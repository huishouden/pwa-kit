/**
 * QR codes made on the device (ISO/IEC 18004, byte mode, versions 1 to 40), for "Share Huishouden"'s
 * code that someone standing next to you scans. No library and no QR service: nothing leaves the
 * page. `qrCode` gives the modules, `qrSvg` an SVG of them for any size on screen.
 *
 * ```ts
 * const svg = qrSvg('https://example.web.app/', { label: 'QR code for example.web.app' });
 * ```
 */

/** Error correction: L recovers about 7% of the code, M 15%, Q 25%, H 30%. */
export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  /** 1 to 40; the code is `17 + 4 × version` modules wide. */
  version: number;
  ecc: QrEcc;
  /** 0 to 7, the pattern that scored best. */
  mask: number;
  size: number;
  /** `modules[y][x]`: true is dark. Without the quiet zone. */
  modules: boolean[][];
}

const ECC_ORDER: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Per version (index 0 unused) and level (L, M, Q, H): error-correction codewords per block, and
// the number of blocks (ISO/IEC 18004 Table 9).
// prettier-ignore
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules that carry data or error correction: everything but the function patterns. */
function rawDataModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(version: number, ecc: QrEcc): number {
  const l = ECC_ORDER[ecc];
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[l][version] * BLOCKS[l][version];
}

/** Bits of the byte-mode character count: 8 up to version 9, 16 after. */
const countBits = (version: number) => (version < 10 ? 8 : 16);

/** The bytes a capacity is counted in: UTF-8, as scanners read byte mode. */
function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

/** The smallest version holding `bytes` at `ecc`, or undefined when even 40 is too small. */
export function qrVersionFor(byteLength: number, ecc: QrEcc = 'M', minVersion = 1): number | undefined {
  for (let v = Math.max(1, Math.floor(minVersion)); v <= 40; v++) if (4 + countBits(v) + 8 * byteLength <= dataCodewords(v, ecc) * 8) return v;
  return undefined;
}

// Reed–Solomon over GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((d, i) => (result[i] ^= gfMul(d, factor)));
  }
  return result;
}

/** The data codewords: mode, count, bytes, terminator and padding. */
function encodeData(bytes: number[], version: number, ecc: QrEcc): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Splits into blocks, adds each block's error correction and interleaves them. */
function withEcc(data: number[], version: number, ecc: QrEcc): number[] {
  const l = ECC_ORDER[ecc];
  const blocks = BLOCKS[l][version];
  const eccLen = ECC_PER_BLOCK[l][version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const block = [...dat];
    if (i < short) block.push(0); // a placeholder, skipped when interleaving
    all.push([...block, ...rsRemainder(dat, divisor)]);
  }
  const out: number[] = [];
  for (let i = 0; i < all[0].length; i++) {
    for (let j = 0; j < all.length; j++) if (i !== shortLen - eccLen || j >= short) out.push(all[j][i]);
  }
  return out;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const size = version * 4 + 17;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly modules: boolean[][];
  readonly fixed: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.fixed[y][x] = true;
  }
}

function drawFunctionPatterns(g: Grid, version: number) {
  const { size } = g;
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((ay, i) =>
    align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  drawFormat(g, 'M', 0); // reserves the format areas; drawn again once the mask is chosen
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, dark);
      g.set(b, a, dark);
    }
  }
}

function drawFormat(g: Grid, ecc: QrEcc, mask: number) {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const { size } = g;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, bit(i));
  g.set(8, size - 8, true);
}

/** Places the codewords in the two-column zigzag from the bottom right, around the function patterns. */
function drawCodewords(g: Grid, codewords: number[]) {
  const { size } = g;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (g.fixed[y][x] || i >= codewords.length * 8) continue;
        g.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask];
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fixed[y][x] && f(x, y)) g.modules[y][x] = !g.modules[y][x];
}

/** The standard's penalty (runs, 2×2 blocks, finder look-alikes, balance): the lowest mask is used. */
export function qrPenalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i]);
    lines.push(modules.map((row) => row[i]));
  }
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const at = (i: number) => i >= 0 && i < size && line[i];
    for (let i = 0; i + 7 <= size; i++) {
      if (!finder.every((d, k) => line[i + k] === d)) continue;
      const lightBefore = [1, 2, 3, 4].every((k) => !at(i - k));
      const lightAfter = [0, 1, 2, 3].every((k) => !at(i + 7 + k));
      if (lightBefore || lightAfter) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** Encodes `text` (UTF-8, byte mode) in the smallest version that holds it at `ecc` (default M), from `minVersion` up. */
export function qrCode(text: string, { ecc = 'M', mask, minVersion }: { ecc?: QrEcc; mask?: number; minVersion?: number } = {}): QrCode {
  const bytes = utf8(text);
  const version = qrVersionFor(bytes.length, ecc, minVersion);
  if (!version) throw new RangeError(`too long for a QR code: ${bytes.length} bytes`);
  if (mask !== undefined && !(Number.isInteger(mask) && mask >= 0 && mask <= 7)) throw new RangeError(`mask must be 0 to 7, not ${mask}`);
  const codewords = withEcc(encodeData(bytes, version, ecc), version, ecc);
  const size = version * 4 + 17;
  const build = (m: number) => {
    const g = new Grid(size);
    drawFunctionPatterns(g, version);
    drawCodewords(g, codewords);
    applyMask(g, m);
    drawFormat(g, ecc, m);
    return g;
  };
  let best = mask ?? 0;
  if (mask === undefined) {
    let lowest = Infinity;
    for (let m = 0; m < 8; m++) {
      const p = qrPenalty(build(m).modules);
      if (p < lowest) [lowest, best] = [p, m];
    }
  }
  return { version, ecc, mask: best, size, modules: build(best).modules };
}

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface QrSvgOptions {
  ecc?: QrEcc;
  /** Light modules around the code; scanners want 4. */
  border?: number;
  /** Its accessible name (`role="img"`); without one the SVG is hidden from assistive technology. */
  label?: string;
}

/**
 * The code as an SVG whose dark modules are one path in `currentColor` on a transparent ground, so
 * the page sets both colours: keep it dark on light in every theme, as scanners expect. It scales to
 * any size (`width: 100%`), with crisp edges.
 */
export function qrSvg(text: string, { ecc = 'M', border = 4, label }: QrSvgOptions = {}): string {
  const { size, modules } = qrCode(text, { ecc });
  const total = size + border * 2;
  let d = '';
  modules.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + border} ${y + border}h1v1h-1z`)));
  const a11y = label ? `role="img" aria-label="${escapeXml(label)}"` : 'aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" ${a11y}><path fill="currentColor" d="${d}"/></svg>`;
}
