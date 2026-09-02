# 05 — Protocole panel ↔ agent

Version de protocole décrite : `1`. Schémas définis en Zod dans `packages/protocol` (unions discriminées) — **règle : jamais de validation `.strict()`** (la tolérance aux champs inconnus est la base de la compatibilité, à encoder en convention de lint).

## 1. Principes

- **Transport** : une connexion WebSocket persistante par agent, **toujours initiée par l'agent** (`wss://<panel>/ws/agent` — doc 03 §1). Frames texte = JSON ; frames binaires = chunks de transfert.
- **Trois genres** : `req` (attend une réponse), `res` (corrélée par `re`), `event` (sans réponse). Canal full-duplex : panel et agent émettent tous deux des `req`.
- **Opérations longues = tasks** (backup, restore, migration, scan, java.install, update) : mécanisme unifié de progression/annulation/reprise (§7). Le `taskId` est fourni par le panel et **persisté en base** (table `tasks`) — le panel survit à son propre redémarrage et réconcilie via `task.list`.
- **Idempotence** : tout `req` porte un `id` ULID ; l'agent déduplique (cache 10 min / 1000 entrées). Rejouer une requête avec le même `id` est toujours sûr. Idempotence sémantique en plus : `server.start` sur un serveur déjà démarré → `ok:true, {alreadyRunning:true}`.
- **Découpage d'implémentation** (le cœur RPC est le vrai gros morceau du projet — planifié comme tel) : jalon A = req/res + events + console avec `seq` ; jalon B = tasks ; jalon C = transferts binaires. Tous livrés dans l'application V1.

## 2. Enveloppe

```json
{
  "v": 1,
  "kind": "req",
  "id": "01J5X8ZK3Q9WYE2R7M4T6B8N1C",
  "type": "server.start",
  "ts": 1787330455000,
  "deadlineMs": 30000,
  "payload": {}
}
```

- `ts` : epoch **millisecondes** (comme partout — doc 04), informatif, jamais un élément de sécurité.
- Champs optionnels actés en phase 2 : `userId` sur les `req` du panel (audit, §12) ; `id` sur les `event` **critiques** (§6 « Tasks et événements fiables ») — c’est cet identifiant, recopié dans `payload.eventId`, qu’acquitte `event.ack`.
- Réponse : `kind:"res"`, `re:<id>`, `ok:true|false`, `payload` ou `error`.
- **Erreur** : `{ code, message, retryable, details }`. `message` = anglais technique (logs) ; **l'UI traduit `code` + `details`** via l'i18n de `packages/shared`.
- Codes standard : `E_AUTH`, `E_PAIRING_CODE_INVALID`, `E_UNSUPPORTED_VERSION`, `E_UNSUPPORTED_TYPE`, `E_INVALID_PAYLOAD` (ajouté en phase 2 : payload ou réponse non conforme au schéma — jamais de déconnexion), `E_NOT_FOUND`, `E_CONFLICT`, `E_BUSY`, `E_TIMEOUT`, `E_CANCELLED`, `E_IO`, `E_PORT_IN_USE`, `E_RAM_GUARD`, `E_EULA_REQUIRED`, `E_JAVA_UNAVAILABLE`, `E_CHECKSUM_MISMATCH`, `E_INTERRUPTED`, `E_INTERNAL`.

## 3. Appairage

```
Admin (UI)                Panel                              Agent (nouvelle machine)
  |-- « Ajouter machine »-->|
  |<-- code MMOP-7F2K-9QXB--|  (TTL 15 min, usage unique, stocké HACHÉ,
  |    + one-liner install  |   5 essais max, rate-limit)
                            |<-- WS + req pair.request ---------|
                            |--- res pair.ok {agentId, secret} ->|
                            |<-- reconnexion + auth.hello -------|
```

- Secret : 256 bits aléatoires. Agent : stocké dans `agent-state.json`, permissions restreintes (chmod 600 / ACL propriétaire). Panel : **hash SHA-256 uniquement**.
- Rotation : `agent.rotateSecret` (les deux secrets valides 24 h pour éviter le lockout). Révocation : suppression de la machine dans l'UI.

> **Implémentation (phase 4, panel)** : `POST /api/machines { name }` crée la machine `pending` et retourne le code (affiché une seule fois) + les one-liners d'installation (si `panel.publicUrl` est réglé) ; `POST /api/machines/:id/pairing-codes` régénère. `pair.request` compare le hash, vérifie TTL/usage unique/essais (doc 04 §2 : 5 échecs brûlent les codes actifs), négocie la version (`E_UNSUPPORTED_VERSION` sinon), enregistre `machine` (OS, arch, hostname, CPU, RAM) et répond `{ agentId = machines.id, secret }`. Rotation : `POST /api/machines/:id/rotate-secret` envoie `agent.rotateSecret` **avant** de remplacer le hash (l'ancien reste accepté jusqu'à `graceUntil`). Révocation : `DELETE /api/machines/:id` (session fermée code 4003, secret oublié, serveurs retirés) ou désactivation (`PATCH { disabled: true }`, `E_AUTH` à la prochaine `auth.hello`).

> **Implémentation (phase 10, sans bump)** : `machineInfo` (porté par `pair.request.machine` et `auth.hello.machine`) gagne `addresses?: { tailnet: string[], global: string[] }` — classement purement syntaxique des interfaces par l'agent (`networkAddresses()` : tailnet = 100.64.0.0/10 et fd7a:115c:a1e0::/48, global = 2000::/3 et IPv4 non privée ; link-local, boucle et RFC 1918 ignorées), sans aucun appel à Tailscale. Le panel le stocke dans `machines.addresses` pour « l'adresse à donner aux amis » (doc 03 §5).

## 4. Authentification et session

`auth.hello` (agent → panel) : `agentId`, `agentSecret`, `agentVersion`, `protoMin/protoMax`, `capabilities` (`rcon`, `zstd`, `direct-transfer`…), `compression` (codecs supportés par le runtime, spike n°3 — le panel choisit et renvoie `compression` dans `auth.ok`), `resume` (tasks en attente, dernier req acquitté), `machine` (hostname, OS, arch, CPU, RAM).

`auth.ok` : version négociée (`min(panelMax, agentMax)` si compatible, sinon `E_UNSUPPORTED_VERSION` + ordre de mise à jour), `heartbeatIntervalSec`, `wantFullSync`, `subscriptions` (ré-abonnements avec `sinceSeq`).

