# PWA standard

Every app built on pwa-kit follows this.
Each rule is here because skipping it broke something; the reason is given so the rule can be
judged rather than copied.

## Who it's for

**Built for any household, free.** Anyone can open an app, sign in with Google, create a household
and use everything without us setting anything up for them. The maintainers' own household is one
user of it (dogfooding), never a special case. So:

- **Self-serve only.** Every feature works from the app for a new household: no per-household
  Sheets, scripts, config files, IDs or console steps done by a maintainer.
- **No single-machine or single-account dependencies.** Nothing may need a particular laptop to be
  on, a maintainer's GitHub account or secrets, or their personal CLIs. Connectivity to outside
  services runs as the household's own Google account (in the browser, with permissions the member
  grants), or in shared infrastructure that serves every household the same way.
- **Free for households and for us.** Free tiers only (Firebase Spark, GitHub public repos, free
  APIs). A feature that needs a paid plan or a billing account is a decision for the user, raised
  with its cost, not a default.
- **Their data, their account.** Household data lives in the household's Firestore documents;
  external data is fetched with the member's own consent and never through maintainers' credentials.
- **Know the limits we accept by staying free**: no scheduled server code on Spark (sync runs when
  someone opens an app, and the shared tablet keeps one open; the one exception is the shared
  notification sender on Cloudflare's free plan, see Notifications); Google's restricted scopes (reading
  email) work unverified for up to 100 users with a warning screen. Firebase Hosting on Spark
  serves 10 GB a month for the whole suite and stops at the limit; no CI job opens production in a
  browser (docs/one-site.md "Bandwidth").

## Shape

- **One repo per app**. Its own CI, tests, staging runs and releases.
- **One Firebase project per family of apps** that share users and data, and **one site**: the
  portal at `/` of `<family>.web.app`, each app under its own path (`/pet/`), so the installed
  portal opens every app in one window and one sign-in covers all of them (see One site). Each app
  still has its own Firebase web app registration and its own Hosting site, which serves the
  redirect from its old address and, on staging, the app's pull requests.
  Unrelated or shareable projects get their own Firebase project.
- **Stack**: Vite + TypeScript, `vite-plugin-pwa` (Workbox), bun. React where the app has state;
  plain TS is fine for static pages like the portal.
- **Wire it up with `infra/bootstrap.sh <apps.conf>`**: add the repo to `APPS` and re-run. It creates
  the site and web app and sets the repo variables. Never hand-create deploy keys.

## PWA

- Manifest: `display: standalone`; `id`, `start_url` and `scope` the app's path (`/pet/`; the
  portal's `/`), icons at 192 and 512 plus a 512 maskable icon under it. Generate PNGs from one SVG
  (`bunx pwa-icons`).
- Use `pwaApp({ base: '/pet/' })` from `@huishouden/pwa-kit/vite`; `base` sets all of the above and
  Vite's `base`. Its worker installs new versions in the background and waits (`registerType:
  'prompt'`; see Updates) and it sets **`navigateFallbackDenylist`** with `/^\/__\//`. Firebase serves its sign-in popup at
  `/__/auth/handler`; without this the service worker answers it with the cached app and
  "Sign in with Google" opens the app instead of Google. The portal also passes `otherApps` (the
  paths in `apps.json`), so its worker never answers a navigation into an app with the portal.
- Hosting headers: each path's `sw.js`, `registerSW.js`, `index.html` and the manifest `no-cache`;
  `assets/` immutable for a year (the combined `firebase.json`, generated; see One site).
- Tablet first: test at 1280×800 landscape; tap targets at least 44 px.

## Updates

Apps redeploy often (every kit release redeploys them all), so a new version must never interrupt
anyone: no reload under a half-filled form, an open sheet or a screen someone is reading.

- **Never reload a page in use.** `pwaApp` builds a worker that installs a new version and waits.
  `startUpdates({ base: import.meta.env.BASE_URL })` from `./update` (once, in main.tsx, in
  production builds) registers it, checks hourly and on return after 15 minutes, and applies a
  waiting version only: **at launch**, before the first touch (a version that was already waiting);
  **when the page is hidden** and nothing would be lost (no open dialog or sheet, no typed text still
  in a field, no `holdUpdates()` / `useHoldUpdates`); or **when the person taps** the app bar's small
  Update button. Otherwise it applies once every window of the app has closed. Never
  `registerType: 'autoUpdate'` or a `virtual:pwa-register` call of your own.
- **A reload returns to the same place.** The tab, and the item it shows where that is cheap, live in
  the address (`?tab=care&pet=p1`): `useUrlTab` and `useUrlParam` from `./react/url-state`. A tab
  change pushes a history entry, so Back works; a refinement (the item shown) replaces it.
- **A lazily loaded file that is gone** (a newer deploy removed it) is tried twice (`retryImport`);
  then the Update button offers the new version. Nothing navigates away on its own; the asset CDN's
  fallback (`./asset-cdn`) acts only before the page has loaded.
- **Opening shows a stable frame.** Until the session is restored and the first data has arrived,
  the app shows its own frame and tabs over `ScreenSkeleton` (`./react/ui`): never the sign-in screen,
  an empty state or a half-drawn app that is then replaced.
- **Tests:** `./e2e-update` builds the app twice and serves the builds locally (`buildVersions`,
  `serveBuilds`); `expectUpdateWithoutReload` opens a deep screen with input on build A, deploys
  build B under it and checks the page did not reload, kept its screen and input, and applied B
  when hidden with nothing unsaved, back on the same screen. Each app's `e2e/updates.spec.ts` runs
  it, with a reload and Back test, in `e2e:emulator`.

## One site

All apps share one origin ([docs/one-site.md](docs/one-site.md) has the design and the reasons).

- **Paths**: `/` is the portal, `/<repo>/` each app. `apps.json` in the portal repo lists every app
  with its `path`; the portal's tiles, the site's routing and its headers come from it.
- **Links**: between apps, same-origin paths (`/`, `/pet/`, the portal's `/privacy`), never an
  absolute address, so staging links stay on staging. Anything stored or sent (agenda `url`,
  reminder `url`, invitations) uses `appUrl(import.meta.env.BASE_URL, …)` from `./site`: the
  page's origin plus the app's path. Inside an app, build paths from `import.meta.env.BASE_URL`;
  `location.pathname` includes the app's path.
- **Tests**: `BASE_URL` is the app's path (`https://<site>/pet/`), so specs navigate with relative
  paths (`./`, `?tab=care`); a leading `/` lands on the portal.
- **Storage**: every app shares `localStorage`, IndexedDB and Cache Storage. Prefix a new
  `localStorage` key with the app's short name (`pet-…`) unless sharing it is the point, and say
  so where it is defined. Shared on purpose: the Firebase Auth session (one sign-in), Firestore's
  cache (multi-tab, any app), the write outbox (`hh-outbox:`, replayed by whichever app opens
  next), Google API tokens (`hh-google-tokens`).
- **Deploys**: no repo deploys alone. `pwa.yml` with `base` publishes each build of `main` as the
  repo's `hosting` release asset and deploys the whole site from every app's latest asset; the
  each deploy rechecks for builds published meanwhile. A failed build never replaces an app's last good one.
- **Old addresses**: `<family>-<app>.web.app` 301s every path to the app's path, query kept, and
  serves a `/sw.js` that retires the old installed copy (`"redirect": true` in `apps.json`).

## Security headers

Every site sends these on its own pages (`templates/firebase.json`, values in
`@huishouden/pwa-kit/security-headers`):

| Header | Value | Stops |
|---|---|---|
| `X-Frame-Options` | `DENY` | another site framing the app (clickjacking) |
| `Content-Security-Policy` | `frame-ancestors 'none'; object-src 'none'; base-uri 'self'` | the same for current browsers; plugins; a `<base>` tag redirecting relative URLs |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | paths (record ids) leaking to other sites |
| `X-Content-Type-Options` | `nosniff` | a served file being run as another type |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | device features the app doesn't use |

- **Only on app paths.** The rule is `"regex": "^/(?:[^_].*|_[^_].*|_)?$"`, every path except
  Firebase's `/__/`: Google sign-in opens `/__/auth/handler` in a popup and frames `/__/auth/iframe`
  on the auth domain (the portal's site), so frame-denying those breaks sign-in. Never use
  `"source": "**"` for these headers.
- **Per app, the features it uses:** `camera=(self)` for an app that takes photos in the page
  (Pet's medicine labels, the contact screenshot reader), `geolocation=(self)` for one that asks
  where you are (Groceries' nearby stores, Tasks' nearby places). Microphone stays off everywhere.
- **Checked twice:** CI's `pwa-headers-check` (kit 0.43.0 and later) fails a `firebase.json`
  whose app paths lack a header or whose `/__/` paths would be frame-denied, and each app's smoke
  test calls `expectSecurityHeaders(request, '/', { camera, geolocation })` from `/e2e` against the
  live and staging sites, which also checks the site's `/__/auth/handler` is not frame-denied.
- **Sign-in on staging first:** a change to these headers goes through a staging deploy with
  `expectGoogleSignInPopup` (the real popup reaching accounts.google.com), since signed-in staging
  tests use custom tokens and never open the popup.

## Sign-in and data

- Firebase Auth with Google. `authDomain` is the project's `<project>.firebaseapp.com`:
  it is the only redirect URI the auto-created OAuth client allows. An app's own domain gives
  `Error 400: redirect_uri_mismatch` until its `/__/auth/handler` is added to that client.
- The OAuth consent screen is In production, External. Asking for sensitive scopes (Sheets,
  Drive) shows "unverified app" once per user and counts toward a lifetime cap of 100 users.
  Prefer designs that need no Google API scopes in the browser.
- Shared data lives in Firestore in the family's project. A project has exactly one rules file,
  so exactly one repo deploys it: a dedicated rules repo (for Huishouden, `huishouden/rules`),
  never an app's repo, so one app's failing build can't hold back everyone's rules. Apps send their
  rules blocks there, with emulator tests next to the others.
- Apps open Firestore with `initFirestore(app, { auth })` and write with `setDoc`, `updateDoc`,
  `deleteDoc`, `addDoc`, `writeBatch` and the field sentinels from `@huishouden/pwa-kit/firestore`,
  not `firebase/firestore`. A write reaches Firestore's offline cache a few milliseconds after the
  call returns; these also note it in localStorage at once, so an entry tapped in just before the
  app is closed or reloaded is written when it next opens instead of being lost. Writes stay
  fire-and-forget: the screen updates from the local cache, and errors go to a toast. CI's
  `pwa-write-check` fails app code that imports or re-exports a write function from `firebase/firestore`
  (or imports it whole, `* as`).
- People, accounts, card numbers and other personal facts are data, not code: keep them in the
  app's data store (a sheet tab, Firestore), never in the repo, including test fixtures (use
  made-up values). A leak scan can't recognise most of these, so this rule is the protection.
- Sample data should feel real: well-known national chains and services (a big grocery chain, a
  streaming service) make screenshots recognisable and are not sensitive. What stays invented is
  whatever could point at a real household: people's names, emails, addresses, account and card
  numbers, local or regional businesses, store numbers, and real amounts or dates copied from
  real records.

## Roles

Every member of a household has a role, set by an admin in the portal's household panel and
enforced by the rules, not just hidden in the apps (`@huishouden/pwa-kit/roles`, `huishouden/rules`
README "Roles"):

| | Admin | Member | Helper | Kid |
|---|---|---|---|---|
| Invite and remove people, set roles (never their own) | yes | | | |
| Settings: household name, food preferences, portal layout, an app's settings, lists, the meal plan, medicine courses | yes | yes | | |
| Read the everyday things, add their own, tick off anyone's | yes | yes | yes | yes |
| Change or delete what someone else added | yes | yes | | |
| Give medicine | yes | yes | if the course allows them | |
| Spending and Bills | yes | yes | | |
| Records marked private | yes | yes | | |

The creator is an admin; a new invitee is a member unless the admin picks another role. A helper
is a babysitter, a pet sitter or the shared wall tablet's account; a kid is a helper who never
gives medicine.

- **Hide, then explain.** Take `useRole(household, me)` once in the app's shell. Leave out the
  controls a role can't use (delete on someone else's item, settings, the private toggle) and, where
  a person would look for one, say why in one line with `RoleNote` (`refusal(action)`: "Only admins
  and members can change settings."). A refused write still shows that sentence, not a raw error.
- **Sign what you add.** Every record a helper or kid may add carries `by` (the adder's email) and
  keeps it on edits: that is what lets them change their own and nothing else. Ticking something
  off writes only the fields that tick it (`completed`, `done`, `lastDone`, `due`), never `by`.
- **Private records.** Contacts, appointments, agenda items and reminders take `private: true`
  ("Only admins and members", `PrivateCheckbox`). Write the flag on every save, `false` included:
  a record without it is private to helpers and kids. Their reads of those collections pass
  `restricted: isRestricted(role)` (`watchContacts`, `watchAgenda`, `syncAgenda`, `syncReminders`,
  ...) or add `where('private', '==', false)`, since the rules refuse a list that could include a
  private one. On an admin's or member's device, run `markUnflaggedOpen` on the app's appointments
  so older ones become visible to helpers. An appointment's agenda items and reminders take its flag.
- **Money.** Spending and Bills open to a one-line refusal for helpers and kids, and the portal
  hides their tiles. Their agenda items and reminders are always private (`MONEY_APPS`).
- **Medicine.** A course says who can give it (`givers`: all helpers, the default, or only
  `approvedHelpers`; `GiversField`). Check `mayGive(course, role, me)` before offering "Given".
- **Tests.** The rules repo tests every role against every collection. Each app's signed-in suite
  runs one flow as `test-helper@example.com` (a helper in the staging household): a refused action
  shows its sentence and a permitted one works.

## Languages

Every app is fully translated: English, Spanish and Dutch ([docs/i18n.md](docs/i18n.md) has the
step-by-step, the API and the glossary).

- **No English literal in UI code.** Every visible string, `aria-label` and toast goes through
  `t()` (`./i18n`, `useT()` from `./react/i18n`), with the app's catalogues in
  `src/locales/{en,es,nl}.json`. Sentences are whole messages with variables and plurals, never
  concatenated words: word order differs between the languages.
- **New UI text ships in every language** in the same PR: an English-only key fails
  `pwa-i18n-check` in CI, and the `cr` reviewer checks that the Spanish and Dutch read naturally and
  use the glossary's words (reviewer note: a PR that adds or changes visible text without updating
  `es.json` and `nl.json` is not ready).
- **One locale formats everything**: dates, times, numbers, money and distances only through the
  kit's formatters or `getLocale()`; never `toLocaleDateString(undefined, …)`, `'en-US'` or
  `navigator.language`. Money is in the household's currency.
- **Data stays as entered.** Names, notes and other household data are never translated; sample
  data may stay English.
- **Text other members read** (reminders, to-dos, agenda items) is built with `localizeReminders`,
  `localizeTodos` and `localizeAgenda`: the writer's words plus `texts` in the other languages its
  readers use (each member's stored language, `households/{id}.langs`; docs/i18n.md), never every
  language the suite speaks.
- **Tests**: each app's e2e has an `i18n.spec.ts` with `expectLocalized` for Spanish and Dutch;
  PRs that change UI show phone screenshots in each language.

## Shared code

- **Copy once, then extract.** When a second app needs code another app already has, it moves into
  the kit instead of being copied: time and due wording (`/time`), schedules (`/schedule`), money
  (`/money`), Google tokens (`/google-token`, `/gmail`), calendar import (`/calendar`,
  `/react/calendar`), contacts (`/contacts`, `/react/contacts`) and the React UI primitives
  (`/react/ui`, `/react/clock`) already have. Copies drift: before extraction four apps worded the
  same 60 days three ways.
- **Data actions are written once.** An app's actions build `Op` lists (`./store`) and run through
  one backend: `commitOps` to Firestore for a household, `useSampleStore` in memory for the
  signed-out sample, so the sample behaves exactly like the real app and a change can't be made in
  one and forgotten in the other. Each action that changes or removes something returns the `Undo`
  from `changes`, which the app's toast offers. Start-up is `initApp` (`./app`), logs read through
  `./log`, small charts are `QuantityChart` (`./react/chart`).
- **CI lists copies.** `pwa-reuse-check` (warnings in `pwa.yml`) names any app declaration that is a
  near copy of a kit export; import the kit's, or keep it with `// reuse-check:allow <reason>`.
- **The kit holds mechanism, the app holds policy.** Generic arithmetic, wording and components go
  in the kit; an app's own roles, search words, limits and labels are passed in as arguments.
- **Suggestions from Google services** (new calendar events, new Google Tasks) use `useSuggestions`
  (`./react/suggestions`): they look only with a token the device already has, never open Google's
  window, and say plainly that they stop an hour after the member last connected on that device.
- **Google API scopes go through `googleAccessToken`**, so a token is asked for once and reused for
  its hour across features, and a revoked one is forgotten on the 401. Tokens come from Google
  Identity Services' token client with the app's OAuth web client (`configureGoogleTokens` with
  `VITE_GOOGLE_CLIENT_ID` at startup), never from Firebase Auth: Firebase signs people in, and a
  popup re-sign-in for scopes fails whenever its sign-in backend does. Call it from a tap; code that
  runs when the app opens uses `cachedGoogleToken` and shows a button when there is none, so an
  app never opens Google's window by itself.

## Household tools

Everything a person can do with the household's data in an app, an assistant can do through the
connector and `hh data` can do on the command line: both run the kit's `household-tools` (`TOOLS`),
which act as the signed-in person under the same rules.

- **Ship the tool with the data.** A change that adds or changes user-editable data (a new
  collection, a new field people set, a new setting), or a household task someone asked an agent to
  do that no tool covers, ships with the matching household tool in the same change set, merged in
  this order: the kit's `src/household-tools/` (tool, tests, `COVERAGE`), then huishouden/rules when
  the rules change, then the connector (on the new kit, with an emulator test under those rules),
  then `hh` (its `hh data` command and README). It is fixed as found, the way a kit gap is: not left as
  a follow-up, and never done instead by writing to Firestore by hand.
- **The tool does what the app does.** The same fields, limits and ids the app writes; the roles the
  rules and the app allow, refused up front in the person's language; and whatever the app derives
  from the change (reminders, agenda items, to-dos) written alongside, so the app's next sync finds
  it unchanged.
- **Coverage is listed.** `COVERAGE` (`src/household-tools/coverage.ts`) names every collection
  under `households/{id}` the rules let someone write: the tools that cover it, `internal` (derived,
  or a device's or sign-in's plumbing) with why, or `gap` with what is missing. huishouden/rules'
  test fails when the rules allow writes to a collection `COVERAGE` doesn't list, and the kit's when
  a write tool isn't listed against its data, so a new collection can't arrive unnoticed.
  `coverageGaps()` is the open list.

## Notifications

Reminders reach people as push notifications through one shared sender,
[huishouden/notify](https://github.com/huishouden/notify): a Cloudflare Worker (free plan) that runs
every five minutes for every household in the project, the same way. No app sends anything itself
and no household sets anything up.

- **Reminders are data.** An app writes them to `households/{id}/reminders` with
  `@huishouden/pwa-kit/reminders` (`upsertReminder`, or `replaceReminders(ref, remindersForCourse(...))`
  for a medicine course, or `syncReminders(app, list)` with everything an app works out from its
  data) and deletes them when they no longer apply. Each has an https deep link
  back into the app. Ids are idempotent, so saving the same thing twice never doubles a reminder.
- **A reminder says what it is about.** Anything that can be done outside the app (the portal's
  To-do list, the connector, a calendar, another device) carries a `source` (`./reminder-source`):
  the record and when it is still due (a bill's `status` not paid, a dose record not yet written
  while its medicine still has reminders on; `any` with `group` for "this and that, or this and that").
  The sender checks it before sending and deletes the reminder unsent once it is done, without
  waiting for the app to be opened. A source names only the app's own records and done fields
  (`REMINDER_SOURCES`, mirrored by the rules' `hhSourceDoc`; add a collection in both first). This
  is the one place a server reads household records with a service account rather than as a
  member: huishouden/notify, document by document (`get`, never a list), only what
  `REMINDER_SOURCES` allows, and it counts a source only when its writer could read those records.
- **One subscription per device for the whole suite.** Every app shares the origin, so the
  portal's service worker (scope `/`) owns the push subscription, stored with `app: "suite"`. The
  sender sends a reminder from any app to it once; a tap opens the reminder's own app path. Each
  person opts in once per device, from the portal's Notifications panel (`DeviceNotifications`) or
  from any app's `NotificationsCard`, which calls `enablePush` from a tap. `enablePush` also
  deletes the member's documents for the device's older per-app subscriptions, and
  `upgradePush` (run by the card) does that without a prompt where notifications are already
  allowed, so a device never gets a reminder twice. A per-app subscription keeps receiving until
  its device upgrades. A suite subscription may carry `apps` (`PUSH_SUBSCRIPTION_FIELDS`): the
  silent move keeps the apps the device was for (a shared tablet that notified for Pet stays Pet),
  the sender sends only those apps' reminders to it, and a tap on the panel's switch (or "Get every
  app here") clears the limit. `PushSuiteUpgrade`, mounted once in the portal's signed-in shell,
  runs the move on open. Release order: rules accept `apps` and the sender filters on it before a
  kit release that writes it reaches the portal. Build with `pwaApp({ push: true })` (the portal's too) and the
  `VITE_VAPID_PUBLIC_KEY` repo variable (the bootstrap sets it when `apps.conf` has `VAPID_PUBLIC_KEY`).
- **One place to manage it.** The portal's Notifications panel: this device (on, off, a test
  notification) and `AppNotificationToggles`, one switch per app for the signed-in person
  (`notificationPrefs`, `setAppMuted`; no Bills or Health for helpers and kids, as in the apps).
  Each app's settings carries the compact `NotificationsCard` (status, the device switch, a
  "Manage in Huishouden" link to `/notifications`). An app that writes reminders must offer it.
- **Say why when it can't.** `pushSupport()` gives the reason and a sentence to show. iPhone and iPad
  get notifications only from an app added to the Home Screen, on iOS/iPadOS 16.4 or later; in a
  Safari tab the app explains how to add it rather than showing a button that does nothing.
- **Timing**: up to five minutes late; reminders more than 12 hours overdue (the sender was down)
  are dropped rather than sent. Anything that must not be missed also shows in the app itself.
- **Rules**: the `reminders` and `pushSubscriptions` blocks live in the project's rules file (fields
  match `REMINDER_FIELDS` and `PUSH_SUBSCRIPTION_FIELDS`), with the collection-group index on
  `reminders` (`sent`, `at`) the sender's query needs.

## Calendar suggestions

An assistant that writes to Google Calendar ("add a vet appointment for Biscuit Tuesday at 3") is a
way to add things to an app. Every app with Import from calendar also offers what is new there on
its own, with `useCalendarSuggestions` and `CalendarSuggestions` from `/react/calendar`:

- **Same words, same import**: pass the app's Import from calendar word list and its `isImported`
  check, and call the same handler Add uses in the import dialog. An event is offered until it is
  added or the member says Not this one (kept per member on the device).
- **Never asks**: it looks only with a calendar token already on the device (`cachedCalendarToken`),
  on open and on return to view at most every 30 minutes, from now to 60 days ahead. Tokens last
  an hour from the member's last calendar search or import; without one there is no card and no
  prompt. The calendar token is kept in localStorage for that hour (read-only scopes), so any script
  on the app's origin and anyone using the device before it ends can read the calendar; sign-out
  clears it. Keep the origin free of third-party scripts.
- **Placement**: mount the hook once in the app's shell; show the card at the top of the main
  screen, under the frame, only when there is something new. One line, calm; never a dialog.
- **Tests**: `stubCalendar(page, { events })` from `/e2e` (sample app, signed out) with the clock
  set to the sample's day.

## Agenda

The portal shows one household calendar and a Today view built from every app's dates, without
reading any app's own collections. Each app publishes its dated things to `households/{id}/agenda`
with `@huishouden/pwa-kit/agenda`; the portal only reads.

- **What to publish**: anything with a date someone in the household would want on a calendar or
  in Today: appointments, jobs and services coming due, renewals and expiries, unpaid bills,
  birthdays, medicine courses, feeds not given yet. One item per date, `kind` from the fixed list,
  an https deep link to the record, and `status` (`upcoming`, `overdue`, `done`) for things someone
  has to do. Leave out logs of what already happened (a feed given, a payment made): those stay in
  the app. Feeds and doses (`feeding`, `medicine`) are one item per occasion; one not done by the
  end of its day drops out of Today as missed rather than staying overdue.
- **When**: on save, `replaceAgenda(ref, items)` for the record (or `removeAgenda` when it is
  deleted); on open, `syncAgenda(app, items)` with everything the app works out, which repairs what
  another device or an older version left behind. Both write only what changed.
- **Window**: from 30 days ago to 180 days ahead, plus overdue items whatever their age. Repeating
  things publish their next date, not every future one. Keep `title` and `detail` short (120 and
  200 characters) and in the app's own words ("Change HVAC filter", "$84.20, autopay off").
- **Privacy**: admins and members read every item; helpers and kids (and the shared wall screen,
  if its account is a helper) read only items with `private: false`. An item from a private record
  is published `private: true`; Spending's and Bills' always are. Keep a private detail in the app.
- **Rules**: the `agenda` block in the project's rules file; fields match `AGENDA_FIELDS`, and
  `by` must be the signed-in member.

## To-dos

The portal's To-do tab lists every app's open, actionable things in one place, sorted by when each
was added, so the household can clear out old ones in any app without opening it. Each app
publishes its open items to `households/{id}/todos` with `@huishouden/pwa-kit/todos`; the portal
reads them and runs the actions the app wrote down.

- **What to publish**: things someone has to do or decide, one item per record: open to-dos and
  chores, jobs due or overdue, checklist items, reminders due, unpaid bills. Not appointments that
  simply happen, and not logs. A list that is all small things (groceries) publishes one summary line
  (`status: 'info'`, no actions) linking to the app. `createdAt` is when the record was added (what
  "Older than 30 days" filters on), `due` its due day if it has one, `owner` who added it.
- **Actions**: `done` and `cancel`, each a short label ("Done", "Mark paid", "Skip", "Pause"), the
  ops that do it in the app's own collections (`TODO_COLLECTIONS`; merge ops on the fields that
  change), and who may (`roles`, plus `owner: true` for helpers' and kids' own records, `emails` for
  named members): the same the app's rules allow, so the portal hides what a role can't do. Cancel
  is the app's own notion and stays visible in its history (a cancelled to-do, a paused job, a
  skipped checklist item, a dismissed reminder). Use placeholders for anything about the moment it
  runs (`'$today'`, `'$today+3m'`, `'$now'`, `'$me'`, and `{ $nextDue: { schedule, due } }` for a
  repeating job's next due date, `./schedule` `nextDueAfterDone` as of the tap), never a date worked
  out when publishing.
- **When**: `syncTodos(app, items)` on open and a few seconds after the data changes, alongside
  `syncAgenda`. A record done or cancelled anywhere drops out on the next sync; the portal removes
  the item itself when it runs an action, and Undo writes the records and the item back.
- **Privacy**: as the agenda: helpers and kids read only `private: false` items, Spending's and
  Bills' are always private.
- **Rules**: the `todos` block; fields match `TODO_FIELDS` and `TODO_ACTION_FIELDS`, `by` is the
  signed-in member. The rules can't check ops (no loops), so the portal refuses an action writing
  outside the app's collections (`todoOpsAllowed`), and every op is checked by the target
  collection's own rules as the member who taps it.

## For named people only

Some records are about one person's care, and nobody else in the household reads them: a medicine
is for that person, their carers and the household's admins. Their dated things and open actions
still belong on the portal's Today, Calendar and To-do, and their reminders still go out, but only to
those people. They go to the personal collections instead of the shared ones (`./audience`):

| Shared | For named people | Publish with |
|---|---|---|
| `agenda` | `personalAgenda` | `syncPersonalAgenda(db, id, app, items, { by })` |
| `todos` | `personalTodos` | `syncPersonalTodos(db, id, app, items, { by })` |
| `reminders` | `personalReminders` | `syncPersonalReminders(db, id, app, reminders, by)` |

- **Audience**: each item names `audience`, the lowercase emails of the members who may read it
  (`cleanAudience`). The rules let only those members read, write or delete it, and the writer must
  be one of them. Kids are never in it. A reminder's `recipients` are some of its audience.
- **Each device keeps its own share current**: a sync reads and writes only the items naming the
  signed-in member, so every allowed member's device repairs the same items and nobody else's
  touches them.
- **Readers**: the portal follows a member's personal items next to the shared ones
  (`watchAgenda(..., { me })`, `watchTodos(..., { me })`); the sender reads `personalReminders` too.
- **What they say**: a person's name and the kind of thing ("Medicine for Nan", "Appointment for
  Nan"), never what the record holds (a medicine's name, a visit's doctor): the portal may be on a
  wall tablet. The rest goes in `calendarDetail`, for the reader's own calendar when they turn on
  Health details. Notifications go to the recipients' own devices and may name it.
- **Never to analytics**: the app passes the names it holds to `setSensitiveWords` (`./observability`),
  which takes them out of everything sent to New Relic.
- **Rules**: the `personalAgenda`, `personalTodos` and `personalReminders` blocks; fields match
  `PERSONAL_AGENDA_FIELDS`, `PERSONAL_TODO_FIELDS` and `PERSONAL_REMINDER_FIELDS`.

## Food preferences

Meal suggestions in any app (Groceries' meal ideas, and whatever comes next) plan for the same people.
The portal's household panel edits one document, `households/{id}/settings/food`, with
`@huishouden/pwa-kit/food`; other apps only read it with `watchFood`.

- **People, not accounts**: every member is listed (`withMembers`), and people without an account
  (children, a regular guest) can be added. Each has diets from the fixed `DIETS` list, an `avoid`
  list of ingredients and a short note.
- **Constraints in words**: use `householdDietRules(food)` (and `pantryText`) in a prompt or next to
  a suggestion instead of wording diets per app, so GERD or pregnancy guidance reads the same
  everywhere. Allergies are strict; dislikes in `avoid` are preferences. Diets are rules or
  preferences per `DIET_STRICT` (`isStrict`, `GENTLE_DIETS`): GERD and low-sodium are preferences, so
  rank and label meals for them rather than filter; use `householdDietRules(food, { strictOnly: true })`
  for the rules and `householdDietPreferences(food)` for the rest.
- **Nobody named to a model**: a prompt for a model outside the household (Gemini's free tier may
  keep and review what it is sent) is built from `pseudonymousFood(food).food`: each person is
  "Person A", "Person B", … by their place in the list, with their diets, allergies and note but no
  name, id or email, and names and emails in notes replaced (single-letter initials stay; pass every household member, with
  their full profile name, as `others`: the list holds first names only). A note is free text: anything else in it reaches the model as written, so
  ask for food notes, not contact details. Checks and reasons shown run on the real list; text the
  model wrote goes through `restore` before anyone reads it.
- **Rules**: the `settings/food` case of the `settings` block checks the document's shape
  (`FOOD_FIELDS`, list sizes, the pantry, `by` the signed-in member). A request may evaluate only
  1000 expressions, too few to check every person's fields, so always write with `saveFood` (which
  clips each person to `FOOD_PERSON_FIELDS` and `FOOD_LIMITS`) and read with `watchFood`.

## Read budgets

Firestore's free plan has 50,000 document reads a day for the whole project: every household, app
and Worker, until midnight Pacific. Once they are gone every read fails, everywhere. On 2026-10-12
one calendar Worker round compared fresh lists with counts taken before an edit, went back a step
for ever and read about 39,000 documents in 19 minutes; the apps and notify failed for an hour.
Reads are therefore budgeted, tested and capped like money (docs/one-site.md "Budgets" for what is
billed and a household's day).

- **Every read path has a read-budget test.** Every Worker run type (calendar's checks, feed and
  sync rounds and alert inbox units; notify's run; each connector tool family) and every app's main
  screens and sync paths carry a test that counts the reads Firestore bills and fails past a
  ceiling: `expectReads(fn, { max })` from `@huishouden/pwa-kit/read-test`. REST code is counted
  from each response (`meter(fetch)`), SDK code from each result and snapshot
  (`readCounter().sdk(firebase/firestore)`), an app's screens in the browser with
  `expectPageReads(page, open, { max, min, label, settleMs, settleTimeoutMs })` from `./e2e` on its
  emulator build (the preset counts every `firebase/firestore` read in builds with
  `VITE_USE_EMULATORS=true` or `VITE_READ_METER=true`, from the shell or the mode's `.env` file;
  `e2e:emulator` runs them, not staging); a count still rising after `settleTimeoutMs` fails as
  `unsettled` (a listener in a loop). The emulator bills nothing and reports no counts, so the count is
  Firestore's billing rule applied to what came back (`billedReads`): one per document returned, at
  least one per query and aggregation, one per 1,000 entries an aggregation walks, a listener's
  whole result when it starts and one per changed document after. The ceiling is the expected
  count for the test's invented data, not a round number far above it.
- **A change that raises a budget says why in its PR**: which read was added, for what, and the
  new count. Lowering one needs no reason.
- **Jobs that read in steps get an interleaving test.** A job that reads, decides and reads again
  (a Worker round, a sync with a check before it, a multi-step import) is run with another member's
  write landing before each of its reads (`expectReads(fn, { max, beforeRead: writeBeforeEachRead(write) })`)
  and must finish within its budget. A step never compares what it just read with counts or
  snapshots captured earlier in the same job without refreshing them, and a state machine never
  returns to an earlier step without having made progress.
- **Workers run their reads under `ReadBudget`** (`@huishouden/pwa-kit/read-budget`): a cap per
  run, a share per Pacific day kept in a ledger (D1, or a SQLite Durable Object from
  `readLedgerObject`), a pause for every run when Firestore answers 429 `RESOURCE_EXHAUSTED`, and
  the run's reads (`summary()`) in its log line and heartbeat. `finish()` runs in a `finally` (or
  the run goes through `within(fn)`), so a run that throws is still counted. A cap reached answers like
  Firestore's own quota, so the code's quota handling covers it. Caps are `[vars]` read with
  `readCap`, so a typo fails loudly instead of turning a cap off.
- **The day is allocated.** The Workers' daily shares add up to well under the free 50,000, leaving
  the rest to the apps, which have no server-side cap:

  | Consumer | Variable (wrangler.toml) | Per day | Per run |
  |---|---|---|---|
  | Calendar, checks | `FIRESTORE_CHECK_READS` | 12,000 | 300 per check invocation |
  | Calendar, feed and sync rounds | `FIRESTORE_WORK_READS` | 6,000 | 2,500 per round (`ROUND_READS`) |
  | Calendar, Spending alert inboxes | `FIRESTORE_MAIL_READS` | 2,000 | 400 per unit |
  | Notify (queries included) | `FIRESTORE_NOTIFY_READS` | 4,000 | 400 per run |
  | Connector (each connection 1,000) | `FIRESTORE_CONNECTOR_READS` | 4,000 | 500 per tool call |
  | **Workers together** | | **28,000** | |
  | Apps (every household's devices) | | 22,000 | |

  Changing a share changes this table in the same PR; the Workers' sum stays at or under 30,000.
  Staging has its own 50,000, mostly for the apps' test runs: its Worker shares are smaller.
- **Alarms come early.** Cloud Monitoring emails at 5,000 billed reads in an hour (a runaway at
  the incident's rate trips it within about three minutes) and at 30,000 in 24 hours
  (`infra/read-alert.sh`, `hh ops read-alerts`).

## Observability

The maintainers hear about a failure from the reports, not from a household. Every app sends
errors, speed and anonymous usage counts to one New Relic account on its free tier
(`@huishouden/pwa-kit/observability`; setup, alerts and dashboard in
[docs/observability.md](docs/observability.md)).

- **Start it first.** `startObservability({ app: 'baby', env: import.meta.env })` in `firebase.ts`
  (or `main.tsx`) before rendering (`initApp` does it). On the suite's site it reads the app's entry
  in `/hh-observability.json`, which every production deploy writes from the portal's monitoring
  workflow; a build served elsewhere reads `VITE_NEWRELIC_ACCOUNT_ID`, `VITE_NEWRELIC_APP_ID` and
  `VITE_NEWRELIC_BROWSER_KEY` (repo variables). All public by design: the browser key can only send.
  Local builds, previews, staging and automated browsers send nothing.
- **Errors and performance are always on.** Uncaught errors and Core Web Vitals are automatic;
  `readError` and `googleFetch` report the failures they word or throw (not offline or an expired
  token); anything else handled goes through `reportError(e, { where: 'save feed' })`.
- **Usage is counted per visit, anonymously.** `track('log feed', { kind: 'bottle' })` for a feature
  used and `trackView(tab)` for a screen; action names and small enums only. The agent runs with
  session tracking off: no cookie and no localStorage id, so nothing links one visit to the next and
  no consent banner is needed. Households are counted by a hash of the id (`saveMyProfile` sets it).
  When the browser sends Global Privacy Control (or Do Not Track), usage counts and the household
  hash are skipped silently; errors and performance still go. There is no opt-out screen.
- **No personal data leaves the device.** No names, emails, household ids, entries, free text or
  query strings: messages, stacks and URLs pass through `redact` and the agent's obfuscation rules.
  An app holding names that could end up in an error (Health's medicines and people) registers them
  with `setSensitiveWords(app, words)`, and every report has them replaced with `[redacted]`.
  Geography is what New Relic derives from the network address (country, region, city, the
  network's coordinates), kept 8 days with the rest of the Browser data; the free plan can't drop the
  city (docs/observability.md "Geography"). Never the device's location. No session replay, traces,
  AJAX URLs or click tracking.
- **Say so.** The portal's `/privacy` page (linked from every app's account menu as "Privacy" and
  from the portal's footer) says in plain words what is collected, what isn't and who provides it;
  each app's README has a Privacy section pointing to it.
- **Free.** 100 GB a month of ingest (the apps use megabytes), one full user, unlimited ping
  monitors, alerts and dashboards. A feature that would need more is a decision for the user.

## CI/CD

Every app's `.github/workflows/ci.yml` calls `pwa-kit/.github/workflows/pwa.yml@v0`
(`templates/ci.yml`), which runs these jobs on `ubuntu-latest`:

| Job | Runs on | Does |
|---|---|---|
| `leak-scan` | push to `main` | gitleaks on the added commits (`actions/leak-scan`) |
| `build` | push to `main` | the next version from the commit titles (see Versions; embedded as `VITE_APP_VERSION`), `bun install --frozen-lockfile`, `pwa-bandwidth-check`, lint (`tsc --noEmit`), `pwa-design-check`, `pwa-write-check`, `pwa-headers-check`, unit tests, build |
| `release` | push to `main`, after `build` and `leak-scan` | the version's annotated tag and its GitHub release with generated notes, when the commit titles since the last tag call for one (nothing is committed; see Versions) |
| `publish` | push to `main`, with `base` | The build (and a staging build) as `site.tar.gz` / `site-staging.tar.gz` on the repo's `hosting` pre-release |
| `deploy` | push to `main`; a manual run with `reconcile` | Keyless via Workload Identity Federation for Firebase; the Cloudflare token only in the portal's `production` environment (of the PWA repos; the Workers hold their own for `wrangler deploy`); with `base`, `pwa-site assemble` (every app's latest asset under its path, the combined `firebase.json`); in an app (no token) the CDN only for builds it already holds (`--cdn-held`, the rest from the site until the portal's next deploy); in the portal the assets to the asset CDN (`pwa-site cdn`, `wrangler deploy`, then `pwa-site cdn-check`, which uploads again, up to three times, if another repo's upload replaced them; docs/one-site.md "Asset CDN") and then `firebase deploy`, `cdn-check` once more after the pages are live, rechecked for builds published meanwhile; without, `firebase deploy --only hosting:<target>`. |
| `smoke` | after `deploy` | One HTTP check of the live app path (index.html, a hashed asset on the CDN with its CORS and caching headers and the site's own copy, the manifest, `sw.js`, their caching and compression); no browser (docs/one-site.md "Bandwidth") |
| `staging-build`, `staging-site`, `staging` | manual runs with `staging-ref` | Build against the staging project (no credentials); assemble the suite, serving its own assets (no job that builds a ref holds the Cloudflare token; nothing from the ref runs); deploy to the app's staging site, `e2e` and `e2e:signed-in` there in households of the run's own, then remove them (see Staging) |

- Repo variables (not secrets; the Firebase web config is public by design): `GCP_WIF_PROVIDER`,
  `GCP_DEPLOY_SA`, `VITE_FIREBASE_*` (the bootstrap sets them). No app repo holds a Cloudflare
  token: `CLOUDFLARE_API_TOKEN` (Workers Scripts edit) and `CLOUDFLARE_ACCOUNT_ID` are secrets of the
  portal's `production` environment (deployment branches: `main` only), the one PWA deploy that uploads
  to the asset CDN (the Workers repos, notify, connector and calendar, hold the same two in their own
  `production` environments for `wrangler deploy`); apps' deploys keep the CDN only for builds it already holds (docs/one-site.md
  "Asset CDN"). The bootstrap creates the `production` environment (main only) of every repo and places
  the Cloudflare token and account id in the portal's and the Workers' with `hh ops secret push cloudflare`,
  and the portal's repo secret `NEW_RELIC_API_KEY` (monitoring) with `hh ops secret push newrelic-user`,
  all from the keychain (`hh ops secret store <name>` puts them there; never paste one in chat). Callers pass no secrets (never `inherit`, which would hand pwa.yml every repo secret);
  the variable `HH_ASSET_CDN=off` (repo or organization) turns the CDN off. Apps on the suite's site need no
  `VITE_NEWRELIC_*`: the deploy serves their New Relic settings (see Observability).
- Deploy waits on `leak-scan` and `build`. `concurrency: cancel-in-progress` on every workflow.
- No schedules: nothing hosted runs on a timer for the process (no reconcile, no sweep, no digest,
  no Renovate). The Workers' own product schedules (notifications, calendar sync) are product, not
  process.
- Apps' and Workers' pull requests run no jobs, by decision (the kit's own `ci.yml` still checks its PRs: it publishes nothing to Hosting): hosted CI runs only on `main` (and on manual `staging-ref`
  runs), where a failing build or unit test stops the deploy. The PR's
  author verifies it before it is ready (see Pull requests); `leak-scan` on `main` still scans
  every push. No browser runs against production (docs/one-site.md "Bandwidth": Hosting on Spark
  serves 10 GB a month for the whole suite; `pwa-bandwidth-check` fails a workflow step that would).
- Real secrets (test account passwords, API tokens) go in GitHub Actions secrets and are read
  only in the jobs that need them. Never in argv, logs, or the repo.

## Pull requests

The author owns everything before `main`; nothing hosted runs on a PR. The `hh` CLI
(huishouden/cli; it updates itself) does each step, and the `huishouden`
Claude Code plugin (huishouden/claude-plugins, skill `pr-lifecycle`) tells agents to:

1. **Open it as a draft**: `gh pr create --draft`.
2. **Review while draft**: `hh dev review` runs the local `cr` reviewer (org reviewers from
   huishouden/cr-reviewers), one review at a time on a machine; address findings and resolve the
   threads. Bar: no Blocking or Major finding left.
3. **Verify**: `hh dev verify` (build, unit tests, the emulator tests, screenshots on a local
   preview) or `hh dev evidence` (the branch deployed to the app's staging site, the browser tests
   there, phone and tablet screenshots in light and dark). `hh dev evidence` picks staging when the
   change touches rules, Workers, sign-in, Google or notifications, local otherwise
   (`--staging`/`--local` override), and posts or updates one PR comment with the results and
   images for the head commit. Never production.
4. **Ready**: `hh dev ready` checks the review bar and evidence green for the head commit, then
   runs `gh pr ready`; it refuses otherwise. If the kit is behind it first commits `chore: kit
   vX.Y.Z` on the branch (pin, `bun.lock`, workflow refs); a review or evidence of an earlier
   commit stands when only the kit moved since.
5. **Merge** (squash; the PR title is a Conventional Commit): `main` builds, tests, releases and
   deploys. There is no version or CHANGELOG in a PR.

## Versions

Versions are made by CI on merge to `main`, never by a commit. The next semver comes from the
Conventional Commit titles since the last `v*` tag: `feat` is minor, `fix`, `perf` and `refactor`
patch, `!` or `BREAKING CHANGE:` major (minor before 1.0); `chore`, `docs`, `test`, `ci`, `build`
and `style` alone release nothing. CI creates the annotated tag and a GitHub release with generated
notes; packages that ship built code (the kit, `hh`) attach their tarball
(`pwa-kit-X.Y.Z.tgz`, built in CI: `dist/` is not in git). `package.json` stays `0.0.0` and there is
no CHANGELOG.md. The Workers and the rules repo call `tag-release.yml` (after their tests, before
their deploy); apps get the same from `pwa.yml`. Apps embed the tag and commit in the build (`VITE_APP_VERSION`, `VITE_BUILD_SHA`:
the About screen and New Relic). Release-please and Renovate are retired.

**The kit is current when you touch a repo**: `hh dev verify|evidence|review|ready` commit
`chore: kit vX.Y.Z` (the pin as the release tarball URL, `bun.lock`, the exact workflow refs) on the
branch when it is behind; `hh dev bump-kit` does it by hand. Nothing bumps
dependencies on a schedule.

### Supply chain

Apps install the kit from the release tarball that the kit's own CI builds from a tagged commit.
Only accounts with write access to `huishouden/pwa-kit` can publish or replace a release asset,
which is the same trust boundary as the source itself. Bun records no integrity hash for a URL
tarball in `bun.lock`; that is accepted by policy, not a gap to close with a checksum. Third-party
actions are pinned by commit SHA; the kit's own reusable workflow and actions (`@v0`) sit inside the
same write-access boundary.

## Staging

Risky changes are tried live, signed in, before they reach a household. Staging is a second
Firebase project, `huishouden-staging` (Spark, free), with its own Firestore, rules and Auth, so
nothing deployed or tested there can read or write real household data.

- **Sites**: each app has `huishouden-staging-<app>.web.app`; the portal is
  `huishouden-staging.web.app`. A staging deploy (by the PR's author, or a manual `staging-ref` run) puts the whole suite there, as production is laid out: its
  own build under its path, every other app's latest staging build (`site-staging.tar.gz`) under
  theirs, so `https://huishouden-staging-pet.web.app/pet/` is the PR and `/` its portal. One site
  per app, so two repos' PRs never overwrite each other; a PR deploy replaces the app's previous
  one, and the PR comment says which commit is there.
- **When it deploys**: when the PR's author deploys it, from their machine, before marking the PR
  ready, or with a manual run of the app's `ci` workflow given `staging-ref` (a branch, tag or SHA),
  which deploys that ref to staging instead of production. Pull requests trigger no deploy. Main
  deploys to production only.
- **What runs there**: one read to check the day's quota is not used up, the build with the
  `STAGING_VITE_FIREBASE_*` variables (`staging-build`, no credentials), the suite assembled and
  serving its own assets (`staging-site`: no Cloudflare token reaches a job that builds a ref, and
  nothing from the ref runs; docs/one-site.md "Asset CDN"), the deploy, then `e2e` and `e2e:signed-in` against the app's
  path on the staging site, then the removal of the run's test data (`pwa-staging cleanup`). One
  staging run per app at a time (it tests the build on the app's one site).
- **Quota**: staging is on Firebase's free plan: 50,000 document reads, 20,000 writes and 20,000
  deletes a day for every app's runs together, reset at midnight Pacific (07:00 UTC in summer,
  08:00 in winter). When they are used up the job fails at its first step with "staging quota
  exceeded — rerun after 07:00 UTC", and says so again after failing tests. A run reads what its
  pages load, so: only what it seeded and wrote (its own households); seed in one commit (`docs`);
  check a write with one document (`hh.get(path)`), never by listing a collection; reuse one
  signed-in context per person per spec file (`hh.open`), whose pages close after each test.
- **Test households**: every run has its own, never shared: `useTestHousehold(test)` from
  `@huishouden/pwa-kit/e2e` gives the spec file `e2e-<repo>-<run id>-<attempt>-<spec>` with an
  admin, a member, a helper and a kid (`hh.users.helper.email`, `<household>-helper@example.com`,
  emails verified, invented), seeded in the file's `beforeAll` with any app data it needs (`docs`, one
  commit), and removed after the run with every household its people belong to. A Health carer is
  set in Health by the spec (the helper, say), like any app data. `hh ops staging-cleanup`
  (also run after each `hh dev evidence --staging`) removes what a cancelled run left once it is a
  day old. Nothing outlives its run,
  so a test may count on an empty household.
- **From your own machine**: `bunx pwa-staging run -- bun run e2e:signed-in` (with `BASE_URL` set to
  the staging site under test) runs the same specs against staging outside CI: a run id of its own
  (`e2e-local-<you>-<time>`), the staging service account's token through `gcloud` impersonation
  (Service Account Token Creator on it; or `HH_STAGING_ACCESS_TOKEN`), the quota check, the
  command, then the cleanup. Nothing in the specs or the kit depends on CI. It stops first, before a
  token is minted, when `VITE_FIREBASE_PROJECT_ID` (bun loads `.env.local` into the process) or
  `BASE_URL` names production.
- **Signing in**: `hh.signIn(page, 'helper')` (or `signInTestUser(page, { as, household })`) mints a
  custom token with the staging deploy account (IAM `signJwt`, keyless), runs `signInWithCustomToken`
  on the site's own origin and opens the app signed in. It throws if the build's or the site's
  Firebase config names any project but `huishouden-staging` (or neither names one), on the
  emulators too if the build's project or `BASE_URL` is production (`assertNotProduction`,
  `assertNotProductionUrl`, before the page is touched), and only the
  staging account can sign the token, so it cannot sign anyone in to production. `useTestHousehold`
  skips the file where neither staging credentials nor the emulators are there.
- **Emulators first**: the same specs run on the Auth and Firestore emulators with the household's
  real rules on the author's machine before the PR is ready (`HH_E2E_TARGET=emulator`; `initApp` connects to them in a
  build with `VITE_USE_EMULATORS=true`; ports 9099 and 8080 unless `VITE_EMULATOR_AUTH_PORT`/`VITE_EMULATOR_FIRESTORE_PORT` and `HH_EMULATOR_AUTH_PORT`/`HH_EMULATOR_FIRESTORE_PORT` say otherwise, so runs side by side don't collide), free and without a quota. An app with an `e2e:emulator`
  script (`playwright test e2e/signed-in.spec.ts --grep-invert @staging`) runs there everything
  but the tests tagged `@staging`, and staging runs only those: flows through another app on the
  site (the portal's To-do list, `runPortalTodo`), the Workers (calendar feed, connector), and the
  one-site sign-in. Tag one key flow `@smoke` too: a PR that only moves the kit's version runs just
  the `@smoke` tests on staging.
- **Credentials**: Workload Identity Federation to the staging project only (`STAGING_GCP_*`); its
  provider accepts any branch of the owner's repos, but only jobs of the kit's `pwa.yml` at a
  release tag or of the rules repo's workflows. Its deploy account may deploy Hosting and rules,
  write Firestore, manage Auth users and sign its own tokens. Production's provider still accepts
  `main` only. There is no service-account key anywhere.
- **Rules**: `huishouden/rules` runs the emulator tests, then deploys to staging on every same-repo
  PR and on `main`, and to production on `main`. Staging carries whichever rules were deployed last.
- **By hand**: sign in with Google on the staging portal's site,
  `https://huishouden-staging.web.app/<app>/`, to click through anything; a person starts with no
  household there and creates one on the staging portal. It is the only staging origin on the OAuth
  client (Google allows 10; docs/one-site.md "Sign-in origins"), so One Tap and Google API tokens
  fail on the per-app staging sites. Flows that need Google's consent
  for an API (Gmail, Calendar, Contacts) stay manual: test users have no Google account, and the
  automated suites stub those APIs (`stubGoogleTokens`, `page.route`).
- **Not on staging**: push notifications (the sender reads production only) and Apps Script.
- **Setup**: `infra/bootstrap.sh --staging <apps.conf>` (with `STAGING_PROJECT` in the conf)
  creates the sites, web apps, Firestore, authorized domains, WIF and the `STAGING_*` variables,
  and checks the OAuth client's origins.
  Until those variables exist the staging jobs skip, so apps can adopt this kit before staging does.

## Tests

- **Unit tests** (`bun test`) for parsing and money logic, with inputs and expected outputs in
  fixture files (`__fixtures__/`, `fixtures/`), scrubbed of real names, emails and card digits.
- **Smoke tests** (`bun run e2e`, Playwright, headless Chromium) against staging or a local preview, never production (CI/CD; docs/one-site.md "Bandwidth").
  Minimum set, from `@huishouden/pwa-kit/e2e`:
  1. Loads with no runtime errors.
  2. Installable: manifest has a 512 icon, every icon URL loads, a service worker controls the
     page after one reload.
  3. Sign-in popup lands on accounts.google.com with a `/__/auth/handler` redirect and no
     `redirect_uri_mismatch`, run on the second load (under the service worker).
  4. Security headers on the app's pages and none that frame-deny `/__/auth/handler`
     (`expectSecurityHeaders`).
  5. Signed out, the "Sample data" banner is one line on a 390px phone (`expectCompactSampleBanner`).
  6. An app with section tabs shows them as the bottom bar on a 390px phone and in the app bar on a
     tablet (`expectBottomNav`).
- **Signed-in tests** (`e2e/signed-in.spec.ts`; `bun run e2e:emulator` on the emulators,
  `bun run e2e:signed-in` on staging) run as the invented people of a household of the run's own
  (`useTestHousehold`), signed in with Firebase custom tokens, never a Google account: Google blocks
  scripted sign-in to real accounts, and neither target is near a real household. Cover the app's
  key flows end to end against the real rules; tag `@staging` only what needs the real site or a
  Worker (see Staging).

## License

- Every repo is source available under PolyForm Shield 1.0.0: `LICENSE` is the kit's `LICENSE`
  byte for byte (the official text from polyformproject.org and the line
  `Required Notice: Copyright (c) 2026 Caleb Piekstra (https://github.com/huishouden)`), and
  `package.json` says `"license": "PolyForm-Shield-1.0.0"` and `"private": true` (nothing is
  published to npm; the kit is installed from its release tarball, `pwa-kit-X.Y.Z.tgz`; git tags through v0.105.0).
- The README ends with a License section: the terms in one sentence, and that the Huishouden name
  and logo are the project's brand.
- CI checks both: `pwa.yml` runs `actions/license-check` in its leak-scan job; the Workers and the
  rules repo run `huishouden/pwa-kit/actions/license-check@v0` in theirs.
- Third-party code keeps its own license: a copied file keeps its header, dependencies keep theirs.

## Leaks

- The scan uses `actions/leak-scan/gitleaks.toml` (gitleaks defaults plus a personal-mailbox
  pattern) unless the repo has its own `.gitleaks.toml`. Rules describe patterns, never the
  values to look for: a list of the real addresses or numbers you want kept out is itself a leak.
- Allowlist by path or rule only, with the reason in the entry. Prefer removing the file.
- Enable the pre-commit hook (`templates/githooks/pre-commit`, `git config core.hooksPath .githooks`)
  so a leak is stopped before it is a commit. It fails closed: without gitleaks or a rules file
  the commit stops. `LEAK_SCAN_SKIP=1` skips it on purpose, and CI still scans the push. In a
  public repo a pushed branch is already public, so CI only catches what the hook missed.
- Public repos: GitHub secret scanning and push protection on.
- The scan covers the commits each PR or push adds. History before the scan existed is audited
  once, at publication, with a fresh-history publish if needed.

## Apps Script

- Script source lives in the app repo (`apps-script/`), deployed with `clasp`
  (a `script:push` script that runs its tests first). Never edit only in the browser editor.
