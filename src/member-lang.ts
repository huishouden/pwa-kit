import { doc, type Firestore } from 'firebase/firestore';
import { setDoc } from './firestore.js';
import { getLang, getLangChoice, isLang, onLangChange, setLangChoice, type Lang } from './i18n.js';
import type { MemberLangs } from './reader-langs.js';

/**
 * Each member's language, one for the whole suite on every device: `households/{id}.langs[email]`,
 * which every member's device reads with the household and only the member writes (the rules). It
 * is stored per household, so each household's members can read it; a member of several keeps the
 * same language in each (the household the apps use leads, `followMemberLang`).
 * Apps publish reminders, to-dos and agenda items in their readers' languages from it
 * (`./reader-langs`), the sender notifies in it, and every app on every device shows it.
 * localStorage (`hh-lang`, `./i18n`) stays the boot cache, so a page paints in it before the
 * household arrives.
 *
 * `watchHousehold` (`./household`) follows it by itself: the first time a member opens an app with
 * none stored, their device's language (or the one they chose there) is stored; after that a
 * change on any device (the app bar's Language menu) is stored and every other device follows.
 */

/** Stores the signed-in member's language on the household; only their own entry is written. */
export async function saveMyLang(db: Firestore, householdId: string, email: string, lang: Lang): Promise<void> {
  if (!isLang(lang)) throw new Error(`Not a language: ${String(lang)}`);
  // A merge of a one-key map writes only this member's entry, as the rules require.
  await setDoc(doc(db, 'households', householdId), { langs: { [email.trim().toLowerCase()]: lang } }, { merge: true });
}

/** What following needs of a household. */
export interface LangFollowHousehold {
  id: string;
  members: readonly string[];
  /** Members who have opened an app in it (`markJoined`): only there is a language written. */
  joined: readonly string[];
  langs?: MemberLangs;
}

/**
 * Writes asked for in this page, by household, member and language, until the household shows a
 * stored language, shared by every follower (two `watchHousehold` calls in one page write once); and
 * those the rules refused, never asked again until the language or the household changes.
 */
const asked = new Set<string>();
const refused = new Set<string>();
const keyOf = (id: string, email: string, lang: Lang) => `${id}|${email}|${lang}`;

/** For tests: forget the writes asked for and refused in this page. */
export function resetMemberLangForTests(): void {
  asked.clear();
  refused.clear();
}

/**
 * Keeps this page's language and the member's stored one in step. `apply(household, others)` on
 * every snapshot, with the household the page uses and any other households the member is in: a
 * stored language this page doesn't show is switched to; none stored stores this page's (a concrete
 * language, never Automatic). A language chosen here afterwards is stored. Each of `others` is kept
 * at the same language, so what their members publish for this member is in it too; with none stored
 * where the apps are used, a language stored in another is taken. Only households the member has
 * joined are written (an invitation never acted on gets nothing). `stop()` ends
 * it. A write the rules refuse (`permission-denied`) is not asked again for the same household and
 * language; any other failure is tried again on the next snapshot or change.
 */
export function followMemberLang(
  db: Firestore,
  email: string,
  { save = saveMyLang }: { save?: typeof saveMyLang } = {},
): { apply: (household: LangFollowHousehold | null, others?: readonly LangFollowHousehold[]) => void; stop: () => void } {
  const me = email.trim().toLowerCase();
  let mine: LangFollowHousehold[] = [];
  // Only a household the member has joined: an invitation they never acted on learns nothing of them.
  const storeIn = (h: LangFollowHousehold, lang: Lang) => {
    if (!h.members.includes(me) || !h.joined?.includes(me) || h.langs?.[me] === lang) return;
    const key = keyOf(h.id, me, lang);
    if (asked.has(key) || refused.has(key)) return;
    asked.add(key);
    save(db, h.id, me, lang).catch((e: unknown) => {
      asked.delete(key);
      if ((e as { code?: string } | null)?.code === 'permission-denied') refused.add(key);
    });
  };
  const store = (lang: Lang) => mine.forEach((h) => storeIn(h, lang));
  const stopListening = onLangChange(({ lang }) => store(lang));
  return {
    apply(next, others = []) {
      mine = next && next.members.includes(me) ? [next, ...others.filter((h) => h.id !== next.id && h.members.includes(me))] : [];
      if (!next || !mine.length) return;
      // A stored language has landed what was asked (or another device chose since): a later choice is new.
      for (const h of mine) if (h.langs?.[me]) for (const key of asked) if (key.startsWith(`${h.id}|${me}|`)) asked.delete(key);
      // Stored in the household the apps use, else in another the member has joined (in `others`' order).
      const stored = next.langs?.[me] ?? mine.find((h) => h.joined?.includes(me) && h.langs?.[me])?.langs?.[me];
      // The member's language: the one stored, else the one this page shows (chosen here, else the device's).
      const choice = getLangChoice();
      const lang = stored ?? (choice === 'auto' ? getLang() : choice);
      store(lang);
      if (choice !== lang || getLang() !== lang) void setLangChoice(lang);
    },
    stop: stopListening,
  };
}
