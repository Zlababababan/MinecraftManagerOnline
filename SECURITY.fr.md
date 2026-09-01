# Politique de sécurité

[English](SECURITY.md) · **Français**

MinecraftManagerOnline expose un panel web destiné à être joignable depuis Internet, embarque ses
propres implémentations de Web Push et d'ACME, et pilote des processus Java sur des machines
distantes. Cette surface mérite une politique, même pour un projet tenu par une seule personne.

## Versions suivies

Seule la **dernière release** reçoit les correctifs de sécurité. Il n'y a pas de branche de support
au long cours : si vous utilisez une version antérieure, le correctif consiste à mettre à jour
(l'installeur en une commande le fait sur place, avec retour arrière si la nouvelle version ne
démarre pas — voir le [guide d'installation](docs/guide/fr/installation.md#15-mettre-à-jour-le-panel)).

## Signaler une vulnérabilité

Signalez en privé, pas dans une issue publique.

1. Onglet **Security** du dépôt, bouton **Report a vulnerability** (signalement privé de GitHub). La
   discussion reste privée jusqu'au correctif, sans que vous ayez à savoir qui je suis, ni moi à
   publier une adresse.
2. Si ce bouton ne vous est pas proposé, ouvrez une issue ordinaire contenant **uniquement** la
   phrase « j'ai un signalement de sécurité » — aucun détail, aucune reproduction — et j'ouvrirai un
   canal privé.

Indiquez si possible : la version du panel et des agents, le mode d'installation (installeur en une
commande, archive, Docker), le mode d'accès (Tailscale, direct, reverse proxy manuel), ce dont
l'attaquant a besoin au départ (rien ? un compte `viewer` ? une machine appairée ?), et une
reproduction. La sortie de `mmo-panel doctor` est souvent utile.

**Ce à quoi vous pouvez vous attendre.** Je suis seul mainteneur, sur mon temps libre : aucun
engagement de délai ne serait honnête ici. Concrètement : j'accuse réception dès que je lis le
signalement, et je vous dis franchement si je compte corriger, quand, et dans quelle version. Si le
signalement est valable et que vous voulez être crédité, vous l'êtes dans les notes de release.

Merci de ne pas lancer de scanner automatisé contre un panel qui n'est pas le vôtre, et de ne pas
tester sur les serveurs d'autrui. Une installation locale tient en une commande.

## Périmètre

**Dans le périmètre** — tout ce qui permet de faire plus que ce à quoi on a droit :

- atteindre `/api/*` ou `/ws/*` sans session, ou contourner le rôle exigé par une route ;
- passer d'un rôle à un autre (`viewer` → `operator` → `admin`) ;
- sortir du jail de fichiers par serveur de l'agent, ou écrire hors des dossiers d'un serveur ;
- détourner l'appairage pour rattacher une machine, ou en reprendre une existante ;
- forger ou rejouer des messages sur le WebSocket panel↔agent, ou mettre en défaut la signature
  Ed25519 qui protège la chaîne de mise à jour de l'agent ;
- une fuite de secret là où il ne doit pas apparaître : réponses d'API, journaux, commandes
  d'installation, sauvegardes ;
- une exécution de code à distance depuis une position non authentifiée.

**Hors périmètre** — connus, documentés et assumés. Les signaler n'apporte rien :

- **Un administrateur peut tout faire.** Lancer des processus, lire et écrire les fichiers des
  serveurs, installer un JRE, passer des commandes console : c'est le produit, pas un défaut. Idem
  pour un `operator` sur les serveurs qui lui sont ouverts.
- **Un panel pilote ses agents par construction.** Un agent fait confiance au panel avec lequel il
  s'est appairé : c'est le canal de commande. « Si je compromets le panel je contrôle les agents »
  décrit l'architecture.
- La dette résiduelle documentée en `docs/03-socle-technique.md` §6, acceptée pour la 1.0, et qui
  exige dans tous les cas un compte authentifié : pas de filtre SSRF sur `fs.fetch` (un opérateur
  peut viser une adresse locale ou du tailnet), regex non bornée dans `logs.search` (ReDoS),
  injection de `\n` dans les commandes générées par un `config.set` à chaud, pas de compteur d'usage
  sur le relais de migration, pas de limite de débit sur les archives d'agent publiques.
- Le **mode d'accès manuel** avec un certificat auto-signé ou une CA privée : c'est le choix de
  l'exploitant, et le guide dit ce qu'il coûte.
- Tout ce qui suppose un accès local ou physique à la machine qui fait tourner le panel — quiconque
  y est déjà sous le compte du panel a la base de données.
- Les vulnérabilités de Minecraft lui-même, des mods ou plugins que vous installez, ou des runtimes
  Java que l'agent télécharge chez Adoptium et Azul. À signaler à leurs auteurs.
- L'absence d'en-têtes de sécurité sur les fichiers statiques du front, l'absence de limite de débit
  sur des routes qui ne contiennent rien, et les rapports de scanner sans reproduction.

## Ce que le projet fait déjà

Pour que vous sachiez ce qui est en place, et ce qui ne l'est pas : les sessions sont des jetons
aléatoires de 256 bits stockés hachés, les mots de passe utilisent argon2id, chaque route refuse par
défaut et déclare un rôle minimal, le login est limité par adresse et par compte avec un chemin
d'échec à temps constant, le panel n'écoute que sur `127.0.0.1` (`0.0.0.0` est refusé au démarrage,
sauf opt-in explicite pour les conteneurs), et l'agent refuse de considérer son propre dossier
d'état ou d'installation comme un dossier de serveur.

La signature Ed25519 des bundles de release protège la **chaîne de mise à jour de l'agent** — ce
n'est pas une signature de l'archive qu'un humain télécharge. Pour vérifier un téléchargement,
utilisez le manifeste `panel-<plateforme>.json` publié avec chaque release : il porte l'empreinte
SHA-256 attendue.
