#!/usr/bin/env bash
#
# prepare-agent-updater.sh — Shared idempotent host helper for local agent updater.
#
# Idempotently extracts the bundled updater from a running deployed API container,
# validates host architecture, reuses valid existing credentials/config without rotation,
# bootstraps credentials if absent or invalid, sets secure DAC modes, updates only when
# binary or config SHA changed, waits for in-flight journals, refreshes host-pty and
# ai-host-helper helpers while idle, installs secure shared root registry, and never
# touches the running agent binary.
#
# Usage:
#   sudo ./scripts/install/prepare-agent-updater.sh [options]
#
# Options:
#   --compose-file <path>     Path to docker-compose.yml
#   --container <id|name>     Explicit running API container name or ID
#   --image <image>           API image fallback if container is stopped/offline
#   --backend-url <url>       Backend URL for absent updater bootstrap
#   --agent-state-dir <path>  Host agent state directory (default: /var/lib/vps-manager-agent)
#   --updater-config <path>   Updater config path (default: /etc/vps-updater/config.json)
#   --updater-dest <path>     Updater binary destination (default: /usr/local/lib/vps-manager-agent/vps-updater)
#   --updater-state-dir <path> Updater state directory (default: /var/lib/vps-updater)
#   --arch <arch>             Architecture override ("amd64" or "arm64")
#   --skip-systemd            Skip systemctl reload/restart (for containers or test harnesses)
#   --dry-run                 Echo actions without modifying filesystem or services
#   --help|-h                 Show this help

set -euo pipefail
umask 022

COMPOSE_FILE=""
CONTAINER_OVERRIDE=""
IMAGE_OVERRIDE=""
BACKEND_URL=""
AGENT_STATE_DIR="/var/lib/vps-manager-agent"
UPDATER_CONFIG="/etc/vps-updater/config.json"
UPDATER_DEST="/usr/local/lib/vps-manager-agent/vps-updater"
UPDATER_STATE_DIR="/var/lib/vps-updater"
ARCH_OVERRIDE=""
SKIP_SYSTEMD=false
BINARY_OVERRIDE=""
DRY_RUN=false
PREPARE_STATUS="ok"
EXPLICIT_AGENT_STATE_DIR=""
EXPLICIT_UPDATER_STATE_DIR=""
EXPLICIT_AGENT_BINARY=""
EXPLICIT_AGENT_UNIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file)
      COMPOSE_FILE="$2"; shift 2 ;;
    --container)
      CONTAINER_OVERRIDE="$2"; shift 2 ;;
    --image)
      IMAGE_OVERRIDE="$2"; shift 2 ;;
    --backend-url)
      BACKEND_URL="$2"; shift 2 ;;
    --agent-state-dir)
      AGENT_STATE_DIR="$2"; EXPLICIT_AGENT_STATE_DIR="$2"; shift 2 ;;
    --updater-config)
      UPDATER_CONFIG="$2"; shift 2 ;;
    --updater-dest)
      UPDATER_DEST="$2"; shift 2 ;;
    --updater-state-dir)
      UPDATER_STATE_DIR="$2"; EXPLICIT_UPDATER_STATE_DIR="$2"; shift 2 ;;
    --agent-binary)
      EXPLICIT_AGENT_BINARY="$2"; shift 2 ;;
    --agent-unit)
      EXPLICIT_AGENT_UNIT="$2"; shift 2 ;;
    --arch)
      ARCH_OVERRIDE="$2"; shift 2 ;;
    --binary)
      BINARY_OVERRIDE="$2"; shift 2 ;;
    --skip-systemd)
      SKIP_SYSTEMD=true; shift ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --help|-h)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Error: Unknown argument $1" >&2
      exit 1 ;;
  esac
done

if [[ "$DRY_RUN" != "true" && "$(id -u)" -ne 0 ]]; then
  echo "Error: prepare-agent-updater.sh requires root privileges (or use --dry-run)." >&2
  exit 1
fi

# Locate installer-lib.sh
INSTALLER_LIB_PATH=""
if [[ -f "./installer-lib.sh" ]]; then
  INSTALLER_LIB_PATH="$(pwd)/installer-lib.sh"
