import { collection, doc, getDoc, onSnapshot, type Firestore, type Unsubscribe } from 'firebase/firestore';
import { arrayRemove, arrayUnion, deleteDoc, setDoc, updateDoc } from './firestore.js';
import { getLang, isLang, kt, onLangChange, type Lang } from './i18n.js';

/**
 * Push notifications for reminders, with the browser's own Web Push (VAPID; no Firebase Cloud
 * Messaging). `enablePush` asks permission, subscribes through the app's service worker and
 * stores the subscription in `households/{id}/pushSubscriptions/{id}`; the shared sender
 * (huishouden/notify) reads them with a service account and delivers due reminders. Members can
 * only see and delete their own subscriptions.
 *
 * One subscription per device for the whole suite: every app shares the origin, so the portal's
 * service worker (scope `/`) owns the push subscription and its stored document says `app: "suite"`.
 * The sender sends a reminder from any app to it once, and a tap opens the right app's path.
 * `enablePush` also moves this device off older per-app subscriptions (`app` is an app's name):
 * it deletes the member's documents for them, so the device never gets a reminder twice, and
 * `upgradePush` does the same without a prompt on a device that already allowed notifications.
 * Until a device upgrades, its per-app subscription keeps receiving.
 *
 * The service worker side comes from `pwaApp({ push: true })`, which the portal must set. The VAPID public key is public:
 * apps get it from the `VITE_VAPID_PUBLIC_KEY` repo variable.
 *
 * iPhone and iPad: push works only in an app added to the Home Screen, on iOS/iPadOS 16.4 or
 * later; `pushSupport()` says so, so the app can explain instead of showing a dead button.
 *
 * Each subscription carries the device's language (`lang`, ./i18n), so the sender shows a
 * reminder's `texts` in it (./reminders). `enablePush` writes it; `syncPushLang` (or
 * `watchPushLang`, running for as long as the app is open) rewrites it when the language changes.
 *
 * Fields match the rules exactly (see PUSH_SUBSCRIPTION_FIELDS); keep them in step.
 */
export interface PushSubscriptionDoc {
  email: string;
  /** `"suite"` for the portal's worker (all apps), else the short name of the app whose worker holds an older per-app subscription. */
  app: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ua?: string;
  /**
   * Suite subscriptions only: the apps this device gets, when the person's choice on it was narrower
   * than every app (a per-app subscription moved to the suite one keeps its apps). Absent: every app.
   */
  apps?: string[];
  /** The device's language (`en`, `es`, `nl`): which of a reminder's `texts` it is sent. */
  lang?: Lang;
  createdAt: number;
}

export const PUSH_SUBSCRIPTION_FIELDS = ['email', 'app', 'endpoint', 'keys', 'ua', 'apps', 'lang', 'createdAt'] as const;

export type PushUnsupportedReason =
  /** iPhone/iPad in a browser tab: add the app to the Home Screen first. */
  | 'ios-not-installed'
  /** iPhone/iPad older than 16.4. */
  | 'ios-too-old'
  /** No service worker, PushManager or Notification API (old browser, private mode, http). */
  | 'unsupported-browser'
  /** The person blocked notifications for this site; only they can undo it, in site settings. */
  | 'denied';

export type PushSupport = { supported: true } | { supported: false; reason: PushUnsupportedReason; message: string };

const MESSAGE_KEYS = {
  'ios-not-installed': 'push.iosNotInstalled',
  'ios-too-old': 'push.iosTooOld',
  'unsupported-browser': 'push.unsupported',
  denied: 'push.denied',
} as const satisfies Record<PushUnsupportedReason, string>;

/** The sentence to show for a reason, in the active language. */
export function pushMessage(reason: PushUnsupportedReason): string {
  return kt(MESSAGE_KEYS[reason]);
}

interface Env {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  permission: NotificationPermission | 'unavailable';
}

function currentEnv(): Env {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const win = typeof window !== 'undefined' ? window : undefined;
  return {
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone: Boolean(
      (nav as { standalone?: boolean } | undefined)?.standalone || win?.matchMedia?.('(display-mode: standalone)').matches,
    ),
    hasServiceWorker: Boolean(nav && 'serviceWorker' in nav),
    hasPushManager: Boolean(win && 'PushManager' in win),
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'unavailable',
  };
}

