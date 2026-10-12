#!/usr/bin/env bash
# shellcheck disable=SC2317
#
# install-updater.sh — Bootstrap the pull-only local-agent safe-upgrade
# updater (docs/local-agent-upgrade-plan.md §4/§5). Manual, operator-driven
# install: CI/deploy never runs this silently.
#
# Usage:
#   sudo ./scripts/install/install-updater.sh --binary <path> --config <path> [options]
#   sudo ./scripts/install/install-updater.sh --upgrade [--binary <path>] [--config <path>] [options]
#
# Options:
#   --binary <path>       Path to the vps-updater binary (required unless --upgrade with candidate binary).
#   --config <path>       Path to the updater config JSON (required unless --upgrade with existing config).
#   --upgrade             Upgrade existing updater without release manifest or signing keys.
#   --manifest <path>     Path to the Ed25519-signed release manifest
#                         (required in install mode, including --dry-run;
#                         not needed for --uninstall). Verified offline
#                         against the pinned public key with
#                         scripts/release/verify-manifest.mjs before
#                         anything is installed; the exact
#                         component:"updater"/os/arch entry supplies the
#                         expected size, SHA-256 and
#                         <version>+<buildId> identity checked against the
#                         binary. No network access, no unverified path.
#   --pubkey <b64>        Pinned release public key (raw 32-byte Ed25519,
#                         base64). Exactly one of --pubkey/--pubkey-file/
#                         --pubkey-env must be given with --manifest.
#   --pubkey-file <path>  File holding the pinned base64 public key.
#   --pubkey-env <name>   Environment variable holding the pinned key.
#   --sha256 <hex>        Optional extra pin: must equal the signed
#                         manifest's updater-entry SHA-256 (never trusted
#                         on its own — the manifest entry is authoritative).
#   --dry-run             Print what would be done without making changes.
#   --uninstall           Stop/disable updater units and remove updater files.
#                         Preserves /var/lib/vps-updater (journals, backups).
#   --install-cli         Also install the flexserverctl CLI (default: on).
#   --skip-cli            Do not install the flexserverctl CLI.
#   --cli-source <path>   Path to flexserverctl.py (default: sibling file,
#                         else download from the pinned repository).
#   --cli-dest <path>     CLI install path (default:
#                         /usr/local/bin/flexserverctl).
#   --purge-state         With --uninstall: also remove /var/lib/vps-updater.
#   --help                Show this help.
#
# This script:
#   1. Verifies the signed release manifest offline against the pinned
#      public key (scripts/release/verify-manifest.mjs), selects the exact
#      component:"updater" artifact for this os/arch, and refuses to install
#      unless the binary's size, SHA-256 and `-version` identity match that
#      signed entry. Verification failure stops the install before any file
#      or unit is written.
#   2. Installs the updater binary to /usr/local/lib/vps-manager-agent/
#      vps-updater (root:root 0755) — NOT writable by the updater user and
#      never a path the privileged helper may replace.
#   3. Creates system user/group vps-updater (no shell, no home).
#   4. Installs config to /etc/vps-updater/config.json (root:vps-updater
#      0640, dir 0750) with apiBase https, fixed agentBinary/agentUnit.
#   5. Creates the state layout /var/lib/vps-updater with the DAC model the
#      capability-less helper relies on:
#        pending/ results/ staging/  root:vps-updater 0770 (shared)
#        helper/                     root:root 0755 (updater reads only)
#        helper/backups/             root:root 0755
#   6. Writes three hardened systemd units:
#        vps-updater.service       unprivileged pull-only daemon
#        vps-updater-apply.path    watches stateDir/pending
#        vps-updater-apply.service root oneshot, FIXED argv, empty
#                                  CapabilityBoundingSet — the daemon can
#                                  never pass commands, paths or units
#   7. Enables the daemon and the path unit. Never touches
#      vps-manager-agent.service beyond what the helper itself restarts.
#   8. Installs flexserverctl.py to /usr/local/bin/flexserverctl (root:root
#      0755, atomic, syntax-checked first; requires python3) unless --skip-cli.
#
# Requires root (except --dry-run, which works unprivileged).

set -euo pipefail
umask 077

# ── Early flag scan ───────────────────────────────────────────────────────
# Scanned before the bootstrap below so `--help` and `--dry-run` never touch
# the network or the filesystem: a piped `--dry-run` must make zero writes,
# including the library and CLI downloads. Root is intentionally NOT required
# here so an unprivileged `--dry-run` still works.
#
# Scans without mutating positional parameters: a while/shift loop would
# consume the argument list (e.g. --binary/--config values) before the main
# option parser ever sees it, breaking every real invocation.
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --help)
      # Read the header only when genuinely running from a file: in pipe mode
      # $0 can be the interpreter path (a binary), which would dump garbage.
      installer_header=""
      if [[ -r "$0" ]] && IFS= read -r installer_header < "$0" && [[ "$installer_header" == "#!"* ]]; then
        sed -n '2,73p' "$0" | sed 's/^# \{0,1\}//'
      else
        echo "Usage: sudo install-updater.sh --binary <path> --manifest <path> [options]"
        echo "Run this script from a file (clone the repository) to see the full help."
      fi
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
  esac
