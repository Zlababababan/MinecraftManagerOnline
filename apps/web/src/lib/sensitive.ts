/**
 * Données sensibles floutées par défaut (demande de Yassin, 02/10) : une IP ou l'adresse d'un
 * serveur part vite dans une capture d'écran partagée sans y penser. Le flou est un réglage de CE
 * navigateur (pas du compte) : « tout afficher » se choisit dans l'en-tête et se retient ici.
 *
 * Ce n'est pas une protection : la donnée est dans la page, un clic la révèle. C'est un garde-fou
 * contre le partage involontaire, rien de plus.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'mmo.revealSensitive';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let revealAll = read();

export function revealSensitive(): boolean {
  return revealAll;
}

export function setRevealSensitive(value: boolean): void {
  revealAll = value;
  try {
    if (value) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Navigation privée : le choix vaut pour la page ouverte.
  }
  for (const listener of listeners) listener();
}

/** `true` = tout est affiché en clair dans ce navigateur. */
export function useRevealSensitive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revealSensitive,
    () => false,
  );
}

/**
 * Coupe une phrase traduite autour de la donnée sensible qu'elle contient, pour ne flouter que
 * celle-ci : `splitAround((v) => t('…readyAt', { address: v }))` rend `[avant, après]`.
 */
export function splitAround(render: (placeholder: string) => string): [string, string] {
  const mark = '\u0001';
  const [before = '', after = ''] = render(mark).split(mark);
  return [before, after];
}
