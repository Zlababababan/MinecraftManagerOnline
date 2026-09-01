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

## 7. Sicherungen

Serverseite → Reiter **Backups**. Zwei Hälften:

- **Archives** (Archive): jetzt eine Sicherung erstellen (funktioniert bei laufendem Server — der Agent schreibt die Welt vorher mit `save-all` weg), sie herunterladen, mit einem Klick wiederherstellen (standardmäßig wird vorher eine Sicherung des aktuellen Stands angelegt) oder löschen. Jedes Archiv zeigt Größe, Datum und Integritäts-Hash.
- **Policies** (Regeln): geplante Sicherungen, ausgeführt **vom Agenten**, ob das Panel online ist oder nicht. Wählen Sie die Häufigkeit und wie viele Archive aufbewahrt werden (die Rotation lässt das jüngste erfolgreiche Archiv nie verfallen). „Only if running“ (nur wenn er läuft) überspringt einen gestoppten Server. Die Zeiten folgen der Planungs-Zeitzone des Panels, die unter dem Formular angezeigt wird.

Ein neuer Server erhält eine Standardregel (täglich, 7 aufbewahren). Schlägt eine geplante Sicherung fehl oder wird sie übersprungen, hält das Panel es fest und kann Sie benachrichtigen — siehe die Benachrichtigungskategorien in Ihren Kontoeinstellungen. Der Zielordner wird unter Settings → General festgelegt (pro Server in der Regel überschreibbar).

## 8. Einen Server duplizieren

Serverseite → **Duplicate** (duplizieren; ein Dialog öffnet sich): Das Panel kopiert den Server in einen **neuen** Server, auf derselben oder einer anderen Maschine. Der typische Fall ist ein „Vorlagen“-Server, den man auf seine eigene Maschine klont.

Das Original wird nie verändert: Lief es, wird es für die Dauer der Kopie gestoppt und danach automatisch wieder gestartet — ob die Duplizierung gelingt oder scheitert. Der Klon kommt **gestoppt** an, mit dem Abzeichen „Copy“, mit eigener Identität und mit einem freien Spielport, den das Panel automatisch wählt (später unter Configuration änderbar, wenn Sie einen anderen bevorzugen). Sein RCON wird beim ersten Start neu vergeben.

Darunter steckt derselbe Mechanismus wie bei einer Migration (Sicherung → Übertragung → Wiederherstellung): Beide Maschinen müssen online sein, und es dauert etwa so lange wie eine Sicherung plus eine Wiederherstellung. Scheitert etwas vor der Wiederherstellung, wird nichts angelegt; scheitert es danach, bleibt der Klon bestehen und der Fehler sagt, was zu prüfen ist (insbesondere der Port).

## 9. Startgruppen

Seite **Servers** (Flottenansicht) → Schaltfläche **Groups** (Gruppen, für Administratoren): Gruppe anlegen, Server hinzufügen und mit den Pfeilen ordnen. Server, die zu einer Gruppe gehören, tragen in der Liste ein Gruppenabzeichen.

**Gruppe starten** startet die Server **einzeln nacheinander** in der gewählten Reihenfolge und wartet jeweils, bis einer wirklich läuft, bevor der nächste dran ist; das Stoppen geht die Reihenfolge rückwärts durch. Die Serie hält beim ersten Fehlschlag an und benachrichtigt Sie. Pro Gruppe kann immer nur eine Gruppenaktion gleichzeitig laufen.

Zeitpläne zielen nicht auf Gruppen: Für einen geplanten Start in Reihenfolge staffeln Sie die Zeitpläne der einzelnen Server. Gehört ein Velocity-Proxy zur Gruppe, stellen Sie ihn beim Start ans Ende (die Oberfläche warnt Sie, wenn er es nicht ist): Die Server sollten bereit sein, wenn der Proxy anfängt, Spieler anzunehmen.

## 10. Velocity-Proxys

Ein Ordner mit einer `velocity.toml` wird beim Scan als **Velocity-Proxy** erkannt und wie ein Server verwaltet: starten, stoppen, Konsole, Logs.

Einige Unterschiede sind Absicht: keine Minecraft-Version (ein Proxy hat keine), kein RCON und kein TPS (das Metrik-Panel erklärt, warum), das saubere Stoppen nutzt Velocitys `shutdown`-Befehl, Port und MOTD werden aus `velocity.toml` gelesen, und es gibt keine EULA zu bestätigen. Gestartet wird mit Java 17.

Der Agent der Maschine muss aktuell sein, um Proxys zu erkennen — ein älterer Agent ignoriert sie schlicht.
