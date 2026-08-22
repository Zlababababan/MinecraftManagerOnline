/** Configuration du panel (env ou options programmatiques). Jamais `0.0.0.0` (doc 05 §12). */
import path from 'node:path';

export interface PanelConfig {
  /** Dossier des données (`mmo.db`, `metrics.db`, artefacts). */
  dataDir: string;
  host: string;
  port: number;
  /** Heartbeat demandé aux agents (doc 05 §13 : 15 s) et délai avant `offline` (40 s). */
  heartbeatIntervalSec: number;
  offlineAfterMs: number;
  /** Durée de vie d'une session cookie (défaut 30 jours). */
  sessionTtlMs: number;
  /** Cookie `Secure` forcé (sinon déduit de `panel.publicUrl` en https). */
  cookieSecure: boolean | undefined;
  /** Accès au manifest Mojang (mapping MC→Java) ; `false` = table statique seulement. */
  mojangManifest: boolean;
}

const FORBIDDEN_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

export function assertListenHost(host: string): void {
  if (FORBIDDEN_HOSTS.has(host)) {
    throw new Error(
      `refusing to listen on ${host}: the panel never binds all interfaces (doc 05 §12) — use 127.0.0.1 or a dedicated interface address`,
    );
  }
}

export function defaultConfig(overrides: Partial<PanelConfig> = {}): PanelConfig {
  const config: PanelConfig = {
    dataDir: path.resolve('data'),
    host: '127.0.0.1',
    port: 3000,
    heartbeatIntervalSec: 15,
    offlineAfterMs: 40_000,
    sessionTtlMs: 30 * 24 * 3_600_000,
    cookieSecure: undefined,
    mojangManifest: true,
    ...overrides,
  };
  assertListenHost(config.host);
  return config;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PanelConfig {
  const secure = env.MMO_COOKIE_SECURE;
  return defaultConfig({
    dataDir: path.resolve(env.MMO_DATA_DIR ?? 'data'),
    host: env.MMO_HOST ?? '127.0.0.1',
    port: Number(env.MMO_PORT ?? 3000),
    ...(secure === undefined ? {} : { cookieSecure: secure === '1' || secure === 'true' }),
    mojangManifest: env.MMO_MOJANG_MANIFEST !== '0',
  });
}
