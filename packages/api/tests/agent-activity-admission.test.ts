import { describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
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

describe("AgentLifecycleCoordinator activity admission and fencing", () => {
  it("allows update fence acquisition during active activities, blocks new activity and concurrent update, drains accounting", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const vpsId = "vps-test-1";

    // Initially, update lifecycle can be acquired
    const releaseInit = await coordinator.tryAcquire(vpsId, "update");
    releaseInit();

    const releaseJob1 = coordinator.tryAcquireActivity(vpsId, "job");
    const releaseJob2 = coordinator.tryAcquireActivity(vpsId, "job");
    const releaseTerm1 = coordinator.tryAcquireActivity(vpsId, "terminal");

    // With active ongoing activities, tryAcquire("update") succeeds and fences the VPS
    const releaseUpdate = await coordinator.tryAcquire(vpsId, "update");
    expect(coordinator.isLifecycleActive(vpsId)).toBe(true);

    // Concurrent update or lifecycle operation is blocked while update is active
    await expect(coordinator.tryAcquire(vpsId, "update")).rejects.toThrow(ConflictException);
    await expect(coordinator.tryAcquire(vpsId, "install")).rejects.toThrow(ConflictException);

    // New activities must reject while update is active
    expect(() => coordinator.tryAcquireActivity(vpsId, "job")).toThrow(ConflictException);
    expect(() => coordinator.tryAcquireActivity(vpsId, "terminal")).toThrow(ConflictException);

    // Idempotent release of ongoing activities: calling multiple times only decrements once
    releaseJob1();
    releaseJob1();
    releaseJob2();
    releaseTerm1();
    releaseTerm1();

    // Lifecycle remains active until update itself releases
    expect(coordinator.isLifecycleActive(vpsId)).toBe(true);
    expect(() => coordinator.tryAcquireActivity(vpsId, "job")).toThrow(ConflictException);

    // Release update fence
    releaseUpdate();
    expect(coordinator.isLifecycleActive(vpsId)).toBe(false);

    // After update release and ongoing activity completion, new activities can be acquired again
    const releaseNewJob = coordinator.tryAcquireActivity(vpsId, "job");
    releaseNewJob();
  });

  it("permits activity during non-update lifecycle operations such as install", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const vpsId = "vps-test-2";

    const releaseInstall = await coordinator.tryAcquire(vpsId, "install");
    expect(coordinator.isLifecycleActive(vpsId)).toBe(true);

    // Activities (e.g. install job) are permitted during install
    const releaseJob = coordinator.tryAcquireActivity(vpsId, "job");
    releaseJob();
    releaseInstall();
  });

  it("supports durable update-fence reconstruction and batch reconstruction", () => {
    const coordinator = new AgentLifecycleCoordinator();

    const releases = coordinator.reconstructExecutingFences(["vps-a", "vps-b"]);
    expect(coordinator.isLifecycleActive("vps-a")).toBe(true);
    expect(coordinator.isLifecycleActive("vps-b")).toBe(true);

    // Cannot acquire activity while fence is active
    expect(() => coordinator.tryAcquireActivity("vps-a", "job")).toThrow(ConflictException);
    expect(() => coordinator.tryAcquireActivity("vps-b", "terminal")).toThrow(ConflictException);

    // Release fence for vps-a
    releases.get("vps-a")?.();
    expect(coordinator.isLifecycleActive("vps-a")).toBe(false);
    expect(coordinator.isLifecycleActive("vps-b")).toBe(true);

    // vps-a can now acquire activity, vps-b still cannot
    const releaseA = coordinator.tryAcquireActivity("vps-a", "job");
    releaseA();
    expect(() => coordinator.tryAcquireActivity("vps-b", "terminal")).toThrow(ConflictException);

    releases.get("vps-b")?.();
    expect(coordinator.isLifecycleActive("vps-b")).toBe(false);
  });
});

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
    const releaseUpdate = await coordinator.tryAcquire("vps-1", "update");
    releaseUpdate();
  });

  it("rejects terminal open when agent update fence is active", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const releaseUpdate = await coordinator.tryAcquire("vps-updating", "update");

    const sessions = {
      authenticateById: vi.fn(async () => ({
        id: "dash-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    } as unknown as DashboardSessionService;
    const service = new TerminalSessionService(
      config,
      {} as unknown as VpsRepository,
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
        vpsId: "vps-updating",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(ConflictException);

    expect(service.registry.hasActive("vps-updating")).toBe(false);
    releaseUpdate();
  });
});

describe("JobRunnerService activity admission and conflict safety", () => {
  it("acquires activity before status running and releases in finally upon task completion", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const jobRepo = createInMemoryJobRepo();
    const activity = new JobActivityService();
    const runner = new JobRunnerService(jobRepo, activity, coordinator);

    const job = await jobRepo.create({
      vpsId: "vps-job-1",
      type: "command",
      status: "queued",
      step: "queued",
      progress: 0,
    });

    let updateAllowedDuringExecution = false;
    let releaseInFlightUpdate: (() => void) | undefined;
    const { promise, resolve } = Promise.withResolvers<void>();
    runner.start(job, async (ctx) => {
      // Under disruptive update policy, update acquisition is allowed during active activity
      try {
        releaseInFlightUpdate = await coordinator.tryAcquire("vps-job-1", "update");
        updateAllowedDuringExecution = true;
      } catch {
        updateAllowedDuringExecution = false;
      }
      await ctx.succeed();
      resolve();
    });
    await promise;
    await flushMicrotasks();
    expect(updateAllowedDuringExecution).toBe(true);
    releaseInFlightUpdate?.();

    // After completion, activity was released so update can be acquired and released
    const releaseUpdate = await coordinator.tryAcquire("vps-job-1", "update");
    releaseUpdate();
    const completed = await jobRepo.get(job.id);
    expect(completed?.status).toBe("succeeded");
  });

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
    // After failure, activity was released in finally
    const releaseUpdate = await coordinator.tryAcquire("vps-job-2", "update");
    releaseUpdate();

    const completed = await jobRepo.get(job.id);
    expect(completed?.status).toBe("failed");
  });

  it("synchronously rejects at start admission with retriable ConflictException when update is in progress", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const jobRepo = createInMemoryJobRepo();
    const activity = new JobActivityService();
    const runner = new JobRunnerService(jobRepo, activity, coordinator);

    // Active update fence on vps-job-3
    const releaseUpdate = await coordinator.tryAcquire("vps-job-3", "update");

    const job = await jobRepo.create({
      vpsId: "vps-job-3",
      type: "command",
      status: "queued",
      step: "queued",
      progress: 0,
    });

    const taskExecuted = vi.fn(async () => {});
    // start() must synchronously throw ConflictException at admission
    expect(() => runner.start(job, taskExecuted)).toThrow(ConflictException);

    // Task must never have been called
    expect(taskExecuted).not.toHaveBeenCalled();

    // Queued job in repo should be cancelled due to admission conflict rather than permanently failed
    const finalJob = await jobRepo.get(job.id);
    expect(finalJob?.status).toBe("cancelled");
    expect(finalJob?.step).toBe("admission_rejected");
    expect(finalJob?.errorMessage).toMatch(/Agent update is in progress/i);

    releaseUpdate();
  });
});
