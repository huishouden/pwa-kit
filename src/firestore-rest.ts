/**
 * Firestore over REST for servers (no Firebase SDK, no DOM), as the signed-in person (their Firebase ID token on every call), so the
 * household's security rules decide every read and write exactly as in the apps. Values come back
 * typed (`{"integerValue": "5"}`) and are decoded into plain JSON; whole numbers are written as
 * integers, as the Firebase SDK does, since the rules check `is int`.
 */

import { refusalScope } from './read-budget.js';

export type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: Value[] } }
  | { mapValue: { fields?: Record<string, Value> } };

export interface Doc {
  id: string;
  /** Path under `documents/`: households/h1/items/i1 */
  path: string;
  data: Record<string, unknown>;
  updateTime?: string;
}

/** `increment(n)`: added on the server, as the SDK's FieldValue. */
export class Increment {
  constructor(readonly by: number) {}
}

/** `deleteField()` in a merge: the field is removed, as the SDK's FieldValue. */
export class FieldDelete {}

export type Code = 'permission-denied' | 'not-found' | 'already-exists' | 'failed-precondition' | 'invalid-argument' | 'unauthenticated' | 'unavailable' | 'resource-exhausted' | 'unknown';

export class FirestoreError extends Error {
  constructor(
    readonly code: Code,
    message: string,
    /** The `ReadBudget` cap that refused (`./read-budget`), when it was one rather than Firestore. */
    readonly budgetScope?: string,
  ) {
    super(message);
  }
}

const STATUS_CODES: Record<string, Code> = {
  PERMISSION_DENIED: 'permission-denied',
  NOT_FOUND: 'not-found',
  ALREADY_EXISTS: 'already-exists',
  FAILED_PRECONDITION: 'failed-precondition',
  INVALID_ARGUMENT: 'invalid-argument',
  UNAUTHENTICATED: 'unauthenticated',
  UNAVAILABLE: 'unavailable',
  ABORTED: 'unavailable',
  // The project's daily quota (the free plan's 50,000 reads), or a `ReadBudget` cap (./read-budget).
  RESOURCE_EXHAUSTED: 'resource-exhausted',
};

export function encode(v: unknown): Value {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  throw new FirestoreError('invalid-argument', `Cannot store a ${typeof v}`);
}

/** Fields of a document, leaving out `undefined` (as JSON does) and increments (written as transforms). */
export function encodeFields(data: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined && !(v instanceof Increment) && !(v instanceof FieldDelete)) out[k] = encode(v);
  return out;
}

export function decode(value: Value): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields);
  return undefined;
}

export function decodeFields(fields: Record<string, Value> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decode(v)]));
}

