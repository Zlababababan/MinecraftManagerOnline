# Spikes de validation (phase 0)

Vérifications techniques réalisées **avant** le code de l'agent (doc 03 §10). Chaque note fait autorité sur le point qu'elle tranche ; les docs 03/05/06 y renvoient.

| # | Note | Verdict |
|---|---|---|
| 1 | [EOF stdin — survie des serveurs à la mort de l'agent](01-eof-stdin.md) | ✅ design confirmé sur 5 loaders ; `detached: true` obligatoire ; ne jamais tuer l'arbre de processus |
| 2 | [Monitoring Windows sans wmic](02-monitoring-windows.md) | ✅ libs OK sans wmic ; ❗ CPU par ticks faux sous Hyper-V → sidecar PowerShell + cycles |
| 3 | [zstd dans Node 24](03-zstd-node24.md) | ✅ zstd 3 par défaut, gzip en repli ; jamais `nbWorkers` ; intégrité par manifeste |

Scripts reproductibles dans [`scripts/`](scripts/) (`pnpm install --ignore-workspace` dans ce dossier ; hors workspace pnpm). Les résultats bruts JSON sont commités dans `scripts/results/`, les logs ignorés.
