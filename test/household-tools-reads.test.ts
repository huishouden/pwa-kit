import { describe, expect, test } from 'bun:test';
import { FirestoreRest } from '../src/firestore-rest';
import { runTool, Session, toolNamed } from '../src/household-tools';
import { expectReads } from '../src/read-test';

process.env.TZ = 'UTC';

// What the shopping tools that find an item bill, counted over the REST client as Firestore bills it
// (`../src/read-test`). One household, 3 lists (2 shopping, 1 tasks), 5 open items.
const ROOT = 'projects/demo-kit/databases/(default)/documents';
const NOW = Date.UTC(2031, 0, 6, 15);
const ME = 'sam@example.com';
const ID = 'AbCdEfGhIjKlMnOpQrSt'; // a generated document id: 20 letters and digits

type Fields = Record<string, string | number | boolean | string[]>;
const value = (v: Fields[string]): unknown =>
  Array.isArray(v) ? { arrayValue: { values: v.map((x) => ({ stringValue: x })) } } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v };
const doc = (path: string, fields: Fields) => ({ name: `${ROOT}/${path}`, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, value(v)])) });

const HOUSEHOLD = doc('households/h1', { name: 'Home', members: [ME], joined: [ME], createdAt: 1 });
const LISTS = [
  doc('households/h1/lists/groceries', { name: 'Groceries', icon: 'grocery', sortOrder: 0 }),
  doc('households/h1/lists/costco', { name: 'Costco', icon: 'bulk', sortOrder: 1 }),
  doc('households/h1/lists/chores', { name: 'Chores', icon: 'chores', sortOrder: 2 }),
];
const DAY = 86_400_000;
const item = (id: string, name: string, listId = 'groceries', completedAt = 0) =>
  doc(`households/h1/items/${id}`, { listId, name, category: 'Other', quantity: '1', by: ME, completed: completedAt > 0, ...(completedAt ? { completedAt } : {}), urgency: 'Standard', createdAt: NOW - DAY, updatedAt: NOW - DAY });
const BOUGHT_ID = 'BoUgHtBoUgHtBoUgHt01';
const ITEMS = [
  // Open: 4 on shopping lists, 1 on Tasks' chores list.
  item(ID, 'Deodorant'), item('milk', 'Milk'), item('eggs', 'Eggs'), item('bulkrice', 'Rice', 'costco'), item('mop', 'Mop the floor', 'chores'),
  // Bought: 2 this week (1 a chore), 1 last week, and 40 long ago that a bounded search never reads.
  item(BOUGHT_ID, 'Bread', 'groceries', NOW - DAY), item('sweep', 'Sweep', 'chores', NOW - 2 * DAY), item('cheese', 'Cheese', 'groceries', NOW - 8 * DAY),
  ...Array.from({ length: 40 }, (_, i) => item(`old${i}`, `Old ${i}`, 'groceries', NOW - (60 + i) * DAY)),
];

type Filter = { fieldFilter: { field: { fieldPath: string }; op: string; value: Record<string, unknown> } };
const plain = (v: Record<string, unknown>): unknown =>
  'arrayValue' in v ? ((v.arrayValue as { values?: Record<string, unknown>[] }).values ?? []).map(plain) : 'integerValue' in v ? Number(v.integerValue) : Object.values(v)[0];
const field = (d: ReturnType<typeof doc>, path: string) => (d.fields[path] ? plain(d.fields[path] as Record<string, unknown>) : undefined);

/** A runQuery as Firestore answers it: its filters, order and limit applied. */
function answer(query: { where?: Filter | { compositeFilter: { filters: Filter[] } }; orderBy?: { field: { fieldPath: string }; direction: string }[]; limit?: number }, docs: ReturnType<typeof doc>[]) {
  const filters = !query.where ? [] : 'compositeFilter' in query.where ? query.where.compositeFilter.filters : [query.where];
  let out = docs.filter((d) =>
    filters.every(({ fieldFilter: f }) => {
      const have = field(d, f.field.fieldPath);
      const want = plain(f.value);
      if (f.op === 'EQUAL') return have === want;
      if (f.op === 'IN') return (want as unknown[]).includes(have);
      if (f.op === 'GREATER_THAN_OR_EQUAL') return typeof have === 'number' && have >= (want as number);
      if (f.op === 'ARRAY_CONTAINS') return Array.isArray(have) && have.includes(want);
      throw new Error(`the fake has no ${f.op}`);
    }),
  );
  for (const o of [...(query.orderBy ?? [])].reverse()) out = [...out].sort((a, b) => (Number(field(a, o.field.fieldPath)) - Number(field(b, o.field.fieldPath))) * (o.direction === 'DESCENDING' ? -1 : 1));
  return query.limit ? out.slice(0, query.limit) : out;
}

