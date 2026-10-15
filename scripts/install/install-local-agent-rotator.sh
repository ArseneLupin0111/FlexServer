#!/usr/bin/env bash
#
# install-local-agent-rotator.sh — Standalone installer and remediation script
# for the VPS Manager local agent credential rotation helper daemon.
#
# Installs a constrained root systemd daemon that listens on a Unix domain socket
# (/var/run/flexserver/agent-rotation.sock) restricted to the unprivileged API container
# user (uid 100, gid 101). The daemon validates peer OS credentials, validates that the
# requested vpsId matches the host agent configuration, atomically updates only the token
# in /etc/vps-manager-agent/config.json preserving permissions (0640) and group (gid 999),
# and restarts vps-manager-agent.service with automatic rollback on restart failure.
#
# Usage:
#   sudo ./scripts/install/install-local-agent-rotator.sh [options]
#
# Options:
#   --binary <path>       Path to local-agent-rotator binary (optional; auto-located if omitted).
#   --socket-path <path>  Socket path (default: /var/run/flexserver/agent-rotation.sock).
#   --socket-uid <uid>    API container user UID (default: auto-detected or 100).
#   --socket-gid <gid>    API container group GID (default: auto-detected or 101).
#   --config-file <path>  Target agent config file (default: /etc/vps-manager-agent/config.json).
#   --service-name <name> Agent systemd service to restart (default: vps-manager-agent.service).
#   --dry-run             Print planned changes without modifying system.
#   --uninstall           Stop, disable, and remove daemon service and binary.
#   --help                Show this help.

set -euo pipefail
umask 022

SERVICE_NAME="flexserver-local-agent-rotator"
SERVICE_DEST="/usr/local/bin/flexserver-local-agent-rotator"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SOCKET_PATH_DEFAULT="/var/run/flexserver/agent-rotation.sock"
CONFIG_FILE_DEFAULT="/etc/vps-manager-agent/config.json"
AGENT_SERVICE_NAME_DEFAULT="vps-manager-agent.service"

BINARY_SRC=""
SOCKET_PATH="${SOCKET_PATH_DEFAULT}"
SOCKET_UID=""
SOCKET_GID=""
CONFIG_FILE="${CONFIG_FILE_DEFAULT}"
AGENT_SERVICE_NAME="${AGENT_SERVICE_NAME_DEFAULT}"
DRY_RUN=false
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      BINARY_SRC="$2"; shift 2 ;;
    --socket-path)
      SOCKET_PATH="$2"; shift 2 ;;
    --socket-uid)
      SOCKET_UID="$2"; shift 2 ;;
    --socket-gid)
      SOCKET_GID="$2"; shift 2 ;;
    --api-uid-gid)
      SOCKET_UID="${2%%:*}"
      SOCKET_GID="${2##*:}"
      shift 2 ;;
    --config-file)
      CONFIG_FILE="$2"; shift 2 ;;
    --service-name)
      AGENT_SERVICE_NAME="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --uninstall)
      UNINSTALL=true; shift ;;
    --help)
      grep -E '^# ' "$0" | cut -c 3-
      exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Error: This installer must be run as root (e.g. sudo $0)." >&2
  exit 1
fi

