import { collection, doc, onSnapshot, query, where, type Firestore, type Unsubscribe } from 'firebase/firestore';
import { addDoc, deleteDoc, deleteField, setDoc, updateDoc, writeBatch } from './firestore.js';
import {
  CONTACT_PAY_COLLECTION,
  backfillPositions,
  cleanContact,
  cleanContactPay,
  contactPayDoc,
  tidyContactPay,
  toContact,
  withContactPay,
  type Contact,
  type ContactInput,
  type ContactPay,
  type ContactPayKind,
} from './contact-core.js';
import { geocodeAddress, getHome, onHomeChange } from './home.js';

/**
 * The household's contacts over the Firebase SDK. The data contract and the screen helpers are in
 * `./contact-core` (re-exported here), which servers import without Firebase.
 */
export * from './contact-core.js';

const contactsOf = (db: Firestore, householdId: string) => collection(db, 'households', householdId, 'contacts');
const payOf = (db: Firestore, householdId: string) => collection(db, 'households', householdId, CONTACT_PAY_COLLECTION);

export interface WatchContactsOptions {
  /** Only those shown in this app: only those are read. */
  app?: string;
  /**
   * Whether each contact carries its pay details (`contactPay`), read whole: by default only
   * without `app` (the portal, Bills), since an app's own list doesn't show them. Never with
   * `restricted`. Only a whole-list watch removes the pay details of deleted contacts.
   */
  pay?: boolean;
  /**
   * A helper or kid (`isRestricted(role)`): only contacts not marked private, as the rules require,
   * and no pay details (never read, so no permission error either).
   */
  restricted?: boolean;
  /** Who is signed in, for the `by` of pay details tidied on load (see `tidyContactPay`). */
  by?: string;
  /**
   * Looks up contacts saved with an address but no position (before positions existed), so they
   * say how far from home they are: once the list has come from the server and the household has
   * a home, up to `limit` of them (`POSITION_BACKFILL_LIMIT`), one a second at most through the
   * kit's Nominatim queue and cache, only while the page is showing. An address the map can't find
   * is marked `geoTried` and left for 30 days. Admins and members only (ignored with `restricted`).
   */
  backfillPositions?: boolean | { limit?: number };
  onError?: (error: Error) => void;
}

/**
 * Follows the household's contacts, optionally only those shown in one app (the only ones read),
 * sorted by name. Pass `restricted` for helpers and kids: the rules refuse them a list that could
 * include private ones, and pay details. With `pay` (the default without `app`) each contact carries
 * its pay details (`contactPay`) and the first list waits for both; on the whole list (no `app`),
 * once both have come from the server, any pay details still on a contact's own document are moved
 * to `contactPay` and those of deleted contacts removed.
 */
