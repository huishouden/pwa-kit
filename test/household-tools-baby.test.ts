import { afterAll, describe, expect, test } from 'bun:test';
import { setTimeZone } from './tz';
import { checkArgs, runTool, Session, toolNamed } from '../src/household-tools';
import type { Doc, FirestoreRest, Write } from '../src/firestore-rest';

// Baby's settings through the shared tools, on an in-memory Firestore. 13:00 UTC is 08:00 in New
// York; 19:00 there is 00:00 UTC the next day.
afterAll(setTimeZone('UTC'));

const NOW = Date.UTC(2031, 0, 6, 13);
const SAM = 'sam@example.com';
const JO = 'jo@example.com';
const KIM = 'kim@example.com';
const H = 'households/h1';

type Data = Record<string, unknown>;

/** Enough of FirestoreRest for the tools: documents by path, equality and array-contains filters, atomic commits. */
function memoryDb(seed: Record<string, Data>) {
  const docs = new Map(Object.entries(seed));
  const commits: Write[][] = [];
  const toDoc = (path: string, data: Data): Doc => ({ id: path.split('/').pop()!, path, data });
  const db = {
    get: async (path: string) => (docs.has(path) ? toDoc(path, docs.get(path)!) : null),
    query: async (parent: string, collection: string, { where = [] }: { where?: { field: string; op: string; value: unknown }[] } = {}) => {
      const prefix = `${parent ? `${parent}/` : ''}${collection}/`;
      return [...docs.entries()]
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .filter(([, d]) => where.every((w) => (w.op === 'EQUAL' ? d[w.field] === w.value : w.op === 'ARRAY_CONTAINS' ? Array.isArray(d[w.field]) && (d[w.field] as unknown[]).includes(w.value) : true)))
        .map(([p, d]) => toDoc(p, d));
    },
    commit: async (writes: Write[]) => {
      commits.push(writes);
      for (const w of writes) {
        if ('delete' in w) docs.delete(w.path);
        else if ('set' in w) docs.set(w.path, w.set);
        else if ('create' in w) docs.set(w.path, w.create);
        else docs.set(w.path, { ...(docs.get(w.path) ?? {}), ...w.merge });
      }
    },
  } as unknown as FirestoreRest;
  return { db, docs, commits };
}

function household(extra: Record<string, Data> = {}) {
  return memoryDb({
    [H]: { name: 'Home', members: [SAM, JO, KIM], joined: [SAM, JO, KIM], roles: { [JO]: 'helper', [KIM]: 'kid' }, createdAt: 1 },
    ...extra,
  });
}

const run = (email: string, db: FirestoreRest, tool: string, args: Record<string, unknown>) =>
  runTool(new Session({ uid: email, email, connectionId: `hh-${email}`, timeZone: 'America/New_York' }, db, 'https://example.web.app', () => NOW), toolNamed(tool)!, args);

const kickReminder = (day: string, at: number, extra: Data = {}): Data => ({ app: 'baby', title: 'Time for a kick count', body: '', at, url: 'https://example.web.app/baby/#kicks', recipients: 'all', ref: `kicks:${day}`, private: true, sent: false, createdAt: 1, by: SAM, ...extra });

describe('baby_settings', () => {
  test("Baby's defaults when nothing is saved, for a helper too", async () => {
    const call = await run(JO, household().db, 'baby_settings', {});
    expect(call.result.error).toBeUndefined();
    expect(call.result.data).toMatchObject({ contraction_note: '', kick_target: 10, kick_remind_at: null });
    expect(call.result.text).toContain('No instructions from the provider saved yet.');
    expect(call.result.text).toContain('Kick counter: counts to 10 movements. No daily reminder.');
  });

  test('the note, the target and the reminder time, with who saved them', async () => {
    const { db } = household({
      [`${H}/babyContractionSettings/main`]: { note: 'Call at 5-1-1', updatedAt: NOW - 86_400_000, updatedBy: SAM },
      [`${H}/babyKickSettings/main`]: { target: 12, remindAt: '19:30', updatedAt: NOW, updatedBy: SAM },
    });
    const call = await run(SAM, db, 'baby_settings', {});
    expect(call.result.data).toMatchObject({ contraction_note: 'Call at 5-1-1', contraction_note_updated_by: SAM, kick_target: 12, kick_remind_at: '19:30' });
    expect(call.result.text).toContain('Instructions from the provider: "Call at 5-1-1" (saved ');
    expect(call.result.text).toContain('Reminder every day at 7:30 PM.');
  });

  test('kids have none, as in the rules', async () => {
    const call = await run(KIM, household().db, 'baby_settings', {});
    expect(call.result.error).toBe(true);
    expect(call.result.text).toBe("Baby's settings aren't available to kids.");
  });
});

