import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { saveKeyringToFile } from "../src/ssh/key-encryption.js";
import type { ApplicationsRepository } from "../src/persistence/repositories/applications.repository.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import { createJsonApplicationsRepository } from "../src/persistence/repositories/applications.repository.js";
import { createJsonApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import {
  ApplicationsService,
  computeProjectRuntimeFingerprint,
} from "../src/docker-applications/applications.service.js";
import type { StoredApplicationsInventory } from "../src/docker-applications/inventory.schemas.js";
import { AgentApplicationsController } from "../src/docker-applications/agent.controller.js";
import { AgentService } from "../src/agents/agent.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonMetricRepository } from "../src/persistence/repositories/metric.repository.js";
import type { Request } from "express";

const testKeyring = {
  version: 1 as const,
  activeKekId: "test",
  keys: { test: { key: randomBytes(32).toString("base64") } },
};

const configFor = (keyringFile: string): AppConfig => ({
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
  dashboardSessionSecret: "applications-test-secret",
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
  composeCrypto: { keyringFile },
  compose: {
    claimLeaseSeconds: 120,
    inventoryMaxBytes: 524_288,
    previewTtlSeconds: 300,
  },
});

const vpsId = "test-vps-phase2";
const instanceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const containerKey1 = "containerkey0001";
const containerKey2 = "containerkey0002";
const nowIso = new Date().toISOString();

const vpsRecord = {
  id: vpsId,
  name: "test-node",
  host: "203.0.113.20",
  port: 22,
  username: "root",
  composeManagementEnabled: true,
  agentStatus: "online",
  lastSeenAt: nowIso,
} as VpsRecord;

const vps = {
  get: async (id: string) => (id === vpsId ? vpsRecord : undefined),
} as VpsRepository;

const agents = {
  getState: async (id: string) =>
    id === vpsId ? { status: "online", lastSeenAt: nowIso } : undefined,
} as AgentRepository;
const opaqueKey = (n: number): string => `c${String(n).padStart(31, "0")}`;

type ReplicaSeed = { state: string; status: string; health?: string };
type ServiceSeed = { service: string; replicas: ReplicaSeed[] };
type ProjectSeed = { project: string; services: ServiceSeed[] };

/** Deterministic container keys per (project, service) so replica→key mapping is recoverable across saves. */
function keysFor(seeds: ProjectSeed[]): Record<string, string[]> {
  const keys: Record<string, string[]> = {};
  let seq = 0;
  for (const seed of seeds) {
    for (const svc of seed.services) {
      seq += 1;
      keys[`${seed.project}\u0000${svc.service}`] =
        svc.replicas.map((_, i) => opaqueKey(seq * 100 + i));
    }
  }
  return keys;
}

/** Parametrized current-replication inventory: fresh, complete, same instance/epoch. */
function makeInventory(projectSeeds: ProjectSeed[]): StoredApplicationsInventory {
  let replicaTotal = 0;
  for (const seed of projectSeeds) {
    for (const svc of seed.services) replicaTotal += svc.replicas.length;
  }
  const keys = keysFor(projectSeeds);
  return {
    vpsId,
    receivedAt: nowIso,
    protocolVersion: "applications-v1",
    agentInstanceId: instanceId,
    daemonEpoch: 1,
    inventorySequence: 5000,
    collectedAt: new Date(Date.parse(nowIso) + 1).toISOString(),
    completeness: true,
    completionReason: "",
    containerTotal: replicaTotal,
    projectTotal: projectSeeds.length,
    replicaTotal,
    projects: projectSeeds.map(seed => ({
      project: seed.project,
      replicaTotal: seed.services.reduce((acc, svc) => acc + svc.replicas.length, 0),
      services: seed.services.map(svc => ({
        service: svc.service,
        occupiedSlots: [],
        maxSlot: 1000,
        replicas: svc.replicas.map((r, i) => ({
          containerKey: keys[`${seed.project}\u0000${svc.service}`][i],
          slot: i + 1,
          state: r.state,
          status: r.status,
          health: r.health ?? "healthy",
          createdAt: nowIso,
        })),
        health: "healthy",
        isOneoff: false,
        configHash: `cfg-${svc.service}`,
      })),
    })),
    capability: {
      protocolVersion: "applications-v1",
      os: "linux",
      arch: "amd64",
      agentVersion: "test",
      dockerAvailable: true,
      composeMode: "plugin",
      installState: "plugin",
      managementGate: false,
      features: [],
      reasons: [],
    },
  };
}

/**
 * Registers an app bound to the persisted project, verifies its source with the
 * agent-reported dependency graph, and opts it into stack control so lifecycle
 * operations become admissible. Returns the appId.
 */
async function registerExternalControlled(
  svc: ApplicationsService,
  opts: {
    prefix: string;
    sourcePath?: string;
    sourceServices?: { name: string; kind?: string; dependsOn?: string[]; healthcheck?: boolean }[];
  },
): Promise<string> {
  const sourcePath = opts.sourcePath ?? "/srv/persisted-app/compose.yml";
  const sourceServices = opts.sourceServices ?? [{ name: "web", dependsOn: [] }];
  const dependenciesGraph = opts.dependenciesGraph ?? [{ service: "web", dependsOn: [] }];
  const registered = (await svc.list(vpsId)).items.find(app => app.projectName === "persisted-app");
  if (!registered) throw new Error("registered fixture application missing");
  const registeredApp = { id: registered.appId };

  const sourceOp = await svc.source(vpsId, registeredApp.id, {
    confirmation: { confirmed: true },
    idempotencyKey: `source-${opts.prefix}`,
    sourcePath,
  });
  const sourceClaim = await svc.claim(vpsId, instanceId);
  expect(sourceClaim?.operationId).toBe(sourceOp.operationId);
  expect(sourceClaim!.kind).toBe("verify_source");
  await svc.report(vpsId, instanceId, sourceOp.operationId, {
    claimToken: sourceClaim!.claimToken,
    status: "succeeded",
    executed: false,
    observed: [{
      path: sourcePath,
      verified: true,
      digest: "b".repeat(64),
      project: "persisted-app",
      services: sourceServices.map(s => ({ name: s.name, kind: s.kind ?? "longlived", dependsOn: s.dependsOn ?? [], healthcheck: s.healthcheck === true })),
      dependenciesGraph,
    }],
  });

  await svc.optInExternal(vpsId, registeredApp.id, {
    confirmation: { confirmed: true },
    idempotencyKey: `optin-${opts.prefix}`,
  });
  return registeredApp.id;
}


function sampleInventory(): StoredApplicationsInventory {
  return {
    vpsId,
    receivedAt: nowIso,
    protocolVersion: "applications-v1",
    agentInstanceId: instanceId,
    daemonEpoch: 1,
    inventorySequence: 1,
    collectedAt: nowIso,
    completeness: true,
    completionReason: "",
    containerTotal: 2,
    projectTotal: 2,
    replicaTotal: 2,
    projects: [
      {
        project: "persisted-app",
        replicaTotal: 1,
        services: [
          {
            service: "web",
            occupiedSlots: [],
            maxSlot: 1,
            replicas: [
              {
                containerKey: containerKey1,
                slot: 1,
                state: "running",
                status: "Up 2 hours",
                createdAt: nowIso,
              },
            ],
            health: "healthy",
            isOneoff: false,
            configHash: "cfg1",
          },
        ],
      },
      {
        project: "detected-external",
        replicaTotal: 1,
        services: [
          {
            service: "api",
            occupiedSlots: [],
            maxSlot: 1,
            replicas: [
              {
                containerKey: containerKey2,
                slot: 1,
                state: "running",
                status: "Up 1 hour",
                createdAt: nowIso,
              },
            ],
            health: "healthy",
            isOneoff: false,
            configHash: "cfg2",
          },
        ],
      },
    ],
    capability: {
      protocolVersion: "applications-v1",
      os: "linux",
      arch: "amd64",
      agentVersion: "test",
      dockerAvailable: true,
      composeMode: "plugin",
      installState: "plugin",
      managementGate: false,
      features: [],
      reasons: [],
    },
  };
}

describe("Applications phase 2 API regressions", () => {
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
    dir = await mkdtemp(join(tmpdir(), "applications-phase2-test-"));
    const keyringFile = join(dir, "compose-keyring.json");
    await saveKeyringToFile(keyringFile, testKeyring);
    const config = configFor(keyringFile);
    repo = createJsonApplicationsRepository(dir);
    const inventories = createJsonApplicationsInventoryRepository(
      join(dir, "inventory.json"),
    );
    await inventories.save(sampleInventory());
    const applicationService = new ApplicationsService(
      config,
      vps,
      agents,
      repo,
      inventories,
    );
    service = applicationService;

    const registeredApp = await applicationService.create(vpsId, {
      confirmation: { confirmed: true },
      idempotencyKey: "create-persisted-app",
      displayName: "Persisted App",
      detectedProjectName: "persisted-app",
      daemonEpoch: "1",
    });

    return { registeredApp, service: applicationService, repo, inventories };
  }

  it("settles and replays the actual worker terminal receipt through strict controller validation", async () => {
    const { service } = await setup();
    const agentService = new AgentService(
      createJsonAgentRepository(join(dir!, "agents.json")),
      createJsonMetricRepository(join(dir!, "metrics.json")),
      vps, configFor(join(dir!, "compose-keyring.json")),
      new AgentLifecycleCoordinator(), {} as never,
    );
    const credential = await agentService.createCredential(vpsId);
    const controller = new AgentApplicationsController(agentService, service);
    const headers = new Headers({ authorization: `Bearer ${credential.token}`, "x-agent-instance": instanceId });
    const req = { header: (name: string) => headers.get(name) ?? undefined } as Request;
    const op = await service.runtimePreparation(vpsId, {
      confirmation: { confirmed: true }, idempotencyKey: "wire-runtime-receipt", pluginRequired: true,
    });
    const claim = await service.claim(vpsId, instanceId);
    const receipt = {
      claimToken: claim!.claimToken, status: "succeeded", executed: false,
      mutationAuthorized: false, partial: false, error: "",
      observed: [{ installPerformed: false, confirmedMode: "plugin", composeVersion: "2.39.4" }],
    };
    await controller.result(req, op.id, receipt);
    await controller.result(req, op.id, receipt);
    const result = await service.vpsOperation(vpsId, op.id);
    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({ installPerformed: false, confirmedMode: "plugin", composeVersion: "2.39.4" });
    expect(JSON.stringify(result)).not.toContain(claim!.claimToken);
    await expect(controller.result(req, op.id, { ...receipt, unsupported: true })).rejects.toThrow();
  });

  it("unifies registered and detected applications in list and detail with deterministic appId", async () => {
    const { registeredApp, service } = await setup();
    const listRes = await service.list(vpsId);

    expect(listRes.items).toHaveLength(2);
    const registered = listRes.items.find(
      (item) => item.appId === registeredApp.id,
    );
    expect(registered).toBeDefined();
    expect(registered?.mode).toBe("detected_readonly");

    const expectedDetectedId = createHash("sha256")
      .update(JSON.stringify([vpsId, "1", "detected-external"]))
      .digest("hex")
      .slice(0, 16);

    const detected = listRes.items.find(
      (item) => item.appId === expectedDetectedId,
    );
    expect(detected).toBeDefined();
    expect(detected?.mode).toBe("detected_readonly");
    expect(detected?.displayName).toBe("detected-external");
    expect(detected?.observed.services[0].service).toBe("api");

    const regDetail = await service.detail(vpsId, registeredApp.id);
    expect(regDetail.id).toBe(registeredApp.id);
    expect(regDetail.projectName).toBe("persisted-app");

    const detDetail = await service.detail(vpsId, expectedDetectedId);
    expect(detDetail.id).toBe(expectedDetectedId);
    expect(detDetail.mode).toBe("detected_readonly");
    expect(detDetail.projectName).toBe("detected-external");
    expect(detDetail.observed.services[0].replicas[0].containerKey).toBe(
      containerKey2,
    );

    await expect(service.detail(vpsId, "non-existent-app-id")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("computes deterministic project runtime fingerprint over sorted container keys", () => {
    const inv = sampleInventory();
    const fp1 = computeProjectRuntimeFingerprint(inv, "persisted-app");
    const fp2 = computeProjectRuntimeFingerprint(inv, "persisted-app");
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/);

    const fpDetected = computeProjectRuntimeFingerprint(
      inv,
      "detected-external",
    );
    expect(fpDetected).not.toBe(fp1);

    const fpMissing = computeProjectRuntimeFingerprint(
      inv,
      "non-existent-project",
    );
    expect(fpMissing).toBe(
      createHash("sha256").update("[]").digest("hex"),
    );
  });

  it("updates and propagates configurable readinessSeconds via update and claim", async () => {
    const { registeredApp, service } = await setup();

    const updated = await service.update(vpsId, registeredApp.id, {
      confirmation: { confirmed: true },
      idempotencyKey: "update-readiness",
      readinessSeconds: 450,
    });
    expect(updated.readinessSeconds).toBe(450);

    const source = await service.source(vpsId, registeredApp.id, {
      confirmation: { confirmed: true }, idempotencyKey: "readiness-source",
      sourcePath: "/srv/persisted-app/compose.yml",
    });
    const sourceClaim = await service.claim(vpsId, instanceId);
    await service.report(vpsId, instanceId, source.operationId, {
      claimToken: sourceClaim!.claimToken, status: "succeeded", executed: true,
      observed: [{ path: "/srv/persisted-app/compose.yml", verified: true,
        digest: "a".repeat(64), project: "persisted-app",
        services: [{ name: "web" }], dependenciesGraph: [{ service: "web", dependsOn: [] }] }],
    });
    await service.optInExternal(vpsId, registeredApp.id, {
      confirmation: { confirmed: true }, idempotencyKey: "readiness-opt-in",
    });
    const op = await service.work(vpsId, registeredApp.id, "lifecycle_restart", {
      confirmation: { confirmed: true }, idempotencyKey: "readiness-restart",
    });
    const claimed = await service.claim(vpsId, instanceId);
    expect(claimed?.operationId).toBe(op.id);
    expect(claimed?.readinessSeconds).toBe(450);
  });

  it("enforces credential replacement and deletion fences on active operations and invalidates previews", async () => {
    const { service, repo } = await setup();
    const registeredApp = await service.create(vpsId, { confirmation: { confirmed: true }, idempotencyKey: "managed-credential", displayName: "Managed" });
    const conf = {
      confirmation: { confirmed: true },
      idempotencyKey: "cred-k1",
    };

    const cred = await service.setCredential(vpsId, {
      ...conf,
      host: "ghcr.io",
      username: "deployer",
      password: "secretpassword",
    });

    const preview = await service.preview(vpsId, registeredApp.id, {
      confirmation: { confirmed: true },
      idempotencyKey: "prev-cred-test",
      composeYaml: "services:\n  app:\n    image: nginx:alpine",
      registryCredentialIds: [cred.id],
    });

    await service.setCredential(vpsId, {
      confirmation: { confirmed: true },
      idempotencyKey: "cred-k2",
      credentialId: cred.id,
      host: "ghcr.io",
      username: "deployer",
      password: "newsecretpassword",
    });

    expect((await service.previewDetail(vpsId, registeredApp.id, preview.previewId)).status).toBe("stale");
    // Persist an executing reference to exercise the replacement fence atomically.
    await repo.transaction(state => {
      const operation = state.operations.find(op => op.id === preview.operationId)!;
      operation.status = "applying";
    });

    await expect(
      service.setCredential(vpsId, {
        confirmation: { confirmed: true },
        idempotencyKey: "cred-k3",
        credentialId: cred.id,
        host: "ghcr.io",
        username: "deployer",
        password: "anotherpassword",
      }),
    ).rejects.toThrow(ConflictException);

    await expect(service.setCredential(vpsId, {
      confirmation: { confirmed: true }, idempotencyKey: "cred-implicit-replace",
      host: "ghcr.io", username: "deployer", password: "replacement",
    })).rejects.toThrow(ConflictException);

    await expect(
      service.deleteCredential(vpsId, cred.id, {
        confirmation: { confirmed: true },
        idempotencyKey: "cred-del-test",
      }),
    ).rejects.toThrow(ConflictException);
  });

  it("supports full adoption preview and adopt flow with secrets, revision and owner manifest", async () => {
    const { registeredApp, service } = await setup();

    const sourceOp = await service.source(vpsId, registeredApp.id, {
      confirmation: { confirmed: true },
      idempotencyKey: "source-verify-1",
      sourcePath: "/srv/persisted-app/docker-compose.yml",
    });

    const sourceClaim = await service.claim(vpsId, instanceId);
    await service.report(vpsId, instanceId, sourceOp.operationId, {
      claimToken: sourceClaim!.claimToken,
      status: "succeeded",
      executed: true,
      mutationAuthorized: false,
      observed: [{
        path: "/srv/persisted-app/docker-compose.yml",
        verified: true,
        digest: "a".repeat(64),
        project: "persisted-app",
        services: [{ name: "web" }],
        dependenciesGraph: [{ service: "web", dependsOn: [] }],
      }],
    });

    const composeYaml = "services:\n  web:\n    image: nginx:alpine\n";
    const prevRes = await service.adoptionPreview(vpsId, registeredApp.id, {
      confirmation: { confirmed: true },
      idempotencyKey: "adopt-preview-1",
      composeYaml,
      secretValues: { DB_PASS: "secret123" },
    });

    expect(prevRes.adoptionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(prevRes.differences).toEqual([]);
    expect(prevRes.runtimeReady).toBe(true);

    const adopted = await service.adopt(vpsId, registeredApp.id, {
      confirmation: { confirmed: true },
      idempotencyKey: "adopt-confirm-1",
      composeYaml,
      adoptionDigest: prevRes.adoptionDigest,
      approvedDifferences: [],
      secretValues: { DB_PASS: "secret123" },
    });

    expect(adopted.mode).toBe("managed");
    expect(adopted.ownerManifest).toBeDefined();
    expect(adopted.ownerManifest?.projectName).toBe("persisted-app");
    expect(adopted.ownerManifest?.containers).toHaveLength(1);
    expect(adopted.ownerManifest?.containers[0].containerKey).toBe(containerKey1);

    const revs = await service.revisions(vpsId, registeredApp.id);
    expect(revs.items).toHaveLength(1);
    expect(revs.items[0].seq).toBe(1);

    const detail = await service.detail(vpsId, registeredApp.id);
    expect(detail.secrets).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "DB_PASS", version: 1 })]),
    );
  });
  it("projects dependency-order per-edge conditions and one-shot health/state replicas into the durable claim plan", async () => {
    const { service, inventories } = await setup();
    const appId = await registerExternalControlled(service, {
      prefix: "dep-order",
      sourcePath: "/srv/persisted-app/project-compose.yml",
      sourceServices: [
        { name: "migration-job", kind: "oneshot", dependsOn: [] },
        { name: "postgres", kind: "longlived", dependsOn: ["migration-job"], healthcheck: true },
        { name: "web", kind: "longlived", dependsOn: ["postgres", "migration-job"] },
      ],
      dependenciesGraph: [
        { service: "migration-job", dependsOn: [] },
        { service: "postgres", dependsOn: ["migration-job"], dependencyConditions: { "migration-job": "completed" } },
        { service: "web", dependsOn: ["postgres", "migration-job"], dependencyConditions: { postgres: "healthy", "migration-job": "completed" } },
      ],
    });

    await inventories.save(makeInventory([
      {
        project: "persisted-app",
        services: [
          { service: "migration-job", replicas: [{ state: "exited", status: "Exited (0) 3 seconds ago" }] },
          { service: "postgres", replicas: [{ state: "running", status: "Up 2 hours", health: "healthy" }] },
          { service: "web", replicas: [{ state: "created", status: "Created" }] },
        ],
      },
    ]));

    const op = await service.work(vpsId, appId, "lifecycle_start", {
      confirmation: { confirmed: true },
      idempotencyKey: "start-dep-order",
    });
    const claim = await service.claim(vpsId, instanceId);
    expect(claim?.operationId).toBe(op.id);
    expect(claim?.kind).toBe("lifecycle_start");

    const plan = claim?.lifecyclePlan;
    expect(plan?.action).toBe("start");
    expect(plan?.order).toEqual(["migration-job", "postgres", "web"]);
    expect(plan?.services.map(s => s.name)).toEqual(["migration-job", "postgres", "web"]);

    const migration = plan?.services[0];
    expect(migration?.kind).toBe("oneshot");
    expect(migration?.dependsOn).toEqual([]);
    expect(migration?.dependencyConditions).toEqual({});
    // mrVnhE-2: a service's own condition reflects its own readiness, never
    // a dependency's edge condition. One-shots complete; long-lived services
    // are healthy only when the source declares a healthcheck.
    expect(migration?.condition).toBe("completed");
    expect(migration?.replicas).toHaveLength(1);
    expect(migration?.replicas[0]?.oneShotStatus).toBe("succeeded");

    const postgres = plan?.services[1];
    expect(postgres?.kind).toBe("longlived");
    expect(postgres?.dependsOn).toEqual(["migration-job"]);
    expect(postgres?.dependencyConditions).toEqual({ "migration-job": "completed" });
    // Declares a healthcheck: healthy is the service's own readiness here,
    // even though its dependency edge (migration-job) demands "completed".
    expect(postgres?.condition).toBe("healthy");
    expect(postgres?.replicas[0]?.oneShotStatus).toBe("running");

    const web = plan?.services[2];
    // No healthcheck on this service itself, even though its dependency edges
    // demand healthy/completed: readiness must not be borrowed from edges.
    expect(web?.condition).toBe("started");
    expect(web?.dependencyConditions).toEqual({ postgres: "healthy", "migration-job": "completed" });

    // Agent execution contract: dependent appears strictly after its dependency.
    const positions = plan?.services.map(s => plan?.order.indexOf(s.name) ?? -1) ?? [];
    expect(positions[2]).toBeGreaterThan(positions[1]!);
    expect(positions[1]).toBeGreaterThan(positions[0]!);
  });

  it("classifies one-shot replicas from live replica health and exit codes", async () => {
    const { service, inventories } = await setup();
    const appId = await registerExternalControlled(service, {
      prefix: "oneshot-status",
      sourceServices: [
        { name: "jobs", kind: "oneshot", dependsOn: [] },
        { name: "web", dependsOn: [] },
      ],
      dependenciesGraph: [{ service: "jobs", dependsOn: [] }, { service: "web", dependsOn: [] }],
    });

    await inventories.save(makeInventory([
      {
        project: "persisted-app",
        services: [
          { service: "web", replicas: [{ state: "running", status: "Up 5 minutes" }] },
          {
            service: "jobs",
            replicas: [
              { state: "exited", status: "Exited (0) 3 seconds ago" },
              { state: "exited", status: "Exited (1) 0 seconds ago" },
              { state: "created", status: "Created" },
              { state: "running", status: "Up 1 minute" },
            ],
          },
        ],
      },
    ]));

    const op = await service.work(vpsId, appId, "lifecycle_restart", {
      confirmation: { confirmed: true },
      idempotencyKey: "restart-oneshot-status",
    });
    const claim = await service.claim(vpsId, instanceId);
    expect(claim?.operationId).toBe(op.id);

    const jobs = claim?.lifecyclePlan?.services.find(s => s.name === "jobs");
    expect(jobs?.kind).toBe("oneshot");
    expect(jobs?.replicas.map(r => r.oneShotStatus)).toEqual([
      "succeeded", "failed", "never_started", "running",
    ]);
    expect(jobs?.replicas.map(r => r.state)).toEqual(["exited", "exited", "created", "running"]);

    // Long-lived service is never classified through one-shot status semantics.
    const web = claim?.lifecyclePlan?.services.find(s => s.name === "web");
    expect(web?.kind).toBe("longlived");
    expect(web?.replicas.map(r => r.oneShotStatus)).toEqual(["running"]);
  });

  it("preserves per-edge conditions and one-shot exit status through the public operation projection", async () => {
    const { service, inventories } = await setup();
    const appId = await registerExternalControlled(service, {
      prefix: "projection",
      sourceServices: [
        { name: "migration-job", kind: "oneshot", dependsOn: [] },
        { name: "web", kind: "longlived", dependsOn: ["migration-job"] },
      ],
      dependenciesGraph: [
        { service: "migration-job", dependsOn: [] },
        { service: "web", dependsOn: ["migration-job"], dependencyConditions: { "migration-job": "completed" } },
      ],
    });

    await inventories.save(makeInventory([
      {
        project: "persisted-app",
        services: [
          { service: "migration-job", replicas: [{ state: "exited", status: "Exited (0) 3 seconds ago" }] },
          { service: "web", replicas: [{ state: "running", status: "Up 1 minute", health: "healthy" }] },
        ],
      },
    ]));

    const op = await service.work(vpsId, appId, "lifecycle_start", {
      confirmation: { confirmed: true },
      idempotencyKey: "start-projection",
    });
    const claim = await service.claim(vpsId, instanceId);
    expect(claim?.operationId).toBe(op.id);
    const app = await repo!.transaction(state => state.applications.find(row => row.id === appId)!);
    await service.authorize(vpsId, instanceId, op.id, {
      claimToken: claim!.claimToken,
      payloadDigest: createHash("sha256").update(JSON.stringify({ appId, daemonEpoch: app.daemonEpoch, generation: app.generation, operationId: op.id, kind: op.kind, sourceDigest: claim!.lifecyclePlan!.sourceDigest, observedFingerprint: claim!.lifecyclePlan!.observedFingerprint })).digest("hex"),
    });
    await service.report(vpsId, instanceId, op.id, {
      claimToken: claim!.claimToken,
      status: "succeeded",
      executed: true,
      mutationAuthorized: true,
      observed: [{
        serviceOutcomes: [
          { service: "migration-job", outcome: "succeeded" },
          { service: "web", status: "succeeded", reason: "readiness satisfied" },
        ],
      }],
    });

    // Public projection strips the claim, retains bounded result fields.
    const projection = (await service.operation(vpsId, appId, op.id)) as {
      status: string; claimToken?: unknown; claimToken_count?: number;
      authorization?: Record<string, unknown>;
      result?: Record<string, unknown>;
      lifecyclePlan?: { services: { name: string; dependencyConditions?: Record<string, string>; replicas: { oneShotStatus: string; state: string }[] }[] };
    };
    expect(projection.status).toBe("succeeded");
    expect(projection.claimToken).toBeUndefined();
    expect(projection.authorization?.payloadDigest).toBeUndefined();
    expect(projection.authorization?.nonce).toBeUndefined();

    expect(projection.result?.outcome).toBe("succeeded");
    expect(projection.result?.executed).toBe(true);
    expect(projection.result?.serviceOutcomes).toEqual([
      { service: "migration-job", outcome: "succeeded" },
      { service: "web", outcome: "succeeded", reason: "readiness satisfied" },
    ]);

    expect(projection.lifecyclePlan?.services.find(s => s.name === "web")?.dependencyConditions)
      .toEqual({ "migration-job": "completed" });
    expect(projection.lifecyclePlan?.services.find(s => s.name === "migration-job")?.replicas[0])
      .toEqual(expect.objectContaining({ state: "exited", oneShotStatus: "succeeded" }) as Record<string, unknown>);

    const history = await service.history(vpsId, appId);
    const entry = history.items.find(h => h.id === op.id);
    expect(entry?.status).toBe("succeeded");
    expect(entry && "claimToken" in entry ? entry.claimToken : undefined).toBeUndefined();
  });

  it("validates lifecycle authorization preimage against verified source digest and admitted fingerprint", async () => {
    const { service, inventories } = await setup();
    const appId = await registerExternalControlled(service, {
      prefix: "authz",
      sourcePath: "/srv/persisted-app/compose.yml",
    });

    await inventories.save(makeInventory([
      {
        project: "persisted-app",
        services: [
          { service: "web", replicas: [{ state: "running", status: "Up 5 minutes" }] },
        ],
      },
    ]));

    const op = await service.work(vpsId, appId, "lifecycle_stop", {
      confirmation: { confirmed: true },
      idempotencyKey: "stop-authz",
    });
    expect(op.lifecyclePlan?.action).toBe("stop");
    expect(op.lifecyclePlan?.sourceDigest).toBe("b".repeat(64));

    const claim = await service.claim(vpsId, instanceId);
    expect(claim?.operationId).toBe(op.id);
    const claimedPlan = claim?.lifecyclePlan;
    expect(claimedPlan?.observedFingerprint).toBe(
      computeProjectRuntimeFingerprint(await inventories.current(vpsId), "persisted-app"),
    );

    const appRecord = await repo?.transaction(s => s.applications.find(a => a.id === appId)!);
    const payloadDigest = createHash("sha256").update(JSON.stringify({
      appId,
      daemonEpoch: appRecord?.daemonEpoch,
      generation: appRecord?.generation,
      operationId: op.id,
      kind: op.kind,
      sourceDigest: "b".repeat(64),
      observedFingerprint: op.lifecyclePlan?.observedFingerprint,
    })).digest("hex");

    await expect(service.authorize(vpsId, instanceId, op.id, {
      claimToken: claim?.claimToken ?? "",
      payloadDigest,
    })).resolves.toEqual(
      expect.objectContaining({ revisionAuthorizationId: expect.any(String), grantedAt: expect.any(String) }),
    );

    const projection = await service.operation(vpsId, appId, op.id);
    expect(projection.status).toBe("applying");
  });

  it("rejects lifecycle authorization preimage for a tampered agent source digest", async () => {
    const { service, inventories } = await setup();
    const appId = await registerExternalControlled(service, {
      prefix: "authz-tamper",
      sourcePath: "/srv/persisted-app/compose.yml",
    });

    await inventories.save(makeInventory([
      {
        project: "persisted-app",
        services: [
          { service: "web", replicas: [{ state: "running", status: "Up 5 minutes" }] },
        ],
      },
    ]));

    const op = await service.work(vpsId, appId, "lifecycle_stop", {
      confirmation: { confirmed: true },
      idempotencyKey: "stop-authz-tamper",
    });
    const claim = await service.claim(vpsId, instanceId);
    expect(claim?.operationId).toBe(op.id);

    // Source digest tampered by the agent while the fingerprint still matches.
    const appRecord = await repo?.transaction(s => s.applications.find(a => a.id === appId)!);
    const payloadDigest = createHash("sha256").update(JSON.stringify({
      appId,
      daemonEpoch: appRecord?.daemonEpoch,
      generation: appRecord?.generation,
      operationId: op.id,
      kind: op.kind,
      sourceDigest: "f".repeat(64),
      observedFingerprint: op.lifecyclePlan?.observedFingerprint,
    })).digest("hex");

    await expect(service.authorize(vpsId, instanceId, op.id, {
      claimToken: claim?.claimToken ?? "",
      payloadDigest,
    })).rejects.toThrow(ConflictException);

    expect((await service.operation(vpsId, appId, op.id)).status).toBe("claimed");
  });
});
