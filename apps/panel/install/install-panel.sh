#!/bin/sh
# MinecraftManagerOnline — installation du PANEL sous Linux (systemd). POSIX sh.
#
#   curl -fsSL https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest/download/install-panel.sh | sh
#
# Un seul copier-coller : téléchargement de la release GitHub, vérification sha256, code dans
# /opt/mmo-panel (remplacé à chaque mise à jour), données dans /var/lib/mmo-panel (jamais touchées),
# réglages dans /etc/mmo-panel/panel.env (jamais écrasé), service systemd durci, attente de
# /api/health. Relancer la même commande met à jour (sauvegarde d'abord, retour arrière si la
# nouvelle version ne démarre pas).
#
# Options :
#   --archive FICHIER    installation hors ligne depuis mmo-panel-<v>-<plateforme>.tar.gz
#   --version X.Y.Z      installe cette version précise (défaut : la dernière release)
#   --dir DIR            dossier du code (défaut : /opt/mmo-panel)
#   --data-dir DIR       dossier des données (défaut : /var/lib/mmo-panel)
#   --user NOM           compte qui exécute le panel (défaut : mmo, créé si absent)
#   --repo OWNER/NAME    dépôt GitHub source (défaut : Zlababababan/MinecraftManagerOnline)
#   --no-service         fichiers seulement (pas de service, pas de root si les dossiers sont à vous)
#   --update             met à jour (refuse s'il n'y a pas d'installation existante)
#   --migrate-data       déplace les données d'un ancien emplacement (ex. <dir>/data) vers --data-dir,
#                        avec integrity_check ; l'ancien dossier n'est supprimé qu'après un
#                        redémarrage sain
#   --uninstall          arrête et supprime le service et le code (--purge : les données aussi)
#
# Règle absolue : ce script ne lit JAMAIS stdin (en `curl | sh`, stdin EST le script).
set -eu

REPO="Zlababababan/MinecraftManagerOnline"
ARCHIVE=""
WANT_VERSION=""
INSTALL_DIR=""
DATA_DIR=""
RUN_USER=""
NO_SERVICE=0
UPDATE=0
MIGRATE=0
UNINSTALL=0
PURGE=0
SERVICE_NAME="mmo-panel"
ENV_FILE="/etc/mmo-panel/panel.env"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"

say() { printf '%s\n' "[mmo] $*"; }
die() { printf '%s\n' "[mmo] ERREUR : $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --archive=*) ARCHIVE="${1#*=}"; shift ;;
    --version) WANT_VERSION="$2"; shift 2 ;;
    --version=*) WANT_VERSION="${1#*=}"; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --update) UPDATE=1; shift ;;
    --migrate-data) MIGRATE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,26p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done

[ -n "$INSTALL_DIR" ] || INSTALL_DIR="/opt/mmo-panel"
[ -n "$DATA_DIR" ] || DATA_DIR="/var/lib/mmo-panel"
[ -n "$RUN_USER" ] || RUN_USER="mmo"
RELEASE_BASE="https://github.com/$REPO/releases"

# --- Plateforme -------------------------------------------------------------------------------
[ "$(uname -s)" = Linux ] || die "ce script installe le panel sous Linux ; Windows : install-panel.ps1, macOS : guide §1.2/§1.4"
case "$(uname -m)" in
  x86_64|amd64) PLATFORM="linux-x64" ;;
  aarch64|arm64) PLATFORM="linux-arm64" ;;
  *) die "architecture non prise en charge : $(uname -m)" ;;
esac
if ls /lib/ld-musl-* >/dev/null 2>&1 || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
  die "libc musl détectée (Alpine ?) : le runtime Node embarqué exige la glibc — utilisez une distribution glibc (Debian, Ubuntu, Fedora…) ou votre propre Node ≥ 24 (guide §1.1)"
fi

