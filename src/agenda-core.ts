import { MONEY_APPS } from './role-core.js';
import { cleanAudience, inAudience } from './audience.js';
import { HOUR, daysBetween, dueText, dueWords, formatTime, longDate, startOfDay, toYmd, type Ymd, ymdToTime, addDays } from './time.js';
import { capitalize, cleanLocalTexts, DEFAULT_LOCALES, formatList, getLang, kt, LANGS, localizeRecords, localized, type Lang, type LocalTexts } from './i18n.js';
import { langsOfReaders, type LocalizeOptions } from './reader-langs.js';
import { cleanRule, isEventRule, type EventRule } from './schedule.js';
import { isHhmm, isYmd, type Hhmm } from './time.js';
import { ROLES, type Role } from './role-core.js';
import type { Op } from './store.js';
import { cleanMerge, mergedTitle, mergeIdentity, MERGE_LIMITS, type MergeSpec } from './merge.js';

/**
 * The household's agenda: dated things from every app in one collection,
 * `households/{id}/agenda`, so the portal can show one calendar and a Today view without reading
 * any app's own collections. Each app publishes its items here (appointments, due jobs, bills,
 * renewals) and keeps them current; the portal only reads.
 *
 * Admins and members read every item; helpers and kids (`./roles`) only those with `private: false`,
 * so an item from a private appointment, or from Spending or Bills, is published `private: true`.
 * Every item is written with the flag: one without it counts as private to helpers and kids.
 * Fields match the rules exactly (see AGENDA_FIELDS); keep them in step.
 */

export type AgendaKind = 'appointment' | 'due' | 'renewal' | 'bill' | 'birthday' | 'medicine' | 'feeding' | 'task' | 'other';
export const AGENDA_KINDS: readonly AgendaKind[] = ['appointment', 'due', 'renewal', 'bill', 'birthday', 'medicine', 'feeding', 'task', 'other'];

/**
 * For things someone has to do (a job, a bill, a dose): `upcoming` until done, `overdue` once its day
 * has passed, `done`. Leave it out for things that simply happen (an appointment, a birthday).
 */
export type AgendaStatus = 'upcoming' | 'overdue' | 'done';
export const AGENDA_STATUSES: readonly AgendaStatus[] = ['upcoming', 'overdue', 'done'];

export interface AgendaItem {
  id: string;
  /** The app's repo short name ("home"). */
  app: string;
  /** The source record within the app ("job:abc", "appointment:xyz"); one record may give several items. */
  ref: string;
  kind: AgendaKind;
  title: string;
  /** ms since epoch. All-day items start at local midnight of their day. */
  start: number;
  /** ms since epoch, after `start`. All-day items end at local midnight after their last day. */
  end?: number;
  allDay: boolean;
  /** One short line: a place, an amount, "autopay on". */
  detail?: string;
  /** https deep link to the record in the app. */
  url: string;
  /** Who or what it is for: a pet, a person, a car. */
  who?: string;
  status?: AgendaStatus;
  /** Only admins and members see it: from a private record, or about money. Stored as a boolean. */
  private?: boolean;
  /**
   * Only these members see it (lowercase emails): an item in `personalAgenda` (`./audience`), about
   * one person's care. Absent on the shared agenda.
   */
  audience?: string[];
  /** The title and detail in its readers' other languages (`localizeAgenda`); `title`/`detail` are the writer's and the fallback. */
  texts?: AgendaTexts;
  /**
   * One occurrence of something on a schedule (garbage pickup every Thursday): the schedule, so a
   * calendar can show the whole series as one repeating event (`./calendar-export`), and which of
   * its days this one is.
   */
  series?: AgendaSeries;
  /**
   * How a change made elsewhere (the item moved or renamed in the person's own calendar) is written
   * back to the record it came from: declarative writes on the app's own collections, as a to-do's
   * Done (`./todo-core`), made as the person so the app's rules still decide.
   */
  edit?: AgendaEdit;
  /**
   * More than the portal shows, for the reader's own calendar only, when they turn on detail
   * (`./calendar-export`): a Health dose's medicine names. The portal never displays it; like the
   * rest of the item, only its readers can read it.
   */
  calendarDetail?: string;
  /**
   * May show as one with the app's other items that have the same `merge.key`, start, end and
   * readers (`mergeAgenda`, `./merge`): garbage and recycling on the same morning.
   */
  merge?: MergeSpec;
  updatedAt: number;
  /** Lowercase email of the member whose app wrote it. */
  by: string;
}

/** What an agenda item says, per language: its title and detail, and its merge's part and title. */
export type AgendaTexts = LocalTexts<'title' | 'detail' | 'mergePart' | 'mergeTitle'>;

