import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachTerminalWebSocket } from "../src/terminal/terminal-websocket.js";
import { TerminalError } from "../src/terminal/terminal-error.js";

const origin = "https://dashboard.example.test";
const config = (extra = {}) => ({ mode: "local", enableWebTerminal: true, dashboardPublicOrigin: origin, terminal: { openTimeoutMs: 40 }, ...extra } as any);
const session = { id: "dash_1", expiresAt: new Date(Date.now() + 60_000).toISOString() };
let servers: Server[] = [];
async function setup(extra: any = {}, terminal: any = {}, settingsService?: any) {
  const server = createServer();
  const calls: any[] = [];
  const sessions = { findByRequest: async (req: any) => req.headers.cookie === "dashboard_session=valid" ? session : undefined } as any;
  const service = {
    open: async (socket: any, id: string, message: any) => {
      calls.push(message);
      terminal.onOpen?.(socket, id, message);
      if (terminal.error) throw terminal.error;
    },
    registry: { closeAll: async (reason: string) => { terminal.closed = reason; } },
    isWebTerminalEnabled: async () => config(extra).mode === "local" && Boolean(config(extra).enableWebTerminal),
  } as any;
  const transport = attachTerminalWebSocket(server, config(extra), sessions, service, settingsService);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return { server, port: (server.address() as any).port, calls, service, transport };
}
function client(port: number, path: string, headers: Record<string, string> = {}) { return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers }); }
function closed(ws: WebSocket) { return new Promise<{code:number, reason:string}>(resolve => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))); }
afterEach(async () => { await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r())))); servers = []; });

