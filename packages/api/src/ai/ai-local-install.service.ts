import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { APP_CONFIG, AGENT_REPOSITORY, AI_REPOSITORY, FLEET_REPOSITORY, LOCAL_UPGRADE_REPOSITORY, VPS_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { FleetRepository } from "../persistence/repositories/fleet.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import type {
  LocalUpgradeRepository,
} from "../persistence/repositories/local-upgrade.repository.js";
import { newLocalUpgradeId } from "../persistence/repositories/local-upgrade.repository.js";
import {
  AI_INSTALL_COMPONENTS,
  AI_INSTALL_JOB_KIND,
  AI_INSTALL_UPDATER_CAPABILITY,
  LOCAL_UPGRADE_OVERALL_DEADLINE_MS,
  LOCAL_UPGRADE_PHASE_TIMEOUT_MS,
  UPDATER_HEALTH_TTL_MS,
  isTerminalState,
  jobKind,
  type AiInstallConfirmer,
  type LocalUpgradeJob,
} from "../local-upgrade/local-upgrade.models.js";
import { LocalUpgradeUniqueViolationError } from "../local-upgrade/local-upgrade.models.js";
import { isLocalHostVps, LocalUpgradeService, normalizeArchitecture } from "../local-upgrade/local-upgrade.service.js";
import type { FleetManifestEnvelope, FleetManifestPayload, FleetRelease } from "../agent-updates/fleet.models.js";
import { verifyFleetManifest } from "../agent-updates/fleet-manifest.verifier.js";
import { isFreshTimestamp } from "../common/host-health.js";
import { AuditService } from "../audit/audit.service.js";
import type { VpsRecord } from "../vps/vps.models.js";

// ── Local/system host AI first-install (pull updater channel) ─────────────
//
// Remote SSH hosts install the API-image bundle over saved SSH (see
// ai-bundle-install.service.ts). Local/system hosts have no SSH transport:
// their first AI install is pulled by the host's own updater from a SIGNED
// fleet release (verifyFleetManifest at import AND at schedule time), whose
// manifest must carry all four AI components for the host architecture.
//
// Fail-closed rules (every gate has an explicit reason):
//  — the helper must prove the `ai-install` capability on a LIVE claim before
//    the API ever hands out such a job (an old protocol-3 helper that ignores
//    `kind` must never receive one);
//  — the release's minUpdaterVersion is compared semantically (never
//    lexically) against the updater identity "semver+buildId";
//  — success is never reported from the updater verdict alone: fresh AI
//    evidence (healthy updater AI health covering every pinned component +
//    a fresh supported AI capability claim recorded after the job claim) is
//    required, and installedAi mismatch means "not confirmed";
//  — first install is dashboard-action-only: nothing here is wired into the
//    agent convergence tick, and the SSH-channel triggers all skip local
//    hosts, so a plain deploy can never silently install AI.

/** Re-export so the dashboard route layer can classify hosts without
 * importing the local-upgrade module directly. */
export { isLocalHostVps };

export type AiLocalJobWire = {
  id: string;
  state: "pending" | "running" | "succeeded" | "failed";
  progress: number | null;
  phase: string;
  error: string | null;
};

export type AiLocalReleaseWire = {
  releaseId: string;
  version: string;
  buildId: string;
  manifestSha256: string;
};

export type AiLocalInstallView = {
  installSupported: boolean;
  installReason?: string;
  localJob: AiLocalJobWire | null;
  localRelease: AiLocalReleaseWire | null;
};

export type AiLocalInstallScheduleResult = {
  jobId: string;
  /** True when the request replayed an existing idempotency key. */
  replay: boolean;
};

/** Capability evidence and AI capability claims older than this cannot
 * confirm success (matches the awaiting_heartbeat phase budget). */
const AI_CAPABILITY_CONFIRM_TTL_MS = 10 * 60_000;

export const AI_LOCAL_INSTALL_DEMO_REASON =
  "AI install is disabled in demo mode.";
export const AI_LOCAL_INSTALL_NO_UPDATER_REASON =
  "No local updater is reporting for this host; the first AI install is pulled by the host updater.";
export const AI_LOCAL_INSTALL_UPDATER_STALE_REASON =
  "The local updater has not reported recently; reconnect it before installing AI.";
