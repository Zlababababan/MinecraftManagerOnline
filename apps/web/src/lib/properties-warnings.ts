/**
 * Les pièges de `server.properties`, signalés AU MOMENT où on tombe dedans (retour de Yassin,
 * 02/10, sur l'avertissement des deux ports : « si on savait où en mettre d'autres du même style,
 * ça serait bien »). Chaque règle est un réglage qui ne fait pas ce que son nom laisse croire, ou
 * dont l'effet se paie plus tard, ailleurs, sans message.
 *
 * Un avertissement n'apparaît que si la personne vient de MODIFIER le réglage en cause (il est dans
 * le patch) : un serveur déjà réglé ainsi ne porte pas de bandeau permanent. Rien n'est bloqué.
 */
export interface PropertyWarning {
  id:
    | 'queryPortOnly'
    | 'portTaken'
    | 'onlineModeOff'
    | 'serverIp'
    | 'levelName'
    | 'levelSeed'
    | 'gamemode';
  /** Le champ où se trouve le remède : un bouton y mène et le met en avant. */
  focus?: string;
  params?: Record<string, string>;
}

export interface WarningContext {
  /** Port de jeu → nom, pour les AUTRES serveurs de la même machine. */
  otherPorts: ReadonlyMap<number, string>;
}

export function propertyWarnings(
  original: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
  patch: Readonly<Record<string, unknown>>,
  context: WarningContext,
): PropertyWarning[] {
  const changed = (key: string): boolean => key in patch;
  const out: PropertyWarning[] = [];

  // Deux lignes « port » : seule `server-port` compte pour rejoindre.
  if (changed('query.port') && !changed('server-port')) {
    out.push({ id: 'queryPortOnly', focus: 'server-port' });
  }
  // Port déjà pris par un autre serveur de la machine : le second refusera de démarrer.
  const port = Number(current['server-port']);
  const owner = context.otherPorts.get(port);
  if (changed('server-port') && owner !== undefined) {
    out.push({ id: 'portTaken', params: { port: String(port), name: owner } });
  }
  // Mode hors ligne : n'importe qui entre sous n'importe quel pseudo, opérateurs compris.
  if (changed('online-mode') && current['online-mode'] === 'false') {
    out.push({ id: 'onlineModeOff' });
  }
  // Adresse d'écoute renseignée : le serveur n'écoute plus que sur elle (souvent : plus du tout).
  if (changed('server-ip') && (current['server-ip'] ?? '') !== '') {
    out.push({ id: 'serverIp' });
  }
  // Nom du monde changé sur un serveur qui en a déjà un : un monde NEUF est créé au démarrage.
  if (changed('level-name') && (original['level-name'] ?? '') !== '') {
    out.push({ id: 'levelName', params: { name: original['level-name'] ?? '' } });
  }
  // La graine ne sert qu'à la création du monde.
  if (changed('level-seed')) out.push({ id: 'levelSeed' });
  // Le mode de jeu par défaut ne touche pas les joueurs déjà venus, sauf « forcer ».
  if (changed('gamemode') && current['force-gamemode'] !== 'true') {
    out.push({ id: 'gamemode', focus: 'force-gamemode' });
  }
  return out;
}
