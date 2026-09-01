# Instalación

[English](../installation.md) · [Français](../fr/installation.md) · **Español** · [Deutsch](../de/installation.md) · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

_Traducción comunitaria de la versión en inglés, que es la de referencia: puede ir con retraso — en caso de duda, consulte la [versión en inglés](../installation.md). La interfaz de la aplicación está disponible en inglés y en francés._

Guía del usuario — instale el **panel** (una sola máquina, la que permanece encendida) y, después, un **agente** en cada máquina que aloje servidores de Minecraft (a menudo la misma). Todo se distribuye como archivos autónomos: no hay que instalar Node, Java ni Python de antemano.

Plataformas empaquetadas: **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, servidores ARM), **macOS Apple Silicon**. Windows ARM64 funciona con el archivo x64 (emulación). macOS Intel no está empaquetado.

**¿Qué distribuciones de Linux?** Desde la 1.0.5 el panel no contiene ningún módulo compilado, así que **funciona en cualquier distribución basada en glibc**: Ubuntu 20.04 y posteriores, Debian 11 y posteriores, Fedora, Rocky/Alma/RHEL 9, openSUSE, Raspberry Pi OS, Oracle Linux, Arch… No hay nada que instalar: ni compilador ni paquetes de desarrollo. La única excepción es **Alpine** y otros sistemas basados en musl, que el runtime de Node incluido no admite: use la imagen Docker oficial (§1.2 — lleva su propia libc), una distribución con glibc, o ejecute el panel con su propio Node ≥ 24 (`node app/dist/main.js` desde la carpeta extraída).

## 1. El panel

### 1.1 Descarga

Abra la [página de releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest) y descargue el archivo que corresponda a su máquina:

| Su máquina                                     | Archivo a descargar                       |
| ---------------------------------------------- | ----------------------------------------- |
| Windows (cualquier PC reciente)                | `mmo-panel-<version>-win-x64.zip`         |
| Linux en un PC o servidor normal               | `mmo-panel-<version>-linux-x64.tar.gz`    |
| Linux en ARM (Raspberry Pi, VM Oracle/Ampere…) | `mmo-panel-<version>-linux-arm64.tar.gz`  |
| Mac con Apple Silicon (M1–M4)                  | `mmo-panel-<version>-darwin-arm64.tar.gz` |

¿No sabe qué Linux tiene? Ejecute `uname -m`: `x86_64` significa x64, `aarch64` significa ARM64.

El archivo es autónomo: lleva su propio runtime de Node, el panel, la interfaz web y los instaladores del agente para las cuatro plataformas. **No hay nada que instalar de antemano**: ni Node, ni Java, ni compilador, ni paquete de desarrollo.

> **¿Quiere comprobar la descarga?** Cada release publica `SHA256SUMS.txt`: descárguelo junto a su archivo y ejecute `sha256sum -c SHA256SUMS.txt --ignore-missing` (Linux), `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS), o compare `Get-FileHash <archivo>` con la línea que lleva el nombre de su archivo (Windows). Los manifiestos `panel-<plataforma>.json` llevan las mismas huellas, de uno en uno.

### 1.2 Extraer y ejecutar

**Linux, un solo comando.** En una máquina con systemd (Ubuntu, Debian, Fedora, Raspberry Pi OS…), un único copiar y pegar hace todo lo que describen §1.1 a §1.4 — descarga, verificación SHA-256, código en `/opt/mmo-panel`, datos en `/var/lib/mmo-panel`, ajustes en `/etc/mmo-panel/panel.env`, servicio systemd endurecido, y después espera a que el panel responda:

```bash
curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
```

Ejecute **el mismo comando otra vez para actualizar**: primero se hace una copia de la base de datos y, si la nueva versión no arranca, se restablece la anterior. `--uninstall` la desinstala (`--purge` borra además los datos) y `--help` enumera las demás opciones (instalación sin conexión `--archive`, `--dir`, `--data-dir`…). Si prefiere ver cada paso, la vía manual que sigue está plenamente soportada: el instalador y la vía manual llevan al mismo resultado.

**Docker.** La imagen oficial (multiarquitectura x64/ARM64, con los agentes incluidos) es la respuesta cuando la máquina usa Alpine/musl, o cuando ya lo ejecuta todo en contenedores. Descargue [docker-compose.yml](https://github.com/Zlababababan/MinecraftManagerOnline/blob/main/docker-compose.yml) y nada más, y después:

```bash
docker compose up -d
```

El panel responde en `http://127.0.0.1:3000`. Los datos viven en el **volumen con nombre** `mmo-data` — resista la tentación de un bind mount `./data`: creado por root en el primer `up`, reproduce exactamente el error de permisos «no se puede abrir la base de datos», ya que el contenedor se ejecuta como el usuario `node` (uid 1000). Dentro del contenedor el panel escucha en todas las interfaces (una opción explícita de la imagen): es la línea `ports:` la que decide la exposición real — mantenga `127.0.0.1:3000:3000` y ponga `tailscale serve` (§3) en el host, o expóngalo a conciencia. CLI: `docker compose exec panel /app/entrypoint.sh doctor` (ídem `setup`, `restore`).

