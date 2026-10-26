import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool } from "pg";
import type { AppConfig } from "../config/app-config.js";
import type { FleetRepository } from "../persistence/repositories/fleet.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import type { MetricRepository } from "../persistence/repositories/metric.repository.js";
import type { AuditService } from "../audit/audit.service.js";
import type { SshService } from "../ssh/ssh.service.js";
import type { KeyService } from "../ssh/keyService.js";
import { withFileLock } from "../persistence/repositories/json-file.js";
import type {
  FleetGroup,
  FleetHost,
  FleetHostStatus,
  FleetMaintenanceWindow,
  FleetManifestEnvelope,
  FleetNotification,
  FleetOverviewResponse,
  FleetPolicy,
  FleetRelease,
  FleetRollout,
  FleetRolloutHost,
} from "./fleet.models.js";
import { verifyFleetManifest } from "./fleet-manifest.verifier.js";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

const ADVISORY_LOCK_ID = 99283741;
const CANARY_OBSERVATION_MS = 5 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function lookupPolicy(
  policies: Map<string, FleetPolicy> | Record<string, FleetPolicy>,
  vpsId: string,
): FleetPolicy | undefined {
  if (policies instanceof Map) {
    return policies.get(vpsId);
  }
  return policies[vpsId];
}

function policyValues(
  policies: Map<string, FleetPolicy> | Record<string, FleetPolicy>,
): FleetPolicy[] {
  if (policies instanceof Map) {
    return Array.from(policies.values());
  }
  return Object.values(policies);
}

export interface FleetServiceDependencies {
  config: AppConfig;
  fleetRepository: FleetRepository;
  vpsRepository: VpsRepository;
  agentRepository: AgentRepository;
  aiRepository?: AiRepository;
  metricRepository?: MetricRepository;
  pool?: Pool;
  clock?: () => number;
}

export class FleetService {
  private readonly config: AppConfig;
  private readonly fleetRepo: FleetRepository;
  private readonly vpsRepo: VpsRepository;
  private readonly agentRepo: AgentRepository;
  private readonly aiRepo?: AiRepository;
  private readonly metricRepo?: MetricRepository;
  private readonly pool?: Pool;
  private readonly getNow: () => number;

  constructor(deps: FleetServiceDependencies) {
    this.config = deps.config;
    this.fleetRepo = deps.fleetRepository;
    this.vpsRepo = deps.vpsRepository;
    this.agentRepo = deps.agentRepository;
    this.aiRepo = deps.aiRepository;
    this.metricRepo = deps.metricRepository;

    let pool = deps.pool;
    if (!pool && deps.fleetRepository && typeof deps.fleetRepository === "object" && "pool" in deps.fleetRepository) {
      const repoWithPool = deps.fleetRepository as { pool?: unknown };
      if (repoWithPool.pool && typeof repoWithPool.pool === "object") {
        pool = repoWithPool.pool as Pool;
      }
    }
    this.pool = pool;

    this.getNow = deps.clock ?? (() => Date.now());
  }

  /** Signed AI releases dashboard. Host health is real agent state only:
   * online = agent state fresh (5 min), ai = live AI capability record; a
   * host without a fresh agent heartbeat or without AI evidence fails closed
   * (status "offline" / "ai_unhealthy") — never fabricated from updater
   * heartbeats. */
  async getOverview(): Promise<FleetOverviewResponse> {
    const [releases, rollouts, notifications] = await Promise.all([
      this.fleetRepo.listReleases(),
      this.fleetRepo.listRollouts(),
      this.fleetRepo.listNotifications(100),
    ]);
    await this.fleetRepo.pruneNotifications(NINETY_DAYS_MS);

    const latestRelease = releases[0];
    const activeRollout = rollouts.find(
      (r) => r.state === "running" || r.state === "pending",
    );
    const rolloutHostByVps = new Map(
      activeRollout?.hosts.map((h) => [h.vpsId, h]) ?? [],
    );

    const now = this.getNow();
    const hosts: FleetHost[] = [];
    const vpsList = await this.vpsRepo.list().catch(() => []);
    const stateByVps = new Map(
      (await this.agentRepo.listStates().catch(() => [])).map((s) => [s.vpsId, s]),
    );
    for (const vps of vpsList) {
      const agentState = stateByVps.get(vps.id);
      const lastSeenMs = agentState?.lastSeenAt
        ? new Date(agentState.lastSeenAt).getTime()
        : 0;
      const online =
        agentState?.status === "online" && now - lastSeenMs <= 5 * 60 * 1000;
      const rh = rolloutHostByVps.get(vps.id);

      let status: FleetHostStatus = "idle";
      if (rh) {
        status = rh.state as FleetHostStatus;
      } else if (!online) {
        status = "offline";
      } else {
        const capability = this.aiRepo
          ? await this.aiRepo.getAiCapability(vps.id).catch(() => undefined)
          : undefined;
        if (capability && capability.supported && capability.freshness) {
          status =
            now - new Date(capability.freshness).getTime() <= 15 * 60 * 1000
              ? "idle"
              : "ai_stale";
        } else {
          status = "ai_unhealthy";
        }
      }

      hosts.push({
        vpsId: vps.id,
        name: vps.name,
        online,
        installedBuildId: agentState?.buildId ?? null,
        targetReleaseId: latestRelease?.id ?? null,
        policy: { mode: "auto", group: "Default" },
        enrolled: true,
        setupRequired: false,
        status,
        lastSeenAt: agentState?.lastSeenAt ?? null,
      });
    }

    return {
      hosts,
      groups: [{ name: "Default" }],
      releases,
      rollouts,
      notifications,
    };
  }


