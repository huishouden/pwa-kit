#!/usr/bin/env bun
// Usage: bun scripts/medicine-names.ts   Writes src/medicine-names.ts: the names the label reader
// recognises on the device. Human medicines: RxNorm's prescribable ingredients and brands (NLM
// RxNav, public), without allergen extracts, vaccines and the like. Pet medicines: the products of
// common animal-drug labels on DailyMed (NLM), with the strengths each comes in, for the person to
// pick when a label's strength is unreadable. Re-run to refresh; the output is reviewed in the PR.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PET_QUERIES = [
  'carprofen', 'rimadyl', 'novox', 'apoquel', 'cytopoint', 'heartgard', 'interceptor', 'sentinel', 'simparica', 'nexgard',
  'bravecto', 'credelio', 'revolution', 'advantage', 'frontline', 'trifexis', 'comfortis', 'clavamox', 'metacam', 'meloxidyl',
  'previcox', 'deramaxx', 'galliprant', 'onsior', 'vetmedin', 'fortekor', 'felimazole', 'methimazole', 'cerenia', 'proin',
  'incurin', 'baytril', 'convenia', 'simplicef', 'zeniquin', 'orbax', 'panacur', 'drontal', 'profender', 'thyro-tabs',
  'soloxine', 'vetoryl', 'mirataz', 'entyce', 'clomicalm', 'reconcile', 'sileo', 'librela', 'solensia', 'enroflox',
  'rilexine', 'clavacillin', 'cephalexin', 'doxycycline', 'prednisolone', 'enalapril', 'benazepril', 'phenobarbital', 'zonisamide', 'gabapentin',
];
const SKIP = /\b(?:extract|pollen|allergenic|antigen|vaccine|leaf|root|seed|flower|bark|fruit|whole|venom|mite|mold|feather|dander|hair|epithelia|insect|grass|weed|tree|oil|berry|herb|honey|flavor|food)\b/i;

async function get(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.text();
    if (attempt >= 3) throw new Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
}

// Ordinary English words that are also listed as ingredients ("white", "human", "water", "nitrate")
// would match label text that isn't a medicine's name: left out, unless they read as a medicine
// (a usual drug ending) or are on the short list of medicines that are dictionary words.
const DICTIONARY = '/usr/share/dict/words';
const dictionary = (await Bun.file(DICTIONARY).exists()) ? new Set((await Bun.file(DICTIONARY).text()).split('\n').map((w) => w.toLowerCase())) : null;
if (!dictionary) console.warn(`${DICTIONARY} not found: dictionary words are not left out`);
const DRUG_ENDING = /(?:cillin|mycin|micin|cycline|oxacin|pril|sartan|olol|statin|azole|tidine|dipine|caine|barbital|phrine|amine|pine|done|phine|zine|trol|sone|lone|terone|estrone|thyroid|insulin|heparin)$/;
const DICTIONARY_MEDICINES = new Set('aspirin insulin codeine morphine penicillin quinine caffeine lithium nicotine heparin atropine colchicine niacin biotin menthol camphor oxytocin bacitracin chloroquine quinidine theophylline scopolamine pilocarpine lindane'.split(' '));
const ordinary = (name: string) => {
  const first = name.split(/[\s/,()-]+/)[0].toLowerCase();
  return !!dictionary?.has(first) && !DRUG_ENDING.test(first) && !DICTIONARY_MEDICINES.has(first);
};

const rx = JSON.parse(await get('https://rxnav.nlm.nih.gov/REST/Prescribe/allconcepts.json?tty=IN+BN')) as { minConceptGroup: { minConcept: { name: string }[] } };
const human = [...new Set(rx.minConceptGroup.minConcept.map((c) => c.name.trim()))]
  .filter((n) => !SKIP.test(n) && n.split(/\s+/).length <= 4 && /^[A-Za-z]/.test(n) && !ordinary(n))
  .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

interface PetProduct {
  name: string;
  generic: string;
  form: string;
  strengths: string[];
}
const pets = new Map<string, PetProduct>();
const DM = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';
for (const q of PET_QUERIES) {
  for (const doctype of ['50578-4', '50577-6']) {
    const list = JSON.parse(await get(`${DM}/spls.json?drug_name=${encodeURIComponent(q)}&doctype=${doctype}&pagesize=4`)) as { data: { setid: string }[] };
    for (const spl of list.data.slice(0, 3)) {
      const xml = await get(`${DM}/spls/${spl.setid}.xml`);
      // Attributes come in any order: read each tag's attributes by name.
      const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
      const re = /<manufacturedProduct>\s*<code [^>]*\/>\s*<name>([^<]*)<\/name>(?:\s*<suffix>[^<]*<\/suffix>)?\s*(<formCode[^>]*>)([\s\S]*?)<\/manufacturedProduct>/g;
      for (let m; (m = re.exec(xml)); ) {
        const name = m[1].trim();
        const form = attr(m[2], 'displayName');
        const generic = (m[3].match(/<genericMedicine>\s*<name>([^<]*)<\/name>/)?.[1] ?? '').trim();
        const strength = [...m[3].matchAll(/<ingredient classCode="ACTI[BM]">\s*<quantity>\s*(<numerator[^>]*>)\s*(<denominator[^>]*>)/g)]
          .map((q) => {
            const [nu, nv, du, dv] = [attr(q[1], 'unit'), attr(q[1], 'value'), attr(q[2], 'unit'), attr(q[2], 'value')];
            return `${Number(nv)} ${nu === 'ug' ? 'mcg' : nu}${du && du !== '1' ? `/${dv === '1' ? '' : dv}${du}` : ''}`;
          })
          .join(' / ');
        if (!name || !strength) continue;
        const key = `${name.toLowerCase()}|${form}`;
        const p = pets.get(key) ?? { name, generic, form: form.toLowerCase(), strengths: [] };
        if (!p.strengths.includes(strength)) p.strengths.push(strength);
        pets.set(key, p);
      }
    }
  }
}
const petList = [...pets.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const p of petList) p.strengths.sort((a, b) => parseFloat(a) - parseFloat(b));

const out = `/**
 * Medicine names the label reader recognises on the device (\`./medicine-label\`), so a name read
 * half-right ("Erythromy") is put right and a person's name is never taken for a medicine's.
 * Generated by scripts/medicine-names.ts from RxNorm (prescribable ingredients and brands, NLM
 * RxNav) and DailyMed's animal-drug labels (NLM): public data. Loaded only when a label is read.
 */

/** Human medicines: RxNorm ingredient and brand names, one per line. */
export const HUMAN_NAMES = ${JSON.stringify(human.join('\n'))};

/** Pet medicines from animal-drug labels: brand, generic name, form and the strengths it comes in. */
export const PET_PRODUCTS: { name: string; generic: string; form: string; strengths: string[] }[] = ${JSON.stringify(petList)};
`;
writeFileSync(join(import.meta.dir, '..', 'src', 'medicine-names.ts'), out);
console.log(`medicine names: ${human.length} human, ${petList.length} pet products`);
