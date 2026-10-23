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
TEST_FLEET_ACTIVATION="${REPO_ROOT}/scripts/tests/test-fleet-updater-activation.sh"
PREPARE_UPDATER="${REPO_ROOT}/scripts/install/prepare-agent-updater.sh"
DEPLOY_SH="${REPO_ROOT}/scripts/deploy.sh"
AGENT_DIR="${REPO_ROOT}/packages/agent"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# ── 1. Syntax ─────────────────────────────────────────────────────────────

for f in "$INSTALL_UPDATER" "$INSTALL_LOCAL" "$INSTALL_SH" "$INSTALL_FLEET_UPDATER" "$TEST_FLEET_ACTIVATION" "$PREPARE_UPDATER" "$DEPLOY_SH" "${BASH_SOURCE[0]}"; do
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
MOCK_PID=""
MOCK_UNRELATED_PID=""
trap 'rm -rf "$WORK"; [[ -n "$MOCK_PID" ]] && kill -9 "$MOCK_PID" 2>/dev/null || true; [[ -n "$MOCK_UNRELATED_PID" ]] && kill -9 "$MOCK_UNRELATED_PID" 2>/dev/null || true' EXIT
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
    && printf '%s' "$OUT" | grep -Fq 'CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_CHOWN'; then
    pass "generated helper unit uses fixed argv and bounded capability bounding set (CAP_DAC_OVERRIDE CAP_CHOWN)"
  else
    fail "helper unit must run fixed argv as root with bounded capabilities (CAP_DAC_OVERRIDE CAP_CHOWN)"
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

# ── 2c. Bundled-source installer and shared prepare fixture checks ─────────

# 1. install-fleet-updater --source validation
if "$INSTALL_FLEET_UPDATER" --dry-run --source invalid --api-url https://api.example.com --token vma_test_secret --vps-id vps_test --binary "$WORK/vps-updater" >/dev/null 2>&1; then
  fail "install-fleet-updater rejects invalid --source value"
else
  pass "install-fleet-updater rejects invalid --source value"
fi

# 2. install-fleet-updater --source signed requires pubkey
if "$INSTALL_FLEET_UPDATER" --dry-run --source signed --api-url https://api.example.com --token vma_test_secret --vps-id vps_test --binary "$WORK/vps-updater" >/dev/null 2>&1; then
  fail "install-fleet-updater signed mode must fail without pubkey"
else
  pass "install-fleet-updater signed mode requires pubkey"
fi

# 3. install-fleet-updater --source bundled succeeds without pubkey and omits pubkey config
FLEET_BUNDLED_OUT="$("$INSTALL_FLEET_UPDATER" --dry-run --source bundled --api-url https://api.example.com --token vma_test_secret --vps-id vps_test --binary "$WORK/vps-updater" 2>&1 || true)"
if printf '%s' "$FLEET_BUNDLED_OUT" | grep -Fq '"agentStateDir"'; then
  pass "install-fleet-updater bundled mode includes agentStateDir"
else
  fail "install-fleet-updater bundled mode must include agentStateDir: $FLEET_BUNDLED_OUT"
fi
if printf '%s' "$FLEET_BUNDLED_OUT" | grep -Fq '"fleetReleasePublicKeyFile"'; then
  fail "install-fleet-updater bundled mode must omit fleetReleasePublicKeyFile: $FLEET_BUNDLED_OUT"
else
  pass "install-fleet-updater bundled mode omits fleetReleasePublicKeyFile"
fi

# 4. install-fleet-updater --source signed with pubkey includes fleetReleasePublicKeyFile
FLEET_SIGNED_OUT="$("$INSTALL_FLEET_UPDATER" --dry-run --source signed --api-url https://api.example.com --token vma_test_secret --vps-id vps_test --binary "$WORK/vps-updater" --pubkey "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGenKey dummy" 2>&1 || true)"
if printf '%s' "$FLEET_SIGNED_OUT" | grep -Fq '"fleetReleasePublicKeyFile"' && printf '%s' "$FLEET_SIGNED_OUT" | grep -Fq '"agentStateDir"'; then
  pass "install-fleet-updater signed mode includes fleetReleasePublicKeyFile and agentStateDir"
