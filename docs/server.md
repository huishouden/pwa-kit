# Acting as a person from a server

Some Huishouden services run on a server rather than in the browser. Two examples are
huishouden/connector (the remote MCP server people add to their AI assistant) and a calendar feed.
These services act **as the signed-in person**. The household's Firestore rules decide everything
they read and write, exactly as in the apps. They need no service account, no OAuth client and no
console step.

Every module below is server-safe. It imports no package, no Firebase SDK and no DOM, and
`test/server-safe.test.ts` keeps it that way. They run in Cloudflare Workers, Bun and Node.

| Module | What it does |
|---|---|
| `@huishouden/pwa-kit/signin-handoff` | Gets the person's Firebase refresh token from the portal's `/connect` page, where they sign in as in every app. Provides `connectUrl`, `parseConnectParams`, `HandoffRequest` / `isHandoffRequest`, `storeHandoff` and `takeHandoff`, plus the paths `CONNECT_PATH`, `HANDOFF_PATH` and `CALLBACK_PATH`. For the `hh` command line: `cliConnectUrl`, `isLoopbackRedirect`, `pkceChallenge`, `CliHandoffRequest`, `storeCliHandoff` and `takeCliHandoff`, with `CLI_HANDOFF_PATH` and `CLI_TOKEN_PATH`. |
| `@huishouden/pwa-kit/firebase-auth-rest` | Exchanges a refresh token for an ID token and says who it is: `exchangeRefreshToken(options, refreshToken)`. `verifyIdToken(options, idToken)` checks a token the portal sends (through Firebase Auth's `accounts:lookup`). `IdTokenCache` keeps a token per isolate until 5 minutes before it expires. `FirebaseAuthError.kind` is `revoked`, `unverified` or `unavailable`. |
| `@huishouden/pwa-kit/firestore-rest` | `new FirestoreRest({ projectId, token })` sends every call with the person's ID token. `get(path)` returns null when the document is missing. `query(parent, collection, { where, orderBy, limit })` reads documents; `aggregate(parent, collection, { where }, ['updatedAt'])` counts them and sums fields in one request (one read per 1000 index entries), a cheap "did anything change" check. `commit(writes)` is atomic. A write is `set`, `merge` (leaf paths, like the SDK's `merge: true`), `create` (must not exist yet, for idempotency keys) or `delete`. `Increment` is the SDK's `increment()`; `FieldDelete` in a merge removes the field, as `deleteField()`. Whole numbers are written as integers. `FirestoreError.code` is `permission-denied`, `not-found` and so on. |
| `@huishouden/pwa-kit/read-budget` | A Worker's Firestore reads, counted and capped (STANDARD.md "Read budgets"). `new ReadBudget({ run, daily: [{ name, cap }], ledger })`: `begin()` says whether a run may start (not while paused, not with a share spent), `fetch(inner)` is the fetch to give the Firestore client (counts each response with `billedReads`, refuses past a cap with Firestore's own 429 shape, pauses every run on a real 429), `finish()` adds the run to the day (in a `finally`, or run the work in `within(fn)`), `summary()` is for the log line and heartbeat (with `ledger: 'failed'` when the day's count couldn't be kept). A refusal is a `FirestoreError` with code `resource-exhausted` and `budgetScope` set (`budgetScopeOf(e)`). Ledgers: `d1Ledger(DB)`, `sqlLedger(sql)` / `readLedgerObject(DurableObject)`, `memoryLedger()`. Also `quotaDay`, `untilNextQuotaDay`, `readCap`, `budgetScopeOf`. |
| `@huishouden/pwa-kit/read-test` | Read-budget and interleaving tests: `expectReads((meter) => run({ fetch: meter(fetch) }), { max })` fails with the count by kind past `max`; `readCounter().sdk(firebaseFirestoreModule)` counts the SDK's reads (with `mock.module` in bun); `beforeRead: writeBeforeEachRead(write)` lands a write before each read. In the browser, a build with `VITE_USE_EMULATORS=true` or `VITE_READ_METER=true` counts every `firebase/firestore` read (the preset's `readMeter`, `./read-meter-browser`), and `expectPageReads(page, open, { max, min, label, settleMs, settleTimeoutMs })` from `./e2e` checks a screen's budget (and fails a count that never settles). A hook's own reads and writes use `raw.fetch`, the uncounted fetch. |
| `@huishouden/pwa-kit/local-clock` | `new LocalClock(timeZone)` reads days in the person's time zone on a UTC server. `local(t)` moves an absolute time into a frame whose UTC fields show the person's wall clock. The kit's day and dose logic (`./time`, `./dose`, `./agenda-core`, `./todo-core`) then answers exactly as on their phone. `utc()` goes back, `today()`, `parse('2031-01-05T08:00')`, `isoLocal(t)`. |

The data contracts come from the cores: `./todo-core`, `./agenda-core`, `./contact-core`,
`./role-core`, plus `./dose`, `./schedule`, `./time`, `./i18n` and `./money`.
`todoActionOps` and `planTodo` apply a to-do's Done or Cancel the way the portal does.

## Signing in

