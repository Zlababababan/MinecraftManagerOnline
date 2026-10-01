/**
 * Lot 5 — assistant de création : le chemin final est montré avant d'écrire quoi que ce soit, un
 * nom de dossier invalide arrête là, le pré-contrôle est demandé avant le dernier écran, et le
 * bouton de création reste inerte tant que l'EULA n'est pas cochée — elle ne l'est jamais d'avance.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MachineDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { CreateServerModal, DEFAULT_RAM_MB, groupVersions } from './CreateServerModal.js';

const machine = { id: 'm1', name: 'Tour', os: 'linux' } as MachineDto;
const directories = [
  { id: 'dir1', path: '/srv/minecraft', enabled: true, lastScanAt: null },
  { id: 'dir2', path: '/data/mc', enabled: true, lastScanAt: null },
];

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface FetchOptions {
  /** Le pré-contrôle dit-il que Java manque ? */
  javaMissing?: boolean;
  role?: 'admin' | 'operator';
  /** L'intégration FTB est-elle activée (Réglages → Services tiers) ? */
  ftb?: boolean;
  /** Zips posés sur la machine (mode « Archive »). */
  archives?: string[];
  /** L'inspection reconnaît-elle le chargeur de l'archive ? (défaut : oui.) */
  archiveRecognized?: boolean;
}

function installFetch(calls: Call[], options: FetchOptions = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      const body: unknown =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      await Promise.resolve();
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/api/auth/me') {
        return json({
          user: { id: 'u1', username: 'ambre', role: options.role ?? 'admin', scoped: false },
          features: { ftb: options.ftb === true },
        });
      }
      if (path.startsWith('/api/tasks')) return json({ tasks: [] });
      if (path.endsWith('/java/install')) return json({ task: { id: 't-java' }, sources: [] });
      if (path === '/api/servers') {
        return json({
          servers: [
            { id: 'srv-creatif', machineId: 'm1', name: 'Créatif', path: '/srv/minecraft/creatif' },
            {
              id: 'srv-ailleurs',
              machineId: 'm2',
              name: 'Ailleurs',
              path: '/srv/minecraft/survie',
            },
          ],
        });
      }
      if (path.startsWith('/api/install/modpacks/ftb?')) {
        return json({ packs: [{ id: 125, name: 'FTB Evolution', synopsis: 'Tech et magie' }] });
      }
      if (path === '/api/install/modpacks/ftb/125') {
        const v = (id: number, name: string, installable: boolean) => ({
          id,
          name,
          type: 'release',
          mcVersion: installable ? '1.21.1' : null,
          loader: installable ? 'neoforge' : null,
          loaderVersion: installable ? '21.1.209' : null,
          ramRecommendedMb: 8092,
          installable,
        });
        return json({
          pack: {
            id: 125,
            name: 'FTB Evolution',
            synopsis: 'Tech et magie',
            versions: [v(100487, '1.43.1', true), v(7, 'ancienne', false)],
          },
        });
      }
      if (path.endsWith('/install/archives')) {
        return json({
          archives: (options.archives ?? []).map((name) => ({
            directoryId: 'dir1',
            name,
            path: `/srv/minecraft/${name}`,
            size: 903_000_000,
            modifiedAt: 1_790_000_000_000,
          })),
        });
      }
      if (path.endsWith('/install/archives/inspect')) {
        return json({
          inspection: {
            path: (body as { path: string }).path,
            files: 1941,
            bytes: 1_041_326_457,
            root: '',
            recognized:
              options.archiveRecognized === false
                ? null
                : {
                    loader: 'neoforge',
                    mcVersion: '1.21.1',
                    loaderVersion: '21.1.250',
                    source: 'startserver.sh',
                  },
            properties: options.archiveRecognized === false ? {} : { 'allow-flight': 'true' },
            hasMods: true,
          },
        });
      }
      if (path.startsWith('/api/install/catalog')) {
        if (path.includes('fabric')) {
          return json({
            loader: 'fabric',
            versions: [{ id: '1.21.1', stable: true, loaderVersion: '0.16.5' }],
          });
        }
        return json({
          loader: 'vanilla',
          versions: [
            { id: '1.20.2-pre1', stable: false },
            { id: '1.20.1', stable: true },
            { id: '1.19.4', stable: true },
          ],
        });
      }
      if (path.endsWith('/install/precheck')) {
        return json({
          precheck: {
            ok: false,
            path: { ok: true },
            port: { ok: false, code: 'port_in_use' },
            java: options.javaMissing === true ? { ok: false, code: 'java_missing' } : { ok: true },
            disk: { ok: true },
            target: {
              path: '/srv/minecraft/survie',
              gamePort: 25565,
              javaMajor: 17,
              loaderVersion: null,
            },
          },
        });
      }
      return json({ server: { id: 'srv-new' } });
    }),
  );
}

