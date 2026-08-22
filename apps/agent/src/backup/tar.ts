/**
 * Archive tar maison (ustar + en-têtes pax pour les chemins longs et les très gros fichiers) en
 * flux, sans dépendance (règle de l'agent : bundle universel, zéro module natif — et `archiver`
 * n'apporte rien ici). Lisible par tar, 7-Zip, bsdtar. Pas de liens symboliques (ignorés, signalés).
 *
 * - `walkTree()` inventorie un dossier (fichiers, dossiers, tailles) avec exclusions ;
 * - `tarEntries()` produit les blocs tar (générateur : `Readable.from()` + `pipeline()`) ;
 * - `extractTar()` consomme un flux tar et écrit dans un dossier, chemins jailés (`..` refusé).
 */
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';

export const TAR_BLOCK = 512;

export interface TreeEntry {
  /** Chemin relatif avec `/` (sans `./`). */
  rel: string;
  abs: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface TreeSummary {
  entries: TreeEntry[];
  files: number;
  bytes: number;
  /** Entrées ignorées (liens symboliques, types spéciaux). */
  skipped: string[];
}

export type ExcludeFn = (rel: string, kind: 'file' | 'dir') => boolean;

/** Inventaire trié (ordre stable : dossiers avant leur contenu). */
export async function walkTree(root: string, exclude: ExcludeFn): Promise<TreeSummary> {
  const entries: TreeEntry[] = [];
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;
  const visit = async (dir: string, relDir: string): Promise<void> => {
    const names = (await readdir(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      const st = await lstat(abs).catch(() => undefined);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        skipped.push(rel);
        continue;
      }
      if (st.isDirectory()) {
        if (exclude(rel, 'dir')) continue;
        entries.push({ rel, abs, kind: 'dir', size: 0, mtimeMs: st.mtimeMs, mode: st.mode });
        await visit(abs, rel);
      } else if (st.isFile()) {
        if (exclude(rel, 'file')) continue;
        entries.push({ rel, abs, kind: 'file', size: st.size, mtimeMs: st.mtimeMs, mode: st.mode });
        files++;
        bytes += st.size;
      } else {
        skipped.push(rel);
      }
    }
  };
  await visit(root, '');
  return { entries, files, bytes, skipped };
}

// --- Écriture -----------------------------------------------------------------------------------------

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value, offset, length, 'utf8');
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  buf.write(text.slice(-(length - 1)), offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function header(
  name: string,
  size: number,
  mtimeSec: number,
  typeflag: '0' | '5' | 'x',
  mode: number,
): Buffer {
  const buf = Buffer.alloc(TAR_BLOCK);
  writeString(buf, 0, 100, name);
  writeOctal(buf, 100, 8, mode & 0o7777);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, mtimeSec);
  buf.fill(0x20, 148, 156); // checksum : espaces pendant le calcul
  buf.write(typeflag, 156, 1, 'ascii');
  buf.write('ustar', 257, 5, 'ascii');
  buf[262] = 0;
  buf.write('00', 263, 2, 'ascii');
  writeString(buf, 265, 32, 'mmo');
  writeString(buf, 297, 32, 'mmo');
  writeOctal(buf, 329, 8, 0);
  writeOctal(buf, 337, 8, 0);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  // La longueur inclut ses propres chiffres.
  while (Buffer.byteLength(`${String(len)}${body}`, 'utf8') !== len) {
    len = Buffer.byteLength(`${String(len)}${body}`, 'utf8');
  }
  return `${String(len)}${body}`;
}

function padding(size: number): Buffer {
  const rest = size % TAR_BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK - rest);
}

const MAX_OCTAL_SIZE = 0o77777777777; // 8 Gio - 1

export interface TarProgress {
  /** Octets de fichiers émis (hors en-têtes). */
  bytes: number;
  files: number;
  current: string;
}

/**
 * Blocs tar des entrées données (un en-tête pax précède toute entrée dont le nom dépasse 100 octets
 * ou dont la taille dépasse 8 Gio). Un fichier qui rétrécit entre l'inventaire et la lecture est
 * complété par des zéros ; un fichier qui grossit est tronqué à la taille inventoriée (archive
 * toujours cohérente avec ses en-têtes).
 */
