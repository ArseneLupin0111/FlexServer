import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { redactString } from "../common/redaction.js";
import { DashboardSessionService } from "../auth/dashboard-session.service.js";
import { AI_REPOSITORY, APP_CONFIG, DOCKER_MONITORING_REPOSITORY } from "../tokens.js";
import { AiPolicyService } from "./ai-policy.service.js";
import { AiAssistantError } from "./ai-failures.js";
import type { DockerMonitoringRepository } from "../persistence/repositories/docker-monitoring.repository.js";
import {
  AiPersistenceConflictError,
  type AiOutboxCommandExpect,
  type AiRepository,
} from "../persistence/repositories/ai.persistence.js";
import type { AppConfig } from "../config/app-config.js";
import { decryptAiSecret, loadAiKeyring } from "./ai-crypto.js";
import type {
  AiCapability,
  AiExecutionReceipt,
  AiHostCommand,
  AiOutboxEntry,
  AiTask,
  AiTaskState,
} from "./ai.models.js";
import {
  hostCancelStatusSchema,
  hostClaimSchema,
  hostHeartbeatSchema,
  hostOutputSchema,
  hostResultSchema,
} from "./ai.schemas.js";
const TOKEN_REDACT_REGEX = /vma_[a-zA-Z0-9_-]+/g;

export function redactSensitive(text: string): string {
  if (!text) return text;
  return redactString(text).replace(TOKEN_REDACT_REGEX, "[redacted]");
}

function isPathAllowed(filePath: string, allowedScopes: string[]): boolean {
  if (!allowedScopes || allowedScopes.length === 0) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return allowedScopes.some((scope) => {
    const normScope = scope.replace(/\\/g, "/");
    return (
      normalized === normScope ||
      normalized.startsWith(
        normScope.endsWith("/") ? normScope : normScope + "/",
      )
    );
  });
}

export type BoundedOutputChunk = {
  streamId: string;
  sequence: number;
  globalCursor?: number;
  chunk: string;
  isGap: boolean;
  isEnd: boolean;
  timestamp: string;
};

export type BoundedOutputEnvelope = {
  taskId: string;
  nextCursor: number;
  chunks: BoundedOutputChunk[];
  hasMore: boolean;
  isGap: boolean;
};

interface TaskRingBuffer {
  taskId: string;
  chunks: BoundedOutputChunk[];
  currentBytes: number;
  nextGlobalSeq: number;
  earliestGlobalCursor: number;
  highestGlobalCursor: number;
  lastUpdated: number;
  hasGapBeforeEarliest: boolean;
}

export class AiEphemeralOutputBuffer {
  private readonly maxBytesPerTask = 1024 * 1024; // 1 MiB per task
  private readonly maxTotalTasks = 64; // Max 64 tasks retained in memory (~64 MiB upper bound)
  private readonly maxReadBatchBytes = 64 * 1024; // 64 KiB max per readOutput call
  private readonly buffers = new Map<string, TaskRingBuffer>();

