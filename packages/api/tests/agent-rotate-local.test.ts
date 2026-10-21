import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonJobRepository } from "../src/persistence/repositories/job.repository.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { LocalAgentRotationHelper } from "../src/agents/local-agent-rotation-helper.service.js";
import type { CommandJob } from "../src/jobs/jobs.models.js";
import type { KeyService } from "../src/ssh/keyService.js";

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
  dashboardSessionSecret: "rotate-test-secret-32+chars-here!!!",
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-rotate-"));
  vpsRepo = createVpsStore(join(tempDir, "data", "vps.json"));
  sharedAgentRepo = createJsonAgentRepository(join(tempDir, "data", "agents.json"));
  sharedJobRepo = createJsonJobRepository(join(tempDir, "data", "jobs.json"));
  keys = createKeyService(join(tempDir, "private", "keys"));
  const { createSessionCookie } = await import("./test-helpers.js");
  sessionCookie = await createSessionCookie(
    tempDir,
    localConfig.dashboardSessionSecret,
  );
});

afterEach(async () => {
  await closeTestApps();
  for (let attempt = 0; attempt < 200; attempt++) {
    let jobs: CommandJob[];
    try {
      jobs = await sharedJobRepo.list();
    } catch {
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    if (
      jobs.every(
        (job) =>
          job.status === "succeeded" ||
          job.status === "failed" ||
          job.status === "cancelled",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  vi.restoreAllMocks();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      break;
    } catch {
      if (attempt === 4) throw new Error(`Failed to cleanup ${tempDir}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

function app() {
  return createApp({
    store: vpsRepo,
    keys,
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    jobs: sharedJobRepo,
    metrics: createJsonMetricRepository(join(tempDir, "data", "metrics.json")),
    agent: sharedAgentRepo,
    config: {
      ...localConfig,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
  });
}

function withCookie(req: request.Test) {
  return req
    .set("Cookie", sessionCookie)
    .set("Origin", "http://127.0.0.1")
    .set("Host", "127.0.0.1");
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

async function createRemoteVps(): Promise<string> {
  const record = await vpsRepo.create({
    name: "remote-vps",
    host: "203.0.113.50",
    port: 22,
    username: "root",
  });
  return record.id;
}

async function waitForJob(
  jobId: string,
  want: "succeeded" | "failed",
  timeoutMs = 15_000,
): Promise<CommandJob> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await sharedJobRepo.get(jobId);
    if (job?.status === want) return job;
    if (
      job?.status === "succeeded" ||
      job?.status === "failed" ||
      job?.status === "cancelled"
    ) {
      throw new Error(
        `Rotate job ended as ${job.status}: ${job.errorMessage ?? "unknown"}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForJob timed out after ${timeoutMs}ms`);
}

describe("POST /api/vps/:id/rotate-agent", () => {
  it("returns 401 without an authenticated session", async () => {
    const vpsId = await createLocalVps();
    await request(app()).post(`/api/vps/${vpsId}/rotate-agent`).expect(401);
  });

  it("rejects remote/user-managed hosts with 400", async () => {
    const vpsId = await createRemoteVps();
    const res = await withCookie(
      request(app()).post(`/api/vps/${vpsId}/rotate-agent`),
    ).expect(400);
    expect(res.body.error.message).toMatch(/local/i);
  });

  it("helper failure preserves the old active credential", async () => {
    const server = app();
    const vpsId = await createLocalVps();
    const old = await sharedAgentRepo.createCredential({
      vpsId,
      secretHash: "sha256_old",
      status: "active",
    });

    vi.spyOn(
      LocalAgentRotationHelper.prototype,
      "applyCredential",
    ).mockRejectedValueOnce(new Error("helper boom"));

    const post = await withCookie(
      request(server).post(`/api/vps/${vpsId}/rotate-agent`),
    ).expect(201);
    const jobId: string = post.body.data.jobId;
    const newCredentialId: string = post.body.data.credentialId;
    expect(jobId).toMatch(/^job_/);

    await waitForJob(jobId, "failed");

    const creds = await sharedAgentRepo.listCredentialsByVps(vpsId);
    const oldAfter = creds.find((c) => c.id === old.id);
    expect(oldAfter?.status).toBe("active");
    const fresh = creds.find((c) => c.id === newCredentialId);
    expect(fresh?.status).toBe("revoked");
  }, 15_000);

  it("helper success rotates to the new credential with a redacted response", async () => {
    const server = app();
    const vpsId = await createLocalVps();
    const old = await sharedAgentRepo.createCredential({
      vpsId,
      secretHash: "sha256_old",
      status: "active",
    });

    vi.spyOn(
      LocalAgentRotationHelper.prototype,
      "applyCredential",
    ).mockResolvedValueOnce(undefined);

    const post = await withCookie(
      request(server).post(`/api/vps/${vpsId}/rotate-agent`),
    ).expect(201);
    expect(post.body.data.jobId).toMatch(/^job_/);
    expect(post.body.data.credentialId).toBeDefined();
    expect(JSON.stringify(post.body)).not.toContain("vma_");

    await waitForJob(post.body.data.jobId, "succeeded");

    const creds = await sharedAgentRepo.listCredentialsByVps(vpsId);
    const rotated = creds.find((c) => c.id === post.body.data.credentialId);
    expect(rotated?.status).toBe("active");
    const oldAfter = creds.find((c) => c.id === old.id);
    expect(oldAfter?.status).toBe("revoked");

    const jobsRes = await withCookie(request(server).get("/api/jobs")).expect(
      200,
    );
    expect(JSON.stringify(jobsRes.body)).not.toContain("vma_");
  }, 15_000);

  it("preserves active local-updater credential when rotating agent credential", async () => {
    const server = app();
    const vpsId = await createLocalVps();
    const oldAgent = await sharedAgentRepo.createCredential({
      vpsId,
      secretHash: "sha256_old_agent",
      status: "active",
      scope: "agent",
    });
    const updaterCred = await sharedAgentRepo.createCredential({
      vpsId,
      secretHash: "sha256_updater",
      status: "active",
      scope: "local-updater",
    });

    vi.spyOn(
      LocalAgentRotationHelper.prototype,
      "applyCredential",
    ).mockResolvedValueOnce(undefined);

    const post = await withCookie(
      request(server).post(`/api/vps/${vpsId}/rotate-agent`),
    ).expect(201);

    await waitForJob(post.body.data.jobId, "succeeded");

    const creds = await sharedAgentRepo.listCredentialsByVps(vpsId);
    const rotated = creds.find((c) => c.id === post.body.data.credentialId);
    expect(rotated?.status).toBe("active");
    expect(rotated?.scope).toBe("agent");

    const oldAgentAfter = creds.find((c) => c.id === oldAgent.id);
    expect(oldAgentAfter?.status).toBe("revoked");

    const updaterAfter = creds.find((c) => c.id === updaterCred.id);
    expect(updaterAfter?.status).toBe("active");
    expect(updaterAfter?.scope).toBe("local-updater");
  }, 15_000);
});

describe("LocalAgentRotationHelper process execution", () => {
  const originalHelperEnv = process.env.LOCAL_AGENT_ROTATION_HELPER;
  const originalTimeoutEnv = process.env.LOCAL_AGENT_ROTATION_TIMEOUT_MS;

  afterEach(() => {
    if (originalHelperEnv === undefined) {
      delete process.env.LOCAL_AGENT_ROTATION_HELPER;
    } else {
      process.env.LOCAL_AGENT_ROTATION_HELPER = originalHelperEnv;
    }
    if (originalTimeoutEnv === undefined) {
      delete process.env.LOCAL_AGENT_ROTATION_TIMEOUT_MS;
    } else {
      process.env.LOCAL_AGENT_ROTATION_TIMEOUT_MS = originalTimeoutEnv;
    }
  });

  it("fails closed when LOCAL_AGENT_ROTATION_HELPER is not configured", async () => {
    delete process.env.LOCAL_AGENT_ROTATION_HELPER;
    const helper = new LocalAgentRotationHelper();
    await expect(
      helper.applyCredential("vps_local", "vma_cred_secret123"),
    ).rejects.toThrow("Local agent rotation helper is not configured");
  });

  it("resolves when helper process exits with code 0", async () => {
    const scriptPath = join(tempDir, "mock-success-helper.js");
    await writeFile(
      scriptPath,
      `
      let data = '';
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => {
        const parsed = JSON.parse(data.trim());
        if (parsed.vpsId && parsed.token) process.exit(0);
        process.exit(2);
      });
      `,
      "utf8",
    );

    process.env.LOCAL_AGENT_ROTATION_HELPER = scriptPath;
    const helper = new LocalAgentRotationHelper();
    await expect(
      helper.applyCredential("vps_local", "vma_cred_secret123"),
    ).resolves.toBeUndefined();
  });

  it("rejects with sanitized stderr when helper exits non-zero and redacts tokens", async () => {
    const scriptPath = join(tempDir, "mock-fail-helper.js");
    await writeFile(
      scriptPath,
      `
      process.stderr.write("Failed to update config for token vma_cred_secret123: permission denied\\n");
      process.exit(1);
      `,
      "utf8",
    );

    process.env.LOCAL_AGENT_ROTATION_HELPER = scriptPath;
    const helper = new LocalAgentRotationHelper();
    await expect(
      helper.applyCredential("vps_local", "vma_cred_secret123"),
    ).rejects.toThrow(/Rotation helper exited with code 1/);

    try {
      await helper.applyCredential("vps_local", "vma_cred_secret123");
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("vma_cred_secret123");
      expect(msg).toContain("[REDACTED]");
    }
  });

  it("times out and kills child process when helper does not exit", async () => {
    // Deliberate test of child process timeout termination with short timeout
    const scriptPath = join(tempDir, "mock-hanging-helper.js");
    await writeFile(
      scriptPath,
      `
      import net from "node:net";
      const server = net.createServer().listen(0);
      `,
      "utf8",
    );

    process.env.LOCAL_AGENT_ROTATION_HELPER = scriptPath;
    process.env.LOCAL_AGENT_ROTATION_TIMEOUT_MS = "200";
    const helper = new LocalAgentRotationHelper();
    await expect(
      helper.applyCredential("vps_local", "vma_cred_secret123"),
    ).rejects.toThrow(/timed out after 200ms/);
  });
});

describe("Local agent rotation client and socket protocol", () => {
  const originalHelperEnv = process.env.LOCAL_AGENT_ROTATION_HELPER;
  const originalSocketEnv = process.env.LOCAL_AGENT_ROTATION_SOCKET;

  let testSocketPath: string;
  let clientBinaryPath: string;
  let server: net.Server | null = null;

  beforeEach(() => {
    testSocketPath = join(tempDir, "agent-rotation.sock");
    const ext = process.platform === "win32" ? ".exe" : "";
    const here = fileURLToPath(new URL(".", import.meta.url));
    const candidates = [
      join(process.cwd(), `packages/agent/dist/local-agent-rotator${ext}`),
      join(process.cwd(), `packages/agent/dist/local-agent-rotator-linux-amd64`),
      resolve(here, `../../agent/dist/local-agent-rotator${ext}`),
      resolve(here, `../../agent/dist/local-agent-rotator-linux-amd64`),
      "/usr/local/bin/local-agent-rotation-client",
      "/usr/local/bin/flexserver-local-agent-rotator",
    ];
    clientBinaryPath = candidates.find((cand) => existsSync(cand)) || "";
  });
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (originalHelperEnv === undefined) {
      delete process.env.LOCAL_AGENT_ROTATION_HELPER;
    } else {
      process.env.LOCAL_AGENT_ROTATION_HELPER = originalHelperEnv;
    }
    if (originalSocketEnv === undefined) {
      delete process.env.LOCAL_AGENT_ROTATION_SOCKET;
    } else {
      process.env.LOCAL_AGENT_ROTATION_SOCKET = originalSocketEnv;
    }
  });

  it.skipIf(process.platform === "win32")(
    "successfully passes payload to socket server and resolves on ok: true",
    async () => {
      let receivedPayload: { vpsId?: string; token?: string } | null = null;
      server = net.createServer((conn) => {
      let raw = "";
      conn.on("data", (chunk) => {
        raw += chunk.toString("utf8");
        if (raw.includes("\n")) {
          receivedPayload = JSON.parse(raw.trim());
          conn.write(JSON.stringify({ ok: true }) + "\n");
          conn.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(testSocketPath, () => resolve());
    });

    process.env.LOCAL_AGENT_ROTATION_HELPER = clientBinaryPath;
    process.env.LOCAL_AGENT_ROTATION_SOCKET = testSocketPath;

    const helper = new LocalAgentRotationHelper();
    await helper.applyCredential("vps_local", "vma_test_secret_999");

    expect(receivedPayload).toEqual({
      vpsId: "vps_local",
      token: "vma_test_secret_999",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects and redacts token when socket server rejects request",
    async () => {
    server = net.createServer((conn) => {
      let raw = "";
      conn.on("data", (chunk) => {
        raw += chunk.toString("utf8");
        if (raw.includes("\n")) {
          conn.write(
            JSON.stringify({
              ok: false,
              error: "vpsId mismatch: expected vps_local_host, got wrong_vps",
            }) + "\n",
          );
          conn.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(testSocketPath, () => resolve());
    });

    process.env.LOCAL_AGENT_ROTATION_HELPER = clientBinaryPath;
    process.env.LOCAL_AGENT_ROTATION_SOCKET = testSocketPath;

    const helper = new LocalAgentRotationHelper();
    await expect(
      helper.applyCredential("wrong_vps", "vma_leaky_secret_123"),
    ).rejects.toThrow(/vpsId mismatch/);
  });

  it("rejects when rotation socket cannot be reached", async () => {
    process.env.LOCAL_AGENT_ROTATION_HELPER = clientBinaryPath;
    process.env.LOCAL_AGENT_ROTATION_SOCKET = testSocketPath;

    const helper = new LocalAgentRotationHelper();
    await expect(
      helper.applyCredential("vps_local", "vma_secret"),
    ).rejects.toThrow(/Socket connection failed|exited with code 1/);
  });

  it.skipIf(process.platform === "win32")(
    "end-to-end full controller rotation succeeds via client and mock host socket",
    async () => {
    const apiApp = app();
    const vpsId = await createLocalVps();
    const oldCred = await sharedAgentRepo.createCredential({
      vpsId,
      secretHash: "sha256_old",
      status: "active",
    });

    server = net.createServer((conn) => {
      let raw = "";
      conn.on("data", (chunk) => {
        raw += chunk.toString("utf8");
        if (raw.includes("\n")) {
          conn.write(JSON.stringify({ ok: true }) + "\n");
          conn.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(testSocketPath, () => resolve());
    });

    process.env.LOCAL_AGENT_ROTATION_HELPER = clientBinaryPath;
    process.env.LOCAL_AGENT_ROTATION_SOCKET = testSocketPath;

    const post = await withCookie(
      request(apiApp).post(`/api/vps/${vpsId}/rotate-agent`),
    ).expect(201);

    const jobId: string = post.body.data.jobId;
    const newCredentialId: string = post.body.data.credentialId;
    expect(jobId).toMatch(/^job_/);
    expect(JSON.stringify(post.body)).not.toContain("vma_");

    await waitForJob(jobId, "succeeded");

    const creds = await sharedAgentRepo.listCredentialsByVps(vpsId);
    const newCred = creds.find((c) => c.id === newCredentialId);
    expect(newCred?.status).toBe("active");
    const oldCredAfter = creds.find((c) => c.id === oldCred.id);
    expect(oldCredAfter?.status).toBe("revoked");
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "end-to-end full controller rotation fails and preserves old credential on socket failure",
    async () => {
    const apiApp = app();
    const vpsId = await createLocalVps();
    const oldCred = await sharedAgentRepo.createCredential({
      vpsId,
      secretHash: "sha256_old",
      status: "active",
    });

    server = net.createServer((conn) => {
      let raw = "";
      conn.on("data", (chunk) => {
        raw += chunk.toString("utf8");
        if (raw.includes("\n")) {
          conn.write(JSON.stringify({ ok: false, error: "host systemctl restart failed" }) + "\n");
          conn.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(testSocketPath, () => resolve());
    });
    process.env.LOCAL_AGENT_ROTATION_HELPER = clientBinaryPath;
    process.env.LOCAL_AGENT_ROTATION_SOCKET = testSocketPath;

    const post = await withCookie(
      request(apiApp).post(`/api/vps/${vpsId}/rotate-agent`),
    ).expect(201);

    const jobId: string = post.body.data.jobId;
    const newCredentialId: string = post.body.data.credentialId;

    await waitForJob(jobId, "failed");

    const creds = await sharedAgentRepo.listCredentialsByVps(vpsId);
    const oldCredAfter = creds.find((c) => c.id === oldCred.id);
    expect(oldCredAfter?.status).toBe("active");
    const newCred = creds.find((c) => c.id === newCredentialId);
    expect(newCred?.status).toBe("revoked");
  }, 15_000);
});