/** iOS/iPadOS version from the user agent, or null if not iOS. iPadOS reports itself as a Mac with touch. */
export function iosVersion(userAgent: string, maxTouchPoints = 0): number | null {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  if (!ios) return null;
  const m = userAgent.match(/OS (\d+)[_.](\d+)/) ?? userAgent.match(/Version\/(\d+)\.(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) / 100 : 0;
}

/** Whether this device can get reminders as notifications, and if not, why (with a sentence to show). */
export function pushSupport(env: Env = currentEnv()): PushSupport {
  const no = (reason: PushUnsupportedReason): PushSupport => ({ supported: false, reason, message: pushMessage(reason) });
  const ios = iosVersion(env.userAgent, env.maxTouchPoints);
  if (ios !== null) {
    if (ios > 0 && ios < 16.04) return no('ios-too-old');
    if (!env.standalone) return no('ios-not-installed');
  }
  if (!env.hasServiceWorker || !env.hasPushManager || env.permission === 'unavailable') return no('unsupported-browser');
  if (env.permission === 'denied') return no('denied');
  return { supported: true };
}

/** VAPID public key (base64url) as the bytes PushManager.subscribe wants. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The subscription's document id: a hash of email and endpoint, so a shared tablet can hold a
 * subscription for each person signed in on it, and re-enabling overwrites instead of adding.
 */
export async function pushSubscriptionId(email: string, endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${email.trim().toLowerCase()}\n${endpoint}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const subscriptionsOf = (db: Firestore, householdId: string) => collection(db, 'households', householdId, 'pushSubscriptions');

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** The `app` of a subscription made through the portal's worker: every app's reminders. */
export const SUITE_PUSH_APP = 'suite';
/** The portal's worker scope, which owns the suite's subscription. */
export const SUITE_SCOPE = '/';

export interface EnablePushOptions {
  /** This app's short name. Used only when the portal's worker can't be reached (a local preview of one app, or its first install still running): the subscription is then this app's alone. */
  app?: string;
  /** Limits the suite subscription to these apps (a silent move from per-app subscriptions keeps theirs). Omit for every app. */
  apps?: string[];
  /** How long to wait for the portal's worker (default `SUITE_WORKER_WAIT_MS`). */
  waitMs?: number;
}

/** What the result of `enablePush` says: where the subscription is and whether it is the suite's. */
export interface EnabledPush {
  id: string;
  endpoint: string;
  /** Made through the portal's worker (every app), not an app's own. */
  suite: boolean;
}

/** How long to wait for the portal's worker to become active, on a first visit that is still installing it. */
export const SUITE_WORKER_WAIT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The portal's registration (scope `/`), registering `/sw.js` when this device hasn't opened the
 * portal yet, and waiting until it is active. Null when it isn't reachable (a build served alone).
 */
export async function suiteRegistration(waitMs = SUITE_WORKER_WAIT_MS): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    let reg = await navigator.serviceWorker.getRegistration(SUITE_SCOPE);
    if (!reg || new URL(reg.scope).pathname !== SUITE_SCOPE) reg = await navigator.serviceWorker.register('/sw.js', { scope: SUITE_SCOPE });
    for (let waited = 0; waited < waitMs && !reg.active; waited += 100) await sleep(100);
    return reg.active ? reg : null;
  } catch {
    return null;
  }
}

/** Every registration on this origin (the portal's and each app's), with its push subscription, if any. */
async function deviceRegistrations(): Promise<{ reg: ServiceWorkerRegistration; sub: PushSubscription; suite: boolean }[]> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return [];
  const sw = navigator.serviceWorker;
  const regs = sw.getRegistrations ? await sw.getRegistrations() : [await sw.getRegistration()].filter((r): r is ServiceWorkerRegistration => !!r);
  const out: { reg: ServiceWorkerRegistration; sub: PushSubscription; suite: boolean }[] = [];
  for (const reg of regs) {
    const sub = await reg.pushManager?.getSubscription();
    if (sub) out.push({ reg, sub, suite: !reg.scope || new URL(reg.scope).pathname === SUITE_SCOPE });
  }
  return out;
}

