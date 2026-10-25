import { randomUUID } from "node:crypto";
import type { AiEnvelopeData } from "../../ai/ai-crypto.js";
import type {
  AiAuditEvent,
  AiBundleJobRecord,
  AiBundleJobState,
  AiBundleJobTrigger,
  AiCapability,
  AiConversation,
  AiConversationCheckpoint,
  AiConversationMessage,
  AiConversationMessageEvidence,
  AiExecutionBlob,
  AiExecutionReceipt,
  AiHostCommand,
  AiOutboxEntry,
  AiPlan,
  AiPolicy,
  AiProviderAuthKind,
  AiProviderProfileInternal,
  AiProviderSelection,
  AiProviderSettingsInternal,
  AiProviderTokenState,
  AiRestrictedEvidenceSource,
  AiTask,
  AiTaskState,
  AiTaskUsage,
} from "../../ai/ai.models.js";
import type { AiTaskError } from "../../ai/ai.models.js";
export type { AiBundleJobRecord, AiBundleJobState, AiBundleJobTrigger };

/** Error raised when a CAS/admission/identity invariant fails. */
export type AiPersistenceConflictCode =
  | "task_conflict"
  | "conversation_conflict"
  | "checkpoint_conflict"
  | "settings_conflict"
  | "provider_conflict"
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
  /** Provider profile + model bound at admission (Q9/Q16). */
  providerId?: string;
  model?: string;
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
  /** True while a compaction summarization round is underway (UI "Auto-compact");
   *  undefined keeps the current flag, false clears it. Force-cleared on any
   *  transition to a terminal state. Never authorizes anything by itself. */
  compacting?: boolean;
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
  restrictedSources?: AiRestrictedEvidenceSource[];
  providerId?: string;
  model?: string;
  createdAt?: string;
};

/** Create/update write for one provider profile. Structural invariants
 * (unique models, defaultModel ∈ models, single default, exactly-one-key
 * semantics) are enforced by the repository core for both drivers. */
export type AiProviderProfileWriteInput = {
  name: string;
  endpoint: string;
  models: string[];
  defaultModel?: string;
  enabled: boolean;
  isDefault: boolean;
  allowPrivateEndpoint?: boolean;
  /** Immutable after creation; defaults to "apiKey". */
  authKind?: AiProviderAuthKind;
  /** Replaces the stored envelope when set; absent keeps the existing key. */
  apiKeyEnvelope?: AiEnvelopeData;
  expectedRevision?: number;
  now?: string;
};

/** OAuth token lifecycle write — deliberately revision-neutral so token
 * refresh never invalidates plans (docs/ai-chatgpt-oauth-provider-plan.md). */
export type AiProviderOauthUpdateInput = {
  envelope?: AiEnvelopeData;
  tokenState?: AiProviderTokenState;
  now?: string;
};

/** Snapshot consumed by the boot migration service and provider routes. */
export type AiProviderMigrationView = {
  legacy: AiProviderSettingsInternal | undefined;
  providers: AiProviderProfileInternal[];
  /** Set once migration has run; gates legacy PATCH rejection (Q14/Q15). */
  migratedAt: string | undefined;
  lastSelection: AiProviderSelection | undefined;
};

/** Atomic compare-and-advance of a conversation's compaction checkpoint
 *  (docs/ai-assistant-context-compaction-plan.md invariant 2/4).
 *  Summary is redacted before storage; empty/whitespace or >64KiB summaries
 *  are rejected; a CAS mismatch keeps the previous checkpoint intact. */
export type AiCheckpointAdvanceInput = {
  vpsId: string;
  conversationId: string;
  /** Chain summary covering everything through coveredMessageId. */
  summary: string;
  /** Exclusive covered boundary: LAST durable message id included in summary. */
  coveredMessageId: string;
  /** CAS — revision of the checkpoint this advance extends; 0 = expect none yet. */
  expectedRevision: number;
  /** Model that produced the summary (provenance across model switches). */
  summaryModel?: string;
  restrictedSources?: AiRestrictedEvidenceSource[];
  now?: string;
};

/** Bounded, lossless history page for one conversation (oldest -> newest). */
export type AiConversationHistoryPage = {
  messages: AiConversationMessage[];
  /** Total durable messages in the conversation. */
  total: number;
  /** Messages available after this page (total - offset - messages.length). */
  remaining: number;
};

export const AI_CHECKPOINT_SUMMARY_MAX_BYTES = 64 * 1024;
export const AI_HISTORY_DEFAULT_PAGE = 1000;
export const AI_HISTORY_MAX_PAGE = 10_000;

export type AiCapabilityUpsertInput = AiCapability & { now?: string };

/** AI bundle install job input types (execmode plan). All transitions are
 * atomic under the shared AI state lock so at most one pending/running job
 * exists per VPS in either driver. */
