import { compareText, kt } from './i18n.js';
import { formatYmd, monthYear, ymdParts } from './time.js';

/**
 * Health conditions (huishouden/health): what a person has been diagnosed with, under
 * `households/{id}/healthPeople/{personId}/conditions/{conditionId}`, organised by medical area
 * (`SPECIALTIES`): asthma sits under Pulmonology, type 2 diabetes under Endocrinology.
 * Server-safe: Health and the household tools (the assistant connector, `hh data`) read and write
 * conditions with the same code.
 *
 * Who may read them is narrower than for medicines and visits (huishouden/rules,
 * `conditionReader`): the household's admins and the members among the person's readers (their
 * member carers, and the person themself when a member). Helper carers, who give doses and take
 * someone to a visit, never read a condition, not even its name; a visit tagged with one carries
 * only its id. Nothing about a condition is published to the
 * portal, the calendars, reminders or to-dos.
 *
 * Finding one: `searchConditions` asks the U.S. National Library of Medicine's free Clinical Tables
 * service (no key) for consumer names and ICD-10-CM codes, sending only the words typed. The code's
 * medical area comes from `specialtyForIcd10` (the table `ICD10_SPECIALTIES`), which a person may
 * always override per condition; free text, without a code, is always allowed.
 */

export const CONDITIONS = 'conditions';

/** Medical areas, in the order a picker lists them; `primary` (primary care or other) last. */
export const SPECIALTIES = [
  'allergy',
  'cardiology',
  'dermatology',
  'endocrinology',
  'ent',
  'gastroenterology',
  'hemOnc',
  'infectious',
  'mentalHealth',
  'nephrology',
  'neurology',
  'obgyn',
  'ophthalmology',
  'orthopedics',
  'pulmonology',
  'rheumatology',
  'urology',
  'primary',
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

export const CONDITION_STATUSES = ['active', 'managed', 'resolved'] as const;
export type ConditionStatus = (typeof CONDITION_STATUSES)[number];

export const CONDITION_SEVERITIES = ['mild', 'moderate', 'severe'] as const;
export type ConditionSeverity = (typeof CONDITION_SEVERITIES)[number];

/**
 * A date as precise as it is known: "2019", "2019-03" or "2019-03-14" (diagnosed "in 2019",
 * "March 2019", or on the day).
 */
export type PartialDate = string;

/** healthPeople/{personId}/conditions/{conditionId}. */
export interface ConditionData {
  /** The path's person, repeated (the rules check it). */
  personId: string;
  /** "Asthma", "Type 2 diabetes". */
  name: string;
  /** The ICD-10-CM code the lookup found ("E11.9"); none for free text. */
  icd10?: string;
  /** The medical area it is filed under; the code's by default (`specialtyForIcd10`), changeable. */
  specialty: Specialty;
  status: ConditionStatus;
  /** When it was diagnosed: a year, a month or a day. */
  diagnosed?: PartialDate;
  /** When it resolved, for a resolved condition. */
  resolved?: PartialDate;
  severity?: ConditionSeverity;
  /** Who diagnosed it: a household contact (`./contacts`), usually a doctor. */
  doctorId?: string;
  /** Where: a household contact (the clinic or hospital)... */
  clinicId?: string;
  /** ...or a place in words, when it isn't a contact. */
  place?: string;
  /** The person's medicines that treat it (`healthPeople/{personId}/meds` ids). */
  medIds?: string[];
  notes?: string;
  createdAt: number;
  updatedAt?: number;
  by: string;
  /** Written by the person's assistant (huishouden/connector). */
  via?: 'assistant';
}
export interface Condition extends ConditionData {
  id: string;
}

export const CONDITION_FIELDS = [
  'personId', 'name', 'icd10', 'specialty', 'status', 'diagnosed', 'resolved', 'severity', 'doctorId', 'clinicId', 'place', 'medIds', 'notes',
  'createdAt', 'updatedAt', 'by', 'via',
] as const;

export const CONDITION_LIMITS = { name: 120, icd10: 10, place: 200, notes: 1000, medIds: 20, id: 128 } as const;

// ---- Reading and writing ----

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
const clip = (s: string | undefined, max: number) => (s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const one = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

export const isSpecialty = (v: unknown): v is Specialty => one(SPECIALTIES, v);
export const isConditionStatus = (v: unknown): v is ConditionStatus => one(CONDITION_STATUSES, v);
export const isConditionSeverity = (v: unknown): v is ConditionSeverity => one(CONDITION_SEVERITIES, v);

const PARTIAL_DATE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;

/** "2019", "2019-03" or a real day "2019-03-14". */
export function isPartialDate(v: unknown): v is PartialDate {
  if (typeof v !== 'string') return false;
  const m = PARTIAL_DATE.exec(v);
  if (!m) return false;
  return m[3] === undefined || ymdParts(v) !== null;
}

/** An ICD-10-CM code as stored: a letter, two characters, optionally a dot and up to four more ("M54.12", "E11.9", "C50"). */
export function cleanIcd10(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]\d[0-9A-Z])(?:\.?([0-9A-Z]{1,4}))?$/.exec(s);
  return m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : undefined;
}

function cleanIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const ids = list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= CONDITION_LIMITS.id);
  return [...new Set(ids)].slice(0, CONDITION_LIMITS.medIds);
}

/** A stored condition, read defensively. */
export function toCondition(id: string, d: Record<string, unknown>, personId?: string): Condition {
  const icd10 = cleanIcd10(d.icd10);
  const medIds = cleanIds(d.medIds);
  return {
    id,
    personId: personId ?? String(d.personId ?? ''),
    name: String(d.name ?? ''),
    ...(icd10 ? { icd10 } : {}),
    specialty: isSpecialty(d.specialty) ? d.specialty : 'primary',
    status: isConditionStatus(d.status) ? d.status : 'active',
    ...(isPartialDate(d.diagnosed) ? { diagnosed: d.diagnosed } : {}),
    ...(isPartialDate(d.resolved) ? { resolved: d.resolved } : {}),
    ...(isConditionSeverity(d.severity) ? { severity: d.severity } : {}),
    ...(str(d.doctorId) ? { doctorId: str(d.doctorId) } : {}),
    ...(str(d.clinicId) ? { clinicId: str(d.clinicId) } : {}),
    ...(str(d.place) ? { place: str(d.place) } : {}),
    ...(medIds.length ? { medIds } : {}),
    ...(str(d.notes) ? { notes: str(d.notes) } : {}),
    createdAt: int(d.createdAt) ?? 0,
    ...(int(d.updatedAt) ? { updatedAt: int(d.updatedAt) } : {}),
    by: String(d.by ?? ''),
    ...(d.via === 'assistant' ? { via: 'assistant' as const } : {}),
  };
}

export type ConditionInput = Omit<ConditionData, 'createdAt' | 'updatedAt' | 'by' | 'via' | 'specialty' | 'status'> & {
  /** Left out: the code's area (`specialtyForIcd10`), else the name's (`guessSpecialty`). */
  specialty?: Specialty;
  /** Default resolved with a `resolved` date, else active. */
  status?: ConditionStatus;
};

/**
 * The stored document, exactly as the rules accept it: trimmed, clipped, no undefined fields. A
 * resolved date is kept only on a resolved condition (one with no status is resolved); a place in
 * words only without a clinic (`conditionConflicts` says what would be dropped).
 * `stamp` is `createdAt`, `by` and, on a change, `updatedAt` (`./store` `stampFor`); `via` the
 * assistant's mark.
 */
