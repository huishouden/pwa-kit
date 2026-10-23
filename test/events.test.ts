import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeZone } from './tz';
import cases from './fixtures/event-rules.json';
import {
  cleanRule, describePrep, fitsRule, describeRule, eventOccurrences, happensOn, inferRule, isEventRule, isPrepOffset, nextOccurrence, nthWeekday, occurrenceStart,
  prepState, prepWhen, prepWindow, pruneChanges, ruleOccurrences, toChange, weekdayOfMonth, withChange, type EventRule, type OccurrenceChanges,
} from '../src/schedule';
import { atTime, clockWords, isHhmm, toHhmm, HOUR } from '../src/time';
import { looksLikePrep, recurringSeries, seriesCover, similarTitles, type CalendarMatch, type CalendarSeries, type ScheduledEvent } from '../src/calendar';

describe('event rules', () => {
  for (const c of cases.occurrences) {
    const rule = c.rule as EventRule;
    test(`${c.why}: ${c.describe}`, () => {
      expect(isEventRule(rule)).toBe(true);
      expect(ruleOccurrences(rule, c.from, c.to)).toEqual(c.expected);
      expect(describeRule(rule)).toBe(c.describe);
      for (const d of c.expected) expect(happensOn(rule, d)).toBe(true);
    });
  }

  test('nothing in an empty or reversed window', () => {
    const r: EventRule = { freq: 'week', every: 1, start: '2031-10-02' };
    expect(ruleOccurrences(r, '2031-10-03', '2031-10-08')).toEqual([]);
    expect(ruleOccurrences(r, '2031-10-20', '2031-10-10')).toEqual([]);
    expect(happensOn(r, '2031-10-03')).toBe(false);
    expect(happensOn(r, 'not a day')).toBe(false);
  });

  test('a window years after the start is found without walking from the start', () => {
    const r: EventRule = { freq: 'week', every: 2, start: '2001-01-04' };
    const t = performance.now();
    expect(ruleOccurrences(r, '2091-01-01', '2091-01-31')).toHaveLength(2);
    expect(performance.now() - t).toBeLessThan(50);
  });

  test('isEventRule refuses what the rules refuse', () => {
    const ok: EventRule = { freq: 'month', every: 1, start: '2031-01-01', nth: 2, weekday: 3 };
    expect(isEventRule(ok)).toBe(true);
    for (const bad of [
      null, [], { ...ok, freq: 'day' }, { ...ok, every: 0 }, { ...ok, every: 100 }, { ...ok, every: 1.5 }, { ...ok, start: '2031-02-30' },
      { ...ok, nth: 5 }, { ...ok, weekday: 7 }, { freq: 'month', every: 1, start: '2031-01-01', nth: 2 }, { ...ok, extra: 1 },
      { freq: 'week', every: 1, start: '2031-01-01', days: [] }, { freq: 'week', every: 1, start: '2031-01-01', days: [7] },
      { freq: 'month', every: 1, start: '2031-01-01', days: [1] }, { freq: 'week', every: 1, start: '2031-01-01', nth: 1, weekday: 1 },
      { freq: 'week', every: 1, start: '2031-01-10', until: '2031-01-01' },
    ])
      expect(isEventRule(bad)).toBe(false);
  });

  test('cleanRule keeps only what the rule says', () => {
    expect(cleanRule({ freq: 'week', every: 1, start: '2031-10-02', days: [4] })).toEqual({ freq: 'week', every: 1, start: '2031-10-02' });
    expect(cleanRule({ freq: 'week', every: 1, start: '2031-10-02', days: [4, 1, 4] })).toEqual({ freq: 'week', every: 1, start: '2031-10-02', days: [1, 4] });
    expect(cleanRule({ freq: 'month', every: 1, start: '2031-10-02', days: [4] })).toEqual({ freq: 'month', every: 1, start: '2031-10-02' });
  });

  test('weekday of the month', () => {
    expect(nthWeekday(2031, 10, 1, 4)).toBe('2031-10-02');
    expect(nthWeekday(2031, 10, -1, 4)).toBe('2031-10-30');
    expect(nthWeekday(2031, 2, 4, 6)).toBe('2031-02-22');
    expect(weekdayOfMonth('2031-10-30')).toEqual({ nth: 5, weekday: 4, last: true });
    expect(weekdayOfMonth('2031-10-23')).toEqual({ nth: 4, weekday: 4, last: false });
  });
});

