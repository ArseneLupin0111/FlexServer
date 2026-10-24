#!/usr/bin/env bash
#
# check-no-docker-socket.sh — Phase 5/Gate-5 Compose-surface Docker-socket guard.
#
# Primary guard (image metadata alone is ineffective because the socket is
# mounted at *run* time via Compose, not baked into image config):
#   1. raw repository `docker-compose.yml` plus rendered `docker compose config`;
#   2. scripts/install/install.sh generated Compose template (COMPOSE_CONTENT block)
#      plus a whole-file tripwire;
#   3. production Compose heredoc embedded in .github/workflows/ci.yml
#      (the `cat > '$DEPLOY_PATH/docker-compose.yml'` block written by deploy).
# Fails on /var/run/docker.sock, /run/docker.sock, docker.sock, and
# bind/source/target mount variants, plus group_add grants.
# Image `docker inspect` remains only a supplemental check in CI.
#
# Comment handling is consistent on every surface: all content passes through
# one normalization function that strips full-line YAML/shell comments and
# inline comments starting outside single/double quotes (a `#` begins a
# comment only at line start or after whitespace). Explanatory comments are
# therefore ignored, while real `volumes:` / `source:` / `target:` /
# `group_add:` config is still detected.
#
# Also asserts the deploy heredoc pins immutable images (no `:latest`).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
INSTALL_SH="${REPO_ROOT}/scripts/install/install.sh"
WORKFLOW="${REPO_ROOT}/.github/workflows/ci.yml"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# Keep pattern and normalization each in one source shared with the fidelity fixture.
# shellcheck source=/dev/null
source "${REPO_ROOT}/scripts/tests/socket-pattern.sh"
# shellcheck source=/dev/null
source "${REPO_ROOT}/scripts/tests/socket-normalize.sh"

fail_if_match() { # $1=label, reads stdin; normalized before matching.
  local label="$1"
  local hits
  hits="$(normalize_content | grep -nEi "$SOCKET_PATTERN" || true)"
  if [[ -n "$hits" ]]; then
    fail "$label references the Docker socket:"; printf '%s\n' "$hits" >&2
  else
    pass "$label has no Docker-socket reference"
  fi
}

fail_if_group_add() { # $1=label, reads stdin; normalized before matching.
  local label="$1"
  local hits
  hits="$(normalize_content | grep -nE 'group_add' || true)"
  if [[ -n "$hits" ]]; then
    fail "$label must not use group_add:"; printf '%s\n' "$hits" >&2
  else
    pass "$label uses no group_add"
  fi
}

# Normalized bind/source/target tripwire: passes clean, fails when a real
# mount line co-occurs with a socket path (both evaluated post-normalize).
fail_if_socket_mount_variant() { # $1=label, reads stdin
  local label="$1"
  local content
  content="$(cat)"
  local normalized
  normalized="$(printf '%s' "$content" | normalize_content)"
  local mount_hint=""
  local socket_hit=""
  mount_hint="$(printf '%s' "$normalized" | grep -nEi 'source:.*docker|target:.*docker|type:[[:space:]]*bind|volumes:' || true)"
  socket_hit="$(printf '%s' "$normalized" | grep -nEi "$SOCKET_PATTERN" || true)"
  if [[ -n "$mount_hint" && -n "$socket_hit" ]]; then
    fail "$label mounts the Docker socket via bind/source/target:"
    printf '%s\n' "$socket_hit" >&2
  else
    pass "$label has no Docker-socket bind/source/target mount"
  fi
}

# ── 1. Raw repo compose + rendered config ─────────────────────────────────
# All raw checks route through the same normalized helpers as every other
# surface (socket match, group_add, and source/target tripwire).
if [[ -f "$COMPOSE_FILE" ]]; then
  fail_if_match "docker-compose.yml" <"$COMPOSE_FILE"
  fail_if_group_add "docker-compose.yml" <"$COMPOSE_FILE"
  fail_if_socket_mount_variant "docker-compose.yml" <"$COMPOSE_FILE"
else
  fail "docker-compose.yml not found"
fi

# Optional feature overrides must preserve the same API socket isolation.
for override in docker/compose/applications.yml docker/compose/files.yml docker/compose/terminal.yml; do
  if [[ -f "${REPO_ROOT}/${override}" ]]; then
    fail_if_match "$override" <"${REPO_ROOT}/${override}"
    fail_if_group_add "$override" <"${REPO_ROOT}/${override}"
    fail_if_socket_mount_variant "$override" <"${REPO_ROOT}/${override}"
  fi
