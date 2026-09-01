# Adicionar uma máquina

[English](../add-a-machine.md) · [Français](../fr/ajouter-une-machine.md) · [Español](../es/add-a-machine.md) · [Deutsch](../de/add-a-machine.md) · **Português** · [Русский](../ru/add-a-machine.md) · [中文](../zh/add-a-machine.md)

_Tradução da versão em inglês, que é a referência. A interface do aplicativo está disponível em inglês e em francês._

Uma **máquina** = um computador que hospeda servidores Minecraft, controlado por um agente. O próprio host do painel pode ser uma delas (o caso mais comum: tudo roda no PC de jogos).

## 1. Criar a máquina e obter o comando

1. Painel → **Machines** → **Add a machine** (adicionar uma máquina), dê um nome a ela.
2. O painel exibe um **código de pareamento** (`MMOP-XXXX-XXXX`, válido por 15 minutos, uso único) e o comando completo para Windows e para Linux/macOS.
3. Cole o comando na máquina de destino — veja [Instalação § 2](installation.md#2-os-agentes) para os detalhes do que ele faz.
4. A máquina fica `online` no painel. Se o código expirou, **New pairing code** (novo código de pareamento) gera outro (os códigos anteriores da máquina são invalidados); execute o comando de novo.

O comando contém a URL pública do painel: confira-a (Settings → General) se a máquina de destino não estiver na mesma rede que você.

## 2. Detectar servidores

Na página da máquina: **Watched directories** (diretórios monitorados) → adicione a pasta-mãe dos seus servidores (ex.: `E:\Minecraft\Server`, `/srv/minecraft`). O agente faz a varredura (Forge, NeoForge, Fabric, Vanilla; 1.12 → 1.21+) e **adota automaticamente** cada servidor detectado, com seu loader, versão e RAM — a varredura periódica roda sozinha, **Scan now** força uma passada imediata e **Add a server folder** registra uma pasta específica sem esperar. Tudo continua editável depois na página do servidor (packs ajustados à mão às vezes enganam as heurísticas — a origem de cada valor detectado é exibida). Nada é modificado no disco na adoção, exceto a ativação do RCON (`server.properties`, senha gerada), necessária para controlar o servidor em modo detached.

Java: o agente inventaria os JREs presentes; se a versão necessária estiver faltando, instale-a a partir do cartão **Java runtimes** da página da máquina (botão **Install this runtime** — Temurin, senão Zulu, baixado e verificado automaticamente).

## 3. Primeira inicialização de um servidor

Inicie o servidor pelo seu cartão (dashboard) ou pela sua página, e veja o estado passar por `starting` → `running` (PID exibido). A aba **Console** mostra as linhas ao vivo e aceita comandos. Na primeira inicialização de um servidor novo, se o EULA da Mojang ainda não foi aceito, o painel guia você (explicação, link, caixa de seleção), e então você inicia de novo. Todo o resto fica nas abas da página do servidor: **Players** (whitelist, ops, bans — sem nunca abrir um arquivo), **Configuration** (`server.properties` explicado campo a campo), **Files**, **Backups**, **Metrics**, **Scheduler**, **Logs**.

## 4. Endereços para os jogadores

Cada servidor tem uma configuração de **Exposure** (exposição — cartão **Player access**, aba Overview da página do servidor):

- **Tailnet**: seus amigos instalam o Tailscale e entram na sua tailnet (compartilhamento de nó ou convite); o endereço a dar a eles é o IP `100.x.y.z` da máquina (ou o nome MagicDNS) + porta.
- **Direct**: endereço público — seu domínio, se a máquina for o host do painel em modo direct, senão o IPv6 global da máquina (ou o host público que você informa na página da máquina, cartão "Addresses for players"). Abra a porta do servidor (pinhole IPv6 no roteador + a regra exibida em Settings → Remote access → Firewall rules).

Jogadores na mesma rede local não precisam de nada: endereço LAN + porta, seja qual for o modo. O botão **Test reachability** do cartão realiza um _Server List Ping_ real a partir do host do painel (versão, jogadores, MOTD): é isso que um cliente Minecraft verá.

## 5. Várias máquinas

- Servidores podem ser **migrados** de uma máquina para outra (cartão **Migration** da aba Overview → **Migrate to another machine**): pré-verificações no destino (espaço em disco, Java, porta), transferência direta de agente para agente ou retransmitida pelo painel, chaveamento, e a pasta antiga é renomeada `.migrated-<date>`.
- Os **backups** têm um destino por servidor (local, ou uma pasta compartilhada/montada), rotação por política, restauração em um clique.
- Atualizações de agente: Settings → General → "Update agents automatically when they connect", ou manualmente pela página da máquina (cartão Agent). Um agente que não volta saudável em 30 s faz rollback sozinho para a versão anterior.

## 6. Remover uma máquina

Página da máquina → **Remove machine** (remover a máquina): ela desaparece do painel (servidores e arquivos permanecem intactos no disco). Na própria máquina: `install.ps1 -Uninstall` / `install.sh --uninstall` ([Instalação § 2](installation.md#2-os-agentes)).

## 7. Backups

Página do servidor → aba **Backups**. Duas metades:

- **Archives** (arquivos): crie um backup agora (funciona com o servidor em execução — o agente grava o mundo com `save-all` antes), baixe-o, restaure-o com um clique (por padrão é feita uma cópia de segurança do estado atual) ou apague-o. Cada arquivo mostra o seu tamanho, a data e o hash de integridade.
- **Policies** (políticas): backups programados executados **pelo agente**, com o painel online ou não. Escolha a frequência e quantos arquivos manter (a rotação nunca expira o arquivo bem-sucedido mais recente). «Only if running» (somente se estiver em execução) ignora um servidor parado. Os horários seguem o fuso horário de agendamento do painel, exibido sob o formulário.

Um servidor novo recebe uma política padrão (diária, manter 7). Se um backup programado falhar ou for ignorado, o painel registra isso e pode notificá-lo — veja as categorias de notificação nas configurações da sua conta. A pasta de destino é definida em Settings → General (com substituição por servidor na política).

## 8. Duplicar um servidor

Página do servidor → **Duplicate** (duplicar; abre-se uma caixa de diálogo): o painel copia o servidor para um servidor **novo**, na mesma máquina ou noutra. O caso típico é um servidor «modelo» que se clona na própria máquina.

O original nunca é modificado: se estava em execução, é parado durante a cópia e reiniciado automaticamente — tanto se a duplicação der certo como se falhar. O clone chega **parado**, com um selo «Copy», com identidade própria e com uma porta de jogo livre escolhida automaticamente pelo painel (mude-a depois em Configuration, se preferir outra). O seu RCON é reatribuído no primeiro arranque.

Por baixo é o mesmo mecanismo de uma migração (backup → transferência → restauração): ambas as máquinas precisam estar online, e demora mais ou menos o tempo de um backup mais uma restauração. Se algo falhar antes da restauração, nada é criado; se falhar depois, o clone é mantido e o erro diz o que verificar (a porta, em particular).

## 9. Grupos de arranque

Página **Servers** (visão da frota) → botão **Groups** (grupos, para administradores): crie um grupo, adicione servidores e ordene-os com as setas. Os servidores que pertencem a um grupo exibem um selo de grupo na lista.

**Iniciar o grupo** lança os servidores **um a um** na ordem escolhida, esperando que cada um esteja realmente em execução antes de passar ao seguinte; a parada percorre a ordem inversa. A série para no primeiro fracasso e notifica você. Só pode haver uma ação de grupo em curso de cada vez sobre um mesmo grupo.

Os agendamentos não miram grupos: para um arranque programado em sequência, escalone os agendamentos por servidor. Se um proxy Velocity pertencer ao grupo, coloque-o por último no arranque (a interface avisa se não estiver): convém que os servidores estejam prontos quando o proxy começar a aceitar jogadores.

## 10. Proxies Velocity

Uma pasta que contém um `velocity.toml` é reconhecida na varredura como um **proxy Velocity** e gerida como um servidor: iniciar, parar, console, logs.

Algumas diferenças são propositais: nenhuma versão do Minecraft é exibida (um proxy não tem), não há RCON nem TPS (o painel de métricas explica por quê), a parada limpa usa o comando `shutdown` do Velocity, a porta e o MOTD são lidos do `velocity.toml`, e não há EULA a aceitar. Ele é lançado com Java 17.

O agente da máquina precisa estar atualizado para detectar proxies — um agente antigo simplesmente os ignora.
