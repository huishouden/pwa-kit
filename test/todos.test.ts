import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as real from 'firebase/firestore';
import { daysBetween } from '../src/time';

// An in-memory stand-in for the few Firestore calls todos.ts makes (the rules themselves are
// tested in huishouden/rules). Counts writes so "unchanged items are not rewritten" is checkable.
const store = new Map<string, Record<string, unknown>>();
let writes = 0;
type Ref = { path: string; id: string };
type Where = { field: string; op: string; value: unknown };
const ref = (path: string): Ref => ({ path, id: path.split('/').pop()! });
const docsOf = (q: { path: string; w?: Where[] }) =>
  [...store.entries()]
    .filter(([p, d]) => p.startsWith(`${q.path}/`) && !p.slice(q.path.length + 1).includes('/') && (q.w ?? []).every((w) => (w.op === 'array-contains' ? Array.isArray(d[w.field]) && (d[w.field] as unknown[]).includes(w.value) : d[w.field] === w.value)))
    .map(([p, d]) => ({ id: p.split('/').pop()!, ref: ref(p), data: () => d }));
const listeners = new Set<() => void>();
const refuse = new Set<string>();
const merge = (a: Record<string, unknown> | undefined, b: Record<string, unknown>) => ({ ...(a ?? {}), ...b });
mock.module('firebase/firestore', () => ({
  ...real,
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') }),
  doc: (first: { path: string } | unknown, ...parts: string[]) =>
    ref(typeof first === 'object' && first && 'path' in first ? [(first as { path: string }).path, ...parts].join('/') : parts.join('/')),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  query: (col: { path: string }, ...w: Where[]) => ({ ...col, w }),
  getDocs: async (q: { path: string; w: Where[] }) => ({ docs: docsOf(q) }),
  getDoc: async (r: Ref) => ({ exists: () => store.has(r.path), data: () => store.get(r.path) }),
  onSnapshot: (q: { path: string; w: Where[] }, next: (s: unknown) => void) => {
    const listener = () => next({ docs: docsOf(q) });
    listeners.add(listener);
    listener();
    return () => listeners.delete(listener);
  },
  writeBatch: () => {
    const ops: (() => void)[] = [];
    const paths: string[] = [];
    return {
      set: (r: Ref, d: Record<string, unknown>, o?: { merge?: boolean }) => (
        paths.push(r.path), ops.push(() => (writes++, store.set(r.path, o?.merge ? merge(store.get(r.path), d) : d)))
      ),
      update: (r: Ref, d: Record<string, unknown>) => (paths.push(r.path), ops.push(() => (writes++, store.set(r.path, merge(store.get(r.path), d))))),
      delete: (r: Ref) => (paths.push(r.path), ops.push(() => (writes++, store.delete(r.path)))),
      commit: async () => {
        if (paths.some((p) => refuse.has(p))) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
        ops.forEach((op) => op());
        listeners.forEach((l) => l());
      },
    };
  },
}));

const {
  TODO_FIELDS, TODO_ACTION_FIELDS, addedText, applyTodo, canDo, olderThan, resolveOps, sortTodos, syncTodos, todoDoc, todoDueText, todoId,
  todoOpsAllowed, todoOverdue, toTodoItem, watchTodos, TodoActionError, personalTodoDoc, syncPersonalTodos, PERSONAL_TODO_FIELDS,
} = await import('../src/todos');
const { memoryNotes, withoutPageStorage } = await import('./published-notes');
withoutPageStorage(beforeAll, afterAll);
type TodoInput = import('../src/todos').TodoInput;
type TodoItem = import('../src/todos').TodoItem;

const db = {} as real.Firestore;
const H = 'h1';
const NOW = new Date(2026, 9, 3, 10, 0).getTime();
const day = (m: number, d: number) => new Date(2026, m - 1, d, 12).getTime();
const ALEX = 'alex@example.com';
const SAM = 'sam@example.com';
const url = 'https://huishouden.example.web.app/tasks/?item=i1';
const base = `households/${H}`;
const reset = () => {
  store.clear();
  refuse.clear();
  writes = 0;
};
const stored = () =>
  [...store.entries()].filter(([p]) => p.startsWith(`${base}/todos/`)).map(([p, d]) => toTodoItem(p.split('/').pop()!, d));