export async function* tarEntries(
  entries: Iterable<TreeEntry>,
  onProgress?: (p: TarProgress) => void,
  shouldAbort?: () => boolean,
): AsyncGenerator<Buffer> {
  let bytes = 0;
  let files = 0;
  for (const e of entries) {
    if (shouldAbort?.()) throw new Error('aborted');
    const name = e.kind === 'dir' ? `${e.rel}/` : e.rel;
    const mtimeSec = Math.max(0, Math.floor(e.mtimeMs / 1000));
    const needsPax = Buffer.byteLength(name, 'utf8') > 100 || e.size > MAX_OCTAL_SIZE;
    if (needsPax) {
      let records = paxRecord('path', name);
      if (e.size > MAX_OCTAL_SIZE) records += paxRecord('size', String(e.size));
      const payload = Buffer.from(records, 'utf8');
      yield header('./PaxHeaders/mmo', payload.byteLength, mtimeSec, 'x', 0o644);
      yield payload;
      yield padding(payload.byteLength);
    }
    const shortName = needsPax ? name.slice(0, 100) : name;
    if (e.kind === 'dir') {
      yield header(shortName, 0, mtimeSec, '5', e.mode || 0o755);
      continue;
    }
    yield header(shortName, Math.min(e.size, MAX_OCTAL_SIZE), mtimeSec, '0', e.mode || 0o644);
    let written = 0;
    if (e.size > 0) {
      const stream = createReadStream(e.abs, { highWaterMark: 1024 * 1024 });
      try {
        for await (const chunk of stream) {
          const buf = chunk as Buffer;
          if (shouldAbort?.()) throw new Error('aborted');
          const remaining = e.size - written;
          if (remaining <= 0) break;
          const slice = buf.byteLength > remaining ? buf.subarray(0, remaining) : buf;
          written += slice.byteLength;
          bytes += slice.byteLength;
          yield slice;
          if (written >= e.size) break;
        }
      } finally {
        stream.destroy();
      }
      if (written < e.size) {
        const fill = Buffer.alloc(e.size - written);
        bytes += fill.byteLength;
        yield fill;
      }
    }
    yield padding(e.size);
    files++;
    onProgress?.({ bytes, files, current: e.rel });
  }
  yield Buffer.alloc(TAR_BLOCK * 2);
}

// --- Lecture --------------------------------------------------------------------------------------------

interface ParsedHeader {
  name: string;
  size: number;
  mtimeSec: number;
  typeflag: string;
  mode: number;
  /** Cible d'un lien symbolique (typeflag `2`). */
  linkname: string;
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  if (text === '') return 0;
  // Encodage binaire base-256 (GNU) pour les très grandes valeurs
  const first = buf[offset] ?? 0;
  if (first & 0x80) {
    let v = 0;
    for (let i = 1; i < length; i++) v = v * 256 + (buf[offset + i] ?? 0);
    return v;
  }
  return parseInt(text, 8) || 0;
}

