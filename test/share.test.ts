import { afterEach, describe, expect, test } from 'bun:test';
import jsQR from 'jsqr';
import { SHARE_HOST, SHARE_URL, copyShareLink, shareData, shareHuishouden, shareQrSvg, type ShareEnv } from '../src/share';
import { SUITE_ORIGIN } from '../src/suite';
import { resetI18nForTests, setLangChoice } from '../src/i18n';

afterEach(() => resetI18nForTests());

const abort = () => Object.assign(new Error('Share canceled'), { name: 'AbortError' });

describe('what is shared', () => {
  test('the bare site address: no query, no fragment, nothing about the sharer', () => {
    expect(SHARE_URL).toBe(`${SUITE_ORIGIN}/`);
    const url = new URL(SHARE_URL);
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(SHARE_HOST).toBe(url.host);
  });

  test('the name, a one-line pitch that ends by inviting them to start their own household, the address', () => {
    const data = shareData();
    expect(data).toEqual({ title: 'Huishouden', text: expect.stringContaining('Start your own household'), url: SHARE_URL });
    expect(data.text).toStartWith('Huishouden: free household apps (groceries, tasks, calendar, pets, baby, health)');
    expect(data.text).not.toContain('\n');
    expect(data.text).not.toContain('http');
  });

  test('the pitch in the page language', async () => {
    await setLangChoice('nl');
    expect(shareData().text).toContain('Begin je eigen huishouden');
    await setLangChoice('es');
    expect(shareData().text).toContain('Crea tu propio hogar');
    expect(shareData().url).toBe(SHARE_URL);
  });
});

describe('shareHuishouden', () => {
  test('uses the system share sheet when there is one, and copies nothing', async () => {
    const shared: ShareData[] = [];
    const copied: string[] = [];
    const env: ShareEnv = { share: async (d) => void shared.push(d), copy: async (t) => void copied.push(t) };
    expect(await shareHuishouden(env)).toBe('shared');
    expect(shared).toEqual([shareData()]);
    expect(copied).toEqual([]);
  });

  test('closing the share sheet is a cancel, not a reason to copy', async () => {
    const copied: string[] = [];
    expect(await shareHuishouden({ share: () => Promise.reject(abort()), copy: async (t) => void copied.push(t) })).toBe('cancelled');
    expect(copied).toEqual([]);
  });

  test('without a share sheet, copies the link', async () => {
    const copied: string[] = [];
    expect(await shareHuishouden({ copy: async (t) => void copied.push(t) })).toBe('copied');
    expect(copied).toEqual([SHARE_URL]);
  });

  test('a share sheet that refuses the data or fails to open falls back to copying', async () => {
    const copied: string[] = [];
    const copy = async (t: string) => void copied.push(t);
    let called = false;
    expect(await shareHuishouden({ share: async () => void (called = true), canShare: () => false, copy })).toBe('copied');
    expect(called).toBe(false);
    const notAllowed = Object.assign(new Error('no gesture'), { name: 'NotAllowedError' });
    expect(await shareHuishouden({ share: () => Promise.reject(notAllowed), copy })).toBe('copied');
    expect(copied).toEqual([SHARE_URL, SHARE_URL]);
  });

  test('neither works: failed', async () => {
    expect(await shareHuishouden({})).toBe('failed');
    expect(await shareHuishouden({ copy: () => Promise.reject(new Error('denied')) })).toBe('failed');
  });
});

describe('shareQrSvg', () => {
  test('is the site address, named in the page language', async () => {
    expect(shareQrSvg()).toContain(`aria-label="QR code for ${SHARE_HOST}"`);
    await setLangChoice('nl');
    expect(shareQrSvg()).toContain(`aria-label="QR-code voor ${SHARE_HOST}"`);
  });

  test('decodes to the site address', () => {
    // Rasterise the SVG's unit squares as a camera would see them, and read it with a decoder.
    const svg = shareQrSvg();
    const total = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
    const scale = 6;
    const side = total * scale;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    for (const [, sx, sy] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((Number(sy) * scale + dy) * side + Number(sx) * scale + dx) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        }
      }
    }
    expect(jsQR(pixels, side, side)?.data).toBe(SHARE_URL);
  });
});

describe('copyShareLink', () => {
  test('copies the address alone; no clipboard or a refusal is failed', async () => {
    const copied: string[] = [];
    expect(await copyShareLink({ copy: async (t) => void copied.push(t) })).toBe('copied');
    expect(copied).toEqual([SHARE_URL]);
    expect(await copyShareLink({ share: async () => {} })).toBe('failed');
    expect(await copyShareLink({ copy: () => Promise.reject(new Error('denied')) })).toBe('failed');
  });
});
