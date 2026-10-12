import { describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import * as nodeIcal from 'node-ical';
import { toAgendaItem, type AgendaItem } from '../src/agenda-core';
import { toTodoItem, type TodoItem } from '../src/todo-core';
import type { Role } from '../src/role-core';
import {
  DEFAULT_CALENDAR_SETTINGS, addToCalendarIcs, exportEvents, exportIcs, calendarSettingsDoc, exportUid, googleTemplateUrl, isExportedEvent, loadExportLang, toCalendarSettings, visibleTo,
  type CalendarSettings, type ExportInput,
} from '../src/calendar-export';
import { toMatch } from '../src/calendar';
import fixture from './fixtures/calendar-export/agenda.json';

const at = (iso: string) => Date.parse(iso);
const TZ = fixture.timeZone;
const NOW = at('2031-10-01T12:00:00Z');

const agenda: AgendaItem[] = fixture.agenda.map(({ id, start, end, ...rest }) =>
  toAgendaItem(id, { ...rest, start: at(start), ...(end ? { end: at(end) } : {}) }),
);
const todos: TodoItem[] = fixture.todos.map(({ id, due, ...rest }) => toTodoItem(id, { ...rest, ...(due ? { due: at(due) } : {}) }));

function input(me: string, settings: Partial<CalendarSettings> = {}, lang: ExportInput['lang'] = 'en'): ExportInput {
  return { agenda, todos, me, role: (fixture.members as Record<string, Role>)[me], lang, timeZone: TZ, settings: { ...DEFAULT_CALENDAR_SETTINGS, ...settings } };
}

const keys = (me: string, settings?: Partial<CalendarSettings>) => exportEvents(input(me, settings)).map((e) => e.key);

describe('who sees what', () => {
  test('an admin sees everything they are in the audience of, bills included', () => {
    const k = keys('admin@example.com');
    expect(k).toContain('bills|bill:power');
    expect(k).toContain('pet|appointment:vet');
    expect(k).toContain('health|dose:ana:2031-10-05T08:00');
  });

  test('a helper gets no bills, no private items and no Health', () => {
    const k = keys('helper@example.com');
    expect(k).not.toContain('bills|bill:power');
    expect(k).not.toContain('pet|appointment:vet');
    expect(k.some((x) => x.startsWith('health|'))).toBe(false);
    expect(k.some((x) => x.includes('bills'))).toBe(false);
    expect(k).toContain('home|event:bins');
    expect(k).toContain('baby|appointment:checkup');
  });

  test('a kid sees what a helper does', () => {
    expect(keys('kid@example.com')).toEqual(keys('helper@example.com'));
  });

  test('a member who is not a carer gets no Health; a carer does', () => {
    expect(keys('member@example.com').some((x) => x.startsWith('health|'))).toBe(false);
    expect(keys('carer@example.com')).toContain('health|dose:ana:2031-10-05T08:00');
  });

  test('an item without a private flag counts as private to helpers', () => {
    const unflagged = toAgendaItem('x', { app: 'home', ref: 'job:x', kind: 'due', title: 'Old', start: NOW, allDay: true, url: 'https://example.com/' });
    const events = exportEvents({ ...input('helper@example.com'), agenda: [unflagged], todos: [] });
    expect(events).toHaveLength(0);
  });
});

describe('settings', () => {
  test('defaults: everything on except Health detail', () => {
    expect(toCalendarSettings(undefined)).toEqual({ hiddenApps: [], todos: true, healthDetail: false, done: true });
    expect(toCalendarSettings({ hiddenApps: ['pet', 'BAD', 3], todos: 'yes' }).hiddenApps).toEqual(['pet']);
  });

  test('hidden apps, bills, to-dos and done things can be left out', () => {
    expect(keys('admin@example.com', { hiddenApps: ['home'] }).some((k) => k.startsWith('home|'))).toBe(false);
    expect(keys('admin@example.com', { hiddenApps: ['bills'] })).not.toContain('bills|bill:power');
    expect(keys('admin@example.com', { todos: false }).some((k) => k.startsWith('todo|'))).toBe(false);
    const done = exportEvents(input('admin@example.com', { done: false })).filter((e) => e.status === 'done');
    expect(done).toHaveLength(0);
  });

  test('a stored bills: false (the old switch) reads as Bills and Spending hidden; true or missing changes nothing', () => {
    expect(toCalendarSettings({ bills: false, hiddenApps: ['pet'] }).hiddenApps).toEqual(['pet', 'bills']);
    expect(toCalendarSettings({ bills: false, hiddenApps: ['bills'] }).hiddenApps).toEqual(['bills']);
    expect(toCalendarSettings({ bills: true, hiddenApps: ['pet'] }).hiddenApps).toEqual(['pet']);
    expect(toCalendarSettings({ hiddenApps: ['pet'] }).hiddenApps).toEqual(['pet']);
    expect(toCalendarSettings({ bills: false })).not.toHaveProperty('bills');
    expect(calendarSettingsDoc(toCalendarSettings({ bills: false }), 'A@b.c')).not.toHaveProperty('bills');
    expect(keys('admin@example.com', toCalendarSettings({ bills: false }))).not.toContain('bills|bill:power');
    expect(keys('admin@example.com', toCalendarSettings({ bills: true }))).toContain('bills|bill:power');
  });

  test('hiding Bills (or Spending) hides the whole money set, Spending to-dos included', () => {
    const item = { kind: 'bill', private: true, status: 'upcoming' } as const;
    const base = { me: 'admin@example.com', role: 'admin' as const };
    expect(visibleTo({ ...item, app: 'spending' }, { ...base, settings: { ...DEFAULT_CALENDAR_SETTINGS, hiddenApps: ['bills'] } })).toBe(false);
    expect(visibleTo({ ...item, app: 'bills' }, { ...base, settings: { ...DEFAULT_CALENDAR_SETTINGS, hiddenApps: ['spending'] } })).toBe(false);
    expect(visibleTo({ ...item, app: 'bills' }, { ...base, settings: DEFAULT_CALENDAR_SETTINGS })).toBe(true);
  });

  test('a stored spending reads as bills, so unticking Bills clears the money set', () => {
    expect(toCalendarSettings({ hiddenApps: ['spending', 'bills', 'pet'] }).hiddenApps).toEqual(['bills', 'pet']);
  });

  test('re-saving after a legacy bills: false with Bills ticked again shows Bills', () => {
    const legacy = toCalendarSettings({ bills: false });
    const resaved = calendarSettingsDoc({ ...legacy, hiddenApps: legacy.hiddenApps.filter((a) => a !== 'bills') }, 'a@b.c');
    expect(resaved).not.toHaveProperty('bills');
    expect(toCalendarSettings(resaved).hiddenApps).toEqual([]);
  });

  test('Health without detail: "Medicine for Ana" and no medicine name anywhere', async () => {
    const [dose] = exportEvents(input('carer@example.com')).filter((e) => e.app === 'health');
    expect(dose.title).toBe('Medicine for Ana');
    expect(dose.description).not.toContain('Amoxicillin');
    const ics = exportIcs(exportEvents(input('carer@example.com')), { householdId: 'h-demo', timeZone: TZ, lang: 'en', now: NOW });
    expect(ics).not.toContain('Amoxicillin');
    await loadExportLang('es');
    const [es] = exportEvents(input('carer@example.com', {}, 'es')).filter((e) => e.app === 'health');
    expect(es.title).toBe('Medicina para Ana');
  });

  test('a Health visit without detail: "Appointment for Ana", and what it is only with detail on', () => {
    const visit = toAgendaItem('health_visit_ana', {
      app: 'health', ref: 'visit:ana:v1', kind: 'appointment', title: 'Appointment for Ana', start: at('2031-10-06T10:00:00+02:00'), end: at('2031-10-06T11:00:00+02:00'),
      allDay: false, who: 'Ana', url: 'https://example.com/health/?tab=visits', private: true, audience: ['carer@example.com'],
      calendarDetail: 'Dentist: Cleaning with Dr. Example', updatedAt: 1, by: 'admin@example.com',
    });
    const off = exportEvents({ ...input('carer@example.com'), agenda: [visit] }).find((e) => e.app === 'health')!;
    expect(off.title).toBe('Appointment for Ana');
    expect(off.description).not.toContain('Dentist');
    const on = exportEvents({ ...input('carer@example.com', { healthDetail: true }), agenda: [visit] }).find((e) => e.app === 'health')!;
    expect(on.description).toContain('Dentist: Cleaning with Dr. Example');
    expect(exportEvents({ ...input('admin@example.com'), agenda: [visit] }).filter((e) => e.app === 'health')).toHaveLength(0);
  });

  test('a calendar-only detail goes in only with Health detail on', () => {
    const withNames = agenda.map((i) => (i.app === 'health' ? { ...i, calendarDetail: 'Amoxicillin 250 mg, Vitamin D' } : i));
    const off = exportEvents({ ...input('carer@example.com'), agenda: withNames }).find((e) => e.app === 'health')!;
    expect(off.description).not.toContain('Vitamin D');
    const on = exportEvents({ ...input('carer@example.com', { healthDetail: true }), agenda: withNames }).find((e) => e.app === 'health')!;
    expect(on.description).toContain('Amoxicillin 250 mg, Vitamin D');
  });

  test('Health with detail on shows what Health published', () => {
    const [dose] = exportEvents(input('carer@example.com', { healthDetail: true })).filter((e) => e.app === 'health');
    expect(dose.description).toContain('Amoxicillin 250 mg');
  });
});

describe('the events', () => {
  const events = exportEvents(input('admin@example.com'));
  const byKey = (k: string) => events.find((e) => e.key === k)!;

  test('a regular event is one series: skipped day excluded, moved day overridden', () => {
    const bins = byKey('home|event:bins');
    expect(bins.series!.first).toBe('2031-09-04');
    expect(bins.series!.exdates).toEqual(['2031-10-16']);
    expect(bins.series!.overrides.map((o) => [o.original, o.start])).toEqual([['2031-10-23', at('2031-10-24T08:00:00+02:00')]]);
    expect(bins.end - bins.start).toBe(30 * 60_000);
  });

  test('an occurrence moved from a past day to a later one skips none of the days between', () => {
    // 2031-09-11 (a past Thursday) was moved to 2031-10-03; nothing else before 2031-10-02 is published.
    const moved = toAgendaItem('moved', { ...agenda.find((i) => i.id === 'home_event_bins_2031-10-02')!, start: at('2031-10-03T07:00:00+02:00'), series: { ...agenda[0].series!, original: '2031-09-11' } });
    const events = exportEvents({ ...input('admin@example.com'), agenda: [...agenda, moved], todos: [] });
    const bins = events.find((e) => e.key === 'home|event:bins')!;
    expect(bins.series!.exdates).toEqual(['2031-10-16']);
    expect(bins.series!.overrides.map((o) => o.original)).toContain('2031-09-11');
  });

  test('the reader’s language', async () => {
    await loadExportLang('nl');
    const nl = exportEvents(input('admin@example.com', {}, 'nl')).find((e) => e.key === 'home|event:bins')!;
    expect(nl.title).toBe('Afval ophalen');
  });

  test('a record with several items gets one event each, keyed by start', () => {
    expect(events.filter((e) => e.key.startsWith('home|prep:bins|'))).toHaveLength(2);
  });

  test('a thing to do by a time has an alarm at its time; a done one is ticked and has none', () => {
    const preps = events.filter((e) => e.ref === 'prep:bins');
    const open = preps.find((e) => e.status === 'upcoming')!;
    const done = preps.find((e) => e.status === 'done')!;
    expect(open.alarmMinutes).toBe(0);
    expect(done.alarmMinutes).toBeUndefined();
    expect(done.title).toBe('✓ Take the bins out');
  });

  test('all-day items are dates in the calendar’s zone; several days end the day after the last', () => {
    const renewal = byKey('car|renewal:insurance');
    expect([renewal.startDate, renewal.endDate]).toEqual(['2031-10-28', '2031-10-30']);
    const job = byKey('home|job:filter');
    expect([job.startDate, job.endDate]).toEqual(['2031-10-15', '2031-10-16']);
  });

  test('an all-day item written in another zone keeps its day', () => {
    const fromNewYork = toAgendaItem('ny', { app: 'home', ref: 'job:ny', kind: 'due', title: 'X', start: at('2031-10-15T00:00:00-04:00'), allDay: true, url: 'https://example.com/', private: false });
    const [e] = exportEvents({ ...input('admin@example.com'), agenda: [fromNewYork], todos: [] });
    expect(e.startDate).toBe('2031-10-15');
  });

  test('to-dos with a due day, once: not when the agenda has the same record, not summary lines', () => {
    const todoKeys = events.filter((e) => e.kind === 'todo').map((e) => e.key);
    expect(todoKeys).toEqual(['todo|tasks|item:paint']);
    expect(byKey('todo|tasks|item:paint').title).toBe('To do: Buy paint');
  });

  test('the hash changes when what a calendar shows changes, and only then', () => {
    const again = exportEvents(input('admin@example.com'));
    expect(again.map((e) => e.hash)).toEqual(events.map((e) => e.hash));
    const moved = agenda.map((i) => (i.id === 'home_job_filter' ? { ...i, start: at('2031-10-16T00:00:00+02:00'), updatedAt: i.updatedAt + 1 } : i));
    const changed = exportEvents({ ...input('admin@example.com'), agenda: moved });
    expect(changed.find((e) => e.key === 'home|job:filter')!.hash).not.toBe(byKey('home|job:filter').hash);
    expect(changed.find((e) => e.key === 'home|event:bins')!.hash).toBe(byKey('home|event:bins').hash);
  });
});

describe('the feed as iCalendar', () => {
  const events = exportEvents(input('admin@example.com'));
  const ics = exportIcs(events, { householdId: 'h-demo', timeZone: TZ, lang: 'en', now: NOW });

  test('parses in ical.js with the right events, times and recurrence', () => {
    const cal = new ICAL.Component(ICAL.parse(ics));
    expect(cal.getFirstPropertyValue('x-wr-calname')).toBe('Huishouden');
    expect(String(cal.getFirstPropertyValue('refresh-interval'))).toBe('PT1H');
    const vevents = cal.getAllSubcomponents('vevent');
    const uid = exportUid('h-demo', 'home|event:bins');
    const binsParts = vevents.filter((v) => v.getFirstPropertyValue('uid') === uid);
    expect(binsParts).toHaveLength(2);
    const master = new ICAL.Event(binsParts.find((v) => !v.hasProperty('recurrence-id'))!);
    for (const o of binsParts.filter((v) => v.hasProperty('recurrence-id'))) master.relateException(o);
    const it = master.iterator();
    const seen: number[] = [];
    for (let next = it.next(); next && seen.length < 12; next = it.next()) {
      const d = master.getOccurrenceDetails(next);
      const ms = d.startDate.toJSDate().getTime();
      if (ms >= at('2031-10-01T00:00:00Z') && ms < at('2031-11-01T00:00:00Z')) seen.push(ms);
      if (ms > at('2031-11-01T00:00:00Z')) break;
    }
    expect(seen).toEqual([at('2031-10-02T07:00:00+02:00'), at('2031-10-09T07:00:00+02:00'), at('2031-10-24T08:00:00+02:00'), at('2031-10-30T07:00:00+01:00')]);
  });

  test('parses in node-ical too, timed events landing on the same instants', () => {
    const parsed = nodeIcal.sync.parseICS(ics);
    const vevents = Object.values(parsed).filter((v) => v && (v as { type?: string }).type === 'VEVENT') as unknown as { uid: string; start: Date; summary: string }[];
    const checkup = vevents.find((v) => v.uid === exportUid('h-demo', 'baby|appointment:checkup'))!;
    expect(checkup.start.getTime()).toBe(at('2031-10-07T10:30:00+02:00'));
    expect(vevents.find((v) => v.uid === exportUid('h-demo', 'bills|bill:power'))!.summary).toBe('Power bill');
  });

  test('alarms for things to do; SEQUENCE and LAST-MODIFIED from the item', () => {
    const cal = new ICAL.Component(ICAL.parse(ics));
    const prep = cal.getAllSubcomponents('vevent').find((v) => String(v.getFirstPropertyValue('summary')) === 'Take the bins out')!;
    expect(prep.getFirstSubcomponent('valarm')!.getFirstPropertyValue('trigger')!.toString()).toBe('PT0S');
    expect(Number(prep.getFirstPropertyValue('sequence'))).toBeGreaterThan(0);
    expect(prep.hasProperty('last-modified')).toBe(true);
  });

  test('a helper’s feed has no bills and no Health', () => {
    const helper = exportIcs(exportEvents(input('helper@example.com')), { householdId: 'h-demo', timeZone: TZ, lang: 'en', now: NOW });
    expect(helper).not.toContain('Power bill');
    expect(helper).not.toContain('Medicine');
    expect(helper).toContain('Garbage pickup');
  });
});

describe('add to calendar', () => {
  test('Google template link: local times with the zone, the series as recur', () => {
    const url = new URL(googleTemplateUrl({ title: 'Garbage pickup', start: at('2031-10-02T07:00:00+02:00'), allDay: false, detail: 'Every Thursday', series: { rule: { freq: 'week', every: 1, start: '2031-09-04' }, time: '07:00', minutes: 30 } }, { timeZone: TZ }));
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('dates')).toBe('20310904T070000/20310904T073000');
    expect(url.searchParams.get('ctz')).toBe(TZ);
    expect(url.searchParams.get('recur')).toBe('RRULE:FREQ=WEEKLY;BYDAY=TH;WKST=SU');
  });

  test('Google template link for an all-day item', () => {
    const url = new URL(googleTemplateUrl({ title: 'Insurance', start: at('2031-10-28T00:00:00+01:00'), end: at('2031-10-30T00:00:00+01:00'), allDay: true }, { timeZone: TZ }));
    expect(url.searchParams.get('dates')).toBe('20311028/20311030');
    expect(url.searchParams.has('ctz')).toBe(false);
  });

  test('.ics download is one PUBLISH event a parser reads', () => {
    const ics = addToCalendarIcs({ title: 'Checkup', start: at('2031-10-07T10:30:00+02:00'), end: at('2031-10-07T11:00:00+02:00'), allDay: false, location: 'Clinic', url: 'https://example.com/baby/' }, { timeZone: TZ, now: NOW });
    const cal = new ICAL.Component(ICAL.parse(ics));
    expect(cal.getFirstPropertyValue('method')).toBe('PUBLISH');
    const e = new ICAL.Event(cal.getFirstSubcomponent('vevent')!);
    expect(e.startDate.toJSDate().getTime()).toBe(at('2031-10-07T10:30:00+02:00'));
    expect(e.location).toBe('Clinic');
  });
});

