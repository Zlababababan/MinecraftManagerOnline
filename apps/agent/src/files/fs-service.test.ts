import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tmpDir } from '../test/helpers.js';
import { FsService, sha256 } from './fs-service.js';
import { ForbiddenRoots } from './forbidden.js';
import { MARKER_NAME, TRASH_DIR, isReservedPath, normalizeRelative } from './jail.js';

describe('jail des chemins (doc 05 §6)', () => {
  it('normalise les séparateurs et refuse `..`, racines et lettres de lecteur', () => {
    expect(normalizeRelative('world\\region/./r.0.0.mca')).toBe('world/region/r.0.0.mca');
    expect(normalizeRelative('')).toBe('');
    expect(normalizeRelative('./logs/')).toBe('logs');
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:\\Windows', '\\\\server\\share']) {
      expect(() => normalizeRelative(bad), bad).toThrow(
        expect.objectContaining({ code: 'E_INVALID_PAYLOAD' }) as Error,
      );
    }
  });

  it('phase 12 : noms réservés Windows, point/espace final, corbeille et marqueur en toute casse', () => {
    for (const bad of ['CON', 'logs/nul.txt', 'COM1.log', 'foo.', 'bar ', 'a/LPT9/b']) {
      expect(() => normalizeRelative(bad), bad).toThrow(
        expect.objectContaining({ code: 'E_INVALID_PAYLOAD' }) as Error,
      );
    }
    expect(normalizeRelative('console.txt')).toBe('console.txt');
    expect(normalizeRelative('config/nulls.json')).toBe('config/nulls.json');
    expect(isReservedPath('.MMO-TRASH/x')).toBe(true);
    expect(isReservedPath(TRASH_DIR)).toBe(true);
    expect(isReservedPath(MARKER_NAME.toUpperCase())).toBe(true);
    expect(isReservedPath(`world/${MARKER_NAME}`)).toBe(false);
    expect(isReservedPath('mods')).toBe(false);
  });

  it('phase 12 : racines interdites (état et installation de l’agent)', () => {
    const state = path.resolve('/srv/mmo/state');
    const home = path.resolve('/srv/mmo/app');
    const f = new ForbiddenRoots([state, home, undefined]);
    // Égal, contenu, contenant → refusés comme racine de jail ; ancêtre toléré pour un scan.
    expect(f.overlaps(state)).toBe(true);
    expect(f.overlaps(path.join(state, 'x'))).toBe(true);
    expect(f.overlaps(path.resolve('/srv/mmo'))).toBe(true);
    expect(f.overlaps(path.resolve('/srv'))).toBe(true);
    expect(f.overlaps(path.resolve('/srv/minecraft/vanilla'))).toBe(false);
    expect(f.overlaps(path.resolve('/srv/mmo/state-old'))).toBe(false);
    expect(f.inside(path.resolve('/srv'))).toBe(false);
    expect(f.inside(path.join(home, 'versions'))).toBe(true);
    expect(() => {
      f.assert(state, 'server path');
    }).toThrow(expect.objectContaining({ code: 'E_INVALID_PAYLOAD' }) as Error);
    expect(() => {
      f.assert(path.resolve('/srv'), 'watched directory', false);
    }).not.toThrow();
  });
});

