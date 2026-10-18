/**
 * Calendar days and the words for them. Pure: nothing reads the clock, every function takes `now`
 * (ms) or `today` (a `Ymd`), so tests pin them and a demo can run on a fixed day.
 *
 * Two representations, both local time:
 * - a moment, ms since the epoch (`number`): when something happened;
 * - a calendar day, `'YYYY-MM-DD'` (`Ymd`): when something is due. Day arithmetic on these is exact
 *   (no DST or time-zone drift) and month arithmetic clamps to the month's last day.
 * `addDays`, `addMonths` and `daysBetween` take either and give back the same kind.
 */

import { capitalize, formatNumber, getLocale, kt, numberFormat } from './i18n.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 'YYYY-MM-DD', a local calendar day. */
export type Ymd = string;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' to its parts, or null when malformed or not a real day (2031-02-30). */
export function ymdParts(s: string | undefined | null): { y: number; m: number; d: number } | null {
  const match = typeof s === 'string' ? YMD.exec(s) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export const isYmd = (s: unknown): s is Ymd => typeof s === 'string' && ymdParts(s) !== null;

export const ymd = (y: number, m: number, d: number): Ymd =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The local day containing a moment. */
export function toYmd(t: number): Ymd {
  const date = new Date(t);
  return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** 'YYYY-MM-DD' to local midnight, or null when malformed or not a real day. */
export function parseYmd(s: string | undefined | null): number | null {
  const p = ymdParts(s);
  return p ? new Date(p.y, p.m - 1, p.d).getTime() : null;
}

/** Local midnight of a calendar day; throws on anything that isn't one. */
export function ymdToTime(s: Ymd): number {
  const t = parseYmd(s);
  if (t === null) throw new Error(`Not a date: ${s}`);
  return t;
}

/** Local midnight at the start of the day containing `t`. */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Day number since 1970-01-01, ignoring time zones and DST: exact day arithmetic. */
function dayNumber(s: Ymd): number {
  const p = ymdParts(s);
  if (!p) throw new Error(`Not a date: ${s}`);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY);
}

function fromDayNumber(n: number): Ymd {
  const d = new Date(n * DAY);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** `days` calendar days later: a `Ymd` stays a `Ymd`; a moment becomes local midnight of that day (DST-safe). */
export function addDays(s: Ymd, days: number): Ymd;
export function addDays(t: number, days: number): number;
export function addDays(at: Ymd | number, days: number): Ymd | number {
  if (typeof at === 'string') return fromDayNumber(dayNumber(at) + days);
  const d = new Date(startOfDay(at));
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * The same day `months` later (or earlier), clamped to the month's last day: 31 January plus one
 * month is 28 or 29 February. `day` keeps an intended day of month for later steps (the 31st).
 * A moment gives local midnight of the resulting day.
 */
export function addMonths(s: Ymd, months: number, day?: number): Ymd;
export function addMonths(t: number, months: number, day?: number): number;
export function addMonths(at: Ymd | number, months: number, day?: number): Ymd | number {
  const s = typeof at === 'string' ? at : toYmd(at);
  const p = ymdParts(s);
  if (!p) throw new Error(`Not a date: ${s}`);
  const index = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  const out = ymd(y, m, Math.min(day ?? p.d, daysInMonth(y, m)));
  return typeof at === 'string' ? out : ymdToTime(out);
}

/** Whole calendar days from `from` to `to`, negative when `to` is earlier. Moments count by the day they fall on. */
export function daysBetween(from: Ymd | number, to: Ymd | number): number {
  const day = (x: Ymd | number) => (typeof x === 'string' ? dayNumber(x) : dayNumber(toYmd(x)));
  return day(to) - day(from);
}

/** Calendar days from now to a day or moment; negative once it has passed. */
export const daysUntil = (due: Ymd | number, now: number): number => daysBetween(now, due);

/** 0 = Sunday. */
export const weekday = (s: Ymd): number => new Date(dayNumber(s) * DAY).getUTCDay();

/** English month names. Kit text uses `monthName` (the active locale); kept for callers that parse English. */
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** English weekday names, 0 = Sunday. Kit text uses `weekdayName`. */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** A cached `Intl.DateTimeFormat` in the active locale (or `locale`). */
export function dateFormat(options: Intl.DateTimeFormatOptions, locale: string = getLocale()): Intl.DateTimeFormat {
  // The zone's January and July offsets in the key: a formatter keeps the zone it was made in.
  const key = `${locale}|${new Date(0).getTimezoneOffset()}|${new Date(15_638_400_000).getTimezoneOffset()}|${JSON.stringify(options)}`;
  let f = dateFormats.get(key);
  if (!f) dateFormats.set(key, (f = new Intl.DateTimeFormat(locale, options)));
  return f;
}

// ICU puts a narrow no-break space before AM/PM; plain spaces keep text searchable and tests simple.
const tidy = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');

/** A day's local noon, so no time zone moves it to the next or previous day. */
const noonOf = (s: Ymd) => {
  const p = ymdParts(s)!;
  return new Date(p.y, p.m - 1, p.d, 12);
};

/** Month 1-12 in the active locale: "November", "noviembre", "november"; `short`: "Nov", "nov", "nov". */
export function monthName(m: number, { short = false, locale = getLocale() }: { short?: boolean; locale?: string } = {}): string {
  return dateFormat({ month: short ? 'short' : 'long' }, locale).format(new Date(2000, m - 1, 15));
}

/** Weekday 0-6 (0 = Sunday) in the active locale: "Friday", "viernes", "vrijdag"; `short`: "Fri". */
export function weekdayName(day: number, { short = false, locale = getLocale() }: { short?: boolean; locale?: string } = {}): string {
  // 2000-01-02 was a Sunday.
  return dateFormat({ weekday: short ? 'short' : 'long' }, locale).format(new Date(2000, 0, 2 + day, 12));
}

/** "1st", "2nd", "23rd" (English); "1.º" (Spanish); "1e" (Dutch): a day of the month as a rank. */
export function ordinal(n: number): string {
  return kt('time.ordinal', { n });
}

const unit = (n: number, u: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year') =>
  tidy(numberFormat({ style: 'unit', unit: u, unitDisplay: 'long' }, getLocale()).format(n));

// ---- Durations: how long, from a number of milliseconds ----

/** "35m", "1h", "2h 10m", "1d 3h" (Spanish "2 h 10 min", Dutch "2 u 10 min"). Rounds down to the minute; under a minute is "0m". */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / MINUTE));
  const d = Math.floor(totalMin / (24 * 60));
  const h = Math.floor((totalMin % (24 * 60)) / 60);
  const m = totalMin % 60;
  if (d > 0) return h ? kt('time.durationDH', { d, h }) : kt('time.durationD', { d });
  if (h > 0) return m ? kt('time.durationHM', { h, m }) : kt('time.durationH', { h });
  return kt('time.durationM', { m });
}

/** "just now" under a minute, otherwise "2h 10m ago". */
export function formatAgo(at: number, now: number): string {
  const ms = now - at;
  if (ms < MINUTE) return kt('time.justNow');
  return kt('time.ago', { span: formatDuration(ms) });
}

/** Hours with one decimal, for totals: "9.5 h" ("9,5 h"). */
export function formatHours(ms: number): string {
  const h = Math.round((ms / HOUR) * 10) / 10;
  return kt('time.hoursTotal', { h: formatNumber(h, getLocale(), { maximumFractionDigits: 1 }) });
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago": the long form, to the nearest unit. */
export function agoWords(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return kt('time.justNow');
  if (ms < HOUR) return kt('time.ago', { span: unit(Math.round(ms / MINUTE), 'minute') });
  if (ms < DAY) return kt('time.ago', { span: unit(Math.round(ms / HOUR), 'hour') });
  return kt('time.ago', { span: unit(Math.round(ms / DAY), 'day') });
}

// ---- Spans: a number of calendar days in the unit a person would say ----

export interface SpanOptions {
  /** Say days up to this many (default 13: "13 days", then "2 weeks"). */
  daysUpTo?: number;
  /**
   * Months rounded `down` (default: "3 weeks" never means 20 days, weeks run to 60 days so it
   * never says "1 month") or to the `nearest` month (weeks under 60 days, then at least 2 months).
   */
  months?: 'down' | 'nearest';
}

/**
 * "5 days", "3 weeks", "4 months", "2 years" in the active locale ("3 semanas", "3 weken"). The
 * sign is ignored: callers say "in" or "ago". Days under two weeks, weeks under two months, months
 * under two years, then whole years.
 */
export function formatSpan(days: number, { daysUpTo = 13, months = 'down' }: SpanOptions = {}): string {
  const n = Math.abs(Math.trunc(days));
  if (n <= daysUpTo) return unit(n, 'day');
  if (n < (months === 'down' ? 61 : 60)) return unit(Math.floor(n / 7), 'week');
  if (n < 730) return unit(months === 'down' ? Math.floor(n / 30.44) : Math.max(2, Math.round(n / 30.44)), 'month');
  return unit(Math.floor(n / 365.25), 'year');
}

/** "today", "tomorrow", "in 12 days", "in 3 weeks". */
export function inDays(days: number, options?: SpanOptions): string {
  if (days === 0) return kt('time.today');
  if (days === 1) return kt('time.tomorrow');
  return kt('time.inSpan', { span: formatSpan(days, options) });
}

/** "today", "yesterday", "4 days ago", "2 months ago". */
export function daysAgo(days: number, options?: SpanOptions): string {
  if (days === 0) return kt('time.today');
  if (days === 1) return kt('time.yesterday');
  return kt('time.ago', { span: formatSpan(days, options) });
}

/** "Today", "Tomorrow", "In 5 days", "Yesterday", "12 days ago", by calendar day. */
export function relativeDay(t: number, now: number): string {
  const d = daysBetween(now, t);
  if (d === 0) return capitalize(kt('time.today'));
  if (d === 1) return capitalize(kt('time.tomorrow'));
  if (d === -1) return capitalize(kt('time.yesterday'));
  return capitalize(d > 0 ? kt('time.inSpan', { span: unit(d, 'day') }) : kt('time.ago', { span: unit(-d, 'day') }));
}

// ---- Due dates ----

export type DueState = 'overdue' | 'today' | 'soon' | 'later';

/** Within this many days something counts as "due soon" unless the caller says otherwise. */
export const SOON_DAYS = 14;

/** Where a due day stands from `today`, and how many days away it is (negative when overdue). */
export function dueState(due: Ymd, today: Ymd, soonDays = SOON_DAYS): { state: DueState; days: number } {
  const days = daysBetween(today, due);
  if (days < 0) return { state: 'overdue', days };
  if (days === 0) return { state: 'today', days };
  return { state: days <= soonDays ? 'soon' : 'later', days };
}

/** "Overdue by 5 days", "Due today", "Due tomorrow", "Due in 4 days", "Due in 3 weeks". */
export function dueText(due: Ymd, today: Ymd, options?: SpanOptions): string {
  const days = daysBetween(today, due);
  if (days < 0) return kt('time.overdueBy', { span: formatSpan(days, options) });
  if (days === 0) return kt('time.dueToday');
  if (days === 1) return kt('time.dueTomorrow');
  return kt('time.dueIn', { span: formatSpan(days, options) });
}

/** A title used mid-sentence: "Gutter cleaning" becomes "gutter cleaning"; "HVAC filter" and names that start "McX" stay. */
export function midSentence(title: string): string {
  const t = title.trim();
  if (t.length > 1 && t[1] === t[1].toLowerCase() && t[0] !== t[0].toLowerCase()) return t[0].toLowerCase() + t.slice(1);
  return t;
}

/** The glanceable line: "Overdue: gutter cleaning", "Filter change due in 4 days", "Lawn service due today". */
export function dueHeadline(title: string, due: Ymd, today: Ymd, options?: SpanOptions): string {
  const days = daysBetween(today, due);
  const t = title.trim();
  if (days < 0) return kt('time.headlineOverdue', { title: midSentence(t) });
  if (days === 0) return kt('time.headlineToday', { title: t });
  if (days === 1) return kt('time.headlineTomorrow', { title: t });
  return kt('time.headlineIn', { title: t, span: formatSpan(days, options) });
}

// ---- Dates as words, in the active locale ----

/** "Nov 4" ("4 nov"), with the year when it isn't today's year (or `today` isn't given): "Dec 2, 2030". */
export function shortDate(s: Ymd, today?: Ymd, { month = 'short' }: { month?: 'short' | 'long' } = {}): string {
  const p = ymdParts(s)!;
  const sameYear = !!today && ymdParts(today)?.y === p.y;
  return tidy(dateFormat(sameYear ? { month, day: 'numeric' } : { month, day: 'numeric', year: 'numeric' }).format(noonOf(s)));
}

/** "Tuesday, November 4" ("martes, 4 de noviembre"), with the year when it isn't today's year: "Sunday, February 1, 2032". */
export function longDate(s: Ymd, today?: Ymd): string {
  const p = ymdParts(s)!;
  const sameYear = !!today && ymdParts(today)?.y === p.y;
  const options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  return tidy(dateFormat(sameYear ? options : { ...options, year: 'numeric' }).format(noonOf(s)));
}

/** "November 2033" ("noviembre de 2033"). */
export function monthYear(s: Ymd): string {
  return tidy(dateFormat({ month: 'long', year: 'numeric' }).format(noonOf(s)));
}

/**
 * A due day as a list shows it: "Today", "Tomorrow", "Yesterday", "Friday" (this week), "May 30",
 * "Jan 4, 2032". `inline` for mid-sentence: "today", "tomorrow", and weekdays as the language writes
 * them ("Friday", "viernes", "vrijdag").
 */
export function dueWords(due: Ymd, today: Ymd, { inline = false }: { inline?: boolean } = {}): string {
  const n = daysBetween(today, due);
  const cap = inline ? (s: string) => s : capitalize;
  if (n === 0) return cap(kt('time.today'));
  if (n === 1) return cap(kt('time.tomorrow'));
  if (n === -1) return cap(kt('time.yesterday'));
  if (n > 1 && n < 7) return cap(weekdayName(weekday(due)));
  return shortDate(due, today);
}

// ---- Moments in the active locale, and form inputs ----

/** "7:30 PM" ("7:30 p.m.", "19:30"): 12 or 24 hours as the locale says. */
export const formatTime = (t: number, locale: string = getLocale()) => tidy(dateFormat({ hour: 'numeric', minute: '2-digit' }, locale).format(t));
/** "Tuesday, November 4". */
export const formatDayLong = (t: number, locale: string = getLocale()) => tidy(dateFormat({ weekday: 'long', day: 'numeric', month: 'long' }, locale).format(t));
/** "Tuesday, November 4, 2031". */
export const formatDateLong = (t: number, locale: string = getLocale()) =>
  tidy(dateFormat({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, locale).format(t));
/** "Tue, Nov 4" ("mar, 4 nov", "di 4 nov"). */
export const formatDayShort = (t: number, locale: string = getLocale()) => tidy(dateFormat({ weekday: 'short', day: 'numeric', month: 'short' }, locale).format(t));
/** "Nov". */
export const monthShort = (t: number, locale: string = getLocale()) => tidy(dateFormat({ month: 'short' }, locale).format(t));
/** "Tue" ("mar", "di"). */
export const weekdayShort = (t: number, locale: string = getLocale()) => tidy(dateFormat({ weekday: 'short' }, locale).format(t));

/** A calendar day in the active locale: "Apr 22, 2031", "22 abr 2031", "22 apr 2031". */
export const formatYmd = (s: Ymd, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }, locale: string = getLocale()) =>
  tidy(dateFormat(options, locale).format(noonOf(s)));

/** Value for <input type="datetime-local">, in local time. */
export function toLocalInput(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** An <input type="datetime-local"> value back to a moment; null when empty or malformed. */
export function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : Math.round(t);
}

// ---- Times of day: 'HH:MM', 24-hour, local ----

/** 'HH:MM', 24-hour local time of day: '07:00', '19:30'. */
export type Hhmm = string;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isHhmm = (s: unknown): s is Hhmm => typeof s === 'string' && HHMM.test(s);

/** Minutes after midnight of an 'HH:MM'; throws on anything else. */
export function hhmmMinutes(s: Hhmm): number {
  const m = HHMM.exec(s);
  if (!m) throw new Error(`Not a time: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * A day at a time of day, local, as a moment: 19:00 on the day the clocks change is still 19:00 on
 * the wall. Without a time, local midnight. On the one hour a spring-forward day skips, the moment
 * after the gap (02:30 becomes 03:30).
 */
export function atTime(day: Ymd, time?: Hhmm): number {
  const p = ymdParts(day);
  if (!p) throw new Error(`Not a date: ${day}`);
  if (time === undefined) return new Date(p.y, p.m - 1, p.d).getTime();
  const min = hhmmMinutes(time);
  return new Date(p.y, p.m - 1, p.d, Math.floor(min / 60), min % 60).getTime();
}

/** The local 'HH:MM' of a moment. */
export function toHhmm(t: number): Hhmm {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "at 7 PM", "a las 7 p.m." / "a la 1 p.m.", "om 19:00": a time of day after a verb. */
export function atClock(time: Hhmm): string {
  const words = clockWords(time);
  return kt(/^1(?!\d)/.test(words) ? 'time.atClockOne' : 'time.atClock', { time: words });
}

/** "by 7 PM", "antes de las 7 p.m." / "antes de la 1 p.m.", "vóór 19:00": a deadline. */
export function byClock(time: Hhmm): string {
  const words = clockWords(time);
  return kt(/^1(?!\d)/.test(words) ? 'time.byClockOne' : 'time.byClock', { time: words });
}

/**
 * "7 PM", "7:30 AM", "12 PM" (noon), "12 AM" (midnight) in English; "7 p.m." in Latin-American
 * Spanish; "19:00" where the locale counts 24 hours (Dutch): how a time is said on a household screen.
 */
export function clockWords(time: Hhmm, locale: string = getLocale()): string {
  const min = hhmmMinutes(time);
  const h = Math.floor(min / 60);
  const m = min % 60;
  const at = new Date(2000, 0, 1, h, m);
  const twelve = dateFormat({ hour: 'numeric' }, locale).resolvedOptions().hourCycle?.startsWith('h1') ?? false;
  // On a 24-hour clock "19" alone isn't a time; "19:00" is.
  return tidy(dateFormat(twelve && !m ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' }, locale).format(at));
}
