# MinecraftManagerOnline

[![CI](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml/badge.svg)](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zlababababan/MinecraftManagerOnline)](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)
[![Licence](https://img.shields.io/github/license/Zlababababan/MinecraftManagerOnline)](LICENSE)

[English](README.md) · **Français** · [Español](README.es.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [中文](README.zh.md)

Pilotez vos serveurs Minecraft auto-hébergés depuis un navigateur — PC ou téléphone — même quand la machine qui les fait tourner est chez vous, derrière une box sans IP publique.

Un **panel** web central (la machine qui reste allumée) + un **agent** léger sur chaque machine qui héberge des serveurs. Les agents se connectent en sortie : rien à ouvrir sur les machines de jeu.

## Fonctionnalités

- **Console temps réel** (xterm) avec historique, commandes, et détection des événements du serveur ;
- **Démarrage / arrêt / redémarrage** à distance, y compris au boot de la machine — les serveurs Java sont détachés et **survivent** aux redémarrages et mises à jour de l'agent ;
- **Détection automatique** des serveurs existants (Vanilla, Forge, NeoForge, Fabric, 1.12 → 1.21 — éprouvée sur une bibliothèque réelle de 56 serveurs hétérogènes) ;
- **Sauvegardes à chaud** (`save-off`/`save-all`/`save-on`) avec rotation, planification, restauration en un clic et backup de sécurité ;
- **Planificateur en français simple** : « tous les jours à 8h00, 12h30 et 20h00 », « une seule fois le… », avertissements aux joueurs avant un arrêt — l'expression cron n'apparaît que dans un mode avancé ;
- **Joueurs** : liste en ligne, whitelist, ops, kick/ban ; **métriques** TPS/MSPT, CPU, RAM par serveur ;
- **Multi-machines** : agents Windows / Linux / macOS (x64 et ARM64) installés **en un clic** depuis le panel, mis à jour automatiquement (bundles signés Ed25519, rollback automatique en cas d'échec) ;
- **Accès distant sans IP publique** : Tailscale par défaut (fonctionne derrière CGNAT), ou IPv6 direct avec certificat automatique, ou votre propre reverse-proxy ;
- **Explorateur de fichiers**, upload/download avec reprise, migration d'un serveur d'une machine à l'autre ;
- **PWA** installable sur mobile, notifications push, thème sombre, interface entièrement bilingue (français/anglais), journal d'audit et comptes multi-utilisateurs (admin / opérateur / lecteur).

## Démarrage rapide

1. **Téléchargez l'archive du panel** correspondant à votre machine depuis la [dernière release](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest) — `win-x64` (Windows), `linux-x64`, `linux-arm64` (Raspberry Pi, serveurs ARM) ou `darwin-arm64` (Apple Silicon). Vous ne savez pas quel Linux ? `uname -m` : `x86_64` = x64, `aarch64` = ARM64.

2. **Extrayez et lancez.** Il n'y a rien à installer avant : l'archive embarque son propre runtime Node. Windows : extrayez, puis double-cliquez sur `mmo-panel.cmd`. Linux et macOS :

   ```bash
   tar -xzf mmo-panel-*.tar.gz
   cd mmo-panel
   ./mmo-panel.sh
   ```

   Ouvrez ensuite `http://127.0.0.1:3000`. Sur une machine sans navigateur, créez plutôt le compte en ligne de commande : `./mmo-panel.sh setup --username admin --random-password`. Si quelque chose cloche, `./mmo-panel.sh doctor` dit quoi et pourquoi.

3. **Suivez le [guide d'installation](docs/guide/fr/installation.md)** : wizard du premier démarrage, panel en service, agents installés en un clic depuis le panel, et accès pour vos amis et votre téléphone.

> Construire depuis les sources ne sert que pour une plateforme sans archive (macOS Intel) : `pnpm install && pnpm release:build -- --panel`, avec Node 24 et pnpm. L'archive du **panel** est produite pour la plateforme sur laquelle vous buildez ; celles des **agents** le sont pour les 4. Sans clé de mainteneur, le build est signé avec la clé de développement, ce que le panel affiche — pleinement fonctionnel pour un usage personnel.

## Plateformes

|                                 | Panel                         | Agent               |
| ------------------------------- | ----------------------------- | ------------------- |
| Windows x64                     | ✅ (archive fournie)          | ✅                  |
| Linux x64                       | ✅ (archive fournie)          | ✅                  |
| Linux ARM64 (Raspberry Pi 4/5…) | ✅ (archive fournie)          | ✅                  |
| macOS Apple Silicon             | ✅ (archive fournie)          | ✅                  |
| Windows ARM64                   | via l'archive x64 (émulation) | via x64 (émulation) |

Aucune dépendance à installer : chaque archive embarque son runtime Node épinglé, et depuis la 1.0.5 le panel ne contient **aucun module compilé** — tous les Linux à base de glibc fonctionnent (Ubuntu 20.04+, Debian 11+, Fedora, Rocky/Alma/RHEL 9, openSUSE, Raspberry Pi OS, Arch…), sans compilateur ni paquet de développement. Alpine et les systèmes à base de musl ne sont pas couverts par le runtime embarqué. Java est provisionné automatiquement par l'agent (Temurin → Zulu) selon la version Minecraft.

## Documentation

- **Guide utilisateur** : [Installation](docs/guide/fr/installation.md) · [Ajouter une machine](docs/guide/fr/ajouter-une-machine.md) · [FAQ réseau](docs/guide/fr/faq-reseau.md) — aussi disponible en [English](docs/guide/installation.md), [Español](docs/guide/es/installation.md), [Deutsch](docs/guide/de/installation.md), [Português](docs/guide/pt/installation.md), [Русский](docs/guide/ru/installation.md) et [中文](docs/guide/zh/installation.md)
- Conception : [Présentation](docs/01-presentation.md) · [Fonctionnalités](docs/02-fonctionnalites.md) · [Socle technique](docs/03-socle-technique.md) · [Base de données](docs/04-base-de-donnees.md) · [Protocole panel-agent](docs/05-protocole.md) · [Serveurs Minecraft](docs/06-minecraft.md) · [Plan de développement](docs/07-plan-de-developpement.md)
- [Pipeline de release](tools/release/README.md) — archives, signature, publication
- [Contribuer](CONTRIBUTING.fr.md) — prérequis, commandes, conventions

## Développement

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

Monorepo pnpm + Turborepo : `apps/panel` (API Fastify + SQLite), `apps/web` (PWA React), `apps/agent` (bundle universel esbuild, zéro module natif), `packages/protocol`, `packages/shared`, `packages/config`. Node 24 LTS épinglé (voir `.node-version`). Stack : TypeScript partout, Fastify 5, Zod 4, React 19, Mantine 8, Drizzle.

## Licence

Distribué sous licence [MIT](LICENSE).
