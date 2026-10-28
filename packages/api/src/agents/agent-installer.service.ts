import { BadRequestException, ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
  APP_CONFIG,
  AGENT_REPOSITORY,
  KEY_SERVICE,
  VPS_REPOSITORY,
} from "../tokens.js";
type Architecture = "amd64" | "arm64";

/** Extract "linux/<arch>" from `uname -m` output; null on anything else. */
function normalizeArchitecture(raw: string): Architecture | null {
  if (/arm64|aarch64/i.test(raw)) return "arm64";
  if (/x86_64|amd64/i.test(raw)) return "amd64";
  return null;
}
import { BundledAgentService } from "../local-upgrade/bundled-agent.service.js";
import {
  AGENT_LIFECYCLE_LOCK,
  buildDockerStateProvisionCommand,
  buildLifecycleLockAcquireCommand,
  buildLifecycleLockReleaseCommand,
  buildManagedProcessInspectCommand,
  buildManagedProcessStopCommand,
  buildTransactionalStartCommand,
} from "./agent-lifecycle-remote.js";
import { resolveAgentBackendUrl } from "./agent-backend-url.js";
import { sanitiseError } from "../jobs/job-runner.service.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function validInstallHome(value: string): boolean {
  return (
    value.startsWith("/") &&
    value !== "/" &&
    !/[\r\n\0]/.test(value) &&
    value
      .split("/")
      .slice(1)
      .every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function stageName(kind: "binary" | "config", nonce: string): string {
  return kind === "binary"
    ? `vps-agent.stage-${nonce}`
    : `config.stage-${nonce}.json`;
}

type Polling = {
  intervalMs: number;
  timeoutMs: number;
  sleep(ms: number): Promise<void>;
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    @Inject(BundledAgentService) private readonly bundledAgent: BundledAgentService,
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(AGENT_REPOSITORY) private readonly agentRepository: AgentRepository,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(KEY_SERVICE) private readonly keys: KeyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JobRunnerService) private readonly jobRunner: JobRunnerService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(AgentLifecycleCoordinator)
    private readonly lifecycle: AgentLifecycleCoordinator,
    @Optional() private readonly polling?: Partial<Polling>,
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

      // Determine reinstall status before starting
      const isReinstall =
        priorState !== undefined && priorState.status !== "not_installed";

      // 4. Agent binary selection happens after remote `uname -m` detection
      // inside the install job; no amd64 pre-check here so an arm64-only host
      // is never preempted before upload.

      // 5. Resolve SSH auth
      const sshAuth = await resolveSshAuth(vps, password, this.keys);

      // Create the job before the credential so a setup failure cannot leave a
      // pending token without an installing lifecycle checkpoint.
      const now = new Date().toISOString();
      job = await this.jobs.create({
        vpsId,
        type: "install-agent",
        status: "queued",
        step: "queued",
        progress: 0,
        startedAt: now,
      });

      // Credential creation and the installing state are one repository
      // transaction. Reconciliation cannot revoke a token between them.
      const created = await this.agentService.createInstallCredential(vpsId, job.id);
      credential = created.credential;
      const token = created.token;
      state = created.state;

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
        const nonce = randomBytes(12).toString("hex");
        let swapped = false;
        let priorCredentialsRevoked = false;
        let remoteLock = "";
        let lockAcquired = false;
        let hadBinary = false;
        let hadConfig = false;
        let stagedBinary = "";
        let stagedConfig = "";
        let backupBinary = "";
        let backupConfig = "";
        let liveDir = "";
        let liveBinary = "";
        let liveConfig = "";
        let livePidFile = "";
        let liveHome = "";
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
          if (!homeDir || !validInstallHome(homeDir)) {
            throw new Error("Could not determine remote home directory");
          }

          // Detect remote host architecture; unknown arch fails closed
          // (never guess amd64) before any upload occurs.
          const unameResult = await this.ssh.execCommand(vps, "uname -m", sshAuth, 10_000);
          const targetArch = normalizeArchitecture(unameResult.stdout);
          if (!targetArch) {
            throw new BadRequestException(
              `Unsupported remote architecture: ${unameResult.stdout.trim() || "(empty)"}`,
            );
          }
          liveDir = `${homeDir}/.vps-manager-agent`;
          liveBinary = `${liveDir}/vps-agent`;
          liveConfig = `${liveDir}/config.json`;
          livePidFile = `${liveDir}/vps-agent.pid`;
          liveHome = homeDir;
          const remoteDir = liveDir;
          const remoteBinary = liveBinary;
          const remoteConfig = liveConfig;
          const pidFile = livePidFile;
          remoteLock = `${remoteDir}/${AGENT_LIFECYCLE_LOCK}`;
          stagedBinary = `${remoteDir}/${stageName("binary", nonce)}`;
          stagedConfig = `${remoteDir}/${stageName("config", nonce)}`;
          backupBinary = `${remoteDir}/vps-agent.backup-${nonce}`;
          backupConfig = `${remoteDir}/config.backup-${nonce}.json`;

          await ctx.update("creating-directory", 10);
          await this.ssh.makeDirectory(vps, remoteDir, 0o700, sshAuth);

          // Serialize against concurrent lifecycle ops on the host.
          const lockResult = await this.ssh.execCommand(
            vps,
            buildLifecycleLockAcquireCommand(remoteLock),
            sshAuth,
            10_000,
          );
          if (lockResult.stdout.trim() !== "acquired") {
            throw new ConflictException(
              "Agent lifecycle lock is already held",
            );
          }
          lockAcquired = true;

          // Stage binary to a temp path — never overwrite the live executable
          // (Linux returns ETXTBSY/text-file-busy on open-for-write of a
          // running image). Staged path is removed on every failure path.
          await ctx.update("uploading-binary", 30);
          const binaryPath = this.resolveBinaryPath(targetArch);
          const binaryContent = readFileSync(binaryPath);
          const checksum = createHash("sha256")
            .update(binaryContent)
            .digest("hex");
          await this.ssh.uploadFile(
            vps,
            stagedBinary,
            binaryContent,
            0o700,
            sshAuth,
          );
          await this.ssh.execCommand(
            vps,
            `chmod 700 -- ${shellQuote(stagedBinary)} && test "$(sha256sum -- ${shellQuote(stagedBinary)} | cut -d' ' -f1)" = ${shellQuote(checksum)}`,
            sshAuth,
            15_000,
          );

          // Stage config with the new pending token — live config.json keeps
          // serving the running agent until cutover.
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

          await ctx.update("uploading-config", 50);
          await this.ssh.uploadFile(
            vps,
            stagedConfig,
            configContent,
            0o600,
            sshAuth,
          );

          // Pre-cutover preflight with the STAGED binary. Fail-closed: any
          // non-zero exit rejects here while the live agent keeps running
          // untouched on the old binary + old config + old credential.
          await ctx.update("provisioning-docker-state", 60);
          await this.ssh.execCommand(
            vps,
            buildDockerStateProvisionCommand(stagedBinary, remoteDir),
            sshAuth,
            30_000,
          );

          await ctx.update("validating", 70);
          await this.ssh.execCommand(
            vps,
            `${shellQuote(stagedBinary)} -config ${shellQuote(stagedConfig)} -validate-config`,
            sshAuth,
            45_000,
          );

          // Stop the verified old process/unit BEFORE committing the new
          // binary/config. Atomic rename-before-stop would leave a deleted
          // exe running and the transactional start a no-op that never loads
          // the new token.
          await ctx.update("stopping", 75);
          const ownership = (
            await this.ssh.execCommand(
              vps,
              buildManagedProcessInspectCommand(remoteBinary, remoteConfig, pidFile, {
                vpsId,
              }),
              sshAuth,
              10_000,
            )
          ).stdout.trim();
          const owned = /^owned:([1-9][0-9]*):([1-9][0-9]*)$/.exec(ownership);
          if (!owned && ownership !== "none") {
            throw new Error("Managed agent process ownership is missing or ambiguous");
          }
          const existing = await this.ssh.execCommand(vps,
            `test ! -e ${shellQuote(remoteBinary)} || printf binary; test ! -e ${shellQuote(remoteConfig)} || printf config`, sshAuth, 10_000);
          hadBinary = existing.stdout.includes("binary");
          hadConfig = existing.stdout.includes("config");
          await this.ssh.execCommand(vps, [
            hadBinary ? `cp -p -- ${shellQuote(remoteBinary)} ${shellQuote(backupBinary)}` : ":",
            hadConfig ? `cp -p -- ${shellQuote(remoteConfig)} ${shellQuote(backupConfig)}` : ":",
          ].join(" && "), sshAuth, 15_000);
          // Any failure from stop onward must restore the prior installation.
          swapped = true;
          if (owned) {
            await this.ssh.execCommand(
              vps,
              buildManagedProcessStopCommand(remoteBinary, remoteConfig, owned[1], owned[2], {
                vpsId,
              }),
              sshAuth,
              30_000,
            );
          } else if (ownership === "none") {
            await this.ssh.execCommand(
              vps,
              buildManagedProcessStopCommand(remoteBinary, remoteConfig, undefined, undefined, {
                vpsId,
              }),
              sshAuth,
              30_000,
            );
          } else {
            throw new Error(
              "Managed agent process ownership is missing or ambiguous",
            );
          }

          // Commit: backup live files (when present) then rename staged into
          // place. Fresh installs have nothing to back up.
          await ctx.update("swapping", 80);
          await this.ssh.execCommand(
            vps,
            [
              `mv -- ${shellQuote(stagedBinary)} ${shellQuote(remoteBinary)}`,
              `mv -- ${shellQuote(stagedConfig)} ${shellQuote(remoteConfig)}`,
            ].join(" && "),
            sshAuth,
            10_000,
          );

          // Start background loop via transactional start (existing safe
          // cutover: reconciles systemd unit, legacy pidfile, MainPID).
          await ctx.update("starting-background", 85);
          // Baseline captured immediately before the new agent is launched:
          // only credential usage / state strictly newer than this can prove
          // the staged binary + token actually took over.
          const baselineCredentialLastUsedAt = (
            await this.agentRepository.getCredential(credential!.id)
          )?.lastUsedAt;
          const baselineStateLastSeenAt = priorState?.lastSeenAt;
          const loopCmd = buildTransactionalStartCommand(
            remoteBinary,
            remoteConfig,
            pidFile,
            { vpsId, user: vps.username || undefined, homeDir },
          );
          await this.ssh.execCommand(vps, loopCmd, sshAuth, 10_000);
          // Bounded wait for a real observation: the freshly issued
          // credential must be active and used by an ingest strictly newer
          // than the pre-start baseline, and that ingest must have published
          // an online state with a version.
          await this.waitForReadyObservation(
            vpsId,
            credential!.id,
            baselineCredentialLastUsedAt,
            baselineStateLastSeenAt,
          );
          // Revoke older agent credentials atomically only after the new
          // credential has produced a fresh heartbeat; updater scope is untouched.
          const revokedCredentialIds =
            await this.agentRepository.revokeOtherActiveAgentCredentials(
              vpsId,
              credential!.id,
            );
          priorCredentialsRevoked = true;
          // Preserve the identity published by the real ingest (version,
          // buildId, lastSeenAt) — never synthesize lastSeenAt. Re-read so a
          // heartbeat that landed after the wait is not overwritten either.
          const observed = await this.agentRepository.getState(vpsId);
          await this.agentRepository.upsertState({
            ...observed,
            vpsId,
            status: "online",
            installedAt: observed?.installedAt ?? new Date().toISOString(),
            lastError: undefined,
            lastInstallJobId: job!.id,
          });

          await this.audit.record({
            actor: "system",
            action: "agent.install.success",
            resourceType: "vps",
            resourceId: vpsId,
            result: "success",
            metadata: {
              jobId: job!.id,
              ...(revokedCredentialIds.length > 0
                ? { revokedCredentialIds }
                : {}),
            },
          });

          await ctx.succeed("complete");
          await this.ssh.execCommand(vps,
            `rm -f -- ${shellQuote(backupBinary)} ${shellQuote(backupConfig)} ${shellQuote(stagedBinary)} ${shellQuote(stagedConfig)}`,
            sshAuth, 10_000).catch(() => undefined);
        } catch (error: unknown) {
          if (!swapped) {
            // Pre-cutover: live binary/config/credential untouched. Remove
            // staged artifacts only, revoke the pending credential, and keep
            // prior state fields (upsertState replaces the whole record).
            const staged = [stagedBinary, stagedConfig].filter((p) => p.length > 0);
            if (staged.length > 0) {
              await this.ssh
                .execCommand(
                  vps,
                  `rm -f -- ${staged.map((p) => shellQuote(p)).join(" ")}`,
                  sshAuth,
                  10_000,
                )
                .catch(() => undefined);
            }
            if (credential) {
              await this.agentRepository
                .revokeCredential(credential.id)
                .catch(() => undefined);
            }
            await this.recordInstallFailure(vpsId, job!.id, priorState, error);
          } else if (!priorCredentialsRevoked) {
            // Post-cutover, pre-revocation failure: old credentials still valid.
            // Restore old binary/config and restart the old agent so the failed
            // reinstall does not leave the host dark.
            // Rollback artifacts stay discoverable if this leg fails.
            try {
              await ctx.update("rolling-back", 90);
              await this.ssh.execCommand(vps,
                buildManagedProcessStopCommand(liveBinary, liveConfig, undefined, undefined, { vpsId }),
                sshAuth, 30_000);
              await this.ssh.execCommand(
                vps,
                [
                  hadBinary ? `mv -f -- ${shellQuote(backupBinary)} ${shellQuote(liveBinary)}` : `rm -f -- ${shellQuote(liveBinary)}`,
                  hadConfig ? `mv -f -- ${shellQuote(backupConfig)} ${shellQuote(liveConfig)}` : `rm -f -- ${shellQuote(liveConfig)}`,
                  `rm -f -- ${shellQuote(stagedBinary)} ${shellQuote(stagedConfig)}`,
                ].join(" && "),
                sshAuth,
                10_000,
              );
              if (hadBinary && hadConfig) {
                await this.ssh.execCommand(vps,
                  buildTransactionalStartCommand(liveBinary, liveConfig, livePidFile, {
                    vpsId, user: vps.username || undefined, homeDir: liveHome,
                  }), sshAuth, 30_000);
              }
            } catch {
              // Preserve backups for manual recovery; surface original error.
            }
            if (credential) {
              await this.agentRepository
                .revokeCredential(credential.id)
                .catch(() => undefined);
            }
            await this.recordInstallFailure(vpsId, job!.id, priorState, error);
          } else {
            // Post-cutover, post-revocation failure: prior credentials were
            // revoked atomically, so old binary/config cannot be restored
            // (their token is dead). The new agent is running and verified
            // online; clean up staged and backup files, keep the new credential
            // active, and leave state intact.
            await this.ssh
              .execCommand(
                vps,
                `rm -f -- ${shellQuote(backupBinary)} ${shellQuote(backupConfig)} ${shellQuote(stagedBinary)} ${shellQuote(stagedConfig)}`,
                sshAuth,
                10_000,
              )
              .catch(() => undefined);
          }

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
          if (lockAcquired) {
            await this.ssh
              .execCommand(
                vps,
                buildLifecycleLockReleaseCommand(remoteLock),
                sshAuth,
                10_000,
              )
              .catch(() => undefined);
          }
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

  /**
   * Bounded wait for proof that the newly issued credential and the staged
   * binary actually took over: credential active with usage strictly newer
   * than the pre-start baseline, plus an online state with a version and a
   * lastSeenAt strictly newer than the pre-start baseline.
   */
  private async waitForReadyObservation(
    vpsId: string,
    credentialId: string,
    baselineLastUsedAt: string | undefined,
    baselineLastSeenAt: string | undefined,
  ): Promise<void> {
    const interval = this.polling?.intervalMs ?? 500;
    const timeout =
      this.polling?.timeoutMs ??
      Math.max(60_000, this.config.agentInstallIntervalSeconds * 3_000);
    const nap = this.polling?.sleep ?? sleep;
    const credentialBaseline = Date.parse(baselineLastUsedAt ?? "");
    const stateBaseline = Date.parse(baselineLastSeenAt ?? "");
    for (let i = 0; i < Math.max(1, Math.ceil(timeout / interval)); i++) {
      const credential = await this.agentRepository.getCredential(credentialId);
      const state = await this.agentRepository.getState(vpsId);
      const usedAt = Date.parse(credential?.lastUsedAt ?? "");
      const seenAt = Date.parse(state?.lastSeenAt ?? "");
      if (
        credential?.status === "active" &&
        Number.isFinite(usedAt) &&
        (!Number.isFinite(credentialBaseline) || usedAt > credentialBaseline) &&
        state?.status === "online" &&
        typeof state.version === "string" &&
        state.version.length > 0 &&
        Number.isFinite(seenAt) &&
        (!Number.isFinite(stateBaseline) || seenAt > stateBaseline)
      ) {
        return;
      }
      await nap(interval);
    }
    throw new Error("Timed out waiting for installed agent observation");
  }

  /**
   * Record an install failure without blindly replacing identity that a real
   * ingest published while the install was running. `upsertState` replaces the
   * whole record, so keep the freshest observed identity (version / buildId /
   * lastSeenAt / installedAt) and only then stamp the failure.
   */
  private async recordInstallFailure(
    vpsId: string,
    jobId: string,
    priorState: AgentState | undefined,
    error: unknown,
  ): Promise<void> {
    const current = await this.agentRepository
      .getState(vpsId)
      .catch(() => undefined);
    const observed = Date.parse(current?.lastSeenAt ?? "");
    const previous = Date.parse(priorState?.lastSeenAt ?? "");
    const keepObserved =
      Number.isFinite(observed) &&
      (!Number.isFinite(previous) || observed > previous);
    const identity = keepObserved ? current : priorState;
    await this.agentRepository.upsertState({
      ...identity,
      vpsId,
      status: "failed",
      lastError: sanitiseError(error),
      lastInstallJobId: jobId,
    });
  }

  /**
   * Delegate arch-verified binary resolution to BundledAgentService: it
   * validates the ELF header per requested architecture, honours the explicit
   * AGENT_BINARY_PATH only when it genuinely targets that arch (else falls
   * back to a matching sibling) and returns null (never an amd64 guess) when
   * nothing valid exists.
   */
  private resolveBinaryPath(arch: Architecture): string {
    const path = this.bundledAgent.resolveBinaryPath(arch);
    if (!path) {
      throw new BadRequestException(
        `Host agent binary for ${arch} not found. Run 'npm run build:agent' first or configure AGENT_BINARY_PATH.`,
      );
    }
    return path;
  }
}
