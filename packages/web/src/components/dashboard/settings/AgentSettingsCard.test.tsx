import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsCard } from "./AgentSettingsCard";

const policy = {
  vpsId: "vps-1",
  aiEnabled: true,
  readEnabled: true,
  dockerActionsEnabled: true,
  composeActionsEnabled: true,
  shellEnabled: false,
  execMode: "sandbox",
  privilegedAcknowledgedAt: null,
  privilegedAcknowledgedBy: null,
  executionMode: "manual",
  yoloAcknowledgedAt: null,
  yoloAcknowledgedBy: null,
  fileReadScopes: [],
  fileWriteScopes: [],
  serviceProfileIds: [],
  sendLogsToProvider: false,
  sendFilesToProvider: false,
  revision: 1,
  updatedAt: "2026-10-25T00:00:00.000Z",
};

const bundle = (state: "running" | "failed") => ({
  available: true,
  bundleId: "b1234567890abcdef1234",
  installed: false,
  lastInstalledBundleId: null,
  lastJob: {
    state,
    error: state === "failed" ? "ssh: checksum mismatch" : null,
    startedAt: "2026-10-25T10:00:00.000Z",
    finishedAt: state === "failed" ? "2026-10-25T10:01:00.000Z" : null,
  },
  capability: { supported: true, privilegedSupported: true },
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AgentSettingsCard AI bundle status", () => {
  it("tracks a server-started install through failure without exposing a manual install action", async () => {
    vi.useFakeTimers();
    let current = bundle("running");
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: url.endsWith("/ai/bundle")
          ? current
          : url.endsWith("/ai/policy")
            ? policy
            : { supported: true, agentVersion: "0.9.0" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentSettingsCard vpsId="vps-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent("Installing AI bundle…");
    expect(screen.getByRole("progressbar", { name: "AI bundle install progress" })).not.toHaveAttribute("aria-valuenow");
    expect(screen.queryByRole("button", { name: /(?:install|update) AI bundle/i })).not.toBeInTheDocument();

    current = bundle("failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-job-error")).toHaveTextContent("ssh: checksum mismatch");
  });
});

describe("AgentSettingsCard execution confinement copy", () => {
  it("renders manual approval warning for privileged execMode under manual executionMode", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: url.endsWith("/ai/policy")
          ? { ...policy, execMode: "privileged", executionMode: "manual" }
          : url.endsWith("/ai/bundle")
            ? bundle("running")
            : { supported: true, agentVersion: "0.9.0" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentSettingsCard vpsId="vps-1" />);
    await screen.findByTestId("agent-settings-card");

    expect(
      screen.getAllByText(/Every command still needs your approval/i).length,
    ).toBeGreaterThan(0);
  });

  it("renders autonomous execution copy for privileged execMode under YOLO executionMode", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: url.endsWith("/ai/policy")
          ? { ...policy, execMode: "privileged", executionMode: "yolo" }
          : url.endsWith("/ai/bundle")
            ? bundle("running")
            : { supported: true, agentVersion: "0.9.0" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentSettingsCard vpsId="vps-1" />);
    await screen.findByTestId("agent-settings-card");

    expect(
      screen.getByText(/Under Full YOLO, commands execute autonomously without per-step approval/i),
    ).toBeInTheDocument();
  });
});
