import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { seedDockerMonitoringForTests } from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createApp, closeTestApps, createSessionCookie } from "./test-helpers.js";

// ── Docker Monitoring I1 REST/DI lane (JSON backend) ──────────────────────
// Focused API coverage: local session auth, empty reads + shapes, VPS 404
// before repository data, strict 400/caps/tampered cursors, VPS isolation,
// ack unavailable in I1 without mutation, dashboard route unchanged.

const SESSION_SECRET = "docker-monitoring-api-test-secret-32chars";
const ORIGIN = "http://127.0.0.1";
const HOST = "127.0.0.1";

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

const T1 = "2026-09-10T00:00:00.000Z";
const T2 = "2026-09-11T00:00:00.000Z";
const T3 = "2026-09-12T00:00:00.000Z";

let tempDir: string;
let server: Express;
let sessionCookie: string;
let vpsA = "";
let vpsB = "";
let vpsEmpty = "";

function hostSample(id: string, vpsId: string, effectiveAt: string) {
  return {
    id,
    vpsId,
    agentInstanceId: "inst1",
    snapshotId: `snap_${id}`,
    collectedAt: effectiveAt,
    receivedAt: effectiveAt,
    effectiveAt,
    metrics: { cpu: 1 },
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-docker-mon-api-"));
  const dataDir = join(tempDir, "data");

  const store = createVpsStore(join(dataDir, "vps.json"));
  const createdA = await store.create({
    name: "docker-a",
    host: "203.0.113.10",
    port: 22,
    username: "root",
  });
  const createdB = await store.create({
    name: "docker-b",
    host: "203.0.113.11",
    port: 22,
    username: "root",
  });
  const createdEmpty = await store.create({
    name: "docker-empty",
    host: "203.0.113.12",
    port: 22,
    username: "root",
  });
  vpsA = createdA.id;
  vpsB = createdB.id;
  vpsEmpty = createdEmpty.id;

  await seedDockerMonitoringForTests(join(dataDir, "docker-monitoring.json"), {
    samples: [
      hostSample("ha1", vpsA, T1),
      hostSample("ha2", vpsA, T2),
      hostSample("ha3", vpsA, T3),
      {
        ...hostSample("hb1", vpsB, T2),
        agentInstanceId: "inst1",
        containerKey: "ck1",
      },
      hostSample("hb-host", vpsB, T1),
    ],
    events: [
      {
        id: "ev-a1",
        vpsId: vpsA,
        agentInstanceId: "inst1",
        action: "die",
        eventOccurredAt: T2,
        receivedAt: T2,
        eventDigest: "digest_ev-a1",
        contextVersion: 1,
      },
      {
        id: "ev-b1",
        vpsId: vpsB,
        agentInstanceId: "inst1",
        action: "start",
        eventOccurredAt: T2,
        receivedAt: T2,
        eventDigest: "digest_ev-b1",
        contextVersion: 1,
      },
    ],
    alerts: [
      {
        id: "al-a1",
        vpsId: vpsA,
        ruleKind: "container_cpu_high",
        state: "open",
        fingerprint: "fp_al-a1",
        openedAt: T2,
        occurrences: 1,
        summary: "cpu high",
        contextVersion: 1,
      },
    ],
    latestStorage: {
      [vpsA]: {
        vpsId: vpsA,
        agentInstanceId: "inst1",
        snapshotId: "snap-storage-a",
        collectedAt: T3,
        receivedAt: T3,
        formulaVersion: 1,
        images: { supported: true, count: 2, totalBytes: 1000 },
        containers: { supported: true, count: 1, totalBytes: 500 },
        localVolumes: { supported: false, count: 0, totalBytes: 0 },
        buildCache: { supported: false, count: 0, totalBytes: 0 },
      },
    },
  });

  sessionCookie = await createSessionCookie(tempDir, SESSION_SECRET);
  server = createApp({
    config: {
      ...baseConfig,
      dataDir,
      privateDir: join(tempDir, "private"),
    },
  });
});

