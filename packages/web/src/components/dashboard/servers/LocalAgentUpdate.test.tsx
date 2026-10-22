import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAgentUpdate } from "./LocalAgentUpdate";
import type {
  AgentUpdateStatus,
  LocalAgentUpgradeJob,
  LocalAgentUpgradeState,
  VpsRecord,
} from "../../../lib/api";
import { DashboardContext, type DashboardCtx } from "../../../context/DashboardContext";

const vps: VpsRecord = {
  id: "local-1",
  name: "local-box",
  displayName: "Local box",
  host: "127.0.0.1",
  port: 22,
  username: "root",
  status: "healthy",
  kind: "local",
  managedBy: "system",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const remoteVps: VpsRecord = {
  id: "remote-1",
  name: "web-01",
  displayName: "web-01",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  status: "healthy",
  agentStatus: "online",
  kind: "remote",
  managedBy: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CURRENT_BUILD = "aaaa1111aaaa2222aaaa3333aaaa4444aaaa5555";
const TARGET_BUILD = "bbbb1111bbbb2222bbbb3333bbbb4444bbbb5555";
const HEARTBEAT_BUILD = "cccc1111cccc2222cccc3333cccc4444cccc5555";

type FetchReply = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (data: unknown): FetchReply => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status: number, error: { code: string; message: string; jobId?: string }): FetchReply => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

const fetchMock = vi.fn();
let handler: (url: string, init?: RequestInit) => FetchReply = () =>
  fail(500, { code: "unhandled", message: "unhandled request" });

const status = (overrides: Partial<AgentUpdateStatus> = {}): AgentUpdateStatus => ({
  installed: {
    version: "1.0.0",
    buildId: CURRENT_BUILD,
    lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    fresh: true,
  },
  available: {
    releaseId: "rel-2001",
    version: "1.1.0",
    buildId: TARGET_BUILD,
    publishedAt: "2026-09-27T08:00:00.000Z",
    artifacts: [
      {
        os: "linux",
        arch: "amd64",
        size: 4096,
        sha256: "d".repeat(64),
        url: "https://releases.example.com/rel-2001/vps-agent-linux-amd64",
      },
    ],
  },
  compatibility: { compatible: true, apiContractVersion: 1, reason: "ok" },
  updater: { installed: true, healthy: true, lastSeenAt: new Date(Date.now() - 60_000).toISOString() },
  state: "available",
  job: null,
  ...overrides,
});

const job = (overrides: Partial<LocalAgentUpgradeJob> = {}): LocalAgentUpgradeJob => ({
  id: "job-1",
  vpsId: "local-1",
  state: "queued" as LocalAgentUpgradeState,
  progress: null,
  releaseId: "rel-2001",
  releaseVersion: "1.1.0",
  releaseBuildId: TARGET_BUILD,
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
  completedAt: null,
  error: null,
  result: null,
  ...overrides,
});

// ── Existing SSE mechanism mock (lib/live-api subscribeMonitoring) ────

type SseListener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onerror: ((event: unknown) => void) | null = null;
  private listeners: Record<string, SseListener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: SseListener): void {
    const existing = this.listeners[type] ?? [];
    this.listeners[type] = [...existing, listener];
  }

  close(): void {}

  static emit(type: string, payload: unknown): void {
    const envelope = {
      data: JSON.stringify({
        schemaVersion: 1,
        type,
        emittedAt: new Date().toISOString(),
        seq: 1,
        payload,
      }),
    };
    for (const inst of MockEventSource.instances) {
      for (const listener of inst.listeners[type] ?? []) {
        listener(envelope as MessageEvent);
      }
    }
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  handler = () => fail(500, { code: "unhandled", message: "unhandled request" });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init)),
  );
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function localStatusFetch(): FetchReply {
  return ok(status());
}

