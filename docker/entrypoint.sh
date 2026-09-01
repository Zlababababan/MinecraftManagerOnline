#!/bin/sh
# Point d'entrée du conteneur : `docker run <image>` démarre le panel, `docker run <image> doctor`
# (ou `setup …`, `restore …`) passe la sous-commande au CLI.
set -eu
# Agents embarqués par l'image officielle : servis si présents et si l'utilisateur n'a pas déjà
# pointé MMO_DIST_DIR ailleurs (sans agents, défaut = <dataDir>/dist, sur le volume — le dépôt
# admin y persiste).
if [ -z "${MMO_DIST_DIR:-}" ] && [ -f /app/dist-agent/manifest.json ]; then
  export MMO_DIST_DIR=/app/dist-agent
fi
exec node /app/app/dist/main.js "$@"
