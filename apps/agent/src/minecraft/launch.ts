/**
 * Construction de la ligne de commande java (doc 06 §1) : 4 templates (`jar` vanilla/Forge
 * ancien/Fabric, `argfile` Forge/NeoForge modernes) + flags injectés systématiquement.
 * Jamais via un shell ni un `.bat`/`.sh` ; cwd = dossier du serveur. Fonction pure (testable).
 */
import { ProtocolError, type LaunchPlan, type Os } from '@mmo/protocol';
import { compareMcVersions } from '@mmo/shared';

import { LOG4J2_112_116_FILENAME, LOG4J2_112_116_XML } from './log4j2-config.js';

export interface LaunchInput {
  serverDir: string;
  launch: LaunchPlan;
  os: Os;
  javaPath: string;
  javaMajor: number;
  maxRamMb: number;
  minRamMb?: number | undefined;
  mcVersion?: string | undefined;
  /** Arguments JVM supplémentaires (après les flags injectés). */
  jvmArgs?: readonly string[] | undefined;
}

export interface LaunchCommand {
  file: string;
  args: string[];
  cwd: string;
  /** Fragment distinctif de la ligne de commande (ré-adoption). */
  cmdlineKey: string;
  /** Fichiers à écrire dans le dossier serveur avant le lancement (config log4j2 patchée). */
  files: { name: string; content: string }[];
}

export type Log4ShellMitigation = 'config_file' | 'no_lookups' | 'none';

/** 1.12–1.16.5 : fichier de configuration ; 1.17–1.18.0 : propriété système ; sinon rien. */
export function log4ShellMitigation(mcVersion: string | undefined): Log4ShellMitigation {
  if (mcVersion === undefined) return 'no_lookups'; // inconnu : la propriété est sans effet de bord
  const ge112 = compareMcVersions(mcVersion, '1.12');
  const lt117 = compareMcVersions(mcVersion, '1.17');
  const le1180 = compareMcVersions(mcVersion, '1.18.1');
  if (ge112 === undefined || lt117 === undefined || le1180 === undefined) return 'no_lookups';
  if (ge112 >= 0 && lt117 < 0) return 'config_file';
  if (lt117 >= 0 && le1180 < 0) return 'no_lookups';
  return 'none';
}

export function buildLaunchCommand(input: LaunchInput): LaunchCommand {
  const args: string[] = [];
  const files: LaunchCommand['files'] = [];

  // Mémoire (garde-fou vérifié en amont par le gestionnaire)
  if (input.minRamMb !== undefined)
    args.push(`-Xms${String(Math.min(input.minRamMb, input.maxRamMb))}M`);
  args.push(`-Xmx${String(input.maxRamMb)}M`);

  // Encodage (piège n°1 sous Windows, doc 06 §3)
  args.push('-Dfile.encoding=UTF-8');
  if (input.javaMajor >= 19) args.push('-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');

  // Log4Shell
  switch (log4ShellMitigation(input.mcVersion)) {
    case 'config_file':
      files.push({ name: LOG4J2_112_116_FILENAME, content: LOG4J2_112_116_XML });
      args.push(`-Dlog4j.configurationFile=${LOG4J2_112_116_FILENAME}`);
      break;
    case 'no_lookups':
      args.push('-Dlog4j2.formatMsgNoLookups=true');
      break;
    case 'none':
      break;
  }

  args.push('-XX:+ExitOnOutOfMemoryError', '-Djava.awt.headless=true', '-Dlog4j.skipJansi=true');
  if (input.jvmArgs) args.push(...input.jvmArgs);

  let cmdlineKey: string;
  switch (input.launch.kind) {
    case 'jar':
      args.push('-jar', input.launch.jar);
      cmdlineKey = input.launch.jar;
      break;
    case 'argfile': {
      const win = input.os === 'windows';
      const name = win ? 'win_args.txt' : 'unix_args.txt';
      const available = win ? input.launch.hasWinArgs : input.launch.hasUnixArgs;
      if (!available) {
        throw new ProtocolError(
          'E_NOT_FOUND',
          `argfile ${name} missing in ${input.launch.argfileDir}`,
          {
            details: {
              argfile: name,
              argfileDir: input.launch.argfileDir,
              reason: 'argfile_missing',
            },
          },
        );
      }
      const argfile = `${input.launch.argfileDir.replace(/\/+$/, '')}/${name}`;
      args.push(`@${argfile}`);
      cmdlineKey = argfile;
      break;
    }
  }
  args.push('nogui');

  return { file: input.javaPath, args, cwd: input.serverDir, cmdlineKey, files };
}
