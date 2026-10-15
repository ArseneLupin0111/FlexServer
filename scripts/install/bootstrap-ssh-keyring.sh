#!/usr/bin/env bash
#
# bootstrap-ssh-keyring.sh — Idempotent, durable host bootstrapper for SSH key envelope encryption.
#
# Responsibilities:
#   1. Prepares external keyring directory (/etc/flexserver) outside checkout, DATA_DIR, and PRIVATE_DIR.
#   2. Enforces strict POSIX DAC permissions (0750 dir, 0600 file, owned by API container UID:GID).
#   3. Fails closed before generating a new KEK if existing encrypted envelopes are found without a keyring.
#   4. Initializes a new external KEK keyring only when absent and safe to do so.
#   5. Atomically migrates existing plaintext OpenSSH private keys to encrypted envelopes via CLI.
#   6. Ensures .env and docker-compose.yml wire the keyring path and read-only container mount.
#   7. NEVER prints secret key material to stdout/stderr.
#
# Usage:
#   sudo bash scripts/install/bootstrap-ssh-keyring.sh [--deploy-path /opt/vps-manager-nodejs] [--dry-run]
#

set -euo pipefail

DEPLOY_PATH="/opt/vps-manager-nodejs"
EXPLICIT_KEYRING_FILE=""
EXPLICIT_KEYRING_DIR=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-path)
      DEPLOY_PATH="$2"
      shift 2
      ;;
    --keyring-dir)
      EXPLICIT_KEYRING_DIR="$2"
      shift 2
      ;;
    --keyring-file)
      EXPLICIT_KEYRING_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--deploy-path <path>] [--keyring-dir <dir>] [--keyring-file <file>] [--dry-run]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done
if [[ ! -d "$DEPLOY_PATH" ]]; then
  if [[ -f "./docker-compose.yml" ]]; then
    DEPLOY_PATH="$(pwd)"
  else
    echo "Error: Deploy path $DEPLOY_PATH does not exist." >&2
    exit 1
  fi
fi

COMPOSE_FILE="${DEPLOY_PATH}/docker-compose.yml"
ENV_FILE="${DEPLOY_PATH}/.env"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Error: Compose file not found at $COMPOSE_FILE" >&2
  exit 1
fi

# Preserve existing configured custom keyring path from .env before defaulting
ENV_KEYRING=""
if [[ -f "$ENV_FILE" ]]; then
  ENV_KEYRING="$(grep -E '^SSH_KEY_ENCRYPTION_KEY_FILE=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\"'\'' ' || true)"
fi

if [[ -n "$EXPLICIT_KEYRING_FILE" ]]; then
  KEYRING_FILE="$EXPLICIT_KEYRING_FILE"
  KEYRING_DIR="$(dirname "$KEYRING_FILE")"
elif [[ -n "$ENV_KEYRING" ]]; then
  KEYRING_FILE="$ENV_KEYRING"
  KEYRING_DIR="$(dirname "$KEYRING_FILE")"
  echo "[Keyring] Preserving existing configured keyring path from .env: ${KEYRING_FILE}"
elif [[ -n "$EXPLICIT_KEYRING_DIR" ]]; then
  KEYRING_DIR="$EXPLICIT_KEYRING_DIR"
  KEYRING_FILE="${KEYRING_DIR}/ssh-keyring.json"
else
  KEYRING_DIR="/etc/flexserver"
  KEYRING_FILE="${KEYRING_DIR}/ssh-keyring.json"
fi
SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Error: Root privileges or sudo required to manage $KEYRING_DIR." >&2
    exit 1
  fi
fi