afterEach(async () => {
  await closeTestApps();
  await rm(tempDir, { recursive: true, force: true });
});

function authed(req: request.Test) {
  return req.set("Cookie", sessionCookie);
}

describe("docker monitoring API auth (local mode)", () => {
  it("rejects unauthenticated reads with 401", async () => {
    await request(server).get(`/api/vps/${vpsA}/docker/history`).expect(401);
    await request(server).get(`/api/vps/${vpsA}/docker/events`).expect(401);
    await request(server).get(`/api/vps/${vpsA}/docker/storage`).expect(401);
    await request(server).get(`/api/vps/${vpsA}/docker/alerts`).expect(401);
    await request(server)
      .get(`/api/vps/${vpsA}/docker/instances/inst1/containers/ck1/history`)
      .expect(401);
  });
});

describe("docker monitoring API empty reads and shapes", () => {
  it("host history returns empty {data,page} shape", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/history`),
    ).expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page.hasMore).toBe(false);
    expect(res.body.page.nextCursor).toBeUndefined();
    expect(typeof res.body.page.limit).toBe("number");
  });

  it("container history returns empty {data,page} shape", async () => {
    const res = await authed(
      request(server).get(
        `/api/vps/${vpsEmpty}/docker/instances/inst1/containers/ck1/history`,
      ),
    ).expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page.hasMore).toBe(false);
  });

  it("events returns empty {data,page} shape", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/events`),
    ).expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page.hasMore).toBe(false);
  });

  it("storage returns {data:null} when nothing stored", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/storage`),
    ).expect(200);
    expect(res.body).toEqual({ data: null });
  });

  it("alerts returns empty {data,page} shape", async () => {
    const res = await authed(
      request(server).get(`/api/vps/${vpsEmpty}/docker/alerts`),
    ).expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page.hasMore).toBe(false);
  });

  it("seeded host history paginates with {data,page} and storage shape", async () => {
    const first = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/history?limit=1`),
    ).expect(200);
    expect(first.body.data.map((s: { id: string }) => s.id)).toEqual(["ha3"]);
    expect(first.body.page).toMatchObject({ limit: 1, hasMore: true });
    expect(typeof first.body.page.nextCursor).toBe("string");

    const second = await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/history?limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
      ),
    ).expect(200);
    expect(second.body.data.map((s: { id: string }) => s.id)).toEqual(["ha2"]);

    const storage = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/storage`),
    ).expect(200);
    expect(storage.body.data).toMatchObject({
      vpsId: vpsA,
      snapshotId: "snap-storage-a",
    });
  });
});

describe("docker monitoring API VPS existence checked before reads", () => {
  it("returns 404 for unknown VPS on every read endpoint", async () => {
    const missing = "vps_missing_does_not_exist";
    await authed(request(server).get(`/api/vps/${missing}/docker/history`)).expect(
      404,
      { error: { message: "VPS not found" } },
    );
    await authed(
      request(server).get(
        `/api/vps/${missing}/docker/instances/inst1/containers/ck1/history`,
      ),
    ).expect(404);
    await authed(
      request(server).get(`/api/vps/${missing}/docker/events`),
    ).expect(404);
    await authed(
      request(server).get(`/api/vps/${missing}/docker/storage`),
    ).expect(404);
    await authed(
      request(server).get(`/api/vps/${missing}/docker/alerts`),
    ).expect(404);
  });

  it("returns 404 for ack on unknown VPS before any mutation", async () => {
    await authed(
      request(server)
        .post(`/api/vps/vps_missing_does_not_exist/docker/alerts/al-a1/acknowledge`)
        .set("Origin", ORIGIN)
        .set("Host", HOST),
    ).expect(404);
  });
});

describe("docker monitoring API strict validation and caps", () => {
  it("rejects over-cap limits with 400", async () => {
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/history?limit=501`),
    ).expect(400);
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/events?limit=201`),
    ).expect(400);
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/alerts?limit=201`),
    ).expect(400);
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/history?limit=0`),
    ).expect(400);
  });

  it("rejects unknown query params (strict schemas) with 400", async () => {
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/history?unexpectedParam=1`),
    ).expect(400);
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/events?bogus=x`),
    ).expect(400);
  });

  it("rejects inverted and over-range date windows with 400", async () => {
    await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/history?from=${encodeURIComponent(T2)}&to=${encodeURIComponent(T1)}`,
      ),
    ).expect(400);
    await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/history?from=2026-01-01T00:00:00.000Z&to=2026-02-15T00:00:00.000Z`,
      ),
    ).expect(400);
  });

  it("rejects split container filters with 400", async () => {
    await authed(
      request(server).get(`/api/vps/${vpsA}/docker/events?containerKey=ck1`),
    ).expect(400);
    await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/alerts?agentInstanceId=inst1`,
      ),
    ).expect(400);
  });

  it("rejects malformed cursors with 400", async () => {
    await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/history?cursor=${encodeURIComponent("!!!not-base64!!!")}`,
      ),
    ).expect(400);
    await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/events?cursor=${encodeURIComponent("!!!not-base64!!!")}`,
      ),
    ).expect(400);
  });

  it("rejects structurally invalid base64url cursors with controlled 400 Invalid cursor", async () => {
    const badPayload = {
      v: 1,
      vpsId: vpsA,
      scope: "host",
      filters: {},
      order: "effectiveAt,id",
      last: { at: "not-a-datetime", id: "!!!bad!!!" },
    };
    const badCursor = Buffer.from(JSON.stringify(badPayload), "utf8").toString("base64url");
    for (const path of [
      `/api/vps/${vpsA}/docker/history?cursor=${encodeURIComponent(badCursor)}`,
      `/api/vps/${vpsA}/docker/events?cursor=${encodeURIComponent(badCursor)}`,
      `/api/vps/${vpsA}/docker/alerts?cursor=${encodeURIComponent(badCursor)}`,
      `/api/vps/${vpsA}/docker/instances/inst1/containers/ck1/history?cursor=${encodeURIComponent(badCursor)}`,
    ]) {
      const res = await authed(request(server).get(path)).expect(400);
      expect(res.body).toEqual({ error: { message: "Invalid cursor" } });
    }
  });

  it("accepts one-sided to queries as bounded [to-30d, to] for history/events/alerts", async () => {
    const toOnly = encodeURIComponent(T3);
    const history = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/history?to=${toOnly}`),
    ).expect(200);
    expect(history.body.data.map((s: { id: string }) => s.id)).toEqual(["ha3", "ha2", "ha1"]);

    const events = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/events?to=${toOnly}`),
    ).expect(200);
    expect(events.body.data.map((e: { id: string }) => e.id)).toEqual(["ev-a1"]);

    const alerts = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/alerts?to=${toOnly}`),
    ).expect(200);
    expect(alerts.body.data.map((a: { id: string }) => a.id)).toEqual(["al-a1"]);

    const container = await authed(
      request(server).get(
        `/api/vps/${vpsB}/docker/instances/inst1/containers/ck1/history?to=${toOnly}`,
      ),
    ).expect(200);
    expect(container.body.data.map((s: { id: string }) => s.id)).toEqual(["hb1"]);

    // Old `to` far beyond 30d from now is normalized (not rejected): the
    // effective window is [to-30d, to], so results stay bounded.
    const oldTo = encodeURIComponent("2025-01-15T00:00:00.000Z");
    await authed(request(server).get(`/api/vps/${vpsA}/docker/history?to=${oldTo}`)).expect(200);
    await authed(request(server).get(`/api/vps/${vpsA}/docker/events?to=${oldTo}`)).expect(200);
    await authed(request(server).get(`/api/vps/${vpsA}/docker/alerts?to=${oldTo}`)).expect(200);
  });

  it("rejects tampered, cross-VPS, and cross-scope cursors with 400", async () => {
    const first = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/history?limit=1`),
    ).expect(200);
    const cursor = first.body.page.nextCursor as string;
    expect(typeof cursor).toBe("string");

    const tampered = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/history?cursor=${encodeURIComponent(tampered)}`,
      ),
    ).expect(400);

    await authed(
      request(server).get(
        `/api/vps/${vpsB}/docker/history?cursor=${encodeURIComponent(cursor)}`,
      ),
    ).expect(400);

    await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/events?cursor=${encodeURIComponent(cursor)}`,
      ),
    ).expect(400);
  });
});