done

# ── Bootstrap ─────────────────────────────────────────────────────────────
# The documented entry point is `curl … | sudo bash`, so this body may be on
# stdin with no path of its own and no sibling files. ${BASH_SOURCE[0]} is then
# unset — indexing it unguarded aborts under `set -u` — so locate a sibling
# library explicitly, and only fall back to downloading the pinned copy.

INSTALLER_LIB_PATH=""
if [[ -f "./installer-lib.sh" ]]; then
  INSTALLER_LIB_PATH="$(pwd)/installer-lib.sh"
elif [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  INSTALLER_LIB_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/installer-lib.sh"
fi
if [[ ! -f "$INSTALLER_LIB_PATH" ]]; then
  INSTALLER_LIB_PATH=""
fi

INSTALLER_DIR=""
if [[ -n "$INSTALLER_LIB_PATH" ]]; then
  INSTALLER_DIR="$(dirname "$INSTALLER_LIB_PATH")"
fi

# Sourced only from a real sibling file. Downloading is a write plus a network
# fetch, which a piped `--dry-run` must not perform.
if [[ -n "$INSTALLER_LIB_PATH" ]]; then
  # shellcheck source=scripts/install/installer-lib.sh
  source "$INSTALLER_LIB_PATH"
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would fetch installer-lib.sh from the pinned repository."
  echo "[DRY-RUN] Would fetch flexserverctl.py, syntax-check it, then install it to /usr/local/bin/flexserverctl."
  echo "[DRY-RUN] Zero writes and zero network changes would be made."
  exit 0
else
  if ! command -v curl &>/dev/null; then
    echo "Error: installer-lib.sh not found and curl is unavailable to fetch it." >&2
    exit 1
  fi
  INSTALLER_LIB_PATH="$(mktemp)" || exit 1
  if ! curl -fsSL -o "$INSTALLER_LIB_PATH" \
    "https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install/installer-lib.sh"; then
    rm -f "$INSTALLER_LIB_PATH"
    echo "Error: Could not fetch installer-lib.sh required by this installer." >&2
    exit 1
  fi
  # shellcheck source=scripts/install/installer-lib.sh
  source "$INSTALLER_LIB_PATH"
  # Registered after sourcing: the library owns the cleanup list and EXIT trap.
  INSTALLER_TMP_FILES+=("$INSTALLER_LIB_PATH")
fi

# ── Constants (fixed by the updater's production invariants) ──────────────

BINARY_DEST="/usr/local/lib/vps-manager-agent/vps-updater"
CONFIG_DIR="/etc/vps-updater"
CONFIG_FILE="${CONFIG_DIR}/config.json"
STATE_DIR="/var/lib/vps-updater"
SERVICE_USER="vps-updater"
UNIT_DAEMON="/etc/systemd/system/vps-updater.service"
UNIT_PATH="/etc/systemd/system/vps-updater-apply.path"
UNIT_HELPER="/etc/systemd/system/vps-updater-apply.service"
# Ed25519 manifest verification runs offline via the repo's existing CLI.
# Guarded: in pipe mode ${BASH_SOURCE[0]} is unset and would abort under set -u.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/../release/verify-manifest.mjs" ]]; then
  VERIFY_MANIFEST_CLI="${SCRIPT_DIR}/../release/verify-manifest.mjs"
else
  VERIFY_MANIFEST_CLI=""
fi
# The install target is always a Linux systemd host, whatever platform the
# operator previews it from; arch follows the running machine.
TARGET_OS="linux"
case "$(uname -m)" in
  x86_64|amd64) TARGET_ARCH="amd64" ;;
  aarch64|arm64) TARGET_ARCH="arm64" ;;
  *) TARGET_ARCH="$(uname -m)" ;;
esac

# ── Args ──────────────────────────────────────────────────────────────────

