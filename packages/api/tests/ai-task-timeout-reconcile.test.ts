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
import { createJsonDockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import type { DockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import { DockerManagementService } from "../src/docker/docker-management.service.js";
import { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
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
import type { AiPlan } from "../src/ai/ai.models.js";

const request = { dashboardSessionId: "admin-session" } as unknown as Request;

describe("AI task timeout bounds, queue claim prevention, and uncertain fence reconciliation", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let dockerRepo: DockerManagementRepository;
  let dockerService: DockerManagementService;
  let dockerBridge: AiDockerBridgeService;
  let vpsId: string;
  let taskService: AiTaskService;
  let agentService: AiAgentService;
  let retentionService: AiRetentionService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-timeout-reconcile-tests-"));
    const keyring: Keyring = createTestKeyring("kek_timeout_tests");
    await saveKeyringToFile(join(dir, "ai-keyring.json"), keyring);

    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    dockerRepo = createJsonDockerManagementRepository(join(dir, "docker-mgmt.json"));

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

    const mockMonitoring = {
      getAuthoritativeLatest: async () => null,
      getCachedSummary: async () => null,
      getCachedContainers: async () => [],
    };

    dockerService = new DockerManagementService(
      vpsRepo,
      dockerRepo,
      mockMonitoring as never,
    );

    const composeOps = new Map<string, { id: string; status: string; vpsId: string; appId: string; idempotencyKey: string }>();
    (globalThis as any).__composeOps = composeOps;
    const mockApplications = {
      findByIdempotencyKey: async (v: string, key: string) => {
        for (const op of composeOps.values()) {
          if (op.vpsId === v && op.idempotencyKey === key) return op;
        }
        return undefined;
      },
      failQueued: async (v: string, key: string) => {
        for (const op of composeOps.values()) {
          if (op.vpsId === v && op.idempotencyKey === key) {
            if (op.status === "prepared") {
              op.status = "cancelled";
              return true;
            }
            return false;
          }
        }
        return false;
      },
      releaseContainer: async () => {},
    };

    dockerBridge = new AiDockerBridgeService(
      aiRepo,
      config,
      vpsRepo,
      dockerService,
      mockApplications as never,
      mockMonitoring as never,
      mockMonitoring as never,
    );

    const policyService = new AiPolicyService(config, aiRepo);
    const mockSessions = {
      authenticateById: async () => ({ id: "admin-session", username: "admin" }),
      requireSession: async () => ({ id: "admin-session", username: "admin" }),
    };

    taskService = new AiTaskService(
      aiRepo,
      config,
      policyService,
      {} as never, // metrics
      mockSessions as never, // sessions
      {} as never, // docker
      {} as never, // hostPlans
      dockerBridge, // dockerBridge
      mockMonitoring as never, // monitoring
      {} as never, // readToolsService
      vpsRepo,
    );

    agentService = new AiAgentService(
      aiRepo,
      config,
      mockSessions as never,
      mockMonitoring as never,
      policyService,
      taskService,
    );

    retentionService = new AiRetentionService(
      config,
      aiRepo,
      vpsRepo,
      mockSessions as never,
      taskService,
    );
  });

  afterEach(async () => {
    taskService.onModuleDestroy();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const createPlan = (taskId: string, steps: AiPlan["steps"], status: AiPlan["status"] = "pending"): AiPlan => ({
    planId: randomUUID(),
    planVersion: 1,
    taskId,
    vpsId,
    agentInstanceId: "inst_1",
    providerRevision: 1,
    policyRevision: 1,
    planDigest: `digest_${randomUUID().replace(/-/g, "")}`,
    risk: "low",
    requiresApproval: true,
    steps,
    status,
    approvedAt: status === "approved" || status === "consumed" ? new Date().toISOString() : undefined,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  it("bounds non-dispatched stalled executing task and expires commands so queue cannot later claim", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Conv 1");
    const taskId = randomUUID();
    const plan = createPlan(taskId, [
      {
        stepId: "step_1",
        description: "run cmd",
        tool: "exec",
        command: "echo test",
        args: {},
        timeoutSeconds: 30,
      },
    ]);

    const { task: created } = await aiRepo.createTask({
      id: taskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "planning",
    });

    const taskWithPlan = await aiRepo.updateTask({
      id: taskId,
      expectedRevision: created.revision,
      state: "executing",
      ownerLease: { ownerInstanceId: "inst_1", leaseSeconds: 60 },
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      plan: { ...plan, status: "consumed" },
    });
    const commandId = randomUUID();
    await aiRepo.enqueueCommands([
      {
        entry: {
          id: commandId,
          taskId,
          stepId: "step_1",
          commandId,
          vpsId,
          agentInstanceId: "inst_1",
          planVersion: 1,
          planDigest: plan.planDigest,
          policyRevision: 1,
          command: {
            version: 1,
            taskId,
            stepId: "step_1",
            commandId,
            vpsId,
            agentInstanceId: "inst_1",
            planVersion: 1,
            planDigest: plan.planDigest,
            policyRevision: 1,
            deadlineAt: new Date(Date.now() - 1000).toISOString(),
            kind: "ai_host_action",
            command: {
              run: "echo test",
              argv: ["echo", "test"],
              cwd: "/root",
              env: {},
              timeoutSeconds: 30,
            },
          },
          payload: {
            stepId: "step_1",
            encryptedBlobId: "blob_1",
          },
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId,
          taskIdRevision: taskWithPlan.revision,
          planDigest: plan.planDigest,
        },
      },
    ]);

    const recovered = await (retentionService as any).reconcileActiveTasks();
    expect(recovered).toBeGreaterThanOrEqual(1);

    // Task must fail with deadline_exceeded (NOT uncertain, because no commands were claimed)
    const task = await aiRepo.getTask(vpsId, taskId);
    expect(task?.state).toBe("failed");
    expect(task?.error?.code).toBe("deadline_exceeded");

    // Commands in outbox must be atomically expired
    const outbox = await aiRepo.getOutboxEntry(commandId);
    expect(outbox?.status).toBe("failed");

    // Stale worker tries to claim the command - must NOT be claimable!
    const claimed = await aiRepo.claimCommands("inst_1", vpsId, 10);
    expect(claimed.length).toBe(0);

    // VPS is NOT fenced by uncertain task; slot is released
    const active = await aiRepo.getActiveTask(vpsId);
    expect(active).toBeFalsy();
  });

  it("bounds cancel_requested task without claimed commands: cancels cleanly and frees slot", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Conv C1");
    const taskId = randomUUID();
    await aiRepo.createTask({
      id: taskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "cancel_requested",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await (retentionService as any).reconcileActiveTasks();
    const task = await aiRepo.getTask(vpsId, taskId);
    expect(task?.state).toBe("cancelled");
    const active = await aiRepo.getActiveTask(vpsId);
    expect(active).toBeFalsy();
  });

  it("bounds cancel_requested task with claimed commands: transitions to uncertain preserving fence", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Conv C2");
    const taskId = randomUUID();
    const plan = createPlan(taskId, [
      {
        stepId: "step_c2",
        description: "run cmd",
        tool: "exec",
        command: "echo test",
        args: {},
        timeoutSeconds: 30,
      },
    ]);

    const { task: created } = await aiRepo.createTask({
      id: taskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "planning",
    });

    const taskWithPlan = await aiRepo.updateTask({
      id: taskId,
      expectedRevision: created.revision,
      state: "executing",
      ownerLease: { ownerInstanceId: "inst_1", leaseSeconds: 60 },
      plan: { ...plan, status: "consumed" },
    });

    const cmdId = randomUUID();
    await aiRepo.enqueueCommands([
      {
        entry: {
          id: cmdId,
          taskId,
          stepId: "step_c2",
          commandId: cmdId,
          vpsId,
          agentInstanceId: "inst_1",
          planVersion: 1,
          planDigest: plan.planDigest,
          policyRevision: 1,
          command: {
            version: 1,
            taskId,
            stepId: "step_c2",
            commandId: cmdId,
            vpsId,
            agentInstanceId: "inst_1",
            planVersion: 1,
            planDigest: plan.planDigest,
            policyRevision: 1,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            kind: "ai_host_action",
            command: {
              run: "echo test",
              argv: ["echo", "test"],
              cwd: "/root",
              env: {},
              timeoutSeconds: 30,
            },
          },
          payload: {
            stepId: "step_c2",
            encryptedBlobId: "blob_2",
          },
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId,
          taskIdRevision: taskWithPlan.revision,
          planDigest: plan.planDigest,
        },
      },
    ]);

    // Worker claims the command (it is dispatched!)
    const claimed = await aiRepo.claimCommands("inst_1", vpsId, 10);
    expect(claimed.length).toBe(1);

    const currentTask = (await aiRepo.getTask(vpsId, taskId))!;
    await aiRepo.updateTask({
      id: taskId,
      expectedRevision: currentTask.revision,
      state: "cancel_requested",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    // Now retention sweep runs
    await (retentionService as any).reconcileActiveTasks();
    const task = await aiRepo.getTask(vpsId, taskId);
    expect(task?.state).toBe("uncertain");
    expect(task?.error?.code).toBe("uncertain_outcome");
  });

  it("exact late target_busy receipt clears old AI uncertain and allows new approval", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Docker chat");
    const taskId = randomUUID();
    const stepId = "step_docker_restart";
    const plan = createPlan(taskId, [
      {
        stepId,
        description: "restart nginx",
        tool: "docker_action",
        command: "restart",
        args: { container: "nginx" },
        timeoutSeconds: 30,
      },
    ]);

    const { task: created } = await aiRepo.createTask({
      id: taskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "uncertain",
      error: {
        code: "uncertain_outcome",
        message: "Timed out waiting for docker operation",
      },
    });

    await aiRepo.updateTask({
      id: taskId,
      expectedRevision: created.revision,
      plan,
    });

    const idempotencyKey = `ai-step-${stepId}`;
    const { operation: op } = await dockerRepo.create({
      id: randomUUID(),
      vpsId,
      action: "restart",
      target: { container: "nginx", containerKey: "nginx" },
      idempotencyKey,
      requestDigest: "digest123",
    });
    await dockerRepo.claim(op.id, "inst_1");

    // Verify that VPS is fenced right now: approval of a new task is rejected
    const newTaskId = randomUUID();
    const newPlan = createPlan(newTaskId, [
      {
        stepId: "step_new",
        description: "start container",
        tool: "docker_action",
        command: "start",
        args: { container: "web" },
        timeoutSeconds: 10,
      },
    ]);
    const { task: newCreated } = await aiRepo.createTask({
      id: newTaskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "awaiting_approval",
    });
    await aiRepo.updateTask({
      id: newTaskId,
      expectedRevision: newCreated.revision,
      plan: newPlan,
    });
    const execSpy = vi.spyOn(dockerBridge, "execute").mockResolvedValue({ ok: true, result: { ok: true } });
    await expect(
      taskService.approve(request, vpsId, newTaskId, {
        planVersion: newPlan.planVersion,
        planDigest: newPlan.planDigest,
      }),
    ).rejects.toThrow(/Cannot approve mutations while an unresolved uncertain execution exists/i);
    expect(execSpy).not.toHaveBeenCalled();
    // Late result arrives from agent: target_busy
    await dockerService.resultForAgent(vpsId, {
      commandId: op.id,
      agentInstanceId: "inst_1",
      status: "failed",
      errorCode: "target_busy",
    });
    // Late result automatically reconciles the uncertain task in real time via listener;
    // running retention sweep afterwards is idempotent.
    const reconciledOldTask = await aiRepo.getTask(vpsId, taskId);
    expect(reconciledOldTask?.state).toBe("failed");
    expect(reconciledOldTask?.error?.code).toBe("task_busy");
    expect(reconciledOldTask?.error?.message).toBe("target_busy");

    await (retentionService as any).reconcileActiveTasks();
    // VPS fence is now cleared! New task approval now succeeds!
    const approvedNewTask = await taskService.approve(request, vpsId, newTaskId, {
      planVersion: newPlan.planVersion,
      planDigest: newPlan.planDigest,
    });
    expect(approvedNewTask.state).toBe("succeeded");
    expect(execSpy).toHaveBeenCalled();
  });

  it("reconciliation is idempotent and unresolved unknown stays fenced", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Multi chat");
    const multiTaskId = randomUUID();
    const multiPlan = createPlan(multiTaskId, [
      {
        stepId: "step_1",
        description: "echo step 1",
        tool: "exec",
        command: "echo 1",
        args: {},
        timeoutSeconds: 10,
      },
      {
        stepId: "step_2",
        description: "echo step 2",
        tool: "exec",
        command: "echo 2",
        args: {},
        timeoutSeconds: 10,
      },
    ]);

    const { task: multiCreated } = await aiRepo.createTask({
      id: multiTaskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "uncertain",
    });
    await aiRepo.updateTask({
      id: multiTaskId,
      expectedRevision: multiCreated.revision,
      plan: multiPlan,
    });

    // Record receipt for step 1 only
    await aiRepo.recordReceipts([
      {
        commandId: randomUUID(),
        taskId: multiTaskId,
        stepId: "step_1",
        vpsId,
        agentInstanceId: "inst_1",
        planVersion: 1,
        planDigest: multiPlan.planDigest,
        payloadDigest: "digest_1",
        status: "succeeded",
        result: { ok: true },
        createdAt: new Date().toISOString(),
      },
    ]);

    // Reconcile via taskService: step 2 has no receipt -> stays uncertain
    const reconciledPartial = await taskService.reconcile(request, vpsId, multiTaskId);
    expect(reconciledPartial.state).toBe("uncertain");

    // Record receipt for step 2 as succeeded
    await aiRepo.recordReceipts([
      {
        commandId: randomUUID(),
        taskId: multiTaskId,
        stepId: "step_2",
        vpsId,
        agentInstanceId: "inst_1",
        planVersion: 1,
        planDigest: multiPlan.planDigest,
        payloadDigest: "digest_2",
        status: "succeeded",
        result: { ok: true },
        createdAt: new Date().toISOString(),
      },
    ]);

    // Reconcile again -> transitions to succeeded
    const reconciledComplete = await taskService.reconcile(request, vpsId, multiTaskId);
    expect(reconciledComplete.state).toBe("succeeded");

    // Repeated reconciliation on settled task is idempotent
    const reconciledAgain = await taskService.reconcile(request, vpsId, multiTaskId);
    expect(reconciledAgain.state).toBe("succeeded");
  });

  it("indeterminate Docker receipt (uncertain_outcome) preserves uncertainty fence", async () => {
    const conv = await aiRepo.createConversation(vpsId, "Indeterminate Docker chat");
    const taskId = randomUUID();
    const stepId = "step_docker_indeterminate";
    const idempotencyKey = `ai-step-${stepId}`;
    const plan = createPlan(taskId, [
      {
        stepId,
        description: "restart nginx container",
        tool: "docker_action",
        action: "restart",
        containerId: "c123",
        command: "docker restart c123",
        args: { action: "restart", containerId: "c123" },
        timeoutSeconds: 10,
      },
    ]);

    const { operation: op } = await dockerRepo.create({
      id: randomUUID(),
      vpsId,
      action: "restart",
      target: { container: "c123", containerKey: "c123" },
      idempotencyKey,
      requestDigest: "digest-c123",
    });
    await dockerRepo.claim(op.id, "inst_1");

    const { task: created } = await aiRepo.createTask({
      id: taskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "uncertain",
    });
    await aiRepo.updateTask({
      id: taskId,
      expectedRevision: created.revision,
      plan,
    });

    // Late result arrives: indeterminate / uncertain_outcome
    await dockerService.resultForAgent(vpsId, {
      commandId: op.id,
      agentInstanceId: "inst_1",
      status: "uncertain",
      errorCode: "uncertain_outcome",
    });

    // Reconcile via taskService: must remain uncertain because outcome is indeterminate!
    const reconciled = await taskService.reconcile(request, vpsId, taskId);
    expect(reconciled.state).toBe("uncertain");

    // Approval of another mutation must still be blocked by fence
    const newTaskId = randomUUID();
    const newPlan = createPlan(newTaskId, [
      {
        stepId: "step_new",
        description: "start container",
        tool: "docker_action",
        command: "start",
        args: { container: "web" },
        timeoutSeconds: 10,
      },
    ]);
    const { task: newCreated } = await aiRepo.createTask({
      id: newTaskId,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "awaiting_approval",
    });
    await aiRepo.updateTask({
      id: newTaskId,
      expectedRevision: newCreated.revision,
      plan: newPlan,
    });
    await expect(
      taskService.approve(request, vpsId, newTaskId, {
        planVersion: newPlan.planVersion,
        planDigest: newPlan.planDigest,
      }),
    ).rejects.toThrow(/Cannot approve mutations while an unresolved uncertain execution exists/i);
  });

  it("bounds stalled compose tasks: cancels prepared compose op; claimed compose op stays uncertain and fences", async () => {
    const composeOps = (globalThis as any).__composeOps as Map<string, any>;
    const conv = await aiRepo.createConversation(vpsId, "Compose chat");

    // 1. Prepared compose op: cancel cleanly on timeout
    const taskId1 = randomUUID();
    const plan1 = createPlan(taskId1, [
      {
        stepId: "step_c1",
        description: "compose up",
        tool: "compose_action",
        command: "up",
        args: { service: "web" },
        timeoutSeconds: 10,
      },
    ]);
    const { task: t1 } = await aiRepo.createTask({
      id: taskId1,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "planning",
    });
    await aiRepo.updateTask({
      id: taskId1,
      expectedRevision: t1.revision,
      expiresAt: new Date(Date.now() - 5000).toISOString(),
      plan: plan1,
    });
    composeOps.set("op1", {
      id: "op1",
      vpsId,
      appId: "app1",
      idempotencyKey: `ai-step-step_c1`,
      status: "prepared",
    });

    await retentionService.reconcileActiveTasks();
    const stored1 = await aiRepo.getTask(vpsId, taskId1);
    expect(stored1?.state).toBe("expired");
    expect(composeOps.get("op1")?.status).toBe("cancelled");

    // Conversation active slot is freed
    expect(await aiRepo.getActiveTask(vpsId)).toBeFalsy();

    // 2. Claimed/applying compose op: cannot cancel -> transitions to uncertain, preserves fence
    const taskId2 = randomUUID();
    const plan2 = createPlan(taskId2, [
      {
        stepId: "step_c2",
        description: "compose deploy",
        tool: "compose_deploy",
        command: "deploy",
        args: {},
        timeoutSeconds: 10,
      },
    ]);
    const { task: t2 } = await aiRepo.createTask({
      id: taskId2,
      vpsId,
      conversationId: conv.id,
      initiatingSessionId: "admin-session",
      state: "cancel_requested",
    });
    await aiRepo.updateTask({
      id: taskId2,
      expectedRevision: t2.revision,
      expiresAt: new Date(Date.now() - 5000).toISOString(),
      plan: plan2,
    });
    composeOps.set("op2", {
      id: "op2",
      vpsId,
      appId: "app2",
      idempotencyKey: `ai-step-step_c2`,
      status: "applying",
    });

    await retentionService.reconcileActiveTasks();
    const stored2 = await aiRepo.getTask(vpsId, taskId2);
    expect(stored2?.state).toBe("uncertain");
    // Status in compose remains applying (not modified)
    expect(composeOps.get("op2")?.status).toBe("applying");
  });

  it("counts executed cancelled receipt as unresolved outcome during command expiration", async () => {
    const taskId = randomUUID();
    const commandId = randomUUID();
    const stepId = "step-cancel-executed";

    const conversation = await aiRepo.createConversation(vpsId, "Cancel executed");
    const { task: t } = await aiRepo.createTask({
      id: taskId,
      vpsId,
      conversationId: conversation.id,
      initiatingSessionId: "admin-session",
      state: "cancel_requested",
    });
    const tWithPlan = await aiRepo.updateTask({
      id: taskId,
      expectedRevision: t.revision,
      plan: {
        planId: "p1",
        planVersion: 1,
        vpsId,
        agentInstanceId: "agent-smoke",
        policyRevision: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        steps: [{ stepId, tool: "host_command", description: "cmd", args: {}, timeoutSeconds: 30, resourceKeys: [], inputDigests: {} }],
        status: "consumed",
        preconditions: [],
        planDigest: "a".repeat(64),
      },
    });

    await aiRepo.enqueueCommands([
      {
        entry: {
          id: commandId,
          taskId,
          stepId,
          commandId,
          vpsId,
          agentInstanceId: "agent-smoke",
          planVersion: 1,
          planDigest: "a".repeat(64),
          policyRevision: 1,
          command: {
            version: 1,
            taskId,
            stepId,
            commandId,
            vpsId,
            agentInstanceId: "agent-smoke",
            planVersion: 1,
            planDigest: "a".repeat(64),
            policyRevision: 1,
            deadlineAt: new Date(Date.now() + 60000).toISOString(),
            kind: "ai_host_action",
            command: {
              run: "echo test",
              argv: ["echo", "test"],
              cwd: "/root",
              timeoutSeconds: 30,
            },
          },
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId,
          taskIdRevision: tWithPlan.revision,
          planDigest: "a".repeat(64),
        },
      },
    ]);

    // Record receipt with cancelled status but executed: true
    await aiRepo.recordReceipts([
      {
        commandId,
        taskId,
        stepId,
        vpsId,
        agentInstanceId: "agent-smoke",
        planVersion: 1,
        planDigest: "a".repeat(64),
        payloadDigest: "p".repeat(64),
        status: "cancelled",
        result: { executed: true, exitCode: 130 },
        createdAt: new Date().toISOString(),
      },
    ]);

    // expirePendingCommandsForTask must see that this command outcome was executed after cancellation
    const res = await aiRepo.expirePendingCommandsForTask(taskId);
    expect(res.remainingDispatchedCount).toBeGreaterThanOrEqual(1);
  });

  it("releases container reservation when tombstoning a queued Docker operation", async () => {
    let releasedId: string | undefined;
    const fakeApps = {
      releaseContainer: async (_vpsId: string, opId: string) => {
        releasedId = opId;
      },
    };
    const svcWithApps = new DockerManagementService(
      vpsRepo,
      dockerRepo,
      {} as never,
      { mode: "local" } as AppConfig,
      fakeApps as never,
    );

    const idempotencyKey = "ai-step-tombstone-reservation-test";
    // Create queued operation
    await dockerRepo.create({
      id: "op-queued-tombstone",
      vpsId,
      idempotencyKey,
      requestDigest: "d".repeat(64),
      action: "stop",
      target: { containerKey: "web-app", agentInstanceId: "agent-1" },
    });

    const tombstoned = await svcWithApps.tombstone(vpsId, idempotencyKey, "deadline_exceeded");
    expect(tombstoned.status).toBe("failed");
    expect(releasedId).toBe("op-queued-tombstone");
  });
});
