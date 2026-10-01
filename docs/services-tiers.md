# Services tiers

Tout ce à quoi MinecraftManagerOnline parle en dehors de chez vous, comment il s'y prend pour ne
jamais abuser de ces services, et comment retirer l'intégration FTB en entier.

La liste de référence est dans le code : `packages/shared/src/third-party.ts`
(`THIRD_PARTY_SERVICES`). L'interface la montre aux administrateurs dans **Réglages → Services
tiers** (nom, adresses, usage).

## 1. Les services

| Id            | Hôtes                                                                   | Qui l'appelle                     | Pour quoi                                                         |
| ------------- | ----------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `ftb`         | `api.feed-the-beast.com`, `files.feed-the-beast.com`                    | panel (API), agent (fichiers)     | catalogue et fichiers des modpacks FTB — **retirable** (§4)       |
| `curseforge`  | `edge.forgecdn.net`                                                     | agent                             | fichiers de mods d'un pack FTB hébergés chez CurseForge           |
| `mojang`      | `piston-meta.mojang.com`, `piston-data.mojang.com`, `api.minecraftservices.com` | panel (versions), agent (jar, profils) | versions de jeu, jar serveur, pseudo → UUID (`privacy.mojangLookup`) |
| `mcHeads`     | `mc-heads.net`                                                          | navigateur                        | têtes des joueurs (`privacy.externalAvatars`)                     |
| `fabric`      | `meta.fabricmc.net`                                                     | panel, agent                      | versions et lanceur Fabric                                        |
| `forge`       | `maven.minecraftforge.net`, `files.minecraftforge.net`                  | panel, agent                      | versions et installeur Forge                                      |
| `neoforge`    | `maven.neoforged.net`                                                   | panel, agent                      | versions et installeur NeoForge                                   |
| `adoptium`    | `api.adoptium.net`                                                      | panel                             | Java (Temurin)                                                    |
| `azul`        | `api.azul.com`                                                          | panel                             | Java (Zulu), en repli                                             |
| `spark`       | `sparkapi.lucko.me`, `spark.lucko.me`                                   | panel, agent                      | spark en un clic                                                  |
| `letsEncrypt` | `acme-v02.api.letsencrypt.org`                                          | panel                             | certificat du mode d'accès direct                                 |

Hors liste parce qu'ils ne sont pas « tiers » au même sens : GitHub (`releases.atom`, vérification
de mise à jour du panel, une fois par jour au plus, réglage `panel.updateCheck.enabled`), les
services de notification push des navigateurs et les webhooks (adresses choisies par
l'administrateur).

## 2. Ne jamais spammer un service

Un outil qui martèle une API se fait bloquer, et le blocage frappe **tous** ses utilisateurs à la
fois ; ces services sont souvent gratuits et tenus par de petites équipes. D'où, dès la première
version de chaque appel :

- **Un seul point de sortie côté panel** : `apps/panel/src/util/polite-fetch.ts`
  (`PoliteFetcher`), partagé par tout le panel. Les catalogues Mojang, Fabric, Forge, NeoForge, FTB
  et spark y passent. Aucun navigateur ne contacte ces API : il interroge le panel.
- **User-Agent identifiable** : `MinecraftManagerOnline/<version> (+https://github.com/Zlababababan/MinecraftManagerOnline)`
  pour le panel (y compris les appels Java et GitHub, qui n'utilisent que l'en-tête) ;
  `MinecraftManagerOnline-agent (+…)` pour l'agent (profils Mojang, tout téléchargement).
- **Concurrence bornée par hôte** : 3 requêtes à la fois au plus. Une recherche FTB qui veut vingt
  fiches les obtient trois par trois.
- **Requêtes identiques partagées** : dix onglets qui ouvrent la même liste font un seul appel.
- **Cache** chez chaque appelant : listes de versions 1 h, détail d'une version publiée gardé pour
  toujours (il ne change plus), fiches FTB 1 h, listes de fichiers FTB (plusieurs Mio) : les 4
  dernières. Un pack FTB introuvable ou illisible n'est pas redemandé pendant l'heure qui suit.
- **`429` et `503` respectés, sans relance automatique** (demande de Yassin, 01/10/2026 : « évite
  les relances ») : l'hôte est mis au repos pour la durée demandée par `Retry-After` (1 min au
  moins), et l'interface le dit (« le catalogue demande de ralentir… réessayez dans quelques
  minutes »). Le navigateur ne relance pas non plus les requêtes de catalogue.
- **Cache négatif** : un hôte en panne (réseau, 5xx) n'est plus sollicité pendant 1 min, doublée à
  chaque panne consécutive (plafond 15 min), remise à zéro au premier succès. Pendant ce temps, un
  clic reçoit `E_UNREACHABLE` avec `details.retryInMs` sans que rien ne sorte.
- **CurseForge en dernier recours** (décision de Yassin, 01/10/2026) : pour un fichier de pack FTB
  publié chez CurseForge, la copie hébergée par FTB est demandée d'abord ; `edge.forgecdn.net`
  n'est contacté que si elle manque ou échoue (sur FTB Evolution : 27 fichiers sur 7 124 n'ont pas
  de copie FTB). Le panel, lui, ne parle jamais à CurseForge.
