import type { Role } from './role-core.js';

/**
 * What a reminder is about, so the shared sender (huishouden/notify) can tell it is no longer due
 * when the thing was done somewhere other than the app that wrote it: a bill paid from the portal's
 * To-do list or the connector, a task ticked in Google Tasks, a dose marked on another phone.
 * Before sending, the sender reads the records a reminder's `source` names and deletes the
 * reminder unsent when they say it is done. Without a source, a reminder is sent as before.
 *
 * A source is a list of `checks`, each on one document under the household:
 * - `{ doc, due }`: passes while the document exists and every condition holds. Without conditions,
 *   while it exists (a course not removed).
 * - `{ doc, absent: true }`: passes while the document doesn't exist: a record written once the
 *   thing is done (a dose marked given, a thing to do before an event ticked).
 *
 * The reminder is due while every check passes, or with `any: true` while at least one does (a
 * reminder for several doses at once, due while any is unmarked).
 *
 * The sender reads with its own service account (STANDARD.md "Reminders": the one place a server
 * reads household records that way), so what a source may name is limited here, and the sender
 * refuses anything else: only the reminder's own app's collections and, in each, only
 * the fields that say whether a record is done (`REMINDER_SOURCES`); only from writers who may read
 * those records (`roles`, and a Health person's `readers`); the rules make `by` the writer. A
 * refused source counts as none. So a source never tells its writer anything they couldn't see.
 *
 * Server-safe: no Firebase, no DOM. The sender imports it as it is.
 */

/** A value a condition compares a field with. */
export type SourceValue = string | number | boolean | null;

/** One condition on a field (a missing field reads as null): its value is one of `in`, or none of `notIn`. */
export type SourceCondition = { field: string; in: SourceValue[] } | { field: string; notIn: SourceValue[] };

/** One document under the household and when it keeps the reminder due. */
export type SourceCheck = { doc: string; due?: SourceCondition[] } | { doc: string; absent: true };

export interface ReminderSource {
  checks: SourceCheck[];
  /** Due while any check passes, rather than all. */
  any?: boolean;
}

/** The sizes the sender and the rules accept. */
export const REMINDER_SOURCE_LIMITS = { checks: 8, conditions: 4, values: 8, path: 400, value: 200 } as const;

/** What a collection lets a source check, and who may. */
export interface SourceCollection {
  /** Fields conditions may read: the ones that say whether a record is done. */
  fields: readonly string[];
  /** Writers' roles whose sources may name it. */
  roles: readonly Role[];
  /** The record's person (`healthPeople/{id}`, the first two parts) must list the writer in `readers`, unless an admin. */
  readers?: boolean;
}

const EVERYDAY: readonly Role[] = ['admin', 'member', 'helper'];
const HEALTH: SourceCollection['roles'] = ['admin', 'member', 'helper'];

/**
 * By app, the collections its reminders' sources may name (`*` is one document id) and what each
 * allows. Kids' sources are never used. Every collection listed is one any member of the roles
 * given may read in full (the rules' `isMember()` reads), except Bills (admins and members) and
 * Health records (the person's readers), which `roles` and `readers` cover; so even a check on
 * whether a document exists tells its writer nothing new. huishouden/rules mirrors the
 * collections (`hhSourceDoc`); add an app's collections here and there before its reminders name
 * them.
 */
