import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// "Continue in this tab": Google's code client in redirect mode, stubbed, and the page Google sends
// the person back to. The state kept in sessionStorage is what lets an answer in.
if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://suite.example.com/my-calendar' });
afterAll(() => {
  // window is the global object under the DOM, so its Google stub outlives the DOM unless removed.
  delete (window as unknown as { google?: unknown }).google;
  return GlobalRegistrator.unregister();
});

const asked: Record<string, unknown>[] = [];
(window as unknown as { google: unknown }).google = {
  accounts: {
    id: {},
    oauth2: {
      initCodeClient: (cfg: Record<string, unknown>) => ({
        requestCode: () => asked.push(cfg),
      }),
    },
  },
};

const { configureGoogleTokens, googleAuthCodeRedirect, googleAuthCodeReturn, googleRedirectReturned } = await import('../src/google-token');
const auth = (uid = 'u1') => ({ currentUser: { uid, email: `${uid}@example.com` } }) as never;
const CAL = 'https://www.googleapis.com/auth/calendar';

/** Google sending the person back to the page with `query`. */
const back = (query: string) => history.replaceState(null, '', `/my-calendar?${query}`);

beforeEach(() => {
  asked.length = 0;
  sessionStorage.clear();
  history.replaceState(null, '', '/my-calendar');
  configureGoogleTokens({ clientId: 'client-1.apps.googleusercontent.com', preload: false });
});

describe('googleAuthCodeRedirect', () => {
  test('redirect mode back to this page, with a random state kept for this tab', async () => {
    await googleAuthCodeRedirect(auth(), [CAL], { data: 'calendar' });
    expect(asked).toHaveLength(1);
    const cfg = asked[0]!;
    expect(cfg).toMatchObject({ client_id: 'client-1.apps.googleusercontent.com', scope: CAL, ux_mode: 'redirect', redirect_uri: 'https://suite.example.com/my-calendar', login_hint: 'u1@example.com', include_granted_scopes: true });
    expect(String(cfg.state)).toMatch(/^[0-9a-f]{64}$/);
    const kept = JSON.parse(sessionStorage.getItem('hh-google-redirect')!);
    expect(kept).toMatchObject({ state: cfg.state, uid: 'u1', scopes: [CAL], redirectUri: 'https://suite.example.com/my-calendar', data: 'calendar' });
  });

  test('the account chooser and an explicit return address', async () => {
    await googleAuthCodeRedirect(auth(), [CAL], { selectAccount: true, redirectUri: 'https://suite.example.com/spending/' });
    expect(asked[0]).toMatchObject({ select_account: true, include_granted_scopes: false, redirect_uri: 'https://suite.example.com/spending/' });
    expect(asked[0]!.login_hint).toBeUndefined();
  });
});

describe('googleAuthCodeReturn', () => {
  async function asked_() {
    await googleAuthCodeRedirect(auth(), [CAL], { data: 'calendar' });
    return String(asked[0]!.state);
  }

  test('not a return: null, and the address is left alone', () => {
    history.replaceState(null, '', '/my-calendar?tab=x');
    expect(googleRedirectReturned()).toBe(false);
    expect(googleAuthCodeReturn(auth())).toBeNull();
    expect(location.search).toBe('?tab=x');
  });

  test('the code, once, with the address to exchange it with; the code leaves the address', async () => {
    const state = await asked_();
    back(`state=${state}&code=4%2F0-one-time&scope=${encodeURIComponent(`email ${CAL}`)}&authuser=0&prompt=consent&tab=x`);
    expect(googleRedirectReturned()).toBe(true);
    expect(googleAuthCodeReturn(auth())).toEqual({ code: '4/0-one-time', scope: `email ${CAL}`, redirectUri: 'https://suite.example.com/my-calendar', data: 'calendar' });
    expect(location.search).toBe('?tab=x');
    expect(sessionStorage.getItem('hh-google-redirect')).toBeNull();
    // The same answer again (a reload with the old address) is refused: the state was used.
    back(`state=${state}&code=4%2F0-one-time`);
    expect(() => googleAuthCodeReturn(auth())).toThrow(expect.objectContaining({ code: 'unknown' }));
  });

  test('a state this tab did not ask for, another person, or an old request: refused', async () => {
    await asked_();
    back('state=forged&code=c');
    expect(googleRedirectReturned()).toBe(false);
    expect(() => googleAuthCodeReturn(auth())).toThrow(expect.objectContaining({ code: 'unknown' }));

    const state = await asked_();
    back(`state=${state}&code=c&scope=${encodeURIComponent(CAL)}`);
    expect(() => googleAuthCodeReturn(auth('someone-else'))).toThrow(expect.objectContaining({ code: 'unknown' }));

    asked.length = 0;
    const old = await asked_();
    const kept = JSON.parse(sessionStorage.getItem('hh-google-redirect')!);
    sessionStorage.setItem('hh-google-redirect', JSON.stringify({ ...kept, at: Date.now() - 16 * 60_000 }));
    back(`state=${old}&code=c&scope=${encodeURIComponent(CAL)}`);
    expect(() => googleAuthCodeReturn(auth())).toThrow(expect.objectContaining({ code: 'unknown' }));
    expect(location.search).toBe('');
  });

  test('no on Google’s page, or the scope unticked: access_denied with the caller’s words', async () => {
    let state = await asked_();
    back(`state=${state}&error=access_denied`);
    expect(() => googleAuthCodeReturn(auth(), { deniedMessage: 'Calendar not allowed' })).toThrow(expect.objectContaining({ code: 'access_denied', message: 'Calendar not allowed' }));
    asked.length = 0;
    state = await asked_();
    back(`state=${state}&code=c&scope=email`);
    expect(() => googleAuthCodeReturn(auth())).toThrow(expect.objectContaining({ code: 'access_denied' }));
  });
});
