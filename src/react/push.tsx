/**
 * Notifications, one switch per device for the whole suite (STANDARD.md "Notifications"). The
 * portal's Notifications panel is the place to manage them: `DeviceNotifications` (this device on or
 * off, a test notification) and `AppNotificationToggles` (which apps notify the signed-in person).
 * Each app's settings carries the compact `NotificationsCard`: the device status, a switch so a
 * first-time user need not leave, and a "Manage in Huishouden" link to the panel. Each person turns
 * the device on once; where the device can't (an iPhone not added to the Home Screen), it says why.
 *
 * ```tsx
 * <NotificationsCard db={db} householdId={id} user={user} app="tasks" vapidKey={import.meta.env.VITE_VAPID_PUBLIC_KEY}
 *   offText="Get a notification here an hour before a task is due." onText="On. This device tells you an hour before a task is due." />
 * ```
 */
import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import type { Firestore } from 'firebase/firestore';
import { NOTIFICATIONS_PATH } from '../app-bar';
import { formatList } from '../i18n';
import { disablePush, enablePush, pushMode, pushScope, pushSupport, sendTestNotification, setAppMuted, upgradePush, watchMutedApps, watchPushLang } from '../push';
import { useKitT } from './i18n';
import { Checkbox, cardClass, overline, primaryButton, secondaryButton } from './ui';

/** Where the portal's Notifications panel opens: same-origin, so a staging app links to staging. */
export const MANAGE_NOTIFICATIONS_HREF = NOTIFICATIONS_PATH;

type State = 'checking' | 'off' | 'on' | 'working';

/** This device's switch: the state, and turning it on or off. Also moves an older per-app subscription to the suite one. */
function useDevicePush(db: Firestore, householdId: string, user: { email: string | null }, vapidKey: string | undefined, app?: string) {
  const kt = useKitT();
  const [state, setState] = useState<State>('checking');
  const [scope, setScope] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const email = user.email;

  useEffect(() => {
    let live = true;
    const read = () =>
      pushMode(db, householdId, { email })
        .then(async (m) => {
          const apps = m === 'off' ? null : await pushScope(db, householdId, { email });
          if (live) {
            setScope(apps);
            setState(m === 'off' ? 'off' : 'on');
          }
        })
        .catch(() => live && setState('off'));
    // Allowed here already under an app's own subscription: moved to the suite's without asking.
    void upgradePush(db, householdId, { email }, vapidKey).then((moved) => (moved ? read() : undefined)).catch(() => {});
    void read();
    return () => {
      live = false;
    };
  }, [db, householdId, email, vapidKey]);

  // While on, the stored subscription follows the language, so reminders arrive in it.
  useEffect(() => (state === 'on' ? watchPushLang(db, householdId, { email }) : undefined), [state, db, householdId, email]);

  const turnOn = async () => {
    setError(null);
    setState('working');
    try {
      await enablePush(db, householdId, { email }, vapidKey ?? '', { app });
      setScope(null);
      setState('on');
    } catch (e) {
      setError(e instanceof Error ? e.message : kt('push.couldNotTurnOn'));
      setState('off');
    }
  };

  const turnOff = async () => {
    setError(null);
    setState('working');
    try {
      await disablePush(db, householdId, { email });
      setScope(null);
      setState('off');
    } catch {
      setError(kt('push.couldNotTurnOff'));
      setState('on');
    }
  };

  return { state, scope, error, setError, turnOn, turnOff };
}

function DeviceSwitch({ state, turnOn, turnOff }: { state: State; turnOn: () => void; turnOff: () => void }) {
  const kt = useKitT();
  return state === 'on' ? (
    <button type="button" className={secondaryButton} onClick={turnOff}>
      <BellOff size={18} /> {kt('push.turnOff')}
    </button>
  ) : (
    <button type="button" className={primaryButton} disabled={state !== 'off'} onClick={turnOn}>
      <Bell size={18} /> {state === 'working' ? kt('push.asking') : kt('push.turnOn')}
    </button>
  );
}

