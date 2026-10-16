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

## Docker Management

Docker monitoring remains read-only and can be enabled independently from `dockerManagementEnabled`, which defaults to `false`. Read-only container logs are available by default for non-system VPS records and the system-managed local host in local mode, independently of that flag and without a new toggle. `dockerManagementEnabled` continues to protect dashboard mutations, which are limited to confirmed `start`, `stop`, and `restart` actions scoped to a VPS, agent instance, and opaque container key. The API stores bounded operation state in the configured JSON or PostgreSQL repository and never opens the Docker socket.

The agent owns Docker socket access. Its independent command worker claims authenticated operations, records bounded receipts, enforces deadlines and target identity, and reports uncertain outcomes without replaying a mutation. Container logs are requested on demand and stream over a dedicated SSE viewer; they are held only in memory and are not written to jobs, audit, or persistent storage.

Deploy an agent containing the command worker before enabling Docker management for a VPS. Management capability and target discovery remain available when Docker monitoring is disabled; targets are exposed when management is enabled or read-only logs are supported. Monitoring data itself is still controlled by `dockerMetricsEnabled`.

### Realtime container logs

Container logs are an approved exception to the Phase 1 no-ingestion invariant only: they are on demand, ephemeral, and never persist. A viewer opens `GET /api/vps/:id/docker/management/logs/stream?agentInstanceId=<id>&containerKey=<key>`, which creates one in-RAM `DockerLogsService` subscription that the opening connection is the only viewer of, bounded at 4 concurrent streams per VPS and 32 per API instance. The agent claims the waiting subscription with `POST /api/agent/logs/claim`, opens exactly one Docker `GET /containers/{id}/logs?stdout=1&stderr=1&tail=200&timestamps=1&follow=1` request, and uploads bounded batches with `POST /api/agent/logs/:subscriptionId/chunks` before reporting the terminal outcome with `POST /api/agent/logs/:subscriptionId/result`. There is no snapshot-then-follow pair and no reconnect to the same subscription, so the fixed 200-line tail is read once and the connection never replays it.

Log content never reaches persistence, monitoring, or audit. Lines are streamed to the browser on a dedicated SSE endpoint (`docker.logs.state`, `docker.logs.lines`, `docker.logs.closed`) that shares no transport, buffer, or event with `monitoring.snapshot`/`metrics.updated`, and nothing is written to `data/`, PostgreSQL, audit, jobs, or Docker monitoring repositories. Reconnect is deliberately a new viewer: the browser buffer is dropped, a new subscription is opened, and Docker re-serves the latest 200 lines, so a network gap can lose the lines in flight rather than silently duplicating or backfilling them. The viewer retains at most 2,000 lines or 1 MiB of text and discards the oldest with a visible notice; the agent caps one line at 4 KiB UTF-8 and one batch at 100 lines or a 32 KiB serialized body.

Docker log streaming uses `logsSupported`, not the management action capability or `dockerManagementEnabled`, for opening and revalidating subscriptions. In local mode, logs are supported for non-system VPS records and system-managed records with `kind: local`; other system records remain excluded. Demo mode reports unsupported with an explicit reason rather than faking a source. Local and added VPS agents use the same authenticated claim/chunks/result protocol; the in-process local metrics collector cannot supply Docker logs. Dashboard session and origin checks, authenticated agent credentials bound to the VPS, and current inventory membership for the exact `agentInstanceId`/`containerKey` pair remain required. Disabling management does not disable an otherwise permitted read-only stream or authorize any action. System-managed local hosts remain blocked from destructive management actions. Agent-side log reading is Linux-only through the Docker Unix socket `/var/run/docker.sock`; other platforms report an explicit unsupported transport instead of dialing any TCP daemon endpoint. A subscription that never reaches a live source closes with `agent_unavailable` after 30 seconds, a silent source closes with `stream_lost` after 10 seconds, session loss closes with `session_expired`, and the hard lifetime cap is 2 hours. Rollout requires the new API and a new Linux agent together: an old agent cannot claim, so the viewer shows a bounded failure instead of fabricated lines.

