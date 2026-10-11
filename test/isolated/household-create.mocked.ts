import { beforeEach, expect, mock, test } from 'bun:test';
import * as real from 'firebase/firestore';

// A fake store with the rules' behaviour for a first household: the first write creates it, a repeat is refused.
const store = new Map<string, Record<string, unknown>>();
const uid = { uid: 'u1', email: 'alex@example.com' };
let sets = 0;
let failWith: Error | undefined;
mock.module('firebase/firestore', () => ({
  ...real,
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }),
  doc: (a: { path?: string }, ...parts: string[]) => {
    const path = parts.length ? [a.path, ...parts].filter(Boolean).join('/') : `${a.path}/random-id`;
    return { path, id: path.split('/').pop()!, firestore: {} };
  },
  query: (c: unknown, ...q: { email: string }[]) => ({ c, email: q[0]!.email }),
  where: (_f: string, _op: string, email: string) => ({ email }),
  getDocs: async (q: { email: string }) => ({
    docs: [...store].filter(([, d]) => (d.members as string[]).includes(q.email)).map(([path, d]) => ({ id: path.split('/').pop()!, data: () => d })),
  }),
  setDoc: async (r: { path: string }, data: Record<string, unknown>) => {
    sets++;
    if (failWith) throw failWith;
    if (store.has(r.path)) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    store.set(r.path, data);
  },
}));

const { createHousehold } = await import('../../src/household');
const db = { app: {} } as real.Firestore;
const ME = 'alex@example.com';

beforeEach(() => {
  store.clear();
  sets = 0;
  failWith = undefined;
});

test('creating twice, even at once, makes one household and returns its id both times', async () => {
  const [a, b] = await Promise.all([createHousehold(db, ME, 'Home', uid), createHousehold(db, 'Alex@example.com', 'Home', uid)]);
  expect(a).toBe('first-u1');
  expect(b).toBe(a);
  expect(store.size).toBe(1);
  expect(sets).toBe(2);
  expect(await createHousehold(db, ME, 'Again', uid)).toBe(a);
  expect(store.get('households/first-u1')).toMatchObject({ name: 'Home', members: [ME], roles: { [ME]: 'admin' } });
});

test('someone removed from their first household gets a household with a random id', async () => {
  store.set('households/first-u1', { name: 'Old', members: ['sam@example.com'], roles: { 'sam@example.com': 'admin' } });
  expect(await createHousehold(db, ME, 'Home', uid)).toBe('random-id');
});

test('a first id someone else holds, with me a member but not its admin, is not mine to return', async () => {
  store.set('households/first-u1', { name: 'Theirs', members: ['sam@example.com', ME], roles: { 'sam@example.com': 'admin', [ME]: 'member' } });
  expect(await createHousehold(db, ME, 'Home', uid)).toBe('random-id');
});

test('a failure that is not permission-denied is thrown', async () => {
  failWith = Object.assign(new Error('unavailable'), { code: 'unavailable' });
  await expect(createHousehold(db, ME, 'Home', uid)).rejects.toThrow('unavailable');
});

test('without a signed-in user the household gets a random id', async () => {
  expect(await createHousehold(db, ME, 'Home', null)).toBe('random-id');
});

test('a user whose email is not the one given gets a random id, so first-<uid> never holds someone else\'s address', async () => {
  expect(await createHousehold(db, ME, 'Home', { uid: 'u2', email: 'sam@example.com' })).toBe('random-id');
});
