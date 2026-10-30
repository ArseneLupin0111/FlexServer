import type { AiEnvelopeData } from "./ai-crypto.js";

export type AiTaskState =
  | "planning"
  | "awaiting_input"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "cancel_requested"
  | "uncertain"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type AiPlanStep = {
  stepId: string;
  tool: string;
  version: number;
  args: Record<string, unknown>;
  resourceKeys: string[];
  inputDigests: Record<string, string>;
  description: string;
  timeoutSeconds: number;
  encryptedBlobId?: string;
};

export type AiPlanStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

/** Shell execution mode (docs/ai-agent-autoupdate-execmode-plan.md Q3):
 * "sandbox" confines via cgroup v2 + rootfs; "privileged" runs the root
 * broker op without confinement (plan + per-command approval still apply). */
export type AiExecMode = "sandbox" | "privileged";

export type AiPlan = {
  planId: string;
  planVersion: number;
  taskId: string;
  vpsId: string;
  agentInstanceId?: string;
  /** Provider whose revision approved this plan; covered by planDigest. */
  providerId?: string;
  providerRevision: number;
  policyRevision: number;
  capabilityRevision: number;
  /** Stamped from the ACTIVE POLICY at propose time (never the model call);
   * approve/dispatch re-checks policy.execMode against this → stale_plan. */
  execMode: AiExecMode;
  steps: AiPlanStep[];
  preconditions: { key: string; expectedValue: unknown }[];
  recoverySteps?: AiPlanStep[];
  planDigest: string;
  expiresAt: string;
  status: AiPlanStatus;
  approvedAt?: string;
  approvedSessionId?: string;
  consumedAt?: string;
};

export type AiTaskUsage = {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  rounds: number;
  toolCalls: number;
};

export type AiTaskError = {
  code: string;
  message: string;
  details?: unknown;
};

export type AiExecutionMode = "manual" | "yolo";

export type AiTaskLoopPhase =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "continuation_ready"
  | "completed";

export type AiCompletionKind =
  | "verified"
  | "unverified"
  | "blocked"
  | "cancelled"
  | "expired";

export type AiTaskCompletionOutcome = {
  kind: AiCompletionKind;
  reasonCode: string;
  message: string;
  evidenceReferences?: string[];
  completedAt: string;
};

export type AiTaskObservation = {
  id: string;
  turn: number;
  tool: string;
  source: "read_tool" | "host_receipt" | "docker_bridge";
  commandId?: string;
  stepId?: string;
  planVersion?: number;
  planDigest?: string;
  target?: string;
  status: "succeeded" | "failed" | "uncertain" | "cancelled";
  exitCode?: number;
  evidence?: AiConversationMessageEvidence[];
  restrictedSources?: AiRestrictedEvidenceSource[];
  outputPreview?: string;
  summary?: string;
  createdAt: string;
};

export type AiTaskJournalEntry = {
  journalId: string;
  turn: number;
  callId: string;
  tool: string;
  providerId?: string;
  providerRevision?: number;
  inputArgs?: Record<string, unknown>;
  status: "dispatched" | "completed" | "failed" | "cancelled";
  observationId?: string;
  commandId?: string;
  createdAt: string;
  completedAt?: string;
};

export type AiTaskLoopCounters = {
  providerCalls: number;
  readCalls: number;
  mutationPlans: number;
  verificationAttempts: number;
  toolCalls: number;
  noProgressStreak: number;
  noProgressFingerprint?: string;
  deadlineAt: string;
};

export type AiTaskLoopState = {
  contractVersion: "loop_v1";
  mode: AiExecutionMode;
  turn: number;
  phase: AiTaskLoopPhase;
  leaseToken: string;
  turnLeaseOwnerInstanceId?: string;
  turnLeaseExpiresAt?: string;
  continuationReady: boolean;
  pauseReason?: string;
  pinnedProviderId?: string;
  pinnedProviderRevision?: number;
  pinnedPolicyRevision?: number;
  pinnedCapabilityRevision?: number;
  counters: AiTaskLoopCounters;
  planHistory: AiPlan[];
  observations: AiTaskObservation[];
  journal: AiTaskJournalEntry[];
  completion?: AiTaskCompletionOutcome;
};

export type AiTask = {
  id: string;
  conversationId: string;
  vpsId: string;
  state: AiTaskState;
  revision: number;
  /** Task execution version: legacy missing/1 vs loop 2. */
  executionVersion?: 1 | 2;
  /** Stamped at admission from policy.executionMode for loop tasks */
  executionMode?: AiExecutionMode;
  /** Provider profile + model bound at admission; revision changes to this
   * profile (only) invalidate the task (docs/ai-multi-provider-plan.md Q9). */
  providerId?: string;
  model?: string;
  requestSummary: string;
  summary?: string;
  clarificationPrompt?: string;
  plan?: AiPlan | null;
  usage: AiTaskUsage;
  error?: AiTaskError;
  capabilityMetadata?: {
    protocolVersion: number;
    rootfsDigest?: string;
  };
  /** True only while a compaction summarization round is actually underway
   * (UI "Auto-compact" status); cleared on every terminal transition. */
  compacting?: boolean;
  initiatingSessionId?: string;
  ownerInstanceId?: string;
  ownerLeaseExpiresAt?: string;
  /** Structured loop state present when executionVersion === 2 */
  loop?: AiTaskLoopState;
  /** Terminal outcome of multi-turn verification / execution */
  completion?: AiTaskCompletionOutcome;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};

