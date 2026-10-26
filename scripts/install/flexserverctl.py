#!/usr/bin/env python3
"""flexserverctl - safe backend URL cutover for the vps-manager stack.

Standalone, stdlib-only Python 3 CLI for Linux. Switches the backend URL for
the local agent without rotating credentials, validates the config, probes
health without sending secrets, performs one ordered transaction, verifies
actual delivery rather than mere service liveness, and rolls back byte-for-byte
with an explicit outcome.

Usage:
  flexserverctl help
  flexserverctl set-backend <URL> [--mode auto|systemd|user] [--dry-run]
  flexserverctl set-backend --url <URL> [--mode auto|systemd|user] [--dry-run]
  flexserverctl validate-url <URL>

Modes:
  auto     (default) pick systemd when running as root with a systemd agent
           install present, else user mode when ~/.vps-manager-agent exists.
  systemd  rewrite /etc/vps-manager-agent/config.json (backendUrl) only.
  user     rewrite ~/.vps-manager-agent/config.json (backendUrl) only.

Transaction (both modes), in this exact order:
  lock -> snapshot -> health probe -> stop -> write config -> delivery preflight
  -> restart -> postcheck. Any downstream failure stops the newly started
  loop, restores the original bytes/owner/mode, restarts the original process
  onto the restored config, and reports restored, or rollback-failed (hold) if
  the restore itself failed.

Guarantees:
  * A loop and a -once preflight never run concurrently.
  * Tokens (vma_...) are never printed; config contents are never logged.
  * Health is probed with a credential-free GET <url>/api/health: system TLS
    verification, no redirect followed, bounded timeout and body size, and a
    required {"ok": true} body shape.
  * http is accepted only for loopback hosts (agent config).
  * No host is allow- or deny-listed by name. Any syntactically valid https URL
    is accepted here; DNS/TLS/auth failures surface in the health probe and
    never bypass it.
  * Process identity uses /proc exe + cwd + full argv + starttime; there is no
    pkill/killall anywhere, and a kill is only ever issued against a process
    whose full identity was verified first.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

AGENT_CONFIG_PATH = "/etc/vps-manager-agent/config.json"
AGENT_BINARY = "/usr/local/bin/vps-manager-agent"
AGENT_UNIT = "vps-manager-agent.service"
USER_AGENT_DIR = ".vps-manager-agent"
USER_CONFIG_NAME = "config.json"
USER_PID_NAME = "vps-agent.pid"
LIFECYCLE_LOCK_NAME = "lifecycle.lock"
SYSTEMD_LOCK_NAME = "flexserverctl.lock"
RUN_LOCK_DIR = "/run/vps-manager-agent"


SYSTEMCTL_BIN = "systemctl"
TOKEN_RE = re.compile(r"vma_[A-Za-z0-9_\-]+")
HEALTH_TIMEOUT = 10
HEALTH_MAX_BYTES = 64 * 1024
BACKUP_SUFFIX = ".flexserverctl.bak"
PREFLIGHT_TIMEOUT = 60
SYSTEMCTL_TIMEOUT = 30
STOP_TERM_WAIT = 5.0
STOP_KILL_WAIT = 2.0
SPAWN_SETTLE = 0.2
STARTTIME_STABLE_POLLS = 3
STARTTIME_POLL_INTERVAL = 0.05
DETAIL_LIMIT = 300

# Recognised one-shot invocation argv shapes. A loop never carries these:
# `-once` pushes once and exits, `-host-only` pairs with `-once`, `-version`
# prints and exits, and `-provision-docker-state` exits without looping.
# All are Booleans in Go, so every combinational form counts: `-once`,
# `--once`, `-once=true`, `--once=true`, `-once 1` (via parse_go_flags).
NON_LOOP_FLAGS = ("once", "host-only", "version", "provision-docker-state", "validate-config")
# Go's flag package accepts `-flag value` and `-flag=value` for non-booleans,
# so `-config` also matches `--config`, `-config=/path`, `--config=/path`.
CONFIG_FLAG = "-config"
CONFIG_FLAG_NAMES = ("config", )

HELP_TEXT = """flexserverctl - safe backend URL cutover for the vps-manager stack

Usage:
  flexserverctl help
  flexserverctl set-backend <URL> [--mode auto|systemd|user] [--dry-run]
  flexserverctl set-backend --url <URL> [--mode auto|systemd|user] [--dry-run]
  flexserverctl validate-url <URL>

Commands:
  set-backend <URL>   Cut the local backend URL over atomically. When --dry-run
                      is given, nothing is written and no service is touched.
  validate-url <URL>  Validate a URL with zero side effects. Exit 0 when the
                      URL is acceptable, exit 1 otherwise.
  help                Print this text.

Options:
  --mode auto|systemd|user   Installation to target (default: auto).
                             auto prefers a root-owned systemd install, then
                             the user install; it fails when neither exists.
  --dry-run                  Validate and probe health only. No write, no stop,
                             no start, no backup file.

Outcomes:
  applied-with-heartbeat-confirmation-required
                             Configs written, loop restarted, preflight passed.
                             Server-side delivery is confirmed by the agent
                             heartbeat, not by this invocation.
  restored                   A failure after the write was rolled back
                             byte-for-byte and the original loop was restarted
                             onto the restored config.
  rollback-failed            The rollback itself failed. The .bak files are
                             retained on purpose; operator must intervene.
