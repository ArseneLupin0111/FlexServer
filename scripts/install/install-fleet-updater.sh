#!/usr/bin/env bash
# install-fleet-updater.sh — Provision and bootstrap the pull-only fleet updater on a remote host.
#
# Usage:
#   sudo ./scripts/install/install-fleet-updater.sh \
#     --api-url <url> \
#     --token <scoped_token> \
#     --pubkey-file <path_to_pem> \
#     --vps-id <vps_id> \
#     --binary <path_to_vps_updater> \
#     [options]
#
# Options:
#   --source <source>         Provisioning source: "bundled" or "signed" (default: signed)
#   --api-url <url>           Base URL of the vps-manager API (e.g. https://api.flexserver.com)
#   --token <token>           Scoped bearer credential (vma_...)
#   --token-file <path>       Path to file containing scoped bearer credential
#   --pubkey <key>            Pinned Ed25519 public key (PEM or base64, required in signed mode)
#   --pubkey-file <path>      Path to pinned Ed25519 public key PEM (required in signed mode)
#   --vps-id <id>             Trusted VPS ID
#   --binary <path>           Path to vps-updater binary to install
#   --agent-binary <path>     Fixed agent binary path (default: /usr/local/bin/vps-manager-agent)
#   --agent-unit <unit>       Fixed agent systemd unit name (default: derived from vps-id)
#   --agent-state-dir <path>  Host agent state directory (default: /var/lib/vps-manager-agent)
#   --manifest <path>         Optional release manifest envelope to verify upfront
#   --dest <path>             Binary install destination (default: /usr/local/lib/vps-manager-agent/vps-updater)
#   --config-dest <path>      Config destination (default: /etc/vps-updater/config.json)
#   --key-dest <path>         Key destination (default: /etc/vps-updater/fleet-release.pub)
#   --dry-run                 Echo actions without modifying filesystem or services
#   --skip-systemd            Skip systemctl daemon-reload/start (for containers or test harnesses)
#   --help                    Show this help
set -euo pipefail
umask 022

SOURCE="signed"
API_URL=""
TOKEN=""
TOKEN_FILE=""
PUBKEY=""
PUBKEY_FILE=""
VPS_ID=""
BINARY_SRC=""
AGENT_BINARY="/usr/local/bin/vps-manager-agent"
AGENT_UNIT=""
AGENT_STATE_DIR="/var/lib/vps-manager-agent"
EXPLICIT_AGENT_STATE_DIR=""
EXPLICIT_AGENT_BINARY=""
MANIFEST_SRC=""
BINARY_DEST="/usr/local/lib/vps-manager-agent/vps-updater"
CONFIG_FILE="/etc/vps-updater/config.json"
KEY_FILE="/etc/vps-updater/fleet-release.pub"
STATE_DIR="/var/lib/vps-updater"
SERVICE_USER="vps-updater"
DRY_RUN=false
SKIP_SYSTEMD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE="$2"; shift 2 ;;
    --agent-state-dir)
      AGENT_STATE_DIR="$2"; EXPLICIT_AGENT_STATE_DIR="$2"; shift 2 ;;
    --agent-binary)
      AGENT_BINARY="$2"; EXPLICIT_AGENT_BINARY="$2"; shift 2 ;;
    --state-dir)
      STATE_DIR="$2"; shift 2 ;;
    --api-url|--api-base)
      API_URL="$2"; shift 2 ;;
    --token|--credential)
      TOKEN="$2"; shift 2 ;;
    --token-file|--credential-file)
      TOKEN_FILE="$2"; shift 2 ;;
    --pubkey)
      PUBKEY="$2"; shift 2 ;;
    --pubkey-file)
      PUBKEY_FILE="$2"; shift 2 ;;
    --vps-id)
      VPS_ID="$2"; shift 2 ;;
    --binary)
      BINARY_SRC="$2"; shift 2 ;;
    --agent-binary)
      AGENT_BINARY="$2"; shift 2 ;;
    --agent-unit)
      AGENT_UNIT="$2"; shift 2 ;;
    --manifest)
      MANIFEST_SRC="$2"; shift 2 ;;
    --dest)
      BINARY_DEST="$2"; shift 2 ;;
    --config-dest)
      CONFIG_FILE="$2"; shift 2 ;;
    --key-dest)
      KEY_FILE="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --skip-systemd)
      SKIP_SYSTEMD=true; shift ;;
    --help|-h)
      sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Error: unknown argument $1" >&2
      exit 1 ;;
  esac