describe('changes to one occurrence', () => {
  const trash: EventRule = { freq: 'week', every: 1, start: '2031-01-02' };

  test('a moved occurrence appears on its new day with its new time; the schedule is untouched', () => {
    const changes: OccurrenceChanges = { '2031-12-25': { moved: { date: '2031-12-26', time: '08:00' }, note: 'Holiday week' } };
    const occ = eventOccurrences(trash, '2031-12-20', '2032-01-03', { time: '07:00', changes });
    expect(occ).toEqual([
      { original: '2031-12-25', date: '2031-12-26', time: '08:00', moved: true, skipped: false, note: 'Holiday week' },
      { original: '2032-01-01', date: '2032-01-01', time: '07:00', moved: false, skipped: false },
    ]);
    expect(ruleOccurrences(trash, '2031-12-20', '2032-01-03')).toEqual(['2031-12-25', '2032-01-01']);
  });

  test('a move across the window edge is found from either side', () => {
    const changes = { '2031-10-30': { moved: { date: '2031-11-03' } } };
    expect(eventOccurrences(trash, '2031-11-01', '2031-11-07', { changes }).map((o) => [o.original, o.date])).toEqual([['2031-10-30', '2031-11-03'], ['2031-11-06', '2031-11-06']]);
    expect(eventOccurrences(trash, '2031-10-27', '2031-10-31', { changes })).toEqual([]);
  });

  test('a moved one keeps the usual time unless it got its own', () => {
    const changes = { '2031-10-30': { moved: { date: '2031-10-31' } } };
    expect(eventOccurrences(trash, '2031-10-31', '2031-10-31', { time: '07:00', changes })[0].time).toBe('07:00');
  });

  test('a skipped one is left out, or kept and marked', () => {
    const changes = { '2031-10-23': { skipped: true as const, note: 'Strike' } };
    expect(eventOccurrences(trash, '2031-10-20', '2031-10-31', { changes }).map((o) => o.date)).toEqual(['2031-10-30']);
    expect(eventOccurrences(trash, '2031-10-20', '2031-10-31', { changes, includeSkipped: true }).map((o) => [o.date, o.skipped, o.note])).toEqual([
      ['2031-10-23', true, 'Strike'],
      ['2031-10-30', false, undefined],
    ]);
    expect(nextOccurrence(trash, '2031-10-20', { changes })?.date).toBe('2031-10-30');
  });

  test('a change on a day the rule does not happen is ignored, as is a malformed one', () => {
    const changes = { '2031-10-24': { skipped: true }, '2031-10-23': { moved: { date: 'soon' } } } as unknown as OccurrenceChanges;
    expect(eventOccurrences(trash, '2031-10-20', '2031-10-26', { changes }).map((o) => [o.date, o.moved])).toEqual([['2031-10-23', false]]);
    expect(toChange({ moved: { date: '2031-10-24', time: '25:00' } })).toEqual({ moved: { date: '2031-10-24' } });
    expect(toChange({ note: 'just a note' })).toBeNull();
  });

  test('withChange adds, replaces, clears and keeps the newest MAX_CHANGES', () => {
    let c = withChange(undefined, '2031-10-23', { skipped: true });
    expect(c).toEqual({ '2031-10-23': { skipped: true } });
    c = withChange(c, '2031-10-23', { moved: { date: '2031-10-24' } });
    expect(c).toEqual({ '2031-10-23': { moved: { date: '2031-10-24' } } });
    expect(withChange(c, '2031-10-23', null)).toEqual({});
    expect(withChange(c, '2031-10-23', { moved: { date: '2031-10-23' } })).toEqual({});
    let many: OccurrenceChanges = {};
    for (const d of ruleOccurrences(trash, '2031-01-01', '2033-12-31')) many = withChange(many, d, { skipped: true });
    expect(Object.keys(many)).toHaveLength(100);
    expect(Object.keys(many).sort()[0] > '2032-01-01').toBe(true);
  });

  test('pruneChanges forgets the past but keeps a past day moved into the future', () => {
    const c: OccurrenceChanges = {
      '2031-10-02': { skipped: true },
      '2031-10-09': { moved: { date: '2031-10-20' } },
      '2031-10-23': { skipped: true },
    };
    expect(Object.keys(pruneChanges(c, '2031-10-16')).sort()).toEqual(['2031-10-09', '2031-10-23']);
  });
});

