import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import {
  createJsonAiRepository,
  aiProviderKeyAad,
} from "../src/persistence/repositories/ai.repository.js";
import {
  AiPersistenceConflictError,
  type AiRepository,
} from "../src/persistence/repositories/ai.persistence.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiProvider } from "../src/ai/ai-provider.js";
import { encryptAiSecret } from "../src/ai/ai-crypto.js";
import { AI_PROVIDER_KEY_CONTEXT } from "../src/ai/ai-routes.service.js";
import {
  createTestKeyring,
  saveKeyringToFile,
  type Keyring,
} from "../src/ssh/key-encryption.js";
import { AiAssistantError } from "../src/ai/ai-failures.js";
import type {
  AiExecutionMode,
  AiPlanStepProposal,
  AiPolicy,
  AiTask,
} from "../src/ai/ai.models.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { MetricService } from "../src/metrics/metric.service.js";
import type { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import type { AiHostPlanService } from "../src/ai/ai-host-plan.service.js";
import type { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import type { AiReadToolsService } from "../src/ai/ai-read-tools.service.js";

const request = { dashboardSessionId: "admin-session" } as unknown as Request;

describe("AI Agent Multi-Turn Execution Loop (ai-agent-loop)", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let config: AppConfig;
  let service: AiTaskService;
  let bridgeService: AiDockerBridgeService;
  let readToolsService: AiReadToolsService;
  let monitoringRepo: DockerMonitoringRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-loop-tests-"));
    const keyring: Keyring = createTestKeyring("kek_loop_tests");
    const keyringFile = join(dir, "ai-keyring.json");
    await saveKeyringToFile(keyringFile, keyring);

    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    const server = await vpsRepo.create({
      name: "Loop-VPS",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      dockerManagementEnabled: true,
    });
    vpsId = server.id;

    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-loop-test-secret-at-least-32-chars-long",
    });
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

    const profileId = "loop-test-provider";
    await aiRepo.createProviderProfile({
      id: profileId,
      name: "Loop Test Provider",
      endpoint: "https://provider.example.test/v1",
      models: ["loop-test-model"],
      defaultModel: "loop-test-model",
      enabled: true,
      isDefault: true,
      apiKeyEnvelope: encryptAiSecret(
        "sk-loop-fixture",
        aiProviderKeyAad(profileId),
        keyring,
      ),
    });

    bridgeService = {
      propose: vi.fn(
        async (_task, tool, rawArgs): Promise<AiPlanStepProposal> => ({
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
        }),
      ),
      execute: vi.fn(async () => ({
        ok: true,
        result: { message: "Docker bridge mutation applied successfully" },
      })),
    } as unknown as AiDockerBridgeService;

    readToolsService = {
      isReadTool: vi.fn(
        (name: string) =>
          name === "service_status" ||
          name === "host_service_status" ||
          name === "docker_inspect" ||
          name === "read_file",
      ),
      execute: vi.fn(async () =>
        JSON.stringify({
          active: "active",
          status: "running",
          subState: "running",
          unit: "app-service",
        }),
      ),
    } as unknown as AiReadToolsService;

    monitoringRepo = {
      getAuthoritativeLatest: vi.fn(async () => ({
        activeInstanceId: "agent-inst-1",
      })),
      currentContainers: vi.fn(async () => []),
    } as unknown as DockerMonitoringRepository;

    const sessions = {
      authenticateById: async (sessionId: string) =>
        sessionId === "admin-session" ? { sessionId } : null,
    } as unknown as DashboardSessionService;

    const metricService = {
      list: vi.fn(async () => []),
    } as unknown as MetricService;

    const dockerService = {} as unknown as DockerMonitoringService;
    const hostPlanService = {} as unknown as AiHostPlanService;

    service = new AiTaskService(
      aiRepo,
      config,
      new AiPolicyService(config, aiRepo),
      metricService,
      sessions,
      dockerService,
      hostPlanService,
      bridgeService,
      monitoringRepo,
      readToolsService,
      vpsRepo,
    );
  });

  afterEach(async () => {
    service?.onModuleDestroy();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function setPolicy(
    mode: AiExecutionMode,
    patch: Partial<AiPolicy> = {},
  ): Promise<AiPolicy> {
    const current = await aiRepo.getAiPolicy(vpsId);
    return aiRepo.updateAiPolicy({
      vpsId,
      patch: {
        executionMode: mode,
        dockerActionsEnabled: true,
        readEnabled: true,
        ...(mode === "yolo"
          ? { yoloAcknowledgedAt: new Date().toISOString() }
          : {}),
        ...patch,
      },
      expectedRevision: current!.revision,
    });
  }

  function pollDelay(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }

  async function pollUntil(
    predicate: (task: AiTask) => boolean,
    taskId: string,
    timeoutMs = 6000,
  ): Promise<AiTask> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = await aiRepo.getTask(vpsId, taskId);
      if (task && predicate(task)) return task;
      if (task && (task.state === "failed" || task.state === "cancelled")) {
        console.error("Task ended prematurely in error state:", task.state, task.error, task.completion);
        return task;
      }
      await pollDelay(20);
    }
    const finalTask = await aiRepo.getTask(vpsId, taskId);
    console.error("Poll timeout finalTask:", finalTask?.state, finalTask?.error, finalTask?.completion);
    throw new Error(
      `pollUntil timed out (last state: ${finalTask?.state}, revision: ${finalTask?.revision})`,
    );
  }

  // 1. Same-task 2 manual plans: exact approvals required, stale replayed approvals rejected
  it("same-task 2 manual plans: requires exact approval per plan and rejects stale replay", async () => {
    await setPolicy("manual");

    let callCount = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          message: {
            role: "assistant",
            content: "Proposing plan 1",
            toolCalls: [
              {
                id: "call-plan-1",
                type: "function",
                function: {
                  name: "docker_action",
                  arguments: JSON.stringify({
                    action: "stop",
                    target: { containerKey: "app-service" },
                  }),
                },
              },
            ],
          },
          usage: { inputTokens: 40, outputTokens: 20, estimated: false },
        };
      }
      if (callCount === 2) {
        return {
          message: {
            role: "assistant",
            content: "Proposing plan 2",
            toolCalls: [
              {
                id: "call-plan-2",
                type: "function",
                function: {
                  name: "docker_action",
                  arguments: JSON.stringify({
                    action: "start",
                    target: { containerKey: "app-service" },
                  }),
                },
              },
            ],
          },
          usage: { inputTokens: 40, outputTokens: 20, estimated: false },
        };
      }
      return {
        message: {
          role: "assistant",
          content: "Manual multi-plan task completed successfully.",
          toolCalls: [],
        },
        usage: { inputTokens: 30, outputTokens: 15, estimated: false },
      };
    });

    const task = await service.create(request, vpsId, {
      request: "Perform two-step manual container maintenance",
      idempotencyKey: "manual-2plans-test",
    });

    // Plan 1 proposed
    const plan1Task = await pollUntil(
      (t) => t.state === "awaiting_approval",
      task.id,
    );
    expect(plan1Task.plan).toBeDefined();
    expect(plan1Task.plan?.planVersion).toBe(1);
    const plan1Digest = plan1Task.plan!.planDigest;

    // Stale/invalid approval rejected
    await expect(
      service.approve(request, vpsId, task.id, {
        planVersion: 1,
        planDigest: "sha256:fake_or_stale_digest_123456",
      }),
    ).rejects.toThrow();

    // Exact approval of Plan 1 succeeds
    await service.approve(request, vpsId, task.id, {
      planVersion: 1,
      planDigest: plan1Digest,
    });
    // Plan 2 proposed in the same task
    const plan2Task = await pollUntil(
      (t) => t.state === "awaiting_approval" && t.plan?.planVersion === 2,
      task.id,
    );
    expect(plan2Task.state).toBe("awaiting_approval");
    expect(plan2Task.plan?.planVersion).toBe(2);
    const plan2Digest = plan2Task.plan!.planDigest;
    expect(plan2Digest).not.toBe(plan1Digest);

    // Replay of Plan 1's digest against active Plan 2 is rejected
    await expect(
      service.approve(request, vpsId, task.id, {
        planVersion: 1,
        planDigest: plan1Digest,
      }),
    ).rejects.toThrow();

    await expect(
      service.approve(request, vpsId, task.id, {
        planVersion: 2,
        planDigest: plan1Digest,
      }),
    ).rejects.toThrow();

    // Exact approval of Plan 2 succeeds
    await service.approve(request, vpsId, task.id, {
      planVersion: 2,
      planDigest: plan2Digest,
    });

    // Same task completes with both plans in planHistory
    const completed = await pollUntil(
      (t) => t.state === "succeeded",
      task.id,
    );
    expect(completed.loop?.planHistory).toHaveLength(2);
    expect(completed.loop?.planHistory[0].planVersion).toBe(1);
    expect(completed.loop?.planHistory[1].planVersion).toBe(2);
    expect(completed.loop?.planHistory[0].status).toBe("consumed");
    expect(completed.loop?.planHistory[1].status).toBe("consumed");
    expect(completed.loop?.counters.mutationPlans).toBe(2);
  });

  // 2. YOLO mode: autonomous multi-mutation plan progression without manual approval
  it("YOLO mode: automatically approves and chains sequential mutation plans", async () => {
    await setPolicy("yolo");

    let callCount = 0;
    vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          message: {
            role: "assistant",
            content: "YOLO plan 1",
            toolCalls: [
              {
                id: "yolo-call-1",
                type: "function",
                function: {
                  name: "docker_action",
                  arguments: JSON.stringify({
                    action: "stop",
                    target: { containerKey: "app-service" },
                  }),
                },
              },
            ],
          },
          usage: { inputTokens: 40, outputTokens: 20, estimated: false },
        };
      }
      if (callCount === 2) {
        return {
          message: {
            role: "assistant",
            content: "YOLO plan 2",
            toolCalls: [
              {
                id: "yolo-call-2",
                type: "function",
                function: {
                  name: "docker_action",
                  arguments: JSON.stringify({
                    action: "start",
                    target: { containerKey: "app-service" },
                  }),
                },
              },
            ],
          },
          usage: { inputTokens: 40, outputTokens: 20, estimated: false },
        };
      }
      if (callCount === 3) {
        return {
          message: {
            role: "assistant",
            content: "Verifying container health",
            toolCalls: [
              {
                id: "yolo-call-3",
                type: "function",
                function: {
                  name: "service_status",
                  arguments: JSON.stringify({ unit: "app-service" }),
                },
              },
            ],
          },
          usage: { inputTokens: 30, outputTokens: 15, estimated: false },
        };
      }
      return {
        message: {
          role: "assistant",
          content: "YOLO autonomous loop finished with verified outcome.",
          toolCalls: [],
        },
        usage: { inputTokens: 20, outputTokens: 10, estimated: false },
      };
    });

    const task = await service.create(request, vpsId, {
      request: "Autonomous full maintenance in YOLO mode",
      idempotencyKey: "yolo-2plans-test",
    });

    // Task proceeds end-to-end without any manual service.approve calls
    const completed = await pollUntil(
      (t) => t.state === "succeeded",
      task.id,
      8000,
    );

    expect(completed.loop?.planHistory).toHaveLength(2);
    expect(completed.loop?.planHistory[0].status).toBe("consumed");
    expect(completed.loop?.planHistory[1].status).toBe("consumed");
    expect(completed.loop?.counters.mutationPlans).toBe(2);
    expect(completed.completion?.kind).toBe("verified");
  });

  // 3. Verify-on-stop: command exit 0 without postcheck yields unverified; unhealthy probe must not be verified
  describe("verify-on-stop: postcondition verification vs unverified", () => {
    it("mutation exit 0 without postcheck read tool yields unverified outcome", async () => {
      await setPolicy("yolo");

      let callCount = 0;
      vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Restarting app-service",
              toolCalls: [
                {
                  id: "m-call-1",
                  type: "function",
                  function: {
                    name: "docker_action",
                    arguments: JSON.stringify({
                      action: "restart",
                      target: { containerKey: "app-service" },
                    }),
                  },
                },
              ],
            },
            usage: { inputTokens: 40, outputTokens: 20, estimated: false },
          };
        }
        // No postcheck read tool performed; immediately provides final prose
        return {
          message: {
            role: "assistant",
            content: "Restart executed without postcheck probe.",
            toolCalls: [],
          },
          usage: { inputTokens: 30, outputTokens: 15, estimated: false },
        };
      });

      const task = await service.create(request, vpsId, {
        request: "Restart container without postcheck",
        idempotencyKey: "verify-stop-nopostcheck",
      });

      const settled = await pollUntil(
        (t) => t.state === "succeeded" || t.state === "failed",
        task.id,
      );

      // Mutation succeeded but lacks postcheck verification -> unverified
      expect(settled.completion?.kind).toBe("unverified");
      expect(settled.completion?.reasonCode).toBe("unverified_completion");
    });

    it("postcheck reporting unhealthy or unrelated read must not be marked verified", async () => {
      await setPolicy("yolo");

      // Configure readToolsService to return an unhealthy service status
      vi.spyOn(readToolsService, "execute").mockResolvedValueOnce(
        JSON.stringify({
          active: "failed",
          status: "dead",
          subState: "failed",
          unit: "app-service",
        }),
      );

      let callCount = 0;
      vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Restarting app-service",
              toolCalls: [
                {
                  id: "m-call-unhealthy-1",
                  type: "function",
                  function: {
                    name: "docker_action",
                    arguments: JSON.stringify({
                      action: "restart",
                      target: { containerKey: "app-service" },
                    }),
                  },
                },
              ],
            },
            usage: { inputTokens: 40, outputTokens: 20, estimated: false },
          };
        }
        if (callCount === 2) {
          return {
            message: {
              role: "assistant",
              content: "Checking status",
              toolCalls: [
                {
                  id: "probe-call-1",
                  type: "function",
                  function: {
                    name: "service_status",
                    arguments: JSON.stringify({ unit: "app-service" }),
                  },
                },
              ],
            },
            usage: { inputTokens: 30, outputTokens: 15, estimated: false },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "Checked service status after restart.",
            toolCalls: [],
          },
          usage: { inputTokens: 20, outputTokens: 10, estimated: false },
        };
      });

      const task = await service.create(request, vpsId, {
        request: "Restart container and check health",
        idempotencyKey: "verify-stop-unhealthy",
      });

      const settled = await pollUntil(
        (t) => t.state === "succeeded" || t.state === "failed",
        task.id,
      );

      // Successful read transport reporting unhealthy status must not yield verified
      expect(settled.completion?.kind).not.toBe("verified");
      expect(settled.completion?.kind).toBe("unverified");
    });
  });

  it("startup sweep resumes a persisted continuation once", async () => {
    await setPolicy("manual");
    const conversation = await aiRepo.createConversation(vpsId, "Restart continuation");
    const admitted = await aiRepo.createTask({
      id: randomUUID(),
      vpsId,
      conversationId: conversation.id,
      state: "planning",
      requestSummary: "Resume after restart",
      initiatingSessionId: "admin-session",
      providerId: "loop-test-provider",
      model: "loop-test-model",
      executionVersion: 2,
      executionMode: "manual",
      loop: {
        mode: "manual",
        continuationReady: true,
        counters: { providerCalls: 0, readCalls: 0, mutationPlans: 0, verificationAttempts: 0, toolCalls: 0 },
      },
    });
    await aiRepo.appendMessage({
      id: randomUUID(),
      vpsId,
      conversationId: conversation.id,
      taskId: admitted.task.id,
      role: "user",
      content: "Continue the persisted task",
    });
    const generate = vi.spyOn(AiProvider.prototype, "generate").mockResolvedValue({
      message: { role: "assistant", content: "Restarted task completed.", toolCalls: [] },
      usage: { inputTokens: 10, outputTokens: 5, estimated: false },
    });

    const service2 = new AiTaskService(
      aiRepo,
      config,
      new AiPolicyService(config, aiRepo),
      { list: async () => [] } as unknown as MetricService,
      { authenticateById: async (sessionId: string) => sessionId === "admin-session" ? { sessionId } : null } as unknown as DashboardSessionService,
      {} as unknown as DockerMonitoringService,
      {} as unknown as AiHostPlanService,
      bridgeService,
      monitoringRepo,
      readToolsService,
      vpsRepo,
    );
    await Promise.all([service.onModuleInit(), service2.onModuleInit()]);
    const settled = await pollUntil((task) => task.state === "succeeded" || task.state === "failed", admitted.task.id);
    expect(settled.state).toBe("succeeded");
    expect(generate).toHaveBeenCalledTimes(1);
    service2.onModuleDestroy();
    service.onModuleDestroy();
  });

  describe("lease concurrency and cancellation fencing", () => {
    it("leased late worker cannot commit turn decisions after losing lease", async () => {
      const fencingServer = await vpsRepo.create({
        name: "Fencing VPS",
        host: "127.0.0.1",
        port: 22,
        username: "root",
      });
      const fencingVpsId = fencingServer.id;
      const fencingConv = await aiRepo.createConversation(
        fencingVpsId,
        "Fencing Conversation",
      );

      // Create a fresh task in planning state to test turn lease conflict
      const admitted = await aiRepo.createTask({
        id: randomUUID(),
        vpsId: fencingVpsId,
        conversationId: fencingConv.id,
        state: "planning",
        requestSummary: "Direct planning task for lease test",
        initiatingSessionId: "admin-session",
        executionVersion: 2,
        executionMode: "manual",
        loop: {
          mode: "manual",
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          counters: {
            providerCalls: 0,
            readCalls: 0,
            mutationPlans: 0,
            verificationAttempts: 0,
            toolCalls: 0,
          },
        },
      });

      const t0 = "2026-10-30T10:00:00.000Z";
      const tPastExpiry = "2026-10-30T10:00:15.000Z";

      // Worker 1 claims turn with 10 second lease at t0
      const worker1Claim = await aiRepo.claimTurn({
        taskId: admitted.task.id,
        vpsId: fencingVpsId,
        ownerInstanceId: "worker-1",
        leaseSeconds: 10,
        now: t0,
      });
      const staleLeaseToken = worker1Claim.loop!.leaseToken!;
      const staleRevision = worker1Claim.revision;

      // At tPastExpiry, Worker 2 claims expired turn
      const worker2Claim = await aiRepo.claimTurn({
        taskId: admitted.task.id,
        vpsId: fencingVpsId,
        ownerInstanceId: "worker-2",
        leaseSeconds: 60,
        now: tPastExpiry,
      });
      expect(worker2Claim.loop?.leaseToken).not.toBe(staleLeaseToken);

      // Late Worker 1 attempting commit past expiry must be rejected with AiPersistenceConflictError
      await expect(
        aiRepo.releaseOrCommitTurn({
          taskId: admitted.task.id,
          vpsId: fencingVpsId,
          expectedRevision: staleRevision,
          expectedLeaseToken: staleLeaseToken,
          ownerInstanceId: "worker-1",
          state: "succeeded",
          now: tPastExpiry,
        }),
      ).rejects.toThrow(AiPersistenceConflictError);
    });

    it("cancelled task fences continuation: no continuation is ready or claimable", async () => {
      await setPolicy("manual");

      // Provider pauses on clarification prompt
      vi.spyOn(AiProvider.prototype, "generate").mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "clarify-call-1",
              type: "function",
              function: {
                name: "request_clarification",
                arguments: JSON.stringify({ question: "Need details" }),
              },
            },
          ],
        },
        usage: { inputTokens: 20, outputTokens: 10, estimated: false },
      });

      const task = await service.create(request, vpsId, {
        request: "Request needing clarification",
        idempotencyKey: "cancel-fence-test",
      });

      await pollUntil((t) => t.state === "awaiting_input", task.id);

      // Cancel the task
      await service.cancel(request, vpsId, task.id);
      const cancelledTask = await aiRepo.getTask(vpsId, task.id);
      expect(cancelledTask?.state).toBe("cancelled");

      // Continuation claim must return undefined
      const continuation = await aiRepo.claimPendingContinuation(vpsId);
      expect(continuation).toBeUndefined();

      // wakeContinuation must not resurrect or schedule cancelled task
      await service.wakeContinuation(vpsId, task.id);
      const afterWake = await aiRepo.getTask(vpsId, task.id);
      expect(afterWake?.state).toBe("cancelled");
    });
  });

  // 5. Accumulated budgets & resume without reset
  describe("accumulated budgets and resume persistence", () => {
    it("resuming a task preserves accumulated counters, token usage, and deadline without reset", async () => {
      await setPolicy("manual");

      let callCount = 0;
      vi.spyOn(AiProvider.prototype, "generate").mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "Inspecting environment",
              toolCalls: [
                {
                  id: "read-call-1",
                  type: "function",
                  function: {
                    name: "service_status",
                    arguments: JSON.stringify({ unit: "app-service" }),
                  },
                },
              ],
            },
            usage: { inputTokens: 150, outputTokens: 50, estimated: false },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "Need clarification",
            toolCalls: [
              {
                id: "clarify-call-2",
                type: "function",
                function: {
                  name: "request_clarification",
                  arguments: JSON.stringify({ question: "Proceed with restart?" }),
                },
              },
            ],
          },
          usage: { inputTokens: 100, outputTokens: 40, estimated: false },
        };
      });

      const task = await service.create(request, vpsId, {
        request: "Inspect and ask",
        idempotencyKey: "resume-accum-test",
      });

      const pausedTask = await pollUntil(
        (t) => t.state === "awaiting_input",
        task.id,
      );

      // Verify non-zero counters and usage accumulated before resume
      expect(pausedTask.usage.inputTokens).toBeGreaterThan(0);
      expect(pausedTask.loop?.counters.providerCalls).toBeGreaterThan(0);
      const originalDeadline = pausedTask.loop?.deadlineAt;
      const priorUsage = { ...pausedTask.usage };
      const priorCounters = { ...pausedTask.loop!.counters };

      // Resume task
      const resumed = await service.resume(request, vpsId, task.id);

      // Assert counters and deadline are NOT reset to 0 / fresh values
      expect(resumed.usage.inputTokens).toBeGreaterThanOrEqual(priorUsage.inputTokens);
      expect(resumed.loop?.counters.providerCalls).toBeGreaterThanOrEqual(
        priorCounters.providerCalls,
      );
      expect(resumed.loop?.deadlineAt).toBe(originalDeadline);
    });

    it("cumulative task token exhaustion triggers budget_exhausted failure", async () => {
      // Recreate service with a tight token budget of 300 tokens
      const tightConfig = {
        ...config,
        ai: {
          ...config.ai,
          maxCumulativeTaskTokens: 300,
        },
      };

      const tightService = new AiTaskService(
        aiRepo,
        tightConfig,
        new AiPolicyService(tightConfig, aiRepo),
        {} as MetricService,
        {
          authenticateById: async () => ({ sessionId: "admin-session" }),
        } as unknown as DashboardSessionService,
        {} as DockerMonitoringService,
        {} as AiHostPlanService,
        bridgeService,
        monitoringRepo,
        readToolsService,
        vpsRepo,
      );

      await setPolicy("manual");

      vi.spyOn(AiProvider.prototype, "generate").mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "Token-heavy response",
          toolCalls: [
            {
              id: "read-heavy-1",
              type: "function",
              function: {
                name: "service_status",
                arguments: JSON.stringify({ unit: "app-service" }),
              },
            },
          ],
        },
        // Usage that exhausts the 300 token budget
        usage: { inputTokens: 250, outputTokens: 100, estimated: false },
      });

      const task = await tightService.create(request, vpsId, {
        request: "Request exceeding token budget",
        idempotencyKey: "budget-exhausted-test",
      });

      const failedTask = await pollUntil(
        (t) => t.state === "failed",
        task.id,
      );

      expect(failedTask.error?.code).toBe("budget_exhausted");
      expect(failedTask.completion?.kind).toBe("blocked");
      expect(failedTask.completion?.reasonCode).toBe("budget_exhausted");
      tightService.onModuleDestroy();
    });
  });
});
