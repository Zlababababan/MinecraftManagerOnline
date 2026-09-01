# Instalação

[English](../installation.md) · [Français](../fr/installation.md) · [Español](../es/installation.md) · [Deutsch](../de/installation.md) · **Português** · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

_Tradução comunitária da versão em inglês, que é a referência: pode estar desatualizada — em caso de dúvida, consulte a [versão em inglês](../installation.md). A interface do aplicativo está disponível em inglês e em francês._

Guia do usuário — instale o **painel** (uma única máquina, a que fica ligada) e depois um **agente** em cada máquina que hospeda servidores Minecraft (muitas vezes a mesma). Tudo é distribuído como arquivos autocontidos: nenhum Node, Java ou Python para instalar antes.

Plataformas empacotadas: **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, servidores ARM), **macOS Apple Silicon**. O Windows ARM64 funciona com o arquivo x64 (emulação). macOS Intel não é empacotado.

**Quais distribuições Linux?** Desde a 1.0.5 o painel não contém nenhum módulo compilado, portanto **qualquer distribuição baseada em glibc funciona**: Ubuntu 20.04 e posteriores, Debian 11 e posteriores, Fedora, Rocky/Alma/RHEL 9, openSUSE, Raspberry Pi OS, Oracle Linux, Arch… Não há nada a instalar — nem compilador nem pacote de desenvolvimento. A única exceção é o **Alpine** e outros sistemas baseados em musl, que o runtime Node embutido não suporta: use a imagem Docker oficial (§1.2 — ela traz a sua própria libc), uma distribuição com glibc, ou execute o painel com o seu próprio Node ≥ 24 (`node app/dist/main.js` a partir da pasta extraída).

## 1. O painel

### 1.1 Download

Abra a [página de releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest) e baixe o arquivo correspondente à sua máquina:

| Sua máquina                                    | Arquivo a baixar                          |
| ---------------------------------------------- | ----------------------------------------- |
| Windows (qualquer PC recente)                  | `mmo-panel-<version>-win-x64.zip`         |
| Linux num PC ou servidor comum                 | `mmo-panel-<version>-linux-x64.tar.gz`    |
| Linux em ARM (Raspberry Pi, VM Oracle/Ampere…) | `mmo-panel-<version>-linux-arm64.tar.gz`  |
| Mac com Apple Silicon (M1–M4)                  | `mmo-panel-<version>-darwin-arm64.tar.gz` |

Não sabe qual Linux você tem? Execute `uname -m`: `x86_64` significa x64, `aarch64` significa ARM64.

O arquivo é autossuficiente: traz o seu próprio runtime Node, o painel, a interface web e os instaladores do agente para as quatro plataformas. **Não há nada a instalar antes** — nem Node, nem Java, nem compilador, nem pacote de desenvolvimento.

> **Quer conferir o download?** Cada release publica `SHA256SUMS.txt`: baixe-o ao lado do seu arquivo e execute `sha256sum -c SHA256SUMS.txt --ignore-missing` (Linux), `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS), ou compare `Get-FileHash <arquivo>` com a linha que traz o nome do seu arquivo (Windows). Os manifestos `panel-<plataforma>.json` trazem as mesmas impressões, um arquivo por vez.

### 1.2 Extrair e executar

**Linux, um único comando.** Numa máquina com systemd (Ubuntu, Debian, Fedora, Raspberry Pi OS…), um copiar e colar faz tudo o que os §1.1 a §1.4 descrevem — download, verificação SHA-256, código em `/opt/mmo-panel`, dados em `/var/lib/mmo-panel`, configurações em `/etc/mmo-panel/panel.env`, serviço systemd endurecido — e depois espera o painel responder:

```bash
curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
```

Execute **o mesmo comando de novo para atualizar**: o banco de dados é copiado antes e, se a nova versão não iniciar, a anterior é reposta. `--uninstall` desinstala (`--purge` apaga também os dados) e `--help` lista as demais opções (instalação offline `--archive`, `--dir`, `--data-dir`…). Se preferir ver cada etapa, o caminho manual abaixo continua plenamente suportado — o instalador e o caminho manual levam ao mesmo resultado.

**Docker.** A imagem oficial (multiarquitetura x64/ARM64, agentes incluídos) é a resposta quando a máquina usa Alpine/musl, ou quando você já roda tudo em contêineres. Baixe apenas o [docker-compose.yml](https://github.com/Zlababababan/MinecraftManagerOnline/blob/main/docker-compose.yml) e depois:

```bash
docker compose up -d
```

O painel responde em `http://127.0.0.1:3000`. Os dados ficam no **volume nomeado** `mmo-data` — resista à tentação de um bind mount `./data`: criado por root no primeiro `up`, ele reproduz exatamente o erro de permissão «não é possível abrir o banco de dados», já que o contêiner roda como o usuário `node` (uid 1000). Dentro do contêiner o painel escuta em todas as interfaces (uma escolha explícita da imagem): é a linha `ports:` que decide a exposição real — mantenha `127.0.0.1:3000:3000` e coloque o `tailscale serve` (§3) no host, ou exponha conscientemente. CLI: `docker compose exec panel /app/entrypoint.sh doctor` (idem `setup`, `restore`).

