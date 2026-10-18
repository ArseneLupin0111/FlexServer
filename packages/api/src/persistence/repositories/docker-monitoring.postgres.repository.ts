import { withTransaction, type DatabasePool } from "../../db/pool.js";
import {
  assertDockerCursorBinding,
  compareDockerWatermarks,
  decodeDockerCursor,
  encodeDockerCursor,
} from "../../docker/docker-monitoring.schemas.js";
import { DockerIngestConflict } from "../../docker/docker-monitoring.models.js";
import {
  evaluateDockerUnavailable,
  createInitialDockerUnavailableState,
  DOCKER_UNAVAILABLE_RULE_KIND,
  dockerUnavailableFingerprint,
  buildDockerUnavailableSummary,
  evaluateDockerAlert,
  createInitialDockerAlertState,
  DOCKER_ALERT_RULES,
  dockerAlertFingerprint,
  buildDockerAlertSummary,
  type DockerAlertObservation,
  type DockerAlertRuleKind,
  type DockerTypedAlertState,
} from "../../docker/docker-alert-evaluator.js";
import type { DockerContainerDetails } from "../../docker/docker-container-details.js";
import type {
  DockerAlert,
  DockerAlertResolutionReason,
  DockerAuthoritativeLatest,
  DockerContainerSample,
  DockerCurrentContainer,
  DockerCursorPayload,
  DockerEventWatermark,
  DockerHostSample,
  DockerHostSampleCoverage,
  DockerIngestBatch,
  DockerMetricRollup,
  DockerIngestUnit,
  DockerIngestResult,
  DockerOperationalEvent,
  DockerPage,
  DockerStorageCategory,
  DockerStorageLatest,
} from "../../docker/docker-monitoring.models.js";
import type {
  DockerAlertsQuery,
  DockerContainerSamplesQuery,
  DockerEventsQuery,
  DockerHostSamplesQuery,
  DockerMonitoringRepository,
  DockerRollupsQuery,
  DockerMonitoringCleanup,
  DockerMonitoringMaintenanceOptions,
  DockerMonitoringMaintenanceResult,
} from "./docker-monitoring.repository.js";
import { optionalIsoString, requiredIsoString } from "./postgres-mappers.js";

// ── PostgreSQL Docker monitoring repository ───────────────────────────────
// Bounded VPS-scoped keyset reads matching the JSON observable semantics.
// Ingest, cleanup, maintenance, and rollup operations share the repository contract.

type SampleRow = {
  id: string;
  vps_id: string;
  agent_instance_id: string;
  snapshot_id: string;
  container_key: string | null;
  name: string | null;
  state: string | null;
  collected_at: Date | string;
  received_at: Date | string;
  effective_at: Date | string;
  metrics: Record<string, number>;
  coverage: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
};

type RollupRow = {
  id: string;
  vps_id: string;
  agent_instance_id: string;
  scope: DockerMetricRollup["scope"];
  metric_name: string | null;
  container_key: string | null;
  cohort_digest: string | null;
  bucket_start: Date | string;
  formula_version: number;
  first_at: Date | string;
  last_at: Date | string;
  sample_count: number;
  gauge_min: number | null;
  gauge_max: number | null;
  gauge_sum: number | null;
  gauge_average: number | null;
  counter_first: number | null;
  counter_last: number | null;
  counter_increase: number | null;
  reset_count: number;
  expected_samples: number;
  observed_samples: number;
  partial_sample_count: number;
  gap_count: number;
  coverage_ratio: number;
};

type EventRow = {
  id: string;
  vps_id: string;
  agent_instance_id: string;
  container_key: string | null;
  action: DockerOperationalEvent["action"];
  event_occurred_at: Date | string;
  received_at: Date | string;
  event_digest: string;
  context_version: 1;
  health_status: DockerOperationalEvent["healthStatus"] | null;
  exit_code: number | null;
  signal: number | null;
  oom_killed: boolean | null;
};

type StorageRow = {
  vps_id: string;
  agent_instance_id: string;
  snapshot_id: string;
  collected_at: Date | string;
  received_at: Date | string;
  images: DockerStorageCategory;
  containers: DockerStorageCategory;
  local_volumes: DockerStorageCategory;
  build_cache: DockerStorageCategory;
  formula_version: 1;
};

type WatermarkRow = {
  vps_id: string;
  agent_instance_id: string;
  time_nano: string;
  boundary_digests: string[];
  committed_batch_id: string | null;
  updated_at: Date | string;
};

type BatchRow = {
  vps_id: string;
  agent_instance_id: string;
  batch_id: string;
  snapshot_id: string;
  request_digest: string;
  result: string;
};

type AlertRow = {
  id: string;
  vps_id: string;
  agent_instance_id: string | null;
  rule_kind: string;
  container_key: string | null;
  state: DockerAlert["state"];
  fingerprint: string;
  opened_at: Date | string;
  last_observed_at: Date | string | null;
  resolved_at: Date | string | null;
  acknowledged_at: Date | string | null;
  acknowledged_by: string | null;
  occurrences: number;
  summary: string;
  context_version: 1;
  resolution_reason: DockerAlert["resolutionReason"] | null;
};

function rowToHostSample(row: SampleRow): DockerHostSample {
  const coverage = row.coverage;
  const typedCoverage =
    coverage &&
    typeof coverage === "object" &&
    typeof (coverage as Record<string, unknown>).detailsSampled === "number" &&
    typeof (coverage as Record<string, unknown>).detailsTotalEligible ===
      "number" &&
    typeof (coverage as Record<string, unknown>).complete === "boolean"
      ? (coverage as DockerHostSampleCoverage)
      : undefined;
  return {
    id: row.id,
    vpsId: row.vps_id,
    agentInstanceId: row.agent_instance_id,
    snapshotId: row.snapshot_id,
    collectedAt: requiredIsoString(row.collected_at),
    receivedAt: requiredIsoString(row.received_at),
    effectiveAt: requiredIsoString(row.effective_at),
    metrics: row.metrics ?? {},
    ...(typedCoverage ? { coverage: typedCoverage } : {}),
  };
}

function rowToContainerSample(row: SampleRow): DockerContainerSample {
  return {
    ...rowToHostSample(row),
    containerKey: row.container_key!,
    ...(row.name != null ? { name: row.name } : {}),
    ...(row.state != null ? { state: row.state } : {}),
    ...(row.details != null ? { details: row.details as DockerContainerDetails } : {}),
  };
}

function rowToRollup(row: RollupRow): DockerMetricRollup {
  return {
    id: row.id,
    vpsId: row.vps_id,
    agentInstanceId: row.agent_instance_id,
    scope: row.scope,
    ...(row.metric_name != null && row.metric_name !== "legacy"
      ? { metricName: row.metric_name }
      : {}),
    ...(row.container_key != null ? { containerKey: row.container_key } : {}),
    ...(row.cohort_digest != null ? { cohortDigest: row.cohort_digest } : {}),
    bucketStart: requiredIsoString(row.bucket_start),
    formulaVersion: row.formula_version,
    firstAt: requiredIsoString(row.first_at),
    lastAt: requiredIsoString(row.last_at),
    sampleCount: row.sample_count,
    ...(row.gauge_min != null ? { gaugeMin: Number(row.gauge_min) } : {}),
    ...(row.gauge_max != null ? { gaugeMax: Number(row.gauge_max) } : {}),
    ...(row.gauge_sum != null ? { gaugeSum: Number(row.gauge_sum) } : {}),
    ...(row.gauge_average != null
      ? { gaugeAverage: Number(row.gauge_average) }
      : {}),
    ...(row.counter_first != null
      ? { counterFirst: Number(row.counter_first) }
      : {}),
    ...(row.counter_last != null
      ? { counterLast: Number(row.counter_last) }
      : {}),
    ...(row.counter_increase != null
      ? { counterIncrease: Number(row.counter_increase) }
      : {}),
    resetCount: row.reset_count,
    expectedSamples: row.expected_samples,
    observedSamples: row.observed_samples,
    partialSampleCount: row.partial_sample_count,
    gapCount: row.gap_count,
    coverageRatio: Number(row.coverage_ratio),
  };
}

