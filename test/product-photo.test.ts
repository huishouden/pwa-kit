import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import nutella from './fixtures/product-photo/off-nutella.json';
import unknown from './fixtures/product-photo/off-unknown.json';
import { fitWithin, shrinkPhoto } from '../src/photo';
import { barcodeProductName, lookupBarcode, ProductPhotoError, readBarcode, readProductPhotos, validGtin, type Fetch } from '../src/product-photo';
import { PRODUCT_PHOTO_PATH, type ProductPhotoResponse } from '../src/product-photo-core';

// The browser's image pieces, faked: a photo's "pixels" are its file name (`<width>x<height>`), the
// canvas remembers what it drew, and a barcode is found in files named `code-<digits>`.
const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas, BarcodeDetector: g.BarcodeDetector };
const drawn: { width: number; height: number }[] = [];

beforeEach(() => {
  drawn.length = 0;
  g.createImageBitmap = async (file: File) => {
    if (file.name === 'broken.jpg') throw new Error('unreadable');
    const [w, h] = (file.name.match(/(\d+)x(\d+)/)?.slice(1) ?? ['1000', '800']).map(Number);
    return { width: w, height: h, close() {}, name: file.name };
  };
  g.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return { drawImage: () => drawn.push({ width: this.width, height: this.height }), imageSmoothingQuality: 'low' };
    }
    async convertToBlob({ type }: { type: string }) {
      return new Blob([`jpeg ${this.width}x${this.height}`], { type });
    }
  };
  g.BarcodeDetector = class {
    static async getSupportedFormats() {
      return ['qr_code', 'ean_13', 'upc_a'];
    }
    constructor(readonly options: { formats: string[] }) {}
    async detect(bitmap: { name: string }) {
      const code = bitmap.name.match(/code-(\d+)/)?.[1];
      return code ? [{ rawValue: code, format: 'ean_13' }] : [];
    }
  };
});
afterEach(() => Object.assign(g, saved));

const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

