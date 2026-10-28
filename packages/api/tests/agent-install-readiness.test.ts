import { expect, it } from "vitest";
import { AgentInstallerService } from "../src/agents/agent-installer.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { BundledAgentService } from "../src/local-upgrade/bundled-agent.service.js";
import type { AppConfig } from "../src/config/app-config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState, AgentCredential } from "../src/agents/agent.models.js";

async function installScenario(mode: "new" | "none" | "old") {
  let state: AgentState | undefined;
  const credential = { id: "new", status: "pending" } as AgentCredential;
  let task!: (ctx: unknown) => Promise<void>;
  let succeeded = false;
  let rolledBack = false;
  const binDir = mkdtempSync(join(tmpdir(), "readiness-installer-"));
  const amd64Path = join(binDir, "vps-agent-linux-amd64");
  writeFileSync(amd64Path, buildElf("a".repeat(40), "1.2.3", "amd64"));
  const ssh = {
    makeDirectory: async () => {}, uploadFile: async () => {},
    execCommand: async (_v: unknown, command: string) => {
      if (command.includes("mv -f --")) rolledBack = true;
      return { stdout: command === "echo $HOME" ? "/home/audit" :
        command.includes("uname -m") ? "x86_64" :
        command.startsWith("if mkdir") ? "acquired" :
        command.includes("owned:") ? "none" : "" };
    },
  };
  const service = new AgentInstallerService(...([
    { agentPublicBaseUrl: "https://unreachable.invalid", agentInstallIntervalSeconds: 15 },
    ssh,
    new BundledAgentService({ agentBinaryPath: amd64Path } as unknown as AppConfig),
    {
      createCredential: async () => ({ credential, token: "probe" }),
      createInstallCredential: async () => {
        state = { vpsId: "audit", status: "installing", lastInstallJobId: "job" };
        return { credential, token: "probe", state };
      },
    },
    { getState: async () => state, upsertState: async (s: AgentState) => (state = s),
      getCredential: async () => credential, revokeCredential: async () => { credential.status = "revoked"; },
      revokeOtherActiveAgentCredentials: async () => [] },
    { get: async () => ({ id: "audit", host: "203.0.113.1", port: 22, username: "audit", keyProvisionedAt: "now" }) },
    { readPrivateKey: async () => "key" }, { record: async () => {} },
    { start: (_job: unknown, fn: typeof task) => { task = fn; } },
    { create: async () => ({ id: "job" }), update: async () => ({}) }, new AgentLifecycleCoordinator(),
    { intervalMs: 1, timeoutMs: 3, sleep: async () => {
      if (mode === "none") return;
      const now = new Date().toISOString();
      if (mode === "new") { credential.status = "active"; credential.lastUsedAt = now; }
      state = { vpsId: "audit", status: "online", version: "1.2.3", buildId: "a".repeat(40), lastSeenAt: now };
    } },
  ] as unknown as ConstructorParameters<typeof AgentInstallerService>));
  await service.install("audit", undefined, undefined);
  let error: unknown;
  try { await task({ update: async () => {}, succeed: async () => { succeeded = true; } }); }
  catch (e) { error = e; }
  return { state, credential, succeeded, rolledBack, error };
}

it("requires the new install credential, not an old agent heartbeat", async () => {
  for (const mode of ["none", "old"] as const) {
    const result = await installScenario(mode);
    expect(String(result.error)).toContain("Timed out waiting");
    expect(result.succeeded).toBe(false);
    expect(result.credential.status).toBe("revoked");
    expect(result.state?.status).toBe("failed");
  }
});
it("preserves real ingest identity on successful installation", async () => {
  const result = await installScenario("new");
  expect(result.error).toBeUndefined();
  expect(result.succeeded).toBe(true);
  expect(result.state).toMatchObject({ status: "online", version: "1.2.3", buildId: "a".repeat(40) });
  expect(result.state?.lastSeenAt).toBe(result.credential.lastUsedAt);
});

function buildElf(buildId: string, version: string, arch: "amd64" | "arm64"): Buffer {
  const buf = Buffer.alloc(128);
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; // ELF magic
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // little-endian
  buf[7] = 0; // System V OS ABI
  buf.writeUInt16LE(arch === "arm64" ? 0xb7 : 0x3e, 18);
  buf.write(`version.Build=${buildId}\0`, 64);
  buf.write(`version.Value=${version}\0`, 96);
  return buf;
}

