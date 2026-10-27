#!/usr/bin/env bash
#
# Focused behavioral regression for install.sh Compose keyring provisioning.
#
# The fixture runs a copied installer with a fake Docker CLI.  It gives the
# API service's normal Compose definition a read-only custom keyring bind, then
# requires the administration run to use a separate read-write bind.  A second
# install must preserve the generated keyring and must not initialize it again.
# No production path, Docker daemon, or host service is touched.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="${REPO_ROOT}/scripts/install/install.sh"
INSTALL_LIB="${REPO_ROOT}/scripts/install/installer-lib.sh"
CLI_SOURCE="${REPO_ROOT}/scripts/install/flexserverctl.py"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# install.sh intentionally requires root because it is a host installer.  The
# real behavior is covered on a root-capable Linux runner; do not fake that
# trust boundary in this test.
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "SKIP: Compose keyring fixture requires root to execute install.sh" >&2
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

APP_DIR="$WORK/app"
SSH_DIR="$WORK/ssh-admin"
AI_DIR="$WORK/ai-admin"
COMPOSE_DIR="$WORK/compose-admin"
COMPOSE_KEYRING_FILE="$COMPOSE_DIR/compose-keyring.json"
DOCKER_LOG="$WORK/docker.log"
FAKEBIN="$WORK/fakebin"
INSTALL_DIR="$WORK/installer"
mkdir -p "$FAKEBIN" "$INSTALL_DIR" "$APP_DIR"
: > "$DOCKER_LOG"

# Start from an existing install configuration with a missing Compose keyring.
# Keeping this path separate from the SSH and AI paths exercises the custom
# path branch and causes the generated API mount to be read-only.
cat > "$APP_DIR/.env" <<ENV
SSH_KEY_ENCRYPTION_KEY_FILE=${SSH_DIR}/ssh-keyring.json
AI_KEYRING_FILE=${AI_DIR}/ai-keyring.json
COMPOSE_KEYRING_FILE=${COMPOSE_KEYRING_FILE}
ENV
printf 'fixture-password\n' > "$WORK/password"

cp "$INSTALL_SH" "$INSTALL_DIR/install.sh"
cp "$INSTALL_LIB" "$INSTALL_DIR/installer-lib.sh"
cp "$CLI_SOURCE" "$INSTALL_DIR/flexserverctl.py"
chmod 0755 "$INSTALL_DIR/install.sh"

REAL_MKTEMP="$(command -v mktemp)"
REAL_MV="$(command -v mv)"

# Keep the installer's final CLI write inside the fixture.  The installer does
# not expose a destination flag, so this command shim is the safe boundary for
# that unrelated final step; all keyring assertions still use real filesystem
# operations in the disposable directories above.
cat > "$FAKEBIN/mktemp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == /usr/local/bin/flexserverctl.tmp.XXXXXX ]]; then
  exec "$REAL_MKTEMP" "$WORK/flexserverctl.tmp.XXXXXX"
fi
exec "$REAL_MKTEMP" "$@"
SH
cat > "$FAKEBIN/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
last=$(( ${#args[@]} - 1 ))
if [[ "$last" -ge 0 && "${args[$last]}" == /usr/local/bin/flexserverctl ]]; then
  args[$last]="$WORK/flexserverctl"
fi
exec "$REAL_MV" "${args[@]}"
SH
# chown is not part of the behavior under test; making it a no-op avoids
# requiring the fixture's synthetic container UID to exist on the host.
cat > "$FAKEBIN/chown" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 0755 "$FAKEBIN/mktemp" "$FAKEBIN/mv" "$FAKEBIN/chown"


# Health checks are the only curl operation reached by this reduced install.
cat > "$FAKEBIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *"/api/health"*) exit 0 ;;
  *) echo "unexpected curl invocation: $*" >&2; exit 97 ;;
esac
SH
chmod 0755 "$FAKEBIN/curl"

# Fake Docker implements only the public commands install.sh reaches.  The
# keyring init handlers deliberately fail unless their administrative bind is
# read-write, which makes a read-only-only regression observable without a
# Docker daemon.
cat > "$FAKEBIN/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker' >> "$DOCKER_LOG"
for arg in "$@"; do printf ' %q' "$arg" >> "$DOCKER_LOG"; done
printf '\n' >> "$DOCKER_LOG"

if [[ "${1-}" == compose ]]; then
  shift
  if [[ "${1-}" == version ]]; then
    echo 'Docker Compose fixture v2'
    exit 0
  fi
  joined="$*"
  if [[ "$joined" == *'set-dashboard-password.js --stdin'* ]]; then
    cat >/dev/null
    exit 0
  fi
  if [[ "$joined" == *'manage-compose-keys.js init'* ]]; then
    rw_mount=""
    compose_env=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -v) rw_mount="${2-}"; shift 2 ;;
        -e) case "${2-}" in COMPOSE_KEYRING_FILE=*) compose_env="${2#*=}" ;; esac; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$rw_mount" != *:rw ]]; then
      echo 'Compose keyring administration was not given a read-write mount' >&2
      exit 98
    fi
    host_dir="${rw_mount%%:*}"
    host_file="$host_dir/${compose_env##*/}"
    mkdir -p "$host_dir"
    printf '{"fixture":"compose-keyring","version":1}\n' > "$host_file"
    exit 0
  fi
  if [[ "$joined" == *'manage-ssh-keys.js init'* ]]; then
    mount=""
    key_path=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -v) mount="${2-}"; shift 2 ;;
        --path) key_path="${2-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ "$mount" == *:rw ]] || { echo 'SSH fixture mount is not writable' >&2; exit 98; }
    mkdir -p "$(dirname "$key_path")"
    printf '{"fixture":"ssh-keyring","version":1}\n' > "$key_path"
    exit 0
  fi
  if [[ "$joined" == *'manage-ai-keys.js init'* ]]; then
    mount=""
    ai_env=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -v) mount="${2-}"; shift 2 ;;
        -e) case "${2-}" in AI_KEYRING_FILE=*) ai_env="${2#*=}" ;; esac; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ "$mount" == *:rw ]] || { echo 'AI fixture mount is not writable' >&2; exit 98; }
    host_dir="${mount%%:*}"
    mkdir -p "$host_dir"
    printf '{"fixture":"ai-keyring","version":1}\n' > "$host_dir/${ai_env##*/}"
    exit 0
  fi
  exit 0
