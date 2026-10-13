import { describe, expect, test } from 'bun:test';
import { firebaseConfigFromEnv } from '../src/firebase';
import { SUITE_ORIGIN } from '../src/site';
import { FIREBASE_RESERVED_PATHS, linkPreview, navigationDenylist, normalizeBase, pwaApp, pwaWorkbox, sitePath, telemetryChunks, TELEMETRY_CHUNKS, webManifest } from '../src/vite';

describe('firebaseConfigFromEnv', () => {
  const env = {
    VITE_FIREBASE_API_KEY: 'key',
    VITE_FIREBASE_PROJECT_ID: 'demo-project',
    VITE_FIREBASE_APP_ID: '1:2:web:3',
  };

  test('defaults authDomain to the project domain the auto-created OAuth client allows', () => {
    expect(firebaseConfigFromEnv(env).authDomain).toBe('demo-project.firebaseapp.com');
  });

  test('uses the fallback when the build has no Firebase variables', () => {
    const fallback = { apiKey: 'f', authDomain: 'f.firebaseapp.com', projectId: 'f', appId: 'x' };
    expect(firebaseConfigFromEnv({}, fallback)).toBe(fallback);
  });

  test('fails loudly with neither', () => {
    expect(() => firebaseConfigFromEnv({})).toThrow(/VITE_FIREBASE/);
  });
});

describe('FIREBASE_RESERVED_PATHS', () => {
  test('excludes the Firebase auth handler and SDK paths, not app routes', () => {
    const denied = (p: string) => FIREBASE_RESERVED_PATHS.some((r) => r.test(p));
    expect(denied('/__/auth/handler')).toBe(true);
    expect(denied('/__/firebase/init.json')).toBe(true);
    expect(denied('/')).toBe(false);
    expect(denied('/settings')).toBe(false);
  });
});

describe('pwaApp', () => {
  test('returns the vite-plugin-pwa plugins', () => {
    const plugins = pwaApp({ name: 'Demo', description: 'd', themeColor: '#000', backgroundColor: '#fff' });
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThan(0);
  });
});

describe('base path (docs/one-site.md)', () => {
  const app = { name: 'Pet', description: 'd', themeColor: '#000', backgroundColor: '#fff' };

  test('normalizes the path', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('pet')).toBe('/pet/');
    expect(normalizeBase('/pet')).toBe('/pet/');
    expect(normalizeBase('/pet/')).toBe('/pet/');
  });

  test("sets Vite's base", () => {
    expect(sitePath('/pet/').config()).toEqual({ base: '/pet/' });
  });

  test('an app owns its path: manifest id, start, scope, icons and share target', () => {
    const m = webManifest({ ...app, base: '/pet/', shareTarget: true });
    expect(m.id).toBe('/pet/');
    expect(m.start_url).toBe('/pet/');
    expect(m.scope).toBe('/pet/');
    expect(m.icons.map((i) => i.src)).toEqual(['/pet/pwa-192.png', '/pet/pwa-512.png', '/pet/pwa-maskable-512.png']);
    expect(m.share_target?.action).toBe('/pet/');
  });

  test('the portal keeps / so installing it covers every app', () => {
    const m = webManifest(app);
    expect([m.id, m.start_url, m.scope]).toEqual(['/', '/', '/']);
    expect(m.icons[0].src).toBe('/pwa-192.png');
  });

  test("an app's worker falls back to its own index.html", () => {
    expect(pwaWorkbox({ ...app, base: '/pet/' }).navigateFallback).toBe('/pet/index.html');
    expect(pwaWorkbox(app).navigateFallback).toBe('/index.html');
  });

  test("the portal's worker leaves other apps' paths and /__/ to the network", () => {
    const deny = navigationDenylist({ base: '/', otherApps: ['pet', '/baby/', 'home'] });
    const denied = (p: string) => deny.some((r) => r.test(p));
    for (const p of ['/pet/', '/pet', '/pet/?tab=care', '/baby/feeds', '/home/', '/__/auth/handler']) expect(denied(p), p).toBe(true);
    for (const p of ['/', '/privacy', '/petals', '/calendar', '/babysitter']) expect(denied(p), p).toBe(false);
    expect(pwaWorkbox({ ...app, otherApps: ['pet'] }).navigateFallbackDenylist).toEqual(deny.slice(0, 1).concat(navigationDenylist({ otherApps: ['pet'] }).slice(1)));
  });

  test('link previews with a base and no url point at the app on the suite site', () => {
    const out = linkPreview({ ...app, base: '/pet/' }).transformIndexHtml('<head></head>');
    expect(out).toContain(`<meta property="og:image" content="${SUITE_ORIGIN}/pet/og.png" />`);
    expect(out).toContain(`<meta property="og:url" content="${SUITE_ORIGIN}/pet/" />`);
  });

  test('link previews with neither stay relative', () => {
    const out = linkPreview({ name: app.name, description: app.description }).transformIndexHtml('<head></head>');
    expect(out).toContain('<meta property="og:image" content="/og.png" />');
    expect(out).not.toContain('og:url');
  });

  test('link previews with the app address', () => {
    const out = linkPreview({ ...app, url: 'https://example.web.app/pet/' }).transformIndexHtml('<head></head>');
    expect(out).toContain('<meta property="og:image" content="https://example.web.app/pet/og.png" />');
    expect(out).toContain('<meta property="og:url" content="https://example.web.app/pet/" />');
  });
});

