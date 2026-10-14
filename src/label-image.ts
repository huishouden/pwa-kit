/**
 * Pixel work for reading labels from photos, on plain arrays so the same code runs in the browser
 * (pixels from a canvas) and in the benchmark (pixels from a decoder): greyscale, contrast,
 * local contrast (CLAHE), scaling, quarter turns and cropping, and the uncompressed bitmap the OCR
 * engine reads (no canvas needed to encode it).
 */

/** An 8-bit greyscale image, row by row. */
export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

/** RGBA pixels as a canvas gives them (`ImageData`). */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Luma of each pixel. */
export function toGray(img: Rgba): Gray {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return { width: img.width, height: img.height, data: out };
}

/** Light text on a dark ground turned into dark on light, which the engine reads far better. */
export function darkOnLight(img: Gray): Gray {
  let sum = 0;
  for (let i = 0; i < img.data.length; i++) sum += img.data[i];
  if (sum / img.data.length >= 110) return img;
  return { ...img, data: img.data.map((v) => 255 - v) };
}

/** Stretches the levels so the darkest `lowShare` and lightest `highShare` of pixels reach black and white. */
export function stretch(img: Gray, lowShare = 0.01, highShare = 0.01): Gray {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  const n = img.data.length;
  let lo = 0, hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * lowShare; ) lo++;
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * highShare; ) hi--;
  if (hi - lo < 16) return img;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo))));
  return { ...img, data: img.data.map((v) => lut[v]) };
}

/**
 * Contrast-limited adaptive histogram equalisation: each of `tiles` x `tiles` regions gets its own
 * levels (clipped at `clip` times the mean count, so flat paper isn't turned into noise), blended
 * between tile centres. Evens out glare, shadow and a dim corner.
 */
export function clahe(img: Gray, tiles = 8, clip = 2.5): Gray {
  const { width: w, height: h, data } = img;
  const tx = Math.max(1, Math.min(tiles, Math.floor(w / 32))), ty = Math.max(1, Math.min(tiles, Math.floor(h / 32)));
  const tw = w / tx, th = h / ty;
  const luts: Uint8Array[] = [];
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      const x0 = Math.floor(i * tw), x1 = Math.floor((i + 1) * tw), y0 = Math.floor(j * th), y1 = Math.floor((j + 1) * th);
      const hist = new Float64Array(256);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[data[y * w + x]]++;
      const count = (x1 - x0) * (y1 - y0);
      const limit = Math.max(1, (clip * count) / 256);
      let excess = 0;
      for (let v = 0; v < 256; v++) if (hist[v] > limit) (excess += hist[v] - limit), (hist[v] = limit);
      const add = excess / 256;
      const lut = new Uint8Array(256);
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v] + add;
        lut[v] = Math.min(255, Math.round((acc * 255) / count));
      }
      luts.push(lut);
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.max(0, Math.min(ty - 1, (y - th / 2) / th));
    const j0 = Math.floor(gy), j1 = Math.min(ty - 1, j0 + 1), fy = gy - j0;
    for (let x = 0; x < w; x++) {
      const gx = Math.max(0, Math.min(tx - 1, (x - tw / 2) / tw));
      const i0 = Math.floor(gx), i1 = Math.min(tx - 1, i0 + 1), fx = gx - i0;
      const v = data[y * w + x];
      const a = luts[j0 * tx + i0][v], b = luts[j0 * tx + i1][v], c = luts[j1 * tx + i0][v], d = luts[j1 * tx + i1][v];
      out[y * w + x] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Sauvola binarisation: a pixel is ink when darker than its neighbourhood's mean, adjusted by the
 * neighbourhood's spread. Removes uneven light; can break thin or low-contrast print.
 */
export function sauvola(img: Gray, window = Math.max(15, Math.round(Math.min(img.width, img.height) / 40) | 1), k = 0.2): Gray {
  const { width: w, height: h, data } = img;
  const iw = w + 1;
  const sum = new Float64Array(iw * (h + 1)), sq = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rs += v;
      rq += v * v;
      sum[(y + 1) * iw + x + 1] = sum[y * iw + x + 1] + rs;
      sq[(y + 1) * iw + x + 1] = sq[y * iw + x + 1] + rq;
    }
  }
  const r = window >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const s = sum[y1 * iw + x1] - sum[y0 * iw + x1] - sum[y1 * iw + x0] + sum[y0 * iw + x0];
      const q = sq[y1 * iw + x1] - sq[y0 * iw + x1] - sq[y1 * iw + x0] + sq[y0 * iw + x0];
      const mean = s / n;
      const sd = Math.sqrt(Math.max(0, q / n - mean * mean));
      out[y * w + x] = data[y * w + x] > mean * (1 + k * (sd / 128 - 1)) ? 255 : 0;
    }
  }
  return { width: w, height: h, data: out };
}

