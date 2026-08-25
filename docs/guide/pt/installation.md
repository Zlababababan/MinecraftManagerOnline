# Instalação

[English](../installation.md) · [Français](../fr/installation.md) · [Español](../es/installation.md) · [Deutsch](../de/installation.md) · **Português** · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

_Tradução da versão em inglês, que é a referência. A interface do aplicativo está disponível em inglês e em francês._

Guia do usuário — instale o **painel** (uma única máquina, a que fica ligada) e depois um **agente** em cada máquina que hospeda servidores Minecraft (muitas vezes a mesma). Tudo é distribuído como arquivos autocontidos: nenhum Node, Java ou Python para instalar antes.

Plataformas empacotadas: **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, servidores ARM), **macOS Apple Silicon**. O Windows ARM64 funciona com o arquivo x64 (emulação). macOS Intel não é empacotado.

## 1. O painel

### 1.1 Download

Baixe o arquivo `mmo-panel-<version>-<platform>.zip` (Windows) ou `.tar.gz` (Linux / macOS) nas [releases do GitHub](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Ele contém o runtime Node fixado, o painel, a interface web e os arquivos de instalação do agente para as 4 plataformas (`dist-agent/`).

> Não há arquivo para a sua plataforma? Compile a partir do código-fonte em dois comandos: veja "Início rápido" no [README](../../../README.pt.md).

### 1.2 Extrair e iniciar

**Windows** — extraia para uma pasta permanente, por exemplo `C:\mmo\panel`, e então:

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux / macOS**:

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
/opt/mmo/mmo-panel/mmo-panel.sh
```

O painel escuta em `http://127.0.0.1:3000` (nunca em todas as interfaces — a camada de acesso, §3, é o que o expõe; `0.0.0.0` é recusado na inicialização). Variáveis úteis: `MMO_PORT`, `MMO_HOST` (um endereço específico), `MMO_DATA_DIR` (padrão `./data` ao lado do script — **essa é a pasta a incluir no backup**: banco de dados SQLite, métricas, certificados, releases). Além do console, o painel grava seu log em `data/logs/panel-<date>.log` (14 dias mantidos) — é lá que se deve olhar quando algo deu errado depois que a janela foi fechada.

### 1.3 Primeira inicialização

Abra `http://127.0.0.1:3000`: o assistente roda em duas etapas — **Administrator account** (conta de administrador: nome de usuário, senha, idioma) e depois **Access** (acesso): a **URL pública do painel** (opcional nesta etapa), o **modo de acesso** (veja §3) e o **destino padrão dos backups**. A URL pública pode ser alterada a qualquer momento em Settings → General: é ela que é injetada nos comandos de instalação dos agentes e nas notificações push — defina-a assim que seu acesso remoto estiver funcionando.

### 1.4 Iniciar junto com o sistema (serviço)

**Windows** (o shawl acompanha o arquivo) — em um PowerShell de **administrador**:

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

O serviço passa então a rodar como `LocalSystem`; para executá-lo com a sua própria conta (recomendado se os backups apontam para uma unidade de rede), use `services.msc` → Log On, ou adapte o procedimento do agente (§2.2). Variáveis de ambiente (`MMO_PORT`…): `shawl add --env MMO_PORT=3000 …`.

> Importante: `mmo-panel.cmd` define `MMO_WEB_DIR` e `MMO_DIST_DIR`; com o shawl, adicione-as explicitamente: `--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`.

**Linux** (systemd) — `/etc/systemd/system/mmo-panel.service`:

```ini
[Unit]
Description=MinecraftManagerOnline panel
After=network-online.target
Wants=network-online.target

[Service]
User=mmo
WorkingDirectory=/opt/mmo/mmo-panel
ExecStart=/opt/mmo/mmo-panel/mmo-panel.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home-dir /opt/mmo/mmo-panel --shell /usr/sbin/nologin mmo
sudo chown -R mmo /opt/mmo/mmo-panel
sudo systemctl daemon-reload && sudo systemctl enable --now mmo-panel
```

**macOS** (launchd) — `/Library/LaunchDaemons/com.mmo.panel.plist` com `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` e `KeepAlive` definidos como `true`, e então `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Atualizar o painel

Pare o serviço, extraia o novo arquivo **por cima** (a pasta `data/` nunca está dentro do arquivo), reinicie. As migrações do banco de dados rodam na inicialização. O novo arquivo embute agentes da mesma versão: o painel publica a release do agente automaticamente e, se "Update agents automatically when they connect" (atualizar os agentes automaticamente quando se conectarem) estiver marcado (Settings → General — desmarcado por padrão), cada agente é atualizado na sua próxima conexão, com rollback automático em caso de falha. Caso contrário, atualize-os um a um a partir do cartão Agent da página de cada máquina.

### 1.6 Fazer backup e restaurar o painel

O painel faz backup de si mesmo uma vez por dia (cópia consistente `VACUUM INTO` do seu banco de dados) em `data/backups/panel/mmo-<date>.db`, com 7 cópias mantidas; Settings → Panel backups permite criar um sob demanda. As métricas (`metrics.db`) não são copiadas: podem ser reconstruídas e são grandes. Faça também backup da pasta `data/` inteira se quiser manter os certificados e os arquivos de agente.

Para **restaurar**: pare o painel (serviço ou Ctrl+C), e então:

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

Um nome de arquivo simples basta para uma cópia que está em `data/backups/panel/`; um caminho completo também é aceito. A cópia é verificada (`integrity_check`), o banco de dados atual é mantido como `mmo.db.before-restore-<date>`, e então o painel pode ser reiniciado: os agentes se reconectam com seu segredo original e os servidores que eles hospedam são readotados com os mesmos identificadores (marcador `.mmo-server.json`). Tudo o que foi criado depois do backup (usuários, máquinas pareadas, configurações) é perdido: uma máquina pareada depois do backup terá de ser pareada novamente. A restauração se recusa a rodar se `mmo.db-wal` não estiver vazio (painel ainda em execução, ou encerrado abruptamente — inicie-o, pare-o de forma limpa e tente de novo).

## 2. Os agentes

Um agente por máquina que hospeda servidores. Ele se conecta **de dentro para fora** ao painel (WebSocket): nenhuma porta para abrir nas máquinas dos agentes.

### 2.1 O comando de uma linha

No painel: **Machines → Add a machine** (adicionar uma máquina). O painel gera um código de pareamento (válido por 15 minutos) e o comando completo para colar na máquina de destino:

- **Windows** (PowerShell, qualquer versão):
  `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -PairCode MMOP-XXXX-XXXX`
- **Linux / macOS**:
  `curl -fsSL https://<panel>/install.sh | sh -s -- --pair-code MMOP-XXXX-XXXX`

O script baixa do painel o arquivo da plataforma certa, verifica seu hash SHA-256, instala os arquivos, **pareia** o agente (o erro é imediato se o código expirou), e então registra e inicia o serviço. A máquina aparece `online` no painel em poucos segundos.

> O painel precisa estar acessível a partir da máquina de destino (§3). Enquanto a URL pública não estiver definida, o comando usa o endereço com o qual você abriu o painel.

### 2.2 O que o script faz — Windows

- Arquivos em `%LOCALAPPDATA%\Programs\mmo-agent` (runtime, `launcher.cjs`, `versions/<v>/agent.js`, `shawl.exe`), estado em `%LOCALAPPDATA%\mmo-agent`.
- O serviço `mmo-agent` é registrado com o **shawl**, com início automático; ele roda **com a sua conta do Windows** (a senha é pedida uma única vez, na janela elevada que se abre) para que o agente possa ver suas unidades de rede mapeadas e suas pastas. Para ser exato: a conta da janela elevada — se o UAC fizer você digitar as credenciais de outro administrador, é com essa conta que o serviço vai rodar. O direito "Log on as a service" é concedido automaticamente (se isso falhar, o script continua e explica como concedê-lo com `secpol.msc`). Alternativa: `-ServiceAccount LocalSystem`.
- **Conta sem senha** (sessão aberta com PIN ou sem senha nenhuma): o Windows proíbe que serviços façam logon com senha vazia. Confirme o prompt vazio: o script avisa e registra o serviço como `LocalSystem` (o agente então não consegue ver suas unidades de rede mapeadas). Para voltar à sua conta: defina uma senha do Windows e execute o comando de novo.
- Se algo falhar na janela elevada, a mensagem permanece na tela (Enter para fechar) e os detalhes ficam em `%TEMP%\mmo-install.log`.
- O serviço reinicia automaticamente se travar; parada limpa = Ctrl+C encaminhado ao agente, **nunca** à árvore de processos inteira: os servidores Minecraft sobrevivem à parada ou à atualização do agente e depois são readotados.
- Opções: `-NoService` (somente os arquivos), `-InstallDir`, `-StateDir`, `-Panel`, `-Archive <zip>` (offline).
- Desinstalação: `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -Uninstall` (adicione `-Purge` para remover também o estado; os servidores Minecraft nunca são tocados).

### 2.3 O que o script faz — Linux

- Arquivos em `/opt/mmo-agent`, estado em `/var/lib/mmo-agent`, conta de sistema `mmo` criada se necessário (`--user <name>` para outra conta — o agente precisa poder ler/gravar as pastas dos servidores).
- Unidade systemd `mmo-agent` com `KillMode=process` (os servidores desanexados sobrevivem) e `Restart=on-failure`. O `sudo` é solicitado quando necessário.
- **Sem root**: `--user-service` instala em `~/.local/share/mmo-agent` (arquivos em `app/`, estado na raiz) com `systemctl --user` e `loginctl enable-linger` (inicia no boot sem sessão aberta). Atenção: quando executado com `sudo`, `--user-service` é ignorado e a instalação para o sistema inteiro é realizada.
- Opções: `--no-service`, `--dir`, `--state-dir`, `--panel`, `--archive <tar.gz>` (offline).
- Desinstalação: `curl -fsSL https://<panel>/install.sh | sh -s -- --uninstall [--purge]` (adicione `--user-service` se a instalação foi feita assim). A conta de sistema `mmo` é mantida (`userdel mmo` se você não a quiser mais).
- No **WSL**, a VM para alguns segundos depois que o último terminal é fechado: o serviço (e os servidores) param junto — o WSL serve para experimentar, não para hospedar.

### 2.4 O que o script faz — macOS

Mesma lógica: `/opt/mmo-agent`, LaunchDaemon `com.mmo.agent` (`KeepAlive`, `AbandonProcessGroup`: os servidores sobrevivem), conta = o usuário que executa o `sudo`. `--user-service` cria em vez disso um LaunchAgent (inicia apenas no login da sessão). Log: `/var/lib/mmo-agent/agent.log`.

### 2.5 Depois que a máquina reinicia

O serviço relança o agente; o agente readota os servidores ainda vivos (PID + hora de início + linha de comando) e, se "Restore desired state when an agent boots" (restaurar o estado desejado quando um agente inicia) estiver ativado (Settings → General), reinicia os que estavam marcados `running`.

### 2.6 Instalação offline

Baixe o arquivo da plataforma a partir do painel (Settings → Agent distribution) ou da release, copie-o junto com o script (`install.ps1` / `install.sh` também estão dentro do arquivo) e execute `install.ps1 -Archive <zip> -Panel https://<panel> -PairCode …` ou `sh install.sh --archive <tar.gz> --panel https://<panel> --pair-code …` (o hash SHA-256 só é verificado para um arquivo baixado do painel — um arquivo local é usado como está).

## 3. Acesso remoto (resumo)

O painel só escuta em `127.0.0.1`. Para alcançá-lo a partir de agentes em outras máquinas, dos seus amigos e do seu celular, escolha um modo (Settings → Remote access):

| Modo                   | Para quem                                                    | O que fazer                                                                                                              |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Tailscale** (padrão) | Todo mundo, inclusive atrás de CGNAT/4G                      | Instale o Tailscale no host do painel e em cada dispositivo cliente, e então execute o comando `tailscale serve` exibido |
| **Direct**             | Você tem um IPv6 público e um domínio (DuckDNS, Cloudflare…) | Informe domínio + provedor DNS, solicite o certificado (DNS-01), abra a porta 443 (pinhole IPv6 no seu roteador)         |
| **Manual**             | Você já roda um reverse proxy                                | Aponte-o para `127.0.0.1:3000` com suporte a WebSocket                                                                   |

Em todos os casos, o cartão **Reachability test** (teste de alcançabilidade — botão **Run the test**, em Settings → Remote access) verifica HTTP, WebSocket, frames binários (64 KiB) e o certificado TLS através da URL pública. Detalhes e solução de problemas: [FAQ de rede](network-faq.md). Adicionar máquinas e endereços para dar aos jogadores: [Adicionar uma máquina](add-a-machine.md).

## 4. No seu celular: instale o PWA

O painel é um aplicativo web instalável (PWA): com o acesso remoto funcionando (§3 — a instalação exige HTTPS), abra a URL pública no navegador do seu celular e adicione o app à tela inicial:

- **Android (Chrome)**: menu ⋮ → "Adicionar à tela inicial" (ou "Instalar app" quando oferecido).
- **iOS (Safari)**: botão Compartilhar → "Adicionar à Tela de Início". No iOS isso é **obrigatório** para receber notificações push: elas só funcionam a partir do PWA instalado, não do Safari.

O app então abre em tela cheia, com a navegação na parte de baixo da tela. Para as notificações (queda de servidor, backup com falha, agente offline…): página Account → Push notifications — ative-as, escolha as categorias e verifique com o botão "Send a test" (enviar um teste). No modo Tailscale, o celular precisa ter o aplicativo Tailscale instalado e conectado à tailnet para alcançar o painel.
