/**
 * The FDA's listing for a label's NDC (openFDA's NDC directory, `api.fda.gov/drug/ndc.json`: free,
 * no key, open to browsers): the exact product name, strength, form and route, preferred over what
 * was read from a photo. Only the NDC is sent, never other text from the label. The listing is
 * used only when it agrees with the label: a misread digit can name another medicine, so the name
 * or the strength read must match it; otherwise nothing changes and the person is told to check.
 *
 * Pet medicines are not in the NDC directory; for them the device's list (`./medicine-names`)
 * gives the strengths a product comes in, offered when the label's own was unreadable.
 */

import type { Route } from './dose';
import type { LabelCourse } from './medicine-label';
import { isLiquidForm, type MedicineNames } from './medicine-names-match';
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

/** "500 mg/1" -> "500 mg", "5 mg/g" stays, "90 ug/1" -> "90 mcg". */
function strengthOf(s: string): string {
  return s.replace(/\bug\b/g, 'mcg').replace(/\/1$/, '').replace(/\/(\d+)\s*([a-z]+)$/i, ' / $1 $2').replace(/\s+/g, ' ').trim();
}

/** The NDC directory's product for an NDC as printed (package or product code), or null if not listed. */
export async function ndcListing(ndc: string, fetcher: Fetch = fetch): Promise<Listing | null> {
  const parts = ndc.split('-');
  if (parts.length !== 3) return null;
  const product = `${parts[0]}-${parts[1]}`;
  for (const q of [`product_ndc:"${product}"`, `packaging.package_ndc:"${ndc}"`]) {
    const r = await fetcher(`${OPENFDA_NDC}?search=${encodeURIComponent(q)}&limit=1`);
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`openFDA ${r.status}`);
    const hit = ((await r.json()) as { results?: any[] }).results?.[0];
    if (!hit) continue;
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
  return null;
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
  /** The device's medicine names, for pet products' strengths. */
  names?: MedicineNames;
}

/**
 * The course with the FDA's listing applied when the label's NDC is listed and agrees with what
 * was read: name, strength, form and route from the listing, marked `sources: 'fda'`. A pet
 * product read by name gets the strengths it comes in (`strengthChoices`) when its strength was
 * not read. Network failures leave the course as read.
 */
export async function withListing(course: LabelCourse, options: ListingOptions = {}): Promise<LabelCourse> {
  const out: LabelCourse = { ...course, sources: { ...course.sources }, assumptions: [...course.assumptions] };
  if (course.ndc) {
    let listing: Listing | null = null;
    try {
      listing = await ndcListing(course.ndc, options.fetch);
    } catch {
      // Offline or the service is down: the label as read.
    }
    if (listing) {
      const agrees = (course.name && sameName(course.name, listing)) || (course.strength && partOf(course.strength, listing.strength));
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
        out.assumptions.push(kt('dose.ndcDisagrees', { ndc: course.ndc, name: titleCase(listing.brand) }));
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