**`sync.state`** (si `wantFullSync`) : snapshot complet de vérité terrain — serveurs et états réels, **mode d'attache** (`attached` = stdin/stdout pipés ; `detached` = process survivant à un redémarrage d'agent, pilotage RCON + tail de logfile), tasks en cours, compteurs `seq`, ports occupés, JRE installés. **Le panel réconcilie sur ce snapshot** (l'agent est la vérité sur ce qui tourne) : correction des états, clôture des sessions joueurs orphelines, relance selon `desired_state`.

> **Implémentation (phase 4, panel)** : toute requête/événement avant `auth.hello` → `E_AUTH` / ignoré. `auth.ok` : `wantFullSync` toujours `true`, `heartbeatIntervalSec` = 15, `compression` = `zstd` si annoncé sinon `gzip` sinon `none`, `subscriptions` = canaux `console:<serverId>` regardés par au moins un navigateur avec `sinceSeq` = dernier `seq` connu du panel (l'agent renvoie les lignes manquantes). **Une session par machine** : une nouvelle `auth.hello` ferme l'ancienne session (code 4000). Réconciliation sur `sync.state` : états et `pid`/`attachMode` alignés sur le snapshot (événements `server.stateChanged { reconciled: true }` pour les écarts), serveurs de la base absents du snapshot et « en marche » remis à `stopped`, sessions joueurs clôturées, `serverId` inconnus du panel journalisés ; puis, après la réponse, `agent.configure` complet et `server.start` des `desired_state = running` arrêtés (échec → événement `server.startFailed`).

## 5. Heartbeat et autonomie

- Ping/pong WS + `agent.heartbeat` (event, 15 s) : CPU/RAM/disque machine, nb serveurs actifs, tasks actives.
- Panel : agent **offline** après 40 s sans heartbeat → événement + push ; les serveurs de la machine passent à « inaccessible » (dérivé, jamais `stopped` : on ne sait pas). *Phase 4* : le panel ferme lui-même la session (code 4002) et émet `agent.offline` ; `last_seen_at` est rafraîchi à chaque heartbeat, dont la dernière valeur (CPU/RAM/disque) est exposée dans l'API machines et diffusée aux navigateurs (`machine.heartbeat`).
- Agent sans panel : reconnexion en backoff (1 s → 60 s, jitter ±20 %), et **autonomie totale** — watchdog, backups planifiés, redémarrage des serveurs `desired_state='running'` au boot de la machine (le `desired_state` par serveur est poussé et **persisté côté agent** via `agent.configure`, politique « restaurer au boot » configurable).

## 6. Catalogue des messages

> **Implémentation (phase 2)** : le jalon A vit dans `packages/protocol` — `REQUESTS` / `EVENTS` (`src/catalog.ts`, direction + schémas Zod requête/réponse), enveloppe (`envelope.ts`), `ProtocolError` (`errors.ts`), pair RPC typé `RpcPeer` (`rpc/peer.ts` : idempotence, timeouts, `E_UNSUPPORTED_TYPE`/`E_INVALID_PAYLOAD`), négociation (`version.ts`). Tests de contrat sur `test/fixtures/v1/messages.json` (un échantillon par type, tolérance aux champs inconnus). Les types `task.*`, `backup.*`, `java.install`, `agent.update`, `runtime.update` et `fs.*transfer*` (jalons B/C) s’ajoutent au catalogue sans bump.

> **Amendement (phase 3, sans bump)** : `scan.run` est **implémenté et ajouté au catalogue** — requête `{ directoryIds?, paths? }`, réponse `{ scannedPaths, servers: detectedServerSchema[] }` (scan immédiat, en plus des `server.detected` diffusés en événements). `agent.configure` porte désormais un tableau **`servers`** (`serverConfigSchema` : `serverId`, `path`, `maxRamMb`/`minRamMb`, `loader`, `mcVersion`, `launch`, `javaMajor`/`javaStrict`/`javaPath`, `jvmArgs`, `startTimeoutSec`/`stopTimeoutSec`) : la config de lancement poussée par le panel (autorité des IDs) et **persistée côté agent** dans `agent-state.json`, indispensable pour lancer/relancer un serveur sans panel (restauration au boot, watchdog). Liste complète si présente : un serveur absent mais **arrêté** est oublié ; un serveur en marche est conservé.

### Cycle de vie agent

| Type | Dir. | Description |
|---|---|---|
| `pair.request` | A→P | Appairage initial |
| `auth.hello` / `sync.state` | A→P | Auth + snapshot |
| `agent.heartbeat` | A→P (event) | Statut léger 15 s — **lot 9** : `agentRssMb?` / `agentCpuPct?` (coût du processus agent lui-même, CPU en cœurs ; `SelfMeter`, delta de `process.cpuUsage()`), relayés au front dans `machine.heartbeat` |
| `agent.info` | P→A | Détails machine (volumes, JRE, répertoires) |
| `agent.configure` | P→A | Config poussée et persistée : répertoires surveillés, destination backups, règles watchdog, plannings de backups locaux, **`desired_state` par serveur**, intervalle métriques, `mojangLookup?` (lot 9, vie privée : `false` = usercache local seulement, jamais l'API Mojang ; un agent N-1 l'ignore) |
| `agent.rotateSecret` | P→A | Rotation du secret |
| `agent.update` | P→A | Mise à jour du **bundle universel** (§9) |
| `runtime.update` | P→A | Mise à jour du runtime Node (canal séparé, rare) |
| `agent.restart` | P→A | Redémarre l'agent (les serveurs détachés survivent) |
| `agent.diagnostics` | P→A | **Lot 9** : diagnostic borné — état de l'agent + fin de son journal fichier |
| `agent.log` | A→P (event) | Logs internes agent (≥ warn) |

> **Amendement (2026-09-02, lot 9, sans bump) — `agent.diagnostics` et journal fichier de l'agent.** L'agent n'avait **aucun** fichier de journal : stderr, capturé ou non par le gestionnaire de service (journald, shawl, launchd — jamais au même endroit), et deux niveaux relayés au panel par `agent.log`. Sur un incident chez un tiers, il n'y avait rien à lire. Désormais chaque ligne du `Logger` est aussi écrite dans **`<stateDir>/logs/agent-<date>.log`** (`apps/agent/src/log-file.ts` sur `@mmo/shared/node` `createRotatingLog`, la mécanique du journal du panel : fichier choisi à l'écriture, bascule quotidienne, 32 Mio puis suffixe numéroté, 14 jours, purge aussi depuis le timer de corbeille — un agent silencieux ne bascule jamais). **`agent.diagnostics { logLines? ≤ 2000 (200), logMaxBytes? ≤ 1 Mio (256 Kio) }`** rend `{ agentVersion, runtimeVersion, machine, pid, startedAt, uptimeSec, stateDir, agentHome?, rssMb, panelUrl?, connected, servers[] (serverId, runState, attachMode, pid?), activeTasks, capabilities, log: { file?, lines[], truncated } }` : **borné** des deux côtés (l'agent ne lit jamais plus de `logMaxBytes` octets du fichier, `tailRotatedLog`), **jamais masqué par l'agent** — c'est le panel qui masque avec les règles de `mmo-panel report` (`util/mask.ts` : chemins personnels, jetons, codes d'appairage, adresses tronquées) avant de servir `GET /api/machines/:id/diagnostics` (admin, pièce jointe `text/plain`, audit `machine.diagnostics`). Capacité annoncée : `diagnostics`. Un agent N-1 répond `E_UNSUPPORTED_TYPE` (HTTP 501) et l'UI dit de le mettre à jour ; la fixture `v1/messages.json` porte un échantillon, les fixtures N-1 sont inchangées (ajout pur).

### Détection

| Type | Dir. | Description |
|---|---|---|
| `scan.run` | P→A | Scan immédiat des répertoires surveillés (ou de `paths` ad hoc) → `{ scannedPaths, servers }` **et** événements `server.detected`/`updated`/`removed` (diff). Implémenté phase 3 |
| `server.detected` | A→P (event) | Serveur découvert : loader, version MC, RAM détectée + source, ports, EULA, **score de confiance + evidence**. Schéma `detectedServerSchema` = sortie exacte de `detectServer()` (`@mmo/shared`) : champs `{ value, confidence, source }`, `evidence[]` = codes traduits par l’UI, `launch` (template doc 06 §1), `javaRequirement` (table ; affiné par le panel via le manifest), `needsInstall` |
| `server.removed` / `server.updated` | A→P (event) | Dossier disparu / métadonnées changées |

Identifiants : marqueur `.mmo-server.json` déposé dans le dossier, mais **le panel est l'autorité** — marqueur dupliqué (copie/restore) = conflit explicite, voir doc 04 §3.

### Contrôle des serveurs

| Type | Dir. | Description |
|---|---|---|
| `server.start` | P→A | L'agent construit la commande java (doc 06) ; garde-fous RAM/port/EULA/Java → erreurs typées |
| `server.stop` | P→A | Arrêt propre (`stop` stdin, fallback RCON) ; `{ timeoutSec: 120, announce?, forceAfterTimeout? }` |
| `server.restart` | P→A | stop + start atomique côté agent (survit à une coupure panel) |
| `server.kill` | P→A | Terminaison forcée |
| `server.stateChanged` | A→P (event) | `starting/running/stopping/stopped/crashed` + `exitReason` (`stop`/`kill`/`crash`/`freeze_kill`), `exitCode`, `crashReportPath`. **Toujours émis par l'agent** — le panel ne déduit jamais un état |
| `server.command` | P→A | Commande console via stdin |
| `server.rcon` | P→A | Commande via RCON (réponse corrélée ; seul canal en mode `detached`) |
| `server.eulaAccept` | P→A | Écrit `eula=true` après confirmation UI |
| `server.setProvisioning` | P→A | `installing/ready/archived` |
| `player.event` | A→P (event) | join/leave parsé des logs (+ effectif en ligne) |
| `player.list` | P→A | Liste en ligne à la demande (RCON `list`) |
| `player.action` | P→A | *Phase 6.* `{ action: kick\|ban\|pardon\|banIp\|pardonIp\|op\|deop\|whitelistAdd\|whitelistRemove, target, reason?, level? }` — **routé par l'agent** : en marche → commande (RCON de préférence pour la réponse, stdin en repli), arrêté → édition du fichier JSON (`kick` → `E_CONFLICT`). Réponse `{ applied: file\|commands, response?, warnings? }` (`W_OP_LEVEL_LIVE`, `W_BAN_EXPIRES_LIVE`, `W_COMMAND_FAILED`) |
| `player.resolve` | P→A | *Phase 6.* `{ names[] }` → `{ players: [{ name, uuid\|null, source: usercache\|mojang\|offline\|unknown }], onlineMode }` — `usercache.json` d'abord, puis API Mojang (`online-mode=true`, lot de 10) ou UUID v3 hors ligne (doc 06 §7) |

### Console et logs

| Type | Dir. | Description |
|---|---|---|
| `console.subscribe` | P→A | `{ serverId, sinceSeq }` — abonnement + rattrapage |
| `console.unsubscribe` | P→A | Personne ne regarde → économie de bande passante |
| `console.lines` | A→P (event) | Lignes batchées (≤ 50 lignes ou 100 ms), chacune avec `seq`, `ts`, `level`, `text` |
| `logs.search` | P→A | Recherche dans les archives **exécutée par l'agent** (les logs ne quittent jamais la machine — pas d'archivage central en V1) |
| `logs.listFiles` | P→A | Liste des `logs/*.log.gz` (téléchargeables via transferts) |

Rattrapage : ring buffer agent (5 000 lignes / 2 Mo par serveur), `seq` monotone persisté. Trou trop grand → `{ truncated: true, oldestSeq }`, l'UI signale et complète via `logs.search`. Le `seq` déduplique aussi les batches reçus en double. Côté panel, les derniers `seq` consommés sont persistés périodiquement ; après un restart du panel, un `wantFullSync` peut laisser un trou visuel de console — assumé et affiché. *Phase 4* : relais console côté panel = ring buffer mémoire de 1 000 lignes par serveur, `console.subscribe` vers l'agent au **premier** navigateur abonné (`sinceSeq` = dernier `seq` du buffer), `console.unsubscribe` au départ du dernier, dédup par `seq` dans les deux sens ; `GET /api/servers/:id/console` sert le buffer (complété par un aller-retour agent si personne ne regarde).

### Fichiers et configuration

| Type | Dir. | Description |
|---|---|---|
| `fs.list` / `fs.stat` / `fs.mkdir` / `fs.rename` / `fs.copy` | P→A | Chemins **relatifs, normalisés et jailés** aux racines autorisées (`../` refusé) |
| `fs.delete` | P→A | → corbeille `.mmo-trash/` (purge 7 j), pas de suppression directe |
| `fs.read` | P→A | Petits fichiers texte ≤ 512 Ko inline ; au-delà, le panel bascule automatiquement sur `fs.download` (cas crash-reports volumineux) |
| `fs.write` | P→A | Écriture atomique (temp + rename), `expectedSha256` optionnel → `E_CONFLICT` si édition concurrente |
| `config.get` / `config.set` | P→A | Sur-couche typée : `server.properties`, `whitelist.json`, `ops.json`, `banned-players.json`, `banned-ips.json` rendus en JSON structuré. **Routage par l'agent** : serveur en marche → commandes (`whitelist add`…), arrêté → édition de fichiers (doc 06 §7). *Phase 6* : schémas des entrées dans `CONFIG_DATA_SCHEMAS` (`set` = patch `{ clé: valeur \| null }` pour les properties, tableau complet pour les JSON) ; réponse enrichie `{ applied, restartRequired, commands?, warnings?, sha256? }` |
| `fs.download.start` / `fs.upload.start` / `fs.transfer.ack` / `fs.transfer.done` / `fs.transfer.cancel` | bidir. | Gros fichiers (§8) |

### Monitoring

| Type | Dir. | Description |
|---|---|---|
| `metrics.configure` | P→A | Intervalle par défaut **15 s** (5 s = mode inspection temporaire, non persisté en brut) |
| `metrics.sample` | A→P (event) | Machine + par serveur : CPU, RSS, TPS/MSPT si disponibles, joueurs (buffer local 1 h hors-ligne, rejoué avec timestamps). Champ optionnel `cpuSource: 'cycles' \| 'proc' \| 'ticks'` (spike n°2) : `ticks` = valeur potentiellement sous-évaluée (Windows sans PowerShell), l'UI l'affiche avec un avertissement |
| `watchdog.alert` | A→P (event) | Crash/freeze : `{ kind, action, attempt }` — politique poussée par `agent.configure`, **exécutée localement** |
| `port.conflict` | A→P (event) | Conflit de port détecté sur la machine |

> **Implémentation (phase 7, sans bump)** : `metrics.sample.servers[].tpsSource` (`neoforge | forge | spark | tick_query`, absent = indisponible) et `watchdog.alert.kind = 'ram'` (garde-fou mémoire, `action: 'none'`) ajoutés. **Agent** (`src/monitoring/`) : `MetricsCollector` toutes les `metricsIntervalSec` (15 s, `agent.configure`/`metrics.configure` appliqués à chaud) — CPU/RSS des serveurs `starting/running/stopping` (échantillonneur par OS, doc 03 §1), joueurs connus de l'agent, TPS/MSPT via `TpsProbe` (RCON, uniquement `running`), machine (CPU, RAM, disque) + `cpuSource` ; hors ligne, **tampon mémoire 1 h glissante** (`bufferMs / intervalMs` échantillons) rejoué tel quel (timestamps d'origine) à la session suivante, avant le rattrapage console. Le heartbeat reprend `cpuPct`/`cpuSource`/disque du dernier relevé. `watchdog.alert` est critique (journalisé, rejoué, acquitté). **Panel** : `metrics.sample` → `MetricsService` (doc 04 §7) et diffusion `{ type: 'metrics.sample', machineId, sample }` sur `/ws/client` (le front ajoute le point aux séries brutes affichées) ; `watchdog.alert` → événement `watchdog.alert` (`critical` pour `crash_loop`/`gave_up`, sinon `warning`) **et** ligne d'audit `watchdog.<action>` (userId null) quand une action automatique a eu lieu ; `port.conflict` → événement `warning`. Le panel pousse la politique watchdog dans `agent.configure.watchdog` depuis `servers.auto_restart / crash_loop_max / watchdog_freeze_s` (`freezeAction` = `kill_restart`) ; l'agent la **persiste** (`agent-state.json › watchdog`) et l'applique sans panel.

### Backups

| Type | Dir. | Description |
|---|---|---|
| `backup.create` | P→A | Task. Serveur en marche : `save-off` + `save-all flush` → copie → `save-on` (backup à chaud cohérent, via RCON si détaché) |
| `backup.list` | P→A | Archives présentes (id, taille, sha256, date) |
| `backup.restore` | P→A | Task. Stop → **backup de sécurité automatique** → restauration → redémarrage optionnel |
| `backup.delete` | P→A | Suppression (confirmation UI) |
| `backup.rotated` | A→P (event) | Suppressions faites par la **rotation locale de l'agent** — synchronise la table `backups` (événement journalisé/acquitté) |
| `backup.skipped` | A→P (event) | Occurrence de planning **volontairement non exécutée** (serveur arrêté sous `onlyIfRunning`, autre task de sauvegarde en cours, cron invalide, démarrage impossible) — **non critique** |

Plannings de backups : poussés via `agent.configure`, **déclenchés localement** (un backup nocturne ne dépend pas du panel) ; résultats rejoués à la reconnexion.

> **Implémentation (phase 8, jalon B — sans bump)** : schémas dans `packages/protocol/src/messages/tasks.ts`. Toute requête qui démarre une task répond immédiatement `{ taskId }` (`backup.create` ajoute `backupId`) ; le **`taskId` est fourni par l'initiateur** (ULID : le panel pour les ordres, l'agent pour ses plannings), ce qui rend le rejeu idempotent (même `taskId` ⇒ la task n'est pas relancée). `backup.create { taskId, serverId, backupId?, kind, policyId?, destination?, codec? (zstd|gzip), keep?, keepDays?, comment? }` ; `backup.list { serverId, destinations? }` renvoie les **manifestes** (`backupManifestSchema` : `backupId, serverId, kind, policyId?, createdAt, codec, archivePath, sizeBytes, sha256, files, bytesRaw, hot, serverName?, mcVersion?, loader?, agentVersion?, comment?`) ; `backup.restore { taskId, serverId, backupId, archivePath?, safetyBackup = true, safetyBackupId?, restartAfter = false }` ; `backup.delete { serverId, backupId, archivePath? } → { deleted }` ; `backup.rotated` (critique) `{ eventId, serverId, ts, policyId?, deleted: [{ backupId, archivePath }] }`. `server.commandHelp { serverId, name?, timeoutMs? } → { available, lines[], truncated }` (ajout du 2026-08-31, p2a) : l'agent exécute `help` en RCON et rend les lignes **brutes** — c'est le panel qui les analyse, pour que le parseur puisse être corrigé sans mettre à jour les agents du parc. `agent.configure.backupSchedules[]` = `{ id, serverId, cron, timezone?, keep?, keepDays?, onlyIfRunning, destination?, enabled }` (`timezone` ajouté le 2026-08-30, optionnel : un agent N-1 l'ignore et garde son heure locale — voir doc 04 `schedule.timezone`), `agent.configure.backupDestination` (chaîne vide = défaut agent).
>
> **Amendement (2026-08-30) — preuve d'exécution des politiques.** `backup.skipped { serverId, ts, policyId, reason, detail? }` avec `reason ∈ server_stopped | task_running | invalid_cron | start_failed`. **Non critique délibérément** : un type d'événement inconnu d'un pair est journalisé puis jeté sans acquittement (`rpc/peer.ts`) ; déclaré critique face à un panel N-1, il resterait pour toujours dans `pendingEvents` et finirait par évincer de vrais `task.completed`. Motif : les trois sorties silencieuses du planificateur d'agent (`markRun(); continue;`) ne produisaient aucune trame — côté panel, un serveur arrêté sous `onlyIfRunning` et une politique cassée étaient indiscernables. Le panel enregistre l'issue dans `backup_policies` (doc 04) sans notifier : c'est un état normal. Corrigé au passage : `markRun()` consommait l'occurrence **avant** `tasks.start`, donc un démarrage impossible la perdait sans sauvegarde ni trace ; et le signalement est non fatal, sinon une notification en échec interromprait l'évaluation des plannings suivants. Côté panel, un échec de sauvegarde **planifiée** n'était rattaché à aucune politique (la ligne de task créée à la volée n'a ni `refId` ni ligne `backups`) : le `policyId` est désormais relu dans la requête jointe à la task. Nouveau : `fs.fetch { taskId, serverId, path (jailé), url, sha256?, sha1?, size?, overwrite }` — l'agent télécharge une URL dans le dossier du serveur (« installer spark en un clic », dette phase 7).

