# CLAUDE.md — MinecraftManagerOnline (MMO)

Fichier de contexte pour Claude uniquement. Style volontairement dense. **À maintenir** : mettre à jour la section « État » à chaque fin de phase, décision structurante, ou avant de proposer un changement de chat.

## Projet
Pilotage à distance de serveurs Minecraft auto-hébergés. Architecture : panel central (web + API + SQLite) + agents (1 par machine, WebSocket sortant, appairage par code). Multi-OS Win/Linux/macOS, x64 + ARM64. PWA responsive FR/EN, thème sombre. Licence propriétaire. Pas de MVP : application complète (périmètre = doc 02).

## Source de vérité = docs/ — lire À LA DEMANDE, ne pas dupliquer ici
- 01-presentation : vision, principes, glossaire
- 02-fonctionnalites : périmètre V1/Futur (11 domaines)
- 03-socle-technique : stack, distribution/updates, couche d'accès, sécurité, tests, spikes
- 04-base-de-donnees : schéma SQLite complet + règles d'exploitation
- 05-protocole : catalogue des messages panel↔agent, tasks, transferts, pannes
- 06-minecraft : lancement (4 templates), détection, console, cycle de vie, RCON, TPS, fichiers
- 07-plan-de-developpement : 13 phases (0–12), dépendances, critères « terminé quand »

## Décisions verrouillées (résumé télégraphique)
TS partout · Node 24 LTS épinglé · Fastify 5 + Zod 4 · React 19 + Vite + Mantine 8 + TanStack + xterm · SQLite WAL, 2 fichiers (mmo.db + metrics.db) · Drizzle · pnpm + Turborepo · agent = bundle esbuild universel + runtime Node embarqué + micro-launcher (exit 75, health-check 30 s/2 crashs, rollback N-1, signature Ed25519, clé privée hors panel) · AUCUN module natif dans l'agent · RCON auto-provisionné (stdin = principal, RCON = complément/mode detached) · serveurs Java détachés, survivent à l'agent, ré-adoption PID+heure+cmdline · couche d'accès pluggable tailscale(défaut)/direct(IPv6+ACME DNS-01+DynDNS)/manual, ZÉRO API Tailscale dans le code · Java multi-fournisseur Temurin→Zulu→x64 émulé, mapping via manifest Mojang · métriques 15 s · timestamps epoch ms partout · jamais `.strict()` sur les schémas protocole · protocole évolue par ajout, panel supporte N/N-1 · erreurs = codes (l'UI traduit) · i18n fr/en dès la 1re chaîne · panel = autorité des IDs serveurs · compression gzip (zstd si spike OK)

## Environnement utilisateur
Windows 11 · PC en IPv6 seul (CGNAT IPv4, pas de redirection de ports) · serveurs réels dans `E:\Minecraft\Server` (~56 : Forge/NeoForge/Fabric/Vanilla, 1.12→1.21, structures hétérogènes) = terrain de test → **travailler sur des copies, ne rien modifier/casser** · git : identité locale neutre déjà configurée sur le repo (MinecraftManagerOnline / noreply) — ne JAMAIS utiliser le nom/mail perso de l'utilisateur, ni dans les commits ni ailleurs.

## Méthode de travail
- Français, concis. L'utilisateur valide chaque phase avant la suivante ; les décisions déjà validées ne se rediscutent pas.
- Une phase = code + tests + docs amendés (toute dérogation aux docs 03–06 est actée dans le doc concerné) + commit(s) en français.
- Économie de contexte : lire uniquement les docs/fichiers utiles à la tâche en cours ; ne pas re-scanner `E:\Minecraft\Server` ; ne pas relire des docs déjà appliqués dans la session.
- **Règle de rotation de chat** : dès que le contexte devient lourd (fin de phase, long débogage clos, pivot de sujet), (1) mettre à jour la section « État » ci-dessous, (2) proposer spontanément à l'utilisateur un prompt prêt-à-coller pour démarrer un nouveau chat qui reprend exactement où on en est.

## État (maj 2026-08-21, fin de session phases 0 + 1)
- **Fait** : Phase 0 (3 spikes → notes `docs/spikes/0x-*.md`, scripts reproductibles `docs/spikes/scripts/`, hors workspace) et Phase 1 (monorepo pnpm 11 + Turborepo 2.10, Node 24.19 épinglé `.node-version`, TS 5.9 strict, ESLint 10 flat config avec règles anti-`.strict()` (protocol) et anti-module-natif (agent, + test de scan du bundle), Vitest 4, squelettes testés des 5 packages, CI 4 OS, CONTRIBUTING.md). `pnpm check` vert en local (Windows). **CI GitHub pas encore observée** (aucun remote configuré).
- **Résultats des spikes** : (1) EOF — Vanilla 1.20.1, Forge 1.12.2/1.16.5, Fabric 1.21.1, NeoForge 1.21.1 survivent tous à la mort de l'agent et à l'EOF stdin, restent pilotables par RCON, s'arrêtent proprement → modèle « détaché + RCON » confirmé ; piège : `taskkill /T` / `KillMode=control-group` tuent les serveurs. (2) Monitoring — `pidusage`/`systeminformation` OK sans wmic, MAIS CPU par ticks faux ×25–60 sous Hyper-V (VBS/WSL2) → sidecar PowerShell persistant + `QueryProcessCycleTime` sur Windows, `% Processor Utility` pour la machine. (3) zstd — validé (Node ≥ 22.15), 5–9× plus rapide que gzip → zstd 3 par défaut ; jamais `nbWorkers` (flux vide silencieux) ; intégrité par manifeste sha256 (flux tronqué accepté sans erreur).
- **Amendements aux docs** (commit dédié, réversible en bloc si désaccord) : doc 03 §1 (métriques Windows par cycles ; zstd par défaut), §3 (le superviseur ne tue jamais l'arbre de processus), §10 (spikes clos) ; doc 05 (compression zstd, champ optionnel `cpuSource`) ; doc 06 §3 (règle stdin nuancée).
- **Environnement** : `node` global machine = 22.14 ; Node 24.19 via `%LOCALAPPDATA%\pnpm\bin\node.EXE` (pnpm env, hors PATH). TypeScript 6/7 (compilateur natif) : migration à évaluer quand typescript-eslint le supportera (< 6.1 aujourd'hui). Politique pnpm : versions exactes, `minimumReleaseAge` 3 jours.
- **Prochaine étape** : Phase 2 = `packages/shared` (i18n fr/en, mapping MC→Java via manifest Mojang + fallback, parsing de logs 2 formats + stacktraces, heuristiques de détection — fixtures copiées/anonymisées de vrais dossiers) et `packages/protocol` (enveloppe, codes d'erreur, schémas jalon A, RPC typé, négociation N/N-1, tests de contrat). Terminé quand détection correcte sur ≥ 90 % des fixtures réelles.
