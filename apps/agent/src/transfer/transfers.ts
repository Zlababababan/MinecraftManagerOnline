/**
 * Transferts binaires côté agent (jalon C, doc 05 §8) sur le WebSocket de session :
 * - `fs.download.start` : fichier du serveur (jailé) ou archive de backup → `TransferSender`
 *   (chunks 1 Mo, fenêtre 8, priorité basse via `bufferedAmount`), reprise par `offset` (le panel
 *   relance avec l'offset qu'il détient ; le SHA-256 final couvre le fichier entier) ;
 * - `fs.upload.start` : `TransferReceiver` → `<cible>.<transferId>.part` (reprise = taille du
 *   `.part`), `fs.transfer.done` vérifie taille + SHA-256 puis renomme ;
 * - `fs.fetch` (task) : téléchargement HTTP d'une URL dans le dossier du serveur (spark en un clic).
 * À la perte de session, les transferts en cours sont abandonnés (les `.part` restent pour la reprise).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  ProtocolError,
  TRANSFER_CHUNK_SIZE,
  TRANSFER_WINDOW_CHUNKS,
  TransferReceiver,
  TransferSender,
  decodeFrame,
  type Compression,
  type ParsedRequestPayload,
} from '@mmo/protocol';
import { chunkCodec, effectiveCompression, sha256Hasher } from '@mmo/shared/node';

import type { AgentPeer } from '../connection/connection.js';
import { errorMessage, type Logger } from '../log.js';
import type { ServerManager } from '../minecraft/server-manager.js';
import type { BackupService } from '../backup/backup-service.js';
import type { TaskContext } from '../tasks/runner.js';

export interface AgentTransfersOptions {
  manager: ServerManager;
  backups: BackupService;
  logger: Logger;
  /** Codecs acceptés par la session courante (négociés à `auth.hello`). */
  sessionCompression: () => Compression | undefined;
  fetchImpl?: typeof fetch;
}

interface Download {
  sender: TransferSender;
  peer: AgentPeer;
}

interface DownloadStarted {
  size: number;
  modifiedAt: number;
  chunkSize: number;
  compression: Compression;
  fileName: string;
}

interface Upload {
  receiver: TransferReceiver;
  handle: FileHandle;
  partPath: string;
  finalPath: string;
  overwrite: boolean;
  peer: AgentPeer;
}

