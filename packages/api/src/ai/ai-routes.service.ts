import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { APP_CONFIG, AI_REPOSITORY, VPS_REPOSITORY } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { AiPersistenceConflictError, type AiRepository } from "../persistence/repositories/ai.persistence.js";
import { aiProviderKeyAad, defaultAiPolicy } from "../persistence/repositories/ai.repository.js";
import { redactString } from "../common/redaction.js";
import { decryptAiSecret, encryptAiSecret, loadAiKeyring } from "./ai-crypto.js";
import { AiProvider, fetchProviderModels } from "./ai-provider.js";
import { generateCodexRequest } from "./ai-codex-provider.js";
import type { AiProviderProfile, AiProviderProfileInternal } from "./ai.models.js";
import { updateAiPolicySchema, updateAiSettingsSchema, providerProfileWriteSchema, codexOauthExchangeSchema } from "./ai.schemas.js";
import { AiCodexOauthService, CodexOauthReloginRequiredError, CodexOauthStateError } from "./ai-codex-oauth.service.js";
import { AiBundleOrchestrationService } from "./ai-bundle-install.service.js";

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
  authKind: profile.authKind,
  tokenState: profile.tokenState,
  revision: profile.revision,
  updatedAt: profile.updatedAt,
});

@Injectable()
export class AiRoutesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(AiCodexOauthService) private readonly codexOauth: AiCodexOauthService,
    // Optional (PR #37 lesson): hand-built test/module configs may not wire
    // the AI bundle orchestration; bundle routes then degrade gracefully.
    @Optional()
    @Inject(AiBundleOrchestrationService)
    private readonly bundleOrchestrator?: AiBundleOrchestrationService,
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
    if (profile.authKind === "chatgpt_oauth") {
      const accessToken = await this.codexOauth.getValidAccessToken(profile.id);
      const result = await generateCodexRequest(
        { apiBaseUrl: profile.endpoint, cliVersion: this.config.ai.codexOauth.cliVersion, model: profile.defaultModel ?? profile.models[0]!, accessToken, allowPrivateEndpoint: profile.allowPrivateEndpoint },
        [{ role: "user", content: "Call flexserver_check with {ok:true}. No infrastructure data is provided." }],
        [{ type: "function", function: { name: "flexserver_check", description: "Synthetic protocol check only", parameters: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false } } }],
      );
      const calls = result.message.toolCalls;
      if (calls?.length !== 1 || calls[0]!.function.name !== "flexserver_check") throw new BadRequestException("Codex protocol check failed");
      const args = JSON.parse(calls[0]!.function.arguments) as Record<string, unknown>;
      if (args.ok !== true || Object.keys(args).length !== 1) throw new BadRequestException("Codex protocol check failed");
      return { ok: true } as const;
    }
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
    const authKind = input.authKind ?? "apiKey";
    if (authKind === "apiKey" && !input.endpoint) throw new BadRequestException("Provider endpoint required");
    // chatgpt_oauth profiles are pinned to the configured Codex API base;
    // API keys are meaningless for them (auth comes from OAuth tokens).
    const endpoint = authKind === "chatgpt_oauth" ? this.config.ai.codexOauth.apiBaseUrl : input.endpoint!;
    const id = randomUUID();
    const apiKeyEnvelope = authKind === "apiKey" ? await this.createProfileEnvelope(input.apiKey, id) : undefined;
    try {
      const profile = await this.repository.createProviderProfile({
        id,
        name: redactString(input.name),
        endpoint,
        models,
        defaultModel,
        enabled: input.enabled ?? true,
        isDefault: input.isDefault ?? false,
        allowPrivateEndpoint: authKind === "chatgpt_oauth" ? false : input.allowPrivateEndpoint ?? false,
        authKind,
        apiKeyEnvelope,
      });
      return publicProviderProfile(profile);
    } catch (error) {
      if (error instanceof AiPersistenceConflictError) throw new ConflictException(error.detail ?? "Provider conflict");
      throw error;
    }
  }

  /** Slice 4 (docs/ai-chatgpt-oauth-provider-plan.md): start the paste-back
   * OAuth flow for one saved chatgpt_oauth profile. */
  async authorizeProviderOauth(request: Request, id: string) {
    this.authorize(request);
    const profile = await this.repository.getProviderProfile(id);
    if (!profile) throw new NotFoundException("Provider not found");
    if (profile.authKind !== "chatgpt_oauth") throw new BadRequestException("Provider is not a ChatGPT OAuth profile");
    return this.codexOauth.beginAuthorize(id);
  }

  async exchangeProviderOauth(request: Request, id: string, body: unknown) {
    this.authorize(request);
    const profile = await this.repository.getProviderProfile(id);
    if (!profile) throw new NotFoundException("Provider not found");
    if (profile.authKind !== "chatgpt_oauth") throw new BadRequestException("Provider is not a ChatGPT OAuth profile");
    const parsed = codexOauthExchangeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid OAuth callback URL");
    let tokens;
    try {
      tokens = await this.codexOauth.exchangeCallback(id, parsed.data.callbackUrl);
    } catch (error) {
      if (error instanceof CodexOauthReloginRequiredError || error instanceof CodexOauthStateError) {
        throw new BadRequestException(error instanceof CodexOauthStateError ? "OAuth login session expired or unknown — start again" : "OpenAI rejected the login — start again");
      }
      throw error;
    }
    const updated = await this.repository.getProviderProfile(id);
    if (!updated) throw new NotFoundException("Provider not found");
    return { profile: publicProviderProfile(updated), expiresAt: tokens.expiresAt, lastRefreshedAt: tokens.lastRefreshedAt };
  }

  async updateProvider(request: Request, id: string, body: unknown) {
    this.authorize(request);
    const existing = await this.repository.getProviderProfile(id);
    if (!existing) throw new NotFoundException("Provider not found");
    const { input, models, defaultModel } = this.profileWriteInput(body);
    if (existing.authKind === "apiKey" && !input.endpoint) throw new BadRequestException("Provider endpoint required");
    // OAuth profiles keep their pinned Codex endpoint and take no API key.
    const endpoint = existing.authKind === "chatgpt_oauth" ? existing.endpoint : input.endpoint!;
    const apiKeyEnvelope = existing.authKind === "apiKey" ? await this.createProfileEnvelope(input.apiKey, id) : undefined;
    try {
      const profile = await this.repository.updateProviderProfile(id, {
        name: redactString(input.name),
        endpoint,
        models,
        defaultModel,
        enabled: input.enabled ?? existing.enabled,
        isDefault: input.isDefault ?? existing.isDefault,
        allowPrivateEndpoint: existing.authKind === "chatgpt_oauth" ? false : input.allowPrivateEndpoint ?? existing.allowPrivateEndpoint ?? false,
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
    if (profile.authKind === "chatgpt_oauth") throw new BadRequestException("ChatGPT OAuth profiles use a fixed model list; edit it manually");
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
    return await this.repository.getAiPolicy(vpsId) ?? defaultAiPolicy(vpsId);
  }

  /** GET /api/vps/:id/ai/bundle — bundled AI artifacts + per-VPS install
   * state (pinned shape, see AiBundleView). Degrades to available=false with
   * a reason when the orchestration is not wired or the bundle is missing. */
  async bundle(request: Request, vpsId: string) {
    this.authorize(request);
    if (!await this.vps.get(vpsId)) throw new NotFoundException("VPS not found");
    if (!this.bundleOrchestrator) {
      return {
        available: false,
        reason: "AI bundle orchestration is not available in this deployment",
        bundleId: null,
        installed: false,
        lastInstalledBundleId: null,
        lastJob: null,
        capability: { supported: false, privilegedSupported: false },
      };
    }
    return this.bundleOrchestrator.getBundleView(vpsId);
  }

  /** POST /api/vps/:id/ai/bundle/install — deliberate "Install/Update AI
   * bundle" action; idempotent while a job is pending/running, 503 when the
   * bundle is unavailable. */
  async installBundle(request: Request, vpsId: string) {
    this.authorize(request);
    if (!await this.vps.get(vpsId)) throw new NotFoundException("VPS not found");
    if (!this.bundleOrchestrator) {
      throw new ServiceUnavailableException("AI bundle orchestration is not available in this deployment");
    }
    return this.bundleOrchestrator.installBundle(vpsId, "manual");
  }

  async updatePolicy(request: Request, vpsId: string, body: unknown) {
    const current = await this.policy(request, vpsId);
    const parsed = updateAiPolicySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid AI policy");
    const { execMode, acknowledgePrivileged, ...patch } = parsed.data;
    // Privileged execution (execmode plan Q4) is gated by a one-time risk
    // acknowledgment: this request must carry `acknowledgePrivileged` OR the
    // policy must already hold a retained acknowledgment. Sandbox is free.
    if (execMode === "privileged" && acknowledgePrivileged !== true && current.privilegedAcknowledgedAt === null) {
      throw new BadRequestException("Privileged execution requires acknowledging the risk first (acknowledgePrivileged)");
    }
    // A fresh acknowledgment is recorded with the authenticated admin's
    // session identity; prior ones are refreshed only on explicit re-ack and
    // never cleared (switching back to sandbox keeps them).
    const acknowledgmentPatch =
      execMode === "privileged" && acknowledgePrivileged === true
        ? { privilegedAcknowledgedAt: new Date().toISOString(), privilegedAcknowledgedBy: request.dashboardSessionId ?? null }
        : {};
    const updated = await this.repository.updateAiPolicy({
      vpsId,
      patch: { ...patch, ...(execMode ? { execMode } : {}), ...acknowledgmentPatch },
      expectedRevision: current.revision,
    });
    // Q8 deliberate-action trigger: AFTER a successful persist, the first AI
    // bundle install is scheduled only on an explicit enable action (AI
    // off→on, shell off→on, or an execMode change) and only when the bundle
    // is present but not yet installed on the host. Fire-and-forget with
    // error containment; never scheduled from GETs; convergence (Q7) owns
    // later version updates.
    if (
      this.bundleOrchestrator &&
      ((!current.aiEnabled && updated.aiEnabled) ||
        (!current.shellEnabled && updated.shellEnabled) ||
        current.execMode !== updated.execMode)
    ) {
      void this.bundleOrchestrator
        .maybeInstallAfterDeliberateAction(vpsId)
        .catch(() => {});
    }
    return updated;
  }
}
