#!/usr/bin/env bun
/**
 * Sets up New Relic (free tier) for a family of apps: one Browser application per app, an uptime
 * check per app, alert conditions with an email destination, and one dashboard. Safe to re-run:
 * everything is found by name and updated rather than duplicated, and uptime checks for addresses no
 * longer in the list are deleted. Ends with what New Relic keeps of the apps' geography (city, how
 * long), and the pipeline cloud rules that would drop the city where the account's plan allows them.
 * docs/observability.md; STANDARD.md "Observability".
 *
 *   NEW_RELIC_API_KEY=… NEW_RELIC_ACCOUNT_ID=… ALERT_EMAIL=… bun infra/newrelic.ts apps.json [--out observability.json] [--repo-variables]
 *
 * apps.json is the portal's list: [{ "repo": "baby", "site": "huishouden-baby", "path": "/baby/" }, …]. An app
 * with a `path` is checked at that path on the shared site (the portal's, path `/`; docs/one-site.md).
 *
 * `--out` writes the browser-agent settings of every app with a path (account id, app id, browser
 * key: public by design) for the site's `/hh-observability.json`; the portal's monitoring workflow
 * publishes it and every deploy serves it, so apps need no repo variables. `--repo-variables` sets
 * the `VITE_NEWRELIC_*` variables on each app's repo instead (apps on sites of their own; needs `gh`
 * signed in with admin on the repos).
 *
 * Reports each app's page views (REPORTING_SINCE, default `1 day ago`).
 * Optional: GITHUB_OWNER (default huishouden), FAMILY (default Huishouden), DRY_RUN=1.
 * The user key (NRAK-…) is read from the environment only and never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const KEY = process.env.NEW_RELIC_API_KEY?.trim();
const ACCOUNT = Number(process.env.NEW_RELIC_ACCOUNT_ID);
const EMAIL = process.env.ALERT_EMAIL?.trim();
const OWNER = process.env.GITHUB_OWNER ?? 'huishouden';
const FAMILY = process.env.FAMILY ?? 'Huishouden';
const DRY = process.env.DRY_RUN === '1';
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const OUT = outIndex >= 0 ? argv[outIndex + 1] : undefined;
const REPO_VARIABLES = argv.includes('--repo-variables');
const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!KEY || !ACCOUNT || !EMAIL || !file || (outIndex >= 0 && !OUT)) {
  console.error('Usage: NEW_RELIC_API_KEY=… NEW_RELIC_ACCOUNT_ID=… ALERT_EMAIL=… bun infra/newrelic.ts apps.json [--out observability.json] [--repo-variables]');
  process.exit(2);
}

/** Text with anything that looks like a New Relic key, or the alert address, taken out. */
const scrub = (text: string) =>
  [KEY!, EMAIL!].reduce((t, secret) => (secret ? t.split(secret).join('[redacted]') : t), text).replace(/\b(NRAK|NRAA|NRII|NRJS|NRIQ)-[A-Za-z0-9]+/g, '$1-[redacted]');
const log = (text: string) => console.log(scrub(text));

interface AppEntry {
  repo: string;
  site: string;
  path?: string;
}
const apps = (JSON.parse(readFileSync(file, 'utf8')) as AppEntry[]).filter((a) => a.repo && a.site);
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const browserName = (a: AppEntry) => `${FAMILY} ${title(a.repo)}`;
const shared = apps.find((a) => a.path === '/')?.site;
const siteUrl = (a: AppEntry) => (a.path && shared ? `https://${shared}.web.app${a.path}` : `https://${a.site}.web.app/`);

