// Replaces the kit's observability for the whole process to see which views the frame counts, so it
// runs on its own (package.json "test").
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';

if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://suite.example.com/pet/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  if (root) act(() => root!.unmount());
  await GlobalRegistrator.unregister();
});

const views: string[] = [];
mock.module('../../src/observability', () => ({ trackView: (view: string) => views.push(view) }));

const { createRoot } = await import('react-dom/client');
const { AppFrame, AppOpening, listColumn } = await import('../../src/react/frame');
const { loadLang, setLangChoice } = await import('../../src/i18n');
const { Ellipsis, Sun, Heart } = await import('lucide-react');

const TABS = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'care', label: 'Care', icon: Heart },
  { id: 'pets', label: 'Pets', icon: Ellipsis },
];
const bar = { app: 'Pet', glyph: 'paw' as const, portalUrl: '/', user: undefined };

let root: ReturnType<typeof createRoot> | null = null;
function render(node: React.ReactNode) {
  document.body.innerHTML = '<div id="app"></div>';
  root = createRoot(document.getElementById('app')!);
  act(() => root!.render(node));
}
const frame = () => document.querySelector('[data-hh-frame]')!;
const tabLabels = () => Array.from(document.querySelectorAll('hh-app-bar nav[slot="nav"] button')).map((b) => b.textContent);
const skeleton = () => document.querySelector('[data-hh-skeleton]');
const sentence = () => skeleton()?.querySelector('.sr-only')?.textContent;

beforeEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  views.length = 0;
  document.documentElement.removeAttribute('data-hh-bottom-nav');
});

describe('AppOpening', () => {
  test('the frame, the tabs and the placeholder, marked as opening; no view counted', () => {
    render(<AppOpening {...bar} tabs={TABS} tab="care" onTab={() => {}} phase="session" />);
    expect(frame().getAttribute('data-hh-frame')).toBe('opening');
    expect(document.querySelector('hh-app-bar')!.getAttribute('app')).toBe('Pet');
    expect(tabLabels()).toEqual(['Today', 'Care', 'Pets']);
    expect(document.querySelector('hh-app-bar nav[slot="nav"] [aria-current="page"]')!.textContent).toBe('Care');
    // The phone's bottom bar too, so the page is padded for it from the first paint.
    expect(document.querySelector('nav[data-hh-bottom-nav]')).not.toBeNull();
    expect(document.documentElement.hasAttribute('data-hh-bottom-nav')).toBe(true);
    expect(skeleton()!.closest('main')).not.toBeNull();
    expect(skeleton()!.getAttribute('aria-busy')).toBe('true');
    expect(views).toEqual([]);
  });

  test('no tabs when they are not known before sign-in (Baby)', () => {
    render(<AppOpening {...bar} app="Baby" glyph="bottle" phase="household" />);
    expect(document.querySelector('nav[slot="nav"]')).toBeNull();
    expect(document.querySelector('nav[data-hh-bottom-nav]')).toBeNull();
    expect(views).toEqual([]);
  });

  test('a tap on a tab while opening reaches the app', () => {
    const chosen: string[] = [];
    render(<AppOpening {...bar} tabs={TABS} tab="today" onTab={(id) => chosen.push(id)} phase="session" />);
    act(() => (document.querySelector('hh-app-bar nav[slot="nav"] button:nth-child(3)') as HTMLElement).click());
    expect(chosen).toEqual(['pets']);
    expect(views).toEqual([]);
  });

  test('screen readers hear the phase, in the page language', async () => {
    render(<AppOpening {...bar} phase="session" />);
    expect(sentence()).toBe('Opening Pet.');
    render(<AppOpening {...bar} phase="household" />);
    expect(sentence()).toBe('Finding your household.');
    render(<AppOpening {...bar} phase="data" />);
    expect(sentence()).toBe('Getting Pet ready.');
    render(<AppOpening {...bar} phase="data" label="Loading the pets." />);
    expect(sentence()).toBe('Loading the pets.');

    const said: Record<string, string[]> = {};
    for (const lang of ['es', 'nl'] as const) {
      await loadLang(lang);
      await act(() => setLangChoice(lang, null));
      said[lang] = [];
      for (const phase of ['session', 'household', 'data'] as const) {
        render(<AppOpening {...bar} phase={phase} />);
        said[lang].push(sentence()!);
      }
    }
    await act(() => setLangChoice('en', null));
    expect(said).toEqual({
      es: ['Abriendo Pet.', 'Buscando tu hogar.', 'Preparando Pet.'],
      nl: ['Pet wordt geopend.', 'Je huishouden zoeken.', 'Pet wordt klaargezet.'],
    });
  });

  test('a list app (Tasks) gets its placeholder in the list column inside the scrolling main', () => {
    render(<AppOpening {...bar} app="Tasks" glyph="check" layout="list" phase="data" />);
    const main = document.querySelector('main')!;
    expect(main.className).toBe('min-h-0 flex-1 overflow-y-auto');
    expect(skeleton()!.parentElement!.className).toBe(listColumn);
    expect(frame().className).toBe('flex h-full flex-col');
  });

  test('the app settings never show while opening: they belong to the loaded app', () => {
    const loadedFrame = { ...bar, onSettings: () => {}, settingsLabel: 'Pet settings' };
    render(<AppOpening {...loadedFrame} phase="session" />);
    expect(document.querySelector('hh-app-bar')!.hasAttribute('settings')).toBe(false);
  });
});

