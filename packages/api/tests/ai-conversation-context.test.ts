import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiProvider, type ProviderMessage } from "../src/ai/ai-provider.js";
import { AI_PROVIDER_KEY_CONTEXT } from "../src/ai/ai-routes.service.js";
import { encryptAiSecret } from "../src/ai/ai-crypto.js";
import { createTestKeyring, saveKeyringToFile } from "../src/ssh/key-encryption.js";
import type { MetricService } from "../src/metrics/metric.service.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import type { AiHostPlanService } from "../src/ai/ai-host-plan.service.js";
import type { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import type { AiReadToolsService } from "../src/ai/ai-read-tools.service.js";

const request = { dashboardSessionId: "admin-session" } as Request;

describe("conversation context across tasks", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ai-context-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it("includes previous turns only from the selected conversation without authorizing an ok reply", async () => {
    const keyring = createTestKeyring("kek_context_test");
    await saveKeyringToFile(join(dir, "keyring.json"), keyring);
    const repository = createJsonAiRepository(join(dir, "ai.json"));
    const vps = createVpsStore(join(dir, "vps.json"));
    const server = await vps.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    await repository.updateSettings({ patch: { endpoint: "https://provider.example.test/v1", model: "test-model" }, apiKeyEnvelope: encryptAiSecret("sk-test-context", AI_PROVIDER_KEY_CONTEXT, keyring), expectedRevision: 0 });
    const config = { ...parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "context-test-secret-0123456789abcdef" }), ai: { enabled: true, keyringFile: join(dir, "keyring.json") } };
    const service = new AiTaskService(repository, config, new AiPolicyService(config, repository), {} as MetricService, { authenticateById: async () => ({ sessionId: "admin-session" }) } as unknown as DashboardSessionService, {} as DockerMonitoringService, {} as AiHostPlanService, {} as AiDockerBridgeService, {} as DockerMonitoringRepository, {} as AiReadToolsService, vps);
    const requests: ProviderMessage[][] = [];
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_settings, messages) => {
      requests.push([...messages]);
      return { message: { role: "assistant", content: requests.length === 1 ? "Disk currently 90% full; investigate large directories." : "I can inspect large directories." }, usage: { inputTokens: 100, outputTokens: 20, estimated: false } };
    });
    const wait = async (id: string) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const task = await repository.getTask(server.id, id);
        if (task?.state === "succeeded" || task?.state === "failed") return task;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("task timed out");
    };
    const first = await service.create(request, server.id, { request: "How full is disk?", idempotencyKey: "disk-first" });
    const firstOutcome = await wait(first.id);
    expect(firstOutcome.state, JSON.stringify(firstOutcome.error)).toBe("succeeded");
    const other = await repository.createConversation(server.id, "private");
    await repository.appendMessage({ id: "private-message", vpsId: server.id, conversationId: other.id, role: "user", content: "DO NOT LEAK THIS" });
    const second = await service.create(request, server.id, { request: "ok", conversationId: first.conversationId, idempotencyKey: "disk-second" });
    expect((await wait(second.id)).state).toBe("succeeded");
    const payload = requests[1]!.map(message => message.content).join("\n");
    expect(payload).toContain("How full is disk?");
    expect(payload).toContain("Disk currently 90% full");
    expect(payload).toContain("ok");
    expect(payload).not.toContain("DO NOT LEAK THIS");
    expect(second.plan).toBeNull();
  });
});
