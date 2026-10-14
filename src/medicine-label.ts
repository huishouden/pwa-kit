/**
 * The medicine on a label: name, strength, form, route and NDC, from the text of a package label
 * (the maker's box or bottle) as well as a pharmacy or vet label. `./dose` `parseDirections` reads
 * the directions; this adds what a package label carries in its own layout: the name over several
 * lines in the largest print, the strength on a line of its own, "Tablets, USP" under the name,
 * "For oral use in dogs only", and the National Drug Code.
 *
 * Privacy: the person's name, the owner's, the prescriber's and the pharmacy's address are on the
 * same labels. A line is only taken for the medicine's name when it sits with a strength or a form
 * or is a known medicine name (`isMedicineName`), never from a line that names a patient, client,
 * doctor or place, and never by print size alone on a pharmacy or vet label.
 */

import { confidenceOf, parseDirectionsCore, type ParsedCourse, type Route } from './dose';
import { kt } from './i18n.js';
import type { Box } from './label-image';
import type { LabelLine } from './label-read';

/** Where a field's value came from: the label as read, the FDA's listing for its NDC, or a medicine-name list. */
export type FieldSource = 'label' | 'fda' | 'names';

export interface LabelCourse extends ParsedCourse {
  /** The National Drug Code as printed ("59390-217-02"). */
  ndc?: string;
  /** Where name, strength, form and route came from; absent means the label. */
  sources?: Partial<Record<'name' | 'strength' | 'form' | 'route', FieldSource>>;
  /** Strengths the medicine comes in, when the label's own was unreadable (from a listing), for the person to pick. */
  strengthChoices?: string[];
}

const NDC_PREFIX = String.raw`(?:N\s?D\s?C|NOC|MDC|NDG|KDC|HDC|NBC)\s*(?:#|No\.?|number)?\s*[:#]?\s*`;
const DASH = String.raw`\s?[-‐‑–—_~]\s?`;

/**
 * The NDC on a label, as printed: 4-4-2, 5-3-2, 5-4-1 or 5-4-2 digits. Digits run together after
 * "NDC" are split by their count (5-5 as 5-3-2, 4-6 as 4-4-2, 11 as 5-4-2). Phone numbers (3-3-4),
 * Rx numbers and dates never match.
 */
