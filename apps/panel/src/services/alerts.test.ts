/**
 * Moteur d'alertes : tout ce qu'un événement ponctuel ne sait pas faire. Chaque test correspond à
 * une nuisance concrète qu'on cherche à éviter — le bruit est ce qui fait ignorer les alertes, et
 * une alerte ignorée ne vaut pas mieux que pas d'alerte du tout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openMmoDatabase, type MmoDatabase, type OpenedDatabase } from '../db/client.js';
import type { MachineRow, ServerRow } from '../db/schema.js';
import { collectConditions, type ConditionInputs } from './alert-conditions.js';
import { AlertsService, DEFAULT_THRESHOLDS, type AlertCondition } from './alerts.js';

interface Published {
  type: string;
  payload: Record<string, unknown>;
}

const MACHINE = 'm1';
const SERVER = 's1';

function condition(over: Partial<AlertCondition> = {}): AlertCondition {
  return {
    rule: 'server.down',
    scopeType: 'server',
    scopeId: SERVER,
    machineId: MACHINE,
    serverId: SERVER,
    detail: {},
    ...over,
  };
}

describe('AlertsService', () => {
  let opened: OpenedDatabase<MmoDatabase>;
  let published: Published[];
  let now: number;
  let current: AlertCondition[];
  let service: AlertsService;

  beforeEach(() => {
    opened = openMmoDatabase(':memory:');
    published = [];
    now = 1_800_000_000_000;
    current = [];
    service = new AlertsService({
      db: opened.db,
      now: () => now,
      thresholds: () => DEFAULT_THRESHOLDS,
      conditions: () => current,
      publish: (e) => published.push({ type: e.type, payload: e.payload }),
    });
  });
  afterEach(() => {
    opened.close();
  });

  const types = () => published.map((p) => p.type);

  it('notifie une fois à l’apparition, et pas à chaque évaluation', () => {
    current = [condition()];
    service.evaluate();
    service.evaluate();
    service.evaluate();
    expect(types()).toEqual(['alert.firing']);
    expect(service.list('firing')).toHaveLength(1);
  });

  it('notifie le retour à la normale, avec la durée de l’incident', () => {
    current = [condition()];
    service.evaluate();
    now += 20 * 60_000;
    current = [];
    service.evaluate();
    expect(types()).toEqual(['alert.firing', 'alert.resolved']);
    expect(published[1]?.payload).toMatchObject({ rule: 'server.down', durationMs: 20 * 60_000 });
    expect(service.list('firing')).toHaveLength(0);
    expect(service.list('resolved')).toHaveLength(1);
  });

  // Une machine qui tombe emporte ses serveurs : sans regroupement, douze serveurs font douze
  // notifications pour un seul incident, et l'utilisateur coupe les notifications.
  it('une machine hors ligne masque les alertes de ses serveurs', () => {
    current = [
      condition({
        rule: 'machine.offline',
        scopeType: 'machine',
        scopeId: MACHINE,
        serverId: undefined,
      }),
      condition({ scopeId: 's1' }),
      condition({ scopeId: 's2' }),
      condition({ scopeId: 's3' }),
    ];
    service.evaluate();
    expect(types()).toEqual(['alert.firing']);
    expect(published[0]?.payload.rule).toBe('machine.offline');
    // Les alertes masquées existent quand même : l'interface doit les montrer.
    expect(service.list('firing')).toHaveLength(4);
  });

  it('une alerte masquée puis démasquée n’annonce pas un retour à la normale fantôme', () => {
    current = [
      condition({
        rule: 'machine.offline',
        scopeType: 'machine',
        scopeId: MACHINE,
        serverId: undefined,
      }),
      condition(),
    ];
    service.evaluate();
    published.length = 0;
    // La machine revient, le serveur est toujours à terre : il n'a jamais été notifié, donc sa
    // résolution ne doit rien annoncer non plus.
    current = [condition()];
    service.evaluate();
    expect(types()).toEqual(['alert.resolved']);
    expect(published[0]?.payload.rule).toBe('machine.offline');
  });

  it('rappelle une alerte qui dure, mais espacé', () => {
    current = [condition()];
    service.evaluate();
    now += DEFAULT_THRESHOLDS.repeatMs - 1000;
    service.evaluate();
    expect(types()).toEqual(['alert.firing']);
    now += 2000;
    service.evaluate();
    expect(types()).toEqual(['alert.firing', 'alert.firing']);
    expect(published[1]?.payload.repeat).toBe(true);
  });

  it('une alerte qui réapparaît après résolution est une nouvelle alerte', () => {
    current = [condition()];
    service.evaluate();
    current = [];
    service.evaluate();
    now += 60_000;
    current = [condition()];
    service.evaluate();
    expect(types()).toEqual(['alert.firing', 'alert.resolved', 'alert.firing']);
    expect(service.list('firing')).toHaveLength(1);
  });

  it('oublie les alertes résolues anciennes', () => {
    current = [condition()];
    service.evaluate();
    current = [];
    service.evaluate();
    expect(service.purgeResolvedBefore(now - 1000)).toBe(0);
    expect(service.purgeResolvedBefore(now + 1000)).toBe(1);
    expect(service.list()).toHaveLength(0);
  });
});

// --- Règles ------------------------------------------------------------------------------------

function machine(over: Partial<MachineRow> = {}): MachineRow {
  return {
    id: MACHINE,
    name: 'PC du salon',
    status: 'offline',
    lastSeenAt: null,
    createdAt: 0,
    ...over,
  } as MachineRow;
}

function server(over: Partial<ServerRow> = {}): ServerRow {
  return {
    id: SERVER,
    machineId: MACHINE,
    name: 'Vanilla',
    desiredState: 'running',
    runState: 'stopped',
    provisioning: 'ready',
    stoppedAt: null,
    updatedAt: 0,
    createdAt: 0,
    ...over,
  } as ServerRow;
}

describe('règles d’alerte', () => {
  const NOW = 1_800_000_000_000;
  const base = (over: Partial<ConditionInputs> = {}): ConditionInputs => ({
    now: NOW,
    thresholds: DEFAULT_THRESHOLDS,
    machines: [],
    servers: [],
    machineSample: () => undefined,
    serverSample: () => undefined,
    ...over,
  });
  const rules = (input: ConditionInputs, firing = new Set<string>()) =>
    collectConditions(input, firing).map((c) => `${c.rule} ${c.scopeId}`);

  it('machine hors ligne : seulement passé le délai, jamais sur un simple redémarrage', () => {
    const recent = machine({ lastSeenAt: NOW - 60_000 });
    expect(rules(base({ machines: [recent] }))).toEqual([]);
    const gone = machine({ lastSeenAt: NOW - 20 * 60_000 });
    expect(rules(base({ machines: [gone] }))).toEqual(['machine.offline m1']);
    // Une machine en ligne, jamais ; une machine désactivée ou en attente non plus.
    expect(rules(base({ machines: [machine({ status: 'online', lastSeenAt: 0 })] }))).toEqual([]);
    expect(rules(base({ machines: [machine({ status: 'disabled', lastSeenAt: 0 })] }))).toEqual([]);
    expect(rules(base({ machines: [machine({ status: 'pending', lastSeenAt: 0 })] }))).toEqual([]);
  });

  it('serveur à terre : seulement s’il devrait tourner, et passé le délai', () => {
    expect(rules(base({ servers: [server({ stoppedAt: NOW - 60_000 })] }))).toEqual([]);
    expect(rules(base({ servers: [server({ stoppedAt: NOW - 10 * 60_000 })] }))).toEqual([
      'server.down s1',
    ]);
    // Arrêté volontairement, ou pas encore installé : rien.
    expect(rules(base({ servers: [server({ desiredState: 'stopped', stoppedAt: 0 })] }))).toEqual(
      [],
    );
    expect(
      rules(base({ servers: [server({ provisioning: 'installing', stoppedAt: 0 })] })),
    ).toEqual([]);
    expect(rules(base({ servers: [server({ runState: 'starting', stoppedAt: 0 })] }))).toEqual([]);
  });

  // Sans hystérésis, un disque qui oscille autour de 90 % produit une notification par minute.
  it('disque : entre à 90 %, ne sort qu’en repassant sous 85 %', () => {
    const sample = (pct: number) => () => ({
      ts: NOW,
      diskUsedGb: pct,
      diskTotalGb: 100,
    });
    const input = (pct: number) =>
      base({ machines: [machine({ status: 'online' })], machineSample: sample(pct) });
    expect(rules(input(88))).toEqual([]);
    expect(rules(input(91))).toEqual(['disk.low m1']);
    // Déjà en alerte : 88 % ne suffit pas à sortir, 84 % oui.
    const firing = new Set(['disk.low m1']);
    expect(rules(input(88), firing)).toEqual(['disk.low m1']);
    expect(rules(input(84), firing)).toEqual([]);
  });

  it('TPS : une absence de mesure n’est jamais une alerte', () => {
    const running = server({ runState: 'running' });
    const at =
      (tps: number | null, ts = NOW) =>
      () => ({ ts, tps });
    expect(rules(base({ servers: [running], serverSample: at(19) }))).toEqual([]);
    expect(rules(base({ servers: [running], serverSample: at(9) }))).toEqual(['tps.low s1']);
    // RCON pas prêt, commande non supportée : pas de TPS, donc rien à dire.
    expect(rules(base({ servers: [running], serverSample: at(null) }))).toEqual([]);
    // Échantillon périmé (panel redémarré, agent parti) : on ne conclut rien non plus.
    expect(rules(base({ servers: [running], serverSample: at(2, NOW - 10 * 60_000) }))).toEqual([]);
  });

  it('une machine hors ligne ne produit ni alerte disque ni alerte TPS pour elle', () => {
    const gone = machine({ lastSeenAt: NOW - 20 * 60_000 });
    const running = server({ runState: 'running' });
    const found = rules(
      base({
        machines: [gone],
        servers: [running],
        machineSample: () => ({ ts: NOW, diskUsedGb: 99, diskTotalGb: 100 }),
        serverSample: () => ({ ts: NOW, tps: 2 }),
      }),
    );
    // `server.down` ne s'applique pas (le serveur est `running` côté panel) ; disque et TPS sont
    // écartés à la source, leur mesure ne veut plus rien dire.
    expect(found).toEqual(['machine.offline m1']);
  });
});
