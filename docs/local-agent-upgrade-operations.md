# Local agent upgrades: operator runbook

The dashboard compares fresh agent heartbeats with the deployed API image's bundled agent binary (`/app/agent/vps-agent-linux-amd64` or `/app/agent/vps-agent-linux-arm64`). Agent upgrades for both local and remote hosts use these bundled API artifacts directly and require no manual signing keys or external release catalogs. Deploying an API image updates the available bundled binary, and background convergence (`AgentConvergenceService`) automatically schedules pull-only upgrades via the host updater daemon (`vps-updater`) and `LocalUpgradeService`. The API container remains unprivileged (no Docker/systemd socket or host-root mount). Remote SSH access is used solely to bootstrap or repair the updater installation, not to push-replace running binaries.

### Remote SSH process ownership and managed systemd service

Remote agent management on systemd-capable Linux hosts uses a dedicated system-level systemd service:
`/etc/systemd/system/vps-agent-${sha256(vpsId).toLowerCase()}.service`.
Local host agent installations retain the canonical `vps-manager-agent.service` unit to preserve updater daemon (`vps-updater`) supervision and atomic swaps; only remote SSH managed services use the hashed unit naming scheme.
The unit executes as the host login user (`User=<user>`, `Group=<group>`), with `WorkingDirectory=<homeDir>`, `Restart=always`, `RestartSec=10`, `TimeoutStopSec=15`, and `KillMode=control-group`. `KillMode=control-group` provides complete descendant process cleanup and signal propagation on service stop or restart to avoid orphan workers; it is process lifecycle termination management, not a security sandbox or privilege boundary.
Sudo/root access is required for remote service configuration, unit installation, and lifecycle transitions; there is no fallback to unprivileged `nohup` background loops. Supported service configurations preserve all managed Docker state arguments (`-state`, `-docker-identity-path`, `-docker-runtime-keys-path`, `-docker-runtime-owner-uid`) alongside `-config`.

Remote reinstall uploads a separate staged binary/config and validates them before stopping the current service. It keeps rollback copies through job completion and replaces files by rename, avoiding Linux `Text file busy` errors from writing an active executable. Restart and reinstall inspect the deterministic unit's live `MainPID`, not a stale PID file left by an earlier supervisor restart. A foreign or invalid MainPID remains a hard ownership failure.

Remote install/reinstall completion requires an online ingest with a version and fresh usage of the newly issued install credential after the pre-start baseline. A heartbeat from an older credential alone cannot complete the install. The job preserves the observed version, build ID, and heartbeat timestamp; absence of confirmation within `max(60 seconds, 3 × agent interval)` fails the job and enters the existing rollback/revocation path.

Server deletion checks persisted queued/running jobs while holding the per-VPS uninstall slot, before touching the remote installation or revoking credentials. Finish or resolve the active job before retrying deletion. This guard does not add automatic recovery for jobs stranded by an API crash, nor does deletion remove the host's `authorized_keys` entry.

Azure remote lifecycle recovery was exercised on 2026-10-16: restart job `job_y2E7WgZOMw3D` and reinstall job `job_XdfQMZYGdem0` both succeeded, followed by fresh metric ingest and matching systemd/PID-file PID `4015012`. The API-only operational hotfix uses `/opt/vps-manager-nodejs/docker-compose.azure-hotfix.yml` and image `flexserver-api:azure-lifecycle-hotfix-20261016`; retain this override until a normal release includes the source fix. This is not evidence for the local-updater gate below.

#### Per-VPS singleton process lock

