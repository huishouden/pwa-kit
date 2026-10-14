/**
 * Field-level scoring for the label benchmark. A field counts when the label shows it (truth not
 * null): right, wrong (filled with something else: the garbled fills a person has to catch), or
 * empty. Text measures: the character error rate and word precision/recall where the label's
 * full text is known (synthetic labels, the local photos), and key-token recall everywhere.
 */
import type { Truth } from './fetch';

export const FIELDS = ['name', 'strength', 'strengthOffered', 'form', 'route', 'ndc', 'directions'] as const;
export type Field = (typeof FIELDS)[number];
export type Outcome = 'right' | 'wrong' | 'empty';

/** What a pipeline produced for one image, in the parser's terms. */
export interface Reading {
  text: string;
  name?: string;
  strength?: string;
  form?: string;
  route?: string;
  ndc?: string;
  doseAmount?: number;
  doseUnit?: string;
  timesPerDay?: number;
  intervalHours?: number;
  asNeeded?: boolean;
  /** Every field a person would see filled in (notes too), for the privacy check. */
  shown: string[];
  /** Strengths offered to pick from (the label's own unreadable). */
  strengthChoices?: string[];
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9.%/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => norm(s).replace(/[./%]/g, ' ').split(' ').filter(Boolean);

const QUALIFIERS = new Set(
  'usp tablets tablet tabs tab caplets capsules capsule caps chewable chewables chews chew soft oral solution suspension for ophthalmic ointment film coated hcl er dr ext extended release delayed sterile topical drops drop eye nasal spray injectable injection inhalation aerosol hfa the and of cream gel liquid metered hydrochloride sodium potassium calcium besylate maleate sulfate citrate hyclate dihydrate trihydrate monohydrate'.split(' '),
);

export function nameOutcome(parsed: string | undefined, names: string[]): Outcome {
  if (!parsed?.trim()) return 'empty';
  const p = new Set(words(parsed).filter((w) => !QUALIFIERS.has(w)));
  for (const n of names) {
    const t = words(n).filter((w) => !QUALIFIERS.has(w));
    if (t.length && t.every((w) => p.has(w)) && p.size - t.length <= 1) return 'right';
  }
  return 'wrong';
}

const UNIT: Record<string, string> = { mcg: 'mcg', ug: 'mcg', µg: 'mcg', mg: 'mg', g: 'g', gm: 'g', ml: 'ml', '%': '%', iu: 'unit', unit: 'unit', units: 'unit' };
/** "15-92MG" -> 15 mg, 92 mg; "125 mg/5 mL" -> 125 mg, 5 ml; "0.5%" -> 0.5 %. */
export function amounts(s: string): string[] {
  const out: string[] = [];
  const t = s.toLowerCase().replace(/,(?=\d{3}\b)/g, '').replace(/(\d),(\d)/g, '$1.$2');
  const re = /(\d+(?:\.\d+)?|\.\d+)((?:\s*[-/]\s*(?:\d+(?:\.\d+)?|\.\d+))*)\s*(mcg|ug|µg|mg|gm|g|ml|%|iu|units?)\b|(\d+(?:\.\d+)?)\s*(%)/g;
  for (let m; (m = re.exec(t)); ) {
    if (m[4]) {
      out.push(`${Number(m[4])} %`);
      continue;
    }
    const unit = UNIT[m[3]] ?? m[3];
    for (const n of [m[1], ...(m[2].match(/\d+(?:\.\d+)?|\.\d+/g) ?? [])]) out.push(`${Number(n)} ${unit}`);
  }
  return out.sort();
}

export function strengthOutcome(parsed: string | undefined, truth: string | string[]): Outcome {
  if (!parsed?.trim()) return 'empty';
  const p = amounts(parsed).join('|');
  if (!p) return 'wrong';
  return (Array.isArray(truth) ? truth : [truth]).some((t) => {
    const a = amounts(t);
    // The parser keeps "per 5 mL" denominators only sometimes; the numerator alone is still right.
    return a.join('|') === p || a.filter((x) => !/ ml$/.test(x)).join('|') === p.split('|').filter((x) => !/ ml$/.test(x)).join('|');
  })
    ? 'right'
    : 'wrong';
}

export function canonicalForm(form: string | undefined): string | undefined {
  if (!form) return undefined;
  const f = form.toLowerCase();
  if (/chew/.test(f)) return 'chewable';
  if (/tab|caplet/.test(f)) return 'tablet';
  if (/cap/.test(f)) return 'capsule';
  if (/inhaler|aerosol|hfa/.test(f)) return 'inhaler';
  if (/spray/.test(f)) return 'spray';
  if (/inject/.test(f)) return 'injection';
  if (/ointment|cream|gel/.test(f)) return 'ointment';
  if (/solution|suspension|syrup|liquid|drop|elixir/.test(f)) return 'liquid';
  if (/powder|granule/.test(f)) return 'powder';
  if (/patch|transdermal/.test(f)) return 'patch';
  return f;
}

export function canonicalRoute(route: string | undefined): string | undefined {
  if (!route) return undefined;
  const r = route.toLowerCase();
  if (/mouth|oral|swallow/.test(r)) return 'oral';
  if (/eye|ophthalm/.test(r)) return 'ophthalmic';
  if (/ear|otic/.test(r)) return 'otic';
  if (/nos|nasal/.test(r)) return 'nasal';
  if (/inhal/.test(r)) return 'inhalation';
  if (/skin|subcut|inject|intraven|intramusc/.test(r)) return 'injection';
  if (/topical|affected|apply|skin/.test(r)) return 'topical';
  return r;
}

const digits = (s: string | undefined) => (s ?? '').replace(/\D/g, '');

const UNIT_ALIAS: Record<string, string> = { chew: 'tablet', tablet: 'tablet', capsule: 'capsule', ml: 'ml', drop: 'drop', puff: 'puff' };

export function directionsOutcome(r: Reading, d: NonNullable<Truth['directions']>): Outcome {
  const has = r.timesPerDay !== undefined || r.intervalHours !== undefined || r.doseAmount !== undefined || r.asNeeded;
  if (!has) return 'empty';
  if (d.dose) {
    const [n, unit] = d.dose.split(' ');
    if (r.doseAmount !== Number(n) || UNIT_ALIAS[r.doseUnit ?? ''] !== UNIT_ALIAS[unit.replace(/s$/, '')]) return 'wrong';
  }
  if (d.timesPerDay !== undefined && r.timesPerDay !== d.timesPerDay) return 'wrong';
  if (d.intervalHours !== undefined && r.intervalHours !== d.intervalHours) return 'wrong';
  if (d.asNeeded !== undefined && !!r.asNeeded !== d.asNeeded) return 'wrong';
  return 'right';
}

export function scoreFields(r: Reading, t: Truth): Partial<Record<Field, Outcome>> {
  const out: Partial<Record<Field, Outcome>> = {};
  out.name = nameOutcome(r.name, t.names);
  if (t.strength) {
    out.strength = strengthOutcome(r.strength, t.strength);
    // Empty, but the right one is among the strengths offered to pick from.
    // Of the labels whose strength was not read: the right one among the strengths offered to pick from.
    if (out.strength === 'empty') out.strengthOffered = !r.strengthChoices?.length ? 'empty' : r.strengthChoices.some((c) => strengthOutcome(c, t.strength!) === 'right') ? 'right' : 'wrong';
  }
  if (t.form) out.form = !r.form ? 'empty' : canonicalForm(r.form) === t.form ? 'right' : 'wrong';
  if (t.route) out.route = !r.route ? 'empty' : canonicalRoute(r.route) === t.route ? 'right' : 'wrong';
  if (t.ndc) out.ndc = !r.ndc ? 'empty' : digits(r.ndc) === digits(t.ndc) ? 'right' : 'wrong';
  if (t.directions) out.directions = directionsOutcome(r, t.directions);
  return out;
}

/** Private strings (synthetic people and places) that ended up in a field a person would save. */
export function leaks(r: Reading, t: Truth): string[] {
  const shown = norm(r.shown.join(' | '));
  const out: string[] = [];
  for (const p of t.private ?? []) {
    for (const w of words(p).filter((w) => w.length >= 4 && !/^\d+$/.test(w))) {
      if (new RegExp(`\\b${w}\\b`).test(shown)) out.push(w);
    }
  }
  return [...new Set(out)];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Character error rate of the read text against the label's text (both normalised: case, spacing). */
export function cer(text: string, truth: string): number {
  const a = norm(text), b = norm(truth);
  return b.length ? levenshtein(a, b) / b.length : 0;
}

/** Word precision (share of read words that are on the label) and recall (share of label words read). */
export function wordPR(text: string, truth: string): { precision: number; recall: number } {
  const read = words(text).filter((w) => w.length >= 2);
  const real = words(truth).filter((w) => w.length >= 2);
  const bag = new Map<string, number>();
  for (const w of real) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of read) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(w, n - 1);
    }
  }
  return { precision: read.length ? hit / read.length : 1, recall: real.length ? hit / real.length : 1 };
}

/** Share of the label's key tokens (name words, strength numbers, NDC) that appear in the read text. */
export function keyRecall(text: string, t: Truth): number {
  const keys = new Set<string>();
  for (const w of words(t.names[0]).filter((w) => w.length >= 3 && !QUALIFIERS.has(w))) keys.add(w);
  for (const s of [t.strength].flat()) for (const n of (s ?? '').match(/\d+(?:\.\d+)?/g) ?? []) keys.add(n);
  if (t.ndc) keys.add(digits(t.ndc));
  if (!keys.size) return 1;
  const flat = norm(text);
  const flatDigits = digits(text);
  let hit = 0;
  for (const k of keys) if (/^\d{9,}$/.test(k) ? flatDigits.includes(k) : new RegExp(`(^|[^a-z0-9.])${k.replace('.', '\\.')}([^a-z0-9]|$)`).test(flat)) hit++;
  return hit / keys.size;
}
