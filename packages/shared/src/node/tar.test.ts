import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractTar, listTar, safeRelative, tarEntries, walkTree } from './tar.js';

async function tmpDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(p);
  return Buffer.concat(parts);
}

async function digestTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const abs = path.join(dir, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = await stat(abs);
      if (st.isDirectory()) {
        out[`${r}/`] = 'dir';
        await visit(abs, r);
      } else
        out[r] = createHash('sha256')
          .update(await readFile(abs))
          .digest('hex');
    }
  };
  await visit(root, '');
  return out;
}

describe('tar maison', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir('mmo-tar-'));
  });
  afterEach(() => cleanup());

  it('aller-retour fidèle : fichiers, dossiers vides, noms longs et accentués, gros fichier', async () => {
    const src = path.join(dir, 'src');
    const longName = 'a'.repeat(120);
    await mkdir(path.join(src, 'world', 'region'), { recursive: true });
    await mkdir(path.join(src, 'vide'), { recursive: true });
    await mkdir(path.join(src, longName), { recursive: true });
    await writeFile(path.join(src, 'server.properties'), 'motd=Héllo\n');
    await writeFile(path.join(src, 'world', 'level.dat'), randomBytes(1234));
    await writeFile(
      path.join(src, 'world', 'region', 'r.0.0.mca'),
      randomBytes(3 * 1024 * 1024 + 17),
    );
    await writeFile(path.join(src, longName, 'été.txt'), 'accents');
    await writeFile(path.join(src, 'zero'), '');

    const tree = await walkTree(src, () => false);
    expect(tree.files).toBe(5);
    const tar = await collect(tarEntries(tree.entries));
    expect(tar.byteLength % 512).toBe(0);

    const dest = path.join(dir, 'dest');
    const result = await extractTar(Readable.from([tar]), dest);
    expect(result.files).toBe(5);
    expect(result.bytes).toBe(tree.bytes);
    expect(await digestTree(dest)).toEqual(await digestTree(src));
  });

  it('exclusions et progression', async () => {
    const src = path.join(dir, 'src');
    await mkdir(path.join(src, 'logs'), { recursive: true });
    await mkdir(path.join(src, '.mmo-trash'), { recursive: true });
    await writeFile(path.join(src, 'logs', 'latest.log'), 'log');
    await writeFile(path.join(src, '.mmo-trash', 'x'), 'x');
    await writeFile(path.join(src, 'keep.txt'), 'keep');
    const tree = await walkTree(src, (rel) => rel === 'logs' || rel === '.mmo-trash');
    expect(tree.entries.map((e) => e.rel)).toEqual(['keep.txt']);
    const seen: string[] = [];
    await collect(tarEntries(tree.entries, (p) => seen.push(p.current)));
    expect(seen).toEqual(['keep.txt']);
  });

  it('phase 12 : plafonds d’octets et d’entrées à l’extraction (E_TOO_LARGE)', async () => {
    const src = path.join(dir, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, 'a.bin'), randomBytes(30_000));
    await writeFile(path.join(src, 'b.bin'), randomBytes(30_000));
    const tree = await walkTree(src, () => false);
    const tar = await collect(tarEntries(tree.entries));
    await expect(
      extractTar(Readable.from([tar]), path.join(dir, 'd1'), { maxBytes: 50_000 }),
    ).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
    await expect(
      extractTar(Readable.from([tar]), path.join(dir, 'd2'), { maxEntries: 1 }),
    ).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
    await expect(
      extractTar(Readable.from([tar]), path.join(dir, 'd3'), { maxBytes: 60_000, maxEntries: 2 }),
    ).resolves.toMatchObject({ files: 2, bytes: 60_000 });
  });

  it('refuse les chemins hors cible et signale une archive tronquée', async () => {
    expect(safeRelative('../x')).toBeUndefined();
    expect(safeRelative('/etc/passwd')).toBeUndefined();
    expect(safeRelative('C:/x')).toBeUndefined();
    expect(safeRelative('./a/./b/')).toBe('a/b');
    const src = path.join(dir, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, 'big.bin'), randomBytes(100_000));
    const tree = await walkTree(src, () => false);
    const tar = await collect(tarEntries(tree.entries));
    const dest = path.join(dir, 'dest');
    await expect(extractTar(Readable.from([tar.subarray(0, 50_000)]), dest)).rejects.toThrow(
      /unexpected end/,
    );
  });

  it('lot 4 : listTar lit les en-têtes sans rien écrire (pax compris) et signale une archive tronquée', async () => {
    const src = path.join(dir, 'src');
    const longName = 'x'.repeat(120) + '.dat';
    await mkdir(path.join(src, 'world', 'region'), { recursive: true });
    await mkdir(path.join(src, 'empty'), { recursive: true });
    await writeFile(path.join(src, 'world', 'region', 'r.0.0.mca'), randomBytes(70_000));
    await writeFile(path.join(src, 'world', 'level.dat'), randomBytes(1_000));
    await writeFile(path.join(src, longName), 'long');
    await writeFile(path.join(src, 'server.properties'), 'a=b\n');
    const tree = await walkTree(src, () => false);
    const tar = await collect(tarEntries(tree.entries));
    const seen: string[] = [];
    // Deux morceaux coupés au milieu d'un en-tête : le tampon interne doit recoller.
    const listing = await listTar(Readable.from([tar.subarray(0, 700), tar.subarray(700)]), {
      onEntry: (e) => seen.push(e.rel),
    });
    expect(listing.entries.map((e) => [e.rel, e.kind, e.size])).toEqual([
      ['empty', 'dir', 0],
      ['server.properties', 'file', 4],
      ['world', 'dir', 0],
      ['world/level.dat', 'file', 1_000],
      ['world/region', 'dir', 0],
      ['world/region/r.0.0.mca', 'file', 70_000],
      [longName, 'file', 4],
    ]);
    expect(seen).toEqual(listing.entries.map((e) => e.rel));
    expect(listing.skipped).toEqual([]);
    expect(listing.entries[3]?.mtimeMs).toBeGreaterThan(0);
    // Rien n'a été écrit : le dossier de travail ne contient toujours que la source.
    expect(await readdir(dir)).toEqual(['src']);
    await expect(listTar(Readable.from([tar.subarray(0, 40_000)]))).rejects.toThrow(
      /unexpected end/,
    );
    await expect(listTar(Readable.from([tar]), { maxEntries: 3 })).rejects.toMatchObject({
      code: 'E_TOO_LARGE',
    });
  });

  it('lot 4 : extractTar avec un prédicat d’inclusion n’écrit que les chemins retenus', async () => {
    const src = path.join(dir, 'src');
    await mkdir(path.join(src, 'world', 'region'), { recursive: true });
    await mkdir(path.join(src, 'config'), { recursive: true });
    await writeFile(path.join(src, 'world', 'region', 'r.0.0.mca'), randomBytes(5_000));
    await writeFile(path.join(src, 'world', 'level.dat'), 'level');
    await writeFile(path.join(src, 'config', 'a.toml'), 'a');
    await writeFile(path.join(src, 'server.properties'), 'a=b\n');
    const tree = await walkTree(src, () => false);
    const tar = await collect(tarEntries(tree.entries));
    const dest = path.join(dir, 'dest');
    const wanted = ['world/region', 'server.properties'];
    const include = (rel: string): boolean =>
      wanted.some((p) => rel === p || rel.startsWith(p + '/'));
    const result = await extractTar(Readable.from([tar]), dest, { include });
    expect(result).toMatchObject({ files: 2, bytes: 5_004, skipped: [] });
    expect(Object.keys(await digestTree(dest)).sort()).toEqual([
      'server.properties',
      'world/',
      'world/region/',
      'world/region/r.0.0.mca',
    ]);
  });
});
