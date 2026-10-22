import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { APP_CONFIG, AI_REPOSITORY, VPS_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import { decryptAiSecret, encryptAiSecret, loadAiKeyring } from "./ai-crypto.js";
import { AiProvider } from "./ai-provider.js";
import { updateAiPolicySchema, updateAiSettingsSchema } from "./ai.schemas.js";

// Global provider credentials have a reserved, non-task AAD identity.
export const AI_PROVIDER_KEY_CONTEXT = { vpsId: "global", taskId: "provider", field: "providerApiKey", version: 1 } as const;

@Injectable()
export class AiRoutesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
  ) {}

  private authorize(request: Request): void {
    if (this.config.mode !== "local" || !this.config.ai.enabled) throw new ForbiddenException("AI disabled");
    if (!request.dashboardSessionId) throw new UnauthorizedException();
  }

  async settings(request: Request) {
    this.authorize(request);
    const settings = await this.repository.getSettings();
    return { endpoint: settings?.endpoint ?? "", model: settings?.model ?? "", hasApiKey: Boolean(settings?.encryptedApiKey), allowPrivateEndpoint: settings?.allowPrivateEndpoint ?? false, revision: settings?.revision ?? 0, updatedAt: settings?.updatedAt ?? new Date(0).toISOString() };
  }

  async updateSettings(request: Request, body: unknown) {
    this.authorize(request);
    const parsed = updateAiSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid AI settings");
    const { apiKey, ...patch } = parsed.data;
    const current = await this.repository.getSettings();
    if (!apiKey && !current?.encryptedApiKey) throw new BadRequestException("Provider API key required");
    const apiKeyEnvelope = apiKey ? encryptAiSecret(apiKey, AI_PROVIDER_KEY_CONTEXT, await loadAiKeyring(this.config.ai.keyringFile)) : undefined;
    await this.repository.updateSettings({ patch, apiKeyEnvelope, expectedRevision: current?.revision ?? 0 });
    return this.settings(request);
  }

  async checkProvider(request: Request) {
    this.authorize(request);
    const settings = await this.repository.getSettings();
    if (!settings?.encryptedApiKey) throw new BadRequestException("Provider configuration required");
    const apiKey = decryptAiSecret(settings.encryptedApiKey, AI_PROVIDER_KEY_CONTEXT, await loadAiKeyring(this.config.ai.keyringFile));
    return new AiProvider().check({ ...settings, apiKey });
  }

  async policy(request: Request, vpsId: string) {
    this.authorize(request);
    if (!await this.vps.get(vpsId)) throw new NotFoundException("VPS not found");
    return await this.repository.getAiPolicy(vpsId) ?? { vpsId, aiEnabled: true, readEnabled: true, dockerActionsEnabled: true, composeActionsEnabled: true, shellEnabled: false, fileReadScopes: [], fileWriteScopes: [], serviceProfileIds: [], sendLogsToProvider: false, sendFilesToProvider: false, revision: 0, updatedAt: new Date(0).toISOString() };
  }

  async updatePolicy(request: Request, vpsId: string, body: unknown) {
    const current = await this.policy(request, vpsId);
    const parsed = updateAiPolicySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid AI policy");
    return this.repository.updateAiPolicy({ vpsId, patch: parsed.data, expectedRevision: current.revision });
  }
}
