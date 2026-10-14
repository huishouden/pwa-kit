/**
 * The cloud comparison: the same public and synthetic label images read by a vision model on
 * Cloudflare Workers AI instead of on the device, scored the same way (`score.ts`). For the
 * decision only (the apps read on the device); never run on a real household photo: this script
 * reads only the benchmark set (`.cache/set.json`), never `--local` photos.
 *
 *   CLOUD_AI_URL=http://localhost:8799 bun bench/labels/cloud.ts --model @cf/... [--limit 40]
 *   bun bench/labels/cloud.ts --model @cf/... --against kit    # no calls: the on-device run on the same images
 *
 * CLOUD_AI_URL is a Worker with an AI binding that runs `{ model, input }` and answers
 * `{ ms, out }` (wrangler dev, AI bindings are remote). Free allocation: 10,000 neurons a day.
 */
import sharp from 'sharp';
import { CACHE, corpus, type Label } from './fetch';
import type { SetItem } from './variants';
import { FIELDS, scoreFields, type Field, type Outcome, type Reading } from './score';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const model = opt('model') ?? '@cf/mistralai/mistral-small-3.1-24b-instruct';
const limit = Number(opt('limit') ?? 40);
const url = process.env.CLOUD_AI_URL ?? 'http://localhost:8799';

const PROMPT = `You read medicine labels from photos for a household's medicine list. Read the label in the photo and reply with JSON only:
{"name": medicine name as printed (brand or generic, no strength), "strength": e.g. "10 mg" or "5 mg/mL", "form": e.g. "tablets", "capsules", "oral solution", "ointment", "route": e.g. "by mouth", "in the eye", "ndc": the NDC as printed or null,
 "dose_amount": number per dose or null, "dose_unit": "tablet"|"capsule"|"ml"|"drop"|"puff"|null, "times_per_day": number or null, "interval_hours": number or null, "as_needed": true|false}
Use null for anything the label does not show. Never include a person's, pet's, prescriber's or pharmacy's name or address.`;

const labels = new Map<string, Label>([...(await corpus()), ...(await Bun.file(`${CACHE}synthetic.json`).json())].map((l: Label) => [l.id, l]));
const all: SetItem[] = await Bun.file(`${CACHE}set.json`).json();
// One photo-like image per label (not the flat scan): the effect each label got first, or the vial.
const seen = new Set<string>();
const photos = all.filter((i) => i.variant !== 'flat' && !seen.has(i.id) && seen.add(i.id));
// Spread over the whole corpus (human, pet, synthetic) when fewer than all are asked for.
const items = photos.filter((_, i) => photos.length <= limit || Math.floor((i * limit) / photos.length) !== Math.floor(((i - 1) * limit) / photos.length));

type Row = { id: string; variant: string; set: string; kind: string; fields: Partial<Record<Field, Outcome>>; ms: number; tokens?: unknown; reading?: Reading };
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const row = (rs: Row[]) =>
  FIELDS.map((f) => {
    const sc = rs.filter((r) => r.fields[f]);
    return sc.length ? `${pct(sc.filter((r) => r.fields[f] === 'right').length, sc.length)} (${pct(sc.filter((r) => r.fields[f] === 'wrong').length, sc.length)} wrong, n=${sc.length})` : '–';
  }).join(' | ');
const table = (title: string, rs: Row[]) => {
  console.log(`\n${title}: ${rs.length} images\n| group | ${FIELDS.join(' | ')} |`);
  for (const [k, g] of Object.entries({ human: rs.filter((r) => r.set === 'human'), pet: rs.filter((r) => r.set === 'pet'), all: rs })) console.log(`| ${k} | ${row(g)} |`);
};

const against = opt('against');
if (against) {
  // The same images as the model's run, scored from an on-device run: no calls.
  const cloud = await Bun.file(`${CACHE}results/cloud-${model.split('/').pop()}.json`).json();
  const run = (await Bun.file(`${CACHE}results/${against}.json`).json()).results as Row[];
  const same = cloud.items.map((k: string) => run.find((r) => `${r.id}~${r.variant}` === k)).filter(Boolean) as Row[];
  table(`on the device (${against}), the images of ${model}`, same);
  table(model, cloud.results);
  process.exit(0);
}

const results: Row[] = [];
for (const item of items) {
  const label = labels.get(item.id)!;
  const jpeg = await sharp(item.file).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  const input = {
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: [{ type: 'text', text: 'The label:' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }] },
    ],
    max_tokens: 300,
    temperature: 0,
  };
  let answer: Record<string, unknown> = {};
  let ms = 0;
  let tokens: unknown;
  try {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({ model, input }) });
    const j = (await r.json()) as { ms: number; out?: any; error?: string };
    ms = j.ms;
    tokens = j.out?.usage;
    const text: string = typeof j.out?.response === 'string' ? j.out.response : JSON.stringify(j.out?.response ?? j.out?.choices?.[0]?.message?.content ?? '');
    answer = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    if (j.error) console.error(item.id, j.error);
  } catch (e) {
    console.error(item.id, String(e));
  }
  const s = (k: string) => (typeof answer[k] === 'string' && answer[k] ? (answer[k] as string) : undefined);
  const n = (k: string) => (typeof answer[k] === 'number' ? (answer[k] as number) : undefined);
  const reading: Reading = {
    text: '',
    name: s('name'), strength: s('strength'), form: s('form'), route: s('route'), ndc: s('ndc'),
    doseAmount: n('dose_amount'), doseUnit: s('dose_unit'), timesPerDay: n('times_per_day'), intervalHours: n('interval_hours'), asNeeded: answer.as_needed === true,
    shown: [s('name'), s('strength'), s('form'), s('route')].filter((x): x is string => !!x),
  };
  results.push({ id: item.id, variant: item.variant, set: label.set, kind: label.kind, fields: scoreFields(reading, label.truth), ms, tokens, reading });
  console.error(item.id, item.variant, JSON.stringify(results.at(-1)!.fields), JSON.stringify(tokens));
}

table(model, results);
await Bun.write(`${CACHE}results/cloud-${model.split('/').pop()}.json`, JSON.stringify({ model, items: results.map((r) => `${r.id}~${r.variant}`), results: results.map(({ tokens: _t, ...r }) => ({ ...r, ms: Math.round(r.ms) })) }, null, 1));
