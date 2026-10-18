import { describe, expect, test } from 'bun:test';
import { runTool, Session, toolNamed } from '../src/household-tools';
import type { Doc, FirestoreRest, Write } from '../src/firestore-rest';

process.env.TZ = 'UTC';

// The shopping tools and the day an item is needed by (`../src/need-by`). 2031-01-06 is a Monday;
// the person is in New York.
const NOW = Date.UTC(2031, 0, 6, 15); // 10:00 Monday in New York
const ME = 'sam@example.com';
const ALEX = 'alex@example.com';
const home = (roles?: Record<string, string>): Doc => ({ id: 'h1', path: 'households/h1', data: { name: 'Home', members: roles ? [ALEX, ME] : [ME, ALEX], joined: [ME], createdAt: 1, ...(roles ? { roles } : {}) } });
const LIST: Doc = { id: 'groceries', path: 'households/h1/lists/groceries', data: { name: 'Groceries', icon: 'grocery', sortOrder: 0 } };
const item = (id: string, data: Record<string, unknown>): Doc => ({
  id,
  path: `households/h1/items/${id}`,
  data: { listId: 'groceries', name: id, category: 'Other', quantity: '1', notes: '', addedBy: 'Alex', by: ALEX, completed: false, urgency: 'Standard', createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000, ...data },
});

function fakeDb(items: Doc[] = [], household = home()) {
  const commits: Write[][] = [];
  const db = {
    get: async () => null,
    query: async (_parent: string, collection: string) => (collection === 'households' ? [household] : collection === 'lists' ? [LIST] : collection === 'items' ? items : []),
    commit: async (writes: Write[]) => void commits.push(writes),
  } as unknown as FirestoreRest;
  return { db, commits };
}

const session = (db: FirestoreRest, now = NOW) => new Session({ uid: 'u1', email: ME, connectionId: 'hh-u1', timeZone: 'America/New_York' }, db, 'https://example.web.app', () => now);
const created = (commits: Write[][]) => (commits[0].find((w) => w.path.includes('/items/')) as { create: Record<string, unknown> }).create;
const merged = (commits: Write[][]) => (commits[0][0] as { merge: Record<string, unknown> }).merge;

describe('groceries_add: need_by', () => {
  test('a later day is stored with Standard for older apps, and said back', async () => {
    const { db, commits } = fakeDb();
    const call = await runTool(session(db), toolNamed('groceries_add')!, { name: 'Deodorant', need_by: '2031-01-08' });
    expect(call.result.error).toBeUndefined();
    expect(created(commits)).toMatchObject({ needBy: '2031-01-08', urgency: 'Standard', position: -NOW });
    expect(call.result.text).toContain('Added Deodorant to Groceries, need by Wed.');
    expect(call.result.data).toMatchObject({ need_by: '2031-01-08', urgency: 'Standard' });
  });

  test('today is stored as Need Today, above the other new items', async () => {
    const { db, commits } = fakeDb();
    await runTool(session(db), toolNamed('groceries_add')!, { name: 'Eggs', need_by: '2031-01-06' });
    expect(created(commits)).toMatchObject({ needBy: '2031-01-06', urgency: 'Need Today' });
    expect(created(commits).position as number).toBeLessThan(-NOW);
  });

  test('"Need Today" without a day is dated today; Standard and Whenever store no day', async () => {
    for (const [urgency, needBy] of [['Need Today', '2031-01-06'], ['Standard', undefined], ['Whenever', undefined]] as const) {
      const { db, commits } = fakeDb();
      await runTool(session(db), toolNamed('groceries_add')!, { name: 'Milk', urgency });
      expect(created(commits).needBy).toBe(needBy);
      expect(created(commits).urgency).toBe(urgency);
    }
  });

  test('a day that has passed, or is not a day, is refused before anything is written', async () => {
    for (const need_by of ['2031-01-05', 'tuesday', '2031-02-30']) {
      const { db, commits } = fakeDb();
      const call = await runTool(session(db), toolNamed('groceries_add')!, { name: 'Milk', need_by });
      expect(call.result.error).toBe(true);
      expect(call.result.text).toContain(need_by === '2031-01-05' ? 'has passed (today is 2031-01-06)' : 'is not a day I can read');
      expect(commits).toEqual([]);
    }
  });

  test("late evening: today is the person's day, not UTC's", async () => {
    // 23:30 Monday in New York is 04:30 Tuesday UTC.
    const late = Date.UTC(2031, 0, 7, 4, 30);
    const { db, commits } = fakeDb();
    const call = await runTool(session(db, late), toolNamed('groceries_add')!, { name: 'Bread', need_by: '2031-01-06' });
    expect(call.result.error).toBeUndefined();
    expect(created(commits)).toMatchObject({ needBy: '2031-01-06', urgency: 'Need Today' });
  });
});

