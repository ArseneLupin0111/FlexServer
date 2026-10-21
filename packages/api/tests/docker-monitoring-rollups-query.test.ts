import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import {
  createJsonDockerMonitoringRepository,
  seedDockerMonitoringForTests,
} from "../src/persistence/repositories/docker-monitoring.repository.js";
import {
  dockerRollupsQuerySchema,
  normalizeDockerDateRange,
  MAX_QUERY_RANGE_MS,
} from "../src/docker/docker-monitoring.schemas.js";
import type { DockerMetricRollup } from "../src/docker/docker-monitoring.models.js";
import { createApp, closeTestApps, createSessionCookie } from "./test-helpers.js";

// ── Docker Monitoring rollup query API (bounded REST over existing storage) ─
// Focused slice: strict from/to validation + 30d max range (shared policy),
// stable (bucketStart,id) keyset pagination consistent with listRollups,
// JSON/Postgres parity of repository filters (from/to on bucketStart).

const SESSION_SECRET = "docker-monitoring-rollups-query-secret-32c";
const B1 = "2026-09-10T00:00:00.000Z";
const B2 = "2026-09-11T00:00:00.000Z";
const B3 = "2026-09-12T00:00:00.000Z";

function rollup(id: string, vpsId: string, bucketStart: string, extra: Partial<DockerMetricRollup> = {}): DockerMetricRollup {
  return {
    id,
    vpsId,
    agentInstanceId: "inst1",
    scope: "host",
    metricName: "cpuPercent",
    bucketStart,
    formulaVersion: 1,
    firstAt: bucketStart,
    lastAt: bucketStart,
    sampleCount: 2,
    resetCount: 0,
    expectedSamples: 2,
    observedSamples: 2,
    partialSampleCount: 0,
    gapCount: 0,
    coverageRatio: 1,
    ...extra,
  };
}

describe("dockerRollupsQuerySchema validation", () => {
  it("accepts bounded two-sided windows and defaults limit", () => {
    const parsed = dockerRollupsQuerySchema.parse({ vpsId: "v", from: B1, to: B2 });
    expect(parsed.limit).toBe(100);
    expect(parsed.from).toBe(B1);
  });

  it("rejects inverted and over-30d ranges with 400-class Zod errors", () => {
    expect(() => dockerRollupsQuerySchema.parse({ vpsId: "v", from: B2, to: B1 })).toThrow();
    expect(() =>
      dockerRollupsQuerySchema.parse({ vpsId: "v", from: "2026-01-01T00:00:00.000Z", to: "2026-02-15T00:00:00.000Z" }),
    ).toThrow();
  });

  it("accepts to-only queries; service normalization bounds them to [to-30d, to]", () => {
    const parsed = dockerRollupsQuerySchema.parse({ vpsId: "v", to: "2025-01-15T00:00:00.000Z" });
    expect(parsed.from).toBeUndefined();
    const normalized = normalizeDockerDateRange(parsed);
    expect(normalized.from).toBe(
      new Date(Date.parse("2025-01-15T00:00:00.000Z") - MAX_QUERY_RANGE_MS).toISOString(),
    );
  });

  it("enforces limit caps and strict unknown params", () => {
    expect(() => dockerRollupsQuerySchema.parse({ vpsId: "v", limit: 501 })).toThrow();
    expect(() => dockerRollupsQuerySchema.parse({ vpsId: "v", limit: 0 })).toThrow();
    expect(() => dockerRollupsQuerySchema.parse({ vpsId: "v", bogus: "x" })).toThrow();
  });

  it("requires agentInstanceId and containerKey together", () => {
    expect(() => dockerRollupsQuerySchema.parse({ vpsId: "v", containerKey: "ck1" })).toThrow();
    expect(() =>
      dockerRollupsQuerySchema.parse({ vpsId: "v", agentInstanceId: "inst1", containerKey: "ck1" }),
    ).not.toThrow();
  });
});

