# Observability

How the Huishouden apps report errors, speed and usage, what is alerted, and how it is set up.
The rules for apps are in [STANDARD.md](../STANDARD.md#observability).

## Why New Relic

| Need | New Relic (free tier) | Firebase Performance + Google Analytics | Cloudflare Workers Observability |
|---|---|---|---|
| Browser JS errors | Yes, with stack traces, per app and version | No (Crashlytics has no web SDK) | Worker only |
| Core Web Vitals | Yes (LCP, INP, CLS per page view) | Yes (Performance Monitoring) | No |
| Usage, geography from the network, no device id | Yes (PageView, PageAction; session tracking can be turned off) | Yes, but Analytics is ad-tech: cookies, Google signals, a consent banner in many countries | No |
| Alerts by email | Yes, on any query | Performance alerts only; no error alerts | Paid plans |
| Uptime checks | Unlimited ping monitors | No | No |
| Worker heartbeat | Event API + loss-of-signal alert | No | Logs only, no alert on free |
| Cost | $0: 100 GB/month ingest, 1 full user | $0 | $0 (logs) |

One tool covers errors, vitals, usage, uptime, the notify Worker and alerts, with SQL-like queries
(NRQL) over all of it. Firebase would still need a second tool for errors and alerts, and Google
Analytics sends far more than these apps need.

## What is collected

| Data | Event | When | Why |
|---|---|---|---|
| Uncaught JS errors and handled failures (`reportError`) with Firestore or HTTP code | `JavaScriptError` | Always | Hear about breakage first; error-spike alert |
| Page loads with LCP, INP, CLS and load time | `PageView`, `PageViewTiming` | Always | Speed on the tablet and phones; page views per app |
| Feature use and screens (`track`, `trackView`) | `PageAction` (`actionName`, `view`) | Not under GPC or DNT | Which features matter |
| Hashed household (`householdTag`) | attribute `household` | Not under GPC or DNT | Count active households without knowing which |
| App, version, build SHA | attributes `app`, `application.version`, `buildSha` | Always | Errors per release |
| Device type and browser | derived by New Relic from the request | Always | Devices to test on |
| Country, region, city, network (`asn`, `asnOrganization`) and the network's coordinates (`asnLatitude`, `asnLongitude`) | derived by New Relic from the network address the report comes from | Always | Where the apps are used; see [Geography](#geography) |

Nothing is stored on the device: the agent runs with session tracking off
(`privacy.cookies_enabled: false`), so there is no cookie and no localStorage id, every count is per
visit, and nothing links one visit to the next. That is why no consent banner is needed. When the
browser sends Global Privacy Control (or Do Not Track), the agent loads without the usage feature,
and `track`, `trackView`'s count and the household hash are skipped silently; errors and performance
still go. There is no opt-out screen.

Not collected: names, emails, household ids, entries or anything typed, query strings and
fragments, the device's location (the agent has no access to it; the apps that use it for a store
nearby keep it on the device), IP addresses (New Relic uses the address only to work out the geography
and overwrites it within 24 hours), session ids, replays, traces, AJAX URLs, clicks. `redact` and the agent's `obfuscate`
rules strip emails, `households/…` and `profiles/…` path ids, query strings and long numbers from
every message, stack trace and URL before it is sent.

Nothing at all is sent when the browser is automated (Playwright, CI), the page is not on
`*.web.app` / `*.firebaseapp.com` over https, or the app has no settings: no entry in the site's
`/hh-observability.json` and no `VITE_NEWRELIC_*` variables (staging gets neither).

The portal's `/privacy` page says this for people using the apps; every app's account menu links it.

## Geography

New Relic Browser places every report by the network address it comes from: `countryCode`,
`regionCode`, `city`, the network (`asn`, `asnOrganization`) and that network's coordinates
(`asnLatitude`, `asnLongitude`). It is the location of the internet provider's network, often a
nearby city rather than the person's own, and never the device's location. All of it is kept as
long as the rest of the Browser data: 8 days on the free plan (`dataManagement` retention for the
`Browser`, `Browser:EventLog`, `Browser:JSErrors` and `PcvPerf` namespaces; the free plan allows 1 to
8), then deleted.

City and coordinates are kept because nothing on the free plan can drop them:

