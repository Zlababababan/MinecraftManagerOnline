#!/bin/sh
# MinecraftManagerOnline — installation de l'agent (Linux : systemd, macOS : launchd). POSIX sh.
#
#   curl -fsSL https://<panel>/install.sh | sh -s -- --pair-code MMOP-XXXX
#
# Options :
#   --pair-code CODE     code d'appairage (page « Ajouter une machine » du panel)
#   --panel URL          URL du panel (défaut : celle qui a servi ce script)
#   --archive FICHIER    installation hors ligne depuis une archive mmo-agent-<v>-<plateforme>.tar.gz
#   --dir DIR            dossier d'installation (défaut : /opt/mmo-agent, ou ~/.local/share/mmo-agent/app en --user-service)
#   --state-dir DIR      état de l'agent (défaut : /var/lib/mmo-agent, ou ~/.local/share/mmo-agent)
#   --user NOM           compte qui exécute l'agent (défaut : mmo, créé si absent ; macOS : l'utilisateur courant)
#   --user-service       service utilisateur sans root (systemd --user + linger ; macOS : LaunchAgent)
#   --no-service         fichiers seulement (pas de service)
#   --uninstall          arrête et supprime le service et les fichiers (--purge : l'état aussi)
#
# Le superviseur ne tue jamais l'arbre de processus (KillMode=process / AbandonProcessGroup) :
# les serveurs Minecraft survivent à l'arrêt de l'agent (doc 03 §3).
set -eu

PANEL="__PANEL_URL__"
PAIR_CODE=""
ARCHIVE=""
INSTALL_DIR=""
STATE_DIR=""
RUN_USER=""
USER_SERVICE=0
NO_SERVICE=0
UNINSTALL=0
PURGE=0
SERVICE_NAME="mmo-agent"
LAUNCHD_LABEL="com.mmo.agent"

say() { printf '%s\n' "[mmo] $*"; }
die() { printf '%s\n' "[mmo] ERREUR : $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --pair-code) PAIR_CODE="$2"; shift 2 ;;
    --pair-code=*) PAIR_CODE="${1#*=}"; shift ;;
    --panel) PANEL="$2"; shift 2 ;;
    --panel=*) PANEL="${1#*=}"; shift ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --user-service) USER_SERVICE=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done

case "$PANEL" in
  __*|"") [ "$UNINSTALL" = 1 ] || [ -n "$ARCHIVE" ] || die "URL du panel inconnue : passez --panel https://…" ;;
esac
PANEL="${PANEL%/}"

# --- Plateforme -------------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux) PLATFORM_OS="linux" ;;
  Darwin) PLATFORM_OS="darwin" ;;
  *) die "système non pris en charge : $OS" ;;
esac
case "$ARCH" in
  x86_64|amd64) PLATFORM_ARCH="x64" ;;
  aarch64|arm64) PLATFORM_ARCH="arm64" ;;
  *) die "architecture non prise en charge : $ARCH" ;;
esac
PLATFORM="$PLATFORM_OS-$PLATFORM_ARCH"
[ "$PLATFORM" = "darwin-x64" ] && die "macOS Intel n'est pas packagé (plateformes : linux-x64, linux-arm64, darwin-arm64, win-x64)"

# --- Mode (système / utilisateur) et chemins --------------------------------------------------
if { [ "$USER_SERVICE" = 1 ] || [ "$NO_SERVICE" = 1 ]; } && [ "$(id -u)" != 0 ]; then
  HOME_DIR="${HOME:-$(cd ~ && pwd)}"
  [ -n "$INSTALL_DIR" ] || INSTALL_DIR="${XDG_DATA_HOME:-$HOME_DIR/.local/share}/mmo-agent/app"
  [ -n "$STATE_DIR" ] || STATE_DIR="${XDG_DATA_HOME:-$HOME_DIR/.local/share}/mmo-agent"
  [ -n "$RUN_USER" ] || RUN_USER="$(id -un)"
  SYSTEM_MODE=0
