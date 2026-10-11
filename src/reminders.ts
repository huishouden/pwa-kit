import { collection, doc, getDocs, onSnapshot, query, where, type Firestore, type Unsubscribe } from 'firebase/firestore';
import { deleteDoc, setDoc, writeBatch } from './firestore.js';
import { doseSlots, type MedCourse } from './dose.js';
import { cleanAudience, inAudience } from './audience.js';
import { kt } from './i18n.js';
import { atClock } from './time.js';
import { readSource } from './reminder-source.js';
import type { LocalizeOptions } from './reader-langs.js';
import { cleanTexts, localizeReminders, PERSONAL_REMINDERS, personalReminderDoc, reminderDoc, reminderId, toReminder, type PersonalReminderInput, type Reminder, type ReminderInput, type ReminderTexts } from './reminder-core.js';
import { fingerprint, forgetPublished, publishedKey, publishedStore, unlessPublished, type PublishedStorage } from './published.js';

export type { ReminderSource, SourceCheck, SourceCondition, SourceValue } from './reminder-source.js';
export * from './reminder-core.js';

/**
 * Reminders any app writes and the shared sender (huishouden/notify) delivers as push
 * notifications: one collection, `households/{id}/reminders`. The sender checks every five
 * minutes for reminders that are due and not yet sent, pushes them to the recipients' devices,
 * and marks them sent. Apps never send anything themselves.
 *
 * Each member is notified in their own language. A reminder's `title` and `body` are in the writer's
 * language; `texts` carries the same title and body in the other languages its recipients use
 * (`./reader-langs`, from each member's stored language), and the sender shows the recipient's,
 * falling back to `title`/`body`. Kit builders fill `texts` (`remindersForCourseInEveryLang`); an
 * app wraps its own reminder builder with `localizeReminders(() => build())`, which runs it once
 * per language needed.
 *
 * Fields match the rules exactly (see REMINDER_FIELDS); keep them in step.
 */

/**
 * For writes from a helper's or kid's device (`isRestricted(role)`): only reminders not marked
 * private are read and written, each on its own, and one the rules refuse (written before the
 * flag, until an admin's or member's device rewrites it) is skipped rather than failing the rest.
 */
export interface ReminderWriteOptions {
  restricted?: boolean;
  /** Where this device notes what apps scheduled (`./published`): `localStorage` by default, null for none. */
  published?: PublishedStorage | null;
}

const remindersOf = (db: Firestore, householdId: string) => collection(db, 'households', householdId, 'reminders');
const personalOf = (db: Firestore, householdId: string) => collection(db, 'households', householdId, PERSONAL_REMINDERS);

/** Reminders matching `filters`, or for a helper or kid only the open ones (what the rules let them read). */
const visible = (db: Firestore, householdId: string, restricted: boolean | undefined, ...filters: ReturnType<typeof where>[]) =>
  query(remindersOf(db, householdId), ...filters, ...(restricted ? [where('private', '==', false)] : []));

const refused = (e: unknown) => (e as { code?: string })?.code === 'permission-denied';

type Op = (b: ReturnType<typeof writeBatch>) => void;

async function commit(db: Firestore, ops: Op[], restricted = false): Promise<void> {
  if (restricted) {
    for (const op of ops) {
      const batch = writeBatch(db);
      op(batch);
      await batch.commit().catch((e) => {
        if (!refused(e)) throw e;
      });
    }
    return;
  }
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + 450)) op(batch);
    await batch.commit();
  }
}

/**
 * Creates or replaces a reminder (id from `reminderId(ref ?? app, at)` unless given). Writing it
 * again marks it unsent, so it is delivered again if its time has come.
 */
export async function upsertReminder(db: Firestore, householdId: string, input: ReminderInput, by: string, { published }: Pick<ReminderWriteOptions, 'published'> = {}): Promise<string> {
  const id = input.id ?? reminderId(input.ref ?? input.app, input.at);
  forgetPublished(publishedStore(published), db, householdId, 'reminders', input.app);
  await setDoc(doc(remindersOf(db, householdId), id), reminderDoc(input, by));
  return id;
}

