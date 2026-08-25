# FAQ réseau

[English](../network-faq.md) · **Français**

Le panel n'écoute **que** sur `127.0.0.1` (ou une adresse précise via `MMO_HOST`). Trois façons de l'atteindre de l'extérieur ; une seule suffit.

## Tailscale (défaut, recommandé)

**Pourquoi** : fonctionne derrière CGNAT, 4G, wifi d'hôtel, sans ouvrir de port ; certificat HTTPS automatique ; plan gratuit jusqu'à 6 utilisateurs (3 sur certaines offres — vérifiez).

1. Installez [Tailscale](https://tailscale.com/download) sur l'hôte du panel, connectez-vous.
2. Dans le panel, Réglages → Accès distant, mode **Tailscale** : copiez et exécutez la commande affichée, de la forme
   `tailscale serve --bg --https=443 http://127.0.0.1:3000`.
   Activez **MagicDNS** et **HTTPS certificates** dans la console Tailscale si ce n'est pas fait.
3. L'URL publique devient `https://<machine>.<tailnet>.ts.net` : renseignez-la dans Réglages → Général.
4. Sur chaque appareil client (téléphone, PC d'un ami, machine agent distante) : installer Tailscale, se connecter au **même tailnet** (invitez vos amis, ou partagez le nœud).
5. Lancez le **Test de joignabilité** (même écran, bouton **Lancer le test**) : HTTP, WebSocket, frames binaires et certificat TLS (les frames binaires passent par `tailscale serve`).

Agents : la commande d'installation utilise l'URL `https://…ts.net` ; la machine agent doit donc avoir Tailscale. Serveurs Minecraft : exposition **Tailnet**, adresse `100.x.y.z:25565`.

Dépannage : `tailscale status` sur l'hôte ; `tailscale serve status` doit lister le proxy (`No serve config` = la commande serve n'a jamais été lancée — le test de joignabilité échoue alors en « connexion refusée » sur le port 443) ; si le test WebSocket échoue alors que HTTP passe, vérifiez que vous n'avez pas un autre proxy devant (nginx) sans `Upgrade`. Si PowerShell répond que `tailscale` n'est pas reconnu (Windows), la CLI n'est pas dans le PATH : appelez-la par son chemin complet, ex. `& 'C:\Program Files\Tailscale\tailscale.exe' serve …` (à adapter au dossier d'installation).

## Direct (IPv6 + votre domaine)

**Pourquoi** : aucun intermédiaire, vos amis n'installent rien. **Condition** : une IPv6 publique (la plupart des box) — l'IPv4 derrière CGNAT ne suffit pas.

1. Un domaine : gratuit avec **DuckDNS** (`votre-nom.duckdns.org`) ou un domaine chez Cloudflare ; ou tout fournisseur en mode **manuel** (vous posez les enregistrements vous-même).
2. Réglages → Accès distant, mode **Direct** : domaine, fournisseur DNS, jeton (DuckDNS : jeton du site ; Cloudflare : API token `Zone:DNS:Edit`), e-mail ACME. **Enregistrer** puis **Demander un certificat** : le panel pose le TXT `_acme-challenge` (ou vous l'affiche en mode manuel), attend la propagation, obtient un certificat Let's Encrypt et ouvre un listener HTTPS sur votre IPv6 globale, port 443.
3. **DNS dynamique** : interrupteur « Mettre à jour l'AAAA automatiquement » — le panel met à jour l'AAAA toutes les 10 min (DuckDNS/Cloudflare/URL générique). En mode manuel, pointez vous-même l'AAAA sur l'IPv6 affichée.
4. **Box / pare-feu** : sur la box, créez un _pinhole_ IPv6 (Freebox : « Ouvrir un port IPv6 » ; Livebox : « Pare-feu IPv6 ») vers l'adresse de l'hôte, port 443 TCP. Sur l'hôte, ajoutez la règle affichée dans Réglages → Accès distant → **Règles pare-feu** (PowerShell `New-NetFirewallRule` / `ufw allow`). Les adresses IPv6 _temporaires_ (privacy extensions) changent : le panel choisit l'adresse stable vue au tick précédent ; en cas de doute, fixez-la dans « Adresse IPv6 publique ».
5. URL publique : `https://votre-nom.duckdns.org` (Réglages → Général), puis lancez le **Test de joignabilité**.

Serveurs Minecraft : exposition **Direct**, pinhole + règle pare-feu par port de jeu (affichées au même endroit). Les joueurs en IPv4 seul ne pourront pas se connecter : préférez Tailscale pour eux.

Renouvellement : automatique chaque jour si < 30 jours restants, sauf DNS manuel (le panel avertit : relancez la demande de certificat).

## Manuel (reverse-proxy existant)

Faites pointer votre proxy (Caddy, nginx, Traefik…) sur `http://127.0.0.1:3000` **avec support WebSocket** (`Upgrade`/`Connection`) et des frames d'au moins 16 Mo, transmettez `X-Forwarded-Proto` / `X-Forwarded-Host`. Exemple Caddy :

```
panel.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Renseignez l'URL publique et lancez le test de joignabilité : la ligne « Vu via » du résultat indique « un reverse-proxy » si les en-têtes sont bien transmis.

## Questions fréquentes

**L'agent reste `offline` après l'installation.** Sur la machine : journaux — Windows `launcher.log` à la racine de `%LOCALAPPDATA%\Programs\mmo-agent` et journaux du service dans son sous-dossier `logs\`, Linux `journalctl -u mmo-agent -f` (`--user` si installé en `--user-service`), macOS `/var/lib/mmo-agent/agent.log`. Causes usuelles : URL du panel inaccessible depuis cette machine (Tailscale non installé/connecté, pare-feu), certificat non reconnu (mode manuel avec une CA privée : ajoutez-la au magasin système), code d'appairage expiré (le message `pairing failed` est affiché pendant l'installation).

**Le panel est joignable mais le WebSocket échoue.** Un proxy sans `Upgrade` ou avec un _timeout_ d'inactivité court. Le test de joignabilité montre l'étape en échec (HTTP, WebSocket, Frames binaires, Certificat TLS).

**Les notifications push n'arrivent pas.** Elles exigent HTTPS (Tailscale ou Direct) et, sur iOS, l'installation de la PWA sur l'écran d'accueil (Compte → Notifications push guide la procédure ; voir aussi [Installation § 4](installation.md#4-sur-le-téléphone--installer-la-pwa)). Le bouton « Envoyer un test » au même endroit vérifie la chaîne complète.

**Un serveur tombe quand l'agent s'arrête ou se met à jour.** Ne doit pas arriver : les serveurs sont détachés et le service est configuré pour ne tuer que l'agent (`KillMode=process`, `AbandonProcessGroup`, shawl). Si vous avez installé un service à la main, vérifiez ce réglage ; n'utilisez jamais `taskkill /T` sur l'agent.

**IPv4 seulement (pas d'IPv6 sur la box).** Le mode Direct est impossible sans redirection de port IPv4 publique ; utilisez Tailscale.

**Ports.** Panel : 443 entrant (Direct uniquement). Agents : aucun port entrant. Serveurs Minecraft : 25565/TCP (et le port choisi) si mode Direct.
