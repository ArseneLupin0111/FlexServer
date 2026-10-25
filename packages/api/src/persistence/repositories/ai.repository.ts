import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { createDatabasePool } from "../../db/pool.js";
import type { Pool, PoolClient } from "pg";
import { loadAiKeyring, rewrapAiEnvelope } from "../../ai/ai-crypto.js";
import { redactString } from "../../common/redaction.js";
import {
  AI_CHECKPOINT_SUMMARY_MAX_BYTES,
  AI_HISTORY_DEFAULT_PAGE,
  AI_HISTORY_MAX_PAGE,
  AI_TERMINAL_TASK_STATES,
  AiPersistenceConflictError,
  type AiCapabilityUpsertInput,
  type AiCheckpointAdvanceInput,
  type AiConversationAppendMessageInput,
  type AiOutboxCommandExpect,
  type AiPlanApprovalInput,
  type AiPolicyUpdateInput,
  type AiProviderMigrationView,
  type AiProviderProfileWriteInput,
  type AiRepository,
  type AiSettingsUpdateInput,
  type AiTaskCreateInput,
  type AiTaskTransitionInput,
} from "./ai.persistence.js";
import type { AiConversation, AiConversationCheckpoint, AiConversationMessage, AiAuditEvent, AiCapability, AiExecutionBlob, AiExecutionReceipt, AiHostCommand, AiOutboxEntry, AiPlan, AiPolicy, AiProviderProfileInternal, AiProviderSettingsInternal, AiTask, AiTaskState, AiTaskUsage } from "../../ai/ai.models.js";
import {
  readJsonFile,
  readModifyWriteJsonFile,
  withFileLock,
  writeJsonFile,
} from "./json-file.js";

const bumpRevision = (revision: number): number => revision + 1;
// Absent-policy default: observation and approval-gated management stay
// available by default; shell and provider-egress grants remain opt-in.
const defaultAiPolicy = (vpsId: string): AiPolicy => ({
  vpsId, aiEnabled: true, readEnabled: true, dockerActionsEnabled: true,
  composeActionsEnabled: true, shellEnabled: false, fileReadScopes: [],
  fileWriteScopes: [], serviceProfileIds: [], sendLogsToProvider: false,
  sendFilesToProvider: false, revision: 0, updatedAt: new Date(0).toISOString(),
});
const refreshPolicy = (base: AiPolicy, patch: AiPolicyUpdateInput["patch"], now: string): AiPolicy =>
  ({ ...base, ...patch, vpsId: base.vpsId, revision: bumpRevision(base.revision), updatedAt: now });
const matchesAuditFilter = (event: AiAuditEvent, filter?: { vpsId?: string; taskId?: string }): boolean =>
  (!filter?.vpsId || event.vpsId === filter.vpsId) && (!filter?.taskId || event.taskId === filter.taskId);

const PROVIDER_MODELS_MAX = 100;
const providerModelsValid = (models: string[]): boolean =>
  models.length > 0 &&
  models.length <= PROVIDER_MODELS_MAX &&
  models.every((model) => model.length >= 1 && model.length <= 256) &&
  new Set(models).size === models.length;
/** Per-provider API-key AAD (docs/ai-multi-provider-plan.md invariant "Keys"). */
export const aiProviderKeyAad = (providerId: string) =>
  ({ vpsId: "global", taskId: providerId, field: "providerApiKey", version: 1 }) as const;

// ── Shared state model (docs/ai-assistant-implementation-plan.md §9) ─────
// JSON driver: one bounded document, all invariants enforced under the JSON
// file lock (plan §9: task/approval/outbox commit together). PG driver: the
// same document in a single jsonb row of ai_state_journal; every operation
// rewrites that row inside one SQL transaction, so CAS/admission/approval/
// outbox/receipt checks cannot interleave — identical semantics.

export type StoredAiState = {
  settings?: AiProviderSettingsInternal;
  /** Multi-provider profiles (docs/ai-multi-provider-plan.md); optional for
   * documents persisted before this field existed. */
  providers?: AiProviderProfileInternal[];
  /** Admin's last chat selection (Q16 tier 2). */
  lastSelection?: { providerId: string; model: string };
  /** Stamped once the legacy→providers boot migration has run (Q15). */
  providersMigratedAt?: string;
  conversations: AiConversation[];
  messages: (AiConversationMessage & { vpsId: string })[];
  tasks: StoredTask[];
  outbox: AiOutboxEntry[];
  receipts: (AiExecutionReceipt & { updatedAt: string })[];
  blobs: AiExecutionBlob[];
  policies: AiPolicy[];
  capabilities: Record<string, AiCapability>;
  auditEvents: AiAuditEventRow[];
  /** Per-conversation compaction checkpoints; optional because documents
   *  persisted before this field existed load without it (back-compat). */
  checkpoints?: StoredAiCheckpoint[];
};

export type StoredAiCheckpoint = AiConversationCheckpoint & { vpsId: string };

export type AiAuditEventRow = {
  createdAt: string;
  event: AiAuditEvent;
};

export type StoredTask = AiTask & {
  idempotencyKey: string;
  initiatingSessionId: string;
};

const emptyAiState = (): StoredAiState => ({
  conversations: [],
  messages: [],
  tasks: [],
  outbox: [],
  receipts: [],
  blobs: [],
  policies: [],
  capabilities: {},
  auditEvents: [],
  checkpoints: [],
  providers: [],
});

const defaultUsage = (): AiTaskUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  estimated: false,
  rounds: 0,
  toolCalls: 0,
});

const ACTIVE_STATES = new Set<AiTaskState>([
  "planning",
  "awaiting_input",
  "awaiting_approval",
  "executing",
  "verifying",
  "cancel_requested",
  "uncertain",
]);

const isTerminalState = (state: AiTaskState): boolean =>
  !ACTIVE_STATES.has(state) && AI_TERMINAL_TASK_STATES.includes(state);

const isoNow = (now?: string): string => now ?? new Date().toISOString();

const isoOptional = (
  value: string | Date | null | undefined,
): string | undefined =>
  value
    ? value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString()
    : undefined;

