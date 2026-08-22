/*
 * Gestion du push dans le service worker (importé par le SW généré par vite-plugin-pwa via
 * `workbox.importScripts`). Le contenu est le JSON `PushPayload` chiffré par le panel : titre et corps
 * déjà localisés selon la langue du destinataire. Clic → ouverture/focus de l'URL de l'événement.
 * `pushsubscriptionchange` (rotation par le navigateur) → ré-abonnement + renvoi au panel.
 */
/* eslint-disable no-undef */
/* global self, clients */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'MinecraftManagerOnline', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'MinecraftManagerOnline';
  const options = {
    body: data.body || '',
    icon: '/pwa-192.png',
    badge: '/pwa-192.png',
    lang: data.locale || 'fr',
    data: { url: data.url || '/', eventId: data.eventId || null },
  };
  if (data.tag) {
    options.tag = String(data.tag);
    options.renotify = true;
  }
  if (typeof data.ts === 'number') options.timestamp = data.ts;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  const target = new URL(url, self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) {
            return client.navigate(target).then((c) => (c ? c.focus() : client.focus()));
          }
          return client.focus();
        }
      }
      return clients.openWindow(target);
    }),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription;
  const options = old && old.options ? old.options : null;
  if (!options || !options.applicationServerKey) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey })
      .then((sub) => {
        const json = sub.toJSON();
        return fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          }),
        });
      })
      .catch(() => undefined),
  );
});
