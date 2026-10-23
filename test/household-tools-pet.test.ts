import { afterAll, describe, expect, test } from 'bun:test';
import { setTimeZone } from './tz';
import { runTool, Session, toolNamed } from '../src/household-tools';
import { FirestoreError, Increment, type Doc, type FirestoreRest, type Write } from '../src/firestore-rest';

// Pet outings (bathroom breaks) through the shared tools, on an in-memory Firestore. 13:00 UTC is
// 08:00 in New York: Theo's 07:30 breakfast outing is late, his 18:00 dinner one still to come.
afterAll(setTimeZone('UTC'));

const NOW = Date.UTC(2031, 0, 6, 13);
const SAM = 'sam@example.com';
const JO = 'jo@example.com';
const H = 'households/h1';

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

/** 07:00 New York on a January day. */
const morning = (day: number) => Date.UTC(2031, 0, day, 12);

function household(plan: Data = {}, extra: Record<string, Data> = {}) {
  return memoryDb({
    [H]: { name: 'Home', members: [SAM, JO], joined: [SAM, JO], roles: { [JO]: 'helper' }, createdAt: 1 },
    [`${H}/petProfiles/p1`]: { name: 'Theo', species: 'dog', weightUnit: 'lb', createdAt: 1, by: SAM },
    [`${H}/petProfiles/p2`]: { name: 'Nori', species: 'cat', weightUnit: 'lb', createdAt: 1, by: SAM },
    [`${H}/petMeals/m1`]: { petId: 'p1', name: 'Breakfast', time: '07:30', createdAt: 1, by: SAM },
    [`${H}/petMeals/m2`]: { petId: 'p1', name: 'Dinner', time: '18:00', createdAt: 1, by: SAM },
    [`${H}/petOutingPlans/p1`]: { on: true, mode: 'meals', poopMin: 2, createdAt: 1, by: SAM, ...plan },
    // Two poops on the 3rd, one on the 4th and one on the 5th: under the minimum two days running.
    [`${H}/petOutings/a`]: { petId: 'p1', at: morning(3), pee: true, poop: true, by: SAM, createdAt: 1 },
    [`${H}/petOutings/b`]: { petId: 'p1', at: morning(3) + 3600_000, pee: true, poop: true, by: SAM, createdAt: 1 },
    [`${H}/petOutings/c`]: { petId: 'p1', at: morning(4), pee: true, poop: true, by: SAM, createdAt: 1 },
    [`${H}/petOutings/d`]: { petId: 'p1', at: morning(5), pee: true, poop: true, walkMin: 20, by: SAM, createdAt: 1 },
    ...extra,
  });
}

const as = (email: string, db: FirestoreRest, via?: 'assistant') => new Session({ uid: email, email, connectionId: `hh-${email}`, timeZone: 'America/New_York', ...(via ? { via } : {}) }, db, 'https://example.web.app', () => NOW);
const run = (email: string, db: FirestoreRest, tool: string, args: Record<string, unknown>, via?: 'assistant') => runTool(as(email, db, via), toolNamed(tool)!, args);

describe('pet_today outings', () => {
  test('each scheduled outing, poops against the minimum, days under it; only for pets with outings on', async () => {
    const { db } = household({}, { [`${H}/petOutings/e`]: { petId: 'p1', at: NOW - 600_000, walkMin: 15, by: JO, createdAt: 1 } });
    const call = await run(SAM, db, 'pet_today', {});
    expect(call.result.error).toBeUndefined();
    const pets = (call.result.data as { pets: { name: string; outings?: Record<string, unknown> }[] }).pets;
    expect(pets.find((p) => p.name === 'Nori')!.outings).toBeUndefined();
    expect(pets.find((p) => p.name === 'Theo')!.outings).toEqual({
      slots: [
        { key: 'meal-m1', label: 'Breakfast', time: '07:30', state: 'late' },
        { key: 'meal-m2', label: 'Dinner', time: '18:00', state: 'due' },
      ],
      extra: 1,
      poops_today: 0,
      poop_min: 2,
      under_days: 2,
      walk_minutes_today: 15,
      walk_goal: 0,
    });
    expect(call.result.text).toContain('Outings: 0 of 2 poops today, 15 min walked, Breakfast at 7:30 AM: not out yet, Dinner at 6:00 PM: due, and under the minimum 2 days running');
  });

  test('every N hours within waking hours, and set times', async () => {
    const every = household({ mode: 'every', every: 4, from: '07:00', to: '21:00' });
    const slots = async (db: FirestoreRest) =>
      ((await run(SAM, db, 'pet_today', { pet: 'Theo' })).result.data as { pets: { outings: { slots: { key: string; time: string }[] } }[] }).pets[0].outings.slots.map((s) => s.time);
    expect(await slots(every.db)).toEqual(['07:00', '11:00', '15:00', '19:00']);
    expect(await slots(household({ mode: 'times', times: ['18:00', '07:00'] }).db)).toEqual(['07:00', '18:00']);
  });

  test('a day with nothing logged breaks the run of days under the minimum', async () => {
    const { db, docs } = household();
    docs.delete(`${H}/petOutings/c`);
    const call = await run(SAM, db, 'pet_today', { pet: 'Theo' });
    expect((call.result.data as { pets: { outings: { under_days: number } }[] }).pets[0].outings.under_days).toBe(1);
  });
});

