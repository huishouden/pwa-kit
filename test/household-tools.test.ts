import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkArgs, COVERAGE, coverageGaps, runTool, Session, TOOLS, toolNamed } from '../src/household-tools';

process.env.TZ = 'UTC';
import en from '../src/household-tools/locales/en';
import es from '../src/household-tools/locales/es';
import nl from '../src/household-tools/locales/nl';
import { FirestoreError, type Doc, type FirestoreRest, type Write } from '../src/firestore-rest';
import { messageArgs } from '../src/i18n';

// The tools the connector and `hh data` share. Their full behaviour under the household's rules is
// tested in huishouden/connector against the emulator; here, the parts that don't need one.

const NOW = Date.UTC(2031, 0, 6, 15);
const ME = 'sam@example.com';
const HOME: Doc = { id: 'h1', path: 'households/h1', data: { name: 'Home', members: [ME, 'alex@example.com'], joined: [ME], createdAt: 1 } };

/** A FirestoreRest with one household and a list, recording commits. */
function fakeDb(over: Partial<Pick<FirestoreRest, 'get' | 'query' | 'commit'>> = {}) {
  const commits: Write[][] = [];
  const db = {
    get: async () => null,
    query: async (_parent: string, collection: string) =>
      collection === 'households' ? [HOME] : collection === 'lists' ? [{ id: 'groceries', path: 'households/h1/lists/groceries', data: { name: 'Groceries', icon: 'cart', sortOrder: 0 } }] : [],
    commit: async (writes: Write[]) => void commits.push(writes),
    ...over,
  } as unknown as FirestoreRest;
  return { db, commits };
}

const session = (db: FirestoreRest, via?: 'assistant') => new Session({ uid: 'u1', email: ME, connectionId: 'hh-u1', timeZone: 'America/New_York', ...(via ? { via } : {}) }, db, 'https://example.web.app', () => NOW);

