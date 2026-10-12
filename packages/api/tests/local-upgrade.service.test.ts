import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import type { AgentCredential } from "../src/agents/agent.models.js";
import { AuditService } from "../src/audit/audit.service.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import type { LocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import { createJsonLocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import {
  LocalUpgradeService,
  type CreateLocalUpgradeResult,
} from "../src/local-upgrade/local-upgrade.service.js";
import type { LocalUpgradeJob } from "../src/local-upgrade/local-upgrade.models.js";
import {
  LOCAL_UPGRADE_LEASE_TTL_MS,
  LOCAL_UPGRADE_OVERALL_DEADLINE_MS,
} from "../src/local-upgrade/local-upgrade.models.js";
import { AGENT_API_CONTRACT_VERSION } from "../src/local-upgrade/versions.js";

const LOCAL_VPS_ID = "vps_local_host";
const RELEASE_SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const BASELINE_SHA = "1111111111111111111111111111111111111111";
const TARGET_SHA256 = "0123456789abcdef".repeat(4);

const baseConfig = {
  mode: "demo",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: false,
  dataDir: "data",
  privateDir: "private",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
  agentInstallIntervalSeconds: 1,
  allowInsecureAgentHttp: false,
  storageDriver: "json",
  dbSsl: false,
  dbPoolMax: 10,
  dashboardSessionTtlSeconds: 86_400,
  dashboardCookieSecure: false,
  dashboardCookieSameSite: "lax",
  dashboardSessionSecret: "local-upgrade-test-secret-32+chars!",
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
} as unknown as AppConfig;

type ErrorBody = {
  error?: {
    message?: string;
    code?: string;
    jobId?: string;
    reason?: string;
  };
};

