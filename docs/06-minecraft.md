# 06 — Lancement et pilotage des serveurs Minecraft

Référence technique pour l'agent : construction des commandes, auto-détection, console, cycle de vie, RCON, TPS, formats de fichiers. Cible : Vanilla / Forge / NeoForge / Fabric, MC 1.12 → 1.21+.

## 1. Matrice de lancement — 4 templates

L'agent construit **lui-même** la commande (jamais via `.bat`/`.sh`, jamais via un shell) ; cwd = dossier du serveur, toujours.

| Cas | Commande | Notes |
|---|---|---|
| **Vanilla** | `java <flags> -jar server.jar nogui` | Jar parfois nommé `minecraft_server.<v>.jar` |
| **Forge ancien (≤ 1.16.5)** | `java <flags> -jar forge-<mc>-<v>[-universal].jar nogui` | Ne pas confondre avec l'**installer** (discriminant fiable : il contient `install_profile.json`). 1.12.x = **strictement Java 8** |
| **Forge/NeoForge modernes (≥ 1.17)** | `java <flags> @libraries/.../win_args.txt nogui` (ou `unix_args.txt`) | Argfiles générés par l'installeur ; `@fichier` = expansion native du launcher java (JDK 9+). On **remplace** `@user_jvm_args.txt` par nos flags et on garde l'argfile Forge tel quel — ne jamais le parser soi-même. Choix win/unix selon l'OS de l'agent |
| **Fabric** | `java <flags> -jar fabric-server-launch.jar nogui` | Attend `server.jar` vanilla à côté (`fabric-server-launcher.properties` : `serverJar=`) ; variante téléchargeable `fabric-server-mc.<mc>-loader.<v>-launcher.<v>.jar` (version MC dans le nom). Quilt : même modèle (`quilt-server-launch.jar`), pour plus tard |

