import { SERIES_DEFAULT_MINUTES, type AgendaItem, type AgendaKind, type AgendaSeries, type AgendaStatus } from './agenda-core.js';
import type { TodoItem } from './todo-core.js';
import { MONEY_APPS, type Role } from './role-core.js';
import { kt, loadLang, withLang, type Lang } from './i18n.js';
import { ruleOccurrences, type EventRule } from './schedule.js';
import { addDays, isYmd, type Hhmm, type Ymd } from './time.js';
import { allDayOf, clockIn, dayIn, firstOccurrence, icsCalendar, icsDate, icsLocal, lastOccurrence, ruleToRrule, zonedTime, type IcsEvent } from './ics.js';

/**
 * The household's agenda in a person's own calendar: what one person may see, in their language,
 * as calendar events. One model feeds the subscribed calendar (`exportIcs`, served by
 * huishouden/calendar), the Google Calendar sync (the same Worker) and the "Add to calendar"
 * buttons (`addToCalendarIcs`, `googleTemplateUrl`). Server-safe.
 *
 * Who sees what follows the household's rules, and is checked here again: helpers and kids only
 * items not marked private and nothing about money; personal items (Health) only their audience.
 * Each person's settings (`CalendarSettings`) then leave out apps (Bills among them), to-dos or done things, and keep Health
 * items to "Medicine for Ana" or "Appointment for Ana" unless they ask for the detail, since calendars
 * are often shared.
 *
 * Regular events (an agenda item with `series`) become one repeating event: an RRULE from the
 * schedule, EXDATEs for skipped days and overrides for moved ones.
 */

// ---- Settings: `households/{id}/calendarSettings/{email}` ----

export interface CalendarSettings {
  /** Apps left out of the calendar ("pet"). "bills" stands for the household's money items (Bills and Spending). */
  hiddenApps: string[];
  /** To-dos with a due day. */
  todos: boolean;
  /** Health items with their detail; off, they read "Medicine for Ana" or "Appointment for Ana" and nothing more. */
  healthDetail: boolean;
  /** Things already done (a ticked task, a given dose). */
  done: boolean;
}

export const CALENDAR_SETTINGS = 'calendarSettings';
export const CALENDAR_SETTINGS_FIELDS = ['hiddenApps', 'todos', 'healthDetail', 'done', 'updatedAt', 'by'] as const;
export const DEFAULT_CALENDAR_SETTINGS: Readonly<CalendarSettings> = { hiddenApps: [], todos: true, healthDetail: false, done: true };

/** Stored settings read defensively; anything missing takes its default. A stored `bills: false` (the old separate switch) reads as Bills (and with it Spending) hidden. */
export function toCalendarSettings(data: unknown): CalendarSettings {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const flag = (k: keyof CalendarSettings) => (typeof d[k] === 'boolean' ? (d[k] as boolean) : (DEFAULT_CALENDAR_SETTINGS[k] as boolean));
  const hidden = Array.isArray(d.hiddenApps) ? d.hiddenApps.filter((a): a is string => typeof a === 'string' && /^[a-z]{1,40}$/.test(a)) : [];
  if (d.bills === false) hidden.push('bills');
  // The money set has one key, "bills" (the only Bills checkbox); a stored "spending" reads as it.
  return {
    hiddenApps: [...new Set(hidden.map((a) => (a === 'spending' ? 'bills' : a)))].slice(0, 30),
    todos: flag('todos'),
    healthDetail: flag('healthDetail'),
    done: flag('done'),
  };
}

/** The stored document for settings, as the rules accept it. Write it as a full `set` (no merge) so a legacy `bills` field is dropped. */
export function calendarSettingsDoc(settings: CalendarSettings, by: string, now = Date.now()) {
  const s = toCalendarSettings(settings);
  return { ...s, updatedAt: now, by: by.trim().toLowerCase() };
}

// ---- Marking events made by the export ----

/**
 * The private extended property every event Huishouden writes to a Google calendar carries:
 * `'<household>:<key>'`. The calendar import (`./calendar`) skips events that have it, so nothing
 * exported comes back as a suggestion.
 */
