# Instalación

[English](../installation.md) · [Français](../fr/installation.md) · **Español** · [Deutsch](../de/installation.md) · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

_Traducción de la versión en inglés, que es la de referencia. La interfaz de la aplicación está disponible en inglés y en francés._

Guía del usuario — instale el **panel** (una sola máquina, la que permanece encendida) y, después, un **agente** en cada máquina que aloje servidores de Minecraft (a menudo la misma). Todo se distribuye como archivos autónomos: no hay que instalar Node, Java ni Python de antemano.

Plataformas empaquetadas: **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, servidores ARM), **macOS Apple Silicon**. Windows ARM64 funciona con el archivo x64 (emulación). macOS Intel no está empaquetado.

## 1. El panel

### 1.1 Descarga

Obtenga el archivo `mmo-panel-<version>-<platform>.zip` (Windows) o `.tar.gz` (Linux / macOS) desde las [releases de GitHub](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Contiene el runtime de Node fijado, el panel, la interfaz web y los archivos de instalación del agente para las 4 plataformas (`dist-agent/`).

> ¿No hay archivo para su plataforma? Constrúyalo desde el código fuente en dos comandos: véase «Inicio rápido» en el [README](../../../README.es.md).

### 1.2 Extraer y ejecutar

**Windows** — extraiga en una carpeta permanente, por ejemplo `C:\mmo\panel`, y luego:

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux / macOS**:

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
/opt/mmo/mmo-panel/mmo-panel.sh
```

El panel escucha en `http://127.0.0.1:3000` (nunca en todas las interfaces — la capa de acceso, §3, es la que lo expone; `0.0.0.0` se rechaza al arrancar). Variables útiles: `MMO_PORT`, `MMO_HOST` (una dirección concreta), `MMO_DATA_DIR` (por defecto `./data` junto al script — **esta es la carpeta que hay que respaldar**: base de datos SQLite, métricas, certificados, releases). Además de la consola, el panel escribe su log en `data/logs/panel-<date>.log` (se conservan 14 días) — ahí es donde hay que mirar cuando algo ha ido mal después de cerrar la ventana.

### 1.3 Primer arranque

Abra `http://127.0.0.1:3000`: el asistente se desarrolla en dos pasos — **Administrator account** (cuenta de administrador: nombre de usuario, contraseña, idioma) y, después, **Access** (acceso): la **URL pública del panel** (opcional en esta fase), el **modo de acceso** (véase §3) y el **destino de copias de seguridad por defecto**. La URL pública puede cambiarse en cualquier momento en Settings → General: es la que se inyecta en los comandos de instalación de los agentes y en las notificaciones push — defínala en cuanto su acceso remoto esté operativo.

### 1.4 Arranque al iniciar el sistema (servicio)

**Windows** (shawl se incluye en el archivo) — en un PowerShell de **administrador**:

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

El servicio se ejecuta entonces como `LocalSystem`; para ejecutarlo con su propia cuenta (recomendado si las copias de seguridad apuntan a una unidad de red), use `services.msc` → Log On, o adapte el procedimiento del agente (§2.2). Variables de entorno (`MMO_PORT`…): `shawl add --env MMO_PORT=3000 …`.

> Importante: `mmo-panel.cmd` define `MMO_WEB_DIR` y `MMO_DIST_DIR`; con shawl, añádalas explícitamente: `--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`.

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

**macOS** (launchd) — `/Library/LaunchDaemons/com.mmo.panel.plist` con `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` y `KeepAlive` a `true`, y luego `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Actualizar el panel

Detenga el servicio, extraiga el nuevo archivo **encima** (la carpeta `data/` nunca está dentro del archivo) y reinicie. Las migraciones de la base de datos se ejecutan al arrancar. El nuevo archivo incluye agentes de la misma versión: el panel publica la release del agente automáticamente y, si «Update agents automatically when they connect» (actualizar los agentes automáticamente cuando se conectan) está marcado (Settings → General — desmarcado por defecto), cada agente se actualiza en su siguiente conexión, con rollback automático en caso de fallo. Si no, actualícelos uno a uno desde la tarjeta Agent de la página de cada máquina.

### 1.6 Copia de seguridad y restauración del panel

El panel se respalda a sí mismo una vez al día (copia coherente `VACUUM INTO` de su base de datos) en `data/backups/panel/mmo-<date>.db`, con 7 copias conservadas; Settings → Panel backups permite crear una bajo demanda. Las métricas (`metrics.db`) no se copian: pueden reconstruirse y ocupan mucho. Respalde también la carpeta `data/` completa si quiere conservar los certificados y los archivos de los agentes.

Para **restaurar**: detenga el panel (servicio o Ctrl+C) y luego:

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

Basta con el nombre del fichero para una copia situada en `data/backups/panel/`; también se acepta una ruta completa. La copia se verifica (`integrity_check`), la base de datos actual se conserva como `mmo.db.before-restore-<date>` y, después, el panel puede reiniciarse: los agentes se reconectan con su secreto original y los servidores que alojan se readoptan con los mismos identificadores (marcador `.mmo-server.json`). Todo lo creado después de la copia de seguridad (usuarios, máquinas emparejadas, ajustes) se pierde: una máquina emparejada después de la copia tendrá que emparejarse de nuevo. La restauración se niega a ejecutarse si `mmo.db-wal` no está vacío (panel aún en marcha, o terminado bruscamente — arránquelo, deténgalo limpiamente e inténtelo de nuevo).

## 2. Los agentes

Un agente por máquina que aloja servidores. Se conecta de forma **saliente** al panel (WebSocket): ningún puerto que abrir en las máquinas de los agentes.

### 2.1 El comando de una línea

En el panel: **Machines → Add a machine** (Máquinas → Añadir una máquina). El panel genera un código de emparejamiento (válido durante 15 minutos) y el comando completo que hay que pegar en la máquina de destino:

- **Windows** (PowerShell, cualquier versión):
  `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -PairCode MMOP-XXXX-XXXX`
- **Linux / macOS**:
  `curl -fsSL https://<panel>/install.sh | sh -s -- --pair-code MMOP-XXXX-XXXX`

El script descarga del panel el archivo de la plataforma adecuada, verifica su hash SHA-256, instala los ficheros, **empareja** el agente (el error es inmediato si el código ha caducado) y, por último, registra y arranca el servicio. La máquina aparece `online` en el panel en unos segundos.

> El panel debe ser accesible desde la máquina de destino (§3). Mientras la URL pública no esté definida, el comando usa la dirección con la que usted abrió el panel.

### 2.2 Qué hace el script — Windows

- Ficheros en `%LOCALAPPDATA%\Programs\mmo-agent` (runtime, `launcher.cjs`, `versions/<v>/agent.js`, `shawl.exe`), estado en `%LOCALAPPDATA%\mmo-agent`.
- El servicio `mmo-agent` se registra con **shawl**, arranque automático; se ejecuta **con su cuenta de Windows** (la contraseña se pide una sola vez, en la ventana elevada que se abre) para que el agente pueda ver sus unidades de red mapeadas y sus carpetas. Para ser exactos: la cuenta de la ventana elevada — si el UAC le hace introducir las credenciales de otro administrador, esa es la cuenta con la que se ejecutará el servicio. El derecho «Log on as a service» (iniciar sesión como servicio) se concede automáticamente (si eso falla, el script continúa y explica cómo concederlo con `secpol.msc`). Alternativa: `-ServiceAccount LocalSystem`.
- **Cuenta sin contraseña** (sesión abierta con un PIN o sin contraseña alguna): Windows prohíbe que los servicios inicien sesión con una contraseña vacía. Confirme la solicitud vacía: el script lo indica y registra el servicio como `LocalSystem` (el agente entonces no puede ver sus unidades de red mapeadas). Para volver a su cuenta: establezca una contraseña de Windows y ejecute el comando de nuevo.
- Si algo falla en la ventana elevada, el mensaje permanece en pantalla (Enter para cerrar) y los detalles quedan en `%TEMP%\mmo-install.log`.
- El servicio se reinicia automáticamente si se bloquea; parada limpia = Ctrl+C reenviado al agente, **nunca** a todo el árbol de procesos: los servidores de Minecraft sobreviven a la parada o actualización del agente y luego se readoptan.
- Opciones: `-NoService` (solo los ficheros), `-InstallDir`, `-StateDir`, `-Panel`, `-Archive <zip>` (sin conexión).
- Desinstalación: `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -Uninstall` (añada `-Purge` para eliminar también el estado; los servidores de Minecraft no se tocan nunca).

### 2.3 Qué hace el script — Linux

- Ficheros en `/opt/mmo-agent`, estado en `/var/lib/mmo-agent`, cuenta de sistema `mmo` creada si es necesario (`--user <name>` para otra cuenta — el agente debe poder leer/escribir en las carpetas de los servidores).
- Unidad systemd `mmo-agent` con `KillMode=process` (los servidores separados sobreviven) y `Restart=on-failure`. Se pide `sudo` cuando hace falta.
- **Sin root**: `--user-service` instala en `~/.local/share/mmo-agent` (ficheros en `app/`, estado en la raíz) con `systemctl --user` y `loginctl enable-linger` (arranca con el sistema sin sesión abierta). Atención: ejecutado con `sudo`, `--user-service` se ignora y se realiza la instalación a nivel de sistema.
- Opciones: `--no-service`, `--dir`, `--state-dir`, `--panel`, `--archive <tar.gz>` (sin conexión).
- Desinstalación: `curl -fsSL https://<panel>/install.sh | sh -s -- --uninstall [--purge]` (añada `--user-service` si se instaló así). La cuenta de sistema `mmo` se conserva (`userdel mmo` si ya no la quiere).
- Bajo **WSL**, la VM se detiene unos segundos después de cerrarse el último terminal: el servicio (y los servidores) se detienen con ella — WSL sirve para hacer pruebas, no para alojar.

### 2.4 Qué hace el script — macOS

La misma lógica: `/opt/mmo-agent`, LaunchDaemon `com.mmo.agent` (`KeepAlive`, `AbandonProcessGroup`: los servidores sobreviven), cuenta = el usuario que ejecuta `sudo`. `--user-service` crea en su lugar un LaunchAgent (arranca solo al iniciar la sesión). Log: `/var/lib/mmo-agent/agent.log`.

### 2.5 Tras el reinicio de la máquina

El servicio relanza el agente; el agente readopta los servidores aún vivos (PID + hora de inicio + línea de comandos) y, si «Restore desired state when an agent boots» (restaurar el estado deseado cuando un agente arranca) está activado (Settings → General), reinicia los que estaban marcados `running`.

### 2.6 Instalación sin conexión

Descargue el archivo de la plataforma desde el panel (Settings → Agent distribution) o desde la release, cópielo junto con el script (`install.ps1` / `install.sh` también están dentro del archivo) y ejecute `install.ps1 -Archive <zip> -Panel https://<panel> -PairCode …` o `sh install.sh --archive <tar.gz> --panel https://<panel> --pair-code …` (el hash SHA-256 solo se verifica para un archivo descargado del panel — un archivo local se toma tal cual).

## 3. Acceso remoto (resumen)

El panel solo escucha en `127.0.0.1`. Para alcanzarlo desde los agentes de otras máquinas, desde sus amigos y desde su teléfono, elija un modo (Settings → Remote access — ajustes → acceso remoto):

| Modo                        | Para quién es                                              | Qué hacer                                                                                                                   |
| --------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Tailscale** (por defecto) | Todo el mundo, incluso detrás de CGNAT/4G                  | Instale Tailscale en el host del panel y en cada dispositivo cliente, y luego ejecute el comando `tailscale serve` mostrado |
| **Direct**                  | Tiene una IPv6 pública y un dominio (DuckDNS, Cloudflare…) | Introduzca dominio + proveedor DNS, solicite el certificado (DNS-01), abra el puerto 443 (pinhole IPv6 en el router)        |
| **Manual**                  | Ya tiene un reverse proxy en marcha                        | Apúntelo a `127.0.0.1:3000` con soporte de WebSocket                                                                        |

En todos los casos, la tarjeta **Reachability test** (test de accesibilidad; botón **Run the test**, en Settings → Remote access) comprueba HTTP, WebSocket, las tramas binarias (64 KiB) y el certificado TLS a través de la URL pública. Detalles y resolución de problemas: [FAQ de red](network-faq.md). Añadir máquinas y direcciones que dar a los jugadores: [Añadir una máquina](add-a-machine.md).

## 4. En el teléfono: instalar la PWA

El panel es una aplicación web instalable (PWA): una vez el acceso remoto en marcha (§3 — la instalación requiere HTTPS), abra la URL pública en el navegador del teléfono y añada la aplicación a la pantalla de inicio:

- **Android (Chrome)**: menú ⋮ → «Añadir a pantalla de inicio» (o «Instalar app» cuando se ofrece).
- **iOS (Safari)**: botón Compartir → «Añadir a pantalla de inicio». En iOS esto es **obligatorio** para recibir notificaciones push: solo funcionan desde la PWA instalada, no desde Safari.

La aplicación se abre entonces a pantalla completa, con la navegación en la parte inferior. Para las notificaciones (caída de un servidor, copia de seguridad fallida, agente sin conexión…): página Account (cuenta) → Push notifications — actívelas, elija las categorías y compruebe con el botón «Send a test» (enviar una prueba). En modo Tailscale, el teléfono debe tener la aplicación de Tailscale instalada y conectada al tailnet para alcanzar el panel.