const input = (over: Partial<TodoInput> = {}): TodoInput => ({
  ref: 'item:i1',
  title: 'Fix the porch light',
  createdAt: day(8, 1),
  url,
  owner: SAM,
  done: { label: 'Done', roles: ['admin', 'member', 'helper', 'kid'], ops: [{ col: 'items', id: 'i1', data: { completed: true, completedAt: '$now', updatedAt: '$now' }, merge: true }] },
  cancel: {
    label: 'Cancel',
    roles: ['admin', 'member'],
    owner: true,
    ops: [{ col: 'items', id: 'i1', data: { completed: true, completedAt: '$now', cancelledAt: '$now', cancelledBy: '$me', updatedAt: '$now' }, merge: true }],
  },
  ...over,
});
const item = (over: Partial<TodoItem> = {}): TodoItem => ({ ...todoDoc('tasks', input(), ALEX, NOW), id: todoId('tasks', 'item:i1'), ...over });

describe('to-do documents', () => {
  test('ids are <app>:<ref> and Firestore-safe', () => {
    expect(todoId('tasks', 'item:i1')).toBe('tasks:item:i1');
    expect(todoId('home', 'prep:e1/2026-10-03')).toBe('home:prep:e1_2026-10-03');
  });

  test('the stored document has only rules fields, trimmed, with lowercase emails and plain ops', () => {
    const d = todoDoc('tasks', input({ title: `  ${'x'.repeat(130)} `, detail: ' Chores   list ', who: '', owner: 'Sam@Example.com', due: 5.4 }), 'Alex@Example.com', 7);
    expect(d.title).toHaveLength(120);
    expect(d.detail).toBe('Chores list');
    expect('who' in d).toBe(false);
    expect(d.by).toBe(ALEX);
    expect(d.owner).toBe(SAM);
    expect(d.due).toBe(5);
    expect(d.status).toBe('open');
    expect(d.private).toBe(false);
    expect(d.updatedAt).toBe(7);
    for (const k of Object.keys(d)) expect(TODO_FIELDS as readonly string[]).toContain(k);
    for (const k of Object.keys(d.cancel!)) expect(TODO_ACTION_FIELDS as readonly string[]).toContain(k);
    const undef = todoDoc('tasks', input({ done: { label: 'Done', roles: ['admin'], ops: [{ col: 'items', id: 'i1', data: { a: 1, b: undefined } }] } }), ALEX);
    expect(undef.done!.ops[0].data).toEqual({ a: 1 });
  });

  test("Spending's and Bills' items are private whatever the app says", () => {
    expect(todoDoc('bills', input({ done: undefined, cancel: undefined }), ALEX).private).toBe(true);
  });

  test('summary lines keep no actions', () => {
    const d = todoDoc('groceries', { ref: 'list', title: 'Groceries: 6 on the list', createdAt: 1, url, status: 'info' }, ALEX);
    expect(d.status).toBe('info');
    expect('done' in d).toBe(false);
  });

  test('refuses what the rules or the portal would refuse', () => {
    expect(() => todoDoc('tasks', input({ url: '/tasks/' }), ALEX)).toThrow(/https/);
    expect(() => todoDoc('tasks', input({ title: ' ' }), ALEX)).toThrow(/title/);
    expect(() => todoDoc('tasks', input({ ref: '' }), ALEX)).toThrow(/ref/);
    expect(() => todoDoc('tasks', input({ createdAt: Number.NaN }), ALEX)).toThrow(/createdAt/);
    expect(() => todoDoc('Tasks', input(), ALEX)).toThrow(/app/);
    // An action that would write another app's records, or money.
    expect(() => todoDoc('tasks', input({ done: { label: 'Done', roles: ['admin'], ops: [{ col: 'bills', id: 'b1', data: null }] } }), ALEX)).toThrow(/outside/);
    expect(() => todoDoc('tasks', input({ done: { label: '', roles: ['admin'], ops: input().done!.ops } }), ALEX)).toThrow(/label/);
  });

  test('ops are allowed only on the app\'s own collections, at most eight', () => {
    expect(todoOpsAllowed('home', [{ col: 'homeTasks', id: 'j1', data: {} }])).toBe(true);
    expect(todoOpsAllowed('pet', [{ col: 'petOutings', id: 'out-p1-2031-01-06-meal-m1', data: {} }])).toBe(true);
    expect(todoOpsAllowed('pet', [{ col: 'petRoutineLogs', id: 'rtn-r1-2031-01-06', data: {} }])).toBe(true);
    expect(todoOpsAllowed('pet', [{ col: 'petRoutines', id: 'r1', data: {} }])).toBe(false);
    expect(todoOpsAllowed('pet', [{ col: 'petOutingPlans', id: 'p1', data: {} }])).toBe(false);
    expect(todoOpsAllowed('home', [{ col: 'items', id: 'j1', data: {} }])).toBe(false);
    expect(todoOpsAllowed('home', [{ col: 'homeTasks', id: 'a/b', data: {} }])).toBe(false);
    expect(todoOpsAllowed('home', [])).toBe(false);
    expect(todoOpsAllowed('home', Array.from({ length: 9 }, (_, i) => ({ col: 'homeTasks', id: `j${i}`, data: {} })))).toBe(false);
    expect(todoOpsAllowed('spending', [{ col: 'spendingTransactions', id: 't', data: null }])).toBe(false);
  });

  test('toTodoItem reads stored documents defensively', () => {
    expect(toTodoItem('x', { app: 'car', status: 'weird', createdAt: 'no', done: { label: 'Done', ops: [{ col: 'carRenewals', id: 'r', data: 3 }, 'x'], roles: ['boss', 'kid'] } })).toEqual({
      id: 'x', app: 'car', ref: '', title: '', createdAt: 0, url: '', status: 'open', updatedAt: 0, by: '', done: { label: 'Done', ops: [], roles: ['kid'] },
    });
  });
});

