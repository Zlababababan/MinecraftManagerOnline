# MinecraftManagerOnline

[![CI](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml/badge.svg)](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zlababababan/MinecraftManagerOnline)](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)
[![License](https://img.shields.io/github/license/Zlababababan/MinecraftManagerOnline)](LICENSE)

**English** · [Français](README.fr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [中文](README.zh.md)

Control your self-hosted Minecraft servers from a browser — desktop or phone — even when the machine running them sits at home, behind a box with no public IP.

A central web **panel** (the machine that stays on) + a lightweight **agent** on every machine that hosts servers. Agents connect outbound: nothing to open on the game machines.

## Features

- **Real-time console** (xterm) with history, commands, and server event detection;
- **Start / stop / restart** remotely, including at machine boot — Java servers are detached and **survive** agent restarts and updates;
- **Automatic detection** of existing servers (Vanilla, Forge, NeoForge, Fabric, 1.12 → 1.21 — proven on a real library of 56 heterogeneous servers);
- **Hot backups** (`save-off`/`save-all`/`save-on`) with rotation, scheduling, one-click restore and safety backup;
- **Plain-language scheduler**: "every day at 8:00, 12:30 and 20:00", "one time only on…", player warnings before a stop — the cron expression only appears in an advanced mode;
- **Players**: online list, whitelist, ops, kick/ban; per-server **metrics**: TPS/MSPT, CPU, RAM;
- **Multi-machine**: Windows / Linux / macOS agents (x64 and ARM64) installed **in one click** from the panel, updated automatically (Ed25519-signed bundles, automatic rollback on failure);
- **Remote access without a public IP**: Tailscale by default (works behind CGNAT), or direct IPv6 with automatic certificates, or your own reverse proxy;
- **File explorer**, resumable upload/download, server migration from one machine to another;
- **PWA** installable on mobile, push notifications, dark theme, fully bilingual interface (English/French), audit log and multi-user accounts (administrator / operator / viewer).

## Quick start

1. **Download the panel archive** `mmo-panel-<version>-<platform>.zip` (Windows) or `.tar.gz` (Linux / macOS) from the [releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases). If there is none for your platform, build it yourself — Node ≥ 22 and pnpm are all you need. On a fresh machine (e.g. a Linux ARM VM), install them first — standalone pnpm, then Node through it — and clone this repository:

   ```bash
   sudo apt install -y git curl build-essential       # Debian/Ubuntu — the compiler is needed when no prebuilt SQLite binary exists for your platform (e.g. Linux ARM)
   curl -fsSL https://get.pnpm.io/install.sh | sh -   # then open a new shell
   pnpm env use --global 24
   git clone https://github.com/Zlababababan/MinecraftManagerOnline.git && cd MinecraftManagerOnline
   ```

   Then build:

   ```bash
   pnpm install
   pnpm release:build -- --panel
   ```

   The archive shows up in `release/<version>/`. Two things to know: the **panel** archive is produced for the platform you build on (build on Linux to host on Linux — the **agent** archives for all 4 platforms are always produced); without a maintainer key the build is signed with the development key, which the panel points out — fully functional for personal use.

2. **Follow the [installation guide](docs/guide/installation.md)**: panel in two commands then the first-start wizard, agents installed in one click from the panel, and access for your friends and your phone.

## Platforms

|                                  | Panel                        | Agent               |
| -------------------------------- | ---------------------------- | ------------------- |
| Windows x64                      | ✅ (archive provided)        | ✅                  |
| Linux x64                        | ✅ (archive provided)       | ✅                  |
| Linux ARM64 (Raspberry Pi 4/5…)  | ✅ (archive provided)       | ✅                  |
| macOS Apple Silicon              | ✅ (archive provided)       | ✅                  |
| Windows ARM64                    | via the x64 archive (emulation) | via x64 (emulation) |

No dependency to install: each archive embeds its pinned Node runtime. Linux archives run on glibc ≥ 2.31 (Ubuntu 20.04+, Debian 11+). Java is provisioned automatically by the agent (Temurin → Zulu) to match the Minecraft version.

## Documentation

- **User guide**: [Installation](docs/guide/installation.md) · [Add a machine](docs/guide/add-a-machine.md) · [Network FAQ](docs/guide/network-faq.md) — also available in [Français](docs/guide/fr/installation.md), [Español](docs/guide/es/installation.md), [Deutsch](docs/guide/de/installation.md), [Português](docs/guide/pt/installation.md), [Русский](docs/guide/ru/installation.md) and [中文](docs/guide/zh/installation.md)
- Design documents (in French): [Présentation](docs/01-presentation.md) · [Fonctionnalités](docs/02-fonctionnalites.md) · [Socle technique](docs/03-socle-technique.md) · [Base de données](docs/04-base-de-donnees.md) · [Protocole panel-agent](docs/05-protocole.md) · [Serveurs Minecraft](docs/06-minecraft.md) · [Plan de développement](docs/07-plan-de-developpement.md)
- [Release pipeline](tools/release/README.md) (in French) — archives, signing, publication
- [Contributing](CONTRIBUTING.md) — prerequisites, commands, conventions

## Development

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

pnpm + Turborepo monorepo: `apps/panel` (Fastify API + SQLite), `apps/web` (React PWA), `apps/agent` (universal esbuild bundle, zero native modules), `packages/protocol`, `packages/shared`, `packages/config`. Node 24 LTS pinned (see `.node-version`). Stack: TypeScript everywhere, Fastify 5, Zod 4, React 19, Mantine 8, Drizzle.

## License

Distributed under the [MIT](LICENSE) license.
