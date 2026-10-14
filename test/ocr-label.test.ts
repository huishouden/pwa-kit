import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readLabel } from '../src/dose';
import { readLabelLines, releaseOcr } from '../src/ocr';

const paths = { enginePath: join(import.meta.dir, 'fixtures', 'ocr', 'fake-engine.ts') };

describe('readLabelLines without OffscreenCanvas', () => {
  test('reads the photo once as it is, as before, and readLabel still resolves', async () => {
    expect(typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas).toBe('undefined');
    const photo = new Blob(['photo'], { type: 'image/jpeg' });
    const read = await readLabelLines(photo, { paths });
    expect(read).toEqual({ text: 'Lisinopril 10 mg tablets\nTake 1 tablet by mouth daily', lines: [], words: [], codes: [], turns: 0, passes: 1 });
    expect(await readLabel(photo, { paths })).toBe('Lisinopril 10 mg tablets\nTake 1 tablet by mouth daily');
    await releaseOcr();
  });
});