const applyUsageDelta = (
  usage: AiTaskUsage,
  delta?: Partial<AiTaskUsage>,
): AiTaskUsage => {
  if (!delta) return usage;
  return {
    inputTokens: usage.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: usage.outputTokens + (delta.outputTokens ?? 0),
    estimated: delta.estimated ?? usage.estimated,
    rounds: usage.rounds + (delta.rounds ?? 0),
    toolCalls: usage.toolCalls + (delta.toolCalls ?? 0),
  };
};

const findTask = (state: StoredAiState, id: string): StoredTask | undefined =>
  state.tasks.find((t) => t.id === id);

const findActiveTask = (state: StoredAiState, vpsId: string): StoredTask | undefined =>
  state.tasks.find((t) => t.vpsId === vpsId && ACTIVE_STATES.has(t.state));

/** Invariant checks shared by both adapters (planning §7, §9):  */
const assertNoActiveTask = (state: StoredAiState, vpsId: string): void => {
  if (findActiveTask(state, vpsId)) {
    throw new AiPersistenceConflictError(
      "task_conflict",
      `vps ${vpsId} already has an active task`,
    );
  }
};

const assertEnqueueExpectation = (
  state: StoredAiState,
  expect: AiOutboxCommandExpect,
): void => {
  const task = findTask(state, expect.taskId);
  if (!task) {
    throw new AiPersistenceConflictError("stale_dispatch", `task ${expect.taskId} missing`);
  }
  if (task.revision !== expect.taskIdRevision) {
    throw new AiPersistenceConflictError(
      "stale_dispatch",
      `task ${expect.taskId} revision ${task.revision} != expected ${expect.taskIdRevision}`,
    );
  }
  const plan = task.plan;
  if (expect.autoAuthorized) {
    return;
  }
  if (!plan) {
    throw new AiPersistenceConflictError("stale_dispatch", `task ${expect.taskId} has no plan`);
  }
  if (expect.planDigest !== undefined && plan.planDigest !== expect.planDigest) {
    throw new AiPersistenceConflictError(
      "stale_dispatch",
      `plan digest mismatch for task ${expect.taskId}`,
    );
  }
  if (plan.status !== "approved" && plan.status !== "consumed") {
    throw new AiPersistenceConflictError(
      "stale_dispatch",
      `plan ${plan.planId} status ${plan.status} is not approved`,
    );
  }
};

const assertConversation = (
  state: StoredAiState,
  vpsId: string,
  conversationId: string,
): AiConversation => {
  const conversation = state.conversations.find(
    (c) => c.id === conversationId && c.vpsId === vpsId,
  );
  if (!conversation) {
    throw new AiPersistenceConflictError(
      "conversation_conflict",
      `conversation ${conversationId} not found on vps ${vpsId}`,
    );
  }
  return conversation;
};

const assertEveryCommand = (
  state: StoredAiState,
  commands: { entry: AiOutboxEntry; expect: AiOutboxCommandExpect }[],
): void => {
  const seen = new Set<string>();
  for (const { entry, expect } of commands) {
    if (seen.has(entry.commandId)) {
      throw new AiPersistenceConflictError("receipt_conflict", `duplicate commandId ${entry.commandId}`);
    }
    seen.add(entry.commandId);
    if (expect.commandId !== undefined && expect.commandId !== entry.commandId) {
      throw new AiPersistenceConflictError(
        "stale_dispatch",
        `entry ${entry.id} exposes commandId ${entry.commandId}, expect ${expect.commandId}`,
      );
    }
    const existing = state.outbox.find((e) => e.commandId === entry.commandId);
    if (existing) {
      throw new AiPersistenceConflictError(
        "stale_dispatch",
        `commandId ${entry.commandId} already queued (entry ${existing.id})`,
      );
    }
  }
};

const receiptsConflict = (
  a: AiExecutionReceipt,
  b: AiExecutionReceipt,
): string | null => {
  if (a.taskId !== b.taskId) {
    return `taskId mismatch (${a.taskId} !== ${b.taskId})`;
  }
  if (a.vpsId !== b.vpsId) {
    return `vpsId mismatch (${a.vpsId} !== ${b.vpsId})`;
  }
  if (a.stepId !== b.stepId) {
    return `stepId mismatch (${a.stepId} !== ${b.stepId})`;
  }
  if (a.agentInstanceId !== b.agentInstanceId) {
    return `agentInstanceId mismatch (${a.agentInstanceId} !== ${b.agentInstanceId})`;
  }
  if (a.planVersion !== b.planVersion) {
    return `planVersion mismatch (${a.planVersion} !== ${b.planVersion})`;
  }
  if (a.planDigest !== b.planDigest) {
    return `planDigest mismatch (${a.planDigest} !== ${b.planDigest})`;
  }
  if (a.payloadDigest !== b.payloadDigest) {
    return `payloadDigest mismatch (${a.payloadDigest} !== ${b.payloadDigest})`;
  }
  if (a.status !== b.status) {
    return `status mismatch (${a.status} !== ${b.status})`;
  }
  const aErrCode = a.error?.code ?? "";
  const bErrCode = b.error?.code ?? "";
  const aErrMsg = a.error?.message ?? "";
  const bErrMsg = b.error?.message ?? "";
  if (aErrCode !== bErrCode || aErrMsg !== bErrMsg) {
    return `error mismatch`;
  }
  if (!isDeepStrictEqual(a.result, b.result)) {
    return `result payload mismatch`;
  }
  return null;
};

const customizeIncomingReceipts = (
  state: StoredAiState,
  receipts: AiExecutionReceipt[],
): { created: AiExecutionReceipt[]; duplicates: AiExecutionReceipt[] } => {
  const existingMap = new Map<string, AiExecutionReceipt>(
    state.receipts.map((r) => [r.commandId, r]),
  );
  const batchMap = new Map<string, AiExecutionReceipt>();
  const created: AiExecutionReceipt[] = [];
  const duplicates: AiExecutionReceipt[] = [];

  for (const receipt of receipts) {
    const batchPrior = batchMap.get(receipt.commandId);
    if (batchPrior) {
      const conflict = receiptsConflict(batchPrior, receipt);
      if (conflict) {
        throw new AiPersistenceConflictError(
          "receipt_conflict",
          `conflicting receipt in batch for commandId ${receipt.commandId}: ${conflict}`,
        );
      }
      duplicates.push(receipt);
      continue;
    }
    batchMap.set(receipt.commandId, receipt);

    const existing = existingMap.get(receipt.commandId);
    if (existing) {
      const conflict = receiptsConflict(existing, receipt);
      if (conflict) {
        throw new AiPersistenceConflictError(
          "receipt_conflict",
          `conflicting receipt for commandId ${receipt.commandId}: ${conflict}`,
        );
      }
      duplicates.push(receipt);
    } else {
      created.push(receipt);
      existingMap.set(receipt.commandId, receipt);
    }
  }
  return { created, duplicates };
};


