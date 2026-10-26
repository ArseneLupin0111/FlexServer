#!/usr/bin/env bash
# shellcheck shell=bash
#
# installer-lib.sh — Shared helpers for the VPS Manager installers.
#
# Sourced by scripts/install/install.sh and install-local-agent.sh. Keeping
# the helpers in one place means both installers share identical semantics for:
#
#   1. Backend URL policy — parsed with Python's urllib (the same parser
#      family the Node runtime uses via `new URL()`), not shell globs, so
#      userinfo, ports, IPv6 literals, paths, queries and malformed input
#      are handled by a real parser.
#   2. flexserverctl CLI packaging — python3 prerequisite, source
#      resolution/download, atomic install, uninstall, temp cleanup.
#
# Dependency-free beyond bash, coreutils, curl (pipe mode) and python3 (URL
# parsing and the CLI itself).

# ── Pipe-mode bootstrap ───────────────────────────────────────────────────
# The documented entry points are `curl … | sudo bash`, which means the
# installer body is on stdin: ${BASH_SOURCE[0]} is unset, so there is no
# script path to find sibling files from and `dirname ""` would abort under
# `set -u`. The entrypoints therefore locate a sibling library explicitly and,
# failing that, download the pinned copy before sourcing it.

FLEXSERVERCTL_REPO_RAW_BASE_URL="${FLEXSERVERCTL_REPO_RAW_BASE_URL:-https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install}"
FLEXSERVERCTL_LIB_FILE_NAME="installer-lib.sh"
FLEXSERVERCTL_LIB_REPO_RAW_URL="${FLEXSERVERCTL_REPO_RAW_BASE_URL}/${FLEXSERVERCTL_LIB_FILE_NAME}"

# Echo the directory the installer is running from, or return 1 when it is
# piped through stdin and has no path of its own.
installer_self_dir() {
  local self="${BASH_SOURCE[0]:-}"
  [[ -n "$self" && -f "$self" ]] || return 1
  cd "$(dirname "$self")" && pwd
}

# ── Temp-file bookkeeping ─────────────────────────────────────────────────
# Every installer sources this lib, so the one shared list and one EXIT trap
# mean a download can never be orphaned on a target host.

INSTALLER_TMP_FILES=()

installer_cleanup_tmp_files() {
  local tmp_file
  # The ${arr[@]+…} form avoids both the "unbound variable" failure under
  # set -u and the phantom empty element that ${arr[@]:-} produces when the
  # array is empty.
  for tmp_file in ${INSTALLER_TMP_FILES[@]+"${INSTALLER_TMP_FILES[@]}"}; do
    if [[ -n "$tmp_file" && -e "$tmp_file" ]]; then
      rm -rf -- "$tmp_file"
    fi
  done
}

# Never clobber a trap the entrypoint already installed.
if [[ -z "$(trap -p EXIT)" ]]; then
  trap installer_cleanup_tmp_files EXIT
fi

# ── URL policy ────────────────────────────────────────────────────────────

# Print "<scheme> <hostname>" for a parsable http(s) URL, else return 1.
#
# Parsing is delegated to urllib because shell prefix matching cannot tell
# "http://127.0.0.1" from "http://127.0.0.1.evil.example", and cannot parse
# IPv6/userinfo/port forms at all. The parsed hostname is only lowercased —
# a trailing FQDN dot ("localhost.") is preserved verbatim, because Go's
# config.isLoopbackHost() compares the raw host and rejects "localhost.".
# Normalising it here would accept a redirect target that the runtime then
# refuses, so the installer must reason about the same host the runtime sees.
#
# Rejected: unsupported schemes, unparsable URLs, embedded credentials
# (userinfo), empty hosts, and any whitespace/control characters — the latter
# matters because these values are written verbatim into .env files, where a
# control character could inject extra environment lines.
parse_backend_url() {
  local url="${1-}"
  [[ -n "$url" ]] || return 1
  python3 - "$url" <<'PY' || return 1
import sys
from urllib.parse import urlsplit

raw = sys.argv[1]
if any(ord(ch) < 0x20 or ch.isspace() for ch in raw):
    sys.exit(1)
try:
    parts = urlsplit(raw)
except ValueError:
    sys.exit(1)
scheme = (parts.scheme or "").lower()
if scheme not in ("http", "https"):
    sys.exit(1)
if parts.username or parts.password:
    sys.exit(1)
host = (parts.hostname or "").lower()
if not host:
    sys.exit(1)
print("%s %s" % (scheme, host))
PY
}

