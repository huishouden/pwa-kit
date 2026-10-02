import { type VitePWAOptions } from 'vite-plugin-pwa';
export interface PwaAppOptions {
    name: string;
    shortName?: string;
    description: string;
    themeColor: string;
    backgroundColor: string;
    /** Manifest icons; defaults to /pwa-192.png, /pwa-512.png, /pwa-maskable-512.png (what pwa-icons writes). */
    icons?: {
        src: string;
        sizes: string;
        type: string;
        purpose: string;
    }[];
    /** Files in public/ to precache besides the build output (icons, favicons). */
    includeAssets?: string[];
    /**
     * The app's public address (https://<site>.web.app). Link previews need absolute URLs for the
     * page and image; without it they fall back to relative ones, which some messengers ignore.
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
     * `share_target` that launches `/?share_title=…&share_text=…&share_url=…`; read it with
     * `readSharedPlace(location)` from `@huishouden/pwa-kit/places`.
     */
    shareTarget?: boolean;
    /** Overrides merged last, for anything app-specific. */
    overrides?: Partial<VitePWAOptions>;
}
/**
 * Vite PWA plugin with the conventions every app here shares: auto-updating service worker,
 * standalone manifest with 192/512/maskable icons from public/, and Firebase-safe navigation.
 */
export declare function pwaApp(options: PwaAppOptions): ({
    name: string;
    config: () => {
        define: {
            'import.meta.env.VITE_APP_VERSION': string;
            'import.meta.env.VITE_BUILD_SHA': string;
        };
    };
} | {
    name: string;
    apply: "build";
    config(user?: {
        build?: {
            assetsDir?: string;
            rollupOptions?: {
                output?: unknown;
            };
        };
    }): {
        build?: undefined;
    } | {
        build: {
            rollupOptions: {
                output: {
                    chunkFileNames: (chunk: ChunkInfo) => string;
                };
            };
        };
    };
} | {
    name: string;
    transformIndexHtml(html: string): string;
} | {
    name: string;
    apply: "build";
    generateBundle(this: {
        emitFile(file: {
            type: "asset";
            fileName: string;
            source: string;
        }): string;
    }): void;
} | import("vite").Plugin<any>)[];
/**
 * The Workbox options `pwaApp` passes. The kit's entries in `importScripts`, `runtimeCaching` and
 * `globIgnores` are kept and an app's `overrides.workbox` entries are added after them; other
 * keys in `overrides.workbox` replace the kit's.
 */
export declare function pwaWorkbox(options: PwaAppOptions): {
    importScripts: string[];
    runtimeCaching: (import("workbox-build").RuntimeCaching | {
        urlPattern: RegExp;
        handler: "CacheFirst";
        options: {
            cacheName: string;
            expiration: {
                maxEntries: number;
                maxAgeSeconds: number;
            };
            cacheableResponse: {
                statuses: number[];
            };
        };
    })[];
    globIgnores: string[];
    additionalManifestEntries?: Array<string | import("workbox-build").ManifestEntry> | undefined;
    dontCacheBustURLsMatching?: RegExp | undefined;
    manifestTransforms?: Array<import("workbox-build").ManifestTransform> | undefined;
    maximumFileSizeToCacheInBytes?: number | undefined;
    modifyURLPrefix?: {
        [key: string]: string;
    } | undefined;
    globFollow?: boolean | undefined;
    globPatterns: Array<string>;
    templatedURLs?: {
        [key: string]: string | Array<string>;
    } | undefined;
    babelPresetEnvTargets?: Array<string> | undefined;
    cacheId?: string | null | undefined;
    cleanupOutdatedCaches?: boolean | undefined;
    clientsClaim?: boolean | undefined;
    directoryIndex?: string | null | undefined;
    disableDevLogs?: boolean | undefined;
    ignoreURLParametersMatching?: Array<RegExp> | undefined;
    inlineWorkboxRuntime?: boolean | undefined;
    mode?: string | null | undefined;
    navigateFallback: string | null;
    navigateFallbackAllowlist?: Array<RegExp> | undefined;
    navigateFallbackDenylist: Array<RegExp>;
    navigationPreload?: boolean | undefined;
    offlineGoogleAnalytics?: (boolean | import("workbox-google-analytics/initialize.js").GoogleAnalyticsInitializeOptions) | undefined;
    skipWaiting?: boolean | undefined;
    sourcemap?: boolean | undefined;
    swDest?: string | undefined;
    globDirectory?: string | undefined;
};
/** The web app manifest `pwaApp` writes (before `overrides.manifest`). */
export declare function webManifest(options: PwaAppOptions): {
    icons: {
        src: string;
        sizes: string;
        type: string;
        purpose: string;
    }[];
    share_target?: {
        action: string;
        method: "GET";
        enctype: string;
        params: {
            title: string;
            text: string;
            url: string;
        };
    } | undefined;
    id: string;
    name: string;
    short_name: string;
    description: string;
    theme_color: string;
    background_color: string;
    display: "standalone";
    orientation: "any";
    start_url: string;
    scope: string;
};
/**
 * What a shared link shows (Messages, WhatsApp, Slack...): the page description and Open Graph /
 * Twitter tags, written from the same name and description as the manifest so there is one source.
 * Any description or og:/twitter: tags already in index.html are replaced.
 */
