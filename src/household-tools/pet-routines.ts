import { z } from 'zod';
import { addDays, daysAgo, daysBetween, dueText, formatTime, inDays, type Ymd } from '../time.js';
import { formatList } from '../i18n.js';
import { describeRule, describeSchedule } from '../schedule.js';
import { ROUTINE_LIMITS, routineLogId, routineRule, routineSchedule, routineStatus, toRoutine, type Routine, type RoutineLogLike } from '../pet-routines.js';
import { t } from './i18n.js';
import { UserError } from './context.js';
import { common, defineTool, idempotency, render, type ToolContext } from './registry.js';
import { alreadyThere, clip, pick } from './shared.js';
import { choosePet, num, petUrl, str, toPets, type Pet } from './pet-data.js';

/** Care routines (scoop the litter box, change the litter...): due days and ids from ../pet-routines, shared with Pet. */

/** How many days of routine logs the tool reads, as Pet does: enough for a routine done every few months. */
const ROUTINE_LOG_DAYS = 400;

async function loadRoutines(ctx: ToolContext, today: Ymd): Promise<{ pets: Pet[]; routines: Routine[]; logs: (RoutineLogLike & { by: string; note?: string })[] }> {
  const base = `households/${ctx.here.id}`;
  const since = ctx.clock.utc(Date.parse(`${addDays(today, -ROUTINE_LOG_DAYS)}T00:00:00Z`));
  const [pets, routines, logs] = await Promise.all([
    ctx.session.db.query(base, 'petProfiles'),
    ctx.session.db.query(base, 'petRoutines'),
    ctx.session.db.query(base, 'petRoutineLogs', { where: [{ field: 'at', op: 'GREATER_THAN_OR_EQUAL', value: since }] }),
  ]);
  return {
    pets: toPets(pets),
    routines: routines
      .map((d) => toRoutine(d.id, d.data))
      .filter((r): r is Routine => r !== null)
      .sort((a, b) => a.name.localeCompare(b.name)),
    logs: logs.map((d) => ({ routineId: String(d.data.routineId ?? ''), due: String(d.data.due ?? ''), on: String(d.data.on ?? ''), at: num(d.data.at), by: String(d.data.by ?? ''), ...(str(d.data.note) ? { note: str(d.data.note) } : {}) })),
  };
}

const petsOf = (r: Routine, pets: Pet[]) => formatList(r.petIds.map((id) => pets.find((p) => p.id === id)?.name).filter((n): n is string => !!n));

/** How a routine repeats, in words. Call inside `render`. */
const routineWords = (r: Routine) => {
  const s = routineSchedule(r);
  return s ? describeSchedule(s) : describeRule(routineRule(r));
};

export const petRoutines = defineTool({
  name: 'pet_routines',
  title: "Pets' care routines",
  description:
    "The household's care routines in Huishouden Pet (scoop the litter box, change the litter, brush, clean the water fountain, change the fish tank water, clean the cage...), each for one or several pets: whether it is overdue, due today, done today (by whom and when) or due later, how it repeats and when it was last done. Routine names are what `pet_routine_done` takes. Set routines up in Pet, on a pet's page.",
  kind: 'read',
  input: { ...common, pet: z.string().max(60).optional().describe('Only the routines of one pet, by name or id.') },
  async run(ctx, args) {
    const today = ctx.clock.today();
    const data = await loadRoutines(ctx, today);
    const only = args.pet ? choosePet(data.pets, args.pet)[0] : undefined;
    const routines = data.routines.filter((r) => !only || r.petIds.includes(only.id));
    ctx.touched('pet');
    return render(ctx.lang, () => {
      const lines = [`**${t('pet.routinesTitle')}** · ${ctx.here.name}`, ''];
      const out = routines.map((r) => {
        const st = routineStatus(r, data.logs, today);
        const when = st.state === 'done' && st.log ? t('pet.routineDoneBy', { time: formatTime(ctx.clock.local(st.log.at ?? 0)), who: st.log.by }) : dueText(st.due, today);
        const last = st.last ? t('pet.routineLast', { when: daysAgo(daysBetween(st.last.on, today)), who: st.last.by }) : t('pet.routineNever');
        lines.push(`- ${r.name} (${petsOf(r, data.pets)}): ${when}${st.state === 'overdue' ? ' ⚠' : ''} · ${routineWords(r)} · ${last}`);
        return {
          id: r.id,
          name: r.name,
          pets: r.petIds.map((id) => ({ id, name: data.pets.find((p) => p.id === id)?.name ?? '' })),
          state: st.state,
          due: st.due,
          days_late: st.late,
          next_due: st.next,
          ...(st.last ? { last_done: st.last.on, last_done_by: st.last.by } : {}),
        };
      });
      if (!routines.length) lines.push(t('pet.noRoutines'));
      lines.push('', t('pet.link', { url: petUrl(ctx) }));
      return { text: lines.join('\n'), data: { household: ctx.here.id, date: today, routines: out } };
    });
  },
});

export const petRoutineDone = defineTool({
  name: 'pet_routine_done',
  title: 'Mark a pet care routine done',
  description:
    "Marks a care routine (\"Litter box\", \"Change litter\", \"Brush Nori\") done today, as this person, with an optional note. It answers the routine's open due day (or the next one when it isn't due yet), so the reminder for it stops and the next due day is counted from today when the routine repeats from when it was last done. Doing it twice the same day writes once. Anyone in the household may, kids too.",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    routine: z.string().min(1).max(ROUTINE_LIMITS.name).describe('Routine name or id from `pet_routines`.'),
    note: z.string().max(ROUTINE_LIMITS.note).optional(),
  },
  async run(ctx, args) {
    const today = ctx.clock.today();
    const data = await loadRoutines(ctx, today);
    const { found, ambiguous } = pick(data.routines, args.routine, (r) => r.id, (r) => r.name);
    if (!found) {
      const names = (ambiguous ?? data.routines).map((r) => `${r.name} (${petsOf(r, data.pets)})`).join(', ') || '-';
      throw new UserError(ambiguous ? 'pet.ambiguousRoutine' : 'pet.unknownRoutine', { name: args.routine, routines: names });
    }
    const st = routineStatus(found, data.logs, today);
    const pets = petsOf(found, data.pets);
    if (st.state === 'done') {
      ctx.touched('pet', `petRoutineLogs/${routineLogId(found.id, st.due)}`);
      return render(ctx.lang, () => ({ text: t('pet.routineAlready', { name: found.name, pets, url: petUrl(ctx) }), data: { id: routineLogId(found.id, st.due), routine: found.id, due: st.due, repeated: true } }));
    }
    const now = ctx.clock.now();
    const id = routineLogId(found.id, st.due);
    const note = clip(args.note, ROUTINE_LIMITS.note);
    const doc = { routineId: found.id, due: st.due, on: today, at: Math.round(now), ...(note ? { note } : {}), by: ctx.session.email, createdAt: now, ...ctx.session.via };
    let repeated = false;
    try {
      await ctx.session.db.commit([{ path: `households/${ctx.here.id}/petRoutineLogs/${id}`, create: doc }]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('pet', `petRoutineLogs/${id}`);
    const after = routineStatus(found, [...data.logs, { routineId: found.id, due: st.due, on: today, at: now }], today);
    return render(ctx.lang, () => ({
      text: t(repeated ? 'pet.routineAlready' : 'pet.routineDone', { name: found.name, pets, next: inDays(daysBetween(today, after.next)), url: petUrl(ctx) }),
      data: { id, routine: found.id, due: st.due, next_due: after.next, repeated },
    }));
  },
});