  append(taskId: string, chunk: BoundedOutputChunk): void {
    let entry = this.buffers.get(taskId);
    if (!entry) {
      if (this.buffers.size >= this.maxTotalTasks) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [id, buf] of this.buffers.entries()) {
          if (buf.lastUpdated < oldestTime) {
            oldestTime = buf.lastUpdated;
            oldestKey = id;
          }
        }
        if (oldestKey) {
          this.buffers.delete(oldestKey);
        }
      }
      entry = {
        taskId,
        chunks: [],
        currentBytes: 0,
        nextGlobalSeq: 0,
        earliestGlobalCursor: 1,
        highestGlobalCursor: 0,
        lastUpdated: Date.now(),
        hasGapBeforeEarliest: chunk.sequence > 0 || chunk.isGap,
      };
      this.buffers.set(taskId, entry);
    }

    entry.lastUpdated = Date.now();
    entry.nextGlobalSeq += 1;
    const globalCursor = entry.nextGlobalSeq;
    entry.highestGlobalCursor = globalCursor;

    const storedChunk: BoundedOutputChunk = {
      ...chunk,
      globalCursor,
    };

    const chunkBytes = Buffer.byteLength(storedChunk.chunk, "utf8");
    while (
      entry.chunks.length > 0 &&
      entry.currentBytes + chunkBytes > this.maxBytesPerTask
    ) {
      const removed = entry.chunks.shift()!;
      entry.currentBytes -= Buffer.byteLength(removed.chunk, "utf8");
      entry.hasGapBeforeEarliest = true;
      if (entry.chunks.length > 0) {
        entry.earliestGlobalCursor = entry.chunks[0].globalCursor ?? 1;
        entry.chunks[0].isGap = true;
      }
    }

    entry.chunks.push(storedChunk);
    entry.currentBytes += chunkBytes;
  }

  getChunksAfter(
    taskId: string,
    cursor = 0,
  ): BoundedOutputEnvelope {
    const entry = this.buffers.get(taskId);
    if (!entry) {
      return {
        taskId,
        nextCursor: cursor,
        chunks: [],
        hasMore: false,
        isGap: false,
      };
    }

    const isGapDetected =
      (cursor === 0 && entry.hasGapBeforeEarliest) ||
      (cursor > 0 && cursor < entry.earliestGlobalCursor);

    const candidateChunks =
      cursor > 0
        ? entry.chunks.filter((c) => (c.globalCursor ?? 0) > cursor)
        : [...entry.chunks];

    // Bounded per-call output: accumulate up to 64 KiB
    const selectedChunks: BoundedOutputChunk[] = [];
    let batchBytes = 0;
    let hasMore = false;

    for (let i = 0; i < candidateChunks.length; i++) {
      const c = candidateChunks[i];
      const cBytes = Buffer.byteLength(c.chunk, "utf8");
      if (selectedChunks.length > 0 && batchBytes + cBytes > this.maxReadBatchBytes) {
        hasMore = true;
        break;
      }
      selectedChunks.push(c);
      batchBytes += cBytes;
    }

    if (isGapDetected && selectedChunks.length > 0) {
      selectedChunks[0] = { ...selectedChunks[0], isGap: true };
    }

    const nextCursor =
      selectedChunks.length > 0
        ? selectedChunks[selectedChunks.length - 1].globalCursor ?? cursor
        : Math.max(cursor, entry.highestGlobalCursor);

    return {
      taskId,
      nextCursor,
      chunks: selectedChunks,
      hasMore,
      isGap: isGapDetected,
    };
  }

  hasBuffer(taskId: string): boolean {
    return this.buffers.has(taskId);
  }

  clear(taskId: string): void {
    this.buffers.delete(taskId);
  }
}

