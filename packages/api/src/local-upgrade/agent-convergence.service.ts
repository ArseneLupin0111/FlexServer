import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import {
  AGENT_REPOSITORY,
  APP_CONFIG,
  FLEET_PROVISIONING_SERVICE,
  LOCAL_UPGRADE_REPOSITORY,
  VPS_REPOSITORY,
} from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import {
  newLocalUpgradeId,
  type LocalUpgradeRepository,
} from "../persistence/repositories/local-upgrade.repository.js";
import { BundledAgentService } from "./bundled-agent.service.js";
import {
  LocalUpgradeService,
  normalizeArchitecture,
  type AgentUpdateView,
} from "./local-upgrade.service.js";
import {
  EXECUTING_UPGRADE_STATES,
  isTerminalState,
  UPDATER_HEALTH_TTL_MS,
  type AgentConvergenceRecord,
} from "./local-upgrade.models.js";
import { isFreshTimestamp } from "../common/host-health.js";
import { DemoMutationBlockedError, VpsNotFoundError } from "../common/errors.js";
import { AuditService } from "../audit/audit.service.js";
import { AgentLifecycleCoordinator } from "../agents/agent-lifecycle-coordinator.js";
import type { FleetProvisioningService } from "../agents/fleet-provisioning.service.js";
import { AiBundleOrchestrationService } from "../ai/ai-bundle-install.service.js";

