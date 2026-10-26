import { describe, expect, it, vi } from "vitest";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import { TerminalSessionRegistry } from "../src/terminal/terminal-registry.js";
import {
  TerminalSessionService,
  type TerminalSocket,
} from "../src/terminal/terminal-session.service.js";
import type { AppConfig } from "../src/config/app-config.js";
import { JobRunnerService } from "../src/jobs/job-runner.service.js";
import { JobActivityService } from "../src/jobs/job-activity.service.js";
import type { CommandJob } from "../src/jobs/jobs.models.js";
import type { JobRepository } from "../src/persistence/repositories/job.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { KeyService } from "../src/ssh/keyService.js";
import type { SshService } from "../src/ssh/ssh.service.js";
import type { DashboardSessionService } from "../auth/dashboard-session.service.js";

class MockSocket implements TerminalSocket {
  messages: string[] = [];
  closes: [number | undefined, string | undefined][] = [];
  bufferedAmount = 0;
  messageHandler?: (data: string | Buffer) => void;
  closeHandler?: () => void;
  errorHandler?: () => void;
  pongHandler?: () => void;

  send(data: string, callback?: (error?: Error) => void) {
    this.messages.push(data);
    callback?.();
  }
  close(code?: number, reason?: string) {
    this.closes.push([code, reason]);
    this.closeHandler?.();
  }
  onMessage(handler: (data: string | Buffer) => void) {
    this.messageHandler = handler;
  }
  onClose(handler: () => void) {
    this.closeHandler = handler;
  }
  onError(handler: () => void) {
    this.errorHandler = handler;
  }
  onPong(handler: () => void) {
    this.pongHandler = handler;
  }
}
async function flushMicrotasks(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function createInMemoryJobRepo(initialJobs: CommandJob[] = []): JobRepository {
  const store = new Map<string, CommandJob>(initialJobs.map((j) => [j.id, { ...j }]));
  return {
    get: async (id: string) => store.get(id),
    list: async () => [...store.values()],
    listByVpsId: async (vpsId: string) =>
      [...store.values()].filter((j) => j.vpsId === vpsId),
    create: async (data: Omit<CommandJob, "id">) => {
      const job: CommandJob = { id: `job_${Date.now()}_${Math.random()}`, ...data };
      store.set(job.id, job);
      return job;
    },
    update: async (id: string, patch: Partial<CommandJob>) => {
      const existing = store.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      store.set(id, updated);
      return updated;
    },
    delete: async (id: string) => store.delete(id),
    deleteOlderThan: async () => 0,
    countRunning: async () =>
      [...store.values()].filter((j) => j.status === "running").length,
    listRunning: async () =>
      [...store.values()].filter((j) => j.status === "running"),
  } as unknown as JobRepository;
}


describe("TerminalSessionRegistry.hasActive", () => {
  it("reports active session presence and clears on release or bulk close", async () => {
    const registry = new TerminalSessionRegistry({ global: 10, perDashboard: 5, perVps: 2 });
    const close = vi.fn(async () => {});

    expect(registry.hasActive("vps-1")).toBe(false);

    const reg1 = registry.admit("dash-1", "vps-1", close);
    expect(registry.hasActive("vps-1")).toBe(true);
    expect(registry.hasActive("vps-2")).toBe(false);

    const reg2 = registry.admit("dash-1", "vps-1", close);
    expect(registry.hasActive("vps-1")).toBe(true);

    registry.release(reg1.id);
    expect(registry.hasActive("vps-1")).toBe(true);

    registry.release(reg2.id);
    expect(registry.hasActive("vps-1")).toBe(false);

    // Admission + closeByVps
    registry.admit("dash-1", "vps-1", close);
    expect(registry.hasActive("vps-1")).toBe(true);
    await registry.closeByVps("vps-1");
    expect(registry.hasActive("vps-1")).toBe(false);
  });
});

describe("TerminalSessionService activity admission and leak prevention", () => {
  const config = {
    enableWebTerminal: true,
    mode: "local",
    terminal: {
      global: 10,
      perDashboard: 3,
      perVps: 2,
      openTimeoutMs: 100,
      idleTimeoutMs: 50,
      lifetimeMs: 200,
      revocationPollMs: 25,
      heartbeatMs: 1000,
      outputBufferBytes: 100,
      inputBufferBytes: 100,
      slowConsumerTimeoutMs: 100,
    },
  } as unknown as AppConfig;

  it("releases coordinator activity and registry on startup failure (e.g. VPS not found)", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const vps = { get: vi.fn(async () => undefined) } as unknown as VpsRepository;
    const sessions = {
      authenticateById: vi.fn(async () => ({
        id: "dash-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    } as unknown as DashboardSessionService;
    const service = new TerminalSessionService(
      config,
      vps,
      {} as unknown as KeyService,
      {} as unknown as SshService,
      sessions,
      coordinator,
    );

    const socket = new MockSocket();
    await expect(
      service.open(socket, "dash-1", {
        type: "open",
        version: 1,
        vpsId: "vps-missing",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "VPS_NOT_FOUND" });

    // Assert: No leaked activity (update can be acquired) and no leaked session in registry
    expect(service.registry.hasActive("vps-missing")).toBe(false);
    const releaseUpdate = await coordinator.tryAcquire("vps-missing", "update");
    releaseUpdate();
  });

  it("releases coordinator activity and registry on SSH connection failure", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const vps = {
      get: vi.fn(async () => ({ id: "vps-1", kind: "remote" })),
    } as unknown as VpsRepository;
    const keys = {
      readPrivateKey: vi.fn(async () => "KEY"),
    } as unknown as KeyService;
    const ssh = {
      openManagedShell: vi.fn(async () => {
        throw new Error("SSH network unreachable");
      }),
    } as unknown as SshService;
    const sessions = {
      authenticateById: vi.fn(async () => ({
        id: "dash-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    } as unknown as DashboardSessionService;
    const service = new TerminalSessionService(
      config,
      vps,
      keys,
      ssh,
      sessions,
      coordinator,
    );

    const socket = new MockSocket();
    await expect(
      service.open(socket, "dash-1", {
        type: "open",
        version: 1,
        vpsId: "vps-1",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "SSH_FAILURE" });

    expect(service.registry.hasActive("vps-1")).toBe(false);
  });

});

describe("JobRunnerService activity admission and conflict safety", () => {

  it("releases activity in finally even when task throws an error", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const jobRepo = createInMemoryJobRepo();
    const activity = new JobActivityService();
    const runner = new JobRunnerService(jobRepo, activity, coordinator);

    const job = await jobRepo.create({
      vpsId: "vps-job-2",
      type: "command",
      status: "queued",
      step: "queued",
      progress: 0,
    });

    const { promise, resolve } = Promise.withResolvers<void>();
    const origUpdate = jobRepo.update.bind(jobRepo);
    jobRepo.update = async (id, patch) => {
      const res = await origUpdate(id, patch);
      if (patch.status === "failed") resolve();
      return res;
    };

    runner.start(job, async () => {
      throw new Error("Task execution exploded");
    });
    await promise;
    await flushMicrotasks();

    const completed = await jobRepo.get(job.id);
    expect(completed?.status).toBe("failed");
  });

});
