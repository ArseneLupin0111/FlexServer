import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArgumentsHost, HttpException } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ApiExceptionFilter } from "../src/common/filters/api-exception.filter.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { LocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import { createJsonLocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { createSessionCookie } from "./test-helpers.js";

const RELEASE_SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const BASELINE_SHA = "1111111111111111111111111111111111111111";

// Environment captured before any test mutates it so unconfigured tests stay
// deterministic regardless of execution order.
const initialEnv = {
  AGENT_RELEASE_PUBLIC_KEY: process.env.AGENT_RELEASE_PUBLIC_KEY,
  AGENT_RELEASE_MANIFEST_URL: process.env.AGENT_RELEASE_MANIFEST_URL,
  AGENT_BINARY_PATH: process.env.AGENT_BINARY_PATH,
};
const initialFetch = globalThis.fetch;

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
  dashboardSessionSecret: "local-updater-routes-secret-32+chars!",
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

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
let sessionCookie: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-updater-routes-"));
  vpsRepo = createVpsStore(join(tempDir, "data", "vps.json"));
  agentRepo = createJsonAgentRepository(join(tempDir, "data", "agents.json"));
  lugRepo = createJsonLocalUpgradeRepository(
    join(tempDir, "data", "local-upgrades.json"),
  );
  sessionCookie = await createSessionCookie(
    tempDir,
    localConfig.dashboardSessionSecret,
  );
  setupBundledBinary();
});

afterEach(async () => {
  process.env.AGENT_RELEASE_PUBLIC_KEY = initialEnv.AGENT_RELEASE_PUBLIC_KEY;
  if (initialEnv.AGENT_RELEASE_PUBLIC_KEY === undefined) {
    delete process.env.AGENT_RELEASE_PUBLIC_KEY;
  }
  process.env.AGENT_RELEASE_MANIFEST_URL =
    initialEnv.AGENT_RELEASE_MANIFEST_URL;
  if (initialEnv.AGENT_RELEASE_MANIFEST_URL === undefined) {
    delete process.env.AGENT_RELEASE_MANIFEST_URL;
  }
  process.env.AGENT_BINARY_PATH = initialEnv.AGENT_BINARY_PATH;
  if (initialEnv.AGENT_BINARY_PATH === undefined) {
    delete process.env.AGENT_BINARY_PATH;
  }
  globalThis.fetch = initialFetch;
  await rm(tempDir, { recursive: true, force: true });
});

