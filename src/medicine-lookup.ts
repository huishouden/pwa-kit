/**
 * The FDA's listing for a label's NDC (openFDA's NDC directory, `api.fda.gov/drug/ndc.json`: free,
 * no key, open to browsers): the exact product name, strength, form and route, preferred over what
 * was read from a photo. Only the NDC is sent, or, when the code was only half read, the
 * medicine's name as it stands on the device's medicine list (never other text from the label);
 * the digits read are matched to the listed packages on the device. The listing is
 * used only when it agrees with the label: a misread digit can name another medicine, so the name
 * or the strength read must match it; otherwise nothing changes and the person is told to check.
 *
 * Pet medicines are not in the NDC directory; for them the device's list (`./medicine-names`)
 * gives the strengths a product comes in, offered when the label's own was unreadable.
 */

import type { Route } from './dose';
import type { LabelCourse } from './medicine-label';
import { isLiquidForm, type MedicineNames } from './medicine-names-match';
import { digitCount, isNdcShape, MIN_CODE_DIGITS } from './ndc';
import { kt } from './i18n.js';

export const OPENFDA_NDC = 'https://api.fda.gov/drug/ndc.json';

export interface Listing {
  /** Brand name ("Lisinopril", "Caduet"). */
  brand: string;
  generic: string;
  /** "5 mg/g", "7.5 mg / 46 mg". */
  strength: string;
  /** Lower case, the FDA's words: "ointment", "capsule, extended release". */
  form: string;
  /** Lower case: "ophthalmic", "oral". */
  route?: string;
  labeler?: string;
  productNdc: string;
}

type Fetch = (url: string) => Promise<Response>;

/** openFDA could not be reached or refused: the label is used as read. Anything else is a bug and is thrown. */
export class OpenFdaError extends Error {}

