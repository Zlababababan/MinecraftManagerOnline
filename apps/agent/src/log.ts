/**
 * Journal de l'agent : stderr (format texte) + relais optionnel vers le panel (`agent.log`, non
 * critique). Implémente `RpcLogger` de `@mmo/protocol`.
 */
import type { LogLevel, RpcLogger } from '@mmo/protocol';

export type LogContext = Record<string, unknown>;
export type LogSink = (entry: LogEntry) => void;

export interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
  context?: LogContext;
}

const RANK: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };

export class Logger implements RpcLogger {
  private readonly sinks = new Set<LogSink>();
  private minLevel: LogLevel;

  constructor(
    private readonly name: string,
    options: { level?: LogLevel; stderr?: boolean } = {},
  ) {
    this.minLevel = options.level ?? 'INFO';
    if (options.stderr ?? true) this.sinks.add(stderrSink);
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  child(name: string): Logger {
    const child = new Logger(`${this.name}:${name}`, { level: this.minLevel, stderr: false });
    child.sinks.add((e) => {
      this.dispatch(e);
    });
    return child;
  }

  addSink(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  log(level: LogLevel, message: string, context?: LogContext): void {
    if (RANK[level] < RANK[this.minLevel]) return;
    this.dispatch({
      ts: Date.now(),
      level,
      message: `[${this.name}] ${message}`,
      ...(context === undefined ? {} : { context }),
    });
  }

  debug(message: string, context?: LogContext): void {
    this.log('DEBUG', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.log('INFO', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.log('WARN', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.log('ERROR', message, context);
  }

  private dispatch(entry: LogEntry): void {
    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch {
        // un sink défaillant ne doit jamais casser l'agent
      }
    }
  }
}

function stderrSink(entry: LogEntry): void {
  const time = new Date(entry.ts).toISOString();
  const ctx = entry.context === undefined ? '' : ` ${safeJson(entry.context)}`;
  process.stderr.write(`${time} ${entry.level.padEnd(5)} ${entry.message}${ctx}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) =>
      v instanceof Error ? { name: v.name, message: v.message } : v,
    );
  } catch {
    return '[unserializable]';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
