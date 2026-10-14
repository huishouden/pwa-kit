/**
 * "Scan the label": medicine label photos (taken, chosen from the library, pasted or dropped, and
 * several at once for the front and back of a box: `./image-picker`) read on the device
 * (`../ocr` `readLabelLines`: several passes, unsure words dropped; nothing uploaded or kept) and
 * parsed (`../medicine-label` `parseLabel`, with the medicine names kept on the device). When the
 * label shows an NDC, the FDA's listing for that code (only the code, or for a half-read code the
 * medicine's listed name, is sent) supplies the exact
 * name, strength and form, if it agrees with what was read (`../medicine-lookup`). The app fills
 * its own form from the result and says what it filled. The card then shows, in this order, what
 * was filled in (field by field) and where it came from, the strengths to pick from when the
 * label's was unreadable, what to check (`assumptions`), the label lines it read but did not use
 * (`unparsed`, never hidden: a person must see what the form does not hold, such as a warning),
 * the pharmacy lines it left out on purpose, and the whole text it read, folded.
 *
 * ```tsx
 * <LabelScan onRead={(parsed) => {
 *   const draft = toMedCourse(parsed, { startDate: today });
 *   if (draft.name) setName(draft.name);
 *   return [draft.name && { label: 'Medicine', value: draft.name }].filter(Boolean);
 * }} />
 * ```
 */
import { useEffect, useRef, useState } from 'react';
import { ScanText } from 'lucide-react';
import { combineLabelTexts } from '../dose';
import type { LabelReading } from '../label-read';
import { parseLabel, type LabelCourse } from '../medicine-label';
import { withListing, type ListingOptions } from '../medicine-lookup';
import { medicineNames } from '../medicine-names-match';
import { readLabelLines } from '../ocr';
import { useKitT } from './i18n';
import { ImagePicker } from './image-picker';
import { Chip } from './ui';

declare global {
  interface Window {
    /** Browser tests set this to stand in for the label photo's text (OCR needs a real photo). */
    __mockLabelText?: string;
  }
}

/** One field the app filled from the label: "Medicine", "Lisinopril 10 mg". */
export interface LabelFill {
  label: string;
  value: string;
}

type Scan =
  | { status: 'idle' }
  | { status: 'reading'; progress: number; photo: number; photos: number }
  | { status: 'done'; text: string; filled: LabelFill[]; parsed: LabelCourse }
  | { status: 'error' };

export interface LabelScanProps {
  /** Fills the app's form from what was read; returns what it filled, in the form's order. */
  onRead: (parsed: LabelCourse, text: string) => LabelFill[];
  /**
   * The person picked one of the strengths the medicine comes in (`strengthChoices`, offered when
   * the label's own strength was unreadable): put it in the form. Without it the choices are listed.
   */
  onStrength?: (strength: string) => void;
  /** The line under the title before a photo is picked. */
  intro?: string;
  /** Reads the photo (tests); default `readLabelLines`, or `window.__mockLabelText` when set. */
  read?: (photo: Blob, onProgress: (progress: number) => void) => Promise<string | LabelReading>;
  /** The FDA listing step (tests); default `withListing` (openFDA, the NDC only). `null`: never look up. */
  listing?: ((course: LabelCourse, options: ListingOptions) => Promise<LabelCourse>) | null;
  /** Photos to read as soon as this shows, such as ones shared in from the gallery (`../shared-images`). */
  images?: File[];
}

const defaultRead = (photo: Blob, onProgress: (progress: number) => void) =>
  window.__mockLabelText !== undefined ? Promise.resolve(window.__mockLabelText) : readLabelLines(photo, { onProgress });

/** A lookup that takes longer than this is skipped: the label as read is filled in. */
const LISTING_TIMEOUT_MS = 6000;

const defaultListing = (course: LabelCourse, options: ListingOptions) =>
  Promise.race([withListing(course, options), new Promise<LabelCourse>((resolve) => setTimeout(() => resolve(course), LISTING_TIMEOUT_MS))]);

