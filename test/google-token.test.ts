import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import responses from './fixtures/gis/token-responses.json';

// A stand-in for Google Identity Services' token client. Each requestAccessToken records what was
// asked and answers through `answer`: by default a new token carrying exactly the scopes asked for.
interface TokenConfig {
  client_id: string;
  scope: string;
  hint?: string;
  include_granted_scopes?: boolean;
  callback: (r: Record<string, unknown>) => void;
  error_callback?: (e: { type: string; message?: string }) => void;
}
const requests: { clientId: string; scopes: string[]; hint?: string; includeGranted?: boolean; prompt?: string }[] = [];
let answer: (cfg: TokenConfig) => void;
const grant = (cfg: TokenConfig, extra: Record<string, unknown> = {}) =>
  cfg.callback({ ...responses.granted, access_token: `token-${requests.length}`, scope: cfg.scope, ...extra });

const gis = {
  id: { initialize() {}, prompt() {}, disableAutoSelect() {} },
  oauth2: {
    initTokenClient: (cfg: TokenConfig) => ({
      requestAccessToken(overrides?: { prompt?: string }) {
        requests.push({ clientId: cfg.client_id, scopes: cfg.scope.split(' '), hint: cfg.hint, includeGranted: cfg.include_granted_scopes, prompt: overrides?.prompt });
        answer(cfg);
      },
    }),
    hasGrantedAllScopes: () => true,
    initCodeClient: (cfg: { client_id: string; scope: string; ux_mode: string; login_hint?: string; select_account?: boolean; include_granted_scopes?: boolean; callback: (r: Record<string, unknown>) => void; error_callback?: (e: { type: string }) => void }) => ({
      requestCode() {
        codeRequests.push({ clientId: cfg.client_id, scope: cfg.scope, mode: cfg.ux_mode, hint: cfg.login_hint, ...(cfg.select_account ? { chooser: true, granted: cfg.include_granted_scopes } : {}) });
        codeAnswer(cfg);
      },
    }),
  },
};
const codeRequests: { clientId: string; scope: string; mode: string; hint?: string; chooser?: boolean; granted?: boolean }[] = [];
let codeAnswer: (cfg: { scope: string; callback: (r: Record<string, unknown>) => void; error_callback?: (e: { type: string }) => void }) => void = (cfg) => cfg.callback({ code: 'one-time-code', scope: cfg.scope });

const { cachedGoogleToken, configureGoogleTokens, forgetGoogleToken, googleAccessToken, googleAuthCode, googleFetch, GoogleApiError, GoogleTokenError } = await import('../src/google-token');
const { requestGmailToken, storedGmailToken, gmailMailbox, gmailError, GMAIL_READONLY_SCOPE } = await import('../src/gmail');
const { googleWindowMessage, popupBlocked, popupCancelled } = await import('../src/feedback');

