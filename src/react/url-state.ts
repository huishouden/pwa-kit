/**
 * React hooks over `../url-state`: the screen lives in the address, so a reload and Back and Forward
 * restore it (STANDARD.md "Updates").
 *
 * ```tsx
 * const [tab, setTab] = useUrlTab(['today', 'care', 'pets'] as const, 'today');
 * const [petId, setPetId] = useUrlParam('pet');
 * ```
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { onUrlChange, setUrlParams, tabFromUrl, urlParam } from '../url-state';

const href = () => location.href;
const serverHref = () => 'http://localhost/';

/** The current address, re-rendering when it changes. */
export function useUrl(): string {
  return useSyncExternalStore(onUrlChange, href, serverHref);
}

/**
 * A query parameter and its setter. Setting it pushes a history entry, so Back returns; pass
 * `{ replace: true }` for refinements that should not (a filter, a highlighted row).
 */
export function useUrlParam(name: string): [string | null, (value: string | null, options?: { replace?: boolean; also?: Record<string, string | null> }) => void] {
  const value = urlParam(name, useUrl());
  const set = useCallback(
    (next: string | null, { replace = false, also = {} }: { replace?: boolean; also?: Record<string, string | null> } = {}) => setUrlParams({ ...also, [name]: next }, { replace }),
    [name],
  );
  return [value, set];
}

export interface UrlTabOptions {
  /** The query parameter; default `tab`. */
  param?: string;
  /** Also read `#<id>` (an app that kept its tab in the fragment): moved into the query on first render. */
  legacyHash?: boolean;
}

/**
 * The app's tab, in `?tab=`: `fallback` (the first screen) leaves the parameter out. Choosing a tab
 * pushes a history entry; `also` changes other parameters in the same entry (`{ pet: null }` to
 * leave the previous tab's item behind).
 */
export function useUrlTab<T extends string>(ids: readonly T[], fallback: T, { param = 'tab', legacyHash = false }: UrlTabOptions = {}): [T, (id: T, options?: { replace?: boolean; also?: Record<string, string | null> }) => void] {
  const url = useUrl();
  const tab = tabFromUrl(url, ids, fallback, { param, legacyHash });
  useEffect(() => {
    if (!legacyHash || !location.hash) return;
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!(ids as readonly string[]).includes(hash)) return;
    // An old #tab link: the same screen, with the tab where the rest of the suite keeps it.
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    setUrlParams({ [param]: hash === fallback ? null : hash }, { replace: true });
  }, [legacyHash, ids, fallback, param]);
  const choose = useCallback(
    (id: T, { replace = false, also = {} }: { replace?: boolean; also?: Record<string, string | null> } = {}) =>
      setUrlParams({ ...also, [param]: id === fallback ? null : id }, { replace }),
    [param, fallback],
  );
  return [tab, choose];
}
