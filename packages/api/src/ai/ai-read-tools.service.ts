import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import { z } from "zod";
import {
  APP_CONFIG,
  DOCKER_MONITORING_REPOSITORY,
} from "../tokens.js";
import type { DockerMonitoringRepository } from "../persistence/repositories/docker-monitoring.repository.js";
import type { AppConfig } from "../config/app-config.js";
import {
  DockerLogsPolicyError,
  DockerLogsService,
  type DockerLogStreamQuery,
  type DockerLogsSessionContext,
} from "../docker/docker-logs.service.js";
import { AiPolicyService, AiPolicyError } from "./ai-policy.service.js";
import { AiAgentService } from "./ai-agent.service.js";
import { redactString, redactValue } from "../common/redaction.js";
import { AiAssistantError } from "./ai-failures.js";
import type { AiExecutionReceipt, AiPolicy, AiTask } from "./ai.models.js";
import type { ProviderTool } from "./ai-provider.js";

/** Max characters for file/tool preview placed in model context (plan §9.3 64 KiB cap). */
const MAX_CONTEXT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_LOG_TIMEOUT_MS = 5000;
const MAX_LOG_TIMEOUT_MS = 10000;

export const readTools: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "container_inspect",
      description:
        "Inspect safe bounded metadata of a container (ports, restart policy, health check, mounts, state). No raw environment variables or daemon secrets.",
      parameters: {
        type: "object",
        properties: {
          containerKey: {
            type: "string",
            description: "Container key or container name",
          },
        },
        required: ["containerKey"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "container_logs",
      description:
        "Read recent bounded logs for a Docker container. Requires policy log egress grant (sendLogsToProvider). Secret-redacted, bounded evidence may be retained in conversation history.",
      parameters: {
        type: "object",
        properties: {
          containerKey: {
            type: "string",
            description: "Container key or container name",
          },
          tailLines: {
            type: "integer",
            description: "Number of recent lines to tail (1-200, default 100)",
          },
          timeoutMs: {
            type: "integer",
            description:
              "Maximum milliseconds to wait for initial logs (max 10000, default 5000)",
          },
        },
        required: ["containerKey"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Auto-authorized scoped read of a text file on the host within allowed policy scopes. Requires sendFilesToProvider egress grant.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file on host",
          },
          scope: {
            type: "string",
            description: "Approved scope path containing the target",
          },
          maxBytes: {
            type: "integer",
            description: "Maximum bytes to read (max 262144, default 65536)",
          },
        },
        required: ["path", "scope"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "service_status",
      description:
        "Auto-authorized status query for a system service within registered service profile IDs.",
      parameters: {
        type: "object",
        properties: {
          profileId: {
            type: "string",
            description: "Registered service profile ID",
          },
          service: {
            type: "string",
            description: "Service unit name",
          },
        },
        required: ["profileId", "service"],
        additionalProperties: false,
      },
    },
  },
];

const READ_TOOL_NAMES: Record<string, true> = {
  container_inspect: true,
  docker_inspect: true,
  container_logs: true,
  docker_logs: true,
  file_read: true,
  host_file_read: true,
  files_read: true,
  service_status: true,
  host_service_status: true,
  services_inspect: true,
};

export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES[name] === true;
}

const containerInspectSchema = z
  .object({
    containerKey: z.string().min(1).max(256),
  })
  .strict();

const containerLogsSchema = z
  .object({
    containerKey: z.string().min(1).max(256),
    tailLines: z.number().int().min(1).max(200).optional().default(100),
    timeoutMs: z
      .number()
      .int()
      .min(500)
      .max(MAX_LOG_TIMEOUT_MS)
      .optional()
      .default(DEFAULT_LOG_TIMEOUT_MS),
  })
  .strict();

const pathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (val) =>
      val.startsWith("/") &&
      !val.split("/").includes("..") &&
      !val.includes("\0"),
    { message: "Path must be absolute, non-empty, without .. or null bytes" },
  );

