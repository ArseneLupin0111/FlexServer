import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { AiAgentService } from "../src/ai/ai-agent.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import type {
  AiHostCommand,
  AiHostHeartbeatRequest,
  AiHostOutputRequest,
  AiHostResultRequest,
  AiPlan,
} from "../src/ai/ai.models.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";

const VPS_ID = "vps-binding-test";
const TASK_ID = "task-binding-test";
const INSTANCE_ID = "agent-instance-binding";
const COMMAND_ID = "command-binding-test";
const STEP_ID = "step-binding-test";
const PLAN_DIGEST = "plan-digest-binding-test";

function makePlan(): AiPlan {
  return {
    planId: "plan-binding-test",
    planVersion: 1,
    taskId: TASK_ID,
    vpsId: VPS_ID,
    agentInstanceId: INSTANCE_ID,
    providerRevision: 1,
    policyRevision: 1,
    capabilityRevision: 1,
    execMode: "sandbox",
    steps: [
      {
        stepId: STEP_ID,
        tool: "service_status",
        version: 1,
        args: { service: "docker" },
        resourceKeys: ["service:docker"],
        inputDigests: { payload: "payload-digest-binding-test" },
        description: "Read docker status",
        timeoutSeconds: 30,
      },
    ],
    preconditions: [],
    planDigest: PLAN_DIGEST,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "consumed",
    approvedSessionId: "session-binding-test",
  };
}

function makeCommand(): AiHostCommand {
  return {
    version: 1,
    taskId: TASK_ID,
    stepId: STEP_ID,
    commandId: COMMAND_ID,
    vpsId: VPS_ID,
    agentInstanceId: INSTANCE_ID,
    planVersion: 1,
    planDigest: PLAN_DIGEST,
    policyRevision: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    kind: "service_status",
    payload: { service: "docker" },
  };
}

type Fixture = {
  repo: AiRepository;
  service: AiAgentService;
  command: AiHostCommand;
  result: AiHostResultRequest;
  output: AiHostOutputRequest;
};

