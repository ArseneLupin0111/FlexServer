import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { AppConfig } from "../src/config/app-config.js";
import { AuditService } from "../src/audit/audit.service.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { AuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import type { LocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import {
  createJsonLocalUpgradeRepository,
  LocalUpgradeUniqueViolationError,
} from "../src/persistence/repositories/local-upgrade.repository.js";
import { createPostgresLocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.postgres.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { LocalUpgradeService } from "../src/local-upgrade/local-upgrade.service.js";
import { AgentConvergenceService } from "../src/local-upgrade/agent-convergence.service.js";
import { BundledAgentService } from "../src/local-upgrade/bundled-agent.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { loadMigrations } from "../src/db/migrations.js";
import type { LocalUpgradeJob } from "../src/local-upgrade/local-upgrade.models.js";
import type { AgentSystemInfo } from "../src/agents/agent.models.js";
const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;
const BUILD_ID_OLD = "1111111111111111111111111111111111111111";
const BUILD_ID_V1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUILD_ID_V2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA256_V1 = "1234567890abcdef".repeat(4);
const SHA256_V2 = "fedcba0987654321".repeat(4);

const baseConfig = {
  mode: "production",
  dataDir: "data",
  privateDir: "private",
  storageDriver: "json",
} as unknown as AppConfig;

function makeFakeBundled(currentBuildId: string = BUILD_ID_V1): BundledAgentService {
  return {
    getMetadata: vi.fn((arch: "amd64" | "arm64") => {
      if (arch === "amd64" || arch === "arm64") {
        return {
          version: "1.0.0",
          buildId: currentBuildId,
          sha256: currentBuildId === BUILD_ID_V1 ? SHA256_V1 : SHA256_V2,
          sizeBytes: 10_000,
          arch,
        };
      }
      return null;
    }),
  } as unknown as BundledAgentService;
}

function fakeSystemInfo(vpsId: string, arch?: string): AgentSystemInfo {
  return {
    vpsId,
    collectedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    hostname: `host-${vpsId}`,
    kernel: arch ? { arch } : undefined,
  };
}
async function addTestVps(
  vpsStore: VpsRepository,
  id: string,
  name = "VPS",
) {
  return vpsStore.ensureLocalHost({
    id,
    name,
    host: "10.0.0.1",
    port: 22,
    username: "root",
    kind: "remote",
    managedBy: "user",
    status: "healthy",
  });
}

async function setAgentOnline(
  agentRepo: AgentRepository,
  vpsId: string,
  buildId: string,
  version = "0.9.0",
) {
  return agentRepo.upsertState({
    vpsId,
    status: "online",
    version,
    buildId,
    installedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
}

describe("AgentConvergenceService (JSON Repository)", () => {
  let tmpDir: string;
  let vpsStore: VpsRepository;
  let agentRepo: AgentRepository;
  let auditRepo: AuditRepository;
  let upgradeRepo: LocalUpgradeRepository;
  let auditService: AuditService;
  let coordinator: AgentLifecycleCoordinator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-conv-test-"));
    vpsStore = createVpsStore(join(tmpDir, "vps.json"));
    agentRepo = createJsonAgentRepository(join(tmpDir, "agents.json"));
    auditRepo = createJsonAuditRepository(join(tmpDir, "audit.json"));
    upgradeRepo = createJsonLocalUpgradeRepository(join(tmpDir, "local-upgrades.json"));
    auditService = new AuditService(baseConfig, auditRepo);
    coordinator = new AgentLifecycleCoordinator();
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  });

  it("two concurrent claims => exactly one executing (JSON adapter)", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await addTestVps(vpsStore, "vps-02", "VPS 2");

    const now = new Date().toISOString();
    const job1: LocalUpgradeJob = {
      id: "lug_1",
      vpsId: "vps-01",
      state: "queued",
      progress: null,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_1/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      actor: "test",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: null,
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const job2: LocalUpgradeJob = {
      ...job1,
      id: "lug_2",
      vpsId: "vps-02",
    };

    await upgradeRepo.create(job1);
    await upgradeRepo.create(job2);

    // First claim succeeds
    const claimed1 = await upgradeRepo.compareAndSet("lug_1", 0, {
      state: "claimed",
      claimedAt: now,
    });
    expect(claimed1?.state).toBe("claimed");

    // Second claim fails with global_active
    await expect(
      upgradeRepo.compareAndSet("lug_2", 0, {
        state: "claimed",
        claimedAt: now,
      }),
    ).rejects.toThrowError(LocalUpgradeUniqueViolationError);
  });

  it("offline oldest host => another ready host proceeds", async () => {
    // Two VPS in stable order: vps-01 (older/first) and vps-02 (second)
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await addTestVps(vpsStore, "vps-02", "VPS 2");

    // vps-01 is offline (stale updater heartbeat)
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
      protocolVersion: 3,
    });

    // vps-02 is ready and online (even if busy)
    await setAgentOnline(agentRepo, "vps-02", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-02", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-02",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: false,
      busyReason: "pty_active",
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );

    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    await convergence.tick();

    // vps-01 should not get a job because it is offline
    const jobs1 = await upgradeRepo.listByVps("vps-01");
    expect(jobs1.length).toBe(0);

    // vps-02 should get a job created immediately even though busy!
    const jobs2 = await upgradeRepo.listByVps("vps-02");
    expect(jobs2.length).toBe(1);
    expect(jobs2[0].releaseBuildId).toBe(BUILD_ID_V1);
    expect(jobs2[0].state).toBe("queued");
  });

  it("busy installed host is scheduled immediately on startup tick", async () => {
    await addTestVps(vpsStore, "vps-busy", "Busy VPS");
    await setAgentOnline(agentRepo, "vps-busy", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-busy", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-busy",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: false,
      busyReason: "long_running_job",
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    await convergence.tick();

    const jobs = await upgradeRepo.listByVps("vps-busy");
    expect(jobs.length).toBe(1);
    expect(jobs[0].state).toBe("queued");
    expect(jobs[0].releaseBuildId).toBe(BUILD_ID_V1);
  });

  it("terminal CAS and suppression survive process restart", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );

    // Record terminal failure with suppression atomically
    await upgradeRepo.create({
      id: "lug_fail",
      vpsId: "vps-01",
      state: "claimed",
      progress: null,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_fail/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      actor: "test",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: new Date().toISOString(),
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await upgradeRepo.compareAndSet(
      "lug_fail",
      0,
      {
        state: "failed",
        error: { code: "crash", message: "process crashed" },
      },
      {
        suppressedBuildId: BUILD_ID_V1,
        suppressedReason: "process crashed",
      },
    );

    // Verify suppression is written
    const conv = await upgradeRepo.getConvergence("vps-01");
    expect(conv?.suppressedBuildId).toBe(BUILD_ID_V1);

    // Simulate service restart: create fresh service instance with fresh repo instances
    const freshUpgradeRepo = createJsonLocalUpgradeRepository(join(tmpDir, "local-upgrades.json"));
    const freshAgentRepo = createJsonAgentRepository(join(tmpDir, "agents.json"));
    const freshVpsStore = createVpsStore(join(tmpDir, "vps.json"));
    const freshCoordinator = new AgentLifecycleCoordinator();
    const freshLocalUpgradeService = new LocalUpgradeService(
      baseConfig,
      freshUpgradeRepo,
      freshAgentRepo,
      freshVpsStore,
      bundled,
      auditService,
      freshCoordinator,
    );
    const freshConvergence = new AgentConvergenceService(
      baseConfig,
      freshUpgradeRepo,
      freshAgentRepo,
      freshVpsStore,
      bundled,
      freshLocalUpgradeService,
      auditService,
      undefined,
      freshCoordinator,
    );

    await freshConvergence.onApplicationBootstrap();
    await freshConvergence.tick();

    // No new job created because BUILD_ID_V1 is suppressed
    const jobs = await freshUpgradeRepo.listByVps("vps-01");
    const queuedJobs = jobs.filter((j) => j.state === "queued");
    expect(queuedJobs.length).toBe(0);
  });

  it("repeated retry key => one attempt", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );

    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    // Request update twice with same idempotency key
    const res1 = await convergence.requestUpdate("vps-01", "retry-key-abc");
    const res2 = await convergence.requestUpdate("vps-01", "retry-key-abc");

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();

    // Tick creates job
    await convergence.tick();

    const jobs = await upgradeRepo.listByVps("vps-01");
    expect(jobs.length).toBe(1);

    // Calling requestUpdate again with same key does not create second job
    await convergence.requestUpdate("vps-01", "retry-key-abc");
    await convergence.tick();

    const jobsAfter = await upgradeRepo.listByVps("vps-01");
    expect(jobsAfter.length).toBe(1);
  });

  it("new deployment supersedes unclaimed old target", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });
    // First target: BUILD_ID_V1
    const bundledV1 = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeServiceV1 = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundledV1,
      auditService,
      coordinator,
    );

    // Create queued job for V1
    await localUpgradeServiceV1.createJob("vps-01", { releaseId: BUILD_ID_V1 });
    const initialJobs = await upgradeRepo.listByVps("vps-01");
    expect(initialJobs[0].state).toBe("queued");
    expect(initialJobs[0].releaseBuildId).toBe(BUILD_ID_V1);

    // New deployment occurs: bundled agent changes to BUILD_ID_V2!
    const bundledV2 = makeFakeBundled(BUILD_ID_V2);
    const localUpgradeServiceV2 = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundledV2,
      auditService,
      coordinator,
    );
    const convergenceV2 = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundledV2,
      localUpgradeServiceV2,
      auditService,
      undefined,
      coordinator,
    );

    // Tick reconciles: old job is superseded, new job for V2 created
    await convergenceV2.tick();

    const allJobs = await upgradeRepo.listByVps("vps-01");
    const oldJob = allJobs.find((j) => j.releaseBuildId === BUILD_ID_V1);
    expect(oldJob?.state).toBe("superseded");

    const newJob = allJobs.find((j) => j.releaseBuildId === BUILD_ID_V2);
    expect(newJob).toBeDefined();
    expect(newJob?.state).toBe("queued");
  });

  it("old post-swap target recovers before new execution", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await addTestVps(vpsStore, "vps-02", "VPS 2");

    // vps-01 has a post-swap job in awaiting_heartbeat
    const now = new Date().toISOString();
    await upgradeRepo.create({
      id: "lug_postswap",
      vpsId: "vps-01",
      state: "awaiting_heartbeat",
      progress: 90,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_postswap/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      actor: "test",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: now,
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });

    // vps-02 is idle and ready
    await setAgentOnline(agentRepo, "vps-02", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-02", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-02",
      lastSeenAt: now,
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    // Tick: because vps-01 is executing (awaiting_heartbeat), vps-02 cannot be scheduled
    await convergence.tick();

    const jobsVps2 = await upgradeRepo.listByVps("vps-02");
    expect(jobsVps2.length).toBe(0);

    // Now vps-01 agent produces the target heartbeat and completes
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_V1, "1.0.0");

    await convergence.tick();

    // vps-01 succeeded, and now vps-02 gets its turn!
    const postSwapJob = await upgradeRepo.get("lug_postswap");
    expect(postSwapJob?.state).toBe("succeeded");

    const jobsVps2After = await upgradeRepo.listByVps("vps-02");
    expect(jobsVps2After.length).toBe(1);
    expect(jobsVps2After[0].state).toBe("queued");
  });

  it("missing arch never defaults to amd64", async () => {
    await addTestVps(vpsStore, "vps-noarch", "No Arch VPS");
    await setAgentOnline(agentRepo, "vps-noarch", BUILD_ID_OLD);
    // System info has no kernel architecture
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-noarch"));
    // Updater has no platform architecture
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-noarch",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    await convergence.tick();

    // No job created
    const jobs = await upgradeRepo.listByVps("vps-noarch");
    expect(jobs.length).toBe(0);

    // Status view shows incompatible / missing arch, never amd64
    const status = await convergence.getAgentUpdate("vps-noarch");
    expect(status.compatibility.compatible).toBe(false);
    expect(status.automation.state).toBe("incompatible");
  });

  it("deferred pre-swap attempt -> host reconnects -> creates new attempt", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    // First tick creates queued job
    await convergence.tick();
    const initialJobs = await upgradeRepo.listByVps("vps-01");
    expect(initialJobs.length).toBe(1);
    expect(initialJobs[0].state).toBe("queued");

    // Host becomes offline -> job is deferred
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
      protocolVersion: 3,
    });
    await convergence.tick();

    const deferredJob = await upgradeRepo.get(initialJobs[0].id);
    expect(deferredJob?.state).toBe("deferred");

    // Host reconnects (even while busy) -> tick creates a fresh attempt with a unique attempt key!
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: false,
      busyReason: "pty_active",
    });
    await convergence.tick();

    const allJobs = await upgradeRepo.listByVps("vps-01");
    expect(allJobs.length).toBe(2);
    const queuedJob = allJobs.find((j) => j.state === "queued");
    expect(queuedJob).toBeDefined();
    expect(queuedJob?.id).not.toBe(initialJobs[0].id);
  });

  it("retry failure is suppressed again until a new key is issued", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    // Initial state: BUILD_ID_V1 is suppressed from a prior failure
    await upgradeRepo.updateConvergence("vps-01", {
      suppressedBuildId: BUILD_ID_V1,
      suppressedReason: "prior failure",
    });

    // Tick does NOT create a job because of suppression
    await convergence.tick();
    expect((await upgradeRepo.listByVps("vps-01")).length).toBe(0);

    // User requests manual retry with key "retry-1"
    await convergence.requestUpdate("vps-01", "retry-1");

    // Tick creates the retry attempt
    await convergence.tick();
    const jobs = await upgradeRepo.listByVps("vps-01");
    expect(jobs.length).toBe(1);
    expect(jobs[0].state).toBe("queued");

    // Attempt fails (updater reports error or terminal failure)
    await upgradeRepo.compareAndSet(
      jobs[0].id,
      jobs[0].revision,
      {
        state: "failed",
        error: { code: "install_error", message: "disk full" },
      },
    );

    // Terminal CAS re-asserts suppression AND clears the retryKey/retryBuildId
    const convAfterFail = await upgradeRepo.getConvergence("vps-01");
    expect(convAfterFail?.suppressedBuildId).toBe(BUILD_ID_V1);
    expect(convAfterFail?.retryKey).toBeNull();

    // Next tick: host is idle, but stays suppressed! No duplicate retry is attempted!
    await convergence.tick();
    const jobsAfterTick = await upgradeRepo.listByVps("vps-01");
    expect(jobsAfterTick.length).toBe(1); // Still only the 1 failed job

    // Only when user issues a NEW key does a new attempt proceed
    await convergence.requestUpdate("vps-01", "retry-2");
    await convergence.tick();
    const jobsAfterNewRetry = await upgradeRepo.listByVps("vps-01");
    expect(jobsAfterNewRetry.length).toBe(2);
  });

  it("earlier non-created job does not starve next host", async () => {
    // Two VPS: vps-01 is older (first in sort order), vps-02 is second
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await addTestVps(vpsStore, "vps-02", "VPS 2");

    // vps-01 is already on the target build (nothing to create)
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_V1);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    // vps-02 is on old build and needs update
    await setAgentOnline(agentRepo, "vps-02", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-02", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-02",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    await convergence.tick();

    // vps-01 had nothing created, vps-02 got its queued job without starvation!
    const vps01Jobs = await upgradeRepo.listByVps("vps-01");
    expect(vps01Jobs.length).toBe(0);

    const vps02Jobs = await upgradeRepo.listByVps("vps-02");
    expect(vps02Jobs.length).toBe(1);
    expect(vps02Jobs[0].state).toBe("queued");
  });

  it("replayK1 after failed retry does not create duplicate attempt; new key K2 creates fresh attempt", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    // Initial state: suppressed
    await upgradeRepo.updateConvergence("vps-01", {
      suppressedBuildId: BUILD_ID_V1,
      suppressedReason: "failure",
    });

    // Request retry with K1
    await convergence.requestUpdate("vps-01", "K1");
    await convergence.tick();

    const jobs = await upgradeRepo.listByVps("vps-01");
    expect(jobs.length).toBe(1);
    expect(jobs[0].retryRequestKey).toBe("K1");

    // Attempt fails
    await upgradeRepo.compareAndSet(jobs[0].id, jobs[0].revision, {
      state: "failed",
      error: { code: "install_error", message: "disk full" },
    });

    // Verify retryKey is consumed
    const convAfterFail = await upgradeRepo.getConvergence("vps-01");
    expect(convAfterFail?.retryKey).toBeNull();

    // User replays K1
    await convergence.requestUpdate("vps-01", "K1");
    await convergence.tick();

    // Replay of consumed K1 did NOT create a new job
    const jobsAfterReplay = await upgradeRepo.listByVps("vps-01");
    expect(jobsAfterReplay.length).toBe(1);

    // User provides fresh key K2
    await convergence.requestUpdate("vps-01", "K2");
    await convergence.tick();

    // New attempt created for K2
    const jobsAfterK2 = await upgradeRepo.listByVps("vps-01");
    expect(jobsAfterK2.length).toBe(2);
    expect(jobsAfterK2.find((j) => j.retryRequestKey === "K2")).toBeDefined();
  });

  it("K2 arriving while K1 is executing is preserved when K1 reaches terminal state", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    // Request retry with K1 and start it
    await convergence.requestUpdate("vps-01", "K1");
    await convergence.tick();

    const jobs = await upgradeRepo.listByVps("vps-01");
    expect(jobs.length).toBe(1);
    const jobK1 = jobs[0];
    expect(jobK1.retryRequestKey).toBe("K1");

    // While K1 is in-flight, user submits K2
    await convergence.requestUpdate("vps-01", "K2");
    const convDuringK1 = await upgradeRepo.getConvergence("vps-01");
    expect(convDuringK1?.retryKey).toBe("K2");

    // K1 reaches terminal failure
    await upgradeRepo.compareAndSet(jobK1.id, jobK1.revision, {
      state: "failed",
      error: { code: "crash", message: "crashed" },
    });

    // Convergence must NOT erase K2!
    const convAfterK1Fail = await upgradeRepo.getConvergence("vps-01");
    expect(convAfterK1Fail?.retryKey).toBe("K2");
    expect(convAfterK1Fail?.retryBuildId).toBe(BUILD_ID_V1);

    // Next tick creates attempt for K2
    await convergence.tick();
    const jobsAfterK2 = await upgradeRepo.listByVps("vps-01");
    expect(jobsAfterK2.length).toBe(2);
    expect(jobsAfterK2.find((j) => j.retryRequestKey === "K2")).toBeDefined();
  });

  it("queued job on busy host is not deferred; defers safely when offline without failure suppression", async () => {
    await addTestVps(vpsStore, "vps-01", "VPS 1");
    await setAgentOnline(agentRepo, "vps-01", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-01", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: true,
    });

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );
    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      undefined,
      coordinator,
    );

    // Initial tick creates queued job
    await convergence.tick();
    const jobs = await upgradeRepo.listByVps("vps-01");
    expect(jobs.length).toBe(1);
    const queuedJob = jobs[0];
    expect(queuedJob.state).toBe("queued");

    // Host becomes busy with activity - queued job must NOT be deferred
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: false,
      busyReason: "docker_build",
    });

    // Next convergence tick keeps the queued job
    await convergence.tick();
    const jobStillQueued = await upgradeRepo.get(queuedJob.id);
    expect(jobStillQueued?.state).toBe("queued");

    // When host goes offline (stale updater heartbeat), queued job is deferred
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-01",
      lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
      protocolVersion: 3,
    });
    await convergence.tick();

    const jobAfter = await upgradeRepo.get(queuedJob.id);
    expect(jobAfter?.state).toBe("deferred");
    expect(jobAfter?.result?.reason).toBe("updater_offline");

    // Target is NOT suppressed!
    const conv = await upgradeRepo.getConvergence("vps-01");
    expect(conv?.suppressedBuildId ?? null).toBeNull();
  });

  it("refreshes remote updater via ensureBundled once per process on target agent build mismatch before candidate scheduling", async () => {
    await addTestVps(vpsStore, "vps-remote-refresh", "Remote VPS");
    await setAgentOnline(agentRepo, "vps-remote-refresh", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-remote-refresh", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-remote-refresh",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: false,
      busyReason: "pty_active",
    });

    const fakeProvisioning = {
      ensureBundled: vi.fn().mockResolvedValue({
        vpsId: "vps-remote-refresh",
        status: "enrolled",
        reason: null,
      }),
    };

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );

    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      fakeProvisioning as never,
      coordinator,
    );

    // First tick triggers ensureBundled to refresh the remote updater and defers job scheduling
    await convergence.tick();
    expect(fakeProvisioning.ensureBundled).toHaveBeenCalledWith("vps-remote-refresh");
    const jobsTick1 = await upgradeRepo.listByVps("vps-remote-refresh");
    expect(jobsTick1.length).toBe(0);

    // Next tick: host was refreshed in this process, so candidate job is scheduled immediately without second refresh
    await convergence.tick();
    expect(fakeProvisioning.ensureBundled).toHaveBeenCalledTimes(1);
    const jobsTick2 = await upgradeRepo.listByVps("vps-remote-refresh");
    expect(jobsTick2.length).toBe(1);
    expect(jobsTick2[0].state).toBe("queued");
  });

  it("refreshes remote updater via ensureBundled when queued job already exists on remote host", async () => {
    await addTestVps(vpsStore, "vps-queued-refresh", "Queued Remote VPS");
    await setAgentOnline(agentRepo, "vps-queued-refresh", BUILD_ID_OLD);
    await agentRepo.upsertSystemInfo(fakeSystemInfo("vps-queued-refresh", "x86_64"));
    await upgradeRepo.recordUpdaterHeartbeat({
      vpsId: "vps-queued-refresh",
      lastSeenAt: new Date().toISOString(),
      protocolVersion: 3,
      idle: false,
      busyReason: "deploy_running",
    });

    const now = new Date().toISOString();
    await upgradeRepo.create({
      id: "lug_queued_preexisting",
      vpsId: "vps-queued-refresh",
      state: "queued",
      progress: null,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_queued_preexisting/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      actor: "convergence",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: null,
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });

    const fakeProvisioning = {
      ensureBundled: vi.fn().mockResolvedValue({
        vpsId: "vps-queued-refresh",
        status: "enrolled",
        reason: null,
      }),
    };

    const bundled = makeFakeBundled(BUILD_ID_V1);
    const localUpgradeService = new LocalUpgradeService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      auditService,
      coordinator,
    );

    const convergence = new AgentConvergenceService(
      baseConfig,
      upgradeRepo,
      agentRepo,
      vpsStore,
      bundled,
      localUpgradeService,
      auditService,
      fakeProvisioning as never,
      coordinator,
    );

    await convergence.tick();
    expect(fakeProvisioning.ensureBundled).toHaveBeenCalledWith("vps-queued-refresh");

    // Second tick does not repeatedly call ensureBundled
    await convergence.tick();
    expect(fakeProvisioning.ensureBundled).toHaveBeenCalledTimes(1);

    const job = await upgradeRepo.get("lug_queued_preexisting");
    expect(job?.state).toBe("queued");
  });
});

