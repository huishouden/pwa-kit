import { addDays, daysBetween, isHhmm, isYmd, type Ymd } from './time.js';
import { addInterval, occurrenceAfter, occurrenceOnOrAfter, occurrenceOnOrBefore, ruleOccurrences, type EventRule, type FixedSchedule, type Schedule, type Unit } from './schedule.js';

/**
 * Huishouden Pet's care routines (scoop the litter box, change the litter, brush the dog), the
 * part every writer must agree on: when a routine is due (`routineStatus`) and the id of the log
 * written when it is done (`routineLogId`). Pet's own buttons, the portal's To-do list (Pet
 * publishes its actions) and the assistant's `pet_routine_done` all write
 * `petRoutineLogs/<routineLogId>`, and a routine's reminder is cancelled by the sender while that
 * document is absent (`./reminder-source`), so a drift here would log a routine twice or notify
 * after it was done.
 *
 * A routine belongs to one or more pets (a household with two cats and one box) and repeats
 * three ways:
 * - `after-done`: every N days, weeks or months counted from when it was last done ("change the
 *   litter a week after the last change");
 * - `fixed`: every N days, weeks or months on the calendar from `since` ("scoop every day");
 * - `weekdays`: on set weekdays ("brush on Monday and Thursday").
 * A fixed routine that is missed is not piled up: only the latest occurrence on or before today is
 * open, the older ones count as missed.
 *
 * Server-safe: no Firebase, no DOM.
 */

export const ROUTINE_PRESETS = ['scoop', 'litter', 'brush', 'fountain', 'fishWater', 'cage'] as const;
export type RoutinePreset = (typeof ROUTINE_PRESETS)[number];
/** What a routine's `kind` may say: a preset, or `custom`. */
export const ROUTINE_KINDS = [...ROUTINE_PRESETS, 'custom'] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

export const ROUTINE_MODES = ['after-done', 'fixed', 'weekdays'] as const;
export type RoutineMode = (typeof ROUTINE_MODES)[number];
export const ROUTINE_UNITS = ['day', 'week', 'month'] as const satisfies readonly Unit[];
export type RoutineUnit = (typeof ROUTINE_UNITS)[number];

/** The sizes the rules accept. */
export const ROUTINE_LIMITS = { name: 60, pets: 8, every: 99, note: 200, petId: 128 } as const;
export const ROUTINE_DEFAULTS = { remindAt: '09:00' } as const;

/** How a preset repeats when it is picked: scoop daily, the rest weekly from the last time. */
export const ROUTINE_PRESET_SCHEDULES: Readonly<Record<RoutinePreset, { mode: RoutineMode; every: number; unit: RoutineUnit }>> = {
  scoop: { mode: 'fixed', every: 1, unit: 'day' },
  litter: { mode: 'after-done', every: 1, unit: 'week' },
  brush: { mode: 'after-done', every: 1, unit: 'week' },
  fountain: { mode: 'after-done', every: 1, unit: 'week' },
  fishWater: { mode: 'after-done', every: 1, unit: 'week' },
  cage: { mode: 'after-done', every: 1, unit: 'week' },
};

/** What `routineStatus` reads of a `petRoutines` document (`id` is its id). */
export interface RoutineLike {
  id: string;
  petIds: readonly string[];
  mode: RoutineMode;
  every?: number;
  unit?: RoutineUnit;
  /** `mode: 'weekdays'`: 0 = Sunday. */
  days?: readonly number[];
  /** The first day it is due, and the anchor of a fixed routine. */
  since: Ymd;
}

/** What `routineStatus` reads of a `petRoutineLogs` document. */
export interface RoutineLogLike {
  routineId: string;
  /** The due day this log answers. */
  due: Ymd;
  /** The day it was done (the person's local day). */
  on: Ymd;
  at?: number;
}

/** A `petRoutines` document as every reader takes it. */
export interface Routine extends RoutineLike {
  name: string;
  kind?: RoutineKind;
  remind: boolean;
  /** 'HH:MM' of the day's reminder. */
  time?: string;
}