/** Scaled by `factor`: averaging when shrinking (no aliasing on fine print), bilinear when enlarging. */
export function scale(img: Gray, factor: number): Gray {
  const w = Math.max(1, Math.round(img.width * factor)), h = Math.max(1, Math.round(img.height * factor));
  if (w === img.width && h === img.height) return img;
  const out = new Uint8Array(w * h);
  const src = img.data;
  if (factor < 1) {
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * img.width + xx];
        out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const fy = Math.min(img.height - 1, (y + 0.5) / factor - 0.5);
      const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(img.height - 1, y0 + 1), dy = Math.max(0, fy - y0);
      for (let x = 0; x < w; x++) {
        const fx = Math.min(img.width - 1, (x + 0.5) / factor - 0.5);
        const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(img.width - 1, x0 + 1), dx = Math.max(0, fx - x0);
        const a = src[y0 * img.width + x0], b = src[y0 * img.width + x1], c = src[y1 * img.width + x0], d = src[y1 * img.width + x1];
        out[y * w + x] = (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Turned clockwise by `quarters` quarter turns. */
export function rotate(img: Gray, quarters: number): Gray {
  const q = ((quarters % 4) + 4) % 4;
  if (q === 0) return img;
  const { width: w, height: h, data } = img;
  const W = q === 2 ? w : h, H = q === 2 ? h : w;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      if (q === 1) out[x * W + (h - 1 - y)] = v;
      else if (q === 2) out[(h - 1 - y) * W + (w - 1 - x)] = v;
      else out[(w - 1 - x) * W + y] = v;
    }
  }
  return { width: W, height: H, data: out };
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The part of the image inside `box` (clamped to the image). */
export function crop(img: Gray, box: Box): Gray {
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(img.width, Math.ceil(box.x1)), y1 = Math.min(img.height, Math.ceil(box.y1));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(img.data.subarray((y0 + y) * img.width + x0, (y0 + y) * img.width + x0 + w), y * w);
  return { width: w, height: h, data: out };
}

/** An uncompressed 8-bit greyscale BMP: the OCR engine reads it from bytes, no canvas or encoder needed. */
export function toBmp(img: Gray): Uint8Array {
  const row = (img.width + 3) & ~3;
  const offset = 14 + 40 + 256 * 4;
  const size = offset + row * img.height;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, offset, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, img.width, true);
  v.setInt32(22, img.height, true); // rows bottom-up, the form every reader takes
  v.setUint16(26, 1, true);
  v.setUint16(28, 8, true);
  v.setUint32(34, row * img.height, true);
  v.setUint32(38, 11811, true); // 300 dpi
  v.setUint32(42, 11811, true);
  v.setUint32(46, 256, true);
  for (let i = 0; i < 256; i++) {
    buf[54 + i * 4] = i;
    buf[55 + i * 4] = i;
    buf[56 + i * 4] = i;
  }
  for (let y = 0; y < img.height; y++) buf.set(img.data.subarray(y * img.width, (y + 1) * img.width), offset + (img.height - 1 - y) * row);
  return buf;
}