describe("AI agent result/output command binding", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-agent-report-binding-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fixture(claimed: boolean): Promise<Fixture> {
    const repo = createJsonAiRepository(join(dir, "ai.json"));
    const conversation = await repo.createConversation(VPS_ID, "Binding test");
    const { task } = await repo.createTask({
      id: TASK_ID,
      conversationId: conversation.id,
      vpsId: VPS_ID,
      state: "planning",
      requestSummary: "Check docker",
      idempotencyKey: "binding-test-idempotency",
      initiatingSessionId: "session-binding-test",
    });
    const plan = makePlan();
    const planned = await repo.updateTask({
      id: task.id,
      expectedRevision: task.revision,
      plan,
    });
    const executing = await repo.updateTask({
      id: task.id,
      expectedRevision: planned.revision,
      state: "executing",
      ownerLease: { ownerInstanceId: INSTANCE_ID, leaseSeconds: 60 },
    });
    const command = makeCommand();
    await repo.enqueueCommands([
      {
        entry: {
          id: "outbox-binding-test",
          taskId: TASK_ID,
          stepId: STEP_ID,
          commandId: COMMAND_ID,
          vpsId: VPS_ID,
          agentInstanceId: INSTANCE_ID,
          command,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        expect: {
          taskId: TASK_ID,
          taskIdRevision: executing.revision,
          commandId: COMMAND_ID,
          planDigest: PLAN_DIGEST,
        },
      },
    ]);
    if (claimed) {
      const claimedCommands = await repo.claimCommands(INSTANCE_ID, VPS_ID, 1);
      expect(claimedCommands).toEqual([command]);
    }

    const config = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-agent-report-binding-test-secret-0123456789",
    });
    const sessions = {
      authenticateById: async () => ({ sessionId: "session-binding-test" }),
    } as unknown as DashboardSessionService;
    const service = new AiAgentService(
      repo,
      { ...config, ai: { ...config.ai, enabled: true } },
      sessions,
      {} as unknown as DockerMonitoringRepository,
      new AiPolicyService(config, repo),
    );

    const result: AiHostResultRequest = {
      version: 1,
      agentInstanceId: INSTANCE_ID,
      taskId: TASK_ID,
      stepId: STEP_ID,
      commandId: COMMAND_ID,
      planVersion: 1,
      planDigest: PLAN_DIGEST,
      status: "succeeded",
      executed: true,
      exitCode: 0,
      payload: { service: "docker", status: "active" },
    };
    const output: AiHostOutputRequest = {
      version: 1,
      agentInstanceId: INSTANCE_ID,
      taskId: TASK_ID,
      commandId: COMMAND_ID,
      streamId: "stream-binding-test",
      sequence: 0,
      chunk: "active",
      isGap: false,
      isEnd: true,
    };
    return { repo, service, command, result, output };
  }

  it("rejects an unknown result command instead of creating a receipt", async () => {
    const { service, repo, result } = await fixture(true);
    await expect(
      service.result(VPS_ID, { ...result, commandId: "forged-unknown-command" }),
    ).rejects.toThrow();
    expect(await repo.listReceiptsByTask(TASK_ID)).toHaveLength(0);
  });

  it.each([
    ["agent instance", { agentInstanceId: "wrong-agent-instance" }],
    ["task", { taskId: "wrong-task" }],
    ["step", { stepId: "wrong-step" }],
    ["plan version", { planVersion: 99 }],
    ["plan digest", { planDigest: "forged-plan-digest" }],
  ])("rejects a result with a wrong %s", async (_name, patch) => {
    const { service, repo, result } = await fixture(true);
    await expect(service.result(VPS_ID, { ...result, ...patch })).rejects.toThrow();
    expect(await repo.listReceiptsByTask(TASK_ID)).toHaveLength(0);
  });

  it("rejects a result while the exact command is still pending/unclaimed", async () => {
    const { service, repo, result } = await fixture(false);
    await expect(service.result(VPS_ID, result)).rejects.toThrow();
    expect(await repo.listReceiptsByTask(TASK_ID)).toHaveLength(0);
  });

  it("rejects forged auto-authorized reads that have no dispatched outbox command", async () => {
    const { service, repo, result } = await fixture(true);
    await expect(
      service.result(VPS_ID, {
        ...result,
        commandId: "forged-auto-read",
        stepId: "read-forged-auto-read",
        planVersion: 0,
        planDigest: "forged-auto-read-plan-digest",
      }),
    ).rejects.toThrow();
    expect(await repo.listReceiptsByTask(TASK_ID)).toHaveLength(0);
  });

  it("accepts a legitimate dispatched report and its identical retry", async () => {
    const { service, repo, result } = await fixture(true);
    await expect(service.result(VPS_ID, result)).resolves.toMatchObject({
      ok: true,
      commandId: COMMAND_ID,
      agentInstanceId: INSTANCE_ID,
    });
    await expect(service.result(VPS_ID, result)).resolves.toMatchObject({
      ok: true,
      commandId: COMMAND_ID,
      agentInstanceId: INSTANCE_ID,
    });
    expect(await repo.listReceiptsByTask(TASK_ID)).toHaveLength(1);
  });

  it("rejects forged output and accepts output for the dispatched command", async () => {
    const { service, output } = await fixture(true);
    await expect(
      service.output(VPS_ID, { ...output, commandId: "forged-output-command" }),
    ).rejects.toThrow();
    await expect(service.output(VPS_ID, output)).resolves.toMatchObject({
      ok: true,
      acknowledgedSeq: 0,
    });
  });

  it.each([
    ["agent instance", { agentInstanceId: "wrong-output-agent" }],
    ["command", { commandId: "forged-output-command" }],
  ])("rejects output with a wrong %s and does not publish it", async (_name, patch) => {
    const { service, output } = await fixture(true);
    await expect(service.output(VPS_ID, { ...output, ...patch })).rejects.toThrow();
    expect((await service.readOutput(TASK_ID)).chunks).toHaveLength(0);
  });

  it.each([
    ["agent instance", { agentInstanceId: "wrong-heartbeat-agent" }],
    ["command", { commandId: "forged-heartbeat-command" }],
  ])("rejects a heartbeat with a wrong %s", async (_name, patch) => {
    const { service } = await fixture(true);
    const heartbeat: AiHostHeartbeatRequest = {
      version: 1,
      agentInstanceId: INSTANCE_ID,
      taskId: TASK_ID,
      commandId: COMMAND_ID,
      timestamp: new Date().toISOString(),
    };
    await expect(
      service.heartbeat(VPS_ID, { ...heartbeat, ...patch }),
    ).rejects.toThrow();
  });

  it.each([
    ["agent instance", { agentInstanceId: "wrong-cancel-agent" }],
    ["command", { commandId: "forged-cancel-command" }],
  ])(
    "rejects a cancel callback with a wrong %s without mutating task state",
    async (_name, patch) => {
      const { service, repo } = await fixture(true);
      const task = await repo.getTask(VPS_ID, TASK_ID);
      await repo.updateTask({
        id: TASK_ID,
        expectedRevision: task!.revision,
        state: "cancel_requested",
      });
      await expect(
        service.cancelStatus(VPS_ID, {
          version: 1,
          agentInstanceId: INSTANCE_ID,
          taskId: TASK_ID,
          commandId: COMMAND_ID,
          acknowledged: true,
          terminated: true,
          ...patch,
        }),
      ).rejects.toThrow();
      expect((await repo.getTask(VPS_ID, TASK_ID))?.state).toBe(
        "cancel_requested",
      );
    },
  );

  it("accepts a legitimate cancel callback", async () => {
    const { service, repo } = await fixture(true);
    const task = await repo.getTask(VPS_ID, TASK_ID);
    await repo.updateTask({
      id: TASK_ID,
      expectedRevision: task!.revision,
      state: "cancel_requested",
    });
    const callback = {
      version: 1 as const,
      agentInstanceId: INSTANCE_ID,
      taskId: TASK_ID,
      commandId: COMMAND_ID,
      acknowledged: true,
      terminated: true,
    };
    await expect(service.cancelStatus(VPS_ID, callback)).resolves.toEqual({
      ok: true,
    });
    expect((await repo.getTask(VPS_ID, TASK_ID))?.state).toBe("cancelled");
  });
});