To prevent duplicate agent instances and conflicting background metric collectors for the same VPS, the agent enforces a per-VPS singleton OS process lock on Linux:
- **Lock path:** `/run/vps-manager-agent/vps-agent-${sha256(vpsId).toLowerCase()}.lock`.
- **Trusted `vpsId` source:** the privileged helper reads `vpsId` only from the root-owned, non-symlink, regular-file `/etc/vps-manager-agent/config.json` (rejecting group/world-writable modes and non-root owners when running as root); `agentConfig` cannot be redirected outside `FixedAgentConfig` outside test mode. The optional `vpsId` field in the updater config accepts only a trimmed local value and is otherwise ignored in production.
- **Directory & file security:** The directory `/run/vps-manager-agent` is root-owned with mode `0755` (`perm & 0022 == 0`). The lock file is a root-owned regular file with mode `0666`.
- **Provisioning (No RuntimeDirectory):** Provisioned via `/etc/tmpfiles.d/vps-manager-agent.conf` and `systemd-tmpfiles --create`. The service unit must **not** specify `RuntimeDirectory=`; systemd's `RuntimeDirectory=` directive automatically transfers directory ownership to the service's unprivileged `User=`, which would break the trusted root-ownership invariant (`0755` root:root). The local agent installer also provisions this tmpfiles configuration so directory and permissions persist across reboots.
- **Durable provisioning migration:** `lock.Provision(vpsId)` enforces a root-owned `0755` directory and root-owned `0666` lock file without unlinking or truncating an existing file (a held inode is preserved), writes `/etc/tmpfiles.d/vps-manager-agent.conf` (`0644` root:root), and runs `systemd-tmpfiles --create` for reboot persistence. The privileged updater helper provisions from the trusted local `/etc/vps-manager-agent/config.json` `vpsId` before binary swap and restart (helper unit: `ReadWritePaths=/run/vps-manager-agent /etc/tmpfiles.d`, `ReadOnlyPaths=/etc/vps-manager-agent/config.json`). Operators can pre-provision with `vps-agent -config <path> -provision-lock`.
- **Invariants:** The lock file is opened with `O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK` and verified to be a root-owned regular file. On Linux, there is no fallback path and no environment variable override. Root processes can create the file and directory if missing; unprivileged agent processes require pre-provisioning and fail closed with an actionable error if absent.
- **Acquisition and crash release:** The lock is acquired via non-blocking exclusive flock (`syscall.Flock(fd, LOCK_EX|LOCK_NB)`). The descriptor is held for the process lifetime. On crash or termination, the kernel automatically releases the flock. The lock file is **never** unlinked or truncated on release or exit, ensuring all competing processes contend on the same inode across restarts.
- **Contention with `-once`:** Executing `vps-agent ... -once` acquires the exact same non-blocking OS lock before initiating metrics collection or network calls. If another agent instance is active for the VPS, `-once` exits immediately with `instance lock error: agent already running for this VPS`.

#### Upgrade preflight and offline config validation (`-validate-config`)

Because `-once` contends for the singleton lock and will fail if the daemon is running, staged upgrade preflights must not use `-once` against an active loop. Instead, candidate binaries are validated using the offline flag:
```bash
<candidate-binary> -config <config-path> -validate-config
```
`-validate-config` loads and validates configuration syntax and required fields without acquiring the singleton lock, without initiating network traffic, and without mutating state or filesystem contents. This offline preflight succeeds safely while the continuous daemon holds the active singleton lock.

#### Pull-based agent upgrade and convergence lifecycle

Both local and remote agent updates follow the unified pull-based updater lifecycle:
1. **Automatic convergence scheduling:** `AgentConvergenceService` checks installed agents against the deployment's bundled build identity. When idle (`idle === true`, no active PTY/shell, Compose mutation, or AI task), an upgrade job is created.
2. **Updater claim & download:** The host updater daemon claims the job with protocol 3 evidence and downloads its scoped artifact from `/api/local-updater/jobs/:jobId/artifact`.
3. **Offline preflight & validation:** Validate binary integrity, ELF architecture, SHA-256 digest, and configuration syntax.
4. **Root helper atomic swap:** The privileged helper backs up the current binary to `/var/lib/vps-updater/helper/backups/<jobId>/`, atomically renames the candidate into `/usr/local/bin/vps-manager-agent`, and restarts the agent service.
5. **Heartbeat confirmation & safe rollback:** If the restarted agent fails to report a fresh heartbeat matching the target build ID within the grace period, the helper restores the previous binary from backup and records rollback. Failing builds are suppressed for that host until explicitly retried via Update/Retry.

#### Deployment wrapper and platform boundaries

- **One-command deployment (`scripts/deploy.sh`):** Deployments use `bash scripts/deploy.sh` (or `bash scripts/deploy.sh --pull`), which brings up the container stack, verifies API health, and runs `scripts/install/prepare-agent-updater.sh` on the local host. Updater preparation failures warn the operator but do not fail dashboard deployment.
- **Missing-access remediation (`needs_access`):** Remote hosts requiring SSH setup retry asynchronously at most once every 60 seconds and immediately upon manual Update/Retry action. Provide valid authorized SSH keys and sudo rights to clear `needs_access`.
- **Target architecture verification:** Artifact cross-build (10,432,120 bytes, ELF EM_AARCH64), ELF headers, and scoped download authorization via protocol 3 (claim 200, download 200 with exact SHA-256 and size verification; protocol 2 / foreign VPS denied 403) are verified. Native arm64 runtime restart execution remains unverified due to the absence of a native arm64 test host in this environment.
- **End-to-end verification scope:** Automated unit and integration test suites verify the convergence scheduler, protocol 3 updater daemon, and privileged helper state machines. Full live multi-host end-to-end scenarios—including the deployment wrapper with saved-SSH bootstrap, unchanged PID / no job creation on README/web-only deploys, and offline target sequencing—were not verified in this run (waived due to Windows environment).
#### Legacy PID migration and incident context

