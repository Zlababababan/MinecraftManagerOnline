# Ajouter une machine

[English](../add-a-machine.md) · **Français**

Une **machine** = un ordinateur qui héberge des serveurs Minecraft, piloté par un agent. Le panel lui-même peut en être une (cas le plus courant : tout tourne sur le PC de jeu).

## 1. Créer la machine et obtenir la commande

1. Panel → **Machines** → **Ajouter une machine**, donnez-lui un nom.
2. Le panel affiche un **code d'appairage** (`MMOP-XXXX-XXXX`, valable 15 minutes, usage unique) et la commande complète pour Windows et pour Linux/macOS.
3. Collez la commande sur la machine cible — voir [Installation § 2](installation.md#2-les-agents) pour le détail de ce qu'elle fait.
4. La machine passe `online` dans le panel. Si le code a expiré, **Nouveau code d'appairage** en génère un autre (les codes précédents de la machine sont invalidés) ; relancez la commande.

La commande contient l'URL publique du panel : vérifiez-la (Réglages → Général) si la machine cible n'est pas sur le même réseau que vous.

## 2. Détecter les serveurs

Sur la page de la machine : **Répertoires surveillés** → ajoutez le dossier parent de vos serveurs (ex. `E:\Minecraft\Server`, `/srv/minecraft`). L'agent scanne (Forge, NeoForge, Fabric, Vanilla ; 1.12 → 1.21+) et **adopte automatiquement** chaque serveur détecté, avec son loader, sa version et sa RAM — le scan périodique tourne seul, **Scanner maintenant** force un passage immédiat, et **Ajouter un dossier serveur** enregistre un dossier précis sans attendre. Tout reste modifiable ensuite sur la fiche du serveur (les packs bricolés déjouent parfois les heuristiques — la source de chaque valeur détectée est affichée). Rien n'est modifié sur le disque à l'adoption, sauf l'activation RCON (`server.properties`, mot de passe généré) nécessaire au pilotage en mode détaché.

Java : l'agent inventorie les JRE présents ; si la version requise manque, installez-la depuis la carte **Runtimes Java** de la page machine (bouton **Installer ce runtime** — Temurin, sinon Zulu, téléchargé et vérifié automatiquement).

## 3. Premier démarrage d'un serveur

Démarrez le serveur depuis sa carte (tableau de bord) ou sa fiche, et suivez l'état `starting` → `running` (PID affiché). L'onglet **Console** montre les lignes en direct et accepte les commandes. Au premier lancement d'un serveur neuf, si l'EULA de Mojang n'est pas encore acceptée, le panel vous guide (explication, lien, case à cocher) puis vous relancez. Le reste se fait par les onglets de la fiche : **Joueurs** (whitelist, ops, bans — sans jamais ouvrir un fichier), **Configuration** (`server.properties` expliqué champ par champ), **Fichiers**, **Sauvegardes**, **Métriques**, **Planificateur**, **Journaux**.

## 4. Adresses pour les joueurs

Chaque serveur a un réglage **Exposition** (carte **Accès des joueurs**, onglet Aperçu de la fiche serveur) :

- **Tailnet** : vos amis installent Tailscale et rejoignent votre tailnet (partage de nœud ou invitation) ; l'adresse à leur donner est l'IP `100.x.y.z` (ou le nom MagicDNS) de la machine + port.
- **Direct** : adresse publique — votre domaine si la machine est l'hôte du panel en mode direct, sinon l'IPv6 globale de la machine (ou l'hôte public que vous saisissez sur la page machine, carte « Adresses pour les joueurs »). Ouvrez le port du serveur (pinhole IPv6 sur la box + règle affichée dans Réglages → Accès distant → Règles pare-feu).

Les joueurs du même réseau local n'ont besoin de rien : adresse LAN + port, quel que soit le mode. Le bouton **Tester la joignabilité** de la carte effectue un vrai _Server List Ping_ depuis l'hôte du panel (version, joueurs, MOTD) : c'est ce que verra un client Minecraft.

## 5. Plusieurs machines

- Les serveurs peuvent être **migrés** d'une machine à l'autre (carte **Migration** de l'onglet Aperçu → **Migrer vers une autre machine**) : pré-vérifications sur la cible (espace, Java, port), transfert direct entre agents ou relayé par le panel, bascule, l'ancien dossier est renommé `.migrated-<date>`.
- Les **sauvegardes** ont une destination par serveur (locale ou dossier partagé/monté), rotation par politique, restauration en un clic.
- Mise à jour des agents : Réglages → Général → « Mettre à jour les agents automatiquement à la connexion », ou manuellement depuis la page machine (carte Agent). Un agent qui ne redevient pas sain en 30 s revient de lui-même à la version précédente.

## 6. Retirer une machine

Page machine → **Retirer la machine** : elle disparaît du panel (les serveurs et fichiers restent intacts sur le disque). Sur la machine : `install.ps1 -Uninstall` / `install.sh --uninstall` ([Installation § 2](installation.md#2-les-agents)).
