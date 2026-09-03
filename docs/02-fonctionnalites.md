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
| Gestion des ports : affichage, modification, détection de conflit par machine avant lancement | V1 |
| Acceptation guidée de l'EULA | V1 |
| États de provisionnement (en installation / prêt / archivé) | V1 |
| Groupes de démarrage : démarrage séquentiel par rang en attendant l'état « en marche », arrêt en ordre inverse, série interrompue au premier échec | V1 (post-1.0, 2026-09-01) |
| Proxy Velocity reconnu au scan (`velocity.toml`) et pilotable : lancement `jar` sans `nogui`, console stdin, arrêt `shutdown`, pas d'EULA ni de RCON | V1 (post-1.0, 2026-09-01) |
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
| Statistiques : historique de fréquentation, temps de jeu | Futur |

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

> **Ajout (lot 8, 2026-09-03) — droits par serveur.** Un compte peut être **limité** (« Accès : serveurs choisis ») : il ne voit que les serveurs et machines qui lui sont accordés, chacun avec un rôle (lecture ou opérateur) plafonné par le rôle du compte ; une machine accordée couvre tous ses serveurs, présents et futurs ; un serveur accordé rend la page de sa machine lisible. Tout le reste lui est invisible — listes, temps réel, console, notifications, événements — et un serveur hors portée répond « introuvable », pas « interdit ». Un administrateur n'est jamais limité.

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