describe('syncTodos and watchTodos', () => {
  test('replace-by-app: writes what is new, leaves what is unchanged, deletes what is closed; other apps untouched', async () => {
    reset();
    expect(await syncTodos(db, H, 'tasks', [input(), input({ ref: 'item:i2', title: 'Return library books' })], { by: ALEX, now: NOW })).toEqual({ written: 2, deleted: 0, unchanged: 0 });
    await syncTodos(db, H, 'home', [{ ...input({ ref: 'job:j1', done: undefined, cancel: undefined }) }], { by: ALEX, now: NOW });
    writes = 0;
    expect(await syncTodos(db, H, 'tasks', [input()], { by: SAM, now: NOW + 5000 })).toEqual({ written: 0, deleted: 1, unchanged: 1 });
    expect(writes).toBe(1);
    expect(stored().map((t) => t.id).sort()).toEqual(['home:job:j1', 'tasks:item:i1']);
  });

  test('the same to-dos again from this device skip the read until they change', async () => {
    reset();
    const published = memoryNotes();
    const items = [input(), input({ ref: 'item:i2', title: 'Return library books' })];
    expect(await syncTodos(db, H, 'tasks', items, { by: ALEX, now: NOW, published })).toEqual({ written: 2, deleted: 0, unchanged: 0 });
    expect(await syncTodos(db, H, 'tasks', items, { by: ALEX, now: NOW + 1000, published })).toEqual({ written: 0, deleted: 0, unchanged: 2, skipped: true });
    expect(await syncTodos(db, H, 'tasks', [input()], { by: ALEX, now: NOW + 2000, published })).toEqual({ written: 0, deleted: 1, unchanged: 1 });
  });

  test('a helper never writes or removes private items, and a refused write is skipped', async () => {
    reset();
    await syncTodos(db, H, 'baby', [{ ...input({ ref: 'appt:a1', private: true, done: undefined, cancel: undefined }) }], { by: ALEX, now: NOW });
    const helper = { by: SAM, restricted: true, now: NOW };
    refuse.add(`${base}/todos/baby:appt:a2`);
    expect(await syncTodos(db, H, 'baby', [{ ...input({ ref: 'appt:a2', done: undefined, cancel: undefined }) }], helper)).toEqual({ written: 1, deleted: 0, unchanged: 0 });
    expect(stored().map((t) => t.id)).toEqual(['baby:appt:a1']);
  });

  test('watchTodos follows the list newest first, a helper only the open ones', async () => {
    reset();
    await syncTodos(db, H, 'tasks', [input({ ref: 'a', createdAt: day(1, 1) }), input({ ref: 'b', createdAt: day(5, 1), private: true })], { by: ALEX, now: NOW });
    let seen: TodoItem[] = [];
    const stop = watchTodos(db, H, {}, (items) => (seen = items));
    expect(seen.map((t) => t.ref)).toEqual(['b', 'a']);
    stop();
    watchTodos(db, H, { restricted: true }, (items) => (seen = items))();
    expect(seen.map((t) => t.ref)).toEqual(['a']);
  });
});

