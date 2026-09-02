/**
 * Lot 9 — vie privée : les deux interrupteurs (`privacy.mojangLookup`, `privacy.externalAvatars`)
 * sont validés, poussés à l'agent (`agent.configure.mojangLookup`) et exposés au navigateur
 * (`/api/auth/me.privacy`) pour tout utilisateur connecté.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestPanel, createUser, setupAdmin, type TestPanel } from '../test/helpers.js';

describe('vie privée : réglages, config d’agent, /api/auth/me', () => {
  let panel: TestPanel;
  let admin: string;

  beforeEach(async () => {
    panel = await createTestPanel();
    admin = await setupAdmin(panel);
  });
  afterEach(async () => {
    await panel.close();
  });

  const patch = (body: Record<string, string>) =>
    panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: body,
      headers: { cookie: admin },
    });

  it('n’accepte que true/false, et le défaut est « activé »', async () => {
    const settings = (
      await panel.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: admin } })
    ).json<{ settings: Record<string, string> }>().settings;
    expect(settings['privacy.mojangLookup']).toBe('true');
    expect(settings['privacy.externalAvatars']).toBe('true');
    for (const bad of ['yes', '1', '', 'FALSE']) {
      const res = await patch({ 'privacy.mojangLookup': bad });
      expect(res.statusCode, `valeur « ${bad} »`).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('E_VALIDATION');
    }
    expect((await patch({ 'privacy.mojangLookup': 'false' })).statusCode).toBe(200);
    expect(panel.ctx.settings.getBool('privacy.mojangLookup')).toBe(false);
  });

  it('la résolution Mojang est poussée à l’agent dans agent.configure', async () => {
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
      headers: { cookie: admin },
    });
    const { machine } = res.json<{ machine: { id: string } }>();
    expect(panel.ctx.servers.buildAgentConfig(machine.id).mojangLookup).toBe(true);
    await patch({ 'privacy.mojangLookup': 'false' });
    expect(panel.ctx.servers.buildAgentConfig(machine.id).mojangLookup).toBe(false);
  });

  it('/api/auth/me expose privacy.externalAvatars à tout utilisateur, pas seulement aux admins', async () => {
    const viewer = await createUser(panel, admin, {
      username: 'viewer',
      password: 'viewer-pass',
      role: 'viewer',
    });
    const me = (cookie: string) =>
      panel.app
        .inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
        .then((r) => r.json<{ privacy: { externalAvatars: boolean } }>().privacy);
    expect(await me(viewer)).toEqual({ externalAvatars: true });
    await patch({ 'privacy.externalAvatars': 'false' });
    expect(await me(viewer)).toEqual({ externalAvatars: false });
    expect(await me(admin)).toEqual({ externalAvatars: false });
  });
});
