import { z } from 'zod';
import { BABY_SETTINGS_LIMITS, clampKickTarget, DEFAULT_KICK_TARGET, KICK_REMIND_AT, KICK_REMIND_DAYS, kickReminderPlan, kickReminders } from '../baby-settings.js';
import { localizeReminders, toReminder } from '../reminder-core.js';
import { can } from '../role-core.js';
import type { Write } from '../firestore-rest.js';
import { formatDateLong, formatTime } from '../time.js';
import { t } from './i18n.js';
import { UserError } from './context.js';
import { common, defineTool, render, type ToolContext } from './registry.js';
import { clip } from './shared.js';

/**
 * Baby's settings, as the app keeps them: the contraction timer's instructions from the provider
 * (`babyContractionSettings/main`) and the kick counter's target and daily reminder
 * (`babyKickSettings/main`). Admins and members change them; helpers read them; kids have neither.
 * The limits and the kick reminder are `../baby-settings`, which Baby uses too.
 */
const HHMM = KICK_REMIND_AT;

const babyUrl = (ctx: ToolContext, tab: 'contractions' | 'kicks') => ctx.session.link('baby', `#${tab}`);

interface Settings {
  contractions: { note: string; updatedAt?: number; updatedBy?: string };
  kicks: { target: number; remindAt?: string; updatedAt?: number; updatedBy?: string };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

async function loadSettings(ctx: ToolContext): Promise<Settings> {
  if (ctx.here.role === 'kid') throw new UserError('baby.noKids');
  const base = `households/${ctx.here.id}`;
  const [c, k] = await Promise.all([ctx.session.db.get(`${base}/babyContractionSettings/main`), ctx.session.db.get(`${base}/babyKickSettings/main`)]);
  const cd = c?.data ?? {};
  const kd = k?.data ?? {};
  const remindAt = str(kd.remindAt);
  return {
    contractions: { note: typeof cd.note === 'string' ? cd.note : '', ...stamp(cd) },
    kicks: { target: clampKickTarget(num(kd.target) ?? DEFAULT_KICK_TARGET), ...(remindAt && HHMM.test(remindAt) ? { remindAt } : {}), ...stamp(kd) },
  };
}

const stamp = (d: Record<string, unknown>) => ({ ...(num(d.updatedAt) ? { updatedAt: num(d.updatedAt) } : {}), ...(str(d.updatedBy) ? { updatedBy: str(d.updatedBy) } : {}) });

function mayChange(ctx: ToolContext): void {
  if (ctx.here.role === 'kid') throw new UserError('baby.noKids');
  if (!can(ctx.here.role, 'change-settings')) throw new UserError('baby.settingsStaff');
}

/** "7:00 PM" for "19:00", in the current language. Call inside `render`. */
const clockWords = (hhmm: string) => formatTime(Date.parse(`2000-01-01T${hhmm}:00Z`));

/** "(saved Oct 3, 2031 by sam@example.com)". Call inside `render`. */
const savedWords = (ctx: ToolContext, s: { updatedAt?: number; updatedBy?: string }) =>
  s.updatedAt ? ` ${t('baby.saved', { date: formatDateLong(ctx.clock.local(s.updatedAt)), who: s.updatedBy ?? '-' })}` : '';

export const babySettings = defineTool({
  name: 'baby_settings',
  title: "Baby's settings",
  description:
    "Baby's settings: the instructions from the provider (labor and delivery, the midwife) shown on the contraction timer, such as when to call or come in, and the kick counter's target (movements to count, default 10) and daily reminder time. Admins, members and helpers read them; kids have neither.",
  kind: 'read',
  input: { ...common },
  async run(ctx) {
    const s = await loadSettings(ctx);
    ctx.touched('baby');
    return render(ctx.lang, () => {
      const lines = [`**${t('baby.settingsTitle')}** · ${ctx.here.name}`, ''];
      lines.push(s.contractions.note ? `- ${t('baby.note', { note: s.contractions.note })}${savedWords(ctx, s.contractions)}` : `- ${t('baby.noNote')}`);
      lines.push(`- ${t('baby.kicks', { target: s.kicks.target })} ${s.kicks.remindAt ? t('baby.kicksRemind', { time: clockWords(s.kicks.remindAt) }) : t('baby.kicksNoRemind')}${savedWords(ctx, s.kicks)}`);
      lines.push('', t('baby.link', { url: babyUrl(ctx, 'contractions') }));
      const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);
      return {
        text: lines.join('\n'),
        data: {
          household: ctx.here.id,
          contraction_note: s.contractions.note,
          contraction_note_updated_at: iso(s.contractions.updatedAt),
          contraction_note_updated_by: s.contractions.updatedBy ?? null,
          kick_target: s.kicks.target,
          kick_remind_at: s.kicks.remindAt ?? null,
          kick_settings_updated_at: iso(s.kicks.updatedAt),
          kick_settings_updated_by: s.kicks.updatedBy ?? null,
        },
      };
    });
  },
});

