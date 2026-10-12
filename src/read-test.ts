import type { Fetch } from './firestore-rest.js';
import { billedReads, isFirestoreUrl, readKind, type RestReadKind } from './read-budget.js';

/**
 * Read-budget tests (STANDARD.md "Read budgets"): every Worker run type and every app's main screens
 * and sync paths carry a test that counts the Firestore reads it is billed for and fails past a
 * ceiling, and the interleaving tests run a job with writes landing between its reads.
 *
 *     const { reads } = await expectReads((meter) => runWork(env, pid, { fetch: meter(fetch) }), { max: 40, label: 'feed round' });
 *
 * Reads are counted as Firestore bills them, from what comes back: over REST from each response
 * (`billedReads`, the same count the Workers' `ReadBudget` keeps), and through the Firebase SDK from
 * each result and snapshot (`counter.sdk(firestoreModule)`). The emulator bills nothing and reports
 * no read counts, so this is the measure; it is the quota's rule, not an estimate.
 */

/** What a read was: a get, a list, a query, an aggregation, a batchGet, or a listener's snapshot. */
export type ReadKind = RestReadKind | 'listen';

export interface ReadTally {
  /** Reads billed. */
  reads: number;
  /** Read requests (REST calls, SDK reads, listener snapshots that billed anything). */
  requests: number;
  byKind: Partial<Record<ReadKind, { requests: number; reads: number }>>;
}

/**
 * Called before each read goes out (REST or an SDK read; not a listener's later snapshots). `n` counts
 * from 1. Its writes must go around the counter: `raw.fetch` is the uncounted fetch for a REST read
 * (or use the emulator's owner token, another client). A hook that reads through the counter runs
 * itself again; past MAX_HOOK_RUNS the counter throws rather than hang.
 */
export type BeforeRead = (n: number, kind: ReadKind, raw: { fetch?: Fetch }) => Promise<void> | void;

/** A `beforeRead` hook run this many times in one count is reading through the counter itself. */
export const MAX_HOOK_RUNS = 10_000;

/** The page global a counted build sets (`./read-meter-browser`) and `./e2e` reads. */
export const PAGE_READS_KEY = '__hhReads';

/** What a browser test reads: the page's reads since it loaded or since `reset()`. */
export interface PageReadMeter {
  tally(): ReadTally;
  reset(): void;
}

export interface ReadCounter {
  readonly tally: ReadTally;
  /** Starts the count again. */
  reset(): void;
  /** `inner` with Firestore's REST reads counted (and `beforeRead` run before each). */
  fetch(inner: Fetch): Fetch;
  /**
   * The Firebase SDK's `firebase/firestore` module with its reads counted: `getDoc`, `getDocs`, their
   * `FromServer` forms, `getCountFromServer`, `getAggregateFromServer` and `onSnapshot`. With bun:
   *
   *     const real = await import('firebase/firestore');
   *     mock.module('firebase/firestore', () => counter.sdk(real));
   *
   * A listener is billed its whole result (at least 1) on its first snapshot, even one the cache
   * answers (the server still sends the new target whole), then one read per added or changed
   * document in each snapshot from the server; later snapshots from the cache bill nothing. A
   * `getDoc`/`getDocs` answered from the cache (offline) bills nothing. One undercount:
   * `getAggregateFromServer` (sums, averages) is counted 1 read, where Firestore bills 1 per 1,000
   * entries; count alongside it (`getCountFromServer`) where the size matters to a budget.
   */
  sdk<M extends object>(real: M): M;
  /** Sets or clears the hook run before each read. */
  setBeforeRead(hook: BeforeRead | null): void;
  /** Set when a `beforeRead` hook ran MAX_HOOK_RUNS times (it reads through the counter). */
  readonly runaway: Error | undefined;
}

type SnapLike = { metadata?: { fromCache?: boolean }; size?: number; docChanges?: () => { type: string }[]; data?: () => Record<string, unknown> };