export const REMINDER_SOURCES: Readonly<Record<string, Readonly<Record<string, SourceCollection>>>> = deepFreeze({
  bills: { bills: { fields: ['status', 'dismissed', 'due'], roles: ['admin', 'member'] } },
  tasks: { items: { fields: ['completed', 'dueAt'], roles: EVERYDAY } },
  pet: {
    petMedCourses: { fields: [], roles: EVERYDAY },
    petMedDoses: { fields: [], roles: EVERYDAY },
    petMeals: { fields: [], roles: EVERYDAY },
    petOutingPlans: { fields: ['on'], roles: EVERYDAY },
    petOutings: { fields: [], roles: EVERYDAY },
    petProfiles: { fields: ['birthDate', 'birthDateApprox'], roles: EVERYDAY },
    petRoutines: { fields: [], roles: EVERYDAY },
    petRoutineLogs: { fields: [], roles: EVERYDAY },
  },
  health: {
    'healthPeople/*/doses': { fields: [], roles: HEALTH, readers: true },
    'healthPeople/*/meds': { fields: ['refillOrderedAt'], roles: HEALTH, readers: true },
  },
  home: {
    homeEvents: { fields: [], roles: EVERYDAY },
    homeEventPrep: { fields: [], roles: EVERYDAY },
  },
  // A reminder is done once its record is gone, or has moved on: rescheduled, renewed, closed, serviced or paused.
  // Appointments can be private (hidden from helpers and kids), and the sender reads them whatever the flag: staff only, so a check can't probe a record its writer may not read.
  baby: { babyAppointments: { fields: ['at'], roles: ['admin', 'member'] } },
  car: {
    carRenewals: { fields: ['dueDate', 'closedAt'], roles: EVERYDAY },
    carServiceItems: { fields: ['lastDate', 'pausedAt'], roles: EVERYDAY },
  },
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
}

const SEGMENT = /^(?!\.\.?$)(?!__.*__$)[^/]{1,200}$/;

/** The collection entry a document path falls in for `app`, or undefined when its sources may not name it. */
export function sourceCollection(app: string, doc: string): SourceCollection | undefined {
  if (typeof doc !== 'string' || doc.length > REMINDER_SOURCE_LIMITS.path) return undefined;
  const parts = doc.split('/');
  if (parts.length < 2 || parts.length % 2 !== 0 || !parts.every((p) => SEGMENT.test(p))) return undefined;
  const col = parts.slice(0, -1);
  for (const [pattern, entry] of Object.entries(REMINDER_SOURCES[app] ?? {})) {
    const want = pattern.split('/');
    if (want.length === col.length && want.every((w, i) => w === '*' || w === col[i])) return entry;
  }
  return undefined;
}

const isValue = (v: unknown): v is SourceValue =>
  v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= REMINDER_SOURCE_LIMITS.value);

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readCondition(value: unknown, fields: readonly string[]): SourceCondition | null {
  if (!isMap(value) || Object.keys(value).length !== 2 || typeof value.field !== 'string' || !fields.includes(value.field)) return null;
  const op = 'in' in value ? 'in' : 'notIn' in value ? 'notIn' : null;
  const values = op ? value[op] : null;
  if (!op || !Array.isArray(values) || values.length === 0 || values.length > REMINDER_SOURCE_LIMITS.values || !values.every(isValue)) return null;
  return op === 'in' ? { field: value.field, in: [...values] } : { field: value.field, notIn: [...values] };
}

function readCheck(app: string, value: unknown): SourceCheck | null {
  if (!isMap(value) || typeof value.doc !== 'string') return null;
  const entry = sourceCollection(app, value.doc);
  if (!entry) return null;
  if (value.absent !== undefined) return value.absent === true && Object.keys(value).length === 2 ? { doc: value.doc, absent: true } : null;
  if (Object.keys(value).some((k) => k !== 'doc' && k !== 'due')) return null;
  const raw = value.due ?? [];
  if (!Array.isArray(raw) || raw.length > REMINDER_SOURCE_LIMITS.conditions) return null;
  const due = raw.map((c) => readCondition(c, entry.fields));
  if (due.some((c) => !c)) return null;
  return due.length ? { doc: value.doc, due: due as SourceCondition[] } : { doc: value.doc };
}

/**
 * A stored or written `source` as the sender uses it, or null when there is none or it breaks any
 * limit: another app's collection, a field that isn't a done field, too many checks.
 */
