# MinecraftManagerOnline

Application web de pilotage à distance de serveurs Minecraft auto-hébergés : démarrage/arrêt, console temps réel, joueurs, backups, planification — multi-machines, multi-OS (Windows / Linux / macOS, x64 et ARM), utilisable sur PC et mobile (PWA).

## Démarrage rapide (utilisateur)

1. **Récupérez l'archive du panel** `mmo-panel-<version>-<plateforme>.zip` (Windows) ou `.tar.gz` (Linux / macOS) depuis la page des releases du dépôt. S'il n'y en a pas (ou pas pour votre plateforme), construisez-la vous-même — Node ≥ 22 et pnpm suffisent :

   ```bash
   pnpm install
   pnpm release:build -- --panel
   ```

   L'archive apparaît dans `release/<version>/`. Deux choses à savoir : l'archive du **panel** est produite pour la plateforme sur laquelle vous buildez (construisez sous Linux pour héberger sous Linux — les archives d'**agents** des 4 plateformes sont, elles, toujours produites) ; sans clé de mainteneur le build est signé avec la clé de développement, ce que le panel affiche — pleinement fonctionnel pour un usage personnel.

2. **Suivez le [guide d'installation](docs/guide/installation.md)** : panel en deux commandes puis wizard du premier démarrage, agents installés en un clic depuis le panel, et accès pour vos amis et votre téléphone (Tailscale par défaut — fonctionne même sans IP publique).

## Documentation

- [Présentation du projet](docs/01-presentation.md)
- [Fonctionnalités](docs/02-fonctionnalites.md)
- [Socle technique](docs/03-socle-technique.md)
- [Base de données](docs/04-base-de-donnees.md)
- [Protocole panel-agent](docs/05-protocole.md)
- [Serveurs Minecraft](docs/06-minecraft.md)
- [Plan de développement](docs/07-plan-de-developpement.md)
- **Guide utilisateur** : [Installation](docs/guide/installation.md) · [Ajouter une machine](docs/guide/ajouter-une-machine.md) · [FAQ réseau](docs/guide/faq-reseau.md)
- [Pipeline de release](tools/release/README.md) — archives, signature, publication
- [Spikes de validation](docs/spikes/) — résultats des vérifications techniques de la phase 0
- [Contribuer](CONTRIBUTING.md) — prérequis, commandes, conventions

## Développement

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

Monorepo pnpm + Turborepo : `apps/panel` (API Fastify), `apps/web` (PWA React), `apps/agent` (bundle universel), `packages/protocol`, `packages/shared`, `packages/config`. Node 24 LTS (voir `.node-version`).

## Licence

Distribué sous licence [MIT](LICENSE).
