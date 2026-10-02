# MinecraftManagerOnline — Fonctionnalités

Liste de référence, validée avant le développement. Chaque fonctionnalité est marquée **V1** (application complète initiale) ou **Futur** (évolution prévue par l'architecture, développée plus tard).

## 1. Machines (multi-serveur physique)

| Fonctionnalité | Portée |
|---|---|
| Enregistrement d'une machine via code d'appairage généré par le panel | V1 |
| Statut en ligne / hors ligne, reconnexion automatique des agents | V1 |
| Métriques par machine : CPU, RAM, disque | V1 |
| Refus propre des commandes vers une machine hors ligne | V1 |
| Mise à jour des agents poussée depuis le panel (protocole versionné) | V1 |
| Migration d'un serveur d'une machine à une autre (backup → transfert → restauration) | V1 |
| Duplication d'un serveur (même chaîne que la migration, nouvel identifiant, nouveau port ; la source reste en place — cible = même machine ou une autre) | V1 (post-1.0, 2026-09-01) |
| Wake-on-LAN : allumer une machine à distance | Futur |

## 2. Serveurs — cycle de vie

| Fonctionnalité | Portée |
|---|---|
| Auto-détection dans les répertoires surveillés : type (Vanilla / Forge / NeoForge / Fabric), version Minecraft, RAM allouée | V1 |
| Ajout manuel d'un serveur (dossier arbitraire) | V1 |
| Démarrer / arrêter / redémarrer / kill | V1 |
| Lancement construit par l'application (indépendant des scripts `.bat`/`.sh`) | V1 |
| Gestionnaire de versions Java : détection de la version requise, téléchargement automatique du bon JRE (tous OS, x64 et ARM) | V1 |
| Garde-fou RAM : refus de lancement si mémoire insuffisante sur la machine | V1 |
| Priorité CPU par serveur (normale / réduite / minimale) | V1 |
| Gestion des ports : affichage, modification, détection de conflit par machine avant lancement | V1 |
| Acceptation guidée de l'EULA | V1 |
| États de provisionnement (en installation / prêt / archivé) | V1 |
| Groupes de démarrage : démarrage séquentiel par rang en attendant l'état « en marche », arrêt en ordre inverse, série interrompue au premier échec | V1 (post-1.0, 2026-09-01) |
| Proxy Velocity reconnu au scan (`velocity.toml`) et pilotable : lancement `jar` sans `nogui`, console stdin, arrêt `shutdown`, pas d'EULA ni de RCON | V1 (post-1.0, 2026-09-01) |
| Création d'un serveur depuis le panel (Vanilla, Fabric) : assistant, versions issues des fournisseurs, installation en tâche de fond, reprise d'une installation ratée | V1 (post-1.0, 2026-09-04) |
| Création d'un serveur depuis un modpack (CurseForge, FTB, Modrinth) | Futur |
| Mise à jour d'un serveur vers une nouvelle version de modpack | Futur |

## 3. Console et logs

| Fonctionnalité | Portée |
|---|---|
| Logs en temps réel (WebSocket), coloration par niveau | V1 |
| Envoi de commandes avec autocomplétion et historique | V1 |
| Recherche dans les logs, accès aux logs archivés | V1 |
| RCON en complément du stdin (parler à un serveur non lancé par l'application) | V1 |
| **Macros de console** : séquences de commandes enregistrées, jouées d'un clic (2026-08-31) | V1 |

> **Ajout (2026-08-31) — macros de console.** Une macro est une suite de commandes exécutées **dans l'ordre**, enregistrée une fois et rejouée d'un clic : sur cinquante serveurs, les mêmes trois ou quatre commandes se retapent plusieurs fois par semaine, et se retapent mal (`save-all` sans `save-off` avant, un `kill @e` trop large). Par défaut une macro vaut pour **toute la flotte** ; la rattacher à un serveur sert aux séquences qui dépendent d'un mod. Trois décisions : (1) chaque commande passe par le **même chemin que la console**, donc apparaît dans l'historique et dans l'audit — une macro agit, elle ne lit pas ; (2) la séquence **s'arrête au premier échec**, parce que continuer laisserait le serveur dans l'état intermédiaire (sauvegarde désactivée) sans que personne ne le sache, et le résultat dit lesquelles sont passées ; (3) une macro qui contient un arrêt, un bannissement ou une destruction **demande confirmation en montrant la séquence exacte** — c'est un clic, et « arrêter le serveur » ne doit jamais être un clic distrait. Pas de boucle, pas de condition, pas d'attente : ce qui demande un délai (« prévenir puis arrêter dans 5 minutes ») relève du planificateur, qui sait déjà le faire et le montre.

## 4. Joueurs

| Fonctionnalité | Portée |
|---|---|
| Liste des joueurs en ligne (avatars) | V1 |
| Kick / ban / pardon, op / deop | V1 |
| Gestion graphique de la whitelist | V1 |
| Historique des connexions | V1 |

## 5. Configuration sans fichier texte

Objectif : un utilisateur non développeur n'ouvre jamais un fichier brut.

| Fonctionnalité | Portée |
|---|---|
| Éditeur graphique de `server.properties` : interrupteurs, menus, explication de chaque propriété | V1 |
| Éditeurs graphiques de `whitelist.json`, `ops.json`, `banned-players.json`, `banned-ips.json` | V1 |
| Explorateur de fichiers : navigation, upload, téléchargement, édition | V1 |
| Éditeur texte brut en mode « avancé » | V1 |
| Gestion des mods : liste, activer/désactiver, ajout | Futur |

## 6. Monitoring et fiabilité

| Fonctionnalité | Portée |
|---|---|
| CPU / RAM par serveur, TPS, uptime | V1 |
| Graphiques historiques | V1 |
| Watchdog : détection de crash et de freeze, redémarrage automatique optionnel | V1 |
| Statistiques : historique de fréquentation, temps de jeu | V1 (lot 8, 2026-09-04) |

> **Ajout (lot 8, 2026-09-04) — boutons dans la notification.** Une notification de serveur tombé propose **Démarrer** et **Console** ; un démarrage qui échoue propose **Console** seule (il faut d'abord lire). **Le panel décide, le service worker exécute** : les actions sont choisies et localisées côté panel, avec leur URL, et le worker ne fait qu'appeler ce qu'on lui donne — en n'acceptant que des chemins internes. L'appel part avec le cookie de session : un lecteur reçoit le même refus que dans l'interface, et le résultat (demandé / refusé) revient en notification, puisque celle d'origine a disparu au clic.

> **Ajout (lot 8, 2026-09-04) — heures calmes et silence par serveur.** Deux réglages **personnels** (chacun choisit ce qui fait sonner SON téléphone), qui ne touchent que le push : la cloche du panel garde tout, c'est l'historique. **Heures calmes** : une plage par compte (22 h → 7 h par défaut, la traversée de minuit est le cas normal), dans le fuseau du panel — celui des planifications, affiché sous le réglage. Pendant la plage, rien ne part sur le téléphone **sauf les urgences** : sévérité `error` et alertes (serveur tombé, machine hors ligne, disque plein, TPS effondré) — être silencieux la nuit ne doit pas vouloir dire apprendre au matin que le serveur est tombé à 23 h. **Silence par serveur** : un interrupteur sur la vue d'ensemble d'un serveur ; celui-là ne connaît pas d'exception (c'est un choix explicite, pas une plage horaire), et la page Compte liste les serveurs mis en silence pour les réactiver.

> **Ajout (lot 8, 2026-09-04) — statistiques de fréquentation.** `player_sessions` accumulait depuis toujours et n'était lue que comme un historique à plat. L'onglet Joueurs → **Statistiques** en tire, sur 7, 30, 90 ou 365 jours : joueurs distincts, connexions, temps de jeu total, record de joueurs simultanés (avec sa date), fréquentation et temps de jeu **par jour**, temps de jeu **par heure de la journée** (le graphique qui dit quand redémarrer sans gêner personne) et le classement des temps de jeu, badge « nouveau » compris. Une session à cheval sur minuit est répartie entre les deux journées ; une session en cours compte jusqu'à maintenant. Tout est calculé dans le fuseau du panel (celui des planifications, affiché sous les graphiques). Lecture pure : aucun appel à l'agent, aucune écriture, rien de publié hors du panel.

## 7. Backups

| Fonctionnalité | Portée |
|---|---|
| Backups manuels et planifiés, avec rotation automatique | V1 |
| Restauration en un clic | V1 |
| Restauration partielle : parcourir une archive sans l'extraire, restaurer un dossier ou un fichier (un monde seul, une région, `server.properties`), côte à côte par défaut — jamais d'écrasement sans le demander | V1 (lot 4, 2026-09-02) |
| Emplacement de stockage configurable (autre disque, NAS), rétention par serveur | V1 |
| **Copie hors-site** : chaque archive réussie copiée sur une autre machine du parc par la chaîne de migration (direct entre agents, relais du panel sinon, reprise, sha256), rétention propre à la copie, rapatriement quand l'original a disparu, rattrapage à la reconnexion de la destination | V1 (lot 4, 2026-09-02) |

## 8. Planificateur

| Fonctionnalité | Portée |
|---|---|
| Démarrage / arrêt / redémarrage programmés | V1 |
| Messages d'annonce en jeu avant un arrêt | V1 |
| Tâches personnalisées (commande planifiée) | V1 (livrée en phase 8 : action `command` du planificateur) |
| Exécution unique (« le [date] à [heure] », sans récurrence) | V1 (Planificateur v2, 2026-08-24) |
| Plusieurs horaires par jour dans une même planification | V1 (Planificateur v2, 2026-08-24) |
| Fréquences en langage simple, expression cron reléguée à un mode avancé replié | V1 (Planificateur v2, 2026-08-24) |

> **Planificateur v2 (livré 2026-08-24, premier développement post-1.0)** : constat de recette — « cron » et l'expression à étoiles sont du jargon inaccessible aux débutants, l'heure quotidienne était mal saisie, l'exécution unique et le multi-horaires manquaient. Livré : composant `ScheduleInput` commun au planificateur du serveur et aux politiques de sauvegarde — fréquences en français (« Tous les jours », « Certains jours de la semaine » à puces multi-jours, « Toutes les N heures », « Une seule fois », « Avancé »), sélecteurs natifs date/heure, plusieurs horaires par jour (planificateur seulement : plusieurs expressions cron, une par ligne — les politiques de sauvegarde restent à un horaire par politique, cron simple compris par tous les agents), « Prochaine exécution » mise en évidence et descriptions en langage simple dans les listes. Exécution unique : `runAt` côté serveur (voir doc 04 §5) ; manquée si le panel était éteint à l'heure prévue (tolérance 10 min), définitivement — badge « Manquée » explicite dans l'UI.

## 9. Utilisateurs et sécurité

| Fonctionnalité | Portée |
|---|---|
| Comptes multi-utilisateurs, rôles : administrateur / opérateur / lecture seule | V1 |
| Journal d'audit : qui a fait quoi, quand | V1 |
| Accès distant via réseau privé Tailscale (aucun port exposé sur Internet) | V1 |
| Permissions par serveur et par machine (restreindre un utilisateur à certains serveurs, ou à une machine entière) | V1 |
| Page de statut publique par serveur (lien non devinable, lecture seule, sans compte) | V1 |
| Demande de whitelist en libre-service depuis la page publique (l'opérateur accepte ou refuse) | V1 |

> **Ajout (lot 5, 2026-09-04) — qui a le droit de créer un serveur.** La question était le huitième chantier du lot 8 ; elle se tranche ici parce que c'est le lot 5 qui la pose. **Créer un serveur exige le rôle opérateur sur la MACHINE** : les routes vivent sous `/api/machines/:id`, donc la portée par machine s'y applique telle quelle, et une machine accordée couvre déjà ses serveurs présents **et futurs** — celui qu'on crée en est un. Un compte limité à des serveurs n'a aucun droit de création. Ce qui rend ce droit sûr : le chemin n'est pas libre — on choisit un **répertoire surveillé** et un **nom de dossier**, le panel compose le reste. **Adopter un dossier quelconque reste administrateur** (`POST /api/servers`), parce que cela ouvre un accès aux fichiers sur un chemin choisi librement : ce sont deux autorisations différentes, pas deux niveaux de la même.

> **Ajout (lot 8, 2026-09-03) — droits par serveur.** Un compte peut être **limité** (« Accès : serveurs choisis ») : il ne voit que les serveurs et machines qui lui sont accordés, chacun avec un rôle (lecture ou opérateur) plafonné par le rôle du compte ; une machine accordée couvre tous ses serveurs, présents et futurs ; un serveur accordé rend la page de sa machine lisible. Tout le reste lui est invisible — listes, temps réel, console, notifications, événements — et un serveur hors portée répond « introuvable », pas « interdit ». Un administrateur n'est jamais limité.

> **Ajout (lot 8, 2026-09-03) — clés d'API.** Chaque compte crée ses clés (page Compte : nom, rôle, expiration ; jeton `mmo_…` montré une fois, `Authorization: Bearer`). Le rôle effectif est le plus faible entre la clé et son propriétaire, et une clé d'un compte limité ne voit que ses serveurs : une clé n'élève jamais un compte, et suit sa rétrogradation, sa désactivation, sa suppression. Une clé ne gère ni compte, ni comptes, ni clés (routes réservées au cookie). Dernière utilisation (date, adresse) affichée ; révocation immédiate ; les administrateurs voient et révoquent toutes les clés (Réglages) ; audit `apikey.created/revoked`, et toute action faite par une clé est auditée au nom du compte ET de la clé.

> **Ajout (lot 8, 2026-09-03) — appareils connectés.** La page Compte liste les sessions du compte (navigateur résumé, adresse, dernière activité, « cet appareil ») ; chacune se déconnecte, ou toutes les autres d'un bouton — le geste quand on soupçonne un accès indésirable. La session d'un autre compte n'existe pas (404). Un administrateur peut déconnecter un compte de tous ses appareils (Réglages → Utilisateurs). Audit `auth.sessionRevoked`, `auth.sessionsRevoked`, `user.sessionsRevoked`.
> **Ajout (lot 8, 2026-09-03) — page de statut publique.** Chaque serveur peut publier une page en **lecture seule** sur un chemin non devinable (`/s/<jeton>`, 128 bits), activée explicitement, à donner à des amis : nom, état, adresse à copier, version, MOTD, nombre de joueurs, prochaine sauvegarde. Aucun compte, aucune action, aucun chemin disque, aucune machine, aucun identifiant interne — et **aucun pseudo sans opt-in** (case « Afficher les pseudos », décochée par défaut). Le résultat est mis en cache quelques secondes ; quand aucun agent ne tient la machine, le panel interroge le serveur lui-même (Server List Ping). Désactiver garde le lien, « Changer de lien » le tue sur-le-champ. Audit `server.statusPage` / `server.statusPageRotated` — jamais le jeton.

> **Ajout (lot 8, 2026-09-04) — demande de whitelist en libre-service.** Second opt-in de la page publique (« Accepter les demandes de whitelist », décoché par défaut) : le visiteur saisit son pseudo Minecraft et, s'il le veut, un mot pour le propriétaire. **La demande est inerte** — le panel range une ligne et prévient l'opérateur ; il n'interroge ni l'agent, ni Mojang, et n'écrit rien sur le serveur. La demande apparaît dans l'onglet Joueurs → Liste blanche, avec Accepter / Refuser : accepter exécute l'action whitelist existante (commande si le serveur tourne, fichier sinon) et ne marque la demande acceptée que si elle a réussi. Une ligne par (serveur, pseudo) : redemander ne crée pas de doublon et rend l'état de sa propre demande — c'est ainsi qu'un ami accepté apprend qu'il peut se connecter. Oublier une demande tranchée permet à la personne d'en refaire une. Limiteur public serré (dix par minute et par adresse), rien du visiteur n'est conservé. Audit `whitelist.accepted` / `whitelist.rejected` / `whitelist.requestDeleted` ; notification « Demande de whitelist reçue » (activée par défaut).


## 10. Notifications et événements

| Fonctionnalité | Portée |
|---|---|
| Bus d'événements interne (crash, joueur rejoint/quitte, backup terminé/échoué, TPS bas…) | V1 |
| Notifications push PWA (mobile et PC) | V1 |
| **Alertes à état** : serveur tombé, machine hors ligne, disque presque plein, TPS effondré — hystérésis, regroupement par dépendance, rappel espacé, retour à la normale notifié (2026-08-30) | V1 |
| **Réglage par catégorie ET par canal** : 21 catégories, chacune activable séparément pour la cloche du panel et pour le push (2026-08-31) | V1 |
| **Webhooks sortants** : salon Discord (embed coloré par sévérité) ou JSON signé HMAC pour n8n/Home Assistant, mêmes catégories que la cloche, garde SSRF, réessais bornés, santé notifiée (2026-09-02) | V1 |

> **Ajout (2026-09-02, lot 4) — webhooks sortants.** Réglages → Webhooks : un webhook = un genre (`discord` : embed coloré par sévérité, titre et corps localisés dans la langue du webhook, lien vers le panel ; `json` : l'événement brut plus le rendu, signé HMAC-SHA256 dans `x-mmo-signature`, secret montré une seule fois à la création et à la rotation), une langue, et ses **catégories** — les mêmes cases que la cloche et le push (`NOTIFICATION_TYPES`), pas un troisième catalogue. Garde SSRF à la saisie ET à chaque envoi (https seul, noms locaux/tailnet refusés, chaque adresse résolue contrôlée, adresse épinglée à la connexion — doc 03 §6) ; réessais bornés (1 s, 5 s, 30 s, `Retry-After` honoré) sur les seules réponses transitoires ; une file par webhook (un endpoint lent ne retarde ni les autres ni le push) ; santé sur la fiche (`fail_count`, `last_error`) et nouvelle catégorie `webhook.failed` — un événement par épisode, retour à la normale annoncé. Le bot Discord bidirectionnel reste écarté (CONTRIBUTING) : les webhooks sortants couvrent l'essentiel de la valeur sans connexion permanente à maintenir.

> **Ajout (2026-08-31) — notifications à la carte.** Le catalogue passe de 13 à 21 catégories : la moitié des événements du bus n'avait aucune case à cocher, donc ne pouvait ni notifier ni se régler — un problème remonté par une machine (EULA refusée, dossier non inscriptible, démarrage qui n'aboutit pas), une machine appairée, un serveur découvert, un serveur disparu, une tâche réussie, une planification exécutée, une action de modération. `resources` est séparée en disque et TPS. Surtout, chaque catégorie se règle **par canal** : la cloche du panel et le téléphone ne demandent pas la même chose — jusqu'ici, couper « joueur arrivé » pour ne pas être réveillé la nuit supprimait aussi l'historique de la cloche. Défauts : ce qui demande une intervention est activé, ce qui raconte la vie courante ne l'est pas (un premier scan sur cinquante serveurs en découvrirait cinquante d'un coup). Écran regroupé par thème — vingt interrupteurs en liste plate ne se lisent pas.

> **Ajout (2026-08-30) — vue de flotte.** Page `/servers` : liste plate de tous les serveurs, recherche (nom **et** chemin), filtres machine / loader / version / état, tri (nom, état, dernier démarrage, RAM allouée), le tout **persisté dans l'URL** — une vue se met en favori et se partage. Sélection multiple et **actions groupées séquentielles** : le garde-fou mémoire de l'agent compare `maxRamMb` à `total − réserve − somme des maxRamMb des serveurs déjà lancés` et se recalcule à chaque requête sans verrou, donc des démarrages parallèles passent tous la garde avant que le premier ne soit compté, ou s'effondrent en cascade de refus. Le panel enchaîne (`server.start` répond après le spawn, et un serveur en `starting` est déjà compté) et **s'arrête au premier refus** en disant lequel a bloqué et lesquels n'ont pas été tentés. Non réalisable en l'état : tri par TPS ou par joueurs connectés — ces valeurs ne sont pas dans le DTO serveur, elles ne transitent qu'en `metrics.sample`.

> **Ajout (2026-09-20) — cartes ou tableau, et mémoire d'appareil.** La barre de la page `/servers` devient un composant commun (`ListToolbar` : recherche, filtres de la page, tri, commutateur d'affichage) destiné à toutes les listes. Deux présentations : le **tableau** (plus de serveurs à l'écran, sélection en colonne) et les **cartes** (les actions Démarrer/Arrêter/Redémarrer sous le pouce, ce que réclame un téléphone) ; la sélection et les actions groupées marchent dans les deux. **Le filtre reste dans l'URL** (il se partage et se met en favori) mais l'**affichage et le tri sont mémorisés par APPAREIL** (`localStorage`, `mmo-list-<liste>`) : « le tableau sur le PC, les cartes sur le téléphone » est un besoin d'appareil, pas d'identité — rien ne part vers le panel. Arbitrage explicite quand les deux parlent : une URL qui porte un tri gagne (lien partagé, favori) ; sans tri dans l'URL, le panel reprend celui de la dernière visite. Une préférence illisible (mode inconnu, tri retiré du code, stockage refusé) retombe sur le défaut, champ par champ.
>
> La même barre et la même liste (`ServerCollection`, cartes ou tableau) servent le **tableau de bord** et la **page d'une machine** : recherche, commutateur, et sur la page machine le tri. Chaque liste a sa propre mémoire (`servers`, `machine-servers`, `dashboard-servers`) — régler l'une ne règle pas les autres. Sous `LIST_TOOLBAR_MIN` (4) serveurs, **aucune barre** : on voit déjà tout, une recherche serait du bruit. Une recherche qui ne trouve rien sur une machine efface sa carte du tableau de bord (c'est ce qu'on attend d'une recherche), mais une machine qui n'a aucun serveur garde la sienne (elle porte l'état de la machine).
>
> **Amendement (2026-10-01) — une seule liste de serveurs.** Principe : *une fonction = un seul endroit complet ; ailleurs, un raccourci qui y mène*. La page `/servers` est LA liste : **cartes par défaut** (mémoire d'appareil sous la clé `server-list` — l'ancienne clé `servers` enregistrait « tableau » sans qu'on l'ait choisi), avec « Créer un serveur » et « Ajouter une machine ». La **page d'une machine ne liste plus les serveurs** : elle en donne le nombre et renvoie à `/servers?machine=<id>` (la mémoire `machine-servers` disparaît). « Créer un serveur » est un bouton unique (`CreateServerButton`) partagé par le tableau de bord et la page Serveurs. La fenêtre « Ajouter une machine » enchaîne après le code d'appairage (`AfterPairing`) : attente de l'agent → dossier des serveurs → « Créer un serveur » → page du serveur, où se trouve Démarrer.
>
> **Amendement (2026-10-01) — suite de la passe UX.** (a) **Favoris** : une étoile (carte et tableau) épingle un serveur en tête de `/servers`, quel que soit le tri, et dans une section « Favoris » du tableau de bord — un favori n'est répété dans aucune autre section (schéma : doc 04). (b) **Carte serveur** : en plus de Démarrer/Arrêter, « Console » (lien `?tab=console`) et « Adresse » (copie l'adresse à donner aux amis, demandée au panel au clic par `GET /api/servers/:id/address`, avec repli `execCommand` hors contexte sécurisé). (c) **Une seule machine** : l'entrée de menu « Machines » disparaît pour l'admin et la page de la machine devient la section « Machine » des Réglages ; elle revient à la deuxième machine (les routes `/machines` restent valides). (d) **Réglages par besoin** : `?section=network|machine|backups|accounts|advanced`. (e) **Page serveur** : cinq onglets visibles (aperçu, console, joueurs, configuration, sauvegardes), les six autres sous un menu « Plus » dont le bouton porte le nom de l'onglet ouvert ; les URL `?tab=` ne changent pas.
>
> **Amendement (2026-10-02, 1.0.13) — pas de détour.** Règle : *ce qu'il faut pour finir un geste se trouve à l'endroit du geste ; un refus propose son remède ; un bouton indisponible reste visible et dit pourquoi.* Appliquée à huit parcours trouvés en relisant le code clic par clic : (1) page Serveurs : « Actualiser » (`ScanButton`, scan des répertoires surveillés des machines en ligne, ou de la machine filtrée) et « Ajouter un dossier serveur » (`AddExistingServerButton`) ; (2) zip par chemin (doc 06 §6sexies) ; (3) « Créer un serveur » ne disparaît plus : sans répertoire surveillé il demande le dossier sur place (`DirectoryForm`) puis ouvre l'assistant, agent hors ligne il est grisé avec la raison ; (4-7) démarrage refusé (`useStartRefusal`) : `E_EULA_REQUIRED` → fenêtre d'acceptation puis démarrage, `E_JAVA_UNAVAILABLE` → bouton d'installation du Java requis, `E_PORT_IN_USE` / `E_RAM_GUARD` → bouton vers les réglages du serveur, tout autre refus garde le message d'origine ; (8) mise à jour de l'agent annoncée sur le tableau de bord (`AgentUpdateBanner`). **Rejoindre** : `JoinStatus` affiche « Démarrage depuis … » puis « Prêt : on peut rejoindre le serveur à l'adresse … » (l'état `running` suit la ligne `Done (…)!` ou l'authentification RCON, doc 06 ; l'adresse n'est demandée que pour un serveur en marche) ; un port de jeu autre que 25565 est mis en avant sur la carte.
>
> **Amendement (2026-10-02, après 1.0.13) — audit précis, liens de l'aperçu, données sensibles.** (1) **Audit** : `server.configChanged` et `server.fileWritten` portent `changes` (`apps/panel/src/util/config-diff.ts`) — clés modifiées avec valeur avant → après pour un fichier clé=valeur, éléments ajoutés/retirés pour une liste JSON, lignes ajoutées/retirées pour un autre texte ; l'état d'avant est relu chez l'agent juste avant l'écriture ; une clé dont le nom contient `password`, `secret` ou `token` est masquée des deux côtés. Règle : *l'audit doit suffire à savoir ce qui a été fait, sans supposer*. (2) **Liens de l'aperçu** : une valeur réglable est un lien `?tab=<onglet>&focus=<nom>` vers son champ, que l'écran d'arrivée entoure d'un `FocusTarget` (défilement au centre, cadre et pulsation) — port de jeu et RCON vers Configuration, mémoire et redémarrage automatique vers Réglages. (3) **Deux ports** : `server-port` et `query.port` restent deux lignes éditables (rien de ce que permet le fichier n'est retiré) ; modifier `query.port` seul affiche un avertissement et un bouton vers le port de jeu. (4) **Port affiché** : `servers.game_port` suit `server-port` dès l'enregistrement si le serveur est arrêté ; en marche, il change au redémarrage (rapport d'état de l'agent). (5) **Données sensibles** : IP et adresses sont rendues par `Sensitive` (floues par défaut, un clic révèle, interrupteur d'en-tête retenu par navigateur dans `mmo.revealSensitive`) — adresse d'un serveur (carte, page, notification de copie, accès des joueurs), IP des sessions, de l'audit et des bannissements, adresses détectées d'une machine. Pas flouté : la page de statut publique (l'adresse y est le but), les champs de saisie, la console et les journaux. Ce n'est pas une protection, seulement un garde-fou contre le partage involontaire.
>
> **Amendement (2026-10-02, après 1.0.13, second lot) — tout enregistrer, machine hors ligne, sortir de Tailscale, pièges de configuration.** (1) **Tout enregistrer** (« la position de la souris, les clics dans le vide… Tout ») : le parcours UI (`ui_events`, doc 04 §7) gagne une colonne `data` (migration metrics `0002`) et les genres `move`, `scroll`, `key`, `input`, `toast`, `error`, `view` en plus de `click` (désormais aussi dans le vide, avec coordonnées et repère voisin) et `nav` (recherche `?tab=…` comprise) ; souris et défilement sont échantillonnés (1/s, seulement s'ils ont changé) ; un champ secret (type mot de passe, ou dont le nom, l'identifiant ou le libellé évoque `password`/`secret`/`token`/clé d'API/code d'appairage) ne livre que sa longueur ; une frappe dans un champ n'est pas enregistrée touche par touche, le champ l'est à sa validation. Les **refus** entrent dans l'audit : `request.refused` (méthode, motif de route, statut, code, détails) pour toute requête non GET rejetée, sauf l'envoi du parcours UI et la connexion (déjà `auth.loginFailed`) ; le corps de la requête n'est jamais recopié. Lecture croisée pour Ambre : `node tmp/audit-recent.mjs`. (2) **Machine hors ligne** (`OfflineNotice`, dans l'en-tête de machine) : « Hors ligne depuis … : l'agent se reconnecte tout seul » pendant deux minutes (`RECONNECT_GRACE_MS`, l'agent retentant au pire chaque minute, doc 05 §5), puis le remède (machine allumée ? agent lancé ? commande `Start-Service mmo-agent` sous Windows) ; rien pour une machine jamais appairée. (3) **Adresse du panel** : une seule règle, `installChoices` (`apps/panel/src/util/install-commands.ts`), pour la commande générique et celle du code d'appairage — `install` par l'adresse enregistrée (machine, sinon URL publique, sinon adresse consultée), `installHere` par l'adresse consultée quand elle diffère, avec `-Panel`/`--panel` explicite ; l'interface l'affiche dans un encadré (`InstallHereNotice`) qui rappelle qu'une adresse de bouclage ne vaut que sur la machine du panel. **Sortir de Tailscale** (`LeaveTailscale`, carte Accès distant) : proposé quand le mode est `tailscale` mais que la requête n'arrive pas par Tailscale ; après avoir montré les trois changements, règle `access.mode=manual`, `panel.publicUrl=<adresse consultée>`, `servers.defaultExposeMode=direct` et passe tous les serveurs en `direct`. (4) **Pièges de configuration** (`lib/properties-warnings.ts`) : un avertissement n'apparaît que si le réglage en cause vient d'être modifié — port déjà utilisé par un autre serveur de la machine, mode en ligne coupé, adresse d'écoute renseignée, nom du monde changé (un monde neuf serait créé), graine changée, mode de jeu sans « forcer » ; chacun peut porter un bouton vers le champ du remède. Rien n'est bloqué.
>
> **Filtre texte sur les listes qui ne sont pas des serveurs** : l'explorateur de **fichiers** filtre le dossier COURANT (un `mods/` réel en compte des centaines), et le filtre appartient à ce dossier — en ouvrir un autre l'efface, sinon un dossier plein passerait pour vide à cause d'un filtre oublié (`filter.dir === dir ? filter.q : ''`, sans effet de bord). L'onglet **Joueurs** porte un champ unique au-dessus des vues En ligne / Liste blanche / Opérateurs / Bannis / Historique (pseudo, et adresse pour les IP bannies) ; il TRAVERSE les vues, parce que « ce pseudo est-il en liste blanche, et est-il banni ? » est une seule question. Les statistiques n'ont pas de filtre (elles ne listent personne). Invariant commun : **une liste vidée par un filtre le dit** (`list.noMatch`) au lieu d'afficher le message « liste vide » — sinon on rajoute un joueur qui y est déjà.

## 11. Interface

| Fonctionnalité | Portée |
|---|---|
| PWA responsive : barre latérale sur PC, navigation basse sur mobile, installable | V1 |
| Thème sombre par défaut, thème clair disponible | V1 |
| Bilingue FR / EN | V1 |
| Dashboard : cartes serveurs groupées par machine, stats globales | V1 |
| Page serveur : onglets Console / Joueurs / Config / Backups / Stats / Fichiers | V1 |
| **Premiers pas guidés** : carte de 4 étapes auto-cochées sur le dashboard tant que le panel n'est pas prêt, avec la ligne « accès à distance » (2026-08-31) | V1 |
| **Aide contextuelle** : icône vers la section du guide dans la langue de l'interface (appairage, accès, URL publique, Java, sauvegardes) — table langue → chemin verrouillée par test contre les guides du dépôt (2026-08-31) | V1 |
| **Accessibilité** : un h1 par page (visuel inchangé via `size`), lien d'évitement, région live globale (connexion, agent hors ligne, état serveur), miroir console en `role="log"` ligne par ligne (2026-08-31) | V1 |
| Carte du monde en ligne | Futur |

## 12. Post-1.0 — ajouts livrés pendant la recette utilisateur (2026-08-24)

Compléments décidés et livrés au fil de la recette (`docs/guide/fr/recette.md`), hors périmètre initial mais actés dans les docs techniques :

| Ajout | Référence |
|---|---|
| Politique de sauvegarde par défaut à la création d'un serveur (quotidienne 04h00, 7 conservées, si en marche) + rattrapage unique pour l'existant | doc 04 §5 |
| Console : historique de `logs/latest.log` préchargé + téléchargement en un clic | doc 06 §3 |
| Parcours UI (clics/navigations) enregistré dans `metrics.db` pour la maintenance et le diagnostic, rétention 14 j | doc 04 §7 |
| Écrans Réglages → Utilisateurs et Journal d'audit (réalisation UI de fonctions V1 du §9 qui n'existaient que côté API) | — |
| Rechargement automatique du front quand un déploiement du panel invalide les chunks ouverts | — |
| Indicateur de fraîcheur du heartbeat machine, onglets défilants avec chevrons, pastille de notification effacée au clic, termes techniques Minecraft gardés en anglais en français (Kill, Seed, Whitelist, Spawn, PvP) | — |
