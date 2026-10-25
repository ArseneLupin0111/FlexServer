#!/usr/bin/env bash
#
# install.sh — One-command VPS Manager installer.
#
# Installs the Docker app (web + API) and optionally the host systemd agent
# on a Linux amd64 server. Also installs flexserverctl
# (scripts/install/flexserverctl.py) to /usr/local/bin/flexserverctl when
# present (requires python3).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install/install.sh | sudo bash
#   sudo ./scripts/install/install.sh [options]
#
# Options:
#   --help                   Show this help.
#   --dry-run                Print what would be done without making changes.
#   --app-dir <path>         Application data directory (default: /opt/vps-manager).
#   --app-port <port>        Web UI port (default: 38280).
#   --api-port <port>        Internal API port (default: 38281).
#   --api-image <image>      API Docker image (default: ghcr.io/sondoan17/vps-manager-nodejs-api:latest).
#   --web-image <image>      Web Docker image (default: ghcr.io/sondoan17/vps-manager-nodejs-web:latest).
#   --backend-url <url>      Backend URL for the host agent (default: http://127.0.0.1:<app-port>).
#   --allow-insecure-backend-url Allow http backend URL to non-loopback addresses.
#   --dashboard-password-file <path> Read dashboard password from file (one line).
#   --install-docker         Auto-install Docker via get.docker.com (default: fail with instructions).
#   --skip-pull              Do not pull images before starting (use local images).
#   --skip-agent             Skip installing the host systemd agent.
#   --rotate-agent           Rotate local agent token/config even if one already exists.
#
# The script:
#   1. Checks root, Linux amd64, Docker availability.
#   2. Generates /opt/vps-manager/.env (preserving existing secrets).
#   3. Generates a docker-compose.yml for web + API services.
#   4. Pulls images and starts containers.
#   5. Waits for API health endpoint.
#   6. Sets dashboard password.
#   7. Extracts agent binary from API container.
#   8. Bootstraps agent credential via API container.
#   9. Installs host systemd agent (unless --skip-agent).
#  10. Installs flexserverctl CLI to /usr/local/bin/flexserverctl (requires python3).

set -euo pipefail
umask 077

# ── Early flag scan ───────────────────────────────────────────────────────
# Scanned before the bootstrap below so `--help` and `--dry-run` never touch
# the network or the filesystem: a piped `--dry-run` must make zero writes,
# including the library and CLI downloads. $0 is unreadable in pipe mode, so
# help is printed from the in-body list below instead of re-reading $0.
#
# Scans without mutating positional parameters: a while/shift loop would
# consume the argument list before the main option parser ever sees it.
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --help)
      echo "Usage: sudo $0 [options]"
      echo ""
      echo "Options:"
      echo "  --enable-ai               Install and enable isolated AI worker subsystem (default: off)."
      echo "                            Full AI options are listed in the script header of"
      echo "                            scripts/install/install-local-agent.sh."
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

INSTALLER_LIB_PATH=""
if [[ -f "./installer-lib.sh" ]]; then
  INSTALLER_LIB_PATH="$(pwd)/installer-lib.sh"
elif [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  INSTALLER_LIB_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/installer-lib.sh"
fi
if [[ ! -f "$INSTALLER_LIB_PATH" ]]; then
  INSTALLER_LIB_PATH=""
fi

INSTALLER_DIR=""
if [[ -n "$INSTALLER_LIB_PATH" ]]; then
  INSTALLER_DIR="$(dirname "$INSTALLER_LIB_PATH")"
fi

# The library is sourced only from a real sibling file. Downloading it is a
# write (mktemp + curl) plus a network fetch, which a piped `--dry-run` must
# not perform, so that path is skipped and the remaining behaviour is
# simulated from the script's own logic.
if [[ -n "$INSTALLER_LIB_PATH" ]]; then
  # shellcheck source=scripts/install/installer-lib.sh
  source "$INSTALLER_LIB_PATH"
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would fetch installer-lib.sh from the pinned repository."
  echo "[DRY-RUN] Would fetch flexserverctl.py, syntax-check it, then install it to /usr/local/bin/flexserverctl."
  echo "[DRY-RUN] Zero writes and zero network changes would be made."
  exit 0
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

# ── Defaults ──────────────────────────────────────────────────────────────

APP_DIR="/opt/vps-manager"
APP_PORT=38280
API_PORT=38281
API_IMAGE="ghcr.io/sondoan17/vps-manager-nodejs-api:latest"
WEB_IMAGE="ghcr.io/sondoan17/vps-manager-nodejs-web:latest"
BACKEND_URL=""
ALLOW_INSECURE_BACKEND_URL=false
DASHBOARD_PASSWORD_FILE=""
INSTALL_DOCKER=false
SKIP_PULL=false
SKIP_AGENT=false
ROTATE_AGENT=false
GENERATED_PASSWORD=""
AGENT_SERVICE_NAME="vps-manager-agent"
AGENT_CONFIG_FILE="/etc/vps-manager-agent/config.json"
ENABLE_DOCKER_METRICS_ACCESS=false
FLEXSERVERCTL_DEST="/usr/local/bin/flexserverctl"

random_hex() {
  local bytes="$1"
  if command -v openssl &>/dev/null; then
    openssl rand -hex "$bytes"
  else
    od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
  fi
}

# ── Arg parsing ───────────────────────────────────────────────────────────
ENABLE_LOCAL_TERMINAL=false
ENABLE_AI=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      echo "Usage: sudo $0 [options]"
      echo ""
      echo "Options:"
      echo "  --help                    Show this help."
      echo "  --dry-run                 Print what would be done without making changes."
      echo "  --app-dir <path>          Application data directory (default: ${APP_DIR})."
      echo "  --app-port <port>         Web UI port (default: ${APP_PORT})."
      echo "  --api-port <port>         Internal API port (default: ${API_PORT})."
      echo "  --api-image <image>       API Docker image (default: ${API_IMAGE})."
      echo "  --web-image <image>       Web Docker image (default: ${WEB_IMAGE})."
      echo "  --backend-url <url>       Backend URL for host agent."
      echo "  --allow-insecure-backend-url Allow http backend URL to non-loopback addresses."
      echo "  --dashboard-password-file <path> Read password from file."
      echo "  --install-docker          Auto-install Docker via get.docker.com."
      echo "  --skip-pull               Do not pull images before starting (use local images)."
      echo "  --skip-agent              Skip host systemd agent installation."
      echo "  --rotate-agent            Rotate local agent token/config."
      echo "  --enable-docker-metrics-access"
      echo "                            Add docker group to the systemd agent service unit"
      echo "                            (SupplementaryGroups). Docker group access is"
      echo "                            root-equivalent; only needed if Docker metrics are"
      echo "                            enabled via the dashboard."
      echo "  --enable-local-terminal   Enable local host web terminal daemon (host-pty) and compose mount."
      echo "  --enable-ai               Install and enable isolated AI worker subsystem (default: off)."
      exit 0 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    --api-image) API_IMAGE="$2"; shift 2 ;;
    --web-image) WEB_IMAGE="$2"; shift 2 ;;
    --backend-url) BACKEND_URL="$2"; shift 2 ;;
    --allow-insecure-backend-url) ALLOW_INSECURE_BACKEND_URL=true; shift ;;
    --dashboard-password-file) DASHBOARD_PASSWORD_FILE="$2"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=true; shift ;;
    --skip-pull) SKIP_PULL=true; shift ;;
    --skip-agent) SKIP_AGENT=true; shift ;;
    --rotate-agent) ROTATE_AGENT=true; shift ;;
    --enable-docker-metrics-access) ENABLE_DOCKER_METRICS_ACCESS=true; shift ;;
    --enable-local-terminal) ENABLE_LOCAL_TERMINAL=true; shift ;;
    --enable-ai|--install-ai) ENABLE_AI=true; shift ;;
    *)
      echo "Error: Unknown argument: $1"
      echo "Usage: sudo $0 [options]"
      exit 1 ;;
  esac
