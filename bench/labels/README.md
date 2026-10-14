# Label benchmark

How well the kit reads medicine labels from photos (`LabelScan`, `readLabelLines`, `parseLabel`,
`withListing`), field by field, so a change to the reader is kept only when it measures better.

## The set

- **Package labels** (`corpus.json`, 55): principal display panels of human prescription, human
  OTC and animal drug labels from DailyMed (U.S. National Library of Medicine), each with its
  source page and image address, cut to the label where the image is a whole carton. Downloaded by
  `fetch.ts`, never committed. Truth (name, strength, form, route, NDC, directions where shown) was
  read off each image by eye; `null` where the label does not show it.
- **Pharmacy and vet labels** (`synth.ts`, 15): drawn in a browser with the layouts of real ones
  (pharmacy header, Rx number, patient, directions, drug line, quantity, refills, prescriber, the
  maker's band with the NDC; a vet vial cut off at the right edge). Every person, pet, clinic and
  address is invented; the drugs and NDCs are real products. They carry the directions and the
  private strings the parser must never put in a medicine field.
- **Phone-like photos** (`variants.ts`): each label flat, plus three of perspective, a curved
  bottle, blur, glare, low light and a quarter or half turn, on a cloth, wood or plain surface at
  about 2400 px; each pharmacy and vet label also on a vial with the neighbouring bottles' labels
  showing at both sides. 280 images, deterministic.
- **Local photos** (`--local <file>`): real household photos stay on the machine, in a truth file
  outside the repository. Only their scores are printed or saved, never their text or fields.

## Running it

```sh
bun bench/labels/fetch.ts && bun bench/labels/synth.ts && bun bench/labels/variants.ts   # once (~2 min)
bun bench/labels/bench.ts --read baseline --parse directions --name baseline   # the reader before (v0.123.0)
bun bench/labels/bench.ts --read kit --parse fda --name kit                    # the reader now (~4 min, 6 workers)
bun bench/labels/bench.ts --reuse kit --parse names                            # parse an earlier run again (seconds)
bun bench/labels/debug.ts kit lisinopril-2.5~glare                             # one image: its lines and fields
BENCH_OPTS='{"psms":["11"]}' bun bench/labels/bench.ts --name try-psm11        # reader options (ReadLabelPassOptions)
```

A field counts where the label shows it: right, wrong (filled with something else, which a person
has to catch) or empty. `strengthOffered`: of the labels whose strength was not read, the share
where the right one is among the strengths offered to pick from. Text: key-token recall (name
words, strength numbers, NDC found in the text read), and for the synthetic and local labels the
character error rate and word precision and recall against the full text. `leaks`: private strings
in a saved field. `--save` writes the scores (no text) to `results/`.

## Results (October 2026)

280 images (156 human, 124 pet); right % (wrong %).

| Field | Human before | Human now | Pet before | Pet now |
| --- | --- | --- | --- | --- |
| Name | 17 (13) | 81 (7) | 15 (29) | 71 (11) |
| Strength | 42 (35) | 79 (7) | 50 (20) | 60 (13) |
| Strength unread, the right one offered to pick | – | 0% of 21 | – | 60% of 30 |
| Form | 14 (0) | 94 (1) | 26 (2) | 88 (6) |
| Route | 20 (5) | 90 (3) | 23 (2) | 82 (7) |
| NDC | 0 (0) | 61 (4) | 0 (0) | 50 (7) |
| Directions (pharmacy and vet labels) | 81 (9) | 94 (6) | 70 (11) | 80 (14) |
| Key-token recall | 0.50 | 0.64 | 0.49 | 0.51 |
| Word precision, synthetic labels | 0.73 | 0.87 | 0.75 | 0.90 |
| Character error rate, synthetic labels | 0.36 | 0.25 | 0.28 | 0.11 |
| Private strings in a medicine field | 0 | 0 | 0 | 0 |
| Seconds per image (one engine, M-series core) | 1.3 | 4.7 | 1.1 | 4.6 |

What each step adds (human name / strength, pet name / strength; same images):

| Reader | Parser | Human | Pet |
| --- | --- | --- | --- |
| before | before | 17 / 42 | 15 / 50 |
| before | label fields | 22 / 46 | 18 / 51 |
| before | + medicine names | 55 / 46 | 62 / 51 |
| before | + FDA listing | 64 / 60 | 62 / 51 |
| now | before | 24 / 58 | 16 / 60 |
| now | label fields | 31 / 63 | 20 / 60 |
| now | + medicine names | 69 / 63 | 71 / 60 |
| now | + FDA listing | 81 / 79 | 71 / 60 |

Reader options tried (with the current parser; human name / strength / NDC, pet name / strength / NDC, seconds):

| Reader | Human | Pet | s |
| --- | --- | --- | --- |
| sparse text (11) only | 79 / 77 / 64 | 69 / 61 / 54 | 3.9 |
| page (3) only | 71 / 69 / 54 | 66 / 52 / 43 | 3.8 |
| 11 then 3, always | 81 / 81 / 64 | 70 / 59 / 50 | 5.7 |
| **11 then 3 when 11 finds little (kept)** | 81 / 79 / 61 | 71 / 60 / 50 | 4.5 |
| without the other quarter turns | 74 / 72 / 63 | 65 / 55 / 46 | 5.2 |
| with CLAHE local contrast | 77 / 76 / 58 | 73 / 67 / 50 | 6.9 |
| 11, and 11 again with CLAHE | 78 / 77 / 66 | 72 / 68 / 54 | 5.8 |
| with Sauvola black and white | 70 / 63 / 47 | 63 / 54 / 29 | 7.8 |
| with a zoomed second read of the text area | 81 / 80 / 66 | 70 / 60 / 50 | 6.2 |

Dropped: CLAHE (pet strength up 7, human name down 4: a wash, and slower), Sauvola (worse
everywhere), the zoomed read (no gain), PSM 3 alone. Kept: PSM 11 first, PSM 3 only when needed,
the quarter turns, word confidences, lines rebuilt from word positions, the number fixes, the
package-label fields, the medicine names, the FDA listing.

A vision model on Workers AI, the same 70 photo-like images (one per label), for comparison only
(`cloud.ts`; never a household photo):

| | Name | Strength | Form | Route | NDC | Directions |
| --- | --- | --- | --- | --- | --- | --- |
| On the device (this reader) | 67 (10) | 64 (9) | 91 (3) | 84 (4) | 50 (9) | 58 (32) |
| mistral-small-3.1-24b-instruct | 99 (1) | 94 (4) | 96 (4) | 83 (4) | 82 (16) | 68 (32) |
| llama-4-scout-17b (30 of them) | 90 (10) | 90 (0) | 97 (3) | 57 (0) | 76 (24) | 86 (14) |

About 40 to 55 neurons an image (10,000 free a day).