# ── Uninstall Mode ──────────────────────────────────────────────────────────
if [[ "$UNINSTALL" == "true" ]]; then
  echo "[Uninstall] Stopping and disabling ${SERVICE_NAME}..."
  if systemctl is-active "${SERVICE_NAME}" &>/dev/null || systemctl is-enabled "${SERVICE_NAME}" &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run: systemctl stop ${SERVICE_NAME}"
      echo "  [DRY-RUN] Would run: systemctl disable ${SERVICE_NAME}"
    else
      systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
      systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
    fi
  fi

  if [[ -f "$UNIT_FILE" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${UNIT_FILE}"
    else
      rm -f "$UNIT_FILE"
      systemctl daemon-reload
    fi
  fi

  if [[ -f "$SERVICE_DEST" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${SERVICE_DEST}"
    else
      rm -f "$SERVICE_DEST"
    fi
  fi

  if [[ -S "$SOCKET_PATH" || -f "$SOCKET_PATH" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${SOCKET_PATH}"
    else
      rm -f "$SOCKET_PATH"
    fi
  fi

  echo "[Uninstall] ${SERVICE_NAME} removed successfully."
  exit 0
fi

# ── Binary Resolution ───────────────────────────────────────────────────────
resolve_binary() {
  if [[ -n "$BINARY_SRC" && -f "$BINARY_SRC" ]]; then
    echo "$BINARY_SRC"
    return 0
  fi

  local candidates=(
    "./packages/agent/dist/local-agent-rotator-linux-amd64"
    "./packages/agent/dist/local-agent-rotator"
    "./packages/agent/cmd/local-agent-rotator/local-agent-rotator"
    "/app/agent/local-agent-rotator-linux-amd64"
    "/usr/local/bin/local-agent-rotator"
  )
  for cand in "${candidates[@]}"; do
    if [[ -f "$cand" ]]; then
      echo "$cand"
      return 0
    fi
  done

  # Try extracting from running API container or docker image if docker is present
  if command -v docker &>/dev/null; then
    local api_container
    api_container="$(docker ps -q --filter "name=api" --filter "status=running" 2>/dev/null | head -n1 || true)"
    if [[ -n "$api_container" ]]; then
      local tmp_extracted
      tmp_extracted="$(mktemp /tmp/rotator-extracted.XXXXXX)"
      if docker cp "${api_container}:/app/agent/local-agent-rotator-linux-amd64" "$tmp_extracted" &>/dev/null; then
        chmod 0755 "$tmp_extracted"
        echo "$tmp_extracted"
        return 0
      fi
      rm -f "$tmp_extracted"
    fi
  fi

  # Fallback: attempt on-the-fly compilation if go is installed
  if command -v go &>/dev/null && [[ -d "./packages/agent/cmd/local-agent-rotator" ]]; then
    local tmp_build
    tmp_build="$(mktemp /tmp/rotator-build.XXXXXX)"
    echo "Compiling local-agent-rotator binary..." >&2
    if (cd ./packages/agent && CGO_ENABLED=0 GOOS=linux go build -o "$tmp_build" ./cmd/local-agent-rotator) &>/dev/null; then
      chmod 0755 "$tmp_build"
      echo "$tmp_build"
      return 0
    fi
    rm -f "$tmp_build"
  fi

  return 1
}

RESOLVED_BINARY=""
if ! RESOLVED_BINARY="$(resolve_binary)"; then
  echo "Error: Could not locate local-agent-rotator binary." >&2
  echo "Specify it explicitly via --binary <path>, or build with 'npm run build:agent'." >&2
  exit 1
fi

# ── API UID/GID Detection ───────────────────────────────────────────────────
if [[ -z "$SOCKET_UID" || -z "$SOCKET_GID" ]]; then
  # Try querying docker container or image if available
  if command -v docker &>/dev/null; then
    DETECTED_UID="$(docker compose exec -T api id -u 2>/dev/null || true)"
    DETECTED_GID="$(docker compose exec -T api id -g 2>/dev/null || true)"
    if [[ -n "$DETECTED_UID" && -n "$DETECTED_GID" ]]; then
      SOCKET_UID="${SOCKET_UID:-$DETECTED_UID}"
      SOCKET_GID="${SOCKET_GID:-$DETECTED_GID}"
    fi
  fi
  # Defaults for production node:24-alpine container app user
  SOCKET_UID="${SOCKET_UID:-100}"
  SOCKET_GID="${SOCKET_GID:-101}"
fi

# ── Install Binary ──────────────────────────────────────────────────────────
echo "[Install] Installing local agent rotation helper daemon..."
echo "  Source binary: ${RESOLVED_BINARY}"
echo "  Destination:   ${SERVICE_DEST}"
echo "  Socket path:   ${SOCKET_PATH}"
echo "  Socket UID/GID:${SOCKET_UID}:${SOCKET_GID}"
echo "  Target config: ${CONFIG_FILE}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would copy ${RESOLVED_BINARY} to ${SERVICE_DEST} (root:root 0755)"
else
  TMP_DEST="${SERVICE_DEST}.tmp.$$"
  cp -f "$RESOLVED_BINARY" "$TMP_DEST"
  chown root:root "$TMP_DEST"
  chmod 0755 "$TMP_DEST"
  mv -f "$TMP_DEST" "$SERVICE_DEST"
fi

# ── Systemd Unit Installation ───────────────────────────────────────────────
SOCKET_DIR="$(dirname "$SOCKET_PATH")"
SOCKET_DIR_NAME="$(basename "$SOCKET_DIR")"
RUNTIME_DIR_LINE=""
if [[ "$SOCKET_DIR_NAME" != "run" && -n "$SOCKET_DIR_NAME" && "$SOCKET_DIR_NAME" != "." && "$SOCKET_DIR_NAME" != "/" ]]; then
  RUNTIME_DIR_LINE="RuntimeDirectory=${SOCKET_DIR_NAME}
RuntimeDirectoryMode=0755"
fi

UNIT_CONTENT=$(cat <<EOF
[Unit]
Description=VPS Manager Local Agent Rotation Helper Daemon
Documentation=https://github.com/sondoan17/vps-manager-nodejs
After=network.target

[Service]
Type=simple
User=root
Group=root
${RUNTIME_DIR_LINE}
ExecStart=${SERVICE_DEST} -server -socket ${SOCKET_PATH} -socket-mode 0660 -socket-uid ${SOCKET_UID} -socket-gid ${SOCKET_GID} -config ${CONFIG_FILE} -service-name ${AGENT_SERVICE_NAME}
Restart=always
RestartSec=5

ProtectKernelTunables=true
ProtectKernelModules=true
ProtectClock=true

[Install]
WantedBy=multi-user.target
EOF
)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would write systemd unit: ${UNIT_FILE}"
  echo "---"
  echo "$UNIT_CONTENT"
  echo "---"
  echo "  [DRY-RUN] Would run: systemctl daemon-reload && systemctl enable ${SERVICE_NAME} && systemctl restart ${SERVICE_NAME}"
else
  mkdir -p "$SOCKET_DIR"
  chmod 0755 "$SOCKET_DIR"

  TMP_UNIT="$(mktemp /tmp/${SERVICE_NAME}.XXXXXX.service)"
  echo "$UNIT_CONTENT" > "$TMP_UNIT"
  chown root:root "$TMP_UNIT"
  chmod 0644 "$TMP_UNIT"
  mv -f "$TMP_UNIT" "$UNIT_FILE"

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  echo "  Started ${SERVICE_NAME}."
fi

# ── Verification ────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" != "true" ]]; then
  sleep 1
  if ! systemctl is-active "${SERVICE_NAME}" &>/dev/null; then
    echo "Warning: ${SERVICE_NAME} is not active. Check journalctl -u ${SERVICE_NAME} -n 20." >&2
    exit 1
  fi
  if [[ ! -S "$SOCKET_PATH" ]]; then
    echo "Warning: Socket ${SOCKET_PATH} does not exist after service start." >&2
    exit 1
  fi
  echo "  Verified ${SERVICE_NAME} running and socket created (${SOCKET_PATH})."
fi

echo ""
echo "[Success] Local agent rotation helper installed and running."
echo "Check status: sudo systemctl status ${SERVICE_NAME}"
echo "View logs:    sudo journalctl -u ${SERVICE_NAME} -f"
