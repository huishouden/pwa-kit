# One site for the whole suite

Every Huishouden app is served from one Firebase Hosting site, under its own path:

| Path | App | Repo |
|---|---|---|
| `/` | Portal | `portal` |
| `/<app>/` (`/spending/`, `/baby/`, `/pet/`, `/home/`, `/car/`, `/bills/`, `/tasks/`, `/groceries/`, `/health/`) | that app | `<app>` |

Production is `https://huishouden-piekstra.web.app/` (`SUITE_SITE` in `./site`), staging mirrors it on
the staging sites.
Repos, tests, staging runs and releases stay separate: only hosting is shared.

## Why

An installed PWA shows no browser UI only while it navigates inside its manifest `scope`, and a
scope can't leave its origin. With one site per app, every tile in the installed portal opened a
second origin: a browser bar, a second sign-in, a second set of permissions. On one origin the
portal's scope `/` covers every app, and Firebase Auth keeps one session for all of them (they
share the project's browser API key, so the IndexedDB session record is the same one).

## Paths and builds

- `pwaApp({ base: '/pet/' })` (from `./vite`) sets Vite's `base`, so assets, `index.html` links and
  the manifest link carry the prefix. Apps use `import.meta.env.BASE_URL` for anything they build
  by hand, and `appUrl(import.meta.env.BASE_URL, '?tab=care')` for absolute links (agenda items,
  reminders, invitations): the origin comes from the page, so a staging build links to staging.
- Manifest: `id`, `start_url` and `scope` are the base (`/pet/`), icons and the share target live
  under it. The portal keeps `/` for all three: installing the portal covers every app, so moving
  from a tile into `/pet/` stays in the installed window with no browser bar. Each app stays
  installable on its own (its own id and scope); an installed app opens only its own path.
- Links between apps are same-origin paths (`/`, `/pet/`, `/privacy`), never absolute URLs, so the
  staging portal leads to staging apps.

## Service workers

Each app registers `<base>sw.js` with scope `<base>` and precaches only its own build (the build
runs before assembly, so other apps' files are never in its glob). Workbox's navigation fallback is
`<base>index.html`.

The portal's worker has scope `/`, which also matches `/pet/…` until the Pet worker is installed
(a browser picks the registration with the longest matching scope, so once `/pet/sw.js` is
registered it controls `/pet/` pages). Without care, the first tap on a tile would get the portal's
cached `index.html`. `pwaApp({ base: '/', otherApps: ['pet', …] })` adds every app path, and
Firebase's `/__/`, to `navigateFallbackDenylist`, so those navigations go to the network. The portal
reads the paths from `apps.json`. Asset requests from an app page the portal's worker controls fall
through to the network: no precache route matches them.

Updates: one worker per base, which installs a new version and waits until `./update` applies it
(at launch, when the page is hidden with nothing unsaved, or from the Update button; STANDARD.md
"Updates"), then claims its pages; `sw.js`, `index.html` and manifests are `no-cache` under every base.

Push: the notification click handler reuses a window inside the tapped worker's scope (not any
window of the origin, which would now be another app), and icons resolve against the scope.

## Same origin: storage

One origin means one `localStorage`, one IndexedDB and one Cache Storage for every app.

