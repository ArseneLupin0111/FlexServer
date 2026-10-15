import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentUpgraderService } from "../src/agents/agent-upgrader.service.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { AgentState } from "../src/agents/agent.models.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function fixture(options: { lock?: string; ownership?: string | string[]; observations?: AgentState[]; getState?: (context: { phase: string; callCount: number }) => AgentState; versionOut?: string; initial?: Partial<AgentState> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agent-upgrade-")); dirs.push(dir);
  const binaryPath = join(dir, "candidate"); await writeFile(binaryPath, "candidate-binary");
  const vps = { id: "vps-1", name: "remote", host: "203.0.113.2", port: 22, username: "root", keyProvisionedAt: "2026-01-01T00:00:00Z" };
  const initial: AgentState = { vpsId: vps.id, status: "online", version: "1.0.0", lastSeenAt: "2026-01-01T00:00:00.000Z", ...options.initial };
  const observations = [...(options.observations ?? [])];
  let currentPhase = "initial";
  let callCount = 0;
  const agents = {
    getState: vi.fn(async () => {
      callCount++;
      if (options.getState) return options.getState({ phase: currentPhase, callCount });
      return observations.shift() ?? initial;
    }),
    createCredential: vi.fn(), updateCredential: vi.fn(), revokeCredential: vi.fn(),
  };
  const commands: string[] = [];
  const ownerships = Array.isArray(options.ownership) ? [...options.ownership] : undefined;
  const ssh = {
    uploadFile: vi.fn(async (..._args: unknown[]) => undefined),
    execCommand: vi.fn(async (_vps: unknown, command: string) => {
      commands.push(command);
      if (command.includes("$HOME")) return { stdout: "/home/deploy\n", stderr: "" };
      if (command.includes("mkdir --") && command.includes("lifecycle.lock")) return { stdout: options.lock ?? "acquired", stderr: "" };
      if (command.endsWith(" -version")) return { stdout: options.versionOut ?? "2.0.0\n", stderr: "" };
      if (command.includes("_owned=''") || command.includes("printf 'owned:%s:%s")) {
        const out = ownerships ? (ownerships.shift() ?? "owned:42:9001\n") : (options.ownership ?? "owned:42:9001\n");
        return { stdout: out, stderr: "" };
      }
      if (command.includes("_pid=$(cat") && command.includes("printf '%s")) return { stdout: "43\n", stderr: "" };
      return { stdout: "", stderr: "" };
    }),
  };
  let task: ((ctx: any) => Promise<void>) | undefined;
  const runner = { start: vi.fn((_job, next) => { task = next; }) };
  const jobs = { create: vi.fn(async () => ({ id: "job-1", vpsId: vps.id, type: "upgrade-agent", status: "queued", progress: 0 })), update: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };
  const lifecycle = new AgentLifecycleCoordinator();
  const config = { mode: "local", agentBinaryPath: binaryPath, agentInstallIntervalSeconds: 30 } as AppConfig;
  const service = new AgentUpgraderService(config, ssh as any, agents as any, { get: vi.fn(async () => vps) } as any,
    { readPrivateKey: vi.fn(async () => "private-key") } as any, audit as any, runner as any, jobs as any, lifecycle,
    { intervalMs: 1, timeoutMs: 3, sleep: async () => undefined });
  const stopPid = vi.spyOn(service as unknown as { stopPid: (...args: unknown[]) => Promise<void> }, "stopPid");
  const result = await service.upgrade(vps.id);
  const ctx = { update: vi.fn(async (phase: string) => { currentPhase = phase; }), succeed: vi.fn(async () => { currentPhase = "succeeded"; }) };
  return { service, result, task: () => task!(ctx), ctx, ssh, commands, agents, lifecycle, initial, stopPid };
}

describe("AgentUpgraderService", () => {
  it("rejects a remote lock conflict before upload and releases lifecycle", async () => {
    const f = await fixture({ lock: "conflict" });
    await expect(f.task()).rejects.toThrow(/lock is already held/i);
    expect(f.ssh.uploadFile).not.toHaveBeenCalled();
    const release = await f.lifecycle.tryAcquire("vps-1", "upgrade"); release();
  });

  it("uses a post-preflight baseline and requires a newer candidate observation", async () => {
    const preflight = { ...((await fixture()).initial), version: "2.0.0", lastSeenAt: "2026-01-01T00:00:01.000Z" };
    const success = { ...preflight, lastSeenAt: "2026-01-01T00:00:02.000Z" };
    const f = await fixture({ observations: [fState("1.0.0", 0), preflight, preflight, success] });
    await f.task();
    expect(f.ctx.succeed).toHaveBeenCalledWith("complete");
    const preflightCmd = f.commands.findIndex((c) => c.includes(" -validate-config"));
    expect(preflightCmd).toBeGreaterThan(-1);
    const identify = f.commands.findIndex((c) => c.includes("_matches=0"));
    const stop = f.commands.findIndex((c) => c.includes("kill -TERM") && c.includes("owns()"));
    const swap = f.commands.findIndex((c) => c.includes("vps-agent.backup-"));
    const start = f.commands.findIndex((c) => c.includes("systemctl start"));
    expect([preflightCmd, identify, stop, swap, start]).toEqual([...([preflightCmd, identify, stop, swap, start])].sort((a, b) => a - b));
    expect(f.agents.createCredential).not.toHaveBeenCalled();
    expect(f.agents.updateCredential).not.toHaveBeenCalled();
    expect(f.agents.revokeCredential).not.toHaveBeenCalled();
    expect(f.ssh.uploadFile.mock.calls.every((call) => !String(call[1]).endsWith("config.json"))).toBe(true);
  });

  it("does not accept the staged preflight ingest as startup proof and rolls back", async () => {
    const preflight = fState("2.0.0", 1);
    const f = await fixture({ observations: [fState("1.0.0", 0), preflight, preflight, preflight, preflight, fState("1.0.0", 2), fState("1.0.0", 3)] });
    await expect(f.task()).rejects.toThrow(/Timed out waiting/i);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(true);
  });

  it("preserves recovery artifacts and reports a sanitized rollback failure", async () => {
    const preflight = fState("2.0.0", 1);
    const f = await fixture({ observations: [fState("1.0.0", 0), preflight, preflight, preflight, preflight] });
    // Rollback never observes a newer old-version ingest.
    await expect(f.task()).rejects.toThrow(/recovery artifacts were preserved/i);
    const lockRelease = f.commands.filter((c) => c.includes("rmdir --") && c.includes("lifecycle.lock"));
    expect(lockRelease).toHaveLength(1);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(true);
  });

  it("refuses ambiguous ownership without signaling or swapping", async () => {
    const f = await fixture({ ownership: "ambiguous\n" });
    await expect(f.task()).rejects.toThrow(/ownership is missing or ambiguous/i);
    expect(f.stopPid).not.toHaveBeenCalled();
    expect(f.commands.some((c) => c.includes("backup-") && c.includes("mv --"))).toBe(false);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(true);
  });

  it("upgrades successfully when managed process is genuinely absent (stopped agent)", async () => {
    const preflight = { ...((await fixture()).initial), version: "2.0.0", lastSeenAt: "2026-01-01T00:00:01.000Z" };
    const success = { ...preflight, lastSeenAt: "2026-01-01T00:00:02.000Z" };
    const f = await fixture({
      ownership: "none\n",
      observations: [fState("1.0.0", 0), preflight, preflight, success],
    });
    await f.task();
    expect(f.ctx.succeed).toHaveBeenCalledWith("complete");
    expect(f.ctx.update).not.toHaveBeenCalledWith("stopping", 50);
    expect(f.stopPid).not.toHaveBeenCalled();
    expect(f.commands.some((c) => c.includes("vps-agent.backup-") && c.includes("mv --"))).toBe(true);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("backup-"))).toBe(true);
  });

  it("rolls back successfully when candidate process died without leaving a live process", async () => {
    const preflight = fState("2.0.0", 1);
    const f = await fixture({
      ownership: ["owned:42:9001\n", "none\n"],
      observations: [
        fState("1.0.0", 0),
        preflight,
        preflight,
        preflight,
        preflight,
        fState("1.0.0", 2),
        fState("1.0.0", 3),
      ],
    });
    await expect(f.task()).rejects.toThrow(/Timed out waiting/i);
    expect(f.stopPid).toHaveBeenCalledTimes(1);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(true);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(true);
  });

  it("refuses ambiguous ownership during rollback, preserving live binary and artifacts", async () => {
    const preflight = fState("2.0.0", 1);
    const f = await fixture({
      ownership: ["owned:42:9001\n", "ambiguous\n"],
      observations: [
        fState("1.0.0", 0),
        preflight,
        preflight,
        preflight,
        preflight,
      ],
    });
    await expect(f.task()).rejects.toThrow(/recovery artifacts were preserved/i);
    expect(f.stopPid).toHaveBeenCalledTimes(1);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(false);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(false);
  });

  it("provisions Docker v2 state with the staged binary before preflight and start", async () => {
    const f = await fixture({ observations: [fState("1.0.0", 0), fState("2.0.0", 1), fState("2.0.0", 2), fState("2.0.0", 3)] });
    await f.task();
    const provision = f.commands.findIndex((c) => c.includes("-provision-docker-state"));
    const preflightCmd = f.commands.findIndex((c) => c.includes(" -validate-config"));
    const stop = f.commands.findIndex((c) => c.includes("kill -TERM") && c.includes("owns()"));
    const swap = f.commands.findIndex((c) => c.includes("vps-agent.backup-"));
    const start = f.commands.findIndex((c) => c.includes("systemctl start"));
    expect(provision).toBeGreaterThanOrEqual(0);
    // Provisioning gates everything: preflight, stop, swap, and start.
    expect([provision, preflightCmd, stop, swap, start]).toEqual([...([provision, preflightCmd, stop, swap, start])].sort((a, b) => a - b));
    const provisionCmd = f.commands[provision];
    // Uses the staged binary and the shared agent state directory.
    expect(provisionCmd).toContain("vps-agent.stage-");
    expect(provisionCmd).toContain("/.vps-manager-agent/");
    // Never rotates an existing identity: identity-loss guard precedes any provision call.
    expect(provisionCmd.indexOf("refusing to rotate the installation identity")).toBeGreaterThan(-1);
    expect(provisionCmd.indexOf("-provision-docker-state")).toBeGreaterThan(
      provisionCmd.indexOf("refusing to rotate the installation identity"),
    );
    // Root/passwdless-sudo fail-closed guard precedes any provision call.
    expect(provisionCmd.indexOf("passwordless sudo")).toBeLessThan(
      provisionCmd.indexOf("-provision-docker-state"),
    );
    // Final verification pass validates with the runtime owner uid.
    expect(provisionCmd).toContain("-docker-runtime-owner-uid \"$_u\"");
  });

  it("upgrades candidate with version and build ID when fresh heartbeat matches both", async () => {
    const buildId = "af467d23a1d5a3d84f078dc1016f3a7a16f344a0";
    const versionOut = `0.1.0+${buildId}\n`;
    const f = await fixture({
      versionOut,
      observations: [
        fState("1.0.0", 0),
        fState("1.0.0", 0),
        fState("0.1.0", 1, buildId),
        fState("0.1.0", 2, buildId),
      ],
    });
    await f.task();
    expect(f.ctx.succeed).toHaveBeenCalledWith("complete");
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("backup-"))).toBe(true);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(false);
  });

  it("rejects observation with same semantic version but wrong build ID and rolls back", async () => {
    const candidateBuildId = "af467d23a1d5a3d84f078dc1016f3a7a16f344a0";
    const wrongBuildId = "0000000000000000000000000000000000000000";
    const versionOut = `0.1.0+${candidateBuildId}\n`;
    const wrongState = fState("0.1.0", 1, wrongBuildId);
    const f = await fixture({
      versionOut,
      observations: [
        fState("1.0.0", 0), // prior (upgrade)
        fState("1.0.0", 0), // postStopBaseline
        wrongState,         // candidate poll 1
        wrongState,         // candidate poll 2
        wrongState,         // candidate poll 3 -> times out
        fState("1.0.0", 0), // beforeRollback
        fState("1.0.0", 2), // rollback poll 1 -> succeeds
      ],
    });
    await expect(f.task()).rejects.toThrow(/timed out waiting for upgraded agent observation/i);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(true);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(true);
  });

  it("rejects observation with same semantic version but missing build ID when candidate has build ID", async () => {
    const candidateBuildId = "af467d23a1d5a3d84f078dc1016f3a7a16f344a0";
    const versionOut = `0.1.0+${candidateBuildId}\n`;
    const noBuildState = fState("0.1.0", 1, undefined);
    const f = await fixture({
      versionOut,
      observations: [
        fState("1.0.0", 0), // prior (upgrade)
        fState("1.0.0", 0), // postStopBaseline
        noBuildState,       // candidate poll 1
        noBuildState,       // candidate poll 2
        noBuildState,       // candidate poll 3 -> times out
        fState("1.0.0", 0), // beforeRollback
        fState("1.0.0", 2), // rollback poll 1 -> succeeds
      ],
    });
    await expect(f.task()).rejects.toThrow(/timed out waiting for upgraded agent observation/i);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(true);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(true);
  });

  it("rejects stale observation matching version and build ID when timestamp is not newer than baseline", async () => {
    const buildId = "af467d23a1d5a3d84f078dc1016f3a7a16f344a0";
    const versionOut = `0.1.0+${buildId}\n`;
    const staleState = fState("0.1.0", 1, buildId);
    const f = await fixture({
      versionOut,
      observations: [
        fState("1.0.0", 0), // prior (upgrade)
        fState("1.0.0", 1), // postStopBaseline (timestamp 1, base = 1000)
        staleState,         // candidate poll 1 (timestamp 1 <= 1 -> stale)
        staleState,         // candidate poll 2 (timestamp 1 <= 1 -> stale)
        staleState,         // candidate poll 3 (timestamp 1 <= 1 -> stale) -> times out
        fState("1.0.0", 1), // beforeRollback (timestamp 1, base = 1000)
        fState("1.0.0", 2), // rollback poll 1 (timestamp 2 > 1) -> succeeds
      ],
    });
    await expect(f.task()).rejects.toThrow(/timed out waiting for upgraded agent observation/i);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(true);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(true);
  });

  it("safely rolls back to legacy prior agent without build ID", async () => {
    const candidateBuildId = "af467d23a1d5a3d84f078dc1016f3a7a16f344a0";
    const versionOut = `0.1.0+${candidateBuildId}\n`;
    const f = await fixture({
      versionOut,
      initial: { version: "1.0.0", buildId: undefined },
      observations: [
        fState("1.0.0", 0),           // prior (legacy without buildId)
        fState("1.0.0", 0),           // postStopBaseline
        fState("wrong-candidate", 1), // candidate poll 1
        fState("wrong-candidate", 1), // candidate poll 2
        fState("wrong-candidate", 1), // candidate poll 3 -> times out
        fState("1.0.0", 0),           // beforeRollback
        fState("1.0.0", 2, undefined),// rollback poll 1 (legacy 1.0.0 without buildId, timestamp 2 > 0) -> succeeds
      ],
    });
    await expect(f.task()).rejects.toThrow(/timed out waiting for upgraded agent observation/i);
    expect(f.commands.some((c) => c.includes("mv -f --") && c.includes("backup-"))).toBe(true);
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(true);
  });

  it("verifies prior build ID when rolling back to prior agent that had build ID", async () => {
    const candidateBuildId = "af467d23a1d5a3d84f078dc1016f3a7a16f344a0";
    const priorBuildId = "1111111111111111111111111111111111111111";
    const wrongPriorBuildId = "2222222222222222222222222222222222222222";
    const versionOut = `0.1.0+${candidateBuildId}\n`;
    const f = await fixture({
      versionOut,
      initial: { version: "1.0.0", buildId: priorBuildId },
      observations: [
        fState("1.0.0", 0, priorBuildId),      // prior (upgrade)
        fState("1.0.0", 0, priorBuildId),      // postStopBaseline
        fState("wrong-candidate", 1),          // candidate poll 1
        fState("wrong-candidate", 1),          // candidate poll 2
        fState("wrong-candidate", 1),          // candidate poll 3 -> times out
        fState("1.0.0", 0, priorBuildId),      // beforeRollback
        fState("1.0.0", 2, wrongPriorBuildId), // rollback poll 1: wrong buildId
        fState("1.0.0", 2, wrongPriorBuildId), // rollback poll 2: wrong buildId
        fState("1.0.0", 2, wrongPriorBuildId), // rollback poll 3: wrong buildId -> rollback times out
      ],
    });
    await expect(f.task()).rejects.toThrow(
      /Agent upgrade failed and rollback could not be verified; recovery artifacts were preserved/,
    );
    // Stage binary removal is not executed because rollback verification failed and recovery artifacts were preserved
    expect(f.commands.some((c) => c.includes("rm -f --") && c.includes("stage-"))).toBe(false);
  });
});

function fState(version: string, second: number, buildId?: string): AgentState {
  return { vpsId: "vps-1", status: "online", version, buildId, lastSeenAt: `2026-01-01T00:00:0${second}.000Z` };
}
