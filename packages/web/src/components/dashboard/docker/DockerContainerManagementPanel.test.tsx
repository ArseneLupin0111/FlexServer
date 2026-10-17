import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Depth is `src/components/dashboard/docker`, so the shared jest-dom matcher
// setup is three levels up; this resolves from the repo root config too.
import "../../../test/setup";
import { DockerContainerManagementPanel } from "./DockerContainerManagementPanel";

// ── SSE harness ───────────────────────────────────────────────────────
// The panel is exercised through the same shape the transport decodes
// (`docker.logs.state|lines|closed` with a subscription id bound at open),
// so these tests assert viewer behavior, not transport internals.

type StreamLine = {
  stream: "stdout" | "stderr" | "combined";
  text: string;
  truncated: boolean;
};

type OpenStream = {
  url: string;
  subscriptionId: string;
  receivedLines: StreamLine[];
  status: "waiting" | "live" | "stopped" | "disconnected" | "completed" | "expired" | "failed";
  closed: boolean;
  close: () => void;
  state: (status: "waiting" | "live") => void;
  lines: (incoming: StreamLine[]) => void;
  closedEvent: (reason: "completed" | "failed" | "expired", errorCode?: string) => void;
  error: () => void;
};

const openStreams: OpenStream[] = [];

/**
 * Stands in for the browser EventSource. The subscription id is generated
 * per stream exactly like the backend does, and every emitted frame carries
 * it, so the panel's own id binding is what is under test.
 */
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  private source: OpenStream;
  private listeners: Record<string, ((event: MessageEvent) => void)[]> = {};

  constructor(url: string) {
    const index = openStreams.length + 1;
    const subscriptionId = `dlog-sub-${index}`;
    this.source = {
      url,
      subscriptionId,
      receivedLines: [],
      status: "waiting",
      closed: false,
      close: () => this.close(),
      state: (status) => {
        this.source.status = status;
        this.emit("docker.logs.state", { subscriptionId, status });
      },
      lines: (incoming) => {
        this.source.receivedLines.push(...incoming);
        this.emit("docker.logs.lines", { subscriptionId, lines: incoming });
      },
      closedEvent: (reason, errorCode) => {
        this.source.status =
          reason === "completed"
            ? "completed"
            : reason === "expired"
              ? "expired"
              : "failed";
        this.emit("docker.logs.closed", {
          subscriptionId,
          reason,
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
      },
      error: () => {
        this.close();
        this.onerror?.();
      },
    };
    openStreams.push(this.source);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners[type] ?? [];
    set.push(listener);
    this.listeners[type] = set;
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = (this.listeners[type] ?? []).filter((item) => item !== listener);
    this.listeners[type] = set;
  }

  dispatchEvent(event: Event): boolean {
    const type = event.type;
    const message = event as MessageEvent;
    for (const listener of this.listeners[type] ?? []) listener(message);
    return true;
  }

  readonly close = (): void => {
    if (this.source.closed) return;
    this.source.closed = true;
    this.readyState = MockEventSource.CLOSED;
  };

  private readonly emit = (type: string, data: unknown): void => {
    this.dispatchEvent(
      Object.assign(new Event(type), { data: JSON.stringify(data) }),
    );
  };
}

beforeEach(() => {
  // jsdom has no layout: give the log <pre> a bounded scroll box so the
  // pin-the-view contract can be exercised (position vs. reflow independent).
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return 5000;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 400;
    },
  });
  // jsdom ignores scroll writes, which would make "jump to latest" a no-op
  // and the test vacuous; back it with a store both sides can observe.
  let scrollTop = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return scrollTop;
    },
    set(value: number) {
      scrollTop = value;
    },
  });
  vi.stubGlobal("EventSource", MockEventSource);
  openStreams.length = 0;
});

