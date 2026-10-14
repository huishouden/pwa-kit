/**
 * Phone-like photos made from the flat label scans: the label on a cloth or wood background, then
 * one effect each: perspective, a curved bottle (cylinder), blur, glare, low light, rotation.
 * Synthetic pharmacy and vet labels are also put on a vial with the neighbours' labels showing at
 * both sides. Deterministic (seeded by the label id). Writes `.cache/set/` and `.cache/set.json`.
 */
import sharp from 'sharp';
import { mkdir, rm } from 'node:fs/promises';
import { CACHE, corpus, type Label } from './fetch';

export const EFFECTS = ['perspective', 'cylinder', 'blur', 'glare', 'lowlight', 'rotation'] as const;
export type Variant = 'flat' | 'vial' | (typeof EFFECTS)[number];

interface Raw {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

async function load(input: string | Buffer): Promise<Raw> {
  const { data, info } = await sharp(input).flatten({ background: '#ffffff' }).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

const png = (r: Raw) => sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length), { raw: { width: r.width, height: r.height, channels: 4 } }).png();

/** A cloth (stripes), wood (grain) or plain (noise) surface. */
function background(width: number, height: number, rand: () => number): Raw {
  const data = new Uint8ClampedArray(width * height * 4);
  const kind = Math.floor(rand() * 3);
  const base = kind === 0 ? [178, 182, 160] : kind === 1 ? [150, 110, 70] : [120, 120, 125];
  const period = 40 + rand() * 80;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let f = 1;
      if (kind === 0) f = Math.sin((y / period) * Math.PI * 2) > 0.2 ? 1.25 : 0.95; // cloth stripes, like a tea towel
      if (kind === 1) f = 0.9 + 0.15 * Math.sin(y / 9 + Math.sin(x / 140) * 3);
      const n = (rand() - 0.5) * 30 + (kind === 0 && (x + y) % 6 < 2 ? 12 : 0); // weave
      const i = (y * width + x) * 4;
      data[i] = base[0] * f + n;
      data[i + 1] = base[1] * f + n;
      data[i + 2] = base[2] * f + n;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function sample(src: Raw, x: number, y: number, out: Uint8ClampedArray, o: number, shade = 1): boolean {
  if (x < 0 || y < 0 || x > src.width - 1 || y > src.height - 1) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, src.width - 1), y1 = Math.min(y0 + 1, src.height - 1);
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = src.data[(y0 * src.width + x0) * 4 + c], b = src.data[(y0 * src.width + x1) * 4 + c];
    const d = src.data[(y1 * src.width + x0) * 4 + c], e = src.data[(y1 * src.width + x1) * 4 + c];
    out[o + c] = ((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy) * shade;
  }
  out[o + 3] = 255;
  return true;
}

/** Homography mapping the unit square's corners to `q` (4 points), inverted for sampling. */
function homography(q: [number, number][]): number[] {
  // Square-to-quad (Heckbert).
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  // Inverse (adjugate).
  return [e - f * h, c * h - b, b * f - c * e, f * g - d, a - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
}

/** Draws `label` onto `bg` inside the quad `q` (top-left, top-right, bottom-right, bottom-left). */
function warpQuad(bg: Raw, label: Raw, q: [number, number][]) {
  const m = homography(q);
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(bg.height, Math.ceil(Math.max(...ys))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(bg.width, Math.ceil(Math.max(...xs))); x++) {
      const w = m[6] * x + m[7] * y + m[8];
      const u = (m[0] * x + m[1] * y + m[2]) / w, v = (m[3] * x + m[4] * y + m[5]) / w;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      sample(label, u * (label.width - 1), v * (label.height - 1), bg.data, (y * bg.width + x) * 4);
    }
  }
}

/**
 * Draws `label` wrapped round a vertical cylinder whose visible face spans `w` px from `left`,
 * `top`, seen slightly from above (lines bow), with the shading of a round bottle. `arc` is the
 * share of the label's width that faces the camera.
 */