file_exists() {
  local target="$1"
  if [[ -n "$SUDO" ]]; then
    $SUDO test -f "$target"
  else
    test -f "$target"
  fi
}
# Detect API container runtime UID and GID dynamically
API_UID="100"
API_GID="101"
if command -v docker >/dev/null 2>&1; then
  # Try reading from running container first
  RUNNING_API_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null | head -n 1 || true)"
  if [[ -n "$RUNNING_API_CONTAINER" ]]; then
    DETECTED_UID_GID="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$RUNNING_API_CONTAINER" 2>/dev/null | grep -E '^API_UID_GID=' || true)"
    if [[ -z "$DETECTED_UID_GID" ]]; then
      DETECTED_UID_GID="$(docker exec "$RUNNING_API_CONTAINER" sh -lc 'printf "%s:%s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
    fi
    if [[ "$DETECTED_UID_GID" =~ ^[0-9]+:[0-9]+$ ]]; then
      API_UID="${DETECTED_UID_GID%%:*}"
      API_GID="${DETECTED_UID_GID##*:}"
    fi
  else
    # Try resolving image from compose file or inspect
    IMAGE_NAME="$(grep -E 'image:' "$COMPOSE_FILE" | grep 'api' | awk '{print $2}' | head -n 1 || true)"
    if [[ -n "$IMAGE_NAME" ]]; then
      DETECTED_UID_GID="$(docker run --rm --entrypoint sh "$IMAGE_NAME" -lc 'printf "%s:%s" "$(id -u)" "$(id -g)"' 2>/dev/null || true)"
      if [[ "$DETECTED_UID_GID" =~ ^[0-9]+:[0-9]+$ ]]; then
        API_UID="${DETECTED_UID_GID%%:*}"
        API_GID="${DETECTED_UID_GID##*:}"
      fi
    fi
  fi
fi

echo "[Keyring] Target keyring directory: ${KEYRING_DIR}"
echo "[Keyring] Target keyring file:      ${KEYRING_FILE}"
echo "[Keyring] API runtime UID:GID:     ${API_UID}:${API_GID}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Target keyring directory: ${KEYRING_DIR}"
  echo "[DRY-RUN] Target keyring file:      ${KEYRING_FILE}"
  echo "[DRY-RUN] Would ensure directory $KEYRING_DIR (chown ${API_UID}:${API_GID}, chmod 0750)"
  if file_exists "$KEYRING_FILE"; then
    echo "[DRY-RUN] Keyring file exists. Would ensure chmod 0600, chown ${API_UID}:${API_GID}"
  else
    echo "[DRY-RUN] Keyring file absent. Would check for encrypted envelopes and run manage-ssh-keys init --path $KEYRING_FILE"
  fi
  echo "[DRY-RUN] Would run manage-ssh-keys migrate --path $KEYRING_FILE"
  echo "[DRY-RUN] Would ensure SSH_KEY_ENCRYPTION_KEY_FILE in ${ENV_FILE}"
  if ! grep -q "${KEYRING_DIR}:${KEYRING_DIR}" "$COMPOSE_FILE"; then
    echo "[DRY-RUN] Would wire '- ${KEYRING_DIR}:${KEYRING_DIR}:ro' into services.api.volumes in ${COMPOSE_FILE}"
  fi
  exit 0
fi
# 1. Ensure host directory exists with proper permissions
$SUDO mkdir -p "$KEYRING_DIR"
$SUDO chown "${API_UID}:${API_GID}" "$KEYRING_DIR"
$SUDO chmod 0750 "$KEYRING_DIR"

# 2. Pre-flight & wire configuration BEFORE any key mutations
echo "[Keyring] Pre-flighting configuration: updating .env and docker-compose.yml..."
if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required for safe, structural compose configuration." >&2
  echo "Action required: Install python3 before bootstrapping keyring." >&2
  exit 1
fi

# Update .env path
if [[ -f "$ENV_FILE" ]]; then
  CURRENT_ENV_KEYRING="$(grep -E '^SSH_KEY_ENCRYPTION_KEY_FILE=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\"'\'' ' || true)"
  if [[ -z "$CURRENT_ENV_KEYRING" ]]; then
    echo "SSH_KEY_ENCRYPTION_KEY_FILE=${KEYRING_FILE}" >> "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    echo "[Keyring] Appended SSH_KEY_ENCRYPTION_KEY_FILE=${KEYRING_FILE} to ${ENV_FILE}"
  elif [[ "$CURRENT_ENV_KEYRING" != "$KEYRING_FILE" ]]; then
    python3 - "$ENV_FILE" "$KEYRING_FILE" << 'EOF'
import sys
env_file, target = sys.argv[1], sys.argv[2]
with open(env_file, 'r') as f:
    lines = f.readlines()
new_lines = []
for line in lines:
    if line.startswith('SSH_KEY_ENCRYPTION_KEY_FILE='):
        new_lines.append(f'SSH_KEY_ENCRYPTION_KEY_FILE={target}\n')
    else:
        new_lines.append(line)
with open(env_file, 'w') as f:
    f.writelines(new_lines)
EOF
    chmod 0600 "$ENV_FILE"
    echo "[Keyring] Updated SSH_KEY_ENCRYPTION_KEY_FILE=${KEYRING_FILE} in ${ENV_FILE}"
  else
    echo "[Keyring] Verified SSH_KEY_ENCRYPTION_KEY_FILE=${KEYRING_FILE} in ${ENV_FILE}"
  fi
