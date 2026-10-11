/**
 * Signed-in tests against real Firebase: the `huishouden-staging` project (Spark, free) in the
 * kit's staging job, or the Auth and Firestore emulators in its `app-tests` job. Everything here
 * refuses to run against any other project.
 *
 * Every CI run gets households of its own: `testHousehold(scope)` names one for the run
 * (`HH_STAGING_RUN`, `e2e-<repo>-<run id>-<attempt>`) and the spec file, with its own invented admin,
 * member, helper and kid. The spec that needs them seeds them (`seedTestHousehold`), and the job
 * removes the run's households and users at the end (`cleanupTestRun`); a nightly sweep removes
 * any a cancelled run left (`sweepStaging`). Nothing is shared between runs, so two repos' runs
 * never see each other's data, and a run reads only what it wrote: staging's free quota is 50,000
 * document reads a day for every app's runs together.
 *
 * Sign-in doesn't use Google: CI mints Firebase custom tokens for the invented users with the
 * staging deploy service account (IAM `signJwt`, keyless through Workload Identity Federation), and
 * the page signs in with `signInWithCustomToken`. On the emulators the token is unsigned, which only
 * the emulator accepts.
 *
 * Runs in Node or bun (CI, Playwright), never in an app bundle.
 */
import { decodeFields, encodeFields, type Value } from './firestore-rest.js';
import { SUITE_SITE } from './suite.js';

export const STAGING_PROJECT = 'huishouden-staging';
/** The emulators' project in the kit's app-tests job: `demo-` projects never reach Google. */
export const EMULATOR_PROJECT = 'demo-huishouden';

export type TestRole = 'admin' | 'member' | 'helper' | 'kid';
export const TEST_ROLES: readonly TestRole[] = ['admin', 'member', 'helper', 'kid'];

export interface TestUser {
  uid: string;
  /** `<household id>-<role>@example.com`: `example.com` is reserved, so it can never reach anyone. */
  email: string;
  name: string;
  role: TestRole;
}

export interface TestHousehold {
  /** `e2e-<repo>-<run id>-<attempt>-<scope>` in CI. */
  id: string;
  name: string;
  users: Record<TestRole, TestUser>;
}

export type E2eTarget = 'staging' | 'emulator';

type Env = Record<string, string | undefined>;

const processEnv = (): Env => (globalThis as { process?: { env: Env } }).process?.env ?? {};

/** `emulator` in the kit's app-tests job (`HH_E2E_TARGET=emulator`), otherwise `staging`. */
export function e2eTarget(env: Env = processEnv()): E2eTarget {
  return env.HH_E2E_TARGET === 'emulator' ? 'emulator' : 'staging';
}

/** The project the target's users and households live in. */
export function e2eProject(env: Env = processEnv()): string {
  if (e2eTarget(env) === 'staging') return STAGING_PROJECT;
  const project = env.HH_EMULATOR_PROJECT || EMULATOR_PROJECT;
  if (!project.startsWith('demo-')) throw new Error(`The emulators' project must be a demo- project, not "${project}"`);
  return project;
}

/** The production Firebase project, which no test, seed or sign-in helper may ever touch. */
export const PRODUCTION_PROJECT = SUITE_SITE;

const PRODUCTION_HINT =
  'That is production. A .env.local (bun and Vite both read it) or an exported VITE_FIREBASE_* with the production values is the usual cause: delete it and run `hh dev verify` or `hh dev evidence`, which build with an explicit staging or emulator env.';

/** Throws, before any sign-in or write, when `projectId` is the production project. */
export function assertNotProduction(projectId: string | undefined, what = 'Firebase project'): void {
  if (projectId === PRODUCTION_PROJECT) throw new Error(`${what} is "${projectId}"; tests never run against production. ${PRODUCTION_HINT}`);
}

/** Throws when `url` is the production site (huishouden-piekstra.web.app or .firebaseapp.com). */
export function assertNotProductionUrl(url: string | undefined, what = 'BASE_URL'): void {
  if (!url) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // A safety check fails closed: a value that cannot be read cannot be shown not to be production.
    throw new Error(`${what} is not a URL: "${url}"`);
  }
  if (host === `${PRODUCTION_PROJECT}.web.app` || host === `${PRODUCTION_PROJECT}.firebaseapp.com`) {
    throw new Error(`${what} is the production site (${host}); tests run on the emulators or ${STAGING_PROJECT}, never production`);
  }
}