// This file's page storage and window (Google's script on it) stand in for the page's, and are put
// back after its tests, so later files see what they would have.
const pageGlobals = (['localStorage', 'window'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
afterAll(() => {
  delete (globalThis as unknown as { window?: { google?: unknown } }).window?.google;
  for (const [k, d] of pageGlobals) d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k];
});

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;

const auth = (uid = 'u1') => ({ currentUser: { uid, email: `${uid}@example.com` } }) as never;
const A = 'https://www.googleapis.com/auth/a';
const B = 'https://www.googleapis.com/auth/b';
const C = 'https://www.googleapis.com/auth/c';

beforeEach(() => {
  const g = globalThis as unknown as { window?: { google?: unknown } };
  g.window ??= globalThis as never;
  g.window.google = { accounts: gis };
  configureGoogleTokens({ clientId: 'client-1.apps.googleusercontent.com', preload: false });
  forgetGoogleToken();
  store.clear();
  requests.length = 0;
  answer = (cfg) => grant(cfg);
});

describe('googleAccessToken', () => {
  test('asks Google Identity Services once per set of scopes and reuses the token', async () => {
    expect(await googleAccessToken(auth(), [A])).toBe('token-1');
    expect(await googleAccessToken(auth(), [A])).toBe('token-1');
    expect(requests).toEqual([{ clientId: 'client-1.apps.googleusercontent.com', scopes: [A], hint: 'u1@example.com', includeGranted: true, prompt: '' }]);
    expect(await googleAccessToken(auth(), [B])).toBe('token-2');
    expect(requests.map((r) => r.scopes)).toEqual([[A], [B]]);
  });

  test("opens Google's window in the same tick as the tap when the script is loaded", () => {
    void googleAccessToken(auth(), [A]);
    expect(requests).toHaveLength(1);
  });

  test('two taps at once share one window', async () => {
    let finish: () => void = () => {};
    answer = (cfg) => (finish = () => grant(cfg));
    const first = googleAccessToken(auth(), [A]);
    const second = googleAccessToken(auth(), [A]);
    finish();
    expect(await first).toBe('token-1');
    expect(await second).toBe('token-1');
    expect(requests).toHaveLength(1);
  });

  test('a token for more scopes covers a request for fewer, including scopes granted earlier', async () => {
    await googleAccessToken(auth(), [A, B]);
    expect(cachedGoogleToken(auth(), [B])).toBe('token-1');
    expect(cachedGoogleToken(auth(), [A, B])).toBe('token-1');
    answer = (cfg) => grant(cfg, { scope: `${cfg.scope} ${A} ${B}` });
    await googleAccessToken(auth(), [C]);
    expect(cachedGoogleToken(auth(), [A, C])).toBe('token-2');
  });

  test('tokens are per member', async () => {
    await googleAccessToken(auth('u1'), [A]);
    expect(cachedGoogleToken(auth('u2'), [A])).toBeNull();
  });

  test('kept until five minutes before Google says it ends', async () => {
    const before = Date.now();
    await googleAccessToken(auth(), [A], { persist: true });
    const [saved] = JSON.parse(store.get('hh-google-tokens')!) as { expires: number }[];
    expect(saved.expires).toBeGreaterThanOrEqual(before + (3599 - 300) * 1000);
    expect(saved.expires).toBeLessThanOrEqual(Date.now() + (3599 - 300) * 1000);
    answer = (cfg) => grant(cfg, { expires_in: '300' });
    await googleAccessToken(auth(), [B]);
    expect(cachedGoogleToken(auth(), [B])).toBeNull();
  });

  test('memory only unless persisted; persisted ones survive a reload', async () => {
    await googleAccessToken(auth(), [A]);
    expect(store.has('hh-google-tokens')).toBe(false);
    await googleAccessToken(auth(), [B], { persist: true });
    const saved = JSON.parse(store.get('hh-google-tokens')!);
    expect(saved.map((e: { scopes: string[] }) => e.scopes)).toEqual([[B]]);
  });

  test('forgetting one token asks again for it only', async () => {
    await googleAccessToken(auth(), [A]);
    await googleAccessToken(auth(), [B], { persist: true });
    forgetGoogleToken('token-2');
    expect(cachedGoogleToken(auth(), [B])).toBeNull();
    expect(cachedGoogleToken(auth(), [A])).toBe('token-1');
    expect(store.has('hh-google-tokens')).toBe(false);
  });

  test('signed out, or no client id', async () => {
    await expect(googleAccessToken({ currentUser: null } as never, [A])).rejects.toThrow('Sign in first.');
    configureGoogleTokens({ clientId: '' });
    const e = await googleAccessToken(auth(), [A]).catch((x) => x);
    expect(e).toBeInstanceOf(GoogleTokenError);
    expect(e.code).toBe('not_configured');
    expect(requests).toHaveLength(0);
    expect(await googleAccessToken(auth(), [A], { clientId: 'client-2' })).toBe('token-1');
    expect(requests[0].clientId).toBe('client-2');
  });

  test('refused on the consent screen, or a permission unticked', async () => {
    answer = (cfg) => cfg.callback(responses.denied);
    const denied = await googleAccessToken(auth(), [A], { deniedMessage: 'No calendar.' }).catch((x) => x);
    expect(denied.message).toBe('No calendar.');
    expect(denied.code).toBe('access_denied');
    answer = (cfg) => grant(cfg, { scope: A });
    const partial = await googleAccessToken(auth(), [A, B], { deniedMessage: 'No calendar.' }).catch((x) => x);
    expect(partial.code).toBe('access_denied');
    expect(cachedGoogleToken(auth(), [A])).toBeNull();
    answer = (cfg) => cfg.callback(responses.invalidRequest);
    expect((await googleAccessToken(auth(), [A]).catch((x) => x)).message).toBe('Google answered: Invalid parameter value for scope.');
  });

  test('window closed or blocked', async () => {
    answer = (cfg) => cfg.error_callback!(responses.popupClosed);
    const closed = await googleAccessToken(auth(), [A]).catch((x) => x);
    expect(closed.code).toBe('popup_closed');
    expect(popupCancelled(closed)).toBe(true);
    answer = (cfg) => cfg.error_callback!(responses.popupFailed);
    const blocked = await googleAccessToken(auth(), [A]).catch((x) => x);
    expect(popupBlocked(blocked)).toBe(true);
    expect(gmailError(blocked)).toBe('The browser blocked Google’s window. Allow popups for this site and try again.');
    // A failed attempt doesn't stick: the next tap asks again.
    answer = (cfg) => grant(cfg);
    expect(await googleAccessToken(auth(), [A])).toBe('token-3');
  });
});

describe('googleFetch', () => {
  test('a 401 forgets the token; errors carry Google’s message and status', async () => {
    const token = await googleAccessToken(auth(), [A]);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), { status: 401 })) as unknown as typeof fetch;
    try {
      const e = (await googleFetch(token, 'https://example.com/api', { label: 'Calendar' }).catch((x) => x)) as InstanceType<typeof GoogleApiError>;
      expect(e).toBeInstanceOf(GoogleApiError);
      expect(e.message).toBe('[401] Calendar: Invalid Credentials');
      expect(e.status).toBe(401);
      expect(cachedGoogleToken(auth(), [A])).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('Gmail token and mailbox', () => {
  test('the read-only token is persisted and found again without a window', async () => {
    expect(storedGmailToken(auth())).toBeNull();
    const token = await requestGmailToken(auth());
    expect(requests.map((r) => r.scopes)).toEqual([[GMAIL_READONLY_SCOPE]]);
    expect(storedGmailToken(auth())).toBe(token);
    expect(store.has('hh-google-tokens')).toBe(true);
  });

  test('search and get through the REST API; a 401 asks again next time', async () => {
    const token = await requestGmailToken(auth());
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: URL) => {
      urls.push(String(url));
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
      return new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    try {
      const box = gmailMailbox(token);
      expect(await box.search('from:(billing@example.com)', 5)).toEqual(['m1', 'm2']);
      expect(urls[0]).toContain('q=from%3A%28billing%40example.com%29');
      expect(urls[0]).toContain('maxResults=5');
      await expect(box.get('m1')).rejects.toThrow('Gmail access has ended');
      expect(storedGmailToken(auth())).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('calendar search with series starts', () => {
  test('a repeating match carries when its series began, fetched once per series', async () => {
    const { findCalendarEvents } = await import('../src/calendar');
    const original = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = (async (url: URL) => {
      paths.push(url.pathname);
      if (url.pathname.endsWith('/users/me/calendarList')) return Response.json({ items: [{ id: 'family@example.com', summary: 'Family' }] });
      if (url.pathname.endsWith('/events/bday-series')) return Response.json({ id: 'bday-series', htmlLink: 'l', start: { date: '2027-03-14' } });
      return Response.json({
        items: [
          { id: 'bday-series_20320314', recurringEventId: 'bday-series', summary: "Biscuit's birthday", htmlLink: 'l1', start: { date: '2032-03-14' } },
          { id: 'one-off', summary: 'Biscuit birthday party', htmlLink: 'l2', start: { dateTime: '2032-03-16T15:00:00Z' } },
        ],
      });
    }) as unknown as typeof fetch;
    try {
      const matches = await findCalendarEvents(auth(), ["biscuit's birthday", 'biscuit birthday'], { seriesStart: true });
      const series = matches.find((m) => m.id === 'bday-series_20320314')!;
      expect(series).toMatchObject({ calendarId: 'family@example.com', recurringEventId: 'bday-series', seriesStart: new Date(2027, 2, 14).getTime() });
      expect(matches.find((m) => m.id === 'one-off')!.seriesStart).toBeUndefined();
      expect(paths.filter((p) => p.endsWith('/events/bday-series'))).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('googleAuthCode', () => {
  test('every way Google’s window ends without a code has a message: blocked, closed, unknown', async () => {
    const ended = async (_why: string) => googleAuthCode(auth(), [A]).catch((e: unknown) => e);
    codeAnswer = (cfg) => cfg.error_callback?.({ type: 'popup_failed_to_open' });
    const blocked = await ended('popup_failed_to_open');
    expect(popupBlocked(blocked)).toBe(true);
    expect(googleWindowMessage(blocked)).toBe('Your browser blocked Google’s window. Allow pop-ups for this site, then try again.');
    expect(googleWindowMessage(blocked, 'Google', { continueHere: true })).toBe('Your browser blocked Google’s window. Allow pop-ups for this site, or use Continue in this tab.');
    codeAnswer = (cfg) => cfg.error_callback?.({ type: 'popup_closed' });
    expect(googleWindowMessage(await ended('popup_closed'))).toBe('Google’s window was closed before finishing. Try again when you are ready.');
    codeAnswer = (cfg) => cfg.error_callback?.({ type: 'something_new' });
    expect(googleWindowMessage(await ended('unknown'))).toBe('Google’s window stopped before finishing. Try again.');
    codeAnswer = (cfg) => cfg.callback({ error: 'access_denied' });
    expect(googleWindowMessage(await ended('denied'), 'Google Calendar')).toBe('Google Calendar access was not allowed. Try again and allow it on Google’s page.');
    expect(googleWindowMessage(new Error('[500] calendar worker'))).toBeNull();
  });

  test('tapping again while Google’s window is open brings it back: one client, one answer', async () => {
    codeRequests.length = 0;
    let finish: (() => void) | undefined;
    codeAnswer = (cfg) => {
      finish ??= () => cfg.callback({ code: 'the-code', scope: cfg.scope });
    };
    const first = googleAuthCode(auth(), [A]);
    const again = googleAuthCode(auth(), [A]);
    expect(codeRequests).toHaveLength(2);
    finish!();
    expect(await first).toEqual({ code: 'the-code', scope: A });
    expect(await again).toEqual({ code: 'the-code', scope: A });
    // Once answered, the next tap starts a new request.
    codeAnswer = (cfg) => cfg.callback({ code: 'next-code', scope: cfg.scope });
    expect((await googleAuthCode(auth(), [A])).code).toBe('next-code');
  });

  test('a code client that throws is an error, not a silent wait', async () => {
    codeAnswer = () => {
      throw new Error('boom');
    };
    expect(await googleAuthCode(auth(), [A]).catch((e) => e.code)).toBe('unknown');
    codeAnswer = (cfg) => cfg.callback({ code: 'after', scope: cfg.scope });
    expect((await googleAuthCode(auth(), [A])).code).toBe('after');
  });

  test('a one-time code from the code client in a popup, hinted with the member', async () => {
    codeRequests.length = 0;
    codeAnswer = (cfg) => cfg.callback({ code: 'one-time-code', scope: cfg.scope });
    expect(await googleAuthCode(auth(), [A])).toEqual({ code: 'one-time-code', scope: A });
    expect(codeRequests).toEqual([{ clientId: 'client-1.apps.googleusercontent.com', scope: A, mode: 'popup', hint: 'u1@example.com' }]);
  });

  test('selectAccount: the account chooser, no hint, only the scopes asked for', async () => {
    codeRequests.length = 0;
    codeAnswer = (cfg) => cfg.callback({ code: 'other-account-code', scope: cfg.scope });
    expect(await googleAuthCode(auth(), [A], { selectAccount: true })).toEqual({ code: 'other-account-code', scope: A });
    expect(codeRequests).toEqual([{ clientId: 'client-1.apps.googleusercontent.com', scope: A, mode: 'popup', hint: undefined, chooser: true, granted: false }]);
  });

  test('a scope left unticked, or the window closed, is an error with its code', async () => {
    codeAnswer = (cfg) => cfg.callback({ code: 'c', scope: 'openid' });
    expect(await googleAuthCode(auth(), [A]).catch((e) => e.code)).toBe('access_denied');
    codeAnswer = (cfg) => cfg.error_callback?.({ type: 'popup_closed' });
    expect(await googleAuthCode(auth(), [A]).catch((e) => e.code)).toBe('popup_closed');
    codeAnswer = (cfg) => cfg.callback({ error: 'access_denied' });
    expect(await googleAuthCode(auth(), [A]).catch((e) => e).then((e: InstanceType<typeof GoogleTokenError>) => e.code)).toBe('access_denied');
  });
});
