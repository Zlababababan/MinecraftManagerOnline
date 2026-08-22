/**
 * Web Push côté navigateur (doc 03 §5) : détection du support (HTTPS, service worker, PushManager,
 * iOS = PWA installée obligatoire), abonnement avec la clé VAPID du panel, re-synchronisation au
 * démarrage (iOS purge silencieusement : si l'utilisateur avait activé le push et que l'abonnement a
 * disparu, on le recrée ; s'il existe, on le renvoie au panel pour rafraîchir `last_seen_at`).
 */
import type { PushSubscribeInput } from '@mmo/protocol/client';

export const PUSH_FLAG = 'mmo.push';

export type PushUnsupportedReason = 'insecure' | 'no-sw' | 'no-push' | 'ios-not-installed';

export interface PushSupport {
  supported: boolean;
  reason?: PushUnsupportedReason;
  ios: boolean;
  standalone: boolean;
  permission: NotificationPermission | 'unsupported';
}

export function isIos(
  ua = navigator.userAgent,
  maxTouchPoints = navigator.maxTouchPoints,
): boolean {
  // iPadOS se présente comme un Mac : on le reconnaît au tactile multipoint.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export function pushSupport(): PushSupport {
  const ios = isIos();
  const standalone = isStandalone();
  const permission: PushSupport['permission'] =
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const base = { ios, standalone, permission };
  if (!window.isSecureContext) return { ...base, supported: false, reason: 'insecure' };
  if (!('serviceWorker' in navigator)) return { ...base, supported: false, reason: 'no-sw' };
  if (ios && !standalone) return { ...base, supported: false, reason: 'ios-not-installed' };
  if (!('PushManager' in window) || typeof Notification === 'undefined') {
    return { ...base, supported: false, reason: 'no-push' };
  }
  return { ...base, supported: true };
}

export function urlBase64ToUint8Array(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function toInput(subscription: PushSubscription): PushSubscribeInput {
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    userAgent: navigator.userAgent.slice(0, 512),
  };
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscribeInput | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  return sub === null ? undefined : toInput(sub);
}

/** Demande la permission puis abonne ce navigateur (idempotent : renvoie l'abonnement existant). */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscribeInput> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('permission denied');
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    }));
  localStorage.setItem(PUSH_FLAG, '1');
  return toInput(sub);
}

export async function unsubscribePush(): Promise<string | undefined> {
  localStorage.removeItem(PUSH_FLAG);
  if (!('serviceWorker' in navigator)) return undefined;
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (sub === null) return undefined;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

/**
 * Au démarrage de l'app : renvoie l'abonnement courant au panel (ou le recrée s'il a disparu alors
 * que l'utilisateur l'avait activé). Renvoie `undefined` si rien n'est à faire.
 */
export async function resyncPush(
  vapidPublicKey: string | null,
  post: (input: PushSubscribeInput) => Promise<unknown>,
): Promise<'synced' | 'resubscribed' | undefined> {
  const support = pushSupport();
  if (!support.supported || support.permission !== 'granted') return undefined;
  const existing = await currentSubscription();
  if (existing !== undefined) {
    await post(existing);
    return 'synced';
  }
  if (localStorage.getItem(PUSH_FLAG) === '1' && vapidPublicKey !== null) {
    await post(await subscribePush(vapidPublicKey));
    return 'resubscribed';
  }
  return undefined;
}
