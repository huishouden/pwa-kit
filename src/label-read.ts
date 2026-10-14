/**
 * Reading a medicine label from a photo: the OCR passes, the choice of orientation, and the
 * clean-up of what the engine returns, before `./dose` parses it. Pure apart from the engine
 * (`Recognize`), so the benchmark (bench/labels) runs exactly this in Node.
 *
 * What it does, each step kept because it measured better on the label benchmark
 * (bench/labels/README.md):
 * - greyscale, levels stretched, light-on-dark turned dark-on-light;
 * - small photos scaled up and large ones down, so print lands near the size the engine reads best;
 * - read as sparse text (page segmentation 11), which finds label text scattered between pictures,
 *   barcodes and the table cloth; when that finds little, read again as a page (3) and the words
 *   of both merged, the surer kept;
 * - a photo with little readable text is tried in the other three quarter turns;
 * - words the engine is unsure of are dropped (its per-word confidence), and lines are rebuilt
 *   from the words' positions, following a line that bends round a bottle;
 * - digits and units the engine confuses (O/0, l/1, S/5, "rng") are put right where a word is
 *   clearly a number.
 * Local contrast (CLAHE), black and white (Sauvola) and a second, zoomed read of the text area
 * are options, off: they did not help overall.
 */

import { clahe, crop, darkOnLight, rotate, sauvola, scale, stretch, toBmp, type Box, type Gray } from './label-image';

export interface OcrWord {
  text: string;
  /** 0..100, the engine's. */
  confidence: number;
  box: Box;
}

/** One reading of an image: every word the engine found, with where it is. */
export interface OcrPage {
  words: OcrWord[];
}

/** Page segmentation modes used: 3 (a page, laid out automatically), 11 (sparse text, no order). */
export type Psm = '3' | '6' | '11';

/** Reads a bitmap (`toBmp`) with the given page segmentation mode. */
export type Recognize = (bitmap: Uint8Array, psm: Psm) => Promise<OcrPage>;

/** One line of the label as read: its words, how sure the engine was, and how tall its print is. */
export interface LabelLine {
  text: string;
  /** Mean word confidence, 0..100. */
  confidence: number;
  /** Median height of its words in pixels of the read image: the bigger print is the medicine's name. */
  height: number;
  box: Box;
}

export interface LabelReading {
  text: string;
  lines: LabelLine[];
  /** Every word the passes found, before the unsure ones were dropped (`linesOf` rebuilds the lines). */
  words: OcrWord[];
  /**
   * Runs of digits read on the label, sure or not ("24208-9102"), that may be its NDC: for
   * `./medicine-lookup` to match against the FDA's listing. They stay on the device.
   */
  codes: string[];
  /** Quarter turns clockwise the photo was read at. */
  turns: number;
  /** OCR passes run. */
  passes: number;
}

export interface ReadLabelPassOptions {
  /** Longest side the photo is scaled to. Default 2000. */
  maxSide?: number;
  /** Shortest longest side: smaller photos are scaled up to it. Default 1600. */
  minSide?: number;
  /** Local contrast (CLAHE) before reading. Default false: on the benchmark it helped pet boxes and hurt as much elsewhere. */
  clahe?: boolean;
  /** Black and white (Sauvola) before reading. Default false. */
  binarize?: boolean;
  /** The passes, in order; their words are merged. Default ['11', '3']. */
  psms?: Psm[];
  /** Passes after the first with local contrast (CLAHE) instead, whatever `clahe` says. Default none. */
  claheAlso?: Psm[];
  /** Run the passes after the first only when the first found less sure text than this (`readingScore`). Default 250: same accuracy, a quarter faster. */
  morePassesBelow?: number;
  /** Try the other quarter turns when the first reading finds little. Default true. */
  turns?: boolean;
  /** Words below this confidence are dropped (unless their line is sure). Default 50. */
  minWordConfidence?: number;
  /** Lines whose mean confidence is below this are dropped. Default 45. */
  minLineConfidence?: number;
  /** Read again, larger, inside the area where the text was found when it is a small part of the photo. Default false: no gain on the benchmark. */
  zoom?: boolean;
  /** When no clear NDC was read but a long run of digits was, read once more with local contrast for its digits. Default true. */
  codePass?: boolean;
  /** Fix O/0, l/1, S/5 and unit misreadings in numbers. Default true. */
  fixNumbers?: boolean;
  /** Called before each pass with the pass number (from 1) and the total planned. */
  onPass?: (pass: number, total: number) => void;
}

