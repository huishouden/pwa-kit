import { afterEach, describe, expect, test } from 'bun:test';
import { loadLang, withLang } from '../src/i18n';
import {
  ICD10_SPECIALTIES, SPECIALTIES, clearConditionSearchCache, cleanIcd10, conditionConflicts, conditionDoc, defaultSpecialty, groupBySpecialty, guessSpecialty, isPartialDate, partialDateWords,
  searchConditions, specialtyForIcd10, specialtyLabel, toCondition, ConditionSearchUnavailable, type Condition,
} from '../src/condition';
import { toVisit, visitAgendaItem, visitDoc, visitReminders } from '../src/visit';

const NOW = new Date(2031, 4, 13, 12).getTime();

describe('ICD-10-CM to medical area', () => {
  test.each([
    ['M54.12', 'neurology'], // cervical radiculopathy: chapter M, but neurology
    ['M54.16', 'neurology'],
    ['M54.30', 'neurology'], // sciatica
    ['M50.10', 'neurology'],
    ['M51.16', 'neurology'],
    ['M54.50', 'orthopedics'], // low back pain stays musculoskeletal
    ['M17.11', 'orthopedics'], // knee osteoarthritis
    ['M06.9', 'rheumatology'], // rheumatoid arthritis
    ['M32.9', 'rheumatology'], // lupus
    ['M10.9', 'rheumatology'], // gout
    ['M81.0', 'endocrinology'], // osteoporosis
    ['I48.91', 'cardiology'],
    ['I10', 'cardiology'],
    ['I63.9', 'neurology'], // stroke
    ['E11.9', 'endocrinology'],
    ['F41.1', 'mentalHealth'],
    ['G43.909', 'neurology'],
    ['G47.33', 'pulmonology'], // sleep apnea
    ['J45.909', 'pulmonology'],
    ['J30.1', 'allergy'],
    ['J32.9', 'ent'],
    ['H40.9', 'ophthalmology'],
    ['H91.90', 'ent'],
    ['K21.9', 'gastroenterology'],
    ['L40.0', 'dermatology'],
    ['L20.9', 'allergy'],
    ['N18.3', 'nephrology'],
    ['N40.0', 'urology'],
    ['N80.0', 'obgyn'],
    ['O24.410', 'obgyn'],
    ['C50.911', 'hemOnc'],
    ['D50.9', 'hemOnc'],
    ['D84.9', 'allergy'],
    ['B20', 'infectious'],
    ['S52.501A', 'orthopedics'],
    ['T78.40XA', 'allergy'],
    ['Z88.0', 'allergy'],
  ])('%s files under %s', (code, specialty) => {
    expect(specialtyForIcd10(code)).toBe(specialty as never);
  });

  test('codes the table has nothing for, and nonsense, give null', () => {
    expect(specialtyForIcd10('Z00.00')).toBeNull();
    expect(specialtyForIcd10('R10.9')).toBeNull();
    expect(specialtyForIcd10('hello')).toBeNull();
    expect(specialtyForIcd10(undefined)).toBeNull();
  });

  test('every line of the table names an area and a well-formed range or prefix', () => {
    for (const l of ICD10_SPECIALTIES) {
      expect(SPECIALTIES).toContain(l.specialty);
      expect(l.codes).toMatch(/^([A-Z]\d[0-9A-Z]-[A-Z]\d[0-9A-Z]|[A-Z]\d[0-9A-Z](\.[0-9A-Z]{1,4})?)$/);
      expect(l.what.length).toBeGreaterThan(3);
    }
  });

  test('cleanIcd10 reads codes as people and services write them', () => {
    expect(cleanIcd10(' m5412 ')).toBe('M54.12');
    expect(cleanIcd10('E11.9')).toBe('E11.9');
    expect(cleanIcd10('I10')).toBe('I10');
    expect(cleanIcd10('S13.9XXA')).toBe('S13.9XXA');
    expect(cleanIcd10('12.3')).toBeUndefined();
  });

  test('a name without a code suggests its area in any of the three languages', () => {
    expect(guessSpecialty('Cervical radiculopathy')).toBe('neurology');
    expect(guessSpecialty('Hernia de disco cervical')).toBe('neurology');
    expect(guessSpecialty('Hoge bloeddruk')).toBe('cardiology');
    expect(guessSpecialty('Type 2 diabetes')).toBe('endocrinology');
    expect(guessSpecialty('Heartburn')).toBe('gastroenterology');
    expect(guessSpecialty('Hepatitis C')).toBe('infectious');
    expect(guessSpecialty('Autoimmune hepatitis')).toBe('gastroenterology');
    expect(guessSpecialty('Heart failure')).toBe('cardiology');
    expect(guessSpecialty('Archive')).toBeNull();
    expect(guessSpecialty('Tornado')).toBeNull();
    expect(guessSpecialty('Something rare')).toBeNull();
    expect(defaultSpecialty({ name: 'Something rare' })).toBe('primary');
    // The code wins over the words.
    expect(defaultSpecialty({ name: 'Back pain with arthritis', icd10: 'M54.12' })).toBe('neurology');
  });
});

