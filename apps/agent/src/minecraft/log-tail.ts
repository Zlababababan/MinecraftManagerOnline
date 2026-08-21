/**
 * Tail de `logs/latest.log` pour le mode `detached` (doc 05 §4) : les pipes sont perdus, le
 * serveur n'écrit plus que dans ses fichiers. Polling (portable, robuste aux rotations/troncatures) ;
 * décodage UTF-8 tolérant, lignes entières uniquement.
 */
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export interface LogTailOptions {
  intervalMs?: number;
  /** `true` = commencer à la fin du fichier (ne pas rejouer l'historique). */
  fromEnd?: boolean;
}

export class LogTail {
  private position = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private reading = false;
  private started = false;

  constructor(
    private readonly file: string,
    private readonly onLine: (line: string) => void,
    private readonly options: LogTailOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.options.fromEnd ?? true) {
      try {
        this.position = (await stat(this.file)).size;
      } catch {
        this.position = 0;
      }
    }
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.intervalMs ?? 500);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      let size: number;
      try {
        size = (await stat(this.file)).size;
      } catch {
        return;
      }
      if (size < this.position) {
        // Rotation ou troncature : on repart du début du nouveau fichier.
        this.position = 0;
        this.decoder = new StringDecoder('utf8');
        this.partial = '';
      }
      if (size === this.position) return;
      const handle = await open(this.file, 'r');
      try {
        const length = size - this.position;
        const buf = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
        const { bytesRead } = await handle.read(buf, 0, buf.length, this.position);
        this.position += bytesRead;
        this.consume(this.decoder.write(buf.subarray(0, bytesRead)));
      } finally {
        await handle.close();
      }
    } finally {
      this.reading = false;
    }
  }

  private consume(text: string): void {
    const data = this.partial + text;
    const parts = data.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.onLine(line);
  }
}