export function assertStagingProject(projectId: string | undefined, what = 'Firebase project'): void {
  assertNotProduction(projectId, what);
  if (projectId !== STAGING_PROJECT) {
    throw new Error(`${what} is ${projectId ? `"${projectId}"` : 'unknown'}; test sign-in and seeding only run against ${STAGING_PROJECT}`);
  }
}

const RUN_ID = /^e2e-[a-z0-9][a-z0-9-]*$/;

/**
 * This run's id: `HH_STAGING_RUN` (the kit's jobs set `e2e-<repo>-<run id>-<attempt>`), else
 * `e2e-emulator` on the emulators and `e2e-local` on staging from a laptop.
 */
export function testRunId(env: Env = processEnv()): string {
  const id = (env.HH_STAGING_RUN || (e2eTarget(env) === 'emulator' ? 'e2e-emulator' : 'e2e-local')).toLowerCase();
  if (!RUN_ID.test(id)) throw new Error(`HH_STAGING_RUN "${id}" must start with e2e- and use only a-z, 0-9 and -`);
  return id;
}

/**
 * A run from a laptop (`pwa-staging run`): `e2e-local-<who>-<time>`, unique per run, so two people's
 * (or one person's two) runs never share a household, and the sweep knows it by its `e2e-` prefix.
 */
export function localRunId(who: string, now = Date.now()): string {
  const slug = who.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 12) || 'dev';
  return `e2e-local-${slug}-${now.toString(36)}`;
}

/** The kit's jobs' run id: `e2e-<repo>-<run id>-<attempt>`. */
export function ciRunId(repository: string, runId: string | number, attempt: string | number): string {
  const repo = repository.split('/').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `e2e-${repo}-${runId}-${attempt}`;
}

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Longest household id: `<id>-member@example.com` must fit an email's 64-character local part. */
const MAX_ID = 50;

/**
 * The run's household for `scope` (a spec file's name; default the run's own), with its four
 * invented people. Pure: the same run and scope name the same household and users in every worker.
 */
export function testHousehold(scope = '', env: Env = processEnv()): TestHousehold {
  const run = testRunId(env);
  const slug = scope
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(spec|test)\.[a-z]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  let id = slug ? `${run}-${slug}` : run;
  if (id.length > MAX_ID) id = `${id.slice(0, MAX_ID - 8).replace(/-$/, '')}-${shortHash(id).slice(0, 7)}`;
  const user = (role: TestRole): TestUser => ({
    uid: `${id}-${role}`,
    email: `${id}-${role}@example.com`,
    name: `Test ${role[0]!.toUpperCase()}${role.slice(1)}`,
    role,
  });
  return { id, name: 'Test household', users: { admin: user('admin'), member: user('member'), helper: user('helper'), kid: user('kid') } };
}

/** Which of the household's users `email` is; throws for anyone else. */
export function testUserByEmail(household: TestHousehold, email: string): TestUser {
  const e = email.trim().toLowerCase();
  const user = Object.values(household.users).find((u) => u.email === e);
  if (!user) throw new Error(`${email} is not one of this run's test users (${Object.values(household.users).map((u) => u.email).join(', ')})`);
  return user;
}

/** The audience Firebase Auth requires on a custom token. */
export const CUSTOM_TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

export interface AdminRestCall {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  body?: unknown;
}

/** Firebase custom-token claims for `uid`, issued by `serviceAccount`, valid for an hour. */
export function customTokenClaims(uid: string, serviceAccount: string, nowMs: number) {
  const iat = Math.floor(nowMs / 1000);
  return { iss: serviceAccount, sub: serviceAccount, aud: CUSTOM_TOKEN_AUDIENCE, iat, exp: iat + 3600, uid };
}

export function signJwtRequest(uid: string, serviceAccount: string, nowMs: number): AdminRestCall {
  if (!serviceAccount.endsWith(`@${STAGING_PROJECT}.iam.gserviceaccount.com`)) {
    throw new Error(`Custom tokens are only minted by a ${STAGING_PROJECT} service account, not ${serviceAccount}`);
  }
  return {
    method: 'POST',
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signJwt`,
    body: { payload: JSON.stringify(customTokenClaims(uid, serviceAccount, nowMs)) },
  };
}

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An unsigned custom token, which only the Auth emulator accepts. */
export function emulatorCustomToken(uid: string, nowMs: number): string {
  const claims = customTokenClaims(uid, 'firebase-auth-emulator@example.com', nowMs);
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.`;
}

// --- Quota ---------------------------------------------------------------------------------------

/** When Firestore's free daily quota next resets: midnight Pacific, as `HH:00 UTC`. */
export function quotaResetUtc(now = Date.now()): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' }) // locale-check:allow (a UTC offset for a CI message)
    .formatToParts(new Date(now))
    .find((p) => p.type === 'timeZoneName')?.value;
  const offset = Number(/GMT([+-]\d+)/.exec(part ?? '')?.[1] ?? -7);
  return `${String((24 - offset) % 24).padStart(2, '0')}:00 UTC`;
}

