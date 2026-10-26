#!/usr/bin/env bash
# shellcheck disable=SC2317
#
# install-local-agent.sh — Install the VPS Manager agent on the local host.
#
# Usage:
#   sudo ./scripts/install/install-local-agent.sh --binary <path> --config <path> [options]
#
# Options:
#   --binary <path>       Path to the agent binary (required).
#   --config <path>       Path to the agent config JSON file (required).
#   --service-name <name> Systemd service name (default: vps-manager-agent).
#   --service-user <user> System user for the service (default: vps-manager-agent).
#   --dry-run             Print what would be done without making changes.
#   --install-cli         Also install the flexserverctl CLI (default: on).
#   --skip-cli            Do not install the flexserverctl CLI.
#   --cli-source <path>   Path to flexserverctl.py (default: sibling file,
#                         else download from the pinned repository).
#   --cli-dest <path>     CLI install path (default:
#                         /usr/local/bin/flexserverctl).
#   --install-ai          Install and enable isolated AI worker subsystem.
#                         Auto-resolves a packaged AI bundle (executor, host
#                         helper, rootfs tarball + manifest, profiles) from
#                         sibling files of --binary/--config, /app/agent/ai,
#                         or /opt/vps-manager by default.
#   --ai-executor-binary <path>  Override: path to ai-executor binary.
#   --ai-host-helper-binary <path> Override: path to ai-host-helper binary.
#   --ai-rootfs-tar <path>       Override: path to minimal rootfs tarball.
#   --ai-rootfs-manifest <path>  Override: path to rootfs manifest JSON.
#   --ai-profiles-dir <path>     Override: path to root-owned AI profiles dir.
#   --help                Show this help.
#
# This script:
#   1. Installs the agent binary to /usr/local/bin/vps-manager-agent (root:root 0755).
#   2. Creates system user/group vps-manager-agent (no shell).
#   3. Installs config to /etc/vps-manager-agent/config.json (root:vps-manager-agent 0640,
#      dir 0750).
#   4. Writes a hardened systemd unit file.
#   5. Runs systemctl daemon-reload, enable, and start/restart.
#   6. Installs flexserverctl.py to /usr/local/bin/flexserverctl (root:root 0755,
#      atomic, syntax-checked first; requires python3) unless --skip-cli.
#
# On --uninstall: stops, disables, removes unit, binary, config, and the CLI.
# Does NOT remove the API app data (only agent runtime files). Never deletes
# AI host state: the whole /var/lib/flexserver-ai directory (state, receipts,
# scratch, backups) is preserved in place on --uninstall.

set -euo pipefail
umask 077

# ── Early flag scan ───────────────────────────────────────────────────────
# Scanned before the bootstrap below so `--help` and `--dry-run` never touch
# the network or the filesystem: a piped `--dry-run` must make zero writes,
# including the library and CLI downloads.
#
# Scans without mutating positional parameters: a while/shift loop would
# consume the argument list (e.g. --binary/--config values) before the main
# option parser ever sees it, breaking every real invocation.
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --help)
      # Read the header only when genuinely running from a file: in pipe mode
      # $0 can be the interpreter path (a binary), which would dump garbage.
      installer_header=""
      if [[ -r "$0" ]] && IFS= read -r installer_header < "$0" && [[ "$installer_header" == "#!"* ]]; then
        sed -n '4,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      else
        echo "Usage: sudo install-local-agent.sh --binary <path> --config <path> [options]"
        echo "Run this script from a file (clone the repository) to see the full help."
      fi
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
  esac
done

# ── Bootstrap ─────────────────────────────────────────────────────────────
# The documented entry point is `curl … | sudo bash`, so this body may be on
# stdin with no path of its own and no sibling files. ${BASH_SOURCE[0]} is then
# unset — indexing it unguarded aborts under `set -u` — so locate a sibling
# library explicitly, and only fall back to downloading the pinned copy.

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

INSTALLER_LIB_PATH=""
if [[ -f "./installer-lib.sh" ]]; then
  INSTALLER_LIB_PATH="$(pwd)/installer-lib.sh"
