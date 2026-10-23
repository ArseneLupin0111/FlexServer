#!/usr/bin/env bash
#
# test-fleet-updater-activation.sh — Behavioral regression for install-fleet-updater.sh
# systemd availability handling (including degraded state) and failure propagation.
#
# Verifies:
#   1. Systemd availability detection treats 'degraded' (is-system-running exit 1)
#      as operational systemd, invoking daemon-reload, enable, and restart.
#   2. Activation failure propagation: failures during systemctl enable, restart,
#      or daemon-reload are not masked and cause the installer to exit non-zero
#      without falsely reporting success.
#   3. Token cleanup: credential files are cleaned up on activation failures.
#   4. Clean fallback: when systemctl reports 'offline', activation is skipped
#      cleanly with exit code 0.
#   5. --skip-systemd and --dry-run preserve non-activation behavior.
#   6. Generated helper unit bounds capabilities (CAP_DAC_OVERRIDE CAP_CHOWN)
#      and mounts legacy user-home agent paths in ReadWritePaths.
#
# Safe to run anywhere: uses isolated temporary directories and disposable fixtures
# without touching host systemd or requiring real root privileges.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_FLEET_UPDATER="${REPO_ROOT}/scripts/install/install-fleet-updater.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"

SYSTEMCTL_LOG="$WORK/systemctl.log"

# Disposable id stub: report root (0) for -u
cat > "$FAKEBIN/id" <<'EOF'
#!/bin/sh
if [ "$1" = "-u" ]; then
  echo 0
  exit 0
fi
REAL_ID="$(command -v id 2>/dev/null || true)"
if [ -n "$REAL_ID" ] && [ "$REAL_ID" != "$0" ]; then
  exec "$REAL_ID" "$@"
fi
exit 0
EOF
chmod +x "$FAKEBIN/id"

# Disposable getent stub: report vps-updater exists, vps-manager-agent absent
cat > "$FAKEBIN/getent" <<'EOF'
#!/bin/sh
if [ "$1" = "group" ] && [ "$2" = "vps-updater" ]; then
  echo "vps-updater:x:999:"
  exit 0
fi
if [ "$1" = "passwd" ] && [ "$2" = "vps-updater" ]; then
  echo "vps-updater:x:999:999::/nonexistent:/sbin/nologin"
  exit 0
fi
if [ "$2" = "vps-manager-agent" ]; then
  exit 1
fi
REAL_GETENT="$(command -v getent 2>/dev/null || true)"
if [ -n "$REAL_GETENT" ] && [ "$REAL_GETENT" != "$0" ]; then
  exec "$REAL_GETENT" "$@"
fi
exit 1
EOF
chmod +x "$FAKEBIN/getent"

# Disposable chown stub: no-op in test sandbox
cat > "$FAKEBIN/chown" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$FAKEBIN/chown"

# Disposable systemctl fixture:
# Supports simulating degraded systemd (is-system-running prints degraded and exits 1),
# offline state, and selective step failures.
cat > "$FAKEBIN/systemctl" <<'EOF'
#!/bin/sh
cmd="$1"
shift || true

if [ "$cmd" = "is-system-running" ]; then
  if [ "${FAKE_SYSTEMCTL_OFFLINE:-0}" = "1" ]; then
    echo "offline"
    exit 1
  fi
  # Real systemd in degraded state outputs "degraded" and exits 1
  echo "degraded"
  exit 1
fi

if [ -n "${SYSTEMCTL_LOG:-}" ]; then
  echo "$cmd $*" >> "$SYSTEMCTL_LOG"
fi