> **Amendement (2026-09-01) — `fs.fetch` reprend au lieu de recommencer.** L'exécuteur était un `fetch` unique, sans reprise ni réessai, là où `downloadWithResume` (utilisé par `java.install`, `migration.import`, `agent.update` et `runtime.update`) vivait dans le même paquet : un mod de 300 Mo coupé à 90 % repartait de zéro. Il est désormais posé dessus. **Extension par ajout, sans bump** : `fs.fetch` accepte `sources?: [{ url, kind? }]` (jusqu'à 8, essayées APRÈS `url` — miroir ou relais du panel ; un agent N-1 les ignore et se contente de `url`), et `fsFetchResult` gagne `sha1?` (empreinte des catalogues de mods, calculée dans la même passe que le sha256 ; optionnelle, donc un agent N-1 reste valide). Les garde-fous ne bougent pas de main : le plafond de taille (doc 03 §6) devient une option `maxBytes` du téléchargeur, vérifiée sur la taille **annoncée** puis sur le flux **réel**, et `E_TOO_LARGE` rejoint les codes qui n'entraînent aucun réessai — trop gros ne devient pas plus petit. Le jail, les chemins réservés et le refus des URL non http(s) restent dans l'exécuteur, appliqués à **chaque** source. Prouvé par un test qui coupe la connexion à mi-fichier et vérifie qu'il y a bien eu deux requêtes, la seconde portant `Range: bytes=<moitié>-`.

