import { describe, expect, test } from 'bun:test';
import { isRoutineSchedule, toRoutine, routineDueDays, routineLogId, routineStatus, type RoutineLike, type RoutineLogLike } from '../src/pet-routines';

// 2031-01-06 is a Monday.
const TODAY = '2031-01-06';
const log = (routineId: string, due: string, on: string, at = 0): RoutineLogLike => ({ routineId, due, on, at });
const box = (extra: Partial<RoutineLike> = {}): RoutineLike => ({ id: 'r1', petIds: ['p1', 'p2'], mode: 'fixed', every: 1, unit: 'day', since: '2031-01-01', ...extra });

describe('routineLogId', () => {
  test('one id per routine and due day, so every writer writes the same document', () => {
    expect(routineLogId('r1', '2031-01-06')).toBe('rtn-r1-2031-01-06');
  });
});

describe('routineStatus, fixed', () => {
  test('a daily routine is due today until it is logged, then done today with its log', () => {
    expect(routineStatus(box(), [], TODAY)).toMatchObject({ state: 'due', due: TODAY, late: 0, next: '2031-01-07' });
    const l = log('r1', TODAY, TODAY);
    expect(routineStatus(box(), [l], TODAY)).toMatchObject({ state: 'done', due: TODAY, log: l, next: '2031-01-07' });
  });
  test('missed days are not piled up: only the latest occurrence is open, and it is overdue by its own days', () => {
    const weekly = box({ every: 1, unit: 'week', since: '2031-01-01' }); // Wednesdays
    expect(routineStatus(weekly, [], TODAY)).toMatchObject({ state: 'overdue', due: '2031-01-01', late: 5, next: '2031-01-08' });
    expect(routineStatus(weekly, [log('r1', '2031-01-01', '2031-01-03')], TODAY)).toMatchObject({ state: 'later', due: '2031-01-08' });
  });
  test('logs of other routines are ignored; a log that is not today but covers the occurrence leaves it later', () => {
    expect(routineStatus(box(), [log('r2', TODAY, TODAY)], TODAY).state).toBe('due');
    expect(routineStatus(box(), [log('r1', TODAY, '2031-01-05')], TODAY).state).toBe('later');
  });
  test('before it starts it is later, due on the first day', () => {
    expect(routineStatus(box({ since: '2031-01-10' }), [], TODAY)).toMatchObject({ state: 'later', due: '2031-01-10' });
  });
});

describe('routineStatus, weekdays', () => {
  const brush = box({ mode: 'weekdays', days: [1, 4], every: undefined, unit: undefined, since: '2031-01-01' }); // Monday, Thursday
  test('due on its weekdays, overdue on the days after, later once logged', () => {
    expect(routineStatus(brush, [], TODAY)).toMatchObject({ state: 'due', due: TODAY, next: '2031-01-09' });
    expect(routineStatus(brush, [], '2031-01-08')).toMatchObject({ state: 'overdue', due: TODAY, late: 2, next: '2031-01-09' });
    expect(routineStatus(brush, [log('r1', TODAY, '2031-01-07')], '2031-01-08')).toMatchObject({ state: 'later', due: '2031-01-09' });
  });
});

describe('routineStatus, after-done', () => {
  const litter = box({ mode: 'after-done', every: 1, unit: 'week' });
  test('never done: due from its first day', () => {
    expect(routineStatus(litter, [], TODAY)).toMatchObject({ state: 'overdue', due: '2031-01-01', late: 5 });
  });
  test('counted from when it was last done, not from when it was due', () => {
    const l = log('r1', '2031-01-01', '2031-01-03');
    expect(routineStatus(litter, [l], TODAY)).toMatchObject({ state: 'later', due: '2031-01-10', next: '2031-01-10', last: l });
    expect(routineStatus(litter, [l], '2031-01-10').state).toBe('due');
    expect(routineStatus(litter, [l], '2031-01-12')).toMatchObject({ state: 'overdue', late: 2 });
  });
  test('done today shows done with the log and the next day counted from today; the latest log counts', () => {
    const old = log('r1', '2031-01-01', '2030-12-20');
    const l = log('r1', '2031-01-03', TODAY);
    expect(routineStatus(litter, [old, l], TODAY)).toMatchObject({ state: 'done', log: l, next: '2031-01-13' });
  });
  test('monthly steps clamp to the month end', () => {
    const monthly = box({ mode: 'after-done', every: 1, unit: 'month' });
    expect(routineStatus(monthly, [log('r1', '2031-01-01', '2031-01-31')], '2031-02-01').due).toBe('2031-02-28');
  });
});

describe('routineDueDays', () => {
  test('a fixed routine lists each unlogged occurrence; an after-done one its next due day', () => {
    expect(routineDueDays(box(), [log('r1', TODAY, TODAY)], TODAY, '2031-01-08')).toEqual(['2031-01-07', '2031-01-08']);
    const litter = box({ mode: 'after-done', every: 1, unit: 'week' });
    expect(routineDueDays(litter, [log('r1', '2031-01-01', '2031-01-03')], TODAY, '2031-01-08')).toEqual([]);
    expect(routineDueDays(litter, [log('r1', '2031-01-01', '2031-01-03')], TODAY, '2031-01-12')).toEqual(['2031-01-10']);
    expect(routineDueDays(litter, [], TODAY, '2031-01-08')).toEqual([]);
  });
});

describe('isRoutineSchedule', () => {
  test('accepts what the rules accept', () => {
    expect(isRoutineSchedule(box())).toBe(true);
    expect(isRoutineSchedule(box({ mode: 'weekdays', days: [1, 4] }))).toBe(true);
    expect(isRoutineSchedule(box({ mode: 'weekdays', days: [] }))).toBe(false);
    expect(isRoutineSchedule(box({ every: 0 }))).toBe(false);
    expect(isRoutineSchedule(box({ unit: 'year' as 'day' }))).toBe(false);
    expect(isRoutineSchedule(box({ since: 'soon' }))).toBe(false);
  });
});

describe('toRoutine', () => {
  const doc = { name: ' Scoop litter box ', kind: 'scoop', petIds: ['p1', 'p2'], mode: 'fixed', every: 1, unit: 'day', since: '2031-01-01', remind: true, time: '19:00' };
  test('reads a routine as the rules would have taken it', () => {
    expect(toRoutine('r1', doc)).toEqual({ id: 'r1', name: 'Scoop litter box', kind: 'scoop', petIds: ['p1', 'p2'], mode: 'fixed', every: 1, unit: 'day', since: '2031-01-01', remind: true, time: '19:00' });
    expect(toRoutine('r2', { name: 'Brush', petIds: ['p1'], mode: 'weekdays', days: [1, 4], since: '2031-01-01' })).toMatchObject({ mode: 'weekdays', days: [1, 4], remind: false });
  });
  test('is null for what the rules would refuse, so every reader agrees it is not there', () => {
    for (const bad of [{ mode: 'yearly' }, { mode: undefined }, { name: '  ' }, { petIds: [] }, { every: 0 }, { unit: 'year' }, { since: 'soon' }, { petIds: ['p1', 5] }, { petIds: Array.from({ length: 9 }, (_, i) => `p${i}`) }, { name: 'x'.repeat(61) }, { mode: 'weekdays', days: [1, 'x'] }])
      expect(toRoutine('r1', { ...doc, ...bad })).toBeNull();
    expect(toRoutine('r1', { ...doc, mode: 'weekdays' })).toBeNull();
  });
});
