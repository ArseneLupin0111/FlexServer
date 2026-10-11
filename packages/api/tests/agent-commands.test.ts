import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { MetricRepository } from "../src/persistence/repositories/metric.repository.js";
import type { DockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonJobRepository } from "../src/persistence/repositories/job.repository.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import { createJsonDockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import {
  createJsonDockerMonitoringRepository,
  seedDockerMonitoringForTests,
} from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { AgentService } from "../src/agents/agent.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { DockerManagementService } from "../src/docker/docker-management.service.js";

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

const CONTAINER_KEY = "queuecontainerkey01";

let tempDir: string;
let vpsRepo: VpsRepository;
let agentRepo: AgentRepository;
let metricRepo: MetricRepository;
let mgmtRepo: DockerManagementRepository;
let monitoringRepo: DockerMonitoringRepository;
let mgmtService: DockerManagementService;
let agentService: AgentService;
let vpsId: string;
let token: string;
let credentialId: string;
let keySeq: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-agent-commands-"));
  vpsRepo = createVpsStore(join(tempDir, "data", "vps.json"));
  agentRepo = createJsonAgentRepository(join(tempDir, "data", "agents.json"));
  metricRepo = createJsonMetricRepository(
    join(tempDir, "data", "metrics.json"),
  );
  mgmtRepo = createJsonDockerManagementRepository(
    join(tempDir, "data", "docker-management.json"),
  );
  monitoringRepo = createJsonDockerMonitoringRepository(
    join(tempDir, "data", "docker-monitoring.json"),
  );
  mgmtService = new DockerManagementService(
    vpsRepo,
    mgmtRepo,
    monitoringRepo,
    demoConfig,
  );
  agentService = new AgentService(
    agentRepo,
    metricRepo,
    vpsRepo,
    demoConfig,
    new AgentLifecycleCoordinator(),
    {} as never,
  );
  const record = await vpsRepo.create({
    name: "cmd-vps",
    host: "10.9.8.7",
    port: 22,
    username: "root",
  });
  vpsId = record.id;
  await vpsRepo.update(vpsId, { dockerManagementEnabled: true });
  const cred = await agentService.createCredential(vpsId);
  token = cred.token;
  credentialId = cred.credential.id;
  keySeq = 0;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Capability policy gating (viewer identity discovery) ──────────────────
// capability() projects the latest committed snapshot into (containerKey,
// agentInstanceId) pairs. Management consent gates supported/actions; local
// non-system logs also expose targets without consent. dockerMetricsEnabled gates nothing
// here: identity discovery is not monitoring data.

const CAPABILITY_NOW = "2026-09-15T12:00:00.000Z";
const localConfig: AppConfig = { ...demoConfig, mode: "local" };

async function seedSnapshot(container: Record<string, unknown>) {
  await seedDockerMonitoringForTests(
    join(tempDir, "data", "docker-monitoring.json"),
    {
      samples: [
        {
          id: "cap_h",
          vpsId,
          agentInstanceId: "inst_local",
          snapshotId: "snap_cap",
          collectedAt: CAPABILITY_NOW,
          receivedAt: CAPABILITY_NOW,
          effectiveAt: CAPABILITY_NOW,
          metrics: { cpuPercent: 1, memoryUsageBytes: 64, pids: 2 },
        },
        {
          id: "cap_c",
          vpsId,
          agentInstanceId: "inst_local",
          snapshotId: "snap_cap",
          collectedAt: CAPABILITY_NOW,
          receivedAt: CAPABILITY_NOW,
          effectiveAt: CAPABILITY_NOW,
          metrics: { cpuPercent: 1, memoryUsageBytes: 64, pids: 2 },
          ...container,
        },
      ],
    },
  );
}

