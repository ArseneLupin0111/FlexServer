import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { APP_CONFIG } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import { terminalError } from "./terminal-error.js";

export const MSG_TYPE_DATA = 0x01;
export const MSG_TYPE_RESIZE = 0x02;
export const MSG_TYPE_EXIT = 0x03;
export const MSG_TYPE_CLOSE = 0x04;
export const MSG_TYPE_ERROR = 0x05;

export function encodeFrame(type: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = type;
  frame.writeUInt32BE(payload.length, 1);
  if (payload.length > 0) {
    payload.copy(frame, 5);
  }
  return frame;
}

export function encodeResize(rows: number, cols: number): Buffer {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt16BE(rows, 0);
  payload.writeUInt16BE(cols, 2);
  return encodeFrame(MSG_TYPE_RESIZE, payload);
}

export interface ManagedTerminalChannel {
  setWindow(rows: number, cols: number, height?: number, width?: number): boolean;
  write(data: string | Buffer): boolean;
  pause(): void;
  resume(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
}

export interface ManagedTerminalShell {
  channel: ManagedTerminalChannel;
  close(): void;
}

@Injectable()
export class LocalTerminalService {
  constructor(
    @Optional()
    @Inject(APP_CONFIG)
    private readonly config?: AppConfig,
  ) {}

  /**
   * Detects whether the current process is executing inside a container.
   */
  isDocker(): boolean {
    return (
      existsSync("/.dockerenv") ||
      process.env.CONTAINER === "docker" ||
      process.env.IS_DOCKER === "true"
    );
  }

  /**
   * Checks whether host PTY execution is supported in the current deployment.
   */
  isSupported(): boolean {
    if (this.isDocker()) {
      const socketPath =
        process.env.LOCAL_PTY_SOCKET_PATH ||
        "/var/run/vps-manager/host-pty.sock";
      return existsSync(socketPath);
    }
    try {
      const { command } = this.resolveBinary();
      return Boolean(command);
    } catch {
      return false;
    }
  }

  /**
   * Resolves the host-pty executable or go run fallback.
   */
  resolveBinary(): { command: string; args: string[]; cwd?: string } {
    if (process.env.LOCAL_PTY_COMMAND) {
      const parts = process.env.LOCAL_PTY_COMMAND.split(/\s+/);
      return { command: parts[0]!, args: parts.slice(1) };
    }
    if (process.env.LOCAL_PTY_BINARY_PATH && existsSync(process.env.LOCAL_PTY_BINARY_PATH)) {
      return { command: process.env.LOCAL_PTY_BINARY_PATH, args: [] };
    }

    // Find repo root dynamically
    let repoRoot = dirname(fileURLToPath(import.meta.url));
    while (repoRoot && repoRoot !== dirname(repoRoot)) {
      if (existsSync(resolve(repoRoot, "packages/agent"))) {
        break;
      }
      repoRoot = dirname(repoRoot);
    }

    const ext = process.platform === "win32" ? ".exe" : "";
    const candidates: string[] = [];
    if (process.platform === "win32") {
      candidates.push(
        resolve(repoRoot, `packages/agent/dist/host-pty.exe`),
        resolve(repoRoot, `packages/agent/cmd/host-pty/host-pty.exe`),
        resolve(repoRoot, `dist/host-pty.exe`),
      );
    } else {
      candidates.push(
        resolve(repoRoot, `packages/agent/dist/host-pty`),
        resolve(repoRoot, `packages/agent/dist/host-pty-linux-amd64`),
        resolve(repoRoot, `packages/agent/cmd/host-pty/host-pty`),
        resolve(repoRoot, `dist/host-pty`),
        `/app/agent/host-pty`,
        `/app/agent/host-pty-linux-amd64`,
        `/usr/local/bin/host-pty`,
        `/usr/local/bin/flexserver-host-pty`,
      );
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { command: candidate, args: [] };
      }
    }

    // Default to binary name on PATH
    return { command: `host-pty${ext}`, args: [] };
  }

  /**
   * Spawns a real host PTY session attached to an interactive shell.
   */
  async openShell(dimensions: {
    cols: number;
    rows: number;
  }): Promise<ManagedTerminalShell> {
    if (this.isDocker()) {
      return this.openDockerHostShell(dimensions);
    }

    return this.openLocalProcessShell(dimensions);
  }