elif [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/installer-lib.sh" ]]; then
  INSTALLER_LIB_PATH="${SCRIPT_DIR}/installer-lib.sh"
fi
if [[ ! -f "$INSTALLER_LIB_PATH" ]]; then
  INSTALLER_LIB_PATH=""
fi

INSTALLER_DIR=""
if [[ -n "$INSTALLER_LIB_PATH" && -f "$INSTALLER_LIB_PATH" && "$INSTALLER_LIB_PATH" != /tmp/* ]]; then
  INSTALLER_DIR="$(dirname "$INSTALLER_LIB_PATH")"
elif [[ -n "$SCRIPT_DIR" ]]; then
  INSTALLER_DIR="$SCRIPT_DIR"
elif [[ -f "./scripts/install/installer-lib.sh" ]]; then
  INSTALLER_DIR="$(pwd)/scripts/install"
elif [[ -f "./installer-lib.sh" ]]; then
  INSTALLER_DIR="$(pwd)"
fi

# Sourced only from a real sibling file. Downloading is a write plus a network
# fetch, which a piped `--dry-run` must not perform.
if [[ -n "$INSTALLER_LIB_PATH" ]]; then
  # shellcheck source=scripts/install/installer-lib.sh
  source "$INSTALLER_LIB_PATH"
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would fetch installer-lib.sh from the pinned repository."
  echo "[DRY-RUN] Would fetch flexserverctl.py, syntax-check it, then install it to /usr/local/bin/flexserverctl."
  echo "[DRY-RUN] Zero writes and zero network changes would be made."
  FLEXSERVERCTL_COMMAND_NAME="flexserverctl"
  FLEXSERVERCTL_DEST_DEFAULT="/usr/local/bin/flexserverctl"
  INSTALLER_TMP_FILES=()
  prepare_flexserverctl_source() { return 0; }
  resolve_flexserverctl_source() { echo "/usr/local/bin/flexserverctl"; }
  install_flexserverctl() { return 0; }
else
  if ! command -v curl &>/dev/null; then
    echo "Error: installer-lib.sh not found and curl is unavailable to fetch it." >&2
    exit 1
  fi
  INSTALLER_LIB_PATH="$(mktemp)" || exit 1
  if ! curl -fsSL -o "$INSTALLER_LIB_PATH" \
    "https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install/installer-lib.sh"; then
    rm -f "$INSTALLER_LIB_PATH"
    echo "Error: Could not fetch installer-lib.sh required by this installer." >&2
    exit 1
  fi
  # shellcheck source=scripts/install/installer-lib.sh
  source "$INSTALLER_LIB_PATH"
  # Registered after sourcing: the library owns the cleanup list and EXIT trap.
  INSTALLER_TMP_FILES+=("$INSTALLER_LIB_PATH")
fi

# ── Constants ─────────────────────────────────────────────────────────────

BINARY_DEST="/usr/local/bin/vps-manager-agent"
CONFIG_DIR="/etc/vps-manager-agent"
CONFIG_FILE="${CONFIG_DIR}/config.json"
STATE_DIR="/var/lib/vps-manager-agent"
STATE_FILE="${STATE_DIR}/state.json"
DOCKER_IDENTITY_FILE="${CONFIG_DIR}/docker-identity.json"
DOCKER_RUNTIME_KEYS_FILE="${STATE_DIR}/runtime-keys.json"
SERVICE_NAME_DEFAULT="vps-manager-agent"
SERVICE_USER_DEFAULT="vps-manager-agent"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME_DEFAULT}.service"

LOCK_DIR="/run/vps-manager-agent"
TMPFILES_DIR="/etc/tmpfiles.d"
TMPFILES_FILE="${TMPFILES_DIR}/vps-manager-agent.conf"
# ── Args ──────────────────────────────────────────────────────────────────
# ── AI Subsystem Constants ───────────────────────────────────────────────
AI_USER_DEFAULT="flexserver-ai"
AI_GROUP_DEFAULT="flexserver-ai"
AI_HELPER_SERVICE_NAME="flexserver-ai-helper"
AI_HELPER_UNIT_FILE="/etc/systemd/system/${AI_HELPER_SERVICE_NAME}.service"
AI_HELPER_DEST="/usr/local/sbin/ai-host-helper"
AI_EXECUTOR_DEST="/usr/local/sbin/ai-executor"
AI_RUN_DIR="/run/flexserver-ai"
AI_HELPER_SOCKET="${AI_RUN_DIR}/helper.sock"
AI_STATE_DIR="/var/lib/flexserver-ai"
AI_STATE_FILE="${AI_STATE_DIR}/ai-state.json"
AI_SCRATCH_DIR="${AI_STATE_DIR}/scratch"
AI_PROFILES_DIR="/etc/flexserver-ai/profiles"
AI_ROOTFS_DIR="${AI_ROOTFS_DIR:-/usr/local/share/flexserver-ai/rootfs}"
AI_ROOTFS_MANIFEST="${AI_ROOTFS_MANIFEST:-/usr/local/share/flexserver-ai/rootfs.manifest.json}"
UNINSTALL=false
INSTALL_AI=false
AI_EXECUTOR_SRC=""
AI_HOST_HELPER_SRC=""
AI_ROOTFS_TAR_SRC=""
AI_ROOTFS_MANIFEST_SRC=""
AI_ROOTFS_BUNDLE_SRC=""
AI_PROFILES_DIR_SRC=""
AI_PROFILES_BUNDLE_SRC=""
AI_USER="${AI_USER_DEFAULT}"
AI_GROUP="${AI_GROUP_DEFAULT}"

BINARY_SRC=""
CONFIG_SRC=""
SERVICE_NAME="${SERVICE_NAME_DEFAULT}"
SERVICE_USER="${SERVICE_USER_DEFAULT}"
UNINSTALL=false
ENABLE_DOCKER_ACCESS=false
INSTALL_CLI=true
SKIP_CLI=false
CLI_DEST="${FLEXSERVERCTL_DEST_DEFAULT:-/usr/local/bin/flexserverctl}"
CLI_SRC=""
INSTALL_HOST_PTY=false
HOST_PTY_SRC=""
HOST_PTY_SERVICE_NAME="flexserver-host-pty"
HOST_PTY_DEST="/usr/local/bin/flexserver-host-pty"
HOST_PTY_SOCKET_PATH="/var/run/flexserver/host-pty/host-pty.sock"
HOST_PTY_SOCKET_UID=""
HOST_PTY_SOCKET_GID=""
HOST_PTY_UNIT_FILE="/etc/systemd/system/${HOST_PTY_SERVICE_NAME}.service"
INSTALL_ROTATOR=false
ROTATOR_SRC=""
ROTATOR_SERVICE_NAME="flexserver-local-agent-rotator"
ROTATOR_DEST="/usr/local/bin/flexserver-local-agent-rotator"
ROTATOR_SOCKET_PATH="/var/run/flexserver/agent-rotation/agent-rotation.sock"
ROTATOR_UNIT_FILE="/etc/systemd/system/${ROTATOR_SERVICE_NAME}.service"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      BINARY_SRC="$2"; shift 2 ;;
    --config)
      CONFIG_SRC="$2"; shift 2 ;;
    --service-name)
      SERVICE_NAME="$2"; shift 2 ;;
    --service-user)
      SERVICE_USER="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --uninstall)
      UNINSTALL=true; shift ;;
    --enable-docker-metrics-access)
      ENABLE_DOCKER_ACCESS=true; shift ;;
    --install-cli)
      INSTALL_CLI=true; SKIP_CLI=false; shift ;;
    --skip-cli)
      SKIP_CLI=true; shift ;;
    --cli-source)
      CLI_SRC="$2"; shift 2 ;;
    --cli-dest)
      CLI_DEST="$2"; shift 2 ;;
    --install-host-pty)
      INSTALL_HOST_PTY=true; shift ;;
    --host-pty-binary)
      HOST_PTY_SRC="$2"; INSTALL_HOST_PTY=true; shift 2 ;;
    --host-pty-socket-path)
      HOST_PTY_SOCKET_PATH="$2"; shift 2 ;;
    --install-rotator)
      INSTALL_ROTATOR=true; shift ;;
    --rotator-binary)
      ROTATOR_SRC="$2"; INSTALL_ROTATOR=true; shift 2 ;;
    --rotator-socket-path)
      ROTATOR_SOCKET_PATH="$2"; shift 2 ;;
    --api-uid-gid)
      HOST_PTY_SOCKET_UID="${2%%:*}"
      HOST_PTY_SOCKET_GID="${2##*:}"
      shift 2 ;;
    --install-ai|--enable-ai)
      INSTALL_AI=true; shift ;;
    --ai-executor-binary)
      AI_EXECUTOR_SRC="$2"; INSTALL_AI=true; shift 2 ;;
    --ai-host-helper-binary)
      AI_HOST_HELPER_SRC="$2"; INSTALL_AI=true; shift 2 ;;
    --ai-rootfs-tar)
      AI_ROOTFS_TAR_SRC="$2"; INSTALL_AI=true; shift 2 ;;
    --ai-rootfs-manifest)
      AI_ROOTFS_MANIFEST_SRC="$2"; INSTALL_AI=true; shift 2 ;;
    --ai-rootfs-bundle)
      AI_ROOTFS_BUNDLE_SRC="$2"; INSTALL_AI=true; shift 2 ;;
    --ai-profiles-dir)
      AI_PROFILES_DIR_SRC="$2"; INSTALL_AI=true; shift 2 ;;
    --ai-profiles-bundle)
      AI_PROFILES_BUNDLE_SRC="$2"; INSTALL_AI=true; shift 2 ;;
    --ai-user)
      AI_USER="$2"; shift 2 ;;
    --ai-group)
      AI_GROUP="$2"; shift 2 ;;
    --help)
      echo "Usage: sudo ./scripts/install/install-local-agent.sh --binary <path> --config <path> [options]"
      echo ""
      echo "Options:"
      echo "  --binary <path>       Path to the agent binary (required)."
      echo "  --config <path>       Path to the agent config JSON file (required for install)."
      echo "  --service-name <name> Systemd service name (default: ${SERVICE_NAME_DEFAULT})."
      echo "  --service-user <user> System user for the service (default: ${SERVICE_USER_DEFAULT})."
      echo "  --enable-docker-metrics-access"
      echo "                        Add 'docker' group to the systemd service (SupplementaryGroups)."
      echo "                        Docker group access is root-equivalent; only needed if Docker"
      echo "                        metrics are enabled via the dashboard. Fails if docker group"
      echo "                        does not exist on the system."
      echo "  --dry-run             Print what would be done without making changes."
      echo "  --uninstall           Stop, disable, and remove the agent."
      echo "  --install-cli         Also install the flexserverctl CLI (default: on)."
      echo "  --skip-cli            Do not install the flexserverctl CLI."
      echo "  --cli-source <path>   Path to flexserverctl.py (default: sibling file, else download)."
      echo "  --cli-dest <path>     CLI install path (default: ${FLEXSERVERCTL_DEST_DEFAULT})."
      echo "  --install-ai          Install and enable isolated AI worker subsystem"
      echo "                        (auto-resolves the packaged AI bundle; see header)."
      echo "  --ai-executor-binary <path>  Override: ai-executor binary."
      echo "  --ai-host-helper-binary <path> Override: ai-host-helper binary."
      echo "  --ai-rootfs-tar <path>       Override: minimal rootfs tarball."
      echo "  --ai-rootfs-manifest <path>  Override: rootfs manifest JSON."
      echo "  --ai-profiles-dir <path>     Override: AI profiles directory."
      echo "  --ai-user <user>             Unprivileged AI execution user (default: ${AI_USER_DEFAULT})."
      echo "  --ai-group <group>           Unprivileged AI execution group (default: ${AI_GROUP_DEFAULT})."
      echo "  --help                Show this help."
      exit 0 ;;
    *)
      echo "Error: Unknown argument: $1"
      echo "Usage: sudo ./scripts/install/install-local-agent.sh --binary <path> --config <path> [options]"
      exit 1 ;;
  esac
done

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Error: Invalid --service-name. Allowed: letters, numbers, '_', '.', '@', '-'." >&2
  exit 1
fi
if [[ ! "$SERVICE_USER" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "Error: Invalid --service-user. Allowed: letters, numbers, '_', '.', '@', '-'." >&2
  exit 1
fi

# ── Root check ────────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (sudo)." >&2
  exit 1
fi

# ── Uninstall mode ────────────────────────────────────────────────────────

if [[ "$UNINSTALL" == "true" ]]; then
  echo "[Uninstall] Stopping and disabling ${SERVICE_NAME}..."
  if systemctl is-enabled "${SERVICE_NAME}" &>/dev/null; then
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

  if [[ -f "$BINARY_DEST" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${BINARY_DEST}"
    else
      rm -f "$BINARY_DEST"
    fi
  fi
  if systemctl is-enabled "${HOST_PTY_SERVICE_NAME}" &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run: systemctl stop ${HOST_PTY_SERVICE_NAME}"
      echo "  [DRY-RUN] Would run: systemctl disable ${HOST_PTY_SERVICE_NAME}"
    else
      systemctl stop "${HOST_PTY_SERVICE_NAME}" 2>/dev/null || true
      systemctl disable "${HOST_PTY_SERVICE_NAME}" 2>/dev/null || true
    fi
  fi
  if [[ -f "$HOST_PTY_UNIT_FILE" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${HOST_PTY_UNIT_FILE}"
    else
      rm -f "$HOST_PTY_UNIT_FILE"
    fi
  fi
  if [[ -f "$HOST_PTY_DEST" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${HOST_PTY_DEST}"
    else
      rm -f "$HOST_PTY_DEST"
    fi
  fi
  if [[ -S "$HOST_PTY_SOCKET_PATH" || -f "$HOST_PTY_SOCKET_PATH" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${HOST_PTY_SOCKET_PATH}"
    else
      rm -f "$HOST_PTY_SOCKET_PATH"
    fi
  fi
  if systemctl is-enabled "${ROTATOR_SERVICE_NAME}" &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run: systemctl stop ${ROTATOR_SERVICE_NAME}"
      echo "  [DRY-RUN] Would run: systemctl disable ${ROTATOR_SERVICE_NAME}"
    else
      systemctl stop "${ROTATOR_SERVICE_NAME}" 2>/dev/null || true
      systemctl disable "${ROTATOR_SERVICE_NAME}" 2>/dev/null || true
    fi
  fi
  if [[ -f "$ROTATOR_UNIT_FILE" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${ROTATOR_UNIT_FILE}"
    else
      rm -f "$ROTATOR_UNIT_FILE"
    fi
  fi
  if [[ -f "$ROTATOR_DEST" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${ROTATOR_DEST}"
    else
      rm -f "$ROTATOR_DEST"
    fi
  fi
  if [[ -S "$ROTATOR_SOCKET_PATH" || -f "$ROTATOR_SOCKET_PATH" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${ROTATOR_SOCKET_PATH}"
    else
      rm -f "$ROTATOR_SOCKET_PATH"
    fi
  fi
  if [[ -f "$TMPFILES_FILE" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${TMPFILES_FILE}"
    else
      rm -f "$TMPFILES_FILE"
    fi
  fi
  # AI Subsystem teardown
  if systemctl is-enabled "${AI_HELPER_SERVICE_NAME}" &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run: systemctl stop ${AI_HELPER_SERVICE_NAME}"
      echo "  [DRY-RUN] Would run: systemctl disable ${AI_HELPER_SERVICE_NAME}"
    else
      systemctl stop "${AI_HELPER_SERVICE_NAME}" 2>/dev/null || true
      systemctl disable "${AI_HELPER_SERVICE_NAME}" 2>/dev/null || true
    fi
  fi
  if [[ -f "$AI_HELPER_UNIT_FILE" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${AI_HELPER_UNIT_FILE}"
    else
      rm -f "$AI_HELPER_UNIT_FILE"
    fi
  fi
  if [[ -S "$AI_HELPER_SOCKET" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${AI_HELPER_SOCKET}"
    else
      rm -f "$AI_HELPER_SOCKET"
    fi
  fi
  for bin in "$AI_HELPER_DEST" "$AI_EXECUTOR_DEST"; do
    if [[ -f "$bin" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [DRY-RUN] Would remove: ${bin}"
      else
        rm -f "$bin"
      fi
    fi
  done
  # AI state (state file, receipts, scratch, backups) is never deleted:
  # /var/lib/flexserver-ai is preserved in place so a later reinstall
  # reattaches to the existing state, and unmatched pending receipts stay
  # auditable on the host indefinitely.
  if [[ -d "$AI_STATE_DIR" ]]; then
    echo "  [Uninstall] Preserving AI state in ${AI_STATE_DIR} (state, receipts, scratch, backups)."
  fi
  if [[ -d "$AI_PROFILES_DIR" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${AI_PROFILES_DIR}"
    else
      rm -rf "$AI_PROFILES_DIR"
    fi
  fi
  if [[ -d "$AI_ROOTFS_DIR" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${AI_ROOTFS_DIR}"
    else
      rm -rf "$AI_ROOTFS_DIR"
    fi
  fi
  if [[ -d "$AI_RUN_DIR" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${AI_RUN_DIR}"
    else
      rm -rf "$AI_RUN_DIR"
    fi
  fi

  if [[ -d "$CONFIG_DIR" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${CONFIG_DIR}/"
    else
      rm -rf "$CONFIG_DIR"
    fi
  fi

  if [[ -d "$STATE_DIR" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would remove: ${STATE_DIR}/"
    else
      rm -rf "$STATE_DIR"
    fi
  fi

  # /usr/local/bin/flexserverctl is deliberately preserved: any later
  # component install may still need it.

  echo "[Uninstall] Note: API app data in /opt/vps-manager was preserved."
  echo "[Uninstall] Agent tokens can be revoked via the dashboard > Servers > Local Host."
  exit 0
fi

# ── Install mode validation ───────────────────────────────────────────────

if [[ -z "$BINARY_SRC" ]]; then
  echo "Error: --binary <path> is required." >&2
  exit 1
fi
if [[ ! -f "$BINARY_SRC" ]]; then
  echo "Error: Binary not found: ${BINARY_SRC}" >&2
  exit 1
fi
if [[ -z "$CONFIG_SRC" ]]; then
  echo "Error: --config <path> is required." >&2
  exit 1
fi
if [[ ! -f "$CONFIG_SRC" ]]; then
  echo "Error: Config file not found: ${CONFIG_SRC}" >&2
  exit 1
fi

# Validate config JSON and required fields when node, python3 or jq is available.
if command -v node &>/dev/null; then
  if ! node -e '
    const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const key of ["backendUrl", "vpsId", "token"]) {
      if (typeof config[key] !== "string" || config[key].length === 0) throw new Error(`missing ${key}`);
    }
    for (const key of ["intervalSeconds", "requestTimeoutSeconds"]) {
      if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`invalid ${key}`);
    }
  ' "$CONFIG_SRC" &>/dev/null; then
    echo "Error: Config file is not a valid VPS Manager agent config: ${CONFIG_SRC}" >&2
    exit 1
  fi
elif command -v python3 &>/dev/null; then
  if ! python3 -c '
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    cfg = json.load(f)
for k in ["backendUrl", "vpsId", "token"]:
    if not isinstance(cfg.get(k), str) or not cfg[k]:
        sys.exit(1)
for k in ["intervalSeconds", "requestTimeoutSeconds"]:
    v = cfg.get(k)
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        sys.exit(1)
' "$CONFIG_SRC" &>/dev/null; then
    echo "Error: Config file is not a valid VPS Manager agent config: ${CONFIG_SRC}" >&2
    exit 1
  fi
elif command -v jq &>/dev/null; then
  if ! jq -e '.backendUrl and .vpsId and .token and (.intervalSeconds >= 1) and (.requestTimeoutSeconds >= 1)' "$CONFIG_SRC" &>/dev/null; then
    echo "Error: Config file is not a valid VPS Manager agent config: ${CONFIG_SRC}" >&2
    exit 1
  fi
else
  echo "Warning: Could not validate config JSON/schema (no node, python3, or jq). Proceeding..."
fi

# ── Docker group check ─────────────────────────────────────────────────────

DOCKER_SUPPLEMENTARY_GROUPS=""
if [[ "$ENABLE_DOCKER_ACCESS" == "true" ]]; then
  if getent group docker &>/dev/null; then
    DOCKER_SUPPLEMENTARY_GROUPS="docker"
    echo "[Docker] Docker group found: will add SupplementaryGroups=docker to the systemd unit."
    echo "  WARNING: The docker group is root-equivalent. Only enable this if you"
    echo "  intend to use the Docker metrics dashboard toggle."
  else
    echo "Error: --enable-docker-metrics-access was specified but the 'docker' group does not" >&2
    echo "  exist on this system. Install Docker first so the group is created:" >&2
    echo "    curl -fsSL https://get.docker.com | sh" >&2
    echo "  Or omit the flag to install without Docker socket access." >&2
    exit 1
  fi
fi

# ── flexserverctl CLI — source and python3 prerequisite ───────────────────
#
# Checked before the install mutations below, so a missing python3 or a
# failed pipe-mode download can never leave the agent installed but the CLI
# missing. The atomic copy into place happens at the end of the install.
CLI_RESOLVED_SOURCE=""
if [[ "$INSTALL_CLI" == "true" && "$SKIP_CLI" == "false" ]]; then
  if [[ "$DRY_RUN" == "false" ]]; then
    if [[ -n "$CLI_SRC" ]]; then
      FLEXSERVERCTL_SOURCE="$CLI_SRC"
    fi
    if ! prepare_flexserverctl_source; then
      exit 1
    fi
    CLI_RESOLVED_SOURCE="$FLEXSERVERCTL_SRC"
  fi
fi

# ── AI bundle preflight (fail closed BEFORE any install mutation) ─────────
#
# Runs before the agent binary, config, unit, users or AI assets are
# mutated: an incomplete or corrupt/missing AI bundle must refuse to start
# the install at all, never leave a half-installed AI subsystem behind.
# Dry-run validates presence AND runs the (temp-only) content verification
# so a dry run reports exactly what a real run would find, but performs no
# host mutation: everything stays inside a registered temp directory.
if [[ "$INSTALL_AI" == "true" ]]; then
  # python3 is an explicit AI prerequisite: the verifier, the bundled-tar
  # scans and the config's ai block all need it on the host. Fail closed
  # before any staging, extraction or mutation instead of silently skipping.
  if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required to install the AI bundle (verifier + config block)." >&2
    echo "  Install it first, e.g.: sudo apt install python3 (or equivalent)." >&2
    echo "  Re-run without --install-ai / --skip-ai to install without AI." >&2
    exit 1
  fi
  ai_cand_dir="$(dirname "$BINARY_SRC")"
  PREFLIGHT_BUNDLE_ROOTS=("${ai_cand_dir}" "${SCRIPT_DIR:-$ai_cand_dir}" "/app/agent/ai" "/opt/vps-manager" "/opt/vps-manager/ai")
  PREFLIGHT_ARCH="$(uname -m 2>/dev/null || echo unknown)"
  case "$PREFLIGHT_ARCH" in
    x86_64|amd64) ai_bundle_arch="amd64" ;;
    aarch64|arm64) ai_bundle_arch="arm64" ;;
    *) ai_bundle_arch="" ;;
  esac
  if [[ -z "$ai_bundle_arch" ]]; then
    echo "Error: Unsupported host architecture for the AI bundle: ${PREFLIGHT_ARCH}." >&2
    exit 1
  fi
  # Overrides win; otherwise auto-resolve the packaged bundle from the roots.
  PREFLIGHT_AI_EXECUTOR="${AI_EXECUTOR_SRC}"
  PREFLIGHT_AI_HOST_HELPER="${AI_HOST_HELPER_SRC}"
  PREFLIGHT_AI_ROOTFS_TAR="${AI_ROOTFS_TAR_SRC}"
  PREFLIGHT_AI_ROOTFS_MANIFEST="${AI_ROOTFS_MANIFEST_SRC}"
  PREFLIGHT_AI_PROFILES_DIR="${AI_PROFILES_DIR_SRC}"
  if [[ -z "$PREFLIGHT_AI_EXECUTOR" ]]; then
    for _root in "${PREFLIGHT_BUNDLE_ROOTS[@]}"; do
      for _cand in "${_root}/ai-executor-linux-${ai_bundle_arch}" "${_root}/ai-executor"; do
        if [[ -f "$_cand" ]]; then PREFLIGHT_AI_EXECUTOR="$_cand"; break 2; fi
      done
    done
  fi
  if [[ -z "$PREFLIGHT_AI_HOST_HELPER" ]]; then
    for _root in "${PREFLIGHT_BUNDLE_ROOTS[@]}"; do
      for _cand in "${_root}/ai-host-helper-linux-${ai_bundle_arch}" "${_root}/ai-host-helper"; do
        if [[ -f "$_cand" ]]; then PREFLIGHT_AI_HOST_HELPER="$_cand"; break 2; fi
      done
    done
  fi
  if [[ -z "$PREFLIGHT_AI_ROOTFS_TAR" ]]; then
    for _root in "${PREFLIGHT_BUNDLE_ROOTS[@]}"; do
      for _cand in "${_root}/ai-rootfs-linux-${ai_bundle_arch}.tar.gz" "${_root}/rootfs.tar.gz"; do
        if [[ -f "$_cand" ]]; then PREFLIGHT_AI_ROOTFS_TAR="$_cand"; break 2; fi
      done
    done
  fi
  if [[ -z "$PREFLIGHT_AI_ROOTFS_MANIFEST" ]]; then
    for _root in "${PREFLIGHT_BUNDLE_ROOTS[@]}"; do
      for _cand in "${_root}/ai-rootfs-linux-${ai_bundle_arch}.manifest.json" "${_root}/rootfs.manifest.json"; do
        if [[ -f "$_cand" ]]; then PREFLIGHT_AI_ROOTFS_MANIFEST="$_cand"; break 2; fi
      done
    done
  fi
  if [[ -z "$PREFLIGHT_AI_PROFILES_DIR" ]]; then
    for _root in "${PREFLIGHT_BUNDLE_ROOTS[@]}"; do
      for _cand in "${_root}/ai-profiles" "${_root}/profiles"; do
        if [[ -d "$_cand" ]]; then PREFLIGHT_AI_PROFILES_DIR="$_cand"; break 2; fi
      done
    done
  fi
  PREFLIGHT_AI_ROOTFS_BUNDLE="${AI_ROOTFS_BUNDLE_SRC}"
  PREFLIGHT_AI_PROFILES_BUNDLE="${AI_PROFILES_BUNDLE_SRC}"

  ai_preflight_missing=()
  [[ -n "$PREFLIGHT_AI_EXECUTOR" && -f "$PREFLIGHT_AI_EXECUTOR" && -r "$PREFLIGHT_AI_EXECUTOR" ]] || ai_preflight_missing+=("executor(ai-executor-linux-${ai_bundle_arch})")
  [[ -n "$PREFLIGHT_AI_HOST_HELPER" && -f "$PREFLIGHT_AI_HOST_HELPER" && -r "$PREFLIGHT_AI_HOST_HELPER" ]] || ai_preflight_missing+=("helper(ai-host-helper-linux-${ai_bundle_arch})")
  [[ -n "$PREFLIGHT_AI_ROOTFS_TAR" && -f "$PREFLIGHT_AI_ROOTFS_TAR" && -r "$PREFLIGHT_AI_ROOTFS_TAR" ]] || ai_preflight_missing+=("rootfs(ai-rootfs-linux-${ai_bundle_arch}.tar.gz)")
  [[ -n "$PREFLIGHT_AI_ROOTFS_MANIFEST" && -f "$PREFLIGHT_AI_ROOTFS_MANIFEST" && -r "$PREFLIGHT_AI_ROOTFS_MANIFEST" ]] || ai_preflight_missing+=("manifest(ai-rootfs-linux-${ai_bundle_arch}.manifest.json)")
  if [[ -n "$PREFLIGHT_AI_PROFILES_DIR" ]]; then
    if [[ ! -d "$PREFLIGHT_AI_PROFILES_DIR" || ! -r "$PREFLIGHT_AI_PROFILES_DIR" ]]; then
      ai_preflight_missing+=("profiles(ai-profiles)")
    fi
  elif [[ -n "$PREFLIGHT_AI_PROFILES_BUNDLE" ]]; then
    if [[ ! -f "$PREFLIGHT_AI_PROFILES_BUNDLE" || ! -r "$PREFLIGHT_AI_PROFILES_BUNDLE" ]]; then
      ai_preflight_missing+=("profiles-bundle")
    fi
  else
    ai_preflight_missing+=("profiles(ai-profiles)")
  fi
  if [[ -n "$PREFLIGHT_AI_ROOTFS_BUNDLE" && (! -f "$PREFLIGHT_AI_ROOTFS_BUNDLE" || ! -r "$PREFLIGHT_AI_ROOTFS_BUNDLE") ]]; then
    ai_preflight_missing+=("rootfs-bundle(${PREFLIGHT_AI_ROOTFS_BUNDLE})")
  fi
  if [[ -n "$PREFLIGHT_AI_PROFILES_BUNDLE" && (! -f "$PREFLIGHT_AI_PROFILES_BUNDLE" || ! -r "$PREFLIGHT_AI_PROFILES_BUNDLE") ]]; then
    ai_preflight_missing+=("profiles-bundle(${PREFLIGHT_AI_PROFILES_BUNDLE})")
  fi
  if [[ ${#ai_preflight_missing[@]} -gt 0 ]]; then
    echo "Error: AI bundle incomplete: missing ${ai_preflight_missing[*]}" >&2
    echo "  Search roots: ${PREFLIGHT_BUNDLE_ROOTS[*]}" >&2
    echo "  Install the complete AI bundle (see scripts/install/install.sh's defaults) or run with --skip-ai to install without AI." >&2
    exit 1
  fi

  # Content verification, in a registered temp dir only. Extracts ONCE here;
  # the mutation phase installs from this verified tree (no second tar).
  PREFLIGHT_AI_TMP="$(mktemp -d "${TMPDIR:-/tmp}/vai-verify.XXXXXX")"
  INSTALLER_TMP_FILES+=("$PREFLIGHT_AI_TMP")
  PREFLIGHT_AI_STAGED="$PREFLIGHT_AI_TMP/rootfs"
  PREFLIGHT_AI_PROFILES_STAGED="$PREFLIGHT_AI_TMP/profiles"
  PREFLIGHT_AI_STAGED_TAR="$PREFLIGHT_AI_TMP/rootfs.tar.gz"
  PREFLIGHT_AI_STAGED_MANIFEST="$PREFLIGHT_AI_TMP/rootfs.manifest.json"
  PREFLIGHT_AI_VERIFY_SCRIPT="$PREFLIGHT_AI_TMP/verify-bundle.py"
  mkdir -- "$PREFLIGHT_AI_STAGED" "$PREFLIGHT_AI_PROFILES_STAGED"
  cp -f -- "$PREFLIGHT_AI_ROOTFS_TAR" "$PREFLIGHT_AI_STAGED_TAR"
  cp -f -- "$PREFLIGHT_AI_ROOTFS_MANIFEST" "$PREFLIGHT_AI_STAGED_MANIFEST"
  if [[ -n "$PREFLIGHT_AI_PROFILES_DIR" ]]; then
    cp -a -- "$PREFLIGHT_AI_PROFILES_DIR/." "$PREFLIGHT_AI_PROFILES_STAGED/"
  fi
  cat <<'EOF_VERIFY_PY' > "$PREFLIGHT_AI_VERIFY_SCRIPT"
import sys, os, json, hashlib, tarfile

def main():
    if len(sys.argv) < 9:
        sys.stderr.write("Usage: verify-bundle.py <mode> <tar> <manifest> <tmp> <executor> <helper> <profiles> <rootfs_root>\n")
        sys.exit(2)
    mode = sys.argv[1]
    tar_path = sys.argv[2]
    manifest_path = sys.argv[3]
    tmp_dir = sys.argv[4]
    executor = sys.argv[5]
    helper = sys.argv[6]
    profiles_dir = sys.argv[7]
    rootfs_root = sys.argv[8]

    if mode == "digest-tar":
        if not os.path.isfile(tar_path):
            sys.stderr.write(f"Error: tar file does not exist: {tar_path}\n")
            sys.exit(1)
        if not os.path.isfile(manifest_path):
            sys.stderr.write(f"Error: manifest file does not exist: {manifest_path}\n")
            sys.exit(1)
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                mf = json.load(f)
        except Exception as e:
            sys.stderr.write(f"Error: corrupt or invalid manifest JSON: {e}\n")
            sys.exit(1)

        expected_tar_sha = mf.get("rootfsSha256", "")
        h = hashlib.sha256()
        with open(tar_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        actual_tar_sha = h.hexdigest()
        if expected_tar_sha != actual_tar_sha:
            sys.stderr.write(f"Error: rootfsSha256 does not match tar bytes: manifest={expected_tar_sha} actual={actual_tar_sha}\n")
            sys.exit(1)

        for item in mf.get("files", []):
            raw_p = item.get("path", "")
            clean = raw_p
            if clean.startswith("./"):
                clean = clean[2:]
            elif clean.startswith("/"):
                clean = clean[1:]
            if not clean:
                sys.stderr.write(f"Error: manifest file entry contains an empty, '.' or '..' component: {raw_p}\n")
                sys.exit(1)
            parts = clean.replace("\\", "/").split("/")
            for part in parts:
                if part in (".", "..") or part == "":
                    sys.stderr.write(f"Error: manifest file entry contains an empty, '.' or '..' component: {raw_p}\n")
                    sys.exit(1)
        sys.exit(0)

    elif mode == "scan-tar":
        if not os.path.isfile(tar_path):
            sys.stderr.write(f"Error: tar file does not exist: {tar_path}\n")
            sys.exit(1)
        try:
            with tarfile.open(tar_path, "r:*") as tf:
                for m in tf.getmembers():
                    name = m.name
                    clean = name
                    if clean.startswith("./"):
                        clean = clean[2:]
                    elif clean.startswith("/"):
                        sys.stderr.write(f"Error: tarball member has leading slash: {name}\n")
                        sys.exit(1)
                    if clean in ("", "."):
                        continue
                    parts = clean.replace("\\", "/").split("/")
                    if any(p == ".." for p in parts):
                        sys.stderr.write(f"Error: tarball member contains '..' or traversal component: {name}\n")
                        sys.exit(1)
                    if m.issym() or m.islnk():
                        target = m.linkname
                        if target.startswith("/") or target.startswith("\\"):
                            sys.stderr.write(f"Error: symlink target escapes rootfs tree: {name} -> {target}\n")
                            sys.exit(1)
                        clean_dir = os.path.dirname(clean)
                        target_norm = os.path.normpath(os.path.join(clean_dir, target)).replace("\\", "/")
                        if target_norm == ".." or target_norm.startswith("../"):
                            sys.stderr.write(f"Error: symlink target escapes rootfs tree: {name} -> {target}\n")
                            sys.exit(1)
        except Exception as e:
            if "symlink target escapes" in str(e):
                sys.exit(1)
            sys.stderr.write(f"Error: corrupt or invalid tarball: {e}\n")
            sys.exit(1)
        sys.exit(0)

    elif mode == "check-extracted":
        if not os.path.isdir(rootfs_root):
            sys.stderr.write(f"Error: extracted rootfs root does not exist: {rootfs_root}\n")
            sys.exit(1)
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                mf = json.load(f)
        except Exception as e:
            sys.stderr.write(f"Error: corrupt manifest JSON: {e}\n")
            sys.exit(1)

        for item in mf.get("files", []):
            raw_p = item.get("path", "")
            clean = raw_p
            if clean.startswith("./"):
                clean = clean[2:]
            elif clean.startswith("/"):
                clean = clean[1:]
            full_p = os.path.join(rootfs_root, clean)
            if not os.path.isfile(full_p):
                sys.stderr.write(f"Error: extracted file missing: {raw_p} at {full_p}\n")
                sys.exit(1)
            expected_sha = item.get("sha256", "")
            h = hashlib.sha256()
            with open(full_p, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            if h.hexdigest() != expected_sha:
                sys.stderr.write(f"Error: extracted file SHA mismatch for {raw_p}: expected {expected_sha}, got {h.hexdigest()}\n")
                sys.exit(1)

        abs_root = os.path.abspath(rootfs_root)
        for cur_dir, dirs, files in os.walk(rootfs_root, followlinks=False):
            for entry in dirs + files:
                entry_p = os.path.join(cur_dir, entry)
                if os.path.islink(entry_p):
                    target = os.readlink(entry_p)
                    if target.startswith("/"):
                        sys.stderr.write(f"Error: extracted symlink escapes rootfs tree: {entry_p} -> {target}\n")
                        sys.exit(1)
                    target_abs = os.path.abspath(os.path.join(cur_dir, target))
                    if not (target_abs == abs_root or target_abs.startswith(abs_root + os.sep)):
                        sys.stderr.write(f"Error: extracted symlink escapes rootfs tree: {entry_p} -> {target}\n")
                        sys.exit(1)
        sys.exit(0)
    else:
        sys.stderr.write(f"Error: unknown verification mode: {mode}\n")
        sys.exit(2)

if __name__ == "__main__":
    main()
EOF_VERIFY_PY

  if [[ ! -s "$PREFLIGHT_AI_VERIFY_SCRIPT" ]]; then
    echo "Error: AI bundle verifier script could not be written; refusing to mutate." >&2
    exit 1
  fi

  VERIFY_SCRIPT="$PREFLIGHT_AI_VERIFY_SCRIPT"
  VERIFY_TAR="$PREFLIGHT_AI_STAGED_TAR"
  VERIFY_MANIFEST="$PREFLIGHT_AI_STAGED_MANIFEST"
  VERIFY_EXECUTOR="$PREFLIGHT_AI_EXECUTOR"
  VERIFY_HELPER="$PREFLIGHT_AI_HOST_HELPER"
  # Profiles: resolve to the staged copy so every verifier call sees the
  # same tree (flag dir, packaged dir or extracted --ai-profiles-bundle).
  VERIFY_PROFILES_DIR="$PREFLIGHT_AI_PROFILES_STAGED"
  VERIFY_TMP="$PREFLIGHT_AI_TMP"
  VERIFY_ROOTFS_ROOT="$PREFLIGHT_AI_STAGED"

  # AI_PROFILES_STAGED_SRC points at the profiles staged tree for the
  # mutation phase (never the nonexistent "profiles-bundle" name).
  AI_PROFILES_STAGED_SRC="$PREFLIGHT_AI_PROFILES_STAGED"
  # Stage 1: tar digest against manifest (no extraction). Stage 2: tar member
  # scan (traversal, symlink/hardlink escapes) BEFORE any extraction.
  python3 "$VERIFY_SCRIPT" digest-tar "$VERIFY_TAR" "$VERIFY_MANIFEST" "$VERIFY_TMP" \
    "$VERIFY_EXECUTOR" "$VERIFY_HELPER" "$VERIFY_PROFILES_DIR" "$VERIFY_ROOTFS_ROOT" || exit 1
  python3 "$VERIFY_SCRIPT" scan-tar "$VERIFY_TAR" "$VERIFY_MANIFEST" "$VERIFY_TMP" \
    "$VERIFY_EXECUTOR" "$VERIFY_HELPER" "$VERIFY_PROFILES_DIR" "$VERIFY_ROOTFS_ROOT" || exit 1

  # Scan and stage optional bundles inside the temp tree before extracting
  if [[ -n "$AI_ROOTFS_BUNDLE_SRC" ]]; then
    python3 "$VERIFY_SCRIPT" scan-tar "$AI_ROOTFS_BUNDLE_SRC" "$VERIFY_MANIFEST" "$VERIFY_TMP" \
      "$VERIFY_EXECUTOR" "$VERIFY_HELPER" "$VERIFY_PROFILES_DIR" "$PREFLIGHT_AI_TMP/rootfs-bundle" || exit 1
    mkdir -p "$PREFLIGHT_AI_TMP/rootfs-bundle"
    tar -xzf "$AI_ROOTFS_BUNDLE_SRC" -C "$PREFLIGHT_AI_TMP/rootfs-bundle" --strip-components=1 || {
      echo "Error: AI rootfs bundle tarball is corrupt or unreadable: ${AI_ROOTFS_BUNDLE_SRC}" >&2
      exit 1
    }
  fi
  if [[ -n "$AI_PROFILES_BUNDLE_SRC" ]]; then
    python3 "$VERIFY_SCRIPT" scan-tar "$AI_PROFILES_BUNDLE_SRC" "$VERIFY_MANIFEST" "$VERIFY_TMP" \
      "$VERIFY_EXECUTOR" "$VERIFY_HELPER" "$VERIFY_PROFILES_DIR" "$PREFLIGHT_AI_PROFILES_STAGED" || exit 1
    mkdir -p "$PREFLIGHT_AI_PROFILES_STAGED"
    tar -xzf "$AI_PROFILES_BUNDLE_SRC" -C "$PREFLIGHT_AI_PROFILES_STAGED" --strip-components=1 || {
      echo "Error: AI profiles bundle tarball is corrupt or unreadable: ${AI_PROFILES_BUNDLE_SRC}" >&2
      exit 1
    }
  fi

  # Only now extract, once, into the registered temp tree.
  tar -xzf "$PREFLIGHT_AI_STAGED_TAR" -C "$PREFLIGHT_AI_STAGED" || {
    echo "Error: AI rootfs tarball is corrupt or unreadable: ${PREFLIGHT_AI_ROOTFS_TAR}" >&2
    exit 1
  }
  if [[ ! -d "$PREFLIGHT_AI_STAGED/bin" ]]; then
    echo "Error: AI rootfs tarball must unpack a ./bin directory: ${PREFLIGHT_AI_ROOTFS_TAR}" >&2
    exit 1
  fi
  # Stage 3: per-file digests + symlink escapes in the extracted tree.
  python3 "$VERIFY_SCRIPT" check-extracted "$VERIFY_TAR" "$VERIFY_MANIFEST" "$VERIFY_TMP" \
    "$VERIFY_EXECUTOR" "$VERIFY_HELPER" "$VERIFY_PROFILES_DIR" "$VERIFY_ROOTFS_ROOT" || exit 1

  # Feed the mutation phase from the verified temp tree.
  AI_EXECUTOR_SRC="$PREFLIGHT_AI_EXECUTOR"
  AI_HOST_HELPER_SRC="$PREFLIGHT_AI_HOST_HELPER"
  AI_ROOTFS_MANIFEST_SRC="$PREFLIGHT_AI_ROOTFS_MANIFEST"
  AI_ROOTFS_STAGED_SRC="$PREFLIGHT_AI_TMP/rootfs-bundle"
  AI_PROFILES_STAGED_SRC="$PREFLIGHT_AI_PROFILES_STAGED"
  AI_VERIFIED_ROOTFS_TMP="$PREFLIGHT_AI_STAGED"
fi


echo "[Install] Installing VPS Manager Agent..."

# Create system user/group
if ! getent group "${SERVICE_USER}" &>/dev/null; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would create group: ${SERVICE_USER}"
  else
    groupadd --system "${SERVICE_USER}"
    echo "  Created group: ${SERVICE_USER}"
  fi
fi

if ! getent passwd "${SERVICE_USER}" &>/dev/null; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would create user: ${SERVICE_USER} (no shell, no home)"
  else
    useradd --system --no-create-home --shell /sbin/nologin -g "${SERVICE_USER}" "${SERVICE_USER}"
    echo "  Created user: ${SERVICE_USER}"
  fi
fi

# Install binary
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would install binary: ${BINARY_SRC} -> ${BINARY_DEST} (root:root 0755)"
else
  cp -f "$BINARY_SRC" "$BINARY_DEST"
  chown root:root "$BINARY_DEST"
  chmod 0755 "$BINARY_DEST"
  echo "  Installed binary: ${BINARY_DEST}"
fi

# Install config
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would create directory: ${CONFIG_DIR} (root:${SERVICE_USER} 0750)"
  echo "  [DRY-RUN] Would install config: ${CONFIG_SRC} -> ${CONFIG_FILE} (root:${SERVICE_USER} 0640)"
  echo "  [DRY-RUN] Would ensure Docker state before starting the service: ${DOCKER_IDENTITY_FILE} (root:root 0600) and ${DOCKER_RUNTIME_KEYS_FILE} (${SERVICE_USER}:${SERVICE_USER} 0600), provisioning idempotently without rotating an existing identity"
  echo "  [DRY-RUN] Would ensure singleton lock: ${LOCK_DIR} (root:root 0755), deterministic 0666 lock file, and ${TMPFILES_FILE} (root:root 0644)"
else
  mkdir -p "$CONFIG_DIR"
  chown root:"${SERVICE_USER}" "$CONFIG_DIR"
  chmod 0750 "$CONFIG_DIR"
  if [[ "$CONFIG_SRC" != "$CONFIG_FILE" ]]; then
    cp -f "$CONFIG_SRC" "$CONFIG_FILE"
  fi
  chown root:"${SERVICE_USER}" "$CONFIG_FILE"
  chmod 0640 "$CONFIG_FILE"
  mkdir -p "$STATE_DIR"
  chown "${SERVICE_USER}:${SERVICE_USER}" "$STATE_DIR"
  chmod 0750 "$STATE_DIR"
  SERVICE_UID="$(id -u "$SERVICE_USER")"
  if [[ ! "$SERVICE_UID" =~ ^[0-9]+$ ]]; then
    echo "Error: Could not resolve numeric UID for service user: ${SERVICE_USER}" >&2
    exit 1
  fi
  # Docker identity/runtime state: never rotate an existing identity, and
  # never start the service without a pair the agent will accept.
  if [[ -e "$DOCKER_RUNTIME_KEYS_FILE" && ! -e "$DOCKER_IDENTITY_FILE" ]]; then
    echo "Error: ${DOCKER_RUNTIME_KEYS_FILE} exists without ${DOCKER_IDENTITY_FILE}." >&2
    echo "  Refusing to rotate an existing Docker installation identity." >&2
    echo "  Restore the identity file from backup, then re-run this installer." >&2
    exit 1
  fi
  PROVISION_OWNER_UID=0
  if [[ -e "$DOCKER_RUNTIME_KEYS_FILE" ]]; then
    RUNTIME_OWNER_UID="$(stat -c %u "$DOCKER_RUNTIME_KEYS_FILE")"
    case "$RUNTIME_OWNER_UID" in
      0|"$SERVICE_UID")
        PROVISION_OWNER_UID="$RUNTIME_OWNER_UID"
        ;;
      *)
        echo "Error: unexpected owner uid ${RUNTIME_OWNER_UID} for ${DOCKER_RUNTIME_KEYS_FILE}." >&2
        echo "  Refusing to touch Docker runtime keys owned by another user." >&2
        exit 1
        ;;
    esac
  fi
  if ! "$BINARY_DEST" -provision-docker-state -docker-identity-path "$DOCKER_IDENTITY_FILE" -docker-runtime-keys-path "$DOCKER_RUNTIME_KEYS_FILE" -docker-runtime-owner-uid "$PROVISION_OWNER_UID"; then
    echo "Error: Docker state provisioning failed; not starting the service." >&2
    exit 1
  fi
  # Identity stays root-owned; runtime keys must belong to the service user.
  chown root:root "$DOCKER_IDENTITY_FILE"
  chmod 0600 "$DOCKER_IDENTITY_FILE"
  chown "${SERVICE_USER}:${SERVICE_USER}" "$DOCKER_RUNTIME_KEYS_FILE"
  chmod 0600 "$DOCKER_RUNTIME_KEYS_FILE"
  # Verification pass: accept the pair only if it passes exactly the owner/
  # mode/pair validation the agent performs before it starts.
  if ! "$BINARY_DEST" -provision-docker-state -docker-identity-path "$DOCKER_IDENTITY_FILE" -docker-runtime-keys-path "$DOCKER_RUNTIME_KEYS_FILE" -docker-runtime-owner-uid "$SERVICE_UID"; then
    echo "Error: Docker state verification failed; not starting the service." >&2
    exit 1
  fi
  echo "  Ensured Docker state: identity root:root 0600, runtime keys ${SERVICE_USER}:0600"
  echo "  Installed config: ${CONFIG_FILE}"
  # Singleton lock and tmpfiles provisioning: guarantee root-owned 0755 directory,
  # root-owned 0666 lock file (preserving existing inode), and systemd-tmpfiles persistence.
  LOCK_VPS_ID=""
  if command -v node &>/dev/null; then
    LOCK_VPS_ID="$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (typeof c.vpsId === "string") console.log(c.vpsId.trim()); } catch (e) {}' "$CONFIG_FILE")"
  elif command -v jq &>/dev/null; then
    LOCK_VPS_ID="$(jq -r '.vpsId // empty' "$CONFIG_FILE" 2>/dev/null || true)"
  elif command -v python3 &>/dev/null; then
    LOCK_VPS_ID="$(python3 -c 'import json, sys; c = json.load(open(sys.argv[1])); print(str(c.get("vpsId", "")).strip())' "$CONFIG_FILE" 2>/dev/null || true)"
  fi
  if [[ -z "$LOCK_VPS_ID" ]]; then
    LOCK_VPS_ID="$(grep -o '"vpsId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_FILE" 2>/dev/null | head -1 | sed -e 's/.*:[[:space:]]*"//' -e 's/"$//' || true)"
  fi
  if [[ -z "$LOCK_VPS_ID" ]]; then
    echo "Error: Could not extract vpsId from config: ${CONFIG_FILE}" >&2
    exit 1
  fi

  LOCK_HASH=""
  if command -v sha256sum &>/dev/null; then
    LOCK_HASH="$(printf '%s' "$LOCK_VPS_ID" | sha256sum | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    LOCK_HASH="$(printf '%s' "$LOCK_VPS_ID" | shasum -a 256 | awk '{print $1}')"
  elif command -v node &>/dev/null; then
    LOCK_HASH="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$LOCK_VPS_ID")"
  elif command -v python3 &>/dev/null; then
    LOCK_HASH="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$LOCK_VPS_ID")"
  fi

  if [[ ! "$LOCK_HASH" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Error: Could not compute sha256 hash of vpsId" >&2
    exit 1
  fi

  LOCK_PATH="${LOCK_DIR}/vps-agent-${LOCK_HASH}.lock"

  if [[ -L "$LOCK_DIR" ]]; then
    echo "Error: lock directory is a symlink: ${LOCK_DIR}" >&2
    exit 1
  fi
  mkdir -p "$LOCK_DIR"
  chown root:root "$LOCK_DIR"
  chmod 0755 "$LOCK_DIR"
  if [[ ! -d "$LOCK_DIR" ]]; then
    echo "Error: lock directory path is not a directory: ${LOCK_DIR}" >&2
    exit 1
  fi

  if [[ -L "$LOCK_PATH" ]]; then
    echo "Error: lock file is a symlink, refusing to follow: ${LOCK_PATH}" >&2
    exit 1
  fi
  if [[ -e "$LOCK_PATH" && ! -f "$LOCK_PATH" ]]; then
    echo "Error: lock file path is not a regular file: ${LOCK_PATH}" >&2
    exit 1
  fi

  if [[ ! -e "$LOCK_PATH" ]]; then
    touch "$LOCK_PATH"
  fi
  chown root:root "$LOCK_PATH"
  chmod 0666 "$LOCK_PATH"

  mkdir -p "$TMPFILES_DIR"
  chown root:root "$TMPFILES_DIR"
  chmod 0755 "$TMPFILES_DIR"
  if [[ -L "$TMPFILES_FILE" ]]; then
    echo "Error: tmpfiles configuration is a symlink, refusing to follow: ${TMPFILES_FILE}" >&2
    exit 1
  fi
  printf 'd %s 0755 root root -\nf %s 0666 root root -\n' "$LOCK_DIR" "$LOCK_PATH" > "$TMPFILES_FILE"
  chmod 0644 "$TMPFILES_FILE"
  chown root:root "$TMPFILES_FILE"

  if command -v systemd-tmpfiles &>/dev/null; then
    systemd-tmpfiles --create "$TMPFILES_FILE" 2>/dev/null || true
  fi
    echo "  Provisioned singleton lock and tmpfiles: ${LOCK_PATH} (${TMPFILES_FILE})"
  fi

# ── AI rootfs atomic staging and installation ────────────────────────────
verify_staged_rootfs() {
  local rootfs_dir="$1"
  local manifest_file="$2"

  if [[ ! -d "$rootfs_dir/bin" ]]; then
    echo "Error: Staged rootfs is missing /bin directory: ${rootfs_dir}" >&2
    return 1
  fi

  if [[ ! -f "$manifest_file" ]]; then
    echo "Error: Manifest file does not exist: ${manifest_file}" >&2
    return 1
  fi

  python3 - "$rootfs_dir" "$manifest_file" <<'PY_EOF_VERIFY_STAGE'
import os, sys, json, hashlib

rootfs_dir = os.path.abspath(sys.argv[1])
manifest_path = sys.argv[2]
abs_root = os.path.abspath(rootfs_dir)
real_root = os.path.realpath(rootfs_dir)

try:
    with open(manifest_path, "r", encoding="utf-8") as f:
        mf = json.load(f)
except Exception as e:
    sys.stderr.write(f"Error: Invalid manifest JSON: {e}\n")
    sys.exit(1)

for item in mf.get("files", []):
    raw_p = item.get("path", "")
    clean = raw_p
    if clean.startswith("./"):
        clean = clean[2:]
    elif clean.startswith("/"):
        clean = clean[1:]
    parts = clean.replace("\\", "/").split("/")
    if not clean or any(p in (".", "..") or not p for p in parts):
        sys.stderr.write(f"Error: manifest file entry contains traversal component: {raw_p}\n")
        sys.exit(1)
    full_p = os.path.normpath(os.path.join(rootfs_dir, clean))
    if not (full_p == abs_root or full_p.startswith(abs_root + os.sep)):
        sys.stderr.write(f"Error: manifest file path escapes rootfs: {raw_p}\n")
        sys.exit(1)
    if os.path.islink(full_p):
        target = os.readlink(full_p)
        if target.startswith("/") or target.startswith("\\"):
            sys.stderr.write(f"Error: Symlink target is absolute (escapes rootfs): {raw_p} -> {target}\n")
            sys.exit(1)
        target_abs = os.path.abspath(os.path.join(os.path.dirname(full_p), target))
        if not (target_abs == abs_root or target_abs.startswith(abs_root + os.sep)):
            sys.stderr.write(f"Error: Symlink escapes rootfs tree: {raw_p} -> {target}\n")
            sys.exit(1)
        real_p = os.path.realpath(full_p)
        if not (real_p == real_root or real_p.startswith(real_root + os.sep)):
            sys.stderr.write(f"Error: Symlink escapes rootfs tree: {raw_p} -> {target}\n")
            sys.exit(1)
        if not os.path.isfile(full_p):
            sys.stderr.write(f"Error: Broken or non-regular symlink in manifest: {raw_p} at {full_p}\n")
            sys.exit(1)
    else:
        if not os.path.isfile(full_p):
            sys.stderr.write(f"Error: Missing regular rootfs file from manifest: {raw_p} at {full_p}\n")
            sys.exit(1)
    expected_sha = item.get("sha256", "")
    if expected_sha:
        h = hashlib.sha256()
        with open(full_p, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        if h.hexdigest() != expected_sha:
            sys.stderr.write(f"Error: SHA256 mismatch for {raw_p}: expected {expected_sha}, got {h.hexdigest()}\n")
            sys.exit(1)

for cur_dir, dirs, files in os.walk(rootfs_dir, followlinks=False):
    for entry in dirs + files:
        p = os.path.join(cur_dir, entry)
        if os.path.islink(p):
            target = os.readlink(p)
            if target.startswith("/") or target.startswith("\\"):
                sys.stderr.write(f"Error: Symlink target is absolute (escapes rootfs): {p} -> {target}\n")
                sys.exit(1)
            target_abs = os.path.abspath(os.path.join(cur_dir, target))
            if not (target_abs == abs_root or target_abs.startswith(abs_root + os.sep)):
                sys.stderr.write(f"Error: Symlink escapes rootfs tree: {p} -> {target}\n")
                sys.exit(1)
            real_p = os.path.realpath(p)
            if not (real_p == real_root or real_p.startswith(real_root + os.sep)):
                sys.stderr.write(f"Error: Symlink escapes rootfs tree: {p} -> {target}\n")
                sys.exit(1)
            if not os.path.exists(p):
                sys.stderr.write(f"Error: Broken symlink in rootfs tree: {p} -> {target}\n")
                sys.exit(1)
PY_EOF_VERIFY_STAGE
}

install_ai_rootfs() {
  local rootfs_dest="${1}"
  local manifest_dest="${2}"
  local bundle_src="${3:-}"
  local verified_tmp="${4}"
  local manifest_src="${5}"

  if [[ -z "$verified_tmp" || ! -d "$verified_tmp" ]]; then
    echo "Error: Verified rootfs source directory does not exist: ${verified_tmp}" >&2
    return 1
  fi
  if [[ -z "$manifest_src" || ! -f "$manifest_src" ]]; then
    echo "Error: Manifest source file does not exist: ${manifest_src}" >&2
    return 1
  fi

  local parent_dir
  parent_dir="$(dirname "$rootfs_dest")"
  mkdir -p "$parent_dir"
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    chown root:root "$parent_dir"
  fi
  chmod 0755 "$parent_dir"

  mkdir -p "$(dirname "$manifest_dest")"

  local stage_dir
  stage_dir="$(mktemp -d "${rootfs_dest}.stage.XXXXXX")" || {
    echo "Error: Failed to create rootfs staging directory next to ${rootfs_dest}" >&2
    return 1
  }
  if declare -p INSTALLER_TMP_FILES &>/dev/null; then
    INSTALLER_TMP_FILES+=("$stage_dir")
  fi

  # 1. Optional remote-style rootfs bundle is mapped first
  if [[ -n "$bundle_src" && -d "$bundle_src" ]]; then
    echo "[install-ai] Staging verified rootfs bundle tree into ${stage_dir}"
    if ! cp -a "$bundle_src/." "$stage_dir/"; then
      echo "Error: Failed to copy rootfs bundle into staging directory: ${stage_dir}" >&2
      rm -rf "$stage_dir"
      return 1
    fi
  fi

  # 2. Verified preflight rootfs tree from tarball overlays it
  echo "[install-ai] Staging verified rootfs tree into ${stage_dir}"
  if ! cp -a "$verified_tmp/." "$stage_dir/"; then
    echo "Error: Failed to copy verified rootfs into staging directory: ${stage_dir}" >&2
    rm -rf "$stage_dir"
    return 1
  fi

  # 3. Manifest installed in staged tree
  if ! cp -f "$manifest_src" "$stage_dir/rootfs.manifest.json"; then
    echo "Error: Failed to copy manifest into staged rootfs: ${stage_dir}" >&2
    rm -rf "$stage_dir"
    return 1
  fi
  if ! chmod 0644 "$stage_dir/rootfs.manifest.json"; then
    echo "Error: Failed to chmod manifest in staged rootfs: ${stage_dir}" >&2
    rm -rf "$stage_dir"
    return 1
  fi
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    if ! chown root:root "$stage_dir/rootfs.manifest.json"; then
      echo "Error: Failed to chown manifest in staged rootfs: ${stage_dir}" >&2
      rm -rf "$stage_dir"
      return 1
    fi
  fi

  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    chown -R root:root "$stage_dir"
  fi
  chmod -R go-w "$stage_dir"
  chmod 0755 "$stage_dir"

  # 4. Stage external manifest on same filesystem
  local manifest_stage
  manifest_stage="$(mktemp "${manifest_dest}.stage.XXXXXX")" || {
    echo "Error: Failed to create manifest staging file next to ${manifest_dest}" >&2
    rm -rf "$stage_dir"
    return 1
  }
  if declare -p INSTALLER_TMP_FILES &>/dev/null; then
    INSTALLER_TMP_FILES+=("$manifest_stage")
  fi

  if ! cp -f "$manifest_src" "$manifest_stage"; then
    echo "Error: Failed to copy manifest to ${manifest_stage}" >&2
    rm -rf "$stage_dir" "$manifest_stage"
    return 1
  fi
  if ! chmod 0644 "$manifest_stage"; then
    echo "Error: Failed to chmod ${manifest_stage}" >&2
    rm -rf "$stage_dir" "$manifest_stage"
    return 1
  fi
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    if ! chown root:root "$manifest_stage"; then
      echo "Error: Failed to chown ${manifest_stage}" >&2
      rm -rf "$stage_dir" "$manifest_stage"
      return 1
    fi
  fi

  # 5. Verify staged rootfs after overlay
  if ! verify_staged_rootfs "$stage_dir" "$manifest_src"; then
    echo "Error: Staged rootfs verification failed" >&2
    rm -rf "$stage_dir" "$manifest_stage"
    return 1
  fi

  # 6. All fallible steps passed. Move existing rootfs/manifest aside to backup directories.
  local backup_dir=""
  if [[ -e "$rootfs_dest" || -L "$rootfs_dest" ]]; then
    backup_dir="$(mktemp -d "${rootfs_dest}.old.XXXXXX")" || {
      echo "Error: Failed to create rootfs backup directory" >&2
      rm -rf "$stage_dir" "$manifest_stage"
      return 1
    }
    if ! mv "$rootfs_dest" "$backup_dir/rootfs"; then
      echo "Error: Failed to move existing rootfs aside into ${backup_dir}/rootfs" >&2
      rm -rf "$stage_dir" "$manifest_stage" "$backup_dir"
      return 1
    fi
  fi

  local backup_manifest_dir=""
  if [[ -e "$manifest_dest" || -L "$manifest_dest" ]]; then
    backup_manifest_dir="$(mktemp -d "${manifest_dest}.old.XXXXXX")" || {
      echo "Error: Failed to create manifest backup directory" >&2
      if [[ -n "$backup_dir" && -e "$backup_dir/rootfs" ]]; then
        mv "$backup_dir/rootfs" "$rootfs_dest"
      fi
      rm -rf "$stage_dir" "$manifest_stage" ${backup_dir:+"$backup_dir"}
      return 1
    }
    if ! mv "$manifest_dest" "$backup_manifest_dir/manifest"; then
      echo "Error: Failed to move existing manifest aside into ${backup_manifest_dir}/manifest" >&2
      if [[ -n "$backup_dir" && -e "$backup_dir/rootfs" ]]; then
        mv "$backup_dir/rootfs" "$rootfs_dest"
      fi
      rm -rf "$stage_dir" "$manifest_stage" ${backup_dir:+"$backup_dir"} "$backup_manifest_dir"
      return 1
    fi
  fi

  # 7. Swap staged rootfs into place
  if ! mv "$stage_dir" "$rootfs_dest"; then
    echo "Error: Failed to swap staged rootfs into place; rolling back..." >&2
    if [[ -n "$backup_dir" && -e "$backup_dir/rootfs" ]]; then
      mv "$backup_dir/rootfs" "$rootfs_dest"
    fi
    if [[ -n "$backup_manifest_dir" && -e "$backup_manifest_dir/manifest" ]]; then
      mv "$backup_manifest_dir/manifest" "$manifest_dest"
    fi
    rm -rf "$stage_dir" "$manifest_stage" ${backup_dir:+"$backup_dir"} ${backup_manifest_dir:+"$backup_manifest_dir"}
    return 1
  fi

  # 8. Swap staged manifest into place
  if ! mv "$manifest_stage" "$manifest_dest"; then
    echo "Error: Failed to swap staged manifest into place; rolling back..." >&2
    mv "$rootfs_dest" "$stage_dir"
    if [[ -n "$backup_dir" && -e "$backup_dir/rootfs" ]]; then
      mv "$backup_dir/rootfs" "$rootfs_dest"
    fi
    if [[ -n "$backup_manifest_dir" && -e "$backup_manifest_dir/manifest" ]]; then
      mv "$backup_manifest_dir/manifest" "$manifest_dest"
    fi
    rm -rf "$stage_dir" "$manifest_stage" ${backup_dir:+"$backup_dir"} ${backup_manifest_dir:+"$backup_manifest_dir"}
    return 1
  fi

  # 9. Swaps succeeded completely; remove old backup directories
  if [[ -n "$backup_dir" && -d "$backup_dir" ]]; then
    rm -rf "$backup_dir"
  fi
  if [[ -n "$backup_manifest_dir" && -d "$backup_manifest_dir" ]]; then
    rm -rf "$backup_manifest_dir"
  fi
  return 0
}

# ── AI subsystem mutation — only after the preflight gate passed ──────────
#
# Consumes ONLY the preflight-verified bundle (staged executor/helper/
# rootfs/profiles inside the registered temp dir). The rootfs tar is never
# extracted again: the verified tree is copied into place as-is.
if [[ "$INSTALL_AI" == "true" ]]; then
  echo "[AI] Installing isolated AI worker subsystem..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would create dedicated AI system user ${AI_USER} and group ${AI_GROUP}"
    echo "  [DRY-RUN] Would install helper: ${AI_HOST_HELPER_SRC} -> ${AI_HELPER_DEST}"
    echo "  [DRY-RUN] Would install executor: ${AI_EXECUTOR_SRC} -> ${AI_EXECUTOR_DEST}"
    echo "  [DRY-RUN] Would install verified AI rootfs into ${AI_ROOTFS_DIR} and manifest at ${AI_ROOTFS_MANIFEST}"
    if [[ -n "$(ls -A "$AI_PROFILES_STAGED_SRC" 2>/dev/null)" ]]; then
      echo "  [DRY-RUN] Would install profiles from bundle into ${AI_PROFILES_DIR}"
    else
      echo "  [DRY-RUN] Would write default ${AI_PROFILES_DIR}/nginx.json (no packaged profiles in bundle)"
    fi
    echo "  [DRY-RUN] Would configure ${AI_HELPER_SERVICE_NAME}.service and start it"
  else
    # Create group and user (no shell, no home, no docker group, no sudo)
    getent group "$AI_GROUP" &>/dev/null || groupadd -r "$AI_GROUP"
    getent passwd "$AI_USER" &>/dev/null || useradd -r -g "$AI_GROUP" -s /usr/sbin/nologin -d /var/empty -M "$AI_USER"

    # AI state dirs: mkdir + non-recursive chown of the top level only;
    # prior AI state is never recursively re-owned.
    mkdir -p "$AI_STATE_DIR" "$AI_SCRATCH_DIR" "$AI_STATE_DIR/backups"
    chown "$AI_USER:$AI_GROUP" "$AI_STATE_DIR" "$AI_SCRATCH_DIR" "$AI_STATE_DIR/backups"
    chmod 0750 "$AI_STATE_DIR"
    chmod 0700 "$AI_SCRATCH_DIR" "$AI_STATE_DIR/backups"

    # Rootfs dirs are root-owned; the helper read-executes them via its own
    # privileges, the AI user never needs write access.
    mkdir -p "$AI_PROFILES_DIR"
    chown root:root "$AI_PROFILES_DIR"
    chmod 0755 "$AI_PROFILES_DIR"

    install_ai_rootfs "$AI_ROOTFS_DIR" "$AI_ROOTFS_MANIFEST" "${AI_ROOTFS_STAGED_SRC:-}" "$AI_VERIFIED_ROOTFS_TMP" "$AI_ROOTFS_MANIFEST_SRC" || {
      echo "Error: Failed to install AI rootfs into ${AI_ROOTFS_DIR}" >&2
      exit 1
    }

    # Profiles: packaged profiles (flag dir or bundle, staged+verified in
    # preflight) win; the default nginx profile is written ONLY when no
    # packaged profile exists at all.
    if [[ -n "$(ls -A "$AI_PROFILES_STAGED_SRC" 2>/dev/null)" ]]; then
      echo "[install-ai] Installing packaged AI profiles into ${AI_PROFILES_DIR}"
      cp -a "$AI_PROFILES_STAGED_SRC/." "$AI_PROFILES_DIR/"
      chown root:root "$AI_PROFILES_DIR"
      chmod 0755 "$AI_PROFILES_DIR"
      chown root:root "${AI_PROFILES_DIR}"/*.json
      chmod 0644 "${AI_PROFILES_DIR}"/*.json
    else
      echo "[install-ai] No packaged profiles in bundle; writing default ${AI_PROFILES_DIR}/nginx.json"
      cat << 'EOF_NGINX' > "${AI_PROFILES_DIR}/nginx.json"
{
  "id": "nginx",
  "version": 1,
  "serviceUnit": "nginx.service",
  "allowedActions": ["status", "start", "restart", "reload"],
  "allowedConfigPaths": [
    "/etc/nginx/nginx.conf",
    "/etc/nginx/conf.d/*.conf",
    "/etc/nginx/sites-available/*",
    "/etc/nginx/sites-enabled/*"
  ],
  "validatorExec": "/usr/sbin/nginx",
  "validatorArgv": ["-t", "-c"],
  "healthCheckCmd": ["/usr/sbin/nginx", "-t"],
  "healthTimeoutSec": 10
}
EOF_NGINX
      chmod 0644 "${AI_PROFILES_DIR}/nginx.json"
      chown root:root "${AI_PROFILES_DIR}/nginx.json"
    fi

    # Install verified binaries (staged copies from the preflight temp).
    install -m 0755 "$AI_HOST_HELPER_SRC" "$AI_HELPER_DEST"
    install -m 0755 "$AI_EXECUTOR_SRC" "$AI_EXECUTOR_DEST"

    # Resolve UID and GID for helper pinned identity and config injection.
    AI_UID_NUM="$(id -u "$AI_USER")"
    AI_GID_NUM="$(getent group "$AI_GROUP" | cut -d: -f3)"
    if [[ ! "$AI_UID_NUM" =~ ^[0-9]+$ || ! "$AI_GID_NUM" =~ ^[0-9]+$ ]]; then
      echo "Error: Could not resolve numeric UID/GID for AI user: ${AI_USER}:${AI_GROUP}" >&2
      exit 1
    fi

    # Write and start helper unit
    cat << EOF_HELPER > "$AI_HELPER_UNIT_FILE"
[Unit]
Description=FlexServer AI Host Helper
After=network.target

[Service]
Type=simple
User=root
Group=${AI_GROUP}
RuntimeDirectory=flexserver-ai
RuntimeDirectoryMode=0770
ExecStart=${AI_HELPER_DEST} --socket ${AI_HELPER_SOCKET} --socket-mode 0660 --socket-uid 0 --socket-gid %G --profiles-dir ${AI_PROFILES_DIR} --execution-uid ${AI_UID_NUM} --execution-gid ${AI_GID_NUM} --executor-binary ${AI_EXECUTOR_DEST} --rootfs-dir ${AI_ROOTFS_DIR} --backups-dir ${AI_STATE_DIR}/backups
Restart=on-failure
RestartSec=2
# CAP_CHOWN is required for the helper to take ownership of the runtime
# socket (/run/flexserver-ai/helper.sock) on restart; without it chown fails
# with EPERM and the unit crash-loops under `Restart=on-failure`.
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_CHOWN CAP_SYS_CHROOT CAP_MKNOD CAP_SYS_ADMIN CAP_KILL CAP_DAC_OVERRIDE
NoNewPrivileges=no
PrivateTmp=yes
PrivateDevices=no
ProtectSystem=full
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=no
ReadWritePaths=/etc /var/lib/flexserver-ai /run/flexserver-ai
RestrictAddressFamilies=AF_UNIX AF_NETLINK
RestrictRealtime=yes
LockPersonality=yes
SystemCallFilter=@system-service
UMask=0077

[Install]
WantedBy=multi-user.target
EOF_HELPER
    chmod 0644 "$AI_HELPER_UNIT_FILE"
    systemctl daemon-reload
    systemctl enable "${AI_HELPER_SERVICE_NAME}"
    systemctl restart "${AI_HELPER_SERVICE_NAME}"
    echo "  Started ${AI_HELPER_SERVICE_NAME}"
    # Update config.json with the AI block. python3 is guaranteed by the
    # preflight prerequisite gate; a failure here means the verifier lost
    # python3 mid-run, so fail closed instead of shipping a broken config.
    if ! python3 - "$CONFIG_FILE" "$AI_UID_NUM" "$AI_GID_NUM" "$AI_HELPER_SOCKET" "$AI_EXECUTOR_DEST" "$AI_SCRATCH_DIR" "$AI_STATE_FILE" "$AI_ROOTFS_DIR" "$AI_ROOTFS_MANIFEST" "$AI_PROFILES_DIR" <<'PY_EOF_AI_CFG'
import json, sys
cfg_path = sys.argv[1]
uid, gid = int(sys.argv[2]), int(sys.argv[3])
cfg = json.load(open(cfg_path, encoding="utf-8"))
cfg["ai"] = {
    "enabled": True,
    "executionUid": uid,
    "executionGid": gid,
    "helperSocketPath": sys.argv[4],
    "executorPath": sys.argv[5],
    "scratchRootPath": sys.argv[6],
    "statePath": sys.argv[7],
    "rootfsDirPath": sys.argv[8],
    "rootfsManifestPath": sys.argv[9],
    "profilesDirPath": sys.argv[10],
    "maxConcurrentTasks": 1,
}
open(cfg_path, "w", encoding="utf-8").write(json.dumps(cfg, indent=2) + "\n")
PY_EOF_AI_CFG
    then
      echo "Error: Could not write the ai block into ${CONFIG_FILE}." >&2
      exit 1
    fi
    chown root:"${SERVICE_USER}" "$CONFIG_FILE"
    chmod 0640 "$CONFIG_FILE"
  fi
fi

# Supplementary groups for the agent service
SUPP_GROUPS=()
if [[ -n "$DOCKER_SUPPLEMENTARY_GROUPS" ]]; then
  SUPP_GROUPS+=("$DOCKER_SUPPLEMENTARY_GROUPS")
fi
if [[ "$INSTALL_AI" == "true" ]]; then
  SUPP_GROUPS+=("$AI_GROUP")
fi
SUPP_GROUPS_LINE=""
if [[ ${#SUPP_GROUPS[@]} -gt 0 ]]; then
  SUPP_GROUPS_LINE="SupplementaryGroups=$(IFS=' '; echo "${SUPP_GROUPS[*]}")"
fi
RESTRICT_NAMESPACES_LINE="RestrictNamespaces=true"
if [[ "$INSTALL_AI" == "true" ]]; then
  RESTRICT_NAMESPACES_LINE="RestrictNamespaces=false"
fi
# Write systemd unit
UNIT_CONTENT=$(
  cat <<UNIT
[Unit]
Description=VPS Manager Agent
Documentation=https://github.com/sondoan17/vps-manager-nodejs
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
${SUPP_GROUPS_LINE}
ExecStart=${BINARY_DEST} -config ${CONFIG_FILE} -state ${STATE_FILE}
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
StateDirectory=vps-manager-agent
StateDirectoryMode=0750
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
${RESTRICT_NAMESPACES_LINE}
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true

[Install]
WantedBy=multi-user.target
UNIT
)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would write systemd unit: ${UNIT_FILE}"
  echo "---"
  echo "$UNIT_CONTENT"
  echo "---"
else
  echo "$UNIT_CONTENT" > "$UNIT_FILE"
  chmod 0644 "$UNIT_FILE"
  echo "  Written systemd unit: ${UNIT_FILE}"
fi

# Reload and start
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would run: systemctl daemon-reload"
  echo "  [DRY-RUN] Would run: systemctl enable ${SERVICE_NAME}"
  echo "  [DRY-RUN] Would run: systemctl restart ${SERVICE_NAME}"
else
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  echo "  Started ${SERVICE_NAME} (enabled on boot)"
fi

if [[ "$INSTALL_CLI" == "true" && "$SKIP_CLI" == "false" ]]; then
  echo "[flexserverctl] Installing CLI..."
  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -n "$CLI_SRC" ]]; then
      echo "  [DRY-RUN] Would install ${CLI_SRC} -> ${CLI_DEST} (root:root 0755)"
    elif resolve_flexserverctl_source &>/dev/null; then
      echo "  [DRY-RUN] Would install $(resolve_flexserverctl_source) -> ${CLI_DEST} (root:root 0755)"
    else
      echo "  [DRY-RUN] Would download flexserverctl.py, then install it to ${CLI_DEST} (root:root 0755)"
    fi
  else
    # Source was fetched and validated before the install mutations.
    install_flexserverctl "$CLI_DEST" "${CLI_RESOLVED_SOURCE:-}"
  fi
fi

if [[ -z "$HOST_PTY_SRC" ]]; then
  cand_dir="$(dirname "$BINARY_SRC")"
  for cand in "${cand_dir}/host-pty-linux-amd64" "${cand_dir}/host-pty" "/app/agent/host-pty-linux-amd64" "/opt/vps-manager/host-pty-linux-amd64"; do
    if [[ -f "$cand" ]]; then
      HOST_PTY_SRC="$cand"
      break
    fi
  done
fi

# Stop the legacy PTY unit before the rotation helper starts in its new child.
# Its old RuntimeDirectory may otherwise remove the helper's new socket.
if [[ -n "$HOST_PTY_SRC" && -f "$HOST_PTY_SRC" && "$DRY_RUN" != "true" ]]; then
  systemctl stop "${HOST_PTY_SERVICE_NAME}" || true
fi

if [[ "$INSTALL_HOST_PTY" == "true" || -n "$HOST_PTY_SRC" ]] && [[ -n "$HOST_PTY_SRC" && -f "$HOST_PTY_SRC" ]]; then
  echo "[host-pty] Installing host PTY service..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would install host-pty binary: ${HOST_PTY_SRC} -> ${HOST_PTY_DEST} (root:root 0755)"
  else
    cp -f "$HOST_PTY_SRC" "$HOST_PTY_DEST"
    chown root:root "$HOST_PTY_DEST"
    chmod 0755 "$HOST_PTY_DEST"
    mkdir -p "$(dirname "$HOST_PTY_SOCKET_PATH")"
    chmod 0755 "$(dirname "$HOST_PTY_SOCKET_PATH")"
  fi

  HOST_PTY_EXTRA_ARGS=""
  if [[ -n "$HOST_PTY_SOCKET_UID" ]]; then
    HOST_PTY_EXTRA_ARGS="${HOST_PTY_EXTRA_ARGS} -socket-uid ${HOST_PTY_SOCKET_UID}"
  fi
  if [[ -n "$HOST_PTY_SOCKET_GID" ]]; then
    HOST_PTY_EXTRA_ARGS="${HOST_PTY_EXTRA_ARGS} -socket-gid ${HOST_PTY_SOCKET_GID}"
  fi

  # Only own this daemon's child directory; never the shared mount parent.
  HOST_PTY_RUNTIME_DIR_CONFIG=""
  if [[ "$HOST_PTY_SOCKET_PATH" == /var/run/flexserver/host-pty/* || "$HOST_PTY_SOCKET_PATH" == /run/flexserver/host-pty/* ]]; then
    HOST_PTY_RUNTIME_DIR_CONFIG="RuntimeDirectory=flexserver/host-pty
RuntimeDirectoryMode=0755
"
  fi

  HOST_PTY_UNIT_CONTENT=$(cat <<PTYUNIT
[Unit]
Description=VPS Manager Host PTY Daemon
Documentation=https://github.com/sondoan17/vps-manager-nodejs
After=network.target

[Service]
Type=simple
User=root
Group=root
${HOST_PTY_RUNTIME_DIR_CONFIG}ExecStart=${HOST_PTY_DEST} -socket ${HOST_PTY_SOCKET_PATH} -socket-mode 0660${HOST_PTY_EXTRA_ARGS}
Restart=always
RestartSec=5

ProtectKernelTunables=true
ProtectKernelModules=true
ProtectClock=true

[Install]
WantedBy=multi-user.target
PTYUNIT
)

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would write systemd unit: ${HOST_PTY_UNIT_FILE}"
    echo "---"
    echo "$HOST_PTY_UNIT_CONTENT"
    echo "---"
    echo "  [DRY-RUN] Would run: systemctl daemon-reload && systemctl enable ${HOST_PTY_SERVICE_NAME} && systemctl restart ${HOST_PTY_SERVICE_NAME}"
  else
    echo "$HOST_PTY_UNIT_CONTENT" > "$HOST_PTY_UNIT_FILE"
    chmod 0644 "$HOST_PTY_UNIT_FILE"
    systemctl daemon-reload
    systemctl enable "${HOST_PTY_SERVICE_NAME}"
    # Start after rotator migration: its old unit may still clean the shared parent.
  fi
fi

if [[ -z "$ROTATOR_SRC" ]]; then
  cand_dir="$(dirname "$BINARY_SRC")"
  for cand in "${cand_dir}/local-agent-rotator-linux-amd64" "${cand_dir}/local-agent-rotator" "/app/agent/local-agent-rotator-linux-amd64" "/opt/vps-manager/local-agent-rotator-linux-amd64"; do
    if [[ -f "$cand" ]]; then
      ROTATOR_SRC="$cand"
      break
    fi
  done
fi

if [[ "$INSTALL_ROTATOR" == "true" || -n "$ROTATOR_SRC" ]] && [[ -n "$ROTATOR_SRC" && -f "$ROTATOR_SRC" ]]; then
  echo "[rotator] Installing local agent rotation helper service..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would install rotator binary: ${ROTATOR_SRC} -> ${ROTATOR_DEST} (root:root 0755)"
  else
    cp -f "$ROTATOR_SRC" "$ROTATOR_DEST"
    chown root:root "$ROTATOR_DEST"
    chmod 0755 "$ROTATOR_DEST"
    mkdir -p "$(dirname "$ROTATOR_SOCKET_PATH")"
    chmod 0755 "$(dirname "$ROTATOR_SOCKET_PATH")"
  fi

  ROTATOR_EXTRA_ARGS=""
  if [[ -n "$HOST_PTY_SOCKET_UID" ]]; then
    ROTATOR_EXTRA_ARGS="${ROTATOR_EXTRA_ARGS} -socket-uid ${HOST_PTY_SOCKET_UID}"
  fi
  if [[ -n "$HOST_PTY_SOCKET_GID" ]]; then
    ROTATOR_EXTRA_ARGS="${ROTATOR_EXTRA_ARGS} -socket-gid ${HOST_PTY_SOCKET_GID}"
  fi

  ROTATOR_RUNTIME_DIR_CONFIG=""
  if [[ "$ROTATOR_SOCKET_PATH" == /var/run/flexserver/agent-rotation/* || "$ROTATOR_SOCKET_PATH" == /run/flexserver/agent-rotation/* ]]; then
    ROTATOR_RUNTIME_DIR_CONFIG="RuntimeDirectory=flexserver/agent-rotation
RuntimeDirectoryMode=0755
"
  fi

  ROTATOR_UNIT_CONTENT=$(cat <<ROTATORUNIT
[Unit]
Description=VPS Manager Local Agent Rotation Helper Daemon
Documentation=https://github.com/sondoan17/vps-manager-nodejs
After=network.target

[Service]
Type=simple
User=root
Group=root
${ROTATOR_RUNTIME_DIR_CONFIG}ExecStart=${ROTATOR_DEST} -server -socket ${ROTATOR_SOCKET_PATH} -socket-mode 0660${ROTATOR_EXTRA_ARGS} -config ${CONFIG_FILE} -service-name ${SERVICE_NAME}
Restart=always
RestartSec=5

ProtectKernelTunables=true
ProtectKernelModules=true
ProtectClock=true

[Install]
WantedBy=multi-user.target
ROTATORUNIT
)

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would write systemd unit: ${ROTATOR_UNIT_FILE}"
    echo "---"
    echo "$ROTATOR_UNIT_CONTENT"
    echo "---"
    echo "  [DRY-RUN] Would run: systemctl daemon-reload && systemctl enable ${ROTATOR_SERVICE_NAME} && systemctl restart ${ROTATOR_SERVICE_NAME}"
  else
    echo "$ROTATOR_UNIT_CONTENT" > "$ROTATOR_UNIT_FILE"
    chmod 0644 "$ROTATOR_UNIT_FILE"
    systemctl daemon-reload
    systemctl enable "${ROTATOR_SERVICE_NAME}"
    systemctl restart "${ROTATOR_SERVICE_NAME}"
    echo "  Started ${ROTATOR_SERVICE_NAME} (socket: ${ROTATOR_SOCKET_PATH})"
  fi
fi
if [[ -n "$HOST_PTY_SRC" && -f "$HOST_PTY_SRC" && "$DRY_RUN" != "true" ]]; then
  systemctl restart "${HOST_PTY_SERVICE_NAME}"
  echo "  Started ${HOST_PTY_SERVICE_NAME} (socket: ${HOST_PTY_SOCKET_PATH})"
fi

echo ""
echo "[Install] VPS Manager Agent installed successfully."
echo "  Binary:     ${BINARY_DEST}"
echo "  Config:     ${CONFIG_FILE}"
echo "  Service:    ${SERVICE_NAME}"
echo ""
echo "Check status: sudo systemctl status ${SERVICE_NAME}"
echo "View logs:    sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
