import { UserError } from './context.js';
import type { ToolContext } from './registry.js';
import type { Doc } from '../firestore-rest.js';
import { pick } from './shared.js';

/** What the Pet tools share: a pet as the tools read it, the loose readers of a document's fields, and the link into Pet. */

export interface Pet {
  id: string;
  name: string;
  species: string;
}
export const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The `petProfiles` documents as pets, by name. */
export const toPets = (docs: Doc[]): Pet[] =>
  docs.map((d) => ({ id: d.id, name: String(d.data.name ?? ''), species: String(d.data.species ?? 'other') })).sort((a, b) => a.name.localeCompare(b.name));

export function choosePet(pets: Pet[], wanted?: string): Pet[] {
  if (!wanted) return pets;
  const { found, ambiguous } = pick(pets, wanted, (p) => p.id, (p) => p.name);
  if (found) return [found];
  throw new UserError(ambiguous ? 'pet.ambiguous' : 'pet.unknown', { name: wanted, pets: pets.map((p) => p.name).join(', ') });
}

export const petUrl = (ctx: ToolContext, query = '') => ctx.session.link('pet', query);
