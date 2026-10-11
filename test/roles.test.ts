import { describe, expect, mock, test } from 'bun:test';
import * as real from 'firebase/firestore';

// Records the household writes; the rules that check them are tested in huishouden/rules.
const writes: { kind: string; path: string; data: Record<string, unknown> }[] = [];
mock.module('firebase/firestore', () => ({
  ...real,
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }),
  doc: (a: { path?: string }, ...parts: string[]) => {
    const path = parts.length ? [a.path, ...parts].filter(Boolean).join('/') : `${a.path}/new-id`;
    return { path, id: path.split('/').pop()!, firestore: {} };
  },
  updateDoc: async (r: { path: string }, data: Record<string, unknown>) => void writes.push({ kind: 'update', path: r.path, data }),
  setDoc: async (r: { path: string }, data: Record<string, unknown>) => void writes.push({ kind: 'set', path: r.path, data }),
}));

const { ROLES, ROLE_DESCRIPTIONS, can, effectiveRoles, giversFields, helpersOf, householdRole, isRestricted, mayGive, refusal, setRole, toRoles } = await import('../src/roles');
const { createHousehold, inviteMember, removeMember, toHousehold } = await import('../src/household');

const db = {} as real.Firestore;
const A = 'alex@example.com';
const B = 'sam@example.com';
const H = 'helper@example.com';
const K = 'kid@example.com';
const home = toHousehold('h1', { name: 'Home', members: [A, B, H, K], roles: { [H]: 'helper', [K]: 'kid', [B]: 'bogus' }, createdAt: 1 });
const last = () => writes[writes.length - 1]!;

describe('roles', () => {
  test('the creator is the admin and anyone unnamed a member, as in the rules', () => {
    expect(householdRole(home, A)).toBe('admin');
    expect(householdRole(home, ' Sam@Example.com ')).toBe('member');
    expect(householdRole(home, H)).toBe('helper');
    expect(householdRole(home, K)).toBe('kid');
    expect(householdRole(home, 'stranger@example.com')).toBeNull();
    expect(householdRole(null, A)).toBeNull();
    expect(householdRole({ members: [A, B], roles: { [A]: 'member', [B]: 'admin' } }, A)).toBe('member');
  });

  test('only valid roles are read from the document', () => {
    expect(home.roles).toEqual({ [H]: 'helper', [K]: 'kid' });
    expect(toRoles(['admin'])).toEqual({});
    expect(toRoles(null)).toEqual({});
  });

  test('what each role may do matches the rules', () => {
    const table = Object.fromEntries(
      ROLES.map((r) => [r, (['manage-people', 'change-settings', 'see-money', 'see-private', 'edit-others', 'give-medicine', 'add', 'tick'] as const).filter((a) => can(r, a))]),
    );
    expect(table).toEqual({
      admin: ['manage-people', 'change-settings', 'see-money', 'see-private', 'edit-others', 'give-medicine', 'add', 'tick'],
      member: ['change-settings', 'see-money', 'see-private', 'edit-others', 'give-medicine', 'add', 'tick'],
      helper: ['give-medicine', 'add', 'tick'],
      kid: ['add', 'tick'],
    });
    expect(can(null, 'tick')).toBe(false);
    expect(ROLES.filter(isRestricted)).toEqual(['helper', 'kid']);
  });

  test('refusals say who can, in one sentence', () => {
    expect(refusal('change-settings')).toBe('Only admins and members can change settings.');
    expect(refusal('see-money')).toMatch(/^Only admins and members can/);
    for (const r of ROLES) expect(ROLE_DESCRIPTIONS[r]).toMatch(/\.$/);
  });

  test('medicine: admins and members always, kids never, helpers when the course allows them', () => {
    const open = {};
    const restricted = giversFields('approved', ['Helper@Example.com']);
    expect(restricted).toEqual({ givers: 'approved', approvedHelpers: [H] });
    expect(giversFields('all', [H])).toEqual({ givers: 'all' });
    expect(mayGive(open, 'member', B)).toBe(true);
    expect(mayGive(restricted, 'admin', A)).toBe(true);
    expect(mayGive(open, 'helper', H)).toBe(true);
    expect(mayGive(restricted, 'helper', H)).toBe(true);
    expect(mayGive(restricted, 'helper', 'other@example.com')).toBe(false);
    expect(mayGive(open, 'kid', K)).toBe(false);
    expect(helpersOf(home)).toEqual([H]);
  });
});

describe('household writes', () => {
  test('a new household names its creator admin', async () => {
    await createHousehold(db, 'Alex@Example.com', ' Home ', { uid: 'u1', email: A });
    expect(last().data).toMatchObject({ name: 'Home', members: [A], roles: { [A]: 'admin' } });
    expect(last().path).toBe('households/first-u1');
  });

  test('setting a role writes every member’s out', async () => {
    await setRole(db, home, H, 'member');
    expect(last()).toMatchObject({ path: 'households/h1', data: { roles: { [A]: 'admin', [B]: 'member', [H]: 'member', [K]: 'kid' } } });
    expect(effectiveRoles(home)).toEqual({ [A]: 'admin', [B]: 'member', [H]: 'helper', [K]: 'kid' });
    await expect(setRole(db, home, 'stranger@example.com', 'admin')).rejects.toThrow(/not in this household/);
  });

  test('an invitee is a member unless given a role', async () => {
    await inviteMember(db, 'h1', 'New@Example.com');
    expect(Object.keys(last().data)).toEqual(['members']);
    await inviteMember(db, home, 'sitter@example.com', 'helper');
    expect(last().data.roles).toEqual({ [A]: 'admin', [B]: 'member', [H]: 'helper', [K]: 'kid', 'sitter@example.com': 'helper' });
    await expect(inviteMember(db, 'h1', 'sitter@example.com', 'helper')).rejects.toThrow(/Pass the household/);
    await expect(inviteMember(db, home, H, 'kid')).rejects.toThrow(/already/);
  });

  test('removing someone takes their role with them and keeps the creator’s admin role written out', async () => {
    await removeMember(db, home, H);
    expect(last().data).toEqual({ members: [A, B, K], roles: { [A]: 'admin', [B]: 'member', [K]: 'kid' } });
    // Without the creator, the next person keeps the role they had rather than becoming admin by position.
    const shared = toHousehold('h1', { members: [A, B, H], roles: { [B]: 'admin', [H]: 'helper' } });
    await removeMember(db, shared, A);
    expect(last().data).toEqual({ members: [B, H], roles: { [B]: 'admin', [H]: 'helper' } });
  });
});