export const AGENDA_FIELDS = ['app', 'ref', 'kind', 'title', 'start', 'end', 'allDay', 'detail', 'url', 'who', 'status', 'private', 'texts', 'series', 'edit', 'calendarDetail', 'merge', 'updatedAt', 'by'] as const;

/**
 * An occurrence's schedule. Each occurrence of the series carries the same `rule`, `time` and
 * `through`; `original` is the day the schedule put this one on (the key of a move or skip in the
 * app's own record), which differs from the item's day when it was moved. A day of the rule up to
 * `through` with no item is skipped; after `through` nothing is known yet, so the schedule stands.
 */
export interface AgendaSeries {
  rule: EventRule;
  /** Its usual time of day; all day without one. */
  time?: Hhmm;
  /** How long a timed occurrence lasts, in minutes (default `SERIES_DEFAULT_MINUTES`). */
  minutes?: number;
  original: Ymd;
  /** The last day the app published occurrences for. */
  through: Ymd;
}

export const SERIES_FIELDS = ['rule', 'time', 'minutes', 'original', 'through'] as const;
export const SERIES_DEFAULT_MINUTES = 60;

/**
 * Writes that change the source record, each with the roles that may (the same as the app's rules).
 * `reschedule`: the item moved to another day or time. `retime`: a series' usual time changed for
 * every occurrence. `rename`: a new title (for a series, the whole series'). `notes`: new notes.
 * `skip`: this occurrence of a series won't happen. `cancel`: a one-off item was deleted.
 *
 * Op data may use the to-do placeholders (`'$now'`, `'$today'`, `'$me'`) and these, filled in from
 * the change: `'$start'` and `'$end'` (ms), `'$date'` (YYYY-MM-DD) and `'$time'` (HH:MM, or the
 * field is removed when the item became all day), `'$title'` and `'$notes'`, and for an occurrence
 * of a series `'$original'`, its day as the schedule has it, also as a map key, so one edit on the
 * series serves every occurrence: `{ exceptions: { $original: { skipped: true } } }`.
 */
export interface AgendaEdit {
  reschedule?: AgendaAction;
  retime?: AgendaAction;
  rename?: AgendaAction;
  notes?: AgendaAction;
  skip?: AgendaAction;
  cancel?: AgendaAction;
}

export type AgendaEditKind = keyof AgendaEdit;
export const AGENDA_EDIT_KINDS: readonly AgendaEditKind[] = ['reschedule', 'retime', 'rename', 'notes', 'skip', 'cancel'];

export interface AgendaAction {
  /** Writes under `households/{id}`, on collections the app may change (`AGENDA_EDIT_COLLECTIONS`). */
  ops: Op[];
  roles: Role[];
  /** Also these members (lowercase emails): whoever added the record, a medicine's carers. */
  emails?: string[];
}

/** The most writes one action may make, and members it may name. */
export const AGENDA_EDIT_LIMITS = { ops: 4, emails: 12 } as const;

/**
 * The collections each app's agenda edits may write. A change from a calendar that would touch
 * anything else is refused, so an item can't be made to change money or settings.
 */
export const AGENDA_EDIT_COLLECTIONS: Record<string, readonly string[]> = {
  home: ['homeTasks', 'homeServiceLog', 'homeEvents'],
  baby: ['babyAppointments', 'babyChecklists'],
  pet: ['petAppointments', 'petReminders'],
  car: ['carAppointments', 'carRenewals', 'carServiceItems'],
  tasks: ['items'],
  health: [],
  bills: [],
  groceries: [],
};

/** The collection of items for named members only (`./audience`). */
export const PERSONAL_AGENDA = 'personalAgenda';

/** Fields of a `personalAgenda` item: the agenda's plus `audience`. */
export const PERSONAL_AGENDA_FIELDS = [...AGENDA_FIELDS, 'audience'] as const;

/** Maximum lengths, the same as the rules. */
export const AGENDA_LIMITS = { app: 40, ref: 200, title: 120, detail: 200, calendarDetail: 200, url: 2000, who: 60, by: 254 } as const;

/** Limits inside `texts`, the same as the fields they translate. */
export const AGENDA_TEXT_LIMITS = { title: AGENDA_LIMITS.title, detail: AGENDA_LIMITS.detail, mergePart: MERGE_LIMITS.part, mergeTitle: MERGE_LIMITS.title } as const;

/**
 * Runs `build` in the writer's language and in the languages of each item's readers
 * (`./reader-langs`: its audience, else the members who may see it), and gives the items with
 * `texts` (title and detail) in those readers' languages, so the portal and calendars show each
 * reader their own:
 *
 * ```ts
 * syncAgenda(db, id, 'bills', await localizeAgenda(() => billAgenda(bills)), { by: me });
 * ```
 */
