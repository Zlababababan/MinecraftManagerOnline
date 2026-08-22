/**
 * Client RCON maison (doc 06 §5) — protocole Source RCON, TCP little-endian :
 * `[len i32][reqId i32][type i32][payload][\0\0]` ; login = type 3, commande = type 2, réponse = type 0.
 * - file de commandes **sérialisée** (le serveur traite une commande à la fois) ;
 * - fin de réponse détectée par la technique du « paquet junk » : un paquet de type inconnu envoyé
 *   juste après la commande ; Minecraft y répond `Unknown request …` après tous les fragments
 *   (4 096 octets) de la réponse réelle ; repli sur un silence de `idleMs` (parser tolérant) ;
 * - reconnexion automatique à la prochaine commande après une erreur.
 */
import net from 'node:net';

import { ProtocolError } from '@mmo/protocol';

export const RCON_AUTH = 3;
export const RCON_EXEC = 2;
export const RCON_RESPONSE = 0;
/** Type volontairement inconnu du serveur (Minecraft répond `Unknown request`). */
export const RCON_JUNK_TYPE = 100;
export const RCON_MAX_COMMAND_BYTES = 1446;

export function encodeRconPacket(id: number, type: number, body: string | Buffer): Buffer {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const buf = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
  buf.writeInt32LE(buf.length - 4, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/** Découpe les paquets complets d'un tampon ; retourne le reste non consommé. */
export function decodeRconPackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let acc = buffer;
  while (acc.length >= 4) {
    const len = acc.readInt32LE(0);
    if (len < 10 || len > 1 << 20) {
      // Longueur aberrante : on abandonne le reste (mode tolérant, MC-270327).
      return { packets, rest: Buffer.alloc(0) };
    }
    if (acc.length < 4 + len) break;
    const id = acc.readInt32LE(4);
    const type = acc.readInt32LE(8);
    const body = acc.subarray(12, 4 + len - 2).toString('utf8');
    packets.push({ id, type, body });
    acc = acc.subarray(4 + len);
  }
  return { packets, rest: acc };
}

export interface RconClientOptions {
  host?: string;
  port: number;
  password: string;
  /** Délai par commande (défaut 5 s). */
  timeoutMs?: number;
  /** Silence après le dernier fragment valant fin de réponse si le paquet junk n'est pas honoré. */
  idleMs?: number;
  connectTimeoutMs?: number;
}

interface Waiter {
  resolve: (packets: RconPacket[]) => void;
  reject: (error: Error) => void;
}

export class RconClient {
  private socket: net.Socket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: Waiter | undefined;
  private received: RconPacket[] = [];
  private authed = false;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly options: RconClientOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.idleMs = options.idleMs ?? 400;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3000;
  }

  get isConnected(): boolean {
    return this.socket !== undefined && this.authed;
  }

  /** Connexion + authentification (idempotent). */
  connect(): Promise<void> {
    return this.enqueue(() => this.ensureConnected());
  }

  /** Exécute une commande (sans slash), sérialisée avec les autres. */
  exec(command: string, timeoutMs?: number): Promise<string> {
    return this.enqueue(async () => {
      if (Buffer.byteLength(command, 'utf8') > RCON_MAX_COMMAND_BYTES) {
        throw new ProtocolError('E_INVALID_PAYLOAD', 'rcon command too long', {
          details: { max: RCON_MAX_COMMAND_BYTES },
        });
      }
      // Le délai de la commande borne aussi l'authentification : une sonde de vivacité ne doit pas
      // attendre 5 s de plus sur un serveur gelé (phase 7, watchdog).
      await this.ensureConnected(timeoutMs);
      const id = this.allocId();
      const junkId = this.allocId();
      const packets = await this.roundTrip(
        [encodeRconPacket(id, RCON_EXEC, command), encodeRconPacket(junkId, RCON_JUNK_TYPE, '')],
        (p) => p.id === junkId,
        timeoutMs ?? this.timeoutMs,
        true,
      );
      return packets
        .filter((p) => p.id === id)
        .map((p) => p.body)
        .join('');
    });
  }

  close(): void {
    this.authed = false;
    const s = this.socket;
    this.socket = undefined;
    if (s) s.destroy();
    this.fail(new ProtocolError('E_INTERRUPTED', 'rcon connection closed', { retryable: true }));
  }

  // --- Internes -------------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private allocId(): number {
    const id = this.nextId++;
    if (this.nextId > 0x7fff_fff0) this.nextId = 1;
    return id;
  }

  private async ensureConnected(timeoutMs?: number): Promise<void> {
    if (this.socket && this.authed) return;
    this.close();
    await this.open();
    const id = this.allocId();
    const packets = await this.roundTrip(
      [encodeRconPacket(id, RCON_AUTH, this.options.password)],
      (p) => p.type === RCON_EXEC,
      timeoutMs ?? this.timeoutMs,
      false,
    );
    const reply = packets.find((p) => p.type === RCON_EXEC);
    if (reply?.id !== id) {
      this.close();
      throw new ProtocolError('E_AUTH', 'rcon authentication refused', { retryable: false });
    }
    this.authed = true;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.options.port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new ProtocolError('E_TIMEOUT', 'rcon connect timeout', {
            details: { port: this.options.port },
          }),
        );
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        resolve();
      });
      socket.once('error', (error: Error) => {
        clearTimeout(timer);
        if (this.socket === socket) {
          this.socket = undefined;
          this.authed = false;
          this.fail(
            new ProtocolError('E_IO', `rcon socket error: ${error.message}`, { cause: error }),
          );
        } else {
          reject(
            new ProtocolError('E_IO', `rcon connect failed: ${error.message}`, { cause: error }),
          );
        }
      });
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.authed = false;
          this.fail(
            new ProtocolError('E_INTERRUPTED', 'rcon connection closed', { retryable: true }),
          );
        }
      });
      socket.on('data', (chunk: Buffer) => {
        this.onData(chunk);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { packets, rest } = decodeRconPackets(this.buffer);
    this.buffer = rest;
    if (packets.length === 0) return;
    this.received.push(...packets);
    this.waiter?.resolve(this.received);
  }

  /**
   * Envoie des paquets et attend jusqu'au paquet terminal (`isLast`), au silence (`idle`) ou au
   * délai global. Résout avec tous les paquets reçus.
   */
  private roundTrip(
    packets: Buffer[],
    isLast: (p: RconPacket) => boolean,
    timeoutMs: number,
    useIdle: boolean,
  ): Promise<RconPacket[]> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(
        new ProtocolError('E_INTERRUPTED', 'rcon not connected', { retryable: true }),
      );
    }
    return new Promise<RconPacket[]>((resolve, reject) => {
      this.received = [];
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        finish(
          new ProtocolError('E_TIMEOUT', 'rcon command timed out', { details: { timeoutMs } }),
        );
      }, timeoutMs);
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        this.waiter = undefined;
        const all = this.received;
        this.received = [];
        if (error) {
          // Après un timeout, l'état du flux est inconnu : on coupe pour repartir propre.
          if (error instanceof ProtocolError && error.code === 'E_TIMEOUT') this.close();
          reject(error);
        } else resolve(all);
      };
      this.waiter = {
        resolve: (all) => {
          if (all.some(isLast)) {
            finish();
            return;
          }
          if (useIdle) {
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              finish();
            }, this.idleMs);
          }
        },
        reject: (error) => {
          finish(error);
        },
      };
      for (const p of packets) socket.write(p);
    });
  }

  private fail(error: Error): void {
    this.waiter?.reject(error);
  }
}

/** Analyse la réponse de `list` : `There are 2 of a max of 20 players online: A, B`. */
export function parseListResponse(
  text: string,
): { online: number; max?: number; players: string[] } | undefined {
  const m = /There are (\d+)(?: of a max(?: of)? (\d+))? players online:?\s*(.*)$/s.exec(
    text.trim(),
  );
  if (!m) return undefined;
  const players = (m[3] ?? '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const max = m[2] === undefined ? undefined : Number(m[2]);
  return { online: Number(m[1]), ...(max === undefined ? {} : { max }), players };
}