@Injectable()
export class AiAgentService {
  private readonly outputEmitter = new EventEmitter();
  private readonly receiptEmitter = new EventEmitter();
  private readonly outputBuffer = new AiEphemeralOutputBuffer();
  private readonly ephemeralReceiptCache = new Map<string, AiExecutionReceipt>();
  constructor(
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DashboardSessionService)
    private readonly dashboardSessionService: DashboardSessionService,
    @Inject(DOCKER_MONITORING_REPOSITORY)
    private readonly monitoring: DockerMonitoringRepository,
    @Inject(AiPolicyService)
    private readonly policyService: AiPolicyService,
  ) {
    this.outputEmitter.setMaxListeners(128);
    this.receiptEmitter.setMaxListeners(128);
  }

  subscribeOutput(
    taskId: string,
    listener: (chunk: BoundedOutputChunk) => void,
  ): () => void {
    const eventName = `output:${taskId}`;
    this.outputEmitter.on(eventName, listener);
    return () => {
      this.outputEmitter.off(eventName, listener);
    };
  }

  /**
   * Read bounded ephemeral output envelopes for controller SSE stream polling.
   * Monotonic nextCursor across ring buffer evictions, with explicit gap flag
   * on eviction/reconnect/cross-API unavailable.
   */
  async readOutput(
    taskId: string,
    cursor = 0,
  ): Promise<BoundedOutputEnvelope> {
    if (!this.outputBuffer.hasBuffer(taskId)) {
      // Check if task exists and has executed receipts (startup / reconnect / cross-API instance)
      const receipts = await this.repository.listReceiptsByTask(taskId, 1);
      if (receipts.length > 0 || cursor > 0) {
        return {
          taskId,
          nextCursor: Math.max(cursor, 1),
          chunks: [],
          hasMore: false,
          isGap: true,
        };
      }
    }
    return this.outputBuffer.getChunksAfter(taskId, cursor);
  }

  clearOutput(taskId: string): void {
    this.outputBuffer.clear(taskId);
  }

  /**
   * Enqueue an auto-authorized scoped read command (file_read, service_status)
   * for host agent execution without synthetic human plan approval.
   */
  async enqueueAutoAuthorizedRead(
    vpsId: string,
    taskId: string,
    kind: "file_read" | "service_status",
    payload: Record<string, unknown>,
    policyRevision?: number,
  ): Promise<{ commandId: string }> {
    const task = await this.repository.getTask(vpsId, taskId);
    if (!task) {
      throw new NotFoundException("Task not found");
    }
    if (task.state !== "planning" && task.state !== "awaiting_input") {
      throw new BadRequestException(
        "Task must be in planning or awaiting_input state for auto-authorized reads",
      );
    }

    if (
      !task.initiatingSessionId ||
      !(await this.dashboardSessionService.authenticateById(
        task.initiatingSessionId,
      ))
    ) {
      throw new ForbiddenException(
        "Initiating session is required and must be valid",
      );
    }

    const policy = await this.repository.getAiPolicy(vpsId);
    if (!policy || !policy.aiEnabled || !policy.readEnabled) {
      throw new ForbiddenException("AI read policy is disabled");
    }

    if (kind === "file_read") {
      let targetPath: string | undefined;
      if (
        payload &&
        typeof payload === "object" &&
        "path" in payload &&
        typeof payload.path === "string"
      ) {
        targetPath = payload.path;
      }
      if (!targetPath || !isPathAllowed(targetPath, policy.fileReadScopes)) {
        throw new ForbiddenException("Path not permitted by fileReadScopes");
      }
    }

    // Bind to the authoritative latest active agent instance BEFORE enqueueing.
    // No empty agent binding is ever dispatched; a missing snapshot fails fast
    // with sandbox_unavailable, no retries.
    const latest = await this.monitoring.getAuthoritativeLatest(vpsId);
    if (!latest?.activeInstanceId) {
      throw new AiAssistantError("sandbox_unavailable");
    }
    const agentInstanceId = latest.activeInstanceId;

    const commandId = randomUUID();
    const revision = policyRevision ?? policy.revision;
    const planDigest = createHash("sha256")
      .update(JSON.stringify({ kind, payload }))
      .digest("hex");

    const command: AiHostCommand = {
      version: 1,
      taskId,
      stepId: `read-${commandId}`,
      commandId,
      vpsId,
      agentInstanceId,
      planVersion: 0,
      planDigest,
      policyRevision: revision,
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      kind,
      payload,
    };

    const outboxEntry: AiOutboxEntry = {
      id: randomUUID(),
      commandId,
      taskId,
      stepId: `read-${commandId}`,
      vpsId,
      agentInstanceId,
      command,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const expect: AiOutboxCommandExpect = {
      taskId,
      taskIdRevision: task.revision,
      commandId,
      autoAuthorized: true,
    };

    await this.repository.enqueueCommands([{ entry: outboxEntry, expect }]);
    return { commandId };
  }

  /**
   * Await receipt for an enqueued command with zero-latency event notification
   * and fallback repository polling.
   */
  async waitForReceipt(
    taskId: string,
    commandId: string,
    timeoutMs = 30000,
  ): Promise<AiExecutionReceipt> {
    const cached = this.ephemeralReceiptCache.get(commandId);
    if (cached) {
      return cached;
    }
    const receipts = await this.repository.listReceiptsByTask(taskId);
    const existing = receipts.find((r) => r.commandId === commandId);
    if (existing) {
      return existing;
    }

    const { promise, resolve, reject } =
      Promise.withResolvers<AiExecutionReceipt>();
    const timer = setTimeout(() => {
      this.receiptEmitter.off(`receipt:${commandId}`, onReceipt);
      reject(
        new Error(`Timeout waiting for receipt commandId=${commandId}`),
      );
    }, timeoutMs);

    const onReceipt = (r: AiExecutionReceipt) => {
      clearTimeout(timer);
      this.receiptEmitter.off(`receipt:${commandId}`, onReceipt);
      resolve(r);
    };

    this.receiptEmitter.once(`receipt:${commandId}`, onReceipt);
    return promise;
  }
  /**
   * Claim next pending command for this VPS with full revalidation:
   *  - Policy revision and permissions check
   *  - Provider revision check
   *  - Session provenance revalidation (plan.approvedSessionId)
   *  - Payload decryption from execution blob using AES-GCM and keyring
   * Plaintext payload is placed ONLY in the returned command; DB outbox is never updated with plaintext.
   */
  async claim(
    vpsId: string,
    input: z.infer<typeof hostClaimSchema>,
  ): Promise<AiHostCommand | null> {
    if (input.capabilities) {
      const caps: AiCapability = {
        vpsId,
        supported: input.capabilities.supported,
        reason: input.capabilities.unsupportedReason,
        freshness: new Date().toISOString(),
        protocolVersion: 1,
        cgroupV2Available: input.capabilities.cgroupV2,
        namespacesAvailable: input.capabilities.namespaces,
        seccompAvailable: input.capabilities.seccomp,
        // Additive execmode field: absent from older agents → false (fail-closed).
        privilegedSupported: input.capabilities.privilegedSupported === true,
        ...(input.capabilities.privilegedUnsupportedReason
          ? { privilegedUnsupportedReason: input.capabilities.privilegedUnsupportedReason }
          : {}),
        profiles: [],
        rootfsDigest: input.capabilities.rootfsDigest,
      };
      await this.repository.recordAiCapability(caps);
    }

    if (!this.config.ai.enabled) {
      return null;
    }

    const commands = await this.repository.claimCommands(
      input.agentInstanceId,
      vpsId,
      1,
    );
    if (!commands || commands.length === 0) {
      return null;
    }

    const command = commands[0];
    const task = await this.repository.getTask(vpsId, command.taskId);
    if (!task) {
      await this.repository.markCommandAcknowledged(
        command.commandId,
        input.agentInstanceId,
      );
      return null;
    }

    const isAutoAuthorizedRead =
      command.planVersion === 0 &&
      (command.kind === "file_read" || command.kind === "service_status");

    if (isAutoAuthorizedRead) {
      // Auto-authorized read: task must be in planning or awaiting_input state
      if (task.state !== "planning" && task.state !== "awaiting_input") {
        await this.repository.markCommandAcknowledged(
          command.commandId,
          input.agentInstanceId,
        );
        return null;
      }

      // Session provenance revalidation against task initiating session
      if (
        !task.initiatingSessionId ||
        !(await this.dashboardSessionService.authenticateById(
          task.initiatingSessionId,
        ))
      ) {
        await this.failCommandWithoutTerminalizingTask(
          command,
          input.agentInstanceId,
          "approval_expired",
          "Initiating session is expired or revoked",
        );
        return null;
      }

      // Policy revalidation
      const policy = await this.repository.getAiPolicy(vpsId);
      if (!policy || !policy.aiEnabled || !policy.readEnabled) {
        await this.failCommandWithoutTerminalizingTask(
          command,
          input.agentInstanceId,
          "policy_denied",
          "AI read policy is disabled",
        );
        return null;
      }

      if (command.kind === "file_read") {
        let targetPath: string | undefined;
        if (
          command.payload &&
          typeof command.payload === "object" &&
          "path" in command.payload &&
          typeof command.payload.path === "string"
        ) {
          targetPath = command.payload.path;
        }
        if (!targetPath || !isPathAllowed(targetPath, policy.fileReadScopes)) {
          await this.failCommandWithoutTerminalizingTask(
            command,
            input.agentInstanceId,
            "policy_denied",
            "Target path not allowed by fileReadScopes policy",
          );
          return null;
        }
      }

      return {
        version: 1,
        taskId: command.taskId,
        stepId: command.stepId,
        commandId: command.commandId,
        vpsId,
        agentInstanceId: input.agentInstanceId,
        planVersion: 0,
        planDigest: command.planDigest,
        policyRevision: command.policyRevision,
        deadlineAt: command.deadlineAt,
        kind: command.kind,
        payload: command.payload,
      };
    }

    if (task.state !== "executing" && task.state !== "cancel_requested") {
      await this.repository.markCommandAcknowledged(
        command.commandId,
        input.agentInstanceId,
      );
      return null;
    }

    const plan = task.plan;
    if (
      !plan ||
      plan.status !== "consumed" ||
      plan.planVersion !== command.planVersion ||
      plan.planDigest !== command.planDigest
    ) {
      await this.failCommandAndTask(
        task,
        command,
        input.agentInstanceId,
        "stale_plan",
        "Plan is not in consumed state or plan digest mismatch",
      );
      return null;
    }

    // Session provenance revalidation
    if (
      !plan.approvedSessionId ||
      !(await this.dashboardSessionService.authenticateById(
        plan.approvedSessionId,
      ))
    ) {
      await this.failCommandAndTask(
        task,
        command,
        input.agentInstanceId,
        "approval_expired",
        "Approving session is expired or revoked",
      );
      return null;
    }

    // Policy revalidation
    const policy = await this.repository.getAiPolicy(vpsId);
    if (
      !policy ||
      !policy.aiEnabled ||
      policy.revision !== command.policyRevision
    ) {
      await this.failCommandAndTask(
        task,
        command,
        input.agentInstanceId,
        "policy_denied",
        "AI policy changed or disabled",
      );
      return null;
    }

    if (command.kind === "shell" && !policy.shellEnabled) {
      await this.failCommandAndTask(
        task,
        command,
        input.agentInstanceId,
        "policy_denied",
        "Shell commands disabled by policy",
      );
      return null;
    }

    // Provider revalidation — scoped to the plan's own provider (Q9): another
    // provider's configuration change never blocks this claim.
    const planProviderId = plan.providerId ?? task.providerId;
    let providerRevisionOk: boolean;
    if (planProviderId) {
      const profile = await this.repository.getProviderProfile(planProviderId);
      providerRevisionOk = profile?.revision === plan.providerRevision;
    } else {
      const settings = await this.repository.getSettings();
      providerRevisionOk = settings?.revision === plan.providerRevision;
    }
    if (!providerRevisionOk) {
      await this.failCommandAndTask(
        task,
        command,
        input.agentInstanceId,
        "provider_revision_changed",
        "Provider revision changed since plan was approved",
      );
      return null;
    }

    // Decrypt execution blob if command payload holds encryptedBlobId
    let payload = command.payload;
    const blobId = (payload as Record<string, unknown>)?.encryptedBlobId as
      | string
      | undefined;
    if (blobId) {
      const blob = await this.repository.getExecutionBlob(blobId);
      if (!blob) {
        await this.failCommandAndTask(
          task,
          command,
          input.agentInstanceId,
          "execution_failed",
          "Execution blob not found or expired",
        );
        return null;
      }
      try {
        const keyring = await loadAiKeyring(this.config.ai.keyringFile);
        const plaintext = decryptAiSecret(
          blob.encryptedPayload,
          {
            vpsId,
            taskId: command.taskId,
            field: "executionPayload",
            version: 1,
          },
          keyring,
        );
        payload = JSON.parse(plaintext);
      } catch {
        await this.failCommandAndTask(
          task,
          command,
          input.agentInstanceId,
          "execution_failed",
          "Failed to decrypt execution payload",
        );
        return null;
      }
    }

    const returnedCommand: AiHostCommand = {
      version: 1,
      taskId: command.taskId,
      stepId: command.stepId,
      commandId: command.commandId,
      vpsId,
      agentInstanceId: input.agentInstanceId,
      planVersion: command.planVersion,
      planDigest: command.planDigest,
      policyRevision: command.policyRevision,
      deadlineAt: command.deadlineAt,
      kind: command.kind,
      payload,
    };

    return returnedCommand;
  }

  async heartbeat(
    vpsId: string,
    input: z.infer<typeof hostHeartbeatSchema>,
  ): Promise<{ ok: boolean; cancelRequested: boolean }> {
    const task = await this.repository.getTask(vpsId, input.taskId);
    if (!task) {
      return { ok: false, cancelRequested: true };
    }

    let cancelRequested =
      task.state === "cancel_requested" || task.state === "cancelled";

    if (
      task.plan?.approvedSessionId &&
      !(await this.dashboardSessionService.authenticateById(
        task.plan.approvedSessionId,
      ))
    ) {
      cancelRequested = true;
    }

    return { ok: true, cancelRequested };
  }

  async output(
    vpsId: string,
    input: z.infer<typeof hostOutputSchema>,
  ): Promise<{ ok: boolean; acknowledgedSeq: number }> {
    const task = await this.repository.getTask(vpsId, input.taskId);
    if (!task) {
      throw new NotFoundException("Task not found");
    }

    const redactedChunk = redactSensitive(input.chunk);
    const chunkData: BoundedOutputChunk = {
      streamId: input.streamId,
      sequence: input.sequence,
      chunk: redactedChunk,
      isGap: input.isGap,
      isEnd: input.isEnd,
      timestamp: new Date().toISOString(),
    };

    this.outputBuffer.append(input.taskId, chunkData);
    this.outputEmitter.emit(`output:${input.taskId}`, chunkData);

    return { ok: true, acknowledgedSeq: input.sequence };
  }

  async result(
    vpsId: string,
    input: z.infer<typeof hostResultSchema>,
  ): Promise<{ ok: boolean; commandId: string; agentInstanceId: string }> {
    const task = await this.repository.getTask(vpsId, input.taskId);
    if (!task) {
      throw new NotFoundException("Task not found");
    }
    const isAutoAuthorizedRead = input.planVersion === 0;

    // Strict binding to persisted command plan version / digest before branching
    if (!isAutoAuthorizedRead) {
      const plan = task.plan;
      if (
        !plan ||
        plan.planVersion !== input.planVersion ||
        plan.planDigest !== input.planDigest
      ) {
        throw new ConflictException(
          "Plan version or plan digest mismatch with active task plan",
        );
      }
    }

    const step = task.plan?.steps.find((s) => s.stepId === input.stepId);
    const payloadDigest =
      step?.inputDigests?.payload ??
      (typeof step?.args?.payloadDigest === "string"
        ? step.args.payloadDigest
        : (isAutoAuthorizedRead ? input.planDigest : ""));

    const outputPreview = input.outputPreview
      ? redactSensitive(input.outputPreview)
      : undefined;
    const errorMessage = input.errorMessage
      ? redactSensitive(input.errorMessage)
      : undefined;

    // Ephemeral in-memory receipt contains full typed payload for active callers like AiReadTools
    const inMemoryReceipt: AiExecutionReceipt = {
      commandId: input.commandId,
      taskId: input.taskId,
      stepId: input.stepId,
      vpsId,
      agentInstanceId: input.agentInstanceId,
      planVersion: input.planVersion,
      planDigest: input.planDigest,
      payloadDigest,
      status: input.status,
      result: input.payload,
      outputPreview,
      errorCode: input.errorCode,
      errorMessage,
      error: input.errorCode
        ? { code: input.errorCode, message: errorMessage ?? "" }
        : undefined,
      createdAt: new Date().toISOString(),
    };
    this.ephemeralReceiptCache.set(input.commandId, inMemoryReceipt);
    if (this.ephemeralReceiptCache.size > 256) {
      const first = this.ephemeralReceiptCache.keys().next().value;
      if (first) this.ephemeralReceiptCache.delete(first);
    }

    // Raw file contents and execution output stay transient. Digests retain
    // receipt identity without persisting agent-controlled free text.
    const durableResult = {
      executed: input.executed,
      exitCode: input.exitCode,
    };

    const durableReceipt: AiExecutionReceipt = {
      ...inMemoryReceipt,
      result: durableResult,
      outputPreview: undefined,
      errorMessage: undefined,
      error: input.errorCode ? { code: input.errorCode, message: "" } : undefined,
    };


    let created = 0;
    try {
      const res = await this.repository.recordReceipts([durableReceipt]);
      created = res.created;
    } catch (err) {
      if (
        err instanceof AiPersistenceConflictError &&
        err.code === "receipt_conflict"
      ) {
        await this.repository.markCommandAcknowledged(
          input.commandId,
          input.agentInstanceId,
        );
        this.receiptEmitter.emit(`receipt:${input.commandId}`, inMemoryReceipt);
        try {
          await this.repository.updateTask({
            id: task.id,
            expectedRevision: task.revision,
            state: "uncertain",
            error: {
              code: "uncertain_outcome",
              message: "Conflicting execution receipt reported for command",
            },
          });
        } catch {
          // Benign on concurrent CAS update
        }
        return {
          ok: true,
          commandId: input.commandId,
          agentInstanceId: input.agentInstanceId,
        };
      }
      throw err;
    }

    await this.repository.markCommandAcknowledged(
      input.commandId,
      input.agentInstanceId,
    );

    this.receiptEmitter.emit(`receipt:${input.commandId}`, inMemoryReceipt);

    if (isAutoAuthorizedRead) {
      // Auto-authorized reads MUST NOT terminalize the task
      return {
        ok: true,
        commandId: input.commandId,
        agentInstanceId: input.agentInstanceId,
      };
    }

    // Idempotent duplicate: receipt already committed
    if (created === 0) {
      return {
        ok: true,
        commandId: input.commandId,
        agentInstanceId: input.agentInstanceId,
      };
    }

    // Transition task based on receipts across all steps
    await this.transitionTaskOnReceipt(task, durableReceipt, input.executed);

    return {
      ok: true,
      commandId: input.commandId,
      agentInstanceId: input.agentInstanceId,
    };
  }

  async cancelStatus(
    vpsId: string,
    input: z.infer<typeof hostCancelStatusSchema>,
  ): Promise<{ ok: boolean }> {
    const task = await this.repository.getTask(vpsId, input.taskId);
    if (!task) {
      return { ok: true };
    }

    if (task.state === "cancel_requested") {
      const receipts = await this.repository.listReceiptsByTask(input.taskId);
      const anyExecuted = receipts.some(
        (r) => r.status === "uncertain" || r.status === "succeeded",
      );
      const nextState: AiTaskState = anyExecuted ? "uncertain" : "cancelled";
      try {
        await this.repository.updateTask({
          id: task.id,
          expectedRevision: task.revision,
          state: nextState,
          error: {
            code: "cancelled",
            message: "Command execution cancelled and scope terminated",
          },
        });
      } catch {
        // Revision CAS conflict or concurrent update is benign
      }
    }

    return { ok: true };
  }

  private async failCommandAndTask(
    task: AiTask,
    command: AiHostCommand,
    agentInstanceId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const receipt: AiExecutionReceipt = {
      commandId: command.commandId,
      taskId: command.taskId,
      stepId: command.stepId,
      vpsId: task.vpsId,
      agentInstanceId,
      planVersion: command.planVersion,
      planDigest: command.planDigest,
      payloadDigest: "",
      status: "failed",
      error: { code: errorCode, message: errorMessage },
      createdAt: new Date().toISOString(),
    };
    await this.repository.recordReceipts([receipt]);
    await this.repository.markCommandAcknowledged(
      command.commandId,
      agentInstanceId,
    );
    try {
      await this.repository.updateTask({
        id: task.id,
        expectedRevision: task.revision,
        state: "failed",
        error: { code: errorCode, message: errorMessage },
      });
    } catch {
      // Ignored if concurrent update intervened
    }
  }

  private async failCommandWithoutTerminalizingTask(
    command: AiHostCommand,
    agentInstanceId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const receipt: AiExecutionReceipt = {
      commandId: command.commandId,
      taskId: command.taskId,
      stepId: command.stepId,
      vpsId: command.vpsId,
      agentInstanceId,
      planVersion: command.planVersion,
      planDigest: command.planDigest,
      payloadDigest: "",
      status: "failed",
      error: { code: errorCode, message: errorMessage },
      createdAt: new Date().toISOString(),
    };
    await this.repository.recordReceipts([receipt]);
    await this.repository.markCommandAcknowledged(
      command.commandId,
      agentInstanceId,
    );
    this.receiptEmitter.emit(`receipt:${command.commandId}`, receipt);
  }

  private async transitionTaskOnReceipt(
    task: AiTask,
    receipt: AiExecutionReceipt,
    executed: boolean,
  ): Promise<void> {
    const receipts = await this.repository.listReceiptsByTask(task.id);
    const plan = task.plan;
    const allStepsCompleted = plan
      ? plan.steps.every((s) => receipts.some((r) => r.stepId === s.stepId))
      : true;

    let finalOutcome: AiTaskState | null = null;

    if (receipt.status === "uncertain" || (receipt.status === "cancelled" && executed)) {
      finalOutcome = "uncertain";
    } else if (receipt.status === "cancelled" && !executed) {
      finalOutcome = "cancelled";
    } else if (receipt.status === "failed") {
      finalOutcome = "failed";
    } else if (allStepsCompleted) {
      if (receipts.some((r) => r.status === "uncertain")) {
        finalOutcome = "uncertain";
      } else if (receipts.some((r) => r.status === "failed")) {
        finalOutcome = "failed";
      } else if (receipts.some((r) => r.status === "cancelled")) {
        finalOutcome = "uncertain";
      } else if (receipts.every((r) => r.status === "succeeded")) {
        finalOutcome = "succeeded";
      }
    }

    if (!finalOutcome) {
      return;
    }

    try {
      if (task.state === "executing") {
        const verifyingTask = await this.repository.updateTask({
          id: task.id,
          expectedRevision: task.revision,
          state: "verifying",
        });
        await this.repository.updateTask({
          id: task.id,
          expectedRevision: verifyingTask.revision,
          state: finalOutcome,
          error:
            finalOutcome === "failed"
              ? receipt.error ?? {
                  code: "execution_failed",
                  message: "Execution step failed",
                }
              : undefined,
        });
      } else if (task.state === "verifying" || task.state === "cancel_requested") {
        await this.repository.updateTask({
          id: task.id,
          expectedRevision: task.revision,
          state: finalOutcome,
          error:
            finalOutcome === "failed"
              ? receipt.error ?? {
                  code: "execution_failed",
                  message: "Execution step failed",
                }
              : undefined,
        });
      }
    } catch {
      // Ignored on CAS collision; durable receipt remains authoritative
    }
  }
}