export type AiProviderSettings = {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  allowPrivateEndpoint?: boolean;
  revision: number;
  updatedAt: string;
};

export type AiProviderSettingsInternal = {
  endpoint: string;
  model: string;
  encryptedApiKey?: AiEnvelopeData;
  allowPrivateEndpoint?: boolean;
  revision: number;
  updatedAt: string;
};

/** Public projection of one provider profile: envelope material never leaves
 * the persistence layer (docs/ai-multi-provider-plan.md invariants). */
export type AiProviderAuthKind = "apiKey" | "chatgpt_oauth";

/** OAuth token lifecycle state; `relogin_required` fails closed (plan Q7). */
export type AiProviderTokenState = "connected" | "relogin_required";

export type AiProviderProfile = {
  id: string;
  name: string;
  endpoint: string;
  models: string[];
  defaultModel?: string;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  allowPrivateEndpoint: boolean;
  authKind: AiProviderAuthKind;
  tokenState?: AiProviderTokenState;
  revision: number;
  updatedAt: string;
};

export type AiProviderProfileInternal = {
  id: string;
  name: string;
  endpoint: string;
  models: string[];
  defaultModel?: string;
  enabled: boolean;
  isDefault: boolean;
  /** AAD { vpsId: "global", taskId: id, field: "providerApiKey", version: 1 }. */
  encryptedApiKey?: AiEnvelopeData;
  allowPrivateEndpoint?: boolean;
  authKind: AiProviderAuthKind;
  /** Codex OAuth tokens { accessToken, refreshToken, accountId, expiresAt,
   * lastRefreshedAt } under AAD field "codexOauthToken" (plan Q3). */
  encryptedOauth?: AiEnvelopeData;
  tokenState?: AiProviderTokenState;
  revision: number;
  updatedAt: string;
};

/** Admin's most recent chat selection (Q16 resolution tier 2). */
export type AiProviderSelection = { providerId: string; model: string };

export type AiPolicy = {
  vpsId: string;
  aiEnabled: boolean;
  readEnabled: boolean;
  dockerActionsEnabled: boolean;
  composeActionsEnabled: boolean;
  shellEnabled: boolean;
  /** Shell execution mode; defaults to "sandbox". Legacy persisted rows
   * without the field read as "sandbox" (fail-closed, execmode plan Q3). */
  execMode: AiExecMode;
  /** One-time privileged-risk acknowledgment (who/when). Retained forever —
   * switching back to sandbox never clears it, so re-enabling needs no new
   * ack. */
  privilegedAcknowledgedAt: string | null;
  privilegedAcknowledgedBy: string | null;
  executionMode: AiExecutionMode;
  yoloAcknowledgedAt: string | null;
  yoloAcknowledgedBy: string | null;
  fileReadScopes: string[];
  fileWriteScopes: string[];
  serviceProfileIds: string[];
  sendLogsToProvider: boolean;
  sendFilesToProvider: boolean;
  revision: number;
  updatedAt: string;
};

export type AiCapability = {
  vpsId: string;
  supported: boolean;
  reason?: string;
  freshness: string;
  agentVersion?: string;
  protocolVersion: number;
  cgroupV2Available: boolean;
  namespacesAvailable: boolean;
  seccompAvailable: boolean;
  /** Privileged (root broker, no confinement) availability probed by the
   * agent helper; fail-closed false for claims from older agents. */
  privilegedSupported: boolean;
  privilegedUnsupportedReason?: string;
  profiles: string[];
  rootfsDigest?: string;
  profilesDigest?: string;
};

// ── AI bundle install jobs (docs/ai-agent-autoupdate-execmode-plan.md) ──

export type AiBundleJobState = "pending" | "running" | "succeeded" | "failed";

/** Why the install started: a policy action or a bundle convergence tick. */
export type AiBundleJobTrigger = "deliberate" | "convergence";

/** Latest AI bundle install job for one VPS (one record per VPS; the record
 * survives job replacement so lastInstalledBundleId is durable). */
export type AiBundleJobRecord = {
  vpsId: string;
  jobId: string;
  state: AiBundleJobState;
  /** bundleId this job installs (sha256 over sorted {relativePath, sha256}). */
  bundleId: string;
  trigger: AiBundleJobTrigger;
  /** Redacted failure reason; null/undefined while pending/running/succeeded. */
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** BundleId of the most recent successful install on the VPS; carried
   * forward across job replacement. Convergence compares this against the
   * bundled bundleId (Q7). */
  lastInstalledBundleId?: string;
};

export type AiConversation = {
  id: string;
  vpsId: string;
  title: string;
  /** Provider/model pinned for this conversation (Q16 tier 1). */
  selectedProviderId?: string;
  selectedModel?: string;
  createdAt: string;
  updatedAt: string;
};

