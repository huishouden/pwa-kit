import { describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { agendaDoc, agendaMergeGroups, isMergedItem, mergeAgenda, toAgendaItem, type AgendaItem } from '../src/agenda-core';
import { DEFAULT_CALENDAR_SETTINGS, exportClusters, exportEvents, exportIcs, loadExportLang, splitRules, type ExportInput } from '../src/calendar-export';
import { zonedTime } from '../src/ics';
import { cleanMerge, mergedTitle } from '../src/merge';
import { mergedReminderText, reminderDoc, reminderMergeKey, toReminder, type MergeableReminder } from '../src/reminder-core';
import { ruleOccurrences, type EventRule } from '../src/schedule';
import type { Role } from '../src/role-core';
import fixture from './fixtures/merge/agenda.json';

const TZ = fixture.timeZone;
const FROM = '2031-10-01';

type SeriesRecord = (typeof fixture.series)[number];

/** A series' occurrences from FROM to its `through`, all day, as Home publishes them; some skipped or moved. */
function occurrences(record: SeriesRecord, { skip = [], moved = {} }: { skip?: string[]; moved?: Record<string, string> } = {}): AgendaItem[] {
  const { rule, through, ...rest } = record as SeriesRecord & { edit?: unknown };
  return ruleOccurrences(rule as EventRule, FROM, through)
    .filter((d) => !skip.includes(d))
    .map((original) => {
      const day = moved[original] ?? original;
      const start = zonedTime(day, undefined, TZ);
      return toAgendaItem(`${record.app}_${record.ref}_${start}`, { ...rest, start, allDay: true, series: { rule, original, through } });
    });
}

const items = (ids?: string[]): AgendaItem[] =>
  fixture.items.filter((i) => !ids || ids.includes(i.id)).map(({ id, start, end, ...rest }) => toAgendaItem(id, { ...rest, start: Date.parse(start), ...(end ? { end: Date.parse(end) } : {}) }));

const [garbage, recycling, yard] = fixture.series;

function input(agenda: AgendaItem[], me = 'admin@example.com', lang: ExportInput['lang'] = 'en'): ExportInput {
  return { agenda, todos: [], me, role: (fixture.members as Record<string, Role>)[me], lang, timeZone: TZ, settings: DEFAULT_CALENDAR_SETTINGS };
}

describe('the merge spec', () => {
  test('needs a key, a part and {parts} in the title', () => {
    expect(cleanMerge({ key: ' collection ', part: 'garbage', title: '{parts} pickup' })).toEqual({ key: 'collection', part: 'garbage', title: '{parts} pickup' });
    expect(cleanMerge({ key: 'collection', part: 'garbage', title: 'Pickup' })).toBeUndefined();
    expect(cleanMerge({ key: '', part: 'garbage', title: '{parts}' })).toBeUndefined();
    expect(cleanMerge({ key: 'k', part: 'p', title: '{parts}', other: 'x' })).toEqual({ key: 'k', part: 'p', title: '{parts}' });
  });

  test('agendaDoc keeps a merge and refuses a broken one', () => {
    const base = { ref: 'x', kind: 'other' as const, title: 'Garbage pickup', start: 1, allDay: true, url: 'https://example.com/home/' };
    expect(agendaDoc('home', { ...base, merge: { key: 'collection', part: 'garbage', title: '{parts} pickup' } }, 'a@example.com').merge).toEqual({ key: 'collection', part: 'garbage', title: '{parts} pickup' });
    expect(() => agendaDoc('home', { ...base, merge: { key: 'collection', part: 'garbage', title: 'no parts' } }, 'a@example.com')).toThrow();
  });

  test('titles list the parts the language\'s way, first letter upper case', () => {
    expect(mergedTitle('{parts} pickup', ['garbage', 'recycling'], 'en')).toBe('Garbage and recycling pickup');
    expect(mergedTitle('{parts} pickup', ['garbage', 'recycling', 'yard waste'], 'en')).toBe('Garbage, recycling, and yard waste pickup');
    expect(mergedTitle('{parts} ophalen', ['afval', 'recycling'], 'nl')).toBe('Afval en recycling ophalen');
    expect(mergedTitle('Feed {parts} · AM', ['Milo', 'Theo'], 'es')).toBe('Feed Milo y Theo · AM');
  });
});

describe('mergeAgenda: the portal\'s Today and Calendar', () => {
  test('garbage and recycling on the same day show as one, in every language', () => {
    const day = [...occurrences(garbage), ...occurrences(recycling)].filter((i) => i.series!.original === '2031-10-07');
    const shown = mergeAgenda(day, 'en');
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Garbage and recycling pickup');
    expect(shown[0].texts?.nl?.title).toBe('Afval en recycling ophalen');
    expect(shown[0].detail).toBe('Garbage pickup: Every Tuesday and Friday · Recycling pickup: Every Tuesday');
    expect(isMergedItem(shown[0]) && shown[0].members.map((m) => m.ref)).toEqual(['event:garbage', 'event:recycling']);
    expect(shown[0].url).toBe('https://example.com/home/#regular');
  });

  test('two pets at the same meal merge; a private one, another app\'s and a fed one stay apart', () => {
    const [a, b, priv, baby] = items(['pet_meal_a', 'pet_meal_b', 'pet_meal_private', 'baby_other_app']);
    const shown = mergeAgenda([a, b, priv, baby], 'en');
    expect(shown.map((i) => i.title)).toEqual(['Feed Milo and Theo · AM', 'Feed Pip · AM', 'Feed the baby · AM']);
    expect(shown[0].who).toBe('Milo and Theo');
    expect(shown[0].private).toBe(false);
    const fed = { ...b, status: 'done' as const };
    expect(mergeAgenda([a, fed], 'en').map((i) => i.title)).toEqual(['Feed Theo · AM', 'Feed Milo · AM']);
  });

  test('items for different people never merge', () => {
    const [a, b] = items(['pet_meal_a', 'pet_meal_b']);
    expect(agendaMergeGroups([{ ...a, audience: ['x@example.com'] }, { ...b, audience: ['y@example.com'] }]).size).toBe(0);
    expect(agendaMergeGroups([{ ...a, audience: ['x@example.com'] }, { ...b, audience: ['x@example.com'] }]).size).toBe(1);
  });

  test('an item without a merge, or alone, is left as it is', () => {
    const [a] = items(['pet_meal_a']);
    const { merge: _m, ...plain } = a;
    expect(mergeAgenda([a])).toEqual([a]);
    expect(mergeAgenda([plain, { ...plain, id: 'other', ref: 'meal:z' }])).toHaveLength(2);
  });
});

describe('splitRules', () => {
  test('weekly schedules counted alike split into the shared days and each one\'s own', () => {
    const r = splitRules([garbage.rule as EventRule, recycling.rule as EventRule])!;
    expect(r.shared).toEqual({ freq: 'week', every: 1, start: '2031-09-02' });
    expect(r.rest).toEqual([{ freq: 'week', every: 1, start: '2031-09-02', days: [5] }, null]);
  });

  test('the same rule is shared whole; schedules that can\'t be said as rules aren\'t split', () => {
    expect(splitRules([recycling.rule as EventRule, yard.rule as EventRule])).toEqual({ shared: { freq: 'week', every: 1, start: '2031-09-02' }, rest: [null, null] });
    expect(splitRules([{ freq: 'week', every: 2, start: '2031-09-01' }, { freq: 'week', every: 1, start: '2031-09-02' }])).toBeNull();
    expect(splitRules([{ freq: 'week', every: 2, start: '2031-09-01' }, { freq: 'week', every: 2, start: '2031-09-08' }])).toBeNull();
    expect(splitRules([{ freq: 'week', every: 1, start: '2031-09-01', until: '2032-01-01' }, { freq: 'week', every: 1, start: '2031-09-01', days: [1, 4] }])).toBeNull();
    expect(splitRules([{ freq: 'month', every: 1, start: '2031-09-01' }, { freq: 'week', every: 1, start: '2031-09-02' }])).toBeNull();
  });
});

describe('exportEvents: a person\'s calendar', () => {
  test('Shared days are one repeating event; garbage repeats on its other day; recycling has none of its own', async () => {
    await loadExportLang('en');
    const events = exportEvents(input([...occurrences(garbage), ...occurrences(recycling)]));
    const merged = events.find((e) => e.merged)!;
    expect(merged.title).toBe('Garbage and recycling pickup');
    expect(merged.series?.rule).toEqual({ freq: 'week', every: 1, start: '2031-09-02' });
    expect(merged.series?.exdates).toEqual([]);
    expect(merged.description).toBe('Garbage pickup: Every Tuesday and Friday\nRecycling pickup: Every Tuesday\n\nhttps://example.com/home/#regular');
    const own = events.filter((e) => !e.merged);
    expect(own.map((e) => e.key)).toEqual(['home|event:garbage']);
    expect(own[0].series?.rule).toEqual({ freq: 'week', every: 1, start: '2031-09-02', days: [5] });
    expect(own[0].series?.exdates).toEqual([]);
    const ics = exportIcs(events, { householdId: 'h', timeZone: TZ, lang: 'en', now: Date.parse('2031-10-01T12:00:00Z') });
    const vevents = new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vevent');
    expect(vevents.map((v) => String(v.getFirstPropertyValue('rrule')))).toEqual(['FREQ=WEEKLY;BYDAY=TU;WKST=SU', 'FREQ=WEEKLY;BYDAY=FR;WKST=SU']);
  });

  test('the merged event\'s key stays as members come and go, so a synced calendar updates it in place', () => {
    const two = exportEvents(input([...occurrences(garbage), ...occurrences(recycling)])).find((e) => e.merged)!;
    const three = exportEvents(input([...occurrences(garbage), ...occurrences(recycling), ...occurrences(yard)])).find((e) => e.merged)!;
    expect(three.key).toBe(two.key);
    expect(three.title).toBe('Garbage, recycling, and yard waste pickup');
    // Recycling and yard waste alone: their own rule shared whole, the same key's shape.
    const pair = exportEvents(input([...occurrences(recycling), ...occurrences(yard)]));
    expect(pair).toHaveLength(1);
    expect(pair[0].key).toBe(two.key);
  });

  test('a day recycling is skipped shows garbage alone that day; one skipped by both is skipped', () => {
    const events = exportEvents(input([...occurrences(garbage, { skip: ['2031-10-21'] }), ...occurrences(recycling, { skip: ['2031-10-14', '2031-10-21'] })]));
    const merged = events.find((e) => e.merged)!;
    expect(merged.series?.exdates).toEqual(['2031-10-21']);
    expect(merged.series?.overrides.map((o) => [o.original, o.title])).toEqual([['2031-10-14', 'Garbage pickup']]);
    expect(events.filter((e) => !e.merged).map((e) => e.key)).toEqual(['home|event:garbage']);
  });

  test('moved together (a holiday) is the merged series\' occurrence on the new day', () => {
    const events = exportEvents(input([...occurrences(garbage, { moved: { '2031-10-14': '2031-10-15' } }), ...occurrences(recycling, { moved: { '2031-10-14': '2031-10-15' } })]));
    const merged = events.find((e) => e.merged && e.series)!;
    expect(merged.series?.overrides.map((o) => [o.original, o.startDate, o.title])).toEqual([['2031-10-14', '2031-10-15', 'Garbage and recycling pickup']]);
    expect(merged.series?.exdates).toEqual([]);
  });

  test('one-off items merge into one event keyed by the merge and the time; apart again when one goes', () => {
    const prep = items(['home_prep_garbage_2031-10-06', 'home_prep_recycling_2031-10-06']);
    const [both] = exportEvents(input(prep));
    expect(both.title).toBe('Take the garbage and recycling out');
    expect(both.merged).toBe(true);
    expect(both.alarmMinutes).toBe(0);
    expect(both.items.map((i) => i.ref)).toEqual(['prep:garbage', 'prep:recycling']);
    expect(both.key).toMatch(new RegExp(`^merge\\|home\\|prep\\|task\\|[0-9a-f]+\\|open\\|${Date.parse('2031-10-06T19:00:00-04:00')}\\|${Date.parse('2031-10-06T23:59:00-04:00')}$`));
    expect(exportEvents(input(prep.slice(0, 1))).map((e) => e.key)).toEqual(['home|prep:garbage']);
  });

  test('groups of different kinds get their own keys; no key holds an email', () => {
    const [a, b] = items(['pet_meal_a', 'pet_meal_b']);
    const audience = ['x@example.com', 'admin@example.com'];
    const tasks = [a, b].map((i) => ({ ...i, id: `${i.id}-task`, ref: `${i.ref}-task`, kind: 'task' as const }));
    const events = exportEvents(input([a, b, ...tasks].map((i) => ({ ...i, audience, private: true }))));
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.key)).size).toBe(2);
    expect(events.every((e) => !e.key.includes('@'))).toBe(true);
  });

  test('a helper sees only what they may: the private pet stays out and nothing is folded in', () => {
    const shown = exportEvents(input(items(['pet_meal_a', 'pet_meal_b', 'pet_meal_private']), 'helper@example.com'));
    expect(shown.map((e) => e.title)).toEqual(['Feed Milo and Theo · AM']);
  });

  test('in Dutch', async () => {
    await loadExportLang('nl');
    const [e] = exportEvents(input(items(['pet_meal_a', 'pet_meal_b']), 'admin@example.com', 'nl'));
    expect(e.title).toBe('Milo en Theo voeren · AM');
  });

  test('exportClusters keeps records that merge together, for exporting in parts', () => {
    const all = [...occurrences(garbage), ...occurrences(recycling), ...items(['pet_meal_a', 'pet_meal_b', 'pet_meal_private'])];
    const clusters = exportClusters(all, input(all));
    const refs = clusters.map((c) => [...new Set(c.map((i) => i.ref))].sort().join(' ')).sort();
    expect(refs).toEqual(['event:garbage event:recycling', 'meal:a:2031-10-07 meal:b:2031-10-07', 'meal:c:2031-10-07']);
    const parts = clusters.flat();
    expect(exportEvents(input(parts)).map((e) => e.key)).toEqual(exportEvents(input(all)).map((e) => e.key));
  });
});

