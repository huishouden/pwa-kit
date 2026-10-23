import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as real from 'firebase/firestore';

// One push subscription per device for the suite: the portal's worker (scope /) owns it, and the
// member's older per-app documents for the device are deleted so nothing arrives twice.
const store = new Map<string, Record<string, unknown>>();
const deleted: string[] = [];
type Ref = { path: string };
mock.module('firebase/firestore', () => ({
  ...real,
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }),
  doc: (col: { path: string }, id: string) => ({ path: `${col.path}/${id}` }),
  getDoc: async (r: Ref) => ({ exists: () => store.has(r.path), data: () => store.get(r.path) }),
  setDoc: async (r: Ref, data: Record<string, unknown>) => void store.set(r.path, data),
  deleteDoc: async (r: Ref) => {
    deleted.push(r.path);
    store.delete(r.path);
  },
}));

const KEY = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
const keyBytes = new Uint8Array(65).fill(4);
const sub = (endpoint: string) => ({ endpoint, options: { applicationServerKey: keyBytes.buffer }, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => true });
const subs: Record<string, ReturnType<typeof sub> | null> = { '/': null, '/pet/': sub('https://push.example.com/pet') };
const registration = (scope: string) => ({
  scope: `https://x.example${scope}`,
  active: {},
  pushManager: { getSubscription: async () => subs[scope], subscribe: async () => (subs[scope] = sub('https://push.example.com/suite')) },
});
const regs = [registration('/'), registration('/pet/')];

const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const savedNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Android Chrome', maxTouchPoints: 5, serviceWorker: { getRegistration: async (scope?: string) => regs.find((r) => new URL(r.scope).pathname === (scope ?? '/pet/')), getRegistrations: async () => regs, register: async () => regs[0], ready: Promise.resolve(regs[1]) } },
});
Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted', requestPermission: async () => 'granted' } });
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: Object.assign(new EventTarget(), { PushManager: class {}, matchMedia: () => ({ matches: false }) }) });
afterAll(() => {
  for (const [k, d, ] of [['navigator', saved], ['Notification', savedNotification], ['window', savedWindow]] as const) d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k];
});

const { SUITE_PUSH_APP, enablePush, pushMode, pushScope, pushSubscriptionId, upgradePush } = await import('../src/push');
const db = {} as real.Firestore;
const user = { email: 'Sam@Example.com' };
const path = async (endpoint: string) => `households/h/pushSubscriptions/${await pushSubscriptionId('sam@example.com', endpoint)}`;

// Every test starts on a device whose only subscription is Pet's own worker's, with nothing stored.
beforeEach(() => {
  store.clear();
  deleted.length = 0;
  subs['/'] = null;
  subs['/pet/'] = sub('https://push.example.com/pet');
});
const perApp = async () => store.set(await path('https://push.example.com/pet'), { email: 'sam@example.com', app: 'pet' });
// The device moved to the suite subscription, keeping Pet as its one app.
const upgraded = async () => {
  await perApp();
  expect(await upgradePush(db, 'h', user, KEY)).toBe(true);
};

describe('suite-wide push subscription', () => {
  test('a device with only a per-app subscription is "legacy" and still delivering', async () => {
    await perApp();
    expect(await pushMode(db, 'h', user)).toBe('legacy');
  });

  test('upgrading subscribes through the portal worker, stores app "suite" and deletes the per-app document', async () => {
    await perApp();
    expect(await upgradePush(db, 'h', user, KEY)).toBe(true);
    // The move keeps the apps the device was for, so a shared tablet that notified for Pet does not start showing everything.
    expect(store.get(await path('https://push.example.com/suite'))).toMatchObject({ app: SUITE_PUSH_APP, email: 'sam@example.com', apps: ['pet'] });
    expect(await pushScope(db, 'h', user)).toEqual(['pet']);
    expect(store.has(await path('https://push.example.com/pet'))).toBe(false);
    expect(await pushMode(db, 'h', user)).toBe('suite');
  });

  test('already on the suite subscription: nothing to upgrade, one document for the device', async () => {
    await upgraded();
    expect(await upgradePush(db, 'h', user, KEY)).toBe(false);
    expect([...store.keys()]).toHaveLength(1);
  });

  test('enabling again on a device with a per-app subscription never leaves two documents, and an explicit tap widens it to every app', async () => {
    await upgraded();
    await perApp();
    await enablePush(db, 'h', user, KEY);
    expect([...store.keys()]).toEqual([await path('https://push.example.com/suite')]);
    expect(store.get(await path('https://push.example.com/suite'))).not.toHaveProperty('apps');
    expect(await pushScope(db, 'h', user)).toBeNull();
  });

  test('no key, no upgrade', async () => {
    expect(await upgradePush(db, 'h', user, undefined)).toBe(false);
  });
});

