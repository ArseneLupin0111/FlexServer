import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type { AppConfig } from "../config/app-config.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { KeyService } from "../ssh/keyService.js";
import { SshService } from "../ssh/ssh.service.js";
import { AuditService } from "../audit/audit.service.js";
import {
  JobRunnerService,
  sanitiseError,
  type JobTaskContext,
} from "../jobs/job-runner.service.js";
import { JobService } from "../jobs/job.service.js";
import { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import {
  AGENT_LIFECYCLE_LOCK,
  buildLifecycleLockAcquireCommand,
  buildLifecycleLockReleaseCommand,
  buildManagedProcessInspectCommand,
  buildManagedProcessStopCommand,
  buildTransactionalStartCommand,
  type ManagedProcessOptions,
} from "./agent-lifecycle-remote.js";
import {
  APP_CONFIG,
  AGENT_REPOSITORY,
  VPS_REPOSITORY,
  KEY_SERVICE,
} from "../tokens.js";
import { VpsNotFoundError } from "../common/errors.js";
import type { AgentState } from "./agent.models.js";
import type { VpsRecord } from "../vps/vps.models.js";

export const buildRestartInspectCommand = buildManagedProcessInspectCommand;
export function buildRestartStopCommand(
  binary: string,
  config: string,
  pidOrPidFile: string,
  starttime = "required-starttime",
  options?: ManagedProcessOptions,
) {
  return buildManagedProcessStopCommand(
    binary,
    config,
    pidOrPidFile,
    starttime,
    options,
  );
}
export const buildRestartStartCommand = buildTransactionalStartCommand;
export type { ManagedProcessOptions };

export function validAgentHome(home: string) {
  return (
    home.startsWith("/") &&
    home !== "/" &&
    !/[\0\r\n]/.test(home) &&
    home
      .split("/")
      .slice(1)
      .every((p) => p && p !== "." && p !== "..")
  );
}
type Polling = {
  intervalMs: number;
  timeoutMs: number;
  sleep(ms: number): Promise<void>;
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable()
export class AgentRestartService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(VPS_REPOSITORY) private readonly vpss: VpsRepository,
    @Inject(KEY_SERVICE) private readonly keys: KeyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JobRunnerService) private readonly runner: JobRunnerService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(AgentLifecycleCoordinator)
    private readonly lifecycle: AgentLifecycleCoordinator,
    @Optional() private readonly polling?: Partial<Polling>,
  ) {}

  async restart(vpsId: string): Promise<{ jobId: string; state: AgentState }> {
    const release = await this.lifecycle.tryAcquire(vpsId, "restart");
    let handed = false;
    try {
      const vps = await this.vpss.get(vpsId);
      if (!vps) throw new VpsNotFoundError();
      const state = await this.agents.getState(vpsId);
      if (
        !state ||
        !["online", "offline", "failed"].includes(state.status) ||
        !state.version
      )
        throw new BadRequestException(
          "An online, offline, or failed installed agent with a version is required before restart",
        );
      if (!vps.keyProvisionedAt)
        throw new BadRequestException(
          "Agent restart requires a provisioned SSH key",
        );
      let key: string;
      try {
        key = await this.keys.readPrivateKey(vpsId);
      } catch {
        throw new BadRequestException(
          "SSH private key not found. Provision the key again.",
        );
      }
      const job = await this.jobs.create({
        vpsId,
        type: "restart-agent",
        status: "queued",
        step: "queued",
        progress: 0,
        startedAt: new Date().toISOString(),
      });
      await this.audit
        .record({
          actor: "system",
          action: "agent.restart.start",
          resourceType: "vps",
          resourceId: vpsId,
          result: "success",
          metadata: { jobId: job.id },
        })
        .catch(() => undefined);
      this.runner.start(job, async (ctx) => {
        try {
          await this.run(vps, key, state.version!, ctx);
          await this.audit.record({
            actor: "system",
            action: "agent.restart.success",
            resourceType: "vps",
            resourceId: vpsId,
            result: "success",
            metadata: { jobId: job.id },
          });
          await ctx.succeed("complete");
        } catch (error) {
          const message = sanitiseError(error);
          await this.audit
            .record({
              actor: "system",
              action: "agent.restart.failure",
              resourceType: "vps",
              resourceId: vpsId,
              result: "failure",
              metadata: { jobId: job.id, error: message },
            })
            .catch(() => undefined);
          throw new Error(message);
        } finally {
          release();
        }
      });
      handed = true;
      return { jobId: job.id, state };
    } finally {
      if (!handed) release();
    }
  }

  private async run(
    vps: VpsRecord,
    key: string,
    version: string,
    ctx: JobTaskContext,
  ) {
    const auth = { privateKey: key };
    const exec = this.ssh.execCommandStrict.bind(this.ssh);
    await ctx.update("connecting", 5);
    const home = (
      await exec(vps, "printf '%s\\n' \"$HOME\"", auth, 10_000)
    ).stdout.trim();
    if (!validAgentHome(home)) throw new Error("Invalid remote home directory");
    const dir = `${home}/.vps-manager-agent`,
      binary = `${dir}/vps-agent`,
      config = `${dir}/config.json`,
      pidFile = `${dir}/vps-agent.pid`,
      lock = `${dir}/${AGENT_LIFECYCLE_LOCK}`;
    const acquired = (
      await exec(vps, buildLifecycleLockAcquireCommand(lock), auth, 10_000)
    ).stdout.trim();
    if (acquired !== "acquired")
      throw new ConflictException("Agent lifecycle lock is already held");
    try {
      const inspect = (
        await exec(
          vps,
          buildRestartInspectCommand(binary, config, pidFile, {
            vpsId: vps.id,
          }),
          auth,
          10_000,
        )
      ).stdout.trim();
      const owned = /^owned:([1-9][0-9]*):([1-9][0-9]*)$/.exec(inspect);
      if (owned) {
        await ctx.update("stopping", 30);
        await exec(
          vps,
          buildRestartStopCommand(binary, config, owned[1], owned[2], {
            vpsId: vps.id,
          }),
          auth,
          10_000,
        );
      } else if (inspect === "none") {
        // If the service is in auto-restart or activating state with no live PID,
        // ensure any existing systemd service is stopped before starting anew.
        await exec(
          vps,
          buildRestartStopCommand(binary, config, "0", "0", {
            vpsId: vps.id,
          }),
          auth,
          10_000,
        );
      } else {
        throw new Error(
          "Managed agent process ownership is missing or ambiguous",
        );
      }
      // Baseline is deliberately captured only after the prior process stopped.
      const baseline = (await this.agents.getState(vps.id))?.lastSeenAt;
      await ctx.update("starting", 60);
      await exec(
        vps,
        buildRestartStartCommand(binary, config, pidFile, {
          vpsId: vps.id,
          user: vps.username || "root",
          homeDir: home,
        }),
        auth,
        10_000,
      );
      await ctx.update("verifying-ingest", 80);
      await this.wait(vps.id, baseline, version);
    } finally {
      await exec(
        vps,
        buildLifecycleLockReleaseCommand(lock),
        auth,
        10_000,
      ).catch(() => undefined);
    }
  }

  private async wait(
    id: string,
    baseline: string | undefined,
    version: string,
  ) {
    const base = baseline ? Date.parse(baseline) : 0,
      interval = this.polling?.intervalMs ?? 500,
      timeout =
        this.polling?.timeoutMs ??
        Math.max(60_000, this.config.agentInstallIntervalSeconds * 3_000),
      nap = this.polling?.sleep ?? sleep;
    for (let i = 0; i < Math.max(1, Math.ceil(timeout / interval)); i++) {
      const state = await this.agents.getState(id);
      if (
        state?.version === version &&
        state.lastSeenAt &&
        Date.parse(state.lastSeenAt) > base
      )
        return;
      await nap(interval);
    }
    throw new Error("Timed out waiting for restarted agent observation");
  }
}