let tempDir: string;
let vpsRepo: VpsRepository;
let agentRepo: AgentRepository;
let lugRepo: LocalUpgradeRepository;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-local-upgrade-"));
  vpsRepo = createVpsStore(join(tempDir, "data", "vps.json"));
  agentRepo = createJsonAgentRepository(join(tempDir, "data", "agents.json"));
  lugRepo = createJsonLocalUpgradeRepository(
    join(tempDir, "data", "local-upgrades.json"),
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Test helpers ────────────────────────────────────────────────────────

function makeService(
  mode: "local" | "demo" = "local",
  bundledOverrides?: Partial<BundledAgentService>,
) {
  const config: AppConfig = {
    ...baseConfig,
    mode,
    dataDir: join(tempDir, "data"),
    privateDir: join(tempDir, "private"),
  };
  const catalog = {
    getCompatibleRelease: vi.fn(),
    getReleaseById: vi.fn(),
  };
  const bundledAgent = {
    getMetadata: vi.fn().mockReturnValue({
      filePath: "/app/agent/vps-agent-linux-amd64",
      os: "linux",
      arch: "amd64",
      version: "1.4.0",
      buildId: RELEASE_SHA,
      sha256: TARGET_SHA256,
      size: 1024,
      publishedAt: "2026-09-01T00:00:00Z",
    }),
    resolveBinaryPath: vi.fn().mockReturnValue("/app/agent/vps-agent-linux-amd64"),
    ...bundledOverrides,
  } as unknown as BundledAgentService;
  const service = new LocalUpgradeService(
    config,
    lugRepo,
    agentRepo,
    vpsRepo,
    bundledAgent,
    new AuditService(config, createJsonAuditRepository(join(tempDir, "data", "audit.json"))),
  );
  return { service, catalog, bundledAgent };
}

/**
 * Read the shared audit file through a fresh service instance — the same
 * wiring production uses, so what a test sees is what ops would query.
 */
async function readAudit(action?: string) {
  const config: AppConfig = {
    ...baseConfig,
    mode: "local",
    dataDir: join(tempDir, "data"),
    privateDir: join(tempDir, "private"),
  };
  const audit = new AuditService(
    config,
    createJsonAuditRepository(join(tempDir, "data", "audit.json")),
  );
  return action ? audit.list({ action }) : audit.list();
}

function okRelease(
  overrides: Partial<{
    apiCompatibility: { min: number; max: number };
    artifacts: unknown[];
    releaseId: string;
    buildId: string;
  }> = {},
) {
  return {
    status: "ok" as const,
    release: {
      releaseId: overrides.releaseId ?? RELEASE_SHA,
      version: "1.4.0",
      buildId: overrides.buildId ?? overrides.releaseId ?? RELEASE_SHA,
      publishedAt: "2026-09-01T00:00:00Z",
      channel: "stable",
      apiCompatibility: overrides.apiCompatibility ?? { min: 1, max: 3 },
      artifacts:
        overrides.artifacts ?? [
          {
            os: "linux",
            arch: "amd64",
            size: 8345672,
            sha256: TARGET_SHA256,
            url: "https://example.com/vps-agent-linux-amd64",
          },
        ],
      manifestRaw: `{"releaseId":"${overrides.releaseId ?? RELEASE_SHA}"}`,
    },
  };
}

async function localVps() {
  const vps = await vpsRepo.ensureLocalHost({
    id: LOCAL_VPS_ID,
    name: "Workstation",
    host: "127.0.0.1",
    port: 22,
    username: "root",
  });
  await agentRepo.upsertSystemInfo({ vpsId: LOCAL_VPS_ID, kernel: { arch: "x86_64" } });
  return vps;
}

async function remoteVps() {
  return vpsRepo.create({
    name: "remote",
    host: "203.0.113.10",
    port: 22,
    username: "root",
  });
}

function credential(vpsId = LOCAL_VPS_ID): Promise<AgentCredential> {
  return agentRepo.createCredential({
    vpsId,
    secretHash: "test-secret-hash",
    status: "active",
    scope: "local-updater",
  });
}

async function touchHeartbeat(vpsId = LOCAL_VPS_ID, protocolVersion = 2) {
  await lugRepo.recordUpdaterHeartbeat({
    vpsId,
    lastSeenAt: new Date().toISOString(),
    credentialId: "cred_updater_test",
    protocolVersion,
  });
}

function upsertBuild(buildId: string, ageMs = 0) {
  return agentRepo.upsertState({
    vpsId: LOCAL_VPS_ID,
    status: "online",
    version: "1.3.0",
    buildId,
    lastSeenAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

/** Await a rejection and assert HTTP status + error.code; returns the body. */
async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<NonNullable<ErrorBody["error"]>> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught, "expected promise to reject").toBeDefined();
  const err = caught as {
    getStatus?: () => number;
    getResponse?: () => unknown;
    message?: string;
  };
  expect(typeof err.getStatus, `expected HttpException, got: ${err.message}`)
    .toBe("function");
  expect(err.getStatus!()).toBe(status);
  const body = err.getResponse!() as ErrorBody;
  expect(body.error?.code).toBe(code);
  return body.error ?? {};
}

/** Create a ready-to-run job: local host, fresh heartbeat, catalog ok. */
async function createJob(
  service: LocalUpgradeService,
  options: {
    releaseId?: string;
    idempotencyKey?: string;
    actor?: string;
    withBuild?: string;
  } = {},
) {
  await touchHeartbeat();
  await upsertBuild(options.withBuild ?? BASELINE_SHA);
  return service.createJob(
    LOCAL_VPS_ID,
    { releaseId: options.releaseId ?? RELEASE_SHA },
    {
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
    },
  );
}

/** Claim and walk the job to `to`, applying progress along the way. */
async function progressTo(
  job: LocalUpgradeJob,
  credentialValue: AgentCredential,
  service: LocalUpgradeService,
  to: "downloading" | "verifying" | "staging" | "restarting" | "awaiting_heartbeat",
  progress: number,
): Promise<LocalUpgradeJob> {
  const result = await service.progress(credentialValue, job.id, {
    fencingToken: job.fencingToken,
    phase: to,
    progress,
  });
  return result;
}

// ── createJob validation order ──────────────────────────────────────────

describe("createJob validation", () => {
  it("rejects mutations in demo mode", async () => {
    await localVps();
    const { service } = makeService("demo");
    await expect(createJob(service)).rejects.toMatchObject({
      constructor: expect.anything(),
    });
    // DemoMutationBlockedError surfaces as 403 via the filter.
    const caught = await createJob(service).catch((e: unknown) => e);
    expect((caught as Error).message).toMatch(/demo/i);
  });

  it("returns 404 for an unknown host", async () => {
    const { service } = makeService();
    await expect(
      service.createJob("vps_missing", { releaseId: RELEASE_SHA }),
    ).rejects.toThrow("VPS not found");
  });

  it("rejects non-local hosts with not_local", async () => {
    const remote = await remoteVps();
    const { service } = makeService();
    await expectHttpError(
      service.createJob(remote.id, { releaseId: RELEASE_SHA }),
      409,
      "not_local",
    );
  });

  it("rejects when the updater is not reporting", async () => {
    await localVps();
    const { service, catalog } = makeService();
    const error = await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      409,
      "updater_unhealthy",
    );
    expect(error.message).toMatch(/not reporting/i);
    expect(catalog.getReleaseById).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent architecture without consulting the catalog", async () => {
    await localVps();
    const { service, catalog } = makeService();
    await touchHeartbeat();
    await upsertBuild(BASELINE_SHA);
    // Reported but unmapped architecture: must never fall back to amd64.
    await agentRepo.upsertSystemInfo({
      vpsId: LOCAL_VPS_ID,
      kernel: { arch: "riscv64" },
    });

    const error = await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      400,
      "release_incompatible",
    );
    expect(error.reason).toBe("unsupported_architecture");
    expect(catalog.getReleaseById).not.toHaveBeenCalled();
  });

  it("rejects when the agent heartbeat is unknown or stale", async () => {
    await localVps();
    const { service, catalog } = makeService();
    await touchHeartbeat();

    // Unknown: no agent state has ever been reported.
    await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      409,
      "agent_unavailable",
    );

    // Stale: build identity exists but the heartbeat is past freshness.
    await upsertBuild(BASELINE_SHA, 10 * 60_000);
    await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      409,
      "agent_unavailable",
    );

    expect(catalog.getReleaseById).not.toHaveBeenCalled();
    expect(await lugRepo.listByVps(LOCAL_VPS_ID, { limit: 10 })).toHaveLength(0);
  });

  it("maps bundled unavailable and changed outcomes", async () => {
    await localVps();
    const { service, bundledAgent } = makeService();
    await touchHeartbeat();
    await upsertBuild(BASELINE_SHA);

    vi.mocked(bundledAgent.getMetadata).mockReturnValueOnce(null);
    await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      409,
      "release_unavailable",
    );

    vi.mocked(bundledAgent.getMetadata).mockReturnValueOnce({
      filePath: "/app/agent/vps-agent-linux-amd64",
      os: "linux",
      arch: "amd64",
      version: "1.4.0",
      buildId: "9999999999999999999999999999999999999999",
      sha256: TARGET_SHA256,
      size: 1024,
      publishedAt: "2026-09-01T00:00:00Z",
    });
    await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      409,
      "release_changed",
    );
  });

  it("rejects bundled binary without a matching architecture", async () => {
    await localVps();
    const { service, bundledAgent } = makeService();
    await touchHeartbeat();
    await upsertBuild(BASELINE_SHA);
    vi.mocked(bundledAgent.getMetadata).mockReturnValueOnce({
      filePath: "/app/agent/vps-agent-linux-amd64",
      os: "linux",
      arch: "arm64",
      version: "1.4.0",
      buildId: RELEASE_SHA,
      sha256: TARGET_SHA256,
      size: 1024,
      publishedAt: "2026-09-01T00:00:00Z",
    });
    const error = await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      400,
      "release_incompatible",
    );
    expect(error.reason).toBe("unsupported_architecture");
  });
  it("rejects when the agent already runs this release", async () => {
    await localVps();
    const { service, catalog } = makeService();
    await touchHeartbeat();
    await upsertBuild(RELEASE_SHA);
    vi.mocked(catalog.getReleaseById).mockResolvedValueOnce(
      okRelease() as never,
    );
    await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }),
      409,
      "already_current",
    );
  });
});

