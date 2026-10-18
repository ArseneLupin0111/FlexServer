import {
  BadRequestException,
  ConflictException,
  Injectable,
  Inject,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { VpsNotFoundError } from "../common/errors.js";
import { createHash } from "node:crypto";
import type { AgentDockerMetricsInput } from "../agents/agent.models.js";
import {
  DockerIngestCapacityRefused,
  DockerIngestConflict,
  type DockerAlertResolutionReason,
  type DockerIngestUnit,
} from "./docker-monitoring.models.js";
import {
  DOCKER_INGEST_DIGEST_VERSION,
  DOCKER_INGEST_LEGACY_DIGEST_VERSION,
  dockerIngestRequestDigest,
} from "./docker-monitoring.schemas.js";
import { ZodError } from "zod";
import {
  DOCKER_MONITORING_CAPS,
  type DockerMonitoringMaintenanceResult,
  type DockerMonitoringRepository,
} from "../persistence/repositories/docker-monitoring.repository.js";
import { APP_CONFIG, DOCKER_MONITORING_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { VPS_REPOSITORY } from "../tokens.js";
import { DockerActivityService } from "./docker-activity.service.js";
import { AuditService } from "../audit/audit.service.js";

import {
  dockerHostHistoryQuerySchema,
  dockerContainerHistoryQuerySchema,
  dockerEventsQuerySchema,
  dockerAlertsQuerySchema,
  dockerRollupsQuerySchema,
  type DockerHostHistoryQuery,
  type DockerContainerHistoryQuery,
  type DockerEventsQuery,
  type DockerAlertsQuery,
  type DockerRollupsQuery,
  normalizeDockerDateRange,
} from "./docker-monitoring.schemas.js";

@Injectable()
export class DockerMonitoringService {
  constructor(
    @Inject(DOCKER_MONITORING_REPOSITORY)
    private readonly repository: DockerMonitoringRepository,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
    @Optional() private readonly activity?: DockerActivityService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  private async verify(vpsId: string) {
    if (!(await this.vps.get(vpsId))) throw new VpsNotFoundError();
  }

  private toBadRequest(error: unknown): never {
    if (error instanceof ZodError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (
      /cursor/i.test(message) ||
      /malformed/i.test(message) ||
      /mismatch/i.test(message) ||
      /unsupported cursor/i.test(message) ||
      /bad charset/i.test(message)
    ) {
      throw new BadRequestException({ error: { message: "Invalid cursor" } });
    }
    throw error;
  }

  async resolveActiveAlertsForVps(
    vpsId: string,
    reason: DockerAlertResolutionReason,
    resolvedAt: string = new Date().toISOString(),
  ) {
    await this.verify(vpsId);
    return this.repository.resolveActiveAlertsForVps(vpsId, reason, resolvedAt);
  }

  async cleanupForVps(
    vpsId: string,
    reason:
      | "monitoring_disabled"
      | "vps_deleted"
      | "identity_reset_orphaned" = "monitoring_disabled",
  ) {
    await this.verify(vpsId);
    return this.repository.cleanupForVps({ vpsId, reason });
  }

  async ingest(
    vpsId: string,
    input: AgentDockerMetricsInput,
    receivedAt: string,
  ) {
    await this.verify(vpsId);
    const stable = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const sourceSequence = input.sourceSequence;
    const hostMetrics = {
      containerTotal: input.containerTotal,
      containerRunning: input.containerRunning,
      cpuPercent: input.cpuPercent,
      memoryUsageBytes: input.memoryUsageBytes,
      ...(input.memoryLimitBytes === undefined
        ? {}
        : { memoryLimitBytes: input.memoryLimitBytes }),
      networkRxBytes: input.networkRxBytes,
      networkTxBytes: input.networkTxBytes,
      blockReadBytes: input.blockReadBytes,
      blockWriteBytes: input.blockWriteBytes,
      pids: input.pids,
      ...(input.sampledContainerAggregate === undefined
        ? {}
        : {
            sampledContainerAggregateCpuPercent:
              input.sampledContainerAggregate.cpuPercent,
            sampledContainerAggregateMemoryUsageBytes:
              input.sampledContainerAggregate.memoryUsageBytes,
            sampledContainerAggregateNetworkRxBytes:
              input.sampledContainerAggregate.networkRxBytes,
            sampledContainerAggregateNetworkTxBytes:
              input.sampledContainerAggregate.networkTxBytes,
            sampledContainerAggregateBlockReadBytes:
              input.sampledContainerAggregate.blockReadBytes,
            sampledContainerAggregateBlockWriteBytes:
              input.sampledContainerAggregate.blockWriteBytes,
            sampledContainerAggregatePids: input.sampledContainerAggregate.pids,
          }),
    };
    const hostSample = {
      id: stable([
        vpsId,
        input.agentInstanceId,
        input.snapshotId,
        input.collectedAt,
        hostMetrics,
        input.sampledContainerAggregate?.coverage,
      ]),
      vpsId,
      agentInstanceId: input.agentInstanceId,
      snapshotId: input.snapshotId,
      collectedAt: input.collectedAt,
      receivedAt,
      effectiveAt: input.collectedAt,
      metrics: hostMetrics,
      ...(input.sampledContainerAggregate === undefined
        ? {}
        : { coverage: input.sampledContainerAggregate.coverage }),
    };
    const containerSamples = input.containers.map((c) => ({
      id: stable([
        vpsId,
        input.agentInstanceId,
        input.snapshotId,
        input.collectedAt,
        c.containerKey,
        c.cpuPercent,
        c.memoryUsageBytes,
        c.networkRxBytes,
        c.networkTxBytes,
        c.blockReadBytes,
        c.blockWriteBytes,
        c.pids,
      ]),
      vpsId,
      agentInstanceId: input.agentInstanceId,
      snapshotId: input.snapshotId,
      collectedAt: input.collectedAt,
      receivedAt,
      effectiveAt: input.collectedAt,
      containerKey: c.containerKey,
      name: c.name,
      image: c.image,
      status: c.status,
      state: c.state,
      metrics: {
        cpuPercent: c.cpuPercent,
        memoryUsageBytes: c.memoryUsageBytes,
        ...(c.memoryLimitBytes === undefined
          ? {}
          : { memoryLimitBytes: c.memoryLimitBytes }),
        networkRxBytes: c.networkRxBytes,
        networkTxBytes: c.networkTxBytes,
        blockReadBytes: c.blockReadBytes,
        blockWriteBytes: c.blockWriteBytes,
        pids: c.pids,
      },
      ...(c.details === undefined ? {} : { details: c.details }),
    }));
    const events = input.events?.map((e, i) => ({
      ...e.context,
      id: stable([
        vpsId,
        input.agentInstanceId,
        e.eventOccurredAt,
        e.action,
        e.containerKey,
        i,
      ]),
      vpsId,
      agentInstanceId: input.agentInstanceId,
      containerKey: e.containerKey,
      action: e.action,
      eventOccurredAt: e.eventOccurredAt,
      receivedAt,
      eventDigest: stable([
        e.eventOccurredAt,
        e.action,
        e.containerKey,
        e.context,
      ]),
      contextVersion: 1 as const,
      sourceSequence,
    }));
    const from = input.fromWatermark ?? { timeNano: "0", boundaryDigests: [] };
    const to = input.proposedWatermark ?? {
      timeNano: sourceSequence,
      boundaryDigests: [],
    };
    const hasEventProtocol =
      input.batchId !== undefined ||
      input.events !== undefined ||
      input.eventWindow !== undefined ||
      input.fromWatermark !== undefined ||
      input.proposedWatermark !== undefined;
    // Keep the v1 projection and sample IDs intact for already committed ledgers.
    const digestContainers = containerSamples.map(
      ({ name: _name, image: _image, status: _status, ...sample }) => sample,
    );
    const digestProjection = {
      vpsId,
      agentInstanceId: input.agentInstanceId,
      snapshotId: input.snapshotId,
      batchId: input.batchId,
      collectedAt: input.collectedAt,
      sourceSequence,
      hostMetrics,
      containers: digestContainers,
      events,
      storage: input.storage,
      ...(input.monitoring === undefined ? {} : { monitoring: input.monitoring }),
    };
    const unit: DockerIngestUnit = {
      vpsId,
      agentInstanceId: input.agentInstanceId,
      snapshotId: input.snapshotId,
      batchId: input.batchId,
      requestDigest: dockerIngestRequestDigest({
        ...digestProjection,
        containers: digestContainers.map(({ receivedAt: _receivedAt, ...sample }) => sample),
        events: events?.map(({ receivedAt: _receivedAt, ...event }) => event),
        ...(hasEventProtocol ? { eventProtocol: {
          fromWatermark: from,
          proposedWatermark: to,
          eventWindow: { from: input.eventWindow?.since ?? from.timeNano, to: input.eventWindow?.until ?? to.timeNano },
        } } : {}),
        available: input.available,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.engineVersion === undefined ? {} : { engineVersion: input.engineVersion }),
        ...(input.apiVersion === undefined ? {} : { apiVersion: input.apiVersion }),
      }),
      legacyRequestDigest: (originalReceivedAt) => dockerIngestRequestDigest({
        ...digestProjection,
        containers: digestContainers.map((sample) => ({ ...sample, receivedAt: originalReceivedAt })),
        events: events?.map((event) => ({ ...event, receivedAt: originalReceivedAt })),
      }, DOCKER_INGEST_LEGACY_DIGEST_VERSION),
      requestDigestVersion: DOCKER_INGEST_DIGEST_VERSION,
      receivedAt,
      sourceSequence,
      hostSample,
      containerSamples,
      events,
      storageLatest: input.storage
        ? {
            ...input.storage,
            vpsId,
            agentInstanceId: input.agentInstanceId,
            snapshotId: input.snapshotId,
            collectedAt: input.collectedAt,
            receivedAt,
          }
        : undefined,
      ...(hasEventProtocol
        ? {
            eventProtocol: {
              fromWatermark: {
                ...from,
                vpsId,
                agentInstanceId: input.agentInstanceId,
                updatedAt: receivedAt,
              },
              proposedWatermark: {
                ...to,
                vpsId,
                agentInstanceId: input.agentInstanceId,
                updatedAt: receivedAt,
              },
              eventWindow: {
                from: input.eventWindow?.since ?? from.timeNano,
                to: input.eventWindow?.until ?? to.timeNano,
              },
            },
          }
        : {}),
      available: input.available,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.engineVersion === undefined
        ? {}
        : { engineVersion: input.engineVersion }),
      ...(input.apiVersion === undefined ? {} : { apiVersion: input.apiVersion }),
      ...(input.monitoring === undefined
        ? {}
        : { monitoring: { ...input.monitoring } }),
    };
    try {
      const result = await this.repository.ingestUnit(unit);
      if (result.ingestStatus === "rejected") {
        throw new ConflictException({
          error: {
            message: "Docker ingest history capacity refused",
            code: result.status ?? "history_capacity_refused",
            retryable: true,
          },
        });
      }
      if (unit.events?.length)
        this.activity?.publish({
          type: "docker.events.available",
          vpsId,
          newestEventId: unit.events[unit.events.length - 1]?.id,
          countHint: unit.events.length,
        });
      if (unit.monitoring?.availability === "unavailable")
        this.activity?.publish({
          type: "docker.alerts.updated",
          vpsId,
          changedAlertIds: [],
          refreshRequired: true,
        });
      return result;
    } catch (error) {
      if (error instanceof DockerIngestCapacityRefused)
        throw new ConflictException({
          error: { message: error.message, code: error.code, retryable: true },
        });
      if (error instanceof DockerIngestConflict)
        throw new ConflictException({
          error: { message: "Docker ingest conflict", code: error.code },
        });
      throw error;
    }
  }

  async hostHistory(
    input: Omit<DockerHostHistoryQuery, "vpsId"> & { vpsId: string },
  ) {
    await this.verify(input.vpsId);
    const parsed = dockerHostHistoryQuerySchema.parse(input);
    const query = normalizeDockerDateRange(parsed);
    try {
      return await this.repository.listHostSamples(query);
    } catch (error) {
      this.toBadRequest(error);
    }
  }
  async containerHistory(
    input: Omit<DockerContainerHistoryQuery, "vpsId"> & { vpsId: string },
  ) {
    await this.verify(input.vpsId);
    const parsed = dockerContainerHistoryQuerySchema.parse(input);
    const query = normalizeDockerDateRange(parsed);
    try {
      return await this.repository.listContainerSamples(query);
    } catch (error) {
      this.toBadRequest(error);
    }
  }
  async currentContainers(vpsId: string) {
    await this.verify(vpsId);
    return this.repository.listCurrentContainers(vpsId);
  }
  async events(input: Omit<DockerEventsQuery, "vpsId"> & { vpsId: string }) {
    await this.verify(input.vpsId);
    const parsed = dockerEventsQuerySchema.parse(input);
    const query = normalizeDockerDateRange(parsed);
    try {
      return await this.repository.listEvents(query);
    } catch (error) {
      this.toBadRequest(error);
    }
  }
  async storage(vpsId: string) {
    await this.verify(vpsId);
    return this.repository.getStorageLatest(vpsId);
  }
  async rollups(input: Omit<DockerRollupsQuery, "vpsId"> & { vpsId: string }) {
    await this.verify(input.vpsId);
    const parsed = dockerRollupsQuerySchema.parse(input);
    const query = normalizeDockerDateRange(parsed);
    try {
      return await this.repository.listRollups(query);
    } catch (error) {
      this.toBadRequest(error);
    }
  }
  async alerts(input: Omit<DockerAlertsQuery, "vpsId"> & { vpsId: string }) {
    await this.verify(input.vpsId);
    const parsed = dockerAlertsQuerySchema.parse(input);
    const query = normalizeDockerDateRange(parsed);
    try {
      return await this.repository.listAlerts(query);
    } catch (error) {
      this.toBadRequest(error);
    }
  }
  async acknowledge(
    vpsId: string,
    alertId: string,
    actor = "dashboard",
    metadata?: Record<string, unknown>,
  ) {
    await this.verify(vpsId);
    try {
      const result = await this.repository.acknowledgeAlert(
        vpsId,
        alertId,
        actor,
        new Date().toISOString(),
      );
      if (result.changed) {
        await this.audit?.record({
          actor,
          action: "docker.alert.acknowledged",
          resourceType: "docker_alert",
          resourceId: alertId,
          result: "success",
          metadata: {
            vpsId,
            alertId,
            ruleKind: result.alert.ruleKind,
            ...(metadata?.requestId === undefined
              ? {}
              : { requestId: metadata.requestId }),
          },
        });
        this.activity?.publish({
          type: "docker.alerts.updated",
          vpsId,
          changedAlertIds: [alertId],
        });
      }
      return result.alert;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Docker alert not found"
      ) {
        throw new NotFoundException({
          error: { message: "Docker alert not found" },
        });
      }
      throw error;
    }
  }

  /**
   * Bounded retention maintenance slice: strict cutoff derived from validated
   * config retention days, per-VPS newest-first caps, delegates to the
   * repository's existing JSON/Postgres prune. No scheduler, rollup pruning,
   * alerts, SSE, or migrations here.
   */
  async runMaintenance(
    now?: string,
  ): Promise<DockerMonitoringMaintenanceResult> {
    const prune = this.repository.pruneSamplesEventsAndStorage;
    if (typeof prune !== "function")
      return { samplesRemoved: 0, eventsRemoved: 0 };
    const nowMs = now === undefined ? Date.now() : Date.parse(now);
    if (Number.isNaN(nowMs))
      throw new Error(
        "Invalid maintenance now: must be an ISO datetime string",
      );
    const retentionDays = this.config?.dockerRetentionDays ?? 7;
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 90
    ) {
      throw new Error(
        "Invalid maintenance retention days: must be an integer 1..90",
      );
    }
    const cutoff = new Date(
      nowMs - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rollupRetentionDays = this.config?.dockerRollupRetentionDays ?? 30;
    const alertRetentionDays =
      this.config?.dockerResolvedAlertRetentionDays ?? 30;
    if (
      !Number.isInteger(rollupRetentionDays) ||
      rollupRetentionDays < 1 ||
      rollupRetentionDays > 365 ||
      !Number.isInteger(alertRetentionDays) ||
      alertRetentionDays < 1 ||
      alertRetentionDays > 365
    )
      throw new Error("Invalid rollup or resolved alert retention days");
    const rollupCutoff = new Date(
      nowMs - rollupRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const alertCutoff = new Date(
      nowMs - alertRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const samplesPerVps = Math.min(
      this.config?.dockerMaintenanceSamplesPerVps ??
        DOCKER_MONITORING_CAPS.samplesPerVps,
      DOCKER_MONITORING_CAPS.samplesPerVps,
    );
    const eventsPerVps = Math.min(
      this.config?.dockerMaintenanceEventsPerVps ??
        DOCKER_MONITORING_CAPS.eventsPerVps,
      DOCKER_MONITORING_CAPS.eventsPerVps,
    );
    if (!Number.isInteger(samplesPerVps) || samplesPerVps < 0) {
      throw new Error(
        "Invalid maintenance option samplesPerVps: must be a non-negative integer",
      );
    }
    if (!Number.isInteger(eventsPerVps) || eventsPerVps < 0) {
      throw new Error(
        "Invalid maintenance option eventsPerVps: must be a non-negative integer",
      );
    }
    const startedAt = Date.now();
    const result = await prune.call(this.repository, {
      cutoff,
      rollupCutoff,
      alertCutoff,
      samplesPerVps,
      eventsPerVps,
    });
    return {
      samplesRemoved: result.samplesRemoved,
      ...(result.rollupsRemoved !== undefined
        ? { rollupsRemoved: result.rollupsRemoved }
        : {}),
      eventsRemoved: result.eventsRemoved,
      ...(result.alertsRemoved !== undefined
        ? { alertsRemoved: result.alertsRemoved }
        : {}),
      ...(result.storageMode ? { storageMode: result.storageMode } : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
      pass: { retentionDays, samplesPerVps, eventsPerVps },
    };
  }
}
