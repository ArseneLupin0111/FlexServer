import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool } from "pg";
import type { AppConfig } from "../config/app-config.js";
import type { FleetRepository } from "../persistence/repositories/fleet.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { LocalUpgradeRepository } from "../persistence/repositories/local-upgrade.repository.js";
import type { LocalUpgradeService } from "../local-upgrade/local-upgrade.service.js";
import {
  LOCAL_UPGRADE_POST_SWAP_STATES,
  LOCAL_UPGRADE_TERMINAL_STATES,
  type UpdaterHeartbeat,
} from "../local-upgrade/local-upgrade.models.js";
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
const MAX_CONCURRENT_PER_COHORT = 3;
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
  localUpgradeRepository: LocalUpgradeRepository;
  localUpgradeService?: LocalUpgradeService;
  metricRepository?: MetricRepository;
  auditService?: AuditService;
  sshService?: SshService;
  keyService?: KeyService;
  pool?: Pool;
  clock?: () => number;
}

export class FleetService {
  private readonly config: AppConfig;
  private readonly fleetRepo: FleetRepository;
  private readonly vpsRepo: VpsRepository;
  private readonly agentRepo: AgentRepository;
  private readonly localUpgradeRepo: LocalUpgradeRepository;
  private readonly localUpgradeService?: LocalUpgradeService;
  private readonly metricRepo?: MetricRepository;
  private readonly auditService?: AuditService;
  private readonly sshService?: SshService;
  private readonly keyService?: KeyService;
  private readonly pool?: Pool;
  private readonly getNow: () => number;

