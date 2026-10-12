import { describe, expect, test } from 'bun:test';
import { FirestoreError, FirestoreRest } from '../src/firestore-rest';
import {
  billedReads,
  budgetScopeOf,
  d1Ledger,
  isFirestoreUrl,
  isQuotaExhausted,
  memoryLedger,
  quotaDay,
  readCap,
  ReadBudget,
  readLedgerObject,
  sqlLedger,
  untilNextQuotaDay,
  type SqlLike,
} from '../src/read-budget';
import { expectReads, readCounter, ReadBudgetExceeded, writeBeforeEachRead } from '../src/read-test';
import runQuery3 from './fixtures/firestore-rest/run-query-3.json';
import runQueryEmpty from './fixtures/firestore-rest/run-query-empty.json';
import aggregation2500 from './fixtures/firestore-rest/aggregation-2500.json';
import batchGet from './fixtures/firestore-rest/batch-get.json';
import list2 from './fixtures/firestore-rest/list-2.json';
import quotaExhausted from './fixtures/firestore-rest/quota-exhausted.json';

const BASE = 'https://firestore.googleapis.com/v1';
const ROOT = 'projects/demo-kit/databases/(default)/documents';
const url = (rest: string) => `${BASE}/${ROOT}${rest}`;
const MIN = 60_000;

describe('billedReads: what Firestore bills for a REST answer', () => {
  test('a query: each document, at least one', () => {
    expect(billedReads('POST', url('/households/h1:runQuery'), 200, runQuery3)).toBe(3);
    expect(billedReads('POST', url('/households/h1:runQuery'), 200, runQueryEmpty)).toBe(1);
  });
  test('an aggregation: one per 1,000 entries, at least one; the count read under the request\'s alias', () => {
    expect(billedReads('POST', url('/households/h1:runAggregationQuery'), 200, aggregation2500)).toBe(3);
    const counted = JSON.stringify({ structuredAggregationQuery: { aggregations: [{ alias: 'total', sum: { field: { fieldPath: 'amount' } } }, { alias: 'howMany', count: {} }] } });
    expect(billedReads('POST', url('/households/h1:runAggregationQuery'), 200, [{ result: { aggregateFields: { total: { integerValue: '99999' }, howMany: { integerValue: '4200' } } } }], counted)).toBe(5);
    expect(billedReads('POST', url('/households/h1:runAggregationQuery'), 200, [{ result: { aggregateFields: { n: { integerValue: '0' } } } }])).toBe(1);
  });
  test('a batchGet: every document asked for, found or missing', () => {
    expect(billedReads('POST', url(':batchGet'), 200, batchGet)).toBe(2);
  });
  test('a get, found or missing; a list, each document', () => {
    expect(billedReads('GET', url('/households/h1'), 200, { name: 'x', fields: {} })).toBe(1);
    expect(billedReads('GET', url('/households/h1'), 404, { error: { status: 'NOT_FOUND' } })).toBe(1);
    expect(billedReads('GET', url('/households/h1/reminders?pageSize=300'), 200, list2)).toBe(2);
  });
  test('writes, refusals and failures bill nothing', () => {
    expect(billedReads('POST', url(':commit'), 200, {})).toBe(0);
    expect(billedReads('POST', url(':batchWrite'), 200, {})).toBe(0);
    expect(billedReads('POST', url('/households/h1:runQuery'), 429, quotaExhausted)).toBe(0);
    expect(billedReads('GET', url('/households/h1'), 403, {})).toBe(0);
  });
  test('Firestore URLs, production and emulator; its quota answer', () => {
    expect(isFirestoreUrl(url(':runQuery'))).toBe(true);
    expect(isFirestoreUrl(`http://127.0.0.1:8080/v1/${ROOT}/households/h1`)).toBe(true);
    expect(isFirestoreUrl('https://www.googleapis.com/calendar/v3/calendars/primary/events')).toBe(false);
    expect(isQuotaExhausted(429, {})).toBe(true);
    expect(isQuotaExhausted(400, quotaExhausted)).toBe(true);
    expect(isQuotaExhausted(200, runQuery3)).toBe(false);
  });
});

