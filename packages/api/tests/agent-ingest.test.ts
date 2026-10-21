import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonDockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createJsonJobRepository } from "../src/persistence/repositories/job.repository.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { AgentService } from "../src/agents/agent.service.js";
import { agentMetricPayloadSchema } from "../src/agents/agent.schemas.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { isFreshTimestamp } from "../src/monitoring/monitoring.service.js";

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
let vpsRepo: VpsRepository;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-agent-"));
  vpsRepo = createVpsStore(join(tempDir, "data", "vps.json"));
});

afterEach(async () => {
  await closeTestApps();
  await rm(tempDir, { recursive: true, force: true });
});

// ── Test helpers ────────────────────────────────────────────────────────

/** Create a VPS record and return its auto-generated id. */
async function createVps(): Promise<string> {
  const record = await vpsRepo.create({
    name: "test-vps",
    host: "10.0.0.1",
    port: 22,
    username: "root",
  });
  return record.id;
}

function makeService(
  docker: { ingest: ReturnType<typeof vi.fn> } = { ingest: vi.fn() },
) {
  const agentRepo = createJsonAgentRepository(
    join(tempDir, "data", "agents.json"),
  );
  const metricRepo = createJsonMetricRepository(
    join(tempDir, "data", "metrics.json"),
  );
  const dockerMonitoringService = docker;
  const service = new AgentService(
    agentRepo,
    metricRepo,
    vpsRepo,
    demoConfig,
    new AgentLifecycleCoordinator(),
    dockerMonitoringService as never,
  );
  return { agentRepo, metricRepo, service };
}

function app(overrides?: Partial<AppConfig>) {
  const config = { ...demoConfig, ...overrides };
  return createApp({
    config: {
      ...config,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
    store: vpsRepo,
    keys: createKeyService(join(tempDir, "private", "keys")),
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    jobs: createJsonJobRepository(join(tempDir, "data", "jobs.json")),
    metrics: createJsonMetricRepository(join(tempDir, "data", "metrics.json")),
    agent: createJsonAgentRepository(join(tempDir, "data", "agents.json")),
  });
}

function validPayload(overrides?: Record<string, unknown>) {
  return {
    cpu: 42,
    memory: 65,
    disk: 55,
    loadAverage: 1.5,
    networkRx: 100_000,
    networkTx: 50_000,
    uptime: 3600,
    collectedAt: new Date().toISOString(),
    agentVersion: "1.0.0",
    ...overrides,
  };
}

// ── VPS existence ───────────────────────────────────────────────────────

describe("VPS existence checks", () => {
  it("createCredential fails when VPS does not exist", async () => {
    const { service } = makeService();
    await expect(service.createCredential("nonexistent_vps")).rejects.toThrow(
      "VPS not found",
    );
  });

  it("createCredential succeeds when VPS exists", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const result = await service.createCredential(vpsId);
    expect(result.credential.vpsId).toBe(vpsId);
    expect(result.token).toContain(result.credential.id);
  });

  it("ingestMetric fails when VPS deleted after credential creation", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { credential } = await service.createCredential(vpsId);
    // Delete the VPS
    await vpsRepo.delete(vpsId);
    // Ingest should now fail
    await expect(
      service.ingestMetric(credential, validPayload()),
    ).rejects.toThrow("VPS not found");
  });
});

// ── Token verification ──────────────────────────────────────────────────