export function localizeAgenda<T extends Pick<AgendaInput, 'title' | 'detail' | 'merge'>>(build: () => T[], options: LocalizeOptions = {}): Promise<(T & { texts?: AgendaTexts })[]> {
  const writer = options.writer ?? getLang();
  return localizeRecords(build, (item) => ({ title: item.title, detail: item.detail, mergePart: item.merge?.part, mergeTitle: item.merge?.title }), { langsOf: langsOfReaders(options, writer), writer });
}

/** An item's title and detail in the reader's language. */
export function agendaWords(item: Pick<AgendaItem, 'title' | 'detail' | 'texts'>): { title: string; detail?: string } {
  return { title: localized(item, 'title', item.title) ?? item.title, detail: localized(item, 'detail', item.detail) };
}

/** Apps publish items from this many days ago (overdue ones whatever their age)... */
export const AGENDA_PAST_DAYS = 30;
/** ...to this many days ahead. */
export const AGENDA_AHEAD_DAYS = 180;

/** What an app passes in: everything but the bookkeeping the kit fills in. */
export type AgendaInput = Omit<AgendaItem, 'id' | 'app' | 'updatedAt' | 'by' | 'audience'>;

/** An item for named members only: who may see it (`./audience`). */
export type PersonalAgendaInput = AgendaInput & { audience: readonly string[] };

/** An all-day item's `start` (and, for the day after its last, `end`): local midnight of a day. */
export const allDayStart = (day: Ymd): number => ymdToTime(day);

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_');

/** The same id for the same item however often it is published: `<app>_<ref>_<start>`, Firestore-safe. */
export function agendaId(app: string, ref: string, start: number): string {
  return `${safe(app).slice(0, 40)}_${safe(ref).slice(0, 200)}_${Math.round(start)}`;
}