// ── createJob persistence ───────────────────────────────────────────────

describe("createJob persistence", () => {
  it("pins release, artifact and deadline fields on a queued job", async () => {
    await localVps();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);

    const before = Date.now();
    const { job, created } = await createJob(service, {
      withBuild: BASELINE_SHA,
      actor: "alice",
    });
    const after = Date.now();

    expect(created).toBe(true);
    expect(job.id).toMatch(/^lug_[A-Za-z0-9_-]{12}$/);
    expect(job.vpsId).toBe(LOCAL_VPS_ID);
    expect(job.state).toBe("queued");
    expect(job.progress).toBeNull();
    expect(job.fencingToken).toBe(0);
    expect(job.reclaimCount).toBe(0);
    expect(job.revision).toBe(0);
    expect(job.releaseId).toBe(RELEASE_SHA);
    expect(job.releaseVersion).toBe("1.4.0");
    expect(job.releaseBuildId).toBe(RELEASE_SHA);
    expect(job.targetSha256).toBe(TARGET_SHA256);
    expect(job.targetUrl).toBe(`/api/local-updater/jobs/${job.id}/artifact`);
    expect(job.targetSizeBytes).toBe(1024);
    expect(job.manifestRaw).toBe("");
    expect(job.baselineBuildId).toBe(BASELINE_SHA);
    expect(job.actor).toBe("alice");
    expect(job.error).toBeNull();
    expect(job.result).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.claimedAt).toBeNull();

    const deadline = Date.parse(job.deadlineAt);
    expect(deadline).toBeGreaterThanOrEqual(
      before + LOCAL_UPGRADE_OVERALL_DEADLINE_MS - 50,
    );
    expect(deadline).toBeLessThanOrEqual(after + LOCAL_UPGRADE_OVERALL_DEADLINE_MS + 50);
    expect(Date.parse(job.phaseDeadlineAt!)).toBeGreaterThan(before);
  });

  it("replays an idempotency key to the same job", async () => {
    await localVps();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);

    const first = await createJob(service, { idempotencyKey: "key-1" });
    const second = await createJob(service, { idempotencyKey: "key-1" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.revision).toBe(first.job.revision);
  });

  it("rejects a second active job with active_job_exists + jobId", async () => {
    await localVps();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);

    const { job } = await createJob(service, { idempotencyKey: "key-a" });
    const error = await expectHttpError(
      service.createJob(LOCAL_VPS_ID, { releaseId: RELEASE_SHA }, { idempotencyKey: "key-b" }),
      409,
      "active_job_exists",
    );
    expect(error.jobId).toBe(job.id);
  });
});

