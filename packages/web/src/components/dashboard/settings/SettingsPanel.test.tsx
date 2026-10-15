import "../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import {
  DashboardContext,
  type DashboardCtx,
} from "../../../context/DashboardContext";
import type { DashboardOverview } from "../../../lib/api";

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
  it("renders runtime facts and initial disabled state", () => {
    renderWithContext(mockOverview);

    expect(screen.getByText("App mode")).toBeInTheDocument();
    expect(screen.getByText("Real SSH")).toBeInTheDocument();
    expect(screen.getByText("Local auth")).toBeInTheDocument();

    const toggleButton = screen.getByTestId("web-terminal-toggle");
    expect(toggleButton).toHaveTextContent("Enable");
    expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    expect(toggleButton).toHaveAttribute("aria-label", "Enable web terminal");

    const guardToggle = screen.getByTestId("terminal-command-guard-toggle");
    expect(guardToggle).toHaveTextContent("Enable");
    expect(guardToggle).toHaveAttribute("aria-pressed", "false");
    expect(guardToggle).toHaveAttribute(
      "aria-label",
      "Enable terminal command guard",
    );
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

    expect(toggleButton).toHaveTextContent("Disable");
    expect(toggleButton).toHaveAttribute("aria-pressed", "true");
    expect(toggleButton).toHaveAttribute("aria-label", "Disable web terminal");
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
      expect(toggleButton).toHaveTextContent("Enable");
      expect(toggleButton).toHaveAttribute("aria-pressed", "false");
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
    expect(toggleButton).toHaveTextContent("Disable");
    expect(toggleButton).toHaveAttribute("aria-pressed", "true");

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

    expect(guardToggle).toHaveTextContent("Disable");
    expect(guardToggle).toHaveAttribute("aria-pressed", "true");
    expect(guardToggle).toHaveAttribute(
      "aria-label",
      "Disable terminal command guard",
    );
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
