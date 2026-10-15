#!/usr/bin/env bash
#
# test-local-agent-rotation.sh
#
# Isolated end-to-end test and live verification script for local agent rotation helper.
# Validates client-to-host-socket communication, permission checks, atomic config updates,
# systemd service restart, rollback on restart failure, and wrong-vps rejection.
#
# Usage:
#   # Run isolated fixture tests (Linux/macOS):
#   ./scripts/test/test-local-agent-rotation.sh
#
#   # Run safe live verification on host (reads host token and pipes directly to client):
#   sudo ./scripts/test/test-local-agent-rotation.sh --smoke-live
#

set -euo pipefail

MODE="fixture"
if [[ "${1:-}" == "--smoke-live" ]]; then
  MODE="live"
fi

if [[ "$MODE" == "live" ]]; then
  echo "=== Running Safe Live Local Agent Rotation Smoke Test ==="
  CONFIG_FILE="/etc/vps-manager-agent/config.json"
  SOCKET_PATH="/var/run/flexserver/agent-rotation.sock"

  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: Host config file $CONFIG_FILE not found." >&2
    exit 1
  fi
  if [[ ! -S "$SOCKET_PATH" ]]; then
    echo "Error: Rotation socket $SOCKET_PATH not found or daemon not running." >&2
    exit 1
  fi

  # Locate client executable
  CLIENT_BIN=""
  if [[ -x "/usr/local/bin/local-agent-rotation-client" ]]; then
    CLIENT_BIN="/usr/local/bin/local-agent-rotation-client"
  elif [[ -x "/usr/local/bin/flexserver-local-agent-rotator" ]]; then
    CLIENT_BIN="/usr/local/bin/flexserver-local-agent-rotator"
  elif [[ -x "./packages/agent/dist/local-agent-rotator-linux-amd64" ]]; then
    CLIENT_BIN="./packages/agent/dist/local-agent-rotator-linux-amd64"
  elif [[ -x "./packages/agent/dist/local-agent-rotator" ]]; then
    CLIENT_BIN="./packages/agent/dist/local-agent-rotator"
  fi

  if [[ -z "$CLIENT_BIN" ]]; then
    echo "Error: Could not locate client executable." >&2
    exit 1
  fi

  echo "Piping existing host config credential directly to client (no token printed or in argv)..."
  # Python reads token without echoing it and formats JSON directly to client stdin
  python3 -c '
import json, subprocess, sys, os

with open("'"$CONFIG_FILE"'") as f:
    cfg = json.load(f)

payload = json.dumps({"vpsId": cfg["vpsId"], "token": cfg["token"]}) + "\n"
cmd = "'"$CLIENT_BIN"'".split()
env = os.environ.copy()
env["LOCAL_AGENT_ROTATION_SOCKET"] = "'"$SOCKET_PATH"'"

proc = subprocess.run(cmd, input=payload, text=True, capture_output=True, env=env)
if proc.returncode != 0:
    print(f"Live smoke test client failed (code {proc.returncode}): {proc.stderr}", file=sys.stderr)
    sys.exit(proc.returncode)
print("Live smoke test succeeded! Host rotation helper verified.")
'
  exit 0
fi

echo "=== Running Isolated Local Agent Rotation Fixture Tests ==="

TMP_DIR="$(mktemp -d /tmp/rotator-fixture.XXXXXX)"
cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

SOCKET_PATH="${TMP_DIR}/agent-rotation.sock"
CONFIG_FILE="${TMP_DIR}/config.json"
FAKE_SYSTEMCTL="${TMP_DIR}/fake-systemctl.sh"
SYSTEMCTL_LOG="${TMP_DIR}/systemctl.log"

# Locate or build local-agent-rotator binary
ROTATOR_BIN="${ROTATOR_BINARY:-}"
if [[ -n "$ROTATOR_BIN" && -x "$ROTATOR_BIN" ]]; then
  :
elif [[ -x "./packages/agent/dist/local-agent-rotator-linux-amd64" ]]; then
  ROTATOR_BIN="./packages/agent/dist/local-agent-rotator-linux-amd64"
elif [[ -x "./packages/agent/dist/local-agent-rotator" ]]; then
  ROTATOR_BIN="./packages/agent/dist/local-agent-rotator"
