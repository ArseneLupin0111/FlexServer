import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsCard } from "./AgentSettingsCard";
import type {
  AiBundleJobState,
  AiBundleLocalJob,
  AiBundleStatus,
  AiCapability,
  AiPolicy,
} from "../../../lib/ai-api";
import type { AgentUpdateView } from "../../../lib/api";

/**
 * Focused tests for the AI bundle install progress slice (web-only): the
 * progress block shows immediately after the Install click, reflects the
 * polled job states (pending/running → succeeded/failed), and never claims a
 * numeric percentage unless the server reported one. Remote SSH jobs
 * (lastJob; channel "ssh" or absent) always stay indeterminate; local
 * updater jobs (localJob; channel "updater") render a determinate bar only
 * for real numeric progress, gate the button on explicit server readiness
 * (installSupported === true, no optimistic inference), and fail closed when
 * the API omits the local job. All transport is mocked — no real VPS or
 * provider is contacted.
 */

type FetchReply = { ok: boolean; status: number; json: () => Promise<unknown> };
const ok = (data: unknown): FetchReply => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status: number, error: { code: string; message: string }): FetchReply => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

const fetchMock = vi.fn();
let handler: (url: string, init?: RequestInit) => FetchReply | Promise<FetchReply> = () =>
  fail(500, { code: "unhandled", message: "unhandled request" });

beforeEach(() => {
  fetchMock.mockReset();
  handler = () => fail(500, { code: "unhandled", message: "unhandled request" });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init)),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const policy: AiPolicy = {
  vpsId: "vps-1",
  aiEnabled: true,
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
  updatedAt: "2026-10-25T00:00:00.000Z",
};

const agentUpdate: AgentUpdateView = {
  installed: { version: "0.9.0", buildId: "aaaa1111bbbb", lastSeenAt: null, fresh: true },
  available: null,
  compatibility: { compatible: true, apiContractVersion: 3, reason: "ok" },
  updater: { installed: true, healthy: true, lastSeenAt: "2026-10-25T09:00:00.000Z" },
  state: "current",
  job: null,
  automation: { state: "current", reason: null, targetBuildId: null, retryAllowed: false },
};

const capability: AiCapability = {
  vpsId: "vps-1",
  supported: true,
  freshness: "2026-10-25T00:00:00.000Z",
  agentVersion: "0.9.0",
  protocolVersion: 3,
  cgroupV2Available: true,
  namespacesAvailable: true,
  seccompAvailable: true,
  profiles: [],
};

const bundleJob = (
  state: AiBundleJobState,
  error: string | null = null,
): AiBundleStatus["lastJob"] => ({
  state,
  error,
  startedAt: "2026-10-25T10:00:00.000Z",
  finishedAt: null,
});

const bundleView = (overrides: Partial<AiBundleStatus> = {}): AiBundleStatus => ({
  available: true,
  bundleId: "b1234567890abcdef1234",
  installed: false,
  lastInstalledBundleId: null,
  lastJob: null,
  capability: { supported: true, privilegedSupported: true },
  ...overrides,
});

const localJob = (
  state: AiBundleJobState,
  progress: number | null = null,
  phase?: string,
  error: string | null = null,
): AiBundleLocalJob => ({
  id: "upd-job-1",
  state,
  progress,
  ...(phase ? { phase } : {}),
  error,
});

/** Eligible local/system host on the updater channel (server readiness
 * explicit). */
const updaterView = (overrides: Partial<AiBundleStatus> = {}): AiBundleStatus =>
  bundleView({
    installChannel: "updater",
    installSupported: true,
    ...overrides,
  });

/** Routes the card's four GETs; the /ai/bundle reply is swappable so tests
 * can drive the polled job state between ticks. */
