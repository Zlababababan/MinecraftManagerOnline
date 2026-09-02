/**
 * Lot 4 — carte « Sauvegardes du panel » : avertissement sur les secrets (toujours visible),
 * dernière erreur automatique en rouge, contenu de chaque archive, téléchargement par fetch
 * (le fichier arrive en blob et un lien de téléchargement est cliqué — pas d'onglet JSON en cas
 * d'erreur), commande de restauration sur l'archive la plus récente.
 */
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PanelBackupDto } from '@mmo/protocol/client';

import { i18n } from '../../i18n/index.js';
import { PanelBackupsCard } from './PanelBackupsCard.js';

const archive: PanelBackupDto = {
  file: 'mmo-panel-2026-09-02T04-00-00.tar.gz',
  format: 'archive',
  sizeBytes: 2_500_000,
  createdAt: 1_788_321_600_000,
};
const legacy: PanelBackupDto = {
  file: 'mmo-2026-08-23T01-00-00.db',
  format: 'db',
  sizeBytes: 1_900_000,
  createdAt: 1_787_446_800_000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(paths: string[], lastError: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      paths.push(path);
      await Promise.resolve();
      if (path === '/api/admin/backups') {
        return json(200, {
          backups: [archive, legacy],
          directory: 'D:\\mmo\\data\\backups\\panel',
          status: { lastSuccessAt: archive.createdAt, lastError, lastAttemptAt: null },
        });
      }
      if (path.endsWith('/download')) {
        return new Response(new Blob(['octets']), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${archive.file}"`,
          },
        });
      }
      return json(404, { code: 'E_NOT_FOUND', message: path });
    }),
  );
}

function renderCard(): void {
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PanelBackupsCard />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('PanelBackupsCard', () => {
  let paths: string[];
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
    paths = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('avertit sur les secrets, décrit le contenu de chaque copie, propose la restauration de la plus récente', async () => {
    installFetch(paths, null);
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId(`panel-backup-${archive.file}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId('panel-backup-secrets-warning')).toHaveTextContent(
      'secrets du panel',
    );
    expect(screen.queryByTestId('panel-backup-last-error')).not.toBeInTheDocument();
    expect(screen.getByTestId(`panel-backup-${archive.file}`)).toHaveTextContent('base + TLS');
    expect(screen.getByTestId(`panel-backup-${legacy.file}`)).toHaveTextContent('ancien format');
    expect(screen.getByTestId('panel-backups-card')).toHaveTextContent(
      `mmo-panel restore ${archive.file}`,
    );
  });

  it('affiche en rouge l’échec de la dernière sauvegarde automatique', async () => {
    installFetch(paths, 'ENOSPC: no space left on device');
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('panel-backup-last-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('panel-backup-last-error')).toHaveTextContent('ENOSPC');
  });

  it('télécharge une archive par fetch et clique un lien nommé comme le fichier', async () => {
    installFetch(paths, null);
    const createObjectURL = vi.fn(() => 'blob:mmo');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId(`panel-backup-download-${archive.file}`)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId(`panel-backup-download-${archive.file}`));
    await waitFor(() => {
      expect(clicked).toEqual([archive.file]);
    });
    expect(paths).toContain(`/api/admin/backups/${encodeURIComponent(archive.file)}/download`);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mmo');
    click.mockRestore();
  });
});