### Java

| Type | Dir. | Description |
|---|---|---|
| `java.list` | P→A | JRE gérés + JVM système détectées |
| `java.install` | P→A | Task. Payload = **chaîne ordonnée de sources décidée par le panel** (Temurin → Zulu → x64 émulé, URLs + checksums), incluant le **mode relais** (URL servie par le panel pour les machines sans Internet sortant) |
| `java.remove` | P→A | Supprime un JRE géré inutilisé |

> **Implémentation (phase 9, sans bump — `packages/protocol/src/messages/java.ts`)** : `java.install { taskId, majorVersion, sources[] }` avec `sources[] = { vendor (temurin|zulu|system|unknown), url (absolue ou relative au panel), archive (zip|tar.gz), sha256?, size?, emulated, relay, headers?, fullVersion? }` — la chaîne est construite par le panel (`services/java-runtimes.ts` : API Adoptium `assets/latest` puis API Azul `packages/?latest=true` (+ détail `sha256_hash`), puis x64 émulé sur ARM ; un 404 = combo sauté ; fonctions pures dans `@mmo/shared` `java/providers.ts`). L'agent (`src/java/installer.ts`) essaie chaque source dans l'ordre : téléchargement avec reprise `Range` (`src/util/download.ts`), sha256, extraction (`zip.ts` maison ou tar.gz avec modes/liens symboliques, dossier racine aplati) sous `<stateDir>/java/<major>-<vendor>[-x64]/`, sonde `java -version`, puis source suivante en cas d'échec ; résultat `{ runtime, sourceIndex, vendor, emulated, failures[] }`, `E_JAVA_UNAVAILABLE` si aucune source n'aboutit. **Mode relais** : `relay: true` ⇒ le panel télécharge l'archive dans `<dataDir>/jre-cache/` et la sert par `/api/relay/<token>` (jeton 1 h). `java.remove { path }` refuse tout chemin hors du dossier géré (`E_INVALID_PAYLOAD`). L'inventaire remonte dans `sync.state.javaRuntimes` (sondé au démarrage de l'agent, en cache ensuite) → table `java_runtimes` (doc 04 §2).

### Tasks et événements fiables

| Type | Dir. | Description |
|---|---|---|
| `task.progress` | A→P (event) | `{ taskId, phase, pct, detail, etaSec }` |
| `task.completed` / `task.failed` | A→P (event) | **Persistés dans le journal local de l'agent**, rejoués jusqu'à acquittement |
| `task.ackResult` | P→A | Acquittement d'un résultat de task |
| `task.cancel` | P→A | Annulation coopérative (nettoyage des artefacts partiels) |
| `task.list` | P→A | État de toutes les tasks connues de l'agent (réconciliation au boot du panel) |
| `event.ack` | P→A | Acquittement batché des événements discrets critiques (`server.stateChanged`, `task.completed`, `watchdog.alert`, `player.event`, `backup.rotated`) — garantit que push et audit ne ratent rien |

> **Implémentation (phase 8, agent + panel)** : `task.progress { taskId, kind, serverId?, ts, phase, pct?, detail?, etaSec? }` (non critique, ≤ 2/s par task sauf changement de phase) ; `task.completed { eventId, taskId, kind, serverId?, startedAt, finishedAt, result }` et `task.failed { …, error, cancelled }` sont **critiques** : ils passent par le journal d'événements de la connexion (rejoués jusqu'à `event.ack`) — c'est ce qui synchronise un backup planifié exécuté panel éteint. `task.cancel { taskId } → { cancelled, status? }` (annulation coopérative : `AbortSignal`, artefacts partiels supprimés, `task.failed { E_CANCELLED, cancelled: true }`) ; `task.list {} → { tasks: TaskInfo[] }` (journal complet de l'agent : réconciliation au boot du panel) ; `task.ackResult { taskId }` = le panel a tout enregistré, l'agent peut oublier la task (sinon purge après 7 j). **Journal WAL de l'agent** : `apps/agent/src/tasks/journal.ts` (`tasks.json`, écrit avant chaque étape irréversible : `ctx.checkpoint()`) + `runner.ts` (`TaskRunner`) ; au boot, une task laissée `running` est interrompue — artefacts nettoyés, `task.failed { E_INTERRUPTED, retryable: true }` — la reprise par offset est portée par les transferts (§8), pas par les tasks. Côté panel (`services/tasks.ts`) : ligne `tasks` créée **avant** l'ordre, `stalled` quand l'agent tombe, réconciliation `task.list` après chaque `sync.state` (inconnue de l'agent ⇒ `E_INTERRUPTED` ; connue de l'agent seulement ⇒ créée), puis `backup.list` par serveur pour que la table `backups` reflète le disque.

