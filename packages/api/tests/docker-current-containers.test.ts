import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNestApp } from "../src/app.js";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AppConfig } from "../src/config/app-config.js";
import { ConflictException } from "@nestjs/common";
import { DockerMonitoringService } from "../src/docker/docker-monitoring.service.js";
import {
  DOCKER_INGEST_DIGEST_VERSION,
  DOCKER_INGEST_LEGACY_DIGEST_VERSION,
  dockerIngestRequestDigest,
} from "../src/docker/docker-monitoring.schemas.js";
import type { DockerIngestUnit } from "../src/docker/docker-monitoring.models.js";
import type { AgentDockerMetricsInput } from "../src/agents/agent.models.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import {
  createJsonDockerMonitoringRepository,
  seedDockerMonitoringForTests,
} from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createSessionCookie } from "./test-helpers.js";

// ── Current containers (latest committed snapshot) + name persistence ─────
// The endpoint derives rows from container samples of the newest snapshot
// only: stale authoritative ingest state (latestByVps) and the legacy
// agent_docker_metrics projection must never influence the response.

const SESSION_SECRET = "docker-monitoring-api-test-secret-32chars";

const baseConfig: AppConfig = {
  mode: "local",
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
  dashboardSessionSecret: SESSION_SECRET,
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  dockerRetentionDays: 7,
  dockerMaintenanceSamplesPerVps: 5000,
  dockerMaintenanceEventsPerVps: 10000,
  dockerMaintenanceIntervalSeconds: 21600,
  dockerJsonMaxBytes: 32 * 1024 * 1024,
  dockerJsonMaintenanceMaxRewriteBytes: 8 * 1024 * 1024,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

const T_OLD = "2026-09-10T00:00:00.000Z";
const T_NEW = "2026-09-12T00:00:00.000Z";

let tempDir: string;
let server: Express;
let app: NestExpressApplication;
let sessionCookie: string;
let vpsA = "";
let vpsB = "";
let vpsEmpty = "";
let vpsBroken = "";

function sample(
  id: string,
  vpsId: string,
  effectiveAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    vpsId,
    agentInstanceId: "inst1",
    snapshotId: `snap_${id}`,
    collectedAt: effectiveAt,
    receivedAt: effectiveAt,
    effectiveAt,
    metrics: { cpuPercent: 1, memoryUsageBytes: 64, pids: 2 },
    ...extra,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-current-containers-"));
  const dataDir = join(tempDir, "data");

  const store = createVpsStore(join(dataDir, "vps.json"));
  const createdA = await store.create({
    name: "current-a",
    host: "203.0.113.20",
    port: 22,
    username: "root",
  });
  const createdB = await store.create({
    name: "current-b",
    host: "203.0.113.21",
    port: 22,
    username: "root",
  });
  const createdEmpty = await store.create({
    name: "current-empty",
    host: "203.0.113.22",
    port: 22,
    username: "root",
  });
  const createdBroken = await store.create({
    name: "current-broken",
    host: "203.0.113.23",
    port: 22,
    username: "root",
  });
  vpsA = createdA.id;
  vpsB = createdB.id;
  vpsEmpty = createdEmpty.id;
  vpsBroken = createdBroken.id;

  // Enable actions on A and BROKEN; B keeps default management consent off.
  // `dockerMetricsEnabled` stays at its default (false) to prove identity
  // discovery does not depend on monitoring or action consent.
  await store.update(vpsA, { dockerManagementEnabled: true });
  await store.update(vpsBroken, { dockerManagementEnabled: true });

  await seedDockerMonitoringForTests(
    join(dataDir, "docker-monitoring.json"),
    {
      samples: [
        // VPS A, stale snapshot: a container that was recreated since.
        sample("ha_old", vpsA, T_OLD, { snapshotId: "snap_a_old" }),
        sample("ck_old", vpsA, T_OLD, {
          snapshotId: "snap_a_old",
          containerKey: "ck_old",
          name: "legacy-old",
          state: "exited",
        }),
        // VPS A, latest committed snapshot: recreated key, one row without name.
        sample("ha_new", vpsA, T_NEW, { snapshotId: "snap_a_new" }),
        sample("ck_web", vpsA, T_NEW, {
          snapshotId: "snap_a_new",
          containerKey: "ck_web",
          name: "web",
          state: "running",
        }),
        sample("ck_plain", vpsA, T_NEW, {
          snapshotId: "snap_a_new",
          containerKey: "ck_plain",
        }),
        // VPS B, isolated.
        sample("hb_new", vpsB, T_NEW, {
          agentInstanceId: "instB",
          snapshotId: "snap_b_new",
        }),
        sample("ck_b", vpsB, T_NEW, {
          agentInstanceId: "instB",
          snapshotId: "snap_b_new",
          containerKey: "ck_b",
          name: "service-b",
          state: "running",
        }),
        // VPS BROKEN, snapshot rows that cannot form a stream identity pair.
        // Malformed keys must be dropped rather than fixed up or guessed.
        sample("hb_broken", vpsBroken, T_NEW, {
          agentInstanceId: "inst2",
          snapshotId: "snap_broken",
        }),
        sample("ck_bad_chars", vpsBroken, T_NEW, {
          agentInstanceId: "inst2",
          snapshotId: "snap_broken",
          containerKey: "ck/bad key",
          name: "bad-key",
        }),
        sample("ck_too_long", vpsBroken, T_NEW, {
          agentInstanceId: "inst2",
          snapshotId: "snap_broken",
          containerKey: "c".repeat(33),
          name: "too-long",
        }),
        sample("ck_noname", vpsBroken, T_NEW, {
          agentInstanceId: "inst2",
          snapshotId: "snap_broken",
          containerKey: "ck_noname",
        }),
        sample("ck_ok", vpsBroken, T_NEW, {
          agentInstanceId: "inst2",
          snapshotId: "snap_broken",
          containerKey: "ck_ok",
          name: "kept",
          image: "redis:7",
          state: "running",
        }),
      ],
      latestByVps: {
        // Authoritative ingest state deliberately points at the STALE
        // snapshot: it must not change what the endpoint returns.
        [vpsA]: {
          activeInstanceId: "inst1",
          snapshotId: "snap_a_old",
          sourceSequence: "5",
          receivedAt: T_OLD,
          updatedAt: T_OLD,
          revision: 7,
        },
      },
    },
  );

  sessionCookie = await createSessionCookie(tempDir, SESSION_SECRET);
  app = await createNestApp({
    config: {
      ...baseConfig,
      dataDir,
      privateDir: join(tempDir, "private"),
    },
  });
  server = app.getHttpAdapter().getInstance();
});