describe("LocalAgentUpdate action flow", () => {
  it("triggers update directly without confirmation dialog and sends Idempotency-Key", async () => {
    let updateRequested = false;
    handler = (url, init) => {
      if (url.includes("/agent-update")) {
        if (init?.method === "POST") {
          updateRequested = true;
          return ok(
            status({
              state: "available",
              job: job({ state: "queued" }),
              automation: {
                state: "updating",
                reason: "Update requested",
                targetBuildId: TARGET_BUILD,
                retryAllowed: false,
              },
            }),
          );
        }
        return localStatusFetch();
      }
      return fail(500, { code: "unexpected", message: "unexpected request" });
    };

    render(<LocalAgentUpdate vps={vps} />);

    await screen.findByText("Update available");
    const user = userEvent.setup();
    const upgradeButton = screen.getByRole("button", { name: "Upgrade agent" });
    await user.click(upgradeButton);

    // No alertdialog is opened!
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/agent-update") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeDefined();
    const [postUrl, postInit] = post as [string, RequestInit];
    expect(postUrl).toBe("/api/vps/local-1/agent-update");
    expect(new Headers(postInit.headers).get("Idempotency-Key")).toBeTruthy();

    await screen.findByText("Queued");
    expect(updateRequested).toBe(true);
  });

  it("retransmits same idempotency key on failure", async () => {
    let callCount = 0;
    let firstKey = "";
    handler = (url, init) => {
      if (url.includes("/agent-update")) {
        if (init?.method === "POST") {
          callCount++;
          firstKey = new Headers(init.headers).get("Idempotency-Key") || "";
          return fail(500, { code: "BUSY", message: "Server busy with active tasks" });
        }
        return localStatusFetch();
      }
      return fail(500, { code: "unexpected", message: "unexpected request" });
    };

    render(<LocalAgentUpdate vps={vps} />);
    await screen.findByText("Update available");
    const user = userEvent.setup();
    const upgradeButton = screen.getByRole("button", { name: "Upgrade agent" });

    await user.click(upgradeButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("Server busy with active tasks");
    expect(callCount).toBe(1);

    // Click again to retransmit
    await user.click(upgradeButton);
    expect(callCount).toBe(2);
    const secondKey = new Headers(
      (fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit).headers,
    ).get("Idempotency-Key");
    expect(secondKey).toBe(firstKey);
  });
});

describe("LocalAgentUpdate persisted job progress", () => {
  it("resumes a persisted job after reload and polls the job endpoint every 5s", async () => {
    vi.useFakeTimers();
    const active = job({ state: "downloading", progress: 42 });
    handler = (url) =>
      url.includes("/agent-update")
        ? ok(status({ job: active, state: "available" }))
        : url.includes("/local-agent-upgrades/job-1")
          ? ok(job({ state: "downloading", progress: 55 }))
          : fail(500, { code: "unexpected", message: "unexpected request" });

    render(<LocalAgentUpdate vps={vps} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Downloading update")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByText(/target 1\.1\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade agent" })).toBeDisabled();
    expect(
      screen.getByText("An upgrade job is already running for this server."),
    ).toBeInTheDocument();

    const jobCallsBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/local-agent-upgrades/job-1"),
    ).length;
    expect(jobCallsBefore).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const jobCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/local-agent-upgrades/job-1"),
    );
    expect(jobCalls.length).toBe(1);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "55");
  });
});

