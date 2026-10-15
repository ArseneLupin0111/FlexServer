import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/app-config.js";
import {
  DuplicateAgentInstallError,
  VpsNotFoundError,
} from "../common/errors.js";
import type { AgentState } from "./agent.models.js";
import type { VpsRecord } from "../vps/vps.models.js";
import { AgentService } from "./agent.service.js";
import { SshService } from "../ssh/ssh.service.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { KeyService } from "../ssh/keyService.js";
import { AuditService } from "../audit/audit.service.js";
import { JobRunnerService } from "../jobs/job-runner.service.js";
import { JobService } from "../jobs/job.service.js";
import { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import {
  buildDockerStateProvisionCommand,
  buildTransactionalStartCommand,
} from "./agent-lifecycle-remote.js";
import { resolveAgentBackendUrl } from "./agent-backend-url.js";
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

/**
 * Build auth object for SSH operations.
 * Prefers private key if keyProvisionedAt, falls back to password when supplied.
 */
function resolveSshAuth(
  vps: VpsRecord,
  password: string | undefined,
  keys: KeyService,
):
  | { password?: string; privateKey?: string }
  | Promise<{ password?: string; privateKey?: string }> {
  if (vps.keyProvisionedAt) {
    // Private key available — prefer it
    const readKey = async () => {
      try {
        const privateKey = await keys.readPrivateKey(vps.id);
        return { privateKey };
      } catch (error: unknown) {
        throw new BadRequestException(
          `SSH private key not found for VPS "${vps.id}". Reinstall the key first.`,
        );
      }
    };
    return readKey();
  }
  if (password) {
    return { password };
  }
  throw new BadRequestException(
    "SSH authentication method not available. Either provision a key or provide a one-time password.",
  );
}

// ── Service ──────────────────────────────────────────────────────────────

@Injectable()
export class AgentInstallerService {
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

  /**
   * Start the one-click agent installation for a VPS.
   *
   * Returns immediately with job metadata. The actual install runs asynchronously
   * via the JobRunnerService.
   */
  async install(
    vpsId: string,
    password: string | undefined,
    _requestHost: string | undefined,
  ): Promise<{ jobId: string; state: AgentState }> {
    const releaseLifecycle = await this.lifecycle.tryAcquire(vpsId, "install");
    let handedOff = false;
    let priorState: AgentState | undefined;
    let credential: { id: string } | undefined;
    let job: Awaited<ReturnType<JobService["create"]>> | undefined;
    let state: AgentState | undefined;
    try {
      // 1. VPS must exist
      const vps = await this.vpsRepository.get(vpsId);
      if (!vps) throw new VpsNotFoundError();

      // 2. Block duplicate install
      const existingState = await this.agentRepository.getState(vpsId);
      priorState = existingState;
      if (existingState?.status === "installing") {
        throw new DuplicateAgentInstallError();
      }

      // 3. Resolve backend URL (may throw if localhost/no config)
      const backendUrl = resolveAgentBackendUrl(this.config);

      // 4. Check agent binary exists locally
      const binaryPath = this.resolveBinaryPath();
      if (!existsSync(binaryPath)) {
        throw new BadRequestException(
          "Agent binary not found. Run 'npm run build:agent' first or configure AGENT_BINARY_PATH.",
        );
      }

      // 5. Resolve SSH auth
      const sshAuth = await resolveSshAuth(vps, password, this.keys);

      // 6. Create pending credential (token never returned to caller)
      const created = await this.agentService.createCredential(
        vpsId,
        "pending",
      );
      credential = created.credential;
      const token = created.token;

      // 7. Create job
      const now = new Date().toISOString();
      job = await this.jobs.create({
        vpsId,
        type: "install-agent",
        status: "queued",
        step: "queued",
        progress: 0,
        startedAt: now,
      });

      // 8. Mark state as installing
      state = await this.agentRepository.upsertState({
        vpsId,
        status: "installing",
        lastInstallJobId: job!.id,
      });

      // 9. Audit: install started
      await this.audit
        .record({
          actor: "system",
          action: "agent.install.start",
          resourceType: "vps",
          resourceId: vpsId,
          result: "success",
          metadata: { jobId: job!.id },
        })
        .catch(() => undefined);

      // 10. Start async install task
      this.jobRunner.start(job, async (ctx) => {
        try {
          await ctx.update("connecting", 5);

          // Determine remote home directory
          const homeResult = await this.ssh.execCommand(
            vps,
            "echo $HOME",
            sshAuth,
            10_000,
          );
          const homeDir = homeResult.stdout.trim();
          if (!homeDir) {
            throw new Error("Could not determine remote home directory");
          }
          const remoteDir = `${homeDir}/.vps-manager-agent`;

          await ctx.update("creating-directory", 10);
          await this.ssh.makeDirectory(vps, remoteDir, 0o700, sshAuth);

          await ctx.update("uploading-binary", 30);
          const binaryContent = readFileSync(binaryPath);
          const remoteBinary = `${remoteDir}/vps-agent`;
          await this.ssh.uploadFile(
            vps,
            remoteBinary,
            binaryContent,
            0o700,
            sshAuth,
          );

          // Build agent config — token embedded in config on VPS only
          const agentConfig = {
            backendUrl,
            vpsId,
            token,
            intervalSeconds: this.config.agentInstallIntervalSeconds,
            requestTimeoutSeconds: 10,
          };
          const configContent = Buffer.from(
            JSON.stringify(agentConfig, null, 2) + "\n",
            "utf8",
          );
          const remoteConfig = `${remoteDir}/config.json`;

          await ctx.update("uploading-config", 50);
          await this.ssh.uploadFile(
            vps,
            remoteConfig,
            configContent,
            0o600,
            sshAuth,
          );

          // Provision Docker identity/runtime state before any agent run.
          // Fail-closed: a non-zero exit rejects here, the install job fails,
          // and neither -once nor the background start is reached. An existing
          // identity is preserved (state.Provision is idempotent).
          await ctx.update("provisioning-docker-state", 60);
          await this.ssh.execCommand(
            vps,
            buildDockerStateProvisionCommand(remoteBinary, remoteDir),
            sshAuth,
            30_000,
          );

          // Run -validate-config offline validation
          await ctx.update("validating", 70);
          const validateCmd = `${shellQuote(remoteBinary)} -config ${shellQuote(remoteConfig)} -validate-config`;
          // 45s timeout for the preflight validation
          await this.ssh.execCommand(vps, validateCmd, sshAuth, 45_000);

          // Start background loop via transactional start
          await ctx.update("starting-background", 85);
          const pidFile = `${remoteDir}/vps-agent.pid`;
          const loopCmd = buildTransactionalStartCommand(
            remoteBinary,
            remoteConfig,
            pidFile,
            { vpsId, user: vps.username || undefined, homeDir },
          );
          await this.ssh.execCommand(vps, loopCmd, sshAuth, 10_000);
          // Mark success
          await this.agentRepository.upsertState({
            vpsId,
            status: "online",
            installedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            lastInstallJobId: job!.id,
          });

          await this.audit.record({
            actor: "system",
            action: "agent.install.success",
            resourceType: "vps",
            resourceId: vpsId,
            result: "success",
            metadata: { jobId: job!.id },
          });

          await ctx.succeed("complete");
        } catch (error: unknown) {
          await this.agentRepository.revokeCredential(credential!.id);

          // Mark state as failed
          await this.agentRepository.upsertState({
            vpsId,
            status: "failed",
            lastError: sanitiseError(error),
            lastSeenAt: priorState?.lastSeenAt,
            lastInstallJobId: job!.id,
          });

          await this.audit.record({
            actor: "system",
            action: "agent.install.failure",
            resourceType: "vps",
            resourceId: vpsId,
            result: "failure",
            metadata: { jobId: job!.id },
          });

          // Re-throw so JobRunnerService can also update job status
          throw error;
        } finally {
          releaseLifecycle();
        }
      });

      handedOff = true;
      return { jobId: job!.id, state: state! };
    } catch (error) {
      if (credential)
        await this.agentRepository.revokeCredential(credential.id);
      if (job)
        await this.jobs.update(job.id, {
          status: "failed",
          step: "setup",
          errorMessage: sanitiseError(error),
          finishedAt: new Date().toISOString(),
        });
      throw error;
    } finally {
      if (!handedOff) releaseLifecycle();
    }
  }

  private resolveBinaryPath(): string {
    if (this.config.agentBinaryPath) {
      return this.config.agentBinaryPath;
    }
    const candidates = [
      // Docker default path (set via AGENT_BINARY_PATH env in Dockerfile)
      "/app/agent/vps-agent-linux-amd64",
      // process.cwd() relative Docker default (when not set explicitly)
      join(process.cwd(), "agent", "vps-agent-linux-amd64"),
      // Source-tree development paths
      join(process.cwd(), "packages", "agent", "dist", "vps-agent-linux-amd64"),
      join(
        process.cwd(),
        "..",
        "..",
        "packages",
        "agent",
        "dist",
        "vps-agent-linux-amd64",
      ),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
    throw new BadRequestException(
      "Agent binary not found. The API Docker image includes the agent at /app/agent/vps-agent-linux-amd64. " +
        "For local development, run 'npm run build:agent' first. " +
        "You can also set AGENT_BINARY_PATH to override the search path.",
    );
  }
}
