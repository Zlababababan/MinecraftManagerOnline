/** Front servi par le panel : fichiers statiques, cache, fallback SPA hors /api et /ws. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestPanel, setupAdmin, tmpDir, type TestPanel } from '../test/helpers.js';
import { isApiOrWs, wantsSpaFallback } from './static.js';

describe('static (front buildé)', () => {
  let panel: TestPanel;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await tmpDir('mmo-web-');
    cleanup = t.cleanup;
    await mkdir(path.join(t.dir, 'assets'), { recursive: true });
    await writeFile(path.join(t.dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(path.join(t.dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    await writeFile(path.join(t.dir, 'sw.js'), '// sw');
    await writeFile(path.join(t.dir, 'manifest.webmanifest'), '{}');
    panel = await createTestPanel({ config: { webDir: t.dir } });
  });
  afterEach(async () => {
    await panel.close();
    await cleanup();
  });

  it('sert index.html, les assets immuables, sw.js sans cache', async () => {
    let res = await panel.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('id="root"');
    res = await panel.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    res = await panel.app.inject({ method: 'GET', url: '/sw.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    res = await panel.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('fallback SPA pour les navigations, 404 JSON pour /api et les assets manquants', async () => {
    let res = await panel.app.inject({
      method: 'GET',
      url: '/servers/01ABC?tab=console',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
    // /api reste « refus par défaut » : jamais de fallback HTML, même pour une route inconnue.
    res = await panel.app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('E_AUTH');
    const cookie = await setupAdmin(panel);
    res = await panel.app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { accept: 'text/html', cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('E_NOT_FOUND');
    res = await panel.app.inject({
      method: 'GET',
      url: '/assets/missing.js',
      headers: { accept: 'application/javascript' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('E_NOT_FOUND');
    res = await panel.app.inject({
      method: 'POST',
      url: '/servers/x',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    // Les routes API restent prioritaires sur le wildcard statique.
    res = await panel.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('sans dossier web : aucun fallback', async () => {
    const bare = await createTestPanel({ config: { webDir: undefined } });
    const res = await bare.app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('E_NOT_FOUND');
    await bare.close();
  });

  it('helpers', () => {
    expect(isApiOrWs('/api')).toBe(true);
    expect(isApiOrWs('/ws/client')).toBe(true);
    expect(isApiOrWs('/apix')).toBe(false);
    expect(wantsSpaFallback({ method: 'GET', url: '/x', headers: { accept: 'text/html' } })).toBe(
      true,
    );
    expect(
      wantsSpaFallback({ method: 'GET', url: '/api/x', headers: { accept: 'text/html' } }),
    ).toBe(false);
    expect(
      wantsSpaFallback({ method: 'GET', url: '/x', headers: { accept: 'application/json' } }),
    ).toBe(false);
  });
});