// ── claim / lease / fencing ─────────────────────────────────────────────

describe("claim", () => {
  it("returns null when no job is active", async () => {
    await localVps();
    const cred = await credential();
    const { service } = makeService();
    expect(await service.claim(cred)).toBeNull();
  });

  it("claims a queued job once with a fencing token and a 60s lease", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);

    const before = Date.now();
    const claimed = await service.claim(cred);
    const after = Date.now();

    expect(claimed).not.toBeNull();
    expect(claimed!.requiresReconcile).toBe(false);
    const claimedJob = claimed!.job;
    expect(claimedJob.id).toBe(job.id);
    expect(claimedJob.state).toBe("claimed");
    expect(claimedJob.fencingToken).toBe(1);
    expect(claimedJob.reclaimCount).toBe(0);
    expect(claimedJob.claimedAt).not.toBeNull();
    const lease = Date.parse(claimedJob.leaseExpiresAt!);
    expect(lease).toBeGreaterThanOrEqual(before + LOCAL_UPGRADE_LEASE_TTL_MS - 50);
    expect(lease).toBeLessThanOrEqual(after + LOCAL_UPGRADE_LEASE_TTL_MS + 50);

    // A second claim within the lease is an idempotent replay.
    const replay = await service.claim(cred);
    expect(replay!.job.fencingToken).toBe(1);
    expect(replay!.job.reclaimCount).toBe(0);
  });

  it("serializes concurrent claims onto one fencing token", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await createJob(service);

    const [a, b] = await Promise.all([service.claim(cred), service.claim(cred)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.job.id).toBe(b!.job.id);
    expect(a!.job.fencingToken).toBe(1);
    expect(b!.job.fencingToken).toBe(1);
    expect(a!.job.reclaimCount).toBe(0);
    expect(b!.job.reclaimCount).toBe(0);
  });

  it("reclaims an expired lease with a bumped token and reclaimCount", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    const claimed = await service.claim(cred);
    expect(claimed!.job.fencingToken).toBe(1);

    // Expire the lease out-of-band.
    const current = (await lugRepo.get(job.id))!;
    await lugRepo.compareAndSet(job.id, current.revision, {
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const reclaimed = await service.claim(cred);
    expect(reclaimed!.job.fencingToken).toBe(2);
    expect(reclaimed!.job.reclaimCount).toBe(1);

    // Progress with the old token must be rejected.
    await expectHttpError(
      service.progress(cred, job.id, {
        fencingToken: 1,
        phase: "downloading",
        progress: 5,
      }),
      409,
      "stale_lease",
    );
  });
});

// ── progress ────────────────────────────────────────────────────────────

describe("progress", () => {
  it("walks phases, refreshes the lease, and pins the baseline at restarting", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;

    let current: LocalUpgradeJob = claimed.job;
    for (const [phase, progress] of [
      ["downloading", 20],
      ["verifying", 40],
      ["staging", 60],
    ] as const) {
      current = await progressTo(current, cred, service, phase, progress);
      expect(current.state).toBe(phase);
      expect(current.progress).toBe(progress);
      expect(current.fencingToken).toBe(1);
      expect(Date.parse(current.leaseExpiresAt!)).toBeGreaterThan(Date.now());
      expect(current.baselineHeartbeatAt).toBeUndefined();
    }

    const restarting = await progressTo(current, cred, service, "restarting", 80);
    expect(restarting.state).toBe("restarting");
    expect(restarting.baselineBuildId).toBe(BASELINE_SHA);
    expect(restarting.baselineHeartbeatAt).not.toBeNull();

    const awaiting = await progressTo(
      restarting,
      cred,
      service,
      "awaiting_heartbeat",
      90,
    );
    expect(awaiting.state).toBe("awaiting_heartbeat");
  });

  it("rejects progress from a wrong fencing token", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    await service.claim(cred);

    await expectHttpError(
      service.progress(cred, job.id, {
        fencingToken: 99,
        phase: "downloading",
        progress: 5,
      }),
      409,
      "stale_lease",
    );
  });

  it("rejects progress on a terminal job", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    await service.claim(cred);
    await service.result(cred, job.id, { fencingToken: 1, outcome: "failed", reason: "boom" });

    await expectHttpError(
      service.progress(cred, job.id, {
        fencingToken: 1,
        phase: "downloading",
        progress: 5,
      }),
      409,
      "job_terminal",
    );
  });
});