const planChanged = (
  state: StoredAiState,
  task: StoredTask,
  input: AiTaskTransitionInput,
): boolean => {
  if (input.plan === undefined || input.plan === task.plan) return false;
  const previous = task.plan;
  if (previous && previous.status !== "consumed" && previous.status !== "expired") {
    // Replacing a live plan requires the previous one never to have been
    // dispatched; once dispatched it must run to a receipt first.
    const dispatched = state.outbox.some(
      (entry) => entry.taskId === task.id && entry.command.planVersion === previous.planVersion,
    );
    if (dispatched) return true;
  }
  return false;
};

/** Active-slot fence: (a) a task staying/becoming active must be the only
 * active task for its VPS besides itself; (b) 'executing' requires a lease —
 * the caller either extends the existing one or supplies a fresh deadline. */
const assertActiveTransition = (
  state: StoredAiState,
  next: StoredTask,
  lease?: { ownerInstanceId: string; leaseSeconds: number } | null,
): void => {
  if (!ACTIVE_STATES.has(next.state)) return;
  if (next.state === "executing") {
    const leaseSeconds = lease?.leaseSeconds ?? 0;
    if (!lease || leaseSeconds <= 0) {
      throw new AiPersistenceConflictError(
        "task_conflict",
        `task ${next.id} entering 'executing' requires an owner lease`,
      );
    }
  }
  const otherActive = findActiveTask(state, next.vpsId);
  if (otherActive && otherActive.id !== next.id) {
    throw new AiPersistenceConflictError(
      "task_conflict",
      `vps ${next.vpsId} already holds an active task ${otherActive.id}`,
    );
  }
};

