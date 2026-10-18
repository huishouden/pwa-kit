import { afterEach, describe, expect, test } from 'bun:test';
import { setLangForTests } from '../src/i18n';
import { LocalClock } from '../src/local-clock';
import { deviceCalendar, NEED_TODAY, needByChoiceLabel, needByChoices, needByOf, needByPatch, needByState, needByUrgency, needByUrgent, needByWords, pinNeedBy, STANDARD, WHENEVER } from '../src/need-by';
import { toYmd } from '../src/time';

process.env.TZ = 'UTC';

// 2031-01-04 is a Saturday.
const SAT = '2031-01-04';
const at = (ymd: string, hour = 12) => Date.parse(`${ymd}T${String(hour).padStart(2, '0')}:00:00Z`);
const opts = { today: SAT, dayOf: toYmd };

afterEach(async () => {
  await setLangForTests('en');
});

describe('needByOf: the stored day, and the rule for older "Need Today" items', () => {
  test('a stored day is the day, whatever the urgency mirror says', () => {
    expect(needByOf({ needBy: '2031-01-07', urgency: STANDARD }, opts)).toEqual({ day: '2031-01-07', guessed: false });
    expect(needByOf({ needBy: '2031-01-07', urgency: WHENEVER }, opts)).toEqual({ day: '2031-01-07', guessed: false });
    expect(needByOf({ needBy: '2031-01-04', urgency: NEED_TODAY, updatedAt: at(SAT) }, opts)).toEqual({ day: SAT, guessed: false });
  });

  test('no day and not Need Today: none', () => {
    expect(needByOf({ urgency: STANDARD }, opts)).toBeNull();
    expect(needByOf({ urgency: WHENEVER, needBy: null }, opts)).toBeNull();
    expect(needByOf({}, opts)).toBeNull();
  });

  test('a malformed or impossible day is ignored', () => {
    expect(needByOf({ needBy: '2031-02-30', urgency: STANDARD }, opts)).toBeNull();
    expect(needByOf({ needBy: 'tuesday', urgency: STANDARD }, opts)).toBeNull();
    expect(needByOf({ needBy: 20310107, urgency: STANDARD }, opts)).toBeNull();
  });

  test('a legacy Need Today is needed on the day it was last changed, else added, else today', () => {
    expect(needByOf({ urgency: NEED_TODAY, updatedAt: at('2031-01-01'), createdAt: at('2030-12-30') }, opts)).toEqual({ day: '2031-01-01', guessed: true });
    expect(needByOf({ urgency: NEED_TODAY, createdAt: at('2030-12-30') }, opts)).toEqual({ day: '2030-12-30', guessed: true });
    expect(needByOf({ urgency: NEED_TODAY, updatedAt: 0, createdAt: 'x' }, opts)).toEqual({ day: SAT, guessed: true });
    expect(needByOf({ urgency: NEED_TODAY }, opts)).toEqual({ day: SAT, guessed: true });
  });

  test('an older app turning on Need Today for a dated item makes it needed that day', () => {
    // Dated Tuesday (written as Standard); an older app sets Need Today on Saturday.
    expect(needByOf({ needBy: '2031-01-07', urgency: NEED_TODAY, updatedAt: at(SAT) }, opts)).toEqual({ day: SAT, guessed: true });
  });

  test('a day set as today stays that day when the item is touched later (dragged, edited)', () => {
    expect(needByOf({ needBy: '2031-01-02', urgency: NEED_TODAY, updatedAt: at(SAT) }, opts)).toEqual({ day: '2031-01-02', guessed: false });
  });

  test("the day of a moment is read on the reader's calendar: late evening in New York is still that day", () => {
    const clock = new LocalClock('America/New_York', () => at('2031-01-05', 4)); // 23:00 Saturday in New York
    const cal = { today: clock.today(), dayOf: (t: number) => toYmd(clock.local(t)) };
    expect(cal.today).toBe(SAT);
    // Set at 22:30 Saturday New York time, 03:30 Sunday UTC.
    const set = Date.parse('2031-01-05T03:30:00Z');
    expect(needByOf({ urgency: NEED_TODAY, updatedAt: set }, cal)).toEqual({ day: SAT, guessed: true });
    expect(needByOf({ urgency: NEED_TODAY, updatedAt: set }, { today: '2031-01-05', dayOf: toYmd })).toEqual({ day: '2031-01-05', guessed: true });
  });

  test('across a clock change: set the evening before Europe falls back, read the morning after', () => {
    // 2031-10-26 03:00 CEST becomes 02:00 CET in Amsterdam.
    const clock = new LocalClock('Europe/Amsterdam', () => Date.parse('2031-10-26T08:00:00Z'));
    const cal = { today: clock.today(), dayOf: (t: number) => toYmd(clock.local(t)) };
    const set = Date.parse('2031-10-25T21:45:00Z'); // 23:45 CEST Saturday
    expect(cal.today).toBe('2031-10-26');
    expect(needByOf({ urgency: NEED_TODAY, updatedAt: set }, cal)).toEqual({ day: '2031-10-25', guessed: true });
    expect(needByState('2031-10-25', cal.today)).toBe('overdue');
    expect(needByWords('2031-10-25', cal.today)).toBe('Overdue, needed yesterday');
  });
});

describe('needByUrgency: what older apps read', () => {
  test('today or past is Need Today, later is Standard, none keeps the chosen undated urgency', () => {
    expect(needByUrgency(SAT, SAT)).toBe(NEED_TODAY);
    expect(needByUrgency('2031-01-01', SAT)).toBe(NEED_TODAY);
    expect(needByUrgency('2031-01-05', SAT)).toBe(STANDARD);
    expect(needByUrgency(null, SAT)).toBe(STANDARD);
    expect(needByUrgency(null, SAT, WHENEVER)).toBe(WHENEVER);
    // Need Today always comes with a day; none asked for is Standard.
    expect(needByUrgency(null, SAT, NEED_TODAY)).toBe(STANDARD);
  });
});

