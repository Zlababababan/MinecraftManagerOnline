/**
 * Mises à jour côté agent (phase 9, doc 03 §3, doc 05 §9). Disposition gérée par le launcher
 * (`launcher.cjs`, figé) dans `home` (= `MMO_AGENT_HOME`) :
 *
 *   versions/<v>/agent.js   bundles installés        current.json  { version }
 *   next.json               { version, previous }    → écrit ici, consommé par le launcher
 *   trial.json              essai en cours (launcher) update-result.json  issue (launcher → agent)
 *   runtime/<v>/…           runtimes Node            runtime-next.json / runtime-current.json
 *
 * `agent.update` : téléchargement (reprise `Range`), sha256, **signature Ed25519** (clés embarquées),
 * `versions/<v>/`, `next.json`, sortie code **75**. Le launcher bascule, surveille la santé (message IPC
 * `healthy` envoyé quand la session panel est établie) et revient à N-1 sinon ; l'agent relit
 * `update-result.json` au démarrage et l'émet en `agent.updateResult` (critique).
 * `runtime.update` : archive Node vérifiée et extraite sous `runtime/<v>/`, swap au prochain redémarrage.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';

import { ProtocolError, type ParsedRequestPayload, type EventPayload } from '@mmo/protocol';

import { extractTar } from '../backup/tar.js';
import { extractZip } from '../java/zip.js';
import { errorMessage, type Logger } from '../log.js';
import { downloadWithResume } from '../util/download.js';
import { AGENT_UPDATE_PUBLIC_KEYS } from './keys.js';

export const UPDATE_EXIT_CODE = 75;

export interface UpdaterOptions {
  /** Dossier géré par le launcher ; `undefined` = lancé sans launcher (dev) : mises à jour refusées. */
  home: string | undefined;
  currentVersion: string;
  logger: Logger;
  publicKeys?: readonly string[];
  panelOrigin: () => string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Arrêt propre puis sortie (code 75) — injectable en test. */
  restart: (code: number) => void;
  /** Délai entre la réponse `agent.update` et la sortie (défaut 300 ms). */
  exitDelayMs?: number;
}

export type UpdateResultPayload = Omit<EventPayload<'agent.updateResult'>, 'eventId'>;

export class AgentUpdater {
  private readonly keys: KeyObject[];
  private busy = false;

