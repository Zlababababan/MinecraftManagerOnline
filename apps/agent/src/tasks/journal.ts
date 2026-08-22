/**
 * Journal write-ahead des tasks (doc 05 §6 « Tasks », §10) : `tasks.json` dans le dossier d'état,
 * écrit **avant** chaque changement de phase. Au redémarrage de l'agent, une task encore `running`
 * est interrompue : artefacts partiels nettoyés, `task.failed { E_INTERRUPTED, retryable }` émis
 * (la reprise par offset des transferts est portée par le panel, qui relance avec l'offset connu).
 * Les tasks terminées restent listables (`task.list`) jusqu'à `task.ackResult`, au plus 7 jours.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { protocolErrorSchema, taskStatusSchema, type TaskInfo } from '@mmo/protocol';

export const taskRecordSchema = z.object({
  taskId: z.string(),
  kind: z.string(),
  serverId: z.string().optional(),
  status: taskStatusSchema,
  phase: z.string().optional(),
  pct: z.number().optional(),
  detail: z.string().optional(),
  startedAt: z.int(),
  updatedAt: z.int(),
  finishedAt: z.int().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: protocolErrorSchema.optional(),
  cancelled: z.boolean().optional(),
  /** Requête d'origine (diagnostic, reprise). */
  payload: z.unknown().optional(),
  /** Fichiers partiels à supprimer si la task est interrompue. */
  artifacts: z.array(z.string()).default([]),
  /** Résultat acquitté par le panel (`task.ackResult`) : purgeable. */
  acked: z.boolean().default(false),
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

const journalSchema = z.object({
  version: z.literal(1),
  tasks: z.record(z.string(), taskRecordSchema).default({}),
});

export const TASKS_FILE = 'tasks.json';
const RETENTION_MS = 7 * 24 * 3600_000;

export class TaskJournal {
  readonly file: string;
  private tasks: Record<string, TaskRecord> = {};
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.file = path.join(dir, TASKS_FILE);
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let text: string | undefined;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      text = undefined;
    }
    this.tasks = {};
    if (text === undefined) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = journalSchema.safeParse(json);
    if (parsed.success) {
      this.tasks = parsed.data.tasks;
    } else {
      await rename(this.file, `${this.file}.corrupt-${String(this.now())}`).catch(() => undefined);
    }
    this.purge();
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks[taskId];
  }

  all(): TaskRecord[] {
    return Object.values(this.tasks);
  }

  /** Tasks non terminées (au boot : à interrompre). */
  running(): TaskRecord[] {
    return this.all().filter((t) => t.status === 'running' || t.status === 'pending');
  }

  /** Écrit immédiatement (write-ahead) — à utiliser avant d'exécuter une étape irréversible. */
  async put(record: TaskRecord): Promise<void> {
    this.tasks[record.taskId] = record;
    await this.save();
  }

  /** Mise à jour légère (progression) : écriture différée et coalescée (≤ 1/s). */
  patch(taskId: string, mutate: (record: TaskRecord) => void): TaskRecord | undefined {
    const r = this.tasks[taskId];
    if (!r) return undefined;
    mutate(r);
    r.updatedAt = this.now();
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 1000);
    this.timer.unref();
    return r;
  }

  remove(taskId: string): void {
    if (taskId in this.tasks) {
      const { [taskId]: _removed, ...rest } = this.tasks;
      this.tasks = rest;
      this.dirty = true;
    }
  }

  /** Oublie les tasks acquittées ou terminées depuis plus de 7 jours. */
  purge(): void {
    const limit = this.now() - RETENTION_MS;
    for (const t of this.all()) {
      const finished = t.status !== 'running' && t.status !== 'pending';
      if (finished && (t.acked || (t.finishedAt ?? t.updatedAt) < limit)) this.remove(t.taskId);
    }
  }

  async flush(): Promise<void> {
    if (this.dirty) await this.save();
  }

  async save(): Promise<void> {
    this.dirty = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.writing = this.writing.then(() => this.writeNow());
    await this.writing;
  }

  toInfo(record: TaskRecord): TaskInfo {
    return {
      taskId: record.taskId,
      kind: record.kind,
      ...(record.serverId === undefined ? {} : { serverId: record.serverId }),
      status: record.status,
      ...(record.phase === undefined ? {} : { phase: record.phase }),
      ...(record.pct === undefined ? {} : { pct: record.pct }),
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  private async writeNow(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, tasks: this.tasks }, null, 2) + '\n';
    const tmp = `${this.file}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, snapshot);
      await rename(tmp, this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
