import { GlobalRegistrator } from './dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  LAUNCH_WINDOW_MS,
  RETURN_CHECK_MS,
  SKIP_WAITING,
  TAKEOVER_TIMEOUT_MS,
  UPDATE_CHECK_MS,
  hasUnsavedInput,
  mayApply,
  mayReload,
  offerUpdate,
  onUpdateReady,
  resetUpdatesForTests,
  retryImport,
  startUpdates,
  updateReady,
  type UpdateSignals,
} from '../src/update';

beforeAll(() => {
  if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://suite.example.com/pet/' });
});
afterAll(() => GlobalRegistrator.unregister());

const idle: UpdateSignals = { waiting: true, visible: true, launching: false, interacted: false, unsaved: false };

describe('the update policy', () => {
  test('nothing applies without a waiting version', () => {
    for (const reason of ['launch', 'hidden', 'tap'] as const) expect(mayApply(reason, { ...idle, waiting: false, visible: false, launching: true })).toBe(false);
  });

  test('never while the page is visible and in use: only the person’s tap', () => {
    expect(mayApply('hidden', { ...idle, visible: true })).toBe(false);
    expect(mayApply('launch', { ...idle, launching: true, interacted: true })).toBe(false);
    expect(mayApply('launch', { ...idle, launching: false })).toBe(false);
    expect(mayApply('tap', { ...idle, interacted: true, unsaved: true })).toBe(true);
  });

  test('hidden: applies with nothing unsaved, holds with something', () => {
    expect(mayApply('hidden', { ...idle, visible: false })).toBe(true);
    expect(mayApply('hidden', { ...idle, visible: false, unsaved: true })).toBe(false);
  });

  test('launch: applies before the first touch, inside the launch window', () => {
    expect(mayApply('launch', { ...idle, launching: true })).toBe(true);
  });

  test('after the takeover: a launch or hidden apply reloads only if nobody touched the page since', () => {
    expect(mayReload('tap', { visible: true, interactedSinceApply: true })).toBe(true);
    expect(mayReload('hidden', { visible: false, interactedSinceApply: true })).toBe(true);
    expect(mayReload('hidden', { visible: true, interactedSinceApply: false })).toBe(true);
    expect(mayReload('hidden', { visible: true, interactedSinceApply: true })).toBe(false);
    expect(mayReload('launch', { visible: true, interactedSinceApply: false })).toBe(true);
    expect(mayReload('launch', { visible: true, interactedSinceApply: true })).toBe(false);
  });
});

describe('hasUnsavedInput', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('an open dialog or sheet holds', () => {
    expect(hasUnsavedInput(document)).toBe(false);
    document.body.innerHTML = '<div role="dialog" aria-modal="true">Edit</div>';
    expect(hasUnsavedInput(document)).toBe(true);
  });

  test('typed text holds until the field is emptied or gone', () => {
    document.body.innerHTML = '<input id="a"><input id="b" type="checkbox"><textarea id="c"></textarea>';
    const a = document.getElementById('a') as HTMLInputElement;
    const b = document.getElementById('b') as HTMLInputElement;
    const c = document.getElementById('c') as HTMLTextAreaElement;
    expect(hasUnsavedInput(document, [a, b, c])).toBe(false);
    a.value = 'Milk';
    expect(hasUnsavedInput(document, [a])).toBe(true);
    a.value = '  ';
    expect(hasUnsavedInput(document, [a])).toBe(false);
    b.checked = true;
    expect(hasUnsavedInput(document, [b]), 'a checkbox is not typed text').toBe(false);
    c.value = 'Note';
    expect(hasUnsavedInput(document, [c])).toBe(true);
    c.remove();
    expect(hasUnsavedInput(document, [c])).toBe(false);
  });

  test('a hold holds', () => {
    expect(hasUnsavedInput(document, [], 1)).toBe(true);
  });
});

// ---- The updater against a fake service worker container ----