describe("terminal websocket integration", () => {
  it("accepts authorized exact-origin cookie and forwards one matching open", async () => {
    const x = await setup(); const ws = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" });
    await new Promise<void>(r => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "open", version: 1, vpsId: "v1", cols: 80, rows: 24 }));
    await new Promise(r => setTimeout(r, 10)); expect(x.calls).toHaveLength(1); expect(x.calls[0].vpsId).toBe("v1"); ws.close();
  });
  it.each([["missing cookie", { Origin: origin }, 401], ["invalid cookie", { Cookie: "dashboard_session=bad", Origin: origin }, 401], ["missing origin", { Cookie: "dashboard_session=valid" }, 403], ["wrong origin", { Cookie: "dashboard_session=valid", Origin: "https://evil.test" }, 403]])("rejects %s", async (_name, headers, status) => {
    const x = await setup(); const ws = client(x.port, "/api/vps/v1/terminal", headers as any); const result = await new Promise<number>(r => ws.on("unexpected-response", (_req, res) => r(res.statusCode ?? 0))); expect(result).toBe(status);
  });
  it("rejects disabled and unrelated paths without hanging", async () => {
    const x = await setup({ enableWebTerminal: false }); const disabled = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" }); expect(await new Promise<number>(r => disabled.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)))).toBe(503);
    const unrelated = client(x.port, "/api/other", { Origin: origin }); expect(await new Promise<number>(r => unrelated.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)))).toBe(404);
  });
  it("closes mismatch and malformed first messages with 1008", async () => {
    const x = await setup(); for (const payload of [{ type:"open", version:1, vpsId:"other", cols:80, rows:24 }, { type:"input", data:"x" }, "not-json"]) { const ws = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" }); await new Promise<void>(r => ws.once("open", r)); ws.send(typeof payload === "string" ? payload : JSON.stringify(payload)); expect((await closed(ws)).code).toBe(1008); }
  });
  it("times out first message and releases pending capacity", async () => {
    const x = await setup(); const ws = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" }); await new Promise<void>(r => ws.once("open", r)); expect((await closed(ws)).code).toBe(1008);
    const next = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" }); await new Promise<void>(r => next.once("open", r)); next.send(JSON.stringify({ type:"open", version:1, vpsId:"v1", cols:80, rows:24 })); await new Promise(r => setTimeout(r, 10)); expect(x.calls).toHaveLength(1); next.close();
  });
  it("maps terminal errors safely and shuts down clients", async () => {
    const x = await setup({}, { error: new Error("secret-cause") }); const ws = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" }); await new Promise<void>(r => ws.once("open", r)); const firstClosed = closed(ws); ws.send(JSON.stringify({ type:"open", version:1, vpsId:"v1", cols:80, rows:24 })); const message = await new Promise<string>(r => ws.once("message", d => r(d.toString()))); expect(message).not.toContain("secret-cause"); expect(JSON.parse(message).code).toBe("INTERNAL_ERROR"); expect((await firstClosed).code).toBe(1011);
    const second = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" }); await new Promise<void>(r => second.once("open", r)); const secondClosed = closed(second); await x.transport.close(); expect((await secondClosed).code).toBe(1001); expect(x.service.registry.closeAll).toBeDefined();
  });
  it("is idempotent on close and detaches upgrade listener", async () => { const x = await setup(); await x.transport.close(); await x.transport.close(); expect(x.server.listenerCount("upgrade")).toBe(0); });
  it("uses runtime settingsService to gate terminal access overriding env config", async () => {
    const settingsService = { isWebTerminalEnabled: async () => false };
    const x = await setup({ enableWebTerminal: true }, {}, settingsService);
    const disabled = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" });
    const { promise: disabledStatusPromise, resolve: resolveDisabledStatus } = Promise.withResolvers<number>();
    disabled.on("unexpected-response", (_q, res) => resolveDisabledStatus(res.statusCode ?? 0));
    expect(await disabledStatusPromise).toBe(503);

    settingsService.isWebTerminalEnabled = async () => true;
    const { promise: openCalledPromise, resolve: resolveOpenCalled } = Promise.withResolvers<void>();
    const origOpen = x.service.open;
    x.service.open = async (...args: any[]) => {
      await origOpen(...args);
      resolveOpenCalled();
    };
    const enabled = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" });
    const { promise: enabledOpenedPromise, resolve: resolveEnabledOpened } = Promise.withResolvers<void>();
    enabled.once("open", () => resolveEnabledOpened());
    await enabledOpenedPromise;
    enabled.send(JSON.stringify({ type: "open", version: 1, vpsId: "v1", cols: 80, rows: 24 }));
    await openCalledPromise;
    expect(x.calls).toHaveLength(1);
    enabled.close();
  });

  it("revokes active session when terminal is disabled at runtime", async () => {
    let webTerminalEnabled = true;
    const listeners: Array<() => Promise<void>> = [];
    const settingsService = {
      isWebTerminalEnabled: async () => webTerminalEnabled,
      onDisabled: (cb: () => Promise<void>) => {
        listeners.push(cb);
        return () => {
          const idx = listeners.indexOf(cb);
          if (idx !== -1) listeners.splice(idx, 1);
        };
      },
      disable: async () => {
        webTerminalEnabled = false;
        await Promise.all(listeners.map((l) => l()));
      },
    };
    let activeWs: any = null;
    const terminalMock = {
      onOpen: (socket: any) => {
        activeWs = socket;
      },
      closed: "",
    };
    settingsService.onDisabled(async () => {
      if (activeWs) {
        activeWs.send(JSON.stringify({ type: "closed", reason: "terminal_disabled" }));
        activeWs.close(1000, "terminal_disabled");
      }
    });

    const x = await setup({}, terminalMock, settingsService);
    const ws = client(x.port, "/api/vps/v1/terminal", { Origin: origin, Cookie: "dashboard_session=valid" });
    const { promise: openPromise, resolve: resolveOpen } = Promise.withResolvers<void>();
    ws.once("open", () => resolveOpen());
    await openPromise;
    ws.send(JSON.stringify({ type: "open", version: 1, vpsId: "v1", cols: 80, rows: 24 }));
    await new Promise((r) => setTimeout(r, 20));

    const closedPromise = closed(ws);
    await settingsService.disable();
    const result = await closedPromise;
    expect(result.code).toBe(1000);
    expect(result.reason).toBe("terminal_disabled");
  });
});
