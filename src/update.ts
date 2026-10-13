/**
 * New versions without interruptions (STANDARD.md "Updates"). A deploy's service worker installs in
 * the background and waits; the page someone is using is never reloaded under them. The waiting
 * version applies:
 *
 * - **at launch**: a version already waiting when the page opens (found in an earlier session)
 *   applies before the person has touched anything, within `LAUNCH_WINDOW_MS`;
 * - **when the page is hidden** (another app, the screen off) and nothing holds it: no open dialog
 *   or sheet, no text the person typed still in a field, no `holdUpdates()`;
 * - **when the person asks**: the app bar's small Update button (`applyUpdate()`).
 *
 * Otherwise it applies on its own the next time every window of the app has closed. A reload, when
 * there is one, returns to the same screen because apps keep it in the address (`./url-state`).
 *
 * `pwaApp` builds the worker for this (`registerType: 'prompt'`: it waits, and takes over when
 * told); the app starts it once from main.tsx:
 *
 * ```ts
 * if (import.meta.env.PROD) startUpdates({ base: import.meta.env.BASE_URL });
 * ```
 */

export type ApplyReason = 'launch' | 'hidden' | 'tap';

/** How often an open page asks for a new version (a wall tablet stays open for days). */
export const UPDATE_CHECK_MS = 60 * 60 * 1000;
/** Coming back to a page asks again when the last check is older than this. */
export const RETURN_CHECK_MS = 15 * 60 * 1000;
/** A version already waiting at launch applies only this early, and only before any touch or key. */
export const LAUNCH_WINDOW_MS = 3000;
/** After asking the waiting worker to take over, how long before reloading anyway (a tap only). */
export const TAKEOVER_TIMEOUT_MS = 4000;
/** The message vite-plugin-pwa's prompt-mode worker answers with `skipWaiting()`. */
export const SKIP_WAITING = { type: 'SKIP_WAITING' } as const;

export interface UpdateSignals {
  /** A new version is installed and waiting. */
  waiting: boolean;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** The page opened less than `LAUNCH_WINDOW_MS` ago. */
  launching: boolean;
  /** The person has touched, clicked or typed since the page opened. */
  interacted: boolean;
  /** An open dialog or sheet, typed text still in a field, or a `holdUpdates()` (`hasUnsavedInput`). */
  unsaved: boolean;
}

/** The update policy: whether a waiting version may apply now, for `reason`. */
export function mayApply(reason: ApplyReason, s: UpdateSignals): boolean {
  if (!s.waiting) return false;
  if (reason === 'tap') return true;
  if (reason === 'hidden') return !s.visible && !s.unsaved;
  return s.launching && !s.interacted && !s.unsaved;
}

/**
 * Once the new worker controls the page: whether to reload, for the apply started for `reason`.
 * A tap always does. Hidden: while still hidden, or back but untouched since (a suspended page
 * that resumes before its reload). Launch: only while untouched.
 */
export function mayReload(reason: ApplyReason, { visible, interactedSinceApply }: { visible: boolean; interactedSinceApply: boolean }): boolean {
  if (reason === 'tap') return true;
  if (reason === 'hidden') return !visible || !interactedSinceApply;
  return !interactedSinceApply;
}

const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'time', 'month', 'week']);
const OPEN_DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** Whether `el` is a field the person types into and it still holds text. */
export function holdsText(el: Element): boolean {
  if (!el.isConnected) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return (el as HTMLTextAreaElement).value.trim() !== '';
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    return TEXT_INPUTS.has((input.getAttribute('type') ?? '').toLowerCase()) && input.value.trim() !== '';
  }
  return (el as HTMLElement).isContentEditable === true && (el.textContent ?? '').trim() !== '';
}

/**
 * Whether the page holds something a reload would lose: an open dialog or sheet (the kit's
 * `Dialog`, any `role="dialog"` or `<dialog open>`), a field the person typed into (`edited`) that
 * still holds text, or a hold (`holds` above 0).
 */
export function hasUnsavedInput(doc: Pick<Document, 'querySelector'>, edited: Iterable<Element> = [], holds = 0): boolean {
  if (holds > 0) return true;
  if (doc.querySelector(OPEN_DIALOGS)) return true;
  for (const el of edited) if (holdsText(el)) return true;
  return false;
}

type Listener = (ready: boolean) => void;

