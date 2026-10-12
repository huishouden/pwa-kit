import type { Fetch } from './firestore-rest.js';

/**
 * Firestore reads on a server (a Worker, the connector, `hh`): what Firestore bills for each REST
 * response, the quota's day, and `ReadBudget`, the caps every Worker runs its reads under
 * (STANDARD.md "Read budgets").
 *
 * The free plan's 50,000 reads a day are the project's: every household, app and Worker draws on
 * them, and once they are gone every read fails until midnight Pacific. On 2026-10-12 one calendar
 * round re-read the same lists for 19 minutes (about 39,000 reads) and stopped every app for the
 * rest of the night. A Worker therefore:
 *
 * - counts what each response is billed for (`billedReads`), from the wire, so a new code path can't
 *   read uncounted;
 * - stops a run past its own cap (`run`), so one runaway job can't take the day;
 * - stops for the rest of the Pacific day once its share (`daily`) is spent;
 * - stops everything for a while when Firestore answers 429 `RESOURCE_EXHAUSTED` (`pause`);
 * - logs each run's reads (`summary()`), so the culprit has a name.
 */

/** The free (Spark) plan's document reads a day, for the whole project. */
export const FREE_DAILY_READS = 50_000;

const PACIFIC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }); // locale-check:allow

/** The quota's day `now` falls on, "2031-10-01": Firestore's daily quotas reset at midnight Pacific. */
export const quotaDay = (now: number): string => PACIFIC.format(now);

/** Milliseconds from `now` to the next midnight Pacific (07:00 UTC in summer, 08:00 in winter). */
export function untilNextQuotaDay(now: number): number {
  const day = quotaDay(now);
  let t = Math.floor(now / 3_600_000) * 3_600_000;
  while (quotaDay(t) === day) t += 3_600_000;
  return t - now;
}

/**
 * A cap from a Worker's `[vars]`: reads as a whole number. Unset, empty or 0 is no cap (Infinity);
 * anything else that isn't a whole number throws, so a typo can't turn a cap off.
 */