| Way to drop them | Result (checked 2026-10-04) |
|---|---|
| NRQL drop rules (`nrqlDropRulesCreate`) | Discontinued 2026-08-31 ([EOL notice](https://docs.newrelic.com/eol/2025/05/drop-rule-filter/)); NerdGraph answers "Customer account is not authorized to create legacy drop rules" |
| Pipeline cloud rules (`entityManagementCreatePipelineCloudRule`, scope `ACCOUNT`) | "Access denied ... can_create PIPELINE_CLOUD_RULE", although the key's user is in the Admin group with All Product Admin, a role that carries "Pipeline control cloud rules: modify". Pipeline Control is sold as part of Advanced Compute ([costs](https://docs.newrelic.com/docs/new-relic-control/pipeline-control/costs/)); free accounts "must upgrade to a paid plan to continue using drop rules" ([EOL notice](https://docs.newrelic.com/eol/2025/05/drop-rule-filter/)) |
| Pipeline cloud rules, scope `ORGANIZATION` | "Scope not supported: ORGANIZATION" (cloud rules are per account) |
| Browser agent settings | None turn geography off: it is added at ingest, not by the agent ([security for browser monitoring](https://docs.newrelic.com/docs/browser/new-relic-browser/performance-quality/security-browser-monitoring/)); obfuscation rules only rewrite what the agent sends |
| Sending only errors | Errors carry the same attributes, so it would change nothing |
| A relay without `X-Forwarded-For` ([proxy settings](https://docs.newrelic.com/docs/browser/new-relic-browser/configuration/proxy-agent-requests/): "New Relic will geolocate your proxy as the client instead") | Works: New Relic locates only from `X-Forwarded-For`, else the connecting address, and ignores `CF-Connecting-IP` and `X-Real-IP` (tested). Not built: it needs a public endpoint (a Cloudflare Worker route) that forwards to New Relic, a decision for the maintainers |

The monitoring workflow still tries the pipeline cloud rules every run (`DELETE city, asnLatitude,
asnLongitude FROM <event> WHERE appName LIKE 'Huishouden %'` for `PageView`, `PageViewTiming`,
`PageAction`, `JavaScriptError` and `BrowserPerformance`), so they appear on the first run after the
account gets Pipeline Control. Until then the refusal is a notice, not a failure, and the run's
summary says how many page views carried a city and how long Browser data is kept. The portal's
`/privacy` page says the same in plain words.

## In an app

```ts
// src/data/firebase.ts (or main.tsx), before rendering
import { startObservability } from '@huishouden/pwa-kit/observability';
startObservability({ app: 'baby', env: import.meta.env });
```

```ts
import { reportError, track, trackView } from '@huishouden/pwa-kit/observability';
track('log feed', { kind: 'bottle' });          // a feature used: an action name and small enums
trackView(tab);                                 // a screen or tab shown
catch (e) { reportError(e, { where: 'import statement' }); }  // handled failures readError doesn't see
```

`saveMyProfile` tags the visit with the household's hash, so apps that record profiles need nothing
else for the household count.

## Alerts

Policy **Huishouden**, emailed through the workflow **Huishouden alerts** (destination
**Huishouden alerts email**). All are NRQL conditions (free).

| Condition | Fires when |
|---|---|
| App errors spike | More than 10 errors in one app within 30 minutes (one incident per app) |
| Site down | An app's uptime check (its path on the suite's site) failed twice within 30 minutes (ping every 30 min from 2 locations) |
| Notify sender silent | No `NotifyRun` heartbeat from the notify Worker for 20 minutes (it runs every 5) |
| Notify run crashed | A notify run threw (`NotifyRun.error`), other than a stop at a read limit (`QuotaExhausted`) |
| Notify stopped by Firestore's quota | A notify run stopped because Firestore refused reads for the project's daily quota (`NotifyRun.quota`); every app is refused until midnight Pacific |
| Push deliveries failing | More than 5 Web Push deliveries failed in an hour |

CI failures on `main` are emailed by GitHub to whoever pushed.

## Dashboard

**Huishouden** (pages Overview, Errors, Core Web Vitals, Usage): errors and page views by app,
hashed active households, error rate, countries and regions, devices, uptime, notify runs, top
errors by version and code, LCP/INP/CLS p75 per app, feature use and tabs. Counts are per page
view or visit; there are no sessions to count, by design.

## Setup

Provisioning runs in CI, in the portal repo: `.github/workflows/monitoring.yml` (huishouden/portal).
No New Relic key lives on anyone's machine, and no app repo holds New Relic variables.

```
portal apps.json ──► monitoring workflow ──► New Relic: Browser apps, ping monitors, alerts, dashboard
                         │ (infra/newrelic.ts at the kit version the portal pins)
                         └──► portal release `observability`, asset observability.json
                                   │
every production deploy (pwa-site assemble) ──► /hh-observability.json on the site
                                   │
each app (startObservability) reads its path's entry at start
```

The workflow runs when `apps.json` changes on `main` and on demand; a monitor edited or deleted by
hand is repaired by a manual run. It:

1. Creates or updates, by name: a Browser app per app (`Huishouden Baby`, …), a ping monitor per
   app at its path on the suite's site (`https://<site>.web.app/<app>/`), the alert policy,
   conditions, email destination, channel and workflow, the dashboard, and, where the plan allows
   them, a pipeline cloud rule per browser event type that drops city and coordinates
   ([Geography](#geography); refused on the free plan, reported as a notice). A family ping
   monitor whose name is not one of the apps' (a removed app) is deleted; an existing monitor at an
   old per-app address is moved to the path.
2. Writes each app's browser settings (account id, app id, browser key `NRJS-…`; public by design,
   the browser key can only send data) to `observability.json` and, when it changed, uploads it to
   the portal's `observability` pre-release and starts the portal's CI, which deploys the site with
   the new `/hh-observability.json`. (Without that, the next deploy of any app, or a manual reconcile run, picks up the new
   asset and deploys it.) No app rebuilds: the settings are read at run time, so an app added to
   `apps.json` reports from the next deploy.

The assembler publishes the file only if it holds nothing but digits and `NRJS-` keys, so a user
key can never reach the site. The script prints no key; failures are scrubbed of anything shaped
like one.

Without the `NEW_RELIC_API_KEY` secret the workflow skips with a notice and succeeds.

### Once, by a maintainer

1. A New Relic account (free, no card): https://newrelic.com/signup. US data region.
2. A user key: one.newrelic.com > your name > API keys > Create a key > type User, named
   `huishouden-portal-ci`. Paste it straight into the secret (it is never needed anywhere else):

   ```sh
   gh secret set NEW_RELIC_API_KEY -R huishouden/portal   # paste at the prompt
   gh secret set ALERT_EMAIL -R huishouden/portal         # the address alerts go to
   gh workflow run monitoring.yml -R huishouden/portal
   ```

   The account id is not secret; it is set in the workflow (`NEW_RELIC_ACCOUNT_ID`).
3. If New Relic sends a verification email to the alert address, confirm it.
4. Notify heartbeat: put an ingest key in the Worker (huishouden/notify README, "Monitoring").

### Rotating the key

1. Create a new User key (as above), named with the date.
2. `gh secret set NEW_RELIC_API_KEY -R huishouden/portal` and paste it.
3. `gh workflow run monitoring.yml -R huishouden/portal` and check it passes
   (`gh run watch -R huishouden/portal`).
4. Delete the old key in one.newrelic.com > API keys.

The browser key and app ids do not change with it, so the apps are unaffected.

### Running it by hand

For a family without the portal's workflow, or to try a change to the script, from this repo:

```sh
NEW_RELIC_API_KEY=… NEW_RELIC_ACCOUNT_ID=… ALERT_EMAIL=you@example.com \
  bun infra/newrelic.ts ../portal/apps.json --out observability.json
```

`DRY_RUN=1` prints what it would do. `--repo-variables` sets the `VITE_NEWRELIC_*` variables on each
app's repo instead (apps served from a site of their own; needs `gh` with admin on the repos).

## Free-tier headroom

| Item | Free allowance | Expected use |
|---|---|---|
| Data ingest | 100 GB/month | Under 0.1 GB: about 2 KB per page view, 288 notify events a day |
| Full platform users | 1 | 1 |
| Ping monitors | Unlimited | 10 apps × 2 locations × 2/hour ≈ 29,000 checks/month, not billed |
| Other synthetic checks | 500/month | 0 |
| Alerts, dashboards, pipeline cloud rules | Included | 6 conditions, 1 dashboard, 5 rules |

Browser events are kept for New Relic's default retention (8 days for raw events at the time of
writing), so the dashboard's month-long charts fill in over time and older detail ages out.

## Checking it works

Every provisioning run ends with each app's page views over the last day (in the portal's
monitoring run summary); an app at 0 after a visit has no settings on the site. By hand:

```sh
newrelic nrql query --accountId <id> --query "SELECT count(*) FROM PageView, JavaScriptError, PageAction WHERE appName LIKE 'Huishouden %' FACET eventType(), appName SINCE 1 hour ago"
newrelic nrql query --accountId <id> --query "SELECT latest(timestamp), sum(pushed) FROM NotifyRun SINCE 30 minutes ago"
```
