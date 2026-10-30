import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test/setup";
import { App } from "./App";
import "./DashboardApp";
import { calculateServerOpsSummary } from "./components/dashboard/servers/ServerOpsSummary";

const fetchMock = vi.fn();

// ── Mock EventSource ──────────────────────────────────────────────────

type EventCallback = (event: MessageEvent) => void;
type OpenCallback = () => void;
type ErrorCallback = (event: Event) => void;

let mockEventSourceInstance: {
  url: string;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: (type: string, data: string) => void;
  triggerOpen: () => void;
  triggerError: () => void;
  onopen: OpenCallback | null;
  onerror: ErrorCallback | null;
} | null = null;

let eventSourceConstructorSpy: ReturnType<typeof vi.fn>;

function createMockEventSource() {
  const listeners = new Map<string, Set<EventCallback>>();
  let closed = false;

  const instance = {
    url: "",
    close: vi.fn(() => {
      closed = true;
    }),
    addEventListener: vi.fn((type: string, callback: EventCallback) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(callback);
    }),
    removeEventListener: vi.fn((type: string, callback: EventCallback) => {
      listeners.get(type)?.delete(callback);
    }),
    dispatchEvent: (type: string, data: string) => {
      if (closed) return;
      const callbacks = listeners.get(type);
      if (callbacks) {
        const event = new MessageEvent(type, { data });
        for (const cb of callbacks) cb(event);
      }
    },
    triggerOpen: () => {
      if (instance.onopen) instance.onopen();
    },
    triggerError: () => {
      if (instance.onerror) instance.onerror(new Event("error"));
    },
    onopen: null as OpenCallback | null,
    onerror: null as ErrorCallback | null,
  };

  return instance;
}

function stubEventSource() {
  mockEventSourceInstance = null;

  eventSourceConstructorSpy = vi.fn((url: string) => {
    const instance = createMockEventSource();
    instance.url = url;
    mockEventSourceInstance = instance;
    return instance;
  });

  vi.stubGlobal("EventSource", eventSourceConstructorSpy);
}

const emptyDashboard = {
  mode: "local",
  summary: {
    totalServers: 0,
    healthyServers: 0,
    warningServers: 0,
    unreachableServers: 0,
    runningJobs: 0,
  },
  servers: [],
  metrics: [],
  jobs: [],
  auditEvents: [],
  terminal: {
    label: "Demo terminal",
    networkAccess: "disabled",
    commands: [],
    sessions: [],
  },
  settings: {
    appMode: "local",
    webTerminalEnabled: false,
    realSshEnabled: false,
    authRequiredInLocalMode: true,
  },
};

function makeEnvelope(type: string, payload: unknown) {
  return JSON.stringify({
    schemaVersion: 1,
    type,
    id: "test-id",
    emittedAt: new Date().toISOString(),
    payload,
  });
}

function authOk(mode: "demo" | "local" = "local", authRequired = true) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: { mode, authenticated: authRequired, authRequired },
    }),
  };
}

function renderApp(initialEntries = ["/vps"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  stubEventSource();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  mockEventSourceInstance = null;
});

