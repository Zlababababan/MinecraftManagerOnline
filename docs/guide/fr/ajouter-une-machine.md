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
- **Restaurer des fichiers…** (menu de l'archive) : parcourez l'archive sans l'extraire — l'agent lit les en-têtes du tar sur la machine — et cochez les dossiers ou fichiers à récupérer : un monde seul, un fichier de région, le `server.properties` d'hier. Par défaut ils arrivent **à côté** des fichiers actuels, dans un nouveau dossier `restored-<date>` du dossier serveur : rien n'est remplacé, le serveur continue de tourner, et vous déplacez ce dont vous avez besoin depuis là (ce dossier n'est jamais sauvegardé ni détecté comme un serveur ; supprimez-le quand c'est fini). Choisissez _Remplacer les fichiers actuels_ pour restaurer en place : les chemins choisis sont supprimés puis réécrits depuis l'archive, le serveur est arrêté d'abord et une sauvegarde de sécurité est prise par défaut. Demande un agent 1.0.8 ou plus récent ; un agent plus ancien reçoit un message clair « mettez à jour l'agent ».
- **Politiques** : sauvegardes planifiées exécutées **par l'agent**, panel allumé ou non. Choisissez la fréquence et le nombre d'archives à garder (la rotation ne périme jamais l'archive réussie la plus récente). « Seulement si le serveur tourne » saute un serveur arrêté. Les horaires suivent le fuseau de planification du panel, affiché sous le formulaire.
- **Copie hors-site** : choisissez une autre machine du parc, et chaque sauvegarde réussie de ce serveur (manuelle ou planifiée) y est copiée aussitôt écrite — d'agent à agent quand les deux se joignent, par le panel sinon, avec reprise et vérification (sha256). La copie a sa propre rétention (« copies conservées »), indépendante de celle de l'original. Chaque archive indique où vit sa copie ; si l'original disparaît de la machine du serveur (rotation, disque perdu), _Rapatrier depuis <machine>_ ramène la copie et la sauvegarde redevient restaurable. Une destination éteinte se rattrape à sa reconnexion (la dernière archive sans copie part). Supprimer une sauvegarde supprime aussi ses copies joignables.

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

## 11. Partager avec des amis : des comptes limités à certains serveurs

Un ami qui héberge une des machines, ou qui ne joue que sur un serveur, n'a pas besoin de tout le panel. Réglages → Utilisateurs a une colonne **Accès** à côté du rôle : **Tout le panel** (le comportement historique : le rôle vaut partout) ou **Serveurs choisis**. Avec le second, le bouton **Serveurs…** ouvre ce que le compte a le droit de voir :

- une **machine** accorde tous ses serveurs, y compris ceux détectés plus tard — le bon choix pour « il gère sa propre machine » ;
- un **serveur** n'accorde que lui, et laisse ouvrir la page de sa machine en lecture (métriques, état de l'agent) ;
- chaque ligne porte un rôle, **lecture** ou **opérateur**, jamais au-dessus du rôle du compte : un compte créé en lecture seule reste lecteur partout.

Tout le reste n'existe pas pour ce compte : ni dans les listes, ni dans le temps réel, ni dans la console, ni dans les notifications, et un lien direct vers un autre serveur répond « introuvable » plutôt qu'« interdit ». Changer le réglage d'accès déconnecte le compte (comme un changement de rôle) ; changer les serveurs accordés recharge seulement ses pages ouvertes. Les administrateurs voient toujours tout et ne peuvent pas être limités.

Une action de groupe s'exécute sur chaque serveur du groupe : un compte limité ne peut la lancer que s'il est opérateur sur chacun de ses membres.

## 12. Clés d'API

Un script, une box domotique ou un outil de supervision peuvent appeler l'API du panel sans votre mot de passe. Sur votre page **Compte**, la carte **Clés d'API** crée une clé avec un nom, un **rôle** et une **expiration** ; la clé est affichée **une seule fois** et s'envoie avec chaque requête :

```
curl -H "Authorization: Bearer mmo_…" https://panel.example.net/api/servers
```

Ce qu'une clé peut faire est borné deux fois : par son propre rôle, choisi à la création, et par votre compte — le plus faible des deux l'emporte, et une clé d'un compte limité à certains serveurs ne voit que ces serveurs. Une clé ne peut donc jamais faire plus que vous, et si votre compte est rétrogradé, désactivé ou supprimé, ses clés suivent. Une clé ne change pas un mot de passe, ne crée pas de compte, ne crée ni ne révoque de clé : ces pages exigent une vraie connexion. La colonne **Dernière utilisation** (date et adresse) dit si une clé sert encore ; révoquez-la depuis la même carte, l'effet est immédiat. Les administrateurs voient toutes les clés de tous les comptes dans Réglages → Clés d'API, et peuvent révoquer n'importe laquelle. Les clés refusées sont limitées par adresse, et le journal d'audit nomme le compte ET la clé pour tout ce qui est fait par elle.

## 13. Appareils connectés

Votre page **Compte** liste chaque navigateur connecté à votre compte : quel navigateur et quel système, depuis quelle adresse, la dernière activité, et quelle ligne est **cet appareil**. **Déconnecter** met fin à la session de ce navigateur sur-le-champ — ses pages perdent leur connexion en direct et retombent sur l'écran de connexion. **Déconnecter les autres appareils** ne garde que celui que vous utilisez : le bon geste quand vous pensez que quelqu'un connaît votre mot de passe, juste après l'avoir changé. Les sessions expirent d'elles-mêmes après 30 jours sans activité. Un administrateur peut aussi déconnecter un compte de partout depuis Réglages → Utilisateurs (**Déconnecter partout**), par exemple quand un ami quitte le serveur.

## 14. Une page de statut publique pour les amis

Vos amis n'ont pas besoin d'un compte pour savoir si le serveur tourne. Sur la vue d'ensemble d'un serveur, la carte **Page de statut publique** publie un lien à leur donner :

```
https://panel.example.ts.net/s/UkZ0bE1nQ2h5Zg
```

La page montre le nom du serveur, s'il est en ligne, **l'adresse à copier** dans le client Minecraft, la version, le message d'accueil (MOTD), le nombre de joueurs connectés et l'heure de la prochaine sauvegarde. Elle ne montre rien d'autre : ni chemin de dossier, ni machine, ni identifiant, et il n'y a aucun bouton — on ne démarre, n'arrête et ne configure rien depuis cette page.

Les **pseudos** ne sont affichés que si vous cochez « Afficher les pseudos des joueurs connectés » : par défaut, la page dit « 3 joueurs » sans dire lesquels. Demandez leur accord avant de les publier.

Trois choses à savoir :

- **Le lien est le mot de passe.** Il n'est pas devinable, mais quiconque l'a peut voir la page ; ne le publiez que là où vous le voulez bien. **Changer de lien** en fabrique un nouveau et tue l'ancien sur-le-champ — le geste à faire si le lien a fuité.
- **Désactiver garde le lien.** Le bouton « Publier une page de statut » suffit à fermer la page ; en la rouvrant plus tard, vos amis retrouvent l'adresse qu'ils ont mise en favori.
- **Le lien n'est joignable que là où le panel l'est.** Si votre panel passe par Tailscale, la page suit : elle est visible par les appareils du tailnet, pas par Internet.

Quand la machine est éteinte ou que son agent est arrêté, le panel interroge directement le serveur (le même « ping » que les clients Minecraft) : la page reste juste, même si le panel n'a plus d'agent pour le lui dire. L'état est mis en cache quelques secondes : rafraîchir la page en boucle ne dérange pas le serveur.

## 15. Laisser vos amis demander l'accès (whitelist)

Si votre serveur a une liste blanche, ajouter quelqu'un demande d'habitude un aller-retour : il vous donne son pseudo par message, vous ouvrez le panel, vous tapez. La case **« Accepter les demandes de whitelist »** de la page de statut publique supprime l'aller-retour.

Une fois cochée, vos amis voient un petit formulaire sur la page : leur **pseudo Minecraft**, et s'ils le veulent un mot pour vous (« c'est Paul du lycée »). Rien ne se passe alors sur votre serveur — la demande vous attend, c'est tout.

