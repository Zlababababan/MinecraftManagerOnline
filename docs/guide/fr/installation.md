# Installation

[English](../installation.md) · **Français** · [Español](../es/installation.md) · [Deutsch](../de/installation.md) · [Português](../pt/installation.md) · [Русский](../ru/installation.md) · [中文](../zh/installation.md)

Guide utilisateur — installer le **panel** (une seule machine, celle qui reste allumée), puis un **agent** sur chaque machine qui héberge des serveurs Minecraft (souvent la même). Tout est livré sous forme d'archives autonomes : aucun Node, Java ou Python à installer au préalable.

Plateformes packagées : **Windows x64**, **Linux x64**, **Linux ARM64** (Raspberry Pi 4/5, serveurs ARM), **macOS Apple Silicon**. Windows ARM64 fonctionne avec l'archive x64 (émulation). macOS Intel n'est pas packagé.

**Quelles distributions Linux ?** Depuis la 1.0.5, le panel ne contient plus aucun module compilé : **toute distribution à base de glibc fonctionne** — Ubuntu 20.04 et suivantes, Debian 11 et suivantes, Fedora, Rocky/Alma/RHEL 9, openSUSE, Raspberry Pi OS, Oracle Linux, Arch… Rien à installer, ni compilateur, ni paquet de développement. Seule exception : **Alpine** et les systèmes à base de musl, que le runtime Node embarqué ne gère pas — utilisez l'image Docker officielle (§1.2 — elle emporte sa propre libc), une distribution à glibc, ou lancez le panel avec votre propre Node ≥ 24 (`node app/dist/main.js` depuis le dossier extrait).

## 1. Le panel

### 1.1 Télécharger

Ouvrez la [page des releases](https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest) et téléchargez le fichier qui correspond à votre machine :

