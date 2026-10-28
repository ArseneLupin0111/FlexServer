import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";
import type { AgentCredential } from "../src/agents/agent.models.js";
import { AgentService } from "../src/agents/agent.service.js";
import {
  deriveHostStatus,
  HOST_FRESHNESS_THRESHOLD_MS,
  isFreshTimestamp,
} from "../src/common/host-health.js";
import { deriveDockerPresentation } from "../src/dashboard/dashboard.service.js";
import type { AppConfig } from "../src/config/app-config.js";
import { DashboardService } from "../src/dashboard/dashboard.service.js";
import {
  applyAgentState,
  deriveAgentStatus,
  type VpsRecord,
} from "../src/vps/vps.models.js";
import { VpsService } from "../src/vps/vps.service.js";

const credential: AgentCredential = {
  id: "credential-1",
  vpsId: "vps-1",
  secretHash: "hash",
  status: "active",
  createdAt: "2026-09-14T00:00:00.000Z",
};

function validPayload() {
  return {
    cpu: 10,
    memory: 20,
    disk: 30,
    loadAverage: 0.5,
    networkRx: 100,
    networkTx: 200,
    uptime: 300,
    collectedAt: new Date().toISOString(),
    agentVersion: "1.0.0",
  };
}

function createService(
  append: ReturnType<typeof vi.fn>,
  markSeen: ReturnType<typeof vi.fn>,
) {
  const agentRepository = {
    getCredential: vi.fn().mockResolvedValue(credential),
    // Repository contract: undefined means the heartbeat was not admitted.
    acceptHeartbeat: vi.fn(
      async (input: { lastUsedAt: string; lastUsedIp?: string }) => ({
        ...credential,
        status: "active",
        lastUsedAt: input.lastUsedAt,
        ...(input.lastUsedIp !== undefined
          ? { lastUsedIp: input.lastUsedIp }
          : {}),
      }),
    ),
  };
  const metricRepository = { append };
  const vpsRepository = {
    get: vi
      .fn()
      .mockResolvedValue({ id: "vps-1", dockerMetricsEnabled: false }),
    markSeen,
  };
  const config = { metricWindowLimit: 120 } as AppConfig;

  const service = new AgentService(
    agentRepository as never,
    metricRepository as never,
    vpsRepository as never,
    config,
    new AgentLifecycleCoordinator(),
    { ingest: vi.fn() } as never,
  );
  return { agentRepository, service };
}

const staleRecord: VpsRecord = {
  id: "vps-1",
  name: "stale-host",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  status: "healthy",
  lastSeenAt: "2026-09-14T11:57:59.999Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const localConfig = {
  mode: "local",
  enableWebTerminal: false,
} as AppConfig;

