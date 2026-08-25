# Netzwerk-FAQ

[English](../network-faq.md) · [Français](../fr/faq-reseau.md) · [Español](../es/network-faq.md) · **Deutsch** · [Português](../pt/network-faq.md) · [Русский](../ru/network-faq.md) · [中文](../zh/network-faq.md)

_Übersetzung der englischen Version, die maßgeblich ist. Die Benutzeroberfläche der Anwendung ist auf Englisch und Französisch verfügbar._

Das Panel lauscht **nur** auf `127.0.0.1` (oder auf einer bestimmten Adresse via `MMO_HOST`). Drei Wege, es von außen zu erreichen; einer genügt.

## Tailscale (Standard, empfohlen)

**Warum**: funktioniert hinter CGNAT, 4G, Hotel-WLAN, ohne einen einzigen Port zu öffnen; automatisches HTTPS-Zertifikat; kostenloser Tarif für bis zu 6 Benutzer (bei manchen Angeboten 3 — prüfen).

1. Installieren Sie [Tailscale](https://tailscale.com/download) auf dem Panel-Host und melden Sie sich an.
2. Im Panel, Settings → Remote access (Einstellungen → Fernzugriff), Modus **Tailscale**: Kopieren Sie den angezeigten Befehl und führen Sie ihn aus, in der Form
   `tailscale serve --bg --https=443 http://127.0.0.1:3000`.
   Aktivieren Sie **MagicDNS** und **HTTPS certificates** in der Tailscale-Konsole, falls noch nicht geschehen.
3. Die öffentliche URL wird zu `https://<machine>.<tailnet>.ts.net`: Tragen Sie sie unter Settings → General ein.
4. Auf jedem Client-Gerät (Telefon, PC eines Freundes, entfernte Agent-Maschine): Tailscale installieren und demselben **tailnet** beitreten (laden Sie Ihre Freunde ein oder geben Sie den Node frei).
5. Führen Sie den **Reachability test** (Erreichbarkeitstest) aus (gleicher Bildschirm, Schaltfläche **Run the test**): HTTP, WebSocket, Binär-Frames und TLS-Zertifikat (die Binär-Frames laufen durch `tailscale serve`).

Agents: Der Installationsbefehl verwendet die `https://…ts.net`-URL; die Agent-Maschine braucht daher ebenfalls Tailscale. Minecraft-Server: Exposure **Tailnet**, Adresse `100.x.y.z:25565`.

Fehlerbehebung: `tailscale status` auf dem Host; `tailscale serve status` muss den Proxy auflisten (`No serve config` = der serve-Befehl wurde nie ausgeführt — der Erreichbarkeitstest schlägt dann mit einer abgewiesenen Verbindung auf Port 443 fehl); wenn der WebSocket-Test fehlschlägt, während HTTP besteht, prüfen Sie, ob nicht noch ein anderer Proxy davor steht (nginx) ohne `Upgrade`. Antwortet das Terminal, `tailscale` sei nicht bekannt (Windows), ist die CLI nicht in Ihrem PATH: Rufen Sie sie mit ihrem vollständigen Pfad in **doppelten** Anführungszeichen auf (einfache Anführungszeichen scheitern unter Windows) — Eingabeaufforderung: `"C:\Program Files\Tailscale\tailscale.exe" serve …`, PowerShell: dasselbe mit `&` davor (an Ihren Installationsordner anpassen).

## Direct (IPv6 + eigene Domain)

**Warum**: kein Zwischenglied, Ihre Freunde installieren nichts. **Voraussetzung**: eine öffentliche IPv6 (die meisten Heimrouter haben eine) — IPv4 hinter CGNAT genügt nicht.

1. Eine Domain: kostenlos mit **DuckDNS** (`your-name.duckdns.org`) oder eine Domain bei Cloudflare; oder ein beliebiger Anbieter im Modus **manual** (Sie legen die Einträge selbst an).
2. Settings → Remote access, Modus **Direct**: Domain, DNS-Anbieter, Token (DuckDNS: das Token der Website; Cloudflare: ein API-Token mit `Zone:DNS:Edit`), ACME-E-Mail. **Save** (Speichern), dann **Request a certificate** (Zertifikat anfordern): Das Panel legt den TXT-Eintrag `_acme-challenge` an (oder zeigt ihn Ihnen im manuellen Modus), wartet auf die Propagation, holt ein Let's-Encrypt-Zertifikat und öffnet einen HTTPS-Listener auf Ihrer globalen IPv6-Adresse, Port 443.
3. **Dynamisches DNS**: der Schalter „Update the AAAA record automatically“ (AAAA-Eintrag automatisch aktualisieren) — das Panel aktualisiert den AAAA-Eintrag alle 10 Min. (DuckDNS/Cloudflare/generische URL). Im manuellen Modus richten Sie den AAAA-Eintrag selbst auf die angezeigte IPv6.
4. **Router / Firewall**: Legen Sie am Router ein IPv6-_Pinhole_ an (Freebox: „Ouvrir un port IPv6“; Livebox: „Pare-feu IPv6“) zur Adresse des Hosts, Port 443 TCP. Auf dem Host fügen Sie die unter Settings → Remote access → **Firewall rules** (Firewall-Regeln) angezeigte Regel hinzu (PowerShell `New-NetFirewallRule` / `ufw allow`). _Temporäre_ IPv6-Adressen (Privacy Extensions) ändern sich mit der Zeit: Das Panel wählt die beim vorigen Tick gesehene stabile Adresse; im Zweifel legen Sie sie unter „Public IPv6 address“ (Öffentliche IPv6-Adresse) fest.
5. Öffentliche URL: `https://your-name.duckdns.org` (Settings → General), dann führen Sie den **Reachability test** aus.

Minecraft-Server: Exposure **Direct**, Pinhole + Firewall-Regel pro Spielport (an derselben Stelle angezeigt). Reine IPv4-Spieler werden sich nicht verbinden können: Bevorzugen Sie für sie Tailscale.

Erneuerung: automatisch, täglich geprüft, sobald weniger als 30 Tage verbleiben — außer bei manuellem DNS (das Panel warnt Sie: Fordern Sie das Zertifikat erneut an).

## Manual (bestehender Reverse-Proxy)

Richten Sie Ihren Proxy (Caddy, nginx, Traefik…) auf `http://127.0.0.1:3000`, **mit WebSocket-Unterstützung** (`Upgrade`/`Connection`) und Frames von mindestens 16 MB, und leiten Sie `X-Forwarded-Proto` / `X-Forwarded-Host` weiter. Caddy-Beispiel:

```
panel.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Tragen Sie die öffentliche URL ein und führen Sie den Erreichbarkeitstest aus: Die Zeile „Seen via“ des Ergebnisses zeigt „a reverse-proxy“, wenn die Header korrekt weitergeleitet werden.

## Häufig gestellte Fragen

**Der Agent bleibt nach der Installation `offline`.** Prüfen Sie auf der Maschine die Logs — Windows: `launcher.log` im Wurzelverzeichnis von `%LOCALAPPDATA%\Programs\mmo-agent` und die Dienstlogs in dessen Unterordner `logs\`; Linux: `journalctl -u mmo-agent -f` (`--user`, falls mit `--user-service` installiert); macOS: `/var/lib/mmo-agent/agent.log`. Übliche Ursachen: Panel-URL von dieser Maschine aus nicht erreichbar (Tailscale nicht installiert/verbunden, Firewall), Zertifikat nicht vertrauenswürdig (manueller Modus mit einer privaten CA: in den Systemspeicher aufnehmen), abgelaufener Kopplungscode (die Meldung `pairing failed` wird während der Installation angezeigt) oder ein von einem anderen Panel geerbter Agent-Zustand (`unknown, unpaired or disabled agent` in den Logs — der Installer koppelt automatisch neu; als letztes Mittel mit `-Purge` / `--purge` deinstallieren und den Installationsbefehl erneut ausführen).

**Das Panel ist erreichbar, aber WebSocket schlägt fehl.** Ein Proxy ohne `Upgrade` oder mit einem kurzen Idle-Timeout. Der Erreichbarkeitstest zeigt, welcher Schritt fehlschlägt (HTTP, WebSocket, Binary frames, TLS certificate).

**Push-Benachrichtigungen kommen nie an.** Sie erfordern HTTPS (Tailscale oder Direct) und, auf iOS, die Installation der PWA auf dem Startbildschirm (Account → Push notifications führt Sie hindurch; siehe auch [Installation § 4](installation.md#4-auf-ihrem-telefon-die-pwa-installieren)). Die Schaltfläche „Send a test“ an derselben Stelle prüft die gesamte Kette.

**Ein Server fällt aus, wenn der Agent stoppt oder aktualisiert wird.** Sollte nicht passieren: Die Server sind detached, und der Dienst ist so konfiguriert, dass nur der Agent beendet wird (`KillMode=process`, `AbandonProcessGroup`, shawl). Wenn Sie einen Dienst von Hand eingerichtet haben, prüfen Sie diese Einstellung; verwenden Sie niemals `taskkill /T` auf den Agent.

**Nur IPv4 (kein IPv6 am Router).** Der Direct-Modus ist ohne öffentliche IPv4-Portweiterleitung unmöglich; verwenden Sie Tailscale.

**Ports.** Panel: 443 eingehend (nur im Direct-Modus). Agents: kein eingehender Port. Minecraft-Server: 25565/TCP (und jeder von Ihnen gewählte Port) im Direct-Modus.