export interface DeviceNotificationsProps {
  /** The apps' labels by short name, to say which apps a device limited to some gets. */
  labels?: Record<string, string>;
  db: Firestore;
  householdId: string;
  user: { email: string | null };
  vapidKey: string | undefined;
  plain?: boolean;
}

/** The portal's "this device" section: on or off for the whole suite, and a test notification. */
export function DeviceNotifications({ db, householdId, user, vapidKey, plain, labels = {} }: DeviceNotificationsProps) {
  const kt = useKitT();
  const support = pushSupport();
  const { state, scope, error, setError, turnOn, turnOff } = useDevicePush(db, householdId, user, vapidKey);
  const [tested, setTested] = useState<'idle' | 'sent' | 'failed'>('idle');
  return (
    <section className={plain ? '' : `${cardClass} p-6`} aria-label={kt('push.title')}>
      <h3 className={overline}>{kt('push.title')}</h3>
      {!vapidKey ? (
        <p className="mt-2 text-base text-muted">{kt('push.notSetUp')}</p>
      ) : !support.supported ? (
        <p className="mt-2 text-base text-muted">{support.message}</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 text-base text-muted">{state === 'on' ? kt('push.suiteOn') : kt('push.suiteOff')}</p>
            <DeviceSwitch state={state} turnOn={() => void turnOn()} turnOff={() => void turnOff()} />
          </div>
          {state === 'on' && scope && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-base text-muted">{kt('push.scoped', { apps: formatList(scope.map((a) => labels[a] ?? a)) })}</p>
              <button type="button" className={secondaryButton} onClick={() => void turnOn()}>
                {kt('push.allApps')}
              </button>
            </div>
          )}
          {state === 'on' && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={secondaryButton}
                onClick={() => {
                  setError(null);
                  sendTestNotification(kt('push.testTitle'), kt('push.testBody'))
                    .then((shown) => setTested(shown ? 'sent' : 'failed'))
                    .catch(() => setTested('failed'));
                }}
              >
                {kt('push.test')}
              </button>
              <div role="status" aria-live="polite">
                {tested === 'sent' && <p className="text-sm text-muted">{kt('push.testSent')}</p>}
                {tested === 'failed' && <p className="text-sm text-error">{kt('push.testFailed')}</p>}
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-base text-error">
          {error}
        </p>
      )}
    </section>
  );
}

export interface AppNotificationToggle {
  /** The app's short name, as its reminders' `app` ("pet"). */
  id: string;
  /** What the person sees ("Pet"). */
  label: string;
}

export interface AppNotificationTogglesProps {
  db: Firestore;
  householdId: string;
  /** The signed-in person; the toggles are theirs alone, on all their devices (`setAppMuted`). */
  email: string;
  /** The apps to offer, already limited to the ones this person's role may use. */
  apps: AppNotificationToggle[];
  plain?: boolean;
}

