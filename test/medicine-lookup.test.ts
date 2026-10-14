import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabelCourse } from '../src/medicine-label';
import { elevenDigits, matchCode, nameListings, ndcListing, sameStrength, withListing, type ListedProduct } from '../src/medicine-lookup';
import { isNdcShape } from '../src/ndc';
import { namesMatcher } from '../src/medicine-names-match';

const CADUET = readFileSync(join(import.meta.dir, 'fixtures', 'openfda', 'name-caduet.json'), 'utf8');
const CIPROFLOXACIN = readFileSync(join(import.meta.dir, 'fixtures', 'openfda', 'ndc-59390-217.json'), 'utf8');

/** openFDA as the fixture: the one product, 404 for anything else; records the URLs asked. */
function fda(calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    return decodeURIComponent(url).includes('59390-217') ? new Response(CIPROFLOXACIN) : new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
  };
}

const read = (c: Partial<LabelCourse>): LabelCourse => ({ notes: [], confidence: 0, unparsed: [], assumptions: [], ignored: [], ...c });

describe('ndcListing', () => {
  test('the product for a package NDC, in label words; only the code is sent', async () => {
    const calls: string[] = [];
    expect(await ndcListing('59390-217-02', fda(calls))).toMatchObject({ brand: 'Ciprofloxacin HCl Ophthalmic', strength: '3 mg/mL', form: 'solution', route: 'ophthalmic', productNdc: '59390-217' });
    expect(calls).toEqual(['https://api.fda.gov/drug/ndc.json?search=product_ndc%3A%2259390-217%22&limit=1']);
  });

  test('an NDC that is not listed', async () => {
    expect(await ndcListing('12345-678-90', fda())).toBeNull();
  });
});

describe('withListing', () => {
  test('a listing that agrees with the label fills the name, strength and form, marked as the FDA\'s', async () => {
    const out = await withListing(read({ name: 'Ciproflox', strength: '0.3%', ndc: '59390-217-02' }), { fetch: fda() });
    // 0.3% is 3 mg/mL: the label's own wording stays.
    expect(out).toMatchObject({ name: 'Ciprofloxacin Hcl Ophthalmic', strength: '0.3%', form: 'solution', route: 'in the eye', sources: { name: 'fda', form: 'fda', route: 'fda' } });
  });

  test('a listing for another medicine (a misread digit) changes nothing and says so', async () => {
    const out = await withListing(read({ name: 'Lisinopril', strength: '10 mg', ndc: '59390-217-02' }), { fetch: fda() });
    expect(out.name).toBe('Lisinopril');
    expect(out.sources).toEqual({});
    expect(out.assumptions.join(' ')).toContain('59390-217-02');
  });

  test('offline: the label as read', async () => {
    const course = read({ name: 'Ciprofloxacin', ndc: '59390-217-02' });
    const out = await withListing(course, { fetch: async () => Promise.reject(new Error('offline')) });
    expect(out).toMatchObject({ name: 'Ciprofloxacin' });
    expect(out.sources).toEqual({});
  });

  test('a pet medicine read without its strength gets the strengths it comes in, of its kind', async () => {
    const names = namesMatcher([], [
      { name: 'Galliprant', generic: 'grapiprant', form: 'tablet', strengths: ['20 mg', '60 mg', '100 mg'] },
      { name: 'Carprofen', generic: 'carprofen', form: 'injection, solution', strengths: ['50 mg/mL'] },
      { name: 'Carprofen', generic: 'carprofen', form: 'tablet, chewable', strengths: ['25 mg', '75 mg', '100 mg'] },
    ]);
    expect((await withListing(read({ name: 'Galliprant' }), { names, fetch: fda() })).strengthChoices).toEqual(['20 mg', '60 mg', '100 mg']);
    const chew = await withListing(read({ name: 'Carprofen', form: 'chewable tablets' }), { names, fetch: fda() });
    expect(chew.strengthChoices).toEqual(['25 mg', '75 mg', '100 mg']);
    expect((await withListing(read({ name: 'Galliprant', strength: '60 mg' }), { names, fetch: fda() })).strengthChoices).toBeUndefined();
  });
});

describe('sameStrength', () => {
  test.each([
    ['0.3%', '3 mg/mL', true],
    ['7.5-46MG', '7.5 mg / 46 mg', true],
    ['125 mg/5 mL', '125 mg / 5 mL', true],
    ['20 mg/mL', '20 mg/1 mL', true],
    ['10 mg', '20 mg', false],
    ['125mg', '875 mg / 125 mg', false],
  ])('%s and %s: %p', (a, b, same) => expect(sameStrength(a, b)).toBe(same));
});

/** openFDA for a name search: Caduet's listings; nothing else is listed. */
function byName(calls: string[] = []) {
  return async (url: string) => {
    calls.push(decodeURIComponent(url));
    return decodeURIComponent(url).includes('"Caduet"') ? new Response(CADUET) : new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
  };
}

