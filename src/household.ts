import { collection, deleteField, doc, getDocs, onSnapshot, query, where, type Firestore, type Unsubscribe } from 'firebase/firestore';
import { addDoc, arrayRemove, arrayUnion, setDoc, updateDoc } from './firestore.js';
import { observeHousehold } from './observability.js';
import { kt } from './i18n.js';
import { isCurrencyCode, setCurrency } from './money.js';
import { effectiveRoles, toRoles, type Role } from './roles.js';
import { homeDoc, setHome, toHome, type HomeCandidate, type HouseholdHome } from './home.js';
import { followMemberLang, type saveMyLang } from './member-lang.js';
import { cleanMemberLangs, setReaderHousehold, type MemberLangs } from './reader-langs.js';

/**
 * A household shared by every app in the family: one document per household in
 * `households/{householdId}`, with members identified by lowercase email. Apps keep their own data
 * in subcollections (`households/{id}/lists`, `/spendingTransactions`, ...), and security rules grant
 * access to members of the parent document — so adding someone here gives them every app at once.
 *
 * Shape matches the rules every app shares:
 *   { name: string, members: string[], joined?: string[], roles?: { [email]: Role }, langs?: { [email]: Lang }, currency?: string, home?: HouseholdHome, createdAt: number }
 */
export interface Household {
  id: string;
  name: string;
  /** Lowercase emails allowed in. Invited people are members before they first sign in. */
  members: string[];
  /** Members who have signed in at least once (each member records their own). */
  joined: string[];
  /** Roles written out (`./roles`); anyone missing is a member, except the creator (first), an admin. */
  roles?: Record<string, Role>;
  /** ISO 4217 code amounts are shown in ("USD", "EUR"); unset means US dollars. Admins and members set it. */
  currency?: string;
  /** Where the household lives (`./home`): every member reads it; admins and members set it. */
  home?: HouseholdHome;
  /** Each member's language (`./member-lang`), written by that member only; what published items are stored in (`./reader-langs`). */
  langs?: MemberLangs;
  createdAt: number;
}

export type HouseholdState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'ready'; household: Household }
  | { status: 'error'; error: Error };

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const COLLECTION = 'households';

/**
 * The household an app uses when a person belongs to several. Any member of any household can add
 * an email to it, so an invitation the person never acted on must not displace a household they
 * already use: households they have joined (opened an app in, see `markJoined`) come first, and
 * among those, or among invitations when they have joined none, the oldest, so every app picks the
 * same one. Documents still waiting for the server (a household created a moment ago on this
 * device) are skipped — the rules can't see them yet, so subscriptions under them would be refused.
 */
export function pickHousehold(
  docs: { id: string; data: Record<string, unknown>; pending?: boolean }[],
  email?: string,
): Household | null {
  const me = email ? normalizeEmail(email) : null;
  const households = docs
    .filter((d) => !d.pending)
    .map((d) => toHousehold(d.id, d.data))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return (me && households.find((h) => h.joined.includes(me))) || households[0] || null;
}

const membersQuery = (db: Firestore, email: string) =>
  query(collection(db, COLLECTION), where('members', 'array-contains', normalizeEmail(email)));

/**
 * Follows the household the signed-in person belongs to (see `pickHousehold`). Also keeps the
 * page's currency, home and members' languages (`./reader-langs`) set from it, and the member's
 * language in step with this page (`./member-lang`, which writes the member's own `langs` entry;
 * `followLang: false` leaves it alone, `{ save }` replaces the write, for tests). Several watchers in
 * one page write a change once.
 */
export function watchHousehold(
  db: Firestore,
  email: string,
  onChange: (state: HouseholdState) => void,
  { followLang = true }: { followLang?: boolean | { save: typeof saveMyLang } } = {},
): Unsubscribe {
  onChange({ status: 'loading' });
  const lang = followLang ? followMemberLang(db, email, followLang === true ? {} : followLang) : null;
  const stop = onSnapshot(
    membersQuery(db, email),
    { includeMetadataChanges: true },
    (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, data: d.data(), pending: d.metadata.hasPendingWrites }));
      // Stay loading while the only household is a local one the server hasn't accepted yet.
      if (docs.length && docs.every((d) => d.pending)) return;
      const household = pickHousehold(docs, email);
      // Every amount the kit formats follows the household's currency, and every distance and
      // nearby search its home.
      if (household) {
        setCurrency(household.currency);
        setHome(household.home);
      }
      // What the page publishes is stored in its readers' languages, and the member's follows them.
      setReaderHousehold(household);
      lang?.apply(
        household,
        docs
          .filter((d) => !d.pending)
          .map((d) => toHousehold(d.id, d.data))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
      );
      onChange(household ? { status: 'ready', household } : { status: 'none' });
    },
    (error) => onChange({ status: 'error', error }),
  );
  return () => {
    stop();
    lang?.stop();
  };
}

