// Spike n°3 — zstd dans node:zlib (Node ≥ 22.15 / 23.8 / 24) : API streaming, options, perfs vs gzip.
// usage: node zstd.mjs [fichier-ou-dossier échantillon]   (défaut : ~48 Mo de données synthétiques mixtes)
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';

console.log(`node ${process.version} — zlib ${process.versions.zlib}, zstd ${process.versions.zstd ?? '(non exposé)'}`);
const api = ['zstdCompress', 'zstdCompressSync', 'zstdDecompress', 'zstdDecompressSync', 'createZstdCompress', 'createZstdDecompress'];
console.log('API présente :', api.map((k) => `${k}=${typeof zlib[k] === 'function' ? 'oui' : 'NON'}`).join(' '));
console.log('constants :', Object.keys(zlib.constants).filter((k) => k.startsWith('ZSTD_')).slice(0, 12).join(', '), '…');

// Échantillon : concatène des fichiers d'un dossier (région .mca/.mcr, NBT .dat, json, jar) ou synthétique.
function loadSample(arg) {
  if (arg && fs.existsSync(arg)) {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mca|mcr|dat|json|toml|cfg|jar|txt|nbt|properties)$/.test(e.name)) files.push(p); } };
    fs.statSync(arg).isDirectory() ? walk(arg) : files.push(arg);
    const bufs = []; let total = 0;
    for (const f of files) { if (total > 64 * 1048576) break; const b = fs.readFileSync(f); bufs.push(b); total += b.length; }
    console.log(`échantillon réel : ${files.length} fichiers, ${Math.round(total / 1048576)} Mo`);
    return Buffer.concat(bufs);
  }
  const parts = [];
  for (let i = 0; i < 24; i++) parts.push(Buffer.from(JSON.stringify({ i, name: `player${i}`, pos: [i * 1.5, 64, -i], inv: Array.from({ length: 200 }, (_, j) => ({ id: `minecraft:item_${j % 37}`, count: j % 64 })) }).repeat(300)));
  for (let i = 0; i < 24; i++) { const b = Buffer.alloc(1048576); for (let j = 0; j < b.length; j++) b[j] = (j * 31 + i * 7) & 0xff ^ (Math.random() * 16 | 0); parts.push(b); }
  const buf = Buffer.concat(parts);
  console.log(`échantillon synthétique : ${Math.round(buf.length / 1048576)} Mo (moitié texte répétitif, moitié bruité)`);
  return buf;
}
const sample = loadSample(process.argv[2]);

async function bench(label, mkCompress, mkDecompress) {
  const chunks = [];
  let t0 = performance.now();
  await pipeline(Readable.from([sample]), mkCompress(), new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }));
  const tc = performance.now() - t0;
  const compressed = Buffer.concat(chunks);
  const out = [];
  t0 = performance.now();
  await pipeline(Readable.from([compressed]), mkDecompress(), new Writable({ write(c, _e, cb) { out.push(c); cb(); } }));
  const td = performance.now() - t0;
  const ok = Buffer.concat(out).equals(sample);
  const mb = sample.length / 1048576;
  console.log(`  ${label.padEnd(22)} ratio ${(sample.length / compressed.length).toFixed(2)}x  compress ${Math.round(tc).toString().padStart(5)} ms (${(mb / (tc / 1000)).toFixed(0).padStart(4)} Mo/s)  decompress ${Math.round(td).toString().padStart(4)} ms (${(mb / (td / 1000)).toFixed(0).padStart(4)} Mo/s)  ${ok ? 'OK' : 'CORROMPU !'}`);
}

console.log('\n[streaming] pipeline Readable → createXxx → Writable :');
await bench('gzip level 6 (défaut)', () => zlib.createGzip(), () => zlib.createGunzip());
await bench('gzip level 1', () => zlib.createGzip({ level: 1 }), () => zlib.createGunzip());
for (const lvl of [1, 3, 6, 10]) {
  await bench(`zstd level ${lvl}`, () => zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: lvl } }), () => zlib.createZstdDecompress());
}
await bench('zstd 3 + 4 threads', () => zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3, [zlib.constants.ZSTD_c_nbWorkers]: 4 } }), () => zlib.createZstdDecompress());

console.log('\n[sync / promisifié] :');
let t0 = performance.now();
const z = zlib.zstdCompressSync(sample, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
console.log(`  zstdCompressSync lvl3 : ${Math.round(performance.now() - t0)} ms, ${z.length} octets`);
t0 = performance.now();
const back = await new Promise((res, rej) => zlib.zstdDecompress(z, (e, b) => (e ? rej(e) : res(b))));
console.log(`  zstdDecompress (cb)   : ${Math.round(performance.now() - t0)} ms, identique=${back.equals(sample)}`);

console.log('\n[robustesse] :');
try { zlib.zstdDecompressSync(Buffer.from('pas du zstd')); console.log('  données invalides : PAS d\'erreur ?!'); } catch (e) { console.log(`  données invalides → erreur propre : ${e.code} ${e.message}`); }
try { zlib.zstdDecompressSync(z.subarray(0, z.length >> 1)); console.log('  flux tronqué : PAS d\'erreur ?!'); } catch (e) { console.log(`  flux tronqué → erreur : ${e.code} ${e.message}`); }
// Frame magic + vérification qu'un flux zstd standard (avec checksum) est produit
console.log(`  magic number : 0x${z.readUInt32LE(0).toString(16)} (attendu 0xfd2fb528)`);
const withChecksum = zlib.zstdCompressSync(Buffer.from('abc'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
console.log(`  option checksumFlag acceptée : ${withChecksum.length} octets`);
console.log('\nterminé');
