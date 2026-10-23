import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, setSystemTime, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import calendarList from './fixtures/calendar-api/calendar-list.json';
import vetEvents from './fixtures/calendar-api/vet-events.json';
import groomerEvents from './fixtures/calendar-api/groomer-events.json';
import type { CalendarMatch } from '../src/calendar';

// React DOM decides at import whether it runs in a browser, so the DOM comes first.
if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://pet.example.com/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');
const { CALENDAR_SCOPES, dismissEvent, dismissedEvents, isImported, newSuggestions, suggestionWhen } = await import('../src/calendar');
const { CalendarSuggestions, useCalendarSuggestions } = await import('../src/react/calendar');

// The sample morning: Wednesday 14 May 2031, 10:30 local time.
const NOW = new Date(2031, 4, 14, 10, 30).getTime();
const at = (day: number, h: number, m = 0) => new Date(2031, 4, day, h, m).getTime();
const match = (id: string, title: string, start: number, extra: Partial<CalendarMatch> = {}): CalendarMatch => ({
  id,
  title,
  start,
  allDay: false,
  location: '',
  description: '',
  link: `https://calendar.example.com/${id}`,
  calendarName: 'Family',
  ...extra,
});

const user = { uid: 'u1', email: 'sam@example.com' };
const fakeAuth = (who: typeof user | null = user) => ({ currentUser: who, onAuthStateChanged: (cb: (u: unknown) => void) => (cb(who), () => {}) }) as never;
const seedToken = (token = 'cal-token', uid = 'u1') =>
  localStorage.setItem('hh-google-tokens', JSON.stringify([{ uid, scopes: CALENDAR_SCOPES, token, expires: Date.now() + 50 * 60_000 }]));