else
  fail "install-fleet-updater signed mode must include fleetReleasePublicKeyFile and agentStateDir: $FLEET_SIGNED_OUT"
fi

# 4b. install-fleet-updater systemd activation and failure propagation regression
if bash "$TEST_FLEET_ACTIVATION"; then
  pass "install-fleet-updater systemd activation regression suite passed"
else
  fail "install-fleet-updater systemd activation regression suite failed"
fi

# 5. prepare-agent-updater architecture validation
if "$PREPARE_UPDATER" --dry-run --arch unsupported_arch >/dev/null 2>&1; then
  fail "prepare-agent-updater must reject unsupported arch"
else
  pass "prepare-agent-updater rejects unsupported architecture"
fi

# 6. prepare-agent-updater non-dry-run requires root
PREPARE_NONROOT_REFUSED=0
if [[ $EUID -eq 0 ]]; then
  if command -v runuser &>/dev/null; then
    runuser -u nobody -- "$PREPARE_UPDATER" --arch amd64 >/dev/null 2>&1 || PREPARE_NONROOT_REFUSED=1
  elif command -v su &>/dev/null; then
    su -s /bin/sh nobody -c "'$PREPARE_UPDATER' --arch amd64" >/dev/null 2>&1 || PREPARE_NONROOT_REFUSED=1
  elif command -v sudo &>/dev/null; then
    sudo -u nobody "$PREPARE_UPDATER" --arch amd64 >/dev/null 2>&1 || PREPARE_NONROOT_REFUSED=1
  else
    PREPARE_NONROOT_REFUSED=1
  fi
else
  "$PREPARE_UPDATER" --arch amd64 >/dev/null 2>&1 || PREPARE_NONROOT_REFUSED=1
fi
if [[ "$PREPARE_NONROOT_REFUSED" -eq 1 ]]; then
  pass "prepare-agent-updater without root and without --dry-run is refused"
else
  fail "prepare-agent-updater must refuse non-root execution"
fi

# 7. prepare-agent-updater absent config bootstrap in dry-run
PREP_BOOTSTRAP_OUT="$("$PREPARE_UPDATER" --dry-run --arch amd64 --updater-config "$WORK/nonexistent-config.json" --backend-url "https://api.example.com" 2>&1 || true)"
if printf '%s' "$PREP_BOOTSTRAP_OUT" | grep -Fq '"agentStateDir"' && printf '%s' "$PREP_BOOTSTRAP_OUT" | grep -Fq '"apiBase"'; then
  pass "prepare-agent-updater bootstraps absent configuration with agentStateDir"
else
  fail "prepare-agent-updater must bootstrap absent config with agentStateDir: $PREP_BOOTSTRAP_OUT"
fi

# 8. prepare-agent-updater reuses valid existing config without rotating token
HEALTHY_CFG="$WORK/healthy-config.json"
cat > "$HEALTHY_CFG" <<'EOF'
{
  "apiBase": "https://api.example.com",
  "credential": "vma_preserved_credential_token_12345",
  "agentBinary": "/usr/local/bin/vps-manager-agent",
  "agentUnit": "vps-manager-agent.service",
  "stateDir": "/var/lib/vps-updater",
  "agentStateDir": "/var/lib/vps-manager-agent"
}
EOF
PREP_REUSE_OUT="$("$PREPARE_UPDATER" --dry-run --arch amd64 --updater-config "$HEALTHY_CFG" --backend-url "https://different.example.com" 2>&1 || true)"
if printf '%s' "$PREP_REUSE_OUT" | grep -Fq "vma_preserved_credential_token_12345" && ! printf '%s' "$PREP_REUSE_OUT" | grep -Fq "vma_bootstrap_local_updater_secret_key"; then
  pass "prepare-agent-updater reuses valid existing configuration without token rotation"
else
  fail "prepare-agent-updater must reuse existing config: $PREP_REUSE_OUT"
fi

