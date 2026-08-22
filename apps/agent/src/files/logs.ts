/**
 * `logs.listFiles` / `logs.search` (doc 05 §6) : les archives ne quittent jamais la machine — la
 * recherche s'exécute ici, fichier par fichier (`.log` en clair, `.log.gz` décompressés en flux),
 * du plus récent au plus ancien, bornée par `limit`.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

import { ProtocolError, type ParsedResponsePayload } from '@mmo/protocol';

export const LOGS_SEARCH_DEFAULT_LIMIT = 500;
export const LOGS_SEARCH_MAX_LIMIT = 5000;
const LOG_FILE = /^[A-Za-z0-9._-]+\.log(\.gz)?$/;

export type LogFileInfo = ParsedResponsePayload<'logs.listFiles'>['files'][number];

export async function listLogFiles(serverDir: string): Promise<LogFileInfo[]> {
  const dir = path.join(serverDir, 'logs');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: LogFileInfo[] = [];
  for (const name of names) {
    if (!LOG_FILE.test(name)) continue;
    try {
      const s = await stat(path.join(dir, name));
      if (!s.isFile()) continue;
      files.push({ name, sizeBytes: s.size, modifiedAt: Math.round(s.mtimeMs) });
    } catch {
      // fichier disparu entre-temps
    }
  }
  // `latest.log` d'abord, puis du plus récent au plus ancien.
  files.sort((a, b) =>
    a.name === 'latest.log' ? -1 : b.name === 'latest.log' ? 1 : b.modifiedAt - a.modifiedAt,
  );
  return files;
}

export interface SearchOptions {
  query: string;
  regex?: boolean | undefined;
  caseSensitive?: boolean | undefined;
  files?: string[] | undefined;
  limit?: number | undefined;
}

function buildMatcher(options: SearchOptions): (line: string) => boolean {
  const flags = options.caseSensitive ? '' : 'i';
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(options.query, flags);
    } catch (error) {
      throw new ProtocolError('E_INVALID_PAYLOAD', `invalid regex: ${String(error)}`);
    }
    return (line) => re.test(line);
  }
  if (options.caseSensitive) return (line) => line.includes(options.query);
  const needle = options.query.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

export async function searchLogs(
  serverDir: string,
  options: SearchOptions,
): Promise<ParsedResponsePayload<'logs.search'>> {
  const limit = Math.min(options.limit ?? LOGS_SEARCH_DEFAULT_LIMIT, LOGS_SEARCH_MAX_LIMIT);
  const matches = buildMatcher(options);
  const all = await listLogFiles(serverDir);
  const wanted = options.files === undefined ? undefined : new Set(options.files);
  const files = all.filter((f) => wanted === undefined || wanted.has(f.name));
  const out: ParsedResponsePayload<'logs.search'>['matches'] = [];
  let truncated = false;
  for (const file of files) {
    const abs = path.join(serverDir, 'logs', file.name);
    const input = file.name.endsWith('.gz')
      ? createReadStream(abs).pipe(createGunzip())
      : createReadStream(abs);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNo = 0;
    try {
      for await (const line of rl) {
        lineNo++;
        if (!matches(line)) continue;
        if (out.length >= limit) {
          truncated = true;
          break;
        }
        out.push({ file: file.name, line: lineNo, text: line });
      }
    } catch {
      // archive corrompue : on passe au fichier suivant
    } finally {
      rl.close();
      input.destroy();
    }
    if (truncated) break;
  }
  return { matches: out, truncated };
}