done

if [[ "$DRY_RUN" == "false" && "$(id -u)" -ne 0 ]]; then
  echo "Error: install-fleet-updater.sh requires root (or use --dry-run)" >&2
  exit 1
fi
if [[ "$SOURCE" != "bundled" && "$SOURCE" != "signed" ]]; then
  echo "Error: --source must be 'bundled' or 'signed', got: $SOURCE" >&2
  exit 1
fi

if [[ -z "$API_URL" ]]; then
  echo "Error: --api-url is required" >&2; exit 1
fi
if [[ -n "$TOKEN_FILE" ]]; then
  if [[ ! -f "$TOKEN_FILE" ]]; then
    echo "Error: token file not found: $TOKEN_FILE" >&2; exit 1
  fi
  TOKEN="$(head -n 1 "$TOKEN_FILE" | tr -d '\r\n[:space:]')"
fi

if [[ -z "$TOKEN" ]]; then
  echo "Error: --token or --token-file is required" >&2; exit 1
fi
if [[ -z "$BINARY_SRC" || ! -f "$BINARY_SRC" ]]; then
  echo "Error: valid --binary path is required" >&2; exit 1
fi
if [[ "$SOURCE" == "signed" ]]; then
  if [[ -z "$PUBKEY" && -z "$PUBKEY_FILE" ]]; then
    echo "Error: either --pubkey or --pubkey-file is required in signed mode" >&2; exit 1
  fi
fi

if [[ -n "$PUBKEY_FILE" && ! -f "$PUBKEY_FILE" ]]; then
  echo "Error: public key file not found: $PUBKEY_FILE" >&2; exit 1
fi
# Derive agent unit from VPS ID if omitted
if [[ -z "$AGENT_UNIT" ]]; then
  if [[ -n "$VPS_ID" ]]; then
    # Use sha256 prefix of vps-id for distinct unit name
    HASH_PREFIX=$(echo -n "$VPS_ID" | sha256sum | awk '{print substr($1, 1, 12)}')
    AGENT_UNIT="vps-manager-agent-${HASH_PREFIX}.service"
  else
    AGENT_UNIT="vps-manager-agent.service"
  fi
fi

if [[ -z "$EXPLICIT_AGENT_STATE_DIR" ]]; then
  from_cfg=""
  if [[ -f "$CONFIG_FILE" ]]; then
    if command -v python3 &>/dev/null; then
      from_cfg="$(python3 -c 'import json, sys; d=json.load(open(sys.argv[1])); print(d.get("agentStateDir", ""))' "$CONFIG_FILE" 2>/dev/null || true)"
      if [[ -n "$from_cfg" ]]; then AGENT_STATE_DIR="$from_cfg"; fi
    fi
  fi
  if [[ -z "$from_cfg" ]] && command -v systemctl &>/dev/null; then
    env_state="$(systemctl show -p Environment --value "$AGENT_UNIT" 2>/dev/null | tr ' ' '\n' | grep '^FLEXSERVER_AGENT_STATE_DIR=' | cut -d= -f2- || true)"
    if [[ -n "$env_state" ]]; then
      AGENT_STATE_DIR="$env_state"
    else
      user="$(systemctl show -p User --value "$AGENT_UNIT" 2>/dev/null || true)"
      if [[ -n "$user" && "$user" != "root" ]]; then
        user_home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
        if [[ -n "$user_home" && -d "${user_home}/.flexserver/agent/docker-applications" ]]; then
          AGENT_STATE_DIR="${user_home}/.flexserver/agent"
        fi
      fi
    fi
  fi
fi

