/**
 * React hooks over `../update`: whether a new version is ready, and holding it back while the
 * screen has something a reload would lose that the page can't see for itself (open dialogs and
 * typed text it sees: `hasUnsavedInput`).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { holdUpdates, onUpdateReady, updateReady } from '../update';

/** Whether the app bar's Update button shows. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(onUpdateReady, updateReady, () => false);
}

/** While `active`, a waiting version does not apply when the page is hidden (a recording, an upload, a timer). */
export function useHoldUpdates(active: boolean): void {
  useEffect(() => (active ? holdUpdates() : undefined), [active]);
}
