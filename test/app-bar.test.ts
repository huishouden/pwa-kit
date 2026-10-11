import { afterAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from './dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppBar } from '../src/react/app-bar';
import { displayNameOf, initialOf, isSuite, sameSite, versionLabel } from '../src/app-bar';
import { resetI18nForTests, setLangChoice } from '../src/i18n';

describe('app bar helpers', () => {
  test('the initial comes from the name, then the email', () => {
    expect(initialOf({ name: 'sam example', email: 'x@example.com' })).toBe('S');
    expect(initialOf({ displayName: 'Robin', email: 'x@example.com' })).toBe('R');
    expect(initialOf({ email: 'alex@example.com' })).toBe('A');
    expect(initialOf({})).toBe('?');
    expect(displayNameOf({ name: '  Kim  ' })).toBe('Kim');
  });

  test('the portal is the suite itself', () => {
    expect(isSuite('Huishouden')).toBe(true);
    expect(isSuite('')).toBe(true);
    expect(isSuite('Baby')).toBe(false);
  });

  test('version label names the suite and the app', () => {
    expect(versionLabel('Baby', '1.2.0 (abc1234)')).toBe('Huishouden Baby 1.2.0 (abc1234)');
    expect(versionLabel('Huishouden', '1.2.0')).toBe('Huishouden 1.2.0');
    expect(versionLabel('Baby', '')).toBe('');
  });

  test('sameSite compares origins, resolving relative URLs', () => {
    expect(sameSite('/', 'https://portal.example.com/x')).toBe(true);
    expect(sameSite('https://portal.example.com', 'https://baby.example.com/')).toBe(false);
    expect(sameSite('not a url', 'also not')).toBe(false);
  });
});

// Element tests share one DOM, removed afterwards so later test files see none.
afterAll(() => GlobalRegistrator.unregister());

describe('<hh-app-bar>', () => {
  type Bar = HTMLElementTagNameMap['hh-app-bar'];
  function mount(attrs: Record<string, string> = {}, inner = '') {
    document.body.innerHTML = '';
    const bar = document.createElement('hh-app-bar') as Bar;
    bar.setAttribute('app', 'Baby');
    bar.setAttribute('glyph', 'bottle');
    bar.setAttribute('portal-url', 'https://portal.example.com/');
    bar.setAttribute('version', '1.2.0 (abc1234)');
    for (const [k, v] of Object.entries(attrs)) bar.setAttribute(k, v);
    bar.innerHTML = inner;
    document.body.append(bar);
    return { bar, $: (sel: string) => bar.shadowRoot!.querySelector<HTMLElement>(sel) };
  }

  test('shows the logo and names, linking to the portal', () => {
    const { $ } = mount();
    expect(($('a.home') as HTMLAnchorElement).getAttribute('href')).toBe('https://portal.example.com/');
    expect($('a.home')!.getAttribute('aria-label')).toBe('Huishouden home');
    expect($('.logo svg')).not.toBeNull();
    expect($('.suite')!.textContent).toBe('Huishouden');
    expect($('.suite')!.hidden).toBe(false);
    expect($('h1')!.textContent).toBe('Baby');
  });

  test('the portal shows one name', () => {
    const { $ } = mount({ app: 'Huishouden', glyph: 'home' });
    expect($('.suite')!.hidden).toBe(true);
    expect($('h1')!.textContent).toBe('Huishouden');
  });

  test('an unknown glyph falls back to the portal door', () => {
    const { bar, $ } = mount({ glyph: 'nonsense' });
    expect(bar.glyph).toBe('nonsense');
    expect($('.logo')!.dataset.glyph).toBe('home');
  });

  test('shows nothing in the account area until the session is known', () => {
    const { $ } = mount();
    expect($('.account')!.children.length).toBe(0);
  });

  test('signed out: Sign in with Google raises hh-sign-in', () => {
    const { bar, $ } = mount();
    bar.user = null;
    let fired = 0;
    document.addEventListener('hh-sign-in', () => fired++, { once: true });
    const button = $('.signin') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Sign in with Google');
    expect(button.textContent).toBe('Sign in\u00a0with Google');
    button.click();
    expect(fired).toBe(1);
    bar.signingIn = true;
    expect(($('.signin') as HTMLButtonElement).disabled).toBe(true);
    expect($('.signin')!.textContent).toBe('Opening Google');
  });

  test('signed in: the avatar opens the account menu; Escape closes it', () => {
    const { bar, $ } = mount();
    bar.user = { name: 'Sam Example', email: 'sam@example.com', photoURL: null };
    const avatar = $('.avatar') as HTMLButtonElement;
    expect(avatar.textContent).toBe('S');
    expect(avatar.getAttribute('aria-label')).toBe('Signed in as sam@example.com');
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
    expect($('.menu')!.hidden).toBe(true);

    avatar.click();
    expect(avatar.getAttribute('aria-expanded')).toBe('true');
    expect(avatar.getAttribute('aria-controls')).toBe($('.menu')!.id);
    const menu = $('.menu')!;
    expect(menu.hidden).toBe(false);
    expect(menu.querySelector('.who-name')!.textContent).toBe('Sam Example');
    expect(menu.querySelector('.who-email')!.textContent).toBe('sam@example.com');
    expect(menu.querySelector('a.item')!.getAttribute('href')).toBe('https://portal.example.com/');
    expect(menu.querySelector('a.item')!.textContent).toBe('All apps');
    const links = Array.from(menu.querySelectorAll('a.item')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['All apps', 'https://portal.example.com/'],
      ['Notifications', 'https://portal.example.com/notifications'],
      ['In your own calendar', 'https://portal.example.com/my-calendar'],
      ['Use with your AI assistant', 'https://portal.example.com/assistant'],
      ['Privacy', 'https://portal.example.com/privacy'],
    ]);
    expect(menu.querySelector('.version')!.textContent).toBe('Huishouden Baby 1.2.0 (abc1234)');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hidden).toBe(true);
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
  });

  test('a click outside closes the menu; Sign out raises hh-sign-out', () => {
    const { bar, $ } = mount();
    bar.user = { email: 'sam@example.com' };
    ($('.avatar') as HTMLButtonElement).click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect($('.menu')!.hidden).toBe(true);

    ($('.avatar') as HTMLButtonElement).click();
    let fired = 0;
    bar.addEventListener('hh-sign-out', () => fired++);
    const out = Array.from($('.menu')!.querySelectorAll('button.item')).find((b) => b.textContent === 'Sign out') as HTMLButtonElement;
    out.click();
    expect(fired).toBe(1);
    expect($('.menu')!.hidden).toBe(true);
  });

  test('the account menu offers Automatic, Light and Dark for the whole suite', () => {
    localStorage.removeItem('hh-theme');
    const { bar, $ } = mount();
    bar.user = { email: 'sam@example.com' };
    ($('.avatar') as HTMLButtonElement).click();
    const group = $('.menu .modes')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(bar.shadowRoot!.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe('Theme');
    const modes = Array.from(group.querySelectorAll<HTMLButtonElement>('.mode'));
    expect(modes.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Automatic', 'true'],
      ['Light', 'false'],
      ['Dark', 'false'],
    ]);
    modes[2].click();
    expect(localStorage.getItem('hh-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(modes.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    // The menu stays open so the change can be seen and undone.
    expect($('.menu')!.hidden).toBe(false);
    modes[1].click();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    localStorage.removeItem('hh-theme');
  });

  test('signed out: a "Theme, language and privacy" button opens the theme choice and Privacy', () => {
    const { bar, $ } = mount();
    bar.user = null;
    const trigger = $('.menu-button') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('Theme, language and privacy');
    expect(trigger.getAttribute('aria-controls')).toBe($('.menu')!.id);
    expect($('.menu')!.hidden).toBe(true);
    trigger.click();
    const menu = $('.menu')!;
    expect(menu.hidden).toBe(false);
    expect(menu.getAttribute('aria-label')).toBe('Theme, language and privacy');
    expect(Array.from(menu.querySelectorAll('.mode[data-mode]')).map((b) => b.textContent)).toEqual(['Automatic', 'Light', 'Dark']);
    expect(Array.from(menu.querySelectorAll('.mode[data-lang]')).map((b) => b.textContent)).toEqual(['Automatic', 'English', 'Español', 'Nederlands']);
    expect(Array.from(menu.querySelectorAll('a.item')).map((a) => a.textContent)).toEqual(['Privacy']);
    expect(menu.querySelector('button.item')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hidden).toBe(true);
    expect($('.signin')).not.toBeNull();
  });

  test('offers the language, each named in itself, and re-renders in the chosen one', async () => {
    resetI18nForTests();
    const { bar, $ } = mount();
    bar.user = { email: 'sam@example.com', name: 'Sam' };
    const langs = () => Array.from(bar.shadowRoot!.querySelectorAll<HTMLButtonElement>('.mode[data-lang]'));
    // Signed in, the language is the member's for every device: always a language, never Automatic.
    expect(langs().map((b) => b.textContent)).toEqual(['English', 'Español', 'Nederlands']);
    expect(langs()[1].lang).toBe('es');
    expect(langs()[0].getAttribute('aria-pressed')).toBe('true');
    try {
      langs()[1].focus();
      langs()[1].click();
      await setLangChoice('es');
      expect((bar.shadowRoot!.activeElement as HTMLElement | null)?.dataset.lang).toBe('es');
      expect(localStorage.getItem('hh-lang')).toBe('es');
      expect($('button.item')!.textContent).toBe('Cerrar sesión');
      expect(langs().map((b) => b.textContent)).toEqual(['English', 'Español', 'Nederlands']);
      expect(langs()[1].getAttribute('aria-pressed')).toBe('true');
      bar.user = null;
      // Signed out, the device's own Automatic is offered too.
      expect(langs().map((b) => b.textContent)).toEqual(['Automático', 'English', 'Español', 'Nederlands']);
      expect(langs()[2].getAttribute('aria-pressed')).toBe('true');
      expect($('a.home')!.getAttribute('aria-label')).toBe('Inicio de Huishouden');
    } finally {
      localStorage.removeItem('hh-lang');
      resetI18nForTests();
    }
  });

  test("the app's own settings sit in the menu, signed out and in, and raise hh-settings", () => {
    const { bar, $ } = mount({ settings: 'Baby settings' });
    const calls: string[] = [];
    bar.addEventListener('hh-settings', () => calls.push('settings'));
    bar.user = null;
    const trigger = $('.menu-button') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('Settings');
    trigger.click();
    const items = () => Array.from($('.menu')!.querySelectorAll('.item')).map((b) => b.textContent);
    expect(items()).toEqual(['Baby settings', 'Privacy']);
    ($('.menu [part="app-settings"]') as HTMLButtonElement).click();
    expect(calls).toEqual(['settings']);
    expect($('.menu')!.hidden).toBe(true);

    bar.user = { email: 'sam@example.com' };
    expect(items()).toEqual(['Baby settings', 'All apps', 'Notifications', 'In your own calendar', 'Use with your AI assistant', 'Privacy', 'Sign out']);
    bar.settings = '';
    expect(items()).toEqual(['All apps', 'Notifications', 'In your own calendar', 'Use with your AI assistant', 'Privacy', 'Sign out']);
    bar.user = null;
    expect($('.menu-button')!.getAttribute('aria-label')).toBe('Theme, language and privacy');
  });

  test('the logo tile and the initial avatar take the theme\'s tile colours', () => {
    const { bar, $ } = mount();
    bar.user = { email: 'sam@example.com' };
    expect($('.logo svg .hh-logo-tile')).not.toBeNull();
    const css = bar.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).toContain('.logo .hh-logo-tile { fill: var(--tile); }');
    expect(css).toMatch(/\.avatar \{[^}]*box-shadow: 0 0 0 1px var\(--tile-ring\)/);
  });

  test('Sign in has an icon for narrow phones and keeps its full name', () => {
    const { bar, $ } = mount();
    bar.user = null;
    expect($('.signin .icon svg')).not.toBeNull();
    expect($('.signin .label')!.textContent).toBe('Sign in\u00a0with Google');
    expect($('.signin')!.getAttribute('aria-label')).toBe('Sign in with Google');
  });

  test('the photo carries no referrer', () => {
    const { bar, $ } = mount();
    bar.user = { email: 'sam@example.com', photoURL: 'https://photos.example.com/sam.png' };
    const img = $('.avatar img') as HTMLImageElement;
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(img.getAttribute('src')).toBe('https://photos.example.com/sam.png');
  });

  test("an app on the portal's own site still links to all apps", () => {
    const { bar, $ } = mount({ 'portal-url': '/' });
    bar.user = { email: 'sam@example.com' };
    const links = Array.from($('.menu')!.querySelectorAll('a.item')).map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['All apps', '/'],
      ['Notifications', new URL('/notifications', location.href).href],
      ['In your own calendar', new URL('/my-calendar', location.href).href],
      ['Use with your AI assistant', new URL('/assistant', location.href).href],
      ['Privacy', new URL('/privacy', location.href).href],
    ]);
  });

  test('no "All apps" on the portal itself; the assistant page and Privacy stay', () => {
    const { bar, $ } = mount({ 'portal-url': '/', app: 'Huishouden' });
    bar.user = { email: 'sam@example.com' };
    const links = Array.from($('.menu')!.querySelectorAll('a.item')).map((a) => a.textContent);
    expect(links).toEqual(['Notifications', 'In your own calendar', 'Use with your AI assistant', 'Privacy']);
    expect($('.menu a.item')!.getAttribute('href')).toBe(new URL('/notifications', location.href).href);
  });

  test('section tabs that move to the bottom bar on phones mark the bar', async () => {
    const { bar } = mount({}, '<nav slot="nav" data-bottom-nav><button>Today</button></nav>');
    await Promise.resolve();
    expect(bar.hasAttribute('bottom-nav')).toBe(true);
    const other = mount({}, '<nav slot="nav"><button>March</button></nav>');
    await Promise.resolve();
    expect(other.bar.hasAttribute('bottom-nav')).toBe(false);
  });

  test('the nav area shows only when the app slots something into it', async () => {
    expect(mount().$('.nav')!.hidden).toBe(true);
    const { $ } = mount({}, '<nav slot="nav"><button>Today</button></nav>');
    await new Promise((r) => setTimeout(r, 0));
    expect($('.nav')!.hidden).toBe(false);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('AppBar (React)', () => {
  test('passes attributes, the user property, slotted children and both events', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = createRoot(document.getElementById('root')!);
    const calls: string[] = [];
    const render = (user: { email: string } | null) =>
      act(() =>
        root.render(
          createElement(
            AppBar,
            {
              app: 'Spending',
              glyph: 'card',
              portalUrl: 'https://portal.example.com/',
              version: '1.0.0 (abc1234)',
              theme: 'dark',
              user,
              onSignIn: () => calls.push('in'),
              onSignOut: () => calls.push('out'),
              onSettings: () => calls.push('settings'),
            },
            createElement('nav', { slot: 'nav' }, 'March'),
          ),
        ),
      );

    await render(null);
    const bar = document.querySelector('hh-app-bar')!;
    expect(bar.getAttribute('portal-url')).toBe('https://portal.example.com/');
    expect(bar.getAttribute('theme')).toBe('dark');
    expect(bar.querySelector('nav[slot="nav"]')!.textContent).toBe('March');
    expect(bar.user).toBeNull();
    bar.shadowRoot!.querySelector<HTMLButtonElement>('.signin')!.click();
    expect(bar.getAttribute('settings')).toBe('Spending settings');
    bar.shadowRoot!.querySelector<HTMLButtonElement>('[part="app-settings"]')!.click();

    await render({ email: 'sam@example.com' });
    expect(bar.user).toEqual({ email: 'sam@example.com' });
    bar.shadowRoot!.querySelector<HTMLButtonElement>('.avatar')!.click();
    Array.from(bar.shadowRoot!.querySelectorAll<HTMLButtonElement>('button.item')).find((b) => b.textContent === 'Sign out')!.click();
    expect(calls).toEqual(['in', 'settings', 'out']);
    await act(() => root.unmount());
  });
});