// ── result ──────────────────────────────────────────────────────────────

describe("result", () => {
  it("gates success on a fresh target-build heartbeat", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    let current = await progressTo(claimed.job, cred, service, "restarting", 80);
    current = await progressTo(current, cred, service, "awaiting_heartbeat", 90);

    // Heartbeat still reports the baseline build: success is deferred.
    const deferred = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "succeeded",
      reportedBuildId: RELEASE_SHA,
    });
    expect(deferred.awaitHeartbeat).toBe(true);
    expect(deferred.job.state).toBe("awaiting_heartbeat");

    // Fresh heartbeat with the target build confirms the upgrade.
    await upsertBuild(RELEASE_SHA);
    const confirmed = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "succeeded",
      reportedBuildId: RELEASE_SHA,
    });
    expect(confirmed.awaitHeartbeat).toBeUndefined();
    expect(confirmed.job.state).toBe("succeeded");
    expect(confirmed.job.progress).toBe(100);
    expect(confirmed.job.result).toMatchObject({
      outcome: "succeeded",
      reportedBuildId: RELEASE_SHA,
      heartbeatBuildId: RELEASE_SHA,
    });
    expect(confirmed.job.completedAt).not.toBeNull();
  });

  it("accepts rolled_back only when the baseline heartbeat is verified", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    const restarting = await progressTo(claimed.job, cred, service, "restarting", 80);

    // Baseline build reporting again, fresh and after the swap point.
    await upsertBuild(BASELINE_SHA);
    const rolled = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "rolled_back",
      reportedBuildId: BASELINE_SHA,
    });
    expect(rolled.job.state).toBe("rolled_back");
    expect(rolled.job.result).toMatchObject({
      outcome: "rolled_back",
      heartbeatBuildId: BASELINE_SHA,
    });
    expect(restarting.state).toBe("restarting");
  });

  it("settles unverified rollbacks and allows a later refinement", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    await progressTo(claimed.job, cred, service, "restarting", 80);

    // Baseline heartbeat never advanced past the swap point → unverified.
    const unverified = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "rolled_back",
      reportedBuildId: BASELINE_SHA,
    });
    expect(unverified.job.state).toBe("rollback_unverified");
    expect(unverified.job.error?.code).toBe("rollback_unverified");

    // Late verification: baseline build fresh again → refine to rolled_back.
    await upsertBuild(BASELINE_SHA);
    const refined = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "rolled_back",
      reportedBuildId: BASELINE_SHA,
    });
    expect(refined.job.state).toBe("rolled_back");
    expect(refined.job.error).toBeNull();

    // Other outcomes on the refined terminal job are rejected.
    await expectHttpError(
      service.result(cred, job.id, {
        fencingToken: 1,
        outcome: "failed",
        reason: "late failure",
      }),
      409,
      "job_terminal",
    );
  });

  it("404s result for an unknown job", async () => {
    await localVps();
    const cred = await credential();
    const { service } = makeService();
    const caught = await service
      .result(cred, "lug_missingjob123", { fencingToken: 1, outcome: "failed" })
      .catch((e: unknown) => e);
    const body = (caught as { getResponse: () => ErrorBody }).getResponse();
    expect(body.error?.code).toBe("job_not_found");
  });
});

// ── reconciliation: deadlines & heartbeat success ───────────────────────

