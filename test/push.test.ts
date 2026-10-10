import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTIFICATION_PREFS_FIELDS, PUSH_SUBSCRIPTION_FIELDS, applicationServerKey, iosVersion, mutedApps, pushSubscriptionId, pushSupport } from '../src/push';
import { PUSH_SW_FILE, installPushHandlers, pushServiceWorkerSource } from '../src/push-sw';
import { OCR_CACHE, pwaApp } from '../src/vite';

const IPHONE_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_16_1 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const env = { userAgent: ANDROID, maxTouchPoints: 5, standalone: false, hasServiceWorker: true, hasPushManager: true, permission: 'default' as NotificationPermission };

describe('pushSupport', () => {
  test('Android and desktop browsers: supported in a tab', () => {
    expect(pushSupport(env)).toEqual({ supported: true });
  });
  test('iPhone in Safari: add to Home Screen first', () => {
    const r = pushSupport({ ...env, userAgent: IPHONE_17, hasPushManager: false });
    expect(r).toMatchObject({ supported: false, reason: 'ios-not-installed' });
    expect(r.supported === false && r.message).toContain('Add to Home Screen');
  });
  test('iPhone, installed, 16.4 or later: supported', () => {
    expect(pushSupport({ ...env, userAgent: IPHONE_17, standalone: true })).toEqual({ supported: true });
  });
  test('iPhone older than 16.4', () => {
    expect(pushSupport({ ...env, userAgent: IPHONE_16_1, standalone: true })).toMatchObject({ reason: 'ios-too-old' });
  });
  test('iPad reporting itself as a Mac is still iOS', () => {
    expect(iosVersion(IPAD_AS_MAC, 5)).toBe(17.04);
    expect(iosVersion(IPAD_AS_MAC, 0)).toBeNull();
    expect(pushSupport({ ...env, userAgent: IPAD_AS_MAC, maxTouchPoints: 5 })).toMatchObject({ reason: 'ios-not-installed' });
  });
  test('blocked, or no push in this browser', () => {
    expect(pushSupport({ ...env, permission: 'denied' })).toMatchObject({ reason: 'denied' });
    expect(pushSupport({ ...env, hasPushManager: false })).toMatchObject({ reason: 'unsupported-browser' });
    expect(pushSupport({ ...env, permission: 'unavailable' as never })).toMatchObject({ reason: 'unsupported-browser' });
  });
});

describe('subscriptions', () => {
  test('VAPID key decodes from base64url to the 65-byte uncompressed point', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const key = Buffer.from(raw).toString('base64url');
    expect(applicationServerKey(key)).toEqual(raw);
  });
  test('the id is per person and endpoint, case-insensitive on the email', async () => {
    const a = await pushSubscriptionId('Sam@Example.com', 'https://push.example.com/abc');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await pushSubscriptionId('sam@example.com', 'https://push.example.com/abc')).toBe(a);
    expect(await pushSubscriptionId('alex@example.com', 'https://push.example.com/abc')).not.toBe(a);
  });
  test('fields the rules allow', () => {
    expect([...PUSH_SUBSCRIPTION_FIELDS]).toEqual(['email', 'app', 'endpoint', 'keys', 'ua', 'apps', 'lang', 'createdAt']);
  });
});

