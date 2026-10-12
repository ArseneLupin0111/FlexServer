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