describe("reconciliation", () => {
  it("fails an unclaimed job at its phase deadline", async () => {
    await localVps();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);

    const current = (await lugRepo.get(job.id))!;
    await lugRepo.compareAndSet(job.id, current.revision, {
      phaseDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const ruled = await service.getJob(LOCAL_VPS_ID, job.id);
    expect(ruled.state).toBe("failed");
    expect(ruled.error?.code).toBe("claim_timeout");
    expect(ruled.result?.outcome).toBe("failed");
    expect(ruled.completedAt).not.toBeNull();
  });

  it("times out a pre-swap phase before the binary swap", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    const downloading = await progressTo(claimed.job, cred, service, "downloading", 20);

    await lugRepo.compareAndSet(job.id, downloading.revision, {
      phaseDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const ruled = await service.getJob(LOCAL_VPS_ID, job.id);
    expect(ruled.state).toBe("failed");
    expect(ruled.error?.code).toBe("phase_timeout");
    expect(ruled.result?.outcome).toBe("failed");
  });

  it("rules heartbeat_timeout on awaiting_heartbeat past deadline", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    let current = await progressTo(claimed.job, cred, service, "restarting", 80);
    current = await progressTo(current, cred, service, "awaiting_heartbeat", 90);

    await lugRepo.compareAndSet(job.id, current.revision, {
      phaseDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const ruled = await service.getJob(LOCAL_VPS_ID, job.id);
    expect(ruled.state).toBe("rollback_unverified");
    expect(ruled.error?.code).toBe("heartbeat_timeout");
    expect(ruled.result?.outcome).toBe("rollback_unverified");
  });

  it("auto-succeeds a post-swap job when the target build heartbeats", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    let current = await progressTo(claimed.job, cred, service, "restarting", 80);
    current = await progressTo(current, cred, service, "awaiting_heartbeat", 90);
    expect(current.state).toBe("awaiting_heartbeat");

    // The new binary identifies itself in a fresh heartbeat.
    await upsertBuild(RELEASE_SHA);
    const read = await service.getJob(LOCAL_VPS_ID, job.id);
    expect(read.state).toBe("succeeded");
    expect(read.progress).toBe(100);
    expect(read.result).toMatchObject({
      outcome: "succeeded",
      heartbeatBuildId: RELEASE_SHA,
    });
  });
});

// ── GET /agent-update state precedence ──────────────────────────────────

describe("getAgentUpdate", () => {
  it("reports release_unavailable when bundled agent is missing", async () => {
    await localVps();
    const { service, bundledAgent } = makeService();
    vi.mocked(bundledAgent.getMetadata).mockReturnValue(null);
    await upsertBuild(BASELINE_SHA);

    const view = await service.getAgentUpdate(LOCAL_VPS_ID);
    expect(view.state).toBe("release_unavailable");
    expect(view.compatibility.compatible).toBe(false);
    expect(view.compatibility.reason).toBe("release_unavailable");
    expect(view.available).toBeNull();
  });

  it("reports unknown without a fresh installed build", async () => {
    await localVps();
    const { service } = makeService();

    const missing = await service.getAgentUpdate(LOCAL_VPS_ID);
    expect(missing.state).toBe("unknown");

    await upsertBuild(BASELINE_SHA, 10 * 60_000); // stale heartbeat
    const stale = await service.getAgentUpdate(LOCAL_VPS_ID);
    expect(stale.state).toBe("unknown");
    expect(stale.installed.fresh).toBe(false);
  });

  it("reports current when the installed build matches the release", async () => {
    await localVps();
    const { service } = makeService();
    await upsertBuild(RELEASE_SHA);

    const view = await service.getAgentUpdate(LOCAL_VPS_ID);
    expect(view.state).toBe("current");
    expect(view.installed.buildId).toBe(RELEASE_SHA);
    expect(view.available?.releaseId).toBe(RELEASE_SHA);
    expect(view.compatibility.compatible).toBe(true);
    expect(view.compatibility.reason).toBe("ok");
  });

  it("reports incompatible when the reported architecture is unknown", async () => {
    await localVps();
    const { service, catalog } = makeService();
    await upsertBuild(BASELINE_SHA);
    await touchHeartbeat();
    // Reported but unmapped architecture: no safe default to query with.
    await agentRepo.upsertSystemInfo({
      vpsId: LOCAL_VPS_ID,
      kernel: { arch: "riscv64" },
    });

    const view = await service.getAgentUpdate(LOCAL_VPS_ID);
    expect(view.state).toBe("incompatible");
    expect(view.compatibility.compatible).toBe(false);
    expect(view.compatibility.reason).toBe("unsupported_architecture");
    expect(view.available).toBeNull();
    expect(catalog.getCompatibleRelease).not.toHaveBeenCalled();
  });

  it("reports updater_unavailable without a fresh updater heartbeat", async () => {
    await localVps();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getCompatibleRelease).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);

    const view = await service.getAgentUpdate(LOCAL_VPS_ID);
    expect(view.state).toBe("updater_unavailable");
    expect(view.updater.installed).toBe(false);
    expect(view.updater.healthy).toBe(false);
  });

  it("reports available with a healthy updater and the latest job", async () => {
    await localVps();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getCompatibleRelease).mockResolvedValue(okRelease() as never);
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    await touchHeartbeat();

    const { job } = await createJob(service);
    const view = await service.getAgentUpdate(LOCAL_VPS_ID);

    expect(view.state).toBe("available");
    expect(view.available).toMatchObject({
      releaseId: RELEASE_SHA,
      version: "1.4.0",
      buildId: RELEASE_SHA,
    });
    expect(view.available?.artifacts).toHaveLength(1);
    expect(view.compatibility.compatible).toBe(true);
    expect(view.updater).toMatchObject({ installed: true, healthy: true });
    expect(view.job?.id).toBe(job.id);
  });
});

