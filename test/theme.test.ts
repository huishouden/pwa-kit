import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://baby.example.com/' });
import {
  DARK_THEME_COLOR,
  LEGACY_THEME_KEYS,
  THEME_BOOT_SCRIPT,
  THEME_KEY,
  applyTheme,
  getThemeMode,
  isThemeMode,
  onThemeChange,
  readThemeMode,
  resetThemeForTests,
  resolveDark,
  setThemeMode,
  startTheme,
} from '../src/theme';
import { themeBoot } from '../src/vite';

afterAll(() => {
  // The module's choice outlives this file's DOM: leave none for the next file to start from.
  resetThemeForTests();
  return GlobalRegistrator.unregister();
});

/** A stand-in for the device's light/dark setting that can flip like a real one. */
let systemDark = false;
const mediaListeners = new Set<() => void>();
globalThis.matchMedia = ((query: string) => ({
  get matches() {
    return query.includes('dark') && systemDark;
  },
  media: query,
  addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
  removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
})) as unknown as typeof matchMedia;
function flipSystem(dark: boolean) {
  systemDark = dark;
  for (const fn of mediaListeners) fn();
}

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

const html = () => document.documentElement;
const meta = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;

beforeEach(() => {
  localStorage.clear();
  systemDark = false;
  html().className = '';
  html().style.colorScheme = '';
  document.head.innerHTML = '<meta name="theme-color" content="#1b4332">';
  resetThemeForTests();
});

describe('mode resolution', () => {
  test('dark is the Dark choice, or Automatic on a dark device', () => {
    expect(resolveDark('dark', false)).toBe(true);
    expect(resolveDark('light', true)).toBe(false);
    expect(resolveDark('auto', true)).toBe(true);
    expect(resolveDark('auto', false)).toBe(false);
  });

  test('only the three choices are modes', () => {
    expect(['auto', 'light', 'dark'].every(isThemeMode)).toBe(true);
    expect(isThemeMode('system')).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe('stored choice', () => {
  test('nothing stored is Automatic', () => {
    expect(readThemeMode(memoryStore())).toBe('auto');
  });

  test('hh-theme wins over an old key', () => {
    expect(readThemeMode(memoryStore({ [THEME_KEY]: 'light', 'hearthlist.theme': '"dark"' }))).toBe('light');
  });

  test("Tasks' and Groceries' old choice moves to hh-theme", () => {
    const store = memoryStore({ [LEGACY_THEME_KEYS[0]]: '"dark"' });
    expect(readThemeMode(store)).toBe('dark');
    expect(store.data.get(THEME_KEY)).toBe('dark');
  });

  test('a garbled value is ignored', () => {
    const store = memoryStore({ [THEME_KEY]: 'purple', 'hearthlist.theme': '{oops' });
    expect(readThemeMode(store)).toBe('auto');
    expect(store.data.get(THEME_KEY)).toBe('purple');
  });

  test('blocked storage is Automatic, not an error', () => {
    const store = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    expect(readThemeMode(store)).toBe('auto');
    expect(readThemeMode(null)).toBe('auto');
  });
});

describe('applying', () => {
  test('dark puts .dark, color-scheme and the dark status bar on the page; light restores the page colour', () => {
    applyTheme(true);
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().style.colorScheme).toBe('dark');
    expect(meta().content).toBe(DARK_THEME_COLOR);
    applyTheme(false);
    expect(html().classList.contains('dark')).toBe(false);
    expect(html().style.colorScheme).toBe('light');
    expect(meta().content).toBe('#1b4332');
  });

  test('setThemeMode stores the choice for every app and tells listeners', () => {
    const seen: string[] = [];
    const off = onThemeChange(({ mode, dark }) => seen.push(`${mode}:${dark}`));
    setThemeMode('dark');
    off();
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(getThemeMode()).toBe('dark');
    expect(html().classList.contains('dark')).toBe(true);
    expect(seen).toEqual(['dark:true']);
  });

  test('Automatic follows the device as it changes', () => {
    setThemeMode('auto');
    startTheme();
    expect(html().classList.contains('dark')).toBe(false);
    flipSystem(true);
    expect(html().classList.contains('dark')).toBe(true);
    flipSystem(false);
    expect(html().classList.contains('dark')).toBe(false);
  });

  test('another tab choosing Dark turns this one dark (storage event)', () => {
    startTheme();
    expect(html().classList.contains('dark')).toBe(false);
    localStorage.setItem(THEME_KEY, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' }));
    expect(getThemeMode()).toBe('dark');
    expect(html().classList.contains('dark')).toBe(true);
    // Other keys are left alone.
    localStorage.setItem(THEME_KEY, 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    expect(html().classList.contains('dark')).toBe(true);
  });

  test('printing is light, and the screen goes back to dark afterwards', () => {
    startTheme();
    setThemeMode('dark');
    window.dispatchEvent(new Event('beforeprint'));
    expect(html().classList.contains('dark')).toBe(false);
    window.dispatchEvent(new Event('afterprint'));
    expect(html().classList.contains('dark')).toBe(true);
  });
});

describe('before the first paint', () => {
  const boot = () => new Function(THEME_BOOT_SCRIPT)();

  test('the boot script reads, migrates and applies like the module', () => {
    localStorage.setItem('hearthlist.theme', '"dark"');
    boot();
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().style.colorScheme).toBe('dark');
    expect(meta().content).toBe(DARK_THEME_COLOR);
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  test('the boot script follows the device on Automatic and keeps the light colour', () => {
    systemDark = true;
    boot();
    expect(html().classList.contains('dark')).toBe(true);
    expect(meta().dataset.light).toBe('#1b4332');
    systemDark = false;
    localStorage.setItem(THEME_KEY, 'light');
    boot();
    expect(html().classList.contains('dark')).toBe(false);
    expect(meta().content).toBe('#1b4332');
  });

  test('pwaApp puts the script at the end of <head>, once', () => {
    const plugin = themeBoot();
    const out = plugin.transformIndexHtml('<html><head><meta name="theme-color" content="#1b4332" /></head><body></body></html>');
    expect(out).toContain('<script data-hh-theme-boot>');
    expect(out.indexOf('data-hh-theme-boot')).toBeGreaterThan(out.indexOf('theme-color'));
    expect(out.indexOf('data-hh-theme-boot')).toBeLessThan(out.indexOf('</head>'));
    expect(plugin.transformIndexHtml(out)).toBe(out);
  });
});
