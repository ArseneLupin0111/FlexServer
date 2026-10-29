import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository, defaultAiPolicy } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
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
import type { AiCapability, AiHostCommand, AiPolicy, AiTask } from "../src/ai/ai.models.js";
import { updateAiPolicySchema } from "../src/ai/ai.schemas.js";
import { readJsonFile, writeJsonFile } from "../src/persistence/repositories/json-file.js";
import { AiAssistantError } from "../src/ai/ai-failures.js";

const request = { dashboardSessionId: "admin-session" } as unknown as Request;
const TERMINAL: Record<string, true> = {
  succeeded: true,
  failed: true,
  cancelled: true,
  expired: true,
  executing: true,
  uncertain: true,
};
function pollDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
const rootfsDigest = "a".repeat(64);
const profilesDigest = "b".repeat(64);

describe("AI per-VPS autoApprove (YOLO policy)", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let config: AppConfig;
  let service: AiTaskService;
  let activeInstanceId: string | null = "agent-inst-1";
  let idempotencyCounter = 0;
  let sessionValid = true;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-auto-approve-tests-"));
    const keyring: Keyring = createTestKeyring("kek_autoapprove_tests");
    const keyringFile = join(dir, "ai-keyring.json");
    await saveKeyringToFile(keyringFile, keyring);

    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    const created = await vpsRepo.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;

    const parsed = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "ai-autoapprove-test-secret-at-least-32-chars" });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true, keyringFile } };

    await aiRepo.updateSettings({
      patch: { endpoint: "https://provider.example.test/v1", model: "test-model" },
      apiKeyEnvelope: encryptAiSecret("sk-autoapprove-fixture", AI_PROVIDER_KEY_CONTEXT, keyring),
      expectedRevision: 0,
    });

    sessionValid = true;
    activeInstanceId = "agent-inst-1";
    service = makeService();
    idempotencyCounter = 0;
  });

  afterEach(async () => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        break;
      } catch {
        if (attempt === 4) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  function makeService(): AiTaskService {
    const sessions = {
      authenticateById: async (sessionId: string) => (sessionValid && sessionId === "admin-session" ? { sessionId } : null),
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

  async function seedPolicy(overrides: Partial<AiPolicy> = {}): Promise<AiPolicy> {
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

  async function proposeShellPlan(shellArgs: Record<string, unknown> = {}): Promise<AiTask> {
    idempotencyCounter += 1;
    vi.spyOn(AiProvider.prototype, "generate").mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "host_shell",
              arguments: JSON.stringify({ script: "echo test", timeoutSeconds: 30, ...shellArgs }),
            },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, estimated: true },
    });
    const created = await service.create(request, vpsId, {
      request: "Run diagnostic shell",
      idempotencyKey: `autoapprove-${idempotencyCounter}`,
    });
    const currentPol = await aiRepo.getAiPolicy(vpsId);
    const deadline = Date.now() + 4000;
    for (;;) {
      const task = await aiRepo.getTask(vpsId, created.id);
      if (task) {
        if (!currentPol?.autoApprove && (task.state === "awaiting_approval" || TERMINAL[task.state])) {
          return task;
        }
        if (currentPol?.autoApprove) {
          if (task.state === "failed" || task.state === "uncertain" || task.state === "succeeded" || task.state === "cancelled") {
            return task;
          }
          if (task.state === "executing") {
            const outbox = await aiRepo.replayPendingCommands(vpsId);
            if (outbox.some((cmd) => cmd.taskId === task.id)) {
              return task;
            }
            await pollDelay(25);
            const refetched = await aiRepo.getTask(vpsId, task.id);
            if (refetched && refetched.state !== "executing") return refetched;
          }
        }
      }
      if (Date.now() > deadline) throw new Error(`AI task never settled (last: ${task?.state ?? "none"})`);
      // Asynchronous background run() loop polled until persistence settles
      await pollDelay(10);
    }
  }

  describe("Schema & policy normalization", () => {
    it("defaults autoApprove to false in defaultAiPolicy", () => {
      const policy = defaultAiPolicy(vpsId);
      expect(policy.autoApprove).toBe(false);
    });

    it("validates updateAiPolicySchema: allows autoApprove boolean and rejects non-boolean values", () => {
      expect(updateAiPolicySchema.safeParse({ autoApprove: true }).success).toBe(true);
      expect(updateAiPolicySchema.safeParse({ autoApprove: false }).success).toBe(true);
      expect(updateAiPolicySchema.safeParse({ autoApprove: "true" }).success).toBe(false);
    });

    it("normalizes absent or corrupt autoApprove to false on read (fail-closed)", async () => {
      const aiFile = join(dir, "ai.json");
      const raw = await readJsonFile<{ policies: Record<string, unknown>[] }>(aiFile, { policies: [] });
      raw.policies.push({ vpsId, revision: 1, updatedAt: new Date().toISOString() });
      await writeJsonFile(aiFile, raw);

      const policy = await aiRepo.getAiPolicy(vpsId);
      expect(policy?.autoApprove).toBe(false);
    });

    it("persists autoApprove toggles cleanly", async () => {
      const p1 = await aiRepo.updateAiPolicy({ vpsId, patch: { autoApprove: true }, expectedRevision: 0 });
      expect(p1.autoApprove).toBe(true);
      const read1 = await aiRepo.getAiPolicy(vpsId);
      expect(read1?.autoApprove).toBe(true);

      const p2 = await aiRepo.updateAiPolicy({ vpsId, patch: { autoApprove: false }, expectedRevision: p1.revision });
      expect(p2.autoApprove).toBe(false);
      const read2 = await aiRepo.getAiPolicy(vpsId);
      expect(read2?.autoApprove).toBe(false);
    });
  });

  describe("Auto-approval execution and safety gates", () => {
    it("autoApprove OFF (default): leaves plan in awaiting_approval with pending status", async () => {
      await seedPolicy({ autoApprove: false });
      await seedCapability();

      const task = await proposeShellPlan();
      expect(task.state).toBe("awaiting_approval");
      expect(task.plan?.status).toBe("pending");

      const outbox = await aiRepo.claimCommands("agent-inst-1", vpsId, 10);
      expect(outbox).toHaveLength(0);
    });

    it("autoApprove ON: automatically approves, transitions to executing and enqueues outbox command", async () => {
      await seedPolicy({ autoApprove: true });
      await seedCapability();

      const task = await proposeShellPlan();
      expect(task.state).toBe("executing");
      expect(task.plan?.status).toBe("consumed");

      let claimed: AiHostCommand[] = [];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        claimed = await aiRepo.claimCommands("agent-inst-1", vpsId, 10);
        if (claimed.length > 0) break;
        await pollDelay(10);
      }
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.taskId).toBe(task.id);
      expect(claimed[0]?.kind).toBe("shell");
    });

    it("no retroactive dispatch: enabling autoApprove does NOT dispatch existing awaiting_approval plan", async () => {
      await seedPolicy({ autoApprove: false });
      await seedCapability();

      const task = await proposeShellPlan();
      expect(task.state).toBe("awaiting_approval");

      // Enable autoApprove now
      const current = await aiRepo.getAiPolicy(vpsId);
      await aiRepo.updateAiPolicy({
        vpsId,
        patch: { autoApprove: true },
        expectedRevision: current!.revision,
      });

      // Existing task must remain in awaiting_approval
      const fetched = await aiRepo.getTask(vpsId, task.id);
      expect(fetched?.state).toBe("awaiting_approval");
      expect(fetched?.plan?.status).toBe("pending");

      const outbox = await aiRepo.claimCommands("agent-inst-1", vpsId, 10);
      expect(outbox).toHaveLength(0);
    });

    it("safety fence: uncertain outcome fence blocks autoapproval without corrupting state", async () => {
      await seedPolicy({ autoApprove: true });
      await seedCapability();

      // Seed an unresolved uncertain task on this VPS
      await aiRepo.createConversation(vpsId, "prior", "conv-prior");
      await aiRepo.createTask({
        id: "uncertain-prior-task",
        vpsId,
        conversationId: "conv-prior",
        initiatingSessionId: "admin-session",
        idempotencyKey: "idem-prior",
        requestSummary: "prior crashed step",
        state: "uncertain",
      });

      const task = await proposeShellPlan();
      // Autoapproval is rejected truthfully by uncertain CAS fence
      expect(task.state).toBe("failed");
      expect(task.error?.code).toBe("uncertain_outcome");

      const outbox = await aiRepo.claimCommands("agent-inst-1", vpsId, 10);
      expect(outbox).toHaveLength(0);
    });

    it("safety fence: revoked session blocks autoapproval with policy_denied", async () => {
      await seedPolicy({ autoApprove: true });
      await seedCapability();

      // Session revoked before proposal
      sessionValid = false;

      const task = await proposeShellPlan();
      expect(task.state).toBe("failed");
      expect(task.error?.code).toBe("policy_denied");

      const outbox = await aiRepo.claimCommands("agent-inst-1", vpsId, 10);
      expect(outbox).toHaveLength(0);
    });

    it("no replay: autoapproved and consumed plan cannot be re-approved", async () => {
      await seedPolicy({ autoApprove: true });
      await seedCapability();

      const task = await proposeShellPlan();
      expect(task.state).toBe("executing");
      expect(task.plan?.status).toBe("consumed");

      // Attempting to approve again must fail with stale_plan
      await expect(
        service.approve(request, vpsId, task.id, {
          planVersion: task.plan!.planVersion,
          planDigest: task.plan!.planDigest,
        }),
      ).rejects.toThrowError(AiAssistantError);
    });

    it("post-dispatch error preserves uncertain mutation fence without marking task failed", async () => {
      await seedPolicy({ autoApprove: true });
      await seedCapability();

      vi.spyOn(aiRepo, "enqueueCommands").mockRejectedValueOnce(new Error("Disk full on outbox journal"));

      const task = await proposeShellPlan();
      expect(task.state).toBe("uncertain");
      expect(task.error?.code).toBe("uncertain_outcome");

      // Mutation fence must remain active: autoapproving another task in the same VPS cannot mutate
      const nextTask = await proposeShellPlan();
      expect(nextTask.state).toBe("failed");
      expect(nextTask.error?.code).toBe("uncertain_outcome");
    });
  });
});
