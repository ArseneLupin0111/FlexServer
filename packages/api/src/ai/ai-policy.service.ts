// ── AI policy, capability and admission gate (plan §4, §7.2, §9) ────────
//
// Permission to act = intersection of:
//   admin policy (ai_policies row; absent rows default on for ai/read/
//   docker/compose, off for shell/egress/scopes) × current VPS gates ×
//   tool policy × approval requirement × provider configuration.
//
// Demo mode never reaches a provider or a real host action; runtime
// opt-ins (shell/egress) default OFF and every mutation step must be
// covered by a consumed canonical plan approval; read/docker/compose
// gates default ON with no persisted policy.
// Gate answers are decided here — never from model output.

import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";
import { UnauthorizedException } from "@nestjs/common";
import { AI_REPOSITORY, APP_CONFIG } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import { AiProviderUnavailableError } from "./ai-failures.js";
import type {
  AiCapability,
  AiHostCapabilitiesReport,
  AiPolicy,
  AiProviderProfileInternal,
  AiProviderSettingsInternal,
  AiTaskState,
} from "./ai.models.js";

/** Capability refresh window (§4.1): older → unavailable with reason. */
export const AI_CAPABILITY_FRESHNESS_MS = 5 * 60 * 1000;

/** Task states that hold the per-VPS active slot (§7.1). */
export const AI_ACTIVE_TASK_STATES: readonly AiTaskState[] = [
  "planning",
  "awaiting_input",
  "awaiting_approval",
  "executing",
  "verifying",
  "cancel_requested",
];

export interface AiProviderReady {
  configured: true;
  settings: AiProviderSettingsInternal;
}

export interface AiProviderNotReady {
  configured: false;
  reason: string;
}

export type AiProviderReadiness = AiProviderReady | AiProviderNotReady;

export interface AiGateErrorShape {
  status: number;
  code: string;
  detail?: Record<string, unknown>;
}

/** Named error norm carrying a wire code + HTTP status; caught by the API
 * exception filter's dedicated AI branch and rendered as `error.code`. */
export class AiPolicyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    detail?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "AiPolicyError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export type AiPolicyGate = keyof AiPolicy;

@Injectable()
export class AiPolicyService {
  private readonly logger = new Logger(AiPolicyService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
  ) {}

  /** Global runtime gate + configured provider state. Strict readiness:
   * endpoint AND model AND API key must all exist — no silent default. */
  async resolveProviderReadiness(): Promise<AiProviderReadiness> {
    if (!this.config.ai.enabled) {
      return { configured: false, reason: "ai_disabled" };
    }
    const settings = await this.repository.getSettings();
    if (!settings || !settings.endpoint || !settings.model || !settings.encryptedApiKey) {
      return { configured: false, reason: "provider_unavailable" };
    }
    return { configured: true, settings };
  }

  /** Readiness of one provider profile (docs/ai-multi-provider-plan.md):
   * enabled, with endpoint, models and usable credentials. API-key profiles
   * need their key envelope; ChatGPT-OAuth profiles need a connected token
   * envelope (expiry is enforced at dispatch after refresh). */
  isProfileReady(profile: AiProviderProfileInternal | undefined): profile is AiProviderProfileInternal {
    if (!this.config.ai.enabled || !profile?.enabled || !profile.endpoint || profile.models.length === 0) return false;
    return profile.authKind === "chatgpt_oauth"
      ? Boolean(profile.encryptedOauth && profile.tokenState !== "relogin_required")
      : Boolean(profile.encryptedApiKey);
  }

