# 05 — Protocole panel ↔ agent

Version de protocole décrite : `1`. Schémas définis en Zod dans `packages/protocol` (unions discriminées) — **règle : jamais de validation `.strict()`** (la tolérance aux champs inconnus est la base de la compatibilité, à encoder en convention de lint).

## 1. Principes

- **Transport** : une connexion WebSocket persistante par agent, **toujours initiée par l'agent** (`wss://<panel>/agent/v1`). Frames texte = JSON ; frames binaires = chunks de transfert.
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

## 4. Authentification et session

`auth.hello` (agent → panel) : `agentId`, `agentSecret`, `agentVersion`, `protoMin/protoMax`, `capabilities` (`rcon`, `zstd`, `direct-transfer`…), `compression` (codecs supportés par le runtime, spike n°3 — le panel choisit et renvoie `compression` dans `auth.ok`), `resume` (tasks en attente, dernier req acquitté), `machine` (hostname, OS, arch, CPU, RAM).

`auth.ok` : version négociée (`min(panelMax, agentMax)` si compatible, sinon `E_UNSUPPORTED_VERSION` + ordre de mise à jour), `heartbeatIntervalSec`, `wantFullSync`, `subscriptions` (ré-abonnements avec `sinceSeq`).

**`sync.state`** (si `wantFullSync`) : snapshot complet de vérité terrain — serveurs et états réels, **mode d'attache** (`attached` = stdin/stdout pipés ; `detached` = process survivant à un redémarrage d'agent, pilotage RCON + tail de logfile), tasks en cours, compteurs `seq`, ports occupés, JRE installés. **Le panel réconcilie sur ce snapshot** (l'agent est la vérité sur ce qui tourne) : correction des états, clôture des sessions joueurs orphelines, relance selon `desired_state`.

## 5. Heartbeat et autonomie

- Ping/pong WS + `agent.heartbeat` (event, 15 s) : CPU/RAM/disque machine, nb serveurs actifs, tasks actives.
- Panel : agent **offline** après 40 s sans heartbeat → événement + push ; les serveurs de la machine passent à « inaccessible » (dérivé, jamais `stopped` : on ne sait pas).
- Agent sans panel : reconnexion en backoff (1 s → 60 s, jitter ±20 %), et **autonomie totale** — watchdog, backups planifiés, redémarrage des serveurs `desired_state='running'` au boot de la machine (le `desired_state` par serveur est poussé et **persisté côté agent** via `agent.configure`, politique « restaurer au boot » configurable).

## 6. Catalogue des messages

> **Implémentation (phase 2)** : le jalon A vit dans `packages/protocol` — `REQUESTS` / `EVENTS` (`src/catalog.ts`, direction + schémas Zod requête/réponse), enveloppe (`envelope.ts`), `ProtocolError` (`errors.ts`), pair RPC typé `RpcPeer` (`rpc/peer.ts` : idempotence, timeouts, `E_UNSUPPORTED_TYPE`/`E_INVALID_PAYLOAD`), négociation (`version.ts`). Tests de contrat sur `test/fixtures/v1/messages.json` (un échantillon par type, tolérance aux champs inconnus). Les types `task.*`, `backup.*`, `java.install`, `agent.update`, `runtime.update` et `fs.*transfer*` (jalons B/C) s’ajoutent au catalogue sans bump.

> **Amendement (phase 3, sans bump)** : `scan.run` est **implémenté et ajouté au catalogue** — requête `{ directoryIds?, paths? }`, réponse `{ scannedPaths, servers: detectedServerSchema[] }` (scan immédiat, en plus des `server.detected` diffusés en événements). `agent.configure` porte désormais un tableau **`servers`** (`serverConfigSchema` : `serverId`, `path`, `maxRamMb`/`minRamMb`, `loader`, `mcVersion`, `launch`, `javaMajor`/`javaStrict`/`javaPath`, `jvmArgs`, `startTimeoutSec`/`stopTimeoutSec`) : la config de lancement poussée par le panel (autorité des IDs) et **persistée côté agent** dans `agent-state.json`, indispensable pour lancer/relancer un serveur sans panel (restauration au boot, watchdog). Liste complète si présente : un serveur absent mais **arrêté** est oublié ; un serveur en marche est conservé.

### Cycle de vie agent

| Type | Dir. | Description |
|---|---|---|
| `pair.request` | A→P | Appairage initial |
| `auth.hello` / `sync.state` | A→P | Auth + snapshot |
| `agent.heartbeat` | A→P (event) | Statut léger 15 s |
| `agent.info` | P→A | Détails machine (volumes, JRE, répertoires) |
| `agent.configure` | P→A | Config poussée et persistée : répertoires surveillés, destination backups, règles watchdog, plannings de backups locaux, **`desired_state` par serveur**, intervalle métriques |
| `agent.rotateSecret` | P→A | Rotation du secret |
| `agent.update` | P→A | Mise à jour du **bundle universel** (§9) |
| `runtime.update` | P→A | Mise à jour du runtime Node (canal séparé, rare) |
| `agent.restart` | P→A | Redémarre l'agent (les serveurs détachés survivent) |
| `agent.log` | A→P (event) | Logs internes agent (≥ warn) |

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

### Console et logs

| Type | Dir. | Description |
|---|---|---|
| `console.subscribe` | P→A | `{ serverId, sinceSeq }` — abonnement + rattrapage |
| `console.unsubscribe` | P→A | Personne ne regarde → économie de bande passante |
| `console.lines` | A→P (event) | Lignes batchées (≤ 50 lignes ou 100 ms), chacune avec `seq`, `ts`, `level`, `text` |
| `logs.search` | P→A | Recherche dans les archives **exécutée par l'agent** (les logs ne quittent jamais la machine — pas d'archivage central en V1) |
| `logs.listFiles` | P→A | Liste des `logs/*.log.gz` (téléchargeables via transferts) |

