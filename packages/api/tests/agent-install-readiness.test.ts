import { expect, it } from "vitest";
import { AgentInstallerService } from "../src/agents/agent-installer.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import type { AgentState, AgentCredential } from "../src/agents/agent.models.js";

async function installScenario(mode: "new" | "none" | "old") {
  let state: AgentState | undefined;
  const credential = { id: "new", status: "pending" } as AgentCredential;
  let task!: (ctx: unknown) => Promise<void>;
  let succeeded = false;
  let rolledBack = false;
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
    { agentPublicBaseUrl: "https://unreachable.invalid", agentBinaryPath: "package.json", agentInstallIntervalSeconds: 15 },
    ssh,
    { createCredential: async () => ({ credential, token: "probe" }) },
    { getState: async () => state, upsertState: async (s: AgentState) => (state = s),
      getCredential: async () => credential, revokeCredential: async () => { credential.status = "revoked"; } },
    { get: async () => ({ id: "audit", host: "203.0.113.1", port: 22, username: "audit", keyProvisionedAt: "now" }) },
    { readPrivateKey: async () => "key" }, { record: async () => {} },
    { start: (_job: unknown, fn: typeof task) => { task = fn; } },
    { create: async () => ({ id: "job" }) }, new AgentLifecycleCoordinator(),
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
