/**
 * Contre-pression WebSocket (lot 9). Un socket dont le pair ne lit plus accumule en mémoire tout
 * ce qu'on lui envoie : `bufferedAmount` grimpe sans borne, et un navigateur endormi ou un lien
 * saturé finissait par coûter au panel des dizaines de Mio par client — l'envoi n'inspectait
 * jamais cette valeur alors que les deux transports l'exposent.
 *
 * Politique en deux paliers, la même côté panel (vers les navigateurs) et côté agent (vers le
 * panel) : au-delà du premier seuil, les messages **de faible valeur** — échantillons de
 * métriques, lignes de console, qui seront de toute façon remplacés par les suivants — sont
 * abandonnés ; au-delà du second, le socket est fermé proprement et le pair se reconnecte (le
 * front et l'agent savent déjà le faire). Les messages de valeur (états, événements, réponses)
 * passent toujours : les perdre coûterait plus qu'une fermeture.
 */
export const BACKPRESSURE = {
  /** Au-delà : les messages de faible valeur sont abandonnés. */
  dropAboveBytes: 1024 * 1024,
  /** Au-delà : fermeture (code 1013 « try again later »), le pair se reconnecte. */
  closeAboveBytes: 8 * 1024 * 1024,
} as const;

export type BackpressureAction = 'send' | 'drop' | 'close';

export function backpressureAction(
  bufferedAmount: number,
  lowValue: boolean,
  thresholds: { dropAboveBytes: number; closeAboveBytes: number } = BACKPRESSURE,
): BackpressureAction {
  if (bufferedAmount > thresholds.closeAboveBytes) return 'close';
  if (lowValue && bufferedAmount > thresholds.dropAboveBytes) return 'drop';
  return 'send';
}
