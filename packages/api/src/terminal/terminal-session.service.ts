import { StringDecoder } from "node:string_decoder";
import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import { APP_CONFIG, KEY_SERVICE, VPS_REPOSITORY } from "../tokens.js";
import { AuditService } from "../audit/audit.service.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { KeyService } from "../ssh/keyService.js";
import { SshService } from "../ssh/ssh.service.js";
import type { ManagedSshShell } from "../ssh/sshService.js";
import { DashboardSessionService } from "../auth/dashboard-session.service.js";
import type { ManagedTerminalShell } from "./local-terminal.service.js";
import { LocalTerminalService } from "./local-terminal.service.js";
import { DashboardSettingsService } from "../dashboard/dashboard-settings.service.js";
import {
  type TerminalRegistration,
  TerminalSessionRegistry,
} from "./terminal-registry.js";
import {
  encodeTerminalMessage,
  parseTerminalMessage,
  type TerminalClientMessage,
} from "./terminal-protocol.js";
import { TerminalError, terminalError } from "./terminal-error.js";
import { AgentLifecycleCoordinator } from "../agents/agent-lifecycle-coordinator.js";

export interface TerminalSocket {
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | Buffer) => void): void;
  onClose(handler: () => void): void;
  onError?(handler: () => void): void;
  offMessage?(handler: (data: string | Buffer) => void): void;
  offClose?(handler: () => void): void;
  offError?(handler: () => void): void;
  bufferedAmount?: number;
  ping?(): void;
  onPong?(handler: () => void): void;
  offPong?(handler: () => void): void;
}

type State = "opening" | "ready" | "closing" | "closed";
const auditActions = new Set([
  "requested",
  "opened",
  "closed",
  "failed",
  "blocked",
  "revoked",
  "limit_exceeded",
]);