"""


def redact(text: str) -> str:
    return TOKEN_RE.sub("[redacted]", text)


def eprint(*parts: object) -> None:
    sys.stderr.write(redact(" ".join(str(p) for p in parts)) + "\n")
    sys.stderr.flush()


def fail(msg: str, code: int = 1):
    eprint("Error:", msg)
    raise SystemExit(code)


def is_linux() -> bool:
    return sys.platform.startswith("linux")


def assert_linux() -> None:
    if not is_linux():
        fail("flexserverctl is Linux-only (it manages systemd units and reads /proc)")


# --- path resolution -------------------------------------------------------


def _env_path(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def proc_root() -> str:
    return _env_path("FLEXSERVERCTL_PROC_ROOT", "/proc")


def home_dir() -> str:
    return _env_path("FLEXSERVERCTL_HOME", os.path.expanduser("~"))


def user_agent_dir() -> str:
    return os.path.join(home_dir(), USER_AGENT_DIR)


def user_config_path() -> str:
    return _env_path("FLEXSERVERCTL_USER_CONFIG", os.path.join(user_agent_dir(), USER_CONFIG_NAME))


def user_pid_path() -> str:
    return os.path.join(user_agent_dir(), USER_PID_NAME)


def user_lock_path() -> str:
    return os.path.join(user_agent_dir(), LIFECYCLE_LOCK_NAME)

def resolve_agent_unit(agent_cfg_path: str = "", vps_id: str = "") -> str:
    """Resolve the systemd service name for the agent.

    Uses FLEXSERVERCTL_AGENT_UNIT env override if set.
    Checks for the canonical default AGENT_UNIT on disk or unified unit
    vps-agent-${sha256(vpsId)}.service on disk, falling back to AGENT_UNIT.
    """
    override = os.environ.get("FLEXSERVERCTL_AGENT_UNIT", "").strip()
    if override:
        return override
    if os.path.exists(f"/etc/systemd/system/{AGENT_UNIT}") or os.path.exists(f"/lib/systemd/system/{AGENT_UNIT}"):
        return AGENT_UNIT
    if not vps_id and agent_cfg_path and os.path.exists(agent_cfg_path):
        try:
            cfg = load_json_file(agent_cfg_path)
            vps_id = cfg.get("vpsId", "")
        except Exception:
            pass
    if vps_id:
        vps_hash = hashlib.sha256(str(vps_id).encode("utf-8")).hexdigest().lower()
        unit = f"vps-agent-{vps_hash}.service"
        if os.path.exists(f"/etc/systemd/system/{unit}") or os.path.exists(f"/lib/systemd/system/{unit}"):
            return unit
    return AGENT_UNIT


def systemd_lock_path() -> str:
    """CLI-internal systemd-mode lock.

    Deliberately NOT the parent API's lock name: the API's lifecycle lock is a
    user-mode (~/.vps-manager-agent) construct, and a stale API-held lock must
    not permanently block root-side migrations.
    """
    parent = os.path.dirname(os.path.abspath(agent_config_path()))
    return _env_path("FLEXSERVERCTL_SYSTEMD_LOCK", os.path.join(parent, SYSTEMD_LOCK_NAME))


def agent_config_path() -> str:
    return _env_path("FLEXSERVERCTL_AGENT_CONFIG", AGENT_CONFIG_PATH)


def user_agent_bin_path() -> str:
    """Default user-mode agent binary.

    Mirrors the API installer and the user README: a user install places the
    loop at ~/.vps-manager-agent/vps-agent (plus a vps-agent.exe sibling on
    Windows). The systemd default differs and stays unchanged; an explicit
    FLEXSERVERCTL_AGENT_BIN override still wins in either mode.
    """
    override = _env_path("FLEXSERVERCTL_AGENT_BIN", "")
    if override:
        return override
    return os.path.join(user_agent_dir(), "vps-agent.exe" if os.name == "nt" else "vps-agent")


def systemctl_bin() -> str:
    return _env_path("FLEXSERVERCTL_SYSTEMCTL_BIN", SYSTEMCTL_BIN)



def systemd_present() -> bool:
    return os.path.isdir("/run/systemd/system") or shutil.which(SYSTEMCTL_BIN) is not None


def detect_mode() -> str:
    """auto: prefer a root-owned systemd install, else the user install."""
    if os.geteuid() == 0 and os.path.exists(agent_config_path()) and systemd_present():
        return "systemd"
    if os.path.exists(user_config_path()):
        return "user"
    fail(
        "cannot auto-detect an installation: neither "
        f"{agent_config_path()} nor {user_config_path()} exists; "
        "pass --mode systemd or --mode user explicitly"
    )


# --- URL validation (agent config.go Validate + bootstrap validateBackendUrl) ---


def _strip_brackets(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        return host[1:-1]
    return host


def is_loopback_host(host: str) -> bool:
    return _strip_brackets(host) in ("localhost", "127.0.0.1", "::1")


def validate_backend_url(raw: str) -> str:
    """Validate a migration-target backend URL.

    Host-agnostic by design: no host is allow- or deny-listed. A syntactically
    valid https URL is always accepted here; reachability, DNS, TLS and
    authentication are resolved later by the credential-free health probe.
    """
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("backend URL is required")
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError as exc:
        raise ValueError(f"invalid backend URL: {exc}") from exc
    if not parsed.scheme or not parsed.hostname:
        raise ValueError(f"backend URL must be a valid absolute URL: {raw}")
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f'backend URL scheme must be http or https, got "{parsed.scheme}"')
    if parsed.username or parsed.password or "@" in (parsed.netloc or ""):
        raise ValueError("backend URL must not carry userinfo")
    if scheme == "http" and not is_loopback_host(parsed.hostname):
        raise ValueError(
            f'backend URL must use https (http is only allowed for loopback, '
            f'got "{parsed.hostname}")'
        )
    normalized = raw.rstrip("/")
    if not normalized:
        raise ValueError(f"invalid backend URL: {raw}")
    return normalized


# --- config schema validation ---------------------------------------------

AGENT_REQUIRED_KEYS = (
    "backendUrl",
    "vpsId",
    "token",
    "intervalSeconds",
    "requestTimeoutSeconds",
)


def validate_agent_config(cfg) -> dict:
    """Mirror packages/agent/internal/config/config.go Validate()."""
    if not isinstance(cfg, dict):
        raise ValueError("agent config must be a JSON object")
    for key in AGENT_REQUIRED_KEYS:
        if cfg.get(key) in (None, ""):
            raise ValueError(f"agent config is missing required key {key!r}")
    for key in ("intervalSeconds", "requestTimeoutSeconds"):
        value = cfg[key]
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f"agent config {key} must be an integer")
        if key == "intervalSeconds" and value < 1:
            raise ValueError("agent config intervalSeconds must be >= 1")
        if key == "requestTimeoutSeconds" and value <= 0:
            raise ValueError("agent config requestTimeoutSeconds must be > 0")
    state_path = cfg.get("statePath")
    if state_path is not None and not isinstance(state_path, str):
        raise ValueError("agent config statePath must be a string when present")
    validate_backend_url(str(cfg["backendUrl"]))
    return cfg



# --- config writing: snapshot, atomic replace, verified restore ------------


def load_json_file(path: str) -> dict:
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except FileNotFoundError as exc:
        raise ValueError(f"cannot read {path}: file not found") from exc
    except OSError as exc:
        raise ValueError(f"cannot read {path}: {exc}") from exc
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"cannot parse {path} as JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return parsed


def file_identity(path: str):
    """(uid, gid, mode) for path.

    Raises OSError when the identity cannot be read. An unreadable identity is
    a real failure (race, deletion, permissions, I/O) and must NOT silently
    fall back to root:root 0o644, which would break owner/mode preservation on
    configs that belong to a non-root user.
    """
    st = os.stat(path)
    return (st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode))


def backup_path(path: str) -> str:
    return path + BACKUP_SUFFIX


def serialize_json(obj) -> bytes:
    return (json.dumps(obj, indent=2, sort_keys=False) + "\n").encode("utf-8")


def safe_chown(path: str, uid: int, gid: int) -> None:
    """chown that propagates real failures. Never silently ignored on Linux."""
    if not is_linux():
        return
    os.chown(path, uid, gid)


def make_backup(path: str) -> bytes:
    """Snapshot the original bytes in memory and to the .bak sidecar.

    Refuses to overwrite a retained backup: `rollback-failed` deliberately
    keeps the sidecar for operator recovery, so a later attempt must not
    silently truncate the evidence. Mode/owner are preserved and a permission
    failure is never swallowed.
    """
    target = backup_path(path)
    if os.path.exists(target):
        raise ValueError(
            f"a backup already exists at {target}; a previous transaction left it "
            "there deliberately (rollback-failed). Remove it manually if that "
            "transaction has been handled."
        )
    try:
        with open(path, "rb") as fh:
            original = fh.read()
    except OSError as exc:
        raise ValueError(f"cannot snapshot {path}: {exc}") from exc
    identity = file_identity(path)
    umask = os.umask(0)
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    finally:
        os.umask(umask)
    with os.fdopen(fd, "wb") as fh:
        fh.write(original)
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(target, identity[2])
    safe_chown(target, identity[0], identity[1])
    return original


def atomic_write_json(path: str, obj: dict, identity=None) -> None:
    """Replace path's content atomically, preserving mode/owner.

    `identity` must be a real (uid, gid, mode) triple. There is no fallback to
    root:root 0o644: if the identity is unknown the caller has already refused
    the transaction, so writing a wrongly-owned config is never possible.
    """
    data = serialize_json(obj)
    if identity is None:
        identity = file_identity(path)
    directory = os.path.dirname(os.path.abspath(path)) or "."
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".flexserverctl-", dir=directory)
    try:
        with os.fdopen(tmp_fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_path, identity[2])
        safe_chown(tmp_path, identity[0], identity[1])
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def restore_backup_with_identity(config: str, identity) -> None:
    """Restore the backup bytes, then owner/mode. Raises on any real failure."""
    if not identity:
        raise ValueError(f"no recorded identity for {config}; refusing to restore blindly")
    src = backup_path(config)
    if not os.path.exists(src):
        raise ValueError(f"no backup at {src}; cannot restore {config}")
    with open(src, "rb") as fh:
        restored = fh.read()
    directory = os.path.dirname(os.path.abspath(config)) or "."
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=".flexserverctl-restore-", dir=directory)
    try:
        with os.fdopen(tmp_fd, "wb") as fh:
            fh.write(restored)
        os.chmod(tmp_path, identity[2])
        os.replace(tmp_path, config)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    os.chmod(config, identity[2])
    safe_chown(config, identity[0], identity[1])


def cleanup_backups(*paths: str) -> None:
    """Delete the .bak sidecars. Only for a verified-successful transaction."""
    for path in paths:
        try:
            os.unlink(backup_path(path))
        except OSError:
            pass


def hold_backups(*paths: str) -> None:
    for path in paths:
        if os.path.exists(backup_path(path)):
            eprint(f"holding backup for operator review: {backup_path(path)}")


# --- health probe: credential-free, no redirects, bounded, shape-checked ----


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


# Historical private spelling; retained so either import name resolves.
_NoRedirect = NoRedirect


def health_probe(base_url: str, timeout: int = HEALTH_TIMEOUT):
    target = base_url.rstrip("/") + "/api/health"
    opener = urllib.request.build_opener(
        NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context())
    )
    # Cloudflare (error 1010) rejects the default `Python-urllib/3.x` agent
    # string, which is exactly the kind of false negative that would strand a
    # valid migration. An explicit honest UA identifies the tool instead.
    request = urllib.request.Request(
        target,
        method="GET",
        headers={"Accept": "application/json", "User-Agent": "flexserverctl/1.0"},
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                return False, f"{target} returned HTTP {status}"
            body = response.read(HEALTH_MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        return False, f"{target} returned HTTP {exc.code}"
    except Exception as exc:  # DNS, TLS, connect, timeout
        return False, f"probe of {target} failed: {exc}"
    if len(body) > HEALTH_MAX_BYTES:
        return False, f"{target} body exceeds {HEALTH_MAX_BYTES} bytes"
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return False, f"{target} did not return valid JSON"
    if isinstance(payload, dict) and payload.get("ok") is True:
        return True, f"{target} health ok:true"
    return False, f"{target} missing ok:true in response body"


# --- lifecycle lock (mkdir semantics, mirroring the API's remote lock) -----


class LifecycleLock:
    """Advisory exclusive lock implemented as a directory, like the API."""

    def __init__(self, lock_path: str):
        self.lock_path = lock_path
        self.held = False

    def acquire(self) -> bool:
        try:
            os.mkdir(self.lock_path)
        except OSError:
            return False
        self.held = True
        try:
            with open(os.path.join(self.lock_path, "owner"), "w") as fh:
                fh.write(str(os.getpid()))
        except OSError:
            pass
        return True

    def release(self) -> None:
        if not self.held:
            return
        # Invariant: Root lock inode in /run/vps-manager-agent must NEVER be unlinked.
        if self.lock_path.startswith(RUN_LOCK_DIR):
            self.held = False
            return
        try:
            os.rmdir(self.lock_path)
        except OSError:
            shutil.rmtree(self.lock_path, ignore_errors=True)
        self.held = False

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
        return False


# --- /proc readers (seam-injectable root for portable testing) ------------


def _proc_entry(pid) -> str:
    return os.path.join(proc_root(), str(pid))


def pid_alive(pid) -> bool:
    try:
        return os.path.isdir(_proc_entry(pid))
    except (TypeError, ValueError):
        return False


def read_cmdline(pid):
    try:
        with open(os.path.join(_proc_entry(pid), "cmdline"), "rb") as fh:
            raw = fh.read()
    except OSError:
        return []
    return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part != b""]


def read_exe(pid):
    try:
        return os.path.realpath(os.path.join(_proc_entry(pid), "exe"))
    except OSError:
        return ""


def read_cwd(pid):
    try:
        return os.path.realpath(os.path.join(_proc_entry(pid), "cwd"))
    except OSError:
        return ""


def read_starttime(pid):
    """Field 22 of /proc/<pid>/stat, robust to spaces in comm."""
    try:
        with open(os.path.join(_proc_entry(pid), "stat"), "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return ""
    close = raw.rfind(")")
    if close == -1:
        return ""
    rest = raw[close + 1:].split()
    if len(rest) < 20:
        return ""
    return rest[19]


def read_pid_file(path: str):
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


def canonical(path) -> str:
    return os.path.realpath(os.path.abspath(str(path)))


def resolve_argv0(argv, cwd: str) -> str:
    """Canonical form of argv[0] as Linux resolves it for exe matching."""
    argv0 = str(argv[0]) if argv else ""
    if not argv0:
        return ""
    if not os.path.isabs(argv0) and cwd:
        argv0 = os.path.join(cwd, argv0)
    return canonical(argv0)


def list_pids():
    try:
        entries = os.listdir(proc_root())
    except OSError:
        return []
    return sorted(int(name) for name in entries if name.isdigit())


def parse_go_flags(argv) -> dict:
    """Parse a process argv the way Go's flag package parses argv.

    Accepted shapes (identical to flag.Parse):
        -flag value   --flag value
        -flag=value   --flag=value
        -bool         -bool=true   -bool=false   -bool=0   -bool=1
        -              (terminates parsing)

    Returns {flag_name: value}. A bare boolean is True; a non-boolean looking
    flag without a value raises, which is why a caller must not require one to
    be present. Unknown flags are still returned so a caller can detect extra
    Docker-identity argv without knowing its semantics.

    Argv[0] (the binary path) is always skipped.
    """
    parsed = {}
    index = 1
    argv = list(argv)
    while index < len(argv):
        token = argv[index]
        if token == "-" or token == "--":
            break
        if not token.startswith("-") or token == "-":
            index += 1
            continue
        body = token[1:]
        name, eq, inline = body.partition("=")
        normalised = name.lstrip("-")
        if eq:
            if inline in ("true", "1", "t", "TRUE", "True"):
                parsed[normalised] = True
            elif inline in ("false", "0", "f", "FALSE", "False"):
                parsed[normalised] = False
            else:
                parsed[normalised] = inline
        else:
            value = ""
            if index + 1 < len(argv):
                value = argv[index + 1]
            if (
                normalised in NON_LOOP_FLAGS
                and not (value.startswith("-") and len(value) > 1 and not _looks_numeric(value))
            ):
                # A boolean flag with a separate space-delimited token is not a
                # value in Go; treat it as already set and resume at next token.
                parsed[normalised] = True
            elif value.startswith("-") and len(value) > 1 and not _looks_numeric(value):
                parsed[normalised] = True
            else:
                parsed[normalised] = value
                index += 1
        index += 1
    return parsed


def _bool_token(text: str) -> bool:
    return str(text).strip().lower() in ("true", "1", "t")


def _looks_numeric(text: str) -> bool:
    try:
        float(text)
        return True
    except (TypeError, ValueError):
        return False


def is_loop_argv(argv) -> bool:
    """True for a managed loop argv, False for every one-shot shape."""
    if not argv:
        return False
    parsed = parse_go_flags(argv)
    for token in NON_LOOP_FLAGS:
        if parsed.get(token) is True or parsed.get(token) == "true":
            return False
    for name in CONFIG_FLAG_NAMES:
        if parsed.get(name):
            return True
    return False


def loop_config_from_argv(argv, cwd: str):
    """Canonical -config value from a loop argv.

    A relative -config resolves against the supplied cwd, which callers obtain
    from that process's own /proc/<pid>/cwd *before* calling this.
    """
    parsed = parse_go_flags(argv)
    value = None
    for name in CONFIG_FLAG_NAMES:
        if parsed.get(name):
            value = parsed[name]
            break
    if not value:
        return None
    if not os.path.isabs(value):
        if not cwd:
            return None
        value = os.path.join(cwd, value)
    return canonical(value)


def find_managed_processes(binary: str, config: str):
    """Enumerate processes that own the managed loop: exe + full argv match."""
    binary_c = canonical(binary)
    config_c = canonical(config)
    found = []
    for pid in list_pids():
        if pid == os.getpid():
            continue
        argv = read_cmdline(pid)
        if not argv or not is_loop_argv(argv):
            continue
        if read_exe(pid) != binary_c:
            continue
        proc_cwd = read_cwd(pid)
        resolved = loop_config_from_argv(argv, proc_cwd)
        if resolved is None or resolved != config_c:
            continue
        found.append(
            {"pid": str(pid), "starttime": read_starttime(pid), "argv": argv, "cwd": proc_cwd}
        )
    return found


def classify_inspection(matches, pid_file: str, liveness_root: str = ""):
    """Pure mirror of classifyManagedProcessInspection in
    packages/api/src/agents/agent-lifecycle-remote.ts.

    `liveness_root` overrides the /proc root used for the "is that PID alive"
    probe, so callers on non-Linux hosts can point at a fake tree.
    """
    match_list = list(matches or [])
    count = len(match_list)
    owned = match_list[0] if count == 1 else None
    exists = os.path.exists(pid_file)
    content = read_pid_file(pid_file) if exists else None

    def _alive(pid) -> bool:
        if liveness_root:
            return os.path.isdir(os.path.join(liveness_root, str(pid)))
        return pid_alive(pid)

    if count > 1:
        return "ambiguous"
    if not exists:
        return "none" if count == 0 else "ambiguous"
    pid = content or ""
    if pid == "" or not pid.isdigit():
        return "invalid"
    if count == 0:
        return "mismatch" if _alive(pid) else "none"
    if owned is not None and pid == str(owned.get("pid")):
        return f"owned:{pid}:{owned.get('starttime')}"
    return "mismatch"


# --- command execution ----------------------------------------------------


def run_cmd(argv, timeout=60, cwd=None, env=None):
    """Run a subprocess, never raising on non-zero. Returns (rc, output)."""
    try:
        completed = subprocess.run(
            list(argv),
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            text=True,
        )
    except FileNotFoundError as exc:
        return 127, f"{argv[0]}: not found: {exc}"
    except subprocess.TimeoutExpired:
        return 124, f"{' '.join(str(a) for a in argv)} timed out after {timeout}s"
    except OSError as exc:
        return 126, f"{argv[0]}: {exc}"
    return completed.returncode, completed.stdout or ""


def run_systemctl(args, timeout=SYSTEMCTL_TIMEOUT):
    return run_cmd([systemctl_bin()] + list(args), timeout=timeout)

def run_agent_validate_config(agent_bin: str, config: str, timeout=PREFLIGHT_TIMEOUT):
    """Preflight validation using -validate-config."""
    argv = [agent_bin, CONFIG_FLAG, config, "-validate-config"]
    return run_cmd(argv, timeout=timeout)


def run_agent_once(agent_bin: str, config: str, state_path: str, timeout=PREFLIGHT_TIMEOUT):
    """Delivery preflight: one isolated push with the candidate config.

    The disposable state path keeps the real persisted state untouched, and the
    caller guarantees no loop is running concurrently.
    """
    argv = [agent_bin, CONFIG_FLAG, config, "-state", state_path, "-once", "-host-only"]
    return run_cmd(argv, timeout=timeout)


# --- process ownership, stop, transactional start -------------------------


def owns_process(pid, exe: str, argv, cwd: str, starttime: str, config: str = "") -> bool:
    """Full identity check: starttime AND exe AND complete argv (and config).

    Never a bare `kill`; the caller has already resolved every field of the
    identity. Returns False (never a partial truth) when anything mismatches.
    """
    if not pid:
        return False
    if str(read_starttime(pid) or "") != str(starttime or ""):
        return False
    if read_exe(pid) != canonical(exe):
        return False
    if read_cmdline(pid) != list(argv):
        return False
    proc_cwd = read_cwd(pid)
    if cwd and proc_cwd != cwd:
        return False
    if config:
        return loop_config_from_argv(list(argv), proc_cwd) == canonical(config)
    return True


def _same_spawn(pid, starttime: str) -> bool:
    """Identity for the spawn/teardown window: starttime + pid only."""
    return bool(pid) and str(read_starttime(pid) or "") == str(starttime or "")


def stop_exact_process(proc: dict, exe: str, config: str) -> bool:
    """TERM then KILL an owned process, revalidating identity before every
    signal. Returns True only when the process is gone; returns False (never
    truthy) when the identity never matched, so a caller can never mistake
    "not ours" for "stopped"."""
    pid = str(proc.get("pid", ""))
    starttime = str(proc.get("starttime", ""))
    argv = list(proc.get("argv", []))
    cwd = proc.get("cwd", "") or read_cwd(pid)
    resolved_config = loop_config_from_argv(argv, cwd)

    def owned() -> bool:
        if str(read_starttime(pid) or "") != starttime:
            return False
        if read_exe(pid) != canonical(exe):
            return False
        if read_cmdline(pid) != argv:
            return False
        return resolved_config == canonical(config)

    if not owned():
        # Not ours. Never signal an unrelated process; report non-ownership.
        return not pid_alive(pid)

    def _signal(sig) -> bool:
        if not owned():
            return False
        try:
            os.kill(int(pid), sig)
        except OSError:
            return not pid_alive(pid)
        return True

    _signal(signal.SIGTERM)
    deadline = time.monotonic() + STOP_TERM_WAIT
    while time.monotonic() < deadline:
        if not owned():
            return True
        time.sleep(0.1)
    _signal(signal.SIGKILL)
    deadline = time.monotonic() + STOP_KILL_WAIT
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.1)
    return not pid_alive(pid)


def _stable_starttime(pid) -> str:
    """Poll starttime until it repeats, so a PID-reuse race cannot fool us."""
    previous = read_starttime(pid)
    stable = 0
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        current = read_starttime(pid)
        if not current:
            stable = 0
            previous = ""
        elif current == previous:
            stable += 1
            if stable >= STARTTIME_STABLE_POLLS - 1:
                return current
        else:
            previous = current
            stable = 0
        time.sleep(STARTTIME_POLL_INTERVAL)
    return ""


class SpawnedLoop:
    """A spawned loop plus everything needed to verify or tear it down."""

    def __init__(self, pid, exe, config, argv, cwd, starttime):
        self.pid = str(pid)
        self.exe = exe
        self.config = config
        self.argv = list(argv)
        self.cwd = cwd
        self.starttime = starttime
        self.published = False
        self.tmp_pid_file = ""

    def __bool__(self) -> bool:
        return True


def spawn_verified_loop(exe: str, config: str, pid_file: str, cwd: str = "", argv=None):
    """Spawn a loop, verify its full identity, then publish the pid file.

    `argv` may be supplied by the caller to preserve an original loop's exact
    command line (relative -config, -state, -docker-identity-path, ...) when
    resuming; it defaults to `<exe> -config <config>`.

    The child handle is retained so teardown targets exactly the process we
    spawned. A starttime is captured immediately after the spawn, before any
    stable-poll can fail, so teardown is never a bare PID cleanup on an unknown
    identity: if the starttime changes underneath us (pid reuse) teardown gives
    up rather than signal an unrelated process.
    """
    resolved_cwd = cwd or canonical(os.path.dirname(os.path.abspath(config)))
    loop_argv = list(argv) if argv else [exe, CONFIG_FLAG, config]
    umask = os.umask(0o077)
    try:
        handle = subprocess.Popen(
            loop_argv, cwd=resolved_cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    finally:
        os.umask(umask)
    pid = str(handle.pid)
    # Capture an identity immediately; never leave it empty while the child lives.
    initial_starttime = read_starttime(pid) or ""
    spawned = SpawnedLoop(pid, exe, config, loop_argv, resolved_cwd, initial_starttime)

    def teardown() -> None:
        if (
            spawned.starttime
            and handle.poll() is None
            and _same_spawn(pid, spawned.starttime)
        ):
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                pass
            deadline = time.monotonic() + STOP_TERM_WAIT
            while time.monotonic() < deadline and _same_spawn(pid, spawned.starttime):
                time.sleep(0.1)
            if _same_spawn(pid, spawned.starttime):
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except OSError:
                    pass
                deadline = time.monotonic() + STOP_KILL_WAIT
                while time.monotonic() < deadline and _same_spawn(pid, spawned.starttime):
                    time.sleep(0.1)
        if spawned.tmp_pid_file:
            try:
                os.unlink(spawned.tmp_pid_file)
            except OSError:
                pass
            spawned.tmp_pid_file = ""
        if spawned.published and read_pid_file(pid_file) == pid:
            try:
                os.unlink(pid_file)
            except OSError:
                pass
            spawned.published = False

    def die(reason: str):
        teardown()
        try:
            handle.wait(timeout=1)
        except Exception:
            pass
        raise RuntimeError(f"spawn verification failed for pid {pid}: {reason}")

    time.sleep(SPAWN_SETTLE)
    starttime = _stable_starttime(pid)
    if not starttime:
        # Re-read (the child is alive and may simply be slow to settle) so
        # teardown still has a real identity to validate against.
        spawned.starttime = read_starttime(pid) or spawned.starttime
        die("unstable or unreadable starttime (pid reuse suspected)")
    spawned.starttime = starttime
    if handle.poll() is not None:
        die("loop exited before verification")
    if not owns_process(pid, exe, loop_argv, resolved_cwd, starttime, config):
        die("spawned process failed identity verification")

    tmp_pid = f"{pid_file}.tmp.{pid}.{starttime}"
    if os.path.exists(tmp_pid):
        die("temporary pid file already exists")
    spawned.tmp_pid_file = tmp_pid
    try:
        with open(tmp_pid, "w") as fh:
            fh.write(pid + "\n")
    except OSError as exc:
        die(f"cannot write temporary pid file: {exc}")

    if not owns_process(pid, exe, loop_argv, resolved_cwd, starttime, config):
        die("identity changed between spawn and publish")

    try:
        os.replace(tmp_pid, pid_file)
    except OSError as exc:
        die(f"cannot publish pid file: {exc}")
    spawned.tmp_pid_file = ""
    spawned.published = True

    if handle.poll() is not None or not owns_process(
        pid, exe, loop_argv, resolved_cwd, starttime, config
    ):
        die("loop did not survive post-publish verification")
    return spawned


def start_transactional_loop(exe: str, config: str, pid_file: str, cwd: str = "", argv=None):
    """Public alias for spawn_verified_loop."""
    return spawn_verified_loop(exe, config, pid_file, cwd, argv=argv)



# --- cutover transaction --------------------------------------------------


class Outcome:
    SUCCESS = "applied-with-heartbeat-confirmation-required"
    RESTORED = "restored"
    ROLLBACK_FAILED = "rollback-failed"


def _verify_restore(path: str, original: bytes) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read() == original
    except OSError:
        return False


def _stop_spawned(pid: str) -> None:
    if not pid or not pid_alive(pid):
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(int(pid), sig)
        except OSError:
            return
        deadline = time.monotonic() + (STOP_TERM_WAIT if sig == signal.SIGTERM else STOP_KILL_WAIT)
        while time.monotonic() < deadline and pid_alive(pid):
            time.sleep(0.1)
        if not pid_alive(pid):
            return


def _preflight(agent_bin: str, config: str):
    """Candidate config validation using -validate-config.

    Validates candidate configuration offline without lock acquisition,
    state mutation, or network requests.
    """
    rc, out = run_agent_validate_config(agent_bin, config)
    if rc == 0:
        return True, "preflight ok"
    return False, f"preflight failed rc={rc}: {redact(' '.join((out or '').split()))[:DETAIL_LIMIT]}"

def _health_gate(url: str):
    return health_probe(url)


def _rollback(agent_cfg, agent_backup, agent_identity):
    """Best-effort rollback. Returns True only when the restore verified.

    Identities are captured before the write, so a rollback restores the
    original owner/mode rather than whatever the interrupted write left.
    """
    ok = True
    try:
        restore_backup_with_identity(agent_cfg, agent_identity)
        if not _verify_restore(agent_cfg, agent_backup):
            ok = False
            eprint(f"post-restore verification failed for {agent_cfg}")
    except Exception as exc:
        ok = False
        eprint(f"restore of {agent_cfg} failed: {redact(str(exc))}")
    return ok


def _stopped_units_recover(units) -> None:
    """Best-effort restart of every unit we stopped, on a failure path."""
    for unit in units:
        run_systemctl(["reset-failed", unit])
        run_systemctl(["restart", unit])


def do_systemd_cutover(new_url: str, dry_run: bool = False) -> int:
    """Run a systemd agent cutover under the CLI's lifecycle lock."""
    assert_linux()
    new_url = validate_backend_url(new_url)
    if dry_run:
        ok, detail = _health_gate(new_url)
        if not ok:
            fail(f"health probe refused {new_url}: {detail}")
        print("dry-run: no changes applied")
        return 0
    lock = LifecycleLock(systemd_lock_path())
    if not lock.acquire():
        fail(f"another lifecycle operation holds {systemd_lock_path()}")
    try:
        return _do_systemd_cutover_locked(
            new_url,
            agent_config_path(),
            _env_path("FLEXSERVERCTL_AGENT_BIN", AGENT_BINARY),
        )
    finally:
        lock.release()


