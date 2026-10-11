import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { Firestore } from 'firebase/firestore';

// Language changes are window events; without a DOM here, a bare EventTarget stands in for window.
const ownWindow = typeof window === 'undefined' || typeof window.dispatchEvent !== 'function';
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
if (ownWindow) Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: new EventTarget() });

const { followMemberLang, resetMemberLangForTests } = await import('../src/member-lang');
const { getLang, getLangChoice, resetI18nForTests, setLangChoice, setLangForTests } = await import('../src/i18n');

const db = {} as Firestore;
const ME = 'sam@example.com';
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) };
};
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetI18nForTests();
  resetMemberLangForTests();
});
afterAll(() => {
  if (ownWindow) {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

describe("following the member's language", () => {
  test('none stored: this page\'s language is stored, once, as a language', async () => {
    await setLangForTests('auto', ['es-MX']);
    const saved: string[] = [];
    const follow = followMemberLang(db, ' Sam@Example.com ', { save: async (_db, id, email, lang) => void saved.push(`${id} ${email} ${lang}`) });
    const h = { id: 'h1', members: [ME, 'alex@example.com'], joined: [ME] };
    follow.apply(h);
    follow.apply(h);
    await settle();
    expect(saved).toEqual([`h1 ${ME} es`]);
    expect(getLangChoice()).toBe('es');
    follow.stop();
  });

  test('a stored language is followed; a language chosen here is stored', async () => {
    await setLangForTests('en');
    const saved: string[] = [];
    const follow = followMemberLang(db, ME, { save: async (_db, _id, _email, lang) => void saved.push(lang) });
    follow.apply({ id: 'h1', members: [ME], joined: [ME], langs: { [ME]: 'nl' } });
    await settle();
    expect(getLang()).toBe('nl');
    expect(saved).toEqual([]);
    await setLangChoice('es', memory());
    expect(saved).toEqual(['es']);
    // The household's next snapshot carries it: nothing more is written.
    follow.apply({ id: 'h1', members: [ME], joined: [ME], langs: { [ME]: 'es' } });
    await settle();
    expect(saved).toEqual(['es']);
    follow.stop();
    await setLangChoice('en', memory());
    expect(saved).toEqual(['es']);
  });

  test('nothing is written for a household the person is not in, or before one is known', async () => {
    await setLangForTests('en');
    const saved: string[] = [];
    const follow = followMemberLang(db, ME, { save: async (_db, _id, _email, lang) => void saved.push(lang) });
    await setLangChoice('nl', memory());
    follow.apply(null);
    follow.apply({ id: 'h2', members: ['alex@example.com'], joined: [] });
    await settle();
    expect(saved).toEqual([]);
    follow.stop();
  });

  test('a failed write is tried again on the next snapshot; one the rules refuse is not', async () => {
    await setLangForTests('en');
    let calls = 0;
    const follow = followMemberLang(db, ME, {
      save: async () => {
        calls++;
        throw calls === 1 ? Object.assign(new Error('offline'), { code: 'unavailable' }) : Object.assign(new Error('refused'), { code: 'permission-denied' });
      },
    });
    for (let i = 0; i < 4; i++) {
      follow.apply({ id: 'h1', members: [ME], joined: [ME] });
      await settle();
    }
    expect(calls).toBe(2);
    // A new language is asked once more.
    await setLangChoice('nl', memory());
    await settle();
    expect(calls).toBe(3);
    follow.stop();
  });

  test('two followers in one page write a change once', async () => {
    await setLangForTests('en');
    const saved: string[] = [];
    const save = async (_db: unknown, _id: string, _email: string, lang: string) => {
      await settle();
      saved.push(lang);
    };
    const a = followMemberLang(db, ME, { save });
    const b = followMemberLang(db, ME, { save });
    const h = { id: 'h1', members: [ME], joined: [ME], langs: { [ME]: 'en' as const } };
    a.apply(h);
    b.apply(h);
    await setLangChoice('es', memory());
    await settle();
    await settle();
    expect(saved).toEqual(['es']);
    a.stop();
    b.stop();
  });

  test("a member of several households keeps the same language in each; the one the apps use leads", async () => {
    await setLangForTests('en');
    const saved: string[] = [];
    const follow = followMemberLang(db, ME, { save: async (_db, id, _email, lang) => void saved.push(`${id} ${lang}`) });
    const used = { id: 'h1', members: [ME], joined: [ME], langs: { [ME]: 'nl' as const } };
    const other = { id: 'h2', members: ['alex@example.com', ME], joined: [ME], langs: { [ME]: 'es' as const } };
    const notMine = { id: 'h3', members: ['alex@example.com'], joined: [] };
    follow.apply(used, [used, other, notMine]);
    await settle();
    expect(saved).toEqual(['h2 nl']);
    expect(getLang()).toBe('nl');
    await setLangChoice('en', memory());
    expect(saved.sort()).toEqual(['h1 en', 'h2 en', 'h2 nl']);
    follow.stop();
  });

  test('with none stored where the apps are used, the language stored in another joined household is taken', async () => {
    await setLangForTests('en');
    const saved: string[] = [];
    const follow = followMemberLang(db, ME, { save: async (_db, id, _email, lang) => void saved.push(`${id} ${lang}`) });
    const used = { id: 'h1', members: [ME], joined: [ME] };
    const other = { id: 'h2', members: ['alex@example.com', ME], joined: [ME], langs: { [ME]: 'nl' as const } };
    follow.apply(used, [used, other]);
    await settle();
    expect(saved).toEqual(['h1 nl']);
    expect(getLang()).toBe('nl');
    follow.stop();
  });

  test('an invitation not yet joined gets no write and gives no language', async () => {
    await setLangForTests('en');
    const saved: string[] = [];
    const follow = followMemberLang(db, ME, { save: async (_db, id, _email, lang) => void saved.push(`${id} ${lang}`) });
    const used = { id: 'h1', members: [ME], joined: [ME] };
    const invited = { id: 'h2', members: ['alex@example.com', ME], joined: ['alex@example.com'], langs: { [ME]: 'nl' as const } };
    follow.apply(used, [used, invited]);
    await setLangChoice('es', memory());
    await settle();
    expect(saved.sort()).toEqual(['h1 en', 'h1 es']);
    // The household the apps use, before markJoined lands: nothing until the snapshot that has it.
    const fresh = followMemberLang(db, ME, { save: async (_db, id, _email, lang) => void saved.push(`${id} ${lang}`) });
    fresh.apply({ id: 'h3', members: [ME], joined: [] });
    await settle();
    expect(saved.filter((x) => x.startsWith('h3'))).toEqual([]);
    fresh.apply({ id: 'h3', members: [ME], joined: [ME] });
    await settle();
    expect(saved.filter((x) => x.startsWith('h3'))).toEqual(['h3 es']);
    follow.stop();
    fresh.stop();
  });
});
