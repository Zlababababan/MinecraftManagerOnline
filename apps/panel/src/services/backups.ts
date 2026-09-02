/**
 * Backups côté panel (doc 04 §5 `backups`, `backup_policies` ; doc 05 §6) : la table reflète les
 * archives présentes sur les machines — alimentée par les résultats de tasks (`backup.create`,
 * `backup.restore` → backup de sécurité), par `backup.rotated` (rotation locale de l'agent) et par
 * `backup.list` à chaque reconnexion (un backup planifié exécuté panel éteint apparaît ici sans
 * autre intervention). Les politiques sont poussées à l'agent (`agent.configure.backupSchedules`)
 * qui les exécute seul.
 */
import { backupManifestSchema, ulid, type BackupManifest } from '@mmo/protocol';
import type { BackupDto, BackupPolicyDto, BackupPolicyInput } from '@mmo/protocol/client';
import { nextCronRun } from '@mmo/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { backupPolicies, backups, type BackupPolicyRow, type BackupRow } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { parseJson, toJson } from '../util/json.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

export interface BackupsServiceDeps {
  db: MmoDatabase;
  now: () => number;
  settings: SettingsService;
  broadcast: (backup: BackupDto) => void;
  /**
   * Lot 4 : une archive vient d'être déclarée corrompue (elle ne l'était pas avant) — par
   * `backup.verified` en direct ou par un manifeste relu à la reconnexion. Une seule fois par
   * archive : le verdict ne change plus tant qu'elle n'est pas supprimée.
   */
  onCorrupted?: (row: BackupRow) => void;
}

interface ManifestExtras {
  codec?: 'zstd' | 'gzip';
  hot?: boolean;
  files?: number;
  bytesRaw?: number;
  comment?: string;
}

export const DEFAULT_POLICY = { cron: '0 4 * * *', keepLast: 7, onlyIfRunning: true } as const;

/** Les colonnes d'état n'ont pas de CHECK (une contrainte ajoutée reconstruirait la table). */
function isPolicyStatus(value: string | null): value is 'success' | 'failed' | 'skipped' {
  return value === 'success' || value === 'failed' || value === 'skipped';
}

function isVerifyStatus(value: string | null): value is 'ok' | 'corrupted' {
  return value === 'ok' || value === 'corrupted';
}

export class BackupsService {
  constructor(private readonly deps: BackupsServiceDeps) {}

  // --- Lecture --------------------------------------------------------------------------------

  get(id: string): BackupRow | undefined {
    return this.deps.db.select().from(backups).where(eq(backups.id, id)).get();
  }

  require(id: string): BackupRow {
    const row = this.get(id);
    if (!row) throw notFound('backup', id);
    return row;
  }

  list(serverId: string, includeDeleted = false): BackupRow[] {
    return this.deps.db
      .select()
      .from(backups)
      .where(
        includeDeleted
          ? eq(backups.serverId, serverId)
          : and(
              eq(backups.serverId, serverId),
              inArray(backups.status, ['running', 'success', 'failed']),
            ),
      )
      .orderBy(desc(backups.startedAt))
      .all();
  }

  toDto(row: BackupRow): BackupDto {
    const extras = parseJson<ManifestExtras>(row.manifestJson, {});
    return {
      id: row.id,
      serverId: row.serverId,
      policyId: row.policyId,
      kind: row.kind,
      status: row.status,
      machineId: row.machineId,
      archivePath: row.archivePath,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: row.error,
      createdBy: row.createdBy,
      codec: extras.codec ?? null,
      hot: extras.hot ?? null,
      files: extras.files ?? null,
      bytesRaw: extras.bytesRaw ?? null,
      comment: extras.comment ?? null,
      taskId: row.taskId,
      verifiedAt: row.verifiedAt,
      verifyStatus: isVerifyStatus(row.verifyStatus) ? row.verifyStatus : null,
    };
  }

  /** Destination effective d'un serveur : politique > réglage global > défaut agent (null). */
  defaultDestination(): string | undefined {
    const v = this.deps.settings.get(SETTING_KEYS.backupDestination);
    return v === undefined || v === '' ? undefined : v;
  }

  // --- Cycle de vie ---------------------------------------------------------------------------

  /** Ligne `running` créée **avant** l'ordre à l'agent. */
  start(input: {
    id?: string | undefined;
    serverId: string;
    machineId: string;
    kind: BackupRow['kind'];
    policyId?: string | undefined;
    taskId: string;
    createdBy?: string | undefined;
    comment?: string | undefined;
  }): BackupRow {
    const id = input.id ?? ulid(this.deps.now());
    this.deps.db
      .insert(backups)
      .values({
        id,
        serverId: input.serverId,
        policyId: input.policyId ?? null,
        kind: input.kind,
        status: 'running',
        machineId: input.machineId,
        startedAt: this.deps.now(),
        createdBy: input.createdBy ?? null,
        taskId: input.taskId,
        manifestJson: input.comment === undefined ? null : toJson({ comment: input.comment }),
      })
      .run();
    const row = this.require(id);
    this.deps.broadcast(this.toDto(row));
    return row;
  }

