import { describe, expect, test } from 'bun:test';
import seedFixture from './fixtures/staging/seed-requests.json';
import claimsFixture from './fixtures/staging/sign-jwt-claims.json';
import partialError from './fixtures/staging/batch-create-partial-error.json';
import authUsers from './fixtures/staging/auth-users.json';
import {
  assertNotProduction,
  assertNotProductionUrl,
  emulatorWebConfig,
  checkStagingQuota,
  ciRunId,
  localRunId,
  cleanupTestRun,
  emulatorCustomToken,
  getTestDoc,
  mintCustomToken,
  quotaResetUtc,
  seedRequests,
  seedTestHousehold,
  signedInTestsAvailable,
  signJwtRequest,
  stagingCredentialsFromEnv,
  stagingWebConfig,
  sweepStaging,
  testHousehold,
  testRunId,
  testUserByEmail,
  StagingQuotaError,
} from '../src/staging';

const SA = 'github-deploy@huishouden-staging.iam.gserviceaccount.com';
const NOW = 1_790_000_000_000; // 2026-09-21, Pacific summer time
const RUN = { HH_STAGING_RUN: 'e2e-pet-18000000000-1', HH_STAGING_ACCESS_TOKEN: 'at' };
const DOCS = 'https://firestore.googleapis.com/v1/projects/huishouden-staging/databases/(default)/documents';
const AUTH = 'https://identitytoolkit.googleapis.com/v1/projects/huishouden-staging';