const clip = (s: string | undefined, max: number) => (s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** The stored document: trimmed and clipped to the rules' sizes; throws on what the rules would refuse. */
export function agendaDoc(app: string, input: AgendaInput, by: string, now = Date.now()): Omit<AgendaItem, 'id'> {
  if (!/^https:\/\//.test(input.url)) throw new Error('Agenda url must be an https deep link into the app.');
  if (!AGENDA_KINDS.includes(input.kind)) throw new Error(`Unknown agenda kind: ${input.kind}`);
  if (input.status !== undefined && !AGENDA_STATUSES.includes(input.status)) throw new Error(`Unknown agenda status: ${input.status}`);
  if (!Number.isFinite(input.start)) throw new Error('Agenda item has no start.');
  const title = clip(input.title, AGENDA_LIMITS.title);
  if (!title) throw new Error('Agenda item has no title.');
  if (!input.ref) throw new Error('Agenda item has no ref.');
  const start = Math.round(input.start);
  const end = input.end !== undefined && Number.isFinite(input.end) && Math.round(input.end) > start ? Math.round(input.end) : undefined;
  const detail = clip(input.detail, AGENDA_LIMITS.detail);
  const calendarDetail = clip(input.calendarDetail, AGENDA_LIMITS.calendarDetail);
  const who = clip(input.who, AGENDA_LIMITS.who);
  const texts = cleanLocalTexts(input.texts, AGENDA_TEXT_LIMITS);
  const series = input.series === undefined ? undefined : cleanSeries(input.series);
  if (input.series !== undefined && !series) throw new Error('Agenda series is not a schedule the rules accept.');
  const edit = input.edit === undefined ? undefined : cleanEdit(app, input.edit);
  const merge = input.merge === undefined ? undefined : cleanMerge(input.merge);
  if (input.merge !== undefined && !merge) throw new Error('Agenda merge needs a key, a part, and a title with {parts}.');
  return {
    app,
    ref: input.ref.slice(0, AGENDA_LIMITS.ref),
    kind: input.kind,
    title,
    start,
    ...(end !== undefined ? { end } : {}),
    allDay: input.allDay === true,
    ...(detail ? { detail } : {}),
    url: input.url.slice(0, AGENDA_LIMITS.url),
    ...(who ? { who } : {}),
    ...(input.status ? { status: input.status } : {}),
    private: input.private === true || MONEY_APPS.includes(app),
    ...(texts ? { texts } : {}),
    ...(series ? { series } : {}),
    ...(edit ? { edit } : {}),
    ...(calendarDetail ? { calendarDetail } : {}),
    ...(merge ? { merge } : {}),
    updatedAt: now,
    by: by.trim().toLowerCase(),
  };
}

/**
 * A `personalAgenda` document: as `agendaDoc`, private, with the audience cleaned. Throws when the
 * audience is empty or leaves out the writer (the rules refuse both).
 */
export function personalAgendaDoc(app: string, input: PersonalAgendaInput, by: string, now = Date.now()): Omit<AgendaItem, 'id'> {
  const audience = cleanAudience(input.audience);
  if (!inAudience(audience, by)) throw new Error('A personal agenda item must name its writer in its audience.');
  const { audience: _a, ...rest } = input;
  return { ...agendaDoc(app, { ...rest, private: true }, by, now), audience };
}

/** The window apps publish: from `AGENDA_PAST_DAYS` ago to `AGENDA_AHEAD_DAYS` ahead, whole days. */
export function agendaWindow(now: number): { from: number; to: number } {
  return { from: addDays(now, -AGENDA_PAST_DAYS), to: addDays(now, AGENDA_AHEAD_DAYS + 1) };
}

/** Whether an item belongs in the published window: overlapping it, or overdue whatever its age. */
export function inAgendaWindow(item: Pick<AgendaItem, 'start' | 'end' | 'status'>, now: number): boolean {
  const { from, to } = agendaWindow(now);
  if (item.start >= to) return false;
  return item.status === 'overdue' || (item.end ?? item.start) >= from;
}
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A series as stored: known keys only, or undefined when it isn't one. */
export function cleanSeries(v: unknown): AgendaSeries | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const s = v as Record<string, unknown>;
  if (!isEventRule(s.rule) || !isYmd(s.original) || !isYmd(s.through)) return undefined;
  if (s.time !== undefined && !isHhmm(s.time)) return undefined;
  const minutes = typeof s.minutes === 'number' && Number.isInteger(s.minutes) && s.minutes > 0 && s.minutes <= 24 * 60 ? s.minutes : undefined;
  return {
    rule: cleanRule(s.rule),
    ...(s.time ? { time: s.time as Hhmm } : {}),
    ...(minutes ? { minutes } : {}),
    original: s.original as Ymd,
    through: s.through as Ymd,
  };
}

/** Whether a collection path matches an entry of `AGENDA_EDIT_COLLECTIONS` (`*` is one id). */
function collectionMatches(pattern: string, col: string): boolean {
  const want = pattern.split('/');
  const have = col.split('/');
  return want.length === have.length && want.every((w, i) => (w === '*' ? /^[^/]{1,200}$/.test(have[i]) && have[i] !== '.' && have[i] !== '..' : w === have[i]));
}

/** Whether every op writes only collections `app`'s edits may (`AGENDA_EDIT_COLLECTIONS`), and at most `AGENDA_EDIT_LIMITS.ops`. */
export function agendaOpsAllowed(app: string, ops: readonly Op[]): boolean {
  const allowed = AGENDA_EDIT_COLLECTIONS[app] ?? [];
  return (
    ops.length > 0 &&
    ops.length <= AGENDA_EDIT_LIMITS.ops &&
    ops.every(
      (op) =>
        allowed.some((p) => collectionMatches(p, op.col)) &&
        typeof op.id === 'string' &&
        /^[^/]{1,200}$/.test(op.id) &&
        op.id !== '.' &&
        op.id !== '..' &&
        (op.data === null || (typeof op.data === 'object' && !Array.isArray(op.data))),
    )
  );
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function readAction(app: string, v: unknown): AgendaAction | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  if (!Array.isArray(a.ops)) return undefined;
  const ops = a.ops.flatMap((o): Op[] => {
    if (!o || typeof o !== 'object') return [];
    const { col, id, data, merge } = o as Record<string, unknown>;
    if (typeof col !== 'string' || typeof id !== 'string') return [];
    if (data !== null && (typeof data !== 'object' || Array.isArray(data))) return [];
    return [{ col, id, data: data === null ? null : plain(data as object), ...(merge === true ? { merge: true } : {}) }];
  });
  if (!agendaOpsAllowed(app, ops)) return undefined;
  const roles = Array.isArray(a.roles) ? ROLES.filter((r) => (a.roles as unknown[]).includes(r)) : [];
  const emails = Array.isArray(a.emails)
    ? [...new Set(a.emails.filter((e): e is string => typeof e === 'string').map((e) => e.trim().toLowerCase()))].slice(0, AGENDA_EDIT_LIMITS.emails)
    : [];
  if (roles.length === 0 && emails.length === 0) return undefined;
  return { ops, roles, ...(emails.length ? { emails } : {}) };
}

function readEdit(app: string, v: unknown): AgendaEdit | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const e = v as Record<string, unknown>;
  const out: AgendaEdit = {};
  for (const kind of AGENDA_EDIT_KINDS) {
    const action = readAction(app, e[kind]);
    if (action) out[kind] = action;
  }
  return Object.keys(out).length ? out : undefined;
}