afterEach(async () => {
  await app?.close();
  await rm(tempDir, { recursive: true, force: true });
});

function authed(req: request.Test) {
  return req.set("Cookie", sessionCookie);
}

describe("GET /api/vps/:id/docker/containers/current", () => {
  it("returns only the latest snapshot's containers, ordered by containerKey", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/containers/current`),
    ).expect(200);

    // Exact response contract, exact key sets: rows without a stored name
    // must omit the key entirely (never name: null), and the stale
    // latestByVps entry (snap_a_old) must not surface ck_old.
    expect(res.body).toEqual({
      data: [
        {
          agentInstanceId: "inst1",
          containerKey: "ck_plain",
          collectedAt: T_NEW,
          metrics: { cpuPercent: 1, memoryUsageBytes: 64, pids: 2 },
        },
        {
          agentInstanceId: "inst1",
          containerKey: "ck_web",
          name: "web",
          state: "running",
          collectedAt: T_NEW,
          metrics: { cpuPercent: 1, memoryUsageBytes: 64, pids: 2 },
        },
      ],
    });
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      "agentInstanceId", "collectedAt", "containerKey", "metrics",
    ]);
    expect(res.body.data.map((c: { containerKey: string }) => c.containerKey)).toEqual([
      "ck_plain",
      "ck_web",
    ]);
    expect(
      res.body.data.some(
        (c: { containerKey: string }) => c.containerKey === "ck_old",
      ),
    ).toBe(false);
  });

  it("keeps history rows readable for the recreated key of the latest snapshot", async () => {
    const res = await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/instances/inst1/containers/ck_web/history`,
      ),
    ).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      containerKey: "ck_web",
      snapshotId: "snap_a_new",
      name: "web",
      state: "running",
    });
  });

  it("does not leak containers across VPS", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsB}/docker/containers/current`),
    ).expect(200);
    expect(res.body).toEqual({
      data: [
        {
          agentInstanceId: "instB",
          containerKey: "ck_b",
          name: "service-b",
          state: "running",
          collectedAt: T_NEW,
          metrics: { cpuPercent: 1, memoryUsageBytes: 64, pids: 2 },
        },
      ],
    });
  });

  it("returns {data: []} when the VPS has no samples", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/containers/current`),
    ).expect(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("returns 404 for an unknown VPS", async () => {
    await authed(
      request(server).get(
        "/api/vps/vps_missing_does_not_exist/docker/containers/current",
      ),
    ).expect(404, { error: { message: "VPS not found" } });
  });

  it("rejects unauthenticated reads with 401", async () => {
    await request(server)
      .get(`/api/vps/${vpsA}/docker/containers/current`)
      .expect(401);
  });
});

