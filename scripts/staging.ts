#!/usr/bin/env bun
// pwa-staging <command>: the staging project's test data (src/staging.ts), for the kit's jobs and
// for people running the signed-in tests against staging from their own machine.
// Staging commands need the staging service account's access token in HH_STAGING_ACCESS_TOKEN and
// refuse any project but huishouden-staging; HH_E2E_TARGET=emulator points them at the emulators.
//
//   quota     one read; fails with "staging quota exceeded — rerun after HH:00 UTC" when it is used up
//   seed      the run's own household and people (HH_STAGING_RUN); specs seed theirs, so CI doesn't
//   cleanup   removes the run's households and people (HH_STAGING_RUN)
//   sweep     removes what runs left behind that is over a day old, and the old shared fixture
//   run -- <command...>
//             from a laptop: a run id of its own (e2e-local-<you>-<time>), the staging service
//             account's token through gcloud impersonation (your account needs Service Account Token
//             Creator on it), the quota check, the command (`bun run e2e:signed-in`), then cleanup
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { STAGING_PROJECT, StagingQuotaError, assertNotProduction, assertNotProductionUrl, checkStagingQuota, cleanupTestRun, localRunId, seedTestHousehold, sweepStaging, testRunId } from '../src/staging';

const argv = process.argv.slice(2);
const [command] = argv;
const commands = ['quota', 'seed', 'cleanup', 'sweep', 'run'];
if (!command || !commands.includes(command)) {
  console.error(`usage: pwa-staging ${commands.join('|')}   (run: pwa-staging run -- bun run e2e:signed-in)`);
  process.exit(2);
}

const annotate = process.env.GITHUB_ACTIONS === 'true';
const DEFAULT_SA = `github-deploy@${STAGING_PROJECT}.iam.gserviceaccount.com`;

async function run(cmd: string[]): Promise<number> {
  if (!cmd.length) {
    console.error('usage: pwa-staging run -- <command...>   (e.g. bun run e2e:signed-in)');
    return 2;
  }
  const env = process.env;
  // First, before a token is minted or anything runs. bun loads .env.local into this process, so a production value there stops the run rather than being kept by the `||=` below.
  try {
    assertNotProduction(env.VITE_FIREBASE_PROJECT_ID, 'VITE_FIREBASE_PROJECT_ID (an .env file or the environment)');
    assertNotProductionUrl(env.BASE_URL);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
  env.HH_STAGING_SA ||= DEFAULT_SA;
  env.HH_STAGING_RUN ||= localRunId(env.USER || userInfo().username);
  if (!env.HH_STAGING_ACCESS_TOKEN) {
    const token = spawnSync('gcloud', ['auth', 'print-access-token', `--impersonate-service-account=${env.HH_STAGING_SA}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (token.status !== 0 || !token.stdout.trim()) {
      console.error(`No staging token: gcloud could not impersonate ${env.HH_STAGING_SA} (needs Service Account Token Creator on it), and HH_STAGING_ACCESS_TOKEN is not set`);
      return 1;
    }
    env.HH_STAGING_ACCESS_TOKEN = token.stdout.trim();
  }
  // The build under test must be staging's: specs refuse any other project.
  env.VITE_FIREBASE_PROJECT_ID ||= STAGING_PROJECT;
  await checkStagingQuota();
  console.log(`run ${env.HH_STAGING_RUN} against ${env.BASE_URL ?? "the playwright config's BASE_URL"}`);
  const result = spawnSync(cmd[0]!, cmd.slice(1), { stdio: 'inherit', env });
  try {
    const report = await cleanupTestRun();
    console.log(`cleanup: ${report.households.length} households (${report.documents} documents), ${report.users} users removed`);
  } catch (e) {
    console.error(`cleanup failed (the nightly sweep removes it after a day): ${e instanceof Error ? e.message : e}`);
  }
  return result.status ?? 1;
}

try {
  if (command === 'quota') {
    await checkStagingQuota();
    console.log('staging Firestore quota: available');
  } else if (command === 'seed') {
    const household = await seedTestHousehold();
    console.log(`seeded households/${household.id} with ${Object.values(household.users).map((u) => u.email).join(', ')}`);
  } else if (command === 'run') {
    const rest = argv.slice(1);
    process.exit(await run(rest[0] === '--' ? rest.slice(1) : rest));
  } else {
    const report = command === 'cleanup' ? await cleanupTestRun() : await sweepStaging();
    const what = command === 'cleanup' ? `run ${testRunId()}` : 'leftovers over a day old';
    console.log(`${command} (${what}): ${report.households.length} households (${report.documents} documents), ${report.users} users removed`);
    for (const id of report.households) console.log(`  households/${id}`);
  }
} catch (e) {
  if (e instanceof StagingQuotaError) {
    console.error(annotate ? `::error title=Staging quota exceeded::${e.message}` : e.message);
    process.exit(3);
  }
  throw e;
}
