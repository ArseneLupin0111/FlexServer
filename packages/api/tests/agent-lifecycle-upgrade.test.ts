import { describe, expect, it } from "vitest";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";

describe("AgentLifecycleCoordinator upgrade", () => {
  it("permits ingest throughout upgrade and blocks a second lifecycle operation", async () => {
    const lifecycle = new AgentLifecycleCoordinator();
    const releaseUpgrade = await lifecycle.tryAcquire("vps-1", "upgrade");
    const releaseIngest = await lifecycle.beginIngest("vps-1");
    expect(lifecycle.isLifecycleActive("vps-1")).toBe(true);
    expect(lifecycle.isUninstalling("vps-1")).toBe(false);
    await expect(lifecycle.tryAcquire("vps-1", "install")).rejects.toThrow(/already in progress/i);
    releaseIngest();
    releaseUpgrade();
    const releaseRetry = await lifecycle.tryAcquire("vps-1", "upgrade");
    releaseRetry();
  });

});
