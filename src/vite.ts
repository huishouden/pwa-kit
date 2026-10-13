import { readFileSync } from 'node:fs';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';
import { PUSH_SW_FILE, pushServiceWorkerSource } from './push-sw.js';
import { LANG_BOOT_SCRIPT } from './i18n.js';
import { THEME_BOOT_SCRIPT } from './theme.js';
import { SUITE_ORIGIN } from './site.js';
import { SITE_PAGE, cdnFallbackScript, cdnHints } from './asset-cdn.js';
import { SHARE_ACTION, SHARE_FILE_FIELD, SHARE_IMAGE_FIELD, SHARE_SW_FILE, shareServiceWorkerSource } from './share-sw.js';

export interface PwaAppOptions {
  /**
   * The path the app is served under on the suite's one site (docs/one-site.md): `/pet/` for an
   * app, `/` for the portal. Sets Vite's `base`, and the manifest's `id`, `start_url`, `scope`,
   * icons and share target, the service worker's scope and its navigation fallback. Default `/`.
   */
  base?: string;
  /**
   * The portal only: paths of the other apps on the same site (`['pet', 'baby']`). The portal's
   * worker (scope `/`) then leaves navigations to them to the network instead of answering with
   * the portal, until the app's own worker takes over its path.
   */
  otherApps?: string[];
  name: string;
  shortName?: string;
  description: string;
  themeColor: string;
  backgroundColor: string;
  /** Manifest icons; defaults to <base>pwa-192.png, pwa-512.png, pwa-maskable-512.png (what pwa-icons writes). */
  icons?: { src: string; sizes: string; type: string; purpose: string }[];
  /** Files in public/ to precache besides the build output (icons, favicons). */
  includeAssets?: string[];
  /**
   * The app's public address, with its path (`https://<site>.web.app/pet/`). Link previews need absolute URLs for the
   * page and image. Default with `base`: `base` on the suite's site (`SUITE_ORIGIN` in `./site`);
   * without either, relative ones, which some messengers ignore.
   */
  url?: string;
  /**
   * Show push notifications (@huishouden/pwa-kit/push): adds `hh-push-sw.js` to the build and
   * loads it into the generated service worker, which then shows reminders and opens their deep
   * link when tapped.
   */
  push?: boolean;
  /**
   * Cache the OCR engine (`readLabel` in ./dose, `readPlaceScreenshot` in ./places) in the service worker
   * after first use, so reading works offline: tesseract.js, its worker, WebAssembly core
   * and English data from jsDelivr, all at pinned versions.
   */
  ocr?: boolean;
  /**
   * Show the installed app in the phone's Share menu (Android and desktop Chrome; iOS has no share
   * targets), so Google Maps → Share → the app opens it with the place. Adds a manifest
   * `share_target` that launches `<base>?share_title=…&share_text=…&share_url=…`; read it with
   * `readSharedPlace(location)` from `@huishouden/pwa-kit/places`.
   *
   * `{ contacts: true }` also takes contact cards (Contacts → Share → the app): the share target
   * becomes a POST that the service worker receives (`hh-share-sw.js`), keeping the card for
   * `readSharedContact()` in `@huishouden/pwa-kit/contacts` (`?share=contact`) and sending shared
   * places on to the same `?share_title=…` address as before.
   *
   * `{ images: true }` takes photos the same way (Gallery → Share → the app, Android): the service
   * worker keeps them for `readSharedImages()` in `@huishouden/pwa-kit/shared-images`
   * (`?share=image`), which "Scan the label" (`LabelScan`'s `images`) reads.
   */
  shareTarget?: boolean | { contacts?: boolean; images?: boolean };
  /**
   * Where the build's hashed files (`<base>assets/*`) are served from (docs/one-site.md "Asset
   * CDN"): `https://huishouden-assets.huishouden-app.workers.dev`. index.html and the service
   * worker's precache name them there; the chunks reach each other by relative URL, so the same
   * build also runs from the site's own copy. Default: the `HH_ASSET_ORIGIN` environment variable,
   * which the reusable workflow sets per flavor; unset (a local build), the site's own `assets/`.
   */
  assetOrigin?: string;
  /** Overrides merged last, for anything app-specific. */
  overrides?: Partial<VitePWAOptions>;
}

