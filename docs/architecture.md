# Architecture

This repository is an npm workspaces monorepo with a NestJS API and Vite React dashboard.

## Runtime Shape

The backend starts from `packages/api/src/server.ts`, creates an Express server, mounts request ID middleware, Helmet, mutation rate limiting, static serving from root `public/`, and then attaches NestJS through an Express adapter.

`packages/api/src/app.module.ts` wires controllers and services with dependency injection. The current portfolio MVP keeps JSON persistence behind repository interfaces so SQLite can replace it later without changing controllers.

## Backend Modules

- Config: parses `APP_MODE`, `DASHBOARD_SESSION_SECRET`, terminal flags, private-network flags, and storage directories.
- VPS: stores local VPS metadata in `data/vps.json` and preserves the existing CRUD/provision/verify API.
- SSH: wraps real `ssh2` helpers with demo-mode and host-policy gates.
- Dashboard: exposes `GET /api/dashboard` with demo overview data, jobs, metrics, audit, terminal, and settings.
- Audit, Jobs, Metrics: JSON-backed primitives for portfolio MVP operational depth.

## Frontend

`packages/web` is a Vite React app using local shadcn-style primitives and Tailwind tokens. The dashboard renders a single page with section anchors for Overview, Servers, Jobs, Metrics, Terminal, Audit Log, and Settings.

## Persistence

The MVP uses JSON files under `data/` and key material under `private/`. JSON writes use atomic temp-file replacement and private file modes. `data/` and `private/` are not statically served.

## Deployment

`Dockerfile` builds web assets into `public/`, compiles the API into `dist/`, runs as a non-root user, exposes port 3000, and checks `/api/health`. `docker-compose.yml` starts demo mode with writable volumes for `/app/data` and `/app/private`.

Deployment agent builds use a content identity rather than repository HEAD: `go run ./cmd/agent-build-id --root .` from `packages/agent` hashes the normalized runtime Go/module inputs, embedded runtime assets for Linux amd64/arm64, Go toolchain version, and fixed build recipe. The first 40 lowercase hex characters of SHA-256 identify the build; artifact verification still uses the full SHA-256 digest. Test files, calculator sources, docs, and other workspace packages do not affect this identity. Docker and `scripts/agent/build-agent.mjs` compile with `-trimpath -buildvcs=false` and display version `dev` unless `AGENT_VERSION` is explicitly supplied. Deployment builds ignore `AGENT_BUILD_ID`; externally pinned identities remain confined to signed-release tooling.

## Docker Compose applications (phase 2)

Compose applications extend the existing Docker workspace. The API owns authenticated application policy and versioned storage; the agent reports bounded runtime inventory/capability and is the host-side execution boundary. Do not expose host Docker access to API/web. A distinct per-VPS gate controls mutations; detected projects remain read-only unless an operator explicitly opts in to external control or supplies managed configuration. Runtime capability must be verified before any operation is admitted, and installation/preparation is separately explicit. A visible application record does not imply runtime compatibility or complete lifecycle/deployment support; unsupported and unverified states remain unavailable.

