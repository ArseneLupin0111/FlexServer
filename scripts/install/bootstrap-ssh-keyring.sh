#!/usr/bin/env bash
#
# bootstrap-ssh-keyring.sh — Idempotent, durable host bootstrapper for SSH and AI
# keyring envelope encryption.
#
# Responsibilities:
#   1. Prepares external keyring directory (/etc/flexserver) outside checkout, DATA_DIR, and PRIVATE_DIR.
#   2. Enforces strict POSIX DAC permissions (0750 dir, 0600 file, owned by API container UID:GID) for both keyrings.
#   3. Fails closed before generating a new KEK if existing encrypted envelopes are found without a keyring.
#   4. Initializes a new external SSH KEK keyring only when absent and safe to do so.
#   5. Atomically migrates existing plaintext OpenSSH private keys to encrypted envelopes via CLI.
#   6. Initializes a new external AI keyring only when absent and safe to do so.
#   7. Ensures .env and docker-compose.yml wire the keyring paths, APP_AI_ENABLED flag, and read-only container mount.
#   8. Existing encrypted AI data blocks AI keyring regeneration (fail closed).
#   9. NEVER prints secret key material to stdout/stderr.
#
# Usage:
#   sudo bash scripts/install/bootstrap-ssh-keyring.sh [--deploy-path /opt/vps-manager-nodejs] [--keyring-dir <dir>] [--keyring-file <file>] [--ai-keyring-file <file>] [--dry-run]
#
# Usage:
#   sudo bash scripts/install/bootstrap-ssh-keyring.sh [--deploy-path /opt/vps-manager-nodejs] [--dry-run]
#

set -euo pipefail

DEPLOY_PATH="/opt/vps-manager-nodejs"
EXPLICIT_KEYRING_FILE=""
EXPLICIT_KEYRING_DIR=""
EXPLICIT_AI_KEYRING_FILE=""
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
    --ai-keyring-file)
      EXPLICIT_AI_KEYRING_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--deploy-path <path>] [--keyring-dir <dir>] [--keyring-file <file>] [--ai-keyring-file <file>] [--dry-run]"
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

# Preserve existing configured custom keyring paths from .env before defaulting
ENV_KEYRING=""
ENV_AI_KEYRING=""
if [[ -f "$ENV_FILE" ]]; then
  ENV_KEYRING="$(grep -E '^SSH_KEY_ENCRYPTION_KEY_FILE=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\"'\'' ' || true)"
  ENV_AI_KEYRING="$(grep -E '^AI_KEYRING_FILE=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\"'\'' ' || true)"
fi

if [[ -n "$EXPLICIT_KEYRING_FILE" ]]; then
  KEYRING_FILE="$EXPLICIT_KEYRING_FILE"
  KEYRING_DIR="$(dirname "$KEYRING_FILE")"
elif [[ -n "$ENV_KEYRING" ]]; then
  KEYRING_FILE="$ENV_KEYRING"
  KEYRING_DIR="$(dirname "$KEYRING_FILE")"
  echo "[Keyring] Preserving existing configured SSH keyring path from .env: ${KEYRING_FILE}"
elif [[ -n "$EXPLICIT_KEYRING_DIR" ]]; then
  KEYRING_DIR="$EXPLICIT_KEYRING_DIR"
  KEYRING_FILE="${KEYRING_DIR}/ssh-keyring.json"
else
  KEYRING_DIR="/etc/flexserver"
  KEYRING_FILE="${KEYRING_DIR}/ssh-keyring.json"
fi

if [[ -n "$EXPLICIT_AI_KEYRING_FILE" ]]; then
  AI_KEYRING_FILE="$EXPLICIT_AI_KEYRING_FILE"
  AI_KEYRING_DIR="$(dirname "$AI_KEYRING_FILE")"
