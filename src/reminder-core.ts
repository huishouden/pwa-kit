import { MONEY_APPS } from './role-core.js';
import { cleanAudience, inAudience } from './audience.js';
import { getLang, LANGS, localizeRecords, type Lang } from './i18n.js';
import { langsOfReaders, type LocalizeOptions } from './reader-langs.js';
import { cleanSource, readSource, type ReminderSource } from './reminder-source.js';
import { cleanMerge, mergedTitle, mergeIdentity, MERGE_LIMITS, MERGE_PARTS, type MergeSpec } from './merge.js';

/**
 * The reminder documents (`./reminders`) without Firebase: their shape, ids and builders, for servers
 * that write the same documents over Firestore REST as a signed-in person (the household tools).
 * `./reminders` re-exports all of it.
 */

/** A reminder's words in one language. */
export interface ReminderText {
  title: string;
  body: string;
  /** Its merge's part and title in this language (`./merge`). */
  mergePart?: string;
  mergeTitle?: string;
}

/** The same title and body in the recipients' other languages (`./reader-langs`), for the sender to pick by the member's language. */
export type ReminderTexts = Partial<Record<Lang, ReminderText>>;

export interface Reminder {
  id: string;
  /** Short name of the app that owns it ("pet"); its notification opens in that app when it can. */
  app: string;
  title: string;
  body: string;
  /** `title` and `body` in the recipients' other languages; the sender uses the member's (`./member-lang`), else `title`/`body`. */
  texts?: ReminderTexts;
  /** When to notify, ms since epoch. */
  at: number;
  /** Deep link opened when the notification is tapped (https). */
  url: string;
  /** Everyone in the household, or these members (lowercase emails). */
  recipients: 'all' | string[];
  /** What it belongs to, for replacing or cancelling a group ("pet:course:abc"). */
  ref?: string;
  /**
   * For admins and members only (a private appointment, a bill): helpers and kids neither read it
   * nor get it on their devices. Always written; one without it counts as private to them.
   */
  private?: boolean;
  /**
   * Only these members read it (lowercase emails): a reminder in `personalReminders` (`./audience`),
   * about one person's care; `recipients` are some of them. Absent on shared reminders.
   */
  audience?: string[];
  /**
   * What it is about, so the sender deletes it unsent once that is done anywhere: a bill paid from
   * the portal, a task ticked in Google Tasks (`./reminder-source`). Without one it is always sent.
   */
  source?: ReminderSource;
  /**
   * May go out as one notification with the app's other reminders that have the same `merge.key`,
   * minute, recipients and readers (`./merge`): "Take the garbage and recycling out". Each keeps its
   * own source: one whose record is done drops out, and none is sent when all are.
   */
  merge?: MergeSpec;
  sent: boolean;
  sentAt?: number;
  createdAt: number;
  by: string;
}

export const REMINDER_FIELDS = ['app', 'title', 'body', 'texts', 'at', 'url', 'recipients', 'ref', 'private', 'source', 'merge', 'sent', 'sentAt', 'createdAt', 'by'] as const;

/** Limits of a stored title and body, also inside `texts` (the rules check the same). */
export const REMINDER_LIMITS = { title: 120, body: 500 } as const;

/** The collection of reminders for named members only (`./audience`); the sender reads it too. */
export const PERSONAL_REMINDERS = 'personalReminders';

/** Fields of a `personalReminders` document: a reminder's plus `audience`. */
export const PERSONAL_REMINDER_FIELDS = [...REMINDER_FIELDS, 'audience'] as const;

export type ReminderInput = Pick<Reminder, 'app' | 'title' | 'at' | 'url'> & Partial<Pick<Reminder, 'id' | 'body' | 'texts' | 'recipients' | 'ref' | 'private' | 'source' | 'merge'>>;