export function conditionDoc(input: ConditionInput, stamp: { createdAt: number; by: string; updatedAt?: number }, via?: 'assistant'): ConditionData {
  const name = clip(input.name, CONDITION_LIMITS.name);
  const icd10 = cleanIcd10(input.icd10);
  // A resolved date with no status says it is over.
  const status = isConditionStatus(input.status) ? input.status : isPartialDate(input.resolved) ? 'resolved' : 'active';
  const specialty = isSpecialty(input.specialty) ? input.specialty : defaultSpecialty({ name, icd10 });
  const id = (s: string | undefined) => clip(s, CONDITION_LIMITS.id) || undefined;
  const clinicId = id(input.clinicId);
  const place = clinicId ? '' : clip(input.place, CONDITION_LIMITS.place);
  const notes = (input.notes ?? '').trim().slice(0, CONDITION_LIMITS.notes);
  const medIds = cleanIds(input.medIds);
  return {
    personId: input.personId,
    name,
    ...(icd10 ? { icd10 } : {}),
    specialty,
    status,
    ...(isPartialDate(input.diagnosed) ? { diagnosed: input.diagnosed } : {}),
    ...(status === 'resolved' && isPartialDate(input.resolved) ? { resolved: input.resolved } : {}),
    ...(isConditionSeverity(input.severity) ? { severity: input.severity } : {}),
    ...(id(input.doctorId) ? { doctorId: id(input.doctorId) } : {}),
    ...(clinicId ? { clinicId } : {}),
    ...(place ? { place } : {}),
    ...(medIds.length ? { medIds } : {}),
    ...(notes ? { notes } : {}),
    createdAt: stamp.createdAt,
    ...(stamp.updatedAt !== undefined ? { updatedAt: stamp.updatedAt } : {}),
    by: stamp.by,
    ...(via ? { via } : {}),
  };
}

/** What `conditionDoc` would drop from `input`: a place in words beside a clinic, a resolved date on a condition that isn't resolved. */
export function conditionConflicts(input: Pick<ConditionInput, 'clinicId' | 'place' | 'status' | 'resolved'>): ('place' | 'resolved')[] {
  const out: ('place' | 'resolved')[] = [];
  if (input.clinicId?.trim() && input.place?.trim()) out.push('place');
  if (input.resolved && input.status && input.status !== 'resolved') out.push('resolved');
  return out;
}

// ---- Medical areas from ICD-10-CM ----

/**
 * One line of the ICD-10-CM to medical-area table. `codes` is a category range ("M05-M14": every
 * code whose first three characters fall in it) or a code prefix ("M54.1": that code and the ones
 * under it). The first line that matches wins, so exceptions come before their block and blocks
 * before their chapter.
 */
export interface Icd10Specialty {
  codes: string;
  specialty: Specialty;
  /** What the codes are, for the documentation and the tests. */
  what: string;
}

/**
 * ICD-10-CM codes to the medical area that usually treats them. Mostly the chapter (G: nervous
 * system, Neurology), with the exceptions where another area is the usual one: radiculopathies and
 * sciatica are filed in chapter M (musculoskeletal) but seen by neurology; strokes are circulatory
 * (I) but neurological; inflammatory arthritis and lupus are rheumatology rather than orthopedics;
 * kidney failure is nephrology rather than urology. Every condition's area can be changed by hand.
 */