BINARY_SRC=""
CONFIG_SRC=""
MANIFEST_SRC=""
PUBKEY=""
PUBKEY_FILE=""
PUBKEY_ENV=""
SHA256_EXPECTED=""
UPGRADE=false
UNINSTALL=false
PURGE_STATE=false
INSTALL_CLI=true
SKIP_CLI=false
CLI_DEST="${FLEXSERVERCTL_DEST_DEFAULT}"
CLI_SRC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      BINARY_SRC="$2"; shift 2 ;;
    --config)
      CONFIG_SRC="$2"; shift 2 ;;
    --manifest)
      MANIFEST_SRC="$2"; shift 2 ;;
    --pubkey)
      PUBKEY="$2"; shift 2 ;;
    --pubkey-file)
      PUBKEY_FILE="$2"; shift 2 ;;
    --pubkey-env)
      PUBKEY_ENV="$2"; shift 2 ;;
    --sha256)
      SHA256_EXPECTED="$2"; shift 2 ;;
    --upgrade)
      UPGRADE=true; shift ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --uninstall)
      UNINSTALL=true; shift ;;
    --purge-state)
      PURGE_STATE=true; shift ;;
    --install-cli)
      INSTALL_CLI=true; SKIP_CLI=false; shift ;;
    --skip-cli)
      SKIP_CLI=true; shift ;;
    --cli-source)
      CLI_SRC="$2"; shift 2 ;;
    --cli-dest)
      CLI_DEST="$2"; shift 2 ;;
    --help)
      installer_header=""
      if [[ -r "$0" ]] && IFS= read -r installer_header < "$0" && [[ "$installer_header" == "#!"* ]]; then
        sed -n '2,73p' "$0" | sed 's/^# \{0,1\}//'
      else
        echo "Usage: sudo install-updater.sh --binary <path> --manifest <path> [options]"
      fi
      exit 0 ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      echo "Usage: sudo ./scripts/install/install-updater.sh --binary <path> --config <path> [--manifest <path>] [--upgrade] [--dry-run|--uninstall]" >&2
      exit 1 ;;
  esac
done

# ── Root check (dry-run works unprivileged) ───────────────────────────────

if [[ $EUID -ne 0 && "$DRY_RUN" != "true" ]]; then
  echo "Error: This script must be run as root (sudo), or use --dry-run." >&2
  exit 1
fi

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would run: $*"
  else
    "$@"
  fi
}

# ── Uninstall mode ────────────────────────────────────────────────────────

if [[ "$UNINSTALL" == "true" ]]; then
  echo "[Uninstall] Removing the local-agent updater..."
  for u in "vps-updater-apply.path" "vps-updater-apply.service" "vps-updater.service"; do
    if systemctl list-unit-files "$u" &>/dev/null || [[ -f "/etc/systemd/system/$u" ]]; then
      run systemctl disable --now "$u" 2>/dev/null || true
      # disable --now on a .path also stops the triggered .service
      run systemctl stop "${u%.path}.service" 2>/dev/null || true
    fi
    if [[ -f "/etc/systemd/system/$u" ]]; then
      run rm -f "/etc/systemd/system/$u"
    fi
  done
  run systemctl daemon-reload

  if [[ -f "$BINARY_DEST" ]]; then
    run rm -f "$BINARY_DEST"
  fi
  if [[ -d "$CONFIG_DIR" ]]; then
    run rm -rf "$CONFIG_DIR"
  fi

  if [[ "$PURGE_STATE" == "true" ]]; then
    if [[ -d "$STATE_DIR" ]]; then
      echo "  WARNING: purging ${STATE_DIR} (journals and any retained backups)" >&2
      run rm -rf "$STATE_DIR"
    fi
  elif [[ -d "$STATE_DIR" ]]; then
    echo "[Uninstall] Preserved ${STATE_DIR} (journals/backups; use --purge-state to remove)."
    echo "[Uninstall] Offline recovery: see docs/local-agent-upgrade-operations.md runbook."
  fi
  # /usr/local/bin/flexserverctl is deliberately preserved: the local agent
  # (and any later component install) may still need it.

  echo "[Uninstall] The agent unit ${UNIT_HELPER##*/} was not modified; vps-manager-agent keeps running."
  exit 0
fi

# ── Install mode validation ───────────────────────────────────────────────

if [[ "$UPGRADE" == "true" ]]; then
  if [[ -z "$CONFIG_SRC" && -f "$CONFIG_FILE" ]]; then
    CONFIG_SRC="$CONFIG_FILE"
  fi
  if [[ -z "$BINARY_SRC" ]]; then
    CANDIDATES=(
      "./vps-updater-linux-amd64"
      "./vps-updater"
      "/app/agent/vps-updater-linux-amd64"
      "$(dirname "$0")/../../packages/agent/dist/vps-updater-linux-amd64"
    )
    for cand in "${CANDIDATES[@]}"; do
      if [[ -f "$cand" ]]; then
        BINARY_SRC="$cand"
        break
      fi
    done
  fi
fi

if [[ -z "$BINARY_SRC" ]]; then
  echo "Error: --binary <path> is required." >&2
  exit 1
fi
if [[ ! -f "$BINARY_SRC" ]]; then
  echo "Error: Binary not found: ${BINARY_SRC}" >&2
  exit 1
fi
if [[ -z "$CONFIG_SRC" ]]; then
  echo "Error: --config <path> is required." >&2
  exit 1
fi
if [[ ! -f "$CONFIG_SRC" ]]; then
  echo "Error: Config file not found: ${CONFIG_SRC}" >&2
  exit 1
fi
# node runtime for manifest verification and config validation
if ! command -v node &>/dev/null; then
  echo "Error: node is required to validate the updater config and verify the signed manifest." >&2
  exit 1
