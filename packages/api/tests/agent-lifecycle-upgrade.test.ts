import { ConflictException } from "@nestjs/common";
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

  it("allows update fence when host is busy with activities, blocks new activity, and drains accounting", async () => {
    const lifecycle = new AgentLifecycleCoordinator();
    const releaseJob = lifecycle.tryAcquireActivity("vps-2", "job");
    const releaseTerm = lifecycle.tryAcquireActivity("vps-2", "terminal");

    // Update acquires immediately even with running activities
    const releaseUpdate = await lifecycle.tryAcquire("vps-2", "update");
    expect(lifecycle.isLifecycleActive("vps-2")).toBe(true);

    // Blocks new activity during update
    expect(() => lifecycle.tryAcquireActivity("vps-2", "job")).toThrow(ConflictException);

    // Ongoing activities release cleanly
    releaseJob();
    releaseTerm();

    // New activity still blocked while update fence is held
    expect(() => lifecycle.tryAcquireActivity("vps-2", "job")).toThrow(ConflictException);

    releaseUpdate();
    expect(lifecycle.isLifecycleActive("vps-2")).toBe(false);

    // Activity can be acquired again
    const releaseNewJob = lifecycle.tryAcquireActivity("vps-2", "job");
    releaseNewJob();
  });
});
