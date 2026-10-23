import { afterAll, describe, expect, test } from 'bun:test';
import { setTimeZone } from './tz';
import { runTool, Session, toolNamed } from '../src/household-tools';
import { FirestoreError, Increment, type Doc, type FirestoreRest, type Write } from '../src/firestore-rest';

// Health's writes through the shared tools, on an in-memory Firestore (no rules: those are tested in
// huishouden/connector against the emulator). 13:00 UTC is 08:00 in New York: Nan's morning dose is due.
// The tools run in a UTC process (Workers do; `hh` sets TZ), as LocalClock's frame needs.
afterAll(setTimeZone('UTC'));

const NOW = Date.UTC(2031, 0, 6, 13);
const SAM = 'sam@example.com';
const ALEX = 'alex@example.com';
const H = 'households/h1';
const NAN = `${H}/healthPeople/p1`;
const SLOT = '2031-01-06T08:00';
const DOSE = `${NAN}/doses/m1_2031-01-06T0800`;

type Data = Record<string, unknown>;

/** Enough of FirestoreRest for the tools: documents by path, equality, array-contains and >= filters, atomic commits. */
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
        .filter(([, d]) =>
          where.every((w) =>
            w.op === 'EQUAL' ? d[w.field] === w.value : w.op === 'ARRAY_CONTAINS' ? Array.isArray(d[w.field]) && (d[w.field] as unknown[]).includes(w.value) : w.op === 'GREATER_THAN_OR_EQUAL' ? (d[w.field] as number) >= (w.value as number) : true,
          ),
        )
        .map(([p, d]) => toDoc(p, d));
    },
    commit: async (writes: Write[]) => {
      for (const w of writes) if ('create' in w && docs.has(w.path)) throw new FirestoreError('already-exists', w.path);
      commits.push(writes);
      for (const w of writes) {
        if ('delete' in w) docs.delete(w.path);
        else if ('create' in w) docs.set(w.path, w.create);
        else if ('set' in w) docs.set(w.path, w.set);
        else if ('merge' in w) {
          const merged: Data = { ...(docs.get(w.path) ?? {}) };
          for (const [k, v] of Object.entries(w.merge)) merged[k] = v instanceof Increment ? (Number(merged[k] ?? 0) + v.by) : v;
          docs.set(w.path, merged);
        }
      }
    },
  } as unknown as FirestoreRest;
  return { db, docs, commits };
}

function household(extra: Record<string, Data> = {}) {
  return memoryDb({
    [H]: { name: 'Home', members: [SAM, ALEX], joined: [SAM, ALEX], roles: { [ALEX]: 'helper' }, createdAt: 1 },
    [NAN]: { name: 'Nan', carers: [SAM, ALEX], readers: [SAM, ALEX] },
    [`${NAN}/meds/m1`]: { personId: 'p1', name: 'Examplamine', strength: '10 mg', dose: '1 tablet', asNeeded: false, times: ['08:00', '20:00'], everyDays: 1, startDate: '2031-01-01', createdAt: 1, by: SAM },
    ...extra,
  });
}

const as = (email: string, db: FirestoreRest) => new Session({ uid: email, email, connectionId: `hh-${email}`, timeZone: 'America/New_York' }, db, 'https://example.web.app', () => NOW);
const run = (email: string, db: FirestoreRest, tool: string, args: Record<string, unknown>) => runTool(as(email, db), toolNamed(tool)!, args);