/** Whether this device's notifications are the suite-wide subscription, an older per-app one, or off. */
export type PushMode = 'suite' | 'legacy' | 'off';

/** Deletes the member's stored documents for the device's per-app subscriptions (the browser's stay, a shared tablet's other members may use them until they upgrade). */
async function dropLegacy(db: Firestore, householdId: string, email: string, legacy: { sub: PushSubscription }[]): Promise<void> {
  for (const { sub } of legacy) await deleteDoc(doc(subscriptionsOf(db, householdId), await pushSubscriptionId(email, sub.endpoint))).catch(() => {});
}

/**
 * Turns on reminders as notifications on this device for the signed-in member, for every app.
 * Call it from a button tap (browsers only ask for permission in response to one). Throws with a
 * sentence to show when the device can't, or the person said no. Replaces the member's per-app
 * subscriptions on this device, so nothing arrives twice.
 */
export async function enablePush(
  db: Firestore,
  householdId: string,
  user: { email: string | null },
  vapidPublicKey: string,
  options: EnablePushOptions = {},
): Promise<EnabledPush> {
  if (!user.email) throw new Error(kt('feedback.signInFirst'));
  if (!vapidPublicKey) throw new Error(kt('push.notConfigured'));
  const support = pushSupport();
  if (!support.supported) throw new Error(support.message);
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? pushMessage('denied') : kt('push.notAllowed'));

  const suite = await suiteRegistration(options.waitMs);
  // Without the portal's worker the subscription can only be this app's own, so the app must say which.
  if (!suite && !options.app) throw new Error(kt('push.couldNotTurnOn'));
  const registration = suite ?? (await navigator.serviceWorker.ready);
  const key = applicationServerKey(vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with another key can't receive this sender's pushes.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error(kt('push.incomplete'));
  const email = user.email.trim().toLowerCase();
  const id = await pushSubscriptionId(email, json.endpoint);
  const data: PushSubscriptionDoc = {
    email,
    app: suite ? SUITE_PUSH_APP : (options.app as string),
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    ua: navigator.userAgent.slice(0, 300),
    ...(suite && options.apps?.length ? { apps: options.apps } : {}),
    lang: getLang(),
    createdAt: Date.now(),
  };
  await setDoc(doc(subscriptionsOf(db, householdId), id), data);
  // The suite subscription now covers every app: this member's per-app documents for the device go.
  if (suite) await dropLegacy(db, householdId, email, (await deviceRegistrations()).filter((r) => !r.suite));
  return { id, endpoint: json.endpoint, suite: !!suite };
}

/** How this device gets the signed-in member's notifications: the suite subscription, an older per-app one still stored (still delivering), or none. */
export async function pushMode(db: Firestore, householdId: string, user: { email: string | null }): Promise<PushMode> {
  if (!user.email || !pushSupport().supported || Notification.permission !== 'granted') return 'off';
  let suite = false;
  let legacy = false;
  for (const reg of await deviceRegistrations()) {
    const stored = await getDoc(doc(subscriptionsOf(db, householdId), await pushSubscriptionId(user.email, reg.sub.endpoint)));
    if (!stored.exists()) continue;
    if (reg.suite) suite = true;
    else legacy = true;
  }
  // 'legacy' also covers a suite document left beside a per-app one (a cleanup that was cut short): upgradePush finishes it.
  return legacy ? 'legacy' : suite ? 'suite' : 'off';
}

/** Whether this device gets the signed-in member's notifications: subscribed, and their subscription is stored. */
export async function pushEnabled(db: Firestore, householdId: string, user: { email: string | null }): Promise<boolean> {
  return (await pushMode(db, householdId, user)) !== 'off';
}

/**
 * Moves a device from a per-app subscription to the suite one without asking: notifications are
 * already allowed for the site (permission is per origin), so it only subscribes through the
 * portal's worker and removes the older documents. Resolves to whether it upgraded; failures are
 * silent, the next open tries again.
 */
