/**
 * Moteurs de transfert (doc 05 §8), indépendants du transport et du système de fichiers :
 *
 * - `TransferSender` découpe une source en chunks de taille fixe, compresse chaque chunk, émet les
 *   frames en respectant une fenêtre glissante (chunks non acquittés) et la **priorité basse**
 *   (n'empile rien dans le socket si `bufferedAmount` dépasse le seuil : heartbeats, console et
 *   métriques passent entre deux chunks). Les chunks non acquittés sont retenus pour pouvoir
 *   reprendre après une coupure (`detach()` puis `resume(offset, sendFrame)`).
 * - `TransferReceiver` vérifie la continuité des offsets, décompresse, écrit (sérialisé, avec
 *   contre-pression : l'ack n'est envoyé qu'après l'écriture) et vérifie taille + SHA-256 à la fin.
 *
 * Les offsets sont toujours ceux du fichier non compressé.
 */
import { ProtocolError } from '../errors.js';
import { encodeFrame, type TransferFrame } from './frame.js';

export interface ChunkCodec {
  compress(data: Uint8Array): Uint8Array;
  decompress(data: Uint8Array): Uint8Array;
}

export const identityCodec: ChunkCodec = {
  compress: (d) => d,
  decompress: (d) => d,
};

export interface Hasher {
  update(data: Uint8Array): void;
  /** Hexadécimal minuscule. */
  digest(): string;
}

export interface TransferSenderOptions {
  transferId: string;
  chunkSize: number;
  /** Chunks émis non acquittés (défaut 8). */
  windowChunks?: number;
  codec: ChunkCodec;
  hash: () => Hasher;
  sendFrame: (frame: Uint8Array) => void;
  /** Octets en attente dans le socket ; au-delà de `maxBuffered`, l'émetteur attend. */
  bufferedAmount?: () => number;
  /** Défaut : 2 chunks. */
  maxBuffered?: number;
  /** Notification de progression (offset acquitté). */
  onProgress?: (ackedOffset: number) => void;
  /** Horloge injectable pour l'attente de socket occupé (défaut 10 ms). */
  pollMs?: number;
}

interface Retained {
  offset: number;
  length: number;
  frame: Uint8Array;
}

export class TransferSender {
  private readonly window: number;
  private readonly maxBuffered: number;
  private readonly retained: Retained[] = [];
  private sendFrame: ((frame: Uint8Array) => void) | undefined;
  private acked: number;
  private next: number;
  private total: number | undefined;
  private failure: ProtocolError | undefined;
  private wake: (() => void) | undefined;
  private readonly hasher: Hasher;
  private finished = false;

  constructor(
    private readonly options: TransferSenderOptions,
    startOffset = 0,
  ) {
    this.window = options.windowChunks ?? 8;
    this.maxBuffered = options.maxBuffered ?? options.chunkSize * 2;
    this.sendFrame = options.sendFrame;
    this.acked = startOffset;
    this.next = startOffset;
    this.hasher = options.hash();
  }

  get ackedOffset(): number {
    return this.acked;
  }

  get sentOffset(): number {
    return this.next;
  }

  /** SHA-256 des octets émis (valide une fois `run()` résolu). */
  get sha256(): string {
    return this.hasher.digest();
  }

  get isAttached(): boolean {
    return this.sendFrame !== undefined;
  }

  /**
   * Émet toute la source à partir de l'offset de départ ; résout quand le dernier octet est
   * acquitté. Rejette `ProtocolError` (`E_CANCELLED`, `E_IO`…) sur `cancel()`.
   */
  async run(source: AsyncIterable<Uint8Array>): Promise<{ size: number }> {
    let pending: Uint8Array[] = [];
    let pendingLength = 0;
    const { chunkSize } = this.options;
    for await (const piece of source) {
      this.throwIfFailed();
      if (piece.byteLength === 0) continue;
      pending.push(piece);
      pendingLength += piece.byteLength;
      while (pendingLength >= chunkSize) {
        const chunk = takeBytes(pending, chunkSize);
        pending = chunk.rest;
        pendingLength -= chunkSize;
        await this.emitChunk(chunk.data);
      }
    }
    if (pendingLength > 0) await this.emitChunk(takeBytes(pending, pendingLength).data);
    this.total = this.next;
    this.finished = true;
    await this.waitFor(() => this.acked >= this.next);
    return { size: this.next };
  }

