import { capitalize, DEFAULT_LOCALES, formatList, type Lang } from './i18n.js';
import { contentHash } from './hash.js';

/**
 * Things that may show as one: garbage and recycling picked up the same morning, two pets not fed
 * yet at the same meal. An app marks each such agenda item or reminder with a `merge` (the same
 * `key` for things that may combine, this one's `part` of the combined title, and that title with
 * `{parts}` where the parts go), and wherever items are shown or sent (the portal's Today and
 * Calendar, a person's calendar, the push sender) the ones that share a key, a time and readers
 * become one: "Garbage and recycling pickup", "Milo and Theo: AM not fed yet".
 *
 * Only items of the same app merge, and only with the same readers (the same privacy and audience),
 * so a private item is never folded into a shared one. Each keeps its own record: a to-do is still
 * ticked on its own, a reminder whose record is done drops out of the combined push. Server-safe.
 */

export interface MergeSpec {
  /** Which items may combine, within the app: "collection", "meal:am". */
  key: string;
  /** This item's part of the combined title, as written mid-sentence: "garbage", "Milo". */
  part: string;
  /** The combined title, with `{parts}` where the parts go: "{parts} pickup", "{parts}: AM not fed yet". */
  title: string;
}

export const MERGE_FIELDS = ['key', 'part', 'title'] as const;

/** Maximum lengths (the rules check the same). */
export const MERGE_LIMITS = { key: 80, part: 60, title: 120 } as const;

/** Where the parts go in `title`. */
export const MERGE_PARTS = '{parts}';

/** The words of a merge in another language, kept in the record's `texts` beside its title. */
export interface MergeTexts {
  mergePart?: string;
  mergeTitle?: string;
}

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/** A merge as stored: known keys, trimmed and clipped; undefined when it isn't one (no key, part, or `{parts}` in the title). */
export function cleanMerge(v: unknown): MergeSpec | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const m = v as Record<string, unknown>;
  const key = clip(m.key, MERGE_LIMITS.key);
  const part = clip(m.part, MERGE_LIMITS.part);
  const title = clip(m.title, MERGE_LIMITS.title);
  if (!key || !part || !title.includes(MERGE_PARTS)) return undefined;
  return { key, part, title };
}

/**
 * The combined title: the parts listed the language's way, in `template`, its first letter upper
 * case ("{parts} pickup" with "garbage" and "recycling": "Garbage and recycling pickup"). Parts
 * repeated are listed once.
 */
export function mergedTitle(template: string, parts: readonly string[], lang: Lang, max = MERGE_LIMITS.title): string {
  const unique = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  const list = formatList(unique, { loc: DEFAULT_LOCALES[lang] });
  return capitalize(template.split(MERGE_PARTS).join(list), DEFAULT_LOCALES[lang]).slice(0, max);
}

/**
 * Who may read a record, as a short hash: records merge only when it is the same. Hashed, so the
 * audience's emails never reach a key stored outside the household (a calendar event's mark).
 */
export function readersKey(r: { private?: boolean; audience?: readonly string[] }): string {
  const audience = r.audience ? [...new Set(r.audience.map((e) => e.trim().toLowerCase()))].sort().join(',') : '';
  return contentHash(`${r.private === false ? 'open' : 'private'}|${audience}`);
}

/** What `mergeIdentity` reads: an agenda item or a reminder. */
export interface Mergeable {
  app: string;
  merge?: MergeSpec;
  kind?: string;
  status?: string;
  private?: boolean;
  audience?: readonly string[];
}

/**
 * The part of the merge rule every place shares: the same app, `merge.key` and kind, the same
 * readers, both done or both not. Each place adds when (`agendaMergeKey`, `reminderMergeKey`, the
 * calendar's keys). Null for a record without a merge.
 */
export function mergeIdentity(r: Mergeable): string | null {
  if (!r.merge) return null;
  return [r.app, r.merge.key, r.kind ?? '', readersKey(r), r.status === 'done' ? 'done' : 'open'].join('|');
}