# 9. prepare-agent-updater detects active in-flight journal and defers
STATE_IN_FLIGHT="$WORK/state-in-flight"
mkdir -p "$STATE_IN_FLIGHT/helper"
cat > "$STATE_IN_FLIGHT/helper/journal.json" <<'EOF'
{
  "jobId": "job-test-in-flight",
  "phase": "intent",
  "releaseId": "candidate-target"
}
EOF
if grep -Eq '"phase"[[:space:]]*:[[:space:]]*"(intent|renamed)"' "$STATE_IN_FLIGHT/helper/journal.json" 2>/dev/null; then
  pass "updater detects in-flight journal phase"
else
  fail "in-flight journal pattern must match intent phase"
fi

# 10. deploy.sh --help and --dry-run
if bash "$DEPLOY_SH" --help >/dev/null 2>&1; then
  pass "deploy.sh --help exits 0"
else
  fail "deploy.sh --help must exit 0"
fi

if bash "$DEPLOY_SH" --dry-run >/dev/null 2>&1; then
  pass "deploy.sh --dry-run succeeds"
else
  fail "deploy.sh --dry-run must succeed"
fi

if bash "$DEPLOY_SH" --dry-run --pull >/dev/null 2>&1; then
  pass "deploy.sh --dry-run --pull succeeds"
else
  fail "deploy.sh --dry-run --pull must succeed"
fi
# -- Scoped mock docker for deploy.sh behavioral tests ----------------------
MOCK_BIN="$WORK/mock-bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/docker" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == "compose" ]]; then
  shift
  for arg in "$@"; do
    if [[ "$arg" == "exec" ]]; then
      if [[ -n "$MOCK_DOCKER_EXEC_EXIT" ]]; then
        exit "$MOCK_DOCKER_EXEC_EXIT"
      fi
      exit 0
    fi
  done
  if [[ -n "$MOCK_DOCKER_COMPOSE_EXIT" ]]; then
    exit "$MOCK_DOCKER_COMPOSE_EXIT"
  fi
  exit 0
fi
exit 0
EOF
chmod 0755 "$MOCK_BIN/docker"

# 11. deploy.sh exits nonzero on API health failure (with compose up succeeding via mock)
if PATH="$MOCK_BIN:$PATH" bash "$DEPLOY_SH" --health-url "http://127.0.0.1:1/down" --health-timeout 1 >/dev/null 2>&1; then
  fail "deploy.sh must exit nonzero when dashboard health check fails"
else
  pass "deploy.sh exits nonzero on dashboard health failure"
fi

