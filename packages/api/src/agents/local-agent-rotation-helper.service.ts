import { spawn } from "node:child_process";
import { Injectable } from "@nestjs/common";
import { sanitiseError } from "../jobs/job-runner.service.js";

/**
 * Invokes the host-side privileged helper through argv-only spawn.
 * The helper path is configured by LOCAL_AGENT_ROTATION_HELPER and receives
 * the credential over stdin; it must atomically update the host config and
 * restart the systemd agent. Missing configuration fails closed.
 */
@Injectable()
export class LocalAgentRotationHelper {
  async applyCredential(vpsId: string, token: string): Promise<void> {
    const command = process.env.LOCAL_AGENT_ROTATION_HELPER?.trim();
    if (!command) {
      throw new Error("Local agent rotation helper is not configured");
    }

    const isNodeScript = command.endsWith(".js") || command.endsWith(".mjs");
    const execCmd = isNodeScript ? process.execPath : command;
    const args = isNodeScript ? [command] : [];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(execCmd, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      let settled = false;

      const timeoutMs =
        Number(process.env.LOCAL_AGENT_ROTATION_TIMEOUT_MS) || 30_000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              if (!child.killed) child.kill("SIGKILL");
            } catch {}
          }, 2000).unref?.();
        } catch {}
        reject(new Error(`Rotation helper timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-512);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Rotation helper failed to start: ${sanitiseError(error.message)}`));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) return resolve();
        const errDetail = stderr.trim() ? `: ${sanitiseError(stderr.trim())}` : "";
        reject(new Error(`Rotation helper exited with code ${code ?? "unknown"}${errDetail}`));
      });
      child.stdin.end(JSON.stringify({ vpsId, token }) + "\n");
    });
  }
}
