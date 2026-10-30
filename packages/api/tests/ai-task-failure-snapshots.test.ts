import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiTaskService } from "../src/ai/ai-task.service.js";
import { AiPolicyService, AiPolicyError } from "../src/ai/ai-policy.service.js";
import {
  AiProvider,
  ProviderKeyRequiredError,
  ProviderProtocolError,
  ProviderTransportError,
} from "../src/ai/ai-provider.js";
import { AI_PROVIDER_KEY_CONTEXT } from "../src/ai/ai-routes.service.js";
import { encryptAiSecret } from "../src/ai/ai-crypto.js";
import {
  createTestKeyring,
  saveKeyringToFile,
  type Keyring,
} from "../src/ssh/key-encryption.js";
import type { MetricService } from "../src/metrics/metric.service.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import type { AiHostPlanService } from "../src/ai/ai-host-plan.service.js";
import type { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import type { AiReadToolsService } from "../src/ai/ai-read-tools.service.js";
import type { AiTask } from "../src/ai/ai.models.js";

// Task failure snapshot codes. Provider calls are stubbed via an
// AiProvider.prototype spy; the task run is fire-and-forget, so each test
// polls the task to a terminal state before asserting the public snapshot.

const request = { dashboardSessionId: "admin-session" } as unknown as Request;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

/** Real policy service whose dispatch revalidation throws a fixed error,
 * reproducing mid-run AiPolicyError failures (revision/policy changed). */
class RevalidationFailingPolicyService extends AiPolicyService {
  constructor(
    config: AppConfig,
    repository: AiRepository,
    private readonly failure: () => AiPolicyError,
  ) {
    super(config, repository);
  }
  override async revalidateForDispatch(): Promise<void> {
    throw this.failure();
  }
}

describe("AI task failure snapshots", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-task-failure-"));
    const keyring: Keyring = createTestKeyring("kek_task_failures");
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
      apiKeyEnvelope: encryptAiSecret("sk-task-fixture", AI_PROVIDER_KEY_CONTEXT, keyring),
      expectedRevision: 0,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function baseConfig(keyringFile = join(dir, "ai-keyring.json")): AppConfig {
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-task-failure-test-secret-0123456789",
    });
    return { ...parsed, ai: { enabled: true, keyringFile } };
  }

  function makeService(
    options: {
      policy?: AiPolicyService;
      sessions?: DashboardSessionService;
      keyringFile?: string;
    } = {},
  ): AiTaskService {
    const config = baseConfig(options.keyringFile);
    const sessions: DashboardSessionService =
      options.sessions ??
      ({ authenticateById: async () => ({ sessionId: "admin-session" }) } as unknown as DashboardSessionService);
    return new AiTaskService(
      aiRepo,
      config,
      options.policy ?? new AiPolicyService(config, aiRepo),
      {} as unknown as MetricService,
      sessions,
      {} as unknown as DockerMonitoringService,
      {} as unknown as AiHostPlanService,
      {} as unknown as AiDockerBridgeService,
      {} as unknown as DockerMonitoringRepository,
      {} as unknown as AiReadToolsService,
      vpsRepo,
    );
  }

  async function runTaskToTerminal(service: AiTaskService, idempotencyKey: string): Promise<AiTask> {
    const created = await service.create(request, vpsId, {
      request: "Summarize current container status",
      idempotencyKey,
    });
    const deadline = Date.now() + 4000;
    for (;;) {
      const task = await aiRepo.getTask(vpsId, created.id);
      if (task && TERMINAL.has(task.state)) {
        // Assert through the public snapshot, not the internal row.
        return service.get(request, vpsId, created.id);
      }
      if (Date.now() > deadline) {
        throw new Error(`AI task never reached a terminal state (last: ${task?.state ?? "none"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("keeps the recognized AiPolicyError code provider_revision_changed on the failed snapshot", async () => {
    const policy = new RevalidationFailingPolicyService(
      baseConfig(),
      aiRepo,
      () => new AiPolicyError("provider_revision_changed", 409),
    );
    const task = await runTaskToTerminal(makeService({ policy }), "policy-revision-changed");
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("provider_revision_changed");
  });

  it("keeps the recognized AiPolicyError code policy_denied without leaking its detail", async () => {
    const policy = new RevalidationFailingPolicyService(
      baseConfig(),
      aiRepo,
      () => new AiPolicyError("policy_denied", 409, { reason: "policy_changed" }),
    );
    const task = await runTaskToTerminal(makeService({ policy }), "policy-denied");
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("policy_denied");
    expect(task.error?.details).toBeUndefined();
  });

  it("collapses an AiPolicyError carrying an unrecognized code to provider_unavailable", async () => {
    const policy = new RevalidationFailingPolicyService(
      baseConfig(),
      aiRepo,
      () => new AiPolicyError("brand_new_unstable_code", 500, { secret: "sk-leak" }),
    );
    const task = await runTaskToTerminal(makeService({ policy }), "policy-unrecognized");
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("provider_unavailable");
    expect(JSON.stringify(task.error)).not.toContain("brand_new_unstable_code");
    expect(JSON.stringify(task.error)).not.toContain("sk-leak");
  });

  it("preserves the provider_protocol_error code from a protocol failure with the generic message", async () => {
    vi.spyOn(AiProvider.prototype, "generate").mockRejectedValueOnce(new ProviderProtocolError());
    const task = await runTaskToTerminal(makeService(), "provider-protocol");
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("provider_protocol_error");
    expect(task.error?.message).not.toContain("Invalid provider response");
  });

  it("preserves the provider_key_required code from a key failure with the generic message", async () => {
    vi.spyOn(AiProvider.prototype, "generate").mockRejectedValueOnce(new ProviderKeyRequiredError());
    const task = await runTaskToTerminal(makeService(), "provider-key-required");
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("provider_key_required");
    expect(task.error?.message).not.toContain("Provider key required");
  });

  it("preserves the provider_unavailable code from a transport failure", async () => {
    vi.spyOn(AiProvider.prototype, "generate").mockRejectedValueOnce(new ProviderTransportError());
    const task = await runTaskToTerminal(makeService(), "provider-transport");
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("provider_unavailable");
  });

  it("preserves the crypto_unavailable code from a missing keyring without keyring detail", async () => {
    const task = await runTaskToTerminal(
      makeService({ keyringFile: join(dir, "missing-ai-keyring.json") }),
      "crypto-unavailable",
    );
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("crypto_unavailable");
    expect(task.error?.message).not.toContain("keyring");
  });

  it("keeps the AiAssistantError code on the cancelled snapshot", async () => {
    // authenticateById resolving falsy makes the run cancel the task under loop revoke semantics.
    const sessions = {
      authenticateById: async () => undefined,
    } as unknown as DashboardSessionService;
    const task = await runTaskToTerminal(makeService({ sessions }), "assistant-error");
    expect(task.state).toBe("cancelled");
    expect(task.completion?.kind).toBe("cancelled");
    expect(task.error?.code).toBe("policy_denied");
  });

  it("records a mid-run abort as cancelled with the fixed cancellation error", async () => {
    const sessions = {
      authenticateById: async () => {
        const running = (makeServiceHolder.service as unknown as {
          running: Map<string, AbortController>;
        }).running;
        for (const controller of running.values()) controller.abort();
        return { sessionId: "admin-session" };
      },
    } as unknown as DashboardSessionService;
    const makeServiceHolder: { service?: AiTaskService } = {};
    makeServiceHolder.service = makeService({ sessions });
    const task = await runTaskToTerminal(makeServiceHolder.service!, "cancelled-mid-run");
    expect(task.state).toBe("cancelled");
    expect(task.error?.code).toBe("cancelled");
  });

  it("sanitizes unknown raw failures to provider_unavailable with no secret-bearing text", async () => {
    vi.spyOn(AiProvider.prototype, "generate").mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 10.0.0.9 apiKey=sk-live-abc123 forbidden"),
    );
    const task = await runTaskToTerminal(makeService(), "unknown-raw");
    expect(task.state).toBe("failed");
    expect(task.error?.code).toBe("provider_unavailable");
    expect(JSON.stringify(task.error)).not.toContain("sk-live-abc123");
    expect(JSON.stringify(task.error)).not.toContain("ECONNREFUSED");
  });
});
