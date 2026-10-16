import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "../config/app-config.js";
import {
  DuplicateAgentInstallError,
  VpsNotFoundError,
} from "../common/errors.js";
import type { AgentState } from "./agent.models.js";
import type { CommandJob } from "../jobs/jobs.models.js";
import type { VpsRecord } from "../vps/vps.models.js";
import { AgentService } from "./agent.service.js";
import { SshService } from "../ssh/ssh.service.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { KeyService } from "../ssh/keyService.js";
import { AuditService } from "../audit/audit.service.js";
import {
  JobRunnerService,
  type JobTaskContext,
} from "../jobs/job-runner.service.js";
import { JobService } from "../jobs/job.service.js";
import { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import { buildServiceUninstallCommand } from "./agent-lifecycle-remote.js";
import { sanitiseError } from "../jobs/job-runner.service.js";
import {
  APP_CONFIG,
  AGENT_REPOSITORY,
  VPS_REPOSITORY,
  KEY_SERVICE,
} from "../tokens.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const AGENT_DIR = ".vps-manager-agent";
const AGENT_BINARY = "vps-agent";

/**
 * Build the remote stop command for the agent process without using a broad
 * `pkill -f vps-agent` pattern.
 *
 * Strategy:
 *  1. If the agent left a pid file (`~/.vps-manager-agent/vps-agent.pid`),
 *     verify the recorded PID still maps to the exact agent binary, then send
 *     TERM to that PID only.
 *  2. As a targeted safety net, kill any process whose full command line
 *     matches the *exact* quoted binary path (`~/.vps-manager-agent/vps-agent`).
 *     This cannot match unrelated processes: the pattern is the full absolute
 *     binary path of the managed agent, never a bare process name.
 *  3. Always exit 0 — "no agent running" is a perfectly fine state.
 */
export function buildStopAgentCommand(remoteDir: string, vpsId?: string): string {
  return buildServiceUninstallCommand(remoteDir, vpsId);
}

// ── Service ──────────────────────────────────────────────────────────────

@Injectable()
export class AgentUninstallerService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(AGENT_REPOSITORY) private readonly agentRepository: AgentRepository,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(KEY_SERVICE) private readonly keys: KeyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JobRunnerService) private readonly jobRunner: JobRunnerService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(AgentLifecycleCoordinator)
    private readonly lifecycle: AgentLifecycleCoordinator,
  ) {}

  /** Keep the uninstall slot until local finalization has completed. */
  async removeForDelete(
    vpsId: string,
    finalize: (vps: VpsRecord) => Promise<void>,
  ): Promise<void> {
    const release = await this.lifecycle.tryAcquire(vpsId, "uninstall");
    try {
      const vps = await this.vpsRepository.get(vpsId);
      if (!vps) throw new VpsNotFoundError();
      if (vps.kind === "local" || vps.managedBy === "system") {
        throw new BadRequestException("Local host is managed by the built-in agent");
      }
      const state = await this.agentRepository.getState(vpsId);
      if (state?.status === "installing") throw new DuplicateAgentInstallError();
      const credentials = await this.agentRepository.listCredentialsByVps(vpsId);
      const verifiedRemoved = state?.status === "not_installed" &&
        credentials.every((credential) => credential.status === "revoked");
      const untouched = !vps.keyProvisionedAt && !state && credentials.length === 0 &&
        !(await this.agentRepository.getSystemInfo(vpsId));
      if (!verifiedRemoved && !untouched) {
        if (!vps.keyProvisionedAt) {
          throw new BadRequestException("Server removal requires a provisioned SSH key to clean up the agent. Provision the key and retry.");
        }
        let privateKey: string;
        try {
          privateKey = await this.keys.readPrivateKey(vpsId);
        } catch {
          throw new BadRequestException("SSH private key is unavailable. Provision the key again before removing this server.");
        }
        await this.runRemoteRemoval(vps, privateKey);
        for (const credential of credentials) {
          if (!(await this.agentRepository.revokeCredential(credential.id))) {
            throw new Error("Credential revocation failed");
          }
        }
      }
      // Durable checkpoint permits retry after key deletion or local cleanup failure.
      await this.agentRepository.upsertState({ vpsId, status: "not_installed" });
      await finalize(vps);
    } finally {
      release();
    }
  }

  /**
   * Start asynchronous agent removal for a VPS.
   *
   * Returns immediately with job metadata; the actual removal runs through
   * the JobRunnerService. Remote removal uses the provisioned SSH key and:
   *   1. stops the exact managed agent process,
   *   2. removes only ~/.vps-manager-agent,
   *   3. after successful remote removal revokes all agent credentials,
   *   4. clears stale agent state/system info/docker metrics and persists
   *      `not_installed`.
   */
  async uninstall(
    vpsId: string,
  ): Promise<{ jobId: string; state: AgentState }> {
    const releaseLifecycle = await this.lifecycle.tryAcquire(
      vpsId,
      "uninstall",
    );
    let handedOff = false;
    let priorState: AgentState | undefined;
    let job: CommandJob | undefined;
    let stateOverwritten = false;

    try {
      priorState = await this.agentRepository.getState(vpsId);
      // 1. VPS must exist and be remote/user-managed (controller/service level
      //    also enforce this, but re-check at the boundary).
      const vps = await this.vpsRepository.get(vpsId);
      if (!vps) throw new VpsNotFoundError();

      // 2. Block concurrent lifecycle work
      if (priorState?.status === "installing") {
        throw new DuplicateAgentInstallError();
      }

      // 3. Require a provisioned SSH key — uninstall must never fall back to a
      //    one-time password (that flow is install-only).
      if (!vps.keyProvisionedAt) {
        throw new BadRequestException(
          "Agent removal requires a provisioned SSH key. Provision a key first.",
        );
      }
      let privateKey: string;
      try {
        privateKey = await this.keys.readPrivateKey(vpsId);
      } catch {
        throw new BadRequestException(
          `SSH private key not found for VPS "${vpsId}". Provision the key again.`,
        );
      }

      // 4. Create job
      const now = new Date().toISOString();
      job = await this.jobs.create({
        vpsId,
        type: "uninstall-agent",
        status: "queued",
        step: "queued",
        progress: 0,
        startedAt: now,
      });
      const dispatchedJob = job;

      // 5. Mark state as installing so the UI shows a live in-flight action and
      //    blocks concurrent installs.
      const state = await this.agentRepository.upsertState({
        vpsId,
        status: "installing",
        lastInstallJobId: dispatchedJob.id,
      });
      stateOverwritten = true;

      // 6. Audit is best-effort and must not prevent dispatch.
      await this.audit
        .record({
          actor: "system",
          action: "agent.uninstall.start",
          resourceType: "vps",
          resourceId: vpsId,
          result: "success",
          metadata: { jobId: dispatchedJob.id },
        })
        .catch(() => undefined);

      // 7. Start async removal task
      this.jobRunner.start(dispatchedJob, async (ctx) => {
        try {
          await this.runRemoteRemoval(vps, privateKey, (step, progress) => ctx.update(step, progress));

          // Remote removal succeeded → revoke all credentials for this VPS.
          const credentials =
            await this.agentRepository.listCredentialsByVps(vpsId);
          for (const credential of credentials) {
            const revoked = await this.agentRepository.revokeCredential(
              credential.id,
            );
            if (!revoked) throw new Error("Credential revocation failed");
          }
          const remaining =
            await this.agentRepository.listCredentialsByVps(vpsId);
          if (
            remaining.some(
              (credential) =>
                credential.status === "active" ||
                credential.status === "pending",
            )
          ) {
            throw new Error("Active agent credentials remain");
          }

          // Clear stale agent state/system info, then persist the terminal
          // `not_installed` state.
          await this.agentRepository.deleteSystemInfo(vpsId);
          await this.agentRepository.upsertState({
            vpsId,
            status: "not_installed",
            lastInstallJobId: dispatchedJob.id,
          });

          await this.audit.record({
            actor: "system",
            action: "agent.uninstall.success",
            resourceType: "vps",
            resourceId: vpsId,
            result: "success",
            metadata: { jobId: dispatchedJob.id },
          });

          await ctx.succeed("complete");
        } catch (error: unknown) {
          const message = sanitiseError(error);

          // Preserve the last successful observation when removal fails.
          const previousState = priorState;
          await this.agentRepository.upsertState({
            vpsId,
            status: "failed",
            lastError: message,
            lastSeenAt: previousState?.lastSeenAt,
            lastInstallJobId: dispatchedJob.id,
          });

          await this.audit.record({
            actor: "system",
            action: "agent.uninstall.failure",
            resourceType: "vps",
            resourceId: vpsId,
            result: "failure",
            metadata: { jobId: dispatchedJob.id, error: message },
          });

          // Re-throw so JobRunnerService also marks the job failed.
          throw error;
        } finally {
          releaseLifecycle();
        }
      });
      handedOff = true;

      return { jobId: dispatchedJob.id, state };
    } catch (error: unknown) {
      const message = sanitiseError(error);
      if (job) {
        await this.jobs
          .update(job.id, {
            status: "failed",
            step: "setup",
            errorMessage: message,
            finishedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (stateOverwritten) {
        const recoveryState = priorState ?? {
          vpsId,
          status: "failed" as const,
          lastError: message,
          lastInstallJobId: job?.id,
        };
        await this.agentRepository
          .upsertState(recoveryState)
          .catch(() => undefined);
      } else if (job && !priorState) {
        await this.agentRepository
          .upsertState({
            vpsId,
            status: "failed",
            lastError: message,
            lastInstallJobId: job.id,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (!handedOff) releaseLifecycle();
    }
  }

  private async runRemoteRemoval(
    vps: VpsRecord,
    privateKey: string,
    report?: (step: string, progress: number) => Promise<void>,
  ): Promise<void> {
    const auth = { privateKey };

    // Determine remote home directory (same approach as the installer).
    await report?.("connecting", 5);
    const homeResult = await this.ssh.execCommand(
      vps,
      "echo $HOME",
      auth,
      10_000,
    );
    const homeDir = homeResult.stdout.trim();
    if (
      !homeDir ||
      /[\r\n]/.test(homeDir) ||
      !/^\/(?:[^\/]+\/)*[^\/]+$/.test(homeDir) ||
      homeDir === "/"
    ) {
      throw new Error("Invalid remote home directory");
    }
    const remoteDir = `${homeDir}/${AGENT_DIR}`;
    const qDir = shellQuote(remoteDir);

    // Stop and remove the managed service, ensuring process is stopped
    await report?.("stopping", 30);
    await this.ssh.execCommand(
      vps,
      buildStopAgentCommand(remoteDir, vps.id),
      auth,
      20_000,
    );

    // Remove only the agent directory.
    await report?.("removing-files", 60);
    await this.ssh.execCommand(vps, `if [ "$(id -u)" -eq 0 ]; then rm -rf -- ${qDir}; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n rm -rf -- ${qDir}; else rm -rf -- ${qDir}; fi`, auth, 15_000);

    // Verify removal so credentials are only revoked after the agent is gone.
    const check = await this.ssh.execCommand(
      vps,
      `test ! -e ${qDir} && echo removed || true`,
      auth,
      10_000,
    );
    if (!check.stdout.includes("removed")) {
      throw new Error("Agent directory could not be fully removed");
    }
  }
}
