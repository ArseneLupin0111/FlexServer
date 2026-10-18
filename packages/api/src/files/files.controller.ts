import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { DashboardSessionGuard } from "../auth/dashboard-session.guard.js";
import { OriginGuard } from "../auth/origin-guard.js";
import { cleanFilesPath, directoryBodySchema, renameBodySchema } from "./files.schemas.js";
import { FilesService } from "./files.service.js";

@Controller("api/vps/:id/files")
@UseGuards(DashboardSessionGuard, OriginGuard)
export class FilesController {
  constructor(@Inject(FilesService) private readonly filesService: FilesService) {}

  @Get("capabilities")
  async capabilities(@Param("id") id: string) {
    const data = await this.filesService.capabilities(id);
    return { data };
  }

  @Get("entries")
  async list(
    @Param("id") id: string,
    @Query("path") rawPath: unknown,
    @Req() req: Request,
  ) {
    const path = cleanFilesPath(rawPath ?? "/", true);
    const data = await this.filesService.list(id, path, {
      dashboardSessionId: req.dashboardSessionId,
    });
    return { data };
  }

  @Get("download")
  async download(
    @Param("id") id: string,
    @Query("path") rawPath: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const path = cleanFilesPath(rawPath, false);
    await this.filesService.download(id, path, res, {
      dashboardSessionId: req.dashboardSessionId,
    });
  }

  @Put("upload")
  @HttpCode(201)
  async upload(
    @Param("id") id: string,
    @Query("path") rawPath: unknown,
    @Req() req: Request,
  ) {
    const path = cleanFilesPath(rawPath, false);
    const data = await this.filesService.upload(id, path, req, {
      dashboardSessionId: req.dashboardSessionId,
    });
    return { data };
  }

  @Post("directory")
  @HttpCode(201)
  async mkdir(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = directoryBodySchema.parse(body);
    const data = await this.filesService.mkdir(id, parsed.path, {
      dashboardSessionId: req.dashboardSessionId,
    });
    return { data };
  }

  @Post("rename")
  @HttpCode(200)
  async rename(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = renameBodySchema.parse(body);
    const data = await this.filesService.rename(id, parsed.path, parsed.newPath, {
      dashboardSessionId: req.dashboardSessionId,
    });
    return { data };
  }

  @Delete("entry")
  @HttpCode(204)
  async delete(
    @Param("id") id: string,
    @Query("path") rawPath: unknown,
    @Req() req: Request,
  ) {
    const path = cleanFilesPath(rawPath, false);
    await this.filesService.delete(id, path, {
      dashboardSessionId: req.dashboardSessionId,
    });
  }
}