describe('health_log_dose', () => {
  test("marks the dose due now, signed by the person, without the assistant's mark", async () => {
    const { db, docs } = household();
    const call = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine' });
    expect(call.result.data).toMatchObject({ written: true, slot: SLOT, status: 'given' });
    expect(docs.get(DOSE)).toEqual({ personId: 'p1', medId: 'm1', slot: SLOT, at: NOW, status: 'given', by: SAM, createdAt: NOW });
  });

  test('a second give soon after asks first (the double-dose guard); confirmed, it marks the next dose time', async () => {
    const { db, commits } = household({ [DOSE]: { personId: 'p1', medId: 'm1', slot: SLOT, at: NOW - 600_000, status: 'given', by: SAM, createdAt: NOW - 600_000 } });
    const asked = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine' });
    expect(asked.result.data).toMatchObject({ written: false, needs_confirmation: true });
    expect(commits).toEqual([]);
    const confirmed = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', confirm: true });
    expect(confirmed.result.data).toMatchObject({ written: true, slot: '2031-01-06T20:00' });
  });

  test('turning a given dose into a skipped one asks first', async () => {
    const { db, docs, commits } = household({ [DOSE]: { personId: 'p1', medId: 'm1', slot: SLOT, at: NOW - 600_000, status: 'given', by: SAM, createdAt: NOW - 600_000 } });
    const asked = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '08:00', status: 'skipped' });
    expect(asked.result.data).toMatchObject({ written: false, needs_confirmation: true });
    expect(asked.result.text).toContain('was marked given at 7:50 AM');
    expect(commits).toEqual([]);
    await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '08:00', status: 'skipped', confirm: true });
    expect(docs.get(DOSE)).toMatchObject({ status: 'skipped', by: SAM });
  });

  test("giving a dose someone else gave asks first, naming them", async () => {
    const { db, commits } = household({ [DOSE]: { personId: 'p1', medId: 'm1', slot: SLOT, at: NOW - 600_000, status: 'given', by: ALEX, createdAt: NOW - 600_000 } });
    const asked = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '08:00' });
    expect(asked.result.data).toMatchObject({ written: false, needs_confirmation: true });
    expect(asked.result.text).toContain('was already given');
    expect(commits).toEqual([]);
  });

  test("giving a dose someone else marked skipped is refused, not re-signed", async () => {
    const theirs = { personId: 'p1', medId: 'm1', slot: SLOT, at: NOW - 600_000, status: 'skipped', by: ALEX, createdAt: NOW - 600_000 };
    const { db, docs, commits } = household({ [DOSE]: theirs });
    const call = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '08:00' });
    expect(call.result.text).toContain('Someone else already marked that dose');
    expect(commits).toEqual([]);
    expect(docs.get(DOSE)).toEqual(theirs);
  });

  test("someone else's mark is theirs: nothing is overwritten, confirmed or not", async () => {
    const theirs = { personId: 'p1', medId: 'm1', slot: SLOT, at: NOW - 600_000, status: 'given', by: ALEX, createdAt: NOW - 600_000 };
    for (const args of [{ status: 'skipped' }, { status: 'skipped', confirm: true }, { confirm: true }]) {
      const { db, docs, commits } = household({ [DOSE]: theirs });
      const call = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '08:00', ...args });
      expect(call.result.error).toBe(true);
      expect(call.result.text).toContain('Someone else already marked that dose');
      expect(commits).toEqual([]);
      expect(docs.get(DOSE)).toEqual(theirs);
    }
  });

  test('a named earlier dose time today, and a time that is not one', async () => {
    const { db, docs } = household();
    const call = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '20:00', status: 'skipped' });
    expect(call.result.data).toMatchObject({ written: true, slot: '2031-01-06T20:00', status: 'skipped' });
    expect(docs.has(`${NAN}/doses/m1_2031-01-06T2000`)).toBe(true);
    const bad = await run(SAM, db, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '09:00' });
    expect(bad.result.error).toBe(true);
  });
});

