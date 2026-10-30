// ── AiAssistantErrors: named, exported wire-surface error types (§8.2) ─
//
// Every AI runtime failure surfacing to HTTP or to the agent transport is a
// named class here, carrying a stable machine codesher together with
// optional structured detail for the exception filter. Never embed raw
// provider, SSH, or filesystem error strings into these errors.

/** Wire error codes — mirror web/src/lib/ai-api.ts AiErrorCode exactly. */
export type AiErrorCode =
  | "ai_disabled"
  | "provider_unavailable"
  | "provider_rate_limit"
  | "provider_context_overflow"
  | "provider_response_truncated"
  | "provider_protocol_error"
  | "provider_key_required"
  | "crypto_unavailable"
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
  | "no_progress"
  | "cancelled"
  | "sandbox_unavailable"
  | "file_changed"
  | "profile_changed";

const AI_HTTP_STATUS: Record<AiErrorCode, number> = {
  ai_disabled: 403,
  provider_unavailable: 502,
  provider_rate_limit: 429,
  provider_context_overflow: 413,
  provider_response_truncated: 502,
  provider_protocol_error: 502,
  provider_key_required: 503,
  crypto_unavailable: 503,
  provider_revision_changed: 409,
  capability_unavailable: 409,
  task_busy: 409,
  policy_denied: 403,
  protected_target: 403,
  ambiguous_target: 400,
  stale_plan: 409,
  approval_expired: 409,
  approval_replayed: 409,
  target_changed: 409,
  budget_exhausted: 429,
  output_gap: 502,
  uncertain_outcome: 409,
  no_progress: 429,
  cancelled: 409,
  sandbox_unavailable: 503,
  file_changed: 409,
  profile_changed: 409,
};

export function aiHttpStatusFor(code: AiErrorCode): number {
  return AI_HTTP_STATUS[code];
}

/** Runtime guard for the stable wire-code union (AI_HTTP_STATUS is the
 * exhaustive registry). Loosely-typed carriers such as AiPolicyError.code
 * must pass this before their code is reused. */
export function isAiErrorCode(value: unknown): value is AiErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AI_HTTP_STATUS, value);
}

export class AiAssistantError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;
  readonly detail?: Record<string, unknown>;

  constructor(code: AiErrorCode, detailOrMessage?: string | Record<string, unknown>, detail: Record<string, unknown> = {}) {
    super(typeof detailOrMessage === "string" ? detailOrMessage : code);
    this.name = "AiAssistantError";
    this.code = code;
    this.status = aiHttpStatusFor(code);
    this.detail =
      typeof detailOrMessage === "object" ? detailOrMessage : detail;
  }
}

/** Thrown by the runtime when a task snapshot lookup misses (route 404). */
export class AiTaskNotFoundError extends Error {}

/** Provider availability failures distinct from protocol failures. */
export class AiProviderUnavailableError extends AiAssistantError {
  constructor() {
    super("provider_unavailable", "Provider is not configured or unreachable");
  }
}

/** Budget accounting exhausted: no more rounds/tool calls/tokens. */
export class AiBudgetExhaustedError extends AiAssistantError {
  constructor(usage: { rounds?: number; toolCalls?: number }) {
    super("budget_exhausted", { usage });
  }
}
