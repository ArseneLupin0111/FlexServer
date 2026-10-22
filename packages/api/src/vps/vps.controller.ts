import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import {
  buildPageMeta,
  parsePagination,
  type PaginationQuery,
} from "../common/pagination.js";
import { AuditService, type AuditFilter } from "../audit/audit.service.js";
import { JobService } from "../jobs/job.service.js";
import { MetricService } from "../metrics/metric.service.js";
import { MonitoringService } from "../monitoring/monitoring.service.js";
import { HostKeyPinService } from "../ssh/host-key-pin.service.js";
import { VpsService } from "./vps.service.js";
import { AgentRotationService } from "../agents/agent-rotation.service.js";

@Controller("api/vps")
@UseGuards(DashboardSessionGuard, OriginGuard)
export class VpsController {
  constructor(
    @Inject(VpsService) private readonly vps: VpsService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(MetricService) private readonly metrics: MetricService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MonitoringService) private readonly monitoring: MonitoringService,
    @Inject(HostKeyPinService) private readonly hostKeyPin: HostKeyPinService,
    @Inject(AgentRotationService)
    private readonly rotation: AgentRotationService,
  ) {}

  @Get()
  async list() {
    return { data: await this.vps.list() };
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return { data: await this.vps.create(body) };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return { data: await this.vps.get(id) };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    return { data: await this.vps.update(id, body) };
  }

  @Delete(":id")
  @HttpCode(204)
  async delete(@Param("id") id: string) {
    await this.vps.delete(id);
  }

  @Post(":id/provision-key")
  async provisionKey(@Param("id") id: string, @Body() body: unknown) {
    return { data: await this.vps.provisionKey(id, body) };
  }

  @Post(":id/verify-key")
  async verifyKey(@Param("id") id: string) {
    await this.vps.verifyKey(id);
    return { data: { ok: true } };
  }

  @Post(":id/install-agent")
  async installAgent(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const requestHost = req.get("host");
    const result = await this.vps.installAgent(id, body, requestHost);
    return {
      data: {
        jobId: result.jobId,
        state: {
          status: result.state.status,
          lastInstallJobId: result.state.lastInstallJobId,
        },
      },
    };
  }

  /**
   * Queue asynchronous agent removal for a VPS.
   * Returns job metadata immediately; the job performs remote removal using
   * the provisioned SSH key, then revokes credentials and clears agent state.
   */
  @Post(":id/uninstall-agent")
  async uninstallAgent(@Param("id") id: string) {
    const result = await this.vps.uninstallAgent(id);
    return {
      data: {
        jobId: result.jobId,
        state: {
          status: result.state.status,
          lastInstallJobId: result.state.lastInstallJobId,
        },
      },
    };
  }

  @Post(":id/restart-agent")
  async restartAgent(@Param("id") id: string) {
    const result = await this.vps.restartAgent(id);
    return { data: { jobId: result.jobId, state: result.state } };
  }

  /**
   * Rotate the agent credential for the local/system-managed host only.
   * Response is redacted: job id + credential id + state, never the raw token.
   */
  @Post(":id/rotate-agent")
  async rotateAgent(@Param("id") id: string) {
    const result = await this.rotation.rotate(id);
    return {
      data: {
        jobId: result.jobId,
        credentialId: result.credentialId,
        state: result.state,
      },
    };
  }

  // ── Scoped VPS endpoints ───────────────────────────────────────────────

  /**
   * List jobs scoped to a VPS. Validates VPS exists before returning.
   */
  @Get(":id/jobs")
  async listVpsJobs(@Param("id") id: string, @Query() query: PaginationQuery) {
    await this.vps.get(id); // validate VPS exists
    const page = parsePagination(query, "jobs");
    const data = await this.jobs.listByVpsId(id, page);
    return { data, page: buildPageMeta(page, data.length) };
  }

  /**
   * List latest metrics scoped to a VPS. Validates VPS exists.
   */
  @Get(":id/metrics")
  async listVpsMetrics(@Param("id") id: string) {
    await this.vps.get(id); // validate VPS exists
    const data = await this.metrics.list(id);
    return { data };
  }

  /**
   * List audit events scoped to a VPS, including direct VPS events,
   * job-related events, and serverLabel legacy fallback.
   * Validates VPS exists. Filter-before-pagination.
   */
  @Get(":id/audit")
  async listVpsAudit(
    @Param("id") id: string,
    @Query() query: PaginationQuery & AuditFilter,
  ) {
    const vps = await this.vps.get(id); // validate VPS exists
    // Get VPS job IDs for job-related audit matching
    const vpsJobs = await this.jobs.listByVpsId(id);
    const vpsJobIds = vpsJobs.map((j) => j.id);
    // Strip resourceId from query so path param always wins
    const {
      limit: _l,
      offset: _o,
      resourceId: _queryRid,
      action,
      result,
    } = query;
    const page = parsePagination({ limit: _l, offset: _o }, "audit");
    const data = await this.audit.listForVps(
      id,
      vps.name,
      vpsJobIds,
      {
        action: action as string | undefined,
        result: result as string | undefined,
      },
      page,
    );
    return { data, page: buildPageMeta(page, data.length) };
  }

  /**
   * SSE monitoring stream scoped to a single VPS. Validates VPS exists before headers.
   */
  @Get(":id/monitoring/stream")
  async streamVpsMonitoring(
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.vps.get(id); // validate VPS exists before writing SSE headers
    try {
      await this.monitoring.streamForVps(res, id);
    } catch (error) {
      const vpsLogger = new Logger("VpsController");
      vpsLogger.error(
        "Scoped SSE stream error",
        error instanceof Error ? error.message : String(error),
      );
      if (!res.headersSent) {
        res.status(500).json({ error: { message: "Internal server error" } });
      }
    }
  }

  // ── SSH host key trust endpoints ──────────────────────────────────────

  /**
   * Scan a VPS host key using ssh-keyscan. Validates VPS exists.
   */
  @Post(":id/ssh/host-key/scan")
  async scanHostKey(@Param("id") id: string) {
    const vps = await this.vps.get(id);
    const result = await this.hostKeyPin.scanHostKey(vps.id, vps.host, vps.port);
    return { data: result };
  }

  /**
   * Trust a scanned host key. Validates VPS exists.
   */
  @Post(":id/ssh/host-key/trust")
  async trustHostKey(
    @Param("id") id: string,
    @Body() body: { fingerprint: string; keyType?: string },
  ) {
    const vps = await this.vps.get(id);
    const pin = await this.hostKeyPin.trustKey(
      vps.id,
      vps.host,
      vps.port,
      body.fingerprint,
      body.keyType,
    );
    return { data: pin };
  }

  /**
   * Revoke trust for a VPS host key. Validates VPS exists.
   */
  @HttpCode(204)
  @Delete(":id/ssh/host-key/trust")
  async revokeHostKeyTrust(@Param("id") id: string) {
    await this.vps.get(id);
    await this.hostKeyPin.revokeTrust(id);
  }
}