@Injectable()
export class AgentConvergenceService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer: NodeJS.Timeout | null = null;
  private currentTick: Promise<void> | null = null;
  private activeSetupVpsId: string | null = null;
  private readonly refreshedHosts = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOCAL_UPGRADE_REPOSITORY)
    private readonly repository: LocalUpgradeRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(BundledAgentService)
    private readonly bundledAgent: BundledAgentService,
    @Inject(LocalUpgradeService)
    private readonly localUpgradeService: LocalUpgradeService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional()
    @Inject(FLEET_PROVISIONING_SERVICE)
    private readonly provisioning?: FleetProvisioningService,
    @Optional()
    @Inject(AgentLifecycleCoordinator)
    private readonly coordinator?: AgentLifecycleCoordinator,
    // Optional AI bundle convergence (execmode plan Q7): hand-built test
    // configs may not wire it; the agent-binary tick then runs unchanged.
    @Optional()
    @Inject(AiBundleOrchestrationService)
    private readonly aiBundles?: AiBundleOrchestrationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      // 1. Reconstruct executing update fences from durable executing jobs before admitting activity
      const activeJobs = await this.repository.listActive();
      const executing = activeJobs.filter((j) =>
        EXECUTING_UPGRADE_STATES.includes(j.state),
      );
      if (this.coordinator) {
        for (const job of executing) {
          try {
            const release = this.coordinator.seedUpdateFence(job.vpsId);
            this.localUpgradeService.registerUpdateFenceRelease(job.vpsId, release);
          } catch {
            // Already fenced or conflicting
          }
        }
      }

      // 2. Reconstruct suppression on startup for crash/migration safety:
      // If a VPS has a terminal failure without a convergence record, store suppression
      const allVps = await this.vps.list();
      for (const v of allVps) {
        const conv = await this.repository.getConvergence(v.id);
        if (!conv) {
          const recentJobs = await this.repository.listByVps(v.id, { limit: 1 });
          const latest = recentJobs[0];
          if (
            latest &&
            (latest.state === "failed" ||
              latest.state === "rolled_back" ||
              latest.state === "rollback_unverified")
          ) {
            const reason =
              latest.result?.reason ?? latest.error?.message ?? latest.state;
            await this.repository.updateConvergence(v.id, {
              suppressedBuildId: latest.releaseBuildId,
              suppressedReason: reason,
              setupState: "unknown",
            });
          }
        }
      }
    } catch {
      // Ignore non-fatal bootstrap errors
    }

    if (this.config.mode === "demo") return;

    // Start 15-second interval timer
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, 15_000);
    this.timer.unref();

    // Trigger initial tick asynchronously
    setImmediate(() => {
      this.tick().catch(() => {});
    });
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async getAgentUpdate(vpsId: string): Promise<AgentUpdateView> {
    return this.localUpgradeService.getAgentUpdate(vpsId);
  }

  async listAgentUpdates(): Promise<
    Array<{ vpsId: string; name: string; update: AgentUpdateView }>
  > {
    const allVps = await this.vps.list();
    const sorted = allVps.slice().sort((a, b) => a.id.localeCompare(b.id));
    const results: Array<{ vpsId: string; name: string; update: AgentUpdateView }> =
      [];
    for (const vps of sorted) {
      const update = await this.localUpgradeService.getAgentUpdate(vps.id);
      results.push({
        vpsId: vps.id,
        name: vps.name,
        update,
      });
    }
    return results;
  }

  async requestUpdate(
    vpsId: string,
    idempotencyKey: string,
  ): Promise<AgentUpdateView> {
    if (this.config.mode === "demo") throw new DemoMutationBlockedError();

    const vps = await this.vps.get(vpsId);
    if (!vps) throw new VpsNotFoundError();

    const systemInfo = await this.agents.getSystemInfo(vpsId);
    const updaterHeartbeat = await this.repository.getUpdaterHeartbeat(vpsId);
    const arch = normalizeArchitecture(
      systemInfo?.kernel?.arch ?? updaterHeartbeat?.platform?.arch,
    );
    const bundled = arch ? this.bundledAgent.getMetadata(arch) : null;
    const targetBuildId = bundled?.buildId ?? null;

    const conv = await this.repository.getConvergence(vpsId);

    // Duplicate same Idempotency-Key returns existing intent/status without repeated restart
    if (conv?.retryKey === idempotencyKey && conv?.retryBuildId === targetBuildId) {
      return this.localUpgradeService.getAgentUpdate(vpsId);
    }

    // If an attempt was already executed or mapped to this original idempotency key,
    // replaying the same key must return existing status without a new attempt.
    const existingJob = await this.repository.getByVpsAndRetryRequestKey(
      vpsId,
      idempotencyKey,
    );
    if (existingJob) {
      return this.localUpgradeService.getAgentUpdate(vpsId);
    }
    // Record idempotent retry intent; clear nextSetupAttemptAt for immediate setup retry
    await this.repository.updateConvergence(vpsId, {
      retryBuildId: targetBuildId,
      retryKey: idempotencyKey,
      nextSetupAttemptAt: null,
    });

    // Wake tick asynchronously
    setImmediate(() => {
      this.tick().catch(() => {});
    });

    return this.localUpgradeService.getAgentUpdate(vpsId);
  }

  async tick(): Promise<void> {
    if (this.config.mode === "demo") return;
    if (this.currentTick) {
      await this.currentTick;
      return;
    }
    const run = this.runTick();
    this.currentTick = run;
    try {
      await run;
    } finally {
      this.currentTick = null;
    }
  }

  private async runTick(): Promise<void> {
    try {
      // AI bundle convergence (Q7) runs alongside the agent-binary tick in
      // its own job state machine; fire-and-forget so it can never delay or
      // fail the agent update scan.
      if (this.aiBundles) {
        this.aiBundles.convergeTick().catch(() => {});
      }

      const nowMs = Date.now();

      // 1. Reconcile active jobs and deadlines across all hosts
      const activeJobs = await this.repository.listActive();
      for (const job of activeJobs) {
        await this.localUpgradeService.reconcile(job.vpsId, nowMs);
      }

      // Refresh active jobs after reconciliation
      const refreshedActive = await this.repository.listActive();
      const hasExecuting = refreshedActive.some((j) =>
        EXECUTING_UPGRADE_STATES.includes(j.state),
      );

      // 2. Fetch all managed VPS in stable ID order
      const allVps = await this.vps.list();
      const stableVps = allVps.slice().sort((a, b) => a.id.localeCompare(b.id));

      let candidateCreatedThisTick = false;

      for (const vps of stableVps) {
        const activeJob = refreshedActive.find((j) => j.vpsId === vps.id);

        const agentState = await this.agents.getState(vps.id);
        const updaterHeartbeat = await this.repository.getUpdaterHeartbeat(
          vps.id,
        );

        const isInstalled = Boolean(
          agentState &&
            agentState.status !== "not_installed" &&
            (agentState.installedAt || agentState.buildId),
        );
        // If no agent installed on this VPS, skip convergence
        if (!isInstalled && !updaterHeartbeat) {
          continue;
        }

        let conv = await this.repository.getConvergence(vps.id);

        // Missing updater: bootstrap via provisioning asynchronously single-flight
        if (!updaterHeartbeat) {
          const isRemoteHost = vps.kind !== "local" && vps.managedBy !== "system";
          if (isRemoteHost) {
            this.triggerRemoteUpdaterRefresh(vps.id, conv, nowMs);
          }
          continue;
        }

        // Reconcile setup readiness when usable fresh heartbeat/protocol is observed
        if (
          updaterHeartbeat &&
          isFreshTimestamp(updaterHeartbeat.lastSeenAt, UPDATER_HEALTH_TTL_MS) &&
          (updaterHeartbeat.protocolVersion ?? 1) >= 3
        ) {
          if (conv?.setupState !== "ready") {
            await this.repository.updateConvergence(vps.id, {
              setupState: "ready",
              setupReason: null,
            });
            conv = await this.repository.getConvergence(vps.id);
          }
        }
        // Architecture resolution
        const systemInfo = await this.agents.getSystemInfo(vps.id);
        const agentArch = normalizeArchitecture(systemInfo?.kernel?.arch);
        const updaterArch = normalizeArchitecture(
          updaterHeartbeat?.platform?.arch,
        );

        if (agentArch && updaterArch && agentArch !== updaterArch) {
          // Arch conflict
          continue;
        }
        const arch = agentArch ?? updaterArch;
        if (!arch) continue;

        const bundled = this.bundledAgent.getMetadata(arch);
        if (!bundled) continue;

        // Invalidate obsolete retry intent if deployment target changed
        if (conv?.retryBuildId && conv.retryBuildId !== bundled.buildId) {
          await this.repository.updateConvergence(vps.id, {
            retryBuildId: null,
            retryKey: null,
          });
          conv = await this.repository.getConvergence(vps.id);
        }

        // If active job exists for this VPS
        if (activeJob) {
          if (activeJob.state === "queued") {
            const isAgentFresh = agentState?.lastSeenAt
              ? isFreshTimestamp(agentState.lastSeenAt)
              : false;
            const isUpdaterFresh = updaterHeartbeat?.lastSeenAt
              ? isFreshTimestamp(
                  updaterHeartbeat.lastSeenAt,
                  UPDATER_HEALTH_TTL_MS,
                )
              : false;
            if (!isAgentFresh || !isUpdaterFresh) {
              const reason = !isAgentFresh
                ? "agent_offline"
                : "updater_offline";
              await this.localUpgradeService.deferJob(activeJob.id, reason);
            } else {
              // Remote queued job: ensure remote updater is refreshed once per process before claim/execution
              const isRemoteHost = vps.kind !== "local" && vps.managedBy !== "system";
              if (isRemoteHost && this.provisioning && !this.refreshedHosts.has(vps.id)) {
                this.triggerRemoteUpdaterRefresh(vps.id, conv, nowMs);
              }
            }
          }
          // Active job present, skip creating another for this host
          continue;
        }

        // Freshness checks
        const isAgentFresh = agentState?.lastSeenAt
          ? isFreshTimestamp(agentState.lastSeenAt)
          : false;
        const isUpdaterFresh = updaterHeartbeat?.lastSeenAt
          ? isFreshTimestamp(
              updaterHeartbeat.lastSeenAt,
              UPDATER_HEALTH_TTL_MS,
            )
          : false;
        if (!agentState || !isAgentFresh || !isUpdaterFresh) {
          // Waiting connection
          continue;
        }


        // Check if already on the target build
        if (agentState.buildId === bundled.buildId) {
          if (conv?.suppressedBuildId === bundled.buildId) {
            await this.repository.updateConvergence(vps.id, {
              suppressedBuildId: null,
              suppressedReason: null,
              retryBuildId: null,
              retryKey: null,
            });
          }
          continue;
        }

        // Check suppression
        const isSuppressed =
          conv?.suppressedBuildId === bundled.buildId &&
          !(conv?.retryBuildId === bundled.buildId && conv?.retryKey);
        if (isSuppressed) {
          continue;
        }

        // Target agent build mismatch detected.
        // Ensure remote updater is refreshed once per API process via provisioning
        // before scheduling candidate job, replacing old protocol3 updaters that idle-block.
        const isRemoteHost = vps.kind !== "local" && vps.managedBy !== "system";
        if (isRemoteHost && this.provisioning && !this.refreshedHosts.has(vps.id)) {
          this.triggerRemoteUpdaterRefresh(vps.id, conv, nowMs);
          // Defer candidate job creation until remote updater refresh completes in this process
          continue;
        }

        // Candidate ready!
        if (hasExecuting || candidateCreatedThisTick) {
          break;
        }

        try {
          const isRetry = Boolean(
            conv?.retryBuildId === bundled.buildId && conv?.retryKey,
          );
          const idempotencyKey = isRetry
            ? `retry_${vps.id}_${conv!.retryKey}_${newLocalUpgradeId()}`
            : `conv_${vps.id}_${bundled.buildId}_${newLocalUpgradeId()}`;

          const result = await this.localUpgradeService.createJob(
            vps.id,
            { releaseId: bundled.buildId },
            {
              idempotencyKey,
              retryRequestKey: isRetry ? conv!.retryKey! : undefined,
              actor: "convergence",
            },
          );
          if (result.created) {
            candidateCreatedThisTick = true;
          }
        } catch {
          // Job creation contention or validation handled nonfatally
        }
      }
    } finally {
      // Tick complete
    }
  }

  private triggerRemoteUpdaterRefresh(
    vpsId: string,
    conv: AgentConvergenceRecord | undefined,
    nowMs: number,
  ): boolean {
    if (!this.provisioning || this.refreshedHosts.has(vpsId)) {
      return false;
    }
    const canAttemptSetup =
      !conv?.nextSetupAttemptAt ||
      Date.parse(conv.nextSetupAttemptAt) <= nowMs;
    if (!canAttemptSetup || this.activeSetupVpsId !== null) {
      return false;
    }
    this.activeSetupVpsId = vpsId;
    const targetVpsId = vpsId;
    const nextAttemptAt = new Date(nowMs + 60_000).toISOString();
    this.provisioning
      .ensureBundled(targetVpsId)
      .then(async (provResult) => {
        if (provResult.status === "enrolled") {
          this.refreshedHosts.add(targetVpsId);
        }
        const setupState =
          provResult.status === "enrolled"
            ? "ready"
            : provResult.status === "needs_access"
            ? "needs_access"
            : "failed";
        await this.repository.updateConvergence(targetVpsId, {
          setupState,
          setupReason: provResult.reason ?? null,
          nextSetupAttemptAt: setupState === "ready" ? null : nextAttemptAt,
        });
      })
      .catch(async (err: unknown) => {
        await this.repository.updateConvergence(targetVpsId, {
          setupState: "failed",
          setupReason:
            err instanceof Error ? err.message : "bootstrap_failed",
          nextSetupAttemptAt: nextAttemptAt,
        });
      })
      .finally(() => {
        const wasEnrolled = this.refreshedHosts.has(targetVpsId);
        if (this.activeSetupVpsId === targetVpsId) {
          this.activeSetupVpsId = null;
        }
        if (wasEnrolled) {
          setImmediate(() => {
            void this.tick();
          });
        }
      });
    return true;
  }
}
