/**
 * Medicine labels to dose schedules. A photo of a pharmacy or vet label is read on the device
 * (`readLabel`, open-source OCR, nothing uploaded or stored), the directions are parsed with fixed
 * rules (`parseDirections`), and the result becomes daily dose times and reminders.
 *
 * The parser never guesses silently: wording it does not recognise comes back in `unparsed`,
 * and every assumption it makes (a month read as 30 days, only the first step of a taper) comes
 * back in `assumptions`, so the app can show them next to the fields it filled in.
 */

import { readLabelLines, type ReadLabelLinesOptions } from './ocr';
import { fitsRule, type EventRule } from './schedule';
import { kt } from './i18n.js';

export { OCR_LANG_PATH, releaseOcr } from './ocr';

// ---------------------------------------------------------------------------------------------
// OCR

export type ReadLabelOptions = ReadLabelLinesOptions;

/**
 * The text on a label photo, read on the device with tesseract.js (English; see `./ocr`
 * `readLabelLines`, which also gives each line's confidence and print size for
 * `./medicine-label` `parseLabel`). The engine is loaded on first use only, so apps that never
 * call this don't download it.
 */
export async function readLabel(image: Blob, options: ReadLabelOptions = {}): Promise<string> {
  return (await readLabelLines(image, options)).text;
}

/**
 * The text of several photos of one label (the front and the back of a box) as one text for
 * `parseDirections`, in the order given. A line a later photo repeats (an overlap, or the same
 * photo twice) is read once; repeats inside a single photo are left alone.
 */