describe("docker monitoring API VPS isolation", () => {
  it("never leaks samples, events, alerts, or storage across VPSs", async () => {
    const historyA = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/history`),
    ).expect(200);
    expect(
      historyA.body.data.every((s: { vpsId: string }) => s.vpsId === vpsA),
    ).toBe(true);
    expect(historyA.body.data.map((s: { id: string }) => s.id)).toEqual([
      "ha3",
      "ha2",
      "ha1",
    ]);

    const historyB = await authed(
      request(server).get(`/api/vps/${vpsB}/docker/history`),
    ).expect(200);
    expect(historyB.body.data.map((s: { id: string }) => s.id)).toEqual([
      "hb-host",
    ]);

    const containerB = await authed(
      request(server).get(
        `/api/vps/${vpsB}/docker/instances/inst1/containers/ck1/history`,
      ),
    ).expect(200);
    expect(containerB.body.data.map((s: { id: string }) => s.id)).toEqual([
      "hb1",
    ]);

    const containerA = await authed(
      request(server).get(
        `/api/vps/${vpsA}/docker/instances/inst1/containers/ck1/history`,
      ),
    ).expect(200);
    expect(containerA.body.data).toEqual([]);

    const eventsA = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/events`),
    ).expect(200);
    expect(eventsA.body.data.map((e: { id: string }) => e.id)).toEqual([
      "ev-a1",
    ]);

    const eventsB = await authed(
      request(server).get(`/api/vps/${vpsB}/docker/events`),
    ).expect(200);
    expect(eventsB.body.data.map((e: { id: string }) => e.id)).toEqual([
      "ev-b1",
    ]);

    const alertsB = await authed(
      request(server).get(`/api/vps/${vpsB}/docker/alerts`),
    ).expect(200);
    expect(alertsB.body.data).toEqual([]);

    const storageB = await authed(
      request(server).get(`/api/vps/${vpsB}/docker/storage`),
    ).expect(200);
    expect(storageB.body).toEqual({ data: null });
  });
});

