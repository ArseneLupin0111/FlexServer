import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonJobRepository } from "../src/persistence/repositories/job.repository.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";

const demoConfig: AppConfig = {
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
  dashboardSessionSecret: "test-secret",
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-jma-"));
});

afterEach(async () => {
  await closeTestApps();
  await rm(tempDir, { recursive: true, force: true });
});

function app(overrides?: Partial<AppConfig>) {
  const config = { ...demoConfig, ...overrides };
  return createApp({
    config: {
      ...config,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
    store: createVpsStore(join(tempDir, "data", "vps.json")),
    keys: createKeyService(join(tempDir, "private", "keys")),
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    jobs: createJsonJobRepository(join(tempDir, "data", "jobs.json")),
    metrics: createJsonMetricRepository(join(tempDir, "data", "metrics.json")),
  });
}

describe("jobs API", () => {
  describe("demo mode", () => {
    it("returns seeded demo jobs", async () => {
      const res = await request(app()).get("/api/jobs").expect(200);

      expect(res.body.data).toHaveLength(4);
      expect(res.body.data.map((job: { id: string }) => job.id)).toEqual([
        "job_demo_disk_check",
        "job_demo_collect_metrics",
        "job_demo_verify_key",
        "job_demo_rotate_key_failed",
      ]);
      expect(
        res.body.data.map((job: { status: string }) => job.status),
      ).toEqual(["queued", "running", "succeeded", "failed"]);
    });

    it("includes job progress and output preview", async () => {
      const res = await request(app()).get("/api/jobs").expect(200);

      const running = res.body.data.find(
        (job: { id: string }) => job.id === "job_demo_collect_metrics",
      );
      expect(running).toMatchObject({
        vpsId: "demo-edge-sgp-01",
        status: "running",
        progress: 64,
        outputPreview: "Collecting uptime, disk, and load averages...",
      });
    });

    it("does not leak credentials in response", async () => {
      const res = await request(app()).get("/api/jobs").expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(
        /password|private key|secret/i,
      );
    });
  });

  describe("local mode", () => {
    let sessionCookie: string;

    beforeEach(async () => {
      const { createSessionCookie } = await import("./test-helpers.js");
      sessionCookie = await createSessionCookie(
        tempDir,
        demoConfig.dashboardSessionSecret,
      );
    });

    it("returns empty list when no jobs stored", async () => {
      const localConfig: AppConfig = {
        ...demoConfig,
        mode: "local",
      };
      const res = await request(app(localConfig))
        .get("/api/jobs")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns jobs from repository when data exists", async () => {
      const localConfig: AppConfig = {
        ...demoConfig,
        mode: "local",
      };
      // Manually append a job to the JSON file via the repo
      const repo = createJsonJobRepository(join(tempDir, "data", "jobs.json"));
      const job = await repo.append({
        vpsId: "vps_test_01",
        type: "check disk",
        status: "succeeded",
        progress: 100,
        startedAt: "2026-06-25T10:00:00.000Z",
        finishedAt: "2026-06-25T10:00:05.000Z",
        exitCode: 0,
        outputPreview: "Disk usage: 45%",
      });

      const res = await request(app(localConfig))
        .get("/api/jobs")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: job.id,
        vpsId: "vps_test_01",
        type: "check disk",
        status: "succeeded",
        exitCode: 0,
      });
    });
  });
});

