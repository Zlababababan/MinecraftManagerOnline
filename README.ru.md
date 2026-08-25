# MinecraftManagerOnline

[![CI](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml/badge.svg)](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zlababababan/MinecraftManagerOnline)](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)
[![License](https://img.shields.io/github/license/Zlababababan/MinecraftManagerOnline)](LICENSE)

[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · **Русский** · [中文](README.zh.md)

Управляйте своими серверами Minecraft из браузера — с компьютера или телефона — даже если машина, на которой они работают, стоит дома за роутером без публичного IP.

Центральная веб-**панель** (машина, которая остаётся включённой) + лёгкий **агент** на каждой машине, где размещены серверы. Агенты подключаются исходящим соединением: на игровых машинах ничего открывать не нужно.

## Возможности

- **Консоль в реальном времени** (xterm) с историей, командами и распознаванием событий сервера;
- **Запуск / остановка / перезапуск** удалённо, в том числе при загрузке машины — Java-серверы работают отсоединённо (detached) и **переживают** перезапуски и обновления агента;
- **Автоматическое обнаружение** существующих серверов (Vanilla, Forge, NeoForge, Fabric, 1.12 → 1.21 — проверено на реальной библиотеке из 56 разнородных серверов);
- **«Горячие» резервные копии** (`save-off`/`save-all`/`save-on`) с ротацией, расписанием, восстановлением в один клик и страховочной копией;
- **Планировщик на человеческом языке**: «каждый день в 8:00, 12:30 и 20:00», «однократно, такого-то числа…», предупреждения игрокам перед остановкой — cron-выражение появляется только в расширенном режиме;
- **Игроки**: список онлайн, whitelist, операторы, kick/ban; **метрики** по каждому серверу: TPS/MSPT, CPU, RAM;
- **Несколько машин**: агенты для Windows / Linux / macOS (x64 и ARM64), устанавливаются **в один клик** из панели и обновляются автоматически (бандлы с подписью Ed25519, автоматический откат при сбое);
- **Удалённый доступ без публичного IP**: Tailscale по умолчанию (работает за CGNAT), либо прямой IPv6 с автоматическими сертификатами, либо ваш собственный reverse proxy;
- **Файловый менеджер**, докачиваемая загрузка/скачивание, миграция сервера с одной машины на другую;
- **PWA** с установкой на телефон, push-уведомления, тёмная тема, полностью двуязычный интерфейс (английский/французский), журнал аудита и многопользовательские учётные записи (администратор / оператор / наблюдатель).

## Быстрый старт

1. **Скачайте архив панели** `mmo-panel-<version>-<platform>.zip` (Windows) или `.tar.gz` (Linux / macOS) со страницы [релизов](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Если для вашей платформы архива нет, соберите его сами — нужны только Node ≥ 22 и pnpm:

   ```bash
   pnpm install
   pnpm release:build -- --panel
   ```

   Архив появится в `release/<version>/`. Два момента, которые стоит знать: архив **панели** собирается для той платформы, на которой выполняется сборка (собирайте на Linux, чтобы разместить панель на Linux — архивы **агента** для всех 4 платформ создаются всегда); без ключа мейнтейнера сборка подписывается ключом разработки, о чём панель предупреждает — для личного использования это полностью работоспособно.

2. **Следуйте [руководству по установке](docs/guide/ru/installation.md)**: панель в две команды, затем мастер первого запуска, агенты в один клик из панели, а также доступ для друзей и для телефона.

## Платформы

|                                 | Панель                     | Агент                |
| ------------------------------- | -------------------------- | -------------------- |
| Windows x64                     | ✅ (готовый архив)         | ✅                   |
| Linux x64                       | ✅ (готовый архив)         | ✅                   |
| Linux ARM64 (Raspberry Pi 4/5…) | ✅ (готовый архив)         | ✅                   |
| macOS Apple Silicon             | ✅ (готовый архив)         | ✅                   |
| Windows ARM64                   | через архив x64 (эмуляция) | через x64 (эмуляция) |

Никаких зависимостей устанавливать не нужно: каждый архив содержит закреплённую среду выполнения Node. Java устанавливается агентом автоматически (Temurin → Zulu) под нужную версию Minecraft.

## Документация

- **Руководство пользователя**: [Установка](docs/guide/ru/installation.md) · [Добавление машины](docs/guide/ru/add-a-machine.md) · [FAQ по сети](docs/guide/ru/network-faq.md) — оригинал [на английском](docs/guide/installation.md)
- Проектная документация (на французском): [Présentation](docs/01-presentation.md) · [Fonctionnalités](docs/02-fonctionnalites.md) · [Socle technique](docs/03-socle-technique.md) · [Base de données](docs/04-base-de-donnees.md) · [Protocole panel-agent](docs/05-protocole.md) · [Serveurs Minecraft](docs/06-minecraft.md) · [Plan de développement](docs/07-plan-de-developpement.md)
- [Конвейер релизов](tools/release/README.md) (на французском) — архивы, подпись, публикация
- [Contributing](CONTRIBUTING.md) — предварительные требования, команды, соглашения

## Разработка

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

Монорепозиторий pnpm + Turborepo: `apps/panel` (Fastify API + SQLite), `apps/web` (React PWA), `apps/agent` (универсальный esbuild-бандл, ноль нативных модулей), `packages/protocol`, `packages/shared`, `packages/config`. Node 24 LTS закреплён (см. `.node-version`). Стек: TypeScript везде, Fastify 5, Zod 4, React 19, Mantine 8, Drizzle.

## Лицензия

Распространяется по лицензии [MIT](LICENSE).