elif [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  INSTALLER_LIB_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/installer-lib.sh"
fi
if [[ -f "$INSTALLER_LIB_PATH" ]]; then
  # shellcheck source=scripts/install/installer-lib.sh
  source "$INSTALLER_LIB_PATH"
fi

INSTALLER_TMP_FILES=()
cleanup_tmps() {
  for f in "${INSTALLER_TMP_FILES[@]}"; do
    rm -rf "$f" 2>/dev/null || true
  done
}
trap cleanup_tmps EXIT

# ── 1. Determine architecture ───────────────────────────────────────────────
ARCH=""
RAW_ARCH="${ARCH_OVERRIDE:-$(uname -m)}"
case "$RAW_ARCH" in
  x86_64|amd64)
    ARCH="amd64" ;;
  aarch64|arm64)
    ARCH="arm64" ;;
  *)
    echo "Error: Unsupported architecture: ${RAW_ARCH}" >&2
    exit 1 ;;
esac

# ── 2. Locate running API container ─────────────────────────────────────────
API_CONTAINER=""
if [[ -n "$CONTAINER_OVERRIDE" ]]; then
  API_CONTAINER="$CONTAINER_OVERRIDE"
elif [[ "$DRY_RUN" != "true" ]]; then
  if [[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]]; then
    API_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null || true)"
  fi
  if [[ -z "$API_CONTAINER" ]]; then
    for cand in "/opt/vps-manager/docker-compose.yml" "./docker-compose.yml" "../docker-compose.yml"; do
      if [[ -f "$cand" ]]; then
        API_CONTAINER="$(docker compose -f "$cand" ps -q api 2>/dev/null || true)"
        if [[ -n "$API_CONTAINER" ]]; then
          COMPOSE_FILE="$cand"
          break
        fi
      fi
    done
  fi
  if [[ -z "$API_CONTAINER" ]]; then
    API_CONTAINER="$(docker ps --filter "label=com.docker.compose.service=api" --filter "status=running" -q 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -z "$API_CONTAINER" ]]; then
    API_CONTAINER="$(docker ps --filter "name=api" --filter "status=running" -q 2>/dev/null | head -n 1 || true)"
  fi
fi

if [[ -z "$API_CONTAINER" && -z "$IMAGE_OVERRIDE" && "$DRY_RUN" != "true" ]]; then
  echo "Error: Running API container not found to extract bundled updater binary." >&2
  exit 1
fi

get_sha256() {
  local p="$1"
  if [[ ! -f "$p" ]]; then echo ""; return; fi
  if command -v sha256sum &>/dev/null; then
    sha256sum "$p" | awk '{print $1}'
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "$p" | awk '{print $1}'
  elif command -v python3 &>/dev/null; then
    python3 -c "import hashlib, sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$p" 2>/dev/null || echo ""
  fi
}

# ── 3. Extract bundled updater binary from running container ───────────────
TMP_UPDATER="$(mktemp /tmp/vps-updater-extracted.XXXXXX)"
INSTALLER_TMP_FILES+=("$TMP_UPDATER")

if [[ -n "$BINARY_OVERRIDE" && -f "$BINARY_OVERRIDE" ]]; then
  cp -f "$BINARY_OVERRIDE" "$TMP_UPDATER"
  chmod 0755 "$TMP_UPDATER"
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would extract /app/agent/vps-updater-linux-${ARCH} from running API container."
  printf '#!/bin/sh\necho "vps-updater 1.0.0 (build dev)"\n' > "$TMP_UPDATER"
  chmod 0755 "$TMP_UPDATER"
else
  EXTRACT_OK=false
  if [[ -n "$API_CONTAINER" ]]; then
    if docker cp "${API_CONTAINER}:/app/agent/vps-updater-linux-${ARCH}" "$TMP_UPDATER" 2>/dev/null && [[ -s "$TMP_UPDATER" ]]; then
      EXTRACT_OK=true
    fi
  fi
  if [[ "$EXTRACT_OK" != "true" && -n "$IMAGE_OVERRIDE" ]]; then
    if docker run --rm --entrypoint cat "$IMAGE_OVERRIDE" "/app/agent/vps-updater-linux-${ARCH}" > "$TMP_UPDATER" 2>/dev/null && [[ -s "$TMP_UPDATER" ]]; then
      EXTRACT_OK=true
    fi
  fi
  if [[ "$EXTRACT_OK" != "true" ]]; then
    echo "Error: Failed to extract bundled updater binary (/app/agent/vps-updater-linux-${ARCH}) from API container." >&2
    exit 1
  fi
  chmod 0755 "$TMP_UPDATER"
fi

# ── 4. Reuse or bootstrap updater configuration ────────────────────────────
CONFIG_TMP="$(mktemp /tmp/vps-updater-cfg.XXXXXX)"
INSTALLER_TMP_FILES+=("$CONFIG_TMP")