export type AiBundleJobStartInput = {
  vpsId: string;
  bundleId: string;
  trigger?: AiBundleJobTrigger;
  /** Explicit job id (tests / resumption); a fresh UUID otherwise. */
  jobId?: string;
  now?: string;
};

export type AiBundleJobFinishInput = {
  vpsId: string;
  jobId: string;
  outcome: AiBundleJobState & ("succeeded" | "failed");
  /** Raw error; redacted and bounded before storage. */
  error?: string;
  now?: string;
};

export type AiBundleJobStartResult = {
  job: AiBundleJobRecord;
  /** True when a fresh pending job was created; false when a pending/running
   * job already existed and was returned unchanged (idempotent scheduling). */
  created: boolean;
};

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
  /** Bounded, lossless paged history: all durable messages oldest->newest with
   *  total/remaining so no message is silently dropped by a per-call cap. */
  listConversationHistory(
    conversationId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<AiConversationHistoryPage>;

  // ─── compaction checkpoints ─────────────────────────────────────
  /** Latest valid checkpoint (undefined when absent, or when its covered
   *  boundary no longer resolves to a stored message of the conversation). */
  getConversationCheckpoint(
    vpsId: string,
    conversationId: string,
  ): Promise<AiConversationCheckpoint | undefined>;
  /** Atomic compare-and-advance. Verifies conversation isolation, expected
   *  revision (0 = first), boundary existence and monotonic order, redacts
   *  and bounds the summary, then commits revision+1. Conflicts throw
   *  AiPersistenceConflictError("checkpoint_conflict"); the previous
   *  checkpoint survives every failure. */
  saveConversationCheckpoint(
    input: AiCheckpointAdvanceInput,
  ): Promise<AiConversationCheckpoint>;

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

  // ─── AI bundle install jobs (execmode plan Q1/Q7/Q8) ────────────
  /** Latest job record for the VPS (undefined when none ever scheduled). */
  getAiBundleJob(vpsId: string): Promise<AiBundleJobRecord | undefined>;
  /** Atomically create a pending job unless a pending/running job already
   * exists for the VPS (then it is returned with created=false). A terminal
   * record is replaced, carrying lastInstalledBundleId forward. */
  startAiBundleJob(input: AiBundleJobStartInput): Promise<AiBundleJobStartResult>;
  /** pending -> running transition, CAS on jobId. */
  markAiBundleJobRunning(vpsId: string, jobId: string, now?: string): Promise<AiBundleJobRecord>;
  /** Terminal transition. On success lastInstalledBundleId is set to the
   * job's bundleId; on failure the error is redacted and bounded. CAS on
   * jobId; unknown/mismatched job ids throw AiPersistenceConflictError. */
  finishAiBundleJob(input: AiBundleJobFinishInput): Promise<AiBundleJobRecord>;

  getSettings(): Promise<AiProviderSettingsInternal | undefined>;
  updateSettings(input: AiSettingsUpdateInput): Promise<AiProviderSettingsInternal>;

  // ─── provider profiles (docs/ai-multi-provider-plan.md) ─────────
  getProviderMigrationState(): Promise<AiProviderMigrationView>;
  /** Idempotent boot migration completion: no-op when already migrated;
   *  otherwise inserts the converted legacy profile (first profile becomes
   *  the default) and stamps migratedAt. A profile is only inserted when
   *  none exist yet; the legacy settings slot is kept so an older build
   *  still runs after a rollback (Q15). */
  completeProviderMigration(profile?: AiProviderProfileInternal, now?: string): Promise<AiProviderProfileInternal[]>;
  listProviderProfiles(): Promise<AiProviderProfileInternal[]>;
  getProviderProfile(id: string): Promise<AiProviderProfileInternal | undefined>;
  createProviderProfile(input: AiProviderProfileWriteInput & { id?: string }): Promise<AiProviderProfileInternal>;
  /** CAS on expectedRevision; every successful update bumps the profile
   * revision, invalidating only that provider's tasks/plans (Q9). */
  updateProviderProfile(id: string, input: AiProviderProfileWriteInput): Promise<AiProviderProfileInternal>;
  /** Blocked with provider_conflict while any conversation selection or
   * non-terminal task references the profile (Q10). */
  deleteProviderProfile(id: string): Promise<boolean>;
  /** OAuth token lifecycle write: updates the token envelope/state WITHOUT
   * bumping the profile revision (token refresh must not invalidate plans). */
  updateProviderOauth(id: string, input: AiProviderOauthUpdateInput): Promise<AiProviderProfileInternal | undefined>;
  setLastSelection(selection: AiProviderSelection): Promise<void>;
  /** Pins the conversation's provider/model selection (Q16 tier 1). */
  setConversationProviderSelection(vpsId: string, conversationId: string, selection: AiProviderSelection): Promise<AiConversation>;
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
