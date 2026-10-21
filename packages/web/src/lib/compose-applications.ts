/**
 * Docker Compose applications API client (phase 2).
 *
 * Wire contract: local://compose-wire-contract.md (ComposeApi, rev 2).
 * Every dashboard route sits under `/api/vps/:id/docker/applications` with
 * the shared `{ data }` / `{ error }` envelope, session cookie + OriginGuard.
 * The adoption-preview endpoint returns tolerant string-or-object rows for
 * `differences`/`warnings`; `composeFinding` normalizes both.
 * Secrets and registry passwords are write-only: no response carries a
 * value this UI could echo, so no type below includes one.
 */

import { ApiError, request } from "./api";

// ── Wire DTOs ───────────────────────────────────────────────────────

export type ComposeApplicationMode =
  | "detected_readonly"
  | "external_control"
  | "managed"
  | "unmanaged";

export type ComposeServiceKind = "longlived" | "oneshot";

/** Inventory service replica observed from the agent's compose project. */
export type ComposeServiceReplica = {
  containerKey: string;
  state: string;
  health?: string;
};

export type ComposeObservedService = {
  service: string;
  kind: ComposeServiceKind;
  replicas: ComposeServiceReplica[];
  /** null when desired count is unknown (no verified plan). */
  desiredCount: number | null;
};

export type ComposeAppSummary = {
  appId: string;
  displayName: string;
  projectName: string;
  daemonEpoch?: string;
  agentInstanceId?: string;
  mode: ComposeApplicationMode;
  readinessSeconds?: number;
  observed: {
    services: ComposeObservedService[];
    updatedAt?: string;
  };
  inventoryFreshnessSeconds?: number;
  capabilityReason?: string;
};

export type ComposeCapability = {
  supported: boolean;
  reason?: string;
  gate?: { disabled: boolean; reason?: string };
  runtime: {
    dockerPresent: boolean;
    composeVersion?: string;
    composePath?: string;
  };
  agent: { lastSeenAt?: string; agentInstanceId?: string };
  inventory: { ageSeconds?: number; completeness: boolean; reason?: string };
  admission: { ready: boolean; reasons: string[] };
  demoDisabled: boolean;
};

/**
 * Strict normalized structural finding: the adoption-preview endpoint may
 * send a terse reasoning token or a structured row as a difference/warning;
 * `composeFinding` below normalizes both into this shape.
 */
export type ComposeUnsupportedField = {
  field: string;
  reason: string;
  paramPath: string[];
};

/** Tolerant wire form for adoption-preview rows; normalize with `composeFinding`. */
export type ComposeFindingLike = string | { field?: string; reason: string; paramPath?: string[] };

export type ComposeSecretMeta = {
  name: string;
  version: number;
  updatedAt: string;
};

export type ComposeRegistryCredential = {
  id: string;
  host: string;
  username: string;
  version: number;
  updatedAt: string;
};

export type ComposeRevisionMeta = {
  seq: number;
  createdAt: string;
  profiles: string[];
  oneShotServices: string[];
};

export type ComposeAppDetail = ComposeAppSummary & {
  /** Verified external source binding; null until source verify completes. */
  source?: {
    verified: boolean;
    path?: string;
    digest?: string;
    verifiedAt?: string;
    revisionSeq?: number;
  } | null;
  dependencies?: {
    service: string;
    dependsOn: string[];
    ready: boolean;
    reason?: string;
  }[];
  /** Latest admitted operation for this app. */
  operation?: ComposeOperation | null;
  latestRevisionSeq?: number;
  secrets: ComposeSecretMeta[];
  /** Per-service container links preserving the container route identity. */
  serviceContainers?: {
    service: string;
    containerKey: string;
    state?: string;
    running: boolean;
  }[];
};

/** Source verification is asynchronous: the endpoint enqueues an operation. */
export type ComposeSourceVerifyHandle = {
  operationId: string;
  status: string;
};


const composeMissingPath = "";
const composeFindingSeparator = ": ";

/** Normalizes a tolerant adoption-preview row into the strict shape. */
export function composeFinding(finding: ComposeFindingLike): ComposeUnsupportedField {
  if (typeof finding === "string") {
    const spot = finding.indexOf(composeFindingSeparator);
    const field = spot >= 0 ? finding.slice(0, spot) : composeMissingPath;
    const reason = spot >= 0 ? finding.slice(spot + composeFindingSeparator.length) : finding;
    return { field, reason, paramPath: field ? [field] : [] };
  }
  return {
    field: finding.field ?? composeMissingPath,
    reason: finding.reason,
    paramPath: finding.paramPath ?? [],
  };
}