describe("JSON listRollups query parity (from/to, filters, stable pagination)", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "docker-rollups-q-")); });
  afterEach(async () => { await closeTestApps(); await rm(dir, { recursive: true, force: true }); });

  function repo() {
    const file = join(dir, `docker-monitoring-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    return { file, repo: createJsonDockerMonitoringRepository(file) };
  }

  it("filters by bucketStart range newest-first", async () => {
    const { file, repo: r } = repo();
    await seedDockerMonitoringForTests(file, {
      rollups: [rollup("r1", "vps-a", B1), rollup("r2", "vps-a", B2), rollup("r3", "vps-a", B3)],
    });
    const page = await r.listRollups({ vpsId: "vps-a", from: B2, to: B3 });
    expect(page.data.map((x) => x.id)).toEqual(["r3", "r2"]);
  });

  it("walks the full set with stable (bucketStart,id) cursors; filter change rejects cursor", async () => {
    const { file, repo: r } = repo();
    await seedDockerMonitoringForTests(file, {
      rollups: [rollup("r1", "vps-a", B1), rollup("r2", "vps-a", B2), rollup("r3", "vps-a", B3)],
    });
    const first = await r.listRollups({ vpsId: "vps-a", limit: 1 });
    expect(first.data.map((x) => x.id)).toEqual(["r3"]);
    expect(first.page.hasMore).toBe(true);
    const second = await r.listRollups({ vpsId: "vps-a", limit: 1, cursor: first.page.nextCursor });
    expect(second.data.map((x) => x.id)).toEqual(["r2"]);
    const third = await r.listRollups({ vpsId: "vps-a", limit: 1, cursor: second.page.nextCursor });
    expect(third.data.map((x) => x.id)).toEqual(["r1"]);
    expect(third.page.hasMore).toBe(false);
    await expect(
      r.listRollups({ vpsId: "vps-a", limit: 1, cursor: first.page.nextCursor, from: B1, to: B1 }),
    ).rejects.toThrow();
    await expect(r.listRollups({ vpsId: "vps-a", cursor: "!!!not-base64!!!" })).rejects.toThrow();
  });

  it("isolates VPSs and honors scope/instance/container filters", async () => {
    const { file, repo: r } = repo();
    await seedDockerMonitoringForTests(file, {
      rollups: [
        rollup("h1", "vps-a", B2),
        rollup("c1", "vps-a", B2, { id: "c1", scope: "container", containerKey: "ck1" }),
        rollup("h2", "vps-b", B2),
      ],
    });
    expect((await r.listRollups({ vpsId: "vps-b" })).data.map((x) => x.id)).toEqual(["h2"]);
    expect(
      (await r.listRollups({ vpsId: "vps-a", scope: "container", agentInstanceId: "inst1", containerKey: "ck1" })).data.map((x) => x.id),
    ).toEqual(["c1"]);
    expect((await r.listRollups({ vpsId: "vps-a", agentInstanceId: "other" })).data).toEqual([]);
  });
});

describe("GET /api/vps/:id/docker/rollups", () => {
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
    sshHostKeyPins: {},
    sshHostKeyPolicy: "strict",
  };

  let tempDir = "";
  let server: Express;
  let sessionCookie = "";
  let vpsA = "";
  let vpsEmpty = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vps-manager-docker-rollups-api-"));
    const dataDir = join(tempDir, "data");
    const store = createVpsStore(join(dataDir, "vps.json"));
    vpsA = (await store.create({ name: "docker-a", host: "203.0.113.10", port: 22, username: "root" })).id;
    vpsEmpty = (await store.create({ name: "docker-empty", host: "203.0.113.12", port: 22, username: "root" })).id;
    await seedDockerMonitoringForTests(join(dataDir, "docker-monitoring.json"), {
      rollups: [
        { ...rollup("ra1", vpsA, B1), agentInstanceId: "inst1" },
        { ...rollup("ra2", vpsA, B2), agentInstanceId: "inst1" },
        { ...rollup("ra3", vpsA, B3), agentInstanceId: "inst1" },
      ],
    });
    sessionCookie = await createSessionCookie(tempDir, SESSION_SECRET);
    server = createApp({ config: { ...baseConfig, dataDir, privateDir: join(tempDir, "private") } });
  });

  afterEach(async () => { await closeTestApps(); await rm(tempDir, { recursive: true, force: true }); });

  function authed(req: request.Test) { return req.set("Cookie", sessionCookie); }

  it("requires auth and checks VPS existence before reads", async () => {
    await request(server).get(`/api/vps/${vpsA}/docker/rollups`).expect(401);
    await authed(request(server).get(`/api/vps/vps_missing_does_not_exist/docker/rollups`)).expect(404);
  });

  it("returns empty {data,page} shape and paginates newest-first", async () => {
    const empty = await authed(request(server).get(`/api/vps/${vpsEmpty}/docker/rollups`)).expect(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.page.hasMore).toBe(false);

    const first = await authed(request(server).get(`/api/vps/${vpsA}/docker/rollups?limit=1`)).expect(200);
    expect(first.body.data.map((r: { id: string }) => r.id)).toEqual(["ra3"]);
    expect(first.body.page).toMatchObject({ limit: 1, hasMore: true });
    const second = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/rollups?limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor)}`),
    ).expect(200);
    expect(second.body.data.map((r: { id: string }) => r.id)).toEqual(["ra2"]);
  });

  it("enforces strict range validation, caps, and cursor binding", async () => {
    await authed(request(server).get(`/api/vps/${vpsA}/docker/rollups?from=${B2}&to=${B1}`)).expect(400);
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/rollups?from=2026-01-01T00:00:00.000Z&to=2026-02-15T00:00:00.000Z`),
    ).expect(400);
    await authed(request(server).get(`/api/vps/${vpsA}/docker/rollups?limit=501`)).expect(400);
    await authed(request(server).get(`/api/vps/${vpsA}/docker/rollups?bogus=x`)).expect(400);
    await authed(request(server).get(`/api/vps/${vpsA}/docker/rollups?cursor=${encodeURIComponent("!!!not-base64!!!")}`)).expect(400);
  });

  it("accepts to-only as bounded [to-30d, to] and filters by window", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/rollups?from=${encodeURIComponent(B2)}&to=${encodeURIComponent(B3)}`),
    ).expect(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual(["ra3", "ra2"]);
    const toOnly = await authed(request(server).get(`/api/vps/${vpsA}/docker/rollups?to=${encodeURIComponent(B3)}`)).expect(200);
    expect(toOnly.body.data.map((r: { id: string }) => r.id)).toEqual(["ra3", "ra2", "ra1"]);
  });
});