/** Deletes one reminder. Its app isn't known here, so every app's sync on this device reads again. */
export async function cancelReminder(db: Firestore, householdId: string, id: string, { published }: Pick<ReminderWriteOptions, 'published'> = {}): Promise<void> {
  forgetPublished(publishedStore(published), db, householdId, 'reminders');
  await deleteDoc(doc(remindersOf(db, householdId), id));
}

/** Deletes every reminder with this `ref` (a course stopped, an appointment cancelled). */
export async function cancelReminders(db: Firestore, householdId: string, ref: string, { restricted, published }: ReminderWriteOptions = {}): Promise<number> {
  const snap = await getDocs(visible(db, householdId, restricted, where('ref', '==', ref)));
  forgetApps(publishedStore(published), db, householdId, snap.docs.map((d) => d.data().app));
  await commit(db, snap.docs.map((d) => (b) => b.delete(d.ref)), restricted);
  return snap.size;
}

/** A per-record write is about to change what is stored for these apps: their next sync on this device reads again. */
function forgetApps(store: PublishedStorage | null, db: Firestore, householdId: string, apps: unknown[]) {
  for (const app of new Set(apps.filter((a): a is string => typeof a === 'string'))) forgetPublished(store, db, householdId, 'reminders', app);
}

/**
 * Makes the reminders with this `ref` exactly `inputs` from now on: future ones not in the list are
 * deleted, the list is written (unchanged ones keep their ids), and past ones are left alone so a
 * sent reminder is never sent twice. Use it whenever a course or appointment is saved.
 */
export async function replaceReminders(
  db: Firestore,
  householdId: string,
  ref: string,
  inputs: ReminderInput[],
  by: string,
  now = Date.now(),
  { restricted, published }: ReminderWriteOptions = {},
): Promise<string[]> {
  const wanted = new Map(
    inputs
      .filter((r) => r.at > now && !(restricted && r.private))
      .map((r) => [r.id ?? reminderId(ref, r.at), reminderDoc({ ...r, ref }, by, now)] as const),
  );
  const existing = await getDocs(visible(db, householdId, restricted, where('ref', '==', ref)));
  const ops: Op[] = [];
  for (const d of existing.docs) {
    const at = d.data().at as number;
    if (at > now && !wanted.has(d.id)) ops.push((b) => b.delete(d.ref));
  }
  for (const [id, data] of wanted) ops.push((b) => b.set(doc(remindersOf(db, householdId), id), data));
  forgetApps(publishedStore(published), db, householdId, [...existing.docs.map((d) => d.data().app), ...[...wanted.values()].map((d) => d.app)]);
  await commit(db, ops, restricted);
  return [...wanted.keys()];
}

/** A reminder as it would be sent, for telling whether a stored one needs rewriting. */
const sameReminder = (a: Record<string, unknown>, b: Omit<Reminder, 'id'>) =>
  (['app', 'title', 'body', 'at', 'url', 'ref', 'private'] as const).every((k) => a[k] === b[k]) &&
  JSON.stringify(a.recipients) === JSON.stringify(b.recipients) &&
  JSON.stringify(cleanTexts(a.texts as ReminderTexts | undefined) ?? null) === JSON.stringify(b.texts ?? null) &&
  JSON.stringify(readSource(String(a.app ?? ''), a.source) ?? null) === JSON.stringify(b.source ?? null) &&
  a.sent === false;

export interface SyncRemindersResult {
  written: number;
  deleted: number;
  unchanged: number;
  /** Nothing read or written: this device scheduled exactly these reminders a short while ago (`./published`). */
  skipped?: true;
}

/**
 * Makes everything this app has scheduled from now on exactly `inputs` (each with its own `ref`):
 * for apps that work out all their reminders from their data, on open and whenever it changes. Future
 * reminders not in the list are deleted, new or changed ones written, and unchanged ones left alone,
 * so running it often costs one read and almost no writes. Past and sent reminders are never
 * touched, so nothing is sent twice.
 */
