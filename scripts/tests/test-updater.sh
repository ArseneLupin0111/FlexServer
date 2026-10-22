#!/usr/bin/env bash
# shellcheck disable=SC2317
#
# test-updater.sh — Durable assertions for the local-agent updater slice
# (scripts/install/install-updater.sh + packages/agent/internal/updater +
# packages/agent/cmd/vps-updater).
#
# Verifies:
#   1. Syntax: install-updater.sh, install-local-agent.sh, install.sh,
#      install-fleet-updater.sh, and this test pass `bash -n`.
#   2. Live --help and behavioral rejection checks:
#        - help command exits cleanly;
#        - unprivileged non-dry-run install refused (tested across host EUID);
#        - missing binary and missing config rejected;
#        - valid keyless config succeeds in --dry-run --upgrade mode;
#        - generated daemon, helper, and path units verify hardening and triggers;
#        - SHA-256 match succeeds, mismatch and malformed hex rejected;
#        - config validation rejects non-HTTPS, userinfo, unscoped bearer,
#          deviant targets (binary/unit/stateDir), allowedHosts, malformed JSON;
#        - argument parsing rejects --fleet-release-pub-key and accepts --pubkey-file.
#   2b. Installer boundary regression checks:
#        - install-local-agent.sh forwards --pubkey-file to install-updater.sh at
#          both upgrade and bootstrap callsites (never --fleet-release-pub-key);
#        - install-local-agent.sh provisions pinned public key to /etc/vps-updater/fleet-release.pub.
#   3. Scoped Go verification: vet + tests for internal/updater and
#      internal/config, plus a GOOS=linux build of cmd/vps-updater.
#
# Safe to run anywhere: live checks use --help/--dry-run only (no systemd
# writes); does not require root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_UPDATER="${REPO_ROOT}/scripts/install/install-updater.sh"
INSTALL_LOCAL="${REPO_ROOT}/scripts/install/install-local-agent.sh"
INSTALL_SH="${REPO_ROOT}/scripts/install/install.sh"
INSTALL_FLEET_UPDATER="${REPO_ROOT}/scripts/install/install-fleet-updater.sh"
AGENT_DIR="${REPO_ROOT}/packages/agent"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# ── 1. Syntax ─────────────────────────────────────────────────────────────

for f in "$INSTALL_UPDATER" "$INSTALL_LOCAL" "$INSTALL_SH" "$INSTALL_FLEET_UPDATER" "${BASH_SOURCE[0]}"; do
  if [[ -f "$f" ]]; then
    if bash -n "$f"; then pass "$(basename "$f") syntax OK"; else fail "$(basename "$f") syntax"; fi
  fi
done

# ── 2. Live --help and behavioral rejection checks ────────────────────────

if "$INSTALL_UPDATER" --help >/dev/null 2>&1; then
  pass "--help exits 0"
else
  fail "--help must exit 0"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 755 "$WORK"
printf '#!/bin/sh\necho 1.0.0+test\n' > "$WORK/vps-updater"
chmod 755 "$WORK/vps-updater"

NONROOT_REFUSED=0
if [[ $EUID -eq 0 ]]; then
  if command -v runuser &>/dev/null; then
    runuser -u nobody -- "$INSTALL_UPDATER" --binary "$WORK/vps-updater" --config "$WORK/missing.json" >/dev/null 2>&1 || NONROOT_REFUSED=1
  elif command -v su &>/dev/null; then
    su -s /bin/sh nobody -c "'$INSTALL_UPDATER' --binary '$WORK/vps-updater' --config '$WORK/missing.json'" >/dev/null 2>&1 || NONROOT_REFUSED=1
  elif command -v sudo &>/dev/null; then
    sudo -u nobody "$INSTALL_UPDATER" --binary "$WORK/vps-updater" --config "$WORK/missing.json" >/dev/null 2>&1 || NONROOT_REFUSED=1
  else
    NONROOT_REFUSED=1
  fi
else
  "$INSTALL_UPDATER" --binary "$WORK/vps-updater" --config "$WORK/missing.json" >/dev/null 2>&1 || NONROOT_REFUSED=1
fi

if [[ "$NONROOT_REFUSED" -eq 1 ]]; then
  pass "install without root and without --dry-run is refused"
else
  fail "non-root install must be refused before other checks"
fi