Legacy user-managed installs historically used `~/.vps-manager-agent/vps-agent.pid`. Ownership checks accept the canonical absolute executable invocation and the installer’s `./vps-agent` invocation only when its working directory matches the managed binary directory. Supported loops use `-config` alone or the complete managed Docker state arguments (`-state`, `-docker-identity-path`, `-docker-runtime-keys-path`, `-docker-runtime-owner-uid`). Config/state paths and runtime owner must match; arbitrary extra flags and one-shot processes are not accepted.

When the deterministic per-VPS systemd unit is active, its `MainPID` is authoritative and the pidfile is ignored: a supervisor restart that leaves `vps-agent.pid` stale still reports the live `MainPID` as owned when it is the single exact exe/argv match. A foreign, missing, zero, or non-numeric `MainPID` fails closed as `mismatch` (never falling back to the pidfile), and multiple exact matches still report `ambiguous`. With no active unit the legacy pidfile policy applies unchanged.
Pull-based convergence updates both local and remote agents using the host-side updater daemon (`vps-updater`) and privileged helper (`vps-updater-apply.service`). Target candidates are validated before swap, backed up under `/var/lib/vps-updater/helper/backups/<jobId>/`, and confirmed through post-restart heartbeats matching the deployment's bundled content build ID. If an agent fails to report a matching heartbeat before the grace deadline expires, the helper restores the prior binary from backup, marks rollback, and suppresses the failing target build ID for that host.
Container logs can remain `Waiting for agent` while metrics are healthy when the installed binary predates the logs claim worker. Check actual `/api/agent/logs/claim` traffic and the running build, not metrics acknowledgments alone. After upgrading, verify an authenticated container logs SSE subscription transitions from `waiting` to `live` and delivers container log frames.

Azure managed service deployment verified on 2026-10-15: host VPS `vps_kUq9jDFzAtxY` is operational under system-level systemd unit `vps-agent-e3d0757876c6e2baf8d0044daa30b1218070930aa38f83de4112794e7eceeb5a.service` executing under login `User=doanphamthanhson`, running build `0.1.0+867941df81e769e07db86edcf9e4314101889735` (PostgreSQL `metric_latest` records `agent_version: "0.1.0"`; Go `-version` embeds commit build ID `867941df81e769e07db86edcf9e4314101889735`). Fresh heartbeat delivery was verified in production PostgreSQL `metric_latest` received at `2026-10-15T13:51:11.208Z` (age 1.988s after systemd restart).

Host-level lifecycle and lock verification confirmed:
- **Duplicate contention rejection:** Launching a competing process (`vps-agent ... -once`) fails immediately with exit code 1 (`instance lock error: agent already running for this VPS`).
- **Offline preflight safety:** Running `<staged-binary> -config <config> -validate-config` while the continuous daemon is active exits 0 and leaves the live daemon PID unchanged.
- **Stable lock inode across restarts:** Executing `systemctl restart` successfully restarts the service while preserving the exact same lock file inode in `/run/vps-manager-agent/` without deletion or recreation.
- **Journal telemetry:** Host systemd journal records Docker metrics committed after restart.
- **Diagnostic stubs audited:** Two diagnostic stubs observed under `/tmp` were verified via SHA-256 and disassembly as tiny 4624- and 4680-byte test binaries executing pause syscall loops; they were terminated via pidfd, confirmed not to be real agents or causes of upgrade timeouts, and no incident root cause is attributed to them.
- **Lifecycle helper smoke tests:** Generated Linux service helper test suite (start, idempotent start, stop, start, uninstall) verified lock inode preservation and passed under unprivileged `nobody` user.
- **Operational scope boundary:** Verification applies strictly to THIS single Azure host (`vps_kUq9jDFzAtxY`); fleet-wide rollout across remaining remote nodes remains unverified pending individual staged upgrades.

## Bundled agent source and updater architecture

The API container packages verified Linux amd64/arm64 agent and updater binaries (`/app/agent/vps-agent-linux-amd64` and `/app/agent/vps-updater-linux-amd64`, or repository `packages/agent/dist/`, configurable via `AGENT_BINARY_PATH`).

On startup, `BundledAgentService` inspects the bundled agent binary's ELF64 header:
- Validates 64-bit little-endian ELF format for Linux (`ELFCLASS64`, `ELFDATA2LSB`, `OSABI_NONE`/`OSABI_LINUX`).
- Detects machine architecture (`EM_X86_64` => `amd64`, `EM_AARCH64` => `arm64`).
- Computes the binary SHA-256 digest and file byte size.
- Parses the embedded VCS build identity (40-hex commit SHA and semver version).
- Fails closed if the binary is corrupt, non-Linux, wrong architecture, or missing valid commit metadata.