Compose encrypted fields use an external Compose KEK separate from the SSH keyring. Key material is never stored in application data/private volumes or served in API responses. JSON storage is single-writer; PostgreSQL uses transactions for shared admission/state. Approval is bound to a daemon-wide inventory fingerprint plus an exact removed-service ownership manifest, so versioned storage data alone never authorizes mutation of a runtime state that has since drifted. See [Security Model](security.md#docker-compose-applications-phase-2) for source consent, keyring recovery/rotation, and deployment safety.

## Docker Management

Docker monitoring remains read-only and can be enabled independently from `dockerManagementEnabled`, which defaults to `false`. Read-only container logs are available by default for non-system VPS records and the system-managed local host in local mode, independently of that flag and without a new toggle. Management opt-in permits both added VPSs and system-managed records with `kind: local`; system-managed remote hosts remain excluded. Each host's Settings page exposes the Docker management toggle independently of monitoring; the Docker page contains container actions, not permission settings. Start submits immediately; Stop and Restart require confirmation bound to the selected agent instance and opaque container key. Changing the target cancels confirmation. The API stores bounded operation state in the configured JSON or PostgreSQL repository and never opens the Docker socket.

The agent owns Docker socket access. Its independent command worker claims authenticated operations, records bounded receipts, enforces deadlines and target identity, and reports uncertain outcomes without replaying a mutation. Container logs are requested on demand and stream over a dedicated SSE viewer; they are held only in memory and are not written to jobs, audit, or persistent storage.

Deploy an agent containing the command worker before enabling Docker management for a VPS or the local host. The agent must run without `--host-only` and have Docker socket access; the local installer opt-in `--enable-docker-metrics-access` also supplies Docker group access for controls. Docker group access is root-equivalent. Container browsing and Refresh containers remain available when monitoring is disabled; action targets are exposed when management is enabled or read-only logs are supported. Monitoring data itself is still controlled by `dockerMetricsEnabled`. Operations remain queued until claimed; use Check status manually to retrieve the outcome. Do not retry an uncertain mutation automatically. Stopping a local container can interrupt this dashboard itself.

### Realtime container logs

Container logs are an approved exception to the Phase 1 no-ingestion invariant only: they are on demand, ephemeral, and never persist. A viewer opens `GET /api/vps/:id/docker/management/logs/stream?agentInstanceId=<id>&containerKey=<key>`, which creates one in-RAM `DockerLogsService` subscription that the opening connection is the only viewer of, bounded at 4 concurrent streams per VPS and 32 per API instance. The agent claims the waiting subscription with `POST /api/agent/logs/claim`, opens exactly one Docker `GET /containers/{id}/logs?stdout=1&stderr=1&tail=200&timestamps=1&follow=1` request, and uploads bounded batches with `POST /api/agent/logs/:subscriptionId/chunks` before reporting the terminal outcome with `POST /api/agent/logs/:subscriptionId/result`. There is no snapshot-then-follow pair and no reconnect to the same subscription, so the fixed 200-line tail is read once and the connection never replays it.

Log content never reaches persistence, monitoring, or audit. Lines are streamed to the browser on a dedicated SSE endpoint (`docker.logs.state`, `docker.logs.lines`, `docker.logs.closed`) that shares no transport, buffer, or event with `monitoring.snapshot`/`metrics.updated`, and nothing is written to `data/`, PostgreSQL, audit, jobs, or Docker monitoring repositories. Reconnect is deliberately a new viewer: the browser buffer is dropped, a new subscription is opened, and Docker re-serves the latest 200 lines, so a network gap can lose the lines in flight rather than silently duplicating or backfilling them. The viewer retains at most 2,000 lines or 1 MiB of text and discards the oldest with a visible notice; the agent caps one line at 4 KiB UTF-8 and one batch at 100 lines or a 32 KiB serialized body.

Docker log streaming uses `logsSupported`, not the management action capability or `dockerManagementEnabled`, for opening and revalidating subscriptions. In local mode, logs are supported for non-system VPS records and system-managed records with `kind: local`; other system records remain excluded. Demo mode reports unsupported with an explicit reason rather than faking a source. Local and added VPS agents use the same authenticated claim/chunks/result protocol; the in-process local metrics collector cannot supply Docker logs. Dashboard session and origin checks, authenticated agent credentials bound to the VPS, and current inventory membership for the exact `agentInstanceId`/`containerKey` pair remain required. Disabling management does not disable an otherwise permitted read-only stream or authorize any action. System-managed local hosts remain blocked from destructive management actions. Agent-side log reading is Linux-only through the Docker Unix socket `/var/run/docker.sock`; other platforms report an explicit unsupported transport instead of dialing any TCP daemon endpoint. A subscription that never reaches a live source closes with `agent_unavailable` after 30 seconds, a silent source closes with `stream_lost` after 10 seconds, session loss closes with `session_expired`, and the hard lifetime cap is 2 hours. Rollout requires the new API and a new Linux agent together: an old agent cannot claim, so the viewer shows a bounded failure instead of fabricated lines.

Docker monitoring accepts only schema v2 snapshots with durable agent identity and source sequence. Deploy the API migration and provisioned v2 agent before relying on Docker history or dashboard snapshots; old v1 rows are not projected or backfilled. Verify a fresh `docker_metric_samples` row with a non-legacy `agent_instance_id`, advancing `docker_ingest_latest.source_sequence`, and a committed `docker_event_watermarks` row. Host metrics and API health alone do not prove Docker v2 ingestion.

Docker container troubleshooting details are an additive, bounded projection inside the same committed monitoring snapshot as container metrics. Agent inspect is restricted to selected opaque-key targets resolved to validated full daemon IDs; only lifecycle metadata, port bindings, mount paths, network addresses, health status/timings, exit/OOM and restart metadata are projected. Raw inspect, environment, labels, health commands/output and daemon IDs are excluded. Details carry their actual collection time, may be unavailable when the bounded inspect budget expires, and are never carried forward from an older snapshot. Roll out migration `027_docker_container_details.sql` and the API before upgraded agents; older agents may omit details. The Docker tab presents selected-container details and scoped lifecycle events next to existing logs. Log search/filter acts only on the bounded in-memory buffer and does not query Docker history.

Docker ingest digest v2 excludes server receipt timestamps from mapped container samples and events, and binds the event protocol and availability/version metadata. Identical retransmissions return the original committed acknowledgment without advancing history twice. Legacy digest-v1 commits are authenticated by recomputing the original projection at the stored receipt time and checking ledger identity, sequence, and proposed watermark. Legacy v1 did not bind every metadata field; compatibility does not retroactively strengthen that historical contract. Older JSON ledgers without a stored acknowledgment watermark require matching current watermark evidence; missing or advanced evidence fails closed. Do not clear pending agent state to work around replay conflicts.

## Local and Fleet Agent Updates (Automatic Deployment Convergence & Protocol 3 Pull Updater)

All managed agent installations (local and remote) automatically converge to the deployment-bundled artifact via `AgentConvergenceService` and the pull-only `LocalUpgradeService` updater daemon running on the host. Deploying FlexServer defines the authoritative target binary and triggers convergence at API startup without waiting for agent idle. Active terminal sessions, AI tasks, and Compose operations do not defer bundled agent updates; restarting agents or refreshed helpers may interrupt them. Offline hosts wait for connectivity; missing updater bootstrap credentials report actionable `needs_access`. Update failures suppress only the failing target build ID for that host until manually retried via Update/Retry. Deployment agent identity is calculated from Go source/build recipe contents, so web/doc-only changes do not trigger agent upgrades. Signed Ed25519 manifests and verification remain preserved for AI runtime components; new signed rollouts containing `agent` or `updater` remain rejected.
### Component boundaries and trust model

1. **Bundled API artifact & signed fleet manifests:**
   - **Bundled deployment convergence:** The API image packages verified Linux agent and updater binaries (`/app/agent/vps-agent-linux-amd64`, `/app/agent/vps-agent-linux-arm64`, and matching updater binaries). At startup, `BundledAgentService` parses the binary ELF64 header, verifying little-endian Linux format, target architecture (`amd64` or `arm64`), file size, SHA-256 digest, and embedded 40-hex content build ID computed from non-test Go source files and build recipe. The binary is served over HTTPS from `GET /api/local-updater/jobs/:jobId/artifact` exclusively to authorized updaters for their assigned job. Artifact cross-build (10,432,120 bytes, ELF EM_AARCH64), ELF headers, and scoped download authorization via protocol 3 (claim 200, download 200 with exact SHA-256 and size verification; protocol 2 / foreign VPS denied 403) are verified; native arm64 runtime restart execution remains unavailable due to the absence of a native arm64 test host in this environment.
   - **Signed fleet manifests (AI runtime):** Fleet updates distribute an immutable release envelope (`{ payload: "<raw UTF-8 JSON string>", signature: "<base64 Ed25519>", keyId: "<keyId>" }`). The manifest payload specifies `schemaVersion: 1`, `channel: "stable"`, matching 40-hex commit hash for `releaseId` and `buildId`, semver version formatting, and `rollbackSafe: true`. Ed25519 signature verification operates directly on exact payload UTF-8 string bytes without recanonicalizing, immunizing the parser against key-reordering and whitespace canonicalization vulnerabilities. Artifacts encompass `ai-executor`, `ai-host-helper`, `ai-rootfs`, and `ai-profiles`. Rollouts for `agent` and `updater` components via signed fleet manifests are rejected in favor of deployment convergence.
2. **Host pinned public key:** For optional signed AI runtime updates, the Ed25519 public key is pinned offline on the host at `/etc/vps-updater/fleet-release.pub` (`0644 root:root`). Verification is purely offline: the updater never fetches signing keys over the network, failing closed if the key file is missing or invalid.
3. **Pull-only updater daemon & protocol 3 evidence:**
   - The host updater runs as an unprivileged system user (`vps-updater:vps-updater`) with strict systemd isolation (`NoNewPrivileges=true`, `ProtectSystem=strict`, `InaccessiblePaths=/etc/vps-manager-agent`, empty `CapabilityBoundingSet=`).
   - Outbound requests require a scoped bearer credential (`Authorization: Bearer vma_<credentialId>_<secret>`, scope `local-updater`) bound to the local host VPS record (`vps_local_host`). Other scopes or foreign VPS IDs fail closed (`403 Forbidden`).
   - All requests transmit `X-Updater-Protocol-Version: 3` and `User-Agent: vps-updater/3`. Legacy protocol 1 updaters are rejected (`updater_incompatible`), while protocol 2 is accepted for backwards compatibility.
   - **Claim evidence reporting & host activity privilege boundaries:** Protocol 3 claims report host platform, updater version, idle status, and AI health. Activity evidence remains available for signed AI runtime readiness, but does not block bundled deployment agent upgrades. Host directories retain their privilege boundaries: parent state directories use `root:<agentgroup>` mode `1770`, `docker-applications` directories use `0755` with metadata files mode `0664`, and privileged helpers execute in `root:root` mode `0755` directories. Host-pty and AI task admissions remain in privileged host processes without exposing the registry or host filesystem to the API container. Update serialization, journal ownership, integrity validation, and rollback remain mandatory even when workloads are active.
4. **Constrained root helper privilege boundary:**
   - The updater daemon downloads artifacts directly from the API origin over HTTPS (enforcing an explicit hostname allowlist, no redirects, and strict `maxArtifactBytes`), staging them under `/var/lib/vps-updater/staging/<jobId>`.
   - To apply changes, the unprivileged daemon writes an action file (`apply.<jobId>`) into `/var/lib/vps-updater/pending/`.
   - The privileged root helper (`vps-updater-apply.service`) is triggered via a systemd path unit (`vps-updater-apply.path`) watching `/var/lib/vps-updater/pending/`.
   - **Fixed argv and empty capabilities:** The helper runs as `root:root` with an empty `CapabilityBoundingSet=` and fixed argv (`/usr/local/lib/vps-manager-agent/vps-updater helper -config /etc/vps-updater/config.json`). The unprivileged daemon cannot pass commands, paths, or service units to the helper.
   - **Symlink protection:** `requireSecureDir` fail-closes the helper if `/var/lib/vps-updater/helper` or any intermediate state directory is replaced by an unprivileged symlink.
   - **Multi-component upgrade lifecycle:**
     - The updater binary is upgraded first, restarting `vps-updater.service` under the new build before agent or AI changes are applied.
     - The agent binary is validated via `<candidate> -version` and SHA-256 matching, backed up to `/var/lib/vps-updater/helper/backups/<jobId>/`, atomically swapped into `/usr/local/bin/vps-manager-agent`, and `vps-manager-agent.service` is restarted.
     - Installed AI worker components (`ai-executor`, `ai-host-helper`, `ai-rootfs`, `ai-profiles`) are updated in-place without enabling uninstalled services.
5. **Durable journaling and safe rollback:**
   - A root-owned journal (`/var/lib/vps-updater/helper/journal.json`, readable by `vps-updater` but writable only by root) tracks mutation phases (`intent`, `renamed`, `restarted`, `rolled_back`).
   - **Two-generation backup retention:** Backup directories retain the current and previous generation to allow durable rollback. Completed job backups are pruned under root ownership.
   - If the restarted agent fails or the heartbeat deadline expires (`awaitHeartbeatGrace`), the helper restores previous binaries from the backup, restarts services, and verifies previous build identity. An unverified state (`rollback_unverified`) halts subsequent jobs and preserves backups and journals for manual operator resolution (`vps-updater ack`).
6. **Host migration & deployment automation:**
   - **Deployment wrapper (`scripts/deploy.sh`):** Operators deploy via `bash scripts/deploy.sh` (builds and starts containers) or `bash scripts/deploy.sh --pull` (pulls latest images and starts containers without rebuild). Once the API container passes `/api/health`, the wrapper invokes `scripts/install/prepare-agent-updater.sh` using current privileges or `sudo -n` to ensure the local host updater daemon and root helper are installed and current. Missing local sudo privileges prints an actionable warning and exits 0 if the dashboard is healthy, preventing local updater issues from rolling back the dashboard.
   - **Missing-access migration (`needs_access`):** Remote managed hosts require saved authorized SSH credentials with root or passwordless sudo. If SSH credentials, host-key verification, or sudo permissions are missing or untrusted, `AgentConvergenceService` marks the host as `needs_access` without silently opting out. Background bootstrap SSH attempts are throttled to at most once per 60 seconds and trigger immediately when the operator uses the Update/Retry action. Operators migrate unprovisioned or legacy hosts by configuring valid SSH/sudo access and clicking Update/Retry; manual updater enrollment or release selection is eliminated.
   - **In-place protocol migration:** Protocol 1 updaters are upgraded in place via `install-updater.sh --upgrade --binary <path> --config /etc/vps-updater/config.json`, preserving existing configurations, credentials, state directories (`/var/lib/vps-updater`), and journals.
   - **Installer key forwarding:** `install-local-agent.sh` accepts `--fleet-release-pub-key <path>` and forwards it to `install-updater.sh` using the accepted `--pubkey-file` option across both upgrade and bootstrap invocations.
7. **Rollout and verification boundaries:**
   - **Integrated test suites:** 160 integrated tests pass across API and updater modules, including 4 overview tests; Linux race-detector suites (`go test -race`) pass across `internal/updater`, `internal/applications`, and `internal/buildidentity`.
   - **Binary artifact matrix:** All 8 binaries (`vps-agent`, `vps-updater`, `agent-build-id`, `ai-host-helper` across Linux amd64 and arm64) build deterministically with embedded content identity; arm64 cross-build ELF headers and scoped protocol 3 download authorization are verified, while native arm64 restart is not verified.
   - **Host PTY and activity smoke:** Real host-pty lock and group membership smoke tests pass; privileged helpers execute under `root:root` mode `0755` while host state uses `root:<agentgroup>` mode `1770` and `docker-applications` uses `0755` with `0664` metadata files.
   - **Operator visual observation:** Desktop deployment overview and mobile Settings tabs verified visually with live status badges and Update/Retry automation states.
   - **Systemd runtime execution boundary:** Core convergence, daemon, and helper state machines are tested via automated suites. Full multi-host live end-to-end scenarios—including the deployment wrapper with saved-SSH bootstrap, unchanged-PID / no-job behavior on README/web-only deploys, and offline multi-target sequence handling—were not verified in this run (waived due to Windows environment).
   - **Fleet convergence boundary:** Automatic convergence covers all installed managed agents. One host updates at a time (`pg_advisory_xact_lock` / file lock CAS gate). Active shell/PTY sessions, AI tasks, and Docker/Compose mutations do not delay bundled updates; offline hosts wait for connectivity without failing deployment.
## Remote SSH Agent Management and Systemd Lifecycle

Remote agent installations on systemd-capable Linux nodes operate as managed system-level systemd services rather than unmanaged background loops, establishing consistent lifecycle supervision across both local and remote infrastructure.

### Systemd service architecture

1. **Deterministic service naming:** Remote agents are managed under unit name `/etc/systemd/system/vps-agent-${sha256(vpsId).toLowerCase()}.service`. In contrast, local host agent installations retain the canonical `vps-manager-agent.service` unit to preserve local updater daemon (`vps-updater`) supervision and atomic swaps.
2. **Execution identity:** The service unit runs with target login privileges (`User=<user>`, `Group=<group>`), rooted at `WorkingDirectory=<homeDir>`, with `Restart=always`, `RestartSec=10`, `TimeoutStopSec=15`, and `KillMode=control-group` ensuring bounded shutdown and descendant process cleanup. `KillMode=control-group` is process lifecycle cleanup, not a security sandbox or container boundary.
3. **Privilege requirement:** Service configuration, unit installation, and lifecycle operations require `sudo` permissions; unmanaged background `nohup` execution is superseded. Docker state flags (`-state`, `-docker-identity-path`, `-docker-runtime-keys-path`, `-docker-runtime-owner-uid`) are strictly preserved alongside `-config`.
4. **Legacy migration:** Legacy PID tracking (`~/.vps-manager-agent/vps-agent.pid`) with exact executable, working directory, and argv inspection is retained solely to support safe migration from prior nohup loops to systemd. When the deterministic per-VPS unit is active, its `MainPID` is authoritative and the pidfile is ignored (recovering from supervisor restarts that leave it stale); foreign, missing, or invalid `MainPID` fails closed as `mismatch`, and multiple exact matches still report `ambiguous`. Unknown processes or PID mismatches are never terminated.

### Per-VPS singleton process lock

To prevent duplicate concurrent instances from contending on metrics ingest or creating conflicting Docker collectors:
1. **Namespace:** Locked via `/run/vps-manager-agent/vps-agent-${sha256(vpsId).toLowerCase()}.lock`.
2. **Ownership and security:** The directory `/run/vps-manager-agent` is root-owned mode `0755` (`perm & 0022 == 0`). The lock file is a root-owned regular file with mode `0666`. Opened with `O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK`. On Linux, there is no fallback directory and no environment override.
3. **Kernel flock semantics:** The lock is acquired via non-blocking exclusive flock (`syscall.Flock(fd, LOCK_EX|LOCK_NB)`). The inode is held open for process lifetime. On crash or termination, the kernel automatically releases the lock; the lock file is never unlinked or truncated so contending processes always share the same inode.
4. **Provisioning (No RuntimeDirectory):** Provisioned via `/etc/tmpfiles.d/vps-manager-agent.conf` and `systemd-tmpfiles --create`. Systemd's `RuntimeDirectory=` directive is strictly prohibited in agent units because systemd would automatically chown `/run/vps-manager-agent` to the unprivileged service `User=`, breaking the trusted root-ownership invariant (`0755` root:root). Local installers also provision this tmpfiles configuration so `/run/vps-manager-agent` and the regular lock file persist across reboots.
5. **Offline preflight (`-validate-config`):** Because `-once` mode contends for the singleton lock and will fail if the daemon is active, staged upgrade preflights use `<binary> -config <path> -validate-config` for offline validation of configuration syntax and required fields without lock contention, network calls, or state mutation.
6. **Operational limits:** Production verification of systemd service management and singleton process locking has been confirmed on single host Azure VPS `vps_kUq9jDFzAtxY` running managed unit `vps-agent-e3d0757876c6e2baf8d0044daa30b1218070930aa38f83de4112794e7eceeb5a.service` (build `867941df81e769e07db86edcf9e4314101889735`), with verified lock contention rejection, stable lock inode retention across restarts, and offline `-validate-config`. Fleet-wide rollout across remaining remote nodes remains unverified pending individual staged upgrades.

## AI Assistant Operational Safety, Retention, and Lifecycle Supervision

### Retention and State Fencing

1. **Dual-rate retention scheduler:** `AiRetentionService` runs on application bootstrap and on a periodic schedule with a 5-second session/lease reconciliation loop and a 300-second 30-day retention pruning pass. It executes maintenance covering terminal tasks and execution blobs without blocking HTTP request paths.
2. **Terminal task retention:** Tasks in terminal states (`succeeded`, `failed`, `cancelled`, `expired`) older than the 30-day retention cutoff are pruned. Active tasks (`planning`, `awaiting_input`, `awaiting_approval`, `executing`, `verifying`, `cancel_requested`) and `uncertain` tasks are strictly preserved and never TTL-deleted.
3. **Receipt and fence preservation:** Any task referencing active outbox commands (`pending` or `dispatched`) or `uncertain` execution receipts is protected from retention deletion. Terminal task pruning purges only resolved receipts and acknowledged outbox entries, keeping all fences intact.
4. **Needed execution blob protection:** Encrypted execution blobs (`AiExecutionBlob`) are deleted on expiration only if not needed by an active or uncertain task, active outbox commands, or uncertain receipts. Needed blobs remain durable until their associated work settles.
5. **Audit preservation on chat deletion:** Deleting a chat conversation (`deleteConversation`) deletes conversation metadata and messages but preserves all historical audit events (`state.auditEvents`) and records an immutable deletion audit event. Audit records are maintained under the 90-day retention baseline.

### Startup Recovery and Session Revocation

1. **Active task reconciliation:** At startup and during periodic maintenance, active tasks across all VPS instances are evaluated.
2. **Awaiting task expiration:** Tasks remaining in `awaiting_approval`, `awaiting_input`, or `planning` past their `expiresAt` deadline are transitioned to `expired` with wire code `approval_expired`.
3. **Owner lease expiration:** Tasks in `executing` or `verifying` whose runtime owner lease expires without fresh heartbeat/receipt are transitioned to `uncertain` with wire code `uncertain_outcome`, preventing duplicate execution while maintaining the active-slot fence.
4. **Session logout and revocation:** If the initiating dashboard session or the approving session is revoked, logged out, or expired in `DashboardSessionService`:
   - Pending tasks (`planning`, `awaiting_approval`, `awaiting_input`) are expired immediately (`session_revoked`).
   - Executing or verifying tasks are transitioned to `cancel_requested` so the agent terminates execution on the next heartbeat, rather than running detached after logout.

### Redaction and Bounded Output

1. **Shared secret redaction:** All outgoing responses and provider communications pass through `packages/api/src/common/redaction.ts`. Redaction matches private key PEM blocks, SSH keys, passwords, bearer tokens, scoped `vma_` tokens, `sk-` provider keys, generic secret assignments, and `.env` variable assignments.
2. **ANSI escape stripping:** Terminal and subprocess output undergoes ANSI sequence stripping before pattern matching to prevent escape code fragmentation from evading secret redaction.
3. **Chunk boundary streaming redactor:** `ChunkRedactor` buffers stream chunks across packet boundaries to detect and redact split tokens or headers that cross chunk splits.
4. **Operational limits:** Production deployment of AI assistant host execution and multi-node confinement has NOT been verified. Passing local unit tests and simulated adapter runs does not guarantee provider reliability, billing boundaries, or safe confinement on production Linux hosts.

## AI Host Confinement Architecture (P3/P4)

### Process topology

1. **`vps-agent` (unprivileged, dedicated service user):** hosts the AI transport worker. It claims commands, streams bounded output, writes durable receipts, and never executes host-mutating work itself.
2. **`ai-host-helper` (root, systemd unit `flexserver-ai-helper.service`):** a small Unix-domain-socket daemon that owns every privileged operation. Connection authorization uses `SO_PEERCRED`; the helper accepts only root, its own effective UID, explicitly configured `--socket-uid`/`--socket-gid`, and the pinned execution identity. Request payloads are a single bounded JSON line.
3. **`ai-executor` (root bootstrap, drops privileges):** launched only by the helper, only from the pinned `--executor-binary` path. It enters fresh mount/PID/IPC/UTS namespaces, attaches to the task's pre-created cgroup v2 scope, sets `no_new_privs`, drops supplementary groups and capabilities, applies `PR_SET_NO_NEW_PRIVS`/`PR_CAPBSET_DROP`, `setgroups`/`setresgid`/`setresuid` to the pinned UID/GID, and only then execs the requested script inside the read-only rootfs. There is no setuid binary exposed to AI tooling and no root shell path.

### Privileged operation routing

| Operation | Owner | Validation |
| --- | --- | --- |
| `service_status` / `service_action` | helper | Profile membership, action allowlist (`status`, `start`, `restart`, `reload`); `stop`/`disable`/`mask` are refused by policy before `systemctl` runs |
| `config_validate` / `config_apply` | helper | Profile config-path allowlist (wildcards expanded inside the registered root), protected-path denial, pre/post-image SHA-256 CAS, root-owned backup, atomic rename + directory fsync |
| `cgroup_create` / `cgroup_kill` | helper | cgroup v2 unified hierarchy required; group-v2 scope per task with `cpu`/`memory`/`pids` controllers |
| `task_execute` | helper → executor | Pinned execution UID/GID, pinned rootfs, namespace template, cgroup attachment before exec |

The unprivileged worker reaches these only through `packages/agent/internal/ai/helper_client.go`, which validates every response shape and refuses to interpret an error response as success.

### Failure semantics

- Missing cgroup v2 → `cgroup_create` and `task_execute` fail closed; shell/file mutation stays unavailable, and no unconfined fallback exists.
- Digest drift at apply time → rejected before any disk mutation, with the observed digest in the error.
- Unauthorized peer credentials → connection refused before request parsing.
- Helper socket absent → worker reports `ai host helper socket unavailable` rather than attempting privileged work locally.