describe('AppFrame', () => {
  test('the same frame as the opening, without the placeholder; counts the tab, then each change', () => {
    const props = { ...bar, tabs: TABS, onTab: () => {}, layout: 'fit' as const, className: 'print:bg-white' };
    render(<AppOpening {...props} tab="care" phase="data" />);
    const opening = { outer: frame().className, main: document.querySelector('main')!.className, tabs: tabLabels() };
    render(
      <AppFrame {...props} tab="care">
        <p>Care</p>
      </AppFrame>,
    );
    expect(frame().getAttribute('data-hh-frame')).toBe('');
    expect({ outer: frame().className, main: document.querySelector('main')!.className, tabs: tabLabels() }).toEqual(opening);
    expect(opening.outer).toContain('lg:h-dvh lg:overflow-hidden');
    expect(opening.outer).toEndWith('print:bg-white');
    expect(skeleton()).toBeNull();
    expect(views).toEqual(['care']);
    act(() =>
      root!.render(
        <AppFrame {...props} tab="pets">
          <p>Pets</p>
        </AppFrame>,
      ),
    );
    expect(views).toEqual(['care', 'pets']);
  });

  test('view: the app names what is counted, or counts its own (null); a page outside the tabs counts nothing', () => {
    render(<AppFrame {...bar} tabs={TABS} tab="today" view="settings:email" />);
    expect(views).toEqual(['settings:email']);
    views.length = 0;
    render(<AppFrame {...bar} tabs={TABS} tab="today" view={null} />);
    expect(views).toEqual([]);
    render(<AppFrame {...bar} tab="" />);
    expect(views).toEqual([]);
  });

  test('the bar slot, the main classes and what follows main', () => {
    render(
      <AppFrame {...bar} onSettings={() => {}} settingsLabel="Pet settings" bar={<span slot="actions">sync</span>} mainClassName="pb-20" after={<footer>Privacy</footer>}>
        <p>Today</p>
      </AppFrame>,
    );
    expect(document.querySelector('hh-app-bar [slot="actions"]')!.textContent).toBe('sync');
    expect(document.querySelector('hh-app-bar')!.getAttribute('settings')).toBe('Pet settings');
    expect(document.querySelector('main')!.className).toEndWith(' pb-20');
    expect(document.querySelector('main')!.nextElementSibling!.tagName).toBe('FOOTER');
  });
});
