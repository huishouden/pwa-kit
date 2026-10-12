import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type TestType } from '@playwright/test';
import { COMPLETE_OPEN, completeSelector } from './complete.js';
import { CONTENT_SECURITY_POLICY, permissionsPolicy, type DeviceFeatures } from './security-headers.js';
import {
  assertNotProductionUrl,
  e2eTarget,
  emulatorWebConfig,
  getTestDoc,
  mintCustomToken,
  seedTestHousehold,
  signedInTestsAvailable,
  stagingCredentialsFromEnv,
  stagingWebConfig,
  testHousehold,
  testUserByEmail,
  writeTestDocs,
  type StagingWebConfig,
  type TestHousehold,
  type TestRole,
  type TestUser,
} from './staging.js';

// Paths: every helper's default is `./`, which is BASE_URL itself. On the suite's one site BASE_URL
// is the app's path (`https://<site>/pet/`), so pass relative paths (`?tab=care`, `settings`): a
// leading `/` goes to the site root, which is the portal (docs/one-site.md).

/** Loads `path` and fails on any uncaught page error. Returns the errors seen for further checks. */
export async function expectCleanLoad(page: Page, path = './'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path, { waitUntil: 'networkidle' });
  expect(errors, 'uncaught page errors').toEqual([]);
  return errors;
}

/**
 * Installability as browsers judge it: a standalone manifest with a 512px icon, every icon URL
 * loading, and a service worker controlling the page after one reload.
 */
export async function expectInstallable(page: Page, request: APIRequestContext, path = './') {
  await page.goto(path, { waitUntil: 'networkidle' });
  const href = await page.locator('link[rel="manifest"]').first().getAttribute('href');
  expect(href, 'manifest link').toBeTruthy();
  const manifest = await (await request.get(href!)).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i: { sizes: string }) => i.sizes.includes('512x512')), '512px icon').toBe(true);
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker in control').toBe(true);
}

/**
 * Shares a contact card into the app the way Android's Share menu does (`pwaApp({ shareTarget:
 * { contacts: true } })`): a multipart POST to the manifest's share target, which the service
 * worker receives, then opens the page it sends the app to (`?share=contact`). Loads `path` and
 * waits for the service worker to be in control first.
 */
export async function shareContactCard(page: Page, card: string, { name = 'contact.vcf', path = './' }: { name?: string; path?: string } = {}) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload({ waitUntil: 'networkidle' });
  const target = await page.evaluate(
    async ({ card, name }) => {
      const href = (document.querySelector('link[rel="manifest"]') as HTMLLinkElement).href;
      const target = (await (await fetch(href)).json()).share_target as { action: string; method: string; params: { files?: { name: string }[] } };
      if (target?.method !== 'POST' || !target.params.files?.length) throw new Error('The manifest has no share target for files.');
      const form = new FormData();
      form.append(target.params.files[0].name, new File([card], name, { type: 'text/x-vcard' }));
      const res = await fetch(new URL(target.action, href), { method: 'POST', body: form });
      return res.url;
    },
    { card, name },
  );
  expect(new URL(target).searchParams.get('share'), 'the service worker took the card').toBe('contact');
  await page.goto(target);
}

/**
 * Clicks through to the Google sign-in popup and checks it reaches Google with a Firebase
 * /__/auth/handler redirect that Google accepts. Runs on a second load so the service worker is in
 * control, which is when a cached-app fallback would hijack the popup. Needs no credentials.
 */
export async function expectGoogleSignInPopup(
  page: Page,
  context: BrowserContext,
  openPopup: (page: Page) => Promise<void>,
  path = './',
) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  const [popup] = await Promise.all([context.waitForEvent('page'), openPopup(page)]);
  await popup.waitForURL(/accounts\.google\.com/, { timeout: 15_000 });
  const redirect = new URL(popup.url()).searchParams.get('redirect_uri') ?? '';
  expect(redirect).toMatch(/\/__\/auth\/handler$/);
  await expect(popup.locator('body')).not.toContainText('redirect_uri_mismatch');
  await expect(popup.locator('body')).toContainText(/Sign in|Choose an account/);
}

/**
 * The site's security headers as served (STANDARD.md "Security headers"): `url` (default `./`, the app's own path) is
 * frame-denied, sniff-proof and sends only the device permissions in `features`, while the same
 * origin's `/__/auth/handler` is not frame-denied, so Google sign-in keeps working.
 */