- **Jamais une requête par frappe** : la recherche FTB de l'assistant part au bouton.
- **Agent** : la résolution de profils Mojang s'arrête au premier `429`, `5xx` ou échec réseau au
  lieu d'enchaîner les lots suivants ; le téléchargement des fichiers d'un modpack est borné par
  l'étape `fetchMany` (6 à la fois par défaut, 16 au plus), **une seule tentative par source**
  (l'adresse principale, puis son miroir) ; le jar d'un serveur ou d'un installeur a droit à une
  reprise après coupure, pas davantage.
- **Un échec se lit à l'écran** : la tâche d'installation nomme le fichier et le service
  (« Le téléchargement de mods/x.jar depuis edge.forgecdn.net a échoué… ») et dit quoi faire ;
  « Reprendre l'installation » garde les fichiers déjà bons. C'est une personne qui décide de
  réessayer, jamais une boucle.

**Ce qui manque encore** (à reprendre si l'usage le demande) : l'agent n'a pas de borne **par
hôte** pour `fetchMany` (les 6 téléchargements se répartissent entre `files.feed-the-beast.com` et
`edge.forgecdn.net`, sans plafond de débit) ; le cache positif du panel vit en mémoire (un panel
redémarré relit les catalogues) ; aucun service n'expose de quota documenté que l'on pourrait
suivre.

## 3. Conditions d'utilisation

Le produit **n'est pas vendu** : c'est un usage strictement personnel (décision de Yassin,
01/10/2026). Les notes « à vérifier » que l'interface affichait à côté de chaque service — elles
portaient surtout sur l'usage dans un produit vendu — ont été retirées le même jour, avec le champ
`verified`. Ce qui reste dû à ces services, vendu ou non : les règles de politesse du §2.

Si le produit devait un jour être vendu, reprendre la question service par service (conditions
d'utilisation par un outil tiers, droit de télécharger directement, licence de Java, publicité
perdue par Forge…) avant toute chose ; le §5 garde ce qui a déjà été lu.

## 4. Retirer l'intégration FTB en entier

Elle est d'abord **désactivable** sans rien toucher au code : Réglages → Services tiers → « Proposer
les modpacks FTB… » (réglage `modpacks.ftb.enabled`). Coupée, l'assistant n'offre plus l'option,
les routes FTB répondent 404 `FEATURE_DISABLED` et le panel ne contacte plus l'API FTB.

Pour la **retirer** du produit, supprimer ces fichiers :

- `apps/panel/src/services/modpacks/ftb.ts`
- `apps/panel/src/http/routes/modpacks-ftb.ts`
- `packages/shared/src/minecraft/ftb.ts` et `ftb.test.ts`
- `packages/protocol/src/client/ftb.ts`
- `apps/web/src/api/ftb.ts`
- `apps/web/src/components/machine/FtbPackPicker.tsx`

puis enlever leurs branchements (chacun porte le commentaire « retirable en entier ») :

- les **deux lignes de branchement** du panel : `registerFtbRoutes(app, ctx)` dans
  `apps/panel/src/app.ts` et l'entrée `['ftb', ftb]` de `modpacks: new Map(…)` dans
  `apps/panel/src/context.ts` — avec leurs imports, la création `new FtbService(…)` et le champ
  `ftb` de `AppContext` ;
- les exports marqués dans `packages/shared/src/index.ts` et `packages/protocol/src/client/index.ts`,
  et `'ftb'` dans `MODPACK_PROVIDERS` (même fichier) ;
- dans `CreateServerModal.tsx` : l'option « Modpack FTB » et l'état `mode`/`ftbPick` ;
- le réglage `modpacks.ftb.enabled` (`SETTING_KEYS.ftbEnabled`, `EDITABLE_SETTINGS`,
  `/api/auth/me.features.ftb`), l'interrupteur de `ThirdPartyCard` et les entrées `ftb`/`curseforge`
  de `THIRD_PARTY_SERVICES` ;
- les textes `install.ftb.*` et `thirdParty.*ftb*` des traductions web.

Ce qui **reste** et sert à d'autres : l'étape générique `fetchMany` (protocole, agent, capacité
`install-fetch-many`), `ModpackProvider` (`services/modpacks/types.ts`) et le paramètre `modpack` de
la création (un autre fournisseur s'y branche de la même façon), `PoliteFetcher`.

## 5. Journal des vérifications

- **FTB — vérification partielle (2026-10-01).** Source : <https://feed-the-beast.com/blog/p/ftb-api>
  (article du 12 mars 2025, lien fourni par Yassin, lu par résumé automatique). Ce qu'il dit : l'API
  `api.feed-the-beast.com/v1/modpacks/` remplace `api.modpacks.ch` ; les **lanceurs tiers peuvent
  l'utiliser** et FTB s'engage à ne pas leur retirer l'accès ; FTB **demande un User-Agent
  personnalisé** (format libre) pour pouvoir remonter à l'outil en cas de problème ; FTB préfère
  qu'on passe par son application, puis CurseForge, puis les outils tiers. **Respecté** : bonne API,
  User-Agent qui nomme le produit et le dépôt. **Non dit par l'article** : limites de débit, outils
  côté serveur, produits payants, téléchargement direct des fichiers. **Décision (Yassin,
  01/10/2026)** : « Le produit ne sera pas vendu. C'est une utilisation strictement personnelle » et
  « FTB ne donne pas de limite mais on ne va pas exagérer » : usage accepté tel quel. À revoir si
  le produit devait un jour être vendu (documentation annoncée sur docs.feed-the-beast.com ;
  contact : page `/support` de FTB).