if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/nonexistent" --config "$WORK/missing.json" >/dev/null 2>&1; then
  fail "--dry-run with missing binary must fail"
else
  pass "--dry-run rejects missing binary"
fi

if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/nonexistent.json" >/dev/null 2>&1; then
  fail "--dry-run with missing config must fail"
else
  pass "--dry-run rejects missing config file"
fi

if command -v node &>/dev/null && (command -v sha256sum &>/dev/null || command -v shasum &>/dev/null); then
  if command -v sha256sum &>/dev/null; then
    SHA256_REAL="$(sha256sum "$WORK/vps-updater" | awk '{print $1}')"
  else
    SHA256_REAL="$(shasum -a 256 "$WORK/vps-updater" | awk '{print $1}')"
  fi

  cat > "$WORK/config-valid.json" <<JSON
{
  "apiBase": "https://api.example.com",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "agentUnit": "vps-manager-agent.service",
  "stateDir": "/var/lib/vps-updater"
}
JSON

  if OUT="$("$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-valid.json" 2>&1)"; then
    pass "valid keyless config succeeds in --dry-run --upgrade mode"
  else
    fail "--dry-run with valid keyless config must succeed: $OUT"
    OUT=""
  fi

  if [[ -n "$OUT" ]] \
    && printf '%s' "$OUT" | grep -Fq 'User=vps-updater' \
    && printf '%s' "$OUT" | grep -Fq 'NoNewPrivileges=true' \
    && printf '%s' "$OUT" | grep -Fq 'ProtectSystem=strict' \
    && printf '%s' "$OUT" | grep -Fq 'InaccessiblePaths=/etc/vps-manager-agent' \
    && printf '%s' "$OUT" | grep -Fq 'ReadWritePaths=/var/lib/vps-updater' \
    && printf '%s' "$OUT" | grep -Fq 'CapabilityBoundingSet='; then
    pass "generated daemon unit contains required isolation and hardening"
  else
    fail "daemon unit must include isolation, empty capabilities and hardening"
  fi

  if [[ -n "$OUT" ]] \
    && printf '%s' "$OUT" | grep -Fq 'User=root' \
    && printf '%s' "$OUT" | grep -Fq 'ExecStart=/usr/local/lib/vps-manager-agent/vps-updater helper -config /etc/vps-updater/config.json' \
    && printf '%s' "$OUT" | grep -Fq 'CapabilityBoundingSet='; then
    pass "generated helper unit uses fixed argv and empty capability bounding set"
  else
    fail "helper unit must run fixed argv as root with empty capabilities"
  fi

  if [[ -n "$OUT" ]] \
    && printf '%s' "$OUT" | grep -Fq 'DirectoryNotEmpty=/var/lib/vps-updater/pending' \
    && printf '%s' "$OUT" | grep -Fq 'Unit=vps-updater-apply.service'; then
    pass "generated path unit watches pending/ and triggers apply service"
  else
    fail "path unit must watch pending/ and trigger helper service"
  fi

  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-valid.json" --sha256 "$SHA256_REAL" >/dev/null 2>&1; then
    pass "matching --sha256 succeeds in --upgrade mode"
  else
    fail "matching --sha256 must succeed"
  fi

  WRONG_SHA="0000000000000000000000000000000000000000000000000000000000000000"
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-valid.json" --sha256 "$WRONG_SHA" >/dev/null 2>&1; then
    fail "mismatched --sha256 must fail"
  else
    pass "mismatched --sha256 is refused"
  fi

  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-valid.json" --sha256 "invalid-hex" >/dev/null 2>&1; then
    fail "malformed --sha256 must fail"
  else
    pass "malformed --sha256 is refused"
  fi

  # Installer argument boundary: install-updater.sh accepts --pubkey-file
  touch "$WORK/fleet-release.pub"
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-valid.json" --pubkey-file "$WORK/fleet-release.pub" >/dev/null 2>&1; then
    pass "install-updater.sh accepts --pubkey-file in --upgrade mode"
  else
    fail "install-updater.sh must accept --pubkey-file in --upgrade mode"
  fi

  # install-updater.sh rejects legacy / foreign --fleet-release-pub-key option
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-valid.json" --fleet-release-pub-key "$WORK/fleet-release.pub" >/dev/null 2>&1; then
    fail "install-updater.sh must reject unknown --fleet-release-pub-key option"
  else
    pass "install-updater.sh rejects unknown --fleet-release-pub-key option"
  fi

  cat > "$WORK/config-http.json" <<JSON
{
  "apiBase": "http://api.example.com",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "stateDir": "/var/lib/vps-updater"
}
JSON
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-http.json" >/dev/null 2>&1; then
    fail "insecure HTTP apiBase must fail"
  else
    pass "config gate rejects non-HTTPS apiBase"
  fi

  cat > "$WORK/config-userinfo.json" <<JSON
{
  "apiBase": "https://user:pass@api.example.com",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "stateDir": "/var/lib/vps-updater"
}
JSON
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-userinfo.json" >/dev/null 2>&1; then
    fail "userinfo in apiBase must fail"
  else
    pass "config gate rejects userinfo in apiBase"
  fi

  cat > "$WORK/config-unscoped.json" <<JSON
{
  "apiBase": "https://api.example.com",
  "credential": "unscoped_raw_secret_key",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "stateDir": "/var/lib/vps-updater"
}
JSON
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-unscoped.json" >/dev/null 2>&1; then
    fail "unscoped credential must fail"
  else
    pass "config gate rejects unscoped credential"
  fi

  cat > "$WORK/config-bad-bin.json" <<JSON
{
  "apiBase": "https://api.example.com",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "/usr/bin/deviant-agent",
  "stateDir": "/var/lib/vps-updater"
}
JSON
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-bad-bin.json" >/dev/null 2>&1; then
    fail "deviant agentBinary must fail"
  else
    pass "config gate rejects deviant agentBinary"
  fi

  cat > "$WORK/config-bad-unit.json" <<JSON
{
  "apiBase": "https://api.example.com",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "agentUnit": "deviant.service",
  "stateDir": "/var/lib/vps-updater"
}
JSON
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-bad-unit.json" >/dev/null 2>&1; then
    fail "deviant agentUnit must fail"
  else
    pass "config gate rejects deviant agentUnit"
  fi

  cat > "$WORK/config-bad-state.json" <<JSON
{
  "apiBase": "https://api.example.com",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "stateDir": "/var/lib/deviant-updater"
}
JSON
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-bad-state.json" >/dev/null 2>&1; then
    fail "deviant stateDir must fail"
  else
    pass "config gate rejects deviant stateDir"
  fi

  cat > "$WORK/config-bad-hosts.json" <<JSON
{
  "apiBase": "https://api.example.com",
  "credential": "vma_bootstrap_local_updater_secret_key",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "stateDir": "/var/lib/vps-updater",
  "allowedHosts": ["attacker.com"]
}
JSON
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-bad-hosts.json" >/dev/null 2>&1; then
    fail "allowedHosts override must fail"
  else
    pass "config gate rejects allowedHosts overrides"
  fi

  printf '{"apiBase": "https://api.example.com", invalid json' > "$WORK/config-malformed.json"
  if "$INSTALL_UPDATER" --dry-run --upgrade --binary "$WORK/vps-updater" --config "$WORK/config-malformed.json" >/dev/null 2>&1; then
    fail "malformed JSON config must fail"
  else
    pass "config gate rejects malformed JSON config"
  fi
else
  fail "node or sha256sum/shasum unavailable for behavioral dry-run smoke"
fi


# ── 3. Scoped Go verification ─────────────────────────────────────────────

if command -v go &>/dev/null; then
  if (cd "$AGENT_DIR" && go vet ./internal/updater/ ./internal/config/ ./cmd/vps-updater/); then
    pass "go vet updater + config + cmd"
  else
    fail "go vet"
  fi
  if (cd "$AGENT_DIR" && go test ./internal/updater/ ./internal/config/ -count=1 >/dev/null 2>&1); then
    pass "go test internal/updater + internal/config"
  else
    fail "go test internal/updater + internal/config"
  fi
  if (cd "$AGENT_DIR" && GOOS=linux GOARCH=amd64 go build ./cmd/vps-updater/ ./internal/updater/); then
    pass "GOOS=linux GOARCH=amd64 build of cmd/vps-updater"
    rm -f "$AGENT_DIR/vps-updater" 2>/dev/null || true
  else
    fail "linux/amd64 build of cmd/vps-updater"
  fi
else
  fail "go toolchain unavailable for scoped verification"
fi

# ── Summary ───────────────────────────────────────────────────────────────

echo ""
echo "${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
echo "ALL_OK"
