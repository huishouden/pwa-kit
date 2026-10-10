import { z } from 'zod';
import type { Contact } from '../contact-core.js';
import {
  CONDITION_LIMITS, CONDITION_SEVERITIES, CONDITION_STATUSES, CONDITIONS, SPECIALTIES, conditionConflicts, conditionDoc, conditionStatusLabel, groupBySpecialty, isPartialDate,
  partialDateWords, severityLabel, specialtyLabel, toCondition, type Condition,
} from '../condition.js';
import { t } from './i18n.js';
import { isDenied, UserError } from './context.js';
import { common, defineTool, idempotency, render, type ToolContext } from './registry.js';
import { alreadyThere, pick, recordId } from './shared.js';
import { choosePerson, contactsById } from './health.js';
import { conditionUrl, keeps, loadConditions, loadMeds, loadPeople, medLabel, readsConditions, type Med, type Person } from './health-data.js';

/**
 * Health's conditions (`../condition`), grouped by medical area, for the people this person may
 * read them for: admins and the members among the person's readers. Helper carers get
 * none (the rules refuse them), and nothing here says that a condition exists.
 */

const specialtyArg = z.enum(SPECIALTIES);
const partialDate = z.string().refine(isPartialDate, 'A year "2019", a month "2019-03" or a day "2019-03-14".');

/** One condition's facts and Markdown line. Call inside `render`. */
export function conditionFacts(ctx: ToolContext, c: Condition, contacts: Map<string, Contact>, meds: readonly Med[]) {
  const doctor = c.doctorId ? contacts.get(c.doctorId) : undefined;
  const clinic = c.clinicId ? contacts.get(c.clinicId) : undefined;
  const treating = (c.medIds ?? []).map((id) => meds.find((m) => m.id === id)).filter((m): m is Med => !!m);
  const fact = {
    id: c.id,
    name: c.name,
    ...(c.icd10 ? { icd10: c.icd10 } : {}),
    specialty: c.specialty,
    specialty_label: specialtyLabel(c.specialty),
    status: c.status,
    ...(c.diagnosed ? { diagnosed: c.diagnosed } : {}),
    ...(c.resolved ? { resolved: c.resolved } : {}),
    ...(c.severity ? { severity: c.severity } : {}),
    ...(doctor ? { diagnosed_by: { id: doctor.id, name: doctor.name, role: doctor.role, phone: doctor.phone } } : c.doctorId ? { diagnosed_by: { id: c.doctorId } } : {}),
    ...(clinic ? { where: { id: clinic.id, name: clinic.name, address: clinic.address } } : c.place ? { where: { name: c.place } } : {}),
    medicines: treating.map((m) => ({ id: m.id, name: medLabel(m) })),
    ...(c.notes ? { notes: c.notes } : {}),
    url: conditionUrl(ctx, c),
  };
  const bits = [
    conditionStatusLabel(c.status),
    c.severity ? severityLabel(c.severity) : '',
    c.icd10 ? `ICD-10 ${c.icd10}` : '',
    c.diagnosed ? t('conditions.diagnosed', { date: partialDateWords(c.diagnosed) }) : '',
    doctor ? t('conditions.by', { name: doctor.name }) : '',
    clinic ? t('conditions.at', { place: clinic.name }) : c.place ? t('conditions.at', { place: c.place }) : '',
    c.resolved ? t('conditions.resolvedOn', { date: partialDateWords(c.resolved) }) : '',
    treating.length ? t('conditions.treatedWith', { meds: treating.map(medLabel).join(', ') }) : '',
  ].filter(Boolean);
  const line = `- **[${c.name}](${fact.url})** · ${bits.join(' · ')}${c.notes ? ` · ${t('visits.notes', { notes: c.notes })}` : ''} · id \`${c.id}\``;
  return { fact, line };
}

/** The Markdown sections, one per medical area, with its conditions. Call inside `render`. */
export function conditionSections(ctx: ToolContext, list: readonly Condition[], contacts: Map<string, Contact>, meds: readonly Med[], level = '###'): string[] {
  return groupBySpecialty(list).flatMap((g) => ['', `${level} ${specialtyLabel(g.specialty)} (${g.conditions.length})`, '', ...g.conditions.map((c) => conditionFacts(ctx, c, contacts, meds).line)]);
}

