/**
 * @mmo/shared/node — adaptateur système de fichiers Node pour la détection (utilisé par l'agent et
 * par les tests sur fixtures). Le point d'entrée racine `@mmo/shared` reste sans dépendance Node.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { DetectFs, DirEntry, JarHandle } from '../detection/fs.js';
import { openZip } from './zip.js';

export { openZip };
export {
  DEFAULT_EXTRACT_MAX_BYTES,
  DEFAULT_EXTRACT_MAX_ENTRIES,
  TAR_BLOCK,
  assertExtractBudget,
  extractTar,
  safeRelative,
  tarEntries,
  walkTree,
  type ExcludeFn,
  type ExtractOptions,
  type ExtractProgress,
  type ExtractResult,
  type TarProgress,
  type TreeEntry,
  type TreeSummary,
} from './tar.js';
export {
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_RETENTION_DAYS,
  createRotatingLog,
  purgeRotatedLogs,
  tailRotatedLog,
  type LogTail,
  type RotatingLog,
  type RotatingLogOptions,
} from './rotating-log.js';

export function createNodeDetectFs(): DetectFs {
  return {
    async readdir(dir: string): Promise<DirEntry[]> {
      try {
        const entries = await readdir(path.normalize(dir), { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
        }));
      } catch {
        return [];
      }
    },
    async readText(file: string, maxBytes?: number): Promise<string | undefined> {
      try {
        const buf = await readFile(path.normalize(file));
        const slice = maxBytes === undefined ? buf : buf.subarray(0, maxBytes);
        // BOM UTF-8 fréquent dans les fichiers édités sous Windows
        const text = slice.toString('utf8');
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      } catch {
        return undefined;
      }
    },
    openJar(file: string): Promise<JarHandle | undefined> {
      return openZip(path.normalize(file));
    },
  };
}

export * from './codecs.js';
