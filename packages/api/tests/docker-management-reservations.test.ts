import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import type { DockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import type { ApplicationsRepository, ContainerContention } from "../src/persistence/repositories/applications.repository.js";
import type { ApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AgentCommandReport } from "../src/docker/docker-management.schemas.js";
import { createJsonDockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import { createJsonApplicationsRepository } from "../src/persistence/repositories/applications.repository.js";
import { createJsonApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.repository.js";
import { createJsonDockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { ApplicationsService } from "../src/docker-applications/applications.service.js";
import { DockerManagementService } from "../src/docker/docker-management.service.js";

const config: AppConfig = {
  mode: "local",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: false,
  dataDir: "data",
  privateDir: "private",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
  agentInstallIntervalSeconds: 1,
  allowInsecureAgentHttp: false,
  dbSsl: false,
  dbPoolMax: 10,
  dashboardSessionTtlSeconds: 86_400,
  dashboardCookieSecure: false,
  dashboardCookieSameSite: "lax",
  dashboardSessionSecret: "reservation-test-secret",
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
  composeCrypto: { keyringFile: "reservation-test-unused-keyring.json" },
};

const containerKey = "reservationcontainer01";
const agentInstanceId = "inst_reservations01";
const wrongInstanceId = "inst_reservations02";

type FenceCall = {
  containerKey: string;
  agentInstanceId: string;
  operationId: string;
};

type FencePhase = "pass" | "refuse-reserve" | "fail-release";

/** Records the service boundary while applying successful calls to real JSON state. */
class RecordingFence extends ApplicationsService {
  private constructor(
    config: AppConfig,
    vps: VpsRepository,
    repo: ApplicationsRepository,
    inventories: ApplicationsInventoryRepository,
  ) {
    super(config, vps, createJsonAgentRepository(join(tempDir, "data", "agents.json")), repo, inventories);
  }

  static create(
    config: AppConfig,
    vps: VpsRepository,
    repo: ApplicationsRepository,
    inventories: ApplicationsInventoryRepository,
  ): RecordingFence {
    return new RecordingFence(config, vps, repo, inventories);
  }

  phase: FencePhase = "pass";
  readonly calls: FenceCall[] = [];
  refusedCall: FenceCall | undefined;

  override async reserveContainer(
    vpsId: string,
    target: { containerKey: string; agentInstanceId: string },
    operationId: string,
  ): Promise<void> {
    const call: FenceCall = { ...target, operationId };
    this.calls.push(call);
    if (this.phase === "refuse-reserve") {
      this.phase = "pass";
      this.refusedCall = call;
      throw new Error("container_busy");
    }
    await super.reserveContainer(vpsId, target, operationId);
  }

  override async releaseContainer(vpsId: string, operationId: string): Promise<void> {
    if (this.phase === "fail-release") {
      this.phase = "pass";
      throw new Error("simulated release failure");
    }
    await super.releaseContainer(vpsId, operationId);
  }
}

let tempDir: string;
let vpsId: string;
let vpsRepo: VpsRepository;
let mgmtRepo: DockerManagementRepository;
let appsRepo: ApplicationsRepository;
let fence: RecordingFence;
let service: DockerManagementService;

function operationIdFor(key: string): string {
  return createHash("sha256").update(JSON.stringify([vpsId, key])).digest("base64url").slice(0, 21);
}

function createRequest(key: string, action: "start" | "stop" | "restart" = "start", targetKey = containerKey) {
  return {
    action,
    target: { containerKey: targetKey, agentInstanceId },
    idempotencyKey: key,
  } as const;
}

async function contentions(): Promise<ContainerContention[]> {
  return appsRepo.transaction((state) => [...state.containerContentions]);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "docker-management-reservations-"));
  const dataDir = join(tempDir, "data");
  vpsRepo = createVpsStore(join(dataDir, "vps.json"));
  mgmtRepo = createJsonDockerManagementRepository(join(dataDir, "docker-management.json"));
  appsRepo = createJsonApplicationsRepository(dataDir);
  const inventories = createJsonApplicationsInventoryRepository(join(dataDir, "applications-inventory.json"));
  const monitoring = createJsonDockerMonitoringRepository(join(dataDir, "docker-monitoring.json"));

  const vps = await vpsRepo.create({ name: "reservation-vps", host: "10.77.0.1", port: 22, username: "root" });
  vpsId = vps.id;
  await vpsRepo.update(vpsId, { dockerManagementEnabled: true, composeManagementEnabled: true });

  fence = RecordingFence.create(config, vpsRepo, appsRepo, inventories);
  service = new DockerManagementService(vpsRepo, mgmtRepo, monitoring, config, fence);
});

afterEach(async () => {
  await appsRepo.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DockerManagementService shared reservations", () => {
  it("refuses create before writing any executable operation or claimable row", async () => {
    fence.phase = "refuse-reserve";
    await expect(service.create(vpsId, createRequest("refused-key"))).rejects.toThrow("container_busy");

    const operationId = operationIdFor("refused-key");
    expect(fence.refusedCall).toEqual({ containerKey, agentInstanceId, operationId });
    expect(await mgmtRepo.findByIdempotencyKey(vpsId, "refused-key")).toBeUndefined();
    expect(await mgmtRepo.listUnresolved(vpsId)).toEqual([]);
    expect(await mgmtRepo.peekNextClaimable(vpsId, agentInstanceId)).toBeUndefined();
    expect(await contentions()).toEqual([]);
  });

  it("releases persisted terminal result on identical resultForAgent replay after release failure", async () => {
    const op = await service.create(vpsId, createRequest("release-replay"));
    const claimed = await service.claimForAgent(vpsId, agentInstanceId);
    expect(claimed?.commandId).toBe(op.id);
    expect((await mgmtRepo.get(op.id))?.status).toBe("claimed");

    const report: AgentCommandReport = {
      commandId: op.id,
      agentInstanceId,
      status: "succeeded",
      executed: true,
    };
    fence.phase = "fail-release";
    await expect(service.resultForAgent(vpsId, report)).rejects.toThrow("simulated release failure");

    const terminal = await mgmtRepo.get(op.id);
    expect(terminal?.status).toBe("succeeded");
    expect(terminal?.result?.ok).toBe(true);
    expect((await contentions()).filter((row) => row.operationId === op.id)).toHaveLength(1);

    const replay = await service.resultForAgent(vpsId, report);
    expect(replay).toEqual({ ok: true, commandId: op.id, agentInstanceId });
    const afterReplay = await mgmtRepo.get(op.id);
    expect(afterReplay?.status).toBe("succeeded");
    expect(afterReplay?.result).toEqual(terminal?.result);
    expect((await contentions()).filter((row) => row.operationId === op.id)).toHaveLength(0);
    expect(await mgmtRepo.peekNextClaimable(vpsId, agentInstanceId)).toBeUndefined();
  });

  it("concurrent same-key creates use one stable operation reservation id", async () => {
    const key = "same-key-race";
    const [first, second] = await Promise.all([
      service.create(vpsId, createRequest(key)),
      service.create(vpsId, createRequest(key)),
    ]);
    const stableId = operationIdFor(key);
    expect(first.id).toBe(stableId);
    expect(second.id).toBe(stableId);

    const rows = (await contentions()).filter((row) => row.operationId === stableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ containerKey, agentInstanceId, operationId: stableId });
    expect(fence.calls.filter((call) => call.operationId === stableId)).toHaveLength(2);
    expect(await mgmtRepo.listUnresolved(vpsId)).toHaveLength(1);
  });

  it("rejects conflicting same-key request before reserving its alternate target", async () => {
    const key = "conflicting-key";
    const original = await service.create(vpsId, createRequest(key));
    fence.calls.length = 0;

    await expect(service.create(vpsId, createRequest(key, "stop", "alternate-container-key"))).rejects.toThrow();

    expect(fence.calls).toEqual([]);
    const rows = await contentions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      containerKey,
      agentInstanceId,
      operationId: original.id,
    });
    expect(await mgmtRepo.findByIdempotencyKey(vpsId, key)).toMatchObject({
      id: original.id,
      action: "start",
      target: { containerKey, agentInstanceId },
    });
    expect(await mgmtRepo.listUnresolved(vpsId)).toHaveLength(1);
  });

  it("terminal, wrong-instance, and unexpired direct claims do not create reservations", async () => {
    const terminal = await service.create(vpsId, createRequest("terminal-claim"));
    const terminalClaim = await service.claimForAgent(vpsId, agentInstanceId);
    expect(terminalClaim?.commandId).toBe(terminal.id);
    await service.resultForAgent(vpsId, {
      commandId: terminal.id,
      agentInstanceId,
      status: "succeeded",
      executed: true,
    });

    const live = await service.create(vpsId, createRequest("live-claim", "stop", "other-container-key"));
    const liveClaim = await service.claimForAgent(vpsId, agentInstanceId);
    expect(liveClaim?.commandId).toBe(live.id);
    const activeContentions = await contentions();

    fence.calls.length = 0;
    await expect(service.claim(vpsId, terminal.id, agentInstanceId)).rejects.toThrow(/not_claimable/);
    await expect(service.claim(vpsId, live.id, agentInstanceId)).rejects.toThrow(/not_claimable/);
    await expect(service.claim(vpsId, live.id, wrongInstanceId)).rejects.toThrow(/not_claimable/);

    expect(fence.calls).toEqual([]);
    expect((await mgmtRepo.get(terminal.id))?.status).toBe("succeeded");
    expect((await mgmtRepo.get(live.id))?.status).toBe("claimed");
    expect(await contentions()).toEqual(activeContentions);
  });
});