async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('https://api.newrelic.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': KEY! },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`New Relic refused the key (HTTP ${res.status}): is NEW_RELIC_API_KEY a current User key for account ${ACCOUNT}?`);
  const body = (await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}` }] }))) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

const mutate = async <T = any>(what: string, query: string, variables: Record<string, unknown>): Promise<T | null> => {
  log(`${DRY ? '[dry run] ' : ''}${what}`);
  if (DRY) return null;
  const result = await gql<T>(query, variables);
  // Mutations answer problems in an `errors` field rather than failing.
  const problems = Object.values((result ?? {}) as Record<string, { errors?: { description: string }[] } | null>)
    .flatMap((r) => (Array.isArray(r?.errors) ? r.errors : []))
    .map((e) => e.description);
  if (problems.length) throw new Error(`${what}: ${problems.join('; ')}`);
  return result;
};

interface Entity {
  guid: string;
  name: string;
  applicationId?: number;
  monitorId?: string;
  monitorType?: string;
  monitoredUrl?: string;
}

async function entities(query: string): Promise<Entity[]> {
  const found: Entity[] = [];
  let cursor: string | null = null;
  do {
    const d: any = await gql(
      `query($q: String!, $c: String) { actor { entitySearch(query: $q) { results(cursor: $c) { nextCursor entities { guid name
        ... on BrowserApplicationEntityOutline { applicationId }
        ... on SyntheticMonitorEntityOutline { monitorId monitorType monitoredUrl } } } } } }`,
      { q: query, c: cursor },
    );
    found.push(...d.actor.entitySearch.results.entities);
    cursor = d.actor.entitySearch.results.nextCursor;
  } while (cursor);
  return found;
}

// 1. Browser applications, and the settings each app's browser agent needs.
interface AgentSettings {
  accountId: string;
  appId: string;
  browserKey: string;
}

async function browserApps(): Promise<Map<AppEntry, AgentSettings>> {
  const settings = new Map<AppEntry, AgentSettings>();
  const existing = await entities(`domain = 'BROWSER' AND type = 'APPLICATION' AND name LIKE '${FAMILY} %' AND accountId = ${ACCOUNT}`);
  for (const app of apps) {
    let guid = existing.find((e) => e.name === browserName(app))?.guid;
    if (!guid) {
      const made = await mutate(`create Browser app ${browserName(app)}`,
        `mutation($a: Int!, $n: String!) { agentApplicationCreateBrowser(accountId: $a, name: $n, settings: { cookiesEnabled: true, distributedTracingEnabled: false, loaderType: SPA }) { guid } }`,
        { a: ACCOUNT, n: browserName(app) });
      guid = made?.agentApplicationCreateBrowser.guid;
    } else log(`Browser app ${browserName(app)}: exists`);
    if (!guid) continue;
    // A just-created app takes a little while to appear in entity queries; wait for it (up to ~2 minutes).
    let js: { loader_config: { accountID: string; applicationID: string; licenseKey: string } } | undefined;
    for (let i = 0; i < 24 && !js; i++) {
      const d = await gql(`query($g: EntityGuid!) { actor { entity(guid: $g) { ... on BrowserApplicationEntity { browserProperties { jsConfig } } } } }`, { g: guid });
      js = d?.actor?.entity?.browserProperties?.jsConfig;
      if (!js) await new Promise((r) => setTimeout(r, 5000));
    }
    if (!js) throw new Error(`New Relic hasn't indexed ${browserName(app)} yet; re-run in a minute (safe to repeat)`);
    const cfg = js.loader_config;
    settings.set(app, { accountId: String(cfg.accountID), appId: String(cfg.applicationID), browserKey: cfg.licenseKey });
  }
  return settings;
}

/** The site's `hh-observability.json` source: every app with a path, by path. Values only, never logged. */
function writeSiteSettings(settings: Map<AppEntry, AgentSettings>, out: string) {
  const byPath: Record<string, { appId: string; browserKey: string }> = {};
  let accountId = '';
  for (const [app, s] of settings) {
    if (!app.path) continue;
    accountId ||= s.accountId;
    if (s.accountId !== accountId) throw new Error(`${browserName(app)} is in another account (${s.accountId})`);
    byPath[app.path] = { appId: s.appId, browserKey: s.browserKey };
  }
  if (!accountId) throw new Error('no app with a path to write settings for');
  writeFileSync(out, `${JSON.stringify({ accountId, apps: byPath }, null, 2)}\n`);
  log(`wrote ${out}: ${Object.keys(byPath).sort().join(' ')}`);
}

