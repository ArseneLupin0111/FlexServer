import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { saveKeyringToFile } from "../src/ssh/key-encryption.js";
import type { ApplicationsRepository } from "../src/persistence/repositories/applications.repository.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictException } from "@nestjs/common";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import { createJsonApplicationsRepository } from "../src/persistence/repositories/applications.repository.js";
import { createJsonApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { ApplicationsService } from "../src/docker-applications/applications.service.js";
import type { StoredApplicationsInventory } from "../src/docker-applications/inventory.schemas.js";

const testKeyring = { version: 1 as const, activeKekId: "test", keys: { test: { key: randomBytes(32).toString("base64") } } };
const configFor = (keyringFile: string): AppConfig => ({
  mode: "local", enableWebTerminal: false, allowPrivateNetworkTargets: false,
  dataDir: "data", privateDir: "private", rateLimitWindowMs: 60_000, rateLimitMax: 120,
  agentInstallIntervalSeconds: 1, allowInsecureAgentHttp: false, dbSsl: false, dbPoolMax: 10,
  dashboardSessionTtlSeconds: 86_400, dashboardCookieSecure: false, dashboardCookieSameSite: "lax",
  dashboardSessionSecret: "applications-test-secret", trustProxyHops: 0, jobHistoryLimit: 1000,
  auditHistoryLimit: 5000, metricWindowLimit: 120, dockerRetentionDays: 7,
  dockerMaintenanceSamplesPerVps: 5000, dockerMaintenanceEventsPerVps: 10000,
  dockerMaintenanceIntervalSeconds: 21600, dockerJsonMaxBytes: 32 * 1024 * 1024,
  dockerJsonMaintenanceMaxRewriteBytes: 8 * 1024 * 1024, sshHostKeyPins: {}, sshHostKeyPolicy: "strict",
  composeCrypto: { keyringFile },
});

const vpsId = "test-vps";
const instanceId = "cccccccccccccccccccccccccccccccc";
const containerKey = "composebehavioralkey001";
const now = new Date().toISOString();
const vpsRecord = {
  id: vpsId, name: "test", host: "203.0.113.10", port: 22, username: "root",
  composeManagementEnabled: true, agentStatus: "online", lastSeenAt: now,
} as VpsRecord;
const vps = {
  get: async (id: string) => id === vpsId ? vpsRecord : undefined,
} as VpsRepository;
const agents = {
  getState: async (id: string) => id === vpsId ? { status: "online", lastSeenAt: now } : undefined,
} as AgentRepository;

function inventory(): StoredApplicationsInventory {
  return {
    vpsId, receivedAt: now, protocolVersion: "applications-v1", agentInstanceId: instanceId,
    daemonEpoch: 1, inventorySequence: 1, collectedAt: now, completeness: true,
    completionReason: "", containerTotal: 1, projectTotal: 1, replicaTotal: 1,
    projects: [{ project: "external", replicaTotal: 1, services: [{
      service: "web", occupiedSlots: [], maxSlot: 1,
      replicas: [{ containerKey, slot: 1, state: "running", status: "Up", createdAt: now }],
      health: "healthy", isOneoff: false, configHash: "cfg",
    }] }],
    capability: {
      protocolVersion: "applications-v1", os: "linux", arch: "amd64", agentVersion: "test",
      dockerAvailable: true, composeMode: "plugin", installState: "plugin", managementGate: false,
      features: [], reasons: [],
    },
  };
}

describe("ApplicationsService with JSON repository", () => {
  let dir: string | undefined;
  let service: ApplicationsService | undefined;
  let repo: ApplicationsRepository | undefined;
  afterEach(async () => {
    await repo?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    repo = undefined;
    service = undefined;
    dir = undefined;
  });
  
  async function setup() {
    dir = await mkdtemp(join(tmpdir(), "applications-repository-"));
    const keyringFile = join(dir, "compose-keyring.json");
    await saveKeyringToFile(keyringFile, testKeyring);
    const config = configFor(keyringFile);
    repo = createJsonApplicationsRepository(dir);
    const inventories = createJsonApplicationsInventoryRepository(join(dir, "inventory.json"));
    await inventories.save(inventory());
    const applicationService = new ApplicationsService(config, vps, agents, repo, inventories);
    service = applicationService;
    const app = await applicationService.create(vpsId, {
      confirmation: { confirmed: true }, idempotencyKey: "create-app-key",
      displayName: "Managed app",
    });
    return { app, service: applicationService, repo };
  }

  it("admits one operation and replays an identical idempotency request", async () => {
    const { app, service, repo } = await setup();
    const request = { confirmation: { confirmed: true }, idempotencyKey: "operation-key-1" };
    const first = await service.work(vpsId, app.id, "deploy", request);
    const replay = await service.work(vpsId, app.id, "deploy", request);
    expect(replay).toEqual(first);
    expect((await repo.transaction(state => state.operations)).map(operation => operation.id)).toEqual([first.id]);
  });

  it("claims source verification before any managed revision exists", async () => {
    const { app, service } = await setup();
    const operation = await service.source(vpsId, app.id, {
      confirmation: { confirmed: true }, idempotencyKey: "source-first-claim", sourcePath: "/srv/compose.yml",
    });
    const claimed = await service.claim(vpsId, instanceId);
    expect(claimed).toMatchObject({ operationId: operation.operationId, kind: "verify_source", sourcePath: "/srv/compose.yml" });
  });

  it("resolves a managed preview with omitted optional variables", async () => {
    const { app, service } = await setup();
    const preview = await service.preview(vpsId, app.id, {
      confirmation: { confirmed: true }, idempotencyKey: "preview-no-variables", composeYaml: "services:\n  web:\n    image: nginx:alpine\n",
    });
    const claimed = await service.claim(vpsId, instanceId);
    expect(claimed).toMatchObject({ operationId: preview.operationId, kind: "preview_prepare", revision: { variables: {}, composeYaml: "services:\n  web:\n    image: nginx:alpine\n" } });
  });

  it("rejects another operation while an operation is active", async () => {
    const { app, service } = await setup();
    await service.work(vpsId, app.id, "deploy", { confirmation: { confirmed: true }, idempotencyKey: "operation-key-2" });
    await expect(service.work(vpsId, app.id, "deploy", { confirmation: { confirmed: true }, idempotencyKey: "another-key-2" }))
      .rejects.toThrow(ConflictException);
    await expect(service.work(vpsId, app.id, "deploy", { confirmation: { confirmed: true }, idempotencyKey: "invalid-key-3", extra: true }))
      .rejects.toThrow();
  });
  it("serializes concurrent source admission and rejects changed idempotency payloads", async () => {
    const { app, service, repo } = await setup();
    const request = { confirmation: { confirmed: true }, idempotencyKey: "source-race-key", sourcePath: "/srv/compose.yml" };
    const [first, replay] = await Promise.all([
      service.source(vpsId, app.id, request),
      service.source(vpsId, app.id, request),
    ]);
    expect(replay).toEqual(first);
    await expect(service.source(vpsId, app.id, { ...request, sourcePath: "/srv/other.yml" }))
      .rejects.toThrow(ConflictException);
    expect(await repo.transaction(state => state.operations.filter(operation => operation.idempotencyKey === request.idempotencyKey)))
      .toHaveLength(1);
  });

  it("cancels an unclaimed operation without permitting a second active operation", async () => {
    const { app, service, repo } = await setup();
    const operation = await service.work(vpsId, app.id, "deploy", {
      confirmation: { confirmed: true }, idempotencyKey: "cancel-operation-key",
    });
    const cancelled = await service.cancel(vpsId, app.id, operation.id, { confirmation: { confirmed: true }, idempotencyKey: "cancel-confirm-key" });
    expect(cancelled.status).toBe("cancelled");
    const next = await service.work(vpsId, app.id, "deploy", {
      confirmation: { confirmed: true }, idempotencyKey: "next-operation-key",
    });
    expect(next.id).not.toBe(operation.id);
    expect(await repo.transaction(state => state.operations.map(row => row.status))).toEqual(["cancelled", "prepared"]);
  });


  it("persists registry credential identities without PostgreSQL JSONB-invalid NUL characters", async () => {
    const { repo } = await setup();
    const keyringFile = join(dir!, "keyring.json");
    await mkdir(dir!, { recursive: true });
    await saveKeyringToFile(keyringFile, testKeyring);
    const credentialService = new ApplicationsService(configFor(keyringFile), vps, agents, repo!, createJsonApplicationsInventoryRepository(join(dir!, "inventory.json")));
    const confirmation = { confirmation: { confirmed: true }, idempotencyKey: "registry-credential" };
    const created = await credentialService.setCredential(vpsId, { ...confirmation, host: "registry.example", username: "build", password: "secret" });
    expect(created).toMatchObject({ host: "registry.example", username: "build" });
    const updated = await credentialService.setCredential(vpsId, { confirmation: { confirmed: true }, idempotencyKey: "registry-credential-update", credentialId: created.id, host: "registry.example", username: "build", password: "updated-secret" });
    const second = await credentialService.setCredential(vpsId, { confirmation: { confirmed: true }, idempotencyKey: "registry-credential-second", host: "other.example", username: "builder", password: "second-secret" });
    expect(updated.id).toBe(created.id);
    expect(second.id).not.toBe(created.id);
    expect(await credentialService.credentials(vpsId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, host: "registry.example", username: "build", version: 2 }),
      expect.objectContaining({ id: second.id, host: "other.example", username: "builder", version: 1 }),
    ]));
  });
  it("enforces durable container contention reservations and permits exact replay", async () => {
    const { service, repo } = await setup();
    const target = { agentInstanceId: instanceId, containerKey };
    await service.reserveContainer(vpsId, target, "legacy-operation-1");
    await service.reserveContainer(vpsId, target, "legacy-operation-1");
    await expect(service.reserveContainer(vpsId, target, "legacy-operation-2"))
      .rejects.toThrow(ConflictException);
    await expect(service.reserveContainer(vpsId, { ...target, containerKey: "anothercontainerkey01" }, "legacy-operation-1"))
      .rejects.toThrow(ConflictException);
    expect(await repo.transaction(state => state.containerContentions)).toHaveLength(1);
    await service.releaseContainer(vpsId, "legacy-operation-1");
    await expect(service.reserveContainer(vpsId, target, "legacy-operation-2")).resolves.toBeUndefined();
  });
});