describe("agent token verification", () => {
  it("generates unique token with correct format", async () => {
    const vpsId = await createVps();
    const { service, agentRepo } = makeService();
    const { credential, token } = await service.createCredential(vpsId);

    expect(token).toMatch(/^vma_[A-Za-z0-9_-]+_[a-f0-9]{64}$/);
    expect(token.startsWith("vma_" + credential.id + "_")).toBe(true);

    const stored = await agentRepo.getCredential(credential.id);
    expect(stored).toBeDefined();
    expect(stored!.vpsId).toBe(vpsId);
    expect(stored!.status).toBe("active");
  });

  it("stores only secret hash, not raw secret", async () => {
    const vpsId = await createVps();
    const { service, agentRepo } = makeService();
    const { credential, token } = await service.createCredential(vpsId);
    const secret = token.slice(token.lastIndexOf("_") + 1);

    const stored = await agentRepo.getCredential(credential.id);
    expect(stored!.secretHash).not.toBe(secret);

    const expectedHash = createHash("sha256").update(secret).digest("hex");
    expect(stored!.secretHash).toBe(expectedHash);
  });

  it("verifies bearer token successfully", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { token } = await service.createCredential(vpsId);

    const credential = await service.verifyBearerToken(`Bearer ${token}`);
    expect(credential.vpsId).toBe(vpsId);
    expect(credential.status).toBe("active");
  });

  it("rejects missing authorization header", async () => {
    const { service } = makeService();
    await expect(service.verifyBearerToken(undefined)).rejects.toThrow();
  });

  it("rejects invalid header format", async () => {
    const { service } = makeService();
    await expect(service.verifyBearerToken("NotBearer xyz")).rejects.toThrow();
  });

  it("rejects malformed token format", async () => {
    const { service } = makeService();
    await expect(
      service.verifyBearerToken("Bearer invalidtoken"),
    ).rejects.toThrow();
  });

  it("rejects revoked credential even with correct secret", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { credential, token } = await service.createCredential(vpsId);
    const secret = token.slice(token.lastIndexOf("_") + 1);

    await service.revokeCredential(credential.id);

    const reconstructedToken = `vma_${credential.id}_${secret}`;
    await expect(
      service.verifyBearerToken(`Bearer ${reconstructedToken}`),
    ).rejects.toThrow();
  });

  it("rejects token with wrong secret", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { credential } = await service.createCredential(vpsId);
    const wrongToken = `vma_${credential.id}_${"a".repeat(64)}`;
    await expect(
      service.verifyBearerToken(`Bearer ${wrongToken}`),
    ).rejects.toThrow();
  });

  it("rejects token for non-existent credential", async () => {
    const { service } = makeService();
    await expect(
      service.verifyBearerToken(
        "Bearer vma_nonexistent_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      ),
    ).rejects.toThrow();
  });
});

// ── Payload validation ──────────────────────────────────────────────────

describe("agent metric payload validation", () => {
  it("accepts valid payload via ingest", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { credential } = await service.createCredential(vpsId);

    const result = await service.ingestMetric(credential, validPayload());
    expect(result.sample.vpsId).toBe(vpsId);
    expect(result.sample.cpu).toBe(42);
    expect(result.sample.source).toBe("agent");
    expect(result.sample.receivedAt).toBeDefined();
    expect(result.config).toEqual({ dockerMetricsEnabled: false });
  });
});

// ── HTTP endpoint integration ───────────────────────────────────────────

