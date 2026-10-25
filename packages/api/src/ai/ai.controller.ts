import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors, HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { AiRoutesService } from "./ai-routes.service.js";
import { AiTaskService } from "./ai-task.service.js";
import { DashboardSessionService } from "../auth/dashboard-session.service.js";
import { AiPolicyService } from "./ai-policy.service.js";
import { AiResponseInterceptor } from "./ai-response.interceptor.js";
import { AiAgentService } from "./ai-agent.service.js";
const activeStreams = new Map<string, number>();
let totalStreams = 0;

@Controller("api/ai")
@UseGuards(DashboardSessionGuard, OriginGuard)
@UseInterceptors(AiResponseInterceptor)
export class AiSettingsController {
  constructor(@Inject(AiRoutesService) private readonly service: AiRoutesService) {}
  @Get("settings")
  settings(@Req() request: Request) { return this.service.settings(request); }
  @Patch("settings")
  update(@Req() request: Request, @Body() body: unknown) { return this.service.updateSettings(request, body); }
  @Post("provider/check")
  check(@Req() request: Request) { return this.service.checkProvider(request); }
  @Get("providers")
  providers(@Req() request: Request) { return this.service.providers(request); }
  @Post("providers")
  createProvider(@Req() request: Request, @Body() body: unknown) { return this.service.createProvider(request, body); }
  @Patch("providers/:providerId")
  updateProvider(@Req() request: Request, @Param("providerId") providerId: string, @Body() body: unknown) { return this.service.updateProvider(request, providerId, body); }
  @Delete("providers/:providerId")
  deleteProvider(@Req() request: Request, @Param("providerId") providerId: string) { return this.service.deleteProvider(request, providerId); }
  @Post("providers/:providerId/check")
  checkProvider(@Req() request: Request, @Param("providerId") providerId: string) { return this.service.checkProviderProfile(request, providerId); }
  @Post("providers/:providerId/models")
  fetchProviderModels(@Req() request: Request, @Param("providerId") providerId: string) { return this.service.fetchProviderModels(request, providerId); }
  @Post("providers/:providerId/oauth/authorize")
  authorizeProviderOauth(@Req() request: Request, @Param("providerId") providerId: string) { return this.service.authorizeProviderOauth(request, providerId); }
  @Post("providers/:providerId/oauth/exchange")
  exchangeProviderOauth(@Req() request: Request, @Param("providerId") providerId: string, @Body() body: unknown) { return this.service.exchangeProviderOauth(request, providerId, body); }
}

