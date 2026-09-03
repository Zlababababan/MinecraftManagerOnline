/**
 * Lot 8 — voir et révoquer ses sessions : liste des sessions vivantes avec « cet appareil »,
 * révocation d'une session (son cookie meurt, SON WebSocket se ferme en 4001, les autres restent),
 * révocation de la session courante (cookie effacé), « tout sauf cet appareil », la session d'un
 * autre compte n'existe pas (404), déconnexion d'un compte par un admin (toutes ses sessions, tous
 * ses sockets), audit. Une clé d'API n'atteint aucune de ces routes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionDto } from '@mmo/protocol/client';

import {
  connectClient,
  createTestPanel,
  createUser,
  login,
  setupAdmin,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

describe('lot 8 — sessions', () => {
  let panel: TestPanel;
  let admin: string;
  let phone: string;
  let laptop: string;
  let opId: string;

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    auth: { cookie?: string; bearer?: string },
    payload?: unknown,
  ) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: {
        ...(auth.cookie === undefined ? {} : { cookie: auth.cookie }),
        ...(auth.bearer === undefined ? {} : { authorization: `Bearer ${auth.bearer}` }),
        'user-agent': auth.cookie === phone ? 'Mozilla/5.0 (iPhone) Safari' : 'Mozilla/5.0 Firefox',
      },
    });

  async function sessionsOf(cookie: string): Promise<SessionDto[]> {
    const res = await api('GET', '/api/auth/sessions', { cookie });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ sessions: SessionDto[] }>().sessions;
  }

  beforeEach(async () => {
    panel = await createTestPanel();
    admin = await setupAdmin(panel);
    phone = await createUser(panel, admin, {
      username: 'op',
      password: 'correct horse battery',
      role: 'operator',
    });
    opId = panel.ctx.users.findByUsername('op')!.id;
    panel.clock.advance(60_000);
    laptop = await login(panel, 'op', 'correct horse battery');
    await panel.listen();
  });

  afterEach(async () => {
    await panel.close();
  });

  it('liste ses sessions avec « cet appareil », révoque une autre (cookie mort, socket fermé), puis la sienne', async () => {
    const fromLaptop = await sessionsOf(laptop);
    expect(fromLaptop).toHaveLength(2);
    expect(fromLaptop.map((s) => s.current)).toEqual([true, false]);
    const fromPhone = await sessionsOf(phone);
    expect(fromPhone.find((s) => s.current)?.id).toBe(fromLaptop[1]!.id);
    // Les sessions d'un autre compte n'apparaissent pas.
    expect((await sessionsOf(admin)).map((s) => s.current)).toEqual([true]);

    // Le téléphone a un socket ouvert ; le portable révoque la session du téléphone.
    const phoneWs = await connectClient(panel.wsUrl, phone);
    const laptopWs = await connectClient(panel.wsUrl, laptop);
    const closed = new Promise<number>((resolve) => {
      phoneWs.ws.once('close', (code) => {
        resolve(code);
      });
    });
    const phoneId = fromLaptop[1]!.id;
    expect(
      (await api('DELETE', `/api/auth/sessions/${String(phoneId)}`, { cookie: laptop })).statusCode,
    ).toBe(204);
    expect(await closed).toBe(4001);
    expect(laptopWs.ws.readyState).toBe(laptopWs.ws.OPEN);
    expect((await api('GET', '/api/auth/me', { cookie: phone })).statusCode).toBe(401);
    expect((await api('GET', '/api/auth/me', { cookie: laptop })).statusCode).toBe(200);
    expect((await sessionsOf(laptop)).map((s) => s.current)).toEqual([true]);
    const audit = panel.ctx.audit.list(10).find((e) => e.action === 'auth.sessionRevoked');
    expect(audit?.username).toBe('op');
    expect(audit?.targetId).toBe(String(phoneId));

    // Révoquer une session déjà partie, ou celle d'un autre compte : introuvable.
    expect(
      (await api('DELETE', `/api/auth/sessions/${String(phoneId)}`, { cookie: laptop })).statusCode,
    ).toBe(404);
    const adminSession = (await sessionsOf(admin))[0]!.id;
    expect(
      (await api('DELETE', `/api/auth/sessions/${String(adminSession)}`, { cookie: laptop }))
        .statusCode,
    ).toBe(404);
    expect((await api('GET', '/api/auth/me', { cookie: admin })).statusCode).toBe(200);

    // Révoquer la session courante = se déconnecter : cookie effacé, 401 ensuite.
    const mine = (await sessionsOf(laptop))[0]!.id;
    const res = await api('DELETE', `/api/auth/sessions/${String(mine)}`, { cookie: laptop });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/mmo_session=;/);
    expect((await api('GET', '/api/auth/me', { cookie: laptop })).statusCode).toBe(401);
    laptopWs.close();
  });

  it('« tout sauf cet appareil » garde la session courante ; un admin déconnecte un compte partout', async () => {
    const tablet = await login(panel, 'op', 'correct horse battery');
    const phoneWs = await connectClient(panel.wsUrl, phone);
    const tabletWs = await connectClient(panel.wsUrl, tablet);
    const laptopWs = await connectClient(panel.wsUrl, laptop);
    const closedCodes: number[] = [];
    for (const c of [phoneWs, tabletWs]) {
      c.ws.on('close', (code) => {
        closedCodes.push(code);
      });
    }
    const res = await api('DELETE', '/api/auth/sessions', { cookie: laptop });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ revoked: number }>().revoked).toBe(2);
    await waitFor(() => closedCodes.length === 2, 5_000);
    expect(closedCodes).toEqual([4001, 4001]);
    expect(laptopWs.ws.readyState).toBe(laptopWs.ws.OPEN);
    expect((await api('GET', '/api/auth/me', { cookie: phone })).statusCode).toBe(401);
    expect((await api('GET', '/api/auth/me', { cookie: tablet })).statusCode).toBe(401);
    expect((await sessionsOf(laptop)).map((s) => s.current)).toEqual([true]);
    expect(
      panel.ctx.audit.list(10).find((e) => e.action === 'auth.sessionsRevoked')?.details,
    ).toMatchObject({ count: 2 });

    // Admin : déconnecter « op » de partout (opérateur → 403, admin → 204 + audit).
    const again = await login(panel, 'op', 'correct horse battery');
    expect((await api('DELETE', `/api/users/${opId}/sessions`, { cookie: again })).statusCode).toBe(
      403,
    );
    const laptopClosed = new Promise<number>((resolve) => {
      laptopWs.ws.once('close', (code) => {
        resolve(code);
      });
    });
    expect((await api('DELETE', `/api/users/${opId}/sessions`, { cookie: admin })).statusCode).toBe(
      204,
    );
    expect(await laptopClosed).toBe(4001);
    expect((await api('GET', '/api/auth/me', { cookie: laptop })).statusCode).toBe(401);
    expect((await api('GET', '/api/auth/me', { cookie: again })).statusCode).toBe(401);
    const audit = panel.ctx.audit.list(10).find((e) => e.action === 'user.sessionsRevoked');
    expect(audit?.username).toBe('admin');
    expect(audit?.targetLabel).toBe('op');
    expect((await api('DELETE', `/api/users/nope/sessions`, { cookie: admin })).statusCode).toBe(
      404,
    );
  });

  it('une clé d’API ne voit ni ne révoque de session', async () => {
    const created = await api('POST', '/api/api-keys', { cookie: laptop }, { name: 'k' });
    expect(created.statusCode).toBe(201);
    const token = created.json<{ token: string }>().token;
    for (const [method, url] of [
      ['GET', '/api/auth/sessions'],
      ['DELETE', '/api/auth/sessions'],
      ['DELETE', '/api/auth/sessions/1'],
    ] as const) {
      const res = await api(method, url, { bearer: token });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await sessionsOf(laptop)).length).toBe(2);
  });
});