describe('something to do before', () => {
  test('presets read as people say them', () => {
    expect(describePrep({ daysBefore: 1, time: '19:00' })).toBe('The evening before at 7 PM');
    expect(describePrep({ daysBefore: 0, time: '07:00' })).toBe('The morning of, by 7 AM');
    expect(describePrep({ daysBefore: 2, time: '09:30' })).toBe('2 days before at 9:30 AM');
    expect(describePrep({ daysBefore: 1, time: '12:00' })).toBe('The day before at 12 PM');
    expect(isPrepOffset({ daysBefore: 15, time: '19:00' })).toBe(false);
    expect(isPrepOffset({ daysBefore: 1, time: '7pm' })).toBe(false);
  });

  test('due the evening before, missed when pickup begins; all day, missed at the end of its day', () => {
    const timed = prepWindow({ date: '2031-10-23', time: '07:00' }, { daysBefore: 1, time: '19:00' });
    expect(timed).toEqual({ day: '2031-10-22', deadline: atTime('2031-10-22', '19:00'), missedAt: atTime('2031-10-23', '07:00') });
    const allDay = prepWindow({ date: '2031-10-23' }, { daysBefore: 1, time: '19:00' });
    expect(allDay.missedAt).toBe(atTime('2031-10-24'));
    // Due after the event begins (the morning of, for a 6 AM pickup): missed only at the end of the day.
    expect(prepWindow({ date: '2031-10-23', time: '06:00' }, { daysBefore: 0, time: '07:00' }).missedAt).toBe(atTime('2031-10-24'));
  });

  test('later, soon within a day, due after the deadline, missed once it begins, done', () => {
    const w = prepWindow({ date: '2031-10-23', time: '07:00' }, { daysBefore: 1, time: '19:00' });
    expect(prepState(w, atTime('2031-10-21', '18:00'), false)).toBe('later');
    expect(prepState(w, atTime('2031-10-21', '19:00'), false)).toBe('soon');
    expect(prepState(w, atTime('2031-10-22', '20:00'), false)).toBe('due');
    expect(prepState(w, atTime('2031-10-23', '07:00'), false)).toBe('missed');
    expect(prepState(w, atTime('2031-10-23', '07:00'), true)).toBe('done');
    expect(prepState(w, atTime('2031-10-22', '08:00'), false, 6)).toBe('later');
  });

  test('prepWhen', () => {
    const now = atTime('2031-10-22', '10:30');
    expect(prepWhen(atTime('2031-10-22', '19:00'), now)).toBe('tonight by 7 PM');
    expect(prepWhen(atTime('2031-10-22', '12:00'), now)).toBe('today by 12 PM');
    expect(prepWhen(atTime('2031-10-23', '07:30'), now)).toBe('tomorrow by 7:30 AM');
    expect(prepWhen(atTime('2031-10-25', '19:00'), now)).toBe('Saturday by 7 PM');
    expect(prepWhen(atTime('2031-11-05', '19:00'), now)).toBe('Nov 5 by 7 PM');
  });
});

describe('daylight saving time', () => {
  let restore = () => {};
  beforeAll(() => {
    restore = setTimeZone('America/New_York');
  });
  afterAll(() => restore());

  test('7 PM stays 7 PM on the wall across the change, in both directions', () => {
    // US clocks go back on Sunday 2 November 2031 and forward on Sunday 14 March 2032.
    const weekly: EventRule = { freq: 'week', every: 1, start: '2031-10-05' };
    for (const [from, to] of [['2031-10-26', '2031-11-09'], ['2032-03-07', '2032-03-21']]) {
      const occ = eventOccurrences(weekly, from, to, { time: '19:00' });
      expect(occ).toHaveLength(3);
      for (const o of occ) expect(toHhmm(occurrenceStart(o))).toBe('19:00');
      const gaps = occ.slice(1).map((o, i) => (occurrenceStart(o) - occurrenceStart(occ[i])) / HOUR);
      expect(gaps.sort()).toEqual(from.startsWith('2031') ? [168, 169] : [167, 168]);
    }
  });

  test('the evening before a pickup on the day the clocks change', () => {
    const w = prepWindow({ date: '2031-11-02', time: '07:00' }, { daysBefore: 1, time: '19:00' });
    expect(toHhmm(w.deadline)).toBe('19:00');
    expect((w.missedAt - w.deadline) / HOUR).toBe(13);
  });

  test('a time the spring change skips lands just after the gap', () => {
    expect(toHhmm(atTime('2032-03-14', '02:30'))).toBe('03:30');
  });
});

describe('times of day', () => {
  test('clockWords and isHhmm', () => {
    expect(['00:00', '07:00', '12:00', '12:30', '19:05', '23:59'].map((t) => clockWords(t))).toEqual(['12 AM', '7 AM', '12 PM', '12:30 PM', '7:05 PM', '11:59 PM']);
    expect(['7:00', '24:00', '19:60', 1900, ''].some(isHhmm)).toBe(false);
  });
});