When an admin confirms an upgrade in the dashboard:
1. The API creates a persistent upgrade job recording the bundled agent build ID, version, target SHA-256 digest, and an initial deadline.
2. The pull-only host updater daemon (`vps-updater`) polls `GET /api/local-updater/jobs` over outbound HTTPS using a dedicated scoped bearer credential (`Authorization: Bearer vma_<credentialId>_<secret>`, scope `local-updater`).
3. Updater protocol version 2 (`X-Updater-Protocol-Version: 2`) is strictly required on all daemon requests (claim, progress, download, result). Older protocol version 1 updaters are rejected (`updater_incompatible`).
4. The daemon claims the job, receiving an atomic fencing token and target specifications, and streams the binary from `GET /api/local-updater/jobs/:jobId/artifact` directly from the API origin (no redirects allowed). The stream is strictly bounded by `maxArtifactBytes` (default 128 MiB) and verified against `targetSha256`.
5. The daemon stages the verified file under `/var/lib/vps-updater/staging/` and writes a root helper intent record.
6. A privileged helper (`vps-updater-apply`) triggered via systemd path unit re-verifies target size and SHA-256, verifies `<binary> -version`, backs up the existing `/usr/local/bin/vps-manager-agent`, atomically swaps the binary into place, and restarts `vps-manager-agent.service`.
7. Success is determined **only** when the agent publishes a fresh heartbeat carrying the new build ID to `POST /api/agent/metrics` before the deadline.

No external signing keys (`AGENT_RELEASE_SIGNING_KEY`), public keys (`AGENT_RELEASE_PUBLIC_KEY`), or pointer URLs (`AGENT_RELEASE_MANIFEST_URL`) are required for local updates.

## Bootstrap, installation, and updater migration

Install the updater separately from the local metrics agent: it uses a scoped updater credential bound to the local VPS (`vps_local_host`), not a dashboard cookie or metrics token. Generate this credential using the API bootstrap command, transfer it to the host over a secure operator channel, and store it in `/etc/vps-updater/config.json`.

```bash
# Bootstrap fresh updater:
sudo ./scripts/install/install-updater.sh \
  --binary ./vps-updater-linux-amd64 \
  --config ./updater-config.json
```

Supported flags (`install-updater.sh`):
- `--binary <path>`: Path to the vps-updater binary (required unless `--upgrade` with existing binary).
- `--config <path>`: Path to updater config JSON (required unless `--upgrade` with existing config).
- `--upgrade`: Upgrade existing updater to protocol 2 without release manifest or signing keys.
- `--dry-run`: Preview actions without making filesystem or service modifications.
- `--uninstall` (optionally `--purge-state`): Stop services and remove updater units.

### Migrating existing host updaters to protocol 2

Existing host updaters installed under the legacy signed-manifest protocol must be upgraded to protocol 2 to support bundled agent updates:

```bash
sudo ./scripts/install/install-updater.sh \
  --upgrade \
  --binary /path/to/vps-updater-linux-amd64 \
  --config /etc/vps-updater/config.json
```

The `--upgrade` operation:
- Preserves the existing `/etc/vps-updater/config.json` configuration, scoped credentials (`vma_...`), state directory (`/var/lib/vps-updater`), and journals.
- Updates the updater executable at `/usr/local/lib/vps-manager-agent/vps-updater` with 0755 permissions.
- Verifies systemd units (`vps-updater.service`, `vps-updater-apply.path`, `vps-updater-apply.service`) and restarts `vps-updater.service`.
- Requires only `apiBase`, `credential`, `agentBinary`, and `stateDir` in `/etc/vps-updater/config.json`. Any legacy `pinnedPublicKey` in the configuration is safely ignored.
- Enforces preflight quiescence before mutation: refuses an active helper service (`vps-updater-apply.service`), pending queue actions (`pending/`), an in-flight daemon journal (`journal.json`), or an in-flight (`intent`/`renamed`) or malformed/unrecognised helper journal (`helper/journal.json`). Settled helper journals (`restarted`, `rolled_back`) are permitted when the helper is inactive and no daemon journal or pending actions exist, preserving historical journals and backups while allowing routine deployment upgrades.

The production deployment workflow (`ci.yml`) automatically extracts the bundled `vps-updater-linux-amd64` from the deployed API container and runs `install-updater.sh --upgrade` during deployment, keeping host updaters current without touching credentials or state.