// ── Ingest persists `name` while request digests stay byte-identical ──────

function ingestFixture(nameOverride?: string): AgentDockerMetricsInput {
  return {
    collectedAt: "2026-09-15T12:00:00.000Z",
    schemaVersion: 2,
    agentInstanceId: "inst_golden",
    snapshotId: "snap_golden",
    sourceSequence: "1",
    available: true,
    containerTotal: 2,
    containerRunning: 2,
    cpuPercent: 3.5,
    memoryUsageBytes: 1024,
    networkRxBytes: 10,
    networkTxBytes: 20,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    pids: 42,
    containers: [
      {
        containerKey: "ck_alpha",
        name: nameOverride ?? "web",
        image: "nginx:1.25",
        state: "running",
        health: "healthy",
        cpuPercent: 1.5,
        memoryUsageBytes: 512,
        memoryLimitBytes: 2048,
        networkRxBytes: 1,
        networkTxBytes: 2,
        blockReadBytes: 3,
        blockWriteBytes: 4,
        pids: 5,
      },
      {
        containerKey: "ck_beta",
        name: "cache",
        image: "redis:7",
        state: "running",
        cpuPercent: 0.5,
        memoryUsageBytes: 128,
        networkRxBytes: 6,
        networkTxBytes: 7,
        blockReadBytes: 8,
        blockWriteBytes: 9,
        pids: 10,
      },
    ],
  } as unknown as AgentDockerMetricsInput;
}

// Captured from this exact fixture against the digest projection BEFORE name
// persistence was added (DOCKER_INGEST_DIGEST_VERSION = 1). Batch digests
// recorded by earlier builds must keep matching, or replay dedupe breaks
// across the deploy boundary.
const GOLDEN_REQUEST_DIGEST =
  "113165755ce69e514a530990ab5eddc1b8684d7e365d7e366cde35650715228c";

const RECEIVED_AT = "2026-09-15T12:00:01.000Z";
const RECEIVED_AT2 = "2026-09-15T12:00:02.000Z";

function eventfulFixture(
  overrides: Partial<AgentDockerMetricsInput> = {},
): AgentDockerMetricsInput {
  return {
    ...ingestFixture(),
    batchId: "batch-golden",
    events: [
      {
        eventId: "ev-1",
        eventOccurredAt: "2026-09-15T12:00:00.000Z",
        containerKey: "ck_alpha",
        action: "start",
        context: { version: 1 },
      },
    ],
    eventWindow: { since: "0", until: "10", capped: false, lossy: false },
    fromWatermark: { timeNano: "0", boundaryDigests: [] },
    proposedWatermark: { timeNano: "10", boundaryDigests: [] },
    ...overrides,
  } as unknown as AgentDockerMetricsInput;
}

function capturingService() {
  const units: DockerIngestUnit[] = [];
  const repository = {
    ingestUnit: vi.fn(async (unit: DockerIngestUnit) => {
      units.push(unit);
      return {
        vpsId: unit.vpsId,
        ingestStatus: "committed" as const,
        snapshotId: unit.snapshotId,
        agentInstanceId: unit.agentInstanceId,
        receivedAt: unit.receivedAt,
        revision: 1,
      };
    }),
  };
  const service = new DockerMonitoringService(
    repository as never,
    { get: vi.fn(async () => ({ id: "vps-golden" })) } as never,
  );
  return { service, units };
}

// ── Capability targets (viewer identity discovery) ────────────────────────
// capability() projects the latest committed snapshot into the (containerKey,
// agentInstanceId) pairs the viewer can target. Discovery is not gated by
// dockerMetricsEnabled, but every Docker action still is.

