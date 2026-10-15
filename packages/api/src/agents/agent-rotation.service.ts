import {
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { AppConfig } from "../config/app-config.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { AgentService } from "./agent.service.js";
import { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import type { AgentState } from "./agent.models.js";
import type { CommandJob } from "../jobs/jobs.models.js";
import { AuditService } from "../audit/audit.service.js";
import { JobService } from "../jobs/job.service.js";
import {
  JobRunnerService,
  sanitiseError,
} from "../jobs/job-runner.service.js";
import { APP_CONFIG, AGENT_REPOSITORY, VPS_REPOSITORY } from "../tokens.js";
import {
  DemoMutationBlockedError,
  VpsNotFoundError,
} from "../common/errors.js";
import { LocalAgentRotationHelper } from "./local-agent-rotation-helper.service.js";

/**
 * Local-only agent credential rotation.
 *
 * Two-phase swap: issue a `pending` credential, apply it through the
 * host helper, and only then activate the new credential and revoke the
 * old `active` ones. Helper failure revokes only the new pending
 * credential so the previous credential keeps working.
 *
 * The raw token never leaves this service (closure only); callers and
 * responses only see `{ jobId, credentialId }`.
 */
@Injectable()
export class AgentRotationService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(AGENT_REPOSITORY) private readonly agentRepository: AgentRepository,
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(JobRunnerService) private readonly jobRunner: JobRunnerService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AgentLifecycleCoordinator)
    private readonly lifecycle: AgentLifecycleCoordinator,
    @Inject(LocalAgentRotationHelper)
    private readonly helper: LocalAgentRotationHelper,
  ) {}

  async rotate(
    vpsId: string,
  ): Promise<{ jobId: string; credentialId: string; state?: AgentState }> {
    if (this.config.mode === "demo") throw new DemoMutationBlockedError();
    const vps = await this.vpsRepository.get(vpsId);
    if (!vps) throw new VpsNotFoundError();
    if (vps.kind !== "local" && vps.managedBy !== "system") {
      throw new BadRequestException(
        "Credential rotation is only available for the local/system-managed host",
      );
    }

    const release = await this.lifecycle.tryAcquire(vpsId, "rotate");
    let handedOff = false;
    let credentialId: string | undefined;
    let job: CommandJob | undefined;
    try {
      const created = await this.agentService.createCredential(
        vpsId,
        "pending",
        "agent",
      );
      credentialId = created.credential.id;
      const token = created.token;
      const previous = await this.agentRepository.listCredentialsByVps(vpsId);
      const previousActiveIds = previous
        .filter(
          (c) =>
            c.id !== credentialId &&
            c.status === "active" &&
            (c.scope ?? "agent") === "agent",
        )
        .map((c) => c.id);

      job = await this.jobs.create({
        vpsId,
        type: "rotate-agent",
        status: "queued",
        step: "queued",
        progress: 0,
        startedAt: new Date().toISOString(),
      });
      const dispatchedJob = job;
      const newCredentialId = credentialId;

      await this.audit
        .record({
          actor: "system",
          action: "agent.rotate.start",
          resourceType: "vps",
          resourceId: vpsId,
          result: "success",
          metadata: { jobId: dispatchedJob.id, credentialId: newCredentialId },
        })
        .catch(() => undefined);

      this.jobRunner.start(dispatchedJob, async (ctx) => {
        try {
          await ctx.update("rotating", 50);
          await this.helper.applyCredential(vpsId, token);

          await this.agentRepository.updateCredential(newCredentialId, {
            status: "active",
            activatedAt: new Date().toISOString(),
          });
          for (const id of previousActiveIds) {
            await this.agentRepository.revokeCredential(id);
          }

          await this.audit.record({
            actor: "system",
            action: "agent.rotate.success",
            resourceType: "vps",
            resourceId: vpsId,
            result: "success",
            metadata: {
              jobId: dispatchedJob.id,
              credentialId: newCredentialId,
            },
          });
          await ctx.succeed("complete");
        } catch (error: unknown) {
          await this.agentRepository.revokeCredential(newCredentialId);
          const message = sanitiseError(error);
          await this.audit
            .record({
              actor: "system",
              action: "agent.rotate.failure",
              resourceType: "vps",
              resourceId: vpsId,
              result: "failure",
              metadata: {
                jobId: dispatchedJob.id,
                credentialId: newCredentialId,
                error: message,
              },
            })
            .catch(() => undefined);
          throw error;
        } finally {
          release();
        }
      });

      handedOff = true;
      const state = await this.agentRepository.getState(vpsId);
      return { jobId: dispatchedJob.id, credentialId: newCredentialId, state };
    } catch (error: unknown) {
      if (credentialId) {
        await this.agentRepository.revokeCredential(credentialId).catch(
          () => undefined,
        );
      }
      if (job) {
        await this.jobs
          .update(job.id, {
            status: "failed",
            step: "setup",
            errorMessage: sanitiseError(error),
            finishedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (!handedOff) release();
    }
  }
}