afterEach(() => {
  // The root vitest config runs with `globals: false`, so RTL's auto-cleanup
  // is not registered. Without this each render leaks into the next test.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── API harness ───────────────────────────────────────────────────────

type Capability = {
  supported: boolean;
  actions: ("start" | "stop" | "restart")[];
  logsSupported: boolean;
  maxLogLines: number;
  targets: {
    agentInstanceId: string;
    containerKey: string;
    name: string;
    image?: string;
    state?: string;
  }[];
};

const DEFAULT_CAPABILITY: Capability = {
  supported: true,
  actions: ["start", "stop", "restart"],
  logsSupported: true,
  maxLogLines: 200,
  targets: [
    {
      agentInstanceId: "agent-alpha",
      containerKey: "container-one",
      name: "web",
      image: "nginx:1.27",
      state: "running",
    },
    {
      agentInstanceId: "agent-alpha",
      containerKey: "container-two",
      name: "db",
      image: "postgres:16",
      state: "running",
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function stubCapability(capabilities: Record<string, Capability>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("/docker/management/capability")) {
      const vpsId = new URL(url, "http://localhost").pathname.split("/vps/")[1]?.split("/")[0] ?? "";
      // The endpoint answers with the capability object itself — no
      // `{ data }` envelope — which is what the panel parses.
      return jsonResponse(capabilities[vpsId] ?? DEFAULT_CAPABILITY);
    }
    return jsonResponse({ error: { code: "not_found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** First subscription opens as `waiting`, like the real backend. */
async function openStream(): Promise<OpenStream> {
  await waitFor(() => expect(openStreams.length).toBe(1));
  const stream = openStreams[0];
  act(() => stream.state("waiting"));
  await waitFor(() =>
    expect(screen.getByTestId("docker-log-stream-status").textContent).toBe(
      "Waiting for agent",
    ),
  );
  return stream;
}

function logBody(): string {
  // Uses queryByTestId so an empty buffer (where the <pre> is omitted)
  // returns an empty string rather than throwing during transitions.
  return screen.queryByTestId("docker-log-body")?.textContent ?? "";
}

/**
 * The buffer summary line the panel prints (line count and UTF-8 byte
 * total). Both numbers describe the same published buffer, so they are the
 * observable proof that eviction ran on the logical stream and not on a
 * separate staging queue.
 */
function displayedStats(): { lines: number; bytes: number } {
  const text = screen.getByText(/bytes shown/).textContent ?? "";
  return {
    lines: Number(/(\d+) lines?/.exec(text)?.[1] ?? "0"),
    bytes: Number(/(\d+) bytes/.exec(text)?.[1] ?? "0"),
  };
}

describe("DockerContainerManagementPanel logs", () => {
  it("subscribes to the first valid target once capability resolves", async () => {
    stubCapability({});

    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);

    const stream = await openStream();
    expect(stream.url).toContain("agentInstanceId=agent-alpha");
    expect(stream.url).toContain("containerKey=container-one");

    act(() => stream.state("live"));
    await waitFor(() =>
      expect(screen.getByTestId("docker-log-stream-status").textContent).toBe("Live"),
    );
  });

  it("does not subscribe when log streaming is unsupported", async () => {
    stubCapability({
      "vps-1": { ...DEFAULT_CAPABILITY, logsSupported: false },
    });

    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);

    await waitFor(() => expect(screen.getByText("Container logs")).toBeInTheDocument());
    expect(openStreams).toHaveLength(0);
    expect(screen.getByTestId("docker-log-stream-status").textContent).toBe(
      "Not supported",
    );
  });

  it("streams read-only logs with management disabled and keeps actions disabled", async () => {
    stubCapability({
      "vps-1": { ...DEFAULT_CAPABILITY, supported: false, actions: [], logsSupported: true },
    });

    render(<DockerContainerManagementPanel vpsId="vps-1" enabled={false} refreshTick={0} />);

    const stream = await openStream();
    act(() => stream.state("live"));
    for (const action of ["start", "stop", "restart"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${action}$`, "i") }).filter((button) => (button as HTMLButtonElement).disabled)).toHaveLength(1);
    }
    expect(screen.getByTestId("docker-log-stream-status")).toHaveTextContent("Live");
  });

  it("closes read-only logs when a capability refresh revokes log support", async () => {
    stubCapability({
      "vps-1": { ...DEFAULT_CAPABILITY, supported: false, actions: [], logsSupported: true },
    });
    const view = render(<DockerContainerManagementPanel vpsId="vps-1" enabled={false} refreshTick={0} />);
    const stream = await openStream();
    stubCapability({
      "vps-1": { ...DEFAULT_CAPABILITY, supported: false, actions: [], logsSupported: false, targets: [] },
    });
    view.rerender(<DockerContainerManagementPanel vpsId="vps-1" enabled={false} refreshTick={1} />);
    await waitFor(() => expect(stream.closed).toBe(true));
    expect(openStreams).toHaveLength(1);
  });

  it("appends new lines in delivery order while preserving truncation flags", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();

    act(() => stream.state("live"));
    act(() =>
      stream.lines([
        { stream: "stdout", text: "first-line", truncated: false },
        { stream: "stderr", text: "second-line", truncated: false },
      ]),
    );
    await waitFor(() => expect(logBody()).toContain("first-line"));

    act(() =>
      stream.lines([{ stream: "stdout", text: "third-line", truncated: true }]),
    );
    await waitFor(() => expect(logBody()).toContain("third-line"));

    const body = logBody();
    expect(body.indexOf("first-line")).toBeLessThan(body.indexOf("second-line"));
    expect(body.indexOf("second-line")).toBeLessThan(body.indexOf("third-line"));
    expect(body).not.toContain("undefined");
  });

  it("clears the buffer and drops stale frames when the target changes", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const first = await openStream();
    act(() => first.state("live"));
    act(() => first.lines([{ stream: "stdout", text: "line-in-first", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("line-in-first"));

    await userEvent.selectOptions(
      screen.getByLabelText("Target container"),
      "agent-alpha::container-two",
    );

    await waitFor(() => expect(openStreams).toHaveLength(2));
    const second = openStreams[1];
    expect(first.closed).toBe(true);
    expect(second.url).toContain("containerKey=container-two");

    // A frame from the retired viewer must never reach the new buffer.
    act(() => first.lines([{ stream: "stdout", text: "STALE-FRAME", truncated: false }]));
    act(() => second.state("waiting"));
    act(() => second.lines([{ stream: "stdout", text: "line-in-second", truncated: false }]));

    await waitFor(() => expect(logBody()).toContain("line-in-second"));
    expect(logBody()).not.toContain("STALE-FRAME");
    expect(logBody()).not.toContain("line-in-first");
  });

  it("closes the viewer and releases the stream when the VPS scope changes", async () => {
    stubCapability({});
    const { rerender } = render(
      <DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />,
    );
    const stream = await openStream();
    act(() => stream.state("live"));

    rerender(<DockerContainerManagementPanel vpsId="vps-2" enabled refreshTick={0} />);

    await waitFor(() => expect(stream.closed).toBe(true));
    await waitFor(() => expect(openStreams).toHaveLength(2));
    expect(openStreams[1].url).toContain("vps-2");
  });

  it("stops delivering lines once Stop closes the viewer", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() => stream.lines([{ stream: "stdout", text: "before-stop", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("before-stop"));

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(stream.closed).toBe(true);
    await waitFor(() =>
      expect(screen.getByTestId("docker-log-stream-status").textContent).toBe("Stopped"),
    );
    // Stop keeps what was on screen; it does not wipe the buffer.
    expect(logBody()).toContain("before-stop");

    act(() => stream.lines([{ stream: "stdout", text: "after-stop", truncated: false }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logBody()).not.toContain("after-stop");
  });

  it("Clear only drops the display buffer while the source keeps streaming", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() => stream.lines([{ stream: "stdout", text: "initial", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("initial"));

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    // The log surface is dropped entirely when there is nothing to read.
    await waitFor(() =>
      expect(screen.queryByTestId("docker-log-body")).not.toBeInTheDocument(),
    );
    // The source is untouched: Clear is display-only.
    expect(stream.closed).toBe(false);

    act(() => stream.lines([{ stream: "stdout", text: "still-arriving", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("still-arriving"));
  });

  it("Reconnect clears the buffer and opens a fresh stream", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const first = await openStream();
    act(() => first.state("live"));
    act(() => first.lines([{ stream: "stdout", text: "old-window", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("old-window"));

    // The user stops an open viewer (or it disconnects) before Reconnect is exposed.
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(first.closed).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(openStreams).toHaveLength(2));
    // The previous buffer is discarded: the new viewer reopens cleanly.
    await waitFor(() =>
      expect(screen.queryByTestId("docker-log-body")).not.toBeInTheDocument(),
    );

    // The fresh subscription binds exactly like the first: `waiting` opens
    // it, then `live` admits lines. Anything sent before that binding is
    // foreign to this viewer and correctly discarded.
    const second = openStreams[1];
    act(() => second.state("waiting"));
    act(() => second.state("live"));
    act(() => second.lines([{ stream: "stdout", text: "new-window", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("new-window"));
    expect(logBody()).not.toContain("old-window");
  });

  it("discards the oldest lines past the display bound and says so", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() => stream.lines([{ stream: "stdout", text: "oldest-line-marker", truncated: false }]));

    for (let batch = 0; batch < 25; batch += 1) {
      act(() =>
        stream.lines(
          Array.from({ length: 100 }, (_, index) => ({
            stream: "stdout",
            text: `bulk-${batch}-${index}`,
            truncated: false,
          })),
        ),
      );
    }

    await waitFor(() => expect(logBody()).toContain("bulk-24-99"));
    expect(logBody()).not.toContain("oldest-line-marker");
    expect(
      screen.getByText("Older displayed lines were discarded."),
    ).toBeInTheDocument();
  });

  it("reports a safe failure reason without echoing daemon text", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() => stream.closedEvent("failed", "daemon_unreachable"));

    await waitFor(() =>
      expect(
        screen.getByText(/Docker daemon on this server could not be reached/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Error response from daemon/i)).toBeNull();
  });

  it("closes on error and never silently reconnects", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));

    act(() => stream.error());

    await waitFor(() =>
      expect(screen.getByTestId("docker-log-stream-status").textContent).toBe(
        "Disconnected",
      ),
    );
    // Reconnecting is an explicit user action, never a silent retry.
    expect(openStreams).toHaveLength(1);
    expect(stream.closed).toBe(true);
  });

  it("keeps the stream open across a capability refresh that keeps the same target", async () => {
    stubCapability({});
    const { rerender } = render(
      <DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />,
    );
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() => stream.lines([{ stream: "stdout", text: "survives-refresh", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("survives-refresh"));

    // A monitoring refresh tick must not tear down a live subscription.
    rerender(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={7} />);

    await waitFor(() => expect(openStreams).toHaveLength(1));
    expect(stream.closed).toBe(false);
    expect(logBody()).toContain("survives-refresh");
  });

  it("holds the reading position when scrolled up and returns to the tail on demand", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    // The wire contract caps every frame at 100 lines; emitting 300 in one
    // frame would violate the contract and close the stream. Emitted in
    // three valid batches of 100.
    for (let batch = 0; batch < 3; batch += 1) {
      act(() =>
        stream.lines(
          Array.from({ length: 100 }, (_, index) => ({
            stream: "stdout" as const,
            text: `line-${batch * 100 + index}`,
            truncated: false,
          })),
        ),
      );
    }

    const area = await waitFor(() => {
      const node = screen.getByTestId("docker-log-body");
      expect(node.textContent).toContain("line-299");
      return node;
    });

    // Scrolled up: new lines arrive without yanking the reader back down.
    // The scroll geometry is installed on the prototype, so the event must
    // not carry a `target` — assigning those getters would throw.
    act(() => {
      area.scrollTop = 120;
      fireEvent.scroll(area);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument(),
    );
    act(() =>
      stream.lines([{ stream: "stdout", text: "appended-while-scrolled-up", truncated: false }]),
    );
    await waitFor(() => expect(area.textContent).toContain("appended-while-scrolled-up"));
    expect(area.scrollTop).toBe(120);

    await userEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    await waitFor(() => expect(area.scrollTop).toBe(area.scrollHeight));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Jump to latest" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("accepts carriage returns in lines as permitted by the wire contract", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    // A CR without LF represents in-place progress output or a CRLF stream.
    // The backend forbids only LF; CR must be accepted and displayed.
    act(() =>
      stream.lines([
        { stream: "stdout", text: "downloading 45%\rdownloading 100%", truncated: false },
      ]),
    );

    await waitFor(() =>
      expect(logBody()).toContain("downloading 45%\rdownloading 100%"),
    );
    expect(stream.closed).toBe(false);
  });

  it("resets the buffer and auto-subscribes when target changes while stopped", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const first = await openStream();
    act(() => first.state("live"));
    act(() => first.lines([{ stream: "stdout", text: "first-container-log", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("first-container-log"));

    // User stops viewing container-one.
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(first.closed).toBe(true));

    // Changing target while stopped must NOT retain the old buffer and
    // MUST auto-subscribe to the newly chosen target.
    await userEvent.selectOptions(
      screen.getByLabelText("Target container"),
      "agent-alpha::container-two",
    );

    await waitFor(() => expect(openStreams).toHaveLength(2));
    const second = openStreams[1];
    expect(second.url).toContain("containerKey=container-two");
    // Old buffer is discarded from screen immediately.
    expect(logBody()).not.toContain("first-container-log");

    // The auto-subscription opens the new target in `waiting` first: the
    // subscription id is only bound at that handshake.
    act(() => second.state("waiting"));
    act(() => second.state("live"));
    act(() => second.lines([{ stream: "stdout", text: "second-container-log", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("second-container-log"));
  });

  it("surfaces a visible marker for lines marked truncated by the wire contract", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() =>
      stream.lines([
        { stream: "stdout", text: "normal-line", truncated: false },
        { stream: "stderr", text: "long-line-prefix", truncated: true },
      ]),
    );

    await waitFor(() => expect(logBody()).toContain("normal-line"));
    // The marker is observable and travels with the truncated line: any
    // visible bracketed notice after the text proves the flag reached the
    // viewport, without pinning the exact words.
    expect(logBody()).toMatch(/long-line-prefix.*\[[^\]]*truncat[^\]]*\]/);
    // Untruncated lines get no marker at all.
    expect(logBody()).not.toMatch(/normal-line.*\[/);
  });

  it("keeps the log viewport mounted during capability refreshes so scroll position is preserved", async () => {
    stubCapability({});
    const { rerender } = render(
      <DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />,
    );
    const stream = await openStream();
    act(() => stream.state("live"));
    for (let batch = 0; batch < 3; batch += 1) {
      act(() =>
        stream.lines(
          Array.from({ length: 100 }, (_, index) => ({
            stream: "stdout" as const,
            text: `persist-${batch * 100 + index}`,
            truncated: false,
          })),
        ),
      );
    }

    const pre = await waitFor(() => {
      const node = screen.getByTestId("docker-log-body");
      expect(node.textContent).toContain("persist-299");
      return node;
    });

    act(() => {
      pre.scrollTop = 250;
      fireEvent.scroll(pre);
    });
    expect(pre.scrollTop).toBe(250);

    // Monitoring refresh tick: the capability is reloaded in the background.
    // The <pre> node MUST NOT be unmounted or remounted, which would reset scrollTop.
    rerender(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={42} />);

    // Viewport remains the same element with its scroll position intact.
    const preAfter = screen.getByTestId("docker-log-body");
    expect(preAfter).toBe(pre);
    expect(preAfter.scrollTop).toBe(250);
  });

  it("discards oldest lines when buffer exceeds the 1 MiB byte bound independently of row count", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() =>
      stream.lines([{ stream: "stdout", text: "marker-to-be-evicted-by-bytes", truncated: false }]),
    );
    await waitFor(() => expect(logBody()).toContain("marker-to-be-evicted-by-bytes"));

    // The wire caps each frame at 32 KiB serialized and 100 lines, so a
    // contract-respecting burst must be emitted in frames that stay under
    // both. 90 lines × ~570 chars ≈ 51 KB is over the cap, so the frame is
    // sized from a conservative line budget: 7 lines × ~4 KiB ≈ 28 KiB.
    // 40 such frames = 280 fat lines ≈ 1.12 MB of bytes while the row count
    // stays far below the 2,000-line bound, so the byte limit is what fires.
    const fatText = "y".repeat(4064);
    for (let frame = 0; frame < 40; frame += 1) {
      act(() =>
        stream.lines(
          Array.from({ length: 7 }, (_, index) => ({
            stream: "stdout" as const,
            text: `f${frame}-l${index}-${fatText}`,
            truncated: false,
          })),
        ),
      );
    }

    // Wait until the terminal line is actually rendered: asserting on the
    // discard notice alone before the flush completes proves only that the
    // staging queue noticed the burst, not that the display buffer evicted
    // the oldest line.
    await waitFor(() =>
      expect(logBody()).toContain(`f39-l6-${fatText}`),
    );
    expect(
      screen.getByText("Older displayed lines were discarded."),
    ).toBeInTheDocument();
    expect(logBody()).not.toContain("marker-to-be-evicted-by-bytes");
  });

  // ── Publication throttle and burst eviction ─────────────────────────
  // One bounded ref is the whole buffer: appends evict immediately on the
  // logical stream, and a render is a publication at most once per
  // DISPLAY_BATCH_MS. These tests pin that split against regressions in
  // either direction — an unbounded staging queue (rows/bytes shown lie)
  // and a per-append flush (renders thrash under a burst).

  it("keeps the displayed row and byte totals bounded under a contract burst", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));
    act(() =>
      stream.lines([
        { stream: "stdout", text: "oldest-line-marker", truncated: false },
      ]),
    );
    await waitFor(() => expect(logBody()).toContain("oldest-line-marker"));

    // 25 frames of 100 lines each: the row bound must cap the logical
    // stream at exactly 2,000 lines, no matter how many were delivered.
    for (let frame = 0; frame < 25; frame += 1) {
      act(() =>
        stream.lines(
          Array.from({ length: 100 }, (_, index) => ({
            stream: "stdout",
            text: `burst-${frame}-${index}`,
            truncated: false,
          })),
        ),
      );
    }

    // The terminal line of the burst proves the flush finished: asserting
    // on totals while frames are still in flight would read a stale window.
    await waitFor(() => expect(logBody()).toContain("burst-24-99"));
    const stats = displayedStats();
    expect(stats.lines).toBe(2000);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(
      screen.getByText("Older displayed lines were discarded."),
    ).toBeInTheDocument();
    // The oldest line evicted globally; the newest survived in order.
    expect(logBody()).not.toContain("oldest-line-marker");
    expect(logBody()).not.toContain("burst-0-0");
    expect(logBody()).toContain("burst-24-99");
    expect(stream.closed).toBe(false);
  });

  it("coalesces a burst into one publication per throttle window", async () => {
    stubCapability({});
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled refreshTick={0} />);
    const stream = await openStream();
    act(() => stream.state("live"));

    const frame = (tag: string, count: number): StreamLine[] =>
      Array.from({ length: count }, (_, index) => ({
        stream: "stdout",
        text: `${tag}-${index}`,
        truncated: false,
      }));

    // Emit three frames back-to-back inside the same throttle window: the
    // display total must not move until the window elapses, then it must
    // jump by all three frames at once.
    act(() => stream.lines(frame("round-a", 100)));
    const before = screen.getByText(/bytes shown/).textContent;
    act(() => stream.lines(frame("round-b", 100)));
    act(() => stream.lines(frame("round-c", 100)));
    expect(screen.getByText(/bytes shown/).textContent).toBe(before);

    await waitFor(() =>
      expect(screen.getByText(/bytes shown/).textContent).not.toBe(before),
    );
    expect(displayedStats().lines).toBe(300);
    expect(logBody()).toContain("round-a-0");
    expect(logBody()).toContain("round-c-99");
    expect(stream.closed).toBe(false);
  });
});

describe("DockerContainerManagementPanel fixed target (container detail)", () => {
  const DETAIL_TARGET = {
    agentInstanceId: "agent-alpha",
    containerKey: "container-two",
  };

  it("subscribes to the routed container and hides the target selector", async () => {
    stubCapability({});

    render(
      <DockerContainerManagementPanel
        vpsId="vps-1"
        enabled
        refreshTick={0}
        fixedTarget={DETAIL_TARGET}
      />,
    );

    const stream = await openStream();
    expect(stream.url).toContain("agentInstanceId=agent-alpha");
    expect(stream.url).toContain("containerKey=container-two");
    expect(screen.queryByLabelText("Target container")).not.toBeInTheDocument();

    act(() => stream.state("live"));
    act(() => stream.lines([{ stream: "stdout", text: "detail-line", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("detail-line"));
  });

  it("shows the container's own name and key on the detail surface", async () => {
    stubCapability({});

    render(
      <DockerContainerManagementPanel
        vpsId="vps-1"
        enabled
        refreshTick={0}
        fixedTarget={DETAIL_TARGET}
      />,
    );

    await waitFor(() => expect(screen.getByText("db")).toBeInTheDocument());
    expect(screen.getByText(/container-two/)).toBeInTheDocument();
    expect(screen.getByText("Container detail")).toBeInTheDocument();
  });

  it("reports a stale or missing container as unavailable and never falls back to another target", async () => {
    stubCapability({
      // The routed container is no longer in the inventory; only a
      // different container remains. The page must not silently attach to it.
      "vps-1": {
        ...DEFAULT_CAPABILITY,
        targets: [DEFAULT_CAPABILITY.targets[0]],
      },
    });

    render(
      <DockerContainerManagementPanel
        vpsId="vps-1"
        enabled
        refreshTick={0}
        fixedTarget={DETAIL_TARGET}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          /This container is not reported in the server's current inventory/i,
        ),
      ).toBeInTheDocument(),
    );
    expect(openStreams).toHaveLength(0);
    expect(screen.getByTestId("docker-log-stream-status").textContent).toBe(
      "Idle",
    );
    expect(
      screen.getByText(/Container is unavailable, so no log stream is open/i),
    ).toBeInTheDocument();
    // The survivor is never streamed from this page.
    expect(screen.queryByText("web")).not.toBeInTheDocument();
  });

  it("confirms an action against the fixed container, never another target", async () => {
    stubCapability({});
    const fetchMock = vi.mocked(globalThis.fetch);
    render(
      <DockerContainerManagementPanel
        vpsId="vps-1"
        enabled
        refreshTick={0}
        fixedTarget={DETAIL_TARGET}
      />,
    );

    const restart = await screen.findByRole("button", { name: "restart" });
    expect(restart).toBeEnabled();
    await userEvent.click(restart);

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Restart container/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/container-two/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: /Confirm restart/i }));
    // The action POST carries the routed pair only.
    await waitFor(() => {
      const actionCall = fetchMock.mock.calls.find(([requestUrl]) =>
        String(requestUrl).includes("/docker/management/actions"),
      );
      expect(actionCall).toBeTruthy();
      const body = JSON.parse(String((actionCall?.[1] as RequestInit)?.body));
      expect(body.action).toBe("restart");
      expect(body.target).toEqual({
        agentInstanceId: "agent-alpha",
        containerKey: "container-two",
      });
    });
  });

  it("clears the log stream when the route switches to another container", async () => {
    stubCapability({});
    const { rerender } = render(
      <DockerContainerManagementPanel
        vpsId="vps-1"
        enabled
        refreshTick={0}
        fixedTarget={DETAIL_TARGET}
      />,
    );
    const first = await openStream();
    act(() => first.state("live"));
    act(() => first.lines([{ stream: "stdout", text: "container-two-line", truncated: false }]));
    await waitFor(() => expect(logBody()).toContain("container-two-line"));

    rerender(
      <DockerContainerManagementPanel
        vpsId="vps-1"
        enabled
        refreshTick={0}
        fixedTarget={{ agentInstanceId: "agent-alpha", containerKey: "container-one" }}
      />,
    );

    await waitFor(() => expect(openStreams).toHaveLength(2));
    expect(first.closed).toBe(true);
    const second = openStreams[1];
    expect(second.url).toContain("containerKey=container-one");
    await waitFor(() =>
      expect(screen.queryByTestId("docker-log-body")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("web")).toBeInTheDocument();
  });
});

describe("container lifecycle consent", () => {
  it("starts immediately once, checks outcome manually, and confirms or cancels Stop", async () => {
    const operation = { id: "op-1", vpsId: "vps-1", action: "start", target: { agentInstanceId: "agent-alpha", containerKey: "container-one" }, status: "queued", createdAt: "2026-01-01T00:00:00Z" };
    let finish: (value: Response) => void = () => {};
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/capability")) return jsonResponse(DEFAULT_CAPABILITY);
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body as string));
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return jsonResponse({ ...operation, status: "succeeded" });
    }));
    render(<DockerContainerManagementPanel vpsId="vps-1" enabled />);
    const start = await screen.findByRole("button", { name: "start" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start); fireEvent.click(start);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ action: "start", target: operation.target });
    await act(async () => { finish(jsonResponse(operation)); });
    expect(screen.getByText(/Operation status:/)).toHaveTextContent("queued");
    fireEvent.click(screen.getByRole("button", { name: "Check status manually" }));
    await waitFor(() => expect(screen.getByText(/Operation status:/)).toHaveTextContent("succeeded"));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(posts).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ action: "stop", target: operation.target });
    await act(async () => { finish(jsonResponse({ ...operation, action: "stop" })); });
  });

  it("cancels confirmation when the selected identity changes", async () => {
    const calls = stubCapability({});
    const { rerender } = render(<DockerContainerManagementPanel vpsId="vps-1" enabled />);
    const stop = await screen.findByRole("button", { name: "stop" });
    await waitFor(() => expect(stop).toBeEnabled());
    fireEvent.click(stop);
    fireEvent.change(screen.getByRole("combobox", { hidden: true }), { target: { value: "agent-alpha::container-two" } });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    fireEvent.click(stop);
    rerender(<DockerContainerManagementPanel vpsId="vps-2" enabled />);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(calls.filter((url) => url.endsWith("/actions"))).toEqual([]);
  });
});