export const healthConditions = defineTool({
  name: 'health_conditions',
  title: "A person's conditions",
  description:
    "The health conditions (diagnoses) of the people this person may see them for in Huishouden Health, grouped by medical area (neurology, cardiology, endocrinology...): name, ICD-10-CM code, status (active, managed, resolved), when diagnosed, by which doctor and where, severity, the medicines that treat it, notes. Only admins and members who care for the person (or are the person) see conditions; helper carers and kids see none. Leave out `person` for everyone; `specialty` narrows it to one area (\"Nan's neurology conditions\").",
  kind: 'read',
  health: true,
  input: {
    ...common,
    person: z.string().min(1).max(60).optional().describe('Person by name or id, from `health_people`. Leave out for everyone.'),
    specialty: specialtyArg.optional().describe('Only this medical area.'),
    include_resolved: z.boolean().optional().describe('Also resolved conditions. Default true.'),
  },
  async run(ctx, args) {
    if (ctx.here.role === 'kid') throw new UserError('health.noKids');
    const all = args.person ? [await choosePerson(ctx, args.person)] : await loadPeople(ctx);
    const people = all.filter((p) => readsConditions(ctx, p));
    if (args.person && !people.length) throw new UserError('conditions.notShared', { name: all[0].name });
    ctx.touched('health', args.person ? `healthPeople/${people[0].id}/${CONDITIONS}` : undefined);
    const contacts = await contactsById(ctx);
    const lists = await Promise.all(
      people.map(async (p) => {
        const [conditions, meds] = await Promise.all([loadConditions(ctx, p), loadMeds(ctx, p)]);
        const shown = conditions.filter((c) => (!args.specialty || c.specialty === args.specialty) && (args.include_resolved !== false || c.status !== 'resolved'));
        return { person: p, conditions: shown, meds };
      }),
    );
    return render(ctx.lang, () => {
      const lines = [`**${t(args.specialty ? 'conditions.titleIn' : 'conditions.title', { area: args.specialty ? specialtyLabel(args.specialty) : '' })}** · ${ctx.here.name}`];
      if (!people.length) lines.push('', t('conditions.nobody'));
      for (const { person, conditions, meds } of lists) {
        lines.push('', `## ${person.name}`);
        if (!conditions.length) lines.push('', t(args.specialty ? 'conditions.noneIn' : 'conditions.none', { area: args.specialty ? specialtyLabel(args.specialty) : '' }));
        else lines.push(...conditionSections(ctx, conditions, contacts, meds));
      }
      return {
        text: lines.join('\n'),
        data: {
          household: ctx.here.id,
          people: lists.map(({ person, conditions, meds }) => ({
            id: person.id,
            name: person.name,
            groups: groupBySpecialty(conditions).map((g) => ({
              specialty: g.specialty,
              label: specialtyLabel(g.specialty),
              current: g.current,
              conditions: g.conditions.map((c) => conditionFacts(ctx, c, contacts, meds).fact),
            })),
          })),
        },
      };
    });
  },
});

function contactId(contacts: Map<string, Contact>, wanted: string | undefined): string | undefined {
  if (!wanted) return undefined;
  const { found } = pick([...contacts.values()], wanted, (c) => c.id, (c) => c.name);
  if (!found) throw new UserError('health.unknownContact', { name: wanted });
  return found.id;
}

function medIds(meds: Med[], wanted: string[] | undefined): string[] {
  return (wanted ?? []).map((w) => {
    const { found } = pick(meds, w, (m) => m.id, (m) => medLabel(m));
    const byName = found ?? pick(meds, w, (m) => m.id, (m) => m.name).found;
    if (!byName) throw new UserError('health.unknownMed', { name: w, meds: meds.map(medLabel).join(', ') || '-' });
    return byName.id;
  });
}