export const EXPORT_PROPERTY = 'huishouden';

export const exportMark = (householdId: string, key: string): string => `${householdId}:${key}`.slice(0, 1000);

/**
 * Whether a calendar event came from Huishouden's export: written by the Google sync (its private
 * `huishouden` property) or read from the subscribed feed (an iCalendar UID ending "@huishouden").
 */
export function isExportedEvent(e: { extendedProperties?: { private?: Record<string, string> }; iCalUID?: string } | null | undefined): boolean {
  return typeof e?.extendedProperties?.private?.[EXPORT_PROPERTY] === 'string' || (typeof e?.iCalUID === 'string' && e.iCalUID.endsWith('@huishouden'));
}

// ---- The model ----

export interface ExportInput {
  /** The shared agenda items and personal items the person can read. */
  agenda: readonly AgendaItem[];
  /** To-dos the person can read; only open ones with a due day are used. */
  todos?: readonly TodoItem[];
  /** Lowercase email. */
  me: string;
  role: Role;
  lang: Lang;
  /** IANA zone the calendar is in. */
  timeZone: string;
  settings: CalendarSettings;
  /**
   * The household's home address (`households/{id}.home.address`): the LOCATION of things that
   * happen at home (`AT_HOME_APPS`: a lawn visit, the plumber, garbage day), so a calendar can map
   * them and a sitter knows where.
   */
  home?: string;
}

/** Apps whose agenda items happen at the household's home. */
export const AT_HOME_APPS: readonly string[] = ['home'];

const locationOf = (app: string, input: Pick<ExportInput, 'home'>) => (input.home?.trim() && AT_HOME_APPS.includes(app) ? { location: input.home.trim() } : {});

export interface ExportSeries {
  rule: EventRule;
  time?: Hhmm;
  minutes: number;
  /** DTSTART's day: the rule's first occurrence. */
  first: Ymd;
  /** Days the schedule puts an occurrence on that won't happen. */
  exdates: Ymd[];
  /** Moved occurrences, each with `original`. */
  overrides: ExportEvent[];
}

export interface ExportEvent {
  /** The same for the same thing in every run: `app|ref`, or `app|ref|start` when a record has several items; `todo|app|ref` for a to-do. */
  key: string;
  app: string;
  ref: string;
  kind: AgendaKind | 'todo';
  title: string;
  description: string;
  url: string;
  /** Where it happens: the home's address for things at home. */
  location?: string;
  allDay: boolean;
  /** All day: the first day and the day after the last. */
  startDate?: Ymd;
  endDate?: Ymd;
  /** Absolute; all-day events start at midnight in the calendar's zone. */
  start: number;
  end: number;
  status?: AgendaStatus;
  /** A reminder this many minutes before (0: at the start), for things to do by a time. */
  alarmMinutes?: number;
  updatedAt: number;
  series?: ExportSeries;
  /** On an override: the day the schedule put it on. */
  original?: Ymd;
  /** The agenda items it stands for (several for a series), or the to-do. */
  items: AgendaItem[];
  todo?: TodoItem;
  /** Changes whenever anything a calendar shows changes. */
  hash: string;
}

/** A short, stable, non-cryptographic hash (cyrb53) as hex, for noticing changes. */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const RESTRICTED: readonly Role[] = ['helper', 'kid'];
const SHORT_KINDS: readonly string[] = ['task', 'medicine', 'feeding'];
const MINUTE = 60_000;

/** Whether the person may and wants to see the item: the rules' view again, then their settings. */
export function visibleTo(item: Pick<AgendaItem, 'app' | 'kind' | 'private' | 'audience' | 'status'>, { me, role, settings }: Pick<ExportInput, 'me' | 'role' | 'settings'>): boolean {
  const email = me.trim().toLowerCase();
  if (item.audience && !item.audience.includes(email)) return false;
  if (RESTRICTED.includes(role) && (item.private !== false || MONEY_APPS.includes(item.app))) return false;
  // Spending and Bills are one money set: hiding either hides both.
  if (settings.hiddenApps.includes(item.app) || (MONEY_APPS.includes(item.app) && MONEY_APPS.some((a) => settings.hiddenApps.includes(a)))) return false;
  if (!settings.done && item.status === 'done') return false;
  return true;
}