export class AgentTransfers {
  private readonly downloads = new Map<string, Download>();
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly options: AgentTransfersOptions) {}

  get activeCount(): number {
    return this.downloads.size + this.uploads.size;
  }

  /** Enregistre handlers et réception binaire sur un nouveau pair de session. */
  bind(peer: AgentPeer): void {
    peer.onBinary((data) => {
      const frame = decodeFrame(data);
      if (!frame) return;
      this.uploads.get(frame.transferId)?.receiver.onFrame(frame);
    });
    peer.on('fs.transfer.ack', ({ transferId, offset }) => {
      this.downloads.get(transferId)?.sender.onAck(offset);
    });
    peer.on('fs.transfer.cancel', ({ transferId }) => {
      void this.cancel(transferId);
    });
    peer
      .handle('fs.download.start', (p) => this.startDownload(peer, p))
      .handle('fs.upload.start', (p) => this.startUpload(peer, p))
      .handle('fs.transfer.done', (p) => this.finishUpload(p));
  }

  /** Session perdue : abandonne les transferts en cours (reprise par offset à la prochaine session). */
  async detachAll(): Promise<void> {
    for (const [id, d] of this.downloads) {
      d.sender.cancel(new ProtocolError('E_INTERRUPTED', 'session closed', { retryable: true }));
      this.downloads.delete(id);
    }
    for (const [id, u] of this.uploads) {
      u.receiver.cancel(new ProtocolError('E_INTERRUPTED', 'session closed', { retryable: true }));
      await u.receiver.settle().catch(() => undefined);
      await u.handle.close().catch(() => undefined);
      this.uploads.delete(id);
    }
  }

  async cancel(transferId: string): Promise<void> {
    const d = this.downloads.get(transferId);
    if (d) {
      d.sender.cancel();
      this.downloads.delete(transferId);
    }
    const u = this.uploads.get(transferId);
    if (u) {
      u.receiver.cancel();
      await u.receiver.settle().catch(() => undefined);
      await u.handle.close().catch(() => undefined);
      await rm(u.partPath, { force: true }).catch(() => undefined);
      this.uploads.delete(transferId);
    }
  }

  // --- Téléchargement (agent → panel) ---------------------------------------------------------------

  private async startDownload(
    peer: AgentPeer,
    p: ParsedRequestPayload<'fs.download.start'>,
  ): Promise<DownloadStarted> {
    if (this.downloads.has(p.transferId)) {
      throw new ProtocolError('E_CONFLICT', 'transfer already active', {
        details: { transferId: p.transferId },
      });
    }
    let abs: string;
    if (p.backupId !== undefined) {
      abs = (await this.options.backups.find(p.serverId, p.backupId)).archivePath;
    } else {
      abs = await this.options.manager.files(p.serverId).jail.resolveChecked(p.path ?? '');
    }
    const st = await stat(abs).catch(() => undefined);
    if (!st?.isFile()) {
      throw new ProtocolError('E_NOT_FOUND', 'file not found', { details: { path: p.path } });
    }
    if (p.offset > st.size) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'offset beyond end of file', {
        details: { offset: p.offset, size: st.size },
      });
    }
    const compression = this.negotiate(p.compression);
    const chunkSize = p.chunkSize ?? TRANSFER_CHUNK_SIZE;
    // Le SHA-256 final couvre le fichier entier : le préfixe [0, offset) est haché avant l'émission.
    const hash = createHash('sha256');
    const sender = new TransferSender(
      {
        transferId: p.transferId,
        chunkSize,
        windowChunks: TRANSFER_WINDOW_CHUNKS,
        codec: chunkCodec(compression),
        hash: () => ({ update: (d) => hash.update(d), digest: () => hash.digest('hex') }),
        sendFrame: (frame) => {
          peer.sendBinary(frame);
        },
        bufferedAmount: () => peer.bufferedAmount(),
      },
      p.offset,
    );
    this.downloads.set(p.transferId, { sender, peer });
    // La réponse part d'abord ; l'émission commence au tick suivant.
    setTimeout(() => {
      void this.runDownload(peer, p.transferId, sender, abs, p.offset, st.size, hash);
    }, 0);
    return {
      size: st.size,
      modifiedAt: Math.round(st.mtimeMs),
      chunkSize,
      compression,
      fileName: path.basename(abs),
    };
  }

  private async runDownload(
    peer: AgentPeer,
    transferId: string,
    sender: TransferSender,
    abs: string,
    offset: number,
    size: number,
    hash: ReturnType<typeof createHash>,
  ): Promise<void> {
    const stream =
      offset >= size
        ? Readable.from([])
        : createReadStream(abs, { start: offset, highWaterMark: TRANSFER_CHUNK_SIZE });
    try {
      if (offset > 0) {
        const prefix = createReadStream(abs, {
          end: offset - 1,
          highWaterMark: TRANSFER_CHUNK_SIZE,
        });
        for await (const chunk of prefix) hash.update(chunk as Buffer);
      }
      await sender.run(stream as AsyncIterable<Uint8Array>);
      if (this.downloads.get(transferId)?.sender !== sender) return;
      await peer.request(
        'fs.transfer.done',
        { transferId, size, sha256: sender.sha256 },
        { deadlineMs: 120_000 },
      );
    } catch (error) {
      if (!(error instanceof ProtocolError && error.code === 'E_CANCELLED')) {
        this.options.logger.warn('download transfer ended with error', {
          transferId,
          error: errorMessage(error),
        });
      }
    } finally {
      stream.destroy();
      if (this.downloads.get(transferId)?.sender === sender) this.downloads.delete(transferId);
    }
  }

  // --- Téléversement (panel → agent) ---------------------------------------------------------------

  private async startUpload(
    peer: AgentPeer,
    p: ParsedRequestPayload<'fs.upload.start'>,
  ): Promise<{ offset: number; chunkSize: number; compression: Compression }> {
    const existing = this.uploads.get(p.transferId);
    if (existing) {
      // Reprise sur la même session (ou rejeu) : on repart de ce qui est écrit.
      await existing.receiver.settle().catch(() => undefined);
      await existing.handle.close().catch(() => undefined);
      this.uploads.delete(p.transferId);
    }
    const finalPath = await this.options.manager.files(p.serverId).jail.resolveChecked(p.path);
    if (!p.overwrite && (await exists(finalPath))) {
      throw new ProtocolError('E_CONFLICT', 'target file exists', { details: { path: p.path } });
    }
    const partPath = `${finalPath}.${p.transferId}.part`;
    const partStat = await stat(partPath).catch(() => undefined);
    const offset = partStat?.isFile() ? Math.min(partStat.size, p.size) : 0;
    const compression = this.negotiate(p.compression);
    const chunkSize = p.chunkSize ?? TRANSFER_CHUNK_SIZE;
    const handle = await open(partPath, offset > 0 ? 'r+' : 'w');
    if (offset > 0 && partStat && partStat.size > offset) await handle.truncate(offset);
    const receiver = new TransferReceiver(
      {
        transferId: p.transferId,
        codec: chunkCodec(compression),
        hash: sha256Hasher,
        write: async (data, at) => {
          await handle.write(data, 0, data.byteLength, at);
        },
        sendAck: (acked) => {
          try {
            peer.emit('fs.transfer.ack', { transferId: p.transferId, offset: acked });
          } catch {
            // session fermée : l'émetteur reprendra par offset
          }
        },
      },
      offset,
    );
    if (offset > 0) {
      const prefix = createReadStream(partPath, { end: offset - 1 });
      for await (const chunk of prefix) receiver.seed(chunk as Buffer);
    }
    this.uploads.set(p.transferId, {
      receiver,
      handle,
      partPath,
      finalPath,
      overwrite: p.overwrite,
      peer,
    });
    return { offset, chunkSize, compression };
  }

  private async finishUpload(
    p: ParsedRequestPayload<'fs.transfer.done'>,
  ): Promise<{ verified: true }> {
    const u = this.uploads.get(p.transferId);
    if (!u) {
      throw new ProtocolError('E_NOT_FOUND', 'unknown transfer', {
        details: { transferId: p.transferId },
      });
    }
    try {
      await u.receiver.finish(p.size, p.sha256);
      await u.handle.close();
      if (!u.overwrite && (await exists(u.finalPath))) {
        throw new ProtocolError('E_CONFLICT', 'target file exists');
      }
      await rm(u.finalPath, { force: true });
      await rename(u.partPath, u.finalPath);
      return { verified: true };
    } catch (error) {
      await u.handle.close().catch(() => undefined);
      if (error instanceof ProtocolError && error.code === 'E_CHECKSUM_MISMATCH') {
        await rm(u.partPath, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.uploads.delete(p.transferId);
    }
  }

  // --- fs.fetch (task) ----------------------------------------------------------------------------

  /** Exécuteur de la task `fs.fetch` : télécharge `url` vers `path` (jailé), vérifie sha256/sha1 si fournis. */
  async fetchToServer(
    req: Omit<ParsedRequestPayload<'fs.fetch'>, 'taskId'>,
    ctx: TaskContext,
  ): Promise<{ path: string; size: number; sha256: string }> {
    const finalPath = await this.options.manager.files(req.serverId).jail.resolveChecked(req.path);
    if (!req.overwrite && (await exists(finalPath))) {
      throw new ProtocolError('E_CONFLICT', 'target file exists', { details: { path: req.path } });
    }
    const partPath = `${finalPath}.${ctx.taskId}.part`;
    ctx.artifact(partPath);
    await ctx.checkpoint();
    ctx.progress('downloading', 0, req.url);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(req.url, { signal: ctx.signal, redirect: 'follow' });
    } catch (error) {
      if (ctx.isCancelled) throw new ProtocolError('E_CANCELLED', 'fetch cancelled');
      throw new ProtocolError('E_IO', `download failed: ${errorMessage(error)}`, { cause: error });
    }
    if (!response.ok || !response.body) {
      throw new ProtocolError('E_IO', `download failed: HTTP ${String(response.status)}`, {
        details: { status: response.status, url: req.url },
      });
    }
    const total = req.size ?? Number(response.headers.get('content-length') ?? 0);
    const sha256 = createHash('sha256');
    const sha1 = createHash('sha1');
    let size = 0;
    const handle = await open(partPath, 'w');
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        ctx.throwIfCancelled();
        await handle.write(chunk);
        sha256.update(chunk);
        sha1.update(chunk);
        size += chunk.byteLength;
        ctx.progress(
          'downloading',
          total > 0 ? Math.min(99, (size / total) * 100) : undefined,
          `${String(size)} B`,
        );
      }
    } finally {
      await handle.close();
    }
    const digest256 = sha256.digest('hex');
    const digest1 = sha1.digest('hex');
    if (
      (req.sha256 !== undefined && req.sha256.toLowerCase() !== digest256) ||
      (req.sha1 !== undefined && req.sha1.toLowerCase() !== digest1) ||
      (req.size !== undefined && req.size !== size)
    ) {
      await rm(partPath, { force: true });
      throw new ProtocolError('E_CHECKSUM_MISMATCH', 'downloaded file does not match', {
        retryable: true,
        details: { sha256: digest256, sha1: digest1, size },
      });
    }
    ctx.progress('finalizing', 99);
    await rm(finalPath, { force: true });
    await rename(partPath, finalPath);
    ctx.keep(partPath);
    return { path: req.path, size, sha256: digest256 };
  }

  private negotiate(requested: Compression | undefined): Compression {
    const session = this.options.sessionCompression();
    const wanted = requested ?? session ?? 'none';
    // Jamais un codec que la session n'a pas négocié (le pair ne saurait pas le lire).
    if (session === undefined || session === 'none') return 'none';
    if (wanted === 'zstd' && session !== 'zstd') return effectiveCompression('gzip');
    return effectiveCompression(wanted);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
