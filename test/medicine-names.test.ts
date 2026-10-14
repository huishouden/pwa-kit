import { describe, expect, test } from 'bun:test';
import { medicineNames, namesMatcher } from '../src/medicine-names-match';

const names = namesMatcher(['tobramycin', 'cephalexin', 'Lisinopril', 'Marinol', 'Simparica Trio', 'oclacitinib maleate'], [
  { name: 'Proin 50', generic: 'phenylpropanolamine hydrochloride', form: 'tablet, chewable', strengths: ['50 mg'] },
  { name: 'Proin 75', generic: 'phenylpropanolamine hydrochloride', form: 'tablet, chewable', strengths: ['75 mg'] },
]);

describe('namesMatcher', () => {
  test.each([
    ['TOBRAMYCIN', 'tobramycin'],
    ['Tobramyci', 'tobramycin'], // cut short at the end of a curved label
    ['phalexin', 'cephalexin'], // and at the start
    ['Lisinopri', 'Lisinopril'],
    ['Lisinoprll', 'Lisinopril'],
    ['Simparica', 'Simparica'],
    ['oclacitinib', 'oclacitinib'],
  ])('%s -> %s', (word, name) => expect(names.match(word)).toBe(name));

  test.each(['Tablets', 'Relief', 'Topical', 'Marisa', 'Paulsen', 'Ofl', 'Trio'])('no match: %s', (word) => expect(names.match(word)).toBeUndefined());

  test('a pet product by brand or generic word, with every strength of the products sharing it', () => {
    expect(names.pet('Proin')?.strengths).toEqual(['50 mg', '75 mg']);
    expect(names.pet('Phenylpropanolamine HCl')?.strengths).toEqual(['50 mg', '75 mg']);
  });
});

describe('the device list', () => {
  test('loads once and knows common human and pet medicines, not ordinary words', async () => {
    const list = await medicineNames();
    expect(await medicineNames()).toBe(list);
    for (const w of ['lisinopril', 'amoxicillin', 'NexGard', 'carprofen', 'Galliprant']) expect(list.match(w)).toBeDefined();
    for (const w of ['White', 'Water', 'Human', 'Juniper', 'Morning']) expect(list.match(w)).toBeUndefined();
    expect(list.pet('Galliprant')?.strengths).toEqual(['20 mg', '60 mg', '100 mg']);
  });
});
