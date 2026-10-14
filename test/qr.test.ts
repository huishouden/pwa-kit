import { describe, expect, test } from 'bun:test';
import jsQR from 'jsqr';
import { qrCode, qrSvg, qrVersionFor, type QrCode, type QrEcc } from '../src/qr';

/** Draws the code as a scanner's camera would see it, quiet zone included, and reads it back. */
function decode(code: QrCode, scale = 4): string | undefined {
  const border = 4;
  const side = (code.size + border * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + border) * scale + dy) * side + (x + border) * scale + dx) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(pixels, side, side, { inversionAttempts: 'dontInvert' })?.data;
}

const SITE = 'https://huishouden-piekstra.web.app/';

describe('qrCode', () => {
  test('encodes the site address so a scanner reads it back exactly', () => {
    const code = qrCode(SITE);
    expect(code.ecc).toBe('M');
    expect(code.version).toBe(3);
    expect(code.size).toBe(29);
    expect(decode(code)).toBe(SITE);
  });

  test('every level and every mask decodes', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as QrEcc[]) {
      for (let mask = 0; mask < 8; mask++) expect(decode(qrCode(SITE, { ecc, mask })), `${ecc} mask ${mask}`).toBe(SITE);
    }
  });

  // Fills each version to the byte, so every row of the block tables is used and checked by a decoder.
  test('every version from 1 to 40 decodes, at every level', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as QrEcc[]) {
      let previous = 0;
      for (let length = 1; ; length++) {
        const version = qrVersionFor(length, ecc);
        if (!version) break;
        if (version === previous) continue;
        previous = version;
        const text = `https://example.com/${'abcdefghij'.repeat(300)}`.slice(0, Math.max(length, 1));
        const code = qrCode(text, { ecc });
        expect(code.version).toBe(version);
        // jsQR 1.4.0 puts version 23's fourth alignment centre at 74, not the standard's 78 (checked
        // below), and only levels with more error correction read through its misplaced pattern.
        if (version === 23 && ecc === 'L') continue;
        expect(decode(code), `${ecc} version ${version}`).toBe(text);
      }
      expect(previous).toBe(40);
    }
  }, 60_000);

  test("alignment patterns sit where ISO/IEC 18004 Annex E puts them (version 23: 6, 30, 54, 78, 102)", () => {
    const { modules } = qrCode('a', { minVersion: 23 });
    const ring = (cx: number, cy: number) =>
      [-2, -1, 0, 1, 2].every((dy) => [-2, -1, 0, 1, 2].every((dx) => modules[cy + dy][cx + dx] === (Math.max(Math.abs(dx), Math.abs(dy)) !== 1)));
    for (const cy of [30, 54, 78]) for (const cx of [30, 54, 78, 102]) expect(ring(cx, cy), `${cx},${cy}`).toBe(true);
  });

  test('the largest version that fits, and text too long throws', () => {
    expect(qrVersionFor(2953, 'L')).toBe(40);
    expect(qrVersionFor(2954, 'L')).toBeUndefined();
    expect(() => qrCode('x'.repeat(2954), { ecc: 'L' })).toThrow(RangeError);
  });

  test('text beyond ASCII is UTF-8, as scanners read byte mode', () => {
    const text = 'Huishouden: één agenda, compras, niño';
    expect(decode(qrCode(text))).toBe(text);
  });

  test('the same text always gives the same code', () => {
    expect(qrCode(SITE)).toEqual(qrCode(SITE));
  });
});

describe('qrSvg', () => {
  test('one path of dark modules in currentColor, with a quiet zone, named when labelled', () => {
    const svg = qrSvg(SITE, { label: 'QR code for "huishouden" & co' });
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37"');
    expect(svg).toContain('role="img" aria-label="QR code for &#34;huishouden&#34; &#38; co"');
    expect(svg).toContain('fill="currentColor"');
    // The top-left finder's corner sits just inside the 4-module border.
    expect(svg).toContain('M4 4h1v1h-1z');
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(qrSvg(SITE)).toContain('aria-hidden="true"');
  });

  test('the SVG draws exactly the modules of the code', () => {
    const code = qrCode(SITE);
    const svg = qrSvg(SITE);
    const drawn = new Set([...svg.matchAll(/M(\d+) (\d+)h1/g)].map((m) => `${Number(m[1]) - 4},${Number(m[2]) - 4}`));
    const dark = new Set(code.modules.flatMap((row, y) => row.flatMap((d, x) => (d ? [`${x},${y}`] : []))));
    expect(drawn).toEqual(dark);
  });
});
