/**
 * The day a shopping-list item is needed by ("Need by Tue"), on the household's `items`
 * (huishouden/groceries; Huishouden Tasks shares the collection). Pure and server-safe: the apps,
 * the household tools (connector, `hh data`) and the rules' tests read an item the same way.
 *
 * Stored: `needBy`, a local calendar day `'YYYY-MM-DD'` on the writer's calendar (the device's, or
 * the person's time zone in a tool), or absent / null for none. `urgency` stays, in English, for
 * older apps and tools that only know it: whoever writes `needBy` writes `urgency` as
 * `needByUrgency(needBy, today)`, 'Need Today' when the day is today or past, else 'Standard'
 * ('Whenever' is for items with no day).
 *
 * Read (`needByOf`):
 * - `needBy` is the day.
 * - 'Need Today' with no `needBy` (written before the field, or by an older app) is needed on the
 *   day it was last changed (`updatedAt`; else `createdAt`; else today), and marked `guessed`. A
 *   "Need Today" from Monday is overdue on Wednesday instead of "today" for ever.
 * - Both: the earlier of the two, so an older app turning on "Need Today" for an item dated next
 *   week makes it needed today.
 * Apps pin a guessed day when they next write the item (`pinNeedBy`), so the guess stops moving.
 */
import { addDays, daysBetween, isYmd, shortDate, toYmd, weekday, weekdayName, type Ymd } from './time.js';
import { capitalize, getLocale, kt } from './i18n.js';

/** `urgency` as stored, in English. */
export const NEED_TODAY = 'Need Today';
export const STANDARD = 'Standard';
export const WHENEVER = 'Whenever';

/** An item counts as needed soon this many days ahead (today and tomorrow and the day after). */
export const NEED_BY_SOON_DAYS = 2;

/** How many days the quick choices offer: today, tomorrow and the next weekdays by name. */
export const NEED_BY_CHOICES = 6;

/** The fields `needByOf` reads; anything else on the item is ignored. Unknown shapes are tolerated. */
export interface NeedByFields {
  needBy?: unknown;
  urgency?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
}

export interface NeedBy {
  day: Ymd;
  /** From a 'Need Today' without a stored day: the day it was last changed, not a day someone chose. */
  guessed: boolean;
}

export interface NeedByOptions {
  /** Today on the reader's calendar. */
  today: Ymd;
  /** The calendar day of a moment (ms) on the reader's calendar. Default the runtime's local day. */
  dayOf?: (t: number) => Ymd;
}

const moment = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Whether `v` is a day `needBy` may hold. */
export const isNeedBy = (v: unknown): v is Ymd => isYmd(v);

/** The day an item is needed by, or null when it has none. See the module comment for the rule. */
export function needByOf(item: NeedByFields, { today, dayOf = toYmd }: NeedByOptions): NeedBy | null {
  const stored = isNeedBy(item.needBy) ? item.needBy : null;
  if (item.urgency !== NEED_TODAY) return stored ? { day: stored, guessed: false } : null;
  const at = moment(item.updatedAt) ?? moment(item.createdAt);
  const set = at === null ? today : dayOf(at);
  if (stored && stored <= set) return { day: stored, guessed: false };
  return { day: set, guessed: true };
}

/** `urgency` to store with a day (or none: `undated`, default 'Standard'). */
export function needByUrgency(day: Ymd | null | undefined, today: Ymd, undated: string = STANDARD): string {
  if (!day) return undated === NEED_TODAY ? STANDARD : undated;
  return day <= today ? NEED_TODAY : STANDARD;
}

/**
 * What to add to a write of an item whose day was guessed, so it keeps that day: `{ needBy }`, or
 * nothing. Writes that set `needBy` themselves don't need it.
 */
export function pinNeedBy(item: NeedByFields, options: NeedByOptions): { needBy: Ymd } | Record<string, never> {
  const n = needByOf(item, options);
  return n?.guessed ? { needBy: n.day } : {};
}

export type NeedByState = 'overdue' | 'today' | 'soon' | 'later';

/** Where a day stands: past, today, within `NEED_BY_SOON_DAYS`, or later. */
export function needByState(day: Ymd, today: Ymd, soonDays = NEED_BY_SOON_DAYS): NeedByState {
  const n = daysBetween(today, day);
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  return n <= soonDays ? 'soon' : 'later';
}

/** Today or past: the item gets the list's urgent treatment. */
export const needByUrgent = (day: Ymd, today: Ymd): boolean => day <= today;

/**
 * A weekday as a need-by line writes it: short where the language's abbreviation reads clearly
 * ("Tue", "di"), the whole word in Spanish, whose "mar" (martes) reads as "sea".
 */
function weekdayWord(day: Ymd): string {
  return weekdayName(weekday(day), { short: !getLocale().startsWith('es') });
}

/** The day within the coming week by name, else the date: "Tue", "Oct 28" ("Dec 2, 2032" in another year). */
function dayWord(day: Ymd, today: Ymd): string {
  const n = Math.abs(daysBetween(today, day));
  return n < 7 ? weekdayWord(day) : shortDate(day, today);
}

/**
 * "Need today", "Need tomorrow", "Need by Tue", "Need by Oct 28"; once passed, "Overdue, needed
 * yesterday", "Overdue, needed Mon", "Overdue, needed Oct 12". In the active language.
 */
export function needByWords(day: Ymd, today: Ymd): string {
  const n = daysBetween(today, day);
  if (n === 0) return kt('needBy.today');
  if (n === 1) return kt('needBy.tomorrow');
  if (n === -1) return kt('needBy.overdueYesterday');
  if (n < 0) return kt('needBy.overdue', { day: dayWord(day, today) });
  return kt('needBy.by', { day: dayWord(day, today) });
}

/** The quick choices: today, tomorrow and the days after, `count` in all. */
export function needByChoices(today: Ymd, count = NEED_BY_CHOICES): Ymd[] {
  return Array.from({ length: count }, (_, i) => addDays(today, i));
}

/** A quick choice's label: "Today", "Tomorrow", then "Mon", "Tue" ("Lun", "Ma"). */
export function needByChoiceLabel(day: Ymd, today: Ymd): string {
  const n = daysBetween(today, day);
  if (n === 0) return capitalize(kt('time.today'));
  if (n === 1) return capitalize(kt('time.tomorrow'));
  return capitalize(weekdayName(weekday(day), { short: true }));
}
