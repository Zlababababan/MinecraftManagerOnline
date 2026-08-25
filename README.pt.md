# MinecraftManagerOnline

[![CI](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml/badge.svg)](https://github.com/Zlababababan/MinecraftManagerOnline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zlababababan/MinecraftManagerOnline)](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest)
[![License](https://img.shields.io/github/license/Zlababababan/MinecraftManagerOnline)](LICENSE)

[English](README.md) · [Français](README.fr.md) · [Español](README.es.md) · [Deutsch](README.de.md) · **Português** · [Русский](README.ru.md) · [中文](README.zh.md)

Controle seus servidores de Minecraft auto-hospedados a partir de um navegador — no computador ou no celular — mesmo quando a máquina que os executa fica em casa, atrás de um roteador sem IP público.

Um **painel** web central (a máquina que fica ligada) + um **agente** leve em cada máquina que hospeda servidores. Os agentes se conectam de dentro para fora: nada para abrir nas máquinas de jogo.

## Funcionalidades

- **Console em tempo real** (xterm) com histórico, comandos e detecção de eventos do servidor;
- **Iniciar / parar / reiniciar** remotamente, inclusive na inicialização da máquina — os servidores Java rodam desanexados (detached) e **sobrevivem** a reinicializações e atualizações do agente;
- **Detecção automática** de servidores existentes (Vanilla, Forge, NeoForge, Fabric, 1.12 → 1.21 — comprovada em uma biblioteca real de 56 servidores heterogêneos);
- **Backups a quente** (`save-off`/`save-all`/`save-on`) com rotação, agendamento, restauração em um clique e backup de segurança;
- **Agendador em linguagem simples**: "todos os dias às 8:00, 12:30 e 20:00", "uma única vez em…", avisos aos jogadores antes de uma parada — a expressão cron só aparece em um modo avançado;
- **Jogadores**: lista de quem está online, whitelist, ops, kick/ban; **métricas** por servidor: TPS/MSPT, CPU, RAM;
- **Multimáquina**: agentes Windows / Linux / macOS (x64 e ARM64) instalados **em um clique** a partir do painel, atualizados automaticamente (bundles assinados com Ed25519, rollback automático em caso de falha);
- **Acesso remoto sem IP público**: Tailscale por padrão (funciona atrás de CGNAT), ou IPv6 direto com certificados automáticos, ou seu próprio reverse proxy;
- **Explorador de arquivos**, upload/download com retomada, migração de servidores de uma máquina para outra;
- **PWA** instalável no celular, notificações push, tema escuro, interface totalmente bilíngue (inglês/francês), log de auditoria e contas multiusuário (administrador / operador / visualizador).

## Início rápido

1. **Baixe o arquivo do painel** `mmo-panel-<version>-<platform>.zip` (Windows) ou `.tar.gz` (Linux / macOS) nas [releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Se não houver um para a sua plataforma, compile você mesmo — Node ≥ 22 e pnpm são tudo o que você precisa:

   ```bash
   pnpm install
   pnpm release:build -- --panel
   ```

   O arquivo aparece em `release/<version>/`. Duas coisas a saber: o arquivo do **painel** é produzido para a plataforma em que você compila (compile no Linux para hospedar no Linux — os arquivos do **agente** para as 4 plataformas são sempre produzidos); sem uma chave de mantenedor, o build é assinado com a chave de desenvolvimento, o que o painel sinaliza — totalmente funcional para uso pessoal.

2. **Siga o [guia de instalação](docs/guide/pt/installation.md)**: painel em dois comandos e depois o assistente de primeira inicialização, agentes instalados em um clique a partir do painel, e acesso para seus amigos e seu celular.

## Plataformas

|                                 | Painel                       | Agente             |
| ------------------------------- | ---------------------------- | ------------------ |
| Windows x64                     | ✅ (arquivo fornecido)       | ✅                 |
| Linux x64                       | ✅ (arquivo fornecido)       | ✅                 |
| Linux ARM64 (Raspberry Pi 4/5…) | ✅ (arquivo fornecido)       | ✅                 |
| macOS Apple Silicon             | ✅ (arquivo fornecido)       | ✅                 |
| Windows ARM64                   | via o arquivo x64 (emulação) | via x64 (emulação) |

Nenhuma dependência para instalar: cada arquivo embute seu runtime Node fixado. O Java é provisionado automaticamente pelo agente (Temurin → Zulu) conforme a versão do Minecraft.

## Documentação

- **Guia do usuário**: [Instalação](docs/guide/pt/installation.md) · [Adicionar uma máquina](docs/guide/pt/add-a-machine.md) · [FAQ de rede](docs/guide/pt/network-faq.md) — também disponível [em inglês](docs/guide/installation.md) e [em francês](docs/guide/fr/installation.md)
- Documentos de concepção (em francês): [Présentation](docs/01-presentation.md) · [Fonctionnalités](docs/02-fonctionnalites.md) · [Socle technique](docs/03-socle-technique.md) · [Base de données](docs/04-base-de-donnees.md) · [Protocole panel-agent](docs/05-protocole.md) · [Serveurs Minecraft](docs/06-minecraft.md) · [Plan de développement](docs/07-plan-de-developpement.md)
- [Pipeline de release](tools/release/README.md) (em francês) — arquivos, assinatura, publicação
- [Contribuir](CONTRIBUTING.md) — pré-requisitos, comandos, convenções

## Desenvolvimento

```bash
pnpm install
pnpm check   # build + typecheck + lint + test
```

Monorepo pnpm + Turborepo: `apps/panel` (API Fastify + SQLite), `apps/web` (PWA React), `apps/agent` (bundle esbuild universal, zero módulos nativos), `packages/protocol`, `packages/shared`, `packages/config`. Node 24 LTS fixado (veja `.node-version`). Stack: TypeScript em tudo, Fastify 5, Zod 4, React 19, Mantine 8, Drizzle.

## Licença

Distribuído sob a licença [MIT](LICENSE).
