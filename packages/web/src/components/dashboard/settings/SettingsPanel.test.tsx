import "../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import {
  DashboardContext,
  type DashboardCtx,
} from "../../../context/DashboardContext";
import type { DashboardOverview, VpsRecord } from "../../../lib/api";

const mockOverview: DashboardOverview = {
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

function renderWithContext(
  overview: DashboardOverview,
  overrides?: Partial<DashboardCtx>,
) {
  const onUpdateSettings = overrides?.onUpdateSettings ?? vi.fn().mockResolvedValue({
    webTerminalEnabled: !overview.settings.webTerminalEnabled,
  });
  const onRefresh = overrides?.onRefresh ?? vi.fn().mockResolvedValue(undefined);

  const ctx: Partial<DashboardCtx> = {
    overview,
    onUpdateSettings,
    onRefresh,
    ...overrides,
  };

  return {
    onUpdateSettings,
    onRefresh,
    ...render(
      <DashboardContext.Provider value={ctx as DashboardCtx}>
        <SettingsPanel overview={overview} />
      </DashboardContext.Provider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsPanel", () => {
  it("renders the terminal and command guard toggles in their initial disabled state", () => {
    renderWithContext(mockOverview);

    const toggleButton = screen.getByTestId("web-terminal-toggle");
    expect(toggleButton).toHaveAttribute("aria-checked", "false");

    const guardToggle = screen.getByTestId("terminal-command-guard-toggle");
    expect(guardToggle).toHaveAttribute("aria-checked", "false");
  });

  it("handles enabling web terminal with pending state and provider update", async () => {
    let resolve!: (value: { webTerminalEnabled: boolean }) => void;
    const promise = new Promise<{ webTerminalEnabled: boolean }>((res) => {
      resolve = res;
    });
    const onUpdateSettings = vi.fn().mockReturnValue(promise);

    const { rerender } = renderWithContext(mockOverview, { onUpdateSettings });

    const toggleButton = screen.getByTestId("web-terminal-toggle");
    fireEvent.click(toggleButton);

    expect(onUpdateSettings).toHaveBeenCalledWith({ webTerminalEnabled: true });

    // Enters pending state
    expect(toggleButton).toBeDisabled();
    expect(screen.getByText("Updating…")).toBeInTheDocument();

    // Resolve update
    resolve({ webTerminalEnabled: true });

    await waitFor(() => {
      expect(toggleButton).not.toBeDisabled();
    });

    // When parent context updates overview to enabled
    const updatedOverview: DashboardOverview = {
      ...mockOverview,
      settings: {
        ...mockOverview.settings,
        webTerminalEnabled: true,
      },
    };

    const ctx: Partial<DashboardCtx> = {
      overview: updatedOverview,
      onUpdateSettings,
      onRefresh: vi.fn(),
    };

    rerender(
      <DashboardContext.Provider value={ctx as DashboardCtx}>
        <SettingsPanel overview={updatedOverview} />
      </DashboardContext.Provider>,
    );

    expect(toggleButton).toHaveAttribute("aria-checked", "true");
  });

  it("surfaces actionable error message on failure and allows retry", async () => {
    const onUpdateSettings = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "DASHBOARD_PUBLIC_ORIGIN must be configured to enable web terminal.",
        ),
      )
      .mockResolvedValueOnce({ webTerminalEnabled: true });

    renderWithContext(mockOverview, { onUpdateSettings });

    const toggleButton = screen.getByTestId("web-terminal-toggle");
    fireEvent.click(toggleButton);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(
        "DASHBOARD_PUBLIC_ORIGIN must be configured to enable web terminal.",
      );
      expect(toggleButton).not.toBeDisabled();
      expect(toggleButton).toHaveAttribute("aria-checked", "false");
    });

    // Retry
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    expect(onUpdateSettings).toHaveBeenCalledTimes(2);
  });

  it("handles disabling web terminal when initially enabled", async () => {
    const enabledOverview: DashboardOverview = {
      ...mockOverview,
      settings: {
        ...mockOverview.settings,
        webTerminalEnabled: true,
      },
    };

    const onUpdateSettings = vi
      .fn()
      .mockResolvedValue({ webTerminalEnabled: false });

    renderWithContext(enabledOverview, { onUpdateSettings });

    const toggleButton = screen.getByTestId("web-terminal-toggle");
    expect(toggleButton).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggleButton);

    expect(onUpdateSettings).toHaveBeenCalledWith({
      webTerminalEnabled: false,
    });
  });

  it("handles enabling and disabling terminal command guard", async () => {
    const onUpdateSettings = vi
      .fn()
      .mockResolvedValue({ terminalCommandGuardEnabled: true });

    const { rerender } = renderWithContext(mockOverview, { onUpdateSettings });

    const guardToggle = screen.getByTestId("terminal-command-guard-toggle");
    fireEvent.click(guardToggle);
    expect(onUpdateSettings).toHaveBeenCalledWith({
      terminalCommandGuardEnabled: true,
    });

    await waitFor(() => {
      expect(guardToggle).not.toBeDisabled();
    });
    const updatedOverview: DashboardOverview = {
      ...mockOverview,
      settings: {
        ...mockOverview.settings,
        terminalCommandGuardEnabled: true,
      },
    };

    rerender(
      <DashboardContext.Provider
        value={{ overview: updatedOverview, onUpdateSettings, onRefresh: vi.fn() } as unknown as DashboardCtx}
      >
        <SettingsPanel overview={updatedOverview} />
      </DashboardContext.Provider>,
    );

    expect(guardToggle).toHaveAttribute("aria-checked", "true");
  });

  it("surfaces error on command guard update failure", async () => {
    const onUpdateSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("Database write failed"));

    renderWithContext(mockOverview, { onUpdateSettings });

    const guardToggle = screen.getByTestId("terminal-command-guard-toggle");
    fireEvent.click(guardToggle);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Database write failed");
    });
  });
});

