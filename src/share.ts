/**
 * "Share Huishouden": tell someone about the suite itself, so they start a household of their own.
 * Not an invitation into the sharer's household (that is the portal's Household panel,
 * `./invite`). What is shared is the bare site address with a one-line pitch in the page's
 * language: no tracking parameters and nothing about the sharer or their household.
 *
 * The app bar's account menu offers it in every app (`./app-bar`); `shareHuishouden` is the action
 * and `shareQrSvg` the code for someone standing next to you.
 */
import { kt } from './i18n.js';
import { qrSvg } from './qr.js';
import { SUITE_HOST, SUITE_ORIGIN } from './suite.js';

/** The address that is shared: the suite's front door, the portal, with nothing appended. */
export const SHARE_URL = `${SUITE_ORIGIN}/`;

/** The address as people read it, for under the QR code: `huishouden-piekstra.web.app`. */
export const SHARE_HOST = SUITE_HOST;

/** What the system share sheet gets: the suite's name, the pitch in the page's language, the address. */
export function shareData(): ShareData {
  return { title: 'Huishouden', text: kt('share.pitch'), url: SHARE_URL };
}

/** How sharing went: the share sheet sent it, the person closed the sheet, the link was copied, or neither worked. */
export type ShareOutcome = 'shared' | 'cancelled' | 'copied' | 'failed';

/** The browser's share and copy, swappable in tests. */
export interface ShareEnv {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  copy?: (text: string) => Promise<void>;
}

/** This browser's Web Share API and clipboard, where it has them. */
export function browserShareEnv(): ShareEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    share: typeof nav?.share === 'function' ? (data) => nav.share(data) : undefined,
    canShare: typeof nav?.canShare === 'function' ? (data) => nav.canShare(data) : undefined,
    copy: copyText,
  };
}

/** Copies `text`: the async clipboard, else a selected textarea and `execCommand('copy')` (older browsers, http pages). */
export async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) return await navigator.clipboard.writeText(text);
  } catch {
    // Refused (no permission, not focused): try the old way.
  }
  if (typeof document === 'undefined') throw new Error('no clipboard');
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand?.('copy')) throw new Error('copy refused');
  } finally {
    area.remove();
  }
}

/**
 * Shares Huishouden: the system share sheet where there is one (Android's lists Messages, WhatsApp,
 * email), else the link is copied for the caller to say so. Call it from the tap itself: browsers
 * open the share sheet only during a user gesture. Closing the sheet is `cancelled`, not a failure;
 * a sheet that cannot open falls back to copying.
 */
export async function shareHuishouden(env: ShareEnv = browserShareEnv()): Promise<ShareOutcome> {
  const data = shareData();
  if (env.share && (!env.canShare || env.canShare(data))) {
    try {
      await env.share(data);
      return 'shared';
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  return copyShareLink(env);
}

/** Copies `SHARE_URL` with `env.copy`: `failed` when there is no clipboard or it refuses. */
export async function copyShareLink(env: ShareEnv = browserShareEnv()): Promise<'copied' | 'failed'> {
  if (!env.copy) return 'failed';
  try {
    await env.copy(SHARE_URL);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** The QR code of `SHARE_URL`, named for screen readers in the page's language (`./qr`'s `qrSvg`). */
export function shareQrSvg(): string {
  return qrSvg(SHARE_URL, { ecc: 'M', label: kt('share.qrLabel', { address: SHARE_HOST }) });
}