/** An item's edits as stored; throws on one that writes outside the app's collections (`AGENDA_EDIT_COLLECTIONS`). */
export function cleanEdit(app: string, edit: AgendaEdit): AgendaEdit | undefined {
  for (const kind of Object.keys(edit)) {
    if (!(AGENDA_EDIT_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown agenda edit: ${kind}`);
    const action = edit[kind as AgendaEditKind];
    if (action && !agendaOpsAllowed(app, action.ops)) throw new Error(`Agenda ${kind} writes outside ${app}'s collections.`);
  }
  return readEdit(app, edit);
}

/** Whether `me` with `role` may make the item's `kind` edit: it exists, is allowed for the app, and names their role or them. */
export function canEdit(item: Pick<AgendaItem, 'app' | 'edit'>, kind: AgendaEditKind, role: Role | null | undefined, me: string | null | undefined): boolean {
  const action = item.edit?.[kind];
  if (!action || !role || !agendaOpsAllowed(item.app, action.ops)) return false;
  if (MONEY_APPS.includes(item.app) && role !== 'admin' && role !== 'member') return false;
  if (action.roles.includes(role)) return true;
  const email = me?.trim().toLowerCase() ?? '';
  return !!email && (action.emails ?? []).includes(email);
}

/** What fills an edit's placeholders: the change as the calendar has it. */
export interface EditValues {
  start?: number;
  end?: number;
  /** YYYY-MM-DD, the item's day where it happens. */
  date?: Ymd;
  /** HH:MM, or null when it became all day (the field is removed). */
  time?: Hhmm | null;
  title?: string;
  notes?: string;
  /** YYYY-MM-DD: the day the schedule put the occurrence on, for `'$original'` (a value, or a map key). */
  original?: Ymd;
}

/** Sentinel the writer turns into a field delete (Firestore REST: the field left out of a merge's values). */
export const DELETE_FIELD = '$delete';

function fillValue(v: unknown, values: EditValues): unknown {
  if (typeof v === 'string') {
    switch (v) {
      case '$start':
        return values.start ?? v;
      case '$end':
        return values.end ?? v;
      case '$date':
        return values.date ?? v;
      case '$time':
        return values.time === null ? DELETE_FIELD : (values.time ?? v);
      case '$title':
        return values.title ?? v;
      case '$notes':
        return values.notes ?? v;
      case '$original':
        return values.original ?? v;
      default:
        return v;
    }
  }
  if (Array.isArray(v)) return v.map((x) => fillValue(x, values));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === '$original' && values.original ? values.original : k, fillValue(x, values)]));
  return v;
}

const EDIT_PLACEHOLDER = /^\$(start|end|date|time|title|notes|original)$/;

function hasUnfilled(v: unknown): boolean {
  if (typeof v === 'string') return EDIT_PLACEHOLDER.test(v);
  if (Array.isArray(v)) return v.some(hasUnfilled);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => EDIT_PLACEHOLDER.test(k) || hasUnfilled(x));
  return false;
}

/**
 * An edit's ops with the change's values in place of `'$start'`, `'$date'`, `'$time'`, `'$title'`
 * and so on (the to-do placeholders such as `'$now'` are left for `resolveOps`). Throws when the
 * change lacks a value an op needs. `'$time'` for an item that became all day is `DELETE_FIELD`.
 */
export function fillEditOps(ops: readonly Op[], values: EditValues): Op[] {
  const out = ops.map((op) => ({ ...op, data: op.data === null ? null : (fillValue(op.data, values) as object) }));
  if (out.some((op) => hasUnfilled(op.data))) throw new Error('The change is missing a value this edit needs.');
  return out;
}

/** A stored document as an item, read defensively. */
export function toAgendaItem(id: string, data: Record<string, unknown>): AgendaItem {
  const kind = AGENDA_KINDS.includes(data.kind as AgendaKind) ? (data.kind as AgendaKind) : 'other';
  const status = AGENDA_STATUSES.includes(data.status as AgendaStatus) ? (data.status as AgendaStatus) : undefined;
  const end = num(data.end);
  const detail = str(data.detail);
  const who = str(data.who);
  const texts = cleanLocalTexts(data.texts, AGENDA_TEXT_LIMITS);
  const series = cleanSeries(data.series);
  const edit = readEdit(str(data.app) ?? '', data.edit);
  const merge = cleanMerge(data.merge);
  return {
    id,
    app: str(data.app) ?? '',
    ref: str(data.ref) ?? '',
    kind,
    title: str(data.title) ?? '',
    start: num(data.start) ?? 0,
    ...(end !== undefined ? { end } : {}),
    allDay: data.allDay === true,
    ...(detail ? { detail } : {}),
    url: str(data.url) ?? '',
    ...(who ? { who } : {}),
    ...(status ? { status } : {}),
    // Left out when the document has no flag, so an admin's or member's sync writes one.
    ...(typeof data.private === 'boolean' ? { private: data.private } : {}),
    ...(Array.isArray(data.audience) ? { audience: data.audience.filter((e): e is string => typeof e === 'string') } : {}),
    ...(texts ? { texts } : {}),
    ...(series ? { series } : {}),
    ...(edit ? { edit } : {}),
    ...(str(data.calendarDetail) ? { calendarDetail: str(data.calendarDetail) } : {}),
    ...(merge ? { merge } : {}),
    updatedAt: num(data.updatedAt) ?? 0,
    by: str(data.by) ?? '',
  };
}