export function combineLabelTexts(texts: string[]): string {
  const key = (line: string) => line.trim().replace(/\s+/g, ' ').toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    const lines = text.split(/\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
    const fresh = lines.filter((l) => !seen.has(key(l)));
    for (const l of lines) seen.add(key(l));
    out.push(...fresh);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Directions

export type TimeOfDay = 'morning' | 'midday' | 'evening' | 'bedtime';

export interface ParsedCourse {
  /** Medicine name from the label's drug line ("Carprofen"). */
  name?: string;
  /** Strength from the drug line or the directions ("75 mg", "1.5 mg/ml"). */
  strength?: string;
  /** Form from the drug line ("chewable tablets", "oral suspension"). */
  form?: string;
  /** One dose, normalised: "1 tablet", "0.5 ml", "2 drops". */
  dose?: string;
  doseAmount?: number;
  /** Singular unit: "tablet", "capsule", "ml", "drop", "mg". */
  doseUnit?: string;
  /** Doses per dosing day. */
  timesPerDay?: number;
  /** Hours between doses when the label gives an interval ("every 8 hours"; 48 = every other day). */
  intervalHours?: number;
  /** Times of day the label names ("in the morning and at bedtime"). */
  timesOfDay?: TimeOfDay[];
  /** Course length in days. */
  days?: number;
  /** "Until gone" / "until finished": no fixed length. */
  untilGone?: boolean;
  /** true: with food or after meals; false: on an empty stomach. */
  withFood?: boolean;
  /** "As needed" / PRN: no schedule. */
  asNeeded?: boolean;
  /**
   * How it is taken: one of `ROUTES` when the parser names it ("by mouth", "in the eye"), else the
   * label's own words ("in the left ear", "to the affected area"). `routeWords` says it for people.
   */
  route?: Route | (string & {});
  /** Who it is for, from a "Pet:" or "Patient:" line. */
  patient?: string;
  /** Advice lines the app can keep as notes ("Shake well", "Refrigerate"). */
  notes: string[];
  /** 0..1, how much of a usable schedule was found (see `confidenceOf`). */
  confidence: number;
  /** Text the parser did not understand, for the app to show. Never dropped silently. */
  unparsed: string[];
  /** Readings the parser made that the person should confirm. */
  assumptions: string[];
  /** Label lines recognised as pharmacy boilerplate (Rx number, quantity, refills, prescriber, address). */
  ignored: string[];
}

/** The routes the parsers name themselves; anything else in `route` is a label's own wording. */
export const ROUTES = ['by mouth', 'under the skin', 'by injection', 'in the eye', 'in the ear', 'in the nose', 'inhaled', 'on the skin'] as const;
export type Route = (typeof ROUTES)[number];

export const isRoute = (route: string | undefined): route is Route => (ROUTES as readonly string[]).includes(route ?? '');

/** A route as a note, in the active language: the parser's own routes translated, a label's wording as it was. */
export function routeWords(route: string): string {
  return isRoute(route) ? kt('dose.route', { route: route.replace(/ /g, '_') }) : route.replace(/^./, (c) => c.toUpperCase());
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, half: 0.5, 'one-half': 0.5,
  'one half': 0.5, '½': 0.5, '¼': 0.25, '¾': 0.75, 'a half': 0.5,
};

const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|\.\d+|one and (?:a |one-?)half|one-half|one half|a half|half|½|¼|¾|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty|an|a)`;

/** "1 1/2", "1/2", "0.5", "one-half", "two" → number. */
export function parseNumber(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  if (/^one and (a |one-?)half$/.test(t)) return 1.5;
  let m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const UNITS: [RegExp, string][] = [
  [/^(tablets?|tabs?|tbs?)$/, 'tablet'],
  [/^(chewable tablets?|chew tabs?|chewables?|chews?)$/, 'chew'],
  [/^(capsules?|caps?)$/, 'capsule'],
  [/^pills?$/, 'pill'],
  [/^(ml|mls|millilit(?:er|re)s?|cc|ccs)$/, 'ml'],
  [/^(drops?|gtts?)$/, 'drop'],
  [/^puffs?$/, 'puff'],
  [/^sprays?$/, 'spray'],
  [/^(units?|iu)$/, 'unit'],
  [/^(teaspoons?|tsps?)$/, 'teaspoon'],
  [/^(tablespoons?|tbsps?)$/, 'tablespoon'],
  [/^scoops?$/, 'scoop'],
  [/^(packets?|sachets?)$/, 'packet'],
  [/^patch(?:es)?$/, 'patch'],
  [/^(mg|milligrams?)$/, 'mg'],
  [/^(mcg|micrograms?)$/, 'mcg'],
];
const UNIT_WORDS = String.raw`(?:chewable tablets?|chew tabs?|chewables?|chews?|tablets?|tabs?|capsules?|caps?|pills?|millilit(?:er|re)s?|mls?|ccs?|drops?|gtts?|puffs?|sprays?|units?|iu|teaspoons?|tsps?|tablespoons?|tbsps?|scoops?|packets?|sachets?|patch(?:es)?)`;

function unitOf(word: string): string | undefined {
  const w = word.toLowerCase().replace(/\.$/, '');
  return UNITS.find(([re]) => re.test(w))?.[1];
}

/** "0.5 ml", "1 tablet", "2 drops", "1.5 tablets" ("2 tabletas", "2 tabletten"), in the active language. `unit` is the parser's singular English unit. */
export function formatDose(amount: number, unit: string): string {
  const n = Math.round(amount * 1000) / 1000;
  return kt('dose.amount', { unit, n, count: n > 1 ? 2 : 1 });
}

const TIME_OF_DAY_ORDER: TimeOfDay[] = ['morning', 'midday', 'evening', 'bedtime'];

interface State {
  course: ParsedCourse;
  /** Frequencies found, to report disagreements instead of picking one. */
  frequencies: { timesPerDay?: number; intervalHours?: number; text: string }[];
}

interface Rule {
  re: RegExp;
  apply?: (m: RegExpExecArray, s: State) => void;
}

const freq = (timesPerDay: number | undefined, intervalHours?: number) => (m: RegExpExecArray, s: State) =>
  s.frequencies.push({ timesPerDay, intervalHours, text: m[0].trim() });

const tod = (...times: TimeOfDay[]) => (_m: RegExpExecArray, s: State) => {
  const set = new Set([...(s.course.timesOfDay ?? []), ...times]);
  s.course.timesOfDay = TIME_OF_DAY_ORDER.filter((t) => set.has(t));
};

const setDays = (m: RegExpExecArray, s: State) => {
  const n = parseNumber(m[1]);
  if (n === undefined) return;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('w')) s.course.days = n * 7;
  else if (unit.startsWith('m')) {
    s.course.days = n * 30;
    s.course.assumptions.push(kt('dose.assumeMonths', { text: m[0].trim(), days: n * 30 }));
  } else s.course.days = n;
};

const setDose = (amountIndex: number, unitIndex: number) => (m: RegExpExecArray, s: State) => {
  const amount = parseNumber(m[amountIndex]);
  const unit = unitOf(m[unitIndex]);
  if (amount === undefined || !unit) return;
  if (s.course.dose && (s.course.doseAmount !== amount || s.course.doseUnit !== unit)) {
    s.course.unparsed.push(m[0].trim());
    s.course.assumptions.push(kt('dose.assumeTwoDoses', { dose: s.course.dose }));
    return;
  }
  s.course.doseAmount = amount;
  s.course.doseUnit = unit;
  s.course.dose = formatDose(amount, unit);
};

const STRENGTH = String.raw`\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|iu|units?|%)(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:ml|tab(?:let)?|cap(?:sule)?|g|dose|pump|actuation))?`;

/**
 * Applied in order; each consumes the text it matches, so later (looser) rules only see what is
 * left. Rules without `apply` are wording that carries no schedule ("give", "by mouth").
 */
const RULES: Rule[] = [
  // Tapers and changes: only the first step is read, the rest is handed back.
  // (Handled before the rules run; see parseDirections.)

  // As needed.
  { re: /\b(?:as needed|as required|when needed|when required|if needed|p\.?r\.?n\.?)\b(?:\s+for\s+[a-z ]{3,40}?(?=[.,;]|$))?/g, apply: (m, s) => {
    s.course.asNeeded = true;
    const reason = m[0].match(/\bfor\s+(.+)$/);
    if (reason) s.course.notes.push(kt('dose.asNeededFor', { reason: reason[1].trim() }));
  } },

  // Intervals.
  { re: new RegExp(String.raw`\bevery\s+(${NUM})\s*(?:hours?|hrs?|h)\b`, 'g'), apply: (m, s) => {
    const h = parseNumber(m[1]);
    if (h) freq(Number.isInteger(24 / h) ? 24 / h : undefined, h)(m, s);
  } },
  { re: /\bq\.?\s?(\d{1,2})\s?(?:h|hr|hrs|hours?)\b\.?/g, apply: (m, s) => {
    const h = Number(m[1]);
    freq(Number.isInteger(24 / h) ? 24 / h : undefined, h)(m, s);
  } },
  { re: /\b(?:every other day|every second day|on alternate days|alternate days|q\.?o\.?d\.?|eod|q48h)\b/g, apply: freq(1, 48) },
  { re: new RegExp(String.raw`\bevery\s+(${NUM})\s+days\b`, 'g'), apply: (m, s) => {
    const d = parseNumber(m[1]);
    if (d) freq(1, d * 24)(m, s);
  } },
  { re: /\b(?:once|one time)\s+(?:a|per|each|every)\s+week\b|\bonce weekly\b|\bweekly\b|\bevery week\b|\bonce a wk\b/g, apply: freq(1, 168) },
  { re: /\b(?:once|one time)\s+(?:a|per|each|every)\s+month\b|\bmonthly\b|\bevery month\b/g, apply: (m, s) => {
    freq(1, 720)(m, s);
    s.course.assumptions.push(kt('dose.assumeMonthly', { text: m[0].trim() }));
  } },

  // Times per day, in words and abbreviations.
  { re: new RegExp(String.raw`\b(once|twice|thrice|${NUM})(?:\s+times?)?\s+(?:a|per|each|every)\s+day\b|\b(once|twice|thrice|${NUM})(?:\s+times?)?\s+daily\b`, 'g'), apply: (m, s) => {
    const word = (m[1] ?? m[2]).toLowerCase();
    const n = word === 'once' ? 1 : word === 'twice' ? 2 : word === 'thrice' ? 3 : parseNumber(word);
    if (n && Number.isInteger(n)) freq(n)(m, s);
  } },
  { re: /\bb\.?\s?i\.?\s?d\.?(?=\W|$)/g, apply: freq(2) },
  { re: /\bt\.?\s?i\.?\s?d\.?(?=\W|$)/g, apply: freq(3) },
  { re: /\bq\.?\s?i\.?\s?d\.?(?=\W|$)/g, apply: freq(4) },
  { re: /\bs\.?\s?i\.?\s?d\.?(?=\W|$)/g, apply: freq(1) },
  { re: /\bq\.?\s?d\.?(?=\W|$)/g, apply: freq(1) },
  { re: /\bq\.?\s?a\.?\s?m\.?(?=\W|$)/g, apply: tod('morning') },
  { re: /\bq\.?\s?p\.?\s?m\.?(?=\W|$)/g, apply: tod('evening') },
  { re: /\bq\.?\s?h\.?\s?s\.?(?=\W|$)|\bh\.?s\.?(?=\W|$)/g, apply: tod('bedtime') },

  // Times of day.
  { re: /\b(?:in the|every|each)\s+morning\b|\bmornings\b|\bat breakfast\b|\bwith breakfast\b|\ba\.m\.?|\bam\b(?=\s+and\b)/g, apply: tod('morning') },
  { re: /\b(?:at|around)\s+(?:noon|midday|lunch(?:time)?)\b|\bwith lunch\b|\bmidday\b/g, apply: tod('midday') },
  { re: /\b(?:in the|every|each)\s+evening\b|\bevenings\b|\bat dinner(?:time)?\b|\bwith dinner\b|\bwith supper\b|\bp\.m\.?|(?<=and\s)pm\b/g, apply: tod('evening') },
  { re: /\bat bed\s?time\b|\bbefore bed\b|\bat night\b|\bnightly\b|\bevery night\b|\beach night\b/g, apply: tod('bedtime') },
  { re: /\bmorning\b/g, apply: tod('morning') },
  { re: /\bevening\b/g, apply: tod('evening') },

  // Plain "daily" after everything more specific has had its turn.
  { re: /\b(?:daily|every day|each day|per day|a day)\b/g, apply: (m, s) => {
    // "In the morning and evening daily": the times of day already say how often.
    s.frequencies.push({ timesPerDay: undefined, text: m[0].trim() });
  } },

  // Duration.
  { re: new RegExp(String.raw`\b(?:for|x|×)\s*(?:the\s+next\s+|another\s+)?(${NUM})\s*(?:more\s+|additional\s+)?(days?|d|weeks?|wks?|months?|mos?)\b\.?`, 'g'), apply: setDays },
  { re: new RegExp(String.raw`\b(${NUM})[\s-](day|week|month)\s+(?:course|supply)\b`, 'g'), apply: setDays },
  { re: /\buntil (?:all )?(?:gone|finished|done|completed?)\b|\buntil (?:the )?(?:bottle|medication|medicine|supply) is (?:gone|finished|empty)\b|\buntil all (?:are |is |have been )?(?:taken|given|used)\b/g, apply: (_m, s) => (s.course.untilGone = true) },

  // Food.
  { re: /\b(?:with|after) (?:food|a meal|meals|a snack|feeding|a small meal)\b|\bwith or after food\b|\bwith (?:breakfast|dinner|supper)\b/g, apply: (_m, s) => (s.course.withFood = true) },
  { re: /\b(?:on an empty stomach|without food|before (?:food|meals|a meal|eating|feeding)|(?:\d+|one|two) hours? (?:before|after) (?:food|meals|eating|feeding))\b/g, apply: (m, s) => {
    s.course.withFood = false;
    if (/\d|one|two/.test(m[0])) s.course.notes.push(m[0].trim().replace(/^./, (c) => c.toUpperCase()));
  } },

  // Dose. "Give 75 mg" is a dose in mg; a bare "(75 mg)" is the strength.
  { re: new RegExp(String.raw`\b(?:give|take|administer|use|apply|instill|inhale|place|insert|inject)\s+(${NUM})\s*(mg|mcg|milligrams?|micrograms?)\b`, 'g'), apply: setDose(1, 2) },
  { re: new RegExp(String.raw`(?<![\d.\/])(${NUM})\s*(${UNIT_WORDS})(?![a-z])\.?`, 'g'), apply: setDose(1, 2) },
  { re: new RegExp(String.raw`\(?\b(${STRENGTH})\)?`, 'g'), apply: (m, s) => {
    if (!s.course.strength) s.course.strength = m[1].replace(/\s+/g, ' ').trim();
  } },

  // Route.
  { re: /\b(?:in|into|to)\s+(?:the\s+)?(?:each|both|left|right|affected|the)\s+(?:eyes?|ears?|nostrils?)\b|\bto (?:the )?affected (?:area|skin|areas)\b|\btopically\b/g, apply: (m, s) => (s.course.route = m[0].trim()) },
  { re: /\b(?:by mouth|orally|per os|p\.?o\.?(?=\W|$)|by injection|under the skin|subcutaneously|sub-?q|sc)\b/g, apply: (m, s) => (s.course.route = /mouth|oral|os|^p/.test(m[0]) ? 'by mouth' : 'under the skin') },

  // Words that carry nothing for the schedule.
  { re: /\b(?:give|gives|giving|take|takes|administer|use|apply|instill|inhale|place|insert|inject|dose|dosage|directions?|sig|to|your|his|her|their|the|pet|dog|cat|animal|patient|of|and|then|a|an|each|per|please|daily dose|as directed|as instructed|times?|at|in|by|with|starting|start|today|tonight|tomorrow|on|or|for|it|this|medication|medicine|med|meds|doses?)\b/g },
];

const BOILERPLATE = [
  /\brx\s*(?:#|no\.?|number)/i, /^\s*#?\s*\d{5,}\s*$/, /\bqty\b|\bquantity\b/i, /\brefills?\b/i, /\bdate\b|\bfilled\b/i,
  /\bdr\.?\s|\bd\.?v\.?m\.?\b|\bm\.?d\.?\b|\bprescriber\b|\bprescribed by\b/i, /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}|\b\d{3}[-.]\d{4}\b/,
  /\bpharmacy\b|\bclinic\b|\bhospital\b|\bveterinary\b|\banimal (?:care|health|center)\b|\bvet center\b/i,
  /\bkeep out of (?:the )?reach\b|\bfor (?:veterinary|animal) use\b|\bfederal law\b|\bcaution\b|\bdiscard (?:after|by|on)\b|\bexp(?:ires|iry|\.)?\b|\buse by\b|\blot\b|\bndc\b|\bdin\b/i,
  /\d+\s+[a-z]+(?:\s+[a-z]+)?\s+(?:st|street|rd|road|ave|avenue|blvd|lane|ln|dr|drive|way|ct|court|hwy)\b\.?/i,
  /\bowner\b|\bclient\b/i,
];

const ADVICE = [
  /\bshake well\b/i, /\brefrigerate\b|\bkeep (?:in the )?(?:fridge|refrigerated|cold)\b|\bstore (?:in|at|below)\b/i,
  /\bdo not (?:crush|chew|split|break)\b|\bswallow whole\b/i, /\bmay cause\b/i, /\bavoid\b/i, /\bfinish (?:all|the)\b|\bcomplete (?:the )?(?:full )?course\b/i,
  /\bdo not (?:take|give) with\b/i, /\bdrink (?:plenty|a full glass)\b/i, /\bfor external use\b|\bnot for (?:internal|human) use\b/i,
  /\bcontact (?:your|the)\b|\bcall (?:your|the)\b/i,
];

const PATIENT = /^\s*(?:pet|patient|animal|for|name)\s*(?:name)?\s*[:\-]\s*([A-Za-z][A-Za-z' -]{0,40}?)(?:\s*\(.*\))?\s*(?:(?:owner|client|species|dob|age|sex|wt|weight)\b.*)?$/i;
const DIRECTION_START = /^\s*(?:give|take|administer|apply|instill|inhale|place|insert|inject|use|chew|dissolve|mix|squirt|put|directions?|sig)\b/i;
const FORMS = String.raw`(?:chewable tablets?|chew tabs?|tablets?|tabs|capsules?|caps|oral suspension|suspension|oral solution|solution|liquid|syrup|drops|eye drops|ear drops|ointment|cream|gel|chews?|injection|spray|powder|granules|transdermal|patch(?:es)?)`;
const NAME_LINE = new RegExp(String.raw`^\s*([A-Za-z][A-Za-z\-/ ]{2,60}?)\s+(${STRENGTH})(?:\s+(${FORMS}))?(?![a-z])`, 'i');
const SCHEDULE_WORDS = /\b(?:every|daily|times|hours|twice|once|give|take)\b/i;
const NAME_FORM_LINE = new RegExp(String.raw`^\s*([A-Za-z][A-Za-z\-/ ]{2,40}?)\s+(${FORMS})\s*$`, 'i');

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s\-/])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

function emptyCourse(): ParsedCourse {
  return { notes: [], confidence: 0, unparsed: [], assumptions: [], ignored: [] };
}

/**
 * A dose schedule from a label's text or typed directions: "Give 1 tablet by mouth every 12 hours
 * with food for 7 days". Handles once/twice/three/four times daily, every N hours, SID/BID/TID/QID,
 * qNh, QD, QAM/QPM/QHS, every other day, weekly, morning/evening/bedtime, for N days/weeks, until
 * gone, as needed, with food or an empty stomach, and doses in tablets, capsules, ml, drops and
 * more. Anything else is returned in `unparsed`.
 */
export function parseDirections(text: string): ParsedCourse {
  const { course, nameMissing } = parseDirectionsCore(text);
  if (nameMissing) course.assumptions.push(kt('dose.assumeNoName'));
  course.confidence = confidenceOf(course);
  return course;
}

/**
 * `parseDirections` without its last word on the name: `nameMissing` says the text has several
 * lines and none named the medicine, for a caller that looks further (`./medicine-label`) and adds
 * the assumption itself only if it finds none. `confidence` is left to the caller.
 */
export function parseDirectionsCore(text: string): { course: ParsedCourse; nameMissing: boolean } {
  const course = emptyCourse();
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[|_~`]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => /[a-z0-9]/i.test(l));
  const singleLine = lines.length <= 1;

  const directionLines: string[] = [];
  const otherLines: string[] = [];
  let previousWasDirections = false;
  for (const line of lines) {
    const wasDirections = previousWasDirections;
    previousWasDirections = false;
    const patient = line.match(PATIENT);
    if (patient && !singleLine) {
      course.patient = titleCase(patient[1]);
      continue;
    }
    if (!singleLine && !DIRECTION_START.test(line) && BOILERPLATE.some((re) => re.test(line))) {
      course.ignored.push(line);
      continue;
    }
    if (ADVICE.some((re) => re.test(line)) && !DIRECTION_START.test(line) && !looksLikeDirections(line.replace(ADVICE_FREE, ''))) {
      course.notes.push(line.replace(/\.$/, ''));
      continue;
    }
    if (!course.name && !DIRECTION_START.test(line)) {
      const withStrength = line.match(NAME_LINE);
      const named = withStrength ?? line.match(NAME_FORM_LINE);
      if (named && !SCHEDULE_WORDS.test(named[1])) {
        let name = named[1];
        const trailingForm = name.match(new RegExp(String.raw`\s+(${FORMS})$`, 'i'));
        if (trailingForm) {
          name = name.slice(0, -trailingForm[0].length);
          course.form = trailingForm[1].toLowerCase();
        }
        course.name = titleCase(name);
        if (withStrength) {
          course.strength = named[2].replace(/\s+/g, ' ').trim().toLowerCase();
          if (named[3]) course.form = named[3].toLowerCase();
        } else course.form = named[2].toLowerCase();
        const rest = line.slice(named[0].length).replace(/^[\s:,.;-]+/, '').trim();
        if (rest) (looksLikeDirections(rest) || DIRECTION_START.test(rest) ? directionLines : otherLines).push(rest);
        continue;
      }
    }
    // A wrapped line continues the directions when the line before them didn't end a sentence.
    const continues = wasDirections && !/[.!]$/.test(directionLines[directionLines.length - 1] ?? '.');
    if (singleLine || continues || DIRECTION_START.test(line) || looksLikeDirections(line)) {
      directionLines.push(line);
      previousWasDirections = true;
      continue;
    }
    otherLines.push(line);
  }

  const sig = directionLines.join(' ');
  if (sig) parseSig(sig, course);
  course.unparsed.push(...otherLines);
  return { course, nameMissing: !course.name && !singleLine };
}

