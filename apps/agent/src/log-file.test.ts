/**
 * Lot 9 — journal fichier de l'agent et diagnostic borné. Sur de vrais fichiers dans un dossier
 * d'état temporaire : c'est le fichier que `agent.diagnostics` relit, il doit exister pour de bon.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_CAPABILITIES, Agent } from './agent.js';
import { Logger } from './log.js';
import { agentLogDir, createAgentLogSink, purgeAgentLogs, tailAgentLog } from './log-file.js';
import { tmpDir } from './test/helpers.js';

/** Un `WriteStream` écrit de façon asynchrone : attendre le contenu plutôt qu'un délai fixe. */
async function waitForLine(stateDir: string, needle: string): Promise<string[]> {
  const deadline = Date.now() + 5000;
  let tail = tailAgentLog(stateDir, { lines: 50, maxBytes: 65_536 });
  while (!tail.lines.some((l) => l.includes(needle)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    tail = tailAgentLog(stateDir, { lines: 50, maxBytes: 65_536 });
  }
  return tail.lines;
}

describe('journal fichier de l’agent', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('écrit chaque ligne du Logger dans <stateDir>/logs/agent-<date>.log, au format stderr', async () => {
    const state = await tmpDir('mmo-agent-log-');
    cleanups.push(state.cleanup);
    const logger = new Logger('agent', { stderr: false });
    const fileLog = createAgentLogSink(state.dir, () => Date.UTC(2026, 8, 2, 4, 0, 0));
    const detach = logger.addSink(fileLog.sink);
    logger.info('session established', { panel: 'wss://panel.example.org' });
    logger.warn('something odd');
    const lines = await waitForLine(state.dir, 'something odd');
    detach();
    fileLog.close();
    expect(fileLog.file).toBe(path.join(agentLogDir(state.dir), 'agent-2026-09-02.log'));
    expect(lines).toEqual([
      expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO {2}\[agent\] session established \{"panel":"wss:\/\/panel\.example\.org"\}$/,
      ),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN {2}\[agent\] something odd$/),
    ]);
    // Purge par rétention : un journal de 20 jours part, celui du jour reste.
    const old = path.join(agentLogDir(state.dir), 'agent-2026-08-10.log');
    fs.writeFileSync(old, 'x\n');
    const then = new Date(Date.now() - 20 * 86_400_000);
    fs.utimesSync(old, then, then);
    expect(purgeAgentLogs(state.dir, Date.now())).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('agent.diagnostics : état de l’agent + fin du journal, bornés — et le journal se coupe', async () => {
    const state = await tmpDir('mmo-agent-diag-');
    cleanups.push(state.cleanup);
    const agent = new Agent({
      stateDir: state.dir,
      logger: new Logger('agent', { stderr: false }),
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      restrictPermissions: false,
    });
    agent.logger.info('first line');
    agent.logger.info('hello diag');
    await waitForLine(state.dir, 'hello diag');

    const diag = agent.diagnostics({ logLines: 1, logMaxBytes: 65_536 });
    expect(diag.pid).toBe(process.pid);
    expect(diag.agentVersion).toBe(agent.version);
    expect(diag.runtimeVersion).toBe(process.version);
    expect(diag.stateDir).toBe(state.dir);
    expect(diag.connected).toBe(false);
    expect(diag.servers).toEqual([]);
    expect(diag.activeTasks).toBe(0);
    expect(diag.capabilities).toContain('diagnostics');
    expect(diag.capabilities).toBe(AGENT_CAPABILITIES);
    expect(diag.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(diag.rssMb).toBeGreaterThan(0);
    // Borné en lignes : la dernière seulement, et `truncated` le dit.
    expect(diag.log.file).toMatch(/^agent-\d{4}-\d{2}-\d{2}\.log$/);
    expect(diag.log.lines).toHaveLength(1);
    expect(diag.log.lines[0]).toContain('hello diag');
    expect(diag.log.truncated).toBe(true);
    // Sans borne atteinte : les deux lignes, non tronqué.
    const full = agent.diagnostics({ logLines: 200, logMaxBytes: 65_536 });
    expect(full.log.lines.map((l) => l.slice(l.indexOf('[agent]')))).toEqual([
      '[agent] first line',
      '[agent] hello diag',
    ]);
    expect(full.log.truncated).toBe(false);

    // `stop()` détache le journal fichier : la ligne suivante ne s'écrit plus.
    await agent.stop();
    agent.logger.info('after stop');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      tailAgentLog(state.dir, { lines: 50, maxBytes: 65_536 }).lines.some((l) =>
        l.includes('after stop'),
      ),
    ).toBe(false);
  });

  it('fileLog: false — aucun dossier de journaux créé (tests, agent embarqué)', async () => {
    const state = await tmpDir('mmo-agent-nolog-');
    cleanups.push(state.cleanup);
    const agent = new Agent({
      stateDir: state.dir,
      logger: new Logger('agent', { stderr: false }),
      fileLog: false,
      scanIntervalMs: 0,
      trashPurgeIntervalMs: 0,
      restrictPermissions: false,
    });
    agent.logger.info('nowhere');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.existsSync(agentLogDir(state.dir))).toBe(false);
    expect(agent.diagnostics({ logLines: 10, logMaxBytes: 1024 }).log).toEqual({
      lines: [],
      truncated: false,
    });
    await agent.stop();
  });
});
