import { householdRole, isRestricted, type Role } from '../role-core.js';
import { isLang, loadLang, type Lang } from '../i18n.js';
import { LocalClock, isTimeZone } from '../local-clock.js';
import { FirestoreRest, FirestoreError, type Doc } from '../firestore-rest.js';
import { toHome, type HouseholdHome } from '../home.js';
import { cleanMemberLangs, type MemberLangs } from '../reader-langs.js';
import type { ToolMessageKey } from './i18n.js';

/** Who a session acts as, and how (the connector's grant, the `hh` command line's sign-in). */
export interface SessionProps {
  uid: string;
  email: string;
  /**
   * This caller's stable id (the connector's connection, `hh-<uid>` for the command line): with an
   * `idempotency_key` it makes a retried write land on the same record.
   */
  connectionId: string;
  /**
   * The language and time zone the portal's device had at sign-in: the language until the
   * household has the member's (`langs`), the zone until the profile has one.
   */
  lang?: Lang;
  timeZone?: string;
  /**
   * Marks what this session writes (`via: 'assistant'`, which the rules accept and the apps show);
   * left out, records look as if the person made them in an app.
   */
  via?: 'assistant';
}

export interface Household {
  id: string;
  name: string;
  members: string[];
  joined: string[];
  roles?: Record<string, Role>;
  currency?: string;
  /** Where the household lives (`households/{id}.home`): every member reads it. */
  home?: HouseholdHome;
  /** Each member's language (`households/{id}.langs`), set by that member in the apps. */
  langs?: MemberLangs;
  createdAt: number;
}

export function toHousehold(id: string, d: Record<string, unknown>): Household {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const roles = d.roles && typeof d.roles === 'object' ? (d.roles as Record<string, Role>) : undefined;
  const home = toHome(d.home);
  const langs = cleanMemberLangs(d.langs);
  return {
    id,
    name: typeof d.name === 'string' ? d.name : '',
    members: strings(d.members),
    joined: strings(d.joined),
    ...(roles ? { roles } : {}),
    ...(typeof d.currency === 'string' ? { currency: d.currency } : {}),
    ...(home ? { home } : {}),
    ...(langs ? { langs } : {}),
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
  };
}

/**
 * The household the apps open, as `../household` pickHousehold picks it: joined first, then the
 * oldest. `email` is normalized (`Session` does it once).
 */
export function defaultHousehold(households: Household[], email: string): Household | null {
  const sorted = [...households].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return sorted.find((h) => h.joined.includes(email)) ?? sorted[0] ?? null;
}

export interface Profile {
  name?: string;
  timeZone?: string;
}

export interface AuditEntry {
  tool: string;
  kind: 'read' | 'write';
  ok: boolean;
  app?: string;
  ref?: string;
}

/** A household the person is in, with their role there. */
export interface Here extends Household {
  role: Role;
  /** A helper or kid: reads of private-capable collections ask for `private == false`. */
  restricted: boolean;
}

/** Thrown for anything the person should hear in their language (an unknown pet, no household). */
export class UserError extends Error {
  constructor(
    readonly key: ToolMessageKey,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(key);
  }
}

/**
 * One tool call's view of the world: who is asking (their FirestoreRest access, as them), their clock
 * and language, and their households. Built per request; cheap, since reads happen on demand.
 */
export class Session {
  private householdsP: Promise<Household[]> | null = null;
  private profiles = new Map<string, Promise<Profile>>();

  constructor(
    readonly props: SessionProps,
    readonly db: FirestoreRest,
    readonly siteUrl: string,
    private readonly realNow: () => number = Date.now,
    private readonly audit: (household: string, entry: AuditEntry) => void = () => {},
  ) {}

  /** Trimmed and lowercase, as the apps and the rules compare emails. */
  get email(): string {
    return this.props.email.trim().toLowerCase();
  }