describe('the import ignores what the export wrote', () => {
  const base = { id: 'e1', htmlLink: 'https://calendar.google.com/e1', summary: 'Garbage pickup', start: { dateTime: '2031-10-02T07:00:00+02:00' } };

  test('an event the Google sync wrote is no match', () => {
    const exported = { ...base, extendedProperties: { private: { huishouden: 'h-demo:home|event:bins' } } };
    expect(isExportedEvent(exported)).toBe(true);
    expect(toMatch(exported, 'Huishouden')).toBeNull();
  });

  test('an event from the subscribed feed (UID @huishouden) is no match', () => {
    const fromFeed = { ...base, iCalUID: exportUid('h-demo', 'home|event:bins') };
    expect(toMatch(fromFeed, 'Huishouden')).toBeNull();
  });

  test('the person’s own events still match', () => {
    expect(toMatch({ ...base, iCalUID: 'abc@google.com' }, 'Family')?.title).toBe('Garbage pickup');
  });
});

describe('things at home', () => {
  test("Home's events carry the home address as their LOCATION; others don't", () => {
    const before = exportEvents(input('admin@example.com'));
    const events = exportEvents({ ...input('admin@example.com'), home: '12 Example Lane, Springfield' });
    const bins = events.find((e) => e.key === 'home|event:bins')!;
    expect(bins.location).toBe('12 Example Lane, Springfield');
    expect(events.find((e) => e.app === 'pet')!.location).toBeUndefined();
    const ics = exportIcs(events, { householdId: 'h-demo', timeZone: TZ, lang: 'en', now: NOW });
    expect(ics).toContain('LOCATION:12 Example Lane\\, Springfield');
    // Setting a home changes only the events at home, so only those are rewritten.
    expect(events.filter((e) => e.app !== 'home').map((e) => e.hash)).toEqual(before.filter((e) => e.app !== 'home').map((e) => e.hash));
    expect(bins.hash).not.toBe(before.find((e) => e.key === 'home|event:bins')!.hash);
  });
});