const textIn = (item: Pick<AgendaItem, 'title' | 'detail' | 'texts'>, lang: Lang) => ({
  title: item.texts?.[lang]?.title ?? item.title,
  detail: item.texts?.[lang]?.detail ?? item.detail,
});

/** What the event says: Health's without detail unless asked for; a done thing ticked. */
function words(item: AgendaItem, input: ExportInput): { title: string; description: string } {
  const { title, detail } = textIn(item, input.lang);
  if (item.app === 'health' && !input.settings.healthDetail) {
    const who = item.who ?? '';
    const generic = item.kind === 'medicine' ? kt('calendarExport.medicineFor', { who }) : item.kind === 'appointment' ? kt('calendarExport.appointmentFor', { who }) : kt('calendarExport.healthFor', { who });
    return { title: who ? generic : kt('calendarExport.health'), description: item.url };
  }
  const shown = item.status === 'done' ? kt('calendarExport.done', { title }) : title;
  // Health's detail for the person's own calendar (medicine names), only when they asked for it.
  const full = item.app === 'health' && input.settings.healthDetail ? item.calendarDetail : undefined;
  return { title: shown, description: [detail, full, item.url].filter(Boolean).join('\n\n') };
}

function times(item: Pick<AgendaItem, 'start' | 'end' | 'allDay' | 'kind'>, timeZone: string) {
  if (item.allDay) {
    const startDate = allDayOf(item.start, timeZone);
    const last = item.end !== undefined ? allDayOf(item.end, timeZone) : addDays(startDate, 1);
    const endDate = last > startDate ? last : addDays(startDate, 1);
    return { allDay: true, startDate, endDate, start: zonedTime(startDate, undefined, timeZone), end: zonedTime(endDate, undefined, timeZone) };
  }
  const end = item.end !== undefined && item.end > item.start ? item.end : item.start + (SHORT_KINDS.includes(item.kind) ? 15 : 60) * MINUTE;
  return { allDay: false, start: item.start, end };
}

const hashOf = (e: Omit<ExportEvent, 'hash' | 'items' | 'todo' | 'updatedAt'>) =>
  contentHash(JSON.stringify([e.title, e.description, e.url, e.allDay, e.startDate, e.endDate, e.start, e.end, e.alarmMinutes ?? null, e.series ? [e.series.rule, e.series.time ?? null, e.series.minutes, e.series.first, e.series.exdates, e.series.overrides.map((o) => o.hash)] : null, e.original ?? null, ...(e.location ? [e.location] : [])]));

function single(item: AgendaItem, key: string, input: ExportInput): ExportEvent {
  const { title, description } = words(item, input);
  const when = times(item, input.timeZone);
  const alarmMinutes = item.kind === 'task' && !when.allDay && item.status !== 'done' ? 0 : undefined;
  const base = {
    key,
    app: item.app,
    ref: item.ref,
    kind: item.kind,
    title,
    description,
    url: item.url,
    ...locationOf(item.app, input),
    ...when,
    ...(item.status ? { status: item.status } : {}),
    ...(alarmMinutes !== undefined ? { alarmMinutes } : {}),
  };
  return { ...base, updatedAt: item.updatedAt, items: [item], hash: hashOf(base) };
}

/** The occurrence's day and time as the schedule has it, in the calendar's zone. */
function occursAt(item: AgendaItem, timeZone: string): { date: Ymd; time?: Hhmm } {
  return item.allDay ? { date: allDayOf(item.start, timeZone) } : { date: dayIn(item.start, timeZone), time: clockIn(item.start, timeZone) };
}

