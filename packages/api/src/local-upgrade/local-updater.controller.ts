import { createReadStream } from "node:fs";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { AgentCredential } from "../agents/agent.models.js";
import { AgentService } from "../agents/agent.service.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { VPS_REPOSITORY } from "../tokens.js";
import {
  localUpdaterProgressSchema,
  localUpdaterResultSchema,
} from "./local-upgrade.schemas.js";
import {
  isLocalHostVps,
  LocalUpgradeService,
} from "./local-upgrade.service.js";
import type { LocalUpgradeJob } from "./local-upgrade.models.js";

function updaterJob(job: LocalUpgradeJob, requiresReconcile = false) {
  return {
    jobId: job.id,
    // "update" (or absent on very old servers) = agent binary path;
    // "ai-install" = signed AI runtime install, AI components only.
    kind: job.kind === "ai-install" ? "ai-install" : "update",
    phase: job.state,
    state: job.state,
    fencingToken: job.fencingToken,
    manifestRaw: job.manifestRaw,
    claimedAt: job.claimedAt,
    baselineBuildId: job.baselineBuildId,
    requiresReconcile,
    leaseExpiresAt: job.leaseExpiresAt,
    phaseDeadlineAt: job.phaseDeadlineAt,
    deadlineAt: job.deadlineAt,
    baselineHeartbeatAt: job.baselineHeartbeatAt,
    progress: job.progress,
    error: job.error?.message ?? null,
    result: job.result,
    completedAt: job.completedAt,
    release: {
      releaseId: job.releaseId,
      version: job.releaseVersion,
      buildId: job.releaseBuildId,
      targetSha256: job.targetSha256,
    },
    targetUrl: job.targetUrl || `/api/local-updater/jobs/${job.id}/artifact`,
    targetSha256: job.targetSha256,
    targetSizeBytes: job.targetSizeBytes,
    ...(job.components ? { components: job.components } : {}),
    ...(job.manifestSha256 ? { manifestSha256: job.manifestSha256 } : {}),
  };
}

function extractProtocolVersion(req: Request): number {
  const header = req.header("x-updater-protocol-version")?.trim();
  if (header) {
    const parsed = parseInt(header, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const ua = req.header("user-agent") || "";
  const match = /vps-updater\/(\d+)/i.exec(ua);
  if (match) {
    const parsed = parseInt(match[1], 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

/**
 * Pull-only updater API. Authenticated by a dedicated bearer credential
 * scoped `local-updater` (never the metrics/agent credential), bound to the
 * credential VPS record. Remote fleet clients require protocol 3; artifact
 * downloads are authorized for the credential's own job.
 */
@Controller("api/local-updater")
export class LocalUpdaterController {
  constructor(
    @Inject(LocalUpgradeService)
    private readonly service: LocalUpgradeService,
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
  ) {}

  @Post("jobs/claim")
  @HttpCode(200)
  async claim(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.authenticate(req);
    const protocolVersion = extractProtocolVersion(req);
    const evidence = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const claim = await this.service.claim(credential, protocolVersion, evidence);
    if (!claim) return { data: { job: null } };
    return {
      data: {
        job: updaterJob(claim.job, claim.requiresReconcile),
        requiresReconcile: claim.requiresReconcile,
      },
    };
  }

  @Post("jobs/:jobId/progress")
  @HttpCode(200)
  async progress(
    @Req() req: Request,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    const credential = await this.authenticate(req);
    const protocolVersion = extractProtocolVersion(req);
    const input = localUpdaterProgressSchema.parse(body);
    const job = await this.service.progress(credential, jobId, input, protocolVersion);
    return { data: { job: updaterJob(job) } };
  }

  @Post("jobs/:jobId/result")
  @HttpCode(200)
  async result(
    @Req() req: Request,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
  ) {
    const credential = await this.authenticate(req);
    const protocolVersion = extractProtocolVersion(req);
    const input = localUpdaterResultSchema.parse(body);
    const outcome = await this.service.result(credential, jobId, input, protocolVersion);
    return {
      data: {
        job: updaterJob(outcome.job),
        ...(outcome.awaitHeartbeat ? { awaitHeartbeat: true as const } : {}),
      },
    };
  }

  @Get("jobs/:jobId")
  async getJob(@Req() req: Request, @Param("jobId") jobId: string) {
    const credential = await this.authenticate(req);
    return {
      data: {
        job: updaterJob(
          await this.service.getUpdaterJob(credential, jobId),
        ),
      },
    };
  }

  @Get("jobs/:jobId/artifact")
  async getArtifact(
    @Req() req: Request,
    @Param("jobId") jobId: string,
    @Res() res: Response,
  ) {
    const credential = await this.authenticate(req);
    const existingJob = await this.service.findJobById(jobId);
    if (existingJob && existingJob.vpsId !== credential.vpsId) {
      throw new ForbiddenException({
        error: {
          message: "Updater credential does not own this upgrade job",
          code: "invalid_credential_scope",
        },
      });
    }
    const artifact = await this.service.getJobArtifact(credential, jobId);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", artifact.size);
    res.setHeader("X-Artifact-Sha256", artifact.sha256);
    const stream = createReadStream(artifact.filePath);
    stream.pipe(res);
  }

  private async authenticate(req: Request): Promise<AgentCredential> {
    const credential = await this.agentService.verifyBearerToken(
      req.header("authorization"),
    );
    if (credential.scope !== "local-updater") {
      throw new ForbiddenException({
        error: {
          message: "Credential is not scoped for the local updater",
          code: "invalid_credential_scope",
        },
      });
    }
    const vps = await this.vps.get(credential.vpsId);
    if (!vps) {
      throw new ForbiddenException({
        error: {
          message: "VPS not found for updater credential",
          code: "invalid_credential_scope",
        },
      });
    }
    const isLocal = isLocalHostVps(vps);
    const protocolVersion = extractProtocolVersion(req);
    if (!isLocal && protocolVersion < 3) {
      throw new ForbiddenException({
        error: {
          message: "Updater credential is not bound to a local host",
          code: "invalid_credential_scope",
        },
      });
    }
    return credential;
  }
}