def _do_systemd_cutover_locked(new_url, agent_cfg, agent_bin):
    agent_cfg_data = load_json_file(agent_cfg)
    validate_agent_config(agent_cfg_data)

    ok, detail = _health_gate(new_url)
    if not ok:
        fail(f"health probe refused {new_url}: {detail}")

    # Everything past this point runs under the transaction: any failure must
    # either roll back or recover the unit we stopped. The identity is captured
    # inside the protected region so a rollback always restores the true
    # original owner/mode rather than a fallback.
    try:
        agent_identity = file_identity(agent_cfg)
        agent_backup = make_backup(agent_cfg)
    except Exception as exc:
        fail(f"cannot snapshot configs: {redact(str(exc))}")

    agent_unit = resolve_agent_unit(agent_cfg, agent_cfg_data.get("vpsId", ""))
    rc, out = run_systemctl(["stop", agent_unit])
    if rc != 0:
        hold_backups(agent_cfg)
        fail(f"systemctl stop {agent_unit} failed rc={rc}: {redact(out.strip())[:200]}")

    # Prove process exited before proceeding
    for _ in range(50):
        rc_active, _ = run_systemctl(["is-active", "--quiet", agent_unit])
        if rc_active != 0:
            break
        time.sleep(0.1)
    else:
        hold_backups(agent_cfg)
        _stopped_units_recover([agent_unit])
        fail(f"systemctl stop {agent_unit} failed: process still active after stop")

    reason = ""
    try:
        agent_cfg_data["backendUrl"] = new_url
        atomic_write_json(agent_cfg, agent_cfg_data, agent_identity)

        ok, detail = _preflight(agent_bin, agent_cfg)
        if not ok:
            raise RuntimeError(detail)

        rc, out = run_systemctl(["reset-failed", agent_unit])
        if rc != 0:
            eprint(f"warning: reset-failed {agent_unit} rc={rc}")
        rc, out = run_systemctl(["restart", agent_unit])
        if rc != 0:
            raise RuntimeError(
                f"systemctl restart {agent_unit} failed rc={rc}: {redact(out.strip())[:200]}"
            )
        rc, out = run_systemctl(["is-active", agent_unit])
        if rc != 0:
            raise RuntimeError(
                f"systemctl is-active {agent_unit} reported inactive after restart: "
                f"{redact(out.strip())[:200]}"
            )
    except Exception as exc:
        reason = redact(str(exc))
        rollback_ok = _rollback(agent_cfg, agent_backup, agent_identity)
        # The restored bytes only take effect once the unit is stopped and
        # restarted onto them: a `start` on an already-running unit would leave
        # the loop holding the new URL in memory.
        run_systemctl(["stop", agent_unit])
        recovered = True
        run_systemctl(["reset-failed", agent_unit])
        rc, out = run_systemctl(["restart", agent_unit])
        if rc != 0:
            recovered = False
            eprint(f"warning: restart {agent_unit} failed rc={rc}")
        else:
            rc, out = run_systemctl(["is-active", agent_unit])
            if rc != 0:
                recovered = False
                eprint(f"warning: {agent_unit} not active after restart rc={rc}")
        if rollback_ok and recovered:
            cleanup_backups(agent_cfg)
            eprint("restored:", reason)
            return 1
        hold_backups(agent_cfg)
        eprint(
            "rollback-failed:",
            reason,
            "; config may not be safely restored and/or the original loop could "
            "not be restarted onto it, so backups are retained",
        )
        return 1

    cleanup_backups(agent_cfg)
    print(Outcome.SUCCESS)
    return 0



