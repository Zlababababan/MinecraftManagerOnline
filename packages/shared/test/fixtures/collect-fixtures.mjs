#!/usr/bin/env node
/**
 * Collecteur de fixtures de détection — prélève, dans de vrais dossiers serveurs, UNIQUEMENT les
 * fichiers utiles aux heuristiques (doc 06 §2), les anonymise, et reconstruit des mini-jars ne
 * contenant que les entrées inspectées (manifest, version.json, install.properties, descripteurs
 * de mods). Les originaux ne sont jamais modifiés.
 *
 * Usage : node collect-fixtures.mjs <racine-source> <nom-source>=<nom-fixture> [...]
 *   ex.  node collect-fixtures.mjs "E:/Minecraft/Server" ATM10_6.0=neoforge-atm10 "Vanilla 1.20.1/server"=vanilla-1.20.1
 *
 * Sans dépendance (Node ≥ 22.2 : zlib.crc32). Reproductible ; le résultat est committé dans
 * `servers/` — ce script ne tourne qu'à l'ajout d'une fixture.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [, , sourceRoot, ...pairs] = process.argv;
if (!sourceRoot || pairs.length === 0) {
  console.error('usage: collect-fixtures.mjs <racine-source> <src>=<fixture> ...');
  process.exit(2);
}
const outRoot = path.join(import.meta.dirname, 'servers');

// ---------------------------------------------------------------------------------------------
// Lecture zip minimale (central directory → entrées ; store + deflate)
// ---------------------------------------------------------------------------------------------
function readZipEntries(file) {
  const buf = fs.readFileSync(file);
  const eocd = findEocd(buf);
  if (eocd < 0) return undefined;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, csize, local });
    p += 46 + nlen + elen + clen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return undefined;
      const nlen = buf.readUInt16LE(e.local + 26);
      const elen = buf.readUInt16LE(e.local + 28);
      const start = e.local + 30 + nlen + elen;
      const data = buf.subarray(start, start + e.csize);
      return e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    },
  };
}
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Écriture zip minimale (store uniquement)
// ---------------------------------------------------------------------------------------------
function writeZip(file, files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x5000, 12); // 10:00:00
    lh.writeUInt16LE(0x5821, 14); // 2024-01-01
    lh.writeUInt32LE(crc, 16);
    lh.writeUInt32LE(data.length, 20);
    lh.writeUInt32LE(data.length, 24);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0x5000, 12);
    ch.writeUInt16LE(0x5821, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...locals, ...centrals, eocd]));
}

/** Ne garde du MANIFEST.MF que la section principale (Main-Class & co), jamais les digests. */
function trimManifest(text) {
  const main = text.replace(/\r\n/g, '\n').split('\n\n')[0] ?? '';
  return main.trimEnd() + '\n\n';
}

const JAR_KEEP = [
  'META-INF/MANIFEST.MF',
  'version.json',
  'install_profile.json',
  'install.properties',
  'fabric.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'mcmod.info',
  'quilt.mod.json',
];

/** Reconstruit un mini-jar ne contenant que les entrées inspectées par la détection. */
function miniJar(src, dst) {
  const zip = readZipEntries(src);
  const files = [];
  if (zip) {
    for (const name of JAR_KEEP) {
      if (!zip.names.includes(name)) continue;
      let data = zip.read(name);
      if (name === 'META-INF/MANIFEST.MF') data = Buffer.from(trimManifest(data.toString('utf8')));
      else if (name === 'install_profile.json') data = Buffer.from('{"_fixture":"truncated"}\n');
      else if (data.length > 4096 && name !== 'version.json') data = data.subarray(0, 4096);
      files.push([name, data]);
    }
  }
  if (files.length === 0) files.push(['_fixture', Buffer.from('empty placeholder\n')]);
  writeZip(dst, files);
}

// ---------------------------------------------------------------------------------------------
// Anonymisation
// ---------------------------------------------------------------------------------------------
const NAME_PATTERNS = [
  /UUID of player (\S+) is/g,
  /(\S+)\[\/[\d.:a-f\[\]]+\] logged in/g,
  /(\S+) joined the game/g,
  /(\S+) left the game/g,
  /<([^>\s]+)> /g,
  /Disconnecting (\S+?):/g,
  /(\S+) lost connection/g,
  /(\S+) has made the advancement/g,
  /(\S+) has completed the challenge/g,
  /(\S+) has reached the goal/g,
  /name=([^\],\s]+)/g,
  /(\S+) moved too quickly/g,
  /(\S+) moved wrongly/g,
  /(\S+) issued server command/g,
];