function createVpsService(store: object, agentRepository: object) {
  return new VpsService(
    store as never,
    {} as never,
    {} as never,
    {} as never,
    localConfig,
    {} as never,
    {} as never,
    agentRepository as never,
    {} as never,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("host health freshness", () => {
  it("marks a host unreachable when its last observation reaches the shared threshold", () => {
    // Objective positive case: a valid but stale observation must derive an unreachable host.
    // Arrange
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    const lastSeenAt = new Date(
      now - HOST_FRESHNESS_THRESHOLD_MS,
    ).toISOString();

    // Act
    const status = deriveHostStatus("healthy", lastSeenAt, now);

    // Assert
    expect(status).toBe("unreachable");
  });

  it("does not overwrite an explicit warning when its observation is stale", () => {
    // Objective negative case: stale derivation must not erase an actionable warning state.
    // Arrange
    const now = Date.parse("2026-09-14T12:00:00.000Z");
    const lastSeenAt = new Date(
      now - HOST_FRESHNESS_THRESHOLD_MS - 1,
    ).toISOString();

    // Act
    const status = deriveHostStatus("warning", lastSeenAt, now);

    // Assert
    expect(status).toBe("warning");
  });
});

describe("agent freshness", () => {
  const now = Date.parse("2026-09-14T12:00:00.000Z");

  it.each([
    [119_000, "online"],
    [120_000, "offline"],
    [121_000, "offline"],
  ])("derives online state at %sms as %s", (age, expected) => {
    expect(
      deriveAgentStatus("online", new Date(now - age).toISOString(), now),
    ).toBe(expected);
  });

  it.each([undefined, "not-a-timestamp"])(
    "does not claim online with %s timestamp",
    (lastSeenAt: string | undefined) => {
      expect(deriveAgentStatus("online", lastSeenAt, now)).toBe("offline");
    },
  );

  it.each(["failed", "offline", "installing"] as const)(
    "preserves explicit %s",
    (status) => {
      expect(deriveAgentStatus(status, undefined, now)).toBe(status);
    },
  );

  it("applies the same derivation at the central VPS boundary", () => {
    const state = {
      vpsId: "vps-1",
      status: "online" as const,
      lastSeenAt: new Date(now - 120_000).toISOString(),
    };
    expect(
      applyAgentState({ id: "vps-1" } as VpsRecord, state, now).agentStatus,
    ).toBe("offline");
  });
});

describe("VPS read health", () => {
  it("derives stale healthy records as unreachable in both list and get without persisting changes", async () => {
    // Objective positive case: both VPS read paths expose derived health while leaving storage immutable.
    // Arrange
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"));
    const stored = { ...staleRecord };
    const store = {
      list: vi.fn().mockResolvedValue([stored]),
      get: vi.fn().mockResolvedValue(stored),
    };
    const agentRepository = {
      listStates: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue(undefined),
    };
    const service = createVpsService(store, agentRepository);

    // Act
    const listed = await service.list();
    const fetched = await service.get(stored.id);

    // Assert
    expect(listed[0]?.status).toBe("unreachable");
    expect(fetched.status).toBe("unreachable");
    expect(stored.status).toBe("healthy");
    expect(store).not.toHaveProperty("update");
  });

  it("keeps an online agent host unknown when no host observation exists and derives agent offline", async () => {
    // Objective negative case: agent lifecycle state alone must not fabricate healthy host telemetry.
    // Arrange
    const stored: VpsRecord = {
      ...staleRecord,
      status: "unknown",
      lastSeenAt: undefined,
    };
    const state = { vpsId: stored.id, status: "online" as const };
    const store = {
      list: vi.fn().mockResolvedValue([stored]),
      get: vi.fn().mockResolvedValue(stored),
    };
    const agentRepository = {
      listStates: vi.fn().mockResolvedValue([state]),
      getState: vi.fn().mockResolvedValue(state),
    };
    const service = createVpsService(store, agentRepository);

    // Act
    const listed = await service.list();
    const fetched = await service.get(stored.id);

    // Assert
    expect(listed[0]).toMatchObject({
      status: "unknown",
      agentStatus: "offline",
    });
    expect(fetched).toMatchObject({
      status: "unknown",
      agentStatus: "offline",
    });
    expect(stored).toEqual({
      ...staleRecord,
      status: "unknown",
      lastSeenAt: undefined,
    });
  });
});

describe("dashboard host health", () => {
  it("returns a stale server as unreachable and counts it in the summary without mutating its repository record", async () => {
    // Objective positive case: dashboard server and aggregate views share derived unreachable health.
    // Arrange
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"));
    const stored = { ...staleRecord };
    const dashboard = new DashboardService(
      localConfig,
      { list: vi.fn().mockResolvedValue([stored]) } as never,
      { listLatest: vi.fn().mockResolvedValue([]) } as never,
      {
        listStates: vi.fn().mockResolvedValue([]),
        listSystemInfo: vi.fn().mockResolvedValue([]),
      } as never,
      { list: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
    );

    // Act
    const overview = await dashboard.overview();

    // Assert
    expect(overview.servers[0]?.status).toBe("unreachable");
    expect(overview.summary).toMatchObject({
      totalServers: 1,
      healthyServers: 0,
      unreachableServers: 1,
    });
    expect(stored.status).toBe("healthy");
  });
});

describe("agent ingestion host health", () => {
  it("marks the VPS healthy only after the metric append succeeds", async () => {
    // Objective positive case: an accepted, durable observation updates host health in order.
    // Arrange
    const calls: string[] = [];
    const append = vi.fn(async () => {
      calls.push("append");
    });
    const markSeen = vi.fn(async () => {
      calls.push("markSeen");
    });
    const { agentRepository, service } = createService(append, markSeen);

    // Act
    const result = await service.ingestMetric(credential, validPayload());

    expect(result.sample.vpsId).toBe("vps-1");
    expect(calls).toEqual(["append", "markSeen"]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ vpsId: "vps-1", source: "agent", cpu: 10 }),
      120,
    );
    expect(markSeen).toHaveBeenCalledWith(
      "vps-1",
      "healthy",
      result.sample.receivedAt,
    );
    expect(agentRepository.acceptHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: "credential-1",
        vpsId: "vps-1",
        lastSeenAt: result.sample.receivedAt,
      }),
    );
  });

  it("does not mark the VPS healthy when durable metric append fails", async () => {
    // Objective negative case: failed persistence must not publish a false healthy observation.
    // Arrange
    const appendError = new Error("metric persistence failed");
    const append = vi.fn().mockRejectedValue(appendError);
    const markSeen = vi.fn();
    const { agentRepository, service } = createService(append, markSeen);

    // Act
    const ingestion = service.ingestMetric(credential, validPayload());

    // Assert
    await expect(ingestion).rejects.toThrow("metric persistence failed");
    expect(agentRepository.acceptHeartbeat).toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("does not mark the VPS healthy when the payload VPS id mismatches the credential", async () => {
    // Objective negative case: rejected cross-VPS observations must never update host health.
    // Arrange
    const append = vi.fn();
    const markSeen = vi.fn();
    const { service } = createService(append, markSeen);

    // Act
    const ingestion = service.ingestMetric(credential, {
      ...validPayload(),
      vpsId: "different-vps",
    });

    // Assert
    await expect(ingestion).rejects.toBeInstanceOf(UnauthorizedException);
    expect(append).not.toHaveBeenCalled();
    expect(markSeen).not.toHaveBeenCalled();
  });
});
