import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { KeyService } from "../src/ssh/keyService.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import {
  AgentPresenceReconcilerService,
} from "../src/agents/agent-presence-reconciler.service.js";
import {
  buildAgentPresenceProbeCommand,
  classifyAgentPresence,
} from "../src/agents/agent-lifecycle-remote.js";
import type { VpsRecord } from "../src/vps/vps.models.js";

const vps: VpsRecord = {
  id: "vps-1",
  name: "test",
  host: "203.0.113.10",
  port: 22,
  username: "root",
  kind: "remote",
  managedBy: "user",
  keyProvisionedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeService(stdout: string, state: { status: "online"; lastSeenAt: string }) {
  const marked: string[] = [];
  const agents = {
    listStates: async () => [{ vpsId: vps.id, ...state }],
    getState: async () => ({ vpsId: vps.id, ...state }),
    markAgentAbsent: async (id: string, seen: string) => {
      marked.push(`${id}:${seen}`);
      return true;
    },
  } as unknown as AgentRepository;
  const vpss = { list: async () => [vps], get: async () => vps } as unknown as VpsRepository;
  const keys = { readPrivateKey: async () => "private-key" } as unknown as KeyService;
  const ssh = {
    execCommandStrict: vi.fn(async () => ({ stdout, stderr: "" })),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new AgentPresenceReconcilerService(
    { mode: "local", agentPresenceReconcileEnabled: true } as never,
    agents,
    vpss,
    keys,
    ssh as never,
    new AgentLifecycleCoordinator(),
    audit as never,
  );
  return { service, marked, ssh, audit, agents, vpss };
}

describe("agent presence reconciliation", () => {
  it("marks an online stale state absent only after a conclusive empty probe", async () => {
    const seen = new Date(Date.now() - 300_000).toISOString();
    const { service, marked, audit } = makeService("absent\n", {
      status: "online",
      lastSeenAt: seen,
    });

    await service.runOnce();

    expect(marked).toEqual([`vps-1:${seen}`]);
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it("does not transition on SSH failure or ambiguous probe output", async () => {
    const seen = new Date(Date.now() - 300_000).toISOString();
    const { service, marked } = makeService("unknown\n", {
      status: "online",
      lastSeenAt: seen,
    });

    await service.runOnce();

    expect(marked).toEqual([]);
    const inaccessible = makeService("absent\n", { status: "online", lastSeenAt: seen });
    inaccessible.ssh.execCommandStrict.mockRejectedValueOnce(new Error("SSH unavailable"));
    await inaccessible.service.runOnce();
    expect(inaccessible.marked).toEqual([]);
  });

  it("does not revoke credentials when the probed host identity changed", async () => {
    const seen = new Date(Date.now() - 300_000).toISOString();
    const { service, marked, vpss } = makeService("absent\n", { status: "online", lastSeenAt: seen });
    vpss.get = async () => ({ ...vps, host: "203.0.113.11" });
    await service.runOnce();
    expect(marked).toEqual([]);
  });

  it("does not starve later hosts when older hosts cannot be inspected", async () => {
    const seen = new Date(Date.now() - 300_000).toISOString();
    const { service, ssh, agents, vpss } = makeService("unknown\n", { status: "online", lastSeenAt: seen });
    const hosts = Array.from({ length: 11 }, (_, index) => ({ ...vps, id: `vps-${index}` }));
    agents.listStates = async () => hosts.map((host) => ({ vpsId: host.id, status: "online", lastSeenAt: seen }));
    vpss.list = async () => hosts;
    vpss.get = async (id) => hosts.find((host) => host.id === id);
    await service.runOnce();
    await service.runOnce();
    expect(new Set(ssh.execCommandStrict.mock.calls.map(([host]) => host.id)).size).toBe(11);
  });

  it("blocks a new ingest while reconciliation drains an existing ingest", async () => {
    const lifecycle = new AgentLifecycleCoordinator();
    const releaseIngest = await lifecycle.beginIngest(vps.id);
    const acquiring = lifecycle.tryAcquire(vps.id, "reconcile");
    await expect(lifecycle.beginIngest(vps.id)).rejects.toThrow("Agent lifecycle operation in progress");
    releaseIngest();
    const release = await acquiring;
    release();
    const releaseNext = await lifecycle.beginIngest(vps.id);
    releaseNext();
  });

  it("revokes credentials and clears stale lifecycle state atomically, but preserves a newer heartbeat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-presence-"));
    try {
      const repository = createJsonAgentRepository(join(dir, "agents.json"));
      const seen = new Date(Date.now() - 300_000).toISOString();
      const credential = await repository.createCredential({
        vpsId: vps.id, secretHash: "a".repeat(64), status: "active", scope: "agent",
      });
      await repository.upsertState({ vpsId: vps.id, status: "online", lastSeenAt: seen, lastInstallJobId: "previous-install" });
      expect(await repository.markAgentAbsent(vps.id, new Date().toISOString())).toBe(false);
      expect((await repository.getCredential(credential.id))?.status).toBe("active");
      expect(await repository.markAgentAbsent(vps.id, seen)).toBe(true);
      expect(await repository.getState(vps.id)).toEqual({ vpsId: vps.id, status: "not_installed" });
      expect((await repository.getCredential(credential.id))?.status).toBe("revoked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not accept a heartbeat after reconciliation revokes its credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-presence-fence-"));
    try {
      const repository = createJsonAgentRepository(join(dir, "agents.json"));
      const credential = await repository.createCredential({
        vpsId: vps.id,
        secretHash: "b".repeat(64),
        status: "active",
      });
      const lastSeenAt = new Date(Date.now() - 300_000).toISOString();
      await repository.upsertState({ vpsId: vps.id, status: "online", lastSeenAt });
      expect(await repository.markAgentAbsent(vps.id, lastSeenAt)).toBe(true);
      expect(await repository.acceptHeartbeat({
        credentialId: credential.id,
        vpsId: vps.id,
        lastUsedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        version: "1.0.0",
      })).toBeUndefined();
      expect((await repository.getState(vps.id))?.status).toBe("not_installed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates an install credential and installing checkpoint as one write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-install-fence-"));
    try {
      const repository = createJsonAgentRepository(join(dir, "agents.json"));
      const credential = await repository.createInstallCredential(
        { vpsId: vps.id, secretHash: "c".repeat(64), status: "pending" },
        { vpsId: vps.id, status: "installing", lastInstallJobId: "job-1" },
      );
      expect(credential.status).toBe("pending");
      expect(await repository.getState(vps.id)).toMatchObject({
        status: "installing",
        lastInstallJobId: "job-1",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies only exact probe output and checks alternate managed processes", () => {
    expect(classifyAgentPresence("absent\n")).toBe("absent");
    expect(classifyAgentPresence("absent\nwarning")).toBe("unknown");
    const command = buildAgentPresenceProbeCommand("vps-1");
    expect(command).toContain("pgrep -x vps-agent");
    expect(command).toContain("/etc/systemd/system/vps-agent-");
  });
});