describe("DockerManagementService capability gating", () => {
  it("maps committed snapshot rows into viewer targets", async () => {
    await seedSnapshot({
      containerKey: "ck_a",
      name: "web",
      image: "nginx:1.25",
      state: "running",
    });
    const capability = await mgmtService.capability(vpsId);
    expect(capability).toEqual({
      supported: true,
      actions: ["start", "stop", "restart"],
      logsSupported: false,
      reason: "Realtime Docker logs are unavailable in demo mode",
      maxLogLines: 200,
      targets: [
        {
          containerKey: "ck_a",
          name: "web",
          image: "nginx:1.25",
          state: "running",
          agentInstanceId: "inst_local",
        },
      ],
    });
  });

  it("keeps identity discovery and action semantics in demo mode", async () => {
    await seedSnapshot({ containerKey: "ck_demo", name: "web" });
    // Demo mode exposes targets, but logs (agent-backed streaming) do not.
    await expect(mgmtService.capability(vpsId)).resolves.toEqual({
      supported: true,
      actions: ["start", "stop", "restart"],
      logsSupported: false,
      reason: "Realtime Docker logs are unavailable in demo mode",
      maxLogLines: 200,
      targets: [
        { containerKey: "ck_demo", name: "web", agentInstanceId: "inst_local" },
      ],
    });
  });

  it("reports log streaming as supported in local mode", async () => {
    const localService = new DockerManagementService(
      vpsRepo,
      mgmtRepo,
      monitoringRepo,
      localConfig,
    );
    await seedSnapshot({ containerKey: "ck_a", name: "web" });
    const capability = await localService.capability(vpsId);
    expect(capability.logsSupported).toBe(true);
  });

  it.each([
    ["demo", demoConfig],
    ["local", localConfig],
  ] as const)("blocks system-managed hosts with no actions, logs, or targets in %s mode", async (_mode, config) => {
    await vpsRepo.update(vpsId, { managedBy: "system" });
    await seedSnapshot({ containerKey: "ck_a", name: "web" });
    const service = new DockerManagementService(vpsRepo, mgmtRepo, monitoringRepo, config);
    await expect(service.capability(vpsId)).resolves.toEqual({
      supported: false,
      reason: "Docker management is unavailable",
      actions: [],
      logsSupported: false,
      maxLogLines: 200,
      targets: [],
    });
    await expect(service.create(vpsId, {
      action: "start", target: { containerKey: "ck_a" }, idempotencyKey: "system-denied",
    })).rejects.toThrow("Docker management is unavailable");
  });

  it("blocks logs and targets in demo mode when management is disabled", async () => {
    await vpsRepo.update(vpsId, { dockerManagementEnabled: false });
    await seedSnapshot({ containerKey: "ck_a", name: "web" });
    await expect(mgmtService.capability(vpsId)).resolves.toEqual({
      supported: false,
      reason: "Docker management is disabled",
      actions: [],
      logsSupported: false,
      maxLogLines: 200,
      targets: [],
    });
    // Demo mode never provides an agent-backed real source; log policy must stay
    // off even with target discovery available.
  });


  it("exposes logs and targets locally with default management consent off while denying operations", async () => {
    const record = await vpsRepo.create({ name: "default-off", host: "203.0.113.90", port: 22, username: "root" });
    vpsId = record.id;
    expect(record.dockerManagementEnabled).toBe(false);
    await seedSnapshot({ containerKey: "ck_a", name: "web" });
    const service = new DockerManagementService(vpsRepo, mgmtRepo, monitoringRepo, localConfig);
    await expect(service.capability(vpsId)).resolves.toEqual({
      supported: false,
      reason: "Docker management is disabled",
      actions: [],
      logsSupported: true,
      maxLogLines: 200,
      targets: [{ containerKey: "ck_a", name: "web", agentInstanceId: "inst_local" }],
    });
    for (const action of ["start", "stop", "restart"] as const) {
      await expect(service.create(vpsId, {
        action, target: { containerKey: "ck_a" }, idempotencyKey: `disabled-${action}`,
      })).rejects.toThrow("Docker management is disabled");
    }
  });

  it("keeps action and claim semantics unchanged by capability gating", async () => {
    const operation = await queue("start", { containerKey: CONTAINER_KEY });
    expect(operation.status).toBe("queued");
    const res = await claim({ agentInstanceId: "inst_a" }).expect(200);
    expect(res.body.data.command).toMatchObject({
      containerKey: CONTAINER_KEY,
    });
  });
});