describe('condition documents', () => {
  test('conditionDoc keeps what the rules accept; the area defaults from the code and stays overridable', () => {
    const d = conditionDoc(
      { personId: 'p1', name: '  Type 2   diabetes ', icd10: 'e119', diagnosed: '2029-03', doctorId: 'c1', clinicId: 'c2', place: 'ignored with a clinic', medIds: ['m1', 'm1', ''], notes: ' Example note ' },
      { createdAt: NOW, by: 'sam@example.com' },
    );
    expect(d).toEqual({ personId: 'p1', name: 'Type 2 diabetes', icd10: 'E11.9', specialty: 'endocrinology', status: 'active', diagnosed: '2029-03', doctorId: 'c1', clinicId: 'c2', medIds: ['m1'], notes: 'Example note', createdAt: NOW, by: 'sam@example.com' });
    const chosen = conditionDoc({ personId: 'p1', name: 'Asthma', icd10: 'J45.909', specialty: 'allergy', status: 'resolved', resolved: '2030-06-02', place: 'Example Clinic' }, { createdAt: NOW, by: 'sam@example.com', updatedAt: NOW + 1 }, 'assistant');
    expect(chosen).toMatchObject({ specialty: 'allergy', status: 'resolved', resolved: '2030-06-02', place: 'Example Clinic', updatedAt: NOW + 1, via: 'assistant' });
  });

  test('a resolved date with no status is resolved; with a current status it is dropped, and conditionConflicts says so', () => {
    const stamp = { createdAt: NOW, by: 'sam@example.com' };
    expect(conditionDoc({ personId: 'p1', name: 'Wrist fracture', resolved: '2029' }, stamp)).toMatchObject({ status: 'resolved', resolved: '2029', specialty: 'orthopedics' });
    expect(conditionDoc({ personId: 'p1', name: 'Wrist fracture', status: 'active', resolved: '2029' }, stamp)).not.toHaveProperty('resolved');
    expect(conditionConflicts({ status: 'active', resolved: '2029' })).toEqual(['resolved']);
    expect(conditionConflicts({ resolved: '2029' })).toEqual([]);
    expect(conditionConflicts({ clinicId: 'c1', place: 'Example Hospital' })).toEqual(['place']);
  });

  test('partial dates: a year, a month or a real day', () => {
    for (const ok of ['2019', '2019-03', '2019-03-14', '2028-02-29']) expect(isPartialDate(ok)).toBe(true);
    for (const bad of ['19', '2019-13', '2019-3', '2019-02-30', '2027-02-29', 2019, '']) expect(isPartialDate(bad)).toBe(false);
  });

  test('toCondition reads defensively', () => {
    const c = toCondition('k1', { personId: 'x', name: 'Asthma', specialty: 'nope', status: 'gone', diagnosed: 'soon', medIds: ['m1', 5], createdAt: NOW, by: 'a@example.com' }, 'p1');
    expect(c).toEqual({ id: 'k1', personId: 'p1', name: 'Asthma', specialty: 'primary', status: 'active', medIds: ['m1'], createdAt: NOW, by: 'a@example.com' });
  });

  test('a visit about a condition publishes neither the condition nor the area', () => {
    const v = { id: 'v1', ...visitDoc({ personId: 'p1', kind: 'specialist', at: NOW + 86_400_000, conditionId: 'k1', specialty: 'mentalHealth' }, { createdAt: NOW, by: 'a@example.com' }) };
    const options = { person: { id: 'p1', name: 'Ana' }, audience: ['a@example.com'], household: { members: ['a@example.com'] }, url: 'https://example.com/health/' };
    const published = JSON.stringify([visitAgendaItem(v, options), visitReminders(v, { ...options, recipients: ['a@example.com'], now: NOW })]);
    expect(published).not.toContain('k1');
    expect(published).not.toContain('Mental health');
    expect(published).not.toContain('mentalHealth');
  });

  test('visits carry the condition they are about and their area', () => {
    const v = visitDoc({ personId: 'p1', kind: 'specialist', at: NOW, conditionId: 'k1', specialty: 'neurology' }, { createdAt: NOW, by: 'a@example.com' });
    expect(v).toMatchObject({ conditionId: 'k1', specialty: 'neurology' });
    expect(toVisit('v1', { ...v, specialty: 'nope' })).not.toHaveProperty('specialty');
    expect(toVisit('v1', v as unknown as Record<string, unknown>)).toMatchObject({ conditionId: 'k1', specialty: 'neurology' });
  });
});