export async function expectSecurityHeaders(request: APIRequestContext, url = './', features: DeviceFeatures = {}) {
  const res = await request.get(url);
  expect(res.ok(), `${url} loads`).toBe(true);
  const h = res.headers();
  expect(h['x-frame-options'], 'X-Frame-Options').toBe('DENY');
  for (const part of CONTENT_SECURITY_POLICY.split('; ')) expect(h['content-security-policy'] ?? '', 'Content-Security-Policy').toContain(part);
  expect(h['referrer-policy'], 'Referrer-Policy').toBe('strict-origin-when-cross-origin');
  expect(h['x-content-type-options'], 'X-Content-Type-Options').toBe('nosniff');
  expect(h['permissions-policy'], 'Permissions-Policy').toBe(permissionsPolicy(features));
  const handler = await request.get(new URL('/__/auth/handler', res.url()).href);
  expect(handler.ok(), '/__/auth/handler loads').toBe(true);
  expect(handler.headers()['x-frame-options'], '/__/auth/handler is not frame-denied').toBeUndefined();
  expect(handler.headers()['content-security-policy'] ?? '', '/__/auth/handler has no frame-ancestors').not.toContain('frame-ancestors');
}

/**
 * The "Sample data" banner (`SampleBanner` from `/react/ui`) stays one line on a 390px phone: the
 * chip and the short text side by side. Restores the viewport afterwards.
 */
export async function expectCompactSampleBanner(page: Page, path?: string) {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    if (path !== undefined) await page.goto(path, { waitUntil: 'networkidle' });
    const line = page.locator('[data-sample-banner] [data-sample-line]').first();
    await expect(line, 'sample banner').toBeVisible();
    const chip = await line.locator('[data-sample-chip]').boundingBox();
    const text = await line.locator('[data-sample-short]').boundingBox();
    const box = await line.boundingBox();
    expect(chip && text && box, 'banner parts laid out').toBeTruthy();
    expect(Math.abs(chip!.y + chip!.height / 2 - (text!.y + text!.height / 2)), 'chip and text on one line').toBeLessThan(8);
    expect(box!.height, 'one line tall').toBeLessThanOrEqual(48);
  } finally {
    if (before) await page.setViewportSize(before);
  }
}

export interface BottomNavOptions {
  /** Page to load first; leave unset to check the page as it is. */
  path?: string;
  /** The bottom bar's labels in order, More included when the app has one ("Overview", …, "More"). */
  labels?: string[];
  /** What the More sheet lists, in order. */
  more?: string[];
}

/**
 * The phone's bottom tab bar (`SectionTabs` from /react/ui, DESIGN.md "Frame") at 390×844: one
 * labelled nav fixed to the bottom edge, at most five items of 48px or more, the current section
 * marked, the app bar's own tabs gone, the page padded so its end clears the bar, and More (when
 * there is one) opening a sheet that covers the bar. Then at 1280×800 the bar is gone and the tabs
 * are back in the app bar. Restores the viewport afterwards.
 */