  /** Archive terminée (résultat de task, réconciliation, planning agent) : insère ou met à jour. */
  applyManifest(
    manifest: BackupManifest,
    machineId: string,
    options: { taskId?: string | undefined; createdBy?: string | undefined } = {},
  ): BackupRow {
    const existing = this.get(manifest.backupId);
    const extras: ManifestExtras = {
      codec: manifest.codec,
      hot: manifest.hot,
      files: manifest.files,
      bytesRaw: manifest.bytesRaw,
      ...(manifest.comment === undefined ? {} : { comment: manifest.comment }),
    };
    const values = {
      status: 'success' as const,
      machineId,
      archivePath: manifest.archivePath,
      sizeBytes: manifest.sizeBytes,
      sha256: manifest.sha256,
      finishedAt: manifest.createdAt,
      error: null,
      manifestJson: toJson(extras),
      policyId: manifest.policyId ?? existing?.policyId ?? null,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      // Le manifeste fait foi quand il porte un verdict ; un manifeste d'agent N-1 n'en a pas et
      // ne doit pas effacer ce que le panel a appris par `backup.verified`.
      ...(manifest.verifiedAt === undefined
        ? {}
        : { verifiedAt: manifest.verifiedAt, verifyStatus: manifest.verifyStatus ?? null }),
    };
    if (existing) {
      this.deps.db.update(backups).set(values).where(eq(backups.id, existing.id)).run();
    } else {
      this.deps.db
        .insert(backups)
        .values({
          id: manifest.backupId,
          serverId: manifest.serverId,
          kind: manifest.kind,
          startedAt: manifest.createdAt,
          createdBy: options.createdBy ?? null,
          taskId: options.taskId ?? null,
          ...values,
        })
        .run();
    }
    const row = this.require(manifest.backupId);
    this.deps.broadcast(this.toDto(row));
    this.noteCorruption(existing, row);
    return row;
  }

  /**
   * Lot 4 : verdict d'une relecture d'archive (`backup.verified`, non critique — voir le
   * manifeste pour le rattrapage). Une archive inconnue du panel est ignorée : `backup.list` la
   * fera connaître à la prochaine reconnexion, verdict compris.
   */
  recordVerification(
    backupId: string,
    verdict: { ok: boolean; at: number },
  ): BackupRow | undefined {
    const existing = this.get(backupId);
    if (existing?.status !== 'success') return undefined;
    this.deps.db
      .update(backups)
      .set({ verifiedAt: verdict.at, verifyStatus: verdict.ok ? 'ok' : 'corrupted' })
      .where(eq(backups.id, backupId))
      .run();
    const row = this.require(backupId);
    this.deps.broadcast(this.toDto(row));
    this.noteCorruption(existing, row);
    return row;
  }

  private noteCorruption(before: BackupRow | undefined, after: BackupRow): void {
    if (after.verifyStatus === 'corrupted' && before?.verifyStatus !== 'corrupted') {
      this.deps.onCorrupted?.(after);
    }
  }

  fail(id: string, error: string): BackupRow | undefined {
    const row = this.get(id);
    if (row?.status !== 'running') return row;
    this.deps.db
      .update(backups)
      .set({ status: 'failed', error, finishedAt: this.deps.now() })
      .where(eq(backups.id, id))
      .run();
    const updated = this.require(id);
    this.deps.broadcast(this.toDto(updated));
    return updated;
  }

  markDeleted(ids: string[]): BackupRow[] {
    const out: BackupRow[] = [];
    for (const id of ids) {
      const row = this.get(id);
      if (!row || row.status === 'deleted') continue;
      this.deps.db
        .update(backups)
        .set({ status: 'deleted', finishedAt: row.finishedAt ?? this.deps.now() })
        .where(eq(backups.id, id))
        .run();
      const updated = this.require(id);
      out.push(updated);
      this.deps.broadcast(this.toDto(updated));
    }
    return out;
  }

  /**
   * Purge par rétention (doc 04 §8.6) des fiches `deleted` (archive rotée par l'agent ou disparue
   * du disque) — jamais celles qu'une migration référence encore (`server_migrations.backup_id`
   * est une clé étrangère sans ON DELETE). Rend le nombre de lignes supprimées.
   */
  purgeDeletedBefore(ts: number): number {
    return this.deps.db
      .delete(backups)
      .where(
        and(
          eq(backups.status, 'deleted'),
          lt(sql`coalesce(${backups.finishedAt}, ${backups.startedAt})`, ts),
          sql`NOT EXISTS (SELECT 1 FROM server_migrations WHERE backup_id = ${backups.id})`,
        ),
      )
      .run().changes;
  }

