import { describe, expect, it, vi, afterEach, type Mock } from "vitest";
import type { Response } from "express";
import type { AppConfig } from "../src/config/app-config.js";
import type { DashboardDockerMetrics } from "../src/dashboard/dashboard.models.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { VpsService } from "../src/vps/vps.service.js";
import {
  DashboardService,
  deriveDockerPresentation,
} from "../src/dashboard/dashboard.service.js";
import { MonitoringService } from "../src/monitoring/monitoring.service.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── shared fixtures ──────────────────────────────────────────────────────

const localConfig = { mode: "local", enableWebTerminal: false } as AppConfig;

/** Stored snapshot row: everything except read-time presentation fields. */
type DockerSnapshotStored = Omit<
  DashboardDockerMetrics,
  "freshness" | "ageSeconds" | "lastUpdatedAt"
>;

function dockerSnapshot(
  vpsId: string,
  receivedAt: string,
  overrides: Partial<DockerSnapshotStored> = {},
): DockerSnapshotStored {
  return {
    vpsId,
    agentInstanceId: "inst-1",
    snapshotId: "snap-1",
    schemaVersion: 2,
    collectedAt: receivedAt,
    receivedAt,
    effectiveAt: receivedAt,
    sourceSequence: "1",
    containerTotal: 1,
    containerRunning: 1,
    cpuPercent: 5,
    memoryUsageBytes: 1024,
    networkRxBytes: 10,
    networkTxBytes: 10,
    blockReadBytes: 10,
    blockWriteBytes: 10,
    pids: 2,
    containers: [],
    ...overrides,
  };
}

