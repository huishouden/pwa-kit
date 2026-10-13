/**
 * The Huishouden page frame for React apps (DESIGN.md "Frame"): the app bar with the app's tabs over
 * the page's main column, and the same frame while the app opens.
 *
 * `AppFrame` is the loaded app's frame. `AppOpening` is that frame over `ScreenSkeleton`, shown from
 * the first paint until the session is restored, the household found and the first data arrived.
 * Give both the same props (spread one object into each) and nothing moves between the phases or
 * into the loaded app: the app bar, the tabs and the main column are one component's.
 *
 * ```tsx
 * const frame = { app: t('app.name'), glyph: 'paw', portalUrl: '/', version, user, signingIn, onSignIn, onSignOut,
 *   tabs: tabs(t), tab, onTab: setTab, layout: 'fit' } as const;
 * if (loading) return <AppOpening {...frame} phase="household" />;
 * return <AppFrame {...frame} onSettings={openSettings}>…</AppFrame>;
 * ```
 */
import { useEffect, type ReactNode } from 'react';
import { AppBar, type AppBarProps } from './app-bar';
import { ScreenSkeleton, SectionTabs, type Tab } from './ui';
import { useKitT } from './i18n';
import { trackView } from '../observability';

/**
 * How the page under the app bar is laid out.
 * - `page`: the 1200px column, padded (24px, 16px on phones); the page scrolls.
 * - `fit`: `page`, and from 1024px the frame is the screen's height and nothing scrolls the page:
 *   the app's panes scroll on their own (a tablet's dashboard).
 * - `list`: `<main>` fills the rest of the screen and scrolls itself; the app centres its own
 *   column inside (`listColumn`). Tasks and Groceries.
 */
export type FrameLayout = 'page' | 'fit' | 'list';

const OUTER: Record<FrameLayout, string> = {
  page: 'flex min-h-dvh flex-col bg-page font-sans text-ink antialiased',
  fit: 'flex min-h-dvh flex-col bg-page font-sans text-ink antialiased lg:h-dvh lg:overflow-hidden',
  list: 'flex h-full flex-col',
};

const MAIN: Record<FrameLayout, string> = {
  page: 'mx-auto flex w-full max-w-[1200px] min-h-0 flex-1 flex-col gap-4 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 sm:pb-6',
  fit: 'mx-auto flex w-full max-w-[1200px] min-h-0 flex-1 flex-col gap-4 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 sm:pb-6',
  list: 'min-h-0 flex-1 overflow-y-auto',
};

/** The centred column a `list` app puts its screen in, inside `<main>`; the opening placeholder sits in it too. */
export const listColumn = 'mx-auto w-full max-w-3xl p-3 sm:p-4';

export interface AppFrameProps extends Omit<AppBarProps, 'children' | 'className'> {
  /** The app's sections (`SectionTabs`): in the app bar from 640px, a bottom bar on phones. None: no tabs. */
  tabs?: Tab[];
  /** The section shown; `''` for none (a page outside the tabs). */
  tab?: string;
  onTab?: (id: string) => void;
  /** More of the app bar: each child names its slot (`<span slot="actions">`). */
  bar?: ReactNode;
  layout?: FrameLayout;
  /** Added to the frame's outer element (`print:bg-white`). */
  className?: string;
  /** Added to `<main>` (`pb-20` under a floating Undo). */
  mainClassName?: string;
  /**
   * The view counted for usage (`trackView`, anonymous, per visit): the tab by default. `null` when
   * the app counts its own views. Nothing is counted while the frame is opening.
   */
  view?: string | null;
  /** After `<main>`, inside the frame: a footer. */
  after?: ReactNode;
  /** The frame while the app opens: no view is counted. `AppOpening` sets it. */
  opening?: boolean;
  children?: ReactNode;
}

/** The app bar, the app's tabs and the main column (DESIGN.md "Frame"). */
export function AppFrame({ tabs, tab = '', onTab, bar, layout = 'page', className, mainClassName, view, after, opening, children, ...appBar }: AppFrameProps) {
  const counted = opening ? null : view === undefined ? tab : view;
  useEffect(() => {
    if (counted) trackView(counted);
  }, [counted]);
  return (
    <div className={className ? `${OUTER[layout]} ${className}` : OUTER[layout]} data-hh-frame={opening ? 'opening' : ''}>
      <AppBar {...appBar}>
        {tabs && tabs.length > 0 && <SectionTabs tabs={tabs} tab={tab} onTab={onTab ?? noop} />}
        {bar}
      </AppBar>
      <main className={mainClassName ? `${MAIN[layout]} ${mainClassName}` : MAIN[layout]}>{children}</main>
      {after}
    </div>
  );
}

const noop = () => {};

/**
 * What is being waited for: the session restoring (Firebase Auth), the household being found, the
 * app's first data arriving.
 */
export type OpeningPhase = 'session' | 'household' | 'data';

export interface AppOpeningProps extends Omit<AppFrameProps, 'children' | 'opening' | 'view' | 'onSettings' | 'settingsLabel'> {
  phase: OpeningPhase;
  /** The status sentence for screen readers, in place of the phase's own ("Loading the pets."). */
  label?: string;
  /** Placeholder rows (`ScreenSkeleton`). */
  rows?: number;
}

/**
 * The app while it opens (DESIGN.md "Empty and loading states"): its own frame and the tabs known
 * before sign-in (none when they depend on the household, as Baby's do), over `ScreenSkeleton`.
 * Never a sign-in screen, an empty state or a half-drawn app that is then replaced. Counts no view.
 * Screen readers hear "Loading…" and the phase: "Opening Pet.", "Finding your household.",
 * "Getting Pet ready.".
 */
export function AppOpening({ phase, label, rows, layout = 'page', ...props }: AppOpeningProps) {
  const kt = useKitT();
  // The same props object as the loaded frame's may carry its settings: they open in the loaded app.
  const { onSettings: _settings, settingsLabel: _label, ...frame } = props as AppOpeningProps & Pick<AppFrameProps, 'onSettings' | 'settingsLabel'>;
  const sentence = label ?? kt(PHASE_KEY[phase], { app: frame.app });
  const skeleton = <ScreenSkeleton label={sentence} rows={rows} />;
  return (
    <AppFrame {...frame} layout={layout} opening>
      {layout === 'list' ? <div className={listColumn}>{skeleton}</div> : skeleton}
    </AppFrame>
  );
}

const PHASE_KEY = {
  session: 'ui.opening.session',
  household: 'ui.opening.household',
  data: 'ui.opening.data',
} as const satisfies Record<OpeningPhase, string>;
