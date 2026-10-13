/**
 * The Huishouden UI primitives for React apps (DESIGN.md "Components"): class strings for buttons,
 * inputs and cards, and the dialog, chip, field, toast-with-Undo, error notice, status pill,
 * checkbox, section tabs (a bottom bar on phones), member badge, "Sample data" banner every app shows, and
 * the suggestion chip (tap to add, long press to stop suggesting) with its `useLongPress`, a copy button,
 * the note offering to bring back Google's window when it may have opened out of sight, and the
 * completion pattern (`CompleteButton`, `CompletionRow`, `CompletionList`: DESIGN.md "Completion"), and
 * the placeholder every app shows while it opens (`ScreenSkeleton`).
 *
 * Styled with Tailwind v4 on the kit's palette: import `@huishouden/pwa-kit/tailwind.css` after
 * `tailwindcss` in the app's stylesheet. It maps the theme (forest, cream, terracotta) and adds
 * these files to Tailwind's sources. Icons are lucide-react, like the apps'. Each has `dark:` styles
 * (DESIGN.md "Dark and ambient modes") that apply only under a `.dark` class, for apps with a dark setting.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Ellipsis, EyeOff, Plus, SkipForward, X, type LucideIcon } from 'lucide-react';
import { personColour, personInitial, personName } from '../people';
import { clockWords, toHhmm } from '../time';
import { useKitT } from './i18n';
import { kt } from '../i18n';
import { COMPLETE_OPEN, COMPLETE_UNDO } from '../complete';

export const inputClass =
  'w-full min-h-11 rounded-xl border border-line bg-white px-3 py-2.5 text-base text-ink outline-none focus:border-forest-500 focus:ring-2 focus:ring-forest-200 dark:bg-forest-900 dark:focus:ring-forest-700';

/** A select styled like the inputs. */
export const selectClass = `${inputClass} appearance-auto`;

export const primaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50';

export const ghostButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 font-medium text-muted transition-colors duration-150 hover:bg-stone-100 dark:hover:bg-forest-700';

/** The second action next to a primary button. */
export const secondaryButton = `${ghostButton} border border-line bg-surface disabled:opacity-50`;

export const iconButton =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 hover:bg-stone-100 disabled:opacity-30 dark:hover:bg-forest-700';

/** Footer button that deletes; the destructive action stays quiet until asked for. */
export const deleteButton = 'mr-auto inline-flex min-h-11 items-center gap-2 rounded-xl px-3 font-medium text-error hover:bg-stone-100 dark:hover:bg-forest-700';

export const cardClass = 'rounded-2xl border border-line bg-surface shadow-sm';

export const overline = 'text-xs font-semibold uppercase tracking-wide text-muted';

/** A text link with a 44px target: phone numbers, Open in Google Maps, Open in Calendar. */
export const linkClass =
  '-mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2 font-medium text-link underline-offset-4 transition-colors duration-150 hover:bg-tint hover:underline';

