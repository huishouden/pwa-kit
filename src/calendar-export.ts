import { SERIES_DEFAULT_MINUTES, agendaMergeGroups, mergedWords, type AgendaItem, type AgendaKind, type AgendaSeries, type AgendaStatus } from './agenda-core.js';
import { contentHash } from './hash.js';
import { mergeIdentity } from './merge.js';
import type { TodoItem } from './todo-core.js';
import { MONEY_APPS, type Role } from './role-core.js';
import { kt, loadLang, withLang, type Lang } from './i18n.js';
import { cleanRule, fitsRule, ruleOccurrences, type EventRule } from './schedule.js';
import { addDays, daysBetween, isYmd, weekday, type Hhmm, type Ymd } from './time.js';
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
  /** The agenda items it stands for (several for a series, or for things that merged), or the to-do. */
  items: AgendaItem[];
  /**
   * Things that merged (`./merge`): one event for items of several records, so a change made to it
   * in a calendar goes to each of them.
   */
  merged?: boolean;
  todo?: TodoItem;
  /** Changes whenever anything a calendar shows changes. */
  hash: string;
}

export { contentHash } from './hash.js';

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

/** Occurrences of a series by the day the schedule put them on, and the days known to be skipped. */
interface SeriesPlan {
  rule: EventRule;
  time?: Hhmm;
  minutes: number;
  through: Ymd;
  /** The day from which skipped days are known: the earliest an occurrence happens on. */
  known?: Ymd;
  /** The occurrence on its own day and time, standing as the series says. */
  plain: Set<Ymd>;
  /** Occurrences that differ from the series (moved, or with other words), by their original day. */
  overrides: Map<Ymd, ExportEvent>;
}

function seriesOf(plan: SeriesPlan, base: Omit<ExportEvent, 'series' | 'hash' | 'allDay' | 'startDate' | 'endDate' | 'start' | 'end'>, input: ExportInput): ExportEvent | null {
  const first = firstOccurrence(plan.rule);
  if (!first) return null;
  const tz = input.timeZone;
  // Days the apps published through, with no occurrence: skipped. Before the earliest day an
  // occurrence happens on nothing is known (one moved from a past day to a later one still names its
  // past day), so those days stand as the schedule says; after `through` too.
  const exdates = plan.known ? ruleOccurrences(plan.rule, plan.known, plan.through).filter((d) => !plan.plain.has(d) && !plan.overrides.has(d)) : [];
  const overrides = [...plan.overrides.entries()].map(([original, o]) => {
    const { items: _i, updatedAt: _u, hash: _h, ...rest } = o;
    const withOriginal = { ...rest, key: base.key, original };
    return { ...withOriginal, items: o.items, updatedAt: o.updatedAt, hash: hashOf(withOriginal) };
  });
  overrides.sort((a, b) => (a.original! < b.original! ? -1 : 1));
  const series: ExportSeries = { rule: plan.rule, ...(plan.time ? { time: plan.time } : {}), minutes: plan.minutes, first, exdates, overrides };
  const start = plan.time ? zonedTime(first, plan.time, tz) : zonedTime(first, undefined, tz);
  const end = plan.time ? start + plan.minutes * MINUTE : zonedTime(addDays(first, 1), undefined, tz);
  const { items, updatedAt, merged, ...words } = base;
  const head = { ...words, allDay: !plan.time, ...(plan.time ? {} : { startDate: first, endDate: addDays(first, 1) }), start, end, series };
  return { ...head, updatedAt, items, ...(merged ? { merged } : {}), hash: hashOf(head) };
}

/** Whether an occurrence is on its own day at the series' time. */
function isPlain(item: AgendaItem, tz: string, time = item.series?.time): boolean {
  const at = occursAt(item, tz);
  return !!item.series && at.date === item.series.original && (at.time ?? '') === (time ?? '') && item.allDay === !time;
}