/** Whether a label line carries schedule wording, so a wrapped line joins the directions. */
function looksLikeDirections(line: string): boolean {
  const lower = line.toLowerCase();
  // Only rules that set something count; filler words alone don't make a direction line.
  return RULES.some((r) => r.apply && new RegExp(r.re.source, r.re.flags.replace('g', '')).test(lower));
}

function parseSig(sig: string, course: ParsedCourse): void {
  let text = sig.toLowerCase();
  if (text.length !== sig.length) text = sig; // unusual Unicode: keep positions aligned
  // A taper or change ("... for 5 days, then once daily for 5 days") is several courses; read the
  // first and hand back the rest rather than merging them.
  const then = text.search(/(?:[.,;]\s*|\s)then\b|\bfollowed by\b|\bthereafter\b|\bafter that\b/);
  let rest = '';
  if (then > 0) {
    rest = sig.slice(then).replace(/^[.,;\s]+/, '').trim();
    text = text.slice(0, then);
    course.assumptions.push(kt('dose.assumeTaper'));
  }

  // 0: not understood, 1: filler wording, 2: understood.
  const kind = new Array<number>(text.length).fill(0);
  // Advice sentences inside the directions ("... with food. Shake well.") become notes.
  const sentence = /[^.;!]+(?:[.;!](?!\d)|$)/g;
  for (let m: RegExpExecArray | null; (m = sentence.exec(text)); ) {
    if (m[0].length === 0) {
      sentence.lastIndex++;
      continue;
    }
    if (ADVICE.some((re) => re.test(m![0])) && !looksLikeDirections(m[0].replace(ADVICE_FREE, ''))) {
      course.notes.push(sig.slice(m.index, m.index + m[0].length).trim().replace(/[.;!]$/, ''));
      kind.fill(2, m.index, m.index + m[0].length);
    }
  }

  const state: State = { course, frequencies: [] };
  for (const rule of RULES) {
    const masked = [...text].map((c, i) => (kind[i] ? '\u0000' : c)).join('');
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(masked))) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      if (m[0].includes('\u0000')) continue;
      kind.fill(rule.apply ? 2 : 1, m.index, m.index + m[0].length);
      rule.apply?.(m, state);
    }
  }
  resolveFrequency(state);

  // What no rule understood, as the original wording: each stretch between understood parts,
  // trimmed to its first and last word that wasn't filler.
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && kind[i] !== 2) continue;
    let first = -1;
    let last = -1;
    for (let j = start; j < i; j++) {
      if (kind[j] === 0 && /[a-z0-9]/i.test(text[j])) {
        if (first < 0) first = j;
        last = j;
      }
    }
    if (first >= 0) {
      while (first > start && /[\w/]/.test(text[first - 1]) && kind[first - 1] === 0) first--;
      while (last + 1 < i && /[\w/]/.test(text[last + 1])) last++;
      course.unparsed.push(sig.slice(first, last + 1).trim());
    }
    start = i + 1;
  }
  if (rest) course.unparsed.push(rest);
}

