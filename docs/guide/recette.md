# Recette 1.0 — tests de bout en bout (manuel, ~45 min)

But : vérifier que l'application est **utilisable en l'état** sur les parcours essentiels. Rien de compliqué : chaque étape = une action + le résultat attendu. Cochez au fur et à mesure ; notez tout écart (même cosmétique) avec l'étape concernée.

Environnement visé (déjà en place sur le poste de dev) : panel de test `D:\mmo-test\mmo-panel`, agent Windows en service (`mmo-agent`, LocalSystem), serveurs de test sous `D:\mmo-test\servers`. **Ne jamais pointer l'agent sur `E:\Minecraft\Server` directement — copies uniquement.**

## 0. Préparation

- [ ] Lancer le panel : double-clic sur `D:\mmo-test\start-panel.cmd` (fenêtre qui reste ouverte), puis ouvrir **http://127.0.0.1:3100**.
- [ ] Connexion : `admin` / `Mmo-Test-2026!`. Attendu : tableau de bord, machine **PC-Windows en ligne**, agent 1.0.0.
- Pour tester depuis le téléphone (optionnel, §8) : dans `start-panel.cmd`, remplacer `MMO_HOST=127.0.0.1` par `MMO_HOST=0.0.0.0`, relancer, puis ouvrir `http://<IP LAN du PC>:3100` — le panel est alors visible sur tout le réseau local (protégé par mot de passe).

## 1. Machine et tableau de bord

- [ ] La carte machine affiche CPU/RAM/disque qui bougent (rafraîchissement ~15 s).
- [ ] La machine `WSL-Ubuntu` apparaît **hors ligne** (normal : WSL désinstallé) — la supprimer via son menu, elle ne doit plus revenir.

## 2. Détection d'un nouveau serveur

- [ ] Copier un serveur de plus (une **copie** depuis `E:\Minecraft\Server`, léger de préférence — un Vanilla ou Fabric) dans `D:\mmo-test\servers\`.
- [ ] Attendu : le serveur apparaît dans la liste — sous ~5 min (scan périodique) ou tout de suite via le bouton de scan de la page machine — avec loader/version MC/RAM détectés plausibles.

## 3. Cycle de vie du serveur

- [ ] Démarrer `vanilla-1.20.1` s'il est arrêté (sinon le nouveau) ; suivre l'état `starting` → `running`, PID affiché.
- [ ] Console : les lignes du serveur défilent ; envoyer `say bonjour` → visible dans la console.
- [ ] Arrêt propre : état `stopping` → `stopped`, pas de processus java orphelin (vérifier au Gestionnaire des tâches).
- [ ] Redémarrer le serveur (bouton restart) : repasse `running`.
- [ ] Robustesse : tuer le processus java **brutalement** (Gestionnaire des tâches) → le panel doit passer le serveur en arrêté/crashé (et le relancer seulement si le redémarrage auto est activé).
- [ ] Survie à l'agent : serveur `running`, puis redémarrer le service `mmo-agent` (`services.msc`, admin) → le serveur Java **ne tombe pas**, il est ré-adopté (même PID) et la console repasse en RCON (mode détaché : stdin perdu jusqu'au prochain restart du serveur — attendu).

## 4. Fichiers

- [ ] Explorateur de fichiers du serveur : naviguer, ouvrir/éditer `server.properties` (ex. changer le MOTD), sauvegarder.
- [ ] Téléverser un petit fichier, le retélécharger, le supprimer (corbeille).
- [ ] Après restart du serveur : le nouveau MOTD est pris en compte.

## 5. Sauvegardes

- [ ] Lancer une sauvegarde manuelle du serveur → archive listée avec taille/date.
- [ ] Modifier un fichier (ou en supprimer un), puis **restaurer** la sauvegarde (serveur arrêté) → le fichier revient.
- [ ] Créer une planification (ex. toutes les heures, rétention 3) → une exécution part à l'heure prévue (ou vérifier simplement qu'elle est enregistrée et affichée).
- [ ] Réglages → Sauvegardes du panel : lancer une sauvegarde du panel → fichier créé, listé.

## 6. Métriques et joueurs

- [ ] Onglet métriques du serveur : CPU/RAM du processus, TPS (après quelques minutes de jeu réel), graphiques qui avancent.
- [ ] Optionnel (nécessite un client Minecraft) : se connecter au serveur (`localhost:25565`) → événement de connexion + liste des joueurs à jour ; se déconnecter → idem.

## 7. Planificateur et réglages

- [ ] Créer une tâche planifiée simple (ex. `announce` ou `restart` dans 5 min) → elle s'exécute à l'heure dite (visible en console/état).
- [ ] Créer un second utilisateur **non-admin**, se connecter avec dans une fenêtre privée : il voit les serveurs mais pas les réglages d'administration.
- [ ] Basculer la langue FR ↔ EN et le thème sombre ↔ clair : toute l'UI suit, pas de chaîne brute.
- [ ] Journal d'audit (Réglages) : les actions faites ci-dessus y figurent (démarrages, sauvegarde, création d'utilisateur…).

## 8. Optionnel — mobile / PWA

- [ ] Depuis le téléphone (voir §0) : l'UI est utilisable (navigation, console lisible, boutons accessibles), « Ajouter à l'écran d'accueil » fonctionne.

## Si quelque chose casse

- Panel : sortie visible dans la fenêtre de `start-panel.cmd` (+ `D:\mmo-test\panel-data\`).
- Agent : `C:\Users\Yassin\AppData\Local\Programs\mmo-agent\launcher.log` et `logs\shawl_for_mmo-agent_rCURRENT.log` ; état : `C:\Users\Yassin\AppData\Local\mmo-agent\agent-state.json`.
- Redémarrer le service agent : `services.msc` (admin) → `mmo-agent` → Redémarrer.
- Noter : étape, action, attendu vs obtenu, heure (pour croiser avec les logs).