function seriesEvent(items: AgendaItem[], key: string, input: ExportInput, rule?: EventRule, orphans: AgendaItem[] = []): ExportEvent | null {
  const latest = [...items, ...orphans].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const s = latest.series as AgendaSeries;
  const tz = input.timeZone;
  const plan: SeriesPlan = { rule: rule ?? s.rule, ...(s.time ? { time: s.time } : {}), minutes: s.minutes ?? SERIES_DEFAULT_MINUTES, through: s.through, plain: new Set(), overrides: new Map() };
  const shown = [...items, ...orphans].map((i) => occursAt(i, tz).date).sort()[0];
  if (shown) plan.known = shown;
  const plainItem = items.find((i) => isPlain(i, tz, s.time));
  for (const item of items) {
    const original = item.series!.original;
    if (!isYmd(original)) continue;
    if (isPlain(item, tz, s.time)) plan.plain.add(original);
    else plan.overrides.set(original, single(item, key, input));
  }
  const { title, description } = words(plainItem ?? latest, input);
  return seriesOf(
    plan,
    { key, app: latest.app, ref: latest.ref, kind: latest.kind, title, description, url: latest.url, ...locationOf(latest.app, input), updatedAt: Math.max(...items.map((i) => i.updatedAt)), items },
    input,
  );
}

// ---- Merging (`./merge`) ----

/**
 * For series that merge on some of their days (garbage every Monday and Thursday, recycling every
 * Monday): the schedule of the days they share, and each one's own days apart from those, so the
 * calendar shows one repeating event for the shared days and each series repeating on the rest, for
 * as long as the schedules run. Null when that can't be said as schedules: the same rule for every
 * series, or weekly rules counted the same way (the same `every` and weeks) without an end.
 */
export function splitRules(rules: readonly EventRule[]): { shared: EventRule; rest: (EventRule | null)[] } | null {
  if (rules.length < 2) return null;
  const clean = rules.map(cleanRule);
  if (clean.every((r) => JSON.stringify(r) === JSON.stringify(clean[0]))) return { shared: clean[0], rest: clean.map(() => null) };
  if (!clean.every((r) => r.freq === 'week' && !r.until && r.every === clean[0].every)) return null;
  const weekOne = (r: EventRule) => addDays(r.start, -weekday(r.start));
  if (!clean.every((r) => (((daysBetween(weekOne(clean[0]), weekOne(r)) / 7) % r.every) + r.every) % r.every === 0)) return null;
  const daysOf = (r: EventRule) => (r.days?.length ? r.days : [weekday(r.start)]);
  const sharedDays = daysOf(clean[0]).filter((d) => clean.every((r) => daysOf(r).includes(d)));
  if (!sharedDays.length) return null;
  const start = clean.map((r) => r.start).sort()[clean.length - 1];
  const shared = cleanRule({ freq: 'week', every: clean[0].every, start, days: sharedDays });
  const rest = clean.map((r) => {
    const own = daysOf(r).filter((d) => !sharedDays.includes(d));
    return own.length ? cleanRule({ freq: 'week', every: r.every, start: r.start, days: own }) : null;
  });
  return { shared, rest };
}

/** Apps whose items don't merge in a calendar: what Health's say depends on the person's detail setting. */
const UNMERGED_APPS: readonly string[] = ['health'];

/** What several members say together: the combined title, and each one's detail on its own line. */
function mergedEventWords(members: AgendaItem[], input: ExportInput): { title: string; description: string; url: string } {
  const { title } = mergedWords(members, input.lang);
  const lines = members.map((m) => {
    const own = textIn(m, input.lang);
    return own.detail ? `${own.title}: ${own.detail}` : own.title;
  });
  const url = members[0].url;
  const done = members.every((m) => m.status === 'done');
  return { title: done ? kt('calendarExport.done', { title }) : title, description: [lines.join('\n'), url].filter(Boolean).join('\n\n'), url };
}

/** One event for a merge group: its key from the merge key, the time and the readers, so members coming and going keep it. */
function mergedSingle(members: AgendaItem[], input: ExportInput, key = mergedKey(members[0], input)): ExportEvent {
  const first = members[0];
  const { title, description, url } = mergedEventWords(members, input);
  const when = times(first, input.timeZone);
  const open = members.some((m) => m.status !== 'done');
  const statuses = members.map((m) => m.status);
  const status: AgendaStatus | undefined = statuses.includes('overdue') ? 'overdue' : statuses.includes('upcoming') ? 'upcoming' : statuses.includes('done') ? 'done' : undefined;
  const alarmMinutes = first.kind === 'task' && !when.allDay && open ? 0 : undefined;
  const base = {
    key,
    app: first.app,
    ref: `merge:${first.merge!.key}`,
    kind: first.kind,
    title,
    description,
    url,
    ...locationOf(first.app, input),
    ...when,
    ...(status ? { status } : {}),
    ...(alarmMinutes !== undefined ? { alarmMinutes } : {}),
  };
  return { ...base, updatedAt: Math.max(...members.map((m) => m.updatedAt)), items: members, merged: true, hash: hashOf(base) };
}

