import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiAgentService } from "../src/ai/ai-agent.service.js";
import { AiRetentionService } from "../src/ai/ai-retention.service.js";
import { createJsonDockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import type { DockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import { DockerManagementService } from "../src/docker/docker-management.service.js";
import { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
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
  let dockerRepo: DockerManagementRepository;
  let dockerManagementService: DockerManagementService;
  let dockerBridge: AiDockerBridgeService;
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
      dockerManagementEnabled: true,
    });
    vpsId = created.id;
    await vpsRepo.update(vpsId, { dockerManagementEnabled: true });

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

    dockerRepo = createJsonDockerManagementRepository(join(dir, "docker-mgmt.json"));
    dockerManagementService = new DockerManagementService(
      vpsRepo,
      dockerRepo,
      {
        listContainers: async () => [{
          containerKey: "cont-1",
          agentInstanceId: "agent-123",
          names: ["/cont-1"],
        }],
      } as never,
      {} as never,
    );

    dockerBridge = new AiDockerBridgeService(
      aiRepo,
      config,
      vpsRepo,
      dockerManagementService,
      {} as never,
      {} as never,
      {} as never,
    );

    taskService = new AiTaskService(
      aiRepo,
      config,
      policyService,
      {} as never,
      mockSessions as never,
      {} as never,
      {} as never,
      dockerBridge,
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
      dockerBridge,
    );

    retentionService = new AiRetentionService(
      config,
      aiRepo,
      vpsRepo,
      mockSessions as never,
      taskService,
      dockerBridge,
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
      message: expect.stringMatching(/reconciliation required/i),
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

  it("fences bridge dispatch so retention cleanup prevents late docker operation insertion", async () => {
    const conv1 = await aiRepo.createConversation(vpsId, "Fenced test");
    const { task: expiredTask } = await aiRepo.createTask({
      conversationId: conv1.id,
      vpsId,
      initiatingSessionId: "session-1",
      task: "Restart container",
    });

    const stepId = "step-fenced-1";
    await aiRepo.updateTask({
      id: expiredTask.id,
      expectedRevision: expiredTask.revision,
      state: "executing",
      ownerLease: { ownerInstanceId: "owner-1", leaseSeconds: 60 },
      expiresAt: new Date(Date.now() - 10000).toISOString(),
      plan: {
        planId: randomUUID(),
        planVersion: 1,
        taskId: expiredTask.id,
        vpsId,
        agentInstanceId: "agent-123",
        provider: "openai",
        model: "gpt-4o",
        policyRevision: 1,
        execMode: "sandbox",
        steps: [
          {
            stepId,
            tool: "docker_action",
            version: 1,
            args: { action: "restart", target: "cont-1" },
            resourceKeys: [],
            inputDigests: {},
            description: "Restart docker container",
            timeoutSeconds: 30,
          },
        ],
        preconditions: [],
        planDigest: "d".repeat(64),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        status: "consumed",
      },
    });

    // Simulate retention sweeping the executing expired task:
    // It should fence the task first
    taskService.fenceTask(expiredTask.id);

    let reservedCount = 0;
    let releasedCount = 0;
    (dockerManagementService as unknown as { applications: unknown }).applications = {
      reserveContainer: async () => { reservedCount++; },
      releaseContainer: async () => { releasedCount++; },
    };

    // If bridge dispatch tries to create docker operation now, onBeforeCreate fails with stale_plan
    const createPromise = dockerManagementService.create(vpsId, {
      action: "restart",
      target: { containerKey: "cont-1", agentInstanceId: "agent-123" },
      idempotencyKey: `ai-step-${stepId}`,
      onBeforeCreate: async () => {
        if (taskService.isTaskFenced(expiredTask.id)) {
          throw new Error("Task dispatch fenced by retention");
        }
      },
    });

    await expect(createPromise).rejects.toThrow("Task dispatch fenced by retention");
    expect(reservedCount).toBe(1);
    expect(releasedCount).toBe(1);

    // Verify no operation was created in Docker management repository
    const op = await dockerRepo.findByIdempotencyKey(vpsId, `ai-step-${stepId}`);
    expect(op).toBeUndefined();
  });

  it("does not count completed automatic reads as unresolved dispatched commands on timeout", async () => {
    const conv2 = await aiRepo.createConversation(vpsId, "Read test");
    const { task: expiredTask } = await aiRepo.createTask({
      conversationId: conv2.id,
      vpsId,
      initiatingSessionId: "session-1",
      task: "Inspect host",
    });

    // Enqueue command and claim it so outbox entry is marked dispatched
    await aiRepo.enqueueCommands([
      {
        entry: {
          id: randomUUID(),
          taskId: expiredTask.id,
          stepId: "step-read-1",
          commandId: "cmd-read-1",
          vpsId,
          agentInstanceId: "agent-123",
          command: {
            version: 1,
            taskId: expiredTask.id,
            stepId: "step-read-1",
            commandId: "cmd-read-1",
            vpsId,
            agentInstanceId: "agent-123",
            planVersion: 1,
            planDigest: "e".repeat(64),
            policyRevision: 1,
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
            kind: "read",
            payload: {},
          },
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId: expiredTask.id,
          taskIdRevision: expiredTask.revision,
          autoAuthorized: true,
        },
      },
    ]);
    await aiRepo.claimCommands("agent-123", vpsId, 10);

    // Record a completed automatic read receipt
    await aiRepo.recordReceipts([
      {
        id: randomUUID(),
        taskId: expiredTask.id,
        vpsId,
        agentInstanceId: "agent-123",
        commandId: "cmd-read-1",
        stepId: "step-read-1",
        planVersion: 1,
        planDigest: "e".repeat(64),
        status: "succeeded",
        exitCode: 0,
        executed: true,
        summary: "Read completed",
        createdAt: new Date().toISOString(),
      },
    ]);

    const res = await aiRepo.expirePendingCommandsForTask(expiredTask.id);
    expect(res.remainingDispatchedCount).toBe(0);
  });

  it("recognizes indeterminate Docker operation failures (uncertain_outcome) as unresolved outcome", async () => {
    const stepId = "step-indeterminate-1";
    const opId = "op-indet-1";
    await dockerRepo.create({
      id: opId,
      vpsId,
      idempotencyKey: `ai-step-${stepId}`,
      requestDigest: "r".repeat(64),
      action: "restart",
      target: { containerKey: "cont-1", agentInstanceId: "agent-123" },
    });
    await dockerRepo.claim(opId, "agent-123");
    await dockerRepo.setResult(opId, "failed", {
      ok: false,
      message: "uncertain_outcome",
    });

    const conv3 = await aiRepo.createConversation(vpsId, "Docker indet test");
    const { task } = await aiRepo.createTask({
      conversationId: conv3.id,
      vpsId,
      initiatingSessionId: "session-1",
      task: "Restart container",
    });
    const taskWithPlan = await aiRepo.updateTask({
      id: task.id,
      expectedRevision: task.revision,
      state: "executing",
      ownerLease: { ownerInstanceId: "owner-1", leaseSeconds: 60 },
      plan: {
        planId: randomUUID(),
        planVersion: 1,
        taskId: task.id,
        vpsId,
        agentInstanceId: "agent-123",
        provider: "openai",
        model: "gpt-4o",
        policyRevision: 1,
        execMode: "sandbox",
        steps: [
          {
            stepId,
            tool: "docker_action",
            version: 1,
            args: { action: "restart", target: "cont-1" },
            resourceKeys: [],
            inputDigests: {},
            description: "Restart docker container",
            timeoutSeconds: 30,
          },
        ],
        preconditions: [],
        planDigest: "d".repeat(64),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        status: "consumed",
      },
    });

    const queueStatus = await taskService.failQueuedOperationsForTask(vpsId, taskWithPlan);
    expect(queueStatus.claimedCount).toBe(1);
    expect(queueStatus.failedCount).toBe(0);
  });

  it("reconciles Docker uncertain task on late target_busy receipt and clears mutation fence", async () => {
    const stepId = "step-docker-busy-clear";
    const idempotencyKey = `ai-step-${stepId}`;
    const op = await dockerRepo.create({
      id: "op-docker-busy-clear",
      vpsId,
      idempotencyKey,
      requestDigest: "busy-clear-digest",
      action: "start",
      target: { containerKey: "cont-1", agentInstanceId: "agent-123" },
    });

    const conv = await aiRepo.createConversation(vpsId, "Docker busy clear test");
    const { task: uncertainTask } = await aiRepo.createTask({
      id: randomUUID(),
      conversationId: conv.id,
      vpsId,
      initiatingSessionId: "admin-session",
      requestSummary: "Docker busy task",
    });

    await aiRepo.updateTask({
      id: uncertainTask.id,
      expectedRevision: uncertainTask.revision,
      state: "uncertain",
      error: { code: "uncertain_outcome", message: "Timed out observing Docker operation completion" },
      plan: {
        planId: "plan-busy-clear",
        planVersion: 1,
        taskRevision: uncertainTask.revision,
        vpsId,
        agentInstanceId: "agent-123",
        steps: [
          {
            stepId,
            tool: "docker_action",
            description: "Start container",
            args: { action: "start", target: { containerKey: "cont-1" } },
          },
        ],
        status: "approved",
        approvedAt: new Date().toISOString(),
      },
    });

    // Verify fence is active: new task approval must be rejected with uncertain_outcome
    const { task: blockedTask } = await aiRepo.createTask({
      id: randomUUID(),
      conversationId: conv.id,
      vpsId,
      initiatingSessionId: "admin-session",
      requestSummary: "Blocked competing task",
    });
    const blockedPlan = await aiRepo.updateTask({
      id: blockedTask.id,
      expectedRevision: blockedTask.revision,
      state: "awaiting_approval",
      plan: {
        planId: "plan-blocked",
        planVersion: 1,
        planDigest: "f".repeat(64),
        taskRevision: blockedTask.revision,
        policyRevision: 1,
        providerRevision: 1,
        vpsId,
        agentInstanceId: "agent-123",
        steps: [{ stepId: "step-blocked", tool: "docker_action", description: "Stop", args: { action: "stop", target: { containerKey: "cont-1" } } }],
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    await expect(
      taskService.approve(request, vpsId, blockedTask.id, {
        planVersion: 1,
        planDigest: "f".repeat(64),
      }),
    ).rejects.toThrow(/uncertain executions exist|uncertain/i);

    // Agent reports late target_busy receipt
    await dockerRepo.claim(op.operation.id, "agent-123");
    await dockerManagementService.resultForAgent(vpsId, {
      commandId: op.operation.id,
      agentInstanceId: "agent-123",
      status: "failed",
      result: { ok: false, message: "target_busy" },
    });

    // Verify uncertain task is now definitively reconciled to failed
    const resolvedTask = await aiRepo.getTask(vpsId, uncertainTask.id);
    expect(resolvedTask?.state).toBe("failed");
    expect(resolvedTask?.error?.code).toBe("action_failed");

    // Repeated manual reconciliation is idempotent
    const reconciledAgain = await taskService.reconcile(request, vpsId, uncertainTask.id);
    expect(reconciledAgain.state).toBe("failed");
    // Verify fence is cleared: previously blocked task can now be approved
    vi.spyOn(dockerBridge, "execute").mockResolvedValueOnce({
      ok: true,
      result: { ok: true },
    } as never);
    const approved = await taskService.approve(request, vpsId, blockedTask.id, {
      planVersion: 1,
      planDigest: "f".repeat(64),
    });
    expect(approved.state).toBe("succeeded");
  });

  it("retention sweep auto-reconciles Docker uncertain task when definitive failed operation exists", async () => {
    const stepId = "step-retention-reconcile";
    const idempotencyKey = `ai-step-${stepId}`;
    await dockerRepo.create({
      id: "op-retention-reconcile",
      vpsId,
      idempotencyKey,
      requestDigest: "retention-digest",
      action: "start",
      target: { containerKey: "cont-1", agentInstanceId: "agent-123" },
    });
    await dockerRepo.claim("op-retention-reconcile", "agent-123");
    // Directly set result as if reported while server was offline
    await dockerRepo.setResult("op-retention-reconcile", "failed", {
      ok: false,
      message: "target_busy",
    });

    const conv = await aiRepo.createConversation(vpsId, "Retention sweep test");
    const { task: uncertainTask } = await aiRepo.createTask({
      id: randomUUID(),
      conversationId: conv.id,
      vpsId,
      initiatingSessionId: "admin-session",
      requestSummary: "Uncertain task before sweep",
    });
    await aiRepo.updateTask({
      id: uncertainTask.id,
      expectedRevision: uncertainTask.revision,
      state: "uncertain",
      error: { code: "uncertain_outcome", message: "Timed out" },
      plan: {
        planId: "plan-sweep",
        planVersion: 1,
        taskRevision: uncertainTask.revision,
        vpsId,
        agentInstanceId: "agent-123",
        steps: [
          {
            stepId,
            tool: "docker_action",
            description: "Start container",
            args: { action: "start", target: { containerKey: "cont-1" } },
          },
        ],
        status: "approved",
      },
    });

    const recovered = await retentionService.reconcileActiveTasks();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const taskAfter = await aiRepo.getTask(vpsId, uncertainTask.id);
    expect(taskAfter?.state).toBe("failed");
    expect(taskAfter?.error?.code).toBe("task_busy");
  });

  it("preserves uncertain fence on multi-step plan when only partial evidence exists", async () => {
    const step1 = "step-multi-1";
    const step2 = "step-multi-2";

    // Step 1 has definitive failed receipt
    await dockerRepo.create({
      id: "op-multi-1",
      vpsId,
      idempotencyKey: `ai-step-${step1}`,
      requestDigest: "multi-1-digest",
      action: "start",
      target: { containerKey: "cont-1", agentInstanceId: "agent-123" },
    });
    await dockerRepo.claim("op-multi-1", "agent-123");
    await dockerRepo.setResult("op-multi-1", "failed", { ok: false, message: "action_failed" });

    // Step 2 has NO receipt / still pending or uncertain
    const conv = await aiRepo.createConversation(vpsId, "Multi-step test");
    const { task: uncertainTask } = await aiRepo.createTask({
      id: randomUUID(),
      conversationId: conv.id,
      vpsId,
      initiatingSessionId: "admin-session",
      requestSummary: "Multi-step uncertain task",
    });
    await aiRepo.updateTask({
      id: uncertainTask.id,
      expectedRevision: uncertainTask.revision,
      state: "uncertain",
      error: { code: "uncertain_outcome", message: "Timeout" },
      plan: {
        planId: "plan-multi",
        planVersion: 1,
        taskRevision: uncertainTask.revision,
        vpsId,
        agentInstanceId: "agent-123",
        steps: [
          {
            stepId: step1,
            tool: "docker_action",
            description: "Step 1",
            args: { action: "start", target: { containerKey: "cont-1" } },
          },
          {
            stepId: step2,
            tool: "docker_action",
            description: "Step 2",
            args: { action: "stop", target: { containerKey: "cont-1" } },
          },
        ],
        status: "approved",
      },
    });

    // Manual reconcile must preserve uncertain state because step 2 has no definitive terminal evidence
    const reconciled = await taskService.reconcile(request, vpsId, uncertainTask.id);
    expect(reconciled.state).toBe("uncertain");

    // Active task admission must still be blocked by uncertain fence
    const { task: blockedTask } = await aiRepo.createTask({
      id: randomUUID(),
      conversationId: conv.id,
      vpsId,
      initiatingSessionId: "admin-session",
      requestSummary: "Blocked task",
    });
    await aiRepo.updateTask({
      id: blockedTask.id,
      expectedRevision: blockedTask.revision,
      state: "awaiting_approval",
      plan: {
        planId: "plan-blocked-2",
        planVersion: 1,
        planDigest: "g".repeat(64),
        taskRevision: blockedTask.revision,
        policyRevision: 1,
        providerRevision: 1,
        vpsId,
        agentInstanceId: "agent-123",
        steps: [{ stepId: "step-b2", tool: "docker_action", description: "Stop", args: { action: "stop", target: { containerKey: "cont-1" } } }],
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await expect(
      taskService.approve(request, vpsId, blockedTask.id, {
        planVersion: 1,
        planDigest: "g".repeat(64),
      }),
    ).rejects.toThrow(/uncertain executions exist|uncertain/i);
  });

  it("atomically expires dispatch eligibility on timeout so worker cannot later claim stale commands", async () => {
    const expiredDeadlineIso = new Date(Date.now() - 30_000).toISOString();
    const conv = await aiRepo.createConversation(vpsId, "Timeout dispatch test");
    const { task } = await aiRepo.createTask({
      id: randomUUID(),
      conversationId: conv.id,
      vpsId,
      initiatingSessionId: "admin-session",
      requestSummary: "Task with pending command",
      expiresAt: expiredDeadlineIso,
    });

    const commandId = randomUUID();
    const stepId = "step-timeout-claim";
    const agentInstanceId = "agent-123";

    await aiRepo.updateTask({
      id: task.id,
      expectedRevision: task.revision,
      state: "executing",
      ownerLease: { ownerInstanceId: "test-owner", leaseSeconds: 1 },
      expiresAt: expiredDeadlineIso,
      plan: {
        planId: "plan-timeout-claim",
        planVersion: 1,
        taskRevision: task.revision,
        vpsId,
        agentInstanceId,
        planDigest: "h".repeat(64),
        steps: [
          {
            stepId,
            tool: "host_command",
            command: "echo test",
          },
        ],
        status: "approved",
      },
    });

    await aiRepo.enqueueCommands([
      {
        entry: {
          id: randomUUID(),
          taskId: task.id,
          stepId,
          commandId,
          vpsId,
          agentInstanceId,
          status: "pending",
          command: {
            version: 1,
            taskId: task.id,
            stepId,
            commandId,
            vpsId,
            agentInstanceId,
            planVersion: 1,
            planDigest: "h".repeat(64),
            policyRevision: 1,
            deadlineAt: expiredDeadlineIso,
            kind: "host_command",
          },
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId: task.id,
          taskIdRevision: 2,
          planDigest: "h".repeat(64),
          commandId,
        },
      },
    ]);

    // Let lease expire
    await new Promise((r) => setTimeout(r, 1100));

    // Retention sweep runs
    const recovered = await retentionService.reconcileActiveTasks();
    expect(recovered).toBeGreaterThanOrEqual(1);

    // Verify task failed with deadline_exceeded and no fence was created
    const taskAfter = await aiRepo.getTask(vpsId, task.id);
    expect(taskAfter?.state).toBe("failed");
    expect(taskAfter?.error?.code).toBe("deadline_exceeded");

    // Worker agent attempts to claim; must receive 0 commands
    const claims = await aiRepo.claimCommands(agentInstanceId, vpsId, 5);
    expect(claims).toHaveLength(0);
  });
});