fi

# Signed-manifest trust bootstrap (plan §4): install mode — including
# --dry-run — refuses any binary whose size/SHA-256/-version identity is not
# covered by the Ed25519-signed updater artifact entry. --sha256 alone is
# never sufficient: it is only cross-checked against the signed entry.
# --uninstall above needs no manifest; --upgrade upgrades to bundled protocol without signing keys.
if [[ "$UPGRADE" != "true" || -n "$MANIFEST_SRC" ]]; then
if [[ -z "$MANIFEST_SRC" ]]; then
  echo "Error: --manifest <path> is required (the signed release manifest)." >&2
  echo "  Obtain it from the release pipeline and verify it against your" >&2
  echo "  pinned public key; install never accepts an unverified binary." >&2
  exit 1
fi
if [[ ! -f "$MANIFEST_SRC" ]]; then
  echo "Error: Manifest not found: ${MANIFEST_SRC}" >&2
  exit 1
fi
PUBKEY_SOURCES=0
if [[ -n "$PUBKEY" ]]; then PUBKEY_SOURCES=$((PUBKEY_SOURCES + 1)); fi
if [[ -n "$PUBKEY_FILE" ]]; then PUBKEY_SOURCES=$((PUBKEY_SOURCES + 1)); fi
if [[ -n "$PUBKEY_ENV" ]]; then PUBKEY_SOURCES=$((PUBKEY_SOURCES + 1)); fi
if [[ "$PUBKEY_SOURCES" -ne 1 ]]; then
  echo "Error: exactly one of --pubkey, --pubkey-file, --pubkey-env is required with --manifest." >&2
  exit 1
fi
if [[ -n "$PUBKEY_FILE" && ! -f "$PUBKEY_FILE" ]]; then
  echo "Error: Public key file not found: ${PUBKEY_FILE}" >&2
  exit 1
fi
if [[ ! -f "$VERIFY_MANIFEST_CLI" ]]; then
  echo "Error: verify-manifest.mjs not found: ${VERIFY_MANIFEST_CLI}" >&2
  echo "  install-updater.sh must ship alongside ../release/verify-manifest.mjs (scripts/install/ + scripts/release/)." >&2
  echo "  This happens when the installer is piped from stdin (curl … | sudo bash):" >&2
  echo "  clone the repository or copy scripts/ and release/ next to this script instead." >&2
  exit 1
fi
if ! command -v node &>/dev/null; then
  echo "Error: node is required to validate the updater config and verify the signed manifest." >&2
  exit 1
fi

VERIFY_ARGS=(--manifest "$MANIFEST_SRC")
if [[ -n "$PUBKEY" ]]; then
  VERIFY_ARGS+=(--pubkey "$PUBKEY")
elif [[ -n "$PUBKEY_FILE" ]]; then
  VERIFY_ARGS+=(--pubkey-file "$PUBKEY_FILE")
else
  VERIFY_ARGS+=(--pubkey-env "$PUBKEY_ENV")
fi
if ! MF_OUT="$(node "$VERIFY_MANIFEST_CLI" "${VERIFY_ARGS[@]}" 2>&1)"; then
  echo "Error: signed manifest verification failed: ${MANIFEST_SRC}" >&2
  printf '%s\n' "$MF_OUT" | sed 's/^/  /' >&2
  exit 1
fi
echo "[Install] Signed manifest verified: ${MF_OUT}"

# Select the exact updater artifact for this platform. component/os/arch
# must match exactly; a missing, duplicated or foreign entry fails closed
# (e.g. an agent-only manifest cannot bootstrap the updater).
if ! ENTRY="$(node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const os = process.argv[2];
  const arch = process.argv[3];
  const hits = (Array.isArray(m.artifacts) ? m.artifacts : []).filter(
    (a) => a && a.component === "updater" && a.os === os && a.arch === arch,
  );
  if (hits.length !== 1) {
    console.error(`manifest carries ${hits.length} component:"updater" artifacts for ${os}/${arch}; exactly 1 required`);
    process.exit(1);
  }
  const a = hits[0];
  console.log(`${m.version} ${m.buildId} ${m.releaseId} ${a.sha256} ${a.size}`);
' "$MANIFEST_SRC" "$TARGET_OS" "$TARGET_ARCH" 2>&1)"; then
  echo "Error: no verified updater artifact in manifest: ${MANIFEST_SRC}" >&2
  printf '%s\n' "$ENTRY" | sed 's/^/  /' >&2
  exit 1
fi
read -r ENTRY_VERSION ENTRY_BUILDID ENTRY_RELEASE ENTRY_SHA ENTRY_SIZE <<<"$ENTRY"

# Binary size and SHA-256 against the signed entry.
BINARY_SIZE="$(wc -c < "$BINARY_SRC" | tr -d '[:space:]')"
if ! [[ "$BINARY_SIZE" =~ ^[0-9]+$ ]]; then
  echo "Error: cannot measure binary size: ${BINARY_SRC}" >&2
  exit 1