describe('health_add_medicine and health_update_medicine', () => {
  test("adding writes Health's medicine shape, signed by the person", async () => {
    const { db, docs } = household();
    const call = await run(SAM, db, 'health_add_medicine', { person: 'Nan', name: 'Otheramine', strength: '5 mg', times: ['21:00', '09:00'], weekdays: ['monday', 'thursday'], supply: 30, dose_amount: 1 });
    expect(call.result.error).toBeUndefined();
    const [path, med] = [...docs.entries()].find(([p, d]) => p.startsWith(`${NAN}/meds/`) && d.name === 'Otheramine')!;
    expect(path).toMatch(/^households\/h1\/healthPeople\/p1\/meds\/[A-Za-z0-9]{20}$/);
    expect(med).toMatchObject({ personId: 'p1', strength: '5 mg', asNeeded: false, times: ['09:00', '21:00'], startDate: '2031-01-06', supply: 30, supplyAt: NOW, doseAmount: 1, remind: true, escalateMinutes: 30, createdAt: NOW, by: SAM });
    expect(med.rule).toMatchObject({ freq: 'week', days: [1, 4] });
    expect(med).not.toHaveProperty('everyDays');
    expect(med).not.toHaveProperty('via');
  });

  test('a scheduled medicine needs times; a course cannot end before it starts', async () => {
    const { db } = household();
    expect((await run(SAM, db, 'health_add_medicine', { person: 'Nan', name: 'X' })).result.error).toBe(true);
    expect((await run(SAM, db, 'health_add_medicine', { person: 'Nan', name: 'X', times: ['08:00'], start_date: '2031-01-06', end_date: '2031-01-01' })).result.error).toBe(true);
  });

  test('a helper may mark a refill ordered, whatever else the call carries, and change nothing else', async () => {
    const { db, docs } = household();
    const call = await run(ALEX, db, 'health_update_medicine', { person: 'Nan', medicine: 'Examplamine', refill_ordered: true, lang: 'en', time_zone: 'America/New_York', household: 'h1' });
    expect(call.result.error).toBeUndefined();
    expect(docs.get(`${NAN}/meds/m1`)).toMatchObject({ refillOrderedAt: NOW, updatedAt: NOW, strength: '10 mg', by: SAM });
    const change = await run(ALEX, db, 'health_update_medicine', { person: 'Nan', medicine: 'Examplamine', strength: '20 mg' });
    expect(change.result.error).toBe(true);
    expect(docs.get(`${NAN}/meds/m1`)).toMatchObject({ strength: '10 mg' });
  });

  test('stopping ends it today and keeps the rest', async () => {
    const { db, docs } = household();
    await run(SAM, db, 'health_update_medicine', { person: 'Nan', medicine: 'Examplamine', stop: true });
    expect(docs.get(`${NAN}/meds/m1`)).toMatchObject({ endDate: '2031-01-06', times: ['08:00', '20:00'], strength: '10 mg', createdAt: 1, updatedAt: NOW });
  });
});