@Injectable()
export class TerminalSessionService implements OnApplicationShutdown {
  readonly registry: TerminalSessionRegistry;
  private websocketCloser?: () => Promise<void>;
  setWebSocketCloser(closer: () => Promise<void>) {
    this.websocketCloser = closer;
  }
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(KEY_SERVICE) private readonly keys: KeyService,
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(DashboardSessionService)
    private readonly sessions: DashboardSessionService,
    @Inject(AgentLifecycleCoordinator)
    private readonly coordinator: AgentLifecycleCoordinator,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
    @Optional()
    @Inject(DashboardSettingsService)
    private readonly settings?: DashboardSettingsService,
    @Optional()
    @Inject(LocalTerminalService)
    private readonly localTerminal?: LocalTerminalService,
  ) {
    this.registry = new TerminalSessionRegistry(
      config.terminal ?? { global: 10, perDashboard: 3, perVps: 2 },
    );
    if (this.settings && typeof this.settings.onDisabled === "function") {
      this.settings.onDisabled(async () => {
        await this.registry.closeAll("terminal_disabled");
      });
    }
  }

  async closeAll(reason = "server_shutdown"): Promise<void> {
    await this.registry.closeAll(reason);
  }

  async closeByVps(vpsId: string): Promise<void> {
    await this.registry.closeByVps(vpsId);
  }

  async isWebTerminalEnabled(): Promise<boolean> {
    if (this.config.mode !== "local") {
      return false;
    }
    if (this.settings) {
      return this.settings.isWebTerminalEnabled();
    }
    return Boolean(this.config.enableWebTerminal);
  }

  async open(
    socket: TerminalSocket,
    dashboardId: string,
    first: TerminalClientMessage,
  ): Promise<void> {
    const cfg = this.config.terminal!;
    if (first.type !== "open") throw terminalError("PROTOCOL_ERROR");
    let state: State = "opening";
    let shell: ManagedSshShell | ManagedTerminalShell | undefined;
    let registration: TerminalRegistration | undefined;
    let releaseActivity: (() => void) | undefined;
    let shellDisposed = false;
    let outcomeDone = false;
    let onPong: (() => void) | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => void cleanup("idle_timeout"),
        cfg.idleTimeoutMs,
      );
    };
    let inputQueue: string[] = [];
    let inputBytes = 0;
    let inputBlocked = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const drainInput = () => {
      inputBlocked = false;
      while (inputQueue.length && state === "ready") {
        const value = inputQueue.shift()!;
        inputBytes -= Buffer.byteLength(value);
        if (!shell?.channel.write(value)) {
          inputBlocked = true;
          break;
        }
      }
    };
    let channelCleanup: (() => void) | undefined;
    const audit = async (
      action: string,
      reason: string,
      vpsId = first.vpsId,
    ) => {
      if (
        (action === "closed" || action === "failed" || action === "revoked") &&
        outcomeDone
      )
        return;
      if (!auditActions.has(action)) return;
      if (action === "closed" || action === "failed" || action === "revoked")
        outcomeDone = true;
      try {
        await this.audit?.record({
          actor: dashboardId,
          action: `terminal.${action}`,
          resourceType: "terminal",
          resourceId: registration?.id ?? vpsId,
          result:
            action === "opened" || action === "closed" ? "success" : "failure",
          metadata: { dashboardId, vpsId, sessionId: registration?.id, reason },
        });
      } catch {}
    };
    const disposeShell = () => {
      if (shellDisposed) return;
      if (!shell) return;
      shellDisposed = true;
      try {
        shell.close();
      } catch {}
    };
    const cleanup = async (reason = "closed") => {
      if (state === "closed" || state === "closing") return;
      const wasReady = state === "ready";
      state = "closing";
      timers.forEach(clearTimeout);
      intervals.forEach(clearInterval);
      channelCleanup?.();
      disposeShell();
      if (registration) this.registry.release(registration.id);
      try {
        releaseActivity?.();
      } catch {}
      try {
        if (wasReady)
          socket.send(encodeTerminalMessage({ type: "closed", reason }));
      } catch {}
      try {
        socket.close(1000, reason);
      } catch {}
      socket.offMessage?.(onSocketMessage);
      socket.offClose?.(onSocketClose);
      socket.offError?.(onSocketError);
      if (onPong) socket.offPong?.(onPong);
      state = "closed";
      await audit(
        reason === "session_expired" || reason === "terminal_disabled"
          ? "revoked"
          : "closed",
        reason,
      );
    };
    const onSocketClose = () => {
      void cleanup("socket_closed");
    };
    const onSocketError = () => {
      void cleanup("socket_error");
    };
    const onSocketMessage = (raw: string | Buffer) => {
      if (state === "closed" || state === "closing") return;
      try {
        const msg = parseTerminalMessage(raw);
        if (state !== "ready") throw terminalError("PROTOCOL_ERROR");
        if (msg.type === "open") throw terminalError("PROTOCOL_ERROR");
        if (msg.type === "disconnect") void cleanup("client_disconnect");
        else if (msg.type === "resize")
          shell?.channel.setWindow(msg.rows, msg.cols, 0, 0);
        else {
          resetIdle();
          inputQueue.push(msg.data);
          inputBytes += Buffer.byteLength(msg.data);
          if (inputBytes > cfg.inputBufferBytes) {
            void cleanup("input_overflow");
            return;
          }
          if (!inputBlocked) drainInput();
        }
      } catch {
        try {
          socket.send(
            encodeTerminalMessage({
              type: "error",
              code: "PROTOCOL_ERROR",
              message: "Invalid terminal message.",
              retryable: false,
              closeReason: "protocol_error",
            }),
          );
        } catch {}
        void cleanup("protocol_error");
      }
    };
    socket.onClose(onSocketClose);
    socket.onError?.(onSocketError);
    socket.onMessage(onSocketMessage);
    await audit("requested", "requested");
    if (!(await this.isWebTerminalEnabled())) {
      await audit("blocked", "disabled");
      throw terminalError("TERMINAL_DISABLED");
    }
    let session;
    try {
      session = await this.sessions.authenticateById(dashboardId);
    } catch {
      await audit("failed", "session_lookup");
      throw terminalError("INTERNAL_ERROR");
    }
    const expiry = session?.expiresAt ? Date.parse(session.expiresAt) : NaN;
    if (!session || !Number.isFinite(expiry) || expiry <= Date.now()) {
      await audit("blocked", "session_expired");
      throw terminalError("SESSION_EXPIRED");
    }
    releaseActivity = this.coordinator.tryAcquireActivity(
      first.vpsId,
      "terminal",
    );
    try {
      registration = this.registry.admit(dashboardId, first.vpsId, (reason) =>
        cleanup(reason),
      );
    } catch {
      try {
        releaseActivity?.();
      } catch {}
      await audit("limit_exceeded", "limit");
      throw terminalError("LIMIT_EXCEEDED");
    }
    const openTimer = setTimeout(
      () => {
        void cleanup("open_timeout");
      },
      Math.min(cfg.openTimeoutMs, Math.max(1, expiry - Date.now())),
    );
    timers.add(openTimer);
    try {
      const target = await this.vps.get(first.vpsId);
      if (!target) throw terminalError("VPS_NOT_FOUND");
      if (target.kind === "local" || target.managedBy === "system") {
        if (state !== "opening") return;
        const localService =
          this.localTerminal ?? new LocalTerminalService(this.config);
        shell = await localService.openShell({
          cols: first.cols,
          rows: first.rows,
        });
      } else {
        let key: string;
        try {
          key = await this.keys.readPrivateKey(target.id);
        } catch {
          await audit("failed", "key_unavailable");
          throw terminalError("KEY_UNAVAILABLE");
        }
        if (state !== "opening") return;
        const pending = this.ssh.openManagedShell(
          target,
          { privateKey: key },
          { cols: first.cols, rows: first.rows },
        );
        shell = await pending;
      }
      if (state !== "opening") {
        try {
          shell.close();
        } catch {}
        return;
      }
      clearTimeout(openTimer);
      state = "ready";
      const started = Date.now();
      resetIdle();
      const expiresAt = Math.min(expiry, started + cfg.lifetimeMs);
      socket.send(
        encodeTerminalMessage({
          type: "ready",
          terminalSessionId: registration.id,
          startedAt: new Date(started).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
        }),
      );
      let awaitingPong = false;
      onPong = () => {
        if (state === "ready" && awaitingPong) awaitingPong = false;
      };
      socket.onPong?.(onPong);
      const heartbeatTimer = setInterval(() => {
        if (state !== "ready") return;
        if (awaitingPong) {
          void cleanup("heartbeat_timeout");
          return;
        }
        awaitingPong = true;
        try {
          if (typeof socket.ping === "function") socket.ping();
        } catch {
          void cleanup("socket_error");
        }
      }, cfg.heartbeatMs);
      intervals.add(heartbeatTimer);
      await audit("opened", "ready");
      timers.add(
        setTimeout(
          () => {
            void cleanup("lifetime_expired");
          },
          Math.max(1, expiresAt - Date.now()),
        ),
      );
      const revokeTimer = setInterval(() => {
        if (state === "ready") {
          void this.isWebTerminalEnabled()
            .then((enabled) => {
              if (!enabled) return cleanup("terminal_disabled");
              return this.sessions
                .authenticateById(dashboardId)
                .then((active) => {
                  if (!active) return cleanup("session_expired");
                });
            })
            .catch(() => cleanup("session_check_error"));
        }
      }, cfg.revocationPollMs);
      intervals.add(revokeTimer);
      const onClose = () => {
        if (channelClosing || state !== "ready") return;
        channelClosing = true;
        const tail = decoder.end();
        if (tail) {
          const encoded = Buffer.from(tail, "utf8");
          if (outputBytes + encoded.length <= high) {
            outputQueue.push(encoded);
            outputBytes += encoded.length;
          }
        }
        try {
          shell?.channel.pause();
        } catch {}
        flush();
        const finish = () => {
          if (closeDrainTimer) {
            clearTimeout(closeDrainTimer);
            closeDrainTimer = undefined;
          }
          void cleanup("channel_closed");
        };
        finishChannelCloseIfDrained();
        if (channelClosing && state === "ready")
          closeDrainTimer = setTimeout(
            () => {
              if (channelClosing && state === "ready") finish();
            },
            Math.max(1, Math.min(cfg.slowConsumerTimeoutMs, 250)),
          );
      };
      const onError = () => void cleanup("channel_error");
      const drainInput = () => {
        inputBlocked = false;
        while (inputQueue.length && state === "ready") {
          const value = inputQueue.shift()!;
          inputBytes -= Buffer.byteLength(value);
          if (!shell?.channel.write(value)) {
            inputBlocked = true;
            break;
          }
        }
      };
      const onDrain = () => drainInput();
      let outputQueue: Buffer[] = [];
      let outputBytes = 0;
      let outputPaused = false;
      let channelClosing = false;
      let pendingSends = 0;
      let closeDrainTimer: ReturnType<typeof setTimeout> | undefined;
      let flushing = false;
      let flushRequested = false;
      const decoder = new StringDecoder("utf8");
      const high = Math.max(1, cfg.outputBufferBytes);
      const low = Math.floor(high / 2);
      let slow: ReturnType<typeof setTimeout> | undefined;
      const clearSlow = () => {
        if (slow) {
          clearTimeout(slow);
          slow = undefined;
        }
      };
      const armSlow = () => {
        if (!slow)
          slow = setTimeout(
            () => void cleanup("slow_consumer"),
            cfg.slowConsumerTimeoutMs,
          );
      };
      const finishChannelCloseIfDrained = () => {
        if (
          !channelClosing ||
          state !== "ready" ||
          pendingSends !== 0 ||
          outputQueue.length !== 0
        )
          return;
        if (closeDrainTimer) {
          clearTimeout(closeDrainTimer);
          closeDrainTimer = undefined;
        }
        void cleanup("channel_closed");
      };
      const resumeIfDrained = () => {
        if (state !== "ready" || channelClosing) return;
        if (!outputQueue.length && (socket.bufferedAmount ?? 0) <= low) {
          const wasPaused = outputPaused;
          outputPaused = false;
          clearSlow();
          if (wasPaused) {
            try {
              shell?.channel.resume();
            } catch {}
          }
        }
      };
      const flush = () => {
        if (flushing) {
          flushRequested = true;
          return;
        }
        flushing = true;
        try {
          do {
            flushRequested = false;
            if (state !== "ready") return;
            while (
              state === "ready" &&
              outputQueue.length &&
              (socket.bufferedAmount ?? 0) <= low
            ) {
              const chunk = outputQueue.shift()!;
              outputBytes -= chunk.length;
              pendingSends++;
              try {
                socket.send(
                  encodeTerminalMessage({
                    type: "output",
                    data: chunk.toString("utf8"),
                  }),
                  (error) => {
                    pendingSends--;
                    if (state !== "ready" && !channelClosing) return;
                    if (error) void cleanup("socket_error");
                    else {
                      clearSlow();
                      if (state === "ready") {
                        flushRequested = true;
                        queueMicrotask(flush);
                        resumeIfDrained();
                      }
                      finishChannelCloseIfDrained();
                    }
                  },
                );
              } catch {
                void cleanup("socket_error");
                return;
              }
            }
            if (outputQueue.length) {
              if (!outputPaused) {
                outputPaused = true;
                try {
                  shell?.channel.pause();
                } catch {}
              }
              armSlow();
            } else {
              resumeIfDrained();
              finishChannelCloseIfDrained();
            }
          } while (flushRequested && state === "ready");
        } finally {
          flushing = false;
        }
      };
      const onData = (data: Buffer) => {
        resetIdle();
        const text = decoder.write(data);
        const encoded = Buffer.from(text, "utf8");
        if (outputBytes + encoded.length > high) {
          outputPaused = true;
          try {
            shell?.channel.pause();
          } catch {}
          if (!slow)
            slow = setTimeout(
              () => void cleanup("slow_consumer"),
              cfg.slowConsumerTimeoutMs,
            );
          return;
        }
        if (encoded.length) {
          outputQueue.push(encoded);
          outputBytes += encoded.length;
          flush();
        }
      };
      shell.channel.on("data", onData);
      shell.channel.on("close", onClose);
      shell.channel.on("error", onError);
      shell.channel.on("drain", onDrain);
      const poll = setInterval(
        () => {
          if (outputPaused && (socket.bufferedAmount ?? 0) <= low) {
            flush();
            resumeIfDrained();
          }
        },
        Math.max(
          1,
          Math.min(
            cfg.heartbeatMs,
            Math.max(1, Math.floor(cfg.slowConsumerTimeoutMs / 2)),
          ),
        ),
      );
      intervals.add(poll);
      channelCleanup = () => {
        if (closeDrainTimer) clearTimeout(closeDrainTimer);
        if (slow) clearTimeout(slow);
        shell?.channel.on("error", () => {});
        shell?.channel.off?.("data", onData);
        shell?.channel.off?.("close", onClose);
        shell?.channel.off?.("error", onError);
        shell?.channel.off?.("drain", onDrain);
      };
    } catch (cause) {
      timers.forEach(clearTimeout);
      intervals.forEach(clearInterval);
      disposeShell();
      if (registration) this.registry.release(registration.id);
      try {
        releaseActivity?.();
      } catch {}
      state = "closed";
      if (cause instanceof TerminalError) {
        await audit("failed", cause.code);
        throw cause;
      }
      await audit("failed", "ssh");
      throw terminalError("SSH_FAILURE", cause);
    }
  }
  async onApplicationShutdown() {
    if (this.websocketCloser) await this.websocketCloser();
    else await this.registry.closeAll("server_shutdown");
  }
}
