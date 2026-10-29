// ── AI Assistant transport (typed REST client) ─────────────────────────
//
// Matches canonical wire contract (local://ai-wire-contract.md) and
// API models (packages/api/src/ai/ai.models.ts).
// Reuses dashboard transport rules (`lib/api.ts`): credentials,
// `{ data }` unwrapping, ApiError propagation, no credentials in logs.

import { ApiError, request } from "./api";

// ── Models ────────────────────────────────────────────────────────────

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

export const AI_TASK_STATES: readonly AiTaskState[] = [
  "planning",
  "awaiting_input",
  "awaiting_approval",
  "executing",
  "verifying",
  "cancel_requested",
  "uncertain",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
];

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
export type AiPlanStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export type AiPlan = {
  planId: string;
  planVersion: number;
  taskId: string;
  vpsId: string;
  agentInstanceId?: string;
  providerRevision: number;
  policyRevision: number;
  capabilityRevision: number;
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

export type AiTask = {
  id: string;
  conversationId: string;
  vpsId: string;
  state: AiTaskState;
  // Transient operation flag: true only while the backend's summarization
  // (auto-compaction) provider call is in progress. Never inferred from
  // `state`; unset/false means no compaction is active.
  compacting?: boolean;
  revision: number;
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

export type UpdateAiSettings = {
  endpoint: string;
  model: string;
  apiKey?: string;
  allowPrivateEndpoint?: boolean;
};

/** How a provider profile authenticates (docs/ai-chatgpt-oauth-provider-plan.md). */
export type AiProviderAuthKind = "apiKey" | "chatgpt_oauth";

/** OAuth token lifecycle state; `relogin_required` fails closed (plan Q7). */
export type AiProviderTokenState = "connected" | "relogin_required";

/** One admin-managed provider profile (docs/ai-multi-provider-plan.md). */
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

export type ProviderProfileWrite = {
  name: string;
  /** Omitted for chatgpt_oauth profiles: the server fills the fixed Codex
   * endpoint. Required when authKind is "apiKey" (or defaulted). */
  endpoint?: string;
  apiKey?: string;
  allowPrivateEndpoint?: boolean;
  /** Only set on create (or left unset); the profile kind is fixed afterwards. */
  authKind?: AiProviderAuthKind;
  models: string[];
  defaultModel?: string;
  enabled?: boolean;
  isDefault?: boolean;
};

/** Result of the paste-back OAuth exchange (plan Q10 step c). */
export type AiProviderOauthExchangeResult = {
  profile: AiProviderProfile;
  expiresAt: string;
  lastRefreshedAt: string;
};

export type AiProviderSelection = {
  providerId: string;
  model: string;
};

export type AiProvidersResponse = {
  providers: AiProviderProfile[];
  lastSelection?: AiProviderSelection;
  migrated: boolean;
};
/**
 * Execution isolation for AI shell steps (execmode plan Q3). "sandbox" runs
 * inside the AI sandbox (cgroup v2 namespaces); "privileged" runs the root
 * broker directly on the host without confinement — gated server-side by a
 * one-time risk acknowledgment. Older records read as "sandbox".
 */
export type AiExecMode = "sandbox" | "privileged";

export type AiPolicy = {
  vpsId: string;
  aiEnabled: boolean;
  readEnabled: boolean;
  dockerActionsEnabled: boolean;
  composeActionsEnabled: boolean;
  shellEnabled: boolean;
  execMode: AiExecMode;
  /** One-time privileged risk acknowledgment; null until acknowledged.
   * Switching back to sandbox never clears it (plan Q4). */
  privilegedAcknowledgedAt: string | null;
  privilegedAcknowledgedBy: string | null;
  /** When true, mutating plans auto-execute on this VPS without manual approval. Default false. */
  autoApprove: boolean;
  fileReadScopes: string[];
  fileWriteScopes: string[];
  serviceProfileIds: string[];
  sendLogsToProvider: boolean;
  sendFilesToProvider: boolean;
  revision: number;
  updatedAt: string;
};

export type UpdateAiPolicy = {
  aiEnabled?: boolean;
  readEnabled?: boolean;
  dockerActionsEnabled?: boolean;
  composeActionsEnabled?: boolean;
  shellEnabled?: boolean;
  execMode?: AiExecMode;
  /** Required by the server when switching to "privileged" without a retained
   * acknowledgment; re-acking refreshes the stored who/when (plan Q4). */
  acknowledgePrivileged?: boolean;
  /** Per-VPS YOLO toggle: auto-approve mutating plans on generation. Default false. */
  autoApprove?: boolean;
  fileReadScopes?: string[];
  fileWriteScopes?: string[];
  serviceProfileIds?: string[];
  sendLogsToProvider?: boolean;
  sendFilesToProvider?: boolean;
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
  profiles: string[];
  rootfsDigest?: string;
};

export type AiConversation = {
  id: string;
  vpsId: string;
  title: string;
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
};

export type AiConversationMessage = {
  id: string;
  conversationId: string;
  taskId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  evidence?: AiConversationMessageEvidence[];
  /** Provenance label (`provider · model`) on assistant turns. */
  providerId?: string;
  model?: string;
  createdAt: string;
};

export type AiConversationDetail = {
  conversation: AiConversation;
  messages: AiConversationMessage[];
  total?: number;
  remaining?: number;
};

export type CreateAiTaskRequest = {
  request: string;
  idempotencyKey: string;
  conversationId?: string;
  /** Explicit model selection (Q16 tier 1); fails closed server-side when
   * the provider/model cannot be honored. */
  providerId?: string;
  model?: string;
};

export type TaskInputRequest = {
  input: string;
};

export type ApprovePlanRequest = {
  planVersion: number;
  planDigest: string;
};

export type AiTaskPreviewStep = {
  stepId: string;
  payload: Record<string, unknown>;
};

export type AiTaskPreview = {
  planVersion: number;
  planDigest: string;
  steps: AiTaskPreviewStep[];
};

// ── Error Codes ───────────────────────────────────────────────────────

export type AiErrorCode =
  | "ai_disabled"
  | "provider_unavailable"
  | "provider_rate_limit"
  | "provider_context_overflow"
  | "provider_response_truncated"
  | "provider_revision_changed"
  | "capability_unavailable"
  | "task_busy"
  | "policy_denied"
  | "protected_target"
  | "ambiguous_target"
  | "stale_plan"
  | "approval_expired"
  | "approval_replayed"
  | "target_changed"
  | "budget_exhausted"
  | "output_gap"
  | "uncertain_outcome"
  | "sandbox_unavailable"
  | "file_changed"
  | "profile_changed";

export function getAiErrorCode(error: unknown): string | null {
  if (error instanceof ApiError && typeof error.payload?.code === "string") {
    return error.payload.code;
  }
  return null;
}

export function getAiBusyTaskId(error: unknown): string | null {
  if (
    error instanceof ApiError &&
    error.payload?.code === "task_busy" &&
    typeof error.payload?.activeTaskId === "string"
  ) {
    return error.payload.activeTaskId;
  }
  return null;
}

// ── URL Helpers ───────────────────────────────────────────────────────

function vpsAiRoot(vpsId: string): string {
  return `/api/vps/${encodeURIComponent(vpsId)}/ai`;
}

// ── Global Provider Settings APIs ─────────────────────────────────────

export function getAiSettings(signal?: AbortSignal): Promise<AiProviderSettings> {
  return request<AiProviderSettings>("/api/ai/settings", { method: "GET", signal });
}

export function patchAiSettings(
  settings: UpdateAiSettings,
  signal?: AbortSignal,
): Promise<AiProviderSettings> {
  return request<AiProviderSettings>("/api/ai/settings", {
    method: "PATCH",
    body: JSON.stringify(settings),
    signal,
  });
}

export function checkAiProvider(signal?: AbortSignal): Promise<{ ok: true }> {
  return request<{ ok: true }>("/api/ai/provider/check", {
    method: "POST",
    signal,
  });
}

// ── Provider profiles (multi-provider) ────────────────────────────────

export function listAiProviders(signal?: AbortSignal): Promise<AiProvidersResponse> {
  return request<AiProvidersResponse>("/api/ai/providers", { method: "GET", signal });
}

export function createAiProvider(body: ProviderProfileWrite, signal?: AbortSignal): Promise<AiProviderProfile> {
  return request<AiProviderProfile>("/api/ai/providers", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

export function updateAiProvider(id: string, body: ProviderProfileWrite, signal?: AbortSignal): Promise<AiProviderProfile> {
  return request<AiProviderProfile>(`/api/ai/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    signal,
  });
}

export function deleteAiProvider(id: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/ai/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal,
  });
}

export function checkAiProviderProfile(id: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/ai/providers/${encodeURIComponent(id)}/check`, {
    method: "POST",
    signal,
  });
}

export function fetchAiProviderModels(id: string, signal?: AbortSignal): Promise<AiProviderProfile> {
  return request<AiProviderProfile>(`/api/ai/providers/${encodeURIComponent(id)}/models`, {
    method: "POST",
    signal,
  });
}

// ── Provider OAuth (ChatGPT/Codex paste-back login) ───────────────────

/** Builds the OpenAI authorize URL for a saved chatgpt_oauth profile; the
 * PKCE verifier/state stay server-side in memory (plan Q2/Q10). */
export function authorizeAiProviderOauth(
  id: string,
  signal?: AbortSignal,
): Promise<{ authorizeUrl: string }> {
  return request<{ authorizeUrl: string }>(
    `/api/ai/providers/${encodeURIComponent(id)}/oauth/authorize`,
    { method: "POST", signal },
  );
}

/** Exchanges the pasted callback URL (`localhost:1455/auth/callback?...`)
 * for the stored token envelope (plan Q10 step c). */
export function exchangeAiProviderOauth(
  id: string,
  callbackUrl: string,
  signal?: AbortSignal,
): Promise<AiProviderOauthExchangeResult> {
  return request<AiProviderOauthExchangeResult>(
    `/api/ai/providers/${encodeURIComponent(id)}/oauth/exchange`,
    {
      method: "POST",
      body: JSON.stringify({ callbackUrl }),
      signal,
    },
  );
}

// ── Per-VPS Policy & Capability APIs ──────────────────────────────────

export function getVpsAiPolicy(
  vpsId: string,
  signal?: AbortSignal,
): Promise<AiPolicy> {
  return request<AiPolicy>(`${vpsAiRoot(vpsId)}/policy`, {
    method: "GET",
    signal,
  });
}

export function patchVpsAiPolicy(
  vpsId: string,
  policy: UpdateAiPolicy,
  signal?: AbortSignal,
): Promise<AiPolicy> {
  return request<AiPolicy>(`${vpsAiRoot(vpsId)}/policy`, {
    method: "PATCH",
    body: JSON.stringify(policy),
    signal,
  });
}

export function getVpsAiCapability(
  vpsId: string,
  signal?: AbortSignal,
): Promise<AiCapability> {
  return request<AiCapability>(`${vpsAiRoot(vpsId)}/capability`, {
    method: "GET",
    signal,
  });
}

// ── AI bundle status ──────────────────────────────────────────────────

/** Job states reported by the bundle installer. */
export type AiBundleJobState = "pending" | "running" | "succeeded" | "failed";

export type AiBundleJob = {
  state: AiBundleJobState;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** Sandbox capability projection bundled with the AI bundle status. */
export type AiBundleCapability = {
  supported: boolean;
  reason?: string;
  agentVersion?: string;
  privilegedSupported: boolean;
};

/** GET /api/vps/:id/ai/bundle response: install state and capability diagnosis. */
export type AiBundleStatus = {
  /** False when this deployment ships no AI bundle artifacts. */
  available: boolean;
  /** Server-side degrade reason, present only when available=false. */
  reason?: string;
  bundleId: string | null;
  installed: boolean;
  lastInstalledBundleId: string | null;
  lastJob: AiBundleJob | null;
  capability: AiBundleCapability;
};

export function getAiBundle(
  vpsId: string,
  signal?: AbortSignal,
): Promise<AiBundleStatus> {
  return request<AiBundleStatus>(`${vpsAiRoot(vpsId)}/bundle`, {
    method: "GET",
    signal,
  });
}


// ── Tasks APIs ────────────────────────────────────────────────────────

export function listVpsAiTasks(
  vpsId: string,
  query?: { conversationId?: string },
  signal?: AbortSignal,
): Promise<AiTask[]> {
  const qs = query?.conversationId
    ? `?conversationId=${encodeURIComponent(query.conversationId)}`
    : "";
  return request<AiTask[]>(`${vpsAiRoot(vpsId)}/tasks${qs}`, {
    method: "GET",
    signal,
  });
}

export function createVpsAiTask(
  vpsId: string,
  body: CreateAiTaskRequest,
  signal?: AbortSignal,
): Promise<AiTask> {
  return request<AiTask>(`${vpsAiRoot(vpsId)}/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

export function getVpsAiTask(
  vpsId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<AiTask> {
  return request<AiTask>(
    `${vpsAiRoot(vpsId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET", signal },
  );
}
export function getVpsAiTaskPreview(
  vpsId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<AiTaskPreview> {
  return request<AiTaskPreview>(
    `${vpsAiRoot(vpsId)}/tasks/${encodeURIComponent(taskId)}/preview`,
    { method: "GET", signal },
  );
}


export function submitVpsAiTaskInput(
  vpsId: string,
  taskId: string,
  body: TaskInputRequest,
  signal?: AbortSignal,
): Promise<AiTask> {
  return request<AiTask>(
    `${vpsAiRoot(vpsId)}/tasks/${encodeURIComponent(taskId)}/input`,
    {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function approveVpsAiTask(
  vpsId: string,
  taskId: string,
  body: ApprovePlanRequest,
  signal?: AbortSignal,
): Promise<AiTask> {
  return request<AiTask>(
    `${vpsAiRoot(vpsId)}/tasks/${encodeURIComponent(taskId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function denyVpsAiTask(
  vpsId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<AiTask> {
  return request<AiTask>(
    `${vpsAiRoot(vpsId)}/tasks/${encodeURIComponent(taskId)}/deny`,
    {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    },
  );
}

export function cancelVpsAiTask(
  vpsId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<AiTask> {
  return request<AiTask>(
    `${vpsAiRoot(vpsId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    },
  );
}

export function reconcileVpsAiTask(
  vpsId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<AiTask> {
  return request<AiTask>(
    `${vpsAiRoot(vpsId)}/tasks/${encodeURIComponent(taskId)}/reconcile`,
    {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    },
  );
}

// ── Conversations APIs ────────────────────────────────────────────────

export function listVpsAiConversations(
  vpsId: string,
  signal?: AbortSignal,
): Promise<AiConversation[]> {
  return request<AiConversation[]>(`${vpsAiRoot(vpsId)}/conversations`, {
    method: "GET",
    signal,
  });
}

export function getVpsAiConversation(
  vpsId: string,
  conversationId: string,
  signal?: AbortSignal,
  offset = 0,
  limit = 200,
): Promise<AiConversationDetail> {
  return request<AiConversationDetail>(
    `${vpsAiRoot(vpsId)}/conversations/${encodeURIComponent(conversationId)}?offset=${offset}&limit=${limit}`,
    { method: "GET", signal },
  );
}

export function deleteVpsAiConversation(
  vpsId: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `${vpsAiRoot(vpsId)}/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE", signal },
  );
}

