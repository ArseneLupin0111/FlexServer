import "../../../test/setup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TerminalPanel } from "./TerminalPanel";
import type { VpsRecord } from "../../../lib/api";

interface MockTerminalInstance {
  cols: number;
  rows: number;
  emit: (data: string) => void;
  key: (event: Partial<KeyboardEvent>) => boolean;
  selection: string;
  focus: Mock;
  dispose: Mock;
  open: Mock;
  loadAddon: Mock;
  write: Mock;
}
interface MockObserverInstance {
  callback: () => void;
  disconnect: Mock;
}

interface MockFitInstance {
  fit: Mock;
  dispose: Mock;
}

const { sockets, terminals, observers, fits } = vi.hoisted(() => ({
  sockets: [] as MockSocket[],
  terminals: [] as MockTerminalInstance[],
  observers: [] as MockObserverInstance[],
  fits: [] as MockFitInstance[],
}));

class MockSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void; onmessage?: (event: { data: string }) => void;
  onerror?: () => void; onclose?: () => void;
  constructor(public url: string) { sockets.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    selection = "";
    handler?: (data: string) => void;
    keyHandler?: (event: KeyboardEvent) => boolean;
    focus = vi.fn();
    dispose = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    constructor() {
      terminals.push(this);
    }
    onData = vi.fn((handler: (data: string) => void) => {
      this.handler = handler;
      return {
        dispose: vi.fn(() => {
          this.handler = undefined;
        }),
      };
    });
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = handler;
    });
    getSelection = vi.fn(() => this.selection);
    emit(data: string) {
      this.handler?.(data);
    }
    key(event: Partial<KeyboardEvent>) {
      return (
        this.keyHandler?.({
          type: "keydown",
          ctrlKey: false,
          shiftKey: false,
          metaKey: false,
          key: "",
          ...event,
        } as KeyboardEvent) ?? true
      );
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); dispose = vi.fn(); constructor() { fits.push(this); } } }));

const vps = { id: "vps-1", name: "demo", displayName: "Demo", host: "example.test", port: 22, username: "admin", createdAt: "", updatedAt: "" } as VpsRecord;
const rootVps = { ...vps, username: "root" };