def do_user_cutover(new_url: str, dry_run: bool = False) -> int:
    """user-mode cutover. Returns an exit code."""
    assert_linux()
    new_url = validate_backend_url(new_url)
    agent_cfg = user_config_path()
    agent_bin = user_agent_bin_path()
    pid_file = user_pid_path()
    lock = LifecycleLock(user_lock_path())

    if dry_run:
        ok, detail = _health_gate(new_url)
        if not ok:
            fail(f"health probe refused {new_url}: {detail}")
        print("dry-run: no changes applied")
        return 0

    if not lock.acquire():
        fail(f"another lifecycle operation holds {user_lock_path()}")
    try:
        return _do_user_cutover_locked(new_url, agent_cfg, agent_bin, pid_file)
    finally:
        lock.release()


def _do_user_cutover_locked(new_url, agent_cfg, agent_bin, pid_file):
    agent_cfg_data = load_json_file(agent_cfg)
    validate_agent_config(agent_cfg_data)

    ok, detail = _health_gate(new_url)
    if not ok:
        fail(f"health probe refused {new_url}: {detail}")

    matches = find_managed_processes(agent_bin, agent_cfg)
    classification = classify_inspection(matches, pid_file)
    if classification == "ambiguous":
        fail(f"refusing to act: process inspection ambiguous ({len(matches)} matches)")
    if classification == "mismatch":
        fail(
            "refusing to act: pid file disagrees with the running process "
            f"({pid_file}); inspect and remove the stale pid file manually"
        )
    if classification == "invalid":
        fail(f"refusing to act: {pid_file} does not contain a plain PID")

    original = matches[0] if matches else None
    was_active = original is not None
    old_argv = list(original.get("argv", [])) if original else None
    old_cwd = original.get("cwd", "") if original else ""
    try:
        agent_identity = file_identity(agent_cfg)
        agent_backup = make_backup(agent_cfg)
    except Exception as exc:
        fail(f"cannot snapshot agent config: {redact(str(exc))}")

    spawned = None
    try:
        if original:
            if not stop_exact_process(original, agent_bin, agent_cfg):
                raise RuntimeError("could not stop the existing loop (identity lost)")

        agent_cfg_data["backendUrl"] = new_url
        atomic_write_json(agent_cfg, agent_cfg_data, agent_identity)

        ok, detail = _preflight(agent_bin, agent_cfg)
        if not ok:
            raise RuntimeError(detail)

        # Preserve the original loop's exact argv (custom -config form, -state,
        # -docker-identity-path, ...) so the resumed loop is not simplified.
        spawned = spawn_verified_loop(
            agent_bin, agent_cfg, pid_file, old_cwd, argv=old_argv if was_active else None
        )
    except Exception as exc:
        reason = redact(str(exc))
        rollback_ok = _rollback(agent_cfg, agent_backup, agent_identity)
        if rollback_ok:
            _stop_spawned(spawned.pid if spawned else "")
            resumed = True
            if was_active and old_argv and old_cwd:
                resumed = _resume_old_loop(agent_bin, agent_cfg, old_argv, old_cwd, pid_file)
            if not resumed:
                hold_backups(agent_cfg)
                eprint(
                    "rollback-failed:",
                    reason,
                    "; the config was restored but the original loop could not be "
                    "restarted onto it, so the backup is retained",
                )
                return 1
            cleanup_backups(agent_cfg)
            eprint("restored:", reason)
            return 1
        hold_backups(agent_cfg)
        eprint("rollback-failed:", reason, "; the config was NOT safely restored")
        return 1

    cleanup_backups(agent_cfg)
    print(Outcome.SUCCESS)
    return 0