done

# ── Prerequisites ─────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (sudo)." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$(uname -s)" != "Linux" ]] || [[ "$ARCH" != "x86_64" ]]; then
  echo "Error: Only Linux amd64 is supported (detected: $(uname -s) ${ARCH})." >&2
  exit 1
fi

# Python3 prerequisite plus CLI source readiness — both checked before any
# mutation (directory creation, Docker work, or image pulls) so a missing
# interpreter, an absent --cli-source, or a broken/truncated file can never
# leave a half-configured host behind. The final copy to /usr/local/bin still
# happens at the end of the install.
if [[ "$DRY_RUN" == "false" ]]; then
  if ! require_python3_for_cli; then
    exit 1
  fi
  if ! prepare_flexserverctl_source; then
    exit 1
  fi
fi

# Docker check
if ! command -v docker &>/dev/null; then
  if [[ "$INSTALL_DOCKER" == "true" ]]; then
    echo "[Setup] Installing Docker via get.docker.com..."
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run: curl -fsSL https://get.docker.com | sh"
    else
      curl -fsSL https://get.docker.com | sh
      systemctl enable --now docker
      echo "  Docker installed."
    fi
  else
    echo "Error: Docker is not installed." >&2
    echo "  Install Docker first: curl -fsSL https://get.docker.com | sh" >&2
    echo "  Or run with --install-docker to auto-install." >&2
    exit 1
  fi
fi

if ! docker compose version &>/dev/null; then
  echo "Error: docker compose plugin is required." >&2
  echo "  Install it: sudo apt install docker-compose-plugin  (or equivalent)" >&2
  exit 1
fi

# ── Setup directories ─────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would create directory: ${APP_DIR} (0700)"
else
  mkdir -p "${APP_DIR}"
  chmod 0700 "${APP_DIR}"
fi

DATA_DIR="${APP_DIR}/data"
PRIVATE_DIR="${APP_DIR}/private"
ENV_FILE="${APP_DIR}/.env"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
ADMIN_CREDENTIAL_FILE="${DATA_DIR}/admin-credential.json"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would create directories: ${DATA_DIR} ${PRIVATE_DIR}"
else
  mkdir -p "$DATA_DIR" "$PRIVATE_DIR"
fi

# ── Env file ──────────────────────────────────────────────────────────────

