# FAQ de red

[English](../network-faq.md) · [Français](../fr/faq-reseau.md) · **Español** · [Deutsch](../de/network-faq.md) · [Português](../pt/network-faq.md) · [Русский](../ru/network-faq.md) · [中文](../zh/network-faq.md)

_Traducción de la versión en inglés, que es la de referencia. La interfaz de la aplicación está disponible en inglés y en francés._

El panel escucha **solo** en `127.0.0.1` (o en una dirección concreta mediante `MMO_HOST`). Tres formas de alcanzarlo desde fuera; con una basta.

## Tailscale (por defecto, recomendado)

**Por qué**: funciona detrás de CGNAT, 4G, wifi de hotel, sin abrir ningún puerto; certificado HTTPS automático; plan gratuito hasta 6 usuarios (3 en algunas ofertas — compruébelo).

1. Instale [Tailscale](https://tailscale.com/download) en el host del panel e inicie sesión.
2. En el panel, Settings → Remote access (ajustes → acceso remoto), modo **Tailscale**: copie y ejecute el comando mostrado, de la forma
   `tailscale serve --bg --https=443 http://127.0.0.1:3000`.
   Active **MagicDNS** y **HTTPS certificates** en la consola de Tailscale si no está ya hecho.
3. La URL pública pasa a ser `https://<machine>.<tailnet>.ts.net`: introdúzcala en Settings → General.
4. En cada dispositivo cliente (el teléfono, el PC de un amigo, una máquina de agente remota): instale Tailscale y únase al **mismo tailnet** (invite a sus amigos, o comparta el nodo).
5. Ejecute el **Reachability test** (test de accesibilidad; misma pantalla, botón **Run the test**): HTTP, WebSocket, tramas binarias y certificado TLS (las tramas binarias pasan por `tailscale serve`).

Agentes: el comando de instalación usa la URL `https://…ts.net`; la máquina del agente necesita, por tanto, Tailscale también. Servidores de Minecraft: exposición **Tailnet**, dirección `100.x.y.z:25565`.

Resolución de problemas: `tailscale status` en el host; `tailscale serve status` debe listar el proxy (`No serve config` = el comando serve no se ejecutó nunca — el test de accesibilidad falla entonces con una conexión rechazada en el puerto 443); si el test de WebSocket falla mientras HTTP pasa, compruebe que no tiene otro proxy delante (nginx) sin `Upgrade`. Si el terminal responde que `tailscale` no se reconoce (Windows), la CLI no está en su PATH: llámela con su ruta completa entre comillas **dobles** (las simples fallan en Windows) — Símbolo del sistema: `"C:\Program Files\Tailscale\tailscale.exe" serve …`, PowerShell: lo mismo con `&` delante (ajústelo a su carpeta de instalación).

## Direct (IPv6 + dominio propio)

**Por qué**: sin intermediario, sus amigos no instalan nada. **Requisito**: una IPv6 pública (la mayoría de los routers domésticos la tienen) — una IPv4 detrás de CGNAT no basta.

1. Un dominio: gratuito con **DuckDNS** (`su-nombre.duckdns.org`) o un dominio en Cloudflare; o cualquier proveedor en modo **manual** (usted mismo crea los registros).
2. Settings → Remote access, modo **Direct**: dominio, proveedor DNS, token (DuckDNS: el token del sitio; Cloudflare: un token de API con `Zone:DNS:Edit`), correo ACME. **Save** (guardar) y luego **Request a certificate** (solicitar un certificado): el panel crea el registro TXT `_acme-challenge` (o se lo muestra en modo manual), espera la propagación, obtiene un certificado de Let's Encrypt y abre un listener HTTPS en su dirección IPv6 global, puerto 443.
3. **DNS dinámico**: el interruptor «Update the AAAA record automatically» (actualizar el registro AAAA automáticamente) — el panel actualiza el registro AAAA cada 10 min (DuckDNS/Cloudflare/URL genérica). En modo manual, apunte usted mismo el registro AAAA a la IPv6 mostrada.
4. **Router / cortafuegos**: en el router, cree un _pinhole_ IPv6 (Freebox: «Ouvrir un port IPv6»; Livebox: «Pare-feu IPv6») hacia la dirección del host, puerto 443 TCP. En el host, añada la regla mostrada en Settings → Remote access → **Firewall rules** (reglas de cortafuegos; PowerShell `New-NetFirewallRule` / `ufw allow`). Las direcciones IPv6 _temporales_ (privacy extensions) cambian con el tiempo: el panel elige la dirección estable vista en el tick anterior; en caso de duda, fíjela en «Public IPv6 address».
5. URL pública: `https://su-nombre.duckdns.org` (Settings → General), y luego ejecute el **Reachability test**.

Servidores de Minecraft: exposición **Direct**, pinhole + regla de cortafuegos por puerto de juego (mostrada en el mismo lugar). Los jugadores que solo tengan IPv4 no podrán conectarse: para ellos, prefiera Tailscale.

Renovación: automática, comprobada a diario cuando quedan < 30 días — salvo con DNS manual (el panel se lo avisa: solicite el certificado de nuevo).

## Manual (reverse proxy existente)

Apunte su proxy (Caddy, nginx, Traefik…) a `http://127.0.0.1:3000` **con soporte de WebSocket** (`Upgrade`/`Connection`) y tramas de al menos 16 MB, y reenvíe `X-Forwarded-Proto` / `X-Forwarded-Host`. Ejemplo con Caddy:

```
panel.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Introduzca la URL pública y ejecute el test de accesibilidad: la línea «Seen via» (visto a través de) del resultado indica «a reverse-proxy» cuando las cabeceras se reenvían correctamente.

## Preguntas frecuentes

**El agente permanece `offline` tras la instalación.** En la máquina, consulte los logs — Windows: `launcher.log` en la raíz de `%LOCALAPPDATA%\Programs\mmo-agent` y los logs del servicio en su subcarpeta `logs\`; Linux: `journalctl -u mmo-agent -f` (`--user` si se instaló con `--user-service`); macOS: `/var/lib/mmo-agent/agent.log`. Causas habituales: URL del panel inaccesible desde esa máquina (Tailscale no instalado/conectado, cortafuegos), certificado no confiable (modo manual con una CA privada: añádala al almacén del sistema), código de emparejamiento caducado (el mensaje `pairing failed` se muestra durante la instalación), o estado del agente heredado de otro panel (`unknown, unpaired or disabled agent` en los logs — el instalador vuelve a emparejar automáticamente; como último recurso, desinstale con `-Purge` / `--purge` y vuelva a ejecutar el comando de instalación).

**El panel es accesible pero WebSocket falla.** Un proxy sin `Upgrade`, o con un timeout de inactividad corto. El test de accesibilidad muestra qué paso falla (HTTP, WebSocket, Binary frames, TLS certificate).

**Las notificaciones push no llegan nunca.** Requieren HTTPS (Tailscale o Direct) y, en iOS, instalar la PWA en la pantalla de inicio (Account → Push notifications le guía paso a paso; véase también [Instalación § 4](installation.md#4-en-el-teléfono-instalar-la-pwa)). El botón «Send a test» (enviar una prueba), en el mismo lugar, comprueba toda la cadena.

**Un servidor se cae cuando el agente se detiene o se actualiza.** No debería ocurrir: los servidores se ejecutan separados (detached) y el servicio está configurado para matar solo al agente (`KillMode=process`, `AbandonProcessGroup`, shawl). Si instaló un servicio a mano, compruebe ese ajuste; no use nunca `taskkill /T` sobre el agente.

**Solo IPv4 (sin IPv6 en el router).** El modo Direct es imposible sin una redirección de puerto IPv4 pública; use Tailscale.

**Puertos.** Panel: 443 entrante (solo en modo Direct). Agentes: ningún puerto entrante. Servidores de Minecraft: 25565/TCP (y cualquier puerto que haya elegido) en modo Direct.

## Cortafuegos

Por defecto el panel no expone **nada**: escucha solo en `127.0.0.1`. En modo **Tailscale**, por tanto, no hay ninguna regla que abrir en ninguna parte — el tailnet alcanza el panel mediante una conexión saliente. En modo **Direct**, abra en entrada el puerto HTTPS que haya elegido (443 por defecto) en el host — el comando exacto se muestra en Settings → Remote access → **Firewall rules** (reglas de cortafuegos).

**Oracle Cloud** (la VM gratuita aloja paneles con frecuencia): son dos barreras distintas, y hay que abrir las dos.

- En la propia VM, las reglas de iptables de la imagen Ubuntu de Oracle terminan con un REJECT global: la regla de apertura debe **insertarse antes** de él. `-I` (insert) hace exactamente eso; un `-A` (append) queda después del REJECT y no sirve de nada.

  ```bash
  sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

- La **Security List** de la VCN se configura en la consola web de Oracle, no en la VM: añada también allí una regla de entrada para TCP 443 (Networking → Virtual cloud networks → su VCN → Security Lists).

Con Tailscale nada de esto hace falta — ni iptables, ni Security List: en buena medida, esa es la razón de ser del modo por defecto.

## Una vía por máquina

El modo es un valor por defecto, no un muro. Una máquina que no puede unirse al tailnet (una VM alquilada, el servidor de un amigo) puede engancharse a la dirección **directa** mientras las demás siguen usando Tailscale: en Settings → Remote access, active **«Also answer on the direct route»** (responder también por la vía directa) y configure debajo el dominio y el certificado — el panel responde entonces por ambas vías a la vez.

Cada agente recuerda la dirección con la que se emparejó. Cuando genere un código de emparejamiento desde la página de una máquina, aparece un selector **«Panel address for this machine»** (dirección del panel para esta máquina) en cuanto hay elección: escoja la URL por defecto o la vía directa, y el comando de instalación se reconstruye con esa dirección. No hay nada que cambiar en las máquinas ya emparejadas — conservan su vía.
