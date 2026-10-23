import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { GoogleTask } from '../src/google-tasks';

// React DOM decides at import whether it runs in a browser, so the DOM comes first.
if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://tasks.example.com/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');
const { GoogleTasksSuggestions, googleTaskDue, useGoogleTasksSuggestions } = await import('../src/react/google-tasks');

const NOW = new Date(2031, 4, 14, 10, 30).getTime(); // Wednesday
const task = (id: string, title: string, listId: string, extra: Partial<GoogleTask> = {}): GoogleTask => ({ id, listId, title, notes: '', updated: NOW - 1000, completed: false, ...extra });
const user = { uid: 'u1', email: 'sam@example.com' };
const auth = { currentUser: user, onAuthStateChanged: (cb: (u: unknown) => void) => (cb(user), () => {}) } as never;

let root: Root | null = null;
function render(node: React.ReactNode) {
  document.body.innerHTML = '<div id="app"></div>';
  root = createRoot(document.getElementById('app')!);
  act(() => root!.render(node));
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
const button = (name: string) => document.querySelector(`button[aria-label="${name}"]`) as HTMLElement | null;
const card = () => document.querySelector('section[aria-label="New in Google Tasks"]');

beforeEach(() => {
  localStorage.clear();
  delete window.__mockGoogleTasks;
  delete window.__mockGoogleTasksToken;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  // window is the global object under the DOM, so these would outlive this file's DOM.
  delete window.__mockGoogleTasks;
  delete window.__mockGoogleTasksToken;
});

describe('useGoogleTasksSuggestions', () => {
  let state: ReturnType<typeof useGoogleTasksSuggestions> | null = null;
  const onAdd = mock((_t: GoogleTask) => {});
  function Harness({ listIds = ['house'], imported = [] as string[] }) {
    state = useGoogleTasksSuggestions({ auth, app: 'tasks', listIds, isImported: (t) => imported.includes(t.id) });
    return <GoogleTasksSuggestions suggestions={state.suggestions} listTitle={(id) => (id === 'house' ? 'My Tasks' : undefined)} onAdd={onAdd} onDismiss={state.dismiss} now={NOW} />;
  }

  test('without a token on this device it suggests nothing', async () => {
    window.__mockGoogleTasks = [task('a', 'Call the dentist', 'house')];
    render(<Harness />);
    await settle();
    expect(state!.canScan).toBe(false);
    expect(card()).toBeNull();
  });

  test('suggests open tasks from the chosen lists that the app lacks; Not this one keeps one away', async () => {
    window.__mockGoogleTasksToken = 'tasks-token';
    window.__mockGoogleTasks = [
      task('a', 'Call the dentist', 'house', { due: '2031-05-16', updated: NOW - 5000 }),
      task('b', 'Fix the gate', 'house', { updated: NOW - 4000 }),
      task('c', 'Eggs', 'groceries'),
      task('d', 'Already here', 'house'),
      task('e', 'Done already', 'house', { completed: true }),
    ];
    render(<Harness imported={['d']} />);
    await settle();
    expect(state!.suggestions.map((t) => t.id)).toEqual(['a', 'b']);
    expect(card()?.textContent).toContain('New in Google Tasks: Call the dentist');
    expect(card()?.textContent).toContain(`${googleTaskDue(window.__mockGoogleTasks[0], NOW)} · My Tasks`);
    act(() => button('Not this one: Call the dentist')!.click());
    expect(state!.suggestions.map((t) => t.id)).toEqual(['b']);
    expect(JSON.parse(localStorage.getItem('tasks-google-tasks-dismissed-u1') ?? '[]')).toEqual(['a']);
    act(() => button('Add Fix the gate')!.click());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  test('due words', () => {
    const t = (due: string) => googleTaskDue(task('x', 'x', 'l', { due }), NOW);
    expect(t('2031-05-14')).toBe('Due today');
    expect(t('2031-05-15')).toBe('Due tomorrow');
    expect(t('2031-05-16')).toBe(`Due ${new Date(2031, 4, 16).toLocaleDateString(undefined, { weekday: 'short' })}`);
    expect(googleTaskDue(task('x', 'x', 'l'), NOW)).toBeNull();
  });
});