export function watchContacts(
  db: Firestore,
  householdId: string,
  onChange: (contacts: Contact[]) => void,
  { app, pay: withPay = !app, restricted, by, backfillPositions: backfill, onError }: WatchContactsOptions = {},
): Unsubscribe {
  const all = contactsOf(db, householdId);
  const readPay = withPay && !restricted;
  let raw: { id: string; data: Record<string, unknown> }[] | null = null;
  let payDocs: { id: string; data: Record<string, unknown> }[] | null = readPay ? null : [];
  let fromServer = { contacts: false, pay: !readPay };
  let tidied = false;
  const tidy = () => {
    // Only over the whole list: pay details of a contact another app shows aren't orphans.
    if (!readPay || app || tidied || !raw || !payDocs || !fromServer.contacts || !fromServer.pay) return;
    tidied = true;
    tidyPay(db, householdId, raw, payDocs, by).catch((e) => console.warn('Moving contact pay details failed', e));
  };
  const emit = () => {
    if (!raw || !payDocs) return;
    const pay = new Map<string, ContactPay>();
    for (const p of payDocs) {
      const clean = cleanContactPay(p.data);
      if (clean) pay.set(p.id, clean);
    }
    onChange(
      withContactPay(
        raw.map((d) => toContact(d.id, d.data)),
        pay,
      )
        .filter((c) => !app || c.apps.includes(app))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  };
  const stopBackfill = new AbortController();
  let backfillStarted = false;
  const startBackfill = () => {
    if (!backfill || restricted || backfillStarted || !raw || !fromServer.contacts || !getHome() || stopBackfill.signal.aborted) return;
    backfillStarted = true;
    backfillPositions(raw, {
      geocode: async (address) => (await geocodeAddress(address))[0] ?? null,
      write: (id, update) =>
        updateDoc(doc(all, id), 'geoTried' in update ? update : { ...update, geoTried: deleteField() }),
      current: (id) => raw?.find((d) => d.id === id)?.data,
      whenVisible: () => whenVisible(stopBackfill.signal),
      limit: typeof backfill === 'object' ? backfill.limit : undefined,
      signal: stopBackfill.signal,
    }).catch((e) => console.warn('Looking up contact positions failed', e));
  };
  const unsubs = [
    onHomeChange(startBackfill),
    () => stopBackfill.abort(),
    onSnapshot(
      contactsQuery(all, app, restricted),
      { includeMetadataChanges: !restricted },
      (snap) => {
        const first = raw === null;
        raw = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        if (!snap.metadata.fromCache) fromServer = { ...fromServer, contacts: true };
        // With metadata changes on (for the tidy and the backfill), a snapshot that only says "now from the server" isn't a new list.
        if (first || snap.docChanges().length) emit();
        tidy();
        startBackfill();
      },
      (error) => onError?.(error),
    ),
  ];
  if (readPay) {
    unsubs.push(
      onSnapshot(
        payOf(db, householdId),
        { includeMetadataChanges: true },
        (snap) => {
          const first = payDocs === null;
          payDocs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
          if (!snap.metadata.fromCache) fromServer = { ...fromServer, pay: true };
          if (first || snap.docChanges().length) emit();
          tidy();
        },
        // Contacts still show without their pay details (rules not yet deployed, a role just changed).
        (error) => {
          console.warn('Contact pay details unavailable', error);
          payDocs = [];
          emit();
        },
      ),
    );
  }
  return () => unsubs.forEach((u) => u());
}

/** What `watchContacts` reads: one app's contacts, and for helpers and kids only those not private (both indexed single fields). */
function contactsQuery(all: ReturnType<typeof contactsOf>, app: string | undefined, restricted: boolean | undefined) {
  const filters = [...(app ? [where('apps', 'array-contains', app)] : []), ...(restricted ? [where('private', '==', false)] : [])];
  return filters.length ? query(all, ...filters) : all;
}

/** Resolves true once the page is showing (at once when it is, or outside a browser); false when stopped first. */
function whenVisible(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (showing: boolean) => {
      document.removeEventListener('visibilitychange', onChange);
      signal.removeEventListener('abort', onAbort);
      resolve(showing);
    };
    const onChange = () => document.visibilityState === 'visible' && done(true);
    const onAbort = () => done(false);
    document.addEventListener('visibilitychange', onChange);
    signal.addEventListener('abort', onAbort);
  });
}

async function tidyPay(
  db: Firestore,
  householdId: string,
  contacts: { id: string; data: Record<string, unknown> }[],
  pay: { id: string; data: Record<string, unknown> }[],
  by: string | undefined,
): Promise<void> {
  const now = Date.now();
  const { moves, orphans } = tidyContactPay(contacts, pay, now);
  const existing = new Set(pay.map((p) => p.id));
  const writes = [
    ...moves.map((m) => (batch: ReturnType<typeof writeBatch>) => {
      const data = cleanContactPay(m.pay);
      if (data) batch.set(doc(payOf(db, householdId), m.id), { ...data, updatedAt: now, ...(by ? { by } : {}) });
      else if (existing.has(m.id)) batch.delete(doc(payOf(db, householdId), m.id));
      batch.update(doc(contactsOf(db, householdId), m.id), { pay: deleteField() });
    }),
    ...orphans.map((id) => (batch: ReturnType<typeof writeBatch>) => batch.delete(doc(payOf(db, householdId), id))),
  ];
  for (let i = 0; i < writes.length; i += 200) {
    const batch = writeBatch(db);
    for (const w of writes.slice(i, i + 200)) w(batch);
    await batch.commit();
  }
}

