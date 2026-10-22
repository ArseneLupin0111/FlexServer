import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { LocalUpgradeService } from "./local-upgrade.service.js";
import { AgentConvergenceService } from "./agent-convergence.service.js";
import {
  localUpgradeListQuerySchema,
  requiredIdempotencyKeySchema,
} from "./local-upgrade.schemas.js";
/**
 * Admin surface for local agent upgrades.
 * Confirmation is a UX dialog + session cookie + Origin check — no CSRF or
 * confirmationToken field exists in this codebase.
 */
@Controller("api/vps")
@UseGuards(DashboardSessionGuard, OriginGuard)
export class LocalUpgradeController {
  constructor(
    @Inject(LocalUpgradeService)
    private readonly service: LocalUpgradeService,
    @Inject(AgentConvergenceService)
    private readonly convergence: AgentConvergenceService,
  ) {}

  @Get(":id/agent-update")
  async agentUpdate(@Param("id") id: string) {
    return { data: await this.service.getAgentUpdate(id) };
  }

  @Post(":id/agent-update")
  @HttpCode(202)
  async triggerUpdate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKeyHeader: string | undefined,
  ) {
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== "object" || Object.keys(body).length > 0)
    ) {
      throw new BadRequestException({
        error: "agent-update request body must be empty",
      });
    }
    const idempotencyKey = requiredIdempotencyKeySchema.parse(
      idempotencyKeyHeader,
    );
    const data = await this.convergence.requestUpdate(id, idempotencyKey);
    return { data };
  }

  @Get(":id/local-agent-upgrades")
  async list(@Param("id") id: string, @Query() query: Record<string, unknown>) {
    const { limit, offset } = localUpgradeListQuerySchema.parse(query);
    const jobs = await this.service.listJobs(id, { limit, offset });
    return { data: jobs, meta: { limit, offset, count: jobs.length } };
  }

  @Get(":id/local-agent-upgrades/:jobId")
  async get(@Param("id") id: string, @Param("jobId") jobId: string) {
    return { data: await this.service.getJob(id, jobId) };
  }
}
