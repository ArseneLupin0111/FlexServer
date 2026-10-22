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
#   --api-url <url>           Base URL of the vps-manager API (e.g. https://api.flexserver.com)
#   --token <token>           Scoped bearer credential (vma_...)
#   --token-file <path>       Path to file containing scoped bearer credential
#   --pubkey <key>            Pinned Ed25519 public key (PEM or base64)
#   --pubkey-file <path>      Path to pinned Ed25519 public key PEM
#   --vps-id <id>             Trusted VPS ID
#   --binary <path>           Path to vps-updater binary to install
#   --agent-binary <path>     Fixed agent binary path (default: /usr/local/bin/vps-manager-agent)
#   --agent-unit <unit>       Fixed agent systemd unit name (default: derived from vps-id)
#   --manifest <path>         Optional release manifest envelope to verify upfront
#   --dest <path>             Binary install destination (default: /usr/local/lib/vps-manager-agent/vps-updater)
#   --config-dest <path>      Config destination (default: /etc/vps-updater/config.json)
#   --key-dest <path>         Key destination (default: /etc/vps-updater/fleet-release.pub)
#   --dry-run                 Echo actions without modifying filesystem or services
#   --skip-systemd            Skip systemctl daemon-reload/start (for containers or test harnesses)
#   --help                    Show this help

set -euo pipefail
umask 022

API_URL=""
TOKEN=""
TOKEN_FILE=""
PUBKEY=""
PUBKEY_FILE=""
VPS_ID=""
BINARY_SRC=""
AGENT_BINARY="/usr/local/bin/vps-manager-agent"
AGENT_UNIT=""
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
if [[ -z "$PUBKEY" && -z "$PUBKEY_FILE" ]]; then
  echo "Error: either --pubkey or --pubkey-file is required" >&2; exit 1
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

# Upfront manifest verification if provided
if [[ -n "$MANIFEST_SRC" ]]; then
  if [[ ! -f "$MANIFEST_SRC" ]]; then
    echo "Error: manifest file not found: $MANIFEST_SRC" >&2; exit 1
  fi
  chmod +x "$BINARY_SRC" 2>/dev/null || true
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

run chown -R root:"$SERVICE_USER" "$STATE_DIR"
run chmod 0770 "$STATE_DIR" "$STATE_DIR/pending" "$STATE_DIR/results" "$STATE_DIR/staging"
run chown -R root:root "$STATE_DIR/helper"
run chmod 0755 "$STATE_DIR/helper" "$STATE_DIR/helper/backups"

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

echo "[Install] Installing configuration..."
if [[ "$DRY_RUN" == "false" ]]; then
  cat > "$CONFIG_FILE" <<EOF
{
  "apiBase": "${API_URL}",
  "credential": "${TOKEN}",
  "vpsId": "${VPS_ID}",
  "agentBinary": "${AGENT_BINARY}",
  "agentUnit": "${AGENT_UNIT}",
  "fleetReleasePublicKeyFile": "${KEY_FILE}",
  "stateDir": "${STATE_DIR}"
}
EOF
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
if [[ "$BINARY_DEST" != "/usr/local/bin/vps-updater" ]]; then
  run mkdir -p /usr/local/bin
  run ln -sf "$BINARY_DEST" /usr/local/bin/vps-updater
fi

echo "[Install] Installing systemd units..."
DAEMON_UNIT_PATH="/etc/systemd/system/vps-updater.service"
PATH_UNIT_PATH="/etc/systemd/system/vps-updater-apply.path"
APPLY_UNIT_PATH="/etc/systemd/system/vps-updater-apply.service"

if [[ "$DRY_RUN" == "false" ]]; then
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
ReadWritePaths=${STATE_DIR} /usr/local/bin /usr/local/lib /usr/local/share /etc/flexserver-ai /var/lib/flexserver-ai /run/vps-manager-agent /etc/tmpfiles.d
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
UNIT

  chmod 0644 "$DAEMON_UNIT_PATH" "$PATH_UNIT_PATH" "$APPLY_UNIT_PATH"
fi

if [[ "$SKIP_SYSTEMD" == "false" && "$DRY_RUN" == "false" ]]; then
  if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
    echo "[Install] Reloading systemd and enabling services..."
    systemctl daemon-reload
    systemctl enable --now vps-updater-apply.path || true
    systemctl enable --now vps-updater.service || true
    echo "[Install] Fleet updater service successfully enabled and started."
  else
    echo "[Install] Systemd not active in environment; skipping systemctl enable."
  fi
fi
if [[ -n "$TOKEN_FILE" && -f "$TOKEN_FILE" ]]; then
  rm -f "$TOKEN_FILE"
fi

echo "[Install] Done. Fleet updater installed at ${BINARY_DEST}."
