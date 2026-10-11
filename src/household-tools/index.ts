/**
 * The household's data as one signed-in person, for servers and command lines: every tool the AI
 * connector (huishouden/connector) offers and `hh data` runs, in one place so the two can't drift.
 * Each tool reads and writes Firestore over REST as the person (`../firestore-rest` with their ID
 * token from `../firebase-auth-rest`), so the household's rules decide everything, and answers in
 * their language and time zone with links into the apps.
 *
 * Server-safe: no DOM, no Firebase SDK. Needs `zod` (a peer dependency) for the tools' inputs, and a
 * process in UTC (Workers are; a command line sets `TZ=UTC` first): `../local-clock` moves times
 * into a frame whose UTC fields are the person's wall clock, and the kit formats them as local.
 *
 *   const session = new Session({ uid, email, connectionId }, db, siteUrl);
 *   const call = await runTool(session, toolNamed('today')!, { household: 'Home' });
 *   call.result.text; call.result.data;
 */
import { z } from 'zod';
import { FirebaseAuthError } from '../firebase-auth-rest.js';
import { FirestoreError } from '../firestore-rest.js';
import type { Lang } from '../i18n.js';
import { UserError, type AuditEntry, type Session } from './context.js';
import { failureText, render, withHealthNote, type ToolDef, type ToolResult } from './registry.js';
import { t } from './i18n.js';
import { calendar, householdHome, households, today, todos } from './overview.js';
import { groceriesAdd, groceriesCheck, groceriesList, tasksAdd, todoCancel, todoDone } from './lists.js';
import { billsDue } from './money.js';
import { petLogDose, petLogFeeding, petLogOuting, petToday } from './pet.js';
import { petRoutineDone, petRoutines } from './pet-routines.js';
import { homeAddEvent, homeUpkeepDue } from './home.js';
import { addAppointment, contactsAdd, contactsSearch } from './people.js';
import { healthAppointments } from './health-visits.js';
import { healthAddCondition, healthConditions } from './health-conditions.js';
import { healthAddMedicine, healthDoctorList, healthDue, healthHistory, healthLogDose, healthMedicines, healthPeople, healthUpdateMedicine } from './health.js';

export { Session, UserError, type AuditEntry, type Here, type Household, type SessionProps } from './context.js';
export type { ToolContext, ToolDef, ToolResult } from './registry.js';

/** Every tool, in the order clients list them. */
export const TOOLS: readonly ToolDef[] = [
  households,
  householdHome,
  today,
  calendar,
  todos,
  todoDone,
  todoCancel,
  groceriesList,
  groceriesAdd,
  groceriesCheck,
  tasksAdd,
  billsDue,
  petToday,
  petLogFeeding,
  petLogDose,
  petLogOuting,
  petRoutines,
  petRoutineDone,
  homeUpkeepDue,
  homeAddEvent,
  addAppointment,
  contactsSearch,
  contactsAdd,
  healthPeople,
  healthMedicines,
  healthHistory,
  healthDue,
  healthLogDose,
  healthAddMedicine,
  healthUpdateMedicine,
  healthDoctorList,
  healthAppointments,
  healthConditions,
  healthAddCondition,
];

export const toolNamed = (name: string): ToolDef | undefined => TOOLS.find((tool) => tool.name === name);

/** The tool's arguments checked against its input schema: the parsed arguments, or what is wrong with them. */
export function checkArgs(tool: ToolDef, raw: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; issues: string[] } {
  const parsed = z.strictObject(tool.input).safeParse(raw);
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`) };
}

/**
 * Throws unless this process runs in UTC (summer and winter): every time the tools show and every
 * local day would otherwise be off by the machine's offset, Health's dose times included.
 */
export function assertUtcProcess(): void {
  if (new Date(Date.UTC(2000, 0, 1)).getTimezoneOffset() !== 0 || new Date(Date.UTC(2000, 6, 1)).getTimezoneOffset() !== 0)
    throw new Error('household-tools needs a UTC process: set TZ=UTC before anything uses a Date');
}

/** One tool call's outcome: the answer (Health ones with their note) and what it touched, for logs and audits. */
export interface ToolCall {
  result: ToolResult;
  lang: Lang;
  /** The household it acted in, once known. */
  householdId?: string;
  touched: Pick<AuditEntry, 'app' | 'ref'>;
  /** What went wrong, when it did (the result's text already says so in the person's language). */
  error?: unknown;
}

export interface RunOptions {
  /** Whether this call may go ahead (rate limits); false answers "too many requests". */
  allow?: (kind: 'read' | 'write') => Promise<boolean>;
}

/**
 * Runs `tool` as `session`'s person with already-checked `args` (`checkArgs`, or an MCP server's
 * own validation): the household (`args.household` or the one the apps open), their language and
 * clock, then the tool. Never throws for the person's or the rules' reasons: the result says why.
 */
export async function runTool(session: Session, tool: ToolDef, args: Record<string, unknown>, { allow }: RunOptions = {}): Promise<ToolCall> {
  assertUtcProcess();
  let lang: Lang = 'en';
  let householdId: string | undefined;
  let touched: ToolCall['touched'] = {};
  try {
    lang = await session.lang(undefined, args.lang as string | undefined);
    if (allow && !(await allow(tool.kind))) {
      const error = new UserError('error.rateLimited');
      return { result: { text: render(lang, () => t('error.rateLimited')), error: true }, lang, touched, error };
    }
    const here = await session.here(args.household as string | undefined);
    householdId = here.id;
    lang = await session.lang(here.id, args.lang as string | undefined);
    const clock = await session.clock(here.id, args.time_zone as string | undefined);
    const result = await tool.run({ session, here, clock, lang, touched: (app, ref) => (touched = { app, ...(ref ? { ref } : {}) }) }, args as never);
    return { result: withHealthNote(result, lang, tool.health), lang, householdId, touched };
  } catch (e) {
    return { result: withHealthNote({ text: failureText(e, lang), error: true }, lang, tool.health), lang, householdId, touched, error: e };
  }
}

/** A short code for what went wrong, never a message (messages may hold names): for logs. */
export const errorCode = (e: unknown): string =>
  e instanceof UserError ? `user:${e.key}` : e instanceof FirestoreError ? `firestore:${e.code}` : e instanceof FirebaseAuthError ? `auth:${e.kind}` : e instanceof Error ? e.name : 'unknown';

/** The person's Firebase sign-in has ended for good (signed out everywhere, account disabled). */
export const signInEnded = (e: unknown): boolean => e instanceof FirebaseAuthError && e.kind === 'revoked';
