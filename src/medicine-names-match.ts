/**
 * Matching words read off a label against the medicine names on the device (`./medicine-names`,
 * loaded on first use): exact, one or two letters wrong (by length), or cut short at the end of a
 * curved label ("Tobramyci"). Only names of five letters or more count, and words labels use for
 * other things ("Relief", "Allergy") are left out, so a person's or a shop's name doesn't match.
 * A word cut short counts only when it is seven letters or more and only one name has it.
 */

export interface PetProduct {
  name: string;
  generic: string;
  form: string;
  strengths: string[];
}

export interface MedicineNames {
  /** The medicine name a read word is, if any ("Tobramyci" -> "tobramycin"). */
  match(word: string): string | undefined;
  /** The pet product a name is (brand or generic), with the strengths it comes in; of the same kind as `form` (tablets or liquids) when given. */
  pet(name: string, form?: string): PetProduct | undefined;
}

/** Words that are names in the lists but mean something else on a label. */
const LABEL_WORDS = new Set(
  ('relief allergy sleep children childrens tablets tablet capsules capsule acid reducer original formula strength extra maximum night daytime nighttime health basic basics care plus ultra cough cold sinus pain fever eye drops nasal spray oral solution sterile active complete daily gentle natural clear regular ' +
    'topical prevent prevents prevention preventive treatment treats control controls kills fleas ticks heartworm heartworms roundworms hookworms tapeworms worms dogs puppies cats kittens ' +
    'chewable chewables flavored flavor beef chicken liver soft coated scored contents caution federal veterinarian veterinary licensed approved warning warnings indications dosage directions ' +
    'store storage temperature controlled package insert prescribing information manufactured distributed packaged inflammation infection itching antibacterial antibiotic antihistamine ' +
    'contact contains containing protect protects nostril nostrils children nasal reliever relieves symptoms').split(' '),
);

/** Salts, forms and the like: part of many names, the name of none. */
const QUALIFIERS = /^(?:ophthalmic|ointment|capsules?|tablets?|solution|suspension|injection|injectable|chewables?|potassium|sodium|hydrochloride|calcium|magnesium|sulfate|acetate|citrate|phosphate|chloride|maleate|besylate|tartrate|succinate|bicarbonate|oxide|extended|release|delayed|topical|vaginal|rectal|transdermal|inhalation|aerosol|powder|cream|lotion|shampoo|spray|nasal|liquid|syrup|elixir|drops|patch|junior|infants?|adults?|womens?|mens|childrens?|vitamin|multi\w*|super|ultra|extra|maximum|original|advanced|complete|natural|instant|rapid|liquid|softgels?|gummies|gummy)$/i;

/** Liquids (solutions, suspensions, injections) apart from tablets, chews and capsules. */
const liquid = (form: string) => /solution|suspension|liquid|drops|inject|syrup|emulsion/i.test(form);

const key = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '');

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The matcher over a list of names (one name per entry; multi-word names by their distinctive words). */
export function namesMatcher(human: string[], pets: PetProduct[] = []): MedicineNames {
  const words = new Map<string, string>();
  const add = (word: string, name: string) => {
    const k = key(word);
    if (k.length >= 5 && !LABEL_WORDS.has(k) && !words.has(k)) words.set(k, name);
  };
  // A name is matched by its first word ("Simparica Trio" by "Simparica", "oclacitinib maleate"
  // by "oclacitinib"); the answer is that word as listed, never a longer name it was part of.
  for (const n of [...pets.flatMap((p) => [p.name, p.generic]), ...human]) {
    const first = n.split(/[\s/,()-]+/).filter(Boolean)[0] ?? '';
    if (!QUALIFIERS.test(first)) add(first, first);
  }
  const list = [...words.keys()];
  // A pet medicine by any word of its brand or generic name, with the strengths of every product
  // of the same kind (tablets, or liquids) that shares the word ("Proin 50" and "Proin 75").
  const byPet = new Map<string, PetProduct[]>();
  for (const p of pets) {
    for (const n of [p.name, p.generic]) {
      for (const w of n.split(/[\s/,()-]+/)) {
        const k = key(w);
        if (k.length < 5 || QUALIFIERS.test(k) || LABEL_WORDS.has(k)) continue;
        const list = byPet.get(k) ?? [];
        const had = list.find((x) => liquid(x.form) === liquid(p.form));
        if (!had) list.push({ ...p, strengths: [...p.strengths] });
        else for (const st of p.strengths) if (!had.strengths.includes(st)) had.strengths.push(st);
        byPet.set(k, list);
      }
    }
  }
  for (const list of byPet.values()) for (const p of list) p.strengths.sort((a, b) => parseFloat(a) - parseFloat(b));
  return {
    match(word) {
      const k = key(word);
      if (k.length < 5 || LABEL_WORDS.has(k)) return undefined;
      const exact = words.get(k);
      if (exact) return exact;
      const max = k.length >= 10 ? 2 : k.length >= 7 ? 1 : 0;
      let best: string | undefined;
      let bestD = max + 1;
      let prefix: string | undefined;
      let prefixes = 0;
      for (const w of list) {
        if (max) {
          const d = distance(k, w, max);
          if (d < bestD) {
            bestD = d;
            best = words.get(w);
          }
        }
        // Cut short at either end, as on a label that curves out of sight ("Tobramyci", "phalexin").
        if (k.length >= 8 && w.length > k.length && (w.startsWith(k) || w.endsWith(k)) && prefix !== words.get(w)) {
          prefix = words.get(w);
          prefixes++;
        }
      }
      if (best) return best;
      return prefixes === 1 ? prefix : undefined;
    },
    pet(name, form) {
      for (const w of name.split(/[\s/,()-]+/)) {
        const list = byPet.get(key(w));
        if (!list) continue;
        return (form ? list.find((p) => liquid(p.form) === liquid(form)) : undefined) ?? list.find((p) => !liquid(p.form)) ?? list[0];
      }
      return undefined;
    },
  };
}

let loading: Promise<MedicineNames> | undefined;

/** The device's medicine names, loaded once (its own chunk, about 50 KB compressed). */
export function medicineNames(): Promise<MedicineNames> {
  loading ??= import('./medicine-names.js').then(({ HUMAN_NAMES, PET_PRODUCTS }) => namesMatcher(HUMAN_NAMES.split('\n'), PET_PRODUCTS));
  loading.catch(() => (loading = undefined));
  return loading;
}
