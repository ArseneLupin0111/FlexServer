import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { AI_REPOSITORY, AGENT_REPOSITORY, AI_BUNDLE_TRANSPORT, APP_CONFIG, KEY_SERVICE, VPS_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type {
  AiBundleJobFinishInput,
  AiBundleJobRecord,
  AiBundleJobState,
  AiBundleJobTrigger,
  AiRepository,
} from "../persistence/repositories/ai.persistence.js";
import { redactString } from "../common/redaction.js";
import { AuditService } from "../audit/audit.service.js";
import { SshService } from "../ssh/ssh.service.js";
import type { KeyService } from "../ssh/keyService.js";
import type { VpsRecord } from "../vps/vps.models.js";
import {
  AiBundleService,
  type AiBundle,
  type AiBundleArchArtifacts,
  type AiBundleFileEntry,
} from "./ai-bundle.service.js";
import {
  AiLocalInstallService,
  type AiLocalJobWire,
  type AiLocalReleaseWire,
} from "./ai-local-install.service.js";

// ── AI bundle install/update orchestration (execmode plan Q1/Q7/Q8) ──────
//
// Schedules and executes per-VPS installs of the bundled AI artifacts over
// the saved-SSH channel, mirroring the FleetProvisioningService patterns
// (host-key pin enforcement + saved private key + sudo detection stay inside
// SshService; no second SSH stack). The SSH boundary is the injectable
// AiBundleInstallTransport interface so tests run fully offline.

export type AiBundleSshAuth = { password?: string; privateKey?: string };

export interface AiBundleInstallTransport {
  resolveAuth(vpsId: string): Promise<AiBundleSshAuth | null>;
  makeDirectory(
    vps: VpsRecord,
    remotePath: string,
    mode: number,
    auth: AiBundleSshAuth,
  ): Promise<void>;
  uploadFile(
    vps: VpsRecord,
    remotePath: string,
    content: Buffer,
    mode: number,
    auth: AiBundleSshAuth,
  ): Promise<void>;
  execCommand(
    vps: VpsRecord,
    command: string,
    auth: AiBundleSshAuth,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

/** Default transport: reuses SshService (pin/demo/audit machinery) and the
 * saved per-VPS private key exactly like FleetProvisioningService. */
@Injectable()
export class SshAiBundleInstallTransport implements AiBundleInstallTransport {
  constructor(
    // Explicit @Inject: vitest's esbuild transform does not emit
    // design:paramtypes, so implicit class-typed params are unresolvable.
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(KEY_SERVICE) private readonly keys: KeyService,
  ) {}

  async resolveAuth(vpsId: string): Promise<AiBundleSshAuth | null> {
    try {
      const privateKey = await this.keys.readPrivateKey(vpsId);
      if (privateKey && privateKey.trim().length > 0) return { privateKey };
    } catch {
      // No saved private key
    }
    return null;
  }

  makeDirectory(vps: VpsRecord, remotePath: string, mode: number, auth: AiBundleSshAuth) {
    return this.ssh.makeDirectory(vps, remotePath, mode, auth);
  }

  uploadFile(vps: VpsRecord, remotePath: string, content: Buffer, mode: number, auth: AiBundleSshAuth) {
    return this.ssh.uploadFile(vps, remotePath, content, mode, auth);
  }

  execCommand(vps: VpsRecord, command: string, auth: AiBundleSshAuth, timeoutMs: number) {
    return this.ssh.execCommand(vps, command, auth, timeoutMs);
  }
}

export type AiBundleCapabilityView = {
  supported: boolean;
  reason?: string;
  agentVersion?: string;
  privilegedSupported: boolean;
};

/** GET /api/vps/:id/ai/bundle response shape — the web client shares this
 * contract with the POST install response. */
export type AiBundleView = {
  available: boolean;
  /** Present only when available=false. */
  reason?: string;
  bundleId: string | null;
  /** True when the host ever reported an AI capability claim or a successful
   * bundle install was recorded (AI worker exists = bundle installed). */
  installed: boolean;
  lastInstalledBundleId: string | null;
  lastJob: {
    state: AiBundleJobState;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  capability: AiBundleCapabilityView;
  /** Install transport for this host: "updater" — local/system hosts whose
   * first AI install is pulled by their own updater from a signed release;
   * "ssh" — remote hosts pushed over saved SSH. Absent on degraded paths
   * (the web then keeps the legacy remote behavior). */
  installChannel?: "updater" | "ssh";
  /** Dashboard install (POST /install + deliberate/convergence triggers) is
   * only possible on remote SSH-managed hosts; false for local/system hosts
   * and when the host record cannot be resolved. On the updater channel this
   * reflects the local eligibility gates instead (fresh updater heartbeat
   * with the ai-install capability, signed release present, host idle). */
  installSupported?: boolean;
  /** Present only when installSupported=false: actionable guidance. */
  installReason?: string;
  /** Updater-channel job (installChannel "updater"); null on the SSH channel
   * and when no job has been scheduled. */
  localJob?: AiLocalJobWire | null;
  /** Release pinned by the updater-channel job; null when none. Kept strictly
   * separate from lastInstalledBundleId, which tracks the SSH/API-image
   * bundle and is never equated with a signed fleet release id. */
  localRelease?: AiLocalReleaseWire | null;
};

/** Local/system hosts have no SSH transport; when the updater channel is not
 * wired in this deployment the install stays fail-closed with this guidance. */
export const AI_BUNDLE_LOCAL_HOST_INSTALL_REASON =
  "Local host AI install is unavailable through the dashboard in this deployment; run scripts/install/install.sh --enable-ai on the host. Remote hosts install over saved SSH.";

/** Actionable reason when the VPS record cannot be resolved (not found or
 * store read failure): install support is unknown, NOT a local-host case. */
export const AI_BUNDLE_HOST_UNRESOLVED_INSTALL_REASON =
  "VPS record not found or unreadable — refresh the dashboard and retry; AI install support cannot be determined.";

/** Dashboard installs require a remote user-managed host with saved SSH. */
function isLocalOrSystemHost(vps: VpsRecord | undefined): boolean {
  return vps === undefined || vps.kind === "local" || vps.managedBy === "system";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Target arch from the agent system info with a fail-safe amd64 fallback
 * (slice contract: unknown/missing arch resolves to amd64, never throws). */
export function normalizeTargetArch(raw: string | undefined | null): "amd64" | "arm64" {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (trimmed === "arm64" || trimmed === "aarch64") return "arm64";
  return "amd64";
}

type OrchestrationOptions = {
  /** Deadline for the post-install confirming capability claim. */
  confirmDeadlineMs?: number;
  /** Poll cadence while waiting for the confirming claim. */
  confirmPollIntervalMs?: number;
  /** Convergence backoff after a failed job (Q7: the 15s tick must not
   * hammer SSH on repeated failures). */
  failureBackoffMs?: number;
  /** Wall-clock budget for the on-host installer run. */
  installerTimeoutMs?: number;
};

/** Injection token for the optional OrchestrationOptions overrides. Without
 * an explicit token Nest treats the bare `options` constructor param as a
 * class dependency and AppModule instantiation fails (the E2E fixture boots
 * the real app: a DI abort there kills every journey silently). */
export const AI_BUNDLE_ORCHESTRATION_OPTIONS = Symbol.for("AI_BUNDLE_ORCHESTRATION_OPTIONS");

const INSTALLER_COMMAND_TIMEOUT_MS = 300_000;
const CONFIRM_DEADLINE_MS = 120_000;
const CONFIRM_POLL_INTERVAL_MS = 2_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 10_000;

@Injectable()
export class AiBundleOrchestrationService {
  private readonly logger = new Logger(AiBundleOrchestrationService.name);
  /** Per-VPS single-flight guard for jobs executing in this process. */
  private readonly inFlight = new Set<string>();

  private readonly confirmDeadlineMs: number;
  private readonly confirmPollIntervalMs: number;
  private readonly failureBackoffMs: number;
  private readonly installerTimeoutMs: number;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(AiBundleService) private readonly bundles: AiBundleService,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
    @Optional() @Inject(AI_BUNDLE_TRANSPORT) private readonly transport?: AiBundleInstallTransport,
    @Optional() @Inject(AI_BUNDLE_ORCHESTRATION_OPTIONS) options?: OrchestrationOptions,
    // Updater channel for local/system hosts. Kept LAST: tests construct this
    // service positionally with an options tail; without the channel wired the
    // local path stays fail-closed exactly like before.
    @Optional() @Inject(AiLocalInstallService)
    private readonly localInstall?: AiLocalInstallService,
  ) {
    this.confirmDeadlineMs = options?.confirmDeadlineMs ?? CONFIRM_DEADLINE_MS;
    this.confirmPollIntervalMs = options?.confirmPollIntervalMs ?? CONFIRM_POLL_INTERVAL_MS;
    this.failureBackoffMs = options?.failureBackoffMs ?? FAILURE_BACKOFF_MS;
    this.installerTimeoutMs = options?.installerTimeoutMs ?? INSTALLER_COMMAND_TIMEOUT_MS;
  }

  // ─── read path ──────────────────────────────────────────────────────

  async getBundleView(vpsId: string): Promise<AiBundleView> {
    const bundle = this.bundles.getBundle();
    const [capability, job, vps] = await Promise.all([
      this.repository.getAiCapability(vpsId).catch(() => undefined),
      this.repository.getAiBundleJob(vpsId).catch(() => undefined),
      this.vps.get(vpsId).catch(() => undefined),
    ]);
    const view = this.buildView(bundle, capability, job, vps);
    return this.decorateInstallChannel(vps, view);
  }

  /** Channel decoration: local/system hosts with the updater channel wired
   * get the updater-channel eligibility/job/release view; remote hosts get
   * the explicit "ssh" channel with no local job. Absent localInstall keeps
   * the legacy fail-closed view (no installChannel field, like older APIs). */
  private async decorateInstallChannel(
    vps: VpsRecord | undefined,
    view: AiBundleView,
  ): Promise<AiBundleView> {
    if (vps && isLocalOrSystemHost(vps)) {
      if (!this.localInstall) {
        return { ...view, localJob: null, localRelease: null };
      }
      const local = await this.localInstall.getLocalInstallView(vps.id);
      // Strip the SSH-view install fields first: buildView marked local hosts
      // unsupported with SSH guidance, which must never leak into the updater
      // channel's own eligibility verdict.
      const { installSupported: _sshSupported, installReason: _sshReason, ...base } = view;
      return {
        ...base,
        installChannel: "updater",
        installSupported: local.installSupported,
        ...(local.installReason ? { installReason: local.installReason } : {}),
        localJob: local.localJob,
        localRelease: local.localRelease,
      };
    }
    if (vps) {
      // Remote SSH-managed host: explicit channel, never a local job.
      return { ...view, installChannel: "ssh", localJob: null, localRelease: null };
    }
    // Host record unresolved: channel unknown — leave installChannel absent.
    return { ...view, localJob: null, localRelease: null };
  }

  private buildView(
    bundle: ReturnType<AiBundleService["getBundle"]>,
    capability: Awaited<ReturnType<AiRepository["getAiCapability"]>>,
    job: AiBundleJobRecord | undefined,
    vps: VpsRecord | undefined,
  ): AiBundleView {
    const hostMissing = vps === undefined;
    const localOrSystem = !hostMissing && isLocalOrSystemHost(vps);
    return {
      available: bundle.available,
      ...(bundle.available ? {} : { reason: bundle.reason }),
      bundleId: bundle.available ? bundle.bundleId : null,
      installed: Boolean(capability) || Boolean(job?.lastInstalledBundleId),
      lastInstalledBundleId: job?.lastInstalledBundleId ?? null,
      lastJob: job
        ? {
            state: job.state,
            error: job.error ?? null,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt ?? null,
          }
        : null,
      capability: {
        supported: capability?.supported === true,
        ...(capability?.reason ? { reason: capability.reason } : {}),
        ...(capability?.agentVersion ? { agentVersion: capability.agentVersion } : {}),
        privilegedSupported: capability?.privilegedSupported === true,
      },
      installSupported: !hostMissing && !localOrSystem,
      ...(hostMissing
        ? { installReason: AI_BUNDLE_HOST_UNRESOLVED_INSTALL_REASON }
        : localOrSystem
          ? { installReason: AI_BUNDLE_LOCAL_HOST_INSTALL_REASON }
          : {}),
    };
  }

  // ─── scheduling ─────────────────────────────────────────────────────

  /** POST route: schedule (or join) an install; 503 when the bundle is
   * unavailable or installs are disabled; 404 for an unresolvable VPS record.
   * Remote hosts take the SSH path (idempotent per pending/running job);
   * local/system hosts take the updater channel — a durable ai-install job
   * pinned to a signed release, created only with an Idempotency-Key and
   * only on an explicit dashboard action. Returns the fresh view. */
  async installBundle(
    vpsId: string,
    trigger: AiBundleJobTrigger = "manual",
    idempotencyKey?: string,
  ): Promise<AiBundleView> {
    if (this.config.mode === "demo") {
      throw new ServiceUnavailableException("AI bundle install is disabled in demo mode");
    }
    const vps = await this.vps.get(vpsId).catch(() => undefined);
    if (!vps) throw new NotFoundException("VPS not found");
    if (isLocalOrSystemHost(vps)) {
      // Local/system hosts have no SSH transport: their install is pulled by
      // the host's own updater. Fail closed when the channel is not wired.
      if (!this.localInstall) {
        throw new BadRequestException(AI_BUNDLE_LOCAL_HOST_INSTALL_REASON);
      }
      if (trigger !== "manual") {
        // First AI install is a deliberate dashboard action only (Q8): the
        // deliberate/convergence triggers stay on the SSH channel and skip
        // local hosts; this guard keeps that contract even if a future call
        // site forgets.
        throw new BadRequestException(
          "Local host AI install is only scheduled by an explicit dashboard action",
        );
      }
      await this.localInstall.scheduleAiInstall(vpsId, {
        idempotencyKey,
        actor: "dashboard",
      });
      return this.getBundleView(vpsId);
    }
    const scheduled = await this.scheduleInstall(vpsId, trigger);
    if (!scheduled) {
      const bundle = this.bundles.getBundle();
      throw new ServiceUnavailableException(
        bundle.available
          ? "AI bundle install could not be scheduled"
          : `AI bundle unavailable: ${bundle.reason}`,
      );
    }
    return this.getBundleView(vpsId);
  }

  /** Idempotent scheduling: while a pending/running job exists the current
   * job is returned untouched; a terminal (or absent) job is replaced by a
   * fresh pending one. Returns null when the bundle is unavailable/demo. */
  async scheduleInstall(
    vpsId: string,
    trigger: AiBundleJobTrigger = "manual",
  ): Promise<AiBundleJobRecord | null> {
    if (this.config.mode === "demo") return null;
    const bundle = this.bundles.getBundle();
    if (!bundle.available) return null;

    const { job, created } = await this.repository.startAiBundleJob({
      vpsId,
      bundleId: bundle.bundleId,
      trigger,
    });
    if (created) {
      this.launch(vpsId, job);
      return job;
    }
    // Adopt an orphaned pending/running job left by a previous process so a
    // crash cannot wedge the VPS forever; while this process owns the job
    // (in-flight) POST is a pure no-op (idempotent).
    if (
      (job.state === "pending" || job.state === "running") &&
      !this.inFlight.has(vpsId)
    ) {
      this.launch(vpsId, job);
    }
    return job;
  }

  private launch(vpsId: string, job: AiBundleJobRecord): void {
    if (this.inFlight.has(vpsId)) return;
    this.inFlight.add(vpsId);
    // Fire-and-forget with error containment: executeJob performs its own
    // terminal transitions; this catch is the last-resort net so a schedule
    // trigger can never reject into the caller.
    void this.runJob(vpsId, job.jobId).catch(() => {});
  }

  // ─── deliberate-action trigger (Q8) ─────────────────────────────────

  /** Deliberate enabling actions install only on eligible remote hosts without
   * a capability report or recorded installation. */
  async maybeInstallAfterDeliberateAction(vpsId: string): Promise<void> {
    if (this.config.mode === "demo") return;
    const bundle = this.bundles.getBundle();
    if (!bundle.available) return;
    const vps = await this.vps.get(vpsId).catch(() => undefined);
    if (isLocalOrSystemHost(vps)) return;
    const [capability, job] = await Promise.all([
      this.repository.getAiCapability(vpsId).catch(() => undefined),
      this.repository.getAiBundleJob(vpsId).catch(() => undefined),
    ]);
    if (capability || job?.lastInstalledBundleId) return;
    await this.scheduleInstall(vpsId, "deliberate");
  }

  // ─── convergence (Q7) ───────────────────────────────────────────────

  /** Called from the 15s agent-convergence tick. For every VPS that has ANY
   * capability report (AI worker running = bundle installed), converge the
   * installed bundle onto the bundled one — regardless of aiEnabled. VPS
   * without a capability report are deliberately-action-only (Q8). */
  async convergeTick(): Promise<void> {
    if (this.config.mode === "demo") return;
    const bundle = this.bundles.getBundle();
    if (!bundle.available) return;

    const allVps = (await this.vps.list().catch(() => [] as VpsRecord[]))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const nowMs = Date.now();
    let createdThisTick = false;

    for (const vps of allVps) {
      if (isLocalOrSystemHost(vps)) continue;
      // Only hosts where an AI worker exists (any capability report) converge.
      const capability = await this.repository.getAiCapability(vps.id).catch(() => undefined);
      if (!capability) continue;

      const job = await this.repository.getAiBundleJob(vps.id).catch(() => undefined);
      if (job && (job.state === "pending" || job.state === "running")) continue;
      if (job?.lastInstalledBundleId === bundle.bundleId) continue;
      // Backoff: skip hosts whose latest job failed recently so the 15s tick
      // does not hammer SSH (mirrors the agent-binary suppression pattern).
      if (
        job?.state === "failed" &&
        job.finishedAt &&
        nowMs - Date.parse(job.finishedAt) < this.failureBackoffMs
      ) {
        continue;
      }
      if (createdThisTick) break;

      try {
        const scheduled = await this.scheduleInstall(vps.id, "convergence");
        if (scheduled) createdThisTick = true;
      } catch (error) {
        this.logger.warn(
          `AI bundle convergence scheduling failed for ${vps.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
  }

  // ─── job execution ──────────────────────────────────────────────────

  /** Executes one install job end-to-end. Never throws. */
  async runJob(vpsId: string, jobId: string): Promise<void> {
    try {
      await this.executeJob(vpsId, jobId);
    } catch (error) {
      const message = redactString(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 500);
      try {
        await this.repository.finishAiBundleJob({
          vpsId,
          jobId,
          outcome: "failed",
          error: message,
        });
      } catch (finishError) {
        this.logger.warn(
          `AI bundle job ${jobId} failure persist failed: ${finishError instanceof Error ? finishError.message : "unknown"}`,
        );
      }
    } finally {
      this.inFlight.delete(vpsId);
    }
  }

  private async executeJob(vpsId: string, jobId: string): Promise<void> {
    const bundle = this.bundles.getBundle();
    if (!bundle.available) {
      await this.finish(vpsId, jobId, { outcome: "failed", error: `AI bundle unavailable: ${bundle.reason}` });
      return;
    }
    const vps = await this.vps.get(vpsId);
    if (!vps) {
      await this.finish(vpsId, jobId, { outcome: "failed", error: "VPS not found" });
      return;
    }
    if (vps.kind === "local" || vps.managedBy === "system") {
      await this.finish(vpsId, jobId, {
        outcome: "failed",
        error: "AI bundle install requires a remote SSH-managed host",
      });
      return;
    }
    if (!this.transport) {
      await this.finish(vpsId, jobId, { outcome: "failed", error: "AI bundle SSH transport unavailable" });
      return;
    }
    const auth = await this.transport.resolveAuth(vpsId);
    if (!auth || (!auth.privateKey && !auth.password)) {
      await this.finish(vpsId, jobId, {
        outcome: "failed",
        error: "No saved authorized SSH key available for AI bundle install",
      });
      return;
    }
    const systemInfo = await this.agents.getSystemInfo(vpsId).catch(() => undefined);
    const arch = normalizeTargetArch(systemInfo?.kernel?.arch);
    const artifacts = bundle.arches[arch];
    if (!artifacts) {
      await this.finish(vpsId, jobId, {
        outcome: "failed",
        error: `AI bundle has no artifacts for host architecture ${arch}`,
      });
      return;
    }

    await this.repository.markAiBundleJobRunning(vpsId, jobId).catch(() => undefined);

    const tmp = `/tmp/flexserver-ai-install-${jobId}`;
    try {
      await this.transport.makeDirectory(vps, tmp, 0o700, auth);

      // 1. Discover the installed agent binary + config paths (world-readable
      //    unit files; privileged copy happens later on-host so the token
      //    never leaves the host).
      const { agentBin, agentConfig } = await this.discoverAgentPaths(vps, auth);

      // 2. Upload every artifact, verifying sha256 on-host before proceeding.
      const uploads = this.planUploads(bundle, artifacts, tmp);
      for (const upload of uploads) {
        const content = readFileSync(upload.entry.absolutePath);
        await this.transport.uploadFile(vps, upload.remote, content, upload.mode, auth);
        const verify = `test "$(sha256sum ${shellQuote(upload.remote)} | cut -d' ' -f1)" = ${shellQuote(upload.entry.sha256)}`;
        try {
          await this.transport.execCommand(vps, verify, auth, UPLOAD_TIMEOUT_MS);
        } catch {
          throw new Error(`sha256 verification failed for ${upload.entry.relativePath} after upload`);
        }
      }

      // 3. Copy agent binary/config into the staging dir and run the real
      //    installer non-interactively (--skip-cli avoids network downloads).
      const installerStatements = [
        `test -f ${shellQuote(agentBin)} || { echo "agent binary not found: ${agentBin}" >&2; exit 1; }`,
        `test -f ${shellQuote(agentConfig)} || { echo "agent config not found: ${agentConfig}" >&2; exit 1; }`,
        `mkdir -p ${shellQuote(`${tmp}/profiles`)}`,
        `cp -f ${shellQuote(agentBin)} ${shellQuote(`${tmp}/vps-agent`)}`,
        `cp -f ${shellQuote(agentConfig)} ${shellQuote(`${tmp}/config.json`)}`,
        `bash ${shellQuote(`${tmp}/${bundle.installerScript.relativePath}`)}`,
        ` --skip-cli --install-ai`,
        ` --binary ${shellQuote(`${tmp}/vps-agent`)}`,
        ` --config ${shellQuote(`${tmp}/config.json`)}`,
        ` --ai-executor-binary ${shellQuote(`${tmp}/ai-executor`)}`,
        ` --ai-host-helper-binary ${shellQuote(`${tmp}/ai-host-helper`)}`,
        ` --ai-rootfs-tar ${shellQuote(`${tmp}/rootfs.tar.gz`)}`,
        ` --ai-rootfs-manifest ${shellQuote(`${tmp}/rootfs.manifest.json`)}`,
        ` --ai-profiles-dir ${shellQuote(`${tmp}/profiles`)}`,
        ` && echo AI_BUNDLE_INSTALL_OK`,
      ].join("\n");
      const privilegedCmd = [
        `if [ "$(id -u)" -eq 0 ]; then`,
        `  ${installerStatements}`,
        `elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then`,
        `  sudo -n sh -c ${shellQuote(installerStatements)}`,
        `else echo "Error: root or passwordless sudo required" >&2; exit 1; fi`,
      ].join("\n");
      const installerResult = await this.transport.execCommand(
        vps,
        privilegedCmd,
        auth,
        this.installerTimeoutMs,
      );
      if (!installerResult.stdout.includes("AI_BUNDLE_INSTALL_OK")) {
        const detail = redactString(
          [installerResult.stderr, installerResult.stdout].filter(Boolean).join("\n").trim(),
        )
          .split("\n")
          .filter(Boolean)
          .slice(-5)
          .join("; ")
          .slice(0, 400);
        throw new Error(`installer failed: ${detail || "no output"}`);
      }

      // 4. Success requires a FRESH capability claim confirming the install:
      //    a claim received after the installer finished whose rootfsDigest
      //    matches the bundled manifest digest (or privilegedSupported=true,
      //    execmode plan Q3).
      const confirmFloorMs = Date.now();
      const deadline = confirmFloorMs + this.confirmDeadlineMs;
      let confirmed = false;
      while (Date.now() < deadline) {
        await this.sleep(this.confirmPollIntervalMs);
        const capability = await this.repository.getAiCapability(vpsId).catch(() => undefined);
        if (
          capability &&
          Date.parse(capability.freshness) >= confirmFloorMs &&
          (capability.rootfsDigest === artifacts.rootfsDigest ||
            capability.privilegedSupported === true)
        ) {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) {
        throw new Error(
          `install completed but no confirming AI capability claim arrived within ${Math.round(this.confirmDeadlineMs / 1000)}s`,
        );
      }

      await this.finish(vpsId, jobId, { outcome: "succeeded" });
      this.recordAudit(vpsId, "success", {
        bundleId: bundle.bundleId,
        arch,
        jobId,
      });
    } finally {
      // Best-effort staging cleanup; never masks the job outcome.
      await this.transport
        .execCommand(vps, `rm -rf ${shellQuote(tmp)}`, auth, CLEANUP_TIMEOUT_MS)
        .catch(() => undefined);
    }
  }

  private async discoverAgentPaths(
    vps: VpsRecord,
    auth: AiBundleSshAuth,
  ): Promise<{ agentBin: string; agentConfig: string }> {
    const unit = `vps-manager-agent.service`;
    const discoveryCmd = [
      `bin=""; cfg="";`,
      `for f in "/etc/systemd/system/${unit}" "/lib/systemd/system/${unit}" "/usr/local/lib/systemd/system/${unit}"; do`,
      `  if [ -f "$f" ]; then`,
      `    line=$(sed -n 's/^ExecStart=//p' "$f" | head -n 1);`,
      `    bin=$(printf '%s' "$line" | awk '{print $1}');`,
      `    cfg=$(printf '%s' "$line" | sed -n 's/.*-config \\([^ ]*\\).*/\\1/p');`,
      `    break;`,
      `  fi;`,
      `done;`,
      `echo "AGENT_BIN=$bin";`,
      `echo "AGENT_CONFIG=$cfg";`,
    ].join("\n");
    let agentBin = "/usr/local/bin/vps-manager-agent";
    let agentConfig = "/etc/vps-manager-agent/config.json";
    try {
      const result = await this.transport!.execCommand(vps, discoveryCmd, auth, DISCOVERY_TIMEOUT_MS);
      const binMatch = result.stdout.match(/AGENT_BIN=(.*)/);
      const cfgMatch = result.stdout.match(/AGENT_CONFIG=(.*)/);
      if (binMatch && binMatch[1]!.trim()) agentBin = binMatch[1].trim();
      if (cfgMatch && cfgMatch[1]!.trim()) agentConfig = cfgMatch[1].trim();
    } catch {
      // Discovery is best-effort; defaults match the standard installer.
    }
    return { agentBin, agentConfig };
  }

  private planUploads(
    bundle: AiBundle,
    artifacts: AiBundleArchArtifacts,
    tmp: string,
  ): Array<{ entry: AiBundleFileEntry; remote: string; mode: number }> {
    const uploads: Array<{ entry: AiBundleFileEntry; remote: string; mode: number }> = [
      { entry: bundle.installerScript, remote: `${tmp}/${bundle.installerScript.relativePath}`, mode: 0o755 },
      { entry: artifacts.executor, remote: `${tmp}/ai-executor`, mode: 0o755 },
      { entry: artifacts.hostHelper, remote: `${tmp}/ai-host-helper`, mode: 0o755 },
      { entry: artifacts.rootfsTar, remote: `${tmp}/rootfs.tar.gz`, mode: 0o644 },
      { entry: artifacts.rootfsManifest, remote: `${tmp}/rootfs.manifest.json`, mode: 0o644 },
    ];
    if (bundle.installerLib) {
      uploads.unshift({
        entry: bundle.installerLib,
        remote: `${tmp}/${bundle.installerLib.relativePath}`,
        mode: 0o755,
      });
    }
    for (const profile of bundle.profiles) {
      const name = profile.relativePath.slice("profiles/".length);
      uploads.push({ entry: profile, remote: `${tmp}/profiles/${name}`, mode: 0o644 });
    }
    return uploads;
  }

  private async finish(
    vpsId: string,
    jobId: string,
    input: Omit<AiBundleJobFinishInput, "vpsId" | "jobId">,
  ): Promise<void> {
    await this.repository.finishAiBundleJob({ vpsId, jobId, ...input });
  }

  private recordAudit(
    vpsId: string,
    result: "success" | "failure",
    metadata: Record<string, unknown>,
  ): void {
    if (!this.audit) return;
    void this.audit
      .record({
        actor: "system",
        action: "ai.bundle.install",
        resourceType: "vps",
        resourceId: vpsId,
        result,
        metadata,
      })
      .catch(() => undefined);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
