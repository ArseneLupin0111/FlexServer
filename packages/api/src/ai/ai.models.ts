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
  initiatingSessionId?: string;
  ownerInstanceId?: string;
  ownerLeaseExpiresAt?: string;
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
  profilesDigest?: string;
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