export const ICD10_SPECIALTIES: readonly Icd10Specialty[] = [
  // Exceptions, before their chapter.
  { codes: 'M54.1', specialty: 'neurology', what: 'Radiculopathy (cervical, thoracic, lumbar)' },
  { codes: 'M54.3', specialty: 'neurology', what: 'Sciatica' },
  { codes: 'M54.4', specialty: 'neurology', what: 'Lumbago with sciatica' },
  { codes: 'M50.0', specialty: 'neurology', what: 'Cervical disc disorder with myelopathy' },
  { codes: 'M50.1', specialty: 'neurology', what: 'Cervical disc disorder with radiculopathy' },
  { codes: 'M51.0', specialty: 'neurology', what: 'Thoracic and lumbar disc disorders with myelopathy' },
  { codes: 'M51.1', specialty: 'neurology', what: 'Thoracic and lumbar disc disorders with radiculopathy' },
  { codes: 'M47.1', specialty: 'neurology', what: 'Spondylosis with myelopathy' },
  { codes: 'M47.2', specialty: 'neurology', what: 'Spondylosis with radiculopathy' },
  { codes: 'M79.2', specialty: 'neurology', what: 'Neuralgia and neuritis' },
  { codes: 'M79.7', specialty: 'rheumatology', what: 'Fibromyalgia' },
  { codes: 'M05-M14', specialty: 'rheumatology', what: 'Inflammatory arthritis: rheumatoid, psoriatic, gout' },
  { codes: 'M30-M36', specialty: 'rheumatology', what: 'Systemic connective tissue disorders: lupus, vasculitis, Sjogren' },
  { codes: 'M45-M46', specialty: 'rheumatology', what: 'Ankylosing spondylitis and other inflammatory spondylopathies' },
  { codes: 'M80-M81', specialty: 'endocrinology', what: 'Osteoporosis' },
  { codes: 'I60-I69', specialty: 'neurology', what: 'Stroke and other cerebrovascular diseases' },
  { codes: 'G47.3', specialty: 'pulmonology', what: 'Sleep apnea' },
  { codes: 'J30', specialty: 'allergy', what: 'Allergic rhinitis (hay fever)' },
  { codes: 'J00-J06', specialty: 'ent', what: 'Upper respiratory infections: colds, sinusitis, tonsillitis' },
  { codes: 'J31-J39', specialty: 'ent', what: 'Other diseases of the nose, sinuses, throat and larynx' },
  { codes: 'L20', specialty: 'allergy', what: 'Atopic dermatitis (eczema)' },
  { codes: 'L50', specialty: 'allergy', what: 'Urticaria (hives)' },
  { codes: 'K00-K14', specialty: 'primary', what: 'Mouth, teeth and jaw (the dentist)' },
  { codes: 'D80-D89', specialty: 'allergy', what: 'Immune deficiencies and other immune disorders' },
  { codes: 'T78', specialty: 'allergy', what: 'Allergic reactions, anaphylaxis, angioedema' },
  { codes: 'Z88', specialty: 'allergy', what: 'Allergy to medicines' },
  { codes: 'Z91.0', specialty: 'allergy', what: 'Food, insect and other allergies' },
  { codes: 'N00-N19', specialty: 'nephrology', what: 'Kidney disease and kidney failure' },
  { codes: 'N25-N29', specialty: 'nephrology', what: 'Other kidney disorders' },
  { codes: 'N60-N65', specialty: 'obgyn', what: 'Breast disorders' },
  { codes: 'N70-N98', specialty: 'obgyn', what: 'Female pelvic and genital disorders' },
  { codes: 'R56', specialty: 'neurology', what: 'Convulsions and seizures, unspecified' },
  { codes: 'R51', specialty: 'neurology', what: 'Headache' },
  // Chapters.
  { codes: 'A00-B99', specialty: 'infectious', what: 'Certain infectious and parasitic diseases' },
  { codes: 'C00-D49', specialty: 'hemOnc', what: 'Neoplasms' },
  { codes: 'D50-D89', specialty: 'hemOnc', what: 'Diseases of the blood' },
  { codes: 'E00-E89', specialty: 'endocrinology', what: 'Endocrine, nutritional and metabolic diseases' },
  { codes: 'F01-F99', specialty: 'mentalHealth', what: 'Mental, behavioral and neurodevelopmental disorders' },
  { codes: 'G00-G99', specialty: 'neurology', what: 'Diseases of the nervous system' },
  { codes: 'H00-H59', specialty: 'ophthalmology', what: 'Diseases of the eye' },
  { codes: 'H60-H95', specialty: 'ent', what: 'Diseases of the ear' },
  { codes: 'I00-I99', specialty: 'cardiology', what: 'Diseases of the circulatory system' },
  { codes: 'J00-J99', specialty: 'pulmonology', what: 'Diseases of the respiratory system' },
  { codes: 'K00-K95', specialty: 'gastroenterology', what: 'Diseases of the digestive system' },
  { codes: 'L00-L99', specialty: 'dermatology', what: 'Diseases of the skin' },
  { codes: 'M00-M99', specialty: 'orthopedics', what: 'Diseases of the musculoskeletal system' },
  { codes: 'N00-N99', specialty: 'urology', what: 'Diseases of the genitourinary system' },
  { codes: 'O00-O9A', specialty: 'obgyn', what: 'Pregnancy and childbirth' },
  { codes: 'S00-T88', specialty: 'orthopedics', what: 'Injuries' },
];

