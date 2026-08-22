/** Phase 12 — `extractZip` borné : plafonds d'octets/entrées et zip « menteur » (taille déclarée < réelle). */
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildZip, tmpDir } from '../test/helpers.js';
import { extractZip } from './zip.js';

describe('extractZip (phase 12)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir('mmo-zip-'));
  });
  afterEach(() => cleanup());

  it('plafonds d’octets et d’entrées (E_TOO_LARGE), extraction nominale sinon', async () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.alloc(30_000, 1), deflate: true },
      { name: 'b.txt', data: Buffer.alloc(30_000, 2) },
    ]);
    const file = path.join(dir, 'ok.zip');
    await writeFile(file, zip);
    await expect(
      extractZip(file, path.join(dir, 'd1'), { maxBytes: 50_000 }),
    ).rejects.toMatchObject({ code: 'E_TOO_LARGE' });
    await expect(extractZip(file, path.join(dir, 'd2'), { maxEntries: 1 })).rejects.toMatchObject({
      code: 'E_TOO_LARGE',
    });
    await expect(extractZip(file, path.join(dir, 'd3'))).resolves.toMatchObject({
      files: 2,
      bytes: 60_000,
    });
    expect((await readFile(path.join(dir, 'd3', 'a.txt'))).equals(Buffer.alloc(30_000, 1))).toBe(
      true,
    );
  });

  it('zip menteur : taille déclarée minuscule, flux inflaté énorme → coupé sur le flux réel', async () => {
    const zip = buildZip([{ name: 'bomb.bin', data: Buffer.alloc(2_000_000, 0), deflate: true }]);
    // Falsifie la taille décompressée (répertoire central + en-tête local) à 10 octets.
    const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, cen + 24);
    zip.writeUInt32LE(10, 22);
    const file = path.join(dir, 'liar.zip');
    await writeFile(file, zip);
    await expect(
      extractZip(file, path.join(dir, 'd'), { maxBytes: 100_000 }),
    ).rejects.toMatchObject({
      code: 'E_TOO_LARGE',
    });
    // Le fichier partiel ne dépasse jamais le plafond.
    const partial = await stat(path.join(dir, 'd', 'bomb.bin')).catch(() => undefined);
    expect(partial === undefined || partial.size <= 100_000 + 64 * 1024).toBe(true);
  });
});