describe('groceries_list: need_by', () => {
  test('each item says its day; a legacy Need Today counts from its last change', async () => {
    const { db } = fakeDb([
      item('Deodorant', { needBy: '2031-01-08' }),
      item('Batteries', { urgency: 'Need Today', updatedAt: Date.UTC(2031, 0, 4, 18) }),
      item('Rice', {}),
    ]);
    const call = await runTool(session(db), toolNamed('groceries_list')!, {});
    expect(call.result.text).toContain('- Deodorant · Need by Wed · Other');
    expect(call.result.text).toContain('- Batteries · Overdue, needed Sat · Other');
    expect(call.result.text).toContain('- Rice · Other');
    const items = (call.result.data as { lists: { items: Record<string, unknown>[] }[] }).lists[0].items;
    expect(items.find((i) => i.name === 'Deodorant')).toMatchObject({ need_by: '2031-01-08' });
    expect(items.find((i) => i.name === 'Batteries')).toMatchObject({ need_by: '2031-01-04', need_by_guessed: true });
    expect(items.find((i) => i.name === 'Rice')!.need_by).toBeUndefined();
  });

  test('in Spanish', async () => {
    const { db } = fakeDb([item('Deodorant', { needBy: '2031-01-08' })]);
    const call = await runTool(session(db), toolNamed('groceries_list')!, { lang: 'es' });
    expect(call.result.text).toContain('Para el miércoles');
  });
});

describe('groceries_update', () => {
  test('sets a day, with the urgency older apps read', async () => {
    const { db, commits } = fakeDb([item('Deodorant', { urgency: 'Need Today' })]);
    const call = await runTool(session(db), toolNamed('groceries_update')!, { item: 'deodorant', need_by: '2031-01-08' });
    expect(call.result.error).toBeUndefined();
    expect(commits[0][0].path).toBe('households/h1/items/Deodorant');
    expect(merged(commits)).toEqual({ needBy: '2031-01-08', urgency: 'Standard', updatedAt: NOW });
    expect(call.result.text).toContain('Changed Deodorant on Groceries: need by Wed.');
  });

  test('"none" clears the day and the urgency it implied; Whenever stays Whenever', async () => {
    let { db, commits } = fakeDb([item('Deodorant', { needBy: '2031-01-06', urgency: 'Need Today' })]);
    let call = await runTool(session(db), toolNamed('groceries_update')!, { item: 'Deodorant', need_by: 'none' });
    expect(merged(commits)).toEqual({ needBy: null, urgency: 'Standard', updatedAt: NOW });
    expect(call.result.text).toContain('no day set');
    ({ db, commits } = fakeDb([item('Deodorant', { needBy: '2031-01-09', urgency: 'Whenever' })]));
    call = await runTool(session(db), toolNamed('groceries_update')!, { item: 'Deodorant', need_by: 'none' });
    expect(merged(commits)).toMatchObject({ needBy: null, urgency: 'Whenever' });
  });

  test('urgency alone: Need Today dates it today, Standard and Whenever clear the day', async () => {
    for (const [urgency, needBy] of [['Need Today', '2031-01-06'], ['Whenever', null], ['Standard', null]] as const) {
      const { db, commits } = fakeDb([item('Deodorant', { needBy: '2031-01-09' })]);
      await runTool(session(db), toolNamed('groceries_update')!, { item: 'Deodorant', urgency });
      expect(merged(commits)).toMatchObject({ needBy, urgency });
    }
  });

  test('changing only the quantity pins a legacy day so it stops moving', async () => {
    const { db, commits } = fakeDb([item('Batteries', { urgency: 'Need Today', updatedAt: Date.UTC(2031, 0, 4, 18) })]);
    await runTool(session(db), toolNamed('groceries_update')!, { item: 'Batteries', quantity: '2' });
    expect(merged(commits)).toEqual({ needBy: '2031-01-04', quantity: '2', updatedAt: NOW });
  });

  test("a helper changes their own items, not someone else's; nothing to change is said", async () => {
    const helper = home({ [ME]: 'helper' });
    let { db, commits } = fakeDb([item('Deodorant', {})], helper);
    let call = await runTool(session(db), toolNamed('groceries_update')!, { item: 'Deodorant', need_by: '2031-01-07' });
    expect(call.result.error).toBe(true);
    expect(call.result.text).toContain('was added by someone else');
    expect(commits).toEqual([]);
    ({ db, commits } = fakeDb([item('Deodorant', { by: ME })], helper));
    call = await runTool(session(db), toolNamed('groceries_update')!, { item: 'Deodorant', need_by: '2031-01-07' });
    expect(call.result.error).toBeUndefined();
    ({ db, commits } = fakeDb([item('Deodorant', {})]));
    call = await runTool(session(db), toolNamed('groceries_update')!, { item: 'Deodorant' });
    expect(call.result.text).toContain('Say what to change');
    expect(commits).toEqual([]);
  });

  test('an item that is not on the lists is said', async () => {
    const { db } = fakeDb([item('Deodorant', {})]);
    const call = await runTool(session(db), toolNamed('groceries_update')!, { item: 'shampoo', need_by: '2031-01-07' });
    expect(call.result.text).toContain('Nothing called "shampoo"');
  });
});