case "$cmd" in
  daemon-reload)
    if [ "${FAKE_SYSTEMCTL_FAIL_DAEMON_RELOAD:-0}" = "1" ]; then
      echo "Failed to reload systemd daemon: connection refused" >&2
      exit 1
    fi
    exit 0
    ;;
  enable)
    if [ "${FAKE_SYSTEMCTL_FAIL_ENABLE:-0}" = "1" ]; then
      echo "Failed to enable unit: Unit file invalid" >&2
      exit 1
    fi
    exit 0
    ;;
  restart)
    case "$1" in
      vps-updater-apply.path)
        if [ "${FAKE_SYSTEMCTL_FAIL_RESTART_PATH:-0}" = "1" ]; then
          echo "Failed to restart vps-updater-apply.path: Unit not found" >&2
          exit 1
        fi
        ;;
      vps-updater.service)
        if [ "${FAKE_SYSTEMCTL_FAIL_RESTART_SERVICE:-0}" = "1" ]; then
          echo "Failed to restart vps-updater.service: Process exited with status 1" >&2
          exit 1
        fi
        ;;
    esac
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$FAKEBIN/systemctl"

# Create a dummy updater binary
STUB_BIN="$WORK/vps-updater-stub"
printf '#!/bin/sh\necho 1.0.0+test\n' > "$STUB_BIN"
chmod 755 "$STUB_BIN"

run_installer() {
  local test_env_dir="$1"
  shift
  mkdir -p "$test_env_dir/dest" "$test_env_dir/etc/vps-updater" "$test_env_dir/units" "$test_env_dir/bin" "$test_env_dir/state" "$test_env_dir/agent-state"
  
  env \
    PATH="$FAKEBIN:$PATH" \
    SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
    SYSTEMD_UNIT_DIR="$test_env_dir/units" \
    FLEET_UPDATER_SYMLINK_PATH="$test_env_dir/bin/vps-updater" \
    "$@" \
    bash "$INSTALL_FLEET_UPDATER" \
      --source bundled \
      --api-url "https://api.example.com" \
      --token "vma_test_secret_credential" \
      --vps-id "vps_test_host" \
      --binary "$STUB_BIN" \
      --dest "$test_env_dir/dest/vps-updater" \
      --config-dest "$test_env_dir/etc/vps-updater/config.json" \
      --key-dest "$test_env_dir/etc/vps-updater/fleet-release.pub" \
      --state-dir "$test_env_dir/state" \
      --agent-state-dir "$test_env_dir/agent-state" \
      --agent-binary "$test_env_dir/bin/vps-manager-agent"
}

# ── 1. Degraded systemd invokes daemon-reload, enable, and restart ─────────────
rm -f "$SYSTEMCTL_LOG"
TEST1_DIR="$WORK/test1"
set +e
TEST1_OUT="$(run_installer "$TEST1_DIR" 2>&1)"
TEST1_EXIT=$?
set -e

if [ "$TEST1_EXIT" -eq 0 ] && \
   grep -Fq "daemon-reload" "$SYSTEMCTL_LOG" 2>/dev/null && \
   grep -Fq "enable vps-updater-apply.path vps-updater.service" "$SYSTEMCTL_LOG" 2>/dev/null && \
   grep -Fq "restart vps-updater-apply.path" "$SYSTEMCTL_LOG" 2>/dev/null && \
   grep -Fq "restart vps-updater.service" "$SYSTEMCTL_LOG" 2>/dev/null && \
   printf '%s' "$TEST1_OUT" | grep -Fq "[Install] Done. Fleet updater installed"; then
  pass "degraded systemd state invokes daemon-reload, enable, and restart services"
else
  fail "degraded systemd state must invoke activation (exit: $TEST1_EXIT, log: $(cat "$SYSTEMCTL_LOG" 2>/dev/null || echo '<none>'), out: $TEST1_OUT)"
fi

# ── 2. systemctl enable failure propagates non-zero and suppresses success ────
rm -f "$SYSTEMCTL_LOG"
TEST2_DIR="$WORK/test2"
set +e
TEST2_OUT="$(run_installer "$TEST2_DIR" env FAKE_SYSTEMCTL_FAIL_ENABLE=1 2>&1)"
TEST2_EXIT=$?
set -e

if [ "$TEST2_EXIT" -ne 0 ] && ! printf '%s' "$TEST2_OUT" | grep -Fq "[Install] Done. Fleet updater installed"; then
  pass "systemctl enable failure propagates non-zero exit and does not report success"