describe.skipIf(!databaseUrl)("AgentConvergenceService (Postgres Repository)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  let schema: string;
  let upgradeRepo: LocalUpgradeRepository;

  beforeEach(async () => {
    schema = `test_conv_pg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    admin = new pg.Pool({ connectionString: databaseUrl! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path="${schema}"` });

    await pool.query("CREATE TABLE vps (id text PRIMARY KEY)");
    await pool.query("CREATE TABLE IF NOT EXISTS agent_credentials (id text PRIMARY KEY, vps_id text, scope text)");
    await pool.query("CREATE TABLE IF NOT EXISTS agent_states (vps_id text PRIMARY KEY, build_id text)");
    const migrations = await loadMigrations();
    await pool.query(migrations.find((m) => m.id === "021_local_agent_upgrades.sql")!.sql);
    const m032 = migrations.find((m) => m.id === "032_fleet_agent_updates.sql");
    if (m032) await pool.query(m032.sql);
    const m033 = migrations.find((m) => m.id === "033_agent_deploy_convergence.sql");
    if (m033) await pool.query(m033.sql);
    const m034 = migrations.find((m) => m.id === "034_agent_convergence_indexes.sql");
    if (m034) await pool.query(m034.sql);
    await pool.query(migrations.find((m) => m.id === "035_updater_ai_install.sql")!.sql);

    upgradeRepo = createPostgresLocalUpgradeRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("two concurrent claims => exactly one executing (Postgres adapter)", async () => {
    await pool.query("INSERT INTO vps (id) VALUES ('vps-01'), ('vps-02')");

    const now = new Date().toISOString();
    const job1: LocalUpgradeJob = {
      id: "lug_pg_1",
      vpsId: "vps-01",
      state: "queued",
      progress: null,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_pg_1/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      actor: "test",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: null,
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const job2: LocalUpgradeJob = {
      ...job1,
      id: "lug_pg_2",
      vpsId: "vps-02",
    };

    await upgradeRepo.create(job1);
    await upgradeRepo.create(job2);

    const claimed1 = await upgradeRepo.compareAndSet("lug_pg_1", 0, {
      state: "claimed",
      claimedAt: now,
    });
    expect(claimed1?.state).toBe("claimed");

    // Attempting second claim throws global_active error
    await expect(
      upgradeRepo.compareAndSet("lug_pg_2", 0, {
        state: "claimed",
        claimedAt: now,
      }),
    ).rejects.toThrowError(LocalUpgradeUniqueViolationError);
  });

  it("persists convergence records and suppresses build on terminal CAS (Postgres adapter)", async () => {
    await pool.query("INSERT INTO vps (id) VALUES ('vps-01')");
    await upgradeRepo.create({
      id: "lug_pg_fail",
      vpsId: "vps-01",
      state: "claimed",
      progress: null,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_pg_fail/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      actor: "test",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: new Date().toISOString(),
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await upgradeRepo.compareAndSet(
      "lug_pg_fail",
      0,
      {
        state: "failed",
        error: { code: "crash", message: "process crashed" },
      },
      {
        suppressedBuildId: BUILD_ID_V1,
        suppressedReason: "process crashed",
      },
    );

    const conv = await upgradeRepo.getConvergence("vps-01");
    expect(conv?.suppressedBuildId).toBe(BUILD_ID_V1);
    expect(conv?.suppressedReason).toBe("process crashed");

    // Clear suppression via updateConvergence
    await upgradeRepo.updateConvergence("vps-01", {
      suppressedBuildId: null,
      suppressedReason: null,
    });
    const cleared = await upgradeRepo.getConvergence("vps-01");
    expect(cleared?.suppressedBuildId).toBeNull();
  });

  it("preserves K2 retry intent when K1 finishes in terminal failure (Postgres adapter)", async () => {
    await pool.query("INSERT INTO vps (id) VALUES ('vps-01')");
    await upgradeRepo.updateConvergence("vps-01", {
      retryBuildId: BUILD_ID_V1,
      retryKey: "K2",
    });

    const now = new Date().toISOString();
    await upgradeRepo.create({
      id: "lug_pg_k1",
      vpsId: "vps-01",
      state: "claimed",
      progress: null,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_pg_k1/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      retryRequestKey: "K1",
      actor: "test",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: now,
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });

    // K1 fails
    await upgradeRepo.compareAndSet("lug_pg_k1", 0, {
      state: "failed",
      error: { code: "crash", message: "crashed" },
    });

    // In Postgres, K2 retry intent must NOT have been cleared
    const conv = await upgradeRepo.getConvergence("vps-01");
    expect(conv?.suppressedBuildId).toBe(BUILD_ID_V1);
    expect(conv?.retryKey).toBe("K2");
    expect(conv?.retryBuildId).toBe(BUILD_ID_V1);
  });

  it("clears retry intent on success even without prior suppression (Postgres adapter)", async () => {
    await pool.query("INSERT INTO vps (id) VALUES ('vps-01')");
    await upgradeRepo.updateConvergence("vps-01", {
      retryBuildId: BUILD_ID_V1,
      retryKey: "K1",
    });

    const now = new Date().toISOString();
    await upgradeRepo.create({
      id: "lug_pg_k1_succ",
      vpsId: "vps-01",
      state: "awaiting_heartbeat",
      progress: null,
      releaseId: BUILD_ID_V1,
      releaseVersion: "1.0.0",
      releaseBuildId: BUILD_ID_V1,
      targetSha256: SHA256_V1,
      targetUrl: "/api/local-updater/jobs/lug_pg_k1_succ/artifact",
      manifestRaw: "",
      targetArch: "amd64",
      retryRequestKey: "K1",
      actor: "test",
      fencingToken: 1,
      reclaimCount: 0,
      claimedAt: now,
      leaseExpiresAt: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      error: null,
      result: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Job succeeds
    await upgradeRepo.compareAndSet("lug_pg_k1_succ", 0, {
      state: "succeeded",
      completedAt: now,
    });

    // Retry intent must be cleared in Postgres
    const conv = await upgradeRepo.getConvergence("vps-01");
    expect(conv?.retryKey).toBeNull();
    expect(conv?.retryBuildId).toBeNull();
  });
});
