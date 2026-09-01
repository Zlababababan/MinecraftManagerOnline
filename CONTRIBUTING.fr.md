# Contribuer à MinecraftManagerOnline

[English](CONTRIBUTING.md) · **Français**

Conventions du projet, actées en phase 1 (doc 07). La référence de conception reste `docs/` : ce fichier ne fait que fixer les règles de travail. Pour une carte du code en anglais, commencer par [ARCHITECTURE.md](ARCHITECTURE.md).

## Prérequis

- **Node.js 24 LTS** (version épinglée dans `.node-version` ; plancher absolu 22.12). Un gestionnaire de versions (`fnm`, `nvm`, `pnpm env`) lit `.node-version`.
- **pnpm 11** (version épinglée dans `package.json › packageManager` ; `corepack enable` ou installation globale).
- Java n'est nécessaire que pour les tests manuels contre de vrais serveurs — la CI n'en a pas besoin (fake Java server, doc 03 §9).

## Commandes

```bash
pnpm install            # installe tout le workspace
pnpm build              # build de tous les packages (Turborepo, ordre des dépendances respecté)
pnpm typecheck          # tsc --noEmit partout
pnpm lint               # ESLint partout
pnpm test               # Vitest partout
pnpm check              # build + typecheck + lint + test
pnpm format             # Prettier --write ; `pnpm format:check` en CI
```

Une commande ciblée : `pnpm --filter @mmo/panel test`, `pnpm --filter @mmo/web dev`.

Développement du front : `pnpm --filter @mmo/panel dev` (API sur 127.0.0.1:3000) puis `pnpm --filter @mmo/web dev` (Vite sur 5173, proxy `/api` et `/ws`). En production le panel sert `apps/web/dist` (`pnpm build`). E2E : `pnpm --filter @mmo/web e2e` (Playwright, Chromium via `pnpm --filter @mmo/web exec playwright install chromium` la première fois ; construit le front, lance panel + agent réels + fake Java server). Le scénario `whitelist.spec.ts` (phase 6) lit les fichiers du serveur e2e sur disque : ne pas le lancer en parallèle d’un autre run. Le scénario `backups.spec.ts` (phase 8) crée puis supprime des archives dans le dossier d'état temporaire de l'agent e2e. Le test d'intégration `phase9.test.ts` (panel + deux agents) redirige les appels sortants du panel (API Temurin/Zulu) vers un faux fournisseur local : aucun accès Internet requis. Les tests de la phase 10 (`access.test.ts`) ouvrent un listener HTTPS sur 127.0.0.1 avec une CA de test et un reverse-proxy local : aucun accès Internet, aucun appel à DuckDNS/Cloudflare/Let's Encrypt (tout est simulé via le `fetch` injecté). Les tests de l'agent lancent un sidecar PowerShell et un processus « burner » sous Windows (`monitoring/sampler.test.ts`) : `pnpm check` peut être bruyant en CPU pendant ~20 s.

## Structure

```
apps/panel      Fastify 5, ws, Drizzle, web-push ; sert le front buildé + les artefacts agent
apps/web        React 19 + Vite PWA (Mantine, TanStack, xterm)
apps/agent      bundle esbuild universel (CJS) + launcher — AUCUN module natif
packages/protocol   schémas Zod du protocole + client/serveur RPC typés
packages/shared     i18n fr/en, mapping MC→Java, parsing de logs, heuristiques de détection
packages/config     tsconfig / ESLint / Prettier partagés
docs/               conception (source de vérité) + docs/spikes/ (notes de validation)
```

Tous les packages sont ESM (`"type": "module"`), TypeScript **strict** (`@mmo/config/tsconfig.base.json` : `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`…). Les imports internes portent l'extension `.js`.

## Règles non négociables (vérifiées par l'outillage quand c'est possible)

