// A DOM for element tests. Call useDom() at the top of a file, before importing the modules under
// test, so what they set up at import (custom elements, React DOM's browser check) sees it. A
// module is evaluated once for the whole run, though, so a file whose module may already have been
// imported under another file's DOM, or none, loads a copy of its own (see app-bar.test.ts).
import { afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * Registers a DOM at `url` for this file's tests and removes it after them, so later test files see
 * none. The page is emptied first: an element still connected when the window goes would run its
 * disconnectedCallback with `window` already gone.
 */
export function useDom(url: string): void {
  if (typeof document !== 'undefined') return;
  GlobalRegistrator.register({ url });
  afterAll(async () => {
    document.body.replaceChildren();
    await GlobalRegistrator.unregister();
  });
}