describe('the quota day', () => {
  test('is Pacific: it turns at 07:00 UTC in summer, 08:00 in winter', () => {
    expect(quotaDay(Date.parse('2031-10-01T06:59:00Z'))).toBe('2031-09-30');
    expect(quotaDay(Date.parse('2031-10-01T07:00:00Z'))).toBe('2031-10-01');
    expect(untilNextQuotaDay(Date.parse('2031-10-01T06:30:00Z'))).toBe(30 * MIN);
    expect(untilNextQuotaDay(Date.parse('2031-12-01T07:30:00Z'))).toBe(30 * MIN);
  });
  test('readCap: whole numbers; unset or 0 is no cap; a typo throws', () => {
    expect(readCap('X', '3000')).toBe(3000);
    expect(readCap('X', undefined)).toBe(Infinity);
    expect(readCap('X', '0')).toBe(Infinity);
    expect(() => readCap('X', '3,000')).toThrow('X must be a whole number');
  });
});

/** A Firestore that answers every read from a fixture, and counts what reached it. */
function firestore(answers: { query?: unknown; status?: number } = {}) {
  const seen = { reads: 0, writes: 0, other: 0 };
  const fetch = async (u: string, init?: RequestInit) => {
    if (!isFirestoreUrl(u)) {
      seen.other++;
      return Response.json({ ok: true });
    }
    if (u.endsWith(':commit')) {
      seen.writes++;
      return Response.json({});
    }
    seen.reads++;
    if (u.endsWith(':runQuery')) return Response.json(answers.query ?? runQuery3, { status: answers.status ?? 200 });
    if (u.endsWith(':batchGet')) return Response.json(batchGet);
    return Response.json({ name: `${ROOT}/households/h1`, fields: {} }, { status: init?.method && init.method !== 'GET' ? 400 : 200 });
  };
  return { seen, fetch };
}

const client = (fetch: (u: string, i?: RequestInit) => Promise<Response>) => new FirestoreRest({ projectId: 'demo-kit', token: async () => 't', fetch });