/** What `startUpdates` needs from the browser; tests pass fakes. */
export interface UpdateEnv {
  serviceWorker: Pick<ServiceWorkerContainer, 'register' | 'addEventListener' | 'controller'>;
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'querySelector'>;
  window: Pick<Window, 'addEventListener'>;
  reload: () => void;
  /** Milliseconds since the page opened (`performance.now()`). */
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

export interface StartUpdatesOptions {
  /** The app's path, `import.meta.env.BASE_URL` (`/pet/`; the portal's `/`): the worker is `<base>sw.js` with that scope. */
  base?: string;
  /** How often to ask for a new version; default `UPDATE_CHECK_MS`. */
  checkEveryMs?: number;
  /** Tests only. */
  env?: Partial<UpdateEnv>;
}

/** Who listens and what holds, shared by the page's updater and the module's functions (which may run before it starts). */
export interface UpdateShared {
  listeners: Set<Listener>;
  holds: { count: number };
}

/** The running page's updater (one per page); `startUpdates` returns it. */
export class Updates {
  #env: UpdateEnv;
  #shared: UpdateShared;
  #registration: ServiceWorkerRegistration | null = null;
  #ready = false;
  #applying: ApplyReason | null = null;
  #interacted = false;
  #interactedSinceApply = false;
  #edited = new Set<Element>();
  #lastCheck = 0;
  #reloaded = false;

  constructor(env: UpdateEnv, shared: UpdateShared = { listeners: new Set(), holds: { count: 0 } }) {
    this.#env = env;
    this.#shared = shared;
  }

  /** A new version is waiting, or this page runs an older one than its worker: the Update button shows. */
  get ready(): boolean {
    return this.#ready;
  }

  /** The policy's inputs right now. */
  signals(): UpdateSignals {
    return {
      waiting: !!this.#registration?.waiting,
      visible: this.#env.document.visibilityState === 'visible',
      launching: this.#env.now() < LAUNCH_WINDOW_MS,
      interacted: this.#interacted,
      unsaved: hasUnsavedInput(this.#env.document, this.#edited, this.#shared.holds.count),
    };
  }

  onReady(listener: Listener): () => void {
    this.#shared.listeners.add(listener);
    return () => {
      this.#shared.listeners.delete(listener);
    };
  }

  /** Something a reload would lose that the page can't see (an upload, a timer); call the result to let go. */
  hold(): () => void {
    return takeHold(this.#shared.holds);
  }

  /** The person asked (the Update button): the waiting version takes over and the page reloads. */
  apply(): void {
    if (this.#registration?.waiting) {
      this.#apply('tap');
      // A worker that never takes over (an old one without the message handler) still gets the tap.
      this.#env.setTimeout(() => this.#reload(), TAKEOVER_TIMEOUT_MS);
    } else this.#reload();
  }

  /** The server has moved on (a chunk this page needs is gone): show the button and look for the version. */
  offer(): void {
    this.#setReady(true);
    this.check();
  }

  /** Asks the server for a new version now. */
  check(): void {
    this.#lastCheck = this.#env.now();
    void this.#registration?.update().catch(() => {});
  }

  /** Wires the page; resolves once the worker is registered. */
  async start(base: string, checkEveryMs: number): Promise<void> {
    const { document: doc, window: win, serviceWorker: sw } = this.#env;
    const touched = () => {
      this.#interacted = true;
      this.#interactedSinceApply = true;
    };
    for (const type of ['pointerdown', 'keydown']) win.addEventListener(type, touched, { capture: true, passive: true });
    win.addEventListener(
      'input',
      (e) => {
        touched();
        const target = e.target as Element | null;
        if (target && typeof target.tagName === 'string') this.#edited.add(target);
        for (const el of this.#edited) if (!el.isConnected) this.#edited.delete(el);
      },
      { capture: true, passive: true },
    );
    // A lazily loaded file failed (Vite's preload helper): the deploy it belonged to is gone. The app
    // still sees the error; the button offers the version that has the file.
    win.addEventListener('vite:preloadError', () => this.offer());
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') this.#consider('hidden');
      else if (this.#env.now() - this.#lastCheck > RETURN_CHECK_MS) this.check();
    });
    const hadController = !!sw.controller;
    sw.addEventListener('controllerchange', () => this.#onControllerChange(hadController));
    let registration: ServiceWorkerRegistration;
    try {
      registration = await sw.register(`${base}sw.js`, { scope: base });
    } catch {
      return; // no worker (private mode, an old browser): the page works without updates in place
    }
    this.#registration = registration;
    this.#lastCheck = this.#env.now();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        // Installed with a worker already in control: an update, now waiting. (The first install has none and simply activates.)
        if (installing.state === 'installed' && sw.controller) this.#onWaiting();
      });
    });
    if (registration.waiting && sw.controller) {
      this.#setReady(true);
      this.#consider('launch');
      if (doc.visibilityState === 'hidden') this.#consider('hidden');
    }
    this.#env.setInterval(() => this.check(), checkEveryMs);
  }

