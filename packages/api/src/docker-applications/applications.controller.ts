import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { ApplicationsService } from "./applications.service.js";

@Controller("api/vps/:id/docker/applications")
@UseGuards(DashboardSessionGuard, OriginGuard)
export class ApplicationsController {
  constructor(@Inject(ApplicationsService) private readonly service: ApplicationsService) {}

  // 1. Literal routes first to prevent route shadowing by parameterized :appId
  @Get("capability")
  async capability(@Param("id") id: string) {
    return { data: await this.service.capability(id) };
  }

  @Get("operations")
  async vpsOperations(
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return { data: await this.service.vpsOperations(id, { cursor, limit: limit ? parseInt(limit, 10) : undefined }) };
  }

  @Get("operations/:opId")
  async vpsOperation(@Param("id") id: string, @Param("opId") opId: string) {
    return { data: await this.service.vpsOperation(id, opId) };
  }

  @Get("registry-credentials")
  async credentials(@Param("id") id: string) {
    return { data: await this.service.credentials(id) };
  }

  @Post("registry-credentials")
  async createCredential(@Param("id") id: string, @Body() body: unknown) {
    return { data: await this.service.setCredential(id, body) };
  }

  @Patch("registry-credentials/:credentialId")
  async replaceCredential(@Param("id") id: string, @Param("credentialId") credentialId: string, @Body() body: unknown) {
    return { data: await this.service.setCredential(id, { ...(body as object), credentialId }) };
  }

  @Delete("registry-credentials/:credentialId")
  async deleteCredential(@Param("id") id: string, @Param("credentialId") credentialId: string, @Body() body: unknown) {
    return { data: await this.service.deleteCredential(id, credentialId, body) };
  }

  @Post("runtime-preparation")
  async runtimePreparation(@Param("id") id: string, @Body() body: unknown) {
    return { data: await this.service.runtimePreparation(id, body) };
  }

  // 2. Collection root routes
  @Get()
  async list(
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return { data: await this.service.list(id, { cursor, limit: limit ? parseInt(limit, 10) : undefined }) };
  }

  @Post()
  async create(@Param("id") id: string, @Body() body: unknown) {
    return { data: await this.service.create(id, body) };
  }

  // 3. Application instance parameterized routes (:appId)
  @Get(":appId")
  async detail(@Param("id") id: string, @Param("appId") appId: string) {
    return { data: await this.service.detail(id, appId) };
  }

  @Patch(":appId")
  async update(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.update(id, appId, body) };
  }

  @Post(":appId/source")
  async source(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.source(id, appId, body) };
  }

  @Post(":appId/external-control")
  async optIn(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.optInExternal(id, appId, body) };
  }

  @Post(":appId/adoption-preview")
  async adoptionPreview(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.adoptionPreview(id, appId, body) };
  }

  @Post(":appId/adopt")
  async adopt(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.adopt(id, appId, body) };
  }

  @Post(":appId/unmanage")
  async unmanage(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.unmanage(id, appId, body) };
  }

  @Get(":appId/revisions")
  async revisions(
    @Param("id") id: string,
    @Param("appId") appId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return { data: await this.service.revisions(id, appId, { cursor, limit: limit ? parseInt(limit, 10) : undefined }) };
  }

  @Post(":appId/preview")
  async preview(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.preview(id, appId, body) };
  }

  @Get(":appId/previews/:previewId")
  async previewDetail(@Param("id") id: string, @Param("appId") appId: string, @Param("previewId") previewId: string) {
    return { data: await this.service.previewDetail(id, appId, previewId) };
  }

  @Post(":appId/previews/:previewId/confirm")
  async confirmPreview(@Param("id") id: string, @Param("appId") appId: string, @Param("previewId") previewId: string, @Body() body: unknown) {
    return { data: await this.service.confirmPreview(id, appId, previewId, body) };
  }

  @Get(":appId/secrets")
  async secrets(@Param("id") id: string, @Param("appId") appId: string) {
    return { data: await this.service.secrets(id, appId) };
  }

  @Post(":appId/secrets/:name")
  async setSecret(@Param("id") id: string, @Param("appId") appId: string, @Param("name") name: string, @Body() body: unknown) {
    return { data: await this.service.secrets(id, appId, { ...(body as object), name }) };
  }

  @Delete(":appId/secrets/:name")
  async deleteSecret(@Param("id") id: string, @Param("appId") appId: string, @Param("name") name: string, @Body() body: unknown) {
    return { data: await this.service.deleteSecret(id, appId, name, body) };
  }

  @Get(":appId/secrets/:name")
  async secretMetadata(@Param("id") id: string, @Param("appId") appId: string, @Param("name") name: string) {
    return { data: await this.service.secretMetadata(id, appId, name) };
  }

  @Get(":appId/operations")
  async operations(
    @Param("id") id: string,
    @Param("appId") appId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return { data: await this.service.operations(id, appId, { cursor, limit: limit ? parseInt(limit, 10) : undefined }) };
  }

  @Get(":appId/operations/:opId")
  async operation(@Param("id") id: string, @Param("appId") appId: string, @Param("opId") opId: string) {
    return { data: await this.service.operation(id, appId, opId) };
  }

  @Post(":appId/operations/:opId/cancel")
  async cancel(@Param("id") id: string, @Param("appId") appId: string, @Param("opId") opId: string, @Body() body: unknown) {
    return { data: await this.service.cancel(id, appId, opId, body) };
  }

  @Post(":appId/operations/:opId/recheck")
  async recheck(@Param("id") id: string, @Param("appId") appId: string, @Param("opId") opId: string, @Body() body: unknown) {
    return { data: await this.service.recheck(id, appId, opId, body) };
  }

  @Post(":appId/start")
  async start(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.work(id, appId, "lifecycle_start", body) };
  }

  @Post(":appId/stop")
  async stop(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.work(id, appId, "lifecycle_stop", body) };
  }

  @Post(":appId/restart")
  async restart(@Param("id") id: string, @Param("appId") appId: string, @Body() body: unknown) {
    return { data: await this.service.work(id, appId, "lifecycle_restart", body) };
  }
}