function app() {
  return createApp({
    config: {
      ...demoConfig,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
    store: vpsRepo,
    keys: createKeyService(join(tempDir, "private", "keys")),
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    jobs: createJsonJobRepository(join(tempDir, "data", "jobs.json")),
    metrics: metricRepo,
    agent: agentRepo,
    dockerManagement: mgmtRepo,
  });
}

function claim(body: Record<string, unknown>, bearer = token) {
  return request(app())
    .post("/api/agent/commands/claim")
    .set("Authorization", `Bearer ${bearer}`)
    .send(body);
}

function report(body: Record<string, unknown>, bearer = token) {
  return request(app())
    .post("/api/agent/commands/result")
    .set("Authorization", `Bearer ${bearer}`)
    .send(body);
}

async function queue(
  action: "start" | "stop" | "restart" = "start",
  target: { containerKey: string; agentInstanceId?: string } = {
    containerKey: CONTAINER_KEY,
  },
) {
  keySeq += 1;
  return mgmtService.create(vpsId, {
    action,
    target,
    idempotencyKey: `cmdq${keySeq}`,
  });
}

/** Claim one command as inst_a and return the wire payload. */
async function claimFirst() {
  await queue();
  const res = await claim({ agentInstanceId: "inst_a" }).expect(200);
  const command = res.body.data.command as {
    commandId: string;
    agentInstanceId: string;
  };
  expect(command).not.toBeNull();
  return command;
}

function receipt(
  commandId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    commandId,
    agentInstanceId: "inst_a",
    status: "succeeded",
    executed: true,
    exitCode: 0,
    ...overrides,
  };
}

// ── POST /api/agent/commands/claim ──────────────────────────────────────

