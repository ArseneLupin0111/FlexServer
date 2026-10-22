/**
 * Shared remote primitives for agent lifecycle operations (upgrade, restart).
 *
 * Both operations contend on the SAME remote lock directory so they are
 * mutually exclusive on the host. The lock is acquired with an atomic
 * `mkdir` and released with `rmdir` only by the holder.
 *
 * Phase-1 stale-lock policy (conservative): a conflicting lock is NEVER
 * auto-removed. `mkdir` conflict maps to a safe conflict failure and the
 * operator must manually verify no lifecycle operation is running and then
 * `rmdir` the lock. Auto-reclaiming based on mtime/PID is intentionally not
 * implemented: clocks can skew and PIDs can be reused, so heuristic removal
 * could kill a live operation's critical section.
 *
 * Current limitation: if the API process crashes after acquiring the remote
 * lock but before releasing it, the lock remains and all future lifecycle
 * operations conflict until manual cleanup. There is no TTL or fencing
 * token in phase one.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

export const AGENT_LIFECYCLE_LOCK = "lifecycle.lock";

export function getAgentServiceName(vpsId: string): string {
  const hash = createHash("sha256").update(vpsId).digest("hex").toLowerCase();
  return `vps-agent-${hash}.service`;
}

export function getAgentServiceUnitPath(vpsId: string): string {
  return `/etc/systemd/system/${getAgentServiceName(vpsId)}`;
}

export function getAgentLockPath(vpsId: string): string {
  const hash = createHash("sha256").update(vpsId).digest("hex").toLowerCase();
  return `/run/vps-manager-agent/vps-agent-${hash}.lock`;
}

export function getAgentTmpfilesPath(vpsId: string): string {
  const hash = createHash("sha256").update(vpsId).digest("hex").toLowerCase();
  return `/etc/tmpfiles.d/vps-agent-${hash}.conf`;
}

function assertNoNewlines(value: string, fieldName = "value"): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${fieldName} must not contain newline characters`);
  }
}

export function systemdEscapeValue(value: string, fieldName = "value"): string {
  assertNoNewlines(value, fieldName);
  return value.replace(/%/g, () => "%%");
}

export function systemdEscapeExecArg(arg: string, fieldName = "argument"): string {
  assertNoNewlines(arg, fieldName);
  const escaped = arg.replace(/%/g, () => "%%").replace(/\$/g, () => "$$");
  if (escaped === "" || /[\s"'\\]/.test(escaped)) {
    return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return escaped;
}

export interface SystemdUnitOptions {
  vpsId: string;
  user: string;
  group?: string;
  homeDir: string;
  binary: string;
  config: string;
  statePath?: string;
  dockerIdentityPath?: string;
  dockerRuntimeKeysPath?: string;
  dockerRuntimeOwnerUid?: string | number;
}

export function buildSystemdUnitContent(options: SystemdUnitOptions): string {
  if (!options?.vpsId || !options?.user || !options?.homeDir) {
    throw new Error(
      "buildSystemdUnitContent requires complete context: vpsId, user, and homeDir",
    );
  }
  assertNoNewlines(options.user, "user");
  if (options.group) {
    assertNoNewlines(options.group, "group");
  }
  const vpsIdEscaped = systemdEscapeValue(options.vpsId, "vpsId");
  const user = options.user;
  const groupLine = options.group ? `Group=${options.group}\n` : "";
  const workingDir = systemdEscapeValue(options.homeDir, "homeDir");
  const configDir = path.posix.dirname(options.config);
  const statePath = options.statePath ?? `${configDir}/state.json`;

  assertNoNewlines(options.binary, "binary");
  assertNoNewlines(options.config, "config");
  assertNoNewlines(statePath, "statePath");

  const args = [options.binary, "-config", options.config, "-state", statePath];
  if (options.dockerIdentityPath && options.dockerRuntimeKeysPath) {
    assertNoNewlines(options.dockerIdentityPath, "dockerIdentityPath");
    assertNoNewlines(options.dockerRuntimeKeysPath, "dockerRuntimeKeysPath");
    args.push("-docker-identity-path", options.dockerIdentityPath);
    args.push("-docker-runtime-keys-path", options.dockerRuntimeKeysPath);
    if (options.dockerRuntimeOwnerUid != null) {
      const uidStr = String(options.dockerRuntimeOwnerUid);
      assertNoNewlines(uidStr, "dockerRuntimeOwnerUid");
      args.push("-docker-runtime-owner-uid", uidStr);
    }
  }

  const execStart = args.map((arg, idx) => systemdEscapeExecArg(arg, `args[${idx}]`)).join(" ");
  return [
    "[Unit]",
    `Description=VPS Manager Agent (${vpsIdEscaped})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    ...(groupLine ? [groupLine.trim()] : []),
    `WorkingDirectory=${workingDir}`,
    "Environment=FLEXSERVER_AGENT_STATE_DIR=/var/lib/vps-manager-agent",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=10",
    "TimeoutStopSec=15",
    "KillMode=control-group",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
export function buildLifecycleLockAcquireCommand(lockPath: string): string {
  const l = shellQuote(lockPath);
  return `if mkdir -- ${l} 2>/dev/null; then echo acquired; else echo conflict; fi`;
}

export function buildLifecycleLockReleaseCommand(lockPath: string): string {
  const l = shellQuote(lockPath);
  return `rmdir -- ${l}`;
}

/** Shell helper that prints /proc PID starttime (field 22, robust to spaces in comm). */
export const REMOTE_ST_HELPER = `st(){ sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; };`;

