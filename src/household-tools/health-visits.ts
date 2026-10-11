import { z } from 'zod';
import { toContact, type Contact } from '../contact-core.js';
import { agendaId, localizeAgenda, PERSONAL_AGENDA, personalAgendaDoc } from '../agenda-core.js';
import { localizeReminders, PERSONAL_REMINDERS, personalReminderDoc, reminderId } from '../reminder-core.js';
import { formatDateLong, formatTime } from '../time.js';
import {
  DEFAULT_REMIND_BEFORE, FOLLOW_UP_UNITS, visitRecipients, guessVisitKind, leadWords, toVisit, VISIT_KINDS, VISIT_LIMITS, VISIT_NOTES, VISITS, visitAgendaItem, visitDoc, visitKindLabel, visitNoteDoc,
  visitReminders, visitState, visitTitle, type PublishVisitOptions, type Visit,
} from '../visit.js';
import { personAudience } from '../audience.js';
import { t } from './i18n.js';
import { UserError } from './context.js';
import { common, defineTool, render, type ToolContext } from './registry.js';
import { clip, pick } from './shared.js';
import { create } from './home.js';
import { keeps, loadConditions, loadPeople, readsConditions, type Person } from './health-data.js';
import { specialtyLabel, type Specialty } from '../condition.js';

/**
 * Health's visits (`../visit`), as this person may read and write them: every
 * reader of the person reads them (admins, carers, the person), keepers (admins and member carers)
 * also the notes. `add_appointment` with `app: "health"` adds one here and publishes it as Health
 * would, so it is on the calendars and reminds before anyone opens Health.
 */

export { keeps };

const audienceOf = (ctx: ToolContext, p: Person) => personAudience(p, ctx.here);
const recipientsOf = (ctx: ToolContext, p: Person) => visitRecipients(p, ctx.here);

export const visitUrl = (ctx: ToolContext, v: Pick<Visit, 'id' | 'personId'>) =>
  ctx.session.link('health', `?tab=visits&person=${encodeURIComponent(v.personId)}&visit=${encodeURIComponent(v.id)}`);

async function healthContacts(ctx: ToolContext): Promise<Contact[]> {
  const docs = await ctx.session.openRecords(ctx.here, 'contacts', true).catch(() => []);
  return docs.map((d) => toContact(d.id, d.data));
}

const contactOf = (contacts: Contact[], id?: string) => (id ? contacts.find((c) => c.id === id) : undefined);

function publishOptions(ctx: ToolContext, p: Person, v: Visit, contacts: Contact[]): PublishVisitOptions {
  const c = contactOf(contacts, v.contactId);
  return {
    person: { id: p.id, name: p.name },
    audience: audienceOf(ctx, p),
    household: ctx.here,
    url: visitUrl(ctx, v),
    local: (at) => ctx.clock.local(at),
    ...(c ? { contact: { name: c.name, ...(c.address ? { address: c.address } : {}), private: c.private } } : {}),
  };
}

export interface HealthVisitArgs {
  person?: string;
  title: string;
  at: number;
  allDay: boolean;
  minutes?: number;
  location?: string;
  notes?: string;
  kind?: (typeof VISIT_KINDS)[number];
  doctor?: string;
  videoLink?: string;
  prep?: string[];
  medList?: boolean;
  remindBefore?: number[];
  followUp?: { every: number; unit: (typeof FOLLOW_UP_UNITS)[number] };
  /** The medical area it is with. */
  specialty?: Specialty;
  /** The person's condition it is about, by name or id (only for those who may read conditions). */
  condition?: string;
}

/**
 * Adds a visit for someone in Health as this person (`by`, `via: assistant`), its notes when they
 * keep them, and what Health publishes for it: the agenda item and the reminders, for the person's
 * audience. Health's own sync keeps them current after that (same ids).
 */