describe('shrinkPhoto', () => {
  test('a whole photo, at most 768 on its long side, as a JPEG data URL', async () => {
    const shrunk = await shrinkPhoto(photo('4032x3024.jpg'));
    expect({ width: shrunk.width, height: shrunk.height }).toEqual({ width: 768, height: 576 });
    expect(drawn).toEqual([{ width: 768, height: 576 }]);
    expect(shrunk.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  test('never enlarges', () => {
    expect(fitWithin(600, 400, 768)).toEqual({ width: 600, height: 400 });
    expect(fitWithin(3024, 4032, 768)).toEqual({ width: 576, height: 768 });
  });

  test('an unreadable file says so', async () => {
    await expect(shrinkPhoto(photo('broken.jpg'))).rejects.toThrow("Couldn't read that photo");
  });
});

describe('barcodes', () => {
  test('check digits', () => {
    expect(validGtin('3017620422003')).toBe(true);
    expect(validGtin('036000291452')).toBe(true);
    expect(validGtin('3017620422004')).toBe(false);
    expect(validGtin('12345')).toBe(false);
  });

  test('read on the device, retail formats only; none without BarcodeDetector', async () => {
    expect(await readBarcode(photo('code-3017620422003.jpg'))).toBe('3017620422003');
    expect(await readBarcode(photo('code-3017620422004.jpg'))).toBeNull();
    expect(await readBarcode(photo('plain.jpg'))).toBeNull();
    delete g.BarcodeDetector;
    expect(await readBarcode(photo('code-3017620422003.jpg'))).toBeNull();
  });

  test("Open Food Facts: only the number is sent; the brand leads a name that doesn't say it", async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const fetch: Fetch = async (url, init) => {
      asked.push({ url, init });
      return Response.json(url.includes('3017620422003') ? nutella : unknown);
    };
    expect(await lookupBarcode('3017620422003', { fetch })).toEqual({ name: 'Nutella', code: '3017620422003', hints: ['hazelnut spreads', 'sweet spreads', 'spreads', 'breakfasts'] });
    expect(asked[0].url).toStartWith('https://world.openfoodfacts.org/api/v2/product/3017620422003.json?fields=');
    expect(asked[0].init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(await lookupBarcode('4006381333931', { fetch })).toBeNull();
    expect(await lookupBarcode('3017620422004', { fetch })).toBeNull();
    expect(asked).toHaveLength(2);
    expect(barcodeProductName({ product_name: 'Whole milk', brands: 'Horizon Organic' })).toBe('Horizon Organic Whole milk');
    expect(barcodeProductName({ product_name_es: 'Leche entera', product_name: 'Whole milk', brands: 'Horizon' }, 'es')).toBe('Horizon Leche entera');
  });
});

describe('readProductPhotos', () => {
  const SECTIONS = ['Dairy & Eggs', 'Pantry & Dry Goods'];
  /** A Worker that answers each photo from `answers`, in turn. */
  function worker(answers: ProductPhotoResponse[], status = 200) {
    const requests: { photos: string[]; household: string; categories: string[]; auth: string | null }[] = [];
    const fetch: Fetch = async (url, init) => {
      if (url.includes('openfoodfacts')) return Response.json(url.includes('3017620422003') ? nutella : unknown);
      expect(url).toBe(`https://worker.example${PRODUCT_PHOTO_PATH}`);
      const body = JSON.parse(String(init!.body));
      requests.push({ ...body, auth: new Headers(init!.headers).get('Authorization') });
      if (status !== 200) return new Response('{}', { status });
      return Response.json(answers.shift());
    };
    return { fetch, requests };
  }
  const options = (fetch: Fetch) => ({ endpoint: 'https://worker.example/', household: 'h1', idToken: async () => 'id-token', categories: SECTIONS, fetch });

  test('a barcode skips the model; the rest one a request; a product in two photos comes once, in photo order', async () => {
    const w = worker([
      { photos: [{ products: [{ name: 'Coffee mate Italian Sweet Crème creamer, Zero Sugar', category: 'Dairy & Eggs' }, { name: 'Reddi-wip Original' }] }], left: 22 },
      { photos: [{ products: [] }], left: 21 },
      { photos: [{ products: [{ name: 'Reddi-wip original' }] }], left: 20 },
      { photos: [{ products: [{ name: 'Heinz Tomato Ketchup', category: 'Pantry & Dry Goods' }] }], left: 19 },
    ]);
    const files = [photo('code-3017620422003.jpg'), photo('a-1000x800.jpg'), photo('b.jpg'), photo('c.jpg'), photo('d.jpg')];
    const reading = await readProductPhotos(files, options(w.fetch));
    expect(reading.products).toEqual([
      { name: 'Nutella', photo: 0, via: 'barcode', hints: ['hazelnut spreads', 'sweet spreads', 'spreads', 'breakfasts'] },
      { name: 'Coffee mate Italian Sweet Crème creamer, Zero Sugar', category: 'Dairy & Eggs', photo: 1, via: 'photo' },
      { name: 'Reddi-wip Original', photo: 1, via: 'photo' },
      { name: 'Heinz Tomato Ketchup', category: 'Pantry & Dry Goods', photo: 4, via: 'photo' },
    ]);
    expect(reading).toMatchObject({ failed: 0, left: 19 });
    expect(w.requests.map((r) => r.photos.length)).toEqual([1, 1, 1, 1]);
    expect(w.requests[0]).toMatchObject({ household: 'h1', categories: SECTIONS, auth: 'Bearer id-token' });
  });

  test("a cap part way: the photos after it aren't sent, and are counted", async () => {
    const capped: ProductPhotoResponse = { photos: [{ capped: true }], capped: 'household', left: 0 };
    const w = worker([{ photos: [{ products: [{ name: 'Test oats' }] }], left: 0 }, capped, capped, capped]);
    const reading = await readProductPhotos([photo('a.jpg'), photo('b.jpg'), photo('c.jpg'), photo('d.jpg'), photo('e.jpg')], options(w.fetch));
    expect(reading.products.map((p) => p.name)).toEqual(['Test oats']);
    expect(reading.capped).toEqual({ photos: 4, by: 'household' });
    // The first alone, then three in flight at once; none sent after a cap came back.
    expect(w.requests).toHaveLength(4);
  });

  test('an unreadable photo is counted, the others still read', async () => {
    const w = worker([{ photos: [{ products: [{ name: 'Test rice' }] }] }]);
    const reading = await readProductPhotos([photo('broken.jpg'), photo('a.jpg')], options(w.fetch));
    expect(reading).toMatchObject({ failed: 1, products: [{ name: 'Test rice' }] });
  });

  test('signed out, not a member or unreachable with nothing read: an error that says which', async () => {
    await expect(readProductPhotos([photo('a.jpg')], options(worker([], 401).fetch))).rejects.toEqual(new ProductPhotoError('sign-in'));
    await expect(readProductPhotos([photo('a.jpg')], options(worker([], 403).fetch))).rejects.toEqual(new ProductPhotoError('not-member'));
    await expect(readProductPhotos([photo('a.jpg')], options(worker([], 503).fetch))).rejects.toEqual(new ProductPhotoError('unavailable'));
    const offline: Fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(readProductPhotos([photo('a.jpg')], options(offline))).rejects.toEqual(new ProductPhotoError('unavailable'));
  });

  test('a barcode found while the Worker is down: what was read, with the rest counted', async () => {
    const reading = await readProductPhotos([photo('code-3017620422003.jpg'), photo('a.jpg')], options(worker([], 503).fetch));
    expect(reading).toMatchObject({ failed: 1, products: [{ name: 'Nutella', via: 'barcode' }] });
  });
});