describe("LocalAgentUpdate disabled upgrade control", () => {
  it("shows a disabled upgrade control with the specific job-running reason while a job is live", async () => {
    handler = (url) =>
      url.includes("/agent-update")
        ? ok(status({ job: job({ state: "staging", progress: 30 }), state: "available" }))
        : fail(500, { code: "unexpected", message: "unexpected request" });
    render(<LocalAgentUpdate vps={vps} />);

    expect(await screen.findByText("Staging update")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade agent" })).toBeDisabled();
    expect(
      screen.getByText("An upgrade job is already running for this server."),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  });

  it("associates the disabled upgrade button with its reason for assistive tech", async () => {
    handler = () =>
      ok(
        status({
          state: "unknown",
          installed: { version: "1.0.0", buildId: null, lastSeenAt: "2026-01-01T00:00:00.000Z", fresh: false },
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);

    const button = await screen.findByRole("button", { name: "Upgrade agent" });
    expect(button).toBeDisabled();
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy as string);
    expect(reason).not.toBeNull();
    expect(reason).toHaveTextContent(/heartbeat is stale or the build ID is missing/);
  });
});

describe("LocalAgentUpdate live SSE refresh", () => {
  it("re-reads the persisted job promptly on a host-scoped monitoring event and keeps the 5s poll as fallback", async () => {
    vi.useFakeTimers();
    handler = (url) =>
      url.includes("/agent-update")
        ? ok(status({ job: job({ state: "downloading", progress: 42 }), state: "available" }))
        : url.includes("/local-agent-upgrades/job-1")
          ? ok(job({ state: "staging", progress: 70 }))
          : fail(500, { code: "unexpected", message: "unexpected request" });

    render(<LocalAgentUpdate vps={vps} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    const jobCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/local-agent-upgrades/job-1")).length;
    expect(jobCalls()).toBe(0);

    MockEventSource.emit("metrics.updated", { metrics: [{ vpsId: vps.id }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(jobCalls()).toBe(1);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "70");

    MockEventSource.emit("metrics.updated", { metrics: [{ vpsId: "other-host" }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(jobCalls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(jobCalls()).toBe(2);
  });

  it("re-syncs the persisted job from a monitoring.snapshot after reconnect", async () => {
    vi.useFakeTimers();
    handler = (url) =>
      url.includes("/agent-update")
        ? ok(status({ job: job({ state: "downloading", progress: 42 }), state: "available" }))
        : url.includes("/local-agent-upgrades/job-1")
          ? ok(job({ state: "verifying", progress: 60 }))
          : fail(500, { code: "unexpected", message: "unexpected request" });

    render(<LocalAgentUpdate vps={vps} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    MockEventSource.emit("monitoring.snapshot", { overview: {}, servers: [], jobs: [], metrics: [], auditEvents: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const jobCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/local-agent-upgrades/job-1"));
    expect(jobCalls.length).toBe(1);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
  });
});

describe("LocalAgentUpdate updater absence", () => {
  it("hides the upgrade button whenever the updater is absent, even with a release available", async () => {
    handler = () =>
      ok(
        status({
          state: "unknown",
          installed: { version: "1.0.0", buildId: null, lastSeenAt: "2026-01-01T00:00:00.000Z", fresh: false },
          updater: { installed: false, healthy: false, lastSeenAt: null },
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);

    await screen.findByText("Update status unknown");
    expect(screen.queryByRole("button", { name: "Upgrade agent" })).not.toBeInTheDocument();
  });
});

describe("LocalAgentUpdate terminal results", () => {
  it("keeps the confirmation for a succeeded job in workspace settings", async () => {
    const payload = status({
      installed: { version: "0.1.0", buildId: CURRENT_BUILD, lastSeenAt: new Date().toISOString(), fresh: true },
      state: "release_unavailable",
      available: null,
      compatibility: { compatible: false, apiContractVersion: 1, reason: "release_unavailable" },
      job: job({
        state: "succeeded",
        progress: 100,
        releaseVersion: "0.1.0",
        releaseBuildId: CURRENT_BUILD,
        completedAt: "2026-09-27T10:05:00.000Z",
        result: { outcome: "succeeded", reportedBuildId: CURRENT_BUILD, heartbeatBuildId: CURRENT_BUILD, completedAt: "2026-09-27T10:05:00.000Z" },
      }),
    });
    handler = () => ok(payload);
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/is sending a fresh heartbeat/)).toBeInTheDocument();
  });

  it("shows a succeeded upgrade confirmed by the fresh heartbeat build", async () => {
    handler = () =>
      ok(
        status({
          state: "current",
          available: null,
          job: job({
            state: "succeeded",
            progress: 100,
            completedAt: "2026-09-27T10:05:00.000Z",
            result: { outcome: "succeeded", reportedBuildId: TARGET_BUILD, heartbeatBuildId: HEARTBEAT_BUILD, completedAt: "2026-09-27T10:05:00.000Z" },
          }),
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/is sending a fresh heartbeat/)).toBeInTheDocument();
    expect(screen.getByText(/1\.1\.0/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade agent" })).not.toBeInTheDocument();
    expect(screen.queryByText(/manual intervention required/)).not.toBeInTheDocument();
  });

  it("accurately labels a historical succeeded job as previous upgrade when a new bundled update is available", async () => {
    handler = () =>
      ok(
        status({
          state: "available",
          job: job({
            state: "succeeded",
            progress: 100,
            releaseVersion: "1.0.0",
            releaseBuildId: CURRENT_BUILD,
            completedAt: "2026-09-14T07:00:00.000Z",
            result: { outcome: "succeeded", reportedBuildId: CURRENT_BUILD, heartbeatBuildId: CURRENT_BUILD, completedAt: "2026-09-14T07:00:00.000Z" },
          }),
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/Previous upgrade — 1\.0\.0/)).toBeInTheDocument();
    expect(screen.queryByText(/is sending a fresh heartbeat/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade agent" })).toBeInTheDocument();
  });

  it("marks an unverified rollback as needing manual intervention", async () => {
    handler = () =>
      ok(
        status({
          state: "unknown",
          available: null,
          job: job({
            state: "rollback_unverified",
            completedAt: "2026-09-27T10:06:00.000Z",
            error: { code: "HEARTBEAT_TIMEOUT", message: "No heartbeat after swap deadline" },
          }),
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/rollback is unverified — manual intervention required/)).toBeInTheDocument();
    expect(screen.getByText(/journalctl -u vps-manager-agent/)).toBeInTheDocument();
    expect(screen.queryByText(/failed before the agent was swapped/)).not.toBeInTheDocument();
  });

  it("pairs a verified rollback with operational guidance", async () => {
    handler = () =>
      ok(
        status({
          state: "unknown",
          available: null,
          job: job({
            state: "rolled_back",
            completedAt: "2026-09-27T10:05:00.000Z",
            error: { code: "HEARTBEAT_TIMEOUT", message: "New build missed its heartbeat" },
          }),
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/previous build was verified by heartbeat/)).toBeInTheDocument();
    expect(screen.getByText(/New build missed its heartbeat/)).toBeInTheDocument();
    expect(screen.getByText(/journalctl -u vps-manager-agent/)).toBeInTheDocument();
    expect(screen.getByText(/retry the upgrade/)).toBeInTheDocument();
    expect(screen.queryByText(/manual intervention required/)).not.toBeInTheDocument();
  });

  it("renders a plain failure distinctly from a rollback", async () => {
    handler = () =>
      ok(
        status({
          state: "available",
          job: job({
            state: "failed",
            completedAt: "2026-09-27T10:07:00.000Z",
            error: { code: "DOWNLOAD_FAILED", message: "Checksum mismatch from mirror" },
          }),
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/Upgrade failed before the agent was swapped/)).toBeInTheDocument();
    expect(screen.getByText(/Checksum mismatch from mirror/)).toBeInTheDocument();
  });

  it("renders a deferred terminal result", async () => {
    handler = () =>
      ok(
        status({
          state: "available",
          job: job({
            state: "deferred",
            completedAt: "2026-09-27T10:07:00.000Z",
            result: { outcome: "deferred", completedAt: "2026-09-27T10:07:00.000Z" },
          }),
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/Upgrade was deferred because the host was actively running tasks/)).toBeInTheDocument();
  });

  it("renders a superseded terminal result", async () => {
    handler = () =>
      ok(
        status({
          state: "available",
          job: job({
            state: "superseded",
            completedAt: "2026-09-27T10:07:00.000Z",
            result: { outcome: "superseded", completedAt: "2026-09-27T10:07:00.000Z" },
          }),
        }),
      );
    render(<LocalAgentUpdate vps={vps} />);
    expect(await screen.findByText(/Previous update attempt was superseded by a newer deployment build/)).toBeInTheDocument();
  });
});

describe("Remote agent update in Settings (consolidated contracts)", () => {
  it("renders remote host details and handles update via POST /api/vps/:id/agent-update", async () => {
    let updateRequested = false;
    handler = (url, init) => {
      if (url.includes("/api/vps/remote-1/agent-update")) {
        if (init?.method === "POST") {
          updateRequested = true;
          return ok(
            status({
              state: "available",
              job: job({ vpsId: "remote-1", state: "queued" }),
            }),
          );
        }
        return ok(status());
      }
      return fail(500, { code: "unexpected", message: "unexpected request" });
    };

    render(<LocalAgentUpdate vps={remoteVps} />);

    expect(screen.getByText("Agent updates")).toBeInTheDocument();

    const upgradeButton = await screen.findByRole("button", { name: "Upgrade agent" });
    expect(upgradeButton).toBeEnabled();

    const user = userEvent.setup();
    await user.click(upgradeButton);

    // Consolidated: no alertdialog!
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await waitFor(() => expect(updateRequested).toBe(true));
    expect(await screen.findByText("Queued")).toBeInTheDocument();
  });

  it("disables upgrade when agent is not installed and shows concrete reason", () => {
    const uninstalledVps: VpsRecord = {
      ...remoteVps,
      agentStatus: "not_installed",
    };
    render(<LocalAgentUpdate vps={uninstalledVps} />);

    const button = screen.getByRole("button", { name: "Upgrade agent" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Agent is not installed on this server.")).toBeInTheDocument();
  });

  it("disables upgrade when an installation or upgrade is in progress", () => {
    const installingVps: VpsRecord = {
      ...remoteVps,
      agentStatus: "installing",
    };
    render(<LocalAgentUpdate vps={installingVps} />);

    const button = screen.getByRole("button", { name: "Upgrade agent" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("An agent installation or upgrade is currently in progress."),
    ).toBeInTheDocument();
  });

  it("disables upgrade in demo mode", () => {
    render(
      <DashboardContext.Provider
        value={
          {
            mode: "demo",
            busy: false,
          } as unknown as DashboardCtx
        }
      >
        <LocalAgentUpdate vps={remoteVps} />
      </DashboardContext.Provider>,
    );

    const button = screen.getByRole("button", { name: "Upgrade agent" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Agent upgrades are unavailable in demo mode.")).toBeInTheDocument();
  });

  it("disables upgrade when an active restart job is running", () => {
    const offlineVps: VpsRecord = {
      ...remoteVps,
      agentStatus: "offline",
    };
    render(
      <DashboardContext.Provider
        value={
          {
            mode: "local",
            busy: false,
            jobs: [
              {
                id: "job-restart-1",
                vpsId: offlineVps.id,
                type: "restart-agent",
                status: "running",
                step: "running",
                progress: 50,
              },
            ],
          } as unknown as DashboardCtx
        }
      >
        <LocalAgentUpdate vps={offlineVps} />
      </DashboardContext.Provider>,
    );

    const button = screen.getByRole("button", { name: "Upgrade agent" });
    expect(button).toBeDisabled();
    expect(screen.getByText("An agent restart is currently in progress.")).toBeInTheDocument();
  });

  it("disables upgrade when a credential rotation job is queued", () => {
    render(
      <DashboardContext.Provider
        value={
          {
            mode: "local",
            busy: false,
            jobs: [
              {
                id: "job-rotate-1",
                vpsId: remoteVps.id,
                type: "rotate-agent",
                status: "queued",
                step: "queued",
                progress: 0,
              },
            ],
          } as unknown as DashboardCtx
        }
      >
        <LocalAgentUpdate vps={remoteVps} />
      </DashboardContext.Provider>,
    );

    const button = screen.getByRole("button", { name: "Upgrade agent" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("An agent credential rotation is currently in progress."),
    ).toBeInTheDocument();
  });

  it("shows waiting notice when host automation state is waiting_busy", async () => {
    handler = (url) => {
      if (url.includes("/agent-update")) {
        return ok(
          status({
            automation: {
              state: "waiting_busy",
              reason: "Host has active docker task running",
              targetBuildId: TARGET_BUILD,
              retryAllowed: true,
            },
          }),
        );
      }
      return fail(500, { code: "unexpected", message: "unexpected request" });
    };

    render(<LocalAgentUpdate vps={remoteVps} />);

    expect(
      await screen.findByText(
        "Server is busy with active tasks. Update will automatically apply when the host becomes idle.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Waiting (busy)")).toBeInTheDocument();
  });

  it("shows setup guidance when automation state is needs_access", async () => {
    handler = (url) => {
      if (url.includes("/agent-update")) {
        return ok(
          status({
            state: "updater_unavailable",
            automation: {
              state: "needs_access",
              reason: "SSH key lacked sudo permissions",
              targetBuildId: null,
              retryAllowed: true,
            },
          }),
        );
      }
      return fail(500, { code: "unexpected", message: "unexpected request" });
    };

    render(<LocalAgentUpdate vps={remoteVps} />);

    expect(await screen.findByText("Host setup required")).toBeInTheDocument();
    expect(
      screen.getByText(
        /The updater daemon requires root or passwordless sudo privileges to install and swap binaries/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeInTheDocument();
  });
});
