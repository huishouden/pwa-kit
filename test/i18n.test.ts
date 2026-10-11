import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://bills.example.com/' });
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LANG_BOOT_SCRIPT,
  LANG_KEY,
  capitalize,
  formatList,
  formatMessage,
  getLang,
  getLocale,
  inEveryLang,
  kt,
  localeFor,
  matchLang,
  messageArgs,
  onLangChange,
  parseMessage,
  readLangChoice,
  hasTranslation,
  registerKitMessages,
  registerMessages,
  resetI18nForTests,
  resolveLang,
  setLangChoice,
  setLangForTests,
  startI18n,
  t,
  withLang,
  type MessageKey,
} from '../src/i18n';
import kitEn from '../src/locales/en';
import kitEs from '../src/locales/es';
import kitNl from '../src/locales/nl';
import { indexSource } from '../scripts/locales-index';
import { langBoot } from '../src/vite';
import { centsToInput, formatCents, parseCents, setCurrency } from '../src/money';
import { clockWords, dueText, dueWords, formatTime, longDate, shortDate } from '../src/time';

afterAll(() => GlobalRegistrator.unregister());
afterEach(async () => {
  resetI18nForTests();
  setCurrency('USD');
  localStorage.clear();
});

const appEn = {
  'bills.title': 'Bills',
  'bills.due': '{count, plural, =0 {Nothing due} one {# bill due} other {# bills due}}',
  'bills.hello': 'Hello, {name}',
  'bills.onlyEnglish': 'Only in English',
};
const appEs = { 'bills.title': 'Facturas', 'bills.due': '{count, plural, =0 {Nada pendiente} one {# factura pendiente} other {# facturas pendientes}}', 'bills.hello': 'Hola, {name}' };
const appNl = { 'bills.title': 'Rekeningen', 'bills.due': '{count, plural, =0 {Niets te betalen} one {# rekening te betalen} other {# rekeningen te betalen}}', 'bills.hello': 'Hoi {name}' };
const key = (k: string) => k as MessageKey;

describe('messages', () => {
  test('variables, numbers, plural with =0 and #, select, nesting', () => {
    expect(formatMessage('Hello, {name}', { name: 'Sam' }, 'en-US')).toBe('Hello, Sam');
    expect(formatMessage('{n} items', { n: 1234.5 }, 'en-US')).toBe('1,234.5 items');
    expect(formatMessage('{n} items', { n: 1234.5 }, 'nl-NL')).toBe('1.234,5 items');
    const due = '{count, plural, =0 {Nothing due} one {# bill due} other {# bills due}}';
    expect([0, 1, 2, 1000].map((count) => formatMessage(due, { count }, 'en-US'))).toEqual(['Nothing due', '1 bill due', '2 bills due', '1,000 bills due']);
    const who = '{role, select, admin {An admin} other {Someone}} added {count, plural, one {a bill} other {# bills}}';
    expect(formatMessage(who, { role: 'admin', count: 3 }, 'en-US')).toBe('An admin added 3 bills');
    expect(formatMessage(who, { role: 'kid', count: 1 }, 'en-US')).toBe('Someone added a bill');
    expect(formatMessage('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}', { n: 23 }, 'en-US')).toBe('23rd');
  });

  test("Spanish 'many' falls back to other; a missing variable shows as {name}; apostrophes are text", () => {
    expect(formatMessage('{n, plural, one {# factura} other {# facturas}}', { n: 1_000_000 }, 'es')).toBe('1.000.000 facturas');
    expect(formatMessage('Hi {name}', {}, 'en-US')).toBe('Hi {name}');
    expect(formatMessage("Don't suggest {x}", { x: 'milk' }, 'en-US')).toBe("Don't suggest milk");
  });

  test('parse errors and argument lists', () => {
    expect(() => parseMessage('Hello {name')).toThrow();
    expect(() => parseMessage('{n, plural, one {x}}')).toThrow(/other/);
    expect(() => parseMessage('a } b')).toThrow();
    expect(messageArgs('{a} {n, plural, one {# {b}} other {# {c}}}')).toEqual(['a', 'b', 'c', 'n']);
  });
});

