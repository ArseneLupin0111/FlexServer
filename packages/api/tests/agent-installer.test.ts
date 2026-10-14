import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  dashboardSessionSecret: "installer-test-secret-32+chars-here!!",
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-installer-"));
  vpsRepo = createVpsStore(join(tempDir, "data", "vps.json"));
  keys = createKeyService({
    baseDir: join(tempDir, "private", "keys"),
    keyring: createTestKeyring("installer-test-kek"),
  });
});

afterEach(async () => {
  // Retry cleanup to handle ENOTEMPTY from async job runner side effects
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

async function createVps(host?: string): Promise<string> {
  const record = await vpsRepo.create({
    name: "test-vps",
    host: host ?? "203.0.113.50",
    port: 22,
    username: "root",
  });
  return record.id;
}

async function createMockBinary(): Promise<string> {
  const binaryDir = join(tempDir, "packages", "agent", "dist");
  await mkdir(binaryDir, { recursive: true });
  const binaryPath = join(binaryDir, "vps-agent-linux-amd64");
  await writeFile(binaryPath, "#!/bin/sh\necho mock");
  return binaryPath;
}

function app(overrides?: Partial<AppConfig>): ReturnType<typeof createApp> {
  const config = { ...localConfig, ...overrides };
  return createApp({
    config: {
      ...config,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
    store: vpsRepo,
    keys,
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    jobs: createJsonJobRepository(join(tempDir, "data", "jobs.json")),
    metrics: createJsonMetricRepository(join(tempDir, "data", "metrics.json")),
    agent: createJsonAgentRepository(join(tempDir, "data", "agents.json")),
  });
}

describe("POST /api/vps/:id/install-agent", () => {
  let sessionCookie: string;

  beforeEach(async () => {
    const { createSessionCookie } = await import("./test-helpers.js");
    sessionCookie = await createSessionCookie(
      tempDir,
      localConfig.dashboardSessionSecret,
    );
  });

  const origin = "http://127.0.0.1";
  const withCookie = (req: request.Test) =>
    req
      .set("Cookie", sessionCookie)
      .set("Origin", origin)
      .set("Host", "127.0.0.1");

  it("returns 401 without auth token", async () => {
    const vpsId = await createVps();
    await request(app())
      .post(`/api/vps/${vpsId}/install-agent`)
      .send({})
      .expect(401);
  });

  it("returns 404 for nonexistent VPS", async () => {
    await withCookie(
      request(app()).post("/api/vps/nonexistent/install-agent").send({}),
    ).expect(404);
  });

  it("fails with 409 when agent state is already installing", async () => {
    const vpsId = await createVps();
    const agentRepo = createJsonAgentRepository(
      join(tempDir, "data", "agents.json"),
    );
    await agentRepo.upsertState({ vpsId, status: "installing" });
    await withCookie(
      request(app()).post(`/api/vps/${vpsId}/install-agent`).send({}),
    ).expect(409);
  });

  it("returns 400 when AGENT_PUBLIC_BASE_URL missing and host is localhost", async () => {
    const vpsId = await createVps("localhost");
    await withCookie(
      request(app({ agentPublicBaseUrl: undefined }))
        .post(`/api/vps/${vpsId}/install-agent`)
        .set("Host", "localhost:3000")
        .send({}),
    ).expect(400);
  });

  it("fails with 400 when no auth method", async () => {
    const binaryPath = await createMockBinary();
    const vpsId = await createVps();
    await withCookie(
      request(
        app({
          agentBinaryPath: binaryPath,
          agentPublicBaseUrl: "http://example.com:3000",
          allowInsecureAgentHttp: true,
        }),
      )
        .post(`/api/vps/${vpsId}/install-agent`)
        .send({}),
    ).expect(400);
  });

  it("fails with 400 if key marked but key files missing", async () => {
    const binaryPath = await createMockBinary();
    const vpsId = await createVps();
    await vpsRepo.markKeyProvisioned(vpsId);
    await withCookie(
      request(
        app({
          agentBinaryPath: binaryPath,
          agentPublicBaseUrl: "http://example.com:3000",
          allowInsecureAgentHttp: true,
        }),
      )
        .post(`/api/vps/${vpsId}/install-agent`)
        .send({}),
    ).expect(400);
  });

  it("accepts install with key auth", async () => {
    const binaryPath = await createMockBinary();
    const vpsId = await createVps();
    await keys.ensureKeyPair(vpsId);
    await vpsRepo.markKeyProvisioned(vpsId);

    const server = app({
      agentBinaryPath: binaryPath,
      agentPublicBaseUrl: "http://example.com:3000",
      allowInsecureAgentHttp: true,
    });

    const res = await withCookie(
      request(server).post(`/api/vps/${vpsId}/install-agent`).send({}),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.jobId).toBeDefined();
    expect(res.body.data.state.status).toBe("installing");
  });

  it("accepts install with password auth and returns job/state", async () => {
    const binaryPath = await createMockBinary();
    const vpsId = await createVps();
    const server = app({
      agentBinaryPath: binaryPath,
      agentPublicBaseUrl: "http://example.com:3000",
      allowInsecureAgentHttp: true,
    });

    const res = await withCookie(
      request(server)
        .post(`/api/vps/${vpsId}/install-agent`)
        .send({ password: "test-pass" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.jobId).toMatch(/^job_/);
    expect(res.body.data.state.status).toBe("installing");

    const agentRepo = createJsonAgentRepository(
      join(tempDir, "data", "agents.json"),
    );
    const state = await agentRepo.getState(vpsId);
    expect(state).toBeDefined();
    expect(state!.status).toBe("installing");

    const auditRes = await request(server)
      .get("/api/audit")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(JSON.stringify(auditRes.body)).not.toContain("vma_");

    const jobsRes = await request(server)
      .get("/api/jobs")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(JSON.stringify(jobsRes.body)).not.toContain("vma_");
  });
});