## Bootstrap and authorization

Limit updater credentials to a single local VPS and rotate/revoke them independently of metrics credentials. A credential leak warrants immediate revocation and host inspection. An updater that is absent or unhealthy leaves the dashboard in manual-instructions mode; it must not show an actionable upgrade button.
Credential cutover: `bootstrap-local-updater --rotate` creates a new scoped credential, revokes older updater credentials, and prints the new token once. The running updater will fail authentication until its root-owned config is updated and its service restarted. For uninterrupted cutover, use `bootstrap-local-updater --rotate --keep-previous`, install the new token, confirm the updater is healthy, then close the overlap with `revoke-agent-credentials --scope local-updater --keep-credential-id <newCredentialId>`. That revoke command defaults to the `agent` scope when `--scope` is omitted; it refuses a missing, inactive, or wrong-scope keep ID without revoking anything. Never leave the overlap open indefinitely.

## Backend URL cutover (`flexserverctl set-backend`)

Operational status (endpoint-only): host cutover to `https://api.flexserver.tech` verified via `applied-with-heartbeat-confirmation-required` plus a fresh heartbeat; canonical `AGENT_PUBLIC_BASE_URL` GitHub repo Variable persistently holds `https://api.flexserver.tech`; `https://flexserver.tech` remains available. Binary-upgrade production gate remains unverified.

Use `flexserverctl set-backend <URL>` to repoint an **existing** agent. Do not rerun `install.sh --backend-url` (or the standalone installers) for this: that flag sets the public setting and the default for newly written configs and deliberately leaves an already-installed config untouched rather than resetting its backend URL, so a rerun changes nothing on the agent you meant to repoint. It preserves the existing `vma_...` token, never prints it, and never logs config contents; rotation stays a separate, lossy bootstrap step (`--rotate` prints the raw token once and it cannot be recovered), so no `--rotate` is part of a URL change.

Run `flexserverctl help` for the full surface. `--dry-run` is the only safe preview — no write, no stop, no start, no backup file — printing `dry-run: no changes applied` and exiting 0. `flexserverctl validate-url <URL> [--updater]` validates a URL with zero side effects (exit 0 acceptable, 1 otherwise); `--updater` applies the stricter https-only updater `apiBase` rule.

```bash
flexserverctl help
flexserverctl validate-url https://api.flexserver.tech
sudo flexserverctl set-backend https://api.flexserver.tech --dry-run     # auto mode (default)
sudo flexserverctl set-backend https://api.flexserver.tech              # auto mode
flexserverctl set-backend https://api.flexserver.tech --mode user       # explicit mode
```

`--mode auto` (the default) picks `systemd` when running as root with a root-owned systemd agent install, else `user` when `~/.vps-manager-agent` exists, and otherwise fails with a hint to pass `--mode` explicitly; `--mode systemd` and `--mode user` remain the explicit forms. Systemd mode rewrites `backendUrl` in `/etc/vps-manager-agent/config.json` and — only when the updater config exists — `apiBase` in `/etc/vps-updater/config.json` to the same URL; when `vps-updater` is absent the updater leg is skipped. User mode (for example Azure hosts without systemd) rewrites `backendUrl` in `~/.vps-manager-agent/config.json`. Reading root-owned configs under `--mode systemd` may require `sudo`. A split backend/updater base leaves upgrades unhealthy, so apply the same URL to both when both are installed.

Migration targets must be HTTPS — an existing loopback value left in an old config is not a migration target. The updater `apiBase` must stay `https`. URL validation checks shape only: there is no hostname allowlist or denylist, so DNS and TLS are settled by the health probe rather than a name check.

The CLI probes health with a credential-free `GET <url>/api/health` (`User-Agent: flexserverctl/1.0`, system TLS verification, no redirect followed, bounded timeout/body, requiring HTTP 200 plus valid `{"ok": true}`) **before** any write, and runs one ordered transaction: snapshots, health probe, stop the owned old loop, write config(s), delivery preflight, restart, postcheck. The delivery preflight runs as `<agent> -config <cfg> -state <tempdir>/state.json -once -host-only` after the old loop has stopped (so the singleton lock is unheld), ensuring it never clobbers the real state file and verifies candidate connectivity before restarting the service. For staged upgrade preflights where the active daemon is still running, `-validate-config` is used instead so configuration syntax is checked offline without singleton lock contention. Applying the same URL again still restarts the agent unit (and the updater unit when installed). A restart is liveness only — never delivery proof: a clean success is reported as `applied-with-heartbeat-confirmation-required`, and only a fresh agent heartbeat from the parent API completes the cutover. The updater contributes local proof at best (`updater-process-observed`); idle journal silence is not authenticated delivery. On success the only on-disk artifact the CLI leaves behind is `.flexserverctl.bak`, which it deletes.