/**
 * Vite PWA plugin with the conventions every app here shares: a service worker that installs new
 * versions in the background and waits to be told (`./update` applies them without interrupting
 * anyone), standalone manifest with 192/512/maskable icons from public/, and Firebase-safe navigation.
 */
export function pwaApp(options: PwaAppOptions) {
  const { overrides = {} } = options;
  const base = normalizeBase(options.base);
  const origin = assetOriginOf(options);
  return [sitePath(base), readMeter(), ...(origin ? [assetCdn(base, origin)] : []), buildStamp(), telemetryChunks(), stableChunks(), linkPreview(options), themeBoot(), langBoot(), ...(options.push ? [pushServiceWorkerFile()] : []), ...(sharesFiles(options) ? [shareServiceWorkerFile()] : []), ...VitePWA({
    // Never 'autoUpdate': it reloads the open page the moment a new worker activates, a few seconds
    // after opening the app following any deploy. `startUpdates` (./update) registers the worker itself.
    registerType: 'prompt',
    injectRegister: false,
    includeAssets: options.includeAssets ?? ['icon.svg', 'apple-touch-icon.png', 'og.png'],
    base,
    scope: base,
    ...overrides,
    manifest: { ...webManifest(options), ...(overrides.manifest || {}) },
    workbox: pwaWorkbox(options),
  })];
}

/**
 * Whether this build counts its Firestore reads (`readMeter`): builds for the emulators
 * (`VITE_USE_EMULATORS=true`, as `hh dev verify` makes for the signed-in tests) or asked for
 * (`VITE_READ_METER=true`). Never a production or staging build.
 */
export const readMeterOn = (env: Record<string, string | undefined> = process.env): boolean => env.VITE_USE_EMULATORS === 'true' || env.VITE_READ_METER === 'true';

const READ_METER = '@huishouden/pwa-kit/read-meter-browser';

/**
 * Read-budget tests in the browser (STANDARD.md "Read budgets"): every import of
 * `firebase/firestore` (the app's and the kit's) resolves to the kit's counted copy
 * (`./read-meter-browser`), which tallies the reads Firestore bills for each result and snapshot in
 * `window.__hhReads`; `expectPageReads` in `./e2e` reads it.
 */
export function readMeter() {
  // Decided from Vite's resolved environment (shell variables and the mode's .env files), the same
  // `VITE_USE_EMULATORS` the app reads (./app); off until the config is resolved.
  let on = false;
  return {
    name: 'huishouden-read-meter',
    enforce: 'pre' as const,
    configResolved(config: { env: Record<string, unknown> }) {
      on = readMeterOn({ ...process.env, ...(config.env as Record<string, string | undefined>) });
    },
    async resolveId(this: { resolve: (id: string, importer?: string, options?: { skipSelf?: boolean }) => Promise<unknown> }, source: string, importer?: string) {
      if (!on || source !== 'firebase/firestore' || !importer || /read-meter-browser\.[jt]s$/.test(importer)) return null;
      return this.resolve(READ_METER, importer, { skipSelf: true });
    },
  };
}

