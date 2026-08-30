/**
 * Ce qui est vrai maintenant. Séparé du moteur d'alertes (`alerts.ts`) : le moteur ne connaît que
 * des transitions d'état, ces règles ne connaissent que le présent — chacun est testable seul.
 *
 * Règle de prudence commune : **une absence de mesure n'est jamais une alerte**. Le cache de
 * métriques est en mémoire, il est perdu au redémarrage du panel, il n'est jamais relu depuis
 * `metrics.db`, et il reste figé sur la dernière valeur d'un serveur arrêté. Les deux règles qui
 * en dépendent exigent donc un échantillon récent, et se taisent sinon.
 */
import type { MachineRow, ServerRow } from '../db/schema.js';
import type { AlertCondition, AlertThresholds } from './alerts.js';

export interface ConditionInputs {
  now: number;
  thresholds: AlertThresholds;
  machines: MachineRow[];
  servers: ServerRow[];
  /** Dernier point machine connu (mémoire) : disque et fraîcheur. */
  machineSample: (
    machineId: string,
  ) => { ts: number; diskUsedGb: number | null; diskTotalGb: number | null } | undefined;
  /** Dernier point serveur connu (mémoire) : TPS et fraîcheur. */
  serverSample: (serverId: string) => { ts: number; tps: number | null } | undefined;
}

/** États dans lesquels un serveur est considéré comme tournant (aligné sur `servers.ts`). */
const RUNNING = new Set(['running', 'starting', 'stopping']);

/**
 * `firing` = clés `<règle> <portée>` déjà en alerte. C'est ce qui porte l'hystérésis : une règle
 * à seuil entre à `enter` et ne sort qu'en repassant sous `exit`. Sans cette marge, un disque qui
 * oscille autour de 90 % produit cinquante notifications par nuit.
 */
export function collectConditions(
  input: ConditionInputs,
  firing: ReadonlySet<string> = new Set(),
): AlertCondition[] {
  const { now, thresholds: th } = input;
  const out: AlertCondition[] = [];
  const isFiring = (rule: string, scopeId: string) => firing.has(`${rule} ${scopeId}`);

  // 1. Machine hors ligne. Le heartbeat est la seule mesure fiable : `status` est remis à
  // `offline` au démarrage du panel sans toucher `last_seen_at`, s'y fier ferait sonner tout le
  // parc à chaque redémarrage.
  const offline = new Set<string>();
  for (const m of input.machines) {
    if (m.status === 'pending' || m.status === 'disabled') continue;
    const seen = m.lastSeenAt ?? m.createdAt;
    if (m.status !== 'online' && now - seen >= th.machineOfflineMs) {
      offline.add(m.id);
      out.push({
        rule: 'machine.offline',
        scopeType: 'machine',
        scopeId: m.id,
        machineId: m.id,
        serverId: undefined,
        detail: { machineName: m.name, lastSeenAt: m.lastSeenAt },
      });
    }
  }

  // 2. Serveur qui devrait tourner et ne tourne pas. Le prédicat est celui de la réconciliation
  // (`servers.ts`), au délai près : un redémarrage ordinaire ne doit rien déclencher.
  for (const s of input.servers) {
    if (s.desiredState !== 'running' || s.provisioning !== 'ready') continue;
    if (RUNNING.has(s.runState)) continue;
    // `updatedAt` est NOT NULL : c'est le repli quand le serveur n'a jamais été arrêté par nous
    // (adopté déjà à l'arrêt, par exemple).
    const since = s.stoppedAt ?? s.updatedAt;
    if (now - since < th.serverDownMs) continue;
    out.push({
      rule: 'server.down',
      scopeType: 'server',
      scopeId: s.id,
      machineId: s.machineId,
      serverId: s.id,
      detail: { serverName: s.name, runState: s.runState, since },
    });
  }

  // 3. Disque. ⚠ C'est le volume du dossier d'état de l'AGENT, pas celui des serveurs Minecraft :
  // le détail le dit, pour que la notification ne laisse pas croire à autre chose.
  for (const m of input.machines) {
    if (offline.has(m.id)) continue;
    const sample = input.machineSample(m.id);
    if (!sample || now - sample.ts > th.sampleMaxAgeMs) continue;
    if (sample.diskTotalGb === null || sample.diskUsedGb === null) continue;
    if (sample.diskTotalGb <= 0) continue;
    const pct = (sample.diskUsedGb / sample.diskTotalGb) * 100;
    if (pct < (isFiring('disk.low', m.id) ? th.diskExitPct : th.diskEnterPct)) continue;
    out.push({
      rule: 'disk.low',
      scopeType: 'machine',
      scopeId: m.id,
      machineId: m.id,
      serverId: undefined,
      detail: {
        machineName: m.name,
        percent: Math.round(pct),
        freeGb: Math.max(0, Math.round(sample.diskTotalGb - sample.diskUsedGb)),
        scope: 'agent-volume',
      },
    });
  }

  // 4. TPS effondré. `tps === undefined` est une NON-mesure (RCON pas prêt, commande non
  // supportée) et ne doit jamais alerter — c'est la moitié du parc dans la vraie vie.
  for (const s of input.servers) {
    if (s.runState !== 'running') continue;
    if (offline.has(s.machineId)) continue;
    const sample = input.serverSample(s.id);
    if (!sample || now - sample.ts > th.sampleMaxAgeMs) continue;
    const floor = isFiring('tps.low', s.id) ? th.tpsExit : th.tpsEnter;
    if (sample.tps === null || sample.tps >= floor) continue;
    out.push({
      rule: 'tps.low',
      scopeType: 'server',
      scopeId: s.id,
      machineId: s.machineId,
      serverId: s.id,
      detail: { serverName: s.name, tps: Math.round(sample.tps * 10) / 10 },
    });
  }

  return out;
}