const sortedRecords = <T extends { updatedAt: string }>(records: T[]): T[] =>
  [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

const sortedReceipts = (receipts: (AiExecutionReceipt & { updatedAt: string })[]) =>
  sortedRecords(receipts).map(({ updatedAt: _updatedAt, ...receipt }) => receipt);

/** Durable conversation order is pure append order: the position of a
 *  message in state.messages. Every writer only ever push-appends and
 *  deletions filter in place, so array position is the durable insertion
 *  sequence in both the JSON document and the ai_state_journal jsonb row
 *  (jsonb preserves array element order). createdAt is deliberately NOT a
 *  sort key: a backdated append (createdAt earlier than existing messages)
 *  must land AFTER the committed checkpoint boundary in history order, not
 *  be silently swallowed into the covered prefix. */
const orderedConversationMessages = (
  state: StoredAiState,
  conversationId: string,
): (AiConversationMessage & { vpsId: string })[] =>
  state.messages.filter((message) => message.conversationId === conversationId);

/** Checkpoints array accessor that normalizes older state documents in place. */
const checkpointsOf = (state: StoredAiState): StoredAiCheckpoint[] =>
  (state.checkpoints ??= []);

const findCheckpoint = (
  state: StoredAiState,
  vpsId: string,
  conversationId: string,
): StoredAiCheckpoint | undefined =>
  checkpointsOf(state).find(
    (c) => c.conversationId === conversationId && c.vpsId === vpsId,
  );

/** Public task snapshot: the "compacting" operation flag must never be
 *  visible on a terminal task, even if stale state claims otherwise. */
const snapshotTask = (task: StoredTask): AiTask => {
  if (task.compacting === undefined || !isTerminalState(task.state)) {
    return task as AiTask;
  }
  const { compacting: _compacting, ...terminal } = task;
  return terminal as AiTask;
};


// ── Adapter-core: build the entire AiRepository surface over one abstract
//    serialized transaction. The JSON driver runs it under the file lock;
//    the Postgres driver inside BEGIN/COMMIT against ai_state_journal.

type AiStateExecutor = <T>(
  mutate: (state: StoredAiState) => T,
) => Promise<T>;


export function createAiRepositoryCore(exec: AiStateExecutor): AiRepository {
  return {
    async createConversation(vpsId, title, id, now) {
      const createdAt = isoNow(now);
      return exec((state) => {
        if (id && state.conversations.some((c) => c.id === id)) {
          throw new AiPersistenceConflictError(
            "conversation_conflict",
            `conversation ${id} already exists`,
          );
        }
        const conversation: AiConversation = {
          id: id ?? crypto.randomUUID(),
          vpsId,
          title,
          createdAt,
          updatedAt: createdAt,
        };
        state.conversations.push(conversation);
        return conversation;
      });
    },

    async getConversation(vpsId, conversationId) {
      const state = await exec((s) => s);
      return state.conversations.find(
        (c) => c.id === conversationId && c.vpsId === vpsId,
      );
    },

    async listConversations(vpsId, limit = 50) {
      const state = await exec((s) => s);
      return sortedRecords(
        state.conversations.filter((c) => c.vpsId === vpsId),
      ).slice(0, Math.max(limit, 0));
    },

    async deleteConversation(vpsId, conversationId) {
      const conversation = await exec((state) => {
        const index = state.conversations.findIndex(
          (c) => c.id === conversationId && c.vpsId === vpsId,
        );
        if (index === -1) return undefined;
        if (state.tasks.some((task) => task.conversationId === conversationId && ACTIVE_STATES.has(task.state))) {
          throw new AiPersistenceConflictError("conversation_conflict", "conversation has unresolved work");
        }
        const [removed] = state.conversations.splice(index, 1);
        state.messages = state.messages.filter(
          (m) => m.conversationId !== conversationId,
        );
        // Invariant 2: deleting a conversation removes its checkpoint too.
        state.checkpoints = checkpointsOf(state).filter(
          (c) => !(c.conversationId === conversationId && c.vpsId === vpsId),
        );
        // Chat deletion preserves all audit events, and appends a record of the deletion
        state.auditEvents.push({
          createdAt: new Date().toISOString(),
          event: {
            id: randomUUID(),
            actorSessionId: "system",
            vpsId,
            operationId: `delete_conversation_${conversationId}`,
            resultCode: "conversation_deleted",
            createdAt: new Date().toISOString(),
          },
        });
        return removed;
      });
      return conversation !== undefined;
    },

    async appendMessage(input) {
      const createdAt = isoNow(input.createdAt);
      return exec((state) => {
        assertConversation(state, input.vpsId, input.conversationId);
        if (state.messages.some((m) => m.id === input.id)) {
          throw new AiPersistenceConflictError(
            "conversation_conflict",
            `message ${input.id} already exists`,
          );
        }
        const message: AiConversationMessage = {
          id: input.id,
          conversationId: input.conversationId,
          taskId: input.taskId,
          role: input.role,
          content: input.content,
          evidence: input.evidence,
          restrictedSources: input.restrictedSources,
          providerId: input.providerId,
          model: input.model,
          createdAt,
        };
        state.messages.push({ ...message, vpsId: input.vpsId });
        const conversation = assertConversation(state, input.vpsId, input.conversationId);
        conversation.updatedAt = createdAt;
        return message;
      });
    },

    async listMessages(conversationId, limit = 200) {
      const state = await exec((s) => s);
      return state.messages
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-Math.max(limit, 0))
        .map(({ vpsId: _vpsId, ...message }) => message);
    },

    async listConversationHistory(conversationId, options) {
      const state = await exec((s) => s);
      const limit = Math.min(
        Math.max(options?.limit ?? AI_HISTORY_DEFAULT_PAGE, 0),
        AI_HISTORY_MAX_PAGE,
      );
      const offset = Math.max(options?.offset ?? 0, 0);
      const ordered = orderedConversationMessages(state, conversationId);
      const page = ordered.slice(offset, offset + limit);
      return {
        messages: page.map(({ vpsId: _vpsId, ...message }) => message),
        total: ordered.length,
        remaining: Math.max(0, ordered.length - offset - page.length),
      };
    },

    async getConversationCheckpoint(vpsId, conversationId) {
      const state = await exec((s) => s);
      const checkpoint = findCheckpoint(state, vpsId, conversationId);
      if (!checkpoint) return undefined;
      // "Latest valid": a checkpoint whose covered boundary no longer
      // resolves inside its own conversation is not usable context.
      const boundaryResolves = orderedConversationMessages(
        state,
        conversationId,
      ).some((m) => m.id === checkpoint.coveredMessageId);
      if (!boundaryResolves) return undefined;
      const { vpsId: _vpsId, ...valid } = checkpoint;
      return valid;
    },

    async saveConversationCheckpoint(input) {
      const now = isoNow(input.now);
      return exec((state) => {
        assertConversation(state, input.vpsId, input.conversationId);
        // Redact before storage, then validate the redacted result.
        const summary = redactString(input.summary).trim();
        if (summary.length === 0) {
          throw new AiPersistenceConflictError(
            "checkpoint_conflict",
            "checkpoint summary is empty",
          );
        }
        if (Buffer.byteLength(summary, "utf8") > AI_CHECKPOINT_SUMMARY_MAX_BYTES) {
          throw new AiPersistenceConflictError(
            "checkpoint_conflict",
            `checkpoint summary exceeds ${AI_CHECKPOINT_SUMMARY_MAX_BYTES} bytes`,
          );
        }
        const existing = findCheckpoint(state, input.vpsId, input.conversationId);
        const currentRevision = existing?.revision ?? 0;
        if (currentRevision !== input.expectedRevision) {
          throw new AiPersistenceConflictError(
            "checkpoint_conflict",
            `checkpoint revision ${currentRevision} != expected ${input.expectedRevision}`,
          );
        }
        const ordered = orderedConversationMessages(state, input.conversationId);
        const boundaryIndex = ordered.findIndex(
          (m) => m.id === input.coveredMessageId,
        );
        if (boundaryIndex === -1) {
          throw new AiPersistenceConflictError(
            "checkpoint_conflict",
            `covered boundary ${input.coveredMessageId} is not a message of conversation ${input.conversationId}`,
          );
        }
        if (existing) {
          const currentBoundaryIndex = ordered.findIndex(
            (m) => m.id === existing.coveredMessageId,
          );
          if (currentBoundaryIndex !== -1 && boundaryIndex < currentBoundaryIndex) {
            throw new AiPersistenceConflictError(
              "checkpoint_conflict",
              `covered boundary cannot rewind before ${existing.coveredMessageId}`,
            );
          }
        }
        const boundaryMessage = ordered[boundaryIndex]!;
        const checkpoint: StoredAiCheckpoint = {
          conversationId: input.conversationId,
          vpsId: input.vpsId,
          revision: currentRevision + 1,
          summary,
          coveredMessageId: boundaryMessage.id,
          coveredMessageCount: boundaryIndex + 1,
          coveredThrough: boundaryMessage.createdAt,
          summaryModel: input.summaryModel,
          restrictedSources: input.restrictedSources,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const rows = checkpointsOf(state);
        const index = rows.findIndex(
          (c) => c.conversationId === input.conversationId && c.vpsId === input.vpsId,
        );
        if (index === -1) rows.push(checkpoint);
        else rows[index] = checkpoint;
        const { vpsId: _vpsId, ...saved } = checkpoint;
        return saved;
      });
    },

    async createTask(input) {
      const createdAt = isoNow(input.createdAt);
      return exec((state) => {
        const replay = state.tasks.find(
          (t) =>
            t.vpsId === input.vpsId && t.idempotencyKey === input.idempotencyKey,
        );
        if (replay) return { task: replay as AiTask, replay: true };
        assertNoActiveTask(state, input.vpsId);
        assertConversation(state, input.vpsId, input.conversationId);
        const task: StoredTask = {
          id: input.id,
          conversationId: input.conversationId,
          vpsId: input.vpsId,
          state: input.state,
          revision: 1,
          providerId: input.providerId,
          model: input.model,
          requestSummary: input.requestSummary,
          plan: null,
          usage: defaultUsage(),
          createdAt,
          updatedAt: createdAt,
          expiresAt: input.expiresAt,
          idempotencyKey: input.idempotencyKey,
          initiatingSessionId: input.initiatingSessionId,
        };
        state.tasks.push(task);
        return { task: task as AiTask, replay: false };
      });
    },

    async getTask(vpsId, taskId) {
      const state = await exec((s) => s);
      const task = state.tasks.find((t) => t.id === taskId && t.vpsId === vpsId);
      return task ? snapshotTask(task) : undefined;
    },

    async getActiveTask(vpsId) {
      const state = await exec((s) => s);
      const task = findActiveTask(state, vpsId);
      return task ? (task as AiTask) : undefined;
    },

    async listTasks(vpsId, limit = 50) {
      const state = await exec((s) => s);
      return state.tasks
        .filter((t) => t.vpsId === vpsId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, Math.max(limit, 0))
        .map((task) => {
          const copy = { ...task } as Partial<StoredTask>;
          delete copy.idempotencyKey;
          delete copy.initiatingSessionId;
          if (isTerminalState(task.state)) delete copy.compacting;
          return copy as AiTask;
        });
    },

    async updateTask(input) {
      const now = isoNow(input.now);
      return exec((state) => {
        const task = findTask(state, input.id);
        if (!task) {
          throw new AiPersistenceConflictError("task_conflict", `task ${input.id} missing`);
        }
        if (task.revision !== input.expectedRevision) {
          throw new AiPersistenceConflictError(
            "task_conflict",
            `task ${input.id} revision ${task.revision} != expected ${input.expectedRevision}`,
          );
        }
        if (planChanged(state, task, input)) {
          throw new AiPersistenceConflictError(
            "task_conflict",
            `task ${input.id} plan replaced while previous plan still unconsumed`,
          );
        }
        const nextRevision = bumpRevision(task.revision);
        const next: StoredTask = {
          ...task,
          state: input.state ?? task.state,
          summary: input.summary ?? task.summary,
          clarificationPrompt:
            input.clarificationPrompt !== undefined
              ? input.clarificationPrompt
              : task.clarificationPrompt,
          plan: input.plan !== undefined ? input.plan : task.plan,
          usage: applyUsageDelta(task.usage, input.usageDelta),
          error: input.error !== undefined ? input.error ?? undefined : task.error,
          capabilityMetadata:
            input.capabilityMetadata !== undefined
              ? input.capabilityMetadata
              : task.capabilityMetadata,
          expiresAt: input.expiresAt !== undefined ? input.expiresAt ?? undefined : task.expiresAt,
          ownerInstanceId: input.ownerLease ? input.ownerLease.ownerInstanceId : task.ownerInstanceId,
          ownerLeaseExpiresAt: input.ownerLease
            ? new Date(Date.now() + input.ownerLease.leaseSeconds * 1000).toISOString()
            : task.ownerLeaseExpiresAt,
          // "Auto-compact" operation flag: tri-state input, but never carried
          // into a terminal state — summarization never outlives its task.
          compacting:
            input.compacting !== undefined
              ? input.compacting || undefined
              : task.compacting,
          revision: nextRevision,
          updatedAt: now,
        };
        if (isTerminalState(next.state)) delete next.compacting;
        assertActiveTransition(state, next, input.ownerLease);
        const index = state.tasks.findIndex((t) => t.id === input.id);
        state.tasks[index!] = next;
        return next as AiTask;
      });
    },

    async deleteTerminalTasksOlderThan(cutoffIso, keepStates = []) {
      return exec((state) => {
        const keep = new Set(keepStates);
        const cutoff = new Date(cutoffIso).getTime();
        const before = state.tasks.length;

        // Fences and receipts protection: tasks with active outbox commands or uncertain receipts must not be deleted
        const protectedTaskIds = new Set<string>();
        for (const outbox of state.outbox) {
          if (outbox.status === "pending" || outbox.status === "dispatched") {
            protectedTaskIds.add(outbox.taskId);
          }
        }
        for (const receipt of state.receipts) {
          if (receipt.status === "uncertain") {
            protectedTaskIds.add(receipt.taskId);
          }
        }

        const deletedIds = new Set<string>();
        state.tasks = state.tasks.filter((task) => {
          if (!isTerminalState(task.state) || keep.has(task.state) || protectedTaskIds.has(task.id)) {
            return true;
          }
          if (new Date(task.updatedAt).getTime() < cutoff) {
            deletedIds.add(task.id);
            return false;
          }
          return true;
        });

        if (deletedIds.size > 0) {
          state.outbox = state.outbox.filter(
            (o) => !deletedIds.has(o.taskId) || (o.status !== "acknowledged" && o.status !== "failed"),
          );
          state.receipts = state.receipts.filter(
            (r) => !deletedIds.has(r.taskId) || r.status === "uncertain",
          );
          state.blobs = state.blobs.filter((b) => !deletedIds.has(b.taskId));
        }

        return before - state.tasks.length;
      });
    },

    async approve(input) {
      const now = isoNow(input.now);
      return exec((state) => {
        const task = findTask(state, input.taskId);
        if (!task) {
          throw new AiPersistenceConflictError("approval_conflict", `task ${input.taskId} missing`);
        }
        const plan = task.plan;
        if (!plan) {
          throw new AiPersistenceConflictError("approval_conflict", `task ${input.taskId} has no plan`);
        }
        if (plan.planVersion !== input.planVersion || plan.planDigest !== input.planDigest) {
          throw new AiPersistenceConflictError(
            "approval_conflict",
            `plan (version ${input.planVersion}, digest ${input.planDigest}) does not match stored plan`,
          );
        }
        if (plan.status === "consumed") {
          throw new AiPersistenceConflictError(
            "approval_conflict",
            `plan ${plan.planId} already consumed by session ${plan.approvedSessionId ?? "unknown"}`,
          );
        }
        if (plan.status !== "approved" && plan.status !== "pending") {
          throw new AiPersistenceConflictError(
            "approval_conflict",
            `plan ${plan.planId} status ${plan.status}; only pending or approved plans can be consumed`,
          );
        }
        const next: StoredTask = {
          ...task,
          plan: {
            ...plan,
            status: "consumed",
            approvedAt: plan.approvedAt ?? now,
            consumedAt: now,
            approvedSessionId: input.approvedSessionId,
          },
          revision: bumpRevision(task.revision),
          updatedAt: now,
        };
        const index = state.tasks.findIndex((t) => t.id === input.taskId);
        state.tasks[index!] = next;
        return next.plan!;
      });
    },

    async enqueueCommands(entries) {
      await exec((state) => {
        for (const { entry, expect } of entries) {
          assertEnqueueExpectation(state, expect);
        }
        assertEveryCommand(state, entries);
        for (const { entry } of entries) {
          state.outbox.push(entry);
        }
        return entries.length;
      });
    },

    async claimCommands(agentInstanceId, vpsId, limit, now) {
      const at = isoNow(now);
      return exec((state) => {
        const commands: AiHostCommand[] = [];
        const max = Math.max(0, limit);
        if (max === 0) return commands;

        const pending = state.outbox
          .filter(
            (entry) =>
              entry.vpsId === vpsId &&
              entry.status === "pending" &&
              entry.agentInstanceId === agentInstanceId &&
              entry.command.agentInstanceId === agentInstanceId,
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        for (const entry of pending) {
          const task = findTask(state, entry.taskId);
          const isAutoAuthorizedRead =
            entry.command.planVersion === 0 &&
            !!task &&
            (task.state === "planning" || task.state === "awaiting_input");
          if (!task) {
            continue;
          }
          if (!isAutoAuthorizedRead && task.state !== "executing") {
            continue;
          }
          const plan = task.plan;
          if (plan) {
            if (plan.status !== "consumed" && !isAutoAuthorizedRead) {
              continue;
            }
            if (
              plan.planVersion !== entry.command.planVersion ||
              plan.planDigest !== entry.command.planDigest
            ) {
              continue;
            }
          } else if (!isAutoAuthorizedRead) {
            continue;
          }
          if (
            entry.command.deadlineAt &&
            new Date(entry.command.deadlineAt).getTime() <= new Date(at).getTime()
          ) {
            continue;
          }
          if (
            task.ownerLeaseExpiresAt &&
            new Date(task.ownerLeaseExpiresAt).getTime() <= new Date(at).getTime()
          ) {
            continue;
          }

          entry.status = "dispatched";
          entry.dispatchedAt = at;
          commands.push(entry.command);

          if (commands.length >= max) {
            break;
          }
        }

        return commands;
      });
    },

    async markCommandDispatched(commandId, now) {
      const at = isoNow(now);
      return exec((state) => {
        const entry = state.outbox.find((e) => e.commandId === commandId);
        if (!entry || entry.status !== "pending") return false;
        entry.status = "dispatched";
        entry.dispatchedAt = at;
        return true;
      });
    },

    async markCommandAcknowledged(commandId, agentInstanceId, now) {
      const at = isoNow(now);
      return exec((state) => {
        const entry = state.outbox.find((e) => e.commandId === commandId);
        if (
          !entry ||
          (entry.status !== "dispatched" && entry.status !== "pending") ||
          (entry.agentInstanceId && entry.agentInstanceId !== agentInstanceId)
        ) {
          return false;
        }
        entry.status = "acknowledged";
        entry.acknowledgedAt = at;
        if (!entry.agentInstanceId) entry.agentInstanceId = agentInstanceId;
        return true;
      });
    },

    async replayPendingCommands(vpsId, limit = 100) {
      const state = await exec((s) => s);
      return state.outbox
        .filter((entry) => entry.vpsId === vpsId && entry.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, Math.max(limit, 0));
    },

    async recordReceipts(receipts) {
      return exec((state) => {
        const { created } = customizeIncomingReceipts(state, receipts);
        const at = isoNow();
        for (const receipt of created) {
          state.receipts.push({ ...receipt, updatedAt: at });
        }
        return { created: created.length };
      });
    },

    async listReceiptsByTask(taskId, limit = 100) {
      const state = await exec((s) => s);
      return sortedReceipts(
        state.receipts.filter((r) => r.taskId === taskId),
      ).slice(0, Math.max(limit, 0));
    },

    async saveExecutionBlob(blob) {
      await exec((state) => {
        if (state.blobs.some((b) => b.id === blob.id)) {
          throw new AiPersistenceConflictError("task_conflict", `execution blob ${blob.id} exists`);
        }
        state.blobs.push(blob);
        return true;
      });
    },

    async getExecutionBlob(id) {
      const state = await exec((s) => s);
      return state.blobs.find((b) => b.id === id);
    },

    async deleteExecutionBlob(id) {
      const removed = await exec((state) => {
        const index = state.blobs.findIndex((b) => b.id === id);
        if (index === -1) return false;
        const blob = state.blobs[index]!;
        const task = state.tasks.find((t) => t.id === blob.taskId);
        if (task && (ACTIVE_STATES.has(task.state) || task.state === "uncertain")) {
          return false;
        }
        if (state.outbox.some((o) => o.taskId === blob.taskId && (o.status === "pending" || o.status === "dispatched"))) {
          return false;
        }
        if (state.receipts.some((r) => r.taskId === blob.taskId && r.status === "uncertain")) {
          return false;
        }
        state.blobs.splice(index, 1);
        return true;
      });
      return removed;
    },

    async deleteExpiredExecutionBlobs(nowIso) {
      return exec((state) => {
        const now = new Date(nowIso).getTime();
        const before = state.blobs.length;

        const neededTaskIds = new Set<string>();
        for (const task of state.tasks) {
          if (ACTIVE_STATES.has(task.state) || task.state === "uncertain") {
            neededTaskIds.add(task.id);
          }
        }
        for (const outbox of state.outbox) {
          if (outbox.status === "pending" || outbox.status === "dispatched") {
            neededTaskIds.add(outbox.taskId);
          }
        }
        for (const receipt of state.receipts) {
          if (receipt.status === "uncertain") {
            neededTaskIds.add(receipt.taskId);
          }
        }

        state.blobs = state.blobs.filter(
          (b) => neededTaskIds.has(b.taskId) || new Date(b.expiresAt).getTime() >= now,
        );
        return before - state.blobs.length;
      });
    },

    async getAiPolicy(vpsId) {
      const state = await exec((s) => s);
      return state.policies.find((p) => p.vpsId === vpsId) ?? defaultAiPolicy(vpsId);
    },

    async updateAiPolicy(input) {
      const now = isoNow(input.now);
      return exec((state) => {
        const existing = state.policies.find((p) => p.vpsId === input.vpsId);
        if (existing && input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
          throw new AiPersistenceConflictError(
            "policy_conflict",
            `vps ${input.vpsId} policy revision ${existing.revision} != expected ${input.expectedRevision}`,
          );
        }
        const base: AiPolicy = existing ?? defaultAiPolicy(input.vpsId);
        const next = refreshPolicy(base, input.patch, now);
        if (!existing) state.policies.push(next);
        else state.policies[state.policies.indexOf(existing)] = next;
        return next;
      });
    },

    async getAiCapability(vpsId) {
      const state = await exec((s) => s);
      return state.capabilities[vpsId];
    },

    async recordAiCapability(input) {
      const at = isoNow(input.now);
      const { now: _now, ...capability } = input;
      return exec((state) => {
        state.capabilities[capability.vpsId] = capability;
        return capability;
      });
    },

    async getSettings() {
      const state = await exec((s) => s);
      return state.settings;
    },

    async updateSettings(input) {
      const now = isoNow(input.now);
      return exec((state) => {
        const existing = state.settings;
        if (existing && input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
          throw new AiPersistenceConflictError(
            "settings_conflict",
            `settings revision ${existing.revision} != expected ${input.expectedRevision}`,
          );
        }
        const hasEncrypted = existing?.encryptedApiKey !== undefined;
        if (!hasEncrypted && input.apiKeyEnvelope === undefined && (input.patch.endpoint !== undefined || input.patch.model !== undefined)) {
          throw new AiPersistenceConflictError(
            "settings_conflict",
            "provider cannot be enabled without an API key envelope",
          );
        }
        const encryptedApiKey =
          input.apiKeyEnvelope !== undefined
            ? input.apiKeyEnvelope
            : existing?.encryptedApiKey;
        const next: AiProviderSettingsInternal = {
          endpoint: input.patch.endpoint ?? existing?.endpoint ?? "",
          model: input.patch.model ?? existing?.model ?? "",
          encryptedApiKey,
          allowPrivateEndpoint:
            input.patch.allowPrivateEndpoint ?? existing?.allowPrivateEndpoint,
          revision: existing ? bumpRevision(existing.revision) : 1,
          updatedAt: now,
        };
        state.settings = next;
        return next;
      });
    },

    async getProviderMigrationState(): Promise<AiProviderMigrationView> {
      const state = await exec((s) => s);
      return {
        legacy: state.settings,
        providers: [...(state.providers ?? [])],
        migratedAt: state.providersMigratedAt,
        lastSelection: state.lastSelection,
      };
    },

    async completeProviderMigration(profile, now) {
      const stamp = isoNow(now);
      return exec((state) => {
        state.providers ??= [];
        if (!state.providersMigratedAt) {
          if (state.providers.length === 0 && profile) {
            state.providers.push({ ...profile, isDefault: true, revision: 1, updatedAt: stamp });
          }
          state.providersMigratedAt = stamp;
        }
        return [...state.providers];
      });
    },

    async listProviderProfiles() {
      const state = await exec((s) => s);
      return [...(state.providers ?? [])];
    },

    async getProviderProfile(id) {
      const state = await exec((s) => s);
      return state.providers?.find((profile) => profile.id === id);
    },

    async createProviderProfile(input) {
      const now = isoNow(input.now);
      return exec((state) => {
        state.providers ??= [];
        if (!providerModelsValid(input.models)) {
          throw new AiPersistenceConflictError("provider_conflict", "models must be 1–100 unique names of 1–256 chars each");
        }
        const defaultModel = input.defaultModel ?? input.models[0]!;
        if (!input.models.includes(defaultModel)) {
          throw new AiPersistenceConflictError("provider_conflict", "defaultModel must be one of models");
        }
        const id = input.id ?? randomUUID();
        if (state.providers.some((profile) => profile.id === id)) {
          throw new AiPersistenceConflictError("provider_conflict", `provider ${id} already exists`);
        }
        // The first profile is always the default so a default always exists (Q8).
        const becomesDefault = input.isDefault || state.providers.length === 0;
        if (becomesDefault) for (const profile of state.providers) profile.isDefault = false;
        const profile: AiProviderProfileInternal = {
          id,
          name: input.name,
          endpoint: input.endpoint,
          models: [...input.models],
          defaultModel,
          enabled: input.enabled,
          isDefault: becomesDefault,
          encryptedApiKey: input.apiKeyEnvelope,
          allowPrivateEndpoint: input.allowPrivateEndpoint ?? false,
          revision: 1,
          updatedAt: now,
        };
        state.providers.push(profile);
        return profile;
      });
    },

    async updateProviderProfile(id, input) {
      const now = isoNow(input.now);
      return exec((state) => {
        const providers = (state.providers ??= []);
        const profile = providers.find((candidate) => candidate.id === id);
        if (!profile) {
          throw new AiPersistenceConflictError("provider_conflict", `provider ${id} missing`);
        }
        if (input.expectedRevision !== undefined && profile.revision !== input.expectedRevision) {
          throw new AiPersistenceConflictError(
            "provider_conflict",
            `provider ${id} revision ${profile.revision} != expected ${input.expectedRevision}`,
          );
        }
        if (!providerModelsValid(input.models)) {
          throw new AiPersistenceConflictError("provider_conflict", "models must be 1–100 unique names of 1–256 chars each");
        }
        const carriedDefault = profile.defaultModel && input.models.includes(profile.defaultModel) ? profile.defaultModel : undefined;
        const defaultModel = input.defaultModel ?? carriedDefault ?? input.models[0]!;
        if (!input.models.includes(defaultModel)) {
          throw new AiPersistenceConflictError("provider_conflict", "defaultModel must be one of models");
        }
        // Exactly-one-default invariant: dropping the default re-promotes the
        // first enabled peer (or first peer); a sole provider stays default.
        let defaultId: string | undefined = providers.find((candidate) => candidate.isDefault && candidate.id !== id)?.id;
        if (input.isDefault) defaultId = id;
        else if (!defaultId) defaultId = id;
        if (defaultId === id) for (const candidate of providers) candidate.isDefault = candidate.id === id;
        const next: AiProviderProfileInternal = {
          ...profile,
          name: input.name,
          endpoint: input.endpoint,
          models: [...input.models],
          defaultModel,
          enabled: input.enabled,
          isDefault: defaultId === id,
          encryptedApiKey: input.apiKeyEnvelope ?? profile.encryptedApiKey,
          allowPrivateEndpoint: input.allowPrivateEndpoint ?? profile.allowPrivateEndpoint ?? false,
          // Every successful update bumps the revision — scoped invalidation (Q9).
          revision: bumpRevision(profile.revision),
          updatedAt: now,
        };
        providers[providers.indexOf(profile)] = next;
        return next;
      });
    },

    async deleteProviderProfile(id) {
      return exec((state) => {
        const providers = state.providers ?? [];
        const index = providers.findIndex((profile) => profile.id === id);
        if (index === -1) return false;
        if (state.conversations.some((conversation) => conversation.selectedProviderId === id)) {
          throw new AiPersistenceConflictError("provider_conflict", "provider is still selected by a conversation");
        }
        if (state.tasks.some((task) => task.providerId === id && ACTIVE_STATES.has(task.state))) {
          throw new AiPersistenceConflictError("provider_conflict", "provider is referenced by an active task");
        }
        const [removed] = providers.splice(index, 1);
        if (removed.isDefault && providers.length > 0) {
          (providers.find((profile) => profile.enabled) ?? providers[0]!).isDefault = true;
        }
        if (state.lastSelection?.providerId === id) delete state.lastSelection;
        return true;
      });
    },

    async setLastSelection(selection) {
      await exec((state) => {
        state.lastSelection = { ...selection };
        return true;
      });
    },

    async setConversationProviderSelection(vpsId, conversationId, selection) {
      return exec((state) => {
        const conversation = assertConversation(state, vpsId, conversationId);
        conversation.selectedProviderId = selection.providerId;
        conversation.selectedModel = selection.model;
        conversation.updatedAt = new Date().toISOString();
        return conversation;
      });
    },

    async appendAuditEvent(event) {
      await exec((state) => {
        state.auditEvents.push({ createdAt: isoNow(), event });
        state.auditEvents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return true;
      });
    },

    async listAuditEvents(filter) {
      const state = await exec((s) => s);
      return state.auditEvents
        .filter((row) => matchesAuditFilter(row.event, filter))
        .slice(0, Math.max(filter?.limit ?? 100, 0))
        .map((row) => row.event);
    },
  };
};


export function createJsonAiRepository(filePath: string): AiRepository {
  return createAiRepositoryCore(async (mutate) => withFileLock(filePath, async () => {
    const state = await readJsonFile(filePath, emptyAiState());
    const result = mutate(state);
    await writeJsonFile(filePath, state);
    return structuredClone(result);
  }));
}

export function createPostgresAiRepository(pool: Pool): AiRepository {
  return createAiRepositoryCore((mutate) => withPostgresAiState(pool, mutate));
}

async function withPostgresAiState<T>(pool: Pool, mutate: (state: StoredAiState) => T | Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO ai_state_journal (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
        [JSON.stringify(emptyAiState())],
      );
      const res = await client.query<{ state: StoredAiState | string }>(
        "SELECT state FROM ai_state_journal WHERE id = 1 FOR UPDATE",
      );
      const rawState = res.rows[0]?.state;
      const loaded: Partial<StoredAiState> =
        typeof rawState === "string"
          ? JSON.parse(rawState)
          : (rawState ?? {});
      const state: StoredAiState = {
        ...emptyAiState(),
        ...loaded,
      };
      const result = await mutate(state);
      await client.query(
        "UPDATE ai_state_journal SET state = $1::jsonb, updated_at = NOW() WHERE id = 1",
        [JSON.stringify(state)],
      );
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
}

export async function withAiAdminLock<T>(
  config: import("../../config/app-config.js").AppConfig,
  action: (admin: {
    hasEncryptedFields(): Promise<boolean>;
    rotateEncryptedFields(options?: { dryRun?: boolean }): Promise<{ rewrapped: number; kekIds: string[]; refusedTaskIds: string[]; conflictCode?: string }>;
  }) => Promise<T>,
): Promise<T> {
  const administer = async (state: StoredAiState) => {
    return action({
      async hasEncryptedFields() { return Boolean(state.settings?.encryptedApiKey || (state.providers ?? []).some((profile) => profile.encryptedApiKey) || state.blobs.length); },
      async rotateEncryptedFields(options) {
        const refusedTaskIds = state.tasks.filter((task) => ACTIVE_STATES.has(task.state)).map((task) => task.id);
        const envelopeAads = [
          ...(state.settings?.encryptedApiKey
            ? [{ envelope: state.settings.encryptedApiKey, aad: { vpsId: "global", taskId: "provider", field: "providerApiKey", version: 1 } as const }]
            : []),
          ...(state.providers ?? [])
            .filter((profile) => profile.encryptedApiKey)
            .map((profile) => ({ envelope: profile.encryptedApiKey!, aad: aiProviderKeyAad(profile.id) })),
          ...state.blobs.map((blob) => {
            const task = state.tasks.find((t) => t.id === blob.taskId);
            return { envelope: blob.encryptedPayload, aad: { vpsId: task?.vpsId ?? "global", taskId: blob.taskId, field: "executionPayload", version: 1 } as const };
          }),
        ];
        const result = { rewrapped: envelopeAads.length, kekIds: [...new Set(envelopeAads.map((entry) => entry.envelope.kekId))], refusedTaskIds };
        if (refusedTaskIds.length) return result;

        if (envelopeAads.length > 0) {
          const keyring = await loadAiKeyring(config.ai.keyringFile);
          const rewrappedEnvelopes = envelopeAads.map((entry) => rewrapAiEnvelope(entry.envelope, entry.aad, keyring));
          if (!options?.dryRun) {
            if (state.settings?.encryptedApiKey) state.settings.encryptedApiKey = rewrappedEnvelopes[0]!;
            let providerIndex = state.settings?.encryptedApiKey ? 1 : 0;
            for (const profile of state.providers ?? []) {
              if (!profile.encryptedApiKey) continue;
              profile.encryptedApiKey = rewrappedEnvelopes[providerIndex]!;
              providerIndex++;
            }
            let blobIndex = providerIndex;
            for (const blob of state.blobs) {
              blob.encryptedPayload = rewrappedEnvelopes[blobIndex]!;
              blobIndex++;
            }
          }
        }

        return result;
      },
    });
  };
  if (config.storageDriver === "postgres") {
    const pool = createDatabasePool(config);
    try {
      return await withPostgresAiState(pool, administer);
    } finally {
      await pool.end();
    }
  }
  const filePath = join(config.dataDir, "ai.json");
  return withFileLock(filePath, async () => {
    const state = await readJsonFile(filePath, emptyAiState());
    const result = await administer(state);
    await writeJsonFile(filePath, state);
    return result;
  });
}
