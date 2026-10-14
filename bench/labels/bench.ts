/**
 * The label-reading benchmark: reads every image of the set (`variants.ts`) with a pipeline and
 * scores the fields the medicine forms are filled from (`score.ts`).
 *
 *   bun bench/labels/fetch.ts && bun bench/labels/synth.ts && bun bench/labels/variants.ts   # once
 *   bun bench/labels/bench.ts [--read kit|baseline] [--parse fda|names|label|directions] [--reuse <run>] [--name <run>]
 *                             [--local <truth.json>] [--only <id,...>] [--variants flat,...] [--workers 6] [--verbose] [--save]
 *
 * `--local` adds photos that must never leave the machine (a JSON list of `{ set, file, truth }`
 * kept outside the repository), known as local-1, local-2… by their place in it: for those only
 * scores are printed, never the text or the fields, and `--save` leaves them out entirely.
 * Results go to `.cache/results/<read>-<parse>.json` (or `--name`); `--save` also writes the summary to `results/`.
 */
import { createWorker } from 'tesseract.js';
import { mkdir } from 'node:fs/promises';
import { CACHE, corpus, type Label } from './fetch';
import type { SetItem } from './variants';
import { FIELDS, cer, keyRecall, leaks, scoreFields, wordPR, type Field, type Outcome } from './score';
import { PARSERS, READERS, relined, toReading, type BenchOcr, type Read } from './pipelines';
import { OCR_LANG_PATH } from '../../src/ocr';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// --reuse <run>: the readings of an earlier run (same images), parsed again: fast, for parser work.
const reuse = opt('reuse');
const reusedRun = reuse ? await Bun.file(`${CACHE}results/${reuse}.json`).json() : null;
// Images the earlier run kept no reading of (the local photos) are read again with its reader.
const readerName = reusedRun?.reader ?? opt('read') ?? 'kit';
const parserName = opt('parse') ?? 'fda';
const reader = READERS[readerName];
const parser = PARSERS[parserName];
if (!reader || !parser) throw new Error(`--read ${Object.keys(READERS).join('|')} --parse ${Object.keys(PARSERS).join('|')}`);
const pipelineName = opt('name') ?? `${readerName}-${parserName}`;
const reused = new Map<string, Read>();
if (reusedRun) for (const r of reusedRun.results) if (r.read) reused.set(`${r.id}~${r.variant}`, relined(r.read));
const verbose = args.includes('--verbose');
const only = opt('only')?.split(',');
const variantsOnly = opt('variants')?.split(',');

interface LocalPhoto {
  set: 'human' | 'pet';
  file: string;
  truth: Label['truth'];
}

const labels = new Map<string, Label & { local?: boolean }>();
for (const l of [...(await corpus()), ...(await Bun.file(`${CACHE}synthetic.json`).json())]) labels.set(l.id, l);
let items: SetItem[] = await Bun.file(`${CACHE}set.json`).json();
const localFile = opt('local');
if (localFile) {
  // Known by their place in the file only ("local-1"): whatever the file calls them stays in it.
  for (const [n, p] of ((await Bun.file(localFile).json()) as LocalPhoto[]).entries()) {
    const id = `local-${n + 1}`;
    labels.set(id, { id, set: p.set, kind: 'local-photo', source: 'local', truth: p.truth, local: true });
    items.push({ file: p.file, id, variant: 'flat' });
  }
}
if (only) items = items.filter((i) => only.some((o) => i.id === o || i.id.startsWith(o)));
if (variantsOnly) items = items.filter((i) => variantsOnly.includes(i.variant));

const workerCount = Number(opt('workers') ?? 6);
const workers = await Promise.all(
  Array.from({ length: reuse ? 1 : workerCount }, () => createWorker('eng', 1, { langPath: OCR_LANG_PATH, cachePath: `${CACHE}tessdata` }) as unknown as Promise<BenchOcr>),
);

interface Result {
  id: string;
  variant: string;
  set: string;
  kind: string;
  local: boolean;
  fields: Partial<Record<Field, Outcome>>;
  keyRecall: number;
  cer?: number;
  precision?: number;
  recall?: number;
  leaks: number;
  ms: number;
  passes: number;
  text?: string;
  reading?: Record<string, unknown>;
  read?: Read;
}