| Règle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Où                                            | Vérification                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Aucun module natif dans l'agent** (bundle universel, même artefact pour tous les OS/arch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `apps/agent`                                  | ESLint `no-restricted-imports` + test `main.test.ts` qui scanne `dist/agent.js` (`.node`, `process.dlopen`, `bindings`, `node-gyp-build`) |
| **Jamais `.strict()` sur un schéma du protocole** — le protocole évolue par ajout, un pair N/N-1 ignore les champs inconnus                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/protocol`                           | ESLint `no-restricted-syntax`                                                                                                             |
| **Le protocole n'évolue que par ajout** (champs optionnels, nouveaux types) ; toute rupture = bump de `PROTOCOL_VERSION` + support N-1 côté panel                                                                                                                                                                                                                                                                                                                                                                                                                                | `packages/protocol`                           | revue + tests de contrat (phase 2)                                                                                                        |
| **i18n dès la première chaîne** : aucun texte visible en dur dans le front ni dans les push ; les erreurs sont des **codes**, l'UI traduit                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/web`, `apps/panel`, `packages/shared`   | revue ; `no-console` en erreur dans `apps/web`                                                                                            |
| **Une migration mergée ne se modifie jamais** : on en ajoute une nouvelle (Drizzle, SQL commité)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/panel`                                  | revue ; tests « migrations rejouées from scratch » (phase 4)                                                                              |
| **Timestamps = epoch en millisecondes**, partout (DB, protocole, API)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | partout                                       | schémas Zod                                                                                                                               |
| **Jamais `ZSTD_c_nbWorkers`** (perte silencieuse de données, spike n°3) ; l'intégrité d'une archive ou d'un transfert repose sur **sha256 + taille**, jamais sur le codec                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/agent`, `packages/shared`, `apps/panel` | ESLint `no-restricted-syntax` (phase 8) ; tests backups (archive altérée refusée)                                                         |
| **Versions épinglées** (`save-exact`), aucune dépendance publiée depuis < 3 jours (`minimumReleaseAge` pnpm), scripts postinstall sur liste blanche (`allowBuilds`)                                                                                                                                                                                                                                                                                                                                                                                                              | `pnpm-workspace.yaml`, `.npmrc`               | pnpm                                                                                                                                      |
| Le panel est l'autorité des identifiants serveurs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/panel`                                  | doc 04                                                                                                                                    |
| **Le launcher de l'agent est figé** (`apps/agent/launcher/launcher.cjs` : CommonJS, zéro dépendance, jamais réseau, jamais mis à jour par `agent.update`) ; **la clé privée de signature ne vit jamais sur le panel** (`tools/signing/` ; la clé de développement commitée est remplacée par une clé de release hors dépôt en phase 11)                                                                                                                                                                                                                                          | `apps/agent`, `tools/signing`                 | revue ; `launcher.test.ts` (rollback avec bundle cassé) ; `updater.test.ts` (signature invalide refusée)                                  |
| **Zéro API Tailscale dans le code** (doc 03 §5) : le mode `tailscale` se limite à afficher `tailscale serve` et à lire passivement les en-têtes `Tailscale-User-*` ; **le panel n'écoute jamais sur `::`/`0.0.0.0`**, y compris le listener HTTPS du mode `direct` (adresse explicite) ; **Web Push et ACME sont maison** (`services/push/webpush.ts`, `services/access/acme.ts`) — toute modification se vérifie contre le vecteur RFC 8291 et le faux serveur ACME (`test/acme-fake.ts`), jamais contre la production Let's Encrypt (staging sélectionnable dans les réglages) | `apps/panel`                                  | revue ; `webpush.test.ts`, `acme.test.ts`, `access.test.ts`                                                                               |

## Phases et documentation

- **Une phase = code + tests + docs amendés + commit(s)** (doc 07, règle 1). Les tests accompagnent le code, jamais « plus tard ».
- Toute **dérogation** aux docs 03–06 est actée dans le doc concerné au moment où elle se décide (section dédiée ou note datée), et résumée dans `CLAUDE.md › État › Dérogations`.
- Les fonctionnalités « Futur » du doc 02 ne sont pas développées en 1.0, mais chaque phase vérifie qu'elle ne les bloque pas.

## Commits

- **En français**, au présent ou à l'infinitif, format `Sujet : description` — le sujet est la zone touchée (`Panel`, `Agent`, `Web`, `Protocol`, `Shared`, `CI`, `Docs`, `Spikes`, `Monorepo`…).
  Exemples : `Protocol : schémas du jalon A (enveloppe, erreurs, console)`, `Agent : ré-adoption des serveurs après redémarrage`.
- Un commit = une intention. Les commits de phase restent cohérents (build et tests verts à chaque commit).
- Identité git : celle configurée localement sur le dépôt (`MinecraftManagerOnline` / adresse noreply). Aucune identité personnelle.

## Tests

| Niveau            | Outil                                         | Note                                                                                                                                         |
| ----------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitaires         | Vitest (`*.test.ts` à côté du code)           | fixtures copiées de vrais dossiers pour la détection/parsing                                                                                 |
| Intégration panel | Vitest + `fastify.inject` + SQLite temporaire |                                                                                                                                              |
| Intégration agent | « fake Java server » (script Node)            | pas de Java en CI ; phase 9 : deux agents in-process pour la migration, faux JRE (`major=N` + sonde injectée), launcher avec de faux bundles |
| E2E               | Playwright (à partir de la phase 5)           | mobile + desktop, fr + en                                                                                                                    |

La CI (`.github/workflows/ci.yml`) exécute format, build, typecheck, lint et tests sur **windows / ubuntu / ubuntu-arm / macos**. Une phase n'est terminée que si elle est verte sur les quatre.

## Spikes

Les notes de validation vivent dans `docs/spikes/` (une note par spike, scripts reproductibles dans `docs/spikes/scripts/`, hors workspace pnpm). Elles font autorité sur les points qu'elles tranchent et sont référencées depuis les docs 03–06.

## Écarté volontairement

