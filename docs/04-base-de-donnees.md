# 04 — Base de données

SQLite, deux fichiers : **`mmo.db`** (métier) et **`metrics.db`** (métriques haute fréquence — isolées car SQLite n'a qu'un écrivain par fichier). Schéma géré par migrations Drizzle commitées.

## Conventions

- Timestamps : `INTEGER` epoch **millisecondes** (suffixe `_at` / colonne `ts`) — partout, y compris dans les payloads du protocole (conversion en bordure d'UI uniquement).
- IDs métier : `TEXT` ULID (triables chronologiquement). Tables append-only volumineuses (events, audit, sessions joueurs, historique de commandes) : `INTEGER PRIMARY KEY` (rowid).
- Booléens : `INTEGER` 0/1. Structures libres : `TEXT` JSON.
- À chaque ouverture de connexion : `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;` (`foreign_keys` est **par connexion** — l'oublier désactive silencieusement les FK).

## 1. Utilisateurs, sessions, notifications

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                          -- argon2id
  role          TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('admin','operator','viewer')),
  locale        TEXT NOT NULL DEFAULT 'fr' CHECK (locale IN ('fr','en')),
  theme         TEXT NOT NULL DEFAULT 'dark',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                    -- sha256 du token du cookie
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE push_subscriptions (
  id              INTEGER PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  fail_count      INTEGER NOT NULL DEFAULT 0            -- purge des endpoints morts (410)
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);

CREATE TABLE notification_prefs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                             -- 'server.crashed', 'player.joined'…
  enabled    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type)
);
```

Extension future sans refonte : `user_server_permissions(user_id, server_id, role)` pour des droits par serveur.

> **Amendement (2026-08-31) — catégories élargies et préférence par CANAL.** Le catalogue passe de 13 à 21 catégories : la moitié des événements du bus n'avait aucune case, donc ne pouvait ni notifier ni se régler (`agent.problem` = WARN/ERROR d'un agent, `machine.paired`, `server.discovered`, `server.lifecycle`, `task.done`, `schedule.done`, `player.action`), et `resources` mélangeait disque et TPS (séparés en `resource.disk` / `resource.tps`, migration de données `0007_notification_categories` — un « non » déjà exprimé ne doit pas se rallumer tout seul). Nouvelle table `notification_channel_prefs (user_id, channel, event_type, enabled)`, PK composite, migration `0008_notification_channels` : `channel ∈ inapp | push`. **Chaîne de repli** : ligne du canal → ligne `notification_prefs` (ancien réglage commun, conservé en lecture seule) → `NOTIFICATION_DEFAULTS`. Aucune préférence n'est perdue et aucune reprise n'est nécessaire. Motif : couper une catégorie la retirait AUSSI de la cloche in-app — suivre les arrivées de joueurs dans le panel imposait de se faire réveiller par le téléphone. Pas de `CHECK` sur `channel` (une contrainte ajoutée ferait recréer la table) : la validation vit dans Zod, et une valeur inconnue est ignorée à la lecture.

> **Implémentation (phase 10)** — amendements : `users` gagne `notifications_seen_id INTEGER NOT NULL DEFAULT 0` (curseur « vu » du centre de notifications = dernier `events.id` lu) ; `push_subscriptions` gagne `user_agent TEXT` (diagnostic) et `last_seen_at INTEGER` (dernière re-synchronisation par le front), `fail_count` est remis à 0 à chaque succès et l'abonnement est supprimé sur 404/410 ou au 8ᵉ échec consécutif ; un `endpoint` qui se ré-abonne sous un autre compte suit ce compte (upsert). `notification_prefs.event_type` contient une **catégorie** (`NOTIFICATION_TYPES` du protocole client : `server.crashed`, `server.startFailed`, `watchdog.alert`, `agent.offline`, `task.failed`, `backup.failed`, `migration`, `agent.update`, `schedule.failed`, `port.conflict`, `server.state`, `player.activity`), pas un type brut d'événement ; absence de ligne = défaut de la catégorie (toutes activées sauf `server.state` et `player.activity`). Migration `0003_phase10`.

## 2. Machines, appairage, agent, répertoires, Java

```sql
CREATE TABLE machines (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  os               TEXT CHECK (os IN ('windows','linux','macos')),
  arch             TEXT CHECK (arch IN ('x64','arm64')),
  hostname         TEXT,
  agent_version    TEXT,
  protocol_version INTEGER,
  agent_token_hash TEXT,                                -- sha256 du secret d'agent
  agent_token_prev_hash  TEXT,                          -- rotation (doc 05 §3) : ancien hash encore
  agent_token_prev_until INTEGER,                       --   accepté jusqu'à cette date (24 h) — phase 4
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','online','offline','disabled')),
  last_seen_at     INTEGER,
  cpu_model        TEXT,
  cpu_cores        INTEGER,
  ram_total_mb     INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE TABLE pairing_codes (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,                      -- jamais le code en clair
  attempts   INTEGER NOT NULL DEFAULT 0,                -- max 5, rate-limit sur l'endpoint
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                          -- TTL 15 min
  used_at    INTEGER,
  machine_id TEXT REFERENCES machines(id) ON DELETE CASCADE  -- voir note phase 4
);
```

> **Implémentation (phase 4)** : la machine est créée **`pending` avec son nom** par l'admin (« Ajouter machine ») et `pairing_codes.machine_id` est renseigné **dès la création du code** (un code = une machine) ; `used_at` est posé à l'usage et la machine passe `offline` (l'agent se reconnecte avec `auth.hello`). Un nouveau code invalide les codes non utilisés de la même machine. Un code inconnu ne pouvant être attribué, chaque tentative ratée incrémente `attempts` de **tous** les codes actifs : 5 échecs brûlent les codes en attente (l'admin en régénère un). Le code en clair n'est retourné qu'une fois, dans la réponse de création.

```sql
-- Bundle agent UNIVERSEL (identique tous OS/arch) — voir doc 03 §3.
CREATE TABLE agent_releases (
  version          TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'stable',
  released_at      INTEGER NOT NULL,
  bundle_path      TEXT NOT NULL,
  bundle_sha256    TEXT NOT NULL,
  bundle_signature TEXT NOT NULL,                       -- Ed25519
  bundle_size      INTEGER NOT NULL,
  runtime_version  TEXT,                                -- version Node recommandée (canal runtime séparé)
  notes            TEXT
);

CREATE TABLE watched_directories (
  id           TEXT PRIMARY KEY,
  machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER,
  UNIQUE (machine_id, path)
);

CREATE TABLE java_runtimes (
  id            TEXT PRIMARY KEY,
  machine_id    TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  major_version INTEGER NOT NULL,                       -- 8, 17, 21…
  full_version  TEXT,
  vendor        TEXT,                                   -- 'temurin' | 'zulu' | 'system'
  path          TEXT NOT NULL,
  managed       INTEGER NOT NULL DEFAULT 1,
  installed_at  INTEGER NOT NULL,
  UNIQUE (machine_id, path)
);
CREATE INDEX idx_java_machine ON java_runtimes(machine_id, major_version);
```

> **Implémentation (phase 10)** — amendements : `machines` gagne `addresses TEXT` (JSON `{ tailnet: string[], global: string[] }` remonté par l'agent à l'appairage et à chaque `auth.hello`, doc 05 §3), `tailnet_host TEXT` et `public_host TEXT` (surcharges manuelles de « l'adresse à donner aux amis », `PATCH /api/machines/:id`). Migration `0003_phase10`.

> **Implémentation (phase 9)** — amendements : `machines` gagne `runtime_version TEXT` (`auth.hello.runtimeVersion`) ; `java_runtimes` est alimentée par `sync.state.javaRuntimes` / `java.list` (`JavaRuntimesService.sync` : lignes identifiées par `(machine_id, path)`, disparues ⇒ supprimées) et par `java.install` ; `agent_releases` est alimentée par la publication admin (`bundle_path` = `<dataDir>/releases/agent-<version>.js`, sha256 et taille calculés par le panel, signature fournie). Migration `0002_phase9`.

## 3. Serveurs Minecraft

**Autorité des identifiants** : `servers.id` est attribué **par le panel**. L'agent dépose un marqueur `.mmo-server.json` dans le dossier ; si un marqueur déjà connu réapparaît sur un autre chemin ou une autre machine (backup restauré, dossier copié), le panel traite un **conflit explicite** (UI : « copie ? migration ? ») et fait réécrire un nouvel ID si c'est une copie. Cas couvert par un test dédié.

> **Implémentation (phase 4)** : tout serveur détecté dans un répertoire surveillé (ou ajouté manuellement via `POST /api/servers`) est **adopté automatiquement** : ligne `servers` créée avec un ULID du panel, `provisioning = ready` (`installing` si `needsInstall`), `java_major_required` résolu (manifest Mojang → table), puis `agent.configure.servers` poussé à l'agent qui écrit le marqueur. Si le marqueur porte un ID **inconnu** du panel (base restaurée), cet ID est **conservé**. Si le marqueur porte un ID **connu ailleurs** (autre chemin/machine) → **conflit** en mémoire (événement `server.conflict`, `GET /api/servers/conflicts`), résolu par `POST /api/servers/conflicts/resolve` : `copy` (nouveau serveur, nouvel ID réécrit dans le marqueur), `migrate` (l'ID suit le dossier, refusé si le serveur tourne), `ignore` (réapparaît au prochain scan). Un marqueur différent dans un dossier déjà connu (même chemin) n'est pas un conflit : l'ID du panel prime et l'agent réécrit le marqueur (événement `server.markerMismatch`). Dossier disparu (`server.removed`) → `detected = 0`, la ligne est conservée.

```sql
CREATE TABLE servers (
  id                  TEXT PRIMARY KEY,
  machine_id          TEXT NOT NULL REFERENCES machines(id),
  directory_id        TEXT REFERENCES watched_directories(id) ON DELETE SET NULL,
  path                TEXT NOT NULL,
  name                TEXT NOT NULL,
  loader              TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (loader IN ('vanilla','forge','neoforge','fabric','unknown')),
  mc_version          TEXT,
  loader_version      TEXT,
  detected            INTEGER NOT NULL DEFAULT 0,
  java_runtime_id     TEXT REFERENCES java_runtimes(id) ON DELETE SET NULL,
  java_major_required INTEGER,                          -- déduit, surchargeable
  java_args           TEXT,
  min_ram_mb          INTEGER NOT NULL DEFAULT 1024,
  max_ram_mb          INTEGER NOT NULL DEFAULT 4096,    -- garde-fou vérifié avant lancement
  game_port           INTEGER,
  rcon_enabled        INTEGER NOT NULL DEFAULT 1,       -- auto-provisionné (doc 03)
  rcon_port           INTEGER,
  rcon_password_enc   TEXT,                             -- chiffré (clé dans la config, pas en base)
  eula_accepted       INTEGER NOT NULL DEFAULT 0,
  expose_mode         TEXT NOT NULL DEFAULT 'tailnet'
                      CHECK (expose_mode IN ('tailnet','direct')),  -- adresse à donner aux joueurs
  provisioning        TEXT NOT NULL DEFAULT 'installing'
                      CHECK (provisioning IN ('installing','install_failed','ready',
                                              'archived','migrating')),
  run_state           TEXT NOT NULL DEFAULT 'stopped'
                      CHECK (run_state IN ('stopped','starting','running','stopping','crashed')),
  desired_state       TEXT NOT NULL DEFAULT 'stopped'
                      CHECK (desired_state IN ('stopped','running')),
  attach_mode         TEXT NOT NULL DEFAULT 'attached'
                      CHECK (attach_mode IN ('attached','detached')), -- detached = stdin perdu, pilotage RCON
  last_exit_reason    TEXT,                             -- 'stop' | 'kill' | 'crash' | 'freeze_kill'
  auto_restart        INTEGER NOT NULL DEFAULT 0,
  crash_loop_max      INTEGER NOT NULL DEFAULT 3,
  watchdog_freeze_s   INTEGER NOT NULL DEFAULT 120,
  pid                 INTEGER,
  started_at          INTEGER,
  stopped_at          INTEGER,
  detection_json      TEXT,                             -- dernière sortie de detectServer() (phase 4)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (machine_id, path)
);
CREATE INDEX idx_servers_machine ON servers(machine_id);
CREATE INDEX idx_servers_run     ON servers(run_state);
CREATE INDEX idx_servers_ports   ON servers(machine_id, game_port);
```

**Machines à états** (deux axes indépendants) :

- `provisioning` : `installing → ready` | `install_failed` (reprenable) ; `ready ↔ archived` ; `ready → migrating → ready` (échec → retour source).
- `run_state` : `stopped → starting → running → stopping → stopped` ; `starting|running → crashed` (exit non demandé, timeout de démarrage, freeze tué) ; kill manuel → `stopped` avec `last_exit_reason='kill'` ; `crashed → starting` (auto-restart borné par `crash_loop_max`, ou relance manuelle) ; `crashed → stopped` (acquittement).
- Restart = `running → stopping → stopped → starting`, orchestré avec `desired_state='running'` maintenu.
- Agent hors ligne : « inaccessible » est **dérivé** de `machines.status`, jamais stocké dans `run_state`.
- **Ports** : pas d'UNIQUE sur `(machine_id, game_port)` — deux serveurs arrêtés peuvent déclarer le même port. Conflit détecté applicativement au lancement (parmi `starting`/`running` de la machine, ports game + RCON) et en avertissement à l'édition.

```sql
CREATE TABLE command_history (
  id        INTEGER PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  command   TEXT NOT NULL,
  via       TEXT NOT NULL DEFAULT 'stdin' CHECK (via IN ('stdin','rcon')),
  ts        INTEGER NOT NULL
);
CREATE INDEX idx_cmdhist ON command_history(server_id, user_id, ts DESC);

-- Index de navigation ; les fichiers restent sur la machine de l'agent,
-- la recherche plein texte est exécutée PAR L'AGENT en streaming (pas de FTS central).
CREATE TABLE server_log_files (
  id         INTEGER PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  file_name  TEXT NOT NULL,
  size_bytes INTEGER,
  first_ts   INTEGER,
  last_ts    INTEGER,
  UNIQUE (server_id, file_name)
);
```

## 4. Joueurs

Whitelist/ops/bans ne sont **pas dupliqués en base** : les fichiers JSON du serveur restent la source de vérité (édités via l'agent, tracés dans l'audit).

```sql
CREATE TABLE players (
  uuid          TEXT PRIMARY KEY,                       -- identité = UUID (name = cache d'affichage)
  last_name     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE player_sessions (
  id          INTEGER PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player_uuid TEXT NOT NULL REFERENCES players(uuid),
  player_name TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  left_at     INTEGER                                    -- NULL = en ligne
);
CREATE INDEX idx_psess_server ON player_sessions(server_id, joined_at DESC);
CREATE INDEX idx_psess_player ON player_sessions(player_uuid, joined_at DESC);
CREATE INDEX idx_psess_online ON player_sessions(server_id) WHERE left_at IS NULL;
```

**Règle de clôture** : sur `run_state → stopped|crashed` et à chaque réconciliation `sync.state`, toutes les sessions ouvertes du serveur sont clôturées (`left_at = ts` de l'événement) — sinon la liste « en ligne » ment après un crash.

> **Implémentation (phase 6)** : `GET /api/servers/:id/players/history?limit=` expose `player_sessions` (du plus récent au plus ancien, `leftAt` null = en ligne) ; les joueurs sans UUID connu (logs sans ligne `UUID of player`) sont stockés sous `offline:<nom>` dans `players.uuid` et rendus `playerUuid: null`. Whitelist/ops/bans ne sont **toujours pas** dupliqués en base : `GET /api/servers/:id/config/<fichier>` relit les fichiers via l'agent à chaque affichage (cache front invalidé par les événements `player.action` / `server.configChanged`).

## 5. Backups, planificateur, tasks, migrations

Partition d'exécution (voir doc 05) : **backups planifiés, rotation et watchdog = exécutés par l'agent** (survivent à un panel éteint) ; **start/stop/restart programmés et annonces = exécutés par le panel**. Les suppressions faites par la rotation locale remontent via l'événement `backup.rotated` pour que cette table ne diverge jamais du disque.

**Politique par défaut (post-1.0, recette)** : chaque serveur créé (détection, ajout manuel, copie de conflit) reçoit une politique `0 4 * * *`, `keep_last 7`, `only_if_running 1` (un serveur arrêté ne change pas — pas d'archives dupliquées) — politique ordinaire, modifiable/supprimable. Rattrapage unique au démarrage du panel pour les serveurs existants sans politique (`app_settings backups.defaultsSeeded='1'` — supprimer sa politique reste définitif).

```sql
CREATE TABLE backup_policies (
  id              TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  cron            TEXT NOT NULL,
  destination     TEXT,                                 -- NULL = défaut (app_settings)
  keep_last       INTEGER,
  keep_days       INTEGER,
  only_if_running INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  -- Preuve d'exécution (migration 0005, 2026-08-30). Sans ces colonnes, le DTO ne montrait qu'un
  -- `nextRunAt` recalculé à chaque affichage : une politique morte s'affichait exactement comme
  -- une politique saine. Nullable : NULL = jamais tourné, c'est un état à part entière.
  -- Pas de CHECK sur last_status : une contrainte ajoutée imposerait une reconstruction de table.
  last_run_at     INTEGER,
  last_status     TEXT,                                 -- success | failed | skipped
  last_backup_id  TEXT,
  last_error      TEXT,                                 -- message d'échec, ou raison du skip
  overdue_since   INTEGER                               -- NULL = à l'heure ; posé une seule fois
);
CREATE INDEX idx_bpol_server ON backup_policies(server_id);

CREATE TABLE backups (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  policy_id    TEXT REFERENCES backup_policies(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('manual','scheduled','pre_migration','pre_restore')),
  status       TEXT NOT NULL CHECK (status IN ('running','success','failed','deleted')),
  machine_id   TEXT NOT NULL REFERENCES machines(id),   -- où réside l'archive
  archive_path TEXT,
  size_bytes   INTEGER,
  sha256       TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  error        TEXT,
  created_by   TEXT REFERENCES users(id)
);
CREATE INDEX idx_backups_server ON backups(server_id, started_at DESC);

CREATE TABLE scheduled_tasks (
  id          TEXT PRIMARY KEY,
  server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('start','stop','restart','backup','command','announce')),
  cron        TEXT NOT NULL,                            -- 1..10 expressions (une par ligne) ; '' si run_at
  run_at      INTEGER,                                  -- exécution unique (epoch ms) ; NULL si récurrente
  payload     TEXT,                                     -- JSON, ex. annonces avant stop
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_status TEXT,
  next_run_at INTEGER,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_tasks_next ON scheduled_tasks(enabled, next_run_at);

-- Opérations longues du protocole (backup, restore, migration, scan, java.install, update).
-- Permet au panel de survivre à son propre redémarrage : réconciliation via task.list.
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,                         -- taskId du protocole
  kind        TEXT NOT NULL,
  machine_id  TEXT REFERENCES machines(id),
  server_id   TEXT REFERENCES servers(id),
  status      TEXT NOT NULL CHECK (status IN ('pending','running','stalled','done','failed','cancelled')),
  progress    REAL,
  payload     TEXT,                                     -- JSON
  ref_id      TEXT,                                     -- ex. backups.id, server_migrations.id
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  error       TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status, created_at DESC);

CREATE TABLE server_migrations (
  id              TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  from_machine_id TEXT NOT NULL REFERENCES machines(id),
  to_machine_id   TEXT NOT NULL REFERENCES machines(id),
  to_directory_id TEXT REFERENCES watched_directories(id),
  backup_id       TEXT REFERENCES backups(id),
  status          TEXT NOT NULL CHECK (status IN ('pending','backing_up','transferring',
                                     'restoring','verifying','done','failed','rolled_back')),
  progress_pct    REAL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  error           TEXT,
  created_by      TEXT REFERENCES users(id)
);
CREATE INDEX idx_migr_server ON server_migrations(server_id, started_at DESC);
```

> **Implémentation (phase 9)** — amendement : `server_migrations` gagne `source_path` (chemin d'origine, puis chemin renommé `.migrated-<date>` après finalisation), `to_path`, `mode` (`direct` | `relay`, connu à la fin de l'import), `export_task_id`, `import_task_id` (lignes `tasks` avec `ref_id` = id de la migration), `restart_after`. `backup_id` = backup `pre_migration` créé sur la source (ligne `backups` créée avant l'ordre, manifeste appliqué par `task.completed` de genre `migration.export`). `status` : `rolled_back` n'est pas utilisé (un échec avant la bascule laisse simplement le serveur sur la source) ; au démarrage du panel, toute migration active est close `failed E_INTERRUPTED`. `servers.provisioning = 'migrating'` pendant l'opération (démarrage refusé). Service : `apps/panel/src/services/migrations.ts`.

> **Amendement duplication (2026-09-01, migration `0010_server_duplication`)** — `server_migrations` gagne `kind` (`migrate` | `duplicate`, défaut `migrate`) et `target_server_id` (`REFERENCES servers(id) ON DELETE SET NULL`). Une duplication réutilise la chaîne de migration (export `pre_migration` → transfert direct/relais → import) mais l'import se fait sous un **nouvel** id serveur (`target_server_id`) et `migration.finalize` n'est **jamais** appelé — la source reste enregistrée sur son agent ; la cible peut être la machine source. La ligne du clone (`servers`) est insérée **avant** l'import (`provisioning = 'migrating'`, `detected = 0`, réglages copiés de la source, RCON non copié, runtime Java re-résolu) : un scan concurrent qui découvre le dossier en cours d'extraction retombe dessus par `findByPath` au lieu d'adopter un doublon. À la fin elle est confirmée (`ready`, `detected = 1`, `stopped`) avec un `game_port` **libre** choisi par le panel (premier port ≥ celui de la source hors ports connus de la machine et hors plage RCON agent 25575–25675, disponibilité OS vérifiée par `migration.precheck` ; surchargeable dans la requête) et écrit dans `server.properties` via `config.set` ; le RCON copié est réattribué par l'agent au premier démarrage du clone. Échec **avant** import réussi → ligne du clone supprimée ; **après** → clone conservé `ready` avec le port de la source (l'erreur de la duplication le dit). La source, arrêtée par l'export, est **relancée** si elle tournait — succès comme échec. Au redémarrage du panel, duplication active close `failed E_INTERRUPTED` + ligne de clone jamais confirmée supprimée (un dossier importé complet sera ré-adopté par son marqueur au scan suivant). Événements `migration.done`/`migration.failed` avec `payload.kind = 'duplicate'` (libellés de notification dédiés `duplicationDone`/`duplicationFailed`, catégorie « migration » inchangée). Routes : `POST /api/servers/:id/duplicate` (admin) et `/duplicate/precheck` (operator).

> **Implémentation (phase 8)** — amendement : `backups` gagne `manifest_json TEXT` (codec, `hot`, `files`, `bytesRaw`, commentaire — le manifeste déposé par l'agent à côté de l'archive) et `task_id TEXT` (task de création ou de restauration) ; migration `0001_phase8_backups`. La table reflète le disque : alimentée par `task.completed` (`backup.create` → ligne `success` ; `backup.restore` → le backup de sécurité `pre_restore`), par `backup.rotated` (→ `deleted`) et par `backup.list` à chaque reconnexion (archives inconnues insérées — backup planifié exécuté panel éteint —, lignes `success` sans archive → `deleted`). Une ligne `running` est créée **avant** l'ordre à l'agent (comme la ligne `tasks`). `backup_policies` = plannings poussés à l'agent (`agent.configure.backupSchedules`) : `keep_last`/`keep_days` → rotation locale, `destination` NULL → réglage `backups.defaultDestination` → défaut agent (`<stateDir>/backups/<serverId>/`). `scheduled_tasks` = actions **exécutées par le panel** (`start`/`stop`/`restart`/`command`/`announce` ; `backup` inutilisé, les backups planifiés passent par `backup_policies`) : `payload` JSON `{ command?, message?, warnMinutes?, timeoutSec? }`, `next_run_at` recalculé après chaque exécution (heure locale du panel, occurrence manquée non rattrapée), `last_status` = `ok` ou code d'erreur, événement `schedule.run` + audit à chaque exécution.

> **Amendement Planificateur v2 (2026-08-24, migration `0004_scheduler_v2`)** — une tâche planifiée est **récurrente** ou **unique**, exclusivement : (1) récurrente : `cron` = 1 à 10 expressions à 5 champs, **une par ligne** (multi-horaires : « tous les jours à 8h00, 12h30 et 20h00 » = trois lignes), prochaine échéance = minimum des expressions (`nextCronRunList` de `@mmo/shared`) ; (2) unique : `run_at` (epoch ms, heure du panel), `cron` stocké `''` (colonne NOT NULL conservée, le DTO expose `cron: null`). Après son exécution, une tâche unique passe `enabled = 0`, `next_run_at = NULL` et reste listée (`last_status` conservé) ; si le panel était éteint à l'échéance et la découvre avec **plus de 10 min de retard**, elle n'est **pas** exécutée : `last_status = 'missed'`, définitif (un re-tick ne change rien), événement `schedule.run` severity `warning` (→ notification `schedule.failed`) + audit. À l'update, fournir `runAt` **réarme** la tâche (et la réactive sauf `enabled: false` explicite) ; `cron` et `runAt` sont mutuellement exclusifs dans `ScheduledTaskInput` ; un `runAt` nouvellement fourni doit être futur ; un `run_at` passé ne se réarme jamais tout seul (réactivation sans nouveau `runAt` → `next_run_at` reste NULL). Les `backup_policies` ne sont **pas** concernées : cron simple (une expression), analysé par l'agent — pas d'évolution de protocole agent. `tasks` : `payload` JSON `{ request, result }`, `progress` 0–100, phase/détail en mémoire seulement (diffusés par `task.update`), statut `stalled` posé à la déconnexion de l'agent et au démarrage du panel, purge des tasks terminées > 30 j. Services : `apps/panel/src/services/{tasks,backups,scheduler}.ts`.

## 6. Événements, audit, réglages

```sql
-- Bus d'événements persistant ; rowid = curseur de reprise des consommateurs
-- (push, UI temps réel, webhooks futurs). Sans FK volontairement : un événement
-- survit à la suppression de sa cible. Purge configurable (défaut 90 j).
-- Alertes à ÉTAT (2026-08-30). Le bus d'événements est append-only et ponctuel : il ne sait pas
-- dire « c'est toujours en cours » ni « c'est rentré dans l'ordre ». Une ligne par (règle, portée),
-- mise à jour en place, ce qui donne l'hystérésis, le rappel espacé, le regroupement par
-- dépendance et la notification de retour à la normale.
CREATE TABLE alerts (
  id             TEXT PRIMARY KEY,
  rule           TEXT NOT NULL,                         -- machine.offline | server.down | disk.low | tps.low
  scope_type     TEXT NOT NULL,                         -- machine | server
  scope_id       TEXT NOT NULL,
  state          TEXT NOT NULL,                         -- firing | resolved
  first_fired_at INTEGER NOT NULL,
  last_fired_at  INTEGER NOT NULL,
  resolved_at    INTEGER,
  notified_at    INTEGER,                               -- NULL = jamais notifiée (alerte masquée)
  detail         TEXT
);
CREATE UNIQUE INDEX idx_alerts_rule_scope ON alerts(rule, scope_id);
CREATE INDEX idx_alerts_state ON alerts(state);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,        -- 'server.started','server.crashed','player.joined',
                                   -- 'backup.failed','backup.rotated','agent.offline',…
  severity   TEXT NOT NULL DEFAULT 'info'
             CHECK (severity IN ('debug','info','warning','error','critical')),
  machine_id TEXT,
  server_id  TEXT,
  user_id    TEXT,
  payload    TEXT
);
CREATE INDEX idx_events_ts     ON events(ts);
CREATE INDEX idx_events_server ON events(server_id, ts);
CREATE INDEX idx_events_type   ON events(type, ts);

-- Audit des actions humaines et système ; username dénormalisé (survit à la
-- suppression du compte) ; details = diff JSON. Rétention ≥ 1 an.
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  user_id      TEXT,                                    -- NULL = système
  username     TEXT,
  action       TEXT NOT NULL,       -- 'server.start','file.edit','whitelist.add',…
  target_type  TEXT,
  target_id    TEXT,
  target_label TEXT,
  details      TEXT,
  ip           TEXT
);
CREATE INDEX idx_audit_ts   ON audit_log(ts);
CREATE INDEX idx_audit_user ON audit_log(user_id, ts);