export const AI_LOCAL_INSTALL_PROTOCOL_REASON =
  "The local updater protocol is too old for AI install (protocol 3 required).";
export const AI_LOCAL_INSTALL_CAPABILITY_REASON =
  "The local updater does not currently report AI install support; update the host updater to a version with AI install support and retry.";
export const AI_LOCAL_INSTALL_NO_RELEASE_REASON =
  "No signed AI runtime release has been imported; import a complete signed AI release (all four AI components for the host architecture) first.";
export const AI_LOCAL_INSTALL_ARCH_UNKNOWN_REASON =
  "The host architecture is unknown; a fresh agent or updater report is required before installing AI.";
export const AI_LOCAL_INSTALL_KEY_UNCONFIGURED_REASON =
  "The fleet release verification key is not configured; AI install is unavailable.";
export const AI_LOCAL_INSTALL_UNAVAILABLE_REASON =
  "AI local install eligibility cannot be determined; try again.";

type Eligibility = {
  eligible: boolean;
  reason?: string;
  release?: FleetRelease;
  arch?: "amd64" | "arm64";
  envelope?: FleetManifestEnvelope;
};

function noEligibility(reason: string): Eligibility {
  return { eligible: false, reason };
}

/** Complete AI component set for one architecture on a stored release. */
export function hasCompleteAiArtifacts(
  release: FleetRelease,
  arch: "amd64" | "arm64",
): boolean {
  if (!release.signature) return false;
  const artifacts = (release.artifacts ?? []).filter(
    (a) => a.os === "linux" && a.arch === arch,
  );
  const components = new Set(artifacts.map((a) => a.component));
  return AI_INSTALL_COMPONENTS.every((c) => components.has(c));
}

export function parseUpdaterSemver(
  raw: string | undefined | null,
): { major: number; minor: number; patch: number; prerelease: string } | null {
  if (!raw) return null;
  // Updater identity is "semver+buildId" (version.Identity()); split at the
  // first '+' and never compare raw strings lexically.
  const version = raw.split("+")[0]!.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

/** Negative when a < b. Numeric fields first; a prerelease is older than the
 * same release without one; identical prerelease strings compare lexically. */
export function compareUpdaterSemver(
  a: { major: number; minor: number; patch: number; prerelease: string },
  b: { major: number; minor: number; patch: number; prerelease: string },
): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease !== b.prerelease) {
    if (!a.prerelease) return 1;
    if (!b.prerelease) return -1;
    return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
  }
  return 0;
}

/** Web contract (AiBundleLocalJob.state): pending | running | succeeded |
 * failed. Local upgrade states map queued → pending, executing phases →
 * running, succeeded → succeeded, and every other terminal state → failed
 * with its reason surfaced as the job error (the UI polls on
 * pending/running only, so an unmapped raw state would silently stop the
 * progress bar). */
function toLocalJobWire(job: LocalUpgradeJob): AiLocalJobWire {
  const terminalError =
    job.error?.message ??
    (job.state === "rolled_back"
      ? "AI install failed and was rolled back on the host"
      : job.state === "rollback_unverified"
        ? "AI install failed; rollback could not be verified — inspect the host before retrying"
        : job.state === "deferred"
          ? "AI install was deferred; retry when the host is idle"
          : job.state === "superseded"
            ? "AI install was superseded by a newer job"
            : null);
  const state: AiLocalJobWire["state"] =
    job.state === "queued"
      ? "pending"
      : job.state === "succeeded"
        ? "succeeded"
        : isTerminalState(job.state)
          ? "failed"
          : "running";
  return {
    id: job.id,
    state,
    progress: job.progress,
    // Only rendered while the job is active; the state machine name is the
    // phase label (downloading, verifying, staging, …).
    phase: job.state.replace(/_/g, " "),
    error: state === "failed" ? terminalError : job.error?.message ?? null,
  };
}

