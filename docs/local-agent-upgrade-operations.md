# Local agent upgrades: operator runbook

The dashboard's local-agent update status compares a fresh agent heartbeat/build ID with the deployed API image's bundled agent binary (`/app/agent/vps-agent-linux-amd64`). Local agent upgrades use this bundled API artifact directly and require no manual signing keys or external release catalogs. Deploying an API image updates the available bundled binary, but does **not** automatically replace the host systemd agent on disk. Local host agent upgrades are performed pull-only by a separately installed host updater daemon using scoped bearer credentials and a constrained root helper, verified by fresh agent heartbeats. The API container must not receive a Docker socket, systemd socket, root filesystem mount, or host root credentials. Remote SSH agent upgrades remain a separate workflow.

### Remote SSH process ownership and managed systemd service

Remote agent management on systemd-capable Linux hosts uses a dedicated system-level systemd service:
`/etc/systemd/system/vps-agent-${sha256(vpsId).toLowerCase()}.service`.
Local host agent installations retain the canonical `vps-manager-agent.service` unit to preserve updater daemon (`vps-updater`) supervision and atomic swaps; only remote SSH managed services use the hashed unit naming scheme.
The unit executes as the host login user (`User=<user>`, `Group=<group>`), with `WorkingDirectory=<homeDir>`, `Restart=always`, `RestartSec=10`, `TimeoutStopSec=15`, and `KillMode=control-group`. `KillMode=control-group` provides complete descendant process cleanup and signal propagation on service stop or restart to avoid orphan workers; it is process lifecycle termination management, not a security sandbox or privilege boundary.
Sudo/root access is required for remote service configuration, unit installation, and lifecycle transitions; there is no fallback to unprivileged `nohup` background loops. Supported service configurations preserve all managed Docker state arguments (`-state`, `-docker-identity-path`, `-docker-runtime-keys-path`, `-docker-runtime-owner-uid`) alongside `-config`.

#### Per-VPS singleton process lock

To prevent duplicate agent instances and conflicting background metric collectors for the same VPS, the agent enforces a per-VPS singleton OS process lock on Linux:
- **Lock path:** `/run/vps-manager-agent/vps-agent-${sha256(vpsId).toLowerCase()}.lock`.
- **Directory & file security:** The directory `/run/vps-manager-agent` is root-owned with mode `0755` (`perm & 0022 == 0`). The lock file is a root-owned regular file with mode `0666`.
- **Provisioning (No RuntimeDirectory):** Provisioned via `/etc/tmpfiles.d/vps-manager-agent.conf` and `systemd-tmpfiles --create`. The service unit must **not** specify `RuntimeDirectory=`; systemd's `RuntimeDirectory=` directive automatically transfers directory ownership to the service's unprivileged `User=`, which would break the trusted root-ownership invariant (`0755` root:root). The local agent installer also provisions this tmpfiles configuration so directory and permissions persist across reboots.
- **Invariants:** The lock file is opened with `O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK` and verified to be a root-owned regular file. On Linux, there is no fallback path and no environment variable override. Root processes can create the file and directory if missing; unprivileged agent processes require pre-provisioning and fail closed with an actionable error if absent.
- **Acquisition and crash release:** The lock is acquired via non-blocking exclusive flock (`syscall.Flock(fd, LOCK_EX|LOCK_NB)`). The descriptor is held for the process lifetime. On crash or termination, the kernel automatically releases the flock. The lock file is **never** unlinked or truncated on release or exit, ensuring all competing processes contend on the same inode across restarts.
- **Contention with `-once`:** Executing `vps-agent ... -once` acquires the exact same non-blocking OS lock before initiating metrics collection or network calls. If another agent instance is active for the VPS, `-once` exits immediately with `instance lock error: agent already running for this VPS`.

#### Upgrade preflight and offline config validation (`-validate-config`)

Because `-once` contends for the singleton lock and will fail if the daemon is running, staged upgrade preflights must not use `-once` against an active loop. Instead, candidate binaries are validated using the offline flag:
```bash
<candidate-binary> -config <config-path> -validate-config
```
`-validate-config` loads and validates configuration syntax and required fields without acquiring the singleton lock, without initiating network traffic, and without mutating state or filesystem contents. This offline preflight succeeds safely while the continuous daemon holds the active singleton lock.

#### Transactional remote upgrade lifecycle

Remote agent upgrades follow an ordered, transactional sequence:
1. **Stage candidate binary:** Upload candidate binary to a temporary staged path (`vps-agent.stage-<nonce>`).
2. **Offline preflight:** Verify configuration and syntax with `<staged-binary> -config <config> -validate-config`.
3. **Inspect and stop service:** Verify existing process ownership and stop the unit via `systemctl stop vps-agent-<hash>.service`.
4. **Backup and swap:** Back up the existing binary to a timestamped backup path and atomically replace it with the staged binary.
5. **Start service:** Start the unit via `systemctl start vps-agent-<hash>.service` (ensuring tmpfiles runtime lock and unit configuration are active).
6. **Heartbeat confirmation & rollback:** Await fresh heartbeat with matching version and build ID. On start failure or heartbeat timeout, rollback automatically restores the previous binary and restarts the service.

#### Legacy PID migration and incident context

Legacy user-managed installs historically used `~/.vps-manager-agent/vps-agent.pid`. Ownership checks accept the canonical absolute executable invocation and the installer’s `./vps-agent` invocation only when its working directory matches the managed binary directory. Supported loops use `-config` alone or the complete managed Docker state arguments (`-state`, `-docker-identity-path`, `-docker-runtime-keys-path`, `-docker-runtime-owner-uid`). Config/state paths and runtime owner must match; arbitrary extra flags and one-shot processes are not accepted.

Legacy PID tracking is retained strictly as a safe migration path to transition existing nohup loops to systemd. A genuinely absent process is permitted during upgrade and rollback. Invalid, mismatched or ambiguous ownership still refuses mutation: inspect the PID file and process identity rather than deleting the PID file or killing processes indiscriminately. Never terminate unknown process names or foreign PID files.

Remote upgrade confirmation parses `<version>+<40-hex Git build ID>` from the candidate's `-version` output. Heartbeats carry `version` and `buildId` separately: both must match the candidate, and `lastSeenAt` must be strictly newer than the post-preflight/post-stop baseline. A staged preflight heartbeat is not proof of the newly started loop. Legacy/dev binaries without a build ID are verified by version and freshness; rollback also checks the prior build ID when recorded.

If a running candidate reports metrics but the job times out and rolls back, inspect the job and version/build fields before diagnosing network failure. The former composite-version comparison caused this exact symptom. Deploy the corrected API before retrying the upgrade; do not disable heartbeat verification or manually delete delivery state.

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
