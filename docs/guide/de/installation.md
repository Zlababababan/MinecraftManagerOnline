# Installation

[English](../installation.md) · [Français](../fr/installation.md) · [Español](../es/installation.md) · **Deutsch** · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

_Community-Übersetzung der englischen Version, die maßgeblich ist: sie kann veraltet sein — im Zweifel gilt die [englische Fassung](../installation.md). Die Benutzeroberfläche der Anwendung ist auf Englisch und Französisch verfügbar._

Benutzerhandbuch — installieren Sie das **Panel** (eine einzige Maschine, die durchläuft), dann einen **Agent** auf jeder Maschine, die Minecraft-Server hostet (oft dieselbe). Alles wird als eigenständige Archive ausgeliefert: Node, Java oder Python müssen vorher nicht installiert werden.

Paketierte Plattformen: **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, ARM-Server), **macOS Apple Silicon**. Windows ARM64 funktioniert mit dem x64-Archiv (Emulation). Intel-macOS wird nicht paketiert.

**Welche Linux-Distributionen?** Seit 1.0.5 enthält das Panel kein kompiliertes Modul mehr, es läuft daher auf **jeder glibc-basierten Distribution**: Ubuntu 20.04 und neuer, Debian 11 und neuer, Fedora, Rocky/Alma/RHEL 9, openSUSE, Raspberry Pi OS, Oracle Linux, Arch… Es ist nichts zu installieren – kein Compiler, kein Entwicklungspaket. Einzige Ausnahme sind **Alpine** und andere musl-basierte Systeme, die die mitgelieferte Node-Laufzeit nicht unterstützt: Verwenden Sie dort das offizielle Docker-Image (§1.2 – es bringt seine eigene libc mit), eine glibc-Distribution oder starten Sie das Panel mit Ihrem eigenen Node ≥ 24 (`node app/dist/main.js` im entpackten Ordner).

## 1. Das Panel

### 1.1 Download

Öffnen Sie die [Releases-Seite](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest) und laden Sie die Datei herunter, die zu Ihrem Rechner passt:

| Ihr Rechner                                     | Herunterzuladende Datei                   |
| ----------------------------------------------- | ----------------------------------------- |
| Windows (jeder halbwegs aktuelle PC)            | `mmo-panel-<version>-win-x64.zip`         |
| Linux auf einem normalen PC oder Server         | `mmo-panel-<version>-linux-x64.tar.gz`    |
| Linux auf ARM (Raspberry Pi, Oracle/Ampere-VM…) | `mmo-panel-<version>-linux-arm64.tar.gz`  |
| Mac mit Apple Silicon (M1–M4)                   | `mmo-panel-<version>-darwin-arm64.tar.gz` |

Unsicher, welches Linux Sie haben? `uname -m` ausführen: `x86_64` heißt x64, `aarch64` heißt ARM64.

Das Archiv ist eigenständig: Es bringt seine eigene Node-Laufzeit mit, dazu das Panel, die Weboberfläche und die Agent-Installer für alle vier Plattformen. **Es muss nichts vorab installiert werden** – kein Node, kein Java, kein Compiler, kein Entwicklungspaket.

> Download prüfen? Jedes Release veröffentlicht auch `panel-<plattform>.json` mit der erwarteten SHA-256. Vergleichen Sie sie mit `sha256sum <datei>` (Linux/macOS) oder `Get-FileHash <datei>` (Windows).

### 1.2 Entpacken und starten

**Linux, ein Befehl.** Auf einem Rechner mit systemd (Ubuntu, Debian, Fedora, Raspberry Pi OS…) erledigt ein einziges Copy-and-paste alles, was §1.1 bis §1.4 beschreiben – Download, SHA-256-Prüfung, Code in `/opt/mmo-panel`, Daten in `/var/lib/mmo-panel`, Einstellungen in `/etc/mmo-panel/panel.env`, gehärteter systemd-Dienst –, und wartet dann, bis das Panel antwortet:

```bash
curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
```

Für ein **Update denselben Befehl erneut ausführen**: Die Datenbank wird zuerst gesichert, und startet die neue Version nicht, wird die vorherige zurückgeholt. `--uninstall` entfernt die Installation (`--purge` löscht auch die Daten), `--help` listet die übrigen Optionen auf (Offline-Installation `--archive`, `--dir`, `--data-dir`…). Wer jeden Schritt sehen möchte: Der manuelle Weg unten wird weiterhin vollständig unterstützt – Installer und manueller Weg führen zum selben Ergebnis.

