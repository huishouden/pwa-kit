import { can, householdRole, MONEY_APPS, type Role } from './role-core.js';
import { isLang, LANGS, type Lang } from './i18n.js';

/**
 * Which languages a published item is stored in. Each member keeps one language for the whole suite
 * (`households/{id}.langs`, by lowercase email; set by the member themself, `./member-lang`), and a
 * reminder, to-do or agenda item carries `texts` only for the languages its readers use: one
 * language's words, not every language the suite speaks. The item's own `title`, `body` and
 * `detail` are in the writer's language, so the writer's language is never repeated in `texts`, and a
 * household that speaks one language stores no `texts` at all. Readers take `texts[their language]`,
 * else the item's own words.
 */

/** Each member's language, by lowercase email, as stored on the household. */
export type MemberLangs = Partial<Record<string, Lang>>;

/** What working out readers' languages needs of a household. */
export interface LangHousehold {
  members: readonly string[];
  roles?: Readonly<Record<string, Role>>;
  langs?: MemberLangs;
}

/** Who an item is for: a reminder's `recipients`, a personal item's `audience`, a shared item's `private`. */
export interface ItemReaders {
  recipients?: 'all' | readonly string[];
  audience?: readonly string[];
  private?: boolean;
}

/** `langs` as stored: lowercase emails to known languages; anything else dropped. Undefined when none. */
export function cleanMemberLangs(value: unknown): MemberLangs | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: MemberLangs = {};
  for (const [email, lang] of Object.entries(value as Record<string, unknown>)) {
    if (isLang(lang)) out[email.trim().toLowerCase()] = lang;
  }
  return Object.keys(out).length ? out : undefined;
}

const lower = (emails: readonly string[]) => emails.map((e) => e.trim().toLowerCase());

/**
 * The members who read an item: a reminder's named recipients (who get the notification), else a
 * personal item's audience, else every member who may see it (admins and members only when it is
 * private or from a money app).
 */
export function itemReaders(h: LangHousehold, item: ItemReaders, app?: string): string[] {
  if (Array.isArray(item.recipients)) return lower(item.recipients);
  if (item.audience) return lower(item.audience);
  const hidden = item.private === true || (!!app && MONEY_APPS.includes(app));
  const household = { members: [...h.members], roles: { ...(h.roles ?? {}) } };
  return h.members.filter((m) => !hidden || can(householdRole(household, m), 'see-private'));
}

/**
 * The languages of an item's readers other than the writer's (whose words are the item's own), in
 * `LANGS` order. A reader with no stored language counts as reading the writer's.
 */
export function readerLangs(h: LangHousehold, item: ItemReaders, writer: Lang, app?: string): Lang[] {
  const wanted = new Set(itemReaders(h, item, app).map((m) => h.langs?.[m] ?? writer));
  return LANGS.filter((l) => l !== writer && wanted.has(l));
}

let current: LangHousehold | null = null;

/**
 * The household whose members' languages `localizeReminders`, `localizeTodos` and `localizeAgenda`
 * use when not given one. `watchHousehold` (`./household`) sets it, as it does the currency.
 * Servers pass the household to each call instead: this is one page's state.
 */
export function setReaderHousehold(h: LangHousehold | null | undefined): void {
  current = h ? { members: [...h.members], roles: h.roles ? { ...h.roles } : undefined, langs: h.langs ? { ...h.langs } : undefined } : null;
}

/** The household `setReaderHousehold` last set, null before one is known. */
export function getReaderHousehold(): LangHousehold | null {
  return current;
}

/** What `localize*` take: whose languages to store (the page's household by default) and the writer's (the page's). */
export interface LocalizeOptions {
  /** The household the items are published in; default the page's (`setReaderHousehold`). Unknown: every language. */
  household?: LangHousehold | null;
  /** The language the items' own words are in; default the page's. */
  writer?: Lang;
  /** The publishing app, so a money app's items count as private. */
  app?: string;
}

/**
 * For `localizeRecords`: each record's readers' languages (`readerLangs`) in `options.household`, else
 * the page's; undefined (every language) while no household is known. The writer's language is
 * `options.writer`, else the page's.
 */
export function langsOfReaders(options: LocalizeOptions, writer: Lang): ((item: unknown) => Lang[]) | undefined {
  const h = options.household === undefined ? current : options.household;
  if (!h) return undefined;
  // The item's own app when it names one (a reminder does), as the doc builders decide `private`.
  return (item) => readerLangs(h, (item ?? {}) as ItemReaders, writer, options.app ?? (item as { app?: unknown } | null)?.app as string | undefined);
}