  /** Dossiers où chercher en plus de la destination courante (anciennes destinations connues). */
  knownDestinations(serverId: string): string[] {
    const dirs = new Set<string>();
    for (const row of this.list(serverId, true)) {
      if (row.archivePath === null) continue;
      const parent = row.archivePath.replace(/[\\/][^\\/]+[\\/][^\\/]+$/, '');
      if (parent !== '' && parent !== row.archivePath) dirs.add(parent);
    }
    return [...dirs];
  }

  /**
   * Réconciliation avec le disque (`backup.list`) : archives inconnues insérées, lignes `success`
   * dont l'archive a disparu marquées `deleted`. Retourne les lignes modifiées.
   */
  reconcile(serverId: string, machineId: string, manifests: unknown[]): BackupRow[] {
    const changed: BackupRow[] = [];
    const seen = new Set<string>();
    for (const raw of manifests) {
      const parsed = backupManifestSchema.safeParse(raw);
      if (!parsed.success || parsed.data.serverId !== serverId) continue;
      const m = parsed.data;
      seen.add(m.backupId);
      const existing = this.get(m.backupId);
      if (
        existing?.status === 'success' &&
        existing.sha256 === m.sha256 &&
        (m.verifiedAt === undefined ||
          (existing.verifiedAt === m.verifiedAt &&
            existing.verifyStatus === (m.verifyStatus ?? null)))
      ) {
        continue;
      }
      changed.push(this.applyManifest(m, machineId));
    }
    for (const row of this.list(serverId)) {
      if (row.status !== 'success' || seen.has(row.id)) continue;
      changed.push(...this.markDeleted([row.id]));
    }
    return changed;
  }

  // --- Politiques (plannings agent) ----------------------------------------------------------

  listPolicies(serverId: string): BackupPolicyRow[] {
    return this.deps.db
      .select()
      .from(backupPolicies)
      .where(eq(backupPolicies.serverId, serverId))
      .orderBy(backupPolicies.createdAt)
      .all();
  }

  getPolicy(id: string): BackupPolicyRow | undefined {
    return this.deps.db.select().from(backupPolicies).where(eq(backupPolicies.id, id)).get();
  }

  requirePolicy(id: string): BackupPolicyRow {
    const row = this.getPolicy(id);
    if (!row) throw notFound('backup policy', id);
    return row;
  }

  policyToDto(row: BackupPolicyRow): BackupPolicyDto {
    return {
      id: row.id,
      serverId: row.serverId,
      cron: row.cron,
      destination: row.destination,
      keepLast: row.keepLast,
      keepDays: row.keepDays,
      onlyIfRunning: row.onlyIfRunning === 1,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      nextRunAt:
        row.enabled === 1
          ? (nextCronRun(row.cron, this.deps.now(), this.deps.settings.timeZone()) ?? null)
          : null,
      lastRunAt: row.lastRunAt,
      lastStatus: isPolicyStatus(row.lastStatus) ? row.lastStatus : null,
      lastError: row.lastError,
      overdueSince: row.overdueSince,
    };
  }

  /**
   * Enregistre l'issue d'une occurrence. C'est le seul endroit qui écrit l'état d'une politique :
   * `success` et `skipped` prouvent tous deux que le planning tourne (un serveur arrêté sous
   * `onlyIfRunning` se comporte exactement comme prévu), donc les deux lèvent le retard.
   */
  recordPolicyRun(
    policyId: string,
    outcome:
      | { status: 'success'; at: number; backupId: string }
      | { status: 'failed'; at: number; error: string }
      | { status: 'skipped'; at: number; reason: string },
  ): BackupPolicyRow | undefined {
    if (this.getPolicy(policyId) === undefined) return undefined;
    this.deps.db
      .update(backupPolicies)
      .set({
        lastRunAt: outcome.at,
        lastStatus: outcome.status,
        lastBackupId: outcome.status === 'success' ? outcome.backupId : null,
        lastError:
          outcome.status === 'failed'
            ? outcome.error.slice(0, 500)
            : outcome.status === 'skipped'
              ? outcome.reason
              : null,
        overdueSince: null,
      })
      .where(eq(backupPolicies.id, policyId))
      .run();
    return this.getPolicy(policyId);
  }

