/**
 * Lot 8 — le service worker de push, enfin sous test. Il n'était couvert par rien, et il vient de
 * gagner la seule chose de tout le produit qui puisse MODIFIER quelque chose depuis un écran
 * verrouillé : le bouton « Démarrer » d'une notification.
 *
 * Le fichier est du JavaScript ordinaire chargé par `importScripts` : on le lit et on l'évalue
 * avec un faux `self`, ce qui donne accès aux écouteurs qu'il enregistre. Rien n'est simulé de ce
 * qui compte — c'est bien le code livré qui décide d'appeler, ou de refuser.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Chemin depuis la racine du paquet : sous jsdom, `import.meta.url` n'est pas une URL `file:`.
const SOURCE = readFileSync(path.resolve(process.cwd(), 'public/sw-push.js'), 'utf8');

interface Shown {
  title: string;
  options: Record<string, unknown>;
}

interface Harness {
  push(data: unknown): Promise<void>;
  click(notification: { data?: unknown }, action?: string): Promise<void>;
  shown: Shown[];
  fetches: { url: string; init?: RequestInit }[];
  opened: string[];
  fetchOk: boolean;
  fetchThrows: boolean;
}

/** Charge le worker dans un faux environnement et rend de quoi le piloter. */
function load(): Harness {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const shown: Shown[] = [];
  const fetches: { url: string; init?: RequestInit }[] = [];
  const opened: string[] = [];
  const state = { fetchOk: true, fetchThrows: false };

  const self = {
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      listeners.set(type, fn);
    },
    location: { origin: 'https://panel.test' },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
  };
  const clients = {
    matchAll: () => Promise.resolve([]),
    openWindow: (url: string) => {
      opened.push(url);
      return Promise.resolve(null);
    },
  };
  const fetchImpl = (url: string, init?: RequestInit) => {
    fetches.push({ url, ...(init === undefined ? {} : { init }) });
    if (state.fetchThrows) return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: state.fetchOk });
  };

  // Le worker s'exécute dans son propre contexte : `self`, `clients`, `fetch` et `URL` sont les
  // seuls globaux qu'il utilise. `node:vm` plutôt qu'un `new Function` : c'est l'outil fait pour
  // ça, et le fichier reste celui qui est livré.
  vm.runInNewContext(SOURCE, { self, clients, fetch: fetchImpl, URL });

  const fire = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    const fn = listeners.get(type);
    if (fn === undefined) throw new Error(`aucun écouteur ${type}`);
    fn({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        waits.push(p);
      },
    });
    await Promise.all(waits);
  };

  return {
    push: (data: unknown) => fire('push', { data: { json: () => data } }),
    click: (notification, action) =>
      fire('notificationclick', {
        notification: { ...notification, close: () => undefined },
        ...(action === undefined ? {} : { action }),
      }),
    shown,
    fetches,
    opened,
    get fetchOk() {
      return state.fetchOk;
    },
    set fetchOk(value: boolean) {
      state.fetchOk = value;
    },
    get fetchThrows() {
      return state.fetchThrows;
    },
    set fetchThrows(value: boolean) {
      state.fetchThrows = value;
    },
  };
}

const CRASH = {
  title: 'Alpha est tombé',
  body: 'Redémarrage automatique désactivé.',
  url: '/servers/srv1',
  ts: 1_788_000_000_000,
  actions: [
    {
      action: 'restart',
      title: 'Démarrer',
      url: '/api/servers/srv1/start',
      method: 'POST',
      okBody: 'Démarrage demandé.',
      failBody: 'Le panel a refusé.',
    },
    { action: 'console', title: 'Console', url: '/servers/srv1?tab=console' },
  ],
};