export function readCounter({ beforeRead = null as BeforeRead | null } = {}): ReadCounter {
  const tally: ReadTally = { reads: 0, requests: 0, byKind: {} };
  let hook = beforeRead;
  let n = 0;
  let runaway: Error | undefined;
  const add = (kind: ReadKind, reads: number) => {
    const k = (tally.byKind[kind] ??= { requests: 0, reads: 0 });
    k.requests++;
    k.reads += reads;
    tally.requests++;
    tally.reads += reads;
  };
  // Every read is counted, also those sent while another read's hook runs (a job's reads at once).
  // A hook's own writes go around the counter (the emulator's owner, another client): a read it
  // made through it would be counted and would run the hook again.
  const before = async (kind: ReadKind, raw: { fetch?: Fetch } = {}): Promise<void> => {
    if (!hook) return;
    if (n >= MAX_HOOK_RUNS) {
      // Kept as well as thrown: a client may turn the throw into its own error ("unreachable").
      runaway ??= new Error(`beforeRead ran ${MAX_HOOK_RUNS} times in one count: does the hook read through the counter? Use raw.fetch (or another client) for its own reads and writes.`);
      throw runaway;
    }
    await hook(++n, kind, raw);
  };

  const counter: ReadCounter = {
    tally,
    reset() {
      tally.reads = 0;
      tally.requests = 0;
      tally.byKind = {};
      n = 0;
      runaway = undefined;
    },
    get runaway() {
      return runaway;
    },
    setBeforeRead(next) {
      hook = next;
    },
    fetch(inner) {
      return async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const kind = isFirestoreUrl(url) ? readKind(method, url) : null;
        if (!kind) return inner(url, init);
        await before(kind, { fetch: inner });
        const res = await inner(url, init);
        const body = await res
          .clone()
          .json()
          .catch(() => null);
        add(kind, billedReads(method, url, res.status, body, init?.body));
        return res;
      };
    },
    sdk<M extends object>(real: M): M {
      const m = real as Record<string, unknown>;
      const fn = (name: string) => m[name] as ((...a: unknown[]) => unknown) | undefined;
      const wrapped: Record<string, unknown> = { ...m };
      const once = (name: string, kind: ReadKind, bill: (snap: SnapLike) => number) => {
        const f = fn(name);
        if (!f) return;
        wrapped[name] = async (...args: unknown[]) => {
          await before(kind);
          const snap = (await f(...args)) as SnapLike;
          add(kind, snap?.metadata?.fromCache ? 0 : bill(snap));
          return snap;
        };
      };
      once('getDoc', 'get', () => 1);
      once('getDocFromServer', 'get', () => 1);
      once('getDocs', 'query', (s) => Math.max(1, s.size ?? 0));
      once('getDocsFromServer', 'query', (s) => Math.max(1, s.size ?? 0));
      once('getCountFromServer', 'aggregate', (s) => Math.max(1, Math.ceil(Number(s.data?.().count ?? 0) / 1000)));
      once('getAggregateFromServer', 'aggregate', () => 1);
      const onSnapshot = fn('onSnapshot');
      if (onSnapshot) {
        wrapped.onSnapshot = (ref: unknown, ...rest: unknown[]) => {
          let first = true;
          const bill = (snap: SnapLike) => {
            const query = typeof snap?.docChanges === 'function';
            if (first) {
              // A new listener's target is read from the server whole, even when the cache answers first.
              first = false;
              add('listen', query ? Math.max(1, snap.size ?? 0) : 1);
              return;
            }
            if (snap?.metadata?.fromCache) return;
            const reads = query ? snap.docChanges!().filter((c) => c.type !== 'removed').length : 1;
            if (reads) add('listen', reads);
          };
          const isOptions = (x: unknown) => !!x && typeof x === 'object' && typeof (x as { next?: unknown }).next !== 'function' && ('includeMetadataChanges' in (x as object) || 'source' in (x as object));
          const at = isOptions(rest[0]) ? 1 : 0;
          const target = rest[at];
          const args = [...rest];
          if (typeof target === 'function') {
            args[at] = (snap: SnapLike) => {
              bill(snap);
              return (target as (s: SnapLike) => unknown)(snap);
            };
          } else if (target && typeof target === 'object') {
            const observer = target as { next?: (s: SnapLike) => unknown };
            args[at] = {
              ...observer,
              next: (snap: SnapLike) => {
                bill(snap);
                return observer.next?.(snap);
              },
            };
          }
          return onSnapshot(ref, ...args);
        };
      }
      return wrapped as M;
    },
  };
  return counter;
}

