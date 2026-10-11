import { afterEach, describe, expect, test } from 'bun:test';
import { kt, registerMessages, resetI18nForTests, setLangForTests, t, type MessageKey } from '../src/i18n';
import { agendaDoc, agendaWords, localizeAgenda, toAgendaItem } from '../src/agenda';
import { localizeTodos, toTodoItem, todoDoc, todoWords } from '../src/todos';

afterEach(() => resetI18nForTests());

const en = { 'b.pay': 'Pay {name}', 'b.markPaid': 'Mark paid', 'b.auto': 'autopay on' };
const es = { 'b.pay': 'Pagar {name}', 'b.markPaid': 'Marcar pagada', 'b.auto': 'pago automático activado' };
const nl = { 'b.pay': '{name} betalen', 'b.markPaid': 'Betaald', 'b.auto': 'automatische incasso aan' };
const k = (s: string) => s as MessageKey;
const URL = 'https://example-family.web.app/bills/';

describe('to-dos and agenda items in every language', () => {
  test('localizeTodos stores every language; todoWords picks the reader’s', async () => {
    registerMessages(en, { es: async () => es, nl: async () => nl });
    const build = () => [
      {
        ref: 'bill:b1',
        title: t(k('b.pay'), { name: 'Electric' }),
        createdAt: 1,
        url: URL,
        done: { label: t(k('b.markPaid')), roles: ['admin' as const], ops: [{ col: 'bills', id: 'b1', data: { paid: true } }] },
        cancel: { label: kt('common.cancel'), roles: ['admin' as const], ops: [{ col: 'bills', id: 'b1', data: null }] },
      },
    ];
    const [input] = await localizeTodos(build);
    expect(input.title).toBe('Pay Electric');
    expect(input.texts?.nl).toEqual({ title: 'Electric betalen', done: 'Betaald', cancel: 'Annuleren' });
    const stored = todoDoc('bills', input, 'sam@example.com', 5);
    const item = toTodoItem('bills:bill:b1', stored as unknown as Record<string, unknown>);
    expect(todoWords(item).title).toBe('Pay Electric');
    await setLangForTests('es');
    expect(todoWords(item)).toEqual({ title: 'Pagar Electric', detail: undefined, done: 'Marcar pagada', cancel: 'Cancelar' });
    expect(todoWords({ ...item, texts: undefined }).title).toBe('Pay Electric');
  });

  test('texts are cleaned to known languages and fields, clipped like the fields', () => {
    const stored = todoDoc('bills', { ref: 'r', title: 'x', createdAt: 1, url: URL, texts: { es: { title: ` ${'y'.repeat(200)} `, bogus: 'z' }, fr: { title: 'non' }, nl: { title: '  ' } } as never }, 'a@example.com');
    expect(stored.texts).toEqual({ es: { title: 'y'.repeat(120) } });
  });

  test('localizeAgenda and agendaWords', async () => {
    registerMessages(en, { es: async () => es, nl: async () => nl });
    const [input] = await localizeAgenda(() => [{ ref: 'bill:b1', kind: 'bill' as const, title: t(k('b.pay'), { name: 'Water' }), detail: t(k('b.auto')), start: 10, allDay: true, url: URL }]);
    const item = toAgendaItem('x', agendaDoc('bills', input, 'a@example.com', 1) as unknown as Record<string, unknown>);
    await setLangForTests('nl');
    expect(agendaWords(item)).toEqual({ title: 'Water betalen', detail: 'automatische incasso aan' });
  });
});