it("uploads the arm64 binary bytes for an arm64 host, not the amd64 artifact", async () => {
  const uploads: { path: string; content: unknown }[] = [];
  const buildId = "b".repeat(40);
  const arm64Bytes = buildElf(buildId, "1.2.3", "arm64");
  const amd64Bytes = buildElf(buildId, "1.2.3", "amd64");
  const binDir = mkdtempSync(join(tmpdir(), "arm64-installer-"));
  writeFileSync(join(binDir, "vps-agent-linux-amd64"), amd64Bytes);
  writeFileSync(join(binDir, "vps-agent-linux-arm64"), arm64Bytes);
  let state: AgentState | undefined;
  const credential = { id: "new", status: "pending" } as AgentCredential;
  let task!: (ctx: unknown) => Promise<void>;
  const ssh = {
    makeDirectory: async () => {},
    uploadFile: async (_v: unknown, path: string, content: unknown) => {
      uploads.push({ path, content });
    },
    execCommand: async (_v: unknown, command: string) => {
      return { stdout: command === "echo $HOME" ? "/home/audit" :
        command.includes("uname -m") ? "aarch64" :
        command.startsWith("if mkdir") ? "acquired" :
        command.includes("owned:") ? "none" : "" };
    },
  };
  const bundled = new BundledAgentService({ agentBinaryPath: join(binDir, "vps-agent-linux-amd64") } as AppConfig);
  const service = new AgentInstallerService(...([
    { agentPublicBaseUrl: "https://unreachable.invalid", agentInstallIntervalSeconds: 15 },
    ssh,
    bundled,
    {
      createCredential: async () => ({ credential, token: "probe" }),
      createInstallCredential: async () => {
        state = { vpsId: "audit", status: "installing", lastInstallJobId: "job" };
        return { credential, token: "probe", state };
      },
    },
    { getState: async () => state, upsertState: async (s: AgentState) => (state = s),
      getCredential: async () => credential, revokeCredential: async () => { credential.status = "revoked"; },
      revokeOtherActiveAgentCredentials: async () => [] },
    { get: async () => ({ id: "audit", host: "203.0.113.1", port: 22, username: "audit", keyProvisionedAt: "now" }) },
    { readPrivateKey: async () => "key" }, { record: async () => {} },
    { start: (_job: unknown, fn: typeof task) => { task = fn; } },
    { create: async () => ({ id: "job" }), update: async () => ({}) }, new AgentLifecycleCoordinator(),
    { intervalMs: 1, timeoutMs: 3, sleep: async () => {
      credential.status = "active"; credential.lastUsedAt = new Date().toISOString();
      state = { vpsId: "audit", status: "online", version: "1.2.3", buildId, lastSeenAt: new Date().toISOString() };
    } },
  ] as unknown as ConstructorParameters<typeof AgentInstallerService>));
  try {
    await service.install("audit", undefined, undefined);
    await task({ update: async () => {}, succeed: async () => {} });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
  const uploaded = uploads.find((u) => u.path.includes("vps-agent.stage-"));
  expect(uploaded).toBeDefined();
  expect(uploaded!.content).toEqual(arm64Bytes);
  // amd64 bytes were on disk in the same fixture dir and would have been
  // uploaded had the installer blindly reused the configured amd64 path.
  expect(Buffer.compare(amd64Bytes, arm64Bytes)).not.toBe(0);
});

it("retires prior agent-scope credentials only after successful fresh observation cutover", async () => {
  let state: AgentState | undefined;
  const credential = { id: "new-cred-123", status: "pending", scope: "agent" } as AgentCredential;
  let task!: (ctx: unknown) => Promise<void>;
  let revokedWithKeep: string | undefined;
  let auditRecord: { metadata?: { revokedCredentialIds?: string[] } } | undefined;
  const binDir = mkdtempSync(join(tmpdir(), "readiness-revoke-"));
  const amd64Path = join(binDir, "vps-agent-linux-amd64");
  writeFileSync(amd64Path, buildElf("c".repeat(40), "1.2.3", "amd64"));
  const ssh = {
    makeDirectory: async () => {}, uploadFile: async () => {},
    execCommand: async (_v: unknown, command: string) => ({
      stdout: command === "echo $HOME" ? "/home/audit" :
        command.includes("uname -m") ? "x86_64" :
        command.startsWith("if mkdir") ? "acquired" :
        command.includes("owned:") ? "none" : "",
    }),
  };
  const service = new AgentInstallerService(...([
    { agentPublicBaseUrl: "https://unreachable.invalid", agentInstallIntervalSeconds: 15 },
    ssh,
    new BundledAgentService({ agentBinaryPath: amd64Path } as unknown as AppConfig),
    {
      createCredential: async () => ({ credential, token: "probe" }),
      createInstallCredential: async () => {
        state = { vpsId: "audit", status: "installing", lastInstallJobId: "job" };
        return { credential, token: "probe", state };
      },
    },
    {
      getState: async () => state,
      upsertState: async (s: AgentState) => (state = s),
      getCredential: async () => credential,
      revokeCredential: async () => { credential.status = "revoked"; },
      revokeOtherActiveAgentCredentials: async (_vpsId: string, keepId: string) => {
        revokedWithKeep = keepId;
        return ["old-cred-1", "old-cred-2"];
      },
    },
    { get: async () => ({ id: "audit", host: "203.0.113.1", port: 22, username: "audit", keyProvisionedAt: "now" }) },
    { readPrivateKey: async () => "key" },
    { record: async (r: unknown) => { auditRecord = r; } },
    { start: (_job: unknown, fn: typeof task) => { task = fn; } },
    { create: async () => ({ id: "job" }), update: async () => ({}) },
    new AgentLifecycleCoordinator(),
    { intervalMs: 1, timeoutMs: 3, sleep: async () => {
      const now = new Date().toISOString();
      credential.status = "active";
      credential.lastUsedAt = now;
      state = { vpsId: "audit", status: "online", version: "1.2.3", buildId: "c".repeat(40), lastSeenAt: now };
    } },
  ] as unknown as ConstructorParameters<typeof AgentInstallerService>));
  try {
    await service.install("audit", undefined, undefined);
    await task({ update: async () => {}, succeed: async () => {} });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
  expect(revokedWithKeep).toBe(credential.id);
  expect(state?.status).toBe("online");
  expect(auditRecord?.metadata?.revokedCredentialIds).toEqual([
    "old-cred-1",
    "old-cred-2",
  ]);
});

it("rolls back old binary and config if revokeOtherActiveAgentCredentials fails before cutover commits", async () => {
  let state: AgentState | undefined;
  const credential = { id: "new-cred-fail", status: "pending", scope: "agent" } as AgentCredential;
  let task!: (ctx: unknown) => Promise<void>;
  let rolledBack = false;
  const binDir = mkdtempSync(join(tmpdir(), "readiness-rollback-"));
  const amd64Path = join(binDir, "vps-agent-linux-amd64");
  writeFileSync(amd64Path, buildElf("d".repeat(40), "1.2.3", "amd64"));
  const ssh = {
    makeDirectory: async () => {}, uploadFile: async () => {},
    execCommand: async (_v: unknown, command: string) => {
      if (command.includes("mv -f --")) rolledBack = true;
      return {
        stdout: command === "echo $HOME" ? "/home/audit" :
          command.includes("uname -m") ? "x86_64" :
          command.startsWith("if mkdir") ? "acquired" :
          command.includes("owned:") ? "none" :
          command.includes("printf binary") ? "binaryconfig" : "",
      };
    },
  };
  const service = new AgentInstallerService(...([
    { agentPublicBaseUrl: "https://unreachable.invalid", agentInstallIntervalSeconds: 15 },
    ssh,
    new BundledAgentService({ agentBinaryPath: amd64Path } as unknown as AppConfig),
    {
      createCredential: async () => ({ credential, token: "probe" }),
      createInstallCredential: async () => {
        state = { vpsId: "audit", status: "installing", lastInstallJobId: "job" };
        return { credential, token: "probe", state };
      },
    },
    {
      getState: async () => state,
      upsertState: async (s: AgentState) => (state = s),
      getCredential: async () => credential,
      revokeCredential: async () => { credential.status = "revoked"; },
      revokeOtherActiveAgentCredentials: async () => {
        throw new Error("DB connection failure during atomic revoke");
      },
    },
    { get: async () => ({ id: "audit", host: "203.0.113.1", port: 22, username: "audit", keyProvisionedAt: "now" }) },
    { readPrivateKey: async () => "key" },
    { record: async () => {} },
    { start: (_job: unknown, fn: typeof task) => { task = fn; } },
    { create: async () => ({ id: "job" }), update: async () => ({}) },
    new AgentLifecycleCoordinator(),
    { intervalMs: 1, timeoutMs: 3, sleep: async () => {
      const now = new Date().toISOString();
      credential.status = "active";
      credential.lastUsedAt = now;
      state = { vpsId: "audit", status: "online", version: "1.2.3", buildId: "d".repeat(40), lastSeenAt: now };
    } },
  ] as unknown as ConstructorParameters<typeof AgentInstallerService>));
  let error: unknown;
  try {
    await service.install("audit", undefined, undefined);
    await task({ update: async () => {}, succeed: async () => {} });
  } catch (e) {
    error = e;
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
  expect(String(error)).toContain("DB connection failure during atomic revoke");
  expect(rolledBack).toBe(true);
  expect(credential.status).toBe("revoked");
  expect(state?.status).toBe("failed");
});

it("treats cutover as irreversible once revokeOtherActiveAgentCredentials succeeds, never restoring old config", async () => {
  let state: AgentState | undefined;
  const credential = { id: "new-cred-irreversible", status: "pending", scope: "agent" } as AgentCredential;
  let task!: (ctx: unknown) => Promise<void>;
  let rolledBack = false;
  const binDir = mkdtempSync(join(tmpdir(), "readiness-irreversible-"));
  const amd64Path = join(binDir, "vps-agent-linux-amd64");
  writeFileSync(amd64Path, buildElf("e".repeat(40), "1.2.3", "amd64"));
  const ssh = {
    makeDirectory: async () => {}, uploadFile: async () => {},
    execCommand: async (_v: unknown, command: string) => {
      if (command.includes("mv -f --")) rolledBack = true;
      return {
        stdout: command === "echo $HOME" ? "/home/audit" :
          command.includes("uname -m") ? "x86_64" :
          command.startsWith("if mkdir") ? "acquired" :
          command.includes("owned:") ? "none" :
          command.includes("printf binary") ? "binaryconfig" : "",
      };
    },
  };
  let revokeCalled = false;
  const service = new AgentInstallerService(...([
    { agentPublicBaseUrl: "https://unreachable.invalid", agentInstallIntervalSeconds: 15 },
    ssh,
    new BundledAgentService({ agentBinaryPath: amd64Path } as unknown as AppConfig),
    {
      createCredential: async () => ({ credential, token: "probe" }),
      createInstallCredential: async () => {
        state = { vpsId: "audit", status: "installing", lastInstallJobId: "job" };
        return { credential, token: "probe", state };
      },
    },
    {
      getState: async () => state,
      upsertState: async (s: AgentState) => (state = s),
      getCredential: async () => credential,
      revokeCredential: async () => { credential.status = "revoked"; },
      revokeOtherActiveAgentCredentials: async () => {
        revokeCalled = true;
        return ["old-1"];
      },
    },
    { get: async () => ({ id: "audit", host: "203.0.113.1", port: 22, username: "audit", keyProvisionedAt: "now" }) },
    { readPrivateKey: async () => "key" },
    { record: async (r: { action?: string }) => {
      // Audit record fails after cutover
      if (r.action === "agent.install.success") throw new Error("Audit storage down post-cutover");
    } },
    { start: (_job: unknown, fn: typeof task) => { task = fn; } },
    { create: async () => ({ id: "job" }), update: async () => ({}) },
    new AgentLifecycleCoordinator(),
    { intervalMs: 1, timeoutMs: 3, sleep: async () => {
      const now = new Date().toISOString();
      credential.status = "active";
      credential.lastUsedAt = now;
      state = { vpsId: "audit", status: "online", version: "1.2.3", buildId: "e".repeat(40), lastSeenAt: now };
    } },
  ] as unknown as ConstructorParameters<typeof AgentInstallerService>));
  let error: unknown;
  try {
    await service.install("audit", undefined, undefined);
    await task({ update: async () => {}, succeed: async () => {} });
  } catch (e) {
    error = e;
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
  expect(String(error)).toContain("Audit storage down post-cutover");
  expect(revokeCalled).toBe(true);
  // Crucial: cutover is irreversible, so old config is NOT restored
  expect(rolledBack).toBe(false);
  // The new credential is NOT revoked
  expect(credential.status).toBe("active");
  // The new agent remains online
  expect(state?.status).toBe("online");
});
