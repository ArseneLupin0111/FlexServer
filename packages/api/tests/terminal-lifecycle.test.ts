import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { TerminalSessionService, type TerminalSocket } from "../src/terminal/terminal-session.service.js";
import type { AppConfig } from "../src/config/app-config.js";
import { AgentLifecycleCoordinator } from "../src/agents/agent-lifecycle-coordinator.js";

class FakeSocket implements TerminalSocket {
  messages: string[] = []; closes: [number | undefined, string | undefined][] = [];
  message?: (data: string | Buffer) => void; closed?: () => void; errored?: () => void;
  ponged?: () => void; pingCalls = 0;
  ping() { this.pingCalls += 1; }
  send = (data: string) => this.messages.push(data);
  close = (code?: number, reason?: string) => { this.closes.push([code, reason]); this.closed?.(); };
  onMessage = (handler: (data: string | Buffer) => void) => { this.message = handler; };
  onClose = (handler: () => void) => { this.closed = handler; };
  onError = (handler: () => void) => { this.errored = handler; };
  onPong = (handler: () => void) => { this.ponged = handler; };
  receive(value: unknown) { this.message?.(JSON.stringify(value)); }
}
class FakeChannel extends EventEmitter { writes: string[] = []; windows: number[][] = []; end = vi.fn(); pause = vi.fn(); resume = vi.fn(); writeResult = true; write = (v: string) => { this.writes.push(v); return this.writeResult; }; setWindow = (...v: number[]) => this.windows.push(v); }
function setup() {
  const channel = new FakeChannel(); const client = { end: vi.fn() }; const shell = { channel, client, close: vi.fn(() => { channel.end(); client.end(); }) };
  const socket = new FakeSocket(); const sessions = { authenticateById: vi.fn(async () => ({ id: "d", expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(), ipAddress: "" })) };
  const vps = { get: vi.fn(async () => ({ id: "v", host: "h", port: 22, username: "u", kind: "remote" })) };
  const keys = { readPrivateKey: vi.fn(async () => "PRIVATE") }; const ssh = { openManagedShell: vi.fn(async () => shell) };
  const config = { enableWebTerminal: true, mode: "local", terminal: { global: 10, perDashboard: 3, perVps: 2, openTimeoutMs: 100, idleTimeoutMs: 50, lifetimeMs: 200, revocationPollMs: 25, heartbeatMs: 1000, outputBufferBytes: 1, inputBufferBytes: 1, slowConsumerTimeoutMs: 1 } } as unknown as AppConfig;
  const coordinator = new AgentLifecycleCoordinator();
  const audit = { record: vi.fn(async () => {}) }; const service = new TerminalSessionService(config, vps as any, keys as any, ssh as any, sessions as any, coordinator, audit as any);
  return { service, socket, channel, client, shell, sessions, ssh, keys, audit, config };
}
const open = { type: "open", version: 1, vpsId: "v", cols: 80, rows: 24 } as const;
// Flush the microtask queue so fire-and-forget async cleanup settles.
// Pure microtask spinning: deterministic under fake timers, no real waiting.
async function flushMicrotasks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
describe("terminal lifecycle phase 2", () => {
  it("rejects non-open and establishes ready with exact lifetime and ordered resize", async () => { /* Arrange/Act/Assert: positive ready metadata and resize; negative first-frame ordering. */ const x = setup(); await expect(x.service.open(x.socket, "d", { type: "input", data: "x" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR", retryable: false }); const now = Date.now(); await x.service.open(x.socket, "d", open); const ready = JSON.parse(x.socket.messages[0]); expect(Date.parse(ready.expiresAt) - Date.parse(ready.startedAt)).toBe((x.config as any).terminal.lifetimeMs); x.socket.receive({ type: "resize", cols: 100, rows: 30 }); x.socket.receive({ type: "resize", cols: 101, rows: 31 }); expect(x.channel.windows).toEqual([[30, 100, 0, 0], [31, 101, 0, 0]]); expect(Date.parse(ready.startedAt)).toBe(now); });
  it("expires, polls revocation, resets idle only on input/output, and enforces lifetime", async () => { const x = setup(); await x.service.open(x.socket, "d", open); vi.advanceTimersByTime(40); x.socket.receive({ type: "input", data: "x" }); vi.advanceTimersByTime(4); expect(x.shell.close).not.toHaveBeenCalled(); x.sessions.authenticateById.mockResolvedValue(undefined as any); await vi.advanceTimersByTimeAsync(21); await flushMicrotasks(); expect(x.shell.close).toHaveBeenCalled(); });
  it("closes on channel/socket races and releases registry once", async () => { const x = setup(); await x.service.open(x.socket, "d", open); x.channel.emit("error", new Error()); x.channel.emit("close"); x.socket.errored?.(); await Promise.resolve(); expect(x.service.registry.size).toBe(0); expect(x.socket.messages.filter(v => JSON.parse(v).type === "closed")).toHaveLength(1); expect(x.socket.closes).toHaveLength(1); });
  it("supports registry close operations and shutdown", async () => { const x = setup(); await x.service.open(x.socket, "d", open); await x.service.registry.closeByDashboardSession("d"); expect(x.service.registry.size).toBe(0); });
  it("rejects duplicate open with one safe protocol error and cleanup", async () => { /* Arrange */ const x = setup(); await x.service.open(x.socket, "d", open); /* Act */ x.socket.receive(open); await Promise.resolve(); /* Assert: negative ordering case. */ expect(x.socket.messages.map(value => JSON.parse(value)).filter(m => m.type === "error")).toEqual([{ type: "error", code: "PROTOCOL_ERROR", message: "Invalid terminal message.", retryable: false, closeReason: "protocol_error" }]); expect(x.service.registry.size).toBe(0); });
  it("cleans simultaneous channel/socket errors exactly once and audits metadata without secrets or content", async () => { /* Arrange */ const x = setup(); (x.config as any).terminal.outputBufferBytes = 100; (x.config as any).terminal.inputBufferBytes = 100; await x.service.open(x.socket, "d", open); x.socket.receive({ type: "input", data: "SECRET_INPUT" }); x.channel.emit("data", Buffer.from("SECRET_OUTPUT")); /* Act */ x.channel.emit("error", new Error("channel private detail")); x.socket.errored?.(); x.socket.closed?.(); await Promise.resolve(); /* Assert */ expect(x.shell.close).toHaveBeenCalledTimes(1); expect(x.socket.closes).toHaveLength(1); expect(x.audit.record).toHaveBeenCalledTimes(3); const serialized = JSON.stringify(x.audit.record.mock.calls); expect(serialized).not.toContain("PRIVATE"); expect(serialized).not.toContain("SECRET_INPUT"); expect(serialized).not.toContain("SECRET_OUTPUT"); expect(serialized).not.toContain("channel private detail"); expect((x.audit.record as any).mock.calls[2][0]).toMatchObject({ action: "terminal.closed", resourceId: expect.any(String), metadata: { dashboardId: "d", vpsId: "v", reason: "channel_error" } }); });
  it("enforces idle and absolute timeout while output resets idle", async () => { /* Arrange */ const idle = setup(); await idle.service.open(idle.socket, "d", open); /* Act/Assert negative idle */ vi.advanceTimersByTime(51); await Promise.resolve(); expect(idle.socket.closes[0]?.[1]).toBe("idle_timeout"); const life = setup(); await life.service.open(life.socket, "d", open); for (let n=0;n<4;n++) { vi.advanceTimersByTime(40); life.channel.emit("data", Buffer.from("")); } vi.advanceTimersByTime(40); await Promise.resolve(); expect(life.socket.closes[0]?.[1]).toBe("lifetime_expired"); });
  it("handles revocation poll rejection without an unhandled interval rejection", async () => { /* Arrange */ const x = setup(); await x.service.open(x.socket, "d", open); x.sessions.authenticateById.mockRejectedValueOnce(new Error("database secret")); /* Act */ await vi.advanceTimersByTimeAsync(25); /* Assert: negative dependency failure is sanitized and closed. */ expect(x.socket.closes[0]?.[1]).toBe("session_check_error"); });
  it("times out one heartbeat period after a ping receives no pong", async () => {
    const x = setup();
    (x.config as any).terminal.heartbeatMs = 30;
    (x.config as any).terminal.idleTimeoutMs = 500;
    await x.service.open(x.socket, "d", open);
    expect(x.socket.pingCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(x.socket.pingCalls).toBe(1);
    expect(x.socket.closes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30);
    await flushMicrotasks();
    expect(x.socket.closes).toHaveLength(1);
    expect(x.socket.closes[0]?.[1]).toBe("heartbeat_timeout");
    await vi.advanceTimersByTimeAsync(60);
    expect(x.socket.pingCalls).toBe(1);
    expect(x.socket.closes).toHaveLength(1);
  });
  it("accepts only a post-ping pong and schedules the next heartbeat", async () => { const x = setup(); (x.config as any).terminal.heartbeatMs = 30; (x.config as any).terminal.idleTimeoutMs = 500; await x.service.open(x.socket, "d", open); x.socket.ponged?.(); await vi.advanceTimersByTimeAsync(30); expect(x.socket.pingCalls).toBe(1); await vi.advanceTimersByTimeAsync(30); await flushMicrotasks(); expect(x.socket.closes).toHaveLength(1); expect(x.socket.closes[0]?.[1]).toBe("heartbeat_timeout"); const y = setup(); (y.config as any).terminal.heartbeatMs = 30; (y.config as any).terminal.idleTimeoutMs = 500; await y.service.open(y.socket, "d", open); await vi.advanceTimersByTimeAsync(30); expect(y.socket.pingCalls).toBe(1); y.socket.ponged?.(); await vi.advanceTimersByTimeAsync(30); expect(y.socket.pingCalls).toBe(2); await y.service.registry.closeAll("test_cleanup"); });
  it("does not treat heartbeat traffic as terminal idle activity", async () => { const x = setup(); (x.config as any).terminal.heartbeatMs = 30; (x.config as any).terminal.idleTimeoutMs = 85; await x.service.open(x.socket, "d", open); await vi.advanceTimersByTimeAsync(30); expect(x.socket.pingCalls).toBe(1); x.socket.ponged?.(); await vi.advanceTimersByTimeAsync(30); expect(x.socket.pingCalls).toBe(2); x.socket.ponged?.(); await vi.advanceTimersByTimeAsync(25); await flushMicrotasks(); expect(x.socket.closes).toHaveLength(1); expect(x.socket.closes[0]?.[1]).toBe("idle_timeout"); });
  it("closeByVps and awaited shutdown close matching resources", async () => { /* Arrange */ const x = setup(); await x.service.open(x.socket, "d", open); /* Act/Assert positive bulk lifecycle */ await x.service.registry.closeByVps("v"); expect(x.socket.closes[0]?.[1]).toBe("vps_unavailable"); const y = setup(); await y.service.open(y.socket, "d", open); await y.service.onApplicationShutdown(); expect(y.socket.closes[0]?.[1]).toBe("server_shutdown"); expect(y.service.registry.size).toBe(0); });
});