Docker monitoring accepts only schema v2 snapshots with durable agent identity and source sequence. Deploy the API migration and provisioned v2 agent before relying on Docker history or dashboard snapshots; old v1 rows are not projected or backfilled. Verify a fresh `docker_metric_samples` row with a non-legacy `agent_instance_id`, advancing `docker_ingest_latest.source_sequence`, and a committed `docker_event_watermarks` row. Host metrics and API health alone do not prove Docker v2 ingestion.

Docker ingest digest v2 excludes server receipt timestamps from mapped container samples and events, and binds the event protocol and availability/version metadata. Identical retransmissions return the original committed acknowledgment without advancing history twice. Legacy digest-v1 commits are authenticated by recomputing the original projection at the stored receipt time and checking ledger identity, sequence, and proposed watermark. Legacy v1 did not bind every metadata field; compatibility does not retroactively strengthen that historical contract. Older JSON ledgers without a stored acknowledgment watermark require matching current watermark evidence; missing or advanced evidence fails closed. Do not clear pending agent state to work around replay conflicts.

## Local Agent Upgrades (Bundled Binary Architecture)

Local systemd agent updates use the bundled binary packaged inside the deployed API container (`/app/agent/vps-agent-linux-amd64`), eliminating external signed release catalogs and manual key distributions. Deploying an API image updates the available target binary; host binary upgrades are performed pull-only by a separately installed updater daemon with operator confirmation in the dashboard. Remote SSH agent upgrades use a push-driven orchestration pipeline managing dedicated systemd services on remote Linux hosts.

### Component boundaries and trust model

1. **Bundled API artifact:** The API image packages verified Linux agent and updater binaries. At startup, `BundledAgentService` parses the binary ELF64 header, verifying little-endian Linux format, target architecture (`amd64` or `arm64`), file size, SHA-256 digest, and embedded 40-hex commit build ID. The binary is served over HTTPS from `GET /api/local-updater/jobs/:jobId/artifact` (and `/bundled/artifact`).
2. **Pull-only updater daemon:** The host updater runs as an unprivileged system user (`vps-updater`) and polls `GET /api/local-updater/jobs` over outbound HTTPS. It requires a scoped bearer credential (`Authorization: Bearer vma_<credentialId>_<secret>`, scope `local-updater`) bound to the local host VPS record (`vps_local_host`). Other scopes or foreign VPS IDs fail closed (`403 Forbidden`).
3. **Protocol v2 requirement:** The updater daemon must send `X-Updater-Protocol-Version: 2` on all requests. Legacy protocol version 1 updaters are rejected (`updater_incompatible`), enforcing migration before upgrades.
4. **Constrained root helper:** The updater daemon downloads the artifact directly from the API origin (no redirects), enforcing strict `maxArtifactBytes` (default 128 MiB) and SHA-256 digest matching against `targetSha256`. The privileged root helper (`vps-updater-apply`, triggered via a systemd path unit) re-validates the target SHA-256, verifies `<binary> -version`, takes a backup to `/var/lib/vps-updater/helper/backups/`, atomically replaces `/usr/local/bin/vps-manager-agent`, and restarts `vps-manager-agent.service`.
5. **Fresh heartbeat confirmation:** An upgrade job enters `awaiting_heartbeat` and is ruled `succeeded` ONLY after a fresh heartbeat bearing the target commit build ID is ingested by the API before the deadline (`awaitHeartbeatGrace`). Active systemd status or disk hash changes alone are never treated as success.
6. **Safe rollback:** If the restarted agent fails to start or the heartbeat deadline expires, the root helper restores the previous binary from the backup, restarts the service, and verifies the previous build ID via a fresh heartbeat. An unverified state (`rollback_unverified`) halts further jobs and preserves backups and journals for manual operator resolution (`vps-updater ack`).
7. **Host migration:** Existing protocol 1 updaters are upgraded in place via `install-updater.sh --upgrade --binary <path> --config /etc/vps-updater/config.json`, preserving existing configurations, scoped credentials, state directories (`/var/lib/vps-updater`), and journals. Deployment automates this extraction and upgrade on deploy.
8. **No host access from API container:** The API container has no root filesystem mounts, no Docker socket, and no systemd socket access. All mutations remain host-owned and pull-driven. Local testing was performed using simulated updater and heartbeat processes; production rollout requires verification on a real Linux staging host.

## Remote SSH Agent Management and Upgrades

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