describe("metrics API", () => {
  describe("demo mode", () => {
    it("returns seeded demo metrics", async () => {
      const res = await request(app()).get("/api/metrics").expect(200);

      expect(res.body.data).toHaveLength(3);
      expect(res.body.data.map((m: { vpsId: string }) => m.vpsId)).toEqual([
        "demo-edge-sgp-01",
        "demo-api-fra-02",
        "demo-worker-sfo-01",
      ]);
    });

    it("includes freshness field", async () => {
      const res = await request(app()).get("/api/metrics").expect(200);
      expect(
        res.body.data.map((m: { freshness: string }) => m.freshness),
      ).toEqual(["fresh", "fresh", "stale"]);
    });

    it("filters by vpsId query parameter", async () => {
      const res = await request(app())
        .get("/api/metrics?vpsId=demo-api-fra-02")
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        vpsId: "demo-api-fra-02",
        cpu: 72,
        memory: 78,
      });
    });

    it("returns empty array for non-matching vpsId", async () => {
      const res = await request(app())
        .get("/api/metrics?vpsId=nonexistent")
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it("does not leak credentials in response", async () => {
      const res = await request(app()).get("/api/metrics").expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(
        /password|private key|secret/i,
      );
    });
  });

  describe("local mode", () => {
    let sessionCookie: string;

    beforeEach(async () => {
      const { createSessionCookie } = await import("./test-helpers.js");
      sessionCookie = await createSessionCookie(
        tempDir,
        demoConfig.dashboardSessionSecret,
      );
    });

    it("returns empty list when no metrics stored", async () => {
      const localConfig: AppConfig = {
        ...demoConfig,
        mode: "local",
      };
      const res = await request(app(localConfig))
        .get("/api/metrics")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns metrics from repository and supports vpsId filter", async () => {
      const localConfig: AppConfig = {
        ...demoConfig,
        mode: "local",
      };
      const repo = createJsonMetricRepository(
        join(tempDir, "data", "metrics.json"),
      );
      await repo.append({
        vpsId: "vps_alpha",
        cpu: 35,
        memory: 50,
        disk: 70,
        loadAverage: 0.5,
        networkRx: 1000,
        networkTx: 500,
        uptime: 86400,
        collectedAt: "2026-06-25T10:00:00.000Z",
      });
      await repo.append({
        vpsId: "vps_beta",
        cpu: 80,
        memory: 90,
        disk: 50,
        loadAverage: 2.0,
        networkRx: 2000,
        networkTx: 1500,
        uptime: 43200,
        collectedAt: "2026-06-25T10:00:00.000Z",
      });

      const all = await request(app(localConfig))
        .get("/api/metrics")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(all.body.data).toHaveLength(2);

      const filtered = await request(app(localConfig))
        .get("/api/metrics?vpsId=vps_alpha")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(filtered.body.data).toHaveLength(1);
      expect(filtered.body.data[0].cpu).toBe(35);
      expect(filtered.body.data[0].freshness).toBe("stale");
    });
  });
});

describe("audit API", () => {
  describe("demo mode", () => {
    it("returns seeded demo audit events", async () => {
      const res = await request(app()).get("/api/audit").expect(200);

      expect(res.body.data).toHaveLength(7);
      expect(res.body.data.map((e: { action: string }) => e.action)).toEqual([
        "demo.dashboard.view",
        "job.queued",
        "job.running",
        "job.succeeded",
        "job.failed",
        "terminal.opened",
        "ssh.host.blocked",
      ]);
    });

    it("filters by resourceId", async () => {
      const res = await request(app())
        .get("/api/audit?resourceId=job_demo_verify_key")
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        action: "job.succeeded",
        resourceId: "job_demo_verify_key",
        result: "success",
      });
    });

    it("filters by action", async () => {
      const res = await request(app())
        .get("/api/audit?action=job.queued")
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        action: "job.queued",
        resourceType: "job",
      });
    });

    it("filters by result", async () => {
      const res = await request(app())
        .get("/api/audit?result=blocked")
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        action: "ssh.host.blocked",
        result: "blocked",
      });
    });

    it("returns empty array for non-matching filter", async () => {
      const res = await request(app())
        .get("/api/audit?resourceId=nonexistent")
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it("does not leak credentials in response", async () => {
      const res = await request(app()).get("/api/audit").expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(
        /password|private key|secret/i,
      );
    });
  });

  describe("local mode", () => {
    let sessionCookie: string;

    beforeEach(async () => {
      const { createSessionCookie } = await import("./test-helpers.js");
      sessionCookie = await createSessionCookie(
        tempDir,
        demoConfig.dashboardSessionSecret,
      );
    });

    it("returns empty list when no audit events stored", async () => {
      const localConfig: AppConfig = {
        ...demoConfig,
        mode: "local",
      };
      const res = await request(app(localConfig))
        .get("/api/audit")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it("returns audit events from repository and supports filters", async () => {
      const localConfig: AppConfig = {
        ...demoConfig,
        mode: "local",
      };
      const repo = createJsonAuditRepository(
        join(tempDir, "data", "audit.json"),
      );
      const e1 = await repo.append({
        actor: "admin",
        action: "vps.create",
        resourceType: "vps",
        resourceId: "vps_001",
        result: "success",
        metadata: { host: "203.0.113.10" },
      });
      const e2 = await repo.append({
        actor: "admin",
        action: "vps.delete",
        resourceType: "vps",
        resourceId: "vps_002",
        result: "blocked",
        metadata: { reason: "protected" },
      });

      const all = await request(app(localConfig))
        .get("/api/audit")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(all.body.data).toHaveLength(2);

      const actionFilter = await request(app(localConfig))
        .get("/api/audit?action=vps.create")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(actionFilter.body.data).toHaveLength(1);
      expect(actionFilter.body.data[0].resourceId).toBe("vps_001");

      const resultFilter = await request(app(localConfig))
        .get("/api/audit?result=blocked")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(resultFilter.body.data).toHaveLength(1);
      expect(resultFilter.body.data[0].resourceId).toBe("vps_002");
    });
  });
});

