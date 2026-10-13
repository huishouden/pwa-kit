import { afterAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';

// React DOM decides at import whether it runs in a browser, so the DOM comes first.
if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://suite.example.com/pet/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');
const { useUrlParam, useUrlTab } = await import('../src/react/url-state');
const { useHoldUpdates, useUpdateReady } = await import('../src/react/update');
const { offerUpdate, resetUpdatesForTests, startUpdates } = await import('../src/update');

const IDS = ['today', 'care', 'pets'] as const;
type Id = (typeof IDS)[number];
let tab!: Id;
let choose!: (id: Id, o?: { replace?: boolean; also?: Record<string, string | null> }) => void;
let pet!: string | null;
let setPet!: (v: string | null, o?: { replace?: boolean }) => void;

function Screen({ legacyHash = false }: { legacyHash?: boolean }) {
  [tab, choose] = useUrlTab(IDS, 'today', { legacyHash });
  [pet, setPet] = useUrlParam('pet');
  return null;
}

function mount(node: React.ReactNode) {
  document.body.innerHTML = '<div id="app"></div>';
  const root = createRoot(document.getElementById('app')!);
  act(() => root.render(node));
  return root;
}

describe('useUrlTab and useUrlParam', () => {
  test('an old #tab link opens that tab and moves it into the query, without a new entry', () => {
    history.replaceState(null, '', '/pet/#care');
    const before = history.length;
    const root = mount(<Screen legacyHash />);
    expect(tab).toBe('care');
    expect(location.pathname + location.search + location.hash).toBe('/pet/?tab=care');
    expect(history.length).toBe(before);
    act(() => root.unmount());
  });

  test('choosing a tab pushes it (the first screen leaves the parameter out); also changes others in the same entry; Back returns', () => {
    history.replaceState(null, '', '/pet/?tab=care&pet=p1');
    const root = mount(<Screen />);
    expect([tab, pet]).toEqual(['care', 'p1']);
    const before = history.length;
    act(() => choose('pets', { also: { pet: 'p2' } }));
    expect([tab, pet]).toEqual(['pets', 'p2']);
    expect(location.search).toBe('?tab=pets&pet=p2');
    expect(history.length).toBe(before + 1);
    act(() => setPet('p3', { replace: true }));
    expect(history.length).toBe(before + 1);
    act(() => choose('today'));
    expect(location.search).toBe('?pet=p3');
    expect(tab).toBe('today');
    act(() => {
      history.replaceState(null, '', '/pet/?tab=care');
      dispatchEvent(new Event('popstate'));
    });
    expect([tab, pet]).toEqual(['care', null]);
    act(() => root.unmount());
  });
});

describe('useUpdateReady and useHoldUpdates', () => {
  test('the hook follows the updater; a hold from a component holds while active', async () => {
    resetUpdatesForTests();
    let ready = false;
    let active = true;
    function Probe() {
      ready = useUpdateReady();
      useHoldUpdates(active);
      return null;
    }
    const root = mount(<Probe />);
    const noop = () => {};
    const updates = startUpdates({
      env: {
        serviceWorker: { register: () => new Promise(noop), addEventListener: noop, controller: {} } as unknown as ServiceWorkerContainer,
        setInterval: noop,
        setTimeout: noop,
      },
    })!;
    expect(updates.signals().unsaved, 'held by the mounted component').toBe(true);
    expect(ready).toBe(false);
    act(() => offerUpdate());
    expect(ready).toBe(true);
    active = false;
    act(() => root.render(<Probe />));
    expect(updates.signals().unsaved).toBe(false);
    act(() => root.unmount());
    resetUpdatesForTests();
  });
});
