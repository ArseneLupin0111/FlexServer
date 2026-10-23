import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { isFreshTimestamp } from "../common/host-health.js";
import { DemoMutationBlockedError, VpsNotFoundError } from "../common/errors.js";
import type { AppConfig } from "../config/app-config.js";
import type { AgentCredential } from "../agents/agent.models.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type {
  LocalUpgradeRepository,
  LocalUpgradeWritePatch,
} from "../persistence/repositories/local-upgrade.repository.js";
import { newLocalUpgradeId } from "../persistence/repositories/local-upgrade.repository.js";
import { BundledAgentService } from "./bundled-agent.service.js";
import {
  AGENT_REPOSITORY,
  APP_CONFIG,
  LOCAL_UPGRADE_REPOSITORY,
  VPS_REPOSITORY,
} from "../tokens.js";
import type { VpsRecord } from "../vps/vps.models.js";
import {
  isPostSwapState,
  isTerminalState,
  LocalUpgradeUniqueViolationError,
  LOCAL_UPGRADE_LEASE_TTL_MS,
  LOCAL_UPGRADE_OVERALL_DEADLINE_MS,
  LOCAL_UPGRADE_PHASE_TIMEOUT_MS,
  UPDATER_HEALTH_TTL_MS,
  EXECUTING_UPGRADE_STATES,
  type AgentAutomationView,
  type AgentConvergenceRecord,
  type LocalUpgradeJob,
  type LocalUpgradeResult,
  type LocalUpgradeState,
} from "./local-upgrade.models.js";
import { AgentLifecycleCoordinator } from "../agents/agent-lifecycle-coordinator.js";
import { Optional } from "@nestjs/common";
import type {
  LocalUpdaterProgressInput,
  LocalUpdaterResultInput,
} from "./local-upgrade.schemas.js";
import { AGENT_API_CONTRACT_VERSION } from "./versions.js";

// ── Architecture normalization ───────────────────────────────────────────

export function normalizeArchitecture(
  raw?: string | null,
): "amd64" | "arm64" | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "x86_64" || trimmed === "amd64") return "amd64";
  if (trimmed === "aarch64" || trimmed === "arm64") return "arm64";
  return null;
}
// ── Admin views (locked contract with the dashboard) ─────────────────────

export type AgentUpdateReleaseView = {
  releaseId: string;
  version: string;
  buildId: string;
  publishedAt: string;
  artifacts: { os: string; arch: string; size: number; sha256: string; url: string }[];
};

export type AgentUpdateState =
  | "unknown"
  | "current"
  | "available"
  | "incompatible"
  | "release_unavailable"
  | "updater_unavailable";

export type AgentUpdateCompatibilityReason =
  | "ok"
  | "api_incompatible"
  | "unsupported_architecture"
  | "release_unavailable"
  | "unknown";

export type AgentUpdateView = {
  installed: {
    version: string | null;
    buildId: string | null;
    lastSeenAt: string | null;
    fresh: boolean;
  };
  available: AgentUpdateReleaseView | null;
  compatibility: {
    compatible: boolean;
    apiContractVersion: number;
    reason: AgentUpdateCompatibilityReason;
  };
  updater: {
    installed: boolean;
    healthy: boolean;
    lastSeenAt: string | null;
  };
  state: AgentUpdateState;
  job: LocalUpgradeJob | null;
  automation?: AgentAutomationView;
};

export type CreateLocalUpgradeResult = {
  job: LocalUpgradeJob;
  created: boolean;
};

export type UpdaterClaimResult = {
  job: LocalUpgradeJob;
  /** True when a claim lands at/after the swap — the host must reconcile its journal first. */
  requiresReconcile: boolean;
};

export type UpdaterResultOutcome = {
  job: LocalUpgradeJob;
  /** Present when the outcome awaits the confirming agent heartbeat. */
  awaitHeartbeat?: true;
};

// ── Deadline rulings ─────────────────────────────────────────────────────

type DeadlineRuling = {
  state: LocalUpgradeState;
  outcome: LocalUpgradeResult["outcome"];
  code: string;
  message: string;
  auditAction: string;
  auditResult: "failure" | "blocked";
};

/**
 * Missed phase/overall deadlines before the swap point fail the job; at or
 * after the swap point they can never claim success — only attention.
 * Terminal states are never ruled (reconcile skips them).
 */
const DEADLINE_RULING: Record<LocalUpgradeState, DeadlineRuling | undefined> =
  {
    queued: {
      state: "failed",
      outcome: "failed",
      code: "claim_timeout",
      message: "Updater did not claim the upgrade in time",
      auditAction: "local_agent_upgrade.failure",
      auditResult: "failure",
    },
    claimed: {
      state: "failed",
      outcome: "failed",
      code: "phase_timeout",
      message: "Upgrade timed out before the binary swap",
      auditAction: "local_agent_upgrade.failure",
      auditResult: "failure",
    },
    downloading: {
      state: "failed",
      outcome: "failed",
      code: "phase_timeout",
      message: "Upgrade timed out before the binary swap",
      auditAction: "local_agent_upgrade.failure",
      auditResult: "failure",
    },
    verifying: {
      state: "failed",
      outcome: "failed",
      code: "phase_timeout",
      message: "Upgrade timed out before the binary swap",
      auditAction: "local_agent_upgrade.failure",
      auditResult: "failure",
    },
    staging: {
      state: "failed",
      outcome: "failed",
      code: "phase_timeout",
      message: "Upgrade timed out before the binary swap",
      auditAction: "local_agent_upgrade.failure",
      auditResult: "failure",
    },
    restarting: {
      state: "rollback_unverified",
      outcome: "rollback_unverified",
      code: "swap_unconfirmed",
      message:
        "Restart phase timed out — the binary swap may have happened; verify the host manually",
      auditAction: "local_agent_upgrade.rollback",
      auditResult: "failure",
    },
    awaiting_heartbeat: {
      state: "rollback_unverified",
      outcome: "rollback_unverified",
      code: "heartbeat_timeout",
      message: "New agent heartbeat did not arrive in time",
      auditAction: "local_agent_upgrade.rollback",
      auditResult: "failure",
    },
    rolling_back: {
      state: "rollback_unverified",
      outcome: "rollback_unverified",
      code: "rollback_timeout",
      message: "Rollback did not confirm in time",
      auditAction: "local_agent_upgrade.rollback",
      auditResult: "failure",
    },
    succeeded: undefined,
    rolled_back: undefined,
    rollback_unverified: undefined,
    failed: undefined,
    deferred: undefined,
    superseded: undefined,
  };