const fileReadSchema = z
  .object({
    path: pathSchema,
    scope: pathSchema,
    maxBytes: z.number().int().min(1).max(262144).optional().default(65536),
  })
  .strict();

const profileIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);

const serviceStatusSchema = z
  .object({
    profileId: profileIdSchema,
    service: z.string().min(1).max(128),
  })
  .strict();

function isWithinScope(target: string, scope: string): boolean {
  const normScope = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  return target === normScope || target.startsWith(`${normScope}/`);
}

/**
 * Synthetic Express Response stream adapter to consume DockerLogsService SSE events
 * in-memory with strict bounds and zero socket leaks.
 */
class SyntheticLogsResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  statusCode = 200;
  headers: Record<string, unknown> = {};
  readonly lines: string[] = [];
  closed = false;
  closeReason?: string;
  closeStatus?: string;
  private lineBuffer = "";

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) this.headers = { ...this.headers, ...headers };
    return this;
  }

  flushHeaders(): void {}
  flush(): void {}

  write(chunk: unknown): boolean {
    if (this.destroyed || this.writableEnded) return false;
    const str =
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
    this.lineBuffer += str;
    this.parseBuffer();
    return true;
  }

  end(chunk?: unknown): this {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.destroyed = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  private parseBuffer(): void {
    let splitIdx: number;
    while ((splitIdx = this.lineBuffer.indexOf("\n\n")) !== -1) {
      const block = this.lineBuffer.slice(0, splitIdx);
      this.lineBuffer = this.lineBuffer.slice(splitIdx + 2);
      this.processBlock(block);
    }
  }

  private processBlock(block: string): void {
    const lines = block.split("\n");
    let eventName = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6).trim();
      }
    }
    if (eventName === "lines" && dataStr) {
      try {
        const parsed = JSON.parse(dataStr);
        if (Array.isArray(parsed.lines)) {
          for (const l of parsed.lines) {
            if (typeof l === "string") {
              this.lines.push(redactString(l));
            }
          }
        }
      } catch {
        // ignore malformed frame
      }
    } else if (eventName === "closed" && dataStr) {
      this.closed = true;
      try {
        const parsed = JSON.parse(dataStr);
        this.closeStatus = parsed.status;
        this.closeReason = parsed.reason;
      } catch {
        this.closeStatus = "closed";
      }
    }
  }
}

