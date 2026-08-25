# Eine Maschine hinzufügen

[English](../add-a-machine.md) · [Français](../fr/ajouter-une-machine.md) · [Español](../es/add-a-machine.md) · **Deutsch** · [Português](../pt/add-a-machine.md) · [Русский](../ru/add-a-machine.md) · [中文](../zh/add-a-machine.md)

_Übersetzung der englischen Version, die maßgeblich ist. Die Benutzeroberfläche der Anwendung ist auf Englisch und Französisch verfügbar._

Eine **Maschine** = ein Computer, der Minecraft-Server hostet, gesteuert von einem Agent. Der Panel-Host selbst kann eine sein (der häufigste Fall: alles läuft auf dem Gaming-PC).

## 1. Die Maschine anlegen und den Befehl abrufen

1. Panel → **Machines** → **Add a machine** (Maschine hinzufügen), geben Sie ihr einen Namen.
2. Das Panel zeigt einen **Kopplungscode** (`MMOP-XXXX-XXXX`, 15 Minuten gültig, einmalig verwendbar) und den vollständigen Befehl für Windows und für Linux/macOS.
3. Fügen Sie den Befehl auf der Zielmaschine ein — siehe [Installation § 2](installation.md#2-die-agents) für die Details dessen, was er tut.
4. Die Maschine wird im Panel `online`. Ist der Code abgelaufen, erzeugt **New pairing code** (Neuer Kopplungscode) einen weiteren (die früheren Codes der Maschine werden ungültig); führen Sie den Befehl erneut aus.

Der Befehl enthält die öffentliche URL des Panels: Prüfen Sie sie noch einmal (Settings → General), wenn die Zielmaschine nicht im selben Netzwerk ist wie Sie.

## 2. Server erkennen

Auf der Maschinenseite: **Watched directories** (Überwachte Verzeichnisse) → fügen Sie den übergeordneten Ordner Ihrer Server hinzu (z. B. `E:\Minecraft\Server`, `/srv/minecraft`). Der Agent scannt (Forge, NeoForge, Fabric, Vanilla; 1.12 → 1.21+) und **adoptiert automatisch** jeden erkannten Server, mit seinem Loader, seiner Version und seinem RAM — der periodische Scan läuft von selbst, **Scan now** (Jetzt scannen) erzwingt einen sofortigen Durchlauf, und **Add a server folder** (Serverordner hinzufügen) registriert einen bestimmten Ordner ohne Wartezeit. Alles bleibt anschließend auf der Serverseite bearbeitbar (von Hand angepasste Packs täuschen die Heuristiken manchmal — die Quelle jedes erkannten Wertes wird angezeigt). Bei der Adoption wird nichts auf der Festplatte verändert, außer der Aktivierung von RCON (`server.properties`, generiertes Passwort), die erforderlich ist, um den Server im detached-Modus zu steuern.

Java: Der Agent inventarisiert die vorhandenen JREs; fehlt die benötigte Version, installieren Sie sie über die Karte **Java runtimes** (Java-Laufzeitumgebungen) der Maschinenseite (Schaltfläche **Install this runtime** — Temurin, andernfalls Zulu, automatisch heruntergeladen und verifiziert).

## 3. Erster Serverstart

Starten Sie den Server über seine Karte (Dashboard) oder seine Seite und beobachten Sie, wie der Zustand `starting` → `running` durchläuft (PID wird angezeigt). Der Tab **Console** zeigt die Zeilen live und nimmt Befehle entgegen. Beim ersten Start eines frischen Servers führt Sie das Panel, falls die Mojang-EULA noch nicht akzeptiert wurde, durch die Annahme (Erklärung, Link, Kontrollkästchen), dann starten Sie erneut. Alles Weitere findet sich in den Tabs der Serverseite: **Players** (Whitelist, Ops, Bans — ohne je eine Datei zu öffnen), **Configuration** (`server.properties`, Feld für Feld erklärt), **Files**, **Backups**, **Metrics**, **Scheduler**, **Logs**.

## 4. Adressen für Spieler

Jeder Server hat eine Einstellung **Exposure** (Freigabemodus — Karte **Player access**, Tab **Overview** der Serverseite):

- **Tailnet**: Ihre Freunde installieren Tailscale und treten Ihrem tailnet bei (Node-Freigabe oder Einladung); die weiterzugebende Adresse ist die `100.x.y.z`-IP der Maschine (oder ihr MagicDNS-Name) + Port.
- **Direct**: öffentliche Adresse — Ihre Domain, wenn die Maschine der Panel-Host im Direct-Modus ist, andernfalls die globale IPv6 der Maschine (oder der öffentliche Host, den Sie auf der Maschinenseite eintragen, Karte „Addresses for players“). Öffnen Sie den Port des Servers (IPv6-Pinhole am Router + die unter Settings → Remote access → Firewall rules angezeigte Regel).

Spieler im selben lokalen Netzwerk brauchen nichts: LAN-Adresse + Port, unabhängig vom Modus. Die Schaltfläche **Test reachability** (Erreichbarkeit testen) der Karte führt einen echten _Server List Ping_ vom Panel-Host aus durch (Version, Spieler, MOTD): Genau das wird ein Minecraft-Client sehen.

## 5. Mehrere Maschinen

- Server können von einer Maschine auf eine andere **migriert** werden (Karte **Migration** im Tab Overview → **Migrate to another machine**): Vorprüfungen auf dem Ziel (Speicherplatz, Java, Port), direkter Agent-zu-Agent-Transfer oder Relais über das Panel, Umschaltung, und der alte Ordner wird in `.migrated-<date>` umbenannt.
- **Backups** haben ein Ziel pro Server (lokal oder ein freigegebener/eingebundener Ordner), richtlinienbasierte Rotation, Ein-Klick-Wiederherstellung.
- Agent-Updates: Settings → General → „Update agents automatically when they connect“, oder manuell von der Maschinenseite aus (Agent-Karte). Ein Agent, der nicht innerhalb von 30 s wieder gesund zurückkommt, führt selbst ein Rollback auf die vorherige Version durch.

## 6. Eine Maschine entfernen

Maschinenseite → **Remove machine** (Maschine entfernen): Sie verschwindet aus dem Panel (Server und Dateien bleiben auf der Festplatte unversehrt). Auf der Maschine selbst: `install.ps1 -Uninstall` / `install.sh --uninstall` ([Installation § 2](installation.md#2-die-agents)).