Vous la retrouvez dans **l'onglet Joueurs → Liste blanche** du serveur, en haut, avec une pastille orange sur l'onglet quand quelqu'un attend (et une notification, si vous les avez activées) :

- **Accepter** ajoute la personne à la liste blanche pour de bon — commande envoyée au serveur s'il tourne, fichier `whitelist.json` mis à jour sinon. C'est exactement le bouton « Ajouter » que vous auriez utilisé à la main.
- **Refuser** classe la demande sans rien faire.
- **Oublier** (la corbeille, sur une demande déjà traitée) l'efface de la liste — et permet à la personne d'en refaire une.

Deux détails qui comptent :

- **Redemander est sans conséquence.** Un ami impatient qui renvoie son pseudo ne crée pas dix demandes : il relit simplement la sienne. C'est même ainsi qu'il apprend que vous l'avez accepté — la page le lui dit et il peut se connecter.
- **Ouvrir le formulaire n'ouvre pas votre serveur.** Personne n'entre sans votre clic. Si le lien fuite, vous récolterez au pire quelques demandes à refuser ; « Changer de lien » ferme le robinet d'un coup. Le panel accepte au plus dix envois par minute et par visiteur, et ne conserve rien d'autre que le pseudo et le mot laissés.

> Le formulaire ne sert qu'à demander. Il ne dit pas si un pseudo existe, ne consulte pas les serveurs de Mojang et n'affiche aucune image venue d'ailleurs : tant que vous n'avez pas accepté, une demande n'est qu'une ligne en attente.

## 16. Qui joue, et quand

Le panel note chaque arrivée et chaque départ depuis le premier jour. L'onglet **Joueurs → Statistiques** en fait quatre chiffres, deux graphiques et un classement, sur 7, 30, 90 ou 365 jours :

- **Joueurs**, **connexions**, **temps de jeu total** et le **record de joueurs simultanés**, avec la date de ce record ;
- la **fréquentation par jour** (joueurs distincts et connexions) et le **temps de jeu par jour** ;
- les **heures de jeu** : une barre par heure de la journée. C'est le graphique à regarder avant de programmer un redémarrage ou une sauvegarde — la creuse se voit d'un coup d'œil ;
- le **classement des temps de jeu**, avec un badge « nouveau » pour qui vient d'arriver.

Trois précisions sur la façon dont c'est compté :

- **Une partie à cheval sur minuit compte des deux côtés.** Jouer de 23 h à 1 h fait une heure le premier jour et une heure le second, pas deux heures le premier. Une partie en cours est comptée jusqu'à maintenant, pas jusqu'à la fin de la journée.
- **Les journées et les heures sont celles du panel**, dans le fuseau réglé dans Réglages → Général (affiché sous le graphique). C'est le même que celui des planifications : les deux graphiques se lisent ensemble.
- **« Nouveau » se juge sur ce que le panel a gardé.** Les connexions sont purgées au bout d'un an par défaut (Réglages → Rétention) : un joueur qui n'était pas venu depuis plus longtemps que cela repasse pour un nouveau venu.

> Ces chiffres ne sortent jamais du panel : ils ne sont pas publiés sur la page de statut, ne partent dans aucune notification et ne sont visibles que des comptes qui voient déjà le serveur.
