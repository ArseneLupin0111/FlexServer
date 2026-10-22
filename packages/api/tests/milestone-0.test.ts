import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { parseAppConfig } from "../src/config/app-config.js";
import { selectMigrations } from "../src/db/migrations.js";
import type { CommandJob } from "../src/jobs/jobs.models.js";
import type { MetricSample } from "../src/metrics/metrics.models.js";
import { createJsonJobRepository } from "../src/persistence/repositories/job.repository.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import { JobRunnerService } from "../src/jobs/job-runner.service.js";
import { JobActivityService } from "../src/jobs/job-activity.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";

// ── Helpers ────────────────────────────────────────────────────────────

let tempDir: string;
let tempDataDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-m0-"));
  tempDataDir = join(tempDir, "data");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Config ─────────────────────────────────────────────────────────────

describe("agent app config", () => {
  it("defaults agentInstallIntervalSeconds to 1", () => {
    const config = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(config.agentInstallIntervalSeconds).toBe(1);
  });

  it("defaults allowInsecureAgentHttp to false", () => {
    const config = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(config.allowInsecureAgentHttp).toBe(false);
  });

  it("defaults agentPublicBaseUrl to undefined", () => {
    const config = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(config.agentPublicBaseUrl).toBeUndefined();
  });

  it("defaults agentBinaryPath to undefined", () => {
    const config = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(config.agentBinaryPath).toBeUndefined();
  });

  it("parses AGENT_INSTALL_INTERVAL_SECONDS", () => {
    const config = parseAppConfig({
      AGENT_INSTALL_INTERVAL_SECONDS: "5",
    } as NodeJS.ProcessEnv);
    expect(config.agentInstallIntervalSeconds).toBe(5);
  });

  it("rejects AGENT_INSTALL_INTERVAL_SECONDS below 1", () => {
    expect(() =>
      parseAppConfig({
        AGENT_INSTALL_INTERVAL_SECONDS: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      parseAppConfig({
        AGENT_INSTALL_INTERVAL_SECONDS: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("parses ALLOW_INSECURE_AGENT_HTTP true", () => {
    const config = parseAppConfig({
      ALLOW_INSECURE_AGENT_HTTP: "true",
    } as NodeJS.ProcessEnv);
    expect(config.allowInsecureAgentHttp).toBe(true);
  });

  it("defaults storage driver to json", () => {
    const config = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(config.storageDriver).toBe("json");
  });

  it("rejects invalid storage driver", () => {
    expect(() =>
      parseAppConfig({ STORAGE_DRIVER: "sqlite" } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("requires DATABASE_URL for postgres storage", () => {
    expect(() =>
      parseAppConfig({ STORAGE_DRIVER: "postgres" } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL is required/);
  });

  it("parses postgres storage config", () => {
    const config = parseAppConfig({
      STORAGE_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:pass@localhost:5432/vps_manager",
      DB_SSL: "true",
      DB_POOL_MAX: "20",
    } as NodeJS.ProcessEnv);

    expect(config.storageDriver).toBe("postgres");
    expect(config.databaseUrl).toBe(
      "postgres://user:pass@localhost:5432/vps_manager",
    );
    expect(config.dbSsl).toBe(true);
    expect(config.dbPoolMax).toBe(20);
  });

  it("parses AGENT_PUBLIC_BASE_URL", () => {
    const config = parseAppConfig({
      AGENT_PUBLIC_BASE_URL: "https://backend.example.com",
    } as NodeJS.ProcessEnv);
    expect(config.agentPublicBaseUrl).toBe("https://backend.example.com");
  });

  it("accepts empty string for AGENT_PUBLIC_BASE_URL as undefined", () => {
    const config = parseAppConfig({
      AGENT_PUBLIC_BASE_URL: "",
    } as NodeJS.ProcessEnv);
    expect(config.agentPublicBaseUrl).toBeUndefined();
  });

  it("ignores unknown base URLs gracefully", () => {
    // Invalid URLs are rejected by zod url()
    expect(() =>
      parseAppConfig({
        AGENT_PUBLIC_BASE_URL: "not-a-url",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe("database migrations", () => {
  it("excludes optional migrations unless requested", () => {
    const migrations = [
      { id: "001_core_schema.sql", path: "/fake/001_core_schema.sql", sql: "SELECT 1" },
      {
        id: "003_timescale_optional.sql",
        path: "/fake/003_timescale_optional.sql",
        sql: "SELECT 1",
      },
    ];

    expect(
      selectMigrations(migrations, false).map((migration) => migration.id),
    ).toEqual(["001_core_schema.sql"]);
    expect(
      selectMigrations(migrations, true).map((migration) => migration.id),
    ).toEqual(["001_core_schema.sql", "003_timescale_optional.sql"]);
  });
});

// ── Job Repository ─────────────────────────────────────────────────────

describe("job repository (create / get / update / append)", () => {
  const jobPath = () => join(tempDataDir, "jobs.json");

  it("create returns job with generated id", async () => {
    const repo = createJsonJobRepository(jobPath());
    const job = await repo.create({
      vpsId: "vps_001",
      type: "backup",
      status: "queued",
      progress: 0,
    });
    expect(job.id).toMatch(/^job_/);
    expect(job.vpsId).toBe("vps_001");
    expect(job.status).toBe("queued");
    expect(job.progress).toBe(0);
  });

  it("create respects provided id", async () => {
    const repo = createJsonJobRepository(jobPath());
    const job = await repo.create({
      id: "custom_id",
      vpsId: "vps_001",
      type: "backup",
      status: "queued",
      progress: 0,
    });
    expect(job.id).toBe("custom_id");
  });

  it("get returns undefined for missing id", async () => {
    const repo = createJsonJobRepository(jobPath());
    const result = await repo.get("nonexistent");
    expect(result).toBeUndefined();
  });

  it("get returns job by id", async () => {
    const repo = createJsonJobRepository(jobPath());
    const created = await repo.create({
      vpsId: "vps_001",
      type: "backup",
      status: "queued",
      progress: 0,
    });
    const found = await repo.get(created.id);
    expect(found).toMatchObject({ id: created.id, vpsId: "vps_001" });
  });

  it("update patches fields and stamps updatedAt", async () => {
    const repo = createJsonJobRepository(jobPath());
    const job = await repo.create({
      vpsId: "vps_001",
      type: "backup",
      status: "queued",
      progress: 0,
    });
    const updated = await repo.update(job.id, {
      status: "running",
      progress: 50,
      step: "uploading",
    });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("running");
    expect(updated!.progress).toBe(50);
    expect(updated!.step).toBe("uploading");
    expect(updated!.updatedAt).toBeDefined();
    expect(updated!.id).toBe(job.id);
  });

  it("update returns undefined for missing id", async () => {
    const repo = createJsonJobRepository(jobPath());
    const result = await repo.update("nonexistent", { status: "running" });
    expect(result).toBeUndefined();
  });

  it("append is backward compatible", async () => {
    const repo = createJsonJobRepository(jobPath());
    const job = await repo.append({
      vpsId: "vps_001",
      type: "backup",
      status: "queued",
      progress: 0,
    });
    expect(job.id).toMatch(/^job_/);
    const jobs = await repo.list();
    expect(jobs).toHaveLength(1);
  });

  it("list returns all created jobs", async () => {
    const repo = createJsonJobRepository(jobPath());
    await repo.create({
      vpsId: "vps_001",
      type: "a",
      status: "queued",
      progress: 0,
    });
    await repo.create({
      vpsId: "vps_002",
      type: "b",
      status: "running",
      progress: 50,
    });
    const jobs = await repo.list();
    expect(jobs).toHaveLength(2);
  });
});

// ── Metric Repository ──────────────────────────────────────────────────

describe("metric repository (latest + windows)", () => {
  const metricPath = () => join(tempDataDir, "metrics.json");

  const makeSample = (
    vpsId: string,
    overrides: Partial<MetricSample> = {},
  ): MetricSample => ({
    vpsId,
    cpu: 50,
    memory: 50,
    disk: 50,
    loadAverage: 1,
    networkRx: 100,
    networkTx: 100,
    uptime: 3600,
    collectedAt: new Date().toISOString(),
    ...overrides,
  });

  it("append stores one latest per VPS", async () => {
    const repo = createJsonMetricRepository(metricPath());
    await repo.append(makeSample("vps_a", { cpu: 10 }));
    await repo.append(makeSample("vps_b", { cpu: 20 }));
    await repo.append(makeSample("vps_a", { cpu: 30 }));

    const latest = await repo.listLatest();
    expect(latest).toHaveLength(2);

    const a = await repo.getLatest("vps_a");
    expect(a!.cpu).toBe(30);

    const b = await repo.getLatest("vps_b");
    expect(b!.cpu).toBe(20);
  });

  it("list() returns latest only (backward compat)", async () => {
    const repo = createJsonMetricRepository(metricPath());
    await repo.append(makeSample("vps_a", { cpu: 10 }));
    await repo.append(makeSample("vps_a", { cpu: 20 }));

    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].cpu).toBe(20);
  });

  it("bounded window trims to default cap of 120", async () => {
    const repo = createJsonMetricRepository(metricPath());
    for (let i = 0; i < 150; i++) {
      await repo.append(makeSample("vps_a", { cpu: i }));
    }

    const window = await repo.listWindow("vps_a");
    expect(window).toHaveLength(120);
    // Should keep the most recent 120
    expect(window[0].cpu).toBe(30); // 150 - 120 = 0-based index 30
    expect(window[window.length - 1].cpu).toBe(149);
  }, 30_000);

  it("bounded window respects custom limit", async () => {
    const repo = createJsonMetricRepository(metricPath());
    for (let i = 0; i < 50; i++) {
      await repo.append(makeSample("vps_a", { cpu: i }));
    }

    const window = await repo.listWindow("vps_a", 10);
    expect(window).toHaveLength(10);
    expect(window[0].cpu).toBe(40);
  });

  it("upsertLatest sets latest without touching window", async () => {
    const repo = createJsonMetricRepository(metricPath());
    await repo.upsertLatest(makeSample("vps_a", { cpu: 99 }));

    const latest = await repo.getLatest("vps_a");
    expect(latest!.cpu).toBe(99);

    const window = await repo.listWindow("vps_a");
    expect(window).toHaveLength(0);
  });

  it("appendWindow appends to window without updating latest", async () => {
    const repo = createJsonMetricRepository(metricPath());
    await repo.upsertLatest(makeSample("vps_a", { cpu: 1 }));
    await repo.appendWindow(makeSample("vps_a", { cpu: 2 }));
    await repo.appendWindow(makeSample("vps_a", { cpu: 3 }));

    const latest = await repo.getLatest("vps_a");
    expect(latest!.cpu).toBe(1);

    const window = await repo.listWindow("vps_a");
    expect(window).toHaveLength(2);
    expect(window[0].cpu).toBe(2);
    expect(window[1].cpu).toBe(3);
  });

  it("migrates old { metrics: [...] } format on first read", async () => {
    // Write old format
    const oldData = {
      metrics: [
        {
          vpsId: "vps_a",
          cpu: 10,
          memory: 20,
          disk: 30,
          loadAverage: 0.5,
          networkRx: 100,
          networkTx: 200,
          uptime: 3600,
          collectedAt: new Date().toISOString(),
        },
        {
          vpsId: "vps_b",
          cpu: 40,
          memory: 50,
          disk: 60,
          loadAverage: 1.0,
          networkRx: 300,
          networkTx: 400,
          uptime: 7200,
          collectedAt: new Date().toISOString(),
        },
      ],
    };
    await mkdir(tempDataDir, { recursive: true });
    await writeFile(metricPath(), JSON.stringify(oldData), "utf8");

    const repo = createJsonMetricRepository(metricPath());
    const list = await repo.list();
    expect(list).toHaveLength(2);

    // After migration, the file should be rewritten to new format on first write
    await repo.append(makeSample("vps_c", { cpu: 99 }));
    const fileContent = JSON.parse(await readFile(metricPath(), "utf8"));
    expect(fileContent.metrics).toBeUndefined();
    expect(fileContent.latest).toBeDefined();
    expect(fileContent.windows).toBeDefined();
  });

  it("getLatest returns undefined for unknown VPS", async () => {
    const repo = createJsonMetricRepository(metricPath());
    const result = await repo.getLatest("nonexistent");
    expect(result).toBeUndefined();
  });

  it("listWindow returns empty array for unknown VPS", async () => {
    const repo = createJsonMetricRepository(metricPath());
    const result = await repo.listWindow("nonexistent");
    expect(result).toEqual([]);
  });
});

// ── Job Runner Service ─────────────────────────────────────────────────

describe("JobRunnerService", () => {
  const jobPath = () => join(tempDataDir, "jobs.json");

  async function createJobRepo() {
    return createJsonJobRepository(jobPath());
  }

  async function createRunner() {
    const repo = await createJobRepo();
    const runner = new JobRunnerService(
      repo,
      new JobActivityService(),
      new AgentLifecycleCoordinator(),
    );
    return { repo, runner };
  }

  async function makeJob(
    repo: ReturnType<typeof createJsonJobRepository>,
    overrides: Partial<CommandJob> = {},
  ) {
    return repo.create({
      vpsId: "vps_001",
      type: "test",
      status: "queued",
      progress: 0,
      ...overrides,
    });
  }

  it("transitions job from queued -> running -> succeeded", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve, reject) => {
      runner.start(job, async (ctx) => {
        try {
          await ctx.update("working", 50);
          await ctx.succeed("done");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("succeeded");
    expect(updated!.step).toBe("done");
    expect(updated!.progress).toBe(100);
    expect(updated!.finishedAt).toBeDefined();
  });

  it("transitions job from queued -> running -> failed on error", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async (_ctx) => {
        throw new Error("Something went wrong");
      });
      // Give the async runner a moment to finish
      setTimeout(resolve, 200);
    });

    // Wait for the async operation to complete
    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("failed");
    expect(updated!.errorMessage).toContain("Something went wrong");
    expect(updated!.finishedAt).toBeDefined();
    expect(updated!.step).toBe("error");
  });

  it("sanitizes errors - strips stack traces", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        throw new Error("Disk full");
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.errorMessage).toBe("Disk full");
    expect(updated!.errorMessage).not.toContain("Error:");
    expect(updated!.errorMessage).not.toContain("at ");
  });

  it("handles non-Error throwables gracefully", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "string error";
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("failed");
    expect(updated!.errorMessage).toBe("string error");
  });

  it("redacts Authorization Bearer tokens in error messages", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        throw new Error(
          "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0",
        );
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.errorMessage).toContain("[REDACTED]");
    expect(updated!.errorMessage).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts 'token' key values in error messages", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        throw new Error('"token": "super-secret-value-12345"');
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.errorMessage).not.toContain("super-secret-value-12345");
  });

  it("redacts 'authorization' key values in error messages", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        throw new Error('"authorization": "Bearer sekrit"');
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.errorMessage).not.toContain("sekrit");
  });

  it("caps long error messages at 500 chars", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);
    const longMsg = "x".repeat(1000);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        throw new Error(longMsg);
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.errorMessage!.length).toBeLessThanOrEqual(504); // 500 + "..."
  });

  it("normalizes multiline error messages to single line", async () => {
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        throw new Error("line1\nline2\r\nline3");
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.errorMessage).toBe("line1 line2 line3");
  });

  it("does NOT double-sanitize in catch (passes raw error to ctx.fail)", async () => {
    // The catch block no longer calls sanitiseError itself; ctx.fail does it once.
    // This test verifies the behavior by throwing an error with a token value
    // and checking it gets redacted exactly once (not double-redacted).
    const { repo, runner } = await createRunner();
    const job = await makeJob(repo);

    await new Promise<void>((resolve) => {
      runner.start(job, async () => {
        throw new Error("Bearer some-secret-token-here");
      });
      setTimeout(resolve, 200);
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = await repo.get(job.id);
    expect(updated).toBeDefined();
    // The message should be redacted - check it has [REDACTED] but not double
    expect(updated!.errorMessage).toContain("[REDACTED]");
    expect(updated!.errorMessage).not.toContain("some-secret-token-here");
    // Verify no double-redaction (e.g. "Bearer [REDACTED] [REDACTED]")
    const redactedCount = (updated!.errorMessage!.match(/\[REDACTED\]/g) || [])
      .length;
    expect(redactedCount).toBe(1);
  });
});

// ── Job normalization tests ────────────────────────────────────────────

describe("job repository normalization (old files without progress/updatedAt)", () => {
  const jobPath = () => join(tempDataDir, "jobs-old.json");

  it("returns progress 0 and sensible updatedAt when loading old job without those fields", async () => {
    // Write a raw job file that's missing progress and updatedAt
    const raw = {
      jobs: [
        {
          id: "old_job_1",
          vpsId: "vps_001",
          type: "backup",
          status: "queued",
          // no progress, no updatedAt
        },
      ],
    };
    await mkdir(tempDataDir, { recursive: true });
    await writeFile(jobPath(), JSON.stringify(raw), "utf8");

    const repo = createJsonJobRepository(jobPath());
    const jobs = await repo.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].progress).toBe(0);
    expect(jobs[0].updatedAt).toBeDefined();
    expect(typeof jobs[0].updatedAt).toBe("string");

    // get() also normalizes
    const found = await repo.get("old_job_1");
    expect(found).toBeDefined();
    expect(found!.progress).toBe(0);
    expect(found!.updatedAt).toBeDefined();
  });

  it("preserves existing progress and updatedAt when present", async () => {
    const raw = {
      jobs: [
        {
          id: "normal_job",
          vpsId: "vps_001",
          type: "backup",
          status: "succeeded",
          progress: 100,
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    };
    await mkdir(tempDataDir, { recursive: true });
    await writeFile(jobPath(), JSON.stringify(raw), "utf8");

    const repo = createJsonJobRepository(jobPath());
    const jobs = await repo.list();
    expect(jobs[0].progress).toBe(100);
    expect(jobs[0].updatedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

// ── Concurrent-like metric write safety ─────────────────────────────────

describe("metric repository concurrent-ish write safety", () => {
  const metricPath = () => join(tempDataDir, "metrics-concurrent.json");

  const makeSample = (
    vpsId: string,
    overrides: Partial<MetricSample> = {},
  ): MetricSample => ({
    vpsId,
    cpu: 50,
    memory: 50,
    disk: 50,
    loadAverage: 1,
    networkRx: 100,
    networkTx: 100,
    uptime: 3600,
    collectedAt: new Date().toISOString(),
    ...overrides,
  });

  it("preserves unrelated VPS latest values under sequential-ish pressure", async () => {
    const repo = createJsonMetricRepository(metricPath());

    // Interleave writes to different VPSes to stress serialization
    const writes = [];
    for (let i = 0; i < 50; i++) {
      writes.push(repo.append(makeSample("vps_a", { cpu: i })));
      writes.push(repo.append(makeSample("vps_b", { cpu: i * 10 })));
    }
    await Promise.all(writes);

    const a = await repo.getLatest("vps_a");
    const b = await repo.getLatest("vps_b");

    expect(a).toBeDefined();
    expect(a!.cpu).toBe(49); // last write for vps_a
    expect(b).toBeDefined();
    expect(b!.cpu).toBe(490); // last write for vps_b
  });

  it("serializes appendWindow and upsertLatest for same file", async () => {
    const repo = createJsonMetricRepository(metricPath());

    await repo.upsertLatest(makeSample("vps_x", { cpu: 1 }));

    const ops = [];
    for (let i = 0; i < 30; i++) {
      ops.push(repo.appendWindow(makeSample("vps_x", { cpu: i + 10 })));
      ops.push(repo.upsertLatest(makeSample("vps_x", { cpu: i + 100 })));
    }
    await Promise.all(ops);

    const latest = await repo.getLatest("vps_x");
    expect(latest).toBeDefined();
    expect(latest!.cpu).toBe(129); // 100 + 29 = last upsert

    const window = await repo.listWindow("vps_x");
    expect(window).toHaveLength(30);
    // First window entry should be cpu=10, last cpu=39
    expect(window[0].cpu).toBe(10);
    expect(window[window.length - 1].cpu).toBe(39);
  });
});

// ── Metric migration cap test ──────────────────────────────────────────

describe("metric repository migration cap", () => {
  const metricPath = () => join(tempDataDir, "metrics-migration-cap.json");

  const makeSample = (
    vpsId: string,
    cpu: number,
    collectedAt: string,
  ): MetricSample => ({
    vpsId,
    cpu,
    memory: 50,
    disk: 50,
    loadAverage: 1,
    networkRx: 100,
    networkTx: 100,
    uptime: 3600,
    collectedAt,
  });

  it("caps 500 old-format samples to 120 per VPS on migration", async () => {
    // Write old format with 500 samples for one VPS
    const samples: MetricSample[] = [];
    for (let i = 0; i < 500; i++) {
      samples.push(
        makeSample(
          "vps_migrate",
          i,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        ),
      );
    }
    const oldData = { metrics: samples };
    await mkdir(tempDataDir, { recursive: true });
    await writeFile(metricPath(), JSON.stringify(oldData), "utf8");

    // Reading migrates; writing persists the new format
    const repo = createJsonMetricRepository(metricPath());
    // Trigger migration by reading
    const latest = await repo.getLatest("vps_migrate");
    expect(latest).toBeDefined();
    expect(latest!.cpu).toBe(499); // last sample

    // Trigger a write to persist migrated format
    await repo.append(makeSample("vps_migrate", 999, new Date().toISOString()));

    const window = await repo.listWindow("vps_migrate");
    expect(window).toHaveLength(120); // capped
    // Window should be oldest-first, retaining the latest 119 from old format
    // plus the newly appended sample (cpu=999)
    // After migration cap: indices 380..499 (120 items)
    // After append + cap: 119 old (381..499) + 1 new (999) = 120
    expect(window[0].cpu).toBe(381);
    expect(window[window.length - 1].cpu).toBe(999); // newly appended
  });
});

// ── Serialized job write tests ──────────────────────────────────────────

describe("job repository serialized writes", () => {
  const jobPath = () => join(tempDataDir, "jobs-serialized.json");

  it("handles concurrent creates without data loss", async () => {
    const repo = createJsonJobRepository(jobPath());

    const creates = Array.from({ length: 20 }, (_, i) =>
      repo.create({
        vpsId: `vps_${i}`,
        type: "test",
        status: "queued",
        progress: 0,
      }),
    );
    const results = await Promise.all(creates);
    expect(results).toHaveLength(20);

    const jobs = await repo.list();
    expect(jobs).toHaveLength(20);
    const ids = jobs
      .map((j) => j.vpsId)
      .sort((a, b) => {
        const numA = parseInt(a.replace("vps_", ""), 10);
        const numB = parseInt(b.replace("vps_", ""), 10);
        return numA - numB;
      });
    expect(ids[0]).toBe("vps_0");
    expect(ids[19]).toBe("vps_19");
  });

  it("serializes concurrent update and read", async () => {
    const repo = createJsonJobRepository(jobPath());
    const job = await repo.create({
      vpsId: "vps_u",
      type: "test",
      status: "queued",
      progress: 0,
    });

    const updates = Array.from({ length: 10 }, (_, i) =>
      repo.update(job.id, { progress: (i + 1) * 10 }),
    );
    await Promise.all(updates);

    const final = await repo.get(job.id);
    expect(final).toBeDefined();
    expect(final!.progress).toBe(100); // last update wins
  });
});