**Windows, un solo comando.** La misma idea, en un PowerShell (pide la elevación por sí mismo) — código en `C:\Program Files\mmo-panel`, datos en `C:\ProgramData\mmo-panel`, un servicio de Windows con arranque automático diferido:

```powershell
& ([scriptblock]::Create((irm https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.ps1)))
```

Ejecútelo otra vez para actualizar (copia de seguridad primero, vuelta atrás si la nueva versión no arranca). Opciones: `-Port`, `-Archive` (sin conexión), `-MigrateFrom C:\viejo\panel` (copia los datos de una instalación manual anterior, verificados con `integrity_check`, sin tocar el original), `-ServiceAccount User` (si las copias de seguridad van a una unidad de red), `-Uninstall` (`-Purge` borra además los datos). Sus elecciones se recuerdan para la siguiente actualización.

El instalador también coloca **MinecraftManagerOnline** en el menú Inicio: un pequeño icono junto al reloj — clic izquierdo abre la interfaz, clic derecho ofrece abrir, logs, iniciar/detener/reiniciar, «iniciar con Windows» y salir. El icono maneja el servicio (nunca arranca un segundo panel); en una instalación sin servicio, lanza el panel él mismo y al salir lo detiene.

**Windows, vía manual.** Clic derecho en el `.zip` → **Extraer todo**, en una carpeta que vaya a conservar, por ejemplo `C:\mmo\panel` (evite Descargas y el Escritorio). Abra esa carpeta y haga doble clic en **`mmo-panel.cmd`**. Se abre una ventana negra que permanece abierta: eso es el panel en marcha, y cerrarla detiene el panel — el §1.4 lo convierte en un servicio de verdad. Desde un terminal:

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux.** En un terminal, en la carpeta donde se descargó el archivo:

```bash
tar -xzf mmo-panel-*.tar.gz
cd mmo-panel
./mmo-panel.sh
```

Con eso basta para probarlo. Para una máquina que vaya a quedarse encendida, póngalo en un sitio permanente — y atención al `chown`, el error que más tiempo cuesta:

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
sudo chown -R "$USER" /opt/mmo/mmo-panel   # extraído como root — entrégueselo al usuario que lo lanza (§1.4 se lo entrega a la cuenta de servicio mmo)
/opt/mmo/mmo-panel/mmo-panel.sh
```

**macOS** — los mismos comandos que en Linux. En el primer arranque macOS puede negarse a ejecutar un binario descargado: Ajustes del Sistema → Privacidad y seguridad → «Abrir de todos modos».

> ¿Algo va mal? `mmo-panel.cmd doctor` (Windows) o `./mmo-panel.sh doctor` (Linux/macOS) comprueba el runtime, la carpeta de datos y su propietario, la base de datos y el puerto, y dice qué hacer — véase §1.6.

El panel escucha en `http://127.0.0.1:3000` (nunca en todas las interfaces — la capa de acceso, §3, es la que lo expone; `0.0.0.0` se rechaza al arrancar). Variables útiles: `MMO_PORT`, `MMO_HOST` (una dirección concreta), `MMO_DATA_DIR` (por defecto `./data` junto al script — **esta es la carpeta que hay que respaldar**: base de datos SQLite, métricas, certificados, releases). Además de la consola, el panel escribe su log en `data/logs/panel-<date>.log` (se conservan 14 días) — ahí es donde hay que mirar cuando algo ha ido mal después de cerrar la ventana.

### 1.3 Primer arranque

