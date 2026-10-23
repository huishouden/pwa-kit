import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as real from 'firebase/firestore';

// Language changes are window events; without a DOM here, a bare EventTarget stands in for window.
const ownWindow = typeof window === 'undefined' || typeof window.dispatchEvent !== 'function';
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
if (ownWindow) Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: new EventTarget() });

// The device's stored push subscription follows its language (./push `lang`), so the sender can
// pick each reminder's text in it. Firestore and the service worker are stood in for here.
const store = new Map<string, Record<string, unknown>>();
const updates: { path: string; data: Record<string, unknown> }[] = [];
type Ref = { path: string };
mock.module('firebase/firestore', () => ({
  ...real,
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }),
  doc: (col: { path: string }, id: string) => ({ path: `${col.path}/${id}` }),
  getDoc: async (r: Ref) => ({ exists: () => store.has(r.path), data: () => store.get(r.path) }),
  updateDoc: async (r: Ref, data: Record<string, unknown>) => {
    updates.push({ path: r.path, data });
    store.set(r.path, { ...store.get(r.path), ...data });
  },
}));

const ENDPOINT = 'https://push.example.com/abc';
const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: ENDPOINT }) } }) } },
});
afterAll(() => {
  if (saved) Object.defineProperty(globalThis, 'navigator', saved);
  if (ownWindow) {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

const { pushSubscriptionId, syncPushLang, watchPushLang } = await import('../src/push');
const { setLangForTests } = await import('../src/i18n');
const db = {} as real.Firestore;
const user = { email: 'Sam@Example.com' };

beforeEach(() => {
  store.clear();
  updates.length = 0;
});

describe('push subscription language', () => {
  test('rewrites only lang on the device own subscription, and only when it differs', async () => {
    const path = `households/h/pushSubscriptions/${await pushSubscriptionId('sam@example.com', ENDPOINT)}`;
    store.set(path, { email: 'sam@example.com', lang: 'en' });
    expect(await syncPushLang(db, 'h', user, 'es')).toBe(true);
    expect(updates.at(-1)).toEqual({ path, data: { lang: 'es' } });
    expect(await syncPushLang(db, 'h', user, 'es')).toBe(false);
    expect(updates).toHaveLength(1);
  });

  test('nothing when this device has no stored subscription for the member', async () => {
    expect(await syncPushLang(db, 'h', { email: 'alex@example.com' }, 'nl')).toBe(false);
    expect(await syncPushLang(db, 'h', { email: null }, 'nl')).toBe(false);
  });

  test('watchPushLang follows a language change', async () => {
    const path = `households/h/pushSubscriptions/${await pushSubscriptionId('sam@example.com', ENDPOINT)}`;
    store.set(path, { email: 'sam@example.com', lang: 'en' });
    const stop = watchPushLang(db, 'h', user);
    try {
      await setLangForTests('nl');
      await new Promise((r) => setTimeout(r, 10));
      expect(store.get(path)?.lang).toBe('nl');
    } finally {
      stop();
      await setLangForTests('en');
    }
  });
});
