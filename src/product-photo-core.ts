/**
 * Reading product names from photos: the contract between an app and the Worker that asks a vision
 * model (huishouden/calendar's `POST /api/photo/products`), server-safe so both use the same limits,
 * prompt and checks. The browser side is `./product-photo`; the confirm list is
 * `./react/product-photo`.
 *
 * A photo goes to the Worker once, already made small on the device (`shrinkPhoto` in `./photo`:
 * about 768 pixels on the long side, JPEG), and is never stored or logged there: only the names read
 * from it come back, for the person to check before anything is added.
 */

/** Where the Worker answers. */
export const PRODUCT_PHOTO_PATH = '/api/photo/products';

export const PRODUCT_PHOTO_LIMITS = {
  /** Photos in one request: one, so a request stays inside a free Worker's 10 ms of CPU (three measured 14 to 16 ms). */
  photosPerRequest: 1,
  /** Requests in flight at once. */
  concurrentRequests: 3,
  /** Photos read in one go. */
  photosPerPick: 8,
  /** Longest data URL accepted: a 768-pixel JPEG is 60 to 200 KB of base64. */
  dataUrlChars: 700_000,
  /** Sections an app may offer the model. */
  categories: 24,
  categoryChars: 40,
  /** Products kept from one photo. */
  productsPerPhoto: 12,
  /** Longest product name kept. */
  nameChars: 90,
} as const;

/** The long edge photos are made small to on the device before they are sent. */
export const PRODUCT_PHOTO_EDGE = 768;

/** What the app sends: the household (the Worker checks the caller is a member), the photo and the sections to choose from. */
export interface ProductPhotoRequest {
  household: string;
  /** `data:image/jpeg;base64,…`, one per photo. */
  photos: string[];
  /** The app's own sections ("Dairy & Eggs"), as stored; the model picks one per product. Empty: no section. */
  categories: string[];
}

/** A product read from a photo: its name as printed (brand, product, variety; no size) and the section the model chose, when it chose one of the app's. */
export interface FoundProduct {
  name: string;
  category?: string;
}

/** One photo's answer, in the order sent. `capped`: the day's photos ran out before this one. */
export type PhotoAnswer = { products: FoundProduct[] } | { error: 'failed' } | { capped: true };

/** Whose daily allowance stopped a request: the household's, or everyone's together (the free model allowance). */
export type PhotoCap = 'household' | 'everyone';

export interface ProductPhotoResponse {
  photos: PhotoAnswer[];
  /** Set when some or all photos were not read because a daily allowance is used up. */
  capped?: PhotoCap;
  /** Photos the household may still send today. */
  left?: number;
}

const DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** A request body checked: the request, or the reason it is refused (an error code). */
export function checkProductPhotoRequest(body: unknown): ProductPhotoRequest | 'photos' | 'categories' | 'household' {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.household !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(b.household)) return 'household';
  const photos = b.photos;
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > PRODUCT_PHOTO_LIMITS.photosPerRequest) return 'photos';
  if (!photos.every((p) => typeof p === 'string' && p.length <= PRODUCT_PHOTO_LIMITS.dataUrlChars && DATA_URL.test(p))) return 'photos';
  const categories = b.categories ?? [];
  if (!Array.isArray(categories) || categories.length > PRODUCT_PHOTO_LIMITS.categories) return 'categories';
  if (!categories.every((c) => typeof c === 'string' && c.trim().length > 0 && c.length <= PRODUCT_PHOTO_LIMITS.categoryChars && !/[\u0000-\u001f"\\]/.test(c))) return 'categories';
  return { household: b.household, photos: photos as string[], categories: [...new Set(categories as string[])] };
}

/**
 * The model's instructions and the JSON schema its answer must follow. The names stay in the
 * package's own words whatever the reader's language: they are what is printed on the shelf.
 */
export function productPrompt(categories: readonly string[]): { system: string; schema: Record<string, unknown> } {
  const section = categories.length
    ? `- "category": the section a US supermarket shelves it in (refrigerated creamers, milk, cheese and whipped cream with dairy), exactly one of: ${categories.join(' | ')}.\n`
    : '';
  const system = `You read the packages in a photo for a household's shopping list. List every distinct product whose package you can see. For each one give:
- "name": the brand, the product and its variety or flavour as printed on the package, in the package's own words, for example "Coffee mate Italian Sweet Crème creamer, Zero Sugar". No sizes, weights or counts.
${section}Only products actually visible; nothing that is not a product (a table, a hand). Reply with JSON only: {"products":[{"name":"..."${categories.length ? ',"category":"..."' : ''}}]}, or {"products":[]} if there are none.`;
  const item: Record<string, unknown> = categories.length
    ? { type: 'object', properties: { name: { type: 'string' }, category: { type: 'string', enum: [...categories] } }, required: ['name', 'category'] }
    : { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
  return { system, schema: { type: 'object', properties: { products: { type: 'array', items: item } }, required: ['products'] } };
}

const SIZE_TAIL = /[\s,;-]*\(?\d+(?:[.,]\d+)?\s*(?:fl\.?\s*oz|oz|lbs?|g|kg|ml|l|ct|count|pk|pack|pt|qt|gal)\b.*$/i;

/**
 * A name as a list shows it: spaces tidied, a trailing size dropped ("… 28.9 FL OZ"), and words
 * printed in capitals turned to title case when the rest of the name isn't ("ORIGINAL" → "Original";
 * a name all in capitals is title-cased whole). Short capitals (brand initials like "PB") stay.
 */
export function tidyProductName(raw: string): string {
  let name = raw.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(SIZE_TAIL, '').replace(/[\s,;-]+$/, '').trim();
  const words = name.split(' ');
  const shout = (w: string) => /\p{Lu}/u.test(w) && w === w.toUpperCase() && w.replace(/[^\p{L}]/gu, '').length >= 4;
  const title = (w: string) => w.charAt(0) + w.slice(1).toLowerCase();
  name = words.map((w) => (shout(w) ? title(w) : w)).join(' ');
  return name.slice(0, PRODUCT_PHOTO_LIMITS.nameChars).trim();
}

/** The words of a name, for comparing: lowercase, accents and punctuation gone. */
export function nameWords(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether two names are the same product for "already on the list": the same words, or one name's
 * words all within the other's when the shorter has at least two ("Coffee mate creamer" and
 * "Coffee mate Italian Sweet Crème creamer"; never a single word like "creamer").
 */
export function sameProduct(a: string, b: string): boolean {
  const wa = nameWords(a);
  const wb = nameWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  if (wa.join(' ') === wb.join(' ')) return true;
  const [short, long] = wa.length <= wb.length ? [wa, new Set(wb)] : [wb, new Set(wa)];
  return short.length >= 2 && short.every((w) => long.has(w));
}

/**
 * The model's answer made safe to show: JSON (or a JSON object inside text or a code fence) with a
 * `products` (or `items`) list; each name tidied and kept when it has letters, the category kept
 * only when it is one of the app's, duplicates dropped, at most `productsPerPhoto`. Anything else is
 * an empty list.
 */
export function cleanProducts(raw: unknown, categories: readonly string[]): FoundProduct[] {
  let value = raw;
  if (typeof value === 'string') {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
      value = JSON.parse(value.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const list = Array.isArray(obj.products) ? obj.products : Array.isArray(obj.items) ? obj.items : [];
  const found: FoundProduct[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string') continue;
    const name = tidyProductName(e.name);
    if (!/\p{L}/u.test(name) || found.some((f) => nameWords(f.name).join(' ') === nameWords(name).join(' '))) continue;
    const category = typeof e.category === 'string' && categories.includes(e.category) ? e.category : undefined;
    found.push(category ? { name, category } : { name });
    if (found.length >= PRODUCT_PHOTO_LIMITS.productsPerPhoto) break;
  }
  return found;
}

/**
 * The Worker's answer made safe to use, whatever its version: `photos` kept to `sent` entries, each
 * one well formed (products through `cleanProducts`, so names are tidied and limited) or else
 * counted as failed. Null when it is not an answer at all.
 */
export function checkProductPhotoResponse(body: unknown, sent: number, categories: readonly string[]): ProductPhotoResponse | null {
  const b = (body && typeof body === 'object' ? body : null) as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.photos)) return null;
  const photos: PhotoAnswer[] = Array.from({ length: sent }, (_, i) => {
    const a = b.photos instanceof Array ? (b.photos[i] as Record<string, unknown> | undefined) : undefined;
    if (a && typeof a === 'object' && Array.isArray(a.products)) return { products: cleanProducts({ products: a.products }, categories) };
    if (a && typeof a === 'object' && a.capped === true) return { capped: true };
    return { error: 'failed' };
  });
  const capped = b.capped === 'household' || b.capped === 'everyone' ? b.capped : undefined;
  const left = typeof b.left === 'number' && Number.isFinite(b.left) && b.left >= 0 ? Math.floor(b.left) : undefined;
  return { photos, ...(capped ? { capped } : {}), ...(left !== undefined ? { left } : {}) };
}