is_valid_config() {
  local cfg_file="$1"
  if [[ ! -f "$cfg_file" || ! -s "$cfg_file" ]]; then return 1; fi
  if command -v python3 &>/dev/null; then
    python3 -c '
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        d = json.load(f)
    if not isinstance(d, dict): sys.exit(1)
    cred = d.get("credential", "")
    api = d.get("apiBase", "")
    if not cred or not str(cred).startswith("vma_"): sys.exit(1)
    if not api: sys.exit(1)
    sys.exit(0)
except Exception:
    sys.exit(1)
' "$cfg_file" 2>/dev/null
  else
    grep -q '"credential"[[:space:]]*:[[:space:]]*"vma_' "$cfg_file" 2>/dev/null && \
    grep -q '"apiBase"' "$cfg_file" 2>/dev/null
  fi
}

discover_agent_binary() {
  if [[ -n "$EXPLICIT_AGENT_BINARY" ]]; then
    echo "$EXPLICIT_AGENT_BINARY"
    return 0
  fi
  if command -v systemctl &>/dev/null; then
    local bin
    bin="$(systemctl show -p ExecStart --value vps-manager-agent.service 2>/dev/null | awk '{print $1}' | sed 's/path=//' | tr -d '{};:' || true)"
    if [[ -n "$bin" && -x "$bin" ]]; then
      echo "$bin"
      return 0
    fi
  fi
  if [[ -x "/usr/local/bin/vps-manager-agent" ]]; then
    echo "/usr/local/bin/vps-manager-agent"
    return 0
  fi
  if [[ -x "/usr/local/lib/vps-manager-agent/vps-manager-agent" ]]; then
    echo "/usr/local/lib/vps-manager-agent/vps-manager-agent"
    return 0
  fi
  echo "/usr/local/bin/vps-manager-agent"
}

discover_agent_unit() {
  if [[ -n "$EXPLICIT_AGENT_UNIT" ]]; then
    echo "$EXPLICIT_AGENT_UNIT"
    return 0
  fi
  if [[ -f "/etc/systemd/system/vps-manager-agent.service" ]] || \
     [[ -f "/lib/systemd/system/vps-manager-agent.service" ]]; then
    echo "vps-manager-agent.service"
    return 0
  fi
  echo "vps-manager-agent.service"
}

discover_agent_state_dir() {
  if [[ -n "$EXPLICIT_AGENT_STATE_DIR" ]]; then
    echo "$EXPLICIT_AGENT_STATE_DIR"
    return 0
  fi
  if [[ -n "${FLEXSERVER_AGENT_STATE_DIR:-}" ]]; then
    echo "$FLEXSERVER_AGENT_STATE_DIR"
    return 0
  fi
  if [[ -d "/var/lib/vps-manager-agent/docker-applications" || -d "/var/lib/vps-manager-agent" ]]; then
    echo "/var/lib/vps-manager-agent"
    return 0
  fi
  if [[ -n "${HOME:-}" && -d "${HOME}/.flexserver/agent/docker-applications" ]]; then
    echo "${HOME}/.flexserver/agent"
    return 0
  fi
  echo "/var/lib/vps-manager-agent"
}