> **Implémentation (phase 6, agent + panel)** : `fs.*` dans `apps/agent/src/files/` — `Jail` (`jail.ts` : chemins relatifs normalisés, `..`/racine/lettre de lecteur refusés **par le schéma** `relativePathSchema` puis par l'agent, liens symboliques sortants refusés après `realpath`), `FsService` (`fs-service.ts` : listage trié dossiers d'abord avec `.mmo-trash` masqué à la racine, `fs.delete` → `.mmo-trash/<epoch>-<nom>` + sidecar `.mmo-trash.json`, purge **7 j** au démarrage de l'agent puis toutes les 6 h, `fs.read` ≤ 512 Ko + `sha256` + `truncated`, `fs.write` atomique temp + rename avec `expectedSha256` → `E_CONFLICT`, restauration = `fs.rename` depuis la corbeille). `logs.*` (`logs.ts`) : `logs/*.log(.gz)` triés `latest.log` puis du plus récent, recherche en flux (gunzip), `limit` 500 par défaut / 5 000 max, regex invalide → `E_INVALID_PAYLOAD`, archive corrompue ignorée. Côté panel, tout est **relayé** sans stockage (`http/routes/files.ts`) : `GET/PUT /api/servers/:id/config/:file`, `GET /api/servers/:id/files?path=`, `…/files/{stat,read}`, `POST …/files/{mkdir,rename,copy,delete}`, `PUT …/files/write`, `GET …/logs`, `POST …/logs/search` ; joueurs : `POST …/players/{resolve,action}`, `GET …/players/history` (`player_sessions`). Écritures = rôle `operator`, auditées (`server.configChanged`, `server.file*`, `player.<action>`) et publiées en événements (`server.configChanged`, `server.fileChanged`, `player.action`) que le front utilise pour invalider ses caches. Les transferts binaires (`fs.download/upload`) restent au jalon C (phase 8).

> **Implémentation (phase 4, panel)** : tous les types du jalon A sont **consommés** côté panel. Événements critiques : dédup par `eventId` (table `processed_events`, doc 04 §6) puis `event.ack` **batché** (50 ms ou 50 ids) — un rejeu déjà traité est ré-acquitté sans être réappliqué. `server.detected`/`server.updated` → adoption (doc 04 §3) puis `agent.configure` (débouncé 100 ms) ; `server.removed` → `detected = 0` ; `agent.log` ≥ WARN → table `events` ; `metrics.sample` → `metrics.db` depuis la phase 7 (§6 Monitoring). Côté panel, chaque `req` vers l'agent porte l'`userId` de l'initiateur HTTP (§12). Les **codes d'erreur HTTP** propres au panel (`E_FORBIDDEN`, `E_RATE_LIMITED`, `E_SETUP_REQUIRED`, `E_SETUP_DONE`, `E_AGENT_OFFLINE`, `E_VALIDATION`) vivent dans `@mmo/protocol/client` avec le contrat panel↔front (DTO REST + messages de `/ws/client`), traduits par `errors` de `@mmo/shared`.

## 7. Sémantique des flux

Chaque canal (`console:<serverId>`, `metrics`, `agent.log`) a un `seq` monotone **persisté par l'agent** (fsync périodique ; à la perte de quelques unités au crash, c'est le panel qui déduplique). Les événements **discrets critiques** passent en plus par un journal persistant avec `event.ack`.

