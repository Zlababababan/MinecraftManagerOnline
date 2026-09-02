/**
 * Vérification périodique des archives (lot 4 « Ne jamais perdre un monde », 2026-09-02).
 *
 * Une sauvegarde n'est prouvée que le jour où on la relit : un disque qui s'abîme, une archive
 * tronquée par une coupure, un NAS qui a « perdu » un fichier ne se voient qu'à la restauration —
 * c'est-à-dire trop tard. `verifyArchive` existait déjà pour le restore ; cette passe le rejoue
 * seule, à cadence lente :
 *
 * - **une passe par jour** (`intervalMs`), jamais avant `initialDelayMs` après le démarrage (un
 *   agent qui boote a mieux à faire que relire des gigaoctets) ;
 * - **jamais vérifiées d'abord, les plus anciennes en tête**, puis celles dont la dernière
 *   vérification remonte à plus de `recheckAfterMs` (7 j) ; une archive déjà déclarée corrompue
 *   n'est pas relue (elle le reste jusqu'à sa suppression) ;
 * - **budget d'octets par passe** (`byteBudget`, 8 Gio) — au moins une archive à chaque passe, pour
 *   qu'un parc de 56 serveurs × 7 archives soit couvert en semaines et non en années, sans
 *   monopoliser le disque une nuit entière ;
 * - **jamais pendant une task du même serveur** (sauvegarde, restauration, migration) : on ne
 *   relit pas une archive en cours d'écriture ni pendant qu'une autre s'écrit à côté.
 *
 * Le résultat est écrit dans le manifeste par `BackupService.verify` et signalé au panel par
 * `backup.verified` (non critique) — `backup.list` le rattrape à la reconnexion.
 */
import type { BackupManifest } from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';
import type { StateStore } from '../state/store.js';
import type { TaskRunner } from '../tasks/runner.js';
import type { BackupService, BackupVerification } from './backup-service.js';

/** Tasks pendant lesquelles on ne touche pas aux archives du serveur. */
const CONFLICTING_TASKS = [
  'backup.create',
  'backup.restore',
  'backup.restorePaths',
  'migration.export',
  'migration.import',
];

export interface BackupVerifierOptions {
  store: StateStore;
  backups: BackupService;
  tasks: TaskRunner;
  logger: Logger;
  now?: () => number;
  /** Période d'évaluation (défaut 60 s). */
  tickMs?: number;
  /** Cadence des passes (défaut 24 h ; 0 = une passe à chaque tick, pour les tests). */
  intervalMs?: number;
  /** Attente après le démarrage avant la première passe (défaut 10 min). */
  initialDelayMs?: number;
  /** Une archive vérifiée il y a moins longtemps n'est pas relue (défaut 7 j). */
  recheckAfterMs?: number;
  /** Octets relus au plus par passe, au moins une archive (défaut 8 Gio). */
  byteBudget?: number;
}

export interface VerificationPass {
  verified: number;
  corrupted: number;
  /** Archives disparues entre le listage et la lecture. */
  gone: number;
  /** Archives laissées de côté parce qu'une task tournait sur leur serveur. */
  busy: number;
  bytes: number;
  durationMs: number;
}

export class BackupVerifier {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;
  private running = false;

  constructor(private readonly options: BackupVerifierOptions) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Une passe est-elle due maintenant ? */
  due(): boolean {
    const t = this.now();
    if (t - this.startedAt < (this.options.initialDelayMs ?? 10 * 60_000)) return false;
    const last = this.options.store.get().backupVerifyAt;
    return last === undefined || t - last >= (this.options.intervalMs ?? 24 * 3_600_000);
  }

  /** Lance une passe si elle est due ; `undefined` sinon. Jamais deux passes en parallèle. */
  async tick(): Promise<VerificationPass | undefined> {
    if (this.running || !this.due()) return undefined;
    return this.runPass();
  }

  /** Une passe, due ou non (déclenchement explicite). */
  async runPass(): Promise<VerificationPass> {
    if (this.running) throw new Error('verification pass already running');
    this.running = true;
    const started = this.now();
    const pass: VerificationPass = {
      verified: 0,
      corrupted: 0,
      gone: 0,
      busy: 0,
      bytes: 0,
      durationMs: 0,
    };
    try {
      // Posé AVANT la lecture : une passe interrompue (arrêt de l'agent) ne repart pas de zéro
      // à chaque tick de la journée, les archives déjà relues portent leur `verifiedAt`.
      await this.options.store.update((s) => {
        s.backupVerifyAt = started;
      });
      const budget = this.options.byteBudget ?? 8 * 1024 ** 3;
      const candidates = selectForVerification(
        await this.options.backups.listAll(),
        started,
        this.options.recheckAfterMs ?? 7 * 24 * 3_600_000,
      );
      for (const manifest of candidates) {
        if (pass.verified + pass.corrupted > 0 && pass.bytes + manifest.sizeBytes > budget) break;
        if (this.options.tasks.activeFor(manifest.serverId, CONFLICTING_TASKS)) {
          pass.busy++;
          continue;
        }
        let result: BackupVerification | undefined;
        try {
          result = await this.options.backups.verify(manifest);
        } catch (error) {
          // Lecture impossible (disque débranché, permission) : signalé, la passe continue.
          this.options.logger.warn('backup verification failed to read the archive', {
            serverId: manifest.serverId,
            backupId: manifest.backupId,
            error: errorMessage(error),
          });
          continue;
        }
        if (result === undefined) {
          pass.gone++;
          continue;
        }
        pass.bytes += result.sizeBytes;
        if (result.ok) pass.verified++;
        else pass.corrupted++;
      }
    } finally {
      this.running = false;
    }
    pass.durationMs = this.now() - started;
    this.options.logger.info('backup verification pass', { ...pass });
    return pass;
  }
}

/**
 * Archives à relire, dans l'ordre : jamais vérifiées (les plus anciennes d'abord), puis celles
 * vérifiées il y a plus de `recheckAfterMs` (la plus ancienne vérification d'abord). Les archives
 * déjà corrompues sont exclues : les relire ne les répare pas.
 */
export function selectForVerification(
  manifests: readonly BackupManifest[],
  now: number,
  recheckAfterMs: number,
): BackupManifest[] {
  const never = manifests
    .filter((m) => m.verifiedAt === undefined && m.verifyStatus !== 'corrupted')
    .sort((a, b) => a.createdAt - b.createdAt);
  const stale = manifests
    .filter(
      (m) =>
        m.verifiedAt !== undefined &&
        m.verifyStatus !== 'corrupted' &&
        now - m.verifiedAt >= recheckAfterMs,
    )
    .sort((a, b) => (a.verifiedAt ?? 0) - (b.verifiedAt ?? 0));
  return [...never, ...stale];
}