describe('pinNeedBy', () => {
  test('a guessed day is pinned; a stored day or none adds nothing', () => {
    expect(pinNeedBy({ urgency: NEED_TODAY, updatedAt: at('2031-01-01') }, opts)).toEqual({ needBy: '2031-01-01' });
    expect(pinNeedBy({ urgency: NEED_TODAY, needBy: '2031-01-02', updatedAt: at(SAT) }, opts)).toEqual({});
    expect(pinNeedBy({ urgency: STANDARD }, opts)).toEqual({});
  });
});

describe('state and words', () => {
  test('state: overdue, today, soon (two days), later', () => {
    expect(needByState('2031-01-03', SAT)).toBe('overdue');
    expect(needByState(SAT, SAT)).toBe('today');
    expect(needByState('2031-01-06', SAT)).toBe('soon');
    expect(needByState('2031-01-07', SAT)).toBe('later');
    expect(needByUrgent(SAT, SAT)).toBe(true);
    expect(needByUrgent('2031-01-05', SAT)).toBe(false);
  });

  test('English', () => {
    expect(needByWords(SAT, SAT)).toBe('Need today');
    expect(needByWords('2031-01-05', SAT)).toBe('Need tomorrow');
    expect(needByWords('2031-01-07', SAT)).toBe('Need by Tue');
    expect(needByWords('2031-01-10', SAT)).toBe('Need by Fri');
    expect(needByWords('2031-01-11', SAT)).toBe('Need by Jan 11');
    expect(needByWords('2032-01-11', SAT)).toBe('Need by Jan 11, 2032');
    expect(needByWords('2031-01-03', SAT)).toBe('Overdue, needed yesterday');
    expect(needByWords('2030-12-29', SAT)).toBe('Overdue, needed Sun');
    expect(needByWords('2030-12-20', SAT)).toBe('Overdue, needed Dec 20, 2030');
  });

  test('Spanish writes the weekday out; Dutch abbreviates it', async () => {
    await setLangForTests('es');
    expect(needByWords(SAT, SAT)).toBe('Para hoy');
    expect(needByWords('2031-01-07', SAT)).toBe('Para el martes');
    expect(needByWords('2031-01-03', SAT)).toBe('Atrasado, era para ayer');
    await setLangForTests('nl');
    expect(needByWords('2031-01-05', SAT)).toBe('Morgen nodig');
    expect(needByWords('2031-01-07', SAT)).toBe('Uiterlijk di nodig');
    expect(needByWords('2030-12-29', SAT)).toBe('Te laat, was zo nodig');
  });

  test('quick choices: today, tomorrow, then weekdays by name, across a month end', () => {
    const days = needByChoices('2031-01-30');
    expect(days).toEqual(['2031-01-30', '2031-01-31', '2031-02-01', '2031-02-02', '2031-02-03', '2031-02-04']);
    expect(days.map((d) => needByChoiceLabel(d, '2031-01-30'))).toEqual(['Today', 'Tomorrow', 'Sat', 'Sun', 'Mon', 'Tue']);
  });

  test('quick choices across the spring clock change stay one per day', () => {
    // 2031-03-09: US clocks go forward.
    expect(needByChoices('2031-03-08', 3)).toEqual(['2031-03-08', '2031-03-09', '2031-03-10']);
  });
});

describe('needByPatch: the fields every writer writes', () => {
  const cal = { today: SAT, dayOf: toYmd };
  const dated = { needBy: '2031-01-09', urgency: STANDARD, updatedAt: at(SAT) };
  test('a day: that day, with Need Today when it is today or past, else Standard', () => {
    expect(needByPatch(dated, { needBy: '2031-01-07' }, cal)).toEqual({ needBy: '2031-01-07', urgency: STANDARD });
    expect(needByPatch(dated, { needBy: SAT }, cal)).toEqual({ needBy: SAT, urgency: NEED_TODAY });
  });
  test('no day: the asked Standard or Whenever, else the item\'s Whenever, else Standard; Need Today cannot come with none', () => {
    expect(needByPatch(dated, { needBy: null, urgency: WHENEVER }, cal)).toEqual({ needBy: null, urgency: WHENEVER });
    expect(needByPatch({ urgency: WHENEVER, needBy: '2031-01-09' }, { needBy: null }, cal)).toEqual({ needBy: null, urgency: WHENEVER });
    expect(needByPatch(dated, { needBy: null, urgency: NEED_TODAY }, cal)).toEqual({ needBy: null, urgency: STANDARD });
  });
  test('only an urgency: Need Today is today; Standard and Whenever clear the day', () => {
    expect(needByPatch(dated, { urgency: NEED_TODAY }, cal)).toEqual({ needBy: SAT, urgency: NEED_TODAY });
    expect(needByPatch(dated, { urgency: WHENEVER }, cal)).toEqual({ needBy: null, urgency: WHENEVER });
  });
  test('nothing asked: a guessed day is pinned, a stored one left alone, a new item is Standard', () => {
    expect(needByPatch({ urgency: NEED_TODAY, updatedAt: at('2031-01-02') }, {}, cal)).toEqual({ needBy: '2031-01-02' });
    expect(needByPatch(dated, {}, cal)).toEqual({});
    expect(needByPatch({}, {}, cal)).toEqual({ urgency: STANDARD });
  });
  test('deviceCalendar: today and the day of a moment on this device', () => {
    expect(deviceCalendar(at(SAT, 23))).toMatchObject({ today: SAT });
    expect(deviceCalendar().dayOf(at(SAT))).toBe(SAT);
  });
});
