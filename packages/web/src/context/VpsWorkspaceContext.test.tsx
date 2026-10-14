import type * as DashboardPanelsModule from "../components/dashboard/DashboardPanels";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VpsWorkspaceContext,
  VpsWorkspaceTerminalPage,
} from "./VpsWorkspaceContext";
import type { DashboardOverview, VpsRecord } from "../lib/api";

// Mock TerminalPanel to inspect enabled prop without mounting xterm
vi.mock("../components/dashboard/DashboardPanels", async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardPanelsModule>();
  return {
    TerminalPanel: ({
      enabled,
      isLocal,
      vps,
    }: {
      enabled?: boolean;
      isLocal?: boolean;
      vps: VpsRecord;
    }) => (
      <div
        data-testid="terminal-panel"
        data-enabled={String(enabled)}
        data-is-local={String(isLocal)}
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
});