describe('Health visits', () => {
  test('add_appointment for Health writes a visit, its notes apart, and publishes "Appointment for Nan" and the reminders', async () => {
    const { db, docs } = household({ [`${H}/contacts/c1`]: { name: 'Dr. Example', role: 'Doctor', address: '1 Example Way', apps: ['health'], private: true, createdAt: 1, by: SAM } });
    const call = await run(SAM, db, 'add_appointment', { app: 'health', person: 'Nan', title: 'Eye exam', start: '2031-01-09T10:00', doctor: 'Dr. Example', notes: 'Drops: no driving after', prep: ['Bring her glasses'], idempotency_key: 'eye-1' });
    expect(call.result.error).toBeFalsy();
    const at = Date.UTC(2031, 0, 9, 15);
    const visit = [...docs.entries()].find(([p]) => p.startsWith(`${NAN}/visits/`))!;
    expect(visit[1]).toMatchObject({ personId: 'p1', kind: 'eye', title: 'Eye exam', at, contactId: 'c1', prep: ['Bring her glasses'], remindBefore: [1440, 120], by: SAM });
    expect(docs.get(`${NAN}/visitNotes/${visit[0].split('/').pop()}`)).toMatchObject({ text: 'Drops: no driving after', by: SAM });
    const agenda = [...docs.entries()].filter(([p]) => p.startsWith(`${H}/personalAgenda/`)).map(([, d]) => d);
    expect(agenda).toEqual([expect.objectContaining({ app: 'health', kind: 'appointment', title: 'Appointment for Nan', start: at, audience: [ALEX, SAM], calendarDetail: 'Eye doctor: Eye exam · Bring her glasses' })]);
    // The doctor is a private contact and a helper carer reads what is published: not named.
    expect(JSON.stringify(agenda)).not.toContain('Dr. Example');
    const reminders = [...docs.entries()].filter(([p]) => p.startsWith(`${H}/personalReminders/`)).map(([, d]) => d as { at: number; body: string; recipients: string[] });
    expect(reminders.map((r) => r.at).sort()).toEqual([at - 86_400_000, at - 2 * 3_600_000]);
    expect(reminders[0].recipients).toEqual([ALEX, SAM]);
    expect(JSON.stringify([...agenda, ...reminders])).not.toContain('no driving');
  });

  test("what add_appointment publishes is in the writer's language, with texts only for the readers' others", async () => {
    const { db, docs } = household();
    const home = docs.get(H)!;
    docs.set(H, { ...home, langs: { [SAM]: 'en', [ALEX]: 'nl' } });
    const call = await run(SAM, db, 'add_appointment', { app: 'health', person: 'Nan', title: 'Eye exam', start: '2031-01-09T10:00', idempotency_key: 'eye-2' });
    expect(call.lang).toBe('en');
    const agenda = [...docs.entries()].filter(([p]) => p.startsWith(`${H}/personalAgenda/`)).map(([, d]) => d as { title: string; texts?: Record<string, unknown> });
    expect(agenda[0].title).toBe('Appointment for Nan');
    expect(Object.keys(agenda[0].texts ?? {})).toEqual(['nl']);
    const reminders = [...docs.entries()].filter(([p]) => p.startsWith(`${H}/personalReminders/`)).map(([, d]) => d as { texts?: Record<string, unknown> });
    expect(reminders.every((r) => Object.keys(r.texts ?? {}).join() === 'nl')).toBe(true);
    // Alex's stored language is what the assistant answers Alex in.
    expect((await run(ALEX, db, 'health_appointments', { person: 'Nan' })).lang).toBe('nl');
    // Everyone reading English: no texts at all.
    docs.set(H, { ...home, langs: { [SAM]: 'en', [ALEX]: 'en' } });
    for (const p of [...docs.keys()]) if (p.startsWith(`${H}/personal`)) docs.delete(p);
    await run(SAM, db, 'add_appointment', { app: 'health', person: 'Nan', title: 'Eye exam', start: '2031-01-10T10:00', idempotency_key: 'eye-3' });
    const plain = [...docs.entries()].filter(([p]) => p.startsWith(`${H}/personal`)).map(([, d]) => d);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((d) => !('texts' in d))).toBe(true);
  });

  test('a helper carer adds no notes; health_appointments gives notes to keepers only', async () => {
    const { db } = household({
      [`${NAN}/visits/v1`]: { personId: 'p1', kind: 'dentist', title: 'Cleaning', at: Date.UTC(2031, 0, 8, 14), remindBefore: [1440], createdAt: 1, by: SAM },
      [`${NAN}/visitNotes/v1`]: { personId: 'p1', text: 'Two fillings next time', updatedAt: 1, by: SAM },
    });
    expect((await run(ALEX, db, 'add_appointment', { app: 'health', person: 'Nan', title: 'X', start: '2031-01-10T09:00', notes: 'secret' })).result.error).toBe(true);
    const sam = await run(SAM, db, 'health_appointments', { person: 'Nan' });
    expect((sam.result.data!.visits as { notes?: string; state: string }[])[0]).toMatchObject({ notes: 'Two fillings next time', state: 'upcoming' });
    const alex = await run(ALEX, db, 'health_appointments', {});
    expect((alex.result.data!.visits as { notes?: string }[])[0].notes).toBeUndefined();
    expect(alex.result.text).not.toContain('fillings');
  });
});

