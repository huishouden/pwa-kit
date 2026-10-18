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
const item = (id: string, name: string, listId = 'groceries') =>
  doc(`households/h1/items/${id}`, { listId, name, category: 'Other', quantity: '1', by: ME, completed: false, urgency: 'Standard', createdAt: NOW - 86_400_000, updatedAt: NOW - 86_400_000 });
const ITEMS = [item(ID, 'Deodorant'), item('milk', 'Milk'), item('eggs', 'Eggs'), item('bulkrice', 'Rice', 'costco'), item('mop', 'Mop the floor', 'chores')];

function firestore() {
  return async (u: string, init?: RequestInit): Promise<Response> => {
    if (u.endsWith(':commit')) return Response.json({});
    if (u.endsWith(':runQuery')) {
      const collection = JSON.parse(String(init?.body)).structuredQuery.from[0].collectionId as string;
      const docs = collection === 'households' ? [HOUSEHOLD] : collection === 'lists' ? LISTS : collection === 'items' ? ITEMS : [];
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
  // Every call: the household query (1) and one get (1). Then the lists query (3), and the open items
  // query (5) when the item is found by name.
  test('groceries_check by name: the lists and every open item', async () => {
    const { reads } = await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_check')!, { item: 'Milk' });
      expect(call.result.error).toBeUndefined();
    }, { max: 10, min: 10, label: 'groceries_check' });
    expect(reads).toBe(10);
  });

  test('groceries_update by name reads what groceries_check reads', async () => {
    await expectReads(async (meter) => {
      const call = await runTool(session(meter(firestore())), toolNamed('groceries_update')!, { item: 'Milk', need_by: '2031-01-08' });
      expect(call.result.error).toBeUndefined();
    }, { max: 10, min: 10, label: 'groceries_update by name' });
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
    }, { max: 11, min: 11, label: 'groceries_update, unknown id' });
  });
});