async function ask(fetcher: Fetch, url: string): Promise<Response | null> {
  let r: Response;
  try {
    r = await fetcher(url);
  } catch (e) {
    throw new OpenFdaError(String(e));
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new OpenFdaError(`openFDA ${r.status}`);
  return r;
}

/** "500 mg/1" -> "500 mg", "5 mg/g" stays, "90 ug/1" -> "90 mcg". */
function strengthOf(s: string): string {
  return s.replace(/\bug\b/g, 'mcg').replace(/\/1$/, '').replace(/\/(\d+)\s*([a-z]+)$/i, ' / $1 $2').replace(/\s+/g, ' ').trim();
}

/** The NDC directory's product for an NDC as printed (package or product code), with its packages, or null if not listed. */
export async function ndcListing(ndc: string, fetcher: Fetch = fetch): Promise<ListedProduct | null> {
  const parts = ndc.split('-');
  if (parts.length !== 3) return null;
  const product = `${parts[0]}-${parts[1]}`;
  for (const q of [`product_ndc:"${product}"`, `packaging.package_ndc:"${ndc}"`]) {
    const r = await ask(fetcher, `${OPENFDA_NDC}?search=${encodeURIComponent(q)}&limit=1`);
    if (!r) continue;
    const hit = ((await r.json()) as { results?: any[] }).results?.[0];
    if (hit) return toProduct(hit);
  }
  return null;
}

/** A listed product with its packages ("24208-910-55": "1 TUBE in 1 CARTON / 3.5 g in 1 TUBE"). */
export interface ListedProduct extends Listing {
  packages: { ndc: string; description: string }[];
}

function toListing(hit: any): Listing {
  return {
    brand: hit.brand_name ?? hit.generic_name,
    generic: hit.generic_name ?? '',
    strength: (hit.active_ingredients ?? []).map((a: { strength: string }) => strengthOf(a.strength)).join(' / '),
    form: String(hit.dosage_form ?? '').toLowerCase(),
    route: hit.route?.[0]?.toLowerCase(),
    labeler: hit.labeler_name,
    productNdc: hit.product_ndc,
  };
}

/**
 * The NDC directory's products of a medicine name (brand or generic), with their packages, to
 * find which one a label's half-read code is. Only the name is sent; callers send only names
 * from the device's medicine list, never other text read off a label.
 */
export async function nameListings(name: string, fetcher: Fetch = fetch): Promise<ListedProduct[]> {
  const n = name.replace(/["\\]/g, '').trim();
  if (!n) return [];
  const q = encodeURIComponent(`(brand_name:"${n}" generic_name:"${n}")`);
  // A common generic has hundreds of listings: three pages at most, narrowed on the device.
  const out: ListedProduct[] = [];
  for (let skip = 0; skip < 300; skip += 100) {
    const r = await ask(fetcher, `${OPENFDA_NDC}?search=${q}&limit=100${skip ? `&skip=${skip}` : ''}`);
    if (!r) break;
    const body = (await r.json()) as { meta?: { results?: { total?: number } }; results?: any[] };
    out.push(...(body.results ?? []).map(toProduct));
    if (out.length >= (body.meta?.results?.total ?? 0) || !body.results?.length) break;
  }
  return out;
}

function toProduct(hit: any): ListedProduct {
  return {
    ...toListing(hit),
    packages: (hit.packaging ?? []).map((p: { package_ndc: string; description?: string }) => ({ ndc: p.package_ndc, description: p.description ?? '' })),
  };
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** How far a code read is from an NDC, in digits: the closest stretch of the code (a run can carry a digit or two of what was next to it). */
function codeDistance(code: string, ndc: string): number {
  return Math.min(...[ndc, elevenDigits(ndc)].map((form) => digitDistance(code, form)));
}

/** An NDC in the 11-digit 5-4-2 form labels often print ("70518-4742-0" as "70518-4742-00"). */
export function elevenDigits(ndc: string): string {
  const [a, b, c] = ndc.split('-');
  return c === undefined ? ndc : `${a.padStart(5, '0')}-${b.padStart(4, '0')}-${c.padStart(2, '0')}`;
}

function digitDistance(code: string, ndc: string): number {
  const c = code.replace(/\D/g, ''), d = ndc.replace(/\D/g, '');
  let best = editDistance(c, d);
  for (let len = d.length - 1; len <= d.length + 1; len++) for (let i = 0; i + len <= c.length; i++) best = Math.min(best, editDistance(c.slice(i, i + len), d));
  return best;
}

/** Whether a package's size ("3.5 g in 1 TUBE", "30 CAPSULE in 1 BOTTLE") is on the label. */
function sizeOnLabel(description: string, text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  for (const m of description.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(g|ml|mg|capsules?|tablets?|tubes?|bottles?|vials?)\b/g)) {
    const n = m[1].replace('.', '\\.');
    const unit = m[2].replace(/s$/, '');
    if (new RegExp(`(?<![\\d.])${n}\\s*${unit}`).test(t) || (/^(capsule|tablet)$/.test(unit) && new RegExp(`\\b(?:qty|quantity|count)\\W{0,3}${n}(?![\\d.])`).test(t))) return true;
  }
  return false;
}

/**
 * The package of a medicine whose NDC the label shows but was half read: the listed package
 * nearest a code read on the label, at most `maxDistance` digits off (default two), and nearer than any other product's.
 * Ties go to the one whose strength, then size, the label shows; a tie within one product gives
 * the product's code ("24208-910").
 */
export function matchCode(codes: string[], products: ListedProduct[], label: { strength?: string; text?: string } = {}, maxDistance = 2): { ndc: string; listing: ListedProduct } | null {
  const scored: { ndc: string; product: ListedProduct; distance: number; strength: boolean; size: boolean }[] = [];
  for (const product of products) {
    for (const pkg of product.packages) {
      const distance = Math.min(...codes.filter((c) => digitCount(c) >= MIN_CODE_DIGITS).map((c) => codeDistance(c, pkg.ndc)));
      if (distance > maxDistance) continue;
      scored.push({ ndc: pkg.ndc, product, distance, strength: !!label.strength && sameStrength(label.strength, product.strength), size: !!label.text && sizeOnLabel(pkg.description, label.text) });
    }
  }
  if (!scored.length) return null;
  const rank = (x: (typeof scored)[number]) => x.distance * 4 - (x.strength ? 2 : 0) - (x.size ? 1 : 0);
  scored.sort((a, b) => rank(a) - rank(b));
  const best = scored.filter((x) => rank(x) === rank(scored[0]));
  if (new Set(best.map((x) => x.product.productNdc)).size > 1) return null;
  return { ndc: best.length === 1 ? best[0].ndc : best[0].product.productNdc, listing: best[0].product };
}


/**
 * A strength's amounts, comparable across ways of writing it: per-cent as mg per g or mL (0.5% =
 * 5 mg/g), micrograms as such, the "per 5 mL" of a liquid kept, a bare "per mL" or "per 1" not.
 */
function amounts(s: string): string[] {
  const out: string[] = [];
  const t = s.toLowerCase().replace(/,(?=\d{3}\b)/g, '').replace(/\bug\b|µg/g, 'mcg');
  for (const m of t.matchAll(/(\/\s*)?(\d+(?:\.\d+)?|\.\d+)\s*(%|mcg|mg|g|ml|units?|iu)?/g)) {
    const n = Number(m[2]);
    if (m[1] && n === 1) continue;
    out.push(m[3] === '%' ? String(Math.round(n * 10 * 1e6) / 1e6) : String(n));
  }
  return out.sort();
}

/** Whether two strengths are the same amounts ("7.5-46MG" and "7.5 mg / 46 mg"; "0.5%" and "5 mg/g"). */
export function sameStrength(a: string, b: string): boolean {
  const x = amounts(a), y = amounts(b);
  return x.length > 0 && x.join('|') === y.join('|');
}

/** Whether every amount of `part` is one of `whole`'s (a combination read half: "125mg" of "875 mg / 125 mg"). */
function partOf(part: string, whole: string): boolean {
  const x = amounts(part), y = amounts(whole);
  return x.length > 0 && x.every((n) => y.includes(n));
}

const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);

/** Whether a name read off the label is this listing's (a word in common, allowing a misread letter or a cut-off end). */
function sameName(read: string, listing: Listing): boolean {
  const known = new Set([...words(listing.brand), ...words(listing.generic)]);
  return words(read).some((w) => [...known].some((k) => k === w || (w.length >= 5 && (k.startsWith(w) || w.startsWith(k))) || near(w, k)));
}

function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a.length < 6) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

/** The listing's form in label words: "tablet, film coated" -> "tablet", "powder, for suspension" -> "for oral suspension". */
export function formOf(form: string): string {
  if (/chewable/.test(form)) return 'chewable tablet';
  if (/inject/.test(form)) return 'injection';
  if (/for (?:oral )?suspension/.test(form)) return 'for oral suspension';
  if (/for (?:oral )?solution/.test(form)) return 'for oral solution';
  if (/aerosol/.test(form)) return 'inhaler';
  return form.split(',')[0].trim();
}

const FORM_KIND: [RegExp, string][] = [
  [/chew/, 'chewable'], [/tab|caplet/, 'tablet'], [/cap/, 'capsule'], [/inhal|aerosol/, 'inhaler'], [/spray/, 'spray'], [/inject/, 'injection'],
  [/ointment|cream|gel/, 'ointment'], [/powder|granule/, 'powder'], [/patch/, 'patch'],
];
/** Whether two form words are the same kind of thing (tablets and "tablet, film coated"). */
function sameForm(a: string, b: string): boolean {
  const kind = (f: string) => FORM_KIND.find(([re]) => re.test(f.toLowerCase()))?.[1] ?? (isLiquidForm(f) ? 'liquid' : f.toLowerCase());
  return kind(a) === kind(b);
}

/** The NDC directory's routes as the parser's (`./dose` `ROUTES`). */
const ROUTE_WORDS: Record<string, Route> = {
  oral: 'by mouth', ophthalmic: 'in the eye', otic: 'in the ear', nasal: 'in the nose', topical: 'on the skin', cutaneous: 'on the skin',
  'respiratory (inhalation)': 'inhaled', subcutaneous: 'under the skin', intramuscular: 'by injection', intravenous: 'by injection',
};

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

export interface ListingOptions {
  fetch?: Fetch;
  /** The device's medicine names, for pet products' strengths and the name lookup of a half-read NDC. */
  names?: MedicineNames;
  /** The label's text as read, to tell a product's packages apart by the size the label shows. */
  text?: string;
  /** The digit runs read on the label (`LabelReading.codes`), the NDC's candidates: matched on the device; only one in full NDC shape is ever looked up. */
  codes?: string[];
}

/** The first word of a name that is a medicine on the device's list, spelled as listed: the only text ever sent to look a code up. */
function listedName(name: string | undefined, names: MedicineNames | undefined): string | undefined {
  if (!name || !names) return undefined;
  for (const w of name.split(/[\s/(),-]+/)) {
    const hit = w.length >= 5 ? names.match(w) : undefined;
    if (hit && hit.toLowerCase() === w.toLowerCase()) return hit;
  }
  return undefined;
}


/**
 * The label's NDC when none was read clearly, from the digits read and the name: the device's
 * listed name looked up (only the name is sent) and its packages matched to the digits on the
 * device; else a code in a full NDC shape looked up (only the code is sent) and kept only when
 * its product is the medicine named. Without a name read, nothing.
 */
async function resolveNdc(course: LabelCourse, options: ListingOptions): Promise<{ ndc: string; listing: ListedProduct } | null> {
  // Only the name (as listed on the device) or a code in full NDC shape is ever sent.
  const codes = [...(course.ndc ? [course.ndc] : []), ...(options.codes ?? [])];
  if (!codes.length || !course.name) return null;
  const listed = listedName(course.name, options.names);
  if (listed) {
    const products = await nameListings(listed, options.fetch);
    // An NDC read clearly but not listed as this medicine is corrected by one digit at most.
    const match = matchCode(codes, products, { strength: course.strength, text: options.text }, course.ndc ? 1 : 2);
    if (match) {
      // A code read in full for that product is kept as the label prints it.
      const printed = codes.find((c) => isNdcShape(c) && c.startsWith(`${match.listing.productNdc}-`));
      return printed ? { ...match, ndc: printed } : match;
    }
  }
  for (const code of codes.filter((c) => isNdcShape(c) && c !== course.ndc).slice(0, 2)) {
    const listing = await ndcListing(code, options.fetch);
    if (listing && sameName(course.name, listing)) return { ndc: code, listing };
  }
  return null;
}

/**
 * The course with the FDA's listing applied when the label's NDC is listed and agrees with what
 * was read: name, strength, form and route from the listing, marked `sources: 'fda'`. A pet
 * product read by name gets the strengths it comes in (`strengthChoices`) when its strength was
 * not read. Network failures leave the course as read.
 */
export async function withListing(course: LabelCourse, options: ListingOptions = {}): Promise<LabelCourse> {
  const out: LabelCourse = { ...course, sources: { ...course.sources }, assumptions: [...course.assumptions] };
  const agreesWith = (l: Listing) => !!((course.name && sameName(course.name, l)) || (course.strength && partOf(course.strength, l.strength)));
  let listing: ListedProduct | null = null;
  try {
    if (course.ndc) listing = await ndcListing(course.ndc, options.fetch);
    if (listing && agreesWith(listing)) {
      // The product is right: the code stays as printed (labels pad the package code: "-00" for "-0").
    } else {
      // No NDC read, or one that is not listed or names another medicine (a digit misread): the
      // digits read matched against the listings of the medicine named.
      const found = await resolveNdc(course, options);
      if (found) {
        out.ndc = found.ndc;
        out.sources!.ndc = 'fda';
        listing = found.listing;
      }
    }
  } catch (e) {
    // Offline or the service is down: the label as read.
    if (!(e instanceof OpenFdaError)) throw e;
  }
  if (out.ndc) {
    if (listing) {
      const agrees = out.sources!.ndc === 'fda' || agreesWith(listing);
      if (agrees) {
        out.name = titleCase(listing.brand);
        out.sources!.name = 'fda';
        // The label's own wording when it is the same amounts; the listing's when the label's was
        // misread or only half read.
        if (listing.strength && (!course.strength || !sameStrength(course.strength, listing.strength))) {
          out.strength = listing.strength;
          out.sources!.strength = 'fda';
        }
        const form = formOf(listing.form);
        if (form && (!course.form || !sameForm(course.form, form))) {
          out.form = form;
          out.sources!.form = 'fda';
        }
        const route = listing.route && ROUTE_WORDS[listing.route];
        if (route && (!course.route || course.route === route || course.route === 'by mouth')) {
          if (course.route !== route) out.sources!.route = 'fda';
          out.route = course.route && course.route !== 'by mouth' ? course.route : route;
        }
      } else {
        out.assumptions.push(kt('dose.ndcDisagrees', { ndc: out.ndc, name: titleCase(listing.brand) }));
      }
    }
  }
  if (options.names && out.name && out.sources?.name !== 'fda') {
    const pet = options.names.pet(out.name, out.form);
    if (pet) {
      if (!out.form || (!sameForm(out.form, formOf(pet.form)) && /chew|inject/.test(pet.form))) {
        out.form = formOf(pet.form);
        out.sources!.form = 'names';
      }
      // Strengths of the same kind of product: per tablet for tablets, per mL for liquids.
      const liquid = isLiquidForm(out.form ?? pet.form);
      const choices = pet.strengths.filter((st) => /\/\s*m?l\b/i.test(st) === liquid);
      if (choices.length && (!out.strength || !choices.some((st) => sameStrength(out.strength!, st)))) {
        if (out.strength) out.assumptions.push(kt('dose.strengthUnlisted', { strength: out.strength, name: pet.name }));
        out.strengthChoices = choices;
      }
    }
  }
  return out;
}
