import { afterAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import type { ParsedCourse } from '../src/dose';
import type { LabelCourse } from '../src/medicine-label';

if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://health.example.com/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');
const { LabelScan } = await import('../src/react/dose');

const LABEL = ['Lisinopril 10 mg tablets', 'Take 1 tablet by mouth once daily', 'Qty: 30', 'zq7 smudge', 'May cause dizziness'].join('\n');

async function scan(text: string | string[], onRead: (p: ParsedCourse, text: string) => { label: string; value: string }[], files = 1) {
  document.body.innerHTML = '<div id="app"></div>';
  const root = createRoot(document.getElementById('app')!);
  const texts = [text].flat();
  let n = 0;
  act(() => root.render(<LabelScan onRead={onRead} read={async () => texts[n++] ?? texts[0]} />));
  const input = document.querySelector('input[aria-label="Label photo"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: Array.from({ length: files }, (_, i) => new File(['x'], `label${i}.jpg`, { type: 'image/jpeg' })), configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return root;
}

const region = (name: string) => document.querySelector(`[aria-label="${name}"]`)?.textContent ?? '';

describe('LabelScan', () => {
  test('shows what it filled, what it read but did not use, and everything it read', async () => {
    let parsed: ParsedCourse | null = null;
    const root = await scan(LABEL, (p) => {
      parsed = p;
      return [
        { label: 'Medicine', value: [p.name, p.strength].filter(Boolean).join(' ') },
        { label: 'Dose', value: p.dose ?? '' },
        { label: 'Notes', value: '' },
      ];
    });
    expect(parsed!.name).toBe('Lisinopril');
    expect(region('Filled in from the label')).toContain('Filled in from the label. Check each field before saving.');
    expect(region('Filled in from the label')).toContain('MedicineLisinopril 10 mg');
    expect(region('Filled in from the label')).toContain('Dose1 tablet');
    // An empty value is not claimed as filled.
    expect(region('Filled in from the label')).not.toContain('Notes');
    expect(region('Not used')).toContain('zq7 smudge');
    expect(document.body.textContent).toContain('Nothing above holds these lines.');
    expect(document.body.textContent).toContain('Left out: one pharmacy line');
    expect(region('Read from the photo')).toContain('Qty: 30');
    expect(document.querySelector('input[capture]')?.getAttribute('aria-label')).toBe('Camera');
    expect(document.querySelector('input[aria-label="Label photo"]')?.hasAttribute('capture')).toBe(false);
    act(() => root.unmount());
  });

  test('says so when nothing could be filled in', async () => {
    const root = await scan('blurry', () => []);
    expect(document.body.textContent).toContain('Nothing on that photo could be filled in.');
    expect(region('Filled in from the label')).toBe('');
    act(() => root.unmount());
  });

  test('the front and the back of a box, chosen together, fill one form', async () => {
    const seen: string[] = [];
    const root = await scan(['Lisinopril 10 mg tablets\nQty: 30', 'Take 1 tablet by mouth once daily\nQty: 30'], (p, text) => {
      seen.push(text);
      return [{ label: 'Medicine', value: p.name ?? '' }, { label: 'Dose', value: p.dose ?? '' }];
    }, 2);
    expect(seen).toEqual(['Lisinopril 10 mg tablets\nQty: 30\nTake 1 tablet by mouth once daily']);
    expect(region('Filled in from the label')).toContain('MedicineLisinopril');
    expect(region('Filled in from the label')).toContain('Dose1 tablet');
    act(() => root.unmount());
  });

  test('one unreadable photo does not lose the others; all failing is an error', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = createRoot(document.getElementById('app')!);
    let n = 0;
    const read = async () => {
      if (n++ === 0) throw new Error('blurry');
      return LABEL;
    };
    act(() => root.render(<LabelScan onRead={(p) => [{ label: 'Medicine', value: p.name ?? '' }]} read={read} images={[new File(['x'], 'a.jpg', { type: 'image/jpeg' }), new File(['x'], 'b.jpg', { type: 'image/jpeg' })]} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(region('Filled in from the label')).toContain('MedicineLisinopril');
    act(() => root.render(<LabelScan onRead={() => []} read={async () => Promise.reject(new Error('x'))} images={[new File(['x'], 'c.jpg', { type: 'image/jpeg' })]} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't read that photo");
    act(() => root.unmount());
  });

  test('says which fields came from the FDA listing for the label\'s NDC', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = createRoot(document.getElementById('app')!);
    const listing = async (c: LabelCourse): Promise<LabelCourse> => ({ ...c, name: 'Ciprofloxacin', strength: '3 mg/mL', sources: { name: 'fda', strength: 'fda' } });
    let filled: LabelCourse | null = null;
    act(() =>
      root.render(
        <LabelScan
          onRead={(p) => ((filled = p), [{ label: 'Medicine', value: `${p.name} ${p.strength}` }])}
          read={async () => 'NDC 59390-217-02\nCiproflox\nOphthalmic Solution\n0.3%'}
          listing={listing}
          images={[new File(['x'], 'a.jpg', { type: 'image/jpeg' })]}
        />,
      ),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(filled!.ndc).toBe('59390-217-02');
    expect(region('Filled in from the label')).toContain('MedicineCiprofloxacin 3 mg/mL');
    expect(document.body.textContent).toContain('from the FDA listing for NDC 59390-217-02');
    act(() => root.unmount());
  });

  test('offers the strengths the medicine comes in when the label\'s was unreadable, and passes the pick on', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = createRoot(document.getElementById('app')!);
    const picked: string[] = [];
    act(() =>
      root.render(
        <LabelScan
          onRead={(p) => [{ label: 'Medicine', value: p.name ?? '' }]}
          onStrength={(s) => picked.push(s)}
          read={async () => 'Galliprant\nFor oral use in dogs only'}
          listing={async (c) => ({ ...c, strengthChoices: ['20 mg', '60 mg', '100 mg'] })}
          images={[new File(['x'], 'a.jpg', { type: 'image/jpeg' })]}
        />,
      ),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(region('Pick the strength')).toContain('Galliprant comes in these strengths');
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '60 mg')!;
    act(() => button.click());
    expect(picked).toEqual(['60 mg']);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    act(() => root.unmount());
  });

  test('never looks anything up with listing={null}', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = createRoot(document.getElementById('app')!);
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => (calls.push(String(u)), new Response('{}', { status: 404 }))) as typeof fetch;
    act(() => root.render(<LabelScan onRead={() => []} read={async () => 'NDC 59390-217-02\nCiprofloxacin 0.3%'} listing={null} images={[new File(['x'], 'a.jpg', { type: 'image/jpeg' })]} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    globalThis.fetch = realFetch;
    expect(calls).toEqual([]);
    act(() => root.unmount());
  });
});
