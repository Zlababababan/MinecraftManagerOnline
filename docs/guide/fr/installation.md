# Installation

[English](../installation.md) · **Français** · [Español](../es/installation.md) · [Deutsch](../de/installation.md) · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

Guide utilisateur — installer le **panel** (une seule machine, celle qui reste allumée), puis un **agent** sur chaque machine qui héberge des serveurs Minecraft (souvent la même). Tout est livré sous forme d'archives autonomes : aucun Node, Java ou Python à installer au préalable.

Plateformes packagées : **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, serveurs ARM), **macOS Apple Silicon**. Windows ARM64 fonctionne avec l'archive x64 (émulation). macOS Intel n'est pas packagé. Les archives Linux fonctionnent avec glibc ≥ 2.31 (Ubuntu 20.04+, Debian 11+).

## 1. Le panel

### 1.1 Télécharger

Récupérez l'archive `mmo-panel-<version>-<plateforme>.zip` (Windows) ou `.tar.gz` (Linux / macOS) depuis les [releases GitHub](https://github.com/Zlababababan/MinecraftManagerOnline/releases). Elle contient le runtime Node épinglé, le panel, l'interface web et les archives d'installation des agents pour les 4 plateformes (`dist-agent/`).

> Pas d'archive disponible pour votre plateforme ? Construisez-la depuis les sources en deux commandes : voir « Démarrage rapide » dans le [README](../../../README.fr.md).

### 1.2 Extraire et lancer

**Windows** — extrayez dans un dossier permanent, par exemple `C:\mmo\panel`, puis :

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux / macOS** :

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
sudo chown -R "$USER" /opt/mmo/mmo-panel   # extrait par root — donnez-le à l'utilisateur qui le lance (§1.4 le donnera à l'utilisateur de service mmo)
/opt/mmo/mmo-panel/mmo-panel.sh
```

Le panel écoute sur `http://127.0.0.1:3000` (jamais sur toutes les interfaces — c'est la couche d'accès, §3, qui l'expose ; `0.0.0.0` est refusé au démarrage). Variables utiles : `MMO_PORT`, `MMO_HOST` (une adresse précise), `MMO_DATA_DIR` (défaut `./data` à côté du script — **c'est le dossier à sauvegarder** : base SQLite, métriques, certificats, releases). En plus de la console, le panel écrit son journal dans `data/logs/panel-<date>.log` (14 jours conservés) — c'est là qu'il faut regarder quand quelque chose s'est mal passé après la fermeture de la fenêtre.

### 1.3 Premier démarrage

Ouvrez `http://127.0.0.1:3000`. Sur une machine sans navigateur (serveur, VM) : mettez d'abord l'accès distant en place (§3 — installer Tailscale, exécuter la commande `tailscale serve`, puis ouvrir `https://<machine>.<tailnet>.ts.net` depuis un autre appareil) ou passez par un tunnel SSH (`ssh -L 3000:127.0.0.1:3000 utilisateur@machine` puis ouvrez `http://127.0.0.1:3000` en local). Le wizard se déroule en deux étapes — **Compte administrateur** (identifiant, mot de passe, langue), puis **Accès** : l'**URL publique du panel** (optionnelle à ce stade), le **mode d'accès** (voir §3) et la **destination de backups par défaut**. L'URL publique se change à tout moment dans Réglages → Général : c'est elle qui est injectée dans les commandes d'installation des agents et dans les notifications push — renseignez-la dès que votre accès distant est en place.

### 1.4 Démarrer au boot (service)