/** Calendar API stand-in: answers from the fixtures and records each request's token and query. */
const calls: { path: string; q: string | null; token: string | null; timeMin: string | null; timeMax: string | null }[] = [];
function serveCalendar(url: string | URL, init?: RequestInit): Response {
  const u = new URL(String(url));
  calls.push({ path: u.pathname, q: u.searchParams.get('q'), token: new Headers(init?.headers).get('Authorization'), timeMin: u.searchParams.get('timeMin'), timeMax: u.searchParams.get('timeMax') });
  const body = u.pathname.endsWith('/calendarList')
    ? calendarList.body
    : u.searchParams.get('q') === 'vet'
      ? vetEvents.body
      : u.searchParams.get('q') === 'groomer'
        ? groomerEvents.body
        : { items: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let root: Root | null = null;
function render(node: React.ReactNode) {
  document.body.innerHTML = '<div id="app"></div>';
  root = createRoot(document.getElementById('app')!);
  act(() => root!.render(node));
}
/** Lets the scan's requests and state updates finish. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const button = (name: string) => document.querySelector(`button[aria-label="${name}"]`) ?? Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
const card = () => document.querySelector('section[aria-label="New in your calendar"]');

beforeEach(() => {
  setSystemTime(new Date(NOW));
  localStorage.clear();
  calls.length = 0;
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => serveCalendar(url, init)) as unknown as typeof fetch;
  delete window.__mockCalendarEvents;
  delete window.__mockCalendarToken;
});
// window is the global object under the DOM: what a test puts on it, and the fetch stub, would
// otherwise outlive this file's DOM.
const realFetch = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  setSystemTime();
  globalThis.fetch = realFetch;
  delete window.__mockCalendarEvents;
  delete window.__mockCalendarToken;
  delete (window as unknown as { google?: unknown }).google;
});

describe('suggestion helpers', () => {
  test('newSuggestions drops imported, dismissed and repeated events, soonest first', () => {
    const list = [match('b', 'Groomer', at(20, 9)), match('a', 'Vet', at(18, 9)), match('a', 'Vet', at(18, 9)), match('c', 'Vet', at(19, 9)), match('d', 'Vet', at(21, 9))];
    const got = newSuggestions(list, { isImported: (m) => m.id === 'c', dismissed: ['d'] });
    expect(got.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('dismissals are kept per member and app, at most 200', () => {
    dismissEvent('Pet', 'u1', 'evt-1');
    dismissEvent('Pet', 'u1', 'evt-1');
    expect(dismissedEvents('Pet', 'u1')).toEqual(['evt-1']);
    expect(dismissedEvents('Pet', 'u2')).toEqual([]);
    expect(dismissedEvents('Car', 'u1')).toEqual([]);
    for (let i = 0; i < 205; i++) dismissEvent('Pet', 'u1', `e${i}`);
    expect(dismissedEvents('Pet', 'u1')).toHaveLength(200);
    expect(dismissedEvents('Pet', 'u1')[199]).toBe('e204');
    localStorage.setItem('pet-calendar-dismissed-u3', 'not json');
    expect(dismissedEvents('Pet', 'u3')).toEqual([]);
  });

  test('suggestionWhen says the day in as few words as fit', () => {
    const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const weekday = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short' });
    const dayShort = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    expect(suggestionWhen(match('a', 'x', at(14, 15)), NOW)).toBe(`Today ${time(at(14, 15))}`);
    expect(suggestionWhen(match('a', 'x', at(15, 9, 30)), NOW)).toBe(`Tomorrow ${time(at(15, 9, 30))}`);
    expect(suggestionWhen(match('a', 'x', at(20, 15)), NOW)).toBe(`${weekday(at(20, 15))} ${time(at(20, 15))}`);
    expect(suggestionWhen(match('a', 'x', at(28, 15)), NOW)).toBe(`${dayShort(at(28, 15))}, ${time(at(28, 15))}`);
    expect(suggestionWhen(match('a', 'x', at(16, 0), { allDay: true }), NOW)).toBe(`${weekday(at(16, 0))}, all day`);
    expect(suggestionWhen(match('a', 'x', at(30, 0), { allDay: true }), NOW)).toBe(dayShort(at(30, 0)));
  });
});

describe('useCalendarSuggestions', () => {
  const imported = [{ title: 'Vet — Pepper', calendarEventId: 'evt-vet-old' }];
  let state: ReturnType<typeof useCalendarSuggestions> | null = null;
  const onAdd = mock((_m: CalendarMatch) => {});
  const signedIn = fakeAuth();
  function Harness({ auth = signedIn, words = ['vet', 'groomer'], horizonDays }: { auth?: never; words?: string[]; horizonDays?: number }) {
    state = useCalendarSuggestions({ auth, words, isImported: (m) => isImported(m, imported), app: 'Pet', horizonDays });
    return <CalendarSuggestions suggestions={state.suggestions} onAdd={onAdd} onDismiss={state.dismiss} now={NOW} />;
  }
  beforeEach(() => {
    state = null;
    onAdd.mockClear();
  });

  test('without a token on this device it asks nobody and suggests nothing', async () => {
    const gis = mock(() => {});
    (window as unknown as { google: unknown }).google = { accounts: { oauth2: { initTokenClient: gis } } };
    render(<Harness />);
    await settle();
    expect(state!.canScan).toBe(false);
    expect(state!.suggestions).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(gis).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  test('on open, scans the theme words with the cached token and leaves out what the app has', async () => {
    seedToken();
    render(<Harness />);
    await settle();
    expect(state!.canScan).toBe(true);
    expect(calls.every((c) => c.token === 'Bearer cal-token')).toBe(true);
    expect(calls.filter((c) => c.q).map((c) => c.q)).toEqual(['vet', 'groomer']);
    expect(state!.suggestions.map((m) => m.id)).toEqual(['evt-vet-biscuit', 'evt-groomer']);
    expect(card()!.textContent).toContain('New in your calendar: Vet — Biscuit');
    expect(button('+1 more')).toBeTruthy();
  });

  test('looks ahead only horizonDays', async () => {
    seedToken();
    render(<Harness horizonDays={10} />);
    await settle();
    expect(state!.suggestions.map((m) => m.id)).toEqual(['evt-vet-biscuit']);
    const search = calls.find((c) => c.q)!;
    expect(search.timeMin).toBe(new Date(NOW).toISOString());
    expect(search.timeMax).toBe(new Date(NOW + 10 * 86_400_000).toISOString());
  });

  test('looks again on return to view, at most every 30 minutes', async () => {
    seedToken();
    render(<Harness />);
    await settle();
    const first = calls.length;
    const show = () => act(() => void document.dispatchEvent(new Event('visibilitychange')));
    setSystemTime(new Date(NOW + 29 * 60_000));
    show();
    await settle();
    expect(calls.length).toBe(first);
    setSystemTime(new Date(NOW + 31 * 60_000));
    seedToken();
    show();
    await settle();
    expect(calls.length).toBe(first * 2);
  });

  test('Not this one hides the event for this member, also after reopening', async () => {
    seedToken();
    render(<Harness />);
    await settle();
    click(button('Not this one: Vet — Biscuit'));
    expect(state!.suggestions.map((m) => m.id)).toEqual(['evt-groomer']);
    expect(dismissedEvents('Pet', 'u1')).toEqual(['evt-vet-biscuit']);
    act(() => root!.unmount());
    render(<Harness />);
    await settle();
    expect(state!.suggestions.map((m) => m.id)).toEqual(['evt-groomer']);
    expect(card()!.textContent).toContain('Groomer');
    expect(button('+1 more')).toBeFalsy();
  });

  test('Add hands the event to the app and moves to the next one', async () => {
    seedToken();
    render(<Harness />);
    await settle();
    click(button('Add Vet — Biscuit'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].id).toBe('evt-vet-biscuit');
    expect(card()!.textContent).toContain('New in your calendar: Groomer');
  });

  test('a failed scan is quiet', async () => {
    seedToken();
    globalThis.fetch = mock(async () => new Response('{"error":{"message":"Invalid Credentials"}}', { status: 401 })) as unknown as typeof fetch;
    render(<Harness />);
    await settle();
    expect(state!.suggestions).toEqual([]);
    expect(state!.canScan).toBe(false);
    expect(card()).toBeNull();
  });

  test('looks on open even before Firebase reports the member, and again for a restored session', async () => {
    let report: (u: unknown) => void = () => {};
    const restoring = { currentUser: null as typeof user | null, onAuthStateChanged: (cb: (u: unknown) => void) => ((report = cb), () => {}) } as unknown as { currentUser: typeof user | null };
    window.__mockCalendarToken = 'test-token';
    window.__mockCalendarEvents = [match('m1', 'Vet — Biscuit', at(20, 15)), match('m2', 'Groomer', at(21, 9))];
    dismissEvent('Pet', 'u1', 'm1');
    render(<Harness auth={restoring as never} />);
    await settle();
    expect(state!.suggestions.map((m) => m.id)).toEqual(['m1', 'm2']);
    restoring.currentUser = user;
    act(() => report(user));
    await settle();
    expect(state!.suggestions.map((m) => m.id)).toEqual(['m2']);
  });

  test('browser tests stand in with __mockCalendarEvents and __mockCalendarToken, signed out', async () => {
    window.__mockCalendarEvents = [match('m1', 'Vet — Biscuit', at(20, 15)), match('old', 'Vet', at(1, 9)), match('far', 'Vet', at(14, 9) + 90 * 86_400_000)];
    window.__mockCalendarToken = 'test-token';
    const signedOut = fakeAuth(null);
    render(<Harness auth={signedOut} />);
    await settle();
    expect(state!.suggestions.map((m) => m.id)).toEqual(['m1']);
    expect(calls).toHaveLength(0);
  });
});

describe('CalendarSuggestions', () => {
  test('nothing to show renders nothing', () => {
    render(<CalendarSuggestions suggestions={[]} onAdd={() => {}} onDismiss={() => {}} now={NOW} />);
    expect(card()).toBeNull();
  });

  test('one line, with "+2 more" opening the rest, each with Add and Not this one', () => {
    const onAdd = mock((_m: CalendarMatch) => {});
    const onDismiss = mock((_m: CalendarMatch) => {});
    const list = [match('a', 'Vet — Biscuit', at(20, 15)), match('b', 'Groomer', at(22, 9)), match('c', 'Kennel', at(24, 9))];
    render(<CalendarSuggestions suggestions={list} onAdd={onAdd} onDismiss={onDismiss} now={NOW} />);
    expect(card()!.querySelector('p')!.textContent).toBe(`New in your calendar: Vet — Biscuit · ${suggestionWhen(list[0], NOW)}`);
    expect(document.querySelector('[aria-label="More new calendar events"]')).toBeNull();
    const more = button('+2 more')!;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    click(more);
    const items = document.querySelectorAll('[aria-label="More new calendar events"] li');
    expect(Array.from(items).map((li) => li.querySelector('span')!.textContent)).toEqual(['Groomer', 'Kennel']);
    click(button('Add Kennel'));
    expect(onAdd.mock.calls[0][0].id).toBe('c');
    expect(button('+1 more')).toBeTruthy();
    click(button('Not this one: Groomer'));
    expect(onDismiss.mock.calls[0][0].id).toBe('b');
  });

  test('the list is tied to its toggle, and focus stays on the card after a button', async () => {
    const list = [match('a', 'Vet — Biscuit', at(20, 15)), match('b', 'Groomer', at(22, 9))];
    render(<CalendarSuggestions suggestions={list} onAdd={() => {}} onDismiss={() => {}} now={NOW} />);
    const more = button('+1 more')!;
    click(more);
    expect(document.getElementById(more.getAttribute('aria-controls')!)?.getAttribute('aria-label')).toBe('More new calendar events');
    click(button('Not this one: Vet — Biscuit'));
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
    expect(document.activeElement).toBe(card());
  });

  test('an added event whose record never arrives comes back', () => {
    jest.useFakeTimers();
    try {
      const list = [match('a', 'Vet — Biscuit', at(20, 15)), match('b', 'Groomer', at(22, 9))];
      render(<CalendarSuggestions suggestions={list} onAdd={() => {}} onDismiss={() => {}} now={NOW} />);
      click(button('Add Vet — Biscuit'));
      expect(card()!.querySelector('p')!.textContent).toContain('Groomer');
      act(() => void jest.advanceTimersByTime(11_000));
      expect(card()!.querySelector('p')!.textContent).toContain('Vet — Biscuit');
    } finally {
      jest.useRealTimers();
    }
  });
});