export function readSource(app: string, value: unknown): ReminderSource | null {
  if (!isMap(value) || Object.keys(value).some((k) => k !== 'checks' && k !== 'any')) return null;
  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > REMINDER_SOURCE_LIMITS.checks) return null;
  if (value.any !== undefined && typeof value.any !== 'boolean') return null;
  const checks = value.checks.map((c) => readCheck(app, c));
  if (checks.some((c) => !c)) return null;
  return { checks: checks as SourceCheck[], ...(value.any ? { any: true } : {}) };
}

/**
 * `source` as `reminderDoc` writes it, or undefined for none or for one the sender would refuse:
 * left off, the reminder still goes out (as one without a source) rather than failing the app's
 * sync. A source naming records only some people may read (Health's) is kept only on a personal
 * reminder (`personal`), which only its audience reads.
 */
export function cleanSource(app: string, source: ReminderSource | undefined | null, { personal = false }: { personal?: boolean } = {}): ReminderSource | undefined {
  if (source === undefined || source === null) return undefined;
  const read = readSource(app, source);
  if (!read || (!personal && read.checks.some((c) => sourceCollection(app, c.doc)?.readers))) return undefined;
  return read;
}

/** The person document a Health record belongs to (`healthPeople/p1`), whose `readers` decide who may check it. */
const personOf = (doc: string) => doc.split('/').slice(0, 2).join('/');

/** Every document the sender reads for a source: its checks' and, for Health records, their people's. */
export function sourceReads(app: string, source: ReminderSource): string[] {
  const out = new Set<string>();
  for (const c of source.checks) {
    out.add(c.doc);
    if (sourceCollection(app, c.doc)?.readers) out.add(personOf(c.doc));
  }
  return [...out];
}

/** Documents as read: fields, or null when the document doesn't exist. A path not in the map wasn't read. */
export type SourceDocs = Map<string, Record<string, unknown> | null>;

/**
 * Whether a writer with this role may have their source checked: every collection allows the role
 * and, for Health records, the reminder is personal (`personal: true`, a `personalReminders`
 * document) and the writer is an admin or one of the person's `readers`. Undefined while a person
 * document it needs wasn't read.
 */
export function sourceAllowed(
  app: string,
  source: ReminderSource,
  writer: string,
  role: string,
  read: SourceDocs,
  { personal = false }: { personal?: boolean } = {},
): boolean | undefined {
  const email = writer.trim().toLowerCase();
  let unknown = false;
  for (const c of source.checks) {
    const entry = sourceCollection(app, c.doc);
    if (!entry || !(entry.roles as readonly string[]).includes(role)) return false;
    // Records only some may read (Health's) only on a personal reminder, which only its audience reads.
    if (entry.readers && !personal) return false;
    if (!entry.readers || role === 'admin') continue;
    const person = personOf(c.doc);
    if (!read.has(person)) {
      unknown = true;
      continue;
    }
    const readers = read.get(person)?.readers;
    if (!Array.isArray(readers) || !readers.some((r) => typeof r === 'string' && r.toLowerCase() === email)) return false;
  }
  return unknown ? undefined : true;
}

const fieldOf = (fields: Record<string, unknown>, name: string): unknown => (Object.prototype.hasOwnProperty.call(fields, name) && fields[name] !== undefined ? fields[name] : null);

const holds = (c: SourceCondition, fields: Record<string, unknown>) => {
  const v = fieldOf(fields, c.field);
  return 'in' in c ? c.in.some((x) => x === v) : !c.notIn.some((x) => x === v);
};

const passes = (c: SourceCheck, fields: Record<string, unknown> | null) =>
  'absent' in c ? fields === null : fields !== null && (c.due ?? []).every((d) => holds(d, fields));

/**
 * Whether the reminder is still due by its documents as read. Undefined when a document it needs
 * wasn't read and the ones that were don't settle it: the sender then sends it as before.
 */
export function stillDue(source: ReminderSource, read: SourceDocs): boolean | undefined {
  const known = source.checks.filter((c) => read.has(c.doc));
  const results = known.map((c) => passes(c, read.get(c.doc) ?? null));
  if (source.any ? results.includes(true) : results.includes(false)) return !!source.any;
  return known.length < source.checks.length ? undefined : !source.any;
}