/** Schedule wording that can sit inside an advice sentence without making it a direction. */
const ADVICE_FREE = /\b(?:with food|with meals|doses?|medication)\b/g;

function resolveFrequency({ course, frequencies }: State): void {
  const timed = frequencies.filter((f) => f.timesPerDay !== undefined || f.intervalHours !== undefined);
  const todCount = course.timesOfDay?.length;
  if (timed.length === 0) {
    if (todCount) course.timesPerDay = todCount;
    else if (frequencies.length) course.timesPerDay = 1; // a bare "daily"
    return;
  }
  const [first, ...others] = timed;
  course.timesPerDay = first.timesPerDay;
  if (first.intervalHours) course.intervalHours = first.intervalHours;
  for (const f of others) {
    const agrees = (f.timesPerDay === undefined || f.timesPerDay === course.timesPerDay)
      && (f.intervalHours === undefined || course.intervalHours === undefined || f.intervalHours === course.intervalHours);
    if (agrees) {
      course.intervalHours ??= f.intervalHours;
      course.timesPerDay ??= f.timesPerDay;
    } else {
      course.unparsed.push(f.text);
      course.assumptions.push(kt('dose.assumeDisagree', { first: first.text, other: f.text }));
    }
  }
  if (todCount && course.timesPerDay !== undefined && course.intervalHours === undefined && todCount !== course.timesPerDay) {
    course.assumptions.push(
      kt('dose.assumeTimesOfDay', { times: course.timesPerDay, count: todCount, names: course.timesOfDay!.map((time) => kt('dose.timeOfDay', { time })).join(', ') }),
    );
  }
}