export declare function linkPreview(options: Pick<PwaAppOptions, 'name' | 'description' | 'url'>): {
    name: string;
    transformIndexHtml(html: string): string;
};
/** File-name prefix of the New Relic agent's chunks (`./observability`). */
export declare const TELEMETRY_PREFIX = "hh-telemetry-";
/** Those chunks, left out of the precache (`globIgnores`), whatever the assets directory. */
export declare const TELEMETRY_CHUNKS = "**/hh-telemetry-*.js";
type ChunkInfo = {
    moduleIds: string[];
    name: string;
};
/**
 * Names the browser agent's lazily loaded chunks `<assetsDir>/hh-telemetry-*.js`, so the service worker
 * doesn't precache them: about 35 files a device would download on every update for reports that
 * only matter online, and that slow the first install enough to miss "controlled after one
 * reload". Other chunks keep the app's own `chunkFileNames`, or Vite's default. An app with several
 * Rollup outputs is left alone (its agent chunks are then precached).
 */
export declare function telemetryChunks(): {
    name: string;
    apply: "build";
    config(user?: {
        build?: {
            assetsDir?: string;
            rollupOptions?: {
                output?: unknown;
            };
        };
    }): {
        build?: undefined;
    } | {
        build: {
            rollupOptions: {
                output: {
                    chunkFileNames: (chunk: ChunkInfo) => string;
                };
            };
        };
    };
};
/**
 * GET share targets replace the action URL's query, so the parameter names carry the marker.
 * Same names as `SHARE_PARAMS` in ./places (kept apart: this file runs in Node at build time).
 */
export declare const SHARE_TARGET: {
    action: string;
    method: "GET";
    enctype: string;
    params: {
        title: string;
        text: string;
        url: string;
    };
};
/** The OCR engine's files; their URLs carry exact versions, so a cached copy never goes stale. */
export declare const OCR_CACHE: {
    urlPattern: RegExp;
    handler: "CacheFirst";
    options: {
        cacheName: string;
        expiration: {
            maxEntries: number;
            maxAgeSeconds: number;
        };
        cacheableResponse: {
            statuses: number[];
        };
    };
};
/**
 * Firebase Hosting serves its own pages under /__/ (the sign-in popup at /__/auth/handler, SDK
 * config at /__/firebase/init.json). A service worker that answers those navigations with the
 * cached app turns "Sign in with Google" into a popup showing the app itself.
 */
export declare const FIREBASE_RESERVED_PATHS: RegExp[];
/**
 * Stamps the build with `import.meta.env.VITE_APP_VERSION` (package.json version, set by the release
 * process) and `VITE_BUILD_SHA` (short commit, from CI's GITHUB_SHA), so a running app can say exactly
 * what it is. Apps show them in their account menu or settings.
 */
export declare function buildStamp(): {
    name: string;
    config: () => {
        define: {
            'import.meta.env.VITE_APP_VERSION': string;
            'import.meta.env.VITE_BUILD_SHA': string;
        };
    };
};
export {};