/** One-off lookup of the same household `watchHousehold` follows; null when not a member anywhere. */
export async function findHousehold(db: Firestore, email: string): Promise<Household | null> {
  const snap = await getDocs(membersQuery(db, email));
  return pickHousehold(snap.docs.map((d) => ({ id: d.id, data: d.data() })), email);
}

export function toHousehold(id: string, data: Record<string, unknown>): Household {
  return {
    id,
    name: String(data.name ?? 'Household'),
    members: Array.isArray(data.members) ? data.members.map(String) : [],
    joined: Array.isArray(data.joined) ? data.joined.map(String) : [],
    roles: toRoles(data.roles),
    ...(isCurrencyCode(data.currency) ? { currency: data.currency } : {}),
    ...(toHome(data.home) ? { home: toHome(data.home) } : {}),
    ...((langs) => (langs ? { langs } : {}))(cleanMemberLangs(data.langs)),
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
  };
}

/** Sets the currency the household's amounts are shown in (admins and members; the rules check). */
export async function setHouseholdCurrency(db: Firestore, householdId: string, currency: string): Promise<void> {
  if (!isCurrencyCode(currency)) throw new Error(`Not a currency code: ${currency}`);
  await updateDoc(doc(db, COLLECTION, householdId), { currency });
}

/**
 * Sets where the household lives (admins and members; the rules check): a found address, a
 * position, or with `approximate` only the neighbourhood. The zone is this browser's.
 */
export async function setHouseholdHome(db: Firestore, householdId: string, home: HomeCandidate, by: string, options?: { timeZone?: string; now?: number }): Promise<HouseholdHome> {
  const saved = homeDoc(home, by, options);
  await updateDoc(doc(db, COLLECTION, householdId), { home: saved });
  return saved;
}

/** Forgets where the household lives. */
export async function clearHouseholdHome(db: Firestore, householdId: string): Promise<void> {
  await updateDoc(doc(db, COLLECTION, householdId), { home: deleteField() });
}

/**
 * Starts a household with only its creator, its admin; others are invited from inside. Pass the
 * signed-in `user` (`auth.currentUser`, required so a stale call site fails to compile) and the household gets the id `first-<their Firebase uid>`,
 * which the rules accept only from them: calling this twice (a double tap, a retry, a second tab)
 * writes the same document, and the repeat, refused by the rules, returns the household already
 * made rather than a second. When that id is not theirs to write (they were removed from their
 * first household), or `user` is null, or its email is not `email`, a household with a random
 * id is made, as before. Resolves to the household's id either way.
 */
export async function createHousehold(db: Firestore, email: string, name: string, user: { uid: string; email?: string | null } | null): Promise<string> {
  const me = normalizeEmail(email);
  const data = { name: name.trim(), members: [me], roles: { [me]: 'admin' }, createdAt: Date.now() };
  const uid = user && (!user.email || normalizeEmail(user.email) === me) ? user.uid : undefined;
  const random = async () => (await addDoc(collection(db, COLLECTION), data)).id;
  if (!uid) return random();
  const id = `first-${uid}`;
  try {
    await setDoc(doc(db, COLLECTION, id), data);
    return id;
  } catch (e) {
    if ((e as { code?: string }).code !== 'permission-denied') throw e;
  }
  // Refused: either the repeat of a household I made (the rules refuse an update that changes createdAt), or the id is taken.
  const mine = await getDocs(query(collection(db, COLLECTION), where('members', 'array-contains', me)));
  if (mine.docs.some((d) => d.id === id && (d.data() as { roles?: Record<string, unknown> }).roles?.[me] === 'admin')) return id;
  return random();
}

