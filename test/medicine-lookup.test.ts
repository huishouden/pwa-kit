import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabelCourse } from '../src/medicine-label';
import { ndcListing, sameStrength, withListing } from '../src/medicine-lookup';
import { namesMatcher } from '../src/medicine-names-match';

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
