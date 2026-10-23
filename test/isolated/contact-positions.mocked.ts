// Replaces firebase/firestore, the global fetch and `document` for the whole process, so it runs on its own (package.json "test").
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as real from 'firebase/firestore';

// `watchContacts({ backfillPositions })`: an admin's or member's app looks up old contacts' positions
// once the list is from the server and the household has a home, only while the page shows.
const store = new Map<string, Record<string, unknown>>();
const listeners = new Set<() => void>();
type Ref = { path: string; id: string };
const DELETE = Symbol('deleteField');
type Where = { field: string; op: string; value: unknown };
mock.module('firebase/firestore', () => ({
  ...real,
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }),
  doc: (col: { path: string }, id: string) => ({ path: `${col.path}/${id}`, id }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  query: (col: { path: string }, ...ws: Where[]) => ({ ...col, ws }),
  deleteField: () => DELETE,
  onSnapshot: (q: { path: string; ws?: Where[] }, _o: unknown, next: (s: unknown) => void) => {
    const listener = () => {
      const docs = [...store.entries()]
        .filter(([p, d]) => p.startsWith(`${q.path}/`) && (q.ws ?? []).every((w) => (w.op === 'array-contains' ? Array.isArray(d[w.field]) && (d[w.field] as unknown[]).includes(w.value) : d[w.field] === w.value)))
        .map(([p, d]) => ({ id: p.split('/').pop()!, data: () => d }));
      next({ docs, metadata: { fromCache: false }, docChanges: () => docs });
    };
    listeners.add(listener);
    queueMicrotask(listener);
    return () => listeners.delete(listener);
  },
  updateDoc: async (r: Ref, data: Record<string, unknown>) => {
    const next = { ...store.get(r.path) };
    for (const [k, v] of Object.entries(data)) v === DELETE ? delete next[k] : (next[k] = v);
    store.set(r.path, next);
    updates.push({ id: r.id, data });
    listeners.forEach((l) => l());
  },
}));

const { watchContacts } = await import('../../src/contacts');
const { setHome, clearGeocodeCache } = await import('../../src/home');
const { resetPlaceSearch } = await import('../../src/places');

const search = JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/nominatim/search.json'), 'utf8'));
const HOME = { address: '12 Example Lane, Springfield', lat: 39.78, lng: -89.65, setBy: 'alex@example.com', updatedAt: 1 };
const db = {} as real.Firestore;
let updates: { id: string; data: Record<string, unknown> }[] = [];
let asked: string[] = [];
const realFetch = globalThis.fetch;

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  show() {
    this.visibilityState = 'visible';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}
let page: FakeDocument;

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const seed = () => {
  store.set('households/h1/contacts/old', { name: 'Example Garage', address: '12 Example Lane, Springfield', apps: ['car'], private: false, geoTried: 1 });
  store.set('households/h1/contacts/placed', { name: 'Example Vet', address: '1 Main St', lat: 1, lng: 2, apps: ['pet'], private: false });
};

beforeEach(() => {
  store.clear();
  listeners.clear();
  updates = [];
  asked = [];
  clearGeocodeCache();
  resetPlaceSearch();
  setHome(undefined);
  page = new FakeDocument();
  (globalThis as { document?: unknown }).document = page;
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(new URL(String(input instanceof Request ? input.url : input)).searchParams.get('q') ?? '');
    return new Response(JSON.stringify(search), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { document?: unknown }).document;
});

describe('watchContacts backfillPositions', () => {
  test("an admin's or member's app writes the position and drops an old no-match mark", async () => {
    setHome(HOME);
    const stop = watchContacts(db, 'h1', () => {}, { app: 'car', backfillPositions: true });
    await settle();
    expect(asked).toEqual(['12 Example Lane, Springfield']);
    expect(store.get('households/h1/contacts/old')).toMatchObject({ lat: 39.7817, lng: -89.6501 });
    expect(store.get('households/h1/contacts/old')).not.toHaveProperty('geoTried');
    expect(updates.map((u) => u.id)).toEqual(['old']);
    stop();
  });

  test('waits for a home', async () => {
    const stop = watchContacts(db, 'h1', () => {}, { backfillPositions: true });
    await settle();
    expect(asked).toEqual([]);
    setHome(HOME);
    await settle();
    expect(asked).toHaveLength(1);
    stop();
  });

  test('waits while the page is hidden, and not after it is closed', async () => {
    setHome(HOME);
    page.visibilityState = 'hidden';
    const stop = watchContacts(db, 'h1', () => {}, { backfillPositions: true });
    await settle();
    expect(asked).toEqual([]);
    page.show();
    await settle();
    expect(asked).toHaveLength(1);
    stop();

    store.delete('households/h1/contacts/old');
    store.set('households/h1/contacts/new', { name: 'Other', address: '3 Elm St', apps: [], private: false });
    page.visibilityState = 'hidden';
    const closed = watchContacts(db, 'h1', () => {}, { backfillPositions: true });
    await settle();
    closed();
    page.show();
    await settle();
    expect(asked).toHaveLength(1);
  });

  test('not for helpers and kids, and only when asked', async () => {
    setHome(HOME);
    const a = watchContacts(db, 'h1', () => {}, { restricted: true, backfillPositions: true });
    const b = watchContacts(db, 'h1', () => {}, {});
    await settle();
    expect(asked).toEqual([]);
    expect(updates).toEqual([]);
    a();
    b();
  });

  test('runs once per load', async () => {
    setHome(HOME);
    store.set('households/h1/contacts/later', { name: 'Later', address: '4 Oak St', apps: [], private: false });
    const stop = watchContacts(db, 'h1', () => {}, { backfillPositions: { limit: 1 } });
    await settle();
    expect(asked).toHaveLength(1);
    setHome({ ...HOME, updatedAt: 2 });
    await settle(1200);
    expect(asked).toHaveLength(1);
    stop();
  });
});
