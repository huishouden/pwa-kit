import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';

if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://groceries.example.com/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');
const { AddByPhotoButton, AddByPhotoDialog, pickedItems, productRows } = await import('../src/react/product-photo');
const { ProductPhotoError } = await import('../src/product-photo');
const { sameProduct } = await import('../src/product-photo-core');
type ProductReading = import('../src/product-photo').ProductReading;
type PhotoItem = import('../src/react/product-photo').PhotoItem;

const SECTIONS = [
  { value: 'Dairy & Eggs', label: 'Dairy & Eggs' },
  { value: 'Pantry & Dry Goods', label: 'Pantry & Dry Goods' },
  { value: 'Other', label: 'Other' },
];
const ON_LIST = ['Test oats', 'Reddi-wip Original whipped topping'];
const READING: ProductReading = {
  products: [
    { name: 'Coffee mate Italian Sweet Crème creamer, Zero Sugar', category: 'Dairy & Eggs', photo: 0, via: 'photo' },
    { name: 'Reddi-wip Original Whipped Topping', category: 'Dairy & Eggs', photo: 0, via: 'photo' },
    { name: 'Nutella', photo: 1, via: 'barcode', hints: ['sweet spreads'] },
  ],
  failed: 0,
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

function mount(read: (files: File[]) => Promise<ProductReading>) {
  document.body.innerHTML = '<div id="app"></div>';
  const calls = { added: [] as PhotoItem[][], typed: 0, closed: 0 };
  root = createRoot(document.getElementById('app')!);
  act(() =>
    root!.render(
      <AddByPhotoDialog
        read={read}
        categories={SECTIONS}
        sectionFor={(p) => p.category ?? (p.hints?.length ? 'Pantry & Dry Goods' : 'Other')}
        onList={(name) => ON_LIST.some((n) => sameProduct(n, name))}
        onAdd={(items) => calls.added.push(items)}
        onType={() => calls.typed++}
        onClose={() => calls.closed++}
      />,
    ),
  );
  return calls;
}

const input = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const button = (text: string | RegExp) => Array.from(document.querySelectorAll('button')).find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));
const text = () => document.body.textContent ?? '';

async function choose(files: File[]) {
  const el = input('Product photos');
  Object.defineProperty(el, 'files', { value: files, configurable: true });
  await act(async () => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const jpg = (n: string) => new File(['x'], n, { type: 'image/jpeg' });

/** Types into a field as a person does: the element's own value setter (so React sees the change), then the event. */
function setValue(el: HTMLInputElement, value: string) {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'value')) proto = Object.getPrototypeOf(proto);
  el.focus();
  Object.getOwnPropertyDescriptor(proto!, 'value')!.set!.call(el, value);
  const view = el.ownerDocument.defaultView as unknown as typeof globalThis;
  el.dispatchEvent(new view.Event('input', { bubbles: true }));
  // Where react-dom was first loaded before a DOM existed (another test file), it listens for keys instead.
  el.dispatchEvent(new view.KeyboardEvent('keyup', { bubbles: true }));
}

describe('productRows', () => {
  test('ticked unless already on the list; the same product again is not repeated', () => {
    const rows = productRows(READING, { sectionFor: (p) => p.category ?? 'Other', onList: (n) => ON_LIST.some((o) => sameProduct(o, n)) });
    expect(rows.map((r) => [r.name, r.checked, r.onList, r.barcode])).toEqual([
      ['Coffee mate Italian Sweet Crème creamer, Zero Sugar', true, false, false],
      ['Reddi-wip Original Whipped Topping', false, true, false],
      ['Nutella', true, false, true],
    ]);
    const again = productRows(READING, { sectionFor: () => 'Other', onList: () => false, existing: rows });
    expect(again).toHaveLength(3);
    expect(pickedItems(rows)).toEqual([
      { name: 'Coffee mate Italian Sweet Crème creamer, Zero Sugar', category: 'Dairy & Eggs', quantity: '1' },
      { name: 'Nutella', category: 'Other', quantity: '1' },
    ]);
  });
});

describe('AddByPhotoDialog', () => {
  test('the camera button says what it does', () => {
    document.body.innerHTML = '<div id="app"></div>';
    root = createRoot(document.getElementById('app')!);
    act(() => root!.render(<AddByPhotoButton onClick={() => {}} />));
    expect(document.querySelector('button')!.getAttribute('aria-label')).toBe('Add by photo');
  });

  test('pick, a placeholder while reading, then a checklist where nothing is added until the tap', async () => {
    let finish: (r: ProductReading) => void = () => {};
    const calls = mount(() => new Promise((resolve) => (finish = resolve)));
    expect(text()).toContain('sent once to Cloudflare');
    await choose([jpg('a.jpg'), jpg('b.jpg')]);
    expect(text()).toContain('Reading 2 photos…');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => finish(READING));
    expect(text()).toContain('Found 3 items');
    expect(text()).toContain('Already on list');
    expect(text()).toContain('From the barcode');
    expect(calls.added).toEqual([]);
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true]);
    expect(button('Add 2 items')).toBeDefined();

    // Edit a name and a section, untick the barcode product.
    const names = Array.from(document.querySelectorAll('input[aria-label="Name"]')) as HTMLInputElement[];
    await act(async () => setValue(names[0], 'Coffee mate creamer, Zero Sugar'));
    const sections = Array.from(document.querySelectorAll('select[aria-label="Section"]')) as HTMLSelectElement[];
    expect(sections[2].value).toBe('Pantry & Dry Goods');
    await act(async () => boxes[2].click());
    await act(async () => button('Add 1 item')!.click());
    expect(calls.added).toEqual([[{ name: 'Coffee mate creamer, Zero Sugar', category: 'Dairy & Eggs', quantity: '1' }]]);
  });

  test("the household's day used up: it says so and offers typing", async () => {
    const calls = mount(async () => ({ products: [], failed: 0, capped: { photos: 1, by: 'household' } }));
    await choose([jpg('a.jpg')]);
    expect(text()).toContain("Your household has used today's photo reading. Type the items instead");
    await act(async () => button('Type instead')!.click());
    expect(calls.typed).toBe(1);
    expect(button('Try another photo')).toBeUndefined();
  });

  test("everyone's day used up", async () => {
    mount(async () => ({ products: [], failed: 0, capped: { photos: 2, by: 'everyone' } }));
    await choose([jpg('a.jpg'), jpg('b.jpg')]);
    expect(text()).toContain('Photo reading is used up for today.');
  });

  test('some read, some capped: the checklist with a note', async () => {
    mount(async () => ({ products: READING.products.slice(0, 1), failed: 0, capped: { photos: 1, by: 'everyone' } }));
    await choose([jpg('a.jpg'), jpg('b.jpg')]);
    expect(text()).toContain('Found 1 item');
    expect(text()).toContain("1 photo wasn't read: today's photo reading ran out.");
  });

  test('nothing found, or the service down: try again, or type', async () => {
    mount(async () => ({ products: [], failed: 0 }));
    await choose([jpg('a.jpg')]);
    expect(text()).toContain('No products found.');
    await act(async () => button('Try another photo')!.click());
    expect(input('Product photos')).not.toBeNull();
    act(() => root?.unmount());
    mount(async () => {
      throw new ProductPhotoError('unavailable');
    });
    await choose([jpg('a.jpg')]);
    expect(text()).toContain("Couldn't read the photos right now.");
  });
});