Chemins argfiles : `libraries/net/minecraftforge/forge/<mc>-<forge>/` ou `libraries/net/neoforged/neoforge/<v>/`. Si l'argfile de l'OS cible manque (migration inter-OS d'une install bricolée) : ré-exécuter l'installer avec `--installServer` répare `libraries/`.

**Flags injectés systématiquement par l'agent** :

- `-Xmx` / `-Xms` (garde-fou RAM vérifié en amont)
- `-Dfile.encoding=UTF-8` (+ `-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8` si JRE ≥ 19)
- **Log4Shell** : `-Dlog4j2.formatMsgNoLookups=true` (1.17–1.18.0) et, pour 1.12–1.16.5, `-Dlog4j.configurationFile=log4j2_112-116.xml` — le fichier de conf patché Mojang est **embarqué dans le bundle agent** et écrit dans le dossier serveur
- `-XX:+ExitOnOutOfMemoryError` (transforme les OOM-zombies en exit détectable)
- `-Djava.awt.headless=true` + `nogui` (sinon fenêtre Swing qui bloque)
- `-Dlog4j.skipJansi=true` (natives jansi problématiques sur certains Windows/ARM)

> **Implémentation (phase 3)** : `apps/agent` — `buildLaunchCommand` (`src/minecraft/launch.ts`, fonction pure : 2 templates `jar`/`argfile`, flags injectés, choix `win_args.txt`/`unix_args.txt`, `E_NOT_FOUND` si l'argfile de l'OS manque). Atténuation Log4Shell : `log4ShellMitigation` (config `log4j2_112-116.xml` embarquée écrite dans le dossier pour 1.12–1.16.5, `-Dlog4j2.formatMsgNoLookups=true` pour 1.17–1.18.0, rien ensuite). Spawn **détaché** (`detached:true`, `windowsHide`), jamais via shell/`.bat` (`src/minecraft/server-process.ts`). Garde-fous → erreurs typées avant lancement (`src/minecraft/server-manager.ts`) : `E_EULA_REQUIRED`, `E_JAVA_UNAVAILABLE` (sélection `src/platform/java.ts` : version majeure exacte, sinon la plus petite ≥ requise hors mode strict Forge ≤ 1.16.5), `E_RAM_GUARD` (RAM machine − réserve − serveurs en marche), `E_PORT_IN_USE` (port de jeu, test IPv4+IPv6). RCON auto-provisionné dans `server.properties` (`src/minecraft/provisioning.ts`), client maison file sérialisée + paquet junk (`src/minecraft/rcon.ts`). Ré-adoption PID + heure de démarrage + `cmdline` (`src/platform/process-info.ts` : `Get-CimInstance` Windows, `/proc` Linux, `ps` macOS). *Amendement (post-1.0, stabilisation CI 2026-08-25)* : la requête CIM Windows a un timeout de 20 s (la première requête d'une machine froide — WMI + PowerShell — peut dépasser 10 s) et un **disjoncteur** : tout échec autre que « PID absent de Win32_Process » suspend les requêtes CIM pendant 5 min, l'identité répond alors « rien de vérifiable » (`startedAt`/`cmdline` absents) — l'adoption reste bienveillante (`verified: false`) au lieu d'échouer sur un hôte au WMI cassé ou gelé. Validé en CI par le **fake Java server** (`test/fake-java-server.mjs`) et à la main sur un vrai Vanilla 1.20.1 (start → `Done` → RCON `list` → stop propre ; ré-adoption après « mort » de l'agent, java survivant → stop RCON).

> **Amendement proxy Velocity (2026-09-01, lot 7)** — un Velocity est un serveur du template `jar`, avec cinq particularités appliquées quand `loader = 'velocity'` : (1) **pas de `nogui`** (argument inconnu du proxy, qui refuserait de démarrer) ; (2) **pas d'EULA Mojang** (garde `E_EULA_REQUIRED` sautée) ; (3) **jamais de RCON** — le provisionner créerait un `server.properties` parasite dans son dossier ; console via stdin seulement, TPS « indisponible » assumé (`tpsChain` vide), `rcon_enabled = 0` à l'adoption ; (4) le **port d'écoute** vient de `velocity.toml` (`bind`, défaut 25577 — `parseVelocityToml` de `@mmo/shared`) pour le contrôle `E_PORT_IN_USE` ; (5) l'arrêt propre passe par la commande console **`shutdown`** (`stop` est inconnu de Velocity ; `StopOptions.stopCommand`). Détection (§2) : `velocity.toml` **qualifie** le dossier à l'étape 0, loader `velocity` (confiance haute, prioritaire), version tirée du nom `velocity-<v>.jar`, **pas de version Minecraft** (ni note `no_version`, ni redétection à chaque démarrage), Java 17 requis, motd lu dans `velocity.toml`. Compat N−1 : un agent antérieur ne détecte pas les proxys (son étape 0 les rejette) et **rejette** une config `loader: 'velocity'` (enum inconnue) — migrer/dupliquer un proxy vers une machine à l'agent non à jour échoue proprement en validation ; mettre l'agent à jour d'abord.

## 2. Auto-détection d'un dossier serveur

### Signaux

| Signal | Donne |
|---|---|
| `libraries/net/neoforged/neoforge/<v>/` | NeoForge ; MC dérivée du schéma de version (`21.1.x` → 1.21.1) |
| `libraries/net/minecraftforge/forge/<mc>-<forge>/` | Forge ; argfiles présents ⇒ moderne, absents ⇒ jar universal. Plusieurs versions possibles (RAD2 : 9 dossiers) : retenir celle référencée par `run.bat`/`run.sh` (`@libraries/…/<v>/win_args.txt`), sinon la plus haute |
| `forge-*.jar` racine sans `install_profile.json` | Forge legacy, MC dans le nom. Discriminant robuste : `Main-Class` du manifeste (`…installer.SimpleInstaller` = installeur ; `…ServerLaunchWrapper` / `…server.ServerMain` = serveur). Installeur présent **sans** `libraries/` ⇒ loader connu, `needsInstall` |
| `fabric-server-launch.jar` / **`fabric-server-launcher.jar`** (packs ServerPackCreator) / `.fabric/` / `fabric-server-mc.*` | Fabric ; versions MC + loader dans `install.properties` du lanceur, vanilla extrait dans `versions/<mc>/server-<mc>.jar` |
| `server.jar` | Vanilla ; version via `version.json` **dans** le jar (zip, champ `id`, ~1.14+). **Vérifier `Main-Class`** (`net.minecraft.bundler.Main` / `net.minecraft.server.Main`) : un `server.jar` peut être un **ServerStarterJar NeoForge** (`net.neoforged.serverstarterjar.Main8`, 25 Ko — AllOfCreate) |
| `mods/*.jar` (échantillonner 3–5, **y compris `mods/<mc>/`** — SkyFactory 4) | Confirmation : `fabric.mod.json` ⇒ Fabric ; `META-INF/mods.toml` ⇒ famille Forge (compatible Forge **et** NeoForge ≤ 1.20.4) ; `META-INF/neoforge.mods.toml` ⇒ NeoForge ; `mcmod.info` ⇒ Forge 1.12 ; jar multi-loader (plusieurs descripteurs) = ambigu, ne vote pas |
| `user_jvm_args.txt` | RAM (`-Xmx`) Forge/NeoForge modernes |
| `variables.txt` | **ServerPackCreator** (DungeonHeroes, Prominence II, AllOfCreate…) : `MODLOADER`, `MODLOADER_VERSION`, `MINECRAFT_VERSION`, `JAVA_ARGS` (RAM) — loader/version de confiance moyenne, RAM de confiance haute |
| `*.bat` / `*.sh` / `*.ps1` / `settings.*` / `server-setup-config.yaml` | Regex `-Xmx(\d+)([GgMmKk]?)` en **ignorant les lignes commentées** (`#`, `REM`, `::`, `echo`, chaînes `"#` des `.ps1` BetterMC) ; `settings.bat/.sh` : `MAX_RAM=`/`MIN_RAM=` (SkyFactory 4) ; scripts de l’OS de l’agent en priorité, valeurs divergentes ⇒ confiance faible + evidence ; le yaml FTB ServerStarter contient MC + modloader (`install: mcVersion/loaderVersion/modLoader`) |
| `server.properties` | port, RCON, motd, level-name |
| `logs/latest.log` | `Starting minecraft server version <X>` — excellent fallback |
| `eula.txt` | état EULA |

### Algorithme ordonné

> Implémenté en phase 2 : `detectServer()` / `scanForServers()` dans `@mmo/shared` (cœur pur sur une interface `DetectFs`, adaptateur Node + lecteur de jar sans dépendance dans `@mmo/shared/node`). Validé sur 22 fixtures copiées/anonymisées de vrais dossiers (`packages/shared/test/fixtures/servers/`, collecteur `collect-fixtures.mjs`) : 22/22 corrects (loader, version MC, version loader, RAM). Ordre effectif des signaux de loader : libraries NeoForge → argfiles Forge → jar universal Forge → lanceur Fabric → installeur seul → déclaration de pack (`variables.txt` / yaml FTB) → vote des mods → jar vanilla (sans mods) → inconnu ; les mods servent ensuite de **confirmation** (montée en confiance) ou de **contradiction** (confiance faible + evidence).

```
Pour chaque sous-dossier D (profondeur 2 par défaut, .mmo-trash/ et destinations
de backups exclus) :
  0. Qualifier : server.properties OU eula.txt OU (jar serveur + mods/).
  1. Loader (premier match, du plus spécifique au moins) :
     neoforge libraries → forge argfiles → forge jar universal → fabric → 
     inspection mods/ → vanilla → « inconnu / à configurer »
  2. Version MC : nom de dossier libraries → nom de jar → version.json →
     server-setup-config.yaml → logs/latest.log → demander à l'utilisateur
  3. RAM : user_jvm_args.txt → variables.txt → scripts → défaut proposé (4G)
  4. Ports : server.properties (server-port, rcon.port, query.port)
  5. Java requis : version MC + manifest Mojang (doc 03 §4)
  6. Résultat = objet avec score de confiance par champ + evidence ;
     TOUT reste éditable manuellement (les packs bricolés casseront toujours
     une heuristique).
```

## 3. Console (stdin/stdout)

- **Le pipe stdin/stdout suffit** pour tous les loaders/versions ciblés : commandes envoyées **sans** slash initial, terminées par `\n`, flush immédiat. **Ne jamais fermer stdin volontairement** : le spike EOF (doc 03 §10, [`docs/spikes/01-eof-stdin.md`](spikes/01-eof-stdin.md)) montre que tous les loaders testés (Vanilla, Forge 1.12/1.16, Fabric 1.21, NeoForge 1.21) **survivent** à l'EOF stdin et à la mort de l'agent — mais la boucle console est alors définitivement close : le serveur n'est plus pilotable que par RCON jusqu'à son prochain redémarrage (mode `detached`).
- **Encodage — le piège n°1 sur Windows** : Java ≤ 17 encode stdout selon le charset système (cp1252 sur un Windows FR) → accents cassés. Réglé par les flags UTF-8 injectés (§1) ; côté agent, pipes toujours décodés UTF-8 en mode tolérant (les mods écrivent parfois n'importe quoi). Filtre d'échappement ANSI prévu (certains packs forcent la couleur).
- **stdout = source de vérité temps réel** (contient les messages hors log4j : warnings JVM, crashs précoces, hs_err). `logs/latest.log` + `logs/*.log.gz` = archives pour la recherche. `logs/debug.log` non streamé par défaut.
- **Parsing des lignes** (phase 2 : `parseLogLine` / `LogLineClassifier` / `parseLogText` et `matchServerLogEvent` dans `@mmo/shared`) — deux formats + fallback :
  - Vanilla/Fabric/Forge 1.12 : `[HH:mm:ss] [Thread/LEVEL]…`
  - Forge/NeoForge modernes : `[ddMMMyyyy HH:mm:ss.SSS] [Thread/LEVEL] [logger/]: …` — **le mois suit la locale JVM** (`[14sept.2023 …]`, `[07janv.2023 …]` sur un Windows FR, constaté sur DawnCraft/RAD2) : ne jamais exiger un mois anglais
  - Forge 1.12 : format classique avec un logger intercalé `[HH:mm:ss] [Thread/LEVEL] [FML]: …`
  - Toute ligne qui ne matche aucun pattern (stacktraces) est rattachée à l'entrée précédente, même niveau. Niveaux : INFO/WARN/ERROR/FATAL/DEBUG/TRACE.
- **Autocomplétion console (V2, 2026-08-31)** : l'arbre est demandé **au serveur lui-même**, par `help` en RCON (`server.commandHelp`) — donc les commandes des mods, dans leur vraie forme. La liste statique du panel reste le repli (serveur arrêté, agent N-1, première frappe avant la réponse) et une pastille dit laquelle est active : sans elle, un utilisateur sur modpack croirait l'aperçu exhaustif et conclurait qu'une commande n'existe pas. Précautions : `rconExec` sans repli stdin (sinon `help` s'écrirait dans la console de l'utilisateur en mode attaché) ; aucune écriture dans `command_history` ni dans l'audit (sinon `help` remonterait dans le rappel « flèche haut ») ; un seul balayage par session, rien pendant la première minute d'un démarrage (la socket RCON est partagée avec la sonde TPS et le watchdog, et un `E_TIMEOUT` la ferme) ; verrou long si le serveur répond sans connaître `help`, réessai simple sur panne de transport (la leçon de la sonde TPS). Les deux dialectes sont lus : 1.12 paginé (`Showing help page X of N`), 1.13+ Brigadier avec `...` pour un sous-arbre replié, déplié à la demande par `help <commande>`. L'aperçu affiche la forme attendue sous le champ, ce que la position courante attend, et les pseudos en ligne uniquement là où un joueur est attendu.
- **Historique dans l'UI (post-1.0, recette)** : le tampon console (5 000 lignes) repart vide à chaque redémarrage de l'agent, et le tail `detached` démarre en fin de fichier → console vide après un reboot. L'onglet console précharge donc la fin de `logs/latest.log` via `fs.read` (bloc « Historique » estompé au-dessus du direct, 200 lignes max ; les lignes live reçues pendant la lecture sont rejouées après, jamais mélangées) ; si le fichier dépasse le plafond `fs.read` (512 Ko), message + renvoi vers le téléchargement. Un bouton de la console télécharge `logs/latest.log` en un clic (route `files/download` existante) — pensé pour « joindre les logs » en support. Un léger recouvrement historique/tampon est possible (séparateurs visuels, pas de dédup).

## 4. Cycle de vie

### Démarrage

- Prêt = regex `Done \([\d.,]+\s*s\)!` (le nombre suit la locale JVM — virgule possible ; ne pas exiger « For help ») **OU** authentification RCON réussie (le listener RCON démarre en toute fin de boot — sonde de readiness fiable).
- États intermédiaires affichables : `Starting minecraft server version…`, `Preparing spawn area: X%`. Timeout de démarrage configurable, défaut 10 min (gros packs : 3–10 min réels).
- Premier lancement : `You need to agree to the EULA` + exit rapide → déclenche le flux EULA guidé.

### Arrêt gracieux

1. Annonces (`say`) si arrêt programmé.
2. `stop` sur stdin (fallback RCON si détaché). Sauvegarde des mondes : jusqu'à 1–2 min sur un gros pack.
3. Attente d'exit : **120 s** par défaut.
4. Unix : `SIGTERM` (le shutdown hook sauvegarde encore) → 30 s → `SIGKILL`.
5. Windows : pas de SIGTERM exploitable ; `taskkill /F` en dernier recours, marqué « arrêt forcé, risque de corruption » dans l'audit. **Sur Windows, `stop` est le seul arrêt propre → le fallback RCON est vital** (d'où l'auto-provisionnement).

### Crash

Le code de sortie n'est **pas fiable** (0, 1, -1 selon les cas ; OOM parfois sans exit). Faisceau :

1. **Signal principal : exit alors qu'aucun stop n'a été demandé par l'app.** — nuance actée en phase 3 : la ligne `Stopping the server` (événement `stopping`) compte aussi comme demande d'arrêt volontaire, même si le `stop` a été tapé **dans la console** (ou envoyé par un mod/RCON) hors de la séquence `server.stop` : l'exit qui suit est classé `stopped`/`exitReason: stop`, jamais `crashed`. Sans ce signal ni `server.stop`, un exit reste un crash.
2. Nouveau `crash-reports/crash-*-server.txt` pendant la session → attaché à l'événement (parsing du header : cause, mod fautif).
3. Patterns : `Encountered an unexpected exception`, `Exception in server tick loop`, `java.lang.OutOfMemoryError`, `A single server tick took 60.00 seconds`.
4. `hs_err_pid*.log` à la racine = crash JVM natif.

Auto-restart optionnel avec garde anti-boucle (`crash_loop_max` par fenêtre).

### Freeze

- `max-tick-time` vanilla n'est pas exploitable (les modpacks le désactivent).
- **Détection agent** : sonde RCON `list` toutes les 30–60 s, timeout 5 s ; 3 échecs consécutifs process vivant ⇒ freeze suspecté → notification + action configurable (rien / kill+restart). RCON plutôt que stdin car la réponse est corrélée à la requête.
- Alerte précoce : MSPT en continu (§6) + patterns `Can't keep up!`.

> **Implémentation (phase 7, `apps/agent/src/monitoring/watchdog.ts`)** : le watchdog est **local à l'agent** (politique par serveur persistée, reçue via `agent.configure.watchdog`). **Crash** = état `crashed` produit par `ServerProcess` (faisceau ci-dessus : exit sans `server.stop`/`kill`/`Stopping the server`, rapport `crash-reports/` attaché, dernier pattern de crash vu dans les logs remonté en `crashSignal` → `detail` de l'alerte). `autoRestart` faux ⇒ `watchdog.alert { kind: crash, action: none }`. Sinon : **`crashLoopMax` redémarrages automatiques par fenêtre glissante de 10 min** (`crashLoopMax = 0` ⇒ jamais), délai avant relance `min(5 s × tentative, 60 s)`, alerte `{ crash, restart, attempt }` puis, au-delà, `{ crash_loop, gave_up, attempt }` et le serveur reste `crashed` ; un `server.start/stop/restart/kill` explicite annule la relance en attente et remet le compteur à zéro ; la relance passe par les mêmes garde-fous que `server.start` (un `E_PORT_IN_USE` émet `port.conflict`). **Freeze** : sonde RCON `list` toutes les `clamp(freezeTimeoutSec / 3, 5 s, 60 s)` (délai de commande **et** d'authentification = min(5 s, intervalle)), **3 échecs consécutifs** avec processus vivant ⇒ `{ freeze, <freezeAction>, attempt }` ; `kill_restart` ⇒ `SIGKILL` classé `crashed` / `exitReason: freeze_kill` (doc 04 §3), qui passe alors par la logique de crash (relance bornée, `detail: freeze_kill`) ; `none` ⇒ une seule alerte tant que la sonde ne répond pas. Sondes démarrées à `running` (y compris après ré-adoption), arrêtées à `stopping`. **RAM** : le collecteur de métriques alerte `{ kind: ram, action: none }` une fois par session de démarrage quand RSS > 1,5 × `maxRamMb` + 512 Mo (le refus au lancement reste `E_RAM_GUARD`). **Ports** : `**** FAILED TO BIND TO PORT!` dans les logs ⇒ `port.conflict { port: gamePort }` (en plus du contrôle avant lancement). Validé par `agent.watchdog.test.ts` sur le fake Java server (`--crash-after`, `--freeze-after` qui rend RCON muet, `--port` pris) : crash ×3 → restart, restart, gave_up ; freeze → kill_restart → `freeze_kill` → relance → gave_up.

## 5. RCON

- Auto-provisionnement par l'agent (décision doc 03) : `enable-rcon=true`, `rcon.port` unique par machine, `rcon.password` fort généré — actif au prochain restart du serveur ; badge UI « arrêt propre dégradé » tant qu'inactif. RCON écoute sur toutes les interfaces, en clair → **port bloqué hors machine locale** (pare-feu + ACL réseau).
- Protocole Source RCON (TCP little-endian) : `[len][reqId][type][payload][2×null]` ; login = type 3, commande = type 2. Implémentation maison ~100 lignes, reconnexion auto, **file de commandes sérialisée** (le serveur traite une commande RCON à la fois).
- Limites : commande ≤ 1446 octets ; réponses fragmentées par 4096 octets sans marqueur de fin → technique du « paquet junk » pour détecter la fin ; parser en mode tolérant (bug MC-270327). Les réponses asynchrones (spark) et broadcasts de mods ne passent pas par RCON.
- **Un seul paquet par lecture côté serveur** (phase 12, constaté en réel) : le `RconClient` de vanilla lit jusqu'à 1 460 octets et **ferme la connexion** si la lecture ne contient pas exactement un paquet (`if (k != i - 4) return`). Commande et paquet junk ne sont donc jamais écrits coup sur coup : le junk part après le **premier fragment** de réponse (le serveur est alors de retour en lecture). Le fake Java server rejoue ce comportement avec `--rcon-strict-read`.
- **Architecture : stdin = canal principal, RCON = complément** (sondes de vivacité, TPS, `list` parsé, backup à chaud, et seul canal en mode `detached`).

> **Implémentation (phase 8, backups — `apps/agent/src/backup/`)** : **backup à chaud** = `save-off` → `save-all flush` → archive → `save-on` (dans un `finally`), chaque commande envoyée **par RCON d'abord** (la réponse confirme la fin de l'écriture, délai 120 s) puis par stdin en repli, avec attente de « Saved the game » (ou d'un silence console de 3 s, serveurs moddés au message différent). Archive = **tar maison** (`tar.ts` : ustar + en-têtes pax pour les noms > 100 octets et les fichiers ≥ 8 Gio, liens symboliques ignorés et signalés, chemins jailés à l'extraction) compressé en **zstd 3 + checksum** (`.tar.zst`) ou gzip (`.tar.gz`) via `@mmo/shared/node` (jamais `nbWorkers`, règle ESLint partagée) ; exclusions : `.mmo-trash`, `logs`, `crash-reports`, `session.lock`, `.mmo-server.json` (marqueur d'identité), la destination de backups si elle est dans le dossier. Manifeste `<backupId>.json` à côté de l'archive = **seule source d'intégrité** (sha256 + taille, spike n°3). **Restauration** : vérification du manifeste **avant** de toucher au serveur (`E_CHECKSUM_MISMATCH` sans rien modifier), arrêt du serveur s'il tourne (watchdog annulé), backup de sécurité `pre_restore`, journal WAL écrit, purge du dossier (hors exclusions — les journaux survivent), extraction, relance optionnelle ; résultat `{ backupId, safetyBackup?, files, bytes, restarted, wasRunning }`. Une seule task backup/restore par serveur (`E_BUSY`). **Rotation locale** (`keep`, `keepDays`, par politique) → `backup.rotated`. **Plannings** (`scheduler.ts`) : évalués toutes les 30 s en heure locale de la machine, une occurrence n'est jamais exécutée deux fois (`backupScheduleRuns`), occurrence manquée non rattrapée, `onlyIfRunning` respecté, ignoré si une task backup est déjà en cours. Le fake Java server implémente `save-off`/`save-all`/`save-on` (journal `world/save-log.txt`, `world/level.dat` réécrit) pour prouver l'ordre des commandes. **Lot 4 (2026-09-02, `guards.ts`)** : avant d'écrire, l'agent exige le marqueur `.mmo-backups.json` à la racine d'une destination explicite (volume non monté = refus, pas d'écriture sur le disque système) puis, l'inventaire fait après `save-all`, vérifie l'espace libre contre la taille estimée de l'archive (taux de compression de la dernière archive du serveur + 64 Mio) — refus `E_IO` non réessayable avant le premier octet, `save-on` toujours renvoyé (doc 05 §6). **Restauration partielle (lot 4, 2026-09-02)** : `backup.browse` lit les en-têtes de l'archive sans l'extraire (`listArchive` → `listTar`) ; `backup.restorePaths` n'extrait que les chemins choisis (`extractArchive` avec prédicat d'inclusion par préfixe) — côte à côte par défaut dans `restored-<date>/` à la racine du serveur (jamais archivé, jamais purgé par une restauration complète, ignoré du scanner), ou en place avec les mêmes étapes qu'une restauration complète (arrêt, sécurité, purge des seuls chemins choisis, extraction filtrée, relance) ; chaque chemin demandé doit exister dans l'archive avant tout arrêt, les chemins réservés (marqueur, journaux, corbeille) sont refusés à la requête. Détail doc 05 §6.

> **Implémentation (lot 4, copie hors-site — `BackupService.receive`)** : l'agent reçoit une copie d'archive produite sur une autre machine par la chaîne de migration (doc 05 §6, amendement), la vérifie (sha256 par le téléchargeur, copie déjà présente relue), la dépose sous `<destination>/<serverId>/<backupId>.<ext>` avec son manifeste réécrit, et applique `keep` à ce dossier de copie ; il n'a pas besoin de connaître le serveur. Le dossier de copie se liste avec `backup.list`, se sert avec `transfer.serve` (rapatriement) et se purge avec `backup.delete`, exactement comme une archive locale. Les mêmes gardes qu'une sauvegarde locale s'appliquent : marqueur de destination, espace libre.

> **Implémentation (phase 9, migration — `apps/agent/src/migration/migration.ts`)** : l'export de migration est un backup `pre_migration` **à froid** (le serveur est arrêté proprement avant, avec annonce optionnelle, pour que le monde soit figé et que la cible reparte d'un état cohérent) ; la restauration sur la cible réutilise `extractArchive` (mêmes exclusions : `logs/`, `crash-reports/`, corbeille, `session.lock` ne sont pas transportés). Le marqueur `.mmo-server.json` est réécrit sur la cible avec le **même `serverId`** (le panel reste l'autorité des IDs) et retiré du dossier source renommé `.migrated-<date>`, que le scanner ignore (`MIGRATED_DIR`, doc 04 §8.7) — pas de conflit de marqueur après migration.

## 6. TPS / MSPT — honnêtement

| Contexte | Méthode | Fiabilité |
|---|---|---|
| Vanilla < 1.20.3 | **Rien** | — |
| Vanilla ≥ 1.20.3 | `/tick query` | Bonne (parsing texte) |
| Forge | `/forge tps` (`Overall: Mean tick time: X ms. Mean TPS: Y`) | Bonne, regex souple (varie entre versions) |
| NeoForge | `/neoforge tps` | Bonne |
| Fabric | Rien de built-in ; mod **spark** (`/spark tps`) | Bonne si spark présent |

- Chaîne de fallback du monitoring (poll RCON toutes les 15–30 s) : `neoforge tps` → `forge tps` → `spark tps` (si détecté dans `mods/`) → `tick query` (MC ≥ 1.20.3) → **« TPS indisponible » affiché franchement**.
- spark couvre Forge/Fabric/NeoForge/Quilt 1.16.5→1.21+ (+ build Forge 1.12.2) : l'app propose « installer spark en un clic » (drop du jar dans `mods/`), **jamais requis**.
- À ne pas survendre : `Can't keep up!` = signal d'alerte binaire, pas une métrique ; TPS par timestamps de logs = non fiable ; latence RCON = heuristique de santé seulement.

> **Implémentation (phase 7)** : parsing dans `@mmo/shared` (`minecraft/tps.ts` : `parseForgeTps` — `Overall: Mean tick time: X ms. Mean TPS: Y` **et** `Overall: Y TPS (X ms/tick)`, virgule décimale et codes `§` tolérés, première dimension en dernier recours ; `parseSparkTps` — TPS à 10 s + médiane des durées de tick ; `parseTickQuery` — `min(cible, 1000 / mspt)` ; `tpsChain(loader, mcVersion, sparkInstalled)` = chaîne ordonnée, vide pour vanilla < 1.20.3 ou Fabric sans spark). Agent : `TpsProbe` par serveur (`src/monitoring/tps.ts`) — spark détecté par `mods/spark-*.jar`, méthode qui répond **mémorisée**, chaîne réapprise à chaque démarrage et à chaque `agent.configure`, et quand tout échoue **aucune nouvelle tentative pendant 10 min** (pas de spam de la console). **Amendement (2026-08-30)** : le verrou de 10 min ne vaut que si le serveur a **répondu** sans connaître la commande. Un échec de **transport** RCON (listener pas encore ouvert — un vrai serveur peut ouvrir le sien après la ligne « Done » —, socket coupé par un `E_TIMEOUT` du watchdog qui partage le client, timeout) donne lieu à un **backoff court et croissant** (5 s doublés, plafond 60 s, borné à 20 tentatives avant de retomber sur le verrou long) ; la méthode apprise est **conservée** (sinon chaque hoquet renverrait `neoforge tps` à un serveur Forge, dans sa console) et le passage du serveur à `running` **débloque** la sonde. Avant ce correctif, un unique ECONNREFUSED au démarrage suffisait à ce que le TPS ne soit plus jamais échantillonné de toute la session — c'est le défaut que masquait la tolérance `[flaky-ci]` du test `metrics.sample`, désormais retirée et rejouée de façon déterministe (`--rcon-delay`). `metrics.sample` porte `tpsSource`. UI : « TPS indisponible » avec la **raison** (vanilla ancien / Fabric sans spark / commande Forge sans réponse / serveur arrêté), lien de téléchargement de spark et mention « jamais requis ». **Non fait** : « installer spark en un clic » (dépôt du jar par l'agent) attend les transferts de la phase 8 — noté en dette.

## 6bis. Installer un serveur moddé — mesures du spike `runJar` (2026-09-04)

Préalable au lot 5 (doc 07). Trois installeurs réels lancés en tête-à-tête sur des dossiers vides,
avec le bon Java **et avec le mauvais**, pour répondre à une question : que faut-il savoir pour
faire tourner un programme Java tiers depuis l'agent ?

| Installeur | Java « attendu » | Durée | Sortie | Fichiers produits |
|---|---|---|---|---|
| Forge 1.12.2 (14.23.5.2859) | 8 | **4,6 s** | 90 lignes | `forge-<v>.jar` + `minecraft_server.1.12.2.jar` (30 Mio) + `libraries/` (38 Mio) |
| Forge 1.20.1 (47.4.10) | 17 | **20 s** | ~2 000 lignes | `run.sh`/`run.bat`/`user_jvm_args.txt` + `libraries/` (159 Mio) |
| NeoForge 21.1.209 (MC 1.21.1) | 21 | **20 s** | **7 580 lignes, 511 Kio** | idem + `libraries/` (176 Mio) |

**1. L'installeur n'est PAS soumis à la contrainte Java du serveur.** C'est le résultat qui
corrige la prémisse du plan. Forge 1.20.1 et NeoForge 21.1 s'installent **entièrement sous Java
8** (159 et 176 Mio de bibliothèques, « The server installed successfully »), et Forge 1.12.2
s'installe sous Java 21. La règle « Java 8 strictement jusqu'en 1.16.5 » concerne le **lancement**
du serveur, pas son installation : l'agent peut installer avec le Java qu'il a déjà sous la main,
et ne doit résoudre le bon Java qu'au premier démarrage. *Portée du constat : ces trois
installeurs. Les Forge très anciens (1.7–1.10) et les autres familles restent à vérifier au
moment de les supporter.*

**2. Le code de retour est fiable** — 0 en cas de succès, **1** en cas d'échec (cible impossible à
écrire, option inconnue), doublé d'une ligne finale explicite : `The server installed successfully`
ou `There was an error during installation`. On peut donc s'y fier, à condition de lire le code du
processus **et pas celui d'un tube** (piège 79 : `java … | tail` rend le code de `tail`, ce qui
faisait passer un échec pour un succès pendant le spike lui-même).

**3. La sortie ne doit pas partir dans la console du panel.** 7 580 lignes pour une installation
NeoForge : les relayer comme des lignes de console saturerait le canal temps réel (contre-pression,
doc 03 §9). L'agent garde une **queue** et en tire des phases ; les installeurs Forge et NeoForge
modernes écrivent en plus un `installer.jar.log` à côté du JAR — c'est lui qu'on joint à un échec,
pas un tampon mémoire.

**4. La progression est en phases, pas en pourcentage.** Aucun total n'est annoncé. Les motifs
reconnaissables sont `Considering library` / `Downloading library from` / `Download completed`
(téléchargement), puis `Building Processors`, `Processor: <nom>` et `Patching <classe>`
(transformation). Un pourcentage serait inventé ; une phase est vraie.

**5. Ce que produit l'installeur correspond aux templates du §1**, et rien de plus : ni
`server.properties`, ni `eula.txt`. Le 1.12.2 donne un JAR à lancer (template `jar`) ; le 1.20.1 et
le NeoForge donnent `run.sh`/`run.bat` + `user_jvm_args.txt` + `libraries/` (template script de
lancement). L'acceptation de l'EULA et la configuration restent donc au panel, après installation.

**6. Durées mesurées sur une ligne rapide** : 5 à 20 secondes. L'essentiel est du téléchargement
(40 à 176 Mio) : sur une ligne lente, la même installation se compte en minutes. Une task de fond
avec progression reste donc nécessaire — mais le pire n'est pas le calcul, c'est le réseau.

## 7. Fichiers édités par MMO

### `server.properties`

- Java Properties plat ; **le serveur réécrit le fichier** (commentaires perdus — ne pas promettre leur préservation). Clés inconnues (ajoutées par des mods) **préservées** par l'éditeur.
- Écriture sûre universelle : ASCII + échappements `\uXXXX` (+ `\\`, `\:`, `\=`). MOTD : codes couleur `§`.
- Clés notables : `server-port`, `enable-rcon`, `rcon.port`, `rcon.password`, `white-list` (avec tiret) + `enforce-whitelist`, `motd`, `level-name`, `online-mode`, `max-players`, `max-tick-time`. Quasi tout exige un restart.

### Fichiers JSON (whitelist, ops, bans — 1.7.6+, donc toute la plage ciblée)

```json
// whitelist.json
[ { "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5", "name": "Notch" } ]
// ops.json : + "level": 1-4, "bypassesPlayerLimit"
// banned-players.json : + "created", "source", "expires" ("forever" ou date
//   "yyyy-MM-dd HH:mm:ss Z"), "reason"
// banned-ips.json : "ip" à la place de uuid/name
```

- **Identité = UUID** (avec tirets), `name` = cache d'affichage. `online-mode=true` : résolution nom→UUID via l'API Mojang. `online-mode=false` : UUID v3 dérivé = `nameUUIDFromBytes("OfflinePlayer:" + name)` (MD5) — les deux implémentés, choisis selon le serveur. `usercache.json` = source locale pour l'autocomplétion.
- **Règle d'or (routage automatique par l'agent)** : serveur **en marche** → commandes (`whitelist add`, `op`, `ban`, `pardon`, `whitelist reload`) via stdin/RCON ; serveur **arrêté** → édition directe des fichiers. Jamais l'inverse (le serveur réécrit ces fichiers et écraserait l'édition).