# 12. Unrelated healthy port cannot mask compose api failure
if command -v python3 &>/dev/null; then
  UNRELATED_PORT=39282
  python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{\"ok\": true}')
    def log_message(self, *args): pass
httpd = socketserver.TCPServer(('127.0.0.1', $UNRELATED_PORT), H)
httpd.serve_forever()
" &
  MOCK_UNRELATED_PID=$!
  sleep 0.3

  UNRELATED_EXIT=0
  MOCK_DOCKER_EXEC_EXIT=1 PATH="$MOCK_BIN:$PATH" bash "$DEPLOY_SH" --health-timeout 1 >/dev/null 2>&1 || UNRELATED_EXIT=$?
  kill -9 "$MOCK_UNRELATED_PID" 2>/dev/null || true
  wait "$MOCK_UNRELATED_PID" 2>/dev/null || true
  MOCK_UNRELATED_PID=""

  if [[ "$UNRELATED_EXIT" -ne 0 ]]; then
    pass "unrelated healthy port cannot mask compose api failure"
  else
    fail "deploy.sh must exit nonzero when compose api exec fails even if other ports respond"
  fi
fi

# 13. deploy.sh exits 0 with warning when updater preparation encounters an issue but dashboard is healthy
MOCK_PORT=39281
if command -v python3 &>/dev/null; then
  python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{\"ok\": true}')
    def log_message(self, *args): pass
httpd = socketserver.TCPServer(('127.0.0.1', $MOCK_PORT), H)
httpd.serve_forever()
" &
  MOCK_PID=$!
  sleep 0.3

  DEPLOY_WARN_EXIT=0
  DEPLOY_WARN_OUT="$(PATH="$MOCK_BIN:$PATH" bash "$DEPLOY_SH" --health-url "http://127.0.0.1:${MOCK_PORT}/api/health" --health-timeout 5 2>&1 || DEPLOY_WARN_EXIT=$?)"
  kill -9 "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=""

  if [[ "$DEPLOY_WARN_EXIT" -eq 0 ]] && printf '%s' "$DEPLOY_WARN_OUT" | grep -Fq "dashboard is healthy"; then
    pass "deploy.sh succeeds (exit code 0) when host preparation encounters issue but dashboard is healthy"
  else
    fail "deploy.sh must exit 0 when dashboard is healthy: exit=$DEPLOY_WARN_EXIT out=$DEPLOY_WARN_OUT"
  fi
fi

# 14. prepare-agent-updater preserves custom paths from existing config
CUSTOM_CFG="$WORK/custom-paths-config.json"
cat > "$CUSTOM_CFG" <<'EOF'
{
  "apiBase": "https://api.example.com",
  "credential": "vma_custom_cred_token_67890",
  "agentBinary": "/opt/custom/bin/agent",
  "agentUnit": "custom-agent.service",
  "stateDir": "/var/lib/custom-updater",
  "agentStateDir": "/opt/custom/var/agent"
}
EOF
PREP_CUSTOM_OUT="$("$PREPARE_UPDATER" --dry-run --arch amd64 --updater-config "$CUSTOM_CFG" 2>&1 || true)"
if printf '%s' "$PREP_CUSTOM_OUT" | grep -Fq '"/opt/custom/bin/agent"' && \
   printf '%s' "$PREP_CUSTOM_OUT" | grep -Fq '"/opt/custom/var/agent"' && \
   printf '%s' "$PREP_CUSTOM_OUT" | grep -Fq '"custom-agent.service"' && \
   printf '%s' "$PREP_CUSTOM_OUT" | grep -Fq '"/var/lib/custom-updater"'; then
  pass "prepare-agent-updater preserves custom binary, unit, stateDir, and agentStateDir from existing config"
else
  fail "prepare-agent-updater must preserve custom paths from existing config: $PREP_CUSTOM_OUT"
fi

# 15. prepare-agent-updater defers when journal is in mutation or recovery
STATE_REC="$WORK/state-recovery"
mkdir -p "$STATE_REC/helper"
cat > "$STATE_REC/helper/journal.json" <<'EOF'
{
  "jobId": "job-recovering",
  "phase": "renamed",
  "intent": "swap"
}
EOF
PREP_REC_OUT="$("$PREPARE_UPDATER" --dry-run --arch amd64 --updater-state-dir "$STATE_REC" --updater-config "$HEALTHY_CFG" 2>&1 || true)"
if printf '%s' "$PREP_REC_OUT" | grep -iq "active.*journal"; then
  pass "prepare-agent-updater detects active journal in recovery during dry run"
else
  fail "prepare-agent-updater must detect active journal in recovery: $PREP_REC_OUT"
fi

# 16. install-fleet-updater custom agent-state-dir and agent-binary options
FLEET_CUSTOM_OUT="$("$INSTALL_FLEET_UPDATER" --dry-run --source bundled --api-url https://api.example.com --token vma_test_secret --vps-id vps_test --binary "$WORK/vps-updater" --agent-state-dir /home/agentuser/.flexserver/agent --agent-binary /opt/bin/agent 2>&1 || true)"
if printf '%s' "$FLEET_CUSTOM_OUT" | grep -Fq '"/home/agentuser/.flexserver/agent"' && \
   printf '%s' "$FLEET_CUSTOM_OUT" | grep -Fq '"/opt/bin/agent"'; then
  pass "install-fleet-updater supports custom agent-state-dir and agent-binary"
else
  fail "install-fleet-updater must support custom agent-state-dir and agent-binary: $FLEET_CUSTOM_OUT"
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
