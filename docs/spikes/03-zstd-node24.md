# Spike n°3 — zstd dans `node:zlib` (Node 24)

**Date** : 2026-08-21 · **Question** (doc 03 §10) : l'API zstd de `node:zlib` est-elle disponible et utilisable en streaming dans Node 24 ? Sinon gzip par défaut, zstd = capacité future.

**Verdict** : ✅ **zstd est disponible, stable et 5 à 9× plus rapide que gzip** à ratio égal ou meilleur → **zstd devient la compression par défaut des backups et transferts** (négociée ; gzip reste le repli universel). Deux garde-fous obligatoires, issus de bugs constatés : **jamais `nbWorkers`**, et **intégrité vérifiée hors zstd** (un flux tronqué est accepté sans erreur).

## Banc d'essai

- Node **24.19.0** (zlib 1.3.2.1, **zstd 1.5.7** exposé dans `process.versions.zstd`) — installé via `pnpm env`, isolé du Node 22.14 de la machine.
- Contre-épreuve Node **22.14.0** : aucune fonction `zstd*` (l'API est arrivée en 22.15 / 23.8) → `process.versions.zstd` est le bon test de capacité.
- Script : [`scripts/zstd.mjs`](scripts/zstd.mjs). Échantillons : 76 Mo synthétiques (moitié JSON répétitif, moitié bruit) et 11 Mo **réels** (région `.mca`, `level.dat`, JSON d'un monde généré par la copie Vanilla 1.20.1 du spike n°1).

## 1. API

Complète : `zstdCompress[Sync]`, `zstdDecompress[Sync]`, `createZstdCompress`, `createZstdDecompress` ; options via `params: { [zlib.constants.ZSTD_c_compressionLevel]: n, [ZSTD_c_checksumFlag]: 1, … }` ; constantes `ZSTD_*` ; flux standard (magic `0xFD2FB528`, lisible par l'outil `zstd` ou toute autre implémentation). `Transform` classique → `pipeline()` avec `archiver` fonctionne tel quel.

## 2. Performances (streaming, un seul thread, i7-10700KF)

Données synthétiques 76 Mo :

| Codec | Ratio | Compression | Décompression |
|---|---|---|---|
| gzip 6 (défaut) | 3,14× | 84 Mo/s | 274 Mo/s |
| gzip 1 | 2,71× | 103 Mo/s | 237 Mo/s |
| **zstd 1** | 3,16× | **1081 Mo/s** | 494 Mo/s |
| **zstd 3 (défaut zstd)** | 3,16× | **642 Mo/s** | 531 Mo/s |
| zstd 6 | 3,24× | 146 Mo/s | 373 Mo/s |
| zstd 10 | 3,59× | 75 Mo/s | 408 Mo/s |

Données réelles (monde Minecraft, 11 Mo — les régions `.mca` sont déjà compressées en zlib par le jeu, d'où les ratios faibles) :

| Codec | Ratio | Compression | Décompression |
|---|---|---|---|
| gzip 6 | 1,73× | 56 Mo/s | 216 Mo/s |
| zstd 1 | 1,79× | 406 Mo/s | 413 Mo/s |
| **zstd 3** | 1,82× | **251 Mo/s** | 392 Mo/s |
| zstd 6 | 1,83× | 145 Mo/s | 473 Mo/s |

Lecture : sur un monde, la compression est de toute façon limitée par le disque et par la compression interne des régions ; zstd 3 est ~4,5× plus rapide que gzip 6 pour un meilleur ratio, ce qui réduit d'autant la fenêtre de backup (et la charge CPU sur un Raspberry Pi). Niveau recommandé : **3** (au-delà, le gain de taille est marginal et le coût CPU explose).

## 3. Bugs et pièges constatés (Node 24.19)

| Cas | Comportement | Conséquence pour l'agent |
|---|---|---|
| `ZSTD_c_nbWorkers > 0` (multithread) + **une seule écriture ≥ ~10 Mo** | le flux produit **0 octet, sans erreur** (avec des écritures ≤ 4 Mo, résultat correct) | **Interdit** d'activer `nbWorkers` (règle ESLint à ajouter en phase 8). Le multithread n'apporte rien : les backups tournent déjà dans un `worker_thread`. |
| Flux zstd **tronqué** (moitié du fichier) | `zstdDecompressSync` → renvoie **0 octet sans erreur** ; `createZstdDecompress` → termine **sans erreur** et sans données (gzip, lui, lève `Z_BUF_ERROR unexpected end of file`) | L'intégrité ne peut pas reposer sur le codec : **SHA-256 du fichier** dans le manifeste de backup/transfert (déjà prévu doc 05) + taille attendue ; refuser toute archive sans manifeste valide. |
| Flux **corrompu** (1 octet, `checksumFlag` actif) | erreur `ZSTD_error_corruption_detected` | ✅ activer `ZSTD_c_checksumFlag: 1` systématiquement (coût nul). |
| Données non-zstd | erreur `ZSTD_error_prefix_unknown` | ✅ |
| Node < 22.15 | API absente | capacité annoncée par l'agent à l'appairage (`compression: ['zstd','gzip']`), jamais présumée. |

## 4. Décisions proposées (→ doc 03 §1 « Bibliothèques sensibles », doc 05 transferts)

1. Compression des **backups** : **zstd niveau 3** par défaut, `checksumFlag` activé, gzip en repli (option par serveur, et automatique si le runtime ne supporte pas zstd). Extension `.tar.zst` / `.tar.gz` selon le codec ; le manifeste porte `codec`, `sha256`, `size`.
2. Compression des **transferts binaires** panel↔agent (jalon C) : capacité négociée à l'appairage, zstd préféré, gzip garanti.
3. **Jamais `nbWorkers`** ; pas de dictionnaires (inutile à cette échelle).
4. Note de prudence : le sous-système zstd de Node est récent (22.15+) ; le test de contrat « flux tronqué doit être détecté par le manifeste » est ajouté à la suite de tests backups pour ne pas dépendre d'un futur changement de comportement de Node.