/** Writes the contact's pay details (`contactPay`) in `batch`: set, or deleted when none are left. */
function putPay(batch: ReturnType<typeof writeBatch>, db: Firestore, householdId: string, id: string, pay: unknown, by: string, now: number) {
  const data = contactPayDoc(pay, by, now);
  const ref = doc(payOf(db, householdId), id);
  if (data) batch.set(ref, data);
  else batch.delete(ref);
}

/** Adds a contact; its pay details, when `input` has some, go to `contactPay` (admins and members only). */
export async function addContact(db: Firestore, householdId: string, input: ContactInput, by: string): Promise<string> {
  const now = Date.now();
  const data = { ...cleanContact(input), createdAt: now, by };
  if (!cleanContactPay(input.pay)) return (await addDoc(contactsOf(db, householdId), data)).id;
  const ref = doc(contactsOf(db, householdId));
  const batch = writeBatch(db);
  batch.set(ref, data);
  putPay(batch, db, householdId, ref.id, input.pay, by, now);
  await batch.commit();
  return ref.id;
}

/**
 * Replaces the contact's details; fields left empty are removed. Pay details are replaced only when
 * `input` has `pay` (`{}` removes them), so an app that doesn't show them never drops them, and a
 * helper's or kid's save (which never has them) never touches them.
 */
export async function updateContact(db: Firestore, householdId: string, id: string, input: ContactInput, by: string): Promise<void> {
  const now = Date.now();
  const cleaned = cleanContact(input) as Record<string, unknown>;
  const update: Record<string, unknown> = { ...cleaned, updatedAt: now, by };
  for (const k of ['role', 'phone', 'email', 'website', 'address', 'lat', 'lng', 'geoTried', 'mapsUrl', 'notes']) if (!(k in cleaned)) update[k] = deleteField();
  if (!('pay' in input)) return updateDoc(doc(contactsOf(db, householdId), id), update);
  const batch = writeBatch(db);
  batch.update(doc(contactsOf(db, householdId), id), update);
  putPay(batch, db, householdId, id, input.pay, by, now);
  await batch.commit();
}

/**
 * Remembers one pay detail for a contact (the Zelle phone a bill was paid to), keeping the others;
 * an empty value forgets it. Admins and members only (the rules).
 */
export async function setContactPay(db: Firestore, householdId: string, id: string, kind: ContactPayKind, value: string, by: string): Promise<void> {
  const v = cleanContactPay({ [kind]: value })?.[kind];
  await setDoc(doc(payOf(db, householdId), id), { [kind]: v ?? deleteField(), updatedAt: Date.now(), by }, { merge: true });
}

/**
 * Deletes a contact. With `pay` (an admin or member whose list carries them) its pay details go
 * too. Without it (a helper or kid, or an app's own list, which doesn't read them) they stay, so
 * Undo (`restoreContact`) finds them still there, until the next whole-list `watchContacts` (the
 * portal's or Bills') removes them as orphans a day later (`tidyContactPay`).
 */
export async function deleteContact(db: Firestore, householdId: string, id: string, { pay = false }: { pay?: boolean } = {}): Promise<void> {
  if (!pay) return deleteDoc(doc(contactsOf(db, householdId), id));
  const batch = writeBatch(db);
  batch.delete(doc(contactsOf(db, householdId), id));
  batch.delete(doc(payOf(db, householdId), id));
  await batch.commit();
}

/**
 * What deleting a contact in one app means: it stops showing there, and is only deleted outright
 * when no other app shows it (the pediatrician stays in a health app after Baby drops it). Its pay
 * details go with it only when the contact carries them (see `deleteContact`).
 */
export async function removeContactFromApp(db: Firestore, householdId: string, contact: Contact, app: string, by: string): Promise<void> {
  const others = contact.apps.filter((a) => a !== app);
  if (others.length === 0) return deleteContact(db, householdId, contact.id, { pay: !!contact.pay });
  await updateDoc(doc(contactsOf(db, householdId), contact.id), { apps: others, updatedAt: Date.now(), by });
}

/**
 * Writes `private: false` on records saved before the flag existed, which helpers and kids can't
 * read until then. Admins and members only (`can(role, 'see-private')`), for any private-capable
 * collection (contacts, an app's appointments); cheap to run whenever the list loads, since it
 * writes only records without the flag.
 */
