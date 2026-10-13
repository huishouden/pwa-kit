import { describe, expect, test } from 'bun:test';
import {
  ASSET_FILE_LIMIT,
  ASSET_ORIGINS,
  ASSET_WORKERS,
  appsOffCdn,
  offCdnPredicate,
  cdnFallbackScript,
  cdnHints,
  cdnHeaders,
  cdnOriginIn,
  cdnWranglerConfig,
  isCdnAsset,
  namesCdn,
  parseAssetManifest,
  planAssetOrigin,
  ASSET_CORS_ORIGINS,
  retainAssets,
  SITE_PAGE,
  stripCdn,
  type AssetManifest,
} from '../src/asset-cdn';
import { cspBlocksAssets, checkSecurityHeaders, APP_PATHS_REGEX, securityHeaders } from '../src/security-headers';
import { assetCdn, assetOriginOf, cdnPrecache, navigationDenylist, pwaWorkbox } from '../src/vite';
import { FRESH_FILES, SUITE_ORIGIN } from '../src/site';
import { appOf } from '../src/suite';

const now = new Date('2026-10-05T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

describe('addresses', () => {
  test('one Worker per flavor on the account workers.dev subdomain', () => {
    expect(ASSET_ORIGINS.production).toBe('https://huishouden-assets.huishouden-app.workers.dev');
    expect(ASSET_ORIGINS.staging).toBe('https://huishouden-assets-staging.huishouden-app.workers.dev');
    expect(ASSET_WORKERS.staging).toBe('huishouden-assets-staging');
  });
});

describe('isCdnAsset', () => {
  test('files under /assets/ and /<app>/assets/ only', () => {
    expect(isCdnAsset('/assets/index-abc.js')).toBe(true);
    expect(isCdnAsset('/spending/assets/index-abc.css')).toBe(true);
    expect(isCdnAsset('/spending/assets/fonts/inter.woff2')).toBe(true);
    expect(isCdnAsset('/spending/index.html')).toBe(false);
    expect(isCdnAsset('/spending/sw.js')).toBe(false);
    expect(isCdnAsset('/hh-assets.json')).toBe(false);
    expect(isCdnAsset('/a/b/assets/x.js')).toBe(false);
    expect(isCdnAsset('/assets/../sw.js')).toBe(false);
    expect(isCdnAsset('/assets/.hidden')).toBe(false);
  });
});

describe('retainAssets', () => {
  test('live files marked now; earlier ones kept within the retention period, the rest dropped', () => {
    const previous: AssetManifest = {
      flavor: 'production',
      deployedAt: daysAgo(1),
      files: {
        '/pet/assets/old-a.js': { last: daysAgo(2) },
        '/pet/assets/old-b.js': { last: daysAgo(31) },
        '/pet/assets/index-1.js': { last: daysAgo(1) },
      },
    };
    const { manifest, carried } = retainAssets(previous, ['/pet/assets/index-1.js', '/assets/index-2.js'], 'production', now);
    expect(carried).toEqual(['/pet/assets/old-a.js']);
    expect(manifest.files).toEqual({
      '/assets/index-2.js': { last: now.toISOString() },
      '/pet/assets/index-1.js': { last: now.toISOString() },
      '/pet/assets/old-a.js': { last: daysAgo(2) },
    });
    expect(manifest.flavor).toBe('production');
  });

  test('first deploy: nothing carried', () => {
    expect(retainAssets(null, ['/assets/a.js'], 'staging', now).carried).toEqual([]);
  });

  test('over the file limit: the most recently seen earlier files win', () => {
    const files = Object.fromEntries([1, 2, 3, 4].map((d) => [`/assets/f${d}.js`, { last: daysAgo(d) }]));
    const { carried } = retainAssets({ flavor: 'production', deployedAt: daysAgo(1), files }, ['/assets/live.js'], 'production', now, 30, 3);
    expect(carried).toEqual(['/assets/f1.js', '/assets/f2.js']);
  });

  test('more live files than the limit is an error, not a silent drop', () => {
    expect(() => retainAssets(null, ['/assets/a.js', '/assets/b.js'], 'production', now, 30, 1)).toThrow();
    expect(ASSET_FILE_LIMIT).toBeLessThan(20_000);
  });

  test('entries that are not CDN assets are never carried', () => {
    const { carried } = retainAssets({ flavor: 'production', deployedAt: daysAgo(1), files: { '/sw.js': { last: daysAgo(1) } } }, [], 'production', now);
    expect(carried).toEqual([]);
  });
});

describe('parseAssetManifest', () => {
  test('accepts a manifest, refuses anything else', () => {
    const ok = { flavor: 'staging', deployedAt: daysAgo(0), files: { '/assets/a.js': { last: daysAgo(0) } } };
    expect(parseAssetManifest(ok)).toEqual(ok as AssetManifest);
    expect(parseAssetManifest(null)).toBeNull();
    expect(parseAssetManifest({ flavor: 'x', files: {} })).toBeNull();
    expect(parseAssetManifest({ ...ok, files: { '/index.html': { last: daysAgo(0) } } })).toBeNull();
    expect(parseAssetManifest({ ...ok, files: { '/assets/a.js': { last: 'soon' } } })).toBeNull();
  });
});

describe('cdnHeaders', () => {
  test('production: CORS for the suite only, immutable assets, revalidated manifest', () => {
    const h = cdnHeaders('production');
    expect(h).toContain('/*\n  Access-Control-Allow-Origin: https://huishouden-piekstra.web.app\n  Cross-Origin-Resource-Policy: cross-origin\n  X-Content-Type-Options: nosniff');
    expect(h).toContain('/assets/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(h).toContain('/:app/assets/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(h).toContain('/hh-assets.json\n  Cache-Control: no-cache');
    // The manifest's own rule is the only Cache-Control it matches.
    expect(h.split('\n').filter((l) => l.startsWith('/') && l !== '/hh-assets.json' && l !== '/*').every((l) => l.includes('assets/'))).toBe(true);
  });
  test('production CORS is the suite address itself (docs/one-site.md "Moving the suite")', () => {
    expect(ASSET_CORS_ORIGINS.production).toBe(SUITE_ORIGIN);
  });
  test('staging: any origin (a site per app, local previews)', () => {
    expect(cdnHeaders('staging')).toContain('Access-Control-Allow-Origin: *');
  });
});

describe('cdnWranglerConfig', () => {
  test('assets only, on workers.dev, 404 for a missing file', () => {
    const c = cdnWranglerConfig('staging');
    expect(c).toContain('name = "huishouden-assets-staging"');
    expect(c).toContain('workers_dev = true');
    expect(c).toContain('[assets]\ndirectory = "./public"\nnot_found_handling = "none"');
    expect(c).not.toContain('main =');
  });
});

describe('stripCdn and the fallback script', () => {
  const page = `<script data-hh-asset-fallback>${cdnFallbackScript(ASSET_ORIGINS.production, '/pet/index.site.html')}</script>\n    ${cdnHints(ASSET_ORIGINS.production)}<script type="module" crossorigin src="${ASSET_ORIGINS.production}/pet/assets/index-a.js"></script>`;
  test('turning the CDN off leaves same-site paths and a fallback that does nothing', () => {
    const off = stripCdn(page);
    expect(off).toContain('src="/pet/assets/index-a.js"');
    expect(off).toContain('})("","/pet/index.site.html");');
    expect(off).not.toContain('preconnect');
    expect(off).not.toContain('dns-prefetch');
    expect(cdnOriginIn(off)).toBeNull();
    expect(cdnOriginIn(page)).toBe(ASSET_ORIGINS.production);
  });
  test('the staging origin is not mistaken for production', () => {
    expect(cdnOriginIn(`x ${ASSET_ORIGINS.staging}/a.js`)).toBe(ASSET_ORIGINS.staging);
    expect(stripCdn(`${ASSET_ORIGINS.staging}/a.js`)).toBe('/a.js');
  });
  test('namesCdn: pages and workers, never the hashed assets', () => {
    expect(namesCdn('/pet/index.html')).toBe(true);
    expect(namesCdn('/pet/sw.js')).toBe(true);
    expect(namesCdn('/pet/assets/index-a.js')).toBe(false);
    expect(namesCdn('/pet/pwa-512.png')).toBe(false);
  });
  test('the fallback script: the site page restores the address; with an origin it listens for errors', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { location: g.location, history: g.history, addEventListener: g.addEventListener };
    const listeners: string[] = [];
    let replaced = '';
    try {
      g.addEventListener = (type: string) => listeners.push(type);
      g.history = { state: null, replaceState: (_s: unknown, _t: string, url: string) => (replaced = url) };
      g.location = { pathname: '/pet/index.site.html', hash: `#hh-from=${encodeURIComponent('/pet/care?x=1#a')}`, search: '' };
      new Function(cdnFallbackScript('', '/pet/index.site.html'))();
      expect(replaced).toBe('/pet/care?x=1#a');
      expect(listeners).toEqual([]);
      g.location = { pathname: '/pet/', hash: '', search: '' };
      new Function(cdnFallbackScript(ASSET_ORIGINS.production, '/pet/index.site.html'))();
      expect(listeners).toEqual(['load', 'error']);
    } finally {
      Object.assign(g, saved);
    }
  });
});

describe('the fallback script after the page has loaded', () => {
  test('a CDN file failing before load replaces the page once; after load it never navigates', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { location: g.location, history: g.history, addEventListener: g.addEventListener };
    const on: Record<string, (e: unknown) => void> = {};
    const replaced: string[] = [];
    try {
      g.addEventListener = (type: string, fn: (e: unknown) => void) => (on[type] = fn);
      g.location = { pathname: '/pet/', hash: '', search: '?tab=care', replace: (u: string) => replaced.push(u) };
      new Function(cdnFallbackScript(ASSET_ORIGINS.production, '/pet/index.site.html'))();
      const css = { target: { tagName: 'LINK', rel: 'stylesheet', href: `${ASSET_ORIGINS.production}/pet/assets/lazy-a.css` } };
      on.load({});
      on.error(css);
      on.error({ target: { tagName: 'SCRIPT', src: `${ASSET_ORIGINS.production}/pet/assets/index-a.js` } });
      expect(replaced, 'after load: nothing').toEqual([]);
    } finally {
      Object.assign(g, saved);
    }
    try {
      g.addEventListener = (type: string, fn: (e: unknown) => void) => (on[type] = fn);
      g.location = { pathname: '/pet/', hash: '', search: '?tab=care', replace: (u: string) => replaced.push(u) };
      new Function(cdnFallbackScript(ASSET_ORIGINS.production, '/pet/index.site.html'))();
      on.error({ target: { tagName: 'SCRIPT', src: `${ASSET_ORIGINS.production}/pet/assets/index-a.js` } });
      on.error({ target: { tagName: 'SCRIPT', src: `${ASSET_ORIGINS.production}/pet/assets/index-a.js` } });
      expect(replaced).toEqual([`/pet/index.site.html#hh-from=${encodeURIComponent('/pet/?tab=care')}`]);
    } finally {
      Object.assign(g, saved);
    }
  });
});

