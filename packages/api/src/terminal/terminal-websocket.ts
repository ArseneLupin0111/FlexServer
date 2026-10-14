import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { isWebSocketOriginAllowed } from "../auth/origin-policy.js";
import type { DashboardSessionService } from "../auth/dashboard-session.service.js";
import type { AppConfig } from "../config/app-config.js";
import { TerminalError, terminalError } from "./terminal-error.js";
import { parseTerminalMessage } from "./terminal-protocol.js";
import type {
  TerminalSessionService,
  TerminalSocket,
} from "./terminal-session.service.js";

const PATH = /^\/api\/vps\/([^/]+)\/terminal$/;
const reject = (s: Socket, n: number) => {
  const t =
    (
      {
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        503: "Service Unavailable",
      } as any
    )[n] ?? "Bad Request";
  if (!s.destroyed)
    s.end(
      `HTTP/1.1 ${n} ${t}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
};
const safe = (e: unknown) =>
  e instanceof TerminalError ? e : terminalError("INTERNAL_ERROR");

export function adaptTerminalSocket(ws: WebSocket): TerminalSocket {
  const messageMap = new Map<Function, Function>();
  const closeMap = new Map<Function, Function>();
  const errorMap = new Map<Function, Function>();
  const pongMap = new Map<Function, Function>();
  return {
    send: (d, c) => ws.send(d, c),
    close: (c, r) => ws.close(c, r),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    ping: () => ws.ping(),
    onMessage: (h) => {
      const f = (d: WebSocket.RawData) =>
        h(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
      messageMap.set(h, f);
      ws.on("message", f);
    },
    onClose: (h) => {
      const f = () => h();
      closeMap.set(h, f);
      ws.on("close", f);
    },
    onError: (h) => {
      const f = () => h();
      errorMap.set(h, f);
      ws.on("error", f);
    },
    offMessage: (h) => {
      const f = messageMap.get(h);
      if (f) ws.off("message", f as never);
      messageMap.delete(h);
    },
    offClose: (h) => {
      const f = closeMap.get(h);
      if (f) ws.off("close", f as never);
      closeMap.delete(h);
    },
    offError: (h) => {
      const f = errorMap.get(h);
      if (f) ws.off("error", f as never);
      errorMap.delete(h);
    },
    onPong: (h) => {
      const f = () => h();
      pongMap.set(h, f);
      ws.on("pong", f);
    },
    offPong: (h) => {
      const f = pongMap.get(h);
      if (f) ws.off("pong", f as never);
      pongMap.delete(h);
    },
  };
}

/** Sole application upgrade router for /api/vps/:vpsId/terminal. */
export function attachTerminalWebSocket(
  server: HttpServer,
  config: AppConfig,
  sessions: DashboardSessionService,
  terminal: TerminalSessionService,
  settings?: { isWebTerminalEnabled(): Promise<boolean> },
) {
  const existing = (server as any).__terminalTransport;
  if (existing) return existing;
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
  });
  let pending = 0,
    stopped = false;
  const pendingSockets = new Set<Socket>();
  const limit = config.terminal?.pendingLimit ?? 10;
  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      let reserved = false;
      const release = () => {
        if (reserved) {
          reserved = false;
          pending--;
        }
      };
      try {
        const url = new URL(req.url ?? "/", "http://localhost"),
          match = url.pathname.match(PATH);
        if (!match) return reject(socket, 404);
        const isEnabled = settings
          ? await settings.isWebTerminalEnabled()
          : typeof terminal?.isWebTerminalEnabled === "function"
            ? await terminal.isWebTerminalEnabled()
            : config.mode === "local" && Boolean(config.enableWebTerminal);
        if (!isEnabled) return reject(socket, 503);
        const origin =
          typeof req.headers.origin === "string"
            ? req.headers.origin
            : undefined;
        if (
          !isWebSocketOriginAllowed({
            origin,
            configuredOrigin: config.dashboardPublicOrigin,
          })
        )
          return reject(socket, 403);
        if (stopped || pending >= limit) return reject(socket, 503);
        pending++;
        reserved = true;
        pendingSockets.add(socket);
        const session = await sessions.findByRequest({
          headers: req.headers,
        } as never);
        pendingSockets.delete(socket);
        if (!session) {
          release();
          return reject(socket, 401);
        }
        if (stopped) {
          release();
          return reject(socket, 503);
        }
        await new Promise<void>((resolve, rejectUpgrade) => {
          try {
            wss.handleUpgrade(req, socket, head, (ws) => {
              resolve();
              let claimed = false,
                finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                ws.off("message", first);
                ws.off("close", onClose);
                ws.off("error", onError);
                release();
              };
              const onClose = () => finish(),
                onError = () => finish();
              const timer = setTimeout(() => {
                if (!claimed) {
                  finish();
                  ws.close(1008, "open_timeout");
                }
              }, config.terminal?.openTimeoutMs ?? 10000);
              const first = (raw: WebSocket.RawData) => {
                if (claimed) return;
                try {
                  const m = parseTerminalMessage(
                    Buffer.isBuffer(raw)
                      ? raw
                      : Buffer.from(raw as ArrayBuffer),
                  );
                  if (m.type !== "open" || m.vpsId !== match[1])
                    throw new Error();
                  claimed = true;
                  finish();
                  void terminal
                    .open(adaptTerminalSocket(ws), session.id, m)
                    .catch((e) => {
                      const x = safe(e);
                      try {
                        ws.send(
                          JSON.stringify({
                            type: "error",
                            code: x.code,
                            message: x.message,
                            retryable: x.retryable,
                            closeReason: x.closeReason,
                          }),
                        );
                      } finally {
                        ws.close(1011, x.closeReason);
                      }
                    });
                } catch {
                  finish();
                  ws.close(1008, "protocol_error");
                }
              };
              ws.on("message", first);
              ws.once("close", onClose);
              ws.once("error", onError);
            });
          } catch (e) {
            rejectUpgrade(e);
          }
        });
      } catch {
        pendingSockets.delete(socket);
        release();
        if (!socket.destroyed) reject(socket, 503);
      }
    })();
  };
  server.on("upgrade", onUpgrade);
  const transport = {
    wss,
    close: async () => {
      if (stopped) return;
      stopped = true;
      server.off("upgrade", onUpgrade);
      for (const s of pendingSockets) s.destroy();
      pendingSockets.clear();
      await terminal.registry.closeAll("server_shutdown");
      for (const c of wss.clients) {
        try {
          c.close(1001, "server_shutdown");
        } catch {}
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          for (const c of wss.clients) c.terminate();
          done();
        }, 250);
        timer.unref();
        wss.close(done);
      });
      if ((server as any).__terminalTransport === transport)
        delete (server as any).__terminalTransport;
    },
  };
  (server as any).__terminalTransport = transport;
  return transport;
}