done

# ── 2. Rendered `docker compose config` ───────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  RENDERED="$(POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-ci-compose-password}" \
    DASHBOARD_SESSION_SECRET="${DASHBOARD_SESSION_SECRET:-ci-compose-session-secret-012345678901234567890123}" \
    docker compose -f "$COMPOSE_FILE" config 2>/dev/null || true)"
  if [[ -z "$RENDERED" ]]; then
    fail "docker compose config produced no output"
  else
    fail_if_match "rendered docker compose config" <<<"$RENDERED"
    fail_if_group_add "rendered docker compose config" <<<"$RENDERED"
    fail_if_socket_mount_variant "rendered docker compose config" <<<"$RENDERED"
  fi
else
  echo "SKIP: docker CLI unavailable; rendered-config check deferred to CI."
fi

# ── 3. install.sh generated Compose template ──────────────────────────────
if [[ -f "$INSTALL_SH" ]]; then
  TEMPLATE="$(awk '/COMPOSE_CONTENT=\$\(/{flag=1;next} /^COMPOSE$/{flag=0} flag' "$INSTALL_SH")"
  if [[ -z "$TEMPLATE" ]]; then
    fail "install.sh COMPOSE_CONTENT block not found"
  else
    fail_if_match "install.sh generated Compose template" <<<"$TEMPLATE"
    fail_if_group_add "install.sh generated Compose template" <<<"$TEMPLATE"
    fail_if_socket_mount_variant "install.sh generated Compose template" <<<"$TEMPLATE"
  fi
  # Whole-file tripwire catches socket references outside the template too.
  if normalize_content < "$INSTALL_SH" | grep -nEi "$SOCKET_PATTERN" >/dev/null 2>&1; then
    fail "install.sh references the Docker socket"
    normalize_content < "$INSTALL_SH" | grep -nEi "$SOCKET_PATTERN" >&2 || true
  else
    pass "install.sh has no Docker-socket reference"
  fi
  if normalize_content < "$INSTALL_SH" | grep -nE 'group_add' >/dev/null 2>&1; then
    fail "install.sh must not use group_add"
    normalize_content < "$INSTALL_SH" | grep -nE 'group_add' >&2 || true
  else
    pass "install.sh uses no group_add"
  fi
else
  fail "install.sh not found"
fi

# ── 4. Production Compose heredoc in workflow ─────────────────────────────
if [[ -f "$WORKFLOW" ]]; then
  HEREDOC="$(awk "/cat > '\\\$DEPLOY_PATH\\/docker-compose.yml'/{flag=1;next} /^ *EOF$/{if(flag){flag=0;exit}} flag" "$WORKFLOW")"
  if [[ -z "$HEREDOC" ]]; then
    fail "deploy docker-compose heredoc not found in ci.yml"
  else
    fail_if_match "deploy docker-compose heredoc" <<<"$HEREDOC"
    fail_if_group_add "deploy docker-compose heredoc" <<<"$HEREDOC"
    fail_if_socket_mount_variant "deploy docker-compose heredoc" <<<"$HEREDOC"
    if printf '%s' "$HEREDOC" | normalize_content | grep -nE ':latest' >/dev/null 2>&1; then
      fail "deploy heredoc must pin immutable SHA tags (no :latest)"
      printf '%s' "$HEREDOC" | normalize_content | grep -nE ':latest' >&2 || true
    else
      pass "deploy heredoc pins immutable tags (no :latest)"
    fi
  fi
  # Publish fallback tripwire: deploy inputs must never default to :latest.
  if normalize_content < "$WORKFLOW" | grep -nE 'API_SHA_TAG.*:latest|WEB_SHA_TAG.*:latest|:-.*:latest|\$API_IMAGE\}:latest|\$WEB_IMAGE\}:latest' >/dev/null 2>&1; then
    fail "ci.yml must not fall back to :latest for deployed images"
    normalize_content < "$WORKFLOW" | grep -nE 'API_SHA_TAG.*:latest|WEB_SHA_TAG.*:latest|:-.*:latest|\$API_IMAGE\}:latest|\$WEB_IMAGE\}:latest' >&2 || true
  else
    pass "ci.yml has no :latest fallback for deployed images"
  fi
else
  fail "ci.yml not found"
fi

echo "RESULT: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