/**
 * How much of a usable course was found, 0..1: a schedule (0.4), a dose (0.2), a length or "until
 * gone" (0.15), a name (0.15), and with any of those, nothing left unparsed (0.1); each assumption costs 0.1.
 */
export function confidenceOf(c: ParsedCourse): number {
  let score = 0;
  if (c.timesPerDay || c.intervalHours || c.asNeeded) score += 0.4;
  if (c.dose) score += 0.2;
  if (c.days || c.untilGone || c.asNeeded) score += 0.15;
  if (c.name) score += 0.15;
  if (c.unparsed.length === 0 && score > 0) score += 0.1;
  score -= 0.1 * c.assumptions.length;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

// ---------------------------------------------------------------------------------------------
// Schedules

/** Clock times ("HH:MM", local) the household uses for each part of the day. */
export interface DayTimes {
  morning: string;
  midday: string;
  evening: string;
  bedtime: string;
}

export const DEFAULT_DAY_TIMES: DayTimes = { morning: '08:00', midday: '13:00', evening: '20:00', bedtime: '22:00' };

export interface DoseTimesOptions {
  defaultTimes?: Partial<DayTimes>;
  /** First dose of the day for interval schedules. Default: the morning time. */
  firstDose?: string;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};
const toHhmm = (minutes: number) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * The clock times of each dosing day: the named times of day if the label gives them, evenly
 * spaced from the first dose for an interval, otherwise spread from morning to evening
 * (twice daily: 08:00 and 20:00; three times: 08:00, 14:00, 20:00). As needed: none.
 */
export function doseTimes(
  course: Pick<ParsedCourse, 'timesPerDay' | 'intervalHours' | 'timesOfDay' | 'asNeeded'>,
  options: DoseTimesOptions = {},
): string[] {
  const day = { ...DEFAULT_DAY_TIMES, ...options.defaultTimes };
  if (course.asNeeded && !course.timesPerDay && !course.intervalHours) return [];
  if (course.timesOfDay?.length && (!course.timesPerDay || course.timesPerDay === course.timesOfDay.length) && !(course.intervalHours && course.intervalHours < 24)) {
    return sortTimes(course.timesOfDay.map((t) => day[t]));
  }
  const first = toMinutes(options.firstDose ?? day.morning);
  if (course.intervalHours && course.intervalHours < 24) {
    // At most 24 doses a day: a mis-read interval ("every .0000001 hours") must not allocate millions.
    const count = Math.min(24, Math.max(1, Math.floor(24 / course.intervalHours)));
    return sortTimes(Array.from({ length: count }, (_, i) => toHhmm(first + i * course.intervalHours! * 60)));
  }
  const n = course.intervalHours && course.intervalHours >= 24 ? 1 : course.timesPerDay ?? 0;
  if (n <= 0) return [];
  if (n === 1) return [toHhmm(first)];
  const last = Math.max(toMinutes(day.evening), first + 60);
  const step = (last - first) / (n - 1);
  return sortTimes(Array.from({ length: n }, (_, i) => toHhmm(Math.round((first + i * step) / 15) * 15)));
}

const sortTimes = (times: string[]) => [...new Set(times)].sort();

/** "YYYY-MM-DD" in local time. */
export function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseYmd(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The dosing dates of a course: `days` days from `start`, every `everyDays` days (2 = every other day). */
export function courseDays(start: string, days: number, everyDays = 1): string[] {
  const first = parseYmd(start);
  const out: string[] = [];
  for (let i = 0; i < days; i += Math.max(1, everyDays)) {
    out.push(ymd(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)));
  }
  return out;
}

/** The course model apps store (Huishouden Pet's medicine courses). */
export interface MedCourse {
  name: string;
  dose: string;
  timesPerDay: number;
  /** "HH:MM" local, sorted. */
  times: string[];
  /** "YYYY-MM-DD". */
  startDate: string;
  /** Length in days; absent for ongoing or until-gone courses. */
  days?: number;
  withFood?: boolean;
  notes: string;
}

/**
 * A parsed label as the course an app stores, ready for the person to check: the name includes
 * the strength, the times come from `doseTimes`, and everything the course fields can't hold
 * (interval, until gone, as needed, route, the label's advice) goes into `notes`.
 */
export function toMedCourse(parsed: ParsedCourse, options: DoseTimesOptions & { startDate: string }): MedCourse {
  const times = doseTimes(parsed, options);
  const notes: string[] = [];
  if (parsed.intervalHours === 48) notes.push(kt('dose.everyOtherDay'));
  else if (parsed.intervalHours && parsed.intervalHours >= 24) notes.push(kt('dose.everyDays', { n: parsed.intervalHours / 24 }));
  else if (parsed.intervalHours) notes.push(kt('dose.everyHours', { n: parsed.intervalHours }));
  const asNeeded = kt('dose.asNeeded').toLowerCase();
  if (parsed.asNeeded && !parsed.notes.some((n) => /^as needed/i.test(n) || n.toLowerCase().startsWith(asNeeded))) notes.push(kt('dose.asNeeded'));
  if (parsed.untilGone) notes.push(kt('dose.untilGone'));
  // The parser's own routes in the active language; a label's own wording as it was.
  if (parsed.route && parsed.route !== 'by mouth') notes.push(routeWords(parsed.route));
  notes.push(...parsed.notes);
  return {
    name: [parsed.name, parsed.strength].filter(Boolean).join(' '),
    dose: parsed.dose ?? '',
    timesPerDay: parsed.timesPerDay ?? times.length,
    times,
    startDate: options.startDate,
    ...(parsed.days ? { days: parsed.days } : {}),
    ...(parsed.withFood !== undefined ? { withFood: parsed.withFood } : {}),
    notes: notes.join('. '),
  };
}

// ---------------------------------------------------------------------------------------------
// Due and missed doses

export interface DoseSlot {
  /** "YYYY-MM-DD" local. */
  date: string;
  /** "HH:MM" local. */
  time: string;
  /** ms since epoch. */
  at: number;
  /** Stable id of this dose, "YYYY-MM-DDTHH:MM", for recording it as given. */
  key: string;
}

export interface ScheduleCourse {
  startDate: string;
  days?: number;
  times: string[];
  /** Days between dosing days: 2 for every other day. Default 1. */
  everyDays?: number;
  /**
   * Dosing days on a calendar pattern instead (`./schedule` `EventRule`: Mondays and Thursdays, the
   * 1st of each month); `everyDays` is then ignored. Days before `startDate` never count.
   */
  rule?: EventRule;
  /** "YYYY-MM-DD", the last dosing day (a medicine stopped or prescribed until a date). */
  until?: string;
}

/**
 * Every dose of a course between `from` and `to` (ms, inclusive), in order. Ongoing courses (no
 * `days` or `until`) run until `to`.
 */
export function doseSlots(course: ScheduleCourse, from: number, to: number): DoseSlot[] {
  const start = parseYmd(course.startDate);
  const every = course.rule ? 1 : Math.max(1, course.everyDays ?? 1);
  const lastDay = course.days !== undefined ? course.days : Math.ceil((to - start.getTime()) / 86_400_000) + 1;
  const out: DoseSlot[] = [];
  const firstIndex = Math.max(0, Math.floor((from - start.getTime()) / 86_400_000) - 1);
  for (let i = firstIndex - (firstIndex % every); i < lastDay; i += every) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (day.getTime() > to) break;
    const date = ymd(day);
    if (course.until && date > course.until) break;
    if (course.rule && !fitsRule(course.rule, date)) continue;
    for (const time of course.times) {
      const [h, m] = time.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
      if (at >= from && at <= to) out.push({ date, time, at, key: `${date}T${time}` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export type DoseState = 'given' | 'due' | 'missed' | 'upcoming';

export interface DoseWindow {
  /** A dose is due from this many minutes before its time. Default 30. */
  earlyMinutes?: number;
  /** ...until this many minutes after; later it is missed. Default 120. */
  graceMinutes?: number;
}

/** Whether one dose has been given, is due now, was missed, or is still ahead. */
export function doseState(slot: DoseSlot, given: ReadonlySet<string> | readonly string[], now: number, window: DoseWindow = {}): DoseState {
  const has = Array.isArray(given) ? given.includes(slot.key) : (given as ReadonlySet<string>).has(slot.key);
  if (has) return 'given';
  if (now < slot.at - (window.earlyMinutes ?? 30) * 60_000) return 'upcoming';
  if (now <= slot.at + (window.graceMinutes ?? 120) * 60_000) return 'due';
  return 'missed';
}

export interface DoseSummary {
  due: DoseSlot[];
  missed: DoseSlot[];
  next?: DoseSlot;
}

/**
 * The doses due now, those missed since `since` (default: the course start), and the next one,
 * given the keys of doses already recorded as given.
 */
export function doseSummary(course: ScheduleCourse, given: readonly string[], now: number, options: DoseWindow & { since?: number } = {}): DoseSummary {
  const since = options.since ?? parseYmd(course.startDate).getTime();
  const set = new Set(given);
  const slots = doseSlots(course, since, now + 8 * 86_400_000);
  const summary: DoseSummary = { due: [], missed: [] };
  for (const slot of slots) {
    const state = doseState(slot, set, now, options);
    if (state === 'due') summary.due.push(slot);
    else if (state === 'missed') summary.missed.push(slot);
    else if (state === 'upcoming' && !summary.next) summary.next = slot;
  }
  return summary;
}

/** Days between dosing days for a parsed interval (48 h → 2), for `ScheduleCourse.everyDays`. */
export function everyDaysOf(course: Pick<ParsedCourse, 'intervalHours'>): number {
  return course.intervalHours && course.intervalHours >= 24 ? Math.round(course.intervalHours / 24) : 1;
}

// ---------------------------------------------------------------------------------------------
// Doses recorded: given or skipped, adherence, and the guards against giving twice

/** A dose someone recorded: given, or skipped on purpose. `slot` is the `DoseSlot.key` it answers (none for as-needed). */
export interface DoseLog {
  at: number;
  slot?: string;
  status: 'given' | 'skipped';
  by?: string;
}

/** The slot keys that have been answered, given or skipped: nothing more is due for them. */
export function handledKeys(logs: readonly DoseLog[]): Set<string> {
  return new Set(logs.flatMap((l) => (l.slot ? [l.slot] : [])));
}

export type SlotState = 'given' | 'skipped' | 'due' | 'missed' | 'upcoming';

export interface SlotStatus<L extends DoseLog = DoseLog> {
  slot: DoseSlot;
  state: SlotState;
  /** The log that answered it (the given one if a slot was logged both ways). */
  log?: L;
}

/** Each slot of a course between `from` and `to` with what happened to it, in order. */
export function slotStatuses<L extends DoseLog>(course: ScheduleCourse, logs: readonly L[], from: number, to: number, now: number, window: DoseWindow = {}): SlotStatus<L>[] {
  const bySlot = new Map<string, L>();
  for (const l of logs) {
    if (!l.slot) continue;
    const had = bySlot.get(l.slot);
    if (!had || (had.status === 'skipped' && l.status === 'given') || (had.status === l.status && l.at > had.at)) bySlot.set(l.slot, l);
  }
  return doseSlots(course, from, to).map((slot) => {
    const log = bySlot.get(slot.key);
    if (log) return { slot, state: log.status, log };
    const state = doseState(slot, [], now, window);
    return { slot, state: state === 'given' ? 'due' : state };
  });
}

export interface Adherence {
  given: number;
  skipped: number;
  missed: number;
  /** Doses of the period nobody has answered yet that are still due. */
  due: number;
  /** Given out of given and missed (skipped on purpose doesn't count against it); null with nothing to count. */
  rate: number | null;
}

/** How a scheduled course went between `from` and `to` (capped at now): given, skipped and missed doses. */
export function adherence(course: ScheduleCourse, logs: readonly DoseLog[], from: number, to: number, now: number, window: DoseWindow = {}): Adherence {
  const out: Adherence = { given: 0, skipped: 0, missed: 0, due: 0, rate: null };
  for (const s of slotStatuses(course, logs, from, Math.min(to, now), now, window)) {
    if (s.state === 'given') out.given++;
    else if (s.state === 'skipped') out.skipped++;
    else if (s.state === 'missed') out.missed++;
    else if (s.state === 'due') out.due++;
  }
  out.rate = out.given + out.missed > 0 ? out.given / (out.given + out.missed) : null;
  return out;
}

/**
 * How close two doses of a scheduled medicine may be before a second one looks like a double dose:
 * half the shortest gap between its dose times (across midnight too), at least an hour and at most
 * 12 hours. Once a day: 12 hours.
 */
export function doubleDoseWindowMs(times: readonly string[]): number {
  const minutes = [...new Set(times)].map(toMinutes).sort((a, b) => a - b);
  if (minutes.length < 2) return 12 * 3_600_000;
  const gaps = minutes.map((m, i) => (i === minutes.length - 1 ? minutes[0] + 1440 - m : minutes[i + 1] - m));
  const half = (Math.min(...gaps) / 2) * 60_000;
  return Math.min(12 * 3_600_000, Math.max(3_600_000, half));
}

/** The latest dose given within `withinMs` before `now` (or after it, for a time typed ahead), if any. */
export function recentlyGiven<L extends DoseLog>(logs: readonly L[], now: number, withinMs: number): L | undefined {
  return logs.filter((l) => l.status === 'given' && Math.abs(now - l.at) < withinMs).sort((a, b) => b.at - a.at)[0];
}

export interface AsNeededLimits {
  /** Hours to wait between doses. */
  minHours?: number;
  /** Doses allowed in any 24 hours. */
  maxPerDay?: number;
}

export interface AsNeededCheck {
  /** Whether a dose now keeps within the limits. */
  ok: boolean;
  /** `too-soon`: less than `minHours` since the last; `max-reached`: `maxPerDay` given in the last 24 hours. */
  reason?: 'too-soon' | 'max-reached';
  /** The last dose given before now. */
  last?: number;
  /** Doses given in the 24 hours before now. */
  inLastDay: number;
  /** The earliest moment a dose keeps within both limits (now when `ok`). */
  nextAt: number;
}

/**
 * Whether an as-needed medicine ("every 4 to 6 hours as needed, no more than 4 in 24 hours") may be
 * given at `now`, from the doses given. Advice for the person giving it, never a block: the app
 * says why and lets them go ahead.
 */
export function asNeededCheck(logs: readonly DoseLog[], now: number, { minHours, maxPerDay }: AsNeededLimits): AsNeededCheck {
  const given = logs.filter((l) => l.status === 'given' && l.at <= now).map((l) => l.at).sort((a, b) => b - a);
  const last = given[0];
  const window = given.filter((at) => at > now - 86_400_000);
  let nextAt = now;
  let reason: AsNeededCheck['reason'];
  if (maxPerDay && window.length >= maxPerDay) {
    // The dose that has to fall out of the 24 hours before another fits.
    nextAt = Math.max(nextAt, window[maxPerDay - 1] + 86_400_000);
    reason = 'max-reached';
  }
  if (minHours && last !== undefined && now - last < minHours * 3_600_000) {
    nextAt = Math.max(nextAt, last + minHours * 3_600_000);
    reason ??= 'too-soon';
  }
  return { ok: !reason, ...(reason ? { reason } : {}), ...(last !== undefined ? { last } : {}), inLastDay: window.length, nextAt };
}