describe('an NDC half read: the medicine named, its listed packages matched on the device', () => {
  const names = namesMatcher(['Caduet', 'Marinol'], []);

  test('two digits off, the strength read decides between its products; only the name is sent', async () => {
    const calls: string[] = [];
    // "58151-064-93" read as "68151-06493" with a digit lost: 5 mg / 10 mg on the label.
    const out = await withListing(read({ name: 'Caduet', strength: '5 mg/10 mg' }), { fetch: byName(calls), names, codes: ['68151-0493', '0123456789'] });
    expect(out.ndc).toBe('58151-064-93');
    expect(out.sources).toMatchObject({ ndc: 'fda', name: 'fda' });
    expect(calls).toEqual(['https://api.fda.gov/drug/ndc.json?search=(brand_name:"Caduet" generic_name:"Caduet")&limit=100']);
  });

  test('a clear NDC a digit off that is not listed is put right; a code printed in full for the product stays as printed', async () => {
    const out = await withListing(read({ name: 'Caduet', strength: '5 mg/10 mg', ndc: '58161-064-93' }), { fetch: byName(), names });
    expect(out.ndc).toBe('58151-064-93');
    const printed = await withListing(read({ name: 'Caduet', strength: '5 mg/10 mg' }), { fetch: byName(), names, codes: ['58151-064-930', '58151-064-93'] });
    expect(printed.ndc).toBe('58151-064-93');
  });

  test('nothing is looked up without a name read, or with a name not on the list (a person\'s)', async () => {
    const calls: string[] = [];
    expect((await withListing(read({}), { fetch: byName(calls), names, codes: ['58151-064-93'] })).ndc).toBeUndefined();
    expect((await withListing(read({ name: 'Marisol Quenby' }), { fetch: byName(calls), names, codes: ['5815106493'] })).ndc).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('a code in full NDC shape is looked up only when a name was read, and kept only when it is that medicine', async () => {
    const calls: string[] = [];
    const cipro = await withListing(read({ name: 'Ciprofloxacin' }), { fetch: fda(calls), codes: ['59390-217-02'] });
    expect(cipro.ndc).toBe('59390-217-02');
    const other = await withListing(read({ name: 'Lisinopril' }), { fetch: fda(), codes: ['59390-217-02'] });
    expect(other.ndc).toBeUndefined();
  });

  test('matchCode: too far, or two products equally near, is no match', async () => {
    const products = await nameListings('Caduet', byName());
    expect(matchCode(['9999999999'], products)).toBeNull();
    // 58151-060-93 to 58151-064-93 are all one digit from "58151-0693" with no strength to choose.
    expect(matchCode(['58151-0693'], products)).toBeNull();
    expect(matchCode(['58151-0693'], products, { strength: '5 mg/10 mg' })?.ndc).toBe('58151-064-93');
  });

  test('labels print the 11-digit form', () => {
    expect(elevenDigits('70518-4742-0')).toBe('70518-4742-00');
    expect(elevenDigits('0069-6180-30')).toBe('00069-6180-30');
  });
});

describe('matchCode and nameListings, more', () => {
  const product = (packages: [string, string][]): ListedProduct => ({
    brand: 'Example', generic: 'example', strength: '10 mg', form: 'tablet', productNdc: packages[0][0].split('-').slice(0, 2).join('-'),
    packages: packages.map(([ndc, description]) => ({ ndc, description })),
  });
  const two = product([['0069-6180-30', '30 TABLET in 1 BOTTLE'], ['0069-6180-90', '90 TABLET in 1 BOTTLE']]);

  test('two packages of one product equally near: the product\'s code', () => {
    expect(matchCode(['006961800'], [two])?.ndc).toBe('0069-6180');
  });

  test('the package size on the label decides between them', () => {
    expect(matchCode(['006961800'], [two], { text: 'Take 1 tablet daily\n90 Tablets' })?.ndc).toBe('0069-6180-90');
    expect(matchCode(['006961800'], [two], { text: 'QTY: 30' })?.ndc).toBe('0069-6180-30');
  });

  test('a name with hundreds of listings: three pages at most, the name alone in every request', async () => {
    const urls: string[] = [];
    const page = (n: number) => JSON.stringify({ meta: { results: { total: 450 } }, results: Array.from({ length: 100 }, (_, i) => ({ product_ndc: `1${n}${String(i).padStart(3, '0')}-001`, brand_name: 'Lisinopril', packaging: [] })) });
    const fetcher = async (url: string) => (urls.push(decodeURIComponent(url)), new Response(page(urls.length)));
    expect((await nameListings('lisinopril', fetcher)).length).toBe(300);
    expect(urls).toEqual([0, 100, 200].map((skip) => `https://api.fda.gov/drug/ndc.json?search=(brand_name:"lisinopril" generic_name:"lisinopril")&limit=100${skip ? `&skip=${skip}` : ''}`));
  });

  test('a fault that is not openFDA\'s is not swallowed', async () => {
    const names = namesMatcher(['Caduet'], []);
    const broken = async () => new Response('not json');
    await expect(withListing(read({ name: 'Caduet' }), { fetch: broken, names, codes: ['5815106493'] })).rejects.toThrow();
    await expect(withListing(read({ name: 'Caduet' }), { fetch: async () => new Response('', { status: 503 }), names, codes: ['5815106493'] })).resolves.toMatchObject({ name: 'Caduet' });
  });

  test('isNdcShape', () => {
    expect(['0069-6180-30', '59390-217-02', '70518-4742-0', '70518-4742-00'].every(isNdcShape)).toBe(true);
    expect(['555-014-2290', '5939-217-0', '59390-21702', 'Rx-0148217-01'].some(isNdcShape)).toBe(false);
  });
});