// ── admin reads ─────────────────────────────────────────────────────────

describe("admin reads", () => {
  it("404s unknown jobs and lists jobs newest-first", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    await service.claim(cred);

    const listed = await service.listJobs(LOCAL_VPS_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(job.id);

    const caught = await service
      .getJob(LOCAL_VPS_ID, "lug_nope1234567")
      .catch((e: unknown) => e);
    const body = (caught as { getResponse: () => ErrorBody }).getResponse();
    expect(body.error?.code).toBe("job_not_found");
  });

  it("404s updater reads for jobs of another host", async () => {
    await localVps();
    const other = await vpsRepo.create({
      name: "other",
      host: "203.0.113.20",
      port: 22,
      username: "root",
    });
    const cred = await credential(other.id);
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await touchHeartbeat();
    await upsertBuild(BASELINE_SHA);
    const { job } = await service.createJob(LOCAL_VPS_ID, {
      releaseId: RELEASE_SHA,
    });

    const caught = await service
      .getUpdaterJob(cred, job.id)
      .catch((e: unknown) => e);
    const body = (caught as { getResponse: () => ErrorBody }).getResponse();
    expect(body.error?.code).toBe("job_not_found");
  });
});

// ── claim auditing (identifiers only, never secrets) ────────────────────

describe("claim auditing", () => {
  it("records which credential claimed the lease without secrets", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);

    const claimed = (await service.claim(cred))!;
    expect(claimed.job.fencingToken).toBe(1);

    const events = await readAudit("local_agent_upgrade.claim");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "system",
      action: "local_agent_upgrade.claim",
      resourceType: "vps",
      resourceId: LOCAL_VPS_ID,
      jobId: job.id,
      result: "success",
    });
    expect(events[0]?.metadata).toMatchObject({
      releaseId: RELEASE_SHA,
      credentialId: cred.id,
      fencingToken: 1,
      reclaimCount: 0,
      phase: "claimed",
    });
    // Identifiers only: no bearer material, hashes, or free-form secrets.
    expect(JSON.stringify(events[0])).not.toMatch(
      /secret|secretHash|authorization|bearer/i,
    );
  });

  it("does not duplicate claim audits on lease-valid replay", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await createJob(service);

    await service.claim(cred);
    await service.claim(cred);
    expect(await readAudit("local_agent_upgrade.claim")).toHaveLength(1);
  });
});

// ── concurrent create ───────────────────────────────────────────────────

describe("concurrent create", () => {
  it("serializes two racing creates onto one active job", async () => {
    await localVps();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await touchHeartbeat();
    await upsertBuild(BASELINE_SHA);

    const settled = await Promise.allSettled([
      service.createJob(
        LOCAL_VPS_ID,
        { releaseId: RELEASE_SHA },
        { idempotencyKey: "race-a" },
      ),
      service.createJob(
        LOCAL_VPS_ID,
        { releaseId: RELEASE_SHA },
        { idempotencyKey: "race-b" },
      ),
    ]);

    const wins = settled.filter(
      (r): r is PromiseFulfilledResult<CreateLocalUpgradeResult> =>
        r.status === "fulfilled",
    );
    const losses = settled.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(wins[0]!.value.created).toBe(true);
    // Loser sees the single-active rule with the winning job's id.
    const loser = losses[0]!.reason;
    expect(loser.getStatus()).toBe(409);
    expect(loser.getResponse().error.code).toBe("active_job_exists");
    expect(loser.getResponse().error.jobId).toBe(wins[0]!.value.job.id);
  });
});

// ── result replay idempotency ───────────────────────────────────────────