describe("React dashboard", () => {
  it("keeps the homepage public and checks authentication when opening the dashboard", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { mode: "local", authenticated: false, authRequired: true },
      }),
    });
    renderApp(["/"]);

    expect(document.querySelector('input[type="password"]')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getAllByRole("link").some(
      (link) => link.getAttribute("href") === "/vps",
    )).toBe(false);
    cleanup();
    renderApp(["/vps"]);

    await waitFor(
      () => expect(document.querySelector('input[type="password"]')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", expect.any(Object));
    expect(eventSourceConstructorSpy).not.toHaveBeenCalled();
  });
  it("calculates healthy and degraded fleet summaries from existing metrics", () => {
    const healthyServer = {
      id: "healthy", name: "healthy", displayName: "Healthy host", host: "host", port: 22, username: "root",
      status: "healthy" as const, agentStatus: "online" as const, keyProvisionedAt: "2026-01-01", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    };
    const degradedServer = {
      ...healthyServer, id: "degraded", name: "degraded", displayName: "Database", status: "warning" as const, agentStatus: "offline" as const,
    };
    const metrics = [{
      vpsId: "healthy", cpu: 22, memory: 91, disk: 48, loadAverage: 1, networkRx: 0, networkTx: 0, uptime: 1,
      collectedAt: "2026-01-01", freshness: "fresh" as const,
    }, {
      vpsId: "degraded", cpu: 78, memory: 65, disk: 95, loadAverage: 1, networkRx: 0, networkTx: 0, uptime: 1,
      collectedAt: "2026-01-01", freshness: "fresh" as const,
    }];
    const docker = [{
      vpsId: "healthy", collectedAt: "2026-01-01", receivedAt: "2026-01-01", agentInstanceId: "agent-healthy", snapshotId: "snapshot-healthy", sourceSequence: "1", schemaVersion: 2 as const, available: true,
      containerTotal: 4, containerRunning: 3, cpuPercent: 0, memoryUsageBytes: 0, networkRxBytes: 0, networkTxBytes: 0,
      blockReadBytes: 0, blockWriteBytes: 0, pids: 0, containers: [],
    }];

    const healthy = calculateServerOpsSummary([healthyServer], metrics.slice(0, 1), []);
    expect(healthy.attention).toBe(0);
    expect(healthy.pressure).toMatchObject({ server: "Healthy host", resource: "Memory", percent: 91 });

    const degraded = calculateServerOpsSummary([healthyServer, degradedServer], metrics, docker);
    expect(degraded.attention).toBe(1);
    expect(degraded.pressure).toMatchObject({ server: "Database", resource: "Disk", percent: 95 });
    expect(degraded.containers).toMatchObject({ running: 3, problems: 1 });
    expect(degraded).toMatchObject({ liveAgents: 1, agentGaps: 1 });
  });
  it("loads VPS list after auth and shows empty state", async () => {
    fetchMock
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: emptyDashboard }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

    renderApp();

    expect(
      await screen.findByText(
        "No VPS servers yet. Add your first server to get started.",
      ),
    ).toBeInTheDocument();
    // Empty state shows a CTA/link to create a new VPS (no inline create form)
    expect(
      screen.getAllByRole("link", { name: "New VPS" }).length,
    ).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/vps", expect.any(Object));
  });

  it("opens VPS list from route", async () => {
    fetchMock
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: emptyDashboard }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

    renderApp(["/vps"]);

    expect(
      await screen.findByText(
        "No VPS servers yet. Add your first server to get started.",
      ),
    ).toBeInTheDocument();
  });

  it("shows successful manual refresh feedback as a top-right status toast", async () => {
    const dashboardResponse = {
      ok: true,
      status: 200,
      json: async () => ({ data: emptyDashboard }),
    };
    const emptyListResponse = {
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    };

    fetchMock
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(dashboardResponse)
      .mockResolvedValueOnce(emptyListResponse)
      .mockResolvedValueOnce(emptyListResponse)
      .mockResolvedValueOnce(emptyListResponse)
      .mockResolvedValueOnce(emptyListResponse)
      .mockResolvedValueOnce(dashboardResponse)
      .mockResolvedValueOnce(emptyListResponse)
      .mockResolvedValueOnce(emptyListResponse)
      .mockResolvedValueOnce(emptyListResponse)
      .mockResolvedValueOnce(emptyListResponse);

    renderApp(["/vps"]);
    await screen.findByText(
      "No VPS servers yet. Add your first server to get started.",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Refresh dashboard" }),
    );

    const toast = await screen.findByRole("status", { name: /VPS list refreshed/i });
    expect(toast).toHaveTextContent("✓VPS list refreshed");
    expect(toast).toHaveClass("fixed", "right-4", "top-4");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("creates a VPS then provisions key only when one-time password is submitted", async () => {
    fetchMock
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: emptyDashboard }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            id: "vps_1",
            name: "prod",
            displayName: "Production Singapore",
            host: "203.0.113.20",
            port: 22,
            username: "root",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: "vps_1", name: "prod" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: emptyDashboard }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "demo-edge-sgp-01",
              name: "edge-sgp-01",
              host: "demo-edge.internal",
              port: 22,
              username: "deploy",
              provider: "Hetzner",
              region: "Singapore",
              tags: ["edge", "public"],
              status: "healthy",
              lastSeenAt: "2026-01-01T00:10:00.000Z",
              notes: "Handles public ingress.",
              keyProvisionedAt: "2026-01-01T00:05:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

    renderApp();

    await screen.findByText(
      "No VPS servers yet. Add your first server to get started.",
    );

    // The create form now lives on /vps/new; navigate there via the "New VPS" CTA
    await userEvent.click(
      screen.getAllByRole("link", { name: "New VPS" })[0],
    );

    const displayNameInput = screen.getByLabelText("Display name");
    expect(displayNameInput).toHaveAttribute("required");
    expect(displayNameInput).toHaveAttribute("maxlength", "80");
    expect(displayNameInput).toHaveAccessibleDescription(
      "A friendly label shown throughout the dashboard (1–80 characters).",
    );
    await userEvent.type(displayNameInput, "Production Singapore");
    await userEvent.type(screen.getByLabelText("Name"), "prod");
    await userEvent.type(screen.getByLabelText("Host / IP"), "203.0.113.20");
    await userEvent.type(screen.getByLabelText(/Username/i), "root");
    await userEvent.type(
      screen.getByLabelText(/Optional password/i),
      "secret-once",
    );
    await userEvent.click(screen.getByRole("button", { name: /Create VPS/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/vps",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "prod",
          displayName: "Production Singapore",
          host: "203.0.113.20",
          port: 22,
          username: "root",
        }),
      }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/vps/vps_1/provision-key",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ password: "secret-once" }),
        }),
      ),
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("renders demo VPS list from dashboard data", async () => {
    fetchMock
      .mockResolvedValueOnce(authOk("demo", false))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            mode: "demo",
            banner: "Demo mode: simulated servers, no real SSH connections.",
            summary: {
              totalServers: 3,
              healthyServers: 1,
              warningServers: 1,
              unreachableServers: 1,
              runningJobs: 1,
            },
            servers: [
              {
                id: "demo-edge-sgp-01",
                name: "edge-sgp-01",
                host: "demo-edge.internal",
                port: 22,
                username: "deploy",
                provider: "Hetzner",
                region: "Singapore",
                tags: ["edge", "public"],
                status: "healthy",
                lastSeenAt: "2026-01-01T00:10:00.000Z",
                notes: "Handles public ingress.",
                keyProvisionedAt: "2026-01-01T00:05:00.000Z",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "demo-api-fra-02",
                name: "api-fra-02",
                host: "demo-api.internal",
                port: 22,
                username: "deploy",
                status: "warning",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "demo-worker-sfo-01",
                name: "worker-sfo-01",
                host: "demo-worker.internal",
                port: 22,
                username: "deploy",
                status: "unreachable",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            metrics: [
              {
                vpsId: "demo-edge-sgp-01",
                cpu: 22,
                memory: 48,
                disk: 61,
                loadAverage: 0.41,
                networkRx: 128_400,
                networkTx: 93_200,
                uptime: 691_200,
                collectedAt: new Date().toISOString(),
                freshness: "fresh",
              },
            ],
            jobs: [
              {
                id: "job_demo_queued",
                vpsId: "demo-worker-sfo-01",
                type: "check disk usage",
                status: "queued",
                progress: 0,
                workerId: "worker-queue-01",
              },
              {
                id: "job_demo_collect_metrics",
                vpsId: "demo-edge-sgp-01",
                type: "collect metrics",
                status: "running",
                progress: 64,
                workerId: "worker-metrics-01",
              },
              {
                id: "job_demo_verify_key",
                vpsId: "demo-api-fra-02",
                type: "verify key",
                status: "succeeded",
                progress: 100,
                workerId: "worker-crypto-02",
              },
            ],
            auditEvents: [
              {
                id: "audit_demo_dashboard_view",
                actor: "demo",
                action: "demo.dashboard.view",
                resourceType: "dashboard",
                result: "success",
                timestamp: "2026-01-01T00:00:00.000Z",
              },
            ],
            terminal: {
              label: "Demo terminal",
              networkAccess: "disabled",
              commands: ["uptime", "df -h"],
              sessions: [{ command: "uptime", output: "up 8 days" }],
            },
            settings: {
              appMode: "demo",
              webTerminalEnabled: false,
              realSshEnabled: false,
              authRequiredInLocalMode: true,
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "demo-edge-sgp-01",
              name: "edge-sgp-01",
              host: "demo-edge.internal",
              port: 22,
              username: "deploy",
              provider: "Hetzner",
              region: "Singapore",
              tags: ["edge", "public"],
              status: "healthy",
              lastSeenAt: "2026-01-01T00:10:00.000Z",
              notes: "Handles public ingress.",
              keyProvisionedAt: "2026-01-01T00:05:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "job_demo_queued",
              vpsId: "demo-worker-sfo-01",
              type: "check disk usage",
              status: "queued",
              progress: 0,
            },
            {
              id: "job_demo_collect_metrics",
              vpsId: "demo-edge-sgp-01",
              type: "collect metrics",
              status: "running",
              progress: 64,
            },
            {
              id: "job_demo_verify_key",
              vpsId: "demo-api-fra-02",
              type: "verify key",
              status: "succeeded",
              progress: 100,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              vpsId: "demo-edge-sgp-01",
              cpu: 22,
              memory: 48,
              disk: 61,
              loadAverage: 0.41,
              networkRx: 128_400,
              networkTx: 93_200,
              uptime: 691_200,
              collectedAt: new Date().toISOString(),
              freshness: "fresh",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "audit_demo_dashboard_view",
              actor: "demo",
              action: "demo.dashboard.view",
              resourceType: "dashboard",
              result: "success",
              timestamp: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      });

    renderApp();

    // Wait for server cards to be visible after data loads
    expect(await screen.findByRole("heading", { name: "edge-sgp-01" })).toBeInTheDocument();
    // Compact app bar breadcrumb navigation should be present (sidebar removed)
    expect(
      screen.getByRole("navigation", { name: "Dashboard context" }),
    ).toBeInTheDocument();
    // CTA/link to create a new VPS is present in the list header
    expect(
      screen.getByRole("link", { name: "New VPS" }),
    ).toBeInTheDocument();
  });

  it("filters VPS cards without storing secrets", async () => {
    const localDashboard = {
      ...emptyDashboard,
      mode: "demo",
      settings: { ...emptyDashboard.settings, appMode: "demo" },
    };
    fetchMock
      .mockResolvedValueOnce(authOk("demo", false))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: localDashboard }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "vps_1",
              name: "prod-sgp-01",
              displayName: "Primary production",
              host: "203.0.113.20",
              port: 22,
              username: "root",
              provider: "Linode",
              region: "Singapore",
              tags: ["prod"],
              status: "healthy",
              lastSeenAt: "2026-01-01T00:00:00.000Z",
              notes: "Primary node",
              keyProvisionedAt: "2026-01-01T00:00:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "vps_2",
              name: "dev-fra-01",
              host: "203.0.113.21",
              port: 22,
              username: "deploy",
              provider: "OVH",
              region: "Frankfurt",
              tags: ["dev"],
              status: "warning",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

    renderApp();

    expect(await screen.findByRole("heading", { name: "Primary production" })).toBeInTheDocument();
    expect(screen.queryByText("prod-sgp-01")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search servers"), "ovh");
    expect(screen.queryByText("prod-sgp-01")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "dev-fra-01" })).toBeInTheDocument();
  });

  describe("SSE live monitoring events", () => {
    function renderAppWithLiveEvents(mockData: any) {
      fetchMock
        .mockResolvedValueOnce(authOk("demo", false))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: mockData.dashboard }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: mockData.servers }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: mockData.jobs }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: mockData.metrics }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: mockData.auditEvents }),
        });

      renderApp();
      return mockEventSourceInstance;
    }

    const demoDashboard = {
      mode: "demo",
      banner: "Demo mode: simulated servers, no real SSH connections.",
      summary: {
        totalServers: 3,
        healthyServers: 1,
        warningServers: 1,
        unreachableServers: 1,
        runningJobs: 1,
      },
      servers: [],
      metrics: [],
      jobs: [],
      auditEvents: [],
      terminal: {
        label: "Demo terminal",
        networkAccess: "disabled",
        commands: [],
        sessions: [],
      },
      settings: {
        appMode: "demo",
        webTerminalEnabled: false,
        realSshEnabled: false,
        authRequiredInLocalMode: true,
      },
    };

    const demoServerRecords = [
      {
        id: "vps-1",
        name: "web-01",
        host: "10.0.0.1",
        port: 22,
        username: "root",
        status: "healthy",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    it("unknown event types are ignored without crashing", async () => {
      renderAppWithLiveEvents({
        dashboard: demoDashboard,
        servers: demoServerRecords,
        jobs: [],
        metrics: [],
        auditEvents: [],
      });

      // Wait for VPS list to load
      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();

      // Dispatch an unknown event type
      mockEventSourceInstance?.dispatchEvent(
        "unknown.event",
        makeEnvelope("unknown.event", { foo: "bar" }),
      );

      // App should still be functional
      expect(screen.getByRole("heading", { name: "web-01" })).toBeInTheDocument();

      // Dispatch a valid metrics.updated to ensure it still works
      const metricsPayload = {
        metrics: [
          {
            vpsId: "vps-1",
            cpu: 55,
            memory: 70,
            disk: 60,
            loadAverage: 1.0,
            networkRx: 100000,
            networkTx: 50000,
            uptime: 3600,
            collectedAt: new Date().toISOString(),
            freshness: "fresh" as const,
          },
        ],
      };

      mockEventSourceInstance?.dispatchEvent(
        "metrics.updated",
        makeEnvelope("metrics.updated", metricsPayload),
      );

      // Server card still shown
      expect(screen.getByRole("heading", { name: "web-01" })).toBeInTheDocument();

      expect(localStorage.length).toBe(0);
    });

    it("shows live connection state in header", async () => {
      renderAppWithLiveEvents({
        dashboard: { ...demoDashboard, mode: "local" },
        servers: demoServerRecords,
        jobs: [],
        metrics: [],
        auditEvents: [],
      });

      // Initially shows Connecting (EventSource is opened)
      await waitFor(() => {
        expect(screen.getByText("Connecting")).toBeInTheDocument();
      });
      expect(screen.getByText("Local environment")).toBeInTheDocument();
      expect(screen.getByRole("status", { name: "Monitoring connection: Connecting" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open local admin account menu" })).toHaveAttribute("title", "Local admin account");

      // Simulate hello event which transitions to Live
      mockEventSourceInstance?.dispatchEvent(
        "monitoring.hello",
        makeEnvelope("monitoring.hello", { mode: "local", intervalMs: 5000 }),
      );

      await waitFor(() => {
        expect(screen.getByText("Live")).toBeInTheDocument();
      });
      expect(screen.getByRole("status", { name: "Monitoring connection: Live" })).toBeInTheDocument();
      expect(screen.queryByText(/\d{1,2}:\d{2}:\d{2}/)).not.toBeInTheDocument();

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

    it("recovers from a refreshRequired snapshot by refetching over HTTP and keeps applying later metrics", async () => {
      renderAppWithLiveEvents({
        dashboard: demoDashboard,
        servers: demoServerRecords,
        jobs: [],
        metrics: [
          {
            vpsId: "vps-1",
            cpu: 11.1,
            memory: 30,
            disk: 40,
            loadAverage: 0.5,
            networkRx: 0,
            networkTx: 0,
            uptime: 600,
            collectedAt: new Date().toISOString(),
            freshness: "fresh" as const,
          },
        ],
        auditEvents: [],
      });

      // Initial HTTP load renders the server card with its first metric.
      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();
      expect(await screen.findByText("11.1%")).toBeInTheDocument();

      // The bounded snapshot cannot carry the overview, so the next refetch
      // must come from HTTP: dashboard, servers, jobs, metrics, audit.
      const refreshedServer = { ...demoServerRecords[0], displayName: "web-01 refreshed" };
      fetchMock.mockClear();
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: demoDashboard }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [refreshedServer] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                vpsId: "vps-1",
                cpu: 42.5,
                memory: 55,
                disk: 60,
                loadAverage: 1.2,
                networkRx: 0,
                networkTx: 0,
                uptime: 900,
                collectedAt: new Date().toISOString(),
                freshness: "fresh" as const,
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });

      mockEventSourceInstance?.dispatchEvent(
        "monitoring.snapshot",
        makeEnvelope("monitoring.snapshot", { refreshRequired: true }),
      );

      // Refreshed HTTP data replaces the pre-refresh state on screen.
      expect(
        await screen.findByRole("heading", { name: "web-01 refreshed" }),
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("/api/dashboard", expect.any(Object));
      expect(await screen.findByText("42.5%")).toBeInTheDocument();
      expect(screen.queryByText("11.1%")).not.toBeInTheDocument();

      // The same live channel still merges metrics after the refetch.
      mockEventSourceInstance?.dispatchEvent(
        "metrics.updated",
        makeEnvelope("metrics.updated", {
          metrics: [
            {
              vpsId: "vps-1",
              cpu: 87.5,
              memory: 70,
              disk: 65,
              loadAverage: 2.4,
              networkRx: 1024,
              networkTx: 2048,
              uptime: 950,
              collectedAt: new Date().toISOString(),
              freshness: "fresh" as const,
            },
          ],
        }),
      );

      expect(await screen.findByText("87.5%")).toBeInTheDocument();
      expect(screen.queryByText("42.5%")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "web-01 refreshed" })).toBeInTheDocument();
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });

  });

  describe("Phase 1-2 fixes", () => {
    const twoServersDashboard = {
      mode: "local",
      banner: "Test mode",
      summary: {
        totalServers: 2,
        healthyServers: 1,
        warningServers: 0,
        unreachableServers: 1,
        runningJobs: 0,
      },
      servers: [],
      metrics: [],
      jobs: [],
      auditEvents: [],
      terminal: {
        label: "Terminal",
        networkAccess: "disabled",
        commands: [],
        sessions: [],
      },
      settings: {
        appMode: "local",
        webTerminalEnabled: false,
        realSshEnabled: false,
        authRequiredInLocalMode: true,
      },
    };

    const twoServerRecords = [
      {
        id: "vps-1",
        name: "web-01",
        host: "10.0.0.1",
        port: 22,
        username: "root",
        status: "healthy",
        keyProvisionedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "vps-2",
        name: "db-01",
        host: "10.0.0.2",
        port: 22,
        username: "root",
        status: "unreachable",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    it("keeps host status, agent, and access labels independent across card and table views", async () => {
      const records = [
        {
          id: "unknown-host",
          name: "unknown-host",
          host: "203.0.113.30",
          port: 22,
          username: "root",
          status: "unknown",
          agentStatus: "online",
          keyProvisionedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "local-host",
          name: "3e6f37c57a5f",
          host: "127.0.0.1",
          port: 22,
          username: "root",
          status: "healthy",
          kind: "local",
          managedBy: "system",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "friendly-host",
          name: "generated-name",
          displayName: "Friendly production",
          host: "198.51.100.40",
          port: 22,
          username: "deploy",
          status: "healthy",
          keyProvisionedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: twoServersDashboard }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: records }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });

      renderApp(["/vps"]);

      expect(await screen.findByRole("heading", { name: "Friendly production" })).toBeInTheDocument();
      expect(screen.queryByText("generated-name")).not.toBeInTheDocument();
      expect(screen.getByRole("article", { name: "Server Local Server" })).toBeInTheDocument();
      expect(screen.getByRole("article", { name: "Server Friendly production" })).toBeInTheDocument();
      expect(screen.getAllByLabelText("Host status: Healthy")[0]).toHaveTextContent("Healthy");
      expect(within(screen.getByRole("article", { name: "Server unknown-host" })).queryByLabelText("Host status: Unknown")).not.toBeInTheDocument();
      expect(screen.getAllByText("Agent online").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Key ready").length).toBeGreaterThan(0);

      await userEvent.click(screen.getByRole("button", { name: "Table view" }));
      expect(screen.getByText("Host status")).toBeInTheDocument();
      expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Access").length).toBeGreaterThan(0);
      expect(screen.getByRole("link", { name: "Local Server" })).toHaveAttribute("title", "Host ID: 3e6f37c57a5f");
      expect(within(screen.getByRole("row", { name: "Server unknown-host" })).queryByLabelText("Host status: Unknown")).not.toBeInTheDocument();
    });

    it("renders an API-reported offline agent as Offline and preserves last-seen context", async () => {
      const lastSeenAt = "2026-01-02T03:04:05.000Z";
      const offlineRecord = {
        ...twoServerRecords[0],
        displayName: "Stale agent host",
        agentStatus: "offline",
        lastSeenAt,
      };
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: twoServersDashboard }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [offlineRecord] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });

      renderApp(["/vps"]);

      const card = await screen.findByRole("article", { name: "Server Stale agent host" });
      expect(within(card).getByText("Agent offline")).toBeInTheDocument();
      expect(within(card).queryByText("Agent online")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Table view" }));
      const row = screen.getByRole("row", { name: "Server Stale agent host" });
      expect(within(row).getByLabelText("Agent status: Offline")).toBeInTheDocument();
      expect(within(row).queryByLabelText("Agent status: Online")).not.toBeInTheDocument();
      expect(within(row).getByTitle(`Last seen: ${new Date(lastSeenAt).toLocaleString()}`)).not.toHaveTextContent("Never");
    });
    it("distinguishes stale heartbeat from explicit unreachable without false power or down claims", async () => {
      const staleServer = {
        ...twoServerRecords[0],
        id: "vps-stale",
        name: "stale-host",
        displayName: "Stale Telemetry Host",
        status: "unknown" as const,
        agentStatus: "offline" as const,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const unreachableServer = {
        ...twoServerRecords[1],
        id: "vps-unreachable",
        name: "unreachable-host",
        displayName: "Unreachable Host",
        status: "unreachable" as const,
        agentStatus: "offline" as const,
      };

      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: twoServersDashboard }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [staleServer, unreachableServer] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });

      renderApp(["/vps"]);

      const staleCard = await screen.findByRole("article", { name: "Server Stale Telemetry Host" });
      const unreachableCard = screen.getByRole("article", { name: "Server Unreachable Host" });

      // A stale heartbeat is already conveyed by the agent label, not a second host badge.
      expect(within(staleCard).getByText("Agent offline")).toBeInTheDocument();
      expect(within(staleCard).queryByLabelText("Host status: Unknown")).not.toBeInTheDocument();
      expect(within(staleCard).queryByText("Down")).not.toBeInTheDocument();
      expect(within(staleCard).queryByText("Unreachable")).not.toBeInTheDocument();
      expect(within(staleCard).queryByText(/check power/i)).not.toBeInTheDocument();
      expect(within(staleCard).queryByText(/no heartbeat/i)).not.toBeInTheDocument();

      // Explicit unreachable host is labelled Unreachable, not Down, without generic heartbeat/power banner
      expect(within(unreachableCard).getByText("Unreachable")).toBeInTheDocument();
      expect(within(unreachableCard).getByLabelText("Host status: Unreachable")).toBeInTheDocument();
      expect(within(unreachableCard).queryByText("Down")).not.toBeInTheDocument();
      expect(within(unreachableCard).getByText(/host is unreachable/i)).toBeInTheDocument();
      expect(within(unreachableCard).queryByText(/check power/i)).not.toBeInTheDocument();

      // Fleet counter shows reporting semantics
      expect(screen.getAllByText("0/2 REPORTING").length).toBeGreaterThan(0);
      expect(screen.queryByText(/HOSTS ONLINE/i)).not.toBeInTheDocument();

      // The table retains explicit host evidence without duplicating unknown agent state.
      await userEvent.click(screen.getByRole("button", { name: "Table view" }));
      const staleRow = screen.getByRole("row", { name: "Server Stale Telemetry Host" });
      const unreachableRow = screen.getByRole("row", { name: "Server Unreachable Host" });

      expect(within(staleRow).queryByText("Unknown")).not.toBeInTheDocument();
      expect(within(staleRow).getByText("Offline")).toBeInTheDocument();
      expect(within(staleRow).queryByText("Down")).not.toBeInTheDocument();

      expect(within(unreachableRow).getByText("Unreachable")).toBeInTheDocument();
      expect(within(unreachableRow).queryByText("Down")).not.toBeInTheDocument();
    });


    it("keeps the API's removed-agent state after a past successful install job", async () => {
      const removedRecord = {
        ...twoServerRecords[0],
        displayName: "Removed agent host",
        agentStatus: "not_installed" as const,
        lastAgentInstallJobId: "install-1",
      };
      const priorInstall = {
        id: "install-1", vpsId: removedRecord.id, type: "install-agent", status: "succeeded",
        step: "complete", progress: 100, startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
      };
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: twoServersDashboard }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ ...removedRecord, agentStatus: "offline" }] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [priorInstall] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });

      renderApp(["/vps"]);
      const card = await screen.findByRole("article", { name: "Server Removed agent host" });
      expect(within(card).getByText("Agent offline")).toBeInTheDocument();

      mockEventSourceInstance?.dispatchEvent("metrics.updated", makeEnvelope("metrics.updated", {
        metrics: [], servers: [removedRecord],
      }));
      expect(await within(card).findByText("Agent not installed")).toBeInTheDocument();
      expect(within(card).queryByText("Agent online")).not.toBeInTheDocument();
    });

    it("keeps fleet cards focused on navigation", async () => {
      const onlineRecord = { ...twoServerRecords[0], displayName: "Online worker", agentStatus: "online", keyProvisionedAt: "2026-01-01T00:00:00.000Z" };
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: twoServersDashboard }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [onlineRecord] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });

      renderApp(["/vps"]);
      const card = await screen.findByRole("article", { name: "Server Online worker" });
      expect(within(card).getByRole("link", { name: "Manage Online worker" })).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "Verify access" })).not.toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "More actions for Online worker" })).not.toBeInTheDocument();
    });

    it("shows 404 page for unknown routes", async () => {
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServersDashboard }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServerRecords }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });

      renderApp(["/some-old-route"]);

      expect(await screen.findByText("404")).toBeInTheDocument();
      expect(screen.getByText("Page not found.")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Go to VPS list" }),
      ).toBeInTheDocument();
    });

    it("shows Manage link in card view for each VPS", async () => {
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServersDashboard }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServerRecords }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });

      renderApp(["/vps"]);

      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();

      // Each card should have a Manage link
      const manageLinks = screen.getAllByRole("link", { name: /Manage/i });
      expect(manageLinks.length).toBe(2);
      expect(manageLinks[0]).toHaveAttribute("href", "/vps/vps-1");
      expect(manageLinks[1]).toHaveAttribute("href", "/vps/vps-2");
    });

    it("shows live agent progress from jobs.updated without a refresh", async () => {
      const installingRecords = [
        {
          ...twoServerRecords[0],
          agentStatus: "installing",
          lastAgentInstallJobId: "agent-job-1",
        },
      ];
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: twoServersDashboard }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: installingRecords }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });

      renderApp(["/vps"]);
      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();

      mockEventSourceInstance?.dispatchEvent(
        "jobs.updated",
        makeEnvelope("jobs.updated", {
          jobs: [{
            id: "agent-job-1",
            vpsId: "vps-1",
            type: "install-agent",
            status: "running",
            step: "uploading-binary",
            progress: 30,
          }],
        }),
      );

      expect(await screen.findByText("Uploading agent")).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: /Agent install: Uploading agent/i })).toHaveAttribute("aria-valuenow", "30");
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("updates agent availability when an install job succeeds without a page refresh", async () => {
      const installing = { ...twoServerRecords[0], agentStatus: "installing" as const, lastAgentInstallJobId: "agent-job-1" };
      const installed = { ...installing, agentStatus: "online" as const };
      const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(ok(twoServersDashboard))
        .mockResolvedValueOnce(ok([installing]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok(twoServersDashboard))
        .mockResolvedValueOnce(ok([installed]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]));

      renderApp(["/vps"]);
      const card = await screen.findByRole("article", { name: "Server web-01" });
      mockEventSourceInstance?.dispatchEvent("jobs.updated", makeEnvelope("jobs.updated", {
        jobs: [{ id: "agent-job-1", vpsId: "vps-1", type: "install-agent", status: "running", progress: 90 }],
      }));
      expect(await within(card).findByRole("progressbar")).toBeInTheDocument();

      mockEventSourceInstance?.dispatchEvent("jobs.updated", makeEnvelope("jobs.updated", {
        jobs: [{ id: "agent-job-1", vpsId: "vps-1", type: "install-agent", status: "succeeded", progress: 100 }],
      }));
      expect(await within(card).findByText("Agent online")).toBeInTheDocument();
      expect(within(card).queryByText("Agent not installed")).not.toBeInTheDocument();
    });

    it("does not let an older dashboard response undo a completed agent install", async () => {
      const installing = { ...twoServerRecords[0], agentStatus: "installing" as const, lastAgentInstallJobId: "agent-job-1" };
      const installed = { ...installing, agentStatus: "online" as const };
      const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
      let resolveOldJobs!: (value: ReturnType<typeof ok>) => void;
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce(ok(twoServersDashboard))
        .mockResolvedValueOnce(ok([installing]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok(twoServersDashboard))
        .mockResolvedValueOnce(ok([installing]))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveOldJobs = resolve; }))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok(twoServersDashboard))
        .mockResolvedValueOnce(ok([installed]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok([]));

      renderApp(["/vps"]);
      const card = await screen.findByRole("article", { name: "Server web-01" });
      await userEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(11));
      mockEventSourceInstance?.dispatchEvent("jobs.updated", makeEnvelope("jobs.updated", {
        jobs: [{ id: "agent-job-1", vpsId: "vps-1", type: "install-agent", status: "succeeded", progress: 100 }],
      }));
      expect(await within(card).findByText("Agent online")).toBeInTheDocument();
      await act(async () => { resolveOldJobs(ok([])); });
      expect(within(card).getByText("Agent online")).toBeInTheDocument();
    });

    it("keeps card actions out of the fleet list", async () => {
      const onlineRecords = [{ ...twoServerRecords[0], agentStatus: "online" as const }];
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: twoServersDashboard }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: onlineRecords }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });

      renderApp(["/vps"]);
      const card = await screen.findByRole("article", { name: "Server web-01" });
      expect(within(card).getByRole("link", { name: "Manage web-01" })).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "Verify access" })).not.toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "More actions for web-01" })).not.toBeInTheDocument();
    });

    it("shows login gate after logout when auth is required", async () => {
      fetchMock
        .mockResolvedValueOnce(authOk("local", true))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServersDashboard }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServerRecords }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        // Logout API call
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: { ok: true } }),
        });

      renderApp(["/vps"]);

      // Wait for server list to load
      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();

      // Open user menu dropdown and click Log out
      await userEvent.click(
        screen.getByRole("button", { name: "Open local admin account menu" }),
      );

      // Wait for the logout option to be available
      const logoutButton = await screen.findByText("Log out");
      expect(logoutButton).toBeInTheDocument();

      await userEvent.click(logoutButton);

      // After logout, should see the login gate (not the dashboard)
      await waitFor(() => expect(document.querySelector('input[type="password"]')).toBeInTheDocument());
      expect(screen.queryByRole("heading", { name: "web-01" })).not.toBeInTheDocument();

      // Verify logout API was called
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("shows VPS not found for non-existent VPS ID after data loads", async () => {
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServersDashboard }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServerRecords }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });

      renderApp(["/vps/non-existent-vps"]);

      expect(await screen.findByText("VPS not found.")).toBeInTheDocument();
    });
  });

  describe("Phase 5 — workspace structure and scoped APIs", () => {
    const twoServers = [
      {
        id: "vps-1",
        name: "web-01",
        host: "10.0.0.1",
        port: 22,
        username: "root",
        status: "healthy",
        keyProvisionedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "vps-2",
        name: "db-01",
        host: "10.0.0.2",
        port: 22,
        username: "root",
        status: "unreachable",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const dashboardData = {
      mode: "local",
      summary: {
        totalServers: 2,
        healthyServers: 1,
        warningServers: 0,
        unreachableServers: 1,
        runningJobs: 0,
      },
      servers: [],
      metrics: [],
      dockerMetrics: [
        {
          vpsId: "vps-1",
          collectedAt: "2026-01-01T00:00:00.000Z",
          receivedAt: "2026-01-01T00:00:01.000Z",
          agentInstanceId: "agent-1",
          snapshotId: "snapshot-1",
          sourceSequence: "1",
          agentVersion: "1.2.3",
          schemaVersion: 2,
          available: true,
          containerTotal: 2,
          containerRunning: 1,
          cpuPercent: 12.5,
          memoryUsageBytes: 268435456,
          networkRxBytes: 1024,
          networkTxBytes: 2048,
          blockReadBytes: 4096,
          blockWriteBytes: 8192,
          pids: 9,
          containers: [
            {
              containerKey: "workspace-api",
              name: "workspace-api",
              image: "app:latest",
              state: "running",
              status: "Up 2 minutes",
              cpuPercent: 10,
              memoryUsageBytes: 134217728,
              networkRxBytes: 100,
              networkTxBytes: 200,
              blockReadBytes: 300,
              blockWriteBytes: 400,
              pids: 4,
            },
          ],
        },
      ],
      jobs: [],
      auditEvents: [],
      terminal: {
        label: "Terminal",
        networkAccess: "disabled",
        commands: [],
        sessions: [],
      },
      settings: {
        appMode: "local",
        webTerminalEnabled: false,
        realSshEnabled: false,
        authRequiredInLocalMode: true,
      },
    };

    function mockDashboardAndScoped() {
      fetchMock
        .mockResolvedValueOnce(authOk())
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: dashboardData }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServers }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        // Scoped bootstrap calls
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        });
    }

    it("shows 404 for old top-level routes like /overview, /servers, /jobs, /metrics, /audit, /terminal, /settings", async () => {
      const oldRoutes = [
        "/overview",
        "/servers",
        "/jobs",
        "/metrics",
        "/audit",
        "/terminal",
        "/settings",
      ];
      for (const route of oldRoutes) {
        cleanup();
        fetchMock.mockReset();
        mockDashboardAndScoped();
        renderApp([route]);
        expect(await screen.findByText("404")).toBeInTheDocument();
        expect(screen.getByText("Page not found.")).toBeInTheDocument();
      }
    });

    it("renders create form at /vps/new, not VPS not found / workspace", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/new"]);

      // Should show the create form header ("New VPS" in the content area h2), not a workspace or 404
      await waitFor(() => {
        const newVpsHeadings = screen.getAllByText("New VPS");
        expect(newVpsHeadings.length).toBeGreaterThanOrEqual(1);
      });
      expect(screen.getByText(/Password is optional/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Create VPS/i }),
      ).toBeInTheDocument();
      // VPS not found must not appear
      expect(screen.queryByText("VPS not found.")).not.toBeInTheDocument();
    });

    it("renders VPS workspace for valid VPS id, showing server name", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/vps-1"]);

      // Wait for dashboard to load and VPS workspace to render
      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();
      // Workspace header shows the endpoint as username@host:port
      expect(screen.getByText("root@10.0.0.1:22")).toBeInTheDocument();
      // Overview tab should be active by default
      expect(screen.getByText("Overview")).toBeInTheDocument();
    });

    it("renders workspace jobs page for /vps/:id/jobs", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/vps-1/jobs"]);

      expect(await screen.findByText("Jobs for web-01")).toBeInTheDocument();
      // The identity banner/resource strip lives on the Overview only.
      expect(screen.queryByRole("heading", { name: /^web-01$/ })).not.toBeInTheDocument();
      expect(screen.queryByText("root@10.0.0.1:22")).not.toBeInTheDocument();
    });

    it("renders workspace metrics page for /vps/:id/metrics", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/vps-1/metrics"]);

      expect(await screen.findByText("Metrics for web-01")).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Docker metrics" })).not.toBeInTheDocument();
    });

    it("renders Docker monitoring as its own workspace tab", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/vps-1/docker"]);

      await screen.findByRole("link", { name: "Docker" });
      const dockerTab = screen.getByRole("link", { name: "Docker" });
      expect(dockerTab).toHaveAttribute("href", "/vps/vps-1/docker");
      const workloads = await screen.findByRole("region", { name: "Docker metrics" });
      expect(within(workloads).getByText("workspace-api")).toBeInTheDocument();
      expect(within(workloads).getByText("app:latest")).toBeInTheDocument();
      expect(within(workloads).getByRole("region", { name: "Docker metrics summary" })).toHaveTextContent("1/2");
    });

    it("does not embed Docker monitoring in the workspace overview", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/vps-1"]);

      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Docker monitoring" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Docker" })).toHaveAttribute("href", "/vps/vps-1/docker");
    });



    it("shows 404 for unknown workspace sub-route /vps/:id/unknown", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/vps-1/unknown"]);

      expect(await screen.findByText("404")).toBeInTheDocument();
      expect(screen.getByText("Page not found.")).toBeInTheDocument();
    });

    it("logs out from workspace route back to login gate", async () => {
      fetchMock
        .mockResolvedValueOnce(authOk("local", true))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: dashboardData }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: twoServers }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        // Logout API call
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: { ok: true } }),
        });

      renderApp(["/vps/vps-1"]);

      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Open local admin account menu" }),
      );
      const logoutButton = await screen.findByText("Log out");
      await userEvent.click(logoutButton);

      await waitFor(() => expect(document.querySelector('input[type="password"]')).toBeInTheDocument());
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("requests scoped APIs for current VPS", async () => {
      mockDashboardAndScoped();

      renderApp(["/vps/vps-1"]);

      // Wait for workspace to render
      expect(await screen.findByRole("heading", { name: "web-01" })).toBeInTheDocument();

      // The scoped bootstrap calls should have been made (called without params, so no query string)
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/vps/vps-1/metrics",
          expect.any(Object),
        );
      });
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/vps/vps-1/jobs",
          expect.any(Object),
        );
      });
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/vps/vps-1/audit",
          expect.any(Object),
        );
      });
    });

    // ── Settings Agent card (AI policy, exec mode, AI bundle) ──────────

    const agentPolicyFixture = {
      vpsId: "vps-1",
      dockerActionsEnabled: true,
      aiEnabled: false,
      composeActionsEnabled: true,
      shellEnabled: false,
      execMode: "sandbox",
      privilegedAcknowledgedAt: null as string | null,
      privilegedAcknowledgedBy: null as string | null,
      executionMode: "manual" as const,
      yoloAcknowledgedAt: null as string | null,
      yoloAcknowledgedBy: null as string | null,
      fileReadScopes: [],
      fileWriteScopes: [],
      serviceProfileIds: [],
      sendLogsToProvider: false,
      sendFilesToProvider: false,
      revision: 11,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const aiBundleFixture = {
      available: true,
      reason: undefined as string | undefined,
      bundleId: "b1234567890abcdef",
      installed: true,
      lastInstalledBundleId: "b1234567890abcdef" as string | null,
      lastJob: null as {
        state: string;
        error: string | null;
        startedAt: string;
        finishedAt: string | null;
      } | null,
      capability: {
        supported: false,
        reason: "sandbox_unavailable: cgroup v2 is not mounted on this host",
        agentVersion: "0.9.0",
        privilegedSupported: true,
      },
    };

    const aiCapabilityFixture = {
      vpsId: "vps-1",
      supported: false,
      reason: "legacy capability reason",
      freshness: "2026-01-01T00:00:00.000Z",
      agentVersion: "0.9.0",
      protocolVersion: 3,
      cgroupV2Available: false,
      namespacesAvailable: true,
      seccompAvailable: true,
      profiles: [],
    };

    function aiOk(data: unknown, status = 200) {
      return { ok: true, status, json: async () => ({ data }) };
    }

    // Fetch server for the settings route: emulates the policy PATCH CAS
    // (server-side revision bump + privileged acknowledgment recording) and
    // the AI bundle status endpoints. `bundle === null` simulates an older API
    // without the bundle route (404) so the card must degrade gracefully.
    function mockSettingsAiServer(options: {
      policy: typeof agentPolicyFixture;
      bundle?: typeof aiBundleFixture | null;
    }) {
      const state = { ...options.policy };
      const patchBodies: Record<string, unknown>[] = [];
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth/me") return authOk();
        if (url === "/api/vps/vps-1/ai/policy" && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          patchBodies.push(body);
          state.revision += 1;
          if (typeof body.aiEnabled === "boolean") state.aiEnabled = body.aiEnabled;
          if (typeof body.shellEnabled === "boolean") state.shellEnabled = body.shellEnabled;
          if (body.execMode === "privileged" && body.acknowledgePrivileged === true) {
            state.privilegedAcknowledgedAt = "2026-10-25T10:00:00.000Z";
            state.privilegedAcknowledgedBy = "admin-session";
          }
          if (body.execMode === "privileged" || body.execMode === "sandbox") {
            state.execMode = body.execMode;
          }
          return aiOk(state);
        }
        if (url === "/api/vps/vps-1/ai/policy") return aiOk(state);
        if (url === "/api/vps/vps-1/ai/bundle") {
          if (options.bundle === null) {
            return {
              ok: false,
              status: 404,
              json: async () => ({
                error: { code: "NOT_FOUND", message: "AI bundle status is unavailable on this API." },
              }),
            };
          }
          return aiOk(options.bundle ?? aiBundleFixture);
        }
        if (url === "/api/vps/vps-1/ai/capability") return aiOk(aiCapabilityFixture);
        const data =
          url === "/api/dashboard" ? dashboardData
          : url === "/api/vps" ? [{ ...twoServers[0], agentStatus: "online" as const }, twoServers[1]]
          : url === "/api/vps/vps-1/files/capabilities"
            ? { enabled: false, available: false, transport: "sftp", reason: "disabled" }
            : [];
        return aiOk(data);
      });
      return { state, patchBodies };
    }

    it("renders the Agent card with AI and shell toggles, execution mode, and agent version", async () => {
      mockSettingsAiServer({ policy: agentPolicyFixture });

      renderApp(["/vps/vps-1/settings"]);

      expect(await screen.findByRole("heading", { name: "Settings for web-01" })).toBeInTheDocument();
      const card = await screen.findByTestId("agent-settings-card");
      expect(card).toHaveAttribute("data-policy-revision", "11");

      const aiToggle = within(card).getByTestId("agent-ai-toggle");
      expect(aiToggle).toHaveAttribute("aria-checked", "false");
      const shellToggle = within(card).getByTestId("agent-shell-toggle");
      expect(shellToggle).toHaveAttribute("aria-checked", "false");

      const sandbox = within(card).getByTestId("exec-mode-sandbox");
      const privileged = within(card).getByTestId("exec-mode-privileged");
      expect(sandbox).toHaveAttribute("aria-pressed", "true");
      expect(privileged).toHaveAttribute("aria-pressed", "false");

      const versionLine = within(card).getByTestId("agent-version-line");
      expect(versionLine).toHaveTextContent("v0.9.0");

      // Bundle row: installed + short bundle id + capability diagnosis.
      const bundleLine = within(card).getByTestId("ai-bundle-line");
      expect(bundleLine).toHaveTextContent("Installed");
      expect(bundleLine).toHaveTextContent("b1234567890a");
      expect(within(card).getByText("Sandbox unavailable")).toBeInTheDocument();
      expect(
        within(card).getByTestId("ai-capability-reason"),
      ).toHaveTextContent("cgroup v2 is not mounted on this host");
      expect(within(card).getByText("Privileged ready")).toBeInTheDocument();
    });

    it("PATCHes AI and shell toggles individually and follows the returned policy revision", async () => {
      const { state, patchBodies } = mockSettingsAiServer({ policy: agentPolicyFixture });

      renderApp(["/vps/vps-1/settings"]);

      const aiToggle = await screen.findByTestId("agent-ai-toggle");
      await waitFor(() => expect(aiToggle).toBeEnabled());
      fireEvent.click(aiToggle);

      await waitFor(() => {
        expect(aiToggle).toHaveAttribute("aria-checked", "true");
      });
      expect(patchBodies[0]).toEqual({ aiEnabled: true });

      const shellToggle = screen.getByTestId("agent-shell-toggle");
      fireEvent.click(shellToggle);

      await waitFor(() => {
        expect(shellToggle).toHaveAttribute("aria-checked", "true");
      });
      expect(patchBodies[1]).toEqual({ shellEnabled: true });
      expect(state.revision).toBe(13);
      expect(screen.getByTestId("agent-settings-card")).toHaveAttribute(
        "data-policy-revision",
        "13",
      );
    });

    it("requires the one-time privileged acknowledgment, then switches directly", async () => {
      const { state, patchBodies } = mockSettingsAiServer({ policy: agentPolicyFixture });

      renderApp(["/vps/vps-1/settings"]);

      const privileged = await screen.findByTestId("exec-mode-privileged");
      await waitFor(() => expect(privileged).toBeEnabled());
      fireEvent.click(privileged);

      // The modal blocks the switch: confirm stays disabled without the
      // checkbox and no PATCH may fire.
      const modal = await screen.findByTestId("exec-ack-modal");
      const confirm = within(modal).getByTestId("exec-ack-confirm");
      expect(confirm).toBeDisabled();
      expect(patchBodies).toHaveLength(0);

      fireEvent.click(within(modal).getByTestId("exec-ack-checkbox"));
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);

      await waitFor(() => {
        expect(screen.queryByTestId("exec-ack-modal")).toBeNull();
      });
      expect(patchBodies[0]).toEqual({
        execMode: "privileged",
        acknowledgePrivileged: true,
      });
      expect(state.privilegedAcknowledgedAt).toBe("2026-10-25T10:00:00.000Z");
      await waitFor(() => {
        expect(privileged).toHaveAttribute("aria-pressed", "true");
      });

      // Back to sandbox PATCHes directly (the ack is never cleared)...
      const sandbox = screen.getByTestId("exec-mode-sandbox");
      fireEvent.click(sandbox);
      await waitFor(() => {
        expect(sandbox).toHaveAttribute("aria-pressed", "true");
      });
      expect(patchBodies[1]).toEqual({ execMode: "sandbox" });

      // ...and switching to privileged again skips the modal.
      fireEvent.click(screen.getByTestId("exec-mode-privileged"));
      expect(screen.queryByTestId("exec-ack-modal")).toBeNull();
      await waitFor(() => {
        expect(patchBodies[2]).toEqual({ execMode: "privileged" });
      });
      expect(patchBodies).toHaveLength(3);
    });
    it("shows the failed bundle job error", async () => {
      mockSettingsAiServer({
        policy: agentPolicyFixture,
        bundle: {
          ...aiBundleFixture,
          lastJob: {
            state: "failed",
            error: "ssh: checksum mismatch for ai-executor",
            startedAt: "2026-10-25T09:00:00.000Z",
            finishedAt: "2026-10-25T09:01:00.000Z",
          },
        },
      });

      renderApp(["/vps/vps-1/settings"]);

      expect(
        await screen.findByTestId("ai-bundle-job-error"),
      ).toHaveTextContent("ssh: checksum mismatch for ai-executor");
    });

    it("degrades gracefully when the bundle endpoint is missing and falls back to the capability diagnosis", async () => {
      mockSettingsAiServer({ policy: agentPolicyFixture, bundle: null });

      renderApp(["/vps/vps-1/settings"]);

      const bundleLine = await screen.findByTestId("ai-bundle-line");
      expect(bundleLine).toHaveTextContent(
        "AI bundle status is unavailable on this API.",
      );
      expect(
        screen.getByTestId("ai-capability-reason"),
      ).toHaveTextContent("legacy capability reason");
      // The standalone capability endpoint cannot report privileged support.
      expect(screen.queryByText("Privileged ready")).toBeNull();
    });

    it("surfaces the server bundle degrade reason when artifacts are unavailable", async () => {
      mockSettingsAiServer({
        policy: agentPolicyFixture,
        bundle: {
          ...aiBundleFixture,
          available: false,
          reason: "AI bundle directory is empty: /app/agent/ai",
        },
      });

      renderApp(["/vps/vps-1/settings"]);

      expect(
        await screen.findByText("AI bundle directory is empty: /app/agent/ai"),
      ).toBeInTheDocument();
    });

  });

  describe("Docker container history targets", () => {
    // Production regression: the stored snapshot still carries the old
    // container key (f51a…) while the live current-targets endpoint reports
    // the canonical one (dc6d…). Only the current key may become selectable.
    const STALE_SNAPSHOT_KEY = "f51a000000000000000000000000000000000000000000000000000000000001";
    const CURRENT_KEY = "dc6d000000000000000000000000000000000000000000000000000000000002";
    const CURRENT_INSTANCE = "inst-current";

    type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
    const ok = (data: unknown): MockResponse => ({ ok: true, status: 200, json: async () => data });

    const dockerServer = {
      id: "vps-1",
      name: "web-01",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      status: "healthy",
      dockerMetricsEnabled: true,
      dockerManagementEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const dashboardWithStaleSnapshot = {
      mode: "local",
      summary: { totalServers: 1, healthyServers: 1, warningServers: 0, unreachableServers: 0, runningJobs: 0 },
      servers: [],
      metrics: [],
      dockerMetrics: [
        {
          vpsId: "vps-1",
          collectedAt: "2026-01-01T00:00:00.000Z",
          receivedAt: "2026-01-01T00:00:01.000Z",
          agentInstanceId: "inst-stale",
          snapshotId: "snapshot-stale",
          sourceSequence: "1",
          agentVersion: "1.2.3",
          schemaVersion: 2,
          available: true,
          containerTotal: 1,
          containerRunning: 1,
          cpuPercent: 12.5,
          memoryUsageBytes: 268435456,
          networkRxBytes: 1024,
          networkTxBytes: 2048,
          blockReadBytes: 4096,
          blockWriteBytes: 8192,
          pids: 9,
          containers: [
            {
              containerKey: STALE_SNAPSHOT_KEY,
              name: "legacy-api",
              image: "app:1",
              state: "running",
              status: "Up 2 minutes",
              cpuPercent: 10,
              memoryUsageBytes: 134217728,
              networkRxBytes: 100,
              networkTxBytes: 200,
              blockReadBytes: 300,
              blockWriteBytes: 400,
              pids: 4,
            },
          ],
        },
      ],
      jobs: [],
      auditEvents: [],
      terminal: { label: "Terminal", networkAccess: "disabled", commands: [], sessions: [] },
      settings: { appMode: "local", webTerminalEnabled: false, realSshEnabled: false, authRequiredInLocalMode: true },
    };

    function routeDockerPageFetch(currentContainers: MockResponse | Promise<MockResponse>) {
      fetchMock.mockImplementation(async (url: unknown) => {
        const path = String(url);
        if (path === "/api/auth/me") return ok({ data: { mode: "local", authenticated: false, authRequired: false } });
        if (path === "/api/dashboard") return ok({ data: dashboardWithStaleSnapshot });
        if (path === "/api/vps") return ok({ data: [dockerServer] });
        if (path === "/api/vps/vps-1/docker/containers/current") return await currentContainers;
        if (path === "/api/vps/vps-1/docker/storage") return ok({ data: null });
        if (path.startsWith("/api/vps/vps-1/docker/")) return ok({ data: [], page: { limit: 0, hasMore: false } });
        return ok({ data: [] });
      });
    }

    it("offers only current-target keys and fetches history with the canonical key and instance", async () => {
      let resolveCurrent!: (value: MockResponse) => void;
      const currentPending = new Promise<MockResponse>((resolve) => { resolveCurrent = resolve; });
      routeDockerPageFetch(currentPending);

      renderApp(["/vps/vps-1/docker"]);

      const region = await screen.findByRole("region", { name: "Container history" });
      expect(await within(region).findByText("Loading containers…")).toBeInTheDocument();

      resolveCurrent(ok({ data: [{ agentInstanceId: CURRENT_INSTANCE, containerKey: CURRENT_KEY }] }));

      // Contract names are absent here, so the shortened canonical key is shown.
      const targetButton = await within(region).findByRole("button", { name: CURRENT_KEY.slice(0, 12) });
      expect(within(region).queryByText("legacy-api")).not.toBeInTheDocument();

      await userEvent.click(targetButton);

      const historyPath = `/api/vps/vps-1/docker/instances/${CURRENT_INSTANCE}/containers/${CURRENT_KEY}/history?limit=50`;
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(historyPath, expect.any(Object));
      });
      expect(fetchMock.mock.calls.some(([requestUrl]) => String(requestUrl).includes(STALE_SNAPSHOT_KEY))).toBe(false);
    });

    it("shows the current-targets error without a stale snapshot fallback", async () => {
      routeDockerPageFetch({ ok: false, status: 500, json: async () => ({ error: { message: "Current containers unavailable" } }) });

      renderApp(["/vps/vps-1/docker"]);

      const region = await screen.findByRole("region", { name: "Container history" });
      expect(await within(region).findByText("Current containers unavailable")).toBeInTheDocument();
      expect(within(region).queryByRole("button")).not.toBeInTheDocument();
      expect(within(region).queryByText("legacy-api")).not.toBeInTheDocument();
    });

    it("shows an explicit empty state when no current containers are reported", async () => {
      routeDockerPageFetch(ok({ data: [] }));

      renderApp(["/vps/vps-1/docker"]);

      const region = await screen.findByRole("region", { name: "Container history" });
      expect(await within(region).findByText("No containers reported for this server.")).toBeInTheDocument();
      expect(within(region).queryByRole("button")).not.toBeInTheDocument();
      expect(within(region).queryByText("legacy-api")).not.toBeInTheDocument();
    });
  });

  describe("Docker container detail route", () => {
    // The dedicated route retains the full identity pair alongside the inline workspace.
    const TARGET_INSTANCE = "inst-current";
    const TARGET_KEY = "dc6d000000000000000000000000000000000000000000000000000000000002";

    type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
    const ok = (data: unknown): MockResponse => ({ ok: true, status: 200, json: async () => data });

    const dockerServer = {
      id: "vps-1",
      name: "web-01",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      status: "healthy",
      dockerMetricsEnabled: true,
      dockerManagementEnabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const dashboard = {
      mode: "local",
      summary: { totalServers: 1, healthyServers: 1, warningServers: 0, unreachableServers: 0, runningJobs: 0 },
      servers: [],
      metrics: [],
      dockerMetrics: [
        {
          vpsId: "vps-1",
          collectedAt: "2026-01-01T00:00:00.000Z",
          receivedAt: "2026-01-01T00:00:01.000Z",
          agentInstanceId: TARGET_INSTANCE,
          snapshotId: "snapshot-1",
          sourceSequence: "1",
          agentVersion: "1.2.3",
          schemaVersion: 2,
          available: true,
          containerTotal: 1,
          containerRunning: 1,
          cpuPercent: 12.5,
          memoryUsageBytes: 268435456,
          networkRxBytes: 1024,
          networkTxBytes: 2048,
          blockReadBytes: 4096,
          blockWriteBytes: 8192,
          pids: 9,
          containers: [
            {
              containerKey: TARGET_KEY,
              name: "legacy-api",
              image: "app:1",
              state: "running",
              status: "Up 2 minutes",
              cpuPercent: 10,
              memoryUsageBytes: 134217728,
              networkRxBytes: 100,
              networkTxBytes: 200,
              blockReadBytes: 300,
              blockWriteBytes: 400,
              pids: 4,
            },
          ],
        },
      ],
      jobs: [],
      auditEvents: [],
      terminal: { label: "Terminal", networkAccess: "disabled", commands: [], sessions: [] },
      settings: { appMode: "local", webTerminalEnabled: false, realSshEnabled: false, authRequiredInLocalMode: true },
    };

    const capability = {
      supported: true,
      actions: ["start", "stop", "restart"],
      logsSupported: true,
      maxLogLines: 200,
      targets: [
        {
          agentInstanceId: TARGET_INSTANCE,
          containerKey: TARGET_KEY,
          name: "legacy-api",
          image: "app:1",
          state: "running",
        },
      ],
    };

    function routeDetailPageFetch(
      currentContainers: MockResponse = ok({
        data: [{ agentInstanceId: TARGET_INSTANCE, containerKey: TARGET_KEY }],
      }),
      capabilityResponse: MockResponse = ok(capability),
      serverResponse: MockResponse = ok({ data: [dockerServer] }),
    ) {
      fetchMock.mockImplementation(async (url: unknown) => {
        const path = String(url);
        if (path === "/api/auth/me") return ok({ data: { mode: "local", authenticated: false, authRequired: false } });
        if (path === "/api/dashboard") return ok({ data: dashboard });
        if (path === "/api/vps") return await serverResponse;
        if (path === "/api/vps/vps-1/docker/containers/current") return await currentContainers;
        if (path === "/api/vps/vps-1/docker/management/capability") return await capabilityResponse;
        if (path === "/api/vps/vps-1/docker/storage") return ok({ data: null });
        if (path.startsWith("/api/vps/vps-1/docker/")) return ok({ data: [], page: { limit: 0, hasMore: false } });
        return ok({ data: [] });
      });
    }

    it("renders the container detail page directly from its URL", async () => {
      routeDetailPageFetch();
      renderApp([
        `/vps/vps-1/docker/containers/${TARGET_INSTANCE}/${TARGET_KEY}`,
      ]);

      const detail = await screen.findByRole("region", {
        name: "Docker container detail",
      });
      expect(
        within(detail).getByRole("heading", { name: "Container detail" }),
      ).toBeInTheDocument();
      // The fixed target is named on the page; no selector is offered.
      expect(
        within(detail).queryByLabelText("Target container"),
      ).not.toBeInTheDocument();
      expect(within(detail).getByText("legacy-api")).toBeInTheDocument();
      // It is the fixed target's own log surface, not the list page's.
      expect(screen.queryByRole("region", { name: "Container history" })).not.toBeInTheDocument();
    });

    it("renders logs on the detail route when management consent is off", async () => {
      routeDetailPageFetch(
        undefined,
        ok({ ...capability, supported: false, actions: [] }),
        ok({ data: [{ ...dockerServer, dockerManagementEnabled: false }] }),
      );
      renderApp([`/vps/vps-1/docker/containers/${TARGET_INSTANCE}/${TARGET_KEY}`]);

      const detail = await screen.findByRole("region", { name: "Docker container detail" });
      expect(within(detail).getByText("Container logs")).toBeInTheDocument();
      for (const action of ["start", "stop", "restart"]) {
        expect(within(detail).getAllByRole("button", { name: new RegExp(`^${action}$`, "i") }).filter((button) => (button as HTMLButtonElement).disabled)).toHaveLength(1);
      }
    });

    it("offers back navigation to the container list", async () => {
      routeDetailPageFetch();
      renderApp([
        `/vps/vps-1/docker/containers/${TARGET_INSTANCE}/${TARGET_KEY}`,
      ]);

      const back = await screen.findByRole("link", { name: "Back to containers" });
      expect(back).toHaveAttribute("href", "/vps/vps-1/docker");
      await userEvent.click(back);

      const region = await screen.findByRole("region", { name: "Container history" });
      expect(region).toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "Docker container detail" }),
      ).not.toBeInTheDocument();
    });

    it("reports a stale container as unavailable without picking another target", async () => {
      // Capability still advertises two containers; only the routed one is
      // stale. The page must not silently attach to the survivor.
      routeDetailPageFetch(
        ok({ data: [] }),
        ok({
          ...capability,
          targets: [
            {
              agentInstanceId: TARGET_INSTANCE,
              containerKey: "other-container-key",
              name: "other-api",
              image: "other:1",
              state: "running",
            },
          ],
        }),
      );
      renderApp([
        `/vps/vps-1/docker/containers/${TARGET_INSTANCE}/${TARGET_KEY}`,
      ]);

      await waitFor(() => expect(screen.queryByText("other-api")).not.toBeInTheDocument());
      expect(screen.queryByRole("button", { name: /^start$/i })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/docker/management/logs/stream"), expect.anything());
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/docker/management/actions"), expect.anything());
    });
  });

  describe("Edit server regressions", () => {
    const editableServer = {
      id: "vps-edit-1",
      name: "generated-edit-name",
      displayName: "Production API",
      host: "203.0.113.10",
      port: 22,
      username: "deploy",
      provider: "Hetzner",
      region: "Singapore",
      city: "Singapore",
      country: "Singapore",
      notes: "Original notes",
      status: "healthy" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    function dashboardFor(mode: "demo" | "local" = "local") {
      return {
        ...emptyDashboard,
        mode,
        settings: { ...emptyDashboard.settings, appMode: mode },
      };
    }

    function queueInitialEditLoad(
      server: typeof editableServer | Array<Omit<typeof editableServer, "city" | "country"> & { city?: string; country?: string }> = editableServer,
      mode: "demo" | "local" = "local",
    ) {
      fetchMock
        .mockResolvedValueOnce(authOk(mode, mode === "local"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: dashboardFor(mode) }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: Array.isArray(server) ? server : [server] }),
        })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }

    function queueRefresh(server = editableServer) {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: dashboardFor() }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [server] }),
        })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }

    async function openEditMenu(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole("button", { name: "Table view" }));
      await user.click(screen.getByRole("button", { name: "More actions for Production API" }));
    }

    it("saves trimmed editable fields, refreshes the fleet, and closes the dialog", async () => {
      // Positive objective case: an allowed remote-server edit is sent once with the complete normalized payload and reflected after refresh.
      const user = userEvent.setup();
      const updatedServer = {
        ...editableServer,
        displayName: "Production API East",
        host: "198.51.100.25",
        port: 2222,
        username: "admin",
        provider: "OVH",
        city: "Frankfurt",
        country: "Germany",
        notes: "Primary endpoint",
      };
      queueInitialEditLoad();
      renderApp(["/vps"]);
      expect(await screen.findByRole("heading", { name: "Production API" })).toBeInTheDocument();

      await openEditMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Edit server" }));
      expect(await screen.findByRole("heading", { name: "Edit server" })).toBeInTheDocument();
      expect(screen.getByLabelText("Display name")).toHaveValue("Production API");
      expect(screen.getByLabelText("Host / IP")).toHaveValue("203.0.113.10");
      expect(screen.getByLabelText("SSH port")).toHaveValue(22);
      expect(screen.getByLabelText("Username")).toHaveValue("deploy");
      expect(screen.getByLabelText("Username")).toHaveAttribute("maxlength", "64");
      expect(screen.getByLabelText("Provider")).toHaveAttribute("maxlength", "80");
      expect(screen.getByLabelText("Notes")).toHaveAttribute("maxlength", "1000");

      await user.clear(screen.getByLabelText("Display name"));
      await user.type(screen.getByLabelText("Display name"), "  Production API East  ");
      await user.clear(screen.getByLabelText("Host / IP"));
      await user.type(screen.getByLabelText("Host / IP"), "  198.51.100.25  ");
      await user.clear(screen.getByLabelText("SSH port"));
      await user.type(screen.getByLabelText("SSH port"), "2222");
      await user.clear(screen.getByLabelText("Username"));
      await user.type(screen.getByLabelText("Username"), "  admin  ");
      await user.clear(screen.getByLabelText("Provider"));
      await user.type(screen.getByLabelText("Provider"), "  OVH  ");
      expect(screen.queryByLabelText("Region")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("City")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Country")).not.toBeInTheDocument();
      await user.clear(screen.getByLabelText("Notes"));
      await user.type(screen.getByLabelText("Notes"), "  Primary endpoint  ");

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: updatedServer }),
      });
      queueRefresh(updatedServer);
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/vps/vps-edit-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({
              displayName: "Production API East",
              host: "198.51.100.25",
              port: 2222,
              username: "admin",
              provider: "OVH",
              notes: "Primary endpoint",
            }),
          }),
        ),
      );
      expect(await screen.findByRole("link", { name: "Production API East" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Edit server" })).not.toBeInTheDocument();
      expect(screen.getByText("Updated Production API East.")).toBeInTheDocument();
    });

    it("clears an existing provider using the API's unknown value", async () => {
      const user = userEvent.setup();
      const clearedServer = { ...editableServer, provider: "unknown" };
      queueInitialEditLoad();
      renderApp(["/vps"]);
      expect(await screen.findByRole("heading", { name: "Production API" })).toBeInTheDocument();
      await openEditMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Edit server" }));
      await user.clear(await screen.findByLabelText("Provider"));

      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: clearedServer }) });
      queueRefresh(clearedServer);
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        "/api/vps/vps-edit-1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"provider":"unknown"'),
        }),
      ));
      expect(screen.queryByRole("heading", { name: "Edit server" })).not.toBeInTheDocument();
    });

    it("keeps location search working and shows detected location in table with graceful fallback", async () => {
      const user = userEvent.setup();
      const undetected = { ...editableServer, id: "vps-edit-2", displayName: "Backup", city: undefined, country: undefined };
      queueInitialEditLoad([editableServer, undetected]);
      renderApp(["/vps"]);

      expect(await screen.findByRole("heading", { name: "Production API" })).toBeInTheDocument();

      await user.type(screen.getByLabelText("Search servers"), "singapore");
      expect(screen.getByRole("heading", { name: "Production API" })).toBeInTheDocument();
      expect(screen.queryByRole("article", { name: "Server Backup" })).not.toBeInTheDocument();

      await user.clear(screen.getByLabelText("Search servers"));
      await user.click(screen.getByRole("button", { name: "Table view" }));
      expect(screen.getByRole("columnheader", { name: "Location" })).toBeInTheDocument();
      expect(screen.getByText("Singapore, Singapore")).toBeInTheDocument();
      expect(screen.getByText("Location not detected")).toBeInTheDocument();
    });


    it("keeps the dialog open and exposes the API error when saving fails", async () => {
      // Negative objective case: a rejected update is visible, does not refresh stale data, and remains retryable in the dialog.
      const user = userEvent.setup();
      queueInitialEditLoad();
      renderApp(["/vps"]);
      expect(await screen.findByRole("heading", { name: "Production API" })).toBeInTheDocument();
      await openEditMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Edit server" }));

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: "That endpoint is already in use." } }),
      });
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("That endpoint is already in use.");
      expect(screen.getByRole("heading", { name: "Edit server" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
      expect(fetchMock).toHaveBeenCalledTimes(7);
    });

    it("rejects missing required values and out-of-range or fractional SSH ports without PATCHing", async () => {
      // Negative validation objective: required-field and integer/range policy failures are handled client-side without an API call.
      const user = userEvent.setup();
      queueInitialEditLoad();
      renderApp(["/vps"]);
      expect(await screen.findByRole("heading", { name: "Production API" })).toBeInTheDocument();
      await openEditMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Edit server" }));

      await user.clear(screen.getByLabelText("Display name"));
      fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Display name, host, and username are required.",
      );

      await user.type(screen.getByLabelText("Display name"), "Valid name");
      for (const invalidPort of ["0", "65536", "22.5"]) {
        await user.clear(screen.getByLabelText("SSH port"));
        await user.type(screen.getByLabelText("SSH port"), invalidPort);
        fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "SSH port must be a whole number from 1 to 65535.",
        );
      }
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("disables editing for demo and system-managed local servers in card and table views", async () => {
      // Policy objective: both presentation modes consistently prevent demo and local/system-managed records from opening Edit server.
      const user = userEvent.setup();
      for (const policyCase of [
        { mode: "demo" as const, server: editableServer, label: "Edit server: unavailable in demo mode" },
        {
          mode: "local" as const,
          server: { ...editableServer, kind: "local" as const, managedBy: "system" as const },
          label: "Edit server: local servers are system managed",
        },
      ]) {
        cleanup();
        fetchMock.mockReset();
        queueInitialEditLoad(policyCase.server, policyCase.mode);
        renderApp(["/vps"]);
        expect(await screen.findByRole("heading", { name: "Production API" })).toBeInTheDocument();

        await openEditMenu(user);
        expect(screen.getByRole("menuitem", { name: policyCase.label })).toHaveAttribute(
          "data-disabled",
        );
        expect(screen.queryByRole("heading", { name: "Edit server" })).not.toBeInTheDocument();

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Table view" }));
        await openEditMenu(user);
        expect(screen.getByRole("menuitem", { name: policyCase.label })).toHaveAttribute(
          "data-disabled",
        );
        expect(screen.queryByRole("heading", { name: "Edit server" })).not.toBeInTheDocument();
      }
    });
  });
});