export type AiConversationMessageEvidence = {
  type: string;
  timestamp: string;
  title: string;
  data?: unknown;
  /** Structured provenance for bounded tool evidence (host the observation
   * came from, source kind, terminal status, and whether it was truncated). */
  host?: string;
  source?: string;
  status?: string;
  truncated?: boolean;
};

export type AiRestrictedEvidenceSource = "logs" | "files";

export type AiConversationMessage = {
  id: string;
  conversationId: string;
  taskId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  evidence?: AiConversationMessageEvidence[];
  restrictedSources?: AiRestrictedEvidenceSource[];
  /** Provenance for the `provider · model` label (assistant messages). */
  providerId?: string;
  model?: string;
  createdAt: string;
};

/** Redacted, additive compaction checkpoint for one conversation
 * (docs/ai-assistant-context-compaction-plan.md invariant 2). The covered
 * boundary is the LAST message id included in the summary; the uncompressed
 * tail is every durable message ordered AFTER it. */
export type AiConversationCheckpoint = {
  conversationId: string;
  /** 1-based, monotonic per conversation; CAS token for advance. */
  revision: number;
  /** Already redacted before storage; summaries chain additively. */
  summary: string;
  /** Exclusive boundary: last message id whose content the summary covers. */
  coveredMessageId: string;
  /** Number of durable messages covered through the boundary. */
  coveredMessageCount: number;
  /** createdAt of the boundary message; freshness/provenance marker. */
  coveredThrough: string;
  /** Model that produced the summary, for provenance across model switches. */
  summaryModel?: string;
  /** Sources whose data may be present in this summary; missing provenance is not safe to replay. */
  restrictedSources?: AiRestrictedEvidenceSource[];
  createdAt: string;
  updatedAt: string;
};

export type AiHostCommandKind =
  | "shell"
  | "file_read"
  | "file_apply"
  | "service_status"
  | "service_action"
  | "config_validate"
  | "config_apply"
  | "config_recover";

export type AiHostCommand = {
  version: 1;
  taskId: string;
  stepId: string;
  commandId: string;
  vpsId: string;
  agentInstanceId: string;
  planVersion: number;
  planDigest: string;
  policyRevision: number;
  deadlineAt: string;
  kind: AiHostCommandKind;
  payload: Record<string, unknown>;
};

export type AiHostCapabilitiesReport = {
  supported: boolean;
  unsupportedReason?: string;
  cgroupV2: boolean;
  namespaces: boolean;
  seccomp: boolean;
  /** Optional/additive (execmode plan): absent from older agents → the
   * persisted capability records privilegedSupported false (fail-closed). */
  privilegedSupported?: boolean;
  privilegedUnsupportedReason?: string;
  rootfsDigest: string;
  profilesDigest: string;
  profiles: string[];
  agentVersion?: string;
};

export type AiHostClaimRequest = {
  version: 1;
  agentInstanceId: string;
  capabilities?: AiHostCapabilitiesReport;
};

export type AiHostHeartbeatRequest = {
  version: 1;
  agentInstanceId: string;
  taskId: string;
  commandId: string;
  timestamp: string;
};

export type AiHostOutputRequest = {
  version: 1;
  agentInstanceId: string;
  taskId: string;
  commandId: string;
  streamId: string;
  sequence: number;
  chunk: string;
  isGap: boolean;
  isEnd: boolean;
};

export type AiHostResultRequest = {
  version: 1;
  agentInstanceId: string;
  taskId: string;
  stepId: string;
  commandId: string;
  planVersion: number;
  planDigest: string;
  status: "succeeded" | "failed" | "uncertain" | "cancelled";
  executed: boolean;
  exitCode?: number;
  errorCode?: string;
  errorMessage?: string;
  outputPreview?: string;
  payload?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

export type AiHostCancelStatusRequest = {
  version: 1;
  agentInstanceId: string;
  taskId: string;
  commandId: string;
  acknowledged: boolean;
  terminated: boolean;
};

export type AiAuditEvent = {
  id: string;
  actorSessionId: string;
  vpsId: string;
  taskId?: string;
  toolName?: string;
  digest?: string;
  operationId?: string;
  resultCode: string;
  createdAt: string;
};

export type AiOutboxEntry = {
  id: string;
  taskId: string;
  stepId: string;
  commandId: string;
  vpsId: string;
  agentInstanceId: string;
  command: AiHostCommand;
  status: "pending" | "dispatched" | "acknowledged" | "failed";
  createdAt: string;
  dispatchedAt?: string;
  acknowledgedAt?: string;
};

export type AiExecutionReceipt = {
  commandId: string;
  taskId: string;
  stepId: string;
  vpsId: string;
  agentInstanceId: string;
  planVersion: number;
  planDigest: string;
  payloadDigest: string;
  status: "succeeded" | "failed" | "uncertain" | "cancelled";
  result?: unknown;
  outputPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  error?: { code: string; message: string };
  createdAt: string;
};
export type AiExecutionBlob = {
  id: string;
  taskId: string;
  stepId: string;
  encryptedPayload: AiEnvelopeData;
  expiresAt: string;
  createdAt: string;
};