export const healthAddCondition = defineTool({
  name: 'health_add_condition',
  title: 'Add a condition',
  description:
    "Adds a health condition (a diagnosis) for a person in Health, as this person (admins, and members who care for that person; helpers can't). Give the name; `icd10` when known (\"M54.12\") files it under the code's medical area, else the name suggests one, else `specialty` says it (always wins). `diagnosed` may be a year, a month or a day; `doctor` and `clinic` are household contacts (add them with contacts_add), `place` a place in words.",
  kind: 'write',
  health: true,
  input: {
    ...common,
    ...idempotency,
    person: z.string().min(1).max(60).describe('Person by name or id, from `health_people`.'),
    name: z.string().min(1).max(CONDITION_LIMITS.name).describe('"Cervical radiculopathy".'),
    icd10: z.string().max(CONDITION_LIMITS.icd10).optional().describe('ICD-10-CM code, "M54.12".'),
    specialty: specialtyArg.optional().describe('Medical area to file it under. Default: from the code, else the name, else primary care and other.'),
    status: z.enum(CONDITION_STATUSES).optional().describe('Default resolved when `resolved` is given, else active.'),
    diagnosed: partialDate.optional().describe('When diagnosed: "2019", "2019-03" or "2019-03-14".'),
    resolved: partialDate.optional().describe('When it resolved; implies status resolved unless another status is given (a current status with a date is refused).'),
    severity: z.enum(CONDITION_SEVERITIES).optional(),
    doctor: z.string().max(120).optional().describe('Who diagnosed it: a household contact name or id.'),
    clinic: z.string().max(120).optional().describe('Where: a household contact (clinic, hospital) name or id.'),
    place: z.string().max(CONDITION_LIMITS.place).optional().describe('Where, in words, when it is not a contact.'),
    medicines: z.array(z.string().min(1).max(80)).max(CONDITION_LIMITS.medIds).optional().describe("The person's medicines that treat it, by name or id from `health_medicines`."),
    notes: z.string().max(CONDITION_LIMITS.notes).optional(),
  },
  async run(ctx, args) {
    const person: Person = await choosePerson(ctx, args.person);
    if (!keeps(ctx, person)) throw new UserError('conditions.keepersOnly');
    // Said back rather than dropped: a place beside a clinic, a resolved date on a current condition.
    const conflicts = conditionConflicts({ clinicId: args.clinic, place: args.place, status: args.status, resolved: args.resolved });
    if (conflicts.includes('place')) throw new UserError('conditions.placeOrClinic');
    if (conflicts.includes('resolved')) throw new UserError('conditions.resolvedNeedsStatus');
    const [contacts, meds] = await Promise.all([contactsById(ctx), loadMeds(ctx, person)]);
    const now = ctx.clock.now();
    const doc = conditionDoc(
      {
        personId: person.id,
        name: args.name,
        icd10: args.icd10,
        specialty: args.specialty,
        status: args.status,
        diagnosed: args.diagnosed,
        resolved: args.resolved,
        severity: args.severity,
        doctorId: contactId(contacts, args.doctor),
        clinicId: contactId(contacts, args.clinic),
        place: args.place,
        medIds: medIds(meds, args.medicines),
        notes: args.notes,
      },
      { createdAt: now, by: ctx.session.email },
      ctx.session.via.via,
    );
    const id = await recordId(ctx.session.props.connectionId, 'health_add_condition', args.idempotency_key);
    let repeated = false;
    await ctx.session.db.commit([{ path: `households/${ctx.here.id}/healthPeople/${person.id}/${CONDITIONS}/${id}`, create: doc as unknown as Record<string, unknown> }]).catch((e) => {
      if (alreadyThere(e)) repeated = true;
      else if (isDenied(e)) throw new UserError('conditions.keepersOnly');
      else throw e;
    });
    ctx.touched('health', `healthPeople/${person.id}/${CONDITIONS}/${id}`);
    const condition = toCondition(id, doc as unknown as Record<string, unknown>, person.id);
    return render(ctx.lang, () => ({
      text: t('conditions.added', { condition: condition.name, name: person.name, area: specialtyLabel(condition.specialty), url: conditionUrl(ctx, condition) }),
      data: { id, person: person.id, repeated, condition: conditionFacts(ctx, condition, contacts, meds).fact },
    }));
  },
});
