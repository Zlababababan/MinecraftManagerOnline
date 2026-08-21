/**
 * Point d'entrée du bundle agent.
 *   mmo-agent [run] [--panel <ws(s)://…/ws/agent>] [--pair-code <MMOP-…>] [--state-dir <dir>] [--log-level <LEVEL>]
 *   mmo-agent dev <dossier-serveur> [--xmx <Mo>] [--java <exe>] [--state-dir <dir>]   (console locale sans panel)
 *   mmo-agent scan <dossier>                                                          (détection, JSON)
 *   mmo-agent --version
 */
import { PROTOCOL_VERSION, type LogLevel, type ServerConfig } from '@mmo/protocol';
import { PROJECT_NAME, scanForServers } from '@mmo/shared';
import { createNodeDetectFs } from '@mmo/shared/node';
import path from 'node:path';
import readline from 'node:readline';

import { AGENT_VERSION, Agent, currentOs } from './agent.js';
import { Logger, errorMessage } from './log.js';
import { defaultStateDir } from './state/store.js';

export function describeAgent(): string {
  return `${PROJECT_NAME} agent ${AGENT_VERSION} — protocole v${String(PROTOCOL_VERSION)} — node ${process.version} ${process.platform}/${process.arch}`;
}

interface Cli {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Cli {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(arg.slice(2), next);
        i++;
      } else flags.set(arg.slice(2), true);
    } else positional.push(arg);
  }
  const command = positional.shift() ?? 'run';
  return { command, positional, flags };
}

function flag(cli: Cli, name: string): string | undefined {
  const v = cli.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

const LEVELS = new Set<string>(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);

export async function main(argv: readonly string[]): Promise<number> {
  const cli = parseArgs(argv);
  if (cli.flags.has('version')) {
    process.stdout.write(`${describeAgent()}\n`);
    return 0;
  }
  const levelFlag = (flag(cli, 'log-level') ?? 'INFO').toUpperCase();
  const logger = new Logger('agent', {
    level: LEVELS.has(levelFlag) ? (levelFlag as LogLevel) : 'INFO',
  });
  const stateDir = flag(cli, 'state-dir') ?? defaultStateDir();

  switch (cli.command) {
    case 'run':
      return runDaemon(cli, logger, stateDir);
    case 'dev':
      return runDev(cli, logger, stateDir);
    case 'scan':
      return runScan(cli);
    default:
      process.stderr.write(`unknown command: ${cli.command}\n`);
      return 2;
  }
}

async function runDaemon(cli: Cli, logger: Logger, stateDir: string): Promise<number> {
  const agent = new Agent({
    stateDir,
    panelUrl: flag(cli, 'panel'),
    pairCode: flag(cli, 'pair-code'),
    logger,
  });
  logger.info(describeAgent(), { stateDir });
  await agent.start();
  return new Promise<number>((resolve) => {
    const shutdown = (signal: string): void => {
      logger.info('shutting down (servers keep running)', { signal });
      void agent.stop().then(() => {
        resolve(0);
      });
    };
    process.once('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      shutdown('SIGTERM');
    });
  });
}

/** Console locale : lance le serveur du dossier, relaie stdin/stdout, `stop` propre sur Ctrl+C. */
async function runDev(cli: Cli, logger: Logger, stateDir: string): Promise<number> {
  const dirArg = cli.positional[0];
  if (dirArg === undefined) {
    process.stderr.write('usage: mmo-agent dev <server-dir> [--xmx <Mo>] [--java <exe>]\n');
    return 2;
  }
  const dir = path.resolve(dirArg);
  const detected = await scanForServers(createNodeDetectFs(), dir, {
    os: currentOs(),
    maxDepth: 0,
  });
  const server = detected[0];
  if (!server) {
    process.stderr.write(`no Minecraft server detected in ${dir}\n`);
    return 1;
  }
  const serverId = `dev-${path.basename(dir).replace(/[^\w.-]+/g, '_')}`;
  const xmx = flag(cli, 'xmx');
  const java = flag(cli, 'java');
  const config: ServerConfig = {
    serverId,
    path: dir,
    name: server.name,
    maxRamMb: xmx === undefined ? server.maxRamMb.value : Number(xmx),
    ...(server.minRamMb === undefined ? {} : { minRamMb: server.minRamMb.value }),
    loader: server.loader.value,
    ...(server.mcVersion === undefined ? {} : { mcVersion: server.mcVersion.value }),
    ...(server.launch === undefined ? {} : { launch: server.launch }),
    ...(server.javaRequirement === undefined
      ? {}
      : {
          javaMajor: server.javaRequirement.majorVersion,
          javaStrict: server.javaRequirement.strict,
        }),
    ...(java === undefined ? {} : { javaPath: java }),
  };
  const agent = new Agent({
    stateDir: path.join(stateDir, 'dev'),
    logger,
    scanIntervalMs: 0,
    // Relais console : lignes du serveur → stdout
    onServerEvent: (_id, event) => {
      if (event.kind === 'lines') for (const l of event.lines) process.stdout.write(`${l.text}\n`);
      if (event.kind === 'state') {
        const reason = event.exitReason === undefined ? '' : ` (${event.exitReason})`;
        process.stdout.write(`>>> état : ${event.previous} → ${event.state}${reason}\n`);
      }
    },
  });
  await agent.store.load();
  await agent.manager.applyConfigs([config]);
  const proc = agent.manager.require(serverId);
  process.stdout.write(
    `${describeAgent()}\n>>> ${server.loader.value} ${server.mcVersion?.value ?? '?'} — ${dir}\n`,
  );
  try {
    const r = await agent.manager.start(serverId);
    process.stdout.write(`>>> démarré pid ${String(r.pid)} (RCON ${String(proc.rcon?.port)})\n`);
  } catch (error) {
    process.stderr.write(`>>> échec du lancement : ${errorMessage(error)}\n`);
    return 1;
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const cmd = line.trim();
    if (cmd === '') return;
    agent.manager.command(serverId, cmd).catch((error: unknown) => {
      process.stderr.write(`>>> ${errorMessage(error)}\n`);
    });
  });
  return new Promise<number>((resolve) => {
    let stopping = false;
    const finish = (): void => {
      rl.close();
      void agent.stop().then(() => {
        resolve(0);
      });
    };
    process.once('SIGINT', () => {
      if (stopping) return;
      stopping = true;
      process.stdout.write('>>> arrêt propre (120 s max)…\n');
      void agent.manager.stop(serverId).then(finish, finish);
    });
    const poll = setInterval(() => {
      if (!proc.isRunning && !stopping) {
        clearInterval(poll);
        finish();
      }
    }, 500);
  });
}

async function runScan(cli: Cli): Promise<number> {
  const dirArg = cli.positional[0];
  if (dirArg === undefined) {
    process.stderr.write('usage: mmo-agent scan <dir>\n');
    return 2;
  }
  const found = await scanForServers(createNodeDetectFs(), path.resolve(dirArg), {
    os: currentOs(),
  });
  process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
  return 0;
}

// Exécution directe (bundle ou `tsx src/main.ts`) ; importé sans effet par les tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  /(?:^|[\\/])(?:main\.(?:ts|js)|agent\.js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`fatal: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