export function findNdc(text: string): string | undefined {
  const t = text.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
  const dashed = new RegExp(String.raw`(?<![\d-])(\d{4,5})${DASH}(\d{3,4})${DASH}(\d{1,2})(?![\d-])`, 'g');
  const candidates: { ndc: string; prefixed: boolean; maker?: boolean }[] = [];
  for (let m; (m = dashed.exec(t)); ) {
    const [a, b, c] = [m[1], m[2], m[3]];
    const shape = `${a.length}-${b.length}-${c.length}`;
    if (!['4-4-2', '5-3-2', '5-4-1', '5-4-2'].includes(shape)) continue;
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    const prefixed = new RegExp(`${NDC_PREFIX}$`, 'i').test(before);
    candidates.push({ ndc: `${a}-${b}-${c}`, prefixed, maker: prefixed && /\b(?:mfg|mfr|source|manufacturer'?s?)\b[\s.:]*\S*\s*$/i.test(before.replace(new RegExp(`${NDC_PREFIX}$`, 'i'), '')) });
  }
  const loose = new RegExp(String.raw`${NDC_PREFIX}(\d{4,5})${DASH}(\d{5,6})(?!\d)|${NDC_PREFIX}(\d{10,11})(?!\d)`, 'gi');
  for (let m; (m = loose.exec(t)); ) {
    if (m[1]) {
      const [a, rest] = [m[1], m[2]];
      if (a.length === 5 && rest.length === 5) candidates.push({ ndc: `${a}-${rest.slice(0, 3)}-${rest.slice(3)}`, prefixed: true });
      else if (a.length === 4 && rest.length === 6) candidates.push({ ndc: `${a}-${rest.slice(0, 4)}-${rest.slice(4)}`, prefixed: true });
      else if (a.length === 5 && rest.length === 6) candidates.push({ ndc: `${a}-${rest.slice(0, 4)}-${rest.slice(4)}`, prefixed: true });
    } else if (m[3].length === 11) {
      const d = m[3];
      candidates.push({ ndc: `${d.slice(0, 5)}-${d.slice(5, 9)}-${d.slice(9)}`, prefixed: true });
    }
  }
  // "MFG NDC" or "Source NDC" (the maker's code on a repackager's label) loses to the label's own.
  const own = candidates.filter((c) => c.prefixed && !c.maker);
  return (own[0] ?? candidates.find((c) => c.prefixed) ?? candidates[0])?.ndc;
}

const FORM_WORDS = String.raw`(?:chewable tablets?|soft chewable tablets?|chewables?|chews|tablets?|caplets?|capsules?|softgels?|oral solution|oral suspension|for oral suspension|suspension|solution|ophthalmic solution|ophthalmic ointment|ointment|cream|gel|eye drops|ear drops|drops|nasal spray|spray|injectable solution|injection|inhalation aerosol|inhaler|aerosol|syrup|elixir|powder|granules|patch(?:es)?)`;
const FORM_RE = new RegExp(String.raw`\b${FORM_WORDS}\b`, 'i');
const STRENGTH_RE = /(?<![\w.])(\d+(?:[.,]\d+)?(?:\s*[-/]\s*\d+(?:[.,]\d+)?)*)\s*(mg|mcg|µg|g|iu|units?|%)(?:\s*(?:\/|per)\s*(?:\d+(?:\.\d+)?\s*)?(ml|tab(?:let)?|cap(?:sule)?|g|dose|spray|actuation|chewable))?(?![a-z])/i;

/** Lines that are never a medicine's name: who and where, warnings, storage, counts, codes. */
const NOT_NAME = [
  // Who: the patient, the pet and its owner, however the colon was read.
  /\b(?:pet|patient|client|owner|name|dob|species)\s*[:;.,]|^\W*(?:pet|patient|client|owner|species)\b|\((?:canine|feline|dog|cat|equine|k9)\)/i,
  // Where and by whom: prescriber, pharmacy (chains by name, a store number), clinic.
  /\bdr\.?\s|\bd\.?v\.?m\b|\bm\.?d\.?\b|\bprescriber\b|\bprescribed\b|\bpharmac(?:y|ist)\b|\bclinic\b|\bhospital\b|\bveterinary\b|\banimal (?:health|hospital|clinic)\b|\bdrugs?\s*(?:store|#)|#\s*\d{3,}|\b(?:walgreens|cvs|rite aid|walmart|kroger|costco|publix|safeway|wegmans|meijer|albertsons|express scripts|optum|caremark)\b/i,
  // Directions are never the name.
  /\b(?:by mouth|daily|every|times|hours?|twice|once|take|give|apply|instill|inhale|with (?:food|meals))\b/i,
  /\b(?:rx|ndc|lot|exp|qty|quantity|refills?|date|filled|discard|use by|batch|serial|gtin|mfr|mfg|product|item)\b/i,
  /\b(?:each|contains|store|storage|keep|warning|warnings|caution|federal|law|approved|nada|anada|manufactured|distributed|packaged|marketed|made in|see|insert|dosage|usual|directions|read|dispense|net|contents|count|only|use|uses|purpose|drug facts|active ingredients?|indications?|compare|questions|call|www|\.com|inc\b|llc|ltd|corp|laboratories|pharmaceuticals?|sterile|non-?drowsy|relief|actual size|rev\b|code)\b/i,
  /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/,
  /\d+\s+[a-z]+(?:\s+[a-z]+)?\s+(?:st|street|rd|road|ave|avenue|blvd|lane|ln|dr|drive|way|ct|court|hwy|parkway|pkwy)\b/i,
  /\b[A-Z]{2}\s+\d{5}\b/,
];

/** Words that, on their own, are not a name: form words, "USP", strengths. */
const FILLER = /^(?:usp|nf|bp|hcl|er|xr|sr|dr|odt|and|with|for|oral|tablets?|caplets?|capsules?|chewables?|chewable|soft|film|coated|solution|suspension|ophthalmic|otic|nasal|topical|ointment|cream|gel|drops?|spray|injection|injectable|sterile|syrup|aerosol|inhal\w*|the|of)$/i;

/** A person's name printed alone ("TOBIAS WRENFIELD", "Pickle (Canine)"): two or three capitalised words, nothing medical. */
const PERSONISH = /^(?:[A-Z][a-z'-]+|[A-Z][A-Z'-]+)(?:\s+(?:[A-Z]\.?|[A-Z][a-z'-]+|[A-Z][A-Z'-]+)){1,2}(?:\s*\((?:[Cc]anine|[Ff]eline|[Dd]og|[Cc]at|[Ee]quine|CANINE|FELINE)\))?$/;

/** Endings of generic medicine names (WHO stems and common ones), which people's names don't have. */
const DRUG_STEM = /(?:cillin|mycin|micin|cycline|floxacin|oxacin|pril|sartan|olol|statin|azole|prazole|tidine|dipine|triptan|gliptin|gliflozin|parin|profen|coxib|cort|sone|solone|zepam|zolam|setron|lukast|afil|tinib|citinib|xaban|gatran|mab|vir|pentin|mectin|laner|pitant|bendan|amide|azine|zodone|oxetine|aline|pramine|tadine|ifen|formin|thiazide|semide|lol|terol|phylline|thyroxine|thromycin|cefa\w*|ceph\w*|sulf\w*|amox\w*)\b/i;

/** A line that reads like a person's or pet's name and nothing medical. */
const personLine = (t: string) => {
  // Marks the reader leaves around a name ("CORNELIUS HAVERTY =") don't make it any less a name.
  const bare = t.replace(/[^A-Za-z'().\s-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return PERSONISH.test(bare) && !FORM_RE.test(t) && !DRUG_STEM.test(t);
};

const letters = (s: string) => (s.match(/[a-z]/gi) ?? []).length;

function nameLike(line: string): boolean {
  if (letters(line) < 4 || NOT_NAME.some((re) => re.test(line))) return false;
  const words = line.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  if (words.length > 7) return false;
  // Mostly letters: a garbled line ("ei) psstR = oC 2 .") is mostly symbols and short bits.
  const real = words.filter((w) => /^[A-Za-z][A-Za-z'/().,-]*[A-Za-z).,]?$/.test(w) && letters(w) >= 2);
  return real.length >= Math.max(1, words.length * 0.6);
}

/** The name with form words and "USP" taken off its end, and the form if there was one. */
function splitForm(name: string): { name: string; form?: string } {
  let form: string | undefined;
  let rest = name.replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (;;) {
    const m = rest.match(new RegExp(String.raw`\s+(${FORM_WORDS}|usp|nf|for)$`, 'i'));
    if (!m) break;
    if (!/^(usp|nf|for)$/i.test(m[1])) form ??= m[1].toLowerCase();
    rest = rest.slice(0, -m[0].length);
  }
  return { name: rest, form };
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s\-/(])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

const ROUTE_WORDING: [RegExp, Route][] = [
  [/\bophthalm\w*|\bin(?:to)? (?:the |each |both )?eyes?\b|\beye drops\b/i, 'in the eye'],
  [/\botic\b|\bin(?:to)? (?:the |each |both )?ears?\b|\bear drops\b/i, 'in the ear'],
  [/\bnasal\b|\bnostrils?\b|\bin(?:to)? (?:the |each )?nose\b/i, 'in the nose'],
  [/\binhal(?:e|ation|er)\b/i, 'inhaled'],
  [/\bsubcutaneous|\bunder the skin\b/i, 'under the skin'],
  [/\bintravenous|\bintramuscular|\binjectable\b|\binjection\b/i, 'by injection'],
  [/\bfor oral use\b|\boral (?:use|solution|suspension)\b|\bby mouth\b|\borally\b|\bfor oral\b|\bchewable\b|\btablets?\b|\bcapsules?\b|\bcaplets?\b/i, 'by mouth'],
  [/\btopical\b|\bon the skin\b|\bexternal use\b|\bapply\b/i, 'on the skin'],
];

/** How the medicine is taken, from the label's wording ("For oral use in dogs only", "Ophthalmic"). */
export function findRoute(text: string): Route | undefined {
  for (const [re, route] of ROUTE_WORDING) if (re.test(text)) return route;
  return undefined;
}

/** Whether a label is a pharmacy's or a vet's (people and places on it), rather than the maker's. */
export function isDispensingLabel(text: string): boolean {
  let marks = 0;
  for (const re of [/\brx\s*(?:#|no\.?)/i, /\bqty\b|\bquantity\b/i, /\brefills?\b/i, /\bdr\.?\s|\bdvm\b|\bprescriber\b/i, /\b(?:pet|patient|client|owner)\s*:/i, /\bpharmacy\b|\bclinic\b|\banimal hospital\b/i]) {
    if (re.test(text)) marks++;
  }
  return marks >= 2;
}

export interface ParseLabelOptions {
  /** The lines as read, with print sizes (`./label-read`); without them the text's lines are used. */
  lines?: LabelLine[];
  /** Whether a word is a known medicine name (a list on the device); improves the name on hard photos. */
  isMedicineName?: (word: string) => string | undefined;
}

/**
 * Everything a label says about the medicine and how to take it: `parseDirections` for the
 * directions, plus the package-label fields. Values are the label's own words; nothing is guessed:
 * a field stays empty when the label doesn't show it clearly.
 */
export function parseLabel(text: string, options: ParseLabelOptions = {}): LabelCourse {
  const { course: read, multiLine } = parseDirectionsCore(text);
  const course: LabelCourse = read;
  const ndc = findNdc(text);
  if (ndc) course.ndc = ndc;
  const dispensing = isDispensingLabel(text);
  const lines: Line[] = (options.lines ?? text.split('\n').map((t): Line => ({ text: t, height: 0 })))
    .map((l): Line => ({ text: l.text.replace(/[|_~`]+/g, ' ').replace(/\s+/g, ' ').trim(), height: l.height, box: 'box' in l ? l.box : undefined }))
    // Two columns read as one line ("amLODIPine Besylate MFG NDC: 67877-…"): split before the code.
    .flatMap((l) => {
      const m = l.text.match(/\s(?:MFG|MFR|NDC|Rx|Lot|Exp|Qty)\b/i);
      return m?.index && m.index >= 4 ? [{ ...l, text: l.text.slice(0, m.index) }, { ...l, text: l.text.slice(m.index + 1) }] : [l];
    })
    .filter((l) => l.text);

  if (course.name && options.isMedicineName && nameLooksRight(course.name)) {
    // The drug line's name as listed ("PHALEXIN 500MG" on a curved vial: "Cephalexin").
    const kept = keepKnown(course.name, options.isMedicineName);
    if (kept) course.name = titleCase(kept);
  }
  if (!course.name || !nameLooksRight(course.name)) {
    const found = packageName(lines, dispensing, options.isMedicineName);
    if (found) {
      course.name = found.name;
      if (found.strength) course.strength = found.strength;
      if (found.form) course.form = found.form;
    } else {
      // No name block: a medicine name spelled exactly anywhere ("Each tablet contains lisinopril").
      const exact = options.isMedicineName && exactName(lines, options.isMedicineName);
      if (exact) course.name = titleCase(exact);
      else delete course.name;
    }
  }
  if (!course.strength) {
    const s = lines.map((l) => l.text.match(STRENGTH_RE)).find((m) => m && !/\beach\b|\bcontains\b/i.test(m.input ?? ''));
    if (s) course.strength = s[0].replace(/\s+/g, ' ').trim();
  }
  // A combination ("875 mg/125 mg", "5 mg / 20 mg") read as one of its amounts: the whole of it.
  for (const l of lines) {
    const m = l.text.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|g)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(mg|mcg|g)\b/i);
    if (!m || /\beach\b|\bcontains\b/i.test(l.text)) continue;
    const nums = [m[1], m[3].replace(',', '')].map(Number);
    const had = Number(course.strength?.match(/\d+(?:\.\d+)?/)?.[0]);
    if (!course.strength || nums.includes(had)) course.strength = `${m[1]} ${m[2].toLowerCase()}/${m[3]} ${m[4].toLowerCase()}`;
    break;
  }
  if (!course.form || !/chew|inject/i.test(course.form)) {
    // The most telling form on the label: chewable or injectable over plain tablets or solution.
    const forms = lines.filter((l) => !NOT_NAME.slice(0, 2).some((re) => re.test(l.text))).flatMap((l) => l.text.match(new RegExp(FORM_RE.source, 'gi')) ?? []);
    const special = forms.find((f) => /chew|inject/i.test(f));
    if (special) course.form = special.toLowerCase();
    else if (!course.form && forms.length) course.form = forms[0].toLowerCase();
  }
  // Lines that gave the name, strength, form or NDC are used, not "read but not used".
  const used = [course.name, course.strength, course.form, course.ndc].filter((v): v is string => !!v).map((v) => v.toLowerCase());
  course.unparsed = course.unparsed.filter((u) => {
    const l = u.toLowerCase().replace(/[^a-z0-9.%/ -]+/g, ' ').trim();
    if (!l || /^(?:usp|nf|sterile|rx only)$/.test(l)) return false;
    return !used.some((v) => l === v || (l.length >= 4 && (v.includes(l) || (l.includes(v) && l.length - v.length < 12))));
  });
  if (!course.route) {
    const r = findRoute(lines.filter((l) => !/\bkeep out|\bnot for\b|\bwarning|\bhuman\b/i.test(l.text)).map((l) => l.text).join('\n'));
    if (r) course.route = r;
  }
  if (!course.name && multiLine) course.assumptions.push(kt('dose.assumeNoName'));
  course.confidence = confidenceOf(course);
  return course;
}

/** A name from the drug line is plausible: real words beyond form words, not a garbled run or a person. */
function nameLooksRight(name: string): boolean {
  return nameLike(name) && name.split(/\s+/).some((w) => !FILLER.test(w) && letters(w) >= 3) && !personLine(name);
}

type Line = { text: string; height: number; box?: Box };

/**
 * The lines under line `i` in its column, nearest first (up to `max`): with the reader's boxes, the
 * next line down that overlaps it sideways, then the next under that; without, the text's order.
 * Labels set text in columns, and a name continues under itself, not in the column beside it.
 */
function below(lines: Line[], i: number, max: number): number[] {
  if (!lines[i].box) return Array.from({ length: Math.min(max, lines.length - i - 1) }, (_, k) => i + 1 + k);
  const out: number[] = [];
  let cur = lines[i];
  while (out.length < max) {
    const c = cur.box!;
    let best = -1;
    let bestGap = Infinity;
    for (let j = 0; j < lines.length; j++) {
      const b = lines[j].box;
      if (!b || j === i || out.includes(j) || b.y0 < c.y0 + cur.height * 0.4) continue;
      const overlap = Math.min(c.x1, b.x1) - Math.max(c.x0, b.x0);
      if (overlap < Math.min(c.x1 - c.x0, b.x1 - b.x0) * 0.3) continue;
      const gap = b.y0 - c.y1;
      if (gap > Math.max(cur.height, lines[j].height) * 1.6) continue;
      if (gap < bestGap) {
        best = j;
        bestGap = gap;
      }
    }
    if (best < 0) break;
    out.push(best);
    cur = lines[best];
  }
  return out;
}

function packageName(lines: Line[], dispensing: boolean, isMedicineName?: ParseLabelOptions['isMedicineName']): { name: string; strength?: string; form?: string } | undefined {
  /** A medicine name in the line; `exact` when a word is spelled as listed (a near match could be a person's name). */
  const known = (line: string, exact = false) => {
    if (!isMedicineName) return undefined;
    for (const w of line.split(/[^A-Za-z-]+/)) {
      if (w.length < 4) continue;
      const hit = isMedicineName(w);
      if (hit && (!exact || hit.toLowerCase() === w.toLowerCase())) return hit;
    }
    return undefined;
  };
  const candidates: { at: number; score: number }[] = [];
  const heights = lines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => b - a);
  const tall = heights.length ? heights[Math.floor(heights.length * 0.1)] : 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if (!nameLike(t)) continue;
    const exact = known(t, true);
    if (personLine(t) && !exact) continue;
    const named = exact ?? known(t);
    // "Tablets, USP" under the name is part of it, never the name itself.
    if (!t.split(/[\s,]+/).some((w) => !FILLER.test(w.replace(/[^A-Za-z]/g, '')) && letters(w) >= 3)) continue;
    const around = [t, ...below(lines, i, 3).map((j) => lines[j].text)].join(' ');
    const nearStrength = STRENGTH_RE.test(around);
    const nearForm = FORM_RE.test(around);
    let score = (named ? 3 : 0) + (nearStrength ? 2 : 0) + (nearForm ? 1 : 0);
    if (tall && lines[i].height >= tall * 0.8) score += dispensing ? 0.5 : 2;
    // On a pharmacy or vet label the drug line carries its strength or form: a line without either
    // is a person, a place or a note, unless it is a medicine's name spelled as listed.
    if (dispensing && !exact && !(STRENGTH_RE.test(t) || FORM_RE.test(t))) continue;
    if (dispensing && !named && !(nearStrength && nearForm)) continue;
    if (!dispensing && !named && !nearStrength && !nearForm && score < 2) continue;
    candidates.push({ at: i, score });
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => b.score - a.score || a.at - b.at);
  const at = candidates[0].at;
  // The name may run over several lines ("Tobramycin / Ophthalmic / Ointment / USP", "Caduet /
  // (amlodipine and / atorvastatin)"): join the lines under it until the strength.
  const parts = [lines[at].text];
  let strength: string | undefined;
  for (const j of below(lines, at, 4)) {
    const t = lines[j].text;
    const s = t.match(STRENGTH_RE);
    if (s) {
      if (letters(t.replace(STRENGTH_RE, '')) <= 3) strength = s[0].replace(/\s+/g, ' ').trim();
      break;
    }
    const form = FORM_RE.test(t) || /^(?:usp|nf)$/i.test(t.trim());
    if (form || (nameLike(t) && t.split(/\s+/).length <= 4 && !personLine(t))) parts.push(t);
    else break;
  }
  let joined = parts.join(' ');
  const inline = joined.match(STRENGTH_RE);
  if (inline) {
    strength ??= inline[0].replace(/\s+/g, ' ').trim();
    joined = joined.slice(0, inline.index).trim();
  }
  const split = splitForm(joined.replace(/[®™*]/g, '').replace(/\s*\(\s*$/, ''));
  const form = split.form;
  let name = split.name;
  // With the list: keep the words that are medicine names (spelled as listed), salts and "and";
  // drop the rest, which on a hard photo is noise read next to the name.
  const kept = isMedicineName ? keepKnown(name, isMedicineName) : '';
  if (kept) name = kept;
  // Not a listed name: only words that look like a name, with a strength and a form under it (and
  // in the largest print, when the reader gave print sizes). Otherwise better empty than garbled.
  else if (candidates[0].score < (tall ? 5 : 3) || !wordy(name) || name.split(/\s+/).some((w) => w.replace(/[^A-Za-z]/g, '').length < 4 || LABELISH.test(w))) return undefined;
  const words = name.split(/\s+/).filter((w) => !FILLER.test(w.replace(/[()]/g, '')));
  if (!words.length || letters(words.join('')) < 3) return undefined;
  return { name: titleCase(name), strength, form };
}

/** The first medicine name spelled exactly as listed (six letters or more), the larger print first; never on a who or where line. */
function exactName(lines: { text: string; height: number }[], isMedicineName: (word: string) => string | undefined): string | undefined {
  const order = [...lines].sort((a, b) => b.height - a.height);
  for (const l of order) {
    if (NOT_NAME.slice(0, 2).some((re) => re.test(l.text)) || /\bcompare\b|\bnot (?:manufactured|distributed)\b|trademark/i.test(l.text)) continue;
    for (const w of l.text.split(/[^A-Za-z-]+/)) {
      if (w.length < 6) continue;
      const hit = isMedicineName(w);
      if (hit && hit.toLowerCase() === w.toLowerCase()) return hit;
    }
  }
  return undefined;
}

/** Words of a label's description, never a medicine's name. */
const LABELISH = /^(?:anti\w+|analgesic|chewa\w*|contain\w*|caution|soft|flavou?red|beef|chicken|dogs?|cats?|puppies|kittens|zoetis|elanco|merck|bayer|virbac|dechra|norbrook|boehringer|ingelheim|amazon|basic|care|signature|select|equate|kirkland|welmate|up&up|walgreens|cvs)$/i;

/** Salts and joining words kept next to a medicine's name. */
const SALT = /^(?:and|hcl|hydrochloride|sodium|potassium|calcium|magnesium|bicarbonate|carbonate|besylate|maleate|sulfate|citrate|tartrate|succinate|medoxomil|hyclate|mesylate|fumarate|acetate|phosphate|bromide|chloride|dihydrate|trihydrate|monohydrate|propionate|clavulanate|plus|combo|trio|er|xr|sr|dr|odt)$/i;

/**
 * The medicine words of a name block, spelled as listed, with salts and "and", and a brand's
 * generic name kept in its brackets ("Caduet (amlodipine and atorvastatin)"); empty if no word is a medicine.
 */
function keepKnown(block: string, isMedicineName: (word: string) => string | undefined): string {
  const toks = block.split(/\s+/).filter(Boolean);
  const out: { word: string; open: boolean; close: boolean }[] = [];
  let found = false;
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    const t = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (!t) continue;
    // A name split by the reader ("Cipro floxacin") is tried joined to its neighbour first.
    const next = toks[i + 1]?.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    if (SALT.test(t)) {
      if (out.length) out.push({ word: t.toLowerCase(), open: raw.startsWith('('), close: raw.endsWith(')') });
      continue;
    }
    const joined = next && next.length >= 2 && !SALT.test(next) ? isMedicineName(t + next) : undefined;
    const hit = joined ?? (t.length >= 5 ? isMedicineName(t) : undefined);
    const last = joined ? toks[i + 1] : raw;
    const mark = { open: raw.startsWith('('), close: last.endsWith(')') };
    if (hit) {
      out.push({ word: hit, ...mark });
      found = true;
      if (joined) i++;
    }
  }
  while (out.length && /^and$/i.test(out[out.length - 1].word)) out.pop();
  const seen = new Set<string>();
  const words = out.filter((w) => !seen.has(w.word.toLowerCase()) && seen.add(w.word.toLowerCase()));
  if (!found) return '';
  const open = words.findIndex((w) => w.open);
  return words
    .map((w, k) => `${k === open && k > 0 ? '(' : ''}${w.word}${open > 0 && k === words.length - 1 ? ')' : ''}`)
    .join(' ');
}

/** Every word of the block looks like a word (letters, a vowel, three or more long). */
function wordy(block: string): boolean {
  return block.split(/\s+/).every((w) => /^[A-Za-z][A-Za-z'-]*[A-Za-z]\.?$/.test(w) && w.replace(/[^A-Za-z]/g, '').length >= 3 && /[aeiouy]/i.test(w));
}