/**
 * The routine a `petRoutines` document describes, or null when it isn't one the rules would have
 * taken (no name or pets, an unknown way of repeating, a bad schedule): Pet, the portal and the
 * assistant then all agree it isn't there, rather than reading a mode into it.
 */
export function toRoutine(id: string, data: Record<string, unknown>): Routine | null {
  /** The list when every element is valid, else undefined: nothing is silently dropped. */
  const list = <T>(v: unknown, ok: (x: unknown) => x is T): T[] | undefined => (Array.isArray(v) && v.every(ok) ? (v as T[]) : undefined);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const petIds = list(data.petIds, (x): x is string => typeof x === 'string' && x.length > 0 && x.length <= ROUTINE_LIMITS.petId) ?? [];
  const routine: Routine = {
    id,
    name,
    ...((ROUTINE_KINDS as readonly unknown[]).includes(data.kind) ? { kind: data.kind as RoutineKind } : {}),
    petIds,
    mode: data.mode as RoutineMode,
    ...(typeof data.every === 'number' ? { every: data.every } : {}),
    ...(typeof data.unit === 'string' ? { unit: data.unit as RoutineUnit } : {}),
    ...(data.days !== undefined ? { days: list(data.days, (x): x is number => typeof x === 'number') } : {}),
    since: typeof data.since === 'string' ? data.since : '',
    remind: data.remind === true,
    ...(isHhmm(data.time) ? { time: data.time } : {}),
  };
  return name && name.length <= ROUTINE_LIMITS.name && petIds.length && petIds.length <= ROUTINE_LIMITS.pets && (data.days === undefined || routine.days) && (ROUTINE_MODES as readonly unknown[]).includes(data.mode) && isRoutineSchedule(routine) ? routine : null;
}

/** The id of the log written for a routine's due day: `rtn-<routineId>-<YYYY-MM-DD>`. */
export const routineLogId = (routineId: string, due: Ymd) => `rtn-${routineId}-${due}`;

const isDay = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6;

/** Whether the routine's schedule is well formed (the rules check the same). */
export function isRoutineSchedule(r: Pick<RoutineLike, 'mode' | 'every' | 'unit' | 'days' | 'since'>): boolean {
  if (!isYmd(r.since)) return false;
  if (r.mode === 'weekdays') return Array.isArray(r.days) && r.days.length >= 1 && r.days.length <= 7 && r.days.every(isDay);
  return (r.mode === 'after-done' || r.mode === 'fixed') && Number.isInteger(r.every) && r.every! >= 1 && r.every! <= ROUTINE_LIMITS.every && (ROUTINE_UNITS as readonly string[]).includes(r.unit as string);
}

/** The kit schedule of a routine that repeats every N units (`after-done` or `fixed`), for `describeSchedule`. */
export function routineSchedule(r: Pick<RoutineLike, 'mode' | 'every' | 'unit' | 'since'>): Schedule | null {
  if (r.mode === 'weekdays' || !r.every || !r.unit) return null;
  return r.mode === 'fixed' ? { kind: 'fixed', every: r.every, unit: r.unit, anchor: r.since } : { kind: 'after-done', every: r.every, unit: r.unit };
}

/** The event rule of a weekday routine, for `describeRule`. */
export const routineRule = (r: Pick<RoutineLike, 'days' | 'since'>): EventRule => ({ freq: 'week', every: 1, start: r.since, days: [...new Set(r.days ?? [])].sort((a, b) => a - b) });

const fixedOf = (r: RoutineLike): FixedSchedule => ({ kind: 'fixed', every: r.every ?? 1, unit: r.unit ?? 'day', anchor: r.since });