# Preserve existing dashboard session secret if env file exists.
CURRENT_DASHBOARD_SECRET=""
CURRENT_AGENT_PUBLIC_BASE_URL=""
CURRENT_SSH_KEY_ENCRYPTION_KEY_FILE=""
if [[ -f "$ENV_FILE" ]]; then
  CURRENT_DASHBOARD_SECRET=$(grep -E '^DASHBOARD_SESSION_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)
  CURRENT_AGENT_PUBLIC_BASE_URL=$(grep -E '^AGENT_PUBLIC_BASE_URL=' "$ENV_FILE" | cut -d= -f2- || true)
  CURRENT_SSH_KEY_ENCRYPTION_KEY_FILE=$(grep -E '^SSH_KEY_ENCRYPTION_KEY_FILE=' "$ENV_FILE" | cut -d= -f2- || true)
fi

if [[ -n "$CURRENT_SSH_KEY_ENCRYPTION_KEY_FILE" ]]; then
  KEYRING_FILE="$CURRENT_SSH_KEY_ENCRYPTION_KEY_FILE"
  KEYRING_DIR="$(dirname "$KEYRING_FILE")"
else
  KEYRING_DIR="/etc/flexserver"
  KEYRING_FILE="${KEYRING_DIR}/ssh-keyring.json"
fi

if [[ -z "$CURRENT_DASHBOARD_SECRET" ]]; then
  CURRENT_DASHBOARD_SECRET="$(random_hex 32)"
  CURRENT_DASHBOARD_SECRET="${CURRENT_DASHBOARD_SECRET:0:64}"
fi

CURRENT_AI_KEYRING_FILE=""
if [[ -f "$ENV_FILE" ]]; then
  CURRENT_AI_KEYRING_FILE=$(grep -E '^AI_KEYRING_FILE=' "$ENV_FILE" | cut -d= -f2- || true)
fi

if [[ -n "$CURRENT_AI_KEYRING_FILE" ]]; then
  AI_KEYRING_FILE="$CURRENT_AI_KEYRING_FILE"
  AI_KEYRING_DIR="$(dirname "$AI_KEYRING_FILE")"
else
  AI_KEYRING_DIR="$KEYRING_DIR"
  AI_KEYRING_FILE="${AI_KEYRING_DIR}/ai-keyring.json"
fi

# ── URL resolution ────────────────────────────────────────────────────────
#
# Precedence (contract order):
#   1. Explicit --backend-url flag.
#   2. AGENT_PUBLIC_BASE_URL (env var, else existing .env value).
#   3. Loopback default, used only for the local agent bootstrap — never
#      published as a remote-reachable AGENT_PUBLIC_BASE_URL.
#
# BACKEND_URL (what the local agent is told to call) picks the first of
# (1) > (2) > loopback. AGENT_PUBLIC_BASE_URL (canonical remote install URL)
# is written only when steps 1/2 yield a compliant non-loopback URL; an
# explicit valid HTTPS --backend-url replaces a stale .env value.

EFFECTIVE_AGENT_PUBLIC_BASE_URL=""
RESOLVED_BACKEND_URL=""

# Step 1 — explicit --backend-url flag.
if [[ -n "$BACKEND_URL" ]]; then
  # Scheme/format validation happens before any resolution, so an
  # unsupported scheme (e.g. ftp://) cannot fall through into the canonical
  # public URL the runtime would later refuse.
  if ! validate_backend_url "$BACKEND_URL" "$ALLOW_INSECURE_BACKEND_URL"; then
    exit 1
  fi
  RESOLVED_BACKEND_URL="$BACKEND_URL"
  if url_is_remote_publishable "$BACKEND_URL"; then
    # Valid HTTPS: publish it as the canonical remote install URL, replacing
    # any stale configured value.
    EFFECTIVE_AGENT_PUBLIC_BASE_URL="$BACKEND_URL"
  else
    # Plain http, accepted only for a real loopback host (or via the explicit
    # --allow-insecure-backend-url escape hatch). Loopback is fine for the
    # local agent but is never advertised remotely.
    BACKEND_PARSED="$(parse_backend_url "$BACKEND_URL")" || BACKEND_PARSED=""
    BACKEND_HOST="${BACKEND_PARSED##* }"
    if [[ "$BACKEND_PARSED" == http* ]] && is_loopback_host "$BACKEND_HOST"; then
      if [[ -n "${AGENT_PUBLIC_BASE_URL:-}" ]]; then
        EFFECTIVE_AGENT_PUBLIC_BASE_URL="${AGENT_PUBLIC_BASE_URL}"
      elif [[ -n "$CURRENT_AGENT_PUBLIC_BASE_URL" ]]; then
        EFFECTIVE_AGENT_PUBLIC_BASE_URL="$CURRENT_AGENT_PUBLIC_BASE_URL"
      fi
    else
      EFFECTIVE_AGENT_PUBLIC_BASE_URL="$BACKEND_URL"
    fi
  fi
else
  # Step 2 — configured canonical URL (env var beats the existing .env value).
  if [[ -n "${AGENT_PUBLIC_BASE_URL:-}" ]]; then
    if ! validate_backend_url "${AGENT_PUBLIC_BASE_URL}" true; then
      exit 1
    fi
    RESOLVED_BACKEND_URL="${AGENT_PUBLIC_BASE_URL}"
    EFFECTIVE_AGENT_PUBLIC_BASE_URL="${AGENT_PUBLIC_BASE_URL}"
  elif [[ -n "$CURRENT_AGENT_PUBLIC_BASE_URL" ]]; then
    if ! validate_backend_url "$CURRENT_AGENT_PUBLIC_BASE_URL" true; then
      exit 1
    fi
    RESOLVED_BACKEND_URL="$CURRENT_AGENT_PUBLIC_BASE_URL"
    EFFECTIVE_AGENT_PUBLIC_BASE_URL="$CURRENT_AGENT_PUBLIC_BASE_URL"
  fi
fi

# Step 3 — loopback default, used only for the local agent bootstrap.
# (URL validation already happened above, so the loopback default is the only
# remaining case that needs no further checks.)
if [[ -z "$RESOLVED_BACKEND_URL" ]]; then
  RESOLVED_BACKEND_URL="http://127.0.0.1:${APP_PORT}"
fi
BACKEND_URL="$RESOLVED_BACKEND_URL"

# ALLOW_INSECURE_AGENT_HTTP must agree with the persisted public URL scheme:
# resolveAgentBackendUrl() rejects an http:// AGENT_PUBLIC_BASE_URL unless this
# is true, so keep the two consistent instead of hardcoding false.
ALLOW_INSECURE_AGENT_HTTP_VALUE=false
if [[ "$EFFECTIVE_AGENT_PUBLIC_BASE_URL" == http://* ]]; then
  ALLOW_INSECURE_AGENT_HTTP_VALUE=true
fi

ENV_CONTENT=$(
  cat <<ENV
# VPS Manager — generated by install.sh
# Managed values may be rewritten on re-run; data/private directories are preserved.

APP_MODE=local
LOCAL_AGENT_ENABLED=false
STORAGE_DRIVER=json
DATA_DIR=/app/data
PRIVATE_DIR=/app/private

PORT=3000
DASHBOARD_SESSION_SECRET=${CURRENT_DASHBOARD_SECRET}
DASHBOARD_SESSION_TTL_SECONDS=86400
DASHBOARD_COOKIE_SECURE=false
DASHBOARD_COOKIE_SAME_SITE=lax

ENABLE_WEB_TERMINAL=false
ALLOW_PRIVATE_NETWORK_TARGETS=false
ALLOW_INSECURE_AGENT_HTTP=${ALLOW_INSECURE_AGENT_HTTP_VALUE}
AGENT_PUBLIC_BASE_URL=${EFFECTIVE_AGENT_PUBLIC_BASE_URL}

TRUST_PROXY_HOPS=0
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120

METRIC_WINDOW_LIMIT=120
JOB_HISTORY_LIMIT=1000
AUDIT_HISTORY_LIMIT=5000

SSH_HOST_KEY_POLICY=strict
SSH_KEY_ENCRYPTION_KEY_FILE=${KEYRING_FILE}
AI_KEYRING_FILE=${AI_KEYRING_FILE}
APP_AI_ENABLED=true
COMPOSE_KEYRING_FILE=/etc/flexserver/compose-keyring.json
COMPOSE_CLAIM_LEASE_SECONDS=120
COMPOSE_INVENTORY_MAX_BYTES=524288
COMPOSE_PREVIEW_TTL_SECONDS=300
LOCAL_AGENT_ROTATION_HELPER=/usr/local/bin/local-agent-rotation-client
LOCAL_AGENT_ROTATION_SOCKET=/var/run/flexserver/agent-rotation/agent-rotation.sock
ENV
)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would write env file: ${ENV_FILE} (0600)"
  echo "---"
  echo "$ENV_CONTENT" | head -5
  echo "..."
  echo "---"
else
  echo "$ENV_CONTENT" > "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  echo "[Setup] Env file: ${ENV_FILE}"
fi

# ── Compose file ──────────────────────────────────────────────────────────

TERMINAL_VOLUME_LINE=""
TERMINAL_ENV_LINE=""
if [[ "$ENABLE_LOCAL_TERMINAL" == "true" ]]; then
  TERMINAL_VOLUME_LINE="      - /var/run/flexserver:/var/run/flexserver"
  TERMINAL_ENV_LINE="      LOCAL_PTY_SOCKET_PATH: /var/run/flexserver/host-pty/host-pty.sock"
fi

COMPOSE_CONTENT=$(
  cat <<COMPOSE
services:
  api:
    image: ${API_IMAGE}
    ports:
      - "127.0.0.1:${API_PORT}:3000"
    volumes:
      - ./data:/app/data
      - ./private:/app/private
      - ${KEYRING_DIR}:${KEYRING_DIR}:ro
${TERMINAL_VOLUME_LINE}
    env_file: .env
    environment:
      AI_KEYRING_FILE: ${AI_KEYRING_FILE}
${TERMINAL_ENV_LINE}
      SSH_KEY_ENCRYPTION_KEY_FILE: ${KEYRING_FILE}
      LOCAL_AGENT_ROTATION_HELPER: /usr/local/bin/local-agent-rotation-client
      LOCAL_AGENT_ROTATION_SOCKET: /var/run/flexserver/agent-rotation/agent-rotation.sock
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    restart: unless-stopped

  web:
    image: ${WEB_IMAGE}
    ports:
      - "${APP_PORT}:80"
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
    restart: unless-stopped
COMPOSE
)

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would write compose file: ${COMPOSE_FILE}"
  echo "---"
  echo "$COMPOSE_CONTENT"
  echo "---"
else
  echo "$COMPOSE_CONTENT" > "$COMPOSE_FILE"
  echo "[Setup] Compose file: ${COMPOSE_FILE}"
fi

# ── Pull ──────────────────────────────────────────────────────────────────

if [[ "$SKIP_PULL" == "true" ]]; then
  echo "[Docker] Skipping image pull (--skip-pull)."
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would run: docker compose -f ${COMPOSE_FILE} pull"
else
  echo "[Docker] Pulling images..."
  docker compose -f "$COMPOSE_FILE" pull
  echo "[Docker] Images pulled."
fi

# ── Bind mount ownership ──────────────────────────────────────────────────

# The API image runs as a non-root user. Bind-mounted data/private directories
# must be owned by that container UID/GID or JSON storage and credentials cannot
# be written on first boot.
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would set ${DATA_DIR} and ${PRIVATE_DIR} ownership to the API container user"
  echo "[DRY-RUN] Would prepare ${KEYRING_DIR} (chmod 0750) and initialize/migrate ${KEYRING_FILE} plus AI keyring ${AI_KEYRING_FILE}"
else
  API_UID_GID="$(docker run --rm --entrypoint sh "$API_IMAGE" -lc 'printf "%s:%s" "$(id -u)" "$(id -g)"')"
  if [[ ! "$API_UID_GID" =~ ^[0-9]+:[0-9]+$ ]]; then
    echo "Error: Could not determine API image runtime UID/GID for ${API_IMAGE}." >&2
    exit 1
  fi
  chown -R "$API_UID_GID" "$DATA_DIR" "$PRIVATE_DIR"
  chmod 0700 "$DATA_DIR" "$PRIVATE_DIR"
  echo "[Setup] Data directories owned by API container user (${API_UID_GID})."

  # Ensure external SSH keyring directory exists outside checkout and data roots
  mkdir -p "$KEYRING_DIR"
  chown "$API_UID_GID" "$KEYRING_DIR"
  chmod 0750 "$KEYRING_DIR"

  if test -f "$KEYRING_FILE"; then
    echo "[Setup] Preserving existing SSH keyring at ${KEYRING_FILE}."
    chown "$API_UID_GID" "$KEYRING_FILE"
    chmod 0600 "$KEYRING_FILE"
  else
    echo "[Setup] Initializing SSH key encryption keyring..."
    docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
      -v "${KEYRING_DIR}:${KEYRING_DIR}:rw" \
      api node dist/scripts/manage-ssh-keys.js init --path "$KEYRING_FILE"
    chown "$API_UID_GID" "$KEYRING_FILE"
    chmod 0600 "$KEYRING_FILE"
  fi
  # Migrate any managed plaintext keys to envelope encryption
  echo "[Setup] Migrating managed SSH keys to envelope encryption..."
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
    -v "${KEYRING_DIR}:${KEYRING_DIR}:ro" \
    api node dist/scripts/manage-ssh-keys.js migrate --path "$KEYRING_FILE"

  if [[ "$AI_KEYRING_DIR" != "$KEYRING_DIR" ]]; then
    mkdir -p "$AI_KEYRING_DIR"
    chown "$API_UID_GID" "$AI_KEYRING_DIR"
    chmod 0750 "$AI_KEYRING_DIR"
  fi

  if test -f "$AI_KEYRING_FILE"; then
    echo "[Setup] Preserving existing AI keyring at ${AI_KEYRING_FILE}."
    chown "$API_UID_GID" "$AI_KEYRING_FILE"
    chmod 0600 "$AI_KEYRING_FILE"
  else
    echo "[Setup] Initializing AI key encryption keyring..."
    # Stopping API first because the CLI guards JSON storage with a writer lock.
    docker compose -f "$COMPOSE_FILE" rm -sf api >/dev/null 2>&1 || true
    docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
      -v "${AI_KEYRING_DIR}:/run/flexserver-ai-admin:rw" \
      -e AI_KEYRING_FILE="/run/flexserver-ai-admin/$(basename "$AI_KEYRING_FILE")" \
      api node dist/scripts/manage-ai-keys.js init
    chown "$API_UID_GID" "$AI_KEYRING_FILE"
    chmod 0600 "$AI_KEYRING_FILE"
  fi
fi

# ── Start ─────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would run: docker compose -f ${COMPOSE_FILE} up -d"
else
  echo "[Docker] Starting containers..."
  docker compose -f "$COMPOSE_FILE" up -d
  echo "[Docker] Containers started."
fi

# ── Wait for health ───────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would wait for API health at http://127.0.0.1:${API_PORT}/api/health"
else
  echo "[Setup] Waiting for API to become healthy..."
  API_HEALTH_URL="http://127.0.0.1:${API_PORT}/api/health"
  RETRIES=30
  DELAY=3
  for i in $(seq 1 "$RETRIES"); do
    if curl -sf "$API_HEALTH_URL" &>/dev/null; then
      echo "  API is healthy after ~$((i * DELAY))s."
      break
    fi
    if [[ "$i" == "$RETRIES" ]]; then
      echo "Error: API did not become healthy after ${RETRIES} attempts." >&2
      echo "  Check logs: docker compose -f ${COMPOSE_FILE} logs api" >&2
      exit 1
    fi
    sleep "$DELAY"
  done
fi

# ── Dashboard password ────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would set dashboard password"
else
  echo "[Setup] Setting dashboard password..."

  PASSWORD=""
  SKIP_PASSWORD_SET=false
  PASSWORD_ALREADY_CONFIGURED=false
  if [[ -f "$ADMIN_CREDENTIAL_FILE" ]]; then
    PASSWORD_ALREADY_CONFIGURED=true
  fi

  if [[ -n "$DASHBOARD_PASSWORD_FILE" ]]; then
    if [[ -f "$DASHBOARD_PASSWORD_FILE" ]]; then
      PASSWORD="$(head -1 "$DASHBOARD_PASSWORD_FILE" | tr -d '\n\r')"
    else
      echo "Warning: Password file not found: ${DASHBOARD_PASSWORD_FILE}" >&2
    fi
  fi

  if [[ -z "$PASSWORD" ]]; then
    if [[ -t 0 ]]; then
      # TTY available — prompt user
      if [[ "$PASSWORD_ALREADY_CONFIGURED" == "true" ]]; then
        echo -n "Enter dashboard password (empty keeps existing): " >&2
      else
        echo -n "Enter dashboard password (empty auto-generates): " >&2
      fi
      read -rs PASSWORD_INPUT
      echo >&2
      PASSWORD="${PASSWORD_INPUT}"
    fi
    if [[ -z "$PASSWORD" ]]; then
      if [[ "$PASSWORD_ALREADY_CONFIGURED" == "true" ]]; then
        SKIP_PASSWORD_SET=true
      else
        # Auto-generate on first install when no password was provided.
        PASSWORD="$(random_hex 18)"
        GENERATED_PASSWORD="$PASSWORD"
      fi
    fi
  fi

  if [[ "$SKIP_PASSWORD_SET" == "true" ]]; then
    echo "  Existing dashboard password detected; keeping it."
  elif [[ -n "$PASSWORD" ]]; then
    printf '%s\n' "$PASSWORD" | docker compose -f "$COMPOSE_FILE" exec -T api node dist/scripts/set-dashboard-password.js --stdin --skip-if-same
    echo "  Dashboard password set."
  else
    echo "Warning: No dashboard password provided. Set via:" >&2
    echo "  echo '<password>' | docker compose -f ${COMPOSE_FILE} exec -T api node dist/scripts/set-dashboard-password.js --stdin" >&2
  fi
fi

# ── Agent installation ────────────────────────────────────────────────────

if [[ "$SKIP_AGENT" == "true" ]]; then
  echo "[Agent] Skipping (--skip-agent)."
else
  echo "[Agent] Setting up host systemd agent..."

  # Determine the container running the API service
  API_CONTAINER=""
  if [[ "$DRY_RUN" == "false" ]]; then
    API_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null | head -1)"
    if [[ -z "$API_CONTAINER" ]]; then
      echo "Error: Could not find running API container." >&2
      echo "  Falling back to 'api' service name..." >&2
      API_CONTAINER="$(docker ps --filter name=vps-manager-api --format '{{.ID}}' | head -1)"
    fi
  fi

  # Extract agent binary from API container
  AGENT_BIN_TMP=""
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would extract agent binary from API container..."
  else
    AGENT_BIN_TMP="$(mktemp)"
    INSTALLER_TMP_FILES+=("$AGENT_BIN_TMP")
    if ! docker cp "${API_CONTAINER}:/app/agent/vps-agent-linux-amd64" "$AGENT_BIN_TMP" &>/dev/null; then
      echo "Error: Failed to extract agent binary from API container." >&2
      echo "  Ensure API image has the agent at /app/agent/vps-agent-linux-amd64" >&2
      echo "  Skipping agent installation." >&2
      AGENT_BIN_TMP=""
    else
      chmod 0755 "$AGENT_BIN_TMP"
      echo "  Extracted agent binary."
    fi
  fi

  # Prepare local agent updater using shared helper
  PREPARE_UPDATER_SCRIPT=""
  if [[ -f "$(dirname "$0")/prepare-agent-updater.sh" ]]; then
    PREPARE_UPDATER_SCRIPT="$(dirname "$0")/prepare-agent-updater.sh"
  elif [[ -f "$(dirname "$0")/scripts/install/prepare-agent-updater.sh" ]]; then
    PREPARE_UPDATER_SCRIPT="$(dirname "$0")/scripts/install/prepare-agent-updater.sh"
  elif [[ -f "./scripts/install/prepare-agent-updater.sh" ]]; then
    PREPARE_UPDATER_SCRIPT="./scripts/install/prepare-agent-updater.sh"
  fi

  if [[ -n "$PREPARE_UPDATER_SCRIPT" ]]; then
    echo "  Running shared prepare-agent-updater helper..."
    PREP_ARGS=(--compose-file "$COMPOSE_FILE" --agent-state-dir "/var/lib/vps-manager-agent")
    if [[ -n "$API_CONTAINER" ]]; then PREP_ARGS+=(--container "$API_CONTAINER"); fi
    if [[ -n "$BACKEND_URL" ]]; then PREP_ARGS+=(--backend-url "$BACKEND_URL"); fi
    if [[ "$DRY_RUN" == "true" ]]; then PREP_ARGS+=(--dry-run); fi
    if ! bash "$PREPARE_UPDATER_SCRIPT" "${PREP_ARGS[@]}"; then
      echo "Warning: Shared local updater preparation failed; continuing agent install." >&2
    fi
  fi
  UPDATER_BIN_TMP=""

  # Extract bundled host-pty binary from API container
  HOST_PTY_BIN_TMP=""
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would extract host-pty binary from API container..."
  else
    HOST_PTY_BIN_TMP="$(mktemp)"
    INSTALLER_TMP_FILES+=("$HOST_PTY_BIN_TMP")
    if ! docker cp "${API_CONTAINER}:/app/agent/host-pty-linux-amd64" "$HOST_PTY_BIN_TMP" &>/dev/null; then
      echo "Warning: Failed to extract host-pty binary from API container (/app/agent/host-pty-linux-amd64)." >&2
      rm -f "$HOST_PTY_BIN_TMP"
      HOST_PTY_BIN_TMP=""
    else
      chmod 0755 "$HOST_PTY_BIN_TMP"
      echo "  Extracted bundled host-pty binary."
    fi
  fi
  ROTATOR_BIN_TMP=""
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would extract bundled local-agent-rotator binary and pass --rotator-binary..."
  else
    ROTATOR_BIN_TMP="$(mktemp)"
    INSTALLER_TMP_FILES+=("$ROTATOR_BIN_TMP")
    if ! docker cp "${API_CONTAINER}:/app/agent/local-agent-rotator-linux-amd64" "$ROTATOR_BIN_TMP" &>/dev/null; then
      echo "Error: Failed to extract bundled local-agent-rotator; cannot migrate host socket services safely." >&2
      exit 1
    fi
    chmod 0755 "$ROTATOR_BIN_TMP"
  fi
  # Bootstrap agent credential and generate config using --config-only
  AGENT_CONFIG_TMP=""
  AGENT_CONFIG_CREATED=false
  if [[ -n "$AGENT_BIN_TMP" ]] || [[ "$DRY_RUN" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would run bootstrap inside API container..."
      echo "  [DRY-RUN] Would capture config to temp file."
    elif [[ -f "$AGENT_CONFIG_FILE" && "$ROTATE_AGENT" != "true" ]]; then
      AGENT_CONFIG_TMP="$AGENT_CONFIG_FILE"
      echo "  Reusing existing agent config: ${AGENT_CONFIG_FILE}"
    else
      AGENT_CONFIG_TMP="$(mktemp)"
      INSTALLER_TMP_FILES+=("$AGENT_CONFIG_TMP")
      AGENT_CONFIG_CREATED=true
      BOOTSTRAP_ARGS=(node dist/scripts/bootstrap-local-agent.js \
        --backend-url "$BACKEND_URL" \
        --config-only \
        --rotate)
      if ! docker compose -f "$COMPOSE_FILE" exec -T api "${BOOTSTRAP_ARGS[@]}" > "$AGENT_CONFIG_TMP" 2>/dev/null; then
        echo "Error: Bootstrap failed." >&2
        echo "  Check logs: docker compose -f ${COMPOSE_FILE} logs api" >&2
        rm -f "$AGENT_BIN_TMP"
        AGENT_BIN_TMP=""
        AGENT_CONFIG_TMP=""
      else
        echo "  Agent credential bootstrapped."
      fi
    fi
  fi

  # Prepare local agent updater using shared preparation helper
  PREPARE_UPDATER_SCRIPT="$(cd "$(dirname "$0")" && pwd)/prepare-agent-updater.sh"
  if [[ ! -f "$PREPARE_UPDATER_SCRIPT" ]]; then
    for cand in "${INSTALLER_DIR}/prepare-agent-updater.sh" "./scripts/install/prepare-agent-updater.sh" "/tmp/prepare-agent-updater.sh"; do
      if [[ -f "$cand" ]]; then PREPARE_UPDATER_SCRIPT="$cand"; break; fi
    done
  fi
  if [[ -f "$PREPARE_UPDATER_SCRIPT" ]]; then
    echo "  Running shared host updater preparation..."
    PREP_ARGS=(--compose-file "$COMPOSE_FILE" --backend-url "$BACKEND_URL")
    if [[ "$DRY_RUN" == "true" ]]; then PREP_ARGS+=(--dry-run); fi
    if ! bash "$PREPARE_UPDATER_SCRIPT" "${PREP_ARGS[@]}"; then
      echo "Warning: Shared host updater preparation encountered an issue; continuing agent installation." >&2
    fi
  fi
  AI_EXECUTOR_TMP=""
  AI_HELPER_TMP=""
  AI_ROOTFS_TAR_TMP=""
  AI_ROOTFS_MANIFEST_TMP=""
  AI_PROFILES_TMP=""
  if [[ "$ENABLE_AI" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "  [DRY-RUN] Would extract AI executor, helper, rootfs, manifest, profiles from API container..."
    else
      AI_EXECUTOR_TMP="$(mktemp)"
      INSTALLER_TMP_FILES+=("$AI_EXECUTOR_TMP")
      if docker cp "${API_CONTAINER}:/app/agent/ai/ai-executor-linux-amd64" "$AI_EXECUTOR_TMP" &>/dev/null; then
        chmod 0755 "$AI_EXECUTOR_TMP"
      else
        echo "Warning: Failed to extract /app/agent/ai/ai-executor-linux-amd64 from container" >&2
      fi

      AI_HELPER_TMP="$(mktemp)"
      INSTALLER_TMP_FILES+=("$AI_HELPER_TMP")
      if docker cp "${API_CONTAINER}:/app/agent/ai/ai-host-helper-linux-amd64" "$AI_HELPER_TMP" &>/dev/null; then
        chmod 0755 "$AI_HELPER_TMP"
      else
        echo "Warning: Failed to extract /app/agent/ai/ai-host-helper-linux-amd64 from container" >&2
      fi

      AI_ROOTFS_TAR_TMP="$(mktemp)"
      INSTALLER_TMP_FILES+=("$AI_ROOTFS_TAR_TMP")
      if ! docker cp "${API_CONTAINER}:/app/agent/ai/ai-rootfs-linux-amd64.tar.gz" "$AI_ROOTFS_TAR_TMP" &>/dev/null; then
        echo "Warning: Failed to extract /app/agent/ai/ai-rootfs-linux-amd64.tar.gz from container" >&2
      fi

      AI_ROOTFS_MANIFEST_TMP="$(mktemp)"
      INSTALLER_TMP_FILES+=("$AI_ROOTFS_MANIFEST_TMP")
      if ! docker cp "${API_CONTAINER}:/app/agent/ai/ai-rootfs-linux-amd64.manifest.json" "$AI_ROOTFS_MANIFEST_TMP" &>/dev/null; then
        echo "Warning: Failed to extract /app/agent/ai/ai-rootfs-linux-amd64.manifest.json from container" >&2
      fi

      AI_PROFILES_TMP="$(mktemp -d)"
      INSTALLER_TMP_FILES+=("$AI_PROFILES_TMP")
      docker cp "${API_CONTAINER}:/app/agent/ai/profiles/." "$AI_PROFILES_TMP/" 2>/dev/null || true
    fi
  fi
  # Run install-local-agent.sh
  if { [[ -n "$AGENT_BIN_TMP" ]] && [[ -n "$AGENT_CONFIG_TMP" ]]; } || [[ "$DRY_RUN" == "true" ]]; then
    INSTALL_SCRIPT="$(cd "$(dirname "$0")" && pwd)/install-local-agent.sh"
    if [[ ! -f "$INSTALL_SCRIPT" ]]; then
      # Script may not be locally available; try to curl from GitHub
      INSTALL_SCRIPT=""
      if command -v curl &>/dev/null; then
        if [[ "$DRY_RUN" == "true" ]]; then
          echo "  [DRY-RUN] Would download install-local-agent.sh from GitHub"
        else
          INSTALL_SCRIPT="$(mktemp)"
          INSTALLER_TMP_FILES+=("$INSTALL_SCRIPT")
          curl -fsSL -o "$INSTALL_SCRIPT" "https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install/install-local-agent.sh"
          chmod 0755 "$INSTALL_SCRIPT"
        fi
      fi
    fi

    if [[ -n "$INSTALL_SCRIPT" ]] || [[ "$DRY_RUN" == "true" ]]; then
      AGENT_INSTALL_ARGS=(--binary "$AGENT_BIN_TMP" --config "$AGENT_CONFIG_TMP" --service-name "$AGENT_SERVICE_NAME")
      if [[ -n "$ROTATOR_BIN_TMP" ]]; then
        AGENT_INSTALL_ARGS+=(--rotator-binary "$ROTATOR_BIN_TMP")
      fi
      if [[ "$ENABLE_DOCKER_METRICS_ACCESS" == "true" ]]; then
        AGENT_INSTALL_ARGS+=(--enable-docker-metrics-access)
      fi
      if [[ -f /etc/vps-updater/config.json && -x /usr/local/lib/vps-manager-agent/vps-updater ]]; then
        : # Updater already prepared and installed by shared helper
      elif [[ -n "$UPDATER_BIN_TMP" ]] || [[ "$DRY_RUN" == "true" ]]; then
        AGENT_INSTALL_ARGS+=(--upgrade-updater)
        if [[ -n "$UPDATER_BIN_TMP" ]]; then
          AGENT_INSTALL_ARGS+=(--updater-binary "$UPDATER_BIN_TMP")
        fi
      fi
      if [[ -n "$HOST_PTY_BIN_TMP" ]] || [[ "$ENABLE_LOCAL_TERMINAL" == "true" ]]; then
        if [[ -n "$HOST_PTY_BIN_TMP" ]]; then
          AGENT_INSTALL_ARGS+=(--host-pty-binary "$HOST_PTY_BIN_TMP")
        else
          AGENT_INSTALL_ARGS+=(--install-host-pty)
        fi
        if [[ -n "${API_UID_GID:-}" ]]; then
          AGENT_INSTALL_ARGS+=(--api-uid-gid "$API_UID_GID")
        fi
      fi
      if [[ "$ENABLE_AI" == "true" ]]; then
        AGENT_INSTALL_ARGS+=(--install-ai)
        if [[ -n "$AI_EXECUTOR_TMP" ]]; then
          AGENT_INSTALL_ARGS+=(--ai-executor-binary "$AI_EXECUTOR_TMP")
        fi
        if [[ -n "$AI_HELPER_TMP" ]]; then
          AGENT_INSTALL_ARGS+=(--ai-host-helper-binary "$AI_HELPER_TMP")
        fi
        if [[ -n "$AI_ROOTFS_TAR_TMP" ]]; then
          AGENT_INSTALL_ARGS+=(--ai-rootfs-tar "$AI_ROOTFS_TAR_TMP")
        fi
        if [[ -n "$AI_ROOTFS_MANIFEST_TMP" ]]; then
          AGENT_INSTALL_ARGS+=(--ai-rootfs-manifest "$AI_ROOTFS_MANIFEST_TMP")
        fi
        if [[ -n "$AI_PROFILES_TMP" ]]; then
          AGENT_INSTALL_ARGS+=(--ai-profiles-dir "$AI_PROFILES_TMP")
        fi
      fi
      if [[ "$DRY_RUN" == "true" ]]; then
        echo "  [DRY-RUN] Would run: ${INSTALL_SCRIPT} ${AGENT_INSTALL_ARGS[*]}"
        echo "  [DRY-RUN] Would clean up temp files."
      else
        bash "$INSTALL_SCRIPT" "${AGENT_INSTALL_ARGS[@]}"
        # Legacy RuntimeDirectory cleanup may replace the mounted parent inode.
        docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api
        if [[ "$AGENT_CONFIG_CREATED" == "true" ]]; then
          TOKEN_LINE="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AGENT_CONFIG_TMP" | head -1)"
          KEEP_CREDENTIAL_ID="${TOKEN_LINE#vma_}"
          KEEP_CREDENTIAL_ID="${KEEP_CREDENTIAL_ID%_*}"
          if [[ -n "$KEEP_CREDENTIAL_ID" && "$KEEP_CREDENTIAL_ID" != "$TOKEN_LINE" ]]; then
            if docker compose -f "$COMPOSE_FILE" exec -T api node dist/scripts/revoke-agent-credentials.js \
              --vps-id vps_local_host \
              --keep-credential-id "$KEEP_CREDENTIAL_ID" >/dev/null 2>&1; then
              echo "  Old local-agent credentials revoked."
            else
              echo "Warning: Could not revoke old local-agent credentials automatically." >&2
            fi
          else
            echo "Warning: Could not parse credential id from generated agent config; old credentials were not revoked." >&2
          fi
        fi
        echo "  Host agent installed."
      fi
    else
      echo "Warning: install-local-agent.sh not found. Skipping agent installation." >&2
      echo "  To install manually:" >&2
      echo "    curl -fsSL https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install/install-local-agent.sh | sudo bash -s -- --binary <binary> --config <config>" >&2
    fi
  else
    echo "Warning: Agent binary or config could not be obtained. Skipping agent installation." >&2
  fi
fi

# ── flexserverctl CLI installation ─────────────────────────────────────────

# The final copy happens here, at completion. Source fetch and the python3
# prerequisite are checked earlier (before Docker work) so a pipe-mode
# download failure cannot leave a half-configured host behind.

echo "[flexserverctl] Installing CLI..."
if [[ "$DRY_RUN" == "true" ]]; then
  if [[ -n "${FLEXSERVERCTL_SRC:-}" ]] || resolve_flexserverctl_source &>/dev/null; then
    echo "  [DRY-RUN] Would install $(resolve_flexserverctl_source) -> ${FLEXSERVERCTL_DEST} (root:root 0755)"
  else
    echo "  [DRY-RUN] Would download flexserverctl.py, then install it to ${FLEXSERVERCTL_DEST} (root:root 0755)"
  fi
else
  install_flexserverctl "$FLEXSERVERCTL_DEST" "${FLEXSERVERCTL_SRC:-}"
fi

# ── Summary ────────────────────────────────────────────────────────────────

DASHBOARD_URL="http://<your-server-ip>:${APP_PORT}"
if [[ -n "$GENERATED_PASSWORD" ]]; then
  echo ""
  echo "============================================"
  echo "  VPS Manager installed successfully!"
  echo "  Dashboard: ${DASHBOARD_URL}"
  echo "  Username:  admin"
  echo "  Password:  ${GENERATED_PASSWORD}"
  echo "============================================"
  echo ""
  echo "Save this password now. It will not be shown again."
else
  echo ""
  echo "============================================"
  echo "  VPS Manager installed successfully!"
  echo "  Dashboard: ${DASHBOARD_URL}"
  echo "============================================"
  echo ""
fi

echo "Manage:    docker compose -f ${COMPOSE_FILE} ps"
echo "Logs:      docker compose -f ${COMPOSE_FILE} logs -f"
echo "Stop:      docker compose -f ${COMPOSE_FILE} down"
echo "Upgrade:   docker compose -f ${COMPOSE_FILE} pull && docker compose -f ${COMPOSE_FILE} up -d"
echo "Uninstall agent: sudo systemctl disable --now ${AGENT_SERVICE_NAME}; sudo rm -f /etc/systemd/system/${AGENT_SERVICE_NAME}.service /usr/local/bin/vps-manager-agent; sudo rm -rf /etc/vps-manager-agent"
echo "Uninstall app:   docker compose -f ${COMPOSE_FILE} down    # add -v and rm -rf ${APP_DIR} only if you want to purge data"
echo ""
# Runbook pointer (plan §5): the app never silently upgrades the local
# agent or the updater; both stay operator-driven.
echo "Local agent upgrades are managed via bundled updater protocol."
echo "  Updater status:           sudo /usr/local/lib/vps-manager-agent/vps-updater status -config /etc/vps-updater/config.json"
echo "  Manual updater upgrade:   sudo ./scripts/install/install-updater.sh --upgrade --binary <vps-updater>"
echo "  Runbook:                  docs/local-agent-upgrade-operations.md"