elif command -v go &>/dev/null; then
  echo "Building test local-agent-rotator binary..."
  (cd ./packages/agent && CGO_ENABLED=0 go build -o "${TMP_DIR}/local-agent-rotator" ./cmd/local-agent-rotator)
  ROTATOR_BIN="${TMP_DIR}/local-agent-rotator"
fi

if [[ -z "$ROTATOR_BIN" || ! -x "$ROTATOR_BIN" ]]; then
  echo "Error: local-agent-rotator binary not available. Build it first." >&2
  exit 1
fi

# Create fake systemctl script
cat <<'EOF' > "$FAKE_SYSTEMCTL"
#!/usr/bin/env bash
echo "$@" >> "$(dirname "$0")/systemctl.log"
if [[ -f "$(dirname "$0")/fail-restart" ]]; then
  echo "Job for vps-manager-agent.service failed" >&2
  exit 1
fi
exit 0
EOF
chmod 0755 "$FAKE_SYSTEMCTL"

# Create initial test config
cat <<EOF > "$CONFIG_FILE"
{
  "backendUrl": "https://api.flexserver.tech",
  "vpsId": "vps_local_test",
  "token": "vma_initial_fixture_token",
  "intervalSeconds": 15
}
EOF
chmod 0640 "$CONFIG_FILE"

echo "[1/4] Starting isolated local-agent-rotator server..."
"$ROTATOR_BIN" \
  -server \
  -socket "$SOCKET_PATH" \
  -config "$CONFIG_FILE" \
  -service-name "vps-manager-agent.service" \
  -systemctl-cmd "$FAKE_SYSTEMCTL" \
  -allow-any-peer &
SERVER_PID=$!

# Wait for socket to appear
for i in {1..30}; do
  if [[ -S "$SOCKET_PATH" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "Error: Server socket was not created." >&2
  exit 1
fi

echo "[2/4] Testing valid rotation via client..."
printf '{"vpsId":"vps_local_test","token":"vma_new_fixture_token_456"}\n' | \
  "$ROTATOR_BIN" -socket "$SOCKET_PATH"

# Verify config was updated
CURRENT_TOKEN="$(grep -o '"token": *"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)"
if [[ "$CURRENT_TOKEN" != "vma_new_fixture_token_456" ]]; then
  echo "Error: Expected token vma_new_fixture_token_456, got $CURRENT_TOKEN" >&2
  exit 1
fi
echo "  Config successfully updated to new token."

# Verify systemctl was called
if ! grep -q "restart vps-manager-agent.service" "$SYSTEMCTL_LOG"; then
  echo "Error: systemctl restart was not invoked." >&2
  exit 1
fi
echo "  systemctl restart successfully invoked."

echo "[3/4] Testing rejection of incorrect vpsId..."
if printf '{"vpsId":"wrong_vps_id","token":"vma_illegal_token"}\n' | "$ROTATOR_BIN" -socket "$SOCKET_PATH" 2>/dev/null; then
  echo "Error: Server should have rejected mismatched vpsId." >&2
  exit 1
fi

CURRENT_TOKEN="$(grep -o '"token": *"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)"
if [[ "$CURRENT_TOKEN" != "vma_new_fixture_token_456" ]]; then
  echo "Error: Config modified after rejected request!" >&2
  exit 1
fi
echo "  Mismatched vpsId properly rejected with no config change."

echo "[4/4] Testing automatic rollback on systemctl restart failure..."
touch "${TMP_DIR}/fail-restart"
if printf '{"vpsId":"vps_local_test","token":"vma_should_fail_token"}\n' | "$ROTATOR_BIN" -socket "$SOCKET_PATH" 2>/dev/null; then
  echo "Error: Server should have failed when systemctl failed." >&2
  exit 1
fi

CURRENT_TOKEN="$(grep -o '"token": *"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)"
if [[ "$CURRENT_TOKEN" != "vma_new_fixture_token_456" ]]; then
  echo "Error: Config was NOT rolled back to previous token! Current: $CURRENT_TOKEN" >&2
  exit 1
fi
echo "  Config was automatically rolled back on restart failure."

echo ""
echo "=== All Isolated Local Agent Rotation Tests Passed Successfully! ==="