  /** Acquittement du récepteur (tout est reçu jusqu'à `offset` exclu). */
  onAck(offset: number): void {
    if (offset <= this.acked) return;
    this.acked = Math.min(offset, this.next);
    while (this.retained.length > 0) {
      const head = this.retained[0];
      if (head === undefined || head.offset + head.length > this.acked) break;
      this.retained.shift();
    }
    this.options.onProgress?.(this.acked);
    this.wake?.();
  }

  /** Transport perdu : l'émission se suspend, les chunks non acquittés restent retenus. */
  detach(): void {
    this.sendFrame = undefined;
  }

  /**
   * Reprise après reconnexion : le récepteur annonce l'offset qu'il détient ; les chunks retenus à
   * partir de là sont ré-émis sur le nouveau transport. `E_IO` si l'offset est hors fenêtre.
   */
  resume(offset: number, sendFrame: (frame: Uint8Array) => void): void {
    if (offset > this.next) {
      this.fail(
        new ProtocolError('E_IO', 'receiver offset beyond sent data', {
          details: { offset, sent: this.next },
        }),
      );
      return;
    }
    if (offset < this.acked) {
      this.fail(
        new ProtocolError('E_IO', 'receiver offset below acknowledged window', {
          details: { offset, acked: this.acked },
        }),
      );
      return;
    }
    this.acked = offset;
    const keepFrom = this.retained.findIndex((r) => r.offset + r.length > offset);
    this.retained.splice(0, keepFrom === -1 ? this.retained.length : keepFrom);
    this.sendFrame = sendFrame;
    for (const r of this.retained) {
      try {
        sendFrame(r.frame);
      } catch {
        this.detach();
        return;
      }
    }
    this.options.onProgress?.(this.acked);
    this.wake?.();
  }

  cancel(error: ProtocolError = new ProtocolError('E_CANCELLED', 'transfer cancelled')): void {
    this.fail(error);
  }

  get isFinished(): boolean {
    return this.finished && this.acked >= this.next;
  }

  get expectedSize(): number | undefined {
    return this.total;
  }

  // --- Internes -------------------------------------------------------------------------------

  private async emitChunk(data: Uint8Array): Promise<void> {
    await this.waitFor(
      () =>
        this.retained.length < this.window &&
        this.sendFrame !== undefined &&
        (this.options.bufferedAmount?.() ?? 0) < this.maxBuffered,
    );
    this.hasher.update(data);
    const frame = encodeFrame({
      transferId: this.options.transferId,
      offset: this.next,
      data: this.options.codec.compress(data),
    });
    this.retained.push({ offset: this.next, length: data.byteLength, frame });
    this.next += data.byteLength;
    const send = this.sendFrame;
    if (send === undefined) return; // détaché entre-temps : le chunk retenu partira au `resume`
    try {
      send(frame);
    } catch {
      // Socket fermé : on reste en attente d'un `resume` plutôt que d'échouer (reprise par offset).
      this.detach();
    }
  }

  private waitFor(predicate: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const check = (): void => {
        if (settled) return;
        if (this.failure) {
          settled = true;
          this.wake = undefined;
          reject(this.failure);
          return;
        }
        if (predicate()) {
          settled = true;
          this.wake = undefined;
          resolve();
          return;
        }
        this.wake = check;
        // Socket occupé (priorité basse) : on re-sonde sans attendre un ack.
        if (
          this.sendFrame !== undefined &&
          this.retained.length < this.window &&
          (this.options.bufferedAmount?.() ?? 0) >= this.maxBuffered
        ) {
          setTimeout(check, this.options.pollMs ?? 10);
        }
      };
      check();
    });
  }

  private fail(error: ProtocolError): void {
    this.failure ??= error;
    this.wake?.();
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
}

