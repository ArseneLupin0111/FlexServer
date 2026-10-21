import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { saveKeyringToFile, type Keyring } from "../src/ssh/key-encryption.js";
import { encryptComposeField } from "../src/crypto/secret-envelope.js";
import { loadMigrations } from "../src/db/migrations.js";
import {
  ApplicationsService,
  computeProjectRuntimeFingerprint,
  type ContainerScope,
} from "../src/docker-applications/applications.service.js";
import {
  createJsonApplicationsRepository,
  createPostgresApplicationsRepository,
  type ApplicationsRepository,
  type AppRow,
  type PreviewRow,
  type WorkRow,
} from "../src/persistence/repositories/applications.repository.js";
import {
  createJsonApplicationsInventoryRepository,
  type ApplicationsInventoryRepository,
} from "../src/persistence/repositories/applications-inventory.repository.js";
import { createPostgresApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.postgres.repository.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { AgentState } from "../src/agents/agent.models.js";
import type { StoredApplicationsInventory } from "../src/docker-applications/inventory.schemas.js";

// ── Shared Fixtures & Helpers ────────────────────────────────────────────────

const primaryVpsId = "vps_admission_primary";
const otherVpsId = "vps_admission_other";
const disabledVpsId = "vps_admission_disabled";
const primaryInstanceId = "inst_admission_01";

const testKeyring: Keyring = {
  version: 1,
  activeKekId: "test-kek",
  keys: { "test-kek": { key: randomBytes(32).toString("base64") } },
};

const baseVpsRecord: VpsRecord = {
  id: primaryVpsId,
  name: "primary-vps",
  host: "203.0.113.10",
  port: 22,
  username: "root",
  status: "healthy",
  agentStatus: "online",
  lastSeenAt: new Date().toISOString(),
  dockerManagementEnabled: true,
  composeManagementEnabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
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
  dashboardSessionSecret: "compose-admission-secret-key-01",
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
});

let inventorySequenceCounter = 100;

function makeInventory(
  vpsId: string,
  instanceId: string,
  containerKey: string,
  projectName = "demo-stack",
  sequence = ++inventorySequenceCounter,
): StoredApplicationsInventory {
  const timestamp = new Date().toISOString();
  return {
    vpsId,
    receivedAt: timestamp,
    protocolVersion: "applications-v1",
    agentInstanceId: instanceId,
    daemonEpoch: 1,
    inventorySequence: sequence,
    collectedAt: timestamp,
    completeness: true,
    completionReason: "",
    containerTotal: 1,
    projectTotal: 1,
    replicaTotal: 1,
    projects: [
      {
        project: projectName,
        replicaTotal: 1,
        services: [
          {
            service: "web",
            occupiedSlots: [1],
            maxSlot: 1,
            replicas: [
              {
                containerKey,
                slot: 1,
                state: "running",
                status: "Up 2 hours",
                createdAt: timestamp,
              },
            ],
            health: "healthy",
            isOneoff: false,
            configHash: "hash-001",
          },
        ],
      },
    ],
    capability: {
      protocolVersion: "applications-v1",
      os: "linux",
      arch: "amd64",
      agentVersion: "test-agent",
      dockerAvailable: true,
      composeMode: "plugin",
      installState: "plugin",
      managementGate: false,
      features: [],
      reasons: [],
    },
  };
}

function computeLifecyclePreimageDigest(
  app: AppRow,
  op: WorkRow,
  inv: StoredApplicationsInventory,
): string {
  const observedFingerprint = computeProjectRuntimeFingerprint(inv, app.projectName);
  const preimage = {
    appId: app.id,
    daemonEpoch: app.daemonEpoch,
    generation: app.generation,
    operationId: op.id,
    kind: op.kind,
    sourceDigest: (op.request as { sourceDigest?: string }).sourceDigest,
    observedFingerprint,
  };
  return createHash("sha256").update(JSON.stringify(preimage)).digest("hex");
}

type TestContext = {
  service: ApplicationsService;
  repo: ApplicationsRepository;
  inventories: ApplicationsInventoryRepository;
  vpsRecords: Map<string, VpsRecord>;
  keyring: Keyring;
  resetState: () => Promise<void>;
  cleanup: () => Promise<void>;
};