Rattrapage : ring buffer agent (5 000 lignes / 2 Mo par serveur), `seq` monotone persisté. Trou trop grand → `{ truncated: true, oldestSeq }`, l'UI signale et complète via `logs.search`. Le `seq` déduplique aussi les batches reçus en double. Côté panel, les derniers `seq` consommés sont persistés périodiquement ; après un restart du panel, un `wantFullSync` peut laisser un trou visuel de console — assumé et affiché.

### Fichiers et configuration

| Type | Dir. | Description |
|---|---|---|
| `fs.list` / `fs.stat` / `fs.mkdir` / `fs.rename` / `fs.copy` | P→A | Chemins **relatifs, normalisés et jailés** aux racines autorisées (`../` refusé) |
| `fs.delete` | P→A | → corbeille `.mmo-trash/` (purge 7 j), pas de suppression directe |
| `fs.read` | P→A | Petits fichiers texte ≤ 512 Ko inline ; au-delà, le panel bascule automatiquement sur `fs.download` (cas crash-reports volumineux) |
| `fs.write` | P→A | Écriture atomique (temp + rename), `expectedSha256` optionnel → `E_CONFLICT` si édition concurrente |
| `config.get` / `config.set` | P→A | Sur-couche typée : `server.properties`, `whitelist.json`, `ops.json`, `banned-players.json`, `banned-ips.json` rendus en JSON structuré. **Routage par l'agent** : serveur en marche → commandes (`whitelist add`…), arrêté → édition de fichiers (doc 06 §7) |
| `fs.download.start` / `fs.upload.start` / `fs.transfer.ack` / `fs.transfer.done` / `fs.transfer.cancel` | bidir. | Gros fichiers (§8) |

### Monitoring

| Type | Dir. | Description |
|---|---|---|
| `metrics.configure` | P→A | Intervalle par défaut **15 s** (5 s = mode inspection temporaire, non persisté en brut) |
| `metrics.sample` | A→P (event) | Machine + par serveur : CPU, RSS, TPS/MSPT si disponibles, joueurs (buffer local 1 h hors-ligne, rejoué avec timestamps). Champ optionnel `cpuSource: 'cycles' \| 'proc' \| 'ticks'` (spike n°2) : `ticks` = valeur potentiellement sous-évaluée (Windows sans PowerShell), l'UI l'affiche avec un avertissement |
| `watchdog.alert` | A→P (event) | Crash/freeze : `{ kind, action, attempt }` — politique poussée par `agent.configure`, **exécutée localement** |
| `port.conflict` | A→P (event) | Conflit de port détecté sur la machine |

### Backups

| Type | Dir. | Description |
|---|---|---|
| `backup.create` | P→A | Task. Serveur en marche : `save-off` + `save-all flush` → copie → `save-on` (backup à chaud cohérent, via RCON si détaché) |
| `backup.list` | P→A | Archives présentes (id, taille, sha256, date) |
| `backup.restore` | P→A | Task. Stop → **backup de sécurité automatique** → restauration → redémarrage optionnel |
| `backup.delete` | P→A | Suppression (confirmation UI) |
| `backup.rotated` | A→P (event) | Suppressions faites par la **rotation locale de l'agent** — synchronise la table `backups` (événement journalisé/acquitté) |

Plannings de backups : poussés via `agent.configure`, **déclenchés localement** (un backup nocturne ne dépend pas du panel) ; résultats rejoués à la reconnexion.

### Java

| Type | Dir. | Description |
|---|---|---|
| `java.list` | P→A | JRE gérés + JVM système détectées |
| `java.install` | P→A | Task. Payload = **chaîne ordonnée de sources décidée par le panel** (Temurin → Zulu → x64 émulé, URLs + checksums), incluant le **mode relais** (URL servie par le panel pour les machines sans Internet sortant) |
| `java.remove` | P→A | Supprime un JRE géré inutilisé |

