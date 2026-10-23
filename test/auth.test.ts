import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const signInWithCredential = mock(async () => ({ user: { uid: 'u1' } }));
mock.module('firebase/auth', () => ({
  GoogleAuthProvider: { credential: (idToken: string) => ({ idToken }) },
  signInWithCredential,
}));
const { signInSilently } = await import('../src/auth');

// Each test's window is a stand-in carrying Google's script; the real one (or none) is put back after.
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterAll(() => (savedWindow ? Object.defineProperty(globalThis, 'window', savedWindow) : delete (globalThis as { window?: unknown }).window));

type Moment = { isNotDisplayed: () => boolean; getNotDisplayedReason: () => string };
let promptBehaviour: (cb: (r: { credential: string }) => void, listener: (m: Moment) => void) => void;

beforeEach(() => {
  signInWithCredential.mockClear();
  let callback: (r: { credential: string }) => void = () => {};
  (globalThis as unknown as { window: unknown }).window = {
    google: {
      accounts: {
        id: {
          initialize: (cfg: { callback: typeof callback }) => (callback = cfg.callback),
          prompt: (listener: (m: Moment) => void) => promptBehaviour(callback, listener),
          disableAutoSelect: () => {},
        },
      },
    },
  };
});

const auth = (currentUser: unknown = null) => ({ authStateReady: async () => {}, currentUser }) as never;

describe('signInSilently', () => {
  test('does nothing when Firebase already has a user', async () => {
    const result = await signInSilently(auth({ uid: 'existing' }), 'client');
    expect(result.status).toBe('already-signed-in');
  });

  test('signs in to Firebase with the One Tap credential', async () => {
    promptBehaviour = (cb) => cb({ credential: 'id-token' });
    const result = await signInSilently(auth(), 'client');
    expect(result.status).toBe('signed-in');
    expect(signInWithCredential).toHaveBeenCalledTimes(1);
  });

  test('reports Google\'s reason when One Tap is not shown, without throwing', async () => {
    promptBehaviour = (_cb, listener) =>
      listener({ isNotDisplayed: () => true, getNotDisplayedReason: () => 'unregistered_origin' });
    expect(await signInSilently(auth(), 'client')).toEqual({ status: 'unavailable', reason: 'unregistered_origin' });
  });
});