describe('service worker de push', () => {
  let sw: Harness;
  beforeEach(() => {
    vi.restoreAllMocks();
    sw = load();
  });

  it('affiche les boutons fournis par le panel, et les garde pour le clic', async () => {
    await sw.push(CRASH);
    const shown = sw.shown[0];
    expect(shown?.title).toBe('Alpha est tombé');
    expect(shown?.options.actions).toEqual([
      { action: 'restart', title: 'Démarrer' },
      { action: 'console', title: 'Console' },
    ]);
    // L'URL et la méthode ne sont PAS montrées au système : elles voyagent dans `data`, que le
    // navigateur nous rend au clic.
    expect(JSON.stringify(shown?.options.actions)).not.toContain('/api/');
  });

  it('« Démarrer » appelle le panel avec le cookie de session, et dit ce qui s’est passé', async () => {
    await sw.push(CRASH);
    await sw.click({ data: sw.shown[0]?.options.data }, 'restart');

    expect(sw.fetches).toHaveLength(1);
    expect(sw.fetches[0]?.url).toBe('/api/servers/srv1/start');
    expect(sw.fetches[0]?.init?.method).toBe('POST');
    // Sans le cookie, la route répondrait « connectez-vous » : c'est tout l'intérêt du worker.
    expect(sw.fetches[0]?.init?.credentials).toBe('same-origin');
    // La notification d'origine a disparu au clic : sans retour, on taperait dans le vide.
    expect(sw.shown[1]?.options.body).toBe('Démarrage demandé.');
  });

  it('un refus du panel se voit, et une coupure réseau aussi', async () => {
    sw.fetchOk = false;
    await sw.push(CRASH);
    await sw.click({ data: sw.shown[0]?.options.data }, 'restart');
    expect(sw.shown[1]?.options.body).toBe('Le panel a refusé.');

    const offline = load();
    offline.fetchThrows = true;
    await offline.push(CRASH);
    await offline.click({ data: offline.shown[0]?.options.data }, 'restart');
    expect(offline.shown[1]?.options.body).toBe('Le panel a refusé.');
  });

  it('« Console » ouvre le panel sans rien appeler', async () => {
    await sw.push(CRASH);
    await sw.click({ data: sw.shown[0]?.options.data }, 'console');
    expect(sw.fetches).toHaveLength(0);
    expect(sw.opened).toEqual(['https://panel.test/servers/srv1?tab=console']);
  });

  it('un clic hors bouton ouvre la page de l’événement', async () => {
    await sw.push(CRASH);
    await sw.click({ data: sw.shown[0]?.options.data });
    expect(sw.fetches).toHaveLength(0);
    expect(sw.opened).toEqual(['https://panel.test/servers/srv1']);
  });

  it('une action qui vise ailleurs que le panel est refusée', async () => {
    await sw.push({
      ...CRASH,
      actions: [
        // Une URL absolue, un chemin protocole-relatif, et un POST hors `/api/` : trois façons de
        // sortir du panel. Le worker n'exécute que ce qu'il reconnaît.
        { action: 'evil', title: 'Ailleurs', url: 'https://ailleurs.test/x', method: 'POST' },
        { action: 'evil2', title: 'Ailleurs', url: '//ailleurs.test/x', method: 'POST' },
        { action: 'evil3', title: 'Ailleurs', url: '/pas-api/x', method: 'POST' },
        // Et la même chose SANS méthode : une simple navigation vers un autre site emmènerait
        // l'onglet du panel ailleurs — le contrôle d'origine ne doit pas dépendre du POST.
        { action: 'evil4', title: 'Ailleurs', url: 'https://ailleurs.test/page' },
      ],
    });
    expect(sw.shown[0]?.options.actions).toBeUndefined();
    await sw.click({ data: sw.shown[0]?.options.data }, 'evil');
    expect(sw.fetches).toHaveLength(0);
    // Le clic retombe sur l'ouverture de la page de l'événement, jamais sur un appel ni sur le
    // site visé par l'action refusée.
    expect(sw.opened).toEqual(['https://panel.test/servers/srv1']);
    await sw.click({ data: sw.shown[0]?.options.data }, 'evil4');
    expect(sw.opened).toEqual([
      'https://panel.test/servers/srv1',
      'https://panel.test/servers/srv1',
    ]);
  });

  it('sans actions, la notification reste ce qu’elle était', async () => {
    await sw.push({ title: 'Sauvegarde faite', body: 'Alpha', url: '/servers/srv1', ts: 1 });
    expect(sw.shown[0]?.options.actions).toBeUndefined();
    await sw.click({ data: sw.shown[0]?.options.data });
    expect(sw.opened).toEqual(['https://panel.test/servers/srv1']);
  });
});