function seriesEvent(items: AgendaItem[], key: string, input: ExportInput): ExportEvent | null {
  const latest = [...items].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const s = latest.series as AgendaSeries;
  const rule = s.rule;
  const first = firstOccurrence(rule);
  if (!first) return null;
  const minutes = s.minutes ?? SERIES_DEFAULT_MINUTES;
  const tz = input.timeZone;
  const byOriginal = new Map<Ymd, AgendaItem>();
  for (const i of items) if (i.series && isYmd(i.series.original)) byOriginal.set(i.series.original, i);
  const through = s.through;
  // Days the app published through, with no item: skipped. The window starts at the earliest day an
  // item happens on (an occurrence moved from a past day to a later one still names its past day,
  // which says nothing about the days between); before it nothing is known, so those days stand as
  // the schedule says.
  const firstShown = items.map((i) => occursAt(i, input.timeZone).date).sort()[0];
  const exdates = firstShown ? ruleOccurrences(rule, firstShown, through).filter((d) => !byOriginal.has(d)) : [];
  const plain = items.find((i) => {
    const at = occursAt(i, tz);
    return at.date === i.series!.original && (at.time ?? '') === (s.time ?? '');
  }) ?? latest;
  const { title, description } = words(plain, input);
  const start = s.time ? zonedTime(first, s.time, tz) : zonedTime(first, undefined, tz);
  const end = s.time ? start + minutes * MINUTE : zonedTime(addDays(first, 1), undefined, tz);
  const overrides: ExportEvent[] = [];
  for (const [original, item] of byOriginal) {
    const at = occursAt(item, tz);
    const moved = at.date !== original || (at.time ?? '') !== (s.time ?? '') || item.allDay !== !s.time;
    if (!moved) continue;
    const o = single(item, key, input);
    const { items: _i, updatedAt: _u, hash: _h, ...rest } = o;
    const withOriginal = { ...rest, original };
    overrides.push({ ...withOriginal, items: [item], updatedAt: item.updatedAt, hash: hashOf(withOriginal) });
  }
  overrides.sort((a, b) => (a.original! < b.original! ? -1 : 1));
  const series: ExportSeries = { rule, ...(s.time ? { time: s.time } : {}), minutes, first, exdates, overrides };
  const base = {
    key,
    app: latest.app,
    ref: latest.ref,
    kind: latest.kind,
    title,
    description,
    url: latest.url,
    ...locationOf(latest.app, input),
    allDay: !s.time,
    ...(s.time ? {} : { startDate: first, endDate: addDays(first, 1) }),
    start,
    end,
    series,
  };
  return { ...base, updatedAt: Math.max(...items.map((i) => i.updatedAt)), items, hash: hashOf(base) };
}

function todoEvent(todo: TodoItem, input: ExportInput): ExportEvent {
  const startDate = allDayOf(todo.due!, input.timeZone);
  const endDate = addDays(startDate, 1);
  const title = todo.texts?.[input.lang]?.title ?? todo.title;
  const detail = todo.texts?.[input.lang]?.detail ?? todo.detail;
  const base = {
    key: `todo|${todo.app}|${todo.ref}`,
    app: todo.app,
    ref: todo.ref,
    kind: 'todo' as const,
    title: kt('calendarExport.todo', { title }),
    description: [detail, todo.url].filter(Boolean).join('\n\n'),
    url: todo.url,
    allDay: true,
    startDate,
    endDate,
    start: zonedTime(startDate, undefined, input.timeZone),
    end: zonedTime(endDate, undefined, input.timeZone),
  };
  return { ...base, updatedAt: todo.updatedAt, items: [], todo, hash: hashOf(base) };
}

/**
 * Everything the person's calendar shows, in their language, soonest first. Call `loadExportLang`
 * once first on a server (the words come from the kit's catalogues).
 */
export function exportEvents(input: ExportInput): ExportEvent[] {
  return withLang(input.lang, () => {
    const groups = new Map<string, AgendaItem[]>();
    for (const item of input.agenda) {
      if (!visibleTo(item, input)) continue;
      const k = `${item.app}|${item.ref}`;
      groups.set(k, [...(groups.get(k) ?? []), item]);
    }
    const out: ExportEvent[] = [];
    for (const [k, items] of groups) {
      const inSeries = items.filter((i) => i.series);
      if (inSeries.length) {
        const e = seriesEvent(inSeries, k, input);
        if (e) out.push(e);
      }
      const rest = items.filter((i) => !i.series).sort((a, b) => a.start - b.start);
      for (const item of rest) out.push(single(item, rest.length === 1 && !inSeries.length ? k : `${k}|${item.start}`, input));
    }
    if (input.settings.todos) {
      for (const todo of input.todos ?? []) {
        if (todo.status !== 'open' || todo.due === undefined) continue;
        if (groups.has(`${todo.app}|${todo.ref}`)) continue;
        if (!visibleTo({ app: todo.app, kind: 'task', private: todo.private, audience: todo.audience }, input)) continue;
        out.push(todoEvent(todo, input));
      }
    }
    return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  });
}