function remoteVps(enabled: boolean): VpsRecord {
  return {
    id: "vps-remote-1",
    name: "remote-1",
    host: "203.0.113.10",
    port: 22,
    username: "root",
    kind: "remote",
    managedBy: "user",
    dockerMetricsEnabled: enabled,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

type DockerCleanupMock = { cleanupForVps: Mock };

function arrangeRemoteVpsService(
  stored: VpsRecord,
  agent: Partial<AgentRepository>,
  dockerMonitoring: DockerCleanupMock = {
    cleanupForVps: vi.fn(async () => undefined),
  },
) {
  const state = { ...stored };
  const store = {
    get: vi.fn(async () => ({ ...state })),
    update: vi.fn(async (_id: string, patch: Partial<VpsRecord>) => {
      Object.assign(state, patch);
      return { ...state };
    }),
  } as unknown as VpsRepository;
  const audit = { record: vi.fn(async () => undefined) };
  const agentRepository = {
    getState: vi.fn(async () => undefined),
    ...agent,
  } as unknown as AgentRepository;
  const hostKeyPin = { revokeTrust: vi.fn(async () => undefined) };
  const service = new VpsService(
    store,
    {} as never,
    {} as never,
    audit as never,
    localConfig,
    {} as never,
    {} as never,
    agentRepository,
    hostKeyPin as never,
    undefined,
    undefined,
    dockerMonitoring as never,
  );
  return {
    service,
    store,
    audit,
    agentRepository,
    hostKeyPin,
    state,
    dockerMonitoring,
  };
}

// ── (1) remote toggle ────────────────────────────────────────────────────

describe("remote/user-managed VPS docker toggle", () => {
  it("accepts a dockerMetricsEnabled toggle on a remote VPS", async () => {
    // Arrange
    const { service, store, audit, dockerMonitoring } =
      arrangeRemoteVpsService(remoteVps(false), {});

    // Act
    const result = await service.update("vps-remote-1", {
      dockerMetricsEnabled: true,
    });

    // Assert
    expect(result.dockerMetricsEnabled).toBe(true);
    expect(store.update).toHaveBeenCalledWith(
      "vps-remote-1",
      expect.objectContaining({ dockerMetricsEnabled: true }),
    );
    expect(dockerMonitoring.cleanupForVps).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vps.docker_metrics.update" }),
    );
  });

  it("accepts the toggle alongside a normal remote field update", async () => {
    // Arrange
    const { service, store } = arrangeRemoteVpsService(remoteVps(false), {});

    // Act
    const result = await service.update("vps-remote-1", {
      name: "renamed",
      dockerMetricsEnabled: true,
    });

    // Assert
    expect(result.dockerMetricsEnabled).toBe(true);
    expect(result.name).toBe("renamed");
    expect(store.update).toHaveBeenCalledWith(
      "vps-remote-1",
      expect.objectContaining({ name: "renamed", dockerMetricsEnabled: true }),
    );
  });
});

// ── (2) disable clears; delete failure is loud + retryable ────────────────

describe("docker disable cleanup contract", () => {
  it("clears the stored snapshot when a remote VPS is disabled", async () => {
    // Arrange
    const { service, dockerMonitoring } = arrangeRemoteVpsService(
      remoteVps(true),
      {},
    );

    // Act
    const result = await service.update("vps-remote-1", {
      dockerMetricsEnabled: false,
    });

    // Assert
    expect(result.dockerMetricsEnabled).toBe(false);
    expect(dockerMonitoring.cleanupForVps).toHaveBeenCalledTimes(1);
    expect(dockerMonitoring.cleanupForVps).toHaveBeenCalledWith(
      "vps-remote-1",
      "monitoring_disabled",
    );
  });

  it("propagates a docker cleanup failure without a false success audit", async () => {
    // Arrange
    const failure = new Error("docker cleanup failed");
    const { service, audit, dockerMonitoring } = arrangeRemoteVpsService(
      remoteVps(true),
      {},
      {
        cleanupForVps: vi.fn(async () => {
          throw failure;
        }),
      },
    );

    // Act
    const action = service.update("vps-remote-1", { dockerMetricsEnabled: false });

    // Assert
    await expect(action).rejects.toBe(failure);
    expect(dockerMonitoring.cleanupForVps).toHaveBeenCalledWith(
      "vps-remote-1",
      "monitoring_disabled",
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("propagates a local/system docker cleanup failure without a false success audit", async () => {
    // Arrange
    const failure = new Error("local docker cleanup failed");
    const stored: VpsRecord = {
      ...remoteVps(true),
      id: "vps_local_host",
      kind: "local",
      managedBy: "system",
    };
    const { service, audit, dockerMonitoring } = arrangeRemoteVpsService(
      stored,
      {},
      {
        cleanupForVps: vi.fn(async () => {
          throw failure;
        }),
      },
    );

    // Act
    const action = service.update("vps_local_host", { dockerMetricsEnabled: false });

    // Assert
    await expect(action).rejects.toBe(failure);
    expect(dockerMonitoring.cleanupForVps).toHaveBeenCalledWith(
      "vps_local_host",
      "monitoring_disabled",
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("remote combined disable failure commits nothing and retry succeeds", async () => {
    // Arrange: remote disable combined with endpoint + rename. Cleanup fails first.
    const failure = new Error("docker cleanup failed");
    const cleanupForVps = vi.fn(async (): Promise<void> => {
      throw failure;
    });
    const { service, store, audit, hostKeyPin, state } = arrangeRemoteVpsService(
      remoteVps(true),
      {},
      { cleanupForVps },
    );
    const before = { ...state };

    // Act: combined update must fail before any persistence side effect.
    const action = service.update("vps-remote-1", {
      name: "renamed",
      host: "203.0.113.99",
      dockerMetricsEnabled: false,
    });

    // Assert: failure is loud, repository state is unchanged, and no partial
    // commit (endpoint/other fields), trust revocation, or success audit ran.
    await expect(action).rejects.toBe(failure);
    expect(cleanupForVps).toHaveBeenCalledWith(
      "vps-remote-1",
      "monitoring_disabled",
    );
    expect(store.update).not.toHaveBeenCalled();
    expect(hostKeyPin.revokeTrust).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(state).toEqual(before);
    expect(state.dockerMetricsEnabled).toBe(true);
    expect(state.host).toBe("203.0.113.10");
    expect(state.name).toBe("remote-1");

    // Arrange retry: cleanup now succeeds.
    cleanupForVps.mockResolvedValue(undefined);

    // Act: retry the same combined update.
    const retried = await service.update("vps-remote-1", {
      name: "renamed",
      host: "203.0.113.99",
      dockerMetricsEnabled: false,
    });

    // Assert: retry commits endpoint + toggle together, revokes trust once,
    // and records exactly one success audit.
    expect(cleanupForVps).toHaveBeenCalledTimes(2);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(retried.dockerMetricsEnabled).toBe(false);
    expect(retried.name).toBe("renamed");
    expect(retried.host).toBe("203.0.113.99");
    expect(state.dockerMetricsEnabled).toBe(false);
    expect(state.host).toBe("203.0.113.99");
    expect(hostKeyPin.revokeTrust).toHaveBeenCalledTimes(1);
    expect(hostKeyPin.revokeTrust).toHaveBeenCalledWith("vps-remote-1");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vps.docker_metrics.update", result: "success" }),
    );
  });

  it("local disable failure leaves toggle enabled and retry succeeds", async () => {
    // Arrange: local/system disable whose snapshot cleanup fails first.
    const failure = new Error("local docker cleanup failed");
    const cleanupForVps = vi.fn(async (): Promise<void> => {
      throw failure;
    });
    const stored: VpsRecord = {
      ...remoteVps(true),
      id: "vps_local_host",
      kind: "local",
      managedBy: "system",
    };
    const { service, store, audit, state } = arrangeRemoteVpsService(
      stored,
      {},
      { cleanupForVps },
    );
    const before = { ...state };

    // Act
    const action = service.update("vps_local_host", { dockerMetricsEnabled: false });

    // Assert: nothing persisted, still enabled, therefore retryable.
    await expect(action).rejects.toBe(failure);
    expect(cleanupForVps).toHaveBeenCalledWith(
      "vps_local_host",
      "monitoring_disabled",
    );
    expect(store.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(state).toEqual(before);
    expect(state.dockerMetricsEnabled).toBe(true);

    // Arrange retry + Act
    cleanupForVps.mockResolvedValue(undefined);
    const retried = await service.update("vps_local_host", {
      dockerMetricsEnabled: false,
    });

    // Assert
    expect(cleanupForVps).toHaveBeenCalledTimes(2);
    expect(state.dockerMetricsEnabled).toBe(false);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vps.docker_metrics.update", result: "success" }),
    );
  });
});

// ── (3) dashboard overview filtering + derived fields ────────────────────

function arrangeDashboard(
  servers: VpsRecord[],
  storedDocker: DockerSnapshotStored[],
) {
  const storedCopies = storedDocker.map((d) => ({ ...d }));
  const dockerMonitoring = {
    getAuthoritativeLatest: vi.fn(async (vpsId: string) => {
      const row = storedCopies.find((d) => d.vpsId === vpsId);
      if (!row) return undefined;
      return {
        activeInstanceId: row.agentInstanceId,
        snapshotId: row.snapshotId,
        sourceSequence: row.sourceSequence,
        receivedAt: row.receivedAt,
        updatedAt: row.receivedAt,
        revision: 1,
        ...(row.available === undefined ? {} : { available: row.available }),
        ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
        ...(row.engineVersion === undefined
          ? {}
          : { engineVersion: row.engineVersion }),
        ...(row.apiVersion === undefined ? {} : { apiVersion: row.apiVersion }),
      };
    }),
    listHostSamples: vi.fn(async ({ vpsId }: { vpsId: string }) => {
      const row = storedCopies.find((d) => d.vpsId === vpsId);
      return {
        data: row
          ? [
              {
                id: `sample-${row.vpsId}`,
                vpsId: row.vpsId,
                agentInstanceId: row.agentInstanceId,
                snapshotId: row.snapshotId,
                collectedAt: row.collectedAt,
                receivedAt: row.receivedAt,
                effectiveAt: row.effectiveAt,
                metrics: {
                  containerTotal: row.containerTotal,
                  containerRunning: row.containerRunning,
                  cpuPercent: row.cpuPercent,
                  memoryUsageBytes: row.memoryUsageBytes,
                  ...(row.memoryLimitBytes === undefined
                    ? {}
                    : { memoryLimitBytes: row.memoryLimitBytes }),
                  networkRxBytes: row.networkRxBytes,
                  networkTxBytes: row.networkTxBytes,
                  blockReadBytes: row.blockReadBytes,
                  blockWriteBytes: row.blockWriteBytes,
                  pids: row.pids,
                },
              },
            ]
          : [],
        page: { limit: 1, hasMore: false },
      };
    }),
    listCurrentContainers: vi.fn(async (vpsId: string) => {
      const row = storedCopies.find((d) => d.vpsId === vpsId);
      if (!row) return [];
      return row.containers.map((c) => ({
        agentInstanceId: row.agentInstanceId,
        containerKey: c.containerKey,
        name: c.name,
        state: c.state,
        ...(c.image === undefined ? {} : { image: c.image }),
        ...(c.status === undefined ? {} : { status: c.status }),
        metrics: {
          cpuPercent: c.cpuPercent,
          memoryUsageBytes: c.memoryUsageBytes,
          pids: c.pids,
        },
      }));
    }),
  };
  const dashboard = new DashboardService(
    localConfig,
    { list: vi.fn(async () => servers.map((s) => ({ ...s }))) } as never,
    { listLatest: vi.fn(async () => []) } as never,
    {
      listStates: vi.fn(async () => []),
      listSystemInfo: vi.fn(async () => []),
    } as never,
    { list: vi.fn(async () => []) } as never,
    dockerMonitoring as never,
  );
  return { dashboard, storedCopies };
}

describe("dashboard docker overview", () => {
  it("includes an enabled snapshot with derived fields and excludes a disabled stale snapshot", async () => {
    // Arrange: enabled host is fresh, disabled host has a stale leftover row.
    const freshAt = new Date(Date.now() - 10_000).toISOString();
    const staleAt = new Date(Date.now() - 60 * 60_1000).toISOString();
    const servers: VpsRecord[] = [
      { ...remoteVps(false), id: "vps-a", dockerMetricsEnabled: true },
      { ...remoteVps(false), id: "vps-b", dockerMetricsEnabled: false },
    ];
    const storedA = dockerSnapshot("vps-a", freshAt);
    const storedB = dockerSnapshot("vps-b", staleAt);
    const { dashboard, storedCopies } = arrangeDashboard(servers, [storedA, storedB]);

    // Act
    const overview = await dashboard.overview();

    // Assert: only the enabled host is exposed, with read-time derived fields.
    expect(overview.dockerMetrics).toHaveLength(1);
    const presented = overview.dockerMetrics[0]!;
    expect(presented.vpsId).toBe("vps-a");
    expect(presented.freshness).toBe("fresh");
    expect(presented.lastUpdatedAt).toBe(freshAt);
    expect(typeof presented.ageSeconds).toBe("number");
    expect(presented.ageSeconds).toBeGreaterThanOrEqual(9);
    expect(presented.ageSeconds).toBeLessThanOrEqual(30);
    expect(overview.dockerMetrics.some((d) => d.vpsId === "vps-b")).toBe(false);

    // Stored rows are not mutated with derived fields (read-time only).
    expect(storedCopies[0]).not.toHaveProperty("freshness");
    expect(storedCopies[0]).not.toHaveProperty("ageSeconds");
    expect(storedCopies[0]).not.toHaveProperty("lastUpdatedAt");
    expect(storedCopies[1]).not.toHaveProperty("freshness");
  });

  it("returns [] when no host is enabled even if stale rows are stored", async () => {
    // Arrange
    const staleAt = new Date(Date.now() - 60 * 60_1000).toISOString();
    const servers: VpsRecord[] = [
      { ...remoteVps(false), id: "vps-a", dockerMetricsEnabled: false },
    ];
    const { dashboard } = arrangeDashboard(servers, [dockerSnapshot("vps-a", staleAt)]);

    // Act
    const overview = await dashboard.overview();

    // Assert
    expect(overview.dockerMetrics).toEqual([]);
  });
});

// ── (4) SSE authoritative arrays + scoping ───────────────────────────────

type CapturedWrite = { event: string; envelope: any };

function createFakeSseResponse() {
  let text = "";
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      text += chunk;
      return true;
    }),
    on: vi.fn(),
    once: vi.fn(),
    end: vi.fn(),
    text: () => text,
  } as unknown as Response & { text: () => string };
  return res;
}

function parseSse(text: string): CapturedWrite[] {
  const out: CapturedWrite[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.includes("data:")) continue;
    const eventMatch = block.match(/^event: (.+)$/m);
    const dataMatch = block.match(/^data: (.+)$/m);
    if (!eventMatch || !dataMatch) continue;
    out.push({ event: eventMatch[1].trim(), envelope: JSON.parse(dataMatch[1]) });
  }
  return out;
}

function metricSample(vpsId: string, receivedAt: string) {
  return {
    vpsId,
    cpu: 10,
    memory: 10,
    disk: 10,
    loadAverage: 0.1,
    networkRx: 1,
    networkTx: 1,
    uptime: 5,
    collectedAt: receivedAt,
    receivedAt,
  };
}

function overviewFixture(dockerMetrics: DockerSnapshotStored[]) {
  const now = new Date().toISOString();
  return {
    mode: "local",
    summary: {
      totalServers: 2,
      healthyServers: 2,
      warningServers: 0,
      unreachableServers: 0,
      runningJobs: 0,
    },
    servers: [
      { ...remoteVps(false), id: "vps-a", name: "a", dockerMetricsEnabled: true },
      { ...remoteVps(false), id: "vps-b", name: "b", dockerMetricsEnabled: true },
    ],
    metrics: [metricSample("vps-a", now), metricSample("vps-b", now)],
    jobs: [],
    auditEvents: [],
    terminal: { label: "Terminal", networkAccess: "disabled", commands: [], sessions: [] },
    settings: {
      appMode: "local",
      webTerminalEnabled: false,
      terminalCommandGuardEnabled: false,
      realSshEnabled: true,
      authRequiredInLocalMode: true,
    },
    systemInfo: [],
    dockerMetrics: dockerMetrics.map(deriveDockerPresentation),
  };
}

function arrangeMonitoring(overview: ReturnType<typeof overviewFixture>) {
  const dashboardService = { overview: vi.fn(async () => overview) };
  const metricService = {
    list: vi.fn(async (vpsId?: string) => {
      const all = overview.metrics as ReturnType<typeof metricSample>[];
      return vpsId ? all.filter((m) => m.vpsId === vpsId) : [...all];
    }),
  };
  const service = new MonitoringService(
    localConfig,
    dashboardService as never,
    metricService as never,
    {} as never,
    {} as never,
    { subscribe: vi.fn(() => () => undefined) } as never,
  );
  return { service, dashboardService, metricService };
}

describe("monitoring SSE dockerMetrics contract", () => {
  it("global snapshot always carries an authoritative dockerMetrics array, including []", async () => {
    // Arrange: stub timers so the periodic loop cannot fire during this assertion.
    const timer = vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as never);
    try {
      const dockerAt = new Date().toISOString();
      const { service } = arrangeMonitoring(
        overviewFixture([dockerSnapshot("vps-a", dockerAt)]),
      );
      const res = createFakeSseResponse();

      // Act
      await service.stream(res);

      // Assert
      const snapshots = parseSse(res.text()).filter((e) => e.envelope.type === "monitoring.snapshot");
      expect(snapshots).toHaveLength(1);
      expect(Array.isArray(snapshots[0]!.envelope.payload.dockerMetrics)).toBe(true);
      expect(snapshots[0]!.envelope.payload.dockerMetrics.map((d: DashboardDockerMetrics) => d.vpsId)).toEqual([
        "vps-a",
      ]);
      expect(Array.isArray(snapshots[0]!.envelope.payload.overview.dockerMetrics)).toBe(true);
    } finally {
      timer.mockRestore();
    }

    // Arrange empty: no docker rows anywhere still emits [].
    const timer2 = vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as never);
    try {
      const { service } = arrangeMonitoring(overviewFixture([]));
      const res = createFakeSseResponse();

      // Act
      await service.stream(res);

      // Assert
      const snapshots = parseSse(res.text()).filter((e) => e.envelope.type === "monitoring.snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.envelope.payload.dockerMetrics).toEqual([]);
      expect(snapshots[0]!.envelope.payload.overview.dockerMetrics).toEqual([]);
    } finally {
      timer2.mockRestore();
    }
  });

  it("global metrics.updated carries the authoritative dockerMetrics array, including []", async () => {
    // Arrange: capture the periodic loop callback instead of letting it run on a timer.
    const callbacks: Array<() => unknown> = [];
    const timer = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((cb: () => unknown) => {
        callbacks.push(cb);
        return 0 as never;
      }) as never);
    try {
      const dockerAt = new Date().toISOString();
      const { service } = arrangeMonitoring(
        overviewFixture([dockerSnapshot("vps-a", dockerAt)]),
      );
      const res = createFakeSseResponse();
      await service.stream(res);
      expect(callbacks.length).toBeGreaterThan(0);

      // Act: run the local metrics loop once.
      await callbacks[0]!();

      // Assert
      const updates = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1]!.envelope.payload;
      expect(Array.isArray(last.dockerMetrics)).toBe(true);
      expect(last.dockerMetrics.map((d: DashboardDockerMetrics) => d.vpsId)).toEqual(["vps-a"]);
    } finally {
      timer.mockRestore();
    }

    // Arrange empty docker still emits an explicit [] on updates.
    const callbacks2: Array<() => unknown> = [];
    const timer2 = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((cb: () => unknown) => {
        callbacks2.push(cb);
        return 0 as never;
      }) as never);
    try {
      const { service } = arrangeMonitoring(overviewFixture([]));
      const res = createFakeSseResponse();
      await service.stream(res);
      await callbacks2[0]!();

      const updates = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(updates.length).toBeGreaterThan(0);
      expect(updates[updates.length - 1]!.envelope.payload.dockerMetrics).toEqual([]);
    } finally {
      timer2.mockRestore();
    }
  });

  it("scoped snapshot and scoped update include only the requested VPS and never leak another", async () => {
    // Arrange
    const timer = vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as never);
    try {
      const dockerAt = new Date().toISOString();
      const { service } = arrangeMonitoring(
        overviewFixture([dockerSnapshot("vps-a", dockerAt), dockerSnapshot("vps-b", dockerAt)]),
      );
      const res = createFakeSseResponse();

      // Act
      await service.streamForVps(res, "vps-a");

      // Assert snapshot scope
      const snapshots = parseSse(res.text()).filter((e) => e.envelope.type === "monitoring.snapshot");
      expect(snapshots).toHaveLength(1);
      const payload = snapshots[0]!.envelope.payload;
      expect(payload.dockerMetrics.map((d: DashboardDockerMetrics) => d.vpsId)).toEqual(["vps-a"]);
      expect(payload.overview.dockerMetrics.map((d: DashboardDockerMetrics) => d.vpsId)).toEqual([
        "vps-a",
      ]);
      expect(payload.servers.map((s: VpsRecord) => s.id)).toEqual(["vps-a"]);
      expect(JSON.stringify(payload)).not.toContain("vps-b");
    } finally {
      timer.mockRestore();
    }

    // Arrange + Act scoped periodic update: only the requested VPS is emitted.
    const callbacks: Array<() => unknown> = [];
    const timer2 = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((cb: () => unknown) => {
        callbacks.push(cb);
        return 0 as never;
      }) as never);
    try {
      const dockerAt = new Date().toISOString();
      const { service } = arrangeMonitoring(
        overviewFixture([dockerSnapshot("vps-a", dockerAt), dockerSnapshot("vps-b", dockerAt)]),
      );
      const res = createFakeSseResponse();
      await service.streamForVps(res, "vps-b");
      const loop = callbacks.find((cb) => cb.constructor.name === "AsyncFunction") ?? callbacks[0]!;
      await loop();

      // Assert update scope
      const updates = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1]!.envelope.payload;
      expect(last.metrics.map((m: { vpsId: string }) => m.vpsId)).toEqual(["vps-b"]);
      expect(last.dockerMetrics.map((d: DashboardDockerMetrics) => d.vpsId)).toEqual(["vps-b"]);
      expect(JSON.stringify(last)).not.toContain("vps-a");
    } finally {
      timer2.mockRestore();
    }
  });

  it("scoped stream for a VPS without docker rows emits [] instead of another VPS snapshot", async () => {
    // Arrange
    const timer = vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as never);
    try {
      const dockerAt = new Date().toISOString();
      const fixture = overviewFixture([dockerSnapshot("vps-b", dockerAt)]);
      const { service } = arrangeMonitoring(fixture);
      const res = createFakeSseResponse();

      // Act
      await service.streamForVps(res, "vps-a");

      // Assert
      const snapshots = parseSse(res.text()).filter((e) => e.envelope.type === "monitoring.snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.envelope.payload.dockerMetrics).toEqual([]);
      expect(snapshots[0]!.envelope.payload.overview.dockerMetrics).toEqual([]);
    } finally {
      timer.mockRestore();
    }
  });

  it("global update emits dockerMetrics [] even when host metrics are empty", async () => {
    // Arrange: no host-metric rows, but an authoritative empty Docker snapshot.
    const callbacks: Array<() => unknown> = [];
    const timer = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((cb: () => unknown) => {
        callbacks.push(cb);
        return 0 as never;
      }) as never);
    try {
      const fixture = overviewFixture([]);
      fixture.metrics = [];
      const { service } = arrangeMonitoring(fixture);
      const res = createFakeSseResponse();
      await service.stream(res);
      const tick = callbacks.find((cb) => cb.constructor.name === "AsyncFunction") ?? callbacks[0]!;

      // Act: first periodic tick has no host metrics.
      await tick();

      // Assert: authoritative Docker [] is still emitted alongside empty host metrics.
      const updates = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1]!.envelope.payload;
      expect(last.metrics).toEqual([]);
      expect(last.dockerMetrics).toEqual([]);
      const heartbeats = parseSse(res.text()).filter(
        (e) => e.envelope.type === "monitoring.heartbeat",
      );
      expect(heartbeats.length).toBeGreaterThan(0);
    } finally {
      timer.mockRestore();
    }
  });

  it("global update emits a later docker change even when host metrics stay empty", async () => {
    // Arrange: mutable overview whose Docker snapshot gains a row while host
    // metrics remain empty across successive ticks.
    const callbacks: Array<() => unknown> = [];
    const timer = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((cb: () => unknown) => {
        callbacks.push(cb);
        return 0 as never;
      }) as never);
    try {
      const fixture = overviewFixture([]);
      fixture.metrics = [];
      const dockerAt = new Date().toISOString();
      const { service, dashboardService } = arrangeMonitoring(fixture);
      const res = createFakeSseResponse();
      await service.stream(res);
      const tick = callbacks.find((cb) => cb.constructor.name === "AsyncFunction") ?? callbacks[0]!;
      await tick();
      const before = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(before[before.length - 1]!.envelope.payload.dockerMetrics).toEqual([]);

      // Act: Docker snapshot changes; host metrics are still empty.
      fixture.dockerMetrics = [
        deriveDockerPresentation(dockerSnapshot("vps-a", dockerAt)),
      ];
      (dashboardService.overview as ReturnType<typeof vi.fn>).mockResolvedValue(fixture);
      await tick();

      // Assert: the Docker change is emitted without needing host metrics.
      const updates = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(updates.length).toBeGreaterThan(1);
      const last = updates[updates.length - 1]!.envelope.payload;
      expect(last.metrics).toEqual([]);
      expect(last.dockerMetrics.map((d: DashboardDockerMetrics) => d.vpsId)).toEqual(["vps-a"]);
    } finally {
      timer.mockRestore();
    }
  });

  it("scoped update emits dockerMetrics [] for the requested VPS when its host metrics are empty", async () => {
    // Arrange: requested VPS has neither host metrics nor Docker rows, while
    // another VPS owns a Docker snapshot that must not leak.
    const callbacks: Array<() => unknown> = [];
    const timer = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((cb: () => unknown) => {
        callbacks.push(cb);
        return 0 as never;
      }) as never);
    try {
      const dockerAt = new Date().toISOString();
      const fixture = overviewFixture([dockerSnapshot("vps-b", dockerAt)]);
      fixture.metrics = [metricSample("vps-b", new Date().toISOString())];
      const { service } = arrangeMonitoring(fixture);
      const res = createFakeSseResponse();
      await service.streamForVps(res, "vps-a");
      const tick = callbacks.find((cb) => cb.constructor.name === "AsyncFunction") ?? callbacks[0]!;

      // Act: scoped tick sees no rows for vps-a at all.
      await tick();

      // Assert: scoped authoritative [] is emitted with no cross-VPS leak.
      const updates = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1]!.envelope.payload;
      expect(last.metrics).toEqual([]);
      expect(last.dockerMetrics).toEqual([]);
      expect(JSON.stringify(last)).not.toContain("vps-b");
    } finally {
      timer.mockRestore();
    }
  });

  it("scoped local stream ends and releases timers and activity subscriptions when the host disappears", async () => {
    // Arrange: capture the scoped loop + keepalive intervals so teardown is
    // observable instead of inferred from output.
    const callbacks: Array<() => unknown> = [];
    const setTimer = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((cb: () => unknown) => {
        callbacks.push(cb);
        return callbacks.length as never;
      }) as never);
    const clearTimer = vi.spyOn(globalThis, "clearInterval");
    try {
      const dockerAt = new Date().toISOString();
      const fixture = overviewFixture([dockerSnapshot("vps-a", dockerAt)]);
      const dashboardService = { overview: vi.fn(async () => fixture) };
      const metricService = {
        list: vi.fn(async (vpsId?: string) => {
          if (vpsId) return fixture.metrics.filter((m) => m.vpsId === vpsId);
          return [...fixture.metrics];
        }),
      };
      const jobUnsubscribe = vi.fn();
      const jobActivity = { subscribe: vi.fn(() => jobUnsubscribe) };
      const dockerUnsubscribe = vi.fn();
      const dockerActivity = { subscribe: vi.fn(() => dockerUnsubscribe) };
      const service = new MonitoringService(
        localConfig,
        dashboardService as never,
        metricService as never,
        {} as never,
        {} as never,
        jobActivity as never,
        dockerActivity as never,
      );
      const res = createFakeSseResponse();

      // Act: start an active scoped stream, prove one healthy tick, then delete the host.
      await service.streamForVps(res, "vps-a");
      expect(callbacks.length).toBe(2);
      expect(jobActivity.subscribe).toHaveBeenCalledTimes(1);
      expect(dockerActivity.subscribe).toHaveBeenCalledTimes(1);
      const tick = callbacks.find((cb) => cb.constructor.name === "AsyncFunction") ?? callbacks[0]!;
      await tick();
      const healthyUpdates = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(healthyUpdates.length).toBeGreaterThan(0);
      expect(res.end).not.toHaveBeenCalled();

      fixture.servers = fixture.servers.filter((s) => s.id !== "vps-a");
      await tick();

      // Assert: the vanished host ends the stream and clears its loop interval
      // without emitting another scoped update.
      expect(res.end).toHaveBeenCalledTimes(1);
      expect(clearTimer).toHaveBeenCalledWith(1);
      const updatesAfterDelete = parseSse(res.text()).filter((e) => e.envelope.type === "metrics.updated");
      expect(updatesAfterDelete).toHaveLength(healthyUpdates.length);

      // Assert: the close/finish handlers Express fires release activity
      // subscriptions and the keepalive interval.
      const wireCalls = vi.mocked(res.on).mock.calls.concat(vi.mocked(res.once).mock.calls);
      const endHandlers = wireCalls.filter((call) => call[0] === "close" || call[0] === "finish");
      expect(endHandlers).toHaveLength(4);
      for (const call of endHandlers) call[1]();
      expect(jobUnsubscribe).toHaveBeenCalledTimes(1);
      expect(dockerUnsubscribe).toHaveBeenCalledTimes(1);
      expect(clearTimer).toHaveBeenCalledWith(2);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });
});
