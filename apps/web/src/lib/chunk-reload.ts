/**
 * Après un déploiement du panel, les chunks de l'ancienne version encore ouverte dans le navigateur
 * n'existent plus (hachage dans le nom) : tout chargement paresseux échoue (« Failed to fetch
 * dynamically imported module »). Remède standard : recharger la page — le nouvel index référence
 * les nouveaux fichiers. `vite:preloadError` couvre les préchargements ; la page d'erreur du
 * routeur utilise `isChunkLoadError` + `reloadForNewVersion` pour le reste.
 */

const RELOAD_GUARD_KEY = 'mmo-chunk-reload-at';
const RELOAD_GUARD_MS = 30_000;

/** Échec de chargement d'un module dynamique (libellés selon navigateur). */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (message === undefined) return false;
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(
    message,
  );
}

/** Recharge au plus une fois par fenêtre de 30 s (anti-boucle si le panel est vraiment cassé). */
export function reloadForNewVersion(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
  } catch {
    // stockage indisponible : on recharge quand même (pas de garde possible)
  }
  if (Date.now() - last < RELOAD_GUARD_MS) return false;
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // ignore
  }
  window.location.reload();
  return true;
}

export function installChunkReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}
