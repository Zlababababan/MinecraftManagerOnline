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

## 2. Auto-détection d'un dossier serveur

### Signaux

| Signal | Donne |
|---|---|
| `libraries/net/neoforged/neoforge/<v>/` | NeoForge ; MC dérivée du schéma de version (`21.1.x` → 1.21.1) |
| `libraries/net/minecraftforge/forge/<mc>-<forge>/` | Forge ; argfiles présents ⇒ moderne, absents ⇒ jar universal |
| `forge-*.jar` racine sans `install_profile.json` | Forge legacy, MC dans le nom |
| `fabric-server-launch.jar` / `.fabric/` / `fabric-server-mc.*` | Fabric |
| `server.jar` | Vanilla ; version via `version.json` **dans** le jar (zip, champ `id`, ~1.14+) |
| `mods/*.jar` (échantillonner 3–5) | Confirmation : `fabric.mod.json` ⇒ Fabric ; `META-INF/mods.toml` ⇒ Forge ; `META-INF/neoforge.mods.toml` ⇒ NeoForge ; `mcmod.info` ⇒ Forge 1.12 |
| `user_jvm_args.txt` | RAM (`-Xmx`) Forge/NeoForge modernes |
| `variables.txt` | RAM des packs All The Mods (`JAVA_ARGS`) |
| `*.bat` / `*.sh` / `settings.cfg` / `server-setup-config.yaml` | Regex `-Xmx(\d+)([GgMmKk]?)` ; le yaml FTB ServerStarter contient MC + modloader |
| `server.properties` | port, RCON, motd, level-name |
| `logs/latest.log` | `Starting minecraft server version <X>` — excellent fallback |
| `eula.txt` | état EULA |

### Algorithme ordonné

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

- **Le pipe stdin/stdout suffit** pour tous les loaders/versions ciblés : commandes envoyées **sans** slash initial, terminées par `\n`, flush immédiat. **Ne jamais fermer stdin** (déclenche l'arrêt de la boucle console sur certaines versions — cf. spike EOF, doc 03 §10).
- **Encodage — le piège n°1 sur Windows** : Java ≤ 17 encode stdout selon le charset système (cp1252 sur un Windows FR) → accents cassés. Réglé par les flags UTF-8 injectés (§1) ; côté agent, pipes toujours décodés UTF-8 en mode tolérant (les mods écrivent parfois n'importe quoi). Filtre d'échappement ANSI prévu (certains packs forcent la couleur).
- **stdout = source de vérité temps réel** (contient les messages hors log4j : warnings JVM, crashs précoces, hs_err). `logs/latest.log` + `logs/*.log.gz` = archives pour la recherche. `logs/debug.log` non streamé par défaut.
- **Parsing des lignes** — deux formats + fallback :
  - Vanilla/Fabric/Forge 1.12 : `[HH:mm:ss] [Thread/LEVEL]…`
  - Forge/NeoForge modernes : `[ddMMMyyyy HH:mm:ss.SSS] [Thread/LEVEL] [logger/]: …`
  - Toute ligne qui ne matche aucun pattern (stacktraces) est rattachée à l'entrée précédente, même niveau. Niveaux : INFO/WARN/ERROR/FATAL/DEBUG/TRACE.
- **Autocomplétion console (V1 honnête)** : liste statique des commandes vanilla + pseudos depuis `usercache.json` + historique de l'utilisateur (pas d'accès à l'arbre Brigadier des mods).

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

1. **Signal principal : exit alors qu'aucun stop n'a été demandé par l'app.**
2. Nouveau `crash-reports/crash-*-server.txt` pendant la session → attaché à l'événement (parsing du header : cause, mod fautif).
3. Patterns : `Encountered an unexpected exception`, `Exception in server tick loop`, `java.lang.OutOfMemoryError`, `A single server tick took 60.00 seconds`.
4. `hs_err_pid*.log` à la racine = crash JVM natif.

Auto-restart optionnel avec garde anti-boucle (`crash_loop_max` par fenêtre).

### Freeze

- `max-tick-time` vanilla n'est pas exploitable (les modpacks le désactivent).
- **Détection agent** : sonde RCON `list` toutes les 30–60 s, timeout 5 s ; 3 échecs consécutifs process vivant ⇒ freeze suspecté → notification + action configurable (rien / kill+restart). RCON plutôt que stdin car la réponse est corrélée à la requête.
- Alerte précoce : MSPT en continu (§6) + patterns `Can't keep up!`.

## 5. RCON

- Auto-provisionnement par l'agent (décision doc 03) : `enable-rcon=true`, `rcon.port` unique par machine, `rcon.password` fort généré — actif au prochain restart du serveur ; badge UI « arrêt propre dégradé » tant qu'inactif. RCON écoute sur toutes les interfaces, en clair → **port bloqué hors machine locale** (pare-feu + ACL réseau).
- Protocole Source RCON (TCP little-endian) : `[len][reqId][type][payload][2×null]` ; login = type 3, commande = type 2. Implémentation maison ~100 lignes, reconnexion auto, **file de commandes sérialisée** (le serveur traite une commande RCON à la fois).
- Limites : commande ≤ 1446 octets ; réponses fragmentées par 4096 octets sans marqueur de fin → technique du « paquet junk » pour détecter la fin ; parser en mode tolérant (bug MC-270327). Les réponses asynchrones (spark) et broadcasts de mods ne passent pas par RCON.
- **Architecture : stdin = canal principal, RCON = complément** (sondes de vivacité, TPS, `list` parsé, backup à chaud, et seul canal en mode `detached`).

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
