import { describe, expect, test } from 'bun:test';
import { readSource, REMINDER_SOURCES, sourceAllowed, sourceCollection, sourceReads, stillDue, type ReminderSource, type SourceDocs } from '../src/reminder-source';

const bill: ReminderSource = { checks: [{ doc: 'bills/b1', due: [{ field: 'status', notIn: ['paid', 'credit'] }, { field: 'dismissed', notIn: [true] }, { field: 'due', in: ['2031-01-15'] }] }] };
const docs = (entries: Record<string, Record<string, unknown> | null>): SourceDocs => new Map(Object.entries(entries));

describe('readSource', () => {
  test('reads what the apps write', () => {
    expect(readSource('bills', bill)).toEqual(bill);
    const doses = { checks: [{ doc: 'healthPeople/p1/doses/m1_0800', absent: true }, { doc: 'healthPeople/p1/doses/m2_0800', absent: true }], any: true };
    expect(readSource('health', doses)).toEqual(doses);
    expect(readSource('pet', { checks: [{ doc: 'petMedCourses/c1' }], any: false })).toEqual({ checks: [{ doc: 'petMedCourses/c1' }] });
  });

  test("a pet outing slot's reminder: the plan still on, the slot's outing not yet logged", () => {
    const outing = { checks: [{ doc: 'petOutingPlans/p1', due: [{ field: 'on', in: [true] }] }, { doc: 'petOutings/out-p1-2031-01-06-meal-m1', absent: true }] };
    expect(readSource('pet', outing)).toEqual(outing);
    expect(stillDue(outing, docs({ 'petOutingPlans/p1': { on: true }, 'petOutings/out-p1-2031-01-06-meal-m1': null }))).toBe(true);
    expect(stillDue(outing, docs({ 'petOutingPlans/p1': { on: true }, 'petOutings/out-p1-2031-01-06-meal-m1': { poop: true } }))).toBe(false);
    expect(stillDue(outing, docs({ 'petOutingPlans/p1': { on: false }, 'petOutings/out-p1-2031-01-06-meal-m1': null }))).toBe(false);
    // Only the plan's on/off may be read, never a field that says more about the outings.
    expect(readSource('pet', { checks: [{ doc: 'petOutings/o1', due: [{ field: 'poop', in: [true] }] }] })).toBeNull();
  });

  test('null for none, or for anything past the limits', () => {
    for (const bad of [
      undefined,
      null,
      'bills/b1',
      { checks: [] },
      { checks: [{ doc: 'bills/b1' }], extra: 1 },
      { checks: [{ doc: 'bills/b1' }], any: 'yes' },
      { checks: [{ doc: 'bills' }] },
      { checks: [{ doc: 'bills/b1/x' }] },
      { checks: [{ doc: 'bills/../b1' }] },
      { checks: [{ doc: 'bills/__b1__' }] },
      { checks: [{ doc: 'bills/b1', absent: false }] },
      { checks: [{ doc: 'bills/b1', absent: true, due: [] }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status' }] }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status', in: [] }] }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status', in: ['a'], notIn: ['b'] }] }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status', in: [['nested']] }] }] },
      { checks: Array.from({ length: 9 }, () => ({ doc: 'bills/b1' })) },
    ])
      expect(readSource('bills', bad)).toBeNull();
  });

  test("only the app's own collections, and in them only the fields that say it is done", () => {
    expect(readSource('tasks', bill)).toBeNull();
    expect(readSource('spending', { checks: [{ doc: 'spendingTransactions/t1' }] })).toBeNull();
    expect(readSource('health', { checks: [{ doc: 'healthPeople/p1/meds/m1', due: [{ field: 'name', in: ['Lisinopril'] }] }] })).toBeNull();
    expect(readSource('bills', { checks: [{ doc: 'bills/b1', due: [{ field: 'amountDue', in: [100] }] }] })).toBeNull();
    expect(readSource('bills', { checks: [{ doc: 'bills/b1', due: [{ field: 'constructor', in: [null] }] }] })).toBeNull();
    expect(sourceCollection('health', 'healthPeople/p1/notes/n1')).toBeUndefined();
    expect(sourceCollection('health', 'healthPeople/p1')).toBeUndefined();
    for (const [app, cols] of Object.entries(REMINDER_SOURCES)) for (const col of Object.keys(cols)) expect(sourceCollection(app, `${col.replace('*', 'x')}/d1`)).toBe(cols[col]);
    // Frozen: nothing at runtime can widen what a source may name.
    expect(Object.isFrozen(REMINDER_SOURCES) && Object.isFrozen(REMINDER_SOURCES.bills) && Object.isFrozen(REMINDER_SOURCES.bills.bills.fields)).toBe(true);
  });
});