describe("result replay", () => {
  it("replays an identical terminal verdict instead of 409", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    await service.claim(cred);

    const first = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "failed",
      reason: "boom",
    });
    expect(first.job.state).toBe("failed");

    // Lost-response retry: same token, same verdict → committed ruling back.
    const replay = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "failed",
      reason: "boom",
    });
    expect(replay.job.id).toBe(job.id);
    expect(replay.job.state).toBe("failed");
    expect(replay.job.revision).toBe(first.job.revision);
    expect(replay.awaitHeartbeat).toBeUndefined();
  });

  it("rejects a conflicting verdict or stale token on a terminal job", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    await service.claim(cred);
    await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "failed",
      reason: "boom",
    });

    await expectHttpError(
      service.result(cred, job.id, {
        fencingToken: 1,
        outcome: "rolled_back",
      }),
      409,
      "job_terminal",
    );
    await expectHttpError(
      service.result(cred, job.id, { fencingToken: 99, outcome: "failed" }),
      409,
      "job_terminal",
    );
  });
});

// ── post-swap failure safety ────────────────────────────────────────────

describe("post-swap failure safety", () => {
  it("keeps a pre-swap failed report as failed", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);
    await service.claim(cred);

    const outcome = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "failed",
      reason: "checksum mismatch",
    });
    expect(outcome.job.state).toBe("failed");
    expect(outcome.job.error?.code).toBe("update_failed");
    expect(outcome.job.result?.outcome).toBe("failed");
    expect(outcome.job.completedAt).not.toBeNull();
  });

  it("settles a post-swap failed report as rollback_unverified", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    await progressTo(claimed.job, cred, service, "restarting", 80);

    // Updater-visible contract: still 200 with the settled job — never an
    // error code the updater cannot map (it only knows stale_lease and
    // job_terminal). The host must retain backup + journal.
    const outcome = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "failed",
      reason: "service would not start",
    });
    expect(outcome.job.state).toBe("rollback_unverified");
    expect(outcome.job.error?.code).toBe("post_swap_failed");
    expect(outcome.job.error?.message).toMatch(/binary swap/i);
    expect(outcome.job.result?.outcome).toBe("rollback_unverified");
    expect(outcome.job.completedAt).not.toBeNull();

    const rollbacks = await readAudit("local_agent_upgrade.rollback");
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]?.metadata).toMatchObject({
      reason: "service would not start",
      reportedOutcome: "failed",
    });

    // A retried post-swap failed report replays the settled ruling.
    const replay = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "failed",
      reason: "service would not start",
    });
    expect(replay.job.state).toBe("rollback_unverified");
    expect(replay.job.revision).toBe(outcome.job.revision);
  });

  it("settles a rolling_back failed report as rollback_unverified", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    await upsertBuild(BASELINE_SHA);
    const { job } = await createJob(service);
    const claimed = (await service.claim(cred))!;
    const restarting = await progressTo(
      claimed.job,
      cred,
      service,
      "restarting",
      80,
    );
    await service.progress(cred, job.id, {
      fencingToken: 1,
      phase: "rolling_back",
      progress: 50,
    });
    expect(restarting.state).toBe("restarting");

    const outcome = await service.result(cred, job.id, {
      fencingToken: 1,
      outcome: "failed",
      reason: "rollback helper crashed",
    });
    expect(outcome.job.state).toBe("rollback_unverified");
    expect(outcome.job.error?.code).toBe("post_swap_failed");
    expect(outcome.job.result?.outcome).toBe("rollback_unverified");
  });
});

// ── restart / multi-instance ────────────────────────────────────────────

describe("restart resilience", () => {
  it("a fresh service instance continues the durable job", async () => {
    await localVps();
    const cred = await credential();
    const { service, catalog, bundledAgent } = makeService();
    vi.mocked(catalog.getReleaseById).mockResolvedValue(okRelease() as never);
    const { job } = await createJob(service);

    // Fresh objects over the same store: the service holds no in-memory
    // coordinator, so a restarted API (or a second instance) sees the job.
    const config: AppConfig = {
      ...baseConfig,
      mode: "local",
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    };
    const restarted = new LocalUpgradeService(
      config,
      createJsonLocalUpgradeRepository(
        join(tempDir, "data", "local-upgrades.json"),
      ),
      createJsonAgentRepository(join(tempDir, "data", "agents.json")),
      createVpsStore(join(tempDir, "data", "vps.json")),
      bundledAgent,
      new AuditService(
        config,
        createJsonAuditRepository(join(tempDir, "data", "audit.json")),
      ),
    );

    const claimed = await restarted.claim(cred);
    expect(claimed?.job.id).toBe(job.id);
    expect(claimed?.job.fencingToken).toBe(1);
    expect(claimed?.requiresReconcile).toBe(false);
  });
});
