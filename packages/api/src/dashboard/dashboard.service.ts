import { Inject, Injectable, Optional } from "@nestjs/common";
import { DashboardSettingsService } from "./dashboard-settings.service.js";
import type { AppConfig } from "../config/app-config.js";
import {
  DEMO_BANNER,
  demoAuditEvents,
  demoServers,
  demoTerminal,
  getDemoJobs,
  getDemoMetrics,
} from "../demo/demo-fixtures.js";
import type {
  DashboardDockerMetrics,
  DashboardMetricSample,
  DashboardOverview,
  DashboardSummary,
} from "../dashboard/dashboard.models.js";
import type { VpsRecord } from "../vps/vps.models.js";
import { applyAgentState } from "../vps/vps.models.js";
import {
  deriveHostStatus,
  HOST_FRESHNESS_THRESHOLD_MS,
  isFreshTimestamp as isFreshTimestampShared,
} from "../common/host-health.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { JobRepository } from "../persistence/repositories/job.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { MetricRepository } from "../persistence/repositories/metric.repository.js";
import { withHistory } from "../metrics/metric-history.js";
import type { DockerMonitoringRepository } from "../persistence/repositories/docker-monitoring.repository.js";
import {
  AGENT_REPOSITORY,
  APP_CONFIG,
  DOCKER_MONITORING_REPOSITORY,
  JOB_REPOSITORY,
  METRIC_REPOSITORY,
  VPS_REPOSITORY,
} from "../tokens.js";

const STALE_THRESHOLD_MS = HOST_FRESHNESS_THRESHOLD_MS;

function summarize(
  servers: readonly VpsRecord[],
  runningJobs: number,
): DashboardSummary {
  return {
    totalServers: servers.length,
    healthyServers: servers.filter((server) => server.status === "healthy")
      .length,
    warningServers: servers.filter((server) => server.status === "warning")
      .length,
    unreachableServers: servers.filter(
      (server) => server.status === "unreachable",
    ).length,
    runningJobs,
  };
}

/**
 * Shared-threshold wrapper kept for this module's callers; the threshold and
 * receivedAt-first semantics live in `common/host-health.ts`.
 */
export function isFreshTimestamp(
  timestamp: string,
  thresholdMs = STALE_THRESHOLD_MS,
  now = Date.now(),
): boolean {
  return isFreshTimestampShared(timestamp, thresholdMs, now);
}