describe("GET /api/vps/:id/docker/management/capability", () => {
  it("returns canonical valid-pair targets in snapshot order", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/management/capability`),
    ).expect(200);
    expect(res.body).toEqual({
      supported: true,
      actions: ["start", "stop", "restart"],
      logsSupported: true,
      maxLogLines: 200,
      targets: [
        { containerKey: "ck_plain", name: "ck_plain", agentInstanceId: "inst1" },
        { containerKey: "ck_web", name: "web", state: "running", agentInstanceId: "inst1" },
      ],
    });
  });

  it("drops rows whose containerKey violates the opaque charset or length", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsBroken}/docker/management/capability`),
    ).expect(200);
    expect(res.body.targets).toEqual([
      { containerKey: "ck_noname", name: "ck_noname", agentInstanceId: "inst2" },
      { containerKey: "ck_ok", name: "kept", image: "redis:7", state: "running", agentInstanceId: "inst2" },
    ]);
  });

  it("keeps capability and target discovery available with monitoring disabled", async () => {
    // vpsA has dockerMetricsEnabled at its default (false): capability must
    // still resolve, because identity is not monitoring data.
    const res = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/management/capability`),
    ).expect(200);
    expect(res.body.supported).toBe(true);
    expect(res.body.targets).toHaveLength(2);
  });

  it("supports logs without management consent even with no snapshot", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/management/capability`),
    ).expect(200);
    expect(res.body).toEqual({
      supported: false,
      reason: "Docker management is disabled",
      actions: [],
      logsSupported: true,
      maxLogLines: 200,
      targets: [],
    });
  });

  it("returns committed log targets with default management consent off", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsB}/docker/management/capability`),
    ).expect(200);
    expect(res.body).toEqual({
      supported: false,
      reason: "Docker management is disabled",
      actions: [],
      logsSupported: true,
      maxLogLines: 200,
      targets: [{ containerKey: "ck_b", name: "service-b", state: "running", agentInstanceId: "instB" }],
    });
  });

  it("returns no targets when there is no committed snapshot", async () => {
    const current = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/containers/current`),
    ).expect(200);
    expect(current.body).toEqual({ data: [] });
    const res = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/management/capability`),
    ).expect(200);
    expect(res.body.targets).toEqual([]);
  });

  it("returns 404 for an unknown VPS", async () => {
    await authed(
      request(server).get(
        "/api/vps/vps_missing_does_not_exist/docker/management/capability",
      ),
    ).expect(404, { error: { message: "VPS not found" } });
  });

  it("rejects unauthenticated capability reads with 401", async () => {
    await request(server)
      .get(`/api/vps/${vpsA}/docker/management/capability`)
      .expect(401);
  });
});

describe("docker ingest container name persistence", () => {
  it("maps the incoming container name onto persisted samples", async () => {
    const { service, units } = capturingService();
    await service.ingest("vps-golden", ingestFixture(), RECEIVED_AT);

    const alpha = units[0]!.containerSamples.find(
      (s) => s.containerKey === "ck_alpha",
    );
    expect(alpha).toMatchObject({
      containerKey: "ck_alpha",
      name: "web",
      state: "running",
    });
    expect(alpha).toHaveProperty("name", "web");
  });

  it("produces the pre-name golden digest and ignores name-only differences", async () => {
    const { service, units } = capturingService();
    await service.ingest("vps-golden", ingestFixture("web"), RECEIVED_AT);
    await service.ingest(
      "vps-golden",
      ingestFixture("renamed_web"),
      RECEIVED_AT,
    );

    // v1 projection rebuilt with the original receive timestamp still matches
    // the pre-name golden; v2 minimal projection strips name/image/status.
    expect(units[0]!.requestDigestVersion).toBe(DOCKER_INGEST_DIGEST_VERSION);
    expect(units[0]!.legacyRequestDigest?.(RECEIVED_AT)).toBe(
      GOLDEN_REQUEST_DIGEST,
    );
    expect(
      dockerIngestRequestDigest({}, DOCKER_INGEST_LEGACY_DIGEST_VERSION),
    ).not.toBe(dockerIngestRequestDigest({}));
    // `name` is presentation metadata, never request identity.
    expect(units[1]!.requestDigest).toBe(units[0]!.requestDigest);
    expect(units[1]!.requestDigest).not.toBe(GOLDEN_REQUEST_DIGEST);
    expect(units[1]!.legacyRequestDigest?.(RECEIVED_AT)).toBe(
      GOLDEN_REQUEST_DIGEST,
    );
  });

  it("includes details in request identity while absent details remain legacy-stable", async () => {
    const { service, units } = capturingService();
    await service.ingest("vps-golden", ingestFixture(), RECEIVED_AT);
    const details = {
      collectedAt: "2026-09-15T12:00:00.500Z",
      status: "available",
      ports: [],
      mounts: [],
      networks: [],
      healthcheck: { status: "none" },
    };
    const withDetails = {
      ...ingestFixture(),
      containers: ingestFixture().containers.map((c) => ({
        ...c,
        ...(c.containerKey === "ck_alpha" ? { details } : {}),
      })),
    } as AgentDockerMetricsInput;
    await service.ingest("vps-golden", withDetails, RECEIVED_AT);
    expect(units[0]!.legacyRequestDigest?.(RECEIVED_AT)).toBe(GOLDEN_REQUEST_DIGEST);
    expect(units[1]!.requestDigest).not.toBe(units[0]!.requestDigest);
    expect(units[1]!.containerSamples.find((s) => s.containerKey === "ck_alpha")?.details).toEqual(details);
  });

  it("round-trips persisted names through listCurrentContainers and dedupes replays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-manager-current-ingest-"));
    try {
      const repo = createJsonDockerMonitoringRepository(
        join(dir, "docker-monitoring.json"),
      );
      const service = new DockerMonitoringService(
        repo as never,
        { get: vi.fn(async () => ({ id: "vps-golden" })) } as never,
      );

      const details = {
        collectedAt: "2026-09-15T12:00:00.500Z",
        status: "available" as const,
        ports: [],
        mounts: [],
        networks: [],
        healthcheck: { status: "none" as const },
      };
      const fixture = {
        ...ingestFixture(),
        containers: ingestFixture().containers.map((c) => ({
          ...c,
          ...(c.containerKey === "ck_alpha" ? { details } : {}),
        })),
      } as AgentDockerMetricsInput;
      const first = await service.ingest("vps-golden", fixture, RECEIVED_AT);
      expect(first.ingestStatus).toBe("committed");

      // Ingested names flow through the store into the current read.
      expect(await service.currentContainers("vps-golden")).toEqual([
        {
          agentInstanceId: "inst_golden",
          containerKey: "ck_alpha",
          name: "web",
          state: "running",
          image: "nginx:1.25",
          collectedAt: "2026-09-15T12:00:00.000Z",
          details,
          metrics: { cpuPercent: 1.5, memoryUsageBytes: 512, pids: 5 },
        },
        {
          agentInstanceId: "inst_golden",
          containerKey: "ck_beta",
          name: "cache",
          state: "running",
          image: "redis:7",
          collectedAt: "2026-09-15T12:00:00.000Z",
          metrics: { cpuPercent: 0.5, memoryUsageBytes: 128, pids: 10 },
        },
      ]);

      // Identical detail replay is idempotent; changing details conflicts.
      const replay = await service.ingest("vps-golden", fixture, RECEIVED_AT);
      expect(replay.ingestStatus).toBe("already_committed");
      const changed = {
        ...fixture,
        containers: fixture.containers.map((c) => ({
          ...c,
          ...(c.containerKey === "ck_alpha" ? { details: { ...details, oomKilled: true } } : {}),
        })),
      } as AgentDockerMetricsInput;
      await expect(service.ingest("vps-golden", changed, RECEIVED_AT)).rejects.toMatchObject({
        response: expect.objectContaining({ error: expect.objectContaining({ code: "snapshot_conflict" }) }),
      });
      expect(await service.currentContainers("vps-golden")).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a repeated payload with a different receivedAt without extra samples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-manager-current-replay-"));
    try {
      const repo = createJsonDockerMonitoringRepository(
        join(dir, "docker-monitoring.json"),
      );
      const service = new DockerMonitoringService(
        repo as never,
        { get: vi.fn(async () => ({ id: "vps-golden" })) } as never,
      );
      const first = await service.ingest(
        "vps-golden",
        ingestFixture(),
        RECEIVED_AT,
      );
      expect(first.ingestStatus).toBe("committed");
      const replay = await service.ingest(
        "vps-golden",
        ingestFixture(),
        RECEIVED_AT2,
      );
      expect(replay.ingestStatus).toBe("already_committed");
      expect(replay.snapshotId).toBe(first.snapshotId);
      expect(await service.currentContainers("vps-golden")).toHaveLength(2);
      expect(
        (await repo.listHostSamples({ vpsId: "vps-golden" })).data,
      ).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a changed CPU with snapshot_conflict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-manager-current-cpu-"));
    try {
      const repo = createJsonDockerMonitoringRepository(
        join(dir, "docker-monitoring.json"),
      );
      const service = new DockerMonitoringService(
        repo as never,
        { get: vi.fn(async () => ({ id: "vps-golden" })) } as never,
      );
      await service.ingest("vps-golden", ingestFixture(), RECEIVED_AT);
      try {
        await service.ingest(
          "vps-golden",
          { ...ingestFixture(), cpuPercent: 99.9 },
          RECEIVED_AT2,
        );
        expect.unreachable("changed CPU must conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const response = (
          error as InstanceType<typeof ConflictException>
        ).getResponse() as { error?: { code?: string } };
        expect(response.error?.code).toBe("snapshot_conflict");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a v2 replay of a v1 commit via the original receive timestamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-manager-current-legacy-"));
    try {
      const repo = createJsonDockerMonitoringRepository(
        join(dir, "docker-monitoring.json"),
      );
      const service = new DockerMonitoringService(
        repo as never,
        { get: vi.fn(async () => ({ id: "vps-golden" })) } as never,
      );
      const { service: capSvc, units: capUnits } = capturingService();
      await capSvc.ingest("vps-golden", ingestFixture(), RECEIVED_AT);
      const v1Digest = capUnits[0]!.legacyRequestDigest!(RECEIVED_AT);
      expect(v1Digest).toBe(GOLDEN_REQUEST_DIGEST);
      const v1Unit = {
        ...capUnits[0]!,
        vpsId: "vps-golden",
        requestDigest: v1Digest,
        requestDigestVersion: 1 as const,
        receivedAt: RECEIVED_AT,
      };
      const committed = await repo.ingestUnit(v1Unit);
      expect(committed.ingestStatus).toBe("committed");
      const replay = await service.ingest(
        "vps-golden",
        ingestFixture(),
        RECEIVED_AT2,
      );
      expect(replay.ingestStatus).toBe("already_committed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a legacy replay with the wrong proposed watermark", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vps-manager-current-wm-"));
    try {
      const repo = createJsonDockerMonitoringRepository(
        join(dir, "docker-monitoring.json"),
      );
      const service = new DockerMonitoringService(
        repo as never,
        { get: vi.fn(async () => ({ id: "vps-golden" })) } as never,
      );
      const { service: capSvc, units: capUnits } = capturingService();
      await capSvc.ingest("vps-golden", eventfulFixture(), RECEIVED_AT);
      const v1Digest = capUnits[0]!.legacyRequestDigest!(RECEIVED_AT);
      const v1Unit = {
        ...capUnits[0]!,
        vpsId: "vps-golden",
        requestDigest: v1Digest,
        requestDigestVersion: 1 as const,
        receivedAt: RECEIVED_AT,
      };
      await repo.ingestUnit(v1Unit);
      const ok = await service.ingest(
        "vps-golden",
        eventfulFixture(),
        RECEIVED_AT2,
      );
      expect(ok.ingestStatus).toBe("already_committed");
      try {
        await service.ingest(
          "vps-golden",
          eventfulFixture({
            proposedWatermark: { timeNano: "11", boundaryDigests: [] },
          }),
          "2026-09-15T12:00:03.000Z",
        );
        expect.unreachable("wrong watermark must conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const response = (
          error as InstanceType<typeof ConflictException>
        ).getResponse() as { error?: { code?: string } };
        expect(response.error?.code).toBe("snapshot_conflict");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats eventProtocol and available as v2 digest identity", async () => {
    const { service, units } = capturingService();
    await service.ingest("vps-golden", ingestFixture(), RECEIVED_AT);
    await service.ingest("vps-golden", eventfulFixture(), RECEIVED_AT);
    expect(units[1]!.requestDigest).not.toBe(units[0]!.requestDigest);

    const second = capturingService();
    await second.service.ingest("vps-golden", ingestFixture(), RECEIVED_AT);
    await second.service.ingest(
      "vps-golden",
      { ...ingestFixture(), available: false },
      RECEIVED_AT,
    );
    expect(second.units[1]!.requestDigest).not.toBe(
      second.units[0]!.requestDigest,
    );
  });
});