if [[ -z "$EXPLICIT_AGENT_BINARY" ]] && command -v systemctl &>/dev/null; then
  bin="$(systemctl show -p ExecStart --value "$AGENT_UNIT" 2>/dev/null | awk '{print $1}' | sed 's/path=//' | tr -d '{};:' || true)"
  if [[ -n "$bin" && -x "$bin" ]]; then
    AGENT_BINARY="$bin"
  fi
fi
if [[ -n "$MANIFEST_SRC" ]]; then
  if [[ ! -f "$MANIFEST_SRC" ]]; then
    echo "Error: manifest file not found: $MANIFEST_SRC" >&2; exit 1
  fi
  VERIFY_CMD=("$BINARY_SRC" "verify" "-manifest" "$MANIFEST_SRC")
  if [[ -n "$PUBKEY_FILE" ]]; then
    VERIFY_CMD+=("-pubkey-file" "$PUBKEY_FILE")
  elif [[ -n "$PUBKEY" ]]; then
    VERIFY_CMD+=("-pubkey" "$PUBKEY")
  fi
  echo "[Verify] Checking release manifest envelope..."
  if ! "${VERIFY_CMD[@]}"; then
    echo "Error: manifest verification failed!" >&2
    exit 1
  fi
  echo "[Verify] Manifest envelope signature and structure verified."
fi

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] $*"
  else
    "$@"
  fi
}

echo "[Install] Configuring user and directories..."
if ! getent group "$SERVICE_USER" &>/dev/null; then
  run groupadd --system "$SERVICE_USER" || true
fi
if ! getent passwd "$SERVICE_USER" &>/dev/null; then
  run useradd --system --no-create-home --shell /sbin/nologin -g "$SERVICE_USER" "$SERVICE_USER" || true
fi

CONFIG_DIR="$(dirname "$CONFIG_FILE")"
KEY_DIR="$(dirname "$KEY_FILE")"
BIN_DIR="$(dirname "$BINARY_DEST")"

run mkdir -p "$CONFIG_DIR" "$KEY_DIR" "$BIN_DIR"
run mkdir -p "$STATE_DIR/pending" "$STATE_DIR/results" "$STATE_DIR/staging" "$STATE_DIR/helper/backups"
run mkdir -p "$AGENT_STATE_DIR/docker-applications"

run chown -R root:"$SERVICE_USER" "$STATE_DIR"
run chmod 0770 "$STATE_DIR" "$STATE_DIR/pending" "$STATE_DIR/results" "$STATE_DIR/staging"
run chown -R root:root "$STATE_DIR/helper"
run chmod 0755 "$STATE_DIR/helper" "$STATE_DIR/helper/backups"
REG_GROUP="$SERVICE_USER"
if getent group vps-manager-agent &>/dev/null; then
  REG_GROUP="vps-manager-agent"
fi
if getent group "$SERVICE_USER" &>/dev/null && getent passwd vps-manager-agent &>/dev/null; then
  run usermod -a -G "$SERVICE_USER" vps-manager-agent 2>/dev/null || true
fi
run mkdir -p "$AGENT_STATE_DIR"
run chown root:"$REG_GROUP" "$AGENT_STATE_DIR"
run chmod 1770 "$AGENT_STATE_DIR"
run mkdir -p "$AGENT_STATE_DIR/docker-applications"
run chown root:"$REG_GROUP" "$AGENT_STATE_DIR/docker-applications"
run chmod 0755 "$AGENT_STATE_DIR/docker-applications"
if [[ -f "$AGENT_STATE_DIR/docker-applications/exclusion.json" ]]; then
  run chown root:"$REG_GROUP" "$AGENT_STATE_DIR/docker-applications/exclusion.json"
  run chmod 0664 "$AGENT_STATE_DIR/docker-applications/exclusion.json"
fi
if [[ -f "$AGENT_STATE_DIR/docker-applications/exclusion.json.lock" ]]; then
  run chown root:"$REG_GROUP" "$AGENT_STATE_DIR/docker-applications/exclusion.json.lock"
  run chmod 0664 "$AGENT_STATE_DIR/docker-applications/exclusion.json.lock"
fi