describe('pet_log_outing', () => {
  test('ticks the late breakfast outing under its slot id, as the person, then refuses to log it twice', async () => {
    const { db, docs } = household();
    const call = await run(JO, db, 'pet_log_outing', { pet: 'theo', pooped: true }, 'assistant');
    expect(call.result.error).toBeUndefined();
    expect(call.result.text).toContain("Logged Theo's Breakfast outing at 8:00 AM: pooped. 1 of 2 poops today.");
    expect(docs.get(`${H}/petOutings/out-p1-2031-01-06-meal-m1`)).toEqual({ petId: 'p1', slot: 'meal-m1', at: NOW, pee: true, poop: true, by: JO, createdAt: NOW, via: 'assistant' });
    const again = await run(JO, db, 'pet_log_outing', { pet: 'Theo', pooped: true, slot: 'breakfast' });
    expect(again.result.text).toContain('already logged');
    expect(again.result.data).toMatchObject({ repeated: true, poops_today: 1 });
  });

  test('with the breakfast outing done, pee only is an extra outing (dinner is hours away)', async () => {
    const { db, docs } = household({}, { [`${H}/petOutings/out-p1-2031-01-06-meal-m1`]: { petId: 'p1', slot: 'meal-m1', at: NOW - 60_000, pee: true, poop: true, by: SAM, createdAt: 1 } });
    const call = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', pooped: false, idempotency_key: 'k1' });
    expect(call.result.text).toContain('Logged an extra outing for Theo at 8:00 AM: pee only.');
    const extra = [...docs.entries()].find(([p, d]) => p.includes('/petOutings/') && d.poop === false)!;
    expect(extra[1]).toEqual({ petId: 'p1', at: NOW, pee: true, poop: false, by: SAM, createdAt: NOW });
    expect(extra[0]).not.toContain('out-p1');
  });

  test('a walk alone never ticks a bathroom slot', async () => {
    const { db, docs } = household();
    const call = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', walk_minutes: 30, note: 'Park loop' });
    expect(call.result.text).toContain('Logged a 30 min walk for Theo');
    expect(docs.has(`${H}/petOutings/out-p1-2031-01-06-meal-m1`)).toBe(false);
    const walk = [...docs.values()].find((d) => d.walkMin === 30)!;
    expect(walk).toEqual({ petId: 'p1', at: NOW, walkMin: 30, note: 'Park loop', by: SAM, createdAt: NOW });
  });

  test('a retry with the same key writes nothing new and answers the same, whichever slot the first call ticked', async () => {
    const { db, docs } = household();
    const first = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', pooped: true, idempotency_key: 'k2' });
    expect(first.result.data).toMatchObject({ id: 'out-p1-2031-01-06-meal-m1', repeated: false });
    expect(docs.get(`${H}/petOutings/out-p1-2031-01-06-meal-m1`)!.req).toEqual(expect.any(String));
    const count = () => [...docs.keys()].filter((p) => p.includes('/petOutings/')).length;
    const before = count();
    const retry = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', pooped: true, idempotency_key: 'k2' });
    expect(retry.result.data).toMatchObject({ id: 'out-p1-2031-01-06-meal-m1', repeated: true });
    expect(retry.result.text).toContain('Already logged');
    expect(count()).toBe(before);
    // An extra outing (no slot open) retried is the same document too.
    const extra = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', pooped: false, idempotency_key: 'k3' });
    const again = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', pooped: false, idempotency_key: 'k3' });
    expect((again.result.data as { id: string }).id).toBe((extra.result.data as { id: string }).id);
    expect(count()).toBe(before + 1);
  });

  test('a walk naming a slot is still an extra outing: the slot stays open for the bathroom log', async () => {
    const { db, docs } = household();
    const call = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', slot: 'Breakfast', walk_minutes: 20 });
    expect(call.result.text).toContain('Logged a 20 min walk for Theo');
    expect(docs.has(`${H}/petOutings/out-p1-2031-01-06-meal-m1`)).toBe(false);
    const after = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', slot: 'Breakfast', pooped: true });
    expect(after.result.data).toMatchObject({ slot: 'meal-m1', repeated: false });
  });

  test('says what is missing, and which pets have no outings', async () => {
    const { db, commits } = household();
    expect((await run(SAM, db, 'pet_log_outing', { pet: 'Theo' })).result.error).toBe(true);
    const nori = await run(SAM, db, 'pet_log_outing', { pet: 'Nori', pooped: true, slot: 'Breakfast' });
    expect(nori.result.text).toContain("Outings aren't tracked for Nori");
    const unknown = await run(SAM, db, 'pet_log_outing', { pet: 'Theo', pooped: true, slot: 'Lunch' });
    expect(unknown.result.text).toContain('Outings: Breakfast, Dinner');
    expect(commits).toEqual([]);
  });

  test('an earlier time picks that day and the slot near it', async () => {
    const { db, docs } = household();
    await run(SAM, db, 'pet_log_outing', { pet: 'Theo', pooped: true, at: '2031-01-05T18:10' });
    expect(docs.get(`${H}/petOutings/out-p1-2031-01-05-meal-m2`)).toMatchObject({ slot: 'meal-m2', poop: true });
  });
});