## 8. Transferts volumineux et migration

- Frame binaire : `[1 o version][16 o transferId][8 o offset u64 BE][données]`. Chunks 1 Mo, fenêtre glissante 8 chunks non acquittés (borne la mémoire d'un Pi), SHA-256 du fichier complet vérifié à la fin, **reprise par offset** (fichier `.part`).
- Priorité basse : heartbeats/console/métriques intercalés — un download de 5 Go ne gèle pas la console.

> **Implémentation (phase 8, jalon C — sans bump)** : frames binaires sur le **même WebSocket** que les enveloppes JSON (`RpcTransport.sendBinary/onBinary/bufferedAmount`, `packages/protocol/src/transfer/frame.ts`) ; contrôle en JSON (`messages/transfer.ts`) : `fs.download.start { transferId (16 o hex), serverId, path | backupId, offset, compression?, chunkSize? } → { size, modifiedAt?, chunkSize, compression, fileName? }`, `fs.upload.start { transferId, serverId, path, size, overwrite, compression? } → { offset (taille du `.part` existant), chunkSize, compression }`, événements **bidirectionnels** (`dir: 'both'` dans le catalogue) `fs.transfer.ack { transferId, offset }` et `fs.transfer.cancel`, requête `fs.transfer.done { transferId, size, sha256 } → { verified: true }` (le récepteur vérifie taille + SHA-256 du fichier **entier**, `E_CHECKSUM_MISMATCH` sinon). Les offsets désignent le fichier non compressé ; la compression est **par chunk** (`zstd` si négocié à `auth.hello`, `gzip` sinon, `none` possible — `@mmo/shared/node` `chunkCodec`). Moteurs partagés `TransferSender` / `TransferReceiver` (`transfer/engine.ts`, indépendants du transport) : fenêtre 8 chunks, **priorité basse** (rien n'est empilé dans le socket au-delà de 2 chunks en attente), chunks non acquittés retenus pour `detach()`/`resume(offset)`. Agent (`src/transfer/transfers.ts`) : download = fichier jailé ou archive de backup, le préfixe `[0, offset)` est haché avant l'émission pour que le sha256 final couvre tout ; upload → `<cible>.<transferId>.part`, reprise = taille du `.part`, renommage après vérification. Panel (`services/transfers.ts`) : récepteur des downloads (→ réponse HTTP en flux, contre-pression de bout en bout : l'ack suit l'écriture dans la réponse ; si la session tombe, attente de la reconnexion (60 s) puis `fs.download.start { offset }`, **invisible pour le navigateur**) et émetteur des uploads (corps `application/octet-stream` → frames, reprise par `fs.upload.start` + `resume(offset)`). Routes : `GET /api/servers/:id/files/download?path=`, `PUT /api/servers/:id/files/upload?path=&size=&overwrite=`, `GET /api/servers/:id/backups/:backupId/download`. La migration agent→agent reste hors périmètre (phase 9).
- **Migration** : contrôle par le panel, **données directes agent → agent** (HTTP one-shot sur l'IP privée de la source, token à usage unique, TTL court, reprise par Range). **Pré-checks côté cible avant transfert** : port libre, JRE présent ou installable, espace disque. Fallback : relais streaming via les deux WebSockets si le direct échoue. Rien n'est détruit côté source avant confirmation (`.migrated-<date>`, purge différée).

```
migration.export (task, source) → transfer.serve (source) → migration.import (task, cible)
→ bascule de propriété en base → migration.finalize (source)
```

> **Implémentation (phase 9, sans bump — `messages/migration.ts`, agent `src/migration/migration.ts`, panel `services/migrations.ts`)** : le panel orchestre (table `server_migrations`, statuts `pending → backing_up → transferring → restoring → verifying → done | failed`, diffusion `migration.update`). **Source** : `migration.export { taskId, serverId, migrationId, backupId, codec?, destination?, announce?, stopTimeoutSec? }` (task : arrêt propre si le serveur tourne puis backup `pre_migration` ; résultat = manifeste + `wasRunning`) ; `transfer.serve { serverId, backupId, token (32 hex fourni par le panel), ttlSec } → { urls[], size, sha256, expiresAt }` = listener HTTP **one-shot** sur chaque adresse **privée** (RFC 1918, ULA, CGNAT/Tailscale 100.64/10 ; tests : `127.0.0.1`), port éphémère, `GET /<token>` avec `Range` (206/416), fermé après un transfert complet ou à l'expiration ; `migration.finalize { serverId, migrationId, path, action: rename|keep }` : le serveur est oublié par l'agent source, le dossier renommé `<dossier>.migrated-<yyyymmdd-hhmm>` (marqueur `.mmo-server.json` retiré, motif exclu du scan par `MIGRATED_DIR`), purge différée 7 j (`store.migratedDirs`, avec la purge de la corbeille) ; sous Windows le renommage est réessayé (EPERM transitoire) puis, à défaut, le dossier est laissé en place sans marqueur. **Cible** : `migration.precheck { serverId, path, gamePort?, javaMajor?, javaStrict?, requiredBytes } → { ok, path, port, java { runtime?, installable? }, disk { freeBytes } }` (codes `path_not_empty`, `parent_missing`, `port_in_use`, `java_missing`, `disk_full`…) ; `migration.import { taskId, migrationId, config (serverConfig au nouveau chemin), manifest, sources[] { url, kind: direct|relay, headers? }, connectTimeoutMs?, startAfter }` (task : pré-check du dossier, téléchargement avec reprise `Range` depuis les sources **dans l'ordre** — directes (délai de connexion 5 s) puis relais —, vérification sha256 + taille du manifeste, extraction, marqueur, `upsertConfig`, relance optionnelle ; résultat `{ serverId, path, files, bytes, source, started }` ; dossier cible et staging nettoyés en cas d'échec/annulation). **Relais** (amendement du « relais via les deux WebSockets ») : l'URL relais est `/api/relay/<token>` servie par le panel, qui **stream l'archive depuis l'agent source par le WebSocket** (`TransferService.download`, reprise par offset) vers la cible en **HTTP avec `Range`** — même origine que le WebSocket de l'agent, donc toujours joignable si l'agent l'est ; cela réutilise la reprise `Range` de l'import sans second chemin de code. **Bascule** : `servers.machine_id/path/directory_id` mis à jour (`ServersService.moveToMachine`, ligne périmée `detected = 0` au même chemin cible supprimée), `agent.configure` poussé aux deux agents, puis `finalize`. Nouveaux codes : `E_PRECHECK_FAILED` (`details.checks`), `E_UNREACHABLE` (aucune source directe), `E_SIGNATURE_INVALID` (§9). Un redémarrage du panel pendant une migration la clôt `failed E_INTERRUPTED` (rien n'a été détruit ; le serveur reste sur la source, `provisioning` revient à `ready`). Un serveur `migrating` ne peut pas être démarré.

> **Amendement duplication (2026-09-01 — AUCUN nouveau message, agents N et N−1 compatibles)** : dupliquer un serveur réutilise `migration.export` + `transfer.serve` + `migration.precheck` + `migration.import` tels quels. L'import est appelé avec un `config.serverId` **différent** de la source : c'est supporté par construction — le marqueur cible est réécrit avec ce nouvel id par `upsertConfig`, l'archive de backup ne contient pas `.mmo-server.json`, et ni `verifyArchive` ni le relais ne lient l'archive à l'identité d'import. `startAfter` n'est jamais utilisé (le port doit changer d'abord) et `migration.finalize` n'est **pas** appelé : même son action `keep` retire le serveur des configs de l'agent source (sémantique « le dossier reste mais le serveur est parti »), ce qui casserait la source. Le nouveau `server-port` (et `query.port`) du clone est posé après import par `config.set` sur `server.properties` (serveur arrêté ⇒ édition de fichier) ; les clés `rcon.*` copiées sont réécrites par l'auto-provisionnement RCON au premier démarrage du clone. La machine cible peut être la machine source : le listener direct de `transfer.serve` et le repli relais fonctionnent en local. Côté panel : `kind = 'duplicate'` dans `server_migrations` (doc 04 §5), DTO `MigrationDto.kind`/`targetServerId`.

## 9. Mises à jour

**Modèle unique** (fait autorité, aligné doc 03 §3) : `agent.update` pousse le **bundle JS universel** — un seul artefact pour tous les OS/arch — avec `{ version, url (servie par le panel), sha256, signature Ed25519 }`. Vérification, écriture versionnée, exit 75, swap par le launcher, health-check 30 s / 2 crashs, rollback N-1 automatique. `runtime.update` : archive Node par plateforme, swap au prochain restart. Un agent trop ancien est servi par un **mini-protocole d'amorçage figé à vie** (auth + update + heartbeat) — jamais brické.

> **Implémentation (phase 9 — `messages/update.ts`, agent `src/update/`, `launcher/launcher.cjs`, panel `services/releases.ts`)** : `agent.update { version, url (relative au panel : `/api/relay/<token>`, jeton 30 min), sha256, signature (base64), size?, headers?, runtimeVersion? } → { accepted, currentVersion, alreadyCurrent }`. L'agent télécharge (reprise `Range`), vérifie sha256 **puis** la signature Ed25519 contre les clés publiques embarquées (`update/keys.ts`, SPKI DER base64 ; plusieurs clés = rotation ; clé de **développement** dont la clé privée vit dans `tools/signing/dev.private.pem` — à remplacer en phase 11 ; outils `tools/signing/keygen.mjs` et `sign.mjs`), écrit `versions/<v>/agent.js` (+ `package.json` CommonJS) et `next.json { version, previous }`, répond, puis s'arrête proprement avec le code **75**. Sans launcher (`MMO_AGENT_HOME` absent, mode dev) ⇒ `E_CONFLICT { reason: no_launcher }`. **Launcher** (~230 lignes, CommonJS, figé, ne parle pas réseau) : applique `next.json` → `trial.json` + `current.json`, lance `node versions/<cur>/agent.js` avec un canal IPC et `MMO_AGENT_HOME`/`MMO_AGENT_VERSION` ; l'agent envoie `{ type: 'healthy' }` une fois la session panel établie ; pendant un essai, pas de `healthy` sous 30 s (`MMO_LAUNCHER_HEALTH_MS`) ou **2 crashs** ⇒ **rollback** (`current.json` ← `previous`, `versions/<v>/.broken`, `update-result.json { kind, status: rolled_back, version, otherVersion, reason: health_timeout|crash_loop }`) ; `healthy` ⇒ `update-result.json { applied }`. Exit 75 ⇒ relance immédiate ; autre sortie ⇒ backoff 1 s → 60 s ; SIGINT/SIGTERM transmis à l'agent (les serveurs Java détachés survivent). L'agent relit `update-result.json` à la session suivante et émet **`agent.updateResult`** (critique : `{ eventId, ts, kind: agent|runtime, status, version, otherVersion?, reason? }`) → événement `agent.updateApplied` / `agent.updateRolledBack` + audit côté panel. `runtime.update { version, os, arch, url, sha256, archive }` → archive Node vérifiée et extraite sous `runtime/<v>/`, `runtime-next.json` ; le launcher bascule au prochain redémarrage (`runtime-current.json`, même mécanisme d'essai/rollback). `auth.hello.runtimeVersion` (ajout) alimente `machines.runtime_version`. Panel : `agent_releases` (bundle publié par `PUT /api/admin/agent-releases?version=&signature=…` corps `application/octet-stream`, stocké sous `<dataDir>/releases/`), `POST /api/machines/:id/update { version? }`, réglage `agents.autoUpdate` (mise à jour automatique à la connexion, après `sync.state` et la réconciliation). Le mini-protocole d'amorçage « figé à vie » reste à formaliser (phase 11/12) : aujourd'hui `agent.update` est un type ordinaire du catalogue.

