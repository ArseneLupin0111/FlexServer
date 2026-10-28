import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Response } from "express";
import { nanoid } from "nanoid";
import type { AppConfig } from "../config/app-config.js";
import { DashboardService } from "../dashboard/dashboard.service.js";
import { demoServers, getDemoMetrics } from "../demo/demo-fixtures.js";
import type { AuditEvent } from "../audit/audit.models.js";
import type {
  DashboardDockerMetrics,
  DashboardJob,
  DashboardMetricSample,
  DashboardOverview,
} from "../dashboard/dashboard.models.js";
import type { MetricSample } from "../metrics/metrics.models.js";
import type { VpsRecord } from "../vps/vps.models.js";
import type { MetricRepository } from "../persistence/repositories/metric.repository.js";
import { MetricService } from "../metrics/metric.service.js";
import { JobService } from "../jobs/job.service.js";
import {
  JobActivityService,
  type JobActivityListener,
} from "../jobs/job-activity.service.js";
import { APP_CONFIG, METRIC_REPOSITORY } from "../tokens.js";
import { DockerActivityService, DockerInvalidationCoalescer } from "../docker/docker-activity.service.js";
import {
  HOST_FRESHNESS_THRESHOLD_MS,
  isFreshTimestamp as isFreshTimestampShared,
} from "../common/host-health.js";

// ── Event envelope types ──────────────────────────────────────────────

type MonitoringEnvelope<TType extends string, TPayload> = {
  schemaVersion: 1;
  type: TType;
  id: string;
  emittedAt: string;
  payload: TPayload;
};

type HelloPayload = { mode: "demo" | "local"; intervalMs: number };
type SnapshotPayload = {
  overview: DashboardOverview;
  servers: VpsRecord[];
  jobs: DashboardJob[];
  metrics: DashboardMetricSample[];
  auditEvents: AuditEvent[];
  dockerMetrics: DashboardDockerMetrics[];
};
type MetricsUpdatedPayload = {
  metrics: DashboardMetricSample[];
  systemInfo?: DashboardOverview["systemInfo"];
  dockerMetrics?: DashboardDockerMetrics[];
  servers?: VpsRecord[];
};
type JobsUpdatedPayload = {
  jobs: DashboardJob[];
};
type HeartbeatPayload = Record<string, never>;
type ErrorPayload = { message: string };

// ── Demo metric generator ─────────────────────────────────────────────

type MetricState = {
  cpu: number;
  memory: number;
  disk: number;
  loadAverage: number;
  networkRx: number;
  networkTx: number;
  uptime: number;
  trendPoints: number[];
};