describe("docker monitoring API alert acknowledgement", () => {
  it("acknowledges an alert scoped to the VPS", async () => {
    const res = await authed(
      request(server)
        .post(`/api/vps/${vpsA}/docker/alerts/al-a1/acknowledge`)
        .set("Origin", ORIGIN)
        .set("Host", HOST),
    ).expect(201);
    expect(res.body).toMatchObject({ id: "al-a1", state: "acknowledged" });
    expect(res.body.acknowledgedBy).toMatch(/^sess_/);

    const alerts = await authed(
      request(server).get(`/api/vps/${vpsA}/docker/alerts`),
    ).expect(200);
    expect(alerts.body.data.map((a: { id: string }) => a.id)).toEqual([
      "al-a1",
    ]);
    expect(alerts.body.data[0]).toMatchObject({ state: "acknowledged" });
    expect(alerts.body.data[0].acknowledgedBy).toMatch(/^sess_/);
  });

  it("requires session auth and origin for ack", async () => {
    await request(server)
      .post(`/api/vps/${vpsA}/docker/alerts/al-a1/acknowledge`)
      .set("Origin", ORIGIN)
      .set("Host", HOST)
      .expect(401);
    await authed(
      request(server).post(
        `/api/vps/${vpsA}/docker/alerts/al-a1/acknowledge`,
      ),
    ).expect(403);
  });
});

describe("dashboard route unchanged", () => {
  it("still serves the dashboard overview for local sessions", async () => {
    const res = await authed(request(server).get("/api/dashboard")).expect(200);
    expect(res.body.data).toBeDefined();
  });
});
