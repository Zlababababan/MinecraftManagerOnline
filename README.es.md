# MinecraftManagerOnline

[![CI](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml/badge.svg)](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zlababababan/MinecraftManagerOnline)](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)
[![License](https://img.shields.io/github/license/Zlababababan/MinecraftManagerOnline)](LICENSE)

[English](README.md) · [Français](README.fr.md) · **Español** · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [中文](README.zh.md)

Controle sus servidores de Minecraft autoalojados desde un navegador — en el ordenador o en el teléfono — incluso cuando la máquina que los ejecuta está en casa, detrás de un router sin IP pública.

Un **panel** web central (la máquina que permanece encendida) + un **agente** ligero en cada máquina que aloja servidores. Los agentes se conectan de forma saliente: no hay que abrir nada en las máquinas de juego.

## Funcionalidades

- **Consola en tiempo real** (xterm) con historial, comandos y detección de eventos del servidor;
- **Arranque / parada / reinicio** a distancia, incluso al arrancar la máquina — los servidores Java se ejecutan separados (detached) y **sobreviven** a los reinicios y actualizaciones del agente;
- **Detección automática** de servidores existentes (Vanilla, Forge, NeoForge, Fabric, 1.12 → 1.21 — probada sobre una biblioteca real de 56 servidores heterogéneos);
- **Copias de seguridad en caliente** (`save-off`/`save-all`/`save-on`) con rotación, planificación, restauración en un clic y copia de seguridad previa;
- **Planificador en lenguaje corriente**: «todos los días a las 8:00, 12:30 y 20:00», «una sola vez el…», avisos a los jugadores antes de una parada — la expresión cron solo aparece en un modo avanzado;
- **Jugadores**: lista de conectados, whitelist, ops, kick/ban; **métricas** por servidor: TPS/MSPT, CPU, RAM;
- **Multimáquina**: agentes Windows / Linux / macOS (x64 y ARM64) instalados **en un clic** desde el panel, actualizados automáticamente (bundles firmados con Ed25519, rollback automático en caso de fallo);
- **Acceso remoto sin IP pública**: Tailscale por defecto (funciona detrás de CGNAT), o IPv6 directo con certificados automáticos, o su propio reverse proxy;
- **Explorador de archivos**, subida/descarga reanudable, migración de servidores de una máquina a otra;
- **PWA** instalable en el móvil, notificaciones push, tema oscuro, interfaz totalmente bilingüe (inglés/francés), registro de auditoría y cuentas multiusuario (administrador / operador / observador).

## Inicio rápido

1. **Descargue el archivo del panel** `mmo-panel-<version>-<platform>.zip` (Windows) o `.tar.gz` (Linux / macOS) desde las [releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Si no hay ninguno para su plataforma, constrúyalo usted mismo — solo hacen falta Node ≥ 22 y pnpm:

   ```bash
   pnpm install
   pnpm release:build -- --panel
   ```

   El archivo aparece en `release/<version>/`. Dos cosas que conviene saber: el archivo del **panel** se produce para la plataforma en la que se compila (compile en Linux para alojar en Linux — los archivos del **agente** para las 4 plataformas se producen siempre); sin clave de mantenedor, la compilación se firma con la clave de desarrollo, algo que el panel señala — totalmente funcional para uso personal.

2. **Siga la [guía de instalación](docs/guide/es/installation.md)**: el panel en dos comandos y luego el asistente de primer arranque, agentes instalados en un clic desde el panel, y acceso para sus amigos y su teléfono.

## Plataformas

|                                 | Panel                               | Agente                   |
| ------------------------------- | ----------------------------------- | ------------------------ |
| Windows x64                     | ✅ (archivo proporcionado)          | ✅                       |
| Linux x64                       | ✅ (archivo proporcionado)          | ✅                       |
| Linux ARM64 (Raspberry Pi 4/5…) | ✅ (archivo proporcionado)          | ✅                       |
| macOS Apple Silicon             | ✅ (archivo proporcionado)          | ✅                       |
| Windows ARM64                   | mediante el archivo x64 (emulación) | mediante x64 (emulación) |

Ninguna dependencia que instalar: cada archivo incluye su runtime de Node fijado. El agente aprovisiona Java automáticamente (Temurin → Zulu) según la versión de Minecraft.

## Documentación

- **Guía del usuario**: [Instalación](docs/guide/es/installation.md) · [Añadir una máquina](docs/guide/es/add-a-machine.md) · [FAQ de red](docs/guide/es/network-faq.md) — también disponible [en inglés](docs/guide/installation.md) y [en francés](docs/guide/fr/installation.md)
- Documentos de diseño (en francés): [Présentation](docs/01-presentation.md) · [Fonctionnalités](docs/02-fonctionnalites.md) · [Socle technique](docs/03-socle-technique.md) · [Base de données](docs/04-base-de-donnees.md) · [Protocole panel-agent](docs/05-protocole.md) · [Serveurs Minecraft](docs/06-minecraft.md) · [Plan de développement](docs/07-plan-de-developpement.md)
- [Pipeline de release](tools/release/README.md) (en francés) — archivos, firma, publicación
- [Contribuir](CONTRIBUTING.md) — requisitos previos, comandos, convenciones

## Desarrollo

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

Monorepo pnpm + Turborepo: `apps/panel` (API Fastify + SQLite), `apps/web` (PWA React), `apps/agent` (bundle esbuild universal, cero módulos nativos), `packages/protocol`, `packages/shared`, `packages/config`. Node 24 LTS fijado (véase `.node-version`). Stack: TypeScript en todas partes, Fastify 5, Zod 4, React 19, Mantine 8, Drizzle.

## Licencia

Distribuido bajo la licencia [MIT](LICENSE).