# True only for a parsed hostname that is exactly a loopback name.
# Everything else — including "127.0.0.1.evil.example", "localhost.example.com"
# and 0.0.0.0 — is treated as remote. This is intentionally fail-closed: a
# hostname Python accepts but does not normalize (e.g. "0x7f000001") is
# rejected rather than guessed at.
is_loopback_host() {
  case "${1-}" in
    localhost|127.0.0.1|::1) return 0 ;;
    *) return 1 ;;
  esac
}

# Validate a URL used either as the local agent backend or as the canonical
# remote install base. Mirrors validateBackendUrl() in
# packages/api/src/scripts/bootstrap-local-agent.ts, which is authoritative at
# runtime, plus the packaging policy that install.sh has always enforced:
# HTTPS is always accepted; plain http only for loopback, or anywhere when the
# operator explicitly opts in.
#
# NOTE: this is deliberately NOT a mirror of flexserverctl's Python
# validate_backend_url(). That one is a migration contract and is stricter
# (HTTPS-only targets). This helper is an install-time *allow* policy and must
# keep accepting http loopback, because a fresh local install has no
# migration context, works before any CLI config exists, and fails if the
# only permitted URL is HTTPS. The two are intentionally different contracts;
# no parity between them is required or asserted.
#
# Usage: validate_backend_url <url> [allow_insecure_http]
validate_backend_url() {
  local url="${1-}" allow_insecure="${2:-false}"
  local parsed scheme host

  if ! parsed="$(parse_backend_url "$url")"; then
    echo "Error: Not a valid http(s) URL: ${url}" >&2
    return 1
  fi
  scheme="${parsed%% *}"
  host="${parsed##* }"

  case "$scheme" in
    https) return 0 ;;
    http) ;;
    *)
      echo "Error: Unsupported URL scheme (http/https only): ${url}" >&2
      return 1
      ;;
  esac

  if is_loopback_host "$host"; then
    return 0
  fi
  if [[ "$allow_insecure" == "true" ]]; then
    return 0
  fi
  echo "Error: Insecure plain-HTTP URL for non-loopback host '${host}': ${url}" >&2
  echo "  Use HTTPS, or pass --allow-insecure-backend-url explicitly." >&2
  return 1
}

