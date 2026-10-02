import { describe, expect, test } from 'bun:test';
import { firebaseConfigFromEnv } from '../src/firebase';
import { FIREBASE_RESERVED_PATHS, linkPreview, pwaApp, pwaWorkbox, telemetryChunks, TELEMETRY_CHUNKS } from '../src/vite';

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
    expect(pwaWorkbox(base).globIgnores).toEqual([TELEMETRY_CHUNKS]);
    expect(pwaWorkbox({ ...base, overrides: { workbox: { globIgnores: ['**/big-*.js'] } } }).globIgnores).toEqual([TELEMETRY_CHUNKS, '**/big-*.js']);
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
