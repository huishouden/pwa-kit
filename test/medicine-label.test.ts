import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findNdc, findRoute, isDispensingLabel, parseLabel } from '../src/medicine-label';
import { namesMatcher } from '../src/medicine-names-match';

const dir = join(import.meta.dir, 'fixtures', 'package-labels');
const NAMES = namesMatcher(['Lisinopril', 'Carprofen', 'Ciprofloxacin', 'Ofloxacin', 'Amlodipine', 'Tobramycin', 'Marinol'], [
  { name: 'Galliprant', generic: 'grapiprant', form: 'tablet', strengths: ['20 mg', '60 mg', '100 mg'] },
]);

describe('parseLabel: package, pharmacy and vet labels as read', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const expected = JSON.parse(readFileSync(join(dir, file.replace('.txt', '.expected.json')), 'utf8'));
    test(file, () => expect(parseLabel(text)).toMatchObject(expected));
    test(`${file}, with the medicine names`, () => expect(parseLabel(text, { isMedicineName: NAMES.match })).toMatchObject(expected));
  }
});

describe('parseLabel: privacy', () => {
  const people = ['marguerite', 'okonkwo', 'rafael', 'dunmore', 'juniper', 'desmond', 'achterberg', 'felicity', 'moreau', 'copperfield', 'quillon', 'osgood'];
  for (const file of ['pharmacy-vial.txt', 'vet-vial-misread.txt']) {
    test(`${file}: no person, pet or address in a medicine field`, () => {
      const p = parseLabel(readFileSync(join(dir, file), 'utf8'), { isMedicineName: NAMES.match });
      const saved = [p.name, p.strength, p.form, p.route, p.dose, ...p.notes].join(' ').toLowerCase();
      for (const w of people) expect(saved).not.toContain(w);
    });
  }

  test('a name spelled almost like a medicine is still a person', () => {
    // "Marisol" is one letter from "Marinol".
    const p = parseLabel('Larkmoor Pharmacy #2117\nMARISOL QUENBY\nTAKE 1 TABLET BY MOUTH DAILY\nQTY: 30 REFILLS: 1', { isMedicineName: NAMES.match });
    expect(p.name).toBeUndefined();
  });

  test('marks the reader leaves round a person\'s name do not let it through', () => {
    const text = 'Larkmoor Pharmacy #2117 RX# 01348217-015944—\n418 Fennimore Ave DATE: 05/04=—=\nCORNELIUS HAVERTY =\nINSTILL 1 DROP IN EACH EYE FOUR TIMES DAILY FOR 7 DAY=\nOFLOXACIN 0.3% OPHTH SOLUTION =\nMFR: ALTAIRE QTY: 5';
    for (const options of [{}, { isMedicineName: NAMES.match }]) {
      const p = parseLabel(text, options);
      expect(p.name).toBe('Ofloxacin');
      expect(p.strength).toBe('0.3%');
    }
  });

  test('without a strength or form beside it, a pharmacy label line is never taken for the name', () => {
    const p = parseLabel('Larkmoor Pharmacy #2117\nTOBIAS WRENFIELD\nTAKE 1 TABLET BY MOUTH DAILY\nQTY: 30 REFILLS: 1');
    expect(p.name).toBeUndefined();
  });
});

describe('parseLabel: noise', () => {
  test('a garbled line is not filled in as the name', () => {
    expect(parseLabel('ei) psstR = oC 2 .\nEeraple ha mi\nNet We359').name).toBeUndefined();
  });

  test('the medicine names put a half-read name right and drop the noise beside it', () => {
    const p = parseLabel('NDC 61314-647-36\nTobramyc :\nOphthalmi:\nOintment\nUSP\n0.3%\n(Sterile)', { isMedicineName: NAMES.match });
    expect(p).toMatchObject({ name: 'Tobramycin', strength: '0.3%', form: 'ointment', route: 'in the eye', ndc: '61314-647-36' });
  });

  test('a name the reader split in two is joined', () => {
    expect(parseLabel('Cipro floxacin\nOphthalmic Solution\n0.3%', { isMedicineName: NAMES.match }).name).toBe('Ciprofloxacin');
  });
});

describe('findNdc', () => {
  test.each([
    ['NDC 0904-6985-16', '0904-6985-16'],
    ['NDC: 68071-3864-4', '68071-3864-4'],
    ['Rx Only NOC 59390-217-02', '59390-217-02'],
    ['NDC 68001-33200', '68001-332-00'],
    ['COUPLER NDC: 67046129430', '67046-1294-30'],
    ['MFG NDC: 67877-0198-10\nNDC #: 70518-2981-00', '70518-2981-00'],
    ['SOURCE NDC: 67877-414-01\nNDC 50090-5246-0', '50090-5246-0'],
  ])('%s', (text, ndc) => expect(findNdc(text)).toBe(ndc));

  test.each(['Call (555) 014-2290', 'RX# 0148217-01', 'Exp 2026-10-14', 'Lot 12345-67'])('not an NDC: %s', (text) => expect(findNdc(text)).toBeUndefined());
});

describe('findRoute and isDispensingLabel', () => {
  test.each([
    ['For oral use in dogs only', 'by mouth'],
    ['FOR TOPICAL OPHTHALMIC USE ONLY', 'in the eye'],
    ['Fluticasone propionate nasal spray', 'in the nose'],
    ['Albuterol inhalation aerosol', 'inhaled'],
    ['For subcutaneous injection', 'under the skin'],
    ['Injectable solution for intravenous use', 'by injection'],
  ] as const)('%s', (text, route) => expect(findRoute(text)).toBe(route));

  test('a pharmacy label has people and numbers on it; a maker\'s box does not', () => {
    expect(isDispensingLabel(readFileSync(join(dir, 'pharmacy-vial.txt'), 'utf8'))).toBe(true);
    expect(isDispensingLabel(readFileSync(join(dir, 'ciprofloxacin-eye.txt'), 'utf8'))).toBe(false);
  });
});

describe('routes', () => {
  test('no "no name" warning beside a name the package layout found', () => {
    const p = parseLabel(readFileSync(join(dir, 'ciprofloxacin-eye.txt'), 'utf8'));
    expect(p.name).toBe('Ciprofloxacin');
    expect(p.assumptions).toEqual([]);
    expect(parseLabel('ei) psstR\nEeraple ha mi').assumptions).toEqual(['no medicine name found on the label']);
    // A drug line whose "name" is a person: taken back, and the missing name said.
    expect(parseLabel('TOBIAS WRENFIELD 10MG\nTake 1 tablet by mouth daily')).toMatchObject({ assumptions: ['no medicine name found on the label'] });
    expect(parseLabel('TOBIAS WRENFIELD 10MG\nTake 1 tablet by mouth daily').name).toBeUndefined();
  });
});