describe('reading the list', () => {
  const a = item({ id: 'a', app: 'home', createdAt: day(9, 1), due: day(10, 9), title: 'A' });
  const b = item({ id: 'b', app: 'tasks', createdAt: day(6, 1), title: 'B' });
  const c = item({ id: 'c', app: 'baby', createdAt: day(9, 20), due: day(10, 1), title: 'C' });
  const g = item({ id: 'g', app: 'groceries', createdAt: day(10, 3), status: 'info', title: 'Groceries: 6 on the list' });

  test('sorts by date added either way, by due date and by app; summary lines last', () => {
    expect(sortTodos([a, b, c, g], 'newest').map((t) => t.id)).toEqual(['c', 'a', 'b', 'g']);
    expect(sortTodos([a, b, c, g], 'oldest').map((t) => t.id)).toEqual(['b', 'a', 'c', 'g']);
    expect(sortTodos([a, b, c, g], 'due').map((t) => t.id)).toEqual(['c', 'a', 'b', 'g']);
    expect(sortTodos([a, b, c, g], 'app', ['tasks', 'home', 'baby']).map((t) => t.id)).toEqual(['b', 'a', 'c', 'g']);
  });

  test('older than 30 days, due and added in words', () => {
    expect(olderThan(b, NOW)).toBe(true);
    expect(olderThan(a, NOW)).toBe(true);
    expect(olderThan(c, NOW)).toBe(false);
    expect(olderThan({ ...b, status: 'info' }, NOW)).toBe(false);
    expect(todoDueText(c, NOW)).toBe('Overdue by 2 days');
    expect(todoDueText(a, NOW)).toBe('Due in 6 days');
    expect(todoDueText(b, NOW)).toBeUndefined();
    expect(todoOverdue(c, NOW)).toBe(true);
    expect(todoOverdue(a, NOW)).toBe(false);
    expect(addedText({ createdAt: NOW - 1000 }, NOW)).toBe('Added today');
    expect(addedText({ createdAt: day(10, 2) }, NOW)).toBe('Added yesterday');
    expect(addedText({ createdAt: day(9, 20) }, NOW)).toBe('Added 13 days ago');
    expect(addedText({ createdAt: day(8, 20) }, NOW)).toBe('Added 6 weeks ago');
    expect(addedText({ createdAt: day(8, 1) }, NOW)).toBe('Added 2 months ago');
    expect(addedText({ createdAt: day(1, 1) }, NOW)).toBe('Added 9 months ago');
  });

  test('canDo follows roles, the owner and named members; money only for admins and members', () => {
    const t = item();
    expect(canDo(t, 'done', 'kid', 'kid@example.com')).toBe(true);
    expect(canDo(t, 'cancel', 'member', ALEX)).toBe(true);
    expect(canDo(t, 'cancel', 'helper', 'helper@example.com')).toBe(false);
    expect(canDo({ ...t, owner: 'helper@example.com' }, 'cancel', 'helper', 'Helper@Example.com')).toBe(true);
    expect(canDo({ ...t, cancel: { ...t.cancel!, emails: ['h2@example.com'] } }, 'cancel', 'helper', 'h2@example.com')).toBe(true);
    expect(canDo(t, 'done', null, ALEX)).toBe(false);
    expect(canDo({ ...t, status: 'info' }, 'done', 'admin', ALEX)).toBe(false);
    expect(canDo({ ...t, app: 'bills', done: { label: 'Mark paid', roles: ['admin', 'member', 'helper'], ops: [{ col: 'bills', id: 'b', data: {} }] } }, 'done', 'helper', SAM)).toBe(false);
    // An action that writes outside its app (a tampered document) is never offered.
    expect(canDo({ ...t, done: { ...t.done!, ops: [{ col: 'settings', id: 'portal', data: null }] } }, 'done', 'admin', ALEX)).toBe(false);
  });
});

