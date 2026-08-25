# MinecraftManagerOnline

[![CI](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml/badge.svg)](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zlababababan/MinecraftManagerOnline)](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)
[![License](https://img.shields.io/github/license/Zlababababan/MinecraftManagerOnline)](LICENSE)

[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · **Deutsch** · [Português](README.pt.md) · [Русский](README.ru.md) · [中文](README.zh.md)

Steuern Sie Ihre selbst gehosteten Minecraft-Server aus dem Browser — am Desktop oder am Telefon — selbst dann, wenn der Rechner, auf dem sie laufen, zu Hause hinter einem Router ohne öffentliche IP steht.

Ein zentrales Web-**Panel** (die Maschine, die durchläuft) + ein leichtgewichtiger **Agent** auf jeder Maschine, die Server hostet. Agents verbinden sich ausgehend: Auf den Spielmaschinen muss nichts geöffnet werden.

## Funktionen

- **Echtzeit-Konsole** (xterm) mit Verlauf, Befehlen und Erkennung von Serverereignissen;
- **Start / Stopp / Neustart** aus der Ferne, auch beim Hochfahren der Maschine — Java-Server laufen detached und **überleben** Neustarts und Updates des Agents;
- **Automatische Erkennung** vorhandener Server (Vanilla, Forge, NeoForge, Fabric, 1.12 → 1.21 — erprobt an einer realen Bibliothek von 56 heterogenen Servern);
- **Hot-Backups** (`save-off`/`save-all`/`save-on`) mit Rotation, Zeitplanung, Ein-Klick-Wiederherstellung und Sicherheits-Backup;
- **Planer in Klartext**: „jeden Tag um 8:00, 12:30 und 20:00“, „einmalig am …“, Spielerwarnungen vor einem Stopp — der Cron-Ausdruck erscheint nur in einem erweiterten Modus;
- **Spieler**: Online-Liste, Whitelist, Ops, Kick/Ban; **Metriken** pro Server: TPS/MSPT, CPU, RAM;
- **Multi-Maschine**: Windows- / Linux- / macOS-Agents (x64 und ARM64), **mit einem Klick** vom Panel aus installiert, automatisch aktualisiert (Ed25519-signierte Bundles, automatisches Rollback bei Fehlern);
- **Fernzugriff ohne öffentliche IP**: standardmäßig Tailscale (funktioniert hinter CGNAT), oder direktes IPv6 mit automatischen Zertifikaten, oder Ihr eigener Reverse-Proxy;
- **Datei-Explorer**, fortsetzbarer Upload/Download, Server-Migration von einer Maschine auf eine andere;
- **PWA**, auf dem Mobilgerät installierbar, Push-Benachrichtigungen, dunkles Theme, vollständig zweisprachige Oberfläche (Englisch/Französisch), Audit-Log und Mehrbenutzer-Konten (Administrator / Operator / Betrachter).

## Schnellstart

1. **Laden Sie das Panel-Archiv herunter** — `mmo-panel-<version>-<platform>.zip` (Windows) bzw. `.tar.gz` (Linux / macOS) von den [Releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Gibt es keines für Ihre Plattform, bauen Sie es selbst — Node ≥ 22 und pnpm genügen:

   ```bash
   pnpm install
   pnpm release:build -- --panel
   ```

   Das Archiv erscheint in `release/<version>/`. Zwei Dinge sollten Sie wissen: Das **Panel**-Archiv wird für die Plattform erzeugt, auf der Sie bauen (bauen Sie auf Linux, um auf Linux zu hosten — die **Agent**-Archive für alle 4 Plattformen werden immer erzeugt); ohne Maintainer-Schlüssel wird der Build mit dem Entwicklungsschlüssel signiert, worauf das Panel hinweist — für den persönlichen Gebrauch voll funktionsfähig.

2. **Folgen Sie der [Installationsanleitung](docs/guide/de/installation.md)**: das Panel in zwei Befehlen, dann der Assistent beim ersten Start; Agents mit einem Klick vom Panel aus installiert; und Zugriff für Ihre Freunde und Ihr Telefon.

## Plattformen

|                                 | Panel                           | Agent                |
| ------------------------------- | ------------------------------- | -------------------- |
| Windows x64                     | ✅ (Archiv bereitgestellt)      | ✅                   |
| Linux x64                       | ✅ (selbst bauen)               | ✅                   |
| Linux ARM64 (Raspberry Pi 4/5…) | ✅ (selbst bauen)               | ✅                   |
| macOS Apple Silicon             | ✅ (selbst bauen)               | ✅                   |
| Windows ARM64                   | über das x64-Archiv (Emulation) | über x64 (Emulation) |

Keine Abhängigkeiten zu installieren: Jedes Archiv enthält seine festgepinnte Node-Laufzeitumgebung. Java wird vom Agent automatisch passend zur Minecraft-Version bereitgestellt (Temurin → Zulu).

## Dokumentation

- **Benutzerhandbuch**: [Installation](docs/guide/de/installation.md) · [Eine Maschine hinzufügen](docs/guide/de/add-a-machine.md) · [Netzwerk-FAQ](docs/guide/de/network-faq.md) — auch verfügbar auf [Englisch](docs/guide/installation.md) und [Französisch](docs/guide/fr/installation.md)
- Design-Dokumente (auf Französisch): [Présentation](docs/01-presentation.md) · [Fonctionnalités](docs/02-fonctionnalites.md) · [Socle technique](docs/03-socle-technique.md) · [Base de données](docs/04-base-de-donnees.md) · [Protocole panel-agent](docs/05-protocole.md) · [Serveurs Minecraft](docs/06-minecraft.md) · [Plan de développement](docs/07-plan-de-developpement.md)
- [Release-Pipeline](tools/release/README.md) (auf Französisch) — Archive, Signierung, Veröffentlichung
- [Contributing](CONTRIBUTING.md) — Voraussetzungen, Befehle, Konventionen

## Entwicklung

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

pnpm + Turborepo-Monorepo: `apps/panel` (Fastify-API + SQLite), `apps/web` (React-PWA), `apps/agent` (universelles esbuild-Bundle, keine nativen Module), `packages/protocol`, `packages/shared`, `packages/config`. Node 24 LTS festgepinnt (siehe `.node-version`). Stack: überall TypeScript, Fastify 5, Zod 4, React 19, Mantine 8, Drizzle.

## Lizenz

Veröffentlicht unter der [MIT](LICENSE)-Lizenz.
