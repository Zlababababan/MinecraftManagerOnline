# Añadir una máquina

[English](../add-a-machine.md) · [Français](../fr/ajouter-une-machine.md) · **Español** · [Deutsch](../de/add-a-machine.md) · [Português](../pt/add-a-machine.md) · [Русский](../ru/add-a-machine.md) · [中文](../zh/add-a-machine.md)

_Traducción de la versión en inglés, que es la de referencia. La interfaz de la aplicación está disponible en inglés y en francés._

Una **máquina** = un ordenador que aloja servidores de Minecraft, dirigido por un agente. El propio host del panel puede ser una (el caso más habitual: todo se ejecuta en el PC de juego).

## 1. Crear la máquina y obtener el comando

1. Panel → **Machines** → **Add a machine** (añadir una máquina), asígnele un nombre.
2. El panel muestra un **código de emparejamiento** (`MMOP-XXXX-XXXX`, válido durante 15 minutos, de un solo uso) y el comando completo para Windows y para Linux/macOS.
3. Pegue el comando en la máquina de destino — véase [Instalación § 2](installation.md#2-los-agentes) para el detalle de lo que hace.
4. La máquina pasa a `online` en el panel. Si el código ha caducado, **New pairing code** (nuevo código de emparejamiento) genera otro (los códigos anteriores de la máquina se invalidan); ejecute el comando de nuevo.

El comando contiene la URL pública del panel: compruébela (Settings → General) si la máquina de destino no está en la misma red que usted.

## 2. Detectar servidores

En la página de la máquina: **Watched directories** (directorios vigilados) → añada la carpeta padre de sus servidores (p. ej. `E:\Minecraft\Server`, `/srv/minecraft`). El agente escanea (Forge, NeoForge, Fabric, Vanilla; 1.12 → 1.21+) y **adopta automáticamente** cada servidor detectado, con su loader, su versión y su RAM — el escaneo periódico se ejecuta por sí solo, **Scan now** (escanear ahora) fuerza una pasada inmediata y **Add a server folder** (añadir una carpeta de servidor) registra una carpeta concreta sin esperar. Todo sigue siendo editable después en la página del servidor (los packs retocados a mano a veces engañan a las heurísticas — se muestra el origen de cada valor detectado). No se modifica nada en disco durante la adopción, salvo la activación de RCON (`server.properties`, contraseña generada), necesaria para controlar el servidor en modo separado (detached).

Java: el agente inventaría los JRE presentes; si falta la versión requerida, instálela desde la tarjeta **Java runtimes** de la página de la máquina (botón **Install this runtime** — Temurin, en su defecto Zulu, descargado y verificado automáticamente).

## 3. Primer arranque de un servidor

Arranque el servidor desde su tarjeta (dashboard) o desde su página, y observe el estado pasar de `starting` a `running` (PID mostrado). La pestaña **Console** muestra las líneas en directo y acepta comandos. En el primer arranque de un servidor nuevo, si el EULA de Mojang aún no se ha aceptado, el panel le guía paso a paso (explicación, enlace, casilla) y, después, arranque de nuevo. Todo lo demás vive en las pestañas de la página del servidor: **Players** (whitelist, ops, bans — sin abrir jamás un fichero), **Configuration** (`server.properties` explicado campo a campo), **Files**, **Backups**, **Metrics**, **Scheduler**, **Logs**.

## 4. Direcciones para los jugadores

Cada servidor tiene un ajuste de **Exposure** (exposición; tarjeta **Player access**, pestaña Overview de la página del servidor):

- **Tailnet**: sus amigos instalan Tailscale y se unen a su tailnet (compartición del nodo o invitación); la dirección que hay que darles es la IP `100.x.y.z` de la máquina (o su nombre MagicDNS) + puerto.
- **Direct**: dirección pública — su dominio si la máquina es el host del panel en modo directo; si no, la IPv6 global de la máquina (o el host público que introduzca en la página de la máquina, tarjeta «Addresses for players»). Abra el puerto del servidor (pinhole IPv6 en el router + la regla mostrada en Settings → Remote access → Firewall rules).

Los jugadores de la misma red local no necesitan nada: dirección LAN + puerto, sea cual sea el modo. El botón **Test reachability** (probar la accesibilidad) de la tarjeta realiza un _Server List Ping_ real desde el host del panel (versión, jugadores, MOTD): es lo que verá un cliente de Minecraft.

## 5. Varias máquinas

- Los servidores pueden **migrarse** de una máquina a otra (tarjeta **Migration** de la pestaña Overview → **Migrate to another machine**): comprobaciones previas en el destino (espacio en disco, Java, puerto), transferencia directa de agente a agente o retransmitida por el panel, conmutación, y la carpeta antigua se renombra `.migrated-<date>`.
- Las **copias de seguridad** tienen un destino por servidor (local, o una carpeta compartida/montada), rotación por política, restauración en un clic.
- Actualización de los agentes: Settings → General → «Update agents automatically when they connect», o manualmente desde la página de la máquina (tarjeta Agent). Un agente que no vuelve sano en 30 s revierte por sí solo a la versión anterior.

## 6. Quitar una máquina

Página de la máquina → **Remove machine** (quitar la máquina): desaparece del panel (los servidores y los ficheros permanecen intactos en disco). En la propia máquina: `install.ps1 -Uninstall` / `install.sh --uninstall` ([Instalación § 2](installation.md#2-los-agentes)).