function anonymizeText(text) {
  const names = new Map();
  const uuids = new Map();
  const ips = new Map();
  const id = (map, key) => {
    if (!map.has(key)) map.set(key, map.size + 1);
    return map.get(key);
  };
  for (const re of NAME_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const n = m[1];
      if (
        n &&
        n.length >= 3 &&
        n.length <= 16 &&
        /^[A-Za-z0-9_]+$/.test(n) &&
        !/^(Server|Rcon|Console)$/i.test(n)
      ) {
        id(names, n);
      }
    }
  }
  let out = text;
  // Les noms longs d'abord (évite qu'un nom soit préfixe d'un autre).
  for (const n of [...names.keys()].sort((a, b) => b.length - a.length)) {
    out = out.replace(
      new RegExp(
        `(?<![A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`,
        'g',
      ),
      `Player${names.get(n)}`,
    );
  }
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
    const k = id(uuids, u.toLowerCase());
    return `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  });
  out = out.replace(/\b(?!0\.0\.0\.0\b)(?!127\.0\.0\.1\b)(\d{1,3}\.){3}\d{1,3}\b/g, (ip) => {
    if (/^(\d+\.){1,2}\d+$/.test(ip)) return ip; // versions x.y.z
    return `203.0.113.${id(ips, ip)}`;
  });
  const v6 = new Map();
  out = out.replace(/\[\/\[([0-9a-f:]+)\]:(\d+)\]/gi, (_m, ip, port) =>
    /^(0:0:0:0:0:0:0:1|::1)$/.test(ip)
      ? `[/[::1]:${port}]`
      : `[/[2001:db8::${id(v6, ip.toLowerCase())}]:${port}]`,
  );
  out = out.replace(
    /\b(2001|2a0[0-9a-f]|fe80|fd[0-9a-f]{2}):[0-9a-f:]{3,}/gi,
    (ip) => `2001:db8::${id(v6, ip.toLowerCase())}`,
  );
  out = out.replace(/[A-Z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\user');
  out = out.replace(/[A-Z]:\\Minecraft\\Server\\/g, 'E:\\srv\\');
  out = out.replace(/\/home\/[^/\s]+/g, '/home/user');
  return out;
}

function anonymizeProperties(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = /^([^=#]+)=(.*)$/.exec(line);
      if (!m) return line;
      const key = m[1].trim();
      if (key === 'rcon.password' && m[2] !== '') return `${key}=REDACTED`;
      if (
        [
          'level-seed',
          'server-ip',
          'resource-pack',
          'resource-pack-sha1',
          'resource-pack-prompt',
        ].includes(key)
      )
        return `${key}=`;
      return line;
    })
    .join('\n');
}

/** Extrait de latest.log : début + lignes « intéressantes » avec leurs continuations (stacktraces). */
function excerptLog(text) {
  const lines = text.split(/\r?\n/);
  const isEntry = (l) => /^\[\d{2}:\d{2}:\d{2}\]|^\[\d{2}[^\]\s]*\d{4} \d{2}:\d{2}:\d{2}/.test(l);
  const interesting =
    /Starting minecraft server version|Done \(|joined the game|left the game|logged in with entity|Loading Minecraft|for Minecraft .* loading|fml\.mcVersion|Starting Minecraft server on|Preparing spawn area|\/(WARN|ERROR|FATAL)\]|Stopping the server|Can't keep up|You need to agree|lost connection|UUID of player/;
  const keep = new Set();
  for (let i = 0; i < Math.min(50, lines.length); i++) keep.add(i);
  let errors = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!interesting.test(l)) continue;
    if (/\/(ERROR|FATAL)\]/.test(l) && errors++ > 4) continue;
    keep.add(i);
    // continuations (stacktrace, multi-lignes)
    for (let j = i + 1; j < lines.length && j < i + 20 && !isEntry(lines[j]); j++) keep.add(j);
    if (keep.size > 260) break;
  }
  return (
    [...keep]
      .sort((a, b) => a - b)
      .map((i) => lines[i])
      .join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------------------------
// Collecte
// ---------------------------------------------------------------------------------------------
const TEXT_ROOT =
  /^(server\.properties|eula\.txt|user_jvm_args\.txt|variables\.txt|settings\.(bat|sh|cfg)|server-setup-config\.yaml|fabric-server-launcher\.properties|.*\.(bat|sh|ps1))$/i;
const MAX_TEXT = 64 * 1024;

function collect(srcName, fixtureName) {
  const src = path.join(sourceRoot, srcName);
  const dst = path.join(outRoot, fixtureName);
  if (!fs.existsSync(src)) throw new Error(`source introuvable : ${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const manifest = { source: srcName, files: [] };
  const note = (p) => manifest.files.push(p.replace(/\\/g, '/'));

  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const p = path.join(src, ent.name);
    if (ent.isFile()) {
      if (TEXT_ROOT.test(ent.name)) {
        if (fs.statSync(p).size > MAX_TEXT) continue;
        let text = fs.readFileSync(p, 'utf8');
        text = ent.name === 'server.properties' ? anonymizeProperties(text) : anonymizeText(text);
        fs.writeFileSync(path.join(dst, ent.name), text);
        note(ent.name);
      } else if (/\.jar$/i.test(ent.name)) {
        miniJar(p, path.join(dst, ent.name));
        note(ent.name);
      } else if (/\.(exe|dll|json|txt|md|pdf|png|log)$/i.test(ent.name)) {
        // présence seulement (placeholder vide) — utile pour les heuristiques de qualification
        fs.writeFileSync(path.join(dst, ent.name), '');
        note(`${ent.name} (placeholder)`);
      }
    } else if (ent.isDirectory()) {
      const name = ent.name;
      if (name === 'libraries') collectLibraries(p, path.join(dst, name), note);
      else if (name === 'mods') collectMods(p, path.join(dst, name), note, 'mods');
      else if (name === 'logs') collectLogs(p, path.join(dst, name), note);
      else if (name === 'versions') collectVersions(p, path.join(dst, name), note);
      else if (name === '.fabric') {
        fs.mkdirSync(path.join(dst, name), { recursive: true });
        fs.writeFileSync(path.join(dst, name, '.gitkeep'), '');
        note('.fabric/');
      } else if (
        /^(world|config|crash-reports|defaultconfigs|kubejs|scripts|backups)$/i.test(name) ||
        fs.existsSync(path.join(p, 'level.dat'))
      ) {
        fs.mkdirSync(path.join(dst, name), { recursive: true });
        fs.writeFileSync(path.join(dst, name, '.gitkeep'), '');
        note(`${name}/ (vide)`);
      }
    }
  }
  fs.writeFileSync(path.join(dst, '.fixture.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ ${fixtureName} ← ${srcName} (${manifest.files.length} entrées)`);
}

function collectLibraries(src, dst, note) {
  for (const rel of ['net/minecraftforge/forge', 'net/neoforged/neoforge']) {
    const dir = path.join(src, rel);
    if (!fs.existsSync(dir)) continue;
    for (const v of fs.readdirSync(dir)) {
      const vdir = path.join(dir, v);
      if (!fs.statSync(vdir).isDirectory()) continue;
      const out = path.join(dst, rel, v);
      fs.mkdirSync(out, { recursive: true });
      for (const f of fs.readdirSync(vdir)) {
        if (/_args\.txt$/.test(f)) {
          fs.copyFileSync(path.join(vdir, f), path.join(out, f));
          note(`libraries/${rel}/${v}/${f}`);
        } else if (/\.jar$/.test(f)) {
          fs.writeFileSync(path.join(out, f), '');
          note(`libraries/${rel}/${v}/${f} (placeholder)`);
        }
      }
    }
  }
  // Présence des autres groupes (fabricmc, minecraft/server) : marqueurs de dossiers
  for (const rel of ['net/fabricmc', 'net/minecraft/server']) {
    const dir = path.join(src, rel);
    if (!fs.existsSync(dir)) continue;
    for (const v of fs.readdirSync(dir).slice(0, 3)) {
      fs.mkdirSync(path.join(dst, rel, v), { recursive: true });
      fs.writeFileSync(path.join(dst, rel, v, '.gitkeep'), '');
      note(`libraries/${rel}/${v}/`);
    }
  }
}

function collectMods(src, dst, note, rel) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  const jars = entries
    .filter((e) => e.isFile() && /\.jar$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  fs.mkdirSync(dst, { recursive: true });
  // Échantillon déterministe : 6 jars répartis sur la liste triée (hash du nom → stable)
  const sample =
    jars.length <= 6
      ? jars
      : [...jars]
          .sort((a, b) =>
            createHash('sha1')
              .update(a)
              .digest('hex')
              .localeCompare(createHash('sha1').update(b).digest('hex')),
          )
          .slice(0, 6);
  for (const j of sample) {
    miniJar(path.join(src, j), path.join(dst, j));
    note(`${rel}/${j}`);
  }
  fs.writeFileSync(path.join(dst, '_count.txt'), `${jars.length}\n`);
  if (jars.length === 0) fs.writeFileSync(path.join(dst, '.gitkeep'), '');
  for (const e of entries) {
    if (e.isDirectory() && /^\d+\.\d+(\.\d+)?$/.test(e.name))
      collectMods(path.join(src, e.name), path.join(dst, e.name), note, `${rel}/${e.name}`);
  }
}

function collectLogs(src, dst, note) {
  const latest = path.join(src, 'latest.log');
  if (!fs.existsSync(latest)) return;
  fs.mkdirSync(dst, { recursive: true });
  const text = fs.readFileSync(latest, 'utf8');
  fs.writeFileSync(path.join(dst, 'latest.log'), anonymizeText(excerptLog(text)));
  note('logs/latest.log (extrait anonymisé)');
}

function collectVersions(src, dst, note) {
  for (const v of fs.readdirSync(src)) {
    const vdir = path.join(src, v);
    if (!fs.statSync(vdir).isDirectory()) continue;
    fs.mkdirSync(path.join(dst, v), { recursive: true });
    for (const f of fs.readdirSync(vdir)) {
      if (/\.jar$/.test(f)) {
        miniJar(path.join(vdir, f), path.join(dst, v, f));
        note(`versions/${v}/${f}`);
      }
    }
  }
}

for (const pair of pairs) {
  const eq = pair.lastIndexOf('=');
  collect(pair.slice(0, eq), pair.slice(eq + 1));
}
