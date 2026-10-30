import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiAgentService } from "../src/ai/ai-agent.service.js";
import { AiHostPlanService } from "../src/ai/ai-host-plan.service.js";
import { AiProvider } from "../src/ai/ai-provider.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { MetricService } from "../src/metrics/metric.service.js";
import type { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import type { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { AiReadToolsService } from "../src/ai/ai-read-tools.service.js";
import { encryptAiSecret } from "../src/ai/ai-crypto.js";
import { AI_PROVIDER_KEY_CONTEXT } from "../src/ai/ai-routes.service.js";
import { createTestKeyring, saveKeyringToFile, type Keyring } from "../src/ssh/key-encryption.js";
import type { AiCapability, AiPolicy, AiTask } from "../src/ai/ai.models.js";
import { readJsonFile, writeJsonFile } from "../src/persistence/repositories/json-file.js";

// Slice 1 (docs/ai-agent-autoupdate-execmode-plan.md): pre-dispatch shell
// branch, plan execMode stamping and the approve-time stale_plan mode guard.
// The provider call is stubbed via an AiProvider.prototype spy; the run is
// fire-and-forget, so each test polls the task to the target state.

const request = { dashboardSessionId: "admin-session" } as unknown as Request;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const rootfsDigest = "a".repeat(64);
const profilesDigest = "b".repeat(64);

describe("AI shell execMode dispatch", () => {
  let dir: string;
  let keyring: Keyring;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let config: AppConfig;
  let activeInstanceId: string | undefined;
  let service: AiTaskService;
  let idempotencyCounter: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-execmode-dispatch-"));
    keyring = createTestKeyring("kek_execmode_dispatch");
    const keyringFile = join(dir, "ai-keyring.json");
    await saveKeyringToFile(keyringFile, keyring);
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    const created = await vpsRepo.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    const parsed = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "ai-execmode-dispatch-test-secret" });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true, keyringFile } };
    await aiRepo.updateSettings({
      patch: { endpoint: "https://provider.example.test/v1", model: "test-model" },
      apiKeyEnvelope: encryptAiSecret("sk-execmode-fixture", AI_PROVIDER_KEY_CONTEXT, keyring),
      expectedRevision: 0,
    });
    activeInstanceId = "agent-inst-1";
    service = makeService();
    idempotencyCounter = 0;
  });

  afterEach(async () => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        if (attempt === 4) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  function makeService(): AiTaskService {
    const sessions = {
      authenticateById: async () => ({ sessionId: "admin-session" }),
    } as unknown as DashboardSessionService;
    const monitoring = {
      getAuthoritativeLatest: async () => (activeInstanceId ? { activeInstanceId } : undefined),
    } as unknown as DockerMonitoringRepository;
    return new AiTaskService(
      aiRepo,
      config,
      new AiPolicyService(config, aiRepo),
      {} as unknown as MetricService,
      sessions,
      {} as unknown as DockerMonitoringService,
      new AiHostPlanService(aiRepo, config),
      {} as unknown as AiDockerBridgeService,
      monitoring,
      {} as unknown as AiReadToolsService,
      vpsRepo,
    );
  }

  async function seedPolicy(overrides: Partial<AiPolicy> = { execMode: "sandbox" }): Promise<AiPolicy> {
    const current = await aiRepo.getAiPolicy(vpsId);
    return aiRepo.updateAiPolicy({
      vpsId,
      patch: { shellEnabled: true, ...overrides },
      expectedRevision: current!.revision,
    });
  }

  async function seedCapability(overrides: Partial<AiCapability> = {}): Promise<void> {
    const capability: AiCapability = {
      vpsId,
      supported: true,
      freshness: new Date().toISOString(),
      protocolVersion: 1,
      cgroupV2Available: true,
      namespacesAvailable: true,
      seccompAvailable: true,
      privilegedSupported: false,
      profiles: [],
      rootfsDigest,
      profilesDigest,
      ...overrides,
    };
    await aiRepo.recordAiCapability(capability);
  }

  /** Drives one run round whose provider response proposes a host_shell step. */
  async function proposeShellPlan(shellArgs: Record<string, unknown>): Promise<AiTask> {
    idempotencyCounter += 1;
    vi.spyOn(AiProvider.prototype, "generate").mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "host_shell", arguments: JSON.stringify({ script: "echo hi", timeoutSeconds: 30, ...shellArgs }) } }],
      },
      usage: { inputTokens: 10, outputTokens: 5, estimated: true },
    });
    const created = await service.create(request, vpsId, { request: "Chạy diagnostic shell", idempotencyKey: `execmode-${idempotencyCounter}` });
    const deadline = Date.now() + 4000;
    for (;;) {
      const task = await aiRepo.getTask(vpsId, created.id);
      if (task && (task.state === "awaiting_approval" || TERMINAL.has(task.state))) return task;
      if (Date.now() > deadline) throw new Error(`AI task never reached a plan state (last: ${task?.state ?? "none"})`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function agentService(): AiAgentService {
    const sessions = {
      authenticateById: async () => ({ sessionId: "admin-session" }),
    } as unknown as DashboardSessionService;
    const monitoring = {
      getAuthoritativeLatest: async () => (activeInstanceId ? { activeInstanceId } : undefined),
    } as unknown as DockerMonitoringRepository;
    return new AiAgentService(aiRepo, config, sessions, monitoring, new AiPolicyService(config, aiRepo));
  }

  it("keeps the sandbox path unchanged: fresh + supported + activeInstanceId proposes a sandbox plan", async () => {
    await seedPolicy({ execMode: "sandbox" });
    await seedCapability({ supported: true });
    const task = await proposeShellPlan({ execMode: "sandbox" });
    expect(task.state).toBe("awaiting_approval");
    expect(task.error).toBeUndefined();
    expect(task.plan!.execMode).toBe("sandbox");
    expect(task.plan!.steps[0]!.args.execMode).toBe("sandbox");

    const approved = await service.approve(request, vpsId, task.id, { planVersion: 1, planDigest: task.plan!.planDigest });
    expect(approved.state).toBe("executing");

    // The claim-delivered shell payload carries the sandbox execMode.
    const command = await agentService().claim(vpsId, { version: 1, agentInstanceId: "agent-inst-1" });
    expect(command?.kind).toBe("shell");
    expect((command!.payload as Record<string, unknown>).execMode).toBe("sandbox");
  });

  it("sandbox still fails sandbox_unavailable when the capability is not supported", async () => {
    await seedPolicy({ execMode: "sandbox" });
    await seedCapability({ supported: false, privilegedSupported: true });
    const task = await proposeShellPlan({ execMode: "sandbox" });
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("sandbox_unavailable");
  });

  it("privileged path succeeds without sandbox support and stamps plan + payload execMode", async () => {
    await seedPolicy({ execMode: "privileged", privilegedAcknowledgedAt: new Date().toISOString(), privilegedAcknowledgedBy: "admin-session" });
    await seedCapability({ supported: false, privilegedSupported: true });
    const task = await proposeShellPlan({ execMode: "privileged" });
    expect(task.state).toBe("awaiting_approval");
    expect(task.error).toBeUndefined();
    expect(task.plan!.execMode).toBe("privileged");
    expect(task.plan!.steps[0]!.args.execMode).toBe("privileged");

    const approved = await service.approve(request, vpsId, task.id, { planVersion: 1, planDigest: task.plan!.planDigest });
    expect(approved.state).toBe("executing");

    const command = await agentService().claim(vpsId, { version: 1, agentInstanceId: "agent-inst-1" });
    expect(command?.kind).toBe("shell");
    expect((command!.payload as Record<string, unknown>).execMode).toBe("privileged");
  });

  it("privileged path also accepts a model that omits execMode (policy decides)", async () => {
    await seedPolicy({ execMode: "privileged", privilegedAcknowledgedAt: new Date().toISOString(), privilegedAcknowledgedBy: "admin-session" });
    await seedCapability({ supported: false, privilegedSupported: true });
    const task = await proposeShellPlan({});
    expect(task.state).toBe("awaiting_approval");
    expect(task.plan!.execMode).toBe("privileged");
    expect(task.plan!.steps[0]!.args.execMode).toBe("privileged");
  });

  it("privileged path fails sandbox_unavailable when privilegedSupported is false", async () => {
    await seedPolicy({ execMode: "privileged", privilegedAcknowledgedAt: new Date().toISOString(), privilegedAcknowledgedBy: "admin-session" });
    await seedCapability({ supported: true, privilegedSupported: false });
    const task = await proposeShellPlan({ execMode: "privileged" });
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("sandbox_unavailable");
  });

  it("both paths fail sandbox_unavailable without an active agent instance", async () => {
    activeInstanceId = undefined;
    await seedPolicy({ execMode: "sandbox" });
    await seedCapability({ supported: true });
    const sandboxTask = await proposeShellPlan({ execMode: "sandbox" });
    expect(sandboxTask.state).toBe("failed");
    expect(sandboxTask.error?.code).toBe("sandbox_unavailable");

    await seedPolicy({ execMode: "privileged", privilegedAcknowledgedAt: new Date().toISOString(), privilegedAcknowledgedBy: "admin-session" });
    await seedCapability({ supported: false, privilegedSupported: true });
    const privilegedTask = await proposeShellPlan({ execMode: "privileged" });
    expect(privilegedTask.state).toBe("failed");
    expect(privilegedTask.error?.code).toBe("sandbox_unavailable");
  });

  it("rejects a model-supplied execMode that contradicts the policy with policy_denied", async () => {
    await seedPolicy({ execMode: "sandbox" });
    await seedCapability({ supported: true, privilegedSupported: true });
    const escalations = await proposeShellPlan({ execMode: "privileged" });
    expect(escalations.state).toBe("failed");
    expect(escalations.error?.code).toBe("policy_denied");

    await seedPolicy({ execMode: "privileged", privilegedAcknowledgedAt: new Date().toISOString(), privilegedAcknowledgedBy: "admin-session" });
    await seedCapability({ supported: false, privilegedSupported: true });
    const downgrades = await proposeShellPlan({ execMode: "sandbox" });
    expect(downgrades.state).toBe("failed");
    expect(downgrades.error?.code).toBe("policy_denied");
  });

  it("approve throws stale_plan when the policy execMode no longer matches the plan", async () => {
    await seedPolicy({ execMode: "privileged", privilegedAcknowledgedAt: new Date().toISOString(), privilegedAcknowledgedBy: "admin-session" });
    await seedCapability({ supported: true, privilegedSupported: true });
    const task = await proposeShellPlan({ execMode: "privileged" });
    expect(task.state).toBe("awaiting_approval");

    // Change policy in persistence to sandbox while preserving policyRevision,
    // so revalidateForDispatch passes and only the mode guard triggers stale_plan.
    const aiFile = join(dir, "ai.json");
    const raw = await readJsonFile<{ policies: AiPolicy[] }>(aiFile, { policies: [] });
    const pol = raw.policies.find((p) => p.vpsId === vpsId);
    if (pol) {
      pol.execMode = "sandbox";
      await writeJsonFile(aiFile, raw);
    }

    await expect(
      service.approve(request, vpsId, task.id, { planVersion: 1, planDigest: task.plan!.planDigest }),
    ).rejects.toMatchObject({ code: "stale_plan" });
  });
});