const remoteHost = (overrides: Partial<VpsRecord> = {}): VpsRecord => ({
  id: "vps-1", name: "edge-1", displayName: "Edge 1", host: "203.0.113.10", port: 22,
  username: "root", createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
  kind: "remote", managedBy: "user", ...overrides,
});

function renderHostControls(host: VpsRecord, overrides: Partial<DashboardCtx> = {}) {
  const overview = { ...mockOverview, servers: [host] };
  return render(
    <DashboardContext.Provider value={{
      overview,
      records: [host],
      jobs: [],
      mode: "local",
      busy: false,
      provisionPasswords: {},
      systemInfo: [],
      ...overrides,
    } as unknown as DashboardCtx}>
      <SettingsPanel overview={overview} vpsId={host.id} />
    </DashboardContext.Provider>,
  );
}

describe("SettingsPanel host agent controls", () => {
  it("requires confirmation before provisioning a missing SSH key", () => {
    const host = remoteHost();
    const onProvision = vi.fn();
    renderHostControls(host, { provisionPasswords: { [host.id]: "one-time-password" }, onProvision, onPasswordChange: vi.fn() });
    fireEvent.click(screen.getByTestId("install-ssh-key"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Install SSH key?");
    expect(onProvision).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Install key" }));
    expect(onProvision).toHaveBeenCalledWith(host);
  });

  it.each([
    ["not_installed", "Install agent"], ["failed", "Retry install"],
  ] as const)("offers %s agent installation", (agentStatus, label) => {
    const host = remoteHost({ keyProvisionedAt: "2026-10-25T00:00:00.000Z", agentStatus });
    const onInstallAgent = vi.fn();
    renderHostControls(host, { onInstallAgent });
    fireEvent.click(screen.getByTestId("install-agent"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: label }));
    expect(onInstallAgent).toHaveBeenCalledWith(host);
  });

  it("confirms uninstall and restart for an offline agent", () => {
    const host = remoteHost({ keyProvisionedAt: "2026-10-25T00:00:00.000Z", agentStatus: "offline" });
    const onUninstallAgent = vi.fn();
    const onRestartAgent = vi.fn();
    renderHostControls(host, { onUninstallAgent, onRestartAgent });
    fireEvent.click(screen.getByTestId("restart-agent"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restart agent" }));
    expect(onRestartAgent).toHaveBeenCalledWith(host);
    fireEvent.click(screen.getByTestId("uninstall-agent"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Uninstall agent" }));
    expect(onUninstallAgent).toHaveBeenCalledWith(host);
  });

  it("disables actions while the dashboard is busy or a lifecycle job is active", () => {
    const host = remoteHost({ keyProvisionedAt: "2026-10-25T00:00:00.000Z", agentStatus: "not_installed" });
    const { unmount } = renderHostControls(host, { busy: true });
    expect(screen.getByTestId("install-agent")).toBeDisabled();
    unmount();

    renderHostControls(host, {
      jobs: [{
        id: "job-1", vpsId: host.id, type: "install-agent", status: "running", progress: 40, step: "uploading-binary",
      }],
    });
    expect(screen.getByTestId("install-agent")).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: "Agent install: Uploading agent" })).toBeInTheDocument();
  });

  it("leaves local agent lifecycle to the dashboard", () => {
    const host = remoteHost({ kind: "local", managedBy: "system", agentStatus: "online" });
    renderHostControls(host);
    expect(screen.queryByTestId("install-agent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("uninstall-agent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("restart-agent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("install-ssh-key")).not.toBeInTheDocument();
    expect(screen.getByText("The local agent is managed by the dashboard.")).toBeInTheDocument();
  });
});
