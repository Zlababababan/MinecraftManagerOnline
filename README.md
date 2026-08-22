# MinecraftManagerOnline

Application web de pilotage à distance de serveurs Minecraft auto-hébergés : démarrage/arrêt, console temps réel, joueurs, backups, planification — multi-machines, multi-OS (Windows / Linux / macOS, x64 et ARM), utilisable sur PC et mobile (PWA).

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

Projet propriétaire — tous droits réservés. Voir [LICENSE](LICENSE).
