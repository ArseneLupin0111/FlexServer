import { randomUUID } from "node:crypto";
import type { AiEnvelopeData } from "../../ai/ai-crypto.js";
import type {
  AiAuditEvent,
  AiCapability,
  AiConversation,
  AiConversationMessage,
  AiConversationMessageEvidence,
  AiExecutionBlob,
  AiExecutionReceipt,
  AiHostCommand,
  AiOutboxEntry,
  AiPlan,
  AiPolicy,
  AiProviderSettingsInternal,
  AiTask,
  AiTaskState,
  AiTaskUsage,
} from "../../ai/ai.models.js";
import type { AiTaskError } from "../../ai/ai.models.js";
export type { AiTaskState };

/** Error raised when a CAS/admission/identity invariant fails. */
export type AiPersistenceConflictCode =
  | "task_conflict"
  | "conversation_conflict"
  | "settings_conflict"
  | "policy_conflict"
  | "approval_conflict"
  | "stale_dispatch"
  | "receipt_conflict";

export class AiPersistenceConflictError extends Error {
  constructor(
    readonly code: AiPersistenceConflictCode,
    readonly detail?: string,
  ) {
    super(code + (detail ? `: ${detail}` : ""));
    this.name = "AiPersistenceConflictError";
  }
}

export type AiTaskCreateInput = {
  id: string;
  conversationId: string;
  vpsId: string;
  state: AiTaskState;
  /** Raw request text (bounded 32KiB by ai.schemas.ts); durable stored verbatim */
  requestSummary: string;
  idempotencyKey: string;
  initiatingSessionId: string;
  /** Active-slot lease at admission; JSON adapter uses absolute now derived from createdAt */
  expiresAt?: string;
  createdAt?: string;
};

export type AiTaskTransitionInput = {
  id: string;
  /** Current revision the caller observed; required — CAS to prevent lost update */
  expectedRevision: number;
  state?: AiTaskState;
  summary?: string;
  clarificationPrompt?: string;
  plan?: AiPlan | null;
  /** Deltas, added on top of existing counters */
  usageDelta?: Partial<AiTaskUsage>;
  /** Overwrites error field entirely when provided */
  error?: AiTaskError | null;
  capabilityMetadata?: AiTask["capabilityMetadata"];
  expiresAt?: string | null;
  /** Owner lease — required whenever state becomes/executes 'executing'; extends existing lease otherwise */
  ownerLease?: { ownerInstanceId: string; leaseSeconds: number } | null;
  now?: string;
};

export type AiPlanApprovalInput = {
  taskId: string;
  planVersion: number;
  planDigest: string;
  /** consumed-at provenance; also used to reject replay (second approve) */
  approvedSessionId: string;
  now?: string;
};

export type AiConversationAppendMessageInput = {
  id: string;
  conversationId: string;
  vpsId: string;
  taskId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  evidence?: AiConversationMessageEvidence[];
  createdAt?: string;
};

export type AiCapabilityUpsertInput = AiCapability & { now?: string };

export type AiPolicyUpdateInput = {
  vpsId: string;
  patch: Partial<Omit<AiPolicy, "vpsId" | "revision" | "updatedAt">>;
  /** CAS; mismatches throw via AiPersistenceConflictError("policy_conflict") */
  expectedRevision?: number;
  now?: string;
};

export type AiSettingsUpdateInput = {
  patch: Partial<Omit<AiProviderSettingsInternal, "revision" | "updatedAt" | "encryptedApiKey">>;
  /** Replaces (not merges) the provider API key envelope when set */
  apiKeyEnvelope?: AiEnvelopeData;
  expectedRevision?: number;
  now?: string;
};

export type AiOutboxCommandExpect = {
  taskId: string;
  taskIdRevision: number;
  planDigest?: string;
  commandId?: string;
  /** Auto-authorized read (file_read/service_status) dispatched without a human plan. */
  autoAuthorized?: boolean;
};

/** Durable task/conversation/policy/outbox/receipt fence. Two adapters (JSON + PG),
 * same invariants:
 *  — one active task per VPS (state ∈ active set) enforced by UNIQUE partial index
 *    or JSON lock-protected scan;
 *  — (vpsId, idempotencyKey) unique; duplicate admits the stored task unchanged;
 *  — approve consumed exactly once, keyed by (planVersion, planDigest), CAS on plan row;
 *  — enqueue CAS checks task revision and plan digest in one transaction before
 *    marking the outbox entry pending (dispatch-relevant);
 *  — receipts idempotent by commandId (duplicate returns created=false);
 *  — revision bump on every task update. */
