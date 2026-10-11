import { afterEach, describe, expect, test } from 'bun:test';
import { cleanMemberLangs, itemReaders, readerLangs, setReaderHousehold } from '../src/reader-langs';
import { localizeAgenda } from '../src/agenda-core';
import { localizeTodos } from '../src/todo-core';
import { kt, resetI18nForTests } from '../src/i18n';

afterEach(() => {
  setReaderHousehold(null);
  resetI18nForTests();
});

const ADMIN = 'ana@example.com';
const MEMBER = 'ben@example.com';
const HELPER = 'cleo@example.com';
const KID = 'dan@example.com';
const household = {
  members: [ADMIN, MEMBER, HELPER, KID],
  roles: { [ADMIN]: 'admin' as const, [MEMBER]: 'member' as const, [HELPER]: 'helper' as const, [KID]: 'kid' as const },
  langs: { [ADMIN]: 'en' as const, [MEMBER]: 'nl' as const, [HELPER]: 'es' as const },
};

describe('readers and their languages', () => {
  test('a shared item is read by everyone; a private one or a money app\'s by admins and members', () => {
    expect(itemReaders(household, {})).toEqual([ADMIN, MEMBER, HELPER, KID]);
    expect(itemReaders(household, { private: false })).toEqual([ADMIN, MEMBER, HELPER, KID]);
    expect(itemReaders(household, { private: true })).toEqual([ADMIN, MEMBER]);
    expect(itemReaders(household, {}, 'bills')).toEqual([ADMIN, MEMBER]);
  });

  test("a personal item is its audience's; a reminder naming recipients is theirs", () => {
    expect(itemReaders(household, { audience: [HELPER, ADMIN] })).toEqual([HELPER, ADMIN]);
    expect(itemReaders(household, { audience: [ADMIN, HELPER], recipients: [' Ana@Example.com '] })).toEqual([ADMIN]);
    expect(itemReaders(household, { recipients: 'all', private: true })).toEqual([ADMIN, MEMBER]);
  });

  test("the readers' languages leave out the writer's; someone with none stored reads the writer's", () => {
    expect(readerLangs(household, {}, 'en')).toEqual(['es', 'nl']);
    expect(readerLangs(household, { private: true }, 'en')).toEqual(['nl']);
    expect(readerLangs(household, { private: true }, 'nl')).toEqual(['en']);
    // The kid has none stored: they read what the writer writes.
    expect(readerLangs(household, { audience: [KID] }, 'es')).toEqual([]);
    expect(readerLangs({ members: [ADMIN, MEMBER] }, {}, 'en')).toEqual([]);
  });

  test('stored languages are cleaned: lowercase emails, known languages only', () => {
    expect(cleanMemberLangs({ 'Ana@Example.com': 'nl', [MEMBER]: 'fr', [HELPER]: 3 })).toEqual({ [ADMIN]: 'nl' });
    expect(cleanMemberLangs({ [MEMBER]: 'fr' })).toBeUndefined();
    expect(cleanMemberLangs(['en'])).toBeUndefined();
  });
});

describe('to-dos and agenda items in their readers\' languages', () => {
  const URL = 'https://example-family.web.app/tasks/';

  test('each item gets its own readers\' languages, from the page\'s household', async () => {
    setReaderHousehold(household);
    const items = await localizeTodos(() => [
      { title: kt('time.dueToday'), createdAt: 1, url: URL },
      { title: kt('time.dueToday'), createdAt: 1, url: URL, private: true },
      { title: kt('time.dueToday'), createdAt: 1, url: URL, audience: [ADMIN, KID] },
    ]);
    expect(items.map((i) => i.title)).toEqual(['Due today', 'Due today', 'Due today']);
    expect(items.map((i) => Object.keys(i.texts ?? {}))).toEqual([['es', 'nl'], ['nl'], []]);
    expect(items[2]).not.toHaveProperty('texts');
    expect(items[1].texts?.nl).toEqual({ title: 'Vandaag' });
  });

  test('an explicit household and writer win over the page\'s (servers)', async () => {
    setReaderHousehold(household);
    const [item] = await localizeAgenda(() => [{ ref: 'r', kind: 'other' as const, title: kt('time.dueToday'), start: 1, allDay: true, url: URL }], { household: { members: [ADMIN], langs: { [ADMIN]: 'en' } }, writer: 'es' });
    expect(item.title).toBe('Vence hoy');
    expect(item.texts).toEqual({ en: { title: 'Due today' } });
  });

  test("a money app's reminder counts only admins and members, from its own app", async () => {
    setReaderHousehold(household);
    const { localizeReminders } = await import('../src/reminder-core');
    const [r] = await localizeReminders(() => [{ app: 'bills', title: kt('time.dueToday'), at: 1, url: URL }]);
    expect(Object.keys(r.texts ?? {})).toEqual(['nl']);
  });

  test('a household with no one else\'s language stores no texts', async () => {
    const [item] = await localizeAgenda(() => [{ ref: 'r', kind: 'other' as const, title: kt('time.dueToday'), start: 1, allDay: true, url: URL }], { household: { members: [ADMIN, KID], langs: { [ADMIN]: 'en' } } });
    expect(item).not.toHaveProperty('texts');
  });
});
