/**
 * Pile e2e (doc 07 phase 5) lancée par Playwright (`webServer`) : panel **réel** (sources
 * `apps/panel/src`, base SQLite temporaire, front `apps/web/dist` servi), agent **réel**
 * (`apps/agent/src`) dont Java est remplacé par le fake Java server, et un serveur Vanilla minimal.
 * Routes de pilotage (hors production) : `POST /e2e/agent/start { pairCode }`, `POST /e2e/agent/stop`,
 * `GET /e2e/info`. Port : `MMO_E2E_PORT` (défaut 3999).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Agent } from '../../../agent/src/agent.js';
import { Logger } from '../../../agent/src/log.js';
import { buildApp } from '../../../panel/src/app.js';

const PORT = Number(process.env.MMO_E2E_PORT ?? 3999);
const HOST = '127.0.0.1';
const FAKE_SERVER = path.resolve(import.meta.dirname, '../../../agent/test/fake-java-server.mjs');
const WEB_DIST = path.resolve(import.meta.dirname, '../../dist');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, HOST, () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), 'mmo-e2e-'));
const dataDir = path.join(root, 'data');
const stateDir = path.join(root, 'agent');
const serversRoot = path.join(root, 'servers');
const serverDir = path.join(serversRoot, 'Vanilla');
await mkdir(dataDir, { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(path.join(serverDir, 'logs'), { recursive: true });
const gamePort = await freePort();
await writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n');
// `online-mode=false` : résolution UUID hors ligne (aucun appel Mojang pendant les e2e).
await writeFile(
  path.join(serverDir, 'server.properties'),
  `server-port=${String(gamePort)}\nonline-mode=false\nmotd=E2E\n`,
);
await writeFile(path.join(serverDir, 'server.jar'), '');
await writeFile(
  path.join(serverDir, 'logs', 'latest.log'),
  '[10:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.1\n',
);

const panel = await buildApp({
  config: {
    dataDir,
    host: HOST,
    port: PORT,
    heartbeatIntervalSec: 2,
    offlineAfterMs: 10_000,
    mojangManifest: false,
    webDir: WEB_DIST,
  },
  logger: { level: process.env.MMO_LOG_LEVEL ?? 'warn' },
});
const { app } = panel;

let agent: Agent | undefined;

async function startAgent(pairCode: string): Promise<void> {
  await agent?.stop();
  const rconFrom = await freePort();
  agent = new Agent({
    stateDir,
    panelUrl: `ws://${HOST}:${String(PORT)}/ws/agent`,
    pairCode,
    logger: new Logger('agent', { stderr: process.env.MMO_E2E_AGENT_LOG === '1' }),
    scanIntervalMs: 0,
    restrictPermissions: false,
    backoff: { baseMs: 100, maxMs: 500 },
    // Phase 7 : métriques rapides pour que les graphiques se remplissent pendant le test.
    metricsIntervalMs: 1000,
    manager: {
      commandBuilder: (ctx) => ({
        file: process.execPath,
        args: [FAKE_SERVER, '--done-after', '100', '--join', 'Alice', '--stop-delay', '50'],
        cwd: ctx.config.path,
        cmdlineKey: 'fake-java-server.mjs',
        files: [],
      }),
      javaResolver: () =>
        Promise.resolve({
          majorVersion: 17,
          vendor: 'fake',
          path: process.execPath,
          managed: false,
        }),
      totalRamMb: () => 16_384,
      rconPortRange: [Math.min(rconFrom, 64_000), 65_000],
      rconProbeIntervalMs: 200,
      exitPollMs: 100,
    },
  });
  await agent.start();
}

app.get('/e2e/info', { config: { public: true } }, () => ({
  serversRoot,
  serverDir,
  gamePort,
  agentRunning: agent !== undefined,
}));
app.post<{ Body: { pairCode?: string } }>(
  '/e2e/agent/start',
  { config: { public: true } },
  async (request, reply) => {
    const code = request.body.pairCode;
    if (code === undefined) return reply.code(400).send({ error: 'pairCode required' });
    await startAgent(code);
    return { ok: true };
  },
);
app.post('/e2e/agent/stop', { config: { public: true } }, async () => {
  await agent?.stop();
  agent = undefined;
  return { ok: true };
});

await app.listen({ port: PORT, host: HOST });
console.error(`[e2e] panel on http://${HOST}:${String(PORT)} · data ${root}`);

const shutdown = async (): Promise<void> => {
  await agent?.stop().catch(() => undefined);
  await panel.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
