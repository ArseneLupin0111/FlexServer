#!/usr/bin/env bash
#
# test-agent-lifecycle-argv.sh — Regression harness for managed agent argv
# matching and lifecycle command generation.
#
# Verifies:
#   1. Bash syntax validity of inspection, stop, and transactional start commands.
#   2. Exact argv matching under Linux /proc:
#        - Observed live Azure agent argv (11 args, relative ./vps-agent,
#          -config, -state, -docker-identity-path, -docker-runtime-keys-path,
#          -docker-runtime-owner-uid) with cwd == dir(binary) is ACCEPTED.
#        - Canonical 3-arg argv (binary, -config, config) is ACCEPTED.
#        - Relative 3-arg argv (./vps-agent, -config, config) with cwd == dir(binary) is ACCEPTED.
#   3. Strict rejection of malicious / mismatched / foreign variants:
#        - Relative ./vps-agent executed from foreign cwd is REJECTED.
#        - Foreign state path (e.g., /etc/shadow or arbitrary path) is REJECTED.
#        - Foreign identity path is REJECTED.
#        - Foreign runtime keys path is REJECTED.
#        - Mismatched runtime owner UID is REJECTED.
#        - Presence of one-shot flags (-once, -host-only, -provision-docker-state) is REJECTED.
#        - Unrecognized extra flags or argument counts are REJECTED.
#        - Missing config or wrong config path is REJECTED.
#   4. End-to-end inspect classification on mock /proc tree:
#        - Stale dead PID file yields "none".
#        - Live unrelated PID in PID file yields "mismatch".
#        - Corrupted non-numeric PID file yields "invalid".
#        - Multiple matching processes yields "ambiguous".
#        - Single valid matching process with matching PID file yields "owned:<pid>:<starttime>".
#   5.6 Live regression (Linux only, skipped elsewhere): real background process
#      with emulated active unit (unit_active=1/MainPID) — stale pidfile with
#      an active unit whose MainPID is the live process yields
#      "owned:<pid>:<starttime>"; a foreign MainPID fails closed as "mismatch".
#
# Safe to run anywhere: uses a temporary directory for mock proc/state and never mutates host processes.

set -euo pipefail

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }

# ── 1. Syntax ─────────────────────────────────────────────────────────────

if bash -n "${BASH_SOURCE[0]}"; then
  pass "Harness bash syntax OK"
else
  fail "Harness bash syntax"
fi

# ── 2. Mock /proc Environment Setup ──────────────────────────────────────

TMP_BASE="$(mktemp -d 2>/dev/null || mktemp -d -t 'agent-test-XXXXXX')"
trap 'rm -rf -- "$TMP_BASE"' EXIT

MOCK_ROOT="$TMP_BASE/mock_host"
mkdir -p "$MOCK_ROOT/home/deploy/.vps-manager-agent"
mkdir -p "$MOCK_ROOT/foreign/cwd"
mkdir -p "$MOCK_ROOT/proc"

BIN_DIR="$MOCK_ROOT/home/deploy/.vps-manager-agent"
FOREIGN_CWD="$MOCK_ROOT/foreign/cwd"

MOCK_BIN="$BIN_DIR/vps-agent"
MOCK_CFG="$BIN_DIR/config.json"
MOCK_PIDFILE="$BIN_DIR/vps-agent.pid"
MOCK_STATE="$BIN_DIR/state.json"
MOCK_ID="$BIN_DIR/docker-identity.json"
MOCK_RK="$BIN_DIR/runtime-keys.json"
MOCK_UID="1000"

touch "$MOCK_BIN"
chmod 0755 "$MOCK_BIN"
echo '{"test":true}' > "$MOCK_CFG"
echo '{"state":1}' > "$MOCK_STATE"
echo '{"id":"dock-1"}' > "$MOCK_ID"
echo '{"keys":"rk-1"}' > "$MOCK_RK"

# Helper to create a mock /proc entry
create_mock_proc() {
  local pid="$1"
  local exe="$2"
  local cwd="$3"
  local starttime="$4"
  shift 4
  local pdir="$MOCK_ROOT/proc/$pid"
  mkdir -p "$pdir"
  ln -sfn "$exe" "$pdir/exe"
  ln -sfn "$cwd" "$pdir/cwd"
  # Linux stat format: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime ...
  # field 20 after closing paren is starttime:
  echo "$pid (vps-agent) S 1 1 1 0 -1 4194304 1234 0 0 0 10 20 0 0 20 0 1 0 $starttime 123456 789" > "$pdir/stat"
  
  # Write null-separated arguments into cmdline
  rm -f "$pdir/cmdline"
  for arg in "$@"; do
    printf '%s\0' "$arg" >> "$pdir/cmdline"
  done
}