const byStart = (a: AgendaItem, b: AgendaItem) =>
  a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title);

export interface AgendaRange {
  /** ms; items ending before this are left out, except overdue ones. */
  from: number;
  /** ms; items starting at or after this are left out. */
  to: number;
  /** Only these apps' items. */
  apps?: string[];
  /** A helper or kid (`isRestricted(role)`): only items not marked private, as the rules require. */
  restricted?: boolean;
  /** The signed-in member's email: also follows the items for named members that name them (`./audience`). */
  me?: string;
  onError?: (error: Error) => void;
}

/**
 * The items overlapping `from`..`to` (and any overdue), soonest first, optionally only `apps`':
 * what `watchAgenda` shows, for a reader of stored items without Firebase.
 */
export function agendaInRange(items: readonly AgendaItem[], { from, to, apps }: Pick<AgendaRange, 'from' | 'to' | 'apps'>): AgendaItem[] {
  return items.filter((i) => i.start < to && (!apps || apps.includes(i.app)) && (i.status === 'overdue' || (i.end ?? i.start) >= from)).sort(byStart);
}


// ---- Merging: things that show as one (`./merge`) ----

/**
 * An item `mergeAgenda` made, standing for `members` (each still its own record, with its own
 * edits). Its `id` and `ref` name no stored document: act on the members (`isMergedItem`).
 */
export interface MergedAgendaItem extends AgendaItem {
  members: AgendaItem[];
  series?: undefined;
  edit?: undefined;
}

export const isMergedItem = (item: AgendaItem): item is MergedAgendaItem => Array.isArray((item as Partial<MergedAgendaItem>).members);

/**
 * What items merge under: `mergeIdentity` (the same app, `merge.key` and kind, the same readers,
 * both done or both not) and the same start, end and all-day. Null for an item without a merge.
 */
export function agendaMergeKey(item: Pick<AgendaItem, 'app' | 'kind' | 'start' | 'end' | 'allDay' | 'status' | 'private' | 'audience' | 'merge'>): string | null {
  const identity = mergeIdentity(item);
  return identity && `${identity}|${item.allDay ? 'day' : 'time'}|${item.start}|${item.end ?? ''}`;
}

/**
 * The items that merge, by key: each group of two or more items (from different records) that
 * `agendaMergeKey` puts together, its members in the order of their parts.
 */
export function agendaMergeGroups(items: readonly AgendaItem[]): Map<string, AgendaItem[]> {
  const groups = new Map<string, AgendaItem[]>();
  for (const item of items) {
    const key = agendaMergeKey(item);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, list] of groups) {
    const records = new Set(list.map((i) => `${i.app}|${i.ref}`));
    if (records.size < 2) groups.delete(key);
    else list.sort((a, b) => a.merge!.part.localeCompare(b.merge!.part) || a.ref.localeCompare(b.ref) || a.id.localeCompare(b.id));
  }
  return groups;
}

const STATUS_RANK: Record<AgendaStatus, number> = { overdue: 0, upcoming: 1, done: 2 };
const same = <T>(values: T[]): T | undefined => (values.every((v) => v === values[0]) ? values[0] : undefined);

/** The words of a merged item in `lang`: the combined title, and each member's detail. */
export function mergedWords(members: readonly AgendaItem[], lang: Lang): { title: string; detail?: string } {
  const template = members[0].texts?.[lang]?.mergeTitle ?? members[0].merge!.title;
  const parts = members.map((m) => m.texts?.[lang]?.mergePart ?? m.merge!.part);
  const title = mergedTitle(template, parts, lang);
  const own = members.map((m) => ({ title: m.texts?.[lang]?.title ?? m.title, detail: m.texts?.[lang]?.detail ?? m.detail }));
  const details = own.map((o) => o.detail ?? '');
  const shared = same(details);
  const detail = shared !== undefined ? shared || undefined : own.filter((o) => o.detail).map((o) => `${o.title}: ${o.detail}`).join(' · ');
  return { title, ...(detail ? { detail } : {}) };
}

