import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { FleetService } from "./fleet.service.js";
import type { FleetManifestEnvelope } from "./fleet.models.js";
import {
  controlRolloutSchema,
  createRolloutSchema,
  enrollSchema,
  updatePoliciesSchema,
} from "./fleet.schemas.js";

@UseGuards(DashboardSessionGuard, OriginGuard)
@Controller("api/agent-updates")
export class AgentUpdatesController {
  constructor(
    @Inject(FleetService)
    private readonly service: FleetService,
  ) {}

  @Get()
  async getOverview() {
    const data = await this.service.getOverview();
    return { data };
  }

  @Post("enroll")
  @HttpCode(200)
  async enroll(@Body() rawBody: unknown) {
    const parse = enrollSchema.safeParse(rawBody);
    if (!parse.success) {
      throw new BadRequestException({
        error: "Invalid enrollment request",
        details: parse.error.issues,
      });
    }
    const data = await this.service.enrollHosts(
      parse.data.vpsIds,
      parse.data.policy,
    );
    return { data };
  }

  @Patch("policies")
  async updatePolicies(@Body() rawBody: unknown) {
    const parse = updatePoliciesSchema.safeParse(rawBody);
    if (!parse.success) {
      throw new BadRequestException({
        error: "Invalid policy update request",
        details: parse.error.issues,
      });
    }
    const data = await this.service.updatePolicies(
      parse.data.vpsIds,
      parse.data.policy,
    );
    return { data };
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
