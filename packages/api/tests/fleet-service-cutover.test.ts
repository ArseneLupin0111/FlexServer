import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetService } from "../src/agent-updates/fleet.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import type { LocalUpgradeService } from "../src/local-upgrade/local-upgrade.service.js";
import { signFleetManifest } from "../../../scripts/release/fleet-release.mjs";
import type { AppConfig } from "../src/config/app-config.js";
import type { FleetRepository } from "../src/persistence/repositories/fleet.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { LocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.repository.js";
import type { FleetRelease, FleetRollout } from "../src/agent-updates/fleet.models.js";
import type { LocalUpgradeJob } from "../src/local-upgrade/local-upgrade.models.js";
import type { Vps } from "../src/vps/vps.models.js";
import { BadRequestException } from "@nestjs/common";

interface MockVps {
  id: string;
  name: string;
}

interface MockJob {
  id: string;
  vpsId: string;
  revision: number;
  state: string;
  error?: { message: string };
  reason?: string;
  completedAt?: string;
}

describe("FleetService deployment cutover", () => {
  function makeKeys() {
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
    return { privateKey, publicKey };
  }

  function mockDeps(overrides: {
    release?: FleetRelease;
    activeRollout?: FleetRollout;
    vpsList?: MockVps[];
    jobs?: MockJob[];
    localUpgradeService?: LocalUpgradeService;
  } = {}) {
    const releases: FleetRelease[] = overrides.release ? [overrides.release] : [];
    const rollouts: FleetRollout[] = overrides.activeRollout ? [overrides.activeRollout] : [];
    const vpsEntries: MockVps[] = overrides.vpsList ?? [];
    const jobEntries: MockJob[] = overrides.jobs ?? [];
    const tempDir = mkdtempSync(join(tmpdir(), "fleet-test-"));

    const fleetRepo: Partial<FleetRepository> = {
      getRelease: async (id: string) => releases.find((r) => r.id === id),
      upsertRelease: async (r: FleetRelease) => {
        const idx = releases.findIndex((x) => x.id === r.id);
        if (idx >= 0) releases[idx] = r;
        else releases.push(r);
      },
      listReleases: async () => releases,
      getActiveRollout: async () => rollouts.find((r) => r.state === "running" || r.state === "pending"),
      listRollouts: async () => rollouts,
      getRollout: async (id: string) => rollouts.find((r) => r.id === id),
      createRollout: async (r: FleetRollout) => {
        rollouts.push(r);
      },
      updateRollout: async (r: FleetRollout) => {
        const idx = rollouts.findIndex((x) => x.id === r.id);
        if (idx >= 0) rollouts[idx] = r;
      },
      addNotification: async () => {},
      pruneNotifications: async () => 0,
      listPolicies: async () => [],
      listEnrolledVpsIds: async () => [],
    };

    const vpsRepo: Partial<VpsRepository> = {
      list: async () => vpsEntries as unknown as Vps[],
      get: async (id: string) => vpsEntries.find((v) => v.id === id) as unknown as Vps | undefined,
    };

    const agentRepo: Partial<AgentRepository> = {
      listStates: async () => [],
      getState: async (vpsId: string) => ({
        vpsId,
        status: "online",
        lastSeenAt: new Date().toISOString(),
      }),
    };

    const localUpgradeRepo: Partial<LocalUpgradeRepository> = {
      getUpdaterHeartbeat: async () => undefined,
      get: async (id: string) => jobEntries.find((j) => j.id === id) as unknown as LocalUpgradeJob | undefined,
      compareAndSet: async (id: string, _rev: number, patch: Partial<LocalUpgradeJob>) => {
        const job = jobEntries.find((j) => j.id === id);
        if (job) {
          Object.assign(job, patch);
          return job as unknown as LocalUpgradeJob;
        }
        return undefined;
      },
    };

    const config: Partial<AppConfig> = {
      dataDir: tempDir,
      fleet: {},
    };

    const service = new FleetService({
      config: config as AppConfig,
      fleetRepository: fleetRepo as FleetRepository,
      vpsRepository: vpsRepo as VpsRepository,
      agentRepository: agentRepo as AgentRepository,
      localUpgradeRepository: localUpgradeRepo as LocalUpgradeRepository,
      localUpgradeService: overrides.localUpgradeService,
      clock: () => Date.now(),
    });
    return { service, releases, rollouts, tempDir, config };
  }

  it("rejects new signed rollout requests containing agent or updater", async () => {
    const agentRelease: FleetRelease = {
      id: "a".repeat(40),
      version: "1.2.3",
      buildId: "a".repeat(40),
      publishedAt: new Date().toISOString(),
      channel: "stable",
      rollbackSafe: true,
      components: ["agent", "updater"],
      artifacts: [
        {
          component: "agent",
          os: "linux",
          arch: "amd64",
          url: "https://example.com/agent",
          sha256: "b".repeat(64),
          size: 100,
          version: "1.2.3",
        },
      ],
      rawPayload: "{}",
      createdAt: new Date().toISOString(),
    };

    const { service, tempDir } = mockDeps({ release: agentRelease });
    try {
      await expect(
        service.createRollout({
          releaseId: agentRelease.id,
          confirmed: true,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.createRollout({
          releaseId: agentRelease.id,
          confirmed: true,
        }),
      ).rejects.toThrow(/Rollouts for agent or updater components are rejected/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects import of external agent target manifests without AI components", async () => {
    const { privateKey, publicKey } = makeKeys();
    const tempDir = mkdtempSync(join(tmpdir(), "fleet-test-pub-"));
    const pubKeyPath = join(tempDir, "fleet.pub");
    writeFileSync(pubKeyPath, publicKey, "utf8");

    const payload = {
      schemaVersion: 1,
      channel: "stable",
      releaseId: "c".repeat(40),
      buildId: "c".repeat(40),
      version: "2.0.0",
      minUpdaterVersion: "1.0.0",
      publishedAt: new Date().toISOString(),
      rollbackSafe: true,
      artifacts: [
        {
          component: "agent",
          os: "linux",
          arch: "amd64",
          url: "https://example.com/agent",
          sha256: "d".repeat(64),
          size: 500,
          version: "2.0.0",
        },
        {
          component: "updater",
          os: "linux",
          arch: "amd64",
          url: "https://example.com/updater",
          sha256: "e".repeat(64),
          size: 500,
          version: "2.0.0",
        },
      ],
    };

    const envelope = signFleetManifest(payload, privateKey, "test-key");
    const { service, config } = mockDeps();
    config.fleet = { publicKeyFile: pubKeyPath };

    try {
      await expect(service.importRelease(envelope)).rejects.toThrow(BadRequestException);
      await expect(service.importRelease(envelope)).rejects.toThrow(
        /External agent target manifests are no longer imported/i,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows import and rollout of signed AI runtime releases without agent/updater", async () => {
    const { privateKey, publicKey } = makeKeys();
    const tempDir = mkdtempSync(join(tmpdir(), "fleet-test-ai-"));
    const pubKeyPath = join(tempDir, "fleet.pub");
    writeFileSync(pubKeyPath, publicKey, "utf8");

    const payload = {
      schemaVersion: 1,
      channel: "stable",
      releaseId: "f".repeat(40),
      buildId: "f".repeat(40),
      version: "3.0.0",
      minUpdaterVersion: "1.0.0",
      publishedAt: new Date().toISOString(),
      rollbackSafe: true,
      artifacts: [
        {
          component: "ai-executor",
          os: "linux",
          arch: "amd64",
          url: "https://example.com/ai-executor",
          sha256: "1".repeat(64),
          size: 1000,
          version: "3.0.0",
        },
        {
          component: "ai-host-helper",
          os: "linux",
          arch: "amd64",
          url: "https://example.com/ai-host-helper",
          sha256: "2".repeat(64),
          size: 1000,
          version: "3.0.0",
        },
        {
          component: "ai-rootfs",
          os: "linux",
          arch: "amd64",
          url: "https://example.com/ai-rootfs",
          sha256: "3".repeat(64),
          size: 1000,
          version: "3.0.0",
        },
        {
          component: "ai-profiles",
          os: "linux",
          arch: "amd64",
          url: "https://example.com/ai-profiles",
          sha256: "4".repeat(64),
          size: 1000,
          version: "3.0.0",
        },
      ],
      ai: {
        version: "3.0.0",
        components: ["ai-executor", "ai-host-helper", "ai-rootfs", "ai-profiles"],
      },
    };

    const envelope = signFleetManifest(payload, privateKey, "test-key");
    const { service, config } = mockDeps();
    config.fleet = { publicKeyFile: pubKeyPath };

    try {
      const imported = await service.importRelease(envelope);
      expect(imported.id).toBe(payload.releaseId);
      expect(imported.components).toContain("ai-executor");

      // Creating a rollout for AI runtime is allowed
      const rollout = await service.createRollout({
        releaseId: imported.id,
        confirmed: true,
      });
      expect(rollout.releaseId).toBe(imported.id);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("releases coordinator update fence on rollout pause and admits subsequent activity", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const activeFences = new Map<string, () => void>();
    const localUpgradeService = {
      registerUpdateFenceRelease: (vpsId: string, release: () => void) => {
        activeFences.set(vpsId, release);
      },
      releaseUpdateFence: (vpsId: string) => {
        const release = activeFences.get(vpsId);
        if (release) {
          activeFences.delete(vpsId);
          release();
        }
      },
    } as unknown as LocalUpgradeService;

    // Simulate update fence acquired during claim for vps-2
    const releaseVps2Update = await coordinator.tryAcquire("vps-2", "update");
    localUpgradeService.registerUpdateFenceRelease("vps-2", releaseVps2Update);

    // Prior to pause, activity admission for vps-2 MUST throw ConflictException
    expect(() => coordinator.tryAcquireActivity("vps-2", "job")).toThrow(
      /Agent update is in progress for this VPS/,
    );

    const nowIso = new Date().toISOString();
    const jobs: MockJob[] = [
      {
        id: "job-1",
        vpsId: "vps-1",
        state: "failed",
        revision: 1,
        error: { message: "Health check failed" },
      },
      {
        id: "job-2",
        vpsId: "vps-2",
        state: "claimed",
        revision: 1,
      },
    ];

    const release: FleetRelease = {
      id: "rel-123",
      version: "3.0.0",
      buildId: "1".repeat(40),
      publishedAt: nowIso,
      channel: "stable",
      schemaVersion: 1,
      rollbackSafe: true,
      components: ["ai-executor"],
      artifacts: [],
    };

    const activeRollout: FleetRollout = {
      id: "rollout-pause-test",
      releaseId: "rel-123",
      state: "running",
      createdAt: nowIso,
      updatedAt: nowIso,
      hosts: [
        { vpsId: "vps-1", state: "updating", jobId: "job-1" },
        { vpsId: "vps-2", state: "updating", jobId: "job-2" },
      ],
    };

    const vpsList: MockVps[] = [
      { id: "vps-1", name: "Host 1" },
      { id: "vps-2", name: "Host 2" },
    ];

    const { service, tempDir } = mockDeps({
      release,
      activeRollout,
      vpsList,
      jobs,
      localUpgradeService,
    });

    try {
      await service.tick();

      // Rollout is now paused due to vps-1 failure
      expect(activeRollout.state).toBe("paused");
      // Pre-swap job-2 was cancelled
      const job2 = jobs.find((j) => j.id === "job-2");
      expect(job2.state).toBe("failed");

      // The coordinator update fence for vps-2 was released, admitting activity immediately
      const releaseJobActivity = coordinator.tryAcquireActivity("vps-2", "job");
      expect(typeof releaseJobActivity).toBe("function");
      releaseJobActivity();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
