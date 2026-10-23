// Read budgets of the kit's shared sync paths (STANDARD.md "Read budgets"), against the Firestore
// emulator (`bun run test:emulator`): reads counted from the SDK's own results and snapshots as
// Firestore bills them. Its own `bun test` process: it replaces firebase/firestore with the counted
// module for the whole process.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { readCounter, expectReads, writeBeforeEachRead } from '../../src/read-test';

const real = await import('firebase/firestore');
const counter = readCounter();
mock.module('firebase/firestore', () => counter.sdk(real));

const { connectFirestoreEmulator, doc, getDoc, getFirestore, memoryLocalCache, initializeFirestore, setDoc, terminate } = await import('firebase/firestore');
const { syncReminders, syncPersonalReminders } = await import('../../src/reminders');
const { syncTodos } = await import('../../src/todos');
const { syncAgenda } = await import('../../src/agenda');
const { saveMyProfile, watchHousehold, watchProfiles } = await import('../../src/household');
const { watchContacts } = await import('../../src/contacts');

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const DAY = 24 * 3_600_000;
const NOW = Date.now();
const ME = 'alex@example.com';

let app: FirebaseApp;
let db: ReturnType<typeof getFirestore>;
/** A second client: another member's device, whose writes the counter doesn't see as this one's reads. */
let other: FirebaseApp;
let otherDb: ReturnType<typeof getFirestore>;
const run = `r${NOW.toString(36)}`;
const household = `${run}-h`;

beforeAll(async () => {
  if (!emulator) return;
  const [host, port] = emulator.split(':');
  app = initializeApp({ apiKey: 'demo', projectId: 'demo-kit-reads', appId: 'demo' }, `reads-${run}`);
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
  connectFirestoreEmulator(db, host, Number(port));
  other = initializeApp({ apiKey: 'demo', projectId: 'demo-kit-reads', appId: 'demo' }, `reads-other-${run}`);
  otherDb = initializeFirestore(other, { localCache: memoryLocalCache() });
  connectFirestoreEmulator(otherDb, host, Number(port));
  counter.reset();
  await setDoc(doc(otherDb, `households/${household}`), { name: 'Home', members: [ME, 'sam@example.com'], joined: [ME], createdAt: NOW });
});

afterAll(async () => {
  if (!emulator) return;
  await terminate(db);
  await terminate(otherDb);
  await deleteApp(app);
  await deleteApp(other);
});

const reminders = (n: number, app = 'pet') => Array.from({ length: n }, (_, i) => ({ ref: `walk:${i}`, title: `Walk ${i}`, body: 'Outside', at: NOW + (i + 1) * DAY, url: 'https://example.test/pet/' })).map((r) => ({ ...r, app }));
const agenda = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `visit:${i}`, kind: 'appointment' as const, title: `Visit ${i}`, start: NOW + (i + 1) * DAY, allDay: true, url: 'https://example.test/pet/' }));
const todos = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `job:${i}`, title: `Job ${i}`, createdAt: NOW - DAY, url: 'https://example.test/home/' }));

describe.skipIf(!emulator)('sync paths: one query of what the app published, nothing when this device just published the same', () => {
  test('syncReminders', async () => {
    const items = reminders(12);
    // First publish: one query that finds nothing (billed 1).
    await expectReads(() => syncReminders(db, household, 'pet', items, ME, NOW, { published: null }), { max: 1, min: 1, counter, label: 'syncReminders, first' });
    // Again, without this device's note: the query returns the app's 12.
    await expectReads(() => syncReminders(db, household, 'pet', items, ME, NOW, { published: null }), { max: 12, counter, label: 'syncReminders, again' });
    // With the note: nothing read.
    const notes = new Map<string, string>();
    const store = { getItem: (k: string) => notes.get(k) ?? null, setItem: (k: string, v: string) => void notes.set(k, v), removeItem: (k: string) => void notes.delete(k), key: (i: number) => [...notes.keys()][i] ?? null, get length() { return notes.size; } };
    await syncReminders(db, household, 'pet', items, ME, NOW, { published: store });
    await expectReads(() => syncReminders(db, household, 'pet', items, ME, NOW, { published: store }), { max: 0, counter, label: 'syncReminders, published' });
  });

  test('syncPersonalReminders, syncAgenda and syncTodos', async () => {
    const personal = reminders(5, 'health').map((r) => ({ ...r, audience: [ME], recipients: [ME] }));
    await syncPersonalReminders(db, household, 'health', personal, ME, NOW, { published: null });
    await expectReads(() => syncPersonalReminders(db, household, 'health', personal, ME, NOW, { published: null }), { max: 5, counter, label: 'syncPersonalReminders' });
    await syncAgenda(db, household, 'pet', agenda(8), { by: ME, now: NOW, published: null });
    await expectReads(() => syncAgenda(db, household, 'pet', agenda(8), { by: ME, now: NOW, published: null }), { max: 8, counter, label: 'syncAgenda' });
    await syncTodos(db, household, 'home', todos(6), { by: ME, now: NOW, published: null });
    await expectReads(() => syncTodos(db, household, 'home', todos(6), { by: ME, now: NOW, published: null }), { max: 6, counter, label: 'syncTodos' });
  });
});

describe.skipIf(!emulator)('interleaving: another device writes before each read; the sync still finishes in one pass', () => {
  test('syncReminders: a reminder another device added is removed, one query read', async () => {
    const items = reminders(4, 'car');
    await syncReminders(db, household, 'car', items, ME, NOW, { published: null });
    const extra = `households/${household}/reminders/car-stale`;
    const { value } = await expectReads(() => syncReminders(db, household, 'car', items, ME, NOW, { published: null }), {
      max: 5,
      counter,
      label: 'syncReminders with a write before its read',
      beforeRead: writeBeforeEachRead(() => setDoc(doc(otherDb, extra), { app: 'car', ref: 'stale', title: 'Old', body: '', at: NOW + DAY, sent: false, url: 'https://example.test/car/', updatedAt: NOW, by: 'sam@example.com' })),
    });
    expect(value).toMatchObject({ deleted: 1, unchanged: 4 });
  });
});