describe('Vite preset', () => {
  const app = { name: 'Pet', description: 'd', themeColor: '#000', backgroundColor: '#fff', base: '/pet/' };
  test('assetOriginOf: option, else HH_ASSET_ORIGIN, else none; origins only', () => {
    const env = process.env.HH_ASSET_ORIGIN;
    try {
      delete process.env.HH_ASSET_ORIGIN;
      expect(assetOriginOf({})).toBe('');
      process.env.HH_ASSET_ORIGIN = `${ASSET_ORIGINS.staging}/`;
      expect(assetOriginOf({})).toBe(ASSET_ORIGINS.staging);
      expect(assetOriginOf({ assetOrigin: ASSET_ORIGINS.production })).toBe(ASSET_ORIGINS.production);
      expect(assetOriginOf({ assetOrigin: '' })).toBe('');
      expect(() => assetOriginOf({ assetOrigin: 'http://cdn.example.com' })).toThrow();
      expect(() => assetOriginOf({ assetOrigin: 'https://cdn.example.com/x' })).toThrow();
      expect(assetOriginOf({ assetOrigin: 'http://localhost:4174' })).toBe('http://localhost:4174');
    } finally {
      if (env === undefined) delete process.env.HH_ASSET_ORIGIN;
      else process.env.HH_ASSET_ORIGIN = env;
    }
  });

  test('renderBuiltUrl: absolute CDN URLs in HTML, relative in JS and CSS, public files untouched', () => {
    const plugin = assetCdn('/pet/', ASSET_ORIGINS.production);
    const render = (plugin.config() as { experimental: { renderBuiltUrl: (f: string, o: { hostType: 'js' | 'css' | 'html'; type: 'asset' | 'public' }) => unknown } }).experimental.renderBuiltUrl;
    expect(render('assets/index-a.js', { hostType: 'html', type: 'asset' })).toBe(`${ASSET_ORIGINS.production}/pet/assets/index-a.js`);
    expect(render('assets/vendor-a.js', { hostType: 'js', type: 'asset' })).toEqual({ relative: true });
    expect(render('assets/inter-a.woff2', { hostType: 'css', type: 'asset' })).toEqual({ relative: true });
    expect(render('icon.svg', { hostType: 'html', type: 'public' })).toBeUndefined();
  });

  test('the fallback script and connection hints go first in <head>, once', () => {
    const plugin = assetCdn('/pet/', ASSET_ORIGINS.production);
    const once = plugin.transformIndexHtml.handler('<html><head><script type="module" src="x"></script></head></html>');
    expect(once.indexOf('data-hh-asset-fallback')).toBeLessThan(once.indexOf('type="module"'));
    expect(once).toContain(`<link rel="preconnect" href="${ASSET_ORIGINS.production}" crossorigin>`);
    expect(once).toContain(`<link rel="dns-prefetch" href="${ASSET_ORIGINS.production}">`);
    expect(once.indexOf('preconnect')).toBeLessThan(once.indexOf('type="module"'));
    expect(plugin.transformIndexHtml.handler(once)).toBe(once);
  });

  test('og.png (link previews only) is never precached', () => {
    expect(pwaWorkbox(app).globIgnores).toContain('og.png');
  });

  test('precache: assets/ from the CDN, everything else from the site', async () => {
    const { manifest } = await cdnPrecache('/pet/', ASSET_ORIGINS.production)([
      { url: 'assets/index-a.js', revision: null, size: 1 },
      { url: 'index.html', revision: 'r', size: 1 },
      { url: 'pwa-192.png', revision: 'r', size: 1 },
    ]);
    expect(manifest.map((e) => e.url)).toEqual([`${ASSET_ORIGINS.production}/pet/assets/index-a.js`, 'index.html', 'pwa-192.png']);
  });

  test('pwaWorkbox adds the precache rewrite only with an origin, before the app’s own transforms', () => {
    const own = async () => ({ manifest: [], warnings: [] });
    expect('manifestTransforms' in pwaWorkbox({ ...app, assetOrigin: '' })).toBe(false);
    expect(pwaWorkbox({ ...app, assetOrigin: '', overrides: { workbox: { manifestTransforms: [own] } } }).manifestTransforms).toEqual([own]);
    const t = pwaWorkbox({ ...app, assetOrigin: ASSET_ORIGINS.production, overrides: { workbox: { manifestTransforms: [own] } } }).manifestTransforms!;
    expect(t.length).toBe(2);
    expect(t[1]).toBe(own);
  });
});