describe('Health conditions', () => {
  const ASTHMA = `${NAN}/conditions/k1`;
  const seeded = () =>
    household({
      [`${H}/contacts/c1`]: { name: 'Dr. Example Lung', role: 'Pulmonologist', apps: ['health'], createdAt: 1, by: SAM },
      [`${H}/contacts/c2`]: { name: 'Example Clinic', role: 'Clinic', apps: ['health'], createdAt: 1, by: SAM },
      [ASTHMA]: { personId: 'p1', name: 'Asthma', icd10: 'J45.909', specialty: 'pulmonology', status: 'active', diagnosed: '2030-03', doctorId: 'c1', clinicId: 'c2', medIds: ['m1'], notes: 'Example note', createdAt: 1, by: SAM },
      [`${NAN}/conditions/k2`]: { personId: 'p1', name: 'Bronchitis', icd10: 'J20.9', specialty: 'pulmonology', status: 'resolved', resolved: '2029', createdAt: 1, by: SAM },
      [`${NAN}/conditions/k3`]: { personId: 'p1', name: 'Hypertension', icd10: 'I10', specialty: 'cardiology', status: 'managed', createdAt: 1, by: SAM },
      [`${NAN}/conditions/k4`]: { personId: 'p1', name: 'Migraine', icd10: 'G43.909', specialty: 'neurology', status: 'active', createdAt: 1, by: SAM },
      [`${NAN}/visits/v1`]: { personId: 'p1', kind: 'specialist', at: Date.UTC(2031, 0, 8, 14), remindBefore: [1440], conditionId: 'k1', specialty: 'pulmonology', createdAt: 1, by: SAM },
    });

  test('health_conditions groups by medical area, active first, with who diagnosed it, where and what treats it', async () => {
    const { db } = seeded();
    const call = await run(SAM, db, 'health_conditions', { person: 'Nan', specialty: 'pulmonology' });
    expect(call.result.error).toBeUndefined();
    const people = call.result.data!.people as { groups: { specialty: string; current: number; conditions: { name: string; diagnosed_by?: { name: string }; where?: { name: string }; medicines: { name: string }[] }[] }[] }[];
    expect(people[0].groups).toHaveLength(1);
    expect(people[0].groups[0]).toMatchObject({ specialty: 'pulmonology', current: 1 });
    expect(people[0].groups[0].conditions.map((c) => c.name)).toEqual(['Asthma', 'Bronchitis']);
    expect(people[0].groups[0].conditions[0]).toMatchObject({ diagnosed_by: { name: 'Dr. Example Lung' }, where: { name: 'Example Clinic' }, medicines: [{ name: 'Examplamine 10 mg' }] });
    expect(call.result.text).toContain('### Pulmonology (2)');
    expect(call.result.text).toContain('diagnosed March 2030');
    expect(call.result.text).not.toContain('Hypertension');
    const neuro = await run(SAM, db, 'health_conditions', { person: 'Nan', specialty: 'neurology' });
    expect(neuro.result.text).toContain('Migraine');
    expect(neuro.result.text).not.toContain('Asthma');
  });

  test('a helper carer sees no conditions anywhere: not listed, not on the doctor list, not on visits', async () => {
    const { db } = seeded();
    const named = await run(ALEX, db, 'health_conditions', { person: 'Nan' });
    expect(named.result.error).toBe(true);
    expect(named.result.text).not.toContain('Asthma');
    const all = await run(ALEX, db, 'health_conditions', {});
    expect(all.result.data!.people).toEqual([]);
    const list = await run(ALEX, db, 'health_doctor_list', { person: 'Nan' });
    expect(list.result.text).not.toContain('Asthma');
    const visits = await run(ALEX, db, 'health_appointments', { person: 'Nan' });
    expect(visits.result.text).not.toContain('Asthma');
    // The visit's area is the visit's, like its title and doctor.
    expect(visits.result.text).toContain('Pulmonology');
    const linked = await run(ALEX, db, 'add_appointment', { app: 'health', person: 'Nan', title: 'Check', start: '2031-01-10T09:00', condition: 'Asthma' });
    expect(linked.result.error).toBe(true);
    expect(linked.result.text).not.toContain('Asthma');
  });

  test('the doctor list shows active and managed conditions by area; visits name theirs for keepers', async () => {
    const { db } = seeded();
    const list = await run(SAM, db, 'health_doctor_list', { person: 'Nan' });
    expect(list.result.text).toContain('## Conditions');
    expect(list.result.text).toContain('### Cardiology (1)');
    expect(list.result.text).toContain('Asthma');
    expect(list.result.text).not.toContain('Bronchitis');
    const visits = await run(SAM, db, 'health_appointments', { person: 'Nan' });
    expect((visits.result.data!.visits as { condition?: { id?: string; name: string } }[])[0].condition).toEqual({ id: 'k1', name: 'Asthma' });
  });

  test("add_appointment links a visit to a condition, without copying the condition's area", async () => {
    const { db, docs } = seeded();
    const call = await run(SAM, db, 'add_appointment', { app: 'health', person: 'Nan', title: 'Asthma review', start: '2031-01-10T09:00', condition: 'asthma' });
    expect(call.result.error).toBeFalsy();
    const visit = [...docs.entries()].find(([p, d]) => p.startsWith(`${NAN}/visits/`) && (d as { title?: string }).title === 'Asthma review')!;
    expect(visit[1]).toMatchObject({ conditionId: 'k1' });
    expect(visit[1]).not.toHaveProperty('specialty');
    const agenda = JSON.stringify([...docs.entries()].filter(([p]) => p.includes('/personalAgenda/') || p.includes('/personalReminders/')).map(([, d]) => d));
    expect(agenda).not.toContain('Pulmonology');
    // As a word: the visit's random document id, in its links, may hold the letters k1.
    expect(agenda).not.toMatch(/\bk1\b/);
  });

  test('health_add_condition files it under the code, the name or the area given, and only for keepers', async () => {
    const { db, docs } = seeded();
    const call = await run(SAM, db, 'health_add_condition', { person: 'Nan', name: 'Radiculopathy, cervical region', icd10: 'M54.12', diagnosed: '2030', doctor: 'Dr. Example Lung', place: 'Example Hospital', medicines: ['Examplamine'], idempotency_key: 'k-1' });
    expect(call.result.error).toBeUndefined();
    const id = (call.result.data as { id: string }).id;
    expect(docs.get(`${NAN}/conditions/${id}`)).toEqual({ personId: 'p1', name: 'Radiculopathy, cervical region', icd10: 'M54.12', specialty: 'neurology', status: 'active', diagnosed: '2030', doctorId: 'c1', place: 'Example Hospital', medIds: ['m1'], createdAt: NOW, by: SAM });
    expect(call.result.text).toContain('under Neurology');
    const again = await run(SAM, db, 'health_add_condition', { person: 'Nan', name: 'Radiculopathy, cervical region', icd10: 'M54.12', idempotency_key: 'k-1' });
    expect(again.result.data).toMatchObject({ id, repeated: true });
    const named = await run(SAM, db, 'health_add_condition', { person: 'Nan', name: 'Type 2 diabetes' });
    expect((named.result.data as { condition: { specialty: string } }).condition.specialty).toBe('endocrinology');
    const chosen = await run(SAM, db, 'health_add_condition', { person: 'Nan', name: 'Neck pain', icd10: 'M54.2', specialty: 'neurology' });
    expect((chosen.result.data as { condition: { specialty: string } }).condition.specialty).toBe('neurology');
    const over = await run(SAM, db, 'health_add_condition', { person: 'Nan', name: 'Wrist fracture', resolved: '2029' });
    expect((over.result.data as { condition: { status: string; resolved: string } }).condition).toMatchObject({ status: 'resolved', resolved: '2029' });
    const helper = await run(ALEX, db, 'health_add_condition', { person: 'Nan', name: 'Anything' });
    expect(helper.result.error).toBe(true);
    expect(helper.result.text).toContain('Only admins, and members who care for this person');
  });

  test('the person themself reads their own as a member, not as a helper (the rules: their email grants nothing)', async () => {
    const CAROL = 'carol@example.com';
    const HANK = 'hank@example.com';
    const { db } = memoryDb({
      [H]: { name: 'Home', members: [SAM, CAROL, HANK], joined: [SAM, CAROL, HANK], roles: { [HANK]: 'helper' }, createdAt: 1 },
      [`${H}/healthPeople/pc`]: { name: 'Carol', email: CAROL, carers: [], readers: [CAROL] },
      [`${H}/healthPeople/pc/conditions/k1`]: { personId: 'pc', name: 'Asthma', specialty: 'pulmonology', status: 'active', createdAt: 1, by: SAM },
      [`${H}/healthPeople/ph`]: { name: 'Hank', email: HANK, carers: [], readers: [HANK] },
      [`${H}/healthPeople/ph/conditions/k1`]: { personId: 'ph', name: 'Asthma', specialty: 'pulmonology', status: 'active', createdAt: 1, by: SAM },
    });
    const carol = await run(CAROL, db, 'health_conditions', { person: 'Carol' });
    expect(carol.result.text).toContain('Asthma');
    const hank = await run(HANK, db, 'health_conditions', { person: 'Hank' });
    expect(hank.result.error).toBe(true);
    expect(hank.result.text).not.toContain('Asthma');
  });

  test('what would be dropped is said back instead', async () => {
    const { db, commits } = seeded();
    const both = await run(SAM, db, 'health_add_condition', { person: 'Nan', name: 'Asthma', clinic: 'Example Clinic', place: 'Example Hospital' });
    expect(both.result.text).toContain('either `clinic`');
    const resolved = await run(SAM, db, 'health_add_condition', { person: 'Nan', name: 'Asthma', status: 'active', resolved: '2030' });
    expect(resolved.result.text).toContain('`resolved` date');
    expect(commits).toEqual([]);
  });
});