else
  SYSTEM_MODE=1
  [ -n "$INSTALL_DIR" ] || INSTALL_DIR="/opt/mmo-agent"
  [ -n "$STATE_DIR" ] || STATE_DIR="/var/lib/mmo-agent"
  if [ -z "$RUN_USER" ]; then
    if [ "$PLATFORM_OS" = darwin ]; then RUN_USER="${SUDO_USER:-$(id -un)}"; else RUN_USER="mmo"; fi
  fi
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "droits root requis (sudo absent) : relancez en root, ou utilisez --user-service"
    say "droits administrateur requis pour installer le service (sudo)…"
    if [ -f "$0" ] && [ "$0" != "sh" ] && [ "$0" != "-sh" ]; then
      SELF="$0"
    else
      SELF="$(mktemp)"; curl -fsSL "$PANEL/install.sh" > "$SELF" || die "impossible de retélécharger install.sh depuis $PANEL"
    fi
    ARGS=""
    [ -n "$PAIR_CODE" ] && ARGS="$ARGS --pair-code $PAIR_CODE"
    [ -n "$ARCHIVE" ] && ARGS="$ARGS --archive $ARCHIVE"
    [ "$UNINSTALL" = 1 ] && ARGS="$ARGS --uninstall"
    [ "$PURGE" = 1 ] && ARGS="$ARGS --purge"
    # shellcheck disable=SC2086
    exec sudo sh "$SELF" --panel "$PANEL" --dir "$INSTALL_DIR" --state-dir "$STATE_DIR" --user "$RUN_USER" $ARGS
  fi
fi

NODE_BIN=""
find_node() {
  NODE_BIN="$(ls -d "$INSTALL_DIR"/runtime/*/bin/node 2>/dev/null | sort | tail -n 1 || true)"
}