**Windows, um único comando.** Mesma ideia, num PowerShell (ele mesmo pede elevação) — código em `C:\Program Files\mmo-panel`, dados em `C:\ProgramData\mmo-panel`, um serviço do Windows com início automático atrasado:

```powershell
& ([scriptblock]::Create((irm https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.ps1)))
```

Execute de novo para atualizar (backup primeiro, volta atrás se a nova versão não iniciar). Opções: `-Port`, `-Archive` (offline), `-MigrateFrom C:\antigo\panel` (copia os dados de uma instalação manual anterior, verificados com `integrity_check`, sem tocar no original), `-ServiceAccount User` (se os backups vão para uma unidade de rede), `-Uninstall` (`-Purge` apaga também os dados). As suas escolhas são lembradas para a próxima atualização.

O instalador também coloca **MinecraftManagerOnline** no menu Iniciar: um pequeno ícone junto ao relógio — clique esquerdo abre a interface, clique direito oferece abrir, logs, iniciar/parar/reiniciar, «iniciar com o Windows» e sair. O ícone comanda o serviço (nunca inicia um segundo painel); numa instalação sem serviço, ele mesmo inicia o painel e sair o encerra.

**Windows, caminho manual.** Clique com o botão direito no `.zip` → **Extrair tudo**, para uma pasta que você pretende manter, por exemplo `C:\mmo\panel` (evite Downloads e a Área de trabalho). Abra essa pasta e dê dois cliques em **`mmo-panel.cmd`**. Uma janela preta abre e permanece aberta: esse é o painel em execução, e fechá-la para o painel — o §1.4 transforma isso num serviço de verdade. A partir de um terminal:

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux.** Num terminal, na pasta onde o arquivo foi baixado:

```bash
tar -xzf mmo-panel-*.tar.gz
cd mmo-panel
./mmo-panel.sh
```

Isso basta para experimentar. Para uma máquina que vai ficar ligada, coloque-o num lugar permanente — e atenção ao `chown`, o erro que custa mais tempo:

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
sudo chown -R "$USER" /opt/mmo/mmo-panel   # extraído como root — entregue-o ao usuário que o inicia (o §1.4 entrega-o à conta de serviço mmo)
/opt/mmo/mmo-panel/mmo-panel.sh
```

**macOS** — os mesmos comandos do Linux. Na primeira execução o macOS pode recusar-se a executar um binário baixado: Ajustes do Sistema → Privacidade e Segurança → «Abrir assim mesmo».

> Algo errado? `mmo-panel.cmd doctor` (Windows) ou `./mmo-panel.sh doctor` (Linux/macOS) verifica o runtime, a pasta de dados e o seu dono, o banco de dados e a porta, e diz o que fazer — veja o §1.6.

O painel escuta em `http://127.0.0.1:3000` (nunca em todas as interfaces — a camada de acesso, §3, é que o expõe; `0.0.0.0` é recusado no arranque). Variáveis úteis: `MMO_PORT`, `MMO_HOST` (um endereço específico), `MMO_DATA_DIR` (por padrão `./data` ao lado do script — **é esta a pasta a salvaguardar**: banco SQLite, métricas, certificados, releases). Além do console, o painel escreve o seu log em `data/logs/panel-<date>.log` (14 dias mantidos) — é aí que se olha quando algo deu errado depois de a janela ter sido fechada.

### 1.3 Primeiro arranque