describe('planAssetOrigin', () => {
  const P = ASSET_ORIGINS.production;
  const page = `<script>(${JSON.stringify(P)})</script><script src="${P}/pet/assets/a.js"></script>`;
  const files = [
    { path: '/pet/index.html', text: page },
    { path: '/pet/sw.js', text: `[{url:"${P}/pet/assets/a.js"}]` },
    { path: '/old/index.html', text: '<script src="/old/assets/b.js"></script>' },
  ];
  test('CDN on: a fallback page beside each index.html that names it, nothing else touched', () => {
    const plan = planAssetOrigin(files, P);
    expect(plan.error).toBeUndefined();
    expect(plan.naming).toBe(2);
    expect(plan.writes).toEqual([{ path: '/pet/index.site.html', text: '<script>("")</script><script src="/pet/assets/a.js"></script>' }]);
  });
  test('CDN off: every file that names it stripped', () => {
    const plan = planAssetOrigin(files, null);
    expect(plan.writes.map((w) => w.path)).toEqual(['/pet/index.html', '/pet/sw.js']);
    expect(plan.writes.every((w) => cdnOriginIn(w.text) === null)).toBe(true);
  });
  test('a build of the other flavor is refused', () => {
    expect(planAssetOrigin(files, ASSET_ORIGINS.staging).error).toContain('/pet/index.html loads its assets from');
  });
  test('an app off the CDN: its files stripped as if the CDN were off, no fallback page; the rest untouched', () => {
    const portal = { path: '/index.html', text: `<script src="${P}/assets/p.js"></script>` };
    const plan = planAssetOrigin([...files, portal], P, (path) => path.startsWith('/pet/'));
    expect(plan.error).toBeUndefined();
    expect(plan.writes.map((w) => w.path)).toEqual(['/pet/index.html', '/pet/sw.js', '/index.site.html']);
    expect(plan.writes.every((w) => cdnOriginIn(w.text) === null)).toBe(true);
  });
});

