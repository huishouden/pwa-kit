import { describe, expect, test } from 'bun:test';
import { clahe, crop, rotate, scale, stretch, toBmp, toGray, type Gray } from '../src/label-image';
import { codesOf, fixNumberWord, linesOf, mergeWords, readLabelImage, readingScore, wordsToLines, type OcrWord, type Psm } from '../src/label-read';

const word = (text: string, x0: number, y0: number, w = 60, h = 20, confidence = 90): OcrWord => ({ text, confidence, box: { x0, y0, x1: x0 + w, y1: y0 + h } });
const gray = (width: number, height: number, f: (x: number, y: number) => number): Gray => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { width, height, data };
};

describe('fixNumberWord', () => {
  test.each([
    ['2.5rng', '2.5mg'],
    ['5m9', '5mg'],
    ['m9/1,680', 'mg/1,680'],
    ['6800l-332', '68001-332'],
    ['NOC', 'NDC'],
    ['1O0', '100'],
    ['Ointment', 'Ointment'],
    ['USP', 'USP'],
    ['Lot', 'Lot'],
  ])('%s -> %s', (from, to) => expect(fixNumberWord(from)).toBe(to));
});

describe('lines from words', () => {
  test('a line bending round a bottle stays one line; columns far apart stay apart', () => {
    const bent = [word('TAKE', 0, 100), word('ONE', 70, 106), word('TABLET', 140, 112), word('DAILY', 210, 106)];
    const column = word('QTY:', 900, 104, 50);
    expect(wordsToLines([...bent, column]).map((l) => l.text)).toEqual(['TAKE ONE TABLET DAILY', 'QTY:']);
  });

  test('top to bottom, each with its print size', () => {
    const lines = wordsToLines([word('25', 0, 200), word('mg', 70, 200), word('CARPROFEN', 0, 50, 300, 60)]);
    expect(lines.map((l) => [l.text, l.height])).toEqual([['CARPROFEN', 60], ['25 mg', 20]]);
  });

  test('unsure words and noise lines are dropped; a sure line keeps its weaker words', () => {
    const { text } = linesOf([word('Cephalex', 0, 0, 200, 70, 81), word('ei)', 0, 200, 40, 20, 12), word('psstR', 60, 200, 60, 20, 20), word('Ointment', 0, 100, 160, 60, 96), word('USP', 170, 100, 80, 60, 95), word('tube', 260, 100, 80, 60, 45)]);
    expect(text).toBe('Cephalex\nOintment USP tube');
  });

  test('two readings of the same word keep the surer one', () => {
    const merged = mergeWords([[word('Ophthalmi:', 0, 0, 200, 70, 60)], [word('Ophthalmic', 2, 1, 200, 70, 85), word('USP', 0, 100)]]);
    expect(merged.map((w) => w.text)).toEqual(['Ophthalmic', 'USP']);
  });

  test('readingScore counts the letters of sure words only', () => {
    expect(readingScore([word('Cephalexins', 0, 0, 100, 20, 90), word('xq', 0, 0, 10, 10, 30)])).toBe(11);
  });
});

describe('codesOf', () => {
  test('digit runs of eight or more on a line, sure or not, numbers fixed; short numbers and words left out', () => {
    const words = [word('NDC', 0, 0, 40, 20, 90), word('24208-9lO', 50, 0, 90, 20, 0), word('-55', 150, 0, 30, 20, 10), word('Qty:', 0, 100), word('30', 70, 100), word('(555)', 0, 200), word('014-2290', 70, 200)];
    expect(codesOf(words)).toEqual(['24208-910-55']);
  });
});

describe('readLabelImage', () => {
  test('a sideways photo is read in the turn that gives the most sure text', async () => {
    const img = gray(400, 200, () => 255);
    const seen: { psm: Psm; width: number }[] = [];
    // The fake engine finds text only when the image is upright for it: taller than wide.
    const recognize = async (bmp: Uint8Array, psm: Psm) => {
      const v = new DataView(bmp.buffer, bmp.byteOffset);
      const width = v.getInt32(18, true), height = v.getInt32(22, true);
      seen.push({ psm, width });
      return { words: height > width ? [word('Carprofen', 10, 10, 200, 40), word('Chewable', 10, 60, 200, 40), word('Tablets', 10, 110, 200, 40)] : [] };
    };
    const r = await readLabelImage(img, recognize, { zoom: false });
    expect(r.turns === 1 || r.turns === 3).toBe(true);
    expect(r.text).toBe('Carprofen\nChewable\nTablets');
    expect(seen[0].psm).toBe('11');
  });
});

describe('label-image', () => {
  test('toGray, stretch and clahe keep the size and use the full range', () => {
    const rgba = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
    expect(Array.from(toGray(rgba).data)).toEqual([76, 28]);
    const flat = gray(100, 100, (x) => 100 + (x % 20));
    const s = stretch(flat);
    expect(Math.min(...s.data)).toBe(0);
    expect(Math.max(...s.data)).toBe(255);
    expect(clahe(flat).data.length).toBe(10_000);
  });

  test('rotate, scale and crop', () => {
    const img = gray(3, 2, (x, y) => y * 3 + x);
    expect(rotate(img, 1)).toEqual({ width: 2, height: 3, data: new Uint8Array([3, 0, 4, 1, 5, 2]) });
    expect(rotate(rotate(img, 2), 2)).toEqual(img);
    expect(scale(gray(100, 50, () => 7), 0.5)).toMatchObject({ width: 50, height: 25 });
    expect(crop(img, { x0: 1, y0: 0, x1: 3, y1: 1 })).toEqual({ width: 2, height: 1, data: new Uint8Array([1, 2]) });
  });

  test('toBmp writes an 8-bit greyscale bitmap, rows padded to four bytes', () => {
    const bmp = toBmp(gray(3, 2, () => 9));
    const v = new DataView(bmp.buffer);
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe('BM');
    expect([v.getInt32(18, true), v.getInt32(22, true), v.getUint16(28, true)]).toEqual([3, 2, 8]);
    expect(bmp.length).toBe(14 + 40 + 1024 + 4 * 2);
  });
});
