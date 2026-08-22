# Signature des bundles agent (Ed25519)

- `keygen.mjs <dossier>` : génère une paire de clés. La **clé privée ne vit jamais sur le panel**
  (doc 03 §3) — chez le mainteneur uniquement. La clé publique (SPKI DER base64) s'ajoute dans
  `apps/agent/src/update/keys.ts` (plusieurs clés acceptées : rotation possible).
- `sign.mjs <bundle.js> [--key <pem>] [--json]` : calcule sha256 + signature du bundle, à fournir au
  panel lors de la publication (`PUT /api/admin/agent-releases?version=…&signature=…`, corps = bundle).

`dev.private.pem` / `dev.public.txt` : paire **de développement** (la clé publique correspondante est
embarquée dans l'agent pour pouvoir tester les mises à jour de bout en bout et construire des releases
locales). **Phase 11** : la release publique se signe avec une clé générée ici mais conservée hors dépôt
(`MMO_SIGNING_KEY`, secret CI `MMO_SIGNING_KEY_PEM`) — `tools/release/build.mjs --release` refuse la clé
de développement et vérifie que la clé publique est bien dans `keys.ts`. Procédure : `tools/release/README.md`.
