# Spike n°2 — Monitoring Windows 11 sans `wmic`

**Date** : 2026-08-21 · **Question** (doc 03 §10) : `systeminformation` / `pidusage` fonctionnent-ils sur Windows 11 récent, où `wmic` est supprimé (24H2+) ? Sinon, quel fallback ?

**Verdict** : ✅ les deux bibliothèques n'ont **plus besoin de `wmic`**. ❗ Mais le spike révèle un problème plus grave et non anticipé : **sur un hôte où Hyper-V est actif, toutes les sources « par ticks » de temps CPU par process (`GetProcessTimes`, `Win32_Process`, compteurs `% Processor Time`, Gestionnaire des tâches, donc `pidusage` et `systeminformation`) sont fausses d'un facteur 25–60×.** Seule la comptabilité **par cycles** (`QueryProcessCycleTime`) est exacte. Le fallback « PowerShell CIM maison » prévu au doc 03 aurait donc été faux lui aussi.

## Banc d'essai

- Windows 11 Pro **23H2** (build 22631), Intel i7-10700KF (8c/16t, 3,8 GHz nominal), 32 Go. **Hyper-V présent** (`HypervisorPresent=True`, VBS/Memory Integrity actif, WSL2 installé).
- `wmic` est encore présent sur 23H2 → son absence (24H2+) est **simulée** en retirant `System32\Wbem` du `PATH` ; complété par la lecture du code source des deux bibliothèques.
- Node 24.19.0, `pidusage` 4.0.1, `systeminformation` 5.33.1.
- Scripts : [`scripts/monitoring.mjs`](scripts/monitoring.mjs) (latences et cohérence), [`scripts/cpu-cycles.ps1`](scripts/cpu-cycles.ps1) + [`scripts/cpu-cycles.mjs`](scripts/cpu-cycles.mjs) (prototype de l'échantillonneur par cycles), [`scripts/procinfo.mjs`](scripts/procinfo.mjs) (mesure de référence).

## 1. Les bibliothèques sans `wmic`

| Bibliothèque | Mécanisme Windows (lecture du code) | Sans `Wbem` dans le PATH |
|---|---|---|
| `pidusage` 4.0.1 | `stats.js` tente `spawn('wmic', callback)` — appel invalide (options = fonction) qui **lève toujours** une exception synchrone → bascule systématiquement sur `gwmi.js` = `Get-WmiObject win32_process` via `powershell.exe` (Windows PowerShell 5.1) | ✅ identique (n'utilisait déjà pas wmic) |
| `systeminformation` 5.33.1 | zéro occurrence de `wmic` ; tout passe par `powershell.exe` (`Get-CimInstance`, compteurs `.NET`) | ✅ identique |

Latences mesurées (un `powershell.exe` spawné par appel) :

| Appel | Latence | Remarque |
|---|---|---|
| `pidusage(pid)` | 430–1030 ms | 1er appel à froid ~1 s ; lot de 2 PID 870 ms |
| `si.currentLoad()` | 510 ms | **0 ms** et `si.mem()` 360 ms avec `si.powerShellStart()` (session persistante) |
| `si.mem()` / `si.fsSize()` | 285 / 340 ms | |
| `si.osInfo()` / `si.cpu()` | 485 / 1350 ms | à ne faire qu'au démarrage |
| `si.processes()` (liste complète) | 450 ms | |
| `si.networkStats()` | 2270 ms | 1re lecture (intervalle de mesure interne) |
| `si.cpuTemperature()` | 985 ms | `main=null` sur cette machine |

Pour un cycle de métriques toutes les 15 s, ces latences sont acceptables **à condition d'utiliser une session PowerShell persistante** (sinon ~1 s de CPU de spawn par cycle et par serveur).

`pidusage` émet un `DeprecationWarning` DEP0190 (args + `shell: true`) sur Node 24 — bénin mais bruyant.

## 2. Le vrai problème : la comptabilité CPU par ticks est fausse sous Hyper-V

Protocole : un process Node qui sature un cœur (`while (Date.now()-t < N) {}` — vérifié par le nombre d'itérations : 36 M en 3 s), mesuré par toutes les sources disponibles sur 4 s :

| Source | Valeur mesurée | Attendu (1 cœur plein sur 16) | Verdict |
|---|---|---|---|
| `GetProcessTimes` (`process.cpuUsage()`, `Get-Process.TotalProcessorTime`) | **62 ms / 4000 ms = 1,5 %** | ~100 % d'un cœur | ❌ |
| `Win32_Process.UserModeTime` (CIM/WMI = source de `pidusage` et `systeminformation`) | idem (même compteur noyau) | | ❌ |
| Compteur `\Process(x)\% Processor Time` | 1,6 % | 100 % | ❌ |
| Compteur `\Processor(_Total)\% Processor Time` | 0,6 % | ≥ 6,25 % | ❌ |
| `si.currentLoad()` | 0,9 % | ≥ 6,25 % | ❌ |
| **`QueryProcessCycleTime`** (cycles CPU) | 14,98 G cycles ≈ **3,94 s à 3,8 GHz** | 4 s | ✅ |
| **Compteur `\Processor Information(_Total)\% Processor Utility`** | 15,7 % (vs 0,6 % au repos) | ≥ 6,25 % (normalisé fréquence nominale, turbo inclus) | ✅ |
| `Win32_Processor.LoadPercentage` | 14 % | | ✅ (dérivé de l'« utility ») |

Même résultat hors du sandbox de l'outil, pour un process PowerShell, et pour Node 22 comme 24 : c'est la machine. Cause : avec l'hyperviseur actif, la partition racine ne reçoit plus les interruptions d'horloge qui servent au noyau à « facturer » le temps CPU au thread courant ; les compteurs par ticks s'effondrent, la comptabilité par cycles (lue sur le compteur matériel au changement de contexte) reste juste. C'est une configuration **courante** chez la cible du projet (Docker Desktop, WSL2, « Intégrité de la mémoire » activée par défaut sur les PC récents).

## 3. Prototype retenu : échantillonneur par cycles via PowerShell persistant

[`cpu-cycles.ps1`](scripts/cpu-cycles.ps1) : un process PowerShell lancé une fois par l'agent, qui compile au démarrage un P/Invoke (`Add-Type`) vers `QueryProcessCycleTime`, puis répond ligne par ligne (JSON) sur stdin/stdout : pour une liste de PID → cycles + RSS, plus `% Processor Utility` global.

| Mesure | Windows PowerShell 5.1 (toujours présent) | pwsh 7 |
|---|---|---|
| Démarrage (Add-Type + compteurs) | 1,9 s | 2,4 s |
| Latence par échantillon (3 PID) | 23–31 ms | 8–14 ms |
| CPU du process « burner » calculé par cycles | **99–100 % d'un cœur** | 99–100 % |
| Le même par `pidusage` au même instant | 0,4–2,6 % | 0,4–3,7 % |
| RSS du process PowerShell résident | 84 Mo | 169 Mo |

Pièges rencontrés : en PS 5.1 l'accélérateur `[ulong]` n'existe pas (`[uint64]` obligatoire) ; la première lecture d'un `PerformanceCounter` vaut toujours 0 (amorçage nécessaire) ; `Add-Type` écrit un `.cs` temporaire dans `%TEMP%` (compilation csc du .NET Framework — présent sur tout Windows 10/11, y compris ARM64).

CPU % = Δcycles / (Δt × fréquence nominale) — exprimé « en cœurs » (100 % = un cœur nominal saturé ; un process turbo peut dépasser 100 % d'un cœur, on borne à `cores × 100`). Le RSS (`WorkingSet64`) est fiable par toutes les sources.

## 4. Décisions proposées (→ doc 03 §1 « Bibliothèques sensibles »)

1. **Windows** : métriques process (CPU, RSS) et charge CPU globale via un **sidecar PowerShell persistant** (`cpu-cycles.ps1` embarqué dans le bundle sous forme de chaîne, aucun module natif) : cycles pour les process, `% Processor Utility` pour la machine. Redémarré automatiquement s'il meurt ; si PowerShell est indisponible (cas théorique), repli sur `pidusage` avec `cpuSource: 'ticks'` dans les métriques.
2. **Linux / macOS** : `pidusage` (lecture `/proc` et `ps`, comptabilité exacte) — conservé tel quel, validé par la CI ubuntu/ubuntu-arm/macos avec le fake Java server.
3. **`systeminformation`** conservé pour l'inventaire au démarrage (OS, CPU, RAM totale, volumes) et pour `mem()` / `fsSize()` périodiques, avec `powerShellStart()` sur Windows. **Pas** pour la charge CPU sur Windows.
4. Le protocole (doc 05, message de métriques) gagne un champ optionnel `cpuSource: 'cycles' | 'proc' | 'ticks'` pour que le panel sache afficher un avertissement si la valeur est potentiellement sous-évaluée — évolution par ajout, compatible.
5. Test CI Windows dédié : le test « burner » de ce spike (un process qui sature un cœur doit être mesuré > 80 % d'un cœur) devient un test d'intégration de l'agent.