/** Canonical local-host predicate (matches VpsService's own check). */
export function isLocalHostVps(vps: VpsRecord): boolean {
  return vps.kind === "local" || vps.managedBy === "system";
}

export function computeAutomationState(params: {
  arch: "amd64" | "arm64" | null;
  archConflict: boolean;
  targetBuildId: string | null;
  agentFresh: boolean;
  updaterFresh: boolean;
  updaterInstalled: boolean;
  updaterIdle?: boolean;
  busyReason: string | null;
  installedBuildId: string | null;
  activeJob: LocalUpgradeJob | null;
  convergenceRecord: AgentConvergenceRecord | null;
}): AgentAutomationView {
  const {
    arch,
    archConflict,
    targetBuildId,
    agentFresh,
    updaterFresh,
    updaterInstalled,
    updaterIdle,
    busyReason,
    installedBuildId,
    activeJob,
    convergenceRecord,
  } = params;

  const retryPending = Boolean(
    convergenceRecord?.retryBuildId &&
      targetBuildId &&
      convergenceRecord.retryBuildId === targetBuildId &&
      convergenceRecord.retryKey,
  );

  // 1. active execution/recovery ("updating")
  if (
    activeJob &&
    !isTerminalState(activeJob.state) &&
    (EXECUTING_UPGRADE_STATES.includes(activeJob.state) || activeJob.claimedAt != null)
  ) {
    return {
      state: "updating",
      reason: activeJob.message ?? activeJob.state,
      targetBuildId,
      retryAllowed: false,
    };
  }

  // 2. unavailable/incompatible target
  if (archConflict || !arch) {
    return {
      state: "incompatible",
      reason: archConflict ? "arch_conflict" : "unsupported_architecture",
      targetBuildId: null,
      retryAllowed: false,
    };
  }
  if (!targetBuildId) {
    return {
      state: "release_unavailable",
      reason: "release_unavailable",
      targetBuildId: null,
      retryAllowed: false,
    };
  }

  // 3. failure suppression ("failed")
  if (
    convergenceRecord?.suppressedBuildId === targetBuildId &&
    !retryPending
  ) {
    return {
      state: "failed",
      reason: convergenceRecord.suppressedReason ?? "upgrade_failed",
      targetBuildId,
      retryAllowed: true,
    };
  }

  // 4. missing access ("needs_access")
  if (
    !updaterInstalled ||
    convergenceRecord?.setupState === "needs_access" ||
    convergenceRecord?.setupState === "failed"
  ) {
    return {
      state: "needs_access",
      reason: convergenceRecord?.setupReason ?? "updater_not_installed",
      targetBuildId,
      retryAllowed: !retryPending,
    };
  }

  // 5. stale connection ("waiting_connection")
  if (!agentFresh || !updaterFresh) {
    return {
      state: "waiting_connection",
      reason: !agentFresh ? "agent_offline" : "updater_offline",
      targetBuildId,
      retryAllowed: false,
    };
  }

  // 7. current only with fresh matching heartbeat ("current")
  if (installedBuildId === targetBuildId && agentFresh) {
    return {
      state: "current",
      reason: null,
      targetBuildId,
      retryAllowed: false,
    };
  }

  // 8. pending otherwise ("pending")
  return {
    state: "pending",
    reason: null,
    targetBuildId,
    retryAllowed: false,
  };
}