describe('recognising a schedule', () => {
  for (const c of cases.infer) test(c.why, () => expect(inferRule(c.dates)).toEqual(c.expected as EventRule | null));

  test('an inferred rule gives back the dates it came from', () => {
    for (const c of cases.infer.filter((x) => x.expected)) {
      const rule = inferRule(c.dates)!;
      for (const d of c.dates) expect(happensOn(rule, d)).toBe(true);
    }
  });
});

describe('repeating calendar events', () => {
  const ev = (id: string, title: string, y: number, m: number, d: number, h?: number, series?: string): CalendarMatch => ({
    id,
    title,
    start: h === undefined ? new Date(y, m - 1, d).getTime() : new Date(y, m - 1, d, h).getTime(),
    allDay: h === undefined,
    location: '',
    description: '',
    link: `https://calendar.example.com/${id}`,
    calendarName: 'Family',
    ...(series ? { recurringEventId: series } : {}),
  });

  test('occurrences of a series become one schedule; one-offs and lone occurrences stay', () => {
    const { series, rest } = recurringSeries([
      ev('t2', 'Garbage pickup', 2031, 10, 30, 7, 'trash'),
      ev('t1', 'Garbage pickup', 2031, 10, 23, 7, 'trash'),
      ev('r1', 'Recycling', 2031, 10, 16),
      ev('r2', 'recycling ', 2031, 10, 30),
      ev('a', 'Lawn aeration', 2031, 10, 24, 9),
      ev('h', 'HOA meeting', 2031, 11, 11, 19, 'hoa'),
    ]);
    expect(series.map((s) => [s.key, s.title, s.rule, s.time, s.matches.map((m) => m.id)])).toEqual([
      ['title:recycling', 'Recycling', { freq: 'week', every: 2, start: '2031-10-16' }, undefined, ['r1', 'r2']],
      ['trash', 'Garbage pickup', { freq: 'week', every: 1, start: '2031-10-23' }, '07:00', ['t1', 't2']],
    ]);
    expect(rest.map((m) => m.id)).toEqual(['a', 'h']);
  });

  test('irregular dates under one title are not a schedule', () => {
    const { series, rest } = recurringSeries([ev('1', 'Lawn service', 2031, 10, 2, 9), ev('2', 'Lawn service', 2031, 10, 5, 9), ev('3', 'Lawn service', 2031, 10, 19, 9)]);
    expect(series).toEqual([]);
    expect(rest).toHaveLength(3);
  });
});