  /** What every write by this session carries: `{ via: 'assistant' }` for the connector, else nothing. */
  get via(): { via?: 'assistant' } {
    return this.props.via ? { via: this.props.via } : {};
  }

  households(): Promise<Household[]> {
    this.householdsP ??= this.db
      .query('', 'households', { where: [{ field: 'members', op: 'ARRAY_CONTAINS', value: this.email }] })
      .then((docs) => docs.map((d) => toHousehold(d.id, d.data)));
    return this.householdsP;
  }

  /** The household `id`, or the one the apps open; throws a UserError when there is none. */
  async here(id?: string): Promise<Here> {
    const all = await this.households();
    const h = id ? all.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase()) : defaultHousehold(all, this.email);
    if (!h) throw new UserError(id ? 'error.noSuchHousehold' : 'error.noHousehold');
    // Fails closed: a role that can't be read is treated as a helper's (private records filtered).
    const role = householdRole(h, this.email) ?? 'helper';
    return { ...h, role, restricted: isRestricted(role) };
  }

  profile(householdId: string): Promise<Profile> {
    let p = this.profiles.get(householdId);
    if (!p) {
      p = this.db
        .get(`households/${householdId}/profiles/${this.email}`)
        .then((d) => {
          const data = d?.data ?? {};
          return {
            ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
            ...(isTimeZone(data.timeZone) ? { timeZone: data.timeZone as string } : {}),
          };
        })
        .catch((e) => {
          // No profile to read (refused) answers with the defaults; anything else is said as itself
          // and tried again on the next call.
          if (isDenied(e) || (e instanceof FirestoreError && e.code === 'not-found')) return {};
          this.profiles.delete(householdId);
          throw e;
        });
      this.profiles.set(householdId, p);
    }
    return p;
  }

  /**
   * The language to answer in: the call's, the member's in the household (the apps' Language
   * setting, which every app keeps), the one at sign-in, else English. Loaded. (A `lang` on the
   * profile, from before the household kept them, is not read.)
   */
  async lang(householdId: string | undefined, asked?: string): Promise<Lang> {
    const member = householdId && !isLang(asked) ? (await this.households()).find((h) => h.id === householdId)?.langs?.[this.email] : undefined;
    const lang = isLang(asked) ? asked : (member ?? this.props.lang ?? 'en');
    await loadLang(lang);
    return lang;
  }

  async clock(householdId: string | undefined, asked?: string): Promise<LocalClock> {
    const profile = householdId ? await this.profile(householdId) : {};
    const zone = [asked, profile.timeZone, this.props.timeZone].find(isTimeZone) ?? 'UTC';
    return new LocalClock(zone, this.realNow);
  }

  /** "Sam": the profile's first name, else the email's name part, for `addedBy`. */
  async firstName(householdId: string): Promise<string> {
    const { name } = await this.profile(householdId);
    const first = (name ?? '').trim().split(/\s+/)[0];
    if (first) return first.slice(0, 40);
    const local = this.email.split('@')[0].split(/[._+-]/)[0];
    return (local.charAt(0).toUpperCase() + local.slice(1)).slice(0, 40);
  }

  link(app: string, query = ''): string {
    return `${this.siteUrl.replace(/\/$/, '')}/${app}/${query}`;
  }

  record(householdId: string, entry: AuditEntry): void {
    this.audit(householdId, entry);
  }

  /** Reads `collection` under the household, as the person may (helpers and kids only open records). */
  async openRecords(here: Here, collection: string, privateCapable: boolean, where: Parameters<FirestoreRest['query']>[2] = {}): Promise<Doc[]> {
    const filters = [...(where.where ?? []), ...(privateCapable && here.restricted ? [{ field: 'private', op: 'EQUAL' as const, value: false }] : [])];
    return this.db.query(`households/${here.id}`, collection, { ...where, where: filters });
  }
}

export const isDenied = (e: unknown) => e instanceof FirestoreError && e.code === 'permission-denied';