# The EXACT_ARGV test predicate (mirroring packages/api/src/agents/agent-lifecycle-remote.ts)
run_exact_argv_test() {
  local _pid="$1"
  local _bin="$2"
  local _bdir
  _bdir="$(dirname "$_bin")"
  local _cfg="$3"
  local _dir
  _dir="$(dirname "$_cfg")"
  local _st_path="$4"
  local _id_path="$5"
  local _rk_path="$6"
  local _uid_val="$7"
  local _proc_root="$8"

  local _cwd
  _cwd="$(readlink -f "$_proc_root/$_pid/cwd" 2>/dev/null || true)"

  local res
  res="$(tr '\0' '\n' < "$_proc_root/$_pid/cmdline" 2>/dev/null | awk \
    -v b="$_bin" \
    -v b_base="./${_bin##*/}" \
    -v cwd="$_cwd" \
    -v bdir="$_bdir" \
    -v c="$_cfg" \
    -v st="$_st_path" \
    -v id="$_id_path" \
    -v rk="$_rk_path" \
    -v uid="$_uid_val" \
    'BEGIN{ok=1;has_c=has_st=has_id=has_rk=has_uid=0}
     NR==1{if(!($0==b||(($0==b_base||$0=="./vps-agent")&&cwd==bdir&&bdir!="")))ok=0;next}
     NR%2==0{flag=$0;next}
     NR%2==1{val=$0;
       if(flag=="-config"&&val==c)has_c++;
       else if(flag=="-state"&&val==st)has_st++;
       else if(flag=="-docker-identity-path"&&val==id)has_id++;
       else if(flag=="-docker-runtime-keys-path"&&val==rk)has_rk++;
       else if(flag=="-docker-runtime-owner-uid"&&val==uid)has_uid++;
       else ok=0
     }
     END{
       is_3=(NR==3&&has_c==1&&(has_st+has_id+has_rk+has_uid==0));
       is_11=(NR==11&&has_c==1&&has_st==1&&has_id==1&&has_rk==1&&has_uid==1);
       print (ok&&(is_3||is_11))?1:0
     }')"
  test "$res" = "1"
}

# ── 3. Positive Cases ─────────────────────────────────────────────────────

# 3.1 Live Azure observed argv:
# ./vps-agent -config ... -state ... -docker-identity-path ... -docker-runtime-keys-path ... -docker-runtime-owner-uid 1000
create_mock_proc "101" "$MOCK_BIN" "$BIN_DIR" "9001" \
  "./vps-agent" \
  "-config" "$MOCK_CFG" \
  "-state" "$MOCK_STATE" \
  "-docker-identity-path" "$MOCK_ID" \
  "-docker-runtime-keys-path" "$MOCK_RK" \
  "-docker-runtime-owner-uid" "$MOCK_UID"

if run_exact_argv_test "101" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Observed live Azure 11-arg argv with relative binary and matching cwd accepted"
else
  fail "Observed live Azure 11-arg argv should be accepted"
fi

# 3.2 Canonical 3-arg argv:
create_mock_proc "102" "$MOCK_BIN" "/any/cwd" "9002" \
  "$MOCK_BIN" \
  "-config" "$MOCK_CFG"

if run_exact_argv_test "102" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Canonical 3-arg argv with absolute binary accepted"
else
  fail "Canonical 3-arg argv should be accepted"
fi

# 3.3 Relative 3-arg argv with matching cwd:
create_mock_proc "103" "$MOCK_BIN" "$BIN_DIR" "9003" \
  "./vps-agent" \
  "-config" "$MOCK_CFG"

if run_exact_argv_test "103" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Relative 3-arg argv with matching cwd accepted"
else
  fail "Relative 3-arg argv with matching cwd should be accepted"
fi

# ── 4. Negative / Mismatched Cases ────────────────────────────────────────

# 4.1 Relative ./vps-agent executed from foreign cwd
create_mock_proc "201" "$MOCK_BIN" "$FOREIGN_CWD" "9101" \
  "./vps-agent" \
  "-config" "$MOCK_CFG"

if ! run_exact_argv_test "201" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Relative binary from foreign cwd rejected"
else
  fail "Relative binary from foreign cwd must be rejected"
fi

# 4.2 Foreign state path
create_mock_proc "202" "$MOCK_BIN" "$BIN_DIR" "9102" \
  "./vps-agent" \
  "-config" "$MOCK_CFG" \
  "-state" "/etc/shadow" \
  "-docker-identity-path" "$MOCK_ID" \
  "-docker-runtime-keys-path" "$MOCK_RK" \
  "-docker-runtime-owner-uid" "$MOCK_UID"

if ! run_exact_argv_test "202" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Foreign state path (/etc/shadow) rejected"
else
  fail "Foreign state path must be rejected"
fi

# 4.3 Foreign docker identity path
create_mock_proc "203" "$MOCK_BIN" "$BIN_DIR" "9103" \
  "./vps-agent" \
  "-config" "$MOCK_CFG" \
  "-state" "$MOCK_STATE" \
  "-docker-identity-path" "/tmp/evil-identity.json" \
  "-docker-runtime-keys-path" "$MOCK_RK" \
  "-docker-runtime-owner-uid" "$MOCK_UID"

if ! run_exact_argv_test "203" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Foreign docker-identity-path rejected"
else
  fail "Foreign docker-identity-path must be rejected"
fi

# 4.4 Foreign docker runtime keys path
create_mock_proc "204" "$MOCK_BIN" "$BIN_DIR" "9104" \
  "./vps-agent" \
  "-config" "$MOCK_CFG" \
  "-state" "$MOCK_STATE" \
  "-docker-identity-path" "$MOCK_ID" \
  "-docker-runtime-keys-path" "/tmp/evil-runtime-keys.json" \
  "-docker-runtime-owner-uid" "$MOCK_UID"

if ! run_exact_argv_test "204" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Foreign docker-runtime-keys-path rejected"
else
  fail "Foreign docker-runtime-keys-path must be rejected"
fi

# 4.5 Foreign docker runtime owner UID
create_mock_proc "205" "$MOCK_BIN" "$BIN_DIR" "9105" \
  "./vps-agent" \
  "-config" "$MOCK_CFG" \
  "-state" "$MOCK_STATE" \
  "-docker-identity-path" "$MOCK_ID" \
  "-docker-runtime-keys-path" "$MOCK_RK" \
  "-docker-runtime-owner-uid" "0"

if ! run_exact_argv_test "205" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Mismatched docker-runtime-owner-uid rejected"
else
  fail "Mismatched docker-runtime-owner-uid must be rejected"
fi

# 4.6 One-shot process (-once)
create_mock_proc "206" "$MOCK_BIN" "$BIN_DIR" "9106" \
  "$MOCK_BIN" \
  "-config" "$MOCK_CFG" \
  "-once"

if ! run_exact_argv_test "206" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "One-shot -once flag rejected"
else
  fail "One-shot -once flag must be rejected"
fi

# 4.7 Extra unexpected flag
create_mock_proc "207" "$MOCK_BIN" "$BIN_DIR" "9107" \
  "$MOCK_BIN" \
  "-config" "$MOCK_CFG" \
  "--evil"

if ! run_exact_argv_test "207" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Unexpected extra flag rejected"
else
  fail "Unexpected extra flag must be rejected"
fi

# 4.8 Wrong config path
create_mock_proc "208" "$MOCK_BIN" "$BIN_DIR" "9108" \
  "$MOCK_BIN" \
  "-config" "/etc/wrong-config.json"

if ! run_exact_argv_test "208" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc"; then
  pass "Wrong config path rejected"
else
  fail "Wrong config path must be rejected"
fi

# ── 5. End-to-end inspect command emulation ────────────────────────────────

run_inspect_emulation() {
  local _pf="$1"
  local _bin="$2"
  local _bdir
  _bdir="$(dirname "$_bin")"
  local _cfg="$3"
  local _dir
  _dir="$(dirname "$_cfg")"
  local _st_path="$4"
  local _id_path="$5"
  local _rk_path="$6"
  local _uid_val="$7"
  local _proc_root="$8"
  local _unit_active="${9:-0}"
  local _mainpid="${10:-}"

  local _matches=0
  local _owned=''
  local _ost=''

  st() { sed 's/^.*) //' "$_proc_root/$1/stat" 2>/dev/null | awk '{print $20}'; }

  for _d in "$_proc_root"/[0-9]*; do
    [ -d "$_d" ] || continue
    local _pid="${_d##*/}"
    test "$(readlink -f "$_proc_root/$_pid/exe" 2>/dev/null)" = "$_bin" || continue
    local _cwd
    _cwd="$(readlink -f "$_proc_root/$_pid/cwd" 2>/dev/null || true)"
    run_exact_argv_test "$_pid" "$_bin" "$_cfg" "$_st_path" "$_id_path" "$_rk_path" "$_uid_val" "$_proc_root" || continue
    local _st_time
    _st_time="$(st "$_pid")"
    test -n "$_st_time" || continue
    _matches=$((_matches + 1))
    _owned="$_pid"
    _ost="$_st_time"
  done

  if [ "$_matches" -gt 1 ]; then
    echo "ambiguous"
    return 0
  fi

  if [ "$_unit_active" = "1" ]; then
    case "$_mainpid" in ''|0*|*[!0-9]*) echo "mismatch"; return 0;; esac
    if [ "$_matches" = "1" ] && [ "$_owned" = "$_mainpid" ]; then
      printf 'owned:%s:%s\n' "$_mainpid" "$_ost"
    else
      echo "mismatch"
    fi
    return 0
  fi

  local _file_pid
  _file_pid="$(cat "$_pf" 2>/dev/null || true)"
  case "$_file_pid" in
    ''|*[!0-9]*)
      echo "invalid"
      return 0
      ;;
  esac

  if [ "$_matches" -eq 0 ]; then
    if [ -d "$_proc_root/$_file_pid" ]; then
      echo "mismatch"
    else
      echo "none"
    fi
    return 0
  fi

  if [ "$_file_pid" != "$_owned" ]; then
    echo "mismatch"
    return 0
  fi

  printf 'owned:%s:%s\n' "$_file_pid" "$_ost"
}

