import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiAgentService } from "../src/ai/ai-agent.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { AiRetentionService } from "../src/ai/ai-retention.service.js";
import type { AiPlan, AiPlanStep, AiTask } from "../src/ai/ai.models.js";
import {
  createTestKeyring,
  saveKeyringToFile,
  type Keyring,
} from "../src/ssh/key-encryption.js";

const now = "2026-01-01T00:00:00.000Z";
const requestSession = "recovery-session";

describe("AI agent loop recovery and cancellation boundaries", () => {
  let dir: string;
  let repo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let retention: AiRetentionService;
  let agent: AiAgentService;
  let config: AppConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-loop-recovery-"));
    const keyring: Keyring = createTestKeyring("kek_recovery_tests");
    await saveKeyringToFile(join(dir, "ai-keyring.json"), keyring);
    repo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    vpsId = (await vpsRepo.create({
      name: "Recovery VPS",
      host: "127.0.0.1",
      port: 22,
      username: "root",
    })).id;
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "recovery-session-secret-at-least-32-chars",
    });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true, keyringFile: join(dir, "ai-keyring.json") } };
    const sessions = {
      authenticateById: async (id: string) => id === requestSession ? { id } : null,
    };
    const policy = new AiPolicyService(config, repo);
    agent = new AiAgentService(
      repo,
      config,
      sessions as never,
      { getAuthoritativeLatest: async () => null } as never,
      policy,
    );
    retention = new AiRetentionService(config, repo, vpsRepo, sessions as never);
  });

  afterEach(async () => {
    await retention.onApplicationShutdown();
    await rm(dir, { recursive: true, force: true });
  });

  async function createLoopTask(state: AiTask["state"] = "planning"): Promise<AiTask> {
    const conversation = await repo.createConversation(vpsId, "Recovery conversation");
    return (await repo.createTask({
      id: randomUUID(),
      conversationId: conversation.id,
      vpsId,
      state,
      requestSummary: "Recover a multi-turn task",
      idempotencyKey: randomUUID(),
      initiatingSessionId: requestSession,
      executionVersion: 2,
      executionMode: "manual",
      loop: { mode: "manual" },
    })).task;
  }

  function step(stepId: string, tool = "docker_action"): AiPlanStep {
    return {
      stepId,
      tool,
      version: 1,
      args: { action: "restart", target: { containerKey: "app-service" } },
      resourceKeys: ["docker:app-service"],
      inputDigests: {},
      description: `Execute ${tool}`,
      timeoutSeconds: 30,
    };
  }

  function plan(task: AiTask, version: number, status: AiPlan["status"] = "pending"): AiPlan {
    const commandStep = step(`step-${version}`);
    return {
      planId: `plan-${version}`,
      planVersion: version,
      taskId: task.id,
      vpsId,
      providerRevision: 1,
      policyRevision: 1,
      capabilityRevision: 1,
      execMode: "sandbox",
      steps: [commandStep],
      preconditions: [],
      planDigest: `sha256:recovery-plan-${version}-digest`,
      expiresAt: "2026-01-02T00:00:00.000Z",
      status,
    };
  }

  function receipt(task: AiTask, p: AiPlan, status: "succeeded" | "cancelled" = "succeeded") {
    return {
      commandId: `command-${p.planVersion}`,
      taskId: task.id,
      stepId: p.steps[0]!.stepId,
      vpsId,
      agentInstanceId: "agent-recovery",
      planVersion: p.planVersion,
      planDigest: p.planDigest,
      payloadDigest: "",
      status,
      result: { executed: status === "succeeded", exitCode: status === "succeeded" ? 0 : 130 },
      createdAt: now,
    } as const;
  }

  it("reloads planning state with an expired turn lease and makes it recoverable", async () => {
    const task = await createLoopTask();
    const claimed = await repo.claimTurn({
      taskId: task.id, vpsId, expectedTurn: 0, expectedLeaseToken: task.loop!.leaseToken,
      ownerInstanceId: "dead-worker", leaseSeconds: 1, now,
    });
    const expired = await repo.updateTask({
      id: claimed.id, expectedRevision: claimed.revision, state: "planning",
      loopPatch: { continuationReady: false },
      now: "2025-12-31T23:59:59.000Z",
    });
    // A fresh repository instance is the restart boundary; retention is the startup recovery seam.
    const reloaded = createJsonAiRepository(join(dir, "ai.json"));
    const reloadedTask = await reloaded.getTask(vpsId, expired.id);
    expect(reloadedTask?.loop?.continuationReady).toBe(false);
    const freshRetention = new AiRetentionService(config, reloaded, vpsRepo, {
      authenticateById: async () => ({ id: requestSession }),
    } as never);
    await freshRetention.runOnce();
    const recovered = await reloaded.getTask(vpsId, task.id);
    expect(recovered?.state).toBe("planning");
    expect(recovered?.loop?.continuationReady).toBe(true);
    await freshRetention.onApplicationShutdown();
  });

  it("preserves a committed pending plan across reload and never blindly dispatches it", async () => {
    const task = await createLoopTask();
    const p = plan(task, 1);
    const claimed = await repo.claimTurn({
      taskId: task.id, vpsId, expectedTurn: 0, expectedLeaseToken: task.loop!.leaseToken,
      ownerInstanceId: "worker-a", leaseSeconds: 60,
    });
    const committed = await repo.releaseOrCommitTurn({
      taskId: task.id, vpsId, expectedRevision: claimed.revision,
      expectedLeaseToken: claimed.loop!.leaseToken, ownerInstanceId: "worker-a",
      plan: p, loopPatch: { appendPlan: p, continuationReady: false, phase: "awaiting_approval" },
      state: "awaiting_approval", releaseTurnLease: true,
    });
    const reloaded = createJsonAiRepository(join(dir, "ai.json"));
    const persisted = await reloaded.getTask(vpsId, task.id);
    expect(persisted?.plan?.planDigest).toBe(p.planDigest);
    expect(persisted?.plan?.status).toBe("pending");
    expect(await reloaded.replayPendingCommands(vpsId)).toHaveLength(0);
    expect((await reloaded.getTask(vpsId, task.id))?.state).toBe(committed.state);
  });

  it("recovers after receipt commit and claims the continuation exactly once", async () => {
    const task = await createLoopTask();
    const p = plan(task, 1, "approved");
    const claimed = await repo.claimTurn({
      taskId: task.id, vpsId, expectedTurn: 0, expectedLeaseToken: task.loop!.leaseToken,
      ownerInstanceId: "worker-a", leaseSeconds: 60,
    });
    const leased = await repo.updateTask({
      id: task.id, expectedRevision: claimed.revision, ownerLease: { ownerInstanceId: "worker-a", leaseSeconds: 60 },
    });
    const executing = await repo.releaseOrCommitTurn({
      taskId: task.id, vpsId, expectedRevision: leased.revision,
      expectedLeaseToken: leased.loop!.leaseToken, ownerInstanceId: "worker-a", plan: p,
      loopPatch: { appendPlan: p, phase: "executing" }, state: "executing", nextTurnLeaseSeconds: 1,
    });
    const outbox = {
      id: randomUUID(), taskId: task.id, stepId: p.steps[0]!.stepId, commandId: "command-1", vpsId,
      agentInstanceId: "agent-recovery", command: {
        version: 1, commandId: "command-1", taskId: task.id, stepId: p.steps[0]!.stepId, vpsId,
        agentInstanceId: "agent-recovery", planVersion: 1, planDigest: p.planDigest,
        policyRevision: 1, deadlineAt: "2027-01-02T00:00:00.000Z", kind: "service_action", payload: p.steps[0]!.args,
      }, status: "pending" as const, createdAt: now,
    };
    await repo.enqueueCommands([{ entry: outbox, expect: { taskId: task.id, taskIdRevision: executing.revision, planDigest: p.planDigest } }]);
    await repo.recordReceipts([receipt(executing, p)]);
    const afterReceipt = await repo.getTask(vpsId, task.id);
    expect((await repo.listReceiptsByTask(task.id))).toHaveLength(1);
    expect(afterReceipt?.state).toBe("executing");
    const continuation = await repo.recordObservation({
      taskId: task.id, vpsId, expectedRevision: afterReceipt!.revision,
      observation: { id: "receipt-observation", turn: 1, tool: "host_command", source: "host_receipt", commandId: "command-1", stepId: p.steps[0]!.stepId, planVersion: 1, planDigest: p.planDigest, status: "succeeded", createdAt: now },
      continuationReady: true, state: "verifying",
    });
    const recovery = await repo.claimPendingContinuation({ taskId: task.id, vpsId, ownerInstanceId: "restart-worker", leaseSeconds: 60, now: new Date(Date.now() + 2000).toISOString() });
    expect(recovery?.loop?.continuationReady).toBe(false);
    expect(recovery?.loop?.turn).toBe(2);
    expect(await repo.claimPendingContinuation({ taskId: task.id, vpsId, ownerInstanceId: "second-worker", leaseSeconds: 60 })).toBeUndefined();
  });

  it("does not let duplicate or late receipts consume a newer plan", async () => {
    const task = await createLoopTask();
    const oldPlan = plan(task, 1, "approved");
    const newerPlan = plan(task, 2, "pending");
    const claimed = await repo.claimTurn({
      taskId: task.id, vpsId, expectedTurn: 0, expectedLeaseToken: task.loop!.leaseToken,
      ownerInstanceId: "worker-a", leaseSeconds: 60,
    });
    const leased = await repo.updateTask({
      id: task.id, expectedRevision: claimed.revision, ownerLease: { ownerInstanceId: "worker-a", leaseSeconds: 60 },
    });
    const executing = await repo.releaseOrCommitTurn({
      taskId: task.id, vpsId, expectedRevision: leased.revision,
      expectedLeaseToken: leased.loop!.leaseToken, ownerInstanceId: "worker-a", plan: oldPlan,
      loopPatch: { appendPlan: oldPlan, phase: "executing" }, state: "executing", nextTurnLeaseSeconds: 60,
    });
    await repo.recordReceipts([receipt(executing, oldPlan)]);
    const staged = await repo.updateTask({ id: task.id, expectedRevision: executing.revision, state: "planning", plan: newerPlan });
    const duplicate = await repo.recordReceipts([receipt(staged, oldPlan)]);
    expect(duplicate.created).toBe(0);
    const current = await repo.getTask(vpsId, task.id);
    expect(current?.plan?.planVersion).toBe(2);
    expect(current?.plan?.status).toBe("pending");
    expect((await repo.listReceiptsByTask(task.id)).map(r => r.planVersion)).toEqual([1]);
  });

  it("retains a receipt when cancel races dispatch and blocks continuation", async () => {
    const task = await createLoopTask();
    const p = plan(task, 1, "approved");
    const claimed = await repo.claimTurn({
      taskId: task.id, vpsId, expectedTurn: 0, expectedLeaseToken: task.loop!.leaseToken,
      ownerInstanceId: "worker-a", leaseSeconds: 60,
    });
    const leased = await repo.updateTask({
      id: task.id, expectedRevision: claimed.revision, ownerLease: { ownerInstanceId: "worker-a", leaseSeconds: 60 },
    });
    const executing = await repo.releaseOrCommitTurn({
      taskId: task.id, vpsId, expectedRevision: leased.revision,
      expectedLeaseToken: leased.loop!.leaseToken, ownerInstanceId: "worker-a", plan: p,
      loopPatch: { appendPlan: p, phase: "executing" }, state: "executing", nextTurnLeaseSeconds: 60,
    });
    const consumed = await repo.updateTask({
      id: task.id, expectedRevision: executing.revision, plan: { ...p, status: "consumed", consumedAt: now },
    });
    const outbox = {
      id: randomUUID(), taskId: task.id, stepId: p.steps[0]!.stepId, commandId: "command-1", vpsId,
      agentInstanceId: "agent-recovery", command: {
        version: 1, commandId: "command-1", taskId: task.id, stepId: p.steps[0]!.stepId, vpsId,
        agentInstanceId: "agent-recovery", planVersion: 1, planDigest: p.planDigest,
        policyRevision: 1, deadlineAt: "2027-01-02T00:00:00.000Z", kind: "service_action", payload: p.steps[0]!.args,
      }, status: "pending" as const, createdAt: now,
    };
    await repo.enqueueCommands([{ entry: outbox, expect: { taskId: task.id, taskIdRevision: consumed.revision, planDigest: p.planDigest } }]);
    expect(await repo.markCommandDispatched("command-1", now)).toBe(true);
    const cancelRequested = await repo.updateTask({ id: task.id, expectedRevision: consumed.revision, state: "cancel_requested" });
    const receiptResult = await agent.result(vpsId, {
      version: 1, agentInstanceId: "agent-recovery", taskId: task.id, stepId: p.steps[0]!.stepId,
      commandId: "command-1", planVersion: 1, planDigest: p.planDigest, status: "succeeded", executed: true,
      payload: { executed: true },
    });
    expect(receiptResult.ok).toBe(true);
    const settled = await repo.getTask(vpsId, task.id);
    expect(await repo.listReceiptsByTask(task.id)).toHaveLength(1);
    expect(settled?.state).toBe("cancelled");
    expect(await repo.claimPendingContinuation({ taskId: task.id, vpsId, ownerInstanceId: "restart-worker", leaseSeconds: 60 })).toBeUndefined();
    expect(cancelRequested.state).toBe("cancel_requested");
  });
});