@Controller("api/vps/:id/ai")
@UseGuards(DashboardSessionGuard, OriginGuard)
@UseInterceptors(AiResponseInterceptor)
export class AiPolicyController {
  constructor(@Inject(AiRoutesService) private readonly service: AiRoutesService, @Inject(AiTaskService) private readonly tasks: AiTaskService, @Inject(DashboardSessionService) private readonly sessions: DashboardSessionService, @Inject(AiPolicyService) private readonly policyService: AiPolicyService, @Inject(AiAgentService) private readonly agent: AiAgentService) {}
  @Get("policy")
  policy(@Req() request: Request, @Param("id") id: string) { return this.service.policy(request, id); }
  @Patch("policy")
  update(@Req() request: Request, @Param("id") id: string, @Body() body: unknown) { return this.service.updatePolicy(request, id, body); }
  @Get("bundle")
  bundle(@Req() request: Request, @Param("id") id: string) { return this.service.bundle(request, id); }
  @Post("bundle/install")
  installBundle(@Req() request: Request, @Param("id") id: string) { return this.service.installBundle(request, id); }
  @Get("tasks")
  list(@Req() req: Request, @Param("id") id: string, @Query("conversationId") conversationId?: string) { return this.tasks.list(req, id, conversationId); }
  @Post("tasks")
  create(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) { return this.tasks.create(req, id, body); }
  @Get("tasks/:taskId")
  task(@Req() req: Request, @Param("id") id: string, @Param("taskId") taskId: string) { return this.tasks.get(req, id, taskId); }
  @Post("tasks/:taskId/cancel")
  cancel(@Req() req: Request, @Param("id") id: string, @Param("taskId") taskId: string) { return this.tasks.cancel(req, id, taskId); }
  @Post("tasks/:taskId/input")
  input(@Req() req: Request, @Param("id") id: string, @Param("taskId") taskId: string, @Body() body: unknown) { return this.tasks.submitInput(req, id, taskId, body); }
  @Post("tasks/:taskId/approve")
  approve(@Req() req: Request, @Param("id") id: string, @Param("taskId") taskId: string, @Body() body: unknown) { return this.tasks.approve(req, id, taskId, body); }
  @Post("tasks/:taskId/deny")
  deny(@Req() req: Request, @Param("id") id: string, @Param("taskId") taskId: string) { return this.tasks.deny(req, id, taskId); }
  @Post("tasks/:taskId/reconcile")
  reconcile(@Req() req: Request, @Param("id") id: string, @Param("taskId") taskId: string) { return this.tasks.reconcile(req, id, taskId); }
  @Get("tasks/:taskId/preview")
  preview(@Req() req: Request, @Param("id") id: string, @Param("taskId") taskId: string, @Res({ passthrough: true }) res: Response) { res.setHeader("Cache-Control", "no-store"); res.setHeader("Pragma", "no-cache"); return this.tasks.preview(req, id, taskId); }
  @Get("conversations")
  conversations(@Req() req: Request, @Param("id") id: string) { return this.tasks.conversations(req, id); }
  @Get("conversations/:conversationId")
  conversation(@Req() req: Request, @Param("id") id: string, @Param("conversationId") conversationId: string, @Query("offset") rawOffset?: string, @Query("limit") rawLimit?: string) {
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    const limit = rawLimit === undefined ? 200 : Number(rawLimit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HttpException("Invalid conversation page", 400);
    return this.tasks.conversation(req, id, conversationId, { offset, limit });
  }
  @Delete("conversations/:conversationId")
  deleteConversation(@Req() req: Request, @Param("id") id: string, @Param("conversationId") conversationId: string) { return this.tasks.deleteConversation(req, id, conversationId); }
  @Get("capability")
  async capability(@Req() req: Request, @Param("id") id: string) { await this.service.policy(req, id); return this.policyService.getCapability(id); }
  @Get("tasks/:taskId/events")
  async events(@Req() req: Request, @Res() res: Response, @Param("id") id: string, @Param("taskId") taskId: string) {
    await this.tasks.get(req, id, taskId);
    const streamKey = `${req.dashboardSessionId}:${id}`;
    if (totalStreams >= 64 || (activeStreams.get(streamKey) ?? 0) >= 4) throw new HttpException("AI stream limit reached", 429);
    activeStreams.set(streamKey, (activeStreams.get(streamKey) ?? 0) + 1);
    totalStreams++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      totalStreams--;
      const remaining = (activeStreams.get(streamKey) ?? 1) - 1;
      if (remaining > 0) activeStreams.set(streamKey, remaining); else activeStreams.delete(streamKey);
    };
    res.once("close", release);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    let closed = false;
    let revision = -1;
    let outputCursor = 0;
    const stop = () => { closed = true; res.end(); };
    res.on("close", () => { closed = true; });
    const deadline = Date.now() + 180000;
    while (!closed && Date.now() < deadline) {
      try {
        if (!req.dashboardSessionId || !await this.sessions.authenticateById(req.dashboardSessionId)) break;
        const task = await this.tasks.get(req, id, taskId);
        if (closed) break;
        const output = await this.agent.readOutput(taskId, outputCursor);
        if (output.isGap && !res.write("event: ai.output.gap\ndata: {}\n\n")) break;
        for (const chunk of output.chunks) {
          if (chunk.isGap && !res.write(`event: ai.output.gap\ndata: {}\n\n`)) { closed = true; break; }
          if (!res.write(`event: ai.output.chunk\ndata: ${JSON.stringify({ ...chunk, gap: chunk.isGap })}\n\n`)) { closed = true; break; }
        }
        outputCursor = output.nextCursor;
        if (closed) break;
        if (task.revision !== revision) {
          revision = task.revision;
          if (!res.write(`event: ai.usage.updated\ndata: ${JSON.stringify(task.usage)}\n\n`)) break;
          if (task.state === "awaiting_approval" && task.plan && !res.write(`event: ai.approval.required\ndata: ${JSON.stringify(task.plan)}\n\n`)) break;
          if (task.plan && !res.write(`event: ai.step.updated\ndata: ${JSON.stringify({ taskId, plan: task.plan })}\n\n`)) break;
          if (!res.write(`event: ai.task.snapshot\ndata: ${JSON.stringify(task)}\n\n`)) break;
        }
        if (!output.hasMore && ["succeeded", "failed", "cancelled", "expired"].includes(task.state)) {
          res.write("event: ai.stream.closed\ndata: {}\n\n");
          break;
        }
      } catch { break; }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 500);
      await promise;
    }
    stop();
  }
}