function renderModal(options: FetchOptions = {}): { calls: Call[]; created: string[] } {
  const calls: Call[] = [];
  const created: string[] = [];
  installFetch(calls, options);
  render(
    <MantineProvider>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CreateServerModal
          machine={machine}
          directories={directories}
          opened
          onClose={() => undefined}
          onCreated={(id) => created.push(id)}
        />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { calls, created };
}

/** Remplit le premier écran et avance jusqu'au récapitulatif. */
async function walkToReview(): Promise<void> {
  fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
  fireEvent.click(screen.getByTestId('install-next'));
  const version = await screen.findByTestId('install-version');
  await waitFor(() => {
    expect(version.querySelectorAll('option').length).toBeGreaterThan(1);
  });
  fireEvent.change(version, { target: { value: '1.20.1' } });
  fireEvent.click(screen.getByTestId('install-next'));
  fireEvent.click(await screen.findByTestId('install-next'));
}

describe('CreateServerModal', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('montre le chemin final, composé du répertoire choisi et du nom de dossier', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
    expect(screen.getByTestId('install-path')).toHaveTextContent('/srv/minecraft/survie');
    fireEvent.change(screen.getByTestId('install-directory'), { target: { value: 'dir2' } });
    await waitFor(() => {
      expect(screen.getByTestId('install-path')).toHaveTextContent('/data/mc/survie');
    });
  });

  it('un nom de dossier déjà pris sur cette machine est dit tout de suite, et n’avance pas', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'creatif' } });
    expect(
      await screen.findByText('Ce nom de dossier est déjà celui d’un serveur enregistré ici.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('install-next'));
    expect(screen.getByTestId('install-path')).toBeInTheDocument();
    // Le même nom sur une AUTRE machine ne compte pas : « survie » y est libre.
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
    await waitFor(() => {
      expect(
        screen.queryByText('Ce nom de dossier est déjà celui d’un serveur enregistré ici.'),
      ).not.toBeInTheDocument();
    });
    // Et sous un autre répertoire non plus.
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'creatif' } });
    fireEvent.change(screen.getByTestId('install-directory'), { target: { value: 'dir2' } });
    await waitFor(() => {
      expect(
        screen.queryByText('Ce nom de dossier est déjà celui d’un serveur enregistré ici.'),
      ).not.toBeInTheDocument();
    });
  });

  it('un nom de dossier impossible n’avance pas d’un écran', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: '../ailleurs' } });
    fireEvent.click(screen.getByTestId('install-next'));
    // Toujours le premier écran : le chemin final est encore là.
    expect(screen.getByTestId('install-path')).toBeInTheDocument();
  });

  it('le récapitulatif dit ce que la machine refuse, sans empêcher de continuer', async () => {
    const { calls } = renderModal();
    await walkToReview();
    expect(await screen.findByTestId('install-precheck-problems')).toHaveTextContent('port');
    expect(calls.some((c) => c.path.endsWith('/install/precheck'))).toBe(true);
  });

  it('l’EULA n’est jamais cochée d’avance, et rien ne part avant qu’elle le soit', async () => {
    const { calls, created } = renderModal();
    await walkToReview();
    const eula = await screen.findByTestId('install-eula');
    expect(eula).not.toBeChecked();
    expect(screen.getByTestId('install-submit')).toBeDisabled();
    fireEvent.click(eula);
    fireEvent.click(screen.getByTestId('install-submit'));
    await waitFor(() => {
      expect(created).toEqual(['srv-new']);
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/machines/m1/install');
    expect(post?.body).toMatchObject({
      directoryId: 'dir1',
      folderName: 'survie',
      loader: 'vanilla',
      mcVersion: '1.20.1',
      acceptEula: true,
    });
  });

  it('changer de chargeur relit le catalogue et oublie la version choisie', async () => {
    const { calls } = renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
    fireEvent.click(screen.getByTestId('install-next'));
    const version = await screen.findByTestId('install-version');
    await waitFor(() => {
      expect(version.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    fireEvent.change(version, { target: { value: '1.19.4' } });
    fireEvent.click(screen.getByLabelText('Fabric'));
    await waitFor(() => {
      expect(calls.some((c) => c.path.includes('loader=fabric'))).toBe(true);
    });
    // La version choisie pour vanilla est oubliée (Fabric ne la supporte pas forcément) : c'est la
    // dernière stable de SON catalogue qui est reprise, avec la version du chargeur annoncée.
    await waitFor(() => {
      expect(screen.getByTestId('install-version')).toHaveValue('1.21.1');
    });
    expect(screen.getByTestId('install-loader-version')).toHaveTextContent('Fabric 0.16.5');
  });

  it('la dernière stable est présélectionnée, les versions de test masquées sauf demande', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
    fireEvent.click(screen.getByTestId('install-next'));
    const version = await screen.findByTestId('install-version');
    // Une pré-version arrive en tête du catalogue : elle n'est ni choisie ni proposée.
    await waitFor(() => {
      expect(version).toHaveValue('1.20.1');
    });
    const ids = () => [...version.querySelectorAll('option')].map((o) => o.value);
    expect(ids()).not.toContain('1.20.2-pre1');
    fireEvent.click(screen.getByTestId('install-show-unstable'));
    await waitFor(() => {
      expect(ids()).toContain('1.20.2-pre1');
    });
    expect(version).toHaveValue('1.20.1');
  });

  it('la mémoire proposée suit le chargeur tant qu’on n’y a pas touché', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'survie' } });
    fireEvent.click(screen.getByTestId('install-next'));
    await screen.findByTestId('install-version');
    fireEvent.click(screen.getByLabelText('NeoForge'));
    // Le catalogue NeoForge arrive et sa dernière stable est reprise avant d'avancer.
    await waitFor(() => {
      expect(screen.getByTestId('install-version')).toHaveValue('1.20.1');
    });
    fireEvent.click(screen.getByTestId('install-next'));
    const ram = await screen.findByTestId('install-ram');
    expect(ram).toHaveValue(String(DEFAULT_RAM_MB.neoforge));
  });

  it('un Java manquant se règle depuis l’assistant, sans en sortir', async () => {
    const { calls } = renderModal({ javaMissing: true });
    await walkToReview();
    const card = await screen.findByTestId('install-java-missing');
    expect(card).toHaveTextContent('Java 17 n’est pas installé sur cette machine');
    // Java a sa carte : il ne double pas dans la liste des autres problèmes.
    expect(screen.getByTestId('install-precheck-problems')).not.toHaveTextContent('Java');
    fireEvent.click(screen.getByTestId('install-java-button'));
    await waitFor(() => {
      expect(
        calls.find((c) => c.method === 'POST' && c.path === '/api/machines/m1/java/install')?.body,
      ).toEqual({ majorVersion: 17, relay: false });
    });
  });

  it('un opérateur voit le Java manquant mais n’a pas de bouton pour l’installer', async () => {
    renderModal({ javaMissing: true, role: 'operator' });
    await walkToReview();
    expect(await screen.findByTestId('install-java-missing')).toHaveTextContent(
      'Un administrateur peut l’installer',
    );
    expect(screen.queryByTestId('install-java-button')).not.toBeInTheDocument();
  });
});

