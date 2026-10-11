import { z } from 'zod';
import { addDays, atTime, daysBetween, dueText, formatTime, toYmd, type Ymd } from '../time.js';
import { formatList } from '../i18n.js';
import { OUTING_LIMITS, outingId, outingSlots, type OutingPlanLike, type OutingSlotTime } from '../pet-outings.js';
import { addInterval, type Unit } from '../schedule.js';
import { t } from './i18n.js';
import { UserError } from './context.js';
import type { Doc } from '../firestore-rest.js';
import { common, defineTool, idempotency, render, type ToolContext } from './registry.js';
import { alreadyThere, clip, pick, recordId } from './shared.js';
import { choosePet, num, petUrl, str, toPets, type Pet } from './pet-data.js';

/**
 * Huishouden Pet, read and written as the app does (pet src/lib: today.ts, feeding.ts,
 * schedule.ts, courses.ts; src/lib/build.ts for the documents). Days are the person's local days:
 * every time is moved into the local frame (../clock) before the kit's day logic reads it.
 */

interface Meal {
  id: string;
  petId: string;
  name: string;
  time: string;
  food?: string;
  portion?: string;
}
interface Reminder {
  id: string;
  petId: string;
  kind: string;
  title: string;
  every?: number;
  unit?: Unit;
  due: Ymd;
  lastDoneAt?: number;
  dismissedAt?: number;
}
interface Course {
  id: string;
  petId: string;
  name: string;
  dose: string;
  times: string[];
  startDate: Ymd;
  days: number;
  withFood: boolean;
}


const MED_KINDS = ['flea-tick', 'heartworm', 'deworming', 'medication'];

interface PetData {
  pets: Pet[];
  meals: Meal[];
  feedings: Doc[];
  reminders: Reminder[];
  courses: Course[];
  medDoses: Doc[];
}

async function load(ctx: ToolContext, sinceLocalDay: Ymd): Promise<PetData> {
  const base = `households/${ctx.here.id}`;
  const db = ctx.session.db;
  // Feeds and doses of the last two days are all "today" needs (absolute ms, a day's margin for zones).
  const since = ctx.clock.utc(Date.parse(`${addDays(sinceLocalDay, -1)}T00:00:00Z`));
  const [pets, meals, feedings, reminders, courses, medDoses] = await Promise.all([
    db.query(base, 'petProfiles'),
    db.query(base, 'petMeals'),
    db.query(base, 'petFeedings', { where: [{ field: 'at', op: 'GREATER_THAN_OR_EQUAL', value: since }] }),
    db.query(base, 'petReminders'),
    db.query(base, 'petMedCourses'),
    db.query(base, 'petMedDoses', { where: [{ field: 'at', op: 'GREATER_THAN_OR_EQUAL', value: since }] }),
  ]);
  return {
    pets: toPets(pets),
    meals: meals
      .map((d) => ({ id: d.id, petId: String(d.data.petId), name: String(d.data.name ?? ''), time: String(d.data.time ?? '00:00'), food: str(d.data.food), portion: str(d.data.portion) }))
      .sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name)),
    feedings,
    reminders: reminders.map((d) => ({
      id: d.id,
      petId: String(d.data.petId),
      kind: String(d.data.kind ?? 'other'),
      title: String(d.data.title ?? ''),
      every: num(d.data.every),
      unit: str(d.data.unit) as Unit | undefined,
      due: String(d.data.due ?? ''),
      lastDoneAt: num(d.data.lastDoneAt),
      dismissedAt: num(d.data.dismissedAt),
    })),
    courses: courses.map((d) => ({
      id: d.id,
      petId: String(d.data.petId),
      name: String(d.data.name ?? ''),
      dose: String(d.data.dose ?? ''),
      times: [...new Set(Array.isArray(d.data.times) ? (d.data.times as string[]) : [])].sort().slice(0, 6),
      startDate: String(d.data.startDate ?? ''),
      days: num(d.data.days) ?? 0,
      withFood: d.data.withFood === true,
    })),
    medDoses,
  };
}