const DEFAULTS: Required<Omit<ReadLabelPassOptions, 'onPass'>> = {
  maxSide: 2000,
  minSide: 1600,
  clahe: false,
  binarize: false,
  psms: ['11', '3'],
  claheAlso: [],
  morePassesBelow: 250,
  turns: true,
  minWordConfidence: 50,
  minLineConfidence: 45,
  zoom: false,
  codePass: true,
  fixNumbers: true,
};

const alnum = (s: string) => (s.match(/[a-z0-9]/gi) ?? []).length;

/** How much sure, real text a reading holds: letters and digits of the words read with confidence. */
export function readingScore(words: OcrWord[]): number {
  let score = 0;
  for (const w of words) {
    const n = alnum(w.text);
    if (w.confidence >= 70 && n >= 2) score += n;
  }
  return score;
}

const overlap = (a: Box, b: Box) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const area = (r: Box) => Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
  return inter / Math.min(area(a), area(b));
};

/** The words of several readings of one image: where two overlap, the surer one. */
export function mergeWords(pages: OcrWord[][]): OcrWord[] {
  const out: OcrWord[] = [];
  for (const words of pages) {
    for (const w of words) {
      const i = out.findIndex((o) => overlap(o.box, w.box) > 0.5);
      if (i < 0) out.push(w);
      else if (w.confidence > out[i].confidence) out[i] = w;
    }
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Words regrouped into lines: same band of height, close enough along it; top to bottom, left to right. */
export function wordsToLines(words: OcrWord[]): LabelLine[] {
  return groupLines(words).map(lineOf).sort(readingOrder);
}

const readingOrder = (a: LabelLine, b: LabelLine) => (Math.abs(a.box.y0 - b.box.y0) < Math.min(a.height, b.height) * 0.5 ? a.box.x0 - b.box.x0 : a.box.y0 - b.box.y0);

function lineOf(ws: OcrWord[]): LabelLine {
  ws.sort((a, b) => a.box.x0 - b.box.x0);
  const box = { x0: Math.min(...ws.map((w) => w.box.x0)), y0: Math.min(...ws.map((w) => w.box.y0)), x1: Math.max(...ws.map((w) => w.box.x1)), y1: Math.max(...ws.map((w) => w.box.y1)) };
  return {
    text: ws.map((w) => w.text).join(' '),
    confidence: ws.reduce((a, w) => a + w.confidence, 0) / ws.length,
    height: median(ws.map((w) => w.box.y1 - w.box.y0)),
    box,
  };
}

/**
 * Words chained into lines left to right: a word continues the line whose last word ends just
 * before it at the same height. Following the neighbour rather than the line's average height
 * keeps a line together when it bends round a bottle or slopes in a tilted photo.
 */
function groupLines(words: OcrWord[]): OcrWord[][] {
  const sorted = [...words].sort((a, b) => a.box.x0 - b.box.x0);
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const h = w.box.y1 - w.box.y0;
    const cy = (w.box.y0 + w.box.y1) / 2;
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const last = lines[i][lines[i].length - 1];
      const lh = last.box.y1 - last.box.y0;
      const ly = (last.box.y0 + last.box.y1) / 2;
      const gap = w.box.x0 - last.box.x1;
      const m = Math.max(h, lh);
      if (gap > m * 2.5 || gap < -m * 0.5 || m > Math.min(h, lh) * 2.2) continue;
      const dy = Math.abs(cy - ly);
      if (dy > Math.min(h, lh) * 0.6) continue;
      const cost = dy * 3 + Math.max(0, gap);
      if (cost < bestCost) {
        best = i;
        bestCost = cost;
      }
    }
    if (best >= 0) lines[best].push(w);
    else lines.push([w]);
  }
  return lines;
}

const DIGITISH: Record<string, string> = { O: '0', o: '0', D: '0', Q: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };

/**
 * A word with the engine's usual confusions in numbers put right: "1O mg" -> "10 mg", "2.5rng" ->
 * "2.5mg", "NOC 6800l-332" -> "NDC 68001-332". Letters are only turned into digits inside a run
 * that is mostly digits already, so words stay words.
 */
export function fixNumberWord(word: string): string {
  let w = word.replace(/^(?:N[O0D]C|NOG|MDC|NDG|KDC|HDC|WDC|NBC|NDO|NC)(?=[#:\s\d]|$)/, 'NDC');
  w = w.replace(/(\d)\s?(?:rng|rnq|mq|m9|rn9|mgs?\.)(?![a-z0-9])/gi, '$1mg').replace(/^m9(?=\/)/i, 'mg').replace(/(\d)\s?(?:rncg|mcq)\b/gi, '$1mcg').replace(/(\d)\s?(?:rnl|rnL)\b/g, '$1mL');
  return w.replace(/[0-9OoDQlIi|!SsBZz.,\-/]{2,}/g, (run) => {
    const digits = (run.match(/\d/g) ?? []).length;
    const letters = run.length - digits - (run.match(/[.,\-/]/g) ?? []).length;
    if (digits < 2 || letters > digits / 2 || letters === 0) return run;
    return run.replace(/[OoDQlIi|!SsBZz]/g, (c) => DIGITISH[c]);
  });
}

function cleanWords(words: OcrWord[], o: typeof DEFAULTS): OcrWord[] {
  const kept: OcrWord[] = [];
  for (const w of words) {
    const text = (o.fixNumbers ? fixNumberWord(w.text) : w.text).trim();
    if (!text || alnum(text) === 0) continue;
    kept.push({ ...w, text });
  }
  return kept;
}

function filterLines(words: OcrWord[], o: typeof DEFAULTS): LabelLine[] {
  // Lines first (a weak word inside a sure line stays), then drop what is noise.
  const out: LabelLine[] = [];
  for (const ws of groupLines(words)) {
    const line = lineOf(ws);
    if (line.confidence < o.minLineConfidence) continue;
    const keep = ws.filter((w) => w.confidence >= o.minWordConfidence || (line.confidence >= 75 && alnum(w.text) >= 2));
    if (!keep.some((w) => alnum(w.text) >= 2)) continue;
    out.push(lineOf(keep));
  }
  return out.sort(readingOrder);
}

/** The area holding the sure words, with a margin; null when that is most of the image anyway. */
function textArea(words: OcrWord[], img: Gray): Box | null {
  const sure = words.filter((w) => w.confidence >= 70 && alnum(w.text) >= 2);
  if (sure.length < 3) return null;
  const x0 = Math.min(...sure.map((w) => w.box.x0)), y0 = Math.min(...sure.map((w) => w.box.y0));
  const x1 = Math.max(...sure.map((w) => w.box.x1)), y1 = Math.max(...sure.map((w) => w.box.y1));
  const mx = (x1 - x0) * 0.12 + 20, my = (y1 - y0) * 0.12 + 20;
  const box = { x0: Math.max(0, x0 - mx), y0: Math.max(0, y0 - my), x1: Math.min(img.width, x1 + mx), y1: Math.min(img.height, y1 + my) };
  const share = ((box.x1 - box.x0) * (box.y1 - box.y0)) / (img.width * img.height);
  return share < 0.45 ? box : null;
}

/**
 * The label's text from a greyscale photo, with each line's confidence and print size. See the
 * module comment for the steps.
 */
export async function readLabelImage(gray: Gray, recognize: Recognize, options: ReadLabelPassOptions = {}): Promise<LabelReading> {
  const o = { ...DEFAULTS, ...options };
  let passes = 0;
  const planned = o.psms.length + (o.zoom ? 1 : 0);
  const run = async (img: Gray, psm: Psm) => {
    passes++;
    options.onPass?.(passes, Math.max(planned, passes));
    return (await recognize(toBmp(img), psm)).words;
  };

  let base = darkOnLight(stretch(gray));
  const long = Math.max(base.width, base.height);
  if (long > o.maxSide) base = scale(base, o.maxSide / long);
  else if (long < o.minSide) base = scale(base, o.minSide / long);
  const prep = (img: Gray) => {
    const contrast = o.clahe ? clahe(img) : img;
    return o.binarize ? sauvola(contrast) : contrast;
  };

  let img = prep(base);
  let first = await run(img, o.psms[0]);
  let turns = 0;
  if (o.turns && readingScore(first) < 40) {
    // Sideways or upside down: compare the other turns on a smaller copy, keep the best.
    const small = scale(img, Math.min(1, 1000 / Math.max(img.width, img.height)));
    let best = readingScore(await run(small, '11'));
    for (const q of [1, 3, 2]) {
      const s = readingScore(await run(rotate(small, q), '11'));
      if (s > best * 1.5 && s >= 15) {
        best = s;
        turns = q;
      }
    }
    if (turns) {
      img = rotate(img, turns);
      first = await run(img, o.psms[0]);
    }
  }
  const pages = [first];
  if (readingScore(first) < o.morePassesBelow) {
    for (const psm of o.psms.slice(1)) pages.push(await run(img, psm));
    if (o.claheAlso.length) {
      const contrast = clahe(turns ? rotate(base, turns) : base);
      for (const psm of o.claheAlso) pages.push(await run(contrast, psm));
    }
  }
  let words = mergeWords(pages);

  if (o.zoom) {
    const area = textArea(words, img);
    if (area) {
      // The label is a small part of the photo: read that part again at a larger size.
      const part = crop(turns ? rotate(base, turns) : base, area);
      const factor = Math.min(o.maxSide / Math.max(part.width, part.height), 3);
      const zoomed = prep(scale(part, factor));
      const again = await run(zoomed, o.psms[0]);
      if (readingScore(again) > readingScore(words)) {
        const back = (w: OcrWord): OcrWord => ({
          ...w,
          box: { x0: area.x0 + w.box.x0 / factor, y0: area.y0 + w.box.y0 / factor, x1: area.x0 + w.box.x1 / factor, y1: area.y0 + w.box.y1 / factor },
        });
        words = mergeWords([again.map(back), words]);
      }
    }
  }

  const read = linesOf(words, options);
  let codes = codesOf(words);
  if (o.codePass && !NDC_SHAPE.test(read.text) && codes.some((c) => digitCount(c) >= 8)) {
    // An NDC is small print, often on a coloured band or round a curve: local contrast reads its
    // digits better (measured on the label benchmark), at no cost to the rest of the reading.
    codes = [...new Set([...codesOf(await run(clahe(turns ? rotate(base, turns) : base), '11')), ...codes])].slice(0, MAX_CODES);
  }
  return { ...read, words, codes, turns, passes };
}

const NDC_SHAPE = /(?<![\d-])\d{4,5}-\d{3,4}-\d{1,2}(?![\d-])/;
const MAX_CODES = 8;
const digitCount = (s: string) => (s.match(/\d/g) ?? []).length;

/**
 * Runs of digits on each line of every word read, sure or not (numbers fixed as in `fixNumberWord`,
 * spaces dropped, dashes kept): "NDC 24208-9102" gives "24208-9102". Eight digits or more, the
 * longest first; an NDC has ten or eleven.
 */
export function codesOf(words: OcrWord[]): string[] {
  const out = new Set<string>();
  for (const line of groupLines(words)) {
    const text = line.map((w) => fixNumberWord(w.text)).join(' ');
    for (const m of text.matchAll(/\d[\d\s\-‐‑–—]*\d/g)) {
      const run = m[0].replace(/\s+/g, '').replace(/[‐‑–—]/g, '-').replace(/-{2,}/g, '-');
      if (digitCount(run) >= 8 && digitCount(run) <= 14) out.add(run);
    }
  }
  return [...out].sort((a, b) => digitCount(b) - digitCount(a)).slice(0, MAX_CODES);
}

/** The label's lines from the words the passes found: confusions fixed, unsure words and noise dropped. */
export function linesOf(words: OcrWord[], options: Omit<ReadLabelPassOptions, 'onPass'> = {}): { text: string; lines: LabelLine[] } {
  const o = { ...DEFAULTS, ...options };
  const lines = filterLines(cleanWords(words, o), o);
  return { text: lines.map((l) => l.text).join('\n'), lines };
}
