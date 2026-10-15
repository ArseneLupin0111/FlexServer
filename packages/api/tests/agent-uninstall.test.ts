import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonJobRepository } from "../src/persistence/repositories/job.repository.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { createKeyService, type KeyService } from "../src/ssh/keyService.js";
import { createTestKeyring } from "../src/ssh/key-encryption.js";
import type { CommandJob } from "../src/jobs/jobs.models.js";
import type { Dependencies } from "../src/app.js";
import { createSessionCookie } from "./test-helpers.js";
import { SshService } from "../src/ssh/ssh.service.js";

const localConfig: AppConfig = {
  mode: "local",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: false,
  dataDir: "data",
  privateDir: "private",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
  agentInstallIntervalSeconds: 15,
  allowInsecureAgentHttp: false,
  storageDriver: "json",
  dbSsl: false,
  dbPoolMax: 10,
  dashboardSessionTtlSeconds: 86_400,
  dashboardCookieSecure: false,
  dashboardCookieSameSite: "lax",
  dashboardSessionSecret: "uninstall-test-secret-32+chars-here!!",
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

let tempDir: string;
let vpsRepo: VpsRepository;
let keys: KeyService;
let sessionCookie: string;
let sharedAgentRepo: ReturnType<typeof createJsonAgentRepository>;
let sharedJobRepo: ReturnType<typeof createJsonJobRepository>;

function agentRepoPath() {
  return join(tempDir, "data", "agents.json");
}

function jobRepoPath() {
  return join(tempDir, "data", "jobs.json");
}

beforeEach(async () => {
  vi.useRealTimers();
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-uninstall-"));
  vpsRepo = createVpsStore(join(tempDir, "data", "vps.json"));
  sharedAgentRepo = createJsonAgentRepository(agentRepoPath());
  sharedJobRepo = createJsonJobRepository(jobRepoPath());
  keys = createKeyService({
    baseDir: join(tempDir, "private", "keys"),
    keyring: createTestKeyring("uninstall-test-kek"),
  });
  sessionCookie = await createSessionCookie(
    tempDir,
    localConfig.dashboardSessionSecret,
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // JobRunnerService intentionally dispatches detached work. Drain every job
  // before removing the temp directory so Windows cannot retain open files.
  for (let attempt = 0; attempt < 200; attempt++) {
    let jobs: CommandJob[];
    try {
      jobs = await sharedJobRepo.list();
    } catch (error: unknown) {
      // Transient Windows file contention while jobs.json is atomically
      // replaced (write tmp + rename). Retry the drain instead of failing.
      if (!isTransientFsError(error)) throw error;
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    if (jobs.every((job) => job.status === "succeeded" || job.status === "failed" || job.status === "cancelled")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      break;
    } catch {
      if (attempt === 4)
        throw new Error(`Failed to cleanup ${tempDir} after 5 attempts`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

async function createVps(host = "203.0.113.60"): Promise<string> {
  const record = await vpsRepo.create({
    name: "test-vps",
    host,
    port: 22,
    username: "root",
  });
  return record.id;
}

async function createLocalVps(): Promise<string> {
  const record = await vpsRepo.ensureLocalHost({
    id: "local-host",
    name: "local-host",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    kind: "local",
    managedBy: "system",
  });
  return record.id;
}

async function provisionKey(vpsId: string): Promise<void> {
  await keys.ensureKeyPair(vpsId);
  await vpsRepo.markKeyProvisioned(vpsId);
}

function agentRepo() {
  return sharedAgentRepo;
}

function app(overrides?: Partial<AppConfig>, dependencies: Dependencies = {}) {
  const config = { ...localConfig, ...overrides };
  return createApp({
    store: vpsRepo,
    keys,
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    jobs: sharedJobRepo,
    metrics: createJsonMetricRepository(join(tempDir, "data", "metrics.json")),
    agent: agentRepo(),
    ...dependencies,
    config: {
      ...config,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
  });
}

/** Attach the local-mode dashboard session + origin to a supertest request. */
function withCookie(req: request.Test) {
  return req
    .set("Cookie", sessionCookie)
    .set("Origin", "http://127.0.0.1")
    .set("Host", "127.0.0.1");
}

/** Mock successful remote removal via SSH. */
function mockSuccessfulRemoval(homeDir = "/root", homeDelayMs = 0) {
  return vi.spyOn(SshService.prototype, "execCommand").mockImplementation(
    async (_vps, command) => {
      if (command.startsWith("echo $HOME")) {
        if (homeDelayMs > 0) {
          await new Promise((r) => setTimeout(r, homeDelayMs));
        }
        return { stdout: `${homeDir}\n`, stderr: "" };
      }
      if (command.startsWith("test ! -e ") && command.endsWith(" && echo removed || true")) {
        return { stdout: "removed\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  );
}

function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "ENOENT" || code === "EBUSY" || code === "ENOTEMPTY";
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error: unknown) {
      // jobs.json is atomically replaced (write tmp + rename); on Windows a
      // concurrent read can transiently surface EPERM/ENOENT/EBUSY. Retry
      // polling instead of failing the test.
      if (!isTransientFsError(error)) throw error;
    }
    // Poll slowly: every concurrent read holds an open handle that can make
    // the job runner's atomic rename fail with EPERM on Windows, turning a
    // transient harness race into a permanent job failure. 200ms keeps the
    // 15s budget (75 polls) while minimizing open-handle overlap.
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

async function waitForTerminalJob(
  jobId: string,
  timeoutMs = 15_000,
): Promise<CommandJob> {
  const jobs = sharedJobRepo;
  let terminal: CommandJob | undefined;
  await waitUntil(async () => {
    const job = await jobs.get(jobId);
    if (job?.status === "succeeded" || job?.status === "failed") {
      terminal = job;
      return true;
    }
    return false;
  }, timeoutMs);
  return terminal!;
}

async function waitForSuccessfulJob(
  jobId: string,
  timeoutMs = 15_000,
): Promise<CommandJob> {
  const jobs = sharedJobRepo;
  let succeeded: CommandJob | undefined;
  await waitUntil(async () => {
    const job = await jobs.get(jobId);
    if (job?.status === "failed") {
      throw new Error(`Uninstall job failed: ${job.errorMessage ?? "unknown error"}`);
    }
    if (job?.status === "succeeded") {
      succeeded = job;
      return true;
    }
    return false;
  }, timeoutMs);
  return succeeded!;
}

describe("agent state exposure on VPS data", () => {
  let server: ReturnType<typeof app>;

  beforeEach(() => {
    server = app();
  });

  it("surfaces persisted agent state on GET /api/vps (list)", async () => {
    const vpsId = await createVps();
    await agentRepo().upsertState({
      vpsId,
      status: "online",
      version: "1.2.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: new Date().toISOString(),
      lastInstallJobId: "job_install_1",
    });

    const res = await withCookie(request(server).get("/api/vps")).expect(200);
    const record = res.body.data.find(
      (r: { id: string }) => r.id === vpsId,
    );
    expect(record).toBeDefined();
    expect(record.agentStatus).toBe("online");
    expect(record.lastAgentInstallJobId).toBe("job_install_1");
  });

  it("surfaces agent error and failed status on GET /api/vps/:id", async () => {
    const vpsId = await createVps();
    await agentRepo().upsertState({
      vpsId,
      status: "failed",
      lastError: "upload failed: boom",
      lastInstallJobId: "job_install_2",
    });

    const res = await withCookie(
      request(server).get(`/api/vps/${vpsId}`),
    ).expect(200);
    expect(res.body.data.agentStatus).toBe("failed");
    expect(res.body.data.agentLastError).toBe("upload failed: boom");
    expect(res.body.data.lastAgentInstallJobId).toBe("job_install_2");
  });

  it("leaves agent fields absent when no state has been persisted", async () => {
    const vpsId = await createVps();
    const res = await withCookie(
      request(server).get(`/api/vps/${vpsId}`),
    ).expect(200);
    expect(res.body.data.agentStatus).toBeUndefined();
    expect(res.body.data.agentLastError).toBeUndefined();
  });
});

describe("POST /api/vps/:id/uninstall-agent — route guards", () => {
  let server: ReturnType<typeof app>;

  beforeEach(() => {
    server = app();
  });

  it("returns 401 without an authenticated session", async () => {
    const vpsId = await createVps();
    await request(server).post(`/api/vps/${vpsId}/uninstall-agent`).expect(401);
  });

  it("returns 404 for a nonexistent VPS", async () => {
    await withCookie(
      request(server).post("/api/vps/nonexistent/uninstall-agent"),
    ).expect(404);
  });

  it("returns 409 while an install/uninstall is already in flight", async () => {
    const vpsId = await createVps();
    await agentRepo().upsertState({ vpsId, status: "installing" });
    await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(409);
  });

  it("returns 400 when no SSH key has been provisioned", async () => {
    const vpsId = await createVps();
    const res = await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(400);
    expect(res.body.error.message).toMatch(/provisioned SSH key/i);
  });

  it("allows a corrected retry after missing-key preflight failure", async () => {
    const vpsId = await createVps();
    await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(400);

    await provisionKey(vpsId);
    mockSuccessfulRemoval();
    const retry = await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(201);
    await waitForSuccessfulJob(retry.body.data.jobId);
  }, 10_000);

  it("returns 400 for local/system-managed hosts", async () => {
    const vpsId = await createLocalVps();
    const res = await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(400);
    expect(res.body.error.message).toMatch(/built-in agent/i);
  });

  it("blocks uninstall in demo mode", async () => {
    const demoServer = app({ mode: "demo" });
    await request(demoServer)
      .post("/api/vps/demo-edge-sgp-01/uninstall-agent")
      .expect(403);
  });

  it("returns job metadata and queues the job", async () => {
    const vpsId = await createVps();
    await provisionKey(vpsId);
    mockSuccessfulRemoval();

    const res = await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(201);
    expect(res.body.data.jobId).toMatch(/^job_/);
    expect(res.body.data.state.status).toBe("installing");
    expect(res.body.data.state.lastInstallJobId).toBe(res.body.data.jobId);
    expect(JSON.stringify(res.body)).not.toContain("vma_");
    await waitForSuccessfulJob(res.body.data.jobId);
  }, 10_000);

  it("still dispatches when the start audit write rejects", async () => {
    const vpsId = await createVps();
    await provisionKey(vpsId);
    mockSuccessfulRemoval();
    const audit = createJsonAuditRepository(join(tempDir, "data", "audit.json"));
    vi.spyOn(audit, "append").mockRejectedValueOnce(new Error("audit unavailable"));
    const auditFailureServer = app(undefined, { audit });

    const res = await withCookie(
      request(auditFailureServer).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(201);
    expect((await waitForSuccessfulJob(res.body.data.jobId)).status).toBe("succeeded");
  }, 10_000);
});

describe("POST /api/vps/:id/uninstall-agent — successful removal", () => {
  it("removes the agent directory, revokes credentials, clears state, and audits success", async () => {
    const server = app();
    const repo = agentRepo();
    const vpsId = await createVps();
    await provisionKey(vpsId);

    // Pre-seed agent data that must be cleared/downgraded.
    await repo.upsertState({
      vpsId,
      status: "online",
      version: "1.2.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      lastInstallJobId: "job_install_old",
    });
    await repo.upsertSystemInfo({
      vpsId,
      collectedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      agentVersion: "1.2.0",
      os: { name: "ubuntu", version: "22.04" },
    });
    await repo.createCredential({
      vpsId,
      secretHash: "sha256_test",
      status: "active",
    });

    const execSpy = mockSuccessfulRemoval("/home/deploy");

    const post = await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(201);
    const jobId: string = post.body.data.jobId;

    expect((await waitForSuccessfulJob(jobId)).status).toBe("succeeded");

    // Remote commands: home lookup, targeted stop, scoped removal.
    expect(execSpy).toHaveBeenCalled();
    const commands = execSpy.mock.calls.map((c) => String(c[1]));
    expect(commands.some((c) => c.startsWith("echo $HOME"))).toBe(true);
    const stopCmd = commands.find(
      (c) => c.includes("systemctl stop") || c.includes("vps-agent"),
    );
    expect(stopCmd).toBeDefined();
    expect(stopCmd).not.toMatch(/pkill\s+-f/);
    const removeCmd = commands.find((c) => c.includes("rm -rf"));
    expect(removeCmd).toBeDefined();
    expect(removeCmd).toContain(".vps-manager-agent");
    expect(removeCmd).toMatch(/'\/home\/deploy\/\.vps-manager-agent'/);

    // Credentials revoked for this VPS only after successful remote removal.
    const credsAfter = await repo.listCredentialsByVps(vpsId);
    expect(credsAfter.length).toBeGreaterThan(0);
    for (const c of credsAfter) expect(c.status).toBe("revoked");

    await waitUntil(async () => {
      const state = await repo.getState(vpsId);
      return state?.status === "not_installed";
    });
    const state = await repo.getState(vpsId);
    expect(state?.status).toBe("not_installed");
    expect(state?.lastInstallJobId).toBe(jobId);
    expect(state?.lastError).toBeUndefined();

    // Stale system info cleared.
    expect(await repo.getSystemInfo(vpsId)).toBeUndefined();

    // The response and persisted views do not disclose private credentials.
    const responseBody = JSON.stringify(post.body);
    expect(responseBody).not.toContain("PRIVATE KEY");
    expect(responseBody.toLowerCase()).not.toContain("secret_hash");

    // Audit success recorded.
    const auditRes = await withCookie(request(server).get("/api/audit"));
    const actions = auditRes.body.data.map((e: { action: string }) => e.action);
    expect(actions).toContain("agent.uninstall.start");
    expect(actions).toContain("agent.uninstall.success");
    expect(actions).not.toContain("agent.uninstall.failure");

  }, 10_000);
});

describe("POST /api/vps/:id/uninstall-agent — failure behavior", () => {
  it("persists failed state + error, does not revoke credentials, and audits failure", async () => {
    const server = app();
    const repo = agentRepo();
    const vpsId = await createVps();
    await provisionKey(vpsId);
    await repo.upsertState({ vpsId, status: "online" });
    const credential = await repo.createCredential({
      vpsId,
      secretHash: "sha256_test",
      status: "active",
    });

    // First SSH command fails (cannot resolve home directory / connect).
    vi.spyOn(SshService.prototype, "execCommand").mockImplementation(async () => {
      throw new Error("SSH connection timed out. Host unreachable.");
    });

    const post = await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(201);
    const jobId: string = post.body.data.jobId;

    expect((await waitForTerminalJob(jobId)).status).toBe("failed");

    // Failure observability: both job and agent state carry the error.
    const state = await repo.getState(vpsId);
    expect(state?.status).toBe("failed");
    expect(state?.lastError).toMatch(/SSH connection timed out/i);
    expect(state?.lastInstallJobId).toBe(jobId);

    // Credentials are NOT revoked on failure (only after successful removal).
    const credsAfter = await repo.listCredentialsByVps(vpsId);
    expect(
      credsAfter.some((c) => c.id === credential.id && c.status === "active"),
    ).toBe(true);

    const auditRes = await withCookie(request(server).get("/api/audit"));
    const actions = auditRes.body.data.map((e: { action: string }) => e.action);
    expect(actions).toContain("agent.uninstall.failure");
    expect(actions).not.toContain("agent.uninstall.success");
  }, 10_000);

  it("fails when credential revocation silently returns undefined", async () => {
    const repo = agentRepo();
    const server = app(undefined, { agent: repo });
    const vpsId = await createVps();
    await provisionKey(vpsId);
    await repo.upsertState({ vpsId, status: "online" });
    await repo.createCredential({
      vpsId,
      secretHash: "sha256_test",
      status: "active",
    });
    vi.spyOn(repo, "revokeCredential").mockResolvedValue(undefined);
    mockSuccessfulRemoval();

    const post = await withCookie(
      request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
    ).expect(201);
    const terminal = await waitForTerminalJob(post.body.data.jobId);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorMessage).toMatch(/credential revocation failed/i);
    expect((await repo.getState(vpsId))?.status).toBe("failed");
  }, 10_000);
});

describe("monitoring SSE — jobs.updated", () => {
  it("emits typed jobs.updated events for the uninstall job as it progresses", async () => {
    const server = app();
    const repo = agentRepo();
    const vpsId = await createVps();
    await provisionKey(vpsId);
    await repo.upsertState({ vpsId, status: "online" });
    // Slight delay on home lookup so queued→running progress is observable.
    mockSuccessfulRemoval("/root", 350);

    let received = "";
    let remainder = "";
    const seenJobsUpdated: Array<{ jobs: Array<Record<string, unknown>> }> = [];
    const lifecycleSnapshots = new Map<string, Record<string, unknown>>();
    let streamResponse: { destroy(): void } | undefined;
    let resolveStream!: (res: { status?: number; body: unknown }) => void;
    let rejectStream!: (error: unknown) => void;
    const streamPromise = new Promise<{ status?: number; body: unknown }>(
      (resolve, reject) => {
        resolveStream = resolve;
        rejectStream = reject;
      },
    );

    // Start the SSE request immediately (end() kicks the connection off).
    const streamRequest = request(server)
      .get("/api/monitoring/stream")
      .set("Cookie", sessionCookie)
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          remainder += chunk.toString();
          let nl: number;
          while ((nl = remainder.indexOf("\n")) !== -1) {
            const line = remainder.slice(0, nl).trim();
            remainder = remainder.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const envelope = JSON.parse(line.slice(5));
              if (envelope.type === "jobs.updated") {
                seenJobsUpdated.push(envelope.payload);
                for (const job of envelope.payload.jobs ?? []) {
                  if (job.type !== "uninstall-agent") continue;
                  const key = [job.id, job.status, job.step, job.progress].join("/");
                  lifecycleSnapshots.set(key, job);
                }
              }
            } catch {
              // Ignore malformed completed event lines.
            }
          }
          const terminalSeen = [...lifecycleSnapshots.values()].some(
            (job) => job.status === "succeeded" || job.status === "failed",
          );
          // Close once the live progress has reached its terminal state.
          if (terminalSeen) streamResponse?.destroy();
        });
        streamResponse = res as unknown as { destroy(): void };
        res.on("close", () => {
          cb(null, received);
        });
        res.on("error", (err: Error) => cb(err, undefined));
      })
      .timeout(15_000)
      .end((err, res) => {
        if (err) {
          rejectStream(err);
          return;
        }
        resolveStream({ status: res?.status, body: res?.body });
      });

    try {
      // Wait for the stream to connect before mutating state.
      try {
        await waitUntil(
          () =>
            Promise.resolve(
              received.includes("monitoring.hello") ||
                seenJobsUpdated.length > 0,
            ),
          4_000,
        );
      } catch (error) {
        throw new Error(`SSE stream did not connect: ${String(error)}`);
      }
      // Give the handshake a beat, then queue the removal.
      await new Promise((r) => setTimeout(r, 300));
      const post = await withCookie(
        request(server).post(`/api/vps/${vpsId}/uninstall-agent`),
      ).expect(201);

      await streamPromise;
      await waitForTerminalJob(post.body.data.jobId);
    } finally {
      streamResponse?.destroy();
      streamRequest.abort();
    }

    expect(seenJobsUpdated.length).toBeGreaterThan(0);
    const lifecycle = [...lifecycleSnapshots.values()];
    expect(lifecycle.length).toBeGreaterThan(0);
    const statuses = lifecycle.map((j) => j.status);
    // Progress updates arrive over the stream: a queued/running state and a
    // terminal succeeded state.
    expect(statuses.some((s) => s === "queued" || s === "running")).toBe(true);
    const terminal = lifecycle.find(
      (j) => j.status === "succeeded" || j.status === "failed",
    );
    expect(terminal?.status).toBe("succeeded");
    // Job carries vpsId and progress fields the UI depends on.
    expect(lifecycle[0].vpsId).toBe(vpsId);
    for (const j of lifecycle) {
      expect(typeof j.progress).toBe("number");
    }
  }, 25_000);
});