describe('FsService (fs.* sur un dossier serveur)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let outside: string;
  let cleanupOutside: () => Promise<void>;
  let now = 1_787_300_000_000;
  let fs: FsService;

  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir());
    ({ dir: outside, cleanup: cleanupOutside } = await tmpDir('mmo-outside-'));
    await mkdir(path.join(dir, 'world', 'region'), { recursive: true });
    await writeFile(path.join(dir, 'server.properties'), 'motd=Hi\n');
    await writeFile(path.join(dir, 'world', 'level.dat'), Buffer.alloc(10));
    fs = new FsService(dir, { now: () => now });
  });
  afterEach(async () => {
    await cleanup();
    await cleanupOutside();
  });

  it('liste (dossiers d’abord, corbeille masquée à la racine), stat, mkdir', async () => {
    await mkdir(path.join(dir, TRASH_DIR));
    const entries = await fs.list('');
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:world',
      'file:server.properties',
    ]);
    expect(entries[1]?.size).toBe(8);
    const s = await fs.stat('world/level.dat');
    expect(s.kind).toBe('file');
    expect(s.size).toBe(10);
    await fs.mkdir('plugins/sub');
    expect((await stat(path.join(dir, 'plugins', 'sub'))).isDirectory()).toBe(true);
    await expect(fs.list('nope')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('read/write : SHA-256, écriture atomique, E_CONFLICT sur édition concurrente', async () => {
    const r = await fs.read('server.properties');
    expect(r).toMatchObject({ content: 'motd=Hi\n', size: 8, truncated: false, encoding: 'utf8' });
    expect(r.sha256).toBe(sha256('motd=Hi\n'));
    const w = await fs.write('server.properties', 'motd=Bye\n', r.sha256);
    expect(w.sha256).toBe(sha256('motd=Bye\n'));
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toBe('motd=Bye\n');
    await expect(fs.write('server.properties', 'x', r.sha256)).rejects.toMatchObject({
      code: 'E_CONFLICT',
    });
    // Nouveau fichier dans un sous-dossier inexistant, sans fichier temporaire résiduel.
    await fs.write('config/new.toml', 'a = 1\n');
    expect(await readdir(path.join(dir, 'config'))).toEqual(['new.toml']);
    // Troncature au-delà de maxBytes
    await writeFile(path.join(dir, 'big.txt'), 'x'.repeat(2000));
    const big = await fs.read('big.txt', 100);
    expect(big.truncated).toBe(true);
    expect(big.content).toHaveLength(100);
    expect(big.size).toBe(2000);
    await expect(fs.read('world')).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
  });

  it('rename/copy : refus d’écraser sans `overwrite`, copie récursive', async () => {
    await fs.copy('world', 'world_backup');
    expect((await stat(path.join(dir, 'world_backup', 'region'))).isDirectory()).toBe(true);
    await expect(fs.copy('world', 'world_backup')).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await expect(fs.copy('world', 'world/inner')).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    await fs.rename('world_backup', 'old/world');
    expect((await stat(path.join(dir, 'old', 'world', 'level.dat'))).isFile()).toBe(true);
    await expect(fs.rename('old/world', 'world')).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await fs.rename('old/world/level.dat', 'world/level.dat', true);
  });

  it('delete → corbeille horodatée, purge après 7 jours', async () => {
    const r = await fs.delete('world/level.dat');
    expect(r.trashedAs).toBe(`${TRASH_DIR}/${String(now)}-level.dat`);
    expect((await readdir(path.join(dir, 'world'))).includes('level.dat')).toBe(false);
    const meta = JSON.parse(
      await readFile(path.join(dir, TRASH_DIR, `${String(now)}-level.dat.mmo-trash.json`), 'utf8'),
    ) as { originalPath: string };
    expect(meta.originalPath).toBe('world/level.dat');
    // Restauration = rename depuis la corbeille.
    await fs.rename(r.trashedAs, 'world/level.dat');
    await fs.delete('world/level.dat');
    await expect(fs.delete(TRASH_DIR)).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
    await expect(fs.delete('nope')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(await fs.purgeTrash()).toBe(0);
    now += 8 * 24 * 3600_000;
    expect(await fs.purgeTrash()).toBe(1);
    expect(await readdir(path.join(dir, TRASH_DIR))).toEqual([]);
  });

  it('phase 12 : corbeille et marqueur jamais cibles de write/mkdir/rename/copy, marqueur jamais déplacé', async () => {
    await writeFile(path.join(dir, MARKER_NAME), '{"serverId":"s1"}');
    await expect(fs.write(MARKER_NAME, '{}')).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
    await expect(fs.write('.MMO-Server.json', '{}')).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    await expect(fs.delete(MARKER_NAME)).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
    await expect(fs.rename(MARKER_NAME, 'x.json')).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    await expect(fs.rename('server.properties', `${TRASH_DIR}/0-x`)).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    await expect(fs.copy('server.properties', '.MMO-TRASH/x')).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    await expect(fs.mkdir(TRASH_DIR)).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
    await expect(fs.write(`${TRASH_DIR}/evil`, 'x')).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
    // Le marqueur reste lisible, et un fichier homonyme dans un sous-dossier n'est pas réservé.
    expect((await fs.read(MARKER_NAME)).content).toContain('s1');
    await fs.write(`world/${MARKER_NAME}`, '{}');
    expect(await stat(path.join(dir, 'world', MARKER_NAME))).toBeTruthy();
  });

  it('refuse les liens symboliques qui sortent de la racine', async () => {
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(outside, path.join(dir, 'link'), 'dir');
    } catch {
      return; // symlinks non autorisés sur cette machine (Windows sans privilège) : test sans objet
    }
    await expect(fs.read('link/secret.txt')).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
    await expect(fs.list('link')).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD' });
    // Le lien lui-même est listé comme tel, sans le suivre.
    const entries = await fs.list('');
    expect(entries.find((e) => e.name === 'link')?.kind).toBe('symlink');
  });
});