@Injectable()
export class AiLocalInstallService implements AiInstallConfirmer {
  private readonly logger = new Logger(AiLocalInstallService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOCAL_UPGRADE_REPOSITORY)
    private readonly repository: LocalUpgradeRepository,
    @Inject(FLEET_REPOSITORY) private readonly fleet: FleetRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(AI_REPOSITORY) private readonly ai: AiRepository,
    // forwardRef: LocalUpgradeService optionally injects AI_INSTALL_CONFIRMER
    // (bound to this service in AppModule), so a plain class injection here
    // would be a constructor cycle Nest cannot resolve.
    @Inject(forwardRef(() => LocalUpgradeService))
    private readonly upgrades: LocalUpgradeService,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  // ─── GET support: eligibility + durable local job/release state ─────

  /** Eligibility for the updater channel plus the durable ai-install job and
   * its pinned signed release. Any read failure fails closed. */
  async getLocalInstallView(vpsId: string): Promise<AiLocalInstallView> {
    // Deadline rulings must apply before the view renders a stuck job.
    await this.upgrades.reconcile(vpsId, Date.now()).catch(() => undefined);
    const eligibility = await this.computeEligibilityForVpsId(vpsId).catch(
      (error: unknown) =>
        noEligibility(
          error instanceof Error && error.message
            ? `${AI_LOCAL_INSTALL_UNAVAILABLE_REASON} (${error.message})`
            : AI_LOCAL_INSTALL_UNAVAILABLE_REASON,
        ),
    );
    const jobs = await this.repository
      .listByVps(vpsId, { limit: 20 })
      .catch(() => [] as LocalUpgradeJob[]);
    const localJobRecord = jobs.find((job) => jobKind(job) === AI_INSTALL_JOB_KIND);
    return {
      installSupported: eligibility.eligible,
      ...(eligibility.reason ? { installReason: eligibility.reason } : {}),
      localJob: localJobRecord ? toLocalJobWire(localJobRecord) : null,
      localRelease: localJobRecord
        ? {
            releaseId: localJobRecord.releaseId,
            version: localJobRecord.releaseVersion,
            buildId: localJobRecord.releaseBuildId,
            manifestSha256: localJobRecord.manifestSha256 ?? "",
          }
        : null,
    };
  }

  private async computeEligibilityForVpsId(vpsId: string): Promise<Eligibility> {
    const vps = await this.vps.get(vpsId).catch(() => undefined);
    if (!vps) return noEligibility(AI_LOCAL_INSTALL_UNAVAILABLE_REASON);
    return this.computeEligibility(vps);
  }

  // ─── POST support: explicit, idempotent, signed-release-pinned create ──

  /** Schedules the first AI install on a local/system host. Every rejection
   * is explicit (400 with the failing gate, 409 on a conflicting active job);
   * the job pins the verbatim signed manifest and only AI components. */
  async scheduleAiInstall(
    vpsId: string,
    input: { idempotencyKey?: string; actor?: string } = {},
  ): Promise<AiLocalInstallScheduleResult> {
    if (this.config.mode === "demo") {
      throw new ServiceUnavailableException(AI_LOCAL_INSTALL_DEMO_REASON);
    }
    const vps = await this.vps.get(vpsId).catch(() => undefined);
    if (!vps) throw new NotFoundException("VPS not found");
    if (!isLocalHostVps(vps)) {
      throw new BadRequestException(
        "AI local updater install applies to local/system hosts only; remote hosts install over saved SSH",
      );
    }
    const eligibility = await this.computeEligibility(vps);
    if (
      !eligibility.eligible ||
      !eligibility.release ||
      !eligibility.arch ||
      !eligibility.envelope
    ) {
      throw new BadRequestException({
        error: {
          message: eligibility.reason ?? AI_LOCAL_INSTALL_UNAVAILABLE_REASON,
          code: "ai_install_unsupported",
        },
      });
    }
    const key = input.idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException({
        error: {
          message: "Idempotency-Key header is required for local AI install",
          code: "missing_idempotency_key",
        },
      });
    }
    const scopedKey = `${AI_INSTALL_JOB_KIND}:${key}`;
    const replay = await this.repository.getByIdempotencyKey(vpsId, scopedKey);
    if (replay) return { jobId: replay.id, replay: true };

    const active = await this.repository.getActiveByVps(vpsId);
    if (active) {
      throw new ConflictException({
        error: {
          message: "A local job is already active for this host",
          code: "active_job_exists",
          jobId: active.id,
        },
      });
    }