describe('ReadBudget', () => {
  test('counts each response as billed; other hosts pass untouched', async () => {
    const f = firestore();
    const budget = new ReadBudget();
    const fetch = budget.fetch(f.fetch);
    const db = client(fetch);
    await db.query('households/h1', 'agenda');
    await db.get('households/h1');
    await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    expect(budget.summary()).toEqual({ reads: 4, requests: 2, run: null, day: {}, refused: null, ledger: 'none' });
    expect(f.seen.other).toBe(1);
  });

  test('past the run cap every further read and write is refused without reaching Firestore, as its quota answer', async () => {
    const f = firestore();
    const budget = new ReadBudget({ run: 5 });
    const db = client(budget.fetch(f.fetch));
    await db.query('households/h1', 'agenda');
    await db.query('households/h1', 'agenda');
    expect(budget.reads).toBe(6);
    const refused = await db.query('households/h1', 'todos').catch((e) => e);
    expect(refused).toBeInstanceOf(FirestoreError);
    expect((refused as FirestoreError).code).toBe('resource-exhausted');
    expect(budgetScopeOf(refused)).toBe('run');
    expect(await db.commit([{ set: { a: 1 }, path: 'households/h1/x/y' }]).catch((e) => budgetScopeOf(e))).toBe('run');
    expect(f.seen).toEqual({ reads: 2, writes: 0, other: 0 });
    expect(budget.summary().refused).toBe('run');
  });

  test("a daily share: the run starts under it, stops at it, adds its reads; the next run waits for midnight Pacific", async () => {
    const now = Date.parse('2031-10-01T12:00:00Z');
    const ledger = memoryLedger();
    const f = firestore();
    const first = new ReadBudget({ daily: [{ name: 'work', cap: 6 }], ledger, now: () => now });
    expect(await first.begin()).toBeNull();
    const db = client(first.fetch(f.fetch));
    await db.query('households/h1', 'agenda');
    await db.query('households/h1', 'agenda');
    expect(budgetScopeOf(await db.query('households/h1', 'agenda').catch((e) => e))).toBe('work');
    await first.finish();
    await first.finish();
    expect(ledger.counts.get(`${quotaDay(now)}|work`)).toBe(6);
    const next = new ReadBudget({ daily: [{ name: 'work', cap: 6 }], ledger, now: () => now });
    expect(await next.begin()).toEqual({ scope: 'work', wait: untilNextQuotaDay(now), reads: 6 });
    // A new Pacific day starts from nothing.
    const tomorrow = new ReadBudget({ daily: [{ name: 'work', cap: 6 }], ledger, now: () => now + untilNextQuotaDay(now) });
    expect(await tomorrow.begin()).toBeNull();
  });

  test('two shares (all connections, this one): either refuses, named', async () => {
    const ledger = memoryLedger();
    const budget = new ReadBudget({ daily: [{ name: 'connector', key: '*', cap: 100 }, { name: 'connection', key: 'c1', cap: 3 }], ledger });
    await budget.begin();
    const db = client(budget.fetch(firestore().fetch));
    await db.query('households/h1', 'agenda');
    expect(budgetScopeOf(await db.get('households/h1').catch((e) => e))).toBe('connection');
    await budget.finish();
    const day = quotaDay(Date.now());
    expect([ledger.counts.get(`${day}|*`), ledger.counts.get(`${day}|c1`)]).toEqual([3, 3]);
  });

  test("Firestore's own quota: the run is refused from then on, and every run pauses", async () => {
    const now = Date.parse('2031-10-01T12:00:00Z');
    const ledger = memoryLedger();
    const f = firestore({ query: quotaExhausted, status: 429 });
    const budget = new ReadBudget({ ledger, now: () => now, pauseMs: 15 * MIN });
    const db = client(budget.fetch(f.fetch));
    const e = (await db.query('households/h1', 'agenda').catch((x) => x)) as FirestoreError;
    expect(e.code).toBe('resource-exhausted');
    expect(budgetScopeOf(e)).toBeNull();
    expect(budget.refused).toBe('project');
    await db.get('households/h1').catch(() => null);
    expect(f.seen.reads).toBe(1);
    expect(ledger.pausedUntil).toBe(now + 15 * MIN);
    expect(await new ReadBudget({ ledger, now: () => now + MIN }).begin()).toEqual({ scope: 'paused', wait: 14 * MIN });
    // The run's later requests get Firestore's own answer too, never a budget's.
    const later = (await db.get('households/h1').catch((x) => x)) as FirestoreError;
    expect(later.code).toBe('resource-exhausted');
    expect(budgetScopeOf(later)).toBeNull();
  });

  test('a refusal is typed on FirestoreError (budgetScope), and also in its message for other clients', async () => {
    const budget = new ReadBudget({ run: 1 });
    const db = client(budget.fetch(firestore().fetch));
    await db.get('households/h1');
    const e = (await db.get('households/h1').catch((x) => x)) as FirestoreError;
    expect(e.budgetScope).toBe('run');
    expect(budgetScopeOf(new Error(e.message))).toBe('run');
  });

  test('within(): the reads of a run that throws still reach the day', async () => {
    const ledger = memoryLedger();
    const budget = new ReadBudget({ daily: [{ name: 'work', cap: 100 }], ledger });
    const db = client(budget.fetch(firestore().fetch));
    await expect(
      budget.within(async () => {
        await db.query('households/h1', 'agenda');
        throw new Error('the job failed');
      }),
    ).rejects.toThrow('the job failed');
    expect(ledger.counts.get(`${quotaDay(Date.now())}|work`)).toBe(3);
  });

  test('a share with no cap (its variable unset) is counted, never refused', async () => {
    const ledger = memoryLedger();
    const budget = new ReadBudget({ daily: [{ name: 'work', cap: Infinity }], ledger });
    expect(await budget.begin()).toBeNull();
    await client(budget.fetch(firestore().fetch)).query('households/h1', 'agenda');
    await budget.finish();
    expect(ledger.counts.get(`${quotaDay(Date.now())}|work`)).toBe(3);
  });

  test('a ledger that fails: the run goes on, the failure reported', async () => {
    const errors: unknown[] = [];
    const broken = { read: async () => Promise.reject(new Error('down')), add: async () => Promise.reject(new Error('down')), pause: async () => {} };
    const budget = new ReadBudget({ daily: [{ name: 'notify', cap: 10 }], ledger: broken, onLedgerError: (e) => errors.push(e) });
    expect(await budget.begin()).toBeNull();
    await client(budget.fetch(firestore().fetch)).query('households/h1', 'agenda');
    await budget.finish();
    expect(errors.length).toBe(2);
    expect(budget.summary().ledger).toBe('failed');
  });
});