export interface ManagedProcessOptions {
  vpsId?: string;
  user?: string;
  homeDir?: string;
  group?: string;
  statePath?: string;
  dockerIdentityPath?: string;
  dockerRuntimeKeysPath?: string;
  dockerRuntimeOwnerUid?: string | number;
}

export const EXACT_ARGV = `test "$(tr '\\0' '\\n' < /proc/$_pid/cmdline 2>/dev/null | awk -v b="$_bin" -v b_base="./\${_bin##*/}" -v cwd="$_cwd" -v bdir="$_bdir" -v c="$_cfg" -v st="$_st_path" -v id="$_id_path" -v rk="$_rk_path" -v uid="$_uid_val" 'BEGIN{ok=1;has_c=has_st=has_id=has_rk=has_uid=0} NR==1{if(!($0==b||(($0==b_base||$0=="./vps-agent")&&cwd==bdir&&bdir!="")))ok=0;next} NR%2==0{flag=$0;next} NR%2==1{val=$0;if(flag=="-config"&&val==c)has_c++;else if(flag=="-state"&&val==st)has_st++;else if(flag=="-docker-identity-path"&&val==id)has_id++;else if(flag=="-docker-runtime-keys-path"&&val==rk)has_rk++;else if(flag=="-docker-runtime-owner-uid"&&val==uid)has_uid++;else ok=0} END{is_3=(NR==3&&has_c==1&&(has_st+has_id+has_rk+has_uid==0));is_5=(NR==5&&has_c==1&&has_st==1&&(has_id+has_rk+has_uid==0));is_11=(NR==11&&has_c==1&&has_st==1&&has_id==1&&has_rk==1&&has_uid==1);print (ok&&(is_3||is_5||is_11))?1:0}')" = 1`;

function formatProcessContext(
  binary: string,
  config: string,
  options?: ManagedProcessOptions,
): {
  vars: string;
  hasDockerOptions: boolean;
} {
  const b = shellQuote(binary);
  const c = shellQuote(config);
  const st = options?.statePath
    ? shellQuote(options.statePath)
    : '"$_dir/state.json"';
  const id = options?.dockerIdentityPath
    ? shellQuote(options.dockerIdentityPath)
    : '"$_dir/docker-identity.json"';
  const rk = options?.dockerRuntimeKeysPath
    ? shellQuote(options.dockerRuntimeKeysPath)
    : '"$_dir/runtime-keys.json"';
  const uid =
    options?.dockerRuntimeOwnerUid != null
      ? shellQuote(String(options.dockerRuntimeOwnerUid))
      : '"$(test -f "$_rk_path" && stat -c %u "$_rk_path" 2>/dev/null || id -u)"';

  const vars = `_bin=${b}; _cfg=${c}; _dir=$(dirname "$_cfg"); _bdir=$(dirname "$_bin"); _st_path=${st}; _id_path=${id}; _rk_path=${rk}; _uid_val=${uid};`;
  const hasDockerOptions = Boolean(
    options?.dockerIdentityPath || options?.dockerRuntimeKeysPath,
  );
  return { vars, hasDockerOptions };
}

/**
 * Pure mirror of the tail classification in {@link buildManagedProcessInspectCommand}.
 * Exists so the stale-PID policy is unit-testable without a live /proc.
 * Shell remains the source of truth on hosts; this must stay in sync with it.
 *
 * When the deterministic per-VPS unit is active (`unit.active`), that unit is
 * authoritative and the legacy PID file is ignored. A valid MainPID must equal
 * the single exact exe/argv match to report owned; any foreign, missing, or
 * invalid MainPID fails closed as mismatch (never falls back to the pidfile).
 * This recovers from any supervisor restart that leaves
 * `~/.vps-manager-agent/vps-agent.pid` stale: the live MainPID still reports
 * owned when it is the single exact match. When no active unit is available
 * the legacy PID file policy applies.
 */