  async createRollout(params: {
    releaseId: string;
    group?: string;
    vpsIds?: string[];
    confirmed?: boolean;
    irreversibleConsent?: boolean;
  }): Promise<FleetRollout> {
    const release = await this.fleetRepo.getRelease(params.releaseId);
    if (!release) {
      throw new NotFoundException(`Release not found: ${params.releaseId}`);
    }

    const hasAgentComponent =
      release.components?.some((c) => c === "agent") ||
      release.artifacts?.some((a) => a.component === "agent");
    if (hasAgentComponent) {
      throw new BadRequestException(
        "Rollouts for agent or updater components are rejected; agent updates are not automatic. Use the per-host installer.",
      );
    }

    if (release.rollbackSafe === false && !params.irreversibleConsent) {
      throw new BadRequestException(
        "Release is irreversible (rollbackSafe=false). Explicit irreversibleConsent: true is required.",
      );
    }

    const now = this.getNow();
    const nowIso = new Date(now).toISOString();

    const activeRollout = await this.fleetRepo.getActiveRollout();
    if (activeRollout && (activeRollout.state === "running" || activeRollout.state === "pending")) {
      throw new ConflictException(
        `Another rollout is currently active: ${activeRollout.id}`,
      );
    }

    let targetVpsIds: string[] = [];
    if (params.vpsIds && params.vpsIds.length > 0) {
      targetVpsIds = params.vpsIds;
    } else {
      const allHosts = await this.vpsRepo.list();
      const group = params.group ?? "Default";
      const policies = await this.fleetRepo.listPolicies();
      targetVpsIds = allHosts
        .filter((h) => {
          const pol = lookupPolicy(policies, h.id);
          return (!pol && group === "Default") || pol?.group === group;
        })
        .map((h) => h.id);
    }

    const rolloutHosts: FleetRolloutHost[] = targetVpsIds.map((vpsId) => ({
      vpsId,
      state: "queued",
      updatedAt: nowIso,
    }));

    const rollout: FleetRollout = {
      id: randomUUID(),
      releaseId: params.releaseId,
      state: "pending",
      group: params.group ?? "Default",
      createdAt: nowIso,
      updatedAt: nowIso,
      hosts: rolloutHosts,
    };

    await this.fleetRepo.createRollout(rollout);
    await this.fleetRepo.addNotification({
      kind: "info",
      message: `Rollout ${rollout.id} created for release ${release.version} with ${rolloutHosts.length} hosts`,
    });

    await this.tick(now);
    return (await this.fleetRepo.getRollout(rollout.id)) ?? rollout;
  }

  async controlRollout(
    rolloutId: string,
    action: "pause" | "resume" | "retry",
  ): Promise<FleetRollout> {
    const rollout = await this.fleetRepo.getRollout(rolloutId);
    if (!rollout) {
      throw new NotFoundException(`Rollout not found: ${rolloutId}`);
    }

    const now = this.getNow();
    const nowIso = new Date(now).toISOString();

    if (action === "pause") {
      rollout.state = "paused";
      rollout.reason = "Manually paused";
      rollout.updatedAt = nowIso;
    } else if (action === "resume" || action === "retry") {
      for (const h of rollout.hosts) {
        if (
          (action === "retry" && (h.state === "failed" || h.state === "rolled_back")) ||
          (action === "resume" && h.state === "failed" && h.reason?.startsWith("Paused:"))
        ) {
          h.state = "queued";
          h.jobId = undefined;
          h.reason = undefined;
          h.updatedAt = nowIso;
        }
      }
      rollout.state = "running";
      rollout.reason = undefined;
      rollout.updatedAt = nowIso;
    }

    await this.fleetRepo.updateRollout(rollout);
    await this.fleetRepo.addNotification({
      kind: "info",
      message: `Rollout ${rollout.id} action: ${action}`,
    });

    await this.tick(now);
    return rollout;
  }

