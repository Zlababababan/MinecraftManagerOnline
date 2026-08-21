import { PROTOCOL_VERSION } from '@mmo/protocol';
import { PROJECT_NAME } from '@mmo/shared';

/** Point d'entrée du bundle. Phase 3 y branchera le noyau local (process, console, RCON, métriques). */
export function describeAgent(): string {
  return `${PROJECT_NAME} agent — protocole v${String(PROTOCOL_VERSION)} — node ${process.version} ${process.platform}/${process.arch}`;
}

if (process.argv.includes('--version')) {
  process.stdout.write(`${describeAgent()}\n`);
}
