import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AgentService } from "../agents/agent.service.js";
import { ApplicationsService } from "./applications.service.js";
import { z } from "zod";

@Controller("api/agent/applications")
export class AgentApplicationsController {
  constructor(@Inject(AgentService) private readonly agents:AgentService,@Inject(ApplicationsService) private readonly apps:ApplicationsService){}
  private async identity(req: Request) { const credential = await this.agents.verifyAgentBearerToken(req.header("authorization")); const instance = req.header("x-agent-instance"); if (!instance) throw new ForbiddenException("agent_instance_required"); return { vpsId: credential.vpsId, instance }; }
  @Post("claim") async claim(@Req() req:Request,@Body() body:unknown){const input=z.object({agentInstanceId:z.string().min(1).max(128)}).strict().parse(body);const credential=await this.agents.verifyAgentBearerToken(req.header("authorization"));if(req.header("x-agent-instance")!==input.agentInstanceId)throw new ForbiddenException("agent_instance_mismatch");return {data:{work:await this.apps.claim(credential.vpsId,input.agentInstanceId)}};}
  @Post(":opId/progress") async progress(@Req() req:Request,@Param("opId") opId:string,@Body() body:unknown){const input=z.object({claimToken:z.string().length(64),seq:z.number().int().positive(),at:z.string().datetime({offset:true}),items:z.array(z.object({stage:z.enum(["claim","preflight","pull","apply","observe"]),service:z.string().max(128).optional(),status:z.enum(["started","ok","failed","skipped","uncertain"]),reason:z.string().max(255).optional(),observed:z.record(z.unknown()).optional()}).strict()).max(100)}).strict().parse(body);const {vpsId,instance}=await this.identity(req);return {data:await this.apps.progress(vpsId,instance,opId,input)};}
  @Post(":opId/authorize") async authorize(@Req() req:Request,@Param("opId") opId:string,@Body() body:unknown){const input=z.object({claimToken:z.string().length(64),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(body);const {vpsId,instance}=await this.identity(req);return {data:await this.apps.authorize(vpsId,instance,opId,input)};}
  @Post(":opId/result") async result(@Req() req:Request,@Param("opId") opId:string,@Body() body:unknown){const input=z.object({claimToken:z.string().length(64),status:z.enum(["succeeded","failed","uncertain"]),executed:z.boolean(),mutationAuthorized:z.boolean().optional(),partial:z.boolean().optional(),observed:z.array(z.record(z.unknown())).max(128).optional(),error:z.string().max(255).optional()}).strict().parse(body);const {vpsId,instance}=await this.identity(req);return {data:await this.apps.report(vpsId,instance,opId,input)};}
}
