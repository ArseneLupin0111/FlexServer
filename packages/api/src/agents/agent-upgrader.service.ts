import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import type { AgentState } from "./agent.models.js";
import type { VpsRecord } from "../vps/vps.models.js";
import {
  APP_CONFIG,
  AGENT_REPOSITORY,
  VPS_REPOSITORY,
  KEY_SERVICE,
} from "../tokens.js";
import { VpsNotFoundError } from "../common/errors.js";
import {
  AGENT_LIFECYCLE_LOCK,
  buildLifecycleLockAcquireCommand,
  buildLifecycleLockReleaseCommand,
  buildDockerStateProvisionCommand,
  buildManagedProcessInspectCommand,
  buildManagedProcessStopCommand,
  buildTransactionalStartCommand,
} from "./agent-lifecycle-remote.js";

const DIR = ".vps-manager-agent";
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

type AgentIdentity = {
  raw: string;
  version: string;
  buildId?: string;
};

function parseAgentIdentity(raw: string): AgentIdentity {
  const trimmed = raw.trim();
  const plusIdx = trimmed.lastIndexOf("+");
  if (plusIdx !== -1) {
    const candidateBuildId = trimmed.slice(plusIdx + 1);
    const candidateVersion = trimmed.slice(0, plusIdx);
    if (GIT_SHA_RE.test(candidateBuildId) && candidateVersion.length > 0) {
      return {
        raw: trimmed,
        version: candidateVersion,
        buildId: candidateBuildId,
      };
    }
  }
  return {
    raw: trimmed,
    version: trimmed,
  };
}
export type AgentUpgradePolling = {
  intervalMs: number;
  timeoutMs: number;
  sleep(ms: number): Promise<void>;
};
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function q(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function validHome(value: string) {
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

@Injectable()
export class AgentUpgraderService {
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
    @Optional() private readonly polling?: Partial<AgentUpgradePolling>,
  ) {}

  async upgrade(vpsId: string): Promise<{ jobId: string; state: AgentState }> {
    const release = await this.lifecycle.tryAcquire(vpsId, "upgrade");
    let handedOff = false;
    try {
      const vps = await this.vpss.get(vpsId);
      if (!vps) throw new VpsNotFoundError();
      const state = await this.agents.getState(vpsId);
      if (!state || state.status === "not_installed" || !state.version) {
        throw new BadRequestException(
          "An installed agent is required before upgrade",
        );
      }
      if (!vps.keyProvisionedAt)
        throw new BadRequestException(
          "Agent upgrade requires a provisioned SSH key",
        );
      let privateKey: string;
      try {
        privateKey = await this.keys.readPrivateKey(vpsId);
      } catch {
        throw new BadRequestException(
          "SSH private key not found. Provision the key again.",
        );
      }
      const binaryPath = this.binaryPath();
      const candidate = readFileSync(binaryPath);
      const checksum = createHash("sha256").update(candidate).digest("hex");
      const job = await this.jobs.create({
        vpsId,
        type: "upgrade-agent",
        status: "queued",
        step: "queued",
        progress: 0,
        startedAt: new Date().toISOString(),
      });
      await this.audit
        .record({
          actor: "system",
          action: "agent.upgrade.start",
          resourceType: "vps",
          resourceId: vpsId,
          result: "success",
          metadata: { jobId: job.id },
        })
        .catch(() => undefined);
      this.runner.start(job, async (ctx) => {
        try {
          const version = await this.run(
            vps,
            privateKey,
            candidate,
            checksum,
            state,
            ctx,
          );
          await this.audit.record({
            actor: "system",
            action: "agent.upgrade.success",
            resourceType: "vps",
            resourceId: vpsId,
            result: "success",
            metadata: { jobId: job.id, version },
          });
          await ctx.succeed("complete");
        } catch (error) {
          const message = sanitiseError(error);
          await this.audit
            .record({
              actor: "system",
              action: "agent.upgrade.failure",
              resourceType: "vps",
              resourceId: vpsId,
              result: "failure",
              metadata: { jobId: job.id, error: message },
            })
            .catch(() => undefined);
          throw error;
        } finally {
          release();
        }
      });
      handedOff = true;
      return { jobId: job.id, state };
    } finally {
      if (!handedOff) release();
    }
  }

  private async run(
    vps: VpsRecord,
    privateKey: string,
    candidate: Buffer,
    checksum: string,
    prior: AgentState,
    ctx: JobTaskContext,
  ) {
    const auth = { privateKey };
    await ctx.update("connecting", 5);
    const home = (
      await this.ssh.execCommand(vps, "printf '%s\\n' \"$HOME\"", auth, 10_000)
    ).stdout.trim();
    if (!validHome(home)) throw new Error("Invalid remote home directory");
    const dir = `${home}/${DIR}`,
      binary = `${dir}/vps-agent`,
      config = `${dir}/config.json`;
    const pidFile = `${dir}/vps-agent.pid`,
      lock = `${dir}/${AGENT_LIFECYCLE_LOCK}`;
    const nonce = randomBytes(12).toString("hex");
    const staged = `${dir}/vps-agent.stage-${nonce}`,
      backup = `${dir}/vps-agent.backup-${nonce}`;
    const lockResult = await this.ssh.execCommand(
      vps,
      buildLifecycleLockAcquireCommand(lock),
      auth,
      10_000,
    );
    if (lockResult.stdout.trim() !== "acquired")
      throw new ConflictException("Agent upgrade lock is already held");
    let swapped = false,
      candidateIdentity: AgentIdentity = { raw: "", version: "" };
    try {
      await ctx.update("staging", 15);
      await this.ssh.uploadFile(vps, staged, candidate, 0o700, auth);
      await this.ssh.execCommand(
        vps,
        `chmod 700 -- ${q(staged)} && test \"$(sha256sum -- ${q(staged)} | cut -d' ' -f1)\" = ${q(checksum)}`,
        auth,
        15_000,
      );
      const versionOut = (
        await this.ssh.execCommand(vps, `${q(staged)} -version`, auth, 10_000)
      ).stdout.trim();
      if (!VERSION_RE.test(versionOut))
        throw new Error("Candidate returned an invalid version");
      candidateIdentity = parseAgentIdentity(versionOut);
      if (!VERSION_RE.test(candidateIdentity.version))
        throw new Error("Candidate returned an invalid version");
      await ctx.update("validating", 30);
      // Provision Docker identity/runtime state with the staged binary
      // BEFORE touching the live service. Fail-closed: a non-zero exit rejects
      // here, so the live agent keeps running untouched and the staged binary
      // is cleaned up. An existing identity is preserved (state.Provision is
      // idempotent) — never rotated on upgrade.
      await this.ssh.execCommand(
        vps,
        buildDockerStateProvisionCommand(staged, dir),
        auth,
        30_000,
      );
      await this.ssh.execCommand(
        vps,
        `${q(staged)} -config ${q(config)} -validate-config`,
        auth,
        30_000,
      );
      // Snapshot only after it finishes so that observation cannot prove the
      // subsequently started background process is healthy.
      await ctx.update("identifying-process", 40);
      const inspect = buildManagedProcessInspectCommand(
        binary,
        config,
        pidFile,
      );
      const ownership = (
        await this.ssh.execCommand(vps, inspect, auth, 10_000)
      ).stdout.trim();
      const owned = /^owned:([1-9][0-9]*):([1-9][0-9]*)$/.exec(ownership);
      if (owned) {
        await ctx.update("stopping", 50);
        await this.stopPid(vps, auth, binary, config, owned[1], owned[2]);
      } else if (ownership === "none") {
        // Ensure any systemd service in activating/auto-restarting state is stopped
        await this.stopService(vps, auth, binary, config);
      } else {
        throw new Error(
          "Managed agent process ownership is missing or ambiguous",
        );
      }
      const postStopBaseline =
        (await this.agents.getState(vps.id))?.lastSeenAt ?? prior.lastSeenAt;
      await ctx.update("swapping", 60);
      await this.ssh.execCommand(
        vps,
        `test -f ${q(binary)} && mv -- ${q(binary)} ${q(backup)} && mv -- ${q(staged)} ${q(binary)}`,
        auth,
        10_000,
      );
      swapped = true;
      await this.start(vps, auth, binary, config, pidFile, dir);
      await ctx.update("verifying-ingest", 80);
      await this.waitForObservation(vps.id, postStopBaseline, candidateIdentity);
      await this.ssh.execCommand(vps, `rm -f -- ${q(backup)}`, auth, 10_000);
      return candidateIdentity.raw;
    } catch (candidateError) {
      if (!swapped) {
        await this.ssh
          .execCommand(vps, `rm -f -- ${q(staged)}`, auth, 10_000)
          .catch(() => undefined);
        throw candidateError;
      }
      try {
        await ctx.update("rolling-back", 90);
        await this.stopOwned(vps, auth, binary, config, pidFile, dir);
        await this.ssh.execCommand(
          vps,
          `test -f ${q(backup)} && mv -f -- ${q(backup)} ${q(binary)}`,
          auth,
          10_000,
        );
        const beforeRollback = (await this.agents.getState(vps.id))?.lastSeenAt;
        await this.start(vps, auth, binary, config, pidFile, dir);
        await this.waitForObservation(vps.id, beforeRollback, {
          version: prior.version!,
          buildId: prior.buildId,
        });
        await this.ssh.execCommand(vps, `rm -f -- ${q(staged)}`, auth, 10_000);
      } catch {
        throw new Error(
          "Agent upgrade failed and rollback could not be verified; recovery artifacts were preserved",
        );
      }
      throw candidateError;
    } finally {
      await this.ssh
        .execCommand(vps, buildLifecycleLockReleaseCommand(lock), auth, 10_000)
        .catch(() => undefined);
    }
  }

  private async start(
    vps: VpsRecord,
    auth: { privateKey: string },
    binary: string,
    config: string,
    pidFile: string,
    dir: string,
  ) {
    const homeDir = dir.replace(/\/.vps-manager-agent$/, "");
    const cmd = buildTransactionalStartCommand(binary, config, pidFile, {
      vpsId: vps.id,
      user: vps.username || "root",
      homeDir,
    });
    await this.ssh.execCommand(vps, cmd, auth, 10_000);
  }
  private async stopOwned(
    vps: VpsRecord,
    auth: { privateKey: string },
    binary: string,
    config: string,
    pidFile: string,
    dir?: string,
  ) {
    const result = await this.ssh.execCommand(
      vps,
      buildManagedProcessInspectCommand(binary, config, pidFile),
      auth,
      10_000,
    );
    const inspect = result.stdout.trim();
    const owned = /^owned:([1-9][0-9]*):([1-9][0-9]*)$/.exec(inspect);
    if (owned) {
      await this.stopPid(vps, auth, binary, config, owned[1], owned[2]);
    } else if (inspect === "none") {
      await this.stopService(vps, auth, binary, config);
    } else {
      throw new Error(
        "Managed agent process ownership is missing or ambiguous",
      );
    }
  }
  private async stopPid(
    vps: VpsRecord,
    auth: { privateKey: string },
    binary: string,
    config: string,
    pid: string,
    starttime: string,
  ) {
    await this.ssh.execCommand(
      vps,
      buildManagedProcessStopCommand(binary, config, pid, starttime, {
        vpsId: vps.id,
      }),
      auth,
      10_000,
    );
  }
  private async stopService(
    vps: VpsRecord,
    auth: { privateKey: string },
    binary: string,
    config: string,
  ) {
    await this.ssh.execCommand(
      vps,
      buildManagedProcessStopCommand(binary, config, undefined, undefined, {
        vpsId: vps.id,
      }),
      auth,
      10_000,
    );
  }
  private async waitForObservation(
    vpsId: string,
    baseline: string | undefined,
    expected: { version: string; buildId?: string },
  ) {
    const base =
      baseline && Number.isFinite(Date.parse(baseline))
        ? Date.parse(baseline)
        : 0;
    const intervalMs = this.polling?.intervalMs ?? 500;
    const timeoutMs =
      this.polling?.timeoutMs ??
      Math.max(60_000, this.config.agentInstallIntervalSeconds * 3_000);
    const sleep = this.polling?.sleep ?? defaultSleep;
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    for (let i = 0; i < attempts; i++) {
      const state = await this.agents.getState(vpsId);
      const seen = state?.lastSeenAt ? Date.parse(state.lastSeenAt) : NaN;
      if (
        state?.version === expected.version &&
        (!expected.buildId || state.buildId === expected.buildId) &&
        Number.isFinite(seen) &&
        seen > base
      )
        return;
      await sleep(intervalMs);
    }
    throw new Error("Timed out waiting for upgraded agent observation");
  }
  private binaryPath() {
    const candidates = [
      this.config.agentBinaryPath,
      "/app/agent/vps-agent-linux-amd64",
      join(process.cwd(), "agent", "vps-agent-linux-amd64"),
      join(process.cwd(), "packages", "agent", "dist", "vps-agent-linux-amd64"),
    ].filter((x): x is string => Boolean(x));
    const path = candidates.find(existsSync);
    if (!path) throw new BadRequestException("Agent binary not found");
    return path;
  }
}
