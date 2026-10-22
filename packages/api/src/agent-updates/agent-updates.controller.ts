import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { FleetService } from "./fleet.service.js";
import { AgentConvergenceService } from "../local-upgrade/agent-convergence.service.js";
import type { FleetManifestEnvelope } from "./fleet.models.js";
import {
  controlRolloutSchema,
  createRolloutSchema,
} from "./fleet.schemas.js";

@UseGuards(DashboardSessionGuard, OriginGuard)
@Controller("api/agent-updates")
export class AgentUpdatesController {
  constructor(
    @Inject(AgentConvergenceService)
    private readonly convergence: AgentConvergenceService,
    @Inject(FleetService)
    private readonly service: FleetService,
  ) {}

  @Get()
  async getOverview() {
    const hosts = await this.convergence.listAgentUpdates();
    return { data: { hosts } };
  }
  @Post("rollouts")
  async createRollout(@Body() rawBody: unknown) {
    const parse = createRolloutSchema.safeParse(rawBody);
    if (!parse.success) {
      throw new BadRequestException({
        error: "Invalid rollout creation request",
        details: parse.error.issues,
      });
    }
    const data = await this.service.createRollout({
      releaseId: parse.data.releaseId,
      group: parse.data.group,
      vpsIds: parse.data.vpsIds,
      confirmed: parse.data.confirmed,
      irreversibleConsent: parse.data.irreversibleConsent,
    });
    return { data };
  }

  @Post("rollouts/:id/control")
  @HttpCode(200)
  async controlRollout(@Param("id") id: string, @Body() rawBody: unknown) {
    const parse = controlRolloutSchema.safeParse(rawBody);
    if (!parse.success) {
      throw new BadRequestException({
        error: "Invalid rollout control request",
        details: parse.error.issues,
      });
    }
    const data = await this.service.controlRollout(id, parse.data.action);
    return { data };
  }

  @Post("releases/import")
  async importRelease(@Body() body: FleetManifestEnvelope) {
    if (!body || !body.payload || !body.signature || !body.keyId) {
      throw new BadRequestException("Invalid manifest envelope");
    }
    const data = await this.service.importRelease(body);
    return { data };
  }
}