function setRepoVariables(settings: Map<AppEntry, AgentSettings>) {
  for (const [app, s] of settings) {
    const vars = { VITE_NEWRELIC_ACCOUNT_ID: s.accountId, VITE_NEWRELIC_APP_ID: s.appId, VITE_NEWRELIC_BROWSER_KEY: s.browserKey };
    for (const [name, value] of Object.entries(vars)) {
      log(`${DRY ? '[dry run] ' : ''}gh variable set ${name} --repo ${OWNER}/${app.repo}`);
      if (DRY) continue;
      // The value goes in on stdin, so it never appears in a process list or a log.
      const r = spawnSync('gh', ['variable', 'set', name, '--repo', `${OWNER}/${app.repo}`], { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
      if (r.status !== 0) throw new Error(`gh variable set ${name} failed for ${app.repo}`);
    }
  }
}

// 2. Uptime: ping monitors are free and unlimited on every plan (other monitor types count against
// 500 checks a month). One per app at its address; a family ping monitor that isn't one of these
// (an app removed from the list, a duplicate) is deleted. An app with a path is checked there, not at
// its old per-app address, which only redirects.
const monitorName = (a: AppEntry) => `${browserName(a)} up`;

async function uptime() {
  const existing = (await entities(`domain = 'SYNTH' AND type = 'MONITOR' AND name LIKE '${FAMILY} %' AND accountId = ${ACCOUNT}`))
    .filter((e) => e.monitorType === undefined || e.monitorType === 'SIMPLE');
  const kept = new Set<string>();
  for (const app of apps) {
    const name = monitorName(app);
    const uri = siteUrl(app);
    const monitor = {
      name,
      uri,
      period: 'EVERY_30_MINUTES',
      status: 'ENABLED',
      locations: { public: ['AWS_US_EAST_1', 'AWS_US_WEST_1'] },
      advancedOptions: { responseValidationText: FAMILY, useTlsValidation: true, redirectIsFailure: false, shouldBypassHeadRequest: true },
    };
    const found = existing.find((e) => e.name === name && !kept.has(e.guid));
    if (found) {
      kept.add(found.guid);
      const was = found.monitoredUrl && found.monitoredUrl !== uri ? ` (was ${found.monitoredUrl})` : '';
      await mutate(`update monitor ${name}: ${uri}${was}`, `mutation($g: EntityGuid!, $m: SyntheticsUpdateSimpleMonitorInput!) { syntheticsUpdateSimpleMonitor(guid: $g, monitor: $m) { errors { description } } }`, { g: found.guid, m: monitor });
    } else
      await mutate(`create monitor ${name}: ${uri}`, `mutation($a: Int!, $m: SyntheticsCreateSimpleMonitorInput!) { syntheticsCreateSimpleMonitor(accountId: $a, monitor: $m) { errors { description } } }`, { a: ACCOUNT, m: monitor });
  }
  for (const e of existing.filter((x) => !kept.has(x.guid) && x.name.endsWith(' up')))
    await mutate(`delete monitor ${e.name}${e.monitoredUrl ? ` (${e.monitoredUrl})` : ''}: not an app in the list`, `mutation($g: EntityGuid!) { syntheticsDeleteMonitor(guid: $g) { deletedGuid } }`, { g: e.guid });
}

// 3. Geography. New Relic Browser works out country, region, city and the network's coordinates
// (`asnLatitude`, `asnLongitude`) from the address a report comes from. Pipeline cloud rules can delete
// city and coordinates at ingest (NRQL drop rules, their predecessor, were discontinued on 2026-08-31), but Pipeline
// Control is part of New Relic's Advanced Compute, which the free plan doesn't include: New Relic
// answers "Access denied ... can_create PIPELINE_CLOUD_RULE" even to an All Product Admin, whose role
// does carry "Pipeline control cloud rules: modify". That refusal is a known limitation, reported
// with what is kept and for how long; the rules are made by the first run on a plan that has them.
// docs/observability.md "Geography".
const GEO_EVENTS = ['PageView', 'PageViewTiming', 'PageAction', 'JavaScriptError', 'BrowserPerformance'];
const GEO_DESCRIPTION = `${FAMILY}: coarse geography only (STANDARD.md Observability)`;
const geoRuleName = (event: string) => `${FAMILY} coarse geography: ${event}`;
const geoRuleNrql = (event: string) => `DELETE city, asnLatitude, asnLongitude FROM ${event} WHERE appName LIKE '${FAMILY} %'`;
const sameNrql = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
const BROWSER_RETENTION = ['Browser', 'Browser:EventLog', 'Browser:JSErrors', 'PcvPerf'];

/** A GitHub Actions notice when running there, a plain line otherwise. */
const notice = (title: string, text: string) => log(process.env.GITHUB_ACTIONS === 'true' ? `::notice title=${title}::${text}` : `${title}: ${text}`);

async function geography() {
  const r: any = await gql(`query($a: Int!) { actor { account(id: $a) { dataManagement { eventRetentionPolicies { namespace namespaceLevelRetention { retentionInDays } } } } } }`, { a: ACCOUNT });
  const days = (r.actor.account.dataManagement.eventRetentionPolicies ?? [])
    .filter((p: { namespace: string }) => BROWSER_RETENTION.includes(p.namespace))
    .map((p: { namespaceLevelRetention?: { retentionInDays?: number } }) => p.namespaceLevelRetention?.retentionInDays ?? 0);
  const kept = days.length ? `${Math.max(...days)} days` : 'an unknown time';
  const q = `SELECT count(*) AS total, filter(count(*), WHERE city IS NOT NULL) AS city FROM PageView WHERE appName LIKE '${FAMILY} %' SINCE ${process.env.REPORTING_SINCE ?? '1 day ago'}`;
  const n: any = await gql(`query($a: Int!, $q: Nrql!) { actor { account(id: $a) { nrql(query: $q) { results } } } }`, { a: ACCOUNT, q });
  const row = n.actor.account.nrql.results?.[0] ?? {};
  log(`\nGeography: ${row.city ?? 0} of ${row.total ?? 0} page views since ${process.env.REPORTING_SINCE ?? '1 day ago'} carry a city; Browser data is kept ${kept}.`);

  try {
    await geoRules();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/access denied/i.test(message)) throw e;
    notice('City kept (known limitation)',
      `New Relic refused the pipeline cloud rules (${message.replace(/, invocation=.*$/, '').slice(0, 140)}). Pipeline Control needs Advanced Compute, which the free plan doesn't include, so city and network coordinates are kept ${kept} with the rest of the Browser data, as the portal's /privacy page says (docs/observability.md, Geography).`);
  }
}

async function geoRules() {
  const rules: { id: string; name: string; nrql: string; scope?: { id: string } }[] = [];
  let cursor: string | null = null;
  do {
    const d: any = await gql(
      `query($c: String) { actor { entityManagement { entitySearch(query: "type = 'PIPELINE_CLOUD_RULE'", cursor: $c) { nextCursor entities { id name
        ... on EntityManagementPipelineCloudRuleEntity { nrql scope { id } } } } } } }`,
      { c: cursor },
    );
    const page = d.actor.entityManagement.entitySearch;
    rules.push(...page.entities.filter((e: { name?: string; scope?: { id: string } }) => e.name?.startsWith(`${FAMILY} coarse geography: `) && (!e.scope || e.scope.id === String(ACCOUNT))));
    cursor = page.nextCursor ?? null;
  } while (cursor);

  for (const event of GEO_EVENTS) {
    const name = geoRuleName(event);
    const nrql = geoRuleNrql(event);
    const [rule, ...duplicates] = rules.filter((r) => r.name === name);
    if (!rule)
      await mutate(`create pipeline cloud rule ${name}`,
        `mutation($r: EntityManagementPipelineCloudRuleEntityCreateInput!) { entityManagementCreatePipelineCloudRule(pipelineCloudRuleEntity: $r) { entity { id } } }`,
        { r: { name, description: GEO_DESCRIPTION, nrql, scope: { id: String(ACCOUNT), type: 'ACCOUNT' } } });
    else if (!sameNrql(rule.nrql, nrql))
      await mutate(`update pipeline cloud rule ${name}`,
        `mutation($id: ID!, $r: EntityManagementPipelineCloudRuleEntityUpdateInput!) { entityManagementUpdatePipelineCloudRule(id: $id, pipelineCloudRuleEntity: $r) { entity { id } } }`,
        { id: rule.id, r: { name, description: GEO_DESCRIPTION, nrql } });
    else log(`pipeline cloud rule ${name}: in place`);
    for (const extra of duplicates)
      await mutate(`delete duplicate pipeline cloud rule ${name}`, `mutation($id: ID!) { entityManagementDelete(id: $id) { id } }`, { id: extra.id });
  }
}

// 4. Alerts, emailed.
interface Condition {
  name: string;
  description: string;
  query: string;
  operator: 'ABOVE' | 'BELOW' | 'ABOVE_OR_EQUALS';
  threshold: number;
  window: number;
  duration: number;
  expiration?: { expirationDuration: number; openViolationOnExpiration: boolean; closeViolationsOnExpiration: boolean };
  /** A steady signal (a heartbeat) is aggregated as it streams; sparse ones (errors) on a timer. */
  steady?: boolean;
}

/** A notify run that threw, other than one stopped by a read limit (`QuotaExhausted`); the alert and the dashboard share it. */
const NOTIFY_CRASHED = `error IS NOT NULL AND error NOT LIKE 'QuotaExhausted:%'`;
/** A notify run Firestore stopped for the project's quota (`NotifyRun.quota`). */
const NOTIFY_QUOTA = `quota IS TRUE`;

const CONDITIONS: Condition[] = [
  {
    name: 'App errors spike',
    description: 'More than 10 JavaScript or handled errors in an app within 30 minutes (one incident per app). Open the dashboard Errors page and filter by app.',
    query: `SELECT count(*) FROM JavaScriptError WHERE appName LIKE '${FAMILY} %' FACET appName`,
    operator: 'ABOVE', threshold: 10, window: 1800, duration: 1800,
  },
  {
    name: 'Site down',
    description: 'A site failed its uptime check twice in a row (checked every 30 minutes from two locations).',
    query: `SELECT filter(count(*), WHERE result = 'FAILED') FROM SyntheticCheck WHERE monitorName LIKE '${FAMILY} %' FACET monitorName`,
    operator: 'ABOVE_OR_EQUALS', threshold: 2, window: 1800, duration: 1800,
  },
  {
    name: 'Notify sender silent',
    description: 'The notify Worker reported no run for 20 minutes (it runs every 5): reminders are not being sent. Check `bunx wrangler tail` in huishouden/notify.',
    query: `SELECT count(*) FROM NotifyRun`,
    operator: 'BELOW', threshold: 1, window: 600, duration: 1200,
    expiration: { expirationDuration: 1200, openViolationOnExpiration: true, closeViolationsOnExpiration: false },
    steady: true,
  },
  {
    name: 'Notify run crashed',
    description: 'A notify Worker run threw before finishing (the error is on the NotifyRun event). Check `bunx wrangler tail` in huishouden/notify. A run stopped by a read limit (`QuotaExhausted`) is not a crash: see "Notify stopped by Firestore\'s quota".',
    query: `SELECT filter(count(*), WHERE ${NOTIFY_CRASHED}) FROM NotifyRun`,
    operator: 'ABOVE_OR_EQUALS', threshold: 1, window: 1800, duration: 1800,
  },
  {
    name: "Notify stopped by Firestore's quota",
    description: "A notify Worker run stopped because Firestore refused for the project's daily quota (`NotifyRun.quota`): on the free plan every app and Worker is refused reads until midnight Pacific, and due reminders go out late. Nothing in notify fixes it: find what read so much (the \"Firestore reads\" alerts, pwa-kit STANDARD.md \"Read budgets\").",
    query: `SELECT filter(count(*), WHERE ${NOTIFY_QUOTA}) FROM NotifyRun`,
    operator: 'ABOVE_OR_EQUALS', threshold: 1, window: 1800, duration: 1800,
  },
  {
    name: 'Push deliveries failing',
    description: 'More than 5 Web Push deliveries failed in an hour (push service errors other than gone subscriptions).',
    query: `SELECT sum(failed) FROM NotifyRun`,
    operator: 'ABOVE', threshold: 5, window: 3600, duration: 3600,
  },
];

async function alerts(): Promise<string | null> {
  const policyName = FAMILY;
  const p = await gql(`query($a: Int!, $n: String!) { actor { account(id: $a) { alerts { policiesSearch(searchCriteria: { name: $n }) { policies { id name } } } } } }`, { a: ACCOUNT, n: policyName });
  let policyId: string | undefined = p.actor.account.alerts.policiesSearch.policies.find((x: { name: string }) => x.name === policyName)?.id;
  if (!policyId) {
    const made = await mutate(`create alert policy ${policyName}`, `mutation($a: Int!, $p: AlertsPolicyInput!) { alertsPolicyCreate(accountId: $a, policy: $p) { id } }`,
      { a: ACCOUNT, p: { name: policyName, incidentPreference: 'PER_CONDITION_AND_TARGET' } });
    policyId = made?.alertsPolicyCreate.id;
  }
  if (!policyId) return null;

  const c = await gql(`query($a: Int!, $p: ID!) { actor { account(id: $a) { alerts { nrqlConditionsSearch(searchCriteria: { policyId: $p }) { nrqlConditions { id name } } } } } }`, { a: ACCOUNT, p: policyId });
  const have: { id: string; name: string }[] = c.actor.account.alerts.nrqlConditionsSearch.nrqlConditions;
  for (const cond of CONDITIONS) {
    const input = {
      name: cond.name,
      description: cond.description,
      enabled: true,
      nrql: { query: cond.query },
      signal: cond.steady
        ? { aggregationWindow: cond.window, aggregationMethod: 'EVENT_FLOW', aggregationDelay: 120, fillOption: 'STATIC', fillValue: 0 }
        : { aggregationWindow: cond.window, aggregationMethod: 'EVENT_TIMER', aggregationTimer: 120, fillOption: 'NONE' },
      terms: [{ operator: cond.operator, threshold: cond.threshold, thresholdDuration: cond.duration, thresholdOccurrences: 'ALL', priority: 'CRITICAL' }],
      valueFunction: 'SINGLE_VALUE',
      violationTimeLimitSeconds: 86400,
      ...(cond.expiration ? { expiration: cond.expiration } : {}),
    };
    const found = have.find((x) => x.name === cond.name);
    if (found)
      await mutate(`update condition ${cond.name}`, `mutation($a: Int!, $id: ID!, $c: AlertsNrqlConditionUpdateStaticInput!) { alertsNrqlConditionStaticUpdate(accountId: $a, id: $id, condition: $c) { id } }`, { a: ACCOUNT, id: found.id, c: input });
    else
      await mutate(`create condition ${cond.name}`, `mutation($a: Int!, $p: ID!, $c: AlertsNrqlConditionStaticInput!) { alertsNrqlConditionStaticCreate(accountId: $a, policyId: $p, condition: $c) { id } }`, { a: ACCOUNT, p: policyId, c: input });
  }

  // Email destination, channel and workflow.
  const destName = `${FAMILY} alerts email`;
  const ds = await gql(`query($a: Int!, $n: String!) { actor { account(id: $a) { aiNotifications { destinations(filters: { name: $n }) { entities { id name active status } } } } } }`, { a: ACCOUNT, n: destName });
  let dest = ds.actor.account.aiNotifications.destinations.entities.find((x: { name: string }) => x.name === destName);
  if (!dest) {
    const made = await mutate(`create email destination ${destName}`,
      `mutation($a: Int!, $d: AiNotificationsDestinationInput!) { aiNotificationsCreateDestination(accountId: $a, destination: $d) { destination { id active status } error { ... on AiNotificationsResponseError { description } } } }`,
      { a: ACCOUNT, d: { type: 'EMAIL', name: destName, properties: [{ key: 'email', value: EMAIL }] } });
    dest = made?.aiNotificationsCreateDestination.destination;
  }
  if (!dest) return policyId;
  if (dest.status && dest.status !== 'DEFAULT') log(`  destination status: ${dest.status} (an address outside the account may need to confirm a verification email)`);

  const chName = `${FAMILY} alerts email`;
  const cs = await gql(`query($a: Int!, $n: String!) { actor { account(id: $a) { aiNotifications { channels(filters: { name: $n }) { entities { id name } } } } } }`, { a: ACCOUNT, n: chName });
  let channelId: string | undefined = cs.actor.account.aiNotifications.channels.entities.find((x: { name: string }) => x.name === chName)?.id;
  if (!channelId) {
    const made = await mutate(`create email channel ${chName}`,
      `mutation($a: Int!, $c: AiNotificationsChannelInput!) { aiNotificationsCreateChannel(accountId: $a, channel: $c) { channel { id } error { ... on AiNotificationsResponseError { description } } } }`,
      { a: ACCOUNT, c: { type: 'EMAIL', name: chName, destinationId: dest.id, product: 'IINT', properties: [{ key: 'subject', value: `[${FAMILY}] {{ issueTitle }}` }] } });
    channelId = made?.aiNotificationsCreateChannel.channel?.id;
  }
  if (!channelId) return policyId;

  const wfName = `${FAMILY} alerts`;
  const ws = await gql(`query($a: Int!, $n: String!) { actor { account(id: $a) { aiWorkflows { workflows(filters: { name: $n }) { entities { id name } } } } } }`, { a: ACCOUNT, n: wfName });
  if (!ws.actor.account.aiWorkflows.workflows.entities.some((x: { name: string }) => x.name === wfName))
    await mutate(`create workflow ${wfName}`,
      `mutation($a: Int!, $w: AiWorkflowsCreateWorkflowInput!) { aiWorkflowsCreateWorkflow(accountId: $a, createWorkflowData: $w) { workflow { id } errors { description } } }`,
      {
        a: ACCOUNT,
        w: {
          name: wfName,
          workflowEnabled: true,
          destinationsEnabled: true,
          mutingRulesHandling: 'NOTIFY_ALL_ISSUES',
          issuesFilter: { name: wfName, type: 'FILTER', predicates: [{ attribute: 'labels.policyIds', operator: 'EXACTLY_MATCHES', values: [policyId] }] },
          destinationConfigurations: [{ channelId, notificationTriggers: ['ACTIVATED', 'CLOSED'] }],
        },
      });
  return policyId;
}

// 5. One dashboard for the family.
const W = (title: string, viz: string, query: string, column: number, row: number, width = 4, height = 3) => ({
  title,
  visualization: { id: viz },
  layout: { column, row, width, height },
  rawConfiguration: { nrqlQueries: [{ accountIds: [ACCOUNT], query }], ...(viz === 'viz.line' ? { legend: { enabled: true } } : {}) },
});
const APPS_WHERE = `appName LIKE '${FAMILY} %'`;
const SHORT = `capture(appName, r'${FAMILY} (?P<app>.*)')`;

function dashboard() {
  return {
    name: FAMILY,
    description: `Errors, Core Web Vitals, usage and uptime for every ${FAMILY} app (pwa-kit infra/newrelic.ts).`,
    permissions: 'PUBLIC_READ_ONLY',
    pages: [
      {
        name: 'Overview',
        widgets: [
          W('Page views by app', 'viz.line', `SELECT count(*) FROM PageView WHERE ${APPS_WHERE} FACET ${SHORT} TIMESERIES AUTO SINCE 1 week ago`, 1, 1, 8),
          W('Errors by app', 'viz.bar', `SELECT count(*) FROM JavaScriptError WHERE ${APPS_WHERE} FACET ${SHORT} SINCE 1 week ago`, 9, 1),
          W('Page views', 'viz.billboard', `SELECT count(*) AS 'Page views' FROM PageView WHERE ${APPS_WHERE} SINCE 1 week ago COMPARE WITH 1 week ago`, 1, 4),
          W('Active households (hashed)', 'viz.billboard', `SELECT uniqueCount(household) AS 'Households' FROM PageView, PageAction WHERE ${APPS_WHERE} SINCE 1 week ago COMPARE WITH 1 week ago`, 5, 4),
          W('Error rate (errors per 100 page views)', 'viz.billboard', `SELECT 100 * filter(count(*), WHERE eventType() = 'JavaScriptError') / filter(count(*), WHERE eventType() = 'PageView') AS 'Errors per 100 views' FROM JavaScriptError, PageView WHERE ${APPS_WHERE} SINCE 1 day ago`, 9, 4),
          W('Countries', 'viz.bar', `SELECT count(*) FROM PageView WHERE ${APPS_WHERE} FACET countryCode SINCE 1 month ago`, 1, 7),
          W('Regions', 'viz.table', `SELECT count(*) AS 'Page views' FROM PageView WHERE ${APPS_WHERE} FACET countryCode, regionCode SINCE 1 month ago LIMIT 50`, 5, 7),
          W('Devices', 'viz.pie', `SELECT count(*) FROM PageView WHERE ${APPS_WHERE} FACET deviceType SINCE 1 month ago`, 9, 7),
          W('Uptime checks', 'viz.table', `SELECT percentage(count(*), WHERE result = 'SUCCESS') AS 'Up %', average(duration) AS 'ms', latest(result) AS 'Last' FROM SyntheticCheck WHERE monitorName LIKE '${FAMILY} %' FACET monitorName SINCE 1 day ago`, 1, 10, 6),
          W('Notify sender runs', 'viz.line', `SELECT count(*) AS 'Runs', sum(pushed) AS 'Pushed', sum(failed) AS 'Failed', filter(count(*), WHERE ${NOTIFY_CRASHED}) AS 'Crashed', filter(count(*), WHERE ${NOTIFY_QUOTA}) AS 'Quota stops' FROM NotifyRun TIMESERIES 1 hour SINCE 1 day ago`, 7, 10, 6),
        ],
      },
      {
        name: 'Errors',
        widgets: [
          W('Errors over time', 'viz.line', `SELECT count(*) FROM JavaScriptError WHERE ${APPS_WHERE} FACET ${SHORT} TIMESERIES AUTO SINCE 1 week ago`, 1, 1, 12),
          W('Top errors', 'viz.table', `SELECT count(*) AS 'Count', latest(\`application.version\`) AS 'Version', latest(timestamp) AS 'Last seen' FROM JavaScriptError WHERE ${APPS_WHERE} FACET ${SHORT}, errorMessage, \`where\` SINCE 1 week ago LIMIT 50`, 1, 4, 12, 4),
          W('Errors by version', 'viz.bar', `SELECT count(*) FROM JavaScriptError WHERE ${APPS_WHERE} FACET ${SHORT}, \`application.version\` SINCE 1 week ago`, 1, 8, 6),
          W('Handled failures by code', 'viz.bar', `SELECT count(*) FROM JavaScriptError WHERE ${APPS_WHERE} AND handled IS TRUE FACET code, status SINCE 1 week ago`, 7, 8, 6),
        ],
      },
      {
        name: 'Core Web Vitals',
        widgets: [
          W('LCP p75 (ms, good < 2500)', 'viz.bar', `SELECT percentile(largestContentfulPaint, 75) * 1000 FROM PageViewTiming WHERE ${APPS_WHERE} AND timingName = 'largestContentfulPaint' FACET ${SHORT} SINCE 1 week ago`, 1, 1),
          W('INP p75 (ms, good < 200)', 'viz.bar', `SELECT percentile(interactionToNextPaint, 75) FROM PageViewTiming WHERE ${APPS_WHERE} AND timingName = 'interactionToNextPaint' FACET ${SHORT} SINCE 1 week ago`, 5, 1),
          W('CLS p75 (good < 0.1)', 'viz.bar', `SELECT percentile(cumulativeLayoutShift, 75) FROM PageViewTiming WHERE ${APPS_WHERE} AND timingName IN ('pageHide', 'windowUnload') FACET ${SHORT} SINCE 1 week ago`, 9, 1),
          W('LCP p75 over time', 'viz.line', `SELECT percentile(largestContentfulPaint, 75) * 1000 FROM PageViewTiming WHERE ${APPS_WHERE} AND timingName = 'largestContentfulPaint' FACET ${SHORT} TIMESERIES 1 day SINCE 1 month ago`, 1, 4, 12),
          W('Load time by device (s)', 'viz.table', `SELECT percentile(duration, 50, 75) FROM PageView WHERE ${APPS_WHERE} FACET ${SHORT}, deviceType SINCE 1 week ago`, 1, 7, 12),
        ],
      },
      {
        name: 'Usage',
        widgets: [
          W('Feature use', 'viz.bar', `SELECT count(*) FROM PageAction WHERE ${APPS_WHERE} AND actionName != 'view' FACET ${SHORT}, actionName SINCE 1 week ago LIMIT 50`, 1, 1, 6, 4),
          W('Screens and tabs', 'viz.bar', `SELECT count(*) FROM PageAction WHERE ${APPS_WHERE} AND actionName = 'view' FACET ${SHORT}, view SINCE 1 week ago LIMIT 50`, 7, 1, 6, 4),
          W('Households per app (hashed)', 'viz.bar', `SELECT uniqueCount(household) FROM PageView WHERE ${APPS_WHERE} FACET ${SHORT} SINCE 1 week ago`, 1, 5, 6),
          W('Page views per day', 'viz.line', `SELECT count(*) FROM PageView WHERE ${APPS_WHERE} FACET ${SHORT} TIMESERIES 1 day SINCE 1 month ago`, 7, 5, 6),
          W('Versions in use', 'viz.table', `SELECT count(*) AS 'Page views' FROM PageView WHERE ${APPS_WHERE} FACET ${SHORT}, \`application.version\` SINCE 1 day ago`, 1, 8, 12),
        ],
      },
    ],
  };
}

async function upsertDashboard() {
  const found = await entities(`type = 'DASHBOARD' AND name = '${FAMILY}' AND accountId = ${ACCOUNT}`);
  const guid = found.find((e) => e.name === FAMILY)?.guid;
  const d = dashboard();
  if (guid) {
    await mutate(`update dashboard ${FAMILY}`, `mutation($g: EntityGuid!, $d: DashboardInput!) { dashboardUpdate(guid: $g, dashboard: $d) { errors { description } } }`, { g: guid, d });
    return guid;
  }
  const made = await mutate(`create dashboard ${FAMILY}`, `mutation($a: Int!, $d: DashboardInput!) { dashboardCreate(accountId: $a, dashboard: $d) { entityResult { guid } errors { description } } }`, { a: ACCOUNT, d });
  if (made?.dashboardCreate.errors?.length) throw new Error(made.dashboardCreate.errors.map((e: { description: string }) => e.description).join('; '));
  return made?.dashboardCreate.entityResult?.guid ?? null;
}

// 6. Which apps reported page views lately: an app missing here has no settings on the site, or
// nobody opened it.
async function reporting() {
  const nrql = `SELECT count(*) FROM PageView WHERE appName LIKE '${FAMILY} %' FACET appName SINCE ${process.env.REPORTING_SINCE ?? '1 day ago'} LIMIT 50`;
  const d: any = await gql(`query($a: Int!, $q: Nrql!) { actor { account(id: $a) { nrql(query: $q) { results } } } }`, { a: ACCOUNT, q: nrql });
  const counts = new Map<string, number>((d.actor.account.nrql.results ?? []).map((r: { appName?: string; facet?: string; count: number }) => [r.appName ?? r.facet ?? '', r.count]));
  log(`\nPage views since ${process.env.REPORTING_SINCE ?? '1 day ago'}:`);
  for (const app of apps) log(`  ${browserName(app)}: ${counts.get(browserName(app)) ?? 0}`);
}

try {
  const settings = await browserApps();
  if (OUT) writeSiteSettings(settings, OUT);
  if (REPO_VARIABLES) setRepoVariables(settings);
  await uptime();
  const policyId = await alerts();
  const dash = await upsertDashboard();
  log(`\nAlert policy ${policyId ?? '(dry run)'}; dashboard https://one.newrelic.com/redirect/entity/${dash ?? '(dry run)'}`);
  await reporting();
  await geography();
} catch (e) {
  console.error(`newrelic: ${scrub(e instanceof Error ? e.message : String(e))}`);
  process.exit(1);
}