/** `texts` as stored: known languages only, each title and body trimmed and clipped; undefined when none is left. */
export function cleanTexts(texts: ReminderTexts | undefined | null): ReminderTexts | undefined {
  if (!texts || typeof texts !== 'object') return undefined;
  const out: ReminderTexts = {};
  for (const lang of LANGS) {
    const t = texts[lang];
    if (!t || typeof t.title !== 'string') continue;
    const title = t.title.trim().slice(0, REMINDER_LIMITS.title);
    if (!title) continue;
    const mergePart = typeof t.mergePart === 'string' ? t.mergePart.trim().slice(0, MERGE_LIMITS.part) : '';
    const mergeTitle = typeof t.mergeTitle === 'string' ? t.mergeTitle.trim().slice(0, MERGE_LIMITS.title) : '';
    out[lang] = { title, body: (typeof t.body === 'string' ? t.body : '').trim().slice(0, REMINDER_LIMITS.body), ...(mergePart ? { mergePart } : {}), ...(mergeTitle ? { mergeTitle } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Runs `build` in the writer's language (its `t`/`kt` and formatters) and in the languages of each
 * reminder's readers (`./reader-langs`: its named recipients, else everyone who may see it), and
 * returns the writer's reminders, each with `texts` holding those readers' title and body, so each
 * is notified in their own language. `build` must be synchronous and return the same reminders in
 * the same order every time (only the words differ).
 *
 * ```ts
 * syncReminders(db, id, 'car', await localizeReminders(() => carReminders(data)), me);
 * ```
 */
export async function localizeReminders<R extends ReminderInput>(build: () => R[], options: LocalizeOptions = {}): Promise<(R & { texts?: ReminderTexts })[]> {
  const writer = options.writer ?? getLang();
  const out = await localizeRecords(build, (r) => ({ title: r.title, body: r.body ?? '', mergePart: r.merge?.part, mergeTitle: r.merge?.title }), { langsOf: langsOfReaders(options, writer), writer });
  // A body left empty in a language is dropped by localizeRecords; a reminder's text always has one.
  return out.map(({ texts, ...r }) => {
    const clean: ReminderTexts = {};
    for (const [l, t] of Object.entries(texts ?? {}) as [Lang, { title?: string; body?: string; mergePart?: string; mergeTitle?: string }][])
      if (t.title) clean[l] = { title: t.title, body: t.body ?? '', ...(t.mergePart ? { mergePart: t.mergePart } : {}), ...(t.mergeTitle ? { mergeTitle: t.mergeTitle } : {}) };
    return (Object.keys(clean).length ? { ...r, texts: clean } : r) as R & { texts?: ReminderTexts };
  });
}

/** A reminder for named members only: who may read it (`./audience`); `recipients` must be a list of some of them. */
export type PersonalReminderInput = ReminderInput & { audience: readonly string[]; recipients: string[] };

/**
 * The same id for the same reminder however often it is written, so re-saving a course
 * overwrites its reminders instead of doubling them: `<ref or app>-<at>`, Firestore-safe.
 */
export function reminderId(refOrApp: string, at: number): string {
  return `${refOrApp.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 200)}-${at}`;
}

/** The document a reminder is stored as: trimmed, recipients lowercased, unsent. */
export function reminderDoc(input: ReminderInput, by: string, now = Date.now()): Omit<Reminder, 'id'> {
  if (!/^https:\/\//.test(input.url)) throw new Error('Reminder url must be an https deep link into the app.');
  const recipients = input.recipients === undefined || input.recipients === 'all'
    ? 'all'
    : [...new Set(input.recipients.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (Array.isArray(recipients) && recipients.length === 0) throw new Error('Reminder has no recipients.');
  const texts = cleanTexts(input.texts);
  const source = cleanSource(input.app, input.source);
  const merge = input.merge === undefined ? undefined : cleanMerge(input.merge);
  if (input.merge !== undefined && !merge) throw new Error('Reminder merge needs a key, a part, and a title with {parts}.');
  return {
    app: input.app,
    title: input.title.trim().slice(0, REMINDER_LIMITS.title),
    body: (input.body ?? '').trim().slice(0, REMINDER_LIMITS.body),
    ...(texts ? { texts } : {}),
    at: Math.round(input.at),
    url: input.url,
    recipients,
    ...(input.ref ? { ref: input.ref } : {}),
    private: input.private === true || MONEY_APPS.includes(input.app),
    ...(source ? { source } : {}),
    ...(merge ? { merge } : {}),
    sent: false,
    createdAt: now,
    by,
  };
}

/**
 * A `personalReminders` document: as `reminderDoc`, private, with the audience cleaned and the
 * recipients narrowed to it. Throws when the audience leaves out the writer or no recipient is in it.
 */
export function personalReminderDoc(input: PersonalReminderInput, by: string, now = Date.now()): Omit<Reminder, 'id'> {
  const audience = cleanAudience(input.audience);
  if (!inAudience(audience, by)) throw new Error('A personal reminder must name its writer in its audience.');
  const recipients = cleanAudience(input.recipients).filter((e) => audience.includes(e));
  const { audience: _a, ...rest } = input;
  const { source: _s, ...shared } = reminderDoc({ ...rest, recipients, private: true }, by, now);
  const source = cleanSource(input.app, input.source, { personal: true });
  return { ...shared, ...(source ? { source } : {}), audience };
}

export function toReminder(id: string, data: Record<string, unknown>): Reminder {
  return {
    id,
    app: String(data.app ?? ''),
    title: String(data.title ?? ''),
    body: String(data.body ?? ''),
    ...((t) => (t ? { texts: t } : {}))(cleanTexts(data.texts as ReminderTexts | undefined)),
    at: typeof data.at === 'number' ? data.at : 0,
    url: String(data.url ?? ''),
    recipients: Array.isArray(data.recipients) ? data.recipients.map(String) : 'all',
    ref: typeof data.ref === 'string' ? data.ref : undefined,
    ...(typeof data.private === 'boolean' ? { private: data.private } : {}),
    ...(Array.isArray(data.audience) ? { audience: data.audience.filter((e): e is string => typeof e === 'string') } : {}),
    ...((source) => (source ? { source } : {}))(readSource(String(data.app ?? ''), data.source)),
    ...((merge) => (merge ? { merge } : {}))(cleanMerge(data.merge)),
    sent: data.sent === true,
    sentAt: typeof data.sentAt === 'number' ? data.sentAt : undefined,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
    by: String(data.by ?? ''),
  };
}

// ---- Merging (`./merge`): one notification for reminders that go together ----

/** What `reminderMergeKey` and `mergedReminderText` read of a reminder: the stored one, or the sender's copy of it. */
export type MergeableReminder = Pick<Reminder, 'app' | 'at' | 'title' | 'merge' | 'private'> & {
  body?: string;
  recipients: 'all' | readonly string[];
  audience?: readonly string[];
  texts?: Partial<Record<Lang, Partial<ReminderText>>>;
};

/**
 * What reminders merge under: `mergeIdentity` (app, `merge.key`, readers), the same minute and the
 * same recipients. Null for a reminder without a merge.
 */
export function reminderMergeKey(r: MergeableReminder): string | null {
  const identity = mergeIdentity(r);
  if (!identity) return null;
  const to = r.recipients === 'all' ? 'all' : [...new Set(r.recipients.map((e) => e.trim().toLowerCase()))].sort().join(',');
  return `${identity}|${Math.floor(r.at / 60_000)}|${to}`;
}

/**
 * One notification for reminders that merge, in `lang`: the combined title ("Take the garbage and
 * recycling out"), and each one's body once, a line each. `lang` is the reader's; a reminder without
 * words in it (its writer wrote in that language) gives its own.
 */
export function mergedReminderText(members: readonly MergeableReminder[], lang: Lang): ReminderText {
  const partOf = (m: MergeableReminder) => m.texts?.[lang]?.mergePart ?? m.merge?.part ?? m.title;
  const sorted = [...members].sort((a, b) => partOf(a).localeCompare(partOf(b)));
  const template = sorted[0].texts?.[lang]?.mergeTitle ?? sorted[0].merge?.title ?? MERGE_PARTS;
  const bodies = [...new Set(sorted.map((m) => (m.texts?.[lang]?.title ? (m.texts[lang]!.body ?? '') : (m.body ?? '')).trim()).filter(Boolean))];
  return { title: mergedTitle(template, sorted.map(partOf), lang), body: bodies.join('\n').slice(0, REMINDER_LIMITS.body) };
}