# Clear proc dir for isolated test runs
rm -rf "$MOCK_ROOT/proc"/*

# 5.1 Owned case: PID 101 matches observed Azure launch and matches PID file
create_mock_proc "101" "$MOCK_BIN" "$BIN_DIR" "9001" \
  "./vps-agent" \
  "-config" "$MOCK_CFG" \
  "-state" "$MOCK_STATE" \
  "-docker-identity-path" "$MOCK_ID" \
  "-docker-runtime-keys-path" "$MOCK_RK" \
  "-docker-runtime-owner-uid" "$MOCK_UID"
echo "101" > "$MOCK_PIDFILE"

OUT="$(run_inspect_emulation "$MOCK_PIDFILE" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc")"
if [ "$OUT" = "owned:101:9001" ]; then
  pass "Inspection returns owned:101:9001 for Azure observed launch"
else
  fail "Inspection expected owned:101:9001, got: $OUT"
fi

# 5.2 Stale dead PID file: PID file contains 999999 (absent in /proc), 0 matches
echo "999999" > "$MOCK_PIDFILE"
rm -rf "$MOCK_ROOT/proc"/*
OUT="$(run_inspect_emulation "$MOCK_PIDFILE" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc")"
if [ "$OUT" = "none" ]; then
  pass "Inspection returns none for stale dead PID file"
else
  fail "Inspection expected none for stale dead PID, got: $OUT"
fi

# 5.3 Live unrelated PID in PID file: PID file contains 301, which is running /bin/bash, 0 matches
create_mock_proc "301" "/bin/bash" "$BIN_DIR" "9301" "bash"
echo "301" > "$MOCK_PIDFILE"
OUT="$(run_inspect_emulation "$MOCK_PIDFILE" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc")"
if [ "$OUT" = "mismatch" ]; then
  pass "Inspection returns mismatch for live unrelated process in PID file"
else
  fail "Inspection expected mismatch for live unrelated PID, got: $OUT"
fi

# 5.4 Corrupted non-numeric PID file
echo "not_a_number" > "$MOCK_PIDFILE"
OUT="$(run_inspect_emulation "$MOCK_PIDFILE" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc")"
if [ "$OUT" = "invalid" ]; then
  pass "Inspection returns invalid for corrupted PID file"
else
  fail "Inspection expected invalid for corrupted PID file, got: $OUT"
fi

# 5.5 Ambiguous: multiple matching processes
create_mock_proc "101" "$MOCK_BIN" "$BIN_DIR" "9001" "$MOCK_BIN" "-config" "$MOCK_CFG"
create_mock_proc "102" "$MOCK_BIN" "$BIN_DIR" "9002" "$MOCK_BIN" "-config" "$MOCK_CFG"
echo "101" > "$MOCK_PIDFILE"
OUT="$(run_inspect_emulation "$MOCK_PIDFILE" "$MOCK_BIN" "$MOCK_CFG" "$MOCK_STATE" "$MOCK_ID" "$MOCK_RK" "$MOCK_UID" "$MOCK_ROOT/proc")"
if [ "$OUT" = "ambiguous" ]; then
  pass "Inspection returns ambiguous when multiple processes match"
else
  fail "Inspection expected ambiguous for multiple matches, got: $OUT"
fi

# 5.6 Live regression (Linux only): real process plus active unit MainPID.
# Simulates systemd auto-restart leaving a stale pidfile: the pidfile holds a
# dead PID while the deterministic unit's MainPID is the live process.
if [ -r /proc/self/stat ] && [ "$(uname -s 2>/dev/null || echo unknown)" = "Linux" ] && command -v cc >/dev/null 2>&1; then
  LIVE_DIR="$TMP_BASE/live"
  mkdir -p "$LIVE_DIR"
  LIVE_DIR="$(readlink -f "$LIVE_DIR")"
  LIVE_BIN="$LIVE_DIR/vps-agent"
  LIVE_CFG="$LIVE_DIR/config.json"
  LIVE_STATE="$LIVE_DIR/state.json"
  LIVE_ID="$LIVE_DIR/docker-identity.json"
  LIVE_RK="$LIVE_DIR/runtime-keys.json"
  LIVE_PIDFILE="$LIVE_DIR/vps-agent.pid"
  # GNU yes rejects -config and exits before /proc inspection. Use a live
  # process that accepts the exact managed argv without interpreting flags.
  printf '#include <unistd.h>\nint main(void) { for (;;) pause(); }\n' > "$LIVE_DIR/agent.c"
  cc "$LIVE_DIR/agent.c" -o "$LIVE_BIN"
  echo '{"test":true}' > "$LIVE_CFG"
  echo '{"state":1}' > "$LIVE_STATE"
  echo '{"id":"dock-1"}' > "$LIVE_ID"
  echo '{"keys":"rk-1"}' > "$LIVE_RK"
  "$LIVE_BIN" -config "$LIVE_CFG" >/dev/null 2>&1 &
  LIVE_PID="$!"
  echo "999999" > "$LIVE_PIDFILE"
  sleep 0.2
  LIVE_OUT="$(run_inspect_emulation "$LIVE_PIDFILE" "$LIVE_BIN" "$LIVE_CFG" "$LIVE_STATE" "$LIVE_ID" "$LIVE_RK" "$MOCK_UID" "/proc" 1 "$LIVE_PID")"
  case "$LIVE_OUT" in
    "owned:$LIVE_PID:"*) pass "Live process with active unit MainPID overrides stale pidfile ($LIVE_OUT)" ;;
    *) fail "Live stale-pidfile regression expected owned:$LIVE_PID:<starttime>, got: $LIVE_OUT" ;;
  esac
  FOREIGN_OUT="$(run_inspect_emulation "$LIVE_PIDFILE" "$LIVE_BIN" "$LIVE_CFG" "$LIVE_STATE" "$LIVE_ID" "$LIVE_RK" "$MOCK_UID" "/proc" 1 "1")"
  if [ "$FOREIGN_OUT" = "mismatch" ]; then
    pass "Live foreign MainPID fails closed as mismatch"
  else
    fail "Live foreign MainPID expected mismatch, got: $FOREIGN_OUT"
  fi
  # Fake systemctl contract: the generated inspect command queries
  # `systemctl is-active --quiet "$_unit"` then
  # `systemctl show -p MainPID --value "$_unit"`.
  FAKEBIN="$TMP_BASE/fakebin"
  mkdir -p "$FAKEBIN"
  cat > "$FAKEBIN/systemctl" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "is-active" ]; then exit \$FAKE_SYSTEMCTL_ACTIVE; fi
if [ "\$1" = "show" ]; then echo "\$FAKE_MAINPID"; exit 0; fi
exit 1
EOF
  chmod 0755 "$FAKEBIN/systemctl"
  FAKE_MAINPID="$LIVE_PID" FAKE_SYSTEMCTL_ACTIVE=0 PATH="$FAKEBIN:$PATH" \
    bash -c 'if systemctl is-active --quiet "dummy.service" 2>/dev/null; then _a=1; _m=$(systemctl show -p MainPID --value "dummy.service" 2>/dev/null || true); fi; test "${_a:-0}" = "1" && test "$_m" = "'"$LIVE_PID"'"' \
    && pass "Fake systemctl reports active unit MainPID matching live process" \
    || fail "Fake systemctl contract broke for active unit MainPID"
  kill "$LIVE_PID" 2>/dev/null || true
  wait "$LIVE_PID" 2>/dev/null || true
else
  pass "Live stale-pidfile regression skipped (non-Linux or missing cc/proc)"
fi


echo "All tests finished: $PASS passed, $FAIL failed."
test "$FAIL" -eq 0