type Call = { url: string; method?: string; headers: Record<string, string>; body: unknown };
function recorder(reply: (url: string, body: unknown) => Response = () => Response.json({})) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body });
    return reply(url, body);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('each run its own household', () => {
  test('named for the run and the spec file, with four invented people', () => {
    const hh = testHousehold('/w/e2e/signed-in.spec.ts', RUN);
    expect(hh.id).toBe('e2e-pet-18000000000-1-signed-in');
    expect(hh.users.helper).toEqual({ uid: 'e2e-pet-18000000000-1-signed-in-helper', email: 'e2e-pet-18000000000-1-signed-in-helper@example.com', name: 'Test Helper', role: 'helper' });
    expect(Object.keys(hh.users)).toEqual(['admin', 'member', 'helper', 'kid']);
    expect(testHousehold('', RUN).id).toBe('e2e-pet-18000000000-1');
  });

  test('the same in every worker, and short enough for an email address', () => {
    const long = testHousehold('a-very-long-spec-file-name-about-many-things.spec.ts', { HH_STAGING_RUN: 'e2e-groceries-18000000000-12' });
    expect(long).toEqual(testHousehold('a-very-long-spec-file-name-about-many-things.spec.ts', { HH_STAGING_RUN: 'e2e-groceries-18000000000-12' }));
    expect(long.id.length).toBeLessThanOrEqual(50);
    expect(long.users.member.email.split('@')[0]!.length).toBeLessThanOrEqual(64);
    expect(long.id).not.toBe(testHousehold('a-very-long-spec-file-name-about-other-things.spec.ts', { HH_STAGING_RUN: 'e2e-groceries-18000000000-12' }).id);
  });

  test('the kit jobs name runs by repo, run and attempt; anything else is refused', () => {
    expect(ciRunId('huishouden/pet', 18000000000, 2)).toBe('e2e-pet-18000000000-2');
    expect(localRunId('Caleb.P', NOW)).toBe(`e2e-local-caleb-p-${NOW.toString(36)}`);
    expect(testRunId({ HH_STAGING_RUN: localRunId('', NOW) })).toMatch(/^e2e-local-dev-/);
    expect(testRunId({})).toBe('e2e-local');
    expect(testRunId({ HH_E2E_TARGET: 'emulator' })).toBe('e2e-emulator');
    expect(() => testRunId({ HH_STAGING_RUN: 'test-household' })).toThrow(/must start with e2e-/);
  });

  test('only its own people sign in', () => {
    const hh = testHousehold('', RUN);
    expect(testUserByEmail(hh, ' E2E-pet-18000000000-1-Kid@example.com ').role).toBe('kid');
    expect(() => testUserByEmail(hh, 'test-a@example.com')).toThrow(/not one of this run's test users/);
  });
});

describe('seed', () => {
  test('the people (emails verified) and the household with its data in one commit', () => {
    const hh = testHousehold('signed-in.spec.ts', RUN);
    const reqs = seedRequests(hh, { 'agenda/e1': { title: 'E2E bins', start: 5 } }, { env: RUN }, NOW);
    expect(JSON.parse(JSON.stringify(reqs))).toEqual(seedFixture);
  });

  test('two calls with the access token, billed to the staging project', async () => {
    const { calls, fetchImpl } = recorder();
    const hh = await seedTestHousehold({ env: RUN, fetchImpl });
    expect(hh.id).toBe('e2e-pet-18000000000-1');
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${AUTH}/accounts:batchCreate`],
      ['POST', `${DOCS}:commit`],
    ]);
    expect(calls[0]!.headers.authorization).toBe('Bearer at');
    expect(calls[0]!.headers['x-goog-user-project']).toBe('huishouden-staging');
  });

  test('fails when a test user could not be written', async () => {
    const { fetchImpl } = recorder((url) => Response.json(url.includes('batchCreate') ? partialError : {}));
    await expect(seedTestHousehold({ env: RUN, fetchImpl })).rejects.toThrow(/INVALID_EMAIL/);
  });

  test('says which call failed and how', async () => {
    const { fetchImpl } = recorder(() => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }));
    await expect(seedTestHousehold({ env: RUN, fetchImpl })).rejects.toThrow(/accounts:batchCreate: 403 .*PERMISSION_DENIED/);
  });

  test('on the emulators: their REST endpoints as the owner, and only a demo- project', async () => {
    const { calls, fetchImpl } = recorder();
    await seedTestHousehold({ env: { HH_E2E_TARGET: 'emulator' }, fetchImpl });
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-huishouden/accounts:batchCreate',
      'http://127.0.0.1:8080/v1/projects/demo-huishouden/databases/(default)/documents:commit',
    ]);
    expect(calls[0]!.headers.authorization).toBe('Bearer owner');
    await expect(seedTestHousehold({ env: { HH_E2E_TARGET: 'emulator', HH_EMULATOR_PROJECT: 'huishouden-piekstra' }, fetchImpl })).rejects.toThrow(/demo- project/);
  });
});

describe('the quota guard', () => {
  const exhausted = () => new Response('{"error":{"code":429,"message":"Quota exceeded.","status":"RESOURCE_EXHAUSTED"}}', { status: 429 });

  test('says when to rerun: midnight Pacific in UTC', () => {
    expect(quotaResetUtc(NOW)).toBe('07:00 UTC');
    expect(quotaResetUtc(Date.UTC(2026, 11, 1))).toBe('08:00 UTC');
  });

  test('a 429 from any call is the quota, not a test failure', async () => {
    const { fetchImpl } = recorder(exhausted);
    const e = await seedTestHousehold({ env: RUN, fetchImpl }).catch((x) => x);
    expect(e).toBeInstanceOf(StagingQuotaError);
    expect(e.message).toMatch(/^staging quota exceeded — rerun after \d\d:00 UTC/);
  });

  test('the probe: one read of a missing document is fine, a 429 is not', async () => {
    const missing = recorder(() => new Response('{"error":{"code":404}}', { status: 404 }));
    await checkStagingQuota({ env: RUN, fetchImpl: missing.fetchImpl });
    expect(missing.calls.map((c) => [c.method, c.url])).toEqual([['GET', `${DOCS}/households/e2e-quota-probe`]]);
    await expect(checkStagingQuota({ env: RUN, fetchImpl: recorder(exhausted).fetchImpl })).rejects.toBeInstanceOf(StagingQuotaError);
  });
});

describe('reading back', () => {
  test('one document, decoded, or null', async () => {
    const hh = testHousehold('', RUN);
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith('/bills/b1') ? Response.json({ fields: { amount: { integerValue: '8410' }, paid: { booleanValue: true } } }) : new Response('{}', { status: 404 }),
    );
    expect(await getTestDoc(hh, 'bills/b1', { env: RUN, fetchImpl })).toEqual({ amount: 8410, paid: true });
    expect(await getTestDoc(hh, 'bills/b2', { env: RUN, fetchImpl })).toBeNull();
    expect(calls[0]!.url).toBe(`${DOCS}/households/e2e-pet-18000000000-1/bills/b1`);
  });
});

/** A staging project with the users of auth-users.json and a few households, over REST. */
function fakeProject() {
  const households: Record<string, { members: string[]; seededAt?: number; docs: string[] }> = {
    'e2e-pet-18000000000-1-signed-in': { members: ['e2e-pet-18000000000-1-signed-in-admin@example.com'], seededAt: NOW, docs: ['petFeedings/f1', 'healthPeople/p1/meds/m1'] },
    'made-by-a-test': { members: ['e2e-pet-18000000000-1-signed-in-member@example.com'], docs: [] },
    'e2e-bills-17000000000-1': { members: ['e2e-bills-17000000000-1-admin@example.com'], seededAt: NOW - 3 * 86_400_000, docs: ['bills/b1'] },
    'e2e-tasks-18000000001-1': { members: ['e2e-tasks-18000000001-1-admin@example.com'], seededAt: NOW - 3_600_000, docs: [] },
    'test-household': { members: ['test-a@example.com'], docs: ['bills/old'] },
    'a-real-tester': { members: ['someone@example.org'], docs: ['bills/x'] },
  };
  const name = (p: string) => `projects/huishouden-staging/databases/(default)/documents/${p}`;
  const id = (n: string) => n.split('/documents/households/')[1]!;
  const deleted: string[] = [];
  const deletedUsers: string[] = [];
  const { calls, fetchImpl } = recorder((url, body: any) => {
    if (url.includes('accounts:batchGet')) return Response.json({ users: authUsers });
    if (url.endsWith('accounts:batchDelete')) return deletedUsers.push(...body.localIds), Response.json({});
    if (url.endsWith(':commit')) return deleted.push(...body.writes.map((w: { delete: string }) => w.delete.split('/documents/')[1])), Response.json({});
    if (url.endsWith(':runQuery')) {
      const q = body.structuredQuery;
      const parent = url.slice(DOCS.length + 1, -':runQuery'.length);
      if (q.from[0].allDescendants) return Response.json(households[parent.split('/')[1]!]!.docs.map((d) => ({ document: { name: name(`${parent}/${d}`) } })));
      const f = q.where.fieldFilter;
      if (f?.op === 'ARRAY_CONTAINS_ANY') {
        const emails = f.value.arrayValue.values.map((v: { stringValue: string }) => v.stringValue);
        return Response.json(Object.entries(households).filter(([, h]) => h.members.some((m) => emails.includes(m))).map(([k]) => ({ document: { name: name(`households/${k}`) } })));
      }
      const [lo, hi] = q.where.compositeFilter.filters.map((x: any) => id(x.fieldFilter.value.referenceValue));
      return Response.json(
        Object.entries(households)
          .filter(([k]) => k >= lo && k < hi)
          .map(([k, h]) => ({ document: { name: name(`households/${k}`), fields: h.seededAt ? { seededAt: { integerValue: String(h.seededAt) } } : {} } })),
      );
    }
    return new Response('unexpected', { status: 500 });
  });
  return { calls, fetchImpl, deleted, deletedUsers };
}

describe('cleaning up', () => {
  test("a run removes its people and every household they're in, and nothing else", async () => {
    const p = fakeProject();
    const report = await cleanupTestRun({ env: RUN, fetchImpl: p.fetchImpl });
    expect(report.households.sort()).toEqual(['e2e-pet-18000000000-1-signed-in', 'made-by-a-test']);
    expect(p.deleted.sort()).toEqual([
      'households/e2e-pet-18000000000-1-signed-in',
      'households/e2e-pet-18000000000-1-signed-in/healthPeople/p1/meds/m1',
      'households/e2e-pet-18000000000-1-signed-in/petFeedings/f1',
      'households/made-by-a-test',
    ]);
    expect(p.deletedUsers.sort()).toEqual(['e2e-pet-18000000000-1-signed-in-admin', 'e2e-pet-18000000000-1-signed-in-member']);
  });

  test("the nightly sweep removes runs over a day old and the old shared fixture, never a person's own household", async () => {
    const p = fakeProject();
    const report = await sweepStaging({ env: { HH_STAGING_ACCESS_TOKEN: 'at' }, fetchImpl: p.fetchImpl, now: NOW });
    expect(report.households.sort()).toEqual(['e2e-bills-17000000000-1', 'test-household']);
    expect(p.deleted.sort()).toEqual(['households/e2e-bills-17000000000-1', 'households/e2e-bills-17000000000-1/bills/b1', 'households/test-household', 'households/test-household/bills/old']);
    expect(p.deletedUsers.sort()).toEqual(['e2e-bills-17000000000-1-admin', 'test-a']);
  });

  test('the sweep is for staging only', async () => {
    await expect(sweepStaging({ env: { HH_E2E_TARGET: 'emulator' } })).rejects.toThrow(/staging project/);
  });
});

describe('custom tokens', () => {
  test('signs Firebase custom-token claims for the test user with the staging service account', () => {
    const req = signJwtRequest('test-a', SA, NOW);
    expect(req.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`);
    expect(JSON.parse((req.body as { payload: string }).payload)).toEqual(claimsFixture);
  });

  test('never signs with a service account outside the staging project', () => {
    expect(() => signJwtRequest('test-a', 'github-deploy@huishouden-piekstra.iam.gserviceaccount.com', NOW)).toThrow(/huishouden-staging service account/);
  });

  test('returns the signed JWT', async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ keyId: 'k', signedJwt: 'a.b.c' }));
    expect(await mintCustomToken({ uid: 'e2e-pet-1-1-admin', serviceAccount: SA, accessToken: 'at', env: RUN, fetchImpl, now: NOW })).toBe('a.b.c');
    expect(calls[0]!.headers.authorization).toBe('Bearer at');
  });

  test('on the emulators: unsigned, no call', async () => {
    const { calls, fetchImpl } = recorder();
    const token = await mintCustomToken({ uid: 'e2e-emulator-admin', env: { HH_E2E_TARGET: 'emulator' }, fetchImpl, now: NOW });
    expect(token).toBe(emulatorCustomToken('e2e-emulator-admin', NOW));
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(atob(header!))).toEqual({ alg: 'none', typ: 'JWT' });
    expect(JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))).uid).toBe('e2e-emulator-admin');
    expect(signature).toBe('');
    expect(calls).toEqual([]);
  });

  test('credentials come from the staging CI job only', () => {
    expect(() => stagingCredentialsFromEnv({})).toThrow(/staging CI job/);
    expect(stagingCredentialsFromEnv({ HH_STAGING_ACCESS_TOKEN: 'at', HH_STAGING_SA: SA })).toEqual({ accessToken: 'at', serviceAccount: SA });
    expect(signedInTestsAvailable({})).toBe(false);
    expect(signedInTestsAvailable({ HH_E2E_TARGET: 'emulator' })).toBe(true);
    expect(signedInTestsAvailable({ HH_STAGING_ACCESS_TOKEN: 'at', HH_STAGING_SA: SA })).toBe(true);
  });
});
describe('the web config a test signs in with', () => {
  const staging = { VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_PROJECT_ID: 'huishouden-staging' };
  const site = (projectId: string) => ({ apiKey: 'site-key', projectId, authDomain: `${projectId}.firebaseapp.com` });

  test("the build's config wins over the site's", () => {
    expect(stagingWebConfig(staging, site('huishouden-staging'))).toEqual({ apiKey: 'k', projectId: 'huishouden-staging', authDomain: 'huishouden-staging.firebaseapp.com' });
  });

  test("the site's init.json fills in when the test has no build config", () => {
    expect(stagingWebConfig({}, site('huishouden-staging')).apiKey).toBe('site-key');
  });

  test('a staging build without init.json (a local preview) is allowed', () => {
    expect(stagingWebConfig(staging, null).projectId).toBe('huishouden-staging');
  });

  test('refuses a production site even with a staging build config', () => {
    expect(() => stagingWebConfig(staging, site('huishouden-piekstra'))).toThrow(/Hosting project is "huishouden-piekstra"/);
  });

  test('refuses a production build', () => {
    expect(() => stagingWebConfig({ VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_PROJECT_ID: 'huishouden-piekstra' }, null)).toThrow(/Firebase project is "huishouden-piekstra"/);
  });

  test('refuses when nothing names the project', () => {
    expect(() => stagingWebConfig({ VITE_FIREBASE_API_KEY: 'k' }, null)).toThrow(/is unknown/);
  });

  test('needs an API key', () => {
    expect(() => stagingWebConfig({ VITE_FIREBASE_PROJECT_ID: 'huishouden-staging' }, null)).toThrow(/No Firebase API key/);
  });
});