describe("POST /api/agent/commands/claim", () => {
  it("answers instead of 404ing: null command on an empty queue", async () => {
    const res = await claim({ agentInstanceId: "inst_a" }).expect(200);
    expect(res.body).toEqual({ data: { command: null } });
  });

  it("rejects missing, malformed, and revoked bearer tokens with 401", async () => {
    await request(app())
      .post("/api/agent/commands/claim")
      .send({ agentInstanceId: "inst_a" })
      .expect(401);
    await request(app())
      .post("/api/agent/commands/claim")
      .set("Authorization", "Basic abc")
      .send({ agentInstanceId: "inst_a" })
      .expect(401);
    await claim({ agentInstanceId: "inst_a" }, "Bearer garbage_token").expect(
      401,
    );

    await agentService.revokeCredential(credentialId);
    await claim({ agentInstanceId: "inst_a" }).expect(401);
  });

  it("rejects malformed claim bodies with 400", async () => {
    await claim({}).expect(400);
    await claim({ agentInstanceId: "not safe!" }).expect(400);
    await claim({ agentInstanceId: "a".repeat(33) }).expect(400);
    await claim({ agentInstanceId: "inst_a", extra: true }).expect(400);
  });

  it("returns a bounded, correctly targeted command and marks it claimed", async () => {
    const op = await queue();
    const res = await claim({ agentInstanceId: "inst_a" }).expect(200);
    const cmd = res.body.data.command;
    expect(cmd).toEqual({
      commandId: op.id,
      agentInstanceId: "inst_a",
      vpsId,
      action: "start",
      containerKey: CONTAINER_KEY,
      deadlineNano: expect.stringMatching(/^(0|[1-9][0-9]{0,31})$/),
      timeoutSeconds: expect.any(Number),
    });
    expect(cmd.timeoutSeconds).toBeGreaterThanOrEqual(1);
    expect(cmd.timeoutSeconds).toBeLessThanOrEqual(120);
    const deadlineSeconds = Number(cmd.deadlineNano) / 1e9;
    expect(deadlineSeconds).toBeGreaterThan((Date.now() - 5_000) / 1000);
    expect(deadlineSeconds).toBeLessThan((Date.now() + 180_000) / 1000);

    const stored = await mgmtRepo.get(op.id);
    expect(stored).toMatchObject({
      status: "claimed",
      claimedBy: "inst_a",
    });
    expect(Date.parse(stored!.leaseExpiresAt!)).toBeGreaterThan(
      Date.now() + 100_000,
    );
  });

  it("stays silent with null while management is disabled", async () => {
    const op = await queue();
    await vpsRepo.update(vpsId, { dockerManagementEnabled: false });
    const res = await claim({ agentInstanceId: "inst_a" }).expect(200);
    expect(res.body).toEqual({ data: { command: null } });
    expect((await mgmtRepo.get(op.id))!.status).toBe("queued");
  });

  it("never serves the system-managed local host, even force-enabled", async () => {
    const local = await vpsRepo.ensureLocalHost({
      id: "local-host",
      name: "local-host",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      kind: "local",
      managedBy: "system",
    });
    await vpsRepo.update(local.id, { dockerManagementEnabled: true });
    // service.create() forbids the system host; queue directly at the
    // repository to prove the claim gate itself refuses to expose ops.
    const { operation } = await mgmtRepo.create({
      vpsId: local.id,
      idempotencyKey: "localhost1",
      requestDigest: "digest",
      action: "start",
      target: { containerKey: "localcontainerkey01" },
    });
    const localToken = (await agentService.createCredential(local.id)).token;

    const res = await claim({ agentInstanceId: "inst_a" }, localToken).expect(
      200,
    );
    expect(res.body).toEqual({ data: { command: null } });
    expect((await mgmtRepo.get(operation.id))!.status).toBe("queued");
  });

  it("only serves commands queued for the credential's VPS", async () => {
    await queue();
    const other = await vpsRepo.create({
      name: "other-vps",
      host: "10.0.0.9",
      port: 22,
      username: "root",
    });
    await vpsRepo.update(other.id, { dockerManagementEnabled: true });
    const otherToken = (await agentService.createCredential(other.id)).token;

    const res = await claim({ agentInstanceId: "inst_a" }, otherToken).expect(
      200,
    );
    expect(res.body).toEqual({ data: { command: null } });
  });

  it("hands a pre-targeted command only to its matching instance", async () => {
    await queue("restart", {
      containerKey: CONTAINER_KEY,
      agentInstanceId: "inst_a",
    });
    const miss = await claim({ agentInstanceId: "inst_b" }).expect(200);
    expect(miss.body).toEqual({ data: { command: null } });
    const hit = await claim({ agentInstanceId: "inst_a" }).expect(200);
    expect(hit.body.data.command.commandId).toBeDefined();
  });

  it("never hands the same command to two concurrent claims", async () => {
    await queue();
    const [a, b] = await Promise.all([
      claim({ agentInstanceId: "inst_a" }),
      claim({ agentInstanceId: "inst_b" }),
    ]);
    const commands = [a.body.data.command, b.body.data.command];
    expect(commands.filter(Boolean)).toHaveLength(1);
  });

  it("claims exclusively and reclaims only after the lease expires", async () => {
    const op = await queue();
    const first = await mgmtRepo.claimNextQueued(vpsId, "inst_a");
    expect(first?.id).toBe(op.id);
    // Another instance cannot take the live lease…
    expect(await mgmtRepo.claimNextQueued(vpsId, "inst_b")).toBeUndefined();
    // …but can once it expires.
    const future = new Date(Date.now() + 121_000).toISOString();
    const second = await mgmtRepo.claimNextQueued(vpsId, "inst_b", future);
    expect(second?.id).toBe(op.id);
    expect(second?.claimedBy).toBe("inst_b");
  });
});

// ── POST /api/agent/commands/result ─────────────────────────────────────

