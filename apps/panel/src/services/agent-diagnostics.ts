/**
 * Fichier de diagnostic d'un agent (lot 9) — `GET /api/machines/:id/diagnostics`. Même esprit que
 * `mmo-panel report` : un **texte** que l'utilisateur relit avant de le joindre à une issue, jamais
 * une archive. Tout ce qui vient de l'agent passe par le masquage (chemins personnels, jetons,
 * codes d'appairage, adresses tronquées) : le nom d'utilisateur est dans `stateDir`, et le journal
 * peut citer n'importe quel chemin.
 */
import type { ResponsePayload } from '@mmo/protocol';

import { maskText } from '../util/mask.js';
import { PANEL_VERSION } from '../version.js';

export type AgentDiagnostics = ResponsePayload<'agent.diagnostics'>;

export function renderAgentDiagnostics(
  machine: { id: string; name: string },
  diag: AgentDiagnostics,
  now: number,
): string {
  const servers =
    diag.servers.length === 0
      ? ['(none)']
      : diag.servers.map(
          (s) =>
            `${s.serverId}  ${s.runState}  ${s.attachMode}${s.pid === undefined ? '' : `  pid ${String(s.pid)}`}`,
        );
  const lines = [
    '# MinecraftManagerOnline — agent diagnostic',
    `generated: ${new Date(now).toISOString()}`,
    `panel: ${PANEL_VERSION}`,
    `machine: ${machine.name} (${machine.id})`,
    '',
    '## agent',
    `version: ${diag.agentVersion}`,
    `runtime: ${diag.runtimeVersion}`,
    `os: ${diag.machine.os} ${diag.machine.arch} (${diag.machine.hostname})`,
    `pid: ${String(diag.pid)}`,
    `started: ${new Date(diag.startedAt).toISOString()} (uptime ${formatUptime(diag.uptimeSec)})`,
    `rss: ${String(diag.rssMb)} MiB`,
    `state dir: ${diag.stateDir}`,
    `home: ${diag.agentHome ?? '(default)'}`,
    `panel url: ${diag.panelUrl ?? '(unknown)'}`,
    `connected: ${diag.connected ? 'yes' : 'no'}`,
    `active tasks: ${String(diag.activeTasks)}`,
    `capabilities: ${(diag.capabilities ?? []).join(', ')}`,
    '',
    '## servers (id  run state  attach mode  pid)',
    ...servers,
    '',
    `## log (${diag.log.file ?? 'no file yet'}, last ${String(diag.log.lines.length)} lines${
      diag.log.truncated ? ', older lines not included' : ''
    }, masked)`,
    '',
    ...diag.log.lines,
    '',
  ];
  return maskText(lines.join('\n'));
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${String(d)}d ${String(h)}h ${String(m)}m`;
  if (h > 0) return `${String(h)}h ${String(m)}m`;
  return `${String(m)}m`;
}
