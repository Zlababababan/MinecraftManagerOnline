# FAQ de rede

[English](../network-faq.md) · [Français](../fr/faq-reseau.md) · [Español](../es/network-faq.md) · [Deutsch](../de/network-faq.md) · **Português** · [Русский](../ru/network-faq.md) · [中文](../zh/network-faq.md)

_Tradução da versão em inglês, que é a referência. A interface do aplicativo está disponível em inglês e em francês._

O painel escuta **apenas** em `127.0.0.1` (ou em um endereço específico via `MMO_HOST`). Três maneiras de alcançá-lo de fora; uma basta.

## Tailscale (padrão, recomendado)

**Por quê**: funciona atrás de CGNAT, 4G, wi-fi de hotel, sem abrir porta nenhuma; certificado HTTPS automático; plano gratuito de até 6 usuários (3 em algumas ofertas — confira).

1. Instale o [Tailscale](https://tailscale.com/download) no host do painel e faça login.
2. No painel, Settings → Remote access, modo **Tailscale**: copie e execute o comando exibido, da forma
   `tailscale serve --bg --https=443 http://127.0.0.1:3000`.
   Ative **MagicDNS** e **HTTPS certificates** no console do Tailscale, se ainda não estiverem ativados.
3. A URL pública vira `https://<machine>.<tailnet>.ts.net`: informe-a em Settings → General.
4. Em cada dispositivo cliente (celular, PC de um amigo, uma máquina de agente remota): instale o Tailscale e entre na **mesma tailnet** (convide seus amigos, ou compartilhe o nó).
5. Execute o **Reachability test** (teste de alcançabilidade — mesma tela, botão **Run the test**): HTTP, WebSocket, frames binários e certificado TLS (os frames binários passam pelo `tailscale serve`).

Agentes: o comando de instalação usa a URL `https://…ts.net`; a máquina do agente, portanto, também precisa do Tailscale. Servidores Minecraft: exposição **Tailnet**, endereço `100.x.y.z:25565`.

Solução de problemas: `tailscale status` no host; `tailscale serve status` deve listar o proxy (`No serve config` = o comando serve nunca foi executado — o teste de alcançabilidade então falha com conexão recusada na porta 443); se o teste de WebSocket falha enquanto o de HTTP passa, verifique se não há outro proxy na frente (nginx) sem `Upgrade`. Se o terminal responder que `tailscale` não é reconhecido (Windows), a CLI não está no seu PATH: chame-a com o caminho completo entre aspas **duplas** (aspas simples quebram no Windows) — Prompt de Comando: `"C:\Program Files\Tailscale\tailscale.exe" serve …`, PowerShell: o mesmo com `&` na frente (ajuste para a sua pasta de instalação).

## Direct (IPv6 + seu próprio domínio)

**Por quê**: sem intermediário, seus amigos não instalam nada. **Requisito**: um IPv6 público (a maioria dos roteadores domésticos tem um) — IPv4 atrás de CGNAT não basta.

1. Um domínio: gratuito com o **DuckDNS** (`seu-nome.duckdns.org`) ou um domínio na Cloudflare; ou qualquer provedor no modo **manual** (você mesmo cria os registros).
2. Settings → Remote access, modo **Direct**: domínio, provedor DNS, token (DuckDNS: o token do site; Cloudflare: um token de API com `Zone:DNS:Edit`), e-mail ACME. **Save** (salvar) e depois **Request a certificate** (solicitar um certificado): o painel cria o registro TXT `_acme-challenge` (ou o exibe para você no modo manual), aguarda a propagação, obtém um certificado Let's Encrypt e abre um listener HTTPS no seu endereço IPv6 global, porta 443.
3. **DNS dinâmico**: o switch "Update the AAAA record automatically" (atualizar o registro AAAA automaticamente) — o painel atualiza o registro AAAA a cada 10 min (DuckDNS/Cloudflare/URL genérica). No modo manual, aponte você mesmo o registro AAAA para o IPv6 exibido.
4. **Roteador / firewall**: no roteador, crie um _pinhole_ IPv6 (Freebox: "Ouvrir un port IPv6"; Livebox: "Pare-feu IPv6") para o endereço do host, porta 443 TCP. No host, adicione a regra exibida em Settings → Remote access → **Firewall rules** (PowerShell `New-NetFirewallRule` / `ufw allow`). Endereços IPv6 _temporários_ (privacy extensions) mudam com o tempo: o painel escolhe o endereço estável visto no tick anterior; na dúvida, fixe-o em "Public IPv6 address".
5. URL pública: `https://seu-nome.duckdns.org` (Settings → General), e então execute o **Reachability test**.

Servidores Minecraft: exposição **Direct**, pinhole + regra de firewall por porta de jogo (exibida no mesmo lugar). Jogadores somente-IPv4 não conseguirão se conectar: prefira o Tailscale para eles.

Renovação: automática, verificada diariamente quando restam < 30 dias — exceto com DNS manual (o painel avisa você: solicite o certificado de novo).

## Manual (reverse proxy existente)

Aponte seu proxy (Caddy, nginx, Traefik…) para `http://127.0.0.1:3000` **com suporte a WebSocket** (`Upgrade`/`Connection`) e frames de pelo menos 16 MB, e repasse `X-Forwarded-Proto` / `X-Forwarded-Host`. Exemplo com Caddy:

```
panel.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Informe a URL pública e execute o teste de alcançabilidade: a linha "Seen via" (visto via) do resultado mostra "a reverse-proxy" quando os cabeçalhos são repassados corretamente.

## Perguntas frequentes

**O agente continua `offline` depois da instalação.** Na máquina, verifique os logs — Windows: `launcher.log` na raiz de `%LOCALAPPDATA%\Programs\mmo-agent` e os logs do serviço na sua subpasta `logs\`; Linux: `journalctl -u mmo-agent -f` (`--user` se instalado com `--user-service`); macOS: `/var/lib/mmo-agent/agent.log`. Causas habituais: URL do painel inacessível a partir daquela máquina (Tailscale não instalado/conectado, firewall), certificado não confiável (modo manual com uma CA privada: adicione-a ao repositório do sistema), código de pareamento expirado (a mensagem `pairing failed` aparece durante a instalação), ou estado de agente herdado de outro painel (`unknown, unpaired or disabled agent` nos logs — o instalador refaz o pareamento automaticamente; em último caso, desinstale com `-Purge` / `--purge` e execute o comando de instalação de novo).

**O painel está acessível, mas o WebSocket falha.** Um proxy sem `Upgrade`, ou com um timeout de inatividade curto. O teste de alcançabilidade mostra qual etapa falha (HTTP, WebSocket, Binary frames, TLS certificate).

**As notificações push nunca chegam.** Elas exigem HTTPS (Tailscale ou Direct) e, no iOS, a instalação do PWA na tela de início (Account → Push notifications guia você; veja também [Instalação § 4](installation.md#4-no-seu-celular-instale-o-pwa)). O botão "Send a test" no mesmo lugar verifica a cadeia inteira.

**Um servidor cai quando o agente para ou atualiza.** Não deveria acontecer: os servidores rodam desanexados e o serviço é configurado para encerrar apenas o agente (`KillMode=process`, `AbandonProcessGroup`, shawl). Se você instalou um serviço à mão, verifique essa configuração; nunca use `taskkill /T` no agente.

**Somente IPv4 (sem IPv6 no roteador).** O modo Direct é impossível sem um redirecionamento de porta IPv4 público; use o Tailscale.

**Portas.** Painel: 443 de entrada (somente no modo Direct). Agentes: nenhuma porta de entrada. Servidores Minecraft: 25565/TCP (e qualquer porta que você escolher) no modo Direct.
