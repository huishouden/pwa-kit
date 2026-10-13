/**
 * The asset CDN (docs/one-site.md "Asset CDN"): the suite's hashed build files (`<base>assets/*`:
 * JS, CSS, fonts, wasm, imported images) are served from a Cloudflare Worker with static assets
 * instead of Firebase Hosting, whose free plan has 10 GB of transfer a month for the whole suite.
 * Cloudflare serves static assets free and without a request limit. HTML, `sw.js`, the web
 * manifest and icons stay on Firebase, so the app's address, service worker scope and install
 * identity do not change; Firebase keeps a copy of every asset too, which the page falls back to.
 *
 * This module is the pure part: the CDN's addresses, its `_headers`, the Worker's config, which
 * earlier files a deploy keeps, and the page's fallback script. `pwa-site cdn` builds the upload
 * and the reusable workflow deploys it with wrangler, before Firebase deploys the HTML.
 */

import { SUITE_ORIGIN, appOf } from './suite.js';

export type Flavor = 'production' | 'staging';

/** The Worker that serves each flavor's assets (Workers static assets, no script). */
export const ASSET_WORKERS: Record<Flavor, string> = {
  production: 'huishouden-assets',
  staging: 'huishouden-assets-staging',
};

/** The account's workers.dev subdomain, shared with the connector and calendar Workers. */
export const WORKERS_SUBDOMAIN = 'huishouden-app.workers.dev';

/** `https://<worker>.<WORKERS_SUBDOMAIN>`: where each flavor's built pages load their assets from. */
export const ASSET_ORIGINS: Record<Flavor, string> = {
  production: `https://${ASSET_WORKERS.production}.${WORKERS_SUBDOMAIN}`,
  staging: `https://${ASSET_WORKERS.staging}.${WORKERS_SUBDOMAIN}`,
};

/**
 * Who may read the assets with CORS (module scripts and the service worker's precache fetch with
 * CORS). Production: the suite's site only (`SUITE_ORIGIN`); a page opened at the project's
 * firebaseapp.com host fails CORS and falls back to the site's own assets. Staging has a site per
 * app plus the suite's, and local previews, and one header value can't list several origins, so any.
 */
export const ASSET_CORS_ORIGINS: Record<Flavor, string> = {
  production: SUITE_ORIGIN,
  staging: '*',
};

/** Written at the CDN's root: every file it serves and when each was last part of a live build. */
export const ASSET_MANIFEST = 'hh-assets.json';

/**
 * How long a file stays on the CDN after the last deploy that held it: a page loaded before an
 * update still finds its lazily loaded chunks, and a service worker that was installing its
 * precache finishes. Firebase keeps no history at all, so this is more than before.
 */
export const ASSET_RETENTION_DAYS = 30;

/** Workers static assets on the free plan: at most 20,000 files per version. Kept below with room to spare. */
export const ASSET_FILE_LIMIT = 18_000;

export interface AssetManifest {
  flavor: Flavor;
  deployedAt: string;
  /** By path (`/spending/assets/index-abc.js`): when it was last part of a live build. */
  files: Record<string, { last: string }>;
}

/** Whether `path` (from the site's root) is one the CDN serves: a file in `/assets/` or `/<app>/assets/`. */
export function isCdnAsset(path: string): boolean {
  return /^\/(?:[a-z0-9-]+\/)?assets\/[^/]+(?:\/[^/]+)*$/.test(path) && !path.split('/').some((p) => p === '..' || p.startsWith('.'));
}

/**
 * The next manifest and which earlier files to carry over: every file of this deploy (`live`)
 * marked as seen now, plus earlier files last seen within the retention period, newest first, up to
 * the file limit. `previous` is the CDN's current manifest (null on the first deploy).
 */