Abra `http://127.0.0.1:3000`. En una máquina sin pantalla (servidor, VM): configure antes el acceso remoto (§3 — instale Tailscale, ejecute el comando `tailscale serve` y abra `https://<máquina>.<tailnet>.ts.net` desde otro dispositivo) o use un túnel SSH (`ssh -L 3000:127.0.0.1:3000 usuario@máquina` y después abra `http://127.0.0.1:3000` en local). El asistente se desarrolla en dos pasos — **Administrator account** (cuenta de administrador: nombre de usuario, contraseña, idioma) y, después, **Access** (acceso): la **URL pública del panel** (opcional en esta fase), el **modo de acceso** (véase §3) y el **destino de copias de seguridad por defecto**. La URL pública puede cambiarse en cualquier momento en Settings → General: es la que se inyecta en los comandos de instalación de los agentes y en las notificaciones push — defínala en cuanto su acceso remoto esté operativo.

**Sin navegador alguno** (VM en la nube, contenedor, cloud-init), la cuenta de administrador se crea desde la línea de comandos: `setup` es exactamente el mismo código que el asistente. En una VM nueva en la nube a la que se llega por SSH (Oracle, AWS, Hetzner…), la secuencia completa es esta:

1. **Instalar** — el instalador de un solo comando del §1.2 lo hace todo, servicio incluido:

   ```bash
   curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
   ```

2. **Crear la cuenta de administrador.** El instalador ejecuta el panel bajo la cuenta de servicio `mmo`, con sus datos en `/var/lib/mmo-panel` — ejecute `setup` con esa misma identidad:

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --random-password
   ```

   La contraseña generada se muestra una sola vez: cópiela de inmediato. Use `--password-stdin` (`echo -n 'secreto' | … setup --username admin --password-stdin`) o `--password-file <archivo>` para elegirla usted — nunca la pase como argumento, la línea de comandos es visible para todos los procesos de la máquina. `--public-url`, `--locale` y `--access-mode` son opcionales. El comando se niega a ejecutarse dos veces. En una instalación manual (§1.2), donde los datos viven junto al script y le pertenecen a usted, no hace falta prefijo alguno: `/opt/mmo/mmo-panel/mmo-panel.sh setup --username admin --random-password --public-url panel.example.net`.

3. **Comprobar.** `doctor` (§1.6) inspecciona toda la instalación, y el log del panel fluye por journalctl:

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh doctor
   journalctl -u mmo-panel -f
   ```

4. **Abrir la interfaz desde su propio ordenador** (§3). O bien instale Tailscale en la VM y exponga el panel en su tailnet:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

   y después abra `https://<vm>.<tailnet>.ts.net` — o bien, para un primer vistazo rápido sin instalar nada, use un túnel SSH: `ssh -L 3000:127.0.0.1:3000 usuario@vm`, y después abra `http://127.0.0.1:3000` en su ordenador.

**Con cloud-init**, la misma secuencia puede ejecutarse en el primer arranque de la VM, antes incluso de que usted inicie sesión. Use `--password-file` con un archivo depositado por `write_files` — no `--random-password`, cuya salida única se perdería en los logs de cloud-init. El archivo puede vivir dentro de `/var/lib/mmo-panel`: el instalador entrega esa carpeta entera a la cuenta `mmo`, así que el panel puede leerlo ahí.

```yaml
write_files:
  - path: /var/lib/mmo-panel/admin-password
    permissions: '0600'
    content: |
      elija-aqui-una-contrasena-larga
runcmd:
  - curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh -o /run/install-panel.sh
  - sh /run/install-panel.sh
  - sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --password-file /var/lib/mmo-panel/admin-password
  - rm -f /var/lib/mmo-panel/admin-password /run/install-panel.sh
```

Dos cosas que conviene saber. Cloud-init se ejecuta como root y sin terminal: ningún comando debe esperar jamás una pulsación de tecla — `install-panel.sh` nunca lo hace, es una de sus reglas. Y la red no siempre está lista cuando arranca `runcmd`: si la descarga falla, basta con volver a ejecutar el mismo comando a mano en cuanto la VM sea accesible.

### 1.4 Arranque al iniciar el sistema (servicio)

> ¿Instalado con un instalador de un solo comando (§1.2, Linux o Windows)? El servicio ya existe — esta sección es para las instalaciones manuales.

**Windows** (shawl se incluye en el archivo) — en un PowerShell de **administrador**:

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

El servicio se ejecuta entonces como `LocalSystem`; para ejecutarlo con su propia cuenta (recomendado si las copias de seguridad van a una unidad de red), use `services.msc` → Iniciar sesión, o adapte el procedimiento del agente (§2.2). Variables de entorno (`MMO_PORT`…): `shawl add --env MMO_PORT=3000 …`.

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