export function classifyManagedProcessInspection(
  matches: number,
  owned: { pid: string; starttime: string } | null,
  pidFile: { exists: boolean; content?: string },
  pidAlive: (pid: string) => boolean,
  unit?: { active: boolean; mainPid?: string } | null,
): string {
  if (matches > 1) return "ambiguous";
  if (unit?.active) {
    const mainPid = unit.mainPid ?? "";
    if (/^[1-9][0-9]*$/.test(mainPid)) {
      if (owned && owned.pid === mainPid) return `owned:${owned.pid}:${owned.starttime}`;
      return "mismatch";
    }
    return "mismatch";
  }
  if (!pidFile.exists) return matches === 0 ? "none" : "ambiguous";
  const pid = pidFile.content ?? "";
  if (pid === "" || /[^0-9]/.test(pid)) return "invalid";
  if (matches === 0) return pidAlive(pid) ? "mismatch" : "none";
  if (owned && pid === owned.pid) return `owned:${pid}:${owned.starttime}`;
  return "mismatch";
}

export function buildManagedProcessInspectCommand(
  binary: string,
  config: string,
  pidFile: string,
  options?: ManagedProcessOptions,
): string {
  assertNoNewlines(binary, "binary");
  assertNoNewlines(config, "config");
  assertNoNewlines(pidFile, "pidFile");
  if (options?.vpsId) assertNoNewlines(options.vpsId, "vpsId");
  const p = shellQuote(pidFile);
  const { vars } = formatProcessContext(binary, config, options);
  const vpsId = options?.vpsId && options.vpsId.length > 0 ? options.vpsId : null;
  const unitVars = vpsId
    ? `_unit=${shellQuote(getAgentServiceName(vpsId))}; if systemctl is-active --quiet "$_unit" 2>/dev/null; then _unit_active=1; _mainpid=$(systemctl show -p MainPID --value "$_unit" 2>/dev/null || true); fi;`
    : `_unit='';`;
  return [
    `_pf=${p}; ${vars} _matches=0; _owned=''; _ost=''; _mainpid=''; _unit_active=0; ${REMOTE_ST_HELPER} ${unitVars}`,
    `for _d in /proc/[0-9]*; do _pid=\${_d##*/}; test "$(readlink -f /proc/$_pid/exe 2>/dev/null)" = "$_bin" || continue; _cwd=$(readlink -f "/proc/$_pid/cwd" 2>/dev/null || true); ${EXACT_ARGV} || continue; _st_time=$(st "$_pid"); test -n "$_st_time" || continue; _matches=$((_matches+1)); _owned=$_pid; _ost=$_st_time; done;`,
    `test "$_matches" -le 1 || { echo ambiguous; exit 0; };`,
    `if [ "$_unit_active" = "1" ]; then`,
    `  case "$_mainpid" in ''|0*|*[!0-9]*) echo mismatch; exit 0;; esac;`,
    `  test "$_matches" = "1" && test "$_owned" = "$_mainpid" || { echo mismatch; exit 0; };`,
    `  printf 'owned:%s:%s\\n' "$_mainpid" "$_ost"; exit 0;`,
    `fi;`,
    `test -f "$_pf" || { test "$_matches" = 0 && echo none || echo ambiguous; exit 0; }; _pid=$(cat "$_pf" 2>/dev/null); case "$_pid" in (''|*[!0-9]*) echo invalid; exit 0;; esac; if test "$_matches" = 0; then test -d "/proc/$_pid" && echo mismatch || echo none; exit 0; fi; test "$_pid" = "$_owned" || { echo mismatch; exit 0; }; printf 'owned:%s:%s\\n' "$_pid" "$_ost"`,
  ].join(" ");
}