elif [[ -n "$ENV_AI_KEYRING" ]]; then
  AI_KEYRING_FILE="$ENV_AI_KEYRING"
  AI_KEYRING_DIR="$(dirname "$AI_KEYRING_FILE")"
  echo "[Keyring] Preserving existing configured AI keyring path from .env: ${AI_KEYRING_FILE}"
elif [[ -n "$EXPLICIT_KEYRING_DIR" ]]; then
  AI_KEYRING_DIR="$EXPLICIT_KEYRING_DIR"
  AI_KEYRING_FILE="${AI_KEYRING_DIR}/ai-keyring.json"
else
  AI_KEYRING_DIR="/etc/flexserver"
  AI_KEYRING_FILE="${AI_KEYRING_DIR}/ai-keyring.json"
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

echo "[Keyring] Target SSH keyring directory: ${KEYRING_DIR}"
echo "[Keyring] Target SSH keyring file:      ${KEYRING_FILE}"
echo "[Keyring] Target AI keyring directory:  ${AI_KEYRING_DIR}"
echo "[Keyring] Target AI keyring file:       ${AI_KEYRING_FILE}"
echo "[Keyring] API runtime UID:GID:          ${API_UID}:${API_GID}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Target SSH keyring directory: ${KEYRING_DIR}"
  echo "[DRY-RUN] Target SSH keyring file:      ${KEYRING_FILE}"
  echo "[DRY-RUN] Target AI keyring directory:  ${AI_KEYRING_DIR}"
  echo "[DRY-RUN] Target AI keyring file:       ${AI_KEYRING_FILE}"
  echo "[DRY-RUN] Would ensure directory $KEYRING_DIR (chown ${API_UID}:${API_GID}, chmod 0750)"
  if [[ "$AI_KEYRING_DIR" != "$KEYRING_DIR" ]]; then
    echo "[DRY-RUN] Would ensure directory $AI_KEYRING_DIR (chown ${API_UID}:${API_GID}, chmod 0750)"
  fi
  if file_exists "$KEYRING_FILE"; then
    echo "[DRY-RUN] SSH keyring file exists. Would ensure chmod 0600, chown ${API_UID}:${API_GID}"
  else
    echo "[DRY-RUN] SSH keyring file absent. Would check for encrypted envelopes and run manage-ssh-keys init --path $KEYRING_FILE"
  fi
  echo "[DRY-RUN] Would run manage-ssh-keys migrate --path $KEYRING_FILE"
  if file_exists "$AI_KEYRING_FILE"; then
    echo "[DRY-RUN] AI keyring file exists. Would ensure chmod 0600, chown ${API_UID}:${API_GID}"
  else
    echo "[DRY-RUN] AI keyring file absent. Would run manage-ai-keys init with AI_KEYRING_FILE=$AI_KEYRING_FILE"
  fi
  echo "[DRY-RUN] Would ensure SSH_KEY_ENCRYPTION_KEY_FILE in ${ENV_FILE}"
  echo "[DRY-RUN] Would ensure AI_KEYRING_FILE and APP_AI_ENABLED in ${ENV_FILE}"
  if ! grep -q "${KEYRING_DIR}:${KEYRING_DIR}" "$COMPOSE_FILE"; then
    echo "[DRY-RUN] Would wire '- ${KEYRING_DIR}:${KEYRING_DIR}:ro' into services.api.volumes in ${COMPOSE_FILE}"
  fi
  if [[ "$AI_KEYRING_DIR" != "$KEYRING_DIR" ]] && ! grep -q "${AI_KEYRING_DIR}:${AI_KEYRING_DIR}" "$COMPOSE_FILE"; then
    echo "[DRY-RUN] Would wire '- ${AI_KEYRING_DIR}:${AI_KEYRING_DIR}:ro' into services.api.volumes in ${COMPOSE_FILE}"
  fi
  exit 0
