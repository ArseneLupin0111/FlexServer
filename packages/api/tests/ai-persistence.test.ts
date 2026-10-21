import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJsonAiRepository,
  withAiAdminLock,
} from "../src/persistence/repositories/ai.repository.js";
import { manageAiKeysFromCli } from "../src/scripts/manage-ai-keys.js";
import {
  encryptAiSecret,
  decryptAiSecret,
  loadAiKeyring,
} from "../src/ai/ai-crypto.js";
import type { Keyring } from "../src/ssh/key-encryption.js";
import {
  AiPersistenceConflictError,
  type AiOutboxCommandExpect,
  type AiPlanApprovalInput,
  type AiRepository,
  type AiTaskCreateInput,
} from "../src/persistence/repositories/ai.persistence.js";
import type {
  AiExecutionReceipt,
  AiHostCommand,
  AiOutboxEntry,
  AiPlan,
  AiPlanStep,
  AiTask,
  AiTaskState,
} from "../src/ai/ai.models.js";

function makePlanStep(overrides: Partial<AiPlanStep> = {}): AiPlanStep {
  return {
    stepId: overrides.stepId ?? `step-${randomUUID().slice(0, 8)}`,
    tool: overrides.tool ?? "service_status",
    version: overrides.version ?? 1,
    args: overrides.args ?? { service: "docker" },
    resourceKeys: overrides.resourceKeys ?? ["service:docker"],
    inputDigests: overrides.inputDigests ?? {},
    description: overrides.description ?? "Inspect docker service status",
    timeoutSeconds: overrides.timeoutSeconds ?? 30,
    ...overrides,
  };
}

function makePlan(overrides: Partial<AiPlan> = {}): AiPlan {
  const planId = overrides.planId ?? `plan-${randomUUID()}`;
  const taskId = overrides.taskId ?? `task-${randomUUID()}`;
  const vpsId = overrides.vpsId ?? "vps-test";
  return {
    planId,
    planVersion: 1,
    taskId,
    vpsId,
    agentInstanceId: "agent-instance-alpha",
    providerRevision: 1,
    policyRevision: 1,
    capabilityRevision: 1,
    steps: [makePlanStep()],
    preconditions: [],
    planDigest: "sha256:d41d8cd98f00b204e9800998ecf8427e",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: "pending",
    ...overrides,
  };
}

function makeHostCommand(overrides: Partial<AiHostCommand> = {}): AiHostCommand {
  const taskId = overrides.taskId ?? `task-${randomUUID()}`;
  const commandId = overrides.commandId ?? `cmd-${randomUUID()}`;
  return {
    version: 1,
    taskId,
    stepId: overrides.stepId ?? "step-1",
    commandId,
    vpsId: overrides.vpsId ?? "vps-test",
    agentInstanceId: overrides.agentInstanceId ?? "agent-instance-alpha",
    planVersion: overrides.planVersion ?? 1,
    planDigest: overrides.planDigest ?? "sha256:d41d8cd98f00b204e9800998ecf8427e",
    policyRevision: overrides.policyRevision ?? 1,
    deadlineAt: overrides.deadlineAt ?? new Date(Date.now() + 60_000).toISOString(),
    kind: "service_status",
    payload: overrides.payload ?? { service: "docker" },
    ...overrides,
  };
}