export async function syncReminders(
  db: Firestore,
  householdId: string,
  app: string,
  inputs: ReminderInput[],
  by: string,
  now = Date.now(),
  { restricted, published }: ReminderWriteOptions = {},
): Promise<SyncRemindersResult> {
  const wanted = new Map(
    inputs
      .filter((r) => r.at > now && !(restricted && r.private))
      .map((r) => {
        const data = reminderDoc({ ...r, app }, by, now);
        return [r.id ?? reminderId(r.ref ?? app, data.at), data] as const;
      }),
  );
  // The same reminders this device scheduled a short while ago: nothing to read or write (`./published`).
  return unlessPublished(
    publishedStore(published),
    publishedKey(db, householdId, 'reminders', app, by),
    fingerprint(wanted, String(!!restricted)),
    now,
    () => ({ written: 0, deleted: 0, unchanged: wanted.size, skipped: true as const }),
    async () => {
      const existing = await getDocs(visible(db, householdId, restricted, where('app', '==', app)));
      const have = new Map(existing.docs.map((d) => [d.id, d.data() as Record<string, unknown>]));
      const ops: Op[] = [];
      for (const d of existing.docs) {
        const data = d.data() as Record<string, unknown>;
        if (typeof data.at === 'number' && data.at > now && data.sent !== true && !wanted.has(d.id)) ops.push((b) => b.delete(d.ref));
      }
      const deleted = ops.length;
      let unchanged = 0;
      for (const [id, data] of wanted) {
        const old = have.get(id);
        if (old && sameReminder(old, data)) unchanged++;
        else if (old?.sent === true) unchanged++;
        else ops.push((b) => b.set(doc(remindersOf(db, householdId), id), data));
      }
      await commit(db, ops, restricted);
      return { written: ops.length - deleted, deleted, unchanged };
    },
  );
}

/**
 * Makes this app's reminders for named members exactly `inputs` from now on, as `syncReminders`
 * does for shared ones: the reminders whose audience includes `by`. Past and sent ones are never
 * touched; inputs whose audience leaves `by` out, or with no recipient in it, are skipped.
 */
export async function syncPersonalReminders(
  db: Firestore,
  householdId: string,
  app: string,
  inputs: PersonalReminderInput[],
  by: string,
  now = Date.now(),
  { published }: Pick<ReminderWriteOptions, 'published'> = {},
): Promise<SyncRemindersResult> {
  const me = by.trim().toLowerCase();
  const wanted = new Map<string, Omit<Reminder, 'id'>>();
  for (const r of inputs) {
    if (r.at <= now || !inAudience(cleanAudience(r.audience), me)) continue;
    let data: Omit<Reminder, 'id'>;
    try {
      data = personalReminderDoc({ ...r, app }, me, now);
    } catch {
      continue;
    }
    wanted.set(r.id ?? reminderId(r.ref ?? app, data.at), data);
  }
  const col = personalOf(db, householdId);
  return unlessPublished(
    publishedStore(published),
    publishedKey(db, householdId, PERSONAL_REMINDERS, app, me),
    fingerprint(wanted),
    now,
    () => ({ written: 0, deleted: 0, unchanged: wanted.size, skipped: true as const }),
    async () => {
      const existing = await getDocs(query(col, where('app', '==', app), where('audience', 'array-contains', me)));
      const ops: Op[] = [];
      for (const d of existing.docs) {
        const data = d.data() as Record<string, unknown>;
        if (typeof data.at === 'number' && data.at > now && data.sent !== true && !wanted.has(d.id)) ops.push((b) => b.delete(d.ref));
      }
      const deleted = ops.length;
      const have = new Map(existing.docs.map((d) => [d.id, d.data() as Record<string, unknown>]));
      let unchanged = 0;
      for (const [id, data] of wanted) {
        const old = have.get(id);
        if (old && sameReminder(old, data) && JSON.stringify(old.audience) === JSON.stringify(data.audience)) unchanged++;
        else if (old?.sent === true) unchanged++;
        else ops.push((b) => b.set(doc(col, id), data));
      }
      await commit(db, ops);
      return { written: ops.length - deleted, deleted, unchanged };
    },
  );
}

