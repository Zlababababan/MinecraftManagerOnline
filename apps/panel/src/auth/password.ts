/** Mots de passe : argon2id (`@node-rs/argon2`, natif — autorisé côté panel uniquement). */
import { hash, verify } from '@node-rs/argon2';

/** Paramètres OWASP (2023) : m = 19 MiB, t = 2, p = 1. */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Hachage factice, calculé une fois, contre lequel vérifier le mot de passe d'un utilisateur
 * inconnu ou désactivé : sans cela, l'authentification rend la main immédiatement dans ces cas et
 * après ~50 ms d'argon2 pour un compte existant — l'écart suffit à énumérer les comptes.
 */
let dummyHash: Promise<string> | undefined;

export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('mmo-nonexistent-account-placeholder');
  return dummyHash;
}