  async importRelease(
    envelope: FleetManifestEnvelope,
  ): Promise<FleetRelease> {
    const verified = verifyFleetManifest(
      envelope,
      this.config.fleet?.publicKeyFile ?? "",
    );

    const hasAi = verified.artifacts.some((a) => a.component.startsWith("ai-"));
    if (!hasAi) {
      throw new BadRequestException(
        "External agent target manifests are no longer imported. Agent updates are not automatic; only signed AI runtime manifests are supported. Install agents via the per-host installer.",
      );
    }

    const existing = await this.fleetRepo.getRelease(verified.releaseId);
    if (existing) {
      return existing;
    }

    const release: FleetRelease = {
      id: verified.releaseId,
      version: verified.version,
      buildId: verified.buildId,
      publishedAt: verified.publishedAt,
      channel: verified.channel,
      rollbackSafe: verified.rollbackSafe,
      ...(verified.minUpdaterVersion ? { minUpdaterVersion: verified.minUpdaterVersion } : {}),
      upgradeFrom: verified.upgradeFrom,
      components: Array.from(new Set(verified.artifacts.map((a) => a.component))),
      artifacts: verified.artifacts,
      ai: verified.ai,
      rawPayload: envelope.payload,
      signature: envelope.signature,
      keyId: envelope.keyId,
      createdAt: new Date(this.getNow()).toISOString(),
    };

    await this.fleetRepo.upsertRelease(release);
    await this.fleetRepo.addNotification({
      kind: "info",
      message: `Signed release ${release.version} (${release.id.slice(0, 8)}) imported`,
    });

    await this.tick(this.getNow());
    return release;
  }


  async tick(nowMs?: number): Promise<void> {
    const now = nowMs ?? this.getNow();

    await this.withTickLock(async () => {
      await this.executeTick(now);
    });
  }

