/**
 * Traduction des refus du système de fichiers en erreurs de protocole ACTIONNABLES.
 *
 * Vécu réel (2026-08-30, VM Linux ARM) : l'agent installé en service système tourne sous le compte
 * `mmo`, alors que les serveurs vivaient dans le dossier personnel de l'utilisateur. L'écriture de
 * `server.properties` pour provisionner RCON échouait en `EACCES` ; une erreur JS ordinaire, donc
 * emballée en `E_INTERNAL` par le RPC puis effacée par le panel. L'écran affichait « Start internal
 * error » sans plus, alors que le message d'origine nommait le fichier exact.
 *
 * Un refus de droits n'a rien d'interne : c'est une condition d'exploitation ordinaire, qui doit
 * dire QUOI a échoué, SOUS QUEL COMPTE, et CE QU'IL FAUT FAIRE. Le `details.reason` porte le code
 * système (`EACCES`…) : l'UI le traduit via la clé `errors:E_IO_EACCES` (doc 05 §2).
 */
import { access, constants } from 'node:fs/promises';

import { ProtocolError } from '@mmo/protocol';

interface SystemError {
  code?: unknown;
  syscall?: unknown;
  path?: unknown;
}

/** Codes système traduits ; les autres restent des erreurs d'E/S ordinaires. */
const TRANSLATED = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR']);

/** Compte sous lequel tourne l'agent, tel qu'il s'écrira dans un `chown`. */
export function runningAs(): string {
  const name = process.env.USER ?? process.env.USERNAME;
  if (name !== undefined && name !== '') return name;
  // Service systemd sans variables d'environnement : l'uid reste exploitable pour un `chown`.
  return process.getuid === undefined ? 'unknown' : `uid ${String(process.getuid())}`;
}

function systemCode(error: unknown): string | undefined {
  const code = (error as SystemError | null)?.code;
  return typeof code === 'string' && TRANSLATED.has(code) ? code : undefined;
}

/** Refus reconnu, décrit en clair : la cause, ce qui a été refusé, et sous quel compte. */
export interface FsRefusal {
  /** Code système (`EACCES`…), qui sert de `details.reason` et choisit la variante i18n. */
  reason: string;
  path: string;
  user: string;
  syscall: string | undefined;
}

/** Décrit un refus système connu, `undefined` si l'erreur n'en est pas un. */
export function describeFsRefusal(error: unknown, fallbackPath?: string): FsRefusal | undefined {
  const reason = systemCode(error);
  if (reason === undefined) return undefined;
  const raw = (error as SystemError).path;
  const syscall = (error as SystemError).syscall;
  return {
    reason,
    path: typeof raw === 'string' ? raw : (fallbackPath ?? ''),
    user: runningAs(),
    syscall: typeof syscall === 'string' ? syscall : undefined,
  };
}

/**
 * Rend une `ProtocolError` parlante pour un refus système connu, `undefined` sinon — l'appelant
 * relaie alors l'erreur d'origine plutôt que de la travestir.
 */
export function fsProtocolError(error: unknown, fallbackPath?: string): ProtocolError | undefined {
  const refusal = describeFsRefusal(error, fallbackPath);
  if (refusal === undefined) return undefined;
  const { reason, path, user, syscall } = refusal;
  return new ProtocolError(
    'E_IO',
    `${reason}: ${path || 'path unavailable'} (running as ${user})`,
    {
      // Non réessayable : réessayer un refus de droits produit exactement le même refus.
      retryable: false,
      details: { reason, path, user, ...(syscall === undefined ? {} : { syscall }) },
    },
  );
}

/** Exécute une opération de fichiers en traduisant les refus connus. */
export async function withFsErrors<T>(fallbackPath: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw fsProtocolError(error, fallbackPath) ?? error;
  }
}

/**
 * Vérifie qu'un dossier de serveur est traversable ET inscriptible, POSIX uniquement.
 *
 * Pas sous Windows : `fs.access(dir, W_OK)` s'y résume à l'attribut « lecture seule », que
 * l'explorateur pose sur quantité de dossiers parfaitement inscriptibles — le test y produirait
 * des faux refus. Le piège visé est de toute façon celui du compte de service POSIX, et la
 * traduction des erreurs ci-dessus reste le filet sur les deux plateformes.
 *
 * La plateforme RÉELLE décide, pas l'`os` déclaré de l'agent : c'est la sémantique de `access`
 * sur l'hôte qui est en jeu.
 */
export async function assertServerDirWritable(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await access(dir, constants.W_OK | constants.X_OK);
  } catch (error) {
    const translated = fsProtocolError(error, dir);
    if (translated) throw translated;
    // Dossier absent ou illisible : ce n'est pas un problème de droits, on laisse remonter.
    throw error;
  }
}