/** Revalidates identity before every signal; a check-to-kill syscall race remains. */
export function buildManagedProcessStopCommand(
  binary: string,
  config: string,
  pid?: string | null,
  starttime?: string | null,
  options?: ManagedProcessOptions,
): string {
  assertNoNewlines(binary, "binary");
  assertNoNewlines(config, "config");
  if (options?.vpsId) assertNoNewlines(options.vpsId, "vpsId");
  const p = pid ? shellQuote(pid) : "''";
  const s = starttime ? shellQuote(starttime) : "''";
  const { vars } = formatProcessContext(binary, config, options);
  const vpsIdArg = options?.vpsId
    ? shellQuote(options.vpsId)
    : `$(sed -n 's/.*"vpsId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$_cfg" 2>/dev/null)`;
  const owns = `owns(){ test "$(st "$_pid")" = "$_start" && test "$(readlink -f /proc/$_pid/exe 2>/dev/null)" = "$_bin" && _cwd=$(readlink -f "/proc/$_pid/cwd" 2>/dev/null || true) && ${EXACT_ARGV}; };`;
  return [
    `_pid=${p}; _start=${s}; ${vars} ${REMOTE_ST_HELPER} ${owns}`,
    `if [ "$(id -u)" -eq 0 ]; then _s=''; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then _s='sudo -n'; else _s='_nosudo'; fi;`,
    `_vps_id=${vpsIdArg};`,
    `if [ -n "$_vps_id" ]; then`,
    `  _hash=$(printf '%s' "$_vps_id" | sha256sum | awk '{print $1}');`,
    `  _unit="vps-agent-\${_hash}.service";`,
    `  _unit_path="/etc/systemd/system/$_unit";`,
    `  _load=$(systemctl show -p LoadState --value "$_unit" 2>/dev/null || true);`,
    `  if [ "$_load" = 'loaded' ] || [ -f "$_unit_path" ]; then`,
    `    if [ "$_s" = '_nosudo' ]; then echo "Cannot stop systemd service $_unit: sudo required" >&2; exit 1; fi;`,
    `    $_s systemctl stop "$_unit" || exit 1;`,
    `    _i=0; while [ $_i -lt 50 ]; do`,
    `      _act=$(systemctl show -p ActiveState --value "$_unit" 2>/dev/null || true);`,
    `      _mpid=$(systemctl show -p MainPID --value "$_unit" 2>/dev/null || true);`,
    `      if [ "$_act" != 'activating' ] && [ "$_act" != 'deactivating' ] && ! systemctl is-active --quiet "$_unit" 2>/dev/null && { [ "$_mpid" = '0' ] || [ -z "$_mpid" ]; }; then break; fi;`,
    `      sleep .1; _i=$((_i+1));`,
    `    done;`,
    `    _act=$(systemctl show -p ActiveState --value "$_unit" 2>/dev/null || true);`,
    `    _mpid=$(systemctl show -p MainPID --value "$_unit" 2>/dev/null || true);`,
    `    if [ "$_act" = 'activating' ] || [ "$_act" = 'deactivating' ] || systemctl is-active --quiet "$_unit" 2>/dev/null || { [ "$_mpid" != '0' ] && [ -n "$_mpid" ]; }; then`,
    `      echo "Service $_unit failed to stop (ActiveState=$_act, MainPID=$_mpid)" >&2; exit 1;`,
    `    fi;`,
    `  fi;`,
    `fi;`,
    ...(pid && starttime
      ? [
          `if [ -n "$_pid" ] && [ "$_pid" != '0' ] && [ -n "$_start" ]; then`,
          `  if owns; then owns && kill -TERM "$_pid" 2>/dev/null || true; fi;`,
          `  _i=0; while owns && [ $_i -lt 50 ]; do sleep .1; _i=$((_i+1)); done;`,
          `  if owns; then owns && kill -KILL "$_pid" 2>/dev/null || true; fi;`,
          `  _i=0; while owns && [ $_i -lt 20 ]; do sleep .1; _i=$((_i+1)); done;`,
          `  ! owns || { echo "Legacy process $_pid failed to stop" >&2; exit 1; };`,
          `fi;`,
        ]
      : []),
    `exit 0`,
  ].join(" ");
}