/** SQLite enough for the ledger's statements: bun:sqlite behind `exec`. */
async function sqlite(): Promise<SqlLike> {
  const { Database } = await import('bun:sqlite');
  const db = new Database(':memory:');
  return { exec: <T>(q: string, ...b: unknown[]) => db.query(q).all(...(b as never[])) as T[] };
}

describe('ledgers', () => {
  test("the Durable Object's SQLite: counts per day and key, earlier days dropped, the pause only moves later", async () => {
    const l = sqlLedger(await sqlite());
    l.add('2031-10-01', ['*', 'c1'], 5);
    l.add('2031-10-01', ['*'], 2);
    expect(l.read('2031-10-01', ['*', 'c1', 'c2'])).toEqual({ used: { '*': 7, c1: 5, c2: 0 }, pausedUntil: 0 });
    l.add('2031-10-02', ['*'], 1);
    expect(l.read('2031-10-01', ['*']).used['*']).toBe(0);
    l.pause(500);
    l.pause(100);
    expect(l.read('2031-10-02', []).pausedUntil).toBe(500);
  });

  test('readLedgerObject: a Durable Object class over that ledger', async () => {
    const sql = await sqlite();
    class Base {
      constructor(
        readonly ctx: { storage: { sql: SqlLike } },
        readonly env: unknown,
      ) {}
    }
    const Ledger = readLedgerObject(Base as never);
    const obj = new (Ledger as unknown as new (ctx: unknown, env: unknown) => { read(d: string, k: string[]): unknown; add(d: string, k: string[], n: number): void })({ storage: { sql } }, {});
    obj.add('2031-10-01', ['notify'], 4);
    expect(obj.read('2031-10-01', ['notify'])).toEqual({ used: { notify: 4 }, pausedUntil: 0 });
  });

  test("D1's (key, value) rows: the calendar's keys, pruned to yesterday", async () => {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:');
    db.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER)');
    const d1 = {
      prepare: (q: string) => ({
        bind: (...b: unknown[]) => ({
          all: async <T>() => ({ results: db.query(q.replace(/\?\d+/g, '?')).all(...(b as never[])) as T[] }),
          run: async () => db.query(q.replace(/\?\d+/g, '?')).run(...(b as never[])),
        }),
      }),
    };
    const now = Date.parse('2031-10-03T12:00:00Z');
    const l = d1Ledger(d1);
    for (const d of [0, 1, 2]) await l.add(quotaDay(now - d * 24 * 3_600_000), ['work'], 5);
    await l.add(quotaDay(now), ['work'], 1);
    await l.pause(9);
    expect(await l.read(quotaDay(now), ['work', 'mail'])).toEqual({ used: { work: 6, mail: 0 }, pausedUntil: 9 });
    await l.prune(['work'], now);
    expect(db.query("SELECT key FROM meta WHERE key LIKE 'work-reads:%' ORDER BY key").all()).toEqual([{ key: 'work-reads:2031-10-02' }, { key: 'work-reads:2031-10-03' }]);
    // A key with LIKE's wildcards in it is pruned as itself.
    for (const d of [0, 3]) await l.add(quotaDay(now - d * 24 * 3_600_000), ['mail_inbox'], 1);
    await l.add(quotaDay(now - 3 * 24 * 3_600_000), ['mailXinbox'], 1);
    await l.prune(['mail_inbox'], now);
    expect(db.query("SELECT key FROM meta WHERE key LIKE 'mail%' ORDER BY key").all()).toEqual([{ key: 'mailXinbox-reads:2031-09-30' }, { key: 'mail_inbox-reads:2031-10-03' }]);
  });
});