Updater guard: when installed, the updater must be quiescent. A persisted settled helper record (phase `restarted` or `rolled_back`) is permitted only when no daemon journal and no pending queue entries exist; an active daemon run, pending actions, or a corrupt/in-flight helper state cause the cutover to refuse before mutation. The updater daemon is stopped before the config write and a re-check occurs after the stop, so a refusal never leaves the daemon down and never mutates updater state.

Advanced (non-default) environment seams override the production literals for staging or testing: `FLEXSERVERCTL_AGENT_CONFIG`, `FLEXSERVERCTL_UPDATER_CONFIG`, `FLEXSERVERCTL_USER_CONFIG`, `FLEXSERVERCTL_AGENT_BIN`, `FLEXSERVERCTL_UPDATER_BIN`, `FLEXSERVERCTL_SYSTEMCTL_BIN`, `FLEXSERVERCTL_PROC_ROOT`, `FLEXSERVERCTL_HOME`. All default to the production paths and binaries, and there is no environment switch that skips the Linux check — the CLI is Linux-only and fails on other platforms.

Exit codes: `0` for success or a clean dry-run, `1` for any refusal (bad URL, health failure, preflight failure, `restored`, `rollback-failed`). There is no other error code and no `--yes`/`--force` override. A pre-write refusal prints its reason to stderr in the form `Error: <reason>`.

On failure each touched config is restored from its `<config>.flexserverctl.bak` companion with the original bytes, owner and mode, the newly started loop is stopped, and the original loop is restarted with its preserved argv and cwd when one was running. The outcome is `restored` when that rollback succeeds byte-for-byte. If the restore itself fails, the outcome is `rollback-failed`: the `.flexserverctl.bak` files are deliberately retained as operator recovery material (they are deleted only after a verified-successful restore) and manual intervention is required. Endpoint or service recovery is not promised — if the new backend is unreachable, the agent may report no metrics until the URL is fixed.

Stable-domain prerequisite: before cutting over to any stable API domain, its DNS must resolve from the agent host, its TLS certificate must be valid, and its reverse proxy must `proxy_pass` `/api/` to the API (for example Nginx Proxy Manager on the working `flexserver.tech` host) — the cutover validation does not follow redirects, so point at the proxied API origin rather than a redirecting URL. Keep the dashboard origin (`DASHBOARD_PUBLIC_ORIGIN`, with `TRUST_PROXY_HOPS` set per deployment, e.g. `1` behind a single reverse proxy) separate from the agent/API base URL, and set the canonical `AGENT_PUBLIC_BASE_URL` so remote installers generate reachable configs (`AGENT_PUBLIC_BASE_URL` required, HTTPS unless `ALLOW_INSECURE_AGENT_HTTP=true`). `api.flexserver.tech` DNS resolves and its HTTPS API origin is operational and verified, served through Nginx Proxy Manager with a managed certificate — it is an accepted backend URL once the health probe passes. Host cutover to `https://api.flexserver.tech` is verified (endpoint-only: `applied-with-heartbeat-confirmation-required` plus a fresh heartbeat); the canonical `AGENT_PUBLIC_BASE_URL` GitHub repo Variable persistently holds `https://api.flexserver.tech`. `flexserver.tech` remains a working origin. This does not verify the binary-upgrade production gate. Existing agents are not automatically migrated, so repoint each one explicitly with `flexserverctl set-backend`. The installers' URL acceptance is deliberately separate from the migration contract above: they still accept plain `http` for exact `localhost`, `127.0.0.1`, `[::1]` (rejecting `0.0.0.0` and lookalike hosts such as `localhost.example.com`), which is a bootstrap allowance, not permission to settle on loopback as a long-lived backend.

## Upgrade and incident checks

