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
import { AiProvider, ProviderContextOverflowError, ProviderResponseTruncatedError, type ProviderMessage } from "../src/ai/ai-provider.js";
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

describe("assistant context compaction", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ai-compact-flow-")); }, 20_000);
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); }, 20_000);

  async function setup(modelWindows: Record<string, number> = {}) {
    const keyring = createTestKeyring("kek_compact_flow");
    await saveKeyringToFile(join(dir, "keyring.json"), keyring);
    const repository = createJsonAiRepository(join(dir, "ai.json"));
    const vps = createVpsStore(join(dir, "vps.json"));
    const server = await vps.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    await repository.updateSettings({ patch: { endpoint: "https://provider.example.test/v1", model: "test-model" }, apiKeyEnvelope: encryptAiSecret("sk-test-context", AI_PROVIDER_KEY_CONTEXT, keyring), expectedRevision: 0 });
    const config = { ...parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "compact-test-secret-0123456789abcdef" }), ai: { enabled: true, keyringFile: join(dir, "keyring.json"), contextWindowTokens: 16000, contextWindowTokensByModel: modelWindows, contextReserveTokens: 1000, contextTailTokens: 1000, maxCumulativeTaskTokens: 1000000 } };
    const service = new AiTaskService(repository, config, new AiPolicyService(config, repository), {} as MetricService, { authenticateById: async () => ({ sessionId: "admin-session" }) } as unknown as DashboardSessionService, {} as DockerMonitoringService, {} as AiHostPlanService, {} as AiDockerBridgeService, {} as DockerMonitoringRepository, {} as AiReadToolsService, vps);
    const conversation = await repository.createConversation(server.id, "Existing chat");
    for (let index = 0; index < 60; index++) {
      await repository.appendMessage({ id: `history-${index}`, vpsId: server.id, conversationId: conversation.id, role: index % 2 ? "assistant" : "user", content: `historical-${index} ${"disk usage ".repeat(210)}` });
    }
    return { repository, service, server, conversation };
  }
  async function wait(repository: Awaited<ReturnType<typeof setup>>["repository"], vpsId: string, taskId: string) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const task = await repository.getTask(vpsId, taskId);
      if (task?.state === "succeeded" || task?.state === "failed" || task?.state === "awaiting_approval") return task;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("task did not terminate");
  }

  it("summarizes older messages, preserves the current turn and raw transcript, and chains a checkpoint", async () => {
    const { repository, service, server, conversation } = await setup();
    const requests: { messages: readonly ProviderMessage[]; noTools: boolean }[] = [];
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_config, messages, tools) => {
      requests.push({ messages: [...messages], noTools: tools.length === 0 });
      return { message: { role: "assistant", content: tools.length ? "Current request acknowledged" : "Historical disk investigation, evidence is stale; re-observe." }, usage: { inputTokens: 3000, outputTokens: 40, estimated: false } };
    });
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "What next?", idempotencyKey: "compact-success" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state, JSON.stringify(outcome.error)).toBe("succeeded");
    expect(requests.some(entry => entry.noTools)).toBe(true);
    const final = requests.findLast(entry => !entry.noTools)!.messages;
    expect(final.filter(message => message.role === "system")).toHaveLength(1);
    expect(final.find(message => message.content.includes("Historical conversation summary"))?.role).toBe("user");
    expect(final.map(message => message.content).join("\n")).toContain("What next?");
    expect(final.map(message => message.content).join("\n")).toContain("Historical disk investigation");
    const checkpoint = await repository.getConversationCheckpoint(server.id, conversation.id);
    expect(checkpoint?.coveredMessageCount).toBeGreaterThan(0);
    expect((await repository.listConversationHistory(conversation.id)).total).toBe(62);
    expect(outcome.compacting).not.toBe(true);
    expect(outcome.usage.inputTokens).toBeGreaterThan(3000);
  });

  it("uses the active model window rather than the global window for preflight", async () => {
    const { repository, service, server, conversation } = await setup({ "test-model": 8_000 });
    const requests: { messages: readonly ProviderMessage[]; noTools: boolean }[] = [];
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_settings, messages, tools) => {
      requests.push({ messages: [...messages], noTools: tools.length === 0 });
      return { message: { role: "assistant", content: tools.length ? "Done" : "Prior disk investigation, stale." }, usage: { inputTokens: 100, outputTokens: 20, estimated: false } };
    });
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "model-window" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state, JSON.stringify(outcome.error)).toBe("succeeded");
    expect(requests.some(entry => entry.noTools)).toBe(true);
    expect((await repository.getConversationCheckpoint(server.id, conversation.id))?.summaryModel).toBe("test-model");
  });

  it("retries one proven overflow after compaction and never dispatches a third attempt", async () => {
    const { repository, service, server, conversation } = await setup();
    let regularCalls = 0;
    let compactCalls = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_config, _messages, tools) => {
      if (!tools.length) {
        compactCalls++;
        return { message: { role: "assistant", content: "Stale disk history; re-observe." }, usage: { inputTokens: 1000, outputTokens: 10, estimated: false } };
      }
      regularCalls++;
      throw new ProviderContextOverflowError();
    });
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "overflow-once" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state).toBe("failed");
    expect(outcome.error?.code).toBe("provider_context_overflow");
    expect(regularCalls).toBe(2);
    expect(compactCalls).toBeGreaterThan(0);
  });

  it("retains the actual overflow failure when the mandatory current turn cannot be compacted", async () => {
    const { repository, service, server, conversation } = await setup();
    await repository.saveConversationCheckpoint({ vpsId: server.id, conversationId: conversation.id, expectedRevision: 0, coveredMessageId: "history-59", summary: "Prior compact context", summaryModel: "test-model" });
    const generate = vi.spyOn(AiProvider.prototype, "generate").mockRejectedValue(new ProviderContextOverflowError());
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "overflow-no-safe-history" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.error?.code).toBe("provider_context_overflow");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("compacts completed clarification turns but preserves the latest user input", async () => {
    const { repository, service, server, conversation } = await setup();
    await repository.saveConversationCheckpoint({ vpsId: server.id, conversationId: conversation.id, expectedRevision: 0, coveredMessageId: "history-59", summary: "Previous compact history", summaryModel: "test-model" });
    const taskId = "clarification-task";
    await repository.appendMessage({ id: "clarification-initial", vpsId: server.id, conversationId: conversation.id, taskId, role: "user", content: `Please check the service ${"historical detail ".repeat(35)}` });
    await repository.appendMessage({ id: "clarification-question", vpsId: server.id, conversationId: conversation.id, taskId, role: "assistant", content: `Which service? ${"historical detail ".repeat(35)}` });
    await repository.appendMessage({ id: "clarification-old-answer", vpsId: server.id, conversationId: conversation.id, taskId, role: "user", content: `nginx ${"historical detail ".repeat(35)}` });
    await repository.appendMessage({ id: "clarification-follow-up", vpsId: server.id, conversationId: conversation.id, taskId, role: "assistant", content: `Which host? ${"historical detail ".repeat(35)}` });
    await repository.appendMessage({ id: "clarification-current-answer", vpsId: server.id, conversationId: conversation.id, taskId, role: "user", content: "This host" });
    const stored = await repository.createTask({ id: taskId, vpsId: server.id, conversationId: conversation.id, state: "planning", requestSummary: "Please check the service", idempotencyKey: "clarification-compact", initiatingSessionId: "admin-session" });
    const requests: { messages: readonly ProviderMessage[]; noTools: boolean }[] = [];
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_settings, messages, tools) => {
      requests.push({ messages: [...messages], noTools: tools.length === 0 });
      return { message: { role: "assistant", content: tools.length ? "Done" : "Historical service discussion" }, usage: { inputTokens: 100, outputTokens: 20, estimated: false } };
    });
    const context = await (service as unknown as { prepareContext: (...args: unknown[]) => Promise<{ messages: ProviderMessage[] }> }).prepareContext(stored.task, { endpoint: "https://provider.example.test/v1", model: "test-model", apiKey: "test" }, new AbortController().signal, [], { providerRevision: 1, policyRevision: 0, sessionId: "admin-session" }, true);
    expect(requests.some(entry => entry.noTools)).toBe(true);
    expect((await repository.getConversationCheckpoint(server.id, conversation.id))?.coveredMessageId).toBe("clarification-follow-up");
    expect(context.messages.at(-1)?.content).toBe("This host");
    expect(context.messages.map(message => message.content).join("\n")).not.toContain("Which host?");
  });

  it("stops normal dispatch when log egress is revoked during compaction", async () => {
    const { repository, service, server, conversation } = await setup();
    await repository.updateAiPolicy({ vpsId: server.id, expectedRevision: 0, patch: { sendLogsToProvider: true } });
    await repository.appendMessage({ id: "restricted-before-compact", vpsId: server.id, conversationId: conversation.id, role: "assistant", content: "Prior log observation", restrictedSources: ["logs"] });
    let normalCalls = 0;
    let summaryCalls = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_settings, _messages, tools) => {
      if (tools.length) {
        normalCalls++;
        return { message: { role: "assistant", content: "Should not dispatch" }, usage: { inputTokens: 1, outputTokens: 1, estimated: false } };
      }
      summaryCalls++;
      await repository.updateAiPolicy({ vpsId: server.id, expectedRevision: 1, patch: { sendLogsToProvider: false } });
      return { message: { role: "assistant", content: "Historical discussion" }, usage: { inputTokens: 100, outputTokens: 20, estimated: false } };
    });
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "revoke-during-compact" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.error?.code).toBe("policy_denied");
    expect(summaryCalls).toBeGreaterThan(0);
    expect(normalCalls).toBe(0);
  });

  it("does not replay restricted historical evidence after its egress grant is revoked", async () => {
    const { repository, service, server, conversation } = await setup();
    await repository.updateAiPolicy({ vpsId: server.id, expectedRevision: 0, patch: { sendLogsToProvider: true, sendFilesToProvider: true } });
    await repository.appendMessage({ id: "restricted-history", vpsId: server.id, conversationId: conversation.id, role: "assistant", content: "Past log and file observations", restrictedSources: ["logs", "files"] });
    await repository.updateAiPolicy({ vpsId: server.id, expectedRevision: 1, patch: { sendLogsToProvider: false, sendFilesToProvider: false } });
    const generate = vi.spyOn(AiProvider.prototype, "generate");
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "revoked-history" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.error?.code).toBe("policy_denied");
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not replay a checkpoint containing restricted evidence after revocation", async () => {
    const { repository, service, server, conversation } = await setup();
    await repository.saveConversationCheckpoint({ vpsId: server.id, conversationId: conversation.id, expectedRevision: 0, coveredMessageId: "history-57", summary: "Historical log excerpt", summaryModel: "test-model", restrictedSources: ["logs"] });
    const generate = vi.spyOn(AiProvider.prototype, "generate");
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "revoked-checkpoint" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.error?.code).toBe("policy_denied");
    expect(generate).not.toHaveBeenCalled();
  });

  it("preserves bounded observations when a task transitions to an approval plan", async () => {
    const { repository, service, server, conversation } = await setup();
    await repository.saveConversationCheckpoint({ vpsId: server.id, conversationId: conversation.id, expectedRevision: 0, coveredMessageId: "history-59", summary: "Prior compact context", summaryModel: "test-model" });
    const internal = service as unknown as { readToolsService: AiReadToolsService; dockerBridge: AiDockerBridgeService };
    Object.assign(internal.readToolsService, {
      isReadTool: (name: string) => name === "service_status",
      execute: async () => JSON.stringify({ available: true, observedAt: "2026-10-24T10:00:00.000Z", status: "healthy" }),
    });
    Object.assign(internal.dockerBridge, {
      propose: async () => ({ step: { stepId: "step-1", tool: "docker_action", version: 1, args: {}, resourceKeys: [], inputDigests: {}, description: "Synthetic approval", timeoutSeconds: 30 }, preconditions: [] }),
    });
    let call = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
      call++;
      return { message: { role: "assistant", content: "", toolCalls: [{ id: `call-${call}`, type: "function", function: { name: call === 1 ? "service_status" : "docker_action", arguments: "{}" } }] }, usage: { inputTokens: 100, outputTokens: 20, estimated: false } };
    });
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Inspect then propose", idempotencyKey: "approval-evidence" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state, JSON.stringify(outcome.error)).toBe("awaiting_approval");
    const history = await repository.listConversationHistory(conversation.id);
    expect(history.messages.some(message => message.evidence?.some(item => item.source === "service_status"))).toBe(true);
  });

  it("preserves the previous checkpoint when a forced summary gains no headroom", async () => {
    const { repository, service, server, conversation } = await setup();
    const previous = await repository.saveConversationCheckpoint({ vpsId: server.id, conversationId: conversation.id, expectedRevision: 0, coveredMessageId: "history-57", summary: "Prior compact context", summaryModel: "test-model" });
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_settings, _messages, tools) => {
      if (tools.length) throw new ProviderContextOverflowError();
      return { message: { role: "assistant", content: "irreducible ".repeat(1900) }, usage: { inputTokens: 100, outputTokens: 20, estimated: false } };
    });
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "ineffective-summary" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.error?.code).toBe("provider_context_overflow");
    expect(await repository.getConversationCheckpoint(server.id, conversation.id)).toEqual(previous);
    expect((await repository.listConversationHistory(conversation.id)).total).toBe(61);
  });

  it("rejects truncated summaries without committing a checkpoint or losing raw turns", async () => {
    const { repository, service, server, conversation } = await setup();
    vi.spyOn(AiProvider.prototype, "generate").mockRejectedValue(new ProviderResponseTruncatedError());
    const task = await service.create(request, server.id, { conversationId: conversation.id, request: "Continue", idempotencyKey: "compact-truncated" });
    const outcome = await wait(repository, server.id, task.id);
    expect(outcome.state).toBe("failed");
    expect(await repository.getConversationCheckpoint(server.id, conversation.id)).toBeUndefined();
    expect((await repository.listConversationHistory(conversation.id)).total).toBe(61);
    expect(outcome.compacting).not.toBe(true);
  });
});