describe("pagination", () => {
  let sessionCookie: string;

  beforeEach(async () => {
    const { createSessionCookie } = await import("./test-helpers.js");
    sessionCookie = await createSessionCookie(
      tempDir,
      demoConfig.dashboardSessionSecret,
    );
  });

  describe("GET /api/jobs pagination", () => {
    it("returns page metadata with limit and offset", async () => {
      // Pre-populate jobs
      const repo = createJsonJobRepository(join(tempDir, "data", "jobs.json"));
      for (let i = 0; i < 5; i++) {
        await repo.create({
          vpsId: "vps-1",
          type: "test",
          status: "succeeded",
          progress: 100,
        });
      }

      const localConfig: AppConfig = { ...demoConfig, mode: "local" };
      const res = await request(app(localConfig))
        .get("/api/jobs?limit=2&offset=0")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.page).toEqual({ limit: 2, offset: 0, nextOffset: 2 });
    });

    it("supports offset pagination", async () => {
      const repo = createJsonJobRepository(join(tempDir, "data", "jobs.json"));
      for (let i = 0; i < 5; i++) {
        await repo.create({
          vpsId: "vps-1",
          type: "test",
          status: "succeeded",
          progress: 100,
        });
      }

      const localConfig: AppConfig = { ...demoConfig, mode: "local" };
      const first = await request(app(localConfig))
        .get("/api/jobs?limit=2&offset=0")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(first.body.data).toHaveLength(2);

      const second = await request(app(localConfig))
        .get("/api/jobs?limit=2&offset=2")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(second.body.data).toHaveLength(2);
      // Different jobs than first page
      expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    });

    it("rejects limit above max", async () => {
      await request(app()).get("/api/jobs?limit=9999").expect(400);
    });

    it("rejects zero limit", async () => {
      await request(app()).get("/api/jobs?limit=0").expect(400);
    });

    it("rejects negative offset", async () => {
      await request(app()).get("/api/jobs?offset=-1").expect(400);
    });

    it("rejects float limit", async () => {
      await request(app()).get("/api/jobs?limit=1.5").expect(400);
    });

    it("rejects non-numeric limit", async () => {
      await request(app()).get("/api/jobs?limit=abc").expect(400);
    });

    it("rejects repeated limit values", async () => {
      await request(app()).get("/api/jobs?limit=1&limit=2").expect(400);
    });
  });

  describe("GET /api/audit pagination", () => {
    it("returns page metadata", async () => {
      const localConfig: AppConfig = { ...demoConfig, mode: "local" };
      const repo = createJsonAuditRepository(
        join(tempDir, "data", "audit.json"),
      );
      for (let i = 0; i < 5; i++) {
        await repo.append({
          actor: "test",
          action: "test.event",
          resourceType: "test",
          result: "success",
        });
      }

      const res = await request(app(localConfig))
        .get("/api/audit?limit=2")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.page.limit).toBe(2);
      expect(res.body.page.offset).toBe(0);
    });

    it("applies AND filters with pagination", async () => {
      const localConfig: AppConfig = { ...demoConfig, mode: "local" };
      const repo = createJsonAuditRepository(
        join(tempDir, "data", "audit.json"),
      );
      for (let i = 0; i < 3; i++) {
        await repo.append({
          actor: "test",
          action: "test.alpha",
          resourceType: "test",
          resourceId: "r1",
          result: "success",
        });
        await repo.append({
          actor: "test",
          action: "test.beta",
          resourceType: "test",
          resourceId: "r2",
          result: "failure",
        });
      }

      // AND filter: resourceId + result
      const res = await request(app(localConfig))
        .get("/api/audit?resourceId=r2&result=failure&limit=10")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toHaveLength(3);
      for (const e of res.body.data) {
        expect(e.resourceId).toBe("r2");
        expect(e.result).toBe("failure");
      }
    });

    it("filters before pagination", async () => {
      const localConfig: AppConfig = { ...demoConfig, mode: "local" };
      const repo = createJsonAuditRepository(
        join(tempDir, "data", "audit.json"),
      );

      await repo.append({
        id: "audit_failure_old",
        actor: "test",
        action: "test.failure",
        resourceType: "test",
        result: "failure",
        timestamp: "2026-06-25T10:00:00.000Z",
      });
      await repo.append({
        id: "audit_success_new",
        actor: "test",
        action: "test.success",
        resourceType: "test",
        result: "success",
        timestamp: "2026-06-25T11:00:00.000Z",
      });

      const res = await request(app(localConfig))
        .get("/api/audit?result=failure&limit=1")
        .set("Cookie", sessionCookie)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("audit_failure_old");
    });
  });

  describe("GET /api/metrics pagination", () => {
    it("returns paginated latest without vpsId", async () => {
      const localConfig: AppConfig = { ...demoConfig, mode: "local" };
      const repo = createJsonMetricRepository(
        join(tempDir, "data", "metrics.json"),
      );
      for (let i = 0; i < 5; i++) {
        await repo.upsertLatest({
          vpsId: `vps-${i}`,
          cpu: i * 10,
          memory: 50,
          disk: 50,
          loadAverage: 0.5,
          networkRx: 1000,
          networkTx: 500,
          uptime: 86400,
          collectedAt: new Date().toISOString(),
        });
      }

      const res = await request(app(localConfig))
        .get("/api/metrics?limit=2")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.page).toBeDefined();
    });

    it("returns 0/1 item with vpsId filter (no pagination)", async () => {
      const localConfig: AppConfig = { ...demoConfig, mode: "local" };
      const repo = createJsonMetricRepository(
        join(tempDir, "data", "metrics.json"),
      );
      await repo.upsertLatest({
        vpsId: "vps-specific",
        cpu: 42,
        memory: 50,
        disk: 50,
        loadAverage: 0.5,
        networkRx: 1000,
        networkTx: 500,
        uptime: 86400,
        collectedAt: new Date().toISOString(),
      });

      const res = await request(app(localConfig))
        .get("/api/metrics?vpsId=vps-specific")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.page).toBeUndefined();
    });
  });

  describe("rate limiting", () => {
    it("blocks mutations after exceeding rate limit", async () => {
      const lowRateConfig: AppConfig = {
        ...demoConfig,
        mode: "local",
        rateLimitMax: 2,
      };

      // Create a VPS first
      const server = app(lowRateConfig);
      const { createSessionCookie } = await import("./test-helpers.js");
      const cookie = await createSessionCookie(
        tempDir,
        lowRateConfig.dashboardSessionSecret,
      );

      // First request should work
      await request(server)
        .post("/api/vps")
        .set("Cookie", cookie)
        .set("Origin", "http://127.0.0.1")
        .set("Host", "127.0.0.1")
        .send({ name: "r1", host: "203.0.113.1", port: 22, username: "root" })
        .expect(201);

      // Second request should work
      await request(server)
        .post("/api/vps")
        .set("Cookie", cookie)
        .set("Origin", "http://127.0.0.1")
        .set("Host", "127.0.0.1")
        .send({ name: "r2", host: "203.0.113.2", port: 22, username: "root" })
        .expect(201);

      // Third request should be blocked (rateLimitMax=2)
      const blocked = await request(server)
        .post("/api/vps")
        .set("Cookie", cookie)
        .set("Origin", "http://127.0.0.1")
        .set("Host", "127.0.0.1")
        .send({ name: "r3", host: "203.0.113.3", port: 22, username: "root" })
        .expect(429);
      expect(blocked.body.error.message).toBe("Too many requests");
    });
  });
});
