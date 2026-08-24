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
| Création d'un serveur depuis un modpack (CurseForge, FTB, Modrinth) | Futur |
| Mise à jour d'un serveur vers une nouvelle version de modpack | Futur |

## 3. Console et logs

| Fonctionnalité | Portée |
|---|---|
| Logs en temps réel (WebSocket), coloration par niveau | V1 |
| Envoi de commandes avec autocomplétion et historique | V1 |
| Recherche dans les logs, accès aux logs archivés | V1 |
| RCON en complément du stdin (parler à un serveur non lancé par l'application) | V1 |

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
| Emplacement de stockage configurable (autre disque, NAS), rétention par serveur | V1 |

## 8. Planificateur

| Fonctionnalité | Portée |
|---|---|
| Démarrage / arrêt / redémarrage programmés | V1 |
| Messages d'annonce en jeu avant un arrêt | V1 |
| Tâches personnalisées (commande planifiée) | Futur |
| Exécution unique (« le [date] à [heure] », sans récurrence) | Futur — Planificateur v2 |
| Plusieurs horaires par jour dans une même planification | Futur — Planificateur v2 |
| Fréquences en langage simple, expression cron reléguée à un mode avancé replié | Futur — Planificateur v2 |

> **Chantier « Planificateur v2 » (acté 2026-08-24, recette utilisateur)** : premier développement post-1.0. Constat de recette : « cron » et l'expression à étoiles sont du jargon inaccessible aux débutants, l'heure quotidienne est mal saisie, l'exécution unique et le multi-horaires manquent. Concerne le planificateur du serveur **et** les planifications de sauvegarde (même composant `CronInput`). « Prochaine exécution » reste visible pour tous.

## 9. Utilisateurs et sécurité

| Fonctionnalité | Portée |
|---|---|
| Comptes multi-utilisateurs, rôles : administrateur / opérateur / lecture seule | V1 |
| Journal d'audit : qui a fait quoi, quand | V1 |
| Accès distant via réseau privé Tailscale (aucun port exposé sur Internet) | V1 |
| Permissions par serveur (restreindre un utilisateur à certains serveurs) | Futur |

## 10. Notifications et événements

| Fonctionnalité | Portée |
|---|---|
| Bus d'événements interne (crash, joueur rejoint/quitte, backup terminé/échoué, TPS bas…) | V1 |
| Notifications push PWA (mobile et PC) | V1 |
| Webhooks / intégration Discord | Futur |

## 11. Interface

| Fonctionnalité | Portée |
|---|---|
| PWA responsive : barre latérale sur PC, navigation basse sur mobile, installable | V1 |
| Thème sombre par défaut, thème clair disponible | V1 |
| Bilingue FR / EN | V1 |
| Dashboard : cartes serveurs groupées par machine, stats globales | V1 |
| Page serveur : onglets Console / Joueurs / Config / Backups / Stats / Fichiers | V1 |
| Carte du monde en ligne | Futur |

## 12. Post-1.0 — ajouts livrés pendant la recette utilisateur (2026-08-24)

Compléments décidés et livrés au fil de la recette (`docs/guide/recette.md`), hors périmètre initial mais actés dans les docs techniques :

| Ajout | Référence |
|---|---|
| Politique de sauvegarde par défaut à la création d'un serveur (quotidienne 04h00, 7 conservées, si en marche) + rattrapage unique pour l'existant | doc 04 §5 |
| Console : historique de `logs/latest.log` préchargé + téléchargement en un clic | doc 06 §3 |
| Parcours UI (clics/navigations) enregistré dans `metrics.db` pour la maintenance et le diagnostic, rétention 14 j | doc 04 §7 |
| Écrans Réglages → Utilisateurs et Journal d'audit (réalisation UI de fonctions V1 du §9 qui n'existaient que côté API) | — |
| Rechargement automatique du front quand un déploiement du panel invalide les chunks ouverts | — |
| Indicateur de fraîcheur du heartbeat machine, onglets défilants avec chevrons, pastille de notification effacée au clic, termes techniques Minecraft gardés en anglais en français (Kill, Seed, Whitelist, Spawn, PvP) | — |