function wrapCylinder(bg: Raw, label: Raw, left: number, top: number, w: number, arc: number, tilt: number, tint?: number[]) {
  const R = w / 2;
  const theta = Math.min(1.45, (arc * Math.PI) / 2); // half-angle of label shown
  const scale = (label.width * 1) / (2 * theta * R); // label px per arc px
  const h = label.height / scale;
  for (let x = 0; x < w; x++) {
    const s = (x - R) / R; // -1..1 across the bottle
    const ang = Math.asin(Math.max(-1, Math.min(1, s)));
    const shade = 0.55 + 0.45 * Math.cos(ang) ** 0.6;
    const u = label.width / 2 + ang * R * scale;
    const bow = tilt * (1 - Math.cos(ang)) * h;
    for (let y = -Math.ceil(tilt * h); y < h + Math.ceil(tilt * h); y++) {
      const by = Math.round(top + y), bx = Math.round(left + x);
      if (bx < 0 || by < 0 || bx >= bg.width || by >= bg.height) continue;
      const o = (by * bg.width + bx) * 4;
      const v = (y - bow) * scale;
      if (Math.abs(ang) <= theta && u >= 0 && u <= label.width - 1 && v >= 0 && v <= label.height - 1) {
        sample(label, u, v, bg.data, o, shade);
      } else if (tint && y >= -tilt * h * 0.2 && y < h * 1.05) {
        // The vial itself beside and around the label.
        bg.data[o] = tint[0] * shade;
        bg.data[o + 1] = tint[1] * shade;
        bg.data[o + 2] = tint[2] * shade;
      }
    }
  }
}

function lowLight(r: Raw, rand: () => number) {
  for (let i = 0; i < r.data.length; i += 4) {
    const n = (rand() - 0.5) * 34;
    r.data[i] = 255 * (r.data[i] / 255) ** 1.9 * 0.62 + n;
    r.data[i + 1] = 255 * (r.data[i + 1] / 255) ** 1.9 * 0.55 + n;
    r.data[i + 2] = 255 * (r.data[i + 2] / 255) ** 1.9 * 0.42 + n;
  }
}

function glare(r: Raw, rand: () => number) {
  const cx = r.width * (0.3 + rand() * 0.4), cy = r.height * (0.3 + rand() * 0.4);
  const rx = r.width * (0.18 + rand() * 0.12), ry = r.height * (0.1 + rand() * 0.1);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d > 4) continue;
      const a = Math.min(0.92, 1.15 * Math.exp(-d * 1.1));
      const i = (y * r.width + x) * 4;
      for (let c = 0; c < 3; c++) r.data[i + c] = r.data[i + c] * (1 - a) + 255 * a;
    }
  }
}

/** The label on a surface, at roughly phone resolution (longer side ~2400 px). */
function onSurface(label: Raw, rand: () => number, fill = 0.72): { bg: Raw; quad: [number, number][] } {
  const long = 2400;
  const aspect = label.width / label.height;
  const W = aspect >= 1 ? long : Math.round(long * Math.max(0.62, aspect / fill));
  const H = aspect >= 1 ? Math.round(long * Math.max(0.62, 1 / aspect / fill)) : long;
  const lw = Math.min(W * fill, H * fill * aspect), lh = lw / aspect;
  const x = (W - lw) / 2 + (rand() - 0.5) * (W - lw) * 0.5, y = (H - lh) / 2 + (rand() - 0.5) * (H - lh) * 0.5;
  return { bg: background(W, H, rand), quad: [[x, y], [x + lw, y], [x + lw, y + lh], [x, y + lh]] };
}