Abra `http://127.0.0.1:3000`. Numa máquina sem tela (servidor, VM): ou configure antes o acesso remoto (§3 — instale o Tailscale, execute o comando `tailscale serve` e abra `https://<máquina>.<tailnet>.ts.net` de outro dispositivo), ou use um túnel SSH (`ssh -L 3000:127.0.0.1:3000 usuário@máquina` e depois abra `http://127.0.0.1:3000` localmente). O assistente tem dois passos — **Administrator account** (conta de administrador: nome de usuário, senha, idioma) e depois **Access** (acesso): a **URL pública do painel** (opcional nesta fase), o **modo de acesso** (veja o §3) e o **destino padrão dos backups**. A URL pública pode ser alterada a qualquer momento em Settings → General: é ela que é injetada nos comandos de instalação dos agentes e nas notificações push — defina-a assim que o seu acesso remoto estiver no lugar.

**Sem navegador nenhum** (VM na nuvem, contêiner, cloud-init), a conta de administrador é criada pela linha de comando — `setup` é exatamente o mesmo caminho de código do assistente. Numa VM nova na nuvem alcançada por SSH (Oracle, AWS, Hetzner…), a sequência completa é esta:

1. **Instalar** — o instalador de um comando do §1.2 faz tudo, serviço incluído:

   ```bash
   curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
   ```

2. **Criar a conta de administrador.** O instalador executa o painel sob a conta de serviço `mmo`, com os dados em `/var/lib/mmo-panel` — execute o `setup` com essa mesma identidade:

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --random-password
   ```

   A senha gerada é exibida uma única vez — copie-a imediatamente. Use `--password-stdin` (`echo -n 'segredo' | … setup --username admin --password-stdin`) ou `--password-file <arquivo>` para escolhê-la você mesmo — nunca a passe como argumento, a linha de comando é visível para todos os processos da máquina. `--public-url`, `--locale` e `--access-mode` são opcionais. O comando recusa-se a rodar duas vezes. Numa instalação manual (§1.2), em que os dados ficam ao lado do script e pertencem a você, nenhum prefixo é necessário: `/opt/mmo/mmo-panel/mmo-panel.sh setup --username admin --random-password --public-url panel.example.net`.

3. **Conferir.** O `doctor` (§1.6) inspeciona toda a instalação, e o log do painel corre pelo journalctl:

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh doctor
   journalctl -u mmo-panel -f
   ```

4. **Abrir a interface do seu próprio computador** (§3). Ou instale o Tailscale na VM e exponha o painel no seu tailnet:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

   e depois abra `https://<vm>.<tailnet>.ts.net` — ou, para uma primeira olhada rápida sem instalar nada, use um túnel SSH: `ssh -L 3000:127.0.0.1:3000 usuário@vm` e depois abra `http://127.0.0.1:3000` no seu computador.

**Com cloud-init**, a mesma sequência pode rodar no primeiro arranque da VM, antes mesmo de você entrar. Use `--password-file` com um arquivo depositado por `write_files` — e não `--random-password`, cuja saída única se perderia nos logs do cloud-init. O arquivo pode ficar dentro de `/var/lib/mmo-panel`: o instalador entrega essa pasta inteira à conta `mmo`, então o painel consegue lê-lo ali.

```yaml
write_files:
  - path: /var/lib/mmo-panel/admin-password
    permissions: '0600'
    content: |
      escolha-aqui-uma-senha-longa
runcmd:
  - curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh -o /run/install-panel.sh
  - sh /run/install-panel.sh
  - sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --password-file /var/lib/mmo-panel/admin-password
  - rm -f /var/lib/mmo-panel/admin-password /run/install-panel.sh
```

Duas coisas a saber. O cloud-init roda como root, sem terminal: nenhum comando pode esperar por uma tecla — o `install-panel.sh` nunca espera, essa é uma das suas regras. E a rede nem sempre está de pé quando o `runcmd` começa: se o download falhar, basta repetir o mesmo comando à mão assim que a VM estiver acessível.

### 1.4 Iniciar com o sistema (serviço)

> Instalou com um instalador de um comando (§1.2, Linux ou Windows)? O serviço já existe — esta seção é para instalações manuais.

**Windows** (o shawl vem no arquivo) — num PowerShell de **administrador**:

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

O serviço passa então a rodar como `LocalSystem`; para rodá-lo sob a sua própria conta (recomendado se os backups vão para uma unidade de rede), use `services.msc` → Fazer logon, ou adapte o procedimento do agente (§2.2). Variáveis de ambiente (`MMO_PORT`…): `shawl add --env MMO_PORT=3000 …`.

> Importante: o `mmo-panel.cmd` define `MMO_WEB_DIR` e `MMO_DIST_DIR`; com o shawl, acrescente-as explicitamente: `--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`.

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

