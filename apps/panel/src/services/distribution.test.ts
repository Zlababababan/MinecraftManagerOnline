/**
 * Phase 11 : distribution servie par le panel — scripts d'installation (URL injectée), manifeste
 * et archives (`/api/dist`, `/dist/<fichier>`), dépôt admin avec vérification sha256, publication
 * automatique du bundle comme release d'agent, suppression.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestPanel, setupAdmin, tmpDir, type TestPanel } from '../test/helpers.js';

function sha(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('distribution (phase 11)', () => {
  let panel: TestPanel;
  let cleanup: () => Promise<void>;
  let cookie: string;
  let dataDir: string;

  beforeEach(async () => {
    const t = await tmpDir('mmo-dist-');
    cleanup = t.cleanup;
    dataDir = t.dir;
    panel = await createTestPanel({ config: { dataDir: t.dir, webDir: undefined } });
    cookie = await setupAdmin(panel);
  });
  afterEach(async () => {
    await panel.close();
    await cleanup();
  });

  it('scripts d’installation servis publiquement avec l’URL du panel injectée', async () => {
    let res = await panel.app.inject({
      method: 'GET',
      url: '/install.sh',
      headers: { host: 'panel.example:3000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('PANEL="http://panel.example:3000"');
    expect(res.body).toContain('KillMode=process');
    expect(res.body).toContain('AbandonProcessGroup');
    // Derrière tailscale serve : x-forwarded-proto/host priment ; panel.publicUrl prime sur tout.
    res = await panel.app.inject({
      method: 'GET',
      url: '/install.ps1',
      headers: {
        host: '127.0.0.1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'mmo.tailnet.ts.net',
      },
    });
    expect(res.body).toContain("[string]$Panel = 'https://mmo.tailnet.ts.net'");
    await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { 'panel.publicUrl': 'https://panel.public/' },
    });
    res = await panel.app.inject({ method: 'GET', url: '/install.sh' });
    expect(res.body).toContain('PANEL="https://panel.public"');
    expect(res.body).not.toContain('__PANEL_URL__');
  });

  it('manifeste déposé à la main (archive du panel) : release d’agent publiée au démarrage', async () => {
    const bundle = Buffer.from('// bundle 0.11.0');
    const dist = path.join(dataDir, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'agent-0.11.0.js'), bundle);
    await writeFile(
      path.join(dist, 'manifest.json'),
      JSON.stringify({
        version: '0.11.0',
        protocolVersion: 1,
        runtimeVersion: '24.19.0',
        bundle: {
          file: 'agent-0.11.0.js',
          sha256: sha(bundle),
          size: bundle.length,
          signature: 'c2ln',
        },
        platforms: {},
      }),
    );
    await panel.close();
    panel = await createTestPanel({ config: { dataDir, webDir: undefined } });
    const res = await panel.app.inject({ method: 'GET', url: '/api/dist' });
    expect(res.json()).toMatchObject({
      available: false,
      version: '0.11.0',
      releasePublished: true,
    });
    expect(panel.ctx.releases.latest()?.version).toBe('0.11.0');
    expect(await panel.ctx.distribution.syncRelease()).toBe(false);
  });

  it('sans distribution : /api/dist vide, plateforme et fichier introuvables', async () => {
    let res = await panel.app.inject({ method: 'GET', url: '/api/dist' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      available: false,
      version: null,
      platforms: {},
      install: null,
    });
    res = await panel.app.inject({ method: 'GET', url: '/api/dist/linux-x64' });
    expect(res.statusCode).toBe(404);
    res = await panel.app.inject({ method: 'GET', url: '/dist/mmo-agent-1.0.0-linux-x64.tar.gz' });
    expect(res.statusCode).toBe(404);
  });

  it('dépôt admin : fichiers + manifeste vérifiés, release d’agent publiée, service public', async () => {
    const bundle = Buffer.from('// bundle agent 0.11.0\nconsole.log(1);\n');
    const archive = Buffer.from('tar.gz factice '.repeat(100));
    const put = (file: string, body: Buffer) =>
      panel.app.inject({
        method: 'PUT',
        url: `/api/admin/dist/files/${file}`,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: body,
      });
    // Non admin → refusé ; nom invalide → 400.
    let res = await panel.app.inject({
      method: 'PUT',
      url: '/api/admin/dist/files/agent-0.11.0.js',
      headers: { 'content-type': 'application/octet-stream' },
      payload: bundle,
    });
    expect(res.statusCode).toBe(401);
    res = await put('..%2Fevil.js', bundle);
    expect([400, 404]).toContain(res.statusCode);

    res = await put('agent-0.11.0.js', bundle);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      file: 'agent-0.11.0.js',
      sha256: sha(bundle),
      size: bundle.length,
    });
    res = await put('mmo-agent-0.11.0-linux-x64.tar.gz', archive);
    expect(res.statusCode).toBe(201);

    const manifest = {
      version: '0.11.0',
      protocolVersion: 1,
      runtimeVersion: '24.19.0',
      builtAt: 0,
      signingKey: 'dev',
      bundle: {
        file: 'agent-0.11.0.js',
        sha256: sha(bundle),
        size: bundle.length,
        signature: 'c2ln',
      },
      platforms: {
        'linux-x64': {
          file: 'mmo-agent-0.11.0-linux-x64.tar.gz',
          sha256: sha(archive),
          size: archive.length,
        },
      },
    };
    // sha256 faux → E_CHECKSUM_MISMATCH ; fichier manquant → E_VALIDATION.
    res = await panel.app.inject({
      method: 'PUT',
      url: '/api/admin/dist/manifest',
      headers: { cookie },
      payload: { ...manifest, bundle: { ...manifest.bundle, sha256: 'a'.repeat(64) } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ code: string }>().code).toBe('E_CHECKSUM_MISMATCH');
    res = await panel.app.inject({
      method: 'PUT',
      url: '/api/admin/dist/manifest',
      headers: { cookie },
      payload: {
        ...manifest,
        platforms: {
          ...manifest.platforms,
          'win-x64': { file: 'absent.zip', sha256: sha(archive), size: 1 },
        },
      },
    });
    expect(res.statusCode).toBe(400);

    res = await panel.app.inject({
      method: 'PUT',
      url: '/api/admin/dist/manifest',
      headers: { cookie },
      payload: manifest,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      available: true,
      version: '0.11.0',
      runtimeVersion: '24.19.0',
      releasePublished: true,
      platforms: { 'linux-x64': { url: '/dist/mmo-agent-0.11.0-linux-x64.tar.gz' } },
    });
    // La release d'agent a été créée avec la signature du manifeste.
    res = await panel.app.inject({
      method: 'GET',
      url: '/api/agent-releases',
      headers: { cookie },
    });
    expect(res.json<{ latest: string }>().latest).toBe('0.11.0');
    expect(res.json<{ releases: unknown[] }>().releases[0]).toMatchObject({
      version: '0.11.0',
      sha256: sha(bundle),
      signature: 'c2ln',
    });

    // Lecture publique : plateforme (JSON plat lu par install.sh) et téléchargement avec en-têtes.
    res = await panel.app.inject({ method: 'GET', url: '/api/dist/linux-x64' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      platform: 'linux-x64',
      version: '0.11.0',
      runtimeVersion: '24.19.0',
      file: 'mmo-agent-0.11.0-linux-x64.tar.gz',
      sha256: sha(archive),
      size: archive.length,
      url: '/dist/mmo-agent-0.11.0-linux-x64.tar.gz',
    });
    res = await panel.app.inject({ method: 'GET', url: '/dist/mmo-agent-0.11.0-linux-x64.tar.gz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(archive.length));
    expect(res.headers['x-sha256']).toBe(sha(archive));
    expect(res.rawPayload.equals(archive)).toBe(true);
    // Le bundle est servi aussi (manifeste) ; un fichier présent sur disque mais non listé ne l'est pas.
    res = await panel.app.inject({ method: 'GET', url: '/dist/agent-0.11.0.js' });
    expect(res.statusCode).toBe(200);
    res = await panel.app.inject({ method: 'GET', url: '/dist/manifest.json' });
    expect(res.statusCode).toBe(404);
    expect(await readFile(`${dataDir}/dist/manifest.json`, 'utf8')).toContain(
      '"version": "0.11.0"',
    );

    // One-liners génériques quand publicUrl est réglée.
    await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { 'panel.publicUrl': 'https://panel.public' },
    });
    res = await panel.app.inject({ method: 'GET', url: '/api/dist' });
    expect(res.json<{ install: unknown }>().install).toEqual({
      windows: '& ([scriptblock]::Create((irm https://panel.public/install.ps1)))',
      unix: 'curl -fsSL https://panel.public/install.sh | sh',
    });

    // Suppression : fichiers et manifeste retirés, la release d'agent reste.
    res = await panel.app.inject({ method: 'DELETE', url: '/api/admin/dist', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await panel.app.inject({ method: 'GET', url: '/api/dist' });
    expect(res.json<{ available: boolean }>().available).toBe(false);
    res = await panel.app.inject({ method: 'GET', url: '/dist/mmo-agent-0.11.0-linux-x64.tar.gz' });
    expect(res.statusCode).toBe(404);
    res = await panel.app.inject({
      method: 'GET',
      url: '/api/agent-releases',
      headers: { cookie },
    });
    expect(res.json<{ latest: string }>().latest).toBe('0.11.0');
  });
});