  /** AI routes require a live admin session in local mode; in demo mode
   * everything provider-facing is refused before any network/host effect. */
  requireAdminSession(request: Request): string {
    if (this.config.mode !== "local") {
      throw new AiPolicyError("ai_disabled", 403, { scope: "global" });
    }
    const sessionId = (request as Request & { dashboardSessionId?: string })
      .dashboardSessionId;
    if (!sessionId) {
      throw new UnauthorizedException({
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
    }
    return sessionId;
  }

  /** Read (upsert-on-read) effective VPS policy for gate evaluation. */
  async getPolicy(vpsId: string): Promise<AiPolicy | undefined> {
    return this.repository.getAiPolicy(vpsId);
  }

  /** Strict gate for any AI task admission on a VPS. */
  async authorizeTaskAdmission(
    vpsId: string,
    sessionActive: boolean,
  ): Promise<AiPolicy> {
    if (!this.config.ai.enabled) {
      throw new AiPolicyError("ai_disabled", 403, { scope: "global" });
    }
    const policy = await this.repository.getAiPolicy(vpsId);
    if (!policy || !policy.aiEnabled) {
      throw new AiPolicyError("ai_disabled", 403, { scope: "vps" });
    }
    if (!sessionActive) {
      throw new AiPolicyError("ai_disabled", 403, { scope: "session" });
    }
    return policy;
  }

  /** Tool-level authorization: read-only auto-allowed within budget when
   * readEnabled; mutations require gate='aiEnabled' AND an approved plan
   * consumed by the approval seam before execute. */
  authorizeToolCall(policy: AiPolicy, gate: AiPolicyGate): void {
    if (!this.config.ai.enabled) {
      throw new AiPolicyError("ai_disabled", 403);
    }
    if (gate !== "aiEnabled" && policy[gate] !== true) {
      throw new AiPolicyError("policy_denied", 403, { gate });
    }
  }

  /** Egress projection guard for LLM context building (§9.2): contents may
   * reach the provider only when the corresponding data opt-in is true. */
  assertEgressAllowed(policy: AiPolicy, kind: "logs" | "files"): void {
    const granted =
      kind === "logs" ? policy.sendLogsToProvider : policy.sendFilesToProvider;
    if (!granted) {
      throw new AiPolicyError("policy_denied", 403, { gate: kind });
    }
  }

  /** Capability snapshot read: missing rows surface as an unavailable
   * placeholder rather than a route error — the caller decides whether a
   * capability answer is mandatory for the flow it's about to start. */
  async getCapability(vpsId: string): Promise<AiCapability> {
    const capability = await this.repository.getAiCapability(vpsId);
    if (capability) return capability;
    return {
      vpsId,
      supported: false,
      reason: "no_capability_report",
      freshness: new Date(0).toISOString(),
      protocolVersion: 1,
      cgroupV2Available: false,
      namespacesAvailable: false,
      seccompAvailable: false,
      privilegedSupported: false,
      profiles: [],
    };
  }

  /** Age-only freshness of the capability claim (window check, no support
   * flags). The privileged dispatch path uses this because sandbox
   * `supported` is deliberately not required there (execmode plan Q3). */
  isCapabilityReportFresh(capability: AiCapability, now = Date.now()): boolean {
    const age = now - Date.parse(capability.freshness);
    if (!Number.isFinite(age)) return false;
    if (age > AI_CAPABILITY_FRESHNESS_MS) return false;
    if (age < -60_000) return false;
    return true;
  }

  isCapabilityFresh(capability: AiCapability, now = Date.now()): boolean {
    return this.isCapabilityReportFresh(capability, now) && capability.supported === true;
  }

  /** Persist an agent-reported capability snapshot after strict validation.
   * Only the /api/agent/ai/claim route with schema-validated bodies reaches
   * this — never LLM/model data. */
  async applyCapabilityReport(
    vpsId: string,
    report: AiHostCapabilitiesReport,
    agentVersion?: string,
  ): Promise<AiCapability> {
    const now = new Date().toISOString();
    const capability: AiCapability = {
      vpsId,
      supported: report.supported === true,
      ...(report.unsupportedReason ? { reason: report.unsupportedReason } : {}),
      freshness: now,
      ...(agentVersion ? { agentVersion } : {}),
      protocolVersion: 1,
      cgroupV2Available: report.cgroupV2 === true,
      namespacesAvailable: report.namespaces === true,
      seccompAvailable: report.seccomp === true,
      privilegedSupported: report.privilegedSupported === true,
      ...(report.privilegedUnsupportedReason ? { privilegedUnsupportedReason: report.privilegedUnsupportedReason } : {}),
      profiles: Array.isArray(report.profiles)
        ? report.profiles.slice(0, 64)
        : [],
      ...(report.rootfsDigest ? { rootfsDigest: report.rootfsDigest } : {}),
      ...(report.profilesDigest ? { profilesDigest: report.profilesDigest } : {}),
    };
    return this.repository.recordAiCapability(capability);
  }

  /** Revalidation gate at dispatch: policy revision unchanged, provider
   * readiness unchanged. When a providerId is bound (multi-provider), only
   * THAT profile's revision matters — editing another provider never fails
   * this task (Q9). Legacy tasks without a bound provider keep the global
   * settings check. Rejects before enqueue when anything moved. */
  async revalidateForDispatch(
    vpsId: string,
    expected: { policyRevision: number; providerRevision: number; providerId?: string },
  ): Promise<void> {
    if (!this.config.ai.enabled) {
      throw new AiPolicyError("ai_disabled", 403, { scope: "global" });
    }
    if (expected.providerId) {
      const profile = await this.repository.getProviderProfile(expected.providerId);
      if (!profile || !this.isProfileReady(profile) || profile.revision !== expected.providerRevision) {
        throw new AiPolicyError("provider_revision_changed", 409);
      }
    } else {
      const readiness = await this.resolveProviderReadiness();
      if (!readiness.configured) {
        throw new AiPolicyError("provider_unavailable", 502);
      }
      if (readiness.settings.revision !== expected.providerRevision) {
        throw new AiPolicyError("provider_revision_changed", 409);
      }
    }
    const policy = await this.repository.getAiPolicy(vpsId);
    if (!policy || !policy.aiEnabled) {
      throw new AiPolicyError("ai_disabled", 403, { scope: "vps" });
    }
    if (policy.revision !== expected.policyRevision) {
      throw new AiPolicyError("policy_denied", 409, { reason: "policy_changed" });
    }
  }

  isGlobalEnabled(): boolean {
    return this.config.ai.enabled === true;
  }

  /** Error translation: normalized, safe, stable (§8.2). */
  toResponse(error: unknown): AiGateErrorShape {
    if (error instanceof AiPolicyError) {
      return { status: error.status, code: error.code, detail: error.detail };
    }
    this.logger.error(
      `Unhandled AI policy failure: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { status: 500, code: "internal_error" };
  }
}