async function setupApp(
  ctx: TestContext,
  vpsId: string,
  instanceId: string,
  options?: {
    containerKey?: string;
    projectName?: string;
    mode?: "managed" | "external_control";
    withSource?: boolean;
  },
) {
  const containerKey = options?.containerKey ?? "cont_key_001";
  const projectName = options?.projectName ?? "demo-stack";
  const inv = makeInventory(vpsId, instanceId, containerKey, projectName);
  await ctx.inventories.save(inv);

  const created = await ctx.service.create(vpsId, {
    confirmation: { confirmed: true },
    idempotencyKey: `create-app-${randomBytes(4).toString("hex")}`,
    displayName: "Test Compose Stack",
  });

  if (options?.mode === "external_control" || options?.withSource) {
    await ctx.repo.transaction((state) => {
      const app = state.applications.find((a) => a.id === created.id)!;
      app.projectName = projectName;
      app.mode = options?.mode ?? "external_control";
      app.source = {
        path: "/srv/docker-compose.yml",
        digest: "source-digest-001",
        verified: true,
        verifiedAt: new Date().toISOString(),
        services: [{ name: "web", kind: "longlived", dependsOn: [] }],
      };
    });
  }

  return { appId: created.id, inv, containerKey, projectName };
}

// ── Shared Regression Test Suite ─────────────────────────────────────────────