/** One item standing for `members` (a merge group): the combined words in every language, `members` kept. */
export function mergedItem(key: string, members: readonly AgendaItem[], lang: Lang = getLang()): MergedAgendaItem {
  const first = members[0];
  const latest = [...members].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const texts: AgendaTexts = {};
  for (const l of LANGS) texts[l] = mergedWords(members, l);
  const { title, detail } = mergedWords(members, lang);
  // Members link to the same view of their app (Home's regular events, Pet's Today) or each to its own record: then the first's.
  const url = same(members.map((m) => m.url)) ?? first.url;
  const whos = [...new Set(members.map((m) => m.who).filter((w): w is string => !!w))];
  const statuses = members.map((m) => m.status).filter((s): s is AgendaStatus => !!s);
  const status = statuses.sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])[0];
  return {
    id: `merge:${key}`,
    app: first.app,
    ref: `merge:${first.merge!.key}`,
    kind: first.kind,
    title,
    start: first.start,
    ...(first.end !== undefined ? { end: first.end } : {}),
    allDay: first.allDay,
    ...(detail ? { detail } : {}),
    url,
    ...(whos.length === 1 ? { who: whos[0] } : whos.length > 1 ? { who: formatList(whos, { loc: DEFAULT_LOCALES[lang] }) } : {}),
    ...(status ? { status } : {}),
    private: members.some((m) => m.private !== false),
    ...(first.audience ? { audience: first.audience } : {}),
    texts,
    merge: first.merge,
    members: [...members],
    updatedAt: latest.updatedAt,
    by: latest.by,
  };
}

/**
 * The items as they show: those that merge (`agendaMergeGroups`) as one item each, in the place of
 * the first of them, the rest as they are. Titles in `lang` (default the page's), with `texts` in
 * every language. Each merged item keeps its `members`, so a screen can still act on each record.
 */
export function mergeAgenda(items: readonly AgendaItem[], lang: Lang = getLang()): (AgendaItem | MergedAgendaItem)[] {
  const groups = agendaMergeGroups(items);
  if (!groups.size) return [...items];
  const groupOf = new Map<string, string>();
  for (const [key, members] of groups) for (const m of members) groupOf.set(m.id, key);
  const out: (AgendaItem | MergedAgendaItem)[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const key = groupOf.get(item.id);
    if (!key) out.push(item);
    else if (!placed.has(key)) {
      placed.add(key);
      out.push(mergedItem(key, groups.get(key)!, lang));
    }
  }
  return out;
}

// ---- Reading the agenda: Today and days ----

/**
 * Where an item stands now. Items with a status become overdue once their time passes even if the
 * app that wrote them hasn't been opened since: an all-day one after its last day, a timed one after
 * its start. Items without a status (appointments, birthdays) have none.
 */
export function agendaStatus(item: AgendaItem, now: number): AgendaStatus | undefined {
  if (!item.status || item.status === 'done') return item.status;
  if (item.status === 'overdue') return 'overdue';
  const passed = item.allDay ? lastDay(item) < toYmd(now) : item.start < now;
  return passed ? 'overdue' : 'upcoming';
}

/** The day an item's last moment falls on (an all-day `end` is the midnight after it). */
function lastDay(item: AgendaItem): Ymd {
  if (item.end === undefined) return toYmd(item.start);
  return toYmd(item.allDay ? item.end - 1 : item.end);
}

/** "All day", "3:30 PM", "3:30 PM – 4:30 PM". */
export function agendaTime(item: AgendaItem): string {
  if (item.allDay) return kt('agenda.allDay');
  const start = formatTime(item.start);
  return item.end !== undefined && toYmd(item.end) === toYmd(item.start) ? kt('agenda.timeRange', { start, end: formatTime(item.end) }) : start;
}

/** Kinds tied to one occasion: a meal or a dose not given by the end of its day is missed, not still to do. */
const OCCASIONS: readonly AgendaKind[] = ['feeding', 'medicine'];

export type TodayGroup = 'overdue' | 'today' | 'soon' | 'done';

export interface TodayEntry {
  item: AgendaItem;
  group: TodayGroup;
  /** When, in words: "Overdue by 3 days", "Due today", "3:30 PM", "Tomorrow, 9:00 AM". */
  when: string;
}

export interface TodayOptions {
  /** How far ahead "soon" reaches. Default 48. */
  soonHours?: number;
  /** Also return today's finished items, as the 'done' group, so a screen can show what's been done. */
  includeDone?: boolean;
}