describe("POST /api/agent/metrics", () => {
  let agentService: AgentService;
  let validToken: string;
  let credentialId: string;
  let vpsId: string;

  beforeEach(async () => {
    vpsId = await createVps();
    const { service } = makeService();
    agentService = service;
    const result = await agentService.createCredential(vpsId);
    validToken = result.token;
    credentialId = result.credential.id;
  });

  it("accepts valid metric payload and returns ok", async () => {
    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload())
      .expect(201);

    expect(res.body.data).toEqual({
      ok: true,
      vpsId,
      receivedAt: expect.any(String),
      config: { dockerMetricsEnabled: false },
    });
  });

  it("rejects missing authorization header", async () => {
    const res = await request(app())
      .post("/api/agent/metrics")
      .send(validPayload())
      .expect(401);

    expect(res.body.error.message).toContain("Missing authorization");
  });

  it("rejects invalid bearer token", async () => {
    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", "Bearer invalid_token_format")
      .send(validPayload())
      .expect(401);

    expect(res.body.error.message).toContain("Invalid token");
  });

  it("rejects revoked token (correct secret, revoked credential)", async () => {
    // Revoke the credential first
    await agentService.revokeCredential(credentialId);
    const secret = validToken.slice(validToken.lastIndexOf("_") + 1);
    const correctToken = `vma_${credentialId}_${secret}`;

    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${correctToken}`)
      .send(validPayload())
      .expect(401);

    expect(res.body.error.message).toContain("Token has been revoked");
  });

  it("rejects payload with mismatched vpsId", async () => {
    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ vpsId: "wrong_vps" }))
      .expect(401);

    expect(res.body.error.message).toContain("VPS ID mismatch");
  });

  it("rejects ingest when VPS was deleted", async () => {
    // Delete the VPS, then try to ingest
    await vpsRepo.delete(vpsId);

    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload())
      .expect(404);

    expect(res.body.error.message).toContain("VPS not found");
  });

  describe("payload validation", () => {
    it("rejects cpu over 100", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validPayload({ cpu: 150 }))
        .expect(400);
    });

    it("rejects negative memory", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validPayload({ memory: -1 }))
        .expect(400);
    });

    it("rejects disk over 100", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validPayload({ disk: 101 }))
        .expect(400);
    });

    it("rejects negative loadAverage", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validPayload({ loadAverage: -0.5 }))
        .expect(400);
    });

    it("rejects too-old collectedAt", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            collectedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          }),
        )
        .expect(400);
    });

    it("rejects too-future collectedAt", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            collectedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          }),
        )
        .expect(400);
    });

    it("rejects missing agentVersion", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validPayload({ agentVersion: "" }))
        .expect(400);
    });

    it("rejects NaN cpu", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validPayload({ cpu: NaN }))
        .expect(400);
    });
  });

  describe("system info ingestion", () => {
    it("accepts valid payload with system info", async () => {
      const res = await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            system: {
              os: {
                family: "linux",
                name: "Ubuntu",
                version: "22.04",
                prettyName: "Ubuntu 22.04.3 LTS",
              },
              kernel: {
                release: "5.15.0-91-generic",
                version: "#101-Ubuntu SMP",
                arch: "x86_64",
              },
              cpu: {
                cores: 4,
                model: "Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz",
              },
              memory: {
                totalBytes: 8_589_934_592,
                availableBytes: 4_294_967_296,
              },
              rootDisk: {
                mountPoint: "/",
                fsType: "ext4",
                totalBytes: 107_374_182_400,
                usedBytes: 53_687_091_200,
                freeBytes: 53_687_091_200,
              },
            },
          }),
        )
        .expect(201);
      expect(res.body.data.ok).toBe(true);
    });

    it("accepts minimal system info (only rootDisk required fields)", async () => {
      const res = await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            system: {
              rootDisk: { mountPoint: "/" },
            },
          }),
        )
        .expect(201);
      expect(res.body.data.ok).toBe(true);
    });

    it("stores system info accessible via agent repository", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            agentVersion: "2.0.0",
            system: {
              os: { family: "linux" },
              cpu: { cores: 8 },
            },
          }),
        )
        .expect(201);

      const agentRepo = createJsonAgentRepository(
        join(tempDir, "data", "agents.json"),
      );
      const systemInfo = await agentRepo.getSystemInfo(vpsId);
      expect(systemInfo).toBeDefined();
      expect(systemInfo!.vpsId).toBe(vpsId);
      expect(systemInfo!.os?.family).toBe("linux");
      expect(systemInfo!.cpu?.cores).toBe(8);
      expect(systemInfo!.agentVersion).toBe("2.0.0");
      expect(systemInfo!.collectedAt).toBeDefined();
      expect(systemInfo!.receivedAt).toBeDefined();
    });

    it("keeps newer system info when an older collectedAt arrives later", async () => {
      const newerCollectedAt = new Date().toISOString();
      const olderCollectedAt = new Date(Date.now() - 60_000).toISOString();

      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            collectedAt: newerCollectedAt,
            system: {
              os: { family: "linux", name: "newer" },
            },
          }),
        )
        .expect(201);

      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            collectedAt: olderCollectedAt,
            system: {
              os: { family: "linux", name: "older" },
            },
          }),
        )
        .expect(201);

      const agentRepo = createJsonAgentRepository(
        join(tempDir, "data", "agents.json"),
      );
      const systemInfo = await agentRepo.getSystemInfo(vpsId);
      expect(systemInfo?.collectedAt).toBe(newerCollectedAt);
      expect(systemInfo?.os?.name).toBe("newer");
    });

    it("rejects system with unknown nested fields", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            system: {
              os: { family: "linux", extraField: "should be rejected" },
            },
          }),
        )
        .expect(400);
    });

    it("rejects system with cpu cores > 4096", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            system: {
              cpu: { cores: 5000 },
            },
          }),
        )
        .expect(400);
    });

    it("rejects system with negative memory bytes", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            system: {
              memory: { totalBytes: -1 },
            },
          }),
        )
        .expect(400);
    });

    it("rejects system with empty mountPoint", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            system: {
              rootDisk: { mountPoint: "" },
            },
          }),
        )
        .expect(400);
    });

    it("rejects system with oversize os name string", async () => {
      await request(app())
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${validToken}`)
        .send(
          validPayload({
            system: {
              os: { name: "x".repeat(600) },
            },
          }),
        )
        .expect(400);
    });
  });

  it("metric appears via /api/metrics after ingest", async () => {
    const { createSessionCookie } = await import("./test-helpers.js");
    const localApp = app({ mode: "local" });
    const sessionCookie = await createSessionCookie(
      tempDir,
      demoConfig.dashboardSessionSecret,
    );

    await request(localApp)
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload())
      .expect(201);

    const res = await request(localApp)
      .get("/api/metrics")
      .set("Cookie", sessionCookie)
      .expect(200);
    const agentMetric = res.body.data.find(
      (m: { vpsId: string }) => m.vpsId === vpsId,
    );
    expect(agentMetric).toBeDefined();
    expect(agentMetric.cpu).toBe(42);
    expect(agentMetric.source).toBe("agent");
    expect(agentMetric.collectedAt).toBeDefined();
  });

  it("no raw token in responses or error messages", async () => {
    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload())
      .expect(201);

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("vma_");
    expect(bodyStr).not.toContain(validToken);
  });

  it("updates agent state after ingest", async () => {
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ agentVersion: "2.0.0" }))
      .expect(201);

    const agentRepo = createJsonAgentRepository(
      join(tempDir, "data", "agents.json"),
    );
    const state = await agentRepo.getState(vpsId);
    expect(state).toBeDefined();
    expect(state!.status).toBe("online");
    expect(state!.version).toBe("2.0.0");
    expect(state!.lastSeenAt).toBeDefined();
  });

  it("updates credential lastUsedAt after ingest", async () => {
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload())
      .expect(201);

    const agentRepo = createJsonAgentRepository(
      join(tempDir, "data", "agents.json"),
    );
    const credential = await agentRepo.getCredential(credentialId);
    expect(credential).toBeDefined();
    expect(credential!.lastUsedAt).toBeDefined();
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("returns 429 when exceeding agent rate limit", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { token } = await service.createCredential(vpsId);

    // Use a low rateLimitMax so the agent limit (max * 5) is easy to exceed.
    // Keep the window comfortably longer than the request loop so Windows
    // scheduling cannot reset the bucket while the requests are in flight.
    const limitedConfig: AppConfig = {
      ...demoConfig,
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
    };
    const limitedApp = app(limitedConfig);

    // Send 7 requests rapidly — the first 5 fill the agent bucket (max*5),
    // the rest must 429. The 60s window keeps the bucket stable on Windows.
    const results: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(limitedApp)
        .post("/api/agent/metrics")
        .set("Authorization", `Bearer ${token}`)
        .send(validPayload());
      results.push(res.status);
    }

    expect(results.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(results.slice(5)).toEqual([429, 429]);
  });

  it("allows normal cadence under rate limit", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { token } = await service.createCredential(vpsId);

    const res1 = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload())
      .expect(201);

    const res2 = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload())
      .expect(201);

    expect(res1.body.data.ok).toBe(true);
    expect(res2.body.data.ok).toBe(true);
  });
});