describe('the language', () => {
  test('device languages match the first supported one; locales keep the device region', () => {
    expect(matchLang(['fr-FR', 'es-MX', 'en-US'])).toBe('es');
    expect(matchLang(['nl-BE'])).toBe('nl');
    expect(matchLang(['fr', 'de'])).toBe('en');
    expect(matchLang([])).toBe('en');
    expect(localeFor('es', ['es-MX', 'en-US'])).toBe('es-MX');
    expect(localeFor('es', ['en-US'])).toBe('es-US');
    expect(localeFor('nl', ['en-GB'])).toBe('nl-GB');
    expect(localeFor('nl', ['fr'])).toBe('nl-NL');
    expect(localeFor('en', [])).toBe('en-US');
    expect(resolveLang('auto', ['nl-NL'])).toBe('nl');
    expect(resolveLang('es', ['nl-NL'])).toBe('es');
  });

  test('the stored choice: auto unless one of the four values', () => {
    expect(readLangChoice()).toBe('auto');
    localStorage.setItem(LANG_KEY, 'nl');
    expect(readLangChoice()).toBe('nl');
    localStorage.setItem(LANG_KEY, 'fr');
    expect(readLangChoice()).toBe('auto');
  });

  test('app messages first, then the kit; English per key when a translation lacks it; the key itself last', async () => {
    registerMessages(appEn, { es: async () => ({ default: appEs }), nl: async () => appNl });
    expect(t(key('bills.title'))).toBe('Bills');
    expect(t('ui.undo')).toBe('Undo');
    await setLangForTests('es', ['es-MX']);
    expect(getLang()).toBe('es');
    expect(getLocale()).toBe('es-MX');
    expect(t(key('bills.title'))).toBe('Facturas');
    expect(t(key('bills.due'), { count: 2 })).toBe('2 facturas pendientes');
    expect(t(key('bills.onlyEnglish'))).toBe('Only in English');
    expect(t('ui.undo')).toBe('Deshacer');
    expect(t(key('nope.missing'))).toBe('nope.missing');
    await setLangForTests('nl', ['nl-NL']);
    expect(t(key('bills.hello'), { name: 'Sam' })).toBe('Hoi Sam');
    expect(kt('ui.sampleData')).toBe('Voorbeeldgegevens');
  });

  test("the kit's own catalogues (the household tools'): after every app's in every language; kept by resetI18nForTests", async () => {
    registerKitMessages({ 'x.kit': 'Kit words', 'x.both': 'Kit English' }, { es: async () => ({ default: { 'x.kit': 'Palabras del kit', 'x.both': 'Kit en español' } }) });
    registerMessages({ 'x.app': 'App words', 'x.both': 'App English' });
    await setLangForTests('es', ['es-MX']);
    expect(t(key('x.both'))).toBe('App English');
    expect(t(key('x.kit'))).toBe('Palabras del kit');
    expect(hasTranslation(key('x.kit'))).toBe(true);
    resetI18nForTests();
    expect(t(key('x.app'))).toBe('x.app');
    expect(t(key('x.kit'))).toBe('Kit words');
  });

  test('setLangChoice stores, switches, sets <html lang> and tells listeners; startI18n reads the store', async () => {
    const seen: string[] = [];
    const off = onLangChange((s) => seen.push(`${s.choice}:${s.lang}`));
    await setLangChoice('nl');
    expect(localStorage.getItem(LANG_KEY)).toBe('nl');
    expect(document.documentElement.lang).toBe('nl');
    expect(kt('ui.more')).toBe('Meer');
    resetI18nForTests();
    localStorage.setItem(LANG_KEY, 'es');
    await startI18n();
    expect(getLang()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    off();
    expect(seen).toEqual(['nl:nl', 'es:es']);
  });

  test('startI18n starts once: later calls (each useLang mount) change nothing', async () => {
    await startI18n();
    const seen: string[] = [];
    const off = onLangChange((s) => seen.push(s.lang));
    await startI18n();
    await startI18n();
    off();
    expect(seen).toEqual([]);
  });

  test('another tab changing the choice switches this one', async () => {
    await startI18n();
    localStorage.setItem(LANG_KEY, 'es');
    const switched = new Promise<void>((resolve) => {
      const off = onLangChange(() => {
        off();
        resolve();
      });
    });
    window.dispatchEvent(new StorageEvent('storage', { key: LANG_KEY, newValue: 'es' }));
    await switched;
    expect(getLang()).toBe('es');
  });

  test('withLang and inEveryLang render text for other devices', async () => {
    registerMessages(appEn, { es: async () => appEs, nl: async () => appNl });
    const texts = await inEveryLang(() => t(key('bills.due'), { count: 1 }));
    expect(texts).toEqual({ en: '1 bill due', es: '1 factura pendiente', nl: '1 rekening te betalen' });
    expect(getLang()).toBe('en');
    expect(withLang('nl', () => kt('ui.undo'))).toBe('Ongedaan maken');
    expect(kt('ui.undo')).toBe('Undo');
  });

  test('the boot script sets <html lang> from the choice, else the device', () => {
    const run = () => new Function(LANG_BOOT_SCRIPT)();
    document.documentElement.lang = 'en';
    localStorage.setItem(LANG_KEY, 'nl');
    run();
    expect(document.documentElement.lang).toBe('nl');
    localStorage.removeItem(LANG_KEY);
    run();
    expect(document.documentElement.lang).toBe(matchLang(navigator.languages));
    const html = langBoot().transformIndexHtml('<html lang="en"><head></head><body></body></html>');
    expect(html).toContain('<script data-hh-lang-boot>');
    expect(langBoot().transformIndexHtml(html)).toBe(html);
  });
});

describe('formatting follows the locale', () => {
  test('dates and times', async () => {
    expect(shortDate('2031-11-04', '2031-01-01')).toBe('Nov 4');
    expect(clockWords('19:00')).toBe('7 PM');
    expect(dueText('2031-11-25', '2031-11-04')).toBe('Due in 3 weeks');
    await setLangForTests('es', ['es-MX']);
    expect(shortDate('2031-11-04', '2031-01-01')).toBe('4 nov');
    expect(longDate('2031-11-04', '2031-01-01')).toBe('martes, 4 de noviembre');
    expect(clockWords('19:00')).toBe('7 p.m.');
    expect(dueText('2031-11-25', '2031-11-04')).toBe('Vence en 3 semanas');
    await setLangForTests('nl', ['nl-NL']);
    expect(clockWords('19:00')).toBe('19:00');
    expect(formatTime(new Date(2031, 10, 4, 7, 30).getTime())).toBe('7:30');
    expect(dueText('2031-11-03', '2031-11-04')).toBe('1 dag te laat');
    expect(capitalize('vandaag')).toBe('Vandaag');
    expect(dueWords('2031-11-04', '2031-11-04')).toBe('Vandaag');
    expect(dueWords('2031-11-04', '2031-11-04', { inline: true })).toBe('vandaag');
    expect(dueWords('2031-11-07', '2031-11-04', { inline: true })).toBe('vrijdag');
    expect(formatList(['melk', 'eieren', 'brood'])).toBe('melk, eieren en brood');
  });

  test('money: the household currency in the active locale; amounts typed either way', async () => {
    expect(formatCents(123450)).toBe('$1,234.50');
    setCurrency('EUR');
    expect(formatCents(123450)).toBe('€1,234.50');
    await setLangForTests('nl', ['nl-NL']);
    expect(formatCents(123450)).toBe('€\u00a01.234,50');
    expect(formatCents(123450, { headline: true })).toBe('€\u00a01.235');
    expect(centsToInput(12050)).toBe('120,50');
    expect(parseCents('12,50')).toBe(1250);
    expect(parseCents('1.500')).toBe(150000);
    expect(parseCents('€ 1.234,5')).toBe(123450);
    await setLangForTests('en');
    expect(parseCents('1.500')).toBeNull();
    expect(parseCents('1,500')).toBe(150000);
    expect(parseCents('12,50')).toBe(1250);
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('  ')).toBeUndefined();
  });
});

