import { addDays, type Ymd } from './time.js';
import { reminderDoc, reminderId, type Reminder, type ReminderInput } from './reminder-core.js';
import type { ReminderSource } from './reminder-source.js';

/**
 * Huishouden Baby's settings, the part every writer must agree on: the limits of the contraction
 * timer's instructions and of the kick counter (`babyContractionSettings/main`,
 * `babyKickSettings/main`), and the daily "time for a kick count" reminder (its ref, id, source and
 * how many days ahead). Baby and the assistant's `baby_set_kick_settings` both write those
 * reminders to `reminders`; a drift here would leave the other's reminders behind or send two.
 *
 * Server-safe: no Firebase, no DOM.
 */

export const BABY_SETTINGS_LIMITS = { contractionNote: 300, kickTargetMin: 2, kickTargetMax: 50 } as const;
export const DEFAULT_KICK_TARGET = 10;

/** The kick reminder's day-ref prefix: `kicks:<YYYY-MM-DD>`. */
export const KICK_REF = 'kicks:';
/** How many days ahead the daily kick reminder is scheduled (renewed when Baby opens). */
export const KICK_REMIND_DAYS = 7;
/** A reminder time: "HH:MM", 24-hour, local. */
export const KICK_REMIND_AT = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A target Baby counts to: whole, within the limits; the default for anything else. */
export const clampKickTarget = (n: number): number =>
  Math.min(BABY_SETTINGS_LIMITS.kickTargetMax, Math.max(BABY_SETTINGS_LIMITS.kickTargetMin, Math.round(Number.isFinite(n) ? n : DEFAULT_KICK_TARGET)));

/** The ref of the kick-count reminder for a day (YYYY-MM-DD). */
export const kickReminderRef = (ymd: Ymd): string => `${KICK_REF}${ymd}`;

export const isKickReminder = (r: { ref?: unknown }): boolean => typeof r.ref === 'string' && r.ref.startsWith(KICK_REF);

/** Due until that day's first session exists, which has the day as its id: starting a count cancels it unsent. */
export const kickReminderSource = (ymd: Ymd): ReminderSource => ({ checks: [{ doc: `babyKickSessions/${ymd}`, absent: true }] });

export interface KickReminderOptions {
  /** Today on the clock the reminder time is read on. */
  today: Ymd;
  /** Absolute now: times already past are left out. */
  now: number;
  /** The absolute time of `hhmm` on day `ymd` on that clock, or null. */
  at: (ymd: Ymd, hhmm: string) => number | null;
  /** The deep link into Baby's kick counter. */
  url: string;
  /** The words, in the current language. */
  title: string;
  body: string;
  /** False on a device that may not attach a source (the kit lets only admins and members). */
  withSource?: boolean;
}

/**
 * The daily "time for a kick count" reminder at `remindAt` on each of the next `KICK_REMIND_DAYS`
 * days still to come; none without a time. Private (admins and members; kids have no kick
 * counter), to everyone's devices.
 */
export function kickReminders(remindAt: string | undefined | null, { today, now, at, url, title, body, withSource = true }: KickReminderOptions): ReminderInput[] {
  if (!remindAt || !KICK_REMIND_AT.test(remindAt)) return [];
  const out: ReminderInput[] = [];
  for (let i = 0; i < KICK_REMIND_DAYS; i++) {
    const ymd = addDays(today, i);
    const when = at(ymd, remindAt);
    if (when == null || when <= now) continue;
    out.push({
      app: 'baby',
      title,
      body,
      at: Math.round(when),
      url,
      recipients: 'all',
      ref: kickReminderRef(ymd),
      private: true,
      ...(withSource ? { source: kickReminderSource(ymd) } : {}),
    });
  }
  return out;
}

/**
 * What makes the kick reminders still to come exactly `wanted`, as Baby's sync does for all its
 * reminders: the ids to delete (kick reminders in `existing` after `now`, unsent, not wanted) and
 * the documents to set, each under its stable id. Sent and past ones, and Baby's other reminders,
 * are never touched.
 */
export function kickReminderPlan(
  existing: readonly Pick<Reminder, 'id' | 'ref' | 'at' | 'sent'>[],
  wanted: readonly ReminderInput[],
  by: string,
  now: number,
): { remove: string[]; set: [string, Omit<Reminder, 'id'>][] } {
  const set = wanted.filter((r) => r.at > now).map((r): [string, Omit<Reminder, 'id'>] => [r.id ?? reminderId(r.ref ?? r.app, Math.round(r.at)), reminderDoc(r, by, now)]);
  const keep = new Set(set.map(([id]) => id));
  const remove = existing.filter((r) => isKickReminder(r) && r.at > now && r.sent !== true && !keep.has(r.id)).map((r) => r.id);
  return { remove, set };
}