describe('telemetryChunks', () => {
  type Namer = (chunk: { name: string; moduleIds: string[] }) => string;
  const namer = (user?: Parameters<ReturnType<typeof telemetryChunks>['config']>[0]) =>
    (telemetryChunks().config(user) as { build: { rollupOptions: { output: { chunkFileNames: Namer } } } }).build.rollupOptions.output.chunkFileNames;
  const agent = { name: 'jserrors', moduleIds: ['/app/node_modules/@newrelic/browser-agent/src/features/jserrors/index.js'] };
  const mixed = { name: 'index', moduleIds: ['/app/src/App.tsx', '/app/node_modules/@newrelic/browser-agent/src/x.js'] };
  const render = (template: string, chunk: { name: string }) => template.replace('[name]', chunk.name).replace('[hash]', 'abc123');

  test('names chunks made only of the New Relic agent so the precache glob skips them', () => {
    const name = namer();
    const glob = new Bun.Glob(TELEMETRY_CHUNKS);
    expect(glob.match(render(name(agent), agent))).toBe(true);
    expect(glob.match(render(name(mixed), mixed))).toBe(false);
    expect(name({ name: 'x', moduleIds: [] })).toBe('assets/[name]-[hash].js');
    const appChunk = { name: 'nr-utils', moduleIds: ['/app/src/nr-utils.ts'] };
    expect(glob.match(render(name(appChunk), appChunk))).toBe(false);
  });

  test('leaves an app with several outputs alone', () => {
    expect(telemetryChunks().config({ build: { rollupOptions: { output: [{}, {}] } } })).toEqual({});
  });

  test("keeps the app's assetsDir and its own chunkFileNames for other chunks", () => {
    const name = namer({ build: { assetsDir: 'static', rollupOptions: { output: { chunkFileNames: (c: { name: string }) => `static/js/${c.name}.js` } } } });
    expect(name(agent)).toBe('static/hh-telemetry-[name]-[hash].js');
    expect(name(mixed)).toBe('static/js/index.js');
    expect(new Bun.Glob(TELEMETRY_CHUNKS).match(render(name(agent), agent))).toBe(true);
  });

  test("pwaApp's Workbox options ignore them, alongside an app's own globIgnores", () => {
    const base = { name: 'Demo', description: 'd', themeColor: '#000', backgroundColor: '#fff' };
    expect(pwaWorkbox(base).globIgnores).toEqual([TELEMETRY_CHUNKS, 'og.png']);
    expect(pwaWorkbox({ ...base, overrides: { workbox: { globIgnores: ['**/big-*.js'] } } }).globIgnores).toEqual([TELEMETRY_CHUNKS, 'og.png', '**/big-*.js']);
  });
});

describe('linkPreview', () => {
  test('writes description, Open Graph and Twitter tags from one source, replacing old ones', () => {
    const html = '<html><head><meta name="description" content="old"><meta property="og:title" content="old"></head></html>';
    const out = linkPreview({ name: 'Huishouden Example', description: 'Looking after "things"', url: 'https://example.web.app/' }).transformIndexHtml(html);
    expect(out).not.toContain('content="old"');
    expect(out).toContain('<meta name="description" content="Looking after &quot;things&quot;" />');
    expect(out).toContain('<meta property="og:image" content="https://example.web.app/og.png" />');
    expect(out).toContain('<meta property="og:url" content="https://example.web.app/" />');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });
});

test('emulator ports: a valid number or the default', async () => {
  const { emulatorPort } = await import('../src/emulator-port');
  expect(emulatorPort('18080', 8080)).toBe(18080);
  expect(emulatorPort(undefined, 8080)).toBe(8080);
  expect(emulatorPort('x', 9099)).toBe(9099);
  expect(emulatorPort('70000', 9099)).toBe(9099);
});

test('stable chunks: React and Firebase out of the app chunk, nothing loaded lazily', async () => {
  const { STABLE_CHUNK_GROUPS, stableChunks } = await import('../src/vite');
  const [vendor] = STABLE_CHUNK_GROUPS;
  expect(vendor.test.test('/a/node_modules/react-dom/client.js')).toBe(true);
  expect(vendor.test.test('/a/node_modules/@firebase/firestore/dist/index.mjs')).toBe(true);
  expect(vendor.test.test('/a/src/App.tsx')).toBe(false);
  expect(vendor.test.test('/a/node_modules/@firebase/storage/dist/index.esm.js')).toBe(false);
  expect(vendor.test.test('/a/node_modules/@huishouden/pwa-kit/dist/ui.js')).toBe(false);
  expect(stableChunks().config({})).toEqual({ build: { rollupOptions: { output: { codeSplitting: { groups: STABLE_CHUNK_GROUPS } } } } });
  expect(stableChunks().config({ build: { rollupOptions: { output: { codeSplitting: false } } } })).toEqual({});
});

describe('updates (STANDARD.md "Updates")', () => {
  test('the worker waits for ./update to apply a new version; the first install still takes the page', () => {
    const w = pwaWorkbox({ name: 'Pet', description: 'd', themeColor: '#000', backgroundColor: '#fff', base: '/pet/' });
    expect(w.skipWaiting).toBe(false);
    expect(w.clientsClaim).toBe(true);
  });
});
