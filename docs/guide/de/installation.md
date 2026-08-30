# Installation

[English](../installation.md) · [Français](../fr/installation.md) · [Español](../es/installation.md) · **Deutsch** · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

_Übersetzung der englischen Version, die maßgeblich ist. Die Benutzeroberfläche der Anwendung ist auf Englisch und Französisch verfügbar._

Benutzerhandbuch — installieren Sie das **Panel** (eine einzige Maschine, die durchläuft), dann einen **Agent** auf jeder Maschine, die Minecraft-Server hostet (oft dieselbe). Alles wird als eigenständige Archive ausgeliefert: Node, Java oder Python müssen vorher nicht installiert werden.

Paketierte Plattformen: **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, ARM-Server), **macOS Apple Silicon**. Windows ARM64 funktioniert mit dem x64-Archiv (Emulation). Intel-macOS wird nicht paketiert.

**Welche Linux-Distributionen?** Seit 1.0.5 enthält das Panel kein kompiliertes Modul mehr, es läuft daher auf **jeder glibc-basierten Distribution**: Ubuntu 20.04 und neuer, Debian 11 und neuer, Fedora, Rocky/Alma/RHEL 9, openSUSE, Raspberry Pi OS, Oracle Linux, Arch… Es ist nichts zu installieren – kein Compiler, kein Entwicklungspaket. Einzige Ausnahme sind **Alpine** und andere musl-basierte Systeme, die die mitgelieferte Node-Laufzeit nicht unterstützt.

## 1. Das Panel

### 1.1 Herunterladen

Holen Sie sich das Archiv `mmo-panel-<version>-<platform>.zip` (Windows) bzw. `.tar.gz` (Linux / macOS) von den [GitHub-Releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Es enthält die festgepinnte Node-Laufzeitumgebung, das Panel, die Weboberfläche und die Agent-Installationsarchive für alle 4 Plattformen (`dist-agent/`).

> Kein Archiv für Ihre Plattform? Bauen Sie es mit zwei Befehlen aus dem Quellcode: siehe „Schnellstart“ in der [README](../../../README.de.md).

### 1.2 Entpacken und starten

**Windows** — entpacken Sie in einen dauerhaften Ordner, zum Beispiel `C:\mmo\panel`, dann:

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux / macOS**:

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
/opt/mmo/mmo-panel/mmo-panel.sh
```

Das Panel lauscht auf `http://127.0.0.1:3000` (niemals auf allen Schnittstellen — erst die Zugriffsschicht, §3, exponiert es; `0.0.0.0` wird beim Start abgelehnt). Nützliche Variablen: `MMO_PORT`, `MMO_HOST` (eine bestimmte Adresse), `MMO_DATA_DIR` (Standard `./data` neben dem Skript — **das ist der Ordner, den Sie sichern sollten**: SQLite-Datenbank, Metriken, Zertifikate, Releases). Neben der Konsole schreibt das Panel sein Log nach `data/logs/panel-<date>.log` (14 Tage aufbewahrt) — dort sehen Sie nach, wenn nach dem Schließen des Fensters etwas schiefgelaufen ist.

### 1.3 Erster Start

Öffnen Sie `http://127.0.0.1:3000`: Der Assistent läuft in zwei Schritten — **Administrator account** (Administratorkonto: Benutzername, Passwort, Sprache), dann **Access** (Zugriff): die **öffentliche Panel-URL** (in diesem Schritt optional), der **Zugriffsmodus** (siehe §3) und das **Standard-Backup-Ziel**. Die öffentliche URL lässt sich jederzeit unter Settings → General (Einstellungen → Allgemein) ändern: Sie wird in die Agent-Installationsbefehle und in die Push-Benachrichtigungen eingesetzt — tragen Sie sie ein, sobald Ihr Fernzugriff eingerichtet ist.

### 1.4 Start beim Systemstart (Dienst)

**Windows** (shawl liegt dem Archiv bei) — in einer **Administrator**-PowerShell:

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

Der Dienst läuft dann als `LocalSystem`; um ihn unter Ihrem eigenen Konto auszuführen (empfohlen, wenn Backups auf ein Netzlaufwerk zielen), verwenden Sie `services.msc` → Log On (Anmelden), oder übernehmen Sie das Vorgehen des Agents (§2.2). Umgebungsvariablen (`MMO_PORT`…): `shawl add --env MMO_PORT=3000 …`.

> Wichtig: `mmo-panel.cmd` setzt `MMO_WEB_DIR` und `MMO_DIST_DIR`; mit shawl fügen Sie sie explizit hinzu: `--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`.

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

**macOS** (launchd) — `/Library/LaunchDaemons/com.mmo.panel.plist` mit `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` und `KeepAlive` auf `true`, dann `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Das Panel aktualisieren

Stoppen Sie den Dienst, entpacken Sie das neue Archiv **darüber** (der Ordner `data/` ist nie Teil des Archivs), starten Sie neu. Datenbankmigrationen laufen beim Start. Das neue Archiv enthält Agents derselben Version: Das Panel veröffentlicht das Agent-Release automatisch, und wenn „Update agents automatically when they connect“ (Agents beim Verbinden automatisch aktualisieren) angehakt ist (Settings → General — standardmäßig nicht angehakt), wird jeder Agent bei seiner nächsten Verbindung aktualisiert, mit automatischem Rollback bei Fehlern. Andernfalls aktualisieren Sie sie einzeln über die Agent-Karte der jeweiligen Maschinenseite.

### 1.6 Das Panel sichern und wiederherstellen

Das Panel sichert sich einmal täglich selbst (konsistente `VACUUM INTO`-Kopie seiner Datenbank) nach `data/backups/panel/mmo-<date>.db`, 7 Kopien werden aufbewahrt; unter Settings → Panel backups (Panel-Sicherungen) können Sie bei Bedarf eine Sicherung anstoßen. Metriken (`metrics.db`) werden nicht kopiert: Sie lassen sich neu aufbauen und sind groß. Sichern Sie auch den gesamten Ordner `data/`, wenn Sie Zertifikate und Agent-Archive behalten möchten.

Zum **Wiederherstellen**: Stoppen Sie das Panel (Dienst oder Strg+C), dann:

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

Ein bloßer Dateiname genügt für eine Kopie, die in `data/backups/panel/` liegt; ein vollständiger Pfad wird ebenfalls akzeptiert. Die Kopie wird geprüft (`integrity_check`), die aktuelle Datenbank wird als `mmo.db.before-restore-<date>` aufbewahrt, dann kann das Panel neu gestartet werden: Die Agents verbinden sich mit ihrem ursprünglichen Secret erneut, und die von ihnen gehosteten Server werden mit denselben Kennungen wieder adoptiert (Markerdatei `.mmo-server.json`). Alles, was nach dem Backup erstellt wurde (Benutzer, gekoppelte Maschinen, Einstellungen), geht verloren: Eine nach dem Backup gekoppelte Maschine muss erneut gekoppelt werden. Die Wiederherstellung verweigert die Ausführung, wenn `mmo.db-wal` nicht leer ist (Panel läuft noch oder wurde hart beendet — starten Sie es, beenden Sie es sauber und versuchen Sie es erneut).

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