describe('reminders', () => {
  const reminders = fixture.reminders as MergeableReminder[];

  test('reminders at the same minute for the same people share a key; others don\'t', () => {
    const [a, b] = reminders;
    expect(reminderMergeKey(a)).toBe(reminderMergeKey(b));
    expect(reminderMergeKey({ ...b, at: b.at + 60_000 })).not.toBe(reminderMergeKey(a));
    expect(reminderMergeKey({ ...b, private: true })).not.toBe(reminderMergeKey(a));
    expect(reminderMergeKey({ ...b, recipients: ['x@example.com'] })).not.toBe(reminderMergeKey(a));
    expect(reminderMergeKey({ ...b, app: 'pet' })).not.toBe(reminderMergeKey(a));
    expect(reminderMergeKey({ ...b, merge: undefined })).toBeNull();
  });

  test('one notification: the combined title and each body once', () => {
    expect(mergedReminderText(reminders, 'en')).toEqual({ title: 'Take the garbage and recycling out', body: 'Garbage pickup tomorrow\nRecycling pickup tomorrow' });
    expect(mergedReminderText(reminders, 'nl')).toEqual({ title: 'Zet het afval en recycling buiten', body: 'Morgen afval ophalen\nMorgen recycling ophalen' });
  });

  test('stored with its merge and the merge\'s words in each language', () => {
    const doc = reminderDoc({ ...fixture.reminders[0], recipients: 'all', url: 'https://example.com/home/' }, 'a@example.com', 1);
    expect(doc.merge).toEqual({ key: 'prep', part: 'garbage', title: 'Take the {parts} out' });
    expect(doc.texts?.nl).toEqual({ title: 'Afval buiten zetten', body: 'Morgen afval ophalen', mergePart: 'afval', mergeTitle: 'Zet het {parts} buiten' });
    expect(toReminder('r', doc as unknown as Record<string, unknown>).merge).toEqual(doc.merge);
  });
});