/** Stable React key for a normalized finding row. */
export function composeFindingKey(finding: ComposeUnsupportedField): string {
  const path = finding.paramPath.join(".");
  return path || finding.field ? `${path || finding.field}|${finding.reason}` : finding.reason;
}

export type ComposePreviewResult = {
  digest: string;
  redactedModel: Record<string, unknown>;
  imageDigests: Record<string, string>;
  removedServiceIds: string[];
  observedFingerprint: string;
  /** Secret name → version sealed in this approval. */
  secretVersions: Record<string, number>;
  /** Credential id → version sealed in this approval. */
  credentialVersions?: Record<string, number>;
  revisionSeq: number;
  /** Selected one-shot executions approved with this digest. */
  oneShotJobs?: string[];
};

/** Preview row; its resolved model envelope is never exposed by the API. */
export type ComposePreview = {
  id: string;
  appId: string;
  vpsId: string;
  revisionSeq: number;
  status: "pending" | "claimed" | "ready" | "failed" | "confirmed" | "stale";
  generation: number;
  expiresAt?: string;
  createdAt: string;
  digest?: string;
  removedServices?: string[];
  request?: { registryCredentialIds?: string[] };
  result?: ComposePreviewResult;
};

/** Structured, bounded operation progress — never a percentage. */
export type ComposeProgressItem = {
  stage: "claim" | "preflight" | "pull" | "apply" | "observe";
  service?: string;
  status: "started" | "ok" | "failed" | "skipped" | "uncertain";
  reason?: string;
  at: string;
};

export type ComposeOperationStatus =
  | "prepared"
  | "claimed"
  | "preflighting"
  | "pulling"
  | "applying"
  | "observing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain";

export type ComposeOperation = {
  id: string;
  appId: string;
  vpsId: string;
  kind:
    | "deploy"
    | "resume"
    | "removed_service"
    | "runtime_prep"
    | "preview_prepare"
    | "verify_source"
    | "lifecycle_start"
    | "lifecycle_stop"
    | "lifecycle_restart"
    | "unmanage"
    | "recheck";
  status: ComposeOperationStatus;
  actor?: { kind: string; id?: string };
  previewId?: string;
  revisionSeq?: number;
  approvedDigest?: string;
  mutationStarted?: boolean;
  mutationStartedAt?: string;
  authorization?: { id: string; grantedAt: string } | null;
  progress?: { seq: number; items: ComposeProgressItem[]; at?: string };
  result?: {
    outcome?: string;
    installPerformed?: boolean;
    confirmedMode?: string;
    composeVersion?: string;
    unsupportedReason?: string;
    instructions?: string;
    error?: { message: string };
    serviceOutcomes?: { service: string; outcome: string; reason?: string }[];
    observedRuntime?: unknown;
  } | null;
  error?: { code?: string; message: string } | null;
  cancelReason?: string;
  createdAt: string;
  updatedAt?: string;
};

export type ComposeAdoptionPreview = {
  differences: ComposeFindingLike[];
  warnings: ComposeFindingLike[];
  runtimeReady: boolean;
  digest?: string;
};

export type ComposeAppCreatePayload =
  | {
      displayName: string;
      confirmation: { confirmed: true };
      idempotencyKey: string;
    }
  | {
      displayName: string;
      detectedProjectName: string;
      daemonEpoch: string;
      confirmation: { confirmed: true };
      idempotencyKey: string;
    };

function composeErrorPayload(error: unknown): {
  code?: string;
  unsupported?: ComposeFindingLike[];
} | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.payload as
    | { code?: string; unsupported?: ComposeFindingLike[] }
    | undefined;
}

export function composeErrorCode(error: unknown): string | undefined {
  return composeErrorPayload(error)?.code;
}

function composeIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

const composeConfirmation = { confirmed: true } as const;

function composePath(vpsId: string): string {
  return `/api/vps/${encodeURIComponent(vpsId)}/docker/applications`;
}

function appPath(vpsId: string, appId: string): string {
  return `${composePath(vpsId)}/${encodeURIComponent(appId)}`;
}

function opPath(vpsId: string, appId: string, opId: string): string {
  return `${appPath(vpsId, appId)}/operations/${encodeURIComponent(opId)}`;
}

// ── Capability & applications list ──────────────────────────────────

/** Compose endpoints return the shared `{ data }` response envelope. */
export function getVpsComposeCapability(vpsId: string, signal?: AbortSignal) {
  return request<ComposeCapability | null>(`${composePath(vpsId)}/capability`,
  { signal },);
}

