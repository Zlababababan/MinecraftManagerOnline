# Pipeline de release (phase 11, doc 03 §3)

Pur Node (≥ 22), sans python ni dépendance : lecteur/écrivain tar.gz et zip maison (`archive.mjs`), runtimes épinglés par sha256 (`constants.mjs`).

| Script         | Rôle                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build.mjs`    | Build de l'agent, archives des 4 plateformes (`runtime/` Node officiel + `versions/<v>/agent.js` + `launcher.cjs` + scripts d'installation, shawl sous Windows), `manifest.json` signé ; `--panel` ajoute l'archive du panel pour la plateforme de build |
| `smoke.mjs`    | Vérifie chaque archive (sha256, contenu, modes) et exécute `launcher.cjs --version` avec le runtime embarqué sur la plateforme courante                                     |
| `publish.mjs`  | Dépose une release dans un panel (API admin : fichiers puis manifeste — sha256 vérifiés, release d'agent créée) ou par copie locale (`--dist-dir`)                           |

```bash
pnpm release:build               # release/<version>/ (clé de développement, avertissement)
pnpm release:build -- --panel    # + mmo-panel-<v>-<hôte>.zip|tar.gz (pnpm deploy, modules natifs de l'hôte)
pnpm release:smoke
pnpm release:publish -- --panel https://panel --user admin
```

## Clé de signature

La clé privée Ed25519 vit **chez le mainteneur, hors dépôt** (doc 03 §3) :

1. `node tools/signing/keygen.mjs <dossier-hors-dépôt>` → `private.pem` + `public.txt`.
2. Ajouter la clé publique (SPKI base64) dans `apps/agent/src/update/keys.ts` (`RELEASE_KEYS`, plusieurs clés acceptées = rotation) et livrer cette version d'agent **avant** de signer avec la nouvelle clé. La clé de développement n'est présente que dans les builds non `--release` (`MMO_RELEASE_BUILD`, esbuild `define`).
3. `MMO_SIGNING_KEY=<chemin>/private.pem pnpm release:build -- --release` (ou `--key`). Sans clé, la clé de développement `tools/signing/dev.private.pem` est utilisée et `--release` refuse ; le manifeste porte `signingKey: "dev"` et le panel l'affiche (Réglages → Distribution).
4. CI : le workflow `release.yml` (tag `v*`) lit le secret `MMO_SIGNING_KEY_PEM`.
5. **Release 1.0.0 (2026-08-23)** : clé générée chez le mainteneur (`C:\Users\<user>\.mmo\signing\mmo-release.private.pem`, publique `MCowBQYDK2VwAyEAiUDWJLKR+sl8iyPeWm3DEVze+zj+an5PAoQVviUh/Sc=` embarquée), archives des 4 plateformes + panel win-x64 construites avec `--release --panel`, `smoke.mjs` vert (sha256, contenu, `launcher.cjs --version` sur le runtime embarqué).

Reproductibilité : entrées triées, horodatages = `SOURCE_DATE_EPOCH` (0 par défaut), modes explicites ; deux builds du même commit donnent les mêmes sha256 (vérifié).

## Disposition d'une archive agent

```
mmo-agent/
  launcher.cjs                 figé (doc 03 §3), `--version` = exécution unique
  versions/<v>/agent.js        bundle universel signé
  current.json                 { "version": "<v>" }
  runtime/<node>/node(.exe)    runtime Node épinglé (+ LICENSE)
  runtime-current.json         { "version": "<node>" }
  manifest.json                version, plateforme, sha256 + signature du bundle
  install.ps1 / install.sh     mêmes scripts que ceux servis par le panel (hors ligne : --archive)
  shawl.exe                    (Windows) wrapper de service, MIT
```

Service : `<runtime>/node <home>/launcher.cjs run --panel wss://<panel>/ws/agent --state-dir <état>` ; le launcher applique les mises à jour (`next.json`, exit 75, rollback N-1).