export async function makeVariant(file: string, id: string, variant: Variant, neighbours: string[] = []): Promise<Buffer> {
  const rand = rng(`${id}:${variant}`);
  if (variant === 'flat') return sharp(file).png().toBuffer();
  const label = await load(file);
  if (variant === 'vial') {
    // A pharmacy vial: amber (or green for the vet), label wrapped round it, the labels of the
    // bottles beside it showing at both edges.
    const W = 1800, H = 2400;
    const bg = background(W, H, rand);
    const vet = id.includes('vet');
    const tint = vet ? [70, 140, 90] : [190, 120, 40];
    for (const [k, side] of [[0, -1], [1, 1]] as const) {
      const n = neighbours[k];
      if (!n) continue;
      const other = await load(n);
      wrapCylinder(bg, other, side < 0 ? -W * 0.42 : W * 0.86, H * 0.28 + rand() * 120, W * 0.56, 0.9, 0.04, tint);
    }
    wrapCylinder(bg, label, W * 0.1, H * 0.3, W * 0.8, 0.82, 0.06, tint);
    return png(bg).toBuffer();
  }
  if (variant === 'cylinder') {
    const { bg } = onSurface(label, rand);
    const w = bg.width * 0.82;
    const aspect = label.width / label.height;
    // A round bottle shows about 70% of a wide label; tall labels are cartons (less curve).
    wrapCylinder(bg, label, (bg.width - w) / 2, bg.height * 0.2, w, aspect > 1.4 ? 0.7 : 0.85, 0.05);
    return png(bg).toBuffer();
  }
  const { bg, quad } = onSurface(label, rand);
  if (variant === 'perspective') {
    const j = () => (rand() - 0.5) * 0.22;
    const [w, h] = [quad[1][0] - quad[0][0], quad[3][1] - quad[0][1]];
    const q = quad.map(([x, y], k) => [x + j() * w * (k % 3 === 0 ? 1 : -1), y + j() * h] as [number, number]);
    warpQuad(bg, label, q);
    return png(bg).toBuffer();
  }
  warpQuad(bg, label, quad);
  if (variant === 'blur') return png(bg).blur(2.2 + rand() * 1.5).jpeg({ quality: 70 }).toBuffer();
  if (variant === 'glare') {
    glare(bg, rand);
    return png(bg).toBuffer();
  }
  if (variant === 'lowlight') {
    lowLight(bg, rand);
    return png(bg).blur(0.8).jpeg({ quality: 75 }).toBuffer();
  }
  // Rotation: a quarter or half turn (a photo taken sideways, with no orientation tag) and a tilt.
  const turn = [90, 180, 270][Math.floor(rand() * 3)];
  const angle = turn + (rand() - 0.5) * 16;
  return png(bg).rotate(angle, { background: '#777777' }).toBuffer();
}

export interface SetItem {
  file: string;
  id: string;
  variant: Variant;
}

if (import.meta.main) {
  const labels: Label[] = [...(await corpus()), ...(await Bun.file(`${CACHE}synthetic.json`).json())];
  await rm(`${CACHE}set`, { recursive: true, force: true });
  await mkdir(`${CACHE}set`, { recursive: true });
  const items: SetItem[] = [];
  const synthetic = labels.filter((l) => l.id.startsWith('syn-'));
  let k = 0;
  for (const l of labels) {
    const src = `${CACHE}src/${l.id}.png`;
    let variants: Variant[];
    if (l.id.startsWith('syn-')) {
      variants = ['flat', 'vial', EFFECTS[(k + 2) % EFFECTS.length], EFFECTS[(k + 4) % EFFECTS.length]];
    } else {
      // Each effect used equally across the corpus: three per label, rotating.
      variants = ['flat', EFFECTS[k % 6], EFFECTS[(k + 1) % 6], EFFECTS[(k + 3) % 6]];
    }
    k++;
    const others = synthetic.filter((s) => s.id !== l.id).map((s) => `${CACHE}src/${s.id}.png`);
    const neighbours = [others[k % others.length], others[(k + 5) % others.length]];
    for (const variant of variants) {
      const file = `${CACHE}set/${l.id}~${variant}.${variant === 'blur' || variant === 'lowlight' ? 'jpg' : 'png'}`;
      await Bun.write(file, await makeVariant(src, l.id, variant, neighbours));
      items.push({ file, id: l.id, variant });
    }
  }
  await Bun.write(`${CACHE}set.json`, JSON.stringify(items, null, 1));
  console.log(items.length, 'images');
}
