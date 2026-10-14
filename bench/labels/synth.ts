/**
 * Synthetic pharmacy and vet-clinic labels for the benchmark: the layouts of real bottle labels
 * (pharmacy header, Rx number, patient, directions, drug line, quantity, refills, prescriber; the
 * manufacturer's band with the NDC) with invented people, clinics and addresses, drawn in a
 * browser (`bun bench/labels/synth.ts`). Real Rx labels carry the directions and quantity, which
 * the public package labels don't. Writes `.cache/src/<id>.png` and `.cache/synthetic.json`.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { CACHE, type Label } from './fetch';

interface Rx {
  id: string;
  set: 'human' | 'pet';
  /** Look-alike of a layout: a pharmacy bottle with the maker's band, or a vet vial cut off at the right. */
  layout: 'pharmacy' | 'vet';
  drug: string;
  maker?: string;
  ndc?: string;
  directions: string;
  qty: string;
  refills: string;
  truth: Label['truth'];
  people: { patient: string; owner?: string; prescriber: string; place: string; street: string; town: string; phone: string };
  /** The share of the label's width left visible (a vial label wraps out of sight). */
  visible?: number;
}

const PHARMACIES = [
  { place: 'Larkmoor Pharmacy #2117', street: '418 Fennimore Ave', town: 'Oakvale, OH 43001', phone: '(555) 014-2290' },
  { place: 'Copperfield Drug #0604', street: '92 Quillon St', town: 'Marrow Bay, WA 98001', phone: '(555) 017-8834' },
];
const CLINICS = [
  { place: 'Maple Hollow Animal Hospital', street: '7 Tansy Lane', town: 'Brierton, VT 05001', phone: '(555) 019-4410' },
  { place: 'Riverbend Veterinary Clinic', street: '1550 Osgood Rd', town: 'Pell City, KS 66002', phone: '(555) 012-7765' },
];

const h = (drug: string, maker: string, ndc: string, directions: string, qty: string, patient: string, prescriber: string, truth: Omit<Label['truth'], 'private'>, n = 0): Rx => ({
  id: `syn-${truth.names[0].split(' ')[0].toLowerCase()}`,
  set: 'human', layout: 'pharmacy', drug, maker, ndc, directions, qty, refills: `${(n % 3) + 1} by 0${(n % 8) + 1}/1${n % 9}/32`,
  people: { patient, prescriber, ...PHARMACIES[n % 2] }, truth,
});
const v = (drug: string, directions: string, qty: string, pet: string, owner: string, prescriber: string, truth: Omit<Label['truth'], 'private'>, n = 0, visible?: number): Rx => ({
  id: `syn-vet-${truth.names[truth.names.length - 1].split(' ')[0].toLowerCase()}`,
  set: 'pet', layout: 'vet', drug, directions, qty, refills: String(n % 4), visible,
  people: { patient: pet, owner, prescriber, ...CLINICS[n % 2] }, truth,
});