normalize_and_write_config() {
  local src="$1"
  local dest="$2"
  local def_state="$3"
  local def_agent_dir="$4"
  local exp_state="${EXPLICIT_UPDATER_STATE_DIR:-}"
  local exp_agent_state="${EXPLICIT_AGENT_STATE_DIR:-}"
  local exp_agent_bin="${EXPLICIT_AGENT_BINARY:-}"
  local exp_agent_unit="${EXPLICIT_AGENT_UNIT:-}"
  local disc_bin
  disc_bin="$(discover_agent_binary)"
  local disc_unit
  disc_unit="$(discover_agent_unit)"
  local disc_state
  disc_state="$(discover_agent_state_dir)"

  if command -v python3 &>/dev/null; then
    python3 -c '
import json, sys
src, dest, def_state, def_agent_dir, exp_state, exp_agent_state, exp_agent_bin, exp_agent_unit, disc_bin, disc_unit, disc_state = sys.argv[1:12]
with open(src, "r", encoding="utf-8") as f:
    d = json.load(f)

if exp_state:
    d["stateDir"] = exp_state
elif not d.get("stateDir"):
    d["stateDir"] = def_state

if exp_agent_state:
    d["agentStateDir"] = exp_agent_state
elif not d.get("agentStateDir"):
    d["agentStateDir"] = disc_state if disc_state else def_agent_dir

if exp_agent_bin:
    d["agentBinary"] = exp_agent_bin
elif not d.get("agentBinary"):
    d["agentBinary"] = disc_bin if disc_bin else "/usr/local/bin/vps-manager-agent"

if exp_agent_unit:
    d["agentUnit"] = exp_agent_unit
elif not d.get("agentUnit"):
    d["agentUnit"] = disc_unit if disc_unit else "vps-manager-agent.service"

with open(dest, "w", encoding="utf-8") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
' "$src" "$dest" "$def_state" "$def_agent_dir" "$exp_state" "$exp_agent_state" "$exp_agent_bin" "$exp_agent_unit" "$disc_bin" "$disc_unit" "$disc_state"
  elif command -v node &>/dev/null; then
    node -e '
const fs = require("fs");
const [src, dest, defState, defAgentDir, expState, expAgentState, expAgentBin, expAgentUnit, discBin, discUnit, discState] = process.argv.slice(1);
const d = JSON.parse(fs.readFileSync(src, "utf8"));
if (expState) d.stateDir = expState;
else if (!d.stateDir) d.stateDir = defState;

if (expAgentState) d.agentStateDir = expAgentState;
else if (!d.agentStateDir) d.agentStateDir = discState || defAgentDir;

if (expAgentBin) d.agentBinary = expAgentBin;
else if (!d.agentBinary) d.agentBinary = discBin || "/usr/local/bin/vps-manager-agent";

if (expAgentUnit) d.agentUnit = expAgentUnit;
else if (!d.agentUnit) d.agentUnit = discUnit || "vps-manager-agent.service";

fs.writeFileSync(dest, JSON.stringify(d, null, 2) + "\n", "utf8");
' "$src" "$dest" "$def_state" "$def_agent_dir" "$exp_state" "$exp_agent_state" "$exp_agent_bin" "$exp_agent_unit" "$disc_bin" "$disc_unit" "$disc_state"
  else
    cp -f "$src" "$dest"
  fi
}

NEED_BOOTSTRAP=false
if is_valid_config "$UPDATER_CONFIG"; then
  echo "  Reusing valid existing updater configuration from ${UPDATER_CONFIG}."
  normalize_and_write_config "$UPDATER_CONFIG" "$CONFIG_TMP" "$UPDATER_STATE_DIR" "$AGENT_STATE_DIR"
else
  NEED_BOOTSTRAP=true
fi

if [[ "$NEED_BOOTSTRAP" == "true" ]]; then
  echo "  Bootstrapping absent or invalid updater configuration..."
  if [[ -z "$BACKEND_URL" ]]; then
    # Look for .env next to compose file or in /opt/vps-manager
    APP_DIR="/opt/vps-manager"
    if [[ -n "$COMPOSE_FILE" ]]; then APP_DIR="$(dirname "$COMPOSE_FILE")"; fi
    if [[ -f "${APP_DIR}/.env" ]]; then
      BACKEND_URL="$(grep -E '^(AGENT_PUBLIC_BASE_URL|BACKEND_URL|DASHBOARD_PUBLIC_ORIGIN)=' "${APP_DIR}/.env" | head -n 1 | cut -d= -f2- | tr -d '"'\'' ' || true)"
    fi
  fi
  if [[ -z "$BACKEND_URL" ]]; then
    BACKEND_URL="https://127.0.0.1:38281"
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would execute bootstrap-local-updater inside API container for URL: ${BACKEND_URL}"
    disc_bin="$(discover_agent_binary)"
    disc_unit="$(discover_agent_unit)"
    disc_state="$(discover_agent_state_dir)"
    act_bin="${EXPLICIT_AGENT_BINARY:-$disc_bin}"
    act_unit="${EXPLICIT_AGENT_UNIT:-$disc_unit}"
    act_state="${EXPLICIT_AGENT_STATE_DIR:-$disc_state}"
    act_upd_state="${EXPLICIT_UPDATER_STATE_DIR:-$UPDATER_STATE_DIR}"
    cat > "$CONFIG_TMP" <<EOF
{
  "apiBase": "${BACKEND_URL}",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "${act_bin}",
  "agentUnit": "${act_unit}",
  "stateDir": "${act_upd_state}",
  "agentStateDir": "${act_state}"
}
EOF
  else
    BOOTSTRAP_CMD="node dist/scripts/bootstrap-local-updater.js --backend-url ${BACKEND_URL} --rotate"
    JSON_OUT=""
    if [[ -n "$API_CONTAINER" ]]; then
      JSON_OUT="$(docker exec -i "$API_CONTAINER" $BOOTSTRAP_CMD 2>/dev/null || true)"
    fi
    if [[ -z "$JSON_OUT" && -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]]; then
      JSON_OUT="$(docker compose -f "$COMPOSE_FILE" exec -T api $BOOTSTRAP_CMD 2>/dev/null || true)"
    fi
    TOKEN="$(printf '%s' "$JSON_OUT" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    if [[ -z "$TOKEN" ]]; then
      echo "Error: Failed to bootstrap local updater credential from API container." >&2
      exit 1
    fi
    disc_bin="$(discover_agent_binary)"
    disc_unit="$(discover_agent_unit)"
    disc_state="$(discover_agent_state_dir)"
    act_bin="${EXPLICIT_AGENT_BINARY:-$disc_bin}"
    act_unit="${EXPLICIT_AGENT_UNIT:-$disc_unit}"
    act_state="${EXPLICIT_AGENT_STATE_DIR:-$disc_state}"
    act_upd_state="${EXPLICIT_UPDATER_STATE_DIR:-$UPDATER_STATE_DIR}"
    cat > "$CONFIG_TMP" <<EOF
{
  "apiBase": "${BACKEND_URL}",
  "credential": "${TOKEN}",
  "agentBinary": "${act_bin}",
  "agentUnit": "${act_unit}",
  "stateDir": "${act_upd_state}",
  "agentStateDir": "${act_state}"
}
EOF
    echo "  Local updater credential provisioned without exposing secret."
  fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Prepared configuration:"
  cat "$CONFIG_TMP"
