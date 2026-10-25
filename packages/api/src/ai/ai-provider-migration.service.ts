import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AI_REPOSITORY, APP_CONFIG } from "../tokens.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import { aiProviderKeyAad } from "../persistence/repositories/ai.repository.js";
import type { AppConfig } from "../config/app-config.js";
import { redactString } from "../common/redaction.js";
import { AiCryptoUnavailableError, decryptAiSecret, encryptAiSecret, loadAiKeyring, type AiEnvelopeData } from "./ai-crypto.js";
import { AI_PROVIDER_KEY_CONTEXT } from "./ai-routes.service.js";

/** Boot migration (docs/ai-multi-provider-plan.md Q15): converts the legacy
 * single provider slot into the first profile, re-encrypting the API key
 * under a per-provider AAD. Idempotent; defers (never crashes boot) while
 * the keyring is unavailable and retries on the next boot. The legacy
 * settings slot is deliberately kept so an older build still runs after a
 * rollback. */
@Injectable()
export class AiProviderMigrationService implements OnModuleInit {
  private readonly logger = new Logger("AiProviderMigration");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.migrate();
    } catch (error) {
      if (error instanceof AiCryptoUnavailableError) {
        this.logger.warn("AI keyring unavailable; provider migration deferred to the next boot");
        return;
      }
      this.logger.error(`AI provider migration failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async migrate(): Promise<void> {
    const view = await this.repository.getProviderMigrationState();
    if (view.migratedAt) return;
    if (view.providers.length > 0 || !view.legacy?.model) {
      // Profiles already exist (marker only) or nothing usable to convert.
      await this.repository.completeProviderMigration();
      return;
    }
    const legacy = view.legacy;
    const model = redactString(legacy.model);
    const id = randomUUID();
    let envelope: AiEnvelopeData | undefined;
    if (legacy.encryptedApiKey) {
      const keyring = await loadAiKeyring(this.config.ai.keyringFile);
      envelope = encryptAiSecret(decryptAiSecret(legacy.encryptedApiKey, AI_PROVIDER_KEY_CONTEXT, keyring), aiProviderKeyAad(id), keyring);
    }
    await this.repository.completeProviderMigration({
      id,
      name: "Default",
      endpoint: legacy.endpoint,
      models: [model],
      defaultModel: model,
      enabled: true,
      isDefault: true,
      encryptedApiKey: envelope,
      allowPrivateEndpoint: legacy.allowPrivateEndpoint ?? false,
      authKind: "apiKey",
      revision: 1,
      updatedAt: new Date().toISOString(),
    });
    this.logger.log("Migrated legacy AI provider settings into the first provider profile");
  }
}
