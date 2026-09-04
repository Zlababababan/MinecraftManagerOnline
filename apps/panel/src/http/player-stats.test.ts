/**
 * Lot 8 — la route des statistiques de fréquentation, sur de vraies sessions écrites par le
 * chemin normal (`player.joined` / `player.left`). Ce qu'elle protège : le calcul se fait dans le
 * fuseau DU PANEL (pas celui du processus), la fenêtre commence à minuit, une session encore
 * ouverte compte jusqu'à maintenant, et un lecteur y a droit sans rien pouvoir changer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ulid } from '@mmo/protocol';
import type { PlayerStatsDto } from '@mmo/protocol/client';

import { SETTING_KEYS } from '../services/settings.js';
import { createTestPanel, createUser, login, setupAdmin, type TestPanel } from '../test/helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Mercredi 15 juillet 2026, 12 h à Paris. */
const NOW = Date.UTC(2026, 6, 15, 10, 0);

function detected(path: string, name: string, gamePort: number) {
  return {
    path,
    name,
    loader: { value: 'vanilla' as const, confidence: 'high' as const, source: 'jar_name' },
    mcVersion: { value: '1.20.1', confidence: 'high' as const, source: 'jar_manifest' },
    maxRamMb: { value: 2048, confidence: 'medium' as const, source: 'run_script' },
    gamePort,
    eulaAccepted: true,
    launch: { kind: 'jar' as const, jar: 'server.jar' },
    javaRequirement: { majorVersion: 17, strict: false, source: 'table' as const },
    confidence: 'high' as const,
    evidence: [],
  };
}