describe('CreateServerModal — modpacks FTB et services tiers', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const toLoaderStep = async () => {
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'evolution' } });
    fireEvent.click(screen.getByTestId('install-next'));
    await screen.findByTestId('install-loader');
  };

  it('l’option « Modpack FTB » n’existe que si l’intégration est activée', async () => {
    renderModal({ ftb: false });
    await toLoaderStep();
    await screen.findByTestId('install-version');
    expect(screen.queryByLabelText('Modpack FTB')).not.toBeInTheDocument();
  });

  it('choisir un pack, puis une version installable : le pack part avec la création', async () => {
    const { calls, created } = renderModal({ ftb: true });
    await toLoaderStep();
    fireEvent.click(await screen.findByLabelText('Modpack FTB'));
    const packSelect = await screen.findByTestId('ftb-pack');
    await waitFor(() => {
      expect(packSelect.querySelectorAll('option').length).toBe(2);
    });
    // Aucune recherche à chaque frappe : seul le bouton interroge le panel.
    const searches = () => calls.filter((c) => c.path.startsWith('/api/install/modpacks/ftb?'));
    const before = searches().length;
    fireEvent.change(screen.getByTestId('ftb-search'), { target: { value: 'evo' } });
    fireEvent.change(screen.getByTestId('ftb-search'), { target: { value: 'evol' } });
    expect(searches().length).toBe(before);
    // Sans pack choisi, on n'avance pas.
    fireEvent.click(screen.getByTestId('install-next'));
    expect(screen.getByTestId('ftb-pack')).toBeInTheDocument();
    fireEvent.change(packSelect, { target: { value: '125' } });
    const versionSelect = await screen.findByTestId('ftb-version');
    await waitFor(() => {
      expect(versionSelect.querySelectorAll('option').length).toBe(3);
    });
    // Une version sans chargeur installable est montrée, mais inchoisissable.
    expect(versionSelect.querySelector('option[value="7"]')).toBeDisabled();
    fireEvent.change(versionSelect, { target: { value: '100487' } });
    fireEvent.click(screen.getByTestId('install-next'));
    fireEvent.click(await screen.findByTestId('install-next'));
    fireEvent.click(await screen.findByTestId('install-eula'));
    fireEvent.click(screen.getByTestId('install-submit'));
    await waitFor(() => {
      expect(created).toEqual(['srv-new']);
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/machines/m1/install');
    expect(post?.body).toMatchObject({
      folderName: 'evolution',
      modpack: { provider: 'ftb', packId: 125, versionId: 100487 },
    });
  });
});