/** A fake service-worker global: records listeners, notifications, focus and opened windows. */
function fakeServiceWorker(windows: { url: string }[] = [], scope = 'https://pet.example.com/') {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const log: string[] = [];
  const clients = windows.map((w) => ({
    url: w.url,
    focus: async () => void log.push(`focus ${w.url}`),
    navigate: async (u: string) => void log.push(`navigate ${u}`),
  }));
  const sw = {
    location: { origin: new URL(scope).origin },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    registration: { scope, showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: { matchAll: async () => clients, openWindow: async (u: string) => void log.push(`open ${u}`) },
  };
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { sw, shown, log, dispatch };
}

describe('service worker handlers', () => {
  test('a push shows the reminder with its deep link', async () => {
    const f = fakeServiceWorker();
    installPushHandlers(f.sw);
    const payload = { title: 'Biscuit: Carprofen 75 mg', body: '1 tablet at 20:00', url: 'https://pet.example.com/pets/p1', tag: 'r1', app: 'pet' };
    await f.dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
    expect(f.shown).toEqual([{ title: payload.title, options: { body: payload.body, tag: 'r1', icon: 'https://pet.example.com/pwa-192.png', badge: 'https://pet.example.com/pwa-192.png', data: { url: payload.url } } }]);
  });

  test("on the shared site, icons and the default link are the app's path", async () => {
    const f = fakeServiceWorker([], 'https://family.example.com/pet/');
    installPushHandlers(f.sw);
    await f.dispatch('push', { data: { json: () => ({ title: 'Hi' }), text: () => '' } });
    expect(f.shown[0].options).toMatchObject({ icon: 'https://family.example.com/pet/pwa-192.png', data: { url: 'https://family.example.com/pet/' } });
  });

  test("on the shared site, tapping reuses the app's own window, not another app's", async () => {
    const f = fakeServiceWorker(
      [{ url: 'https://family.example.com/' }, { url: 'https://family.example.com/baby/' }, { url: 'https://family.example.com/pet/?tab=care' }],
      'https://family.example.com/pet/',
    );
    installPushHandlers(f.sw);
    await f.dispatch('notificationclick', { notification: { data: { url: 'https://family.example.com/pet/meds/c1' }, close: () => {} } });
    expect(f.log).toEqual(['focus https://family.example.com/pet/?tab=care', 'navigate https://family.example.com/pet/meds/c1']);
  });

  test('on the shared site, a link into an app with no open window opens one', async () => {
    const f = fakeServiceWorker([{ url: 'https://family.example.com/' }], 'https://family.example.com/pet/');
    installPushHandlers(f.sw);
    await f.dispatch('notificationclick', { notification: { data: { url: 'https://family.example.com/home/#upkeep' }, close: () => {} } });
    expect(f.log).toEqual(['open https://family.example.com/home/#upkeep']);
  });

  test('a push that is not JSON still shows, as text', async () => {
    const f = fakeServiceWorker();
    installPushHandlers(f.sw);
    await f.dispatch('push', { data: { json: () => { throw new Error('no'); }, text: () => 'Time for meds' } });
    expect(f.shown[0]).toMatchObject({ title: 'Reminder', options: { body: 'Time for meds' } });
  });

  test('tapping focuses an open window of the app and moves it to the link', async () => {
    const f = fakeServiceWorker([{ url: 'https://other.example.com/' }, { url: 'https://pet.example.com/' }]);
    installPushHandlers(f.sw);
    let closed = false;
    await f.dispatch('notificationclick', { notification: { data: { url: 'https://pet.example.com/pets/p1' }, close: () => (closed = true) } });
    expect(closed).toBe(true);
    expect(f.log).toEqual(['focus https://pet.example.com/', 'navigate https://pet.example.com/pets/p1']);
  });

  test('tapping with no window open opens the link', async () => {
    const f = fakeServiceWorker();
    installPushHandlers(f.sw);
    await f.dispatch('notificationclick', { notification: { data: { url: '/pets/p1' }, close: () => {} } });
    expect(f.log).toEqual(['open https://pet.example.com/pets/p1']);
  });

  test('the generated file is a classic script that installs the handlers on self', async () => {
    const source = pushServiceWorkerSource();
    expect(source).not.toMatch(/\bimport\b|\bexport\b/);
    const f = fakeServiceWorker();
    new Function('self', source)(f.sw);
    await f.dispatch('push', { data: { json: () => ({ title: 'Hi' }), text: () => '' } });
    expect(f.shown.map((n) => n.title)).toEqual(['Hi']);
  });
});

describe('pwaApp({ push, ocr })', () => {
  test('OCR cache matches the pinned engine files only', () => {
    expect(OCR_CACHE.urlPattern.test('https://cdn.jsdelivr.net/npm/tesseract.js@v7.0.0/dist/worker.min.js')).toBe(true);
    expect(OCR_CACHE.urlPattern.test('https://cdn.jsdelivr.net/npm/tesseract.js-core@v7.0.0/tesseract-core-simd-lstm.wasm.js')).toBe(true);
    expect(OCR_CACHE.urlPattern.test('https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz')).toBe(true);
    expect(OCR_CACHE.urlPattern.test('https://cdn.jsdelivr.net/npm/left-pad@1.0.0/index.js')).toBe(false);
  });

  test('a build with push: true ships hh-push-sw.js and the service worker loads it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hh-push-'));
    try {
      writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.ts"></script></body></html>');
      writeFileSync(join(root, 'main.ts'), 'console.log(1);');
      mkdirSync(join(root, 'public'));
      const { build } = await import('vite');
      await build({
        root,
        logLevel: 'silent',
        configFile: false,
        build: { outDir: join(root, 'dist') },
        plugins: [pwaApp({ name: 'Demo', description: 'Demo app.', themeColor: '#000000', backgroundColor: '#ffffff', push: true, ocr: true })],
      });
      expect(existsSync(join(root, 'dist', PUSH_SW_FILE))).toBe(true);
      const sw = readFileSync(join(root, 'dist', 'sw.js'), 'utf8');
      expect(sw).toContain(`importScripts("${PUSH_SW_FILE}")`);
      expect(sw).toContain('hh-ocr');
      expect(sw).toContain('/^\\/__\\//');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('notification preferences', () => {
  test('mutedApps keeps app names only, once each', () => {
    expect(mutedApps({ muted: ['bills', 'bills', 'pet', 3, 'Not An App', ''] })).toEqual(['bills', 'pet']);
    expect(mutedApps(undefined)).toEqual([]);
    expect(mutedApps({ muted: 'bills' })).toEqual([]);
  });

  test('fields match the rules', () => {
    expect([...NOTIFICATION_PREFS_FIELDS]).toEqual(['muted', 'updatedAt']);
  });
});