function makeOutboxEntry(command: AiHostCommand, overrides: Partial<AiOutboxEntry> = {}): AiOutboxEntry {
  return {
    id: overrides.id ?? `outbox-${randomUUID()}`,
    taskId: command.taskId,
    stepId: command.stepId,
    commandId: command.commandId,
    vpsId: command.vpsId,
    agentInstanceId: command.agentInstanceId,
    command,
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<AiExecutionReceipt> = {}): AiExecutionReceipt {
  return {
    commandId: overrides.commandId ?? `cmd-${randomUUID()}`,
    taskId: overrides.taskId ?? `task-${randomUUID()}`,
    stepId: overrides.stepId ?? "step-1",
    vpsId: overrides.vpsId ?? "vps-test",
    agentInstanceId: overrides.agentInstanceId ?? "agent-instance-alpha",
    planVersion: overrides.planVersion ?? 1,
    planDigest: overrides.planDigest ?? "sha256:d41d8cd98f00b204e9800998ecf8427e",
    payloadDigest: overrides.payloadDigest ?? "sha256:e3b0c44298fc1c149afbf4c8996fb924",
    status: overrides.status ?? "succeeded",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    result: overrides.result ?? { exitCode: 0, output: "active" },
    ...overrides,
  };
}

async function setupExecutingTaskWithConsumedPlan(
  repo: AiRepository,
  vpsId: string,
  options: {
    agentInstanceId?: string;
    planDigest?: string;
    planVersion?: number;
  } = {},
): Promise<{
  conversationId: string;
  task: AiTask;
  plan: AiPlan;
}> {
  const agentInstanceId = options.agentInstanceId ?? "agent-instance-alpha";
  const planDigest = options.planDigest ?? "sha256:d41d8cd98f00b204e9800998ecf8427e";
  const planVersion = options.planVersion ?? 1;

  const conv = await repo.createConversation(vpsId, `Conversation for ${vpsId}`);
  const { task: createdTask } = await repo.createTask({
    id: `task-${randomUUID()}`,
    conversationId: conv.id,
    vpsId,
    state: "planning",
    requestSummary: "Execute diagnostic run",
    idempotencyKey: `idem-${randomUUID()}`,
    initiatingSessionId: "session-init",
  });

  const plan = makePlan({
    taskId: createdTask.id,
    vpsId,
    planVersion,
    planDigest,
    agentInstanceId,
    status: "pending",
  });

  await repo.updateTask({
    id: createdTask.id,
    expectedRevision: 1,
    plan,
  });

  const consumedPlan = await repo.approve({
    taskId: createdTask.id,
    planVersion,
    planDigest,
    approvedSessionId: "session-approval-admin",
  });

  const executingTask = await repo.updateTask({
    id: createdTask.id,
    expectedRevision: 3,
    state: "executing",
    ownerLease: {
      ownerInstanceId: agentInstanceId,
      leaseSeconds: 300,
    },
  });

  return {
    conversationId: conv.id,
    task: executingTask,
    plan: consumedPlan,
  };
}

describe("createJsonAiRepository behavioral regressions", () => {
  let tempDir: string;
  let repoPath: string;
  let repo: AiRepository;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-persistence-test-"));
    repoPath = join(tempDir, "ai-state.json");
    repo = createJsonAiRepository(repoPath);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("concurrent admission on same VPS", () => {
    it("admits exactly one task when concurrent admission calls race for the same VPS", async () => {
      const vpsId = "vps-concurrency-race";
      const conv = await repo.createConversation(vpsId, "Concurrency Conv");

      const admissions: AiTaskCreateInput[] = Array.from({ length: 5 }, (_, i) => ({
        id: `task-candidate-${i}-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: `Candidate task ${i}`,
        idempotencyKey: `idem-key-unique-${i}`,
        initiatingSessionId: `session-${i}`,
      }));

      const settled = await Promise.allSettled(
        admissions.map((input) => repo.createTask(input)),
      );

      const fulfilled = settled.filter(
        (res): res is PromiseFulfilledResult<{ task: AiTask; replay: boolean }> =>
          res.status === "fulfilled",
      );
      const rejected = settled.filter(
        (res): res is PromiseRejectedResult => res.status === "rejected",
      );

      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]!.value.replay).toBe(false);

      expect(rejected).toHaveLength(4);
      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(AiPersistenceConflictError);
        expect((rej.reason as AiPersistenceConflictError).code).toBe("task_conflict");
      }

      const tasksOnVps = await repo.listTasks(vpsId);
      expect(tasksOnVps).toHaveLength(1);
      expect(tasksOnVps[0]!.id).toBe(fulfilled[0]!.value.task.id);

      const activeTask = await repo.getActiveTask(vpsId);
      expect(activeTask).toBeDefined();
      expect(activeTask?.id).toBe(fulfilled[0]!.value.task.id);
    });

    it("rejects sequential admission of a second active task on the same VPS while the first is active", async () => {
      const vpsId = "vps-sequential-active";
      const conv = await repo.createConversation(vpsId, "Sequential Conv");

      const task1Input: AiTaskCreateInput = {
        id: `task-1-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "First active task",
        idempotencyKey: "idem-seq-1",
        initiatingSessionId: "session-1",
      };

      const task2Input: AiTaskCreateInput = {
        id: `task-2-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "Conflicting second task",
        idempotencyKey: "idem-seq-2",
        initiatingSessionId: "session-2",
      };

      const firstAdmission = await repo.createTask(task1Input);
      expect(firstAdmission.replay).toBe(false);

      await expect(repo.createTask(task2Input)).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "task_conflict",
      });

      const tasks = await repo.listTasks(vpsId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe(task1Input.id);
    });

    it("permits concurrent admissions targeting distinct VPS instances simultaneously", async () => {
      const vpsA = "vps-distinct-a";
      const vpsB = "vps-distinct-b";

      const [convA, convB] = await Promise.all([
        repo.createConversation(vpsA, "Conv A"),
        repo.createConversation(vpsB, "Conv B"),
      ]);

      const [resA, resB] = await Promise.all([
        repo.createTask({
          id: `task-a-${randomUUID()}`,
          conversationId: convA.id,
          vpsId: vpsA,
          state: "planning",
          requestSummary: "Task for VPS A",
          idempotencyKey: "idem-a",
          initiatingSessionId: "session-a",
        }),
        repo.createTask({
          id: `task-b-${randomUUID()}`,
          conversationId: convB.id,
          vpsId: vpsB,
          state: "planning",
          requestSummary: "Task for VPS B",
          idempotencyKey: "idem-b",
          initiatingSessionId: "session-b",
        }),
      ]);

      expect(resA.replay).toBe(false);
      expect(resB.replay).toBe(false);

      const activeA = await repo.getActiveTask(vpsA);
      const activeB = await repo.getActiveTask(vpsB);

      expect(activeA?.id).toBe(resA.task.id);
      expect(activeB?.id).toBe(resB.task.id);
    });

    it("permits a new task to be admitted on the same VPS after the previous task transitions to a terminal state", async () => {
      const vpsId = "vps-terminal-transition";
      const conv = await repo.createConversation(vpsId, "Terminal Lifecycle Conv");

      const { task: task1 } = await repo.createTask({
        id: `task-1-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "Initial task that will finish",
        idempotencyKey: "idem-term-1",
        initiatingSessionId: "session-term-1",
      });

      await repo.updateTask({
        id: task1.id,
        expectedRevision: 1,
        state: "succeeded",
        summary: "Execution completed successfully",
      });

      const activeAfterTerminal = await repo.getActiveTask(vpsId);
      expect(activeAfterTerminal).toBeUndefined();

      const task2Input: AiTaskCreateInput = {
        id: `task-2-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "Subsequent task after terminal",
        idempotencyKey: "idem-term-2",
        initiatingSessionId: "session-term-2",
      };

      const secondAdmission = await repo.createTask(task2Input);
      expect(secondAdmission.replay).toBe(false);
      expect(secondAdmission.task.id).toBe(task2Input.id);

      const newActive = await repo.getActiveTask(vpsId);
      expect(newActive?.id).toBe(task2Input.id);
    });
  });

  describe("same idempotency returns same task", () => {
    it("returns identical existing task and flags replay=true when called with identical idempotencyKey on same VPS", async () => {
      const vpsId = "vps-idem-replay";
      const conv = await repo.createConversation(vpsId, "Idempotency Conv");

      const originalInput: AiTaskCreateInput = {
        id: `task-orig-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "First diagnostic request",
        idempotencyKey: "idem-shared-token-100",
        initiatingSessionId: "session-user-1",
        createdAt: "2026-03-01T10:00:00.000Z",
      };

      const { task: original, replay: firstReplay } = await repo.createTask(originalInput);
      expect(firstReplay).toBe(false);
      expect(original.id).toBe(originalInput.id);
      expect(original.requestSummary).toBe("First diagnostic request");
      expect(original.revision).toBe(1);

      const replayInput: AiTaskCreateInput = {
        id: `task-discarded-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "Different request summary on retry",
        idempotencyKey: "idem-shared-token-100",
        initiatingSessionId: "session-user-2",
      };

      const { task: replayed, replay: secondReplay } = await repo.createTask(replayInput);

      expect(secondReplay).toBe(true);
      expect(replayed.id).toBe(original.id);
      expect(replayed.requestSummary).toBe("First diagnostic request");
      expect(replayed.revision).toBe(original.revision);
      expect(replayed.createdAt).toBe(original.createdAt);

      const tasks = await repo.listTasks(vpsId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe(original.id);
    });

    it("returns current task state on idempotency replay after the task has advanced revisions", async () => {
      const vpsId = "vps-idem-revisions";
      const conv = await repo.createConversation(vpsId, "Idempotency Revisions Conv");

      const { task: original } = await repo.createTask({
        id: `task-prog-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "Task advancing state",
        idempotencyKey: "idem-prog-key",
        initiatingSessionId: "session-1",
      });

      const updated = await repo.updateTask({
        id: original.id,
        expectedRevision: 1,
        state: "awaiting_approval",
        summary: "Plan ready for operator review",
      });
      expect(updated.revision).toBe(2);

      const replayResult = await repo.createTask({
        id: `task-another-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "planning",
        requestSummary: "Retried submission after progression",
        idempotencyKey: "idem-prog-key",
        initiatingSessionId: "session-1",
      });

      expect(replayResult.replay).toBe(true);
      expect(replayResult.task.id).toBe(original.id);
      expect(replayResult.task.revision).toBe(2);
      expect(replayResult.task.state).toBe("awaiting_approval");
      expect(replayResult.task.summary).toBe("Plan ready for operator review");
    });

    it("scopes idempotencyKey to VPS so identical keys on distinct VPS instances produce independent tasks", async () => {
      const vpsA = "vps-scope-a";
      const vpsB = "vps-scope-b";

      const [convA, convB] = await Promise.all([
        repo.createConversation(vpsA, "Scope Conv A"),
        repo.createConversation(vpsB, "Scope Conv B"),
      ]);

      const sharedKey = "shared-cross-vps-idempotency-key";

      const resA = await repo.createTask({
        id: `task-scope-a-${randomUUID()}`,
        conversationId: convA.id,
        vpsId: vpsA,
        state: "planning",
        requestSummary: "Request on VPS A",
        idempotencyKey: sharedKey,
        initiatingSessionId: "session-a",
      });

      const resB = await repo.createTask({
        id: `task-scope-b-${randomUUID()}`,
        conversationId: convB.id,
        vpsId: vpsB,
        state: "planning",
        requestSummary: "Request on VPS B",
        idempotencyKey: sharedKey,
        initiatingSessionId: "session-b",
      });

      expect(resA.replay).toBe(false);
      expect(resB.replay).toBe(false);
      expect(resA.task.id).not.toBe(resB.task.id);
      expect(resA.task.vpsId).toBe(vpsA);
      expect(resB.task.vpsId).toBe(vpsB);
    });
  });

  describe("exact approval consumed once and wrong digest rejected", () => {
    it("rejects approval with approval_conflict when plan digest does not match stored plan", async () => {
      const vpsId = "vps-approval-digest";
      const conv = await repo.createConversation(vpsId, "Approval Digest Conv");

      const { task: createdTask } = await repo.createTask({
        id: `task-digest-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "awaiting_approval",
        requestSummary: "Approval digest mismatch check",
        idempotencyKey: "idem-digest-check",
        initiatingSessionId: "session-op",
      });

      const expectedDigest = "sha256:11112222333344445555666677778888";
      const plan = makePlan({
        taskId: createdTask.id,
        vpsId,
        planVersion: 1,
        planDigest: expectedDigest,
        status: "pending",
      });

      await repo.updateTask({
        id: createdTask.id,
        expectedRevision: 1,
        plan,
      });

      const wrongDigestInput: AiPlanApprovalInput = {
        taskId: createdTask.id,
        planVersion: 1,
        planDigest: "sha256:tampered9999999999999999999999",
        approvedSessionId: "session-approver",
      };

      await expect(repo.approve(wrongDigestInput)).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "approval_conflict",
      });

      const task = await repo.getTask(vpsId, createdTask.id);
      expect(task?.revision).toBe(2);
      expect(task?.plan?.status).toBe("pending");
      expect(task?.plan?.approvedSessionId).toBeUndefined();
    });

    it("rejects approval with approval_conflict when plan version does not match stored plan", async () => {
      const vpsId = "vps-approval-version";
      const conv = await repo.createConversation(vpsId, "Approval Version Conv");

      const { task: createdTask } = await repo.createTask({
        id: `task-ver-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "awaiting_approval",
        requestSummary: "Approval version mismatch check",
        idempotencyKey: "idem-ver-check",
        initiatingSessionId: "session-op",
      });

      const validDigest = "sha256:abcdefabcdefabcdefabcdefabcdefab";
      const plan = makePlan({
        taskId: createdTask.id,
        vpsId,
        planVersion: 1,
        planDigest: validDigest,
        status: "pending",
      });

      await repo.updateTask({
        id: createdTask.id,
        expectedRevision: 1,
        plan,
      });

      const wrongVersionInput: AiPlanApprovalInput = {
        taskId: createdTask.id,
        planVersion: 99,
        planDigest: validDigest,
        approvedSessionId: "session-approver",
      };

      await expect(repo.approve(wrongVersionInput)).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "approval_conflict",
      });
    });

    it("consumes exact approval once, setting plan status to consumed, recording session provenance, and bumping revision", async () => {
      const vpsId = "vps-approval-exact";
      const conv = await repo.createConversation(vpsId, "Approval Exact Conv");

      const { task: createdTask } = await repo.createTask({
        id: `task-exact-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "awaiting_approval",
        requestSummary: "Exact approval check",
        idempotencyKey: "idem-exact-approval",
        initiatingSessionId: "session-op",
      });

      const planDigest = "sha256:exactapprovaldigest1234567890abcdef";
      const plan = makePlan({
        taskId: createdTask.id,
        vpsId,
        planVersion: 1,
        planDigest,
        status: "pending",
      });

      await repo.updateTask({
        id: createdTask.id,
        expectedRevision: 1,
        plan,
      });

      const approvalInput: AiPlanApprovalInput = {
        taskId: createdTask.id,
        planVersion: 1,
        planDigest,
        approvedSessionId: "session-operator-42",
        now: "2026-03-01T12:00:00.000Z",
      };

      const approvedPlan = await repo.approve(approvalInput);

      expect(approvedPlan.status).toBe("consumed");
      expect(approvedPlan.approvedSessionId).toBe("session-operator-42");
      expect(approvedPlan.consumedAt).toBe("2026-03-01T12:00:00.000Z");
      expect(approvedPlan.approvedAt).toBe("2026-03-01T12:00:00.000Z");

      const task = await repo.getTask(vpsId, createdTask.id);
      expect(task).toBeDefined();
      expect(task?.revision).toBe(3);
      expect(task?.plan?.status).toBe("consumed");
      expect(task?.plan?.approvedSessionId).toBe("session-operator-42");
    });

    it("rejects second approval attempt on an already consumed plan, preventing duplicate consumption", async () => {
      const vpsId = "vps-approval-replay";
      const conv = await repo.createConversation(vpsId, "Approval Replay Conv");

      const { task: createdTask } = await repo.createTask({
        id: `task-replay-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "awaiting_approval",
        requestSummary: "Prevent double approval replay",
        idempotencyKey: "idem-double-approval",
        initiatingSessionId: "session-op",
      });

      const planDigest = "sha256:singleconsumptiondigest1122334455";
      const plan = makePlan({
        taskId: createdTask.id,
        vpsId,
        planVersion: 1,
        planDigest,
        status: "pending",
      });

      await repo.updateTask({
        id: createdTask.id,
        expectedRevision: 1,
        plan,
      });

      await repo.approve({
        taskId: createdTask.id,
        planVersion: 1,
        planDigest,
        approvedSessionId: "session-original-approver",
      });

      const replayApproval: AiPlanApprovalInput = {
        taskId: createdTask.id,
        planVersion: 1,
        planDigest,
        approvedSessionId: "session-duplicate-attacker",
      };

      await expect(repo.approve(replayApproval)).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "approval_conflict",
      });

      const task = await repo.getTask(vpsId, createdTask.id);
      expect(task?.plan?.status).toBe("consumed");
      expect(task?.plan?.approvedSessionId).toBe("session-original-approver");
    });
  });

  describe("claim wrong agent cannot rebind", () => {
    it("returns empty array and leaves outbox pending when an unauthorized agent attempts to claim commands", async () => {
      const vpsId = "vps-claim-isolation";
      const designatedAgent = "agent-designated-77";
      const intruderAgent = "agent-intruder-99";

      const { task, plan } = await setupExecutingTaskWithConsumedPlan(repo, vpsId, {
        agentInstanceId: designatedAgent,
      });

      const command = makeHostCommand({
        taskId: task.id,
        vpsId,
        agentInstanceId: designatedAgent,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      });

      const entry = makeOutboxEntry(command, {
        status: "pending",
        agentInstanceId: designatedAgent,
      });

      const expectSpec: AiOutboxCommandExpect = {
        taskId: task.id,
        taskIdRevision: task.revision,
        planDigest: plan.planDigest,
        commandId: entry.commandId,
      };

      await repo.enqueueCommands([{ entry, expect: expectSpec }]);

      const intruderClaim = await repo.claimCommands(intruderAgent, vpsId, 10);
      expect(intruderClaim).toEqual([]);

      const pendingAfterIntruder = await repo.replayPendingCommands(vpsId);
      expect(pendingAfterIntruder).toHaveLength(1);
      expect(pendingAfterIntruder[0]!.commandId).toBe(entry.commandId);
      expect(pendingAfterIntruder[0]!.status).toBe("pending");
      expect(pendingAfterIntruder[0]!.agentInstanceId).toBe(designatedAgent);
    });

    it("allows designated agent to claim command and transitions entry status to dispatched", async () => {
      const vpsId = "vps-claim-success";
      const designatedAgent = "agent-designated-alpha";

      const { task, plan } = await setupExecutingTaskWithConsumedPlan(repo, vpsId, {
        agentInstanceId: designatedAgent,
      });

      const command = makeHostCommand({
        taskId: task.id,
        vpsId,
        agentInstanceId: designatedAgent,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      });

      const entry = makeOutboxEntry(command, {
        status: "pending",
        agentInstanceId: designatedAgent,
      });

      await repo.enqueueCommands([
        {
          entry,
          expect: {
            taskId: task.id,
            taskIdRevision: task.revision,
            planDigest: plan.planDigest,
            commandId: entry.commandId,
          },
        },
      ]);

      const claimed = await repo.claimCommands(designatedAgent, vpsId, 10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.commandId).toBe(command.commandId);

      const pendingAfterClaim = await repo.replayPendingCommands(vpsId);
      expect(pendingAfterClaim).toHaveLength(0);
    });

    it("rejects acknowledgment from wrong agent and prevents agent rebinding", async () => {
      const vpsId = "vps-ack-isolation";
      const designatedAgent = "agent-designated-beta";
      const intruderAgent = "agent-intruder-beta";

      const { task, plan } = await setupExecutingTaskWithConsumedPlan(repo, vpsId, {
        agentInstanceId: designatedAgent,
      });

      const command = makeHostCommand({
        taskId: task.id,
        vpsId,
        agentInstanceId: designatedAgent,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      });

      const entry = makeOutboxEntry(command, {
        status: "pending",
        agentInstanceId: designatedAgent,
      });

      await repo.enqueueCommands([
        {
          entry,
          expect: {
            taskId: task.id,
            taskIdRevision: task.revision,
            planDigest: plan.planDigest,
            commandId: entry.commandId,
          },
        },
      ]);

      await repo.claimCommands(designatedAgent, vpsId, 10);

      const unauthorizedAck = await repo.markCommandAcknowledged(
        command.commandId,
        intruderAgent,
      );
      expect(unauthorizedAck).toBe(false);

      const authorizedAck = await repo.markCommandAcknowledged(
        command.commandId,
        designatedAgent,
      );
      expect(authorizedAck).toBe(true);

      const subsequentAck = await repo.markCommandAcknowledged(
        command.commandId,
        intruderAgent,
      );
      expect(subsequentAck).toBe(false);
    });
  });

  describe("expired command not dispatched", () => {
    it("does not dispatch a command whose deadline has expired prior to claim", async () => {
      const vpsId = "vps-expired-cmd";
      const agentInstanceId = "agent-instance-alpha";

      const { task, plan } = await setupExecutingTaskWithConsumedPlan(repo, vpsId, {
        agentInstanceId,
      });

      const pastDeadline = "2025-01-01T00:00:00.000Z";
      const command = makeHostCommand({
        taskId: task.id,
        vpsId,
        agentInstanceId,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
        deadlineAt: pastDeadline,
      });

      const entry = makeOutboxEntry(command, {
        status: "pending",
        agentInstanceId,
      });

      await repo.enqueueCommands([
        {
          entry,
          expect: {
            taskId: task.id,
            taskIdRevision: task.revision,
            planDigest: plan.planDigest,
            commandId: entry.commandId,
          },
        },
      ]);

      const claimed = await repo.claimCommands(agentInstanceId, vpsId, 10);
      expect(claimed).toEqual([]);

      const pending = await repo.replayPendingCommands(vpsId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.commandId).toBe(command.commandId);
      expect(pending[0]!.status).toBe("pending");
      expect(pending[0]!.dispatchedAt).toBeUndefined();
    });

    it("dispatches active non-expired command while skipping expired command in the same queue", async () => {
      const vpsId = "vps-mixed-expiry";
      const agentInstanceId = "agent-instance-alpha";

      const { task, plan } = await setupExecutingTaskWithConsumedPlan(repo, vpsId, {
        agentInstanceId,
      });

      const expiredCommand = makeHostCommand({
        commandId: `cmd-expired-${randomUUID()}`,
        taskId: task.id,
        stepId: "step-1",
        vpsId,
        agentInstanceId,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
        deadlineAt: "2025-01-01T00:00:00.000Z",
      });

      const validCommand = makeHostCommand({
        commandId: `cmd-valid-${randomUUID()}`,
        taskId: task.id,
        stepId: "step-2",
        vpsId,
        agentInstanceId,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
        deadlineAt: new Date(Date.now() + 180_000).toISOString(),
      });

      const entryExpired = makeOutboxEntry(expiredCommand, {
        createdAt: "2025-01-01T00:00:00.000Z",
      });
      const entryValid = makeOutboxEntry(validCommand, {
        createdAt: new Date().toISOString(),
      });

      await repo.enqueueCommands([
        {
          entry: entryExpired,
          expect: {
            taskId: task.id,
            taskIdRevision: task.revision,
            planDigest: plan.planDigest,
            commandId: entryExpired.commandId,
          },
        },
        {
          entry: entryValid,
          expect: {
            taskId: task.id,
            taskIdRevision: task.revision,
            planDigest: plan.planDigest,
            commandId: entryValid.commandId,
          },
        },
      ]);

      const claimed = await repo.claimCommands(agentInstanceId, vpsId, 10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.commandId).toBe(validCommand.commandId);

      const pendingAfterClaim = await repo.replayPendingCommands(vpsId);
      expect(pendingAfterClaim).toHaveLength(1);
      expect(pendingAfterClaim[0]!.commandId).toBe(expiredCommand.commandId);
      expect(pendingAfterClaim[0]!.status).toBe("pending");
    });
  });

  describe("duplicate/conflicting receipts invariant and active/uncertain deletion retention", () => {
    it("enforces receipt idempotency by commandId, ignoring exact duplicate submissions even with differing transport timestamps", async () => {
      const taskId = `task-receipts-${randomUUID()}`;
      const commandId = `cmd-receipt-idempotent-${randomUUID()}`;

      const receipt = makeReceipt({
        commandId,
        taskId,
        status: "succeeded",
        payloadDigest: "sha256:payload-digest-1234",
        result: { exitCode: 0, output: "service is running" },
        createdAt: "2025-01-01T12:00:00.000Z",
      });

      const firstRecord = await repo.recordReceipts([receipt]);
      expect(firstRecord).toEqual({ created: 1 });

      const retryReceiptWithNewTimestamp = {
        ...receipt,
        createdAt: "2025-01-01T12:05:00.000Z",
      };

      const duplicateRecord = await repo.recordReceipts([retryReceiptWithNewTimestamp]);
      expect(duplicateRecord).toEqual({ created: 0 });

      const receipts = await repo.listReceiptsByTask(taskId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.commandId).toBe(commandId);
      expect(receipts[0]!.status).toBe("succeeded");
      expect(receipts[0]!.payloadDigest).toBe("sha256:payload-digest-1234");
    });
    it("enforces receipt idempotency when duplicate retry has reordered result object keys", async () => {
      const taskId = `task-reordered-keys-${randomUUID()}`;
      const commandId = `cmd-receipt-reordered-${randomUUID()}`;

      const initialReceipt = makeReceipt({
        commandId,
        taskId,
        status: "succeeded",
        payloadDigest: "sha256:reordered-digest-1",
        result: { exitCode: 0, stdout: "ready", healthy: true, details: { port: 8080, host: "localhost" } },
        createdAt: "2025-01-01T12:00:00.000Z",
      });

      const firstRecord = await repo.recordReceipts([initialReceipt]);
      expect(firstRecord).toEqual({ created: 1 });

      const reorderedRetryReceipt = {
        ...initialReceipt,
        result: { details: { host: "localhost", port: 8080 }, healthy: true, stdout: "ready", exitCode: 0 },
        createdAt: "2025-01-01T12:01:00.000Z",
      };

      const duplicateRecord = await repo.recordReceipts([reorderedRetryReceipt]);
      expect(duplicateRecord).toEqual({ created: 0 });

      const receipts = await repo.listReceiptsByTask(taskId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.commandId).toBe(commandId);
      expect(receipts[0]!.status).toBe("succeeded");
    });

    it("rejects conflicting receipts with receipt_conflict and preserves original stored receipt", async () => {
      const taskId = `task-conflict-receipt-${randomUUID()}`;
      const commandId = `cmd-receipt-conflict-${randomUUID()}`;

      const originalReceipt = makeReceipt({
        commandId,
        taskId,
        status: "succeeded",
        payloadDigest: "sha256:originaldigest1111",
        result: { exitCode: 0, output: "verified ok" },
      });

      const conflictingReceipt = makeReceipt({
        commandId,
        taskId,
        status: "failed",
        payloadDigest: "sha256:tamperedpayload2222",
        error: { code: "EXEC_FAIL", message: "unexpected failure" },
      });

      const firstRecord = await repo.recordReceipts([originalReceipt]);
      expect(firstRecord.created).toBe(1);

      await expect(
        repo.recordReceipts([conflictingReceipt]),
      ).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "receipt_conflict",
      });

      const storedReceipts = await repo.listReceiptsByTask(taskId);
      expect(storedReceipts).toHaveLength(1);
      expect(storedReceipts[0]!.status).toBe("succeeded");
      expect(storedReceipts[0]!.payloadDigest).toBe("sha256:originaldigest1111");
      expect(storedReceipts[0]!.error).toBeUndefined();
    });

    it("rejects conflicting receipts within the same batch with receipt_conflict", async () => {
      const taskId = `task-conflict-batch-${randomUUID()}`;
      const commandId = `cmd-receipt-conflict-batch-${randomUUID()}`;

      const receiptA = makeReceipt({
        commandId,
        taskId,
        status: "succeeded",
        payloadDigest: "sha256:digest-aaa",
        result: { exitCode: 0 },
      });

      const receiptB = makeReceipt({
        commandId,
        taskId,
        status: "failed",
        payloadDigest: "sha256:digest-bbb",
        error: { code: "EXEC_ERR", message: "command crashed" },
      });

      await expect(
        repo.recordReceipts([receiptA, receiptB]),
      ).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "receipt_conflict",
      });

      const storedReceipts = await repo.listReceiptsByTask(taskId);
      expect(storedReceipts).toHaveLength(0);
    });

    it("rejects enqueueing commands with duplicate commandIds in the same batch or matching existing outbox entries", async () => {
      const vpsId = "vps-enqueue-invariants";
      const { task, plan } = await setupExecutingTaskWithConsumedPlan(repo, vpsId);

      const duplicateCommandId = `cmd-duplicate-${randomUUID()}`;

      const commandA = makeHostCommand({
        commandId: duplicateCommandId,
        taskId: task.id,
        vpsId,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
      });

      const commandB = makeHostCommand({
        commandId: duplicateCommandId,
        taskId: task.id,
        vpsId,
        planVersion: plan.planVersion,
        planDigest: plan.planDigest,
      });

      const entryA = makeOutboxEntry(commandA);
      const entryB = makeOutboxEntry(commandB);

      await expect(
        repo.enqueueCommands([
          {
            entry: entryA,
            expect: {
              taskId: task.id,
              taskIdRevision: task.revision,
              planDigest: plan.planDigest,
              commandId: entryA.commandId,
            },
          },
          {
            entry: entryB,
            expect: {
              taskId: task.id,
              taskIdRevision: task.revision,
              planDigest: plan.planDigest,
              commandId: entryB.commandId,
            },
          },
        ]),
      ).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "receipt_conflict",
      });

      await repo.enqueueCommands([
        {
          entry: entryA,
          expect: {
            taskId: task.id,
            taskIdRevision: task.revision,
            planDigest: plan.planDigest,
            commandId: entryA.commandId,
          },
        },
      ]);

      const freshEntryWithExistingCommandId = makeOutboxEntry(commandA);

      await expect(
        repo.enqueueCommands([
          {
            entry: freshEntryWithExistingCommandId,
            expect: {
              taskId: task.id,
              taskIdRevision: task.revision,
              planDigest: plan.planDigest,
              commandId: freshEntryWithExistingCommandId.commandId,
            },
          },
        ]),
      ).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "stale_dispatch",
      });
    });

    it("retains active and uncertain tasks during retention cleanup, deleting only terminal tasks older than cutoff", async () => {
      const cutoff = "2025-06-01T00:00:00.000Z";
      const pastTime = "2025-01-01T00:00:00.000Z";
      const recentTime = "2025-07-01T00:00:00.000Z";

      type FixtureSpec = {
        vpsId: string;
        taskId: string;
        state: AiTaskState;
        createdAt: string;
        expectDeleted: boolean;
      };

      const taskSpecs: FixtureSpec[] = [
        {
          vpsId: "vps-ret-succ-old",
          taskId: "task-succ-old",
          state: "succeeded",
          createdAt: pastTime,
          expectDeleted: true,
        },
        {
          vpsId: "vps-ret-fail-old",
          taskId: "task-fail-old",
          state: "failed",
          createdAt: pastTime,
          expectDeleted: true,
        },
        {
          vpsId: "vps-ret-canc-old",
          taskId: "task-canc-old",
          state: "cancelled",
          createdAt: pastTime,
          expectDeleted: true,
        },
        {
          vpsId: "vps-ret-exp-old",
          taskId: "task-exp-old",
          state: "expired",
          createdAt: pastTime,
          expectDeleted: true,
        },
        {
          vpsId: "vps-ret-succ-recent",
          taskId: "task-succ-recent",
          state: "succeeded",
          createdAt: recentTime,
          expectDeleted: false,
        },
        {
          vpsId: "vps-ret-plan-old",
          taskId: "task-plan-old",
          state: "planning",
          createdAt: pastTime,
          expectDeleted: false,
        },
        {
          vpsId: "vps-ret-exec-old",
          taskId: "task-exec-old",
          state: "executing",
          createdAt: pastTime,
          expectDeleted: false,
        },
        {
          vpsId: "vps-ret-appr-old",
          taskId: "task-appr-old",
          state: "awaiting_approval",
          createdAt: pastTime,
          expectDeleted: false,
        },
        {
          vpsId: "vps-ret-unc-old",
          taskId: "task-unc-old",
          state: "uncertain",
          createdAt: pastTime,
          expectDeleted: false,
        },
      ];

      for (const spec of taskSpecs) {
        const conv = await repo.createConversation(
          spec.vpsId,
          `Retention Conv ${spec.vpsId}`,
        );
        await repo.createTask({
          id: spec.taskId,
          conversationId: conv.id,
          vpsId: spec.vpsId,
          state: spec.state,
          requestSummary: `Retention check task ${spec.taskId}`,
          idempotencyKey: `idem-ret-${spec.taskId}`,
          initiatingSessionId: "session-retention",
          createdAt: spec.createdAt,
        });
      }

      const deletedCount = await repo.deleteTerminalTasksOlderThan(cutoff);
      expect(deletedCount).toBe(4);

      for (const spec of taskSpecs) {
        const fetched = await repo.getTask(spec.vpsId, spec.taskId);
        if (spec.expectDeleted) {
          expect(fetched).toBeUndefined();
        } else {
          expect(fetched).toBeDefined();
          expect(fetched?.id).toBe(spec.taskId);
          expect(fetched?.state).toBe(spec.state);
        }
      }

      const uncertainTask = await repo.getTask("vps-ret-unc-old", "task-unc-old");
      expect(uncertainTask).toBeDefined();
      expect(uncertainTask?.state).toBe("uncertain");
    });

    it("retains terminal tasks that match keepStates even when older than cutoff", async () => {
      const cutoff = "2025-06-01T00:00:00.000Z";
      const pastTime = "2025-01-01T00:00:00.000Z";

      const vpsFailed = "vps-keep-failed";
      const vpsSucceeded = "vps-keep-succeeded";

      const convFailed = await repo.createConversation(vpsFailed, "Keep Failed Conv");
      const convSucceeded = await repo.createConversation(vpsSucceeded, "Keep Succeeded Conv");

      await repo.createTask({
        id: "task-keep-failed",
        conversationId: convFailed.id,
        vpsId: vpsFailed,
        state: "failed",
        requestSummary: "Failed task to retain",
        idempotencyKey: "idem-keep-failed",
        initiatingSessionId: "session-keep",
        createdAt: pastTime,
      });

      await repo.createTask({
        id: "task-delete-succeeded",
        conversationId: convSucceeded.id,
        vpsId: vpsSucceeded,
        state: "succeeded",
        requestSummary: "Succeeded task to delete",
        idempotencyKey: "idem-delete-succeeded",
        initiatingSessionId: "session-keep",
        createdAt: pastTime,
      });

      const deletedCount = await repo.deleteTerminalTasksOlderThan(cutoff, ["failed"]);
      expect(deletedCount).toBe(1);

      const failedTask = await repo.getTask(vpsFailed, "task-keep-failed");
      expect(failedTask).toBeDefined();
      expect(failedTask?.state).toBe("failed");

      const succeededTask = await repo.getTask(vpsSucceeded, "task-delete-succeeded");
      expect(succeededTask).toBeUndefined();
    });

    it("prevents deleting a conversation that contains unresolved active or uncertain tasks", async () => {
      const vpsId = "vps-conv-retention-guard";
      const conv = await repo.createConversation(vpsId, "Guarded Conversation");

      const { task } = await repo.createTask({
        id: `task-guard-${randomUUID()}`,
        conversationId: conv.id,
        vpsId,
        state: "uncertain",
        requestSummary: "Task with uncertain execution state",
        idempotencyKey: "idem-guard-conv",
        initiatingSessionId: "session-guard",
      });

      await expect(repo.deleteConversation(vpsId, conv.id)).rejects.toMatchObject({
        name: "AiPersistenceConflictError",
        code: "conversation_conflict",
      });

      await repo.updateTask({
        id: task.id,
        expectedRevision: 1,
        state: "failed",
        summary: "Resolved after operator intervention",
      });

      const deleted = await repo.deleteConversation(vpsId, conv.id);
      expect(deleted).toBe(true);

      const convAfter = await repo.getConversation(vpsId, conv.id);
      expect(convAfter).toBeUndefined();
    });
  });

  describe("key administration and rotation regressions", () => {
    let adminBaseDir: string;
    let adminDataDir: string;
    let adminPrivateDir: string;
    let adminKeyringFile: string;
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
      savedEnv = { ...process.env };
      adminBaseDir = await mkdtemp(join(tmpdir(), "ai-admin-regressions-"));
      adminDataDir = join(adminBaseDir, "data");
      adminPrivateDir = join(adminBaseDir, "private");
      adminKeyringFile = join(adminBaseDir, "keyring.json");
      await mkdir(adminDataDir, { recursive: true });
      await mkdir(adminPrivateDir, { recursive: true });

      process.env.DASHBOARD_SESSION_SECRET = "0123456789012345678901234567890123456789";
      process.env.DATA_DIR = adminDataDir;
      process.env.PRIVATE_DIR = adminPrivateDir;
      process.env.STORAGE_DRIVER = "json";
      process.env.AI_KEYRING_FILE = adminKeyringFile;
    });

    afterEach(async () => {
      process.env = savedEnv;
      await rm(adminBaseDir, { recursive: true, force: true });
    });

    it("refuses key administration and rotation when active or uncertain tasks exist", async () => {
      await manageAiKeysFromCli(["init"]);

      const aiJsonPath = join(adminDataDir, "ai.json");
      const adminRepo = createJsonAiRepository(aiJsonPath);
      const conv = await adminRepo.createConversation("vps-admin", "Admin Guard");

      const activeTask = await adminRepo.createTask({
        id: `task-uncertain-${randomUUID()}`,
        conversationId: conv.id,
        vpsId: "vps-admin",
        state: "uncertain",
        requestSummary: "Uncertain task guarding key rotation",
        idempotencyKey: "idem-uncertain-admin",
        initiatingSessionId: "session-admin",
      });

      await expect(manageAiKeysFromCli(["rotate"])).rejects.toThrow(
        "AI key administration refused: resolve active or uncertain tasks before retrying.",
      );

      // Transition to terminal failed state allows key administration
      await adminRepo.updateTask({
        id: activeTask.task.id,
        expectedRevision: 1,
        state: "failed",
        summary: "Resolved",
      });

      await expect(manageAiKeysFromCli(["rotate"])).resolves.toBeUndefined();
    });

    it("rewraps encrypted settings and execution blobs, retaining prior KEK and preserving decryption", async () => {
      await manageAiKeysFromCli(["init"]);

      const keyringInitial: Keyring = JSON.parse(await readFile(adminKeyringFile, "utf8")) as Keyring;
      const initialKekId = keyringInitial.activeKekId;
      expect(initialKekId).toBeTruthy();

      const aiJsonPath = join(adminDataDir, "ai.json");
      const adminRepo = createJsonAiRepository(aiJsonPath);
      const loadedKeyring1 = await loadAiKeyring(adminKeyringFile);

      const secretApiKey = "sk-admin-test-secret-key-12345";
      const encryptedApiKey = encryptAiSecret(
        secretApiKey,
        { vpsId: "global", taskId: "provider", field: "providerApiKey", version: 1 },
        loadedKeyring1,
      );
      await adminRepo.updateSettings({
        patch: { endpoint: "https://api.example.com", model: "model-admin" },
        apiKeyEnvelope: encryptedApiKey,
      });

      const conv = await adminRepo.createConversation("vps-admin", "Admin Conv");
      const terminalTask = await adminRepo.createTask({
        id: `task-terminal-${randomUUID()}`,
        conversationId: conv.id,
        vpsId: "vps-admin",
        state: "succeeded",
        requestSummary: "Terminal task with execution blob",
        idempotencyKey: "idem-terminal-admin",
        initiatingSessionId: "session-admin",
      });

      const secretPayload = JSON.stringify({ script: "echo admin pass", exitCode: 0 });
      const encryptedPayload = encryptAiSecret(
        secretPayload,
        { vpsId: "vps-admin", taskId: terminalTask.task.id, field: "executionPayload", version: 1 },
        loadedKeyring1,
      );
      const blobId = `blob-${randomUUID()}`;
      await adminRepo.saveExecutionBlob({
        id: blobId,
        taskId: terminalTask.task.id,
        stepId: "step-admin",
        encryptedPayload,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        createdAt: new Date().toISOString(),
      });

      // Rotate keyring and rewrap stored envelopes
      await manageAiKeysFromCli(["rotate"]);

      const keyringRotated: Keyring = JSON.parse(await readFile(adminKeyringFile, "utf8")) as Keyring;
      const newKekId = keyringRotated.activeKekId;
      expect(newKekId).not.toBe(initialKekId);
      expect(keyringRotated.keys[initialKekId]).toBeDefined();

      const loadedKeyring2 = await loadAiKeyring(adminKeyringFile);

      // Verify settings rewrapped and decryptable
      const updatedSettings = await adminRepo.getSettings();
      expect(updatedSettings?.encryptedApiKey?.kekId).toBe(newKekId);
      const decryptedApiKey = decryptAiSecret(
        updatedSettings!.encryptedApiKey!,
        { vpsId: "global", taskId: "provider", field: "providerApiKey", version: 1 },
        loadedKeyring2,
      );
      expect(decryptedApiKey).toBe(secretApiKey);

      // Verify blob rewrapped and decryptable
      const updatedBlob = await adminRepo.getExecutionBlob(blobId);
      expect(updatedBlob?.encryptedPayload.kekId).toBe(newKekId);
      const decryptedBlob = decryptAiSecret(
        updatedBlob!.encryptedPayload,
        { vpsId: "vps-admin", taskId: terminalTask.task.id, field: "executionPayload", version: 1 },
        loadedKeyring2,
      );
      expect(decryptedBlob).toBe(secretPayload);
    });
  });
});