if [[ -n "$PUBKEY" || -n "$PUBKEY_FILE" ]]; then
  echo "[Install] Installing public key PEM..."
  if [[ "$DRY_RUN" == "false" ]]; then
    if [[ -n "$PUBKEY_FILE" ]]; then
      cp -f "$PUBKEY_FILE" "$KEY_FILE"
    else
      printf '%s\n' "$PUBKEY" > "$KEY_FILE"
    fi
    chmod 0644 "$KEY_FILE"
    chown root:root "$KEY_FILE"
  fi
fi

echo "[Install] Installing configuration..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would write configuration to ${CONFIG_FILE}:"
  if [[ -n "$PUBKEY" || -n "$PUBKEY_FILE" || "$SOURCE" == "signed" ]]; then
    cat <<EOF
{
  "apiBase": "${API_URL}",
  "credential": "${TOKEN}",
  "vpsId": "${VPS_ID}",
  "agentBinary": "${AGENT_BINARY}",
  "agentUnit": "${AGENT_UNIT}",
  "fleetReleasePublicKeyFile": "${KEY_FILE}",
  "stateDir": "${STATE_DIR}",
  "agentStateDir": "${AGENT_STATE_DIR}"
}
EOF
  else
    cat <<EOF
{
  "apiBase": "${API_URL}",
  "credential": "${TOKEN}",
  "vpsId": "${VPS_ID}",
  "agentBinary": "${AGENT_BINARY}",
  "agentUnit": "${AGENT_UNIT}",
  "stateDir": "${STATE_DIR}",
  "agentStateDir": "${AGENT_STATE_DIR}"
}
EOF
  fi
else
  if [[ -n "$PUBKEY" || -n "$PUBKEY_FILE" || "$SOURCE" == "signed" ]]; then
    cat > "$CONFIG_FILE" <<EOF
{
  "apiBase": "${API_URL}",
  "credential": "${TOKEN}",
  "vpsId": "${VPS_ID}",
  "agentBinary": "${AGENT_BINARY}",
  "agentUnit": "${AGENT_UNIT}",
  "fleetReleasePublicKeyFile": "${KEY_FILE}",
  "stateDir": "${STATE_DIR}",
  "agentStateDir": "${AGENT_STATE_DIR}"
}
EOF
  else
    cat > "$CONFIG_FILE" <<EOF
{
  "apiBase": "${API_URL}",
  "credential": "${TOKEN}",
  "vpsId": "${VPS_ID}",
  "agentBinary": "${AGENT_BINARY}",
  "agentUnit": "${AGENT_UNIT}",
  "stateDir": "${STATE_DIR}",
  "agentStateDir": "${AGENT_STATE_DIR}"
}
EOF
  fi
  chown root:"$SERVICE_USER" "$CONFIG_FILE"
  chmod 0640 "$CONFIG_FILE"
fi

echo "[Install] Installing updater binary..."
TMP_BIN="${BINARY_DEST}.tmp.$$"
run cp -f "$BINARY_SRC" "$TMP_BIN"
run chown root:root "$TMP_BIN"
run chmod 0755 "$TMP_BIN"
run mv -f "$TMP_BIN" "$BINARY_DEST"

# Symlink to /usr/local/bin/vps-updater for easy operator access
OPERATOR_SYMLINK_PATH="${FLEET_UPDATER_SYMLINK_PATH:-/usr/local/bin/vps-updater}"
if [[ "$BINARY_DEST" != "$OPERATOR_SYMLINK_PATH" ]]; then
  run mkdir -p "$(dirname "$OPERATOR_SYMLINK_PATH")"
  run ln -sf "$BINARY_DEST" "$OPERATOR_SYMLINK_PATH"
fi

echo "[Install] Installing systemd units..."
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
DAEMON_UNIT_PATH="${SYSTEMD_UNIT_DIR}/vps-updater.service"
PATH_UNIT_PATH="${SYSTEMD_UNIT_DIR}/vps-updater-apply.path"
APPLY_UNIT_PATH="${SYSTEMD_UNIT_DIR}/vps-updater-apply.service"

if [[ "$DRY_RUN" == "false" ]]; then
  run mkdir -p "$SYSTEMD_UNIT_DIR"
  cat > "$DAEMON_UNIT_PATH" <<UNIT