function firestore() {
  return async (u: string, init?: RequestInit): Promise<Response> => {
    if (u.endsWith(':commit')) return Response.json({});
    if (u.endsWith(':runQuery')) {
      const query = JSON.parse(String(init?.body)).structuredQuery;
      const collection = query.from[0].collectionId as string;
      const docs = answer(query, collection === 'households' ? [HOUSEHOLD] : collection === 'lists' ? LISTS : collection === 'items' ? ITEMS : []);
      return Response.json(docs.length ? docs.map((document) => ({ document, readTime: '2031-01-06T15:00:00Z' })) : [{ readTime: '2031-01-06T15:00:00Z' }]);
    }
    const path = decodeURIComponent(u.split('/documents/')[1] ?? '');
    const found = [HOUSEHOLD, ...LISTS, ...ITEMS].find((d) => d.name === `${ROOT}/${path}`);
    return found ? Response.json(found) : Response.json({ error: { status: 'NOT_FOUND', message: 'missing' } }, { status: 404 });
  };
}

const session = (fetch: (u: string, i?: RequestInit) => Promise<Response>) =>
  new Session({ uid: 'u1', email: ME, connectionId: 'hh-u1', timeZone: 'America/New_York' }, new FirestoreRest({ projectId: 'demo-kit', token: async () => 't', fetch }), 'https://example.web.app', () => NOW);

describe('read budgets of the shopping tools that find an item', () => {
  // Every call: the household query (1) and one get (1). Then the lists query (3), and, by name, the
  // open items on the 2 shopping lists (4: the chore isn't read).
  test('groceries_check by name: the lists and every open item', async () => {
    const { reads } = await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_check')!, { item: 'Milk' });
      expect(call.result.error).toBeUndefined();
    }, { max: 9, min: 9, label: 'groceries_check' });
    expect(reads).toBe(9);
  });

  test('groceries_check by the id groceries_list gave reads that one item', async () => {
    await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_check')!, { item: ID });
      expect(call.result.error).toBeUndefined();
    }, { max: 6, min: 6, label: 'groceries_check by id' });
  });

  test('groceries_update by name reads what groceries_check reads', async () => {
    await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_update')!, { item: 'Milk', need_by: '2031-01-08' });
      expect(call.result.error).toBeUndefined();
    }, { max: 9, min: 9, label: 'groceries_update by name' });
  });

  test('groceries_update by the id groceries_list gave reads that one item, not every open one', async () => {
    await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_update')!, { item: ID, need_by: '2031-01-08' });
      expect(call.result.error).toBeUndefined();
      expect(call.result.data).toMatchObject({ id: ID, need_by: '2031-01-08' });
    }, { max: 6, min: 6, label: 'groceries_update by id' });
  });

  test('an id that is not an open shopping item falls back to the name search', async () => {
    await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_update')!, { item: 'ZzZzZzZzZzZzZzZzZzZz', need_by: '2031-01-08' });
      expect(call.result.error).toBeDefined();
    }, { max: 10, min: 10, label: 'groceries_update, unknown id' });
  });

  test('putting a bought item back by id reads that one item', async () => {
    await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_check')!, { item: BOUGHT_ID, bought: false });
      expect(call.result.error).toBeUndefined();
    }, { max: 6, min: 6, label: 'groceries_check bought: false, by id' });
  });

  test('putting a bought item back by name reads only the last 30 days of ticked-off items, not all of them', async () => {
    // Bread, Sweep and Cheese (3); the 40 bought months ago are not read.
    await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_check')!, { item: 'Cheese', bought: false });
      expect(call.result.error).toBeUndefined();
    }, { max: 8, min: 8, label: 'groceries_check bought: false, by name' });
  });
});
