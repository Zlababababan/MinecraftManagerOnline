# Contribuer à MinecraftManagerOnline

[English](CONTRIBUTING.md) · **Français**

Conventions du projet, actées en phase 1 (doc 07). La référence de conception reste `docs/` : ce fichier ne fait que fixer les règles de travail.

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