const isRecurring = (r: Pick<Reminder, 'every' | 'unit'>) => !!r.unit && typeof r.every === 'number' && r.every >= 1;
function leadDays(r: Pick<Reminder, 'every' | 'unit'>): number {
  if (r.unit === 'year') return 30;
  if (r.unit === 'day' || (r.unit === 'week' && (r.every ?? 1) === 1)) return 2;
  return 7;
}
type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'done' | 'dismissed';
function reminderState(r: Reminder, today: Ymd): DueState {
  if (r.dismissedAt !== undefined) return 'dismissed';
  if (!isRecurring(r) && r.lastDoneAt !== undefined) return 'done';
  const days = daysBetween(today, r.due);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return days <= leadDays(r) ? 'soon' : 'later';
}

/** Each meal of `day` for a pet: fed (the latest feed for it that day) or due / late. Local frame. */
function mealsOn(ctx: ToolContext, data: PetData, petId: string, day: Ymd, localNow: number) {
  const fed = data.feedings.filter((f) => f.data.petId === petId && typeof f.data.mealId === 'string' && toYmd(ctx.clock.local(Number(f.data.at))) === day);
  return data.meals
    .filter((m) => m.petId === petId)
    .map((meal) => {
      const last = fed.filter((f) => f.data.mealId === meal.id).sort((a, b) => Number(b.data.at) - Number(a.data.at))[0];
      const at = atTime(day, meal.time);
      return { meal, at, state: last ? ('fed' as const) : localNow > at ? ('late' as const) : ('due' as const), fedAt: last ? ctx.clock.local(Number(last.data.at)) : undefined, by: last ? String(last.data.by ?? '') : undefined };
    });
}

/** A course's slots on `day`: given, skipped, missed or due. Local frame. */
function courseSlots(ctx: ToolContext, data: PetData, course: Course, day: Ymd, localNow: number) {
  const n = daysBetween(course.startDate, day) + 1;
  if (n < 1 || n > course.days) return [];
  const doses = data.medDoses.filter((d) => d.data.courseId === course.id && toYmd(ctx.clock.local(Number(d.data.at))) === day);
  return course.times.map((time, slot) => {
    const mine = doses.filter((d) => d.data.slot === slot).sort((a, b) => Number(b.data.at) - Number(a.data.at));
    const given = mine.find((d) => d.data.skipped !== true);
    const at = atTime(day, time);
    const state = given ? ('given' as const) : mine.length ? ('skipped' as const) : localNow > at ? ('missed' as const) : ('due' as const);
    return { slot, time, at, state };
  });
}


// ---- Outings (bathroom breaks): the slots and ids from ../pet-outings, shared with Pet ----

/** petOutingPlans/{petId} as this tool reads it (only plans that are on). */
interface OutingPlan extends OutingPlanLike {
  poopMin: number;
  walkGoal: number;
}

/** One scheduled outing of a day, named as Pet names it: the meal's name, or the time. */
interface OutingSlot extends OutingSlotTime {
  label: string;
}

/** How many days of outings the tool reads: today and two weeks back, for the days under the minimum. */
const OUTING_DAYS = 15;