fi
# 1. Ensure host directories exist with proper permissions
$SUDO mkdir -p "$KEYRING_DIR"
$SUDO chown "${API_UID}:${API_GID}" "$KEYRING_DIR"
$SUDO chmod 0750 "$KEYRING_DIR"
if [[ "$AI_KEYRING_DIR" != "$KEYRING_DIR" ]]; then
  $SUDO mkdir -p "$AI_KEYRING_DIR"
  $SUDO chown "${API_UID}:${API_GID}" "$AI_KEYRING_DIR"
  $SUDO chmod 0750 "$AI_KEYRING_DIR"
fi

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

  CURRENT_ENV_AI_KEYRING="$(grep -E '^AI_KEYRING_FILE=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\"'\'' ' || true)"
  if [[ -z "$CURRENT_ENV_AI_KEYRING" ]]; then
    echo "AI_KEYRING_FILE=${AI_KEYRING_FILE}" >> "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    echo "[Keyring] Appended AI_KEYRING_FILE=${AI_KEYRING_FILE} to ${ENV_FILE}"
  elif [[ "$CURRENT_ENV_AI_KEYRING" != "$AI_KEYRING_FILE" ]]; then
    python3 - "$ENV_FILE" "$AI_KEYRING_FILE" << 'EOF'
import sys
env_file, target = sys.argv[1], sys.argv[2]
with open(env_file, 'r') as f:
    lines = f.readlines()
new_lines = []
for line in lines:
    if line.startswith('AI_KEYRING_FILE='):
        new_lines.append(f'AI_KEYRING_FILE={target}\n')
    else:
        new_lines.append(line)
with open(env_file, 'w') as f:
    f.writelines(new_lines)
EOF
    chmod 0600 "$ENV_FILE"
    echo "[Keyring] Updated AI_KEYRING_FILE=${AI_KEYRING_FILE} in ${ENV_FILE}"
  else
    echo "[Keyring] Verified AI_KEYRING_FILE=${AI_KEYRING_FILE} in ${ENV_FILE}"
  fi

  CURRENT_ENV_AI_ENABLED="$(grep -E '^APP_AI_ENABLED=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\"'\'' ' || true)"
  if [[ -z "$CURRENT_ENV_AI_ENABLED" ]]; then
    echo "APP_AI_ENABLED=true" >> "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    echo "[Keyring] Appended APP_AI_ENABLED=true to ${ENV_FILE}"
  fi
fi

# Update docker-compose.yml: exact :ro mount and format-matching environment entry
WIRED=false
python3 - "$COMPOSE_FILE" "$KEYRING_DIR" "$KEYRING_FILE" "$AI_KEYRING_DIR" "$AI_KEYRING_FILE" << 'EOF' && WIRED=true || WIRED=false
import sys

compose_file = sys.argv[1]
keyring_dir = sys.argv[2]
keyring_file = sys.argv[3]
ai_keyring_dir = sys.argv[4]
ai_keyring_file = sys.argv[5]

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

# Pass 2: Check / update volumes under api
dirs_to_mount = [keyring_dir]
if ai_keyring_dir != keyring_dir and ai_keyring_dir not in dirs_to_mount:
    dirs_to_mount.append(ai_keyring_dir)

for target_dir in dirs_to_mount:
    mount_target = f'{target_dir}:{target_dir}:ro'
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
                if len(parts) >= 2 and parts[0] == target_dir and parts[1] == target_dir:
                    mode = parts[2] if len(parts) > 2 else ''
                    if mode == 'ro':
                        volumes_has_ro_mount = True
                    else:
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
env_vars = [
    ('SSH_KEY_ENCRYPTION_KEY_FILE', keyring_file),
    ('AI_KEYRING_FILE', ai_keyring_file),
    ('APP_AI_ENABLED', '${APP_AI_ENABLED:-true}')
]

in_env = False
env_indent = -1
env_item_indent = -1
env_header_idx = -1
last_env_item_idx = -1
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
            else:
                is_list_env = False

    if not in_env and indent > api_indent and (stripped == 'environment:' or stripped.startswith('environment:')):
        in_env = True
        env_indent = indent
        env_header_idx = idx

