# Fiche de test — panel 1.0.7 + chantiers non publiés (septembre 2026)

> **Document interne de test** : ce parcours est écrit pour l'installation de production du poste de développement (`E:\mmo-panel`) — ce n'est **pas** un guide d'utilisation. Pour installer et utiliser l'application, voir [Installation](installation.md) et [Ajouter une machine](ajouter-une-machine.md).

Périmètre : **tout ce qui est dans le dépôt aujourd'hui**, c'est-à-dire la 1.0.7 publiée plus les chantiers non publiés des lots 9, 4, 8 et la première moitié du lot 5 (section « Unreleased » du CHANGELOG). Chaque étape = **une action → le résultat attendu**. Cochez au fur et à mesure ; notez tout écart, même cosmétique, avec le numéro de l'étape et l'heure (pour croiser avec les journaux).

Compter **5 à 6 h** pour tout dérouler ; les étapes marquées _(optionnel)_ ou _(matériel : …)_ peuvent être sautées sans casser la suite.

## Environnement

| Quoi                        | Où                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Panel (code)                | `E:\mmo-panel\mmo-panel-1.0.7\` (archive construite depuis `main`, version affichée 1.0.7)                                       |
| Panel (données)             | `E:\mmo-panel\mmo-panel-1.0.7\data\` — `mmo.db`, `metrics.db`, `logs\`, `backups\panel\`, `releases\`                            |
| Journal du panel            | `E:\mmo-panel\mmo-panel-1.0.7\data\logs\panel-<date>.log` (NDJSON — lisible en console si lancé depuis un terminal)              |
| Icône près de l'horloge     | `E:\mmo-panel\mmo-panel-1.0.7\app\install\mmo-panel-tray.ps1`                                                                    |
| Adresse locale / publique   | `http://127.0.0.1:3000` / `https://<votre-nom>.ts.net` (Tailscale `serve`)                                                       |
| Agent (service `mmo-agent`) | `%LOCALAPPDATA%\Programs\mmo-agent\` — `launcher.log` à la racine, `logs\shawl_for_mmo-agent_rCURRENT.log`                       |
| Agent (état + journal)      | `%LOCALAPPDATA%\mmo-agent\agent-state.json`, `%LOCALAPPDATA%\mmo-agent\logs\agent-<date>.log`                                    |
| Répertoire surveillé        | `E:\Minecraft\Server` (54 vrais serveurs adoptés)                                                                                |
| Anciennes versions          | `E:\mmo-panel\mmo-panel.old\`, `E:\mmo-panel\mmo-panel-1.0.5-win-x64\`, `E:\mmo-panel\mmo-panel-sauvegarde-avant-demenagement-…` |

**Règle sur les vrais serveurs** : les 54 serveurs de `E:\Minecraft\Server` ne servent qu'à **regarder** (liste, statistiques, métriques d'un serveur que vous démarrez vous-même). Tout ce qui écrit, restaure, duplique, supprime ou réinstalle se fait sur les **serveurs de test créés au bloc 4** (`test-vanilla`, `test-fabric`).

## 0. Avant de commencer

- [ ] **0.1** Le fichier `E:\mmo-panel\mmo-panel-1.0.7\start-panel.cmd` pointe encore vers `E:\mmo-panel\data`, qui n'existe plus depuis le déplacement : lancé tel quel, le panel créerait une **base vide** et afficherait l'assistant de premier démarrage. Le réécrire (PowerShell) :

  ```powershell
  Set-Content -LiteralPath 'E:\mmo-panel\mmo-panel-1.0.7\start-panel.cmd' -Encoding ascii -Value @'
  @echo off
  rem MinecraftManagerOnline - lanceur du panel. Donnees dans .\data (defaut de mmo-panel.cmd).
  setlocal
  set "MMO_HOST=127.0.0.1"
  set "MMO_PORT=3000"
  call "%~dp0mmo-panel.cmd" %*
  '@
  ```

  Attendu : le fichier ne contient plus de ligne `MMO_DATA_DIR` ; `mmo-panel.cmd` retombe alors sur `<dossier>\data`, qui est le bon.

- [ ] **0.2** Panel arrêté, ouvrir un terminal dans `E:\mmo-panel\mmo-panel-1.0.7\` et lancer `mmo-panel.cmd doctor`. Attendu : chaque ligne verte (runtime, `node:sqlite`, argon2, écriture réelle dans `data\`, `quick_check` de la base, port 3000 libre, front).
- [ ] **0.3** Lancer le panel **depuis ce même terminal** : `start-panel.cmd`. Attendu : des lignes lisibles du type `22:49:09 INFO  panel ready users=1 dataDir=E:\mmo-panel\mmo-panel-1.0.7\data` (plus de JSON brut avec `pid`/`hostname`) ; le fichier `data\logs\panel-<date>.log` reçoit, lui, du NDJSON.
- [ ] **0.4** Ouvrir `http://127.0.0.1:3000` et se connecter. Attendu : **pas** d'assistant de premier démarrage ; tableau de bord avec la machine du PC **en ligne** et les 54 serveurs ; `http://127.0.0.1:3000/api/health` répond `"version":"1.0.7"` et `"driver":"node:sqlite"`.
- [ ] **0.5** Fermer le terminal (Ctrl+C), puis relancer par l'icône : `powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "E:\mmo-panel\mmo-panel-1.0.7\app\install\mmo-panel-tray.ps1"`. Attendu : aucune fenêtre, icône près de l'horloge ; clic gauche → le navigateur s'ouvre sur le panel ; clic droit → Ouvrir / Journaux / Démarrer / Arrêter / Redémarrer / Démarrer avec Windows / Quitter ; « Journaux » ouvre `data\logs\`.
- [ ] **0.6** Clic droit → « Démarrer avec Windows ». Attendu : `MinecraftManagerOnline.lnk` apparaît dans `shell:Startup` ; décocher le retire.
- [ ] **0.7** Ouvrir `https://<votre-nom>.ts.net`. Attendu : même panel ; Réglages → Accès distant indique « Cette requête est passée par tailscale serve ».