  /**
   * Politiques dont l'occurrence attendue n'est jamais arrivée, à la tolérance près, et qui ne
   * sont pas déjà signalées. Base de calcul : la dernière exécution connue, sinon la création —
   * une politique ajoutée il y a cinq minutes n'est pas « en retard » de sa première occurrence.
   */
  overduePolicies(now: number, graceMs: number): BackupPolicyRow[] {
    return this.deps.db
      .select()
      .from(backupPolicies)
      .where(and(eq(backupPolicies.enabled, 1), isNull(backupPolicies.overdueSince)))
      .all()
      .filter((row) => {
        const expected = nextCronRun(
          row.cron,
          row.lastRunAt ?? row.createdAt,
          this.deps.settings.timeZone(),
        );
        return expected !== undefined && now > expected + graceMs;
      });
  }

  /** Marque le retard (une seule fois : `recordPolicyRun` le lève au prochain passage). */
  markOverdue(policyId: string, at: number): void {
    this.deps.db
      .update(backupPolicies)
      .set({ overdueSince: at })
      .where(eq(backupPolicies.id, policyId))
      .run();
  }

  /**
   * Politique par défaut d'un nouveau serveur : quotidienne à 04h00, 7 archives conservées,
   * seulement si le serveur tourne (un serveur arrêté ne change pas — pas d'archives dupliquées).
   * Politique ordinaire ensuite : l'utilisateur la modifie ou la supprime librement.
   */
  seedDefaultPolicy(serverId: string): BackupPolicyRow {
    return this.createPolicy(serverId, {
      cron: DEFAULT_POLICY.cron,
      keepLast: DEFAULT_POLICY.keepLast,
      onlyIfRunning: DEFAULT_POLICY.onlyIfRunning,
    });
  }

  hasPolicies(serverId: string): boolean {
    return (
      this.deps.db
        .select({ id: backupPolicies.id })
        .from(backupPolicies)
        .where(eq(backupPolicies.serverId, serverId))
        .get() !== undefined
    );
  }

  createPolicy(serverId: string, input: BackupPolicyInput): BackupPolicyRow {
    validateCron(input.cron);
    const id = ulid(this.deps.now());
    this.deps.db
      .insert(backupPolicies)
      .values({
        id,
        serverId,
        cron: input.cron,
        destination: input.destination ?? null,
        keepLast: input.keepLast ?? null,
        keepDays: input.keepDays ?? null,
        onlyIfRunning: input.onlyIfRunning ? 1 : 0,
        enabled: input.enabled === false ? 0 : 1,
        createdAt: this.deps.now(),
      })
      .run();
    return this.requirePolicy(id);
  }

  updatePolicy(id: string, input: PartialInput<BackupPolicyInput>): BackupPolicyRow {
    this.requirePolicy(id);
    if (input.cron !== undefined) validateCron(input.cron);
    this.deps.db
      .update(backupPolicies)
      .set({
        ...(input.cron === undefined ? {} : { cron: input.cron }),
        ...(input.destination === undefined ? {} : { destination: input.destination }),
        ...(input.keepLast === undefined ? {} : { keepLast: input.keepLast }),
        ...(input.keepDays === undefined ? {} : { keepDays: input.keepDays }),
        ...(input.onlyIfRunning === undefined
          ? {}
          : { onlyIfRunning: input.onlyIfRunning ? 1 : 0 }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled ? 1 : 0 }),
      })
      .where(eq(backupPolicies.id, id))
      .run();
    return this.requirePolicy(id);
  }

  deletePolicy(id: string): void {
    this.requirePolicy(id);
    this.deps.db.delete(backupPolicies).where(eq(backupPolicies.id, id)).run();
  }

  /** Plannings poussés à l'agent d'une machine (`agent.configure.backupSchedules`). */
  schedulesFor(serverIds: string[]) {
    if (serverIds.length === 0) return [];
    // Le fuseau part AVEC la politique : l'agent ne peut pas le deviner, et le sien est souvent
    // UTC là où l'utilisateur raisonne en heure locale.
    const timezone = this.deps.settings.timeZone();
    return this.deps.db
      .select()
      .from(backupPolicies)
      .where(inArray(backupPolicies.serverId, serverIds))
      .all()
      .map((p) => ({
        id: p.id,
        serverId: p.serverId,
        cron: p.cron,
        timezone,
        ...(p.keepLast === null ? {} : { keep: p.keepLast }),
        ...(p.keepDays === null ? {} : { keepDays: p.keepDays }),
        onlyIfRunning: p.onlyIfRunning === 1,
        ...(p.destination === null ? {} : { destination: p.destination }),
        enabled: p.enabled === 1,
      }));
  }
}

/** Patch partiel (`exactOptionalPropertyTypes` : `undefined` explicite autorisé). */
export type PartialInput<T> = { [K in keyof T]?: T[K] | undefined };

function validateCron(expression: string): void {
  if (nextCronRun(expression, 0) === undefined) {
    throw new AppError('E_VALIDATION', 'invalid cron expression', {
      details: { field: 'cron', value: expression },
    });
  }
}
