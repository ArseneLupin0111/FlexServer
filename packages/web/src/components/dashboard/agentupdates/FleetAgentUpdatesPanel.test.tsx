import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FleetAgentUpdatesPanel } from "./FleetAgentUpdatesPanel";
import type { FleetAgentUpdatesData } from "../../../lib/api";

const BUILD_CURRENT = "aaaa1111aaaa2222aaaa3333aaaa4444aaaa5555";
const BUILD_TARGET = "bbbb1111bbbb2222bbbb3333bbbb4444bbbb5555";

const mockFleetData: FleetAgentUpdatesData = {
  hosts: [
    {
      vpsId: "vps-1",
      name: "prod-web-01",
      update: {
        installed: {
          version: "1.0.0",
          buildId: BUILD_CURRENT,
          lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
          fresh: true,
        },
        available: {
          releaseId: "rel-deploy",
          version: "1.1.0",
          buildId: BUILD_TARGET,
          publishedAt: "2026-10-22T08:00:00.000Z",
          artifacts: [],
        },
        compatibility: {
          compatible: true,
          apiContractVersion: 3,
          reason: "ok",
        },
        updater: {
          installed: true,
          healthy: true,
          lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
        },
        state: "available",
        job: null,
        automation: {
          state: "pending",
          reason: "Awaiting automatic convergence.",
          targetBuildId: BUILD_TARGET,
          retryAllowed: true,
        },
      },
    },
    {
      vpsId: "vps-2",
      name: "prod-db-01",
      update: {
        installed: {
          version: "1.1.0",
          buildId: BUILD_TARGET,
          lastSeenAt: new Date(Date.now() - 10_000).toISOString(),
          fresh: true,
        },
        available: {
          releaseId: "rel-deploy",
          version: "1.1.0",
          buildId: BUILD_TARGET,
          publishedAt: "2026-10-22T08:00:00.000Z",
          artifacts: [],
        },
        compatibility: {
          compatible: true,
          apiContractVersion: 3,
          reason: "ok",
        },
        updater: {
          installed: true,
          healthy: true,
          lastSeenAt: new Date(Date.now() - 10_000).toISOString(),
        },
        state: "current",
        job: null,
        automation: {
          state: "current",
          reason: "Running deployment build.",
          targetBuildId: BUILD_TARGET,
          retryAllowed: false,
        },
      },
    },
    {
      vpsId: "vps-3",
      name: "worker-01",
      update: {
        installed: {
          version: "1.0.0",
          buildId: BUILD_CURRENT,
          lastSeenAt: new Date(Date.now() - 20_000).toISOString(),
          fresh: true,
        },
        available: {
          releaseId: "rel-deploy",
          version: "1.1.0",
          buildId: BUILD_TARGET,
          publishedAt: "2026-10-22T08:00:00.000Z",
          artifacts: [],
        },
        compatibility: {
          compatible: true,
          apiContractVersion: 3,
          reason: "ok",
        },
        updater: {
          installed: true,
          healthy: true,
          lastSeenAt: new Date(Date.now() - 20_000).toISOString(),
        },
        state: "available",
        job: null,
        automation: {
          state: "waiting_connection",
          reason: "Agent heartbeat is stale or disconnected.",
          targetBuildId: BUILD_TARGET,
          retryAllowed: true,
        },
      },
    },
    {
      vpsId: "vps-4",
      name: "edge-01",
      update: {
        installed: {
          version: "0.9.0",
          buildId: null,
          lastSeenAt: null,
          fresh: false,
        },
        available: null,
        compatibility: {
          compatible: false,
          apiContractVersion: 1,
          reason: "release_unavailable",
        },
        updater: {
          installed: false,
          healthy: false,
          lastSeenAt: null,
        },
        state: "updater_unavailable",
        job: null,
        automation: {
          state: "needs_access",
          reason: "Host updater daemon missing root access.",
          targetBuildId: null,
          retryAllowed: true,
        },
      },
    },
    {
      vpsId: "vps-5",
      name: "legacy-01",
      update: {
        installed: {
          version: "0.8.0",
          buildId: "deadbeef",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
          fresh: true,
        },
        available: null,
        compatibility: {
          compatible: true,
          apiContractVersion: 3,
          reason: "ok",
        },
        updater: {
          installed: true,
          healthy: true,
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        },
        state: "available",
        job: null,
        automation: {
          state: "failed",
          reason: "Download verification failed.",
          targetBuildId: BUILD_TARGET,
          retryAllowed: true,
        },
      },
    },
    {
      vpsId: "vps-6",
      name: "staging-01",
      update: {
        installed: {
          version: "1.0.0",
          buildId: BUILD_CURRENT,
          lastSeenAt: new Date(Date.now() - 15_000).toISOString(),
          fresh: true,
        },
        available: {
          releaseId: "rel-deploy",
          version: "1.1.0",
          buildId: BUILD_TARGET,
          publishedAt: "2026-10-22T08:00:00.000Z",
          artifacts: [],
        },
        compatibility: {
          compatible: true,
          apiContractVersion: 3,
          reason: "ok",
        },
        updater: {
          installed: true,
          healthy: true,
          lastSeenAt: new Date(Date.now() - 15_000).toISOString(),
        },
        state: "available",
        job: {
          id: "job-updating-1",
          vpsId: "vps-6",
          state: "downloading",
          progress: 65,
          releaseId: "rel-deploy",
          releaseVersion: "1.1.0",
          releaseBuildId: BUILD_TARGET,
        },
        automation: {
          state: "updating",
          reason: "Downloading update artifact",
          targetBuildId: BUILD_TARGET,
          retryAllowed: false,
        },
      },
    },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FleetAgentUpdatesPanel", () => {
  it("renders status breakdown counts and deployment host table", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: mockFleetData }),
    });

    render(
      <MemoryRouter>
        <FleetAgentUpdatesPanel />
      </MemoryRouter>,
    );

    // Initial loading indicator
    expect(screen.getByText("Loading agent status…")).toBeInTheDocument();

    // Table renders
    expect(await screen.findByRole("table", { name: "Deployment Agent Updates" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThanOrEqual(5);

    // Counts breakdown
    expect(screen.getByRole("tab", { name: /Total Hosts/ })).toHaveTextContent("6");
    expect(screen.getByRole("tab", { name: /Up to Date/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Updating/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Waiting/ })).toHaveTextContent("2"); // pending (1) + waiting_connection (1)
    expect(screen.getByRole("tab", { name: /Needs Access/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /Failed/ })).toHaveTextContent("1");

    // Host rows rendered
    expect(screen.getByText("prod-web-01")).toBeInTheDocument();
    expect(screen.getByText("prod-db-01")).toBeInTheDocument();
    expect(screen.getByText("worker-01")).toBeInTheDocument();
    expect(screen.getByText("edge-01")).toBeInTheDocument();
    expect(screen.getByText("legacy-01")).toBeInTheDocument();
    expect(screen.getByText("staging-01")).toBeInTheDocument();

    // Determinate progress for updating host
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "65");
  });

  it("filters hosts by tab selection", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: mockFleetData }),
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FleetAgentUpdatesPanel />
      </MemoryRouter>,
    );

    await screen.findByText("prod-web-01");

    // Click Needs Access filter tab
    const needsAccessTab = screen.getByRole("tab", { name: /Needs Access/ });
    await user.click(needsAccessTab);

    expect(screen.getByText("edge-01")).toBeInTheDocument();
    expect(screen.queryByText("prod-web-01")).not.toBeInTheDocument();
    expect(screen.queryByText("prod-db-01")).not.toBeInTheDocument();

    // Click Failed tab
    const failedTab = screen.getByRole("tab", { name: /Failed/ });
    await user.click(failedTab);

    expect(screen.getByText("legacy-01")).toBeInTheDocument();
    expect(screen.queryByText("edge-01")).not.toBeInTheDocument();
  });

  it("filters hosts by search query", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: mockFleetData }),
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FleetAgentUpdatesPanel />
      </MemoryRouter>,
    );

    await screen.findByText("prod-web-01");

    const searchInput = screen.getByRole("textbox", { name: "Search hosts" });
    await user.type(searchInput, "prod-db");

    expect(screen.getByText("prod-db-01")).toBeInTheDocument();
    expect(screen.queryByText("prod-web-01")).not.toBeInTheDocument();
  });

  it("requests agent update on a host with Idempotency-Key and updates row state", async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/agent-updates")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: mockFleetData }),
        };
      }
      if (urlStr.includes("/api/vps/vps-1/agent-update") && init?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            data: {
              ...mockFleetData.hosts[0].update,
              automation: {
                state: "updating",
                reason: "Update queued for execution",
                targetBuildId: BUILD_TARGET,
                retryAllowed: false,
              },
            },
          }),
        };
      }
      return { ok: false, status: 500, json: async () => ({ error: { message: "unexpected" } }) };
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FleetAgentUpdatesPanel />
      </MemoryRouter>,
    );

    await screen.findByText("prod-web-01");

    const updateButton = screen.getByRole("button", { name: "Update agent on prod-web-01" });
    expect(updateButton).toBeEnabled();

    await user.click(updateButton);

    // Verify POST was called with Idempotency-Key
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/api/vps/vps-1/agent-update") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const headers = new Headers((postCall![1] as RequestInit).headers);
    expect(headers.get("Idempotency-Key")).toBeTruthy();

    // Row state updates to updating
    expect(
      await screen.findByRole("button", { name: "Updating… agent on prod-web-01" }),
    ).toBeDisabled();
  });
});
