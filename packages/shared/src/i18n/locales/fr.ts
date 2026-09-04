import type { Resources } from './en.js';

/** Ressources i18n — français. Parité de clés avec `en` garantie à la compilation (`satisfies`). */
export const fr = {
  common: {
    appName: 'MinecraftManagerOnline',
    loader: {
      vanilla: 'Vanilla',
      forge: 'Forge',
      neoforge: 'NeoForge',
      fabric: 'Fabric',
      velocity: 'Velocity (proxy)',
      unknown: 'Inconnu (à configurer)',
    },
    confidence: {
      high: 'Confiance élevée',
      medium: 'Confiance moyenne',
      low: 'Confiance faible — à vérifier',
    },
    runState: {
      stopped: 'Arrêté',
      starting: 'Démarrage',
      running: 'En marche',
      stopping: 'Arrêt en cours',
      crashed: 'Planté',
      unreachable: 'Inaccessible',
    },
    attachMode: {
      attached: 'Attaché (console)',
      detached: 'Détaché (RCON seulement jusqu’au prochain redémarrage)',
    },
    cpuSource: {
      cycles: 'CPU (mesure par cycles)',
      proc: 'CPU (/proc)',
      ticks: 'CPU (mesure par ticks, possiblement sous-évaluée)',
    },
    yes: 'Oui',
    no: 'Non',
    unknown: 'Inconnu',
    notify: {
      serverCrashed: { title: '{{server}} a planté', body: 'Le serveur a planté sur {{machine}}.' },
      serverStartFailed: {
        title: 'Échec du démarrage de {{server}}',
        body: 'Démarrage échoué sur {{machine}} : {{reason}}',
      },
      watchdogAlert: {
        title: 'Watchdog : {{server}}',
        body: '{{kind}} → {{action}} ({{machine}})',
      },
      agentOffline: {
        title: '{{machine}} est hors ligne',
        body: "L'agent a perdu sa connexion au panel.",
      },
      taskFailed: { title: 'Tâche échouée : {{kind}}', body: '{{server}} · {{reason}}' },
      backupFailed: { title: 'Sauvegarde échouée : {{server}}', body: '{{reason}}' },
      migrationDone: {
        title: 'Migration terminée : {{server}}',
        body: 'Désormais hébergé sur {{machine}}.',
      },
      migrationFailed: { title: 'Migration échouée : {{server}}', body: '{{reason}}' },
      duplicationDone: {
        title: 'Copie terminée : {{server}}',
        body: 'Nouveau serveur prêt sur {{machine}}.',
      },
      duplicationFailed: { title: 'Copie échouée : {{server}}', body: '{{reason}}' },
      agentUpdateApplied: {
        title: 'Agent mis à jour : {{machine}}',
        body: 'La version {{version}} est en service.',
      },
      agentUpdateRolledBack: {
        title: "Mise à jour d'agent annulée : {{machine}}",
        body: 'Retour à {{version}} : {{reason}}',
      },
      panelUpdateAvailable: {
        title: 'Mise à jour du panel disponible',
        body: 'La version {{version}} est publiée — vous êtes en {{current}}.',
      },
      scheduleFailed: { title: 'Tâche planifiée échouée', body: '{{server}} · {{action}}' },
      portConflict: {
        title: 'Conflit de port sur {{machine}}',
        body: 'Le port {{port}} est déjà utilisé.',
      },
      alertMachineOffline: {
        title: '{{machine}} est hors ligne',
        body: 'Aucun signe de l’agent depuis un moment.',
      },
      alertServerDown: { title: '{{server}} est arrêté', body: 'Il devrait être en marche.' },
      alertDiskLow: {
        title: 'Disque presque plein sur {{machine}}',
        body: '{{percent}} % utilisés, {{freeGb}} Go restants.',
      },
      alertTpsLow: { title: '{{server}} rame', body: 'TPS descendu à {{tps}}.' },
      alertResolved: { title: 'Retour à la normale : {{scope}}', body: 'L’alerte est levée.' },
      backupOverdue: {
        title: 'Aucune sauvegarde de {{server}}',
        body: 'Une sauvegarde planifiée n’a pas eu lieu à l’heure attendue.',
      },
      backupCorrupted: {
        title: 'Sauvegarde corrompue : {{server}}',
        body: 'Une archive ne correspond plus à son manifeste — ne comptez plus dessus : {{path}}',
      },
      panelBackupFailed: {
        title: 'Sauvegarde du panel échouée',
        body: 'La copie quotidienne de la base du panel n’a pas pu être écrite : {{reason}}',
      },
      webhookFailed: {
        title: 'Webhook « {{webhook}} » en échec',
        body: 'Les envois ne passent plus : {{reason}}. Réglages → Webhooks.',
      },
      webhookRecovered: {
        title: 'Webhook « {{webhook}} » rétabli',
        body: 'Les envois passent à nouveau.',
      },
      whitelistRequested: {
        title: '{{player}} demande à rejoindre {{server}}',
        body: 'Demande de liste blanche en attente — onglet Joueurs → Liste blanche.',
      },
      webhookTest: {
        title: 'Test du webhook « {{webhook}} »',
        body: 'Ce message vient de MinecraftManagerOnline : le webhook est bien configuré.',
      },
      replicaDone: {
        title: 'Copie hors-site faite : {{server}}',
        body: 'Archive copiée sur {{machine}}.',
      },
      replicaFailed: { title: 'Copie hors-site échouée : {{server}}', body: '{{reason}}' },
      serverRunning: { title: '{{server}} est en marche', body: 'Démarré sur {{machine}}.' },
      serverStopped: { title: '{{server}} est arrêté', body: 'Arrêté sur {{machine}}.' },
      playerJoined: {
        title: '{{player}} a rejoint {{server}}',
        body: '{{online}} joueur(s) en ligne.',
      },
      playerLeft: {
        title: '{{player}} a quitté {{server}}',
        body: '{{online}} joueur(s) en ligne.',
      },
      taskDone: { title: 'Tâche terminée : {{kind}}', body: '{{server}}{{machine}}' },
      backupDone: { title: 'Sauvegarde faite : {{server}}', body: 'Enregistrée sur {{machine}}.' },
      scheduleDone: { title: 'Action programmée exécutée', body: '{{server}} · {{action}}' },
      agentProblem: { title: 'Problème sur {{machine}}', body: '{{reason}}' },
      machinePaired: {
        title: 'Nouvelle machine : {{machine}}',
        body: 'Appairée depuis {{hostname}}.',
      },
      serverDiscovered: {
        title: 'Nouveau serveur trouvé : {{server}}',
        body: 'Sur {{machine}} · {{path}}',
      },
      serverGone: { title: '{{server}} a disparu', body: 'Dossier introuvable : {{path}}' },
      serverDeleted: { title: '{{server}} supprimé', body: 'Retiré du panel.' },
      serverMoved: {
        title: '{{server}} a déménagé',
        body: 'Maintenant dans {{path}} sur {{machine}}.',
      },
      serverConflict: {
        title: 'Conflit sur {{machine}}',
        body: 'Deux serveurs revendiquent {{path}}.',
      },
      playerAction: { title: '{{action}} · {{target}}', body: 'Sur {{server}}.' },
      test: {
        title: 'Notification de test',
        body: 'Les notifications push fonctionnent sur cet appareil.',
      },
    },
  },
  errors: {
    E_AUTH: 'Échec de l’authentification.',
    E_PAIRING_CODE_INVALID: 'Code d’appairage invalide ou expiré.',
    E_UNSUPPORTED_VERSION:
      'La version du protocole de l’agent n’est pas supportée — mettez l’agent à jour.',
    E_UNSUPPORTED_TYPE: 'Opération non supportée par l’agent (nécessite un agent plus récent).',
    E_INVALID_PAYLOAD: 'Contenu de requête invalide.',
    E_NOT_FOUND: 'Ressource introuvable.',
    E_NOT_FOUND_PATHS_NOT_IN_ARCHIVE: 'Absent de cette archive : {{list}}. Rien n’a été modifié.',
    E_INVALID_PAYLOAD_RESERVED_PATH:
      'Ce chemin est géré par l’agent et n’est jamais restauré : {{path}}.',
    E_IO_ARCHIVE_UNREADABLE:
      'L’archive ne peut pas être lue (corrompue ou tronquée) : ne restaurez pas depuis elle — supprimez-la et refaites une sauvegarde.',
    E_CONFLICT: 'Conflit : la ressource a été modifiée entre-temps.',
    E_BUSY: 'L’agent est occupé, réessayez.',
    E_TIMEOUT: 'L’opération a expiré.',
    E_CANCELLED: 'L’opération a été annulée.',
    E_IO: 'Erreur disque ou réseau.',
    // Variantes `E_IO_<reason>` : la cause système exacte, avec le geste qui répare.
    E_IO_EACCES:
      'Droits insuffisants sur {{path}} — l’agent tourne sous le compte « {{user}} », qui ne peut pas y écrire. Donnez l’accès à ce compte (par exemple : sudo chown -R {{user}} <dossier du serveur>), ou réinstallez l’agent sous le compte propriétaire des serveurs.',
    E_IO_EPERM:
      'Opération refusée sur {{path}} — l’agent tourne sous le compte « {{user}} ». Vérifiez le propriétaire et les droits de ce dossier.',
    E_IO_EROFS: '{{path}} est sur un système de fichiers en lecture seule.',
    E_IO_ENOSPC: 'Plus d’espace disque sur le volume qui contient {{path}}.',
    E_IO_ENOTDIR: '{{path}} n’est pas un dossier.',
    // Lot 4 — gardes de sauvegarde : refus AVANT d'écrire, avec les nombres qui permettent d'agir.
    E_IO_INSUFFICIENT_SPACE:
      'Pas assez d’espace libre pour la sauvegarde sur {{path}} : environ {{requiredMb}} Mo nécessaires (estimation), {{freeMb}} Mo libres. Rien n’a été écrit. Libérez de la place ou changez la destination des sauvegardes.',
    E_IO_DESTINATION_UNMARKED:
      'La destination de sauvegarde {{path}} n’a pas de fichier marqueur ({{marker}}) : le dossier n’est probablement pas monté, ou a été remplacé. Rien n’a été écrit. Montez-le et réessayez ; si c’est bien le bon dossier, créez-y un fichier vide nommé {{marker}}, ou retirez la destination des réglages puis remettez-la.',
    E_PORT_IN_USE: 'Le port {{port}} est déjà utilisé.',
    E_RAM_GUARD: 'Mémoire insuffisante : {{needMb}} Mo nécessaires, {{freeMb}} Mo disponibles.',
    E_EULA_REQUIRED: 'L’EULA Minecraft doit être acceptée avant de démarrer le serveur.',
    E_JAVA_UNAVAILABLE: 'Aucun runtime Java adapté (Java {{majorVersion}}) n’est disponible.',
    E_CHECKSUM_MISMATCH: 'Somme de contrôle incorrecte — le fichier est corrompu.',
    E_INTERRUPTED: 'L’opération a été interrompue ; elle peut être relancée.',
    E_PRECHECK_FAILED: 'Les vérifications préalables sur la machine cible ont échoué.',
    E_SIGNATURE_INVALID: 'La signature du bundle est invalide — mise à jour refusée.',
    E_UNREACHABLE: 'Aucune adresse directe joignable ; passage par le panel.',
    E_TOO_LARGE: 'Le fichier ou le transfert dépasse la taille autorisée.',
    E_INTERNAL: 'Erreur interne.',
    // Codes propres au panel (`@mmo/protocol/client`, phase 4)
    E_FORBIDDEN: 'Vous n’avez pas le droit d’effectuer cette action.',
    E_RATE_LIMITED: 'Trop de tentatives — patientez un instant.',
    E_SETUP_REQUIRED: 'Le panel n’est pas encore configuré.',
    E_SETUP_DONE: 'Le panel est déjà configuré.',
    E_AGENT_OFFLINE: 'L’agent de cette machine n’est pas connecté.',
    E_VALIDATION: 'Saisie invalide.',
    /** Lot 4 — URL de webhook refusée par la garde SSRF (`details.reason`, clé `url`). */
    E_VALIDATION_BAD_URL: 'Cette adresse n’est pas une URL valide.',
    E_VALIDATION_BAD_SCHEME: 'Seules les adresses https:// sont acceptées pour un webhook.',
    E_VALIDATION_CREDENTIALS:
      'Une URL de webhook ne doit pas contenir d’identifiants (user:mot-de-passe@).',
    E_VALIDATION_BLOCKED_HOST:
      'Nom d’hôte refusé ({{hostname}}) : un webhook ne peut pas viser une machine locale ni le tailnet.',
    E_VALIDATION_BLOCKED_ADDRESS:
      '{{hostname}} pointe vers une adresse réservée ({{address}}, {{range}}) : un webhook ne peut viser qu’un service public.',
    E_VALIDATION_UNRESOLVABLE: 'Le nom d’hôte {{hostname}} ne se résout pas depuis le panel.',
    E_VALIDATION_NOT_DISCORD:
      'Ce n’est pas une URL de webhook Discord (attendu : https://discord.com/api/webhooks/<id>/<jeton>).',
    E_VALIDATION_TOO_MANY: 'Nombre maximal de webhooks atteint ({{max}}).',
    E_VALIDATION_NO_SECRET:
      'Un webhook Discord n’a pas de secret : seul un webhook JSON signé en a un.',
    /** Lot 4 — copie hors-site. */
    E_VALIDATION_SAME_MACHINE:
      'La copie hors-site doit vivre sur une autre machine que celle du serveur.',
    E_VALIDATION_NO_DESTINATION: 'Aucune machine de copie hors-site n’est réglée pour ce serveur.',
    /** Lot 8 — droits par serveur. */
    E_VALIDATION_ADMIN_SCOPED:
      'Un administrateur voit tout le panel : le compte ne peut pas être limité à certains serveurs.',
    E_VALIDATION_GRANT_ABOVE_ROLE:
      'Un rôle accordé ne peut pas dépasser le rôle du compte (un lecteur reste lecteur partout).',
    E_NO_RELEASE: 'Aucune release d’agent publiée sur ce panel.',
    /** Lot 8 — clés d'API. */
    E_AUTH_INVALID_API_KEY: 'Cette clé d’API est inconnue, expirée ou révoquée.',
    E_FORBIDDEN_API_KEY: 'Cette action exige une session ouverte, pas une clé d’API.',
    E_VALIDATION_KEY_ABOVE_ROLE:
      'Une clé d’API ne peut pas avoir un rôle supérieur à celui de son propriétaire.',
    E_VALIDATION_TOO_MANY_KEYS: 'Nombre maximal de clés d’API atteint pour ce compte ({{max}}).',
    E_PUSH_DISABLED:
      'Les notifications push ne sont pas configurées sur ce panel (clés VAPID absentes).',
    E_ACCESS_NOT_CONFIGURED:
      "La couche d'accès n'est pas configurée (domaine, fournisseur DNS ou URL publique manquants).",
    E_ACME_FAILED: 'Demande de certificat échouée : {{reason}}',
    E_DNS_FAILED: 'Mise à jour DNS échouée : {{reason}}',
  },
  detection: {
    source: {
      libraries: 'dossier libraries/',
      run_script: 'script de lancement',
      jar_name: 'nom du fichier jar',
      jar_manifest: 'manifeste du jar',
      install_properties: 'install.properties Fabric',
      version_json: 'version.json dans le jar serveur',
      versions_dir: 'dossier versions/',
      variables_txt: 'variables.txt (ServerPackCreator)',
      server_setup_config: 'server-setup-config.yaml (FTB)',
      installer_name: 'nom de l’installeur',
      latest_log: 'logs/latest.log',
      mods: 'dossier mods/',
      user_jvm_args: 'user_jvm_args.txt',
      settings_script: 'script de réglages',
      script: 'script de démarrage',
      server_properties: 'server.properties',
      default: 'valeur par défaut',
      override: 'surcharge manuelle',
      manifest: 'manifest des versions Mojang',
      table: 'table de compatibilité intégrée',
    },
    evidence: {
      neoforge_libraries: 'bibliothèques NeoForge trouvées ({{detail}})',
      forge_libraries: 'bibliothèques Forge trouvées ({{detail}})',
      forge_argfiles: 'fichiers d’arguments Forge/NeoForge trouvés ({{detail}})',
      forge_universal_jar: 'jar universal Forge trouvé ({{detail}})',
      forge_installer_only: 'installeur Forge/NeoForge présent mais non installé ({{detail}})',
      fabric_launcher: 'lanceur serveur Fabric trouvé ({{detail}})',
      fabric_dir: 'dossier .fabric/ trouvé',
      vanilla_jar: 'jar serveur vanilla trouvé ({{detail}})',
      serverstarterjar: 'server.jar est un ServerStarterJar NeoForge, pas un serveur vanilla',
      mods_vote: 'les descripteurs de mods/ indiquent {{detail}}',
      mods_mismatch: 'les descripteurs de mods/ contredisent le loader détecté ({{detail}})',
      mods_ambiguous: 'les descripteurs de mods/ sont ambigus ({{detail}})',
      variables_txt: 'variables.txt déclare {{detail}}',
      server_setup_config: 'server-setup-config.yaml déclare {{detail}}',
      version_conflict: 'versions Minecraft contradictoires trouvées ({{detail}})',
      version_confirmed: 'version Minecraft confirmée par {{detail}}',
      log_version: 'logs/latest.log mentionne la version {{detail}}',
      ram_from: 'réglages mémoire lus dans {{detail}}',
      ram_default: 'aucun réglage mémoire trouvé — valeur par défaut proposée',
      ram_ambiguous: 'plusieurs réglages mémoire trouvés ({{detail}})',
      eula_accepted: 'EULA acceptée',
      eula_missing: 'EULA pas encore acceptée',
      velocity_toml: 'velocity.toml trouvé — proxy Velocity ({{detail}})',
      marker: 'marqueur MMO trouvé ({{detail}})',
      no_loader: 'aucun signal de loader — à configurer manuellement',
      no_version: 'version Minecraft introuvable — à configurer manuellement',
    },
    needsInstall: 'Le loader n’a pas encore été installé (installeur présent, libraries/ absent).',
  },
} as const satisfies Resources;