/** Loads the words the export uses in `lang` (on a server, before `exportEvents`). */
export const loadExportLang = (lang: Lang): Promise<void> => loadLang(lang);

// ---- iCalendar ----

/** The UID of an event in a household's feed: stable for its key. */
export const exportUid = (householdId: string, key: string): string => `${contentHash(`${householdId}|${key}`)}-${contentHash(key)}@huishouden`;

/** 2026-01-01: SEQUENCE counts seconds since then, so it only grows as items change. */
const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);
const sequenceOf = (updatedAt: number) => Math.max(0, Math.floor((updatedAt - SEQUENCE_EPOCH) / 1000));

/** The RRULE and EXDATE values for a series, in the calendar's zone (shared by the feed and Google). */
export function seriesRecurrence(series: ExportSeries, timeZone: string): { rrule: string; exdates: (Ymd | number)[] } {
  const last = series.time ? lastOccurrence(series.rule) : null;
  const rrule = ruleToRrule(series.rule, last && series.time ? { untilUtc: zonedTime(last, series.time, timeZone) } : {});
  const exdates = series.exdates.map((d) => (series.time ? zonedTime(d, series.time, timeZone) : d));
  return { rrule, exdates };
}

/** The original occurrence an override replaces (RECURRENCE-ID): its day, or its usual start. */
export const recurrenceIdOf = (series: ExportSeries, original: Ymd, timeZone: string): Ymd | number => (series.time ? zonedTime(original, series.time, timeZone) : original);

function icsWhen(e: Pick<ExportEvent, 'allDay' | 'startDate' | 'endDate' | 'start' | 'end'>) {
  return e.allDay ? { start: { date: e.startDate! }, end: { date: e.endDate! } } : { start: { at: e.start }, end: { at: e.end } };
}

/** The VEVENTs for export events: one per event, plus one per moved occurrence of a series. */
export function toIcsEvents(events: readonly ExportEvent[], { householdId, timeZone, lang = 'en' }: { householdId: string; timeZone: string; lang?: Lang }): IcsEvent[] {
  return withLang(lang, () =>
    events.flatMap((e) => {
      const uid = exportUid(householdId, e.key);
      const common = (x: ExportEvent): IcsEvent => ({
        uid,
        summary: x.title,
        description: x.description,
        url: x.url,
        ...(x.location ? { location: x.location } : {}),
        ...icsWhen(x),
        sequence: sequenceOf(x.updatedAt),
        lastModified: x.updatedAt,
        ...(x.kind === 'task' || x.kind === 'todo' || x.kind === 'due' ? { transparent: true } : {}),
        ...(x.alarmMinutes !== undefined ? { alarms: [{ minutesBefore: x.alarmMinutes, description: x.title }] } : {}),
        x: { 'X-HUISHOUDEN-APP': x.app },
      });
      const master = common(e);
      if (!e.series) return [master];
      const { rrule, exdates } = seriesRecurrence(e.series, timeZone);
      return [
        { ...master, rrule, ...(exdates.length ? { exdates } : {}) },
        ...e.series.overrides.map((o) => ({ ...common(o), recurrenceId: recurrenceIdOf(e.series!, o.original!, timeZone) })),
      ];
    }),
  );
}

export interface ExportIcsOptions {
  householdId: string;
  timeZone: string;
  lang: Lang;
  now: number;
  /** The calendar's name; default "Huishouden". */
  name?: string;
}