/** Follows the household's reminders, optionally one app's, soonest first. */
export function watchReminders(
  db: Firestore,
  householdId: string,
  onChange: (reminders: Reminder[]) => void,
  { app, restricted, onError }: { app?: string; restricted?: boolean; onError?: (error: Error) => void } = {},
): Unsubscribe {
  const source = visible(db, householdId, restricted, ...(app ? [where('app', '==', app)] : []));
  return onSnapshot(
    source,
    (snap) => onChange(snap.docs.map((d) => toReminder(d.id, d.data())).sort((a, b) => a.at - b.at)),
    (error) => onError?.(error),
  );
}

export interface CourseReminderOptions {
  app: string;
  /** Deep link to the course or the pet in the app (https). */
  url: string;
  /** Groups the course's reminders; default `<app>:course:<course id>`. */
  ref?: string;
  recipients?: 'all' | string[];
  /** Only for admins and members. */
  private?: boolean;
  /** Notify this many minutes before each dose. Default 0. */
  leadMinutes?: number;
  /** Ongoing courses get reminders this many days ahead; re-run when the app opens. Default 14. */
  horizonDays?: number;
  /** Days between dosing days (2 for every other day). Default 1. */
  everyDays?: number;
  /** Who the medicine is for, shown in the title: "Biscuit: Carprofen 75 mg". */
  forWhom?: string;
  now?: number;
}

/**
 * One reminder per future dose of a course, with stable ids (`reminderId(ref, at)`), ready for
 * `replaceReminders(db, householdId, ref, reminders, by)`. Courses with a length get every
 * remaining dose; ongoing ones the next `horizonDays`.
 */
export function remindersForCourse(course: MedCourse & { id: string }, options: CourseReminderOptions): ReminderInput[] {
  const now = options.now ?? Date.now();
  const ref = options.ref ?? `${options.app}:course:${course.id}`;
  const lead = (options.leadMinutes ?? 0) * 60_000;
  const horizon = now + (options.horizonDays ?? 14) * 86_400_000;
  const to = course.days !== undefined ? Number.MAX_SAFE_INTEGER : horizon;
  const slots = doseSlots({ startDate: course.startDate, days: course.days, times: course.times, everyDays: options.everyDays }, now + lead, Math.min(to, now + 366 * 86_400_000));
  const title = options.forWhom && course.name ? kt('reminders.titleFor', { who: options.forWhom, name: course.name }) : options.forWhom || course.name || kt('reminders.medicine');
  const food = course.withFood === true ? 'with' : course.withFood === false ? 'without' : null;
  // The dose's time as said in the reader's language ("at 8 PM", "a las 8 p.m.", "om 20:00"), not 'HH:MM'.
  const body = (time: string) => {
    const at = atClock(time);
    return course.dose && food
      ? kt('reminders.bodyDoseFood', { dose: course.dose, at, food })
      : course.dose
        ? kt('reminders.bodyDose', { dose: course.dose, at })
        : food
          ? kt('reminders.bodyFood', { food })
          : kt('reminders.bodyTime', { at });
  };
  return slots.map((slot) => ({
    id: reminderId(ref, slot.at - lead),
    app: options.app,
    title,
    body: body(slot.time),
    at: slot.at - lead,
    url: options.url,
    recipients: options.recipients ?? 'all',
    ...(options.private ? { private: true } : {}),
    ref,
  }));
}

/** `remindersForCourse` with `texts` in its readers' languages (`localizeReminders`), so each is notified in their own. */
export function remindersForCourseInEveryLang(course: MedCourse & { id: string }, options: CourseReminderOptions, localize: LocalizeOptions = {}): Promise<ReminderInput[]> {
  const now = options.now ?? Date.now();
  return localizeReminders(() => remindersForCourse(course, { ...options, now }), localize);
}