**Windows** (shawl est fourni dans l'archive) — dans un PowerShell **administrateur** :

```powershell
cd C:\mmo\panel
.\shawl.exe add --name mmo-panel --cwd C:\mmo\panel --log-dir C:\mmo\panel\logs --restart -- C:\mmo\panel\runtime\24.19.0\node.exe C:\mmo\panel\app\dist\main.js
sc.exe config mmo-panel start= delayed-auto
Start-Service mmo-panel
```

Le service tourne alors sous `LocalSystem` ; pour le faire tourner sous votre compte (recommandé si les sauvegardes visent un lecteur réseau), passez par `services.msc` → Connexion, ou adaptez la procédure de l'agent (§2.2). Variables d'environnement (`MMO_PORT`…) : `shawl add --env MMO_PORT=3000 …`.

> Important : `mmo-panel.cmd` pose `MMO_WEB_DIR` et `MMO_DIST_DIR` ; avec shawl, ajoutez-les explicitement : `--env MMO_WEB_DIR=C:\mmo\panel\web --env MMO_DIST_DIR=C:\mmo\panel\dist-agent --env MMO_DATA_DIR=C:\mmo\panel\data`.

**Linux** (systemd) — `/etc/systemd/system/mmo-panel.service` :

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

**macOS** (launchd) — `/Library/LaunchDaemons/com.mmo.panel.plist` avec `ProgramArguments` = `/opt/mmo/mmo-panel/mmo-panel.sh`, `RunAtLoad` et `KeepAlive` à `true`, puis `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mmo.panel.plist`.

### 1.5 Mettre à jour le panel

Arrêtez le service, extrayez la nouvelle archive **par-dessus** (le dossier `data/` n'est jamais dans l'archive), redémarrez. Les migrations de base se jouent au démarrage. La nouvelle archive embarque les agents de même version : le panel publie automatiquement la release d'agent et, si « Mettre à jour les agents automatiquement à la connexion » est coché (Réglages → Général — décoché par défaut), chaque agent est mis à jour à sa prochaine connexion, avec rollback automatique en cas d'échec. Sinon, mettez-les à jour un par un depuis la carte Agent de chaque page machine.

### 1.6 Sauvegarder et restaurer le panel

Le panel se sauvegarde lui-même une fois par jour (copie cohérente `VACUUM INTO` de sa base) dans `data/backups/panel/mmo-<date>.db`, 7 copies conservées ; Réglages → Sauvegardes du panel permet d'en créer une à la demande. Les métriques (`metrics.db`) ne sont pas copiées : elles sont reconstituables et volumineuses. Sauvegardez aussi le dossier `data/` complet si vous voulez garder certificats et archives d'agents.

Pour **restaurer** : arrêtez le panel (service ou Ctrl+C), puis :

```powershell
C:\mmo\panel\mmo-panel.cmd restore mmo-2026-08-23T01-00-00.db
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh restore mmo-2026-08-23T01-00-00.db
```

Le nom seul suffit pour une copie du dossier `data/backups/panel/` ; un chemin complet est accepté. La copie est vérifiée (`integrity_check`), la base courante est conservée en `mmo.db.before-restore-<date>`, puis le panel peut être redémarré : les agents se reconnectent avec leur secret d'origine et les serveurs qu'ils portent sont ré-adoptés avec les mêmes identifiants (marqueur `.mmo-server.json`). Ce qui a été créé après la sauvegarde (utilisateurs, machines appairées, réglages) est perdu : une machine appairée après la sauvegarde devra être ré-appairée. La restauration refuse de s'exécuter si `mmo.db-wal` n'est pas vide (panel encore en cours ou arrêt brutal — démarrez-le puis arrêtez-le proprement avant de recommencer).

## 2. Les agents

Un agent par machine hébergeant des serveurs. Il se connecte **en sortie** vers le panel (WebSocket) : aucun port à ouvrir sur les machines agents.

### 2.1 La commande en un clic

Dans le panel : **Machines → Ajouter une machine**. Le panel génère un code d'appairage (valable 15 minutes) et la commande complète à coller sur la machine cible :

- **Windows** (PowerShell, n'importe quelle version) :
  `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -PairCode MMOP-XXXX-XXXX`
- **Linux / macOS** :
  `curl -fsSL https://<panel>/install.sh | sh -s -- --pair-code MMOP-XXXX-XXXX`

Le script télécharge l'archive de la bonne plateforme depuis le panel, vérifie son empreinte SHA-256, installe les fichiers, **appaire** l'agent (l'erreur est immédiate si le code est périmé), puis enregistre et démarre le service. La machine apparaît `online` dans le panel sous quelques secondes.

> Le panel doit être joignable depuis la machine cible (§3). Tant que l'URL publique n'est pas réglée, la commande utilise l'adresse par laquelle vous avez ouvert le panel.

### 2.2 Ce que fait le script — Windows

- Fichiers dans `%LOCALAPPDATA%\Programs\mmo-agent` (runtime, `launcher.cjs`, `versions/<v>/agent.js`, `shawl.exe`), état dans `%LOCALAPPDATA%\mmo-agent`.
- Service `mmo-agent` enregistré avec **shawl**, démarrage automatique ; il tourne **sous votre compte Windows** (mot de passe demandé une fois, dans la fenêtre élevée qui s'ouvre) pour que l'agent voie vos lecteurs mappés et vos dossiers. Précisément : le compte de la fenêtre élevée — si l'UAC vous fait saisir les identifiants d'un autre compte administrateur, c'est sous ce compte-là que le service tournera. Le droit « Ouvrir une session en tant que service » est accordé automatiquement (si cela échoue, le script continue et indique comment le faire via `secpol.msc`). Alternative : `-ServiceAccount LocalSystem`.
- **Compte sans mot de passe** (session ouverte par code PIN ou sans mot de passe) : Windows interdit aux services d'ouvrir une session avec un mot de passe vide. Validez l'invite vide : le script l'indique et enregistre le service sous `LocalSystem` (l'agent ne voit alors pas vos lecteurs réseau mappés). Pour revenir à votre compte : définissez un mot de passe Windows puis relancez la commande.
- En cas d'échec dans la fenêtre élevée, le message reste affiché (Entrée pour fermer) et le détail est dans `%TEMP%\mmo-install.log`.
- Redémarrage automatique du service en cas de plantage ; arrêt propre = Ctrl+C transmis à l'agent, **jamais** l'arbre de processus : les serveurs Minecraft survivent à l'arrêt ou à la mise à jour de l'agent, puis sont ré-adoptés.
- Options : `-NoService` (fichiers seulement), `-InstallDir`, `-StateDir`, `-Panel`, `-Archive <zip>` (hors ligne).
- Désinstaller : `& ([scriptblock]::Create((irm https://<panel>/install.ps1))) -Uninstall` (ajoutez `-Purge` pour supprimer aussi l'état ; les serveurs Minecraft ne sont jamais touchés).

### 2.3 Ce que fait le script — Linux

- Fichiers dans `/opt/mmo-agent`, état dans `/var/lib/mmo-agent`, compte système `mmo` créé si besoin (`--user <nom>` pour un autre compte — l'agent doit pouvoir lire/écrire les dossiers des serveurs).
- Unit systemd `mmo-agent` avec `KillMode=process` (les serveurs détachés survivent) et `Restart=on-failure`. `sudo` est demandé au besoin.
- **Sans root** : `--user-service` installe dans `~/.local/share/mmo-agent` (fichiers dans `app/`, état à la racine) avec `systemctl --user` et `loginctl enable-linger` (démarre au boot sans session ouverte). Attention : lancé avec `sudo`, `--user-service` est ignoré et c'est l'installation système qui est faite.
- Options : `--no-service`, `--dir`, `--state-dir`, `--panel`, `--archive <tar.gz>` (hors ligne).
- Désinstaller : `curl -fsSL https://<panel>/install.sh | sh -s -- --uninstall [--purge]` (ajoutez `--user-service` si installé ainsi). Le compte système `mmo` est conservé (`userdel mmo` si vous n'en voulez plus).
- Sous **WSL**, la VM s'arrête quelques secondes après la fermeture du dernier terminal : le service (et les serveurs) s'arrêtent avec elle — WSL convient pour essayer, pas pour héberger.

### 2.4 Ce que fait le script — macOS

Même logique : `/opt/mmo-agent`, LaunchDaemon `com.mmo.agent` (`KeepAlive`, `AbandonProcessGroup` : les serveurs survivent), compte = l'utilisateur qui lance `sudo`. `--user-service` crée un LaunchAgent (démarre à l'ouverture de session seulement). Journal : `/var/lib/mmo-agent/agent.log`.

### 2.5 Après un redémarrage de la machine

Le service relance l'agent ; l'agent ré-adopte les serveurs encore en vie (PID + heure de démarrage + ligne de commande) et, si « Restaurer l'état souhaité au démarrage d'un agent » est activé (Réglages → Général), redémarre ceux qui étaient marqués `running`.

### 2.6 Installation hors ligne

Téléchargez l'archive de la plateforme depuis le panel (Réglages → Distribution de l'agent) ou la release, copiez-la avec le script (`install.ps1` / `install.sh` sont aussi dans l'archive) et lancez `install.ps1 -Archive <zip> -Panel https://<panel> -PairCode …` ou `sh install.sh --archive <tar.gz> --panel https://<panel> --pair-code …` (l'empreinte SHA-256 n'est vérifiée que pour une archive téléchargée depuis le panel — une archive locale est prise telle quelle).

## 3. Accès distant (résumé)

Le panel n'écoute que sur `127.0.0.1`. Pour l'atteindre depuis vos agents sur d'autres machines, vos amis et votre téléphone, choisissez un mode (Réglages → Accès distant) :

| Mode                   | Pour qui                                                         | À faire                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Tailscale** (défaut) | Tout le monde, y compris derrière CGNAT/4G                       | Installer Tailscale sur l'hôte du panel et sur chaque appareil client, puis exécuter la commande `tailscale serve` affichée |
| **Direct**             | Vous avez une IPv6 publique et un domaine (DuckDNS, Cloudflare…) | Renseigner domaine + fournisseur DNS, émettre le certificat (DNS-01), ouvrir le port 443 (pinhole IPv6 sur la box)          |
| **Manuel**             | Vous avez déjà un reverse-proxy                                  | Le faire pointer sur `127.0.0.1:3000` avec support WebSocket                                                                |

Dans tous les cas, la carte **Test de joignabilité** (bouton **Lancer le test**, dans Réglages → Accès distant) vérifie HTTP, WebSocket, frames binaires (64 KiB) et certificat TLS par l'URL publique. Détails et dépannage : [FAQ réseau](faq-reseau.md). Ajout de machines et adresses à donner aux joueurs : [Ajouter une machine](ajouter-une-machine.md).

## 4. Sur le téléphone : installer la PWA

Le panel est une application web installable (PWA) : une fois l'accès distant en place (§3 — l'installation exige HTTPS), ouvrez l'URL publique dans le navigateur du téléphone et ajoutez l'application à l'écran d'accueil :

- **Android (Chrome)** : menu ⋮ → « Ajouter à l'écran d'accueil » (ou « Installer l'application » si proposé).
- **iOS (Safari)** : bouton Partager → « Sur l'écran d'accueil ». Sur iOS c'est **obligatoire** pour recevoir les notifications push : elles ne fonctionnent que depuis la PWA installée, pas depuis Safari.

L'application s'ouvre alors en plein écran, avec la navigation en bas de l'écran. Pour les notifications (crash d'un serveur, sauvegarde échouée, agent hors ligne…) : page Compte → Notifications push — activez-les, choisissez les catégories, et vérifiez avec le bouton « Envoyer un test ». En mode Tailscale, le téléphone doit avoir l'application Tailscale installée et connectée au tailnet pour joindre le panel.