export interface ExpectReadsOptions {
  /** The ceiling: more reads than this fail. Raise it only with the reason in the PR. */
  max: number;
  /** A floor, to catch a count that silently stopped counting (default 0). */
  min?: number;
  /** What was measured, for the failure message. */
  label?: string;
  /** Count with this counter (one whose `sdk(...)` module the code under test imports); default a new one. */
  counter?: ReadCounter;
  /** Runs before each read: an interleaving test's injected write. */
  beforeRead?: BeforeRead;
}

export class ReadBudgetExceeded extends Error {
  /** `over` the ceiling, or `under` the floor. */
  readonly reason: 'over' | 'under';
  constructor(
    readonly tally: ReadTally,
    readonly options: ExpectReadsOptions,
  ) {
    const kinds = Object.entries(tally.byKind)
      .map(([k, v]) => `${k} ${v.requests}× (${v.reads} reads)`)
      .join(', ');
    const what = options.label ? `${options.label}: ` : '';
    super(
      tally.reads > options.max
        ? `${what}${tally.reads} Firestore reads billed, over the budget of ${options.max} [${kinds}]. Find the extra reads, or raise the budget with the reason in the PR (STANDARD.md "Read budgets").`
        : `${what}${tally.reads} Firestore reads billed, under the floor of ${options.min} [${kinds}]: is the counter still on the code path?`,
    );
    this.name = 'ReadBudgetExceeded';
    this.reason = tally.reads > options.max ? 'over' : 'under';
  }
}

/**
 * Runs `fn` with a fresh count and fails (throws `ReadBudgetExceeded`) when it was billed more than
 * `max` reads, or fewer than `min`. `fn` gets `meter`: wrap the fetch the code under test uses with
 * it. Code reading through the SDK uses `counter.sdk(...)` instead and passes that counter. Listener
 * snapshots arriving after `fn` resolves are not in the count: wait for them inside `fn`.
 */
export async function expectReads<T>(fn: (meter: (inner: Fetch) => Fetch) => Promise<T> | T, options: ExpectReadsOptions): Promise<{ value: T; reads: number; tally: ReadTally }> {
  const counter = options.counter ?? readCounter();
  counter.reset();
  if (options.beforeRead) counter.setBeforeRead(options.beforeRead);
  let value: T;
  try {
    value = await fn((inner) => counter.fetch(inner));
  } catch (e) {
    throw counter.runaway ?? e;
  } finally {
    if (options.beforeRead) counter.setBeforeRead(null);
  }
  if (counter.runaway) throw counter.runaway;
  const tally: ReadTally = { reads: counter.tally.reads, requests: counter.tally.requests, byKind: structuredClone(counter.tally.byKind) };
  if (tally.reads > options.max || tally.reads < (options.min ?? 0)) throw new ReadBudgetExceeded(tally, options);
  return { value, reads: tally.reads, tally };
}

/**
 * An interleaving test's `beforeRead`: `write(n)` before each of the job's reads (the first `times`
 * of them, default all), so another member's edit lands at every await on Firestore. The write
 * must go around the counter (the emulator's owner token, or another client).
 */
export function writeBeforeEachRead(write: (n: number, kind: ReadKind, raw: { fetch?: Fetch }) => Promise<void> | void, { times = Infinity } = {}): BeforeRead {
  return async (n, kind, raw) => {
    if (n <= times) await write(n, kind, raw);
  };
}