```ts
import { connectUrl, isHandoffRequest, storeHandoff, takeHandoff, HANDOFF_PATH, CALLBACK_PATH } from '@huishouden/pwa-kit/signin-handoff';
import { exchangeRefreshToken } from '@huishouden/pwa-kit/firebase-auth-rest';

const auth = { projectId: env.FIREBASE_PROJECT_ID, apiKey: env.FIREBASE_API_KEY };

// 1. Send the browser to the portal, with a state bound to this browser (a SameSite=Lax cookie).
return Response.redirect(connectUrl(env.SITE_URL, { service: origin, state, client: 'Calendar feed', purpose: 'calendar' }));

// 2. POST HANDOFF_PATH, from the portal (CORS: the site's origin only).
const body = await request.json();
if (!isHandoffRequest(body)) return new Response(null, { status: 400 });
const who = await exchangeRefreshToken(auth, body.refreshToken); // throws unless valid, verified, this project
const code = await storeHandoff(env.KV, { ...body, uid: who.uid, email: who.email });
return Response.json({ code });

// 3. GET CALLBACK_PATH?state&code, a top-level navigation from the portal: check the cookie's state.
const handoff = await takeHandoff<HandoffRequest & { uid: string; email: string }>(env.KV, code, stateFromCookie);
// Keep handoff.refreshToken encrypted (workers-oauth-provider's props do), keyed by your grant.
```

The portal posts only to services named in its `CONNECT_SERVICES`. A new service is added there,
with its production and staging origins.

## Signing in from a command line

`hh login` (huishouden/cli) has no cookie to bind the hand-off to, so it uses a PKCE proof key
(RFC 7636), as native OAuth apps do, and a loopback listener:

| Step | Who | What |
|---|---|---|
| 1 | `hh` | Listens on `127.0.0.1` (or `[::1]`) on a random port; makes a random `state` and verifier; opens `cliConnectUrl(site, { redirect, state, codeChallenge })`: `/connect?service=hh&redirect=http://127.0.0.1:<port>/callback&state=…&code_challenge=…&code_challenge_method=S256` |
| 2 | portal | `parseConnectParams` accepts only `isLoopbackRedirect`: exactly `http://127.0.0.1:<1024-65535>/callback` or `http://[::1]:<port>/callback`. Never `localhost`, which a hosts file or DNS can point anywhere. The page says "Sign in to the hh command-line tool on this computer". On Allow it posts a `CliHandoffRequest` (state, challenge, redirect, refresh token) to the connector's `CLI_HANDOFF_PATH` |
| 3 | connector | Checks the refresh token, then `storeCliHandoff`: two minutes in KV under a one-time code, sealed with a key only the code derives, bound to the state, the challenge and the redirect |
| 4 | portal | Sends the browser to `${redirect}?state=…&code=…`. The refresh token is never in a URL |
| 5 | `hh` | Checks the state and posts `{ code, state, code_verifier, redirect_uri }` to `CLI_TOKEN_PATH`. `takeCliHandoff` uses the code up on the first attempt, so a replayed code, an expired one, another state or redirect, or the wrong verifier gets nothing |

## The household's tools

`@huishouden/pwa-kit/household-tools` holds every tool the connector offers an assistant and
`hh data` runs on the command line: `today`, `todos`, `groceries_add`, `health_log_dose` and the
rest. Both call this one implementation, so they can't drift. It needs `zod`, a peer dependency, for
the tools' inputs; otherwise it is server-safe like the modules above.

```ts
import { Session, TOOLS, checkArgs, runTool, toolNamed } from '@huishouden/pwa-kit/household-tools';

const session = new Session({ uid, email, connectionId, via: 'assistant' }, db, env.SITE_URL);
const tool = toolNamed('groceries_add')!;
const checked = checkArgs(tool, { name: 'Oat milk' }); // or the MCP server's own validation
if (checked.ok) {
  const { result } = await runTool(session, tool, checked.args, { allow: rateLimit });
  // result.text: short, in the person's language, with links; result.data: the same as data.
}
```

`via: 'assistant'` marks what the session writes as the assistant's (the rules accept that value or
none, and the apps show it). The command line leaves it out, so its writes look like the person's
own from an app.

The entry needs `zod` installed (an optional peer of the kit: only servers and the command line
load this entry) and a process in UTC, as Workers are: `LocalClock` moves times into a frame whose
UTC fields are the person's wall clock. `hh` sets `TZ=UTC` before it runs a tool.
`connectionId` with a write's `idempotency_key` makes a retry land on the same record.

`COVERAGE` lists every household collection the rules let someone write and the tools that reach it
(or why none does, or what is missing); STANDARD.md "Household tools" says when a tool is due.

## Acting as the person

```ts
import { IdTokenCache, exchangeRefreshToken } from '@huishouden/pwa-kit/firebase-auth-rest';
import { FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import { LocalClock } from '@huishouden/pwa-kit/local-clock';

const tokens = new IdTokenCache((refresh) => exchangeRefreshToken(auth, refresh)); // module scope
const db = new FirestoreRest({ projectId: auth.projectId, token: async () => (await tokens.get(refreshToken)).token });
const agenda = await db.query(`households/${id}`, 'agenda', restricted ? { where: [{ field: 'private', op: 'EQUAL', value: false }] } : {});
const clock = new LocalClock(profile.timeZone ?? 'UTC');
```

Helpers and kids must ask for `private == false` on private-capable collections, because the rules
check queries as a whole. Members who aren't a Health person's carers get nothing from
`healthPeople`. A refused call throws `FirestoreError` with `code: 'permission-denied'`.

When a refresh token comes back `revoked` (the person was disabled, or their tokens were revoked),
end the grant so the client signs in again.