describe('lot 8 — statistiques de fréquentation', () => {
  let panel: TestPanel;
  let admin: string;
  let machineId: string;
  let serverId: string;
  let online = 0;

  const api = (url: string, cookie = admin) =>
    panel.app.inject({ method: 'GET', url, headers: { cookie } });

  async function statsOf(query = ''): Promise<PlayerStatsDto> {
    const res = await api(`/api/servers/${serverId}/players/stats${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ stats: PlayerStatsDto }>().stats;
  }

  /** Une visite écrite par le chemin normal : l'agent annonce l'arrivée puis le départ. */
  function visit(name: string, at: number, durationMs: number | null): void {
    online += 1;
    panel.ctx.servers.applyPlayerEvent(
      { eventId: ulid(), serverId, ts: at, kind: 'join', name, online },
      machineId,
    );
    if (durationMs === null) return;
    online -= 1;
    panel.ctx.servers.applyPlayerEvent(
      { eventId: ulid(), serverId, ts: at + durationMs, kind: 'leave', name, online },
      machineId,
    );
  }

  beforeEach(async () => {
    online = 0;
    panel = await createTestPanel();
    panel.clock.set(NOW);
    await panel.listen();
    admin = await setupAdmin(panel);
    const machine = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: { cookie: admin },
      payload: { name: 'PC' },
    });
    machineId = machine.json<{ machine: { id: string } }>().machine.id;
    const adopted = await panel.ctx.servers.adoptDetected(
      machineId,
      detected('/srv/copains', 'Copains', 25_565),
      undefined,
    );
    serverId = adopted.server!.id;
    panel.ctx.settings.set(SETTING_KEYS.scheduleTimezone, 'Europe/Paris');
  });

  afterEach(async () => {
    await panel.close();
  });

  it('compte le temps de jeu, les connexions et le classement, sans rien dire du panel', async () => {
    // Hier soir : Alice 3 h, Bob 1 h. Avant-hier : Alice 1 h.
    visit('Alice', NOW - DAY - 2 * HOUR, 3 * HOUR);
    visit('Bob', NOW - DAY - HOUR, HOUR);
    visit('Alice', NOW - 2 * DAY, HOUR);

    const stats = await statsOf();
    expect(stats.timeZone).toBe('Europe/Paris');
    expect(stats.totals).toMatchObject({ sessions: 3, players: 2, playtimeMs: 5 * HOUR });
    expect(stats.days).toHaveLength(30);
    // La fenêtre commence à minuit local, et se termine à l'instant présent.
    expect(stats.from).toBe(Date.UTC(2026, 5, 15, 22, 0));
    expect(stats.to).toBe(NOW);
    expect(stats.days.at(-1)?.start).toBe(Date.UTC(2026, 6, 14, 22, 0));
    expect(stats.top[0]).toMatchObject({ name: 'Alice', playtimeMs: 4 * HOUR, sessions: 2 });
    expect(stats.hours.reduce((a, b) => a + b, 0)).toBe(5 * HOUR);

    // Rien du panel ne sort d'une route de statistiques : ni chemin, ni machine.
    const raw = JSON.stringify(stats);
    expect(raw).not.toContain('/srv/copains');
    expect(raw).not.toContain(machineId);
  });

  it('une session encore ouverte compte jusqu’à maintenant', async () => {
    visit('Alice', NOW - 2 * HOUR, null);
    const stats = await statsOf('?days=1');
    expect(stats.days).toHaveLength(1);
    expect(stats.totals.playtimeMs).toBe(2 * HOUR);
    expect(stats.totals.players).toBe(1);
    expect(stats.totals.peakPlayers).toBe(1);
  });

  it('le fuseau du panel décide où tombent les journées, pas celui du processus', async () => {
    // 23 h 30 heure de Paris, le 14 juillet : encore le 14 à Paris, déjà le 14 en UTC… mais
    // 21 h 30 UTC. La bascule de journée n'a donc pas lieu au même instant.
    visit('Alice', Date.UTC(2026, 6, 14, 21, 30), HOUR);

    const paris = await statsOf('?days=2');
    expect(paris.days).toHaveLength(2);
    expect(paris.days[0]?.start).toBe(Date.UTC(2026, 6, 13, 22, 0));
    // 23 h 30 → 0 h 30 : une demi-heure de chaque côté de minuit, heure de Paris.
    expect(paris.days[0]?.playtimeMs).toBe(HOUR / 2);
    expect(paris.days[1]?.playtimeMs).toBe(HOUR / 2);
    expect(paris.hours[23]).toBe(HOUR / 2);

    panel.ctx.settings.set(SETTING_KEYS.scheduleTimezone, 'UTC');
    const utc = await statsOf('?days=2');
    expect(utc.timeZone).toBe('UTC');
    expect(utc.days[0]?.start).toBe(Date.UTC(2026, 6, 14, 0, 0));
    // En UTC la même heure de jeu (21 h 30 → 22 h 30) tient dans une seule journée.
    expect(utc.days[0]?.playtimeMs).toBe(HOUR);
    expect(utc.days[1]?.playtimeMs).toBe(0);
    expect(utc.hours[21]).toBe(HOUR / 2);
    expect(utc.hours[22]).toBe(HOUR / 2);
  });

  it('la fenêtre est bornée, et un lecteur y a droit', async () => {
    visit('Alice', NOW - 3 * HOUR, HOUR);
    expect((await statsOf('?days=7')).days).toHaveLength(7);
    expect((await api(`/api/servers/${serverId}/players/stats?days=0`)).statusCode).toBe(400);
    expect((await api(`/api/servers/${serverId}/players/stats?days=400`)).statusCode).toBe(400);
    expect((await api(`/api/servers/${serverId}/players/stats?days=abc`)).statusCode).toBe(400);

    await createUser(panel, admin, {
      username: 'lecteur',
      password: 'correct horse battery',
      role: 'viewer',
    });
    const viewer = await login(panel, 'lecteur', 'correct horse battery');
    const res = await api(`/api/servers/${serverId}/players/stats`, viewer);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ stats: PlayerStatsDto }>().stats.totals.players).toBe(1);

    // Un serveur qui n'existe pas répond « introuvable », comme partout ailleurs.
    expect((await api('/api/servers/inconnu/players/stats')).statusCode).toBe(404);
  });
});