function matches(line: string, code: string): boolean {
  if (line.includes('-')) {
    const [from, to] = line.split('-');
    const category = code.slice(0, 3);
    return category >= from && category <= to;
  }
  return code.replace('.', '').startsWith(line.replace('.', ''));
}

/** The medical area that usually treats an ICD-10-CM code, or null when the table has none for it (symptoms, Z codes). */
export function specialtyForIcd10(code: string | undefined): Specialty | null {
  const c = cleanIcd10(code);
  if (!c) return null;
  return ICD10_SPECIALTIES.find((l) => matches(l.codes, c))?.specialty ?? null;
}

/** Words in a condition's name that say its area, for names without a code (typed, or from the assistant). English, Spanish and Dutch. */
const NAME_WORDS: readonly [RegExp, Specialty][] = [
  // Viral hepatitis before the digestive words; heartburn and the liver words before the heart's.
  [/hepatitis [abce]\b|viral hepatitis|hepatitis viral|\bhiv\b|\bvih\b|lyme|tubercul|covid|shingles|herpes/i, 'infectious'],
  [/heartburn|acidez|brandend maagzuur|reflux|\bgerd\b|crohn|colitis|\bibs\b|celiac|celíac|coeliak|fatty liver|cirrhos|cirrosis|hepatitis|ulcer|úlcera|maagzweer/i, 'gastroenterology'],
  [/radicul|sciatic|neuropath|migrain|epilep|seizure|parkinson|multiple sclerosis|dementia|alzheimer|stroke|neuralg|ciátic|ciatic|neuropat|epileps|beroerte|hernia (de )?disco|hernia nucle/i, 'neurology'],
  [/arrhythm|atrial fib|\bheart\b|\bcardi|hypertens|blood pressure|angina|corazón|hipertens|\bhart\b|hoge bloeddruk/i, 'cardiology'],
  [/diabet|thyroid|tiroid|schildklier|hypothyr|hyperthyr|cholesterol|osteopor/i, 'endocrinology'],
  [/asthma|asma|astma|\bcopd\b|\bepoc\b|emphysem|bronch|apnea|apnoe/i, 'pulmonology'],
  [/depress|anxiety|ansiedad|angst|bipolar|\badhd\b|\btdah\b|\bptsd\b|\btept\b|schizo|autis|\bocd\b|\btoc\b/i, 'mentalHealth'],
  [/arthritis|artritis|artrose|lupus|\bgout\b|\bgota\b|jicht|fibromyalg|fibromialg/i, 'rheumatology'],
  [/eczema|eccema|psoria|\bacne\b|dermat|rosacea/i, 'dermatology'],
  [/allerg|alerg|hay fever|hooikoorts|hives|urticaria|netelroos|anaphyla/i, 'allergy'],
  [/glaucom|cataract|catarata|\bstaar\b|macular|retin/i, 'ophthalmology'],
  [/kidney|renal|riñón|\bnier/i, 'nephrology'],
  [/prostat|bladder|vejiga|\bblaas|incontinen/i, 'urology'],
  [/pregnan|embaraz|zwanger|endometrio|\bpcos\b|ovari|menopaus/i, 'obgyn'],
  [/cancer|cáncer|kanker|leukem|leucem|lymphom|linfoma|anemi|anaemi|bloedarmoede/i, 'hemOnc'],
  [/sinusitis|tinnitus|hearing loss|vertig|otitis|tonsil|amígdal/i, 'ent'],
  [/fractur|fractura|\bbreuk|tendin|sprain|esguince|verstuik|\btorn\b|scoliosis|escoliosis/i, 'orthopedics'],
];

