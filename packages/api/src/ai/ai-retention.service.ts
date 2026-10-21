import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/app-config.js";
import { AI_REPOSITORY, APP_CONFIG, VPS_REPOSITORY } from "../tokens.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import { AI_ACTIVE_TASK_STATES } from "../persistence/repositories/ai.persistence.js";
import type { AiTaskState } from "./ai.models.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { DashboardSessionService } from "../auth/dashboard-session.service.js";

export type AiRetentionHealth = {
  status: "healthy" | "degraded" | "unknown";
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  runs: number;
  failures: number;
  lastTasksPruned: number;
  lastBlobsPruned: number;
  lastTasksRecovered: number;
};

@Injectable()
export class AiRetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AiRetentionService.name);
  private intervalTimer: NodeJS.Timeout | null = null;
  private passInFlight: Promise<void> | null = null;
  private stopping = false;
  private healthState: AiRetentionHealth = {
    status: "unknown",
    runs: 0,
    failures: 0,
    lastTasksPruned: 0,
    lastBlobsPruned: 0,
    lastTasksRecovered: 0,
  };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(DashboardSessionService)
    private readonly dashboardSessions: DashboardSessionService,
  ) {}
  getHealth(): AiRetentionHealth {
    return { ...this.healthState };
  }

  onApplicationBootstrap(): void {
    if (this.config.mode === "demo") return;
    this.stopping = false;
    if (this.intervalTimer) return;
    void this.runOnce();
    // 5-second interval ensures rapid session revocation and stale planning unblock
    const intervalSeconds = 5;
    this.intervalTimer = setInterval(() => {
      void this.runOnce();
    }, intervalSeconds * 1000);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    await this.passInFlight;
  }

  async runOnce(): Promise<void> {
    if (this.stopping || this.passInFlight) return;
    this.passInFlight = Promise.resolve()
      .then(async () => {
        const startedAt = new Date().toISOString();
        this.healthState = {
          ...this.healthState,
          status: "degraded",
          lastRunAt: startedAt,
          runs: this.healthState.runs + 1,
        };

        // 1. Reconcile active tasks across all VPS instances
        const recoveredCount = await this.reconcileActiveTasks();

        // 2. Prune terminal tasks and expired blobs periodically (every 60 cycles = ~300s) or on initial run
        let tasksPruned = 0;
        let blobsPruned = 0;
        if (this.healthState.runs === 1 || this.healthState.runs % 60 === 0) {
          const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          const keepStates: AiTaskState[] = [...AI_ACTIVE_TASK_STATES, "uncertain"];
          tasksPruned = await this.repository.deleteTerminalTasksOlderThan(thirtyDaysAgo, keepStates);
          blobsPruned = await this.repository.deleteExpiredExecutionBlobs(new Date().toISOString());
        }
        this.healthState = {
          ...this.healthState,
          status: "healthy",
          lastSuccessAt: new Date().toISOString(),
          lastTasksPruned: tasksPruned,
          lastBlobsPruned: blobsPruned,
          lastTasksRecovered: recoveredCount,
          lastError: undefined,
        };
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        const errMessage = error instanceof Error ? error.message : String(error);
        this.healthState = {
          ...this.healthState,
          status: "degraded",
          lastFailureAt: new Date().toISOString(),
          failures: this.healthState.failures + 1,
          lastError: errMessage,
        };
        this.logger.error("AI retention/recovery pass failed", errMessage);
      })
      .finally(() => {
        this.passInFlight = null;
      });

    await this.passInFlight;
  }

  private async reconcileActiveTasks(): Promise<number> {
    let recoveredCount = 0;
    const vpsList = await this.vpsRepository.list().catch(() => []);
    const now = Date.now();

    for (const vps of vpsList) {
      const activeTask = await this.repository.getActiveTask(vps.id).catch(() => undefined);
      if (!activeTask) continue;

      const stored = activeTask as typeof activeTask & {
        initiatingSessionId?: string;
        ownerLeaseExpiresAt?: string;
      };

      // Check session revocation: initiating session or plan approved session
      let sessionRevoked = false;
      if (stored.initiatingSessionId) {
        const active = await this.dashboardSessions.authenticateById(stored.initiatingSessionId);
        if (!active) sessionRevoked = true;
      }
      if (activeTask.plan?.approvedSessionId) {
        const active = await this.dashboardSessions.authenticateById(activeTask.plan.approvedSessionId);
        if (!active) sessionRevoked = true;
      }

      if (sessionRevoked) {
        if (activeTask.state === "executing" || activeTask.state === "verifying") {
          // Transition to cancel_requested so executing agent stops
          try {
            await this.repository.updateTask({
              id: activeTask.id,
              expectedRevision: activeTask.revision,
              state: "cancel_requested",
              error: {
                code: "session_revoked",
                message: "Initiating or approving session has expired or been revoked",
              },
            });
            await this.repository.appendAuditEvent({
              id: randomUUID(),
              actorSessionId: "system",
              vpsId: vps.id,
              taskId: activeTask.id,
              operationId: "session_revoke_reconcile",
              resultCode: "session_revoked",
              createdAt: new Date().toISOString(),
            });
            recoveredCount++;
          } catch {
            // Task revision changed concurrently; skip for next pass
          }
        } else if (
          activeTask.state === "planning" ||
          activeTask.state === "awaiting_approval" ||
          activeTask.state === "awaiting_input"
        ) {
          try {
            await this.repository.updateTask({
              id: activeTask.id,
              expectedRevision: activeTask.revision,
              state: "expired",
              plan: activeTask.plan ? { ...activeTask.plan, status: "expired" } : undefined,
              error: {
                code: "session_revoked",
                message: "Session revoked before plan execution",
              },
            });
            await this.repository.appendAuditEvent({
              id: randomUUID(),
              actorSessionId: "system",
              vpsId: vps.id,
              taskId: activeTask.id,
              operationId: "session_revoke_reconcile",
              resultCode: "session_revoked",
              createdAt: new Date().toISOString(),
            });
            recoveredCount++;
          } catch {
            // Task revision changed concurrently
          }
        }
        continue;
      }

      // Check task expiration (awaiting_approval, awaiting_input, planning)
      const isStalePlanning =
        activeTask.state === "planning" &&
        stored.ownerLeaseExpiresAt &&
        new Date(stored.ownerLeaseExpiresAt).getTime() <= now;

      const isExpiredAwaiting =
        (activeTask.state === "awaiting_approval" ||
          activeTask.state === "awaiting_input" ||
          activeTask.state === "planning") &&
        activeTask.expiresAt &&
        new Date(activeTask.expiresAt).getTime() <= now;

      if (isStalePlanning || isExpiredAwaiting) {
        try {
          await this.repository.updateTask({
            id: activeTask.id,
            expectedRevision: activeTask.revision,
            state: "expired",
            plan: activeTask.plan ? { ...activeTask.plan, status: "expired" } : undefined,
            error: {
              code: "approval_expired",
              message: isStalePlanning
                ? "Planning lease expired following crash or disconnect"
                : "Task awaiting input or approval expired",
            },
          });
          await this.repository.appendAuditEvent({
            id: randomUUID(),
            actorSessionId: "system",
            vpsId: vps.id,
            taskId: activeTask.id,
            operationId: "task_expired_reconcile",
            resultCode: "approval_expired",
            createdAt: new Date().toISOString(),
          });
          recoveredCount++;
        } catch {
          // Task revision changed concurrently
        }
        continue;
      }
      // Check owner lease expiration for executing/verifying tasks
      if (
        (activeTask.state === "executing" || activeTask.state === "verifying") &&
        stored.ownerLeaseExpiresAt &&
        new Date(stored.ownerLeaseExpiresAt).getTime() <= now
      ) {
        try {
          await this.repository.updateTask({
            id: activeTask.id,
            expectedRevision: activeTask.revision,
            state: "uncertain",
            error: {
              code: "uncertain_outcome",
              message: "Execution lease expired without receipt",
            },
          });
          await this.repository.appendAuditEvent({
            id: randomUUID(),
            actorSessionId: "system",
            vpsId: vps.id,
            taskId: activeTask.id,
            operationId: "lease_expired_reconcile",
            resultCode: "uncertain_outcome",
            createdAt: new Date().toISOString(),
          });
          recoveredCount++;
        } catch {
          // Task revision changed concurrently
        }
      }
    }

    return recoveredCount;
  }
}
