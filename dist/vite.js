import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';
import { PUSH_SW_FILE, pushServiceWorkerSource } from './push-sw.js';
/**
 * Vite PWA plugin with the conventions every app here shares: auto-updating service worker,
 * standalone manifest with 192/512/maskable icons from public/, and Firebase-safe navigation.
 */
export function pwaApp(options) {
    const { overrides = {} } = options;
    return [buildStamp(), telemetryChunks(), linkPreview(options), ...(options.push ? [pushServiceWorkerFile()] : []), ...VitePWA({
            registerType: 'autoUpdate',
            includeAssets: options.includeAssets ?? ['icon.svg', 'apple-touch-icon.png', 'og.png'],
            ...overrides,
            manifest: { ...webManifest(options), ...(overrides.manifest || {}) },
            workbox: pwaWorkbox(options),
        })];
}
/**
 * The Workbox options `pwaApp` passes. The kit's entries in `importScripts`, `runtimeCaching` and
 * `globIgnores` are kept and an app's `overrides.workbox` entries are added after them; other
 * keys in `overrides.workbox` replace the kit's.
 */
export function pwaWorkbox(options) {
    const { importScripts = [], runtimeCaching = [], globIgnores = [], ...workboxOverrides } = options.overrides?.workbox ?? {};
    return {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: FIREBASE_RESERVED_PATHS,
        ...workboxOverrides,
        importScripts: [...(options.push ? [PUSH_SW_FILE] : []), ...importScripts],
        runtimeCaching: [...(options.ocr ? [OCR_CACHE] : []), ...runtimeCaching],
        globIgnores: [TELEMETRY_CHUNKS, ...globIgnores],
    };
}
/** The web app manifest `pwaApp` writes (before `overrides.manifest`). */
export function webManifest(options) {
    return {
        id: '/',
        name: options.name,
        short_name: options.shortName ?? options.name,
        description: options.description,
        theme_color: options.themeColor,
        background_color: options.backgroundColor,
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        ...(options.shareTarget ? { share_target: SHARE_TARGET } : {}),
        icons: options.icons ?? [
            { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    };
}
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/**
 * What a shared link shows (Messages, WhatsApp, Slack...): the page description and Open Graph /
 * Twitter tags, written from the same name and description as the manifest so there is one source.
 * Any description or og:/twitter: tags already in index.html are replaced.
 */
export function linkPreview(options) {
    const base = options.url?.replace(/\/$/, '') ?? '';
    const tags = [
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
    if (base)
        tags.push(['property', 'og:url', `${base}/`]);
    return {
        name: 'huishouden-link-preview',
        transformIndexHtml(html) {
            const cleaned = html.replace(/\s*<meta\s+(?:name="description"|(?:property|name)="(?:og|twitter):[^"]*")[^>]*>/g, '');
            const meta = tags.map(([attr, key, value]) => `    <meta ${attr}="${key}" content="${escapeAttr(value)}" />`).join('\n');
            return cleaned.replace(/<\/head>/, `${meta}\n  </head>`);
        },
    };
}
/** File-name prefix of the New Relic agent's chunks (`./observability`). */
export const TELEMETRY_PREFIX = 'hh-telemetry-';
/** Those chunks, left out of the precache (`globIgnores`), whatever the assets directory. */
export const TELEMETRY_CHUNKS = `**/${TELEMETRY_PREFIX}*.js`;
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
        apply: 'build',
        config(user = {}) {
            const dir = user.build?.assetsDir ?? 'assets';
            const output = user.build?.rollupOptions?.output;
            if (Array.isArray(output))
                return {};
            const own = output?.chunkFileNames ?? `${dir}/[name]-[hash].js`;
            return {
                build: {
                    rollupOptions: {
                        output: {
                            chunkFileNames: (chunk) => chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => id.includes('@newrelic/browser-agent'))
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
/** Emits the push handlers next to the service worker (see push-sw.ts). */
function pushServiceWorkerFile() {
    return {
        name: 'huishouden-push-sw',
        apply: 'build',
        generateBundle() {
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
    method: 'GET',
    enctype: 'application/x-www-form-urlencoded',
    params: { title: 'share_title', text: 'share_text', url: 'share_url' },
};
/** The OCR engine's files; their URLs carry exact versions, so a cached copy never goes stale. */
export const OCR_CACHE = {
    urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:tesseract\.js|tesseract\.js-core|@tesseract\.js-data\/eng)@v?\d/,
    handler: 'CacheFirst',
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
/**
 * Stamps the build with `import.meta.env.VITE_APP_VERSION` (package.json version, set by the release
 * process) and `VITE_BUILD_SHA` (short commit, from CI's GITHUB_SHA), so a running app can say exactly
 * what it is. Apps show them in their account menu or settings.
 */
export function buildStamp() {
    let version = process.env.npm_package_version;
    if (!version) {
        try {
            version = JSON.parse(readFileSync('package.json', 'utf8')).version;
        }
        catch { }
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