  /**
   * Connects to a host PTY daemon via Unix domain socket when running in Docker.
   * Fails closed if the host socket is not mounted, preventing container shells.
   */
  private async openDockerHostShell(dimensions: {
    cols: number;
    rows: number;
  }): Promise<ManagedTerminalShell> {
    const socketPath =
      process.env.LOCAL_PTY_SOCKET_PATH ||
      "/var/run/vps-manager/host-pty.sock";

    if (!existsSync(socketPath)) {
      throw terminalError(
        "SSH_FAILURE",
        new Error(
          `Local terminal on Docker deployment requires host transport socket (${socketPath}). ` +
            "Ensure the host-pty daemon is running on the host and its socket is mounted.",
        ),
      );
    }

    const socket = createConnection(socketPath);
    const emitter = new EventEmitter();
    let closed = false;
    let readBuffer = Buffer.alloc(0);
    let earlyError: Error | null = null;
    let earlyClosed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        if (!socket.destroyed) {
          socket.write(encodeFrame(MSG_TYPE_CLOSE, Buffer.alloc(0)));
          socket.end();
          socket.destroy();
        }
      } catch {}
      if (emitter.listenerCount("close") > 0) {
        emitter.emit("close");
      } else {
        earlyClosed = true;
      }
    };

    await new Promise<void>((resolveConnect, rejectConnect) => {
      let settled = false;
      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          rejectConnect(terminalError("SSH_FAILURE", err));
        } else {
          if (emitter.listenerCount("error") > 0) {
            emitter.emit("error", err);
          } else {
            earlyError = err;
          }
          cleanup();
        }
      };

      socket.once("connect", () => {
        if (!settled) {
          settled = true;
          socket.pause();
          // Send initial terminal dimensions
          socket.write(encodeResize(dimensions.rows, dimensions.cols));
          resolveConnect();
        }
      });
      socket.on("error", onError);
    });
    socket.on("close", () => {
      cleanup();
    });

    socket.on("data", (chunk: Buffer) => {
      readBuffer = Buffer.concat([readBuffer, chunk]);

      while (readBuffer.length >= 5) {
        const msgType = readBuffer[0]!;
        const payloadLength = readBuffer.readUInt32BE(1);

        if (readBuffer.length < 5 + payloadLength) {
          break;
        }

        const payload = readBuffer.subarray(5, 5 + payloadLength);
        readBuffer = readBuffer.subarray(5 + payloadLength);

        if (msgType === MSG_TYPE_DATA) {
          emitter.emit("data", payload);
        } else if (msgType === MSG_TYPE_EXIT || msgType === MSG_TYPE_CLOSE) {
          cleanup();
          break;
        } else if (msgType === MSG_TYPE_ERROR) {
          const err = new Error(payload.toString("utf8"));
          if (emitter.listenerCount("error") > 0) {
            emitter.emit("error", err);
          } else {
            earlyError = err;
          }
          cleanup();
          break;
        }
      }
    });

    const channel: ManagedTerminalChannel = {
      write(data: string | Buffer): boolean {
        if (closed || socket.destroyed) return false;
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        return socket.write(encodeFrame(MSG_TYPE_DATA, payload));
      },

      setWindow(rows: number, cols: number): boolean {
        if (closed || socket.destroyed) return false;
        return socket.write(encodeResize(rows, cols));
      },

      pause(): void {
        socket.pause();
      },

      resume(): void {
        socket.resume();
      },

      on(event: string, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
        if (event === "data") {
          socket.resume();
        } else if (event === "error" && earlyError) {
          const err = earlyError;
          earlyError = null;
          queueMicrotask(() => listener(err));
        } else if (event === "close" && earlyClosed) {
          earlyClosed = false;
          queueMicrotask(() => listener());
        }
      },

      off(event: string, listener: (...args: any[]) => void) {
        emitter.off?.(event, listener);
      },
    };
    return {
      channel,
      close: cleanup,
    };
  }

  /**
   * Spawns host-pty directly on the host (Windows / Linux bare-metal).
   */
  private async openLocalProcessShell(dimensions: {
    cols: number;
    rows: number;
  }): Promise<ManagedTerminalShell> {
    const { command, args, cwd } = this.resolveBinary();
    const spawnArgs = [
      ...args,
      "-cols",
      String(dimensions.cols),
      "-rows",
      String(dimensions.rows),
    ];

    let child: ChildProcess;
    try {
      child = spawn(command, spawnArgs, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      throw terminalError("SSH_FAILURE", cause);
    }

    if (!child.stdin || !child.stdout) {
      try {
        child.kill();
      } catch {}
      throw terminalError("SSH_FAILURE", new Error("PTY stdio pipes unavailable"));
    }

    // Wait for successful spawn before returning the shell
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      let settled = false;
      const onEarlyError = (err: Error) => {
        if (!settled) {
          settled = true;
          rejectSpawn(terminalError("SSH_FAILURE", err));
        }
      };
      const onSpawn = () => {
        if (!settled) {
          settled = true;
          child.off("error", onEarlyError);
          resolveSpawn();
        }
      };
      child.once("spawn", onSpawn);
      child.once("error", onEarlyError);
    });

    // Start with stdout paused to prevent unbuffered output loss before consumer attaches
    child.stdout.pause();
    const emitter = new EventEmitter();
    let closed = false;
    let readBuffer = Buffer.alloc(0);
    let stderrOutput = "";
    let earlyError: Error | null = null;
    let earlyClosed = false;

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString("utf8");
      if (stderrOutput.length > 4096) {
        stderrOutput = stderrOutput.slice(-4096);
      }
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(encodeFrame(MSG_TYPE_CLOSE, Buffer.alloc(0)));
          child.stdin.end();
        }
      } catch {}

      setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill("SIGTERM");
          }
        } catch {}
      }, 300);

      if (emitter.listenerCount("close") > 0) {
        emitter.emit("close");
      } else {
        earlyClosed = true;
      }
    };

    child.on("error", (err) => {
      if (!closed) {
        const errDetail = stderrOutput.trim() ? `${err.message}: ${stderrOutput.trim()}` : err.message;
        console.error(`[LocalTerminalService] host-pty error: ${errDetail}`);
        if (emitter.listenerCount("error") > 0) {
          emitter.emit("error", err);
        } else {
          earlyError = err;
        }
        cleanup();
      }
    });
    child.on("exit", (code, signal) => {
      if (!closed && code !== 0 && code !== null) {
        const detail = stderrOutput.trim() ? ` (stderr: ${stderrOutput.trim()})` : "";
        console.error(`[LocalTerminalService] host-pty exited unexpectedly with code ${code}, signal ${signal}${detail}`);
      }
      cleanup();
    });
    // Parse incoming frames from host-pty stdout
    child.stdout.on("data", (chunk: Buffer) => {
      readBuffer = Buffer.concat([readBuffer, chunk]);

      while (readBuffer.length >= 5) {
        const msgType = readBuffer[0]!;
        const payloadLength = readBuffer.readUInt32BE(1);

        if (readBuffer.length < 5 + payloadLength) {
          break;
        }

        const payload = readBuffer.subarray(5, 5 + payloadLength);
        readBuffer = readBuffer.subarray(5 + payloadLength);

        if (msgType === MSG_TYPE_DATA) {
          emitter.emit("data", payload);
        } else if (msgType === MSG_TYPE_EXIT || msgType === MSG_TYPE_CLOSE) {
          cleanup();
          break;
        } else if (msgType === MSG_TYPE_ERROR) {
          if (emitter.listenerCount("error") > 0) {
            emitter.emit("error", new Error(payload.toString("utf8")));
          }
          cleanup();
          break;
        }
      }
    });

    child.stdin.on("drain", () => {
      emitter.emit("drain");
    });

    const channel: ManagedTerminalChannel = {
      write(data: string | Buffer): boolean {
        if (closed || !child.stdin || child.stdin.destroyed) return false;
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        return child.stdin.write(encodeFrame(MSG_TYPE_DATA, payload));
      },

      setWindow(rows: number, cols: number): boolean {
        if (closed || !child.stdin || child.stdin.destroyed) return false;
        return child.stdin.write(encodeResize(rows, cols));
      },

      pause(): void {
        child.stdout?.pause();
      },

      resume(): void {
        child.stdout?.resume();
      },

      on(event: string, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
        if (event === "data") {
          child.stdout?.resume();
        } else if (event === "error" && earlyError) {
          const err = earlyError;
          earlyError = null;
          queueMicrotask(() => listener(err));
        } else if (event === "close" && earlyClosed) {
          earlyClosed = false;
          queueMicrotask(() => listener());
        }
      },

      off(event: string, listener: (...args: any[]) => void) {
        emitter.off(event, listener);
      },
    };

    return {
      channel,
      close: cleanup,
    };
  }
}
