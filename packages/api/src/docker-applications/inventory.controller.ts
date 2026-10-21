import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AgentService } from "../agents/agent.service.js";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { APP_CONFIG, VPS_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { VpsRecord } from "../vps/vps.models.js";
import type { ApplicationsInventoryRepository } from "../persistence/repositories/applications-inventory.repository.js";
import { applicationsInventorySchema } from "./inventory.schemas.js";
export const APPLICATIONS_INVENTORY_REPOSITORY = Symbol("APPLICATIONS_INVENTORY_REPOSITORY");

const instancesMatch = (headerInstance: string | undefined, payloadInstance: string): boolean => Boolean(headerInstance && headerInstance === payloadInstance);
const inventoryAgeSeconds = (collectedAt: string): number => Math.max(0, (Date.now() - Date.parse(collectedAt)) / 1000);

@Controller("api/agent/applications")
export class ApplicationsInventoryAgentController {
  constructor(@Inject(AgentService) private readonly agents: AgentService, @Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(APPLICATIONS_INVENTORY_REPOSITORY) private readonly repository: ApplicationsInventoryRepository, @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository) {}
  @Post("inventory")
  @HttpCode(200)
  async ingest(@Req() req: Request, @Body() body: unknown) {
    if (this.config.mode === "demo") throw new ForbiddenException({ error: { code: "demo_disabled" } });
    const credential = await this.agents.verifyAgentBearerToken(req.header("authorization"));
    const instance = req.header("x-agent-instance");
    const parsed = applicationsInventorySchema.safeParse(body);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(body)) > (this.config.compose?.inventoryMaxBytes ?? 524_288)) throw new BadRequestException({ error: { code: "invalid_inventory" } });
    const record: VpsRecord | undefined = await this.vps.get(credential.vpsId);
    if (!record) throw new ForbiddenException({ error: { code: "vps_unavailable" } });
    if (!instancesMatch(instance, parsed.data.agentInstanceId)) throw new ForbiddenException({ error: { code: "agent_instance_mismatch" } });
    const now = Date.now();
    const age = now - Date.parse(parsed.data.collectedAt);
    if (age < -30_000 || age > 120_000) throw new BadRequestException({ error: { code: "inventory_timestamp_out_of_range" } });
    try {
      const status = await this.repository.save({ ...parsed.data, vpsId: credential.vpsId, receivedAt: new Date(now).toISOString() });
      return { data: { ok: true, status } };
    } catch (error) {
      if (error instanceof Error && error.message === "inventory_sequence_conflict") throw new ConflictException({ error: { code: "inventory_sequence_conflict" } });
      throw error;
    }
  }
}