describe('baby_set_contraction_note', () => {
  test("writes exactly the fields Baby writes, as the person", async () => {
    const { db, docs } = household();
    const call = await run(SAM, db, 'baby_set_contraction_note', { note: '  Call when   5 min apart, 1 min long, for 1 hour ' });
    expect(call.result.error).toBeUndefined();
    expect(docs.get(`${H}/babyContractionSettings/main`)).toEqual({ note: 'Call when 5 min apart, 1 min long, for 1 hour', updatedAt: NOW, updatedBy: SAM });
    expect(call.result.text).toContain('Saved the instructions on the contraction timer');
    expect(call.result.text).toContain('https://example.web.app/baby/#contractions');
  });

  test('an empty note clears it', async () => {
    const { db, docs } = household({ [`${H}/babyContractionSettings/main`]: { note: 'Old', updatedAt: 1, updatedBy: SAM } });
    const call = await run(SAM, db, 'baby_set_contraction_note', { note: '' });
    expect(call.result.text).toContain('Cleared the instructions');
    expect(docs.get(`${H}/babyContractionSettings/main`)!.note).toBe('');
  });

  test('helpers and kids are refused before anything is written; the limit is the rules\' 300', async () => {
    for (const who of [JO, KIM]) {
      const { db, commits } = household();
      const call = await run(who, db, 'baby_set_contraction_note', { note: 'x' });
      expect(call.result.error).toBe(true);
      expect(commits).toEqual([]);
    }
    expect(checkArgs(toolNamed('baby_set_contraction_note')!, { note: 'x'.repeat(301) }).ok).toBe(false);
  });
});

describe('baby_set_kick_settings', () => {
  const day = (d: number, h = 0) => Date.UTC(2031, 0, d, h);

  test('a reminder time schedules the next 7 days as Baby does, keeping the target', async () => {
    const { db, docs } = household({ [`${H}/babyKickSettings/main`]: { target: 12, updatedAt: 1, updatedBy: SAM } });
    const call = await run(SAM, db, 'baby_set_kick_settings', { remind_at: '19:00' });
    expect(call.result.error).toBeUndefined();
    expect(docs.get(`${H}/babyKickSettings/main`)).toEqual({ target: 12, remindAt: '19:00', updatedAt: NOW, updatedBy: SAM });
    const reminders = [...docs.entries()].filter(([p]) => p.startsWith(`${H}/reminders/`));
    expect(reminders.map(([p]) => p.split('/').pop())).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `kicks_2031-01-${String(6 + i).padStart(2, '0')}-${day(7 + i)}`));
    expect(reminders[0][1]).toMatchObject({
      app: 'baby',
      title: 'Time for a kick count',
      at: day(7),
      url: 'https://example.web.app/baby/#kicks',
      recipients: 'all',
      ref: 'kicks:2031-01-06',
      private: true,
      source: { checks: [{ doc: 'babyKickSessions/2031-01-06', absent: true }] },
      sent: false,
      by: SAM,
    });
    expect(call.result.text).toContain('Reminder every day at 7:00 PM.');
  });

  test("a new time replaces the kick reminders still to come; sent, past and other reminders stay", async () => {
    const { db, docs } = household({
      [`${H}/babyKickSettings/main`]: { target: 10, remindAt: '07:00', updatedAt: 1, updatedBy: SAM },
      [`${H}/reminders/past`]: kickReminder('2031-01-06', day(6, 12)),
      [`${H}/reminders/sent`]: kickReminder('2031-01-07', day(7, 12), { sent: true }),
      [`${H}/reminders/later`]: kickReminder('2031-01-08', day(8, 12)),
      [`${H}/reminders/visit`]: { ...kickReminder('x', day(9)), ref: 'appointment:a1:day' },
    });
    await run(SAM, db, 'baby_set_kick_settings', { remind_at: 'off', target: 15 });
    expect(docs.get(`${H}/babyKickSettings/main`)).toEqual({ target: 15, updatedAt: NOW, updatedBy: SAM });
    expect([...docs.keys()].filter((p) => p.startsWith(`${H}/reminders/`)).sort()).toEqual([`${H}/reminders/past`, `${H}/reminders/sent`, `${H}/reminders/visit`]);
  });

  test('only the target: no reminder is read or written', async () => {
    const { db, commits } = household({ [`${H}/babyKickSettings/main`]: { target: 10, remindAt: '19:00', updatedAt: 1, updatedBy: SAM } });
    await run(SAM, db, 'baby_set_kick_settings', { target: 8 });
    expect(commits).toEqual([[{ path: `${H}/babyKickSettings/main`, set: { target: 8, remindAt: '19:00', updatedAt: NOW, updatedBy: SAM } }]]);
  });

  test("a stored target out of Baby's range reads, and is written back, as Baby counts it", async () => {
    const { db, docs } = household({ [`${H}/babyKickSettings/main`]: { target: 99, updatedAt: 1, updatedBy: SAM } });
    expect((await run(SAM, db, 'baby_settings', {})).result.data).toMatchObject({ kick_target: 50 });
    await run(SAM, db, 'baby_set_kick_settings', { remind_at: '19:00' });
    expect(docs.get(`${H}/babyKickSettings/main`)).toMatchObject({ target: 50, remindAt: '19:00' });
  });

  test('nothing to change, a helper, out-of-range targets: refused', async () => {
    const { db, commits } = household();
    expect((await run(SAM, db, 'baby_set_kick_settings', {})).result.text).toContain('Say what to change');
    expect((await run(JO, db, 'baby_set_kick_settings', { target: 8 })).result.text).toBe("Only admins and members can change Baby's settings.");
    expect(commits).toEqual([]);
    const tool = toolNamed('baby_set_kick_settings')!;
    for (const bad of [{ target: 1 }, { target: 51 }, { target: 9.5 }, { remind_at: '7pm' }, { remind_at: '24:00' }]) expect(checkArgs(tool, bad).ok).toBe(false);
    expect(checkArgs(tool, { target: 2, remind_at: 'off' }).ok).toBe(true);
  });
});
