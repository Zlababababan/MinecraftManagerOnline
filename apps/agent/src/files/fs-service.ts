/**
 * Opérations `fs.*` (doc 05 §6) sur un dossier serveur : listage, stat, mkdir, rename, copy,
 * suppression **vers la corbeille** `.mmo-trash/` (purge après 7 jours), lecture inline (≤ 512 Ko,
 * SHA-256), écriture atomique (temp + rename, `expectedSha256` → `E_CONFLICT`).
 */
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { ProtocolError, type ParsedResponsePayload, type fsEntryKindSchema } from '@mmo/protocol';
import type { z } from 'zod';

import { Jail, TRASH_DIR, isTrashPath, normalizeRelative } from './jail.js';

export type FsEntryKind = z.infer<typeof fsEntryKindSchema>;
export type FsEntry = ParsedResponsePayload<'fs.list'>['entries'][number];

export const FS_READ_MAX_BYTES = 512 * 1024;
export const TRASH_RETENTION_MS = 7 * 24 * 3600_000;

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function kindOf(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  return s.isSymbolicLink()
    ? 'symlink'
    : s.isDirectory()
      ? 'dir'
      : s.isFile()
        ? 'file'
        : ('other' as const);
}

function ioError(error: unknown, relative: string): ProtocolError {
  const code = (error as { code?: string }).code;
  if (code === 'ENOENT') {
    return new ProtocolError('E_NOT_FOUND', `no such file: ${relative}`, {
      details: { path: relative },
    });
  }
  if (code === 'EEXIST' || code === 'ENOTEMPTY') {
    return new ProtocolError('E_CONFLICT', `already exists: ${relative}`, {
      details: { path: relative, reason: code },
    });
  }
  return new ProtocolError('E_IO', error instanceof Error ? error.message : String(error), {
    details: { path: relative },
  });
}

export interface FsServiceOptions {
  now?: () => number;
}

export class FsService {
  readonly jail: Jail;
  private readonly now: () => number;

  constructor(root: string, options: FsServiceOptions = {}) {
    this.jail = new Jail(root);
    this.now = options.now ?? Date.now;
  }