export function deriveDockerPresentation(
  metrics: Omit<
    DashboardDockerMetrics,
    "freshness" | "ageSeconds" | "lastUpdatedAt"
  >,
  now = Date.now(),
): DashboardDockerMetrics {
  const received = Date.parse(metrics.receivedAt);
  const ageSeconds = Number.isFinite(received)
    ? Math.max(0, Math.floor((now - received) / 1000))
    : undefined;
  return {
    ...metrics,
    freshness: isFreshTimestampShared(
      metrics.receivedAt,
      STALE_THRESHOLD_MS,
      now,
    )
      ? "fresh"
      : "stale",
    ...(ageSeconds === undefined ? {} : { ageSeconds }),
    lastUpdatedAt: metrics.receivedAt,
  };
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(METRIC_REPOSITORY)
    private readonly metricRepository: MetricRepository,
    @Inject(AGENT_REPOSITORY) private readonly agentRepository: AgentRepository,
    @Inject(JOB_REPOSITORY) private readonly jobRepository: JobRepository,
    @Inject(DOCKER_MONITORING_REPOSITORY)
    private readonly dockerMonitoringRepository: DockerMonitoringRepository,
    @Optional()
    @Inject(DashboardSettingsService)
    private readonly settingsService?: DashboardSettingsService,
  ) {}

  async overview(): Promise<DashboardOverview> {
    if (this.config.mode === "demo") {
      const demoJobs = getDemoJobs();
      const demoMetrics = getDemoMetrics();
      const runningJobs = demoJobs.filter(
        (job) => job.status === "running",
      ).length;
      return {
        mode: "demo",
        banner: DEMO_BANNER,
        summary: summarize(demoServers, runningJobs),
        servers: [...demoServers],
        metrics: [...demoMetrics],
        jobs: [...demoJobs],
        auditEvents: [...demoAuditEvents],
        terminal: demoTerminal,
        settings: {
          appMode: "demo",
          webTerminalEnabled: false,
          realSshEnabled: false,
          authRequiredInLocalMode: true,
        },
        systemInfo: [],
        dockerMetrics: [],
      };
    }

    const servers = await this.vpsRepository.list();
    // Attach persisted agent state so dashboard/snapshot data always exposes
    // the real lifecycle status (not just systemInfo).
    const states = await this.agentRepository.listStates();
    const stateById = new Map(states.map((s) => [s.vpsId, s]));
    const serversWithAgent = servers.map((server) =>
      applyAgentState(
        {
          ...server,
          status: deriveHostStatus(server.status, server.lastSeenAt),
        },
        stateById.get(server.id),
      ),
    );
    const rawMetrics = await this.metricRepository.listLatest();
    const withWindows = await Promise.all(
      rawMetrics.map(async (m) => {
        const window = await this.metricRepository.listWindow(
          m.vpsId,
          this.config.metricWindowLimit,
        );
        return withHistory(m, window, this.config.metricWindowLimit);
      }),
    );
    const metrics: DashboardMetricSample[] = withWindows.map((m) => ({
      ...m,
      freshness: isFreshTimestamp(m.receivedAt ?? m.collectedAt)
        ? "fresh"
        : "stale",
    }));
    const serverIds = new Set(servers.map((s) => s.id));
    const allSystemInfo = await this.agentRepository.listSystemInfo();
    const systemInfo = allSystemInfo.filter((si) => serverIds.has(si.vpsId));
    const jobs = await this.jobRepository.list();

    // Only return Docker metrics for servers with dockerMetricsEnabled === true,
    // sourced from the latest committed snapshot per enabled server.
    const enabledIds = new Set(
      servers.filter((s) => s.dockerMetricsEnabled === true).map((s) => s.id),
    );
    const dockerMetrics = (
      await Promise.all(
        [...enabledIds].map((vpsId) =>
          this.readDockerLatest(vpsId, stateById.get(vpsId)?.version),
        ),
      )
    ).filter((dm): dm is DashboardDockerMetrics => dm !== null);

    return {
      mode: "local",
      summary: summarize(serversWithAgent, 0),
      servers: serversWithAgent,
      metrics,
      jobs,
      auditEvents: [],
      terminal: {
        label: "Terminal",
        networkAccess: "disabled",
        commands: [],
        sessions: [],
      },
      settings: {
        appMode: "local",
        webTerminalEnabled: this.settingsService
          ? await this.settingsService.isWebTerminalEnabled()
          : Boolean(this.config.enableWebTerminal),
        realSshEnabled: true,
        authRequiredInLocalMode: true,
      },
      systemInfo,
      dockerMetrics,
    };
  }

  async updateSettings(input: unknown) {
    if (!this.settingsService) {
      throw new Error("Settings service not configured");
    }
    return this.settingsService.updateSettings(input);
  }

  /**
   * Latest committed Docker snapshot for one VPS, presentation-derived.
   * Returns null when the store has no committed host sample or
   * authoritative latest. Never reads the legacy agent_docker_metrics
   * projection.
   */
  private async readDockerLatest(
    vpsId: string,
    agentVersion: string | undefined,
  ): Promise<DashboardDockerMetrics | null> {
    const [latest, hostPage, containers] = await Promise.all([
      this.dockerMonitoringRepository.getAuthoritativeLatest(vpsId),
      this.dockerMonitoringRepository.listHostSamples({ vpsId, limit: 1 }),
      this.dockerMonitoringRepository.listCurrentContainers(vpsId),
    ]);
    const host = hostPage.data[0];
    if (!host || !latest) return null;

    const m = host.metrics;
    const base: Omit<
      DashboardDockerMetrics,
      "freshness" | "ageSeconds" | "lastUpdatedAt"
    > = {
      vpsId,
      agentInstanceId: host.agentInstanceId,
      snapshotId: host.snapshotId,
      schemaVersion: 2,
      collectedAt: host.collectedAt,
      receivedAt: host.receivedAt,
      effectiveAt: host.effectiveAt,
      ...(agentVersion === undefined ? {} : { agentVersion }),
      sourceSequence: latest.sourceSequence,
      ...(latest.available === undefined ? {} : { available: latest.available }),
      ...(latest.errorCode === undefined ? {} : { errorCode: latest.errorCode }),
      ...(latest.engineVersion === undefined
        ? {}
        : { engineVersion: latest.engineVersion }),
      ...(latest.apiVersion === undefined ? {} : { apiVersion: latest.apiVersion }),
      containerTotal: m.containerTotal ?? 0,
      containerRunning: m.containerRunning ?? 0,
      cpuPercent: m.cpuPercent ?? 0,
      memoryUsageBytes: m.memoryUsageBytes ?? 0,
      ...(typeof m.memoryLimitBytes === "number"
        ? { memoryLimitBytes: m.memoryLimitBytes }
        : {}),
      networkRxBytes: m.networkRxBytes ?? 0,
      networkTxBytes: m.networkTxBytes ?? 0,
      blockReadBytes: m.blockReadBytes ?? 0,
      blockWriteBytes: m.blockWriteBytes ?? 0,
      pids: m.pids ?? 0,
      containers: containers.map((container) => ({
        containerKey: container.containerKey,
        name: container.name ?? container.containerKey,
        state: container.state ?? "",
        cpuPercent: container.metrics.cpuPercent,
        memoryUsageBytes: container.metrics.memoryUsageBytes,
        pids: container.metrics.pids,
        ...(container.image === undefined ? {} : { image: container.image }),
        ...(container.status === undefined ? {} : { status: container.status }),
      })),
    };
    return deriveDockerPresentation(base);
  }
}