function rowToEvent(row: EventRow): DockerOperationalEvent {
  return {
    id: row.id,
    vpsId: row.vps_id,
    agentInstanceId: row.agent_instance_id,
    ...(row.container_key != null ? { containerKey: row.container_key } : {}),
    action: row.action,
    eventOccurredAt: requiredIsoString(row.event_occurred_at),
    receivedAt: requiredIsoString(row.received_at),
    eventDigest: row.event_digest,
    contextVersion: 1,
    ...(row.health_status != null ? { healthStatus: row.health_status } : {}),
    ...(row.exit_code != null ? { exitCode: row.exit_code } : {}),
    ...(row.signal != null ? { signal: row.signal } : {}),
    ...(row.oom_killed != null ? { oomKilled: row.oom_killed } : {}),
  };
}

function rowToStorage(row: StorageRow): DockerStorageLatest {
  return {
    vpsId: row.vps_id,
    agentInstanceId: row.agent_instance_id,
    snapshotId: row.snapshot_id,
    collectedAt: requiredIsoString(row.collected_at),
    receivedAt: requiredIsoString(row.received_at),
    images: row.images,
    containers: row.containers,
    localVolumes: row.local_volumes,
    buildCache: row.build_cache,
    formulaVersion: 1,
  };
}

function rowToWatermark(row: WatermarkRow): DockerEventWatermark {
  return {
    vpsId: row.vps_id,
    agentInstanceId: row.agent_instance_id,
    timeNano: row.time_nano,
    boundaryDigests: row.boundary_digests ?? [],
    ...(row.committed_batch_id != null
      ? { committedBatchId: row.committed_batch_id }
      : {}),
    updatedAt: requiredIsoString(row.updated_at),
  };
}

function rowToBatch(row: BatchRow): DockerIngestBatch {
  return {
    vpsId: row.vps_id,
    agentInstanceId: row.agent_instance_id,
    batchId: row.batch_id,
    snapshotId: row.snapshot_id,
    requestDigest: row.request_digest,
    result: row.result,
  };
}