else
  fail "systemctl enable failure must fail non-zero without reporting success (exit: $TEST2_EXIT, out: $TEST2_OUT)"
fi

# ── 3. systemctl restart vps-updater.service failure propagates non-zero ──────
rm -f "$SYSTEMCTL_LOG"
TEST3_DIR="$WORK/test3"
set +e
TEST3_OUT="$(run_installer "$TEST3_DIR" env FAKE_SYSTEMCTL_FAIL_RESTART_SERVICE=1 2>&1)"
TEST3_EXIT=$?
set -e

if [ "$TEST3_EXIT" -ne 0 ] && ! printf '%s' "$TEST3_OUT" | grep -Fq "[Install] Done. Fleet updater installed"; then
  pass "systemctl restart vps-updater.service failure propagates non-zero exit and does not report success"
else
  fail "systemctl restart vps-updater.service failure must fail non-zero without reporting success (exit: $TEST3_EXIT, out: $TEST3_OUT)"
fi

# ── 4. systemctl restart vps-updater-apply.path failure propagates non-zero ───
rm -f "$SYSTEMCTL_LOG"
TEST4_DIR="$WORK/test4"
set +e
TEST4_OUT="$(run_installer "$TEST4_DIR" env FAKE_SYSTEMCTL_FAIL_RESTART_PATH=1 2>&1)"
TEST4_EXIT=$?
set -e

if [ "$TEST4_EXIT" -ne 0 ] && ! printf '%s' "$TEST4_OUT" | grep -Fq "[Install] Done. Fleet updater installed"; then
  pass "systemctl restart vps-updater-apply.path failure propagates non-zero exit and does not report success"
else
  fail "systemctl restart vps-updater-apply.path failure must fail non-zero without reporting success (exit: $TEST4_EXIT, out: $TEST4_OUT)"
fi

# ── 5. systemctl daemon-reload failure propagates non-zero ───────────────────
rm -f "$SYSTEMCTL_LOG"
TEST5_DIR="$WORK/test5"
set +e
TEST5_OUT="$(run_installer "$TEST5_DIR" env FAKE_SYSTEMCTL_FAIL_DAEMON_RELOAD=1 2>&1)"
TEST5_EXIT=$?
set -e

if [ "$TEST5_EXIT" -ne 0 ] && ! printf '%s' "$TEST5_OUT" | grep -Fq "[Install] Done. Fleet updater installed"; then
  pass "systemctl daemon-reload failure propagates non-zero exit and does not report success"
else
  fail "systemctl daemon-reload failure must fail non-zero without reporting success (exit: $TEST5_EXIT, out: $TEST5_OUT)"
fi

# ── 6. Token file cleaned up on activation failure ───────────────────────────
rm -f "$SYSTEMCTL_LOG"
TEST6_DIR="$WORK/test6"
mkdir -p "$TEST6_DIR"
TEST6_TOKEN="$TEST6_DIR/test-token.txt"
printf "vma_ephemeral_token_value" > "$TEST6_TOKEN"
set +e
TEST6_OUT="$(
  env \
    PATH="$FAKEBIN:$PATH" \
    SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
    SYSTEMD_UNIT_DIR="$TEST6_DIR/units" \
    FLEET_UPDATER_SYMLINK_PATH="$TEST6_DIR/bin/vps-updater" \
    FAKE_SYSTEMCTL_FAIL_RESTART_SERVICE=1 \
    bash "$INSTALL_FLEET_UPDATER" \
      --source bundled \
      --api-url "https://api.example.com" \
      --token-file "$TEST6_TOKEN" \
      --vps-id "vps_test_host" \
      --binary "$STUB_BIN" \
      --dest "$TEST6_DIR/dest/vps-updater" \
      --config-dest "$TEST6_DIR/etc/vps-updater/config.json" \
      --key-dest "$TEST6_DIR/etc/vps-updater/fleet-release.pub" \
      --state-dir "$TEST6_DIR/state" \
      --agent-state-dir "$TEST6_DIR/agent-state" \
      --agent-binary "$TEST6_DIR/bin/vps-manager-agent" 2>&1
)"
TEST6_EXIT=$?
set -e