fi

# Update docker-compose.yml: exact :ro mount and format-matching environment entry
WIRED=false
python3 - "$COMPOSE_FILE" "$KEYRING_DIR" "$KEYRING_FILE" << 'EOF' && WIRED=true || WIRED=false
import sys

compose_file = sys.argv[1]
keyring_dir = sys.argv[2]
keyring_file = sys.argv[3]

with open(compose_file, 'r') as f:
    lines = f.readlines()

# Pass 1: Locate services -> api block
in_services = False
services_indent = -1
api_start_idx = -1
api_indent = -1
api_end_idx = len(lines)

for idx, line in enumerate(lines):
    stripped = line.strip()
    if not stripped or stripped.startswith('#'):
        continue
    indent = len(line) - len(line.lstrip())

    if stripped == 'services:':
        in_services = True
        services_indent = indent
        continue

    if in_services:
        if indent <= services_indent:
            in_services = False
            break
        if stripped.startswith('api:'):
            api_start_idx = idx
            api_indent = indent
            continue
        elif api_start_idx != -1 and indent <= api_indent:
            api_end_idx = idx
            break

if api_start_idx == -1:
    sys.stderr.write('Error: Could not locate services.api block in compose file.\n')
    sys.exit(1)

mount_target = f'{keyring_dir}:{keyring_dir}:ro'

# Pass 2: Check / update volumes under api
in_volumes = False
volumes_indent = -1
volumes_item_indent = -1
volumes_header_idx = -1
last_volume_item_idx = -1
volumes_has_ro_mount = False

for idx in range(api_start_idx, api_end_idx):
    line = lines[idx]
    stripped = line.strip()
    if not stripped or stripped.startswith('#'):
        continue
    indent = len(line) - len(line.lstrip())

    if in_volumes:
        if indent <= volumes_indent:
            in_volumes = False
        elif stripped.startswith('-'):
            volumes_item_indent = indent
            last_volume_item_idx = idx
            spec = stripped.lstrip('-').strip().strip('\'"')
            parts = spec.split(':')
            if len(parts) >= 2 and parts[0] == keyring_dir and parts[1] == keyring_dir:
                mode = parts[2] if len(parts) > 2 else ''
                if mode == 'ro':
                    volumes_has_ro_mount = True
                else:
                    # Replace non-ro with exact :ro
                    indent_str = ' ' * indent
                    lines[idx] = f'{indent_str}- {mount_target}\n'
                    volumes_has_ro_mount = True
        else:
            in_volumes = False

    if not in_volumes and indent > api_indent and stripped == 'volumes:':
        in_volumes = True
        volumes_indent = indent
        volumes_header_idx = idx

if not volumes_has_ro_mount:
    if last_volume_item_idx != -1:
        indent_str = ' ' * volumes_item_indent
        lines.insert(last_volume_item_idx + 1, f'{indent_str}- {mount_target}\n')
        api_end_idx += 1
    elif volumes_header_idx != -1:
        indent_str = ' ' * (volumes_indent + 2)
        lines.insert(volumes_header_idx + 1, f'{indent_str}- {mount_target}\n')
        api_end_idx += 1
    else:
        header_indent = ' ' * (api_indent + 2)
        item_indent = ' ' * (api_indent + 4)
        insert_block = [
            f'{header_indent}volumes:\n',
            f'{item_indent}- {mount_target}\n'
        ]
        lines[api_start_idx + 1:api_start_idx + 1] = insert_block
        api_end_idx += len(insert_block)

# Pass 3: Check / update environment under api
in_env = False
env_indent = -1
env_item_indent = -1
env_header_idx = -1
last_env_item_idx = -1
env_key_idx = -1
is_list_env = False

for idx in range(api_start_idx, api_end_idx):
    line = lines[idx]
    stripped = line.strip()
    if not stripped or stripped.startswith('#'):
        continue
    indent = len(line) - len(line.lstrip())

    if in_env:
        if indent <= env_indent:
            in_env = False
        else:
            env_item_indent = indent
            last_env_item_idx = idx
            if stripped.startswith('-'):
                is_list_env = True
                item_content = stripped.lstrip('-').strip()
                if item_content.startswith('SSH_KEY_ENCRYPTION_KEY_FILE=') or item_content.startswith('SSH_KEY_ENCRYPTION_KEY_FILE:'):
                    env_key_idx = idx
            else:
                if stripped.startswith('SSH_KEY_ENCRYPTION_KEY_FILE:') or stripped.startswith('SSH_KEY_ENCRYPTION_KEY_FILE='):
                    env_key_idx = idx

    if not in_env and indent > api_indent and (stripped == 'environment:' or stripped.startswith('environment:')):
        in_env = True
        env_indent = indent
        env_header_idx = idx