describe('apps off the CDN (a deploy without the Cloudflare token)', () => {
  const apps = ['/', '/pet/', '/spending/'];
  const live: AssetManifest = { flavor: 'production', deployedAt: daysAgo(0), files: { '/assets/p.js': { last: daysAgo(0) }, '/pet/assets/a.js': { last: daysAgo(0) } } };
  test('appOf: the longest app path a file is under', () => {
    expect(appOf('/pet/assets/a.js', apps)).toBe('/pet/');
    expect(appOf('/assets/p.js', apps)).toBe('/');
    expect(appOf('/spending/sw.js', apps)).toBe('/spending/');
    expect(appOf('/x', ['/pet/'])).toBeUndefined();
  });
  test('an app with any asset the CDN lacks is off; one it holds entirely stays on', () => {
    expect(appsOffCdn(['/assets/p.js', '/pet/assets/a.js', '/spending/assets/new.js'], apps, live)).toEqual(['/spending/']);
    expect(appsOffCdn(['/assets/p.js', '/pet/assets/a.js', '/pet/assets/b.js'], apps, live)).toEqual(['/pet/']);
    expect(appsOffCdn(['/assets/p.js', '/pet/assets/a.js', '/pet/index.html'], apps, live)).toEqual([]);
  });
  test('offCdnPredicate: files in an off app\'s folder, not the portal\'s around it', () => {
    const off = offCdnPredicate(['/pet/'], apps);
    expect(off('/pet/index.html')).toBe(true);
    expect(off('/pet/sw.js')).toBe(true);
    expect(off('/index.html')).toBe(false);
    expect(off('/spending/index.html')).toBe(false);
    expect(offCdnPredicate(['/'], apps)('/pet/index.html')).toBe(false);
  });
  test('before the CDN has a manifest every app with assets is off', () => {
    expect(appsOffCdn(['/assets/p.js', '/pet/assets/a.js'], apps, null)).toEqual(['/', '/pet/']);
  });
});