| Store | Key | Shared? |
|---|---|---|
| Firebase Auth | IndexedDB `firebaseLocalStorageDb`, `firebase:authUser:<apiKey>:[DEFAULT]` | Shared on purpose: one sign-in |
| Firestore cache | IndexedDB `firestore/[DEFAULT]/<project>/main`, multi-tab manager | Shared: one cache, any number of tabs and apps. A failed open falls back to memory |
| Write outbox | `hh-outbox:<project>:<time>-<seq>-<tab>` | Shared on purpose: a note is a complete write (path and data), so whichever app opens next replays it for the same member |
| Republish notes | `hh-published:<project>:<household>:<list>:<app>:<member>` | Shared on purpose: a fingerprint of what this device last published to the agenda, to-dos or reminders, so any app skips an unchanged republish ("Budgets") |
| Google API tokens | `hh-google-tokens` (entries keyed by uid and scopes) | Shared on purpose: the same OAuth client, so a Calendar token granted in Pet serves Home |
| Calendar asked | `<app>-calendar-allowed` | Per app already |
| Suggestion dismissals | `<app>-calendar-dismissed-<uid>`, `<app>-google-tasks-dismissed-<uid>` | Per app already |
| Portal layout cache | `hh-portal-layout` | Portal only |
| Spending, Baby, Tasks | `spending-seen-alerts-*`, `baby-seeded-*`, `hearthlist.*` | Per app already |
| Workbox precache | `workbox-precache-v2-<scope>` | Per app (the scope is in the name) |
| OCR runtime cache | `hh-ocr` | Shared on purpose: versioned CDN files |

Nothing needed renaming. New keys follow the rule in STANDARD.md "One site": prefix with the app's
short name unless sharing is the point, and say so.

## Deploys without cross-repo secrets

Firebase Hosting replaces a whole site on each deploy, so every deploy ships every app. Each repo
keeps its own credentials (Workload Identity Federation, the same deploy account it already uses;
the asset CDN's Cloudflare token is the portal's `production` environment's alone, "Asset CDN",
Token) and reads the other apps only from public release assets:

1. `build` (every run) builds `dist`. On `main` it also builds `dist-staging` with the
   `STAGING_VITE_*` variables.
2. `publish` (`main` only, `contents: write` on its own repo) packs each as a tarball with an
   `hh-build.json` stamp (repo, base, sha, version, time) and uploads `site.tar.gz` and
   `site-staging.tar.gz` to the repo's rolling `hosting` pre-release, replacing the previous ones.
   A build that fails never gets here, so the last good asset stays.
3. `deploy` (`main` only, production credentials) runs `pwa-site assemble`: reads the registry
   (`apps.json` in the portal repo, public), downloads each other app's latest `site.tar.gz` by
   asset id, unpacks each under its path, puts this run's own `dist` under its own, writes the
   combined `firebase.json` and `/hh-site.json` (which asset of each app is in this deploy), and
   `/hh-observability.json` (each included app's New Relic browser settings, from the portal's
   `observability` release asset; production only, docs/observability.md). With the asset CDN on,
   the portal's deploy (the only one with the Cloudflare token) uploads the assets there first
   (`pwa-site cdn`, `wrangler deploy`, "Asset CDN") and then deploys to Firebase; an app's deploy
   uploads nothing and keeps the CDN only for builds it already holds ("Asset CDN", without the
   token). Then `pwa-site stale` asks GitHub for the assets again; if any app
   published since the download, it assembles, uploads to the CDN and deploys again (up to three
   rounds). Apps without an asset yet are
   left out (their path falls to the portal).
4. `smoke` checks the live app over HTTP, no browser (see Bandwidth).