  constructor(private readonly options: UpdaterOptions) {
    this.keys = (options.publicKeys ?? AGENT_UPDATE_PUBLIC_KEYS).map((k) =>
      createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }),
    );
  }

  get home(): string | undefined {
    return this.options.home;
  }

  /** Signal de santé au launcher (session panel établie) — sans effet hors launcher. */
  notifyHealthy(): void {
    const send = (process as { send?: (m: unknown) => void }).send;
    if (typeof send === 'function') {
      try {
        send.call(process, { type: 'healthy', version: this.options.currentVersion });
      } catch {
        // canal IPC fermé
      }
    }
  }

  /** Signature Ed25519 valide pour l'une des clés embarquées. */
  verifySignature(data: Uint8Array, signatureB64: string): boolean {
    let sig: Buffer;
    try {
      sig = Buffer.from(signatureB64, 'base64');
    } catch {
      return false;
    }
    if (sig.byteLength !== 64) return false;
    return this.keys.some((key) => {
      try {
        return verify(null, data, key, sig);
      } catch {
        return false;
      }
    });
  }

  // --- agent.update --------------------------------------------------------------------------

  async update(
    req: ParsedRequestPayload<'agent.update'>,
  ): Promise<{ accepted: true; currentVersion: string; alreadyCurrent: boolean }> {
    const home = this.requireHome();
    if (req.version === this.options.currentVersion) {
      return { accepted: true, currentVersion: this.options.currentVersion, alreadyCurrent: true };
    }
    if (this.busy) throw new ProtocolError('E_BUSY', 'an update is already in progress');
    this.busy = true;
    try {
      const dir = path.join(home, 'versions', sanitize(req.version));
      await mkdir(dir, { recursive: true });
      const bundle = path.join(dir, 'agent.js');
      const partPath = `${bundle}.part`;
      const existing = await stat(bundle).catch(() => undefined);
      if (!existing?.isFile()) {
        await downloadWithResume({
          partPath,
          sources: [{ url: req.url, headers: req.headers, kind: 'relay' }],
          panelOrigin: this.options.panelOrigin(),
          sha256: req.sha256,
          size: req.size,
          fetchImpl: this.options.fetchImpl,
        });
        const data = await readFile(partPath);
        if (!this.verifySignature(data, req.signature)) {
          await rm(partPath, { force: true });
          throw new ProtocolError('E_SIGNATURE_INVALID', 'bundle signature does not verify', {
            details: { version: req.version },
          });
        }
        await rename(partPath, bundle);
      } else {
        // Bundle déjà présent (rejeu) : il doit toujours correspondre.
        const data = await readFile(bundle);
        if (!this.verifySignature(data, req.signature)) {
          await rm(bundle, { force: true });
          throw new ProtocolError('E_SIGNATURE_INVALID', 'bundle signature does not verify');
        }
      }
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
      await writeFile(
        path.join(home, 'next.json'),
        JSON.stringify({ version: req.version, previous: this.options.currentVersion }, null, 2) +
          '\n',
      );
      this.options.logger.info('update staged, restarting', {
        from: this.options.currentVersion,
        to: req.version,
      });
      setTimeout(() => {
        this.options.restart(UPDATE_EXIT_CODE);
      }, this.options.exitDelayMs ?? 300).unref();
      return { accepted: true, currentVersion: this.options.currentVersion, alreadyCurrent: false };
    } finally {
      this.busy = false;
    }
  }

  // --- runtime.update ------------------------------------------------------------------------

  async updateRuntime(
    req: ParsedRequestPayload<'runtime.update'>,
  ): Promise<{ accepted: true; currentVersion: string; pending: boolean }> {
    const home = this.requireHome();
    const current = process.version.replace(/^v/, '');
    const wanted = req.version.replace(/^v/, '');
    if (wanted === current) return { accepted: true, currentVersion: current, pending: false };
    if (this.busy) throw new ProtocolError('E_BUSY', 'an update is already in progress');
    this.busy = true;
    try {
      const root = path.join(home, 'runtime');
      const dest = path.join(root, sanitize(wanted));
      const downloads = path.join(root, '.downloads');
      await mkdir(downloads, { recursive: true });
      const partPath = path.join(downloads, `${sanitize(wanted)}.${req.archive}.part`);
      if (!(await nodeExecutable(dest))) {
        await downloadWithResume({
          partPath,
          sources: [{ url: req.url, headers: req.headers, kind: 'relay' }],
          panelOrigin: this.options.panelOrigin(),
          sha256: req.sha256,
          size: req.size,
          fetchImpl: this.options.fetchImpl,
        });
        const extractDir = `${dest}.extract`;
        await rm(extractDir, { recursive: true, force: true });
        await mkdir(extractDir, { recursive: true });
        if (req.archive === 'zip') await extractZip(partPath, extractDir);
        else {
          const input = createReadStream(partPath, { highWaterMark: 1024 * 1024 });
          const gunzip = createGunzip();
          input.on('error', (error) => gunzip.destroy(error));
          try {
            await extractTar(input.pipe(gunzip) as AsyncIterable<Uint8Array>, extractDir, {
              preserveMode: true,
              symlinks: true,
            });
          } finally {
            input.destroy();
          }
        }
        await flattenSingleRoot(extractDir);
        await rm(dest, { recursive: true, force: true });
        await rename(extractDir, dest);
        await rm(partPath, { force: true });
        if (!(await nodeExecutable(dest))) {
          await rm(dest, { recursive: true, force: true });
          throw new ProtocolError('E_IO', 'archive does not contain a node executable');
        }
      }
      await writeFile(
        path.join(home, 'runtime-next.json'),
        JSON.stringify({ version: wanted, previous: current }, null, 2) + '\n',
      );
      this.options.logger.info('runtime staged for next restart', { from: current, to: wanted });
      return { accepted: true, currentVersion: current, pending: true };
    } finally {
      this.busy = false;
    }
  }

  // --- Issue des mises à jour (écrite par le launcher) --------------------------------------------

  /**
   * Consomme `update-result.json` (issue de la dernière bascule du launcher) : revendication par
   * rename (atomique) puis lecture — un `rm` direct pouvait effacer, sans le lire, un résultat que
   * le launcher venait de réécrire entre notre lecture et la suppression (course observée sur le
   * test manuel 1.0 : `applied` perdu). Si le launcher écrit après la revendication, le nouveau
   * fichier reste en place pour l'appel suivant.
   */
  async consumeUpdateResult(): Promise<UpdateResultPayload | undefined> {
    const claim = await this.claimUpdateResult();
    if (!claim) return undefined;
    await this.releaseUpdateResult(claim.claimedPath);
    return claim.payload;
  }

  /**
   * Revendique l'issue SANS la détruire : le fichier revendiqué n'est supprimé que par
   * releaseUpdateResult(), après que l'événement est durablement journalisé. Auparavant la
   * suppression avait lieu dans un finally, donc AVANT le parse et avant toute émission : une
   * mort du processus dans cette fenêtre (SIGTERM du service, exit 75 d'une mise à jour
   * enchaînée, SIGKILL au health-timeout) perdait l'issue pour toujours.
   *
   * Le nom revendiqué est FIXE : avec le PID dedans, une revendication orpheline devenait
   * invisible au redémarrage. Elle est ici reprise au démarrage suivant.
   */
  async claimUpdateResult(): Promise<
    { payload: UpdateResultPayload; claimedPath: string } | undefined
  > {
    const home = this.options.home;
    if (home === undefined) return undefined;
    const file = path.join(home, 'update-result.json');
    const claimed = path.join(home, 'update-result.claimed.json');
    try {
      await rename(file, claimed);
    } catch {
      // Pas de nouvelle issue : reste-t-il une revendication orpheline d'un processus interrompu ?
      if (!existsSync(claimed)) return undefined;
      this.options.logger.info('resuming an orphaned update result');
    }
    let raw: string;
    try {
      raw = await readFile(claimed, 'utf8');
    } catch {
      return undefined;
    }
    const payload = this.parseUpdateResult(raw);
    if (payload === undefined) {
      // Illisible ou invalide : le rejouer ne servirait à rien, on consomme tout de suite.
      await rm(claimed, { force: true }).catch(() => undefined);
      return undefined;
    }
    return { payload, claimedPath: claimed };
  }

  /** Consomme définitivement une revendication (événement durablement journalisé). */
  async releaseUpdateResult(claimedPath: string): Promise<void> {
    await rm(claimedPath, { force: true }).catch(() => undefined);
  }

  /** `undefined` si le contenu n'est pas une issue exploitable (l'appelant la supprime alors). */
  private parseUpdateResult(raw: string): UpdateResultPayload | undefined {
    const discard = (reason: string): void => {
      this.options.logger.warn('discarding update-result.json', { reason });
    };
    try {
      const j = JSON.parse(raw) as Partial<UpdateResultPayload> & { ts?: number };
      if (
        (j.status !== 'applied' && j.status !== 'rolled_back') ||
        typeof j.version !== 'string' ||
        (j.kind !== 'agent' && j.kind !== 'runtime')
      ) {
        discard('unexpected shape');
        return undefined;
      }
      return {
        ts: typeof j.ts === 'number' ? j.ts : Date.now(),
        kind: j.kind,
        status: j.status,
        version: j.version,
        ...(typeof j.otherVersion === 'string' ? { otherVersion: j.otherVersion } : {}),
        ...(typeof j.reason === 'string' ? { reason: j.reason } : {}),
      };
    } catch (error) {
      discard(errorMessage(error));
      return undefined;
    }
  }

  private requireHome(): string {
    if (this.options.home === undefined) {
      throw new ProtocolError(
        'E_CONFLICT',
        'agent not started by the launcher: updates unavailable',
        {
          details: { reason: 'no_launcher' },
        },
      );
    }
    return this.options.home;
  }
}

/** `MMO_AGENT_HOME` (posé par le launcher) ; sinon aucun launcher. */
export function detectAgentHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.MMO_AGENT_HOME;
  return home === undefined || home === '' ? undefined : path.resolve(home);
}

async function nodeExecutable(dir: string): Promise<string | undefined> {
  for (const rel of ['node.exe', 'node', path.join('bin', 'node')]) {
    const p = path.join(dir, rel);
    const st = await stat(p).catch(() => undefined);
    if (st?.isFile()) return p;
  }
  return undefined;
}

async function flattenSingleRoot(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const only = entries[0];
  if (entries.length !== 1 || !only?.isDirectory()) return;
  const root = path.join(dir, only.name);
  const tmp = `${dir}.root`;
  await rm(tmp, { recursive: true, force: true });
  await rename(root, tmp);
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
}

function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_.+-]/g, '_');
}