describe('sourceAllowed', () => {
  const P = { personal: true };
  const doses: ReminderSource = { checks: [{ doc: 'healthPeople/p1/doses/m1_0800', absent: true }], any: true };

  test("bills only from admins and members; kids' sources never", () => {
    expect(sourceAllowed('bills', bill, 'alex@example.com', 'member', docs({}))).toBe(true);
    expect(sourceAllowed('bills', bill, 'sam@example.com', 'helper', docs({}))).toBe(false);
    expect(sourceAllowed('tasks', { checks: [{ doc: 'items/a' }] }, 'sam@example.com', 'helper', docs({}))).toBe(true);
    expect(sourceAllowed('tasks', { checks: [{ doc: 'items/a' }] }, 'kim@example.com', 'kid', docs({}))).toBe(false);
  });

  test("a Health record only from an admin or one of the person's readers", () => {
    expect(sourceReads('health', doses)).toEqual(['healthPeople/p1/doses/m1_0800', 'healthPeople/p1']);
    const person = docs({ 'healthPeople/p1': { readers: ['Bob@example.com', 'helen@example.com'] } });
    expect(sourceAllowed('health', doses, 'bob@example.com', 'member', person, P)).toBe(true);
    expect(sourceAllowed('health', doses, 'helen@example.com', 'helper', person, P)).toBe(true);
    expect(sourceAllowed('health', doses, 'carol@example.com', 'member', person, P)).toBe(false);
    expect(sourceAllowed('health', doses, 'carol@example.com', 'admin', docs({}), P)).toBe(true);
    expect(sourceAllowed('health', doses, 'bob@example.com', 'member', docs({ 'healthPeople/p1': null }), P)).toBe(false);
    expect(sourceAllowed('health', doses, 'bob@example.com', 'member', docs({}), P)).toBeUndefined();
    // Never a kid, even one named; never a helper who isn't a reader.
    expect(sourceAllowed('health', doses, 'kim@example.com', 'kid', docs({ 'healthPeople/p1': { readers: ['kim@example.com'] } }), P)).toBe(false);
    expect(sourceAllowed('health', doses, 'hank@example.com', 'helper', person, P)).toBe(false);
    // Never on a shared reminder, which every member reads.
    expect(sourceAllowed('health', doses, 'bob@example.com', 'member', person)).toBe(false);
    expect(sourceAllowed('bills', bill, 'alex@example.com', 'member', docs({}), { personal: false })).toBe(true);
  });
});

describe('stillDue', () => {
  test('due while every condition holds; done once paid, skipped or re-dated', () => {
    expect(stillDue(bill, docs({ 'bills/b1': { status: 'due', due: '2031-01-15' } }))).toBe(true);
    expect(stillDue(bill, docs({ 'bills/b1': { status: 'paid', due: '2031-01-15' } }))).toBe(false);
    expect(stillDue(bill, docs({ 'bills/b1': { status: 'due', dismissed: true, due: '2031-01-15' } }))).toBe(false);
    expect(stillDue(bill, docs({ 'bills/b1': { status: 'due', due: '2031-02-15' } }))).toBe(false);
  });

  test('a removed record is done; one not read is unknown', () => {
    expect(stillDue(bill, docs({ 'bills/b1': null }))).toBe(false);
    expect(stillDue(bill, docs({}))).toBeUndefined();
  });

  test('absent: due until the record is written', () => {
    const tick: ReminderSource = { checks: [{ doc: 'homeEventPrep/e1_2031-01-15', absent: true }, { doc: 'homeEvents/e1' }] };
    expect(stillDue(tick, docs({ 'homeEventPrep/e1_2031-01-15': null, 'homeEvents/e1': {} }))).toBe(true);
    expect(stillDue(tick, docs({ 'homeEventPrep/e1_2031-01-15': { done: true }, 'homeEvents/e1': {} }))).toBe(false);
    expect(stillDue(tick, docs({ 'homeEventPrep/e1_2031-01-15': null, 'homeEvents/e1': null }))).toBe(false);
  });

  test('a missing field reads as null', () => {
    const s: ReminderSource = { checks: [{ doc: 'items/a', due: [{ field: 'completed', in: [false, null] }] }] };
    expect(stillDue(s, docs({ 'items/a': {} }))).toBe(true);
    expect(stillDue(s, docs({ 'items/a': { completed: true } }))).toBe(false);
  });

  test('any: due while one dose is unmarked; all: one failing settles it', () => {
    const two = (any: boolean): ReminderSource => ({ checks: [{ doc: 'healthPeople/p1/doses/a', absent: true }, { doc: 'healthPeople/p1/doses/b', absent: true }], any });
    const marked = { status: 'given' };
    expect(stillDue(two(true), docs({ 'healthPeople/p1/doses/a': marked, 'healthPeople/p1/doses/b': null }))).toBe(true);
    expect(stillDue(two(true), docs({ 'healthPeople/p1/doses/a': marked, 'healthPeople/p1/doses/b': marked }))).toBe(false);
    expect(stillDue(two(true), docs({ 'healthPeople/p1/doses/a': marked }))).toBeUndefined();
    expect(stillDue(two(false), docs({ 'healthPeople/p1/doses/a': marked }))).toBe(false);
    expect(stillDue(two(false), docs({ 'healthPeople/p1/doses/a': null }))).toBeUndefined();
  });
});