export async function markUnflaggedOpen(db: Firestore, householdId: string, collectionName: string, records: { id: string; private?: unknown }[]): Promise<number> {
  const unflagged = records.filter((r) => typeof r.private !== 'boolean');
  for (let i = 0; i < unflagged.length; i += 450) {
    const batch = writeBatch(db);
    for (const r of unflagged.slice(i, i + 450)) batch.update(doc(db, 'households', householdId, collectionName, r.id), { private: false });
    await batch.commit();
  }
  return unflagged.length;
}

/**
 * Puts a deleted contact back under its old id (Undo), so appointments that point at it still do,
 * with its pay details when it carried them (an admin's or member's contact).
 */
export async function restoreContact(db: Firestore, householdId: string, contact: Contact): Promise<void> {
  const { id, createdAt, updatedAt, by, ...input } = contact;
  const data = { ...cleanContact(input), createdAt, ...(updatedAt ? { updatedAt } : {}), by };
  if (!cleanContactPay(contact.pay)) return setDoc(doc(contactsOf(db, householdId), id), data);
  const batch = writeBatch(db);
  batch.set(doc(contactsOf(db, householdId), id), data);
  // No `by`: whoever undoes may not be who last wrote them, and the rules take `by` as the writer.
  batch.set(doc(payOf(db, householdId), id), { ...cleanContactPay(contact.pay), updatedAt: Date.now() });
  await batch.commit();
}

/** The three contact writes an app's actions make, over Firestore or the sample's memory. */
export interface ContactWrites {
  save(id: string | null, input: ContactInput): void;
  /** Stops showing it in this app (`removeContactFromApp`). */
  remove(contact: Contact): void;
  /** Puts it back as it was (Undo). */
  restore(contact: Contact): void;
}

/**
 * The contact writes for an app's signed-out sample, on a list in memory: a save is cleaned and
 * stamped like `addContact` / `updateContact`, a removal drops it from the list, a restore puts it
 * back under its id. A list sorted by name stays sorted.
 */
export function sampleContacts(
  read: () => Contact[],
  write: (contacts: Contact[]) => void,
  { by, now, newId }: { by: string; now: () => number; newId: () => string },
): ContactWrites {
  const put = (contact: Contact) => write([...read().filter((c) => c.id !== contact.id), contact].sort((a, b) => a.name.localeCompare(b.name)));
  return {
    save: (id, input) => {
      const existing = id ? read().find((c) => c.id === id) : undefined;
      const t = now();
      // As updateContact: pay details left out of `input` are kept.
      const kept = existing?.pay && !('pay' in input) ? { pay: existing.pay } : {};
      put({ id: id ?? newId(), ...kept, ...cleanContact(input), createdAt: existing?.createdAt ?? t, ...(existing ? { updatedAt: t } : {}), by });
    },
    remove: (contact) => write(read().filter((c) => c.id !== contact.id)),
    restore: put,
  };
}

/** The contact writes for a signed-in household, each failure passed to `report` (an error toast). */
export function householdContacts(db: Firestore, householdId: string, app: string, by: string, report: (write: Promise<unknown>) => void): ContactWrites {
  return {
    save: (id, input) => report(id ? updateContact(db, householdId, id, input, by) : addContact(db, householdId, input, by)),
    // A contact other apps also show stays for them; this app only stops showing it.
    remove: (contact) => report(removeContactFromApp(db, householdId, contact, app, by)),
    restore: (contact) => report(restoreContact(db, householdId, contact)),
  };
}

export {
  SHARED_CONTACT_KEY,
  SHARED_CONTACT_PARAM,
  SHARE_CACHE,
  clearSharedContact,
  contactFromCard,
  contactPickerSupported,
  contactSummary,
  fromPickerContact,
  isVCard,
  parseVCard,
  pickContact,
  readSharedContact,
} from './vcard';
export type { ContactFill, ContactFillOptions, LabelledValue, ParsedContact } from './vcard';
export { GOOGLE_CONTACTS_LIMIT, GOOGLE_CONTACTS_SCOPES, fromGooglePerson, googleContactsAvailable, googleContactsToken, searchGoogleContacts } from './google-contacts';