1. On the dashboard's local VPS card or table, compare installed version/build ID and heartbeat age with the bundled binary build ID. `unknown` or stale heartbeat is not evidence that the agent is current. Check updater status and ensure protocol version 2 is active before opening the confirmation dialog.
2. Confirm a single job. The API stores the chosen release ID/hash, idempotency key and deadline; the updater claims it with a lease/fencing token. Refreshing the dashboard must reuse the existing job instead of creating another one.
3. On the host inspect `systemctl status vps-updater.service vps-updater-apply.path vps-manager-agent.service` and `journalctl -u vps-updater.service -u vps-updater-apply.service --since '30 minutes ago'`. Use `vps-updater status` to inspect durable journal and pending actions. Avoid printing credential/config content in diagnostics.
4. When the daemon downloads the bundled artifact from `GET /api/local-updater/jobs/:jobId/artifact`, it verifies the incoming stream against the target SHA-256 digest and size caps. The privileged helper (`vps-updater-apply`) confirms the binary hash, checks `<binary> -version`, saves a backup to `/var/lib/vps-updater/helper/backups/`, atomically swaps `/usr/local/bin/vps-manager-agent`, and restarts `vps-manager-agent.service`. A successful job requires a *new* heartbeat carrying the target build ID from the correct VPS after restart. `systemctl is-active` or a changed binary hash alone is insufficient. Verify `vps-manager-agent -version` matches the bundled release identity, the local Docker snapshot source sequence advances, and at least two fresh samples appear in the chart before closing the incident.
5. On rollback (due to restart failure or heartbeat timeout), the helper restores the previous binary from `/var/lib/vps-updater/helper/backups/`, restarts the unit, and the API verifies the old binary identity via a fresh heartbeat carrying its previous build ID. `rollback_unverified` means host state is uncertain: stop creating new jobs, retain backup and journal, inspect binary hash/service state manually. After recovery, run `sudo -u vps-updater /usr/local/lib/vps-manager-agent/vps-updater ack -config /etc/vps-updater/config.json` (not as root: the journal must remain owned by the daemon); confirm the server rules `rolled_back` and the updater consumes its journal. Do not delete backups or blindly retry a swapped mutation. Both installer preflight and CLI guard preserve these retained journals and backups, refusing mutation whenever an active daemon journal or in-flight helper state exists, while accepting demonstrably settled records (`restarted` or `rolled_back`) once the daemon and helper are idle.
6. If the updater is not installed, the dashboard displays manual instructions during a maintenance window: extract the bundled binary directly from the API deployment (`docker compose exec -T api cat /app/agent/vps-agent-linux-amd64 > /tmp/vps-manager-agent`), verify `./vps-manager-agent -version` and its SHA-256 checksum, back up the existing binary, atomically replace `/usr/local/bin/vps-manager-agent`, restart `vps-manager-agent.service`, and verify a fresh matching heartbeat. No external catalog or key download is needed.
7. For remote systemd-managed agents:
   - Verify unit status and journal: `systemctl status vps-agent-<hash>.service` and `journalctl -u vps-agent-<hash>.service -n 50 --no-pager`.
   - Verify singleton lock: inspect `/run/vps-manager-agent/vps-agent-<hash>.lock` (must be root-owned 0666 regular file in root-owned 0755 directory `/run/vps-manager-agent`). An attempt to launch a competing instance (`vps-agent -config <cfg> -once`) must immediately fail closed with `instance lock error: agent already running for this VPS`.
   - Verify offline config preflight: `vps-agent -config <cfg> -validate-config` must exit 0 without acquiring the lock, contacting the network, or mutating state.

## Rollout and rollback gate

This gate covers binary upgrades only; the endpoint cutover to `https://api.flexserver.tech` is verified separately and does not satisfy this gate. Note on operational limits and status: local test verification passed against simulated updater and heartbeat processes; it does not constitute a verified production rollout on real systemd hosts. Before rolling out in production, execute the verification procedure on a disposable Linux staging host: install the updater and scoped credential, confirm an upgrade to the bundled binary, verify process build ID, fresh heartbeat, Docker source sequence and chart samples. Fault-inject simulated failure scenarios: corrupt/mismatched SHA-256, interrupted download, disk exhaustion, crash after swap, and missing heartbeat; verify no unconfirmed success and a recoverable journal/backup. Force a failed restart and confirm rollback identity. Only then perform an authorized production canary. If a bundled release must be withdrawn, redeploying the API container with a previous bundled binary updates the target, but does not roll back the host agent automatically until an upgrade job is confirmed or manual fallback is applied. Never label a staging or production rollout verified without observing those host checks.

## Signed fleet release promotion

The fleet channel is separate from the deployed-image local upgrade path above. `scripts/release/fleet-release.mjs` signs `{payload, signature, keyId}`: Ed25519 authenticates the exact UTF-8 payload string, not reconstructed JSON. Artifacts bind component, Linux architecture, byte size, SHA-256 and credential-free HTTPS URL. Every platform requires an agent/updater pair; publishing any AI component requires the complete four-component AI runtime.

Use **Promote stable agent release** (`.github/workflows/fleet-release.yml`) with a main-branch ancestor commit, semantic version, minimum updater version and explicit rollback-safety declaration. Verification pins the commit used by promotion. Configure the `agent-stable` GitHub environment with required reviewers; promotion refuses publication unless the reviewer rule exists. Configure environment secrets `FLEET_RELEASE_SIGNING_KEY` (Ed25519 private PEM), `FLEET_ENVIRONMENT_READ_TOKEN` (repository environment metadata read permission), and variable `FLEET_RELEASE_KEY_ID`. Signing secrets never belong in API or host environments.

