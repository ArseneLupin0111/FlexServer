import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetService } from "../src/agent-updates/fleet.service.js";
import { signFleetManifest } from "../../../scripts/release/fleet-release.mjs";
import type { AppConfig } from "../src/config/app-config.js";
import type { FleetRepository } from "../src/persistence/repositories/fleet.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { FleetRelease, FleetRollout } from "../src/agent-updates/fleet.models.js";
import type { Vps } from "../src/vps/vps.models.js";
import { BadRequestException } from "@nestjs/common";

interface MockVps {
  id: string;
  name: string;
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
  } = {}) {
    const releases: FleetRelease[] = overrides.release ? [overrides.release] : [];
    const rollouts: FleetRollout[] = overrides.activeRollout ? [overrides.activeRollout] : [];
    const vpsEntries: MockVps[] = overrides.vpsList ?? [];
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


    const config: Partial<AppConfig> = {
      dataDir: tempDir,
      fleet: {},
    };

    const service = new FleetService({
      config: config as AppConfig,
      fleetRepository: fleetRepo as FleetRepository,
      vpsRepository: vpsRepo as VpsRepository,
      agentRepository: agentRepo as AgentRepository,
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
      components: ["agent"],
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

});