for var_name, var_val in env_vars:
    var_idx = -1
    for idx in range(api_start_idx, api_end_idx):
        line = lines[idx]
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        indent = len(line) - len(line.lstrip())
        if indent > (env_indent if env_indent != -1 else api_indent) and env_header_idx != -1 and idx > env_header_idx:
            if stripped.startswith('-'):
                item_content = stripped.lstrip('-').strip()
                if item_content.startswith(f'{var_name}=') or item_content.startswith(f'{var_name}:'):
                    var_idx = idx
            else:
                if stripped.startswith(f'{var_name}:') or stripped.startswith(f'{var_name}='):
                    var_idx = idx

    if var_idx != -1:
        old_line = lines[var_idx]
        indent = len(old_line) - len(old_line.lstrip())
        indent_str = ' ' * indent
        if old_line.strip().startswith('-'):
            lines[var_idx] = f'{indent_str}- {var_name}={var_val}\n'
        else:
            lines[var_idx] = f'{indent_str}{var_name}: {var_val}\n'
    elif env_header_idx != -1:
        indent_str = ' ' * (env_item_indent if env_item_indent > env_indent else env_indent + 2)
        target_idx = last_env_item_idx + 1 if last_env_item_idx != -1 else env_header_idx + 1
        if is_list_env:
            lines.insert(target_idx, f'{indent_str}- {var_name}={var_val}\n')
        else:
            lines.insert(target_idx, f'{indent_str}{var_name}: {var_val}\n')
        last_env_item_idx = target_idx
        api_end_idx += 1
    else:
        header_indent = ' ' * (api_indent + 2)
        item_indent = ' ' * (api_indent + 4)
        insert_block = [
            f'{header_indent}environment:\n',
            f'{item_indent}{var_name}: {var_val}\n'
        ]
        lines[api_start_idx + 1:api_start_idx + 1] = insert_block
        api_end_idx += len(insert_block)
        env_header_idx = api_start_idx + 1
        env_indent = len(header_indent)
        env_item_indent = len(item_indent)
        last_env_item_idx = api_start_idx + 2

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

# 5. Check if AI keyring file exists; initialize if absent
if file_exists "$AI_KEYRING_FILE"; then
  echo "[Keyring] AI keyring file already exists at ${AI_KEYRING_FILE} (preserving existing KEKs)."
  $SUDO chown "${API_UID}:${API_GID}" "$AI_KEYRING_FILE"
  $SUDO chmod 0600 "$AI_KEYRING_FILE"
else
  echo "[Keyring] AI keyring file absent. Initializing external AI keyring..."
  $SUDO mkdir -p "$AI_KEYRING_DIR"
  $SUDO chown "${API_UID}:${API_GID}" "$AI_KEYRING_DIR"
  $SUDO chmod 0750 "$AI_KEYRING_DIR"

  docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
    -v "${AI_KEYRING_DIR}:${AI_KEYRING_DIR}:rw" \
    -e AI_KEYRING_FILE="$AI_KEYRING_FILE" \
    api node dist/scripts/manage-ai-keys.js init

  if ! file_exists "$AI_KEYRING_FILE"; then
    echo "Error: AI keyring initialization failed; file was not created." >&2
    exit 1
  fi
  $SUDO chown "${API_UID}:${API_GID}" "$AI_KEYRING_FILE"
  $SUDO chmod 0600 "$AI_KEYRING_FILE"
  echo "[Keyring] AI keyring file initialized and permissions set (0600, owner ${API_UID}:${API_GID})."
fi

# 6. Recreate API container if currently running
if command -v docker >/dev/null 2>&1; then
  RUNNING_API="$(docker compose -f "$COMPOSE_FILE" ps -q api 2>/dev/null | head -1 || true)"
  if [[ -n "$RUNNING_API" ]]; then
    echo "[Keyring] Recreating API container with updated mount and environment..."
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --remove-orphans api
  fi
fi

echo "[Keyring] SSH and AI keyring bootstrap completed successfully."