  private async withTickLock(fn: () => Promise<void>): Promise<void> {
    if (this.pool) {
      let client;
      try {
        client = await this.pool.connect();
      } catch {
        return;
      }
      try {
        const res = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) as locked",
          [ADVISORY_LOCK_ID],
        );
        if (!res.rows[0]?.locked) {
          return;
        }
        try {
          await fn();
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]).catch(() => undefined);
        }
      } finally {
        client.release();
      }
    } else {
      await withFileLock(
        join(this.config.dataDir, "fleet-orchestrator.lock"),
        fn,
      );
    }
  }

  private async executeTick(now: number): Promise<void> {
    await this.fleetRepo.pruneNotifications(NINETY_DAYS_MS);

    const activeRollout = await this.fleetRepo.getActiveRollout();
    if (activeRollout && (activeRollout.state === "running" || activeRollout.state === "pending")) {
      if (activeRollout.state === "pending") {
        activeRollout.state = "running";
        activeRollout.updatedAt = new Date(now).toISOString();
        await this.fleetRepo.updateRollout(activeRollout);
      }
      await this.reconcileRollout(activeRollout, now);
      return;
    }

  }

  private async reconcileRollout(
    rollout: FleetRollout,
    now: number,
  ): Promise<void> {
    const release = await this.fleetRepo.getRelease(rollout.releaseId);
    if (!release) return;

    const policies = await this.fleetRepo.listPolicies();
    let hasFailure = false;
    let failureReason = "";

    for (const rh of rollout.hosts) {
      const vps = await this.vpsRepo.get(rh.vpsId);
      if (!vps) continue;

      const pol = lookupPolicy(policies, rh.vpsId);
      const agentState = await this.agentRepo.getState(rh.vpsId);

      const lastSeenMs = agentState?.lastSeenAt
        ? new Date(agentState.lastSeenAt).getTime()
        : 0;
      const isOnline = agentState?.status === "online" && (now - lastSeenMs <= 5 * 60 * 1000);

      if (rh.state === "queued" && rh.jobId) {
        // Local upgrade job records were part of the retired updater
        // channel; staged-but-never-claimed queued hosts simply go failed —
        // agent installs are per-host explicit, not dispatched from here.
        rh.state = "failed";
        rh.reason = "queued host never claimed an agent update job";
        rh.updatedAt = new Date(now).toISOString();
        continue;
      }
      if (rh.state === "updating") {
        // No remote job ledger exists any more (updater jobs lived in the
        // local-upgrade repository). A host stuck in "updating" with no
        // evidence of progress fails closed.
        rh.state = "failed";
        rh.reason = "updating host has no live upgrade evidence";
        rh.updatedAt = new Date(now).toISOString();
        continue;
      }
      if (rh.state === "observing") {
        const observationDuration = rh.observationStartedAt
          ? now - new Date(rh.observationStartedAt).getTime()
          : 0;

        // Real, locally-produced evidence only: fresh agent state + live AI
        // capability record. Missing evidence fails closed.
        const heartbeatFresh = isOnline && (now - lastSeenMs <= 60_000);

        let aiHealthy = true;
        if (release.ai && release.ai.components.length > 0) {
          const capability = this.aiRepo
            ? await this.aiRepo.getAiCapability(rh.vpsId).catch(() => undefined)
            : undefined;
          aiHealthy = Boolean(
            capability?.supported === true &&
              capability.freshness &&
              now - new Date(capability.freshness).getTime() <= 15 * 60 * 1000,
          );
        }

        const buildMatches = agentState?.buildId === release.buildId;

        const healthy = heartbeatFresh && aiHealthy && buildMatches;

        if (!healthy) {
          rh.state = "failed";
          const failReasons = [];
          if (!heartbeatFresh) failReasons.push("agent heartbeat stale");
          if (!aiHealthy) failReasons.push("AI health regression or missing evidence");
          if (!buildMatches) failReasons.push("buildId mismatch");
          rh.reason = `Canary regression: ${failReasons.join(", ")}`;
          rh.updatedAt = new Date(now).toISOString();
          hasFailure = true;
          failureReason = `Canary regression on ${vps.name} (${failReasons.join(", ")})`;
        } else if (observationDuration >= CANARY_OBSERVATION_MS) {
          rh.state = "succeeded";
          rh.updatedAt = new Date(now).toISOString();
        }
      }
    }

    if (hasFailure) {
      rollout.state = "paused";
      rollout.reason = failureReason;
      rollout.updatedAt = new Date(now).toISOString();

      // No pre-swap job ledger exists post-cutover; rollout pause simply
      // withdraws any in-flight host state.
      for (const h of rollout.hosts) {
        if (h.state === "updating" || h.state === "queued") {
          h.state = "failed";
          h.reason = `Paused: ${failureReason}`;
          h.updatedAt = new Date(now).toISOString();
        }
      }

      await this.fleetRepo.updateRollout(rollout);
      await this.fleetRepo.addNotification({
        kind: "warning",
        message: `Rollout ${rollout.id} paused due to failure: ${failureReason}`,
      });
      return;
    }

    const allTerminal = rollout.hosts.every(
      (h) => h.state === "succeeded" || h.state === "failed",
    );
    if (allTerminal && rollout.hosts.length > 0) {
      rollout.state = "completed";
      rollout.updatedAt = new Date(now).toISOString();
      await this.fleetRepo.updateRollout(rollout);
      await this.fleetRepo.addNotification({
        kind: "success",
        message: `Rollout ${rollout.id} completed successfully`,
      });
      return;
    }

    rollout.updatedAt = new Date(now).toISOString();
    await this.fleetRepo.updateRollout(rollout);
  }

  private isInsideMaintenanceWindow(
    win: FleetMaintenanceWindow,
    nowMs: number,
  ): boolean {
    try {
      const date = new Date(nowMs);
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: win.timezone,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = formatter.formatToParts(date);
      let weekdayStr = "";
      let hour = 0;
      let minute = 0;
      for (const part of parts) {
        if (part.type === "weekday") weekdayStr = part.value;
        if (part.type === "hour") hour = Number.parseInt(part.value, 10);
        if (part.type === "minute") minute = Number.parseInt(part.value, 10);
      }

      const dayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      const day = dayMap[weekdayStr] ?? date.getUTCDay();

      const [startH = 0, startM = 0] = win.start.split(":").map(Number);
      const [endH = 0, endM = 0] = win.end.split(":").map(Number);
      const currentMinutes = hour * 60 + minute;
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      if (startMinutes <= endMinutes) {
        if (!win.days.includes(day)) {
          return false;
        }
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
      } else {
        // Overnight window (e.g. Mon 22:00 to Tue 06:00)
        if (currentMinutes >= startMinutes) {
          return win.days.includes(day);
        } else if (currentMinutes <= endMinutes) {
          const previousDay = (day + 6) % 7;
          return win.days.includes(previousDay);
        } else {
          return false;
        }
      }
    } catch {
      return false;
    }
  }

}
