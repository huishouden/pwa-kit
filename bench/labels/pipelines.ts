/**
 * What the benchmark compares, in two stages. Reading (`READERS`): `baseline` is the reader as it
 * was before the benchmark existed (kit v0.99.0: the photo scaled to 2000 px, read once with the
 * engine's defaults); `kit` is `readLabelImage` as it is now (options from BENCH_OPTS, JSON, to
 * compare settings). Parsing (`PARSERS`): `directions` is the released `parseDirections` alone (the baseline);
 * `label` is `parseLabel`; `names` adds the on-device medicine names; `fda` adds the NDC lookup.
 */
import sharp from 'sharp';
import { parseDirections, type ParsedCourse } from '../../src/dose';
import { toGray } from '../../src/label-image';
import { codesOf, linesOf, readLabelImage, type LabelLine, type OcrWord, type Psm, type ReadLabelPassOptions, type Recognize } from '../../src/label-read';
import { parseLabel, type LabelCourse } from '../../src/medicine-label';
import type { Reading } from './score';

/** A tesseract.js worker, in Node. */
export interface BenchOcr {
  recognize(image: Buffer, options?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{ data: any }>;
  terminate(): Promise<unknown>;
}

export interface Read {
  text: string;
  lines?: LabelLine[];
  /** The kit reader's words before filtering, so `--reuse` rebuilds lines with the current code. */
  words?: OcrWord[];
  /** The kit reader's digit runs (`LabelReading.codes`). */
  codes?: string[];
  passes: number;
}

export type Reader = (file: string, ocr: BenchOcr) => Promise<Read>;
export type Parser = (read: Read) => Promise<ParsedCourse & { ndc?: string }>;

export function toReading(text: string, p: ParsedCourse & { ndc?: string }): Reading {
  return {
    text,
    name: p.name, strength: p.strength, form: p.form, route: p.route, ndc: p.ndc,
    doseAmount: p.doseAmount, doseUnit: p.doseUnit, timesPerDay: p.timesPerDay, intervalHours: p.intervalHours, asNeeded: p.asNeeded,
    shown: [p.name, p.strength, p.form, p.route, p.dose, ...p.notes].filter((s): s is string => !!s),
    strengthChoices: (p as LabelCourse).strengthChoices,
  };
}

/** The engine's words from a tesseract.js result (`blocks` output). */
export function wordsOf(data: any): OcrWord[] {
  const out: OcrWord[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) out.push({ text: w.text, confidence: w.confidence, box: w.bbox });
  return out;
}

export const nodeRecognize = (ocr: BenchOcr): Recognize => async (bitmap: Uint8Array, psm: Psm) => {
  const { data } = await ocr.recognize(Buffer.from(bitmap), { tessedit_pageseg_mode: psm }, { blocks: true, text: false });
  return { words: wordsOf(data) };
};

export async function grayOf(file: string) {
  const { data, info } = await sharp(file).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return toGray({ width: info.width, height: info.height, data });
}

const benchOptions: ReadLabelPassOptions = process.env.BENCH_OPTS ? JSON.parse(process.env.BENCH_OPTS) : {};

export const READERS: Record<string, Reader> = {
  async baseline(file, ocr) {
    const img = sharp(file);
    const meta = await img.metadata();
    const scale = 2000 / Math.max(meta.width!, meta.height!);
    const buf = scale < 1 ? await img.resize(Math.round(meta.width! * scale), Math.round(meta.height! * scale)).png().toBuffer() : await img.png().toBuffer();
    const { data } = await ocr.recognize(buf);
    return { text: data.text, passes: 1 };
  },
  async kit(file, ocr) {
    const read = await readLabelImage(await grayOf(file), nodeRecognize(ocr), benchOptions);
    return { text: read.text, lines: read.lines, words: read.words, codes: read.codes, passes: read.passes };
  },
};

let names: Promise<typeof import('../../src/medicine-names-match')> | undefined;
const loadNames = () => (names ??= import('../../src/medicine-names-match'));

/** A reused reading's lines rebuilt from its words with the current code (`--reuse`). */
export function relined(r: Read): Read {
  return r.words ? { ...r, ...linesOf(r.words, benchOptions), codes: process.env.BENCH_WORD_CODES ? codesOf(r.words) : (r.codes ?? codesOf(r.words)) } : r;
}

/**
 * `parseDirections` as released before this reader (`BASELINE_REF`, default v0.123.0): the kit's
 * source at that tag, extracted once into `.cache/baseline-src/`, so the baseline stays the
 * baseline while `src/` changes.
 */
let baselineParse: Promise<typeof parseDirections> | undefined;
function baselineDirections(): Promise<typeof parseDirections> {
  baselineParse ??= (async () => {
    const ref = process.env.BASELINE_REF ?? 'v0.123.0';
    const dir = new URL(`.cache/baseline-src/${ref}/`, import.meta.url).pathname;
    if (!(await Bun.file(`${dir}src/dose.ts`).exists())) {
      await Bun.$`mkdir -p ${dir} && git -C ${new URL('../..', import.meta.url).pathname} archive ${ref} src | tar -x -C ${dir}`;
    }
    return (await import(`${dir}src/dose.ts`)).parseDirections;
  })();
  return baselineParse;
}

export const PARSERS: Record<string, Parser> = {
  directions: async (r) => (await baselineDirections())(r.text),
  label: async (r) => parseLabel(r.text, { lines: r.lines }),
  async names(r) {
    const { medicineNames } = await loadNames();
    return parseLabel(r.text, { lines: r.lines, isMedicineName: (await medicineNames()).match });
  },
  async fda(r) {
    const { medicineNames } = await loadNames();
    const { withListing } = await import('../../src/medicine-lookup');
    const course: LabelCourse = parseLabel(r.text, { lines: r.lines, isMedicineName: (await medicineNames()).match });
    return withListing(course, { fetch: cachedFetch, names: await medicineNames(), text: r.text, codes: r.codes });
  },
};

/** The lookups' fetch, answered from disk after the first time (bench runs stay repeatable and offline). */
async function cachedFetch(url: string): Promise<Response> {
  const key = new Bun.CryptoHasher('sha1').update(url).digest('hex');
  const file = Bun.file(new URL(`.cache/http/${key}.json`, import.meta.url).pathname);
  if (await file.exists()) {
    const { status, body } = await file.json();
    return new Response(body, { status });
  }
  const r = await fetch(url);
  const body = await r.text();
  if (r.status < 500) await Bun.write(file, JSON.stringify({ url, status: r.status, body }));
  return new Response(body, { status: r.status });
}
