/**
 * Racines interdites (phase 12, doc 03 §6) : le dossier d'état de l'agent (secret, état) et le
 * dossier d'installation (launcher, bundles, runtime) ne doivent jamais devenir la racine d'un
 * jail `fs.*` ni une destination de sauvegarde — même sur ordre du panel (compromis ou forgé).
 * `overlaps` : le chemin est égal à, contenu dans **ou contient** une racine (un jail ancêtre
 * atteindrait la racine) ; `inside` : égal ou contenu seulement (scan, répertoires surveillés).
 */
import path from 'node:path';

import { ProtocolError } from '@mmo/protocol';

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class ForbiddenRoots {
  private readonly roots: string[];

  constructor(roots: readonly (string | undefined)[]) {
    this.roots = roots.filter((r): r is string => r !== undefined && r !== '').map(normalize);
  }

  inside(p: string): boolean {
    const n = normalize(p);
    return this.roots.some((r) => isWithin(n, r));
  }

  overlaps(p: string): boolean {
    const n = normalize(p);
    return this.roots.some((r) => isWithin(n, r) || isWithin(r, n));
  }

  /** `strict` = `overlaps` (racine de jail, destination de backup), sinon `inside`. */
  assert(p: string, what: string, strict = true): void {
    if (strict ? this.overlaps(p) : this.inside(p)) {
      throw new ProtocolError(
        'E_INVALID_PAYLOAD',
        `${what} must not be (or contain) the agent state/installation directory`,
        { details: { path: p } },
      );
    }
  }
}
