# 03 — Socle technique

Décisions validées le 2026-08-21. Ce document est la référence : toute dérogation en cours de développement doit être documentée ici.

## Décisions clés en un coup d'œil

| Sujet | Décision |
|---|---|
| Langage | **TypeScript partout** (panel, agent, front) |
| Runtime | Node.js 24 LTS, épinglé, identique panel/agent |
| Base de données | SQLite (WAL) — `mmo.db` + `metrics.db` séparés |
| Distribution agent | Bundle JS universel (~3 Mo, tous OS/arch) + runtime Node embarqué + micro-launcher |
| Accès distant | Couche d'accès **pluggable** : `tailscale` (défaut) / `direct` (IPv6 + domaine) / `manual` |
| RCON | **Auto-provisionné par défaut** (dépendance architecturale, pas une option) |
| Réseau dans le code | **Aucune API Tailscale** — le réseau est une abstraction |

## 1. Stack

| Couche | Choix | Notes |
|---|---|---|
| Runtime | **Node.js 24 LTS** (plancher : 22) | Même version épinglée panel + agent |
| Langage | TypeScript 5.x, `strict: true`, ESM | |
| API panel | **Fastify 5** + `fastify-type-provider-zod` | Zod = validation runtime + types partagés |
| Temps réel | `ws` via `@fastify/websocket` | 2 endpoints : `/ws/agent` (protocole) et `/ws/client` (front) |
| Auth | Sessions cookie maison + **argon2** (`@node-rs/argon2`), RBAC en hook Fastify | Pas de JWT (même origine, peu d'utilisateurs) |
| Push | `web-push` (VAPID) | |
| Front | **Vite + React 19**, TanStack Router + Query, Zustand (état temps réel) | |
| UI | **Mantine 8** (+ `mantine-datatable`) | AppShell responsive, thème sombre natif, Spotlight |
| Console | `@xterm/xterm` + addons fit/search | |
| Graphiques | Mantine Charts (Recharts) ; **uPlot** en secours pour le temps réel haute fréquence | |
| i18n | i18next + react-i18next, fichiers `fr`/`en` dans `packages/shared` | Le panel localise aussi les push |
| PWA | vite-plugin-pwa (Workbox) | |
| ORM | **Drizzle ORM + drizzle-kit** (migrations SQL commitées), driver `better-sqlite3` | Plan B : `node:sqlite` (Node 26) |
| Monorepo | pnpm workspaces + Turborepo | |
| Bundling agent | esbuild → un seul `agent.js` CJS | **Règle : aucun module natif dans l'agent** |
| Tests | Vitest, Playwright, « fake Java server » | Voir §9 |

> **Implémentation (phase 4, `apps/panel`)** : Fastify 5 + `fastify-type-provider-zod` (schémas Zod = validation + types des routes, erreurs de validation → `E_VALIDATION`), `@fastify/websocket` (`/ws/agent`, `/ws/client`), `@fastify/cookie`, Drizzle + `better-sqlite3` (compilé localement sous Windows si le prebuild manque ; `allowBuilds` dans `pnpm-workspace.yaml`), `@node-rs/argon2` (argon2id, OWASP m = 19 MiB / t = 2 / p = 1). Le **contrat panel ↔ front** (DTO REST, messages de `/ws/client`, codes d'erreur HTTP) vit dans **`@mmo/protocol/client`**, distinct du protocole panel↔agent mais sous les mêmes règles (jamais `.strict()`). Toute erreur HTTP sort en `{ code, message, retryable, details }`, traduite par l'UI. Config par env : `MMO_DATA_DIR` (défaut `./data`), `MMO_HOST` (défaut `127.0.0.1`, `0.0.0.0`/`::` **refusés au démarrage**), `MMO_PORT`, `MMO_COOKIE_SECURE`, `MMO_MOJANG_MANIFEST`, `MMO_LOG_LEVEL`.

### Pourquoi TypeScript partout (et pas un agent Go)

- La logique « intelligente » de l'agent (détection heuristique, parsing de logs, mapping MC→Java, watchdog) doit exister aussi côté panel : en TS elle vit une fois dans `packages/shared`, en Go elle serait dupliquée ou générée.
- Le gain RAM de Go (~30 Mo vs ~50–140 Mo) est sans valeur sur des machines dimensionnées pour des heaps Java de 4–16 Go (Raspberry Pi 4/5 inclus).
- Le modèle de distribution (§3) neutralise l'avantage single-binary de Go : l'artefact de mise à jour est un unique bundle JS identique pour toutes les plateformes.
- **Condition de bascule assumée** : si la cible devient des machines à 512 Mo–1 Go, réécrire l'agent en Go redevient pertinent. Le protocole versionné (Zod → JSON Schema exportable) borne ce coût : seule l'implémentation de l'agent changerait.

### Bibliothèques sensibles de l'agent

- Process : `child_process.spawn` **détaché** (`detached: true` — indispensable sous Windows, sinon libuv place l'enfant dans un Job Object tué avec l'agent) + stdin/stdout/stderr pipés + persistance PID (voir doc 05, ré-adoption). **Validé par le spike n°1** ([`docs/spikes/01-eof-stdin.md`](spikes/01-eof-stdin.md)) : tous les loaders testés survivent à la mort de l'agent et à l'EOF stdin, restent pilotables par RCON et s'arrêtent proprement.
- Métriques — **amendé le 2026-08-21 par le spike n°2** ([`docs/spikes/02-monitoring-windows.md`](spikes/02-monitoring-windows.md)) : sous Windows, toute comptabilité CPU « par ticks » (`GetProcessTimes`, WMI, compteurs `% Processor Time`, donc `pidusage` et `systeminformation`) est fausse d'un facteur 25–60× dès qu'Hyper-V est actif (WSL2, Docker, VBS). L'agent utilise donc :
  - **Windows** : un **sidecar PowerShell persistant** (script embarqué dans le bundle, P/Invoke `QueryProcessCycleTime` via `Add-Type`, compteur `% Processor Utility` pour la machine) — aucun module natif ; repli `pidusage` + drapeau `cpuSource: 'ticks'` si PowerShell est indisponible.
  - **Linux / macOS** : `pidusage` (`/proc`, `ps`) — comptabilité exacte.
  - `systeminformation` pour l'inventaire (OS, CPU, RAM, volumes) et `mem()`/`fsSize()` périodiques (session `powerShellStart()` sur Windows) ; jamais pour la charge CPU Windows.
  - Les deux bibliothèques fonctionnent **sans `wmic`** (Windows 24H2+), vérifié.
- RCON : implémentation maison (~100 lignes, protocole trivial) avec file de commandes sérialisée.
- Backups : `archiver` (zip/tar streaming) dans un **worker_thread**. Compression par défaut — **amendé le 2026-08-21 par le spike n°3** ([`docs/spikes/03-zstd-node24.md`](spikes/03-zstd-node24.md)) : **zstd niveau 3** (`node:zlib`, Node ≥ 22.15, 5–9× plus rapide que gzip à ratio égal), `checksumFlag` activé, **gzip en repli** (runtime sans zstd ou choix utilisateur). Règles absolues : jamais `ZSTD_c_nbWorkers` (perte silencieuse de données constatée) ; l'intégrité d'une archive repose sur le **manifeste (sha256 + taille)**, jamais sur le codec (un flux zstd tronqué est accepté sans erreur par Node).

## 2. Structure du monorepo

```
mmo/
├─ apps/
│  ├─ panel/        # Fastify, ws, drizzle, web-push ; sert le front buildé + les artefacts agent
│  ├─ web/          # React PWA
│  └─ agent/        # bundle esbuild + launcher.js
├─ packages/
│  ├─ protocol/     # schémas Zod du protocole + client/serveur RPC typés
│  ├─ shared/       # i18n fr/en, mapping MC→Java, parsing de logs, heuristiques de détection
│  └─ config/       # tsconfig/eslint partagés
├─ docs/
└─ turbo.json, pnpm-workspace.yaml
```

## 3. Distribution, installation, mises à jour

### Modèle de distribution (panel et agent, même mécanique)

Archive par plateforme (win-x64, linux-x64, linux-arm64, darwin-arm64) = `runtime/` (Node officiel épinglé) + `app/` (bundle JS) + `launcher.js` + outil de service. Les archives agent sont **embarquées dans la release du panel et servies par lui** :

- Windows : `irm https://<panel>/install.ps1 | iex`
- Linux/macOS : `curl -fsSL https://<panel>/install.sh | sh`

### Démarrage au boot

- **Windows** : service via **shawl** (embarqué dans l'archive ; fallback documenté : WinSW). **Identité : compte de l'utilisateur** (pas LocalSystem — ACL sur les dossiers serveurs, lecteurs mappés). À tester sur un poste réel.
- **Linux** : unit systemd (`User=mmo`, `Restart=on-failure`).
- **macOS** : LaunchDaemon (`KeepAlive=true`).
- **Contrainte commune (spike n°1)** : le superviseur ne doit **jamais tuer l'arbre de processus** de l'agent, sinon les serveurs Java tombent avec lui. Un `taskkill /T` sur l'agent tue les serveurs détachés (constaté) ; idem `KillMode=control-group` (défaut systemd) ou un groupe de processus launchd. À imposer en phase 11 : systemd `KillMode=process` (ou serveurs lancés dans un scope transient), launchd `AbandonProcessGroup=true`, Windows : vérifier que shawl/WinSW n'enrôlent pas l'enfant dans un Job Object « kill on close » — test dédié par OS.

### Mise à jour de l'agent (modèle unifié — fait autorité)

1. Chaque release du panel embarque le bundle agent de même version + sha256 + **signature Ed25519**. La clé privée de signature vit **chez le mainteneur** (jamais sur le panel) ; la clé publique est embarquée dans l'agent — un panel compromis ne peut pas pousser du code arbitraire.
2. Au `auth.hello`, l'agent annonce sa version ; le panel propose `agent.update` (politique auto ou validation admin).
3. L'agent télécharge **depuis le panel** le bundle universel, vérifie sha256 + signature, écrit `versions/x.y.z/`, note `next.json`, sort avec le code **75**.
4. Le **launcher** (~150 lignes, figé, sur-testé, jamais mis à jour par ce canal) bascule `current` (junction/rename — pas de symlink sous Windows), relance. **Health-check : WS + heartbeat rétablis sous 30 s et pas 2 crashs**, sinon rollback automatique vers N-1 + signalement.
5. **Les serveurs Minecraft ne tombent jamais** : processus Java détachés, ré-adoptés au redémarrage de l'agent (vérification PID **+ heure de démarrage du process + ligne de commande** — jamais le PID seul). Stdin perdu jusqu'au prochain restart du serveur → pilotage RCON entre-temps (mode `detached`).
6. Le **runtime Node** a son propre canal (`runtime.update`, rare) : téléchargement de l'archive runtime, swap par le launcher au prochain restart.

## 4. Gestionnaire Java intégré

- Mapping MC→Java : **manifest Mojang** (`piston-meta.mojang.com/.../version_manifest_v2.json`, champ `javaVersion.majorVersion`), caché côté panel ; table statique en fallback hors-ligne : `[1.12,1.17)→8` (**strictement 8** pour Forge ≤ 1.16), `[1.17,1.20.5)→17`, `[1.20.5,…)→21`. **Override par serveur** toujours possible.
- Téléchargement **multi-fournisseur** (matrice vérifiée le 2026-08-21) : **Temurin** (api.adoptium.net) → **Azul Zulu** (Java 8 macOS ARM, Java 17 Windows ARM) → **build x64 sous émulation** (Java 8 Windows ARM, introuvable ailleurs). Un 404 de l'API = combo indisponible (cas normal), passer au fallback.
- Chaîne de fallback décidée **par le panel** (payload de `java.install`) + **mode relais** : le panel télécharge et sert le JRE aux agents sans Internet sortant.
- Vérification SHA-256 systématique ; JREs sous `data/jre/<major>/`.

## 5. Couche d'accès (pluggable — aucune API Tailscale dans le code)

Contexte réseau de référence : machine hôte en **IPv6 seul, IPv4 CGNAT, pas de redirection de ports** — mais les deux cas (traversée VPN et exposition directe) sont gérés.

| Mode | Mécanique | HTTPS | Pour qui |
|---|---|---|---|
| **`tailscale`** (défaut) | Tailnet privé ; panel derrière `tailscale serve` (écoute 127.0.0.1) | Cert Let's Encrypt auto pour `panel.<tailnet>.ts.net` | 100 % des amis (traverse CGNAT/4G/hôtel) ; plan gratuit = 6 utilisateurs |
| **`direct`** | Domaine perso + AAAA vers la box, pinholes pare-feu IPv6 | **ACME DNS-01 intégré au panel** + client DynDNS intégré (mise à jour de l'AAAA au changement de préfixe) | Amis avec IPv6 de bout en bout ; aucune app à installer |
| **`manual`** | Reverse-proxy/certificats fournis par l'utilisateur | À sa charge | Configurations avancées |

Faits vérifiés qui imposent ce design :

- PWA, service worker et Web Push exigent un **contexte sécurisé HTTPS** (seule exception : localhost) — même dans un tailnet.
- Le **push sort sur Internet** (FCM/Apple/Mozilla) : le panel a besoin d'Internet sortant pour notifier, quel que soit le mode.
- **iOS ≥ 16.4** : push uniquement pour la PWA **installée sur l'écran d'accueil** → onboarding guidé + re-synchronisation périodique des abonnements (iOS purge silencieusement).

**Jeu (connexion Minecraft des amis)** : réglage **par serveur** — `tailnet` ou `direct` — le panel affiche l'adresse exacte à donner aux amis pour chaque mode + test de joignabilité intégré. Minecraft Java gère l'IPv6 nativement.

Portabilité : si Tailscale change ses conditions → **Headscale** (serveur de contrôle open-source auto-hébergé, mêmes clients) ou mode `direct`, sans toucher au code MMO.

## 6. Sécurité (résumé)

- Panel : écoute uniquement sur 127.0.0.1 (mode tailscale) ou sur l'interface dédiée — jamais `0.0.0.0`.
- Sessions cookie (token haché en base), argon2id, RBAC admin/opérateur/lecture. *Phase 4* : cookie `mmo_session` (256 bits aléatoires, SHA-256 en base, `HttpOnly`, `SameSite=Lax`, `Secure` si `panel.publicUrl` est en https ou `MMO_COOKIE_SECURE=1`, 30 jours) ; **refus par défaut** — toute route non marquée `public` exige une session, rôle minimal par route (`viewer` < `operator` < `admin`) ; login limité à 10 essais/min par IP+compte ; le dernier admin actif ne peut être ni rétrogradé ni supprimé ; désactivation/changement de rôle/mot de passe = sessions révoquées. `/ws/client` authentifie par le même cookie à l'upgrade.
- Secrets d'agent : 256 bits, hachés côté panel, rotation/révocation. Codes d'appairage : hachés, TTL 15 min, 5 essais, rate-limit.
- L'authentification applicative des agents est **obligatoire même sous Tailscale** (les appareils des amis sont dans le tailnet ; Tailscale authentifie des machines, pas des rôles).
- **Port RCON** : bloqué hors machine locale (règle pare-feu posée par l'agent + ACL réseau documentée) — il écoute en clair sur toutes les interfaces.
- Bundles agent signés Ed25519 (§3).

## 7. i18n et erreurs

- Tout texte visible passe par i18next (`fr`/`en`) dès la première ligne. Phase 2 : ressources en **modules TS typés** (`packages/shared/src/i18n/locales/{en,fr}.ts`, parité de clés vérifiée à la compilation par `satisfies` + test), espaces de noms `common` / `errors` (un texte par code protocole) / `detection` (sources et evidence) ; `createI18n(locale)` = instance isolée (le panel localise chaque push selon son destinataire), `resources` branché sur `react-i18next` côté web.
- **Règle protocole** : `error.message` = anglais technique (logs) ; l'UI traduit à partir de `error.code` + `error.details`. Idem pour les textes de push (localisés par le panel selon la langue du destinataire).

## 8. Premier démarrage (bootstrap)

Wizard first-run : si la table `users` est vide → création du compte admin (endpoint verrouillé ensuite), génération des clés VAPID, choix du répertoire data et de la destination de backups par défaut, choix du mode d'accès. Rien de tout cela n'est fait « à la main ».

> **Implémentation (phase 4, API)** : `GET /api/setup/status` → `{ needsSetup }` ; `POST /api/setup { username, password, locale?, publicUrl?, accessMode?, backupDestination? }` crée l'admin, génère les clés VAPID (P-256 via `node:crypto`, privée jamais exposée par l'API), enregistre les réglages et ouvre la session ; `E_SETUP_DONE` ensuite. Tant qu'aucun utilisateur n'existe, les routes protégées répondent `E_AUTH` avec `details.setupRequired = true` (le front redirige vers le wizard). **Dérogation** : le répertoire data se choisit **par l'environnement** (`MMO_DATA_DIR`), pas dans le wizard — la base doit exister avant la première page.

## 9. Tests

| Niveau | Outil | Points clés |
|---|---|---|
| Unitaires | Vitest | mapping MC→Java, parsing logs, heuristiques de détection (fixtures copiées de vrais dossiers), schémas protocole, RBAC |
| Intégration panel | Vitest + `fastify.inject` + SQLite temporaire | API, auth, migrations rejouées from scratch |
| Intégration protocole | Panel + agent réels in-process | appairage, reconnexion, négociation de version, update + rollback |
| Intégration agent | **« fake Java server »** (script Node imitant un serveur MC : `Done`, joins, crash, RCON, délais) | start/stop/kill, watchdog, ré-adoption, garde-fou RAM — sans Java en CI |
| E2E | Playwright | flux PWA complets, viewports mobile + desktop, fr + en |
| CI | GitHub Actions : windows, ubuntu, **ubuntu-arm**, macos | rendue possible par le fake server |

## 10. Spikes de validation (réalisés le 2026-08-21 — voir [docs/spikes/](spikes/README.md))

1. **Comportement EOF stdin** — ✅ [confirmé](spikes/01-eof-stdin.md) : Vanilla 1.20.1, Forge 1.12.2/1.16.5, Fabric 1.21.1, NeoForge 1.21.1 survivent tous à la mort de l'agent et à l'EOF, restent pilotables par RCON et s'arrêtent proprement. Le modèle « serveurs détachés, stdin principal + RCON » est retenu tel quel ; la variante « java sans stdin, 100 % RCON » n'est pas nécessaire. Conditions : `detached: true` (Windows) et superviseur qui ne tue jamais l'arbre de processus (§3).
2. **Monitoring Windows 11 24H2+** — ✅/❗ [résultat](spikes/02-monitoring-windows.md) : `systeminformation` et `pidusage` n'utilisent plus `wmic` ; mais la comptabilité CPU par ticks est fausse sous Hyper-V → sidecar PowerShell + `QueryProcessCycleTime` (§1). Le fallback « CIM maison » initialement prévu aurait été faux lui aussi.
3. **zstd dans Node 24** — ✅ [validé](spikes/03-zstd-node24.md) : API streaming complète (Node ≥ 22.15), 5–9× plus rapide que gzip → zstd 3 par défaut, gzip en repli ; interdits/garde-fous en §1.

## 11. Risques assumés

| Risque | Mitigation |
|---|---|
| RSS agent ~100 Mo (vs ~30 en Go) | Sans conséquence sur les machines cibles ; bascule Go possible à coût borné |
| `better-sqlite3` natif (panel uniquement) | Prébuilds 4 plateformes ; plan B `node:sqlite` |
| Process Windows (pas de signaux POSIX) | Séquence stop→RCON→taskkill testée dédiément ; java lancé directement (jamais via shell/.bat) |
| Launcher = SPOF des mises à jour | Minuscule, figé, sur-testé, ne parle pas réseau |
| Push iOS capricieux | Onboarding guidé + resync ; fallback centre de notifications in-app (+ Discord futur) |
| Churn de l'écosystème front | Versions épinglées ; protocole et agent indépendants des libs volatiles |