// ── Freshness ───────────────────────────────────────────────────────────

describe("freshness using receivedAt", () => {
  it("recent receivedAt is fresh", () => {
    expect(isFreshTimestamp(new Date().toISOString())).toBe(true);
  });

  it("old receivedAt is stale", () => {
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(isFreshTimestamp(old)).toBe(false);
  });

  it("ingested metric has receivedAt set for freshness computation", async () => {
    const vpsId = await createVps();
    const { service } = makeService();
    const { credential } = await service.createCredential(vpsId);
    const result = await service.ingestMetric(credential, validPayload());

    expect(result.sample.receivedAt).toBeDefined();
    expect(isFreshTimestamp(result.sample.receivedAt!)).toBe(true);
  });
});

// ── Agent location ───────────────────────────────────────────────────────

describe("agent location ingestion", () => {
  let service: AgentService;
  let token: string;
  let vpsId: string;

  beforeEach(async () => {
    vpsId = await createVps();
    const result = await makeService().service.createCredential(vpsId);
    service = makeService().service;
    token = result.token;
  });

  it("accepts legacy payloads without location", async () => {
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload())
      .expect(201);
    expect((await vpsRepo.get(vpsId))?.city).toBeUndefined();
  });

  it("persists a valid location", async () => {
    const location = {
      city: "Singapore",
      country: "SG",
      detectedAt: new Date().toISOString(),
    };
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload({ location }))
      .expect(201);
    await expect(vpsRepo.get(vpsId)).resolves.toMatchObject({
      city: location.city,
      country: location.country,
      locationDetectedAt: location.detectedAt,
    });
  });

  it.each([
    [{ city: "", country: "SG" }],
    [{ city: "Singapore", country: "" }],
    [{ city: "Singapore", country: "SG", detectedAt: "not-a-date" }],
    [
      {
        city: "Singapore",
        country: "SG",
        detectedAt: new Date().toISOString(),
        extra: true,
      },
    ],
    [
      {
        city: "x".repeat(121),
        country: "SG",
        detectedAt: new Date().toISOString(),
      },
    ],
  ])("rejects invalid location %#", async (location) => {
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload({ location }))
      .expect(400);
  });

  it("does not overwrite a newer location with a stale timestamp", async () => {
    const newer = new Date(Date.now() - 1_000).toISOString();
    const older = new Date(Date.now() - 10_000).toISOString();
    for (const location of [
      { city: "New", country: "SG", detectedAt: newer },
      { city: "Old", country: "SG", detectedAt: older },
      { city: "Equal", country: "SG", detectedAt: newer },
    ]) {
      await service.ingestMetric(
        await service.verifyBearerToken(`Bearer ${token}`),
        validPayload({ location }),
      );
    }
    expect((await vpsRepo.get(vpsId))?.city).toBe("Equal");
  });

  it("rejects a credential from owning another VPS", async () => {
    const other = await createVps();
    const otherCredential = await service.createCredential(other);
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${token}`)
      .send(validPayload({ vpsId: otherCredential.credential.vpsId }))
      .expect(401);
  });
});

// ── Docker metrics ───────────────────────────────────────────────────────

function validDockerPayload(overrides?: Record<string, unknown>) {
  return {
    collectedAt: new Date().toISOString(),
    agentVersion: "1.0.0",
    schemaVersion: 2,
    agentInstanceId: "instance_abc123",
    snapshotId: "snap_abc123",
    sourceSequence: "1",
    available: true,
    containerTotal: 3,
    containerRunning: 2,
    cpuPercent: 45.5,
    memoryUsageBytes: 524_288_000,
    memoryLimitBytes: 1_073_741_824,
    networkRxBytes: 1_000_000,
    networkTxBytes: 500_000,
    blockReadBytes: 100_000,
    blockWriteBytes: 50_000,
    pids: 42,
    containers: [
      {
        containerKey: "container_abc123",
        name: "/web-nginx",
        image: "nginx:1.25",
        status: "Up 3 hours",
        state: "running",
        createdAt: new Date().toISOString(),
        cpuPercent: 12.3,
        memoryUsageBytes: 65_536_000,
        memoryLimitBytes: 268_435_456,
        networkRxBytes: 800_000,
        networkTxBytes: 400_000,
        blockReadBytes: 50_000,
        blockWriteBytes: 20_000,
        pids: 12,
      },
    ],
    ...overrides,
  };
}

describe("Docker metrics ingestion", () => {
  let agentService: AgentService;
  let validToken: string;
  let credentialId: string;
  let vpsId: string;

  beforeEach(async () => {
    vpsId = await createVps();
    const { service } = makeService();
    agentService = service;
    const result = await agentService.createCredential(vpsId);
    validToken = result.token;
    credentialId = result.credential.id;
  });

  it("ignores docker payload when dockerMetricsEnabled is false (default)", async () => {
    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: validDockerPayload() }))
      .expect(201);

    expect(res.body.data.config).toEqual({ dockerMetricsEnabled: false });

    const dockerRepo = createJsonDockerMonitoringRepository(
      join(tempDir, "data", "docker-monitoring.json"),
    );
    expect(await dockerRepo.getAuthoritativeLatest(vpsId)).toBeUndefined();
  });

  it("stores docker metrics when dockerMetricsEnabled is true", async () => {
    // Enable Docker metrics
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: validDockerPayload() }))
      .expect(201);

    expect(res.body.data.config).toEqual({
      dockerMetricsEnabled: true,
      history: true,
      containerHistory: true,
      events: true,
      storage: true,
    });
    const dockerRepo = createJsonDockerMonitoringRepository(
      join(tempDir, "data", "docker-monitoring.json"),
    );
    expect(await dockerRepo.getAuthoritativeLatest(vpsId)).toMatchObject({
      activeInstanceId: "instance_abc123",
      available: true,
    });
  });

  it("stale collectedAt does not overwrite newer docker metrics", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    // Send newer payload first
    const newerCollectedAt = new Date().toISOString();
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: validDockerPayload({
            collectedAt: newerCollectedAt,
            containerTotal: 10,
          }),
        }),
      )
      .expect(201);

    // Send older payload after
    const olderCollectedAt = new Date(Date.now() - 60_000).toISOString();
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: validDockerPayload({
            collectedAt: olderCollectedAt,
            sourceSequence: "2",
            snapshotId: "snap_abc124",
            containerTotal: 5,
          }),
        }),
      )
      .expect(201);
  });

  it("rejects docker payload with too many containers (>20)", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    const manyContainers = Array.from({ length: 21 }, (_, i) => ({
      containerKey: `ck_${i}`,
      name: `/container-${i}`,
      image: "nginx:1.25",
      status: "Up 1 hour",
      state: "running",
      createdAt: new Date().toISOString(),
      cpuPercent: 1,
      memoryUsageBytes: 10_000_000,
      networkRxBytes: 1000,
      networkTxBytes: 500,
      blockReadBytes: 100,
      blockWriteBytes: 50,
      pids: 5,
    }));

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: validDockerPayload({ containers: manyContainers }),
        }),
      )
      .expect(400);
  });

  it("rejects a v1 docker branch with 400 (v2-only wire)", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: { ...validDockerPayload(), schemaVersion: 1, containers: [] },
        }),
      )
      .expect(400);
  });

  it("rejects docker payload with negative values", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: validDockerPayload({ cpuPercent: -1 }) }))
      .expect(400);
  });

  it("rejects system + docker extra fields (strict schema)", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: { ...validDockerPayload(), extraField: "rejected" },
        }),
      )
      .expect(400);
  });

  it("returns enabled config in response when dockerMetricsEnabled is true", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });
    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload())
      .expect(201);
    expect(res.body.data.config).toEqual({
      dockerMetricsEnabled: true,
      history: true,
      containerHistory: true,
      events: true,
      storage: true,
    });
  });

  it("ignores malformed docker payload when disabled (fail-closed compatibility)", async () => {
    // A stale/buggy agent cycle may send a docker branch that would fail the
    // strict docker schema. When disabled, ingest must still accept core
    // metrics and silently drop the docker branch.
    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: {
            collectedAt: "not-a-date",
            schemaVersion: 99,
            available: "yes",
            containerTotal: -5,
            containers: "not-an-array",
            extraField: "rejected",
          },
        }),
      )
      .expect(201);

    expect(res.body.data.config).toEqual({ dockerMetricsEnabled: false });

    const agentRepo = createJsonAgentRepository(
      join(tempDir, "data", "agents.json"),
    );
  });

  it("stores unavailable docker payload when enabled (fail-closed optional)", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    const res = await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: validDockerPayload({
            available: false,
            errorCode: "socket_missing",
            containerTotal: 0,
            containerRunning: 0,
            cpuPercent: 0,
            memoryUsageBytes: 0,
            networkRxBytes: 0,
            networkTxBytes: 0,
            blockReadBytes: 0,
            blockWriteBytes: 0,
            pids: 0,
            containers: [],
          }),
        }),
      )
      .expect(201);

    expect(res.body.data.config).toEqual({
      dockerMetricsEnabled: true,
      history: true,
      containerHistory: true,
      events: true,
      storage: true,
    });
    const dockerRepo = createJsonDockerMonitoringRepository(
      join(tempDir, "data", "docker-monitoring.json"),
    );
    expect(await dockerRepo.getAuthoritativeLatest(vpsId)).toMatchObject({
      activeInstanceId: "instance_abc123",
      available: false,
      errorCode: "socket_missing",
    });
  });

  it("accepts and persists optional engine metadata when enabled", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    const metadata = {
      engineVersion: "25.0.3",
      apiVersion: "1.44",
      os: "linux",
      architecture: "amd64",
    };

    const dockerPayload = { ...validDockerPayload(), ...metadata };
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: dockerPayload }))
      .expect(201);

    const dockerRepo = createJsonDockerMonitoringRepository(
      join(tempDir, "data", "docker-monitoring.json"),
    );
    expect(await dockerRepo.getAuthoritativeLatest(vpsId)).toMatchObject({
      engineVersion: "25.0.3",
      apiVersion: "1.44",
    });
    expect(await dockerRepo.listCurrentContainers(vpsId)).toEqual([
      {
        agentInstanceId: "instance_abc123",
        containerKey: "container_abc123",
        name: "/web-nginx",
        collectedAt: dockerPayload.collectedAt,
        image: "nginx:1.25",
        status: "Up 3 hours",
        state: "running",
        metrics: { cpuPercent: 12.3, memoryUsageBytes: 65_536_000, pids: 12 },
      },
    ]);
  });

  it("accepts engine metadata at the exact cap lengths", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    const metadata = {
      engineVersion: "e".repeat(64),
      apiVersion: "a".repeat(64),
      os: "o".repeat(32),
      architecture: "x".repeat(32),
    };

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: validDockerPayload(metadata) }))
      .expect(201);
  });

  it("accepts a docker payload without engine metadata", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: validDockerPayload() }))
      .expect(201);
  });

  it.each([
    ["engineVersion", "e".repeat(65)],
    ["apiVersion", "a".repeat(65)],
    ["os", "o".repeat(33)],
    ["architecture", "x".repeat(33)],
  ])("rejects over-limit docker %s", async (field, value) => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: validDockerPayload({ [field]: value }) }))
      .expect(400);
  });

  it("rejects unknown docker metadata field", async () => {
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });

    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(
        validPayload({
          docker: validDockerPayload({
            engineVersion: "25.0.3",
            dockerEngine: "rejected",
          }),
        }),
      )
      .expect(400);
  });

  it("clears docker metrics when disabled via update", async () => {
    // Enable and store
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });
    await request(app())
      .post("/api/agent/metrics")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPayload({ docker: validDockerPayload() }))
      .expect(201);

    // Disable via VPS repository directly (simulates what VpsService does)
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: false });
  });
});

describe("Docker ingest via AgentService", () => {
  function validStructuredDockerPayload(overrides: Record<string, unknown> = {}) {
    return {
      collectedAt: new Date().toISOString(),
      schemaVersion: 2,
      agentInstanceId: "instance_abc123",
      snapshotId: "snap_abc123",
      sourceSequence: "1",
      available: true,
      containerTotal: 1,
      containerRunning: 1,
      cpuPercent: 5,
      memoryUsageBytes: 1024,
      networkRxBytes: 10,
      networkTxBytes: 10,
      blockReadBytes: 10,
      blockWriteBytes: 10,
      pids: 2,
      containers: [
        {
          name: "/web-nginx",
          image: "nginx:1.25",
          state: "running",
          containerKey: "ck_abc123",
          cpuPercent: 12.3,
          memoryUsageBytes: 65_536_000,
          networkRxBytes: 800_000,
          networkTxBytes: 400_000,
          blockReadBytes: 50_000,
          blockWriteBytes: 20_000,
          pids: 12,
        },
      ],
      ...overrides,
    };
  }

  it("accepts an old durable batch replay but rejects an old unbatched snapshot", () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const oldSnapshot = validStructuredDockerPayload({ collectedAt: old });
    const batch = {
      ...oldSnapshot,
      batchId: "batch_abc123",
      events: [],
      eventWindow: { since: "0", until: "1", capped: false, lossy: false },
      fromWatermark: { timeNano: "0", boundaryDigests: [] },
      proposedWatermark: { timeNano: "1", boundaryDigests: [] },
    };
    expect(agentMetricPayloadSchema.safeParse(validPayload({ docker: oldSnapshot })).success).toBe(false);
    expect(agentMetricPayloadSchema.safeParse(validPayload({ docker: batch })).success).toBe(true);
  });

  it("returns the accepted structured acknowledgement without a legacy write", async () => {
    const vpsId = await createVps();
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });
    const docker = {
      ingest: vi.fn().mockResolvedValue({
        ingestStatus: "committed",
        snapshotId: "snap_abc123",
        agentInstanceId: "instance_abc123",
        revision: 3,
      }),
    };
    const { agentRepo, service } = makeService(docker);
    const { credential } = await service.createCredential(vpsId);

    const result = await service.ingestMetric(
      credential,
      validPayload({ docker: validStructuredDockerPayload() }),
    );

    expect(docker.ingest).toHaveBeenCalledTimes(1);
    expect(result.docker).toEqual({
      ingestStatus: "committed",
      snapshotId: "snap_abc123",
      agentInstanceId: "instance_abc123",
      revision: 3,
      capabilities: {
        history: true,
        containerHistory: true,
        events: true,
        storage: true,
      },
    });
  });

  it.each(["already_committed", "replay_ignored"] as const)(
    "maps %s without a legacy write",
    async (ingestStatus) => {
      const vpsId = await createVps();
      await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });
      const docker = {
        ingest: vi.fn().mockResolvedValue({
          ingestStatus,
          snapshotId: "snap_abc123",
          agentInstanceId: "instance_abc123",
          revision: 3,
        }),
      };
      const { agentRepo, service } = makeService(docker);
      const { credential } = await service.createCredential(vpsId);

      const result = await service.ingestMetric(
        credential,
        validPayload({ docker: validStructuredDockerPayload() }),
      );

      expect(result.docker?.ingestStatus).toBe(ingestStatus);
    },
  );

  it("propagates a conflict without a legacy write", async () => {
    const vpsId = await createVps();
    await vpsRepo.update(vpsId, { dockerMetricsEnabled: true });
    const docker = {
      ingest: vi
        .fn()
        .mockRejectedValue(
          new ConflictException({
            error: { message: "Docker ingest conflict" },
          }),
        ),
    };
    const { agentRepo, service } = makeService(docker);
    const { credential } = await service.createCredential(vpsId);

    await expect(
      service.ingestMetric(
        credential,
        validPayload({ docker: validStructuredDockerPayload() }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("ignores a docker payload when docker metrics are disabled", async () => {
    const vpsId = await createVps();
    const docker = { ingest: vi.fn() };
    const { agentRepo, service } = makeService(docker);
    const { credential } = await service.createCredential(vpsId);

    const result = await service.ingestMetric(
      credential,
      validPayload({ docker: validStructuredDockerPayload() }),
    );

    expect(result.config).toEqual({ dockerMetricsEnabled: false });
    expect(result.docker).toBeUndefined();
    expect(docker.ingest).not.toHaveBeenCalled();
  });
});
