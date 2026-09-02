import { describe, expect, it } from 'vitest';

import { renderAgentDiagnostics, type AgentDiagnostics } from './agent-diagnostics.js';

const DIAG: AgentDiagnostics = {
  agentVersion: '1.0.8',
  runtimeVersion: 'v24.19.0',
  machine: { hostname: 'gaming-pc', os: 'windows', arch: 'x64' },
  pid: 4242,
  startedAt: Date.UTC(2026, 8, 1, 22, 0, 0),
  uptimeSec: 2 * 86_400 + 3 * 3600 + 5 * 60,
  stateDir: 'C:\\Users\\jean\\AppData\\Local\\mmo-agent',
  agentHome: 'C:\\Users\\jean\\AppData\\Local\\Programs\\mmo-agent',
  rssMb: 85.5,
  panelUrl: 'wss://panel.example.org/ws/agent',
  connected: true,
  servers: [
    {
      serverId: '01J5X8ZK3Q9WYE2R7M4T6B8N9Z',
      runState: 'running',
      attachMode: 'detached',
      pid: 1234,
    },
    { serverId: '01J5X8ZK3Q9WYE2R7M4T6B8N9A', runState: 'stopped', attachMode: 'attached' },
  ],
  activeTasks: 1,
  capabilities: ['rcon', 'diagnostics'],
  log: {
    file: 'agent-2026-09-02.log',
    lines: [
      '2026-09-02T04:00:00.000Z INFO  [agent:ws] connected to 203.0.113.42 with token abc123',
      '2026-09-02T04:00:01.000Z WARN  [agent:servers] EACCES /home/jean/mc/atm10/server.properties',
      '2026-09-02T04:00:02.000Z INFO  [agent] paired with MMOP-AB12-CD34',
    ],
    truncated: true,
  },
};

describe('renderAgentDiagnostics', () => {
  it('rend un texte relisible, masqué : chemins personnels, jeton, code, adresse', () => {
    const text = renderAgentDiagnostics(
      { id: 'mac_1', name: 'Tour du salon' },
      DIAG,
      Date.UTC(2026, 8, 2, 8, 0, 0),
    );
    expect(text).toContain('machine: Tour du salon (mac_1)');
    expect(text).toContain('version: 1.0.8');
    expect(text).toContain('os: windows x64 (gaming-pc)');
    expect(text).toContain('uptime 2d 3h 5m');
    expect(text).toContain('state dir: C:\\Users\\<user>\\AppData\\Local\\mmo-agent');
    expect(text).toContain('home: C:\\Users\\<user>\\AppData\\Local\\Programs\\mmo-agent');
    expect(text).toContain('01J5X8ZK3Q9WYE2R7M4T6B8N9Z  running  detached  pid 1234');
    expect(text).toContain('01J5X8ZK3Q9WYE2R7M4T6B8N9A  stopped  attached');
    expect(text).toContain('last 3 lines, older lines not included, masked');
    expect(text).toContain('connected to 203.0.113.x with token <redacted>');
    expect(text).toContain('EACCES /home/<user>/mc/atm10/server.properties');
    expect(text).toContain('paired with MMOP-<code>');
    // Rien de ce qui était à masquer ne survit.
    for (const leaked of ['jean', 'abc123', '203.0.113.42', 'MMOP-AB12-CD34']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('sans journal ni serveur : le fichier le dit au lieu de se taire', () => {
    const text = renderAgentDiagnostics(
      { id: 'mac_1', name: 'Tour' },
      { ...DIAG, servers: [], log: { lines: [], truncated: false } },
      Date.UTC(2026, 8, 2),
    );
    expect(text).toContain('(none)');
    expect(text).toContain('## log (no file yet, last 0 lines, masked)');
  });
});