    // Defense in depth: re-verify the signed envelope bytes at schedule time
    // (the import path verified them too; the store is never trusted blind).
    let payload: FleetManifestPayload;
    try {
      payload = verifyFleetManifest(
        eligibility.envelope,
        this.config.fleet?.publicKeyFile ?? "",
      );
    } catch (error) {
      throw new BadRequestException({
        error: {
          message: `Signed AI release verification failed: ${
            error instanceof Error ? error.message : "unknown"
          }`,
          code: "ai_release_unverified",
        },
      });
    }
    const arch = eligibility.arch;
    const artifacts = payload.artifacts.filter((a) => a.arch === arch);
    const components = artifacts.map((a) => a.component);
    for (const component of AI_INSTALL_COMPONENTS) {
      if (!components.includes(component)) {
        throw new BadRequestException({
          error: {
            message: `Signed release ${payload.releaseId} is missing the ${component} component for ${arch}`,
            code: "ai_release_incomplete",
          },
        });
      }
    }
    const rootfs = artifacts.find((a) => a.component === "ai-rootfs")!;
    const manifestRaw = JSON.stringify(eligibility.envelope);
    const manifestSha256 = createHash("sha256")
      .update(manifestRaw, "utf8")
      .digest("hex");

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const job: LocalUpgradeJob = {
      id: newLocalUpgradeId(),
      vpsId,
      state: "queued",
      progress: null,
      kind: AI_INSTALL_JOB_KIND,
      targetArch: arch,
      releaseId: payload.releaseId,
      releaseVersion: payload.version,
      releaseBuildId: payload.buildId,
      // The pinned manifest digest anchors the job; component artifacts are
      // addressed by the signed manifest itself (never an agent artifact URL).
      targetSha256: manifestSha256,
      targetUrl: rootfs.url,
      targetSizeBytes: rootfs.size,
      manifestRaw,
      manifestSha256,
      components: [...components],
      actor: input.actor ?? "dashboard",
      idempotencyKey: scopedKey,
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
      if (this.audit) {
        await this.audit
          .record({
            actor: input.actor ?? "dashboard",
            action: "ai.local_install.create",
            resourceType: "vps",
            resourceId: vpsId,
            jobId: created.id,
            result: "success",
            metadata: {
              releaseId: created.releaseId,
              releaseBuildId: created.releaseBuildId,
              manifestSha256: created.manifestSha256,
              components: created.components,
              arch,
            },
          })
          .catch(() => undefined);
      }
      return { jobId: created.id, replay: false };
    } catch (error) {
      if (error instanceof LocalUpgradeUniqueViolationError) {
        if (error.kind === "idempotency" && error.existingId) {
          return { jobId: error.existingId, replay: true };
        }
        throw new ConflictException({
          error: {
            message: "A local job is already active for this host",
            code: "active_job_exists",
            ...(error.existingId ? { jobId: error.existingId } : {}),
          },
        });
      }
      throw error;
    }
  }

  // ─── AiInstallConfirmer: fresh AI evidence only ───────────────────────

  /** True only when ALL of the following hold right now: a fresh updater
   * heartbeat reporting healthy AI whose reported component set covers every
   * component pinned on the job (installedAi mismatch => not confirmed), and
   * a fresh, supported AI capability claim recorded AFTER the job claim. */
  async confirmAiInstall(job: LocalUpgradeJob): Promise<boolean> {
    const expected = job.components ?? [];
    if (expected.length === 0) return false;
    const heartbeat = await this.repository
      .getUpdaterHeartbeat(job.vpsId)
      .catch(() => undefined);
    if (!heartbeat) return false;
    if (!isFreshTimestamp(heartbeat.lastSeenAt, UPDATER_HEALTH_TTL_MS)) {
      return false;
    }
    if (heartbeat.aiHealth?.healthy !== true) return false;
    const reported = new Set<string>([
      ...(heartbeat.installedAi ?? []),
      ...(heartbeat.aiHealth?.components ?? []),
    ]);
    for (const component of expected) {
      if (!reported.has(component)) return false;
    }
    const capability = await this.ai
      .getAiCapability(job.vpsId)
      .catch(() => undefined);
    if (!capability?.supported) return false;
    const floorMs = Date.parse(job.claimedAt ?? job.createdAt);
    const freshMs = Date.parse(capability.freshness);
    if (!Number.isFinite(floorMs) || !Number.isFinite(freshMs)) return false;
    if (freshMs < floorMs) return false;
    if (!isFreshTimestamp(capability.freshness, AI_CAPABILITY_CONFIRM_TTL_MS)) {
      return false;
    }
    return true;
  }

  // ─── eligibility gates (shared by GET and POST; fail closed) ──────────

  private async computeEligibility(vps: VpsRecord): Promise<Eligibility> {
    if (this.config.mode === "demo") {
      return noEligibility(AI_LOCAL_INSTALL_DEMO_REASON);
    }
    const heartbeat = await this.repository
      .getUpdaterHeartbeat(vps.id)
      .catch(() => undefined);
    if (!heartbeat) return noEligibility(AI_LOCAL_INSTALL_NO_UPDATER_REASON);
    if (!isFreshTimestamp(heartbeat.lastSeenAt, UPDATER_HEALTH_TTL_MS)) {
      return noEligibility(AI_LOCAL_INSTALL_UPDATER_STALE_REASON);
    }
    if ((heartbeat.protocolVersion ?? 1) < 3) {
      return noEligibility(AI_LOCAL_INSTALL_PROTOCOL_REASON);
    }
    const capabilities = heartbeat.capabilities ?? [];
    const capabilityFresh =
      heartbeat.capabilitiesAt != null &&
      isFreshTimestamp(heartbeat.capabilitiesAt, UPDATER_HEALTH_TTL_MS);
    if (
      !capabilities.includes(AI_INSTALL_UPDATER_CAPABILITY) ||
      !capabilityFresh
    ) {
      return noEligibility(AI_LOCAL_INSTALL_CAPABILITY_REASON);
    }
    const systemInfo = await this.agents.getSystemInfo(vps.id).catch(() => undefined);
    const agentArch = normalizeArchitecture(systemInfo?.kernel?.arch);
    const updaterArch = normalizeArchitecture(heartbeat.platform?.arch);
    let arch: "amd64" | "arm64" | null = null;
    if (agentArch && updaterArch) {
      if (agentArch !== updaterArch) {
        return noEligibility(
          `Agent architecture (${agentArch}) conflicts with the updater platform architecture (${updaterArch}); resolve the conflict before installing AI.`,
        );
      }
      arch = agentArch;
    } else {
      arch = agentArch ?? updaterArch;
    }
    if (!arch) return noEligibility(AI_LOCAL_INSTALL_ARCH_UNKNOWN_REASON);
    if (!this.config.fleet?.publicKeyFile) {
      return noEligibility(AI_LOCAL_INSTALL_KEY_UNCONFIGURED_REASON);
    }
    const releases = await this.fleet.listReleases().catch(() => [] as FleetRelease[]);
    const release = releases.find((candidate) =>
      hasCompleteAiArtifacts(candidate, arch!),
    );
    if (!release) return noEligibility(AI_LOCAL_INSTALL_NO_RELEASE_REASON);
    if (release.minUpdaterVersion) {
      const current = parseUpdaterSemver(heartbeat.updaterVersion);
      const minimum = parseUpdaterSemver(release.minUpdaterVersion);
      if (!current || !minimum) {
        return noEligibility(
          `The local updater version ("${
            heartbeat.updaterVersion ?? "unknown"
          }") is not a parseable semantic version; update the updater before installing AI.`,
        );
      }
      if (compareUpdaterSemver(current, minimum) < 0) {
        return noEligibility(
          `Local updater version ${heartbeat.updaterVersion} is below the release minimum ${release.minUpdaterVersion}; update the updater first.`,
        );
      }
    }
    if (heartbeat.idle !== true) {
      return noEligibility(
        `The host is busy (${heartbeat.busyReason ?? "the updater reports activity"}); retry when it is idle.`,
      );
    }
    const envelope: FleetManifestEnvelope = {
      payload: release.rawPayload,
      signature: release.signature!,
      keyId: release.keyId ?? "",
    };
    return { eligible: true, release, arch, envelope };
  }
}