export async function upgradePush(db: Firestore, householdId: string, user: { email: string | null }, vapidPublicKey: string | undefined, { waitMs }: { waitMs?: number } = {}): Promise<boolean> {
  if (!vapidPublicKey || !user.email) return false;
  // One move at a time per member and household: the portal's shell and its panel may both ask on open.
  const key = `${householdId}\n${user.email.trim().toLowerCase()}`;
  const running = moving.get(key);
  if (running) return running;
  const move = moveToSuite(db, householdId, user.email, vapidPublicKey, waitMs).finally(() => moving.delete(key));
  moving.set(key, move);
  return move;
}

const moving = new Map<string, Promise<boolean>>();

async function moveToSuite(db: Firestore, householdId: string, email: string, vapidPublicKey: string, waitMs: number | undefined): Promise<boolean> {
  try {
    if ((await pushMode(db, householdId, { email })) !== 'legacy') return false;
    // The move keeps what the person chose here: the apps of the per-app subscriptions it replaces, plus
    // the limit of a suite document already stored (a cleanup cut short). A suite document for every app
    // stays that way. With nothing readable to keep, nothing moves rather than widening the device.
    const has = await suiteDocExists(db, householdId, email);
    const kept = await legacyApps(db, householdId, email);
    let apps: string[] | undefined;
    if (has) {
      const limit = await pushScope(db, householdId, { email });
      apps = limit === null ? undefined : [...new Set([...limit, ...(kept ?? [])])];
    } else if (kept) apps = kept;
    else return false;
    return (await enablePush(db, householdId, { email }, vapidPublicKey, { apps, waitMs })).suite;
  } catch {
    return false;
  }
}

async function suiteDocExists(db: Firestore, householdId: string, email: string): Promise<boolean> {
  for (const { sub, suite } of await deviceRegistrations()) {
    if (suite && (await getDoc(doc(subscriptionsOf(db, householdId), await pushSubscriptionId(email, sub.endpoint)))).exists()) return true;
  }
  return false;
}

/** The apps this device's stored per-app subscriptions for the member are for. */
async function legacyApps(db: Firestore, householdId: string, email: string): Promise<string[] | undefined> {
  const apps = new Set<string>();
  for (const { sub, suite } of await deviceRegistrations()) {
    if (suite) continue;
    const stored = await getDoc(doc(subscriptionsOf(db, householdId), await pushSubscriptionId(email, sub.endpoint)));
    const app = stored.exists() ? stored.data().app : undefined;
    if (typeof app === 'string' && app && app !== SUITE_PUSH_APP) apps.add(app);
  }
  return apps.size ? [...apps] : undefined;
}

/**
 * The apps this device is limited to for the member (a per-app subscription moved to the suite one
 * keeps its apps), or null for every app or no subscription.
 */
export async function pushScope(db: Firestore, householdId: string, user: { email: string | null }): Promise<string[] | null> {
  if (!user.email) return null;
  for (const { sub, suite } of await deviceRegistrations()) {
    if (!suite) continue;
    const stored = await getDoc(doc(subscriptionsOf(db, householdId), await pushSubscriptionId(user.email, sub.endpoint)));
    const apps = stored.exists() ? stored.data().apps : undefined;
    return Array.isArray(apps) && apps.length ? apps.filter((a): a is string => typeof a === 'string') : null;
  }
  return null;
}

/**
 * Shows a notification on this device now, through the same worker that receives reminders, so the
 * person sees what they will get. Resolves to whether one was shown.
 */
export async function sendTestNotification(title: string, body: string): Promise<boolean> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const reg = (await suiteRegistration()) ?? (await navigator.serviceWorker.getRegistration());
  if (!reg) return false;
  await reg.showNotification(title, { body, tag: 'hh-test', icon: `${reg.scope}pwa-192.png`, badge: `${reg.scope}pwa-192.png`, data: { url: reg.scope } });
  return true;
}

