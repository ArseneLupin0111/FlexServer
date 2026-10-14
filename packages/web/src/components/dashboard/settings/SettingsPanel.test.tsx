import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import {
  DashboardContext,
  type DashboardCtx,
} from "../../../context/DashboardContext";
import type { DashboardOverview } from "../../../lib/api";

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

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
    expect(screen.getAllByText("disabled")).toHaveLength(2); // Web terminal and Real SSH facts

    const toggleButton = screen.getByTestId("web-terminal-toggle");
    expect(toggleButton).toHaveTextContent("Enable");
    expect(toggleButton).toHaveAttribute("aria-pressed", "false");
    expect(toggleButton).toHaveAttribute("aria-label", "Enable web terminal");
  });

  it("handles enabling web terminal with pending state and provider update", async () => {
    const { promise, resolve } = Promise.withResolvers<{
      webTerminalEnabled: boolean;
    }>();
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
});