export const babySetContractionNote = defineTool({
  name: 'baby_set_contraction_note',
  title: 'Set the contraction timer instructions',
  description: `Saves the instructions from the provider (labor and delivery, the midwife) that Baby's contraction timer shows, such as "Call when contractions are 5 minutes apart, 1 minute long, for 1 hour", as this person: admins and members (helpers and kids can't). Replaces what is there; an empty note clears it. At most ${BABY_SETTINGS_LIMITS.contractionNote} characters. Read the current one with \`baby_settings\` first when adding to it.`,
  kind: 'write',
  input: { ...common, note: z.string().max(BABY_SETTINGS_LIMITS.contractionNote).describe('The instructions, in their words. Empty clears them.') },
  async run(ctx, args) {
    mayChange(ctx);
    const note = clip(args.note, BABY_SETTINGS_LIMITS.contractionNote);
    const now = Math.round(ctx.clock.now());
    await ctx.session.db.commit([{ path: `households/${ctx.here.id}/babyContractionSettings/main`, set: { note, updatedAt: now, updatedBy: ctx.session.email } }]);
    ctx.touched('baby', 'babyContractionSettings/main');
    const url = babyUrl(ctx, 'contractions');
    return render(ctx.lang, () => ({ text: note ? t('baby.noteSaved', { note, url }) : t('baby.noteCleared', { url }), data: { household: ctx.here.id, contraction_note: note } }));
  },
});

export const babySetKickSettings = defineTool({
  name: 'baby_set_kick_settings',
  title: 'Set the kick counter',
  description: `Changes Baby's kick counter, as this person: admins and members (helpers and kids can't). \`target\`: how many movements a count runs to (${BABY_SETTINGS_LIMITS.kickTargetMin} to ${BABY_SETTINGS_LIMITS.kickTargetMax}, Baby's default ${DEFAULT_KICK_TARGET}). \`remind_at\`: the daily reminder time ("HH:MM", local) or "off". Only the fields given change. A new reminder time schedules the next ${KICK_REMIND_DAYS} days' reminders, in the person's time zone, to everyone's devices with notifications on; each is skipped once that day's count has started.`,
  kind: 'write',
  input: {
    ...common,
    target: z.number().int().min(BABY_SETTINGS_LIMITS.kickTargetMin).max(BABY_SETTINGS_LIMITS.kickTargetMax).optional().describe('Movements to count.'),
    remind_at: z
      .string()
      .regex(/^(([01]\d|2[0-3]):[0-5]\d|off)$/)
      .optional()
      .describe('Daily reminder, "HH:MM" in local time (24-hour), or "off".'),
  },
  async run(ctx, args) {
    mayChange(ctx);
    if (args.target === undefined && args.remind_at === undefined) throw new UserError('baby.kicksNothing');
    const old = (await loadSettings(ctx)).kicks;
    const target = args.target ?? old.target;
    const remindAt = args.remind_at === undefined ? old.remindAt : args.remind_at === 'off' ? undefined : args.remind_at;
    const now = Math.round(ctx.clock.now());
    const base = `households/${ctx.here.id}`;
    const writes: Write[] = [{ path: `${base}/babyKickSettings/main`, set: { target, ...(remindAt ? { remindAt } : {}), updatedAt: now, updatedBy: ctx.session.email } }];
    if (remindAt !== old.remindAt) {
      const today = ctx.clock.today();
      const at = (ymd: string, hhmm: string) => ctx.clock.utc(Date.parse(`${ymd}T${hhmm}:00Z`));
      const wanted = await localizeReminders(
        () => kickReminders(remindAt, { today, now, at, url: babyUrl(ctx, 'kicks'), title: t('baby.kickReminderTitle'), body: t('baby.kickReminderBody') }),
        { household: ctx.here, writer: ctx.lang },
      );
      const existing = await ctx.session.db.query(base, 'reminders', { where: [{ field: 'app', op: 'EQUAL', value: 'baby' }] });
      const plan = kickReminderPlan(existing.map((d) => toReminder(d.id, d.data)), wanted, ctx.session.email, now);
      for (const id of plan.remove) writes.push({ path: `${base}/reminders/${id}`, delete: true });
      for (const [id, doc] of plan.set) writes.push({ path: `${base}/reminders/${id}`, set: doc as unknown as Record<string, unknown> });
    }
    await ctx.session.db.commit(writes);
    ctx.touched('baby', 'babyKickSettings/main');
    const url = babyUrl(ctx, 'kicks');
    return render(ctx.lang, () => ({
      text: `${t('baby.kicksSaved', { target })} ${remindAt ? t('baby.kicksRemind', { time: clockWords(remindAt) }) : t('baby.kicksNoRemind')} [Baby](${url})`,
      data: { household: ctx.here.id, kick_target: target, kick_remind_at: remindAt ?? null, time_zone: ctx.clock.timeZone },
    }));
  },
});
