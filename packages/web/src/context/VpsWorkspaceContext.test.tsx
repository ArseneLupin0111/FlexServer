import "../test/setup";
import type * as DashboardPanelsModule from "../components/dashboard/DashboardPanels";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VpsWorkspaceContext,
  VpsWorkspaceTerminalPage,
  VpsWorkspaceDockerPage,
  VpsWorkspaceDockerContainerPage,
  VpsWorkspaceSettingsPage,
} from "./VpsWorkspaceContext";
import type { AgentUpdateView, DashboardOverview, VpsRecord } from "../lib/api";
import * as api from "../lib/api";
import * as aiApi from "../lib/ai-api";
import type { AiBundleStatus, AiCapability, AiPolicy } from "../lib/ai-api";
import { DashboardContext, type DashboardCtx } from "./DashboardContext";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../lib/live-api", () => ({ subscribeMonitoring: () => () => {} }));

// Mock TerminalPanel to inspect enabled prop without mounting xterm
vi.mock("../components/dashboard/DashboardPanels", async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardPanelsModule>();
  return {
    ...actual,
    TerminalPanel: ({
      enabled,
      isLocal,
      commandGuardEnabled,
      vps,
    }: {
      enabled?: boolean;
      isLocal?: boolean;
      commandGuardEnabled?: boolean;
      vps: VpsRecord;
    }) => (
      <div
        data-testid="terminal-panel"
        data-enabled={String(enabled)}
        data-is-local={String(isLocal)}
        data-guard-enabled={String(commandGuardEnabled)}
      >
        <span>{vps.displayName || vps.name}</span>
        <span>{enabled ? "Terminal Enabled" : "Terminal Disabled"}</span>
      </div>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseOverview: DashboardOverview = {
  mode: "local",
  summary: {
    totalServers: 1,
    healthyServers: 1,
    warningServers: 0,
    unreachableServers: 0,
    runningJobs: 0,
  },
  servers: [],
  metrics: [],
  dockerMetrics: [],
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
    terminalCommandGuardEnabled: false,
    realSshEnabled: false,
    authRequiredInLocalMode: true,
  },
  systemInfo: [],
};

const localVps: VpsRecord = {
  id: "local-host",
  name: "Local Host",
  displayName: "Local Host",
  host: "127.0.0.1",
  port: 22,
  username: "root",
  provider: "local",
  status: "healthy",
  kind: "local",
  managedBy: "system",
  dockerMetricsEnabled: false,
  dockerManagementEnabled: false,
  agentStatus: "online",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const remoteVps: VpsRecord = {
  id: "remote-host",
  name: "Remote VPS",
  displayName: "Remote VPS",
  host: "198.51.100.25",
  port: 22,
  username: "ubuntu",
  provider: "aws",
  status: "healthy",
  kind: "remote",
  managedBy: "user",
  dockerMetricsEnabled: false,
  dockerManagementEnabled: false,
  agentStatus: "not_installed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("VpsWorkspaceTerminalPage gating", () => {
  it("enables local VPS terminal when webTerminalEnabled is true, regardless of realSshEnabled", () => {
    const overview: DashboardOverview = {
      ...baseOverview,
      settings: {
        ...baseOverview.settings,
        webTerminalEnabled: true,
        realSshEnabled: false, // Local does not depend on real SSH
      },
    };

    render(
      <VpsWorkspaceContext.Provider value={{ vps: localVps, overview }}>
        <VpsWorkspaceTerminalPage />
      </VpsWorkspaceContext.Provider>,
    );

    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toHaveAttribute("data-enabled", "true");
    expect(panel).toHaveAttribute("data-is-local", "true");
    expect(screen.getByText("Terminal Enabled")).toBeInTheDocument();
  });

  it("disables local VPS terminal when webTerminalEnabled is false", () => {
    const overview: DashboardOverview = {
      ...baseOverview,
      settings: {
        ...baseOverview.settings,
        webTerminalEnabled: false,
        realSshEnabled: true,
      },
    };

    render(
      <VpsWorkspaceContext.Provider value={{ vps: localVps, overview }}>
        <VpsWorkspaceTerminalPage />
      </VpsWorkspaceContext.Provider>,
    );

    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toHaveAttribute("data-enabled", "false");
    expect(screen.getByText("Terminal Disabled")).toBeInTheDocument();
  });

  it("requires realSshEnabled for remote VPS terminal when webTerminalEnabled is true", () => {
    // webTerminalEnabled true, but realSshEnabled false -> disabled for remote
    const overviewWithoutSsh: DashboardOverview = {
      ...baseOverview,
      settings: {
        ...baseOverview.settings,
        webTerminalEnabled: true,
        realSshEnabled: false,
      },
    };

    const { rerender } = render(
      <VpsWorkspaceContext.Provider
        value={{ vps: remoteVps, overview: overviewWithoutSsh }}
      >
        <VpsWorkspaceTerminalPage />
      </VpsWorkspaceContext.Provider>,
    );

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-enabled",
      "false",
    );
    expect(screen.getByText("Terminal Disabled")).toBeInTheDocument();

    // webTerminalEnabled true AND realSshEnabled true -> enabled for remote
    const overviewWithSsh: DashboardOverview = {
      ...baseOverview,
      settings: {
        ...baseOverview.settings,
        webTerminalEnabled: true,
        realSshEnabled: true,
      },
    };

    rerender(
      <VpsWorkspaceContext.Provider
        value={{ vps: remoteVps, overview: overviewWithSsh }}
      >
        <VpsWorkspaceTerminalPage />
      </VpsWorkspaceContext.Provider>,
    );

    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toHaveAttribute("data-enabled", "true");
    expect(panel).toHaveAttribute("data-is-local", "false");
    expect(screen.getByText("Terminal Enabled")).toBeInTheDocument();
  });

  it("passes terminalCommandGuardEnabled to TerminalPanel", () => {
    const overviewWithGuard: DashboardOverview = {
      ...baseOverview,
      settings: {
        ...baseOverview.settings,
        webTerminalEnabled: true,
        terminalCommandGuardEnabled: true,
      },
    };

    render(
      <VpsWorkspaceContext.Provider
        value={{ vps: localVps, overview: overviewWithGuard }}
      >
        <VpsWorkspaceTerminalPage />
      </VpsWorkspaceContext.Provider>,
    );

    const panel = screen.getByTestId("terminal-panel");
    expect(panel).toHaveAttribute("data-guard-enabled", "true");
  });
});

// The Settings page mounts the Agent card, which lazily fetches the AI
// policy, AI bundle status, capability, and agent-update view. Stub those
// transports so the Docker-management assertions below see only their own
// alerts and no real fetch ever leaves the test.
const stubAgentPolicy: AiPolicy = {
  vpsId: "local-host",
  aiEnabled: false,
  readEnabled: true,
  dockerActionsEnabled: true,
  composeActionsEnabled: true,
  shellEnabled: false,
  execMode: "sandbox",
  privilegedAcknowledgedAt: null,
  privilegedAcknowledgedBy: null,
  fileReadScopes: [],
  fileWriteScopes: [],
  serviceProfileIds: [],
  sendLogsToProvider: false,
  sendFilesToProvider: false,
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const stubBundleStatus: AiBundleStatus = {
  available: true,
  bundleId: "b1234567890abcdef",
  installed: false,
  lastInstalledBundleId: null,
  lastJob: null,
  capability: {
    supported: true,
    agentVersion: "0.9.0",
    privilegedSupported: false,
  },
};

const stubCapability: AiCapability = {
  vpsId: "local-host",
  supported: true,
  freshness: "2026-01-01T00:00:00.000Z",
  agentVersion: "0.9.0",
  protocolVersion: 3,
  cgroupV2Available: true,
  namespacesAvailable: true,
  seccompAvailable: true,
  profiles: [],
};

const stubAgentUpdate: AgentUpdateView = {
  installed: { version: "0.9.0", buildId: "aaaa1111bbbb", lastSeenAt: "2026-01-01T00:00:00.000Z", fresh: true },
  available: null,
  compatibility: { compatible: true, apiContractVersion: 3, reason: "ok" },
  updater: { installed: true, healthy: true, lastSeenAt: "2026-01-01T00:00:00.000Z" },
  state: "current",
  job: null,
  automation: { state: "current", reason: null, targetBuildId: null, retryAllowed: false },
};

function stubAgentCardTransports(vpsId: string): void {
  vi.spyOn(aiApi, "getVpsAiPolicy").mockResolvedValue({ ...stubAgentPolicy, vpsId });
  vi.spyOn(aiApi, "getAiBundle").mockResolvedValue(stubBundleStatus);
  vi.spyOn(aiApi, "getVpsAiCapability").mockResolvedValue(stubCapability);
  vi.spyOn(api, "getVpsAgentUpdate").mockResolvedValue(stubAgentUpdate);
}

describe("Docker management without monitoring", () => {
  beforeEach(() => {
    stubAgentCardTransports("local-host");
  });
  it.each([localVps, remoteVps])("keeps inventory and opt-in available for $id without enabling metrics", async (vps) => {
    const target = { agentInstanceId: "inst_a", containerKey: "container_key", name: "fixture", state: "exited" };
    const inventory = vi.spyOn(api, "listVpsDockerCurrentContainers").mockResolvedValue([target] as api.DockerCurrentContainer[]);
    vi.spyOn(api, "getVpsDockerManagementCapability").mockResolvedValue({ supported: false, actions: [], logsSupported: false, maxLogLines: 200, targets: [target] });
    const onEdit = vi.fn().mockResolvedValue(undefined);
    const dashboard = { busy: false, mode: "local", onEdit, onToggleDockerMetrics: vi.fn() } as unknown as DashboardCtx;
    const view = (record: VpsRecord) => <MemoryRouter><DashboardContext.Provider value={dashboard}><VpsWorkspaceContext.Provider value={{ vps: record, overview: baseOverview }}><VpsWorkspaceDockerPage /></VpsWorkspaceContext.Provider></DashboardContext.Provider></MemoryRouter>;
    const settings = (record: VpsRecord) => <MemoryRouter><DashboardContext.Provider value={dashboard}><VpsWorkspaceContext.Provider value={{ vps: record, overview: baseOverview }}><VpsWorkspaceSettingsPage /></VpsWorkspaceContext.Provider></DashboardContext.Provider></MemoryRouter>;
    const { rerender } = render(settings(vps));
    expect(screen.queryByRole("button", { name: "Refresh containers" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Enable Docker management" }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(vps, { dockerManagementEnabled: true }));
    rerender(settings({ ...vps, dockerManagementEnabled: true }));
    expect(screen.getByRole("switch", { name: "Disable Docker management" })).toHaveAttribute("aria-checked", "true");
    rerender(view({ ...vps, dockerManagementEnabled: true }));
    fireEvent.click(await screen.findByRole("button", { name: "fixture" }));
    expect(screen.getByRole("link", { name: "Open container" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Disable Docker management" })).not.toBeInTheDocument();
    inventory.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh containers" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open container" })).not.toBeInTheDocument());
  });

  it("preserves consent on a failed update", async () => {
    vi.spyOn(api, "listVpsDockerCurrentContainers").mockResolvedValue([]);
    const dashboard = { busy: false, mode: "local", onEdit: vi.fn().mockRejectedValue(new Error("Permission denied")), onToggleDockerMetrics: vi.fn() } as unknown as DashboardCtx;
    render(<MemoryRouter><DashboardContext.Provider value={dashboard}><VpsWorkspaceContext.Provider value={{ vps: localVps, overview: baseOverview }}><VpsWorkspaceSettingsPage /></VpsWorkspaceContext.Provider></DashboardContext.Provider></MemoryRouter>);
    fireEvent.click(screen.getByRole("switch", { name: "Enable Docker management" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByRole("switch", { name: "Enable Docker management" })).toHaveAttribute("aria-checked", "false");
  });
});
describe("Docker direct container route identity", () => {
  it("resolves only the exact current identity and shares the investigation surface", async () => {
    const target: api.DockerCurrentContainer = { agentInstanceId: "agent-exact", containerKey: "key-exact", name: "exact", image: "alpine", state: "running", collectedAt: "2026-10-19T10:00:00Z", metrics: { cpuPercent: 0, memoryUsageBytes: 0, pids: 1 }, details: { collectedAt: "2026-10-19T10:00:00Z", status: "unavailable", reason: "timeout" } };
    vi.spyOn(api, "listVpsDockerCurrentContainers").mockResolvedValue([target]);
    vi.spyOn(api, "listVpsDockerEvents").mockResolvedValue({ data: [], page: { limit: 25, hasMore: false } });
    render(<MemoryRouter initialEntries={["/docker/agent-exact/key-exact"]}><Routes><Route path="/docker/:agentInstanceId/:containerKey" element={<VpsWorkspaceContext.Provider value={{ vps: localVps, overview: baseOverview }}><VpsWorkspaceDockerContainerPage /></VpsWorkspaceContext.Provider>} /></Routes></MemoryRouter>);
    expect(await screen.findByText("exact")).toBeInTheDocument();
    expect(await screen.findByText(/details were unavailable.*timeout/i)).toBeInTheDocument();
    expect(screen.getByText("Container details")).toBeInTheDocument();
  });

  it("does not fall back when the route pair is missing from current inventory", async () => {
    vi.spyOn(api, "listVpsDockerCurrentContainers").mockResolvedValue([{ agentInstanceId: "different", containerKey: "other", metrics: { cpuPercent: 0, memoryUsageBytes: 0, pids: 0 }, collectedAt: "2026-10-19T10:00:00Z" }]);
    render(<MemoryRouter initialEntries={["/docker/missing/key"]}><Routes><Route path="/docker/:agentInstanceId/:containerKey" element={<VpsWorkspaceContext.Provider value={{ vps: localVps, overview: baseOverview }}><VpsWorkspaceDockerContainerPage /></VpsWorkspaceContext.Provider>} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText("Container details")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^start$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /container logs/i })).not.toBeInTheDocument();
  });
});