export async function expectBottomNav(page: Page, { path, labels, more }: BottomNavOptions = {}) {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    if (path !== undefined) await page.goto(path, { waitUntil: 'networkidle' });
    const nav = page.locator('nav[data-hh-bottom-nav]');
    await expect(nav, 'one bottom bar').toHaveCount(1);
    await expect(nav, 'bottom bar').toBeVisible();
    await expect(nav, 'bottom bar is labelled').toHaveAttribute('aria-label', /\S/);
    await expect(page.locator('hh-app-bar nav[slot="nav"]'), 'app bar tabs hidden on phones').toBeHidden();

    const box = (await nav.boundingBox())!;
    expect(Math.abs(box.y + box.height - 844), 'bar on the bottom edge').toBeLessThanOrEqual(1);
    expect(box.width, 'bar spans the screen').toBeGreaterThanOrEqual(389);
    expect(await nav.evaluate((el) => getComputedStyle(el).position), 'bar stays put').toBe('fixed');

    const items = nav.getByRole('button');
    const count = await items.count();
    expect(count, 'one to five items').toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5);
    for (let i = 0; i < count; i++) {
      const b = (await items.nth(i).boundingBox())!;
      expect(Math.min(b.width, b.height), `item ${i + 1} is a 48px target`).toBeGreaterThanOrEqual(48);
    }
    if (labels) expect((await items.allInnerTexts()).map((t) => t.trim()), 'bar labels').toEqual(labels);
    const current = await nav.locator('[aria-current="page"]').count();
    const moreButton = nav.getByRole('button', { name: /^More/ });
    const moreShowing = (await moreButton.count()) > 0 && /^More, showing/.test((await moreButton.getAttribute('aria-label')) ?? '');
    expect(current + (moreShowing ? 1 : 0), 'the current section is marked').toBe(1);

    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-hh-bottom-nav')), 'page knows the bar shows').toBe(true);
    const padding = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
    expect(padding, 'page padded for the bar').toBeGreaterThanOrEqual(box.height - 1);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const main = page.locator('main').first();
    if ((await main.count()) > 0 && (await main.isVisible())) {
      const m = (await main.boundingBox())!;
      expect(m.y + m.height, 'content ends above the bar').toBeLessThanOrEqual(box.y + 1);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    if ((await moreButton.count()) > 0) {
      await moreButton.click();
      const sheet = page.getByRole('dialog', { name: 'More' });
      await expect(sheet, 'More opens a sheet').toBeVisible();
      if (more) expect((await sheet.locator('ul').getByRole('button').allInnerTexts()).map((t) => t.trim()), 'More sheet items').toEqual(more);
      const covered = await page.evaluate(
        ({ x, y }) => !document.elementFromPoint(x, y)?.closest('nav[data-hh-bottom-nav]'),
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      expect(covered, 'the sheet covers the bar').toBe(true);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(nav, 'no bottom bar on tablets').toBeHidden();
    await expect(page.locator('hh-app-bar nav[slot="nav"]'), 'tabs in the app bar on tablets').toBeVisible();
  } finally {
    if (before) await page.setViewportSize(before);
  }
}

export interface ScreenshotOptions {
  path?: string;
  /** Freeze the page clock so date-dependent screens render the same on every run. */
  fixedTime?: string | Date;
  /** Output directory, relative to the repo root. */
  dir?: string;
  /** Runs after load, before the capture (open a dialog, scroll, wait for a chart). */
  prepare?: (page: Page) => Promise<void>;
}

/**
 * Captures a README screenshot of the live app: animations and the caret off, reduced motion,
 * optional frozen clock, so the PNG only changes when the app's look does. The reusable workflow
 * commits docs/screenshots back to main when the bytes change.
 */
export async function captureScreenshot(page: Page, name: string, options: ScreenshotOptions = {}) {
  // SCREENSHOT_DIR lets CI shoot the same scenes into before/ and after/ folders for PR evidence.
  const { path = './', fixedTime, dir = process.env.SCREENSHOT_DIR || 'docs/screenshots', prepare } = options;
  if (fixedTime) await page.clock.setFixedTime(fixedTime);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (prepare) await prepare(page);
  await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled', caret: 'hide' });
}

export interface FrameOptions {
  /** The app's short name as the bar shows it ("Spending"); the portal's is "Huishouden". */
  app: string;
  /** Where the logo must lead. Defaults to any https URL (or `/` on the portal). */
  portalUrl?: string | RegExp;
  /** Page to load first; leave unset to check the page as it is. */
  path?: string;
}

/**
 * The Huishouden frame (DESIGN.md "Frame") on the running app: an `<hh-app-bar>` with the family
 * logo linking to the portal, the app's name, and the bar set in Inter.
 */
export async function expectHuishoudenFrame(page: Page, { app, portalUrl, path }: FrameOptions) {
  if (path !== undefined) await page.goto(path, { waitUntil: 'networkidle' });
  const bar = page.locator('hh-app-bar');
  await expect(bar, 'Huishouden app bar').toHaveCount(1);
  await expect(bar).toBeVisible();
  const home = bar.getByRole('link', { name: 'Huishouden home' });
  await expect(home, 'logo links to the portal').toHaveAttribute('href', portalUrl ?? /^(https:\/\/|\/$)/);
  await expect(home.locator('.logo svg'), 'family logo').toBeVisible();
  await expect(bar.getByRole('heading', { level: 1 }), 'app name').toHaveText(app);
  const font = await bar.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font, 'app bar typeface').toMatch(/^["']?Inter\b/);
}

/**
 * Opens the app's own settings from the app bar's menu (the avatar signed in, the sliders button
 * signed out): the bar holds them since apps dropped their own gear. `name` is the item's text,
 * e.g. "Tasks settings".
 *
 * Safe to call straight after `goto` or a sign-in: it waits for the bar to settle (the session
 * restored, the avatar or sliders button shown) and for the app to name its settings, which a
 * loading screen's bar lacks, and opens the menu again if the bar was replaced under it.
 */
export async function openAppSettings(page: Page, name: string | RegExp, { timeout = 20_000 }: { timeout?: number } = {}) {
  const bar = page.locator('hh-app-bar');
  const trigger = bar.locator('[data-trigger]');
  const item = bar.getByRole('button', { name, exact: typeof name === 'string', includeHidden: true });
  await expect(trigger, 'the app bar settled: its avatar (signed in) or sliders button (signed out)').toBeVisible({ timeout });
  await expect(item, `"${name}" in the app bar's menu: the app has not named its settings (still loading, or no \`settings\` on <hh-app-bar>)`).toBeAttached({ timeout });
  await expect(async () => {
    if (!(await item.isVisible())) await trigger.click();
    await item.click({ timeout: 2_000 });
  }, `open "${name}" from the app bar's menu`).toPass({ timeout });
}

/**
 * The app bar's logo, name and account controls on one row at the current viewport (a phone's
 * 360–412px, in a long language): nothing pushed onto a second line. The nav row is not counted.
 */
export async function expectAppBarOneRow(page: Page) {
  const bar = page.locator('hh-app-bar');
  await expect(bar.locator('.account > *').first()).toBeVisible();
  const rows = await bar.evaluate((el) => {
    const root = el.shadowRoot!;
    const top = (sel: string) => root.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
    const home = top('.home');
    const end = top('.end');
    return { home: home.top + home.height / 2, end: end.top + end.height / 2, width: root.querySelector('header')!.scrollWidth, view: innerWidth };
  });
  expect(Math.abs(rows.home - rows.end), 'account controls on the logo\'s row').toBeLessThan(12);
  expect(rows.width, 'app bar no wider than the screen').toBeLessThanOrEqual(rows.view);
}

export interface ThemeOptions {
  /** Page to load; defaults to the page as it is (reloaded). */
  path?: string;
  /** Also check that visible text reaches 4.5:1 (3:1 when large) against what is behind it, in dark. Default true. */
  contrast?: boolean;
  /** Text to leave out of the contrast check (a photo caption, a colour swatch). */
  ignore?: RegExp;
}

export interface ContrastFailure {
  text: string;
  ratio: number;
  color: string;
  background: string;
}

/**
 * The suite's theme (DESIGN.md "Dark") on the running app. With the choice on Automatic and the
 * device dark, the page is dark from its first paint: `.dark` on <html>, a dark `color-scheme`,
 * page and app bar on dark backgrounds, the dark status-bar colour, and (with `contrast`) no
 * visible text under 4.5:1. Turning the device light then turns the page light without a reload.
 */
export async function expectThemeConsistent(page: Page, { path, contrast = true, ignore }: ThemeOptions = {}) {
  if (path !== undefined) await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('hh-theme', 'auto'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload({ waitUntil: 'networkidle' });
  // The inline script pwaApp adds to <head> is what makes the first paint dark.
  await expect(page.locator('head script[data-hh-theme-boot]'), 'theme set before the first paint').toHaveCount(1);

  const dark = await page.evaluate(readTheme);
  expect(dark.dark, '.dark on <html>').toBe(true);
  expect(dark.colorScheme, 'color-scheme').toBe('dark');
  expect(dark.themeColor, 'theme-color meta').toBe('#081c15');
  expect(dark.body, `page background ${dark.bodyColor} is dark`).toBeLessThan(0.05);
  if (dark.bar !== null) expect(dark.bar, `app bar background ${dark.barColor} is dark`).toBeLessThan(0.05);
  if (contrast) {
    const failures = (await page.evaluate(lowContrastText)).filter((f) => !ignore?.test(f.text));
    expect(failures, 'text under 4.5:1 in dark').toEqual([]);
  }

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), { message: 'follows the device back to light' }).toBe(false);
  const light = await page.evaluate(readTheme);
  expect(light.body, `page background ${light.bodyColor} is light`).toBeGreaterThan(0.8);
}

/** In the page: what the theme looks like now. Luminance 0 (black) to 1 (white). */
function readTheme() {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  // Computed colours may be oklch() (Tailwind's own palette); the canvas turns any of them into sRGB.
  const rgba = (c: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lum = (c: string) => {
    const [r, g, b] = rgba(c).slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bodyColor = getComputedStyle(document.body).backgroundColor;
  const header = document.querySelector('hh-app-bar')?.shadowRoot?.querySelector('header');
  const barColor = header ? getComputedStyle(header).backgroundColor : '';
  return {
    dark: document.documentElement.classList.contains('dark'),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
    body: lum(bodyColor),
    bodyColor,
    bar: header ? lum(barColor) : null,
    barColor,
  };
}

/**
 * In the page: visible text whose colour is under 4.5:1 (3:1 for 24px, or 18.66px bold) against
 * the first solid background behind it. Text over images, inside hidden or faded parts, and SVG
 * text are left out. At most 12, worst first.
 */
export function lowContrastText(): ContrastFailure[] {
  type Rgba = [number, number, number, number];
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  // Computed colours may be oklch() (Tailwind's own palette); the canvas turns any of them into sRGB.
  const rgba = (c: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const parse = (c: string): Rgba => rgba(c);
  const lum = ([r, g, b]: Rgba) =>
    [r, g, b]
      .map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const backgroundOf = (el: Element): Rgba | null => {
    const layers: Rgba[] = [];
    for (let node: Element | null = el; node; node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null)) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none' && !style.backgroundImage.startsWith('linear-gradient')) return null;
      const bg = parse(style.backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let result: Rgba = [255, 255, 255, 1];
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  const hidden = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.95 || node.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  };
  const seen = new Set<Element>();
  const failures: ContrastFailure[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const el = text.parentElement;
    if (!el || seen.has(el) || !text.textContent?.trim()) continue;
    seen.add(el);
    if (el.closest('svg, script, style, noscript, [data-hh-contrast-ignore]') || (el as HTMLButtonElement).disabled) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || hidden(el)) continue;
    const style = getComputedStyle(el);
    const bg = backgroundOf(el);
    if (!bg) continue;
    const fg = over(parse(style.color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5) - 0.01) {
      failures.push({ text: text.textContent.trim().slice(0, 60), ratio: Math.round(ratio * 100) / 100, color: style.color, background: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})` });
    }
  }
  return failures.sort((x, y) => x.ratio - y.ratio).slice(0, 12);
}

export interface GoogleTokenStubOptions {
  /** The access token handed out (default "test-token"). */
  token?: string;
  /**
   * How Google answers instead: the window closed (`popup_closed`) or blocked
   * (`popup_failed_to_open`), or the person refusing (`access_denied`).
   */
  fail?: 'popup_closed' | 'popup_failed_to_open' | 'access_denied';
}

/**
 * Serves a stand-in for Google Identity Services (https://accounts.google.com/gsi/client) so
 * `googleAccessToken` gets a token with no Google account: the token client grants every scope
 * asked for (or fails as `fail` says), and One Tap reports "not displayed". Each request is
 * recorded in `window.__gisTokenRequests` (`{ client_id, scope }`). Call before `page.goto`.
 */
export async function stubGoogleTokens(page: Page, { token = 'test-token', fail }: GoogleTokenStubOptions = {}) {
  const script = `(() => {
  const token = ${JSON.stringify(token)}, fail = ${JSON.stringify(fail ?? null)};
  window.__gisTokenRequests = [];
  window.google = { accounts: {
    id: {
      initialize() {},
      prompt(listener) { if (listener) listener({ isNotDisplayed: () => true, getNotDisplayedReason: () => 'stubbed' }); },
      disableAutoSelect() {},
    },
    oauth2: {
      initTokenClient(cfg) {
        return { requestAccessToken() {
          window.__gisTokenRequests.push({ client_id: cfg.client_id, scope: cfg.scope });
          setTimeout(() => {
            if (fail === 'access_denied') cfg.callback({ error: 'access_denied' });
            else if (fail) cfg.error_callback && cfg.error_callback({ type: fail });
            else cfg.callback({ access_token: token, expires_in: 3599, scope: cfg.scope, token_type: 'Bearer' });
          });
        } };
      },
      hasGrantedAllScopes() { return !fail; },
    },
  } };
})();`;
  await page.route('https://accounts.google.com/gsi/client*', (route) => route.fulfill({ contentType: 'text/javascript', body: script }));
}

export interface CalendarStubOptions {
  /** What the calendar holds, as `findCalendarEvents` returns it (`CalendarMatch[]` from `./calendar`). */
  events: unknown[];
  /** Also stand in for a calendar token already granted on this device, so suggestions look on open (default true). */
  cachedToken?: boolean;
}

/**
 * Before the page loads: Google Calendar answers from `events` (`window.__mockCalendarEvents`) and,
 * with `cachedToken`, the device counts as having a calendar token (`window.__mockCalendarToken`),
 * which `useCalendarSuggestions` needs before it looks. Works signed out, in the sample app.
 */
export async function stubCalendar(page: Page | BrowserContext, { events, cachedToken = true }: CalendarStubOptions) {
  await page.addInitScript(
    ({ events, cachedToken }) => {
      const w = window as unknown as { __mockCalendarEvents: unknown[]; __mockCalendarToken?: string };
      w.__mockCalendarEvents = events;
      if (cachedToken) w.__mockCalendarToken = 'test-token';
    },
    { events, cachedToken },
  );
}

export interface MapStubOptions {
  /** What a Nominatim address search answers (its `jsonv2` objects with `address`); any search gets these. */
  search?: unknown[];
  /** What a reverse lookup (a position to an address) answers; zoom 14 and below (a neighbourhood) gets `area` instead. */
  reverse?: unknown;
  /** The neighbourhood a reverse lookup at suburb level answers, for "Approximate only". */
  area?: unknown;
}

/**
 * OpenStreetMap stands still for a test: Nominatim (search and reverse, `./home` and `./places`)
 * answers from `options`, and map tiles are a plain grey square, so nothing leaves the machine and
 * screenshots don't change with the map. Returns the URLs Nominatim was asked.
 */
export async function stubOpenStreetMap(page: Page | BrowserContext, { search = [], reverse = { error: 'Unable to geocode' }, area }: MapStubOptions = {}): Promise<string[]> {
  const asked: string[] = [];
  // A 1×1 grey PNG.
  const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+P/xfwAJLAPeVvNHBgAAAABJRU5ErkJggg==', 'base64');
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ contentType: 'image/png', body: tile }));
  await page.route('https://nominatim.openstreetmap.org/**', (route) => {
    const url = new URL(route.request().url());
    asked.push(url.href);
    const zoom = Number(url.searchParams.get('zoom') ?? 18);
    const body = url.pathname.startsWith('/reverse') ? (zoom <= 14 && area ? area : reverse) : search;
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  });
  return asked;
}

/** The browser reports this position, with location permission granted for the page's origin. */
export async function useGeolocation(context: BrowserContext, point: { lat: number; lng: number }, origin?: string) {
  await context.grantPermissions(['geolocation'], origin ? { origin } : undefined);
  await context.setGeolocation({ latitude: point.lat, longitude: point.lng, accuracy: 20 });
}

export interface SignInTestUserOptions {
  /** Which of the household's people signs in: `admin`, `member`, `helper` or `kid`. */
  as?: TestRole;
  /** Or one of the household's people by email (`household.users.helper.email`). */
  email?: string;
  /** The household (default the run's own, `testHousehold()`; `useTestHousehold` passes the spec's). */
  household?: TestHousehold;
  /** Page to open once signed in, relative to BASE_URL (default `./`, the app's own path). */
  path?: string;
  /** Firebase JS SDK version loaded from gstatic for the sign-in (default `FIREBASE_WEB_SDK`). */
  sdkVersion?: string;
  /** Where HH_* and VITE_FIREBASE_* are read from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

/** The Firebase web SDK the test sign-in loads; its saved session is read by any v9+ app build. */
export const FIREBASE_WEB_SDK = '12.19.0';

const tokens = new Map<string, { token: string; until: number }>();

/**
 * Signs one of a test household's people in, then opens `path` signed in. On staging (the kit's
 * staging job) it throws if the build's VITE_FIREBASE_PROJECT_ID or the site's /__/firebase/init.json
 * names any project but huishouden-staging, or neither names one (`stagingWebConfig`), and the
 * custom token is signed by the staging service account, so Firebase would refuse it anywhere else.
 * On the emulators (`HH_E2E_TARGET=emulator`, the kit's app-tests job) the token is unsigned and
 * the sign-in goes to the Auth emulator.
 *
 * How: on the site's /__/firebase/init.json (same origin, no app code running) it loads the Firebase
 * SDK from gstatic, runs `signInWithCustomToken`, and leaves the session in IndexedDB where the
 * app's own Firebase finds it on load, exactly as after a real sign-in. The household's people must
 * be seeded first (`useTestHousehold`, or `seedTestHousehold` in a `beforeAll`).
 */
export async function signInTestUser(page: Page, { as, email, household, path = './', sdkVersion = FIREBASE_WEB_SDK, env = process.env }: SignInTestUserOptions): Promise<TestUser> {
  const hh = household ?? testHousehold('', env);
  const user = as ? hh.users[as] : email ? testUserByEmail(hh, email) : undefined;
  if (!user) throw new Error('signInTestUser needs `as` (a role) or `email`');
  const emulator = e2eTarget(env) === 'emulator';
  // Before the page is touched or a token is minted: neither target may be production.
  assertNotProductionUrl(env.BASE_URL);
  let config: StagingWebConfig;
  let serviceAccount: string | undefined;
  let accessToken: string | undefined;
  if (emulator) {
    config = emulatorWebConfig(env);
    // The preview server's 404 for it: same origin, no app code. A response from the local server
    // (not page.route's), or Chrome would hold the page public and refuse its calls to the emulator.
    await page.goto('/__/firebase/init.json');
    assertNotProductionUrl(page.url(), "The page's address");
  } else {
    ({ accessToken, serviceAccount } = stagingCredentialsFromEnv(env));
    const res = await page.goto('/__/firebase/init.json');
    const site = res?.ok() ? ((await res.json().catch(() => null)) as { apiKey?: string; projectId?: string; authDomain?: string } | null) : null;
    config = stagingWebConfig(env, site);
  }
  // A token is good for an hour: one per person per worker, not one per test.
  let cached = tokens.get(`${config.projectId}/${user.uid}`);
  if (!cached || cached.until < Date.now()) {
    cached = { token: await mintCustomToken({ uid: user.uid, serviceAccount, accessToken, env }), until: Date.now() + 50 * 60_000 };
    tokens.set(`${config.projectId}/${user.uid}`, cached);
  }
  const signedIn = await page.evaluate(
    async ({ config, token, base, authEmulator }) => {
      const { initializeApp } = await import(`${base}/firebase-app.js`);
      const { getAuth, signInWithCustomToken, connectAuthEmulator } = await import(`${base}/firebase-auth.js`);
      const auth = getAuth(initializeApp(config));
      if (authEmulator) connectAuthEmulator(auth, authEmulator, { disableWarnings: true });
      const cred = await signInWithCustomToken(auth, token);
      return cred.user.email as string | null;
    },
    { config, token: cached.token, base: `https://www.gstatic.com/firebasejs/${sdkVersion}`, authEmulator: emulator ? `http://${env.HH_EMULATOR_HOST || '127.0.0.1'}:${env.HH_EMULATOR_AUTH_PORT || 9099}` : '' },
  );
  expect(signedIn, 'signed in as the test user').toBe(user.email);
  // Not networkidle: a signed-in app keeps Firestore's listen channel open.
  await page.goto(path);
  return user;
}

/** A spec file's own test household: see `useTestHousehold`. */
export interface TestHouseholdHandle {
  /** The household (resolved inside hooks and tests: its id comes from the spec file's name). */
  readonly household: TestHousehold;
  /** Its people: `users.helper.email`. */
  readonly users: Record<TestRole, TestUser>;
  /** Signs `as` in on `page` and opens `path` (default `./`). */
  signIn(page: Page, as: TestRole, path?: string): Promise<TestUser>;
  /**
   * A new page signed in as `as`, in a browser context the spec file keeps for that person: signed
   * in once per file, not once per test. Pages close after each test, so no Firestore listener is
   * left reading; the contexts close after the file.
   */
  open(browser: Browser, as: TestRole, path?: string): Promise<Page>;
  /** Writes app data under the household in one batched commit: `{ 'agenda/e1': {...} }`. */
  write(docs: Record<string, Record<string, unknown>>): Promise<void>;
  /** One document under the household, with admin access (one read), or null. */
  get(path: string): Promise<Record<string, unknown> | null>;
}

export interface UseTestHouseholdOptions {
  /** Default the spec file's name: each spec file has a household of its own in each run. */
  scope?: string;
  /** App data to seed with the household, in the same commit. */
  docs?: Record<string, Record<string, unknown>>;
}

/**
 * A household of its own for this spec file in this run, with an admin, a member, a helper and a
 * kid, seeded before its tests (one commit) and removed by the job after the run. Skips the file
 * where signed-in tests can't run (no staging credentials, no emulators).
 *
 * ```ts
 * const hh = useTestHousehold(test);
 * test('a helper ...', async ({ page }) => {
 *   await hh.signIn(page, 'helper');
 *   await expect(page.getByLabel(`Role for ${hh.users.helper.email}`)).toHaveValue('helper');
 * });
 * ```
 */
export function useTestHousehold(t: TestType<any, any>, { scope, docs }: UseTestHouseholdOptions = {}): TestHouseholdHandle {
  t.skip(!signedInTestsAvailable(), 'signed-in tests run in CI: the staging job, or the emulators of the app-tests job');
  const household = () => testHousehold(scope ?? t.info().file);
  const contexts = new Map<TestRole, Promise<BrowserContext>>();
  const pages: Page[] = [];
  t.beforeAll(async () => {
    await seedTestHousehold({ household: household(), docs });
  });
  t.afterEach(async () => {
    await Promise.all(pages.splice(0).map((p) => p.close().catch(() => undefined)));
  });
  t.afterAll(async () => {
    const all = [...contexts.values()];
    contexts.clear();
    await Promise.all(all.map(async (c) => (await c).close().catch(() => undefined)));
  });
  return {
    get household() {
      return household();
    },
    get users() {
      return household().users;
    },
    signIn: (page, as, path) => signInTestUser(page, { as, household: household(), path }),
    async open(browser, as, path = './') {
      let context = contexts.get(as);
      if (!context) {
        context = (async () => {
          const c = await browser.newContext({ baseURL: t.info().project.use.baseURL });
          const first = await c.newPage();
          await signInTestUser(first, { as, household: household(), path: 'about:blank' });
          await first.close();
          return c;
        })();
        contexts.set(as, context);
      }
      const page = await (await context).newPage();
      pages.push(page);
      await page.goto(path);
      return page;
    },
    write: (data) => writeTestDocs(household(), data),
    get: (path) => getTestDoc(household(), path),
  };
}

export interface PortalTodoOptions {
  /** `done` (default) or `cancel`, which also confirms. */
  action?: 'done' | 'cancel';
  /** The portal's To-do page (default `/todo`, the site root's: the portal is at `/` on the one site). */
  path?: string;
  /** How long to wait for the app's item to be published (default 30 s: apps publish a few seconds after a change). */
  timeout?: number;
}

/**
 * Finds `title` on the portal's To-do tab (a list item named for it, published by an app through
 * `./todos`) and runs its Done or Cancel there, confirming a cancel, then waits for the item to leave
 * the list. For an app's signed-in staging test: create a record in the app, run this, then check the
 * app's own data changed. Each staging site is a full mirror, so the portal is at `/` on it.
 */
export async function runPortalTodo(page: Page, title: string, { action = 'done', path = '/todo', timeout = 30_000 }: PortalTodoOptions = {}) {
  await page.goto(path);
  const row = page.getByRole('listitem', { name: title, exact: true });
  await expect(row, `"${title}" on the portal's To-do list`).toBeVisible({ timeout });
  // Done is the kit's CompleteButton since the portal adopted it; Cancel keeps `data-todo-action`.
  const button = action === 'done' ? row.locator(`[data-todo-action="done"], ${completeSelector(COMPLETE_OPEN)}`) : row.locator('[data-todo-action="cancel"]');
  await button.first().click();
  if (action === 'cancel') await page.getByRole('dialog').locator('[data-todo-confirm]').click();
  await expect(row, `"${title}" leaves the To-do list`).toHaveCount(0, { timeout: 15_000 });
}

/** English words of the kit's chrome that should never show once a page is in another language. */
export const ENGLISH_CHROME = [
  'Sign in',
  'Sign out',
  'Sample data',
  'Nothing is saved',
  'Overdue',
  'Due today',
  'Due tomorrow',
  'Due in',
  'Tomorrow',
  'Yesterday',
  'Today',
  'Undo',
  'Cancel',
  'Save',
  'Delete',
  'Try again',
  'More',
  'Theme',
  'Language',
  'Privacy',
  'All apps',
  'Close',
];

/** Makes every page in `page`'s context open in `lang` (the suite's stored choice), from the next load on. */
export async function useLanguage(target: Page | BrowserContext, lang: 'auto' | 'en' | 'es' | 'nl') {
  await target.addInitScript((value) => {
    try {
      localStorage.setItem('hh-lang', value);
    } catch {
      // storage blocked: the page stays in the device's language
    }
  }, lang);
}

export interface LocalizedOptions {
  path?: string;
  /** More English words the app's own chrome uses ("Bills due", "Add a bill"). Whole words, case-sensitive. */
  words?: string[];
  /** Words to allow after all (sample data that stays English, a brand). */
  allow?: string[];
}

/**
 * Opens `path` in `lang` and checks it took: `<html lang>`, and none of the kit's English chrome
 * words (plus `words`) in the visible page, app bar included. Data stays as entered, so mark an
 * element whose text is household data with `translate="no"` (or `data-hh-data`) to leave it out,
 * or name its words in `allow`. Returns the visible text it read.
 */
export async function expectLocalized(page: Page, lang: 'es' | 'nl', { path = './', words = [], allow = [] }: LocalizedOptions = {}): Promise<string> {
  await useLanguage(page, lang);
  await page.goto(path, { waitUntil: 'networkidle' });
  await expect(page.locator('html'), '<html lang>').toHaveAttribute('lang', lang);
  const text = await page.evaluate(() => {
    const skip = (el: Element | null) => !!el?.closest('[translate="no"], [data-hh-data], [data-sample-data]');
    const parts: string[] = [];
    const visit = (root: Node) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          if (el.shadowRoot) visit(el.shadowRoot);
          const label = el.getAttribute('aria-label');
          if (label && !skip(el) && (el as HTMLElement).offsetParent !== null) parts.push(label);
          continue;
        }
        const parent = node.parentElement;
        if (!parent || skip(parent) || parent.closest('script, style, [hidden]')) continue;
        if (parent.offsetParent === null && getComputedStyle(parent).position !== 'fixed') continue;
        const value = node.textContent?.trim();
        if (value) parts.push(value);
      }
    };
    visit(document.body);
    return parts.join('\n');
  });
  const english = [...ENGLISH_CHROME, ...words].filter((w) => !allow.includes(w));
  const found = english.filter((w) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(text));
  expect(found, `English left on the ${lang} page`).toEqual([]);
  return text;
}