# --- Droits (jamais de prompt : sudo parle au terminal, pas à stdin) --------------------------
if [ "$(id -u)" != 0 ] && [ "$NO_SERVICE" != 1 ]; then
  command -v sudo >/dev/null 2>&1 || die "droits root requis (sudo absent) : relancez en root"
  say "droits administrateur requis pour installer le service (sudo)…"
  if [ -f "$0" ] && [ "$0" != "sh" ] && [ "$0" != "-sh" ]; then
    SELF="$0"
  else
    SELF="$(mktemp)"
    curl -fsSL "$RELEASE_BASE/latest/download/install-panel.sh" > "$SELF" 2>/dev/null \
      || curl -fsSL "https://raw.githubusercontent.com/$REPO/main/apps/panel/install/install-panel.sh" > "$SELF" \
      || die "impossible de retélécharger install-panel.sh"
  fi
  ARGS=""
  [ -n "$ARCHIVE" ] && ARGS="$ARGS --archive $ARCHIVE"
  [ -n "$WANT_VERSION" ] && ARGS="$ARGS --version $WANT_VERSION"
  [ "$UPDATE" = 1 ] && ARGS="$ARGS --update"
  [ "$MIGRATE" = 1 ] && ARGS="$ARGS --migrate-data"
  [ "$UNINSTALL" = 1 ] && ARGS="$ARGS --uninstall"
  [ "$PURGE" = 1 ] && ARGS="$ARGS --purge"
  # shellcheck disable=SC2086
  exec sudo sh "$SELF" --repo "$REPO" --dir "$INSTALL_DIR" --data-dir "$DATA_DIR" --user "$RUN_USER" $ARGS
fi

HAVE_SYSTEMD=0
command -v systemctl >/dev/null 2>&1 && HAVE_SYSTEMD=1
stop_service() {
  [ "$HAVE_SYSTEMD" = 1 ] && [ -f "$UNIT_PATH" ] && systemctl stop "$SERVICE_NAME" 2>/dev/null || true
}

# --- Où sont les données de l'installation existante ? ----------------------------------------
# L'unit porte le défaut, panel.env peut le surcharger — panel.env prime (comme pour systemd).
effective_data_dir() {
  D=""
  [ -f "$UNIT_PATH" ] && D="$(sed -n 's/^Environment=MMO_DATA_DIR=//p' "$UNIT_PATH" | head -n 1)"
  E=""
  [ -f "$ENV_FILE" ] && E="$(sed -n 's/^MMO_DATA_DIR=//p' "$ENV_FILE" | head -n 1)"
  [ -n "$E" ] && D="$E"
  # Ancien parcours manuel (guide §1.2) : les données vivent DANS le dossier du code.
  [ -z "$D" ] && [ -f "$INSTALL_DIR/data/mmo.db" ] && D="$INSTALL_DIR/data"
  printf '%s' "$D"
}

env_value() { # env_value <VAR> <défaut> — valeur effective d'un réglage du service
  V=""
  [ -f "$ENV_FILE" ] && V="$(sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1)"
  [ -n "$V" ] && printf '%s' "$V" || printf '%s' "$2"
}

health_url() {
  HH="$(env_value MMO_HOST 127.0.0.1)"
  PP="$(env_value MMO_PORT 3000)"
  case "$HH" in *:*) HH="[$HH]" ;; esac
  printf 'http://%s:%s/api/health' "$HH" "$PP"
}

wait_health() { # wait_health <secondes> <fichier de sortie> — via le runtime embarqué (pas de curl requis)
  "$NODE" -e '
const [url, secs, out] = process.argv.slice(1);
const fs = require("node:fs");
let n = 0;
const tick = () =>
  fetch(url, { signal: AbortSignal.timeout(3000) })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
    .then((t) => { fs.writeFileSync(out, t); process.exit(0); })
    .catch(() => { if (++n >= Number(secs)) process.exit(1); setTimeout(tick, 1000); });
tick();' "$(health_url)" "$1" "$2"
}

show_journal() {
  [ "$HAVE_SYSTEMD" = 1 ] && journalctl -u "$SERVICE_NAME" -n 20 --no-pager 2>/dev/null || true
}

json_field() { # json_field <clé> <fichier> — valeur d'une chaîne/nombre dans un JSON compact
  sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" "$2" | head -n 1
}