describe('the site page (fallback)', () => {
  test('never answered from the service worker cache, never cached by browsers', () => {
    expect(navigationDenylist({ base: '/pet/' }).some((r) => r.test('/pet/index.site.html'))).toBe(true);
    expect(navigationDenylist({ base: '/' }).some((r) => r.test('/index.site.html'))).toBe(true);
    expect(navigationDenylist({ base: '/pet/' }).some((r) => r.test('/pet/settings'))).toBe(false);
    expect(FRESH_FILES).toContain(SITE_PAGE);
  });
});

describe('CSP and the asset CDN', () => {
  test('the kit policy has no fetch directives, so nothing blocks the CDN', () => {
    expect(cspBlocksAssets("frame-ancestors 'none'; object-src 'none'; base-uri 'self'")).toEqual([]);
  });
  test('a fetch directive without the CDN is reported, default-src included', () => {
    expect(cspBlocksAssets("script-src 'self'; style-src 'self' https://huishouden-assets.huishouden-app.workers.dev")).toEqual(['script-src']);
    expect(cspBlocksAssets("default-src 'self'")).toEqual(['script-src (from default-src)', 'style-src (from default-src)', 'font-src (from default-src)', 'img-src (from default-src)', 'connect-src (from default-src)']);
    expect(cspBlocksAssets("default-src 'self' https:")).toEqual([]);
  });
  test('pwa-headers-check fails a firebase.json whose CSP would block the CDN', () => {
    const headers = securityHeaders().map((h) => (h.key === 'Content-Security-Policy' ? { ...h, value: `${h.value}; script-src 'self'` } : h));
    const problems = checkSecurityHeaders({ hosting: { headers: [{ regex: APP_PATHS_REGEX, headers }] } });
    expect(problems.some((p) => p.includes('script-src must allow the asset CDN'))).toBe(true);
    expect(checkSecurityHeaders({ hosting: { headers: [{ regex: APP_PATHS_REGEX, headers: securityHeaders() }] } })).toEqual([]);
  });
});
