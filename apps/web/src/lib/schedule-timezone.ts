/**
 * Fuseau de lecture des planifications, côté navigateur.
 *
 * Une heure saisie dans un formulaire (« 4 h 00 ») n'a de sens que rapportée à un fuseau. Celui du
 * navigateur est le réflexe naturel de l'utilisateur — et c'est justement le piège : les
 * planifications sont lues dans le fuseau du PANEL. Quand les deux diffèrent, il faut le dire à
 * l'endroit exact où l'heure se saisit, pas dans une page de réglages que personne n'ouvre.
 */
import { describeTimeZone, localTimeZone, sameOffset } from '@mmo/shared';

export interface TimeZoneNotice {
  /** Fuseau dans lequel les horaires seront lus (celui du panel). */
  zone: string;
  /** `Europe/Paris (+02:00)`, décalage en vigueur maintenant. */
  label: string;
  /** Le navigateur affiche-t-il la même heure ? Sinon, l'écart doit être annoncé. */
  matchesBrowser: boolean;
  /** Fuseau du navigateur, à montrer uniquement quand il diffère. */
  browserZone: string;
  browserLabel: string;
}

/**
 * `undefined` tant que le fuseau du panel est inconnu (réponse pas encore arrivée, ou panel N-1
 * qui ne l'expose pas) : mieux vaut ne rien annoncer qu'annoncer le mauvais fuseau.
 */
export function timeZoneNotice(
  panelZone: string | undefined,
  now: number = Date.now(),
): TimeZoneNotice | undefined {
  if (panelZone === undefined || panelZone === '') return undefined;
  const browserZone = localTimeZone();
  return {
    zone: panelZone,
    label: describeTimeZone(panelZone, now),
    // Ce qui compte est l'heure affichée, pas le nom : Europe/Paris et Europe/Madrid s'accordent.
    matchesBrowser: sameOffset(panelZone, browserZone, now),
    browserZone,
    browserLabel: describeTimeZone(browserZone, now),
  };
}