export function readCap(name: string, value: string | undefined): number {
  if (value === undefined || value.trim() === '') return Infinity;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of reads (wrangler.toml [vars]), not "${value}".`);
  return n === 0 ? Infinity : n;
}

/** Whether `url` is a Firestore REST call (`…/v1/projects/{p}/databases/{d}/documents…`), on production or an emulator. */
export const isFirestoreUrl = (url: string): boolean => /\/v1(?:beta1)?\/projects\/[^/]+\/databases\/[^/]+\/documents/.test(url);

const pathOf = (url: string) => url.split('?')[0];

/** What a Firestore read request is: a get, a list, a query, an aggregation, a batchGet. */
export type RestReadKind = 'get' | 'list' | 'query' | 'aggregate' | 'batchGet';

/** The kind of read a Firestore REST request is, or null for a write (commit, batchWrite, delete, …). */
export function readKind(method: string, url: string): RestReadKind | null {
  const path = pathOf(url);
  if (path.endsWith(':runQuery')) return 'query';
  if (path.endsWith(':runAggregationQuery')) return 'aggregate';
  if (path.endsWith(':batchGet')) return 'batchGet';
  if (method.toUpperCase() !== 'GET') return null;
  // A collection path (odd segments after documents/) is a list; a document path a get.
  const rel = path.split('/documents/')[1] ?? '';
  return rel.split('/').length % 2 === 1 ? 'list' : 'get';
}

/** Whether a Firestore REST request reads (a get, a list, a query, an aggregation, a batchGet). */
export const isReadRequest = (method: string, url: string): boolean => readKind(method, url) !== null;

type Row = { document?: unknown; result?: { aggregateFields?: Record<string, { integerValue?: string }> }; found?: unknown; missing?: unknown };

/** The alias of the count in an aggregation request's body (JSON text or object); null when it counts nothing. */
function countAlias(request: unknown): string | null {
  let body = request;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const aggregations = (body as { structuredAggregationQuery?: { aggregations?: { alias?: string; count?: unknown }[] } } | null)?.structuredAggregationQuery?.aggregations ?? [];
  return aggregations.find((a) => a.count !== undefined)?.alias ?? null;
}

/**
 * Reads Firestore bills for one REST response (https://cloud.google.com/firestore/pricing): one per
 * document a get, list, query or batchGet returns, a get of a missing document and each missing
 * document a batchGet asks for included; at least one per query and per aggregation even when
 * nothing comes back; one per 1,000 index entries an aggregation walks. The entries an aggregation
 * walks are its count, read from the response under the count's alias in `request` (the request's
 * body); an aggregation without a count (sums alone) is billed its minimum here, so count alongside
 * a sum (`FirestoreRest.aggregate` always does). Writes and refused requests are 0.
 *
 * Cloud Monitoring's `document/read_count` leaves out the one-read minimum of empty queries and
 * aggregations; this doesn't, so it is what the quota sees.
 */
export function billedReads(method: string, url: string, status: number, body: unknown, request?: unknown): number {
  const kind = readKind(method, url);
  if (!kind) return 0;
  if (status === 429 || status === 401 || status === 403 || status >= 500) return 0;
  const rows = Array.isArray(body) ? (body as Row[]) : [];
  if (status !== 200) return kind === 'get' && status === 404 ? 1 : 0;
  if (kind === 'query') return Math.max(1, rows.filter((r) => r.document).length);
  if (kind === 'aggregate') {
    const alias = countAlias(request) ?? 'n';
    const n = Number(rows.find((r) => r.result)?.result?.aggregateFields?.[alias]?.integerValue ?? 0);
    return Math.max(1, Math.ceil(n / 1000));
  }
  if (kind === 'batchGet') return rows.filter((r) => r.found || r.missing).length;
  const listed = (body as { documents?: unknown[] } | null)?.documents;
  return Array.isArray(listed) ? Math.max(1, listed.length) : 1;
}

/** Whether a Firestore answer is its quota refusing: 429, or `RESOURCE_EXHAUSTED` in the error. */
export function isQuotaExhausted(status: number, body: unknown): boolean {
  if (status === 429) return true;
  const error = (Array.isArray(body) ? body[0] : body) as { error?: { status?: string } } | null | undefined;
  return error?.error?.status === 'RESOURCE_EXHAUSTED';
}

/** The `details` entry that marks a `ReadBudget` refusal and names its scope. */
export const REFUSAL_TYPE = 'type.googleapis.com/huishouden.ReadBudgetRefusal';
/** The message of a refusal, for clients that only keep the message (it ends with the scope). */
const REFUSAL = 'Read budget spent: ';

const quotaBody = (message: string, details?: unknown[]) => JSON.stringify([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message, ...(details ? { details } : {}) } }]);
const json429 = (body: string) => new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } });

/**
 * What a `ReadBudget` answers in place of a read past a cap: Firestore's own quota answer (429
 * `RESOURCE_EXHAUSTED`), so every client fails exactly as it would at the project's quota, with
 * the scope in `details` (`refusalScope` reads it; `FirestoreRest` keeps it as `budgetScope`).
 */
export const refusalResponse = (scope: string): Response => json429(quotaBody(`${REFUSAL}${scope}`, [{ '@type': REFUSAL_TYPE, scope }]));

/** Firestore's own quota answer, repeated for a run's later requests once Firestore has refused. */
const quotaResponse = (): Response => json429(quotaBody('Quota exceeded.'));

/** The budget a Firestore error body says refused (a `ReadBudget` refusal), or null. */
export function refusalScope(body: unknown): string | null {
  const error = (Array.isArray(body) ? body[0] : body) as { error?: { details?: { '@type'?: string; scope?: unknown }[] } } | null | undefined;
  const scope = error?.error?.details?.find((d) => d?.['@type'] === REFUSAL_TYPE)?.scope;
  return typeof scope === 'string' ? scope : null;
}

/**
 * Which budget refused, for an error from a Firestore client: `FirestoreRest`'s `budgetScope`, else
 * the refusal's message (clients that keep only the message). Null for anything else, Firestore's
 * own quota included.
 */
export function budgetScopeOf(e: unknown): string | null {
  const typed = (e as { budgetScope?: unknown } | null)?.budgetScope;
  if (typeof typed === 'string') return typed;
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const at = m.indexOf(REFUSAL);
  return at < 0 ? null : m.slice(at + REFUSAL.length).split(/\s/)[0] || null;
}

/** Where a Worker keeps the day's counts and the quota pause: D1, a Durable Object's SQLite, or memory in tests. */
export interface ReadLedger {
  /** Reads counted on `day` under each key (0 when none), and until when Firestore is paused (0: not paused). */
  read(day: string, keys: string[]): Promise<{ used: Record<string, number>; pausedUntil: number }>;
  /** Adds `reads` to `day` under each key. */
  add(day: string, keys: string[], reads: number): Promise<void>;
  /** Firestore said its quota is used up: no run starts before `until`. */
  pause(until: number): Promise<void>;
}

/** A daily share: `name` in logs and refusals, counted under `key` (default `name`) in the ledger. */
export interface DailyCap {
  name: string;
  key?: string;
  cap: number;
}

export interface ReadBudgetOptions {
  /** Reads one run may be billed for (Infinity: no cap). Past it, every further read is refused. */
  run?: number;
  /** The day's shares this run draws on (each must have room). Needs `ledger`. */
  daily?: DailyCap[];
  ledger?: ReadLedger | null;
  /** How long a 429 from Firestore stops every run (default 15 minutes; 0: not recorded). */
  pauseMs?: number;
  now?: () => number;
  /**
   * The ledger failed: the run goes on, its daily shares neither enforced nor counted (Firestore's
   * own quota still stands behind it), and `summary().ledger` says `failed`. Default: a
   * `{"event":"read-ledger","ok":false}` log line.
   */
  onLedgerError?: (e: unknown) => void;
}

/** Why a run may not start, and for how long (ms). `scope` is `paused` or a daily cap's name. */
export interface ReadRefusal {
  scope: string;
  wait: number;
  reads?: number;
}

/** A run's reads, for its log line and heartbeat. */
export interface ReadSummary {
  /** Reads billed this run. */
  reads: number;
  /** Firestore read requests made this run. */
  requests: number;
  /** The run's cap (null: none). */
  run: number | null;
  /** Each daily share's count with this run's reads in, by name. */
  day: Record<string, number>;
  /** What refused, if anything: `run`, a daily cap's name, or `project` (Firestore's own quota). */
  refused: string | null;
  /** The ledger: `failed` when it couldn't be read or written this run (the daily shares were then neither enforced nor counted). */
  ledger: 'ok' | 'failed' | 'none';
}

export const FIRESTORE_PAUSE_MS = 15 * 60_000;

/**
 * One run's Firestore reads, counted and capped. `begin()` before the run says whether it may start
 * (not while Firestore is paused, nor with a daily share spent); `fetch(inner)` is the fetch to give
 * the run's Firestore client: it counts each response's billed reads and, once a cap is reached,
 * answers further reads (and the writes after them, which may be built on a refused read) with a
 * refusal shaped like Firestore's quota answer, without asking Firestore. A real 429 from Firestore
 * pauses every run for `pauseMs`, and the run's later requests get Firestore's quota answer too.
 * `finish()` adds the run's reads to the day: call it in a `finally` (or run the work in
 * `within(fn)`, which does), so a run that throws is still counted. Requests other than Firestore's
 * (Google APIs, sign-in, push) pass through untouched.
 *
 * Reads sent at the same moment all go out before any is counted, so a run can end past its cap by
 * one batch of concurrent reads; keep fan-outs small.
 */
export class ReadBudget {
  private count = 0;
  private sent = 0;
  private stop: string | null = null;
  private ledgerFailed = false;
  private used: Record<string, number> = {};
  /** Reads already added to the ledger by `finish`. */
  private added = 0;
  private day = '';
  private readonly runCap: number;
  private readonly daily: Required<DailyCap>[];
  private readonly ledger: ReadLedger | null;
  private readonly pauseMs: number;
  private readonly now: () => number;
  private readonly onLedgerError: (e: unknown) => void;

  constructor(options: ReadBudgetOptions = {}) {
    this.runCap = options.run ?? Infinity;
    // A share without a cap (Infinity) is still counted in the ledger: the day's reads are known either way.
    this.daily = (options.daily ?? []).map((d) => ({ name: d.name, key: d.key ?? d.name, cap: d.cap }));
    this.ledger = options.ledger ?? null;
    this.pauseMs = options.pauseMs ?? FIRESTORE_PAUSE_MS;
    this.now = options.now ?? Date.now;
    const report = options.onLedgerError ?? ((e: unknown) => console.log(JSON.stringify({ event: 'read-ledger', ok: false, error: e instanceof Error ? e.name : 'unknown' })));
    this.onLedgerError = (e) => {
      this.ledgerFailed = true;
      report(e);
    };
    this.day = quotaDay(this.now());
  }

  /** Reads billed this run. */
  get reads(): number {
    return this.count;
  }

  /** Firestore read requests made this run. */
  get requests(): number {
    return this.sent;
  }

  /** What refused this run's reads, if anything: `run`, a daily share's name, or `project` (Firestore's own quota). */
  get refused(): string | null {
    return this.stop;
  }

  /** The cap this run's reads have reached, or null: the next read would go past it. */
  private reached(): string | null {
    if (this.count >= this.runCap) return 'run';
    for (const d of this.daily) if ((this.used[d.key] ?? 0) + this.count >= d.cap) return d.name;
    return null;
  }

  /** Reads left before a cap refuses (Infinity when nothing caps the run). */
  remaining(): number {
    let left = this.runCap - this.count;
    for (const d of this.daily) left = Math.min(left, d.cap - (this.used[d.key] ?? 0) - this.count);
    return Math.max(0, left);
  }

  /** Loads the day's counts; null when the run may start, else why not and for how long. */
  async begin(): Promise<ReadRefusal | null> {
    const now = this.now();
    this.day = quotaDay(now);
    if (!this.ledger) return null;
    let state: { used: Record<string, number>; pausedUntil: number };
    try {
      state = await this.ledger.read(this.day, this.daily.map((d) => d.key));
    } catch (e) {
      this.onLedgerError(e);
      return null;
    }
    this.used = state.used;
    if (state.pausedUntil > now) return { scope: 'paused', wait: state.pausedUntil - now };
    for (const d of this.daily) {
      const used = this.used[d.key] ?? 0;
      if (used >= d.cap) return { scope: d.name, wait: untilNextQuotaDay(now), reads: used };
    }
    return null;
  }

  /** The answer for a request after the run was refused: Firestore's own after its quota, else the budget's. */
  private refusal(): Response {
    return this.stop === 'project' ? quotaResponse() : refusalResponse(this.stop!);
  }

  /** `inner`, with Firestore's reads counted and refused past a cap. */
  fetch(inner: Fetch): Fetch {
    return async (url, init) => {
      if (!isFirestoreUrl(url)) return inner(url, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      // A write after a refused read may have been built from it: nothing of it is written.
      if (this.stop) return this.refusal();
      if (!isReadRequest(method, url)) return inner(url, init);
      const capped = this.reached();
      if (capped) {
        this.stop = capped;
        return this.refusal();
      }
      this.sent++;
      const res = await inner(url, init);
      const body = await res
        .clone()
        .json()
        .catch(() => null);
      if (isQuotaExhausted(res.status, body)) {
        this.stop = 'project';
        if (this.ledger && this.pauseMs > 0) await this.ledger.pause(this.now() + this.pauseMs).catch(this.onLedgerError);
        return res;
      }
      this.count += billedReads(method, url, res.status, body, init?.body);
      return res;
    };
  }

  /** Adds the run's reads not yet added to the day's shares. Safe to call more than once. */
  async finish(): Promise<void> {
    const reads = this.count - this.added;
    if (!this.ledger || reads <= 0 || this.daily.length === 0) return;
    this.added = this.count;
    await this.ledger.add(this.day, this.daily.map((d) => d.key), reads).catch(this.onLedgerError);
  }

  /** Runs `work`, then `finish()` whether it returned or threw. */
  async within<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      await this.finish();
    }
  }

  /** The run's reads, its cap, each share's day count and what refused: for the run's log line and heartbeat. */
  summary(): ReadSummary {
    return {
      reads: this.count,
      requests: this.sent,
      run: Number.isFinite(this.runCap) ? this.runCap : null,
      day: Object.fromEntries(this.daily.map((d) => [d.name, (this.used[d.key] ?? 0) + this.count])),
      refused: this.stop,
      ledger: this.ledger ? (this.ledgerFailed ? 'failed' : 'ok') : 'none',
    };
  }
}

/** A ledger in memory: tests, and a Worker run that keeps no day count. */
export function memoryLedger(): ReadLedger & { counts: Map<string, number>; pausedUntil: number } {
  const counts = new Map<string, number>();
  const ledger = {
    counts,
    pausedUntil: 0,
    async read(day: string, keys: string[]) {
      return { used: Object.fromEntries(keys.map((k) => [k, counts.get(`${day}|${k}`) ?? 0])), pausedUntil: ledger.pausedUntil };
    },
    async add(day: string, keys: string[], reads: number) {
      for (const k of keys) counts.set(`${day}|${k}`, (counts.get(`${day}|${k}`) ?? 0) + reads);
    },
    async pause(until: number) {
      ledger.pausedUntil = Math.max(ledger.pausedUntil, until);
    },
  };
  return ledger;
}

/** The part of D1 the D1 ledger uses. */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> } };
}

export interface D1LedgerOptions {
  /** A `(key TEXT PRIMARY KEY, value INTEGER)` table. Default `meta`. */
  table?: string;
  /** The row of a share's count on a day. Default `<key>-reads:<day>`. */
  rowKey?: (key: string, day: string) => string;
  /** The row holding the pause's end. Default `firestore-pause`. */
  pauseKey?: string;
}

/**
 * A ledger in a D1 table of `(key, value)` rows: a row per share and day, and the pause. One query
 * to read, one statement to add. `prune(keys, now)` drops days before yesterday; it needs `rowKey`
 * to end with the day, as the default does.
 */
export function d1Ledger(db: D1Like, { table = 'meta', rowKey = (k, d) => `${k}-reads:${d}`, pauseKey = 'firestore-pause' }: D1LedgerOptions = {}): ReadLedger & { prune(keys: string[], now: number): Promise<void> } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`d1Ledger: bad table name ${table}`);
  return {
    async read(day, keys) {
      const rows = [pauseKey, ...keys.map((k) => rowKey(k, day))];
      const { results } = await db
        .prepare(`SELECT key, value FROM ${table} WHERE key IN (${rows.map((_, i) => `?${i + 1}`).join(', ')})`)
        .bind(...rows)
        .all<{ key: string; value: number }>();
      const value = (key: string) => Number(results.find((r) => r.key === key)?.value ?? 0);
      return { used: Object.fromEntries(keys.map((k) => [k, value(rowKey(k, day))])), pausedUntil: value(pauseKey) };
    },
    async add(day, keys, reads) {
      for (const k of keys) await db.prepare(`INSERT INTO ${table} (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`).bind(rowKey(k, day), reads).run();
    },
    async pause(until) {
      await db.prepare(`INSERT INTO ${table} (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`).bind(pauseKey, until).run();
    },
    async prune(keys, now) {
      const yesterday = quotaDay(now - 24 * 3_600_000);
      for (const k of keys) {
        const prefix = rowKey(k, '');
        await db.prepare(`DELETE FROM ${table} WHERE key LIKE ?1 ESCAPE '\\' AND key < ?2`).bind(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, rowKey(k, yesterday)).run();
      }
    },
  };
}

/** The part of a Durable Object's `ctx.storage.sql` the SQLite ledger uses. */
export interface SqlLike {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
}

/**
 * A ledger in a Durable Object's SQLite (the only kind on Cloudflare's free plan): the table
 * `reads (day, key, n)` (the connector's, from before this module) and `read_pause`. Earlier days are
 * dropped as a new one is added to. Synchronous inside the object; its RPC methods make it a
 * `ReadLedger` for the Worker (`readLedgerObject`).
 */
export function sqlLedger(sql: SqlLike) {
  sql.exec('CREATE TABLE IF NOT EXISTS reads (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))');
  sql.exec('CREATE TABLE IF NOT EXISTS read_pause (id INTEGER PRIMARY KEY CHECK (id = 1), until INTEGER NOT NULL)');
  return {
    read(day: string, keys: string[]): { used: Record<string, number>; pausedUntil: number } {
      const used: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
      if (keys.length) for (const row of sql.exec<{ key: string; n: number }>(`SELECT key, n FROM reads WHERE day = ? AND key IN (${keys.map(() => '?').join(', ')})`, day, ...keys)) used[row.key] = Number(row.n);
      let pausedUntil = 0;
      for (const row of sql.exec<{ until: number }>('SELECT until FROM read_pause WHERE id = 1')) pausedUntil = Number(row.until);
      return { used, pausedUntil };
    },
    add(day: string, keys: string[], reads: number): void {
      if (!(reads > 0)) return;
      sql.exec('DELETE FROM reads WHERE day < ?', day);
      for (const key of keys) sql.exec('INSERT INTO reads (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n', day, key, reads);
    },
    pause(until: number): void {
      sql.exec('INSERT INTO read_pause (id, until) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET until = MAX(until, excluded.until)', until);
    },
  };
}

type ObjectBase = abstract new (...args: any[]) => object;

/**
 * A Durable Object class holding a Worker's ledger, from Cloudflare's `DurableObject` (passed in, so
 * the kit needs no `cloudflare:workers`):
 *
 *     import { DurableObject } from 'cloudflare:workers';
 *     export class ReadLedgerObject extends readLedgerObject(DurableObject) {}
 *
 * with a SQLite-backed binding in wrangler.toml (`new_sqlite_classes`). Its stub is the
 * `ReadLedger`: `env.READ_LEDGER.get(env.READ_LEDGER.idFromName('reads'))`.
 */
export function readLedgerObject<B extends ObjectBase>(Base: B) {
  const ledgers = new WeakMap<object, ReturnType<typeof sqlLedger>>();
  const of = (self: object) => {
    let l = ledgers.get(self);
    if (!l) ledgers.set(self, (l = sqlLedger((self as { ctx?: { storage: { sql: SqlLike } } }).ctx!.storage.sql)));
    return l;
  };
  abstract class Ledger extends Base {
    read(day: string, keys: string[]) {
      return of(this).read(day, keys);
    }
    add(day: string, keys: string[], reads: number) {
      of(this).add(day, keys, reads);
    }
    pause(until: number) {
      of(this).pause(until);
    }
  }
  return Ledger;
}