export function LabelScan({ onRead, onStrength, intro, read = defaultRead, listing = defaultListing, images }: LabelScanProps) {
  const kt = useKitT();
  intro ??= kt('dose.scanIntro');
  const [scan, setScan] = useState<Scan>({ status: 'idle' });
  const [picked, setPicked] = useState<string | null>(null);
  const run = useRef(0);

  /** Reads each photo in turn (the engine is one worker), then fills the form once from all of them. */
  const readPhotos = async (photos: File[]) => {
    const id = ++run.current;
    const readings: LabelReading[] = [];
    setPicked(null);
    setScan({ status: 'reading', progress: 0, photo: 1, photos: photos.length });
    for (const [n, photo] of photos.entries()) {
      try {
        const r = await read(photo, (progress) => id === run.current && setScan({ status: 'reading', progress, photo: n + 1, photos: photos.length }));
        readings.push(typeof r === 'string' ? { text: r, lines: [], words: [], codes: [], turns: 0, passes: 1 } : r);
      } catch {
        // One unreadable photo does not lose the others; all of them failing is the error.
      }
    }
    if (id !== run.current) return;
    if (readings.length === 0) {
      setScan({ status: 'error' });
      return;
    }
    try {
      const text = combineLabelTexts(readings.map((r) => r.text));
      // Print sizes compare within one photo only.
      const lines = readings.length === 1 && readings[0].lines.length ? readings[0].lines : undefined;
      const names = await medicineNames().catch(() => undefined);
      const codes = [...new Set(readings.flatMap((r) => r.codes))];
      let parsed = parseLabel(text, { lines, isMedicineName: names?.match });
      if (listing) parsed = await listing(parsed, { names, text, codes }).catch(() => parsed);
      if (id !== run.current) return;
      const filled = onRead(parsed, text).filter((f) => f.value.trim());
      setScan({ status: 'done', text, filled, parsed });
    } catch {
      setScan({ status: 'error' });
    }
  };

  // Photos handed in (shared from the gallery) are read once, when they arrive.
  const handled = useRef<File[] | undefined>(undefined);
  useEffect(() => {
    if (!images?.length || handled.current === images) return;
    handled.current = images;
    void readPhotos(images);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  const reading = scan.status === 'reading';

  const lines = (scan.status === 'done' ? scan.text : '').split(/\n+/).map((l) => l.trim()).filter(Boolean);

  return (
    <div className="space-y-3 rounded-2xl border border-line p-4">
      <p className="flex items-center gap-2 font-medium text-ink">
        <ScanText size={18} aria-hidden="true" /> {kt('dose.scan')}
      </p>
      <ImagePicker label={kt('dose.labelPhoto')} multiple disabled={reading} onImages={(photos) => void readPhotos(photos)} />
      {scan.status === 'reading' && (
        <p role="status" className="text-sm text-muted">
          {scan.photos > 1
            ? kt('dose.readingMany', { n: scan.photo, total: scan.photos, percent: Math.round(scan.progress * 100) })
            : kt('dose.reading', { percent: Math.round(scan.progress * 100) })}
        </p>
      )}
      {scan.status === 'idle' && <p className="text-sm text-muted">{intro}</p>}
      {scan.status === 'error' && (
        <p role="alert" className="text-base text-error">
          {kt('dose.readError')}
        </p>
      )}
      {scan.status === 'done' && (
        <div role="status" className="space-y-3 text-base text-ink-soft">
          {scan.filled.length === 0 ? (
            <p>{kt('dose.nothingFilled')}</p>
          ) : (
            <section aria-label={kt('dose.filledSection')}>
              <h3 className="font-medium text-link">{kt('dose.filledCheck')}</h3>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                {scan.filled.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-muted">{f.label}</dt>
                    <dd className="text-ink">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {scan.parsed.sources && Object.values(scan.parsed.sources).includes('fda') && scan.parsed.ndc && (
            <p className="text-sm text-muted">{kt('dose.fromListing', { ndc: scan.parsed.ndc })}</p>
          )}
          {scan.parsed.strengthChoices && scan.parsed.strengthChoices.length > 0 && (
            <section aria-label={kt('dose.strengthChoices')}>
              <h3 className="text-sm font-medium text-ink">{kt('dose.strengthChoices')}</h3>
              <p className="text-sm text-muted">{kt('dose.strengthChoicesHelp', { name: scan.parsed.name ?? '' })}</p>
              {onStrength ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  {scan.parsed.strengthChoices.map((s) => (
                    <Chip
                      key={s}
                      active={picked === s}
                      onClick={() => {
                        setPicked(s);
                        onStrength(s);
                      }}
                    >
                      {s}
                    </Chip>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink">{scan.parsed.strengthChoices.join(', ')}</p>
              )}
            </section>
          )}
          {scan.parsed.assumptions.length > 0 && (
            <section aria-label={kt('dose.checkThese')}>
              <h3 className="text-sm font-medium text-ink">{kt('dose.checkThese')}</h3>
              <ul className="list-disc pl-5 text-sm">
                {scan.parsed.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </section>
          )}
          {scan.parsed.unparsed.length > 0 && (
            <section aria-label={kt('dose.notUsedSection')}>
              <h3 className="text-sm font-medium text-ink">{kt('dose.notUsedSection')}</h3>
              <p className="text-sm text-muted">{kt('dose.notUsedHelp')}</p>
              <ul aria-label={kt('dose.notUsed')} className="mt-1 list-disc pl-5 text-sm">
                {scan.parsed.unparsed.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </section>
          )}
          {scan.parsed.ignored.length > 0 && (
            <p className="text-sm text-muted">{kt('dose.leftOut', { n: scan.parsed.ignored.length })}</p>
          )}
          {lines.length > 0 && (
            <details className="text-sm text-muted">
              <summary className="flex min-h-11 cursor-pointer select-none items-center">{kt('dose.everythingRead')}</summary>
              <ul aria-label={kt('dose.readFromPhoto')} className="mt-1 space-y-0.5 pl-1">
                {lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
