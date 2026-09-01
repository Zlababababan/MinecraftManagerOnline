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

## 7. Copias de seguridad

Página del servidor → pestaña **Backups**. Dos mitades:

- **Archives** (archivos): cree una copia ahora (funciona con el servidor en marcha — el agente vuelca el mundo con `save-all` antes), descárguela, restáurela con un clic (por defecto se toma una copia de seguridad del estado actual) o bórrela. Cada archivo muestra su tamaño, su fecha y su hash de integridad.
- **Policies** (políticas): copias programadas ejecutadas **por el agente**, esté el panel en línea o no. Elija la frecuencia y cuántos archivos conservar (la rotación nunca caduca el archivo correcto más reciente). «Only if running» (solo si está en marcha) omite un servidor detenido. Las horas siguen la zona horaria de planificación del panel, que se muestra bajo el formulario.

Un servidor nuevo recibe una política por defecto (diaria, conservar 7). Si una copia programada falla o se omite, el panel lo registra y puede avisarle — véanse las categorías de notificación en los ajustes de su cuenta. La carpeta de destino se define en Settings → General (con posibilidad de anularla por servidor en la política).

## 8. Duplicar un servidor

Página del servidor → **Duplicate** (duplicar; se abre un diálogo): el panel copia el servidor en un servidor **nuevo**, en la misma máquina o en otra. El caso típico es un servidor «plantilla» que se clona en su propia máquina.

El original nunca se modifica: si estaba en marcha, se detiene durante la copia y se vuelve a arrancar automáticamente — tanto si la duplicación tiene éxito como si falla. El clon llega **detenido**, con una insignia «Copy», con su propia identidad y con un puerto de juego libre elegido automáticamente por el panel (cámbielo después en Configuration si prefiere otro). Su RCON se reasigna en el primer arranque.

Por debajo es el mismo mecanismo que una migración (copia → transferencia → restauración): ambas máquinas deben estar en línea, y tarda aproximadamente lo que una copia más una restauración. Si algo falla antes de la restauración, no se crea nada; si falla después, el clon se conserva y el error indica qué comprobar (el puerto, en particular).

## 9. Grupos de arranque

Página **Servers** (vista de flota) → botón **Groups** (grupos, para administradores): cree un grupo, añádale servidores y ordénelos con las flechas. Los servidores que pertenecen a un grupo muestran una insignia de grupo en la lista.

**Arrancar el grupo** lanza los servidores **uno a uno** en el orden elegido, esperando a que cada uno esté realmente en marcha antes de pasar al siguiente; al detener, recorre el orden inverso. La serie se detiene en el primer fallo y se lo notifica. Solo puede ejecutarse una acción de grupo a la vez sobre un mismo grupo.

Las planificaciones no apuntan a grupos: para un arranque programado en secuencia, escalone las planificaciones por servidor. Si un proxy Velocity pertenece al grupo, póngalo el último para el arranque (la interfaz se lo advierte si no lo está): conviene que los servidores estén listos cuando el proxy empiece a aceptar jugadores.

## 10. Proxies Velocity

Una carpeta que contiene un `velocity.toml` se reconoce durante el escaneo como un **proxy Velocity** y se gestiona como un servidor: arranque, parada, consola, logs.

Algunas diferencias son deliberadas: no se muestra versión de Minecraft (un proxy no tiene), no hay RCON ni TPS (el panel de métricas explica por qué), la parada limpia usa el comando `shutdown` de Velocity, el puerto y el MOTD se leen de `velocity.toml`, y no hay EULA que aceptar. Se usa Java 17 para lanzarlo.

El agente de la máquina debe estar actualizado para detectar proxies — un agente antiguo simplemente los ignora.
