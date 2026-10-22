#!/usr/bin/env bash
#
# deploy.sh — One-command deployment entry point for VPS Manager.
#
# Runs Docker Compose deployment (build or pull), waits for API health,
# and executes host updater preparation with current privileges or `sudo -n`.
#
# Usage:
#   bash scripts/deploy.sh [options]
#   bash scripts/deploy.sh --pull
#
# Options:
#   --pull                    Pull pre-built images and deploy without building (default: build)
#   --compose-file <path>     docker-compose.yml path
#   --env-file <path>         Environment file to pass to docker compose
#   --health-timeout <sec>    Maximum seconds to wait for API health (default: 90)
#   --health-url <url>        Explicit API health check URL
#   --skip-updater            Skip host updater preparation step
#   --dry-run                 Echo deployment actions without running docker or changing host
#   --help|-h                 Show this help

set -euo pipefail

PULL_MODE=false
COMPOSE_FILE=""
ENV_FILE=""
HEALTH_TIMEOUT=90
HEALTH_URL=""
SKIP_UPDATER=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull)
      PULL_MODE=true; shift ;;
    --compose-file|-f)
      COMPOSE_FILE="$2"; shift 2 ;;
    --env-file)
      ENV_FILE="$2"; shift 2 ;;
    --health-timeout)
      HEALTH_TIMEOUT="$2"; shift 2 ;;
    --health-url)
      HEALTH_URL="$2"; shift 2 ;;
    --skip-updater)
      SKIP_UPDATER=true; shift ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Error: Unknown argument $1" >&2
      exit 1 ;;
  esac
done

# ── 1. Locate Compose file ──────────────────────────────────────────────────
if [[ -z "$COMPOSE_FILE" ]]; then
  for cand in "/opt/vps-manager/docker-compose.yml" "./docker-compose.yml" "../docker-compose.yml"; do
    if [[ -f "$cand" ]]; then
      COMPOSE_FILE="$cand"
      break
    fi
  done
fi

COMPOSE_ARGS=()
if [[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]]; then
  COMPOSE_ARGS+=(-f "$COMPOSE_FILE")
fi
if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  COMPOSE_ARGS+=(--env-file "$ENV_FILE")
fi

# ── 2. Run Docker Compose ───────────────────────────────────────────────────
echo "[Deploy] Starting VPS Manager containers..."
if [[ "$DRY_RUN" == "true" ]]; then
  if [[ "$PULL_MODE" == "true" ]]; then
    echo "[DRY-RUN] Would run: docker compose ${COMPOSE_ARGS[*]} pull"
    echo "[DRY-RUN] Would run: docker compose ${COMPOSE_ARGS[*]} up -d"
  else
    echo "[DRY-RUN] Would run: docker compose ${COMPOSE_ARGS[*]} up -d --build"
  fi
else
  if [[ "$PULL_MODE" == "true" ]]; then
    echo "[Deploy] Pulling prebuilt images..."
    if ! docker compose "${COMPOSE_ARGS[@]}" pull; then
      echo "Error: docker compose pull failed." >&2
      exit 1
    fi
    echo "[Deploy] Starting services..."
    if ! docker compose "${COMPOSE_ARGS[@]}" up -d; then
      echo "Error: docker compose up failed." >&2
      exit 1
    fi
  else
    echo "[Deploy] Building and starting services..."
    if ! docker compose "${COMPOSE_ARGS[@]}" up -d --build; then
      echo "Error: docker compose up --build failed." >&2
      exit 1
    fi
  fi
fi

# ── 3. Wait for API Health ──────────────────────────────────────────────────
check_api_health() {
  local url="$1"
  if [[ -n "$url" ]]; then
    if curl -fsS --max-time 3 "$url" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      return 0
    fi
    return 1
  fi

  # Default: verify just deployed compose api using scoped compose args
  if docker compose "${COMPOSE_ARGS[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    return 0
  fi

  return 1
}

echo "[Deploy] Waiting for API dashboard health check..."
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would wait up to ${HEALTH_TIMEOUT}s for API health."
else
  HEALTHY=false
  WAITED=0
  DELAY=2
  while [[ $WAITED -lt $HEALTH_TIMEOUT ]]; do
    if check_api_health "$HEALTH_URL"; then
      HEALTHY=true
      break
    fi
    sleep "$DELAY"
    WAITED=$((WAITED + DELAY))
  done

  if [[ "$HEALTHY" != "true" ]]; then
    echo "Error: API container failed health check within ${HEALTH_TIMEOUT}s." >&2
    docker compose "${COMPOSE_ARGS[@]}" ps -a || true
    docker compose "${COMPOSE_ARGS[@]}" logs --no-color --tail=50 api || true
    exit 1
  fi
  echo "[Deploy] Dashboard is healthy."
fi

# ── 4. Host Updater Preparation ─────────────────────────────────────────────
if [[ "$SKIP_UPDATER" == "true" ]]; then
  echo "[Deploy] Skipping host updater preparation (--skip-updater specified)."
  exit 0
fi

# Locate prepare-agent-updater.sh
PREPARE_SCRIPT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  cand="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install/prepare-agent-updater.sh"
  if [[ -f "$cand" ]]; then PREPARE_SCRIPT="$cand"; fi
fi
if [[ -z "$PREPARE_SCRIPT" && -f "./scripts/install/prepare-agent-updater.sh" ]]; then
  PREPARE_SCRIPT="$(pwd)/scripts/install/prepare-agent-updater.sh"
fi
if [[ -z "$PREPARE_SCRIPT" && -f "./prepare-agent-updater.sh" ]]; then
  PREPARE_SCRIPT="$(pwd)/prepare-agent-updater.sh"
fi
if [[ -z "$PREPARE_SCRIPT" && -f "/tmp/prepare-agent-updater.sh" ]]; then
  PREPARE_SCRIPT="/tmp/prepare-agent-updater.sh"
fi

if [[ -z "$PREPARE_SCRIPT" || ! -f "$PREPARE_SCRIPT" ]]; then
  echo "Warning: scripts/install/prepare-agent-updater.sh not found; skipping host updater preparation." >&2
  echo "[Deploy] Deployment complete: dashboard is healthy."
  exit 0
fi

# Privilege resolution for host preparation:
# Must use current privileges or sudo -n; lack of host privileges prints explicit warning and exits 0.
SUDO_CMD=()
if [[ "$DRY_RUN" != "true" && "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO_CMD=(sudo -n)
  else
    echo "Warning: Host updater preparation requires root privileges or passwordless sudo." >&2
    echo "  Dashboard deployment is healthy, but the local agent updater was not refreshed." >&2
    echo "  To prepare the local updater manually, run: sudo bash ${PREPARE_SCRIPT}" >&2
    echo "[Deploy] Deployment complete: dashboard is healthy."
    exit 0
  fi
fi

echo "[Deploy] Preparing host agent updater..."
PREPARE_ARGS=()
if [[ -n "$COMPOSE_FILE" ]]; then
  PREPARE_ARGS+=(--compose-file "$COMPOSE_FILE")
fi
if [[ "$DRY_RUN" == "true" ]]; then
  PREPARE_ARGS+=(--dry-run)
fi

if ! "${SUDO_CMD[@]}" bash "$PREPARE_SCRIPT" "${PREPARE_ARGS[@]}"; then
  echo "Warning: Host updater preparation failed. Local updater was not refreshed, but dashboard deployment is healthy." >&2
else
  echo "[Deploy] Host updater preparation completed successfully."
fi

echo "[Deploy] Deployment complete: dashboard is healthy."
exit 0