@Injectable()
export class AiReadToolsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DOCKER_MONITORING_REPOSITORY)
    private readonly monitoring: DockerMonitoringRepository,
    @Inject(DockerLogsService)
    private readonly dockerLogsService: DockerLogsService,
    @Inject(AiPolicyService)
    private readonly policyService: AiPolicyService,
    @Inject(AiAgentService)
    private readonly aiAgentService: AiAgentService,
  ) {}

  isReadTool(name: string): boolean {
    return isReadTool(name);
  }

  getTools(): ProviderTool[] {
    return readTools;
  }

  /**
   * Universal tool execution dispatcher for read operations.
   * Auto-authorizes read policy, enforces strict egress guards,
   * performs bounded queries and redacts sensitive data before returning stringified context.
   */
  async execute(
    call: { id?: string; name: string; arguments: string },
    context: { task: AiTask; policy: AiPolicy; signal?: AbortSignal },
  ): Promise<string> {
    const { task, policy, signal } = context;
    const name = call.name;
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      throw new AiAssistantError("policy_denied", "Malformed tool arguments JSON");
    }
    try {
      if (name === "container_inspect" || name === "docker_inspect") {
        const parsed = containerInspectSchema.safeParse(args);
        if (!parsed.success) {
          throw new AiAssistantError("policy_denied", "Invalid container_inspect arguments");
        }
        return await this.inspectContainer(task.vpsId, policy, parsed.data.containerKey);
      }

      if (name === "container_logs" || name === "docker_logs") {
        const parsed = containerLogsSchema.safeParse(args);
        if (!parsed.success) {
          throw new AiAssistantError("policy_denied", "Invalid container_logs arguments");
        }
        return await this.readContainerLogs(
          task,
          policy,
          parsed.data.containerKey,
          parsed.data.tailLines,
          parsed.data.timeoutMs,
          signal,
        );
      }

      if (name === "file_read" || name === "host_file_read" || name === "files_read") {
        const parsed = fileReadSchema.safeParse(args);
        if (!parsed.success) {
          throw new AiAssistantError("policy_denied", "Invalid file_read arguments");
        }
        return await this.readFile(
          task,
          policy,
          parsed.data.path,
          parsed.data.scope,
          parsed.data.maxBytes,
          signal,
        );
      }

      if (
        name === "service_status" ||
        name === "host_service_status" ||
        name === "services_inspect"
      ) {
        const parsed = serviceStatusSchema.safeParse(args);
        if (!parsed.success) {
          throw new AiAssistantError("policy_denied", "Invalid service_status arguments");
        }
        return await this.getServiceStatus(
          task,
          policy,
          parsed.data.profileId,
          parsed.data.service,
          signal,
        );
      }

      throw new AiAssistantError("policy_denied", `Unknown read tool: ${name}`);
    } catch (err) {
      if (err instanceof AiPolicyError) {
        throw new AiAssistantError("policy_denied", err.message);
      }
      throw err;
    }
  }
  /**
   * Container inspect safe projection:
   * Returns ports, restart count/policy, health check, mounts, networks, metrics, and lifecycle.
   * Strips raw environment variables, raw labels, daemon secrets, and direct host handles.
   */
  async inspectContainer(
    vpsId: string,
    policy: AiPolicy,
    containerKey: string,
  ): Promise<string> {
    this.policyService.authorizeToolCall(policy, "readEnabled");

    const containers = await this.monitoring.listCurrentContainers(vpsId);
    const target = containers.find(
      (c) =>
        c.containerKey === containerKey ||
        c.name === containerKey ||
        c.containerKey.startsWith(containerKey),
    );

    if (!target) {
      return JSON.stringify({
        found: false,
        containerKey,
        error: "container_not_found",
        observedAt: new Date().toISOString(),
      });
    }

    const details = target.details?.status === "available" ? target.details : null;

    const projection = {
      found: true,
      containerKey: target.containerKey,
      agentInstanceId: target.agentInstanceId,
      name: target.name ?? null,
      image: target.image ?? null,
      state: target.state ?? null,
      status: target.status ?? null,
      collectedAt: target.collectedAt,
      metrics: {
        cpuPercent: target.metrics.cpuPercent,
        memoryUsageBytes: target.metrics.memoryUsageBytes,
        pids: target.metrics.pids,
      },
      ports: details?.ports ?? [],
      restarts:
        details && details.restartPolicy
          ? {
              restartCount: details.restartCount ?? 0,
              policyName: details.restartPolicy.name,
              maximumRetryCount: details.restartPolicy.maximumRetryCount,
            }
          : null,
      healthcheck: details
        ? {
            status: details.healthcheck.status,
            failingStreak: details.healthcheck.failingStreak,
            intervalMs: details.healthcheck.intervalMs,
            timeoutMs: details.healthcheck.timeoutMs,
          }
        : null,
      mounts: details
        ? details.mounts.map((m) => ({
            type: m.type,
            destination: m.destination,
            readOnly: m.readOnly,
          }))
        : [],
      networks: details
        ? details.networks.map((n) => ({
            name: n.name,
            ipv4: n.ipv4,
          }))
        : [],
      exitCode: details?.exitCode ?? null,
      oomKilled: details?.oomKilled ?? null,
      startedAt: details?.startedAt ?? null,
      finishedAt: details?.finishedAt ?? null,
      observedAt: new Date().toISOString(),
    };

    return JSON.stringify(redactValue(projection));
  }

  /**
   * Bounded Docker logs read using existing DockerLogsService subscription engine.
   * Enforces assertEgressAllowed("logs") before transmission.
   * Strictly caps lines, bytes, and timeout. No fake fallback.
   */
  async readContainerLogs(
    task: AiTask,
    policy: AiPolicy,
    containerKey: string,
    tailLines = 100,
    timeoutMs = DEFAULT_LOG_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<string> {
    this.policyService.authorizeToolCall(policy, "readEnabled");
    this.policyService.assertEgressAllowed(policy, "logs");

    const containers = await this.monitoring.listCurrentContainers(task.vpsId);
    const target = containers.find(
      (c) =>
        c.containerKey === containerKey ||
        c.name === containerKey ||
        c.containerKey.startsWith(containerKey),
    );

    if (!target) {
      return JSON.stringify({
        containerKey,
        available: false,
        error: "container_not_found",
        observedAt: new Date().toISOString(),
      });
    }

    const syntheticRes = new SyntheticLogsResponse() as unknown as Response & {
      flush?: () => void;
    };
    const synthetic = syntheticRes as unknown as SyntheticLogsResponse;

    const query: DockerLogStreamQuery = {
      vpsId: task.vpsId,
      agentInstanceId: target.agentInstanceId,
      containerKey: target.containerKey,
    };

    const sessionContext: DockerLogsSessionContext = {
      localMode: true,
      dashboardSessionId: task.plan?.approvedSessionId,
    };

    try {
      await this.dockerLogsService.open(syntheticRes, query, sessionContext);
    } catch (error) {
      if (error instanceof DockerLogsPolicyError) {
        return JSON.stringify({
          containerKey: target.containerKey,
          available: false,
          error: error.code,
          status: error.status,
          observedAt: new Date().toISOString(),
        });
      }
      return JSON.stringify({
        containerKey: target.containerKey,
        available: false,
        error: error instanceof Error ? error.message : "logs_unavailable",
        observedAt: new Date().toISOString(),
      });
    }

    // Await either initial tail line collection, stream close, timeout, or abort
    const targetLines = Math.min(Math.max(1, tailLines), 200);
    const effectiveTimeout = Math.min(
      Math.max(500, timeoutMs),
      MAX_LOG_TIMEOUT_MS,
    );

    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          synthetic.destroy();
          resolve();
        }
      };

      const timer = setTimeout(done, effectiveTimeout);

      const checkInterval = setInterval(() => {
        if (synthetic.lines.length >= targetLines || synthetic.closed) {
          clearInterval(checkInterval);
          clearTimeout(timer);
          done();
        }
      }, 50);

      signal?.addEventListener("abort", () => {
        clearInterval(checkInterval);
        clearTimeout(timer);
        done();
      });
    });

    const cappedLines = synthetic.lines.slice(-targetLines);
    let totalBytes = 0;
    const boundedLines: string[] = [];
    let truncated = false;

    // Enforce 64 KiB tool envelope limit
    for (let i = cappedLines.length - 1; i >= 0; i--) {
      const line = cappedLines[i];
      const byteLen = Buffer.byteLength(line, "utf8");
      if (totalBytes + byteLen > MAX_CONTEXT_OUTPUT_BYTES - 2048) {
        truncated = true;
        break;
      }
      totalBytes += byteLen;
      boundedLines.unshift(line);
    }

    const payload = {
      containerKey: target.containerKey,
      available: true,
      lines: boundedLines,
      lineCount: boundedLines.length,
      truncated: truncated || synthetic.lines.length > boundedLines.length,
      observedAt: new Date().toISOString(),
    };

    return JSON.stringify(payload);
  }

  /**
   * Auto-authorized scoped file read execution with durable receipt await.
   * Enforces assertEgressAllowed("files") before transmission.
   * Redacts secrets before returning file contents to provider.
   */
  async readFile(
    task: AiTask,
    policy: AiPolicy,
    targetPath: string,
    scope: string,
    maxBytes = 65536,
    signal?: AbortSignal,
  ): Promise<string> {
    this.policyService.authorizeToolCall(policy, "readEnabled");
    this.policyService.assertEgressAllowed(policy, "files");

    if (
      !policy.fileReadScopes.includes(scope) ||
      !isWithinScope(targetPath, scope)
    ) {
      throw new AiAssistantError(
        "policy_denied",
        "Target path outside permitted fileReadScopes",
      );
    }

    const boundedMaxBytes = Math.min(Math.max(1, maxBytes), 262144);

    const { commandId } = await this.aiAgentService.enqueueAutoAuthorizedRead(
      task.vpsId,
      task.id,
      "file_read",
      { path: targetPath, scope, maxBytes: boundedMaxBytes },
      policy.revision,
    );

    let receipt: AiExecutionReceipt;
    try {
      receipt = await this.aiAgentService.waitForReceipt(task.id, commandId, 30000);
    } catch (error) {
      return JSON.stringify({
        path: targetPath,
        status: "uncertain",
        error: error instanceof Error ? error.message : "timeout",
        observedAt: new Date().toISOString(),
      });
    }

    if (receipt.status === "succeeded") {
      let rawContent = "";
      if (receipt.result && typeof receipt.result === "object") {
        const resObj = receipt.result as Record<string, unknown>;
        if (typeof resObj.content === "string") {
          rawContent = resObj.content;
        } else if (typeof resObj.output === "string") {
          rawContent = resObj.output;
        } else if (typeof resObj.stdout === "string") {
          rawContent = resObj.stdout;
        }
      } else if (typeof receipt.result === "string") {
        rawContent = receipt.result;
      }

      const redacted = redactString(rawContent);
      const isTruncated =
        Buffer.byteLength(redacted, "utf8") > MAX_CONTEXT_OUTPUT_BYTES;
      const safeContent = isTruncated
        ? redacted.slice(0, MAX_CONTEXT_OUTPUT_BYTES)
        : redacted;

      return JSON.stringify({
        path: targetPath,
        status: "succeeded",
        content: safeContent,
        bytes: Buffer.byteLength(safeContent, "utf8"),
        truncated: isTruncated,
        observedAt: new Date().toISOString(),
      });
    }

    return JSON.stringify({
      path: targetPath,
      status: receipt.status,
      errorCode: receipt.error?.code ?? "execution_failed",
      errorMessage: receipt.error?.message
        ? redactString(receipt.error.message)
        : "file_read failed",
      observedAt: new Date().toISOString(),
    });
  }

  /**
   * Auto-authorized service status execution with durable receipt await.
   * Redacts secrets before returning status preview to provider.
   */
  async getServiceStatus(
    task: AiTask,
    policy: AiPolicy,
    profileId: string,
    service: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.policyService.authorizeToolCall(policy, "readEnabled");

    if (!policy.serviceProfileIds.includes(profileId)) {
      throw new AiAssistantError(
        "policy_denied",
        "Profile ID not in permitted serviceProfileIds",
      );
    }

    const { commandId } = await this.aiAgentService.enqueueAutoAuthorizedRead(
      task.vpsId,
      task.id,
      "service_status",
      { profileId, service },
      policy.revision,
    );

    let receipt: AiExecutionReceipt;
    try {
      receipt = await this.aiAgentService.waitForReceipt(task.id, commandId, 30000);
    } catch (error) {
      return JSON.stringify({
        profileId,
        service,
        status: "uncertain",
        error: error instanceof Error ? error.message : "timeout",
        observedAt: new Date().toISOString(),
      });
    }

    let output: unknown = null;
    if (receipt.result && typeof receipt.result === "object") {
      const resObj = receipt.result as Record<string, unknown>;
      if (typeof resObj.output === "string") {
        output = redactString(resObj.output);
      } else if (typeof resObj.content === "string") {
        output = redactString(resObj.content);
      } else {
        output = receipt.result;
      }
    } else if (typeof receipt.result === "string") {
      output = redactString(receipt.result);
    }

    return JSON.stringify({
      profileId,
      service,
      status: receipt.status,
      output,
      errorCode: receipt.error?.code ?? null,
      errorMessage: receipt.error?.message
        ? redactString(receipt.error.message)
        : null,
      observedAt: new Date().toISOString(),
    });
  }
}
