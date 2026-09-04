/*
 * Gestion du push dans le service worker (importé par le SW généré par vite-plugin-pwa via
 * `workbox.importScripts`). Le contenu est le JSON `PushPayload` chiffré par le panel : titre et corps
 * déjà localisés selon la langue du destinataire. Clic → ouverture/focus de l'URL de l'événement.
 * `pushsubscriptionchange` (rotation par le navigateur) → ré-abonnement + renvoi au panel.
 *
 * Lot 8 — boutons d'action : **le panel décide, ce fichier exécute**. Le payload porte des actions
 * déjà localisées avec leur URL ; ici on ne fait qu'appeler ce qui est demandé, après avoir vérifié
 * que la cible est bien une route interne. Le raisonnement (quelle action pour quel événement) vit
 * côté panel, là où il est testé — un service worker n'est pas l'endroit où mettre des décisions.
 */
/* eslint-disable no-undef */
/* global self, clients */

/** Une action ne peut viser que le panel lui-même : un appel vers `/api/…`, une page sinon. */
function safePath(url, forApi) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
  if (forApi && !url.startsWith('/api/')) return null;
  return url;
}

function actionsOf(data) {
  if (!Array.isArray(data.actions)) return [];
  return data.actions
    .filter((a) => a && typeof a.action === 'string' && typeof a.title === 'string')
    .filter((a) => safePath(a.url, a.method === 'POST') !== null)
    .slice(0, 2);
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'MinecraftManagerOnline', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'MinecraftManagerOnline';
  const actions = actionsOf(data);
  const options = {
    body: data.body || '',
    icon: '/pwa-192.png',
    badge: '/pwa-192.png',
    lang: data.locale || 'en',
    data: { url: data.url || '/', eventId: data.eventId || null, actions },
  };
  if (actions.length > 0) {
    options.actions = actions.map((a) => ({ action: a.action, title: a.title }));
  }
  if (data.tag) {
    options.tag = String(data.tag);
    options.renotify = true;
  }
  if (typeof data.ts === 'number') options.timestamp = data.ts;
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Ouvre l'onglet du panel (ou le ramène au premier plan) sur `url`. */
function openPanel(url) {
  const target = new URL(url, self.location.origin).href;
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if ('focus' in client) {
        if ('navigate' in client) {
          return client.navigate(target).then((c) => (c ? c.focus() : client.focus()));
        }
        return client.focus();
      }
    }
    return clients.openWindow(target);
  });
}

/**
 * Un bouton d'action : appel au panel avec le cookie de session (donc soumis aux mêmes droits que
 * l'interface), puis une notification de résultat — sans elle, l'utilisateur taperait dans le vide,
 * la notification d'origine ayant disparu. Les textes viennent du panel, jamais d'ici.
 */
function runAction(action) {
  const url = safePath(action.url, action.method === 'POST');
  if (url === null) return Promise.resolve();
  if (action.method !== 'POST') return openPanel(url);
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then((res) => (res.ok ? action.okBody : action.failBody))
    .catch(() => action.failBody)
    .then((body) =>
      body
        ? self.registration.showNotification(action.title, {
            body,
            icon: '/pwa-192.png',
            badge: '/pwa-192.png',
          })
        : undefined,
    );
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action) {
    const chosen = (data.actions || []).find((a) => a.action === event.action);
    if (chosen) {
      event.waitUntil(runAction(chosen));
      return;
    }
  }
  event.waitUntil(openPanel(data.url || '/'));
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
