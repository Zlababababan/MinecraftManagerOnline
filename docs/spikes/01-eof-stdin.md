# Spike n°1 — Survie des serveurs Minecraft à la mort de l'agent (EOF stdin)

**Date** : 2026-08-21 · **Question** (doc 03 §10, doc 07 phase 0) : quand le pipe stdin se ferme (crash/redémarrage/mise à jour de l'agent), le serveur Java survit-il ? Reste-t-il pilotable ? Conditionne le modèle « les serveurs ne tombent jamais » (doc 03 §3) et le mode `detached` (doc 05/06).

**Verdict** : ✅ **Confirmé sur toute la matrice** — Vanilla 1.20.1, Forge 1.12.2, Forge 1.16.5, Fabric 1.21.1, NeoForge 1.21.1 : le serveur survit à la mort brutale de l'agent **et** à la fermeture explicite de stdin, sans boucle CPU folle, reste pilotable par RCON, continue d'écrire `logs/latest.log`, et s'arrête proprement sur `stop` RCON. Aucune exception liée aux pipes dans les logs. Le design (stdin = canal principal, RCON = complément et seul canal en `detached`) est **validé tel quel**. Deux conditions découvertes : `detached: true` obligatoire sous Windows, et **ne jamais tuer l'arbre de processus** de l'agent.

## Banc d'essai

- Windows 11 Pro 23H2, i7-10700KF, 32 Go. JDK 8u281 (1.12/1.16), 17.0.5 (1.20), 21.0.3 (1.21). Node 22.14 (driver).
- **Copies** des serveurs de `E:\Minecraft\Server` (robocopy sans `world`/`backups`/`logs` ; monde neuf `spikeworld`, `online-mode=false`, RCON activé sur un port dédié, `max-tick-time=-1`). Les originaux n'ont pas été touchés.
- Scripts : [`scripts/eof-stdin.mjs`](scripts/eof-stdin.mjs) (driver), [`scripts/fake-agent.mjs`](scripts/fake-agent.mjs) (faux agent), [`scripts/rcon.mjs`](scripts/rcon.mjs), [`scripts/procinfo.mjs`](scripts/procinfo.mjs), [`scripts/summarize.mjs`](scripts/summarize.mjs). Résultats bruts : `scripts/results/eof-run*.json`.

| Serveur copié | Loader / version | Java | Lancement |
|---|---|---|---|
| `Vanilla 1.20.1\server` | Vanilla 1.20.1 | 17 | `-jar server.jar nogui` |
| `SkyFactory4` | Forge 1.12.2-14.23.5.2860 | 8 | `-jar forge-1.12.2-….jar nogui` |
| `RAD2v1.7` | Forge 1.16.5-36.2.39 | 8 | `-jar forge-1.16.5-….jar nogui` |
| `DungeonHeroes_2.4.9` | Fabric 1.21.1 (loader 0.17.3) | 21 | `-jar fabric-server-launcher.jar nogui` |
| `ATM10_6.0` | NeoForge 21.1.219 (1.21.1) | 21 | `@libraries/net/neoforged/neoforge/21.1.219/win_args.txt nogui` |

`Prominence_II_v3.0.2` (Fabric 1.20.1) était prévu mais le pack tel qu'il est sur disque ne démarre pas (loader 0.15.11 < 0.16.10 exigé par ses mods) — remplacé par Dungeon Heroes. Un Forge 1.20.1 n'a pas été testé (ATM9) : même code de console que 1.16.5 et NeoForge 1.21.1, jugé non nécessaire.

## Scénarios

1. **`parent-crash`** (le cas réel) : un « faux agent » Node lance `java` avec `spawn(…, { detached: true, stdio: ['pipe','pipe','pipe'], windowsHide: true })`, attend `Done`, puis est tué par `taskkill /F` (sans `/T`). Le serveur perd d'un coup stdin (EOF) **et** stdout/stderr (pipes cassés).
2. **`stdin-eof`** : le driver lance `java` lui-même, attend `Done`, puis `child.stdin.end()` en gardant stdout — isole l'effet de l'EOF seul et vérifie que stdout continue de couler.

Observations après l'événement : vivant à +3 s et +20 s ; CPU sur 10 s (boucle folle ?) ; RCON `list` et `say` ; `logs/latest.log` encore alimenté ; `stop` via RCON et sortie sous 120 s ; anomalies (`Exception`, `Broken pipe`, `Stream closed`…) dans le log après l'événement.

## Résultats

CPU = % d'un cœur, mesuré par **cycles** (`QueryProcessCycleTime`, cf. spike n°2) pour les runs 2 et 3 ; le run 1 (Forge 1.12/1.16) a été mesuré par ticks (valeurs sous-évaluées, mais le critère « pas de boucle folle » est confirmé par les runs 3 à la mesure fiable).

| Serveur | Scénario | Démarrage | CPU avant → après | Vivant +3 s / +20 s | RCON `list`/`say` | `latest.log` écrit | `stop` → sortie propre | stdout continue | Anomalies |
|---|---|---|---|---|---|---|---|---|---|
| Vanilla 1.20.1 | parent-crash | 12–32 s | 1,8 % → 0,1 % (ticks) ; voir run 3 | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ | n/a | 0 |
| Vanilla 1.20.1 | stdin-eof | 20 s | 1,1 % → 0,2 % (ticks) | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ code 0 | ✅ | 0 |
| Forge 1.12.2 | parent-crash | 66 s | 2 % → 0 % (ticks) ; voir run 3 | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ | n/a | 0 |
| Forge 1.12.2 | stdin-eof | 70 s | 1,7 % → 0 % (ticks) | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ code 0 | ✅ | 0 |
| Forge 1.16.5 | parent-crash | 103 s | 11,6 % → 1,1 % (ticks) ; voir run 3 | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ | n/a | 0 |
| Forge 1.16.5 | stdin-eof | 64 s | 9,1 % → 0,2 % (ticks) | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ code 0 | ✅ | 0 |
| Fabric 1.21.1 | parent-crash | 70 s | 83 % → 11 % | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ | n/a | 0 |
| Fabric 1.21.1 | stdin-eof | 36 s | 80 % → 14 % | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ code 0 | ✅ | 0 |
| NeoForge 1.21.1 | parent-crash | 157 s | 345 % → 22 % | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ | n/a | 0 |
| NeoForge 1.21.1 | stdin-eof | 137 s | 416 % → 21 % | ✅ / ✅ | ✅ / ✅ | ✅ | ✅ code 0 | ✅ | 0 |

Run 3 (`parent-crash` rejoué avec la mesure CPU par cycles) :

| Serveur | Démarrage | CPU avant → après (cycles) | Vivant +3 s / +20 s | RCON | `latest.log` | `stop` → sortie | Anomalies |
|---|---|---|---|---|---|---|---|
| Vanilla 1.20.1 | 14 s | 9 % → 5,5 % | ✅ / ✅ | ✅ | ✅ | ✅ | 0 |
| Forge 1.12.2 | 70 s | 53 % → 2 % | ✅ / ✅ | ✅ | ✅ | ✅ | 0 |
| Forge 1.16.5 | 62 s | 117 % → 7 % | ✅ / ✅ | ✅ | ✅ | ✅ | 0 |

Le CPU « avant » élevé sur les packs modernes est la génération des chunks de spawn juste après `Done` ; la baisse « après » est la stabilisation, pas un effet de l'EOF. Dans tous les cas, le thread console se termine silencieusement sur EOF (`readLine()` → `null`) et le serveur continue.

## Enseignements au-delà de la question posée

1. **`detached: true` est obligatoire sous Windows.** Sans lui, libuv enrôle l'enfant dans un Job Object « kill on close » : la mort de l'agent tue java. Avec lui, java survit (constaté).
2. **Ne jamais tuer l'arbre de processus de l'agent.** Mon premier essai utilisait `taskkill /PID … /T /F` : java, bien que détaché, a été tué avec le faux agent (Windows suit la parenté). Conséquence pour la phase 11 : le service Windows (shawl/WinSW), l'unit systemd (`KillMode=process`, pas `control-group`) et le LaunchDaemon (`AbandonProcessGroup=true`) doivent être configurés et **testés** pour ne jamais propager l'arrêt aux serveurs. Doc 03 §3 amendé.
3. **Pas de fuite côté serveur quand stdout est cassé** : aucun `IOException`/`Broken pipe` dans `latest.log` après la mort du parent (les appenders log4j/PrintStream avalent l'erreur). Le serveur orphelin n'écrit plus que dans ses fichiers de log — d'où le « tail de logfile » du mode `detached` (doc 05), confirmé nécessaire.
4. **Locale** : les serveurs sous Windows FR écrivent `Done (5,309s)!` (virgule décimale). Le parseur de l'agent (phase 2) doit accepter `[\d.,]+`.
5. Temps de démarrage réels (monde neuf, PC rapide) : 12 s vanilla → 2 min 40 ATM10 : le timeout de démarrage par défaut de 10 min (doc 05) est confortable.
6. `enable-rcon=true` + mot de passe + port dédié fonctionne sur les 5 serveurs sans autre réglage, y compris 1.12.2 — l'auto-provisionnement RCON (doc 06 §5) ne pose pas de problème de compatibilité.

## Décisions

- Aucun changement de design : **stdin pipé = canal principal, RCON = complément et canal exclusif en `detached`**, serveurs lancés `detached: true`, ré-adoption par PID + heure de démarrage + ligne de commande. La variante « java sans stdin, 100 % RCON » prévue en repli n'est pas nécessaire.
- Doc 06 §3 : la règle « ne jamais fermer stdin » est reformulée (l'EOF ne tue pas le serveur mais ferme définitivement la console jusqu'au prochain redémarrage).
- Phase 11 : tests par OS « stop/restart du service agent ⇒ les serveurs restent vivants ».