export function Chip({ active, onClick, children, label }: { active?: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
        active
          ? 'border-forest-700 bg-forest-700 text-white dark:border-forest-300 dark:bg-forest-300 dark:text-forest-900'
          : 'border-line bg-surface text-ink-soft hover:border-forest-400'
      }`}
    >
      {children}
    </button>
  );
}

/** How long a finger rests on something before it counts as a long press. */
export const LONG_PRESS_MS = 500;

/** Handlers to spread on an element so a long press or a right-click (or the keyboard's menu key) runs `onLongPress`. */
export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onClickCapture: (e: ReactMouseEvent) => void;
}

/**
 * A long press (touch or mouse, held still for `ms`) or a right-click runs `onLongPress`, and the
 * click that ends a long press is swallowed, so the element's own onClick runs only for a tap.
 * Moving more than 10px is a scroll, not a press. Pair the element with a visible way to reach the
 * same action: a long press is not discoverable on its own.
 */
export function useLongPress(onLongPress: () => void, ms = LONG_PRESS_MS): LongPressHandlers {
  const latest = useRef(onLongPress);
  latest.current = onLongPress;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onPointerDown: (e) => {
      fired.current = false;
      if (e.button !== 0) return;
      cancel();
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        start.current = null;
        fired.current = true;
        latest.current();
      }, ms);
    },
    onPointerMove: (e) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e) => {
      e.preventDefault();
      cancel();
      // A long press on Android also raises contextmenu; the press already ran it.
      if (!fired.current) latest.current();
    },
    onClickCapture: (e) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/**
 * Something the app learned and offers back, "tap to add": a pill that runs `onPick` on a tap. A
 * long press or right-click opens a small sheet with "Don't suggest <label>"; with `editing` an ×
 * beside the label does the same at once, for a visible way in (an "Edit" link by the shelf's
 * heading). Every target is at least 44px. Removing is the app's (with its Undo).
 */
export function SuggestionChip({
  label,
  onPick,
  onRemove,
  editing,
  large,
  removeLabel,
  hint,
}: {
  label: string;
  onPick: () => void;
  onRemove: () => void;
  /** Shows an × that removes it with one tap. */
  editing?: boolean;
  /** The always-on tablet's larger text. */
  large?: boolean;
  removeLabel?: string;
  /** A line in the sheet under the action, such as when it may come back. */
  hint?: string;
}) {
  const kt = useKitT();
  removeLabel ??= kt('ui.dontSuggest', { label });
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => setMenu(true));
  return (
    <span
      className={`inline-flex min-h-11 shrink-0 items-center rounded-full border border-forest-200 bg-forest-50 font-medium text-forest-700 dark:border-forest-600 dark:bg-forest-800 dark:text-forest-100 ${
        large ? 'text-lg' : 'text-sm'
      }`}
    >
      <button
        type="button"
        {...press}
        onClick={onPick}
        aria-label={kt('ui.addSuggestion', { label })}
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full whitespace-nowrap select-none [-webkit-touch-callout:none] hover:bg-forest-100 dark:hover:bg-forest-700 ${
          large ? 'px-4' : 'px-3.5'
        } ${editing ? 'pr-1' : ''}`}
      >
        <Plus size={large ? 18 : 14} strokeWidth={2.5} aria-hidden="true" />
        {label}
      </button>
      {editing && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-forest-700 hover:bg-tint-strong dark:text-forest-100"
        >
          <X size={large ? 18 : 16} aria-hidden="true" />
        </button>
      )}
      {menu &&
        // Into the body, so the sheet takes none of the pill's text styles and no scroller clips it.
        createPortal(
          <Dialog title={label} onClose={() => setMenu(false)}>
            <button
              type="button"
              onClick={() => {
                setMenu(false);
                onRemove();
              }}
              className={`${secondaryButton} w-full justify-start`}
            >
              <EyeOff size={18} aria-hidden="true" /> {removeLabel}
            </button>
            {hint && <p className="mt-3 text-sm text-muted">{hint}</p>}
          </Dialog>,
          document.body,
        )}
    </span>
  );
}

/**
 * A dialog: bottom sheet on phones, centred on tablets; title and close row; Escape and the scrim
 * close it. `wide` for a dialog with a table or two columns.
 *
 * Focus is placed once, when it opens, and never again: re-renders (a clock tick, a snapshot, a
 * new `onClose` arrow from the parent) leave it where the person put it. With a mouse the first
 * field takes it (or a field already focused with `autoFocus`); on a touch screen the dialog
 * itself does, so the keyboard only opens when a field is tapped.
 */
