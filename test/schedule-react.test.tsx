import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import type { EventPrep, EventRule } from '../src/schedule';

if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://home.example.com/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');
const { RulePicker, PrepPicker, nextDatesText } = await import('../src/react/schedule');

// A root left mounted keeps rendering after its test, into the next file once this DOM is gone.
const roots: Root[] = [];
const unmountAll = () => act(() => roots.splice(0).forEach((r) => r.unmount()));
afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

function render(node: React.ReactNode) {
  unmountAll();
  document.body.innerHTML = '<div id="app"></div>';
  const root = createRoot(document.getElementById('app')!);
  roots.push(root);
  act(() => root.render(node));
  return root;
}
const button = (name: string) => Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name) as HTMLButtonElement;
const click = (name: string) => act(() => button(name).click());
const text = () => document.body.textContent ?? '';

function Harness({ initial, onRule }: { initial: EventRule; onRule: (r: EventRule) => void }) {
  const [rule, setRule] = useState(initial);
  return <RulePicker rule={rule} today="2031-10-16" onChange={(r) => (setRule(r), onRule(r))} />;
}

describe('RulePicker', () => {
  test('reads the rule back in words with the next dates, and switches between shapes', () => {
    const seen = mock((_: EventRule) => {});
    render(<Harness initial={{ freq: 'week', every: 1, start: '2031-10-16' }} onRule={seen} />);
    expect(text()).toContain('Every Thursday. Next: Thu, Oct 16 · Thu, Oct 23 · Thu, Oct 30.');
    expect(button('Thursday').getAttribute('aria-pressed')).toBe('true');

    click('Monday');
    expect(seen.mock.lastCall![0]).toEqual({ freq: 'week', every: 1, start: '2031-10-16', days: [1, 4] });
    expect(text()).toContain('Every Monday and Thursday');

    click('Every few weeks');
    expect(seen.mock.lastCall![0]).toEqual({ freq: 'week', every: 2, start: '2031-10-16' });
    expect(text()).toContain('Every other Thursday');

    click('Every month');
    expect(text()).toContain('On the third Thursday');
    click('On the third Thursday');
    expect(seen.mock.lastCall![0]).toEqual({ freq: 'month', every: 1, start: '2031-10-16', nth: 3, weekday: 4 });
    expect(text()).toContain('Every month on the third Thursday. Next: Thu, Oct 16 · Thu, Nov 20 · Thu, Dec 18.');

    click('Every year');
    expect(text()).toContain('Every year on October 16');
  });

  test('the last weekday is offered when the start is one', () => {
    render(<Harness initial={{ freq: 'month', every: 1, start: '2031-10-30' }} onRule={() => {}} />);
    expect(button('On the last Thursday')).toBeTruthy();
    expect(button('On the 30th').getAttribute('aria-pressed')).toBe('true');
  });

  test('nextDatesText skips what was skipped', () => {
    expect(nextDatesText({ freq: 'week', every: 1, start: '2031-10-16' }, '2031-10-16', 2, { '2031-10-16': { skipped: true } })).toBe('Thu, Oct 23 · Thu, Oct 30');
  });
});

describe('PrepPicker', () => {
  function PrepHarness({ onPrep }: { onPrep: (p: EventPrep | null) => void }) {
    const [prep, setPrep] = useState<EventPrep | null>(null);
    return <PrepPicker prep={prep} suggestedTitle="Take the garbage out" onChange={(p) => (setPrep(p), onPrep(p))} />;
  }

  test('off until ticked; then the evening before with a reminder, and other times', () => {
    const seen = mock((_: EventPrep | null) => {});
    render(<PrepHarness onPrep={seen} />);
    expect(document.querySelectorAll('input[type=time]')).toHaveLength(0);
    act(() => (document.querySelector('input[type=checkbox]') as HTMLInputElement).click());
    expect(seen.mock.lastCall![0]).toEqual({ title: 'Take the garbage out', offset: { daysBefore: 1, time: '19:00' }, remind: true });
    expect(text()).toContain('The evening before at 7 PM.');
    click('The morning of');
    expect(text()).toContain('The morning of, by 7 AM.');
    click('Days before');
    expect(seen.mock.lastCall![0]?.offset).toEqual({ daysBefore: 2, time: '07:00' });
  });

  test('a time ending in a period (Spanish "p.m.") ends the sentence once', async () => {
    const { setLangForTests, resetI18nForTests } = await import('../src/i18n');
    await setLangForTests('es', ['es-MX']);
    try {
      render(<PrepPicker prep={{ title: 'Sacar la basura', offset: { daysBefore: 1, time: '19:00' }, remind: true }} suggestedTitle="" onChange={() => {}} />);
      expect(text()).toContain('7 p.m.');
      expect(text()).not.toContain('p.m..');
    } finally {
      resetI18nForTests();
    }
  });
});