  constructor(deps: FleetServiceDependencies) {
    this.config = deps.config;
    this.fleetRepo = deps.fleetRepository;
    this.vpsRepo = deps.vpsRepository;
    this.agentRepo = deps.agentRepository;
    this.localUpgradeRepo = deps.localUpgradeRepository;
    this.metricRepo = deps.metricRepository;
    this.localUpgradeService = deps.localUpgradeService;
    this.auditService = deps.auditService;
    this.sshService = deps.sshService;
    this.keyService = deps.keyService;
    void this.localUpgradeService;
    void this.auditService;
    void this.sshService;
    void this.keyService;

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

  async getOverview(): Promise<FleetOverviewResponse> {
    const [allVps, allAgentStates, allPolicies, enrolledVpsIds, releases, rollouts, notifications] =
      await Promise.all([
        this.vpsRepo.list(),
        this.agentRepo.listStates(),
        this.fleetRepo.listPolicies(),
        this.fleetRepo.listEnrolledVpsIds(),
        this.fleetRepo.listReleases(),
        this.fleetRepo.listRollouts(),
        this.fleetRepo.listNotifications(100),
      ]);

    const allHeartbeats = await Promise.all(
      allVps.map((vps) => this.localUpgradeRepo.getUpdaterHeartbeat(vps.id)),
    );
    const heartbeatByVps = new Map<string, UpdaterHeartbeat>();
    allHeartbeats.forEach((hb, idx) => {
      if (hb) heartbeatByVps.set(allVps[idx].id, hb);
    });

    const enrolledSet = new Set(enrolledVpsIds);
    const activeRollout = rollouts.find(
      (r) => r.state === "running" || r.state === "pending",
    );
    const latestRelease = releases[0];

    const agentStateByVps = new Map(allAgentStates.map((s) => [s.vpsId, s]));

    const groupNames = new Set<string>(["Default"]);
    for (const p of policyValues(allPolicies)) {
      if (p.group) groupNames.add(p.group);
    }
    for (const r of rollouts) {
      if (r.group) groupNames.add(r.group);
    }
    const groups: FleetGroup[] = Array.from(groupNames).map((name) => ({ name }));

    const now = this.getNow();

    const hosts: FleetHost[] = allVps.map((vps) => {
      const agentState = agentStateByVps.get(vps.id);
      const heartbeat = heartbeatByVps.get(vps.id);
      const policy: FleetPolicy = lookupPolicy(allPolicies, vps.id) ?? {
        mode: "auto",
        group: "Default",
      };
      const enrolled = enrolledSet.has(vps.id);

      const lastSeenMs = agentState?.lastSeenAt
        ? new Date(agentState.lastSeenAt).getTime()
        : 0;
      const isOnline = agentState?.status === "online" && (now - lastSeenMs <= 5 * 60 * 1000);

      const installedBuildId = agentState?.buildId ?? null;
      const targetReleaseId = latestRelease?.id ?? null;

      const setupRequired = !heartbeat;

      let status: FleetHostStatus = "idle";
      if (!enrolled || setupRequired) {
        status = "needs_setup";
      } else if (!isOnline) {
        status = "offline";
      } else if (policy.mode === "pinned") {
        status = "pinned";
      } else {
        const rolloutHost = activeRollout?.hosts.find((h) => h.vpsId === vps.id);
        if (rolloutHost) {
          if (rolloutHost.state === "updating") status = "updating";
          else if (rolloutHost.state === "observing") status = "observing";
          else if (rolloutHost.state === "queued") status = "queued";
          else if (rolloutHost.state === "succeeded") status = "succeeded";
          else if (rolloutHost.state === "failed") status = "failed";
          else if (rolloutHost.state === "rolled_back") status = "rolled_back";
        } else if (heartbeat && heartbeat.idle === false) {
          status = "busy";
        } else {
          status = "idle";
        }
      }

      return {
        vpsId: vps.id,
        name: vps.name,
        online: isOnline,
        installedBuildId,
        targetReleaseId,
        policy,
        enrolled,
        setupRequired,
        status,
        lastSeenAt: agentState?.lastSeenAt ?? null,
        platform: heartbeat?.platform,
        updaterVersion: heartbeat?.updaterVersion ?? null,
        installedAi: heartbeat?.installedAi,
        aiHealth: heartbeat?.aiHealth,
      };
    });

    return {
      hosts,
      groups,
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

    const hasAgentOrUpdater =
      release.components?.some((c) => c === "agent" || c === "updater") ||
      release.artifacts?.some(
        (a) => a.component === "agent" || a.component === "updater",
      );
    if (hasAgentOrUpdater) {
      throw new BadRequestException(
        "Rollouts for agent or updater components are rejected; agent updates are managed automatically by deployment convergence.",
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
        "External agent target manifests are no longer imported. Agent updates are managed automatically by deployment convergence. Only signed AI runtime manifests are supported.",
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
      minUpdaterVersion: verified.minUpdaterVersion,
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
      const updaterHeartbeat = await this.localUpgradeRepo.getUpdaterHeartbeat(rh.vpsId);

      const lastSeenMs = agentState?.lastSeenAt
        ? new Date(agentState.lastSeenAt).getTime()
        : 0;
      const isOnline = agentState?.status === "online" && (now - lastSeenMs <= 5 * 60 * 1000);

      if (rh.state === "updating" || rh.state === "queued") {
        if (!rh.jobId) continue;
        const job = await this.localUpgradeRepo.get(rh.jobId);
        if (!job) continue;

        if (job.state === "succeeded") {
          if (rh.isCanary || pol?.canary) {
            rh.state = "observing";
            rh.observationStartedAt = new Date(now).toISOString();
            rh.updatedAt = new Date(now).toISOString();
          } else {
            rh.state = "succeeded";
            rh.updatedAt = new Date(now).toISOString();
          }
        } else if (job.state === "failed" || job.state === "rolled_back") {
          rh.state = "failed";
          rh.reason = job.error?.message ?? "Upgrade failed";
          rh.updatedAt = new Date(now).toISOString();
          hasFailure = true;
          failureReason = `Host ${vps.name} failed: ${rh.reason}`;
        }
      } else if (rh.state === "observing") {
        const observationDuration = rh.observationStartedAt
          ? now - new Date(rh.observationStartedAt).getTime()
          : 0;

        let metricsFresh = false;
        if (this.metricRepo) {
          const latest = await this.metricRepo.getLatest(rh.vpsId);
          if (latest && (now - new Date(latest.collectedAt).getTime() <= 60_000)) {
            metricsFresh = true;
          }
        }

        const heartbeatFresh = isOnline && (now - lastSeenMs <= 60_000);

        const hasAi = Boolean(
          (updaterHeartbeat?.installedAi && updaterHeartbeat.installedAi.length > 0) ||
          (release.ai && release.ai.components.length > 0),
        );
        let aiHealthy = true;
        if (hasAi) {
          if (!updaterHeartbeat?.aiHealth) {
            aiHealthy = false;
          } else {
            aiHealthy = updaterHeartbeat.aiHealth.healthy === true;
          }
        }

        const buildMatches = agentState?.buildId === release.buildId;

        const healthy = metricsFresh && heartbeatFresh && aiHealthy && buildMatches;

        if (!healthy) {
          rh.state = "failed";
          const failReasons = [];
          if (!metricsFresh) failReasons.push("metrics stale");
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

      // Safely cancel pre-swap jobs without interrupting swapping/post-swap jobs
      for (const h of rollout.hosts) {
        if (h.jobId && (h.state === "updating" || h.state === "queued")) {
          const job = await this.localUpgradeRepo.get(h.jobId);
          if (
            job &&
            !LOCAL_UPGRADE_POST_SWAP_STATES.includes(job.state) &&
            !LOCAL_UPGRADE_TERMINAL_STATES.includes(job.state)
          ) {
            await this.localUpgradeRepo.compareAndSet(job.id, job.revision, {
              state: "failed",
              error: { code: "rollout_paused", message: `Rollout paused: ${failureReason}` },
              completedAt: new Date(now).toISOString(),
            });
            this.localUpgradeService?.releaseUpdateFence(job.vpsId);
            h.state = "failed";
            h.reason = `Paused: ${failureReason}`;
            h.updatedAt = new Date(now).toISOString();
          }
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

    await this.dispatchRolloutHosts(rollout, release, now);
    rollout.updatedAt = new Date(now).toISOString();
    await this.fleetRepo.updateRollout(rollout);
  }

  private async isHostEligible(
    rh: FleetRolloutHost,
    release: FleetRelease,
    policies: Map<string, FleetPolicy> | Record<string, FleetPolicy>,
    now: number,
  ): Promise<boolean> {
    const vps = await this.vpsRepo.get(rh.vpsId);
    if (!vps) return false;

    const enrolled = await this.fleetRepo.isEnrolled(rh.vpsId);
    if (!enrolled) return false;

    const agentState = await this.agentRepo.getState(rh.vpsId);
    const lastSeenMs = agentState?.lastSeenAt
      ? new Date(agentState.lastSeenAt).getTime()
      : 0;
    const isOnline = agentState?.status === "online" && (now - lastSeenMs <= 5 * 60 * 1000);
    if (!isOnline) return false;

    const pol = lookupPolicy(policies, rh.vpsId) ?? { mode: "auto", group: "Default" };
    if (pol.mode === "pinned") return false;

    if (
      pol.maintenanceWindow &&
      !this.isInsideMaintenanceWindow(pol.maintenanceWindow, now)
    ) {
      return false;
    }

    const heartbeat = await this.localUpgradeRepo.getUpdaterHeartbeat(rh.vpsId);
    if (!this.isHostIdle(heartbeat, now)) return false;

    if (release.minUpdaterVersion && heartbeat?.updaterVersion) {
      if (this.isVersionOlder(heartbeat.updaterVersion, release.minUpdaterVersion)) {
        return false;
      }
    }

    const os = heartbeat?.platform?.os;
    const arch = heartbeat?.platform?.arch;
    const hasAgentArtifact = release.artifacts?.some(
      (a) => a.os === os && a.arch === arch && a.component === "agent",
    );
    if (!hasAgentArtifact) return false;

    return true;
  }

  private async dispatchRolloutHosts(
    rollout: FleetRollout,
    release: FleetRelease,
    now: number,
  ): Promise<void> {
    const policies = await this.fleetRepo.listPolicies();

    const cohortGroups = new Map<string, FleetRolloutHost[]>();

    for (const rh of rollout.hosts) {
      const pol = lookupPolicy(policies, rh.vpsId);
      const heartbeat = await this.localUpgradeRepo.getUpdaterHeartbeat(rh.vpsId);
      const os = heartbeat?.platform?.os ?? "linux";
      const arch = heartbeat?.platform?.arch ?? "amd64";
      const runtime =
        heartbeat?.installedAi && heartbeat.installedAi.length > 0
          ? "ai"
          : "standard";
      const groupName = pol?.group ?? rollout.group ?? "Default";
      const cohortKey = `${groupName}:${os}:${arch}:${runtime}`;

      let list = cohortGroups.get(cohortKey);
      if (!list) {
        list = [];
        cohortGroups.set(cohortKey, list);
      }
      list.push(rh);
    }

    for (const [, cohortHosts] of cohortGroups) {
      const activeOrObserving = cohortHosts.filter(
        (h) => h.state === "updating" || h.state === "observing",
      );
      const hasSucceededCanary = cohortHosts.some(
        (h) => h.isCanary && h.state === "succeeded",
      );

      if (!hasSucceededCanary) {
        if (activeOrObserving.length === 0) {
          const queuedHosts = cohortHosts.filter((h) => h.state === "queued");

          let candidate: FleetRolloutHost | undefined;
          for (const h of queuedHosts) {
            const pol = lookupPolicy(policies, h.vpsId);
            if (pol?.canary) {
              if (await this.isHostEligible(h, release, policies, now)) {
                candidate = h;
                break;
              }
            }
          }

          if (!candidate) {
            for (const h of queuedHosts) {
              if (await this.isHostEligible(h, release, policies, now)) {
                candidate = h;
                break;
              }
            }
          }

          if (candidate) {
            candidate.isCanary = true;
            await this.tryDispatchHost(candidate, rollout, release, now);
          }
        }
      } else {
        const activeUpdating = cohortHosts.filter((h) => h.state === "updating");
        const availableSlots = Math.max(0, MAX_CONCURRENT_PER_COHORT - activeUpdating.length);

        if (availableSlots > 0) {
          const queuedHosts = cohortHosts.filter((h) => h.state === "queued");
          let dispatchedCount = 0;
          for (const h of queuedHosts) {
            if (dispatchedCount >= availableSlots) break;
            if (await this.isHostEligible(h, release, policies, now)) {
              const dispatched = await this.tryDispatchHost(h, rollout, release, now);
              if (dispatched) {
                dispatchedCount++;
              }
            }
          }
        }
      }
    }
  }

  private async tryDispatchHost(
    rh: FleetRolloutHost,
    rollout: FleetRollout,
    release: FleetRelease,
    now: number,
  ): Promise<boolean> {
    const vps = await this.vpsRepo.get(rh.vpsId);
    if (!vps) {
      rh.state = "failed";
      rh.reason = "VPS not found";
      rh.updatedAt = new Date(now).toISOString();
      return false;
    }

    const enrolled = await this.fleetRepo.isEnrolled(rh.vpsId);
    if (!enrolled) {
      rh.state = "failed";
      rh.reason = "Host not enrolled";
      rh.updatedAt = new Date(now).toISOString();
      return false;
    }

    const agentState = await this.agentRepo.getState(rh.vpsId);
    const lastSeenMs = agentState?.lastSeenAt
      ? new Date(agentState.lastSeenAt).getTime()
      : 0;
    const isOnline = agentState?.status === "online" && (now - lastSeenMs <= 5 * 60 * 1000);

    if (!isOnline) {
      return false;
    }

    const pol = (await this.fleetRepo.getPolicy(rh.vpsId)) ?? {
      mode: "auto",
      group: "Default",
    };

    if (pol.mode === "pinned") {
      rh.state = "failed";
      rh.reason = "Host is pinned; automatic update disallowed";
      rh.updatedAt = new Date(now).toISOString();
      return false;
    }

    if (
      pol.maintenanceWindow &&
      !this.isInsideMaintenanceWindow(pol.maintenanceWindow, now)
    ) {
      return false;
    }

    const heartbeat = await this.localUpgradeRepo.getUpdaterHeartbeat(rh.vpsId);
    if (!this.isHostIdle(heartbeat, now)) {
      return false;
    }

    if (release.minUpdaterVersion && heartbeat?.updaterVersion) {
      if (this.isVersionOlder(heartbeat.updaterVersion, release.minUpdaterVersion)) {
        rh.state = "failed";
        rh.reason = `Host updater version ${heartbeat.updaterVersion} is older than required ${release.minUpdaterVersion}`;
        rh.updatedAt = new Date(now).toISOString();
        return false;
      }
    }

    const allReleases = await this.fleetRepo.listReleases();
    let releaseToDispatch = release;

    if (release.upgradeFrom && release.upgradeFrom.length > 0) {
      const currentBuild = agentState?.buildId;
      if (!currentBuild || !release.upgradeFrom.includes(currentBuild)) {
        const nextRelease = this.findNextReleaseInChain(
          currentBuild ?? "",
          release,
          allReleases,
        );
        if (!nextRelease) {
          rh.state = "failed";
          rh.reason = `No intermediate upgrade path from ${currentBuild} to ${release.buildId}`;
          rh.updatedAt = new Date(now).toISOString();
          return false;
        }
        releaseToDispatch = nextRelease;
      }
    }

    const os = heartbeat?.platform?.os ?? "linux";
    const arch = heartbeat?.platform?.arch ?? "amd64";
    const artifacts = releaseToDispatch.artifacts ?? [];
    const matchingArtifacts = artifacts.filter(
      (a) => a.os === os && a.arch === arch,
    );
    const agentArtifact = matchingArtifacts.find((a) => a.component === "agent");
    if (!agentArtifact) {
      rh.state = "failed";
      rh.reason = `Unsupported platform: no agent artifact found for ${os}/${arch}`;
      rh.updatedAt = new Date(now).toISOString();
      return false;
    }

    const targetSha256 = agentArtifact.sha256;
    const targetUrl = agentArtifact.url;
    const targetSizeBytes = agentArtifact.size;

    const hasAiInstalled = Boolean(
      heartbeat?.installedAi && heartbeat.installedAi.length > 0,
    );
    const selectedComponents = matchingArtifacts
      .filter((a) => {
        if (a.component.startsWith("ai-")) return hasAiInstalled;
        return true;
      })
      .map((a) => a.component);
    if (!selectedComponents.includes("agent")) {
      selectedComponents.push("agent");
    }

    if (!releaseToDispatch.rawPayload || !releaseToDispatch.signature) {
      rh.state = "failed";
      rh.reason = "Unsigned release cannot be dispatched";
      rh.updatedAt = new Date(now).toISOString();
      return false;
    }

    const envelope: FleetManifestEnvelope = {
      payload: releaseToDispatch.rawPayload,
      signature: releaseToDispatch.signature,
      keyId: releaseToDispatch.keyId ?? "",
    };
    const manifestRaw = JSON.stringify(envelope);
    const manifestSha256 = createHash("sha256").update(manifestRaw, "utf8").digest("hex");

    const upgradeJob = await this.localUpgradeRepo.create({
      id: randomUUID(),
      vpsId: rh.vpsId,
      state: "queued",
      progress: 0,
      releaseId: releaseToDispatch.id,
      releaseVersion: releaseToDispatch.version,
      releaseBuildId: releaseToDispatch.buildId,
      targetSha256,
      targetUrl,
      targetSizeBytes,
      manifestRaw,
      manifestSha256,
      actor: "fleet-orchestrator",
      fencingToken: 0,
      reclaimCount: 0,
      claimedAt: null,
      leaseExpiresAt: null,
      deadlineAt: new Date(now + 30 * 60 * 1000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      completedAt: null,
      components: selectedComponents,
    });

    rh.state = "updating";
    rh.jobId = upgradeJob.id;
    rh.updatedAt = new Date(now).toISOString();
    return true;
  }

  private findNextReleaseInChain(
    currentBuild: string,
    targetRelease: FleetRelease,
    allReleases: FleetRelease[],
  ): FleetRelease | null {
    if (!targetRelease.upgradeFrom || targetRelease.upgradeFrom.length === 0) {
      return targetRelease;
    }
    if (targetRelease.upgradeFrom.includes(currentBuild)) {
      return targetRelease;
    }

    const visited = new Set<string>();
    const queue: Array<{ release: FleetRelease; path: FleetRelease[] }> = [
      { release: targetRelease, path: [targetRelease] },
    ];

    while (queue.length > 0) {
      const { release, path } = queue.shift()!;
      if (!release.upgradeFrom) continue;

      for (const requiredFrom of release.upgradeFrom) {
        if (requiredFrom === currentBuild) {
          return path[path.length - 1] ?? targetRelease;
        }
        if (!visited.has(requiredFrom)) {
          visited.add(requiredFrom);
          const parent = allReleases.find((r) => r.buildId === requiredFrom);
          if (parent) {
            queue.push({ release: parent, path: [...path, parent] });
          }
        }
      }
    }

    return null;
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

  private isHostIdle(
    heartbeat: UpdaterHeartbeat | undefined,
    now: number,
  ): boolean {
    if (!heartbeat) return false;
    const lastSeenMs = heartbeat.lastSeenAt
      ? new Date(heartbeat.lastSeenAt).getTime()
      : 0;
    if (now - lastSeenMs > 60_000) return false;
    if (heartbeat.protocolVersion !== 3) return false;
    if (heartbeat.idle !== true) return false;
    if (!heartbeat.platform?.os || !heartbeat.platform?.arch) return false;
    return true;
  }

  private isVersionOlder(current: string, required: string): boolean {
    const p1 = current.split(".").map(Number);
    const p2 = required.split(".").map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] ?? 0;
      const n2 = p2[i] ?? 0;
      if (n1 < n2) return true;
      if (n1 > n2) return false;
    }
    return false;
  }

}