  #onWaiting() {
    this.#setReady(true);
    if (this.#env.document.visibilityState === 'hidden') this.#consider('hidden');
  }

  #consider(reason: ApplyReason) {
    if (this.#applying) return;
    if (mayApply(reason, this.signals())) this.#apply(reason);
  }

  #apply(reason: ApplyReason) {
    const waiting = this.#registration?.waiting;
    if (!waiting) return;
    this.#applying = reason;
    this.#interactedSinceApply = false;
    waiting.postMessage(SKIP_WAITING);
  }

  #onControllerChange(hadController: boolean) {
    const reason = this.#applying;
    if (reason) {
      this.#applying = null;
      const visible = this.#env.document.visibilityState === 'visible';
      if (mayReload(reason, { visible, interactedSinceApply: this.#interactedSinceApply })) return this.#reload();
      // Touched in the moment between: stay, and let the button or the next hide finish it.
      this.#setReady(true);
      return;
    }
    // Another window of the app applied it, or the first install claimed this page.
    if (hadController) this.#setReady(true);
  }

  #reload() {
    if (this.#reloaded) return;
    this.#reloaded = true;
    this.#env.reload();
  }

  #setReady(ready: boolean) {
    if (this.#ready === ready) return;
    this.#ready = ready;
    for (const listener of [...this.#shared.listeners]) listener(ready);
  }
}

function takeHold(holds: { count: number }): () => void {
  holds.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds.count--;
  };
}

let current: Updates | null = null;
// Shared with the updater once it starts, so a listener or hold taken before then still counts and lets go.
const shared: UpdateShared = { listeners: new Set(), holds: { count: 0 } };
let earlyOffer = false;

/** Starts the page's updater (once; later calls return the first). No-op where there are no service workers. */
export function startUpdates({ base = '/', checkEveryMs = UPDATE_CHECK_MS, env = {} }: StartUpdatesOptions = {}): Updates | null {
  if (current) return current;
  const serviceWorker = env.serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
  if (!serviceWorker) return null;
  const updates = new Updates({
    serviceWorker,
    document: env.document ?? document,
    window: env.window ?? window,
    reload: env.reload ?? (() => location.reload()),
    now: env.now ?? (() => performance.now()),
    setInterval: env.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
    setTimeout: env.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
  }, shared);
  current = updates;
  if (earlyOffer) updates.offer();
  void updates.start(base.endsWith('/') ? base : `${base}/`, checkEveryMs);
  return updates;
}

/** Whether the Update button should show. */
export function updateReady(): boolean {
  return current?.ready ?? false;
}

/** Calls `listener` when an update becomes ready (or stops being); returns the unsubscribe. */
export function onUpdateReady(listener: Listener): () => void {
  shared.listeners.add(listener);
  return () => {
    shared.listeners.delete(listener);
  };
}

/** The Update button: the waiting version takes over and the page reloads, now. */
export function applyUpdate(): void {
  if (current) current.apply();
  else if (typeof location !== 'undefined') location.reload();
}

/** Keeps a waiting version from applying while the page is hidden, until the returned function is called (before or after `startUpdates`). */
export function holdUpdates(): () => void {
  return takeHold(shared.holds);
}

/** A file this page needs is gone from the server: show the Update button (see `retryImport`). */
export function offerUpdate(): void {
  if (current) current.offer();
  else earlyOffer = true;
}

/**
 * A lazily loaded module, tried twice: a failure that persists (a deploy removed the file this page
 * names) offers the update rather than leaving the page broken or navigating away. The error is
 * thrown for the caller to show.
 */
export async function retryImport<T>(load: () => Promise<T>, waitMs = 1000): Promise<T> {
  try {
    return await load();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      return await load();
    } catch (error) {
      offerUpdate();
      throw error;
    }
  }
}

/** @internal Tests: forget the page's updater. */
export function resetUpdatesForTests(): void {
  current = null;
  shared.listeners.clear();
  shared.holds.count = 0;
  earlyOffer = false;
}
