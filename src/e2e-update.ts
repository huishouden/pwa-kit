/**
 * End-to-end tests for updates (STANDARD.md "Updates"): two builds of the app served from a local
 * server that can switch between them, so a test opens a screen on build A, "deploys" build B under
 * it and checks the page was not reloaded and kept its screen and input. Runs against a local
 * server only: never staging or production.
 *
 * ```ts
 * const builds = buildVersions(['1.0.0', '1.0.1']);
 * const server = await serveBuilds(builds, '/pet/');
 * await page.goto(`${server.url}?tab=care`);
 * await waitForController(page);
 * await markPage(page);
 * server.use('1.0.1');
 * await waitForWaitingVersion(page);
 * expect(await pageMarked(page)).toBe(true);
 * ```
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { expect, type Page } from '@playwright/test';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Builds the app once per version (`VITE_APP_VERSION`, which changes the bundle and so the
 * service worker's precache), each into its own directory; returns them by version. Uses the
 * environment as it is (`hh dev verify` sets the emulator build's), without the asset CDN.
 */
export function buildVersions(versions: string[], { cwd = process.cwd(), env = {} }: { cwd?: string; env?: Record<string, string> } = {}): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'hh-builds-'));
  const dirs: Record<string, string> = {};
  for (const version of versions) {
    const outDir = join(root, version);
    const run = spawnSync('bunx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd,
      env: { ...process.env, ...env, VITE_APP_VERSION: version, HH_ASSET_ORIGIN: '' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (run.status !== 0) throw new Error(`vite build of ${version} failed (${run.status})`);
    dirs[version] = outDir;
  }
  return dirs;
}

export interface BuildServer {
  /** The app's address on the server (`http://127.0.0.1:<port>/pet/`). */
  url: string;
  /** Serves `version` from now on: a deploy. */
  use(version: string): void;
  close(): Promise<void>;
}

/**
 * Serves `builds` (from `buildVersions`) at `base` on 127.0.0.1 (a secure context, so service
 * workers run), starting with the first; navigations to a path with no file get the app's
 * index.html, as Hosting's rewrite does. The worker, pages and manifest are never cached.
 */
export async function serveBuilds(builds: Record<string, string>, base = '/'): Promise<BuildServer> {
  let current = Object.keys(builds)[0];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (!path.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    const dir = builds[current];
    let file = normalize(join(dir, path.slice(base.length)));
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(path)) {
        res.writeHead(404).end();
        return;
      }
      file = join(dir, 'index.html');
    }
    const fresh = /(?:^|\/)(?:sw\.js|[^/]*\.html|manifest\.webmanifest|registerSW\.js|hh-[a-z]+-sw\.js)$/.test(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': fresh ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}${base}`,
    use(version) {
      if (!builds[version]) throw new Error(`no build ${version}`);
      current = version;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The build's entry script (`assets/index-<hash>.js`), to tell which version a page runs. */
export function entryScript(buildDir: string): string {
  const html = readFileSync(join(buildDir, 'index.html'), 'utf8');
  const src = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
  if (!src) throw new Error(`no entry script in ${buildDir}/index.html`);
  return src.split('/').pop()!;
}

/** The entry script the page loaded. */
export async function pageEntry(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? '').split('/').pop() ?? '');
}

/** Waits until the app's service worker controls the page (the first install claims it). */
export async function waitForController(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout });
}

/** Leaves a mark on the page's window; a reload or navigation removes it (`pageMarked`). */
export async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => ((window as unknown as { __hhMark?: number }).__hhMark = 1));
}

/** Whether the page still has the mark `markPage` left: false after any reload. */
export async function pageMarked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __hhMark?: number }).__hhMark === 1);
}

/** Asks the server for a new version, as the hourly check does, and waits until it is installed and waiting. */
export async function waitForWaitingVersion(page: Page, timeout = 30_000): Promise<void> {
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, undefined, { timeout, polling: 250 });
}

/**
 * Makes the page hidden or visible as switching apps or turning the screen off does, for
 * `./update`: `document.visibilityState` and a `visibilitychange` event. (Playwright can't hide a
 * page itself.)
 */
export async function setPageVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** The app bar's Update button (`./update`). */
export const updateButton = (page: Page) => page.locator('hh-app-bar').locator('.update');

/**
 * The common part of every app's update test: with the page on build A at a deep screen with
 * typed input (`open`), build B is deployed and installs; the page is not reloaded, `check` still
 * passes (the screen and the input survived) and the Update button shows; hiding the page while the
 * input is there still does not reload. Then `clear` saves or empties it and hiding the page applies
 * B with a reload that returns to the same screen (`checkAfter`).
 */
export async function expectUpdateWithoutReload(
  page: Page,
  { server, builds, from, to, open, check, clear, checkAfter, settleMs = 3000 }: {
    server: BuildServer;
    builds: Record<string, string>;
    from: string;
    to: string;
    open: (page: Page) => Promise<void>;
    check: (page: Page) => Promise<void>;
    clear: (page: Page) => Promise<void>;
    checkAfter: (page: Page) => Promise<void>;
    settleMs?: number;
  },
): Promise<void> {
  server.use(from);
  await open(page);
  await waitForController(page);
  expect(await pageEntry(page)).toBe(entryScript(builds[from]));
  await markPage(page);

  server.use(to);
  await waitForWaitingVersion(page);
  await page.waitForTimeout(settleMs);
  expect(await pageMarked(page), 'no reload while the page is in use').toBe(true);
  await check(page);
  await expect(updateButton(page), 'the Update button offers the new version').toBeVisible();

  await setPageVisibility(page, 'hidden');
  await page.waitForTimeout(settleMs);
  expect(await pageMarked(page), 'hidden with unsaved input: still no reload').toBe(true);
  await setPageVisibility(page, 'visible');
  await check(page);

  await clear(page);
  const reloaded = page.waitForEvent('load', { timeout: 30_000 });
  await setPageVisibility(page, 'hidden');
  await reloaded;
  await page.waitForLoadState('domcontentloaded');
  expect(await pageEntry(page), 'the new version runs').toBe(entryScript(builds[to]));
  await checkAfter(page);
}