Ces idées reviennent régulièrement, et elles sont toutes raisonnables. Elles sont refusées ici
délibérément, avec leur raison — un refus écrit d'avance est une politique, pas une réponse
personnelle à votre pull request. Si vous n'êtes pas d'accord, ouvrez une issue et défendez le
dossier ; ce qui n'arrivera pas, c'est qu'une grosse branche atterrisse sans prévenir.

**Stockage et runtime**

- _`node-sqlite3-wasm` en filet de sécurité_ — mesuré : `PRAGMA journal_mode = WAL` reste
  silencieusement à `delete`, pas de mode tableau, pas de transaction, des erreurs sans code. Un
  troisième chemin de code précisément là où le support est le plus difficile.
- _Attendre un driver `node:sqlite` officiel dans Drizzle_ — la version publiée n'en a pas. Attendre
  l'amont n'est pas une stratégie ; vingt-cinq lignes de session écrites à la main, si.
- _Cibles musl dans les plateformes de build_ — Node ne publie pas de binaire musl officiel. Une
  fois les modules natifs partis, Alpine est servi par l'image Docker ou par le Node de la
  distribution.

**Distribution**

- _Auto-mise à jour du panel façon launcher d'agent_ — un chantier XL pour restructurer l'archive,
  plus une surface de panne au démarrage, pour un panel qu'une seule commande met à jour trois fois
  par an.
- _Paquets `.deb`, Homebrew, winget_ — trois canaux à re-tester à chaque release, pour un besoin que
  l'installeur en une commande et Docker couvrent déjà.
- _Spécification OpenAPI publiée_ — le contrat déclare justement `/api` hors périmètre de
  compatibilité. La publier figerait une surface qu'on veut garder libre.
- _SBOM CycloneDX_ — valeur proche de zéro pour le public visé. Une heure le jour où une
  organisation évalue vraiment le projet, pas avant.

**Sauvegardes et intégrations**

- _Destinations S3 / Backblaze_ — environ 200 lignes de SigV4 à maintenir pour un besoin que la
  réplication vers une autre machine du tailnet couvre déjà, gratuitement.
- _SFTP_ — aucune pile SSH acceptable sans dépendance lourde. L'échappatoire honnête est une
  commande post-sauvegarde optionnelle passée en argv, jamais par un shell, pour ceux qui ont déjà
  `rclone` ou `restic`.
- _Bot Discord bidirectionnel_ — il dépend entièrement des permissions par serveur pour être sûr, et
  ajoute une connexion permanente à maintenir. Les webhooks sortants couvrent 80 % de la valeur pour
  20 % du coût.
- _Notifications e-mail SMTP_ — écrire un client SMTP qui tolère les serveurs réels est un puits sans
  fond, alors que le push fonctionne, chiffré et localisé.

**Projet et communauté**

- _Instance de démo publique, ou mode lecture seule_ — un serveur à exploiter et à défendre, pour un
  projet dont toute la promesse est l'auto-hébergement. Un GIF de 15 s et un `docker compose up`
  donnent 90 % de la valeur.
- _Site de documentation généré_ — GitHub rend correctement les 21 pages telles quelles. Une
  demi-journée le jour où la demande se présente.
- _Traduire l'application en cinq langues_ — les docs traduites ont divergé en cinq jours, sans un
  seul contributeur extérieur. Le signal à attendre est qu'un locuteur natif contribue au moins une
  fois ; il n'est pas venu.
- _Weblate / Crowdin_ — une intégration de plus à maintenir, pour zéro traducteur bénévole.
- _Réécrire l'historique git_ — casse tous les clones et toutes les références de commits sans rien
  réparer : ce qui est dans l'historique reste dans les forks et les caches.

**Périmètre produit**

- _Écrire un moteur de carte du monde_ — BlueMap le fait déjà pour tous les loaders visés. Le seul
  chantier légitime est un bouton « Installer la carte » plus un mandataire pour que la carte hérite
  de l'authentification du panel.
- _Mise à jour automatique d'un modpack_ — la fusion des configurations utilisateur casse
  silencieusement des mondes. Chantier distinct, à ne pas greffer sur l'installation.
- _Fédération multi-panel, marketplace, système de plugins_ — rien de tout cela n'aide quelqu'un qui
  héberge pour ses amis, et chacun est une maintenance à vie.
- _Wake-on-LAN_ — le paquet magique exige qu'une autre machine du même sous-réseau ait un agent en
  ligne. Dans le cas d'usage réel, il n'y a généralement personne pour l'envoyer.

**Outillage**

- _Seuil de couverture bloquant en CI_ — surtout du bruit sur les fichiers de plomberie. Publier le
  rapport en artefact est la partie utile.
- _Ajouter les codes du `doctor` aux codes d'erreur du protocole_ — ce sont des enums fermés qui
  traversent le protocole ; les élargir pour des codes qui ne passent jamais sur le fil casserait le
  parse chez un pair N-1 pour rien.
