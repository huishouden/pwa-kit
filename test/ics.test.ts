import { afterAll, describe, expect, test } from 'bun:test';
import { setTimeZone } from './tz';
import ICAL from 'ical.js';
import * as nodeIcal from 'node-ical';
import {
  CRLF, allDayOf, escapeText, firstOccurrence, foldLine, icsCalendar, icsLocal, icsProblems, ruleToRrule, transitionsIn, vtimezone, zonedTime, type IcsEvent,
} from '../src/ics';
import { ruleOccurrences, type EventRule } from '../src/schedule';
import { offsetAt } from '../src/local-clock';
import { addDays, type Ymd } from '../src/time';

const enc = new TextEncoder();

describe('text', () => {
  test('escapes backslash, semicolon, comma and line breaks', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  test('folds at 75 octets without splitting a character, and unfolds back', () => {
    const line = `DESCRIPTION:${'Pickup ñ € 🗑 '.repeat(20)}`;
    const folded = foldLine(line);
    for (const part of folded.split(CRLF)) expect(enc.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.split(`${CRLF} `).join('')).toBe(line);
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });
});

const ZONES = ['Europe/Amsterdam', 'America/New_York', 'America/Mexico_City', 'Australia/Sydney', 'Asia/Kolkata', 'America/Santiago', 'Pacific/Auckland'];

describe('VTIMEZONE', () => {
  test('Amsterdam: the last Sundays of March and October, as yearly rules', () => {
    const lines = vtimezone('Europe/Amsterdam', 2031);
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU');
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
    expect(lines).toContain('DTSTART:20300331T020000');
    expect(lines).toContain('DTSTART:20301027T030000');
  });

  test('New York: the second Sunday of March, the first of November', () => {
    const lines = vtimezone('America/New_York', 2031);
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU');
    expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU');
  });

  test('a zone without changes has one STANDARD observance', () => {
    expect(transitionsIn('Asia/Kolkata', 2031)).toHaveLength(0);
    expect(vtimezone('Asia/Kolkata', 2031).filter((l) => l.startsWith('BEGIN:'))).toEqual(['BEGIN:VTIMEZONE', 'BEGIN:STANDARD']);
  });

  for (const zone of ZONES) {
    test(`${zone}: ical.js reads every hour of three years back to the same instant`, () => {
      const cal = icsCalendar({ name: 'T', timeZone: zone, now: Date.UTC(2031, 0, 1), events: [{ uid: 'x@t', summary: 'x', start: { at: Date.UTC(2031, 0, 1) } }] });
      expect(icsProblems(cal)).toEqual([]);
      const comp = new ICAL.Component(ICAL.parse(cal));
      const tz = new ICAL.Timezone(comp.getFirstSubcomponent('vtimezone')!);
      for (let t = Date.UTC(2031, 0, 1); t < Date.UTC(2034, 0, 1); t += 3_600_000) {
        // The repeated hour when clocks go back reads as its first instance, as in every client.
        const ambiguous = offsetAt(zone, t - 3_600_000) !== offsetAt(zone, t) || offsetAt(zone, t + 3_600_000) !== offsetAt(zone, t);
        if (ambiguous) continue;
        const local = icsLocal(t, zone);
        const time = ICAL.Time.fromData({ year: +local.slice(0, 4), month: +local.slice(4, 6), day: +local.slice(6, 8), hour: +local.slice(9, 11), minute: +local.slice(11, 13), second: +local.slice(13, 15), isDate: false }, tz);
        expect(time.toUnixTime() * 1000).toBe(t);
      }
    });
  }

  test('zonedTime and allDayOf agree with the zone across a clock change', () => {
    expect(zonedTime('2031-10-26', '09:00', 'Europe/Amsterdam')).toBe(Date.parse('2031-10-26T09:00:00+01:00'));
    expect(zonedTime('2031-10-25', '09:00', 'Europe/Amsterdam')).toBe(Date.parse('2031-10-25T09:00:00+02:00'));
    expect(allDayOf(Date.parse('2031-03-30T00:00:00+01:00'), 'Europe/Amsterdam')).toBe('2031-03-30');
  });
});

// node-ical reads an all-day DTSTART as local midnight, which the dates below take in UTC: east of
// UTC that is the day before. Run in UTC, whatever zone the run (or the file before) is in.
afterAll(setTimeZone('UTC'));

/** The same, expanded by node-ical's rrule.js, which handles BYSETPOS (ical.js does not). */
function expandRrule(rule: EventRule, from: Ymd, to: Ymd): Ymd[] {
  const first = firstOccurrence(rule)!;
  const ics = icsCalendar({ name: 'T', timeZone: 'UTC', now: 0, events: [{ uid: 'r@t', summary: 'r', start: { date: first }, end: { date: addDays(first, 1) }, rrule: ruleToRrule(rule) }] });
  const event = Object.values(nodeIcal.sync.parseICS(ics)).find((v) => (v as { type?: string }).type === 'VEVENT') as unknown as { rrule: { between: (a: Date, b: Date, inc: boolean) => Date[] } };
  return event.rrule
    .between(new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`), true)
    .map((d) => d.toISOString().slice(0, 10))
    .filter((d) => d >= from && d <= to);
}

/** Every day ical.js expands the RRULE to (all day, DTSTART at the rule's first occurrence) from `from` to `to`. */
function expand(rule: EventRule, from: Ymd, to: Ymd): Ymd[] {
  const first = firstOccurrence(rule)!;
  const ics = icsCalendar({ name: 'T', timeZone: 'UTC', now: 0, events: [{ uid: 'r@t', summary: 'r', start: { date: first }, end: { date: addDays(first, 1) }, rrule: ruleToRrule(rule) }] });
  expect(icsProblems(ics)).toEqual([]);
  const event = new ICAL.Event(new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent')!);
  const it = event.iterator();
  const out: Ymd[] = [];
  for (let next = it.next(); next; next = it.next()) {
    const d = next.toString().slice(0, 10);
    if (d > to) break;
    if (d >= from) out.push(d);
    if (out.length > 400) break;
  }
  return out;
}

describe('RRULE from the kit’s event rules', () => {
  const rules: [string, EventRule][] = [
    ['every Thursday', { freq: 'week', every: 1, start: '2031-09-04' }],
    ['every other Friday', { freq: 'week', every: 2, start: '2031-09-05' }],
    ['every 3 weeks on Monday and Thursday, starting on a Friday', { freq: 'week', every: 3, start: '2031-09-05', days: [1, 4] }],
    ['every other week on Sunday and Saturday', { freq: 'week', every: 2, start: '2031-09-03', days: [0, 6] }],
    ['monthly on the 15th', { freq: 'month', every: 1, start: '2031-01-15' }],
    ['monthly on the 31st (last day of shorter months)', { freq: 'month', every: 1, start: '2031-01-31' }],
    ['every 2 months on the 30th', { freq: 'month', every: 2, start: '2031-12-30' }],
    ['the third Tuesday', { freq: 'month', every: 1, start: '2031-01-21', nth: 3, weekday: 2 }],
    ['every 3 months on the last Friday', { freq: 'month', every: 3, start: '2031-01-31', nth: -1, weekday: 5 }],
    ['yearly on November 2', { freq: 'year', every: 1, start: '2031-11-02' }],
    ['every 2 years on 29 February', { freq: 'year', every: 1, start: '2032-02-29' }],
    ['weekly until a day', { freq: 'week', every: 1, start: '2031-09-04', until: '2031-12-18' }],
  ];
  for (const [name, rule] of rules) {
    test(`${name}: ${ruleToRrule(rule)}`, () => {
      const from = rule.start;
      const to = addDays(from, 365 * 4);
      const expected = ruleOccurrences(rule, from, to);
      // ical.js (Thunderbird's) has no BYSETPOS; the 29th and 30th use it, so rrule.js checks those.
      if (ruleToRrule(rule).includes('BYSETPOS')) expect(expandRrule(rule, from, to)).toEqual(expected);
      else expect(expand(rule, from, to)).toEqual(expected);
      expect(expandRrule(rule, from, to)).toEqual(expected);
    });
  }

  test('a timed series ends in UTC (UNTIL with Z)', () => {
    const rule: EventRule = { freq: 'week', every: 1, start: '2031-09-04', until: '2031-12-18' };
    expect(ruleToRrule(rule, { untilUtc: zonedTime('2031-12-18', '07:00', 'Europe/Amsterdam') })).toContain('UNTIL=20311218T060000Z');
  });
});

describe('a whole calendar', () => {
  const events: IcsEvent[] = [
    { uid: 'a@t', summary: 'Garbage pickup; bins, please', start: { at: Date.parse('2031-10-02T07:00:00+02:00') }, end: { at: Date.parse('2031-10-02T07:30:00+02:00') }, rrule: 'FREQ=WEEKLY;BYDAY=TH;WKST=SU', exdates: [Date.parse('2031-10-16T07:00:00+02:00')], sequence: 3, lastModified: 0 },
    { uid: 'a@t', summary: 'Garbage pickup (moved)', recurrenceId: Date.parse('2031-10-23T07:00:00+02:00'), start: { at: Date.parse('2031-10-24T08:00:00+02:00') }, end: { at: Date.parse('2031-10-24T08:30:00+02:00') } },
    { uid: 'b@t', summary: 'Take the bins out', start: { at: Date.parse('2031-10-01T19:00:00+02:00') }, alarms: [{ minutesBefore: 0, description: 'Take the bins out' }], transparent: true },
    { uid: 'c@t', summary: 'Insurance', start: { date: '2031-10-28' }, end: { date: '2031-10-30' }, rrule: 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=28', exdates: ['2032-10-28'] },
  ];
  const ics = icsCalendar({ name: 'Huishouden', timeZone: 'Europe/Amsterdam', events, now: Date.UTC(2031, 9, 1), lang: 'nl' });

  test('passes the structural check', () => {
    expect(icsProblems(ics)).toEqual([]);
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(ics).toContain('X-PUBLISHED-TTL:PT1H');
    expect(ics).toContain('SUMMARY:Garbage pickup\\; bins\\, please');
  });

  test('the checker catches what is wrong', () => {
    expect(icsProblems('BEGIN:VCALENDAR\nEND:VCALENDAR\n')).toContain('has a line break that is not CRLF');
    expect(icsProblems(`BEGIN:VCALENDAR${CRLF}VERSION:2.0${CRLF}PRODID:x${CRLF}BEGIN:VEVENT${CRLF}DTSTART;TZID=Nowhere/Zone:20310101T000000${CRLF}END:VEVENT${CRLF}END:VCALENDAR${CRLF}`)).toEqual(
      expect.arrayContaining(['VEVENT has no UID', 'VEVENT has no DTSTAMP', 'TZID Nowhere/Zone has no VTIMEZONE']),
    );
  });

  test('all-day exceptions and series expand in ical.js', () => {
    const comp = new ICAL.Component(ICAL.parse(ics));
    const insurance = new ICAL.Event(comp.getAllSubcomponents('vevent').find((v) => v.getFirstPropertyValue('uid') === 'c@t')!);
    const it = insurance.iterator();
    const years = [it.next()!.toString(), it.next()!.toString()];
    expect(years).toEqual(['2031-10-28', '2033-10-28']);
  });
});