**macOS** (launchd) — `/Library/LaunchDaemons/com.mmo.panel.plist` con `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` y `KeepAlive` a `true`, y después `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Actualizar el panel

El panel le avisa cuando existe una actualización: los administradores ven un banner en cuanto se publica una nueva versión (se consulta el feed de releases de GitHub como mucho cada 6 horas — Settings → General desactiva la comprobación, y una categoría de notificación «New panel version published» hace sonar la campana).

¿Instalado con un instalador de un solo comando (§1.2, Linux o Windows)? Ejecute el mismo comando otra vez: hace una copia de la base de datos, cambia el código, reinicia el servicio y vuelve atrás por sí solo si la nueva versión no arranca. Instalaciones manuales: detenga el servicio, extraiga el nuevo archivo **encima** (la carpeta `data/` nunca está dentro del archivo) y reinicie. Las migraciones de la base de datos se ejecutan al arrancar. El nuevo archivo incluye agentes de la misma versión: el panel publica la release del agente automáticamente y, si «Update agents automatically when they connect» (actualizar los agentes automáticamente al conectarse) está marcado (Settings → General — desmarcado por defecto), cada agente se actualiza en su siguiente conexión, con vuelta atrás automática en caso de fallo. Si no, actualícelos uno a uno desde la tarjeta Agent de la página de cada máquina.

### 1.6 Cuando el panel no arranca: `doctor`

Antes de leer una traza de error, pregúntele al panel qué va mal. Comprueba el runtime, los módulos
que carga, el directorio de datos (una escritura **real**, más el propietario comparado con el
usuario actual), la base de datos, el puerto y la interfaz web.

```powershell
C:\mmo\panel\mmo-panel.cmd doctor
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh doctor
```

Cada línea lleva el prefijo `ok`, `warn` o `ERROR`, y cada error dice qué hacer — incluido el
comando `chown` exacto cuando el archivo se extrajo con `sudo` y el panel se ejecuta con otro
usuario. El comando termina con código 1 en cuanto falla una comprobación, así que puede usarse en
un script.

**¿Va a informar de un problema?** `report` escribe el mismo diagnóstico en un archivo, con sus
versiones, sus máquinas y sus agentes, sus ajustes (sin los secretos) y un extracto enmascarado del
registro — justo lo que pide el formulario de incidencias.

```bash
/opt/mmo/mmo-panel/mmo-panel.sh report
```

Lea el archivo antes de adjuntarlo: las rutas personales, los tokens y los códigos de emparejamiento
están enmascarados y las carpetas de los servidores nunca se listan, pero es usted quien lo publica.
`--stdout` lo muestra en lugar de escribirlo, `--no-log` omite el registro.

### 1.7 Copia de seguridad y restauración del panel

El panel se respalda a sí mismo una vez al día (copia consistente `VACUUM INTO` de su base de datos) en `data/backups/panel/mmo-<date>.db`, conservando 7 copias; Settings → Panel backups permite crear una a demanda. Las métricas (`metrics.db`) no se copian: pueden reconstruirse y ocupan mucho. Respalde también toda la carpeta `data/` si quiere conservar los certificados y los archivos de los agentes.

Para **restaurar**: detenga el panel (servicio o Ctrl+C) y después:

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

Basta con el nombre del archivo si la copia está en `data/backups/panel/`; también se acepta una ruta completa. La copia se verifica (`integrity_check`), la base de datos actual se conserva como `mmo.db.before-restore-<date>` y después puede reiniciarse el panel: los agentes se reconectan con su secreto original y los servidores que alojan se readoptan con los mismos identificadores (marcador `.mmo-server.json`). Todo lo creado después de la copia (usuarios, máquinas emparejadas, ajustes) se pierde: una máquina emparejada después de la copia habrá que emparejarla de nuevo. La restauración se niega a ejecutarse si `mmo.db-wal` no está vacío (panel todavía en marcha, o detenido de forma abrupta — arránquelo, deténgalo limpiamente y vuelva a intentarlo).

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
- ⚠ **Permisos de sus carpetas de servidores.** Instalado como servicio del sistema, el agente se ejecuta como `mmo`, no como usted: los servidores guardados en `/home/<usted>/…` suelen ser de solo lectura para él. El panel se lo advierte en cuanto se adopta el servidor («folder not writable») y un arranque rechazado indica la carpeta y la cuenta. Dos soluciones, cualquiera de las dos:
  - dar acceso a la cuenta del agente: `sudo chown -R mmo /ruta/a/mis-servidores` (o `sudo chmod -R g+w` tras `sudo usermod -aG <su-grupo> mmo`);
  - o instalar el agente con su propia cuenta: `--user <usted>` (servicio del sistema) o `--user-service` (sin root).
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