function gaussianNoise(): number {
  // Box-Muller transform — small jitter
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createMetricState(base: MetricSample): MetricState {
  const cpu = base.cpu;
  const memory = base.memory;
  const disk = base.disk;
  return {
    cpu,
    memory,
    disk,
    loadAverage: base.loadAverage,
    networkRx: base.networkRx,
    networkTx: base.networkTx,
    uptime: base.uptime,
    trendPoints: base.trend?.points ?? [cpu],
  };
}

function evolveMetric(state: MetricState, isStale: boolean): MetricState {
  if (isStale) {
    // Stale: keep zero-ish values, don't change
    return { ...state, uptime: 0 };
  }
  const step = () => clamp(gaussianNoise() * 2.5, -4, 4);
  const nextCpu = clamp(Math.round(state.cpu + step()), 0, 100);
  const nextMem = clamp(Math.round(state.memory + step()), 0, 100);
  const nextDisk = clamp(Math.round(state.disk + step() * 0.3), 0, 100);
  const nextLoad = clamp(
    Math.round((state.loadAverage + gaussianNoise() * 0.15) * 100) / 100,
    0,
    8,
  );
  const nextRx = Math.max(
    0,
    Math.round(state.networkRx + gaussianNoise() * 8000),
  );
  const nextTx = Math.max(
    0,
    Math.round(state.networkTx + gaussianNoise() * 5000),
  );
  const nextUptime = state.uptime + 1; // seconds

  // Roll trend: keep at most 60 points, remove oldest
  const nextPoints = [...state.trendPoints, nextCpu].slice(-60);

  return {
    cpu: nextCpu,
    memory: nextMem,
    disk: nextDisk,
    loadAverage: nextLoad,
    networkRx: nextRx,
    networkTx: nextTx,
    uptime: nextUptime,
    trendPoints: nextPoints,
  };
}

function stateToMetricSample(
  vpsId: string,
  state: MetricState,
  isStale: boolean,
  trendRange: string,
): DashboardMetricSample {
  const now = new Date().toISOString();
  const points = state.trendPoints;
  const min = Math.min(...points);
  const max = Math.max(...points);
  return {
    vpsId,
    cpu: state.cpu,
    memory: state.memory,
    disk: state.disk,
    loadAverage: state.loadAverage,
    networkRx: state.networkRx,
    networkTx: state.networkTx,
    uptime: state.uptime,
    collectedAt: now,
    freshness: isStale ? "stale" : "fresh",
    trend: {
      range: trendRange,
      points,
      min,
      max,
      threshold: 90,
      unit: "cpu",
    },
  };
}

// ── SSE helper ────────────────────────────────────────────────────────

const SSE_FRAME_MAX_BYTES = 32 * 1024;
const SSE_REPLAY_MAX_EVENTS = 100;
let nextSseEventId = 1;
const replayBuffer: Array<{ id: number; frame: string }> = [];

function sendEvent(res: Response, type: string, data: unknown): void {
  const eventId = nextSseEventId++;
  const envelope: MonitoringEnvelope<string, unknown> = {
    schemaVersion: 1,
    type,
    id: String(eventId),
    emittedAt: new Date().toISOString(),
    payload: data,
  };
  const frame = (payload: unknown) => {
    const value = JSON.stringify({ ...envelope, payload });
    return `id: ${envelope.id}\nevent: ${type}\ndata: ${value}\n\n`;
  };
  let output = frame(data);
  if (Buffer.byteLength(output, "utf8") > SSE_FRAME_MAX_BYTES) {
    output = frame({ refreshRequired: true });
  }
  // Keep the write boundary itself bounded; callers treat a failed write as teardown.
  if (Buffer.byteLength(output, "utf8") > SSE_FRAME_MAX_BYTES) {
    throw new Error("SSE frame exceeds bounded write size");
  }
  replayBuffer.push({ id: eventId, frame: output });
  if (replayBuffer.length > SSE_REPLAY_MAX_EVENTS) replayBuffer.shift();
  res.write(output);
}

function replaySince(res: Response, cursor: string | undefined): boolean {
  if (!cursor) return false;
  if (!/^\d+$/.test(cursor)) return false;
  const id = Number(cursor);
  const oldest = replayBuffer[0]?.id;
  if (!oldest || id < oldest - 1 || id >= nextSseEventId) return false;
  for (const event of replayBuffer) if (event.id > id) res.write(event.frame);
  return true;
}

// ── Freshness helpers ─────────────────────────────────────────────────
// Agent metrics prefer receivedAt (server clock) over collectedAt (VPS clock)
// since VPS clocks may be skewed.

/** 2 minutes in ms — samples older than this are considered stale. */
export const STALE_THRESHOLD_MS = HOST_FRESHNESS_THRESHOLD_MS;

/**
 * Shared-threshold wrapper; the canonical implementation and receivedAt-first
 * semantics live in `common/host-health.ts`.
 */
export function isFreshTimestamp(
  timestamp: string,
  thresholdMs = STALE_THRESHOLD_MS,
  now = Date.now(),
): boolean {
  return isFreshTimestampShared(timestamp, thresholdMs, now);
}

// ── Job change tracking per SSE stream ────────────────────────────────
//
// A stream keeps its own buffered view of changed jobs. Raw activity events
// can arrive several times per second (every progress step), so we coalesce
// them with a short trailing debounce and emit at most one `jobs.updated`
// event per flush containing only the jobs that actually changed. Unchanged
// jobs are never re-emitted (deduplication), and heartbeat/metrics cadence
// is untouched.

const JOB_EVENT_DEBOUNCE_MS = 150;

type JobStreamTracker = { flush: () => void; teardown: () => void };

type DockerStreamTracker = { teardown: () => void };

function createDockerStreamTracker(
  res: Response,
  activity: DockerActivityService,
  scope?: { vpsId: string },
): DockerStreamTracker {
  const coalescer = new DockerInvalidationCoalescer(scope);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const flush = () => {
    timer = null;
    if (closed) return;
    const payload = coalescer.flush();
    if (!payload) return;
    try {
      if (scope) {
        for (const event of payload.events) sendEvent(res, "docker.events.available", event);
        for (const alert of payload.alerts) sendEvent(res, "docker.alerts.updated", alert);
        if (payload.refreshRequired && !payload.events.length && !payload.alerts.length) {
          sendEvent(res, "docker.alerts.updated", { vpsId: scope.vpsId, changedAlertIds: [], refreshRequired: true });
        }
      } else {
        // Global streams receive invalidation-only data; clients refresh scoped state.
        sendEvent(res, "docker.invalidation", {
          vpsIds: payload.vpsIds,
          refreshRequired: payload.refreshRequired,
        });
      }
    } catch { teardown(); }
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 25); };
  const unsubscribe = activity.subscribe((event) => { if (!closed) { coalescer.add(event); schedule(); } });
  const teardown = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    coalescer.teardown();
    unsubscribe();
  };
  return { teardown };
}