export async function addHealthVisit(ctx: ToolContext, id: string, args: HealthVisitArgs): Promise<{ person: Person; visit: Visit; url: string; repeated: boolean }> {
  if (!args.person) throw new UserError('health.whichPerson');
  if (ctx.here.role === 'kid') throw new UserError('health.noKids');
  const people = await loadPeople(ctx);
  const { found: person } = pick(people, args.person, (p) => p.id, (p) => p.name);
  if (!person) throw new UserError('health.unknownPerson', { name: args.person, people: people.map((p) => p.name).join(', ') || '-' });
  if (args.notes && !keeps(ctx, person)) throw new UserError('visits.notesKeepersOnly');
  if (args.videoLink && !/^https:\/\/\S+$/i.test(args.videoLink)) throw new UserError('error.badLink');
  let conditionId: string | undefined;
  const specialty = args.specialty;
  if (args.condition) {
    if (!readsConditions(ctx, person)) throw new UserError('conditions.keepersOnly');
    const conditions = await loadConditions(ctx, person);
    const { found } = pick(conditions, args.condition, (c) => c.id, (c) => c.name);
    if (!found) throw new UserError('conditions.unknown', { name: args.condition, conditions: conditions.map((c) => c.name).join(', ') || '-' });
    // The condition's area is not copied onto the visit: helper carers read the visit's area.
    conditionId = found.id;
  }
  const contacts = await healthContacts(ctx);
  let contactId: string | undefined;
  if (args.doctor) {
    const { found } = pick(contacts, args.doctor, (c) => c.id, (c) => c.name);
    if (!found) throw new UserError('health.unknownContact', { name: args.doctor });
    contactId = found.id;
  }
  const now = ctx.clock.now();
  const base = `households/${ctx.here.id}/healthPeople/${person.id}`;
  const doc = visitDoc(
    {
      personId: person.id,
      kind: args.kind ?? guessVisitKind(`${args.title} ${args.location ?? ''}`),
      title: args.title,
      at: args.at,
      ...(args.allDay ? { allDay: true } : { minutes: args.minutes }),
      contactId,
      location: args.location,
      link: args.videoLink,
      prep: args.prep,
      medList: args.medList,
      conditionId,
      specialty,
      remindBefore: args.remindBefore ?? DEFAULT_REMIND_BEFORE,
      followUp: args.followUp,
    },
    { createdAt: now, by: ctx.session.email },
    ctx.session.via.via,
  );
  const repeated = await create(ctx, `${base}/${VISITS}/${id}`, doc as unknown as Record<string, unknown>);
  const notes = clip(args.notes, VISIT_LIMITS.notes);
  if (!repeated && notes) await create(ctx, `${base}/${VISIT_NOTES}/${id}`, visitNoteDoc(person.id, notes, ctx.session.email, now, ctx.session.via.via) as unknown as Record<string, unknown>);
  const visit: Visit = { id, ...doc };
  await publish(ctx, person, visit, contacts);
  ctx.touched('health', `healthPeople/${person.id}/${VISITS}/${id}`);
  return { person, visit, url: visitUrl(ctx, visit), repeated };
}

/** The visit's agenda item and reminders, in its readers' languages, as Health writes them (the same ids, so its sync finds them unchanged). */
async function publish(ctx: ToolContext, person: Person, visit: Visit, contacts: Contact[]): Promise<void> {
  const me = ctx.session.email;
  const options = publishOptions(ctx, person, visit, contacts);
  if (!options.audience.includes(me)) return;
  const now = ctx.clock.now();
  const base = `households/${ctx.here.id}`;
  // In the writer's language, with `texts` for the readers' others (`../reader-langs`).
  const localize = { household: ctx.here, writer: ctx.lang };
  const [item] = await localizeAgenda(() => [visitAgendaItem(visit, options)], localize);
  const reminders = await localizeReminders(() => visitReminders(visit, { ...options, recipients: recipientsOf(ctx, person), now }), localize);
  await ctx.session.db.commit([
    { path: `${base}/${PERSONAL_AGENDA}/${agendaId('health', item.ref, item.start)}`, set: personalAgendaDoc('health', item, me, now) as unknown as Record<string, unknown> },
    ...reminders.map((r) => ({ path: `${base}/${PERSONAL_REMINDERS}/${r.id ?? reminderId(r.ref ?? 'health', r.at)}`, set: personalReminderDoc({ ...r, app: 'health' }, me, now) as unknown as Record<string, unknown> })),
  ]);
}

// ---- health_appointments ----

const when = (ctx: ToolContext, v: Visit) => (v.allDay ? formatDateLong(ctx.clock.local(v.at)) : `${formatDateLong(ctx.clock.local(v.at))} ${formatTime(ctx.clock.local(v.at))}`);