describe('expectReads and the interleaving hook', () => {
  test('passes under the ceiling and says what was read; fails over it, naming the kinds', async () => {
    const f = firestore();
    const { reads, tally } = await expectReads((meter) => client(meter(f.fetch)).query('households/h1', 'agenda'), { max: 3 });
    expect(reads).toBe(3);
    expect(tally.byKind).toEqual({ query: { requests: 1, reads: 3 } });
    const failed = await expectReads(
      async (meter) => {
        const db = client(meter(f.fetch));
        await db.query('households/h1', 'agenda');
        await db.get('households/h1');
      },
      { max: 3, label: 'agenda sync' },
    ).catch((e) => e);
    expect(failed).toBeInstanceOf(ReadBudgetExceeded);
    expect((failed as Error).message).toContain('agenda sync: 4 Firestore reads billed, over the budget of 3 [query 1× (3 reads), get 1× (1 reads)]');
    expect((failed as ReadBudgetExceeded).reason).toBe('over');
    const floor = await expectReads(async () => {}, { max: 3, min: 1 }).catch((e) => e);
    expect((floor as Error).message).toContain('under the floor of 1');
    expect((floor as ReadBudgetExceeded).reason).toBe('under');
  });

  test('reads sent at once are all counted while a hook runs', async () => {
    const f = firestore();
    const { reads } = await expectReads(
      async (meter) => {
        const db = client(meter(f.fetch));
        await Promise.all([db.query('households/h1', 'agenda'), db.query('households/h1', 'todos'), db.get('households/h1')]);
      },
      { max: 7, min: 7, beforeRead: writeBeforeEachRead(() => new Promise((r) => setTimeout(r, 5))) },
    );
    expect(reads).toBe(7);
  });

  test('beforeRead runs before each read, outside the count', async () => {
    const f = firestore();
    const writes: string[] = [];
    const counter = readCounter();
    await expectReads(
      async (meter) => {
        const db = client(meter(f.fetch));
        await db.query('households/h1', 'agenda');
        await db.get('households/h1');
      },
      { max: 10, counter, beforeRead: writeBeforeEachRead((n, kind) => void writes.push(`${n}:${kind}`), { times: 1 }) },
    );
    expect(writes).toEqual(['1:query']);
    expect(counter.tally.reads).toBe(4);
  });

  test('the SDK module: results, cached results, and listeners as Firestore bills them', async () => {
    const counter = readCounter();
    type Snap = { metadata: { fromCache: boolean }; size?: number; docChanges?: () => { type: string }[] };
    const listeners: ((s: Snap) => void)[] = [];
    const real = {
      getDocs: async () => ({ metadata: { fromCache: false }, size: 0 }),
      getDoc: async () => ({ metadata: { fromCache: true } }),
      onSnapshot: (_ref: unknown, next: (s: Snap) => void) => {
        listeners.push(next);
        return () => {};
      },
      doc: () => 'unchanged',
    };
    const sdk = counter.sdk(real);
    expect(sdk.doc()).toBe('unchanged');
    await sdk.getDocs();
    await sdk.getDoc();
    const seen: number[] = [];
    sdk.onSnapshot({}, (s) => void seen.push(s.size ?? -1));
    const q = (size: number, changes: string[], fromCache = false): Snap => ({ metadata: { fromCache }, size, docChanges: () => changes.map((type) => ({ type })) });
    listeners[0](q(3, ['added', 'added', 'added'], true));
    listeners[0](q(3, []));
    listeners[0](q(3, ['modified', 'removed', 'added']));
    listeners[0](q(3, ['modified'], true));
    expect(seen).toEqual([3, 3, 3, 3]);
    // getDocs: 1 (empty); getDoc from cache: 0; the listener: 3 at first (from the cache, but the
    // server sends the new target whole), nothing for the server's confirmation, then 2; a later
    // snapshot from the cache nothing.
    expect(counter.tally.reads).toBe(6);
  });
});

