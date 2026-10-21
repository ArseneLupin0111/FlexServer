import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { AgentService } from "../agents/agent.service.js";
import { AiAgentService } from "./ai-agent.service.js";
import {
  hostCancelStatusSchema,
  hostClaimSchema,
  hostHeartbeatSchema,
  hostOutputSchema,
  hostResultSchema,
} from "./ai.schemas.js";

@Controller("api/agent/ai")
export class AiAgentController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(AiAgentService) private readonly aiAgentService: AiAgentService,
  ) {}

  /**
   * POST /api/agent/ai/claim
   * Pull next pending command for this VPS with server-side bearer binding.
   */
  @Post("claim")
  @HttpCode(200)
  async claim(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(
      req.header("authorization"),
    );
    const parsed = hostClaimSchema.parse(body);
    const command = await this.aiAgentService.claim(credential.vpsId, parsed);
    return {
      data: {
        command,
      },
    };
  }

  /**
   * POST /api/agent/ai/heartbeat
   * Liveness ping and cancellation status check.
   */
  @Post("heartbeat")
  @HttpCode(200)
  async heartbeat(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(
      req.header("authorization"),
    );
    const parsed = hostHeartbeatSchema.parse(body);
    const res = await this.aiAgentService.heartbeat(credential.vpsId, parsed);
    return {
      data: res,
    };
  }

  /**
   * POST /api/agent/ai/output
   * Ephemeral bounded streaming output from command execution.
   */
  @Post("output")
  @HttpCode(200)
  async output(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(
      req.header("authorization"),
    );
    const parsed = hostOutputSchema.parse(body);
    const res = await this.aiAgentService.output(credential.vpsId, parsed);
    return {
      data: res,
    };
  }

  /**
   * POST /api/agent/ai/result
   * Terminal idempotent command execution outcome and receipt commit echo.
   */
  @Post("result")
  @HttpCode(200)
  async result(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(
      req.header("authorization"),
    );
    const parsed = hostResultSchema.parse(body);
    const res = await this.aiAgentService.result(credential.vpsId, parsed);
    return {
      data: res,
    };
  }

  /**
   * POST /api/agent/ai/cancel-status
   * Cancellation termination acknowledgement.
   */
  @Post("cancel-status")
  @HttpCode(200)
  async cancelStatus(@Req() req: Request, @Body() body: unknown) {
    const credential = await this.agentService.verifyAgentBearerToken(
      req.header("authorization"),
    );
    const parsed = hostCancelStatusSchema.parse(body);
    const res = await this.aiAgentService.cancelStatus(
      credential.vpsId,
      parsed,
    );
    return {
      data: res,
    };
  }
}