export function buildServiceUninstallCommand(
  remoteDir: string,
  vpsId?: string,
): string {
  assertNoNewlines(remoteDir, "remoteDir");
  if (vpsId) assertNoNewlines(vpsId, "vpsId");
  const qBinary = shellQuote(`${remoteDir}/vps-agent`);
  const qPidFile = shellQuote(`${remoteDir}/vps-agent.pid`);
  const qConfig = shellQuote(`${remoteDir}/config.json`);
  const vpsIdArg = vpsId
    ? shellQuote(vpsId)
    : `$(test -f "${remoteDir}/config.json" && sed -n 's/.*"vpsId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "${remoteDir}/config.json" 2>/dev/null || true)`;

  return [
    `if [ "$(id -u)" -eq 0 ]; then _s=''; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then _s='sudo -n'; else _s='_nosudo'; fi;`,
    `_vps_id=${vpsIdArg};`,
    `if [ -n "$_vps_id" ]; then`,
    `  _hash=$(printf '%s' "$_vps_id" | sha256sum | awk '{print $1}');`,
    `  _unit="vps-agent-\${_hash}.service";`,
    `  _unit_path="/etc/systemd/system/$_unit";`,
    `  _tmpfiles_path="/etc/tmpfiles.d/vps-agent-\${_hash}.conf";`,
    `  _load=$(systemctl show -p LoadState --value "$_unit" 2>/dev/null || true);`,
    `  if [ "$_load" = 'loaded' ] || [ -f "$_unit_path" ] || [ -f "$_tmpfiles_path" ]; then`,
    `    if [ "$_s" = '_nosudo' ]; then echo "Uninstalling systemd service $_unit requires sudo; privilege unavailable" >&2; exit 1; fi;`,
    `    $_s systemctl stop "$_unit" || exit 1;`,
    `    _i=0; while [ $_i -lt 50 ]; do`,
    `      _act=$(systemctl show -p ActiveState --value "$_unit" 2>/dev/null || true);`,
    `      _mpid=$(systemctl show -p MainPID --value "$_unit" 2>/dev/null || true);`,
    `      if [ "$_act" != 'activating' ] && [ "$_act" != 'deactivating' ] && ! systemctl is-active --quiet "$_unit" 2>/dev/null && { [ "$_mpid" = '0' ] || [ -z "$_mpid" ]; }; then break; fi;`,
    `      sleep .1; _i=$((_i+1));`,
    `    done;`,
    `    _act=$(systemctl show -p ActiveState --value "$_unit" 2>/dev/null || true);`,
    `    _mpid=$(systemctl show -p MainPID --value "$_unit" 2>/dev/null || true);`,
    `    if [ "$_act" = 'activating' ] || [ "$_act" = 'deactivating' ] || systemctl is-active --quiet "$_unit" 2>/dev/null || { [ "$_mpid" != '0' ] && [ -n "$_mpid" ]; }; then`,
    `      echo "Service $_unit failed to stop (ActiveState=$_act, MainPID=$_mpid)" >&2; exit 1;`,
    `    fi;`,
    `    if systemctl is-enabled --quiet "$_unit" 2>/dev/null; then $_s systemctl disable "$_unit" || exit 1; fi;`,
    `    if [ -e "$_unit_path" ]; then $_s rm -f -- "$_unit_path" || exit 1; fi;`,
    `    if [ -e "$_tmpfiles_path" ]; then $_s rm -f -- "$_tmpfiles_path" || exit 1; fi;`,
    `    $_s systemctl daemon-reload || exit 1;`,
    `    $_s systemctl reset-failed "$_unit" 2>/dev/null || true;`,
    `  fi;`,
    `fi;`,
    `_bin=${qBinary}; _cfg=${qConfig}; _dir=$(dirname "$_cfg"); _bdir=$(dirname "$_bin"); _st_path="$_dir/state.json"; _id_path="$_dir/docker-identity.json"; _rk_path="$_dir/runtime-keys.json"; _uid_val="$(test -f "$_rk_path" && stat -c %u "$_rk_path" 2>/dev/null || id -u)"; ${REMOTE_ST_HELPER}`,
    `if [ -f ${qPidFile} ]; then`,
    `  _pid=$(cat ${qPidFile} 2>/dev/null || true);`,
    `  case "$_pid" in`,
    `    (''|*[!0-9]*) ;;`,
    `    (*)`,
    `      _st=$(st "$_pid");`,
    `      if [ -n "$_st" ]; then`,
    `        _un_owns(){ test "$(st "$_pid")" = "$_st" && test "$(readlink -f /proc/$_pid/exe 2>/dev/null)" = "$_bin" && _cwd=$(readlink -f "/proc/$_pid/cwd" 2>/dev/null || true) && ${EXACT_ARGV}; };`,
    `        if _un_owns; then _un_owns && kill -TERM "$_pid" 2>/dev/null || true; fi;`,
    `        _i=0; while _un_owns && [ $_i -lt 50 ]; do sleep .1; _i=$((_i+1)); done;`,
    `        if _un_owns; then _un_owns && kill -KILL "$_pid" 2>/dev/null || true; fi;`,
    `        _i=0; while _un_owns && [ $_i -lt 20 ]; do sleep .1; _i=$((_i+1)); done;`,
    `        ! _un_owns || { echo "Legacy process $_pid failed to stop" >&2; exit 1; };`,
    `      fi;`,
    `      rm -f -- ${qPidFile} 2>/dev/null || true;`,
    `      ;;`,
    `  esac;`,
    `fi; exit 0`,
  ].join(" ");
}