find_node() {
  ls -d "$INSTALL_DIR"/runtime/*/bin/node 2>/dev/null | sort | tail -n 1 || true
}

write_unit() { # write_unit <data-dir> — instancie le gabarit versionné embarqué dans l'archive
  TMPL="$INSTALL_DIR/app/install/mmo-panel.service.tmpl"
  [ -f "$TMPL" ] || die "gabarit d'unit absent ($TMPL) : archive antérieure à install-panel.sh — mettez d'abord à jour le panel"
  sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__DATA_DIR__|$1|g" -e "s|__RUN_USER__|$RUN_USER|g" \
    "$TMPL" > "$UNIT_PATH"
  systemctl daemon-reload
}

# --- Désinstallation --------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  CUR_DATA="$(effective_data_dir)"
  [ -n "$CUR_DATA" ] || CUR_DATA="$DATA_DIR"
  say "désinstallation ($INSTALL_DIR)"
  stop_service
  if [ -f "$UNIT_PATH" ]; then
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl daemon-reload 2>/dev/null || true
  fi
  rm -rf "$INSTALL_DIR" "$INSTALL_DIR.old" "$INSTALL_DIR.failed"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$CUR_DATA" /etc/mmo-panel
    say "données supprimées ($CUR_DATA) — les serveurs Minecraft eux-mêmes ne sont jamais touchés"
  else
    say "données conservées dans $CUR_DATA, réglages dans $ENV_FILE (ajoutez --purge pour les supprimer)"
  fi
  say "désinstallation terminée"
  exit 0
fi

command -v tar >/dev/null 2>&1 || die "tar est requis"
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else die "sha256sum ou shasum requis"; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Migration des données (seule, sans réinstallation) ---------------------------------------
if [ "$MIGRATE" = 1 ]; then
  [ -z "$ARCHIVE" ] || die "--migrate-data s'utilise seul (sans --archive)"
  [ -d "$INSTALL_DIR" ] || die "aucune installation dans $INSTALL_DIR"
  SRC="$(effective_data_dir)"
  [ -n "$SRC" ] || die "emplacement actuel des données introuvable (ni unit, ni panel.env, ni $INSTALL_DIR/data)"
  [ "$SRC" != "$DATA_DIR" ] || die "les données sont déjà dans $DATA_DIR"
  [ -f "$SRC/mmo.db" ] || die "pas de base dans $SRC"
  [ ! -f "$DATA_DIR/mmo.db" ] || die "il y a déjà une base dans $DATA_DIR — je refuse d'écraser"
  grep -q '^MMO_DATA_DIR=' "$ENV_FILE" 2>/dev/null && die "MMO_DATA_DIR est surchargé dans $ENV_FILE : retirez-le d'abord (l'unit borne les écritures au dossier choisi ici)"
  NODE="$(find_node)"
  [ -n "$NODE" ] || die "runtime Node introuvable dans $INSTALL_DIR"
  say "migration des données : $SRC → $DATA_DIR"
  stop_service
  mkdir -p "$DATA_DIR"
  cp -a "$SRC/." "$DATA_DIR/"
  "$NODE" -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);const r=db.prepare("PRAGMA integrity_check").get();db.close();if(String(Object.values(r)[0])!=="ok"){console.error(r);process.exit(1);}' "$DATA_DIR/mmo.db" \
    || die "integrity_check en échec sur la copie — l'original ($SRC) n'a pas été touché"
  id "$RUN_USER" >/dev/null 2>&1 && chown -R "$RUN_USER" "$DATA_DIR"
  write_unit "$DATA_DIR"
  systemctl restart "$SERVICE_NAME"
  if wait_health 30 "$TMP/health.json"; then
    rm -rf "$SRC"
    say "migration terminée — ancien dossier supprimé après redémarrage sain ($(json_field version "$TMP/health.json"))"
  else
    write_unit "$SRC"
    systemctl restart "$SERVICE_NAME" 2>/dev/null || true
    show_journal
    die "le panel n'a pas redémarré sur $DATA_DIR — retour à $SRC, la copie reste dans $DATA_DIR"
  fi
  exit 0
fi

# --- Téléchargement / vérification ------------------------------------------------------------
PREV=0
[ -d "$INSTALL_DIR" ] && PREV=1
[ "$UPDATE" = 1 ] && [ "$PREV" = 0 ] && die "--update : aucune installation dans $INSTALL_DIR"

VERSION=""
if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || die "archive introuvable : $ARCHIVE"
  ARCHIVE_PATH="$ARCHIVE"
  say "installation hors ligne depuis $ARCHIVE"
else
  command -v curl >/dev/null 2>&1 || die "curl est requis pour télécharger (ou passez --archive)"
  if [ -n "$WANT_VERSION" ]; then DL="$RELEASE_BASE/download/v$WANT_VERSION"; else DL="$RELEASE_BASE/latest/download"; fi
  curl -fsSL "$DL/panel-$PLATFORM.json" -o "$TMP/panel.json" || die "manifeste panel-$PLATFORM.json introuvable sur $RELEASE_BASE"
  FILE="$(json_field file "$TMP/panel.json")"
  EXPECTED="$(json_field sha256 "$TMP/panel.json")"
  VERSION="$(json_field version "$TMP/panel.json")"
  [ -n "$FILE" ] && [ -n "$EXPECTED" ] || die "manifeste illisible ($DL/panel-$PLATFORM.json)"
  say "téléchargement du panel $VERSION ($PLATFORM)…"
  curl -fL --progress-bar "$DL/$FILE" -o "$TMP/$FILE" || die "téléchargement impossible"
  ACTUAL="$($SHA "$TMP/$FILE" | cut -d' ' -f1)"
  [ "$ACTUAL" = "$EXPECTED" ] || die "empreinte sha256 incorrecte ($ACTUAL ≠ $EXPECTED)"
  ARCHIVE_PATH="$TMP/$FILE"
fi

mkdir -p "$TMP/x"
tar -xzf "$ARCHIVE_PATH" -C "$TMP/x" || die "extraction impossible"
[ -f "$TMP/x/mmo-panel/app/dist/main.js" ] && [ -f "$TMP/x/mmo-panel/mmo-panel.sh" ] || die "archive invalide (app/dist/main.js ou mmo-panel.sh absent)"

# --- Ancien emplacement des données (rétrocompatibilité) --------------------------------------
CUR_DATA=""
if [ "$PREV" = 1 ]; then
  CUR_DATA="$(effective_data_dir)"
fi
LEGACY_DATA=0
if [ "$CUR_DATA" = "$INSTALL_DIR/data" ]; then
  LEGACY_DATA=1
  say "ATTENTION : vos données vivent dans le dossier du code ($INSTALL_DIR/data)."
  say "  Elles sont préservées, mais déplacez-les quand vous voulez : install-panel.sh --migrate-data"
fi
EFFECTIVE_DATA="${CUR_DATA:-$DATA_DIR}"

# --- Compte ------------------------------------------------------------------------------------
if [ "$NO_SERVICE" != 1 ] && ! id "$RUN_USER" >/dev/null 2>&1; then
  say "création du compte système $RUN_USER"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
      || useradd --system --home-dir "$DATA_DIR" --create-home "$RUN_USER"
  else
    adduser -S -D -h "$DATA_DIR" "$RUN_USER"
  fi
fi

# --- Sauvegarde avant remplacement -------------------------------------------------------------
stop_service
if [ "$PREV" = 1 ] && [ -f "$EFFECTIVE_DATA/mmo.db" ]; then
  STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
  mkdir -p "$EFFECTIVE_DATA/backups/panel"
  cp "$EFFECTIVE_DATA/mmo.db" "$EFFECTIVE_DATA/backups/panel/mmo-pre-update-$STAMP.db"
  for F in "$EFFECTIVE_DATA/mmo.db-wal" "$EFFECTIVE_DATA/mmo.db-shm"; do
    [ -f "$F" ] && cp "$F" "$EFFECTIVE_DATA/backups/panel/$(basename "$F" | sed "s/^mmo\.db/mmo-pre-update-$STAMP.db/")" || true
  done
  say "base sauvegardée (backups/panel/mmo-pre-update-$STAMP.db)"
fi

# --- Pose des fichiers (bascule atomique, l'ancien reste en .old) ------------------------------
mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$INSTALL_DIR.new"
mv "$TMP/x/mmo-panel" "$INSTALL_DIR.new"
chmod 755 "$INSTALL_DIR.new/mmo-panel.sh" "$INSTALL_DIR.new"/runtime/*/bin/node
if [ "$PREV" = 1 ]; then
  rm -rf "$INSTALL_DIR.old"
  mv "$INSTALL_DIR" "$INSTALL_DIR.old"
fi
mv "$INSTALL_DIR.new" "$INSTALL_DIR"
if [ "$LEGACY_DATA" = 1 ] && [ -d "$INSTALL_DIR.old/data" ]; then
  mv "$INSTALL_DIR.old/data" "$INSTALL_DIR/data"
fi
NODE="$(find_node)"
[ -n "$NODE" ] || die "runtime Node absent de l'archive"
say "fichiers installés dans $INSTALL_DIR ($("$NODE" --version))"

rollback() {
  say "retour à la version précédente…"
  stop_service
  mv "$INSTALL_DIR" "$INSTALL_DIR.failed"
  mv "$INSTALL_DIR.old" "$INSTALL_DIR"
  if [ "$LEGACY_DATA" = 1 ] && [ -d "$INSTALL_DIR.failed/data" ]; then
    mv "$INSTALL_DIR.failed/data" "$INSTALL_DIR/data"
  fi
  systemctl restart "$SERVICE_NAME" 2>/dev/null || true
}

# --- Fichiers seulement ------------------------------------------------------------------------
if [ "$NO_SERVICE" = 1 ]; then
  say "pas de service (--no-service). Lancement manuel :"
  say "  MMO_DATA_DIR=$EFFECTIVE_DATA $INSTALL_DIR/mmo-panel.sh"
  exit 0
fi

# --- Réglages (jamais écrasés) + données + unit ------------------------------------------------
[ "$HAVE_SYSTEMD" = 1 ] || die "systemd introuvable : utilisez --no-service et votre superviseur"
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p /etc/mmo-panel
  cat > "$ENV_FILE" <<EOF
# MinecraftManagerOnline — réglages du panel, lus par le service systemd (EnvironmentFile).
# Jamais écrasé par les mises à jour. Après modification : systemctl restart mmo-panel
# MMO_DATA_DIR ne se règle PAS ici : install-panel.sh --migrate-data --data-dir <dir>
# (l'unit borne les écritures au dossier choisi à l'installation).
#MMO_HOST=127.0.0.1
#MMO_PORT=3000
#MMO_LOG_LEVEL=info
EOF
fi
mkdir -p "$EFFECTIVE_DATA"
chown -R "$RUN_USER" "$EFFECTIVE_DATA"
write_unit "$EFFECTIVE_DATA"
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || systemctl enable "$SERVICE_NAME"
# `enable --now` ne redémarre PAS un service déjà actif : restart explicite, sinon l'ancien code
# continuerait de tourner en croyant la mise à jour faite.
systemctl restart "$SERVICE_NAME"

# --- Attente de /api/health + vérification de version ------------------------------------------
if wait_health 45 "$TMP/health.json"; then
  GOT="$(json_field version "$TMP/health.json")"
  if [ -n "$VERSION" ] && [ "$GOT" != "$VERSION" ]; then
    show_journal
    if [ "$PREV" = 1 ]; then rollback; fi
    die "le panel répond en version $GOT au lieu de $VERSION — mise à jour annulée (nouvelle version dans $INSTALL_DIR.failed)"
  fi
else
  show_journal
  if [ "$PREV" = 1 ]; then
    rollback
    if wait_health 30 "$TMP/health2.json"; then
      die "la nouvelle version n'a pas démarré — retour à la précédente réussi ($(json_field version "$TMP/health2.json")). La version en échec est dans $INSTALL_DIR.failed, le journal ci-dessus dit pourquoi"
    fi
    die "la nouvelle version n'a pas démarré, et le retour arrière non plus — journal ci-dessus ; données intactes dans $EFFECTIVE_DATA"
  fi
  die "le panel n'a pas démarré (journal ci-dessus) — diagnostic : sudo -u $RUN_USER MMO_DATA_DIR=$EFFECTIVE_DATA $INSTALL_DIR/mmo-panel.sh doctor"
fi

# --- Fin ---------------------------------------------------------------------------------------
PORT="$(env_value MMO_PORT 3000)"
GOT="$(json_field version "$TMP/health.json")"
say "panel $GOT en service — $(health_url | sed 's|/api/health||')"
say ""
say "depuis un autre appareil :"
say "  tunnel SSH : ssh -L $PORT:127.0.0.1:$PORT <vous>@<cette-machine>   puis http://127.0.0.1:$PORT"
say "  Tailscale  : tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
say ""
say "compte administrateur (première installation) — dans le navigateur, ou sans navigateur :"
say "  sudo -u $RUN_USER MMO_DATA_DIR=$EFFECTIVE_DATA $INSTALL_DIR/mmo-panel.sh setup --username admin --random-password"
say ""
say "réglages : $ENV_FILE · journal : journalctl -u $SERVICE_NAME -f · mise à jour : relancez ce script"