describe('expectPageReads', () => {
  /** A page whose tally follows `counts`, one value per read of it. */
  const page = (counts: (number | null)[]) => {
    let i = 0;
    return {
      evaluate: async (fn: (key: string) => unknown, key: string) => {
        void fn;
        void key;
        const n = counts[Math.min(i++, counts.length - 1)];
        return n === null ? null : { reads: n, requests: n, byKind: { listen: { requests: n, reads: n } } };
      },
      waitForTimeout: async () => {},
    } as never;
  };
  test('waits for the count to settle, then holds it to the ceiling', async () => {
    const { expectPageReads } = await import('../src/e2e');
    expect((await expectPageReads(page([3, 5, 7, 7]), async () => {}, { max: 7 })).reads).toBe(7);
    const over = await expectPageReads(page([3, 9, 9]), async () => {}, { max: 7, label: 'Today' }).catch((e) => e);
    expect((over as ReadBudgetExceeded).reason).toBe('over');
  });
  test('a count that never settles fails, as does a build without the meter', async () => {
    const { expectPageReads, resetPageReads } = await import('../src/e2e');
    const rising = Array.from({ length: 50 }, (_, i) => i + 1);
    await expect(expectPageReads(page(rising), async () => {}, { max: 1000, settleMs: 1, settleTimeoutMs: 0 })).rejects.toThrow('kept rising');
    await expect(expectPageReads(page([null]), async () => {}, { max: 5 })).rejects.toThrow('does not count its reads');
    await expect(resetPageReads(page([null]))).rejects.toThrow('does not count its reads');
  });
});

describe('a hook that reads through the counter', () => {
  test('throws instead of running itself for ever; raw.fetch is the way around', async () => {
    const f = firestore();
    const { MAX_HOOK_RUNS } = await import('../src/read-test');
    let db: FirestoreRest;
    const looping = expectReads(
      async (meter) => {
        db = client(meter(f.fetch));
        await db.get('households/h1');
      },
      { max: 10, beforeRead: async () => void (await db.get('households/h1')) },
    );
    await expect(looping).rejects.toThrow(`beforeRead ran ${MAX_HOOK_RUNS} times`);
    let raw = 0;
    await expectReads(
      async (meter) => {
        await client(meter(f.fetch)).get('households/h1');
      },
      { max: 1, beforeRead: async (_n, _kind, r) => void (await client(r.fetch!).get('households/h1'), raw++) },
    );
    expect(raw).toBe(1);
  });
});

describe("the preset's read meter", () => {
  test('on for emulator builds or when asked; never otherwise', async () => {
    const { readMeterOn } = await import('../src/vite');
    expect(readMeterOn({ VITE_USE_EMULATORS: 'true' })).toBe(true);
    expect(readMeterOn({ VITE_READ_METER: 'true' })).toBe(true);
    expect(readMeterOn({ VITE_FIREBASE_PROJECT_ID: 'huishouden-staging' })).toBe(false);
  });

  test("swaps every firebase/firestore import for the counted copy, except the copy's own; off unless Vite's env turns it on", async () => {
    const { readMeter } = await import('../src/vite');
    const asked: [string, string | undefined][] = [];
    const ctx = { resolve: async (id: string, importer?: string) => (asked.push([id, importer]), { id: `/resolved/${id}` }) };
    const off = readMeter();
    off.configResolved({ env: { VITE_FIREBASE_PROJECT_ID: 'huishouden-staging' } });
    expect(await off.resolveId.call(ctx, 'firebase/firestore', '/app/src/main.tsx')).toBeNull();
    const plugin = readMeter();
    // As a mode's .env file sets it (`vite build --mode emulator`).
    plugin.configResolved({ env: { VITE_USE_EMULATORS: 'true' } });
    expect(await plugin.resolveId.call(ctx, 'firebase/firestore', '/app/src/main.tsx')).toEqual({ id: '/resolved/@huishouden/pwa-kit/read-meter-browser' });
    expect(await plugin.resolveId.call(ctx, 'firebase/firestore', '/app/node_modules/@huishouden/pwa-kit/dist/read-meter-browser.js')).toBeNull();
    expect(await plugin.resolveId.call(ctx, 'firebase/auth', '/app/src/main.tsx')).toBeNull();
    expect(asked).toEqual([['@huishouden/pwa-kit/read-meter-browser', '/app/src/main.tsx']]);
  });
});
