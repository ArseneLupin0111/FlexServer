import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiAgentService } from "../src/ai/ai-agent.service.js";
import { AiRetentionService } from "../src/ai/ai-retention.service.js";
import {
  createTestKeyring,
  saveKeyringToFile,
  type Keyring,
} from "../src/ssh/key-encryption.js";
import { encryptAiSecret } from "../src/ai/ai-crypto.js";
import { AI_PROVIDER_KEY_CONTEXT } from "../src/ai/ai-routes.service.js";

const request = { dashboardSessionId: "admin-session" } as unknown as Request;

describe("AI uncertain task admission and mutation fence regressions", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let taskService: AiTaskService;
  let agentService: AiAgentService;
  let retentionService: AiRetentionService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-uncertain-regressions-"));
    const keyring: Keyring = createTestKeyring("kek_uncertain_tests");
    await saveKeyringToFile(join(dir, "ai-keyring.json"), keyring);

    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    const created = await vpsRepo.create({
      name: "VPS",
      host: "127.0.0.1",
      port: 22,
      username: "root",
    });
    vpsId = created.id;

    await aiRepo.updateSettings({
      patch: { endpoint: "https://provider.example.test/v1", model: "test-model" },
      apiKeyEnvelope: encryptAiSecret("sk-fixture-key", AI_PROVIDER_KEY_CONTEXT, keyring),
      expectedRevision: 0,
    });
    await aiRepo.updateAiPolicy({
      vpsId,
      patch: {
        aiEnabled: true,
        readEnabled: true,
        dockerActionsEnabled: true,
        composeActionsEnabled: true,
        shellEnabled: true,
      },
      expectedRevision: 0,
    });

    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "secret-session-key-0123456789abcdef",
    });
    const config: AppConfig = {
      ...parsed,
      ai: {
        ...parsed.ai,
        enabled: true,
        keyringFile: join(dir, "ai-keyring.json"),
      },
    };

    const policyService = new AiPolicyService(config, aiRepo);
    const mockSessions = {
      authenticateById: async () => ({ id: "admin-session", username: "admin" }),
      requireSession: async () => ({ id: "admin-session", username: "admin" }),
    };

    taskService = new AiTaskService(
      aiRepo,
      config,
      policyService,
      {} as never,
      mockSessions as never,
      {} as never,
      {} as never,
      {} as never,
      { getAuthoritativeLatest: async () => null } as never,
      {} as never,
      vpsRepo,
    );

    agentService = new AiAgentService(
      aiRepo,
      config,
      mockSessions as never,
      { getAuthoritativeLatest: async () => null } as never,
      policyService,
    );

    retentionService = new AiRetentionService(
      config,
      aiRepo,
      vpsRepo,
      mockSessions as never,
    );
  });

  afterEach(async () => {
    taskService.onModuleDestroy();
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

  it("allows admitting new planning task when an uncertain task exists on the VPS", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Existing chat");
    // Seed an existing task in uncertain state (e.g. from an interrupted executor)
    await aiRepo.createTask({
      id: "task-interrupted",
      conversationId: conv.id,
      vpsId,
      state: "uncertain",
      requestSummary: "Previous ambiguous mutation",
      idempotencyKey: "idem-prior",
      initiatingSessionId: "admin-session",
    });

    // Submitting a new user message / task in the same VPS must NOT be blocked with task_busy
    await expect(
      aiRepo.createTask({
        id: "task-new-chat",
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "Follow-up question after uncertain outcome",
        idempotencyKey: "idem-new",
        initiatingSessionId: "admin-session",
      }),
    ).resolves.toMatchObject({
      task: {
        id: "task-new-chat",
        state: "planning",
      },
    });
  });

  it("enforces mutation fence: rejects approval when an unresolved uncertain task exists on the VPS", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Guarded chat");
    // Seed an existing uncertain task
    await aiRepo.createTask({
      id: "task-prior-uncertain",
      conversationId: conv.id,
      vpsId,
      state: "uncertain",
      requestSummary: "Ambiguous executor outcome",
      idempotencyKey: "idem-prior-uncertain",
      initiatingSessionId: "admin-session",
    });

    // Create a new task awaiting approval with a plan
    const { task: planTask } = await aiRepo.createTask({
      id: "task-plan-awaiting",
      conversationId: conv.id,
      vpsId,
      state: "awaiting_approval",
      requestSummary: "New mutation plan",
      idempotencyKey: "idem-plan-awaiting",
      initiatingSessionId: "admin-session",
    });
    const currentSettings = await aiRepo.getSettings();
    const currentPolicy = await aiRepo.getAiPolicy(vpsId);
    const planDigest = "a".repeat(64);
    await aiRepo.updateTask({
      id: planTask.id,
      expectedRevision: planTask.revision,
      plan: {
        planId: randomUUID(),
        planVersion: 1,
        taskId: planTask.id,
        vpsId,
        providerRevision: currentSettings!.revision,
        policyRevision: currentPolicy!.revision,
        capabilityRevision: 0,
        execMode: "sandbox",
        steps: [
          {
            stepId: "step-1",
            tool: "docker_action",
            version: 1,
            args: { action: "restart", target: { containerKey: "web" } },
            resourceKeys: ["docker:web"],
            inputDigests: { payload: "b".repeat(64) },
            description: "Restart web",
            timeoutSeconds: 120,
          },
        ],
        preconditions: [],
        planDigest,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        status: "pending",
      },
    });

    // 1. Direct repository seam check: aiRepo.approve throws uncertain_outcome
    await expect(
      aiRepo.approve({
        taskId: planTask.id,
        planVersion: 1,
        planDigest,
        approvedSessionId: "admin-session",
      }),
    ).rejects.toMatchObject({
      code: "uncertain_outcome",
    });

    // 2. Service level check: taskService.approve maps it to 409 uncertain_outcome
    await expect(
      taskService.approve(request, vpsId, planTask.id, {
        planVersion: 1,
        planDigest,
      }),
    ).rejects.toMatchObject({
      code: "uncertain_outcome",
    });

    // 3. Approval remains strictly unconsumed: plan is still pending, task is still awaiting_approval
    const untouchedTask = await aiRepo.getTask(vpsId, planTask.id);
    expect(untouchedTask?.state).toBe("awaiting_approval");
    expect(untouchedTask?.plan?.status).toBe("pending");
  });

  it("renews owner lease on agent heartbeat during execution so retention does not falsely expire it", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Heartbeat chat");
    const initialLeaseExpiry = new Date(Date.now() + 30000).toISOString(); // 30s remaining (< 60s threshold)

    const { task: executingTask } = await aiRepo.createTask({
      id: "task-executing-hb",
      conversationId: conv.id,
      vpsId,
      state: "executing",
      requestSummary: "Long-running command",
      idempotencyKey: "idem-hb-exec",
      initiatingSessionId: "admin-session",
      ownerLease: {
        ownerInstanceId: "agent-123",
        leaseSeconds: 30,
      },
    });

    // Enqueue an outbox entry to simulate dispatched command
    const commandId = randomUUID();
    await aiRepo.enqueueCommands([
      {
        entry: {
          id: randomUUID(),
          taskId: executingTask.id,
          stepId: "step-1",
          commandId,
          vpsId,
          agentInstanceId: "agent-123",
          command: {
            version: 1,
            taskId: executingTask.id,
            stepId: "step-1",
            commandId,
            vpsId,
            agentInstanceId: "agent-123",
            planVersion: 1,
            planDigest: "c".repeat(64),
            policyRevision: 0,
            deadlineAt: new Date(Date.now() + 600000).toISOString(),
            kind: "exec",
            payload: {},
          },
          status: "dispatched",
          dispatchedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId: executingTask.id,
          taskIdRevision: executingTask.revision,
          commandId,
          autoAuthorized: true,
        },
      },
    ]);

    // Send heartbeat from agent
    const hbRes = await agentService.heartbeat(vpsId, {
      version: 1,
      taskId: executingTask.id,
      commandId,
      agentInstanceId: "agent-123",
      timestamp: new Date().toISOString(),
    });
    expect(hbRes.ok).toBe(true);

    // Lease expiry should be extended significantly beyond initial 30s
    const updated = await aiRepo.getTask(vpsId, executingTask.id);
    expect(updated?.ownerLeaseExpiresAt).toBeDefined();
    const newExpiresMs = new Date(updated!.ownerLeaseExpiresAt!).getTime();
    expect(newExpiresMs).toBeGreaterThan(Date.now() + 60000);
  });

  it("never deletes uncertain tasks or uncertain receipts during retention TTL pruning", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Retention guard");
    const pastTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    const { task: uncertainTask } = await aiRepo.createTask({
      id: "task-old-uncertain",
      conversationId: conv.id,
      vpsId,
      state: "uncertain",
      requestSummary: "Ancient ambiguous task",
      idempotencyKey: "idem-ancient",
      initiatingSessionId: "admin-session",
      createdAt: pastTime,
    });

    await aiRepo.recordReceipts([
      {
        id: randomUUID(),
        taskId: uncertainTask.id,
        stepId: "step-1",
        commandId: "cmd-old-1",
        vpsId,
        agentInstanceId: "agent-old",
        planVersion: 1,
        planDigest: "d".repeat(64),
        status: "uncertain",
        executed: true,
        errorCode: "uncertain_outcome",
        createdAt: pastTime,
      },
    ]);

    // Prune terminal tasks older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await aiRepo.deleteTerminalTasksOlderThan(thirtyDaysAgo, ["succeeded", "failed", "cancelled", "expired"]);

    const preservedTask = await aiRepo.getTask(vpsId, uncertainTask.id);
    expect(preservedTask).toBeDefined();
    expect(preservedTask?.state).toBe("uncertain");

    const receipts = await aiRepo.listReceiptsByTask(uncertainTask.id);
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.status).toBe("uncertain");
  });
  it("recovers gracefully when a heartbeat bumps task revision during result handling", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Heartbeat race chat");
    const { task: executingTask } = await aiRepo.createTask({
      id: "task-executing-race",
      conversationId: conv.id,
      vpsId,
      state: "executing",
      requestSummary: "Command racing with heartbeat",
      idempotencyKey: "idem-race-exec",
      initiatingSessionId: "admin-session",
      ownerLease: {
        ownerInstanceId: "agent-123",
        leaseSeconds: 60,
      },
    });

    const currentSettings = await aiRepo.getSettings();
    const currentPolicy = await aiRepo.getAiPolicy(vpsId);
    const commandId = randomUUID();
    const planDigest = "e".repeat(64);
    await aiRepo.updateTask({
      id: executingTask.id,
      expectedRevision: executingTask.revision,
      ownerLease: {
        ownerInstanceId: "agent-123",
        leaseSeconds: 60,
      },
      plan: {
        planId: randomUUID(),
        planVersion: 1,
        taskId: executingTask.id,
        vpsId,
        providerRevision: currentSettings!.revision,
        policyRevision: currentPolicy!.revision,
        capabilityRevision: 0,
        execMode: "sandbox",
        steps: [
          {
            stepId: "step-1",
            tool: "host:exec",
            version: 1,
            args: { cmd: "echo ok" },
            resourceKeys: [],
            inputDigests: { payload: "f".repeat(64) },
            description: "Echo",
            timeoutSeconds: 30,
          },
        ],
        preconditions: [],
        planDigest,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        status: "consumed",
      },
    });

    const taskWithPlan = (await aiRepo.getTask(vpsId, executingTask.id))!;

    await aiRepo.enqueueCommands([
      {
        entry: {
          id: randomUUID(),
          taskId: taskWithPlan.id,
          stepId: "step-1",
          commandId,
          vpsId,
          agentInstanceId: "agent-123",
          command: {
            version: 1,
            taskId: taskWithPlan.id,
            stepId: "step-1",
            commandId,
            vpsId,
            agentInstanceId: "agent-123",
            planVersion: 1,
            planDigest,
            policyRevision: currentPolicy!.revision,
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
            kind: "exec",
            payload: {},
          },
          status: "dispatched",
          dispatchedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId: taskWithPlan.id,
          taskIdRevision: taskWithPlan.revision,
          commandId,
          autoAuthorized: false,
          planDigest,
        },
      },
    ]);

    // Intercept recordReceipts to simulate a heartbeat arriving right as
    // the receipt is recorded (bumping task revision before transitionTaskOnReceipt CAS)
    const origRecordReceipts = aiRepo.recordReceipts.bind(aiRepo);
    aiRepo.recordReceipts = async (receipts) => {
      const res = await origRecordReceipts(receipts);
      await agentService.heartbeat(vpsId, {
        version: 1,
        taskId: taskWithPlan.id,
        commandId,
        agentInstanceId: "agent-123",
        timestamp: new Date().toISOString(),
      });
      return res;
    };

    // Deliver command result
    const resultRes = await agentService.result(vpsId, {
      version: 1,
      taskId: taskWithPlan.id,
      commandId,
      stepId: "step-1",
      agentInstanceId: "agent-123",
      planVersion: 1,
      planDigest,
      status: "succeeded",
      exitCode: 0,
      executed: true,
      timestamp: new Date().toISOString(),
    } as never);
    expect(resultRes.ok).toBe(true);

    // Task must have transitioned to succeeded despite heartbeat bumping revision in flight
    const finalTask = await aiRepo.getTask(vpsId, taskWithPlan.id);
    expect(finalTask?.state).toBe("succeeded");

    // Idempotent duplicate delivery: does not alter terminal state
    const duplicateRes = await agentService.result(vpsId, {
      version: 1,
      taskId: taskWithPlan.id,
      commandId,
      stepId: "step-1",
      agentInstanceId: "agent-123",
      planVersion: 1,
      planDigest,
      status: "succeeded",
      exitCode: 0,
      executed: true,
      timestamp: new Date().toISOString(),
    } as never);
    expect(duplicateRes.ok).toBe(true);
    const unchangedTask = await aiRepo.getTask(vpsId, taskWithPlan.id);
    expect(unchangedTask?.state).toBe("succeeded");
  });
});