const mergedKey = (item: AgendaItem, input: ExportInput) => {
  const when = item.allDay ? allDayOf(item.start, input.timeZone) : String(item.start);
  return `merge|${mergeIdentity(item)}|${when}|${item.end ?? ''}`;
};

/** What a whole merge group's members share, but their day: which groups make one repeating event. */
const bundleOf = (members: AgendaItem[]) => `${mergeIdentity(members[0])}|${members[0].series?.time ?? ''}|${members.map((x) => x.ref).join(',')}`;

interface MergedSeries {
  key: string;
  refs: string[];
  shared: EventRule;
  rest: Map<string, EventRule | null>;
  plan: SeriesPlan;
  members: AgendaItem[];
  /** A group the series stands for, for its words. */
  sample: AgendaItem[];
}

/**
 * Everything the calendar shows of items that merge, and what is left for each record's own
 * events: the items still shown on their own, and for a series that merges on some days, the rule
 * of its other days (null: none).
 */
function mergeForExport(visible: AgendaItem[], input: ExportInput): { events: ExportEvent[]; left: AgendaItem[]; rules: Map<string, EventRule | null>; orphans: Map<string, AgendaItem[]> } {
  const tz = input.timeZone;
  const groups = [...agendaMergeGroups(visible.filter((i) => !UNMERGED_APPS.includes(i.app))).values()];
  const used = new Set<string>();
  const events: ExportEvent[] = [];
  const rules = new Map<string, EventRule | null>();
  const latestSeries = (ref: string, app: string) => visible.filter((i) => i.app === app && i.ref === ref && i.series).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.series;

  // Groups of occurrences of series, each on its own day: one repeating event per set of series.
  const bundles = new Map<string, AgendaItem[][]>();
  for (const g of groups) {
    const time = g[0].series?.time;
    if (!g.every((m) => m.series && m.series.time === time && isPlain(m, tz) && m.series.original === g[0].series!.original)) continue;
    const k = bundleOf(g);
    bundles.set(k, [...(bundles.get(k) ?? []), g]);
  }
  const accepted: MergedSeries[] = [];
  const keys = new Set<string>();
  for (const days of [...bundles.values()].sort((a, b) => b.length - a.length)) {
    const sample = days[0];
    const refs = sample.map((m) => m.ref);
    const latest = refs.map((r) => latestSeries(r, sample[0].app)!);
    // One merged series per record: a record in two would need its days split twice.
    if (refs.some((r) => rules.has(`${sample[0].app}|${r}`))) continue;
    const split = splitRules(latest.map((s) => s.rule));
    if (!split) continue;
    const key = `merge|${mergeIdentity(sample[0])}|${ruleToRrule(split.shared)}|${latest[0].time ?? ''}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const through = latest.map((s) => s.through).sort()[0];
    const plan: SeriesPlan = { rule: split.shared, ...(latest[0].time ? { time: latest[0].time } : {}), minutes: latest[0].minutes ?? SERIES_DEFAULT_MINUTES, through, plain: new Set(), overrides: new Map() };
    const members: AgendaItem[] = [];
    for (const g of days) {
      if (!fitsRule(split.shared, g[0].series!.original) || g[0].series!.original < split.shared.start) continue;
      plan.plain.add(g[0].series!.original);
      members.push(...g);
      for (const m of g) used.add(m.id);
    }
    refs.forEach((r, i) => rules.set(`${sample[0].app}|${r}`, split.rest[i]));
    accepted.push({ key, refs, shared: split.shared, rest: new Map(refs.map((r, i) => [r, split.rest[i]])), plan, members, sample });
  }

  const seriesFor = (app: string, ref: string, original: Ymd | undefined) =>
    original ? accepted.find((a) => a.sample[0].app === app && a.refs.includes(ref) && fitsRule(a.shared, original) && original >= a.shared.start) : undefined;

  // Other groups: an occurrence of a merged series that differs (moved together: a holiday), else one event of their own.
  for (const g of groups) {
    if (g.some((m) => used.has(m.id))) continue;
    const original = g[0].series?.original;
    const into = g.every((m) => m.series?.original === original) ? seriesFor(g[0].app, g[0].ref, original) : undefined;
    if (into && original && !into.plan.plain.has(original) && !into.plan.overrides.has(original) && g.every((m) => into.refs.includes(m.ref))) {
      into.plan.overrides.set(original, mergedSingle(g, input, into.key));
      into.members.push(...g);
    } else events.push(mergedSingle(g, input));
    for (const m of g) used.add(m.id);
  }

  // Occurrences of a merged series' records on its days that didn't merge (one skipped, or moved
  // alone): an occurrence of the merged series with their own words, or their own event.
  const orphans = new Map<string, AgendaItem[]>();
  const left: AgendaItem[] = [];
  for (const item of visible) {
    if (used.has(item.id)) continue;
    const into = item.series ? seriesFor(item.app, item.ref, item.series.original) : undefined;
    if (!into) {
      left.push(item);
      continue;
    }
    const original = item.series!.original;
    if (!into.plan.plain.has(original) && !into.plan.overrides.has(original)) {
      into.plan.overrides.set(original, single(item, into.key, input));
      into.members.push(item);
    } else {
      const k = `${item.app}|${item.ref}`;
      orphans.set(k, [...(orphans.get(k) ?? []), item]);
    }
  }

  for (const a of accepted) {
    const shown = a.members.map((i) => occursAt(i, tz).date).sort()[0];
    if (shown) a.plan.known = shown;
    const { title, description, url } = mergedEventWords(a.sample, input);
    const first = a.sample[0];
    const e = seriesOf(
      a.plan,
      { key: a.key, app: first.app, ref: `merge:${first.merge!.key}`, kind: first.kind, title, description, url, ...locationOf(first.app, input), updatedAt: Math.max(...a.members.map((i) => i.updatedAt)), items: a.members, merged: true },
      input,
    );
    if (e) events.push(e);
  }
  return { events, left, rules, orphans };
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
    const visible = input.agenda.filter((item) => visibleTo(item, input));
    const records = new Set(visible.map((i) => `${i.app}|${i.ref}`));
    const merged = mergeForExport(visible, input);
    const groups = new Map<string, AgendaItem[]>();
    for (const item of merged.left) {
      const k = `${item.app}|${item.ref}`;
      groups.set(k, [...(groups.get(k) ?? []), item]);
    }
    for (const k of merged.rules.keys()) if (!groups.has(k) && merged.orphans.has(k)) groups.set(k, []);
    const out: ExportEvent[] = [...merged.events];
    for (const [k, items] of groups) {
      const inSeries = items.filter((i) => i.series);
      // A series that merges on some of its days: its other days, when it has any.
      const rule = merged.rules.get(k);
      const split = merged.rules.has(k);
      if (inSeries.length && (!split || rule)) {
        const e = seriesEvent(inSeries, k, input, rule ?? undefined);
        if (e) out.push(e);
      }
      const rest = [...items.filter((i) => !i.series || (split && !rule)), ...(merged.orphans.get(k) ?? [])].sort((a, b) => a.start - b.start);
      for (const item of rest) out.push(single(item, rest.length === 1 && !inSeries.length && !split ? k : `${k}|${item.start}`, input));
    }
    if (input.settings.todos) {
      for (const todo of input.todos ?? []) {
        if (todo.status !== 'open' || todo.due === undefined) continue;
        if (records.has(`${todo.app}|${todo.ref}`)) continue;
        if (!visibleTo({ app: todo.app, kind: 'task', private: todo.private, audience: todo.audience }, input)) continue;
        out.push(todoEvent(todo, input));
      }
    }
    return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  });
}

/**
 * The agenda in the clusters `exportEvents` needs together, for a server that exports in parts:
 * each record's items (a series is one event), joined with the records it merges with.
 */
export function exportClusters(items: readonly AgendaItem[], input: Pick<ExportInput, 'me' | 'role' | 'settings'>): AgendaItem[][] {
  const visible = items.filter((i) => visibleTo(i, input));
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const recordOf = (i: AgendaItem) => `${i.app}|${i.ref}`;
  for (const i of visible) parent.set(recordOf(i), recordOf(i));
  for (const g of agendaMergeGroups(visible.filter((i) => !UNMERGED_APPS.includes(i.app))).values()) for (const m of g.slice(1)) parent.set(find(recordOf(m)), find(recordOf(g[0])));
  const clusters = new Map<string, AgendaItem[]>();
  for (const i of visible) {
    const root = find(recordOf(i));
    clusters.set(root, [...(clusters.get(root) ?? []), i]);
  }
  return [...clusters.values()];
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
