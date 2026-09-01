/**
 * Bannière « version X disponible » : le flux Atom de GitHub liste tout (pré-releases, titres
 * libres, ordre chronologique) — chaque test correspond à une façon dont une bannière pourrait
 * mentir ou harceler : re-notifier la même version, sonner pour une pré-release, marteler GitHub.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openMmoDatabase, type MmoDatabase, type OpenedDatabase } from '../db/client.js';
import type { PublishInput } from './events.js';
import { SettingsService } from './settings.js';
import { UPDATE_CHECK_INTERVAL_MS, UpdateCheckService, latestReleaseIn } from './update-check.js';

const HOUR = 3_600_000;

function atom(...tags: string[]): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry><id>tag:github.com,2008:Repository/9/${tag}</id>` +
        `<link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/${tag}"/>` +
        `<title>${tag} — titre libre, pas un numéro</title></entry>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
}

describe('UpdateCheckService', () => {
  let opened: OpenedDatabase<MmoDatabase>;
  let settings: SettingsService;
  let published: PublishInput[];
  let fetches: number;
  let body: string;
  let now: number;
  let service: UpdateCheckService;

  beforeEach(() => {
    opened = openMmoDatabase(':memory:');
    now = 1_800_000_000_000;
    settings = new SettingsService(opened.db, () => now);
    published = [];
    fetches = 0;
    body = atom('v1.0.6', 'v1.0.2');
    const fakeFetch = (() => {
      fetches += 1;
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    service = new UpdateCheckService({
      settings,
      events: {
        publish: (input) => {
          published.push(input);
        },
      },
      now: () => now,
      fetchImpl: fakeFetch,
      atomUrl: 'https://atom.test/releases.atom',
      currentVersion: '1.0.5',
    });
  });
  afterEach(() => {
    opened.close();
  });

  it('notifie UNE fois par version découverte, au plus un appel réseau par 6 h', async () => {
    await service.checkIfStale();
    expect(fetches).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'panel.updateAvailable',
      severity: 'info',
      payload: { version: '1.0.6', current: '1.0.5' },
    });
    expect(service.latestAvailable()).toBe('1.0.6');

    // Dans la fenêtre : pas de réseau. Après : réseau, mais pas de seconde notification.
    now += HOUR;
    await service.checkIfStale();
    expect(fetches).toBe(1);
    now += UPDATE_CHECK_INTERVAL_MS;
    await service.checkIfStale();
    expect(fetches).toBe(2);
    expect(published).toHaveLength(1);
  });

  it('désactivé : aucun appel réseau', async () => {
    settings.set('panel.updateCheck.enabled', 'false');
    await service.checkIfStale();
    expect(fetches).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('rien de plus récent : cache rempli mais ni notification ni bannière', async () => {
    body = atom('v1.0.5', 'v1.0.4');
    await service.checkIfStale();
    expect(published).toHaveLength(0);
    expect(service.latestAvailable()).toBeUndefined();
  });

  it('échec réseau : l’erreur remonte au tick, la fenêtre de 6 h tient quand même', async () => {
    const failing = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const broken = new UpdateCheckService({
      settings,
      events: { publish: () => undefined },
      now: () => now,
      fetchImpl: failing,
      currentVersion: '1.0.5',
    });
    await expect(broken.checkIfStale()).rejects.toThrow('offline');
    // GitHub en panne ne se fait pas marteler : la prochaine sortie attend la fenêtre.
    await service.checkIfStale();
    expect(fetches).toBe(0);
  });

  it('latestReleaseIn : max sémantique, pré-releases et titres libres ignorés', () => {
    expect(latestReleaseIn(atom('v1.0.2', 'v1.0.10', 'v1.0.9'))).toBe('1.0.10');
    expect(latestReleaseIn(atom('v1.1.0-rc1', 'v1.0.6'))).toBe('1.0.6');
    expect(latestReleaseIn(atom())).toBeUndefined();
    expect(latestReleaseIn('<feed><title>2.0.0 dans un titre</title></feed>')).toBeUndefined();
  });
});