describe('a series the household already has', () => {
  // Thursday 16 October 2031; Sunday the 19th, Monday the 20th, Wednesday the 22nd.
  const weekly = (title: string, firstDay: number, h: number | undefined, weeks = 4, every = 1): CalendarSeries => {
    const matches: CalendarMatch[] = Array.from({ length: weeks }, (_, i) => ({
      id: `${title}-${i}`,
      title,
      start: h === undefined ? new Date(2031, 9, firstDay + 7 * every * i).getTime() : new Date(2031, 9, firstDay + 7 * every * i, h).getTime(),
      allDay: h === undefined,
      location: '',
      description: '',
      link: '',
      calendarName: 'Family',
    }));
    return recurringSeries(matches).series[0];
  };
  type Ev = ScheduledEvent & { id: string; kind: string };
  const kindOf = (t: string) => (/garbage|trash/i.test(t) ? 'trash' : /recycl/i.test(t) ? 'recycling' : /lawn/i.test(t) ? 'lawn' : null);
  const related = (s: CalendarSeries, e: Ev) => kindOf(s.title) === e.kind;
  // Garbage on Mondays and Thursdays, entered recently (after the calendar series began).
  const garbage: Ev = { id: 'g', kind: 'trash', title: 'Garbage pickup', rule: { freq: 'week', every: 1, start: '2031-11-03', days: [1, 4] }, time: '07:00', prep: { offset: { daysBefore: 1, time: '19:00' } } };
  const recycling: Ev = { id: 'r', kind: 'recycling', title: 'Recycling pickup', rule: { freq: 'week', every: 2, start: '2031-10-16' } };

  test('fitsRule carries the pattern on before the start and after the end', () => {
    expect(fitsRule(garbage.rule, '2031-10-20')).toBe(true);
    expect(fitsRule(garbage.rule, '2031-10-21')).toBe(false);
    expect(fitsRule(recycling.rule, '2031-10-02')).toBe(true);
    expect(fitsRule(recycling.rule, '2031-10-09')).toBe(false);
    expect(fitsRule({ freq: 'month', every: 1, start: '2031-06-10', nth: 2, weekday: 2, until: '2031-07-01' }, '2031-10-14')).toBe(true);
    expect(fitsRule({ freq: 'year', every: 1, start: '2031-06-10' }, '2029-06-10')).toBe(true);
    expect(fitsRule({ freq: 'year', every: 1, start: '2031-06-10' }, '2029-06-11')).toBe(false);
  });

  test('the pickups themselves: the same days and rhythm', () => {
    const cover = seriesCover(weekly('Trash day', 20, 7), [recycling, garbage], { related });
    expect(cover).toEqual({ event: garbage, as: 'occurrences' });
    expect(seriesCover(weekly('Recycling', 16, undefined, 3, 2), [garbage, recycling], { related })).toEqual({ event: recycling, as: 'occurrences' });
  });

  test('the evening before a Monday pickup and before a Thursday one is the reminder', () => {
    const monday = weekly('Garbage out for Monday Pickup', 19, 20);
    const thursday = weekly('Garbage out for Thursday Pickup', 22, 20);
    expect(seriesCover(monday, [garbage], { related })).toEqual({ event: garbage, as: 'prep', offset: { daysBefore: 1, time: '20:00' } });
    expect(seriesCover(thursday, [garbage], { related })).toEqual({ event: garbage, as: 'prep', offset: { daysBefore: 1, time: '20:00' } });
    // With no thing to do before yet, the day before is still where a reminder goes.
    const { prep: _, ...bare } = garbage;
    expect(seriesCover(monday, [bare], { related })).toEqual({ event: bare, as: 'prep', offset: { daysBefore: 1, time: '20:00' } });
    expect(looksLikePrep(monday)).toBe(true);
  });

  test('slack: a day and two hours either side of the thing to do before', () => {
    const twoBefore = { ...garbage, prep: { offset: { daysBefore: 2, time: '18:00' } } };
    expect(seriesCover(weekly('Garbage out', 19, 20), [twoBefore], { related })?.offset).toEqual({ daysBefore: 1, time: '20:00' });
    const morning = { ...garbage, prep: { offset: { daysBefore: 1, time: '09:00' } } };
    expect(seriesCover(weekly('Garbage out', 19, 20), [morning], { related })).toBeNull();
  });

  test('a new series is not covered: another kind, other days, or another rhythm', () => {
    expect(seriesCover(weekly('Recycling out', 19, 20), [garbage], { related })).toBeNull();
    expect(seriesCover(weekly('Garbage pickup', 22, 7), [{ ...garbage, rule: { freq: 'week', every: 1, start: '2031-10-16' }, prep: undefined }], { related })).toBeNull();
    expect(seriesCover(weekly('Recycling', 16, undefined, 4, 1), [recycling], { related })).toBeNull();
    expect(seriesCover(weekly('Lawn service', 17, 9), [garbage, recycling], { related })).toBeNull();
  });

  test('what reads as a reminder, and titles that name the same thing', () => {
    expect(looksLikePrep({ title: 'Put the bins out', time: '07:00' })).toBe(true);
    expect(looksLikePrep({ title: 'Garbage pickup', time: '07:00' })).toBe(false);
    expect(looksLikePrep({ title: 'Garbage pickup', time: '20:00' })).toBe(true);
    expect(looksLikePrep({ title: 'Lawn service' })).toBe(false);
    expect(similarTitles('Trash pickup', 'trash  Pickup!')).toBe(true);
    expect(similarTitles('The recycling pickup', 'Recycling pickup')).toBe(true);
    expect(similarTitles('Garbage pickup', 'Garbage out for Monday Pickup')).toBe(false);
    expect(similarTitles('Lawn service', 'Pool service')).toBe(false);
    expect(looksLikePrep({ title: 'Sacar la basura', time: '07:00' })).toBe(true);
    expect(looksLikePrep({ title: 'Container buiten zetten', time: '07:00' })).toBe(true);
    expect(looksLikePrep({ title: 'Recolección de basura', time: '07:00' })).toBe(false);
    expect(looksLikePrep({ title: 'Afval ophalen', time: '07:00' })).toBe(false);
    expect(similarTitles('Recolección de basura', 'recolección de la basura')).toBe(true);
    expect(similarTitles('Recolección de basura', 'Recolección de reciclaje')).toBe(false);
    expect(similarTitles('Oud papier ophalen', 'oud papier  ophalen')).toBe(true);
  });
});