describe.skipIf(!emulator)('watchHousehold', () => {
  test("the member's household when it starts (1 read), then one read per change to it", async () => {
    let ready = 0;
    let stop = () => {};
    await expectReads(
      () =>
        new Promise<void>((resolve) => {
          stop = watchHousehold(db, ME, (s) => {
            if (s.status === 'ready' && ++ready === 1) resolve();
          }, { followLang: false });
        }),
      { max: 1, min: 1, counter, label: 'watchHousehold, start' },
    );
    await expectReads(
      async () => {
        await setDoc(doc(otherDb, `households/${household}`), { name: 'Our home' }, { merge: true });
        for (let i = 0; i < 50 && ready < 2; i++) await new Promise((r) => setTimeout(r, 20));
      },
      { max: 1, min: 1, counter, label: 'watchHousehold, a change' },
    );
    stop();
  });
});

/** Resolves once `ready()` holds, polling the listeners' results (at most a second). */
async function until(ready: () => boolean) {
  for (let i = 0; i < 50 && !ready(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(ready()).toBe(true);
}

describe.skipIf(!emulator)('watchContacts', () => {
  test("an app's list reads only the contacts it shows, and no pay details; the whole list reads them all", async () => {
    const contacts = `households/${household}/contacts`;
    const people = [
      ['vet', { name: 'Example Vet', apps: ['pet'], private: false }],
      ['groomer', { name: 'Example Groomer', apps: ['pet', 'home'], private: false }],
      ['plumber', { name: 'Example Plumber', apps: ['home'], private: false }],
      ['garage', { name: 'Example Garage', apps: ['car'], private: false }],
      ['doctor', { name: 'Example Doctor', apps: ['health'], private: true }],
    ] as const;
    for (const [id, data] of people) await setDoc(doc(otherDb, `${contacts}/${id}`), { ...data, createdAt: NOW, by: ME });
    await setDoc(doc(otherDb, `households/${household}/contactPay/plumber`), { zelle: 'plumber@example.com', updatedAt: NOW, by: ME });

    const watch = async (options: Parameters<typeof watchContacts>[3], label: string, reads: number) => {
      let seen: { id: string; pay?: unknown }[] | undefined;
      let stop = () => {};
      await expectReads(
        async () => {
          stop = watchContacts(db, household, (c) => (seen = c), options);
          await until(() => seen !== undefined);
        },
        { max: reads, min: reads, counter, label },
      );
      stop();
      return seen!;
    };
    // Pet's list: its 2 contacts (the 3 others aren't read).
    expect((await watch({ app: 'pet' }, 'watchContacts, one app', 2)).map((c) => c.id).sort()).toEqual(['groomer', 'vet']);
    // A helper's Health: the app's contacts not marked private, here none (billed 1, as an empty result is).
    expect(await watch({ app: 'health', restricted: true }, "watchContacts, a helper's app", 1)).toEqual([]);
    // Pay details on request: the app's contacts and every pay document.
    expect((await watch({ app: 'home', pay: true }, 'watchContacts, one app with pay', 3)).find((c) => c.id === 'plumber')?.pay).toEqual({ zelle: 'plumber@example.com' });
    // The portal's whole list: all 5 and the pay document.
    expect(await watch({}, 'watchContacts, the whole list', 6)).toHaveLength(5);
  });
});

describe.skipIf(!emulator)('saveMyProfile', () => {
  test("writes only what changed, so a device following the profiles isn't billed for every app open; keeps the language and time zone", async () => {
    const path = `households/${household}/profiles/${ME}`;
    await setDoc(doc(otherDb, path), { lang: 'nl', timeZone: 'Europe/Amsterdam', updatedAt: NOW });
    const notes = new Map<string, string>();
    const published = { getItem: (k: string) => notes.get(k) ?? null, setItem: (k: string, v: string) => void notes.set(k, v), removeItem: (k: string) => void notes.delete(k), key: (i: number) => [...notes.keys()][i] ?? null, get length() { return notes.size; } };
    const user = { email: ME, displayName: 'Alex Example', photoURL: 'https://example.com/alex.png' };

    // Another member's device follows the profiles.
    let changes = 0;
    let names: (string | undefined)[] = [];
    const stop = watchProfiles(otherDb, household, (profiles) => {
      changes++;
      names = [...profiles.values()].map((p) => p.name);
    });
    await until(() => changes > 0);

    const opened = async (label: string, reads: number, next = user, at = NOW) => {
      const before = changes;
      await expectReads(
        async () => {
          await saveMyProfile(db, household, next, { now: at, published });
          if (reads) await until(() => changes > before);
          else await new Promise((r) => setTimeout(r, 200));
        },
        { max: reads, min: reads, counter, label },
      );
    };
    await opened('saveMyProfile, first open', 1);
    await opened('saveMyProfile, opened again', 0);
    await opened('saveMyProfile, a new name', 1, { ...user, displayName: 'Alex E.' });
    await opened('saveMyProfile, a day later', 1, { ...user, displayName: 'Alex E.' }, NOW + DAY);
    stop();

    expect(names).toEqual(['Alex E.']);
    expect((await getDoc(doc(otherDb, path))).data()).toMatchObject({ name: 'Alex E.', photoURL: 'https://example.com/alex.png', lang: 'nl', timeZone: 'Europe/Amsterdam' });
  });
});
