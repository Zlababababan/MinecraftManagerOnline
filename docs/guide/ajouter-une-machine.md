# Ajouter une machine

Une **machine** = un ordinateur qui héberge des serveurs Minecraft, piloté par un agent. Le panel lui-même peut en être une (cas le plus courant : tout tourne sur le PC de jeu).

## 1. Créer la machine et obtenir la commande

1. Panel → **Machines** → **Ajouter une machine**, donnez-lui un nom.
2. Le panel affiche un **code d'appairage** (`MMOP-XXXX-XXXX`, valable 15 minutes, usage unique) et la commande complète pour Windows et pour Linux/macOS.
3. Collez la commande sur la machine cible — voir [Installation § 2](installation.md#2-les-agents) pour le détail de ce qu'elle fait.
4. La machine passe `online` dans le panel. Si le code a expiré, **Nouveau code** en génère un autre ; relancez la commande.

La commande contient l'URL publique du panel : vérifiez-la (Réglages → Général) si la machine cible n'est pas sur le même réseau que vous.

## 2. Détecter les serveurs

Sur la page de la machine : **Dossiers surveillés** → ajoutez le dossier parent de vos serveurs (ex. `E:\Minecraft\Server`, `/srv/minecraft`). L'agent scanne (Forge, NeoForge, Fabric, Vanilla ; 1.12 → 1.21+), propose chaque serveur détecté avec sa version, son loader et sa RAM ; **Adopter** les serveurs voulus. Rien n'est modifié sur le disque à l'adoption, sauf l'activation RCON (`server.properties`, mot de passe généré) nécessaire au pilotage en mode détaché.

Java : l'agent inventorie les JRE présents ; si la version requise manque, **Installer Java** (Temurin, sinon Zulu) depuis la page machine ou la fiche serveur.

## 3. Adresses pour les joueurs

Chaque serveur a un **mode d'exposition** (vue d'ensemble du serveur → carte « Accès joueurs ») :

- **Tailnet** : vos amis installent Tailscale et rejoignent votre tailnet (partage de nœud ou invitation) ; l'adresse à leur donner est l'IP `100.x.y.z` (ou le nom MagicDNS) de la machine + port.
- **Direct** : adresse publique — votre domaine si la machine est l'hôte du panel en mode direct, sinon l'IPv6 globale de la machine (ou l'hôte public que vous saisissez sur la page machine, carte « Adresses pour les joueurs »). Ouvrez le port du serveur (pinhole IPv6 sur la box + règle pare-feu affichée dans Réglages → Accès distant → Pare-feu).
- **LAN** : pas d'exposition, adresse locale.

Le bouton **Tester** effectue un vrai _Server List Ping_ depuis l'hôte du panel (version, joueurs, MOTD) : c'est ce que verra un client Minecraft.

## 4. Plusieurs machines

- Les serveurs peuvent être **migrés** d'une machine à l'autre (fiche serveur → Migrer) : pré-vérifications sur la cible (espace, Java, port), transfert direct entre agents ou relayé par le panel, bascule, l'ancien dossier est renommé `.migrated-<date>`.
- Les **sauvegardes** ont une destination par serveur (locale ou dossier partagé/monté), rotation par politique, restauration en un clic.
- Mise à jour des agents : Réglages → Général → « Mettre à jour les agents automatiquement », ou manuellement depuis la page machine (carte Agent). Un agent qui ne redevient pas sain en 30 s revient de lui-même à la version précédente.

## 5. Retirer une machine

Page machine → **Oublier** retire la machine du panel (les serveurs et fichiers restent intacts). Sur la machine : `install.ps1 -Uninstall` / `install.sh --uninstall` ([Installation § 2](installation.md#2-les-agents)).