describe('production is never a test target', () => {
  test('a production project id is refused with the cause named', () => {
    expect(() => assertNotProduction('huishouden-piekstra', "The app's Firebase project")).toThrow(/never run against production.*\.env\.local.*hh dev verify/s);
    expect(() => assertNotProduction('huishouden-staging')).not.toThrow();
    expect(() => assertNotProduction('demo-huishouden')).not.toThrow();
    expect(() => assertNotProduction(undefined)).not.toThrow();
  });

  test('the production site, either host, is refused as a BASE_URL', () => {
    expect(() => assertNotProductionUrl('https://huishouden-piekstra.web.app/baby/')).toThrow(/production site/);
    expect(() => assertNotProductionUrl('https://huishouden-piekstra.firebaseapp.com/')).toThrow(/production site/);
    expect(() => assertNotProductionUrl('https://huishouden-staging.web.app/baby/')).not.toThrow();
    expect(() => assertNotProductionUrl('http://localhost:4400/baby/')).not.toThrow();
    expect(() => assertNotProductionUrl(undefined)).not.toThrow();
    expect(() => assertNotProductionUrl('not a url')).toThrow(/not a URL/);
  });

  test('an emulator run whose build names production fails before any sign-in', () => {
    expect(() => emulatorWebConfig({ HH_E2E_TARGET: 'emulator', VITE_FIREBASE_PROJECT_ID: 'huishouden-piekstra' })).toThrow(/production/);
    expect(emulatorWebConfig({ HH_E2E_TARGET: 'emulator', VITE_FIREBASE_PROJECT_ID: 'demo-huishouden' }).projectId).toBe('demo-huishouden');
  });
});
