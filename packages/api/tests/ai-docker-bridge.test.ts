import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJsonApplicationsRepository } from "../src/persistence/repositories/applications.repository.js";
import { createJsonDockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import {
  createJsonDockerMonitoringRepository,
  seedDockerMonitoringForTests,
} from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createJsonApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { ApplicationsService } from "../src/docker-applications/applications.service.js";
import { DockerManagementService } from "../src/docker/docker-management.service.js";
import { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import { AiDockerBridgeService } from "../src/ai/ai-docker-bridge.service.js";
import type { AiPolicy, AiPlan, AiPlanStep } from "../src/ai/ai.models.js";
import type { AppConfig } from "../src/config/app-config.js";

// ── AI Docker bridge: proposal bounds + precondition-bound execution ────────
// Proposals must reject unknown tools/actions/targets, protected and non-opted-in
// targets, and carry preconditions. Execution must validate those preconditions
// against live monitoring state before creating any Docker management operation.

const KEK = Buffer.from("0123456789abcdef0123456789abcdef", "hex").toString("base64"); // 32-byte KEK
function baseConfig(dir: string): AppConfig {
  return {
    mode: "local",
    enableWebTerminal: false,
    allowPrivateNetworkTargets: false,
    dataDir: dir,
    privateDir: dir,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    agentInstallIntervalSeconds: 1,
    allowInsecureAgentHttp: false,
    dbSsl: false,
    dbPoolMax: 1,
    dashboardSessionTtlSeconds: 3600,
    dashboardCookieSecure: false,
    dashboardCookieSameSite: "lax",
    dashboardSessionSecret: "ai-bridge-test-secret",
    trustProxyHops: 0,
    jobHistoryLimit: 100,
    auditHistoryLimit: 100,
    metricWindowLimit: 100,
    dockerRetentionDays: 1,
    dockerMaintenanceSamplesPerVps: 100,
    dockerMaintenanceEventsPerVps: 100,
    dockerMaintenanceIntervalSeconds: 100,
    dockerJsonMaxBytes: 1024 * 1024,
    dockerJsonMaintenanceMaxRewriteBytes: 1024 * 1024,
    sshHostKeyPins: {},
    sshHostKeyPolicy: "strict",
    composeCrypto: { keyringFile: join(dir, "ai-keyring.json") },
    ai: {
      keyringFile: join(dir, "ai-keyring.json"),
      adminLockFile: join(dir, "admin.lock"),
      databaseLockTtlMs: 5000,
    },
  };
}

function policy(vpsId: string, overrides: Partial<AiPolicy> = {}): AiPolicy {
  return {
    vpsId,
    aiEnabled: true,
    readEnabled: true,
    dockerActionsEnabled: true,
    composeActionsEnabled: true,
    shellEnabled: false,
    fileReadScopes: [],
    fileWriteScopes: [],
    serviceProfileIds: [],
    sendLogsToProvider: false,
    sendFilesToProvider: false,
    revision: 1,
    updatedAt: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

type SampleInput = {
  id: string;
  snapshotId: string;
  at: string;
  containerKey?: string;
  name?: string;
  image?: string;
  state?: string;
  scope?: "host" | "container";
};

describe("AiDockerBridgeService", () => {
  let dir: string;
  let monitoringFile: string;
  let vpsId: string;
  let bridge: AiDockerBridgeService;
  let mgmtRepo: ReturnType<typeof createJsonDockerManagementRepository>;

  function sample(s: SampleInput) {
    const scope = s.scope ?? "container";
    return {
      id: s.id,
      vpsId,
      agentInstanceId: "agent-inst-1",
      snapshotId: s.snapshotId,
      collectedAt: s.at,
      effectiveAt: s.at,
      receivedAt: s.at,
      scope,
      ...(scope === "container"
        ? {
            containerKey: s.containerKey!,
            ...(s.name !== undefined ? { name: s.name } : {}),
            ...(s.image !== undefined ? { image: s.image } : {}),
            ...(s.state !== undefined ? { state: s.state } : {}),
          }
        : {}),
      metrics: { cpuPercent: 1, memoryUsageBytes: 50_000, pids: 5 },
    };
  }

  async function seedSnapshot(snapshotId: string, at: string, containers: SampleInput[]) {
    await seedDockerMonitoringForTests(monitoringFile, {
      samples: [
        sample({ id: `${snapshotId}_host`, snapshotId, at, scope: "host" }),
        ...containers.map((c) => sample({ ...c, snapshotId, at, scope: "container" })),
      ],
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-bridge-test-"));
    monitoringFile = join(dir, "monitoring.json");
    const config = baseConfig(dir);
    await writeFile(
      join(dir, "ai-keyring.json"),
      JSON.stringify({ version: 1, activeKekId: "kek_1", keys: { kek_1: KEK } }),
    );
    const vpsRepo = createVpsStore(join(dir, "vps.json"));
    mgmtRepo = createJsonDockerManagementRepository(join(dir, "docker-mgmt.json"));
    const appRepo = createJsonApplicationsRepository(dir);
    const appInvRepo = createJsonApplicationsInventoryRepository(join(dir, "app-inv.json"));
    const agentRepo = createJsonAgentRepository(join(dir, "agents.json"));
const createdPre = undefined
    const aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    const monitoringRepo = createJsonDockerMonitoringRepository(monitoringFile);
    const created = await vpsRepo.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    await vpsRepo.update(vpsId, { dockerManagementEnabled: true, composeManagementEnabled: true });
    const monitoringService = new DockerMonitoringService(monitoringRepo, vpsRepo, config);
    const appService = new ApplicationsService(config, vpsRepo, agentRepo, appRepo, appInvRepo);
    const mgmtService = new DockerManagementService(vpsRepo, mgmtRepo, monitoringRepo, config, appService);
    bridge = new AiDockerBridgeService(
      aiRepo,
      config,
      vpsRepo,
      mgmtService,
      appService,
      monitoringService,
      monitoringRepo,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function planFor(step: AiPlanStep, preconditions: AiPlan["preconditions"]): AiPlan {
    return {
      planId: "plan-1",
      planVersion: 1,
      taskId: "task-1",
      vpsId,
      agentInstanceId: "agent-inst-1",
      providerRevision: 1,
      policyRevision: 1,
      capabilityRevision: 0,
      steps: [step],
      preconditions,
      planDigest: "digest-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "approved",
    };
  }

  it("rejects a docker action when the Docker opt-in is disabled", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", state: "running" },
    ]);
    await expect(
      bridge.propose(
        vpsId,
        "docker_action",
        { action: "restart", target: { containerKey: "app" } },
        policy(vpsId, { dockerActionsEnabled: false }),
      ),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("rejects a compose action when the Compose opt-in is disabled", async () => {
    await expect(
      bridge.propose(
        vpsId,
        "compose_action",
        { appId: "app-1", action: "restart" },
        policy(vpsId, { composeActionsEnabled: false }),
      ),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("rejects protected container targets (flexserver, postgres)", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_flex", containerKey: "flexserver-core", name: "flexserver", state: "running" },
      { id: "c_pg", containerKey: "pg-db", name: "postgres", state: "running" },
    ]);
    for (const containerKey of ["flexserver-core", "pg-db"]) {
      await expect(
        bridge.propose(vpsId, "docker_action", { action: "restart", target: { containerKey } }, policy(vpsId)),
      ).rejects.toMatchObject({ code: "protected_target" });
    }
  });

  it("rejects unknown container targets and malformed action args", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", state: "running" },
    ]);
    await expect(
      bridge.propose(vpsId, "docker_action", { action: "restart", target: { containerKey: "ghost" } }, policy(vpsId)),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      bridge.propose(vpsId, "docker_action", { action: "purge", target: { containerKey: "app" } }, policy(vpsId)),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      bridge.propose(vpsId, "docker_action", { action: "restart", target: { containerKey: "app" }, extra: 1 }, policy(vpsId)),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects unknown tools", async () => {
    await expect(
      bridge.propose(vpsId, "shell_run", { script: "id" }, policy(vpsId)),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("proposes a docker action with state-binding preconditions", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", image: "nginx:alpine", state: "running" },
    ]);
    const proposal = await bridge.propose(
      vpsId,
      "docker_action",
      { action: "restart", target: { containerKey: "app" } },
      policy(vpsId),
    );
    const keys = proposal.preconditions.map((c) => c.key);
    expect(keys).toContain("container:app:state");
    expect(keys).toContain("container:app:agentInstanceId");
    expect(proposal.preconditions.find((c) => c.key === "container:app:state")?.expectedValue).toBe("running");
    expect(proposal.step.tool).toBe("docker_action");
    expect(proposal.step.resourceKeys).toContain("docker:container:app");
  });

  it("never mutates Docker state when preconditions drifted", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", state: "running" },
    ]);
    const proposal = await bridge.propose(
      vpsId,
      "docker_action",
      { action: "restart", target: { containerKey: "app" } },
      policy(vpsId),
    );

    // Container flipped to exited in a newer committed snapshot.
    await seedSnapshot("snap-2", "2026-10-21T00:10:00.000Z", [
      { id: "c_app_drift", containerKey: "app", name: "web", state: "exited" },
    ]);

    await expect(
      bridge.execute(
        vpsId,
        proposal.step,
        planFor(proposal.step, proposal.preconditions),
        { dashboardSessionId: "sess-1" } as never,
      ),
    ).rejects.toMatchObject({ code: "target_changed" });

    expect(await mgmtRepo.listByVps(vpsId)).toHaveLength(0);
  });

  it("never mutates Docker state when the target container disappeared", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", state: "running" },
    ]);
    const proposal = await bridge.propose(
      vpsId,
      "docker_action",
      { action: "stop", target: { containerKey: "app" } },
      policy(vpsId),
    );
    await seedSnapshot("snap-2", "2026-10-21T00:10:00.000Z", [
      { id: "c_other", containerKey: "other", name: "other", state: "running" },
    ]);
    await expect(
      bridge.execute(
        vpsId,
        proposal.step,
        planFor(proposal.step, proposal.preconditions),
        { dashboardSessionId: "sess-1" } as never,
      ),
    ).rejects.toMatchObject({ code: "target_changed" });
    expect(await mgmtRepo.listByVps(vpsId)).toHaveLength(0);
  });

  it("refuses execution of an unapproved or expired plan", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", state: "running" },
    ]);
    const proposal = await bridge.propose(
      vpsId,
      "docker_action",
      { action: "restart", target: { containerKey: "app" } },
      policy(vpsId),
    );
    const pending = { ...planFor(proposal.step, proposal.preconditions), status: "pending" as const };
    await expect(
      bridge.execute(vpsId, proposal.step, pending, { dashboardSessionId: "sess-1" } as never),
    ).rejects.toMatchObject({ code: "stale_plan" });

    const expired = {
      ...planFor(proposal.step, proposal.preconditions),
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    await expect(
      bridge.execute(vpsId, proposal.step, expired, { dashboardSessionId: "sess-1" } as never),
    ).rejects.toMatchObject({ code: "approval_expired" });

    expect(await mgmtRepo.listByVps(vpsId)).toHaveLength(0);
  });

  it("refuses execution when the plan VPS does not match", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", state: "running" },
    ]);
    const proposal = await bridge.propose(
      vpsId,
      "docker_action",
      { action: "restart", target: { containerKey: "app" } },
      policy(vpsId),
    );
    const foreign = { ...planFor(proposal.step, proposal.preconditions), vpsId: "vps-other" };
    await expect(
      bridge.execute(vpsId, proposal.step, foreign, { dashboardSessionId: "sess-1" } as never),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("executes through the existing management service exactly once per step id", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", state: "running" },
    ]);
    const proposal = await bridge.propose(
      vpsId,
      "docker_action",
      { action: "restart", target: { containerKey: "app" } },
      policy(vpsId),
    );

    // No agents exist here: completion is decoupled. A settle loop drains the
    // queued operation the way the agent claim path does (claim then terminal
    // result), while execute observes completion instead of assuming it.
    const task = bridge.execute(
      vpsId,
      proposal.step,
      planFor(proposal.step, proposal.preconditions),
      { dashboardSessionId: "sess-1" } as never,
    );
    const settle = (async () => {
      for (let i = 0; i < 20; i++) {
        const pending = await mgmtRepo.peekNextClaimable(vpsId, "agent-inst-1");
        if (!pending) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        const claimed = await mgmtRepo.claimNextQueued(vpsId, "agent-inst-1");
        if (claimed) {
          await mgmtRepo.setResult(claimed.id, "succeeded", { ok: true });
          return;
        }
      }
    })();

    const result = await task;
    await settle;
    expect(result.ok).toBe(true);

    const ops = await mgmtRepo.listByVps(vpsId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.action).toBe("restart");
    expect(ops[0]!.idempotencyKey).toBe(`ai-step-${proposal.step.stepId}`);
  });

  it("reports failure rather than success when the observed operation failed", async () => {
    await seedSnapshot("snap-1", "2026-10-21T00:00:00.000Z", [
      { id: "c_app", containerKey: "app", name: "web", state: "running" },
    ]);
    const proposal = await bridge.propose(
      vpsId,
      "docker_action",
      { action: "start", target: { containerKey: "app" } },
      policy(vpsId),
    );
    const task = bridge.execute(
      vpsId,
      proposal.step,
      planFor(proposal.step, proposal.preconditions),
      { dashboardSessionId: "sess-1" } as never,
    );
    const settle = (async () => {
      for (let i = 0; i < 20; i++) {
        const pending = await mgmtRepo.peekNextClaimable(vpsId, "agent-inst-1");
        if (!pending) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        const claimed = await mgmtRepo.claimNextQueued(vpsId, "agent-inst-1");
        if (claimed) {
          await mgmtRepo.setResult(claimed.id, "failed", { ok: false, message: "daemon refused" });
          return;
        }
      }
    })();
    const result = await task;
    await settle;
    expect(result.ok).toBe(false);
  });

});