beforeEach(() => { sockets.length = 0; terminals.length = 0; observers.length = 0; fits.length = 0; vi.stubGlobal("WebSocket", MockSocket); vi.stubGlobal("ResizeObserver", class { disconnect = vi.fn(); observe = vi.fn(); constructor(public callback: () => void) { observers.push(this); } }); Object.defineProperty(window, "isSecureContext", { configurable: true, value: true }); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: vi.fn(), writeText: vi.fn() } }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("TerminalPanel", () => {
  it("does not open a socket when disabled", () => { render(<TerminalPanel vps={vps} enabled={false} />); expect(screen.getByText("Web terminal is disabled for this environment.")).toBeInTheDocument(); expect(sockets).toHaveLength(0); });
  it("returns to disconnected when enabled without auto-connecting", () => { const { rerender } = render(<TerminalPanel vps={vps} enabled={false} />); expect(screen.getByText("Web terminal is disabled for this environment.")).toBeInTheDocument(); rerender(<TerminalPanel vps={vps} enabled />); expect(screen.getByRole("button", { name: /^Connect$/i })).toBeInTheDocument(); expect(screen.queryByText("Web terminal is disabled for this environment.")).not.toBeInTheDocument(); expect(sockets).toHaveLength(0); });
  it("explicitly connects with the route VPS and bounded dimensions", () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); expect(sockets[0].url).toContain("/api/vps/vps-1/terminal"); sockets[0].open(); expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ type: "open", version: 1, vpsId: "vps-1", cols: 80, rows: 24 }); });
  it("handles ready and output without rendering output in React", async () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); sockets[0].message({ type: "output", data: "secret output" }); await waitFor(() => expect(screen.getAllByText("Connected").length).toBeGreaterThan(0)); expect(screen.queryByText("secret output")).not.toBeInTheDocument(); });
  it("shows safe server errors and cleans up", async () => { const { unmount } = render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "error", code: "INTERNAL_ERROR", message: "private stack trace", retryable: false }); await waitFor(() => expect(screen.getByText(/could not be opened/i)).toBeInTheDocument()); unmount(); expect(sockets[0].readyState).toBe(3); });
  it("preserves a closed state and reconnect opens a new socket", async () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); sockets[0].close(); await waitFor(() => expect(screen.getByText(/closed unexpectedly/i)).toBeInTheDocument()); fireEvent.click(screen.getByRole("button", { name: /^Reconnect$/i })); expect(sockets).toHaveLength(2); expect(sockets[1].url).toContain("/api/vps/vps-1/terminal"); });
  it("keeps the session-expired guidance when the server closes the socket", async () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); sockets[0].message({ type: "closed", reason: "session_expired" }); sockets[0].close(); const guidance = await screen.findByRole("alert"); expect(guidance).toHaveTextContent("Your dashboard session ended, so the terminal closed. Scrollback is preserved. Sign in again to start a new terminal session."); expect(screen.queryByText(/closed unexpectedly/i)).not.toBeInTheDocument(); expect(screen.getAllByText("Session expired").length).toBeGreaterThan(0); });
  it("shows the persistent root warning", () => { render(<TerminalPanel vps={rootVps} />); expect(screen.getByText(/Root shell/)).toBeInTheDocument(); expect(screen.getByText("ROOT")).toBeInTheDocument(); });
  it("expires and stops the socket after ready expiry", async () => { vi.useFakeTimers(); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString() }); await vi.advanceTimersByTimeAsync(1001); expect(screen.getAllByText(/session expired/i).length).toBeGreaterThan(0); expect(sockets[0].readyState).toBe(3); });
  it("sends debounced bounded resize and disposes on unmount", () => { vi.useFakeTimers(); const { unmount } = render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); unmount(); expect(sockets[0].readyState).toBe(3); });
  it("requires explicit confirmation before disconnecting", async () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); await screen.findByText("Close active SSH session?", {}, { timeout: 1 }).catch(() => undefined); fireEvent.click(screen.getByRole("button", { name: /disconnect/i })); expect(screen.getByRole("alertdialog")).toHaveTextContent("Close active SSH session?"); expect(sockets[0].readyState).toBe(1); fireEvent.click(screen.getByRole("button", { name: "Keep session open" })); expect(sockets[0].readyState).toBe(1); fireEvent.click(screen.getByRole("button", { name: /disconnect/i })); fireEvent.click(screen.getByRole("button", { name: "Disconnect and leave" })); expect(sockets[0].readyState).toBe(3); });
  it("sends single-line input directly but confirms multiline paste without displaying or persisting it", async () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); terminals[0].emit("echo safe"); expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "echo safe" }); const terminal = screen.getByRole("application"); const clipboardData = { getData: () => "first secret\nsecond secret" }; fireEvent.paste(terminal, { clipboardData }); expect(screen.getByRole("alertdialog")).toHaveTextContent("Paste multiple lines?"); expect(screen.queryByText(/first secret/)).not.toBeInTheDocument(); const count = sockets[0].sent.length; fireEvent.click(screen.getByRole("button", { name: "Cancel paste" })); expect(sockets[0].sent).toHaveLength(count); fireEvent.paste(terminal, { clipboardData }); fireEvent.click(screen.getByRole("button", { name: "Paste into terminal" })); expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "first secret\nsecond secret" }); });
  it("copies selected text with Ctrl+C and still supports Ctrl+Shift+C", async () => { const writeText = vi.mocked(navigator.clipboard.writeText); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); terminals[0].selection = "selected output"; expect(terminals[0].key({ key: "c", ctrlKey: true })).toBe(false); await waitFor(() => expect(writeText).toHaveBeenCalledWith("selected output")); terminals[0].selection = "other selection"; expect(terminals[0].key({ key: "c", ctrlKey: true, shiftKey: true })).toBe(false); await waitFor(() => expect(writeText).toHaveBeenCalledWith("other selection")); });
  it("leaves Ctrl+C to xterm as SIGINT when there is no selection", () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); terminals[0].selection = ""; expect(terminals[0].key({ key: "c", ctrlKey: true })).toBe(true); terminals[0].emit("\u0003"); expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "\u0003" }); });
  it("pastes single-line clipboard text with plain Ctrl+V", async () => { vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("single command"); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); expect(terminals[0].key({ key: "v", ctrlKey: true })).toBe(false); await waitFor(() => expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "single command" })); });
  it("confirms multiline plain Ctrl+V without sending it", async () => { vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("first\nsecond"); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); const sent = sockets[0].sent.length; expect(terminals[0].key({ key: "v", ctrlKey: true })).toBe(false); expect(await screen.findByRole("alertdialog")).toHaveTextContent("Paste multiple lines?"); expect(sockets[0].sent).toHaveLength(sent); });
  it("keeps Ctrl+Shift+V and Cmd+V paste shortcuts", async () => { const readText = vi.mocked(navigator.clipboard.readText); readText.mockResolvedValueOnce("shift paste").mockResolvedValueOnce("command paste"); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); expect(terminals[0].key({ key: "v", ctrlKey: true, shiftKey: true })).toBe(false); await waitFor(() => expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "shift paste" })); expect(terminals[0].key({ key: "v", metaKey: true })).toBe(false); await waitFor(() => expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "command paste" })); });
  it("lets the DOM paste event own a combined shortcut paste exactly once", async () => { let resolveClipboard!: (value: string) => void; vi.mocked(navigator.clipboard.readText).mockReturnValueOnce(new Promise((resolve) => { resolveClipboard = resolve; })); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); const sent = sockets[0].sent.length; expect(terminals[0].key({ key: "v", ctrlKey: true })).toBe(false); fireEvent.paste(screen.getByRole("application"), { clipboardData: { getData: () => "one paste" } }); resolveClipboard("one paste"); await act(async () => { await Promise.resolve(); }); expect(sockets[0].sent.slice(sent).map((value) => JSON.parse(value))).toEqual([{ type: "input", data: "one paste" }]); });
  it("opens one confirmation for combined multiline shortcut and paste events", async () => { let resolveClipboard!: (value: string) => void; vi.mocked(navigator.clipboard.readText).mockReturnValueOnce(new Promise((resolve) => { resolveClipboard = resolve; })); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); const sent = sockets[0].sent.length; terminals[0].key({ key: "v", ctrlKey: true, shiftKey: true }); fireEvent.paste(screen.getByRole("application"), { clipboardData: { getData: () => "first\nsecond" } }); resolveClipboard("first\nsecond"); await act(async () => { await Promise.resolve(); }); expect(screen.getAllByRole("alertdialog")).toHaveLength(1); expect(sockets[0].sent).toHaveLength(sent); });
  it("handles context-menu single-line and multiline paste once each", async () => { render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); const terminal = screen.getByRole("application"); const sent = sockets[0].sent.length; fireEvent.paste(terminal, { clipboardData: { getData: () => "context paste" } }); expect(sockets[0].sent.slice(sent).map((value) => JSON.parse(value))).toEqual([{ type: "input", data: "context paste" }]); const afterSingle = sockets[0].sent.length; fireEvent.paste(terminal, { clipboardData: { getData: () => "first\nsecond" } }); expect(screen.getAllByRole("alertdialog")).toHaveLength(1); expect(sockets[0].sent).toHaveLength(afterSingle); });
  it("reports denied clipboard access without exposing content", async () => { vi.mocked(navigator.clipboard.readText).mockRejectedValueOnce(new DOMException("denied")); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); terminals[0].key({ key: "v", metaKey: true }); expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard access is unavailable or was denied."); });
  it("reports denied selection copy without exposing selected text", async () => { vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new DOMException("denied")); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); terminals[0].selection = "private selected output"; expect(terminals[0].key({ key: "c", ctrlKey: true })).toBe(false); const alert = await screen.findByRole("alert"); expect(alert).toHaveTextContent("Clipboard access is unavailable or was denied."); expect(alert).not.toHaveTextContent("private selected output"); });
  it("does not paste while disconnected", async () => { vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("do not send"); render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); sockets[0].close(); const sent = sockets[0].sent.length; terminals[0].key({ key: "v", metaKey: true }); expect(await screen.findByText("Connect the terminal before pasting.")).toBeInTheDocument(); expect(sockets[0].sent).toHaveLength(sent); });
  it("debounces resize, bounds dimensions, focuses on ready, and cleans resources", async () => { vi.useFakeTimers(); const { unmount } = render(<TerminalPanel vps={vps} />); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); sockets[0].open(); terminals[0].cols = 900; terminals[0].rows = 0; observers[0].callback(); observers[0].callback(); expect(sockets[0].sent).toHaveLength(1); await vi.advanceTimersByTimeAsync(119); expect(sockets[0].sent).toHaveLength(1); await vi.advanceTimersByTimeAsync(1); expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "resize", cols: 500, rows: 1 }); sockets[0].message({ type: "ready", terminalSessionId: "s1", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }); expect(terminals[0].focus).toHaveBeenCalledOnce(); unmount(); expect(observers[0].disconnect).toHaveBeenCalledOnce(); expect(terminals[0].dispose).toHaveBeenCalledOnce(); });
  it("fully replaces connection resources across repeated reconnects and ignores stale work", async () => { vi.useFakeTimers(); const { unmount } = render(<TerminalPanel vps={vps} />); const terminalElement = screen.getByRole("application"); const removeSpy = vi.spyOn(terminalElement, "removeEventListener"); fireEvent.click(screen.getByRole("button", { name: /^Connect$/i })); const first = sockets[0]; act(() => first.open()); const staleMessage = first.onmessage!; act(() => first.message({ type: "error", message: "timeout" })); fireEvent.click(screen.getByRole("button", { name: /^Reconnect$/i })); expect(observers[0].disconnect).toHaveBeenCalledOnce(); expect(terminals[0].dispose).toHaveBeenCalledOnce(); expect(fits[0].dispose).toHaveBeenCalledOnce(); expect(removeSpy).toHaveBeenCalledWith("paste", expect.any(Function), true); const firstCount = first.sent.length; terminals[0].emit("stale input"); expect(first.sent).toHaveLength(firstCount); const second = sockets[1]; act(() => second.open()); act(() => staleMessage({ data: JSON.stringify({ type: "error", message: "authentication stale" }) })); expect(screen.queryByText("authentication stale")).not.toBeInTheDocument(); observers[0].callback(); observers[1].callback(); observers[1].callback(); await vi.advanceTimersByTimeAsync(120); expect(second.sent.filter((value) => JSON.parse(value).type === "resize")).toHaveLength(1); act(() => second.message({ type: "error", message: "timeout" })); fireEvent.click(screen.getByRole("button", { name: /^Reconnect$/i })); expect(observers[1].disconnect).toHaveBeenCalledOnce(); expect(terminals[1].dispose).toHaveBeenCalledOnce(); expect(fits[1].dispose).toHaveBeenCalledOnce(); unmount(); expect(observers[2].disconnect).toHaveBeenCalledOnce(); expect(terminals[2].dispose).toHaveBeenCalledOnce(); expect(fits[2].dispose).toHaveBeenCalledOnce(); expect(observers.every((item) => item.disconnect.mock.calls.length === 1)).toBe(true); expect(terminals.every((item) => item.dispose.mock.calls.length === 1)).toBe(true); expect(fits.every((item) => item.dispose.mock.calls.length === 1)).toBe(true); });
  it("renders Host terminal and local connection details for local VPS", () => {
    const localHostVps = {
      ...vps,
      id: "local-host",
      kind: "local",
      displayName: "Local Host",
    } as VpsRecord;
    render(<TerminalPanel vps={localHostVps} isLocal />);
    expect(screen.getByText("Host terminal")).toBeInTheDocument();
    expect(screen.getByText("Local Host")).toBeInTheDocument();
    expect(screen.queryByText("SSH terminal")).not.toBeInTheDocument();
  });

  it("renders GUARD ACTIVE badge when commandGuardEnabled is true and GUARD OFF when false", () => {
    const { rerender } = render(
      <TerminalPanel vps={vps} commandGuardEnabled={false} />,
    );
    expect(screen.getByTestId("terminal-guard-badge")).toHaveTextContent("GUARD OFF");

    rerender(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    expect(screen.getByTestId("terminal-guard-badge")).toHaveTextContent("GUARD ACTIVE");
  });

  it("blocks dangerous command execution on Enter when guard is enabled and cancels server line with Ctrl+U", async () => {
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    terminals[0].emit("rm -rf /");

    const sentBeforeEnter = sockets[0].sent.length;
    terminals[0].emit("\r");

    const lastSent = JSON.parse(sockets[0].sent.at(-1)!);
    expect(lastSent.data).toContain("\x15");
    expect(lastSent).toEqual({ type: "input", data: "\x05\x15\x03" });

    const newMessages = sockets[0].sent.slice(sentBeforeEnter).map((m) => JSON.parse(m));
    expect(newMessages.some((m) => m.data === "\r")).toBe(false);

    const alertDialog = await screen.findByRole("alertdialog");
    expect(alertDialog).toHaveTextContent("Dangerous Command Blocked");
    expect(alertDialog).toHaveTextContent("Execution of a potentially destructive command was cancelled before running.");
    expect(alertDialog).toHaveTextContent("Accidental command guard");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("allows safe command execution on Enter without blocking when guard is enabled", () => {
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    terminals[0].emit("echo 'reboot'");
    const sentBefore = sockets[0].sent.length;
    terminals[0].emit("\r");

    expect(sockets[0].sent.length).toBe(sentBefore + 1);
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "\r" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("blocks single-line dangerous clipboard paste immediately without sending to socket", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("rm -rf /");
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const sentBefore = sockets[0].sent.length;
    terminals[0].key({ key: "v", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toHaveTextContent("Dangerous Command Blocked");
    });
    expect(screen.getByText(/Paste blocked: dangerous command detected/i)).toBeInTheDocument();
    expect(sockets[0].sent).toHaveLength(sentBefore);
  });

  it("blocks multiline dangerous paste immediately without opening multiline confirmation", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("echo safe\nmkfs /dev/sda1\necho done");
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const sentBefore = sockets[0].sent.length;
    terminals[0].key({ key: "v", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toHaveTextContent("Dangerous Command Blocked");
    });
    expect(screen.queryByText("Paste multiple lines?")).not.toBeInTheDocument();
    expect(sockets[0].sent).toHaveLength(sentBefore);
  });

  it("allows safe multiline paste with confirmation dialog and sends after approval", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("git status\ngit diff");
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const sentBefore = sockets[0].sent.length;
    terminals[0].key({ key: "v", ctrlKey: true });

    const confirmDialog = await screen.findByRole("alertdialog");
    expect(confirmDialog).toHaveTextContent("Paste multiple lines?");

    fireEvent.click(screen.getByRole("button", { name: "Paste into terminal" }));

    await waitFor(() => {
      expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({
        type: "input",
        data: "git status\ngit diff",
      });
    });
    expect(sockets[0].sent.length).toBe(sentBefore + 1);
  });

  it("updates active session guard behavior when toggle changes without reconnecting (using ref)", async () => {
    const { rerender } = render(<TerminalPanel vps={vps} commandGuardEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    terminals[0].emit("reboot\r");
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "reboot\r" });

    rerender(<TerminalPanel vps={vps} commandGuardEnabled={true} />);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].readyState).toBe(1);

    terminals[0].emit("reboot\r");
    expect(JSON.parse(sockets[0].sent.at(-1)!).data).toContain("\x15");
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "\x05\x15\x03" });
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Dangerous Command Blocked");
  });

  it("allows Enter through when input tracking was invalidated by history recall escape sequence", async () => {
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    terminals[0].emit("\x1b[A");
    const sentBefore = sockets[0].sent.length;

    terminals[0].emit("\r");
    expect(sockets[0].sent.length).toBe(sentBefore + 1);
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ type: "input", data: "\r" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("blocks dangerous command when assembled from typed prefix and pasted suffix", async () => {
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    // User types "rm -rf " into terminal
    terminals[0].emit("rm -rf ");
    const sentBeforePaste = sockets[0].sent.length;

    // User pastes "/etc\n" (which combined with prefix forms "rm -rf /etc\n")
    vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("/etc\n");
    terminals[0].key({ key: "v", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toHaveTextContent("Dangerous Command Blocked");
    });
    expect(sockets[0].sent.length).toBe(sentBeforePaste);
  });

  it("tracks trailing unterminated line from confirmed multiline paste and blocks subsequent dangerous completion", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValueOnce("echo ok\nrm -rf ");
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    terminals[0].key({ key: "v", ctrlKey: true });
    const confirmDialog = await screen.findByRole("alertdialog");
    expect(confirmDialog).toHaveTextContent("Paste multiple lines?");

    fireEvent.click(screen.getByRole("button", { name: "Paste into terminal" }));

    await waitFor(() => {
      expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({
        type: "input",
        data: "echo ok\nrm -rf ",
      });
    });

    // Now user types "/" and hits Enter
    terminals[0].emit("/");
    terminals[0].emit("\r");

    const lastSent = JSON.parse(sockets[0].sent.at(-1)!);
    expect(lastSent.data).toContain("\x15");
    expect(lastSent).toEqual({ type: "input", data: "\x05\x15\x03" });
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Dangerous Command Blocked");
  });

  it("sends multi-byte emoji text without splitting surrogate code units", async () => {
    render(<TerminalPanel vps={vps} commandGuardEnabled={true} />);
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));
    sockets[0].open();
    sockets[0].message({
      type: "ready",
      terminalSessionId: "s1",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const sentBefore = sockets[0].sent.length;
    terminals[0].emit("echo 🚀\r");

    const messages = sockets[0].sent.slice(sentBefore).map((m) => JSON.parse(m));
    // Intact chunk sent containing the emoji without broken surrogates
    expect(messages.some((m) => m.data === "echo 🚀")).toBe(true);
    expect(messages.at(-1)).toEqual({ type: "input", data: "\r" });
  });
});
