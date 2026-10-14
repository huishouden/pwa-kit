/**
 * Finds public package-label images on DailyMed (NLM) for the label-reading benchmark: for each
 * query, the first SPL of the wanted document type, its "principal display panel" images, and the
 * listing data (name, generic name, strength, form, route, NDCs) that becomes the ground truth.
 * Writes `.cache/candidates.json`; the reviewed result is `corpus.json` (`bun bench/labels/discover.ts`).
 */
import { mkdir, writeFile } from 'node:fs/promises';

type Kind = 'human-rx' | 'human-otc' | 'pet';
/** DailyMed document types (LOINC): human prescription, human OTC, prescription and OTC animal. */
const DOCTYPES: Record<Kind, string[]> = {
  'human-rx': ['34391-3'],
  'human-otc': ['34390-5'],
  pet: ['50578-4', '50577-6'],
};

export const QUERIES: [Kind, string][] = [
  ['human-rx', 'amoxicillin'], ['human-rx', 'lisinopril'], ['human-rx', 'atorvastatin'], ['human-rx', 'metformin'],
  ['human-rx', 'amlodipine'], ['human-rx', 'sertraline'], ['human-rx', 'prednisone'], ['human-rx', 'levothyroxine'],
  ['human-rx', 'azithromycin'], ['human-rx', 'ciprofloxacin ophthalmic'],
  ['human-rx', 'albuterol'], ['human-rx', 'gabapentin'], ['human-rx', 'cephalexin'], ['human-rx', 'omeprazole'],
  ['human-otc', 'ibuprofen'], ['human-otc', 'acetaminophen'], ['human-otc', 'loratadine'], ['human-otc', 'cetirizine'],
  ['human-otc', 'diphenhydramine'], ['human-otc', 'famotidine'], ['human-otc', 'naproxen'], ['human-otc', 'fluticasone'],
  ['pet', 'carprofen'], ['pet', 'apoquel'], ['pet', 'gabapentin'], ['pet', 'heartgard'], ['pet', 'nexgard'],
  ['pet', 'simparica'], ['pet', 'bravecto'], ['pet', 'revolution'], ['pet', 'clavamox'], ['pet', 'meloxicam'],
  ['pet', 'enrofloxacin'], ['pet', 'galliprant'], ['pet', 'vetmedin'], ['pet', 'methimazole'], ['pet', 'cerenia'],
  ['pet', 'credelio'], ['pet', 'amoxicillin'], ['pet', 'cephalexin'], ['pet', 'proin'], ['pet', 'trazodone'],
];

const BASE = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';

async function get(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.text();
    if (attempt >= 2) throw new Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
}

const strip = (xml: string) => xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#[0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();

export interface Product {
  ndc: string;
  name: string;
  generic: string;
  form: string;
  strengths: string[];
  packages: string[];
  routes: string[];
}

function products(xml: string): Product[] {
  const out: Product[] = [];
  const re = /<manufacturedProduct>\s*<code code="([\d-]+)"[^>]*\/>\s*<name>([^<]*)<\/name>(?:\s*<suffix>[^<]*<\/suffix>)?\s*<formCode[^>]*displayName="([^"]*)"([\s\S]*?)<\/manufacturedProduct>/g;
  for (let m; (m = re.exec(xml)); ) {
    const body = m[4];
    const generic = body.match(/<genericMedicine>\s*<name>([^<]*)<\/name>/)?.[1] ?? '';
    const strengths = [...body.matchAll(/<ingredient classCode="ACTI[BM]">\s*<quantity>\s*<numerator unit="([^"]*)" value="([^"]*)"\/>\s*<denominator unit="([^"]*)" value="([^"]*)"\/>/g)].map(
      (s) => `${s[2]} ${s[1]}${s[3] !== '1' ? `/${s[4] === '1' ? '' : s[4]}${s[3]}` : ''}`,
    );
    const packages = [...body.matchAll(/<containerPackagedProduct>\s*<code code="([\d-]+)"/g)].map((p) => p[1]);
    // The route sits after the product, in its consumedIn/substanceAdministration block.
    const after = xml.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const routes = [...after.matchAll(/<routeCode[^>]*displayName="([^"]*)"/g)].map((r) => r[1]).slice(0, 1);
    out.push({ ndc: m[1], name: m[2].trim(), generic: generic.trim(), form: m[3], strengths, packages, routes });
  }
  return out;
}

function panels(xml: string): { title: string; text: string; images: string[] }[] {
  const out: { title: string; text: string; images: string[] }[] = [];
  const parts = xml.split(/<section[ >]/).slice(1);
  for (const p of parts) {
    if (!/code="51945-4"/.test(p.slice(0, 400))) continue;
    const title = strip(p.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const text = strip(p.match(/<text>([\s\S]*?)<\/text>/)?.[1] ?? '');
    const images = [...p.matchAll(/<reference value="([^"]+\.(?:jpe?g|png|gif))"/gi)].map((r) => r[1]);
    if (images.length) out.push({ title, text, images });
  }
  return out;
}

if (import.meta.main) {
  const out: unknown[] = [];
  for (const [kind, q] of QUERIES) {
    const list: { setid: string; title: string }[] = [];
    for (const doctype of DOCTYPES[kind]) {
      const page = JSON.parse(await get(`${BASE}/spls.json?drug_name=${encodeURIComponent(q)}&doctype=${doctype}&pagesize=15`)) as { data: { setid: string; title: string }[] };
      list.push(...page.data);
    }
    let found = 0;
    for (const spl of list) {
      if (found >= 2) break;
      let xml: string;
      try {
        xml = await get(`${BASE}/spls/${spl.setid}.xml`);
      } catch {
        continue;
      }
      const docType = xml.match(/displayName="([^"]*DRUG LABEL)"/)?.[1] ?? '';
      const pdp = panels(xml);
      if (!pdp.length) continue;
      found++;
      out.push({ kind, query: q, setid: spl.setid, title: spl.title, docType, products: products(xml), panels: pdp.slice(0, 3) });
      console.log(kind, q, spl.title, pdp.length);
    }
  }
  await mkdir(new URL('.cache/', import.meta.url), { recursive: true });
  await writeFile(new URL('.cache/candidates.json', import.meta.url), JSON.stringify(out, null, 1));
}