## 10. Pannes

| Situation | Comportement |
|---|---|
| Ordre bref perdu avant exécution | Timeout panel → rejeu au retour avec le **même `id`** (dédupliqué) |
| Ordre exécuté, réponse perdue | Le rejeu tape le cache d'idempotence → réponse renvoyée |
| Task interrompue (agent tombé) | Journal write-ahead local : phase reprenable → reprise (offset) ; sinon nettoyage + `task.failed { E_INTERRUPTED, retryable: true }` |
| Serveurs pendant un crash d'agent | Survivent (détachés) ; redéclarés `detached` par `sync.state` |
| Panel éteint | Zéro impact : watchdog, plannings, backups locaux ; événements rejoués à la reconnexion |
| Pair qui ne lit plus (lot 9) | `bufferedAmount` > 1 Mio : `metrics.sample` et `console.lines` abandonnés (les suivants les remplacent), événements critiques conservés ; > 8 Mio côté panel → navigateur fermé `1013`, il se reconnecte (`rpc/backpressure.ts`, doc 03 §6) |

> **Implémentation (phase 8)** : testé de bout en bout — `apps/agent/src/agent.backup.test.ts` (backup planifié exécuté panel injoignable puis `task.completed` rejoué à la reconnexion ; download et upload coupés puis repris par offset ; task interrompue au boot → `E_INTERRUPTED`) et `apps/panel/src/integration/phase8.test.ts` (même scénario avec panel réel + table `backups` synchronisée, `stalled` → réconciliation).

