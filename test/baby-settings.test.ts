import { describe, expect, test } from 'bun:test';
import { clampKickTarget, isKickReminder, KICK_REMIND_DAYS, kickReminderPlan, kickReminders, type KickReminderOptions } from '../src/baby-settings';

// Baby's kick reminder, as Baby and the assistant's tool both write it. Times are read as UTC here.
const NOW = Date.UTC(2031, 0, 6, 13);
const opts: KickReminderOptions = {
  today: '2031-01-06',
  now: NOW,
  at: (ymd, hhmm) => Date.parse(`${ymd}T${hhmm}:00Z`),
  url: 'https://example.web.app/baby/#kicks',
  title: 'Time for a kick count',
  body: 'Count now.',
};

describe('kickReminders', () => {
  test("one a day for the days still to come, today's only when its time is ahead", () => {
    const later = kickReminders('19:00', opts);
    expect(later).toHaveLength(KICK_REMIND_DAYS);
    expect(later[0]).toEqual({ app: 'baby', title: 'Time for a kick count', body: 'Count now.', at: Date.UTC(2031, 0, 6, 19), url: opts.url, recipients: 'all', ref: 'kicks:2031-01-06', private: true, source: { checks: [{ doc: 'babyKickSessions/2031-01-06', absent: true }] } });
    const morning = kickReminders('07:00', opts);
    expect(morning.map((r) => r.ref)).toEqual(['07', '08', '09', '10', '11', '12'].map((d) => `kicks:2031-01-${d}`));
  });

  test('none without a time, or with one that is not HH:MM; no source when the device may not attach one', () => {
    expect(kickReminders(undefined, opts)).toEqual([]);
    expect(kickReminders('7pm', opts)).toEqual([]);
    expect(kickReminders('19:00', { ...opts, withSource: false })[0]).not.toHaveProperty('source');
  });
});

describe('kickReminderPlan', () => {
  test('sets the wanted ones under stable ids; removes only unsent kick reminders still to come that are not wanted', () => {
    const wanted = kickReminders('19:00', opts).slice(0, 2);
    const plan = kickReminderPlan(
      [
        { id: 'past', ref: 'kicks:2031-01-05', at: NOW - 1, sent: false },
        { id: 'sent', ref: 'kicks:2031-01-07', at: NOW + 9e7, sent: true },
        { id: 'stale', ref: 'kicks:2031-01-08', at: NOW + 1e8, sent: false },
        { id: 'visit', ref: 'appointment:a1:day', at: NOW + 1e8, sent: false },
        { id: `kicks_2031-01-06-${Date.UTC(2031, 0, 6, 19)}`, ref: 'kicks:2031-01-06', at: Date.UTC(2031, 0, 6, 19), sent: false },
      ],
      wanted,
      'sam@example.com',
      NOW,
    );
    expect(plan.remove).toEqual(['stale']);
    expect(plan.set.map(([id]) => id)).toEqual([`kicks_2031-01-06-${Date.UTC(2031, 0, 6, 19)}`, `kicks_2031-01-07-${Date.UTC(2031, 0, 7, 19)}`]);
    expect(plan.set[0][1]).toMatchObject({ app: 'baby', private: true, sent: false, by: 'sam@example.com', createdAt: NOW });
  });

  test('nothing wanted: every kick reminder still to come goes', () => {
    expect(kickReminderPlan([{ id: 'a', ref: 'kicks:2031-01-08', at: NOW + 1, sent: false }], [], 'sam@example.com', NOW)).toEqual({ remove: ['a'], set: [] });
  });
});

test('clampKickTarget and isKickReminder', () => {
  expect([clampKickTarget(1), clampKickTarget(12.4), clampKickTarget(99), clampKickTarget(Number.NaN)]).toEqual([2, 12, 50, 10]);
  expect([isKickReminder({ ref: 'kicks:2031-01-06' }), isKickReminder({ ref: 'appointment:a' }), isKickReminder({})]).toEqual([true, false, false]);
});