  async list(relative: string): Promise<FsEntry[]> {
    const rel = normalizeRelative(relative);
    const abs = await this.jail.resolveChecked(rel);
    let names: Dirent[];
    try {
      names = await readdir(abs, { withFileTypes: true });
    } catch (error) {
      throw ioError(error, rel);
    }
    const entries: FsEntry[] = [];
    for (const d of names) {
      if (rel === '' && d.name === TRASH_DIR) continue;
      const entryPath = path.join(abs, d.name);
      try {
        const s = await lstat(entryPath);
        const kind = kindOf(s);
        entries.push({
          name: d.name,
          kind,
          ...(kind === 'file' ? { size: s.size } : {}),
          modifiedAt: Math.round(s.mtimeMs),
        });
      } catch {
        entries.push({ name: d.name, kind: 'other' });
      }
    }
    entries.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : a.kind === 'dir'
          ? -1
          : b.kind === 'dir'
            ? 1
            : 0,
    );
    return entries;
  }

  async stat(relative: string): Promise<ParsedResponsePayload<'fs.stat'>> {
    const rel = normalizeRelative(relative);
    const abs = await this.jail.resolveChecked(rel);
    try {
      const s = await lstat(abs);
      return {
        kind: kindOf(s),
        size: s.size,
        modifiedAt: Math.round(s.mtimeMs),
        createdAt: Math.round(s.birthtimeMs),
      };
    } catch (error) {
      throw ioError(error, rel);
    }
  }

  async mkdir(relative: string): Promise<void> {
    const rel = normalizeRelative(relative);
    if (rel === '') throw new ProtocolError('E_INVALID_PAYLOAD', 'empty path');
    const abs = await this.jail.resolveChecked(rel);
    try {
      await mkdir(abs, { recursive: true });
    } catch (error) {
      throw ioError(error, rel);
    }
  }

  async rename(from: string, to: string, overwrite = false): Promise<void> {
    const relFrom = normalizeRelative(from);
    const relTo = normalizeRelative(to);
    if (relFrom === '' || relTo === '') throw new ProtocolError('E_INVALID_PAYLOAD', 'empty path');
    const absFrom = await this.jail.resolveChecked(relFrom);
    const absTo = await this.jail.resolveChecked(relTo);
    if (!overwrite && (await exists(absTo))) {
      throw new ProtocolError('E_CONFLICT', `target exists: ${relTo}`, {
        details: { path: relTo },
      });
    }
    try {
      await mkdir(path.dirname(absTo), { recursive: true });
      await rename(absFrom, absTo);
    } catch (error) {
      throw ioError(error, relFrom);
    }
  }

  async copy(from: string, to: string, overwrite = false): Promise<void> {
    const relFrom = normalizeRelative(from);
    const relTo = normalizeRelative(to);
    if (relFrom === '' || relTo === '') throw new ProtocolError('E_INVALID_PAYLOAD', 'empty path');
    if (relTo === relFrom || relTo.startsWith(`${relFrom}/`)) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'cannot copy a directory into itself');
    }
    const absFrom = await this.jail.resolveChecked(relFrom);
    const absTo = await this.jail.resolveChecked(relTo);
    if (!overwrite && (await exists(absTo))) {
      throw new ProtocolError('E_CONFLICT', `target exists: ${relTo}`, {
        details: { path: relTo },
      });
    }
    try {
      await mkdir(path.dirname(absTo), { recursive: true });
      await cp(absFrom, absTo, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    } catch (error) {
      throw ioError(error, relFrom);
    }
  }

  /** Déplace vers `.mmo-trash/<epoch>-<nom>` (jamais de suppression directe). */
  async delete(relative: string): Promise<{ trashedAs: string }> {
    const rel = normalizeRelative(relative);
    if (rel === '' || isTrashPath(rel)) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'cannot delete this path', {
        details: { path: rel },
      });
    }
    const abs = await this.jail.resolveChecked(rel);
    if (!(await exists(abs))) {
      throw new ProtocolError('E_NOT_FOUND', `no such file: ${rel}`, { details: { path: rel } });
    }
    const trashRoot = this.jail.resolve(TRASH_DIR);
    await mkdir(trashRoot, { recursive: true });
    const base = `${String(this.now())}-${path.basename(rel)}`;
    let name = base;
    for (let i = 1; await exists(path.join(trashRoot, name)); i++) name = `${base}.${String(i)}`;
    const trashedAs = `${TRASH_DIR}/${name}`;
    try {
      await rename(abs, path.join(trashRoot, name));
      await writeFile(
        path.join(trashRoot, `${name}.mmo-trash.json`),
        JSON.stringify({ originalPath: rel, deletedAt: this.now() }),
        'utf8',
      );
    } catch (error) {
      throw ioError(error, rel);
    }
    return { trashedAs };
  }

  /** Purge les entrées de la corbeille plus vieilles que `TRASH_RETENTION_MS`. */
  async purgeTrash(retentionMs = TRASH_RETENTION_MS): Promise<number> {
    const trashRoot = this.jail.resolve(TRASH_DIR);
    let names: string[];
    try {
      names = await readdir(trashRoot);
    } catch {
      return 0;
    }
    let purged = 0;
    const cutoff = this.now() - retentionMs;
    for (const name of names) {
      if (name.endsWith('.mmo-trash.json')) continue;
      const ts = Number(name.split('-')[0]);
      if (!Number.isFinite(ts) || ts > cutoff) continue;
      await rm(path.join(trashRoot, name), { recursive: true, force: true });
      await rm(path.join(trashRoot, `${name}.mmo-trash.json`), { force: true });
      purged++;
    }
    return purged;
  }

  async read(
    relative: string,
    maxBytes = FS_READ_MAX_BYTES,
  ): Promise<ParsedResponsePayload<'fs.read'>> {
    const rel = normalizeRelative(relative);
    const abs = await this.jail.resolveChecked(rel);
    let buf: Buffer;
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        throw new ProtocolError('E_INVALID_PAYLOAD', 'is a directory', { details: { path: rel } });
      }
      buf = await readFile(abs);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw ioError(error, rel);
    }
    const limit = Math.min(maxBytes, FS_READ_MAX_BYTES);
    const truncated = buf.length > limit;
    const slice = truncated ? buf.subarray(0, limit) : buf;
    const text = slice.toString('utf8');
    return {
      content: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
      encoding: 'utf8',
      sha256: sha256(buf),
      size: buf.length,
      truncated,
    };
  }

  /** Écriture atomique : fichier temporaire dans le même dossier puis `rename`. */
  async write(
    relative: string,
    content: string,
    expectedSha256?: string,
  ): Promise<{ sha256: string }> {
    const rel = normalizeRelative(relative);
    if (rel === '' || isTrashPath(rel)) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'cannot write this path', {
        details: { path: rel },
      });
    }
    const abs = await this.jail.resolveChecked(rel);
    if (expectedSha256 !== undefined) {
      let current: string | undefined;
      try {
        current = sha256(await readFile(abs));
      } catch {
        current = undefined;
      }
      if (current !== undefined && current !== expectedSha256) {
        throw new ProtocolError('E_CONFLICT', 'file changed since it was read', {
          details: { path: rel, sha256: current },
        });
      }
    }
    return writeAtomic(abs, content).catch((error: unknown) => {
      throw ioError(error, rel);
    });
  }
}

export async function writeAtomic(abs: string, content: string): Promise<{ sha256: string }> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, abs);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { sha256: sha256(content) };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}