function assertMaintenanceOptions(
  options: DockerMonitoringMaintenanceOptions,
): void {
  if (
    typeof options.cutoff !== "string" ||
    Number.isNaN(Date.parse(options.cutoff))
  ) {
    throw new Error(
      "Invalid maintenance cutoff: must be an ISO datetime string",
    );
  }
  for (const key of ["samplesPerVps", "eventsPerVps"] as const) {
    const value = options[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Invalid maintenance option ${key}: must be a non-negative integer`,
      );
    }
  }
}

export type PostgresDockerMonitoringRepository = DockerMonitoringRepository & {
  pruneSamplesEventsAndStorage(
    options: DockerMonitoringMaintenanceOptions,
  ): Promise<DockerMonitoringMaintenanceResult>;
};

function rowToAlert(row: AlertRow): DockerAlert {
  return {
    id: row.id,
    vpsId: row.vps_id,
    ...(row.agent_instance_id != null
      ? { agentInstanceId: row.agent_instance_id }
      : {}),
    ruleKind: row.rule_kind,
    ...(row.container_key != null ? { containerKey: row.container_key } : {}),
    state: row.state,
    fingerprint: row.fingerprint,
    openedAt: requiredIsoString(row.opened_at),
    ...(optionalIsoString(row.last_observed_at) !== undefined
      ? { lastObservedAt: optionalIsoString(row.last_observed_at) }
      : {}),
    ...(optionalIsoString(row.resolved_at) !== undefined
      ? { resolvedAt: optionalIsoString(row.resolved_at) }
      : {}),
    ...(optionalIsoString(row.acknowledged_at) !== undefined
      ? { acknowledgedAt: optionalIsoString(row.acknowledged_at) }
      : {}),
    ...(row.acknowledged_by != null
      ? { acknowledgedBy: row.acknowledged_by }
      : {}),
    ...(row.resolution_reason != null
      ? { resolutionReason: row.resolution_reason }
      : {}),
    occurrences: row.occurrences,
    summary: row.summary,
    contextVersion: 1,
  };
}

export function createPostgresDockerMonitoringRepository(
  pool: DatabasePool,
): PostgresDockerMonitoringRepository {
  return {
    async rollupHostGauges(options) {
      const now = new Date(options.now ?? new Date().toISOString());
      const closed = new Date(now);
      closed.setUTCMinutes(0, 0, 0);
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const result: DockerMetricRollup[] = [];
      const metrics = ["cpuPercent", "memoryUsageBytes"] as const;
      for (const metric of metrics) {
        const rows = await pool.query<{
          agent_instance_id: string;
          bucket_start: Date;
          first_at: Date;
          last_at: Date;
          n: number;
          min: number;
          max: number;
          sum: number;
        }>(
          `SELECT agent_instance_id, date_trunc('hour', effective_at) AS bucket_start, min(effective_at) AS first_at, max(effective_at) AS last_at, count(*)::int AS n, min((metrics->>$2)::double precision) AS min, max((metrics->>$2)::double precision) AS max, sum((metrics->>$2)::double precision) AS sum FROM docker_metric_samples WHERE vps_id=$1 AND container_key IS NULL AND effective_at >= $3 AND effective_at < $4 AND metrics ? $2 GROUP BY agent_instance_id, date_trunc('hour', effective_at)`,
          [options.vpsId, metric, cutoff, closed],
        );
        for (const row of rows.rows) {
          const bucket = row.bucket_start.toISOString();
          const id = `host-gauge-v1:${encodeURIComponent(options.vpsId)}:${encodeURIComponent(row.agent_instance_id)}:${metric}:${bucket}`;
          const n = Number(row.n),
            sum = Number(row.sum);
          const rollup: DockerMetricRollup = {
            id,
            vpsId: options.vpsId,
            agentInstanceId: row.agent_instance_id,
            scope: "host",
            metricName: metric,
            bucketStart: bucket,
            formulaVersion: 1,
            firstAt: row.first_at.toISOString(),
            lastAt: row.last_at.toISOString(),
            sampleCount: n,
            gaugeMin: Number(row.min),
            gaugeMax: Number(row.max),
            gaugeSum: sum,
            gaugeAverage: sum / n,
            resetCount: 0,
            expectedSamples: n,
            observedSamples: n,
            partialSampleCount: 0,
            gapCount: 0,
            coverageRatio: 1,
          };
          await pool.query(
            `INSERT INTO docker_metric_rollups (id,vps_id,agent_instance_id,scope,metric_name,bucket_start,formula_version,first_at,last_at,sample_count,gauge_min,gauge_max,gauge_sum,gauge_average,reset_count,expected_samples,observed_samples,partial_sample_count,gap_count,coverage_ratio) VALUES ($1,$2,$3,'host',$4,$5,1,$6,$7,$8,$9,$10,$11,$12,0,$8,$8,0,0,1) ON CONFLICT (id) DO UPDATE SET metric_name=EXCLUDED.metric_name,gauge_min=EXCLUDED.gauge_min,gauge_max=EXCLUDED.gauge_max,gauge_sum=EXCLUDED.gauge_sum,gauge_average=EXCLUDED.gauge_average,sample_count=EXCLUDED.sample_count,expected_samples=EXCLUDED.expected_samples,observed_samples=EXCLUDED.observed_samples`,
            [
              id,
              options.vpsId,
              row.agent_instance_id,
              metric,
              row.bucket_start,
              row.first_at,
              row.last_at,
              n,
              row.min,
              row.max,
              sum,
              sum / n,
            ],
          );
          result.push(rollup);
        }
      }
      return result;
    },
    async listHostSamples(
      query: DockerHostSamplesQuery,
    ): Promise<DockerPage<DockerHostSample>> {
      const limit = query.limit ?? 100;
      const binding = {
        vpsId: query.vpsId,
        scope: "host" as const,
        filters: { from: query.from, to: query.to },
        order: "effectiveAt,id" as const,
      };
      let last: { at: string; id: string } | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeDockerCursor(query.cursor);
        assertDockerCursorBinding(decoded, binding);
        last = decoded.last;
      }
      const values: unknown[] = [query.vpsId];
      const where: string[] = ["vps_id = $1", "container_key IS NULL"];
      if (query.from !== undefined) {
        values.push(new Date(query.from));
        where.push(`effective_at >= $${values.length}`);
      }
      if (query.to !== undefined) {
        values.push(new Date(query.to));
        where.push(`effective_at <= $${values.length}`);
      }
      if (last !== undefined) {
        values.push(new Date(last.at), last.id);
        where.push(
          `(effective_at < $${values.length - 1} OR (effective_at = $${values.length - 1} AND id < $${values.length}))`,
        );
      }
      values.push(limit + 1);
      const result = await pool.query<SampleRow>(
        `SELECT * FROM docker_metric_samples WHERE ${where.join(" AND ")} ` +
          `ORDER BY effective_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, limit).map(rowToHostSample);
      const hasMore = result.rows.length > limit;
      const tail = rows.length > 0 ? rows[rows.length - 1]! : undefined;
      const cursorPayload = (at: string, id: string): DockerCursorPayload => ({
        v: 1,
        vpsId: query.vpsId,
        scope: "host",
        filters: { from: query.from, to: query.to },
        order: "effectiveAt,id",
        last: { at, id },
      });
      return {
        data: rows,
        page: {
          limit,
          hasMore,
          nextCursor:
            hasMore && tail
              ? encodeDockerCursor(cursorPayload(tail.effectiveAt, tail.id))
              : undefined,
        },
      };
    },

    async listContainerSamples(
      query: DockerContainerSamplesQuery,
    ): Promise<DockerPage<DockerContainerSample>> {
      const limit = query.limit ?? 100;
      const binding = {
        vpsId: query.vpsId,
        scope: "container" as const,
        agentInstanceId: query.agentInstanceId,
        containerKey: query.containerKey,
        filters: { from: query.from, to: query.to },
        order: "effectiveAt,id" as const,
      };
      let last: { at: string; id: string } | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeDockerCursor(query.cursor);
        assertDockerCursorBinding(decoded, binding);
        last = decoded.last;
      }
      const values: unknown[] = [
        query.vpsId,
        query.agentInstanceId,
        query.containerKey,
      ];
      const where: string[] = [
        "vps_id = $1",
        "agent_instance_id = $2",
        "container_key = $3",
      ];
      if (query.from !== undefined) {
        values.push(new Date(query.from));
        where.push(`effective_at >= $${values.length}`);
      }
      if (query.to !== undefined) {
        values.push(new Date(query.to));
        where.push(`effective_at <= $${values.length}`);
      }
      if (last !== undefined) {
        values.push(new Date(last.at), last.id);
        where.push(
          `(effective_at < $${values.length - 1} OR (effective_at = $${values.length - 1} AND id < $${values.length}))`,
        );
      }
      values.push(limit + 1);
      const result = await pool.query<SampleRow>(
        `SELECT * FROM docker_metric_samples WHERE ${where.join(" AND ")} ` +
          `ORDER BY effective_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, limit).map(rowToContainerSample);
      const hasMore = result.rows.length > limit;
      const tail = rows.length > 0 ? rows[rows.length - 1]! : undefined;
      return {
        data: rows,
        page: {
          limit,
          hasMore,
          nextCursor:
            hasMore && tail
              ? encodeDockerCursor({
                  v: 1,
                  vpsId: query.vpsId,
                  scope: "container",
                  agentInstanceId: query.agentInstanceId,
                  containerKey: query.containerKey,
                  filters: { from: query.from, to: query.to },
                  order: "effectiveAt,id",
                  last: { at: tail.effectiveAt, id: tail.id },
                })
              : undefined,
        },
      };
    },

    async getAuthoritativeLatest(
      vpsId: string,
    ): Promise<DockerAuthoritativeLatest | undefined> {
      const result = await pool.query<{
        active_instance_id: string;
        active_snapshot_id: string;
        source_sequence: string;
        available: boolean | null;
        error_code: string | null;
        engine_version: string | null;
        api_version: string | null;
        received_at: Date | string;
        updated_at: Date | string;
        revision: string;
      }>(
        `SELECT active_instance_id,active_snapshot_id,source_sequence,available,error_code,engine_version,api_version,received_at,updated_at,revision FROM docker_ingest_latest WHERE vps_id = $1`,
        [vpsId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        activeInstanceId: row.active_instance_id,
        snapshotId: row.active_snapshot_id,
        sourceSequence: String(row.source_sequence),
        ...(row.available == null ? {} : { available: row.available }),
        ...(row.error_code == null ? {} : { errorCode: row.error_code }),
        ...(row.engine_version == null
          ? {}
          : { engineVersion: row.engine_version }),
        ...(row.api_version == null ? {} : { apiVersion: row.api_version }),
        receivedAt: requiredIsoString(row.received_at),
        updatedAt: requiredIsoString(row.updated_at),
        revision: Number(row.revision),
      };
    },

    async listCurrentContainers(
      vpsId: string,
    ): Promise<DockerCurrentContainer[]> {
      // Latest committed snapshot identity comes from the committed samples
      // themselves: newest-first (effective_at DESC, id DESC), the same
      // recency order every other sample read uses (docker_samples_scope_idx).
      // Ingest-state tables and the legacy agent_docker_metrics projection
      // may be stale for legacy snapshots, so they are never read here.
      const identity = await pool.query<{
        agent_instance_id: string;
        snapshot_id: string;
      }>(
        `SELECT agent_instance_id, snapshot_id FROM docker_metric_samples ` +
          `WHERE vps_id = $1 ORDER BY effective_at DESC, id DESC LIMIT 1`,
        [vpsId],
      );
      const latest = identity.rows[0];
      if (latest === undefined) return [];
      const result = await pool.query<{
        agent_instance_id: string;
        container_key: string;
        name: string | null;
        state: string | null;
        image: string | null;
        status: string | null;
        collected_at: Date | string;
        metrics: { cpuPercent: number; memoryUsageBytes: number; pids: number };
        details: Record<string, unknown> | null;
      }>(
        `SELECT agent_instance_id, container_key, name, state, image, status, collected_at, metrics, details ` +
          `FROM docker_metric_samples WHERE vps_id = $1 ` +
          `AND agent_instance_id = $2 AND snapshot_id = $3 ` +
          `AND container_key IS NOT NULL ORDER BY container_key ASC, id ASC`,
        [vpsId, latest.agent_instance_id, latest.snapshot_id],
      );
      return result.rows.map((row) => ({
        agentInstanceId: row.agent_instance_id,
        containerKey: row.container_key,
        ...(row.name != null ? { name: row.name } : {}),
        ...(row.state != null ? { state: row.state } : {}),
        ...(row.image != null ? { image: row.image } : {}),
        ...(row.status != null ? { status: row.status } : {}),
        collectedAt: requiredIsoString(row.collected_at),
        ...(row.details != null ? { details: row.details as DockerContainerDetails } : {}),
        metrics: {
          cpuPercent: row.metrics.cpuPercent,
          memoryUsageBytes: row.metrics.memoryUsageBytes,
          pids: row.metrics.pids,
        },
      }));
    },

    async listEvents(
      query: DockerEventsQuery,
    ): Promise<DockerPage<DockerOperationalEvent>> {
      const limit = query.limit ?? 50;
      const binding = {
        vpsId: query.vpsId,
        scope: "events" as const,
        agentInstanceId: query.agentInstanceId,
        containerKey: query.containerKey,
        filters: { action: query.action, from: query.from, to: query.to },
        order: "eventOccurredAt,id" as const,
      };
      let last: { at: string; id: string } | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeDockerCursor(query.cursor);
        assertDockerCursorBinding(decoded, binding);
        last = decoded.last;
      }
      const values: unknown[] = [query.vpsId];
      const where: string[] = ["vps_id = $1"];
      if (query.action !== undefined) {
        values.push(query.action);
        where.push(`action = $${values.length}`);
      }
      if (query.agentInstanceId !== undefined) {
        values.push(query.agentInstanceId);
        where.push(`agent_instance_id = $${values.length}`);
      }
      if (query.containerKey !== undefined) {
        values.push(query.containerKey);
        where.push(`container_key = $${values.length}`);
      }
      if (query.from !== undefined) {
        values.push(new Date(query.from));
        where.push(`event_occurred_at >= $${values.length}`);
      }
      if (query.to !== undefined) {
        values.push(new Date(query.to));
        where.push(`event_occurred_at <= $${values.length}`);
      }
      if (last !== undefined) {
        values.push(new Date(last.at), last.id);
        where.push(
          `(event_occurred_at < $${values.length - 1} OR (event_occurred_at = $${values.length - 1} AND id < $${values.length}))`,
        );
      }
      values.push(limit + 1);
      const result = await pool.query<EventRow>(
        `SELECT * FROM docker_operational_events WHERE ${where.join(" AND ")} ` +
          `ORDER BY event_occurred_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, limit).map(rowToEvent);
      const hasMore = result.rows.length > limit;
      const tail = rows.length > 0 ? rows[rows.length - 1]! : undefined;
      return {
        data: rows,
        page: {
          limit,
          hasMore,
          nextCursor:
            hasMore && tail
              ? encodeDockerCursor({
                  v: 1,
                  vpsId: query.vpsId,
                  scope: "events",
                  agentInstanceId: query.agentInstanceId,
                  containerKey: query.containerKey,
                  filters: {
                    action: query.action,
                    from: query.from,
                    to: query.to,
                  },
                  order: "eventOccurredAt,id",
                  last: { at: tail.eventOccurredAt, id: tail.id },
                })
              : undefined,
        },
      };
    },

    async listRollups(
      query: DockerRollupsQuery,
    ): Promise<DockerPage<DockerMetricRollup>> {
      const limit = query.limit ?? 100;
      const binding = {
        vpsId: query.vpsId,
        scope: "rollups" as const,
        agentInstanceId: query.agentInstanceId,
        containerKey: query.containerKey,
        filters: { scope: query.scope, from: query.from, to: query.to },
        order: "bucketStart,id" as const,
      };
      let last: { at: string; id: string } | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeDockerCursor(query.cursor);
        assertDockerCursorBinding(decoded, binding);
        last = decoded.last;
      }
      const values: unknown[] = [query.vpsId];
      const where: string[] = ["vps_id = $1"];
      if (query.agentInstanceId !== undefined) {
        values.push(query.agentInstanceId);
        where.push(`agent_instance_id = $${values.length}`);
      }
      if (query.scope !== undefined) {
        values.push(query.scope);
        where.push(`scope = $${values.length}`);
      }
      if (query.containerKey !== undefined) {
        values.push(query.containerKey);
        where.push(`container_key = $${values.length}`);
      }
      if (query.from !== undefined) {
        values.push(new Date(query.from));
        where.push(`bucket_start >= $${values.length}`);
      }
      if (query.to !== undefined) {
        values.push(new Date(query.to));
        where.push(`bucket_start <= $${values.length}`);
      }
      if (last !== undefined) {
        values.push(new Date(last.at), last.id);
        where.push(
          `(bucket_start < $${values.length - 1} OR (bucket_start = $${values.length - 1} AND id < $${values.length}))`,
        );
      }
      values.push(limit + 1);
      const result = await pool.query<RollupRow>(
        `SELECT * FROM docker_metric_rollups WHERE ${where.join(" AND ")} ` +
          `ORDER BY bucket_start DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, limit).map(rowToRollup);
      const hasMore = result.rows.length > limit;
      const tail = rows.length > 0 ? rows[rows.length - 1]! : undefined;
      return {
        data: rows,
        page: {
          limit,
          hasMore,
          nextCursor:
            hasMore && tail
              ? encodeDockerCursor({
                  v: 1,
                  vpsId: query.vpsId,
                  scope: "rollups",
                  agentInstanceId: query.agentInstanceId,
                  containerKey: query.containerKey,
                  filters: {
                    scope: query.scope,
                    from: query.from,
                    to: query.to,
                  },
                  order: "bucketStart,id",
                  last: { at: tail.bucketStart, id: tail.id },
                })
              : undefined,
        },
      };
    },

    async getStorageLatest(
      vpsId: string,
    ): Promise<DockerStorageLatest | undefined> {
      const result = await pool.query<StorageRow>(
        "SELECT * FROM docker_storage_latest WHERE vps_id = $1",
        [vpsId],
      );
      return result.rows[0] ? rowToStorage(result.rows[0]) : undefined;
    },

    async listAlerts(
      query: DockerAlertsQuery,
    ): Promise<DockerPage<DockerAlert>> {
      const limit = query.limit ?? 50;
      const binding = {
        vpsId: query.vpsId,
        scope: "alerts" as const,
        agentInstanceId: query.agentInstanceId,
        containerKey: query.containerKey,
        filters: {
          state: query.state,
          ruleKind: query.ruleKind,
          from: query.from,
          to: query.to,
        },
        order: "lastObservedAt,id" as const,
      };
      let last: { at: string; id: string } | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeDockerCursor(query.cursor);
        assertDockerCursorBinding(decoded, binding);
        last = decoded.last;
      }
      const values: unknown[] = [query.vpsId];
      const where: string[] = ["vps_id = $1"];
      if (query.state !== undefined) {
        values.push(query.state);
        where.push(`state = $${values.length}`);
      }
      if (query.ruleKind !== undefined) {
        values.push(query.ruleKind);
        where.push(`rule_kind = $${values.length}`);
      }
      if (query.agentInstanceId !== undefined) {
        values.push(query.agentInstanceId);
        where.push(`agent_instance_id = $${values.length}`);
      }
      if (query.containerKey !== undefined) {
        values.push(query.containerKey);
        where.push(`container_key = $${values.length}`);
      }
      if (query.from !== undefined) {
        values.push(new Date(query.from));
        where.push(
          `COALESCE(last_observed_at, opened_at) >= $${values.length}`,
        );
      }
      if (query.to !== undefined) {
        values.push(new Date(query.to));
        where.push(
          `COALESCE(last_observed_at, opened_at) <= $${values.length}`,
        );
      }
      if (last !== undefined) {
        values.push(new Date(last.at), last.id);
        where.push(
          `(COALESCE(last_observed_at, opened_at) < $${values.length - 1} OR ` +
            `(COALESCE(last_observed_at, opened_at) = $${values.length - 1} AND id < $${values.length}))`,
        );
      }
      values.push(limit + 1);
      const result = await pool.query<AlertRow>(
        `SELECT * FROM docker_alerts WHERE ${where.join(" AND ")} ` +
          `ORDER BY COALESCE(last_observed_at, opened_at) DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, limit).map(rowToAlert);
      const hasMore = result.rows.length > limit;
      const tail = rows.length > 0 ? rows[rows.length - 1]! : undefined;
      const tailAt = (a: DockerAlert): string => a.lastObservedAt ?? a.openedAt;
      return {
        data: rows,
        page: {
          limit,
          hasMore,
          nextCursor:
            hasMore && tail
              ? encodeDockerCursor({
                  v: 1,
                  vpsId: query.vpsId,
                  scope: "alerts",
                  agentInstanceId: query.agentInstanceId,
                  containerKey: query.containerKey,
                  filters: {
                    state: query.state,
                    ruleKind: query.ruleKind,
                    from: query.from,
                    to: query.to,
                  },
                  order: "lastObservedAt,id",
                  last: { at: tailAt(tail), id: tail.id },
                })
              : undefined,
        },
      };
    },

    async resolveActiveAlertsForVps(
      vpsId: string,
      reason: DockerAlertResolutionReason,
      resolvedAt: string,
    ) {
      const result = await pool.query(
        `UPDATE docker_alerts
            SET state = 'resolved', resolved_at = $2, resolution_reason = $3
          WHERE vps_id = $1 AND state IN ('open', 'acknowledged')`,
        [vpsId, new Date(resolvedAt), reason],
      );
      return result.rowCount ?? 0;
    },

    async acknowledgeAlert(vpsId, alertId, acknowledgedBy, acknowledgedAt) {
      const result = await pool.query<AlertRow>(
        `UPDATE docker_alerts
            SET state = 'acknowledged', acknowledged_at = $3, acknowledged_by = $4
          WHERE vps_id = $1 AND id = $2 AND state = 'open'
          RETURNING *`,
        [vpsId, alertId, new Date(acknowledgedAt), acknowledgedBy],
      );
      if (result.rows[0])
        return { alert: rowToAlert(result.rows[0]), changed: true };
      const existing = await pool.query(
        "SELECT 1 FROM docker_alerts WHERE vps_id = $1 AND id = $2",
        [vpsId, alertId],
      );
      if (!existing.rows[0]) throw new Error("Docker alert not found");
      const current = await pool.query<AlertRow>(
        "SELECT * FROM docker_alerts WHERE vps_id = $1 AND id = $2",
        [vpsId, alertId],
      );
      return { alert: rowToAlert(current.rows[0]!), changed: false };
    },
    async applyUnavailableObservation(vpsId, agentInstanceId, observation) {
      const current = await pool.query<AlertRow>(
        `SELECT * FROM docker_alerts WHERE vps_id = $1 AND fingerprint = $2 AND state IN ('open','acknowledged') LIMIT 1`,
        [vpsId, `docker_unavailable:v1:${vpsId}`],
      );
      if (observation.availability === "unknown")
        return { transition: "frozen" };
      if (current.rows[0] && observation.availability === "available") {
        const result = await pool.query<AlertRow>(
          `UPDATE docker_alerts SET state='resolved', resolved_at=$3, resolution_reason='condition_cleared', last_observed_at=$3 WHERE vps_id=$1 AND fingerprint=$2 AND state IN ('open','acknowledged') RETURNING *`,
          [
            vpsId,
            `docker_unavailable:v1:${vpsId}`,
            new Date(observation.observedAt),
          ],
        );
        return {
          alert: result.rows[0] ? rowToAlert(result.rows[0]) : undefined,
          transition: "resolved",
        };
      }
      if (current.rows[0] && observation.availability === "unavailable") {
        const result = await pool.query<AlertRow>(
          `UPDATE docker_alerts SET last_observed_at=$3, occurrences=occurrences+1 WHERE vps_id=$1 AND fingerprint=$2 AND state IN ('open','acknowledged') RETURNING *`,
          [
            vpsId,
            `docker_unavailable:v1:${vpsId}`,
            new Date(observation.observedAt),
          ],
        );
        return { alert: rowToAlert(result.rows[0]!), transition: "persisted" };
      }
      return { transition: "no_change" };
    },

    async getWatermark(
      vpsId: string,
      agentInstanceId: string,
    ): Promise<DockerEventWatermark | undefined> {
      const result = await pool.query<WatermarkRow>(
        "SELECT * FROM docker_event_watermarks WHERE vps_id = $1 AND agent_instance_id = $2",
        [vpsId, agentInstanceId],
      );
      return result.rows[0] ? rowToWatermark(result.rows[0]) : undefined;
    },

    async getIngestBatch(
      vpsId: string,
      agentInstanceId: string,
      batchId: string,
    ): Promise<DockerIngestBatch | undefined> {
      const result = await pool.query<BatchRow>(
        "SELECT * FROM docker_ingest_batches WHERE vps_id = $1 AND agent_instance_id = $2 AND batch_id = $3",
        [vpsId, agentInstanceId, batchId],
      );
      return result.rows[0] ? rowToBatch(result.rows[0]) : undefined;
    },

    async ingestUnit(unit: DockerIngestUnit): Promise<DockerIngestResult> {
      return withTransaction(pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [unit.vpsId],
        );
        const priorBatch =
          unit.batchId === undefined
            ? undefined
            : (
                await client.query<BatchRow>(
                  "SELECT * FROM docker_ingest_batches WHERE vps_id=$1 AND agent_instance_id=$2 AND batch_id=$3",
                  [unit.vpsId, unit.agentInstanceId, unit.batchId],
                )
              ).rows[0];
        const snapshot = (
          await client.query<{ request_digest: string; result: DockerIngestResult | string; agent_instance_id: string; source_sequence: string }>(
            "SELECT request_digest,result,agent_instance_id,source_sequence FROM docker_snapshot_ledger WHERE vps_id=$1 AND snapshot_id=$2",
            [unit.vpsId, unit.snapshotId],
          )
        ).rows[0];
        const matchesDigest = (digest: string, original: DockerIngestResult) => {
          if (digest === unit.requestDigest) return true;
          if (!snapshot || snapshot.request_digest !== digest || snapshot.agent_instance_id !== unit.agentInstanceId ||
              snapshot.source_sequence !== unit.sourceSequence ||
              original.vpsId !== unit.vpsId || original.agentInstanceId !== unit.agentInstanceId ||
              original.snapshotId !== unit.snapshotId || original.batchId !== unit.batchId ||
              unit.legacyRequestDigest?.(original.receivedAt) !== digest) return false;
          return !unit.eventProtocol || (original.committedWatermark !== undefined &&
            compareDockerWatermarks(original.committedWatermark, unit.eventProtocol.proposedWatermark) === 0);
        };
        if (priorBatch) {
          const parsed: DockerIngestResult = typeof priorBatch.result === "string"
            ? JSON.parse(priorBatch.result) : priorBatch.result;
          if (priorBatch.snapshot_id !== unit.snapshotId || !matchesDigest(priorBatch.request_digest, parsed))
            throw new DockerIngestConflict("request_digest_mismatch");
          return { ...parsed, ingestStatus: parsed.ingestStatus === "replay_ignored" ? "replay_ignored" : "already_committed" };
        }
        if (snapshot) {
          const parsed = typeof snapshot.result === "string" ? JSON.parse(snapshot.result) as DockerIngestResult : snapshot.result;
          if (!matchesDigest(snapshot.request_digest, parsed))
            throw new DockerIngestConflict("request_digest_mismatch");
          return { ...parsed, ingestStatus: parsed.ingestStatus === "replay_ignored" ? "replay_ignored" : "already_committed" };
        }
        const latest = (
          await client.query<{
            active_instance_id: string;
            source_sequence: string;
            revision: string;
          }>(
            "SELECT active_instance_id,source_sequence,revision FROM docker_ingest_latest WHERE vps_id=$1 FOR UPDATE",
            [unit.vpsId],
          )
        ).rows[0];
        const sourceSequence = unit.sourceSequence;
        const seq = BigInt(sourceSequence);
        if (
          latest &&
          latest.active_instance_id === unit.agentInstanceId &&
          seq < BigInt(latest.source_sequence)
        ) {
          const result: DockerIngestResult = {
            vpsId: unit.vpsId,
            ingestStatus: "replay_ignored",
            snapshotId: unit.snapshotId,
            agentInstanceId: unit.agentInstanceId,
            ...(unit.batchId ? { batchId: unit.batchId } : {}),
            receivedAt: unit.receivedAt,
            ...(unit.eventProtocol
              ? { committedWatermark: unit.eventProtocol.proposedWatermark }
              : {}),
            revision: Number(latest.revision),
          };
          return result;
        }
        if (
          latest &&
          latest.active_instance_id !== unit.agentInstanceId &&
          seq <= BigInt(latest.source_sequence)
        )
          throw new DockerIngestConflict("active_instance_conflict");
        if (unit.eventProtocol) {
          const watermark = (
            await client.query<WatermarkRow>(
              "SELECT * FROM docker_event_watermarks WHERE vps_id=$1 AND agent_instance_id=$2 FOR UPDATE",
              [unit.vpsId, unit.agentInstanceId],
            )
          ).rows[0];
          if (
            watermark &&
            compareDockerWatermarks(
              unit.eventProtocol.fromWatermark,
              rowToWatermark(watermark),
            ) !== 0
          )
            throw new DockerIngestConflict("watermark_conflict");
        }
        const revision = (latest ? BigInt(latest.revision) : 0n) + 1n;
        const received = new Date(unit.receivedAt);
        const priorWatermark = (
          await client.query<WatermarkRow>(
            "SELECT * FROM docker_event_watermarks WHERE vps_id=$1 AND agent_instance_id=$2 FOR UPDATE",
            [unit.vpsId, unit.agentInstanceId],
          )
        ).rows[0];
        if (unit.eventProtocol) {
          if (
            priorWatermark &&
            compareDockerWatermarks(
              unit.eventProtocol.fromWatermark,
              rowToWatermark(priorWatermark),
            ) !== 0
          ) {
            throw new DockerIngestConflict("watermark_conflict");
          }
        }
        if (unit.storageLatest)
          await client.query(
            `INSERT INTO docker_storage_latest (vps_id,agent_instance_id,snapshot_id,collected_at,received_at,images,containers,local_volumes,build_cache,formula_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) ON CONFLICT (vps_id) DO UPDATE SET agent_instance_id=EXCLUDED.agent_instance_id,snapshot_id=EXCLUDED.snapshot_id,collected_at=EXCLUDED.collected_at,received_at=EXCLUDED.received_at,images=EXCLUDED.images,containers=EXCLUDED.containers,local_volumes=EXCLUDED.local_volumes,build_cache=EXCLUDED.build_cache`,
            [
              unit.vpsId,
              unit.agentInstanceId,
              unit.snapshotId,
              new Date(unit.storageLatest.collectedAt),
              received,
              unit.storageLatest.images,
              unit.storageLatest.containers,
              unit.storageLatest.localVolumes,
              unit.storageLatest.buildCache,
            ],
          );
        if (unit.monitoring) {
          const rule = await client.query<{ state: unknown }>(
            "SELECT state FROM docker_alert_rule_states WHERE vps_id=$1 AND rule_kind=$2 FOR UPDATE",
            [unit.vpsId, DOCKER_UNAVAILABLE_RULE_KIND],
          );
          const previous = rule.rows[0]?.state
            ? (rule.rows[0].state as never)
            : createInitialDockerUnavailableState(unit.vpsId);
          const evaluated = evaluateDockerUnavailable(previous, {
            availability: unit.monitoring.availability,
            observedAt: unit.hostSample.collectedAt,
          });
          await client.query(
            "INSERT INTO docker_alert_rule_states (vps_id,rule_kind,state,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (vps_id,rule_kind) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at",
            [
              unit.vpsId,
              DOCKER_UNAVAILABLE_RULE_KIND,
              JSON.stringify(evaluated.next),
              received,
            ],
          );
          const active = evaluated.next.alert;
          const fingerprint = dockerUnavailableFingerprint(unit.vpsId);
          if (active)
            await client.query(
              "INSERT INTO docker_alerts (id,vps_id,agent_instance_id,rule_kind,state,fingerprint,opened_at,last_observed_at,occurrences,summary,context_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,1) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,agent_instance_id=EXCLUDED.agent_instance_id,last_observed_at=EXCLUDED.last_observed_at,occurrences=EXCLUDED.occurrences,summary=EXCLUDED.summary",
              [
                `${unit.vpsId}:${DOCKER_UNAVAILABLE_RULE_KIND}`,
                unit.vpsId,
                unit.agentInstanceId,
                DOCKER_UNAVAILABLE_RULE_KIND,
                active.state,
                fingerprint,
                new Date(active.openedAt),
                active.occurrences,
                buildDockerUnavailableSummary(
                  evaluated.unavailableCount,
                  evaluated.window.length,
                ),
              ],
            );
          else if (evaluated.transition === "resolved")
            await client.query(
              "UPDATE docker_alerts SET state='resolved',resolved_at=$2,resolution_reason='condition_cleared',last_observed_at=$2 WHERE vps_id=$1 AND fingerprint=$3 AND state IN ('open','acknowledged')",
              [unit.vpsId, new Date(unit.hostSample.collectedAt), fingerprint],
            );
        }
        // Evaluate and persist all typed evidence rules inside the same ingest transaction.
        const typedObservations: Array<{
          ruleKind: DockerAlertRuleKind;
          observation: DockerAlertObservation;
          ids: { agentInstanceId?: string; containerKey?: string };
        }> = [];
        for (const sample of unit.containerSamples ?? []) {
          const memoryLimit = sample.metrics.memoryLimitBytes;
          const memoryRatio =
            typeof memoryLimit === "number" && memoryLimit > 0
              ? sample.metrics.memoryUsageBytes / memoryLimit
              : undefined;
          const base = {
            observedAt: sample.collectedAt,
            vpsId: unit.vpsId,
            agentInstanceId: unit.agentInstanceId,
            containerKey: sample.containerKey,
            exactContainer: true,
            coverageComplete: sample.coverage?.complete ?? true,
            health: sample.state as DockerAlertObservation["health"],
          } satisfies DockerAlertObservation;
          for (const ruleKind of [
            "container_unhealthy",
            "container_restart_loop",
            "container_cpu_high",
            "container_memory_high",
          ] as const) {
            typedObservations.push({
              ruleKind,
              ids: {
                agentInstanceId: unit.agentInstanceId,
                containerKey: sample.containerKey,
              },
              observation: {
                ...base,
                cpuRatio: sample.metrics.cpuPercent / 100,
                memoryRatio,
              },
            });
          }
        }
        for (const event of unit.events ?? []) {
          if (!event.containerKey) continue;
          for (const ruleKind of [
            "container_unhealthy",
            "container_restart_loop",
          ] as const)
            typedObservations.push({
              ruleKind,
              ids: {
                agentInstanceId: unit.agentInstanceId,
                containerKey: event.containerKey,
              },
              observation: {
                observedAt: event.eventOccurredAt,
                vpsId: unit.vpsId,
                agentInstanceId: unit.agentInstanceId,
                containerKey: event.containerKey,
                exactContainer: true,
                eventAction: [
                  "create",
                  "start",
                  "restart",
                  "die",
                  "stop",
                  "kill",
                  "destroy",
                  "remove",
                  "health_status",
                ].includes(event.action)
                  ? (event.action as DockerAlertObservation["eventAction"])
                  : undefined,
                health:
                  event.healthStatus === "none"
                    ? undefined
                    : (event.healthStatus as DockerAlertObservation["health"]),
              },
            });
        }
        if (unit.storageLatest) {
          const total =
            unit.storageLatest.images.totalBytes +
            unit.storageLatest.containers.totalBytes +
            unit.storageLatest.localVolumes.totalBytes +
            unit.storageLatest.buildCache.totalBytes;
          const reclaimable =
            (unit.storageLatest.images.reclaimableBytes ?? 0) +
            (unit.storageLatest.containers.reclaimableBytes ?? 0) +
            (unit.storageLatest.localVolumes.reclaimableBytes ?? 0) +
            (unit.storageLatest.buildCache.reclaimableBytes ?? 0);
          typedObservations.push({
            ruleKind: "docker_storage_pressure",
            ids: {},
            observation: {
              observedAt: unit.storageLatest.collectedAt,
              vpsId: unit.vpsId,
              supported: total > 0,
              formulaVersion: 1,
              storageRatio: total > 0 ? reclaimable / total : undefined,
            },
          });
        }
        if (unit.events?.length && unit.eventProtocol)
          typedObservations.push({
            ruleKind: "docker_event_gap",
            ids: { agentInstanceId: unit.agentInstanceId },
            observation: {
              observedAt: unit.receivedAt,
              vpsId: unit.vpsId,
              agentInstanceId: unit.agentInstanceId,
              status: "complete",
              gapFree: true,
            },
          });
        for (const item of typedObservations) {
          const stateKey = `${item.ruleKind}:${item.ids.agentInstanceId ?? "host"}:${item.ids.containerKey ?? "host"}`;
          const row = await client.query<{ state: unknown }>(
            "SELECT state FROM docker_alert_rule_states WHERE vps_id=$1 AND rule_kind=$2 FOR UPDATE",
            [unit.vpsId, stateKey],
          );
          const previous = row.rows[0]?.state
            ? (row.rows[0].state as DockerTypedAlertState)
            : createInitialDockerAlertState(item.ruleKind, {
                vpsId: unit.vpsId,
                ...item.ids,
              });
          const evaluated = evaluateDockerAlert(previous, item.observation);
          await client.query(
            "INSERT INTO docker_alert_rule_states (vps_id,rule_kind,state,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (vps_id,rule_kind) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at",
            [unit.vpsId, stateKey, JSON.stringify(evaluated.next), received],
          );
          const active = evaluated.next.alert;
          const fingerprint = dockerAlertFingerprint(
            unit.vpsId,
            item.ruleKind,
            item.ids.agentInstanceId,
            item.ids.containerKey,
          );
          const alertId = fingerprint;
          if (active)
            await client.query(
              "INSERT INTO docker_alerts (id,vps_id,agent_instance_id,rule_kind,container_key,state,fingerprint,opened_at,last_observed_at,occurrences,summary,context_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,1) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,last_observed_at=EXCLUDED.last_observed_at,occurrences=EXCLUDED.occurrences,summary=EXCLUDED.summary",
              [
                alertId,
                unit.vpsId,
                item.ids.agentInstanceId ?? null,
                item.ruleKind,
                item.ids.containerKey ?? null,
                active.state,
                fingerprint,
                new Date(active.openedAt),
                active.occurrences,
                buildDockerAlertSummary(
                  item.ruleKind,
                  `severity=${DOCKER_ALERT_RULES[item.ruleKind].severity}`,
                ),
              ],
            );
          else if (evaluated.resolution)
            await client.query(
              "UPDATE docker_alerts SET state='resolved',resolved_at=$2,resolution_reason=$3,last_observed_at=$2 WHERE vps_id=$1 AND fingerprint=$4 AND state IN ('open','acknowledged')",
              [
                unit.vpsId,
                new Date(item.observation.observedAt),
                evaluated.resolution,
                fingerprint,
              ],
            );
        }
        await client.query(
          `INSERT INTO docker_metric_samples (id,vps_id,agent_instance_id,snapshot_id,container_key,name,state,collected_at,received_at,effective_at,metrics,coverage) VALUES ($1,$2,$3,$4,NULL,NULL,NULL,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
          [
            unit.hostSample.id,
            unit.vpsId,
            unit.agentInstanceId,
            unit.snapshotId,
            new Date(unit.hostSample.collectedAt),
            received,
            new Date(unit.hostSample.effectiveAt),
            JSON.stringify(unit.hostSample.metrics),
            unit.hostSample.coverage == null
              ? null
              : JSON.stringify(unit.hostSample.coverage),
          ],
        );
        for (const sample of unit.containerSamples ?? [])
          await client.query(
            `INSERT INTO docker_metric_samples (id,vps_id,agent_instance_id,snapshot_id,container_key,name,state,image,status,collected_at,received_at,effective_at,metrics,coverage,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
            [
              sample.id,
              unit.vpsId,
              unit.agentInstanceId,
              unit.snapshotId,
              sample.containerKey,
              sample.name ?? null,
              sample.state ?? null,
              sample.image ?? null,
              sample.status ?? null,
              new Date(sample.collectedAt),
              received,
              new Date(sample.effectiveAt),
              JSON.stringify(sample.metrics),
              sample.coverage == null ? null : JSON.stringify(sample.coverage),
              sample.details == null ? null : JSON.stringify(sample.details),
            ],
          );
        if (unit.eventProtocol)
          await client.query(
            "INSERT INTO docker_event_watermarks (vps_id,agent_instance_id,time_nano,boundary_digests,committed_batch_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (vps_id,agent_instance_id) DO UPDATE SET time_nano=EXCLUDED.time_nano,boundary_digests=EXCLUDED.boundary_digests,committed_batch_id=EXCLUDED.committed_batch_id,updated_at=EXCLUDED.updated_at",
            [
              unit.vpsId,
              unit.agentInstanceId,
              unit.eventProtocol.proposedWatermark.timeNano,
              JSON.stringify(
                unit.eventProtocol.proposedWatermark.boundaryDigests,
              ),
              unit.eventProtocol.proposedWatermark.committedBatchId ??
                unit.batchId ??
                null,
              new Date(unit.eventProtocol.proposedWatermark.updatedAt),
            ],
          );
        for (const event of unit.events ?? [])
          await client.query(
            `INSERT INTO docker_operational_events (id,vps_id,agent_instance_id,container_key,action,event_occurred_at,received_at,event_digest,context_version,health_status,exit_code,signal,oom_killed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
            [
              event.id,
              unit.vpsId,
              unit.agentInstanceId,
              event.containerKey ?? null,
              event.action,
              new Date(event.eventOccurredAt),
              received,
              event.eventDigest,
              event.healthStatus ?? null,
              event.exitCode ?? null,
              event.signal ?? null,
              event.oomKilled ?? null,
            ],
          );
        // docker_ingest_latest.compatibility is NOT NULL jsonb object (migration
        // 014); the domain no longer threads it, so write the constant marker.
        await client.query(
          "INSERT INTO docker_ingest_latest (vps_id,active_instance_id,active_snapshot_id,source_sequence,available,error_code,engine_version,api_version,received_at,updated_at,revision,compatibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) ON CONFLICT (vps_id) DO UPDATE SET active_instance_id=EXCLUDED.active_instance_id,active_snapshot_id=EXCLUDED.active_snapshot_id,source_sequence=EXCLUDED.source_sequence,available=EXCLUDED.available,error_code=EXCLUDED.error_code,engine_version=EXCLUDED.engine_version,api_version=EXCLUDED.api_version,received_at=EXCLUDED.received_at,updated_at=EXCLUDED.updated_at,revision=EXCLUDED.revision,compatibility=EXCLUDED.compatibility",
          [
            unit.vpsId,
            unit.agentInstanceId,
            unit.snapshotId,
            sourceSequence,
            unit.available ?? null,
            unit.errorCode ?? null,
            unit.engineVersion ?? null,
            unit.apiVersion ?? null,
            received,
            revision,
            { latest: true },
          ],
        );
        const result: DockerIngestResult = {
          vpsId: unit.vpsId,
          ingestStatus: "committed",
          snapshotId: unit.snapshotId,
          agentInstanceId: unit.agentInstanceId,
          ...(unit.batchId ? { batchId: unit.batchId } : {}),
          receivedAt: unit.receivedAt,
          ...(unit.eventProtocol
            ? { committedWatermark: unit.eventProtocol.proposedWatermark }
            : {}),
          revision: Number(revision),
        };
        await client.query(
          "INSERT INTO docker_snapshot_ledger (vps_id,snapshot_id,agent_instance_id,request_digest,source_sequence,received_at,result,revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            unit.vpsId,
            unit.snapshotId,
            unit.agentInstanceId,
            unit.requestDigest,
            sourceSequence,
            received,
            result,
            revision,
          ],
        );
        if (unit.batchId)
          await client.query(
            "INSERT INTO docker_ingest_batches (vps_id,agent_instance_id,batch_id,snapshot_id,request_digest,result) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              unit.vpsId,
              unit.agentInstanceId,
              unit.batchId,
              unit.snapshotId,
              unit.requestDigest,
              JSON.stringify(result),
            ],
          );
        return result;
      });
    },

    async pruneSamplesEventsAndStorage(
      options: DockerMonitoringMaintenanceOptions,
    ): Promise<DockerMonitoringMaintenanceResult> {
      assertMaintenanceOptions(options);
      return withTransaction(pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["docker-monitoring-maintenance"],
        );
        const cutoff = new Date(options.cutoff);
        const oldSamples = await client.query(
          "DELETE FROM docker_metric_samples WHERE effective_at < $1",
          [cutoff],
        );
        const overCapSamples = await client.query(
          `DELETE FROM docker_metric_samples AS s USING (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY vps_id ORDER BY effective_at DESC, id DESC
               ) AS rn
               FROM docker_metric_samples WHERE effective_at >= $1
             ) ranked WHERE rn > $2
           ) AS overcap WHERE s.id = overcap.id`,
          [cutoff, options.samplesPerVps],
        );
        const rollupCutoff = new Date(options.rollupCutoff ?? options.cutoff);
        const alertCutoff = new Date(options.alertCutoff ?? options.cutoff);
        const oldRollups = await client.query(
          "DELETE FROM docker_metric_rollups WHERE bucket_start < $1",
          [rollupCutoff],
        );
        const oldEvents = await client.query(
          "DELETE FROM docker_operational_events WHERE event_occurred_at < $1",
          [cutoff],
        );
        const oldAlerts = await client.query(
          "DELETE FROM docker_alerts WHERE state = 'resolved' AND resolved_at < $1",
          [alertCutoff],
        );
        const overCapEvents = await client.query(
          `DELETE FROM docker_operational_events AS e USING (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY vps_id ORDER BY event_occurred_at DESC, id DESC
               ) AS rn
               FROM docker_operational_events WHERE event_occurred_at >= $1
             ) ranked WHERE rn > $2
           ) AS overcap WHERE e.id = overcap.id`,
          [cutoff, options.eventsPerVps],
        );
        // Latest state (docker_storage_latest, docker_ingest_latest, watermarks,
        // ledgers, batches, rollups, alerts) is authoritative, not history;
        // preserve it.
        return {
          samplesRemoved:
            (oldSamples.rowCount ?? 0) + (overCapSamples.rowCount ?? 0),
          rollupsRemoved: oldRollups.rowCount ?? 0,
          eventsRemoved:
            (oldEvents.rowCount ?? 0) + (overCapEvents.rowCount ?? 0),
          alertsRemoved: oldAlerts.rowCount ?? 0,
          storageMode: "postgres",
        };
      });
    },

    async cleanupForVps(cleanup: DockerMonitoringCleanup): Promise<void> {
      await withTransaction(pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [cleanup.vpsId],
        );
        for (const table of [
          "docker_metric_samples",
          "docker_metric_rollups",
          "docker_operational_events",
          "docker_storage_latest",
          "docker_event_watermarks",
          "docker_ingest_batches",
          "docker_snapshot_ledger",
          "docker_ingest_batch_results",
          "docker_ingest_latest",
          "docker_alerts",
          "docker_alert_rule_states",
        ])
          await client.query(`DELETE FROM ${table} WHERE vps_id=$1`, [
            cleanup.vpsId,
          ]);
      });
    },
  };
}