export function listVpsComposeApplications(vpsId: string, cursor?: string) {
  return request<{ items: ComposeAppSummary[]; nextCursor?: string }>(composePath(vpsId) + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),);
}

export function getVpsComposeApplication(vpsId: string, appId: string) {
  return request<ComposeAppDetail>(appPath(vpsId, appId));
}

export function renameVpsComposeApplication(
  vpsId: string,
  appId: string,
  displayName: string,
) {
  return request<ComposeAppDetail>(appPath(vpsId, appId), {
    method: "PATCH",
    body: JSON.stringify({
      displayName,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  });
}

export function createVpsComposeApplication(
  vpsId: string,
  payload: ComposeAppCreatePayload,
) {
  return request<ComposeAppSummary>(composePath(vpsId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ── External source & adoption ──────────────────────────────────────

function requireSourcePath(sourcePath: string): string {
  const trimmed = sourcePath.trim();
  if (!trimmed || !trimmed.startsWith("/")) {
    throw new ApiError("Source path must be an absolute path.", {
      message: "Source path must be an absolute path.",
    });
  }
  return trimmed;
}

export function verifyComposeSource(
  vpsId: string,
  appId: string,
  payload: { sourcePath: string; oneShotServices?: string[] },
) {
  return request<ComposeSourceVerifyHandle>(`${appPath(vpsId, appId)}/source`,
  {
    method: "POST",
    body: JSON.stringify({
      sourcePath: requireSourcePath(payload.sourcePath),
      oneShotServices: payload.oneShotServices,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

export type ComposeAdoptionPreviewPayload = {
  sourcePath?: string;
  composeYaml?: string;
  variables?: Record<string, string>;
  profiles?: string[];
  oneShotServices?: string[];
  registryCredentialIds?: string[];
  secretValues?: Record<string, string>;
  secretNames?: string[];
};

export type ComposeAdoptPayload = ComposeAdoptionPreviewPayload & {
  displayName?: string;
  adoptionDigest?: string;
  approvedDifferences?: string[];
};

/** Differences between the verified source and the observed project; no state change. */
export function getComposeAdoptionPreview(
  vpsId: string,
  appId: string,
  body: ComposeAdoptionPreviewPayload = {},
) {
  return request<ComposeAdoptionPreview>(`${appPath(vpsId, appId)}/adoption-preview`,
  {
    method: "POST",
    body: JSON.stringify({
      ...body,
      preservesProject: true,
      sourcePath: body.sourcePath?.trim() || undefined,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

export function adoptComposeApplication(
  vpsId: string,
  appId: string,
  body: ComposeAdoptPayload,
) {
  return request<ComposeAppDetail>(`${appPath(vpsId, appId)}/adopt`, {
    method: "POST",
    body: JSON.stringify({
      ...body,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  });
}

export function updateComposeApplicationReadiness(
  vpsId: string,
  appId: string,
  readinessSeconds: number,
) {
  return request<ComposeAppDetail>(`${appPath(vpsId, appId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      readinessSeconds,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  });
}

export function optInComposeExternalControl(vpsId: string, appId: string) {
  return request<{ appId: string; mode: string }>(`${appPath(vpsId, appId)}/external-control`,
  {
    method: "POST",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

/** Error codes that mean the current preview/draft is stale but the draft itself is salvageable. */
export const COMPOSE_STALE_PREVIEW_ERROR_CODES = [
  "stale_preview",
  "preview_expired",
  "stale_revision",
  "drift_detected",
  "observed_state_changed",
] as const;

export function unmanageComposeApplication(vpsId: string, appId: string) {
  return request<{ mode: string }>(`${appPath(vpsId, appId)}/unmanage`, {
    method: "POST",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  });
}

// ── Revisions & editor flow ─────────────────────────────────────────

export function listComposeRevisions(
  vpsId: string,
  appId: string,
  params?: { limit?: number; cursor?: string },
) {
  const query = new URLSearchParams();
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.cursor) query.set("cursor", params.cursor);
  const encoded = query.toString();
  return request<{ items: ComposeRevisionMeta[]; nextCursor?: string }>(`${appPath(vpsId, appId)}/revisions${encoded ? `?${encoded}` : ""}`,);
}

export function createComposePreview(
  vpsId: string,
  appId: string,
  body: {
    composeYaml?: string;
    revisionSeq?: number;
    variables?: {
      nonSecretValues: Record<string, string>;
      secretNameToggles?: string[];
    };
    profiles?: string[];
    registryCredentialIds?: string[];
    oneShotServices?: string[];
  },
) {
  return request<{ previewId: string; status: string }>(`${appPath(vpsId, appId)}/preview`,
  {
    method: "POST",
    body: JSON.stringify({
      ...body,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

export function getComposePreview(
  vpsId: string,
  appId: string,
  previewId: string,
) {
  return request<ComposePreview>(`${appPath(vpsId, appId)}/previews/${encodeURIComponent(previewId)}`,);
}

export function confirmComposePreview(
  vpsId: string,
  appId: string,
  previewId: string,
  body: { approvedDigest: string; removedServiceIds: string[] },
) {
  return request<ComposeOperation>(`${appPath(vpsId, appId)}/previews/${encodeURIComponent(previewId)}/confirm`,
  {
    method: "POST",
    body: JSON.stringify({
      ...body,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

// ── Operations: history · cancel · recheck · lifecycle ──────────────

export function listComposeOperations(
  vpsId: string,
  appId: string,
  params?: { limit?: number; cursor?: string },
) {
  const query = new URLSearchParams();
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.cursor) query.set("cursor", params.cursor);
  const encoded = query.toString();
  return request<{ items: ComposeOperation[]; nextCursor?: string }>(`${appPath(vpsId, appId)}/operations${encoded ? `?${encoded}` : ""}`,);
}

export function listVpsComposeOperations(vpsId: string) {
  return request<{ items: ComposeOperation[]; nextCursor?: string }>(`${composePath(vpsId)}/operations`,);
}

export function getVpsComposeOperation(vpsId: string, operationId: string) {
  return request<ComposeOperation>(`${composePath(vpsId)}/operations/${encodeURIComponent(operationId)}`,);
}

/** Statuses whose operation may still start or is actively mutating the observed stack. */
export const COMPOSE_ACTIVE_OPERATION_STATUSES: Record<ComposeOperationStatus, boolean> = {
  prepared: true,
  claimed: true,
  preflighting: true,
  pulling: true,
  applying: true,
  observing: true,
  uncertain: true,
  succeeded: false,
  failed: false,
  cancelled: false,
};

export function composeOperationIsActive(status: ComposeOperationStatus): boolean {
  return COMPOSE_ACTIVE_OPERATION_STATUSES[status];
}

export function getComposeOperation(
  vpsId: string,
  appId: string,
  operationId: string,
) {
  return request<ComposeOperation>(opPath(vpsId, appId, operationId));
}

export function cancelComposeOperation(
  vpsId: string,
  appId: string,
  operationId: string,
) {
  return request<ComposeOperation>(`${opPath(vpsId, appId, operationId)}/cancel`,
  {
    method: "POST",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

export function recheckComposeOperation(
  vpsId: string,
  appId: string,
  operationId: string,
) {
  return request<{
    outcome: "resolved" | "still_uncertain";
    operation: ComposeOperation;
  }>(`${opPath(vpsId, appId, operationId)}/recheck`, {
    method: "POST",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  });
}

export type ComposeLifecycleAction = "start" | "stop" | "restart";

export function requestComposeLifecycle(
  vpsId: string,
  appId: string,
  action: ComposeLifecycleAction,
) {
  return request<ComposeOperation>(`${appPath(vpsId, appId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  });
}

export function requestComposeRuntimePreparation(vpsId: string) {
  return request<ComposeOperation>(`${composePath(vpsId)}/runtime-preparation`,
  {
    method: "POST",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      pluginRequired: true,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

// ── Secrets & registry credentials (write-only secret values) ───────

export function listComposeSecrets(vpsId: string, appId: string) {
  return request<ComposeSecretMeta[]>(`${appPath(vpsId, appId)}/secrets`,);
}

export function setComposeSecret(
  vpsId: string,
  appId: string,
  name: string,
  value: string,
) {
  return request<ComposeSecretMeta>(`${appPath(vpsId, appId)}/secrets/${encodeURIComponent(name)}`,
  {
    method: "POST",
    body: JSON.stringify({
      value,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

export function deleteComposeSecret(vpsId: string, appId: string, name: string) {
  return request<{ ok: boolean }>(`${appPath(vpsId, appId)}/secrets/${encodeURIComponent(name)}`,
  {
    method: "DELETE",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

export function listComposeRegistryCredentials(vpsId: string) {
  return request<ComposeRegistryCredential[]>(`${composePath(vpsId)}/registry-credentials`,);
}

export function setComposeRegistryCredential(
  vpsId: string,
  body: { credentialId?: string; host: string; username: string; password: string },
) {
  const base = `${composePath(vpsId)}/registry-credentials`;
  const path = body.credentialId
    ? `${base}/${encodeURIComponent(body.credentialId)}`
    : base;
  return request<ComposeRegistryCredential>(path, {
    method: body.credentialId ? "PATCH" : "POST",
    body: JSON.stringify({
      host: body.host,
      username: body.username,
      password: body.password,
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  });
}

export function deleteComposeRegistryCredential(
  vpsId: string,
  credentialId: string,
) {
  return request<{ ok: boolean }>(`${composePath(vpsId)}/registry-credentials/${encodeURIComponent(credentialId)}`,
  {
    method: "DELETE",
    body: JSON.stringify({
      confirmation: composeConfirmation,
      idempotencyKey: composeIdempotencyKey(),
    }),
  },);
}

export function vpsComposeModeLabel(mode: ComposeApplicationMode): string {
  switch (mode) {
    case "detected_readonly":
      return "Detected (read-only)";
    case "external_control":
      return "External stack control";
    case "managed":
      return "Managed";
    case "unmanaged":
      return "Unmanaged";
    default:
      return "Unknown mode";
  }
}


// ── Offline drafts & local cache ───────────────────────────────────

export type ComposeDraft = {
  yaml: string;
  variableText: string;
  profileText: string;
  credentialIds: string;
  oneShotServices: string[];
  secretNameToggles: string[];
  savedAt: string;
};

const DRAFT_PREFIX = "flexserver_compose_draft_";
const CACHE_PREFIX = "flexserver_compose_cache_";

export function loadComposeDraft(vpsId: string, appId: string): ComposeDraft | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(`${DRAFT_PREFIX}${vpsId}_${appId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ComposeDraft;
  } catch {
    return null;
  }
}

export function saveComposeDraft(
  vpsId: string,
  appId: string,
  draft: Omit<ComposeDraft, "savedAt">,
): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const payload: ComposeDraft = {
      ...draft,
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(`${DRAFT_PREFIX}${vpsId}_${appId}`, JSON.stringify(payload));
  } catch {
    // Ignore storage errors
  }
}

export function clearComposeDraft(vpsId: string, appId: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(`${DRAFT_PREFIX}${vpsId}_${appId}`);
  } catch {
    // Ignore
  }
}

export function saveCachedComposeDetail(
  vpsId: string,
  appId: string,
  detail: ComposeAppDetail,
  operations: ComposeOperation[],
): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(
      `${CACHE_PREFIX}${vpsId}_${appId}`,
      JSON.stringify({ detail, operations, cachedAt: new Date().toISOString() }),
    );
  } catch {
    // Ignore
  }
}

export function loadCachedComposeDetail(
  vpsId: string,
  appId: string,
): { detail: ComposeAppDetail; operations: ComposeOperation[]; cachedAt: string } | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(`${CACHE_PREFIX}${vpsId}_${appId}`);
    if (!raw) return null;
    return JSON.parse(raw) as { detail: ComposeAppDetail; operations: ComposeOperation[]; cachedAt: string };
  } catch {
    return null;
  }
}

/** Detects potential wildcard (0.0.0.0 or unrestricted) port exposure. */
export function detectWildcardPortBindings(
  yamlText: string,
  redactedModel?: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  if (yamlText) {
    const lines = yamlText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("-") &&
        (trimmed.includes("0.0.0.0:") ||
          /-\s*["']?\d+:\d+["']?/.test(trimmed) ||
          /-\s*["']?:\d+["']?/.test(trimmed))
      ) {
        const item = trimmed.replace(/^-\s*/, "").replace(/["']/g, "");
        warnings.push(`Port exposure ${item}: bound to wildcard 0.0.0.0 or all host interfaces.`);
      }
    }
  }
  if (redactedModel && typeof redactedModel === "object" && "services" in redactedModel) {
    const services = redactedModel.services as Record<string, { ports?: (string | { published?: number | string; host_ip?: string })[] }> | undefined;
    if (services && typeof services === "object") {
      for (const [svcName, svc] of Object.entries(services)) {
        if (svc && Array.isArray(svc.ports)) {
          for (const p of svc.ports) {
            if (typeof p === "string" && (p.includes("0.0.0.0:") || (!p.includes("127.0.0.1:") && p.includes(":")))) {
              const msg = `Service "${svcName}" publishes wildcard port "${p}"`;
              if (!warnings.includes(msg)) warnings.push(msg);
            } else if (typeof p === "object" && p !== null) {
              if (p.host_ip === "0.0.0.0" || (!p.host_ip && p.published)) {
                const msg = `Service "${svcName}" publishes port ${p.published} to wildcard interface`;
                if (!warnings.includes(msg)) warnings.push(msg);
              }
            }
          }
        }
      }
    }
  }
  return warnings;
}