/** A field path segment, quoted when it isn't a simple name ("2031-01-05" in a map of days). */
const segment = (k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `\`${k.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Increment) && !(v instanceof FieldDelete);

/** Leaf field paths of a merge, as the SDK's `set(…, { merge: true })` writes them (nested maps merge too); a `FieldDelete` is in the mask but not the values, so it goes. */
export function mergePaths(data: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(data).flatMap(([k, v]) => {
    if (v === undefined || v instanceof Increment) return [];
    const path = prefix + segment(k);
    return isPlainObject(v) && Object.keys(v).length > 0 ? mergePaths(v, `${path}.`) : [path];
  });
}

function transforms(data: Record<string, unknown>, prefix = ''): { fieldPath: string; increment: Value }[] {
  return Object.entries(data).flatMap(([k, v]) => {
    const path = prefix + segment(k);
    if (v instanceof Increment) return [{ fieldPath: path, increment: encode(v.by) }];
    return isPlainObject(v) ? transforms(v, `${path}.`) : [];
  });
}

/** One write in a commit: a full set, a merge (creating the document if missing), a create that must not overwrite, or a delete. */
export type Write =
  | { path: string; set: Record<string, unknown> }
  | { path: string; merge: Record<string, unknown> }
  | { path: string; create: Record<string, unknown> }
  | { path: string; delete: true };

export interface FieldFilter {
  field: string;
  op: 'EQUAL' | 'ARRAY_CONTAINS' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL' | 'IN';
  value: unknown;
}

export interface QueryOptions {
  where?: FieldFilter[];
  orderBy?: { field: string; direction?: 'ASCENDING' | 'DESCENDING' }[];
  limit?: number;
}

/** `fetch`, or a stand-in for tests. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FirestoreRestOptions {
  projectId: string;
  /** The person's Firebase ID token (`./firebase-auth-rest`), fresh for each call. */
  token: () => Promise<string>;
  /** Default https://firestore.googleapis.com/v1; the emulator's is http://127.0.0.1:8080/v1. */
  baseUrl?: string;
  fetch?: Fetch;
}

export class FirestoreRest {
  readonly root: string;
  readonly projectId: string;
  private readonly base: string;
  private readonly token: () => Promise<string>;
  private readonly fetchImpl: Fetch;

  constructor({ projectId, token, baseUrl = 'https://firestore.googleapis.com/v1', fetch: fetchImpl }: FirestoreRestOptions) {
    this.projectId = projectId;
    this.token = token;
    this.base = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
    this.root = `projects/${projectId}/databases/(default)/documents`;
  }

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${url}`, {
        method,
        headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new FirestoreError('unavailable', 'Firestore unreachable');
    }
    const parsed = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      const error = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { status?: string; message?: string } } | undefined;
      const status = error?.error?.status ?? '';
      const scope = refusalScope(parsed);
      throw new FirestoreError(
        STATUS_CODES[status] ?? (res.status === 403 ? 'permission-denied' : res.status === 404 ? 'not-found' : res.status === 429 ? 'resource-exhausted' : 'unknown'),
        `Firestore ${res.status} ${status}${scope ? `: ${error?.error?.message ?? ''}` : ''}`.trim(),
        scope ?? undefined,
      );
    }
    return parsed as T;
  }

  private docOf(raw: { name: string; fields?: Record<string, Value>; updateTime?: string }): Doc {
    const at = raw.name.indexOf('/documents/');
    const path = raw.name.slice(at + '/documents/'.length);
    return { id: path.split('/').pop()!, path, data: decodeFields(raw.fields), updateTime: raw.updateTime };
  }

  /** The document, or null when it doesn't exist. A refused read throws `permission-denied`. */
  async get(path: string): Promise<Doc | null> {
    try {
      return this.docOf(await this.call('GET', `${this.root}/${path}`));
    } catch (e) {
      if (e instanceof FirestoreError && e.code === 'not-found') return null;
      throw e;
    }
  }

  /**
   * Documents of `collection` under `parent` (a document path, or '' for the root) matching every
   * filter. The rules check the query as a whole, so a helper's reads of private-capable
   * collections must ask for `private == false`.
   */
  async query(parent: string, collection: string, { where = [], orderBy = [], limit }: QueryOptions = {}): Promise<Doc[]> {
    const filters = where.map((f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: encode(f.value) } }));
    const structuredQuery = {
      from: [{ collectionId: collection }],
      ...(filters.length === 1 ? { where: filters[0] } : filters.length > 1 ? { where: { compositeFilter: { op: 'AND', filters } } } : {}),
      ...(orderBy.length ? { orderBy: orderBy.map((o) => ({ field: { fieldPath: o.field }, direction: o.direction ?? 'ASCENDING' })) } : {}),
      ...(limit ? { limit } : {}),
    };
    const url = parent ? `${this.root}/${parent}:runQuery` : `${this.root}:runQuery`;
    const rows = await this.call<{ document?: { name: string; fields?: Record<string, Value>; updateTime?: string } }[]>('POST', url, { structuredQuery });
    return rows.filter((r) => r.document).map((r) => this.docOf(r.document!));
  }

  /**
   * How many documents of `collection` under `parent` match, and the sum of each of `sum`'s
   * fields over them, in one request (Firestore bills one read per 1000 index entries). Cheap
   * enough to ask every few minutes whether anything changed: any write that changes `updatedAt`,
   * adds or removes a document moves the count or the sum.
   */
  async aggregate(parent: string, collection: string, { where = [] }: Pick<QueryOptions, 'where'> = {}, sum: string[] = []): Promise<{ count: number; sums: Record<string, number> }> {
    const filters = where.map((f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: encode(f.value) } }));
    const structuredQuery = {
      from: [{ collectionId: collection }],
      ...(filters.length === 1 ? { where: filters[0] } : filters.length > 1 ? { where: { compositeFilter: { op: 'AND', filters } } } : {}),
    };
    const aggregations = [{ alias: 'n', count: {} }, ...sum.map((field, i) => ({ alias: `s${i}`, sum: { field: { fieldPath: field } } }))];
    const url = parent ? `${this.root}/${parent}:runAggregationQuery` : `${this.root}:runAggregationQuery`;
    const rows = await this.call<{ result?: { aggregateFields?: Record<string, Value> } }[]>('POST', url, { structuredAggregationQuery: { structuredQuery, aggregations } });
    const fields = rows.find((r) => r.result)?.result?.aggregateFields ?? {};
    const num = (v: Value | undefined) => (v ? Number(decode(v)) || 0 : 0);
    return { count: num(fields.n), sums: Object.fromEntries(sum.map((f, i) => [f, num(fields[`s${i}`])])) };
  }

  /** Every write at once, or none: the rules check each as if the app had made it. */
  async commit(writes: Write[]): Promise<void> {
    if (writes.length === 0) return;
    const name = (path: string) => `${this.root}/${path}`;
    const body = writes.map((w) => {
      if ('delete' in w) return { delete: name(w.path) };
      const data = 'set' in w ? w.set : 'merge' in w ? w.merge : w.create;
      const fieldTransforms = transforms(data);
      return {
        update: { name: name(w.path), fields: encodeFields(data) },
        ...('merge' in w ? { updateMask: { fieldPaths: mergePaths(data) } } : {}),
        ...('create' in w ? { currentDocument: { exists: false } } : {}),
        ...(fieldTransforms.length ? { updateTransforms: fieldTransforms } : {}),
      };
    });
    await this.call('POST', `${this.root}:commit`, { writes: body });
  }
}