fi

# ── 5. Helper refresh while idle & root-controlled shared registry ──────────
refresh_helpers_if_idle() {
  local container="$1"
  local arch="$2"
  local agent_dir="$3"

  local reg_group="root"
  if getent group vps-manager-agent &>/dev/null; then
    reg_group="vps-manager-agent"
  elif getent group vps-updater &>/dev/null; then
    reg_group="vps-updater"
  fi

  # Secure root-controlled shared registry directory and initial lock registry
  if [[ "$DRY_RUN" != "true" ]]; then
    if getent group vps-updater &>/dev/null && getent passwd vps-manager-agent &>/dev/null; then
      usermod -a -G vps-updater vps-manager-agent 2>/dev/null || true
    fi
    mkdir -p "${agent_dir}"
    chown root:"$reg_group" "${agent_dir}"
    chmod 1770 "${agent_dir}"

    mkdir -p "${agent_dir}/docker-applications"
    chown root:"$reg_group" "${agent_dir}/docker-applications"
    chmod 0755 "${agent_dir}/docker-applications"

    local excl_file="${agent_dir}/docker-applications/exclusion.json"
    if [[ ! -f "$excl_file" ]]; then
      printf '[]\n' > "$excl_file"
    fi
    chown root:"$reg_group" "$excl_file"
    chmod 0664 "$excl_file"

    local lock_f="${agent_dir}/docker-applications/exclusion.json.lock"
    touch "$lock_f"
    chown root:"$reg_group" "$lock_f"
    chmod 0664 "$lock_f"
  else
    echo "  [DRY-RUN] Would ensure secure root-controlled shared registry at ${agent_dir} (root:${reg_group} 1770 parent, 0755 docker-applications, 0664 files)"
  fi

  local lock_f="${agent_dir}/docker-applications/exclusion.json.lock"
  local excl_f="${agent_dir}/docker-applications/exclusion.json"
  local lock_held=false

  if [[ "$DRY_RUN" != "true" && -f "$lock_f" ]]; then
    exec 9<>"$lock_f"
    if flock -x -w 5 9 2>/dev/null; then
      lock_held=true
    else
      echo "  [prepare-agent-updater] Registry lock held by active workload; deferring helper refresh."
      exec 9>&-
      return 0
    fi
  fi

  # Helper 1: host-pty
  local host_pty_dest="/usr/local/bin/flexserver-host-pty"
  local host_pty_service="flexserver-host-pty.service"
  local host_pty_installed=false
  if [[ -f "/etc/systemd/system/${host_pty_service}" || -f "/lib/systemd/system/${host_pty_service}" ]] || \
     systemctl list-unit-files "$host_pty_service" &>/dev/null; then
    host_pty_installed=true
  fi

  local tmp_host_pty
  tmp_host_pty="$(mktemp /tmp/host-pty-extracted.XXXXXX)"
  INSTALLER_TMP_FILES+=("$tmp_host_pty")
  local have_host_pty=false
  if [[ -n "$container" && "$DRY_RUN" != "true" ]]; then
    if docker cp "${container}:/app/agent/host-pty-linux-${arch}" "$tmp_host_pty" 2>/dev/null && [[ -s "$tmp_host_pty" ]]; then
      have_host_pty=true
      chmod 0755 "$tmp_host_pty"
    fi
  fi

  if [[ "$host_pty_installed" == "true" && "$have_host_pty" == "true" ]]; then
    local pty_busy=false
    local host_pty_sock=""
    if [[ -S "/run/flexserver/host-pty/host-pty.sock" ]]; then
      host_pty_sock="/run/flexserver/host-pty/host-pty.sock"
    elif [[ -S "/var/run/flexserver/host-pty/host-pty.sock" ]]; then
      host_pty_sock="/var/run/flexserver/host-pty/host-pty.sock"
    fi

    if [[ -n "$host_pty_sock" ]]; then
      local host_pty_marker=""
      if [[ -f "/run/flexserver/host-pty/active_sessions" ]]; then
        host_pty_marker="/run/flexserver/host-pty/active_sessions"
      elif [[ -f "/var/run/flexserver/host-pty/active_sessions" ]]; then
        host_pty_marker="/var/run/flexserver/host-pty/active_sessions"
      fi

      if [[ -z "$host_pty_marker" ]]; then
        pty_busy=true
      else
        local count
        if ! count="$(cat "$host_pty_marker" 2>/dev/null | tr -d '[:space:]')"; then
          pty_busy=true
        elif [[ ! "$count" =~ ^[0-9]+$ ]] || [[ "$count" -gt 0 ]]; then
          pty_busy=true
        fi
      fi
    fi

    if [[ -f "$excl_f" ]] && grep -q '"scope"[[:space:]]*:[[:space:]]*"terminal:' "$excl_f" 2>/dev/null; then
      pty_busy=true
    fi

    if [[ "$pty_busy" == "true" ]]; then
      echo "  [prepare-agent-updater] host-pty has active sessions; deferring refresh."
    else
      local curr_pty_sha
      local new_pty_sha
      curr_pty_sha="$(get_sha256 "$host_pty_dest")"
      new_pty_sha="$(get_sha256 "$tmp_host_pty")"
      if [[ -z "$curr_pty_sha" || "$curr_pty_sha" != "$new_pty_sha" ]]; then
        echo "  Refreshing host-pty helper binary..."
        mkdir -p "$(dirname "$host_pty_dest")"
        local tmp_t="${host_pty_dest}.tmp.$$"
        cp -f "$tmp_host_pty" "$tmp_t"
        chown root:root "$tmp_t"
        chmod 0755 "$tmp_t"
        mv -f "$tmp_t" "$host_pty_dest"
        if [[ ! -e "/usr/local/bin/host-pty" ]]; then
          ln -sf "$host_pty_dest" "/usr/local/bin/host-pty" 2>/dev/null || true
        fi
        if [[ "$SKIP_SYSTEMD" != "true" ]] && systemctl is-active --quiet "$host_pty_service" 2>/dev/null; then
          echo "  Restarting ${host_pty_service}..."
          if ! systemctl restart "$host_pty_service"; then
            echo "Warning: Failed to restart ${host_pty_service}" >&2
            PREPARE_STATUS="warning"
          elif ! systemctl is-active --quiet "$host_pty_service"; then
            echo "Warning: ${host_pty_service} is not active after restart" >&2
            PREPARE_STATUS="warning"
          else
            echo "  Restarted and verified ${host_pty_service}."
          fi
        fi
      fi
    fi
  fi

  # Helper 2: ai-host-helper
  local ai_helper_dest="/usr/local/sbin/ai-host-helper"
  local ai_helper_service="flexserver-ai-helper.service"
  local ai_helper_installed=false
  if [[ -f "/etc/systemd/system/${ai_helper_service}" || -f "/lib/systemd/system/${ai_helper_service}" ]] || \
     systemctl list-unit-files "$ai_helper_service" &>/dev/null; then
    ai_helper_installed=true
  fi

  local tmp_ai_helper
  tmp_ai_helper="$(mktemp /tmp/ai-helper-extracted.XXXXXX)"
  INSTALLER_TMP_FILES+=("$tmp_ai_helper")
  local have_ai_helper=false
  if [[ -n "$container" && "$DRY_RUN" != "true" ]]; then
    if docker cp "${container}:/app/agent/ai-host-helper-linux-${arch}" "$tmp_ai_helper" 2>/dev/null && [[ -s "$tmp_ai_helper" ]]; then
      have_ai_helper=true
      chmod 0755 "$tmp_ai_helper"
    fi
  fi

  if [[ "$ai_helper_installed" == "true" && "$have_ai_helper" == "true" ]]; then
    local ai_busy=false
    local cgroup_base="/sys/fs/cgroup/flexserver-ai"
    if [[ -d "$cgroup_base" ]]; then
      local entries
      if ! entries="$(ls -A "$cgroup_base" 2>/dev/null)"; then
        ai_busy=true
      elif [[ -n "$entries" ]]; then
        for sub in "$cgroup_base"/*; do
          if [[ -d "$sub" ]]; then
            ai_busy=true
            break
          fi
        done
      fi
    fi

    if [[ -f "$excl_f" ]] && grep -q '"scope"[[:space:]]*:[[:space:]]*"ai:' "$excl_f" 2>/dev/null; then
      ai_busy=true
    fi

    if [[ "$ai_busy" == "true" ]]; then
      echo "  [prepare-agent-updater] ai-host-helper has active tasks; deferring refresh."
    else
      local curr_ai_sha
      local new_ai_sha
      curr_ai_sha="$(get_sha256 "$ai_helper_dest")"
      new_ai_sha="$(get_sha256 "$tmp_ai_helper")"
      if [[ -z "$curr_ai_sha" || "$curr_ai_sha" != "$new_ai_sha" ]]; then
        echo "  Refreshing ai-host-helper binary..."
        mkdir -p "$(dirname "$ai_helper_dest")"
        local tmp_ai="${ai_helper_dest}.tmp.$$"
        cp -f "$tmp_ai_helper" "$tmp_ai"
        chown root:root "$tmp_ai"
        chmod 0755 "$tmp_ai"
        mv -f "$tmp_ai" "$ai_helper_dest"
        if [[ "$SKIP_SYSTEMD" != "true" ]] && systemctl is-active --quiet "$ai_helper_service" 2>/dev/null; then
          echo "  Restarting ${ai_helper_service}..."
          if ! systemctl restart "$ai_helper_service"; then
            echo "Warning: Failed to restart ${ai_helper_service}" >&2
            PREPARE_STATUS="warning"
          elif ! systemctl is-active --quiet "$ai_helper_service"; then
            echo "Warning: ${ai_helper_service} is not active after restart" >&2
            PREPARE_STATUS="warning"
          else
            echo "  Restarted and verified ${ai_helper_service}."
          fi
        fi
      fi
    fi
  fi

  if [[ "$lock_held" == "true" ]]; then
    flock -u 9 2>/dev/null || true
    exec 9>&-
  fi
}
refresh_helpers_if_idle "$API_CONTAINER" "$ARCH" "$AGENT_STATE_DIR"

# ── 6. Check for in-flight journals & wait ──────────────────────────────────
wait_for_updater_journal() {
  local state_dir="$1"
  local max_wait=30
  local waited=0
  while [[ $waited -lt $max_wait ]]; do
    local in_flight=false
    if [[ -f "${state_dir}/journal.json" ]]; then
      if grep -Eq '"phase"[[:space:]]*:[[:space:]]*"(intent|renamed)"' "${state_dir}/journal.json" 2>/dev/null; then
        in_flight=true
      fi
    fi
    if [[ -f "${state_dir}/helper/journal.json" ]]; then
      if grep -Eq '"phase"[[:space:]]*:[[:space:]]*"(intent|renamed)"' "${state_dir}/helper/journal.json" 2>/dev/null; then
        in_flight=true
      fi
    fi
    if [[ "$in_flight" == "false" ]]; then
      return 0
    fi
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Active updater journal in mutation/recovery detected (${state_dir}); would wait for settlement."
      return 1
    fi
    echo "  [prepare-agent-updater] Updater journal mutation/recovery in progress; waiting (${waited}s)..."
    sleep 2
    waited=$((waited + 2))
  done
  echo "Warning: Updater journal did not settle within ${max_wait}s; deferring daemon mutation." >&2
  return 1
}
if [[ -d "$UPDATER_STATE_DIR" ]]; then
  if ! wait_for_updater_journal "$UPDATER_STATE_DIR"; then
    echo "Warning: Active updater journal in mutation/recovery detected; deferring updater installation." >&2
    exit 0
  fi
fi

# ── 7. Check if binary and config changed (SHA changes only) ───────────────
CURRENT_BIN_SHA="$(get_sha256 "$UPDATER_DEST")"
NEW_BIN_SHA="$(get_sha256 "$TMP_UPDATER")"
CURRENT_CFG_SHA="$(get_sha256 "$UPDATER_CONFIG")"
NEW_CFG_SHA="$(get_sha256 "$CONFIG_TMP")"

ALREADY_CURRENT=false
if [[ -n "$CURRENT_BIN_SHA" && "$CURRENT_BIN_SHA" == "$NEW_BIN_SHA" ]] && \
   [[ -n "$CURRENT_CFG_SHA" && "$CURRENT_CFG_SHA" == "$NEW_CFG_SHA" ]]; then
  if [[ "$SKIP_SYSTEMD" == "true" ]] || systemctl is-active --quiet vps-updater.service 2>/dev/null; then
    ALREADY_CURRENT=true
  fi
fi

if [[ "$ALREADY_CURRENT" == "true" ]]; then
  echo "  Local updater is already current (SHA-256: ${CURRENT_BIN_SHA:0:16}...) and daemon is active."
  exit 0
fi

# ── 8. Install or upgrade updater using install-updater.sh ──────────────────
INSTALL_UPDATER_SCRIPT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  cand="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-updater.sh"
  if [[ -f "$cand" ]]; then INSTALL_UPDATER_SCRIPT="$cand"; fi
fi
if [[ -z "$INSTALL_UPDATER_SCRIPT" && -f "./scripts/install/install-updater.sh" ]]; then
  INSTALL_UPDATER_SCRIPT="$(pwd)/scripts/install/install-updater.sh"
fi
if [[ -z "$INSTALL_UPDATER_SCRIPT" && -f "./install-updater.sh" ]]; then
  INSTALL_UPDATER_SCRIPT="$(pwd)/install-updater.sh"
fi
if [[ -z "$INSTALL_UPDATER_SCRIPT" && -f "/tmp/install-updater.sh" ]]; then
  INSTALL_UPDATER_SCRIPT="/tmp/install-updater.sh"
fi

if [[ -n "$INSTALL_UPDATER_SCRIPT" && -f "$INSTALL_UPDATER_SCRIPT" ]]; then
  ARGS=(--upgrade --binary "$TMP_UPDATER" --config "$CONFIG_TMP")
  if [[ "$DRY_RUN" == "true" ]]; then ARGS+=(--dry-run); fi
  echo "  Running install-updater.sh to update local updater..."
  bash "$INSTALL_UPDATER_SCRIPT" "${ARGS[@]}"
else
  # Fallback inline updater installation when install-updater.sh is not staged
  echo "  Installing updater binary and configuration directly..."
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would install ${TMP_UPDATER} -> ${UPDATER_DEST} and ${CONFIG_TMP} -> ${UPDATER_CONFIG}"
  else
    mkdir -p "$(dirname "$UPDATER_DEST")" "$(dirname "$UPDATER_CONFIG")" "$UPDATER_STATE_DIR"
    cp -f "$TMP_UPDATER" "${UPDATER_DEST}.tmp.$$"
    chown root:root "${UPDATER_DEST}.tmp.$$"
    chmod 0755 "${UPDATER_DEST}.tmp.$$"
    mv -f "${UPDATER_DEST}.tmp.$$" "$UPDATER_DEST"

    cp -f "$CONFIG_TMP" "${UPDATER_CONFIG}.tmp.$$"
    chown root:vps-updater "${UPDATER_CONFIG}.tmp.$$" 2>/dev/null || chown root:root "${UPDATER_CONFIG}.tmp.$$"
    chmod 0640 "${UPDATER_CONFIG}.tmp.$$"
    mv -f "${UPDATER_CONFIG}.tmp.$$" "$UPDATER_CONFIG"

    if [[ "$SKIP_SYSTEMD" != "true" ]] && systemctl is-enabled vps-updater.service &>/dev/null; then
      if ! systemctl restart vps-updater.service; then
        echo "Warning: Failed to restart vps-updater.service" >&2
        PREPARE_STATUS="warning"
      elif ! systemctl is-active --quiet vps-updater.service; then
        echo "Warning: vps-updater.service is not active after restart" >&2
        PREPARE_STATUS="warning"
      else
        echo "  Restarted and verified vps-updater.service."
      fi
    fi
  fi
fi

if [[ "$PREPARE_STATUS" != "ok" ]]; then
  echo "Warning: Local updater preparation completed with warnings." >&2
fi

echo "Local updater preparation complete."