-- Réglages clé/valeur (VAPID, destination backups par défaut, rétentions,
-- mode d'accès, domaine/API DNS du mode direct…). La clé de chiffrement de
-- rcon_password_enc vit dans la config/env, PAS en base (et sa perte n'est pas
-- critique : les mots de passe RCON sont relisibles depuis server.properties).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Macros de console (2026-08-31) : séquences de commandes enregistrées, jouées d'un clic.
-- `server_id` NULL = disponible sur tous les serveurs (le cas normal). Migration 0009.
CREATE TABLE console_macros (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  commands   TEXT NOT NULL,        -- une commande par ligne, exécutées dans l'ordre
  server_id  TEXT REFERENCES servers(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_console_macros_server ON console_macros(server_id);
```

**Amendement (2026-08-30) — `schedule.timezone`.** Nom IANA (`Europe/Paris`) dans lequel **toutes** les planifications sont lues : politiques de sauvegarde et actions programmées. Absent ⇒ fuseau de l'hôte du panel ; valeur devenue invalide ⇒ même repli (un réglage bricolé ne doit pas figer le planificateur). Le panel l'applique à `nextCronRun`/`nextCronRunList`, le pousse à l'agent avec chaque politique (`agent.configure.backupSchedules[].timezone`) et l'expose à tout utilisateur connecté par `GET /api/auth/me` — la route des réglages étant réservée aux administrateurs, alors que n'importe qui saisissant une heure a besoin de savoir dans quel fuseau elle sera lue. Motif : les expressions cron étaient évaluées dans le fuseau du **processus** (agent pour les sauvegardes, panel pour les actions, navigateur pour l'aperçu) ; un agent Linux en UTC faisait partir à 6 h une sauvegarde réglée sur 4 h par un utilisateur à Paris, sans que rien ne le signale.

```sql
-- Événements critiques d'agent déjà traités (eventId de server.stateChanged, player.event,
-- server.detected…) : l'agent rejoue jusqu'à event.ack ; si le panel redémarre entre le traitement
-- et l'ack, le rejeu est reconnu ici et seulement ré-acquitté. Purge > 24 h. (phase 4)
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  ts       INTEGER NOT NULL
);
CREATE INDEX idx_processed_ts ON processed_events(ts);
```

Les migrations de schéma sont gérées par drizzle-kit (table interne `__drizzle_migrations`). **Implémentation (phase 4)** : schéma Drizzle dans `apps/panel/src/db/schema.ts` (+ `schema-metrics.ts`), migrations SQL commitées dans `apps/panel/drizzle/{mmo,metrics}` (`pnpm db:generate`, `db:generate:metrics`), rejouées à chaque ouverture. Deux détails que drizzle-kit ne modélise pas sont **posés à la main dans le SQL généré** (à reporter lors des prochaines générations) : `users.username … COLLATE NOCASE` et `WITHOUT ROWID` sur les tables de `metrics.db`.

## 7. `metrics.db` — métriques CPU/RAM/TPS

Échantillonnage **15 s** (5 s réservé à un mode « inspection » temporaire, non persisté en brut). Envoi par lots par les agents (buffer local 1 h en cas de coupure, rejoué avec timestamps), écriture par transactions groupées — jamais un INSERT par échantillon. `PRAGMA auto_vacuum=INCREMENTAL`, **posé avant `journal_mode=WAL`** : le passage en WAL initialise l'en-tête du fichier et fige `auto_vacuum` (mesuré : 0 dans l'ordre inverse, même sur une base sans aucune table). Sur une base déjà créée, seul un `VACUUM` complet bascule le mode.

| Niveau | Résolution | Rétention | Volume estimé (~56 serveurs) |
|---|---|---|---|
| brut | 15 s | 48 h | ~650 k lignes |
| 1 min | 60 s | 14 j | ~1,1 M lignes |
| 1 h | 3600 s | 2 ans | ~1 M lignes |

Job horaire : agrégation brut→1min→1h (min/max/avg), DELETE des tranches expirées, `incremental_vacuum` occasionnel. À < 3 M lignes au régime permanent, SQLite est très à l'aise.

```sql
CREATE TABLE metrics_server_raw (
  server_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  cpu_pct   REAL, ram_mb INTEGER, tps REAL, mspt REAL, players INTEGER,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;

CREATE TABLE metrics_machine_raw (
  machine_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  cpu_pct     REAL, ram_used_mb INTEGER, disk_used_gb REAL, disk_total_gb REAL,
  PRIMARY KEY (machine_id, ts)
) WITHOUT ROWID;

CREATE TABLE metrics_server_1m (
  server_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL,                          -- début de tranche
  cpu_avg REAL, cpu_max REAL,
  ram_avg INTEGER, ram_max INTEGER,
  tps_avg REAL, tps_min REAL,
  players_max INTEGER,
  samples INTEGER NOT NULL,
  PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;
-- metrics_server_1h : DDL identique. metrics_machine_1m / _1h : agrégats machine.
```

`tps`/`mspt` sont NULL quand non mesurables (voir doc 06 §TPS). L'**uptime** se calcule depuis `events`, pas depuis les métriques.

**Parcours UI (post-1.0, recette)** : table `ui_events` dans `metrics.db` (volumineuse et reconstituable → jamais dans `mmo.db`, exclue de la sauvegarde du panel) — `id` auto, `ts`, `user_id`/`username` (résolus côté serveur depuis la session), `kind` (`click`/`nav`), `page` (pathname seul, **jamais de query string**), `target` (`data-testid`, `aria-label` ou texte du bouton, jamais de contenu de champ) ; index sur `ts`. Le front (`apps/web/src/lib/ui-telemetry.ts`, installé par `main.tsx`) capture clics et navigations et poste par lots (5 s ou 25 événements, `sendBeacon` à la fermeture) sur `POST /api/ui-events` (session requise) ; lecture `GET /api/ui-events` (admin). Purge par la maintenance horaire : `retention.uiEventsDays` (défaut 14 j, éditable). But : diagnostic/maintenance (rejouer le parcours d'un utilisateur avant un écart).

> **Implémentation (phase 7, `apps/panel/src/services/metrics.ts`)** : `MetricsService` — `ingest()` empile les `metrics.sample` (les `serverId` inconnus du panel sont filtrés) et écrit **par lots** (5 s ou 200 échantillons) dans une transaction `INSERT OR REPLACE` (un rejeu au même `ts` remplace, jamais de doublon) ; l'état « maintenant » (dernier échantillon, `tpsSource`, `cpuSource`) est gardé en mémoire et oublié à la déconnexion de l'agent. `maintain()` (appelé par la maintenance horaire) agrège les tranches **complètes** brut → 1 min (`AVG/MAX`, `MIN(tps)`, `MAX(players)`, `COUNT`) puis 1 min → 1 h (**moyennes pondérées par `samples`**, extrema, somme des échantillons), en reprenant depuis la dernière tranche agrégée — **ou plus tôt si des échantillons plus anciens ont été ingérés depuis** (rejeu du tampon agent 1 h) ; puis purge (brut 48 h, 1 min 14 j, 1 h 2 ans) et `incremental_vacuum(200)` au plus une fois par jour, checkpoint WAL passif de `metrics.db`. **Rattrapage (2026-08-30)** : les bases créées avant le correctif d'ordre des PRAGMA ont `auto_vacuum=0`, donc `incremental_vacuum` n'y a jamais rien rendu au système de fichiers ; `maintain()` le détecte et lance **un** `VACUUM` complet, au plus une fois par démarrage du panel (la durée est journalisée, `metrics database compacted`). Idempotent (`INSERT OR REPLACE`). Lectures : `GET /api/servers/:id/metrics` et `GET /api/machines/:id/metrics` (`from`, `to?`, `resolution?`) — résolution automatique **brut ≤ 3 h, 1 min ≤ 3 j, sinon 1 h** ; points normalisés (`cpu/ram/tps/players` + `cpuMax/ramMax/tpsMin/samples` en agrégé) + `latest`. Suppression d'un serveur ⇒ ses trois tables sont nettoyées. Le critère « graphiques exacts après 48 h de données synthétiques » est le test `services/metrics.test.ts` (50 h, job horaire simulé, moyennes/extrema vérifiés minute et heure par heure, y compris une heure dont le brut a été purgé). Le schéma de `metrics_server_1m/1h` n'a **pas** de colonne `mspt` (le MSPT n'est visible qu'en brut, ≤ 3 h).

## 8. Règles d'exploitation

1. **Un seul écrivain par fichier** : toutes les écritures passent par une connexion unique du panel (better-sqlite3 synchrone = sérialisation naturelle par l'event loop). `busy_timeout` en ceinture de sécurité.
2. **La console ne va jamais en SQLite** : flux WebSocket + ring buffer mémoire ; archivage en fichiers côté agent.
3. **WAL** : checkpoint `TRUNCATE` périodique en période calme ; paginer les grosses lectures (un long SELECT bloque le checkpoint et fait gonfler le `-wal`).
4. **Sauvegarde du panel lui-même** : tâche périodique `VACUUM INTO` (jamais de copie de fichier à chaud, jamais de SQLite sur partage réseau). *Phase 8* : `PanelBackupService` — `VACUUM INTO '<dataDir>/backups/panel/mmo-<horodatage>.db'` une fois par jour depuis la maintenance horaire (`backupIfStale`), à la demande via `POST /api/admin/backups` (listage `GET`), 7 copies conservées ; `metrics.db` (reconstituable, volumineux) n'est pas copié. *Phase 12* : **restauration** par `mmo-panel restore <fichier>` (panel arrêté) → `restorePanelBackup()` : `integrity_check` + présence de `users`, refus si `mmo.db-wal` non vide, base courante mise de côté en `mmo.db.before-restore-<date>`, `-wal`/`-shm` supprimés, copie en place ; `createdAt` des copies lu depuis le nom (`mmo-<ISO>.db`), pas depuis le mtime. Test `integration/panel-backup.test.ts` : sauvegarde → dérive → restauration → agent reconnecté (secret inchangé) et serveur ré-adopté (même ID), puis purges sur horloge simulée (sessions, codes, événements 90 j, audit 365 j, rotation 7, `backupIfStale` 24 h, réglage `retention.eventsDays` honoré).
5. **Réconciliation** au reconnect d'un agent : comparer le snapshot `sync.state` (vérité terrain) à `run_state`/`desired_state`, corriger, émettre les événements manquants, clôturer les sessions joueurs orphelines.
6. **Purges planifiées** : sessions expirées, pairing codes consommés, events > rétention, push_subscriptions mortes, command_history > N k lignes/serveur, tasks terminées anciennes. *Phase 10* : les abonnements push morts sont purgés **à la livraison** (404/410 ou 8 échecs), pas par la maintenance horaire. Clés `app_settings` de la couche d'accès : `access.mode`, `access.domain`, `access.httpsPort` (443), `access.publicHost`, `access.dns.provider` (`manual`), `access.dns.token` (**secret**), `access.dns.zone`, `access.dns.updateUrl`, `access.acme.email`, `access.acme.directory`, `access.dyndns.enabled` (`false`) ; l'état runtime (adresse publiée, dernier test, erreurs) vit dans `<dataDir>/tls/state.json`, pas en base.
7. **Exclusions de scan** : `.mmo-trash/` (corbeille agent) et les destinations de backups situées sous un répertoire surveillé sont exclues du scan, des backups et des migrations (sinon : backup de corbeille, récursion backup-de-backup).