def _resume_old_loop(agent_bin: str, config: str, argv, cwd: str, pid_file: str) -> bool:
    """Restart the original loop with its original argv and cwd.

    The recorded argv is passed through unchanged, including a relative -config
    (resolved against the recorded cwd) and explicit Docker flag paths.
    """
    if not argv:
        return False
    try:
        spawn_verified_loop(agent_bin, config, pid_file, cwd, argv=argv)
    except Exception as exc:
        eprint("resume failed:", redact(str(exc)))
        return False
    return True


# --- CLI ------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="flexserverctl",
        description="safe backend URL cutover for the vps-manager stack",
        add_help=False,
    )
    sub = parser.add_subparsers(dest="command")
    set_backend = sub.add_parser(
        "set-backend", add_help=False, help="cut the local backend URL over atomically"
    )
    set_backend.add_argument("url", nargs="?", default="")
    set_backend.add_argument("--url", dest="url_opt", default="")
    set_backend.add_argument("--mode", choices=["auto", "systemd", "user"], default="auto")
    set_backend.add_argument(
        "--dry-run", action="store_true", default=False, help="validate and probe only"
    )
    validate = sub.add_parser(
        "validate-url", add_help=False, help="validate a URL with zero side effects"
    )
    validate.add_argument("url")
    sub.add_parser("help", add_help=False)
    return parser


def cmd_validate_url(url: str) -> int:
    try:
        normalized = validate_backend_url(url)
    except ValueError as exc:
        eprint("Error:", str(exc))
        return 1
    print(normalized)
    return 0


def cmd_set_backend(url: str, mode: str, dry_run: bool) -> int:
    url = url or ""
    if not url.strip():
        fail("set-backend requires a URL (or --url <URL>)")
    if mode == "auto":
        mode = detect_mode()
    if mode == "systemd":
        return do_systemd_cutover(url, dry_run=dry_run)
    if mode == "user":
        return do_user_cutover(url, dry_run=dry_run)
    fail(f"unknown --mode {mode!r}")


def main(argv=None) -> int:
    assert_linux()
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("help", "-h"):
        sys.stdout.write(HELP_TEXT)
        return 0
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 2)
    if getattr(args, "command", None) == "validate-url":
        return cmd_validate_url(args.url)
    if getattr(args, "command", None) == "set-backend":
        return cmd_set_backend(args.url_opt or args.url or "", args.mode, args.dry_run)
    sys.stdout.write(HELP_TEXT)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