function parseHeader(buf: Buffer): ParsedHeader | undefined {
  if (buf.every((b) => b === 0)) return undefined;
  const stored = parseInt(readString(buf, 148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (buf[i] ?? 0);
  if (stored !== sum) throw new Error('tar: invalid header checksum');
  const prefix = readString(buf, 345, 155);
  const base = readString(buf, 0, 100);
  return {
    name: prefix === '' ? base : `${prefix}/${base}`,
    size: readOctal(buf, 124, 12),
    mtimeSec: readOctal(buf, 136, 12),
    typeflag: readString(buf, 156, 1) || '0',
    mode: readOctal(buf, 100, 8),
    linkname: readString(buf, 157, 100),
  };
}

function parsePax(payload: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < payload.byteLength) {
    const space = payload.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(payload.subarray(pos, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = payload.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

export interface ExtractProgress {
  bytes: number;
  files: number;
  current: string;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  /** Entrées refusées (chemin hors du dossier cible, types inconnus). */
  skipped: string[];
}

/** Chemin relatif sûr (pas d'absolu, pas de `..`, séparateurs normalisés) ou `undefined`. */
export function safeRelative(name: string): string | undefined {
  const norm = name
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
  if (norm === '' || norm === '.') return undefined;
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return undefined;
  const parts = norm.split('/').filter((p) => p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '')) return undefined;
  return parts.join('/');
}

/**
 * Extrait un flux tar dans `dest`. Les fichiers sont écrits séquentiellement ; les dossiers créés à
 * la volée. Résout quand le flux est terminé (fin d'archive ou EOF).
 */
export interface ExtractOptions {
  onProgress?: (p: ExtractProgress) => void;
  shouldAbort?: () => boolean;
  /** Phase 9 : ignore les N premiers composants de chemin (`jdk-17.0.12+7-jre/bin/java` → `bin/java`). */
  stripComponents?: number;
  /** Phase 9 : applique le mode POSIX de l'archive (bit exécutable de `bin/java`) ; ignoré sous Windows. */
  preserveMode?: boolean;
  /** Phase 9 : crée les liens symboliques dont la cible reste dans `dest` (JRE macOS) ; sinon ignorés. */
  symlinks?: boolean;
}

export async function extractTar(
  source: AsyncIterable<Uint8Array>,
  dest: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const strip = options.stripComponents ?? 0;
  const preserveMode = options.preserveMode === true && process.platform !== 'win32';
  const entryRel = (name: string): string | undefined => {
    const rel = safeRelative(name);
    if (rel === undefined || strip === 0) return rel;
    const parts = rel.split('/');
    return parts.length > strip ? parts.slice(strip).join('/') : undefined;
  };
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;
  let pending: Buffer = Buffer.alloc(0);
  let paxOverrides: Record<string, string> | undefined;
  let paxLink: string | undefined;
  let current:
    | {
        header: ParsedHeader;
        rel: string | undefined;
        remaining: number;
        padding: number;
        handle: Awaited<ReturnType<typeof open>> | undefined;
        abs: string | undefined;
      }
    | undefined;
  let paxRemaining:
    | { kind: 'pax' | 'longname' | 'ignore'; size: number; padding: number; chunks: Buffer[] }
    | undefined;
  const flow = { done: false };

  const finishCurrent = async (): Promise<void> => {
    if (!current) return;
    if (current.handle) await current.handle.close();
    if (current.abs !== undefined && current.rel !== undefined) {
      const mtime = new Date(current.header.mtimeSec * 1000);
      await utimes(current.abs, mtime, mtime).catch(() => undefined);
      files++;
      options.onProgress?.({ bytes, files, current: current.rel });
    }
    current = undefined;
  };

  const startEntry = async (h: ParsedHeader): Promise<void> => {
    const name = paxOverrides?.path ?? h.name;
    const size = paxOverrides?.size === undefined ? h.size : Number(paxOverrides.size);
    paxLink = paxOverrides?.linkpath;
    paxOverrides = undefined;
    const rel = entryRel(name);
    const pad = size % TAR_BLOCK === 0 ? 0 : TAR_BLOCK - (size % TAR_BLOCK);
    if (rel === undefined) {
      if (name !== '' && (strip === 0 || safeRelative(name) === undefined)) skipped.push(name);
      current = {
        header: h,
        rel: undefined,
        remaining: size,
        padding: pad,
        handle: undefined,
        abs: undefined,
      };
      return;
    }
    const abs = path.join(dest, ...rel.split('/'));
    if (h.typeflag === '5') {
      await mkdir(abs, { recursive: true });
      current = {
        header: h,
        rel: undefined,
        remaining: size,
        padding: pad,
        handle: undefined,
        abs: undefined,
      };
      return;
    }
    if (h.typeflag === '2' && options.symlinks === true) {
      const target = (paxLink ?? h.linkname).replace(/\\/g, '/');
      paxLink = undefined;
      // Lien relatif dont la résolution reste dans `dest` ; tout le reste est ignoré.
      const root = path.resolve(dest);
      const resolved = path.resolve(path.dirname(abs), target);
      const inside = resolved === root || resolved.startsWith(root + path.sep);
      if (!target.startsWith('/') && !/^[A-Za-z]:/.test(target) && inside) {
        await mkdir(path.dirname(abs), { recursive: true });
        await symlink(target, abs).catch(() => {
          skipped.push(name);
        });
      } else skipped.push(name);
      current = {
        header: h,
        rel: undefined,
        remaining: size,
        padding: pad,
        handle: undefined,
        abs: undefined,
      };
      return;
    }
    if (h.typeflag !== '0' && h.typeflag !== '7' && h.typeflag !== '') {
      skipped.push(name);
      current = {
        header: h,
        rel: undefined,
        remaining: size,
        padding: pad,
        handle: undefined,
        abs: undefined,
      };
      return;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    const handle = await open(abs, 'w', preserveMode ? h.mode & 0o7777 || 0o644 : undefined);
    current = { header: h, rel, remaining: size, padding: pad, handle, abs };
  };

  const consume = async (): Promise<void> => {
    for (;;) {
      if (options.shouldAbort?.()) throw new Error('aborted');
      if (paxRemaining) {
        if (pending.byteLength === 0) return;
        const take = Math.min(pending.byteLength, paxRemaining.size + paxRemaining.padding);
        const slice = pending.subarray(0, take);
        const dataPart = Math.min(slice.byteLength, paxRemaining.size);
        if (dataPart > 0) paxRemaining.chunks.push(Buffer.from(slice.subarray(0, dataPart)));
        paxRemaining.size -= dataPart;
        paxRemaining.padding -= slice.byteLength - dataPart;
        pending = pending.subarray(take);
        if (paxRemaining.size === 0 && paxRemaining.padding === 0) {
          const payload = Buffer.concat(paxRemaining.chunks);
          if (paxRemaining.kind === 'pax') paxOverrides = parsePax(payload);
          else if (paxRemaining.kind === 'longname') {
            const nul = payload.indexOf(0);
            paxOverrides = {
              path: payload.subarray(0, nul === -1 ? payload.byteLength : nul).toString('utf8'),
            };
          }
          paxRemaining = undefined;
        }
        continue;
      }
      if (current) {
        if (pending.byteLength === 0) return;
        const take = Math.min(pending.byteLength, current.remaining + current.padding);
        const slice = pending.subarray(0, take);
        const dataPart = Math.min(slice.byteLength, current.remaining);
        if (dataPart > 0 && current.handle) {
          await current.handle.write(slice.subarray(0, dataPart));
          bytes += dataPart;
        }
        current.remaining -= dataPart;
        current.padding -= slice.byteLength - dataPart;
        pending = pending.subarray(take);
        if (current.remaining === 0 && current.padding === 0) await finishCurrent();
        continue;
      }
      if (pending.byteLength < TAR_BLOCK) return;
      const block = pending.subarray(0, TAR_BLOCK);
      pending = pending.subarray(TAR_BLOCK);
      const h = parseHeader(block);
      if (!h) {
        flow.done = true;
        return;
      }
      if (h.typeflag === 'x' || h.typeflag === 'g' || h.typeflag === 'L') {
        // pax (x), pax global (g : ignoré), GNU longname (L)
        const pad = h.size % TAR_BLOCK === 0 ? 0 : TAR_BLOCK - (h.size % TAR_BLOCK);
        const kind = h.typeflag === 'x' ? 'pax' : h.typeflag === 'L' ? 'longname' : 'ignore';
        paxRemaining = { kind, size: h.size, padding: pad, chunks: [] };
        continue;
      }
      await startEntry(h);
    }
  };

  try {
    for await (const chunk of source) {
      if (flow.done) break;
      pending = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      await consume();
    }
    if (current) {
      // Archive tronquée : le fichier courant est incomplet.
      await finishCurrent();
      throw new Error('tar: unexpected end of archive');
    }
  } finally {
    if (current?.handle) await current.handle.close().catch(() => undefined);
  }
  return { files, bytes, skipped };
}