fi
if [[ "$BINARY_SIZE" -ne "$ENTRY_SIZE" ]]; then
  echo "Error: binary size mismatch: got ${BINARY_SIZE} bytes, signed updater entry says ${ENTRY_SIZE}." >&2
  exit 1
fi
if command -v sha256sum &>/dev/null; then
  ACTUAL_SHA="$(sha256sum "$BINARY_SRC" | awk '{print $1}')"
elif command -v shasum &>/dev/null; then
  ACTUAL_SHA="$(shasum -a 256 "$BINARY_SRC" | awk '{print $1}')"
else
  echo "Error: cannot verify binary hash (no sha256sum or shasum)." >&2
  exit 1
fi
if [[ "${ACTUAL_SHA,,}" != "${ENTRY_SHA,,}" ]]; then
  echo "Error: binary SHA-256 mismatch: got ${ACTUAL_SHA}, signed updater entry says ${ENTRY_SHA}." >&2
  exit 1
fi
echo "[Install] Binary SHA-256 verified against signed entry: ${ACTUAL_SHA} (${BINARY_SIZE} bytes)"
if [[ -n "$SHA256_EXPECTED" ]]; then
  if ! [[ "$SHA256_EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "Error: --sha256 must be 64 hex characters." >&2
    exit 1
  fi
  if [[ "${SHA256_EXPECTED,,}" != "${ENTRY_SHA,,}" ]]; then
    echo "Error: --sha256 does not match the signed manifest updater entry (${ENTRY_SHA})." >&2
    exit 1
  fi
fi

WANT_ID="${ENTRY_VERSION}+${ENTRY_BUILDID}"
if [[ ! -x "$BINARY_SRC" ]]; then
  echo "Error: ${BINARY_SRC} is not executable; cannot check -version against signed identity ${WANT_ID}." >&2
  echo "  Build it on this host: (cd packages/agent && go build -o <path> ./cmd/vps-updater)" >&2
  exit 1
fi
if ! UPD_VER="$("$BINARY_SRC" -version 2>&1)"; then
  echo "Error: ${BINARY_SRC} -version failed: ${UPD_VER}" >&2
  exit 1
fi
UPD_VER="${UPD_VER//$'\r'/}"
if [[ "$UPD_VER" != "$WANT_ID" ]]; then
  echo "Error: binary -version mismatch: got '${UPD_VER}', signed manifest says '${WANT_ID}'." >&2
  exit 1
fi
echo "[Install] Updater identity verified: ${UPD_VER} (release ${ENTRY_RELEASE})"
else
# In upgrade mode without a release manifest, verify binary directly:
BINARY_SIZE="$(wc -c < "$BINARY_SRC" | tr -d '[:space:]')"
if ! [[ "$BINARY_SIZE" =~ ^[0-9]+$ ]]; then
  echo "Error: cannot measure binary size: ${BINARY_SRC}" >&2
  exit 1
fi
if command -v sha256sum &>/dev/null; then
  ACTUAL_SHA="$(sha256sum "$BINARY_SRC" | awk '{print $1}')"
elif command -v shasum &>/dev/null; then
  ACTUAL_SHA="$(shasum -a 256 "$BINARY_SRC" | awk '{print $1}')"
else
  echo "Error: cannot verify binary hash (no sha256sum or shasum)." >&2
  exit 1
fi
if [[ -n "$SHA256_EXPECTED" ]]; then
  if ! [[ "$SHA256_EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "Error: --sha256 must be 64 hex characters." >&2
    exit 1
  fi
  if [[ "${SHA256_EXPECTED,,}" != "${ACTUAL_SHA,,}" ]]; then
    echo "Error: binary SHA-256 mismatch: got ${ACTUAL_SHA}, expected ${SHA256_EXPECTED}." >&2
    exit 1
  fi
fi
if [[ ! -x "$BINARY_SRC" ]]; then
  chmod +x "$BINARY_SRC" 2>/dev/null || true
fi
if [[ -x "$BINARY_SRC" ]]; then
  UPD_VER="$("$BINARY_SRC" -version 2>&1 || true)"
  UPD_VER="${UPD_VER//$'\r'/}"
  echo "[Upgrade] Binary identity: ${UPD_VER}"
fi
echo "[Upgrade] Verified binary size=${BINARY_SIZE} sha256=${ACTUAL_SHA}"
fi
# Validate the updater config: required fields and the production invariants
# the updater itself enforces (https apiBase, fixed binary/state targets).
# node was already required above for manifest verification.
if ! CFG_ERR="$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const isUpgrade = process.argv[2] === "true";
  const required = ["apiBase", "credential", "agentBinary", "stateDir"];
  for (const k of required) {
    if (typeof c[k] !== "string" || !c[k]) throw new Error(`missing ${k}`);
  }
  const api = new URL(c.apiBase);
  if (api.protocol !== "https:" || api.username || api.password) throw new Error("apiBase must be HTTPS without userinfo");
  if (!c.credential.startsWith("vma_")) throw new Error("credential must be a scoped vma_ bearer");
  if (c.agentBinary !== "/usr/local/bin/vps-manager-agent") throw new Error("agentBinary must be /usr/local/bin/vps-manager-agent");
  const agentUnit = c.agentUnit == null ? "vps-manager-agent.service" : c.agentUnit;
  if (agentUnit !== "vps-manager-agent.service") throw new Error("agentUnit must be vps-manager-agent.service");
  if (c.stateDir !== "/var/lib/vps-updater") throw new Error("stateDir must be /var/lib/vps-updater");
  if ("allowedHosts" in c) throw new Error("allowedHosts is pinned in the binary");
  if (c.pinnedPublicKey) {
    let raw;
    try { raw = Buffer.from(c.pinnedPublicKey, "base64"); } catch { throw new Error("pinnedPublicKey must be base64"); }
    if (raw.length !== 32) throw new Error(`pinnedPublicKey must decode to 32 bytes, got ${raw.length}`);
  }
' "$CONFIG_SRC" "$UPGRADE" 2>&1)"; then
  echo "Error: Config is not a valid updater config (see plan §5): ${CONFIG_SRC}" >&2
  printf '%s\n' "$CFG_ERR" | sed 's/^/  /' >&2
  exit 1
fi

# ── flexserverctl CLI — source and python3 prerequisite ───────────────────
#
# Checked before the install mutations below, so a missing python3 or a
# failed pipe-mode download can never leave the updater installed but the CLI
# missing. Also independent of the strict HTTPS apiBase gate: a host that
# cannot migrate today still gets a working CLI. The atomic copy into place
# happens at the end of the install.
CLI_RESOLVED_SOURCE=""
if [[ "$INSTALL_CLI" == "true" && "$SKIP_CLI" == "false" ]]; then
  if [[ "$DRY_RUN" == "false" ]]; then
    if [[ -n "$CLI_SRC" ]]; then
      FLEXSERVERCTL_SOURCE="$CLI_SRC"
    fi
    if ! prepare_flexserverctl_source; then
      exit 1
    fi
    CLI_RESOLVED_SOURCE="$FLEXSERVERCTL_SRC"
  fi
fi

# ── Install ───────────────────────────────────────────────────────────────

echo "[Install] Installing the local-agent updater..."

# Refuse active job/journal/pending helper before mutation so an in-flight
# upgrade transaction is never interrupted or corrupted.
if [[ -d "$STATE_DIR" ]]; then
  if systemctl is-active --quiet vps-updater-apply.service 2>/dev/null; then
    echo "Error: vps-updater-apply.service is currently running; refusing upgrade while helper is active." >&2
    exit 1
  fi
  if [[ -d "${STATE_DIR}/pending" ]] && [[ -n "$(ls -A "${STATE_DIR}/pending" 2>/dev/null)" ]]; then
    echo "Error: Pending helper actions detected in ${STATE_DIR}/pending; refusing upgrade while action is pending." >&2
    exit 1
  fi
  if [[ -f "${STATE_DIR}/journal.json" ]]; then
    echo "Error: Active daemon journal detected at ${STATE_DIR}/journal.json; refusing upgrade while job is in flight." >&2
    exit 1
  fi
  if [[ -f "${STATE_DIR}/helper/journal.json" ]]; then
    # Helper journal is durable after a completed job: handleCleanup removes it
    # only best-effort, leaving a settled record behind. When no helper service
    # is active, no pending queue entries exist, and no daemon journal exists,
    # a settled "restarted" or "rolled_back" record is quiescent, not in flight.
    # In-flight phases ("intent", "renamed") and malformed/unrecognised records fail closed.
    if ! HJ_ERR="$(node -e '
      const fs = require("fs");
      let raw;
      try {
        raw = fs.readFileSync(process.argv[1], "utf8");
      } catch (e) {
        console.error("cannot read helper journal: " + (e.message || e));
        process.exit(1);
      }
      let hj;
      try {
        hj = JSON.parse(raw);
      } catch (e) {
        console.error("corrupt helper journal (not valid JSON): " + (e.message || e));
        process.exit(1);
      }
      if (!hj || typeof hj !== "object" || Array.isArray(hj) || Object.keys(hj).length === 0) {
        console.error("helper journal is present but empty or not an object");
        process.exit(1);
      }
      const phase = hj.phase;
      const job = typeof hj.jobId === "string" ? hj.jobId : "unknown";
      if (!phase) {
        console.error("helper journal is missing a valid phase (job " + job + ")");
        process.exit(1);
      }
      if (phase === "intent" || phase === "renamed") {
        console.error("helper transaction is mid-swap with in-flight phase " + JSON.stringify(phase) + " (job " + job + ")");
        process.exit(1);
      }
      if (phase !== "restarted" && phase !== "rolled_back") {
        console.error("helper journal has unrecognised phase " + JSON.stringify(phase) + " (job " + job + ")");
        process.exit(1);
      }
    ' "${STATE_DIR}/helper/journal.json" 2>&1)"; then
      echo "Error: Active or unrecognised helper journal detected at ${STATE_DIR}/helper/journal.json; refusing upgrade: ${HJ_ERR}" >&2
      exit 1
    fi
  fi
fi

# User/group
if ! getent group "$SERVICE_USER" &>/dev/null; then
  run groupadd --system "$SERVICE_USER"
fi
if ! getent passwd "$SERVICE_USER" &>/dev/null; then
  run useradd --system --no-create-home --shell /sbin/nologin -g "$SERVICE_USER" "$SERVICE_USER"
fi

# Quiesce active daemon before binary replacement to avoid ETXTBSY on live executable.
WAS_UPDATER_ACTIVE=false
if systemctl is-active --quiet vps-updater.service 2>/dev/null; then
  WAS_UPDATER_ACTIVE=true
  echo "[Upgrade] Quiescing active vps-updater daemon before binary replacement..."
  run systemctl stop vps-updater.service 2>/dev/null || true
fi
# Binary (directory not writable by the updater user: it cannot replace
# itself; only the fixed helper may touch /usr/local/bin/vps-manager-agent).
run mkdir -p "$(dirname "$BINARY_DEST")"
# Existing agent installations may keep this root-owned directory at 0700.
# The unprivileged updater needs traversal, not write access.
run chown root:root "$(dirname "$BINARY_DEST")"
run chmod 0755 "$(dirname "$BINARY_DEST")"

# Backup existing binary if present for transaction rollback.
if [[ -f "$BINARY_DEST" ]]; then
  run cp -f "$BINARY_DEST" "${BINARY_DEST}.backup" 2>/dev/null || true
fi

# Atomic replace: copy to sibling temp file and mv into place to avoid ETXTBSY.
TMP_BIN="${BINARY_DEST}.tmp.$$"
run cp -f "$BINARY_SRC" "$TMP_BIN"
run chown root:root "$TMP_BIN"
run chmod 0755 "$TMP_BIN"
run mv -f "$TMP_BIN" "$BINARY_DEST"

# Config
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would create ${CONFIG_DIR} (root:${SERVICE_USER} 0750)"
  echo "  [DRY-RUN] Would install ${CONFIG_SRC} -> ${CONFIG_FILE} (root:${SERVICE_USER} 0640)"
else
  mkdir -p "$CONFIG_DIR"
  chown root:"$SERVICE_USER" "$CONFIG_DIR"
  chmod 0750 "$CONFIG_DIR"
  if [[ "$CONFIG_SRC" != "$CONFIG_FILE" ]]; then
    cp -f "$CONFIG_SRC" "$CONFIG_FILE"
  fi
  chown root:"$SERVICE_USER" "$CONFIG_FILE"
  chmod 0640 "$CONFIG_FILE"
fi

# State layout. The privileged helper runs with an empty
# CapabilityBoundingSet (uid 0 only, no CAP_DAC_OVERRIDE), so every path it
# writes must be root-owned; the daemon-owned dirs are group-writable by
# vps-updater so root (as owner) and the daemon (as group) can both use them.
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would create ${STATE_DIR}/{pending,results,staging} (root:${SERVICE_USER} 0770)"
  echo "  [DRY-RUN] Would create ${STATE_DIR}/helper/{,backups} (root:root 0755)"
else
  mkdir -p "$STATE_DIR"
  chown root:"$SERVICE_USER" "$STATE_DIR"
  chmod 0770 "$STATE_DIR"
  for d in pending results staging; do
    mkdir -p "$STATE_DIR/$d"
    chown root:"$SERVICE_USER" "$STATE_DIR/$d"
    chmod 0770 "$STATE_DIR/$d"
  done
  mkdir -p "$STATE_DIR/helper/backups"
  chown -R root:root "$STATE_DIR/helper"
  chmod 0755 "$STATE_DIR/helper" "$STATE_DIR/helper/backups"
fi

# ── systemd units ─────────────────────────────────────────────────────────

DAEMON_UNIT_CONTENT=$(
  cat <<UNIT
[Unit]
Description=VPS Manager Local-Agent Updater (pull-only)
Documentation=https://github.com/sondoan17/vps-manager-nodejs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${BINARY_DEST} daemon -config ${CONFIG_FILE}
Restart=always
RestartSec=10

# Security hardening: outbound HTTPS only, no privileged socket, no access
# to agent config/tokens, Docker state, or the binary it must not replace.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${STATE_DIR}
ProtectHome=true
InaccessiblePaths=/etc/vps-manager-agent
CapabilityBoundingSet=
AmbientCapabilities=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true

[Install]
WantedBy=multi-user.target
UNIT
)

PATH_UNIT_CONTENT=$(
  cat <<UNIT
[Unit]
Description=Watch vps-updater privileged action requests

[Path]
DirectoryNotEmpty=${STATE_DIR}/pending
Unit=vps-updater-apply.service

[Install]
WantedBy=multi-user.target
UNIT
)

HELPER_UNIT_CONTENT=$(
  cat <<UNIT
[Unit]
Description=VPS Manager updater privileged helper (fixed operations)

[Service]
Type=oneshot
User=root
Group=root
# FIXED ARGV. The daemon never passes commands, paths or units — the helper
# only learns <action>.<jobId> from ${STATE_DIR}/pending and re-verifies
# signature/hash/buildId itself before any swap.
ExecStart=${BINARY_DEST} helper -config ${CONFIG_FILE}
TimeoutStartSec=300s
UMask=0022

# Hardening: root uid but no capabilities (every path it writes is
# root-owned), no config/token visibility, no kernel/clock access.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${STATE_DIR} /usr/local/bin
ProtectHome=true
InaccessiblePaths=/etc/vps-manager-agent
CapabilityBoundingSet=
AmbientCapabilities=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectControlGroups=true
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true
UNIT
)

write_unit() {
  local path="$1" content="$2"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY-RUN] Would write systemd unit: ${path}"
    echo "---"
    echo "$content"
    echo "---"
  else
    printf '%s\n' "$content" > "$path"
    chmod 0644 "$path"
    echo "  Written systemd unit: ${path}"
  fi
}

write_unit "$UNIT_DAEMON" "$DAEMON_UNIT_CONTENT"
write_unit "$UNIT_PATH" "$PATH_UNIT_CONTENT"
write_unit "$UNIT_HELPER" "$HELPER_UNIT_CONTENT"

# Reload, enable, and restart daemon (daemon restarted — the agent is untouched).
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  [DRY-RUN] Would run: systemctl daemon-reload"
  echo "  [DRY-RUN] Would run: systemctl enable vps-updater.service vps-updater-apply.path"
  echo "  [DRY-RUN] Would run: systemctl restart vps-updater.service vps-updater-apply.path"
else
  systemctl daemon-reload
  systemctl enable vps-updater.service vps-updater-apply.path 2>/dev/null || true
  systemctl restart vps-updater-apply.path 2>/dev/null || true
  if ! systemctl restart vps-updater.service; then
    echo "ERROR: Failed to restart vps-updater.service with new binary" >&2
    if [[ -f "${BINARY_DEST}.backup" ]]; then
      echo "Rolling back to previous updater binary..." >&2
      mv -f "${BINARY_DEST}.backup" "$BINARY_DEST"
      systemctl daemon-reload
      if [[ "$WAS_UPDATER_ACTIVE" == "true" ]]; then
        systemctl restart vps-updater.service 2>/dev/null || true
      else
        systemctl stop vps-updater.service 2>/dev/null || true
      fi
    fi
    exit 1
  fi
  rm -f "${BINARY_DEST}.backup" 2>/dev/null || true
  echo "  Started/restarted vps-updater.service and vps-updater-apply.path (enabled on boot)"
fi

echo ""
echo "[Install] Local-agent updater installed."
echo "  Binary:   ${BINARY_DEST}"
echo "  Config:   ${CONFIG_FILE}"
echo "  State:    ${STATE_DIR}"
echo "  Service:  vps-updater.service  (pull-only daemon, user ${SERVICE_USER})"
echo "  Trigger:  vps-updater-apply.path -> vps-updater-apply.service (root, fixed argv)"
echo ""
echo "Check status: sudo ${BINARY_DEST} status -config ${CONFIG_FILE}"
echo "Ack a hold:   sudo -u ${SERVICE_USER} ${BINARY_DEST} ack -config ${CONFIG_FILE}"
echo "View logs:    sudo journalctl -u vps-updater.service -f"
echo "Runbook:      docs/local-agent-upgrade-operations.md"

# ── flexserverctl CLI ─────────────────────────────────────────────────────

if [[ "$INSTALL_CLI" == "true" && "$SKIP_CLI" == "false" ]]; then
  echo "[flexserverctl] Installing CLI..."
  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -n "$CLI_SRC" ]]; then
      echo "  [DRY-RUN] Would install ${CLI_SRC} -> ${CLI_DEST} (root:root 0755, atomic)"
    elif resolve_flexserverctl_source &>/dev/null; then
      echo "  [DRY-RUN] Would install $(resolve_flexserverctl_source) -> ${CLI_DEST} (root:root 0755, atomic)"
    else
      echo "  [DRY-RUN] Would download flexserverctl.py, then install it to ${CLI_DEST} (root:root 0755, atomic)"
    fi
  else
    install_flexserverctl "$CLI_DEST" "${CLI_RESOLVED_SOURCE:-}"
  fi
fi