> **Implémentation (phase 6)** : `apps/agent/src/minecraft/config-files.ts` (`ConfigService`) et `players.ts`. **`server.properties`** : toujours édité sur disque (le serveur ne le lit qu'au démarrage) via `updateProperties` — ordre, commentaires et clés inconnues conservés, `null` supprime une clé ; `restartRequired = true` si le serveur tourne, **sauf `white-list`** qui est aussi appliquée à chaud par `whitelist on|off`. **JSON** (whitelist/ops/bans) : lecture tolérante (entrées invalides ignorées, champs inconnus des entrées existantes **conservés** à l'écriture, ex. champs ajoutés par des mods) ; arrêté → réécriture complète du fichier avec valeurs par défaut (`level` = `op-permission-level`, `bypassesPlayerLimit` false, `created` au format Java `yyyy-MM-dd HH:mm:ss Z`, `source` `MMO`, `expires` `forever`) ; en marche → **diff** par UUID (ou nom) traduit en commandes (`whitelist add/remove`, `op/deop`, `ban/pardon [raison]`, `ban-ip/pardon-ip`) envoyées en RCON de préférence (réponse corrélée, échec détecté par motifs `does not exist`, `No player was found`… → `W_COMMAND_FAILED`), stdin en repli ; ce qui ne s'applique pas à chaud est signalé (`W_OP_LEVEL_LIVE`, `W_BAN_EXPIRES_LIVE`). L'état « en marche » couvre `starting/running/stopping`. **Identité** : `resolvePlayers` — `usercache.json` (insensible à la casse), puis Mojang `POST …/profile/lookup/bulk/byname` (lots de 10, délai 8 s, réseau coupé ⇒ `unknown`) si `online-mode=true`, sinon UUID v3 calculé ; en mode fichier une action sur un nom irrésoluble → `E_NOT_FOUND` (`uuid_unresolved`) ; une entrée portant le même UUID **ou** le même nom (casse ignorée) est remplacée, jamais dupliquée. Le **fake Java server** implémente ces commandes et réécrit les JSON comme le vrai (UUID hors ligne), ce qui permet de tester le routage de bout en bout. Côté UI : avatars `mc-heads.net` (repli initiales pour les UUID v3 / hors ligne), onglet Joueurs sans jamais exposer un fichier.