### Tasks et événements fiables

| Type | Dir. | Description |
|---|---|---|
| `task.progress` | A→P (event) | `{ taskId, phase, pct, detail, etaSec }` |
| `task.completed` / `task.failed` | A→P (event) | **Persistés dans le journal local de l'agent**, rejoués jusqu'à acquittement |
| `task.ackResult` | P→A | Acquittement d'un résultat de task |
| `task.cancel` | P→A | Annulation coopérative (nettoyage des artefacts partiels) |
| `task.list` | P→A | État de toutes les tasks connues de l'agent (réconciliation au boot du panel) |
| `event.ack` | P→A | Acquittement batché des événements discrets critiques (`server.stateChanged`, `task.completed`, `watchdog.alert`, `player.event`, `backup.rotated`) — garantit que push et audit ne ratent rien |

## 7. Sémantique des flux

Chaque canal (`console:<serverId>`, `metrics`, `agent.log`) a un `seq` monotone **persisté par l'agent** (fsync périodique ; à la perte de quelques unités au crash, c'est le panel qui déduplique). Les événements **discrets critiques** passent en plus par un journal persistant avec `event.ack`.

## 8. Transferts volumineux et migration

- Frame binaire : `[1 o version][16 o transferId][8 o offset u64 BE][données]`. Chunks 1 Mo, fenêtre glissante 8 chunks non acquittés (borne la mémoire d'un Pi), SHA-256 du fichier complet vérifié à la fin, **reprise par offset** (fichier `.part`).
- Priorité basse : heartbeats/console/métriques intercalés — un download de 5 Go ne gèle pas la console.
- **Migration** : contrôle par le panel, **données directes agent → agent** (HTTP one-shot sur l'IP privée de la source, token à usage unique, TTL court, reprise par Range). **Pré-checks côté cible avant transfert** : port libre, JRE présent ou installable, espace disque. Fallback : relais streaming via les deux WebSockets si le direct échoue. Rien n'est détruit côté source avant confirmation (`.migrated-<date>`, purge différée).

```
migration.export (task, source) → transfer.serve (source) → migration.import (task, cible)
→ bascule de propriété en base → migration.finalize (source)
```

## 9. Mises à jour

**Modèle unique** (fait autorité, aligné doc 03 §3) : `agent.update` pousse le **bundle JS universel** — un seul artefact pour tous les OS/arch — avec `{ version, url (servie par le panel), sha256, signature Ed25519 }`. Vérification, écriture versionnée, exit 75, swap par le launcher, health-check 30 s / 2 crashs, rollback N-1 automatique. `runtime.update` : archive Node par plateforme, swap au prochain restart. Un agent trop ancien est servi par un **mini-protocole d'amorçage figé à vie** (auth + update + heartbeat) — jamais brické.

## 10. Pannes

| Situation | Comportement |
|---|---|
| Ordre bref perdu avant exécution | Timeout panel → rejeu au retour avec le **même `id`** (dédupliqué) |
| Ordre exécuté, réponse perdue | Le rejeu tape le cache d'idempotence → réponse renvoyée |
| Task interrompue (agent tombé) | Journal write-ahead local : phase reprenable → reprise (offset) ; sinon nettoyage + `task.failed { E_INTERRUPTED, retryable: true }` |
| Serveurs pendant un crash d'agent | Survivent (détachés) ; redéclarés `detached` par `sync.state` |
| Panel éteint | Zéro impact : watchdog, plannings, backups locaux ; événements rejoués à la reconnexion |

## 11. Versionnement

- `v` entier négocié par plage ; bump uniquement pour rupture réelle. Ajouts de champs optionnels/types/valeurs = sans bump ; champs inconnus ignorés ; `type` inconnu → `E_UNSUPPORTED_TYPE` (jamais de déconnexion), l'UI dégrade (« nécessite agent ≥ x.y »).
- `capabilities` pour l'optionnel (`rcon`, `zstd`, `direct-transfer`, futurs : carte du monde, WoL…).
- Panel supporte N et N-1 ; tests de contrat sur fixtures des versions supportées.

## 12. Sécurité

1. TLS : fourni par la couche d'accès (doc 03 §5) — requis de toute façon par la PWA.
2. **Auth applicative obligatoire même dans le tailnet** (les appareils des amis y sont ; Tailscale authentifie des machines, pas des rôles).
3. Pas de HMAC par message (canal chiffré + session authentifiée suffisent pour les menaces retenues).
4. Écoute réseau minimale : panel jamais sur `0.0.0.0` ; listener de migration one-shot, IP privée, token unique. Port RCON bloqué hors machine locale.
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