describe('CreateServerModal — serveur depuis une archive', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const toArchiveMode = async () => {
    fireEvent.change(screen.getByTestId('install-folder'), { target: { value: 'atm10' } });
    fireEvent.click(screen.getByTestId('install-next'));
    await screen.findByTestId('install-loader');
    fireEvent.click(await screen.findByLabelText('Archive (.zip)'));
    return screen.findByTestId('archive-select');
  };
  const archiveCalls = (calls: Call[]) => calls.filter((c) => c.path.includes('/install/archives'));

  it('sans zip : dit où le poser, n’avance pas, et ne relit la liste qu’au bouton', async () => {
    const { calls } = renderModal({ archives: [] });
    const select = await toArchiveMode();
    await waitFor(() => {
      expect(select).not.toBeDisabled();
    });
    expect(screen.getByTestId('archive-directories')).toHaveTextContent('/srv/minecraft');
    expect(select).toHaveTextContent('Aucun zip dans ces dossiers');
    // Hors du mode archive, la liste n'est jamais demandée ; dedans, une seule fois.
    expect(archiveCalls(calls)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('install-next'));
    expect(
      await screen.findByText('Choisissez une archive dont le chargeur est reconnu.'),
    ).toBeVisible();
    expect(screen.getByTestId('archive-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('archive-refresh'));
    await waitFor(() => {
      expect(archiveCalls(calls)).toHaveLength(2);
    });
  });

  it('choisir un zip : chargeur lu affiché, mémoire proposée, archive envoyée à la création', async () => {
    const { calls, created } = renderModal({ archives: ['ATM10AERO-0.7.1-server.zip'] });
    const select = await toArchiveMode();
    await waitFor(() => {
      expect(select.querySelectorAll('option').length).toBe(2);
    });
    expect(screen.queryByTestId('archive-summary')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: '/srv/minecraft/ATM10AERO-0.7.1-server.zip' } });
    const recognized = await screen.findByTestId('archive-recognized');
    expect(recognized).toHaveTextContent(
      'Le panel installera NeoForge 21.1.250 pour Minecraft 1.21.1 (lu dans startserver.sh).',
    );
    expect(screen.getByTestId('archive-properties')).toHaveTextContent('allow-flight=true');
    expect(screen.queryByTestId('archive-unrecognized')).not.toBeInTheDocument();
    // Le catalogue des versions n'est pas demandé pour NeoForge : l'archive dit tout.
    expect(calls.filter((c) => c.path.includes('catalog?loader=neoforge'))).toHaveLength(0);
    fireEvent.click(screen.getByTestId('install-next'));
    expect(await screen.findByTestId('install-ram')).toHaveValue('8192');
    fireEvent.click(screen.getByTestId('install-next'));
    fireEvent.click(await screen.findByTestId('install-eula'));
    expect(screen.getByText(/ATM10AERO-0\.7\.1-server\.zip — NeoForge 1\.21\.1/)).toBeVisible();
    fireEvent.click(screen.getByTestId('install-submit'));
    await waitFor(() => {
      expect(created).toEqual(['srv-new']);
    });
    const pre = calls.find((c) => c.path.endsWith('/install/precheck'));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/machines/m1/install');
    for (const call of [pre, post]) {
      expect(call?.body).toMatchObject({
        folderName: 'atm10',
        loader: 'neoforge',
        mcVersion: '1.21.1',
        maxRamMb: 8192,
        archive: { path: '/srv/minecraft/ATM10AERO-0.7.1-server.zip' },
      });
    }
  });

  it('chargeur non reconnu : l’assistant le dit et n’avance pas', async () => {
    renderModal({ archives: ['inconnu.zip'], archiveRecognized: false });
    const select = await toArchiveMode();
    await waitFor(() => {
      expect(select.querySelectorAll('option').length).toBe(2);
    });
    fireEvent.change(select, { target: { value: '/srv/minecraft/inconnu.zip' } });
    expect(await screen.findByTestId('archive-unrecognized')).toBeVisible();
    expect(screen.queryByTestId('archive-recognized')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('install-next'));
    expect(screen.getByTestId('archive-picker')).toBeInTheDocument();
    expect(screen.queryByTestId('install-ram')).not.toBeInTheDocument();
  });

  it('revenir à un chargeur nu : plus d’archive dans la requête', async () => {
    const { calls } = renderModal({ archives: ['ATM10AERO-0.7.1-server.zip'] });
    const select = await toArchiveMode();
    await waitFor(() => {
      expect(select.querySelectorAll('option').length).toBe(2);
    });
    fireEvent.change(select, { target: { value: '/srv/minecraft/ATM10AERO-0.7.1-server.zip' } });
    await screen.findByTestId('archive-recognized');
    fireEvent.click(screen.getByLabelText('Vanilla'));
    const version = await screen.findByTestId('install-version');
    await waitFor(() => {
      expect(version).toHaveValue('1.20.1');
    });
    expect(screen.queryByTestId('archive-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('install-next'));
    fireEvent.click(await screen.findByTestId('install-next'));
    await screen.findByTestId('install-eula');
    const pre = calls.find((c) => c.path.endsWith('/install/precheck'));
    expect(pre?.body).toMatchObject({ loader: 'vanilla', mcVersion: '1.20.1' });
    expect(pre?.body).not.toHaveProperty('archive');
  });
});

describe('groupVersions', () => {
  const v = (id: string, stable = true) => ({ id, stable });

  it('groupe par série dans l’ordre reçu, numérotation par année comprise', () => {
    const groups = groupVersions([v('26.1'), v('1.21.4'), v('1.21'), v('1.20.1')], false);
    expect(groups.map((g) => [g.series, g.items.map((i) => i.id)])).toEqual([
      ['26', ['26.1']],
      ['1.21', ['1.21.4', '1.21']],
      ['1.20', ['1.20.1']],
    ]);
  });

  it('les versions de test ne viennent que sur demande, dans un groupe à part en fin de liste', () => {
    const input = [v('24w14a', false), v('1.21'), v('b1.7.3', false)];
    expect(groupVersions(input, false)).toEqual([{ series: '1.21', items: [v('1.21')] }]);
    expect(groupVersions(input, true).at(-1)).toEqual({
      series: undefined,
      items: [v('24w14a', false), v('b1.7.3', false)],
    });
  });
});