[Unit]
Description=VPS Manager Fleet Updater (pull-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${BINARY_DEST} daemon -config ${CONFIG_FILE}
Restart=always
RestartSec=10

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${STATE_DIR}
ProtectHome=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true

[Install]
WantedBy=multi-user.target
UNIT

  cat > "$PATH_UNIT_PATH" <<UNIT
[Unit]
Description=Watch vps-updater privileged action requests

[Path]
DirectoryNotEmpty=${STATE_DIR}/pending
Unit=vps-updater-apply.service

[Install]
WantedBy=multi-user.target
UNIT

  cat > "$APPLY_UNIT_PATH" <<UNIT
[Unit]
Description=VPS Manager fleet updater privileged helper (fixed operations)

[Service]
Type=oneshot
User=root
Group=root
ExecStart=${BINARY_DEST} helper -config ${CONFIG_FILE}
TimeoutStartSec=300s
UMask=0022

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${STATE_DIR} $(dirname "${AGENT_BINARY}") ${AGENT_STATE_DIR}/docker-applications /run/vps-manager-agent /etc/tmpfiles.d
ProtectHome=read-only
CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_CHOWN
AmbientCapabilities=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true
UNIT

  chmod 0644 "$DAEMON_UNIT_PATH" "$PATH_UNIT_PATH" "$APPLY_UNIT_PATH"
fi

is_systemd_available() {
  if ! command -v systemctl &>/dev/null; then
    return 1
  fi
  local state
  state="$(systemctl is-system-running 2>/dev/null || true)"
  state="$(echo "$state" | tr -d '[:space:]')"
  case "$state" in
    running|degraded|starting|initializing|maintenance)
      return 0
      ;;
    offline)
      return 1
      ;;
    *)
      if [[ -d /run/systemd/system ]]; then
        return 0
      fi
      return 1
      ;;
  esac
}

if [[ "$SKIP_SYSTEMD" == "false" && "$DRY_RUN" == "false" ]]; then
  if is_systemd_available; then
    journal_path="$STATE_DIR/helper/journal.json"
    if [[ -f "$journal_path" ]]; then
      wait_seconds=0
      while grep -Eq '"phase"[[:space:]]*:[[:space:]]*"(intent|renamed)"' "$journal_path" 2>/dev/null; do
        if [[ $wait_seconds -ge 60 ]]; then
          echo "Warning: updater journal still in mutation/recovery after 60s; proceeding with caution." >&2
          break
        fi
        sleep 1
        wait_seconds=$((wait_seconds + 1))
      done
    fi
    echo "[Install] Reloading systemd and enabling/restarting services..."
    if ! systemctl daemon-reload; then
      echo "Error: systemctl daemon-reload failed" >&2
      if [[ -n "$TOKEN_FILE" && -f "$TOKEN_FILE" ]]; then
        rm -f "$TOKEN_FILE"
      fi
      exit 1
    fi
    if ! systemctl enable vps-updater-apply.path vps-updater.service; then
      echo "Error: systemctl enable failed for vps-updater units" >&2
      if [[ -n "$TOKEN_FILE" && -f "$TOKEN_FILE" ]]; then
        rm -f "$TOKEN_FILE"
      fi
      exit 1
    fi
    if ! systemctl restart vps-updater-apply.path; then
      echo "Error: systemctl restart failed for vps-updater-apply.path" >&2
      if [[ -n "$TOKEN_FILE" && -f "$TOKEN_FILE" ]]; then
        rm -f "$TOKEN_FILE"
      fi
      exit 1
    fi
    if ! systemctl restart vps-updater.service; then
      echo "Error: systemctl restart failed for vps-updater.service" >&2
      if [[ -n "$TOKEN_FILE" && -f "$TOKEN_FILE" ]]; then
        rm -f "$TOKEN_FILE"
      fi
      exit 1
    fi
  else
    echo "[Install] Systemd not active in environment; skipping systemctl enable."
  fi
fi
if [[ -n "$TOKEN_FILE" && -f "$TOKEN_FILE" ]]; then
  rm -f "$TOKEN_FILE"
fi

echo "[Install] Done. Fleet updater installed at ${BINARY_DEST}."