function takeBytes(pieces: Uint8Array[], length: number): { data: Uint8Array; rest: Uint8Array[] } {
  if (pieces.length === 1 && pieces[0]?.byteLength === length) {
    return { data: pieces[0], rest: [] };
  }
  const data = new Uint8Array(length);
  let filled = 0;
  const rest: Uint8Array[] = [];
  for (const piece of pieces) {
    if (filled >= length) {
      rest.push(piece);
      continue;
    }
    const take = Math.min(piece.byteLength, length - filled);
    data.set(piece.subarray(0, take), filled);
    filled += take;
    if (take < piece.byteLength) rest.push(piece.subarray(take));
  }
  return { data, rest };
}

// --- Récepteur --------------------------------------------------------------------------------------

export interface TransferReceiverOptions {
  transferId: string;
  codec: ChunkCodec;
  hash: () => Hasher;
  /** Écriture séquentielle (fichier `.part`, réponse HTTP…) ; l'ack suit la résolution. */
  write: (data: Uint8Array, offset: number) => void | Promise<void>;
  sendAck: (offset: number) => void;
  /** Hachage des octets déjà présents (reprise) : fourni par l'appelant via `seed`. */
  onError?: (error: ProtocolError) => void;
}

export class TransferReceiver {
  private offset: number;
  private inFlight = 0;
  private chain: Promise<void> = Promise.resolve();
  private failure: ProtocolError | undefined;
  private readonly hasher: Hasher;

  constructor(
    private readonly options: TransferReceiverOptions,
    startOffset = 0,
  ) {
    this.offset = startOffset;
    this.hasher = options.hash();
  }

  /** Octets reçus et écrits (offset attendu de la prochaine frame). */
  get receivedOffset(): number {
    return this.offset;
  }

  get error(): ProtocolError | undefined {
    return this.failure;
  }

  /** Reprise : alimente le hachage avec les octets déjà détenus (lus par l'appelant). */
  seed(existing: Uint8Array): void {
    this.hasher.update(existing);
  }

  /** Frame reçue ; celles d'un autre transfert ou déjà reçues (rejeu) sont ignorées. */
  onFrame(frame: TransferFrame): void {
    if (frame.transferId !== this.options.transferId || this.failure) return;
    const expected = this.offset + this.inFlight;
    if (frame.offset < expected) return; // duplicata (réémission après reprise)
    if (frame.offset > expected) {
      this.fail(
        new ProtocolError('E_IO', 'out-of-order transfer frame', {
          details: { expected, received: frame.offset },
        }),
      );
      return;
    }
    let data: Uint8Array;
    try {
      data = this.options.codec.decompress(frame.data);
    } catch (error) {
      this.fail(new ProtocolError('E_IO', 'chunk decompression failed', { cause: error }));
      return;
    }
    this.inFlight += data.byteLength;
    const at = frame.offset;
    this.chain = this.chain.then(async () => {
      if (this.failure) return;
      try {
        await this.options.write(data, at);
      } catch (error) {
        this.fail(new ProtocolError('E_IO', 'write failed', { cause: error }));
        return;
      }
      this.hasher.update(data);
      this.offset = at + data.byteLength;
      this.inFlight -= data.byteLength;
      this.options.sendAck(this.offset);
    });
  }

  /** Vérification finale (taille + SHA-256) après la dernière écriture. */
  async finish(size: number, sha256: string): Promise<{ sha256: string }> {
    await this.chain;
    if (this.failure) throw this.failure;
    if (this.offset !== size) {
      throw new ProtocolError('E_CHECKSUM_MISMATCH', 'transfer size mismatch', {
        details: { expected: size, received: this.offset },
      });
    }
    const actual = this.hasher.digest();
    if (actual !== sha256.toLowerCase()) {
      throw new ProtocolError('E_CHECKSUM_MISMATCH', 'transfer sha256 mismatch', {
        details: { expected: sha256, actual },
      });
    }
    return { sha256: actual };
  }

  /** Attend les écritures en cours (avant de lire l'offset pour une reprise). */
  settle(): Promise<void> {
    return this.chain;
  }

  cancel(error: ProtocolError = new ProtocolError('E_CANCELLED', 'transfer cancelled')): void {
    this.fail(error);
  }

  private fail(error: ProtocolError): void {
    if (this.failure) return;
    this.failure = error;
    this.options.onError?.(error);
  }
}
