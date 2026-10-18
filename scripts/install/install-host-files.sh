#!/usr/bin/env bash
#
# install-host-files.sh — Install the FlexServer host-files helper as a systemd service.
#
# Usage:
#   sudo ./scripts/install/install-host-files.sh --binary <path> --api-uid-gid <UID:GID> [options]
#
# Options:
#   --binary <path>         Path to host-files binary (required unless --uninstall).
#   --api-uid-gid <UID:GID> UID and GID of the API runtime (e.g. 1000:1000, required unless --uninstall).
#   --socket-path <path>    Unix domain socket path (default: /var/run/flexserver/host-files/files.sock).
#   --dry-run               Print actions without making changes.
#   --uninstall             Stop, disable and remove helper binary, service and runtime directory.
#   --help                  Show this help.
#

set -euo pipefail
umask 022

BINARY_PATH=""
API_UID_GID=""
SOCKET_PATH="/var/run/flexserver/host-files/files.sock"
DRY_RUN=false
UNINSTALL=false
INSTALL_BIN="/usr/local/bin/flexserver-host-files"
SERVICE_NAME="flexserver-host-files.service"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      BINARY_PATH="${2:-}"
      shift 2
      ;;
    --api-uid-gid)
      API_UID_GID="${2:-}"
      shift 2
      ;;
    --socket-path)
      SOCKET_PATH="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    --help)
      sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      exit 1
      ;;
  esac
done

if [[ "$UNINSTALL" == true ]]; then
  echo "Uninstalling ${SERVICE_NAME}..."
  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] systemctl stop ${SERVICE_NAME}"
    echo "[dry-run] systemctl disable ${SERVICE_NAME}"
    echo "[dry-run] rm -f ${UNIT_PATH}"
    echo "[dry-run] systemctl daemon-reload"
    echo "[dry-run] rm -f ${INSTALL_BIN}"
    echo "[dry-run] rm -rf /run/flexserver/host-files /var/run/flexserver/host-files"
    exit 0
  fi

  if [[ $EUID -ne 0 ]]; then
    echo "Error: Root privileges required for uninstall." >&2
    exit 1
  fi

  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${UNIT_PATH}"
  systemctl daemon-reload 2>/dev/null || true
  rm -f "${INSTALL_BIN}"
  rm -rf /run/flexserver/host-files /var/run/flexserver/host-files
  echo "✓ Successfully uninstalled ${SERVICE_NAME} and helper binary."
  exit 0
fi

if [[ -z "$BINARY_PATH" ]]; then
  echo "Error: --binary <path> is required." >&2
  exit 1
fi

if [[ ! -f "$BINARY_PATH" && "$DRY_RUN" == false ]]; then
  echo "Error: Binary not found at '$BINARY_PATH'" >&2
  exit 1
fi

if [[ -z "$API_UID_GID" ]]; then
  echo "Error: --api-uid-gid <UID:GID> is required." >&2
  exit 1
fi

if ! [[ "$API_UID_GID" =~ ^[0-9]+:[0-9]+$ ]]; then
  echo "Error: --api-uid-gid must be in format <UID:GID> (e.g. 1000:1000), got '$API_UID_GID'" >&2
  exit 1
fi

API_UID="${API_UID_GID%%:*}"
API_GID="${API_UID_GID#*:}"

if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] Install binary from '$BINARY_PATH' to '$INSTALL_BIN' (mode 0750, root:root)"
  echo "[dry-run] Create systemd unit at '$UNIT_PATH'"
  echo "[dry-run] Reload systemd daemon and enable/start ${SERVICE_NAME}"
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Error: Root privileges required for installation." >&2
  exit 1
fi

# Stop existing service if running during upgrade
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  echo "Stopping existing ${SERVICE_NAME} for upgrade..."
  systemctl stop "${SERVICE_NAME}"
fi

# Atomic binary replacement
TMP_BIN="${INSTALL_BIN}.tmp.$$"
cp "$BINARY_PATH" "$TMP_BIN"
chmod 0750 "$TMP_BIN"
chown root:root "$TMP_BIN"
mv -f "$TMP_BIN" "$INSTALL_BIN"

# Write systemd unit
cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=FlexServer Host Files Helper
Documentation=https://github.com/vps-manager/vps-manager
After=network.target

[Service]
Type=simple
User=root
Group=${API_GID}
RuntimeDirectory=flexserver/host-files
RuntimeDirectoryMode=0750
ExecStartPost=/bin/chown root:${API_GID} /run/flexserver/host-files
ExecStartPost=/bin/chmod 0750 /run/flexserver/host-files
ExecStart=${INSTALL_BIN} -socket ${SOCKET_PATH} -socket-mode 0660 -socket-uid ${API_UID} -socket-gid ${API_GID}
Restart=on-failure
RestartSec=2s
KillMode=process

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "${UNIT_PATH}"

# Reload and start service
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "✓ Successfully installed and started ${SERVICE_NAME}"