export function Dialog({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const kt = useKitT();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (touchScreen()) return el.focus({ preventScroll: true });
    if (el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>('input, select, textarea, button:not([data-dialog-close])')?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`safe-bottom outline-none max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-surface p-6 shadow-2xl sm:rounded-3xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} className={iconButton} aria-label={kt('ui.close')} data-dialog-close="">
            <X size={20} />
          </button>
        </div>
        {children}
        {/* Labels never break inside a button: on a narrow phone the buttons share rows, growing to fill them. */}
        {footer && <div className="mt-6 flex flex-wrap items-center justify-end gap-2 [&>*]:whitespace-nowrap max-sm:[&>*]:grow">{footer}</div>}
      </div>
    </div>
  );
}

/** A touch screen, where focusing a text field opens the on-screen keyboard. */
const touchScreen = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-sm text-muted">{hint}</span>}
    </label>
  );
}

/**
 * Copies `text` to the clipboard from a tap, and says "Copied" for a moment: a Zelle email, an
 * account number. `what` names it for screen readers and the tooltip ("Copy the Zelle email").
 */
export function CopyButton({ text, what, className = iconButton }: { text: string; what: string; className?: string }) {
  const kt = useKitT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  const label = kt('ui.copy', { what });
  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? kt('ui.copied') : label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
      <span className="sr-only" aria-live="polite">
        {copied ? kt('ui.copied') : ''}
      </span>
    </button>
  );
}

export function Checkbox({ checked, onChange, children, describedBy }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; describedBy?: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-1 text-base text-ink">
      <input type="checkbox" className="h-5 w-5 shrink-0 accent-primary" checked={checked} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

export type Attention = 'overdue' | 'soon' | 'ok' | 'unknown';

/** "Overdue" and "Soon" labels; nothing for the rest, so the eye goes to what needs doing. */
export function StatusPill({ state }: { state: Attention }) {
  const kt = useKitT();
  if (state === 'overdue')
    return <span className="inline-flex shrink-0 items-center rounded-full bg-attention-tint px-2.5 py-0.5 text-sm font-semibold text-attention">{kt('ui.overdue')}</span>;
  if (state === 'soon')
    return <span className="inline-flex shrink-0 items-center rounded-full border border-line bg-surface px-2.5 py-0.5 text-sm font-semibold text-ink-soft">{kt('ui.soon')}</span>;
  return null;
}

/** A failed action in words, with Try again. */
export function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const kt = useKitT();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-error-tint px-3 py-2 text-base text-error">
      <span className="min-w-0 flex-1">{message}</span>
      <button type="button" className="min-h-11 rounded-xl px-3 font-semibold underline-offset-4 hover:underline" onClick={onRetry}>
        {kt('ui.tryAgain')}
      </button>
    </div>
  );
}

/**
 * The note above a signed-out app's invented household. On phones it is one line, the "Sample data"
 * chip and `short`, which opens `text` on a tap; from 640px up `text` sits beside the chip.
 * `notice` (a sign-in error) takes the text's place at every width. `children` (scenario chips) follow
 * on their own row on phones, on the same row when there is room.
 */
export function SampleBanner({
  text,
  short,
  notice,
  children,
  className = '',
}: {
  text: string;
  short?: string;
  notice?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const kt = useKitT();
  short ??= kt('ui.nothingSaved');
  const [open, setOpen] = useState(false);
  return (
    <div role="note" data-sample-banner className={`${cardClass} flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1 sm:px-4 sm:py-1.5 ${className}`}>
      <div data-sample-line className="flex min-h-11 w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1 sm:gap-4">
        <span data-sample-chip className="shrink-0 rounded-full bg-attention-tint px-3 py-1 text-sm font-semibold whitespace-nowrap text-attention">
          {kt('ui.sampleData')}
        </span>
        {notice ? (
          typeof notice === 'string' ? <p className="min-w-0 flex-1 text-base text-muted">{notice}</p> : <div className="min-w-0 flex-1">{notice}</div>
        ) : (
          <>
            <button
              type="button"
              data-sample-short
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-xl text-left text-sm text-muted sm:hidden"
            >
              <span className="truncate">{short}</span>
              <ChevronDown size={16} strokeWidth={2.2} aria-hidden className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
              <span className="sr-only">{open ? kt('ui.hideDetails') : kt('ui.details')}</span>
            </button>
            <p className="hidden min-w-0 flex-1 text-base text-muted sm:block">{text}</p>
          </>
        )}
      </div>
      {open && !notice && <p className="w-full pb-1.5 text-sm text-muted sm:hidden">{text}</p>}
      {children}
    </div>
  );
}

const pulse = 'animate-pulse rounded bg-sunken motion-reduce:animate-none';

/**
 * What every app shows while it opens (DESIGN.md "Empty and loading states"): from the first paint
 * until the session is restored and the first data has arrived, a still placeholder the size of a
 * screen's rows: an overline and a card of `rows` rows. Signed-in or not, no sign-in screen, empty
 * state or half-drawn app flashes before it, and nothing jumps when the real screen replaces it.
 * A status region, so screen readers announce "Loading…" and `label` ("Loading the household's day.").
 */
export function ScreenSkeleton({ rows = 3, label }: { rows?: number; label?: string }) {
  const kt = useKitT();
  return (
    <section role="status" aria-busy="true" aria-label={kt('common.loading')} data-hh-skeleton="">
      {label && <p className="sr-only">{label}</p>}
      <div className={`mb-2 h-4 w-24 ${pulse}`} aria-hidden="true" />
      <ul className={`${cardClass} divide-y divide-line`} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex min-h-20 items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5 sm:py-4">
            <span className={`h-11 w-11 shrink-0 ${pulse} rounded-xl`} />
            <span className="flex-1 space-y-2">
              <span className={`block h-6 w-2/3 ${pulse}`} />
              <span className={`block h-5 w-1/3 ${pulse}`} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface Tab {
  id: string;
  label: string;
  /** A lucide icon, shown beside the label in the phone's bottom bar and its More sheet. */
  icon?: LucideIcon;
  /** One of the (at most four) tabs the phone's bottom bar shows; the rest go under More. */
  primary?: boolean;
  /** A shorter label for the bottom bar when `label` is long ("Visits" for "Appointments"). */
  short?: string;
}

/** Tabs the phone's bottom bar has room for, More included. */
export const BOTTOM_NAV_MAX = 5;

/**
 * Which tabs the phone's bottom bar shows and which go under More: all of them when they fit
 * (four or fewer), else the ones marked `primary` (the first four if none is), in their order.
 */
export function splitTabs(tabs: Tab[]): { bar: Tab[]; more: Tab[] } {
  if (tabs.length < BOTTOM_NAV_MAX) return { bar: tabs, more: [] };
  const marked = tabs.filter((t) => t.primary).slice(0, BOTTOM_NAV_MAX - 1);
  const bar = marked.length ? marked : tabs.slice(0, BOTTOM_NAV_MAX - 1);
  return { bar, more: tabs.filter((t) => !bar.includes(t)) };
}

/**
 * The app's sections. On tablets and desktops (640px and up) a segmented control in the app bar's
 * `nav` slot: `<AppBar …><SectionTabs tabs={…} tab={tab} onTab={setTab} /></AppBar>`. On phones a
 * bar fixed to the bottom of the screen instead (DESIGN.md "Frame"): up to four tabs with icon and
 * short label, and More opening a sheet with the rest when there are five or more. While the bar
 * shows, `<html data-hh-bottom-nav>` gives the page bottom padding (the kit's tailwind.css) and sets
 * `--hh-bottom-nav` to its height, so an app's own fixed bottom elements sit above it with
 * `bottom-(--hh-bottom-nav)`. Dialogs and sheets cover it.
 *
 * `compact` tightened the phone tabs before the bottom bar; it no longer changes anything.
 */
export function SectionTabs({ tabs, tab, onTab }: { tabs: Tab[]; tab: string; onTab: (id: string) => void; compact?: boolean }) {
  const kt = useKitT();
  if (tabs.length === 0) return null;
  return (
    <>
      <nav
        slot="nav"
        data-bottom-nav=""
        aria-label={kt('ui.sections')}
        className="hidden w-full gap-1 overflow-x-auto rounded-2xl border border-line bg-surface p-1 sm:flex sm:w-auto"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            aria-current={t.id === tab ? 'page' : undefined}
            className={`min-h-11 flex-1 rounded-xl px-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 sm:flex-none sm:px-5 sm:text-base ${
              t.id === tab ? 'bg-primary text-on-primary' : 'text-muted hover:bg-stone-100 dark:hover:bg-forest-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {typeof document !== 'undefined' && createPortal(<BottomNav tabs={tabs} tab={tab} onTab={onTab} />, document.body)}
    </>
  );
}

const BOTTOM_NAV_ATTR = 'data-hh-bottom-nav';

function BottomNav({ tabs, tab, onTab }: { tabs: Tab[]; tab: string; onTab: (id: string) => void }) {
  const kt = useKitT();
  const [sheet, setSheet] = useState(false);
  const { bar, more } = splitTabs(tabs);
  const inMore = more.some((t) => t.id === tab);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute(BOTTOM_NAV_ATTR, '');
    return () => root.removeAttribute(BOTTOM_NAV_ATTR);
  }, []);
  const item = (key: string, label: string, Icon: LucideIcon | undefined, active: boolean, props: Record<string, unknown>) => (
    <li key={key} className="flex min-w-0 flex-1">
      <button
        type="button"
        {...props}
        className={`flex min-h-16 w-full min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs font-medium transition-colors duration-150 ${
          active ? 'text-link' : 'text-muted'
        }`}
      >
        <span
          aria-hidden
          className={`flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-150 ${active ? 'bg-forest-100 dark:bg-forest-700' : ''}`}
        >
          {Icon ? <Icon size={22} strokeWidth={active ? 2.4 : 2} /> : null}
        </span>
        <span className={`max-w-full truncate ${active ? 'font-semibold' : ''}`}>{label}</span>
      </button>
    </li>
  );
  return (
    <>
      <nav
        {...{ [BOTTOM_NAV_ATTR]: '' }}
        aria-label={kt('ui.sections')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] sm:hidden"
      >
        <ul className="mx-auto flex max-w-lg">
          {bar.map((t) => item(t.id, t.short ?? t.label, t.icon, t.id === tab, { onClick: () => onTab(t.id), 'aria-current': t.id === tab ? 'page' : undefined }))}
          {more.length > 0 &&
            item('more', kt('ui.more'), Ellipsis, inMore, {
              onClick: () => setSheet(true),
              'aria-haspopup': 'dialog',
              'aria-expanded': sheet,
              'aria-label': inMore ? kt('ui.moreShowing', { tab: more.find((t) => t.id === tab)!.label }) : kt('ui.more'),
            })}
        </ul>
      </nav>
      {sheet && (
        <Dialog title={kt('ui.more')} onClose={() => setSheet(false)}>
          <ul className="grid gap-1">
            {more.map((t) => {
              const Icon = t.icon;
              const active = t.id === tab;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      setSheet(false);
                      onTab(t.id);
                    }}
                    className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base font-medium transition-colors duration-150 ${
                      active ? 'bg-tint text-forest-700 dark:text-forest-200' : 'text-ink hover:bg-stone-100 dark:hover:bg-forest-700'
                    }`}
                  >
                    {Icon ? <Icon size={22} aria-hidden /> : null}
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </Dialog>
      )}
    </>
  );
}

/** A member's initial on their colour, for "logged by" marks. */
export function PersonBadge({ email, me, members, size = 32 }: { email: string; me: string; members: string[]; size?: number }) {
  const kt = useKitT();
  const name = personName(email, { email: me });
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-1 ring-tile-ring"
      style={{ width: size, height: size, backgroundColor: personColour(email, members), fontSize: size * 0.42 }}
      title={kt('ui.loggedBy', { name })}
      aria-label={kt('ui.loggedBy', { name })}
      role="img"
    >
      {personInitial(email)}
    </span>
  );
}

export interface ToastState {
  id: number;
  message: string;
  tone: 'info' | 'error';
  undo?: () => void;
}

/** One toast at a time: `notify` (with an optional Undo), `fail` (an error), `clear`. Pair with `<Toast>`. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const notify = useCallback((message: string, undo?: () => void) => setToast({ id: Date.now(), message, tone: 'info', undo }), []);
  const fail = useCallback((message: string) => setToast({ id: Date.now(), message, tone: 'error' }), []);
  const clear = useCallback(() => setToast(null), []);
  return { toast, notify, fail, clear };
}

/** The toast at the bottom: 6 seconds for news, 9 for errors; Undo runs and dismisses it. */
export function Toast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  const kt = useKitT();
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(onDone, toast.tone === 'error' ? 9000 : 6000);
    return () => clearTimeout(id);
  }, [toast, onDone]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-(--hh-bottom-nav) z-[60] flex justify-center px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      {toast && (
        <div
          className={`pointer-events-auto flex min-h-14 max-w-xl items-center gap-4 rounded-2xl px-5 py-2 text-base font-medium text-white shadow-lg ${
            toast.tone === 'error' ? 'bg-red-700 ring-1 ring-toast-ring' : 'bg-toast ring-1 ring-toast-ring'
          }`}
        >
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                toast.undo?.();
                onDone();
              }}
              className="min-h-11 rounded-xl px-3 font-semibold text-forest-200 underline-offset-4 hover:underline"
            >
              {kt('ui.undo')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** How long a wait on Google's window lasts before `GoogleWindowWait` offers to bring it back. */
export const GOOGLE_WINDOW_HINT_MS = 4000;

/**
 * Under a button that opens Google's window (`googleAuthCode`): when the wait lasts a few seconds,
 * says the window may be behind this one (desktop browsers, installed apps) and offers to bring it
 * to the front; `onShow` calls `googleAuthCode` again, which reuses the open window. With
 * `onContinueHere` (`googleAuthCodeRedirect`) it also offers "Continue in this tab", and shows that
 * button alone while `blocked` (the browser refused the window; the page says so with
 * `googleWindowMessage(e, service, { continueHere: true })`).
 */
export function GoogleWindowWait({
  waiting,
  onShow,
  blocked = false,
  onContinueHere,
  delayMs = GOOGLE_WINDOW_HINT_MS,
}: {
  waiting: boolean;
  onShow: () => void;
  blocked?: boolean;
  onContinueHere?: () => void;
  delayMs?: number;
}) {
  const kt = useKitT();
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!waiting) return;
    const id = setTimeout(() => setLate(true), delayMs);
    return () => clearTimeout(id);
  }, [waiting, delayMs]);
  const here = onContinueHere && (
    <button type="button" className={linkClass} onClick={onContinueHere}>
      {kt('feedback.windowContinueHere')}
    </button>
  );
  if (blocked && !waiting) return here ? <p className="flex flex-wrap items-center gap-x-3 text-sm">{here}</p> : null;
  if (!waiting || !late) return null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span>{kt(onContinueHere ? 'feedback.windowWaitingHere' : 'feedback.windowWaiting')}</span>
      <button type="button" className={linkClass} onClick={onShow}>
        {kt('feedback.windowShow')}
      </button>
      {here}
    </p>
  );
}

/** How long something done keeps its Undo (DESIGN.md "Completion"): six hours, or less when the next one comes sooner. */
export const UNDO_DONE_MS = 6 * 3_600_000;

/**
 * Whether something done at `at` still offers Undo at `now`: within `windowMs` (six hours) and
 * before `until` (the next occurrence, when there is one). Undone later, it goes through the
 * item's own editor or history.
 */
export function canUndoDone(at: number | undefined, now: number, { windowMs = UNDO_DONE_MS, until }: { windowMs?: number; until?: number } = {}): boolean {
  if (at === undefined || !Number.isFinite(at)) return false;
  if (until !== undefined && now >= until) return false;
  return now - at < windowMs;
}

/** Open items first, done ones after, each group keeping its order. */
export function openFirst<T>(items: readonly T[], isDone: (item: T) => boolean): T[] {
  return [...items.filter((x) => !isDone(x)), ...items.filter(isDone)];
}

/** The outlined "Mark done" button (DESIGN.md "Completion"): forest outline, never a fill. */
export const completeButton =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-primary bg-surface px-4 py-2 font-semibold text-link transition-colors duration-150 hover:bg-tint disabled:opacity-50';

const completeButtonLg = 'min-h-14 px-5 text-lg';

/** The quiet Undo beside something done: small text, no border, a 44px target. */
export const undoDoneButton =
  'inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-3 text-sm font-medium text-muted underline-offset-4 transition-colors duration-150 hover:bg-stone-100 hover:underline dark:hover:bg-forest-700';

/** The filled forest check (or, skipped, a quiet skip mark) that says a row is done. Decorative: the row's words say it too. */
export function DoneBadge({ skipped, size = 'md' }: { skipped?: boolean; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-12 w-12' : 'h-9 w-9';
  const icon = size === 'lg' ? 26 : 20;
  return (
    <span
      aria-hidden="true"
      data-done-badge={skipped ? 'skipped' : 'done'}
      className={`inline-flex ${box} shrink-0 items-center justify-center rounded-full ${
        skipped ? 'border border-line bg-sunken text-muted' : 'bg-primary text-on-primary'
      }`}
    >
      {skipped ? <SkipForward size={icon - 4} strokeWidth={2.2} /> : <Check size={icon} strokeWidth={3} />}
    </span>
  );
}

export interface CompleteButtonProps {
  done: boolean;
  /** What is being done, for the buttons' names: "Take the garbage out". */
  name: string;
  onDone: () => void;
  /** Offered while done; leave it out once Undo has run out (`canUndoDone`). */
  onUndo?: () => void;
  /** The open button's visible word: the domain verb ("Give", "Feed", "Mark paid"); "Mark done" by default. */
  verb?: string;
  /** The open button's name; "Mark {name} done" by default. Give one with a domain verb: "Give Heartgard to Biscuit". */
  label?: string;
  /** Undo's name; "Undo done for {name}" by default ("Undo skip for {name}" when skipped). */
  undoLabel?: string;
  skipped?: boolean;
  size?: 'md' | 'lg';
  /** Under 640px only the check shows (the name still says it all): for tight rows. */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Not done: an outlined forest button with a verb ("Mark done", "Give", "Mark paid"). Done: no
 * button that looks like an action, only a small "Undo" while `onUndo` is given (or nothing). The
 * two states carry different names ("Mark Take the garbage out done" / "Undo done for Take the
 * garbage out"), never `aria-pressed`. Pair with `DoneBadge` and a "Done by You · 8:10 PM" line, or
 * use `CompletionRow`, which does.
 */
export function CompleteButton({ done, name, onDone, onUndo, verb, label, undoLabel, skipped, size = 'md', compact, disabled, className = '' }: CompleteButtonProps) {
  const kt = useKitT();
  if (done) {
    if (!onUndo) return null;
    return (
      <button
        type="button"
        data-complete={COMPLETE_UNDO}
        className={`${undoDoneButton} ${className}`}
        onClick={onUndo}
        disabled={disabled}
        aria-label={undoLabel ?? kt(skipped ? 'ui.undoSkipName' : 'ui.undoDoneName', { name })}
      >
        {kt('ui.undo')}
      </button>
    );
  }
  return (
    <button
      type="button"
      data-complete={COMPLETE_OPEN}
      className={`${completeButton} ${size === 'lg' ? completeButtonLg : ''} ${className}`}
      onClick={onDone}
      disabled={disabled}
      aria-label={label ?? kt('ui.markNameDone', { name })}
    >
      <Check size={size === 'lg' ? 22 : 18} strokeWidth={2.4} aria-hidden="true" />
      <span className={compact ? 'hidden sm:inline' : undefined}>{verb ?? kt('ui.markDone')}</span>
    </button>
  );
}

/**
 * "Done by Sam · 8:10 PM" (or "Skipped by …"); `at` is a moment or words already said. Done by the
 * signed-in member (`byMe`, or `by` being `personName`'s "You") it says "Done by you", which each
 * language words in its own case ("Hecho por ti", "Gedaan door jou").
 */
export function doneLine({ by, at, skipped, byMe }: { by?: string; at?: number | string; skipped?: boolean; byMe?: boolean }): string {
  const time = typeof at === 'number' ? clockWords(toHhmm(at)) : at;
  const me = byMe || (by !== undefined && by === kt('people.you'));
  if (skipped) {
    if (me) return time ? kt('ui.skippedByYouAt', { at: time }) : kt('ui.skippedByYou');
    if (by && time) return kt('ui.skippedByAt', { name: by, at: time });
    if (by) return kt('ui.skippedBy', { name: by });
    if (time) return kt('ui.skippedAt', { at: time });
    return kt('ui.skipped');
  }
  if (me) return time ? kt('ui.doneByYouAt', { at: time }) : kt('ui.doneByYou');
  if (by && time) return kt('ui.doneByAt', { name: by, at: time });
  if (by) return kt('ui.doneBy', { name: by });
  if (time) return kt('ui.doneAt', { at: time });
  return kt('ui.done');
}

export interface CompletionRowProps extends Omit<CompleteButtonProps, 'className'> {
  /** The thing to do, as a person reads it. `name` (the buttons' names) defaults to it when it is a string. */
  title: ReactNode;
  name: string;
  /** The line under the title while open: "Tonight by 7 PM", "Overdue by 5 days". */
  meta?: ReactNode;
  /** Late or due now: the open row's meta in the attention colour. The button stays the same. */
  attention?: boolean;
  /** Who did it, as shown ("You", "Sam"), and when (a moment, or words). */
  by?: string;
  /** Done by the signed-in member: "Done by you". */
  byMe?: boolean;
  at?: number | string;
  /** The done line in other words ("Given late 11:02 AM by Jo"); `doneLine({ by, at })` by default. */
  status?: ReactNode;
  /** Shown before the title while open (a category or event tile); the done badge takes its place once done. */
  leading?: ReactNode;
  /** Tapping the title (to edit or open it). */
  onOpen?: () => void;
  openLabel?: string;
  /** More actions while open, before the button: a quiet Skip. */
  actions?: ReactNode;
  /** Under the meta line, either state: notes, who to call. */
  children?: ReactNode;
}

/**
 * A completable item (DESIGN.md "Completion"). Open: the leading tile, the title, its meta (in
 * terracotta when `attention`), any extra actions and the outlined "Mark done". Done: the filled
 * check badge, the title muted (never struck through), "Done by You · 8:10 PM" and a small Undo.
 * Renders an `<li>`; put it in a `<ul>`, or a `CompletionList` that sorts done after open.
 */
export function CompletionRow({ title, meta, attention, by, byMe, at, status, leading, onOpen, openLabel, actions, children, ...button }: CompletionRowProps) {
  useKitT();
  const { done, skipped, size = 'md' } = button;
  const lg = size === 'lg';
  // The title keeps at least 12rem (10rem beside a small Undo); when the action would squeeze it below that (a phone, a long
  // "Mark done" in another language, extra actions like Skip) the actions take a row below, at the right.
  const heading = `${lg ? 'text-2xl sm:text-3xl tracking-tight' : 'text-lg'} leading-snug font-semibold [overflow-wrap:anywhere] ${done ? 'text-muted' : attention && lg ? 'text-attention' : 'text-ink'}`;
  const line = done ? (status ?? doneLine({ by, byMe, at, skipped })) : meta;
  const lineClass = `${lg ? 'text-lg' : 'text-base'} ${!done && attention ? 'font-semibold text-attention' : 'text-muted'}`;
  const text = (
    <>
      <span className={`block ${heading}`}>{title}</span>
      {line ? <span className={`block ${lineClass}`}>{line}</span> : null}
    </>
  );
  return (
    <li data-completion={done ? (skipped ? 'skipped' : 'done') : 'open'} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 sm:flex-nowrap sm:gap-x-4">
      {done ? <DoneBadge skipped={skipped} size={size} /> : leading}
      <div className={`min-w-0 flex-1 ${done ? 'basis-40' : 'basis-48'}`}>
        {onOpen ? (
          <button type="button" className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] flex-col justify-center rounded-xl px-2 text-left hover:bg-sunken" onClick={onOpen} aria-label={openLabel}>
            {text}
          </button>
        ) : (
          text
        )}
        {children}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {!done && actions}
        <CompleteButton {...button} />
      </div>
    </li>
  );
}

export interface CompletionListProps<T> {
  items: readonly T[];
  isDone: (item: T) => boolean;
  /** One `CompletionRow` (an `<li>`) per item. */
  children: (item: T) => ReactNode;
  /** The list's name. */
  label: string;
  /** The one line when everything is done: "All done for tonight"; "All done" by default. */
  allDone?: string;
  /** The folded line's "Show 3 done" in the domain's word ("Show 3 paid"); gets the count. */
  showDone?: (count: number) => string;
  className?: string;
}

/**
 * Completable rows with the done ones after the open ones. Once every item is done the list folds
 * to one line, the check badge and "All done for tonight", which opens the rows again (to undo).
 */
export function CompletionList<T>({ items, isDone, children, label, allDone, showDone, className = '' }: CompletionListProps<T>) {
  const kt = useKitT();
  const [open, setOpen] = useState(false);
  const every = items.length > 0 && items.every(isDone);
  const rows = (
    <ul aria-label={label} className={`divide-y divide-line ${every ? '' : className}`}>
      {openFirst(items, isDone).map(children)}
    </ul>
  );
  if (!every) return rows;
  return (
    <div data-all-done="" className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-sunken sm:gap-4"
      >
        <DoneBadge />
        <span className="min-w-0 flex-1 text-lg font-semibold text-ink">{allDone ?? kt('ui.allDone')}</span>
        <span className="text-sm text-muted">{open ? kt('ui.hideDone') : (showDone ? showDone(items.length) : kt('ui.showDone', { count: items.length }))}</span>
        <ChevronDown size={18} aria-hidden="true" className={`shrink-0 text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && rows}
    </div>
  );
}