/** One switch per app for the signed-in person: whether that app's reminders reach them. */
export function AppNotificationToggles({ db, householdId, email, apps, plain }: AppNotificationTogglesProps) {
  const kt = useKitT();
  const [muted, setMuted] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed read shows no switches and says so, instead of offering to write against a list never read.
  useEffect(
    () =>
      watchMutedApps(db, householdId, email, setMuted, () => {
        setMuted(null);
        setError(kt('push.couldNotRead'));
      }),
    [db, householdId, email, kt],
  );
  return (
    <section className={plain ? '' : `${cardClass} p-6`} aria-label={kt('push.appsTitle')}>
      <h3 className={overline}>{kt('push.appsTitle')}</h3>
      <p className="mt-2 text-base text-muted">{kt('push.appsHint')}</p>
      {muted && (
        <ul className="mt-3 space-y-2">
          {apps.map((app) => (
            <li key={app.id}>
              <Checkbox
                checked={!muted.includes(app.id)}
                onChange={(on) => {
                  setError(null);
                  // Only this app's entry is changed or put back, so a switch that fails never undoes another.
                  const set = (isOn: boolean) => setMuted((list) => (list ? (isOn ? list.filter((a) => a !== app.id) : [...new Set([...list, app.id])]) : list));
                  set(on);
                  setAppMuted(db, householdId, email, app.id, !on).catch(() => {
                    set(!on);
                    setError(kt('push.couldNotMute'));
                  });
                }}
              >
                {app.label}
              </Checkbox>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-base text-error">
          {error}
        </p>
      )}
    </section>
  );
}

export interface NotificationsCardProps {
  db: Firestore;
  householdId: string;
  user: { email: string | null };
  /** The app this card is in ("tasks"): whose reminders `muteText` mutes. */
  app: string;
  /** `VITE_VAPID_PUBLIC_KEY`; without it the card says notifications are not set up. */
  vapidKey: string | undefined;
  /** What turning it on gives, in the app's words. */
  offText: string;
  /** What it does while on. */
  onText: string;
  /** Without the card's own border and padding, inside another card or a dialog. */
  plain?: boolean;
  /**
   * Offers muting this app's reminders for the signed-in member on all their devices
   * (`setAppMuted`), in the app's words: "Mute bill reminders for me". The household's own setting
   * is untouched. Leave out to not offer it.
   */
  muteText?: string;
}

/**
 * The app's compact notifications status: what it gives, the device switch (which turns the whole
 * suite on for this device), and "Manage in Huishouden" for the per-app choices.
 */
export function NotificationsCard({ db, householdId, user, app, vapidKey, offText, onText, plain, muteText }: NotificationsCardProps) {
  const kt = useKitT();
  const support = pushSupport();
  const { state, error, setError, turnOn, turnOff } = useDevicePush(db, householdId, user, vapidKey, app);
  const [muted, setMuted] = useState<boolean | null>(null);
  const email = user.email;

  useEffect(() => (muteText && email ? watchMutedApps(db, householdId, email, (apps) => setMuted(apps.includes(app)), () => setMuted(null)) : undefined), [muteText, db, householdId, email, app]);

  return (
    <section className={plain ? '' : `${cardClass} p-6`} aria-label={kt('push.title')}>
      <h3 className={overline}>{kt('push.title')}</h3>
      {!vapidKey ? (
        <p className="mt-2 text-base text-muted">{kt('push.notSetUp')}</p>
      ) : !support.supported ? (
        <p className="mt-2 text-base text-muted">{support.message}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-base text-muted">{state === 'on' ? onText : offText}</p>
          <DeviceSwitch state={state} turnOn={() => void turnOn()} turnOff={() => void turnOff()} />
        </div>
      )}
      {vapidKey && support.supported && <p className="mt-2 text-sm text-muted">{kt('push.suiteNote')}</p>}
      {muteText && email && muted !== null && (
        <div className="mt-3">
          <Checkbox
            describedBy={`hh-mute-hint-${app}`}
            checked={muted}
            onChange={(on) => {
              setError(null);
              setMuted(on);
              setAppMuted(db, householdId, email, app, on).catch(() => {
                setMuted(!on);
                setError(kt('push.couldNotMute'));
              });
            }}
          >
            {muteText}
          </Checkbox>
          <p id={`hh-mute-hint-${app}`} className="ml-9 text-sm text-muted">{kt('push.muteHint')}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-base text-error">
          {error}
        </p>
      )}
      <p className="mt-3 text-base">
        <a className="font-medium text-link underline" href={MANAGE_NOTIFICATIONS_HREF}>
          {kt('push.manage')}
        </a>
      </p>
    </section>
  );
}

/**
 * Renders nothing: moves this device from an older per-app subscription to the suite one, and
 * keeps the subscription in the page's language. Mount it once in a signed-in shell (the portal
 * does), so a device upgrades the next time the portal opens, without anyone visiting settings.
 */
export function PushSuiteUpgrade({ db, householdId, user, vapidKey }: { db: Firestore; householdId: string; user: { email: string | null }; vapidKey: string | undefined }) {
  const email = user.email;
  useEffect(() => {
    void upgradePush(db, householdId, { email }, vapidKey);
    return watchPushLang(db, householdId, { email });
  }, [db, householdId, email, vapidKey]);
  return null;
}
