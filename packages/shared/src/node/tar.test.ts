import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractTar, safeRelative, tarEntries, walkTree } from './tar.js';

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
});