function setupBundledBinary(customDir?: string) {
  const dir = customDir ?? tempDir;
  const binPath = join(dir, "vps-agent-linux-amd64");
  const dummyElf = Buffer.alloc(128);
  dummyElf[0] = 0x7f;
  dummyElf[1] = 0x45; // 'E'
  dummyElf[2] = 0x4c; // 'L'
  dummyElf[3] = 0x46; // 'F'
  dummyElf[4] = 2; // ELFCLASS64
  dummyElf[5] = 1; // ELFDATA2LSB
  dummyElf[6] = 1; // EV_CURRENT
  dummyElf[7] = 0; // ELFOSABI_NONE
  dummyElf[16] = 2; // ET_EXEC
  dummyElf.writeUInt16LE(0x3e, 18); // EM_X86_64
  dummyElf.write(`version.Build=${RELEASE_SHA}\0`, 32);
  dummyElf.write("version.Value=1.4.0\0", 80);
  writeFileSync(binPath, dummyElf);
  const companion = {
    os: "linux",
    arch: "amd64",
    version: "1.4.0",
    buildId: RELEASE_SHA,
    sha256: createHash("sha256").update(dummyElf).digest("hex"),
    size: dummyElf.length,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(`${binPath}.json`, JSON.stringify(companion, null, 2));
  process.env.AGENT_BINARY_PATH = binPath;
  return { binPath, companion };
}

function serveApp() {
  return createApp({
    store: vpsRepo,
    agent: agentRepo,
    localUpgrades: lugRepo,
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

// ── Domain helpers ──────────────────────────────────────────────────────

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

async function credentialToken(
  vpsId: string,
  scope: "agent" | "local-updater",
): Promise<string> {
  const secret = randomBytes(32).toString("hex");
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const credential = await agentRepo.createCredential({
    vpsId,
    secretHash,
    status: "active",
    scope,
  });
  return `vma_${credential.id}_${secret}`;
}

async function touchHeartbeat(vpsId: string, protocolVersion = 2) {
  await lugRepo.recordUpdaterHeartbeat({
    vpsId,
    lastSeenAt: new Date().toISOString(),
    credentialId: "cred_updater_test",
    protocolVersion,
  });
}

async function upsertBuild(vpsId: string, buildId: string, ageMs = 0) {
  await agentRepo.upsertState({
    vpsId,
    status: "online",
    version: "1.2.0",
    buildId,
    lastSeenAt: new Date(Date.now() - ageMs).toISOString(),
  });
  await agentRepo.upsertSystemInfo({ vpsId, kernel: { arch: "x86_64" } });
}

async function createQueuedJob(
  server: ReturnType<typeof serveApp>,
  vpsId: string,
  headers: Record<string, string> = {},
) {
  const res = await withCookie(
    request(server)
      .post(`/api/vps/${vpsId}/local-agent-upgrades`)
      .set(headers)
      .send({ releaseId: RELEASE_SHA }),
  ).expect(201);
  return res.body.data as { id: string };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("admin auth guards", () => {
  it("requires a dashboard session for agent-update reads", async () => {
    const vpsId = await createLocalVps();
    const res = await request(serveApp())
      .get(`/api/vps/${vpsId}/agent-update`)
      .expect(401);
    expect(res.body.error.message).toBe("Authentication required");
  });

  it("requires a session before the Origin check on mutations", async () => {
    const vpsId = await createLocalVps();
    await request(serveApp())
      .post(`/api/vps/${vpsId}/local-agent-upgrades`)
      .send({ releaseId: RELEASE_SHA })
      .expect(401);

    const noOrigin = await request(serveApp())
      .post(`/api/vps/${vpsId}/local-agent-upgrades`)
      .set("Cookie", sessionCookie)
      .send({ releaseId: RELEASE_SHA })
      .expect(403);
    expect(noOrigin.body.error.message).toBe("Origin header required");
  });

  it("maps unknown VPS ids to 404 and remote hosts to not_local", async () => {
    const server = serveApp();
    await withCookie(request(server).get("/api/vps/ghost/agent-update")).expect(
      404,
      { error: { message: "VPS not found" } },
    );

    const remoteId = await createRemoteVps();
    const res = await withCookie(
      request(server)
        .post(`/api/vps/${remoteId}/local-agent-upgrades`)
        .send({ releaseId: RELEASE_SHA }),
    ).expect(409);
    expect(res.body.error.code).toBe("not_local");
  });
});

describe("job lifecycle over HTTP", () => {
  it("creates a queued job with null contract fields, replays idempotency and conflicts", async () => {
    const server = serveApp({ catalog: true });
    const vpsId = await createLocalVps();
    await touchHeartbeat(vpsId);
    await upsertBuild(vpsId, BASELINE_SHA, 5_000);

    const created = await createQueuedJob(server, vpsId, {
      "Idempotency-Key": "http-key-1",
    });
    expect(created.id).toMatch(/^lug_[A-Za-z0-9_-]{12}$/);

    const res = await withCookie(
      request(server)
        .post(`/api/vps/${vpsId}/local-agent-upgrades`)
        .set("Idempotency-Key", "http-key-1")
        .send({ releaseId: RELEASE_SHA }),
    ).expect(201);
    expect(res.body.data.id).toBe(created.id);
    expect(res.body.data.state).toBe("queued");
    // Locked Web contract: nullable job fields are present as null, not
    // omitted keys.
    expect(res.body.data.error).toBeNull();
    expect(res.body.data.result).toBeNull();
    expect(res.body.data.claimedAt).toBeNull();
    expect(res.body.data.leaseExpiresAt).toBeNull();
    expect(res.body.data.completedAt).toBeNull();

    const conflict = await withCookie(
      request(server)
        .post(`/api/vps/${vpsId}/local-agent-upgrades`)
        .send({ releaseId: RELEASE_SHA }),
    ).expect(409);
    expect(conflict.body.error).toEqual({
      message: "An upgrade job is already active for this host",
      code: "active_job_exists",
      jobId: created.id,
    });

    const list = await withCookie(
      request(server).get(`/api/vps/${vpsId}/local-agent-upgrades`),
    ).expect(200);
    expect(list.body.meta).toEqual({ limit: 50, offset: 0, count: 1 });
    expect(list.body.data[0].id).toBe(created.id);

    const fetched = await withCookie(
      request(server).get(
        `/api/vps/${vpsId}/local-agent-upgrades/${created.id}`,
      ),
    ).expect(200);
    expect(fetched.body.data.id).toBe(created.id);

    const missing = await withCookie(
      request(server).get(
        `/api/vps/${vpsId}/local-agent-upgrades/lug_abcdefghijkl`,
      ),
    ).expect(404);
    expect(missing.body.error.code).toBe("job_not_found");

    const view = await withCookie(
      request(server).get(`/api/vps/${vpsId}/agent-update`),
    ).expect(200);
    expect(view.body.data.state).toBe("available");
    expect(view.body.data.available.releaseId).toBe(RELEASE_SHA);
    expect(view.body.data.compatibility.compatible).toBe(true);
    expect(view.body.data.updater.healthy).toBe(true);
    expect(view.body.data.job.id).toBe(created.id);
  });

  it("reports release_unavailable when the binary is unconfigured", async () => {
    process.env.AGENT_BINARY_PATH = join(tempDir, "missing-binary");
    const server = serveApp();
    const vpsId = await createLocalVps();
    await touchHeartbeat(vpsId);
    await upsertBuild(vpsId, BASELINE_SHA, 5_000);

    const res = await withCookie(
      request(server)
        .post(`/api/vps/${vpsId}/local-agent-upgrades`)
        .send({ releaseId: RELEASE_SHA }),
    ).expect(409);
    expect(res.body.error.code).toBe("release_unavailable");

    const view = await withCookie(
      request(server).get(`/api/vps/${vpsId}/agent-update`),
    ).expect(200);
    expect(view.body.data.state).toBe("release_unavailable");
    expect(view.body.data.available).toBeNull();
    expect(view.body.data.compatibility.reason).toBe("release_unavailable");
  });

  it("gates creation on updater health before the catalog", async () => {
    const server = serveApp({ catalog: true });
    const vpsId = await createLocalVps();
    await upsertBuild(vpsId, BASELINE_SHA, 5_000);
    // Fresh heartbeat deliberately NOT recorded.

    const res = await withCookie(
      request(server)
        .post(`/api/vps/${vpsId}/local-agent-upgrades`)
        .send({ releaseId: RELEASE_SHA }),
    ).expect(409);
    expect(res.body.error.code).toBe("updater_unhealthy");
  });
});

describe("local-updater credential isolation", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await request(serveApp())
      .post("/api/local-updater/jobs/claim")
      .expect(401);
    expect(res.body.error.message).toBe("Missing authorization header");
  });

  it("rejects agent-scoped credentials on updater routes", async () => {
    const server = serveApp();
    const vpsId = await createLocalVps();
    const token = await credentialToken(vpsId, "agent");

    const res = await request(server)
      .post("/api/local-updater/jobs/claim")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    expect(res.body.error.code).toBe("invalid_credential_scope");
  });

  it("rejects updater-scoped credentials on agent routes", async () => {
    const server = serveApp();
    const vpsId = await createLocalVps();
    const token = await credentialToken(vpsId, "local-updater");

    const res = await request(server)
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(403);
    expect(res.body.error.code).toBe("invalid_credential_scope");
  });

  it("rejects updater credentials bound to a remote host", async () => {
    const server = serveApp();
    const remoteId = await createRemoteVps();
    const token = await credentialToken(remoteId, "local-updater");

    const res = await request(server)
      .post("/api/local-updater/jobs/claim")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    expect(res.body.error.code).toBe("invalid_credential_scope");
    expect(res.body.error.message).toContain("local host");
  });
});

describe("claim, progress and result", () => {
  it("claims nothing when no upgrade job is active", async () => {
    const server = serveApp();
    const vpsId = await createLocalVps();
    const token = await credentialToken(vpsId, "local-updater");

    const res = await request(server)
      .post("/api/local-updater/jobs/claim")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.job).toBeNull();
  });

  it("walks phases with fencing, lease replay and heartbeat confirmation", async () => {
    const server = serveApp({ catalog: true });
    const vpsId = await createLocalVps();
    await touchHeartbeat(vpsId);
    await upsertBuild(vpsId, BASELINE_SHA, 5_000);
    const job = await createQueuedJob(server, vpsId);
    const token = await credentialToken(vpsId, "local-updater");
    const auth = { Authorization: `Bearer ${token}`, "X-Updater-Protocol-Version": "2" };

    // Claim: first claim fences the job; a second claim with a live lease is
    // an idempotent replay (same fencing token, no reclaim).
    const claim1 = await request(server)
      .post("/api/local-updater/jobs/claim")
      .set(auth)
      .expect(200);
    expect(claim1.body.data.job).toMatchObject({
      jobId: job.id,
      phase: "claimed",
      release: {
        releaseId: RELEASE_SHA,
        buildId: RELEASE_SHA,
        targetSha256: expect.any(String),
      },
    });
    expect(claim1.body.data.job.state).toBe("claimed");
    expect(claim1.body.data.job.fencingToken).toBe(1);
    expect(claim1.body.data.job.jobId).toBe(job.id);
    expect(claim1.body.data.job.leaseExpiresAt).toEqual(expect.any(String));
    expect(claim1.body.data.requiresReconcile).toBe(false);

    const claim2 = await request(server)
      .post("/api/local-updater/jobs/claim")
      .set(auth)
      .expect(200);
    expect(claim2.body.data.job.fencingToken).toBe(1);
    expect(claim2.body.data.requiresReconcile).toBe(false);

    // Phase walk; a stale fencing token is rejected without mutating state.
    const stale = await request(server)
      .post(`/api/local-updater/jobs/${job.id}/progress`)
      .set(auth)
      .send({ fencingToken: 99, phase: "downloading", progress: 10 })
      .expect(409);
    expect(stale.body.error.code).toBe("stale_lease");

    for (const [phase, progress] of [
      ["downloading", 10],
      ["verifying", 40],
      ["staging", 70],
    ] as const) {
      const res = await request(server)
        .post(`/api/local-updater/jobs/${job.id}/progress`)
        .set(auth)
        .send({ fencingToken: 1, phase, progress })
        .expect(200);
      expect(res.body.data.job.state).toBe(phase);
      expect(res.body.data.job.progress).toBe(progress);
    }

    const restarting = await request(server)
      .post(`/api/local-updater/jobs/${job.id}/progress`)
      .set(auth)
      .send({ fencingToken: 1, phase: "restarting", progress: 90 })
      .expect(200);
    expect(restarting.body.data.job.baselineBuildId).toBe(BASELINE_SHA);
    expect(restarting.body.data.job.baselineHeartbeatAt).toEqual(
      expect.any(String),
    );

    await request(server)
      .post(`/api/local-updater/jobs/${job.id}/progress`)
      .set(auth)
      .send({ fencingToken: 1, phase: "awaiting_heartbeat", progress: 95 })
      .expect(200);

    // Updater reads still work after the swap.
    const updaterGet = await request(server)
      .get(`/api/local-updater/jobs/${job.id}`)
      .set(auth)
      .expect(200);
    expect(updaterGet.body.data.job.state).toBe("awaiting_heartbeat");

    // Success is ruled by the heartbeat, not the updater's word.
    const early = await request(server)
      .post(`/api/local-updater/jobs/${job.id}/result`)
      .set(auth)
      .send({
        fencingToken: 1,
        outcome: "succeeded",
        reportedBuildId: RELEASE_SHA,
      })
      .expect(200);
    expect(early.body.data.awaitHeartbeat).toBe(true);
    expect(early.body.data.job.state).toBe("awaiting_heartbeat");

    await upsertBuild(vpsId, RELEASE_SHA, 1_000);
    const confirmed = await request(server)
      .post(`/api/local-updater/jobs/${job.id}/result`)
      .set(auth)
      .send({
        fencingToken: 1,
        outcome: "succeeded",
        reportedBuildId: RELEASE_SHA,
      })
      .expect(200);
    expect(confirmed.body.data.awaitHeartbeat).toBeUndefined();
    expect(confirmed.body.data.job.state).toBe("succeeded");
    expect(confirmed.body.data.job.completedAt).toEqual(expect.any(String));
    expect(confirmed.body.data.job.result.outcome).toBe("succeeded");

    // Terminal jobs reject further updater writes and stay readable.
    const terminal = await request(server)
      .post(`/api/local-updater/jobs/${job.id}/progress`)
      .set(auth)
      .send({ fencingToken: 1, phase: "downloading", progress: 10 })
      .expect(409);
    expect(terminal.body.error.code).toBe("job_terminal");

    const adminGet = await withCookie(
      request(server).get(`/api/vps/${vpsId}/local-agent-upgrades/${job.id}`),
    ).expect(200);
    expect(adminGet.body.data.state).toBe("succeeded");

    const view = await withCookie(
      request(server).get(`/api/vps/${vpsId}/agent-update`),
    ).expect(200);
    expect(view.body.data.state).toBe("current");
    expect(view.body.data.job.state).toBe("succeeded");
    expect(view.body.data.job.id).toBe(job.id);
  }, 15_000);
});

describe("error envelope", () => {
  it("passes machine-readable fields through and strips everything else", () => {
    const filter = new ApiExceptionFilter();
    let status = 0;
    let body: unknown;
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: "req_test" }),
        getResponse: () => ({
          status: (code: number) => {
            status = code;
            return {
              json: (payload: unknown) => {
                body = payload;
              },
            };
          },
        }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(
      new HttpException(
        {
          error: {
            message: "Release does not support this API contract version",
            code: "release_incompatible",
            reason: "api_incompatible",
            internalDetail: "must-not-leak",
          },
        },
        400,
      ),
      host,
    );

    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        message: "Release does not support this API contract version",
        code: "release_incompatible",
        reason: "api_incompatible",
      },
    });
  });
});
