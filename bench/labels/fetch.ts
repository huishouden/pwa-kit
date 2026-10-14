/**
 * Downloads the public label images listed in `corpus.json` from DailyMed into `.cache/src/`,
 * cut to the label (`crop`, pixels of the original) and scaled so the longer side is at least
 * 1400 px, as a phone photo of the same label would be. Images are never committed.
 */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

export const CACHE = new URL('.cache/', import.meta.url).pathname;

export interface Truth {
  names: string[];
  strength: string | string[] | null;
  form: string;
  route: string;
  ndc: string | null;
  directions?: { dose?: string; timesPerDay?: number; intervalHours?: number; asNeeded?: boolean };
  /** Strings that must never appear in a medicine field (synthetic patient, owner, prescriber, address). */
  private?: string[];
  /** The label's full text, where known, for the character error rate. */
  text?: string;
}

export interface Label {
  id: string;
  set: 'human' | 'pet';
  kind: string;
  source: string;
  image?: string;
  crop?: [number, number, number, number];
  truth: Truth;
}

export async function corpus(): Promise<Label[]> {
  return (await Bun.file(new URL('corpus.json', import.meta.url)).json()).labels;
}

async function fetchRetry(url: string): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.arrayBuffer();
    if (attempt >= 3) throw new Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
}

if (import.meta.main) {
  await mkdir(`${CACHE}src`, { recursive: true });
  for (const label of await corpus()) {
    const out = `${CACHE}src/${label.id}.png`;
    if (await Bun.file(out).exists()) continue;
    let img = sharp(Buffer.from(await fetchRetry(label.image!))).flatten({ background: '#ffffff' });
    if (label.crop) {
      const [left, top, width, height] = label.crop;
      img = sharp(await img.extract({ left, top, width, height }).png().toBuffer());
    }
    const meta = await img.metadata();
    const long = Math.max(meta.width!, meta.height!);
    if (long < 1400) img = img.resize({ width: Math.round((meta.width! * 1400) / long), kernel: 'lanczos3' });
    await img.png().toFile(out);
    console.log(label.id);
  }
}