/** The person's whole calendar as iCalendar text: their subscribed feed. */
export function exportIcs(events: readonly ExportEvent[], { householdId, timeZone, lang, now, name = 'Huishouden' }: ExportIcsOptions): string {
  return withLang(lang, () =>
    icsCalendar({ name, description: kt('calendarExport.description'), timeZone, events: toIcsEvents(events, { householdId, timeZone, lang }), now, refreshMinutes: 60, lang }),
  );
}

// ---- One item: "Add to calendar" ----

/** One thing to put in a calendar: an agenda entry as an app builds it. */
export interface CalendarEntry {
  title: string;
  start: number;
  end?: number;
  allDay: boolean;
  detail?: string;
  /** Where: an address or place name. */
  location?: string;
  /** Deep link back to the record. */
  url?: string;
  kind?: AgendaKind;
  /** For something on a schedule: the whole series goes in, repeating. */
  series?: Pick<AgendaSeries, 'rule' | 'time' | 'minutes'>;
}

const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** The entry as an export event in `timeZone` (the device's by default). */
function entryEvent(entry: CalendarEntry, timeZone: string): Omit<ExportEvent, 'key' | 'app' | 'ref' | 'items' | 'hash' | 'updatedAt'> {
  const description = [entry.detail, entry.url].filter(Boolean).join('\n\n');
  if (entry.series) {
    const first = firstOccurrence(entry.series.rule);
    if (first) {
      const minutes = entry.series.minutes ?? SERIES_DEFAULT_MINUTES;
      const time = entry.series.time;
      const start = zonedTime(first, time, timeZone);
      const series: ExportSeries = { rule: entry.series.rule, ...(time ? { time } : {}), minutes, first, exdates: [], overrides: [] };
      return {
        kind: entry.kind ?? 'other',
        title: entry.title,
        description,
        url: entry.url ?? '',
        allDay: !time,
        ...(time ? {} : { startDate: first, endDate: addDays(first, 1) }),
        start,
        end: time ? start + minutes * MINUTE : zonedTime(addDays(first, 1), undefined, timeZone),
        series,
      };
    }
  }
  return { kind: entry.kind ?? 'other', title: entry.title, description, url: entry.url ?? '', ...times({ ...entry, kind: entry.kind ?? 'other' }, timeZone) };
}

/** A one-event .ics file (METHOD:PUBLISH) for Apple Calendar, Outlook and others; a series repeats. */
export function addToCalendarIcs(entry: CalendarEntry, { timeZone = deviceZone(), now = Date.now(), uid }: { timeZone?: string; now?: number; uid?: string } = {}): string {
  const e = entryEvent(entry, timeZone);
  const recurrence = e.series ? seriesRecurrence(e.series, timeZone) : null;
  const event: IcsEvent = {
    uid: uid ?? `${contentHash(`${entry.title}|${entry.start}|${entry.url ?? ''}`)}@huishouden`,
    summary: e.title,
    ...(e.description ? { description: e.description } : {}),
    ...(entry.location ? { location: entry.location } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...icsWhen(e),
    ...(recurrence ? { rrule: recurrence.rrule } : {}),
    sequence: 0,
  };
  return icsCalendar({ name: entry.title, timeZone, events: [event], now, method: 'PUBLISH' });
}

/**
 * Google Calendar's "add this event" page for the entry (`calendar.google.com/calendar/render?action=TEMPLATE`):
 * dates in the entry's zone, the series' RRULE as `recur`, the detail and link as its notes.
 */
export function googleTemplateUrl(entry: CalendarEntry, { timeZone = deviceZone() }: { timeZone?: string } = {}): string {
  const e = entryEvent(entry, timeZone);
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', e.title);
  url.searchParams.set('dates', e.allDay ? `${icsDate(e.startDate!)}/${icsDate(e.endDate!)}` : `${icsLocal(e.start, timeZone)}/${icsLocal(e.end, timeZone)}`);
  if (!e.allDay) url.searchParams.set('ctz', timeZone);
  if (e.description) url.searchParams.set('details', e.description);
  if (entry.location) url.searchParams.set('location', entry.location);
  if (e.series) url.searchParams.set('recur', `RRULE:${seriesRecurrence(e.series, timeZone).rrule}`);
  return url.href;
}