describe("POST /api/agent/commands/result", () => {
  it("echoes the receipt, stores the outcome, and drops it from the queue", async () => {
    const cmd = await claimFirst();
    const res = await report(receipt(cmd.commandId)).expect(200);
    expect(res.body).toEqual({
      data: {
        ok: true,
        commandId: cmd.commandId,
        agentInstanceId: "inst_a",
      },
    });
    expect(await mgmtRepo.get(cmd.commandId)).toMatchObject({
      status: "succeeded",
      result: { ok: true, exitCode: 0 },
    });
    // Terminal: the queue no longer offers it.
    const again = await claim({ agentInstanceId: "inst_a" }).expect(200);
    expect(again.body).toEqual({ data: { command: null } });
  });

  it("treats an identical replay as an idempotent success", async () => {
    const cmd = await claimFirst();
    const body = receipt(cmd.commandId, {
      status: "failed",
      exitCode: 1,
      errorCode: "action_failed",
      outputPreview: "boom",
    });
    const first = await report(body).expect(200);
    const stored1 = await mgmtRepo.get(cmd.commandId);
    const second = await report(body).expect(200);
    expect(second.body).toEqual(first.body);
    expect(second.body).toEqual({
      data: {
        ok: true,
        commandId: cmd.commandId,
        agentInstanceId: "inst_a",
      },
    });
    expect(stored1).toMatchObject({
      status: "failed",
      result: { ok: false, exitCode: 1, message: "action_failed" },
    });
    expect(await mgmtRepo.get(cmd.commandId)).toEqual(stored1);
  });

  it("conflicts on a divergent second result without rewriting", async () => {
    const cmd = await claimFirst();
    await report(receipt(cmd.commandId)).expect(200);
    await report(
      receipt(cmd.commandId, { status: "failed", exitCode: 2 }),
    ).expect(409);
    expect((await mgmtRepo.get(cmd.commandId))!.status).toBe("succeeded");
  });

  it("conflicts when reporting before claiming", async () => {
    const op = await queue();
    await report(receipt(op.id)).expect(409);
    expect((await mgmtRepo.get(op.id))!.status).toBe("queued");
  });

  it("rejects a receipt from an instance that does not hold the claim", async () => {
    const cmd = await claimFirst();
    await report(
      receipt(cmd.commandId, { agentInstanceId: "inst_b" }),
    ).expect(401);
    expect((await mgmtRepo.get(cmd.commandId))!.status).toBe("claimed");
  });

  it("404s unknown or foreign-VPS command ids", async () => {
    await report(receipt("no_such_command")).expect(404);

    const cmd = await claimFirst();
    const other = await vpsRepo.create({
      name: "other-vps",
      host: "10.0.0.9",
      port: 22,
      username: "root",
    });
    const otherToken = (await agentService.createCredential(other.id)).token;
    await report(receipt(cmd.commandId), otherToken).expect(404);
    expect((await mgmtRepo.get(cmd.commandId))!.status).toBe("claimed");
  });

  it("records uncertain outcomes as failed with the agent error code", async () => {
    const cmd = await claimFirst();
    await report(
      receipt(cmd.commandId, {
        status: "uncertain",
        errorCode: "uncertain_outcome",
        outputPreview: "?",
      }),
    ).expect(200);
    expect(await mgmtRepo.get(cmd.commandId)).toMatchObject({
      status: "failed",
      result: { ok: false, message: "uncertain_outcome" },
    });
  });

  it("rejects invalid result bodies with 400", async () => {
    const cmd = await claimFirst();
    await report(
      receipt(cmd.commandId, { errorCode: "not_a_real_code" }),
    ).expect(400);
    await report(
      receipt(cmd.commandId, { status: "uncertain", executed: false }),
    ).expect(400);
    await report(receipt(cmd.commandId, { exitCode: 300 })).expect(400);
    await report(
      receipt(cmd.commandId, { outputPreview: "x".repeat(9_000) }),
    ).expect(400);
    // Nothing committed by the rejected attempts.
    expect((await mgmtRepo.get(cmd.commandId))!.status).toBe("claimed");
  });
});