describe('Baby and Car sources', () => {
  const appointment: ReminderSource = { checks: [{ doc: 'babyAppointments/a1', due: [{ field: 'at', in: [1900000000000] }] }] };
  const renewal: ReminderSource = { checks: [{ doc: 'carRenewals/r1', due: [{ field: 'closedAt', in: [null] }, { field: 'dueDate', in: ['2031-03-01'] }] }] };
  const service: ReminderSource = { checks: [{ doc: 'carServiceItems/s1', due: [{ field: 'pausedAt', in: [null] }, { field: 'lastDate', in: ['2030-09-01'] }] }] };

  test('are read as written', () => {
    expect(readSource('baby', appointment)).toEqual(appointment);
    expect(readSource('car', renewal)).toEqual(renewal);
    expect(readSource('car', service)).toEqual(service);
    expect(readSource('car', { checks: [{ doc: 'carVehicles/v1' }] })).toBeNull();
    expect(readSource('baby', { checks: [{ doc: 'babyProfile/main' }] })).toBeNull();
  });

  test('a kick-count reminder is due until that day’s session exists', () => {
    const kicks: ReminderSource = { checks: [{ doc: 'babyKickSessions/2031-05-14', absent: true }] };
    expect(readSource('baby', kicks)).toEqual(kicks);
    expect(readSource('baby', { checks: [{ doc: 'babyKickSessions/2031-05-14', due: [{ field: 'end', in: [null] }] }] })).toBeNull();
    expect(readSource('pet', kicks)).toBeNull();
    expect(stillDue(kicks, docs({ 'babyKickSessions/2031-05-14': null }))).toBe(true);
    expect(stillDue(kicks, docs({ 'babyKickSessions/2031-05-14': { start: 1 } }))).toBe(false);
    // Staff only, as for appointments: a helper's or kid's check must not probe a record the sender reads with its own account.
    for (const [role, allowed] of [['admin', true], ['member', true], ['helper', false], ['kid', false]] as const) {
      expect(sourceAllowed('baby', kicks, 'a@example.com', role, docs({}))).toBe(allowed);
    }
  });

  test('a cancelled, rescheduled, renewed, closed, serviced or paused record is done', () => {
    expect(stillDue(appointment, docs({ 'babyAppointments/a1': { at: 1900000000000 } }))).toBe(true);
    expect(stillDue(appointment, docs({ 'babyAppointments/a1': { at: 1900000900000 } }))).toBe(false);
    expect(stillDue(appointment, docs({ 'babyAppointments/a1': null }))).toBe(false);
    expect(stillDue(renewal, docs({ 'carRenewals/r1': { dueDate: '2031-03-01' } }))).toBe(true);
    expect(stillDue(renewal, docs({ 'carRenewals/r1': { dueDate: '2032-03-01' } }))).toBe(false);
    expect(stillDue(renewal, docs({ 'carRenewals/r1': { dueDate: '2031-03-01', closedAt: 5 } }))).toBe(false);
    expect(stillDue(service, docs({ 'carServiceItems/s1': { lastDate: '2030-09-01' } }))).toBe(true);
    expect(stillDue(service, docs({ 'carServiceItems/s1': { lastDate: '2031-02-01' } }))).toBe(false);
    expect(stillDue(service, docs({ 'carServiceItems/s1': { lastDate: '2030-09-01', pausedAt: 7 } }))).toBe(false);
  });

  test('a kid is never checked', () => {
    expect(sourceAllowed('car', renewal, 'a@example.com', 'kid', docs({}))).toBe(false);
    expect(sourceAllowed('baby', appointment, 'a@example.com', 'member', docs({}))).toBe(true);
    // Baby appointments may be private: a helper's check could probe one they can't read.
    expect(sourceAllowed('baby', appointment, 'a@example.com', 'helper', docs({}))).toBe(false);
  });
});

describe('pet routines', () => {
  test("a routine's reminder: the routine still there, the log for that due day not yet written", () => {
    const routine = { checks: [{ doc: 'petRoutines/r1' }, { doc: 'petRoutineLogs/rtn-r1-2031-01-06', absent: true as const }] };
    expect(readSource('pet', routine)).toEqual(routine);
    expect(stillDue(routine, docs({ 'petRoutines/r1': { name: 'Scoop' }, 'petRoutineLogs/rtn-r1-2031-01-06': null }))).toBe(true);
    expect(stillDue(routine, docs({ 'petRoutines/r1': { name: 'Scoop' }, 'petRoutineLogs/rtn-r1-2031-01-06': { by: 'a@b.c' } }))).toBe(false);
    expect(stillDue(routine, docs({ 'petRoutines/r1': null, 'petRoutineLogs/rtn-r1-2031-01-06': null }))).toBe(false);
  });
});
