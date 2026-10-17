import { expect, it } from "vitest";
import { VpsService } from "../src/vps/vps.service.js";
import { AgentUninstallerService } from "../src/agents/agent-uninstaller.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { createVpsCleanup } from "../src/persistence/vps-cleanup.js";

type HarnessOptions = {
  jobStatus: "queued" | "running" | "succeeded";
  rowExists?: boolean;
  vps?: { keyProvisionedAt?: string };
  state?: { vpsId: string; status: string };
  credentials?: Array<{ status: string }>;
};

// Real VpsService/AgentUninstallerService/createVpsCleanup over stubbed
// repositories, recording every side effect by name so ordering is assertable.
function createHarness(options: HarnessOptions) {
  const calls: string[] = [];
  let exists = options.rowExists ?? true;
  let jobStatus = options.jobStatus;
  let state = options.state;
  const credentials = options.credentials ?? [];
  const vps = { id: "audit", kind: "remote", managedBy: "user", keyProvisionedAt: "now", ...options.vps };
  const store = {
    get: async () => (exists ? vps : undefined),
    delete: async () => { calls.push("row deleted"); exists = false; return true; },
  };
  const keys = {
    readPrivateKey: async () => { calls.push("read key"); return "key"; },
    removeKeyPair: async () => { calls.push("key removed"); },
  };
  const agent = {
    getState: async () => state,
    getSystemInfo: async () => undefined,
    listCredentialsByVps: async () => credentials,
    revokeCredential: async () => {
      calls.push("revoke");
      const credential = credentials[0];
      if (credential) credential.status = "revoked";
      return credential;
    },
    upsertState: async (next: { vpsId: string; status: string }) => {
      calls.push("checkpoint");
      state = next;
      return next;
    },
    deleteVpsData: async () => { calls.push("purge"); },
  };
  const jobs = {
    list: async () => [{ vpsId: "audit", status: jobStatus }],
    deleteByVps: async () => { calls.push("jobs purged"); },
  };
  const cleanup = createVpsCleanup(...([agent, jobs, { deleteByVps: async () => {} },
    { cleanupForVps: async () => {} }, { deleteByVps: async () => {} }, { deleteByVps: async () => {} },
    { deleteByVpsId: async () => {} }, { closeByVps: async () => {} }, { closeByVps: () => {} }
  ] as unknown as Parameters<typeof createVpsCleanup>));
  const ssh = { execCommand: async (_v: unknown, cmd: string) => {
    calls.push("remote");
    return { stdout: cmd === "echo $HOME" ? "/home/audit" : cmd.includes("echo removed") ? "removed" : "" };
  } };
  const audit = { record: async () => { calls.push("audit:vps.delete"); } };
  const lifecycle = new AgentLifecycleCoordinator();
  const uninstaller = new AgentUninstallerService(...([{}, ssh, {}, agent, store, keys, audit, {}, {}, lifecycle] as unknown as ConstructorParameters<typeof AgentUninstallerService>));
  const service = new VpsService(...([store, keys, ssh, audit, { mode: "local" }, {}, uninstaller, agent, {}, undefined, undefined, undefined, cleanup, lifecycle] as unknown as ConstructorParameters<typeof VpsService>));
  return {
    service,
    calls,
    credentials,
    lifecycle,
    rowExists: () => exists,
    stateStatus: () => state?.status,
    settleJobs: () => { jobStatus = "succeeded"; },
  };
}

it.each(["queued", "running"] as const)("rejects %s jobs before teardown and allows retry", async (jobStatus) => {
  const harness = createHarness({
    jobStatus,
    state: { vpsId: "audit", status: "online" },
    credentials: [{ status: "active" }],
  });
  await expect(harness.service.delete("audit")).rejects.toThrow("Wait for active server jobs");
  expect(harness.calls).toEqual([]);
  expect(harness.rowExists()).toBe(true);
  expect(harness.stateStatus()).toBe("online");
  expect(harness.credentials[0].status).toBe("active");
  expect(harness.lifecycle.isLifecycleActive("audit")).toBe(false);

  harness.settleJobs();
  await harness.service.delete("audit");
  const { calls } = harness;
  expect(harness.rowExists()).toBe(false);
  expect(harness.credentials[0].status).toBe("revoked");
  expect(calls).toContain("remote");
  expect(calls.indexOf("revoke")).toBeGreaterThan(calls.indexOf("remote"));
  expect(calls.indexOf("checkpoint")).toBeGreaterThan(calls.indexOf("revoke"));
  expect(calls.indexOf("key removed")).toBeGreaterThan(calls.indexOf("checkpoint"));
  expect(calls.indexOf("row deleted")).toBeGreaterThan(calls.indexOf("key removed"));
  expect(calls.indexOf("purge")).toBeGreaterThan(calls.indexOf("row deleted"));
  expect(calls.indexOf("audit:vps.delete")).toBeGreaterThan(calls.indexOf("purge"));
});

it("deletes an untouched server without remote teardown", async () => {
  const harness = createHarness({
    jobStatus: "succeeded",
    vps: { keyProvisionedAt: undefined },
  });
  await harness.service.delete("audit");
  const { calls } = harness;
  expect(calls).not.toContain("remote");
  expect(calls).not.toContain("read key");
  expect(calls).not.toContain("revoke");
  expect(calls).toContain("checkpoint");
  expect(calls.indexOf("key removed")).toBeGreaterThan(calls.indexOf("checkpoint"));
  expect(calls).toContain("purge");
  expect(calls).toContain("audit:vps.delete");
  expect(harness.rowExists()).toBe(false);
});

it("resumes a checkpointed removal without repeating remote teardown", async () => {
  const harness = createHarness({
    jobStatus: "succeeded",
    state: { vpsId: "audit", status: "not_installed" },
    credentials: [{ status: "revoked" }],
  });
  await harness.service.delete("audit");
  const { calls } = harness;
  expect(calls).not.toContain("remote");
  expect(calls).not.toContain("read key");
  expect(calls).not.toContain("revoke");
  expect(calls).toContain("checkpoint");
  expect(calls).toContain("key removed");
  expect(calls).toContain("purge");
  expect(calls).toContain("audit:vps.delete");
  expect(harness.rowExists()).toBe(false);
});

it("finishes cleanup when a previous attempt already removed the row", async () => {
  const harness = createHarness({ jobStatus: "succeeded", rowExists: false });
  await harness.service.delete("audit");
  const { calls } = harness;
  expect(calls).not.toContain("remote");
  expect(calls).not.toContain("read key");
  expect(calls).not.toContain("revoke");
  expect(calls).not.toContain("checkpoint");
  expect(calls).toContain("key removed");
  expect(calls).toContain("purge");
  expect(calls).toContain("audit:vps.delete");
});