fi

if [[ "${1-}" == run ]]; then
  # install.sh asks the API image for its numeric runtime identity.
  echo '1000:1000'
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 97
SH
chmod 0755 "$FAKEBIN/docker"

ORIGINAL_PATH="$PATH"
export WORK DOCKER_LOG REAL_MKTEMP REAL_MV
export PATH="$FAKEBIN:$ORIGINAL_PATH"

run_install() {
  local output rc
  if output="$(bash "$INSTALL_DIR/install.sh" \
      --app-dir "$APP_DIR" \
      --skip-pull \
      --skip-agent \
      --dashboard-password-file "$WORK/password" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi
  printf '%s\n' "$output"
  return "$rc"
}

FIRST_OUTPUT=""
FIRST_RC=0
if FIRST_OUTPUT="$(run_install)"; then FIRST_RC=0; else FIRST_RC=$?; fi
if [[ "$FIRST_RC" -eq 0 ]]; then
  pass "fresh install completes with fake Docker and no production mutation"
else
  fail "fresh install exited ${FIRST_RC}: ${FIRST_OUTPUT}"
fi

COMPOSE_FILE="$APP_DIR/docker-compose.yml"
if [[ -f "$COMPOSE_FILE" ]] && grep -Fq "      - ${COMPOSE_DIR}:${COMPOSE_DIR}:ro" "$COMPOSE_FILE"; then
  pass "normal API Compose definition keeps the custom keyring mount read-only"
else
  fail "normal API Compose definition is missing the custom read-only keyring mount"
fi

if [[ -f "$COMPOSE_KEYRING_FILE" ]]; then
  pass "fresh Compose keyring is provisioned"
else
  fail "fresh Compose keyring was not provisioned"
fi

COMPOSE_INIT_COUNT="$(grep -c 'manage-compose-keys.js init' "$DOCKER_LOG" 2>/dev/null || true)"
if [[ "$COMPOSE_INIT_COUNT" -eq 1 ]] \
  && grep -Fq -- "-v ${COMPOSE_DIR}:/run/flexserver-compose-admin:rw" "$DOCKER_LOG" \
  && grep -Fq -- "COMPOSE_KEYRING_FILE=/run/flexserver-compose-admin/compose-keyring.json" "$DOCKER_LOG"; then
  pass "Compose keyring init uses a separate read-write administration mount"
else
  fail "Compose keyring init did not use the expected read-write administration mount"
fi

if grep -Fq "COMPOSE_KEYRING_FILE=${COMPOSE_KEYRING_FILE}" "$APP_DIR/.env"; then
  pass "custom Compose keyring path is persisted in the generated environment"
else
  fail "custom Compose keyring path was not persisted"
fi

cp "$COMPOSE_KEYRING_FILE" "$WORK/compose-keyring-before-repeat.json"
SECOND_OUTPUT=""
SECOND_RC=0
if SECOND_OUTPUT="$(run_install)"; then SECOND_RC=0; else SECOND_RC=$?; fi
if [[ "$SECOND_RC" -eq 0 ]]; then
  pass "repeat install completes"
else
  fail "repeat install exited ${SECOND_RC}: ${SECOND_OUTPUT}"
fi

if cmp -s "$WORK/compose-keyring-before-repeat.json" "$COMPOSE_KEYRING_FILE"; then
  pass "repeat install preserves the existing Compose keyring bytes"
else
  fail "repeat install changed the existing Compose keyring"
fi

COMPOSE_INIT_COUNT_AFTER="$(grep -c 'manage-compose-keys.js init' "$DOCKER_LOG" 2>/dev/null || true)"
if [[ "$COMPOSE_INIT_COUNT_AFTER" -eq 1 ]] && [[ "$SECOND_OUTPUT" == *"Preserving existing Compose keyring at ${COMPOSE_KEYRING_FILE}."* ]]; then
  pass "repeat install preserves the custom keyring without reinitializing it"
else
  fail "repeat install reinitialized the Compose keyring or did not report preservation"
fi

echo "RESULT: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