function createJobStreamTracker(
  res: Response,
  activity: JobActivityService,
  scope?: { vpsId: string },
): JobStreamTracker {
  const pending = new Map<string, DashboardJob>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let unsubscribed = false;
  let removeSubscription: (() => void) | null = null;

  const teardown = () => {
    if (closed) return;
    closed = true;
    pending.clear();
    if (timer) { clearTimeout(timer); timer = null; }
    if (!unsubscribed) { unsubscribed = true; removeSubscription?.(); removeSubscription = null; }
  };

  const flush = () => {
    timer = null;
    if (closed || pending.size === 0) return;
    const jobs = [...pending.values()];
    pending.clear();
    try {
      sendEvent(res, "jobs.updated", { jobs });
    } catch {
      teardown();
    }
  };

  const scheduleFlush = () => {
    if (timer || closed) return;
    timer = setTimeout(flush, JOB_EVENT_DEBOUNCE_MS);
  };

  const listener: JobActivityListener = (job) => {
    if (closed) return;
    if (scope && job.vpsId !== scope.vpsId) return;
    pending.set(job.id, { ...job, progress: job.progress ?? 0 });
    scheduleFlush();
  };

  removeSubscription = activity.subscribe(listener);
  return { flush, teardown };
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly intervalMs: number;
  private readonly staleThresholdMs = HOST_FRESHNESS_THRESHOLD_MS;

  // Demo state
  private demoStates: Map<string, MetricState> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DashboardService)
    private readonly dashboardService: DashboardService,
    @Inject(MetricService) private readonly metricService: MetricService,
    @Inject(METRIC_REPOSITORY)
    private readonly metricRepository: MetricRepository,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(JobActivityService) private readonly jobActivity: JobActivityService,
    @Optional() @Inject(DockerActivityService) private readonly dockerActivity?: DockerActivityService,
  ) {
    this.intervalMs = this.config.mode === "demo" ? 1_500 : 5_000;
  }

  /**
   * Stream SSE events to the given response. Blocks until the client disconnects.
   */
  async stream(res: Response, lastEventId?: string): Promise<void> {
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    // Flush headers
    res.flushHeaders();

    // Replay retained events when the cursor is valid and retained; otherwise the
    // normal hello/snapshot path below provides an authoritative fallback.
    const replayed = replaySince(res, lastEventId);

    // Subscribe to job activity so `jobs.updated` events stream live progress.
    const jobTracker = createJobStreamTracker(res, this.jobActivity);
    const dockerTracker = this.dockerActivity ? createDockerStreamTracker(res, this.dockerActivity) : null;
    res.once("close", () => { jobTracker.teardown(); dockerTracker?.teardown(); });
    res.once("finish", () => { jobTracker.teardown(); dockerTracker?.teardown(); });
    res.once("error", () => { jobTracker.teardown(); dockerTracker?.teardown(); });

    try {
      // Replay retained events; otherwise send an authoritative hello and snapshot.
      if (!replayed) {
        sendEvent(res, "monitoring.hello", {
        mode: this.config.mode,
        intervalMs: this.intervalMs,
      });
      const overview = await this.dashboardService.overview();
      const snapshotPayload: SnapshotPayload = {
        overview,
        servers: overview.servers,
        jobs: overview.jobs,
        metrics: overview.metrics,
        auditEvents: overview.auditEvents,
        dockerMetrics: overview.dockerMetrics,
      };
      sendEvent(res, "monitoring.snapshot", snapshotPayload);
      }
    } catch {
      jobTracker.teardown();
      dockerTracker?.teardown();
      if (!res.writableEnded) res.end();
      return;
    }

    // Periodic metrics + heartbeat
    if (this.config.mode === "demo") {
      await this.streamDemoLoop(res);
    } else {
      await this.streamLocalLoop(res);
    }
  }

  private async streamDemoLoop(res: Response): Promise<void> {
    // Initialise demo metric state from fixtures
    if (!this.demoStates) {
      const fixtures = getDemoMetrics();
      this.demoStates = new Map(
        fixtures.map((m) => [m.vpsId, createMetricState(m)]),
      );
    }

    // Discover stale VPS IDs from the demo fixture status
    const staleIds = new Set(
      demoServers.filter((s) => s.status === "unreachable").map((s) => s.id),
    );

    const interval = setInterval(() => {
      if (res.destroyed) {
        clearInterval(interval);
        return;
      }

      try {
        // Evolve each metric state
        for (const [vpsId, state] of this.demoStates!) {
          const isStale = staleIds.has(vpsId);
          this.demoStates!.set(vpsId, evolveMetric(state, isStale));
        }

        // Build updated metrics array
        const metrics: DashboardMetricSample[] = [];
        for (const [vpsId, state] of this.demoStates!) {
          const isStale = staleIds.has(vpsId);
          metrics.push(stateToMetricSample(vpsId, state, isStale, "~1m"));
        }

        // Send metrics.updated
        sendEvent(res, "metrics.updated", { metrics, dockerMetrics: [] });

        // Send heartbeat every ~3 ticks
        if (Math.random() < 0.3) {
          sendEvent(res, "monitoring.heartbeat", {});
        }
      } catch {
        // If write fails, client likely disconnected — stop interval
        clearInterval(interval);
      }
    }, this.intervalMs);

    // Cleanup on disconnect
    res.on("close", () => {
      clearInterval(interval);
    });

    // Keep alive — prevent proxy timeout
    const keepAlive = setInterval(() => {
      if (res.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      res.write(": keepalive\n\n");
    }, 15_000);

    res.on("close", () => {
      clearInterval(keepAlive);
    });
  }

  private async streamLocalLoop(res: Response): Promise<void> {
    // Authoritative Docker state is tracked independently of host-metric
    // volume so a present/changed snapshot (including []) is still emitted
    // when ordinary host metrics are empty.
    let lastDockerJson: string | undefined;
    let lastAgentStatusJson: string | undefined;
    let isFirstTick = true;
    let inFlight = false;
    const interval = setInterval(async () => {
      if (res.destroyed || inFlight) {
        if (res.destroyed) clearInterval(interval);
        return;
      }
      inFlight = true;

      try {
        // Re-fetch current metrics from the repository
        const metrics = await this.metricService.list();
        const updatedMetrics: DashboardMetricSample[] = metrics.map((m) => ({
          ...m,
          freshness: isFreshTimestamp(
            m.receivedAt ?? m.collectedAt,
            this.staleThresholdMs,
          )
            ? "fresh"
            : "stale",
        }));

        const overview = await this.dashboardService.overview();
        const dockerMetrics = overview.dockerMetrics ?? [];
        const dockerJson = JSON.stringify(dockerMetrics);
        const agentStatusJson = JSON.stringify(overview.servers.map((server) => [server.id, server.agentStatus, server.lastAgentInstallJobId, server.agentLastError]));
        const agentStatusChanged = agentStatusJson !== lastAgentStatusJson;
        const dockerChanged = dockerJson !== lastDockerJson;
        if (updatedMetrics.length > 0 || isFirstTick || dockerChanged || agentStatusChanged) {
          sendEvent(res, "metrics.updated", {
            metrics: updatedMetrics,
            systemInfo: overview.systemInfo,
            dockerMetrics,
            ...(agentStatusChanged ? { servers: overview.servers } : {}),
          });
          lastDockerJson = dockerJson;
          lastAgentStatusJson = agentStatusJson;
        }

        sendEvent(res, "monitoring.heartbeat", {});
      } catch {
        clearInterval(interval);
      } finally {
        inFlight = false;
      }
    }, this.intervalMs);

    res.on("close", () => {
      clearInterval(interval);
    });

    const keepAlive = setInterval(() => {
      if (res.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      res.write(": keepalive\n\n");
    }, 15_000);

    res.on("close", () => {
      clearInterval(keepAlive);
    });
  }

  /**
   * Stream SSE events scoped to a single VPS.
   * The caller (controller) must validate VPS existence before calling this.
   */
  async streamForVps(res: Response, vpsId: string, lastEventId?: string): Promise<void> {
    // Resolve and validate scope before committing an SSE response.
    const overview = await this.dashboardService.overview();
    const vps = overview.servers.find((s) => s.id === vpsId);
    if (!vps) {
      if (!res.headersSent) res.status(404).json({ error: { message: "VPS not found" } });
      return;
    }
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    // Subscribe to job activity scoped to this VPS.
    const jobTracker = createJobStreamTracker(res, this.jobActivity, {
      vpsId,
    });
    const dockerTracker = this.dockerActivity ? createDockerStreamTracker(res, this.dockerActivity, { vpsId }) : null;
    res.once("close", () => { jobTracker.teardown(); dockerTracker?.teardown(); });
    res.once("finish", () => { jobTracker.teardown(); dockerTracker?.teardown(); });
    res.once("error", () => { jobTracker.teardown(); dockerTracker?.teardown(); });

    try {
      // Hello + initial scoped snapshot must complete before loops are added.
      sendEvent(res, "monitoring.hello", {
        mode: this.config.mode,
        intervalMs: this.intervalMs,
      });

      // Build and send filtered snapshot from the prevalidated overview.
      const filteredMetrics = overview.metrics.filter((m) => m.vpsId === vpsId);
      const filteredJobs = overview.jobs.filter((j) => j.vpsId === vpsId);
      const vpsJobIds = new Set(filteredJobs.map((j) => j.id));
      const filteredAudit = overview.auditEvents.filter(
        (e) =>
          e.resourceId === vpsId ||
          (e.jobId != null && vpsJobIds.has(e.jobId)) ||
          (e.resourceId != null && vpsJobIds.has(e.resourceId)) ||
          e.serverLabel === vps.name,
      );
      const filteredSystemInfo = (overview.systemInfo ?? []).filter(
        (s) => s.vpsId === vpsId,
      );
      const filteredDockerMetrics = (overview.dockerMetrics ?? []).filter(
        (d) => d.vpsId === vpsId,
      );

      const filteredOverview: DashboardOverview = {
        ...overview,
        summary: {
          totalServers: 1,
          healthyServers: vps.status === "healthy" ? 1 : 0,
          warningServers: vps.status === "warning" ? 1 : 0,
          unreachableServers: vps.status === "unreachable" ? 1 : 0,
          runningJobs: filteredJobs.filter((j) => j.status === "running").length,
        },
        servers: [vps],
        metrics: filteredMetrics,
        jobs: filteredJobs,
        auditEvents: filteredAudit,
        systemInfo: filteredSystemInfo,
        dockerMetrics: filteredDockerMetrics,
      };

      const snapshotPayload: SnapshotPayload = {
        overview: filteredOverview,
        servers: [vps],
        jobs: filteredJobs,
        metrics: filteredMetrics,
        auditEvents: filteredAudit,
        dockerMetrics: filteredDockerMetrics,
      };
      sendEvent(res, "monitoring.snapshot", snapshotPayload);
    } catch {
      jobTracker.teardown();
      dockerTracker?.teardown();
      if (!res.writableEnded) res.end();
      return;
    }

    // Periodic filtered metrics
    if (this.config.mode === "demo") {
      await this.streamDemoLoopScoped(res, vpsId);
    } else {
      await this.streamLocalLoopScoped(res, vpsId);
    }
  }

  private async streamDemoLoopScoped(
    res: Response,
    vpsId: string,
  ): Promise<void> {
    // Initialise demo metric state from fixtures
    const fixtures = getDemoMetrics().filter((m) => m.vpsId === vpsId);
    if (fixtures.length === 0) {
      this.logger.warn(`No demo metrics found for VPS ${vpsId}`);
      res.end();
      return;
    }

    const state = createMetricState(fixtures[0]);
    const staleIds = new Set(
      demoServers.filter((s) => s.status === "unreachable").map((s) => s.id),
    );
    const isStale = staleIds.has(vpsId);

    const interval = setInterval(() => {
      if (res.destroyed) {
        clearInterval(interval);
        return;
      }

      try {
        const nextState = evolveMetric(state, isStale);
        Object.assign(state, nextState);

        const metric = stateToMetricSample(vpsId, state, isStale, "~1m");
        sendEvent(res, "metrics.updated", {
          metrics: [metric],
          dockerMetrics: [],
        });

        if (Math.random() < 0.3) {
          sendEvent(res, "monitoring.heartbeat", {});
        }
      } catch {
        clearInterval(interval);
      }
    }, this.intervalMs);

    res.on("close", () => {
      clearInterval(interval);
    });

    const keepAlive = setInterval(() => {
      if (res.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      res.write(": keepalive\n\n");
    }, 15_000);

    res.on("close", () => {
      clearInterval(keepAlive);
    });
  }

  private async streamLocalLoopScoped(
    res: Response,
    vpsId: string,
  ): Promise<void> {
    // Scoped Docker state follows the same independent rule as the global
    // loop, but filtering stays strictly scoped so another VPS never leaks.
    let lastDockerJson: string | undefined;
    let isFirstTick = true;
    let inFlight = false;
    const interval = setInterval(async () => {
      if (res.destroyed || inFlight) {
        if (res.destroyed) clearInterval(interval);
        return;
      }
      inFlight = true;

      try {
        const metrics = await this.metricService.list(vpsId);
        const updatedMetrics: DashboardMetricSample[] = metrics.map((m) => ({
          ...m,
          freshness: isFreshTimestamp(
            m.receivedAt ?? m.collectedAt,
            this.staleThresholdMs,
          )
            ? "fresh"
            : "stale",
        }));

        const overview = await this.dashboardService.overview();
        if (!overview.servers.some((server) => server.id === vpsId)) {
          clearInterval(interval);
          res.end();
          return;
        }
        const filteredSystemInfo = (overview.systemInfo ?? []).filter(
          (s) => s.vpsId === vpsId,
        );
        const filteredDockerMetrics = (overview.dockerMetrics ?? []).filter(
          (d) => d.vpsId === vpsId,
        );
        const dockerJson = JSON.stringify(filteredDockerMetrics);
        const dockerChanged = dockerJson !== lastDockerJson;
        if (updatedMetrics.length > 0 || isFirstTick || dockerChanged) {
          sendEvent(res, "metrics.updated", {
            metrics: updatedMetrics,
            systemInfo: filteredSystemInfo,
            dockerMetrics: filteredDockerMetrics,
          });
          lastDockerJson = dockerJson;
        }
        isFirstTick = false;

        sendEvent(res, "monitoring.heartbeat", {});
      } catch {
        clearInterval(interval);
      } finally {
        inFlight = false;
      }
    }, this.intervalMs);

    res.on("close", () => {
      clearInterval(interval);
    });

    const keepAlive = setInterval(() => {
      if (res.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      res.write(": keepalive\n\n");
    }, 15_000);

    res.on("close", () => {
      clearInterval(keepAlive);
    });
  }
}
