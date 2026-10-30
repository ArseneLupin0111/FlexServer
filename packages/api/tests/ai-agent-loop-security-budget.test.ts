import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository, aiProviderKeyAad } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiProvider } from "../src/ai/ai-provider.js";
import { encryptAiSecret } from "../src/ai/ai-crypto.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { MetricService } from "../src/metrics/metric.service.js";
import type { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import type { AiHostPlanService } from "../src/ai/ai-host-plan.service.js";
import { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import type { AiReadToolsService } from "../src/ai/ai-read-tools.service.js";
import { createTestKeyring, saveKeyringToFile, type Keyring } from "../src/ssh/key-encryption.js";

const request = { dashboardSessionId: "admin-session" } as unknown as Request;

describe("AI loop security and budget boundaries", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let config: AppConfig;
  let service: AiTaskService;
  let bridgeService: AiDockerBridgeService;
  let readToolsService: AiReadToolsService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-loop-security-tests-"));
    const keyring: Keyring = createTestKeyring("kek_loop_security_tests");
    const keyringFile = join(dir, "ai-keyring.json");
    await saveKeyringToFile(keyringFile, keyring);
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    const server = await vpsRepo.create({ name: "Loop security VPS", host: "127.0.0.1", port: 22, username: "root", dockerManagementEnabled: true });
    vpsId = server.id;

    const parsed = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "ai-loop-security-secret-at-least-32-chars" });
    config = {
      ...parsed,
      ai: {
        ...parsed.ai,
        enabled: true,
        keyringFile,
        contextWindowTokens: 16000,
        contextReserveTokens: 1000,
        contextTailTokens: 1000,
        maxCumulativeTaskTokens: 500000,
      },
    };
    const profileId = "loop-security-provider";
    await aiRepo.createProviderProfile({
      id: profileId,
      name: "Loop security provider",
      endpoint: "https://provider.example.test/v1",
      models: ["loop-security-model"],
      defaultModel: "loop-security-model",
      enabled: true,
      isDefault: true,
      apiKeyEnvelope: encryptAiSecret("sk-loop-security-fixture", aiProviderKeyAad(profileId), keyring),
    });

    bridgeService = {
      propose: vi.fn(async (_task, tool, rawArgs) => ({
        step: {
          stepId: randomUUID(),
          tool,
          version: 1,
          args: (rawArgs as Record<string, unknown>) ?? {},
          resourceKeys: ["docker:app-service"],
          inputDigests: {},
          description: `Execute ${tool}`,
          timeoutSeconds: 30,
        },
        preconditions: [],
      })),
      execute: vi.fn(async () => ({ ok: true, result: { message: "mutation applied" } })),
    } as unknown as AiDockerBridgeService;
    readToolsService = {
      isReadTool: vi.fn((name: string) => name === "service_status"),
      execute: vi.fn(async () => JSON.stringify({ active: "active", status: "running", subState: "running", unit: "app-service" })),
    } as unknown as AiReadToolsService;
    const sessions = { authenticateById: async (sessionId: string) => sessionId === "admin-session" ? { sessionId } : null } as unknown as DashboardSessionService;
    service = new AiTaskService(
      aiRepo,
      config,
      new AiPolicyService(config, aiRepo),
      { list: vi.fn(async () => []) } as unknown as MetricService,
      sessions,
      {} as unknown as DockerMonitoringService,
      {} as unknown as AiHostPlanService,
      bridgeService,
      { getAuthoritativeLatest: vi.fn(async () => ({ activeInstanceId: "agent-inst-1" })), currentContainers: vi.fn(async () => []) } as unknown as DockerMonitoringRepository,
      readToolsService,
      vpsRepo,
    );
  });

  afterEach(async () => {
    service?.onModuleDestroy();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function setPolicy(patch: Partial<AiPolicy> = {}): Promise<AiPolicy> {
    const current = await aiRepo.getAiPolicy(vpsId);
    return aiRepo.updateAiPolicy({
      vpsId,
      patch: { executionMode: "manual", dockerActionsEnabled: true, readEnabled: true, ...patch },
      expectedRevision: current!.revision,
    });
  }

  async function yieldToIo(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }

  async function pollUntil(predicate: (task: AiTask) => boolean, taskId: string, maxAttempts = 10000): Promise<AiTask> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const task = await aiRepo.getTask(vpsId, taskId);
      if (task && predicate(task)) return task;
      await yieldToIo();
    }
    throw new Error(`pollUntil exceeded ${maxAttempts} attempts for ${taskId}`);
  }

  function providerResult(content: string, toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []) {
    return {
      message: {
        role: "assistant" as const,
        content,
        toolCalls: toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      },
      usage: { inputTokens: 20, outputTokens: 10, estimated: false },
    };
  }

  async function createLoopTask(idempotencyKey: string, requestText = "Inspect the service") {
    return service.create(request, vpsId, { request: requestText, idempotencyKey });
  }

  it("refuses to promote a legacy executionVersion1 task through resume", async () => {
    const conversation = await aiRepo.createConversation(vpsId, "Legacy resume");
    const { task } = await aiRepo.createTask({
      id: "legacy-resume-task",
      vpsId,
      conversationId: conversation.id,
      state: "awaiting_input",
      requestSummary: "legacy task",
      idempotencyKey: "legacy-resume-key",
      initiatingSessionId: "admin-session",
      executionVersion: 1,
    });

    await expect(service.resume(request, vpsId, task.id)).rejects.toMatchObject({ code: "stale_plan" });
    expect((await aiRepo.getTask(vpsId, task.id))?.executionVersion).toBe(1);
  });

  it("fails closed when policy changes between planning and approval", async () => {
    await setPolicy();
    vi.spyOn(AiProvider.prototype, "generate").mockResolvedValue(providerResult("plan", [{ id: "policy-call", name: "docker_action", arguments: { action: "restart", target: { containerKey: "app-service" } } }]));
    const task = await createLoopTask("policy-change-key", "Restart app-service");
    const pending = await pollUntil((candidate) => candidate.state === "awaiting_approval", task.id);
    await setPolicy({ sendLogsToProvider: true });

    await expect(service.approve(request, vpsId, task.id, { planVersion: pending.plan!.planVersion, planDigest: pending.plan!.planDigest })).rejects.toMatchObject({ code: "policy_denied" });
    expect(bridgeService.execute).not.toHaveBeenCalled();
    expect((await aiRepo.getTask(vpsId, task.id))?.state).toBe("awaiting_approval");
  });

  it("fails closed when the pinned provider changes between planning and approval", async () => {
    await setPolicy();
    vi.spyOn(AiProvider.prototype, "generate").mockResolvedValue(providerResult("plan", [{ id: "provider-call", name: "docker_action", arguments: { action: "restart", target: { containerKey: "app-service" } } }]));
    const task = await createLoopTask("provider-change-key", "Restart app-service");
    const pending = await pollUntil((candidate) => candidate.state === "awaiting_approval", task.id);
    const profile = (await aiRepo.listProviderProfiles())[0]!;
    await aiRepo.updateProviderProfile(profile.id, {
      name: profile.name,
      endpoint: profile.endpoint,
      models: profile.models,
      defaultModel: profile.defaultModel,
      enabled: profile.enabled,
      isDefault: profile.isDefault,
      expectedRevision: profile.revision,
    });

    await expect(service.approve(request, vpsId, task.id, { planVersion: pending.plan!.planVersion, planDigest: pending.plan!.planDigest })).rejects.toMatchObject({ code: "provider_revision_changed" });
    expect(bridgeService.execute).not.toHaveBeenCalled();
    expect((await aiRepo.getTask(vpsId, task.id))?.state).toBe("awaiting_approval");
  });

  it("allows finite changing health polling and stops unchanging polling at the no-progress bound", async () => {
    await setPolicy();
    let calls = 0;
    const finiteObservations = [
      { active: "activating", status: "starting", subState: "start-pre", unit: "app-service" },
      { active: "active", status: "running", subState: "running", unit: "app-service" },
      { active: "active", status: "running", subState: "running", unit: "app-service", generation: 2 },
    ];
    vi.spyOn(readToolsService, "execute").mockImplementation(async () => JSON.stringify(finiteObservations[Math.min(calls - 1, finiteObservations.length - 1)]));
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
      calls += 1;
      if (calls <= 3) return providerResult(`poll ${calls}`, [{ id: `poll-${calls}`, name: "service_status", arguments: { serviceName: "app-service" } }]);
      return providerResult("Polling reached the requested healthy state.");
    });
    const task = await createLoopTask("finite-polling-key", "Poll app-service until healthy");
    const completed = await pollUntil((candidate) => candidate.state === "succeeded", task.id);
    expect(completed.completion?.reasonCode).toBe("query_answered");
    expect(completed.loop?.counters.readCalls).toBe(3);
    expect(completed.loop?.counters.toolCalls).toBe(3);

    vi.restoreAllMocks();
    calls = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
      calls += 1;
      return providerResult("still checking", [{ id: `stuck-${calls}`, name: "service_status", arguments: { serviceName: "app-service" } }]);
    });
    const stuck = await createLoopTask("bounded-polling-key", "Poll app-service forever");
    const bounded = await pollUntil((candidate) => candidate.state === "failed", stuck.id);
    expect(bounded.error?.code).toBe("no_progress");
    expect(bounded.completion?.reasonCode).toBe("no_progress");
    expect(bounded.loop?.counters.noProgressStreak).toBe(3);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("feeds a deterministic read-tool failure observation back to the model", async () => {
    await setPolicy();
    const seen: string[] = [];
    let calls = 0;
    vi.spyOn(readToolsService, "execute").mockRejectedValue(new Error("deterministic service status failure"));
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (_config, messages) => {
      calls += 1;
      if (calls > 1) {
        for (const message of messages) if (message.role === "tool") seen.push(message.content);
        return providerResult("The status check failed deterministically; no mutation was attempted.");
      }
      return providerResult("check", [{ id: "failed-read-call", name: "service_status", arguments: { serviceName: "app-service" } }]);
    });
    const task = await createLoopTask("failed-observation-key", "Check app-service status");
    const completed = await pollUntil((candidate) => candidate.state === "succeeded", task.id);
    expect(completed.completion?.reasonCode).toBe("query_answered");
    expect(seen.some((content) => content.includes('"status":"failed"') && content.includes("deterministic service status failure"))).toBe(true);
  });

  it("rejects an unknown tool without dispatching a mutation", async () => {
    await setPolicy();
    vi.spyOn(AiProvider.prototype, "generate").mockResolvedValue(providerResult("malicious tool", [{ id: "unknown-call", name: "foreign_vps_mutation", arguments: { vpsId: "foreign-vps", action: "restart" } }]));
    const task = await createLoopTask("foreign-tool-key", "Change another VPS");
    const failed = await pollUntil((candidate) => candidate.state === "failed", task.id);
    expect(failed.error?.code).toBe("policy_denied");
    expect(bridgeService.propose).not.toHaveBeenCalled();
    expect(bridgeService.execute).not.toHaveBeenCalled();
  });

  it("does not dispatch an approved plan whose target and VPS are foreign", async () => {
    await setPolicy();
    const conversation = await aiRepo.createConversation(vpsId, "Foreign target");
    const { task } = await aiRepo.createTask({
      id: "foreign-target-task",
      vpsId,
      conversationId: conversation.id,
      state: "planning",
      requestSummary: "foreign target",
      idempotencyKey: "foreign-target-key",
      initiatingSessionId: "admin-session",
      providerId: "loop-security-provider",
      model: "loop-security-model",
      executionVersion: 2,
      loop: { mode: "manual", deadlineAt: new Date(Date.now() + 60_000).toISOString(), pinnedProviderRevision: 1, pinnedPolicyRevision: 1 },
    });
    const foreignPlan: AiPlan = {
      planId: "foreign-plan",
      planVersion: 1,
      taskId: task.id,
      vpsId: "foreign-vps",
      agentInstanceId: "foreign-agent",
      providerId: "loop-security-provider",
      providerRevision: 1,
      policyRevision: 1,
      capabilityRevision: 0,
      execMode: "sandbox",
      steps: [{ stepId: "foreign-step", tool: "docker_action", version: 1, args: { action: "restart", target: { containerKey: "app-service", agentInstanceId: "foreign-agent" } }, resourceKeys: ["foreign-vps:docker:app-service"], inputDigests: {}, description: "foreign", timeoutSeconds: 30 }],
      preconditions: [],
      planDigest: "foreign-plan-digest",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    };
    await aiRepo.updateTask({ id: task.id, expectedRevision: task.revision, state: "awaiting_approval", plan: foreignPlan });
    bridgeService.execute = vi.fn((vps, step, plan, req, before) =>
      AiDockerBridgeService.prototype.execute.call(bridgeService, vps, step, plan, req, before),
    ) as unknown as AiDockerBridgeService["execute"];
    const result = await service.approve(request, vpsId, task.id, { planVersion: 1, planDigest: foreignPlan.planDigest });
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe("policy_denied");
    expect(bridgeService.execute).toHaveBeenCalledTimes(1);
    expect((await aiRepo.getTask(vpsId, task.id))?.state).toBe("failed");
  });
});
