import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { sampleContacts, type Contact } from '../src/contacts';

if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://pet.example.com/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');
const { QuantityChart } = await import('../src/react/chart');
const { useSampleStore } = await import('../src/react/store');

// A root left mounted keeps rendering after its test, into the next file once this DOM is gone.
const roots: Root[] = [];
const unmountAll = () => act(() => roots.splice(0).forEach((r) => r.unmount()));
afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

function render(node: React.ReactNode) {
  unmountAll();
  document.body.innerHTML = '<div id="app"></div>';
  const root = createRoot(document.getElementById('app')!);
  roots.push(root);
  act(() => root.render(node));
  return root;
}

const DAY = 86_400_000;
const at = new Date(2031, 2, 1).getTime();

describe('QuantityChart', () => {
  test('names the range and the target, draws the target line and a dot per point', () => {
    render(
      <QuantityChart
        label="Weight"
        points={[
          { at, value: 24.2 },
          { at: at + 30 * DAY, value: 25.1 },
        ]}
        target={24}
        format={(v) => `${v.toFixed(1)} lb`}
      />,
    );
    const img = document.querySelector('svg[role=img]')!;
    expect(img.getAttribute('aria-label')).toMatch(/^Weight from 24\.2 lb on .+ to 25\.1 lb on .+; target 24\.0 lb$/);
    expect(document.querySelector('[data-testid=chart-target-line]')).not.toBeNull();
    expect(document.body.textContent).toContain('Target 24.0 lb');
    expect(document.querySelectorAll('.rounded-full')).toHaveLength(2);
  });

  test('nothing with one point', () => {
    render(<QuantityChart label="Weight" points={[{ at, value: 3 }]} format={String} />);
    expect(document.querySelector('figure')).toBeNull();
  });
});

describe('useSampleStore', () => {
  test('writes apply at once, render, and read() sees them before the render', () => {
    let store!: ReturnType<typeof useSampleStore<{ notes: { id: string; text: string }[] }>>;
    function Notes() {
      store = useSampleStore(() => ({ notes: [{ id: 'n1', text: 'Milk' }] }));
      return <ul>{store.data.notes.map((n) => <li key={n.id}>{n.text}</li>)}</ul>;
    }
    render(<Notes />);
    const { backend, read } = store;
    act(() => {
      backend.write([{ col: 'notes', id: 'n2', data: { text: 'Eggs' } }]);
      expect(read().notes).toHaveLength(2);
      backend.write([{ col: 'notes', id: 'n1', data: null }]);
    });
    expect(document.body.textContent).toBe('Eggs');
    expect(store.backend).toBe(backend);
  });
});

describe('sampleContacts', () => {
  test('save stamps and cleans, remove and restore by id, sorted by name', () => {
    let list: Contact[] = [{ id: 'c1', name: 'Vet', apps: ['pet'], private: false, createdAt: 1, by: 'alex@example.com' }];
    const writes = sampleContacts(() => list, (l) => (list = l), { by: 'sam@example.com', now: () => 9, newId: () => 'new' });
    writes.save(null, { name: 'Groomer', phone: '  ', apps: ['pet'] });
    expect(list.map((c) => c.id)).toEqual(['new', 'c1']);
    expect(list[0]).toEqual({ id: 'new', name: 'Groomer', apps: ['pet'], private: false, createdAt: 9, by: 'sam@example.com' });
    writes.save('c1', { name: 'Vet clinic', apps: ['pet'] });
    expect(list.find((c) => c.id === 'c1')).toMatchObject({ name: 'Vet clinic', createdAt: 1, updatedAt: 9 });
    const vet = list.find((c) => c.id === 'c1')!;
    writes.remove(vet);
    expect(list.map((c) => c.id)).toEqual(['new']);
    writes.restore(vet);
    expect(list.map((c) => c.id)).toEqual(['new', 'c1']);
  });
});