/**
 * Docker identity/runtime-state provisioning for a managed install or
 * upgrade. Runs as one remote shell script and MUST execute before any
 * `-once` preflight or service start:
 *
 * Privileged (root or passwordless sudo):
 * 1. Fails closed when either file exists without the other: a partial pair
 *    is never completed, and runtime keys without an identity are refused
 *    rather than silently rotating a fresh identity.
 * 2. Runs `-provision-docker-state` idempotently: a valid existing pair is
 *    preserved byte-for-byte (no rotation on upgrade), then ownership/mode
 *    are enforced (identity root:root 0600,
 *    runtime keys <login-user>:<login-group> 0600).
 * 3. Re-runs provisioning with the login user's uid as the runtime owner so
 *    the final state passes exactly the validation the agent performs before
 *    it starts.
 *
 * Unprivileged (non-root without passwordless sudo):
 * 1. Clean install (neither file exists) provisions a user-owned 0600 pair
 *    directly, with no privilege escalation attempt (runtime owner uid must
 *    equal the invoking euid, which the agent CLI enforces).
 * 2. An existing intact user-owned pair is re-provisioned as the login user:
 *    the agent validates content and the runtime↔identity match and preserves
 *    both files byte-for-byte (no rotation on upgrade).
 * 3. An existing root-owned identity with user-owned runtime keys is left
 *    completely untouched (no provision, no chown/chmod): stat checks confirm
 *    regular files, 0600 modes, non-empty content, and the split owners, then
 *    the script exits 0 so the caller's subsequent `-once` preflight runs. That
 *    preflight validates the runtime keys standalone (strict JSON, 32-byte
 *    keys, 0600 + owner, delivery-state MAC) — it never reads the identity
 *    file, so the runtime↔identity cryptographic match is unverifiable as the
 *    SSH user and is revalidated by the next privileged provision. An absent
 *    identity fails closed at the shell guard above rather than being accepted.
 * 4. Anything else fails closed: a partial pair, non-regular files, insecure
 *    modes, unexpected owners, or empty files exit non-zero without touching
 *    state.
 *
 * Every failure path exits non-zero; the SSH layer rejects the command, the
 * install/upgrade job fails, and no service is started or restarted.
 */
export function buildDockerStateProvisionCommand(
  binary: string,
  remoteDir: string,
): string {
  const b = shellQuote(binary);
  const d = shellQuote(remoteDir);
  return [
    "set -eu",
    `_d=${d}; _b=${b}; _id="$_d/docker-identity.json"; _rk="$_d/runtime-keys.json"; _u=$(id -u)`,
    `# Privilege: root, else passwordless sudo (verified with sudo -n), else unprivileged user-owned state only.`,
    `if [ "$_u" -eq 0 ]; then _s=''; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then _s='sudo -n'; else _s='_nosudo'; fi`,
    `if [ -e "$_rk" ] && [ ! -e "$_id" ]; then echo "Docker runtime keys exist without the installation identity ($_id); refusing to rotate the installation identity" >&2; exit 1; fi`,
    `if [ -e "$_id" ] && [ ! -e "$_rk" ]; then echo "Docker installation identity exists without runtime keys ($_rk); refusing to provision a partial pair" >&2; exit 1; fi`,
    `_p=0; if [ -e "$_rk" ]; then _o=$(stat -c %u "$_rk"); case "$_o" in 0|"$_u") _p="$_o";; *) echo "Unexpected owner uid $_o for $_rk; refusing to touch Docker runtime keys" >&2; exit 1;; esac; fi`,
    `if [ "$_s" != '_nosudo' ]; then $_s "$_b" -provision-docker-state -docker-identity-path "$_id" -docker-runtime-keys-path "$_rk" -docker-runtime-owner-uid "$_p"; $_s chown root:root "$_id"; $_s chown "$_u:$(id -gn)" "$_rk"; $_s chmod 0600 "$_id" "$_rk"; $_s "$_b" -provision-docker-state -docker-identity-path "$_id" -docker-runtime-keys-path "$_rk" -docker-runtime-owner-uid "$_u"; exit 0; fi`,
    `if [ ! -e "$_id" ] && [ ! -e "$_rk" ]; then "$_b" -provision-docker-state -docker-identity-path "$_id" -docker-runtime-keys-path "$_rk" -docker-runtime-owner-uid "$_u"; exit 0; fi`,
    `if [ ! -f "$_id" ] || [ ! -f "$_rk" ]; then echo "Docker state files must be regular files; refusing to provision without privilege" >&2; exit 1; fi`,
    `_im=$(stat -c %a "$_id"); _io=$(stat -c %u "$_id"); _rm=$(stat -c %a "$_rk"); _ro=$(stat -c %u "$_rk")`,
    `case "$_im" in 600) ;; *) echo "Insecure mode $_im for $_id; refusing to provision without privilege" >&2; exit 1;; esac`,
    `case "$_rm" in 600) ;; *) echo "Insecure mode $_rm for $_rk; refusing to provision without privilege" >&2; exit 1;; esac`,
    `if [ "$_io" = "$_u" ] && [ "$_ro" = "$_u" ]; then "$_b" -provision-docker-state -docker-identity-path "$_id" -docker-runtime-keys-path "$_rk" -docker-runtime-owner-uid "$_u"; exit 0; fi`,
    `if [ "$_io" = 0 ] && [ "$_ro" = "$_u" ] && [ -s "$_id" ] && [ -s "$_rk" ]; then exit 0; fi`,
    `echo "Unexpected Docker state owners (identity uid $_io, runtime uid $_ro); refusing to touch Docker state without privilege" >&2; exit 1`,
  ].join("\n");
}

