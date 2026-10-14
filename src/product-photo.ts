/**
 * Products read from photos, in the browser: Add by photo (Groceries; any app that keeps a list of
 * things to buy). Each photo is tried on the device first: a retail barcode found by the browser's
 * own `BarcodeDetector` is looked up in Open Food Facts (free, no key; only the number is sent). The
 * photos without one are made small on the device (`shrinkPhoto`, 768 pixels, JPEG) and sent once to
 * the Worker (`PRODUCT_PHOTO_PATH`, huishouden/calendar), one a request and three at a time, which
 * asks a vision model for the product names and keeps nothing. Nothing here adds anything: the app
 * shows the products for the person to check (`./react/product-photo`).
 *
 * ```ts
 * const reading = await readProductPhotos(files, {
 *   endpoint: import.meta.env.VITE_CALENDAR_URL,
 *   household: household.id,
 *   idToken: () => auth.currentUser!.getIdToken(),
 *   categories: ALL_CATEGORIES,
 * });
 * ```
 */
import type { Lang } from './i18n.js';
import { PhotoError, shrinkPhoto } from './photo.js';
import {
  PRODUCT_PHOTO_EDGE,
  PRODUCT_PHOTO_LIMITS,
  PRODUCT_PHOTO_PATH,
  nameWords,
  tidyProductName,
  type FoundProduct,
  type PhotoCap,
  type ProductPhotoResponse,
} from './product-photo-core.js';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Barcode formats printed on retail packages. */
export const RETAIL_BARCODES = ['ean_13', 'ean_8', 'upc_a', 'upc_e'] as const;

/** Whether a GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) has a valid check digit. */
export function validGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