export function retainAssets(
  previous: AssetManifest | null,
  live: string[],
  flavor: Flavor,
  now: Date,
  retentionDays = ASSET_RETENTION_DAYS,
  limit = ASSET_FILE_LIMIT,
): { manifest: AssetManifest; carried: string[] } {
  const at = now.toISOString();
  const liveSet = new Set(live);
  if (liveSet.size > limit) throw new Error(`${liveSet.size} live assets is more than the CDN's ${limit}`);
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const earlier = Object.entries(previous?.files ?? {})
    .filter(([path, { last }]) => !liveSet.has(path) && isCdnAsset(path) && Date.parse(last) >= cutoff)
    .sort(([, a], [, b]) => Date.parse(b.last) - Date.parse(a.last))
    .slice(0, limit - liveSet.size);
  const files: AssetManifest['files'] = {};
  for (const path of [...liveSet].sort()) files[path] = { last: at };
  for (const [path, entry] of earlier) files[path] = { last: entry.last };
  return { manifest: { flavor, deployedAt: at, files }, carried: earlier.map(([path]) => path).sort() };
}

/** Parses a manifest fetched from the CDN; null for anything that isn't one. */
export function parseAssetManifest(json: unknown): AssetManifest | null {
  const m = json as AssetManifest | null;
  if (!m || typeof m !== 'object' || (m.flavor !== 'production' && m.flavor !== 'staging') || !m.files || typeof m.files !== 'object') return null;
  for (const [path, entry] of Object.entries(m.files)) if (!isCdnAsset(path) || typeof entry?.last !== 'string' || Number.isNaN(Date.parse(entry.last))) return null;
  return m;
}

/**
 * The CDN's `_headers` (Workers static assets): CORS for the site, a year's immutable caching for
 * the hashed files, readable cross-origin, never sniffed. The manifest is revalidated every time.
 * Content-Type comes from the file's extension.
 */
export function cdnHeaders(flavor: Flavor): string {
  const all = [
    `  Access-Control-Allow-Origin: ${ASSET_CORS_ORIGINS[flavor]}`,
    '  Cross-Origin-Resource-Policy: cross-origin',
    '  X-Content-Type-Options: nosniff',
  ];
  const immutable = ['  Cache-Control: public, max-age=31536000, immutable'];
  return [
    '/*',
    ...all,
    '/assets/*',
    ...immutable,
    '/:app/assets/*',
    ...immutable,
    `/${ASSET_MANIFEST}`,
    '  Cache-Control: no-cache',
    '',
  ].join('\n');
}

/** The Worker's wrangler.toml: static assets only, no script, on workers.dev; a missing file is a 404. */
export function cdnWranglerConfig(flavor: Flavor, directory = './public', compatibilityDate = '2026-09-01'): string {
  return [
    `# Generated by pwa-site cdn (@huishouden/pwa-kit, docs/one-site.md "Asset CDN"); not edited by hand.`,
    `name = "${ASSET_WORKERS[flavor]}"`,
    `compatibility_date = "${compatibilityDate}"`,
    'workers_dev = true',
    'preview_urls = false',
    '',
    '[assets]',
    `directory = "${directory}"`,
    'not_found_handling = "none"',
    'html_handling = "none"',
    '',
  ].join('\n');
}

/** Files of a built site that name the CDN and are served by Firebase: pages, service workers and their helpers (never the hashed assets). */
export function namesCdn(path: string): boolean {
  return !isCdnAsset(path) && /\.(?:html|js|json|webmanifest)$/.test(path);
}

/**
 * The site's files with the CDN turned off: every CDN address removed, so pages and the service
 * worker load the same files from the site's own `/<app>/assets/` (Firebase holds a copy of every
 * asset). The rollback, and what a deploy without the Cloudflare token serves.
 */
