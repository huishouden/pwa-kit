/**
 * Where the person is, in the address (STANDARD.md "Updates"): the app's tab and, where it is cheap,
 * the item it shows live in the query (`?tab=care&pet=p1`), so a reload, a shared link and Back and
 * Forward all return to the same screen. Changing a tab pushes a history entry; refining what a
 * screen shows (`replace`) does not.
 */

/** Dispatched on `window` after `setUrlParams` changes the address (popstate covers Back and Forward). */
export const URL_CHANGE_EVENT = 'hh-urlchange';

/** A query parameter of the current address, or null. */
export function urlParam(name: string, href: string = location.href): string | null {
  return new URL(href).searchParams.get(name);
}

/**
 * The address with `changes` applied: a string sets the parameter, null removes it; the rest of the
 * query, the path and the fragment stay.
 */
export function withParams(href: string, changes: Record<string, string | null | undefined>): string {
  const url = new URL(href);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  return url.href;
}

/** Writes `changes` into the address: a new history entry, or with `replace` the current one. Nothing when nothing changes. */
export function setUrlParams(changes: Record<string, string | null | undefined>, { replace = false }: { replace?: boolean } = {}): void {
  const next = withParams(location.href, changes);
  if (next === location.href) return;
  if (replace) history.replaceState(history.state, '', next);
  else history.pushState(history.state, '', next);
  dispatchEvent(new Event(URL_CHANGE_EVENT));
}

/** Calls `listener` whenever the address changes (Back, Forward, `setUrlParams`, a fragment link); returns the unsubscribe. */
export function onUrlChange(listener: () => void): () => void {
  for (const type of ['popstate', 'hashchange', URL_CHANGE_EVENT]) addEventListener(type, listener);
  return () => {
    for (const type of ['popstate', 'hashchange', URL_CHANGE_EVENT]) removeEventListener(type, listener);
  };
}

/**
 * The tab an address names: `?<param>=` when it is one of `ids`, else (for apps that once kept the tab
 * in the fragment) `#<id>` when `legacyHash`, else `fallback`.
 */
export function tabFromUrl<T extends string>(href: string, ids: readonly T[], fallback: T, { param = 'tab', legacyHash = false }: { param?: string; legacyHash?: boolean } = {}): T {
  const url = new URL(href);
  const named = url.searchParams.get(param);
  if (named && (ids as readonly string[]).includes(named)) return named as T;
  const hash = decodeURIComponent(url.hash.slice(1));
  if (legacyHash && (ids as readonly string[]).includes(hash)) return hash as T;
  return fallback;
}