async function loadOutings(ctx: ToolContext, today: Ymd): Promise<{ plans: OutingPlan[]; outings: Doc[] }> {
  const base = `households/${ctx.here.id}`;
  const since = ctx.clock.utc(Date.parse(`${addDays(today, -OUTING_DAYS)}T00:00:00Z`));
  const [plans, outings] = await Promise.all([
    ctx.session.db.query(base, 'petOutingPlans'),
    ctx.session.db.query(base, 'petOutings', { where: [{ field: 'at', op: 'GREATER_THAN_OR_EQUAL', value: since }] }),
  ]);
  return {
    plans: plans
      .filter((d) => d.data.on === true)
      .map((d) => ({
        petId: d.id,
        mode: d.data.mode === 'times' || d.data.mode === 'every' ? d.data.mode : 'meals',
        times: Array.isArray(d.data.times) ? (d.data.times as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        every: num(d.data.every),
        from: str(d.data.from),
        to: str(d.data.to),
        poopMin: Math.min(OUTING_LIMITS.poopMin, Math.max(0, num(d.data.poopMin) ?? 0)),
        walkGoal: Math.max(0, num(d.data.walkGoal) ?? 0),
      })),
    outings,
  };
}

/** A pet's scheduled outings, labelled: the meal's name, or the time in the person's words. */
function slotsOf(plan: OutingPlan, meals: Meal[]): OutingSlot[] {
  return outingSlots(plan, meals).map((s) => ({ ...s, label: s.meal ?? formatTime(atTime('2031-01-01', s.time)) }));
}

/** A pet's outings on a local day. Local frame. */
function outingsOn(ctx: ToolContext, outings: Doc[], petId: string, day: Ymd) {
  return outings.filter((o) => o.data.petId === petId && toYmd(ctx.clock.local(Number(o.data.at))) === day);
}

const poopsIn = (list: Doc[]) => list.filter((o) => o.data.poop === true).length;
const walkIn = (list: Doc[]) => list.reduce((n, o) => n + (num(o.data.walkMin) ?? 0), 0);

/** Each slot of `day`: done (the outing logged for it), or due / late. Local frame. */
function slotStates(ctx: ToolContext, plan: OutingPlan, meals: Meal[], outings: Doc[], day: Ymd, localNow: number) {
  const that = outingsOn(ctx, outings, plan.petId, day);
  return slotsOf(plan, meals).map((slot) => {
    const at = atTime(day, slot.time);
    const id = outingId(plan.petId, day, slot.key);
    const done = that.find((o) => o.id === id) ?? that.filter((o) => o.data.slot === slot.key).sort((a, b) => Number(b.data.at) - Number(a.data.at))[0];
    return { slot, at, outing: done, state: done ? ('done' as const) : localNow > at ? ('late' as const) : ('due' as const) };
  });
}

/** Days in a row, ending yesterday, with outings logged and fewer poops than the minimum (days with none logged break the run). */
function underDays(ctx: ToolContext, plan: OutingPlan, outings: Doc[], today: Ymd): number {
  if (!plan.poopMin) return 0;
  let n = 0;
  for (let d = 1; d < OUTING_DAYS; d++) {
    const list = outingsOn(ctx, outings, plan.petId, addDays(today, -d));
    if (!list.length || poopsIn(list) >= plan.poopMin) break;
    n++;
  }
  return n;
}

/** How an outing went, as one of `pet.outingSlot*`'s shapes. */
const howOf = (o: Doc) => (o.data.poop === true ? 'pooped' : o.data.pee === true ? 'pee' : 'out');

/** A pet's outings today: each slot's state, the poops against the minimum, the walk, and days under it. */
function outingSummary(ctx: ToolContext, plan: OutingPlan, meals: Meal[], outings: Doc[], today: Ymd, localNow: number) {
  const slots = slotStates(ctx, plan, meals, outings, today, localNow);
  const todays = outingsOn(ctx, outings, plan.petId, today);
  return { slots, extra: todays.filter((o) => typeof o.data.slot !== 'string').length, poops: poopsIn(todays), walked: walkIn(todays), under: underDays(ctx, plan, outings, today) };
}

/** The summary's line, each part one whole message, joined as a list in the person's language. */
function outingLine(ctx: ToolContext, plan: OutingPlan, s: ReturnType<typeof outingSummary>): string {
  const parts = [
    plan.poopMin ? t('pet.outingPoops', { n: s.poops, min: plan.poopMin }) : t('pet.outingPoopsNoMin', { n: s.poops }),
    ...(plan.walkGoal ? [t('pet.walkGoal', { n: s.walked, goal: plan.walkGoal })] : s.walked ? [t('pet.walked', { n: s.walked })] : []),
    ...s.slots.map((x) =>
      x.outing
        ? t(`pet.outingSlot.${howOf(x.outing)}`, { slot: x.slot.label, time: formatTime(ctx.clock.local(Number(x.outing.data.at))), who: String(x.outing.data.by ?? '') })
        : t(x.state === 'late' ? 'pet.outingSlotLate' : 'pet.outingSlotDue', { slot: x.slot.label, time: formatTime(x.at) }),
    ),
    ...(s.under ? [t('pet.underDays', { n: s.under })] : []),
  ];
  return t('pet.outingsLine', { parts: formatList(parts) });
}

export const petToday = defineTool({
  name: 'pet_today',
  title: "Pets today",
  description:
    "Each pet's day in Huishouden Pet: meals on the feeding board (fed, due or late, and by whom), care reminders overdue, due today or coming up (flea and tick, heartworm, vaccines…), today's medicine-course doses, and for pets whose outings are tracked, today's bathroom breaks (each scheduled outing done, due or late; poops against the daily minimum; days in a row under it; walk minutes). Meal, reminder, course and outing names are what `pet_log_feeding`, `pet_log_dose` and `pet_log_outing` take.",
  kind: 'read',
  input: { ...common, pet: z.string().max(60).optional().describe('One pet by name or id. Default all.') },
  async run(ctx, args) {
    const today = ctx.clock.today();
    const [data, outs] = await Promise.all([load(ctx, today), loadOutings(ctx, today)]);
    const pets = choosePet(data.pets, args.pet);
    const localNow = ctx.clock.localNow();
    ctx.touched('pet');
    return render(ctx.lang, () => {
      const lines = [`**${t('pet.title')}** · ${ctx.here.name}`];
      const out = pets.map((p) => {
        const meals = mealsOn(ctx, data, p.id, today, localNow);
        const reminders = data.reminders
          .filter((r) => r.petId === p.id)
          .map((r) => ({ r, state: reminderState(r, today) }))
          .filter((x) => ['overdue', 'today', 'soon'].includes(x.state))
          .sort((a, b) => a.r.due.localeCompare(b.r.due));
        const courses = data.courses.filter((c) => c.petId === p.id).map((c) => ({ c, slots: courseSlots(ctx, data, c, today, localNow) })).filter((x) => x.slots.length);
        lines.push('', `**[${p.name}](${petUrl(ctx, `?tab=pets&pet=${encodeURIComponent(p.id)}`)})**`);
        for (const m of meals)
          lines.push(
            `- ${t('pet.meal', { name: m.meal.name, time: formatTime(atTime(today, m.meal.time)) })}: ${m.state === 'fed' ? t('pet.fed', { time: formatTime(m.fedAt!), who: m.by ?? '' }) : t(m.state === 'late' ? 'pet.late' : 'pet.due')}${m.meal.portion ? ` · ${m.meal.portion}` : ''}${m.meal.food ? ` ${m.meal.food}` : ''}`,
          );
        for (const { r, state } of reminders) lines.push(`- ${r.title}: ${dueText(r.due, today)}${state === 'overdue' ? ' ⚠' : ''}`);
        for (const { c, slots } of courses) lines.push(`- ${c.name} (${c.dose}): ${slots.map((s) => `${formatTime(s.at)} ${t(`pet.slot.${s.state}`)}`).join(', ')}`);
        const plan = outs.plans.find((x) => x.petId === p.id);
        const sum = plan ? outingSummary(ctx, plan, data.meals, outs.outings, today, localNow) : undefined;
        if (plan && sum) lines.push(`- ${outingLine(ctx, plan, sum)}`);
        if (!meals.length && !reminders.length && !courses.length && !plan) lines.push(`- ${t('pet.nothing')}`);
        return {
          id: p.id,
          name: p.name,
          species: p.species,
          meals: meals.map((m) => ({ id: m.meal.id, name: m.meal.name, time: m.meal.time, state: m.state, ...(m.fedAt ? { fed_at: new Date(m.fedAt).toISOString().slice(11, 16), fed_by: m.by } : {}) })),
          reminders: reminders.map(({ r, state }) => ({ id: r.id, title: r.title, kind: r.kind, due: r.due, state, medicine: MED_KINDS.includes(r.kind) })),
          courses: courses.map(({ c, slots }) => ({ id: c.id, name: c.name, dose: c.dose, slots: slots.map((s) => ({ slot: s.slot, time: s.time, state: s.state })) })),
          ...(plan && sum
            ? {
                outings: {
                  slots: sum.slots.map((s) => ({
                    key: s.slot.key,
                    label: s.slot.label,
                    time: s.slot.time,
                    state: s.state,
                    ...(s.outing
                      ? { pooped: s.outing.data.poop === true, pee: s.outing.data.pee === true, at: new Date(ctx.clock.local(Number(s.outing.data.at))).toISOString().slice(11, 16), by: String(s.outing.data.by ?? '') }
                      : {}),
                  })),
                  extra: sum.extra,
                  poops_today: sum.poops,
                  poop_min: plan.poopMin,
                  under_days: sum.under,
                  walk_minutes_today: sum.walked,
                  walk_goal: plan.walkGoal,
                },
              }
            : {}),
        };
      });
      if (!pets.length) lines.push('', t('pet.none'));
      lines.push('', t('pet.link', { url: petUrl(ctx) }));
      return { text: lines.join('\n'), data: { household: ctx.here.id, date: today, pets: out } };
    });
  },
});

export const petLogFeeding = defineTool({
  name: 'pet_log_feeding',
  title: 'Log a pet feeding',
  description:
    "Records that a pet was fed, as this person, on Huishouden Pet's feeding board. With a `meal` (\"AM\", \"Dinner\") it ticks that meal for today; without one it picks today's next unfed meal, or logs an extra feed when every meal is done.",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    pet: z.string().min(1).max(60).describe('Pet name or id.'),
    meal: z.string().max(40).optional().describe('Meal name or id from `pet_today`.'),
    at: z.string().max(40).optional().describe('When, local "YYYY-MM-DDTHH:MM". Default now.'),
    portion: z.string().max(40).optional(),
    note: z.string().max(200).optional(),
  },
  async run(ctx, args) {
    const today = ctx.clock.today();
    const data = await load(ctx, today);
    const [pet] = choosePet(data.pets, args.pet);
    const when = args.at ? ctx.clock.parse(args.at) : { at: ctx.clock.now(), allDay: false };
    if (!when || when.allDay) throw new UserError('error.badTime', { value: args.at ?? '' });
    if (when.at > ctx.clock.now() + 60_000) throw new UserError('error.future');
    const day = toYmd(ctx.clock.local(when.at));
    const meals = mealsOn(ctx, data, pet.id, day, ctx.clock.local(when.at));
    let meal = undefined as (typeof meals)[number] | undefined;
    if (args.meal) {
      const { found } = pick(meals, args.meal, (m) => m.meal.id, (m) => m.meal.name);
      if (!found) throw new UserError('pet.unknownMeal', { name: args.meal, meals: meals.map((m) => m.meal.name).join(', ') || '-' });
      meal = found;
    } else meal = meals.find((m) => m.state !== 'fed');
    const now = ctx.clock.now();
    const id = await recordId(ctx.session.props.connectionId, 'pet_log_feeding', args.idempotency_key);
    const doc = {
      petId: pet.id,
      ...(meal ? { mealId: meal.meal.id } : {}),
      at: Math.round(when.at),
      ...(clip(args.portion, 40) ? { portion: clip(args.portion, 40) } : {}),
      ...(clip(args.note, 200) ? { note: clip(args.note, 200) } : {}),
      by: ctx.session.email,
      createdAt: now,
      ...ctx.session.via,
    };
    let repeated = false;
    try {
      await ctx.session.db.commit([{ path: `households/${ctx.here.id}/petFeedings/${id}`, create: doc }]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('pet', `petFeedings/${id}`);
    return render(ctx.lang, () => ({
      text: t(meal ? (meal.state === 'fed' ? 'pet.fedAgain' : 'pet.fedMeal') : 'pet.fedExtra', { pet: pet.name, meal: meal?.meal.name ?? '', time: formatTime(ctx.clock.local(when.at)), url: petUrl(ctx) }),
      data: { id, pet: pet.id, meal: meal?.meal.id ?? null, at: ctx.clock.isoLocal(when.at), repeated },
    }));
  },
});

export const petLogDose = defineTool({
  name: 'pet_log_dose',
  title: "Log a pet's medicine",
  description:
    "Records a pet's medicine as given (or skipped), as this person: a care reminder (flea and tick, heartworm, deworming, medication: the next due date moves on as in the app) or a dose of a medicine course (\"1 tablet twice a day for 7 days\"). Kids can't log medicine; helpers only for courses that allow them. Refuses a course slot already given unless `confirm_again`.",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    pet: z.string().min(1).max(60).describe('Pet name or id.'),
    medicine: z.string().min(1).max(80).describe('Care reminder title or medicine course name/id, from `pet_today`.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Course dose time "HH:MM" being answered. Default the one due now.'),
    skipped: z.boolean().optional().describe('Skipped rather than given (courses only).'),
    confirm_again: z.boolean().optional().describe('Log it although that dose was already given today.'),
  },
  async run(ctx, args) {
    if (ctx.here.role === 'kid') throw new UserError('pet.noKids');
    const today = ctx.clock.today();
    const data = await load(ctx, today);
    const [pet] = choosePet(data.pets, args.pet);
    const now = ctx.clock.now();
    const localNow = ctx.clock.localNow();
    const base = `households/${ctx.here.id}`;
    const id = await recordId(ctx.session.props.connectionId, 'pet_log_dose', args.idempotency_key);
    const courses = data.courses.filter((c) => c.petId === pet.id && courseSlots(ctx, data, c, today, localNow).length);
    const reminders = data.reminders.filter((r) => r.petId === pet.id && r.dismissedAt === undefined && MED_KINDS.includes(r.kind));
    const course = pick(courses, args.medicine, (c) => c.id, (c) => c.name).found;
    const reminder = course ? undefined : pick(reminders, args.medicine, (r) => r.id, (r) => r.title).found;
    if (course) {
      const slots = courseSlots(ctx, data, course, today, localNow);
      const slot = args.time ? slots.find((s) => s.time === args.time) : (slots.filter((s) => s.state === 'missed' || s.state === 'due').sort((a, b) => Math.abs(a.at - localNow) - Math.abs(b.at - localNow))[0] ?? slots.find((s) => s.state !== 'given'));
      if (!slot) throw new UserError('pet.noSlot', { name: course.name, times: course.times.join(', ') });
      if (slot.state === 'given' && !args.confirm_again && !args.skipped)
        return render(ctx.lang, () => ({ text: t('pet.alreadyGiven', { name: course.name, time: formatTime(slot.at), pet: pet.name }), data: { written: false, needs_confirmation: true } }));
      const doc = { petId: pet.id, courseId: course.id, slot: slot.slot, at: now, ...(args.skipped ? { skipped: true } : {}), by: ctx.session.email, createdAt: now, ...ctx.session.via };
      let repeated = false;
      try {
        await ctx.session.db.commit([{ path: `${base}/petMedDoses/${id}`, create: doc }]);
      } catch (e) {
        if (!alreadyThere(e)) throw e;
        repeated = true;
      }
      ctx.touched('pet', `petMedDoses/${id}`);
      return render(ctx.lang, () => ({
        text: t(args.skipped ? 'pet.doseSkipped' : 'pet.doseGiven', { name: course.name, pet: pet.name, time: formatTime(slot.at), url: petUrl(ctx, '?tab=care') }),
        data: { id, pet: pet.id, course: course.id, slot: slot.slot, skipped: args.skipped === true, repeated },
      }));
    }
    if (!reminder) throw new UserError('pet.unknownMedicine', { name: args.medicine, options: [...courses.map((c) => c.name), ...reminders.map((r) => r.title)].join(', ') || '-' });
    if (args.skipped) throw new UserError('pet.skipReminder');
    const day = toYmd(localNow);
    const next = isRecurring(reminder) ? addInterval(day, reminder.every!, reminder.unit!) : reminder.due;
    let repeated = false;
    try {
      await ctx.session.db.commit([
        { path: `${base}/petDoses/${id}`, create: { petId: pet.id, reminderId: reminder.id, title: reminder.title.trim().slice(0, 80), at: now, by: ctx.session.email, createdAt: now, ...ctx.session.via } },
        { path: `${base}/petReminders/${reminder.id}`, merge: { lastDoneAt: now, due: next, updatedAt: now } },
      ]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('pet', `petReminders/${reminder.id}`);
    return render(ctx.lang, () => ({
      text: t(isRecurring(reminder) ? 'pet.reminderGiven' : 'pet.reminderDone', { name: reminder.title, pet: pet.name, next: dueText(next, day), url: petUrl(ctx, '?tab=care') }),
      data: { id, pet: pet.id, reminder: reminder.id, next_due: next, repeated },
    }));
  },
});

export const petLogOuting = defineTool({
  name: 'pet_log_outing',
  title: 'Log a pet outing',
  description:
    "Records a bathroom break (or a walk), as this person, for a pet whose outings Huishouden Pet tracks: whether it pooped (it peed unless `pee: false`). Without `slot` it ticks today's scheduled outing closest to the time (one due within 90 minutes or already passed), else logs an extra outing. A walk without bathroom details: `walk_minutes` alone. A slot already logged today is not logged twice. Anyone in the household may log one, kids too.",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    pet: z.string().min(1).max(60).describe('Pet name or id.'),
    pooped: z.boolean().optional().describe('Whether it pooped. Required unless only a walk is logged (`walk_minutes`).'),
    pee: z.boolean().optional().describe('Whether it peed. Default true when `pooped` is given.'),
    slot: z.string().max(40).optional().describe('Scheduled outing name or key from `pet_today` ("Breakfast", "7:00 AM").'),
    at: z.string().max(40).optional().describe('When, local "YYYY-MM-DDTHH:MM". Default now.'),
    walk_minutes: z.number().int().min(1).max(OUTING_LIMITS.walkMin).optional().describe('Walk length, minutes.'),
    note: z.string().max(OUTING_LIMITS.note).optional(),
  },
  async run(ctx, args) {
    if (args.pooped === undefined && args.walk_minutes === undefined) throw new UserError('pet.outingWhat');
    const today = ctx.clock.today();
    const [data, outs] = await Promise.all([load(ctx, today), loadOutings(ctx, today)]);
    const [pet] = choosePet(data.pets, args.pet);
    const when = args.at ? ctx.clock.parse(args.at) : { at: ctx.clock.now(), allDay: false };
    if (!when || when.allDay) throw new UserError('error.badTime', { value: args.at ?? '' });
    if (when.at > ctx.clock.now() + 60_000) throw new UserError('error.future');
    const local = ctx.clock.local(when.at);
    const day = toYmd(local);
    const plan = outs.plans.find((p) => p.petId === pet.id);
    const base = `households/${ctx.here.id}`;
    // The request's own id: an extra outing's document id, and on a slot's outing its `req`, so a
    // retry with the same key finds what the first call wrote, wherever it went.
    const req = await recordId(ctx.session.props.connectionId, 'pet_log_outing', args.idempotency_key);
    const earlier = args.idempotency_key ? outs.outings.find((o) => o.data.petId === pet.id && (o.id === req || o.data.req === req)) : undefined;
    if (earlier) {
      ctx.touched('pet', `petOutings/${earlier.id}`);
      return render(ctx.lang, () => ({
        text: t('pet.outingRepeated', { url: petUrl(ctx) }),
        data: { id: earlier.id, pet: pet.id, slot: typeof earlier.data.slot === 'string' ? earlier.data.slot : null, at: ctx.clock.isoLocal(Number(earlier.data.at)), pooped: earlier.data.poop ?? null, repeated: true },
      }));
    }
    const slots = plan ? slotStates(ctx, plan, data.meals, outs.outings, day, local) : [];
    // A walk on its own never ticks a bathroom slot, even when one is named: it is an extra outing.
    const bathroom = args.pooped !== undefined;
    let slot: (typeof slots)[number] | undefined;
    if (args.slot && bathroom) {
      if (!plan) throw new UserError('pet.noOutings', { pet: pet.name });
      slot = pick(slots, args.slot, (s) => s.slot.key, (s) => s.slot.label).found ?? slots.find((s) => s.slot.time === args.slot || formatTime(s.at) === args.slot);
      if (!slot) throw new UserError('pet.unknownOuting', { name: args.slot, slots: slots.map((s) => s.slot.label).join(', ') || '-' });
    } else if (bathroom) slot = slots.filter((s) => s.state !== 'done' && s.at <= local + 90 * 60_000).sort((a, b) => Math.abs(a.at - local) - Math.abs(b.at - local))[0];
    const now = ctx.clock.now();
    const id = slot ? outingId(pet.id, day, slot.slot.key) : req;
    const note = clip(args.note, OUTING_LIMITS.note);
    const doc = {
      petId: pet.id,
      ...(slot ? { slot: slot.slot.key, ...(args.idempotency_key ? { req } : {}) } : {}),
      at: Math.round(when.at),
      ...(bathroom ? { pee: args.pee ?? true, poop: args.pooped } : {}),
      ...(args.walk_minutes ? { walkMin: args.walk_minutes } : {}),
      ...(note ? { note } : {}),
      by: ctx.session.email,
      createdAt: now,
      ...ctx.session.via,
    };
    let repeated = false;
    try {
      await ctx.session.db.commit([{ path: `${base}/petOutings/${id}`, create: doc }]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('pet', `petOutings/${id}`);
    const poops = poopsIn(outingsOn(ctx, outs.outings, pet.id, day)) + (!repeated && args.pooped ? 1 : 0);
    const min = plan?.poopMin ?? 0;
    const vars = { pet: pet.name, slot: slot?.slot.label ?? '', time: formatTime(local), n: poops, min, minutes: args.walk_minutes ?? 0, url: petUrl(ctx) };
    const how = args.pooped ? ('Pooped' as const) : ('Pee' as const);
    const key = repeated
      ? slot
        ? 'pet.outingAlready'
        : 'pet.outingRepeated'
      : !bathroom
        ? 'pet.walkLogged'
        : (`pet.outing${slot ? ('Logged' as const) : ('Extra' as const)}${how}${min ? ('Min' as const) : ('' as const)}` as const);
    return render(ctx.lang, () => ({
      text: t(key, vars),
      data: { id, pet: pet.id, slot: slot?.slot.key ?? null, at: ctx.clock.isoLocal(when.at), pooped: args.pooped ?? null, poops_today: poops, poop_min: min, repeated },
    }));
  },
});

