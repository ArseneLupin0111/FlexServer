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
import { AiProvider, type ProviderResult } from "../src/ai/ai-provider.js";
import type { AiTask } from "../src/ai/ai.models.js";
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
import { AiAssistantError } from "../src/ai/ai-failures.js";

const request = { dashboardSessionId: "admin-session" } as Request;

describe("manual read plan approval regression", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-read-approval-"));
  }, 20_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  async function setup() {
    const keyring = createTestKeyring("kek_read_approval");
    await saveKeyringToFile(join(dir, "keyring.json"), keyring);
    const repository = createJsonAiRepository(join(dir, "ai.json"));
    const vps = createVpsStore(join(dir, "vps.json"));
    const server = await vps.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    await repository.updateSettings({
      patch: { endpoint: "https://provider.example.test/v1", model: "test-model" },
      apiKeyEnvelope: encryptAiSecret("sk-test-context", AI_PROVIDER_KEY_CONTEXT, keyring),
      expectedRevision: 0,
    });
    const config = {
      ...parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "read-approval-secret-0123456789abcdef" }),
      ai: {
        enabled: true,
        keyringFile: join(dir, "keyring.json"),
        contextWindowTokens: 16000,
        contextWindowTokensByModel: {},
        contextReserveTokens: 1000,
        contextTailTokens: 1000,
        maxCumulativeTaskTokens: 1000000,
      },
    };

    let dockerCalls = 0;
    const docker = {
      currentContainers: async () => {
        dockerCalls++;
        return [
          {
            agentInstanceId: "inst-1",
            containerKey: "app",
            name: "web-app",
            image: "nginx:latest",
            state: "running",
            status: "Up 2 hours",
            collectedAt: new Date().toISOString(),
          },
        ];
      },
    } as unknown as DockerMonitoringService;

    const readTools = {
      isReadTool: (name: string) => name === "container_inspect" || name === "service_status",
      execute: vi.fn(async () => JSON.stringify({ inspect: "ok" })),
    } as unknown as AiReadToolsService;

    const service = new AiTaskService(
      repository,
      config,
      new AiPolicyService(config, repository),
      {} as MetricService,
      { authenticateById: async () => ({ sessionId: "admin-session" }) } as unknown as DashboardSessionService,
      docker,
      {} as AiHostPlanService,
      {} as AiDockerBridgeService,
      {} as DockerMonitoringRepository,
      readTools,
      vps,
    );

    async function pollTask(predicate: (t: AiTask) => boolean, taskId: string, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const t = await repository.getTask(server.id, taskId);
        if (t && predicate(t)) return t;
        await new Promise((r) => setTimeout(r, 20));
      }
      const t = await repository.getTask(server.id, taskId);
      throw new Error(`pollTask timed out; current state: ${t?.state}, plan: ${JSON.stringify(t?.plan)}`);
    }

    return { repository, service, server, docker, readTools, pollTask, getDockerCalls: () => dockerCalls };
  }

  it("manual mode blocks read tool behind awaiting_approval, executes once on approve, rejects stale/wrong", async () => {
    const { repository, service, server, pollTask, getDockerCalls } = await setup();

    let turns = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (): Promise<ProviderResult> => {
      turns++;
      if (turns === 1) {
        return {
          message: {
            role: "assistant",
            content: "Checking docker inventory",
            toolCalls: [
              {
                id: "call-inventory-1",
                type: "function",
                function: { name: "docker_inventory", arguments: "{}" },
              },
            ],
          },
          usage: { inputTokens: 50, outputTokens: 20, estimated: false },
        };
      }
      return {
        message: {
          role: "assistant",
          content: "Containers are running normally.",
          toolCalls: [],
        },
        usage: { inputTokens: 40, outputTokens: 15, estimated: false },
      };
    });

    const task = await service.create(request, server.id, {
      request: "List all containers",
      idempotencyKey: "manual-inventory-test",
    });

    // 1. Must block before approval
    const awaiting = await pollTask((t) => t.state === "awaiting_approval", task.id);
    expect(awaiting.plan).toBeDefined();
    expect(awaiting.plan?.steps[0].tool).toBe("docker_inventory");
    expect(getDockerCalls()).toBe(0); // Not executed yet!

    // 2. Reject wrong planDigest
    await expect(
      service.approve(request, server.id, task.id, {
        planVersion: awaiting.plan!.planVersion,
        planDigest: "wrong-digest-0000",
      }),
    ).rejects.toThrow(AiAssistantError);

    // 3. Reject wrong planVersion
    await expect(
      service.approve(request, server.id, task.id, {
        planVersion: awaiting.plan!.planVersion + 999,
        planDigest: awaiting.plan!.planDigest,
      }),
    ).rejects.toThrow(AiAssistantError);

    // 4. Safe resume while awaiting_approval does not execute prematurely
    const resumedStillAwaiting = await service.resume(request, server.id, task.id);
    expect(resumedStillAwaiting.state).toBe("awaiting_approval");
    expect(getDockerCalls()).toBe(0);

    // 5. Explicit approve executes the read
    const approved = await service.approve(request, server.id, task.id, {
      planVersion: awaiting.plan!.planVersion,
      planDigest: awaiting.plan!.planDigest,
    });
    expect(getDockerCalls()).toBe(1);

    // 6. Duplicate approval replay rejected
    await expect(
      service.approve(request, server.id, task.id, {
        planVersion: awaiting.plan!.planVersion,
        planDigest: awaiting.plan!.planDigest,
      }),
    ).rejects.toThrow(AiAssistantError);
    expect(getDockerCalls()).toBe(1); // Still 1! No execution twice!

    // 7. Loop completes after reading
    const completed = await pollTask((t) => t.state === "succeeded", task.id);
    expect(completed.completion?.kind).toBe("verified");
    expect(completed.completion?.reasonCode).toBe("query_answered");
    expect(completed.loop?.counters.readCalls).toBe(1);
    expect(completed.loop?.counters.mutationPlans).toBe(0);
  });

  it("yolo mode auto-reads inline without awaiting_approval", async () => {
    const { repository, service, server, pollTask, getDockerCalls } = await setup();
    await repository.updateAiPolicy({
      vpsId: server.id,
      expectedRevision: 0,
      patch: { executionMode: "yolo", yoloAcknowledgedAt: new Date().toISOString() },
    });

    let turns = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async (): Promise<ProviderResult> => {
      turns++;
      if (turns === 1) {
        return {
          message: {
            role: "assistant",
            content: "Checking docker inventory",
            toolCalls: [
              {
                id: "call-inventory-yolo",
                type: "function",
                function: { name: "docker_inventory", arguments: "{}" },
              },
            ],
          },
          usage: { inputTokens: 50, outputTokens: 20, estimated: false },
        };
      }
      return {
        message: {
          role: "assistant",
          content: "Done list",
          toolCalls: [],
        },
        usage: { inputTokens: 40, outputTokens: 15, estimated: false },
      };
    });

    const task = await service.create(request, server.id, {
      request: "List all containers in YOLO",
      idempotencyKey: "yolo-inventory-test",
    });

    // Proceeds to succeeded without awaiting_approval
    const completed = await pollTask((t) => t.state === "succeeded", task.id);
    expect(completed.completion?.kind).toBe("verified");
    expect(getDockerCalls()).toBe(1);
    expect(completed.loop?.counters.readCalls).toBe(1);
  });
});