## 1. Agent : passer de 1.0.5 à 1.0.7

Contexte : l'agent du PC est une **build release 1.0.5** ; le bundle 1.0.7 embarqué par ce panel est signé avec la **clé de développement** (Réglages → Distribution de l'agent l'affiche). Une build release n'accepte que la clé de release : « Mettre à jour l'agent » sera **refusé proprement**. Le chemin pour cette fois est la réinstallation par la commande d'installation, qui garde l'appairage. Toutes les nouveautés côté agent (créer un serveur, restauration partielle, copie hors-site, fichier de diagnostic, coût du processus agent, journal fichier) exigent la 1.0.7.

- [ ] **1.1** Machines → le PC → carte **Agent**. Attendu : « Version de l'agent 1.0.5 », « Dernière release 1.0.7 », mention « mise à jour 1.0.7 disponible ».
- [ ] **1.2** _(optionnel)_ Cliquer « Mettre à jour l'agent ». Attendu : refus propre (signature) — notification « Agent mis à jour ou annulé », l'agent reste en 1.0.5 **et reste en ligne**, aucun serveur touché. Si l'agent tombe hors ligne durablement, noter.
- [ ] **1.3** Réglages → Distribution de l'agent → copier la commande **Windows** (sans code d'appairage) → la coller dans un **PowerShell administrateur**. Attendu : « arrêt du service mmo-agent », téléchargement de `mmo-agent-1.0.7-win-x64.zip` depuis le panel, « service mmo-agent installé et démarré », **sans** redemander de code d'appairage.
- [ ] **1.4** Page machine. Attendu : agent **en ligne** en moins d'une minute, « Version de l'agent 1.0.7 », les 54 serveurs toujours là, aucun doublon, aucun conflit de marqueur sur le tableau de bord.
- [ ] **1.5** Carte Agent → « Processus agent ». Attendu : « X Mio · Y % » qui se rafraîchit (mémoire et CPU de l'agent lui-même).
- [ ] **1.6** Carte Agent → « Fichier de diagnostic ». Attendu : téléchargement de `mmo-agent-<machine>-<date>.txt` ; à l'intérieur : version, système, serveurs **sans** votre nom d'utilisateur dans les chemins (`C:\Users\<user>`), aucune valeur de jeton, les 200 dernières lignes du journal de l'agent.
- [ ] **1.7** `%LOCALAPPDATA%\mmo-agent\logs\`. Attendu : un fichier `agent-<date>.log` qui grossit (même contenu que la sortie du service).

## 2. Tableau de bord, flotte, palette, aide

- [ ] **2.1** Tableau de bord. Attendu : compteurs Machines / Serveurs / En marche / Joueurs, « Événements récents » ; **pas** de carte « Premiers pas » (les quatre étapes sont faites) ; **pas** de carte « Conflits de marqueur » ; **pas** de bandeau « La version X est disponible » (1.0.7 est la dernière publiée).
- [ ] **2.2** Serveurs (vue de flotte). Attendu : les 54 serveurs, filtres Machine / Loader / Version / État, tri (Nom, État, Dernier démarrage, RAM allouée), recherche « Nom ou dossier » ; les filtres se retrouvent dans l'URL (recharger la page les garde).
- [ ] **2.3** Ctrl+K → taper le nom exact d'un serveur (ex. `ATM10Aero`). Attendu : la palette propose **ce** serveur (pas un voisin approximatif), Entrée ouvre sa page ; les machines et les actions (démarrer, arrêter…) y figurent aussi.
- [ ] **2.4** Sur une carte qui porte un « ? » (Sauvegardes, Accès distant, Page de statut, Clés d'API, Créer un serveur…), cliquer le lien d'aide. Attendu : le guide **français** s'ouvre sur la bonne section (ancre), en anglais si la section n'existe qu'en anglais.
- [ ] **2.5** Compte → Profil : basculer Langue FR ↔ EN et Thème sombre ↔ clair. Attendu : toute l'interface suit, aucune chaîne brute (`server.tabs.x`), la cloche et les toasts compris.
- [ ] **2.6** Clavier seul : Tab depuis le haut de page. Attendu : premier arrêt sur « Aller au contenu », puis navigation, cartes et onglets atteignables ; Réglages → Journal d'audit et Utilisateurs défilent au clavier.

## 3. Page machine

- [ ] **3.1** Carte machine (tableau de bord et page machine). Attendu : CPU / RAM / Disque qui bougent, « Mis à jour à l'instant / il y a X s » sous les jauges (~15 s).
- [ ] **3.2** Répertoires surveillés → « Scanner maintenant ». Attendu : « 54 serveur(s) détecté(s) dans 1 chemin(s) », aucun conflit, « Dernier scan » à l'instant.
- [ ] **3.3** Runtimes Java. Attendu : la liste des JVM de la machine (gérées et système) avec la colonne « Serveurs » qui les utilisent ; « Installer » propose un runtime manquant (ne pas installer si rien ne manque).
- [ ] **3.4** « Nouveau code d'appairage » → modale. Attendu : code `MMOP-…` affiché une fois, commandes Windows / Linux-macOS **avec** le code, sélecteur « Adresse du panel pour cette machine » (Défaut — https://…) ; changer l'adresse régénère les commandes. Fermer sans rien installer.
- [ ] **3.5** Carte « Adresses pour les joueurs ». Attendu : hôte tailnet détecté (nom MagicDNS / 100.x), champ « Hôte public » vide = détecté par l'agent.

## 4. Créer des serveurs de test (lot 5)

- [ ] **4.1** Page machine → « Créer un serveur ». Attendu : assistant en 4 écrans (Emplacement, Version, Ressources, Vérification).
- [ ] **4.2** Emplacement : répertoire `E:\Minecraft\Server`, nom du dossier `test-vanilla`. Attendu : « Dossier qui sera créé : E:\Minecraft\Server\test-vanilla » composé en direct ; un nom avec accent ou `/` est refusé (« Nom de dossier invalide »).
- [ ] **4.3** Version : Vanilla, choisir la **dernière 1.21.x** stable. Attendu : plusieurs centaines de versions (liste Mojang), les snapshots marqués « instable ».
- [ ] **4.4** Ressources : mémoire 2048 Mio, MOTD `Test MMO`, port laissé tel quel. Attendu : un port de jeu **proposé automatiquement**, libre sur la machine.
- [ ] **4.5** Vérification. Attendu : récapitulatif + pré-contrôles (dossier, port, Java, disque) sans problème ; la case EULA est **décochée** et le bouton « Créer le serveur » **désactivé** tant qu'elle l'est.
- [ ] **4.6** Cocher l'EULA → « Créer le serveur ». Attendu : navigation immédiate vers la page du serveur, bandeau « en cours d'installation », la tâche visible dans « Tâches en cours » (téléchargement ~56 Mio, sha1 vérifié), puis le serveur passe **arrêté / prêt** en moins de 2 min.
- [ ] **4.7** Fichiers du nouveau serveur (onglet Fichiers ou explorateur Windows). Attendu : `server.jar`, `eula.txt` (`eula=true`), `server.properties` (MOTD et port choisis), `.mmo-server.json` ; **pas** de dossier `world` (rien n'a démarré).
- [ ] **4.8** Recommencer avec `test-fabric`, loader **Fabric**, une 1.21.x. Attendu : liste des versions supportées par Fabric (moins nombreuse que Mojang) ; installation en moins de 2 min ; dossier avec `libraries\`, `versions\`, `.fabric\`, `mods\` — et toujours **pas** de `world`.
- [ ] **4.9** Refus : créer à la main `E:\Minecraft\Server\test-occupe\note.txt`, puis lancer l'assistant avec le nom `test-occupe`. Attendu : l'écran Vérification signale « Le dossier existe déjà et n'est pas vide » ; en créant quand même, erreur immédiate, **aucun serveur fantôme** dans la liste, `note.txt` intact.
- [ ] **4.10** Dashboard → aucun « Conflit de marqueur » après un nouveau scan (les chemins écrits par le panel et par le scanner se reconnaissent, `\` ou `/`).
- [ ] **4.11** _(optionnel)_ Couper le réseau pendant le téléchargement d'un troisième serveur `test-panne`. Attendu : tâche échouée, serveur en **installation échouée** avec le message « L'installation a échoué. Reprenez-la, ou supprimez le serveur », bouton « Reprendre l'installation » ; réseau rétabli → reprise du téléchargement là où il s'était arrêté → serveur prêt. Puis « Oublier ce serveur » et supprimer le dossier.

## 5. Cycle de vie (sur `test-vanilla`)

- [ ] **5.1** Démarrer. Attendu : `starting` → `running` en ~30 s (premier démarrage = génération du monde), PID affiché, Aperçu → RCON avec un port **auto-provisionné** (25575–25675), console qui affiche « Done ».
- [ ] **5.2** Arrêter (avec une annonce dans « Annonce aux joueurs »). Attendu : `stopping` → `stopped`, « Dernière sortie : arrêt propre », plus de `java.exe` dans le Gestionnaire des tâches.
- [ ] **5.3** Redémarrer. Attendu : `running` à nouveau, nouveau PID.
- [ ] **5.4** Kill (bouton). Attendu : confirmation « Kill le processus ? », puis `stopped` avec « Dernière sortie : tué ».
- [ ] **5.5** Démarrer, puis tuer `java.exe` **depuis le Gestionnaire des tâches**. Attendu : état **plantage** (« Dernière sortie : plantage »), événement Watchdog ; redémarrage auto désactivé (Réglages du serveur) → il reste arrêté ; activé → il redémarre (tentative 1).
- [ ] **5.6** Survie à l'agent : serveur `running`, puis `services.msc` (admin) → `mmo-agent` → Redémarrer. Attendu : le processus Java **ne tombe pas**, même PID après ré-adoption, la console fonctionne en RCON (attachement « détaché » jusqu'au prochain redémarrage du serveur — normal).
- [ ] **5.7** EULA : sur `test-fabric`, éditer `eula.txt` → `eula=false`, Démarrer. Attendu : refus avec la carte « EULA Minecraft » ; cocher « J'ai lu et j'accepte » → « Accepter et continuer » → démarrage.

## 6. Console

- [ ] **6.1** `test-vanilla` en marche, onglet Console. Attendu : les lignes défilent ; bascule « Direct » / « Historique (logs/latest.log) » — l'historique montre la fin de `latest.log` préchargée.
- [ ] **6.2** Envoyer `say bonjour`. Attendu : ligne visible dans la console ; ↑ rappelle la commande ; Tab complète `gamem` → `gamemode`.
- [ ] **6.3** Taper `gamemode ` (avec l'espace). Attendu : l'aperçu des formes de la commande apparaît sous le champ (`gamemode <mode> [<targets>]`…), avec l'origine (« découverte sur le serveur » après le balayage, « liste générique » avant).
- [ ] **6.4** Macros → « Nouvelle macro » : nom `Soir`, commandes `time set night` et `say bonne nuit`, « Sur ce serveur seulement ». Attendu : la macro s'exécute dans l'ordre, message « « Soir » exécutée (2 commande(s)) ».
- [ ] **6.5** Macro `Stop test` avec la commande `stop`. Attendu : à l'exécution, confirmation « Exécuter « Stop test » ? … arrête, bannit ou détruit » ; « Exécuter quand même » arrête le serveur.
- [ ] **6.6** Bouton « Télécharger logs/latest.log ». Attendu : le fichier se télécharge.

## 7. Configuration, fichiers, journaux, événements, réglages du serveur

- [ ] **7.1** Configuration : changer le MOTD (catégorie Général). Attendu : « 1 changement(s) en attente » → Enregistrer → « Configuration enregistrée » ; serveur en marche → « Le serveur tourne : redémarrez-le » + « Redémarrer maintenant » ; après redémarrage, le nouveau MOTD est lu (Aperçu ou page de statut).
- [ ] **7.2** Configuration : les clés RCON sont « Géré par MMO » ; « Autres clés » vide pour un vanilla ; « Éditer le fichier brut » ouvre l'éditeur texte.
- [ ] **7.3** Fichiers : « Nouveau dossier » `essai`, « Envoyer un fichier » (un petit `.txt`), le télécharger, le renommer, le dupliquer, « Mettre à la corbeille ». Attendu : chaque action confirmée par un toast, le message de corbeille donne le chemin.
- [ ] **7.4** Fichiers : ouvrir `server.properties` dans l'éditeur, le modifier **aussi** dans le Bloc-notes et enregistrer là, puis Enregistrer dans le panel. Attendu : « Le fichier a changé sur le disque depuis son ouverture. Rechargez-le ».
- [ ] **7.5** Journaux : rechercher `Done` sur « Tous les fichiers ». Attendu : résultats avec fichier + ligne ; la recherche s'exécute sur la machine.
- [ ] **7.6** Événements : la liste du serveur contient les démarrages/arrêts, le plantage et l'action de watchdog du bloc 5.
- [ ] **7.7** Réglages (onglet du serveur) : Nom affiché `Test vanilla`, RAM min 1024 / max 2048, redémarrage auto. Attendu : « Réglages enregistrés », nom mis à jour partout (liste, palette).
- [ ] **7.8** Aperçu → menu → « Oublier ce serveur » (annuler la confirmation). Attendu : le texte dit que rien n'est supprimé sur le disque. Ne pas confirmer maintenant.

## 8. Joueurs

- [ ] **8.1** Joueurs → Whitelist → « Ajouter un joueur » avec un vrai pseudo Mojang (le vôtre). Attendu : « Recherche de l'UUID… » puis « compte Mojang », avatar chargé ; serveur en marche → « Appliqué à chaud ».
- [ ] **8.2** « Activer la whitelist ». Attendu : bandeau « Whitelist activée — seuls les joueurs listés peuvent se connecter ».
- [ ] **8.3** Opérateurs : nommer le même pseudo opérateur. Attendu : ligne avec niveau ; serveur en marche → avertissement « niveau par défaut appliqué à chaud ».
- [ ] **8.4** Bannis : bannir un pseudo inventé (`TestBanni_1`) avec une raison ; « Bannir une adresse IP » `203.0.113.7`. Attendu : deux listes séparées (Joueurs bannis / Adresses IP bannies), « Débannir » les retire.
- [ ] **8.5** Réglages → Vie privée → **désactiver** « Résoudre les pseudos chez Mojang », puis ajouter à la whitelist un pseudo inconnu. Attendu : aucune recherche Mojang (« compte inconnu » / UUID mode hors ligne) ; réactiver ensuite.
- [ ] **8.6** Réglages → Vie privée → **désactiver** « Charger les avatars depuis mc-heads.net ». Attendu : initiales à la place des têtes, aucune requête vers mc-heads (onglet Réseau du navigateur) ; réactiver.
- [ ] **8.7** Historique et Statistiques sur **ATM10Aero** (il a de l'historique). Attendu : sessions passées ; Statistiques 7 / 30 / 90 / 365 j : totaux (joueurs, connexions, temps de jeu « 1 h 30 » non arrondi, record simultané), courbe par jour, **histogramme des 24 heures**, top 10, mention « Heures locales du panel (Europe/Paris) ».
- [ ] **8.8** _(matériel : client Minecraft)_ Se connecter à `test-vanilla` (adresse de la carte « Accès des joueurs »). Attendu : « En ligne » liste le joueur, événement « Joueur connecté », « Expulser » fonctionne, la déconnexion crée une ligne d'historique avec durée.

## 9. Métriques

- [ ] **9.1** `test-vanilla` en marche depuis 5 min → Métriques. Attendu : CPU (% d'un cœur), Mémoire (RSS), **TPS** (source « via /tick query »), Joueurs ; plages 1 h → 30 j ; « Moyennes par minute » au-delà de l'heure.
- [ ] **9.2** `test-fabric` en marche → Métriques. Attendu : « TPS indisponible — Fabric n'a pas de commande TPS intégrée » et le bouton « Installer spark en un clic ».
- [ ] **9.3** Cliquer « Installer spark en un clic ». Attendu : tâche « Téléchargement » (reprise possible), puis « spark est installé (…) » ; après redémarrage du serveur, TPS « via spark ».
- [ ] **9.4** Machine → graphiques « CPU de la machine » / « Mémoire de la machine » cohérents avec le Gestionnaire des tâches.

## 10. Planificateur

- [ ] **10.1** Planificateur → « Programmer une action » : **Une seule fois**, dans 3 min, action **Commande** `say planif ok`. Attendu : « Prochaine exécution : … » affichée, puis à l'heure dite la ligne apparaît dans la console ; badge « Exécutée », interrupteur masqué.
- [ ] **10.2** « Tous les jours » avec **deux horaires** (08:00 et 20:30), action Redémarrer, avertissements `10, 5, 1`. Attendu : « Prochaine exécution » = le plus proche des deux ; la liste décrit « Tous les jours à 08:00 et 20:30 » (jamais d'expression cron affichée).
- [ ] **10.3** « Certains jours de la semaine » (Sam + Dim) et « Toutes les N heures ». Attendu : formulaires sans mot « cron » ; « Avancé (expression cron) » l'affiche, lui.
- [ ] **10.4** Ligne « Horaires lus dans Europe/Paris ». Attendu : orange seulement si le fuseau du navigateur diffère ; Réglages → Général → « Fuseau des planifications » montre le même fuseau.
- [ ] **10.5** _(optionnel, 15 min)_ Programmer une action unique dans 3 min, **quitter le panel** (icône → Quitter), attendre 15 min, relancer. Attendu : badge « Manquée » + « le panel était éteint à l'heure prévue », l'action n'est **pas** exécutée en retard.

## 11. Sauvegardes

- [ ] **11.1** `test-vanilla` → Sauvegardes → « Sauvegardes planifiées ». Attendu : une politique **par défaut** (tous les jours à 04:00, garde les 7 dernières, seulement si le serveur tourne). Si elle manque pour un serveur créé par l'assistant : **écart à noter**.
- [ ] **11.2** Serveur **arrêté** → « Créer une sauvegarde » (commentaire `froid`). Attendu : mention « sauvegarde à froid », phases (Préparation → Inventaire → Archivage → Vérification), archive listée Manuelle / taille / OK / « Pas encore vérifiée ».
- [ ] **11.3** Serveur **en marche** → « Créer une sauvegarde » (commentaire `chaud`). Attendu : « à chaud », aucune coupure pour les joueurs, archive listée avec la pastille « à chaud ».
- [ ] **11.4** Réglages → Général → « Destination de sauvegarde par défaut » = `E:\mmo-panel\sauvegardes-serveurs` (créer le dossier vide avant) → Enregistrer. Attendu : en quelques secondes le fichier **`.mmo-backups.json`** apparaît à la racine de ce dossier.
- [ ] **11.5** Nouvelle sauvegarde manuelle. Attendu : l'archive est écrite **sous cette destination** (sous-dossier du serveur).
- [ ] **11.6** Supprimer `.mmo-backups.json` puis relancer une sauvegarde. Attendu : échec **avant tout écrit** avec un message qui nomme le marqueur (destination non marquée) ; recréer un fichier vide de ce nom → la sauvegarde suivante passe.
- [ ] **11.7** « Télécharger » une archive. Attendu : `.tar.gz` téléchargé via le panel.
- [ ] **11.8** Restauration complète : supprimer `E:\Minecraft\Server\test-vanilla\world\level.dat` (serveur arrêté), puis « Restaurer » l'archive `froid` avec « Sauvegarde de sécurité » et « Redémarrer après » cochés. Attendu : confirmation explicite, archive « Sécurité (avant restauration) » créée d'abord, `level.dat` de retour, serveur relancé.
- [ ] **11.9** « Restaurer des fichiers… » → cocher `world` → « À côté des fichiers actuels ». Attendu : lecture de l'archive (arbre avec tailles), un dossier **`restored-<date>`** à la racine du serveur (onglet Fichiers), le serveur **pas** arrêté ; un scan machine ne détecte **pas** `restored-…` comme un serveur ; la sauvegarde suivante l'exclut.
- [ ] **11.10** « Restaurer des fichiers… » → cocher `server.properties` → « Remplacer les fichiers actuels ». Attendu : avertissement d'arrêt, sauvegarde de sécurité, arrêt → remplacement → relance.
- [ ] **11.11** « Supprimer » l'archive `chaud`. Attendu : confirmation « définitivement », ligne « Supprimée » puis disparue ; le fichier n'existe plus sur le disque.
- [ ] **11.12** Vérification périodique : 10 min après le redémarrage de l'agent (bloc 1) et au plus une fois par jour, l'agent relit les archives. Attendu, en revenant plus tard : « Vérifiée le … » sur les archives, jamais deux passes le même jour.
- [ ] **11.13** Réglages → Sauvegardes du panel → « Sauvegarder maintenant ». Attendu : `mmo-panel-<date>.tar.gz` listé « base + TLS », alerte jaune « contient les secrets du panel », « Télécharger » fonctionne ; « Dernière sauvegarde » mise à jour.
- [ ] **11.14** _(matériel : 2e machine)_ Copie hors-site : carte « Copie hors-site » → choisir l'autre machine, 2 copies conservées → Enregistrer ; nouvelle sauvegarde → « Copie sur <machine> » ; supprimer l'original → « Rapatrier depuis <machine> » → l'archive revient et se restaure.
- [ ] **11.15** _(optionnel, panel arrêté)_ Restaurer le panel : `mmo-panel.cmd restore "data\backups\panel\mmo-panel-<date>.tar.gz"`. Attendu : base restaurée, `tls\` courant mis de côté en `tls.before-restore-<date>`, le panel redémarre avec les mêmes données.

## 12. Dupliquer, groupes de démarrage, migration

- [ ] **12.1** `test-vanilla` **en marche** → menu → « Dupliquer » : nom `test-vanilla (copie)`, port vide. Attendu : avertissement « la source sera arrêtée puis relancée », « Port de jeu retenu : … » choisi par le panel, statuts Export → Transfert → Restauration → Terminée dans la carte Migration (type « Copie »), **nouveau** serveur dans la liste avec son propre dossier, la source **relancée** ; un scan ne crée ni doublon ni conflit.
- [ ] **12.2** Serveurs → « Groupes » → créer `Test`, ajouter `test-vanilla` puis `test-fabric`, tout arrêter, puis « Démarrer » le groupe. Attendu : `test-vanilla` d'abord, `test-fabric` **seulement une fois le premier en marche** ; « Arrêter » les enchaîne dans l'ordre inverse ; badge de groupe dans la liste.
- [ ] **12.3** Serveurs → sélectionner les trois serveurs de test → action groupée « Arrêter ». Attendu : exécution l'un après l'autre, résumé « N serveurs traités ».
- [ ] **12.4** _(matériel : 2e machine)_ « Migrer vers une autre machine » : vérifications (dossier, port, Java, disque) puis migration ; l'id suit le dossier, la source est désenregistrée.
- [ ] **12.5** _(matériel : un proxy Velocity dans `E:\Minecraft\Server`)_ Il est détecté avec le loader « velocity », sans version Minecraft ni RCON, s'arrête par `shutdown` ; un groupe qui ne le met pas en dernier affiche l'avertissement.

## 13. Partager avec des amis (lot 8)

- [ ] **13.1** `test-vanilla` → Aperçu → « Page de statut publique » → activer. Attendu : lien `https://…/s/<22 caractères>` avec Copier / Ouvrir ; dans une **fenêtre privée** (sans compte) : nom, état, adresse à copier, version, **nombre** de joueurs sans pseudo, prochaine sauvegarde ; aucune ressource tierce chargée.
- [ ] **13.2** Cocher « Afficher les pseudos des joueurs connectés ». Attendu : la page publique montre les pseudos (avec un joueur connecté) ; décocher les cache.
- [ ] **13.3** « Changer de lien ». Attendu : l'ancienne adresse répond « Ce lien n'est plus valable » ; désactiver la page → même message ; réactiver → **le même** lien qu'avant le changement.
- [ ] **13.4** Arrêter le service `mmo-agent`, recharger la page publique. Attendu : l'état reste juste, mention « (interrogé directement) » ; relancer le service.
- [ ] **13.5** Cocher « Accepter les demandes de whitelist ». Attendu, en fenêtre privée : formulaire « Demander l'accès » ; un pseudo invalide (`ab`) est refusé sur place ; `AmiTest_1` + un mot → « Demande envoyée » ; dans le panel, **pastille** sur l'onglet Joueurs et carte « Demandes en attente » (la note s'y lit, elle **n'apparaît pas** dans la notification).
- [ ] **13.6** « Accepter ». Attendu : `AmiTest_1` dans la whitelist ; redéposer le **même** pseudo en fenêtre privée → « Vous êtes sur la liste blanche » ; un second pseudo → « Refuser » → la page publique dit « refusée » ; « Oublier cette demande » permet de redemander.
- [ ] **13.7** Réglages → Utilisateurs → « Nouvel utilisateur » `ami` / mot de passe, rôle Opérateur, Accès « Serveurs choisis ». Attendu : la modale « Ce que voit ami » s'ouvre aussitôt ; cocher **seulement** `test-vanilla` (opérateur) → « Droits enregistrés ».
- [ ] **13.8** Fenêtre privée, connexion `ami`. Attendu : **un seul** serveur partout (tableau de bord, liste, palette, cloche), console utilisable, Réglages absents ; l'URL d'un autre serveur (copiée depuis votre session) répond « Rien ici » ; l'URL de la machine aussi.
- [ ] **13.9** Depuis votre session : accorder la **machine** entière à `ami` (lecture seule). Attendu : sa fenêtre se **met à jour seule** (reconnexion 4002) et montre tous les serveurs ; les boutons Démarrer sont absents sauf sur `test-vanilla` (accordé opérateur).
- [ ] **13.10** Compte → « Clés d'API » → « Nouvelle clé » `test`, rôle Lecture seule, expire dans 30 jours. Attendu : jeton `mmo_…` (47 caractères) montré **une seule fois** avec un exemple `curl`. Puis :

  ```bash
  curl -H "Authorization: Bearer mmo_VOTRE_CLE" http://127.0.0.1:3000/api/servers
  ```

  Attendu : la liste JSON ; « Dernière utilisation » et l'adresse mises à jour dans la carte ; Journal d'audit : `admin [mmo_xxxxxxxx…]` ; la même clé sur `/api/users` → 403 ; « Révoquer » → 401 immédiat.

- [ ] **13.11** Compte → « Appareils connectés » depuis deux navigateurs. Attendu : les deux, « Cet appareil » sur le courant, adresse et dernière activité ; « Déconnecter » l'autre → il est renvoyé à la connexion à sa prochaine action ; Réglages → Utilisateurs → « Déconnecter partout » sur `ami` ferme sa fenêtre privée.
- [ ] **13.12** Réglages → Clés d'API de tous les comptes. Attendu : colonne Compte, révocation possible, pas de création.

## 14. Notifications, alertes, webhooks

- [ ] **14.1** Cloche : démarrer `test-vanilla`. Attendu : entrée « Serveur démarré » avec pastille ; cliquer l'entrée ouvre le serveur et efface la pastille ; « Tout marquer comme lu ».
- [ ] **14.2** Compte → « Préférences de notification » : décocher la **Cloche** pour « Serveur démarré / arrêté », redémarrer le serveur. Attendu : rien dans la cloche, l'onglet Événements l'a quand même ; recocher.
- [ ] **14.3** Compte → « Notifications push » → « Activer sur cet appareil » (Chrome ou Edge sur `127.0.0.1` ou l'adresse HTTPS) → « Envoyer un test ». Attendu : notification système reçue, appareil listé avec « Dernière livraison ».
- [ ] **14.4** Boutons dans la notification : redémarrage auto **désactivé** sur `test-vanilla`, serveur en marche, tuer `java.exe` au Gestionnaire des tâches. Attendu : notification « Serveur planté » avec les boutons **Démarrer** et **Console** (Chrome / Edge) ; « Démarrer » relance le serveur et une notification de résultat suit ; sur un échec de démarrage, seul « Console » est proposé.
- [ ] **14.5** Compte → « Heures calmes » : « Ne pas me déranger la nuit » de maintenant à +1 h. Attendu : « Serveur démarré » ne fait **pas** sonner (mais reste dans la cloche) ; un plantage (5.5) sonne quand même (urgence) ; désactiver ensuite.
- [ ] **14.6** `test-fabric` → Aperçu → carte « Notifications » → « Ne plus faire sonner mon téléphone pour ce serveur ». Attendu : plus **aucun** push pour ce serveur, plantage compris ; la cloche continue ; Compte → « Serveurs en silence » le liste, « Réactiver » l'en retire.
- [ ] **14.7** Alerte « serveur tombé » : `test-vanilla` en marche, redémarrage auto désactivé, tuer `java.exe`, attendre ~5 min. Attendu : « Alerte » (serveur tombé) dans la cloche et en push ; Démarrer → « Alerte levée ».
- [ ] **14.8** Alerte « machine hors ligne » : arrêter le service `mmo-agent`, attendre quelques minutes. Attendu : machine « Hors ligne », **une seule** alerte pour la machine (pas une par serveur) ; relancer → « levée », serveurs ré-adoptés.
- [ ] **14.9** Réglages → Webhooks → « Ajouter un webhook » JSON signé avec une URL de **https://webhook.site** (nouvelle adresse), toutes les catégories → « Tester ». Attendu : « Test réussi (HTTP 200) », sur webhook.site un POST JSON avec les en-têtes `x-mmo-signature`, `x-mmo-event`, `x-mmo-delivery` ; le secret n'est montré qu'à la création ; l'URL est affichée **masquée**.
- [ ] **14.10** Une URL en `http://` ou vers `192.168.x.x` / `localhost` / `*.ts.net`. Attendu : **refusée à la saisie** avec la raison (https seul, adresse privée…).
- [ ] **14.11** Modifier l'URL vers une adresse webhook.site **inexistante** (404), démarrer un serveur. Attendu : « En échec (1) » avec la dernière erreur, **une** notification « Webhook en échec » ; remettre la bonne URL → prochain envoi OK et notification « rétabli ».
- [ ] **14.12** _(matériel : salon Discord)_ Webhook Discord avec l'URL du salon → « Tester ». Attendu : embed `MMO` dans le salon ; une URL Discord sans `/api/webhooks/<id>/<jeton>` est refusée.

## 15. Réglages généraux, accès, audit, `report`

- [ ] **15.1** Réglages → Général → « Rétention (jours) ». Attendu : 8 champs (événements 90, audit 365, commandes 90, sessions joueurs 365, télémétrie 14, migrations 90, fiches de sauvegardes supprimées 30, tâches 30) ; mettre `0` → erreur qui **nomme le champ** ; mettre 120 sur Événements → Enregistrer → la valeur tient au rechargement.
- [ ] **15.2** Général : « Restaurer l'état souhaité au démarrage d'un agent » coché, « Mettre à jour les agents automatiquement à la connexion » **décoché**, « Vérifier les nouvelles versions du panel » coché, « Intervalle des métriques » 15.
- [ ] **15.3** Accès distant : mode Tailscale, « Répondre aussi sur la voie directe » **décoché** (ne pas activer) → « Test de joignabilité » → « Lancer le test ». Attendu : HTTP / WebSocket / Frames binaires / Certificat TLS **OK**, « Vu via tailscale serve », « Le panel est joignable par https://… ».
- [ ] **15.4** Distribution de l'agent. Attendu : « Agent 1.0.7 », 4 plateformes avec taille, mention « signée avec la clé de développement », commandes génériques Windows / Linux.
- [ ] **15.5** Push (côté panel). Attendu : « Les clés VAPID sont configurées ».
- [ ] **15.6** Journal d'audit. Attendu : toutes les actions de la fiche (création de serveurs, clés, utilisateurs, webhooks, page de statut **sans le jeton**, restaurations) avec utilisateur, adresse, heure ; une ligne dépliée montre le détail ; défilement au clavier.
- [ ] **15.7** Terminal dans `E:\mmo-panel\mmo-panel-1.0.7\` : `mmo-panel.cmd report`. Attendu : `data\mmo-report-<date>.txt` ; à l'intérieur ni votre nom d'utilisateur (`C:\Users\<user>`), ni chemin de serveur, ni valeur de jeton ; les adresses IPv4 sans dernier octet, `127.0.0.1` intact ; les réglages secrets « (set, hidden) ».
- [ ] **15.8** `http://127.0.0.1:3000/api/health` connecté en admin. Attendu : bloc `diagnostics` (démarrage, machines connectées, taille des bases, dernière maintenance, chemin du journal) ; en fenêtre privée, la sonde nue seulement.

## 16. Téléphone / PWA _(matériel : téléphone sur le tailnet)_

- [ ] **16.1** Ouvrir `https://<votre-nom>.ts.net` sur le téléphone → « Installer l'application » / « Sur l'écran d'accueil ». Attendu : icône MMO, ouverture plein écran, navigation et console utilisables, onglets du serveur défilables avec chevrons.
- [ ] **16.2** Compte → Notifications push → « Activer sur cet appareil » → « Envoyer un test ». Attendu : notification reçue le panel fermé ; un plantage (14.4) arrive avec ses boutons (Android) ou sans (iOS, dégradation prévue).

## 17. Nettoyage

- [ ] **17.1** Arrêter les serveurs de test ; « Oublier ce serveur » sur `test-vanilla`, `test-vanilla (copie)`, `test-fabric` (rien n'est supprimé sur le disque) ; supprimer leurs dossiers et `test-occupe` à la main ; scanner → 54 serveurs, aucun conflit.
- [ ] **17.2** Supprimer le groupe `Test`, l'utilisateur `ami`, la clé `test`, le webhook de test, la page de statut ; retirer la destination de sauvegarde si vous ne la gardez pas ; réactiver les préférences modifiées.
- [ ] **17.3** Relire `data\logs\panel-<date>.log` et `%LOCALAPPDATA%\mmo-agent\logs\agent-<date>.log` à la recherche de `ERROR` / `WARN` inattendus pendant la session ; les noter avec l'heure.

## Si quelque chose casse

- Panel : `E:\mmo-panel\mmo-panel-1.0.7\data\logs\panel-<date>.log` (chaque requête y est tracée avec son `requestId`, le même que dans un message d'erreur 500) ; si lancé depuis un terminal, la sortie lisible.
- Agent : `%LOCALAPPDATA%\mmo-agent\logs\agent-<date>.log`, `%LOCALAPPDATA%\Programs\mmo-agent\launcher.log`, `logs\shawl_for_mmo-agent_rCURRENT.log` ; le bouton « Fichier de diagnostic » de la carte Agent rassemble tout cela, masqué.
- Un signalement complet : `mmo-panel.cmd report` (panel) + fichier de diagnostic (agent).
- Redémarrer l'agent : `services.msc` (admin) → `mmo-agent` → Redémarrer. Le panel : icône → Redémarrer, ou Quitter puis relancer.
- Noter : numéro d'étape, action, attendu vs obtenu, heure.
