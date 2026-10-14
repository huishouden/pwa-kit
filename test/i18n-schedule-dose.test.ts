import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { setLangForTests, messageArgs } from '../src/i18n';
import en from '../src/locales/en';
import es from '../src/locales/es';
import nl from '../src/locales/nl';
import { describePrep, describeRule, describeSchedule, describeMonths, prepWhen } from '../src/schedule';
import { CADENCE_LABELS } from '../src/recurring';
import { formatDose, parseDirections, routeWords, toMedCourse } from '../src/dose';
import { atTime } from '../src/time';

// Another test file leaves a bare `window` stub behind; the language change event needs a real one or none.
const g = globalThis as { window?: { dispatchEvent?: unknown } };
let stub: typeof g.window;
beforeAll(() => {
  if (g.window && typeof g.window.dispatchEvent !== 'function') [stub, g.window] = [g.window, undefined];
});
afterAll(() => {
  if (stub) g.window = stub;
});
afterEach(() => setLangForTests('en'));

describe('schedule and dose text in Spanish and Dutch', () => {
  test('the parser\'s routes are said in the language; a label\'s own wording stays as written', async () => {
    expect(routeWords('in the eye')).toBe('In the eye');
    expect(routeWords('in the left ear')).toBe('In the left ear');
    await setLangForTests('nl');
    expect(routeWords('in the eye')).toBe('In het oog');
    expect(toMedCourse(parseDirections('Give 1 tablet under the skin daily'), { startDate: '2031-01-06' }).notes).toBe('Onder de huid');
    await setLangForTests('es');
    expect(routeWords('by injection')).toBe('Inyectado');
  });

  test('every schedule, dose and recurring message has the same variables in every language', () => {
    for (const [key, message] of Object.entries(en)) {
      if (!/^(schedule|dose|recurring)\./.test(key)) continue;
      for (const other of [es, nl] as Record<string, string>[]) expect([key, messageArgs(other[key])]).toEqual([key, messageArgs(message)]);
    }
  });

  test('Spanish rules read as whole phrases', async () => {
    await setLangForTests('es', ['es-MX']);
    expect(describeRule({ freq: 'week', every: 1, start: '2031-10-16' })).toBe('Todos los jueves');
    expect(describeRule({ freq: 'week', every: 2, start: '2031-10-17' })).toBe('Cada dos semanas, los viernes');
    expect(describeRule({ freq: 'week', every: 3, start: '2031-10-18', days: [1, 6] })).toBe('Cada 3 semanas, los lunes y sábados');
    expect(describeRule({ freq: 'month', every: 1, start: '2031-10-21', nth: 3, weekday: 2 })).toBe('Cada mes, el tercer martes');
    expect(describeSchedule({ kind: 'fixed', every: 2, unit: 'week', anchor: '2031-10-17' })).toBe('Cada 2 semanas, los viernes');
    expect(describeSchedule({ kind: 'fixed', every: 1, unit: 'month', anchor: '2031-10-15' })).toBe('Cada mes, el día 15');
    expect(describeSchedule({ kind: 'fixed', every: 1, unit: 'year', anchor: '2031-11-02' })).toBe('Cada año, el 2 de noviembre');
    expect(describeMonths(6)).toBe('Cada 6 meses');
    expect(CADENCE_LABELS.monthly).toBe('Mensual');
    expect(formatDose(2.5, 'tablet')).toBe('2.5 tabletas');
    expect(formatDose(1, 'drop')).toBe('1 gota');
  });

  test('Dutch rules and prep times use the 24-hour clock', async () => {
    await setLangForTests('nl', ['nl-NL']);
    expect(describeRule({ freq: 'week', every: 1, start: '2031-10-16', days: [1, 4] })).toBe('Elke maandag en donderdag');
    expect(describeRule({ freq: 'month', every: 2, start: '2031-10-31', nth: -1, weekday: 5 })).toBe('Om de maand op de laatste vrijdag');
    expect(describeSchedule({ kind: 'fixed', every: 1, unit: 'month', anchor: '2031-10-01' })).toBe('Elke maand op de 1e');
    expect(describePrep({ daysBefore: 1, time: '19:00' })).toBe('De avond ervoor om 19:00');
    expect(describePrep({ daysBefore: 3, time: '09:30' })).toBe('3 dagen ervoor om 9:30');
    const now = atTime('2031-10-22', '08:00');
    expect(prepWhen(atTime('2031-10-22', '19:00'), now)).toBe('vanavond vóór 19:00');
    expect(formatDose(2, 'patch')).toBe('2 pleisters');
  });

  test('a parsed label becomes notes and assumptions in the active language', async () => {
    await setLangForTests('es', ['es-MX']);
    const parsed = parseDirections('Give 1 tablet daily\nfor 5 days');
    expect(parsed.dose).toBe('1 tableta');
    expect(parsed.assumptions).toContain('No se encontró el nombre del medicamento en la etiqueta');
    expect(toMedCourse(parseDirections('Give 1 tablet every other day until gone'), { startDate: '2031-10-01' }).notes).toBe('Un día sí y otro no. Hasta terminarlo');
  });
});