describe('applying an action', () => {
  test('placeholders resolve when the action runs', () => {
    const [op] = resolveOps([{ col: 'homeTasks', id: 'j', data: { lastDone: '$today', due: '$today+3m', week: '$today+2w', at: '$now', by: '$me', n: ['$today-1d'], keep: 'today$' }, merge: true }], { now: NOW, me: 'Sam@Example.com' });
    expect(op.data).toEqual({ lastDone: '2026-10-03', due: '2027-01-03', week: '2026-10-17', at: NOW, by: SAM, n: ['2026-10-02'], keep: 'today$' });
  });

  test('$nextDue resolves to the next due date as of the tap, not as of publishing', () => {
    const monthly = { kind: 'fixed', every: 1, unit: 'month', anchor: '2026-01-15' } as const;
    const resolve = (data: object, now = NOW) => resolveOps([{ col: 'homeTasks', id: 'j', data, merge: true }], { now, me: SAM })[0].data;
    // Three dates overdue (July, August, September 15): the next is October 15, after today.
    expect(resolve({ due: { $nextDue: { schedule: monthly, due: '2026-07-15' } } })).toEqual({ due: '2026-10-15' });
    // Done early: the coming date is covered, the next is the one after it.
    expect(resolve({ due: { $nextDue: { schedule: monthly, due: '2026-10-15' } } })).toEqual({ due: '2026-11-15' });
    expect(resolve({ due: { $nextDue: { schedule: { kind: 'after-done', every: 3, unit: 'month' }, due: '2026-07-15' } } })).toEqual({ due: '2027-01-03' });
    expect(() => resolve({ due: { $nextDue: { schedule: { kind: 'fixed', every: 0, unit: 'month', anchor: '2026-01-15' }, due: '2026-07-15' } } })).toThrow(TodoActionError);
    expect(() => resolve({ due: { $nextDue: { schedule: monthly, due: 'soon' } } })).toThrow(TodoActionError);
  });

  test('a set-dates job three dates overdue, done from the list, is next due after today', async () => {
    reset();
    const monthly = { kind: 'fixed', every: 1, unit: 'month', anchor: '2026-01-15' } as const;
    // Published in July, when only the July date had passed; tapped on 3 October.
    const published = todoDoc(
      'home',
      {
        ref: 'job:j1',
        title: 'Clean the gutters',
        createdAt: 1,
        url,
        done: { label: 'Done', roles: ['admin', 'member', 'helper', 'kid'], ops: [{ col: 'homeTasks', id: 'j1', merge: true, data: { lastDone: '$today', due: { $nextDue: { schedule: monthly, due: '2026-07-15' } }, updatedAt: '$now' } }] },
      },
      ALEX,
      day(7, 16),
    );
    store.set(`${base}/todos/home:job:j1`, published);
    store.set(`${base}/homeTasks/j1`, { title: 'Clean the gutters', schedule: monthly, due: '2026-07-15', by: ALEX });
    const applied = await applyTodo(db, H, { ...published, id: 'home:job:j1' }, 'done', { me: SAM, now: NOW });
    await applied.written;
    const job = store.get(`${base}/homeTasks/j1`)!;
    expect(job).toEqual({ title: 'Clean the gutters', schedule: monthly, due: '2026-10-15', lastDone: '2026-10-03', updatedAt: NOW, by: ALEX });
    expect(daysBetween('2026-10-03', job.due as string)).toBeGreaterThan(0);
  });

  test("a to-do done here forgets its app's note: the app's next sync reads again", async () => {
    reset();
    const notes = memoryNotes();
    store.set(`${base}/items/i1`, { name: 'Fix the porch light', completed: false, by: SAM });
    await syncTodos(db, H, 'tasks', [input()], { by: ALEX, now: NOW, published: notes });
    expect(await syncTodos(db, H, 'tasks', [input()], { by: ALEX, now: NOW + 1000, published: notes })).toMatchObject({ skipped: true });
    const [t] = stored();
    await (await applyTodo(db, H, t, 'cancel', { me: ALEX, now: NOW + 2000, published: notes })).written;
    expect(await syncTodos(db, H, 'tasks', [input()], { by: ALEX, now: NOW + 3000, published: notes })).not.toHaveProperty('skipped');
  });

  test('done writes the source record and removes the item in one batch; Undo puts both back', async () => {
    reset();
    store.set(`${base}/items/i1`, { name: 'Fix the porch light', completed: false, by: SAM });
    await syncTodos(db, H, 'tasks', [input()], { by: ALEX, now: NOW });
    const [t] = stored();
    const applied = await applyTodo(db, H, t, 'cancel', { me: 'Alex@Example.com', now: NOW });
    await applied.written;
    expect(store.get(`${base}/items/i1`)).toEqual({ name: 'Fix the porch light', completed: true, completedAt: NOW, cancelledAt: NOW, cancelledBy: ALEX, updatedAt: NOW, by: SAM });
    expect(stored()).toEqual([]);
    await applied.undo();
    expect(store.get(`${base}/items/i1`)).toEqual({ name: 'Fix the porch light', completed: false, by: SAM });
    const [back] = stored();
    expect({ ...back, updatedAt: 0 }).toEqual({ ...t, updatedAt: 0 });
  });

  test('a record created by the action is removed again by Undo', async () => {
    reset();
    const dose = todoDoc('pet', { ref: 'dose:c1:2026-10-03:0', title: 'Carprofen', createdAt: 1, url, done: { label: 'Given', roles: ['admin', 'member', 'helper'], ops: [{ col: 'petMedDoses', id: 'c1_2026-10-03_0', data: { courseId: 'c1', slot: 0, at: '$now', by: '$me', createdAt: '$now' } }] } }, ALEX, NOW);
    const t = { ...dose, id: 'pet:dose' };
    store.set(`${base}/todos/pet:dose`, dose);
    const applied = await applyTodo(db, H, t, 'done', { me: SAM, now: NOW });
    expect(store.get(`${base}/petMedDoses/c1_2026-10-03_0`)).toEqual({ courseId: 'c1', slot: 0, at: NOW, by: SAM, createdAt: NOW });
    await applied.undo();
    expect(store.has(`${base}/petMedDoses/c1_2026-10-03_0`)).toBe(false);
    expect(store.get(`${base}/todos/pet:dose`)?.by).toBe(SAM);
  });

  test('refuses a merge onto a record deleted in its app, and an action writing elsewhere', async () => {
    reset();
    await expect(applyTodo(db, H, item(), 'done', { me: ALEX, now: NOW })).rejects.toBeInstanceOf(TodoActionError);
    await expect(applyTodo(db, H, item({ done: { label: 'Done', roles: ['admin'], ops: [{ col: 'bills', id: 'b', data: null }] } }), 'done', { me: ALEX })).rejects.toThrow(/its app/);
    expect(writes).toBe(0);
  });
});