if env_key_idx != -1:
    old_line = lines[env_key_idx]
    indent = len(old_line) - len(old_line.lstrip())
    indent_str = ' ' * indent
    if old_line.strip().startswith('-'):
        lines[env_key_idx] = f'{indent_str}- SSH_KEY_ENCRYPTION_KEY_FILE={keyring_file}\n'
    else:
        lines[env_key_idx] = f'{indent_str}SSH_KEY_ENCRYPTION_KEY_FILE: {keyring_file}\n'
elif env_header_idx != -1:
    indent_str = ' ' * (env_item_indent if env_item_indent > env_indent else env_indent + 2)
    target_idx = last_env_item_idx + 1 if last_env_item_idx != -1 else env_header_idx + 1
    if is_list_env:
        lines.insert(target_idx, f'{indent_str}- SSH_KEY_ENCRYPTION_KEY_FILE={keyring_file}\n')
    else:
        lines.insert(target_idx, f'{indent_str}SSH_KEY_ENCRYPTION_KEY_FILE: {keyring_file}\n')

with open(compose_file, 'w') as f:
    f.writelines(lines)

sys.exit(0)
EOF

if [[ "$WIRED" != "true" ]]; then
  echo "Error: Failed to safely wire keyring volume mount and environment into ${COMPOSE_FILE}." >&2
  echo "Action required: Verify ${COMPOSE_FILE} syntax and manually ensure services.api has volume mount '- ${KEYRING_DIR}:${KEYRING_DIR}:ro' and environment 'SSH_KEY_ENCRYPTION_KEY_FILE: ${KEYRING_FILE}'." >&2
  exit 1
fi
echo "[Keyring] Successfully pre-flighted and wired keyring mount and environment in ${COMPOSE_FILE}."

# 3. Check if keyring file exists; initialize if absent
if file_exists "$KEYRING_FILE"; then
  echo "[Keyring] Keyring file already exists at ${KEYRING_FILE} (preserving existing KEKs)."
  $SUDO chown "${API_UID}:${API_GID}" "$KEYRING_FILE"
  $SUDO chmod 0600 "$KEYRING_FILE"
else
  echo "[Keyring] Keyring file absent. Checking keys directory for safety..."
  # Run manage-ssh-keys init with explicit writable (:rw) mount for keyring dir.
  # --no-deps avoids recreating or starting postgres/dependent containers during key init.
  # The CLI has a built-in safety guard that fails closed if existing encrypted envelopes are found.
  echo "[Keyring] Initializing external SSH key encryption keyring..."
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
    -v "${KEYRING_DIR}:${KEYRING_DIR}:rw" \
    -e SSH_KEY_ENCRYPTION_KEY_FILE="$KEYRING_FILE" \
    api node dist/scripts/manage-ssh-keys.js init --path "$KEYRING_FILE"

  if ! file_exists "$KEYRING_FILE"; then
    echo "Error: Keyring initialization failed; file was not created." >&2
    exit 1
  fi
  $SUDO chown "${API_UID}:${API_GID}" "$KEYRING_FILE"
  $SUDO chmod 0600 "$KEYRING_FILE"
  echo "[Keyring] Keyring file initialized and permissions set (0600, owner ${API_UID}:${API_GID})."
fi

# 4. Migrate managed keys to envelope encryption
echo "[Keyring] Running migration on managed SSH keys..."
docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
  -v "${KEYRING_DIR}:${KEYRING_DIR}:ro" \
  -e SSH_KEY_ENCRYPTION_KEY_FILE="$KEYRING_FILE" \
  api node dist/scripts/manage-ssh-keys.js migrate --path "$KEYRING_FILE"

# 5. Recreate API container if currently running
if command -v docker >/dev/null 2>&1; then
  RUNNING_API="$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null | head -1 || true)"
  if [[ -n "$RUNNING_API" ]]; then
    echo "[Keyring] Recreating API container with updated mount and environment..."
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --remove-orphans api
  fi
fi

echo "[Keyring] SSH keyring bootstrap completed successfully."
