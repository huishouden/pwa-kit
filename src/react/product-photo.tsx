/**
 * Add by photo: a camera button beside an app's add field, and the dialog it opens. Photos come in
 * through `ImagePicker` (take one, or choose several), are read by the app's `read` (normally
 * `readProductPhotos` from `../product-photo`), and come back as a checklist: every product ticked,
 * its name, section and quantity editable, anything already on the list unticked and marked. Nothing
 * is added until "Add N items" is tapped. When the day's photo reading is used up, it says so and
 * offers typing instead.
 *
 * ```tsx
 * <AddByPhotoButton onClick={() => setPhoto(true)} />
 * {photo && (
 *   <AddByPhotoDialog
 *     read={(files) => readProductPhotos(files, { endpoint, household, idToken, categories })}
 *     categories={sections.map((c) => ({ value: c, label: sectionLabel(c) }))}
 *     sectionFor={(p) => p.category ?? guessSection(p.name)}
 *     onList={(name) => open.some((i) => sameProduct(i.name, name))}
 *     onAdd={(items) => items.forEach(addItem)}
 *     onType={() => { setPhoto(false); focusAddField(); }}
 *     onClose={() => setPhoto(false)}
 *   />
 * )}
 * ```
 */
import { useId, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { ImagePicker } from './image-picker';
import { useKitT } from './i18n';
import { Dialog, ghostButton, iconButton, inputClass, overline, primaryButton, secondaryButton, selectClass } from './ui';
import { ProductPhotoError, type ProductReading, type ReadProduct } from '../product-photo';
import { nameWords, PRODUCT_PHOTO_LIMITS } from '../product-photo-core';

/** What "Add N items" hands the app, one per ticked row. */
export interface PhotoItem {
  name: string;
  category: string;
  quantity: string;
}

export interface ProductRow extends PhotoItem {
  key: string;
  checked: boolean;
  onList: boolean;
  barcode: boolean;
}

/** The checklist's rows for a reading: ticked unless already on the list; rows already shown are not repeated. */
export function productRows(reading: ProductReading, { sectionFor, onList, existing = [] }: { sectionFor: (p: ReadProduct) => string; onList: (name: string) => boolean; existing?: ProductRow[] }): ProductRow[] {
  const seen = new Set(existing.map((r) => nameWords(r.name).join(' ')));
  const rows: ProductRow[] = [];
  for (const p of reading.products) {
    const key = nameWords(p.name).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const listed = onList(p.name);
    rows.push({ key: `${existing.length + rows.length}:${key}`, name: p.name, category: sectionFor(p), quantity: '1', checked: !listed, onList: listed, barcode: p.via === 'barcode' });
  }
  return [...existing, ...rows];
}

/** The ticked rows with a name, as items to add. */
export const pickedItems = (rows: readonly ProductRow[]): PhotoItem[] =>
  rows.filter((r) => r.checked && r.name.trim()).map((r) => ({ name: r.name.trim(), category: r.category, quantity: r.quantity.trim() || '1' }));

export interface ProductChecklistProps {
  rows: ProductRow[];
  categories: { value: string; label: string }[];
  onChange: (rows: ProductRow[]) => void;
}

/** The editable checklist on its own: tick, name, section and quantity per product. */
export function ProductChecklist({ rows, categories, onChange }: ProductChecklistProps) {
  const kt = useKitT();
  const id = useId();
  const set = (i: number, change: Partial<ProductRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  return (
    <ul className="grid gap-2" aria-label={kt('productPhoto.title')}>
      {rows.map((r, i) => (
        <li key={r.key} className={`flex items-start gap-3 rounded-2xl border border-line p-3 ${r.checked ? '' : 'opacity-70'}`} data-product-row="">
          <input
            type="checkbox"
            checked={r.checked}
            onChange={(e) => set(i, { checked: e.target.checked })}
            aria-label={kt('productPhoto.pick', { name: r.name })}
            aria-describedby={r.onList || r.barcode ? `${id}-${i}` : undefined}
            className="mt-3 h-5 w-5 shrink-0 accent-primary"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <input value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={kt('productPhoto.name')} className={inputClass} enterKeyHint="done" />
            <div className="flex gap-2">
              <select value={r.category} onChange={(e) => set(i, { category: e.target.value })} aria-label={kt('productPhoto.section')} className={`${selectClass} min-w-0 flex-1`}>
                {categories.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input value={r.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-label={kt('productPhoto.quantity')} className={`${inputClass} w-20 shrink-0 text-center`} />
            </div>
            {(r.onList || r.barcode) && (
              <p id={`${id}-${i}`} className="text-sm text-muted">
                {r.onList ? kt('productPhoto.onList') : kt('productPhoto.barcode')}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The camera button beside an add field. */
export function AddByPhotoButton({ onClick, large = false, className = '' }: { onClick: () => void; large?: boolean; className?: string }) {
  const kt = useKitT();
  return (
    <button type="button" onClick={onClick} className={`${iconButton} ${className}`} aria-label={kt('productPhoto.button')} title={kt('productPhoto.button')} data-add-by-photo="">
      <Camera size={large ? 24 : 20} aria-hidden="true" />
    </button>
  );
}

export interface AddByPhotoDialogProps {
  /** Reads the photos (normally `readProductPhotos`). */
  read: (files: File[]) => Promise<ProductReading>;
  /** The sections offered for each product, in order. */
  categories: { value: string; label: string }[];
  /** The section a product starts in (its `category` from the model, the barcode's `hints`, the app's own word list). */
  sectionFor: (product: ReadProduct) => string;
  /** Whether a name is already on the list: such rows start unticked, marked "Already on list". */
  onList: (name: string) => boolean;
  /** The ticked products, on "Add N items". */
  onAdd: (items: PhotoItem[]) => void;
  /** "Type instead": close and put the person in the add field. */
  onType: () => void;
  onClose: () => void;
  title?: string;
}

type Step =
  | { kind: 'pick' }
  | { kind: 'reading'; photos: number }
  | { kind: 'confirm' }
  | { kind: 'stopped'; message: string; retry: boolean };

/** The dialog: pick photos, a placeholder while they are read, then the checklist. */
export function AddByPhotoDialog({ read, categories, sectionFor, onList, onAdd, onType, onClose, title }: AddByPhotoDialogProps) {
  const kt = useKitT();
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const busy = useRef(false);
  const picked = pickedItems(rows);

  const readPhotos = async (files: File[]) => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    const photos = Math.min(files.length, PRODUCT_PHOTO_LIMITS.photosPerPick);
    setStep({ kind: 'reading', photos });
    try {
      const reading = await read(files);
      const next = productRows(reading, { sectionFor, onList, existing: rows });
      const said: string[] = [];
      if (reading.capped) said.push(kt('productPhoto.someCapped', { count: reading.capped.photos }));
      if (reading.failed) said.push(kt('productPhoto.someFailed', { count: reading.failed }));
      if (next.length > 0) {
        setRows(next);
        setNotes(said);
        setStep({ kind: 'confirm' });
      } else if (reading.capped && reading.capped.photos + reading.failed >= photos) {
        setStep({ kind: 'stopped', message: kt(reading.capped.by === 'household' ? 'productPhoto.cappedHousehold' : 'productPhoto.cappedEveryone'), retry: false });
      } else if (reading.failed >= photos) {
        setStep({ kind: 'stopped', message: kt('productPhoto.failed'), retry: true });
      } else {
        setStep({ kind: 'stopped', message: kt('productPhoto.none'), retry: true });
      }
    } catch (e) {
      const reason = e instanceof ProductPhotoError ? e.reason : 'unavailable';
      setStep({ kind: 'stopped', message: kt(reason === 'sign-in' ? 'productPhoto.signIn' : reason === 'not-member' ? 'productPhoto.notMember' : 'productPhoto.failed'), retry: reason === 'unavailable' });
    } finally {
      busy.current = false;
    }
  };

  const back = () => setStep(rows.length > 0 ? { kind: 'confirm' } : { kind: 'pick' });
  const typeInstead = (
    <button type="button" onClick={onType} className={step.kind === 'stopped' && !step.retry ? primaryButton : secondaryButton}>
      {kt('productPhoto.typeInstead')}
    </button>
  );

  const footer =
    step.kind === 'confirm' ? (
      <>
        <button type="button" onClick={onClose} className={ghostButton}>
          {kt('common.cancel')}
        </button>
        <button type="button" onClick={() => onAdd(picked)} disabled={picked.length === 0} className={primaryButton}>
          {kt('productPhoto.add', { count: picked.length })}
        </button>
      </>
    ) : step.kind === 'stopped' ? (
      <>
        {typeInstead}
        {step.retry && (
          <button type="button" onClick={back} className={primaryButton}>
            {kt('productPhoto.tryAgain')}
          </button>
        )}
      </>
    ) : step.kind === 'pick' ? (
      typeInstead
    ) : undefined;

  return (
    <Dialog title={title ?? kt('productPhoto.title')} onClose={onClose} footer={footer}>
      {step.kind === 'pick' && (
        <div className="space-y-4">
          <p className="text-ink">{kt('productPhoto.intro')}</p>
          <ImagePicker label={kt('productPhoto.photoLabel')} multiple onImages={(files) => void readPhotos(files)} />
          <p className="text-sm text-muted">{kt('productPhoto.privacy')}</p>
        </div>
      )}

      {step.kind === 'reading' && (
        <section role="status" aria-busy="true" className="space-y-3" data-photo-reading="">
          <p className="text-ink">{kt('productPhoto.reading', { count: step.photos })}</p>
          <ul className="grid gap-2" aria-hidden="true">
            {Array.from({ length: Math.max(2, step.photos) }, (_, i) => (
              <li key={i} className="flex items-start gap-3 rounded-2xl border border-line p-3">
                <span className="mt-3 h-5 w-5 shrink-0 animate-pulse rounded bg-sunken motion-reduce:animate-none" />
                <span className="flex-1 space-y-2">
                  <span className="block h-11 animate-pulse rounded-xl bg-sunken motion-reduce:animate-none" />
                  <span className="block h-11 w-2/3 animate-pulse rounded-xl bg-sunken motion-reduce:animate-none" />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {step.kind === 'confirm' && (
        <div className="space-y-3">
          <p className="text-ink" role="status">
            {kt('productPhoto.found', { count: rows.length })}
          </p>
          {notes.map((n) => (
            <p key={n} className="text-sm text-attention">
              {n}
            </p>
          ))}
          <ProductChecklist rows={rows} categories={categories} onChange={setRows} />
          <div className="space-y-2 pt-1">
            <p className={overline}>{kt('productPhoto.another')}</p>
            <ImagePicker label={kt('productPhoto.photoLabel')} multiple onImages={(files) => void readPhotos(files)} />
          </div>
        </div>
      )}

      {step.kind === 'stopped' && (
        <p role="alert" className="text-ink" data-photo-stopped="">
          {step.message}
        </p>
      )}
    </Dialog>
  );
}