/**
 * What needs attention: overdue things first (oldest first), then today's (all-day first, then by
 * time; finished appointments left out), then the next `soonHours`. Done items are left out, and so
 * are feeds and doses from earlier days (`feeding`, `medicine`) and timed items with a status whose
 * `end` has passed (a window to do it in that has closed): those are missed, not overdue.
 * Ongoing spans (all-day, several days, no status: a medicine course, a trip) are context for the
 * calendar, not something to do today, so they are left out too. With `includeDone`, today's
 * finished items come back as the 'done' group, last.
 */
export function todayItems(items: AgendaItem[], now: number, { soonHours = 48, includeDone = false }: TodayOptions = {}): TodayEntry[] {
  const today = toYmd(now);
  const soonUntil = now + soonHours * HOUR;
  const out: TodayEntry[] = [];
  for (const item of items) {
    const status = agendaStatus(item, now);
    const first = toYmd(item.start);
    if (status === 'done') {
      if (includeDone && first <= today && lastDay(item) >= today) out.push({ item, group: 'done', when: kt('agenda.done') });
      continue;
    }
    if (item.allDay && !status && lastDay(item) > first) continue;
    if (status === 'overdue') {
      const due = item.allDay ? lastDay(item) : first;
      if (due < today && OCCASIONS.includes(item.kind)) continue;
      // A timed one with an end is due within a window (put the bins out before pickup): once the
      // window has closed it is missed, not something still to do.
      if (!item.allDay && item.end !== undefined && item.end <= now) continue;
      const when = due < today || item.allDay ? dueText(due, today) : kt('agenda.overdueSince', { time: formatTime(item.start) });
      out.push({ item, group: 'overdue', when });
      continue;
    }
    if (first <= today && lastDay(item) >= today) {
      if (!item.allDay && !status && (item.end ?? item.start) < now) continue;
      const when = item.allDay ? (status ? kt('time.dueToday') : capitalize(kt('time.today'))) : agendaTime(item);
      out.push({ item, group: 'today', when });
      continue;
    }
    if (first > today && item.start < soonUntil) {
      const day = dueWords(first, today);
      out.push({ item, group: 'soon', when: item.allDay ? day : kt('agenda.dayAtTime', { day, time: formatTime(item.start) }) });
    }
  }
  const rank: Record<TodayGroup, number> = { overdue: 0, today: 1, soon: 2, done: 3 };
  return out.sort((a, b) => rank[a.group] - rank[b.group] || byStart(a.item, b.item));
}

export interface AgendaDay {
  day: Ymd;
  /** "Today", "Tomorrow", "Yesterday", or "Tuesday, November 4" (with the year when it isn't this year's). */
  label: string;
  /** All-day items first, then by time. */
  items: AgendaItem[];
}

export interface AgendaDaysOptions {
  /** First and last day to show; default every day that has an item. */
  from?: Ymd;
  to?: Ymd;
  /** Include days with nothing on them between `from` and `to`. Default false. */
  emptyDays?: boolean;
}

/** The longest span an item is shown on every day of; longer ones show on their first day only. */
const MAX_SPAN_DAYS = 31;

/** A calendar label for a day relative to now: "Today", "Tomorrow", "Yesterday", or its long date. */
export function dayLabel(day: Ymd, now: number): string {
  const today = toYmd(now);
  const n = daysBetween(today, day);
  if (n === 0) return capitalize(kt('time.today'));
  if (n === 1) return capitalize(kt('time.tomorrow'));
  if (n === -1) return capitalize(kt('time.yesterday'));
  return capitalize(longDate(day, today));
}

/** Items by local day, for a calendar list: an item spanning several days shows on each of them. */
export function agendaDays(items: AgendaItem[], now: number, { from, to, emptyDays = false }: AgendaDaysOptions = {}): AgendaDay[] {
  const days = new Map<Ymd, AgendaItem[]>();
  const add = (day: Ymd, item: AgendaItem) => {
    if ((from && day < from) || (to && day > to)) return;
    const list = days.get(day);
    if (list) list.push(item);
    else days.set(day, [item]);
  };
  for (const item of items) {
    const first = toYmd(item.start);
    const last = lastDay(item);
    const span = daysBetween(first, last);
    if (span <= 0 || span > MAX_SPAN_DAYS) add(first, item);
    else for (let d = 0; d <= span; d++) add(addDays(first, d), item);
  }
  if (emptyDays && from && to) for (let d = from; d <= to; d = addDays(d, 1)) if (!days.has(d)) days.set(d, []);
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, list]) => ({ day, label: dayLabel(day, now), items: list.sort(byStart) }));
}

/** Local midnight today and `days` later: a range for `watchAgenda`. */
export function agendaRange(now: number, days: number, pastDays = 0): { from: number; to: number } {
  const start = startOfDay(now);
  return { from: addDays(start, -pastDays), to: addDays(start, days) };
}