function registerAdmissionRegressionTests(getContext: () => TestContext) {
  describe("cross-domain operation admission and contention", () => {
    it("blocks Compose stack operation when legacy container management holds a reservation on a member container", async () => {
      const ctx = getContext();
      const { appId, containerKey } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      const target: ContainerScope = { agentInstanceId: primaryInstanceId, containerKey };
      await ctx.service.reserveContainer(primaryVpsId, target, "legacy-cmd-101");

      await expect(
        ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
          confirmation: { confirmed: true },
          idempotencyKey: "work-lifecycle-blocked",
        }),
      ).rejects.toThrow(ConflictException);

      await ctx.service.releaseContainer(primaryVpsId, "legacy-cmd-101");

      const admitted = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "work-lifecycle-unblocked",
      });
      expect(admitted.status).toBe("prepared");
    });

    it("enforces container reservation invariants: exact replay succeeds, conflicting target and conflicting operations reject", async () => {
      const ctx = getContext();
      const targetA: ContainerScope = { agentInstanceId: primaryInstanceId, containerKey: "container-alpha" };
      const targetB: ContainerScope = { agentInstanceId: primaryInstanceId, containerKey: "container-beta" };

      await ctx.service.reserveContainer(primaryVpsId, targetA, "op-reserv-1");

      await expect(
        ctx.service.reserveContainer(primaryVpsId, targetA, "op-reserv-1"),
      ).resolves.toBeUndefined();

      await expect(
        ctx.service.reserveContainer(primaryVpsId, targetB, "op-reserv-1"),
      ).rejects.toThrow(ConflictException);

      await expect(
        ctx.service.reserveContainer(primaryVpsId, targetA, "op-reserv-2"),
      ).rejects.toThrow(ConflictException);

      await ctx.service.releaseContainer(primaryVpsId, "op-reserv-1");
      await expect(
        ctx.service.reserveContainer(primaryVpsId, targetA, "op-reserv-2"),
      ).resolves.toBeUndefined();
      await ctx.service.releaseContainer(primaryVpsId, "op-reserv-2");
    });

    it("refuses VPS purge while container reservations or operations remain active", async () => {
      const ctx = getContext();
      const target: ContainerScope = { agentInstanceId: primaryInstanceId, containerKey: "cont-purge-check" };

      await ctx.service.reserveContainer(primaryVpsId, target, "op-hold");
      await expect(ctx.service.assertVpsRemovable(primaryVpsId)).rejects.toThrow(ConflictException);
      await expect(ctx.service.purgeVps(primaryVpsId)).rejects.toThrow(ConflictException);

      await ctx.service.releaseContainer(primaryVpsId, "op-hold");

      await ctx.resetState();
      await expect(ctx.service.assertVpsRemovable(primaryVpsId)).resolves.toBeUndefined();
    });
  });

  describe("concurrent authorization vs Unmanage / secrets / registry replacement", () => {
    it("rejects mutation authorization when Unmanage commits first, invalidating stack generation and mode", async () => {
      const ctx = getContext();
      const { appId, inv } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      const op = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-unm-race-1",
      });
      expect(op.status).toBe("prepared");

      const claim = await ctx.service.claim(primaryVpsId, primaryInstanceId);
      expect(claim?.operationId).toBe(op.id);
      const claimToken = claim!.claimToken;

      // User executes Unmanage before agent authorization request
      const unmanaged = await ctx.service.unmanage(primaryVpsId, appId, {
        confirmation: { confirmed: true },
        idempotencyKey: "unmanage-race-1",
      });
      expect(unmanaged.mode).toBe("unmanaged");

      // Agent attempts mutation authorization
      const appRecord = await ctx.repo.transaction((s) => s.applications.find((a) => a.id === appId)!);
      const payloadDigest = computeLifecyclePreimageDigest(appRecord, op, inv);

      await expect(
        ctx.service.authorize(primaryVpsId, primaryInstanceId, op.id, {
          claimToken,
          payloadDigest,
        }),
      ).rejects.toThrow(ConflictException); // identity_changed

      // Verify mutation authorization was never granted
      const opAfter = await ctx.repo.transaction((s) => s.operations.find((o) => o.id === op.id)!);
      expect(opAfter.authorization).toBeUndefined();
      expect(opAfter.status).not.toBe("applying");
    });

    it("refuses Unmanage when mutation authorization commits first, locking the stack under exclusive mutation", async () => {
      const ctx = getContext();
      const { appId, inv } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      const op = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-unm-race-2",
      });

      const claim = await ctx.service.claim(primaryVpsId, primaryInstanceId);
      expect(claim?.operationId).toBe(op.id);
      const claimToken = claim!.claimToken;

      const appRecord = await ctx.repo.transaction((s) => s.applications.find((a) => a.id === appId)!);
      const payloadDigest = computeLifecyclePreimageDigest(appRecord, op, inv);

      const auth = await ctx.service.authorize(primaryVpsId, primaryInstanceId, op.id, {
        claimToken,
        payloadDigest,
      });
      expect(auth.revisionAuthorizationId).toBeDefined();

      // Mutation is now authorized and applying; Unmanage must be refused
      await expect(
        ctx.service.unmanage(primaryVpsId, appId, {
          confirmation: { confirmed: true },
          idempotencyKey: "unmanage-race-2",
        }),
      ).rejects.toThrow(ConflictException); // application_busy

      // Application remains in external_control
      const appAfter = await ctx.repo.transaction((s) => s.applications.find((a) => a.id === appId)!);
      expect(appAfter.mode).toBe("external_control");
    });

    it("refuses secret update and secret deletion while an operation is active or applying", async () => {
      const ctx = getContext();
      const { appId } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      await ctx.service.secrets(primaryVpsId, appId, {
        confirmation: { confirmed: true },
        idempotencyKey: "sec-add-init",
        name: "API_KEY",
        value: "initial-secret-v1",
      });

      // Admit an operation
      await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-sec-lock",
      });

      // Both update and deletion must be refused with application_busy
      await expect(
        ctx.service.secrets(primaryVpsId, appId, {
          confirmation: { confirmed: true },
          idempotencyKey: "sec-upd-blocked",
          name: "API_KEY",
          value: "updated-secret-v2",
        }),
      ).rejects.toThrow(ConflictException);

      await expect(
        ctx.service.deleteSecret(primaryVpsId, appId, "API_KEY", {
          confirmation: { confirmed: true },
          idempotencyKey: "sec-del-blocked",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("refuses registry credential deletion while in use and detects version conflict on deploy authorization", async () => {
      const ctx = getContext();
      const { appId } = await setupApp(ctx, primaryVpsId, primaryInstanceId, { mode: "managed" });

      const cred = await ctx.service.setCredential(primaryVpsId, {
        confirmation: { confirmed: true },
        idempotencyKey: "cred-setup-01",
        host: "registry.corp.internal",
        username: "builder",
        password: "token-v1",
      });
      expect(cred.version).toBe(1);

      const canonicalModel = {
        services: { web: { image: "registry.corp.internal/app/web@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      };
      const canonicalModelJson = JSON.stringify(canonicalModel);
      const previewDigest = createHash("sha256").update(canonicalModelJson, "utf8").digest("hex");
      const previewId = "preview-cred-race-01";

      const resolvedModelEnvelope = encryptComposeField(
        JSON.stringify({
          canonicalModelJson,
          redactedModel: canonicalModel,
          imageDigests: { web: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          removedServiceIds: [],
          removals: [],
          ownershipBinding: { agentInstanceId: primaryInstanceId, daemonEpoch: "1", projectName: "demo-stack" },
          secretVersions: {},
          credentialVersions: { [cred.id]: 1 },
          revisionSeq: 1,
        }),
        { vpsId: primaryVpsId, appId, field: "resolvedModel", version: 1 },
        ctx.keyring,
      );

      const previewRow: PreviewRow = {
        id: previewId,
        appId,
        vpsId: primaryVpsId,
        revisionSeq: 1,
        status: "confirmed",
        generation: 1,
        request: { registryCredentialIds: [cred.id] },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        updatedAt: new Date().toISOString(),
        digest: previewDigest,
        removedServices: [],
        resolvedModelEnvelope,
        observedCredentialVersions: { [cred.id]: 1 },
      };

      const deployOpId = "deploy-cred-race-01";
      const deployOpRow: WorkRow = {
        id: deployOpId,
        vpsId: primaryVpsId,
        appId,
        kind: "deploy",
        status: "claimed",
        claimToken: "c".repeat(64),
        claimedBy: primaryInstanceId,
        request: { previewId, approvedDigest: previewDigest, removedServiceIds: [], registryCredentialIds: [cred.id] },
        generation: 1,
        idempotencyKey: "deploy-cred-race-idemp",
        requestDigest: "req-digest-01",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await ctx.repo.transaction((state) => {
        state.previews.push(previewRow);
        state.operations.push(deployOpRow);
      });

      // Deletion of credential while referenced in active operation must be refused
      await expect(
        ctx.service.deleteCredential(primaryVpsId, cred.id, {
          confirmation: { confirmed: true },
          idempotencyKey: "del-cred-while-active",
        }),
      ).rejects.toThrow(ConflictException);

      // Credential replacement bumps version to 2
      await ctx.service.setCredential(primaryVpsId, {
        confirmation: { confirmed: true },
        idempotencyKey: "upd-cred-to-v2",
        credentialId: cred.id,
        host: "registry.corp.internal",
        username: "builder",
        password: "token-v2",
      });

      // Deploy authorization must reject because credential version is changed
      const preimage = {
        appId,
        approvedDigest: previewDigest,
        daemonEpoch: "1",
        generation: 1,
        kind: "deploy",
        operationId: deployOpId,
        removedServiceIds: [],
        removals: [],
        ownershipBinding: { agentInstanceId: primaryInstanceId, daemonEpoch: "1", projectName: "demo-stack" },
        inventoryFingerprint: undefined,
      };
      const deployPayloadDigest = createHash("sha256").update(JSON.stringify(preimage)).digest("hex");

      await expect(
        ctx.service.authorize(primaryVpsId, primaryInstanceId, deployOpId, {
          claimToken: "c".repeat(64),
          payloadDigest: deployPayloadDigest,
        }),
      ).rejects.toThrow(ConflictException); // protected_inputs_changed
    });
  });

  describe("cancellation boundary", () => {
    it("permits cancellation before mutation authorization, but strictly refuses cancellation once authorized or terminal", async () => {
      const ctx = getContext();
      const { appId, inv } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      const op1 = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-cancel-prep",
      });
      expect(op1.status).toBe("prepared");

      // Cancellation before mutation authorization succeeds
      const cancelled = await ctx.service.cancel(primaryVpsId, appId, op1.id, {
        confirmation: { confirmed: true },
        idempotencyKey: "cancel-prep-ok",
      });
      expect(cancelled.status).toBe("cancelled");

      // Cancelling an already terminal operation rejects with operation_terminal
      await expect(
        ctx.service.cancel(primaryVpsId, appId, op1.id, {
          confirmation: { confirmed: true },
          idempotencyKey: "cancel-terminal-repeat",
        }),
      ).rejects.toThrow(ConflictException);

      // Cancelled operation does not block admitting a new operation
      const op2 = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-cancel-second",
      });
      expect(op2.id).not.toBe(op1.id);

      // Claim and authorize op2
      const claim = await ctx.service.claim(primaryVpsId, primaryInstanceId);
      const appRecord = await ctx.repo.transaction((s) => s.applications.find((a) => a.id === appId)!);
      const payloadDigest = computeLifecyclePreimageDigest(appRecord, op2, inv);
      await ctx.service.authorize(primaryVpsId, primaryInstanceId, op2.id, {
        claimToken: claim!.claimToken,
        payloadDigest,
      });

      // Cancellation must be refused once mutation authorization is granted
      await expect(
        ctx.service.cancel(primaryVpsId, appId, op2.id, {
          confirmation: { confirmed: true },
          idempotencyKey: "cancel-after-auth-refused",
        }),
      ).rejects.toThrow(ConflictException); // mutation_already_authorized
    });
  });

  describe("receipt replay conflicts and execution without authorization", () => {
    it("accepts exact replay of terminal receipts but rejects conflicting replay and un-authorized execution reports", async () => {
      const ctx = getContext();
      const { appId, inv } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      // Part A: Execution report without authorization must fail
      const unauthOp = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-unauth-exec",
      });
      const unauthClaim = await ctx.service.claim(primaryVpsId, primaryInstanceId);

      await expect(
        ctx.service.report(primaryVpsId, primaryInstanceId, unauthOp.id, {
          claimToken: unauthClaim!.claimToken,
          status: "succeeded",
          executed: true,
          observed: [{ ok: true }],
        }),
      ).rejects.toThrow(ForbiddenException); // authorization_required

      // Clean operations for part B
      await ctx.repo.transaction((s) => {
        s.operations = [];
      });

      // Part B: Authorized operation, terminal receipt replay vs conflicting receipt replay
      const op = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-receipt-replay",
      });
      const claim = await ctx.service.claim(primaryVpsId, primaryInstanceId);
      const appRecord = await ctx.repo.transaction((s) => s.applications.find((a) => a.id === appId)!);
      const payloadDigest = computeLifecyclePreimageDigest(appRecord, op, inv);
      await ctx.service.authorize(primaryVpsId, primaryInstanceId, op.id, {
        claimToken: claim!.claimToken,
        payloadDigest,
      });

      const validReceipt = {
        claimToken: claim!.claimToken,
        status: "succeeded" as const,
        executed: true,
        observed: [{ outcome: "running" }],
      };

      // Initial terminal report commits successfully
      const firstReport = await ctx.service.report(primaryVpsId, primaryInstanceId, op.id, validReceipt);
      expect(firstReport).toEqual({ ok: true, committed: true });

      // Exact replay succeeds idempotently
      const exactReplay = await ctx.service.report(primaryVpsId, primaryInstanceId, op.id, validReceipt);
      expect(exactReplay).toEqual({ ok: true, committed: true });

      // Conflicting receipt (status failed) rejects with receipt_conflict
      await expect(
        ctx.service.report(primaryVpsId, primaryInstanceId, op.id, {
          claimToken: claim!.claimToken,
          status: "failed",
          executed: true,
          error: "divergent error outcome",
        }),
      ).rejects.toThrow(ConflictException);

      // Conflicting receipt (executed mismatch) rejects with receipt_conflict
      await expect(
        ctx.service.report(primaryVpsId, primaryInstanceId, op.id, {
          claimToken: claim!.claimToken,
          status: "succeeded",
          executed: false,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("uncertain status retaining exclusion and recheck reconciliation", () => {
    it("retains stack exclusion during uncertain state, rejecting new operations and unmanage until rechecked", async () => {
      const ctx = getContext();
      const { appId, inv } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      const op = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-uncertain-lock",
      });
      const claim = await ctx.service.claim(primaryVpsId, primaryInstanceId);
      const appRecord = await ctx.repo.transaction((s) => s.applications.find((a) => a.id === appId)!);
      const payloadDigest = computeLifecyclePreimageDigest(appRecord, op, inv);
      await ctx.service.authorize(primaryVpsId, primaryInstanceId, op.id, {
        claimToken: claim!.claimToken,
        payloadDigest,
      });

      const uncertainReceipt = {
        claimToken: claim!.claimToken,
        status: "uncertain" as const,
        executed: true,
        error: "heartbeat dropped during container startup",
      };

      // Report uncertain status
      const reportRes = await ctx.service.report(primaryVpsId, primaryInstanceId, op.id, uncertainReceipt);
      expect(reportRes).toEqual({ ok: true, committed: true });

      const storedOp = await ctx.repo.transaction((s) => s.operations.find((o) => o.id === op.id)!);
      expect(storedOp.status).toBe("uncertain");

      // Exact replay of uncertain receipt accepted idempotently
      const uncertainReplay = await ctx.service.report(primaryVpsId, primaryInstanceId, op.id, uncertainReceipt);
      expect(uncertainReplay).toEqual({ ok: true, committed: true });

      // Conflicting report while uncertain is rejected
      await expect(
        ctx.service.report(primaryVpsId, primaryInstanceId, op.id, {
          claimToken: claim!.claimToken,
          status: "failed",
          executed: true,
          error: "other error",
        }),
      ).rejects.toThrow(ConflictException);

      // Stack exclusion is retained: new operations on the stack reject with application_busy
      await expect(
        ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
          confirmation: { confirmed: true },
          idempotencyKey: "work-during-uncertain",
        }),
      ).rejects.toThrow(ConflictException);

      // Unmanage is rejected while uncertain
      await expect(
        ctx.service.unmanage(primaryVpsId, appId, {
          confirmation: { confirmed: true },
          idempotencyKey: "unm-during-uncertain",
        }),
      ).rejects.toThrow(ConflictException);

      // Cancellation is rejected
      await expect(
        ctx.service.cancel(primaryVpsId, appId, op.id, {
          confirmation: { confirmed: true },
          idempotencyKey: "cancel-during-uncertain",
        }),
      ).rejects.toThrow(ConflictException); // mutation_already_authorized

      // Recheck reconciles the uncertain state against live inventory
      const rechecked = await ctx.service.recheck(primaryVpsId, appId, op.id, {
        confirmation: { confirmed: true },
        idempotencyKey: "recheck-after-uncertain",
      });
      expect(rechecked.id).toBe(op.id);
      expect((rechecked.result as Record<string, unknown>)?.reconcile).toBeDefined();
    });
  });

  describe("auth and VPS isolation", () => {
    it("enforces VPS isolation and Compose management gate without leaking cross-domain access", async () => {
      const ctx = getContext();

      // 1. VPS with composeManagementEnabled = false rejects operations
      await expect(
        ctx.service.create(disabledVpsId, {
          confirmation: { confirmed: true },
          idempotencyKey: "create-disabled-gate",
          displayName: "Disabled Stack",
        }),
      ).rejects.toThrow(ForbiddenException); // compose_management_disabled

      // 2. Setup application on primary VPS
      const { appId } = await setupApp(ctx, primaryVpsId, primaryInstanceId, {
        mode: "external_control",
        withSource: true,
      });

      // 3. Attempting to query, work or unmanage the app using another VPS ID rejects with NotFoundException
      await expect(ctx.service.detail(otherVpsId, appId)).rejects.toThrow(NotFoundException);

      await expect(
        ctx.service.work(otherVpsId, appId, "lifecycle_start", {
          confirmation: { confirmed: true },
          idempotencyKey: "cross-vps-work-refused",
        }),
      ).rejects.toThrow(NotFoundException);

      await expect(
        ctx.service.unmanage(otherVpsId, appId, {
          confirmation: { confirmed: true },
          idempotencyKey: "cross-vps-unmanage-refused",
        }),
      ).rejects.toThrow(NotFoundException);

      // 4. Agent on otherVpsId claiming work receives null (cannot claim primaryVpsId work)
      const op = await ctx.service.work(primaryVpsId, appId, "lifecycle_start", {
        confirmation: { confirmed: true },
        idempotencyKey: "op-isolation-claim",
      });
      expect(op.status).toBe("prepared");

      await ctx.inventories.save(makeInventory(otherVpsId, "other-agent-inst", "other-cont"));
      const otherClaim = await ctx.service.claim(otherVpsId, "other-agent-inst");
      expect(otherClaim).toBeNull();

      const primaryClaim = await ctx.service.claim(primaryVpsId, primaryInstanceId);
      expect(primaryClaim?.operationId).toBe(op.id);

      // 5. Wrong instance ID or wrong claimToken attempting to authorize rejects with ForbiddenException("invalid_claim")
      await expect(
        ctx.service.authorize(primaryVpsId, "imposter-agent-inst", op.id, {
          claimToken: primaryClaim!.claimToken,
          payloadDigest: "f".repeat(64),
        }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        ctx.service.authorize(primaryVpsId, primaryInstanceId, op.id, {
          claimToken: "wrong-token-".padEnd(64, "0"),
          payloadDigest: "f".repeat(64),
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
}

// ── JSON Adapter Suite ───────────────────────────────────────────────────────

describe("Compose admission behavioral regressions — JSON adapter", () => {
  let context: TestContext;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "compose-admission-json-"));
    const keyringFile = join(testDir, "compose-keyring.json");
    await saveKeyringToFile(keyringFile, testKeyring);
    const config = configFor(keyringFile);

    const repo = createJsonApplicationsRepository(testDir);
    const inventoryFile = join(testDir, "inventory.json");
    const inventories = createJsonApplicationsInventoryRepository(inventoryFile);

    const vpsRecords = new Map<string, VpsRecord>();
    vpsRecords.set(primaryVpsId, { ...baseVpsRecord, id: primaryVpsId, composeManagementEnabled: true });
    vpsRecords.set(otherVpsId, { ...baseVpsRecord, id: otherVpsId, name: "other-vps", host: "203.0.113.20", composeManagementEnabled: true });
    vpsRecords.set(disabledVpsId, { ...baseVpsRecord, id: disabledVpsId, name: "disabled-vps", host: "203.0.113.30", composeManagementEnabled: false });

    const vpsRepo: VpsRepository = {
      get: async (id: string) => vpsRecords.get(id),
    } as unknown as VpsRepository;

    const agentsRepo: AgentRepository = {
      getState: async (id: string) => {
        const v = vpsRecords.get(id);
        return v
          ? ({
              vpsId: id,
              status: v.agentStatus ?? "online",
              lastSeenAt: v.lastSeenAt ?? new Date().toISOString(),
              version: "1.0.0",
            } as unknown as AgentState)
          : undefined;
      },
    } as unknown as AgentRepository;

    const service = new ApplicationsService(config, vpsRepo, agentsRepo, repo, inventories);

    const resetState = async () => {
      await repo.transaction((state) => {
        state.applications = [];
        state.secrets = [];
        state.credentials = [];
        state.revisions = [];
        state.previews = [];
        state.operations = [];
        state.containerContentions = [];
      });
    };

    const cleanup = async () => {
      await repo.close();
      await rm(testDir, { recursive: true, force: true });
    };

    context = {
      service,
      repo,
      inventories,
      vpsRecords,
      keyring: testKeyring,
      resetState,
      cleanup,
    };
  });

  afterEach(async () => {
    if (context) {
      await context.cleanup();
    }
  });

  registerAdmissionRegressionTests(() => context);
});

// ── PostgreSQL Adapter Suite (Migrated Schema) ───────────────────────────────

const postgresDatabaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;

describe.skipIf(!postgresDatabaseUrl)(
  "Compose admission behavioral regressions — PostgreSQL adapter (migrated schema)",
  () => {
    let context: TestContext;
    let adminPool: pg.Pool;
    let pool: pg.Pool;
    let schemaName: string;
    let testDir: string;
    let repo: ApplicationsRepository;
    let inventories: ApplicationsInventoryRepository;
    let service: ApplicationsService;
    let vpsRecords: Map<string, VpsRecord>;

    beforeAll(async () => {
      if (!postgresDatabaseUrl) return;

      testDir = await mkdtemp(join(tmpdir(), "compose-admission-pg-"));
      const keyringFile = join(testDir, "compose-keyring.json");
      await saveKeyringToFile(keyringFile, testKeyring);
      const config = configFor(keyringFile);

      adminPool = new pg.Pool({ connectionString: postgresDatabaseUrl });
      schemaName = `compose_adm_${Date.now()}_${randomBytes(4).toString("hex")}`;
      await adminPool.query(`CREATE SCHEMA "${schemaName}"`);

      pool = new pg.Pool({
        connectionString: postgresDatabaseUrl,
        options: `-c search_path=${schemaName}`,
      });

      // Base VPS table before Compose phase 2 migrations
      await pool.query(`CREATE TABLE vps (
        id text PRIMARY KEY,
        name text NOT NULL,
        host text NOT NULL,
        port integer NOT NULL,
        username text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);

      // Seed VPS rows before migrations run
      await pool.query(`INSERT INTO vps (id, name, host, port, username) VALUES
        ('${primaryVpsId}', 'primary', '203.0.113.10', 22, 'root'),
        ('${otherVpsId}', 'other', '203.0.113.20', 22, 'root'),
        ('${disabledVpsId}', 'disabled', '203.0.113.30', 22, 'root')`);

      // Apply migrations 028 and 029
      const migrations = await loadMigrations();
      const mig028 = migrations.find((m) => m.id === "028_docker_applications.sql");
      if (!mig028) throw new Error("028_docker_applications.sql not found");
      await pool.query(mig028.sql);

      const mig029 = migrations.find((m) => m.id === "029_docker_application_state.sql");
      if (!mig029) throw new Error("029_docker_application_state.sql not found");
      await pool.query(mig029.sql);

      repo = createPostgresApplicationsRepository(pool);
      inventories = createPostgresApplicationsInventoryRepository(pool);

      vpsRecords = new Map<string, VpsRecord>();
      vpsRecords.set(primaryVpsId, { ...baseVpsRecord, id: primaryVpsId, composeManagementEnabled: true });
      vpsRecords.set(otherVpsId, { ...baseVpsRecord, id: otherVpsId, name: "other-vps", host: "203.0.113.20", composeManagementEnabled: true });
      vpsRecords.set(disabledVpsId, { ...baseVpsRecord, id: disabledVpsId, name: "disabled-vps", host: "203.0.113.30", composeManagementEnabled: false });

      const vpsRepo: VpsRepository = {
        get: async (id: string) => vpsRecords.get(id),
      } as unknown as VpsRepository;

      const agentsRepo: AgentRepository = {
        getState: async (id: string) => {
          const v = vpsRecords.get(id);
          return v
            ? ({
                vpsId: id,
                status: v.agentStatus ?? "online",
                lastSeenAt: v.lastSeenAt ?? new Date().toISOString(),
                version: "1.0.0",
              } as unknown as AgentState)
            : undefined;
        },
      } as unknown as AgentRepository;

      service = new ApplicationsService(config, vpsRepo, agentsRepo, repo, inventories);

      const resetState = async () => {
        await repo.transaction((state) => {
          state.applications = [];
          state.secrets = [];
          state.credentials = [];
          state.revisions = [];
          state.previews = [];
          state.operations = [];
          state.containerContentions = [];
        });
        await pool.query("DELETE FROM docker_application_inventories");
      };

      const cleanup = async () => {
        await repo.close();
        await pool.end().catch(() => undefined);
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
        await adminPool.end().catch(() => undefined);
        await rm(testDir, { recursive: true, force: true });
      };

      context = {
        service,
        repo,
        inventories,
        vpsRecords,
        keyring: testKeyring,
        resetState,
        cleanup,
      };
    }, 45_000);

    beforeEach(async () => {
      if (context) {
        await context.resetState();
      }
    });

    afterAll(async () => {
      if (context) {
        await context.cleanup();
      }
    });

    registerAdmissionRegressionTests(() => context);
  },
);