const results: Result[] = [];
let next = 0;
const started = Date.now();
await Promise.all(
  workers.map(async (w) => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      const label = labels.get(item.id)!;
      const t0 = performance.now();
      const cached = reused.get(`${item.id}~${item.variant}`);
      const read = cached ?? (await reader(item.file, w));
      const ms = cached ? 0 : performance.now() - t0;
      const parsed = await parser(read);
      const r = { ...toReading(read.text, parsed), passes: read.passes, privateLeaks: 0 };
      const pr = label.truth.text ? wordPR(r.text, label.truth.text) : undefined;
      const res: Result = {
        id: item.id, variant: item.variant, set: label.set, kind: label.kind, local: !!label.local,
        fields: scoreFields(r, label.truth), keyRecall: keyRecall(r.text, label.truth),
        ...(label.truth.text ? { cer: cer(r.text, label.truth.text), precision: pr!.precision, recall: pr!.recall } : {}),
        leaks: leaks(r, label.truth).length + (label.local ? (r.privateLeaks ?? 0) : 0), ms, passes: r.passes,
        // Text and fields are kept for the public and synthetic images only.
        ...(label.local ? {} : { text: r.text, reading: { ...r, text: undefined }, read }),
      };
      results.push(res);
      if (verbose && !label.local) console.log(`\n### ${item.id}~${item.variant}`, JSON.stringify(res.fields), '\n', r.text.slice(0, 600), '\n', JSON.stringify({ ...r, text: undefined, shown: undefined }));
      if (verbose && label.local) console.log(`\n### ${item.id}`, JSON.stringify(res.fields), `keyRecall ${res.keyRecall.toFixed(2)} leaks ${res.leaks}`);
    }
  }),
);
await Promise.all(workers.map((w) => w.terminate()));

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');
function summarize(rs: Result[]) {
  const row: Record<string, string | number> = { images: rs.length };
  for (const f of FIELDS) {
    const scored = rs.filter((r) => r.fields[f]);
    const right = scored.filter((r) => r.fields[f] === 'right').length;
    const wrong = scored.filter((r) => r.fields[f] === 'wrong').length;
    row[f] = scored.length ? `${pct(right, scored.length)} (${pct(wrong, scored.length)} wrong, n=${scored.length})` : '–';
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  row.keyRecall = mean(rs.map((r) => r.keyRecall)).toFixed(2);
  const withText = rs.filter((r) => r.cer !== undefined);
  row.cer = withText.length ? mean(withText.map((r) => r.cer!)).toFixed(2) : '–';
  row.wordPrecision = withText.length ? mean(withText.map((r) => r.precision!)).toFixed(2) : '–';
  row.wordRecall = withText.length ? mean(withText.map((r) => r.recall!)).toFixed(2) : '–';
  row.leaks = rs.reduce((a, r) => a + r.leaks, 0);
  row.secondsPerImage = (mean(rs.map((r) => r.ms)) / 1000).toFixed(1);
  return row;
}

const groups: Record<string, Result[]> = {
  'human, package labels': results.filter((r) => r.set === 'human' && r.kind.startsWith('human')),
  'human, pharmacy labels (synthetic)': results.filter((r) => r.kind === 'synthetic-pharmacy'),
  'pet, package labels': results.filter((r) => r.set === 'pet' && r.kind === 'pet'),
  'pet, vet labels (synthetic)': results.filter((r) => r.kind === 'synthetic-vet'),
  'human, all': results.filter((r) => r.set === 'human' && !r.local),
  'pet, all': results.filter((r) => r.set === 'pet' && !r.local),
};
for (const r of results.filter((r) => r.local)) groups[`local photo ${r.id}`] = [r];
for (const v of ['flat', 'vial', 'perspective', 'cylinder', 'blur', 'glare', 'lowlight', 'rotation']) groups[`variant: ${v}`] = results.filter((r) => r.variant === v && !r.local);

const summary = Object.fromEntries(Object.entries(groups).filter(([, rs]) => rs.length).map(([k, rs]) => [k, summarize(rs)]));
const cols = ['images', ...FIELDS, 'keyRecall', 'cer', 'wordPrecision', 'wordRecall', 'leaks', 'secondsPerImage'];
console.log(`\npipeline ${pipelineName}: ${results.length} images in ${((Date.now() - started) / 1000).toFixed(0)} s with ${workerCount} workers\n`);
console.log(`| group | ${cols.join(' | ')} |\n|${' --- |'.repeat(cols.length + 1)}`);
for (const [k, row] of Object.entries(summary)) console.log(`| ${k} | ${cols.map((c) => row[c]).join(' | ')} |`);

await mkdir(`${CACHE}results`, { recursive: true });
await Bun.write(`${CACHE}results/${pipelineName}.json`, JSON.stringify({ reader: readerName, parser: parserName, options: process.env.BENCH_OPTS ?? null, summary, results }, null, 1));
if (args.includes('--save')) {
  await mkdir(new URL('results/', import.meta.url).pathname, { recursive: true });
  // Scores only: no text, no fields, and nothing at all of the local photos (their rows and groups
  // stay in the console and in .cache): which labels a household has is private too.
  const round = (n: number | undefined, places = 3) => (n === undefined ? undefined : Math.round(n * 10 ** places) / 10 ** places);
  const slim = results.filter((r) => !r.local).map(({ text: _t, reading: _r, read: _read, local: _l, ...rest }) => ({
    ...rest, ms: Math.round(rest.ms), keyRecall: round(rest.keyRecall), cer: round(rest.cer), precision: round(rest.precision), recall: round(rest.recall),
  }));
  const shared = Object.fromEntries(Object.entries(summary).filter(([k]) => !k.startsWith('local photo')));
  await Bun.write(new URL(`results/${pipelineName}.json`, import.meta.url).pathname, JSON.stringify({ summary: shared, results: slim }, null, 1) + '\n');
}
process.exit(0);