## 11. Versionnement

- `v` entier négocié par plage ; bump uniquement pour rupture réelle. Ajouts de champs optionnels/types/valeurs = sans bump ; champs inconnus ignorés ; `type` inconnu → `E_UNSUPPORTED_TYPE` (jamais de déconnexion), l'UI dégrade (« nécessite agent ≥ x.y »).
- `capabilities` pour l'optionnel (`rcon`, `zstd`, `direct-transfer`, futurs : carte du monde, WoL…).
- Panel supporte N et N-1 ; tests de contrat sur fixtures des versions supportées.

> **Amendement (2026-09-01) — le contrat N/N-1 devient exécutable.** « Le panel supporte N et N-1 » était une règle écrite, invoquée par toute la feuille de route, et vérifiée par rien : les fixtures de `v1` sont maintenues **avec** les schémas, donc elles suivent chaque changement au lieu de s'y opposer. Deux références **figées** à la release s'y ajoutent (`packages/protocol/test/fixtures/n-1/`) : `messages.json`, ce qu'un pair de la version précédente envoie encore, et `vocabularies.json`, les 188 valeurs d'enum qu'il connaît (loader, runState, provisioning, codes d'erreur, types de requête et d'événement, capacités, catégories de notification…). `contract-n-1.test.ts` vérifie que les schémas courants acceptent toujours les unes, et n'ont perdu aucune des autres. **Règle** : en cas d'échec, c'est le schéma qu'on corrige (un champ ajouté est optionnel), **jamais la fixture** ; on ne refige une référence que délibérément, au moment d'une release, en recopiant l'état d'alors. Éprouvé dans les deux sens à l'écriture : retirer `loader.velocity` et rendre `fs.fetch.sources` obligatoire font tomber le test en nommant le coupable.

## 12. Sécurité

1. TLS : fourni par la couche d'accès (doc 03 §5) — requis de toute façon par la PWA.
2. **Auth applicative obligatoire même dans le tailnet** (les appareils des amis y sont ; Tailscale authentifie des machines, pas des rôles).
3. Pas de HMAC par message (canal chiffré + session authentifiée suffisent pour les menaces retenues).
4. Écoute réseau minimale : panel jamais sur `0.0.0.0` ; listener de migration one-shot, IP privée, token unique. Port RCON bloqué hors machine locale. *Phase 10* : `/ws/probe` (public, écho borné à 15 s) sert uniquement au test de joignabilité de la couche d'accès ; le listener HTTPS du mode `direct` ne se lie qu'à une adresse explicite.
5. Chemins jailés, suppression = corbeille, chaque `req` du panel porte l'`userId` initiateur (audit des deux côtés).
6. Bundles signés Ed25519 (clé privée hors panel).

## 13. Défauts

| Paramètre | Valeur |
|---|---|
| Heartbeat | 15 s (offline à 40 s) |
| Backoff reconnexion | 1 s → 60 s, jitter ±20 % |
| Ring buffer console | 5 000 lignes ou 2 Mo / serveur |
| Batch console | ≤ 50 lignes ou 100 ms |
| Métriques | **15 s** (buffer hors-ligne 1 h) |
| Timeout `server.stop` | **120 s** (gros modpacks) |
| Timeout démarrage | 10 min (configurable par serveur) |
| Chunk transfert | 1 Mo, fenêtre 8 |
| Cache d'idempotence | 10 min / 1 000 entrées |
| Code d'appairage | TTL 15 min, usage unique, 5 essais |
| Timeout requêtes de contrôle | 30 s |
| Task sans progression | 120 s → `stalled` |
| Compression | **zstd niveau 3** par défaut (spike n°3 concluant, Node ≥ 22.15), gzip garanti en repli ; capacité `zstd` annoncée dans `auth.hello` — jamais présumée |
| Support de versions | N et N-1 ; amorçage figé à vie |