describe('words and grouping', () => {
  const c = (name: string, specialty: Condition['specialty'], status: Condition['status'] = 'active') => ({ name, specialty, status });

  test('grouped by area: current areas first, primary care last, active before managed before resolved', () => {
    const groups = groupBySpecialty([
      c('Old fracture', 'orthopedics', 'resolved'),
      c('Seasonal allergies', 'primary'),
      c('Migraine', 'neurology', 'managed'),
      c('Cervical radiculopathy', 'neurology'),
      c('Hypertension', 'cardiology'),
    ]);
    expect(groups.map((g) => [g.specialty, g.current, g.conditions.map((x) => x.name)])).toEqual([
      ['cardiology', 1, ['Hypertension']],
      ['neurology', 2, ['Cervical radiculopathy', 'Migraine']],
      ['primary', 1, ['Seasonal allergies']],
      ['orthopedics', 0, ['Old fracture']],
    ]);
  });

  test('labels and dates in English, Spanish and Dutch', async () => {
    await loadLang('es');
    await loadLang('nl');
    expect(specialtyLabel('neurology')).toBe('Neurology');
    expect(withLang('es', () => specialtyLabel('neurology'))).toBe('Neurología');
    expect(withLang('nl', () => specialtyLabel('ent'))).toBe('KNO');
    expect(partialDateWords('2019')).toBe('2019');
    expect(partialDateWords('2019-03')).toBe('March 2019');
    expect(partialDateWords('2019-03-14')).toBe('March 14, 2019');
    expect(withLang('es', () => partialDateWords('2019-03'))).toBe('marzo de 2019');
    expect(withLang('nl', () => partialDateWords('2019-03'))).toBe('maart 2019');
  });
});

describe('searchConditions', () => {
  afterEach(() => clearConditionSearchCache());

  const answer = (body: unknown, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/json' } });

  test('consumer names with their code first, then ICD-10-CM descriptions when few; only the words are sent, no referrer', async () => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      if (url.includes('/conditions/')) return answer([1, ['10040'], { icd10cm_codes: ['M54.12'] }, [['Radiculopathy']]]);
      return answer([2, ['M54.12', 'M50.10'], null, [['M54.12', 'Radiculopathy, cervical region'], ['M50.10', 'Cervical disc disorder with radiculopathy, unspecified cervical region']]]);
    }) as unknown as typeof fetch;
    const found = await searchConditions('  cervical  radiculopathy ', { fetch: f });
    expect(found).toEqual([
      { name: 'Radiculopathy', icd10: 'M54.12', specialty: 'neurology' },
      { name: 'Radiculopathy, cervical region', icd10: 'M54.12', specialty: 'neurology' },
      { name: 'Cervical disc disorder with radiculopathy, unspecified cervical region', icd10: 'M50.10', specialty: 'neurology' },
    ]);
    expect(asked).toHaveLength(2);
    for (const a of asked) {
      expect(new URL(a.url).searchParams.get('terms')).toBe('cervical radiculopathy');
      expect(a.init).toMatchObject({ referrerPolicy: 'no-referrer', credentials: 'omit' });
    }
    // Kept for the session: the same words ask nothing.
    await searchConditions('Cervical radiculopathy', { fetch: f });
    expect(asked).toHaveLength(2);
  });

  test('enough consumer names ask nothing more; a short term asks nothing', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return answer([5, ['1', '2', '3', '4', '5'], { icd10cm_codes: ['J45.909', 'J45.30', 'J45.40', 'J45.20', 'J45.50'] }, [['Asthma'], ['Asthma - mild persistent'], ['Asthma - moderate persistent'], ['Asthma - mild intermittent'], ['Asthma - severe persistent']]]);
    }) as unknown as typeof fetch;
    expect(await searchConditions('a', { fetch: f })).toEqual([]);
    const found = await searchConditions('asthma', { fetch: f, limit: 5 });
    expect(found.map((m) => m.specialty)).toEqual(['pulmonology', 'pulmonology', 'pulmonology', 'pulmonology', 'pulmonology']);
    expect(calls).toBe(1);
  });

  test('when the second ask fails, the names found are the answer but not kept; with none found, it is unavailable', async () => {
    let calls = 0;
    let icdUp = false;
    const f = (async (url: string) => {
      calls++;
      if (url.includes('/conditions/')) return answer([1, ['1'], { icd10cm_codes: ['J45.909'] }, [['Asthma']]]);
      return icdUp ? answer([1, ['J45.20'], null, [['J45.20', 'Mild intermittent asthma, uncomplicated']]]) : answer({}, false);
    }) as unknown as typeof fetch;
    expect((await searchConditions('asthma', { fetch: f })).map((m) => m.name)).toEqual(['Asthma']);
    icdUp = true;
    expect((await searchConditions('asthma', { fetch: f })).map((m) => m.name)).toEqual(['Asthma', 'Mild intermittent asthma, uncomplicated']);
    expect(calls).toBe(4);
    const none = (async (url: string) => (url.includes('/conditions/') ? answer([0, [], {}, []]) : answer({}, false))) as unknown as typeof fetch;
    await expect(searchConditions('zzz', { fetch: none })).rejects.toBeInstanceOf(ConditionSearchUnavailable);
  });

  test('offline or busy: ConditionSearchUnavailable, and nothing is kept', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(searchConditions('migraine', { fetch: down })).rejects.toBeInstanceOf(ConditionSearchUnavailable);
    const busy = (async () => answer({}, false)) as unknown as typeof fetch;
    await expect(searchConditions('migraine', { fetch: busy })).rejects.toBeInstanceOf(ConditionSearchUnavailable);
  });
});
