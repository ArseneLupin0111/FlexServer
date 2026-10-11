# Docker Monitoring Phase 1 Implementation Plan

## 1. Goal, Non-goals, Invariants, and Assumptions

### Goal

Extend the existing opt-in Docker snapshot feature into a bounded, read-only monitoring slice with:

- a useful per-server Docker detail view;
- historical host-level and selected per-container metrics;
- a bounded timeline of operational Docker events;
- server-side alert evaluation and lifecycle management; and
- a Docker Engine storage overview based on Docker system/disk-usage semantics.

The result must work with both repository modes selected by `STORAGE_DRIVER` (`json` and `postgres`), must not require TimescaleDB, and must remain compatible with agents that only send the current Docker schema version 1 payload.

### Non-goals

Phase 1 does **not** add:

- container start, stop, restart, pause, remove, exec, or any other Docker mutation;
- Docker Compose discovery or control;
- arbitrary Docker API proxying;
- host-wide filesystem inventory or arbitrary path collection;
- Prometheus, Redis, a separate event broker, or a mandatory TimescaleDB dependency;
- notification delivery to email, chat, or paging systems; or
- user-authored arbitrary expressions. Initial alert rules are a typed allowlist.

**Approved later exception — on-demand realtime container logs.** Retrieving or streaming container logs is no longer a Phase 1 non-goal, but the exception is deliberately narrow and does not relax any monitoring invariant: logs are read only while a viewer is connected, are never collected, persisted, replayed, or monitored in the background, and never enter any Phase 1 monitoring repository, dashboard overview, or SSE event. Permitted reads are limited to `GET /containers/{id}/json` (to learn `Config.Tty`) and one continuous `GET /containers/{id}/logs?stdout=1&stderr=1&tail=200&timestamps=1&follow=1` per open viewer, both still behind the hardcoded allowlist and the resolved 64-character lowercase-hex daemon ID. Background log collection, indexing, previews, search, download, log-driven alerts, and log content in audit/jobs/metrics remain non-goals.

### Monitoring-only and privacy invariants

These are release-blocking invariants, not implementation preferences:

1. Only the Go agent may open `/var/run/docker.sock`. The NestJS API and React web process never receive, mount, proxy, or dial the Docker socket.
2. Agent Docker access remains an explicit GET allowlist. Phase 1 may add only read endpoints needed for bounded monitoring: `/version`, `/containers/json?all=1&size=false`, `/containers/{id}/stats?stream=false`, `/events` with bounded filters/time, and `/system/df`. Under the approved realtime-logs exception the allowlist additionally contains exactly `/containers/{id}/json` and `/containers/{id}/logs`, both permitted only behind an open viewer subscription for an authenticated, identity-bound target on a non-system VPS in local mode. Read-only logs do not require `dockerManagementEnabled`; that flag defaults to `false` and still protects actions. No generic request helper may accept a path from API or UI input.
3. Never collect or persist environment variables, arbitrary labels, mount source/destination paths, mount content, commands/entrypoints/arguments, secrets, Docker configs, Docker secrets, or inspect payloads. On-demand realtime log reads are the only approved content exception: they are viewer-triggered and ephemeral, and log lines are never written to any repository, file, audit record, metric, dashboard snapshot, or monitoring SSE payload. Monitoring-phase safeguards on raw request payloads, IDs before derivation, image/name combinations at warning/error level, and cursors containing raw IDs remain unchanged; log stream errors surface only the published safe error codes, never daemon or log bodies.
4. Container fields remain a narrow allowlist: opaque public ID, bounded display name, bounded image reference, state, bounded status, creation time, health classification when derivable from allowed state/status/event fields, and numeric resource counters.
5. Storage overview means the sanitized aggregate semantics of Docker Engine `GET /system/df`: totals and reclaimable/active sizes for images, containers, local volumes, and build cache. Do not send object names, volume names, mount points, layer IDs, cache records, or per-object details.
6. Operational Docker events are stored in a dedicated bounded event repository/table. They are not `AuditEvent`s and must not be written to `data/audit.json` or the PostgreSQL audit table. User actions such as acknowledging an alert may produce a low-volume audit record; daemon events may not.
7. Every collection and response is capped. No endpoint, JSON file, database query, dashboard snapshot, or SSE event may grow with unbounded container count or history.
8. The authoritative engine totals remain separate from retained details. `containerTotal` and `containerRunning` are totals over `/containers/json`; `containers` remains a capped subset. UI and API copy must not represent the retained subset as the complete inventory.
9. Disabling `dockerMetricsEnabled` stops collection, ignores stale Docker branches at ingest as `AgentService.ingestMetric` does today, deletes latest/history/event/storage monitoring data according to the product decision in [Open decisions](#9-open-decisions-requiring-productengineering-agreement), and resolves or suppresses Docker alerts without fabricating healthy data.

### Assumptions

- Existing dashboard sessions authorize the dashboard as a whole; there is no per-VPS RBAC. Route VPS filtering prevents accidental cross-VPS response mixing but is not an authorization boundary between VPSs. `DashboardSessionGuard` protects dashboard access and `OriginGuard` provides origin/CSRF enforcement where applied.
- Agent authentication remains the bearer credential flow in `AgentController.ingestMetrics` and `AgentService.verifyBearerToken`.
- The agent loop interval is configured by `Config.IntervalSeconds`; Phase 1 does not promise a sample exactly every five seconds.
- The existing Docker collector has one global five-second deadline (`DefaultDockerTimeoutSeconds`) and fetches retained container stats sequentially in `collectDockerFromAPI`. Phase 1 must degrade detail coverage when the budget is exhausted; it must not claim that all 20 containers can always be sampled at the agent interval.
- PostgreSQL migrations already through `012_vps_location.sql` may have been applied. Migration `009_docker_metrics.sql` is immutable. All Phase 1 database changes use new migrations beginning with the next available number at implementation time (expected `013_*`).

### Closed pre-I0 design decisions

The following are resolved architecture decisions and are not deferred to product discovery:

1. **Installation identity:** each agent has a versioned, root-owned `0600` state file containing a 256-bit random installation key. It is never token-derived. First publication uses a temporary file created with `O_CREATE|O_EXCL`, writes/version-validates, `fsync`s the file, links/renames with **no-replace** semantics to the final path, then `fsync`s the parent directory; if another process won, discard the temporary file and validate/read the winner. Ordinary state updates use same-directory atomic replace while preserving owner/mode. `agentInstanceId = base64url(HMAC-SHA-256(installationKey, "vps-manager/docker/agent-instance/v1"))[0:32]`; `containerKey = base64url(HMAC-SHA-256(installationKey, "vps-manager/docker/container/v1\0" || fullDockerContainerId))[0:32]`. Domain separators and output lengths are fixed contract constants.
2. **Identity recovery:** missing state on first install creates the file with create-exclusive semantics, `fsync`, atomic rename, parent-directory `fsync`, and verified owner/mode. A malformed, short, wrong-version, wrong-owner, or over-permissive file fails Docker v2 collection closed; it is never silently replaced. An explicit reinstall/reset creates a new key and therefore a new `agentInstanceId`; the server records an identity transition and orphans prior instance-scoped container alerts/history rather than joining by name.
3. **Event protocol:** Docker `/events` has no cursor. The agent uses bounded fixed `[since, until]` queries, streaming `json.Decoder`, inclusive-boundary replay, and durable event watermarks/digests as specified below. “Cursor” in this document refers only to REST pagination.
4. **Ingest atomicity:** a v2 payload is one `DockerV2IngestUnit`. PostgreSQL commits latest, samples, events, storage, alert transitions, and event watermark in one `PoolClient` transaction. JSON commits one atomic mutation of `data/docker-monitoring.json`, which is the v2 source of truth; `data/agents.json` latest Docker state is an at-least-once compatibility projection reconciled at startup.
5. **Sample dedupe:** every collected Docker snapshot has an agent-generated `snapshotId` persisted in agent state before push and reused across all push retries. Host, container, and storage writes have explicit unique keys and deterministic conflict behavior.
6. **Alert evidence:** unknown, stale, partial coverage, event gaps, and identity changes never count as healthy/clear evidence. Container absence alone never resolves an alert because Phase 1 does not collect authoritative full membership details. Exact evidence rules are closed in Section 5.
7. **PostgreSQL storage:** all Phase 1 Docker tables remain ordinary PostgreSQL tables. There is no Phase 1 promise to convert them to hypertables. Optional Timescale support applies only to the repository's existing `metric_samples` path.

## 2. Current-state Architecture and Constraints

### Runtime path

```text
Docker Engine Unix socket
  -> packages/agent/internal/metrics/docker_collector_linux.go: Collector.collectDocker
  -> packages/agent/internal/metrics/docker_api.go: collectDockerFromAPI
  -> packages/agent/internal/metrics/collector.go: SystemMetrics.Docker
  -> packages/agent/internal/push/client.go: Client.Push
  -> POST /api/agent/metrics
  -> packages/api/src/agents/agent.controller.ts: AgentController.ingestMetrics
  -> packages/api/src/agents/agent.service.ts: AgentService.ingestMetric
  -> AgentRepository.upsertDockerMetrics
  -> DashboardService.overview / MonitoringService
  -> monitoring.snapshot and metrics.updated SSE
  -> packages/web/src/context/DashboardContext.tsx
  -> DockerMetricsPanel
```

### Existing contracts that Phase 1 must preserve

| Area | Current path/symbol | Constraint |
| --- | --- | --- |
| Agent model | `packages/agent/internal/metrics/docker.go`: `DockerMetrics`, `DockerContainerMetric` | Schema version is `DockerSchemaVersion = 1`; details are capped by `MaxContainers = 20`; IDs are truncated to `MaxIDLen = 16`. |
| Agent collector | `packages/agent/internal/metrics/docker_api.go`: `collectDockerFromAPI` | `/version` is best effort with `DockerVersionBudget = 250ms`; list totals are computed before the 20-item cap; stats calls are sequential under the global deadline. |
| Socket ownership | `packages/agent/internal/metrics/docker_collector_linux.go`: `Collector.collectDocker` | Only the agent dials `/var/run/docker.sock`; the whole Docker collection has a five-second timeout. |
| Runtime opt-in | `packages/agent/internal/metrics/docker_collector.go`: `SetDockerMetricsEnabled` | Off by default and learned from a successful ingest response. |
| Downgrade behavior | `packages/agent/internal/push/client.go`: `Client.Push`, `handleConfigResponse` | A 400 with a Docker branch retries once without Docker and disables Docker collection; old/malformed config responses fail closed. |
| API validation | `packages/api/src/agents/agent.schemas.ts`: `agentDockerMetricsInputSchema` | Strict schema, 20-container maximum, safe-number bounds, and Docker source timestamp limited to -10 minutes/+2 minutes. |
| API ingestion | `packages/api/src/agents/agent.service.ts`: `AgentService.ingestMetric` | Docker is ignored while disabled; `receivedAt` is API time; persisted Docker schema is currently forced to 1. |
| Latest persistence | `packages/api/db/migrations/009_docker_metrics.sql` | `agent_docker_metrics` is one latest row per VPS, not history. Do not edit this migration. |
| JSON persistence | `packages/api/src/persistence/repositories/agent.repository.ts`: `AgentFile.dockerMetrics` | Latest-only map in `data/agents.json`; older `collectedAt` snapshots do not overwrite newer ones. |
| PostgreSQL persistence | `packages/api/src/persistence/repositories/agent.postgres.repository.ts` | Latest upsert uses `WHERE agent_docker_metrics.collected_at <= EXCLUDED.collected_at`; details and engine metadata are in bounded `data` JSONB. |
| Repository selection | `packages/api/src/persistence/repositories/create-repositories.ts`: `createRepositories` | JSON and PostgreSQL implementations must be wired together and remain behaviorally equivalent. |
| Current SSE | `packages/api/src/monitoring/monitoring.service.ts`: `MonitoringService.stream`, `streamForVps` | Local streams poll every 5 seconds, compare serialized latest Docker arrays, and resend complete latest Docker snapshots through `metrics.updated`; no replay cursor exists. |
| Browser SSE | `packages/web/src/lib/live-api.ts`: `MonitoringEnvelope`, `subscribeMonitoring` | Envelope schema is 1; EventSource reconnect is used, but there is no `Last-Event-ID` replay contract. |
| Existing UI | `packages/web/src/components/dashboard/servers/DockerMetricsPanel.tsx` | Compact/detail presentation, filters only the retained maximum 20 rows, explicitly explains retained versus total, and links to `/vps/:vpsId/docker`. |
| Detail routing | `packages/web/src/context/VpsWorkspaceContext.tsx` and application routes tested in `packages/web/src/App.test.tsx` | The dedicated Docker route already renders the detail presentation; Phase 1 should evolve it rather than create a competing route. |

### Consequences

- `agent_docker_metrics` remains the cheap latest-state source. History must be append-only in a new repository/table and must not change current dashboard behavior during initial rollout.
- A single `AgentRepository` is already broad. New high-volume history/event responsibilities should use a dedicated `DockerMonitoringRepository` rather than expanding `AgentFile` and `AgentRepository` indefinitely.
- The current global SSE snapshot can grow with server count because it carries complete Docker arrays. History and event pages must never enter `DashboardOverview` or `monitoring.snapshot`.
- JSON mode is local/single-process and uses atomic file replacement. Its Phase 1 retention limits must cap file size on every append; it is not an excuse for an unbounded event log.
- TimescaleDB is optional per `docs/postgres-timescale-storage.md`; core SQL, retention, and queries must run on plain PostgreSQL.

## 3. Target Architecture, Data Flow, and Design Decisions

### Target flow

```text
Agent collection cycle
  host metrics
  Docker snapshot v1 or v2 (best effort, global 5s Docker budget)
    sampledContainerAggregate + authoritative counts + <=20 selected container samples
    <=100 Docker events from a fixed inclusive [since, until] window
    one aggregate Docker /system/df storage summary on slower cadence
  -> existing authenticated POST /api/agent/metrics
  -> strict version-discriminated validation and sanitization
  -> one DockerV2IngestUnit:
       update latest agent_docker_metrics
       append bounded host/container history
       insert idempotent operational events
       update latest storage overview
       evaluate server-side alerts from accepted data
  -> structured push result returns capability/config, ingest status, and committed event watermark

Dashboard reads
  latest state: existing dashboard/SSE path
  history/events/alerts: bounded, VPS-scoped paginated REST
  live invalidation: small VPS-scoped SSE notifications, then REST refetch
```

### Stable installation and container identity

- The installation-key construction in the closed decisions is mandatory. The root-owned versioned state file also stores the last committed event watermark, bounded boundary digests, pending `snapshotId`/event batch metadata, and monotonic local sequence needed for crash recovery; secret key material is never transmitted.
- `agentInstanceId` is explicitly required in every schema-v2 Docker payload, event batch, sample, storage observation, and acknowledgement. The API trusts it only as an authenticated claim bound to the credential's `vpsId`; it is not an authorization credential. The first accepted v2 payload establishes the current instance. A different instance for the same VPS is accepted only as a recorded transition when no unresolved concurrent batch exists; interleaved payloads from old and new instances are a 409 identity conflict until the transition is settled. Old-instance retries remain idempotently readable but cannot advance the new instance watermark or overwrite latest.
- `containerKey` is stable only within one `agentInstanceId`, opaque across installations/VPSs, adequate for history joins, and does not expose a raw Docker ID. API identity is `(vpsId, agentInstanceId, containerKey)`; the browser receives the two opaque IDs only where needed.
- Keep current 16-character `id` in v1 responses for compatibility. Schema v2 adds `containerKey`; the API never attempts to join long-term history by mutable name or image. A v1-only agent can provide host history but not reliable per-container history/events; the API reports capability flags rather than inventing identity.
- Reset/reinstall marks the previous instance retired. Its history remains separately queryable until retention; active per-container alerts become `resolved` with administrative reason `identity_reset_orphaned`, never `condition_cleared`. Full actor IDs from the daemon are used transiently inside the agent only and are never transmitted.

### Collection cadence and budgets

| Signal | Proposed cadence | Bound/budget | Notes |
| --- | --- | --- | --- |
| Authoritative counts, sampled container aggregate, and selected container stats | Existing agent loop, but no faster than 15 seconds for Docker work | Existing global 5 seconds | Only `containerTotal`/`containerRunning` from the full list are authoritative. `sampledContainerAggregate` sums only successfully sampled retained containers and always carries coverage/cohort metadata; no alert may evaluate from it when coverage is incomplete. |
| Container selection | Every Docker cycle | At most 20 stat calls/details | Deterministic rotation by `containerKey`, with running/unhealthy/state-changed containers first, prevents the first 20 list results from monopolizing history. Record `detailsSampled` and `detailsTotalEligible`. |
| Events | Fixed window each Docker cycle | At most 100 accepted events or 64 KiB encoded branch | Query `/events?since=S&until=U` with both endpoints fixed before opening the request. Decode the JSON stream incrementally; never wait on an open-ended event stream. |
| Storage overview | Every 5 minutes, and on first enabled cycle | One `/system/df` response, max 256 KiB read | Run only if enough of the five-second budget remains; otherwise defer. A storage miss must not fail metrics/events. |

Do not introduce parallel stats requests in Phase 1 unless measurements show sequential collection cannot meet the accepted detail target and an engineering decision sets a small concurrency limit. The implementation must first support partial samples and rotation honestly.

### Source and received timestamps

- `collectedAt`: agent wall-clock time at completion of that specific snapshot/storage collection.
- `eventOccurredAt`: Docker event source time (`timeNano` required for v2 event identity; seconds-only events are normalized to nanoseconds and marked reduced precision in typed context).
- `receivedAt`: API wall-clock time when the authenticated payload is accepted.
- `effectiveAt`: server-selected query time. Use source time only when it is parseable and within the existing acceptance window; otherwise reject the branch or use `receivedAt` only where the contract explicitly allows it. Never silently rewrite source time.
- Ordering/latest decisions use `(collectedAt, receivedAt)` for samples and `(eventOccurredAt, receivedAt, eventId)` for events. Freshness uses `receivedAt`, as current Docker UI behavior already prefers it.
- History responses return both source and received timestamps so clock skew and delivery delay are visible.

### Event window, replay, and crash-safe acknowledgement protocol

Docker `/events` supplies timestamps, not a durable cursor. Phase 1 uses this protocol:

1. Agent durable state holds `eventWatermark = { timeNano, boundaryDigests[] }` for the last committed boundary. `boundaryDigests` is a sorted, deduplicated maximum of 256 SHA-256 digests of accepted safe event identities exactly at `timeNano`; exceeding 256 is an explicit boundary overflow gap.
2. Before collection, set `S = eventWatermark.timeNano` (inclusive replay). Freeze `agentNow = time.Now().UTC()` once, require it within the API's accepted clock-skew envelope, and set `U = UnixNano(agentNow - 1s)`. Encode `since`/`until` as base-10 Unix seconds with nanosecond fractions accepted by the Engine API; retain exact integer nanoseconds in payload/state. If `U <= S`, defer without changing state. Query `/events?since=S&until=U` with allowlisted `type=container` and action filters.
3. Decode/work caps are separate from transmit/storage caps. A streaming `json.Decoder` processes at most 10,000 decoded events or 2 MiB of source bytes per window, using an `io.LimitReader(max+1)` sentinel so byte oversize is detected rather than mistaken for clean EOF. Normal transmitted/stored output remains at most 100 safe events and 64 KiB encoded. A safe event digest is over `(agentInstanceId, eventTimeNano, action, containerKey, typedSafeContextVersion, typedSafeContext)`. Events at `S` whose digest is already in durable `boundaryDigests` are replay duplicates.
4. When the 100-event or 64-KiB transmit cap is first reached, stop adding events but continue decoding only through the complete current `timeNano` boundary, with a boundary-overrun allowance of 1,000 additional decoded events and 512 KiB source bytes. Use limit+1 checks for both event and byte allowances. If the boundary completes within overrun, transmit the first 100/64-KiB safe events, add one typed `stream_gap { reason: "boundary_overflow", skippedFromNano, skippedThroughNano, skippedCount? }` covering safe events omitted at that timestamp, and set `proposedWatermark` to that completed timestamp with the complete retained boundary digest set when it fits. The next window starts inclusively there and suppresses already accounted boundary digests.
5. If the boundary digest set exceeds 256, the global five-second Docker context expires during boundary completion, or the boundary-overrun count/byte limit+1 sentinel fires before timestamp changes, deliberately abandon the remainder of the fixed window through `U`: emit `stream_gap { reason: "boundary_overrun_abandoned"|"response_oversize"|"collection_deadline", skippedFromNano, skippedThroughNano: U, skippedCount? }`, set `proposedWatermark = { timeNano: U, boundaryDigests: [] }`, and mark the window lossy. This prevents replaying the same dense prefix forever. If caps occur between timestamp boundaries, advance to the last fully decoded boundary; every attempt therefore either advances, retries a changed remainder with new information, or durably records explicit loss through `U`.
6. The agent has exactly one durable pending batch. It writes `{ batchId, snapshotId, agentInstanceId, fromWatermark, proposedWatermark, eventsDigest }` durably **before** push. `batchId` and `snapshotId` are random opaque IDs reused unchanged for every retry. No later event window is collected while pending exists; there is no drop-oldest event buffer. A pending batch is removed only after a matching acknowledgement or an explicit operator/policy abandonment that first records a gap through its fixed `U`.
7. Request v2 fields are `batchId`, `snapshotId`, `agentInstanceId`, `fromWatermark`, `proposedWatermark`, `events`, `eventWindow: { since, until, capped, lossy, gapReason? }`. The API compares `fromWatermark` to its durable watermark for `(vpsId, agentInstanceId)` inside the ingest transaction. Equal permits CAS advance; an already committed `batchId` returns its prior result; behind/equivalent replay inserts nothing and returns current watermark; ahead/conflicting state returns 409 with no partial writes.
8. Structured success is `{ data: { ok, vpsId, receivedAt, config, docker: { ingestStatus: "committed"|"already_committed"|"replay_ignored", batchId, snapshotId, agentInstanceId, committedWatermark } } }`. The pusher must return this typed result rather than only `error`; `Runner` atomically commits the returned watermark and clears pending state only after validating matching VPS/instance/batch IDs. Lost responses therefore retry safely.
9. Docker daemon time moving backward, daemon identity/version reset evidence, state-file reset, or a requested `since` older than daemon availability produces a typed `stream_gap` event and freezes restart-loop resolution across the gap. A daemon restart without proven loss is a typed `daemon_restarted` observation, not automatically a gap.

Fault cases are explicit: crash before pending-state write produces no batch; crash after write/before request retries the single pending batch; API outage leaves the local event watermark unchanged and blocks later windows until acknowledgement or explicit lossy abandonment; API crash before transaction commit returns no acknowledgement and retry commits once; API crash after commit/before response returns `already_committed`; agent crash after response/before local commit retries and receives the committed watermark; CAS conflict never advances local state. Agent-to-API is at least once, API storage is idempotent, and API-to-browser SSE remains best-effort invalidation recovered by REST refetch.

### Caps and pagination

- Latest snapshot: at most 20 container details, as today; total counts remain authoritative.
- History API: require `vpsId`; default `limit=100`, maximum `500`; maximum query range 30 days; keyset cursor based on `(effectiveAt, id)`, never offset pagination.
- Container history: require both `agentInstanceId` and `containerKey`; default 100, maximum 500; maximum 30-day range.
- Events API: default 50, maximum 200; container filters require both `agentInstanceId` and `containerKey`; other filters are typed `action` and time range.
- Alerts API: default 50, maximum 200; filter by lifecycle state/rule kind and, for container scope, both instance and container key.
- SSE delta payload: maximum 32 KiB and no historical arrays. If a change set exceeds the cap, send `{ vpsId, reason: "refresh_required" }` only.
- Agent payload: continue server request-body limits already in force and add branch-level limits (20 container samples, 100 events, bounded strings, bounded storage aggregate).

### Retention and downsampling

Defaults must be configurable with validated upper bounds in `AppConfig`:

- raw host/container Docker samples: 7 days;
- hourly rollups: 30 days;
- operational Docker events: 14 days and an additional per-VPS hard cap (for example 10,000);
- resolved alerts: 30 days; open alerts are retained until resolved plus the resolved window;
- latest snapshot/storage rows: one per VPS until monitoring is disabled/deleted.

Plain PostgreSQL uses ordinary tables, indexes, SQL aggregation, and an application-owned bounded maintenance service. Phase 1 Docker tables will not be converted to Timescale hypertables; optional Timescale remains limited to existing `metric_samples`. JSON mode maintains `data/docker-monitoring.json` with per-section/per-VPS arrays and the v2 latest source of truth.

Initial maintenance bounds, configurable only within validated ceilings, are: at most 5,000 rows or 2 seconds per PostgreSQL pass; at most 500 raw records per VPS per pass; JSON input/output maximum 32 MiB, maintenance rewrite maximum 8 MiB changed data or 2 seconds, and hard refusal of new historical/event writes (latest still updates) at 32 MiB with a safe capacity status. Maintenance resumes by durable keyset, never offset.

Rollups use closed UTC hourly buckets keyed by `(vpsId, agentInstanceId, scope, containerKey-or-null, cohortDigest-or-null, bucketStart, formulaVersion)`. Host scope uses `containerKey = NULL`; container scope requires a key; sampled aggregate scope requires `cohortDigest = SHA-256(sorted sampled container keys)` and never uses an empty-string sentinel. Persist `firstAt`, `lastAt`, `sampleCount`, gauge `min/max/sum/average`, counter `first/last/increase/resetCount`, and `expectedSamples/observedSamples/partialSampleCount/gapCount/coverageRatio`.

Gauge average is arithmetic mean over accepted observed samples, not time-weighted. `expectedSamples` is computed only over intervals where Docker monitoring was enabled and the agent was observed online, segmented by each reported/configured effective cadence: for each segment, `floor(activeDuration/effectiveCadence)` with no expectation during known offline/disabled intervals. Unknown outage intervals increment `gapCount` and are excluded from the denominator rather than guessed. Cadence changes split segments; `observedSamples` counts unique `snapshotId`s. Counters use `increase = sum(max(0, next-current))`; no delta spans reset, gap, instance change, cadence-unknown boundary, or cohort change. `sampledContainerAggregate` rollups never combine cohort digests; changing cohorts prohibit aggregate rates. Authoritative count gauges roll up independently. Alerts never evaluate from rollups or incomplete aggregate coverage.

### SSE strategy

1. Keep `monitoring.snapshot` and `metrics.updated` envelope schema version 1 compatible.
2. Stop adding Phase 1 history/events/alerts arrays to `DashboardOverview`.
3. Add small event types to `MonitoringEvent`, preferably on the existing VPS-scoped stream from `VpsController`:
   - `docker.latest.updated`: `{ vpsId, collectedAt, receivedAt, revision }`;
   - `docker.events.available`: `{ vpsId, newestEventId, countHint, truncated }`;
   - `docker.alerts.updated`: `{ vpsId, changedAlertIds, refreshRequired }`.
4. Coalesce notifications per VPS to at most one of each type per five-second tick. Each connection has bounded pending sets of at most 100 VPS IDs and 256 alert IDs; overflow collapses to one `refresh_required` frame and clears detail IDs. The full serialized SSE frame, including envelope, is capped at 32 KiB.
5. One connection may have only one async tick/write in flight. Honor `res.write()` backpressure: stop producing detail frames while false, retain only the collapsed bounded invalidation, resume on `drain`, and close after a configurable 10-second slow-consumer timeout. `close`, `finish`, and `error` synchronously clear timers/listeners/pending state; no overlapping `setInterval(async ...)` calls.
6. Migrate global `/api/monitoring/stream` away from full `dockerMetrics` arrays: advertise `dockerInvalidationV1` in `monitoring.hello`; capable clients use invalidations plus REST. During one compatibility release, legacy clients receive the old bounded latest array only under the existing 20-per-VPS contract and a 32 KiB frame cap; overflow sends `refresh_required`. Remove the legacy branch after the supported web version advances. Test hundreds of VPS latest records to prove frame and pending-set bounds. Detailed Docker pages use the scoped stream.

### Approved exception: on-demand realtime container logs (separate transport, no monitoring ingestion)

Realtime container logs are outside the Phase 1 monitoring data flow by construction. They use their own endpoints, their own registry, and their own SSE stream, and they never add a field, event, or repository to Phase 1 monitoring.

Wire contract (mirrored strictly in `packages/api/src/docker/docker-logs.schemas.ts` and `packages/agent/internal/logs/protocol.go`, fail-closed in both directions with every unknown key rejected):

- Browser: `GET /api/vps/:id/docker/management/logs/stream?agentInstanceId=<id>&containerKey=<key>`. Both query parameters are REQUIRED and there is no `tail`, cursor, or `follow` option: the tail is fixed at 200. Each valid connection creates one ephemeral in-memory subscription; that connection is its only viewer, there is no subscription-then-attach split, and therefore no replay buffer or delete route. Connection policy: `DashboardSessionGuard` + `OriginGuard`, VPS existence, `logsSupported` (non-system VPS in local mode), and target membership in the current inventory snapshot (`listCurrentContainers`) for the exact `agentInstanceId`/`containerKey` pair are all checked before SSE headers are written. `dockerManagementEnabled` and the management action capability do not gate read-only logs. Query errors are 400, unknown VPS/target 404, policy-disabled 403, over the connection allowance 429, all as ordinary JSON.
- Agent: `POST /api/agent/logs/claim` (`{agentInstanceId}` → `{data:{subscription:null|{subscriptionId,vpsId,agentInstanceId,containerKey,tailLines:200,expiresAt}}}`) flips `waiting` → `claimed` atomically and never re-claims; `POST /api/agent/logs/:subscriptionId/chunks` (`{agentInstanceId,sequence,ready,lines}`) answers `{data:{ok:true,subscriptionId,sequence}}`; `POST /api/agent/logs/:subscriptionId/result` (`{agentInstanceId,status,errorCode?}`) answers `{data:{ok:true,subscriptionId,agentInstanceId}}`. Agent routes use the same `verifyAgentBearerToken()` credential verification as metrics and commands, the local-updater credential is rejected, and the credential's `vpsId` is bound to the subscription so a credential for one VPS can neither claim nor write another VPS's stream. Unknown subscription ids answer 404, closed ones 410; instance mismatch 401; sequence other than the next expected 409.
- SSE to the browser: `docker.logs.state` (`{subscriptionId,status:"waiting"|"live"}`), `docker.logs.lines` (`{subscriptionId,lines:[{stream:"stdout"|"stderr"|"combined",text,truncated}]}`), `docker.logs.closed` (`{subscriptionId,reason:"completed"|"failed"|"expired",errorCode?}`) and then response close. Headers are the monitoring conventions (`text/event-stream`, `no-cache, no-transform`, `Connection: keep-alive`) plus `X-Accel-Buffering:no`, with a 15-second keepalive comment.

Bounds, in both implementations:

- One Docker request per subscription: `GET /containers/{id}/json` (to read `Config.Tty`, bounded at 256 KiB) then `GET /containers/{id}/logs?stdout=1&stderr=1&tail=200&timestamps=1&follow=1`. There is no snapshot-and-then-follow pair, because two requests would gap or duplicate; there is no automatic source reconnect and no re-read of the tail inside one subscription.
- One line is at most 4 KiB UTF-8, truncated at a rune boundary and reported once with `truncated=true` while the remainder drains to the next newline; empty lines are preserved; `combined` is TTY-only. A batch is at most 100 lines and 32 KiB serialized JSON, measured on serialized bytes. Sequence starts at 1 and increments once per batch/heartbeat; an empty `lines` array is a heartbeat, sent every second so a silent container still proves liveness.
- Agent side: 4 concurrent follow sources at most, claiming once per second while a slot is free, one in-flight upload at a time so batches can never reorder, and a 4-batch bounded queue that fails the stream (`stream_lost`) instead of buffering without limit or dropping silently. Reader EOF drains the queue and flushes the final partial line before reporting `completed`; cancellation flushes nothing new.
- Browser side: the viewer keeps at most 2,000 lines or 1 MiB of text, dropping the oldest with a visible notice, and coalesces appends to at most one render per 100 ms.

Lifecycle: a claim plus `ready` must arrive within 30 seconds of the viewer opening, otherwise `agent_unavailable`; after going live, 10 seconds without a batch or heartbeat is `stream_lost`; the hard subscription lifetime is 2 hours (`expired`, and reconnect opens a fresh 200-line window); policy and dashboard session are revalidated every 15 seconds and expiry/logout ends the stream with `session_expired`; `res.write()` returning false ends the stream as `slow_consumer`. Safe error codes are exactly `container_not_found`, `target_mismatch`, `daemon_unreachable`, `logs_unavailable`, `invalid_docker_stream`, `agent_unavailable`, `stream_lost`, `slow_consumer`, `session_expired`; daemon error bodies and log text never reach an error, a log, a metric, or a response.

Reconnect and demo semantics: the browser `EventSource` never auto-reconnects. `onerror` closes the connection immediately and the viewer shows a disconnected state with a reconnect control; reconnecting is a new subscription, so the displayed buffer is cleared and Docker re-serves the latest 200 lines. Anything emitted in the lost window is deliberately not replayed, because there is nothing to replay it from. Read-only logs are supported by default for non-system VPS records in local mode without a new toggle. Demo mode reports the capability with `logsSupported: false` and an explicit reason instead of opening a source; system VPS records remain excluded. Both opening and ongoing policy checks use `logsSupported`, independently of `dockerManagementEnabled`, while authenticated sessions, agent credentials, and target identity remain enforced. Target discovery is populated when management is enabled or logs are supported; the logs broker policy snapshot contains only `logsSupported` and targets. `dockerManagementEnabled` remains `false` by default and gates action endpoints, not read-only streams.

Rollout: this needs the new API and a new Linux agent together. The agent must be on Linux, because the log source is a separate client that dials only `/var/run/docker.sock` with its own timeout/transport and fails with an explicit unsupported-transport error elsewhere. An older agent cannot claim, so a viewer reports `agent_unavailable` after 30 seconds rather than inventing lines; a new agent against an older API gets a 404 on the claim route and stops its logs worker until restart without disturbing commands, metrics, or the monitoring worker. Verification is behavioral: fake-daemon and broker tests for the decoder, batching, ordering, heartbeat, cancellation, and timeout paths, plus a real-Docker end-to-end smoke when a Linux VPS with socket access is available — automated tests alone do not claim production realtime evidence.

## 4. Incremental Work Breakdown

### Dependency graph

```text
I0 Contract/privacy lock
  -> I1 Persistence and read APIs
       -> I2 Agent schema v2, identity, storage, and events
            -> I3 Ingestion, history, and retention
                 -> I4 Alert evaluation and lifecycle
                 -> I5 SSE invalidation
                      -> I6 Designer-owned Docker detail UI
                           -> I7 rollout hardening and retention operations
```

`I1` can ship dark with no writers. `I2` remains compatible with an old API through current Docker-branch 400 fallback. `I3` can ship without alerts/UI. `I4` and `I5` can ship behind API/UI feature flags. Each increment below has one write owner during implementation; verification ownership is assigned separately in the evidence matrix.

### I0 — Contract and privacy lock

**Implementation owner:** backend/agent engineer. **UI review owner:** designer for terminology only; no production UI change yet.

#### Behavior and acceptance criteria

- [ ] Define schema v2 as an additive discriminated contract while retaining schema v1 validation.
- [ ] Add tests that reject every forbidden class: env, labels, mounts, command/args, secrets, unknown storage object detail, and arbitrary event attributes. Persisted log content is a separate, also-forbidden class: the on-demand realtime logs exception must be proven to leave no log line in any repository, file, audit record, metric, or monitoring payload.
- [ ] Document allowed Docker API paths as constants/tests; no dynamic user-provided path reaches the agent HTTP client.
- [ ] Set explicit caps and default retention values before migration creation.

#### Exact change map

- `packages/agent/internal/metrics/docker.go`: add v2 DTOs, `containerKey`, event batch, storage aggregate, capability/coverage fields, and limits.
- `packages/agent/internal/metrics/docker_api.go`: introduce named private allowlisted request functions only; do not yet enable new calls.
- `packages/api/src/agents/agent.models.ts`: add `AgentDockerMetricsInputV1`, `AgentDockerMetricsInputV2`, event/storage types, and capability response types.
- `packages/api/src/agents/agent.schemas.ts`: use a strict discriminated union on `schemaVersion`; retain literal v1; add strict v2 branch and forbidden-field regression fixtures.
- `packages/api/tests/docker-phase2-regressions.test.ts` and new `packages/api/tests/docker-phase1-contract.test.ts`: backward compatibility, strictness, caps, timestamps, and forbidden fields.
- `packages/agent/internal/metrics/docker_phase3_test.go` and new `docker_phase1_contract_test.go`: allowlist and sanitizer tests.

#### Contracts

- Existing v1 is unchanged.
- V2 is additive under `docker.schemaVersion: 2`; it includes only bounded `containers`, optional bounded `events`, optional aggregate `storage`, coverage metadata, and the fixed-window event watermark fields.
- Ingest response extends `data.config` with optional capability/config fields; old agents ignore them. Required existing `dockerMetricsEnabled` remains.

#### Migration, tests, rollout, rollback

- No migration or data write.
- Roll out API parsing before any agent emits v2.
- Rollback is code-only because no data is written.

### I1 — Dedicated persistence interfaces and bounded read APIs

**Implementation owner:** API persistence engineer.

#### Behavior and acceptance criteria

- [ ] JSON and PostgreSQL repositories pass one shared conformance suite.
- [ ] All list methods require a VPS scope, enforce maximum limits/time ranges, and use stable keyset cursors.
- [ ] Existing latest `AgentRepository` behavior and migration 009 remain untouched.
- [ ] Tables/files can exist empty without changing dashboard responses.

#### Exact change map

- Add `packages/api/src/docker/docker-monitoring.models.ts` for persisted/read models.
- Add `packages/api/src/docker/docker-monitoring.schemas.ts` for REST query and acknowledgement validation.
- Add `packages/api/src/docker/docker-monitoring.service.ts` for scoped reads and lifecycle operations.
- Add `packages/api/src/docker/docker-monitoring.controller.ts` with guarded endpoints.
- Add `packages/api/src/persistence/repositories/docker-monitoring.repository.ts` containing the interface and `createJsonDockerMonitoringRepository(join(config.dataDir, "docker-monitoring.json"))`.
- Add `packages/api/src/persistence/repositories/docker-monitoring.postgres.repository.ts`.
- Update `packages/api/src/persistence/repositories/create-repositories.ts`: add `dockerMonitoring` to `RepositorySet` in both branches.
- Update `packages/api/src/tokens.ts`: add `DOCKER_MONITORING_REPOSITORY`.
- Update `packages/api/src/app.module.ts`: allow dependency injection through `AppDependencies`, register repository/service/controller.
- Add the next available migration number at implementation time, for example `packages/api/db/migrations/013_docker_monitoring.sql` only if 013 is still next; the migration runner's ordering is authoritative. Never modify `009_docker_metrics.sql`.
- Add `packages/api/tests/docker-monitoring-repository.test.ts`, `docker-monitoring-api.test.ts`, and `docker-migration-013.test.ts`; add a PostgreSQL integration counterpart following `docker-migration-009.postgres.test.ts`.

#### Data and API contracts

Proposed guarded endpoints:

```text
GET  /api/vps/:id/docker/history?scope=host&from=&to=&limit=&cursor=
GET  /api/vps/:id/docker/containers/current
GET  /api/vps/:id/docker/instances/:agentInstanceId/containers/:containerKey/history?from=&to=&limit=&cursor=
GET  /api/vps/:id/docker/events?action=&agentInstanceId=&containerKey=&from=&to=&limit=&cursor=
GET  /api/vps/:id/docker/storage
GET  /api/vps/:id/docker/alerts?state=&kind=&agentInstanceId=&containerKey=&limit=&cursor=
POST /api/vps/:id/docker/alerts/:alertId/acknowledge
```

Paginated list responses use `{ data, page: { limit, nextCursor, hasMore } }`. REST pagination cursors are opaque, versioned, signed or strictly validated base64url payloads and bind `vpsId`, scope, `agentInstanceId` (nullable only for host scope), `containerKey` (nullable only for host scope), filters, ordering, and last key; malformed or cross-scope cursors return 400. IDs are opaque and never raw Docker IDs.

`/containers/current` returns `{ data: [{ agentInstanceId, containerKey, name?, state? }] }` from container samples in the latest committed snapshot, or an empty array when none exist. It does not read the legacy latest-snapshot projection: that projection can retain container IDs from before a redeploy. A container recreated under the same name has a new key; select history using the returned instance and key. Names missing from older samples are optional and the UI displays a shortened key.

#### Migration and indexes

The next available migration creates, at minimum:

- `docker_metric_samples(id, vps_id, agent_instance_id, snapshot_id, container_key NULL, collected_at, received_at, effective_at, metrics..., coverage...)`;
- `docker_metric_rollups(vps_id, agent_instance_id, scope, container_key NULL, cohort_digest NULL, bucket_start, formula_version, first_at, last_at, sample_count, gauge_min..., gauge_max..., gauge_sum..., gauge_avg..., counter_first..., counter_last..., counter_increase..., reset_count, expected_samples, observed_samples, partial_sample_count, gap_count, coverage_ratio)`;
- `docker_operational_events(id, vps_id, agent_instance_id, container_key NULL, action, event_occurred_at, received_at, event_digest, context_version, health_status NULL, exit_code NULL, signal NULL, oom_killed NULL)`; no generic event attributes JSONB;
- `docker_storage_latest(vps_id PRIMARY KEY, agent_instance_id, snapshot_id, collected_at, received_at, images_supported, images_count, images_total_bytes, images_total_estimated, images_reclaimable_supported, images_reclaimable_estimated_bytes NULL, containers_supported, containers_count, containers_total_bytes, containers_reclaimable_bytes, local_volumes_supported, local_volumes_count, local_volumes_total_bytes, local_volumes_reclaimable_bytes, build_cache_supported, build_cache_count, build_cache_total_bytes, build_cache_reclaimable_bytes, formula_version)`;
- `docker_event_watermarks(vps_id, agent_instance_id, watermark_time_nano, boundary_digests, committed_batch_id, updated_at)` and `docker_ingest_batches(vps_id, agent_instance_id, batch_id, snapshot_id, request_digest, result)`;
- `docker_alerts(id, vps_id, agent_instance_id NULL, rule_kind, container_key NULL, state, fingerprint, opened_at, last_observed_at, resolved_at, acknowledged_at, acknowledged_by, occurrences, summary, context_version, safe typed context columns...)`. Host alerts use both `agent_instance_id IS NULL` and `container_key IS NULL`; container alerts require both non-null. No empty-string sentinel is permitted.

Required indexes:

- unique host sample `(vps_id, agent_instance_id, snapshot_id) WHERE container_key IS NULL`; unique container sample `(vps_id, agent_instance_id, snapshot_id, container_key) WHERE container_key IS NOT NULL`; identical replay is no-op, same key/different digest is 409 with transaction rollback;
- unique storage observation `(vps_id, agent_instance_id, snapshot_id)` in a storage-history table if history is retained, while `docker_storage_latest` updates only for a newer accepted snapshot;
- unique event `(vps_id, agent_instance_id, event_digest)` plus `(vps_id, event_occurred_at DESC, id DESC)`;
- primary watermark key `(vps_id, agent_instance_id)` and unique committed batch `(vps_id, agent_instance_id, batch_id)`; same batch/request digest returns stored result, different digest is 409;
- fingerprint includes `(vpsId, COALESCE(agentInstanceId,'host'), ruleKind, COALESCE(containerKey,'host'), ruleVersion)`; unique partial index on `(vps_id, fingerprint)` for `state IN ('open','acknowledged')`, plus `(vps_id, agent_instance_id, container_key, state, last_observed_at DESC)`;
- unique rollup key `(vps_id, agent_instance_id, scope, container_key, cohort_digest, bucket_start, formula_version)` using PostgreSQL `NULLS NOT DISTINCT` or equivalent generated sentinel columns with constraints preserving the explicit null semantics above.

No Timescale function appears in the core migration, and these Docker tables remain ordinary PostgreSQL for all of Phase 1.

#### Rollout and rollback

- Apply additive migration first; deploy API with empty reads second.
- Rollback API safely leaves unused additive tables. Do not drop tables during emergency rollback.
- JSON rollback leaves `data/docker-monitoring.json` ignored by old code.

### I2 — Agent v2 collection: stable identity, events, and storage

**Implementation owner:** Go agent engineer.

#### Behavior and acceptance criteria

- [ ] Host metrics still push when any Docker subcollection times out or fails.
- [ ] Docker work never exceeds the existing global five-second deadline.
- [ ] Sequential stats collection reports partial coverage and rotates selected containers fairly.
- [ ] Event retry is at least once and bounded; only a validated acknowledgement advances the event watermark, and one pending batch blocks later windows.
- [ ] Storage contains aggregate `/system/df` semantics only.
- [ ] No forbidden fields occur in marshalled payload fixtures.

#### Exact change map

- `packages/agent/internal/metrics/docker.go`: v2 models, limits, coverage, `containerKey`, event/storage aggregates.
- `packages/agent/internal/metrics/docker_api.go`: deterministic selection/rotation, `/events` bounded decoder, `/system/df` aggregate decoder, response-size limits, remaining-budget checks.
- `packages/agent/internal/metrics/docker_collector_linux.go`: maintain one global context; persist no socket outside agent; coordinate slower storage cadence.
- `packages/agent/internal/metrics/docker_collector.go`: retain fail-closed enable/disable reset; clear pending event-window state when policy requires while preserving the durable installation identity.
- `packages/agent/internal/metrics/collector.go`: attach v2 branches best effort without affecting host collection.
- `packages/agent/internal/push/client.go`: change the pusher API to return a typed structured result containing matching `batchId`, `snapshotId`, `agentInstanceId`, `ingestStatus`, and `committedWatermark`; preserve v1/old-server fallback and classify 409 CAS/identity conflict without discarding pending state.
- `packages/agent/internal/run/run.go`: create and fsync pending IDs/window state before push; atomically commit only a validated structured acknowledgement; do not log event bodies.
- Add `packages/agent/internal/state/docker_state.go` (or the repository's agreed internal state package) for the versioned root-owned `0600` installation key, pending batch, snapshot ID, watermark, and boundary digests with create-exclusive/atomic/fsync behavior.
- Add/extend tests in `packages/agent/internal/metrics/docker_test.go`, `docker_phase3_test.go`, new `docker_events_test.go`, `docker_storage_test.go`, `packages/agent/internal/push/client_test.go`, and new `packages/agent/internal/state/docker_state_test.go`. Event fixtures must include 101+ safe events with identical `timeNano`, a transmit byte cap reached mid-boundary, boundary-overrun limit+1 abandonment, source-response limit+1, crash/retry, and proof that every outcome advances, changes the remaining work, or records explicit loss.

#### Contracts and compatibility

- New API + old agent: accepts v1 and preserves latest-only behavior; it does **not** create v2 history because v1 lacks `snapshotId` and `agentInstanceId`; reports `history=false`, `containerHistory=false`, `events=false`, `storage=false` capabilities.
- Old API + new agent: new agent starts with v1 until server advertises v2. If a v2 branch receives 400, `Client.Push` strips Docker, disables it for that response cycle, and core host metrics continue as today.
- New API + new agent: server advertises maximum accepted schema 2 and caps; agent never exceeds its compiled limits even if server advertises larger values.
- Mixed agents across VPSs are expected; capabilities are per VPS and derived from accepted payloads, never a global deployment assumption.

#### Rollout and rollback

- Ship API capability advertisement before the v2 agent.
- Gate v2 with server response capability; no manual fleet-wide synchronized upgrade.
- Rollback server advertisement to schema 1 to stop v2 emission without uninstalling agents.

### I3 — Atomic ingest, history, downsampling, and retention

**Implementation owner:** API backend engineer.

#### Behavior and acceptance criteria

- [ ] One accepted `DockerV2IngestUnit` atomically commits latest, samples, events, storage, alert transitions, and watermark in PostgreSQL or the JSON source of truth.
- [ ] A retried payload/event batch does not duplicate samples/events.
- [ ] Older source snapshots may enter history but may not overwrite `agent_docker_metrics` latest.
- [ ] Retention and rollups work identically in observable behavior for JSON and PostgreSQL.
- [ ] No history or event array is added to dashboard overview/SSE snapshots.

#### Exact change map

- `packages/api/src/agents/agent.service.ts`: branch by accepted Docker schema, map safe fields, call `DockerMonitoringService.ingestV2Unit`, return the structured committed result/capabilities; retain the current v1 latest path only.
- `packages/api/src/docker/docker-monitoring.service.ts`: define `DockerV2IngestUnit`, CAS/idempotency/conflict rules, retention trigger, rollup, reconciliation, and safe read DTOs.
- PostgreSQL repository accepts one `PoolClient` supplied by a transaction wrapper and performs all v2 writes/evaluation in that transaction; no helper silently falls back to `pool.query`.
- JSON repository performs one `readModifyWriteJsonFile` mutation of `data/docker-monitoring.json` for all v2 state. After commit, project latest into `data/agents.json` at least once. On startup and before latest reads, reconcile missing/stale compatibility projection from the source-of-truth revision; projection failure does not roll back accepted v2 history and is surfaced safely.
- `packages/api/src/config/app-config.ts`: add validated retention, hard-cap, and maintenance interval settings.
- `packages/api/src/server.ts` and the existing mutation rate-limit wiring in `packages/api/src/app.ts`: register the dedicated alert-acknowledgement limiter; add validated `DOCKER_ALERT_ACK_RATE_LIMIT_MAX`/window settings in `packages/api/src/config/app-config.ts` and tests in the existing config/rate-limit suites plus `packages/api/tests/docker-alerts.test.ts`.
- `packages/api/src/vps/vps.service.ts` and `packages/api/src/agents/agent-uninstaller.service.ts`: integrate disable/delete/uninstall cleanup through `DockerMonitoringService`, with idempotent repository cleanup and active-alert administrative resolution according to the selected retention policy.
- `.github/workflows/ci.yml`: add the new migration asset to image smoke checks. Add a mandatory `docker-monitoring-postgres16` job with `services.postgres.image: postgres:16`, health check via `pg_isready`, `VPS_MANAGER_TEST_POSTGRES_URL=postgres://vps_manager:vps_manager@localhost:5432/vps_manager`, `npm ci`, and focused migration/repository/ingest tests. Keep the existing `timescale/timescaledb:2.17.2-pg16` PostgreSQL integration job separate; it does not satisfy plain-PostgreSQL evidence.
- `.env.example`: add safe defaults (implementation is explicitly allowed only in a later production change; this plan does not edit it).
- Tests: `packages/api/tests/docker-monitoring-ingest.test.ts`, repository conformance, config tests, and PostgreSQL integration tests.

#### Retention behavior

- Run cheap cap enforcement synchronously per append.
- Run downsampling/pruning at most once per configured maintenance interval per process; use PostgreSQL advisory locking so multiple API replicas do not duplicate maintenance.
- JSON mode records `lastMaintenanceAt` and performs bounded work under the file lock.
- Do not backfill `agent_docker_metrics` into v2 history: v1 rows lack `agentInstanceId` and retry-stable `snapshotId`. History starts with the first accepted v2 ingest; the existing latest row remains available through the compatibility view.

#### Rollback

- Stop writes by disabling v2 advertisement/history feature flag.
- Existing latest snapshot remains functional through migration 009.
- Preserve collected tables/file for forward recovery; pruning can continue only if its code version understands the schema.

#### JSON/PostgreSQL conformance boundary

Shared conformance covers accepted/replayed/conflicting ingest outcomes, dedupe keys, latest/history/event/storage/alert reads, ordering, pagination, retention semantics, and cleanup. PostgreSQL-only guarantees are multi-replica safety, database transaction isolation, advisory-lock maintenance, and SQL query plans. JSON guarantees single-process atomic file replacement plus at-least-once compatibility projection; it does not promise cross-file atomicity or multi-process safety. Configuration must refuse JSON mode when a configured replica/worker count exceeds one; startup obtains an exclusive process lock where supported and fails closed on contention.

### I4 — Server-side alert evaluation and lifecycle

**Implementation owner:** API backend engineer. **Product owner:** approves initial rule catalog/defaults.

#### Behavior and acceptance criteria

- [ ] Evaluation occurs after complete validation against staged observations plus transaction-visible prior state, before the same atomic commit; no alert state is published before commit.
- [ ] Duplicate observations update one active alert rather than create alert storms.
- [ ] Missing/partial container coverage cannot resolve a container alert.
- [ ] Acknowledgement does not resolve an unhealthy condition.
- [ ] Docker operational events never enter the audit repository; acknowledgement may create one safe audit event.

#### Exact change map

- Add `packages/api/src/docker/docker-alert.service.ts` with typed rule evaluation and transitions.
- Add `packages/api/src/docker/docker-alert.models.ts` for rule kinds, lifecycle, fingerprints, and safe context.
- Update `packages/api/src/docker/docker-monitoring.service.ts` to stage validated observations, invoke the evaluator against staged plus transaction-visible prior state inside the `PoolClient` transaction/JSON mutation callback, commit all writes together, then publish SSE activity only after successful commit.
- Update `packages/api/src/docker/docker-monitoring.controller.ts` for acknowledgement.
- Use existing `packages/api/src/audit/audit.service.ts` only for `docker.alert.acknowledged` (actor, VPS ID, alert ID, rule kind; no daemon payload).
- Add `packages/api/tests/docker-alerts.test.ts` and acknowledgement authorization/audit tests.

The complete state model is specified in [Alert lifecycle and state model](#5-alert-lifecycle-and-state-model).

#### Rollout and rollback

- Deploy evaluator disabled; shadow-evaluate to counters/log-safe diagnostics without creating alerts.
- Enable one rule kind at a time. UI may read alerts only after lifecycle tests pass.
- Rollback disables evaluation; existing alerts remain readable. Optionally bulk-resolve with reason `evaluation_disabled` only through an explicit maintenance operation, not silently.

### I5 — Bounded SSE invalidation

**Implementation owner:** realtime/API engineer.

#### Behavior and acceptance criteria

- [ ] Latest/event/alert writes publish coalesced invalidations, never history arrays.
- [ ] Scoped stream cannot expose another VPS's IDs or counts.
- [ ] Reconnect/refetch recovers missed updates.
- [ ] Slow/disconnected clients release listeners and timers.

#### Exact change map

- Add `packages/api/src/docker/docker-activity.service.ts`, modeled on `packages/api/src/jobs/job-activity.service.ts`.
- Update `packages/api/src/monitoring/monitoring.service.ts`: subscribe/teardown, scoped filtering, coalescing, payload cap; avoid `JSON.stringify` of growing Docker state for new event classes.
- Update `packages/web/src/lib/live-api.ts`: add typed envelope variants and callbacks while preserving envelope schema 1.
- Update `packages/web/src/context/DashboardContext.tsx` and/or `VpsWorkspaceContext.tsx`: invalidate and refetch relevant bounded REST resources.
- Extend `packages/api/tests/monitoring.test.ts`, `docker-phase2-regressions.test.ts`, and `packages/web/src/App.test.tsx`.

#### Rollout and rollback

- REST remains authoritative; SSE events can be feature-flagged off with only polling/manual refresh degradation.
- Old browsers ignore unknown event names. New browsers continue working against old API because initial REST reads and existing events remain valid.

### I6 — Designer-owned Docker detail experience

**Implementation owner:** **designer agent/engineer** for layout, responsive behavior, visual hierarchy, chart interaction, accessible states, and user-facing monitoring copy. A backend/fixer owner may only perform mechanical type/API wiring that preserves the approved design.

#### Behavior and acceptance criteria

- [ ] `/vps/:vpsId/docker` clearly separates latest snapshot, history, events, alerts, and Docker storage.
- [ ] Every chart indicates source time range, freshness, gaps, partial coverage, counter resets, and whether data is raw or hourly rollup.
- [ ] Container list states “showing N retained details of authoritative total M.”
- [ ] Events are labeled operational Docker events, not audit history.
- [ ] No Phase 1 control affordance suggests start/stop/restart/exec/Compose capability, and no Phase 1 view presents logs. The separately approved realtime-logs viewer is the single log surface: it opens on demand, is bounded to 2,000 displayed lines or 1 MiB with a visible discard notice, and reconnects by opening a new subscription that re-reads the fixed 200-line tail instead of promising a replay of whatever was missed while disconnected.
- [ ] Mobile, keyboard, screen-reader, loading, empty, unsupported-agent, stale, and error states are tested.

#### Exact change map

- Evolve `packages/web/src/components/dashboard/servers/DockerMetricsPanel.tsx`; retain compact card behavior and privacy copy.
- Add components under `packages/web/src/components/dashboard/docker/`: `DockerHistoryChart.tsx`, `DockerEventTimeline.tsx`, `DockerAlertsPanel.tsx`, `DockerStorageOverview.tsx`, `DockerCapabilityNotice.tsx`.
- Update `packages/web/src/context/VpsWorkspaceContext.tsx` to load bounded tab data for the existing Docker route.
- Update `packages/web/src/lib/api.ts` with DTOs and paginated request functions.
- Update `packages/web/src/lib/live-api.ts`/context integration from I5.
- Extend `packages/web/src/components/dashboard/servers/DockerMetricsPanel.test.tsx`, add focused component tests, and extend `packages/web/src/App.test.tsx` route/integration coverage.

#### Rollout and rollback

- Hide unavailable sections by capability with explicit “upgrade agent” messaging; never show empty data as healthy.
- Feature-flag advanced sections independently from the existing latest snapshot.
- Rollback restores the existing `DockerMetricsPanel` detail presentation while APIs/data remain additive.

### I7 — Retention operations and rollout hardening

**Implementation owner:** API/operations engineer.

#### Behavior and acceptance criteria

- [ ] Retention runs with bounded work and reports safe counts/durations.
- [ ] Disk growth estimates and cap alarms exist for both storage modes.
- [ ] Upgrade/downgrade, daemon restart, API outage, clock skew, and malformed payload drills pass.
- [ ] Plain PostgreSQL 16 is the mandatory release baseline; the existing Timescale job remains separate and cannot substitute for it.

#### Exact change map

- Add `packages/api/src/docker/docker-retention.service.ts` or integrate bounded scheduling into `DockerMonitoringService` if it remains cohesive.
- Update `packages/api/src/health/health.controller.ts` only with safe aggregate health if needed; never include container names/events.
- Add operational settings to `packages/api/src/config/app-config.ts` and `.env.example` during implementation.
- Add targeted tests under `packages/api/tests/` and update `docs/postgres-timescale-storage.md` only in the implementation PR (outside this plan-only task).

#### Rollback

- Retention/downsampling can be disabled independently, but hard append caps must remain active.
- Do not require a destructive reverse migration. Restore from database/file backup only for actual corruption, not ordinary code rollback.

## 5. Alert Lifecycle and State Model

### Rule evidence and initial catalog

Keep rules typed and server-owned. Candidate Phase 1 rules:

- `docker_unavailable`: open from repeated host Docker `available=false`; clear only after the configured consecutive complete host Docker snapshots report `available=true`. Missing/stale snapshots are unknown.
- `container_unhealthy`: open only from an exact `(agentInstanceId, containerKey)` unhealthy sample/event. Clear only from the configured consecutive exact-container samples explicitly reporting healthy/running. A list omission or another container's health never clears it.
- `container_restart_loop`: open from typed start/restart/die events for the exact container in a complete, gap-free window. Clear only after a configured gap-free quiet window plus an exact healthy sample. Any event gap freezes open/resolve decisions.
- `container_cpu_high` and `container_memory_high`: open from N-of-M exact-container samples with complete per-sample coverage. Clear only from M exact-container below-clear-threshold samples. `sampledContainerAggregate` and incomplete coverage are forbidden evidence.
- `docker_storage_pressure`: evaluate only from a complete sanitized storage observation using the formula version expected by the rule. Clear only from subsequent complete observations below the clear threshold. It describes Docker-managed bytes, not host free space.
- `docker_event_gap`: open from an explicit gap reason and resolve only after a new agent instance/window baseline or a configured run of complete gap-free windows; it never implies recovered lost events.

Thresholds, severities, and defaults require product agreement. Do not infer a host disk-full alert from Docker `/system/df`; it does not provide arbitrary host filesystem capacity.

### States and transitions

```text
no alert --qualifies--> open
open --acknowledge--> acknowledged
open --clear condition--> resolved
acknowledged --condition persists--> acknowledged (occurrences/lastObservedAt update)
acknowledged --clear condition--> resolved
resolved --condition reoccurs after cooldown--> new open alert ID
```

- `open`: condition currently observed and not acknowledged.
- `acknowledged`: condition remains active but a dashboard actor has acknowledged awareness. Acknowledgement records `acknowledgedAt` and a safe actor/session identifier; it is not resolution.
- `resolved`: evaluator observed rule-specific clear evidence, a typed Docker `destroy`/`remove` event for that exact container (gone resolution), or an administrative transition. Store reason `condition_cleared`, `container_removed`, `monitoring_disabled`, or `identity_reset_orphaned`. Phase 1 does not use `container_gone_after_grace`: capped details are not full membership evidence.
- Do not add a separate `closed` state in Phase 1. Resolution is automatic and evidence-driven.

### Deduplication, hysteresis, and cooldown

- Fingerprint: hash of `(vpsId, agentInstanceId-or-host-null-marker, ruleKind, containerKey-or-host-null-marker, normalized rule version)`. Host alerts have null instance/container columns; container alerts require both. Never include names, images, event payload JSON, or threshold values that would accidentally create parallel alerts after a tuning change; explicitly version rule semantics.
- One active row (`open` or `acknowledged`) per fingerprint.
- Trigger only after a rule-specific `N of M` sample/window condition. Resolve only after a separate clear threshold/window to prevent flapping.
- On duplicate qualifying evidence, update `lastObservedAt`, `occurrences`, severity/context, and evaluation revision.
- After resolution, suppress a new alert for the configured cooldown unless severity escalates. Keep the resolved record immutable except safe annotation.
- Partial detail coverage, timeout, stale data, event gap, identity conflict, or agent absence is “unknown,” freezes resolution/cooldown evidence, and never clears an alert. Monitoring disable administratively resolves active Docker alerts as `monitoring_disabled`; installation identity reset administratively resolves prior-instance container alerts as `identity_reset_orphaned` while retaining them for auditability. Only an exact typed `destroy`/`remove` event can establish a gone container in Phase 1.

### Evaluation ownership and audit implications

- `DockerAlertService` in the API is the sole lifecycle transition owner. Agents provide observations, never alert state.
- Evaluation runs after input validation against staged observations plus transaction-visible prior state, before commit. PostgreSQL persists observations, alert transitions, and watermark in the same transaction; JSON computes and persists them inside one `readModifyWriteJsonFile` callback. Only after commit may `DockerActivityService` publish SSE invalidations. Expensive notifications are out of scope.
- Operational events in `docker_operational_events` describe Docker daemon/container observations and are high volume. They never call `AuditService`.
- User acknowledgement is a dashboard mutation and may append one `AuditEvent` via `AuditService` with action `docker.alert.acknowledged`, resource ID equal to the alert ID, VPS linkage, result, and no raw event/context body.
- Automated open/resolve transitions remain in the alert table's lifecycle fields. They are not user audit events.

## 6. Security, Privacy, Performance, Reliability, and Failure Analysis

### Security and privacy controls

- Keep Unix socket code behind Linux agent build files. Add `scripts/tests/check-no-docker-socket.sh` assertions for API/web manifests and source references where appropriate.
- Use hardcoded method/path builders; all Docker calls are GET. Reject redirects and non-Unix/default transports in production agent construction.
- Apply `io.LimitReader(limit+1)` before every decode so oversize is distinguishable from exact-limit success. Preserve existing list/stats limits; event source and `/system/df` limits use explicit limit+1 sentinels.
- Strict schemas reject unknown keys recursively. Repository mappers rebuild safe objects rather than store the incoming Docker branch wholesale.
- Never log raw request payloads, Docker event attributes, IDs before derivation, image/name combinations at warning/error level, or cursors containing raw IDs.
- Dashboard endpoints remain guarded and VPS existence/scoping is checked before response headers/data, following `VpsController.streamMonitoring` behavior.
- Acknowledge uses session and origin guards and validates that the alert belongs to the route VPS. The existing server mutation limiter is only a baseline; add an alert-acknowledgement-specific per-session/per-IP bucket (initially 30/minute) because repeated acknowledgements have persistence/audit cost.

### Sanitized Docker storage formulas

Decode only version-tolerant numeric/boolean fields needed from `/system/df`; unknown fields are ignored, missing categories become `supported=false` rather than zero. For each category, clamp non-negative safe integers and compute:

- images: use top-level `LayersSize` as `imagesTotalBytes` only for tested Engine API versions where the field is present and valid. Never sum `Images[].Size`, because virtual sizes share layers and overlap. Phase 1 does not claim authoritative image reclaimable bytes: if version-tested unique/shared-size semantics are unavailable, set `imagesReclaimableSupported=false`; an optional per-image estimate must be named `imagesReclaimableEstimatedBytes`, marked estimated, and excluded from alerts;
- containers: `totalBytes = sum(Containers[].SizeRw)`, `reclaimableBytes = sum(SizeRw where State != "running")`;
- local volumes: `totalBytes = sum(Volumes[].UsageData.Size)`, `reclaimableBytes = sum(Size where UsageData.RefCount == 0)`;
- build cache: `totalBytes = sum(BuildCache[].Size)`, `reclaimableBytes = sum(Size where InUse == false)`.

Persist `formulaVersion=1`, every category's `supported` flag and object count, totals, and separate reclaimable-supported/estimated flags where applicable. Never persist source arrays. Negative, non-finite/unsafe, contradictory, or malformed category values mark that category unsupported; they do not fail other categories. Read through `io.LimitReader(256KiB+1)` and reject when the sentinel byte exists; oversize/decoder failure omits the entire storage observation, retains prior latest as stale, and records only a sanitized error code. Fixtures must cover shared image layers, missing/changed `LayersSize`, exact-limit and limit+1 responses. UI wording is “Docker image layer bytes reported by the Engine” and, only when present, “estimated potentially reclaimable image bytes”—never “image disk usage” or authoritative “reclaimable.”

### Performance controls

- Container samples are bounded by 20 per cycle and rotated; storage is five-minute cadence; events are 100/64 KiB per batch.
- Historical reads never scan across all VPSs and use covering order indexes/keyset pagination.
- Latest dashboard reads continue using `agent_docker_metrics`, not historical aggregate queries.
- SSE carries revisions/invalidation only. Charts fetch only the selected range/series and downsample server-side when point count exceeds the response cap.
- JSON mode enforces a conservative global file-size/record cap and is documented as local/small-installation storage. Avoid one file per container, which creates unbounded file counts.

### Reliability and failure modes

| Failure | Required behavior |
| --- | --- |
| Docker socket missing/permission denied/daemon unreachable | Existing sanitized error codes remain; host metrics push; repeated failures may open `docker_unavailable`. |
| Five-second Docker deadline reached during sequential stats | Return partial details with coverage; do not classify unsampled containers healthy; rotate next cycle. |
| `/events` count/payload cap | Advance only to the greatest fully processed timestamp boundary and replay inclusively; boundary digest overflow/response oversize records a gap and never skips silently. |
| `/system/df` is slow or malformed | Omit storage branch for that cycle, retain prior latest storage as stale, host/latest metrics continue. |
| API unavailable | Existing push retry/backoff retries the single durable pending batch; event watermark is unchanged and no later window is collected. Recovery commits that batch or an explicit policy/operator abandonment records loss through its fixed `U`. |
| Duplicate/reordered payload | `batchId`, `snapshotId`, digests, unique keys, and watermark CAS prevent duplicates; same key/different content is 409; older accepted history cannot replace latest. |
| Agent clock outside accepted window | Reject only invalid Docker v2 branch where contract permits core retry without Docker; expose safe diagnostic/capability state. Do not persist fabricated time. |
| API restarts during ingest | PostgreSQL transaction commits all-or-nothing. JSON source-of-truth mutation is atomic; `agents.json` projection is reconciled at least once after restart. |
| Multiple API replicas | PostgreSQL unique constraints/advisory lock coordinate writes/maintenance; JSON mode is explicitly single-process and must fail configuration validation or be documented unsupported for replicas. |
| SSE disconnect or slow client | Tear down listeners/timers; client refetches REST after reconnect; missed SSE does not lose durable data. |
| Agent v1 | Existing latest view remains; v2 history/events/storage are unsupported because v1 lacks stable instance/snapshot identity. |
| Monitoring disabled | Agent stops socket access after next acknowledged config; API ignores stale branches as today; lifecycle/data handling follows agreed policy. |
| Container deleted/recreated with same name | Different `containerKey`; history is not merged by name. Resolve the old container alert only from an exact typed `destroy`/`remove` event or an administrative identity/disable transition. |
| Counter reset/daemon restart | Mark reset; rate is unknown/zero for that interval, never a negative spike. |
| Agent log source unavailable on non-Linux | Explicit unsupported-transport failure; no TCP daemon target is configurable, and the subscription fails safely rather than dialing any other endpoint. |
| Docker logging driver cannot serve reads (4xx/5xx other than 404) | `logs_unavailable`, terminal and retryable by reconnecting; the logging driver is never switched and host log files are never read. |
| Log daemon frame malformed or split across reads | `invalid_docker_stream` — the incremental decoder reassembles with `io.ReadFull` and has no raw fallback, so partial headers/payloads or bad stream IDs fail closed instead of leaking binary bytes. |

### Migration and backfill

- Migration is additive and safe on plain PostgreSQL. Apply before enabling writes.
- No historical backfill can be reconstructed from latest-only `agent_docker_metrics`.
- No v1 row is copied into v2 history because identity/dedupe fields cannot be reconstructed safely.
- JSON creates a new `data/docker-monitoring.json`; do not migrate historical data from `data/agents.json`. Reconciliation applies only to projecting accepted v2 latest state in the other direction.
- Validate row counts, indexes, and sample query plans before enabling fleet-wide v2.

## 7. Project-specific Evidence and Verification Matrix

Each claim has one evidence owner and the minimum non-duplicative evidence. The orchestrator is final validation owner and will inspect this file plus commission independent architecture/security review.

| Claim | Evidence owner | Minimum evidence |
| --- | --- | --- |
| API/Web never access or mount the Docker socket | Security reviewer | `sh scripts/tests/check-no-docker-socket.sh`; inspect `docker-compose.yml`, Dockerfile, and agent-only `docker_collector_linux.go`. |
| Forbidden fields cannot enter v2 | API contract test owner | Focused strict-schema tests plus serialized Go fixture test covering env/labels/mounts/commands/logs/secrets. |
| Existing v1 agents continue to ingest | API compatibility test owner | Existing Docker regression suite plus one new v1-with-v2-API test. |
| New agent safely downgrades against old API | Agent push test owner | `go test ./internal/push -run Docker` (exact test name to be set) demonstrating 400 strip/retry/fail-closed behavior. |
| Five-second deadline and sequential partial collection are honest | Agent collector test owner | Fake daemon timing test showing completion by deadline, partial coverage, and next-cycle rotation; no cadence assertion stronger than configured interval/budget. |
| PostgreSQL and JSON share defined semantics | Persistence test owner | One shared conformance suite for the documented common boundary, plus backend-specific tests for PostgreSQL transactions/replicas and JSON lock/projection behavior. |
| Core migration works on plain PostgreSQL 16 | Database test owner | Mandatory `.github/workflows/ci.yml` job backed by `postgres:16` and `VPS_MANAGER_TEST_POSTGRES_URL`; Timescale job remains separate; no extension/function reference in the Docker migration. |
| History/events are bounded and instance-scoped | API test owner | Max-limit/range tests plus REST cursor tamper tests binding VPS, `agentInstanceId`, container, filters, and ordering; identity-reset isolation tests. |
| Event delivery and acknowledgement are crash-safe | API/agent integration owner | Exercise every crash point, 101+ same-`timeNano`, mid-boundary byte cap, both limit+1 sentinels, single-pending outage recovery, explicit abandonment, CAS monotonicity, and structured result validation. |
| SSE does not carry history or unbounded arrays | Realtime test owner | Assert exact event payload keys/size fallback and scoped VPS isolation. |
| Alerts dedupe and lifecycle are correct | Alert test owner | Table-driven instance-scoped fingerprint/index, open/acknowledged/resolved/reopen/cooldown/hysteresis, exact remove/destroy, unknown/gap freeze, monitoring disable, and identity-reset orphan tests. |
| Operational events do not pollute audit | Security test owner | Event ingestion leaves audit count unchanged; acknowledgement adds exactly one safe audit record. |
| Storage is safe and non-overlapping | Agent/API contract owner | Shared-layer fixtures verify `LayersSize` handling, unsupported/estimated image reclaimability, supported/count fields, exact-limit and limit+1 behavior, and absence of names/paths/object IDs. |
| UI communicates stale/partial/unsupported states | Designer + web test owner (designer owns claim) | Component tests and manual responsive/accessibility review of `/vps/:vpsId/docker`. |
| Retention is bounded and idempotent | Retention test owner | Seed over limits, run maintenance twice, verify same rollups and bounded raw/event counts. |

Known repository commands:

```bash
npm test
npm run typecheck
npm run build
npm run test:agent
```

`npm run migrate:db` is an operational command that mutates the configured database, not a generic verification command. Use it only against an explicitly disposable target.

Focused commands should use existing Vitest/Go conventions, for example:

```bash
npx vitest run packages/api/tests/docker-monitoring-api.test.ts
npx vitest run packages/api/tests/docker-alerts.test.ts
npx vitest run packages/web/src/components/dashboard/servers/DockerMetricsPanel.test.tsx
cd packages/agent && go test ./internal/metrics ./internal/push ./internal/run ./internal/state
```

PostgreSQL integration tests are gated by `VPS_MANAGER_TEST_POSTGRES_URL`, matching `packages/api/tests/docker-migration-009.postgres.test.ts`. The mandatory new CI job uses `postgres:16`; the existing Timescale service/job stays separate. Do not claim plain-PostgreSQL evidence from Timescale, mocked SQL, or merely running `npm run migrate:db`.

## 8. Release Sequencing, Checkpoints, and Definition of Done

### Release sequence

1. **Checkpoint A — contract and policy approved:** privacy allowlist, v2 schema, IDs, caps, retention, event set, alert defaults, and the disable/data policy are signed off. Cleanup schema, `VpsService`/`AgentUninstallerService` behavior, and cleanup tests may not be finalized before this policy decision.
2. **Checkpoint B — additive storage deployed:** migration and repositories deployed dark; JSON/PostgreSQL conformance and plain-PostgreSQL migration evidence green.
3. **Checkpoint C — API accepts v2:** schema and capability advertisement deployed with v2 advertisement disabled; v1 regression suite green.
4. **Checkpoint D — canary agent:** enable v2 for one non-critical VPS; observe collection duration, partial coverage, payload size, dedupe, clock skew, and storage growth for at least one retention-maintenance cycle.
5. **Checkpoint E — history/events enabled:** gradual server-side capability rollout; no alert creation yet. Validate event gaps and retention.
6. **Checkpoint F — alerts shadow mode:** evaluate without user-visible opens; compare expected rule outcomes and tune hysteresis.
7. **Checkpoint G — alerts active:** enable one rule kind at a time; verify audit separation and acknowledgement.
8. **Checkpoint H — designer UI:** release bounded REST + SSE-driven detail sections after backend contracts stabilize.
9. **Checkpoint I — broad rollout:** increase canary percentage with rollback switch remaining available. Phase 1 Docker tables remain ordinary PostgreSQL; no Docker-table Timescale experiment is part of this release.

### Explicit definition of done

- [ ] All five scoped capabilities are usable: detail, history, operational events, server-side alerts, and aggregate Docker storage.
- [ ] Monitoring-only and privacy invariants have automated regression evidence.
- [ ] No production code exposes Docker control, Compose, arbitrary inspect data, or API/Web socket access. The realtime logs exception is on-demand only: no background log collection, indexing, previews, search, download, log-driven alerts, or log content in audit/jobs/metrics.
- [ ] v1 and v2 schema compatibility and mixed fleet behavior are tested.
- [ ] Latest totals remain authoritative and retained details are visibly capped.
- [ ] Five-second global Docker budget and sequential stats limitations are represented by partial coverage rather than impossible cadence promises.
- [ ] JSON and PostgreSQL pass the same repository behavior suite.
- [ ] Mandatory `postgres:16` CI evidence passes migration, indexes, ingest, retention, and history queries; Docker tables remain ordinary PostgreSQL and the separate Timescale job is unrelated.
- [ ] Fixed-window event ingest, durable boundary replay, structured acknowledgement, snapshot dedupe, and watermark CAS pass crash/fault tests; browser SSE remains best effort with REST recovery.
- [ ] SSE contains only bounded latest data/invalidation and cannot grow with history.
- [ ] Alert open/acknowledged/resolved lifecycle, dedupe, cooldown, and audit separation pass.
- [ ] Rollback switches are documented and tested without reverting migration 009 or requiring destructive schema rollback.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:agent` pass.
- [ ] Independent architecture/security review has no unresolved release-blocking findings.
- [ ] Designer owns and signs off all new user-visible layout, responsive behavior, interaction, state communication, and accessibility work.

## 9. Open Decisions Requiring Product/Engineering Agreement

Identity, fixed-window event delivery, atomicity, sample/event dedupe, and alert evidence rules are closed architecture decisions above. Remaining decisions are product/operational policy only:

1. **Container selection presentation:** approve priority/rotation UX within the closed 20-detail/five-second constraint; collection must remain deterministic and coverage-explicit.
2. **Event allowlist:** select which container lifecycle/health actions are user-visible. Image/network/volume events remain excluded unless separately privacy-reviewed.
3. **Disable/data policy:** choose immediate purge, retention-until-expiry, or preserve history. In every option active alerts resolve administratively as `monitoring_disabled` and latest stops appearing live.
4. **Retention:** approve 7-day raw, 30-day hourly, 14-day events/10,000 per VPS, 30-day resolved-alert, 32 MiB JSON, and maintenance defaults or choose stricter values.
5. **Alert thresholds:** approve enabled rule kinds, severities, N-of-M windows, hysteresis, and cooldown durations; evidence admissibility is not configurable.
6. **Acknowledgement actor display:** choose the safe actor label derived from current session data and exact audit metadata allowlist.
7. **Storage wording:** approve “Docker-managed storage,” “Docker image layer bytes reported by the Engine,” and “estimated potentially reclaimable”; never imply host free space or guaranteed reclamation.
8. **Feature rollout:** approve per-VPS capability flags/canary controls returned by ingest; per-VPS is recommended for mixed agents.
9. **Demo mode:** decide whether bounded deterministic simulated history/events/alerts/storage is required. Simulated records must never enter production repositories.

## Appendix A. Independent Review Disposition

| Finding | Resolution in this revision |
| --- | --- |
| Fictional `/events` cursor | Replaced with fixed inclusive `[since, until]` windows, streaming decode, durable watermark/boundary digests, caps, gaps, CAS, structured ack, and crash matrix. |
| Unresolved/token-adjacent identity | Closed on root-owned `0600` atomic versioned 256-bit installation key with domain-separated `agentInstanceId`/`containerKey`, fail-closed corruption, and reset/orphan behavior. |
| Missing instance identity | Added required `agentInstanceId` to v2 payloads, storage keys, transition rules, and conflicts. |
| Overstated atomicity/parity | Defined `DockerV2IngestUnit`, one PostgreSQL `PoolClient` transaction, JSON single-file source of truth, at-least-once compatibility projection/reconciliation, and explicit parity exclusions. |
| Missing sample idempotency | Added durable retry-stable `snapshotId`, unique host/container/storage keys, request digests, and 409 mismatch behavior. |
| Ambiguous alert clearing | Added rule-specific exact evidence, gap/unknown freezes, remove/destroy-only gone resolution, disable and identity-reset administrative reasons. |
| Unsafe pusher acknowledgement | Required typed pusher result and validate-before-commit monotonic local watermark behavior. |
| Aggregate/rollup ambiguity | Renamed to `sampledContainerAggregate`; only counts authoritative; added coverage/cohort/reset/gap formulas and alert prohibitions. |
| Timescale ambiguity | Phase 1 Docker tables are ordinary PostgreSQL; optional Timescale remains only for existing metrics. |
| JSON replica ambiguity | Added conformance boundaries, replica-count refusal, and exclusive process-lock requirement. |
| SSE growth/backpressure | Added full-frame/pending caps, collapse behavior, no overlap, backpressure timeout, teardown, global-array migration, compatibility capability, and many-VPS tests. |
| Authorization overstatement | Clarified session-wide dashboard authorization versus VPS response filtering. |
| Generic event JSON | Replaced with typed columns/versioned strict safe context. |
| `/system/df` ambiguity | Added exact v1 formulas, version tolerance, category support, and oversize behavior. |
| Vague maintenance limits | Added row/time/per-VPS/file-byte defaults with bounded config. |
| Verification inaccuracies | Corrected to `VPS_MANAGER_TEST_POSTGRES_URL`, added `.github/workflows/ci.yml`, and classified `migrate:db` as mutating operation, not evidence. |
| Rate-limit/cleanup gaps | Added alert-specific acknowledgement limit and exact `VpsService`/`AgentUninstallerService` cleanup integration/tests. |
| Migration numbering | Next available number is authoritative; 013 is illustrative only. |
| Dense event timestamp can stall forever | Separated decode/work from transmit/storage caps; completed the current timestamp under bounded overrun; added explicit lossy advance through fixed `U` when overrun is exhausted, limit+1 detection, and 101+/mid-boundary tests. |
| Incomplete instance scoping | Added `agentInstanceId` to alerts, fingerprints/indexes, rollups/cohorts, container history routes, event/alert filters, REST cursor scope, and reset-isolation tests; host scope uses constrained nulls. |
| Overlapping image size accounting | Removed per-image virtual-size summation; uses version-tested `LayersSize`, marks image reclaimability unsupported/estimated, adds shared-layer fixtures and precise UI terminology. |
| Alert ordering contradiction | Evaluation now uses validated staged plus transaction-visible prior state before atomic commit; SSE publishes only after commit; JSON evaluates inside its single mutation callback. |
| Multiple pending/buffer ambiguity | Selected exactly one durable pending batch, blocking later windows; outages retain watermark and no drop-oldest path exists. |
| Residual absence resolution | Removed absence-based resolution; only exact remove/destroy or administrative transitions resolve gone containers. |
| Plain PostgreSQL evidence not guaranteed | Added mandatory `postgres:16` CI service/job with exact `VPS_MANAGER_TEST_POSTGRES_URL`; existing Timescale job is separate. |
| Rollup schema/formula mismatch | Expanded migration model/key with instance, cohort, formula version, first/last, gauge/counter aggregates, resets, expected/observed/partial/gaps, cadence segmentation, and arithmetic-average semantics. |
| Installation-state publication ambiguity | Specified create-exclusive temporary file, no-replace final publication, fsync ordering, winner validation, and atomic later replacement. |
| Event window time ambiguity | Defined fixed `agentNow`, `U=agentNow-1s`, Unix fractional timestamp encoding, nanosecond state, and clock-skew behavior. |
| Oversize detection ambiguity | Required limit+1 sentinels for event source, boundary overrun, transmit accounting, and `/system/df`. |
| Missing storage support metadata | Added per-category supported/count fields plus image estimated/reclaimable-supported fields to schema. |
| Missing rate-limit implementation map | Added `server.ts`, `app.ts`, config variables, and focused config/rate-limit/alert tests. |
| Missing state package verification | Focused Go command and file map now include `./internal/state`. |
| Disable policy sequencing | Checkpoint A must settle disable/data policy before cleanup schema and tests are finalized. |