export const healthAppointments = defineTool({
  name: 'health_appointments',
  title: "A person's visits in Health",
  description:
    "The doctor's, dentist's, eye, lab, vaccine and therapy appointments (visits) of the people this person looks after in Huishouden Health: coming up, and past ones with whether they went (attended or missed). Each has its kind, time, doctor or clinic, place or video link, what to do or bring, reminders and follow-up; its medical area (every reader, helper carers included); the condition it is about only for admins and member carers (the person too, when a member), and the notes only for admins and member carers (helper carers never get either). Leave out `person` for everyone.",
  kind: 'read',
  health: true,
  input: {
    ...common,
    person: z.string().min(1).max(60).optional().describe('Person by name or id, from `health_people`. Leave out for everyone.'),
    days_back: z.number().int().min(0).max(730).optional().describe('Past visits from this many days ago. Default 90.'),
    days_ahead: z.number().int().min(1).max(730).optional().describe('Visits up to this many days ahead. Default 365.'),
  },
  async run(ctx, args) {
    if (ctx.here.role === 'kid') throw new UserError('health.noKids');
    const all = await loadPeople(ctx);
    let people = all;
    if (args.person) {
      const { found } = pick(all, args.person, (p) => p.id, (p) => p.name);
      if (!found) throw new UserError('health.unknownPerson', { name: args.person, people: all.map((p) => p.name).join(', ') || '-' });
      people = [found];
    }
    ctx.touched('health');
    const now = ctx.clock.now();
    const from = now - (args.days_back ?? 90) * 86_400_000;
    const to = now + (args.days_ahead ?? 365) * 86_400_000;
    const contacts = await healthContacts(ctx);
    const lists = await Promise.all(
      people.map(async (p) => {
        const under = `households/${ctx.here.id}/healthPeople/${p.id}`;
        const visits = (await ctx.session.db.query(under, VISITS)).map((d) => toVisit(d.id, d.data, p.id)).filter((v) => v.at >= from && v.at <= to);
        const notes = keeps(ctx, p) ? new Map((await ctx.session.db.query(under, VISIT_NOTES).catch(() => [])).map((d) => [d.id, String(d.data.text ?? '')])) : new Map<string, string>();
        // The condition a visit is about, by name, only for those who may read conditions.
        const conditions = new Map((await loadConditions(ctx, p).catch(() => [])).map((c) => [c.id, c.name]));
        return { person: p, visits: visits.sort((a, b) => a.at - b.at), notes, conditions };
      }),
    );
    return render(ctx.lang, () => {
      const rows = lists.flatMap(({ person, visits, notes, conditions }) =>
        visits.map((v) => {
          const c = contactOf(contacts, v.contactId);
          const state = visitState(v, now);
          const note = notes.get(v.id);
          const condition = v.conditionId ? conditions.get(v.conditionId) : undefined;
          const fact = {
            id: v.id,
            person: { id: person.id, name: person.name },
            kind: v.kind,
            kind_label: visitKindLabel(v.kind),
            title: visitTitle(v),
            ...(v.specialty ? { specialty: v.specialty, specialty_label: specialtyLabel(v.specialty) } : {}),
            ...(condition ? { condition: { id: v.conditionId, name: condition } } : {}),
            start: ctx.clock.isoLocal(v.at),
            all_day: !!v.allDay,
            ...(v.allDay ? {} : { minutes: v.minutes ?? 60 }),
            state,
            ...(c ? { doctor: { id: c.id, name: c.name, phone: c.phone, address: c.address, role: c.role } } : v.contactId ? { doctor: { id: v.contactId } } : {}),
            ...(v.location ? { location: v.location } : {}),
            ...(v.link ? { video_link: v.link } : {}),
            prep: v.prep ?? [],
            bring_medicine_list: !!v.medList,
            reminders: v.remindBefore.map(leadWords),
            ...(v.followUp ? { follow_up: v.followUp, follow_up_done: !!v.followUpDoneAt } : {}),
            ...(v.markedBy ? { marked_by: v.markedBy } : {}),
            ...(note ? { notes: note } : {}),
            url: visitUrl(ctx, v),
          };
          const bits = [visitKindLabel(v.kind), v.specialty ? specialtyLabel(v.specialty) : '', condition ?? '', when(ctx, v), c?.name ?? '', v.location ?? c?.address ?? '', v.link ? t('visits.video') : '', ...(v.prep ?? []), v.medList ? t('visits.medList') : '', t(`visits.state.${state}`)].filter(Boolean);
          const line = `- **[${fact.title}](${fact.url})** (${person.name}) · ${bits.join(' · ')}${note ? ` · ${t('visits.notes', { notes: note })}` : ''} · id \`${v.id}\``;
          return { fact, line };
        }),
      );
      return {
        text: [`**${t('visits.title')}** · ${ctx.here.name}`, '', ...(rows.length ? rows.map((r) => r.line) : [t(people.length ? 'visits.none' : 'health.nobody')])].join('\n'),
        data: { household: ctx.here.id, visits: rows.map((r) => r.fact) },
      };
    });
  },
});