**Docker.** Das offizielle Image (Multi-Arch x64/ARM64, Agenten enthalten) ist die Antwort, wenn der Rechner Alpine/musl verwendet oder wenn ohnehin alles in Containern läuft. Laden Sie nur [docker-compose.yml](https://github.com/Zlababababan/MinecraftManagerOnline/blob/main/docker-compose.yml) herunter, dann:

```bash
docker compose up -d
```

Das Panel antwortet unter `http://127.0.0.1:3000`. Die Daten liegen im **benannten Volume** `mmo-data` – widerstehen Sie der Versuchung eines `./data`-Bind-Mounts: Beim ersten `up` von root angelegt, reproduziert er exakt den Rechtefehler „Datenbank lässt sich nicht öffnen“, denn der Container läuft als Benutzer `node` (uid 1000). Im Container lauscht das Panel auf allen Schnittstellen (eine bewusste Freigabe des Images): Was tatsächlich nach außen sichtbar wird, entscheidet die `ports:`-Zeile – behalten Sie `127.0.0.1:3000:3000` und setzen Sie `tailscale serve` (§3) auf den Host, oder öffnen Sie es bewusst. CLI: `docker compose exec panel /app/entrypoint.sh doctor` (ebenso `setup`, `restore`).

**Windows, ein Befehl.** Dieselbe Idee, in einer PowerShell (sie fordert die Rechteerhöhung selbst an) – Code in `C:\Program Files\mmo-panel`, Daten in `C:\ProgramData\mmo-panel`, ein Windows-Dienst mit verzögertem Autostart:

```powershell
& ([scriptblock]::Create((irm https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.ps1)))
```

Zum Aktualisieren erneut ausführen (erst Sicherung, Rückfall auf die alte Version, wenn die neue nicht startet). Optionen: `-Port`, `-Archive` (offline), `-MigrateFrom C:\alt\panel` (kopiert die Daten einer früheren manuellen Installation, mit `integrity_check` geprüft, ohne das Original anzurühren), `-ServiceAccount User` (wenn Sicherungen auf ein Netzlaufwerk gehen), `-Uninstall` (`-Purge` löscht auch die Daten). Ihre Entscheidungen werden für das nächste Update gemerkt.

Der Installer legt außerdem **MinecraftManagerOnline** ins Startmenü: ein kleines Symbol neben der Uhr – Linksklick öffnet die Oberfläche, Rechtsklick bietet Öffnen, Logs, Starten/Stoppen/Neustarten, „mit Windows starten“ und Beenden. Das Symbol steuert den Dienst (es startet nie ein zweites Panel); ohne Dienst startet es das Panel selbst, und Beenden hält es an.

**Windows, manueller Weg.** Rechtsklick auf die `.zip` → **Alle extrahieren**, in einen Ordner, den Sie behalten wollen, etwa `C:\mmo\panel` (nicht Downloads, nicht Desktop). Öffnen Sie diesen Ordner und doppelklicken Sie **`mmo-panel.cmd`**. Ein schwarzes Fenster öffnet sich und bleibt offen: Das ist das laufende Panel, und Schließen beendet es – §1.4 macht daraus einen echten Dienst. Aus einem Terminal:

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux.** In einem Terminal, im Ordner mit der heruntergeladenen Datei:

```bash
tar -xzf mmo-panel-*.tar.gz
cd mmo-panel
./mmo-panel.sh
```

Zum Ausprobieren reicht das. Für einen Rechner, der dauerhaft läuft, legen Sie es an einen festen Ort – und achten Sie auf das `chown`, den Fehler, der die meiste Zeit kostet:

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
sudo chown -R "$USER" /opt/mmo/mmo-panel   # als root entpackt – dem Benutzer übergeben, der es startet (§1.4 übergibt es dem Dienstkonto mmo)
/opt/mmo/mmo-panel/mmo-panel.sh
```

**macOS** – dieselben Befehle wie unter Linux. Beim ersten Start weigert sich macOS womöglich, ein heruntergeladenes Programm auszuführen: Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen“.

> Etwas stimmt nicht? `mmo-panel.cmd doctor` (Windows) bzw. `./mmo-panel.sh doctor` (Linux/macOS) prüft die Laufzeit, den Datenordner und seinen Eigentümer, die Datenbank und den Port und sagt, was zu tun ist – siehe §1.6.

Das Panel lauscht auf `http://127.0.0.1:3000` (nie auf allen Schnittstellen – die Zugangsschicht, §3, macht es erreichbar; `0.0.0.0` wird beim Start abgelehnt). Nützliche Variablen: `MMO_PORT`, `MMO_HOST` (eine bestimmte Adresse), `MMO_DATA_DIR` (Standard `./data` neben dem Skript – **das ist der zu sichernde Ordner**: SQLite-Datenbank, Metriken, Zertifikate, Releases). Neben der Konsole schreibt das Panel sein Log nach `data/logs/panel-<date>.log` (14 Tage aufbewahrt) – dort schauen Sie nach, wenn nach dem Schließen des Fensters etwas schiefging.

### 1.3 Erster Start

Öffnen Sie `http://127.0.0.1:3000`. Auf einem Rechner ohne Bildschirm (Server, VM): entweder zuerst den Fernzugriff einrichten (§3 – Tailscale installieren, den `tailscale serve`-Befehl ausführen, dann `https://<rechner>.<tailnet>.ts.net` von einem anderen Gerät öffnen) oder einen SSH-Tunnel nutzen (`ssh -L 3000:127.0.0.1:3000 benutzer@rechner`, danach lokal `http://127.0.0.1:3000` öffnen). Der Assistent läuft in zwei Schritten – **Administrator account** (Administratorkonto: Benutzername, Passwort, Sprache), dann **Access** (Zugang): die **öffentliche Panel-URL** (in diesem Schritt optional), der **Zugangsmodus** (siehe §3) und das **Standardziel für Sicherungen**. Die öffentliche URL lässt sich jederzeit unter Settings → General ändern: Sie wird in die Agent-Installationsbefehle und in Push-Benachrichtigungen eingesetzt – tragen Sie sie ein, sobald Ihr Fernzugriff steht.

**Ganz ohne Browser** (Cloud-VM, Container, cloud-init) wird das Administratorkonto stattdessen auf der Kommandozeile angelegt – `setup` ist derselbe Codepfad wie der Assistent. Auf einer frischen, per SSH erreichbaren Cloud-VM (Oracle, AWS, Hetzner…) sieht die ganze Abfolge so aus:

1. **Installieren** – der Ein-Befehl-Installer aus §1.2 erledigt alles, Dienst inklusive:

   ```bash
   curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
   ```

2. **Administratorkonto anlegen.** Der Installer betreibt das Panel unter dem Dienstkonto `mmo` mit seinen Daten in `/var/lib/mmo-panel` – führen Sie `setup` unter derselben Identität aus:

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --random-password
   ```

   Das erzeugte Passwort wird genau einmal ausgegeben – kopieren Sie es sofort. Mit `--password-stdin` (`echo -n 'geheim' | … setup --username admin --password-stdin`) oder `--password-file <datei>` wählen Sie es selbst – niemals als Argument übergeben, die Kommandozeile ist für jeden Prozess der Maschine sichtbar. `--public-url`, `--locale` und `--access-mode` sind optional. Der Befehl weigert sich, ein zweites Mal zu laufen. Bei einer manuellen Installation (§1.2), bei der die Daten neben dem Skript liegen und Ihnen gehören, ist kein Präfix nötig: `/opt/mmo/mmo-panel/mmo-panel.sh setup --username admin --random-password --public-url panel.example.net`.

3. **Prüfen.** `doctor` (§1.6) untersucht die gesamte Installation, und das Panel-Log läuft über journalctl:

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh doctor
   journalctl -u mmo-panel -f
   ```

4. **Die Oberfläche vom eigenen Rechner aus öffnen** (§3). Entweder Tailscale auf der VM installieren und das Panel im Tailnet bereitstellen:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

   und dann `https://<vm>.<tailnet>.ts.net` öffnen – oder für einen schnellen ersten Blick ohne Installation einen SSH-Tunnel: `ssh -L 3000:127.0.0.1:3000 benutzer@vm`, danach `http://127.0.0.1:3000` auf Ihrem Rechner öffnen.

**Mit cloud-init** kann dieselbe Abfolge schon beim allerersten Start der VM laufen, bevor Sie sich je anmelden. Nehmen Sie `--password-file` mit einer per `write_files` abgelegten Datei – nicht `--random-password`, dessen einmalige Ausgabe in den cloud-init-Logs verloren ginge. Die Datei darf in `/var/lib/mmo-panel` liegen: Der Installer übergibt diesen ganzen Ordner dem Konto `mmo`, das Panel kann sie dort also lesen.

```yaml
write_files:
  - path: /var/lib/mmo-panel/admin-password
    permissions: '0600'
    content: |
      hier-ein-langes-passwort-waehlen
runcmd:
  - curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh -o /run/install-panel.sh
  - sh /run/install-panel.sh
  - sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --password-file /var/lib/mmo-panel/admin-password
  - rm -f /var/lib/mmo-panel/admin-password /run/install-panel.sh
```

Zwei Dinge sollte man wissen. Cloud-init läuft als root und ohne Terminal: Kein Befehl darf jemals auf einen Tastendruck warten – `install-panel.sh` tut das nie, das ist eine seiner Regeln. Und das Netzwerk steht nicht immer schon, wenn `runcmd` beginnt: Schlägt der Download fehl, genügt es, denselben Befehl von Hand zu wiederholen, sobald die VM erreichbar ist.

### 1.4 Start beim Hochfahren (Dienst)

> Mit einem Ein-Befehl-Installer installiert (§1.2, Linux oder Windows)? Der Dienst existiert bereits – dieser Abschnitt gilt für manuelle Installationen.

**Windows** (shawl liegt im Archiv) – in einer **Administrator**-PowerShell:

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

Der Dienst läuft dann als `LocalSystem`; um ihn unter Ihrem eigenen Konto zu betreiben (empfohlen, wenn Sicherungen auf ein Netzlaufwerk gehen), nutzen Sie `services.msc` → Anmelden, oder übernehmen Sie das Vorgehen des Agenten (§2.2). Umgebungsvariablen (`MMO_PORT`…): `shawl add --env MMO_PORT=3000 …`.

> Wichtig: `mmo-panel.cmd` setzt `MMO_WEB_DIR` und `MMO_DIST_DIR`; bei shawl müssen sie ausdrücklich mit: `--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`.

**Linux** (systemd) – `/etc/systemd/system/mmo-panel.service`:

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

**macOS** (launchd) – `/Library/LaunchDaemons/com.mmo.panel.plist` mit `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` und `KeepAlive` auf `true`, danach `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Panel aktualisieren

Das Panel sagt Ihnen, wenn ein Update existiert: Administratoren sehen ein Banner, sobald eine neue Version veröffentlicht ist (Abgleich mit dem GitHub-Releases-Feed höchstens alle 6 Stunden – Settings → General schaltet die Prüfung ab, und eine Benachrichtigungskategorie „New panel version published“ lässt die Glocke klingeln).

Mit einem Ein-Befehl-Installer installiert (§1.2, Linux oder Windows)? Führen Sie denselben Befehl erneut aus – er sichert die Datenbank, tauscht den Code, startet den Dienst neu und fällt von selbst zurück, wenn die neue Version nicht startet. Manuelle Installationen: Dienst stoppen, das neue Archiv **darüber** entpacken (der Ordner `data/` liegt nie im Archiv), neu starten. Datenbankmigrationen laufen beim Start. Das neue Archiv enthält Agenten derselben Version: Das Panel veröffentlicht das Agent-Release automatisch, und wenn „Update agents automatically when they connect“ (Agenten beim Verbinden automatisch aktualisieren) angehakt ist (Settings → General – standardmäßig nicht angehakt), wird jeder Agent bei seiner nächsten Verbindung aktualisiert, mit automatischem Rückfall bei Fehlschlag. Andernfalls aktualisieren Sie sie einzeln über die Agent-Karte auf der jeweiligen Maschinenseite.

### 1.6 Wenn das Panel nicht startet: `doctor`

Bevor Sie einen Stacktrace lesen, fragen Sie das Panel, was nicht stimmt. Es prüft die Laufzeit, die
Module, die es lädt, das Datenverzeichnis (ein **echter** Schreibvorgang, dazu der Eigentümer im
Vergleich zum aktuellen Benutzer), die Datenbank, den Port und das Frontend.

```powershell
C:\mmo\panel\mmo-panel.cmd doctor
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh doctor
```

Jede Zeile beginnt mit `ok`, `warn` oder `ERROR`, und jeder Fehler sagt, was zu tun ist – inklusive
des genauen `chown`-Befehls, wenn das Archiv mit `sudo` entpackt wurde und das Panel unter einem
anderen Benutzer läuft. Der Befehl endet mit 1, sobald eine Prüfung fehlschlägt, und lässt sich so
in einem Skript verwenden.

**Sie melden ein Problem?** `report` schreibt dieselbe Diagnose in eine Datei — mit Ihren Versionen,
Ihren Maschinen und deren Agenten, Ihren Einstellungen (ohne Geheimnisse) und einem maskierten
Auszug aus dem Log. Genau das, wonach das Issue-Formular fragt.

```bash
/opt/mmo/mmo-panel/mmo-panel.sh report
```

Lesen Sie die Datei, bevor Sie sie anhängen: persönliche Pfade, Tokens und Kopplungscodes sind
maskiert und Server-Ordner werden nie aufgeführt — veröffentlicht wird sie aber von Ihnen.
`--stdout` gibt sie aus, statt sie zu schreiben, `--no-log` lässt das Log weg.

### 1.7 Panel sichern und wiederherstellen

Das Panel sichert sich einmal täglich selbst (konsistente `VACUUM INTO`-Kopie seiner Datenbank) nach `data/backups/panel/mmo-<date>.db`, 7 Kopien werden aufbewahrt; unter Settings → Panel backups lässt sich eine Sicherung auf Anforderung erstellen. Die Metriken (`metrics.db`) werden nicht kopiert: Sie sind neu aufbaubar und groß. Sichern Sie auch den gesamten Ordner `data/`, wenn Sie Zertifikate und Agent-Archive behalten wollen.

Zum **Wiederherstellen**: Panel stoppen (Dienst oder Ctrl+C), dann:

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

Für eine Kopie in `data/backups/panel/` genügt der bloße Dateiname; ein vollständiger Pfad wird ebenfalls akzeptiert. Die Kopie wird geprüft (`integrity_check`), die aktuelle Datenbank bleibt als `mmo.db.before-restore-<date>` erhalten, danach kann das Panel wieder starten: Die Agenten verbinden sich mit ihrem ursprünglichen Geheimnis, und die von ihnen betriebenen Server werden mit denselben Kennungen wieder übernommen (Marker `.mmo-server.json`). Alles, was nach der Sicherung entstanden ist (Benutzer, gekoppelte Maschinen, Einstellungen), geht verloren: Eine nach der Sicherung gekoppelte Maschine muss erneut gekoppelt werden. Die Wiederherstellung verweigert den Dienst, wenn `mmo.db-wal` nicht leer ist (Panel läuft noch oder wurde abrupt beendet – starten, sauber stoppen und erneut versuchen).

## 2. Die Agents

Ein Agent pro Maschine, die Server hostet. Er verbindet sich **ausgehend** mit dem Panel (WebSocket): Auf den Agent-Maschinen muss kein Port geöffnet werden.

### 2.1 Der Ein-Zeilen-Befehl

Im Panel: **Machines → Add a machine** (Maschinen → Maschine hinzufügen). Das Panel erzeugt einen Kopplungscode (15 Minuten gültig) und den vollständigen Befehl zum Einfügen auf der Zielmaschine:

- **Windows** (PowerShell, beliebige Version):
  `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -PairCode MMOP-XXXX-XXXX`
- **Linux / macOS**:
  `curl -fsSL https://<panel>/install.sh | sh -s -- --pair-code MMOP-XXXX-XXXX`

Das Skript lädt das passende Plattform-Archiv vom Panel herunter, prüft dessen SHA-256-Hash, installiert die Dateien, **koppelt** den Agent (der Fehler kommt sofort, wenn der Code abgelaufen ist), registriert und startet dann den Dienst. Die Maschine erscheint innerhalb weniger Sekunden `online` im Panel.

> Das Panel muss von der Zielmaschine aus erreichbar sein (§3). Solange die öffentliche URL nicht gesetzt ist, verwendet der Befehl die Adresse, unter der Sie das Panel geöffnet haben.

### 2.2 Was das Skript macht — Windows

- Dateien in `%LOCALAPPDATA%\Programs\mmo-agent` (Runtime, `launcher.cjs`, `versions/<v>/agent.js`, `shawl.exe`), Zustand in `%LOCALAPPDATA%\mmo-agent`.
- Der Dienst `mmo-agent` wird mit **shawl** registriert, automatischer Start; er läuft **unter Ihrem Windows-Konto** (das Passwort wird einmal abgefragt, im sich öffnenden erhöhten Fenster), damit der Agent Ihre verbundenen Netzlaufwerke und Ordner sehen kann. Genauer gesagt: das Konto des erhöhten Fensters — wenn UAC Sie die Zugangsdaten eines anderen Administrators eingeben lässt, ist das das Konto, unter dem der Dienst laufen wird. Das Recht „Log on as a service“ (Anmelden als Dienst) wird automatisch erteilt (schlägt das fehl, fährt das Skript fort und erklärt, wie Sie es mit `secpol.msc` erteilen). Alternative: `-ServiceAccount LocalSystem`.
- **Konto ohne Passwort** (Sitzung mit PIN oder ganz ohne Passwort geöffnet): Windows verbietet Diensten die Anmeldung mit leerem Passwort. Bestätigen Sie die leere Abfrage: Das Skript weist darauf hin und registriert den Dienst als `LocalSystem` (der Agent sieht dann Ihre verbundenen Netzlaufwerke nicht). Zurück zu Ihrem Konto: Setzen Sie ein Windows-Passwort und führen Sie den Befehl erneut aus.
- Schlägt im erhöhten Fenster etwas fehl, bleibt die Meldung auf dem Bildschirm stehen (Enter zum Schließen), und die Details stehen in `%TEMP%\mmo-install.log`.
- Der Dienst startet nach einem Absturz automatisch neu; sauberer Stopp = Strg+C an den Agent weitergereicht, **niemals** an den ganzen Prozessbaum: Die Minecraft-Server überleben Stopp und Update des Agents und werden anschließend wieder adoptiert.
- Optionen: `-NoService` (nur Dateien), `-InstallDir`, `-StateDir`, `-Panel`, `-Archive <zip>` (offline).
- Deinstallation: `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -Uninstall` (mit `-Purge` wird auch der Zustand entfernt; Minecraft-Server werden niemals angetastet).

### 2.3 Was das Skript macht — Linux

- Dateien in `/opt/mmo-agent`, Zustand in `/var/lib/mmo-agent`, Systemkonto `mmo` wird bei Bedarf angelegt (`--user <name>` für ein anderes Konto — der Agent muss die Serverordner lesen und schreiben können).
- systemd-Unit `mmo-agent` mit `KillMode=process` (detachte Server überleben) und `Restart=on-failure`. `sudo` wird bei Bedarf angefordert.
- **Ohne Root**: `--user-service` installiert nach `~/.local/share/mmo-agent` (Dateien in `app/`, Zustand im Wurzelverzeichnis) mit `systemctl --user` und `loginctl enable-linger` (Start beim Booten ohne offene Sitzung). Achtung: Mit `sudo` ausgeführt wird `--user-service` ignoriert und die systemweite Installation durchgeführt.
- Optionen: `--no-service`, `--dir`, `--state-dir`, `--panel`, `--archive <tar.gz>` (offline).
- ⚠ **Rechte auf Ihren Server-Ordnern.** Als Systemdienst installiert, läuft der Agent als `mmo`, nicht als Sie: Server unter `/home/<sie>/…` sind für ihn oft nur lesbar. Das Panel warnt Sie, sobald der Server übernommen wird („folder not writable“), und ein abgelehnter Start nennt Ordner und Konto. Zwei Lösungen, eine davon genügt:
  - dem Konto des Agenten Zugriff geben: `sudo chown -R mmo /pfad/zu/meinen-servern` (oder `sudo chmod -R g+w` nach `sudo usermod -aG <ihre-gruppe> mmo`);
  - oder den Agenten unter Ihrem eigenen Konto installieren: `--user <sie>` (Systemdienst) oder `--user-service` (ohne root).
- Deinstallation: `curl -fsSL https://<panel>/install.sh | sh -s -- --uninstall [--purge]` (fügen Sie `--user-service` hinzu, falls so installiert). Das Systemkonto `mmo` bleibt erhalten (`userdel mmo`, wenn Sie es nicht mehr möchten).
- Unter **WSL** stoppt die VM wenige Sekunden nach dem Schließen des letzten Terminals: Der Dienst (und die Server) stoppen mit — WSL eignet sich zum Ausprobieren, nicht zum Hosten.

### 2.4 Was das Skript macht — macOS

Gleiche Logik: `/opt/mmo-agent`, LaunchDaemon `com.mmo.agent` (`KeepAlive`, `AbandonProcessGroup`: Server überleben), Konto = der Benutzer, der `sudo` ausführt. `--user-service` erstellt stattdessen einen LaunchAgent (Start nur bei Anmeldung an der Sitzung). Log: `/var/lib/mmo-agent/agent.log`.

### 2.5 Nach einem Neustart der Maschine

Der Dienst startet den Agent neu; der Agent adoptiert die noch laufenden Server erneut (PID + Startzeit + Befehlszeile) und startet, wenn „Restore desired state when an agent boots“ (Gewünschten Zustand beim Start eines Agents wiederherstellen) aktiviert ist (Settings → General), diejenigen neu, die als `running` markiert waren.

### 2.6 Offline-Installation

Laden Sie das Plattform-Archiv vom Panel herunter (Settings → Agent distribution) oder aus dem Release, kopieren Sie es zusammen mit dem Skript (`install.ps1` / `install.sh` liegen auch im Archiv) und führen Sie `install.ps1 -Archive <zip> -Panel https://<panel> -PairCode …` bzw. `sh install.sh --archive <tar.gz> --panel https://<panel> --pair-code …` aus (der SHA-256-Hash wird nur bei einem vom Panel heruntergeladenen Archiv geprüft — ein lokales Archiv wird unverändert übernommen).

## 3. Fernzugriff (Zusammenfassung)

Das Panel lauscht nur auf `127.0.0.1`. Um es von Agents auf anderen Maschinen, von Ihren Freunden und von Ihrem Telefon aus zu erreichen, wählen Sie einen Modus (Settings → Remote access, Einstellungen → Fernzugriff):

| Modus                    | Für wen                                                                | Was zu tun ist                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Tailscale** (Standard) | Alle, auch hinter CGNAT/4G                                             | Installieren Sie Tailscale auf dem Panel-Host und auf jedem Client-Gerät, dann führen Sie den angezeigten `tailscale serve`-Befehl aus |
| **Direct**               | Sie haben eine öffentliche IPv6 und eine Domain (DuckDNS, Cloudflare…) | Domain + DNS-Anbieter eintragen, das Zertifikat anfordern (DNS-01), Port 443 öffnen (IPv6-Pinhole am Router)                           |
| **Manual**               | Sie betreiben bereits einen Reverse-Proxy                              | Richten Sie ihn auf `127.0.0.1:3000`, mit WebSocket-Unterstützung                                                                      |

In jedem Fall prüft die Karte **Reachability test** (Erreichbarkeitstest; Schaltfläche **Run the test**, unter Settings → Remote access) HTTP, WebSocket, Binär-Frames (64 KiB) und das TLS-Zertifikat über die öffentliche URL. Details und Fehlerbehebung: [Netzwerk-FAQ](network-faq.md). Maschinen hinzufügen und Adressen für die Spieler: [Eine Maschine hinzufügen](add-a-machine.md).

## 4. Auf Ihrem Telefon: die PWA installieren

Das Panel ist eine installierbare Web-App (PWA): Sobald der Fernzugriff eingerichtet ist (§3 — die Installation erfordert HTTPS), öffnen Sie die öffentliche URL im Browser Ihres Telefons und fügen die App dem Startbildschirm hinzu:

- **Android (Chrome)**: Menü ⋮ → „Add to Home screen“ (Zum Startbildschirm hinzufügen) — oder „Install app“ (App installieren), wenn angeboten.
- **iOS (Safari)**: Teilen-Schaltfläche → „Add to Home Screen“ (Zum Home-Bildschirm). Auf iOS ist das **zwingend erforderlich**, um Push-Benachrichtigungen zu erhalten: Sie funktionieren nur aus der installierten PWA, nicht aus Safari.

Die App öffnet sich dann im Vollbild, mit der Navigation am unteren Bildschirmrand. Für Benachrichtigungen (Serverabsturz, fehlgeschlagenes Backup, Agent offline…): Seite Account → Push notifications (Push-Benachrichtigungen) — aktivieren Sie sie, wählen Sie die Kategorien und prüfen Sie mit der Schaltfläche „Send a test“ (Test senden). Im Tailscale-Modus muss auf dem Telefon die Tailscale-App installiert und mit dem tailnet verbunden sein, damit es das Panel erreicht.