/**
 * Rewrites the `lang` of this device's stored subscriptions for the signed-in member when it
 * differs from `lang` (default: the page's language). Only that one field of their own documents;
 * nothing when notifications are off here. Resolves to whether it wrote.
 */
export async function syncPushLang(db: Firestore, householdId: string, user: { email: string | null }, lang: Lang = getLang()): Promise<boolean> {
  if (!user.email || !isLang(lang)) return false;
  let wrote = false;
  for (const { sub } of await deviceRegistrations()) {
    const ref = doc(subscriptionsOf(db, householdId), await pushSubscriptionId(user.email, sub.endpoint));
    const stored = await getDoc(ref);
    if (!stored.exists() || stored.data().lang === lang) continue;
    await updateDoc(ref, { lang });
    wrote = true;
  }
  return wrote;
}

/**
 * Keeps this device's subscription in the page's language: syncs once now and again whenever the
 * language changes (the app bar's menu, another tab). Mount it once in the app's shell, signed in;
 * returns the unsubscribe. Failures are silent: the next change or open tries again.
 */
export function watchPushLang(db: Firestore, householdId: string, user: { email: string | null }): () => void {
  const sync = () => void syncPushLang(db, householdId, user).catch(() => {});
  sync();
  return onLangChange(sync);
}

/**
 * Turns notifications off on this device for the signed-in member by deleting their stored
 * subscriptions (the suite one and any older per-app ones). The browser's subscriptions stay,
 * because on a shared tablet another member's notifications use the same ones; pass
 * `unsubscribeDevice: true` to drop them too.
 */
export async function disablePush(
  db: Firestore,
  householdId: string,
  user: { email: string | null },
  { unsubscribeDevice = false }: { unsubscribeDevice?: boolean } = {},
): Promise<void> {
  if (!user.email) return;
  for (const { sub } of await deviceRegistrations()) {
    await deleteDoc(doc(subscriptionsOf(db, householdId), await pushSubscriptionId(user.email, sub.endpoint)));
    if (unsubscribeDevice) await sub.unsubscribe();
  }
}

/**
 * Each member's own notification preferences, on every device they use:
 * `households/{id}/notificationPrefs/{email}`. `muted` lists the apps whose reminders they don't
 * want (["bills"]); the shared sender skips them for that person, whatever the household or the
 * app schedules for everyone else. Only the member reads and writes their own document.
 *
 * Fields match the rules exactly (see NOTIFICATION_PREFS_FIELDS); keep them in step.
 */
export interface NotificationPrefsDoc {
  /** Short names of apps whose reminders this member doesn't get. */
  muted: string[];
  updatedAt: number;
}

export const NOTIFICATION_PREFS = 'notificationPrefs';
export const NOTIFICATION_PREFS_FIELDS = ['muted', 'updatedAt'] as const;

const prefsOf = (db: Firestore, householdId: string, email: string) => doc(db, 'households', householdId, NOTIFICATION_PREFS, email.trim().toLowerCase());

/** The apps a stored preferences document mutes: short names only, without repeats. */
export function mutedApps(data: unknown): string[] {
  const muted = (data as { muted?: unknown } | null | undefined)?.muted;
  return Array.isArray(muted) ? [...new Set(muted.filter((a): a is string => typeof a === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(a)))] : [];
}

/** Follows which apps the member has muted for themselves (none until they mute one). */
export function watchMutedApps(db: Firestore, householdId: string, email: string, onChange: (muted: string[]) => void, onError?: (error: Error) => void): Unsubscribe {
  return onSnapshot(
    prefsOf(db, householdId, email),
    (snap) => onChange(mutedApps(snap.data())),
    (error) => onError?.(error),
  );
}

/** Mutes or unmutes one app's reminders for the member, on all their devices. */
export async function setAppMuted(db: Firestore, householdId: string, email: string, app: string, muted: boolean): Promise<void> {
  if (!email) throw new Error(kt('feedback.signInFirst'));
  await setDoc(prefsOf(db, householdId, email), { muted: muted ? arrayUnion(app) : arrayRemove(app), updatedAt: Date.now() }, { merge: true });
}