describe('a cut-short cleanup', () => {
  test('a suite document beside a per-app one is finished by upgradePush', async () => {
    subs['/'] = sub('https://push.example.com/suite');
    store.set(await path('https://push.example.com/suite'), { email: 'sam@example.com', app: 'suite' });
    store.set(await path('https://push.example.com/pet'), { email: 'sam@example.com', app: 'pet' });
    expect(await pushMode(db, 'h', user)).toBe('legacy');
    expect(await upgradePush(db, 'h', user, KEY)).toBe(true);
    expect([...store.keys()]).toEqual([await path('https://push.example.com/suite')]);
    // The suite document was an explicit every-app one: finishing the cleanup does not narrow it.
    expect(store.get(await path('https://push.example.com/suite'))).not.toHaveProperty('apps');
  });
});

describe('the portal worker is not active yet', () => {
  test("a subscription made through the app's own worker says so: its app's name, no cleanup, not an upgrade", async () => {
    subs['/pet/'] = null;
    const inactive = { ...regs[0], active: null };
    const saved = regs[0];
    regs[0] = inactive as never;
    try {
      const result = await enablePush(db, 'h', user, KEY, { app: 'pet', waitMs: 0 });
      expect(result.suite).toBe(false);
      expect(store.get(await path(result.endpoint))).toMatchObject({ app: 'pet' });
      await expect(enablePush(db, 'h', user, KEY, { waitMs: 0 })).rejects.toThrow();
      subs['/pet/'] = sub('https://push.example.com/pet');
      store.set(await path('https://push.example.com/pet'), { email: 'sam@example.com', app: 'pet' });
      expect(await upgradePush(db, 'h', user, KEY, { waitMs: 0 })).toBe(false);
    } finally {
      regs[0] = saved;
    }
  });
});

describe('what a move keeps', () => {
  test('a limited suite document plus a new per-app document for another app: both apps stay', async () => {
    subs['/'] = sub('https://push.example.com/suite');
    store.set(await path('https://push.example.com/suite'), { email: 'sam@example.com', app: 'suite', apps: ['pet'] });
    store.set(await path('https://push.example.com/pet'), { email: 'sam@example.com', app: 'home' });
    expect(await upgradePush(db, 'h', user, KEY)).toBe(true);
    expect(await pushScope(db, 'h', user)).toEqual(['pet', 'home']);
    expect([...store.keys()]).toEqual([await path('https://push.example.com/suite')]);
  });

  test('a per-app document whose app cannot be read moves nothing, rather than widening the device', async () => {
    store.set(await path('https://push.example.com/pet'), { email: 'sam@example.com' });
    expect(await upgradePush(db, 'h', user, KEY)).toBe(false);
    expect([...store.keys()]).toEqual([await path('https://push.example.com/pet')]);
  });

  test('two moves at once are one move', async () => {
    store.set(await path('https://push.example.com/pet'), { email: 'sam@example.com', app: 'pet' });
    const [a, b] = await Promise.all([upgradePush(db, 'h', user, KEY), upgradePush(db, 'h', user, KEY)]);
    expect([a, b]).toEqual([true, true]);
    expect(await pushScope(db, 'h', user)).toEqual(['pet']);
  });
});