export const SYNTHETIC: Rx[] = [
  h('ATORVASTATIN 20MG TABLETS', 'RADHA', '77771-452-90', 'TAKE 1 TABLET BY MOUTH DAILY AT BEDTIME. MAX DAILY AMOUNT: 1 TABLET', '90', 'TOBIAS WRENFIELD', 'DR. ANNIKA SOLBERG-PRATT',
    { names: ['atorvastatin', 'atorvastatin calcium'], strength: '20 mg', form: 'tablet', route: 'oral', ndc: '77771-452-90', directions: { dose: '1 tablet', timesPerDay: 1 } }, 0),
  h('LISINOPRIL 10MG TABLETS', 'LUPIN', '68180-980-01', 'TAKE ONE TABLET BY MOUTH ONCE DAILY', '90', 'MARGUERITE OKONKWO-BELL', 'DR. RAFAEL DUNMORE',
    { names: ['lisinopril'], strength: '10 mg', form: 'tablet', route: 'oral', ndc: '68180-980-01', directions: { dose: '1 tablet', timesPerDay: 1 } }, 1),
  h('METFORMIN HCL 500MG TABLETS', 'GRANULES', '62207-440-47', 'TAKE 1 TABLET BY MOUTH TWICE DAILY WITH MEALS', '180', 'HAROLD PENWICK', 'DR. LUCIA ABERNATHY',
    { names: ['metformin hcl', 'metformin', 'metformin hydrochloride'], strength: '500 mg', form: 'tablet', route: 'oral', ndc: '62207-440-47', directions: { dose: '1 tablet', timesPerDay: 2 } }, 2),
  h('AMOXICILLIN 500MG CAPSULES', 'TEVA', '0093-3109-05', 'TAKE 1 CAPSULE BY MOUTH THREE TIMES DAILY UNTIL ALL TAKEN', '30', 'JUNE ESTERHAZY', 'DR. KWAME FALLOWS',
    { names: ['amoxicillin'], strength: '500 mg', form: 'capsule', route: 'oral', ndc: '0093-3109-05', directions: { dose: '1 capsule', timesPerDay: 3 } }, 3),
  h('PREDNISONE 20MG TABLETS', 'HIKMA', '0054-0018-20', 'TAKE 2 TABLETS BY MOUTH DAILY WITH FOOD FOR 5 DAYS', '10', 'OSWALD TREMAINE', 'DR. PRIYA VANTERPOOL',
    { names: ['prednisone'], strength: '20 mg', form: 'tablet', route: 'oral', ndc: '0054-0018-20', directions: { dose: '2 tablets', timesPerDay: 1 } }, 4),
  h('VENTOLIN HFA 90MCG INHALER', 'GLAXOSMITHKLINE', '0173-0682-20', 'INHALE 2 PUFFS BY MOUTH EVERY 4 HOURS AS NEEDED FOR WHEEZING', '18 GM', 'BEATRIX QUENNELL', 'DR. SAMUEL ORTEGA-WHITBY',
    { names: ['ventolin hfa', 'ventolin', 'albuterol'], strength: '90 mcg', form: 'inhaler', route: 'inhalation', ndc: '0173-0682-20', directions: { dose: '2 puffs', intervalHours: 4, asNeeded: true } }, 5),
  h('OFLOXACIN 0.3% OPHTH SOLUTION', 'ALTAIRE', '59390-140-05', 'INSTILL 1 DROP IN EACH EYE FOUR TIMES DAILY FOR 7 DAYS', '5 ML', 'CORNELIUS HAVERTY', 'DR. MEI-LIN ROSSITER',
    { names: ['ofloxacin'], strength: '0.3%', form: 'liquid', route: 'ophthalmic', ndc: '59390-140-05', directions: { dose: '1 drop', timesPerDay: 4 } }, 6),
  h('SERTRALINE 50MG TABLETS', 'LUPIN', '68180-352-02', 'TAKE 1 TABLET BY MOUTH EVERY MORNING', '30', 'ROSALIND THACKERAY', 'DR. EMEKA LINDQVIST',
    { names: ['sertraline', 'sertraline hcl'], strength: '50 mg', form: 'tablet', route: 'oral', ndc: '68180-352-02', directions: { dose: '1 tablet', timesPerDay: 1 } }, 7),
  v('Prednisolone 5mg Tablet', 'Give 1 tablet(s) by mouth every 12 hours for 5 days, then 1 tab every 24 hours for 5 days for inflammation', '15.00', 'Pickle (Canine)', 'Vashti Holloway', 'Dr. Ingrid Paulsen, DVM',
    { names: ['prednisolone'], strength: '5 mg', form: 'tablet', route: 'oral', ndc: null, directions: { dose: '1 tablet', intervalHours: 12 } }, 0, 0.8),
  v('Carprofen 75mg Chewable Tablets', 'Give 1 tablet by mouth every 12 hours with food', '60.00', 'Juniper (Canine)', 'Desmond Achterberg', 'Dr. Felicity Moreau, DVM',
    { names: ['carprofen'], strength: '75 mg', form: 'chewable', route: 'oral', ndc: null, directions: { dose: '1 tablet', intervalHours: 12 } }, 1),
  v('Gabapentin 100mg Capsules', 'Give 1 capsule by mouth every 8 hours as needed for pain', '30.00', 'Mochi (Feline)', 'Corinne Blackwood', 'Dr. Tomasz Ellery, DVM',
    { names: ['gabapentin'], strength: '100 mg', form: 'capsule', route: 'oral', ndc: null, directions: { dose: '1 capsule', intervalHours: 8, asNeeded: true } }, 2),
  v('Clavamox 250mg Chewable Tablets', 'Give 1 tablet by mouth twice daily for 10 days', '20.00', 'Rufus (Canine)', 'Anselm Kirkby', 'Dr. Ingrid Paulsen, DVM',
    { names: ['clavamox', 'amoxicillin'], strength: '250 mg', form: 'chewable', route: 'oral', ndc: null, directions: { dose: '1 tablet', timesPerDay: 2 } }, 3, 0.85),
  v('Cephalexin 500mg Capsules', 'Give 1 capsule by mouth every 12 hours until gone', '28.00', 'Hazel (Canine)', 'Leopold Varga', 'Dr. Felicity Moreau, DVM',
    { names: ['cephalexin'], strength: '500 mg', form: 'capsule', route: 'oral', ndc: null, directions: { dose: '1 capsule', intervalHours: 12 } }, 4),
  v('Metronidazole 250mg Tablets', 'Give 1/2 tablet by mouth twice daily with food for 7 days', '7.00', 'Olive (Feline)', 'Philippa Dunleavy', 'Dr. Tomasz Ellery, DVM',
    { names: ['metronidazole'], strength: '250 mg', form: 'tablet', route: 'oral', ndc: null, directions: { dose: '0.5 tablet', timesPerDay: 2 } }, 5),
  v('Meloxicam 1.5mg/mL Oral Suspension', 'Give 0.5 mL by mouth once daily with food', '10 mL', 'Biscuit (Canine)', 'Garrett Oyelaran', 'Dr. Ingrid Paulsen, DVM',
    { names: ['meloxicam'], strength: '1.5 mg/mL', form: 'liquid', route: 'oral', ndc: null, directions: { dose: '0.5 ml', timesPerDay: 1 } }, 6, 0.85),
];