describe('to-dos for named members only', () => {
  const NAN = 'nan@example.com';
  const dosesCol = 'healthPeople/p1/doses';
  const personal = (over: Partial<import('../src/todos').PersonalTodoInput> = {}): import('../src/todos').PersonalTodoInput => ({
    ref: 'missed:p1:2026-10-03T08:00',
    title: 'Missed 8:00 AM medicine for Nan',
    createdAt: NOW,
    url: 'https://huishouden.example.web.app/health/',
    audience: [ALEX, NAN],
    done: { label: 'Given', roles: ['admin'], emails: [ALEX, NAN], ops: [{ col: dosesCol, id: 'm1_2026-10-03T08_00', data: { medId: 'm1', slot: '2026-10-03T08:00', status: 'given', at: 1, by: '$me', createdAt: '$now' } }] },
    ...over,
  });
  const personalStored = () =>
    [...store.entries()].filter(([p]) => p.startsWith(`${base}/personalTodos/`)).map(([p, d]) => toTodoItem(p.split('/').pop()!, d));

  test("nested collections match a star for one id, and nothing else", () => {
    const op = (col: string) => [{ col, id: 'x', data: {} }];
    expect(todoOpsAllowed('health', op('healthPeople/p1/doses'))).toBe(true);
    expect(todoOpsAllowed('health', op('healthPeople/p1/meds'))).toBe(true);
    expect(todoOpsAllowed('health', op('healthPeople/p1/doses/x/y'))).toBe(false);
    expect(todoOpsAllowed('health', op('healthPeople/../doses'))).toBe(false);
    expect(todoOpsAllowed('health', op('healthPeople'))).toBe(false);
    expect(todoOpsAllowed('health', op('petMedDoses'))).toBe(false);
  });

  test('the document names its audience and is private; it must name its writer', () => {
    const d = personalTodoDoc('health', personal(), ALEX, NOW);
    expect(d.audience).toEqual([ALEX, NAN]);
    expect(d.private).toBe(true);
    for (const k of Object.keys(d)) expect(PERSONAL_TODO_FIELDS as readonly string[]).toContain(k);
    expect(() => personalTodoDoc('health', personal({ audience: [NAN] }), ALEX, NOW)).toThrow();
  });

  test('sync writes only items naming the writer; watch with me merges them; Done removes it from the personal list', async () => {
    reset();
    await syncTodos(db, H, 'tasks', [input()], { by: ALEX, now: NOW });
    expect(await syncPersonalTodos(db, H, 'health', [personal(), personal({ ref: 'refill:m2', audience: [NAN] })], { by: ALEX, now: NOW })).toEqual({ written: 1, deleted: 0, unchanged: 0 });
    const seen: TodoItem[][] = [];
    const stop = watchTodos(db, H, { me: ALEX }, (items) => seen.push(items));
    expect(seen.at(-1)!.map((i) => i.title).sort()).toEqual(['Fix the porch light', 'Missed 8:00 AM medicine for Nan']);
    const others: TodoItem[][] = [];
    const stop2 = watchTodos(db, H, { me: SAM }, (items) => others.push(items));
    expect(others.at(-1)!.map((i) => i.title)).toEqual(['Fix the porch light']);
    const t = personalStored()[0];
    expect(canDo(t, 'done', 'member', ALEX)).toBe(true);
    expect(canDo(t, 'done', 'member', SAM)).toBe(false);
    const applied = await applyTodo(db, H, t, 'done', { me: ALEX, now: NOW });
    await applied.written;
    expect(store.get(`${base}/${dosesCol}/m1_2026-10-03T08_00`)).toEqual({ medId: 'm1', slot: '2026-10-03T08:00', status: 'given', at: 1, by: ALEX, createdAt: NOW });
    expect(personalStored()).toEqual([]);
    expect(stored()).toHaveLength(1);
    await applied.undo();
    expect(store.has(`${base}/${dosesCol}/m1_2026-10-03T08_00`)).toBe(false);
    expect(personalStored()[0].audience).toEqual([ALEX, NAN]);
    expect(personalStored()[0].private).toBe(true);
    stop();
    stop2();
  });
});