describe('the kit catalogue', () => {
  const en = kitEn as Record<string, string>;
  test('every message parses, and Spanish and Dutch have every key with the same variables', () => {
    for (const [lang, catalogue] of [
      ['es', kitEs],
      ['nl', kitNl],
    ] as const) {
      const c = catalogue as Record<string, string>;
      expect(Object.keys(c).sort(), lang).toEqual(Object.keys(en).sort());
      // A translation may leave out a variable, never add one the English doesn't pass.
      for (const k of Object.keys(en)) expect(messageArgs(c[k]).filter((a) => !messageArgs(en[k]).includes(a)), `${lang} ${k}`).toEqual([]);
    }
  });

  test('the generated index lists every area', () => {
    const areas = readdirSync('src/locales/en')
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3))
      .sort();
    for (const lang of ['en', 'es', 'nl']) expect(readFileSync(`src/locales/${lang}.ts`, 'utf8'), `${lang}.ts is stale: bun scripts/locales-index.ts`).toBe(indexSource(lang, areas));
  });

  test('no kit code formats in a fixed or the device locale', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'locales') walk(p);
        } else if (/\.tsx?$/.test(e.name) && !['e2e.ts', 'i18n.ts'].includes(e.name)) files.push(p);
      }
    };
    walk('src');
    const banned = [
      /toLocale(?:Date|Time)?String\(\s*(?:undefined|\)|['"])/,
      /\bIntl\.\w+\(\s*(?:undefined|['"])/,
      /['"]en-US['"]/,
      /navigator\.language\b(?!s)/,
    ];
    const found: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('locale-check:allow') || /^\s*(\*|\/\/|\/\*)/.test(line)) return;
        if (banned.some((re) => re.test(line))) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
