/**
 * One image of an earlier run, its lines rebuilt with the current code and parsed again:
 * `bun bench/labels/debug.ts <run> <id>~<variant> [...]`. Public and synthetic images only.
 */
import { CACHE } from './fetch';
import { PARSERS, relined } from './pipelines';

const [run, ...keys] = process.argv.slice(2);
const results = (await Bun.file(`${CACHE}results/${run}.json`).json()).results;
for (const key of keys) {
  const r = results.find((x: { id: string; variant: string }) => `${x.id}~${x.variant}` === key);
  if (!r?.read) {
    console.log(key, 'not in', run);
    continue;
  }
  const read = relined(r.read);
  console.log(`\n=== ${key}`);
  for (const l of read.lines ?? []) console.log(`  ${l.text}  [c${Math.round(l.confidence)} h${Math.round(l.height)}]`);
  const p = await PARSERS[process.env.PARSE ?? 'names'](read);
  console.log(JSON.stringify({ name: p.name, strength: p.strength, form: p.form, route: p.route, ndc: p.ndc, dose: p.dose, timesPerDay: p.timesPerDay, intervalHours: p.intervalHours }));
}