// Care routines: one litter box for two cats (a daily scoop) and a weekly litter change counted from when it was last done.
describe('pet_routines and pet_routine_done', () => {
  const routines = (extra: Record<string, Data> = {}) =>
    household({}, {
      [`${H}/petRoutines/r1`]: { name: 'Scoop litter box', kind: 'scoop', petIds: ['p2', 'p1'], mode: 'fixed', every: 1, unit: 'day', since: '2031-01-01', createdAt: 1, by: SAM },
      [`${H}/petRoutines/r2`]: { name: 'Change litter', kind: 'litter', petIds: ['p2'], mode: 'after-done', every: 1, unit: 'week', since: '2031-01-01', createdAt: 1, by: SAM },
      [`${H}/petRoutineLogs/rtn-r2-2031-01-01`]: { routineId: 'r2', due: '2031-01-01', on: '2031-01-04', at: NOW - 2 * 86_400_000, by: JO, createdAt: 1 },
      ...extra,
    });

  test('lists each routine with its state, schedule and last time, for one pet or all', async () => {
    const { db } = routines();
    const call = await run(SAM, db, 'pet_routines', {});
    expect(call.result.error).toBeUndefined();
    const list = (call.result.data as { routines: { name: string; state: string; next_due: string; last_done_by?: string }[] }).routines;
    expect(list.map((r) => [r.name, r.state])).toEqual([['Change litter', 'later'], ['Scoop litter box', 'due']]);
    expect(list[0]).toMatchObject({ next_due: '2031-01-11', last_done_by: JO });
    expect(call.result.text).toContain('Scoop litter box (Nori and Theo): Due today');
    expect(call.result.text).toContain('not done yet');
    const nori = await run(SAM, db, 'pet_routines', { pet: 'nori' });
    expect((nori.result.data as { routines: unknown[] }).routines).toHaveLength(2);
    const theo = await run(SAM, db, 'pet_routines', { pet: 'theo' });
    expect((theo.result.data as { routines: unknown[] }).routines).toHaveLength(1);
  });

  test('marks the open due day done under its id, as the person; a second call writes nothing', async () => {
    const { db, docs } = routines();
    const call = await run(JO, db, 'pet_routine_done', { routine: 'scoop', note: 'Quick one' }, 'assistant');
    expect(call.result.error).toBeUndefined();
    expect(docs.get(`${H}/petRoutineLogs/rtn-r1-2031-01-06`)).toEqual({ routineId: 'r1', due: '2031-01-06', on: '2031-01-06', at: NOW, note: 'Quick one', by: JO, createdAt: NOW, via: 'assistant' });
    expect(call.result.data).toMatchObject({ id: 'rtn-r1-2031-01-06', next_due: '2031-01-07', repeated: false });
    const again = await run(SAM, db, 'pet_routine_done', { routine: 'Scoop litter box' });
    expect(again.result.text).toContain('already done today');
    expect(again.result.data).toMatchObject({ repeated: true });
    const listed = await run(SAM, db, 'pet_routines', {});
    expect(listed.result.text).toContain('done at 8:00 AM by jo@example.com');
  });

  test('an after-done routine can be done early: the next day is counted from today', async () => {
    const { db, docs } = routines();
    const call = await run(SAM, db, 'pet_routine_done', { routine: 'Change litter' });
    expect(call.result.data).toMatchObject({ id: 'rtn-r2-2031-01-11', due: '2031-01-11', next_due: '2031-01-13' });
    expect(docs.get(`${H}/petRoutineLogs/rtn-r2-2031-01-11`)).toMatchObject({ on: '2031-01-06' });
  });

  test('says which routines exist when the name is unknown or matches several', async () => {
    const { db, commits } = routines({ [`${H}/petRoutines/r3`]: { name: 'Scoop the box', petIds: ['p1'], mode: 'fixed', every: 1, unit: 'day', since: '2031-01-01', createdAt: 1, by: SAM } });
    const unknown = await run(SAM, db, 'pet_routine_done', { routine: 'Walk' });
    expect(unknown.result.error).toBe(true);
    expect(unknown.result.text).toContain('Change litter');
    const several = await run(SAM, db, 'pet_routine_done', { routine: 'scoop' });
    expect(several.result.error).toBe(true);
    expect(several.result.text).toContain('more than one routine');
    expect(commits).toHaveLength(0);
  });
});
