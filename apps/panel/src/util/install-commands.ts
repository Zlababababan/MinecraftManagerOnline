/**
 * LA règle « quelle adresse du panel proposer dans une commande d'installation », la même pour la
 * commande générique (Réglages → Distribution) et pour celle d'un code d'appairage.
 *
 * Retour de Yassin (02/10) : déconnecté de Tailscale, le panel ne lui proposait que l'adresse
 * `…ts.net` enregistrée à l'installation — injoignable. Deux adresses comptent :
 * - `saved` : l'adresse enregistrée (celle de la machine si elle en a une, sinon l'URL publique) ;
 *   c'est la commande principale, parce qu'une machine distante ne joint le panel que par elle ;
 * - `current` : l'adresse par laquelle la personne consulte le panel EN CE MOMENT ; si elle
 *   diffère, on propose aussi la commande qui passe par elle (`installHere`) — c'est celle qui
 *   marche à coup sûr depuis la machine où l'on est.
 *
 * Le script servi garde l'adresse enregistrée en dur : la commande « ici » la remplace donc
 * explicitement (`-Panel` / `--panel`).
 */
export interface InstallCommands {
  url: string;
  windows: string;
  unix: string;
}

export function installCommands(
  url: string,
  options: { pairCode?: string | undefined; explicit?: boolean } = {},
): InstallCommands {
  const win = [
    ...(options.explicit === true ? [`-Panel ${url}`] : []),
    ...(options.pairCode === undefined ? [] : [`-PairCode ${options.pairCode}`]),
  ];
  const unix = [
    ...(options.explicit === true ? [`--panel ${url}`] : []),
    ...(options.pairCode === undefined ? [] : [`--pair-code ${options.pairCode}`]),
  ];
  return {
    url,
    windows: [`& ([scriptblock]::Create((irm ${url}/install.ps1)))`, ...win].join(' '),
    unix:
      unix.length === 0
        ? `curl -fsSL ${url}/install.sh | sh`
        : `curl -fsSL ${url}/install.sh | sh -s -- ${unix.join(' ')}`,
  };
}

export function installChoices(input: {
  saved: string | undefined;
  current: string | undefined;
  pairCode?: string | undefined;
}): { install?: InstallCommands; installHere?: InstallCommands } {
  const { saved, current, pairCode } = input;
  if (saved === undefined) {
    // Rien d'enregistré : l'adresse consultée est la seule connue (le script la reprend tout seul).
    return current === undefined ? {} : { install: installCommands(current, { pairCode }) };
  }
  return {
    install: installCommands(saved, { pairCode }),
    ...(current !== undefined && current !== saved
      ? { installHere: installCommands(current, { pairCode, explicit: true }) }
      : {}),
  };
}
