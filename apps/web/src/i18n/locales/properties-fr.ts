import type { propertiesEn } from './properties-en.js';

type PropertiesResources = {
  [K in keyof typeof propertiesEn]: { label: string; help: string };
};

/** `server.properties` expliqué clé par clé — français. */
export const propertiesFr = {
  motd: {
    label: 'Description du serveur (MOTD)',
    help: 'Texte affiché dans la liste des serveurs multijoueur. Codes couleur § et retours à la ligne \\n acceptés.',
  },
  gamemode: {
    label: 'Mode de jeu par défaut',
    help: 'Mode attribué aux nouveaux joueurs : survie, créatif, aventure ou spectateur.',
  },
  'force-gamemode': {
    label: 'Forcer le mode de jeu',
    help: 'Les joueurs reviennent au mode par défaut à chaque connexion.',
  },
  difficulty: {
    label: 'Difficulté',
    help: 'Paisible supprime les monstres ; difficile durcit la faim et les dégâts.',
  },
  hardcore: {
    label: 'Hardcore',
    help: 'Difficulté verrouillée sur difficile, et les joueurs passent spectateurs à leur mort.',
  },
  pvp: { label: 'Joueur contre joueur', help: 'Autoriser les joueurs à se blesser entre eux.' },
  'allow-flight': {
    label: 'Autoriser le vol',
    help: 'Tolérer les joueurs qui volent en survie (mods, bugs d’élytres). Désactivé = expulsion pour vol.',
  },
  'enable-command-block': {
    label: 'Blocs de commande',
    help: 'Autoriser les blocs de commande à exécuter des commandes.',
  },
  'max-players': { label: 'Joueurs maximum', help: 'Nombre de joueurs simultanés autorisés.' },
  'online-mode': {
    label: 'Mode en ligne (authentification Mojang)',
    help: 'Vérifie les comptes auprès de Mojang. À désactiver seulement en LAN ou derrière un proxy — sinon n’importe qui peut usurper un pseudo.',
  },
  'white-list': {
    label: 'Liste blanche activée',
    help: 'Seuls les joueurs de la liste blanche peuvent se connecter. Appliqué immédiatement si le serveur tourne.',
  },
  'enforce-whitelist': {
    label: 'Appliquer la liste blanche',
    help: 'Expulse les joueurs en ligne retirés de la liste blanche.',
  },
  'player-idle-timeout': {
    label: 'Délai d’inactivité (minutes)',
    help: 'Expulse les joueurs inactifs au-delà de cette durée. 0 désactive.',
  },
  'op-permission-level': {
    label: 'Niveau de permission des opérateurs',
    help: '1 = contourner la protection du spawn, 2 = triche, 3 = gestion des joueurs, 4 = tout (stop, etc.).',
  },
  'function-permission-level': {
    label: 'Niveau de permission des fonctions',
    help: 'Niveau utilisé par les fonctions des packs de données.',
  },
  'hide-online-players': {
    label: 'Masquer les joueurs en ligne',
    help: 'Ne pas lister les pseudos dans le statut du serveur.',
  },
  'enforce-secure-profile': {
    label: 'Profils de chat sécurisés',
    help: 'Exige un chat signé (clé Mojang). Désactivé : clients anciens et certains mods acceptés.',
  },
  'spawn-protection': {
    label: 'Rayon de protection du spawn',
    help: 'Blocs autour du spawn que seuls les opérateurs peuvent modifier. 0 désactive.',
  },
  'level-name': {
    label: 'Dossier du monde',
    help: 'Nom du dossier du monde. En changer charge ou crée un autre monde.',
  },
  'level-seed': {
    label: 'Graine du monde',
    help: 'Utilisée seulement à la génération d’un nouveau monde.',
  },
  'level-type': {
    label: 'Type de monde',
    help: 'Normal, plat, grands biomes, amplifié ou biome unique.',
  },
  'generate-structures': {
    label: 'Générer les structures',
    help: 'Villages, temples, forteresses… dans les nouveaux chunks.',
  },
  'generator-settings': {
    label: 'Réglages du générateur (JSON)',
    help: 'Paramètres personnalisés pour les mondes plats ou sur mesure.',
  },
  'allow-nether': { label: 'Autoriser le Nether', help: 'Active les portails du Nether.' },
  'spawn-monsters': {
    label: 'Apparition des monstres',
    help: 'Les monstres apparaissent la nuit et dans le noir.',
  },
  'spawn-animals': {
    label: 'Apparition des animaux',
    help: 'Les animaux passifs apparaissent naturellement.',
  },
  'spawn-npcs': {
    label: 'Apparition des villageois',
    help: 'Les villageois peuplent les villages.',
  },
  'max-world-size': {
    label: 'Taille maximale du monde',
    help: 'Rayon de la bordure du monde en blocs (max 29 999 984).',
  },
  'max-build-height': {
    label: 'Hauteur de construction maximale',
    help: 'Réglage des anciennes versions ; ignoré depuis la 1.18.',
  },
  'server-ip': {
    label: 'Adresse d’écoute',
    help: 'Laisser vide pour écouter sur toutes les interfaces. À renseigner seulement si la machine a plusieurs IP.',
  },
  'server-port': {
    label: 'Port de jeu',
    help: 'Port TCP auquel les joueurs se connectent (25565 par défaut). Doit être libre sur la machine.',
  },
  'enable-status': {
    label: 'Afficher le statut',
    help: 'Répondre aux pings de la liste des serveurs. Désactivé, le serveur paraît hors ligne dans la liste.',
  },
  'enable-query': {
    label: 'Requêtes GameSpy',
    help: 'Expose le protocole UDP de requête utilisé par certains outils de supervision.',
  },
  'query.port': { label: 'Port de requête', help: 'Port UDP du protocole de requête.' },
  'network-compression-threshold': {
    label: 'Seuil de compression',
    help: 'Les paquets plus gros que cette taille (octets) sont compressés. -1 désactive, 0 compresse tout.',
  },
  'prevent-proxy-connections': {
    label: 'Bloquer les connexions via proxy',
    help: 'Refuse les joueurs dont l’IP diffère de celle authentifiée par Mojang.',
  },
  'use-native-transport': {
    label: 'Transport natif (Linux)',
    help: 'Utilise epoll pour de meilleures performances réseau sous Linux.',
  },
  'rate-limit': {
    label: 'Limite de paquets',
    help: 'Paquets par seconde et par joueur avant expulsion. 0 désactive.',
  },
  'accepts-transfers': {
    label: 'Accepter les transferts',
    help: 'Autorise les joueurs transférés depuis un autre serveur (1.20.5+).',
  },
  'view-distance': {
    label: 'Distance d’affichage (chunks)',
    help: 'Chunks envoyés autour de chaque joueur. Les grandes valeurs coûtent RAM et bande passante.',
  },
  'simulation-distance': {
    label: 'Distance de simulation (chunks)',
    help: 'Chunks où entités et cultures évoluent. À baisser en premier quand les TPS chutent.',
  },
  'max-tick-time': {
    label: 'Délai du watchdog (ms)',
    help: 'Le serveur s’arrête de lui-même si un tick dure plus longtemps. -1 désactive (MMO a son propre watchdog).',
  },
  'entity-broadcast-range-percentage': {
    label: 'Portée d’envoi des entités (%)',
    help: 'Distance à laquelle les entités sont envoyées aux clients, relative au défaut.',
  },
  'sync-chunk-writes': {
    label: 'Écritures de chunks synchrones',
    help: 'Sauvegardes plus sûres ; désactiver accélère la sauvegarde au détriment de la robustesse.',
  },
  'max-chained-neighbor-updates': {
    label: 'Mises à jour en chaîne maximales',
    help: 'Limite les cascades de mises à jour de blocs. -1 supprime la limite.',
  },
  'region-file-compression': {
    label: 'Compression des fichiers de région',
    help: 'Compression des fichiers du monde (1.20.5+). lz4 est plus rapide, deflate plus compact.',
  },
  'pause-when-empty-seconds': {
    label: 'Pause si vide (secondes)',
    help: 'Arrête de simuler le monde après ce délai sans joueur (1.21.2+). -1 désactive.',
  },
  'enable-rcon': {
    label: 'RCON activé',
    help: 'Géré par MMO : l’agent active RCON pour piloter le serveur en mode détaché.',
  },
  rcon_port: { label: 'Port RCON', help: 'Géré par MMO (port libre auto-provisionné).' },
  rcon_password: {
    label: 'Mot de passe RCON',
    help: 'Géré par MMO (mot de passe aléatoire fort).',
  },
  'broadcast-rcon-to-ops': {
    label: 'Diffuser RCON aux opérateurs',
    help: 'Les opérateurs voient la sortie des commandes RCON dans le chat.',
  },
  'resource-pack': {
    label: 'URL du pack de ressources',
    help: 'Lien de téléchargement direct d’un pack proposé aux joueurs.',
  },
  'resource-pack-sha1': {
    label: 'SHA-1 du pack de ressources',
    help: 'Empreinte du pack, permet aux clients de le mettre en cache.',
  },
  'resource-pack-prompt': {
    label: 'Message du pack de ressources',
    help: 'Message affiché quand le pack est proposé (texte JSON).',
  },
  'require-resource-pack': {
    label: 'Pack de ressources obligatoire',
    help: 'Les joueurs qui refusent le pack sont déconnectés.',
  },
  'broadcast-console-to-ops': {
    label: 'Diffuser la console aux opérateurs',
    help: 'Les opérateurs voient la sortie des commandes console dans le chat.',
  },
  'enable-jmx-monitoring': {
    label: 'Supervision JMX',
    help: 'Expose les durées de tick via JMX (outils Java).',
  },
  'log-ips': {
    label: 'Journaliser les IP',
    help: 'Écrit les adresses IP des joueurs dans les journaux.',
  },
  'text-filtering-config': {
    label: 'Configuration du filtrage de texte',
    help: 'Configuration du filtrage du chat (avancé, généralement vide).',
  },
  'initial-enabled-packs': {
    label: 'Packs de données activés au départ',
    help: 'Packs de données activés à la création du monde (séparés par des virgules).',
  },
  'initial-disabled-packs': {
    label: 'Packs de données désactivés au départ',
    help: 'Packs de données désactivés à la création du monde.',
  },
  'bug-report-link': {
    label: 'Lien de signalement de bug',
    help: 'URL proposée aux joueurs pour signaler un problème (1.21.6+).',
  },
} as const satisfies PropertiesResources;
