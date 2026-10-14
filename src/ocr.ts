/**
 * On-device text recognition for photos and screenshots: open-source OCR (tesseract.js, English),
 * nothing uploaded or stored. Used by the medicine-label reader (`./dose` `readLabel`) and the
 * business-listing reader (`./places` `readPlaceScreenshot`); one engine is shared between them.
 *
 * Where the engine's files come from: tesseract.js itself (`TESSERACT_URL`), its worker and its
 * WebAssembly core from jsDelivr at a pinned version, and the English language data from the pinned
 * package below (about 2 MB, gzipped). Nothing is bundled into the app, so an app needs no
 * dependency for it and downloads nothing until someone reads an image. The language data is kept in IndexedDB after the
 * first read; with `pwaApp({ ocr: true })` the service worker also caches the worker and core, so
 * reading works offline after the first use. To self-host instead, copy the files into the app's
 * `public/` and pass their paths as `{ paths }`.
 */
import { toGray, type Box, type Gray } from './label-image';
import { readLabelImage, type LabelReading, type OcrWord, type ReadLabelPassOptions, type Recognize } from './label-read';

export const OCR_LANG_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int';

/** The tesseract.js release used; kept equal to the kit's devDependency (a test checks). */
export const TESSERACT_VERSION = '7.0.0';
export const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.esm.min.js`;

export interface ReadTextOptions {
  /** Self-hosted engine files: `enginePath` (tesseract.esm.min.js), `workerPath`, `corePath`, `langPath` (see OCR_LANG_PATH). */
  paths?: { enginePath?: string; workerPath?: string; corePath?: string; langPath?: string };
  /** 0..1 while the engine loads and reads. */
  onProgress?: (progress: number, status: string) => void;
  /** Longest side the image is scaled down to before reading (phone photos are slow at full size). Default 2000. */
  maxSide?: number;
  /**
   * Prepares a phone screenshot: drops the status bar of a tall image, scales small text up, and
   * turns a dark-mode screen into dark text on light, which the engine reads far better.
   */
  screenshot?: boolean;
}

type OcrWorker = {
  recognize(image: unknown, options?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{ data: { text: string; blocks?: OcrBlock[] | null } }>;
  terminate(): Promise<unknown>;
};
type OcrBlock = { paragraphs: { lines: { words: { text: string; confidence: number; bbox: Box }[] }[] }[] };
let worker: Promise<OcrWorker> | null = null;
let progressListener: ReadTextOptions['onProgress'];

/**
 * The text in an image, read on the device. The engine is loaded on first use only, so apps that
 * never call this don't download it.
 */
export async function readImageText(image: Blob, options: ReadTextOptions = {}): Promise<string> {
  const ocr = await engine(options);
  const prepared = options.screenshot ? await prepareScreenshot(image, options.maxSide ?? 2800) : await downscale(image, options.maxSide ?? 2000);
  const { data } = await ocr.recognize(prepared);
  return data.text;
}

/** The shared engine, started on first use. */
async function engine(options: Pick<ReadTextOptions, 'paths' | 'onProgress'>): Promise<OcrWorker> {
  progressListener = options.onProgress;
  if (!worker) {
    worker = (async () => {
      const { enginePath = TESSERACT_URL, ...paths } = options.paths ?? {};
      // Loaded from its URL rather than bundled, so apps that never read images carry none of it.
      const engine = await import(/* @vite-ignore */ enginePath);
      const { createWorker } = (engine.default ?? engine) as { createWorker: (...args: unknown[]) => Promise<unknown> };
      return (await createWorker('eng', 1, {
        langPath: OCR_LANG_PATH,
        ...paths,
        logger: (m: { progress: number; status: string }) => progressListener?.(m.progress, m.status),
      })) as unknown as OcrWorker;
    })();
    worker.catch(() => (worker = null));
  }
  return worker;
}

export interface ReadLabelLinesOptions extends Pick<ReadTextOptions, 'paths' | 'onProgress'>, Omit<ReadLabelPassOptions, 'onPass'> {}

/**
 * A label photo read the careful way (`./label-read`): several passes, the right way up, unsure
 * words dropped, each line with its confidence and print size. Slower than `readImageText` (two
 * to four passes); progress runs once from 0 to 1 over all of them.
 */
export async function readLabelLines(image: Blob, options: ReadLabelLinesOptions = {}): Promise<LabelReading> {
  const { paths, onProgress, ...passOptions } = options;
  let pass = 1;
  let total = 2;
  const ocr = await engine({ paths, onProgress: (p, status) => onProgress?.(Math.min(1, (pass - 1 + (status === 'recognizing text' ? p : 0)) / total), status) });
  const gray = await grayPixels(image, Math.max(passOptions.maxSide ?? 2000, 1));
  const recognize: Recognize = async (bitmap, psm) => {
    const { data } = await ocr.recognize(bitmap, { tessedit_pageseg_mode: psm }, { blocks: true, text: false });
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) words.push({ text: w.text, confidence: w.confidence, box: w.bbox });
    return { words };
  };
  return readLabelImage(gray, recognize, { ...passOptions, onPass: (n, of) => ((pass = n), (total = of)) });
}

/** The photo's pixels in grey, scaled to at most `maxSide` on its longer side while decoding (orientation as shot). */
async function grayPixels(image: Blob, maxSide: number): Promise<Gray> {
  if (!canDraw()) throw new Error('Reading a photo needs createImageBitmap and OffscreenCanvas');
  const bitmap = await createImageBitmap(image);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return toGray(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/** Stops the OCR engine and frees its memory; the next read starts it again. */
export async function releaseOcr(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await (await w).terminate().catch(() => {});
}

const canDraw = () => typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';

async function downscale(image: Blob, maxSide: number): Promise<Blob> {
  if (!canDraw()) return image;
  const bitmap = await createImageBitmap(image);
  const scale = maxSide / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) {
    bitmap.close();
    return image;
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Where to cut and how far to scale a screenshot of `width` × `height` (pure, for tests). */
export function screenshotFrame(width: number, height: number, maxSide = 2800): { top: number; height: number; scale: number } {
  // A phone screen is at least 1.6 times taller than wide; its top ~5% is the clock and battery.
  const top = height / width >= 1.6 ? Math.round(height * 0.05) : 0;
  const h = height - top;
  // Text on a 1x screenshot is too small to read; 2x/3x screens are about 1080+ px wide already.
  const scale = Math.min(Math.max(1, 1080 / width), maxSide / Math.max(width, h));
  return { top, height: h, scale };
}

async function prepareScreenshot(image: Blob, maxSide: number): Promise<Blob> {
  if (!canDraw()) return image;
  const bitmap = await createImageBitmap(image);
  const frame = screenshotFrame(bitmap.width, bitmap.height, maxSide);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * frame.scale), Math.round(frame.height * frame.scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, frame.top, bitmap.width, frame.height, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  toReadableGray(pixels.data);
  ctx.putImageData(pixels, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Greyscale in place, inverted when the image is mostly dark (dark mode), so text is dark on light. */
export function toReadableGray(rgba: Uint8ClampedArray): void {
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    rgba[i] = rgba[i + 1] = rgba[i + 2] = y;
    sum += y;
  }
  if (sum / (rgba.length / 4) >= 110) return;
  for (let i = 0; i < rgba.length; i += 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = 255 - rgba[i];
}