/** The routine's occurrences from `from` to `to`, both included (fixed and weekday routines). */
function occurrencesBetween(r: RoutineLike, from: Ymd, to: Ymd): Ymd[] {
  if (r.mode === 'weekdays') return ruleOccurrences(routineRule(r), from, to);
  const out: Ymd[] = [];
  for (let d = occurrenceOnOrAfter(fixedOf(r), from); d <= to && out.length < 400; d = occurrenceAfter(fixedOf(r), d)) out.push(d);
  return out;
}

/** The latest occurrence on or before `day`, or null before the routine starts. */
function lastOccurrence(r: RoutineLike, day: Ymd): Ymd | null {
  if (r.mode === 'weekdays') return ruleOccurrences(routineRule(r), addDays(day, -7), day).at(-1) ?? null;
  return occurrenceOnOrBefore(fixedOf(r), day);
}

/** The first occurrence after `day`. */
function nextOccurrence(r: RoutineLike, day: Ymd): Ymd {
  if (r.mode === 'weekdays') return ruleOccurrences(routineRule(r), addDays(day, 1), addDays(day, 8))[0] ?? addDays(day, 7);
  return occurrenceOnOrAfter(fixedOf(r), addDays(day, 1));
}

export type RoutineState = 'overdue' | 'due' | 'done' | 'later';

export interface RoutineStatus<L extends RoutineLogLike = RoutineLogLike> {
  state: RoutineState;
  /** The due day this status is about: the open one, the one done today, or the next. */
  due: Ymd;
  /** Days past `due` while overdue, else 0. */
  late: number;
  /** The log of the due day done today (`state: 'done'`). */
  log?: L;
  /** When it is next due once today's is handled; equals `due` while later. */
  next: Ymd;
  /** The latest log, whenever it was. */
  last?: L;
}

/**
 * Where a routine stands today, from its logs (any routines'; others are ignored): open (`due` or
 * `overdue`), `done` today (with the log, so Undo can remove it) or `later`.
 */
export function routineStatus<L extends RoutineLogLike>(r: RoutineLike, logs: readonly L[], today: Ymd): RoutineStatus<L> {
  const mine = logs.filter((l) => l.routineId === r.id);
  const last = mine.reduce<L | undefined>((a, l) => (!a || l.on > a.on || (l.on === a.on && (l.at ?? 0) > (a.at ?? 0)) ? l : a), undefined);
  const withLast = last ? { last } : {};
  const open = (due: Ymd, next: Ymd): RoutineStatus<L> => ({ state: due < today ? 'overdue' : due === today ? 'due' : 'later', due, late: Math.max(0, daysBetween(due, today)), next, ...withLast });
  if (r.mode === 'after-done') {
    const step = (from: Ymd) => addInterval(from, r.every ?? 1, r.unit ?? 'week');
    if (last && last.on >= today) return { state: 'done', due: last.due, late: 0, log: last, next: step(last.on), ...withLast };
    const due = last ? step(last.on) : r.since;
    return open(due, due);
  }
  const occ = lastOccurrence(r, today);
  if (occ === null) {
    const first = nextOccurrence(r, addDays(r.since, -1));
    return open(first, first);
  }
  const log = mine.find((l) => l.due === occ);
  const next = nextOccurrence(r, today);
  if (log) return log.on >= today ? { state: 'done', due: occ, late: 0, log, next, ...withLast } : { state: 'later', due: next, late: 0, next, ...withLast };
  return open(occ, next);
}

/**
 * The due days from `from` to `to` that are still open and not past, for reminders: the next one of
 * an after-done routine, each unlogged occurrence of a fixed one.
 */
export function routineDueDays(r: RoutineLike, logs: readonly RoutineLogLike[], from: Ymd, to: Ymd): Ymd[] {
  const mine = logs.filter((l) => l.routineId === r.id);
  if (r.mode === 'after-done') {
    const s = routineStatus(r, mine, from);
    return s.state !== 'done' && s.due >= from && s.due <= to ? [s.due] : [];
  }
  return occurrencesBetween(r, from, to).filter((d) => !mine.some((l) => l.due === d));
}