Promotion cross-builds Linux amd64/arm64 executables, packages the pinned BusyBox rootfs and committed profiles, hashes actual artifacts, signs and verifies before publication. Immutable release `agent-<buildId>` must not already exist. The signed `stable.json` pointer under release `agent-stable` is replaced only after artifact publication.

```sh
node scripts/release/fleet-release.mjs sign --spec spec.json --key private.pem --key-id release-key --output stable.json
node scripts/release/fleet-release.mjs verify --manifest stable.json --key public.pem --expect-release <40-hex-build-id>
```

The specification adds `file` to each signed artifact; signing derives size and hash from actual file bytes. The workflow generates its specification with `scripts/release/fleet-spec.mjs` using `BUILD_ID`, `REPOSITORY`, `RELEASE_VERSION`, `MIN_UPDATER`, `ROLLBACK_SAFE` and optional comma-separated `UPGRADE_FROM`.

Configure API trust with external Ed25519 public PEM path `FLEET_RELEASE_PUBLIC_KEY_FILE` and HTTPS pointer `FLEET_RELEASE_MANIFEST_URL`. Mount the public key read-only at that absolute path; the keyring Compose override mounts `/etc/flexserver` read-only. Distribute the public key through the existing trusted administration channel, not from the manifest being verified.

Local release smoke verified actual artifact signing, exact-payload verification, rejection of tampering/untrusted keys, incomplete/duplicate platform sets, and cleartext artifact URLs. Remote GitHub publication and environment approval remain unexercised.

## Signed fleet host updater operations

### Pinned release key and envelope verification
The host updater (`vps-updater`) enforces cryptographic verification of release manifests before any staging or execution occurs:
- Pinned public key path: `/etc/vps-updater/fleet-release.pub` (root-owned 0644). In production, this path is immutable and enforced against the root-owned config.
- The signature envelope is parsed as `{payload: string, signature: string, keyId: string}`. The Ed25519 signature is strictly validated against the exact UTF-8 bytes of `payload`. Recanonicalization is forbidden.
- Verification asserts required manifest fields: `schemaVersion == 1`, `releaseId == buildId`, `channel == "stable"`, and presence of required platform artifacts (`agent`, `updater`).

CLI verification check for operators:
```bash
/usr/local/lib/vps-manager-agent/vps-updater verify \
  -manifest /path/to/manifest.json \
  -pubkey-file /etc/vps-updater/fleet-release.pub
```

### Multi-component upgrade lifecycle
1. **Evidence & protocol:** The updater connects to the API via pull protocol version 3 (`X-Updater-Protocol-Version: 3`), advertising host OS, architecture, current versions, CPU load/busy state, and local AI capability & health.
2. **Updater self-upgrade:** If the release contains a newer `vps-updater` binary, the updater stages and replaces itself first, restarting its service to execute subsequent steps under the newer supervisor logic.
3. **Agent binary swap:** The agent binary is backed up to a root-owned backup directory and replaced atomically by rename (`renameat2` / POSIX atomic rename).
4. **AI component upgrades:** AI components (`ai-executor`, `ai-host-helper`, `ai-rootfs`, `ai-profiles`) are updated only if already installed on the host. Uninstalled components are never silently activated. Rootfs archives are unpacked with leading `rootfs/` stripped; profiles archives are unpacked with leading `profiles/` stripped.
5. **Awaiting heartbeat & observation:** After service restart, the updater monitors agent health and AI helper health. If health checks fail or the grace window elapses, the updater executes automatic rollback from the root-owned backup.
6. **Safe pruning:** On server-ruled terminal completion, the updater cleans the terminal job's staging and retains current + previous backup generations for crash resilience.

### Multi-component upgrade and rollback operational verification

Operational verification exercises real binary compilation, CLI signature verification against valid/tampered/untrusted fixtures, rootfs extraction with symlink handling, and the multi-component upgrade/rollback lifecycle:
1. **Signature and manifest verification:** Confirm that tampered payloads, unknown signing keys, or mismatched SHA-256 digests fail closed before binary staging.
2. **Staging and rootfs extraction:** Verify that unprivileged staging directories unpack archives with stripped path prefixes and correct file modes without privilege escalation.
3. **Atomic swap and rollback execution:** Confirm that service supervision restarts the agent under the target binary, and if post-restart heartbeat validation fails, the privileged helper restores the previous generation from backup and suppresses the failed build ID until operator retry.
