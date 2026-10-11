import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { planTodo, todoActionOps, TodoActionError, type TodoItem } from '../src/todo-core';
import { agendaInRange, toAgendaItem } from '../src/agenda-core';

// Modules a server (a Cloudflare Worker such as huishouden/connector) imports: none may load
// Firebase, the DOM or anything else only a browser app has.
const SERVER_SAFE = ['todo-core', 'agenda-core', 'contact-core', 'role-core', 'reminder-source', 'dose', 'schedule', 'time', 'i18n', 'audience', 'store', 'site', 'money', 'firestore-rest', 'firebase-auth-rest', 'local-clock', 'signin-handoff', 'ics', 'calendar-export', 'visit', 'condition', 'reminder-core', 'people', 'pet-outings', 'pet-routines', 'reader-langs'];

function importGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    // Static imports and re-exports only; `import type` is erased.
    for (const m of source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
      const spec = m[1];
      if (spec.startsWith('.')) walk(join(dirname(file), spec.replace(/\.js$/, '') + '.ts'));
      else bare.add(spec);
    }
  };
  walk(join(import.meta.dir, '../src', `${entry}.ts`));
  return { files: seen, bare };
}

describe('server-safe modules', () => {
  test('the check sees Firebase where it is imported', () => {
    expect(importGraph('todos').bare.has('firebase/firestore')).toBe(true);
  });
  for (const name of SERVER_SAFE) {
    test(`${name} imports no package`, () => {
      expect([...importGraph(name).bare]).toEqual([]);
    });
  }
});

const NOW = Date.UTC(2031, 0, 6, 15);
const item = (over: Partial<TodoItem> = {}): TodoItem => ({
  id: 'home:job:j1',
  app: 'home',
  ref: 'job:j1',
  title: 'Change the filter',
  createdAt: NOW - 1000,
  url: 'https://example.web.app/home/',
  status: 'open',
  done: { label: 'Done', roles: ['admin', 'member'], ops: [{ col: 'homeTasks', id: 'j1', data: { lastDone: '$today', updatedAt: '$now' }, merge: true }] },
  updatedAt: NOW,
  by: 'sam@example.com',
  ...over,
});

describe('planTodo', () => {
  test('writes the resolved ops and removes the item; undo restores both', () => {
    const it = item();
    const ops = todoActionOps(it, 'done', { me: 'Alex@Example.com', now: NOW });
    expect(ops[0].data).toEqual({ lastDone: '2031-01-06', updatedAt: NOW });
    const before = { id: 'j1', title: 'Change the filter', lastDone: '2030-10-01' };
    const plan = planTodo(it, ops, (col, id) => (col === 'homeTasks' && id === 'j1' ? before : undefined), { me: 'Alex@Example.com', now: NOW });
    expect(plan.writes).toEqual([...ops, { col: 'todos', id: 'home:job:j1', data: null }]);
    const undo = plan.undo(NOW + 5);
    expect(undo[0]).toEqual({ col: 'homeTasks', id: 'j1', data: { title: 'Change the filter', lastDone: '2030-10-01' } });
    expect(undo[1]).toMatchObject({ col: 'todos', id: 'home:job:j1', data: { by: 'alex@example.com', updatedAt: NOW + 5, private: false } });
  });

  test('refuses a merge onto a record deleted in its app, and actions outside the app', () => {
    const it = item();
    const ops = todoActionOps(it, 'done', { me: 'alex@example.com', now: NOW });
    expect(() => planTodo(it, ops, () => undefined, { me: 'alex@example.com', now: NOW })).toThrow(TodoActionError);
    expect(() => todoActionOps(item({ done: { label: 'Done', roles: ['admin'], ops: [{ col: 'bills', id: 'b', data: null }] } }), 'done', { me: 'a@b.c', now: NOW })).toThrow(TodoActionError);
    expect(() => todoActionOps(item(), 'cancel', { me: 'a@b.c', now: NOW })).toThrow(TodoActionError);
  });

  test("a server in another time zone passes the person's day for '$today'", () => {
    const ops = todoActionOps(item(), 'done', { me: 'alex@example.com', now: NOW, today: '2031-01-05' });
    expect(ops[0].data).toEqual({ lastDone: '2031-01-05', updatedAt: NOW });
  });

  test('a personal item is removed from personalTodos', () => {
    const it = item({ audience: ['alex@example.com'] });
    const ops = todoActionOps(it, 'done', { me: 'alex@example.com', now: NOW });
    const plan = planTodo(it, ops, () => ({ id: 'j1' }), { me: 'alex@example.com', now: NOW });
    expect(plan.writes.at(-1)).toEqual({ col: 'personalTodos', id: 'home:job:j1', data: null });
  });
});

describe('agendaInRange', () => {
  test('keeps what overlaps the range and anything overdue, soonest first', () => {
    const at = (id: string, start: number, extra: Record<string, unknown> = {}) =>
      toAgendaItem(id, { app: 'pet', ref: id, kind: 'appointment', title: id, start, allDay: false, url: 'https://example.web.app/pet/', updatedAt: 1, by: 'a@b.c', ...extra });
    const items = [at('later', NOW + 10), at('before', NOW - 100), at('overdue', NOW - 100, { status: 'overdue' }), at('outside', NOW + 1000)];
    expect(agendaInRange(items, { from: NOW, to: NOW + 500 }).map((i) => i.id)).toEqual(['overdue', 'later']);
    expect(agendaInRange(items, { from: NOW, to: NOW + 500, apps: ['car'] })).toEqual([]);
  });
});