if [ "$TEST6_EXIT" -ne 0 ] && [ ! -f "$TEST6_TOKEN" ]; then
  pass "token file is removed on activation failure"
else
  fail "token file must be removed on activation failure (exit: $TEST6_EXIT, exists: $([ -f "$TEST6_TOKEN" ] && echo yes || echo no))"
fi

# ── 7. Offline systemd falls back cleanly without error ───────────────────────
rm -f "$SYSTEMCTL_LOG"
TEST7_DIR="$WORK/test7"
set +e
TEST7_OUT="$(run_installer "$TEST7_DIR" env FAKE_SYSTEMCTL_OFFLINE=1 2>&1)"
TEST7_EXIT=$?
set -e

if [ "$TEST7_EXIT" -eq 0 ] && \
   printf '%s' "$TEST7_OUT" | grep -Fq "[Install] Systemd not active in environment; skipping systemctl enable." && \
   printf '%s' "$TEST7_OUT" | grep -Fq "[Install] Done. Fleet updater installed" && \
   [ ! -s "$SYSTEMCTL_LOG" ]; then
  pass "offline systemd falls back cleanly without calling activation"
else
  fail "offline systemd must fall back cleanly (exit: $TEST7_EXIT, out: $TEST7_OUT, log: $(cat "$SYSTEMCTL_LOG" 2>/dev/null || echo '<empty>'))"
fi

# ── 8. --skip-systemd skips activation completely ────────────────────────────
rm -f "$SYSTEMCTL_LOG"
TEST8_DIR="$WORK/test8"
mkdir -p "$TEST8_DIR/dest" "$TEST8_DIR/etc/vps-updater" "$TEST8_DIR/units" "$TEST8_DIR/bin" "$TEST8_DIR/state" "$TEST8_DIR/agent-state"
set +e
TEST8_OUT="$(
  env \
    PATH="$FAKEBIN:$PATH" \
    SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
    SYSTEMD_UNIT_DIR="$TEST8_DIR/units" \
    FLEET_UPDATER_SYMLINK_PATH="$TEST8_DIR/bin/vps-updater" \
    bash "$INSTALL_FLEET_UPDATER" \
      --skip-systemd \
      --source bundled \
      --api-url "https://api.example.com" \
      --token "vma_test_secret" \
      --vps-id "vps_test_host" \
      --binary "$STUB_BIN" \
      --dest "$TEST8_DIR/dest/vps-updater" \
      --config-dest "$TEST8_DIR/etc/vps-updater/config.json" \
      --key-dest "$TEST8_DIR/etc/vps-updater/fleet-release.pub" \
      --state-dir "$TEST8_DIR/state" \
      --agent-state-dir "$TEST8_DIR/agent-state" \
      --agent-binary "$TEST8_DIR/bin/vps-manager-agent" 2>&1
)"
TEST8_EXIT=$?
set -e

if [ "$TEST8_EXIT" -eq 0 ] && \
   ! printf '%s' "$TEST8_OUT" | grep -Fq "[Install] Reloading systemd" && \
   printf '%s' "$TEST8_OUT" | grep -Fq "[Install] Done. Fleet updater installed" && \
   [ ! -s "$SYSTEMCTL_LOG" ]; then
  pass "--skip-systemd cleanly bypasses activation"
else
  fail "--skip-systemd must cleanly bypass activation (exit: $TEST8_EXIT, out: $TEST8_OUT)"
fi

