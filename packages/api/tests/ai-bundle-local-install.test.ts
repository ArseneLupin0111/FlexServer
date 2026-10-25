import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Request } from "express";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonFleetRepository } from "../src/persistence/repositories/fleet.repository.js";
import type { FleetRepository } from "../src/persistence/repositories/fleet.repository.js";
import { createJsonLocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import type { LocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AuditService } from "../src/audit/audit.service.js";
import { LocalUpgradeService } from "../src/local-upgrade/local-upgrade.service.js";
import type { LocalUpgradeJob } from "../src/local-upgrade/local-upgrade.models.js";
import {
  AI_INSTALL_COMPONENTS,
  jobKind,
} from "../src/local-upgrade/local-upgrade.models.js";
import { AiBundleService } from "../src/ai/ai-bundle.service.js";
import { AiBundleOrchestrationService } from "../src/ai/ai-bundle-install.service.js";
import { AiLocalInstallService } from "../src/ai/ai-local-install.service.js";
import { AiRoutesService } from "../src/ai/ai-routes.service.js";
import type { AiCodexOauthService } from "../src/ai/ai-codex-oauth.service.js";
import type { AgentCredential } from "../src/agents/agent.models.js";
import type { BundledAgentService } from "../src/local-upgrade/bundled-agent.service.js";
import { signFleetManifest } from "../../../scripts/release/fleet-release.mjs";

// Route-level integration for the local/system-host AI first-install through
// the pull updater channel: GET /bundle reports updater-channel eligibility
// and the durable job, POST /bundle/install creates an ai-install job pinned
// to a signed release. Fully offline — the signed release is a locally
// generated Ed25519 fixture and no SSH transport is ever invoked.

const AI_COMPONENTS = [...AI_INSTALL_COMPONENTS];

function requestWithKey(idempotencyKey?: string): Request {
  return {
    dashboardSessionId: "admin-session",
    ...(idempotencyKey
      ? { headers: { "idempotency-key": idempotencyKey } }
      : { headers: {} }),
  } as unknown as Request;
}

async function signedAiRelease() {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const payload = {
    schemaVersion: 1,
    channel: "stable",
    releaseId: "c".repeat(40),
    buildId: "c".repeat(40),
    version: "2.0.0",
    minUpdaterVersion: "1.4.0",
    publishedAt: "2026-10-20T00:00:00Z",
    rollbackSafe: true,
    artifacts: AI_COMPONENTS.map((component) => ({
      component,
      os: "linux",
      arch: "amd64",
      url: `https://example.com/${component}`,
      sha256: "d".repeat(64),
      size: 1024,
      version: "2.0.0",
    })),
    ai: { version: "2.0.0", components: AI_COMPONENTS },
  };
  const envelope = signFleetManifest(payload, privateKey as string, "test-ai-key");
  return { publicKey: publicKey as string, payload, envelope };
}

describe("AI bundle local updater channel", () => {
  let tempDir: string;
  let vpsRepo: VpsRepository;
  let agentRepo: AgentRepository;
  let lugRepo: LocalUpgradeRepository;
  let fleetRepo: FleetRepository;
  let aiRepo: AiRepository;
  let config: AppConfig;
  let routes: AiRoutesService;
  let upgrades: LocalUpgradeService;
  let vpsId: string;
  let releaseFixture: Awaited<ReturnType<typeof signedAiRelease>>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-local-install-"));
    vpsRepo = createVpsStore(join(tempDir, "vps.json"));
    agentRepo = createJsonAgentRepository(join(tempDir, "agents.json"));
    lugRepo = createJsonLocalUpgradeRepository(join(tempDir, "local-upgrades.json"));
    fleetRepo = createJsonFleetRepository(join(tempDir, "fleet.json"));
    aiRepo = createJsonAiRepository(join(tempDir, "ai.json"));
    releaseFixture = await signedAiRelease();
    const publicKeyFile = join(tempDir, "fleet-public.pem");
    await writeFile(publicKeyFile, releaseFixture.publicKey, "utf8");

    const local = await vpsRepo.ensureLocalHost({
      name: "Local host",
      host: "127.0.0.1",
      port: 22,
      username: "root",
      kind: "local",
      managedBy: "system",
    });
    vpsId = local.id;
    await agentRepo.upsertSystemInfo({
      vpsId,
      collectedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      kernel: { arch: "x86_64" },
    });

    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-local-install-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: join(tempDir, "no-bundle"),
    });
    config = {
      ...parsed,
      ai: { ...parsed.ai, enabled: true },
      fleet: { publicKeyFile },
    };
    await fleetRepo.upsertRelease({
      id: releaseFixture.payload.releaseId,
      version: releaseFixture.payload.version,
      buildId: releaseFixture.payload.buildId,
      publishedAt: releaseFixture.payload.publishedAt,
      channel: "stable",
      rollbackSafe: true,
      minUpdaterVersion: "1.4.0",
      components: AI_COMPONENTS,
      artifacts: releaseFixture.payload.artifacts,
      rawPayload: releaseFixture.envelope.payload,
      signature: releaseFixture.envelope.signature,
      keyId: releaseFixture.envelope.keyId,
      createdAt: new Date().toISOString(),
    });
    buildRoutes();
  });

  function buildRoutes() {
    const audit = new AuditService(
      config,
      createJsonAuditRepository(join(tempDir, "audit.json")),
    );
    upgrades = new LocalUpgradeService(
      config,
      lugRepo,
      agentRepo,
      vpsRepo,
      {} as unknown as BundledAgentService,
      audit,
    );
    const localInstall = new AiLocalInstallService(
      config,
      lugRepo,
      fleetRepo,
      agentRepo,
      vpsRepo,
      aiRepo,
      upgrades,
      audit,
    );
    const orchestration = new AiBundleOrchestrationService(
      config,
      aiRepo,
      vpsRepo,
      agentRepo,
      new AiBundleService(config),
      audit,
      // The updater channel must never touch SSH: a transport that fails the
      // test if invoked proves the local path stays off the SSH track.
      {
        resolveAuth: () => {
          throw new Error("SSH transport must not be used on the updater channel");
        },
      },
      undefined,
      localInstall,
    );
    routes = new AiRoutesService(
      config,
      aiRepo,
      vpsRepo,
      {} as unknown as AiCodexOauthService,
      orchestration,
    );
  }

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedUpdater(overrides: Record<string, unknown> = {}) {
    return lugRepo.recordUpdaterHeartbeat({
      vpsId,
      lastSeenAt: new Date().toISOString(),
      credentialId: "cred_updater_test",
      protocolVersion: 3,
      updaterVersion: "1.4.0+build.abcdef",
      platform: { os: "linux", arch: "amd64" },
      idle: true,
      capabilities: ["ai-install"],
      capabilitiesAt: new Date().toISOString(),
      ...overrides,
    });
  }

  it("GET on an eligible local host reports the updater channel as supported with no job", async () => {
    await seedUpdater();
    const view = await routes.bundle(requestWithKey(), vpsId);
    expect(view.installChannel).toBe("updater");
    expect(view.installSupported).toBe(true);
    expect(view.installReason).toBeUndefined();
    expect(view.localJob).toBeNull();
    expect(view.localRelease).toBeNull();
  });

  it("GET fails closed with the capability reason when the updater does not advertise ai-install", async () => {
    await seedUpdater({ capabilities: [], capabilitiesAt: undefined });
    const view = await routes.bundle(requestWithKey(), vpsId);
    expect(view.installChannel).toBe("updater");
    expect(view.installSupported).toBe(false);
    expect(view.installReason).toContain("does not currently report AI install support");
    expect(view.localJob).toBeNull();
  });

  it("GET fails closed when no signed AI release has been imported", async () => {
    const emptyFleet = createJsonFleetRepository(join(tempDir, "fleet-empty.json"));
    const audit = new AuditService(config, createJsonAuditRepository(join(tempDir, "audit.json")));
    const localInstall = new AiLocalInstallService(
      config, lugRepo, emptyFleet, agentRepo, vpsRepo, aiRepo, upgrades, audit,
    );
    const orchestration = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, agentRepo, new AiBundleService(config), audit,
      undefined, undefined, localInstall,
    );
    const emptyRoutes = new AiRoutesService(
      config, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService, orchestration,
    );
    await seedUpdater();
    const view = await emptyRoutes.bundle(requestWithKey(), vpsId);
    expect(view.installSupported).toBe(false);
    expect(view.installReason).toContain("No signed AI runtime release has been imported");
  });

  it("POST creates a durable ai-install job pinned to the signed release and replays the idempotency key", async () => {
    await seedUpdater();
    const first = await routes.installBundle(requestWithKey("key-1"), vpsId);
    expect(first.installChannel).toBe("updater");
    expect(first.lastJob).toBeNull(); // no SSH job was ever created
    expect(first.localJob).toMatchObject({
      state: "pending",
      progress: null,
      phase: "queued",
      error: null,
    });
    expect(first.localRelease).toEqual({
      releaseId: releaseFixture.payload.releaseId,
      version: "2.0.0",
      buildId: releaseFixture.payload.buildId,
      manifestSha256: expect.any(String),
    });

    const jobs = await lugRepo.listByVps(vpsId, { limit: 10 });
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as LocalUpgradeJob;
    expect(jobKind(job)).toBe("ai-install");
    expect(job.components).toEqual(AI_COMPONENTS);
    expect(job.manifestSha256).toBe(first.localRelease?.manifestSha256);
    expect(job.manifestRaw).toContain(releaseFixture.payload.releaseId);

    // Same key → same job (replay, never a duplicate).
    const replay = await routes.installBundle(requestWithKey("key-1"), vpsId);
    expect(replay.localJob?.id).toBe(first.localJob?.id);
    expect(await lugRepo.listByVps(vpsId, { limit: 10 })).toHaveLength(1);

    // A different key while the job is active conflicts.
    await expect(
      routes.installBundle(requestWithKey("key-2"), vpsId),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("POST without an Idempotency-Key is rejected with 400 and creates nothing", async () => {
    await seedUpdater();
    await expect(routes.installBundle(requestWithKey(), vpsId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      routes.installBundle(requestWithKey("   "), vpsId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await lugRepo.listByVps(vpsId, { limit: 10 })).toHaveLength(0);
  });

  it("POST on an ineligible host fails closed with the gate reason and no job", async () => {
    // Stale heartbeat: no fresh updater report.
    await seedUpdater({
      lastSeenAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    const error = await routes
      .installBundle(requestWithKey("key-stale"), vpsId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      error: { code: "ai_install_unsupported" },
    });
    expect(await lugRepo.listByVps(vpsId, { limit: 10 })).toHaveLength(0);
  });

  it("GET surfaces the updater job state, phase and real progress for reload recovery", async () => {
    await seedUpdater();
    await routes.installBundle(requestWithKey("key-view"), vpsId);
    const credential: AgentCredential = await agentRepo.createCredential({
      vpsId,
      secretHash: "test-secret-hash",
      status: "active",
      scope: "local-updater",
    });
    const claimed = await upgrades.claim(credential, 3, {
      idle: true,
      capabilities: ["ai-install"],
    });
    expect(claimed).not.toBeNull();
    expect(jobKind(claimed!.job)).toBe("ai-install");
    await upgrades.progress(credential, claimed!.job.id, {
      fencingToken: claimed!.job.fencingToken,
      phase: "downloading",
      progress: 42,
    });
    const view = await routes.bundle(requestWithKey(), vpsId);
    expect(view.localJob).toMatchObject({
      id: claimed!.job.id,
      state: "running",
      progress: 42,
      phase: "downloading",
      error: null,
    });
  });

  it("claims are denied without the live ai-install capability (old helpers never receive the job)", async () => {
    await seedUpdater();
    await routes.installBundle(requestWithKey("key-claim"), vpsId);
    const credential: AgentCredential = await agentRepo.createCredential({
      vpsId,
      secretHash: "test-secret-hash",
      status: "active",
      scope: "local-updater",
    });
    // A claim without the live capability must not hand out the job.
    expect(await upgrades.claim(credential, 3, { idle: true })).toBeNull();
    // The capable helper claims it and receives the pinned manifest.
    const claimed = await upgrades.claim(credential, 3, {
      idle: true,
      capabilities: ["ai-install"],
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.job.manifestRaw).toContain(releaseFixture.payload.releaseId);
  });

  it("remote hosts keep the SSH channel view (no updater fields, no local job)", async () => {
    const remote = await vpsRepo.create({
      name: "VPS",
      host: "127.0.0.1",
      port: 22,
      username: "root",
    });
    await seedUpdater(); // even with updater evidence present on the API side
    const view = await routes.bundle(requestWithKey(), remote.id);
    expect(view.installChannel).toBe("ssh");
    expect(view.installSupported).toBe(true);
    expect(view.localJob).toBeNull();
    expect(view.localRelease).toBeNull();
  });

  it("demo mode disables the updater channel (service-level fail closed)", async () => {
    await seedUpdater();
    // The route layer rejects demo mode at authorize() outright; the
    // updater-channel gates must also fail closed on their own.
    const audit = new AuditService(config, createJsonAuditRepository(join(tempDir, "audit.json")));
    const demoConfig = { ...config, mode: "demo" } as AppConfig;
    const demoUpgrades = new LocalUpgradeService(
      demoConfig, lugRepo, agentRepo, vpsRepo,
      {} as unknown as BundledAgentService, audit,
    );
    const demoLocalInstall = new AiLocalInstallService(
      demoConfig, lugRepo, fleetRepo, agentRepo, vpsRepo, aiRepo, demoUpgrades, audit,
    );
    const view = await demoLocalInstall.getLocalInstallView(vpsId);
    expect(view.installSupported).toBe(false);
    expect(view.installReason).toContain("disabled in demo mode");
    await expect(
      demoLocalInstall.scheduleAiInstall(vpsId, { idempotencyKey: "key-demo" }),
    ).rejects.toThrow(/demo mode/);
  });
});
