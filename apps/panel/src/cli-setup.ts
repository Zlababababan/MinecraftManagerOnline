/**
 * `mmo-panel setup` : configuration initiale sans navigateur.
 *
 * Troisième accroc de l'installation sur une VM cloud (Ubuntu 20.04 ARM) : le wizard n'existait
 * qu'en HTTP, et le panel n'écoute que sur 127.0.0.1 — il fallait monter un tunnel SSH ou un
 * `tailscale serve` AVANT de pouvoir créer le premier compte. Cette commande passe par exactement
 * le même chemin que le wizard (`services/setup.ts`), clés VAPID comprises.
 *
 *   mmo-panel setup --username admin --password-stdin
 *   mmo-panel setup --username admin --random-password --public-url panel.exemple.net
 *
 * Le mot de passe n'est JAMAIS pris sur la ligne de commande : elle est visible de toute la
 * machine (`ps`) et finit dans l'historique du shell.
 */
import { readFileSync } from 'node:fs';

import { LOCALES, isLocale } from '@mmo/shared';

import type { FastifyBaseLogger } from 'fastify';

import type { PanelConfig } from './config.js';

/** Journal muet : la commande parle sur la sortie standard, pas en NDJSON. */
function silentLogger(): FastifyBaseLogger {
  const noop = (): void => undefined;
  const logger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  };
  return logger;
}

const USAGE = `usage: mmo-panel setup --username <name> (--password-stdin | --password-file <file> | --random-password)
                       [--locale ${LOCALES.join('|')}] [--public-url <url>]
                       [--access-mode tailscale|direct|manual]`;

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}

/** Mot de passe aléatoire lisible : 4 groupes base32 sans caractères ambigus. */
function randomPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length] ?? 'a');
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runSetupCommand(
  config: PanelConfig,
  argv: readonly string[],
): Promise<number> {
  const username = flag(argv, 'username');
  if (username === undefined || username === '') {
    console.error(USAGE);
    return 2;
  }

  const sources = ['password-stdin', 'password-file', 'random-password'].filter(
    (name) => flag(argv, name) !== undefined,
  );
  if (sources.length !== 1) {
    console.error(`${USAGE}\n\nexactly one password source is required`);
    return 2;
  }

  let password: string;
  let generated = false;
  if (sources[0] === 'random-password') {
    password = randomPassword();
    generated = true;
  } else if (sources[0] === 'password-file') {
    const file = flag(argv, 'password-file');
    if (file === undefined || file === '') {
      console.error('--password-file needs a path');
      return 2;
    }
    password = readFileSync(file, 'utf8').trim();
  } else {
    password = (await readStdin()).trim();
  }
  if (password === '') {
    console.error('empty password');
    return 2;
  }

  const locale = flag(argv, 'locale');
  if (locale !== undefined && !isLocale(locale)) {
    console.error(`unknown locale: ${locale} (expected ${LOCALES.join(' or ')})`);
    return 2;
  }
  const accessMode = flag(argv, 'access-mode');
  if (
    accessMode !== undefined &&
    accessMode !== 'tailscale' &&
    accessMode !== 'direct' &&
    accessMode !== 'manual'
  ) {
    console.error(`unknown access mode: ${accessMode}`);
    return 2;
  }

  // Contexte complet mais sans serveur HTTP : mêmes migrations, mêmes services que le panel.
  const { createContext } = await import('./context.js');
  const { completeSetup } = await import('./services/setup.js');
  const ctx = createContext({ config, logger: silentLogger() });
  try {
    if (ctx.users.count() > 0) {
      console.error('setup already completed: this panel already has an account');
      return 1;
    }
    const admin = await completeSetup(ctx, {
      username,
      password,
      ...(locale === undefined ? {} : { locale }),
      ...(flag(argv, 'public-url') === undefined ? {} : { publicUrl: flag(argv, 'public-url') }),
      ...(accessMode === undefined ? {} : { accessMode }),
    });
    console.log(`admin account created: ${admin.username}`);
    if (generated) console.log(`password: ${password}`);
    console.log(`data directory: ${config.dataDir}`);
    console.log('start the panel, then sign in with these credentials.');
    return 0;
  } catch (error) {
    console.error(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    ctx.close();
  }
}