/** `assetOrigin`, else `HH_ASSET_ORIGIN`; an https origin without a trailing slash, or '' for none. */
export function assetOriginOf(options: Pick<PwaAppOptions, 'assetOrigin'>): string {
  const raw = (options.assetOrigin ?? process.env.HH_ASSET_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const url = new URL(raw);
  if (url.origin !== raw || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
    throw new Error(`assetOrigin must be an https origin with no path, got ${raw}`);
  }
  return raw;
}

/**
 * The build's hashed files from the asset CDN (docs/one-site.md "Asset CDN"): index.html names
 * them at `origin` (Vite's `renderBuiltUrl`), while JS and CSS reach each other and their images
 * and fonts by relative URL, so a build loaded from the site's own copy stays there. index.html
 * gets the one-time fallback script and the connection hints (`preconnect`, `dns-prefetch`) first in <head>.
 */
export function assetCdn(base: string, origin: string) {
  return {
    name: 'huishouden-asset-cdn',
    apply: 'build' as const,
    config: () => ({
      experimental: {
        renderBuiltUrl(filename: string, { hostType, type }: { hostType: 'js' | 'css' | 'html'; type: 'asset' | 'public' }) {
          if (type === 'public') return undefined;
          return hostType === 'html' ? `${origin}${base}${filename}` : { relative: true };
        },
      },
    }),
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string) {
        if (html.includes('data-hh-asset-fallback')) return html;
        return html.replace(/<head>/, `<head>\n    <script data-hh-asset-fallback>${cdnFallbackScript(origin, `${base}${SITE_PAGE}`)}</script>\n    ${cdnHints(origin)}`);
      },
    },
  };
}

/** Workbox `manifestTransforms` entry: the precache fetches `assets/*` from `origin` (with CORS), the rest from the site. */
export function cdnPrecache(base: string, origin: string) {
  return async (entries: { url: string; revision: string | null; size: number }[]) => ({
    manifest: entries.map((e) => (e.url.startsWith('assets/') ? { ...e, url: `${origin}${base}${e.url}` } : e)),
    warnings: [] as string[],
  });
}