function routeWithBundle(initial: AiBundleStatus) {
  let bundleReply: FetchReply = ok(initial);
  return {
    setBundle(next: AiBundleStatus) {
      bundleReply = ok(next);
    },
    handler: (url: string, init?: RequestInit): FetchReply => {
      if (url === "/api/vps/vps-1/ai/bundle") return bundleReply;
      if (url === "/api/vps/vps-1/ai/policy") return ok(policy);
      if (url === "/api/vps/vps-1/ai/capability") return ok(capability);
      if (url === "/api/vps/vps-1/agent-update") return ok(agentUpdate);
      return fail(500, { code: "unhandled", message: `unhandled ${url}` });
    },
    bundleCalls(): number {
      return fetchMock.mock.calls.filter(([url]) => String(url) === "/api/vps/vps-1/ai/bundle")
        .length;
    },
  };
}

async function renderCard() {
  render(<AgentSettingsCard vpsId="vps-1" />);
  // Flush the lazy initial loads (policy + runtime rows).
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("AgentSettingsCard AI bundle install progress", () => {
  it("shows the indeterminate progress immediately after Install, then follows queued → running via the 5s poll", async () => {
    vi.useFakeTimers();
    const route = routeWithBundle(bundleView());
    handler = route.handler;

    await renderCard();
    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeEnabled();
    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();

    // The POST stays in flight while we assert — progress must be visible
    // already, before any job view has arrived.
    let resolvePost!: (reply: FetchReply) => void;
    handler = (url, init) => {
      if (url === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST") {
        return new Promise<FetchReply>((resolve) => {
          resolvePost = resolve;
        });
      }
      return route.handler(url, init);
    };

    fireEvent.click(install);

    expect(screen.getByTestId("ai-bundle-install-progress")).toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-install-progress")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    const bar = screen.getByRole("progressbar", { name: "AI bundle install progress" });
    // Indeterminate: the bundle job carries no numeric progress, so no
    // percentage is claimed (no aria-valuenow) and the bar pulses.
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Starting install…",
    );
    expect(install).toBeDisabled();

    // POST resolves with the fresh FULL bundle view (lastJob pending).
    await act(async () => {
      resolvePost(ok(bundleView({ lastJob: bundleJob("pending") })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Install queued…",
    );
    expect(
      screen.getByText("An install or update job is already running."),
    ).toBeInTheDocument();
    // No extra bundle GET until the first poll tick.
    expect(route.bundleCalls()).toBe(1);

    // Poll tick: the host now reports the job running.
    route.setBundle(bundleView({ lastJob: bundleJob("running") }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Installing AI bundle…",
    );
    expect(route.bundleCalls()).toBe(2);
    expect(install).toBeDisabled();
  });

  it("resumes a running job from lastJob after reload, then shows the failed outcome with the latest error", async () => {
    vi.useFakeTimers();
    const route = routeWithBundle(bundleView({ lastJob: bundleJob("running") }));
    handler = route.handler;

    await renderCard();

    // Progress resumes from the persisted lastJob without any click.
    expect(screen.getByTestId("ai-bundle-install-progress")).toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Installing AI bundle…",
    );
    expect(screen.getByTestId("ai-bundle-install")).toBeDisabled();

    // Next poll reports failure with the latest error.
    route.setBundle(
      bundleView({
        lastJob: bundleJob("failed", "ssh: checksum mismatch for ai-executor"),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-job-state")).toHaveTextContent(
      "last install failed",
    );
    expect(screen.getByTestId("ai-bundle-job-error")).toHaveTextContent(
      "ssh: checksum mismatch for ai-executor",
    );
    // Retry stays available.
    expect(screen.getByTestId("ai-bundle-install")).toBeEnabled();
  });

  it("completes via polling, shows success, and refreshes the bundle row to installed", async () => {
    vi.useFakeTimers();
    const route = routeWithBundle(bundleView());
    handler = (url, init) => {
      if (url === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST") {
        return Promise.resolve(
          ok(bundleView({ lastJob: bundleJob("pending") })),
        );
      }
      return route.handler(url, init);
    };

    await renderCard();
    fireEvent.click(screen.getByTestId("ai-bundle-install"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Install queued…",
    );

    // Poll tick: the job succeeded and the host now reports the bundle
    // installed under a new bundle id.
    route.setBundle(
      bundleView({
        installed: true,
        bundleId: "c234567890abcdef1234",
        lastInstalledBundleId: "c234567890abcdef1234",
        lastJob: bundleJob("succeeded"),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-job-state")).toHaveTextContent(
      "last install succeeded",
    );
    const line = screen.getByTestId("ai-bundle-line");
    expect(line).toHaveTextContent("Installed");
    expect(line).toHaveTextContent("c234567890ab");
    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeEnabled();
    expect(install).toHaveTextContent("Update AI bundle");
  });

  it("does not let a runtime GET that began before the install POST resolve over the fresh pending job", async () => {
    vi.useFakeTimers();
    // Deferred stale GET (issued via window focus while the POST is still in
    // flight) and deferred POST, so the overlap is fully controlled.
    let resolvePost!: (reply: FetchReply) => void;
    let resolveStaleGet!: (reply: FetchReply) => void;
    const postPromise = new Promise<FetchReply>((resolve) => {
      resolvePost = resolve;
    });
    const staleGetPromise = new Promise<FetchReply>((resolve) => {
      resolveStaleGet = resolve;
    });
    const stale = bundleView(); // pre-job snapshot: lastJob null
    let bundleGets = 0;
    handler = (url, init) => {
      if (url === "/api/vps/vps-1/ai/bundle") {
        bundleGets += 1;
        if (bundleGets === 1) return ok(stale); // initial load
        if (bundleGets === 2) return staleGetPromise; // focus refresh, held
        return ok(bundleView({ lastJob: bundleJob("running") })); // post-POST polls
      }
      if (url === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST") {
        return postPromise;
      }
      if (url === "/api/vps/vps-1/ai/policy") return ok(policy);
      if (url === "/api/vps/vps-1/ai/capability") return ok(capability);
      if (url === "/api/vps/vps-1/agent-update") return ok(agentUpdate);
      return fail(500, { code: "unhandled", message: `unhandled ${url}` });
    };

    await renderCard();
    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeEnabled();

    // Install clicked: POST in flight.
    fireEvent.click(install);
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Starting install…",
    );

    // A runtime refresh starts while the POST is still unresolved (e.g. the
    // user refocuses the tab); its GET /bundle is held in flight.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bundleGets).toBe(2);

    // POST resolves with the fresh pending job view.
    await act(async () => {
      resolvePost(ok(bundleView({ lastJob: bundleJob("pending") })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Install queued…",
    );
    expect(install).toBeDisabled();

    // The pre-job GET now resolves — it must NOT overwrite the fresh job
    // view (which would stop polling and re-enable Install mid-job).
    await act(async () => {
      resolveStaleGet(ok(stale));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Install queued…",
    );
    expect(screen.getByTestId("ai-bundle-install-progress")).toBeInTheDocument();
    expect(install).toBeDisabled();
    expect(
      screen.getByText("An install or update job is already running."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ai-bundle-job-state")).not.toBeInTheDocument();

    // Polling still engages: the next tick reports the job running.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Installing AI bundle…",
    );
    expect(bundleGets).toBe(3);
    expect(install).toBeDisabled();
  });

  it("disables install and surfaces installReason when the host cannot install (installSupported=false)", async () => {
    vi.useFakeTimers();
    const reason =
      "This local host cannot install AI bundle from dashboard; install on host with install-local-agent.sh --install-ai";
    handler = routeWithBundle(bundleView({ installSupported: false, installReason: reason }))
      .handler;

    await renderCard();

    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();

    // The unsupported host must not reach the install endpoint.
    fireEvent.click(install);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST",
      ),
    ).toBe(false);
  });
});

describe("AgentSettingsCard local AI bundle install (updater channel)", () => {
  it("keeps the bar indeterminate while progress is unknown, then renders the updater's real percentage determinately and completes", async () => {
    vi.useFakeTimers();
    const route = routeWithBundle(updaterView());
    handler = (url, init) => {
      if (url === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST") {
        // Full view (same shape as GET) with the scheduled local job.
        return Promise.resolve(
          ok(updaterView({ localJob: localJob("pending") })),
        );
      }
      return route.handler(url, init);
    };

    await renderCard();
    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeEnabled();

    fireEvent.click(install);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Queued local job: active, indeterminate (no percentage reported yet).
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Install queued…",
    );
    let bar = screen.getByRole("progressbar", { name: "AI bundle install progress" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByTestId("ai-bundle-install-meta")).toHaveTextContent(
      "no percentage estimate",
    );
    expect(install).toBeDisabled();

    // Poll: running but the updater has not reported a number yet — still
    // indeterminate, with the phase surfaced as a label.
    route.setBundle(updaterView({ localJob: localJob("running", null, "downloading") }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Installing AI bundle…",
    );
    expect(screen.getByTestId("ai-bundle-install-meta")).toHaveTextContent(
      "downloading",
    );
    bar = screen.getByRole("progressbar", { name: "AI bundle install progress" });
    expect(bar).not.toHaveAttribute("aria-valuenow");

    // Poll: the updater reports real progress — determinate now.
    route.setBundle(updaterView({ localJob: localJob("running", 42, "downloading") }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    bar = screen.getByRole("progressbar", { name: "AI bundle install progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    // The determinate fill is the bar's single child; indeterminate never
    // sets an inline width.
    expect(bar.firstElementChild).toHaveStyle({ width: "42%" });
    expect(screen.getByTestId("ai-bundle-install-meta")).toHaveTextContent("42%");

    // Poll: terminal success — progress block closes, chip shows, button
    // flips to update.
    route.setBundle(
      updaterView({
        installed: true,
        bundleId: "c234567890abcdef1234",
        lastInstalledBundleId: "c234567890abcdef1234",
        localJob: localJob("succeeded", 100),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-job-state")).toHaveTextContent(
      "last install succeeded",
    );
    expect(screen.getByTestId("ai-bundle-install")).toBeEnabled();
    expect(screen.getByTestId("ai-bundle-install")).toHaveTextContent(
      "Update AI bundle",
    );
  });

  it("fails closed when the updater channel does not report installSupported (no optimistic inference)", async () => {
    vi.useFakeTimers();
    // installChannel=updater but installSupported missing entirely.
    handler = routeWithBundle(
      bundleView({ installChannel: "updater" }),
    ).handler;

    await renderCard();
    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeDisabled();
    expect(screen.getByText("AI bundle install is not supported on this host."))
      .toBeInTheDocument();

    fireEvent.click(install);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("fails closed with the server's installReason when the updater host is explicitly unsupported", async () => {
    vi.useFakeTimers();
    const reason = "Updater is not installed on this host; install the updater first.";
    handler = routeWithBundle(
      updaterView({ installSupported: false, installReason: reason }),
    ).handler;

    await renderCard();
    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();

    fireEvent.click(install);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("resumes a running local job after reload and shows the failed outcome with the updater error", async () => {
    vi.useFakeTimers();
    const route = routeWithBundle(
      updaterView({ localJob: localJob("running", 10) }),
    );
    handler = route.handler;

    await renderCard();

    // Progress resumes from the persisted localJob without any click.
    expect(screen.getByTestId("ai-bundle-install-progress")).toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Installing AI bundle…",
    );
    expect(
      screen.getByRole("progressbar", { name: "AI bundle install progress" }),
    ).toHaveAttribute("aria-valuenow", "10");
    expect(screen.getByTestId("ai-bundle-install")).toBeDisabled();

    // Next poll reports failure with the updater's error.
    route.setBundle(
      updaterView({
        localJob: localJob("failed", 10, undefined, "updater: download checksum mismatch"),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-job-state")).toHaveTextContent(
      "last install failed",
    );
    expect(screen.getByTestId("ai-bundle-job-error")).toHaveTextContent(
      "updater: download checksum mismatch",
    );
    // Retry stays available.
    expect(screen.getByTestId("ai-bundle-install")).toBeEnabled();
  });

  it("does not let a runtime GET that began before the install POST resolve over the fresh localJob view", async () => {
    vi.useFakeTimers();
    let resolvePost!: (reply: FetchReply) => void;
    let resolveStaleGet!: (reply: FetchReply) => void;
    const postPromise = new Promise<FetchReply>((resolve) => {
      resolvePost = resolve;
    });
    const staleGetPromise = new Promise<FetchReply>((resolve) => {
      resolveStaleGet = resolve;
    });
    const stale = updaterView(); // pre-job snapshot: localJob null
    let bundleGets = 0;
    handler = (url, init) => {
      if (url === "/api/vps/vps-1/ai/bundle") {
        bundleGets += 1;
        if (bundleGets === 1) return ok(stale); // initial load
        if (bundleGets === 2) return staleGetPromise; // focus refresh, held
        return ok(updaterView({ localJob: localJob("running", 25) })); // post-POST polls
      }
      if (url === "/api/vps/vps-1/ai/bundle/install" && init?.method === "POST") {
        return postPromise;
      }
      if (url === "/api/vps/vps-1/ai/policy") return ok(policy);
      if (url === "/api/vps/vps-1/ai/capability") return ok(capability);
      if (url === "/api/vps/vps-1/agent-update") return ok(agentUpdate);
      return fail(500, { code: "unhandled", message: `unhandled ${url}` });
    };

    await renderCard();
    const install = screen.getByTestId("ai-bundle-install");
    expect(install).toBeEnabled();

    fireEvent.click(install);
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Starting install…",
    );

    // A runtime refresh starts while the POST is still unresolved; its GET
    // is held in flight.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bundleGets).toBe(2);

    // POST resolves with the fresh full view: local job queued.
    await act(async () => {
      resolvePost(ok(updaterView({ localJob: localJob("pending") })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Install queued…",
    );
    expect(install).toBeDisabled();

    // The pre-job GET now resolves — it must NOT overwrite the fresh
    // localJob view (which would stop polling and re-enable Install).
    await act(async () => {
      resolveStaleGet(ok(stale));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Install queued…",
    );
    expect(screen.getByTestId("ai-bundle-install-progress")).toBeInTheDocument();
    expect(install).toBeDisabled();

    // Polling still engages: the next tick reports running with progress.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(
      screen.getByRole("progressbar", { name: "AI bundle install progress" }),
    ).toHaveAttribute("aria-valuenow", "25");
    expect(bundleGets).toBe(3);
    expect(install).toBeDisabled();
  });

  it("keeps remote SSH behavior unchanged on the ssh channel (indeterminate lastJob progress)", async () => {
    vi.useFakeTimers();
    const route = routeWithBundle(
      bundleView({ installChannel: "ssh", lastJob: bundleJob("running") }),
    );
    handler = route.handler;

    await renderCard();

    // Remote lastJob drives the progress block; no localJob exists and none
    // is inferred — the bar stays indeterminate.
    expect(screen.getByTestId("ai-bundle-install-progress")).toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-install-state")).toHaveTextContent(
      "Installing AI bundle…",
    );
    expect(
      screen.getByRole("progressbar", { name: "AI bundle install progress" }),
    ).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByTestId("ai-bundle-install")).toBeDisabled();

    route.setBundle(
      bundleView({
        installChannel: "ssh",
        installed: true,
        bundleId: "c234567890abcdef1234",
        lastInstalledBundleId: "c234567890abcdef1234",
        lastJob: bundleJob("succeeded"),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByTestId("ai-bundle-install-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-bundle-job-state")).toHaveTextContent(
      "last install succeeded",
    );
    expect(screen.getByTestId("ai-bundle-install")).toBeEnabled();
  });
});
