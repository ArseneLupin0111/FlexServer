import { expect, it } from "vitest";
import { VpsService } from "../src/vps/vps.service.js";
import { AgentUninstallerService } from "../src/agents/agent-uninstaller.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { createVpsCleanup } from "../src/persistence/vps-cleanup.js";

it.each(["queued", "running"])("rejects %s jobs before teardown and allows retry", async (status) => {
  const calls: string[] = [];
  let exists = true;
  let state = { vpsId: "audit", status: "online" };
  const credential = { status: "active" };
  const vps = { id: "audit", kind: "remote", managedBy: "user", keyProvisionedAt: "now" };
  const store = { get: async () => exists ? vps : undefined, delete: async () => { exists = false; return true; } };
  const keys = { readPrivateKey: async () => "key", removeKeyPair: async () => { calls.push("key removed"); } };
  const agent = { getState: async () => state, listCredentialsByVps: async () => [credential],
    revokeCredential: async () => { calls.push("revoke"); credential.status = "revoked"; return credential; },
    upsertState: async (s: typeof state) => { state = s; }, deleteVpsData: async () => { calls.push("purge"); } };
  const jobs = { list: async () => [{ vpsId: "audit", status }], deleteByVps: async () => {} };
  const cleanup = createVpsCleanup(...([agent, jobs, { deleteByVps: async () => {} },
    { cleanupForVps: async () => {} }, { deleteByVps: async () => {} }, { deleteByVps: async () => {} },
    { deleteByVpsId: async () => {} }, { closeByVps: async () => {} }, { closeByVps: () => {} }
  ] as unknown as Parameters<typeof createVpsCleanup>));
  const ssh = { execCommand: async (_v: unknown, cmd: string) => {
    calls.push("remote");
    return { stdout: cmd === "echo $HOME" ? "/home/audit" : cmd.includes("echo removed") ? "removed" : "" };
  } };
  const audit = { record: async () => {} };
  const lifecycle = new AgentLifecycleCoordinator();
  const uninstaller = new AgentUninstallerService(...([{}, ssh, {}, agent, store, keys, audit, {}, {}, lifecycle] as unknown as ConstructorParameters<typeof AgentUninstallerService>));
  const service = new VpsService(...([store, keys, ssh, audit, { mode: "local" }, {}, uninstaller, agent, {}, undefined, undefined, undefined, cleanup, lifecycle] as unknown as ConstructorParameters<typeof VpsService>));
  await expect(service.delete("audit")).rejects.toThrow("Wait for active server jobs");
  expect(calls).toEqual([]);
  expect(exists).toBe(true);
  expect(state.status).toBe("online");
  expect(credential.status).toBe("active");
  status = "succeeded";
  await service.delete("audit");
  expect(exists).toBe(false);
  expect(calls).toContain("remote");
  expect(credential.status).toBe("revoked");
  expect(calls.indexOf("key removed")).toBeGreaterThan(calls.indexOf("revoke"));
  expect(calls).toContain("purge");
});
