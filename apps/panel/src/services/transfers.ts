/**
 * Transferts binaires côté panel (jalon C, doc 05 §8) : le panel est **récepteur** des downloads
 * (frames de l'agent → réponse HTTP en flux, contre-pression de bout en bout : l'ack suit l'écriture
 * dans la réponse) et **émetteur** des uploads (corps HTTP → frames vers l'agent, fenêtre 8 chunks).
 * Si la session de l'agent tombe en cours de route, le transfert attend la reconnexion (60 s) puis
 * reprend par offset : `fs.download.start { offset }` ou `fs.upload.start` (offset renvoyé par
 * l'agent = taille du `.part`), sans que le navigateur ne voie la coupure.
 */
import { randomBytes } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';

import {
  ProtocolError,
  TRANSFER_CHUNK_SIZE,
  TRANSFER_WINDOW_CHUNKS,
  TransferReceiver,
  TransferSender,
  decodeFrame,
  transferIdFromBytes,
  type Compression,
} from '@mmo/protocol';
import { chunkCodec, sha256Hasher } from '@mmo/shared/node';
import type { FastifyBaseLogger } from 'fastify';

import type { AgentRegistry } from '../agents/registry.js';
import type { AgentSession, PanelPeer } from '../agents/session.js';
import { AppError } from '../errors.js';

export interface TransferServiceDeps {
  registry: AgentRegistry;
  logger: FastifyBaseLogger;
  /** Attente maximale d'une reconnexion de l'agent (défaut 60 s). */
  reconnectWaitMs?: number;
}

export interface DownloadSource {
  serverId: string;
  path?: string | undefined;
  backupId?: string | undefined;
}

export interface DownloadHandle {
  stream: Readable;
  size: number;
  fileName: string;
  modifiedAt: number | undefined;
  transferId: string;
  /** Résout à la vérification finale (sha256) ou rejette. */
  done: Promise<{ sha256: string }>;
  cancel(): void;
}

interface ActiveDownload {
  receiver: TransferReceiver;
  peer: PanelPeer | undefined;
  settled: boolean;
  finished: (result: { sha256: string }) => void;
  failed: (error: ProtocolError) => void;
}

interface ActiveUpload {
  sender: TransferSender;
  peer: PanelPeer | undefined;
  finished: boolean;
}

const TRANSFER_DEADLINE_MS = 60_000;

export class TransferService {
  private readonly downloads = new Map<string, ActiveDownload>();
  private readonly uploads = new Map<string, ActiveUpload>();
  private readonly reconnectWaiters = new Map<string, Set<(session: AgentSession) => void>>();

  constructor(private readonly deps: TransferServiceDeps) {}

  get activeCount(): number {
    return this.downloads.size + this.uploads.size;
  }

  /** Nouvelle session d'agent : frames et événements de transfert routés vers les moteurs. */
  bind(session: AgentSession, machineId: string): void {
    const { peer } = session;
    peer.onBinary((data) => {
      const frame = decodeFrame(data);
      if (!frame) return;
      this.downloads.get(frame.transferId)?.receiver.onFrame(frame);
    });
    peer.on('fs.transfer.ack', ({ transferId, offset }) => {
      this.uploads.get(transferId)?.sender.onAck(offset);
    });
    peer.on('fs.transfer.cancel', ({ transferId }) => {
      const d = this.downloads.get(transferId);
      if (d) d.failed(new ProtocolError('E_CANCELLED', 'cancelled by agent'));
      this.uploads
        .get(transferId)
        ?.sender.cancel(new ProtocolError('E_CANCELLED', 'cancelled by agent'));
    });
    peer.handle('fs.transfer.done', async ({ transferId, size, sha256 }) => {
      const d = this.downloads.get(transferId);
      if (!d) {
        throw new ProtocolError('E_NOT_FOUND', 'unknown transfer', { details: { transferId } });
      }
      try {
        const result = await d.receiver.finish(size, sha256);
        d.finished(result);
        return { verified: true as const };
      } catch (error) {
        d.failed(
          error instanceof ProtocolError
            ? error
            : new ProtocolError('E_IO', error instanceof Error ? error.message : String(error)),
        );
        throw error;
      }
    });
    const waiters = this.reconnectWaiters.get(machineId);
    if (waiters) {
      this.reconnectWaiters.delete(machineId);
      for (const w of waiters) w(session);
    }
  }