Races: two repos deploying at once each include the other's newest asset or notice it afterwards
(step 3's recheck), and the last deploy wins with both. A manual run of the portal's `ci` with
`reconcile: true` compares the live `/hh-site.json` with the latest assets (the apps' and the
observability settings) and deploys only when they differ; nothing runs it on a schedule (STANDARD.md
"CI/CD"), and the next deploy of any app picks up a lost update.

Rejected: cloning the live Hosting version and replacing one path (Hosting API `versions.clone`).
No deploy would hold every app's source, so a lost update could not be repaired, and the site's
config would have no owner.

### The combined firebase.json

Generated by `siteConfig()` (`./site`), never hand-edited:

- `redirects`: `/<app>` to `/<app>/` (301).
- `rewrites`: `/<app>/**` to `/<app>/index.html` per app, then `**` to `/index.html` (the portal).
  `/__/` is Firebase's and is never rewritten.
- `headers`: the security headers on every path except `/__/`. `Permissions-Policy` applies to the
  document it arrives with, so each app's path gets the features its own `firebase.json` turns on
  (Car `camera=(self)`, Tasks and Groceries `geolocation=(self)`) and the rest of the site the portal's; a union
  would hand every app every feature. `no-cache` on each base's `sw.js`, `registerSW.js`, `hh-push-sw.js`, `index.html`, manifests
  and on `/hh-site.json` and `/hh-observability.json`; a year, immutable, on each base's `assets/`.

Each app's own `firebase.json` stays the place it declares its headers (`pwa-headers-check`); `pack`
copies its `Permissions-Policy` into the build's stamp for the assembler.

## Staging

Same shape, staging builds: a staging deploy (the PR author's, or a manual `staging-ref` run) assembles the branch's build with the latest
`site-staging.tar.gz` of every other app and deploys the whole suite to that app's own staging site
(`huishouden-staging-<app>.web.app`, the portal's is `huishouden-staging.web.app`). It serves its
own assets: no job that builds a ref holds the Cloudflare token, so nothing goes to the staging
asset CDN ("Asset CDN"); the build runs in a job with no credentials. The signed-in
tests run at `https://<staging site>/<app>/`. Each app keeps its own staging site so two repos' PRs
never overwrite each other mid-test; every staging site is a full mirror (portal at `/`, all apps
under their paths), so cross-app checks (one sign-in, tiles) work on any of them. Only
`huishouden-staging.web.app` is an origin of the staging OAuth client ("Sign-in origins"), so
Google's prompt and Google API tokens work there and not on the per-app staging sites.

## Bandwidth

Production is on Firebase's free Spark plan: **10 GB of Hosting transfer a month** for the whole
project (every app, the old per-app sites, preview channels), and at 10 GB Hosting stops serving
until the month resets. Staging (`huishouden-staging`) is a separate project with its own 10 GB.

Budget: households use well under 1 GB a month. A first visit to an app costs its precache (the
service worker downloads every file of the build, compressed: 0.3 to 1.5 MB per app, of which only
the icons, the manifest and the Workbox runtime, about 100 KB, come from Hosting since the asset
CDN); a later visit costs index.html (about 3 KB) and the service worker check. So a browser session against production
costs as much as a new household member. CI therefore never opens production in a browser:

- each deploy's `smoke` is one GET of index.html and HEAD requests for the site's copy of one hashed
  asset, the web manifest and `sw.js`: about 4 KB per deploy, 4 MB for 1,000 deploys (the asset
  itself is fetched from the CDN);
- pull requests run no CI; their browser tests and screenshots run on staging or locally, never
  on production;
- `pwa-bandwidth-check`, run by `pwa.yml` before the build, fails any workflow step that runs a
  browser naming production or without `BASE_URL`; a step whose config only targets localhost says
  so with a `# pwa-bandwidth-check: local` comment line;
- the New Relic uptime monitors are pings (one GET of index.html, about 3 KB) every 30 minutes
  from two locations: about 0.1 GB a month for the suite.

Builds split React and Firebase (`vendor-*.js`) from the app's own code (`stableChunks` in the
preset, Vite 8), so a deploy that changes only the app changes one chunk of about 60 KB compressed, and an installed copy downloads that on update instead of the whole 300 KB bundle.

Hashed files under `/assets/` are `public, max-age=31536000, immutable`; HTML, `sw.js` and
manifests are `no-cache` (revalidated with the ETag, a 304 costs headers only). Hosting compresses
text with Brotli or gzip.

The hashed files themselves are served from the asset CDN (next section), so what Hosting sends per
page load is the HTML, the service worker check and the manifest.

## Budgets

Production runs on Firebase's free Spark plan. Its limits are per project, shared by every
household, every app and every Worker, and a limit reached stops that service for everyone:

| Resource | Spark limit | Resets | What happens at the limit |
|---|---|---|---|
| Firestore document reads | 50,000 a day | midnight Pacific | every read fails, in every app and Worker |
| Firestore writes | 20,000 a day | midnight Pacific | every write fails (the outbox keeps them) |
| Firestore deletes | 20,000 a day | midnight Pacific | every delete fails |
| Firestore stored data | 1 GiB | | writes fail |
| Hosting transfer | 10 GB a month | the 1st | the suite stops loading (see Bandwidth) |
| Hosting storage | 10 GB | | deploys fail |

Reads are the limit that bites. Firestore bills, and counts against the quota
(https://cloud.google.com/firestore/pricing):

- one read per document a query, `get` or listener returns;
- **at least one read per query and per aggregation**, even when nothing comes back, and one per
  1,000 index entries an aggregation (`count`, `sum`) walks;
- a listener: its whole result when it starts, then one per changed document. When its connection
  has been gone for **more than 30 minutes** (a tablet asleep, a closed lid), it is billed its whole
  result again on reconnecting, persistent cache or not. Within 30 minutes only changes are billed;
- `getDocs` always asks the server (the cache is not trusted to be complete): its whole result each time.

Cloud Monitoring's `firestore.googleapis.com/document/read_count` counts documents returned only, so
it leaves out the one-read minimum of empty queries and aggregations. The Workers' checks are
mostly those: add the `RunQuery` and `RunAggregationQuery` requests (`api/request_count`) to get what
is billed.

### A household's day

The budget is **under 5,000 reads a day per active household**, so the free plan holds about ten
(50,000 less the fixed costs below and a margin). The sizing assumes a household (invented, round
numbers) of four members, two with Google Calendar sync, one Spending alert inbox, a screen that
shows the portal all day, and about fifteen app opens a day, two of them Spending.

| Source | What it reads | Reads a day |
|---|---|---|
| Calendar Worker, checks | per Google-synced member: the household and their settings (`batchGet`, 2) and four aggregations (at least 1 each); Google's side every 5 minutes (no Firestore read), the household's every 5 minutes while it changed in the last hour, every 15 otherwise (assumed active a quarter of the day: 144 checks) | ~1,700 |
| Calendar Worker, syncs and feeds | per change and member: an aggregation per list, then only documents changed since the kept copy (`src/lists.ts` in calendar); a whole list when something was deleted, and once a day | ~400 |
| Calendar Worker, alert inbox | Gmail first (no Firestore read); cards, rules and settings every 12 hours (~125); the import's few days of transactions | ~300 |
| Spending | per open after 30 minutes: this and last month's transactions (~250), rules, cards, settings; an older month when opened | ~800 |
| Portal on the always-on screen | per wake after 30 minutes asleep: a week of agenda (the Calendar tab: all of it), to-dos, contacts, members, settings (~75) | ~800 |
| Other app opens | each app's own lists (10 to 60), and its agenda, to-dos and reminders only when they changed or this device's last sync of them is over 6 hours old (`./published`) | ~600 |
| **Household total** | | **~4,600** |

Fixed, once for the project: Notify's due-reminder queries, two every 5 minutes (`FIRESTORE_NOTIFY_READS`
caps the rest), ~600 a day.

What keeps it there, and what to keep when changing an app:

- **No full-history listeners.** A listener's whole result is billed again after every 30-minute
  gap, so a list that only grows (Spending's transactions) is followed by date window, and older
  months are read when shown; the portal follows a week of agenda except on its Calendar tab.
- **Apps republish only what changed.** `syncAgenda`, `syncTodos`, `syncReminders` and their
  personal forms skip the read when this device published the same items in the last 6 hours
  (`src/published.ts`).
- **Workers ask cheaply first.** A check is aggregations and a `batchGet`, never a list; a sync reads
  documents changed since its cached copy. Each Worker runs its reads under the kit's `ReadBudget`
  (`./read-budget`): a cap per run, its own share of the day, a pause when Firestore answers 429.
  The shares and their sum are in STANDARD.md "Read budgets"; a check spaces itself out rather than
  go over its share.
- **Read-budget tests.** Every Worker run type and every app's main screens and sync paths have a
  test with a ceiling on the reads it is billed for (`./read-test`, STANDARD.md "Read budgets").
- **No browser against production** (Bandwidth): one automated browser run reads as much as a
  household's day.
- **Alerts at 5,000 an hour and at 60% of the day.** `infra/read-alert.sh` (run by the bootstrap with
  `ALERT_EMAIL`, or `hh ops read-alerts`) keeps two Cloud Monitoring alert policies, free: billed
  reads (documents returned plus one per query and aggregation request) over 5,000 in the last hour,
  which a runaway job reaches in minutes while the suite's busiest normal hour is under 4,000, and
  over 30,000 in the last 24 hours. Only a policy that differs from the live one is written, so re-running
  it changes nothing: an edit to a policy whose condition holds re-opens its incident and emails again.

Writes are not close: a household writes a few hundred documents a day (each saved record, its
agenda and to-do items when they change, the Workers' syncs), against 20,000.

### Past ten households: Blaze

On the pay-as-you-go Blaze plan the same free amounts apply each day, and beyond them
(us-east1, where the production database is):

| | Price | A household at the budget (30 days) | Cost a month |
|---|---|---|---|
| Reads | $0.03 per 100,000 | 5,000 a day: 150,000 | $0.045 |
| Writes | $0.09 per 100,000 | ~500 a day: 15,000 | $0.014 |
| Deletes | $0.01 per 100,000 | ~100 a day: 3,000 | $0.0003 |
| Hosting transfer | $0.15 per GB past 10 GB a month | well under 0.1 GB | under $0.015 |

About **$0.06 a household a month** past the free ten; a hundred households cost about $6 a month,
less the free amounts. Blaze needs a billing account; set a budget alert on it.

## Asset CDN

Every build's hashed files (`<base>assets/*`: JS, CSS, fonts, wasm, imported images) are served
from a Cloudflare Worker with static assets, which Cloudflare serves free and without a request
limit ("Requests to static assets are free and unlimited",
https://developers.cloudflare.com/workers/platform/pricing/). Everything else stays on Firebase
Hosting at the same address: `index.html`, `sw.js`, `registerSW.js`, the web manifest, icons. So
the app's address, its service worker's scope and its install identity are unchanged, and an
update still arrives through the same-origin `sw.js`.

| | Production | Staging |
|---|---|---|
| Worker | `huishouden-assets` | `huishouden-assets-staging` |
| Origin | `https://huishouden-assets.huishouden-app.workers.dev` | `https://huishouden-assets-staging.huishouden-app.workers.dev` |
| `Access-Control-Allow-Origin` | `https://huishouden-piekstra.web.app` (`SUITE_ORIGIN`) | `*` (a staging site per app, local previews) |

A page opened at the project's other host, `huishouden-piekstra.firebaseapp.com`, is not in that
list: its CDN requests fail CORS and the fallback loads the site's own `assets/` (correct, from
Hosting).

`src/asset-cdn.ts` holds these. Paths on the CDN match the site's: `/spending/assets/index-abc.js`
on the CDN is `/spending/assets/index-abc.js` on the site.

**Build.** `pwa.yml` sets `HH_ASSET_ORIGIN` to the flavor's origin (production for `site.tar.gz`,
staging for `site-staging.tar.gz` and staging runs). `pwaApp` then:

- names the entry script, its module preloads and stylesheets in `index.html` at the CDN
  (`renderBuiltUrl`), as `type="module" crossorigin` scripts and `crossorigin` links, after a
  `preconnect` (with `crossorigin`) and a `dns-prefetch` for the CDN;
- has JS and CSS reach each other, fonts and images by relative URL, so a build loaded from the
  site's own copy keeps loading from there;
- has the service worker precache `assets/*` from the CDN (Workbox `manifestTransforms`), fetched
  with CORS, and answer the page's CDN requests from that cache, so the app opens offline as before;
- puts a small inline script first in `<head>`: when a script or stylesheet from the CDN fails to
  load, or a CDN script fails to parse while the page loads, it replaces the page once with
  `<base>index.site.html`, the same page naming the site's own `assets/` (the assembler writes it
  beside each `index.html`), keeping the address in the fragment, which that page puts back before
  the app starts. The service worker leaves `index.site.html` to the network.

A local build (no `HH_ASSET_ORIGIN`) is exactly as before.

**Deploy.** Firebase keeps a full copy of every asset (it costs nothing unless used). The deploy
job assembles the site as before, then, assets first:

1. `pwa-site cdn` builds the CDN's next version: every `assets/` file of the assembled site, plus
   every earlier file the CDN's `/hh-assets.json` saw in a live build within 30 days, downloaded
   back from the CDN (free), so pages and service workers of earlier deploys still find theirs.
   It writes `_headers` (CORS, `Cross-Origin-Resource-Policy: cross-origin`, `nosniff`, a year
   immutable on `assets/`), the manifest and `wrangler.toml`. The files are uploaded as built and
   Cloudflare compresses them per request, at a lower Brotli level than Hosting's precompressed
   files (the suite's vendor chunk: 248 KB from the CDN, 209 KB from Hosting). Uploading them
   already compressed does not work: with `Content-Encoding: br` in `_headers`, Cloudflare
   compresses the stored Brotli again and browsers receive it double-encoded. A Worker version holds at most 20,000
   files on the free plan; the oldest earlier files give way past 18,000.
2. `wrangler deploy` (an exact version, `WRANGLER_VERSION` in `pwa.yml`) uploads it; unchanged
   files are not sent again. `pwa-site cdn-check` then reads `hh-assets.json` back: another
   repo's upload that started from an older manifest can replace this one, and then the upload
   runs again (up to three times), now carrying that repo's files too.
3. `firebase deploy` publishes the pages that name them. After the pages are live (and after the
   last recheck round), `pwa-site cdn-check` runs again and uploads once more if another repo's
   upload has replaced the CDN's files since.

The recheck rounds (an app published meanwhile) repeat both.

**Without the token: every app's deploy.** Only the portal's deploy holds the token (below). An
app's deploy assembles the same site with `--cdn-held`: each app whose every asset the live CDN's
`hh-assets.json` already lists keeps naming the CDN; an app with any asset it lacks (the app's
own new build) has the CDN stripped from its pages and service worker, as with the CDN off, and
`hh-site.json` lists it under `offCdn`. Nothing is uploaded, and no page names a file the CDN
lacks, so assets still come before the pages that name them. The run shows a notice naming the
apps off the CDN. The portal's next deploy (a push to its main, or its `ci` run with
`reconcile`, which counts `offCdn` as stale) assembles every app's build, uploads the assets with
the retention manifest, and only then deploys the pages that name them.

Staging: `staging-site` uploads to the staging Worker only when a token is passed, and none is (a
staging run builds any ref, and the token never reaches a job that does), so staging serves the
site's own assets. It runs nothing from the ref either way; the ref's build runs in
`staging-build`, which holds no credentials.

`smoke` GETs one CDN asset with `Origin` (status, `immutable`, JavaScript content type, CORS,
`Cross-Origin-Resource-Policy`, compression) and HEADs the site's own copy.

**Token.** `CLOUDFLARE_API_TOKEN` (an account token with Workers Scripts edit, the one the
connector, notify and calendar Workers deploy with) and `CLOUDFLARE_ACCOUNT_ID` are secrets of the
portal's `production` environment only, whose deployment branches are `main` alone (`hh ops
secret set portal CLOUDFLARE_API_TOKEN --env production`, the value on stdin). The deploy job runs
in that environment, so it reads them there; no app repo holds them, and the portal's `ci.yml`
passes none. Only the wrangler command gets the token; nothing stores it, so rolling it means
updating the environment secret in place (and the three Workers' own, which deploy with the same
token from their `production` environments).

**Rollback.** Set the variable `HH_ASSET_CDN=off` (organization-wide, or per repo), then deploy any
app or run the portal's `ci` with `reconcile: true`, which sees the switch differ from the live
`hh-site.json`. The assembler then removes the CDN from every page and service worker
(`--assets-origin none`) and the suite loads its own `assets/` from Hosting as before; installed
copies get a new `sw.js` and refill their cache from the site. Remove the variable to turn the
CDN back on (an app's deploy then names it only for builds it holds; the portal's deploy, for all).

**CSP.** The suite's `Content-Security-Policy` has no fetch directives, so the CDN needs no entry;
`pwa-headers-check` fails a policy that adds `script-src`, `style-src`, `font-src`, `img-src`,
`connect-src` or `default-src` without the CDN's origin.

## Sign-in origins

Two lists decide where Google sign-in works, and they are kept to what the one site needs.

| List | Where | Production (`huishouden-piekstra`) | Staging (`huishouden-staging`) |
|---|---|---|---|
| Authorized JavaScript origins of the OAuth web client | Google Cloud console only (no API) | `https://huishouden-piekstra.web.app`, `https://huishouden-piekstra.firebaseapp.com` | `https://huishouden-staging.web.app`, `https://huishouden-staging.firebaseapp.com` |
| Firebase Auth authorized domains | Identity Toolkit API (the bootstrap) | `huishouden-piekstra.web.app`, `huishouden-piekstra.firebaseapp.com` | those two for staging, every `huishouden-staging-<app>.web.app`, `localhost` |

The OAuth client's origins are what Chrome's sign-in prompt (One Tap, `signInSilently`) and Google
API tokens (`google-token`) check. Google allows an OAuth app that has not been through verification
at most 10 authorized domains, and every `*.web.app` site counts as its own domain (they are on the
public suffix list), so one origin per app does not fit: production would need 10 sites plus
firebaseapp.com, staging 11. It does not need to: every app runs on the suite's site, the old
per-app sites only redirect, and the per-app staging sites exist for pull requests' tests, which
sign in with custom tokens and never show Google's prompt. Trying an app by hand on staging, with
Google, is done on the staging portal's site, `https://huishouden-staging.web.app/<app>/`; on a
per-app staging site the popup sign-in still works (Firebase Auth's list has it), One Tap and
Google API tokens do not.

The suite's site is `SUITE_SITE` from `./site` (today the project's default Hosting site), so
`signInOrigins(project, SUITE_SITE)` from `./oauth-origins` derives both entries. The production `smoke` job, the
staging job (allowed to fail: nothing automated needs it) and the bootstrap check exactly those and
say what to add; an origin a check reports missing is added in the console under Google Auth
Platform > Clients > "Web client (auto created by Google Service)".

Firebase Auth's authorized domains have no such limit, but the bootstrap still adds only what is
used: production gets nothing per app (a new app adds nothing), staging gets each app's staging site
(its pull requests sign in there) and `localhost` (local runs against staging). Anything else on the
list is printed as not needed; `bootstrap.sh --prune-domains` removes it.

## The suite's address

`SUITE_SITE` in `src/suite.ts` (re-exported by `./site`) is the one place the production address is set. Derived from it:

- the deploy target (`sharedSite`, `pwa-site assemble`, `pwa-site site`) and the reconcile run's
  live-site check;
- each app's link preview (`og:url`, `og:image`; `pwaApp({ base })` without `url`);
- the production asset CDN's `Access-Control-Allow-Origin` (`ASSET_CORS_ORIGINS`, "Asset CDN");
- the smoke tests' and PR screenshots' live URL (`pwa.yml` without `site-url`);
- absolute links built where there is no page (`SUITE_ORIGIN`, `suiteUrl(base, path)`: Playwright
  defaults, fallbacks in agenda and reminder code, tests);
- the sign-in checks (`pwa-oauth-origins`, `smoke`) and the bootstrap's authorized domains.

The Workers (`notify`'s `LINK_HOSTS`, `calendar` and `connector`'s `SITE_URL`/`ALLOWED_ORIGINS`) and
`VITE_FIREBASE_AUTH_DOMAIN` are deploy configuration, set outside the apps' code.

### Moving the suite

To serve the suite from another site of the same project (Hosting serves `/__/auth/*` on every
site, so sign-in moves with it):

1. Create the site; add `https://<new>.web.app` to the OAuth web client's Authorized JavaScript
   origins and `https://<new>.web.app/__/auth/handler` to its redirect URIs (console only), and
   `<new>.web.app` to Firebase Auth's authorized domains.
2. Change `SUITE_SITE` (the asset CDN's CORS origin follows it), release the kit, bump every app; each deploy then goes to the new site and
   the old one keeps its last build.
3. Point the Workers' site settings at it, and `VITE_FIREBASE_AUTH_DOMAIN` if sign-in should show
   the new host; rebuild.
4. Mark the portal's entry in `apps.json` `"redirect": true`: the portal's runs then redirect the
   former address to the new root, path and query kept, serving a retiring `sw.js` at `/` and at
   every app's path (`retiringWorkers`) so installed copies leave their caches.

The manifest `id` is relative to the origin, so browsers treat the new address as a new app:
reinstall, and re-enable notifications (push subscriptions are per origin).

## Old addresses

`huishouden-<app>.web.app` becomes a redirect: every path 301s to
`https://huishouden-piekstra.web.app/<app>/<path>`, query kept (deep links in agenda items,
notifications, bookmarks). One file is not redirected: `/sw.js` is a worker that unregisters
itself, clears its caches and reloads its pages, so an installed copy stops answering from its
precache and follows the redirect on its next launch. Firebase checks redirects before static
files, so the redirect's pattern spells out "every path but `/sw.js`" (RE2 has no lookahead).
`apps.json` marks an app `"redirect": true` once its path is live; the portal's runs deploy the
redirect sites (the reconcile run checks them each time and redeploys only when one is wrong).

Installed copies of the old sites open the new path with a browser bar (another origin's scope).
Reinstalling the portal once per device fixes that; the old icons can then be removed.

## Migration

1. Kit: `base`, `otherApps`, `appUrl`, scope-aware push worker and app bar, `./site` and
   `pwa-site`, `pwa.yml` `base` and `reconcile` inputs. Callers without `base` keep today's
   per-site deploys, so moving `v0` changes nothing for them.
2. Portal: `base: '/'`, assembles and deploys the combined site; reconcile by hand (`reconcile: true`). (Its own site
   is the combined one, so nothing changes for a visitor.)
3. Each app: `base: '/<app>/'`, publishes assets, deploys the combined site, smoke at `/<app>/`.
   Its old site is no longer deployed and keeps serving the last build until step 5.
4. Verify every path: sign-in popup, Firestore, Google tokens, push worker.
5. Portal: tiles become paths, `apps.json` marks the old sites `redirect`, the old sites redirect.
6. Registry, uptime checks, sign-in origins and authorized domains ("Sign-in origins") and docs
   follow the paths.
7. Asset CDN (kit 0.100; the upload the portal's alone since 0.104): the two Cloudflare secrets go
   in the portal's `production` environment ("Asset CDN", Token), no app repo holds them or
   passes them in `ci.yml`, and every app takes the kit bump; `HH_ASSET_CDN` stays unset. An app's
   deploy keeps the CDN for builds it already holds (`--cdn-held`); an app with a new build is
   served from the site until the portal's next deploy uploads it.