interface DetectedBarcode {
  rawValue: string;
  format: string;
}
interface BarcodeDetectorLike {
  detect(image: ImageBitmapSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

/** Whether this browser can find barcodes in a photo by itself (Chrome on Android and macOS; not Safari or Firefox today). */
export const canReadBarcodes = (): boolean => typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector === 'function';

/** A retail barcode in the image, read on the device; null when there is none, or the browser can't look. */
export async function readBarcode(image: Blob): Promise<string | null> {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (typeof Detector !== 'function' || typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    const supported = (await Detector.getSupportedFormats?.()) ?? [...RETAIL_BARCODES];
    const formats = RETAIL_BARCODES.filter((f) => supported.includes(f));
    if (formats.length === 0) return null;
    bitmap = await createImageBitmap(image);
    const found = await new Detector({ formats }).detect(bitmap);
    return found.map((b) => b.rawValue).find(validGtin) ?? null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

export const OPEN_FOOD_FACTS = 'https://world.openfoodfacts.org';

interface OffProduct {
  product_name?: string;
  brands?: string;
  categories_tags?: string[];
  [key: `product_name_${string}`]: string | undefined;
}

/**
 * A product's name for a list from its Open Food Facts record: the name in the reader's language
 * (else English, else as entered), led by its brand when the name doesn't already say it.
 */
export function barcodeProductName(p: OffProduct, lang: Lang = 'en'): string | null {
  const product = (p[`product_name_${lang}`] || p.product_name_en || p.product_name || '').trim();
  const brand = (p.brands ?? '').split(',')[0]?.trim() ?? '';
  if (!product) return brand ? tidyProductName(brand) : null;
  const words = new Set(nameWords(product));
  const named = brand && nameWords(brand).every((w) => words.has(w));
  return tidyProductName(named || !brand ? product : `${brand} ${product}`);
}

/** A product found by its barcode: the name, the code, and its Open Food Facts categories in words ("sweet spreads"), for the app to pick a section from. */
export interface BarcodeProduct extends FoundProduct {
  code: string;
  hints: string[];
}

/** Looks a barcode up in Open Food Facts: only the number is sent (no cookies, no referrer). Null when unknown or unreachable. */
export async function lookupBarcode(code: string, { fetch: fetchImpl, lang = 'en' }: { fetch?: Fetch; lang?: Lang } = {}): Promise<BarcodeProduct | null> {
  if (!validGtin(code)) return null;
  const fields = ['product_name', `product_name_${lang}`, 'product_name_en', 'brands', 'categories_tags'].join(',');
  try {
    const res = await (fetchImpl ?? ((u, i) => fetch(u, i)))(`${OPEN_FOOD_FACTS}/api/v2/product/${code}.json?fields=${fields}`, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: number; product?: OffProduct };
    if (body.status !== 1 || !body.product) return null;
    const name = barcodeProductName(body.product, lang);
    if (!name) return null;
    const hints = (body.product.categories_tags ?? [])
      .filter((t) => t.startsWith('en:'))
      .map((t) => t.slice(3).replace(/-/g, ' '))
      .reverse();
    return { name, code, hints };
  } catch {
    return null;
  }
}

/** Why no photo could be read: signed out (or the sign-in expired), not a member of the household, or the service unreachable. */
export class ProductPhotoError extends Error {
  constructor(readonly reason: 'sign-in' | 'not-member' | 'unavailable') {
    super(`photos not read: ${reason}`);
    this.name = 'ProductPhotoError';
  }
}

export interface ReadProductPhotosOptions {
  /** The Worker's origin (the app's `VITE_CALENDAR_URL`). */
  endpoint: string;
  household: string;
  /** The signed-in person's Firebase ID token, fresh. */
  idToken: () => Promise<string>;
  /** The app's sections, as stored; the model picks one per product. */
  categories: readonly string[];
  /** For Open Food Facts' names. Default English. */
  lang?: Lang;
  fetch?: Fetch;
  /** Barcodes first. Default true; false sends every photo to the model. */
  barcodes?: boolean;
}

/** A product read from a photo: from its barcode or by the model. `photo` is its photo's place in the batch. */
export interface ReadProduct extends FoundProduct {
  photo: number;
  via: 'barcode' | 'photo';
  /** Barcode products: Open Food Facts' categories in words, most specific first. */
  hints?: string[];
}

export interface ProductReading {
  products: ReadProduct[];
  /** Photos that could not be read (unreadable file, the model failed). */
  failed: number;
  /** Photos not read because a daily allowance ran out, and whose. */
  capped?: { photos: number; by: PhotoCap };
  /** Photos the household may still send today, when the Worker said. */
  left?: number;
}

/**
 * Reads products from photos (at most `PRODUCT_PHOTO_LIMITS.photosPerPick`): barcodes on the device
 * and Open Food Facts first, then the rest through the Worker, `concurrentRequests` at a time. The same
 * product in two photos comes back once. Throws `ProductPhotoError` only when nothing could be asked
 * at all (signed out, not a member, offline); otherwise what was read, with counts of what wasn't.
 */
export async function readProductPhotos(files: readonly Blob[], options: ReadProductPhotosOptions): Promise<ProductReading> {
  const fetchImpl: Fetch = options.fetch ?? ((u, i) => fetch(u, i));
  const batch = files.slice(0, PRODUCT_PHOTO_LIMITS.photosPerPick);
  const reading: ProductReading = { products: [], failed: 0 };
  const add = (p: ReadProduct) => {
    const key = nameWords(p.name).join(' ');
    if (!reading.products.some((q) => nameWords(q.name).join(' ') === key)) reading.products.push(p);
  };

  const toSend: { photo: number; dataUrl: string }[] = [];
  for (const [photo, file] of batch.entries()) {
    if (options.barcodes !== false) {
      const code = await readBarcode(file);
      const found = code ? await lookupBarcode(code, { fetch: fetchImpl, lang: options.lang }) : null;
      if (found) {
        add({ name: found.name, photo, via: 'barcode', hints: found.hints });
        continue;
      }
    }
    try {
      toSend.push({ photo, dataUrl: (await shrinkPhoto(file, { longEdge: PRODUCT_PHOTO_EDGE })).dataUrl });
    } catch (e) {
      if (!(e instanceof PhotoError)) throw e;
      reading.failed++;
    }
  }

  const base = options.endpoint.replace(/\/+$/, '');
  let answered = false;
  let refused: ProductPhotoError['reason'] | null = null;
  const parts: (typeof toSend)[] = [];
  for (let i = 0; i < toSend.length; i += PRODUCT_PHOTO_LIMITS.photosPerRequest) parts.push(toSend.slice(i, i + PRODUCT_PHOTO_LIMITS.photosPerRequest));
  const answers: { part: typeof toSend; body: ProductPhotoResponse | null }[] = [];
  const send = async (part: typeof toSend) => {
    // Signed out, not a member, or capped: the next request would be refused too.
    if (refused === 'sign-in' || refused === 'not-member' || answers.some((a) => a.body?.capped)) return answers.push({ part, body: null });
    let body: ProductPhotoResponse | null = null;
    try {
      const res = await fetchImpl(`${base}${PRODUCT_PHOTO_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await options.idToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ household: options.household, photos: part.map((p) => p.dataUrl), categories: options.categories }),
      });
      if (res.status === 401 || res.status === 403) refused ??= res.status === 401 ? 'sign-in' : 'not-member';
      else if (res.ok) body = (await res.json().catch(() => null)) as ProductPhotoResponse | null;
    } catch {
      // Offline, or the Worker unreachable.
    }
    if (!body || !Array.isArray(body.photos)) refused ??= 'unavailable';
    answers.push({ part, body: body && Array.isArray(body.photos) ? body : null });
  };
  // The first alone (the Worker then remembers the member for an hour: one household read), then
  // a few at a time, in order of the photos.
  let next = 0;
  if (parts.length) await send(parts[next++]);
  await Promise.all(
    Array.from({ length: Math.min(PRODUCT_PHOTO_LIMITS.concurrentRequests, parts.length) }, async () => {
      while (next < parts.length) await send(parts[next++]);
    }),
  );
  answers.sort((a, b) => a.part[0].photo - b.part[0].photo);
  const cappedBy = answers.find((a) => a.body?.capped)?.body?.capped;
  for (const { part, body } of answers) {
    if (!body) {
      if (cappedBy) reading.capped = { photos: (reading.capped?.photos ?? 0) + part.length, by: cappedBy };
      else reading.failed += part.length;
      continue;
    }
    answered = true;
    if (typeof body.left === 'number') reading.left = reading.left === undefined ? body.left : Math.min(reading.left, body.left);
    part.forEach((sent, j) => {
      const answer = body.photos[j];
      if (answer && 'products' in answer) for (const p of answer.products) add({ ...p, photo: sent.photo, via: 'photo' });
      else if (answer && 'capped' in answer) reading.capped = { photos: (reading.capped?.photos ?? 0) + 1, by: body.capped ?? 'everyone' };
      else reading.failed++;
    });
  }
  // Nothing read and the Worker never answered: say why, rather than "no products".
  if (refused && !answered && reading.products.length === 0) throw new ProductPhotoError(refused);
  return reading;
}