  /** Session fermée : les transferts de cette machine se détachent en attendant la reconnexion. */
  onSessionClosed(peer: PanelPeer): void {
    for (const d of this.downloads.values()) if (d.peer === peer) d.peer = undefined;
    for (const u of this.uploads.values()) {
      if (u.peer === peer) {
        u.peer = undefined;
        u.sender.detach();
      }
    }
  }

  private waitForSession(machineId: string): Promise<AgentSession> {
    const current = this.deps.registry.get(machineId);
    if (current) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.reconnectWaiters.get(machineId)?.delete(onSession);
        reject(
          new AppError('E_AGENT_OFFLINE', 'agent did not reconnect in time', { retryable: true }),
        );
      }, this.deps.reconnectWaitMs ?? 60_000);
      const onSession = (session: AgentSession): void => {
        clearTimeout(timeout);
        resolve(session);
      };
      let set = this.reconnectWaiters.get(machineId);
      if (!set) {
        set = new Set();
        this.reconnectWaiters.set(machineId, set);
      }
      set.add(onSession);
    });
  }

  // --- Download (agent → panel → navigateur) ------------------------------------------------------

  async download(
    machineId: string,
    source: DownloadSource,
    options: { offset?: number | undefined; compression?: Compression | undefined } = {},
  ): Promise<DownloadHandle> {
    const transferId = transferIdFromBytes(randomBytes(16));
    const stream = new PassThrough({ highWaterMark: 4 * TRANSFER_CHUNK_SIZE });
    let codec = chunkCodec('none');
    let resolveDone: (r: { sha256: string }) => void = () => undefined;
    let rejectDone: (e: ProtocolError) => void = () => undefined;
    const done = new Promise<{ sha256: string }>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const active: ActiveDownload = {
      settled: false,
      peer: undefined,
      receiver: new TransferReceiver(
        {
          transferId,
          codec: { compress: (d) => codec.compress(d), decompress: (d) => codec.decompress(d) },
          hash: sha256Hasher,
          write: (data) =>
            new Promise<void>((resolve, reject) => {
              if (stream.destroyed) {
                reject(new Error('client went away'));
                return;
              }
              if (stream.write(data)) resolve();
              else stream.once('drain', resolve);
            }),
          sendAck: (offset) => {
            try {
              active.peer?.emit('fs.transfer.ack', { transferId, offset });
            } catch {
              // session fermée : reprise par offset
            }
          },
          onError: (error) => {
            active.failed(error);
          },
        },
        options.offset ?? 0,
      ),
      finished: (result) => {
        if (active.settled) return;
        active.settled = true;
        this.downloads.delete(transferId);
        stream.end();
        resolveDone(result);
      },
      failed: (error) => {
        if (active.settled) return;
        active.settled = true;
        this.downloads.delete(transferId);
        stream.destroy(error);
        rejectDone(error);
      },
    };
    this.downloads.set(transferId, active);
    // Le navigateur ferme la connexion : on annule côté agent.
    stream.on('close', () => {
      if (!active.settled) {
        const peer = active.peer;
        active.failed(new ProtocolError('E_CANCELLED', 'client closed the download'));
        try {
          peer?.emit('fs.transfer.cancel', { transferId, reason: 'client closed' });
        } catch {
          // ignorer
        }
      }
    });

    const start = async (session: AgentSession) => {
      active.peer = session.peer;
      const res = await session.peer.request(
        'fs.download.start',
        {
          transferId,
          serverId: source.serverId,
          ...(source.path === undefined ? {} : { path: source.path }),
          ...(source.backupId === undefined ? {} : { backupId: source.backupId }),
          offset: active.receiver.receivedOffset,
          ...(options.compression === undefined ? {} : { compression: options.compression }),
        },
        { deadlineMs: TRANSFER_DEADLINE_MS },
      );
      codec = chunkCodec(res.compression);
      return res;
    };

    let session = this.deps.registry.require(machineId);
    let first;
    try {
      first = await start(session);
    } catch (error) {
      active.failed(
        error instanceof ProtocolError ? error : new ProtocolError('E_IO', String(error)),
      );
      throw error;
    }
    // Reprise automatique tant que le navigateur attend : à chaque perte de session, on relance
    // depuis l'offset reçu (le hachage côté panel continue, l'agent recalcule le préfixe).
    void (async () => {
      while (!active.settled) {
        const current = active.peer;
        if (current === undefined || current.isClosed) {
          try {
            session = await this.waitForSession(machineId);
            await active.receiver.settle();
            await start(session);
          } catch (error) {
            active.failed(
              error instanceof ProtocolError
                ? error
                : new ProtocolError('E_INTERRUPTED', 'agent unavailable', { retryable: true }),
            );
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();

    return {
      stream,
      size: first.size,
      fileName: first.fileName ?? source.path?.split('/').pop() ?? 'download',
      modifiedAt: first.modifiedAt,
      transferId,
      done,
      cancel: () => {
        const peer = active.peer;
        active.failed(new ProtocolError('E_CANCELLED', 'download cancelled'));
        try {
          peer?.emit('fs.transfer.cancel', { transferId });
        } catch {
          // ignorer
        }
      },
    };
  }

  // --- Upload (navigateur → panel → agent) ------------------------------------------------------

  async upload(
    machineId: string,
    target: { serverId: string; path: string; size: number; overwrite: boolean },
    body: AsyncIterable<Uint8Array>,
    options: { compression?: Compression | undefined } = {},
  ): Promise<{ sha256: string; size: number }> {
    const transferId = transferIdFromBytes(randomBytes(16));
    let session = this.deps.registry.require(machineId);
    const startRequest = (s: AgentSession) =>
      s.peer.request(
        'fs.upload.start',
        {
          transferId,
          serverId: target.serverId,
          path: target.path,
          size: target.size,
          overwrite: target.overwrite,
          ...(options.compression === undefined ? {} : { compression: options.compression }),
        },
        { deadlineMs: TRANSFER_DEADLINE_MS },
      );
    const first = await startRequest(session);
    if (first.offset !== 0) {
      throw new AppError('E_CONFLICT', 'unexpected partial upload for a fresh transfer');
    }
    const codec = chunkCodec(first.compression);
    const sender = new TransferSender(
      {
        transferId,
        chunkSize: first.chunkSize,
        windowChunks: TRANSFER_WINDOW_CHUNKS,
        codec,
        hash: sha256Hasher,
        sendFrame: (frame) => {
          session.peer.sendBinary(frame);
        },
        bufferedAmount: () => session.peer.bufferedAmount(),
      },
      first.offset,
    );
    const active: ActiveUpload = { sender, peer: session.peer, finished: false };
    this.uploads.set(transferId, active);
    // Surveillance de la session : reprise après reconnexion.
    const watcher = (async () => {
      while (!active.finished && !sender.isFinished) {
        if (!sender.isAttached) {
          try {
            session = await this.waitForSession(machineId);
            const again = await startRequest(session);
            active.peer = session.peer;
            const peer = session.peer;
            sender.resume(again.offset, (frame) => {
              peer.sendBinary(frame);
            });
          } catch (error) {
            sender.cancel(
              error instanceof ProtocolError
                ? error
                : new ProtocolError('E_INTERRUPTED', 'agent unavailable', { retryable: true }),
            );
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    try {
      // `transferId` neuf ⇒ l'agent repart toujours de 0 ; la reprise par offset ne joue qu'entre
      // panel et agent (session perdue en cours d'envoi), jamais avec le navigateur.
      await sender.run(body);
      active.finished = true;
      const sha256 = sender.sha256;
      await session.peer.request(
        'fs.transfer.done',
        { transferId, size: sender.sentOffset, sha256 },
        { deadlineMs: TRANSFER_DEADLINE_MS },
      );
      return { sha256, size: sender.sentOffset };
    } catch (error) {
      active.finished = true;
      try {
        session.peer.emit('fs.transfer.cancel', { transferId, reason: 'upload failed' });
      } catch {
        // session fermée
      }
      throw error;
    } finally {
      active.finished = true;
      this.uploads.delete(transferId);
      await watcher;
    }
  }
}