export interface AiRepository {
  // ─── conversations / messages ───────────────────────────────
  createConversation(vpsId: string, title: string, id?: string, now?: string): Promise<AiConversation>;
  getConversation(vpsId: string, conversationId: string): Promise<AiConversation | undefined>;
  listConversations(vpsId: string, limit?: number): Promise<AiConversation[]>;
  deleteConversation(vpsId: string, conversationId: string): Promise<boolean>;
  appendMessage(input: AiConversationAppendMessageInput): Promise<AiConversationMessage>;
  listMessages(conversationId: string, limit?: number): Promise<AiConversationMessage[]>;

  // ─── tasks / admission ──────────────────────────────────────────
  createTask(input: AiTaskCreateInput): Promise<{ task: AiTask; replay: boolean }>;
  getTask(vpsId: string, taskId: string): Promise<AiTask | undefined>;
  getActiveTask(vpsId: string): Promise<AiTask | undefined>;
  listTasks(vpsId: string, limit?: number): Promise<AiTask[]>;
  /** Strict revision CAS; conflict throws AiPersistenceConflictError("task_conflict") */
  updateTask(input: AiTaskTransitionInput): Promise<AiTask>;
  /** Retention — deletes terminal tasks older than cutoff that are NOT in keepStates */
  deleteTerminalTasksOlderThan(cutoffIso: string, keepStates?: AiTaskState[]): Promise<number>;

  // ─── approval (CAS) ─────────────────────────────────────────────
  approve(taskReplayPlan: AiPlanApprovalInput): Promise<AiPlan>;

  // ─── outbox (durable delivery) ───────────────────────────────────
  enqueueCommands(entries: { entry: AiOutboxEntry; expect: AiOutboxCommandExpect }[]): Promise<void>;
  claimCommands(agentInstanceId: string, vpsId: string, limit: number, now?: string): Promise<AiHostCommand[]>;
  markCommandDispatched(commandId: string, now?: string): Promise<boolean>;
  markCommandAcknowledged(commandId: string, agentInstanceId: string, now?: string): Promise<boolean>;
  replayPendingCommands(vpsId: string, limit?: number): Promise<AiOutboxEntry[]>;

  // ─── receipts (idempotent execution records) ─────────────────────
  recordReceipts(receipts: AiExecutionReceipt[]): Promise<{ created: number }>;
  listReceiptsByTask(taskId: string, limit?: number): Promise<AiExecutionReceipt[]>;

  // ─── encrypted execution blobs ──────────────────────────────────
  saveExecutionBlob(blob: AiExecutionBlob): Promise<void>;
  getExecutionBlob(id: string): Promise<AiExecutionBlob | undefined>;
  deleteExecutionBlob(id: string): Promise<boolean>;
  deleteExpiredExecutionBlobs(nowIso: string): Promise<number>;

  // ─── policy / capability / settings / audit ─────────────────────
  getAiPolicy(vpsId: string): Promise<AiPolicy | undefined>;
  updateAiPolicy(input: AiPolicyUpdateInput): Promise<AiPolicy>;
  getAiCapability(vpsId: string): Promise<AiCapability | undefined>;
  recordAiCapability(input: AiCapabilityUpsertInput): Promise<AiCapability>;
  getSettings(): Promise<AiProviderSettingsInternal | undefined>;
  updateSettings(input: AiSettingsUpdateInput): Promise<AiProviderSettingsInternal>;
  appendAuditEvent(event: AiAuditEvent): Promise<void>;
  listAuditEvents(filter?: { vpsId?: string; taskId?: string; limit?: number }): Promise<AiAuditEvent[]>;
}

export const AI_ACTIVE_TASK_STATES: readonly AiTaskState[] = [
  "planning",
  "awaiting_input",
  "awaiting_approval",
  "executing",
  "verifying",
  "cancel_requested",
  "uncertain",
];

/** Terminal set used for retention deletes; anything not active is terminal here */
export const AI_TERMINAL_TASK_STATES: readonly AiTaskState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
];

export function newAiId(): string {
  return randomUUID();
}