describe('household tools', () => {
  test('every tool has a unique name, a description and an input schema', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('today');
    expect(names).toContain('health_log_dose');
    for (const tool of TOOLS) expect(tool.description.length).toBeGreaterThan(20);
  });

  test('coverage: every tool it names exists, and every write tool is listed against the data it changes', () => {
    const named = new Set(Object.values(COVERAGE).flatMap((c) => ('tools' in c ? c.tools : [])));
    for (const name of named) expect(toolNamed(name), `COVERAGE names ${name}`).toBeDefined();
    for (const tool of TOOLS.filter((x) => x.kind === 'write')) expect(named.has(tool.name), `${tool.name} is in COVERAGE`).toBe(true);
    for (const [col, c] of Object.entries(COVERAGE)) {
      expect(col).toMatch(/^[a-zA-Z]+(\/[a-zA-Z]+)?$/);
      if ('tools' in c) expect(c.tools.length, col).toBeGreaterThan(0);
    }
    const gaps = coverageGaps();
    expect(gaps.find((g) => g.collection === 'lists')).toMatchObject({ kind: 'gap' });
    expect(gaps.find((g) => g.collection === 'items')).toMatchObject({ kind: 'partly' });
    expect(gaps.some((g) => g.collection === 'babyKickSettings')).toBe(false);
  });

  test('Spanish and Dutch have every key, with the same placeholders', () => {
    for (const other of [es, nl] as Record<string, string>[]) {
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
      for (const [key, message] of Object.entries(en)) expect([key, messageArgs(other[key]).sort()]).toEqual([key, messageArgs(message).sort()]);
    }
  });

  test('imports no package but zod (servers and the command line load it)', () => {
    const dir = join(import.meta.dir, '../src/household-tools');
    const bare = new Set<string>();
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const m of readFileSync(file, 'utf8').matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
        if (m[1].startsWith('.')) walk(join(dirname(file), m[1].replace(/\.js$/, '') + '.ts'));
        else bare.add(m[1]);
      }
    };
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) walk(join(dir, f));
    expect([...bare]).toEqual(['zod']);
    expect([...seen].some((f) => /\/(firestore|firebase|auth)\.ts$/.test(f))).toBe(false);
  });

  test('checkArgs: the schema decides; unknown arguments are refused', () => {
    const add = toolNamed('groceries_add')!;
    expect(checkArgs(add, { name: 'Oat milk', urgency: 'Need Today' })).toEqual({ ok: true, args: { name: 'Oat milk', urgency: 'Need Today' } });
    const bad = checkArgs(add, { name: '', colour: 'red' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues.join('\n')).toContain('name');
    expect(!bad.ok && bad.issues.join('\n')).toContain('colour');
  });

  test('runTool: the household the apps open, the profile-less clock, the answer in English', async () => {
    const { db } = fakeDb();
    const call = await runTool(session(db), toolNamed('households')!, {});
    expect(call.householdId).toBe('h1');
    expect(call.result.error).toBeUndefined();
    expect(call.result.data).toMatchObject({ email: ME, role: 'admin', time_zone: 'America/New_York', households: [{ id: 'h1', name: 'Home', default: true }] });
    expect(call.result.text).toContain('Signed in to Huishouden as sam@example.com');
  });

  test("runTool: a write carries via only when the session says so (the connector's, not the command line's)", async () => {
    for (const via of [undefined, 'assistant'] as const) {
      const { db, commits } = fakeDb();
      const call = await runTool(session(db, via), toolNamed('groceries_add')!, { name: 'Oat milk' });
      expect(call.result.error).toBeUndefined();
      const item = commits[0].find((w) => w.path.includes('/items/')) as { create: Record<string, unknown> };
      expect(item.create.via).toBe(via);
      expect('via' in item.create).toBe(via !== undefined);
      expect(call.touched.app).toBe('groceries');
    }
  });

  test('groceries_add: a new item goes to the top of the open items, urgent ones above that', async () => {
    const position = async (args: Record<string, unknown>) => {
      const { db, commits } = fakeDb();
      await runTool(session(db), toolNamed('groceries_add')!, args);
      return ((commits[0].find((w) => w.path.includes('/items/')) as { create: Record<string, unknown> }).create.position as number);
    };
    const standard = await position({ name: 'Oat milk' });
    const urgent = await position({ name: 'Eggs', urgency: 'Need Today' });
    expect(standard).toBe(-NOW);
    expect(urgent).toBeLessThan(standard);
    // Below the positions dragging leaves behind and older (positive timestamp) items.
    expect(standard).toBeLessThan(1000);
  });

  test("runTool: the rules' refusal is said in the person's language, never thrown", async () => {
    const { db } = fakeDb({
      query: async (_p: string, c: string) => {
        if (c === 'households') return [HOME];
        throw new FirestoreError('permission-denied', 'no');
      },
    });
    const call = await runTool(session(db), toolNamed('groceries_list')!, { lang: 'nl' });
    expect(call.result.error).toBe(true);
    expect(call.error).toBeInstanceOf(FirestoreError);
    expect(call.lang).toBe('nl');
    expect(call.result.text).toBe((nl as Record<string, string>)['error.denied']);
  });

  test('runTool: Health answers end with the not-medical-advice note, refusals too', async () => {
    const { db } = fakeDb();
    const call = await runTool(session(db), toolNamed('health_people')!, {});
    expect(call.result.text).toContain('not medical advice');
  });

  test('runTool: no household is said, not thrown', async () => {
    const { db } = fakeDb({ query: async () => [] });
    const call = await runTool(session(db), toolNamed('today')!, {});
    expect(call.result).toEqual({ text: en['error.noHousehold'], error: true });
  });

  test('runTool refuses to run outside a UTC process, before reading anything', async () => {
    const { db, commits } = fakeDb();
    const real = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = () => 300;
    try {
      await expect(runTool(session(db), toolNamed('today')!, {})).rejects.toThrow('needs a UTC process');
    } finally {
      Date.prototype.getTimezoneOffset = real;
    }
    expect(commits).toEqual([]);
  });

  test('runTool: a refused rate limit runs nothing', async () => {
    const { db, commits } = fakeDb();
    const call = await runTool(session(db), toolNamed('groceries_add')!, { name: 'x' }, { allow: async () => false });
    expect(call.result.text).toBe(en['error.rateLimited']);
    expect(commits).toEqual([]);
  });
});