**macOS** (launchd) — `/Library/LaunchDaemons/com.mmo.panel.plist` com `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` e `KeepAlive` em `true`, depois `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Atualizar o painel

O painel avisa quando existe uma atualização: os administradores veem um banner assim que uma nova versão é publicada (consulta ao feed de releases do GitHub no máximo a cada 6 horas — Settings → General desliga a verificação, e uma categoria de notificação «New panel version published» faz o sino tocar).

Instalou com um instalador de um comando (§1.2, Linux ou Windows)? Execute o mesmo comando de novo — ele copia o banco de dados, troca o código, reinicia o serviço e volta atrás sozinho se a nova versão não iniciar. Instalações manuais: pare o serviço, extraia o novo arquivo **por cima** (a pasta `data/` nunca está dentro do arquivo), reinicie. As migrações do banco rodam no arranque. O novo arquivo traz agentes da mesma versão: o painel publica a release do agente automaticamente e, se «Update agents automatically when they connect» (atualizar os agentes automaticamente ao conectar) estiver marcado (Settings → General — desmarcado por padrão), cada agente é atualizado na próxima conexão, com volta atrás automática em caso de falha. Caso contrário, atualize-os um a um pelo cartão Agent da página de cada máquina.

### 1.6 Quando o painel não inicia: `doctor`

Antes de ler um rastreamento de erro, pergunte ao painel o que está errado. Ele verifica o runtime,
os módulos que carrega, o diretório de dados (uma escrita **real**, mais o dono comparado com o
usuário atual), o banco de dados, a porta e o front-end.

```powershell
C:\mmo\panel\mmo-panel.cmd doctor
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh doctor
```

Cada linha é prefixada com `ok`, `warn` ou `ERROR`, e cada erro diz o que fazer — inclusive o
comando `chown` exato quando o arquivo foi extraído com `sudo` e o painel roda sob outro usuário. O
comando sai com 1 assim que uma verificação falha, portanto pode ser usado num script.

**Vai relatar um problema?** O `report` escreve o mesmo diagnóstico num arquivo, com as suas
versões, as suas máquinas e os respetivos agentes, as suas configurações (sem os segredos) e um
trecho mascarado do log — exatamente o que o formulário de issue pede.

```bash
/opt/mmo/mmo-panel/mmo-panel.sh report
```

Leia o arquivo antes de anexá-lo: caminhos pessoais, tokens e códigos de emparelhamento são
mascarados e as pastas dos servidores nunca são listadas, mas quem o publica é você. `--stdout`
mostra-o em vez de gravá-lo, `--no-log` deixa o log de fora.

### 1.7 Backup e restauração do painel

O painel faz o seu próprio backup uma vez por dia (cópia consistente `VACUUM INTO` do seu banco de dados) em `data/backups/panel/mmo-<date>.db`, mantendo 7 cópias; Settings → Panel backups permite criar uma sob demanda. As métricas (`metrics.db`) não são copiadas: podem ser reconstruídas e são grandes. Salvaguarde também a pasta `data/` inteira se quiser manter os certificados e os arquivos dos agentes.

Para **restaurar**: pare o painel (serviço ou Ctrl+C) e depois:

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

Para uma cópia que esteja em `data/backups/panel/` basta o nome do arquivo; um caminho completo também é aceito. A cópia é verificada (`integrity_check`), o banco atual é mantido como `mmo.db.before-restore-<date>`, e então o painel pode ser reiniciado: os agentes reconectam-se com o seu segredo original e os servidores que hospedam são readotados com os mesmos identificadores (marcador `.mmo-server.json`). Tudo o que foi criado depois do backup (usuários, máquinas emparelhadas, configurações) é perdido: uma máquina emparelhada depois do backup terá de ser emparelhada de novo. A restauração recusa-se a rodar se `mmo.db-wal` não estiver vazio (painel ainda em execução, ou encerrado abruptamente — inicie-o, pare-o de forma limpa e tente de novo).

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
- ⚠ **Permissões nas suas pastas de servidores.** Instalado como serviço do sistema, o agente roda como `mmo`, não como você: servidores guardados em `/home/<você>/…` costumam ser somente leitura para ele. O painel avisa assim que o servidor é adotado («folder not writable»), e um arranque recusado nomeia a pasta e a conta. Duas soluções, qualquer uma delas:
  - dar acesso à conta do agente: `sudo chown -R mmo /caminho/para/meus-servidores` (ou `sudo chmod -R g+w` depois de `sudo usermod -aG <seu-grupo> mmo`);
  - ou instalar o agente sob a sua própria conta: `--user <você>` (serviço do sistema) ou `--user-service` (sem root).
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
