/**
 * Jail des chemins (doc 05 §6 « Fichiers ») : tout chemin reçu du panel est **relatif** à la racine
 * du serveur, normalisé (`/` quel que soit l'OS), sans `..`, sans lettre de lecteur ni racine.
 * Les liens symboliques qui sortent de la racine sont refusés après résolution réelle.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { ProtocolError } from '@mmo/protocol';

export const TRASH_DIR = '.mmo-trash';

/** Normalise un chemin relatif : séparateurs `/`, segments vides et `.` retirés ; `..` refusé. */
export function normalizeRelative(input: string): string {
  if (/^[A-Za-z]:/.test(input) || input.startsWith('/') || input.startsWith('\\')) {
    throw new ProtocolError('E_INVALID_PAYLOAD', 'absolute path refused', {
      details: { path: input },
    });
  }
  const parts = input.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) {
    throw new ProtocolError('E_INVALID_PAYLOAD', 'path traversal refused', {
      details: { path: input },
    });
  }
  for (const part of parts) {
    // Caractères interdits sous Windows (et de toute façon douteux ailleurs) + NUL ; noms de
    // périphériques (`CON`, `NUL`…) ; point/espace final (Windows les retire : `foo.` ≡ `foo`).
    if (/[<>:"|?*\0]/.test(part) || WINDOWS_RESERVED.test(part) || /[. ]$/.test(part)) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'invalid path segment', {
        details: { path: input, segment: part },
      });
    }
  }
  return parts.join('/');
}

export function isTrashPath(relative: string): boolean {
  const first = relative.split('/')[0] ?? '';
  // Casse ignorée : NTFS/APFS confondent `.MMO-TRASH` et `.mmo-trash` (phase 12).
  return first.toLowerCase() === TRASH_DIR;
}

/** Marqueur d'identité du serveur (doc 06) : jamais écrit/déplacé/remplacé par `fs.*`. */
export const MARKER_NAME = '.mmo-server.json';

/**
 * Chemin réservé à l'agent : corbeille (source des purges) et marqueur à la racine. Refusé comme
 * cible de `write`/`rename`/`copy`/`mkdir`/upload/fetch et comme source de `delete`/`rename`.
 */
export function isReservedPath(relative: string): boolean {
  return isTrashPath(relative) || relative.toLowerCase() === MARKER_NAME;
}

/** Noms de périphériques Windows (`CON`, `NUL`, `COM1`…) — refusés sur toutes les plateformes. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class Jail {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Chemin absolu (sans vérification d'existence). */
  resolve(relative: string): string {
    const rel = normalizeRelative(relative);
    return rel === '' ? this.root : path.join(this.root, ...rel.split('/'));
  }

  /**
   * Chemin absolu vérifié : le chemin réel (liens résolus) de l'entrée — ou de son parent existant
   * le plus proche — doit rester sous la racine réelle.
   */
  async resolveChecked(relative: string): Promise<string> {
    const abs = this.resolve(relative);
    const rootReal = await realpath(this.root);
    let probe = abs;
    let real: string | undefined;
    for (;;) {
      try {
        real = await realpath(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    if (real === undefined) return abs;
    const rel = path.relative(rootReal, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'path escapes the server directory', {
        details: { path: relative },
      });
    }
    return abs;
  }
}
