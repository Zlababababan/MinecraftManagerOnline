# Ajouter une machine

[English](../add-a-machine.md) · **Français** · [Español](../es/add-a-machine.md) · [Deutsch](../de/add-a-machine.md) · [Português](../pt/add-a-machine.md) · [Русский](../ru/add-a-machine.md) · [中文](../zh/add-a-machine.md)

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

## 7. Sauvegardes

Page serveur → onglet **Sauvegardes**. Deux moitiés :

- **Archives** : créer une sauvegarde maintenant (fonctionne serveur allumé — l'agent vide d'abord le monde sur disque avec `save-all`), la télécharger, la restaurer en un clic (une sauvegarde de sécurité de l'état courant est prise par défaut), ou la supprimer. Chaque archive affiche sa taille, sa date et son empreinte d'intégrité. L'agent **relit aussi chaque archive périodiquement** (une passe par jour, les plus anciennes d'abord, 8 Gio au plus par passe, jamais pendant une sauvegarde ou une restauration de ce serveur) et l'onglet indique quand chacune a été vérifiée pour la dernière fois. Une archive qui ne correspond plus à son manifeste est marquée **Corrompue**, avec un événement et une notification : supprimez-la et refaites une sauvegarde — ne restaurez pas depuis elle.
- **Politiques** : sauvegardes planifiées exécutées **par l'agent**, panel allumé ou non. Choisissez la fréquence et le nombre d'archives à garder (la rotation ne périme jamais l'archive réussie la plus récente). « Seulement si le serveur tourne » saute un serveur arrêté. Les horaires suivent le fuseau de planification du panel, affiché sous le formulaire.

Un nouveau serveur reçoit une politique par défaut (quotidienne, 7 conservées). Si une sauvegarde planifiée échoue ou est sautée, le panel l'enregistre et peut vous prévenir — voir les catégories de notifications dans les réglages de votre compte. Le dossier de destination se règle dans Réglages → Général (remplaçable par politique).

Deux contrôles ont lieu **avant** d'écrire quoi que ce soit :

- **Espace libre.** L'agent estime la taille de l'archive (d'après le taux de compression de l'archive précédente de ce serveur, plus une marge de 64 Mio) et refuse si la destination n'a pas cette place — l'erreur donne les chiffres. Rien n'est écrit, et un serveur en marche continue d'enregistrer normalement.
- **Marqueur de destination.** Quand vous réglez un dossier de destination (autre que celui de l'agent), l'agent y dépose un petit fichier, `.mmo-backups.json`, à la racine. Une sauvegarde est refusée si ce fichier manque — typiquement un lecteur réseau ou un disque USB non monté : sans ce contrôle, la sauvegarde atterrirait dans le point de montage vide du disque système et tout paraîtrait normal jusqu'au jour où vous en auriez besoin. Montez le lecteur et réessayez. Si c'est bien le bon dossier (disque neuf, fichier supprimé), créez-y un fichier vide de ce nom à la racine, ou videz la destination dans les réglages, enregistrez, puis remettez-la.

## 8. Dupliquer un serveur

Fiche serveur → **Dupliquer** (une fenêtre s'ouvre) : le panel copie le serveur vers un **nouveau** serveur, sur la même machine ou sur une autre. Le cas classique : un serveur « modèle » que l'on clone sur sa propre machine.

L'original n'est jamais modifié : s'il tournait, il est arrêté le temps de la copie puis relancé automatiquement — que la duplication réussisse ou échoue. Le clone arrive **arrêté**, avec un badge « Copie », sa propre identité et un port de jeu libre choisi automatiquement par le panel (modifiable ensuite dans la Configuration). Son RCON est réattribué à son premier démarrage.

Sous le capot, c'est la même mécanique qu'une migration (sauvegarde → transfert → restauration) : les deux machines doivent être en ligne, et cela prend à peu près le temps d'une sauvegarde plus une restauration. En cas d'échec avant la restauration, rien n'est créé ; après, le clone est conservé et l'erreur vous dit quoi vérifier (le port, notamment).

## 9. Groupes de démarrage

Page **Serveurs** (vue de flotte) → bouton **Groupes** (admin) : créez un groupe, ajoutez-y des serveurs, ordonnez-les avec les flèches. Les serveurs d'un groupe portent un badge de groupe dans la liste.

**Démarrer le groupe** lance les serveurs **un par un** dans l'ordre choisi, en attendant que chacun soit réellement en marche avant de passer au suivant ; l'arrêt parcourt l'ordre inverse. La série s'arrête au premier échec et vous le signale (notification). Une seule action de groupe à la fois sur un même groupe.

Les planifications ne ciblent pas les groupes : pour un démarrage en série planifié, décalez des planifications par serveur. Si un proxy Velocity fait partie du groupe, placez-le en dernier au démarrage (l'interface avertit si ce n'est pas le cas) : les serveurs doivent être prêts quand le proxy accepte les joueurs.

## 10. Proxys Velocity

Un dossier contenant un `velocity.toml` est reconnu au scan comme **proxy Velocity** et géré comme un serveur : démarrage, arrêt, console, journaux.

Quelques différences sont assumées : pas de version Minecraft affichée (un proxy n'en a pas), pas de RCON ni de TPS (le panneau de métriques l'explique), l'arrêt propre passe par la commande `shutdown` de Velocity, le port et le MOTD sont lus dans `velocity.toml`, et il n'y a pas d'EULA à accepter. Le lancement utilise Java 17.

L'agent de la machine doit être à jour pour détecter les proxys — un agent plus ancien les ignore proprement.
