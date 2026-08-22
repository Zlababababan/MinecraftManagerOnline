/**
 * Archives tar(.gz) et zip en pur Node (aucune dépendance, pas de python) pour le pipeline de
 * release (doc 03 §3). Lecture : tarballs/zip officiels de Node et de shawl. Écriture :
 * archives agent reproductibles (entrées triées, horodatage fixe, modes explicites).
 */
import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

// --- tar ------------------------------------------------------------------------------------

const BLOCK = 512;

function octal(buf, offset, length) {
  const s = buf
    .toString('latin1', offset, offset + length)
    .replace(/\0.*$/s, '')
    .trim();
  return s === '' ? 0 : parseInt(s, 8);
}
function str(buf, offset, length) {
  return buf.toString('utf8', offset, offset + length).replace(/\0.*$/s, '');
}

/** Lit un tar (déjà décompressé) → entrées { name, type ('file'|'dir'|'symlink'|other), mode, size, data, linkName }. */
export function readTar(buffer) {
  const entries = [];
  let pos = 0;
  let longName;
  let paxPath;
  while (pos + BLOCK <= buffer.length) {
    const header = buffer.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const magic = header.toString('latin1', 257, 5);
    let name = str(header, 0, 100);
    if (magic === 'ustar') {
      const prefix = str(header, 345, 155);
      if (prefix !== '') name = `${prefix}/${name}`;
    }
    const dataStart = pos + BLOCK;
    const data = buffer.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x') {
      paxPath = parsePax(data).path;
      continue;
    }
    if (type === 'g') continue;
    if (longName !== undefined) name = longName;
    if (paxPath !== undefined) name = paxPath;
    longName = undefined;
    paxPath = undefined;
    const kind =
      type === '0' || type === '\0'
        ? 'file'
        : type === '5'
          ? 'dir'
          : type === '2'
            ? 'symlink'
            : type;
    entries.push({
      name,
      type: kind,
      mode: octal(header, 100, 8) & 0o7777,
      size,
      data: kind === 'file' ? data : Buffer.alloc(0),
      linkName: kind === 'symlink' ? str(header, 157, 100) : undefined,
    });
  }
  return entries;
}

function parsePax(data) {
  const out = {};
  let p = 0;
  const text = data.toString('utf8');
  while (p < text.length) {
    const sp = text.indexOf(' ', p);
    if (sp === -1) break;
    const len = Number(text.slice(p, sp));
    const record = text.slice(sp + 1, p + len - 1);
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    p += len;
  }
  return out;
}

export function readTarGz(buffer) {
  return readTar(gunzipSync(buffer));
}

function writeOctal(buf, offset, length, value) {
  buf.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'latin1');
}

function tarHeader(name, type, mode, size, mtime, linkName = '') {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.write('        ', 148, 8, 'latin1');
  h.write(type, 156, 1, 'latin1');
  h.write(linkName, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  h.write('root', 265, 32, 'latin1');
  h.write('root', 297, 32, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

function pad(size) {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

/**
 * Écrit un tar à partir d'entrées { name, data?, mode?, type? ('file'|'dir'|'symlink'), linkName? }.
 * Entrées triées par nom (reproductible), mtime fixe (`mtime` en secondes).
 */
export function writeTar(entries, { mtime = 0 } = {}) {
  const chunks = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const type = e.type ?? 'file';
    const data = type === 'file' ? (e.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const mode = e.mode ?? (type === 'dir' ? 0o755 : 0o644);
    const name = type === 'dir' && !e.name.endsWith('/') ? `${e.name}/` : e.name;
    if (Buffer.byteLength(name) > 100 || (e.linkName && Buffer.byteLength(e.linkName) > 100)) {
      const records = [];
      if (Buffer.byteLength(name) > 100) records.push(paxRecord('path', name));
      if (e.linkName && Buffer.byteLength(e.linkName) > 100)
        records.push(paxRecord('linkpath', e.linkName));
      const pax = Buffer.from(records.join(''), 'utf8');
      chunks.push(tarHeader('./PaxHeaders/' + name.slice(0, 80), 'x', 0o644, pax.length, mtime));
      chunks.push(pax, pad(pax.length));
    }
    const typeFlag = type === 'dir' ? '5' : type === 'symlink' ? '2' : '0';
    chunks.push(
      tarHeader(name.slice(0, 100), typeFlag, mode, data.length, mtime, e.linkName ?? ''),
      data,
      pad(data.length),
    );
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len++;
  return `${len}${body}`;
}

export function writeTarGz(entries, options = {}) {
  return gzipSync(writeTar(entries, options), { level: 9 });
}

// --- zip ------------------------------------------------------------------------------------

/** Lit un zip (sans zip64) → entrées { name, type, mode, size, data }. */
export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip: end of central directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const externalAttrs = buffer.readUInt32LE(p + 38);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const isDir = name.endsWith('/');
    let data = Buffer.alloc(0);
    if (!isDir) {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
      if (data.length !== size) throw new Error(`zip: size mismatch for ${name}`);
    }
    const unixMode = (externalAttrs >>> 16) & 0o7777;
    entries.push({
      name,
      type: isDir ? 'dir' : 'file',
      mode: unixMode || (isDir ? 0o755 : 0o644),
      size,
      data,
    });
  }
  return entries;
}

/** Écrit un zip reproductible (deflate, date DOS fixe, entrées triées). */
export function writeZip(entries, { dosDate = 0x5821, dosTime = 0 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const sorted = [...entries]
    .filter((e) => (e.type ?? 'file') !== 'symlink')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const isDir = (e.type ?? 'file') === 'dir';
    const name = Buffer.from(isDir && !e.name.endsWith('/') ? `${e.name}/` : e.name, 'utf8');
    const data = isDir ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0));
    const method = data.length === 0 ? 0 : 8;
    const packed = method === 8 ? deflateRawSync(data, { level: 9 }) : data;
    const crc = data.length === 0 ? 0 : crc32(data) >>> 0;
    const mode = e.mode ?? (isDir ? 0o755 : 0o644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // fait par : unix, version 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(
      ((((isDir ? 0o40000 : 0o100000) | mode) << 16) | (isDir ? 0x10 : 0)) >>> 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** Lit une archive selon son extension. */
export function readArchive(file, buffer) {
  if (file.endsWith('.zip')) return readZip(buffer);
  if (file.endsWith('.tar.gz') || file.endsWith('.tgz')) return readTarGz(buffer);
  if (file.endsWith('.tar')) return readTar(buffer);
  throw new Error(`unsupported archive: ${file}`);
}