/**
 * Transactional launch: deploys/updates the system-level systemd service running
 * as the unprivileged login user, provisions the root /run lock and tmpfiles.d
 * configuration, starts the unit, verifies active status, and records the MainPID.
 */
export function buildTransactionalStartCommand(
  binary: string,
  config: string,
  pidFile: string,
  options?: ManagedProcessOptions,
): string {
  if (!options?.vpsId || !options?.user || !options?.homeDir) {
    throw new Error(
      "buildTransactionalStartCommand requires complete context: vpsId, user, and homeDir",
    );
  }
  assertNoNewlines(binary, "binary");
  assertNoNewlines(config, "config");
  assertNoNewlines(pidFile, "pidFile");
  assertNoNewlines(options.vpsId, "vpsId");
  assertNoNewlines(options.user, "user");
  if (options.group) assertNoNewlines(options.group, "group");
  assertNoNewlines(options.homeDir, "homeDir");
  const user = options.user;
  const homeDir = options.homeDir;
  const serviceName = getAgentServiceName(options.vpsId);
  const unitPath = getAgentServiceUnitPath(options.vpsId);
  const lockPath = getAgentLockPath(options.vpsId);
  const lockDir = "/run/vps-manager-agent";
  const tmpfilesPath = getAgentTmpfilesPath(options.vpsId);
  const p = shellQuote(pidFile);
  const { vars } = formatProcessContext(binary, config, options);
  const unitContent = buildSystemdUnitContent({
    vpsId: options.vpsId,
    user,
    group: options.group,
    homeDir,
    binary,
    config,
    statePath: options.statePath,
    dockerIdentityPath: options.dockerIdentityPath,
    dockerRuntimeKeysPath: options.dockerRuntimeKeysPath,
    dockerRuntimeOwnerUid: options.dockerRuntimeOwnerUid,
  });

  return [
    `_pf=${p}; ${vars} ${REMOTE_ST_HELPER}`,
    `if [ "$(id -u)" -eq 0 ]; then _s=''; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then _s='sudo -n'; else _s='_nosudo'; fi;`,
    `_unit=${shellQuote(serviceName)}; _unit_path=${shellQuote(unitPath)};`,
    `_lock_dir=${shellQuote(lockDir)}; _lock_path=${shellQuote(lockPath)}; _tmpfiles_path=${shellQuote(tmpfilesPath)};`,
    `if [ "$_s" = '_nosudo' ]; then`,
    `  if ! test -f "$_unit_path" || ! test -f "$_lock_path"; then`,
    `    echo "Agent system service requires passwordless sudo (sudo -n); privilege unavailable" >&2; exit 1;`,
    `  fi;`,
    `fi;`,
    `if [ "$_s" != '_nosudo' ]; then`,
    `  if [ -e "$_lock_dir" ] || [ -L "$_lock_dir" ]; then`,
    `    test -d "$_lock_dir" && test ! -L "$_lock_dir" && [ "$(stat -c %u "$_lock_dir" 2>/dev/null)" -eq 0 ] || { echo "Unsafe lock directory $_lock_dir" >&2; exit 1; };`,
    `  else`,
    `    $_s mkdir -p "$_lock_dir" || exit 1;`,
    `  fi;`,
    `  $_s chown root:root "$_lock_dir" && $_s chmod 0755 "$_lock_dir" || exit 1;`,
    `  if [ -e "$_lock_path" ] || [ -L "$_lock_path" ]; then`,
    `    test -f "$_lock_path" && test ! -L "$_lock_path" && [ "$(stat -c %u "$_lock_path" 2>/dev/null)" -eq 0 ] || { echo "Unsafe lock file $_lock_path" >&2; exit 1; };`,
    `  else`,
    `    $_s touch "$_lock_path" || exit 1;`,
    `  fi;`,
    `  $_s chown root:root "$_lock_path" && $_s chmod 0666 "$_lock_path" || exit 1;`,
    `  printf 'd %s 0755 root root -\\nf %s 0666 root root -\\n' "$_lock_dir" "$_lock_path" | $_s tee "$_tmpfiles_path" >/dev/null || exit 1;`,
    `  $_s chmod 0644 "$_tmpfiles_path" || exit 1;`,
    `  if command -v systemd-tmpfiles >/dev/null 2>&1; then $_s systemd-tmpfiles --create "$_tmpfiles_path" 2>/dev/null || true; fi;`,
    `  printf '%s\\n' ${shellQuote(unitContent)} | $_s tee "$_unit_path" >/dev/null || exit 1;`,
    `  $_s chmod 0644 "$_unit_path" || exit 1;`,
    `  $_s systemctl daemon-reload || exit 1;`,
    `  $_s systemctl enable "$_unit" || exit 1;`,
    `fi;`,
    `_svc_pid=''; if systemctl is-active --quiet "$_unit" 2>/dev/null; then _svc_pid=$(systemctl show -p MainPID --value "$_unit" 2>/dev/null || true); fi;`,
    `_leg_pid=''; _leg_st=''; _leg_matches=0; _unknown=0;`,
    `for _d in /proc/[0-9]*; do`,
    `  _pid=\${_d##*/};`,
    `  test "$(readlink -f /proc/$_pid/exe 2>/dev/null)" = "$_bin" || continue;`,
    `  if [ -n "$_svc_pid" ] && [ "$_pid" = "$_svc_pid" ]; then continue; fi;`,
    `  _cwd=$(readlink -f "/proc/$_pid/cwd" 2>/dev/null || true);`,
    `  if ${EXACT_ARGV}; then`,
    `    _st_time=$(st "$_pid");`,
    `    if [ -n "$_st_time" ]; then _leg_matches=$((_leg_matches+1)); _leg_pid=$_pid; _leg_st=$_st_time; else _unknown=$((_unknown+1)); fi;`,
    `  else`,
    `    _unknown=$((_unknown+1));`,
    `  fi;`,
    `done;`,
    `if [ "$_unknown" -gt 0 ]; then echo "Conflicting unknown process running agent binary; refusing to start service" >&2; exit 1; fi;`,
    `if [ "$_leg_matches" -gt 1 ]; then echo "Multiple conflicting processes running agent binary; refusing to start service" >&2; exit 1; fi;`,
    `if [ "$_leg_matches" -eq 1 ]; then`,
    `  test -f "$_pf" && [ "$(cat "$_pf" 2>/dev/null || true)" = "$_leg_pid" ] || { echo "Conflicting unowned or ambiguous legacy process $_leg_pid running; refusing to start service" >&2; exit 1; };`,
    `  _leg_owns(){ test "$(st "$_leg_pid")" = "$_leg_st" && test "$(readlink -f /proc/$_leg_pid/exe 2>/dev/null)" = "$_bin" && _cwd=$(readlink -f "/proc/$_leg_pid/cwd" 2>/dev/null || true) && _pid="$_leg_pid" && ${EXACT_ARGV}; };`,
    `  if _leg_owns; then _leg_owns && kill -TERM "$_leg_pid" 2>/dev/null || true; fi;`,
    `  _i=0; while _leg_owns && [ $_i -lt 50 ]; do sleep .1; _i=$((_i+1)); done;`,
    `  if _leg_owns; then _leg_owns && kill -KILL "$_leg_pid" 2>/dev/null || true; fi;`,
    `  _i=0; while _leg_owns && [ $_i -lt 20 ]; do sleep .1; _i=$((_i+1)); done;`,
    `  ! _leg_owns || { echo "Failed to stop legacy process $_leg_pid" >&2; exit 1; };`,
    `fi;`,
    `if [ "$_s" != '_nosudo' ]; then $_s systemctl start "$_unit"; else systemctl start "$_unit"; fi;`,
    `_i=0; while ! systemctl is-active --quiet "$_unit" && [ $_i -lt 50 ]; do sleep .1; _i=$((_i+1)); done;`,
    `systemctl is-active --quiet "$_unit" || { echo "Systemd service $_unit failed to start" >&2; exit 1; };`,
    `_pid=$(systemctl show -p MainPID --value "$_unit" 2>/dev/null || true);`,
    `test -n "$_pid" && [ "$_pid" -gt 0 ] 2>/dev/null || { echo "Systemd service $_unit has no valid MainPID" >&2; exit 1; };`,
    `test "$(readlink -f /proc/$_pid/exe 2>/dev/null)" = "$_bin" || { echo "MainPID $_pid is not running expected binary" >&2; exit 1; };`,
    `if [ -n "$_pf" ]; then printf '%s\\n' "$_pid" > "$_pf" || true; fi; exit 0`,
  ].join(" ");
}
