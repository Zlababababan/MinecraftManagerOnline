# MinecraftManagerOnline

[![CI](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml/badge.svg)](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zlababababan/MinecraftManagerOnline)](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)
[![License](https://img.shields.io/github/license/Zlababababan/MinecraftManagerOnline)](LICENSE)

[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · **中文**

通过浏览器（电脑或手机）远程管理你自托管的 Minecraft 服务器——即使运行服务器的机器就放在家里、位于没有公网 IP 的路由器后面。

一个中央 Web **面板**（panel，装在常开的那台机器上）+ 每台托管服务器的机器上一个轻量级**代理**（agent）。代理主动向外连接：游戏机器上无需开放任何端口。

## 功能特性

- **实时控制台**（xterm），带历史记录、命令输入和服务器事件检测；
- 远程**启动 / 停止 / 重启**，包括机器开机时自动启动——Java 服务器以分离方式运行，代理重启或更新时仍**继续存活**；
- **自动检测**已有服务器（Vanilla、Forge、NeoForge、Fabric，1.12 → 1.21——已在一个包含 56 个结构各异的真实服务器库上验证）；
- **热备份**（`save-off`/`save-all`/`save-on`），支持轮换、计划执行、一键还原和安全备份；
- **通俗易懂的计划任务**：“每天 8:00、12:30 和 20:00”、“仅在某日执行一次”、停止前向玩家发出警告——cron 表达式只在高级模式中出现；
- **玩家管理**：在线列表、whitelist、op、踢出/封禁；按服务器统计的**指标**：TPS/MSPT、CPU、内存；
- **多机器支持**：Windows / Linux / macOS 代理（x64 和 ARM64），从面板**一键安装**、自动更新（Ed25519 签名的更新包，失败时自动回滚）；
- **无公网 IP 也能远程访问**：默认使用 Tailscale（CGNAT 之后也能工作），或使用带自动证书的 IPv6 直连，或你自己的反向代理；
- **文件管理器**、可断点续传的上传/下载、服务器在机器间的迁移；
- 可安装到手机的 **PWA**、推送通知、深色主题、完整的双语界面（英语/法语）、审计日志和多用户账户（administrator 管理员 / operator 操作员 / viewer 观察者）。

## 快速上手

1. 从 [releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases) 下载**面板压缩包** `mmo-panel-<version>-<platform>.zip`（Windows）或 `.tar.gz`（Linux / macOS）。如果没有适合你平台的压缩包，可以自行构建——只需要 Node ≥ 22 和 pnpm：

   ```bash
   pnpm install
   pnpm release:build -- --panel
   ```

   压缩包会出现在 `release/<version>/` 中。两点须知：**面板**压缩包只针对构建所在的平台生成（要在 Linux 上托管就在 Linux 上构建——4 个平台的**代理**压缩包则始终全部生成）；没有维护者密钥时，构建会使用开发密钥签名，面板会对此给出提示——个人使用完全没有问题。

2. **按照[安装指南](docs/guide/zh/installation.md)操作**：两条命令装好面板，然后是首次启动向导；代理从面板一键安装；最后为你的朋友和手机配置访问。

## 支持的平台

|                                  | 面板                        | 代理                 |
| -------------------------------- | --------------------------- | -------------------- |
| Windows x64                      | ✅（提供压缩包）            | ✅                   |
| Linux x64                        | ✅（提供压缩包）            | ✅                   |
| Linux ARM64（Raspberry Pi 4/5…） | ✅（提供压缩包）            | ✅                   |
| macOS Apple Silicon              | ✅（提供压缩包）            | ✅                   |
| Windows ARM64                    | 通过 x64 压缩包（模拟运行） | 通过 x64（模拟运行） |

无需安装任何依赖：每个压缩包都内置了固定版本的 Node 运行时。Java 由代理根据 Minecraft 版本自动配备（Temurin → Zulu）。

## 文档

- **用户指南**：[安装](docs/guide/zh/installation.md) · [添加机器](docs/guide/zh/add-a-machine.md) · [网络常见问题](docs/guide/zh/network-faq.md) — 另有[英文原版](docs/guide/installation.md)和[法语版](docs/guide/fr/installation.md)
- 设计文档（法语）：[Présentation](docs/01-presentation.md) · [Fonctionnalités](docs/02-fonctionnalites.md) · [Socle technique](docs/03-socle-technique.md) · [Base de données](docs/04-base-de-donnees.md) · [Protocole panel-agent](docs/05-protocole.md) · [Serveurs Minecraft](docs/06-minecraft.md) · [Plan de développement](docs/07-plan-de-developpement.md)
- [发布流水线](tools/release/README.md)（法语）— 压缩包、签名、发布
- [贡献指南](CONTRIBUTING.md) — 前置条件、常用命令、约定

## 开发

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

pnpm + Turborepo monorepo：`apps/panel`（Fastify API + SQLite）、`apps/web`（React PWA）、`apps/agent`（通用 esbuild bundle，零原生模块）、`packages/protocol`、`packages/shared`、`packages/config`。Node 24 LTS 版本固定（见 `.node-version`）。技术栈：全 TypeScript、Fastify 5、Zod 4、React 19、Mantine 8、Drizzle。

## 许可证

基于 [MIT](LICENSE) 许可证分发。