type People = Pick<Household, 'id' | 'members' | 'roles' | 'langs'>;

/**
 * Invites by email (admins only): they get every app the next time they sign in with that Google
 * account, as a member unless `role` says otherwise. Pass the household to give a role.
 */
export async function inviteMember(db: Firestore, household: string | People, email: string, role: Role = 'member'): Promise<void> {
  const address = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error(kt('household.notEmail', { email }));
  const id = typeof household === 'string' ? household : household.id;
  if (role === 'member') {
    await updateDoc(doc(db, COLLECTION, id), { members: arrayUnion(address) });
    return;
  }
  if (typeof household === 'string') throw new Error('Pass the household to invite someone with a role.');
  if (household.members.includes(address)) throw new Error(kt('household.alreadyIn', { email: address }));
  await updateDoc(doc(db, COLLECTION, id), {
    members: arrayUnion(address),
    roles: { ...effectiveRoles(household), [address]: role },
  });
}

/**
 * Removes someone (admins only, never themselves). With the household, their role and language go
 * too and everyone else's role is written out, so removing the creator never makes the next person
 * an admin by position; the rules refuse a removal that would leave a role behind.
 */
export async function removeMember(db: Firestore, household: string | People, email: string): Promise<void> {
  const address = normalizeEmail(email);
  if (typeof household === 'string') {
    await updateDoc(doc(db, COLLECTION, household), { members: arrayRemove(address) });
    return;
  }
  const rest = household.members.filter((m) => m !== address);
  const { [address]: _gone, ...roles } = effectiveRoles(household);
  const { [address]: _lang, ...langs } = household.langs ?? {};
  await updateDoc(doc(db, COLLECTION, household.id), {
    members: rest,
    roles: Object.fromEntries(rest.map((m) => [m, roles[m]!])),
    ...(household.langs && address in household.langs ? { langs } : {}),
  });
}

/** Records the signed-in member's first visit; harmless to call on every sign-in. */
export async function markJoined(db: Firestore, household: Household, email: string): Promise<void> {
  const address = normalizeEmail(email);
  if (household.joined.includes(address) || !household.members.includes(address)) return;
  await updateDoc(doc(db, COLLECTION, household.id), { joined: arrayUnion(address) });
}

/** Members who were invited but have not signed in yet. */
export function pendingMembers(household: Household): string[] {
  return household.members.filter((m) => !household.joined.includes(m));
}

/**
 * A member's name and photo as their own Google account reports them. Google has no public lookup
 * from an email to a profile, so each member records their own on sign-in
 * (`households/{id}/profiles/{email}`, writable only by that member).
 */
export interface Profile {
  email: string;
  name?: string;
  photoURL?: string;
  updatedAt: number;
}

/**
 * Records the signed-in member's name and photo; cheap to call on every sign-in. Also tags this
 * visit's usage counts with the household's hash (`./observability`), so active households can be
 * counted without knowing which.
 */
export async function saveMyProfile(
  db: Firestore,
  householdId: string,
  user: { email: string | null; displayName: string | null; photoURL: string | null },
): Promise<void> {
  if (!user.email) return;
  const email = normalizeEmail(user.email);
  const profile: Record<string, unknown> = { updatedAt: Date.now() };
  if (user.displayName) profile.name = user.displayName.slice(0, 100);
  if (user.photoURL?.startsWith('https://')) profile.photoURL = user.photoURL.slice(0, 500);
  void observeHousehold(householdId);
  await setDoc(doc(db, COLLECTION, householdId, 'profiles', email), profile);
}

/** Follows the profiles members have recorded, keyed by email. */
export function watchProfiles(
  db: Firestore,
  householdId: string,
  onChange: (profiles: Map<string, Profile>) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db, COLLECTION, householdId, 'profiles'),
    (snap) =>
      onChange(
        new Map(
          snap.docs.map((d) => {
            const data = d.data();
            return [
              d.id,
              {
                email: d.id,
                name: typeof data.name === 'string' ? data.name : undefined,
                photoURL: typeof data.photoURL === 'string' ? data.photoURL : undefined,
                updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
              },
            ];
          }),
        ),
      ),
    (error) => onError?.(error),
  );
}
