import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { parseAppConfig } from "../src/config/app-config.js";
import { AiRoutesService } from "../src/ai/ai-routes.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";

const request = { dashboardSessionId: "admin-session" } as unknown as Request;

describe("AI settings availability", () => {
  it("allows provider setup by default but refuses use before a provider is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-settings-"));
    try {
      const config = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "settings-test-secret-at-least-32-characters" });
      const repository = createJsonAiRepository(join(dir, "ai.json"));
      const routes = new AiRoutesService(config, repository, createVpsStore(join(dir, "vps.json")));
      await expect(routes.settings(request)).resolves.toMatchObject({ endpoint: "", model: "", hasApiKey: false });
      await expect(new AiPolicyService(config, repository).resolveProviderReadiness()).resolves.toEqual({ configured: false, reason: "provider_unavailable" });
      const disabled = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "settings-test-secret-at-least-32-characters", APP_AI_ENABLED: "false" });
      await expect(new AiRoutesService(disabled, repository, createVpsStore(join(dir, "vps.json"))).settings(request)).rejects.toMatchObject({ status: 403 });
      await expect(new AiPolicyService(disabled, repository).resolveProviderReadiness()).resolves.toEqual({ configured: false, reason: "ai_disabled" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