/** The area a condition's name suggests, or null. */
export function guessSpecialty(name: string): Specialty | null {
  return NAME_WORDS.find(([re]) => re.test(name))?.[1] ?? null;
}

/** The area to file a condition under when nobody chose one: its code's, else its name's, else primary care or other. */
export function defaultSpecialty(c: { name?: string; icd10?: string }): Specialty {
  return specialtyForIcd10(c.icd10) ?? guessSpecialty(c.name ?? '') ?? 'primary';
}

// ---- Words ----

export const specialtyLabel = (s: Specialty): string => kt(`condition.specialty.${s}`);
export const conditionStatusLabel = (s: ConditionStatus): string => kt(`condition.status.${s}`);
export const severityLabel = (s: ConditionSeverity): string => kt(`condition.severity.${s}`);

/** "2019", "March 2019", "March 14, 2019" in the current language, as written mid-sentence ("marzo de 2019", "maart 2019"). */
export function partialDateWords(d: PartialDate): string {
  if (!isPartialDate(d) || d.length === 4) return d;
  if (d.length === 7) return monthYear(`${d}-01`);
  return formatYmd(d, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Sorts partial dates as the times they begin: "2019" before "2019-03" before "2019-03-14". */
export const comparePartialDates = (a: PartialDate | undefined, b: PartialDate | undefined): number => (a ?? '').localeCompare(b ?? '');

// ---- Grouping ----

const STATUS_ORDER: Record<ConditionStatus, number> = { active: 0, managed: 1, resolved: 2 };

export interface SpecialtyGroup<C extends Pick<Condition, 'name' | 'specialty' | 'status'>> {
  specialty: Specialty;
  conditions: C[];
  /** Active and managed (not resolved). */
  current: number;
}

/**
 * Conditions by medical area: inside each, active first, then managed, then resolved, then by name;
 * areas with something current before those with only resolved ones, then by their label in the
 * current language, primary care or other last.
 */
export function groupBySpecialty<C extends Pick<Condition, 'name' | 'specialty' | 'status'>>(list: readonly C[]): SpecialtyGroup<C>[] {
  const by = new Map<Specialty, C[]>();
  for (const c of list) {
    const s = isSpecialty(c.specialty) ? c.specialty : 'primary';
    by.set(s, [...(by.get(s) ?? []), c]);
  }
  const groups = [...by.entries()].map(([specialty, conditions]) => ({
    specialty,
    conditions: [...conditions].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || compareText(a.name, b.name)),
    current: conditions.filter((c) => c.status !== 'resolved').length,
  }));
  return groups.sort(
    (a, b) =>
      Number(!a.current) - Number(!b.current) ||
      Number(a.specialty === 'primary') - Number(b.specialty === 'primary') ||
      compareText(specialtyLabel(a.specialty), specialtyLabel(b.specialty)),
  );
}

// ---- Looking one up ----

/** A condition the lookup found. */
export interface ConditionMatch {
  /** The consumer name ("Radiculopathy"), else the ICD-10-CM description. */
  name: string;
  icd10?: string;
  /** `specialtyForIcd10` of the code; null when the table has none. */
  specialty: Specialty | null;
}

export const CONDITION_SEARCH_URL = 'https://clinicaltables.nlm.nih.gov/api/conditions/v3/search';
export const ICD10_SEARCH_URL = 'https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search';

/** The service is unreachable or answered oddly (offline, busy): type the name instead. */
export class ConditionSearchUnavailable extends Error {
  constructor(cause?: unknown) {
    super('condition search unavailable', { cause });
    this.name = 'ConditionSearchUnavailable';
  }
}

const searchCache = new Map<string, ConditionMatch[]>();
const CACHE_MAX = 200;

/** Forgets the answers kept for this session (tests). */
export const clearConditionSearchCache = () => searchCache.clear();

export interface ConditionSearchOptions {
  /** At most this many matches. Default 8. */
  limit?: number;
  signal?: AbortSignal;
  /** Tests pass their own. */
  fetch?: typeof fetch;
}

/**
 * Conditions whose names start with the words typed, from the National Library of Medicine's
 * Clinical Tables (free, no key, CORS open): consumer names with their ICD-10-CM code first, then,
 * when those are few, ICD-10-CM descriptions ("cervical radiculopathy" finds "Radiculopathy,
 * cervical region", M54.12). Only `term` is sent: no names, no ids, and no referrer. Answers are kept
 * for the session. Under two letters asks nothing. Throws `ConditionSearchUnavailable` when the
 * service can't be reached (offline included), and the abort error when `signal` aborts.
 */
export async function searchConditions(term: string, { limit = 8, signal, fetch: f = globalThis.fetch }: ConditionSearchOptions = {}): Promise<ConditionMatch[]> {
  const q = term.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (q.length < 2) return [];
  const key = `${q.toLowerCase()}|${limit}`;
  const kept = searchCache.get(key);
  if (kept) return kept;
  const get = async (url: string): Promise<unknown> => {
    let res: Response;
    try {
      res = await f(url, { signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ConditionSearchUnavailable(e);
    }
    if (!res.ok) throw new ConditionSearchUnavailable(res.status);
    try {
      return await res.json();
    } catch (e) {
      throw new ConditionSearchUnavailable(e);
    }
  };
  const params = (extra: Record<string, string>) => new URLSearchParams({ terms: q, maxList: String(limit), ...extra }).toString();
  const consumer = await get(`${CONDITION_SEARCH_URL}?${params({ df: 'consumer_name', ef: 'icd10cm_codes' })}`);
  const out: ConditionMatch[] = [];
  const seen = new Set<string>();
  const add = (name: string, code: string | undefined) => {
    const n = name.trim();
    const icd10 = cleanIcd10(code?.split(',')[0]);
    const k = `${n.toLowerCase()}|${icd10 ?? ''}`;
    if (!n || seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push({ name: n.slice(0, CONDITION_LIMITS.name), ...(icd10 ? { icd10 } : {}), specialty: specialtyForIcd10(icd10) });
  };
  if (Array.isArray(consumer)) {
    const codes = ((consumer[2] as Record<string, unknown> | null)?.icd10cm_codes ?? []) as unknown[];
    const names = (consumer[3] ?? []) as unknown[];
    names.forEach((row, i) => add(String((Array.isArray(row) ? row[0] : row) ?? ''), typeof codes[i] === 'string' ? (codes[i] as string) : undefined));
  } else throw new ConditionSearchUnavailable('shape');
  // Few consumer names: ICD-10-CM descriptions too. If that second ask fails, the consumer names
  // found are still an answer, but not one to keep (the next search asks again); none at all is
  // the service being unavailable.
  let complete = true;
  if (out.length < Math.min(limit, 4)) {
    const icd = await get(`${ICD10_SEARCH_URL}?${params({ sf: 'code,name', df: 'code,name' })}`).catch((e) => {
      if (signal?.aborted || !out.length) throw e;
      complete = false;
      return null;
    });
    if (Array.isArray(icd)) for (const row of (icd[3] ?? []) as unknown[]) if (Array.isArray(row)) add(String(row[1] ?? ''), String(row[0] ?? ''));
  }
  if (complete) {
    if (searchCache.size >= CACHE_MAX) searchCache.delete(searchCache.keys().next().value!);
    searchCache.set(key, out);
  }
  return out;
}