export function stripCdn(text: string): string {
  let out = text;
  for (const origin of Object.values(ASSET_ORIGINS)) {
    const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\s*<link rel="(?:preconnect|dns-prefetch)" href="${escaped}"[^>]*>`, 'g'), '');
    out = out.split(origin).join('');
  }
  return out;
}

/**
 * The connection hints for the CDN, right after the fallback script: the browser opens the TLS
 * connection (with CORS credentials mode, as the module scripts use) while it parses the page.
 */
export function cdnHints(origin: string): string {
  return `<link rel="preconnect" href="${origin}" crossorigin>\n    <link rel="dns-prefetch" href="${origin}">`;
}

/**
 * What the assembler does to the site's pages for `origin` (null: the CDN off): with the CDN on,
 * checks every page and worker names at most that origin and writes `index.site.html` (the
 * fallback, `stripCdn`) beside each index.html that names it; off, strips the CDN from every file
 * that names it. `files` are the site's files that `namesCdn` picks, by path from the site's root.
 * `offCdn` (with an origin): files whose app's assets the CDN does not hold yet (`appsOffCdn`),
 * stripped as if the CDN were off for that app alone.
 */
export function planAssetOrigin(
  files: { path: string; text: string }[],
  origin: string | null,
  offCdn: (path: string) => boolean = () => false,
): { writes: { path: string; text: string }[]; naming: number; error?: string } {
  const writes: { path: string; text: string }[] = [];
  let naming = 0;
  for (const { path, text } of files) {
    const named = cdnOriginIn(text);
    if (!named) continue;
    naming++;
    if (origin && named !== origin) return { writes: [], naming, error: `${path} loads its assets from ${named}, not this deploy's ${origin} (a build of the other flavor?)` };
    if (!origin || offCdn(path)) writes.push({ path, text: stripCdn(text) });
    else if (path.endsWith('/index.html')) writes.push({ path: path.replace(/index\.html$/, SITE_PAGE), text: stripCdn(text) });
  }
  return { writes, naming };
}

/** `planAssetOrigin`'s `offCdn` for the apps `offApps` (of `appPaths`): whether a file is in one of their folders. */
export function offCdnPredicate(offApps: string[], appPaths: string[]): (path: string) => boolean {
  const off = new Set(offApps);
  return (path) => {
    const app = appOf(path, appPaths);
    return app !== undefined && off.has(app);
  };
}

/**
 * The apps (of `appPaths`) with an asset the live CDN (`live`, its manifest; null: none yet) does
 * not hold. A deploy without the Cloudflare token can't upload them, so their pages load the
 * site's own copy until a deploy with the token (the portal's) puts them on the CDN; every other
 * app keeps the CDN, so no page ever names a file the CDN lacks.
 */
export function appsOffCdn(assets: string[], appPaths: string[], live: AssetManifest | null): string[] {
  const off = new Set<string>();
  for (const path of assets) {
    if (!isCdnAsset(path) || live?.files[path]) continue;
    const app = appOf(path, appPaths);
    if (app !== undefined) off.add(app);
  }
  return [...off].sort();
}

/** The asset origin a built file names, if any. */
export function cdnOriginIn(text: string): string | null {
  return Object.values(ASSET_ORIGINS).find((o) => text.includes(o)) ?? null;
}

/** The site's own copy of each app's page with the CDN removed (`stripCdn`), next to its index.html. */
export const SITE_PAGE = 'index.site.html';

/**
 * The page's fallback, inline first in <head>. When, before the page has loaded, a script or
 * stylesheet from the CDN fails to load or a CDN script fails to parse (the CDN's Brotli reaching a
 * client that didn't ask for it, through a proxy that rewrote Accept-Encoding), the page is
 * replaced once by `<base>index.site.html`, the same page naming the site's own assets, with the
 * address kept in the fragment. That page (origin empty) only puts the address back, before the
 * app reads it. The service worker leaves index.site.html to the network. Once the page has loaded
 * it never navigates: a file loaded later that fails (a lazy chunk) is the app's to handle, and
 * `./update` offers the new version instead of taking the person away from what they were doing.
 */
export function cdnFallbackScript(origin: string, sitePage: string): string {
  return `(function(o,p){var k="#hh-from=";if(location.pathname===p&&location.hash.indexOf(k)===0){try{history.replaceState(history.state,"",decodeURIComponent(location.hash.slice(k.length)))}catch(x){}}if(!o)return;var gone=0,loaded=0;addEventListener("load",function(){loaded=1});addEventListener("error",function(e){var t=e.target,u=t&&t.tagName?t.src||t.href||"":e.filename||"";if(gone||u.indexOf(o+"/"))return;if(loaded)return;if(t&&t.tagName){if(t.tagName==="LINK"&&t.rel!=="stylesheet")return}else if(!e.error||e.error.name!=="SyntaxError")return;gone=1;location.replace(p+k+encodeURIComponent(location.pathname+location.search+location.hash))},true)})(${JSON.stringify(origin)},${JSON.stringify(sitePage)});`;
}