# ── 9. --dry-run produces no filesystem writes and no activation ─────────────
rm -f "$SYSTEMCTL_LOG"
TEST9_DIR="$WORK/test9"
mkdir -p "$TEST9_DIR/dest" "$TEST9_DIR/etc/vps-updater" "$TEST9_DIR/units" "$TEST9_DIR/bin" "$TEST9_DIR/state" "$TEST9_DIR/agent-state"
set +e
TEST9_OUT="$(
  env \
    PATH="$FAKEBIN:$PATH" \
    SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
    SYSTEMD_UNIT_DIR="$TEST9_DIR/units" \
    FLEET_UPDATER_SYMLINK_PATH="$TEST9_DIR/bin/vps-updater" \
    bash "$INSTALL_FLEET_UPDATER" \
      --dry-run \
      --source bundled \
      --api-url "https://api.example.com" \
      --token "vma_test_secret" \
      --vps-id "vps_test_host" \
      --binary "$STUB_BIN" \
      --dest "$TEST9_DIR/dest/vps-updater" \
      --config-dest "$TEST9_DIR/etc/vps-updater/config.json" \
      --key-dest "$TEST9_DIR/etc/vps-updater/fleet-release.pub" \
      --state-dir "$TEST9_DIR/state" \
      --agent-state-dir "$TEST9_DIR/agent-state" \
      --agent-binary "$TEST9_DIR/bin/vps-manager-agent" 2>&1
)"
TEST9_EXIT=$?
set -e

if [ "$TEST9_EXIT" -eq 0 ] && \
   printf '%s' "$TEST9_OUT" | grep -Fq "[DRY-RUN]" && \
   [ ! -s "$SYSTEMCTL_LOG" ] && \
   [ ! -f "$TEST9_DIR/units/vps-updater.service" ]; then
  pass "--dry-run performs no unit writes and no activation"
else
  fail "--dry-run must perform no unit writes or activation (exit: $TEST9_EXIT, out: $TEST9_OUT)"
fi

# ── 10. Helper unit bounds capabilities and configures legacy user binary path 
rm -f "$SYSTEMCTL_LOG"
TEST10_DIR="$WORK/test10"
set +e
TEST10_OUT="$(
  env \
    PATH="$FAKEBIN:$PATH" \
    SYSTEMCTL_LOG="$SYSTEMCTL_LOG" \
    SYSTEMD_UNIT_DIR="$TEST10_DIR/units" \
    FLEET_UPDATER_SYMLINK_PATH="$TEST10_DIR/bin/vps-updater" \
    bash "$INSTALL_FLEET_UPDATER" \
      --source bundled \
      --api-url "https://api.example.com" \
      --token "vma_test_secret_credential" \
      --vps-id "vps_test_host" \
      --binary "$STUB_BIN" \
      --dest "$TEST10_DIR/dest/vps-updater" \
      --config-dest "$TEST10_DIR/etc/vps-updater/config.json" \
      --key-dest "$TEST10_DIR/etc/vps-updater/fleet-release.pub" \
      --state-dir "$TEST10_DIR/state" \
      --agent-state-dir "$TEST10_DIR/agent-state" \
      --agent-binary "/home/legacyuser/.vps-manager-agent/vps-manager-agent" 2>&1
)"
TEST10_EXIT=$?
set -e

HELPER_UNIT="$TEST10_DIR/units/vps-updater-apply.service"
if [ "$TEST10_EXIT" -eq 0 ] && \
   [ -f "$HELPER_UNIT" ] && \
   grep -Fq "CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_CHOWN" "$HELPER_UNIT" && \
   grep -Fq "/home/legacyuser/.vps-manager-agent" "$HELPER_UNIT" && \
   grep -Fq "ProtectHome=read-only" "$HELPER_UNIT" && \
   grep -Fq "AmbientCapabilities=" "$HELPER_UNIT"; then
  pass "helper unit bounds capabilities (CAP_DAC_OVERRIDE CAP_CHOWN) and mounts legacy user binary directory in ReadWritePaths"
else
  fail "helper unit must bound capabilities and mount legacy user binary dir in ReadWritePaths (exit: $TEST10_EXIT, unit: $(cat "$HELPER_UNIT" 2>/dev/null || echo '<none>'))"
fi

echo "All tests finished: $PASS passed, $FAIL failed."
test "$FAIL" -eq 0