# True when an explicit --backend-url should be advertised as the canonical
# AGENT_PUBLIC_BASE_URL for remote installs.
#
# HTTPS only. Plain-HTTP is published solely through the explicit
# --allow-insecure-backend-url escape hatch in install.sh, so narrowing this
# helper does not change what that flag can already do — it only keeps the
# automatic path limited to origins that are encrypted by default.
url_is_remote_publishable() {
  case "${1-}" in
    https://*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── flexserverctl CLI packaging ───────────────────────────────────────────

FLEXSERVERCTL_FILE_NAME="flexserverctl.py"
FLEXSERVERCTL_COMMAND_NAME="flexserverctl"
FLEXSERVERCTL_DEST_DEFAULT="/usr/local/bin/flexserverctl"
FLEXSERVERCTL_REPO_RAW_URL="https://raw.githubusercontent.com/sondoan17/vps-manager-nodejs/main/scripts/install/flexserverctl.py"

# Called before any mutation: a host without python3 can run neither the CLI
# nor this library's URL parsing, so both fail with actionable guidance
# instead of leaving a half-configured host behind.
require_python3_for_cli() {
  if command -v python3 &>/dev/null; then
    return 0
  fi
  echo "Error: python3 is required (${FLEXSERVERCTL_COMMAND_NAME} is a Python 3 script)." >&2
  echo "  Install it first, e.g.: sudo apt install python3  (or equivalent)" >&2
  return 1
}

# Echo the flexserverctl.py source path, or return 1 when it is not on disk.
# Resolution order: explicit $FLEXSERVERCTL_SOURCE override, then the sibling
# file next to the installer being run.
resolve_flexserverctl_source() {
  local candidate

  if [[ -n "${FLEXSERVERCTL_SOURCE:-}" ]]; then
    echo "$FLEXSERVERCTL_SOURCE"
    return 0
  fi
  if [[ -n "${INSTALLER_DIR:-}" ]]; then
    candidate="${INSTALLER_DIR}/${FLEXSERVERCTL_FILE_NAME}"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  fi
  return 1
}

# Fetch flexserverctl.py from the pinned repository. Fails closed and
# registers the download for cleanup at exit.
#
# NOTE: echoes the path. Callers must register the returned path themselves
# (register_flexserverctl_source) because a command substitution runs this in
# a subshell, so the += above is not visible to the caller.
download_flexserverctl_source() {
  local dest
  if ! command -v curl &>/dev/null; then
    echo "Error: curl is required to fetch ${FLEXSERVERCTL_FILE_NAME} in pipe mode." >&2
    return 1
  fi
  dest="$(mktemp)" || return 1
  if ! curl -fsSL -o "$dest" "$FLEXSERVERCTL_REPO_RAW_URL"; then
    rm -f "$dest"
    echo "Error: Could not download ${FLEXSERVERCTL_FILE_NAME} from ${FLEXSERVERCTL_REPO_RAW_URL}" >&2
    return 1
  fi
  echo "$dest"
}

# Record a resolved source path for cleanup. Must be called from the caller's
# shell, not from inside a $(…), or the registration is lost.
register_flexserverctl_source() {
  local src="${1-}"
  [[ -n "$src" ]] || return 1
  [[ -f "$src" ]] || return 1
  INSTALLER_TMP_FILES+=("$src")
}

# Resolve (and if needed fetch) a flexserverctl.py source, then verify it is
# present and syntactically valid. Sets the global FLEXSERVERCTL_SRC.
#
# Sets the global rather than echoing, because a command substitution would
# run this in a subshell: the temp-file registration inside would be lost, and
# any diagnostic on stdout would be captured as part of the "filename".
# Must be called before any mutation so a missing, broken or truncated source
# fails fast instead of leaving a half-configured host behind.
prepare_flexserverctl_source() {
  local src

  FLEXSERVERCTL_SRC=""
  if ! src="$(resolve_flexserverctl_source)"; then
    echo "  [flexserverctl] Source not on disk (pipe mode); fetching from repository..." >&2
    if ! src="$(download_flexserverctl_source)"; then
      echo "Error: Could not obtain ${FLEXSERVERCTL_FILE_NAME}." >&2
      return 1
    fi
    if ! register_flexserverctl_source "$src"; then
      rm -f "$src"
      echo "Error: Could not register ${FLEXSERVERCTL_FILE_NAME} for cleanup." >&2
      return 1
    fi
  fi

  if [[ ! -f "$src" ]]; then
    echo "Error: ${FLEXSERVERCTL_FILE_NAME} source not found: ${src}" >&2
    return 1
  fi

  # Syntax-check here, before any mutation, so a truncated pipe-mode download
  # or a broken --cli-source fails fast. install_flexserverctl() re-checks,
  # which is harmless and keeps it safe to call directly.
  if ! python3 - "$src" <<'PY'
import sys

path = sys.argv[1]
with open(path, "rb") as handle:
    compile(handle.read(), path, "exec")
PY
  then
    echo "Error: ${FLEXSERVERCTL_FILE_NAME} is not a valid Python 3 script: ${src}" >&2
    return 1
  fi

  FLEXSERVERCTL_SRC="$src"
}

# Install the CLI: install_flexserverctl <dest> [source]
#
# The optional second argument is a source already resolved and validated by
# prepare_flexserverctl_source(); passing it avoids resolving (and potentially
# downloading) a second time. The source is syntax-checked in memory again,
# then placed atomically (same-directory temp + rename) so a live CLI is never
# left truncated. Nothing is written outside <dest> besides the temp, so no
# __pycache__ lands next to the installed command.
install_flexserverctl() {
  local dest="${1:-$FLEXSERVERCTL_DEST_DEFAULT}"
  local src="${2-}" tmp_dest

  # Fall back to resolving here when called without a pre-resolved source.
  if [[ -z "$src" ]]; then
    if ! prepare_flexserverctl_source; then
      return 1
    fi
    src="$FLEXSERVERCTL_SRC"
  fi
  if [[ ! -f "$src" ]]; then
    echo "Error: ${FLEXSERVERCTL_FILE_NAME} source not found: ${src}" >&2
    return 1
  fi

  # Syntax-check before touching the destination. Compiling in memory avoids
  # py_compile writing a __pycache__ next to the source or destination.
  if ! python3 - "$src" <<'PY'
import sys

path = sys.argv[1]
with open(path, "rb") as handle:
    compile(handle.read(), path, "exec")
PY
  then
    echo "Error: ${FLEXSERVERCTL_FILE_NAME} is not a valid Python 3 script: ${src}" >&2
    return 1
  fi

  tmp_dest="$(mktemp "${dest}.tmp.XXXXXX")" || return 1
  if ! cp -f "$src" "$tmp_dest"; then
    rm -f "$tmp_dest"
    return 1
  fi
  if ! chown root:root "$tmp_dest" || ! chmod 0755 "$tmp_dest"; then
    rm -f "$tmp_dest"
    return 1
  fi
  if ! mv -f "$tmp_dest" "$dest"; then
    rm -f "$tmp_dest"
    return 1
  fi

  echo "  Installed ${FLEXSERVERCTL_COMMAND_NAME}: ${dest}"
}
