import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// infra/read-alert.sh writes a policy only when it differs from the live one: an edit to a policy
// whose condition holds re-opens its incident and emails again, so a re-run must be a no-op.
const SCRIPT = join(import.meta.dir, '..', 'infra', 'read-alert.sh');
const CHANNEL = 'projects/demo-alerts/notificationChannels/1';
const dir = mkdtempSync(join(tmpdir(), 'read-alert-'));

const wanted = (): Record<string, any>[] => {
  const r = Bun.spawnSync(['bash', SCRIPT, '--print', 'demo-alerts']);
  expect(r.exitCode).toBe(0);
  return (JSON.parse(r.stdout.toString()) as Record<string, any>[]).map((p) => ({ ...p, notificationChannels: [CHANNEL] }));
};

/** As the API answers it: names, records and defaults added. */
const live = (p: Record<string, any>) => ({
  ...p,
  name: 'projects/demo-alerts/alertPolicies/42',
  enabled: true,
  creationRecord: { mutateTime: '2031-10-01T12:00:00Z', mutatedBy: 'someone@example.com' },
  mutationRecord: { mutateTime: '2031-10-01T12:00:00Z', mutatedBy: 'someone@example.com' },
  conditions: p.conditions.map((c: Record<string, any>, i: number) => ({ ...c, name: `projects/demo-alerts/alertPolicies/42/conditions/${i}` })),
});

const same = (a: unknown, b: unknown) => {
  writeFileSync(join(dir, 'live.json'), JSON.stringify(a));
  writeFileSync(join(dir, 'wanted.json'), JSON.stringify(b));
  return Bun.spawnSync(['bash', SCRIPT, '--same', join(dir, 'live.json'), join(dir, 'wanted.json')]).exitCode === 0;
};

describe('read-alert.sh: only a policy that differs is written', () => {
  test('the live policy as the API returns it is the same as the wanted one', () => {
    for (const p of wanted()) expect(same(live(p), p)).toBe(true);
  });

  test('a different threshold, documentation, channel or auto-close is a change', () => {
    const [daily] = wanted();
    const q = daily.conditions[0].conditionPrometheusQueryLanguage;
    expect(same(live({ ...daily, conditions: [{ ...daily.conditions[0], conditionPrometheusQueryLanguage: { ...q, query: q.query.replace('> 30000', '> 25000') } }] }), daily)).toBe(false);
    expect(same(live({ ...daily, documentation: { ...daily.documentation, content: 'older words' } }), daily)).toBe(false);
    expect(same(live({ ...daily, notificationChannels: [] }), daily)).toBe(false);
    expect(same(live({ ...daily, alertStrategy: { autoClose: '3600s' } }), daily)).toBe(false);
  });

  test('every field the script sets decides the comparison: none is dropped by the shape it compares', () => {
    const leaves = (v: unknown, path: (string | number)[] = []): (string | number)[][] =>
      v && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => leaves(x, [...path, Array.isArray(v) ? Number(k) : k])) : [path];
    const set = (o: any, path: (string | number)[], value: unknown) => {
      const copy = structuredClone(o);
      let at = copy;
      for (const k of path.slice(0, -1)) at = at[k];
      at[path[path.length - 1]] = value;
      return copy;
    };
    for (const p of wanted()) {
      for (const path of leaves(p)) expect([path.join('.'), same(live(set(p, path, `changed-${path.join('.')}`)), p)]).toEqual([path.join('.'), false]);
    }
  });
});