@Injectable()
export class LocalUpgradeService {
  private readonly activeUpdateFences = new Map<string, () => void>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOCAL_UPGRADE_REPOSITORY)
    private readonly repository: LocalUpgradeRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(BundledAgentService)
    private readonly bundledAgent: BundledAgentService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional()
    @Inject(AgentLifecycleCoordinator)
    private readonly coordinator?: AgentLifecycleCoordinator,
  ) {}

  registerUpdateFenceRelease(vpsId: string, release: () => void): void {
    this.activeUpdateFences.set(vpsId, release);
  }

  releaseUpdateFence(vpsId: string): void {
    const release = this.activeUpdateFences.get(vpsId);
    if (release) {
      this.activeUpdateFences.delete(vpsId);
      try {
        release();
      } catch {
        // ignore
      }
    }
  }

  async deferJob(jobId: string, reason: string): Promise<boolean> {
    const job = await this.repository.get(jobId);
    if (!job || job.state !== "queued" || job.claimedAt !== null) return false;
    const nowIso = new Date().toISOString();
    const updated = await this.commitTerminal(
      job,
      {
        state: "deferred",
        completedAt: nowIso,
        error: null,
        result: {
          outcome: "deferred",
          reason,
          completedAt: nowIso,
        },
      },
      {
        action: "local_agent_upgrade.deferred",
        result: "success",
        metadata: { reason },
      },
    );
    return Boolean(updated);
  }

  // ── Admin API ─────────────────────────────────────────────────────────

  async getAgentUpdate(vpsId: string): Promise<AgentUpdateView> {
    const vps = await this.vps.get(vpsId);
    if (!vps) throw new VpsNotFoundError();
    await this.reconcile(vpsId, Date.now());

    const agentState = await this.agents.getState(vpsId);
    const systemInfo = await this.agents.getSystemInfo(vpsId);
    const updaterHeartbeat = await this.repository.getUpdaterHeartbeat(vpsId);

    const fresh = agentState?.lastSeenAt
      ? isFreshTimestamp(agentState.lastSeenAt)
      : false;
    const updaterHealthy = Boolean(
      updaterHeartbeat &&
        isFreshTimestamp(
          updaterHeartbeat.lastSeenAt,
          UPDATER_HEALTH_TTL_MS,
        ) &&
        (updaterHeartbeat.protocolVersion ?? 1) >= 2,
    );
    const updaterFresh = Boolean(
      updaterHeartbeat &&
        isFreshTimestamp(
          updaterHeartbeat.lastSeenAt,
          UPDATER_HEALTH_TTL_MS,
        ),
    );

    const agentArch = normalizeArchitecture(systemInfo?.kernel?.arch);
    const updaterArch = normalizeArchitecture(updaterHeartbeat?.platform?.arch);

    let arch: "amd64" | "arm64" | null = null;
    let archConflict = false;
    if (fresh && agentArch && updaterFresh && updaterArch) {
      if (agentArch !== updaterArch) {
        archConflict = true;
        arch = null;
      } else {
        arch = agentArch;
      }
    } else if (fresh && agentArch) {
      arch = agentArch;
    } else if (updaterFresh && updaterArch) {
      arch = updaterArch;
    } else if (agentArch && updaterArch) {
      if (agentArch !== updaterArch) {
        archConflict = true;
        arch = null;
      } else {
        arch = agentArch;
      }
    } else {
      arch = agentArch ?? updaterArch ?? null;
    }

    const bundled = arch ? this.bundledAgent.getMetadata(arch) : null;

    let available: AgentUpdateReleaseView | null = null;
    let compatible = false;
    let reason: AgentUpdateCompatibilityReason = "release_unavailable";
    let releaseBuildIds: string[] = [];
    if (bundled) {
      available = {
        releaseId: bundled.buildId,
        version: bundled.version,
        buildId: bundled.buildId,
        publishedAt: bundled.publishedAt,
        artifacts: [
          {
            os: "linux",
            arch: bundled.arch,
            size: bundled.size,
            sha256: bundled.sha256,
            url: `/api/local-updater/bundled/artifact`,
          },
        ],
      };
      compatible = true;
      reason = "ok";
      releaseBuildIds = [bundled.buildId];
    } else if (archConflict || (systemInfo?.kernel?.arch && !agentArch) || (updaterHeartbeat?.platform?.arch && !updaterArch)) {
      compatible = false;
      reason = "unsupported_architecture";
    }

    const updater = {
      installed: updaterHeartbeat != null,
      healthy: updaterHealthy,
      lastSeenAt: updaterHeartbeat?.lastSeenAt ?? null,
    };

    const installedBuild = agentState?.buildId ?? null;
    let state: AgentUpdateState;
    if (!arch || archConflict) {
      reason = "unsupported_architecture";
      state = "incompatible";
    } else if (!bundled) {
      state = "release_unavailable";
    } else if (!agentState?.lastSeenAt || !installedBuild || !fresh) {
      state = "unknown";
    } else if (releaseBuildIds.includes(installedBuild)) {
      state = "current";
    } else if (!compatible) {
      state = "incompatible";
    } else if (!updater.healthy) {
      state = "updater_unavailable";
    } else {
      state = "available";
    }

    const jobs = await this.repository.listByVps(vpsId, { limit: 1 });
    const activeJob = await this.repository.getActiveByVps(vpsId);
    const conv = await this.repository.getConvergence(vpsId);
    const automation = computeAutomationState({
      arch,
      archConflict,
      targetBuildId: bundled?.buildId ?? null,
      agentFresh: fresh,
      updaterFresh,
      updaterInstalled: updater.installed,
      updaterIdle: updaterHeartbeat?.idle === true,
      busyReason: updaterHeartbeat?.busyReason ?? null,
      installedBuildId: installedBuild,
      activeJob: activeJob ?? null,
      convergenceRecord: conv ?? null,
    });

    return {
      installed: {
        version: agentState?.version ?? null,
        buildId: installedBuild,
        lastSeenAt: agentState?.lastSeenAt ?? null,
        fresh,
      },
      available,
      compatibility: {
        compatible,
        apiContractVersion: AGENT_API_CONTRACT_VERSION,
        reason,
      },
      updater,
      state,
      job: jobs[0] ?? null,
      automation,
    };
  }

  async createJob(
    vpsId: string,
    input: { releaseId: string },
    options: { idempotencyKey?: string; retryRequestKey?: string; actor?: string } = {},
  ): Promise<CreateLocalUpgradeResult> {
    if (this.config.mode === "demo") throw new DemoMutationBlockedError();

    const vps = await this.vps.get(vpsId);
    if (!vps) throw new VpsNotFoundError();
    await this.reconcile(vpsId, Date.now());

    if (options.idempotencyKey) {
      const replay = await this.repository.getByIdempotencyKey(
        vpsId,
        options.idempotencyKey,
      );
      if (replay) return { job: replay, created: false };
    }

    const active = await this.repository.getActiveByVps(vpsId);
    if (active) throw this.activeJobConflict(active.id);

    const updaterHeartbeat = await this.repository.getUpdaterHeartbeat(vpsId);
    if (
      !updaterHeartbeat ||
      !isFreshTimestamp(updaterHeartbeat.lastSeenAt, UPDATER_HEALTH_TTL_MS)
    ) {
      throw new ConflictException({
        error: {
          message: "Local updater is not reporting; retry after it reconnects",
          code: "updater_unhealthy",
        },
      });
    }
    if ((updaterHeartbeat.protocolVersion ?? 1) < 3) {
      throw new ConflictException({
        error: {
          message:
            "Updater is running an outdated protocol; upgrade the updater to enable agent updates",
          code: "updater_incompatible",
        },
      });
    }

    const agentState = await this.agents.getState(vpsId);
    const systemInfo = await this.agents.getSystemInfo(vpsId);
    const agentArch = normalizeArchitecture(systemInfo?.kernel?.arch);
    const updaterArch = normalizeArchitecture(updaterHeartbeat.platform?.arch);

    if (agentArch && updaterArch && agentArch !== updaterArch) {
      throw new BadRequestException({
        error: {
          message: `Agent architecture (${agentArch}) and updater platform architecture (${updaterArch}) conflict`,
          code: "release_incompatible",
          reason: "unsupported_architecture",
        },
      });
    }

    const arch = agentArch ?? updaterArch;
    if (!arch) {
      throw new BadRequestException({
        error: {
          message: "Agent architecture is unknown or unsupported",
          code: "release_incompatible",
          reason: "unsupported_architecture",
        },
      });
    }
    if (
      !agentState?.buildId ||
      !agentState.lastSeenAt ||
      !isFreshTimestamp(agentState.lastSeenAt)
    ) {
      throw new ConflictException({
        error: {
          message: "A fresh agent heartbeat with build identity is required",
          code: "agent_unavailable",
        },
      });
    }

    const bundled = this.bundledAgent.getMetadata(arch);
    if (!bundled) {
      throw new ConflictException({
        error: {
          message: "Bundled agent binary is not available",
          code: "release_unavailable",
        },
      });
    }
    if (bundled.buildId !== input.releaseId) {
      throw new ConflictException({
        error: {
          message:
            "The requested release does not match the deployed bundled binary",
          code: "release_changed",
        },
      });
    }
    if (bundled.arch !== arch) {
      throw new BadRequestException({
        error: {
          message: `Bundled agent binary arch (${bundled.arch}) does not match host architecture (${arch})`,
          code: "release_incompatible",
          reason: "unsupported_architecture",
        },
      });
    }
    const installedFresh = !!(
      agentState?.buildId &&
      agentState.lastSeenAt &&
      isFreshTimestamp(agentState.lastSeenAt)
    );
    if (installedFresh && agentState?.buildId === bundled.buildId) {
      throw new ConflictException({
        error: {
          message: "Agent is already running this release",
          code: "already_current",
        },
      });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const jobId = newLocalUpgradeId();
    const job: LocalUpgradeJob = {
      id: jobId,
      vpsId,
      state: "queued",
      progress: null,
      targetArch: arch,
      releaseId: bundled.buildId,
      releaseVersion: bundled.version,
      releaseBuildId: bundled.buildId,
      targetSha256: bundled.sha256,
      targetUrl: `/api/local-updater/jobs/${jobId}/artifact`,
      targetSizeBytes: bundled.size,
      manifestRaw: "",
      ...(agentState?.buildId ? { baselineBuildId: agentState.buildId } : {}),
      actor: options.actor ?? "dashboard",
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      ...(options.retryRequestKey
        ? { retryRequestKey: options.retryRequestKey }
        : {}),
      fencingToken: 0,
      reclaimCount: 0,
      claimedAt: null,
      leaseExpiresAt: null,
      deadlineAt: new Date(nowMs + LOCAL_UPGRADE_OVERALL_DEADLINE_MS).toISOString(),
      phaseDeadlineAt: new Date(
        nowMs + LOCAL_UPGRADE_PHASE_TIMEOUT_MS.queued,
      ).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };

    try {
      const created = await this.repository.create(job);
      await this.audit.record({
        actor: options.actor ?? "dashboard",
        action: "local_agent_upgrade.create",
        resourceType: "vps",
        resourceId: vpsId,
        jobId: created.id,
        result: "success",
        metadata: {
          releaseId: created.releaseId,
          releaseBuildId: created.releaseBuildId,
          targetSha256: created.targetSha256,
        },
      });
      return { job: created, created: true };
    } catch (error: unknown) {
      if (!(error instanceof LocalUpgradeUniqueViolationError)) throw error;
      if (error.kind === "idempotency" && error.existingId) {
        const existing = await this.repository.get(error.existingId);
        if (existing) return { job: existing, created: false };
      }
      const current = error.existingId
        ? await this.repository.get(error.existingId)
        : await this.repository.getActiveByVps(vpsId);
      throw this.activeJobConflict(current?.id);
    }
  }

  async listJobs(
    vpsId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LocalUpgradeJob[]> {
    const vps = await this.vps.get(vpsId);
    if (!vps) throw new VpsNotFoundError();
    await this.reconcile(vpsId, Date.now());
    return this.repository.listByVps(vpsId, options);
  }

  async getJob(vpsId: string, jobId: string): Promise<LocalUpgradeJob> {
    const vps = await this.vps.get(vpsId);
    if (!vps) throw new VpsNotFoundError();
    await this.reconcile(vpsId, Date.now());
    return this.requireJob(vpsId, jobId);
  }

  async findJobById(jobId: string): Promise<LocalUpgradeJob | undefined> {
    return this.repository.get(jobId);
  }

  // ── Updater API ───────────────────────────────────────────────────────

  async claim(
    credential: AgentCredential,
    protocolVersion: number = 3,
    evidence?: Record<string, unknown>,
  ): Promise<UpdaterClaimResult | null> {
    const nowMs = Date.now();
    const existingHeartbeat = await this.repository.getUpdaterHeartbeat(
      credential.vpsId,
    );

    const platform =
      typeof evidence?.platform === "object" && evidence.platform !== null
        ? (evidence.platform as { os: string; arch: string })
        : existingHeartbeat?.platform;

    const idle =
      typeof evidence?.idle === "boolean" ? evidence.idle : undefined;

    const busyReason =
      typeof evidence?.busyReason === "string"
        ? evidence.busyReason
        : undefined;

    const updaterVersion =
      typeof evidence?.updaterVersion === "string"
        ? evidence.updaterVersion
        : existingHeartbeat?.updaterVersion;

    const installedAi = Array.isArray(evidence?.installedAi)
      ? (evidence.installedAi as string[])
      : existingHeartbeat?.installedAi;

    const aiHealth =
      typeof evidence?.aiHealth === "object" && evidence.aiHealth !== null
        ? (evidence.aiHealth as { status: string; healthy: boolean })
        : existingHeartbeat?.aiHealth;

    await this.repository.recordUpdaterHeartbeat({
      vpsId: credential.vpsId,
      lastSeenAt: new Date(nowMs).toISOString(),
      credentialId: credential.id,
      protocolVersion,
      ...(updaterVersion ? { updaterVersion } : {}),
      ...(platform ? { platform } : {}),
      ...(typeof idle === "boolean" ? { idle } : {}),
      ...(busyReason ? { busyReason } : {}),
      ...(installedAi ? { installedAi } : {}),
      ...(aiHealth ? { aiHealth } : {}),
    });
    await this.reconcile(credential.vpsId, nowMs);

    for (let attempt = 0; attempt < 3; attempt++) {
      const job = await this.repository.getActiveByVps(credential.vpsId);
      if (!job) return null;
      if (isTerminalState(job.state)) return null;

      // Protocol guard: bundled jobs require protocol >= 3
      if (!job.manifestRaw && protocolVersion < 3) {
        return null;
      }
      const leaseValid =
        job.leaseExpiresAt != null && nowMs <= Date.parse(job.leaseExpiresAt);
      if (leaseValid) {
        return { job, requiresReconcile: isPostSwapState(job.state) };
      }
      let releaseCoordinatorFence: (() => void) | undefined;
      if (job.state === "queued" && this.coordinator) {
        try {
          releaseCoordinatorFence = await this.coordinator.tryAcquire(credential.vpsId, "update");
        } catch {
          const reason = "activity_in_progress";
          await this.commitTerminal(
            job,
            {
              state: "deferred",
              completedAt: new Date(nowMs).toISOString(),
              error: null,
              result: {
                outcome: "deferred",
                reason,
                completedAt: new Date(nowMs).toISOString(),
              },
            },
            {
              action: "local_agent_upgrade.deferred",
              result: "success",
              metadata: { reason },
            },
          );
          return null;
        }
      }

      const agentState = await this.agents.getState(credential.vpsId);
      let updated: LocalUpgradeJob | undefined;
      try {
        updated = await this.repository.compareAndSet(
          job.id,
          job.revision,
          {
            state: job.state === "queued" ? "claimed" : job.state,
            fencingToken: job.fencingToken + 1,
            reclaimCount:
              job.claimedAt != null ? job.reclaimCount + 1 : job.reclaimCount,
            claimedAt: job.claimedAt ?? new Date(nowMs).toISOString(),
            leaseExpiresAt: new Date(
              nowMs + LOCAL_UPGRADE_LEASE_TTL_MS,
            ).toISOString(),
            ...(job.baselineBuildId == null && agentState?.buildId
              ? { baselineBuildId: agentState.buildId }
              : {}),
          },
        );
      } catch (err) {
        if (releaseCoordinatorFence) {
          releaseCoordinatorFence();
        }
        if (
          err instanceof LocalUpgradeUniqueViolationError &&
          err.kind === "global_active"
        ) {
          return null;
        }
        throw err;
      }
      if (!updated) {
        if (releaseCoordinatorFence) {
          releaseCoordinatorFence();
        }
        continue;
      }
      if (releaseCoordinatorFence) {
        this.activeUpdateFences.set(credential.vpsId, releaseCoordinatorFence);
      }
      if (updated) {
        // replay polls above return without mutating, so they never audit.
        await this.audit.record({
          actor: "system",
          action: "local_agent_upgrade.claim",
          resourceType: "vps",
          resourceId: credential.vpsId,
          jobId: job.id,
          result: "success",
          metadata: {
            releaseId: job.releaseId,
            credentialId: credential.id,
            fencingToken: updated.fencingToken,
            reclaimCount: updated.reclaimCount,
            phase: updated.state,
          },
        });
        return { job: updated, requiresReconcile: isPostSwapState(updated.state) };
      }
    }
    throw new ConflictException({
      error: {
        message: "Claim contention; poll again",
        code: "stale_lease",
      },
    });
  }

  async progress(
    credential: AgentCredential,
    jobId: string,
    input: LocalUpdaterProgressInput,
    protocolVersion: number = 2,
  ): Promise<LocalUpgradeJob> {
    const nowMs = Date.now();
    await this.repository.recordUpdaterHeartbeat({
      vpsId: credential.vpsId,
      lastSeenAt: new Date(nowMs).toISOString(),
      credentialId: credential.id,
      protocolVersion,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      const job = await this.requireJob(credential.vpsId, jobId);
      if (isTerminalState(job.state)) throw this.jobTerminalConflict();
      this.assertLease(job, input.fencingToken, nowMs);

      const agentState = await this.agents.getState(job.vpsId);
      const patch: LocalUpgradeWritePatch = {
        state: input.phase,
        ...(input.progress === undefined ? {} : { progress: input.progress }),
        ...(input.message === undefined ? {} : { message: input.message }),
        leaseExpiresAt: new Date(
          nowMs + LOCAL_UPGRADE_LEASE_TTL_MS,
        ).toISOString(),
        phaseDeadlineAt: new Date(
          nowMs + LOCAL_UPGRADE_PHASE_TIMEOUT_MS[input.phase],
        ).toISOString(),
      };
      if (input.phase === "restarting" && job.baselineHeartbeatAt == null) {
        // Swap point: pin the last pre-restart heartbeat so rollback checks
        // only accept heartbeats from after the restart.
        patch.baselineHeartbeatAt =
          agentState?.lastSeenAt ?? new Date(nowMs).toISOString();
      }
      const updated = await this.repository.compareAndSet(
        job.id,
        job.revision,
        patch,
      );
      if (updated) return updated;
    }
    throw this.staleLeaseConflict();
  }

  async result(
    credential: AgentCredential,
    jobId: string,
    input: LocalUpdaterResultInput,
    protocolVersion: number = 2,
  ): Promise<UpdaterResultOutcome> {
    const nowMs = Date.now();
    await this.repository.recordUpdaterHeartbeat({
      vpsId: credential.vpsId,
      lastSeenAt: new Date(nowMs).toISOString(),
      credentialId: credential.id,
      protocolVersion,
    });
    return this.settleResult(credential, jobId, input, nowMs);
  }

  private async settleResult(
    credential: AgentCredential,
    jobId: string,
    input: LocalUpdaterResultInput,
    nowMs: number,
  ): Promise<UpdaterResultOutcome> {

    for (let attempt = 0; attempt < 3; attempt++) {
      const job = await this.requireJob(credential.vpsId, jobId);

      if (isTerminalState(job.state)) {
        // A rollback_unverified ruling is refinable: the updater's late
        // rolled_back report plus heartbeat verification can still settle it.
        if (job.state === "rollback_unverified" && input.outcome === "rolled_back") {
          const refined = await this.ruleRollback(job, input, nowMs);
          if (refined) return { job: refined };
          const current = await this.repository.get(job.id);
          if (current) return { job: current };
        }

        // Idempotent result replay: an identical verdict under the fencing
        // token that won the terminal ruling reads back the committed job —
        // a retried POST (lost response) converges instead of erroring. A
        // `failed` report also replays a ruling the API settled as
        // rollback_unverified (its policy answer to the same post-swap
        // report). A replay never mutates: it returns the committed ruling
        // unchanged, so a stale claimant (token mismatch) or a conflicting
        // verdict still gets job_terminal.
        if (
          input.fencingToken === job.fencingToken &&
          job.result != null &&
          (job.result.outcome === input.outcome ||
            (input.outcome === "failed" &&
              job.result.outcome === "rollback_unverified") ||
            (input.outcome === "deferred" &&
              job.result.outcome === "rollback_unverified"))
        ) {
          return { job };
        }
        throw this.jobTerminalConflict();
      }

      this.assertLease(job, input.fencingToken, nowMs);
      const nowIso = new Date(nowMs).toISOString();

      if (input.outcome === "failed") {
        // `failed` is only truthful before the binary swap: the updater is
        // reporting that nothing was mutated. At or after the swap the API
        // can never accept failed as proof that cleanup is safe — the host
        // may hold a half-applied binary — so the job settles
        // rollback_unverified instead: backup and journal retained, operator
        // verification required (the same ruling deadline timeouts give
        // post-swap). The response stays 200 with the settled job; the
        // updater only maps stale_lease/job_terminal error codes.
        const postSwap = isPostSwapState(job.state);
        const patch: LocalUpgradeWritePatch = postSwap
          ? {
              state: "rollback_unverified",
              completedAt: nowIso,
              error: {
                code: "post_swap_failed",
                message: input.reason
                  ? `Upgrade failed at or after the binary swap: ${input.reason}`
                  : "Upgrade failed at or after the binary swap; verify the host before cleanup",
              },
              result: {
                outcome: "rollback_unverified",
                ...(input.reportedBuildId
                  ? { reportedBuildId: input.reportedBuildId }
                  : {}),
                completedAt: nowIso,
              },
            }
          : {
              state: "failed",
              completedAt: nowIso,
              error: {
                code: "update_failed",
                message: input.reason ?? "Updater reported a failed upgrade",
              },
              result: {
                outcome: "failed",
                ...(input.reportedBuildId
                  ? { reportedBuildId: input.reportedBuildId }
                  : {}),
                completedAt: nowIso,
              },
            };
        const audit = postSwap
          ? {
              action: "local_agent_upgrade.rollback",
              result: "failure" as const,
              metadata: {
                reason: input.reason ?? "post_swap_failed",
                reportedOutcome: "failed",
              },
            }
          : {
              action: "local_agent_upgrade.failure",
              result: "failure" as const,
              metadata: { reason: input.reason ?? "update_failed" },
            };
        const updated = await this.commitTerminal(job, patch, audit);
        if (updated) return { job: updated };
        continue;
      }

      if (input.outcome === "deferred") {
        const postSwap = isPostSwapState(job.state);
        const patch: LocalUpgradeWritePatch = postSwap
          ? {
              state: "rollback_unverified",
              completedAt: nowIso,
              error: {
                code: "post_swap_failed",
                message: input.reason
                  ? `Upgrade deferred report received at or after binary swap: ${input.reason}`
                  : "Upgrade deferred report received at or after binary swap; verify host",
              },
              result: {
                outcome: "rollback_unverified",
                ...(input.reportedBuildId
                  ? { reportedBuildId: input.reportedBuildId }
                  : {}),
                completedAt: nowIso,
              },
            }
          : {
              state: "deferred",
              completedAt: nowIso,
              error: null,
              result: {
                outcome: "deferred",
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.reportedBuildId
                  ? { reportedBuildId: input.reportedBuildId }
                  : {}),
                completedAt: nowIso,
              },
            };
        const audit = postSwap
          ? {
              action: "local_agent_upgrade.rollback",
              result: "failure" as const,
              metadata: {
                reason: input.reason ?? "post_swap_deferred",
                reportedOutcome: "deferred",
              },
            }
          : {
              action: "local_agent_upgrade.deferred",
              result: "success" as const,
              metadata: { reason: input.reason ?? "host_busy" },
            };
        const updated = await this.commitTerminal(job, patch, audit);
        if (updated) return { job: updated };
        continue;
      }
      if (input.outcome === "superseded") {
        const postSwap = isPostSwapState(job.state);
        const patch: LocalUpgradeWritePatch = postSwap
          ? {
              state: "rollback_unverified",
              completedAt: nowIso,
              error: {
                code: "post_swap_failed",
                message: input.reason
                  ? `Upgrade superseded report received at or after binary swap: ${input.reason}`
                  : "Upgrade superseded report received at or after binary swap; verify host",
              },
              result: {
                outcome: "rollback_unverified",
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.reportedBuildId
                  ? { reportedBuildId: input.reportedBuildId }
                  : {}),
                completedAt: nowIso,
              },
            }
          : {
              state: "superseded",
              completedAt: nowIso,
              error: null,
              result: {
                outcome: "superseded",
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.reportedBuildId
                  ? { reportedBuildId: input.reportedBuildId }
                  : {}),
                completedAt: nowIso,
              },
            };
        const audit = postSwap
          ? {
              action: "local_agent_upgrade.rollback",
              result: "failure" as const,
              metadata: {
                reason: input.reason ?? "post_swap_superseded",
                reportedOutcome: "superseded",
              },
            }
          : {
              action: "local_agent_upgrade.superseded",
              result: "success" as const,
              metadata: { reason: input.reason ?? "superseded_by_deployment" },
            };
        const updated = await this.commitTerminal(job, patch, audit);
        if (updated) return { job: updated };
        continue;
      }

      if (input.outcome === "rollback_unverified") {
        const updated = await this.commitTerminal(
          job,
          {
            state: "rollback_unverified",
            completedAt: nowIso,
            error: {
              code: "rollback_unverified",
              message:
                input.reason ?? "Updater could not verify the rollback",
            },
            result: {
              outcome: "rollback_unverified",
              ...(input.reportedBuildId
                ? { reportedBuildId: input.reportedBuildId }
                : {}),
              completedAt: nowIso,
            },
          },
          {
            action: "local_agent_upgrade.rollback",
            result: "failure",
            metadata: { reason: input.reason ?? "rollback_unverified" },
          },
        );
        if (updated) return { job: updated };
        continue;
      }

      if (input.outcome === "rolled_back") {
        const ruled = await this.ruleRollback(job, input, nowMs);
        if (ruled) return { job: ruled };
        continue;
      }

      // outcome === "succeeded": the heartbeat — not the updater — rules.
      const agentState = await this.agents.getState(job.vpsId);
      const confirmed =
        agentState?.buildId === job.releaseBuildId &&
        (agentState?.lastSeenAt
          ? isFreshTimestamp(agentState.lastSeenAt)
          : false) &&
        (job.baselineHeartbeatAt == null ||
          (agentState?.lastSeenAt != null &&
            Date.parse(agentState.lastSeenAt) >
              Date.parse(job.baselineHeartbeatAt)));
      if (!confirmed) {
        return { job, awaitHeartbeat: true };
      }
      const updated = await this.commitTerminal(
        job,
        {
          state: "succeeded",
          progress: 100,
          completedAt: nowIso,
          result: {
            outcome: "succeeded",
            heartbeatBuildId: agentState?.buildId,
            ...(input.reportedBuildId
              ? { reportedBuildId: input.reportedBuildId }
              : {}),
            completedAt: nowIso,
          },
        },
        {
          action: "local_agent_upgrade.success",
          result: "success",
          metadata: { source: "updater_result" },
        },
      );
      if (updated) return { job: updated };
    }
    throw this.staleLeaseConflict();
  }

  async getUpdaterJob(
    credential: AgentCredential,
    jobId: string,
    _protocolVersion?: string,
  ): Promise<LocalUpgradeJob> {
    await this.reconcile(credential.vpsId, Date.now());
    return this.requireJob(credential.vpsId, jobId);
  }

  // ── Reconciliation & verification ─────────────────────────────────────

  /**
   * Apply heartbeat verification and deadline rulings to every live job of
   * one VPS. Runs on reads (admin views, updater claim, updater get) so the
   * durable store converges without cron.
   */
  async reconcile(vpsId: string, nowMs: number): Promise<void> {
    const jobs = await this.repository.listByVps(vpsId, { limit: 100 });
    for (const job of jobs) {
      if (isTerminalState(job.state)) continue;
      const nowIso = new Date(nowMs).toISOString();

      // Supersede unclaimed bundled jobs pinned to a deployment target that is
      // no longer the running deployment's artifact. Provenance is immutable:
      // the old job retires untouched and a new job carries the new target.
      if (job.state === "queued" && !job.manifestRaw && job.claimedAt == null) {
        const superseded = await this.supersedeIfObsolete(job, nowMs);
        if (superseded) continue;
      }

      // Heartbeat-confirmed success outruns every deadline: the new binary
      // proved itself by identifying itself in a fresh heartbeat.
      if (job.state === "awaiting_heartbeat" || job.state === "restarting") {
        const agentState = await this.agents.getState(vpsId);
        if (
          agentState?.buildId === job.releaseBuildId &&
          agentState.lastSeenAt &&
          isFreshTimestamp(agentState.lastSeenAt) &&
          (job.baselineHeartbeatAt == null ||
            Date.parse(agentState.lastSeenAt) >
              Date.parse(job.baselineHeartbeatAt))
        ) {
          await this.commitTerminal(
            job,
            {
              state: "succeeded",
              progress: 100,
              completedAt: nowIso,
              result: {
                outcome: "succeeded",
                heartbeatBuildId: agentState.buildId,
                completedAt: nowIso,
              },
            },
            {
              action: "local_agent_upgrade.success",
              result: "success",
              metadata: { source: "heartbeat" },
            },
          );
          continue;
        }
      }

      const phaseExpired =
        job.phaseDeadlineAt != null && nowMs > Date.parse(job.phaseDeadlineAt);
      const overallExpired = nowMs > Date.parse(job.deadlineAt);
      if (!phaseExpired && !overallExpired) continue;

      const ruling = DEADLINE_RULING[job.state];
      if (!ruling) continue;
      await this.commitTerminal(
        job,
        {
          state: ruling.state,
          completedAt: nowIso,
          error:
            ruling.state === "deferred"
              ? null
              : { code: ruling.code, message: ruling.message },
          result: {
            outcome: ruling.outcome,
            reason: ruling.state === "deferred" ? ruling.code : undefined,
            completedAt: nowIso,
          },
        },
        {
          action: ruling.auditAction,
          result: ruling.auditResult,
          metadata: { reason: ruling.code },
        },
      );
    }
  }

  /**
   * Rollback ruling: rolled_back only when a fresh heartbeat proves the
   * baseline build is running again after the swap point; otherwise the job
   * settles at rollback_unverified for manual attention.
   */
  private async ruleRollback(
    job: LocalUpgradeJob,
    input: LocalUpdaterResultInput,
    nowMs: number,
  ): Promise<LocalUpgradeJob | undefined> {
    const agentState = await this.agents.getState(job.vpsId);
    const nowIso = new Date(nowMs).toISOString();
    const baselineVerified =
      job.baselineHeartbeatAt != null &&
      job.baselineBuildId != null &&
      agentState?.buildId === job.baselineBuildId &&
      agentState.lastSeenAt != null &&
      isFreshTimestamp(agentState.lastSeenAt) &&
      Date.parse(agentState.lastSeenAt) > Date.parse(job.baselineHeartbeatAt);

    if (baselineVerified) {
      return this.commitTerminal(
        job,
        {
          state: "rolled_back",
          completedAt: nowIso,
          error: null,
          result: {
            outcome: "rolled_back",
            ...(input.reportedBuildId
              ? { reportedBuildId: input.reportedBuildId }
              : {}),
            heartbeatBuildId: agentState?.buildId,
            completedAt: nowIso,
          },
        },
        {
          action: "local_agent_upgrade.rollback",
          result: "success",
          metadata: { verification: "baseline_heartbeat" },
        },
      );
    }
    return this.commitTerminal(
      job,
      {
        state: "rollback_unverified",
        completedAt: nowIso,
        error: {
          code: "rollback_unverified",
          message:
            input.reason ??
            "Pre-upgrade heartbeat was not verified after rollback; verify the host manually",
        },
        result: {
          outcome: "rollback_unverified",
          ...(input.reportedBuildId
            ? { reportedBuildId: input.reportedBuildId }
            : {}),
          completedAt: nowIso,
        },
      },
      {
        action: "local_agent_upgrade.rollback",
        result: "failure",
        metadata: { verification: "unconfirmed" },
      },
    );
  }

  /** CAS a job into a terminal state; audits only when this writer wins. */
  private async commitTerminal(
    job: LocalUpgradeJob,
    patch: LocalUpgradeWritePatch,
    audit: {
      action: string;
      result: "success" | "failure" | "blocked";
      metadata?: Record<string, unknown>;
    },
  ): Promise<LocalUpgradeJob | undefined> {
    const updated = await this.repository.compareAndSet(
      job.id,
      job.revision,
      patch,
    );
    if (!updated) return undefined;
    if (isTerminalState(updated.state)) {
      this.releaseUpdateFence(job.vpsId);
    }
    await this.audit.record({
      actor: "system",
      action: audit.action,
      resourceType: "vps",
      resourceId: job.vpsId,
      jobId: job.id,
      result: audit.result,
      metadata: {
        releaseId: job.releaseId,
        finalState: updated.state,
        ...audit.metadata,
      },
    });
    return updated;
  }

  // ── Guards ────────────────────────────────────────────────────────────

  private async requireJob(
    vpsId: string,
    jobId: string,
  ): Promise<LocalUpgradeJob> {
    const job = await this.repository.get(jobId);
    if (!job || job.vpsId !== vpsId) {
      throw new NotFoundException({
        error: { message: "Upgrade job not found", code: "job_not_found" },
      });
    }
    return job;
  }

  private assertLease(
    job: LocalUpgradeJob,
    fencingToken: number,
    nowMs: number,
  ): void {
    if (
      fencingToken !== job.fencingToken ||
      job.leaseExpiresAt == null ||
      nowMs > Date.parse(job.leaseExpiresAt)
    ) {
      throw this.staleLeaseConflict();
    }
  }

  private staleLeaseConflict(): ConflictException {
    return new ConflictException({
      error: {
        message: "Update lease is stale or expired; reclaim the job first",
        code: "stale_lease",
      },
    });
  }

  private jobTerminalConflict(): ConflictException {
    return new ConflictException({
      error: {
        message: "Upgrade job already reached a terminal state",
        code: "job_terminal",
      },
    });
  }

  private activeJobConflict(jobId?: string): ConflictException {
    return new ConflictException({
      error: {
        message: "An upgrade job is already active for this host",
        code: "active_job_exists",
        ...(jobId ? { jobId } : {}),
      },
    });
  }
  async getJobArtifact(
    credential: AgentCredential,
    jobId: string,
  ): Promise<{ filePath: string; size: number; sha256: string }> {
    await this.reconcile(credential.vpsId, Date.now());
    const job = await this.requireJob(credential.vpsId, jobId);
    if (isTerminalState(job.state) || job.state === "queued") {
      throw this.jobTerminalConflict();
    }
    const arch = await this.resolveJobArch(job);
    if (!arch) {
      throw new NotFoundException({
        error: {
          message: "Unable to determine target architecture for job artifact",
          code: "artifact_missing",
        },
      });
    }

    const bundled = this.bundledAgent.getMetadata(arch);
    if (!bundled) {
      throw new NotFoundException({
        error: {
          message: "Bundled agent binary not found",
          code: "artifact_missing",
        },
      });
    }
    if (
      bundled.sha256 !== job.targetSha256 ||
      bundled.buildId !== job.releaseBuildId ||
      (job.targetSizeBytes != null && bundled.size !== job.targetSizeBytes)
    ) {
      throw new ConflictException({
        error: {
          message:
            "Deployed agent binary does not match the pinned job artifact",
          code: "artifact_mismatch",
        },
      });
    }
    return {
      filePath: bundled.filePath,
      size: bundled.size,
      sha256: bundled.sha256,
    };
  }

  private async resolveJobArch(
    job: LocalUpgradeJob,
  ): Promise<"amd64" | "arm64" | null> {
    let arch: "amd64" | "arm64" | null = job.targetArch ?? null;
    if (!arch && job.manifestRaw) {
      try {
        const parsed = JSON.parse(job.manifestRaw);
        if (Array.isArray(parsed.artifacts)) {
          for (const art of parsed.artifacts) {
            const norm = normalizeArchitecture(art.arch);
            if (norm) {
              arch = norm;
              break;
            }
          }
        }
      } catch {
        // Ignored
      }
    }
    if (!arch) {
      for (const candidateArch of ["amd64", "arm64"] as const) {
        const meta = this.bundledAgent.getMetadata(candidateArch);
        if (meta && meta.sha256 === job.targetSha256) {
          arch = candidateArch;
          break;
        }
      }
    }
    if (!arch) {
      const updaterHeartbeat = await this.repository.getUpdaterHeartbeat(job.vpsId);
      const norm = normalizeArchitecture(updaterHeartbeat?.platform?.arch);
      if (norm) {
        arch = norm;
      }
    }
    return arch;
  }

  private async supersedeIfObsolete(
    job: LocalUpgradeJob,
    nowMs: number,
  ): Promise<boolean> {
    const arch = await this.resolveJobArch(job);
    if (!arch) return false;
    const bundled = this.bundledAgent.getMetadata(arch);
    if (!bundled) return false;

    if (
      bundled.buildId === job.releaseBuildId &&
      bundled.sha256 === job.targetSha256
    ) {
      return false;
    }

    const nowIso = new Date(nowMs).toISOString();
    const updated = await this.commitTerminal(
      job,
      {
        state: "superseded",
        completedAt: nowIso,
        error: null,
        result: {
          outcome: "superseded",
          reason: "superseded_by_newer_deployment",
          completedAt: nowIso,
        },
      },
      {
        action: "local_agent_upgrade.superseded",
        result: "success",
        metadata: {
          reason: "superseded_by_new_deployment",
          previousBuildId: job.releaseBuildId,
          newBuildId: bundled.buildId,
        },
      },
    );
    return Boolean(updated);
  }
}