const CSS = `body{margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#111}
.label{width:860px;padding:0;background:#fff;position:relative}
.band{background:#1d4f91;color:#fff;padding:10px 18px;font-size:22px;display:flex;justify-content:space-between}
.vband{background:#2e6b3a;color:#fff;padding:10px 18px;font-size:22px}
.box{padding:14px 18px 10px;border:2px solid #333;border-top:0}
.hdr{display:flex;justify-content:space-between;font-size:17px;line-height:1.25}
.big{font-size:27px;font-weight:700;margin:10px 0 6px;line-height:1.2}
.drug{font-size:25px;font-weight:700;margin:8px 0}
.row{display:flex;justify-content:space-between;font-size:18px;margin-top:4px}
.small{font-size:15px;color:#333}
.bar{position:absolute;right:6px;top:70px;width:34px;height:220px;background:repeating-linear-gradient(0deg,#000 0 3px,#fff 3px 5px,#000 5px 6px,#fff 6px 9px)}`;

function html(rx: Rx): string {
  const p = rx.people;
  if (rx.layout === 'pharmacy') {
    return `<div class="label"><div class="band"><span>NDC ${rx.ndc}</span><span>${rx.maker}</span></div><div class="box">
<div class="hdr"><div><b>${p.place}</b><br>${p.street}<br>${p.town}<br>${p.phone}</div><div style="text-align:right">RX# 0${rx.id.length}48217-0${rx.id.length + 2}911<br>DATE: 0${rx.refills.length % 9 + 1}/0${rx.qty.length}/31</div></div>
<div class="row" style="font-size:22px;font-weight:700;margin-top:10px"><span>${p.patient}</span></div>
<div class="big">${rx.directions}</div>
<div class="drug">${rx.drug}</div>
<div class="row"><span>MFR: ${rx.maker}</span><span>QTY: ${rx.qty}</span></div>
<div class="row"><span>REFILLS: ${rx.refills}</span><span>${p.prescriber}</span></div>
<div class="small" style="margin-top:6px">USE BEFORE: 09/30/32 &nbsp; CAUTION: FEDERAL LAW PROHIBITS TRANSFER OF THIS DRUG</div>
</div><div class="bar"></div></div>`;
  }
  return `<div class="label"><div class="vband"><b>${p.place}</b> &nbsp; ${p.phone}</div><div class="box">
<div class="small">${p.street}, ${p.town}</div>
<div class="row"><span>Pet: <b>${p.patient}</b></span><span>Client: ${p.owner}</span></div>
<div class="drug">${rx.drug}</div>
<div class="big" style="font-weight:600">${rx.directions}</div>
<div class="row"><span>Qty: ${rx.qty}</span><span>Refills: ${rx.refills}</span><span>Date: 6/1${rx.qty.length}/2031</span></div>
<div class="row"><span>${p.prescriber}</span></div>
<div class="small" style="margin-top:6px">For veterinary use only. Keep out of reach of children.</div></div></div>`;
}

if (import.meta.main) {
  await mkdir(`${CACHE}src`, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 900, height: 700 } });
  const labels: Label[] = [];
  for (const rx of SYNTHETIC) {
    await page.setContent(`<style>${CSS}</style>${html(rx)}`);
    const el = page.locator('.label');
    const box = (await el.boundingBox())!;
    const width = Math.round(box.width * (rx.visible ?? 1));
    await page.screenshot({ path: `${CACHE}src/${rx.id}.png`, clip: { x: box.x, y: box.y, width, height: box.height } });
    // The text a person sees: what is left of each line after the cut, in reading order.
    const text = await page.evaluate((visibleRight) => {
      const out: string[] = [];
      const walker = document.createTreeWalker(document.querySelector('.label')!, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent ?? '';
        let kept = '';
        for (let i = 0; i < t.length; i++) {
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const r = range.getBoundingClientRect();
          if (r.right <= visibleRight + 1) kept += t[i];
        }
        if (kept.trim()) out.push(kept.trim());
      }
      return out.join('\n');
    }, box.x + width);
    const p = rx.people;
    labels.push({
      id: rx.id, set: rx.set, kind: rx.layout === 'pharmacy' ? 'synthetic-pharmacy' : 'synthetic-vet', source: 'synthetic (bench/labels/synth.ts)',
      truth: { ...rx.truth, private: [p.patient.replace(/\s*\(.*\)/, ''), p.owner, p.prescriber.replace(/^dr\.?\s*/i, '').replace(/,.*$/, ''), p.street, p.place].filter((s): s is string => !!s), text },
    });
  }
  await browser.close();
  await Bun.write(`${CACHE}synthetic.json`, JSON.stringify(labels, null, 1));
  console.log(labels.length, 'synthetic labels');
}
