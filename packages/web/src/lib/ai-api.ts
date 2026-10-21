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
export type AiPolicy = {
  vpsId: string;
  aiEnabled: boolean;
  readEnabled: boolean;
  dockerActionsEnabled: boolean;
  composeActionsEnabled: boolean;
  shellEnabled: boolean;
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
  createdAt: string;
};

export type AiConversationDetail = {
  conversation: AiConversation;
  messages: AiConversationMessage[];
};

export type CreateAiTaskRequest = {
  request: string;
  idempotencyKey: string;
  conversationId?: string;
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
): Promise<AiConversationDetail> {
  return request<AiConversationDetail>(
    `${vpsAiRoot(vpsId)}/conversations/${encodeURIComponent(conversationId)}`,
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

