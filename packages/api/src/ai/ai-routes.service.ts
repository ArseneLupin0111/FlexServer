import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { APP_CONFIG, AI_REPOSITORY, VPS_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { AiPersistenceConflictError, type AiRepository } from "../persistence/repositories/ai.persistence.js";
import { aiProviderKeyAad } from "../persistence/repositories/ai.repository.js";
import { redactString } from "../common/redaction.js";
import { decryptAiSecret, encryptAiSecret, loadAiKeyring } from "./ai-crypto.js";
import { AiProvider, fetchProviderModels } from "./ai-provider.js";
import type { AiProviderProfile, AiProviderProfileInternal } from "./ai.models.js";
import { updateAiPolicySchema, updateAiSettingsSchema, providerProfileWriteSchema } from "./ai.schemas.js";

// Global provider credentials have a reserved, non-task AAD identity.
export const AI_PROVIDER_KEY_CONTEXT = { vpsId: "global", taskId: "provider", field: "providerApiKey", version: 1 } as const;

const publicProviderProfile = (profile: AiProviderProfileInternal): AiProviderProfile => ({
  id: profile.id,
  name: profile.name,
  endpoint: profile.endpoint,
  models: profile.models,
  defaultModel: profile.defaultModel,
  enabled: profile.enabled,
  isDefault: profile.isDefault,
  hasApiKey: Boolean(profile.encryptedApiKey),
  allowPrivateEndpoint: profile.allowPrivateEndpoint ?? false,
  revision: profile.revision,
  updatedAt: profile.updatedAt,
});

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

  private async providerKeyring() {
    return loadAiKeyring(this.config.ai.keyringFile);
  }

  async settings(request: Request) {
    this.authorize(request);
    // After migration the legacy view reflects the effective default (Q14);
    // before migration it keeps serving the legacy slot unchanged.
    const view = await this.repository.getProviderMigrationState();
    if (view.migratedAt) {
      const fallback = view.providers.find((profile) => profile.isDefault) ?? view.providers[0];
      return { endpoint: fallback?.endpoint ?? "", model: fallback?.defaultModel ?? fallback?.models[0] ?? "", hasApiKey: Boolean(fallback?.encryptedApiKey), allowPrivateEndpoint: fallback?.allowPrivateEndpoint ?? false, revision: fallback?.revision ?? 0, updatedAt: fallback?.updatedAt ?? new Date(0).toISOString() };
    }
    const settings = view.legacy;
    return { endpoint: settings?.endpoint ?? "", model: settings?.model ?? "", hasApiKey: Boolean(settings?.encryptedApiKey), allowPrivateEndpoint: settings?.allowPrivateEndpoint ?? false, revision: settings?.revision ?? 0, updatedAt: settings?.updatedAt ?? new Date(0).toISOString() };
  }

  async updateSettings(request: Request, body: unknown) {
    this.authorize(request);
    const view = await this.repository.getProviderMigrationState();
    if (view.migratedAt) throw new ConflictException("Provider settings are read-only; manage provider profiles instead");
    const parsed = updateAiSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid AI settings");
    const { apiKey, ...patch } = parsed.data;
    const current = view.legacy;
    if (!apiKey && !current?.encryptedApiKey) throw new BadRequestException("Provider API key required");
    const apiKeyEnvelope = apiKey ? encryptAiSecret(apiKey, AI_PROVIDER_KEY_CONTEXT, await this.providerKeyring()) : undefined;
    try {
      await this.repository.updateSettings({ patch, apiKeyEnvelope, expectedRevision: current?.revision ?? 0 });
    } catch (error) {
      if (error instanceof AiPersistenceConflictError) throw new ConflictException("AI settings changed concurrently");
      throw error;
    }
    return this.settings(request);
  }

  async checkProvider(request: Request) {
    this.authorize(request);
    const view = await this.repository.getProviderMigrationState();
    if (view.migratedAt) {
      const fallback = view.providers.find((profile) => profile.isDefault) ?? view.providers[0];
      if (!fallback) throw new BadRequestException("Provider configuration required");
      return this.checkProfileInternal(fallback);
    }
    const settings = view.legacy;
    if (!settings?.encryptedApiKey) throw new BadRequestException("Provider configuration required");
    const apiKey = decryptAiSecret(settings.encryptedApiKey, AI_PROVIDER_KEY_CONTEXT, await this.providerKeyring());
    return new AiProvider().check({ ...settings, apiKey });
  }

  private async checkProfileInternal(profile: AiProviderProfileInternal) {
    if (!profile.encryptedApiKey) throw new BadRequestException("Provider API key required");
    const apiKey = decryptAiSecret(profile.encryptedApiKey, aiProviderKeyAad(profile.id), await this.providerKeyring());
    return new AiProvider().check({ endpoint: profile.endpoint, model: profile.defaultModel ?? profile.models[0]!, apiKey, allowPrivateEndpoint: profile.allowPrivateEndpoint });
  }

  async providers(request: Request) {
    this.authorize(request);
    const view = await this.repository.getProviderMigrationState();
    return { providers: view.providers.map(publicProviderProfile), lastSelection: view.lastSelection, migrated: Boolean(view.migratedAt) };
  }

  private profileWriteInput(body: unknown) {
    const parsed = providerProfileWriteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid provider profile");
    const input = parsed.data;
    const models = [...new Set(input.models.map((model) => redactString(model)))].filter(Boolean);
    if (models.length === 0) throw new BadRequestException("Provider requires at least one model");
    const defaultModel = input.defaultModel !== undefined ? redactString(input.defaultModel) : undefined;
    if (defaultModel !== undefined && !models.includes(defaultModel)) throw new BadRequestException("defaultModel must be one of models");
    return { input, models, defaultModel };
  }

  private async createProfileEnvelope(apiKey: string | undefined, providerId: string) {
    return apiKey ? encryptAiSecret(apiKey, aiProviderKeyAad(providerId), await this.providerKeyring()) : undefined;
  }

  async createProvider(request: Request, body: unknown) {
    this.authorize(request);
    const { input, models, defaultModel } = this.profileWriteInput(body);
    const id = randomUUID();
    const apiKeyEnvelope = await this.createProfileEnvelope(input.apiKey, id);
    try {
      const profile = await this.repository.createProviderProfile({
        id,
        name: redactString(input.name),
        endpoint: input.endpoint,
        models,
        defaultModel,
        enabled: input.enabled ?? true,
        isDefault: input.isDefault ?? false,
        allowPrivateEndpoint: input.allowPrivateEndpoint ?? false,
        apiKeyEnvelope,
      });
      return publicProviderProfile(profile);
    } catch (error) {
      if (error instanceof AiPersistenceConflictError) throw new ConflictException(error.detail ?? "Provider conflict");
      throw error;
    }
  }

  async updateProvider(request: Request, id: string, body: unknown) {
    this.authorize(request);
    const existing = await this.repository.getProviderProfile(id);
    if (!existing) throw new NotFoundException("Provider not found");
    const { input, models, defaultModel } = this.profileWriteInput(body);
    const apiKeyEnvelope = await this.createProfileEnvelope(input.apiKey, id);
    try {
      const profile = await this.repository.updateProviderProfile(id, {
        name: redactString(input.name),
        endpoint: input.endpoint,
        models,
        defaultModel,
        enabled: input.enabled ?? existing.enabled,
        isDefault: input.isDefault ?? existing.isDefault,
        allowPrivateEndpoint: input.allowPrivateEndpoint ?? existing.allowPrivateEndpoint ?? false,
        apiKeyEnvelope,
        expectedRevision: existing.revision,
      });
      return publicProviderProfile(profile);
    } catch (error) {
      if (error instanceof AiPersistenceConflictError) throw new ConflictException(error.detail ?? "Provider conflict");
      throw error;
    }
  }

  async deleteProvider(request: Request, id: string) {
    this.authorize(request);
    try {
      if (!await this.repository.deleteProviderProfile(id)) throw new NotFoundException("Provider not found");
      return { ok: true };
    } catch (error) {
      if (error instanceof AiPersistenceConflictError) throw new ConflictException(error.detail ?? "Provider still referenced");
      throw error;
    }
  }

  async checkProviderProfile(request: Request, id: string) {
    this.authorize(request);
    const profile = await this.repository.getProviderProfile(id);
    if (!profile) throw new NotFoundException("Provider not found");
    return this.checkProfileInternal(profile);
  }

  async fetchProviderModels(request: Request, id: string) {
    this.authorize(request);
    const profile = await this.repository.getProviderProfile(id);
    if (!profile) throw new NotFoundException("Provider not found");
    if (!profile.encryptedApiKey) throw new BadRequestException("Provider API key required");
    const apiKey = decryptAiSecret(profile.encryptedApiKey, aiProviderKeyAad(profile.id), await this.providerKeyring());
    const models = await fetchProviderModels({ endpoint: profile.endpoint, model: profile.defaultModel ?? profile.models[0]!, apiKey, allowPrivateEndpoint: profile.allowPrivateEndpoint });
    try {
      const updated = await this.repository.updateProviderProfile(id, {
        name: profile.name,
        endpoint: profile.endpoint,
        models,
        defaultModel: models.includes(profile.defaultModel ?? "") ? profile.defaultModel : models[0],
        enabled: profile.enabled,
        isDefault: profile.isDefault,
        allowPrivateEndpoint: profile.allowPrivateEndpoint ?? false,
        expectedRevision: profile.revision,
      });
      return publicProviderProfile(updated);
    } catch (error) {
      if (error instanceof AiPersistenceConflictError) throw new ConflictException(error.detail ?? "Provider conflict");
      throw error;
    }
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