/** Firestore said the project's daily quota is used up (Spark: 50k reads, 20k writes, 20k deletes). */
export class StagingQuotaError extends Error {
  constructor(what: string, now = Date.now()) {
    super(`staging quota exceeded — rerun after ${quotaResetUtc(now)} (${what}: the free daily Firestore quota of ${STAGING_PROJECT} is used up; it resets at midnight Pacific)`);
    this.name = 'StagingQuotaError';
  }
}

/** A 429 or RESOURCE_EXHAUSTED from a Google API. */
export function isQuotaExceeded(status: number, body: string): boolean {
  return status === 429 || /RESOURCE_EXHAUSTED/.test(body);
}

// --- Admin REST --------------------------------------------------------------------------------

export interface AdminCredentials {
  /** Staging: the deploy service account's OAuth access token (default `HH_STAGING_ACCESS_TOKEN`). */
  accessToken?: string;
  /** Where HH_* settings are read from (default `process.env`). */
  env?: Env;
  fetchImpl?: typeof fetch;
}

interface Admin {
  project: string;
  firestore: string;
  identity: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

function admin({ accessToken, env = processEnv(), fetchImpl = fetch }: AdminCredentials = {}): Admin {
  const project = e2eProject(env);
  if (e2eTarget(env) === 'emulator') {
    const host = env.HH_EMULATOR_HOST || '127.0.0.1';
    return {
      project,
      firestore: `http://${host}:${env.HH_EMULATOR_FIRESTORE_PORT || 8080}/v1/projects/${project}/databases/(default)/documents`,
      identity: `http://${host}:${env.HH_EMULATOR_AUTH_PORT || 9099}/identitytoolkit.googleapis.com/v1/projects/${project}`,
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      fetchImpl,
    };
  }
  const token = accessToken || env.HH_STAGING_ACCESS_TOKEN;
  if (!token) throw new Error("Staging test data needs the staging CI job's HH_STAGING_ACCESS_TOKEN");
  return {
    project,
    firestore: `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`,
    identity: `https://identitytoolkit.googleapis.com/v1/projects/${project}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goog-user-project': project },
    fetchImpl,
  };
}

function describe(req: AdminRestCall): string {
  const path = new URL(req.url).pathname;
  return `${req.method} ${path.includes('/documents') ? path.slice(path.indexOf('/documents') + 10) || '/' : path}`;
}

async function call<T = Record<string, unknown>>(a: Admin, req: AdminRestCall): Promise<T> {
  const res = await a.fetchImpl(req.url, { method: req.method, headers: a.headers, body: req.body === undefined ? undefined : JSON.stringify(req.body) });
  const text = await res.text();
  if (!res.ok && isQuotaExceeded(res.status, text)) throw new StagingQuotaError(describe(req));
  if (!res.ok) throw new Error(`${describe(req)}: ${res.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const docName = (a: Admin, path: string) => `projects/${a.project}/databases/(default)/documents/${path}`;

const updates = (a: Admin, household: TestHousehold, docs: Record<string, Record<string, unknown>>) =>
  Object.entries(docs).map(([path, data]) => ({ update: { name: docName(a, `households/${household.id}/${path}`), fields: encodeFields(data) } }));

/** The seed as two Admin REST calls: the users (overwritten, emails verified), then one commit. */
export function seedRequests(household: TestHousehold, docs: Record<string, Record<string, unknown>> = {}, credentials: AdminCredentials = {}, now = Date.now()): AdminRestCall[] {
  const a = admin(credentials);
  const users = Object.values(household.users);
  const emails = users.map((u) => u.email);
  const data = {
    name: household.name,
    members: emails,
    joined: emails,
    roles: Object.fromEntries(users.map((u) => [u.email, u.role])),
    // Old and fixed, so `pickHousehold` prefers it over any household a test creates; the sweep
    // ages it by `seededAt`.
    createdAt: Date.UTC(2026, 0, 1),
    seededAt: now,
  };
  return [
    {
      method: 'POST',
      url: `${a.identity}/accounts:batchCreate`,
      body: { users: users.map((u) => ({ localId: u.uid, email: u.email, emailVerified: true, displayName: u.name })), allowOverwrite: true },
    },
    {
      method: 'POST',
      url: `${a.firestore}:commit`,
      body: { writes: [{ update: { name: docName(a, `households/${household.id}`), fields: encodeFields(data) } }, ...updates(a, household, docs)] },
    },
  ];
}

export interface SeedOptions extends AdminCredentials {
  /** The household to seed (default the run's own, `testHousehold()`). */
  household?: TestHousehold;
  /** App data written with it, by path under the household (`{ 'agenda/e1': {...} }`), in the same commit. */
  docs?: Record<string, Record<string, unknown>>;
}

/**
 * Creates or resets the household's four users and its document, plus `docs`: two calls, one
 * write per document. Idempotent, so every spec (and a retry) that needs the household may call it.
 */
export async function seedTestHousehold(options: SeedOptions = {}): Promise<TestHousehold> {
  const household = options.household ?? testHousehold('', options.env);
  const a = admin(options);
  const [users, commit] = seedRequests(household, options.docs, options);
  const created = await call(a, users!);
  if (Array.isArray(created.error) && created.error.length) throw new Error(`test users: ${JSON.stringify(created.error)}`);
  await call(a, commit!);
  return household;
}

/** Writes `docs` (paths under the household) in one batched commit. */
export async function writeTestDocs(household: TestHousehold, docs: Record<string, Record<string, unknown>>, credentials: AdminCredentials = {}): Promise<void> {
  const a = admin(credentials);
  const writes = updates(a, household, docs);
  if (writes.length) await call(a, { method: 'POST', url: `${a.firestore}:commit`, body: { writes } });
}

/**
 * One document under the household, read with admin access: one read, or null when it doesn't
 * exist. Check a write with this rather than by listing a collection, which reads every document.
 */
export async function getTestDoc(household: TestHousehold, path: string, credentials: AdminCredentials = {}): Promise<Record<string, unknown> | null> {
  const a = admin(credentials);
  const req: AdminRestCall = { method: 'GET', url: `${a.firestore}/households/${household.id}/${path}` };
  const res = await a.fetchImpl(req.url, { headers: a.headers });
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok && isQuotaExceeded(res.status, text)) throw new StagingQuotaError(describe(req));
  if (!res.ok) throw new Error(`${describe(req)}: ${res.status} ${text.slice(0, 300)}`);
  return decodeFields((JSON.parse(text) as { fields?: Record<string, Value> }).fields);
}

type QueryRow = { document?: { name: string; fields?: Record<string, Value> } };

async function runQuery(a: Admin, parent: string, structuredQuery: Record<string, unknown>): Promise<QueryRow[]> {
  const rows = await call<QueryRow[]>(a, { method: 'POST', url: `${a.firestore}${parent ? `/${parent}` : ''}:runQuery`, body: { structuredQuery } });
  return (Array.isArray(rows) ? rows : []).filter((r) => r.document);
}

/** Every document under `path`, at any depth, by name only (one read each). */
async function descendants(a: Admin, path: string): Promise<string[]> {
  const names: string[] = [];
  for (;;) {
    const query: Record<string, unknown> = {
      from: [{ allDescendants: true }],
      select: { fields: [{ fieldPath: '__name__' }] },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: 500,
    };
    if (names.length) query.startAt = { values: [{ referenceValue: names[names.length - 1] }], before: false };
    const page = (await runQuery(a, path, query)).map((r) => r.document!.name);
    names.push(...page);
    if (page.length < 500) return names;
  }
}

/** Deletes a household and everything under it, 500 deletes per commit. Returns how many documents. */
export async function deleteHousehold(id: string, credentials: AdminCredentials = {}): Promise<number> {
  const a = admin(credentials);
  const names = [...(await descendants(a, `households/${id}`)), docName(a, `households/${id}`)];
  for (let i = 0; i < names.length; i += 500) {
    await call(a, { method: 'POST', url: `${a.firestore}:commit`, body: { writes: names.slice(i, i + 500).map((name) => ({ delete: name })) } });
  }
  return names.length;
}

/** The households any of `emails` belongs to (reads only the matches). */
async function householdsOf(a: Admin, emails: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (let i = 0; i < emails.length; i += 10) {
    const rows = await runQuery(a, '', {
      from: [{ collectionId: 'households' }],
      where: { fieldFilter: { field: { fieldPath: 'members' }, op: 'ARRAY_CONTAINS_ANY', value: { arrayValue: { values: emails.slice(i, i + 10).map((e) => ({ stringValue: e })) } } } },
      select: { fields: [{ fieldPath: '__name__' }] },
    });
    for (const r of rows) ids.add(r.document!.name.split('/').pop()!);
  }
  return [...ids];
}

/** The id just after every id that starts with `prefix`. */
const afterPrefix = (prefix: string) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/** Households whose id starts with `prefix`, with when they were seeded (0 if never). */
async function householdsByPrefix(a: Admin, prefix: string): Promise<{ id: string; seededAt: number }[]> {
  const rows = await runQuery(a, '', {
    from: [{ collectionId: 'households' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: { referenceValue: docName(a, `households/${prefix}`) } } },
          { fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN', value: { referenceValue: docName(a, `households/${afterPrefix(prefix)}`) } } },
        ],
      },
    },
    select: { fields: [{ fieldPath: 'seededAt' }] },
  });
  return rows.map((r) => {
    const seeded = r.document!.fields?.seededAt as { integerValue?: string } | undefined;
    return { id: r.document!.name.split('/').pop()!, seededAt: Number(seeded?.integerValue ?? 0) };
  });
}

interface AuthUser {
  localId: string;
  email?: string;
  /** Milliseconds, as a string. */
  createdAt?: string;
}

async function listUsers(a: Admin): Promise<AuthUser[]> {
  const users: AuthUser[] = [];
  let pageToken = '';
  for (;;) {
    const res = await call<{ users?: AuthUser[]; nextPageToken?: string }>(a, {
      method: 'GET',
      url: `${a.identity}/accounts:batchGet?maxResults=1000${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ''}`,
    });
    users.push(...(res.users ?? []));
    if (!res.nextPageToken || !res.users?.length) return users;
    pageToken = res.nextPageToken;
  }
}

async function deleteUsers(a: Admin, uids: string[]): Promise<void> {
  for (let i = 0; i < uids.length; i += 1000) {
    await call(a, { method: 'POST', url: `${a.identity}/accounts:batchDelete`, body: { localIds: uids.slice(i, i + 1000), force: true } });
  }
}

export interface CleanupReport {
  households: string[];
  documents: number;
  users: number;
}

async function removeUsersAndHouseholds(a: Admin, users: AuthUser[], named: string[], credentials: AdminCredentials): Promise<CleanupReport> {
  const emails = users.flatMap((u) => (u.email ? [u.email.toLowerCase()] : []));
  const households = [...new Set([...named, ...(emails.length ? await householdsOf(a, emails) : [])])];
  let documents = 0;
  for (const id of households) documents += await deleteHousehold(id, credentials);
  await deleteUsers(a, users.map((u) => u.localId));
  return { households, documents, users: users.length };
}

/**
 * Removes everything this run made: its users, every household any of them belongs to (the seeded
 * ones and any a test created) and households named for the run. The kit's staging job runs it
 * after the tests (`pwa-staging cleanup`).
 */
export async function cleanupTestRun(credentials: AdminCredentials = {}): Promise<CleanupReport> {
  const a = admin(credentials);
  const run = testRunId(credentials.env);
  const users = (await listUsers(a)).filter((u) => u.localId.startsWith(`${run}-`));
  const named = (await householdsByPrefix(a, run)).map((h) => h.id).filter((id) => id === run || id.startsWith(`${run}-`));
  return removeUsersAndHouseholds(a, users, named, credentials);
}

/** The shared fixture of kits before 0.72, which every run reseeded; the sweep removes it. */
export const LEGACY_TEST_UIDS: readonly string[] = ['test-a', 'test-b', 'test-helper'];
export const LEGACY_TEST_HOUSEHOLD = 'test-household';

/**
 * Removes what runs left behind (cancelled, or killed before their cleanup): `e2e-` users and
 * `e2e-` households older than `olderThanMs` (default a day) with every household those users
 * belong to, and the shared fixture of older kits. The portal's nightly run (`pwa-staging sweep`).
 */
export async function sweepStaging({ olderThanMs = 86_400_000, now = Date.now(), ...credentials }: AdminCredentials & { olderThanMs?: number; now?: number } = {}): Promise<CleanupReport> {
  const a = admin(credentials);
  if (a.project !== STAGING_PROJECT) throw new Error('The sweep is for the staging project');
  const cutoff = now - olderThanMs;
  const users = (await listUsers(a)).filter((u) => (u.localId.startsWith('e2e-') && Number(u.createdAt ?? 0) < cutoff) || LEGACY_TEST_UIDS.includes(u.localId));
  const old = (await householdsByPrefix(a, 'e2e-')).filter((h) => h.seededAt < cutoff).map((h) => h.id);
  const legacy = (await householdsByPrefix(a, LEGACY_TEST_HOUSEHOLD)).filter((h) => h.id === LEGACY_TEST_HOUSEHOLD).map((h) => h.id);
  return removeUsersAndHouseholds(a, users, [...old, ...legacy], credentials);
}

/**
 * One read of a document that doesn't exist. Throws `StagingQuotaError` when today's quota is used
 * up, so the job stops with that rather than with a page of timeouts.
 */
export async function checkStagingQuota(credentials: AdminCredentials = {}): Promise<void> {
  const a = admin(credentials);
  const req: AdminRestCall = { method: 'GET', url: `${a.firestore}/households/e2e-quota-probe` };
  const res = await a.fetchImpl(req.url, { headers: a.headers });
  const text = await res.text();
  if (!res.ok && isQuotaExceeded(res.status, text)) throw new StagingQuotaError('a one-document read');
  if (!res.ok && res.status !== 404) throw new Error(`quota probe: ${res.status} ${text.slice(0, 300)}`);
}

// --- Sign-in -------------------------------------------------------------------------------------

/** A Firebase custom token for a test user: signed by the staging service account, unsigned on the emulators. */
export async function mintCustomToken({
  uid,
  serviceAccount,
  accessToken,
  env = processEnv(),
  fetchImpl = fetch,
  now = Date.now(),
}: AdminCredentials & { uid: string; serviceAccount?: string; now?: number }): Promise<string> {
  if (e2eTarget(env) === 'emulator') return emulatorCustomToken(uid, now);
  if (!serviceAccount) throw new Error('Minting a staging token needs the staging service account (HH_STAGING_SA)');
  const { signedJwt } = await call(admin({ accessToken, env, fetchImpl }), signJwtRequest(uid, serviceAccount, now));
  if (typeof signedJwt !== 'string') throw new Error('signJwt returned no token');
  return signedJwt;
}

export interface StagingWebConfig {
  apiKey: string;
  projectId: string;
  authDomain?: string;
}

/**
 * The Firebase web config a test signs in with, and the guard that it is staging's. The build's
 * VITE_FIREBASE_* (what the app was built with) win over the site's /__/firebase/init.json (what its
 * Hosting project serves); either one naming another project refuses, as does a missing API key.
 */
export function stagingWebConfig(env: Env, site: { apiKey?: string; projectId?: string; authDomain?: string } | null): StagingWebConfig {
  if (site?.projectId) assertStagingProject(site.projectId, "This site's Hosting project");
  const projectId = env.VITE_FIREBASE_PROJECT_ID || site?.projectId;
  assertStagingProject(projectId, "The app's Firebase project");
  const apiKey = env.VITE_FIREBASE_API_KEY || site?.apiKey;
  if (!apiKey) throw new Error('No Firebase API key: set VITE_FIREBASE_API_KEY or test a Firebase Hosting site');
  return { apiKey, projectId: projectId!, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || site?.authDomain };
}

/** The web config of an app built for the emulators (the kit's app-tests job builds with these). */
export function emulatorWebConfig(env: Env = processEnv()): StagingWebConfig {
  assertNotProduction(env.VITE_FIREBASE_PROJECT_ID, "The app's Firebase project");
  return { apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key', projectId: e2eProject(env), authDomain: 'localhost' };
}

/** The staging job's credentials (see .github/workflows/pwa.yml). */
export function stagingCredentialsFromEnv(env: Env = processEnv()): { accessToken: string; serviceAccount: string } {
  const accessToken = env.HH_STAGING_ACCESS_TOKEN;
  const serviceAccount = env.HH_STAGING_SA;
  if (!accessToken || !serviceAccount) {
    throw new Error('Test sign-in runs in the staging CI job only: HH_STAGING_ACCESS_TOKEN and HH_STAGING_SA are not set');
  }
  return { accessToken, serviceAccount };
}

/**
 * Whether signed-in tests can run here: on the emulators, or with the staging job's credentials.
 * Specs skip without: `test.skip(!signedInTestsAvailable(), 'signed-in tests run in CI')`.
 */
export function signedInTestsAvailable(env: Env = processEnv()): boolean {
  return e2eTarget(env) === 'emulator' || !!(env.HH_STAGING_ACCESS_TOKEN && env.HH_STAGING_SA);
}