| Votre machine                                   | Fichier à télécharger                     |
| ----------------------------------------------- | ----------------------------------------- |
| Windows (n'importe quel PC récent)              | `mmo-panel-<version>-win-x64.zip`         |
| Linux sur un PC ou un serveur ordinaire         | `mmo-panel-<version>-linux-x64.tar.gz`    |
| Linux sur ARM (Raspberry Pi, VM Oracle/Ampere…) | `mmo-panel-<version>-linux-arm64.tar.gz`  |
| Mac Apple Silicon (M1–M4)                       | `mmo-panel-<version>-darwin-arm64.tar.gz` |

Vous ne savez pas quel Linux vous avez ? Tapez `uname -m` : `x86_64` = x64, `aarch64` = ARM64.

L'archive se suffit à elle-même : elle embarque son propre runtime Node, le panel, l'interface web et les installeurs d'agents des quatre plateformes. **Il n'y a rien à installer au préalable** — ni Node, ni Java, ni compilateur, ni paquet de développement.

> **Envie de vérifier le téléchargement ?** Chaque release publie `SHA256SUMS.txt` : téléchargez-le à côté de votre archive, puis lancez `sha256sum -c SHA256SUMS.txt --ignore-missing` (Linux), `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS), ou comparez `Get-FileHash <fichier>` à la ligne qui porte le nom de votre fichier (Windows). Les manifestes `panel-<plateforme>.json` portent les mêmes empreintes, un fichier à la fois.

### 1.2 Extraire et lancer

**Linux, une seule commande.** Sur une machine avec systemd (Ubuntu, Debian, Fedora, Raspberry Pi OS…), un copier-coller fait tout ce que décrivent les §1.1 à §1.4 — téléchargement, vérification SHA-256, code dans `/opt/mmo-panel`, données dans `/var/lib/mmo-panel`, réglages dans `/etc/mmo-panel/panel.env`, service systemd durci, puis attente que le panel réponde :

```bash
curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
```

Relancez la **même commande pour mettre à jour** : la base est sauvegardée d'abord, et si la nouvelle version ne démarre pas, la précédente est remise en place. `--uninstall` désinstalle (`--purge` supprime aussi les données), `--help` liste les autres options (`--archive` hors ligne, `--dir`, `--data-dir`…). Si vous préférez voir chaque étape, le parcours manuel ci-dessous reste entièrement pris en charge — installeur et parcours manuel mènent au même résultat.

**Docker.** L'image officielle (multi-arch x64/ARM64, agents embarqués) est la réponse quand la machine tourne sous Alpine/musl, ou quand tout passe déjà par des conteneurs chez vous. Téléchargez [docker-compose.yml](https://github.com/Zlababababan/MinecraftManagerOnline/blob/main/docker-compose.yml), puis :

```bash
docker compose up -d
```

Le panel répond sur `http://127.0.0.1:3000`. Les données vivent dans le **volume nommé** `mmo-data` — résistez au bind `./data` : créé par root au premier `up`, il reproduit exactement l'erreur de droits « cannot open the database », le conteneur tournant sous l'utilisateur `node` (uid 1000). Dans le conteneur, le panel écoute sur toutes les interfaces (opt-in explicite de l'image) : c'est la ligne `ports:` qui décide de l'exposition réelle — gardez `127.0.0.1:3000:3000` et mettez `tailscale serve` (§3) sur l'hôte, ou exposez en connaissance de cause. CLI : `docker compose exec panel /app/entrypoint.sh doctor` (idem `setup`, `restore`).

**Windows, une seule commande.** Même idée, dans un PowerShell (il demande l'élévation tout seul) — code dans `C:\Program Files\mmo-panel`, données dans `C:\ProgramData\mmo-panel`, service Windows en démarrage automatique différé :

```powershell
& ([scriptblock]::Create((irm https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.ps1)))
```

Relancez-la pour mettre à jour (sauvegarde d'abord, retour arrière si la nouvelle version ne démarre pas). Options : `-Port`, `-Archive` (hors ligne), `-MigrateFrom C:\ancien\panel` (copie les données d'une ancienne installation manuelle, vérifiées par `integrity_check`, sans toucher à l'original), `-ServiceAccount User` (si les sauvegardes visent un lecteur réseau), `-Uninstall` (`-Purge` supprime aussi les données). Vos choix sont mémorisés pour la mise à jour suivante.

L'installeur pose aussi **MinecraftManagerOnline** dans le menu Démarrer : une petite icône près de l'horloge — clic gauche pour ouvrir l'interface, clic droit pour ouvrir, journaux, démarrer/arrêter/redémarrer, « démarrer avec Windows » et quitter. L'icône pilote le service (elle ne lance jamais un second panel) ; sur une installation sans service, elle lance le panel elle-même et « Quitter » l'arrête.

**Windows, parcours manuel.** Clic droit sur le `.zip` → **Extraire tout**, dans un dossier que vous garderez, par exemple `C:\mmo\panel` (évitez Téléchargements et le Bureau). Ouvrez ce dossier et double-cliquez sur **`mmo-panel.cmd`**. Une fenêtre noire s'ouvre et reste ouverte : c'est le panel qui tourne, la fermer l'arrête — le §1.4 en fait un vrai service. Depuis un terminal :

```powershell
C:\mmo\panel\mmo-panel.cmd
```

**Linux.** Dans un terminal, dans le dossier où le fichier a été téléchargé :

```bash
tar -xzf mmo-panel-*.tar.gz
cd mmo-panel
./mmo-panel.sh
```

C'est suffisant pour essayer. Pour une machine qui restera allumée, posez-le dans un endroit définitif — et attention au `chown`, c'est l'erreur qui coûte le plus de temps :

```bash
sudo mkdir -p /opt/mmo && sudo tar -xzf mmo-panel-*.tar.gz -C /opt/mmo
sudo chown -R "$USER" /opt/mmo/mmo-panel   # extrait par root — donnez-le à l'utilisateur qui le lance (§1.4 le donnera à l'utilisateur de service mmo)
/opt/mmo/mmo-panel/mmo-panel.sh
```

**macOS** — mêmes commandes que Linux. Au premier lancement, macOS peut refuser d'exécuter un binaire téléchargé : Réglages Système → Confidentialité et sécurité → « Ouvrir quand même ».

> Quelque chose cloche ? `mmo-panel.cmd doctor` (Windows) ou `./mmo-panel.sh doctor` (Linux/macOS) vérifie le runtime, le dossier de données et son propriétaire, la base et le port, et dit quoi faire — voir §1.6.

Le panel écoute sur `http://127.0.0.1:3000` (jamais sur toutes les interfaces — c'est la couche d'accès, §3, qui l'expose ; `0.0.0.0` est refusé au démarrage). Variables utiles : `MMO_PORT`, `MMO_HOST` (une adresse précise), `MMO_DATA_DIR` (défaut `./data` à côté du script — **c'est le dossier à sauvegarder** : base SQLite, métriques, certificats, releases). En plus de la console, le panel écrit son journal dans `data/logs/panel-<date>.log` (14 jours conservés) — c'est là qu'il faut regarder quand quelque chose s'est mal passé après la fermeture de la fenêtre.

### 1.3 Premier démarrage

Ouvrez `http://127.0.0.1:3000`. Sur une machine sans navigateur (serveur, VM) : mettez d'abord l'accès distant en place (§3 — installer Tailscale, exécuter la commande `tailscale serve`, puis ouvrir `https://<machine>.<tailnet>.ts.net` depuis un autre appareil) ou passez par un tunnel SSH (`ssh -L 3000:127.0.0.1:3000 utilisateur@machine` puis ouvrez `http://127.0.0.1:3000` en local). Le wizard se déroule en deux étapes — **Compte administrateur** (identifiant, mot de passe, langue), puis **Accès** : l'**URL publique du panel** (optionnelle à ce stade), le **mode d'accès** (voir §3) et la **destination de backups par défaut**. L'URL publique se change à tout moment dans Réglages → Général : c'est elle qui est injectée dans les commandes d'installation des agents et dans les notifications push — renseignez-la dès que votre accès distant est en place.

**Sans navigateur du tout** (VM cloud, conteneur, cloud-init), le compte administrateur se crée en ligne de commande — `setup` est exactement le même chemin de code que le wizard. Sur une VM cloud toute fraîche jointe en SSH (Oracle, AWS, Hetzner…), le déroulé complet ressemble à ceci :

1. **Installer** — l'installeur en une commande du §1.2 fait tout, service compris :

   ```bash
   curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
   ```

2. **Créer le compte administrateur.** L'installeur fait tourner le panel sous le compte de service `mmo`, avec ses données dans `/var/lib/mmo-panel` — lancez `setup` sous cette même identité :

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --random-password
   ```

   Le mot de passe généré est affiché une seule fois — copiez-le tout de suite. Utilisez `--password-stdin` (`echo -n 'secret' | … setup --username admin --password-stdin`) ou `--password-file <fichier>` pour le choisir vous-même — ne le passez jamais en argument, la ligne de commande est visible de tous les processus de la machine. `--public-url`, `--locale` et `--access-mode` sont facultatifs. La commande refuse de s'exécuter deux fois. Sur une installation manuelle (§1.2), où les données vivent à côté du script et vous appartiennent, aucun préfixe n'est nécessaire : `/opt/mmo/mmo-panel/mmo-panel.sh setup --username admin --random-password --public-url panel.exemple.net`.

3. **Vérifier.** `doctor` (§1.6) inspecte toute l'installation, et le journal du panel défile via journalctl :

   ```bash
   sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh doctor
   journalctl -u mmo-panel -f
   ```

4. **Ouvrir l'interface depuis votre propre ordinateur** (§3). Soit installer Tailscale sur la VM et exposer le panel sur votre tailnet :

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:3000
   ```

   puis ouvrir `https://<vm>.<tailnet>.ts.net` — soit, pour un premier coup d'œil sans rien installer, passer par un tunnel SSH : `ssh -L 3000:127.0.0.1:3000 utilisateur@vm`, puis ouvrez `http://127.0.0.1:3000` sur votre ordinateur.

**Avec cloud-init**, la même séquence peut se jouer au tout premier démarrage de la VM, avant même votre première connexion. Utilisez `--password-file` avec un fichier posé par `write_files` — pas `--random-password`, dont l'affichage unique se perdrait dans les journaux de cloud-init. Le fichier peut vivre dans `/var/lib/mmo-panel` : l'installeur donne tout ce dossier au compte `mmo`, le panel pourra donc l'y lire.

```yaml
write_files:
  - path: /var/lib/mmo-panel/admin-password
    permissions: '0600'
    content: |
      choisissez-un-long-mot-de-passe-ici
runcmd:
  - curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh -o /run/install-panel.sh
  - sh /run/install-panel.sh
  - sudo -u mmo MMO_DATA_DIR=/var/lib/mmo-panel /opt/mmo-panel/mmo-panel.sh setup --username admin --password-file /var/lib/mmo-panel/admin-password
  - rm -f /var/lib/mmo-panel/admin-password /run/install-panel.sh
```

Deux choses à savoir. Cloud-init s'exécute en root, sans terminal : aucune commande ne doit jamais attendre une saisie — `install-panel.sh` n'en attend jamais, c'est l'une de ses règles. Et le réseau n'est pas toujours établi au moment où `runcmd` démarre : si le téléchargement échoue, relancer la même commande à la main une fois la VM joignable suffit.

### 1.4 Démarrer au boot (service)

> Installé avec un installeur en une commande (§1.2, Linux ou Windows) ? Le service existe déjà — cette section concerne les installations manuelles.

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

Le panel vous prévient quand une mise à jour existe : les administrateurs voient une bannière dès qu'une nouvelle version est publiée (vérifiée contre le flux des releases GitHub au plus toutes les 6 heures — Réglages → Général coupe la vérification, et une catégorie de notification « Nouvelle version du panel publiée » fait sonner la cloche).

Installé avec un installeur en une commande (§1.2, Linux ou Windows) ? Relancez la même commande — elle sauvegarde la base, remplace le code, redémarre le service et revient toute seule en arrière si la nouvelle version ne démarre pas. Installation manuelle : arrêtez le service, extrayez la nouvelle archive **par-dessus** (le dossier `data/` n'est jamais dans l'archive), redémarrez. Les migrations de base se jouent au démarrage. La nouvelle archive embarque les agents de même version : le panel publie automatiquement la release d'agent et, si « Mettre à jour les agents automatiquement à la connexion » est coché (Réglages → Général — décoché par défaut), chaque agent est mis à jour à sa prochaine connexion, avec rollback automatique en cas d'échec. Sinon, mettez-les à jour un par un depuis la carte Agent de chaque page machine.

### 1.6 Quand le panel ne démarre pas : `doctor`

Avant de lire une pile d'appels, demandez au panel ce qui ne va pas. Il vérifie le runtime, les
modules qu'il charge, le dossier de données (écriture **réelle**, et propriétaire comparé à
l'utilisateur courant), la base, le port et le front.

```powershell
C:\mmo\panel\mmo-panel.cmd doctor
```

```bash
/opt/mmo/mmo-panel/mmo-panel.sh doctor
```

Chaque ligne porte `ok`, `warn` ou `ERROR`, et chaque erreur dit quoi faire — y compris la
commande `chown` exacte quand l'archive a été extraite en `sudo` et que le panel tourne sous un
autre utilisateur. La commande sort en 1 dès qu'un contrôle échoue : elle est utilisable dans un
script.

**Vous signalez un problème ?** `report` écrit le même diagnostic dans un fichier, avec vos
versions, vos machines et leurs agents, vos réglages (secrets exclus) et un extrait masqué du
journal — exactement ce que réclame le formulaire d'issue.

```bash
/opt/mmo/mmo-panel/mmo-panel.sh report
```

Relisez le fichier avant de le joindre : les chemins personnels, les jetons et les codes
d'appairage sont masqués et les dossiers de serveurs ne sont jamais listés, mais c'est vous qui le
publiez. `--stdout` l'affiche au lieu de l'écrire, `--no-log` laisse le journal de côté.

### 1.7 Sauvegarder et restaurer le panel

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
- ⚠ **Droits sur vos dossiers de serveurs.** Installé en service système, l'agent tourne sous le compte `mmo`, pas sous le vôtre : vos serveurs rangés dans `/home/<vous>/…` lui sont souvent accessibles en lecture seule. Le panel vous prévient dès l'adoption (« dossier non inscriptible »), et un démarrage refusé nomme le dossier et le compte. Deux réparations, au choix :
  - donner l'accès au compte de l'agent : `sudo chown -R mmo /chemin/vers/mes-serveurs` (ou `sudo chmod -R g+w` après `sudo usermod -aG <votre-groupe> mmo`) ;
  - ou installer l'agent sous votre propre compte : `--user <vous>` (service système) ou `--user-service` (sans root).
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