/** `pet`, `/pet` or `/pet/` as `/pet/`; empty or missing as `/`. */
export function normalizeBase(base?: string): string {
  const trimmed = (base ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/** Sets Vite's `base` from `pwaApp({ base })`, so the app states its path once. */
export function sitePath(base: string) {
  return {
    name: 'huishouden-site-path',
    config: () => ({ base }),
  };
}

/**
 * Navigations the worker at `base` must leave to the network: Firebase's `/__/` pages and, for the
 * portal, every other app's path on the same site.
 */
export function navigationDenylist(options: Pick<PwaAppOptions, 'base' | 'otherApps'>): RegExp[] {
  const paths = (options.otherApps ?? []).map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const escaped = paths.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return [...FIREBASE_RESERVED_PATHS, SITE_PAGE_PATH, ...(escaped.length ? [new RegExp(`^/(?:${escaped.join('|')})(?:/|$)`)] : [])];
}

/**
 * The Workbox options `pwaApp` passes. The kit's entries in `importScripts`, `runtimeCaching`,
 * `globIgnores` and `manifestTransforms` are kept and an app's `overrides.workbox` entries are added after them; other
 * keys in `overrides.workbox` replace the kit's.
 */
export function pwaWorkbox(options: PwaAppOptions) {
  const { importScripts = [], runtimeCaching = [], globIgnores = [], manifestTransforms = [], ...workboxOverrides } = options.overrides?.workbox ?? {};
  const origin = assetOriginOf(options);
  return {
    globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
    // A new version waits (no skipWaiting) until ./update sends SKIP_WAITING; the first install still
    // takes the open page at once, so it works offline after one visit.
    skipWaiting: false,
    clientsClaim: true,
    navigateFallback: `${normalizeBase(options.base)}index.html`,
    navigateFallbackDenylist: navigationDenylist(options),
    ...workboxOverrides,
    importScripts: [...(options.push ? [PUSH_SW_FILE] : []), ...(sharesFiles(options) ? [SHARE_SW_FILE] : []), ...importScripts],
    runtimeCaching: [...(options.ocr ? [OCR_CACHE] : []), ...runtimeCaching],
    globIgnores: [TELEMETRY_CHUNKS, ...OG_IMAGE, ...globIgnores],
    ...(origin || manifestTransforms.length ? { manifestTransforms: [...(origin ? [cdnPrecache(normalizeBase(options.base), origin)] : []), ...manifestTransforms] } : {}),
  };
}

/** The web app manifest `pwaApp` writes (before `overrides.manifest`). */
export function webManifest(options: PwaAppOptions) {
  const base = normalizeBase(options.base);
  return {
    id: base,
    name: options.name,
    short_name: options.shortName ?? options.name,
    description: options.description,
    theme_color: options.themeColor,
    background_color: options.backgroundColor,
    display: 'standalone' as const,
    orientation: 'any' as const,
    start_url: base,
    scope: base,
    ...(options.shareTarget ? { share_target: sharesFiles(options) ? shareTargetFiles(options) : { ...SHARE_TARGET, action: base } } : {}),
    icons: options.icons ?? [
      { src: `${base}pwa-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}pwa-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}pwa-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * What a shared link shows (Messages, WhatsApp, Slack...): the page description and Open Graph /
 * Twitter tags, written from the same name and description as the manifest so there is one source.
 * Any description or og:/twitter: tags already in index.html are replaced.
 */
export function linkPreview(options: Pick<PwaAppOptions, 'name' | 'description' | 'url' | 'base'>) {
  const url = options.url ?? (options.base !== undefined ? new URL(normalizeBase(options.base), SUITE_ORIGIN).href : undefined);
  const base = url?.replace(/\/$/, '') ?? normalizeBase(options.base).replace(/\/$/, '');
  const tags: [string, string, string][] = [
    ['name', 'description', options.description],
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'Huishouden'],
    ['property', 'og:title', options.name],
    ['property', 'og:description', options.description],
    ['property', 'og:image', `${base}/og.png`],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', options.name],
    ['name', 'twitter:description', options.description],
    ['name', 'twitter:image', `${base}/og.png`],
  ];
  if (url) tags.push(['property', 'og:url', `${base}/`]);
  return {
    name: 'huishouden-link-preview',
    transformIndexHtml(html: string) {
      const cleaned = html.replace(/\s*<meta\s+(?:name="description"|(?:property|name)="(?:og|twitter):[^"]*")[^>]*>/g, '');
      const meta = tags.map(([attr, key, value]) => `    <meta ${attr}="${key}" content="${escapeAttr(value)}" />`).join('\n');
      return cleaned.replace(/<\/head>/, `${meta}\n  </head>`);
    },
  };
}

/**
 * The suite's light/dark choice (./theme) applied before the first paint: a small inline script at
 * the end of <head> puts `.dark` on <html> and sets `color-scheme` and the theme-color meta, so a
 * dark page never flashes light while the app's bundle loads.
 */
export function themeBoot() {
  return {
    name: 'huishouden-theme-boot',
    transformIndexHtml(html: string) {
      if (html.includes('data-hh-theme-boot')) return html;
      return html.replace(/<\/head>/, `    <script data-hh-theme-boot>${THEME_BOOT_SCRIPT}</script>\n  </head>`);
    },
  };
}

/**
 * The suite's language (./i18n) on <html lang> before the first paint: the stored choice, else the
 * first of the device's languages the suite speaks, else English. Screen readers and the browser's
 * hyphenation and translate offer read it before the app's bundle loads.
 */
export function langBoot() {
  return {
    name: 'huishouden-lang-boot',
    transformIndexHtml(html: string) {
      if (html.includes('data-hh-lang-boot')) return html;
      return html.replace(/<\/head>/, `    <script data-hh-lang-boot>${LANG_BOOT_SCRIPT}</script>\n  </head>`);
    },
  };
}

/**
 * The link-preview image (`og.png`, 1200x630) is for messengers' crawlers, never shown in the app:
 * left out of the precache, which saves every install about 25 KB of Hosting transfer.
 */
export const OG_IMAGE = ['og.png'];

/** File-name prefix of the New Relic agent's chunks (`./observability`). */
export const TELEMETRY_PREFIX = 'hh-telemetry-';
/** Those chunks, left out of the precache (`globIgnores`), whatever the assets directory. */
export const TELEMETRY_CHUNKS = `**/${TELEMETRY_PREFIX}*.js`;

type ChunkInfo = { moduleIds: string[]; name: string };
type ChunkFileNames = string | ((chunk: ChunkInfo) => string);

/**
 * Names the browser agent's lazily loaded chunks `<assetsDir>/hh-telemetry-*.js`, so the service worker
 * doesn't precache them: about 35 files a device would download on every update for reports that
 * only matter online, and that slow the first install enough to miss "controlled after one
 * reload". Other chunks keep the app's own `chunkFileNames`, or Vite's default. An app with several
 * Rollup outputs is left alone (its agent chunks are then precached).
 */
export function telemetryChunks() {
  return {
    name: 'huishouden-telemetry-chunks',
    apply: 'build' as const,
    config(user: { build?: { assetsDir?: string; rollupOptions?: { output?: unknown } } } = {}) {
      const dir = user.build?.assetsDir ?? 'assets';
      const output = user.build?.rollupOptions?.output;
      if (Array.isArray(output)) return {};
      const own = (output as { chunkFileNames?: ChunkFileNames } | undefined)?.chunkFileNames ?? `${dir}/[name]-[hash].js`;
      return {
        build: {
          rollupOptions: {
            output: {
              chunkFileNames: (chunk: ChunkInfo) =>
                chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => id.includes('@newrelic/browser-agent'))
                  ? `${dir}/${TELEMETRY_PREFIX}[name]-[hash].js`
                  : typeof own === 'function'
                    ? own(chunk)
                    : own,
            },
          },
        },
      };
    },
  };
}

/**
 * Libraries every page loads at start and that change only when the lockfile does: React and the
 * Firebase SDK's app, Auth and Firestore. Named one by one: a group also captures modules reached
 * only by dynamic import, so anything an app or the kit loads lazily (Storage, the kit's own
 * lazy modules, locales) must not match, or it would load with the first page.
 */
export const STABLE_CHUNK_GROUPS = [
  {
    name: 'vendor',
    test: /node_modules[\\/](react|react-dom|scheduler|firebase[\\/](app|auth|firestore)|@firebase[\\/](app|auth|firestore|util|component|logger|webchannel-wrapper))[\\/]/,
    priority: 3,
  },
];

/**
 * Splits React and Firebase (`vendor-*.js`) out of the app's own code, so a deploy that changes
 * only the app keeps that file's hash: an installed copy downloads the app's chunk on update, not
 * the whole bundle again (about 300 KB compressed per app before). Hosting transfer is the suite's
 * scarcest free resource (docs/one-site.md "Bandwidth"). Needs Vite 8 (Rolldown's
 * `output.codeSplitting`); Rollup ignores it. An app that sets its own codeSplitting or several
 * outputs is left alone.
 */
export function stableChunks() {
  return {
    name: 'huishouden-stable-chunks',
    apply: 'build' as const,
    config(user: { build?: { rollupOptions?: { output?: unknown } } } = {}) {
      const output = user.build?.rollupOptions?.output;
      if (Array.isArray(output) || (output as { codeSplitting?: unknown } | undefined)?.codeSplitting !== undefined) return {};
      return { build: { rollupOptions: { output: { codeSplitting: { groups: STABLE_CHUNK_GROUPS } } } } };
    },
  };
}

/** Emits the share target's handler next to the service worker (see share-sw.ts). */
function shareServiceWorkerFile() {
  return {
    name: 'huishouden-share-sw',
    apply: 'build' as const,
    generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string }) {
      this.emitFile({ type: 'asset', fileName: SHARE_SW_FILE, source: shareServiceWorkerSource() });
    },
  };
}

const sharesContacts = (options: Pick<PwaAppOptions, 'shareTarget'>) => typeof options.shareTarget === 'object' && options.shareTarget.contacts === true;
const sharesImages = (options: Pick<PwaAppOptions, 'shareTarget'>) => typeof options.shareTarget === 'object' && options.shareTarget.images === true;
/** Either kind of file needs the POST target and its service worker. */
const sharesFiles = (options: Pick<PwaAppOptions, 'shareTarget'>) => sharesContacts(options) || sharesImages(options);

/** `SHARE_TARGET_FILES` narrowed to the kinds of file the app asked for. */
export function shareTargetFiles(options: Pick<PwaAppOptions, 'shareTarget'>) {
  const files = [
    ...(sharesContacts(options) ? SHARE_TARGET_FILES.params.files : []),
    ...(sharesImages(options) ? [{ name: SHARE_IMAGE_FIELD, accept: ['image/*'] }] : []),
  ];
  return { ...SHARE_TARGET_FILES, params: { ...SHARE_TARGET_FILES.params, files } };
}

/** Emits the push handlers next to the service worker (see push-sw.ts). */
function pushServiceWorkerFile() {
  return {
    name: 'huishouden-push-sw',
    apply: 'build' as const,
    generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string }) {
      this.emitFile({ type: 'asset', fileName: PUSH_SW_FILE, source: pushServiceWorkerSource() });
    },
  };
}

/**
 * GET share targets replace the action URL's query, so the parameter names carry the marker.
 * Same names as `SHARE_PARAMS` in ./places (kept apart: this file runs in Node at build time).
 */
export const SHARE_TARGET = {
  action: '/',
  method: 'GET' as const,
  enctype: 'application/x-www-form-urlencoded',
  params: { title: 'share_title', text: 'share_text', url: 'share_url' },
};

/**
 * The share target with contact cards (`shareTarget: { contacts: true }`): files need a POST,
 * received by the service worker (`hh-share-sw.js`). The action is relative, so it resolves
 * against the manifest and stays inside the app's scope wherever the app is served.
 */
export const SHARE_TARGET_FILES = {
  action: SHARE_ACTION,
  method: 'POST' as const,
  enctype: 'multipart/form-data',
  params: {
    ...SHARE_TARGET.params,
    files: [{ name: SHARE_FILE_FIELD, accept: ['text/vcard', 'text/x-vcard', 'text/directory', '.vcf', '.vcard'] }],
  },
};

/** The OCR engine's files; their URLs carry exact versions, so a cached copy never goes stale. */
export const OCR_CACHE = {
  urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:tesseract\.js|tesseract\.js-core|@tesseract\.js-data\/eng)@v?\d/,
  handler: 'CacheFirst' as const,
  options: {
    cacheName: 'hh-ocr',
    expiration: { maxEntries: 20, maxAgeSeconds: 365 * 86_400 },
    cacheableResponse: { statuses: [0, 200] },
  },
};

/**
 * Firebase Hosting serves its own pages under /__/ (the sign-in popup at /__/auth/handler, SDK
 * config at /__/firebase/init.json). A service worker that answers those navigations with the
 * cached app turns "Sign in with Google" into a popup showing the app itself.
 */
export const FIREBASE_RESERVED_PATHS = [/^\/__\//];

/** The site's own copy of the page (./asset-cdn `SITE_PAGE`), the CDN fallback: always from the network. */
export const SITE_PAGE_PATH = /\/index\.site\.html$/;

/**
 * Stamps the build with `import.meta.env.VITE_APP_VERSION` (the release tag CI computed, from the
 * environment; else package.json's version, 0.0.0 in a repo CI versions by tag) and `VITE_BUILD_SHA` (short commit, from CI's GITHUB_SHA), so a running app can say exactly
 * what it is. Apps show them in their account menu or settings.
 */
export function buildStamp() {
  let version = process.env.VITE_APP_VERSION || process.env.npm_package_version;
  if (!version) {
    try {
      version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    } catch {}
  }
  const sha = (process.env.GITHUB_SHA ?? '').slice(0, 7) || 'local';
  return {
    name: 'huishouden-build-stamp',
    config: () => ({
      define: {
        'import.meta.env.VITE_APP_VERSION': JSON.stringify(version ?? '0.0.0'),
        'import.meta.env.VITE_BUILD_SHA': JSON.stringify(sha),
      },
    }),
  };
}