# --- Service : helpers ------------------------------------------------------------------------
SYSTEMCTL=""
if [ "$PLATFORM_OS" = linux ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$SYSTEM_MODE" = 1 ]; then SYSTEMCTL="systemctl"; else SYSTEMCTL="systemctl --user"; fi
fi
UNIT_PATH=""
if [ "$PLATFORM_OS" = linux ]; then
  if [ "$SYSTEM_MODE" = 1 ]; then UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"; else UNIT_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME.service"; fi
else
  if [ "$SYSTEM_MODE" = 1 ]; then UNIT_PATH="/Library/LaunchDaemons/$LAUNCHD_LABEL.plist"; else UNIT_PATH="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"; fi
fi

stop_service() {
  if [ "$PLATFORM_OS" = linux ]; then
    [ -n "$SYSTEMCTL" ] && [ -f "$UNIT_PATH" ] && $SYSTEMCTL stop "$SERVICE_NAME" 2>/dev/null || true
  elif [ -f "$UNIT_PATH" ]; then
    launchctl bootout "$(launchd_domain)" "$UNIT_PATH" 2>/dev/null || launchctl unload "$UNIT_PATH" 2>/dev/null || true
  fi
}
launchd_domain() {
  if [ "$SYSTEM_MODE" = 1 ]; then echo "system"; else echo "gui/$(id -u)"; fi
}

# --- Désinstallation --------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "désinstallation ($INSTALL_DIR)"
  stop_service
  if [ -f "$UNIT_PATH" ]; then
    if [ "$PLATFORM_OS" = linux ] && [ -n "$SYSTEMCTL" ]; then $SYSTEMCTL disable "$SERVICE_NAME" 2>/dev/null || true; fi
    rm -f "$UNIT_PATH"
    [ "$PLATFORM_OS" = linux ] && [ -n "$SYSTEMCTL" ] && $SYSTEMCTL daemon-reload || true
  fi
  rm -rf "$INSTALL_DIR"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$STATE_DIR"
    say "état supprimé ($STATE_DIR) — les serveurs Minecraft eux-mêmes ne sont jamais touchés"
  else
    say "état conservé dans $STATE_DIR (ajoutez --purge pour le supprimer)"
  fi
  say "désinstallation terminée"
  exit 0
fi

# --- Téléchargement / vérification ----------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
command -v tar >/dev/null 2>&1 || die "tar est requis"
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else die "sha256sum ou shasum requis"; fi

json_field() { # json_field <clé> <fichier>  — valeur d'une chaîne/nombre dans un JSON compact
  sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" "$2" | head -n 1
}

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || die "archive introuvable : $ARCHIVE"
  ARCHIVE_PATH="$ARCHIVE"
  say "installation hors ligne depuis $ARCHIVE"
else
  command -v curl >/dev/null 2>&1 || die "curl est requis"
  curl -fsSL "$PANEL/api/dist/$PLATFORM" -o "$TMP/dist.json" || die "aucune archive $PLATFORM publiée sur $PANEL (réglages → distribution)"
  FILE="$(json_field file "$TMP/dist.json")"
  EXPECTED="$(json_field sha256 "$TMP/dist.json")"
  VERSION="$(json_field version "$TMP/dist.json")"
  [ -n "$FILE" ] && [ -n "$EXPECTED" ] || die "réponse inattendue de $PANEL/api/dist/$PLATFORM"
  say "téléchargement de l'agent $VERSION ($PLATFORM)…"
  curl -fL --progress-bar "$PANEL/dist/$FILE" -o "$TMP/$FILE" || die "téléchargement impossible"
  ACTUAL="$($SHA "$TMP/$FILE" | cut -d' ' -f1)"
  [ "$ACTUAL" = "$EXPECTED" ] || die "empreinte sha256 incorrecte ($ACTUAL ≠ $EXPECTED)"
  ARCHIVE_PATH="$TMP/$FILE"
fi

mkdir -p "$TMP/x"
tar -xzf "$ARCHIVE_PATH" -C "$TMP/x" || die "extraction impossible"
[ -f "$TMP/x/mmo-agent/launcher.cjs" ] || die "archive invalide (launcher.cjs absent)"
ARCHIVE_PLATFORM="$(json_field platform "$TMP/x/mmo-agent/manifest.json" || true)"
[ -z "$ARCHIVE_PLATFORM" ] || [ "$ARCHIVE_PLATFORM" = "$PLATFORM" ] || die "archive $ARCHIVE_PLATFORM sur une machine $PLATFORM"

# --- Compte et dossiers -----------------------------------------------------------------------
if [ "$SYSTEM_MODE" = 1 ] && [ "$PLATFORM_OS" = linux ] && ! id "$RUN_USER" >/dev/null 2>&1; then
  say "création du compte système $RUN_USER"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
      || useradd --system --home-dir "$STATE_DIR" --create-home "$RUN_USER"
  else
    adduser -S -D -h "$STATE_DIR" "$RUN_USER"
  fi
fi

stop_service
mkdir -p "$STATE_DIR" "$(dirname "$INSTALL_DIR")"
rm -rf "$INSTALL_DIR.new"
mv "$TMP/x/mmo-agent" "$INSTALL_DIR.new"
if [ -d "$INSTALL_DIR" ]; then
  # Conserve les versions reçues par `agent.update` (rollback possible) ; le reste vient de l'archive.
  if [ -d "$INSTALL_DIR/versions" ]; then cp -R "$INSTALL_DIR/versions/." "$INSTALL_DIR.new/versions/" 2>/dev/null || true; fi
  rm -rf "$INSTALL_DIR.old"; mv "$INSTALL_DIR" "$INSTALL_DIR.old"
fi
mv "$INSTALL_DIR.new" "$INSTALL_DIR"
rm -rf "$INSTALL_DIR.old"
chmod 755 "$INSTALL_DIR/launcher.cjs" "$INSTALL_DIR"/runtime/*/bin/node
if [ "$SYSTEM_MODE" = 1 ]; then chown -R "$RUN_USER" "$INSTALL_DIR" "$STATE_DIR"; fi
find_node
[ -n "$NODE_BIN" ] || die "runtime Node absent de l'archive"
VERSION="$(json_field version "$INSTALL_DIR/current.json")"
say "fichiers installés dans $INSTALL_DIR (agent $VERSION, $("$NODE_BIN" --version))"

# --- Appairage --------------------------------------------------------------------------------
WS_URL="$(printf '%s' "$PANEL" | sed 's#^http://#ws://#; s#^https://#wss://#')/ws/agent"
run_as_user() {
  if [ "$SYSTEM_MODE" = 1 ] && [ "$(id -un)" != "$RUN_USER" ]; then
    if command -v runuser >/dev/null 2>&1; then runuser -u "$RUN_USER" -- env HOME="$STATE_DIR" "$@"; else sudo -u "$RUN_USER" env HOME="$STATE_DIR" "$@"; fi
  else
    "$@"
  fi
}
if [ -n "$PAIR_CODE" ]; then
  say "appairage avec $PANEL…"
  run_as_user "$NODE_BIN" "$INSTALL_DIR/versions/$VERSION/agent.js" pair --panel "$WS_URL" --pair-code "$PAIR_CODE" --state-dir "$STATE_DIR" \
    || die "appairage refusé — générez un nouveau code dans le panel et relancez la commande"
fi

# --- Service ----------------------------------------------------------------------------------
if [ "$NO_SERVICE" = 1 ]; then
  say "pas de service (--no-service). Lancement manuel :"
  say "  $NODE_BIN $INSTALL_DIR/launcher.cjs run --panel $WS_URL --state-dir $STATE_DIR"
  exit 0
fi

if [ "$PLATFORM_OS" = linux ]; then
  [ -n "$SYSTEMCTL" ] || die "systemd introuvable : utilisez --no-service et votre superviseur (ne tuez jamais l'arbre de processus de l'agent)"
  mkdir -p "$(dirname "$UNIT_PATH")"
  if [ "$SYSTEM_MODE" = 1 ]; then USER_LINE="User=$RUN_USER"; WANTED="multi-user.target"; else USER_LINE=""; WANTED="default.target"; fi
  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=MinecraftManagerOnline agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$USER_LINE
WorkingDirectory=$INSTALL_DIR
Environment=HOME=$STATE_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/launcher.cjs run --panel $WS_URL --state-dir $STATE_DIR
Restart=on-failure
RestartSec=5
# Les serveurs Minecraft (détachés) survivent à l'arrêt de l'agent : jamais control-group (doc 03 §3).
KillMode=process
TimeoutStopSec=60

[Install]
WantedBy=$WANTED
EOF
  $SYSTEMCTL daemon-reload
  $SYSTEMCTL enable --now "$SERVICE_NAME"
  if [ "$SYSTEM_MODE" = 0 ] && command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$RUN_USER" 2>/dev/null || say "loginctl enable-linger a échoué : le service ne démarrera qu'à votre connexion"
  fi
  sleep 2
  $SYSTEMCTL --no-pager --lines=5 status "$SERVICE_NAME" || true
  if [ "$SYSTEM_MODE" = 1 ]; then JOURNAL="journalctl -u $SERVICE_NAME -f"; else JOURNAL="journalctl --user -u $SERVICE_NAME -f"; fi
  say "service $SERVICE_NAME installé ($UNIT_PATH). Journal : $JOURNAL"
else
  mkdir -p "$(dirname "$UNIT_PATH")" "$STATE_DIR"
  cat > "$UNIT_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$INSTALL_DIR/launcher.cjs</string>
    <string>run</string>
    <string>--panel</string><string>$WS_URL</string>
    <string>--state-dir</string><string>$STATE_DIR</string>
  </array>
$( [ "$SYSTEM_MODE" = 1 ] && printf '  <key>UserName</key><string>%s</string>\n' "$RUN_USER" )
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$STATE_DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardOutPath</key><string>$STATE_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/agent.log</string>
</dict>
</plist>
EOF
  [ "$SYSTEM_MODE" = 1 ] && chown root:wheel "$UNIT_PATH" && chmod 644 "$UNIT_PATH"
  launchctl bootstrap "$(launchd_domain)" "$UNIT_PATH" 2>/dev/null || launchctl load -w "$UNIT_PATH"
  say "service $LAUNCHD_LABEL installé ($UNIT_PATH). Journal : $STATE_DIR/agent.log"
fi
say "terminé — la machine apparaît dans le panel sous quelques secondes"
