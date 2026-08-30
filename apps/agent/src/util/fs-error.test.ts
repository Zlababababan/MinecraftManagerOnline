/**
 * Un refus de droits doit RESTER lisible de bout en bout. Le défaut corrigé ici s'était vu en
 * vrai : l'agent en service système ne pouvait pas écrire dans les dossiers de serveurs, et
 * l'utilisateur lisait « Start internal error » — zéro information exploitable.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isProtocolError } from '@mmo/protocol';

import { tmpDir } from '../test/helpers.js';
import { assertServerDirWritable, fsProtocolError, runningAs, withFsErrors } from './fs-error.js';

/** Une erreur système telle que Node la produit réellement. */
function sysError(code: string, filePath: string, syscall = 'open'): Error {
  return Object.assign(new Error(`${code}: denied, ${syscall} '${filePath}'`), {
    code,
    syscall,
    path: filePath,
  });
}

/** `chmod` n'a de sens que sur POSIX ; sous Windows la traduction d'erreur reste le filet. */
const posix = process.platform !== 'win32';
/** root ignore les bits de permission : le refus attendu ne se produirait pas. */
const unprivileged = posix && typeof process.getuid === 'function' && process.getuid() !== 0;

describe('traduction des refus du système de fichiers', () => {
  it('nomme le chemin, le compte et la cause système', () => {
    const error = fsProtocolError(sysError('EACCES', '/srv/mc/server.properties'));
    expect(isProtocolError(error)).toBe(true);
    expect(error?.code).toBe('E_IO');
    // `reason` est la clé de la variante i18n : l'UI dira quoi faire, pas « erreur disque ».
    expect(error?.details).toMatchObject({
      reason: 'EACCES',
      path: '/srv/mc/server.properties',
      syscall: 'open',
      user: runningAs(),
    });
    // Réessayer un refus de droits redonne le même refus : ne pas inviter à recommencer.
    expect(error?.retryable).toBe(false);
    expect(error?.message).toContain('/srv/mc/server.properties');
  });

  it('couvre les autres refus durables, et laisse passer le reste', () => {
    for (const code of ['EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR']) {
      expect(fsProtocolError(sysError(code, '/srv/mc'))?.details?.reason).toBe(code);
    }
    // Un fichier absent n'est pas un problème de droits : le travestir en E_IO ferait perdre
    // l'information utile (le dossier n'existe pas).
    expect(fsProtocolError(sysError('ENOENT', '/srv/mc'))).toBeUndefined();
    expect(fsProtocolError(new Error('boom'))).toBeUndefined();
    expect(fsProtocolError(undefined)).toBeUndefined();
  });

  it('retombe sur le chemin fourni quand l’erreur n’en porte pas', () => {
    const bare = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    expect(fsProtocolError(bare, '/srv/fallback')?.details?.path).toBe('/srv/fallback');
  });

  it('withFsErrors traduit, mais ne masque pas les erreurs étrangères', async () => {
    await expect(
      withFsErrors('/srv/mc', () => Promise.reject(sysError('EACCES', '/srv/mc/x'))),
    ).rejects.toMatchObject({ code: 'E_IO', details: { reason: 'EACCES' } });
    const other = new Error('pas un problème de fichiers');
    await expect(withFsErrors('/srv/mc', () => Promise.reject(other))).rejects.toBe(other);
    await expect(withFsErrors('/srv/mc', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('un compte est toujours nommé, même sans variables d’environnement', () => {
    expect(runningAs()).not.toBe('');
  });
});

describe('contrôle d’inscriptibilité du dossier de serveur', () => {
  it('laisse passer un dossier normal', async () => {
    const { dir, cleanup } = await tmpDir();
    try {
      await expect(assertServerDirWritable(dir)).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it.runIf(unprivileged)(
    'refuse un dossier en lecture seule, avec le geste qui répare',
    async () => {
      const { dir, cleanup } = await tmpDir();
      const server = path.join(dir, 'stoneblock');
      await mkdir(server);
      await writeFile(path.join(server, 'server.properties'), 'motd=x\n');
      await chmod(server, 0o555);
      try {
        await expect(assertServerDirWritable(server)).rejects.toMatchObject({
          code: 'E_IO',
          details: { reason: 'EACCES', path: server },
        });
      } finally {
        await chmod(server, 0o755);
        await cleanup();
      }
    },
  );

  it('ne transforme pas un dossier absent en problème de droits', async () => {
    if (!posix) return; // sous Windows le contrôle est volontairement inopérant
    await expect(
      assertServerDirWritable(path.join('/', 'srv', 'absent-mmo')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
