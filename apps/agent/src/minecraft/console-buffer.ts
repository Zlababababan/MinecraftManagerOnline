/**
 * Ring buffer de console par serveur (doc 05 §13 : 5 000 lignes ou 2 Mo) avec `seq` monotone
 * fourni par l'appelant (persisté dans l'état de l'agent, doc 05 §7).
 */
import type { ConsoleLine } from '@mmo/protocol';

export interface ConsoleBufferOptions {
  maxLines?: number;
  maxBytes?: number;
}

export class ConsoleBuffer {
  private readonly lines: ConsoleLine[] = [];
  private bytes = 0;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private head = 0;

  constructor(options: ConsoleBufferOptions = {}) {
    this.maxLines = options.maxLines ?? 5000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  }

  push(line: ConsoleLine): void {
    this.lines.push(line);
    this.bytes += byteLength(line.text);
    while (
      this.lines.length - this.head > 0 &&
      (this.lines.length - this.head > this.maxLines || this.bytes > this.maxBytes)
    ) {
      const dropped = this.lines[this.head];
      if (dropped) this.bytes -= byteLength(dropped.text);
      this.head++;
    }
    // Compactage périodique pour ne pas garder indéfiniment les entrées consommées.
    if (this.head > 1024 && this.head > this.lines.length / 2) {
      this.lines.splice(0, this.head);
      this.head = 0;
    }
  }

  get size(): number {
    return this.lines.length - this.head;
  }

  get oldestSeq(): number | undefined {
    return this.lines[this.head]?.seq;
  }

  get latestSeq(): number | undefined {
    return this.lines.at(-1)?.seq;
  }

  /** Lignes de `seq > sinceSeq` ; `truncated` si des lignes demandées ont été expulsées. */
  since(sinceSeq: number | undefined): { lines: ConsoleLine[]; truncated: boolean } {
    const all = this.lines.slice(this.head);
    if (sinceSeq === undefined) return { lines: all, truncated: false };
    const oldest = this.oldestSeq;
    const truncated = oldest !== undefined && sinceSeq + 1 < oldest;
    return { lines: all.filter((l) => l.seq > sinceSeq), truncated };
  }

  clear(): void {
    this.lines.length = 0;
    this.head = 0;
    this.bytes = 0;
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