type Fn = (e?: unknown) => void;
class Emitter {
  listeners = new Map<string, Fn[]>();
  addEventListener(type: string, fn: Fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, e?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

class FakeWorker extends Emitter {
  state = 'installing';
  messages: unknown[] = [];
  postMessage(m: unknown) {
    this.messages.push(m);
  }
}

class FakeRegistration extends Emitter {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updates = 0;
  async update() {
    this.updates++;
  }
}

class FakeContainer extends Emitter {
  controller: object | null = {};
  registration = new FakeRegistration();
  registered: [string, unknown][] = [];
  async register(url: string, options: unknown) {
    this.registered.push([url, options]);
    return this.registration;
  }
}

function harness({ waitingAtLaunch = false, controlled = true } = {}) {
  const sw = new FakeContainer();
  if (!controlled) sw.controller = null;
  if (waitingAtLaunch) sw.registration.waiting = new FakeWorker();
  const doc = Object.assign(new Emitter(), { visibilityState: 'visible' as DocumentVisibilityState, querySelector: (s: string) => document.querySelector(s) });
  const win = new Emitter();
  let now = 100;
  let reloads = 0;
  const intervals: [Fn, number][] = [];
  const timeouts: [Fn, number][] = [];
  const updates = startUpdates({
    base: '/pet/',
    env: {
      serviceWorker: sw as unknown as ServiceWorkerContainer,
      document: doc as unknown as Document,
      window: win as unknown as Window,
      reload: () => reloads++,
      now: () => now,
      setInterval: (fn, ms) => intervals.push([fn, ms]),
      setTimeout: (fn, ms) => timeouts.push([fn, ms]),
    },
  })!;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** A deploy: the browser finds a new worker, which installs and waits. */
  const deploy = () => {
    const w = new FakeWorker();
    sw.registration.installing = w;
    sw.registration.emit('updatefound');
    w.state = 'installed';
    sw.registration.installing = null;
    sw.registration.waiting = w;
    w.emit('statechange');
    return w;
  };
  const hide = () => {
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
  };
  const show = () => {
    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');
  };
  /** The waiting worker took over (after SKIP_WAITING). */
  const takeover = () => {
    sw.registration.waiting = null;
    sw.emit('controllerchange');
  };
  const touch = () => win.emit('pointerdown', { target: document.body });
  return {
    sw, doc, win, updates, settle, deploy, hide, show, takeover, touch, intervals, timeouts,
    get reloads() { return reloads; },
    setNow: (ms: number) => (now = ms),
  };
}

describe('startUpdates', () => {
  beforeEach(() => resetUpdatesForTests());
  afterEach(() => {
    resetUpdatesForTests();
    document.body.innerHTML = '';
  });

  test('registers <base>sw.js with the app’s scope and checks hourly', async () => {
    const h = harness();
    await h.settle();
    expect(h.sw.registered).toEqual([['/pet/sw.js', { scope: '/pet/' }]]);
    expect(h.intervals.map(([, ms]) => ms)).toEqual([UPDATE_CHECK_MS]);
    h.intervals[0][0]();
    expect(h.sw.registration.updates).toBe(1);
  });

  test('no reload while the page is visible: a new version waits and the Update button shows', async () => {
    const h = harness();
    await h.settle();
    const seen: boolean[] = [];
    onUpdateReady((r) => seen.push(r));
    const w = h.deploy();
    expect(updateReady()).toBe(true);
    expect(seen).toEqual([true]);
    expect(w.messages).toEqual([]);
    expect(h.reloads).toBe(0);
  });

  test('applies when the page is hidden with no unsaved input, and reloads once the new worker is in control', async () => {
    const h = harness();
    await h.settle();
    const w = h.deploy();
    h.hide();
    expect(w.messages).toEqual([SKIP_WAITING]);
    h.takeover();
    expect(h.reloads).toBe(1);
  });

  test('a version found while hidden applies at once', async () => {
    const h = harness();
    await h.settle();
    h.hide();
    const w = h.deploy();
    expect(w.messages).toEqual([SKIP_WAITING]);
  });

  test('hidden with typed text or an open sheet: nothing applies, until it is saved and the page hides again', async () => {
    const h = harness();
    await h.settle();
    document.body.innerHTML = '<input id="item">';
    const input = document.getElementById('item') as HTMLInputElement;
    input.value = 'Bread';
    h.win.emit('input', { target: input });
    const w = h.deploy();
    h.hide();
    expect(w.messages).toEqual([]);
    h.show();
    document.body.innerHTML = '<div role="dialog">Sheet</div>';
    h.hide();
    expect(w.messages, 'an open sheet holds too').toEqual([]);
    h.show();
    document.body.innerHTML = '';
    h.hide();
    expect(w.messages).toEqual([SKIP_WAITING]);
  });

  test('holdUpdates keeps it back until released', async () => {
    const h = harness();
    await h.settle();
    const release = h.updates.hold();
    const w = h.deploy();
    h.hide();
    expect(w.messages).toEqual([]);
    h.show();
    release();
    h.hide();
    expect(w.messages).toEqual([SKIP_WAITING]);
  });

  test('applies at the next launch: a version already waiting applies before the first touch', async () => {
    const h = harness({ waitingAtLaunch: true });
    const w = h.sw.registration.waiting!;
    await h.settle();
    expect(w.messages).toEqual([SKIP_WAITING]);
    h.takeover();
    expect(h.reloads).toBe(1);
  });

  test('launch: not once the person has touched the page, nor after the launch window', async () => {
    const touched = harness({ waitingAtLaunch: true });
    touched.touch();
    await touched.settle();
    expect(touched.sw.registration.waiting!.messages).toEqual([]);
    resetUpdatesForTests();
    const late = harness({ waitingAtLaunch: true });
    late.setNow(LAUNCH_WINDOW_MS + 1);
    await late.settle();
    expect(late.sw.registration.waiting!.messages).toEqual([]);
    expect(updateReady()).toBe(true);
  });

  test('a touch between the takeover request and the takeover cancels the reload; the button stays', async () => {
    const h = harness({ waitingAtLaunch: true });
    await h.settle();
    h.touch();
    h.takeover();
    expect(h.reloads).toBe(0);
    expect(updateReady()).toBe(true);
  });

  test('a page suspended when hidden reloads on return if untouched', async () => {
    const h = harness();
    await h.settle();
    h.deploy();
    h.hide();
    h.show();
    h.takeover();
    expect(h.reloads).toBe(1);
  });

  test('the tap applies whatever the page holds, with a fallback reload', async () => {
    const h = harness();
    await h.settle();
    document.body.innerHTML = '<div role="dialog">Sheet</div>';
    h.touch();
    const w = h.deploy();
    h.updates.apply();
    expect(w.messages).toEqual([SKIP_WAITING]);
    expect(h.timeouts.map(([, ms]) => ms)).toEqual([TAKEOVER_TIMEOUT_MS]);
    h.takeover();
    expect(h.reloads).toBe(1);
    h.timeouts[0][0]();
    expect(h.reloads, 'once').toBe(1);
  });

  test('another window applied it: no reload here, the button offers it', async () => {
    const h = harness();
    await h.settle();
    h.sw.emit('controllerchange');
    expect(h.reloads).toBe(0);
    expect(updateReady()).toBe(true);
  });

  test('the first install claims the page without a reload or a button', async () => {
    const h = harness({ controlled: false });
    await h.settle();
    h.sw.emit('controllerchange');
    expect(h.reloads).toBe(0);
    expect(updateReady()).toBe(false);
  });

  test('a lazily loaded file that failed offers the update and looks for it', async () => {
    const h = harness();
    await h.settle();
    h.win.emit('vite:preloadError');
    expect(updateReady()).toBe(true);
    expect(h.sw.registration.updates).toBe(1);
    expect(h.reloads).toBe(0);
  });

  test('coming back after a while checks for a new version', async () => {
    const h = harness();
    await h.settle();
    h.hide();
    h.show();
    expect(h.sw.registration.updates).toBe(0);
    h.setNow(RETURN_CHECK_MS + 1000);
    h.hide();
    h.show();
    expect(h.sw.registration.updates).toBe(1);
  });
});

describe('retryImport', () => {
  beforeEach(() => resetUpdatesForTests());

  test('a second try that works hides the first failure', async () => {
    let calls = 0;
    const mod = await retryImport(async () => {
      if (calls++ === 0) throw new Error('Failed to fetch dynamically imported module');
      return { default: 1 };
    }, 0);
    expect(mod).toEqual({ default: 1 });
    expect(updateReady()).toBe(false);
  });

  test('two failures offer the update instead of navigating away, and rethrow', async () => {
    const offered: boolean[] = [];
    // No updater yet: the offer waits for startUpdates.
    await expect(retryImport(async () => Promise.reject(new Error('gone')), 0)).rejects.toThrow('gone');
    const h = harness();
    onUpdateReady((r) => offered.push(r));
    expect(updateReady()).toBe(true);
    await h.settle();
    offerUpdate();
    expect(offered).toEqual([]);
  });
});
