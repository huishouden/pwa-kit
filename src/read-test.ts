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

/** Called before each read goes out (REST or an SDK read; not a listener's later snapshots). `n` counts from 1. */
export type BeforeRead = (n: number, kind: ReadKind) => Promise<void> | void;

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
   * A listener is billed its whole result (at least 1) on its first snapshot from the server and one
   * read per added or changed document after; snapshots from the cache bill nothing. One undercount:
   * `getAggregateFromServer` (sums, averages) is counted 1 read, where Firestore bills 1 per 1,000
   * entries; count alongside it (`getCountFromServer`) where the size matters to a budget.
   */
  sdk<M extends object>(real: M): M;
  /** Sets or clears the hook run before each read. */
  setBeforeRead(hook: BeforeRead | null): void;
}

type SnapLike = { metadata?: { fromCache?: boolean }; size?: number; docChanges?: () => { type: string }[]; data?: () => Record<string, unknown> };

export function readCounter({ beforeRead = null as BeforeRead | null } = {}): ReadCounter {
  const tally: ReadTally = { reads: 0, requests: 0, byKind: {} };
  let hook = beforeRead;
  let n = 0;
  let inHook = false;
  const add = (kind: ReadKind, reads: number) => {
    const k = (tally.byKind[kind] ??= { requests: 0, reads: 0 });
    k.requests++;
    k.reads += reads;
    tally.requests++;
    tally.reads += reads;
  };
  const before = async (kind: ReadKind): Promise<boolean> => {
    if (inHook) return false;
    if (hook) {
      inHook = true;
      try {
        await hook(++n, kind);
      } finally {
        inHook = false;
      }
    }
    return true;
  };

  const counter: ReadCounter = {
    tally,
    reset() {
      tally.reads = 0;
      tally.requests = 0;
      tally.byKind = {};
      n = 0;
    },
    setBeforeRead(next) {
      hook = next;
    },
    fetch(inner) {
      return async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const kind = isFirestoreUrl(url) ? readKind(method, url) : null;
        if (!kind) return inner(url, init);
        const counted = await before(kind);
        const res = await inner(url, init);
        if (!counted) return res;
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
          const counted = await before(kind);
          const snap = (await f(...args)) as SnapLike;
          if (counted) add(kind, snap?.metadata?.fromCache ? 0 : bill(snap));
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
            if (inHook || snap?.metadata?.fromCache) return;
            if (typeof snap?.docChanges === 'function') {
              const reads = first ? Math.max(1, snap.size ?? 0) : snap.docChanges().filter((c) => c.type !== 'removed').length;
              if (reads) add('listen', reads);
            } else add('listen', 1);
            first = false;
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
  } finally {
    if (options.beforeRead) counter.setBeforeRead(null);
  }
  const tally: ReadTally = { reads: counter.tally.reads, requests: counter.tally.requests, byKind: structuredClone(counter.tally.byKind) };
  if (tally.reads > options.max || tally.reads < (options.min ?? 0)) throw new ReadBudgetExceeded(tally, options);
  return { value, reads: tally.reads, tally };
}

/**
 * An interleaving test's `beforeRead`: `write(n)` before each of the job's reads (the first `times`
 * of them, default all), so another member's edit lands at every await on Firestore. The write
 * must go around the counter (the emulator's owner token, or another client).
 */
export function writeBeforeEachRead(write: (n: number, kind: ReadKind) => Promise<void> | void, { times = Infinity } = {}): BeforeRead {
  return async (n, kind) => {
    if (n <= times) await write(n, kind);
  };
}
