import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AI_REPOSITORY, APP_CONFIG } from "../tokens.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import type { AppConfig } from "../config/app-config.js";
import type { AiHostCommandKind, AiPlanStep, AiPolicy, AiTask } from "./ai.models.js";
import { encryptAiSecret, loadAiKeyring } from "./ai-crypto.js";
import { AiAssistantError } from "./ai-failures.js";

import type { ProviderTool } from "./ai-provider.js";
const path = z.string().min(1).max(1024).refine(value => value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\0"));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const profile = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const schemas = {
  // execMode is optional model input (absent → the active policy decides;
  // default policy is sandbox). propose() stamps it from the policy so the
  // encrypted payload, args and plan.execMode always agree.
  shell: z.object({ script: z.string().min(1).max(32768), timeoutSeconds: z.number().int().min(1).max(120), execMode: z.enum(["sandbox", "privileged"]).optional() }).strict(),
  file_read: z.object({ path, scope: path, maxBytes: z.number().int().min(1).max(262144) }).strict(),
  file_apply: z.object({ path, scope: path, content: z.string().max(262144), expectedPreImageDigest: digest, postImageDigest: digest, mode: z.number().int().min(0).max(511), createNoReplace: z.boolean() }).strict(),
  service_status: z.object({ profileId: profile, service: z.string().max(128) }).strict(),
  service_action: z.object({ profileId: profile, service: z.string().max(128), action: z.enum(["start", "restart", "reload"]) }).strict(),
  config_validate: z.object({ profileId: profile, targetPath: path, candidateContent: z.string().max(262144) }).strict(),
  config_apply: z.object({ profileId: profile, targetPath: path, candidateContent: z.string().max(262144), expectedPreImageDigest: digest, postImageDigest: digest, reloadService: z.boolean() }).strict(),
  config_recover: z.object({ profileId: profile, targetPath: path, backupPath: path, expectedPostImageDigest: digest, restoreService: z.boolean() }).strict(),
};
const within = (target: string, scope: string) => target === scope || target.startsWith(scope.replace(/\/$/, "") + "/");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const hostTools: ProviderTool[] = Object.entries(schemas)
  .filter(([kind]) => kind !== "file_read" && kind !== "service_status")
  .map(([kind, schema]) => ({
    type: "function",
    function: {
      name: `host_${kind}`,
      description: `Propose ${kind} for explicit human approval. Never executes immediately.`,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(schema.shape).map(([key]) => [
            key,
            key === "execMode"
              ? { type: "string", enum: ["sandbox", "privileged"], default: "sandbox" }
              : key === "timeoutSeconds" || key === "mode" || key === "maxBytes"
                ? { type: "integer" }
                : key === "createNoReplace" || key === "reloadService" || key === "restoreService"
                  ? { type: "boolean" }
                  : { type: "string" },
          ]),
        ),
        // execMode stays optional for the model (absent = policy decides);
        // every other shell/file/config field is required.
        required: Object.keys(schema.shape).filter((key) => key !== "execMode"),
        additionalProperties: false,
      },
    },
  }));
@Injectable()
export class AiHostPlanService {
  constructor(@Inject(AI_REPOSITORY) private readonly repository: AiRepository, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async propose(task: AiTask, kind: AiHostCommandKind, input: unknown, policy: AiPolicy): Promise<AiPlanStep> {
    const parsed = schemas[kind].safeParse(input);
    if (!parsed.success) throw new AiAssistantError("policy_denied");
    const payload: Record<string, unknown> = parsed.data;
    if (kind === "shell") {
      // Execution mode is policy-dictated, never model-dictated (execmode
      // plan): callers reject model-supplied execMode values that differ from
      // the policy before this, so stamping here keeps the encrypted payload,
      // the approval-visible args and plan.execMode in agreement ("sandbox"
      // under the default policy).
      payload.execMode = policy.execMode;
    }
    this.authorize(kind, payload, policy);
    const stepId = randomUUID();
    const id = randomUUID();
    const now = new Date().toISOString();
    const encryptedPayload = encryptAiSecret(JSON.stringify(payload), { vpsId: task.vpsId, taskId: task.id, field: "executionPayload", version: 1 }, await loadAiKeyring(this.config.ai.keyringFile));
    await this.repository.saveExecutionBlob({ id, taskId: task.id, stepId, encryptedPayload, expiresAt: new Date(Date.now() + 180000).toISOString(), createdAt: now });
    const target = String(payload.path ?? payload.targetPath ?? payload.profileId ?? "scratch");
    const args = Object.fromEntries(Object.entries(payload).filter(([key]) => !["script", "content", "candidateContent"].includes(key)));
    args.payloadDigest = sha256(JSON.stringify(payload));
    if (typeof payload.script === "string") args.scriptDigest = sha256(payload.script);
    // Approval previews decrypt exact bytes only for the authenticated approver.
    if (typeof payload.content === "string") args.contentDigest = sha256(payload.content);
    if (typeof payload.candidateContent === "string") args.candidateDigest = sha256(payload.candidateContent);
    return { stepId, tool: `host.${kind}`, version: 1, args, resourceKeys: [`${task.vpsId}:${kind === "shell" ? "scratch" : target}`], inputDigests: { payload: String(args.payloadDigest) }, description: `${kind}: ${target}`, timeoutSeconds: typeof payload.timeoutSeconds === "number" ? payload.timeoutSeconds : 120, encryptedBlobId: id };
  }

  authorize(kind: AiHostCommandKind, payload: Record<string, unknown>, policy: AiPolicy): void {
    if (!policy.aiEnabled) throw new AiAssistantError("policy_denied");
    if (kind === "file_read" && !policy.readEnabled) throw new AiAssistantError("policy_denied");
    if (kind === "shell" && !policy.shellEnabled) throw new AiAssistantError("policy_denied");
    if (kind === "shell" && payload.execMode !== undefined && payload.execMode !== policy.execMode) throw new AiAssistantError("policy_denied");
    for (const field of ["script", "content", "candidateContent"]) {
      const value = payload[field];
      if (typeof value === "string" && Buffer.byteLength(value, "utf8") > (field === "script" ? 32768 : 262144)) throw new AiAssistantError("policy_denied");
    }
    const checkProtectedPath = (targetPath?: unknown) => {
      if (typeof targetPath === "string") {
        const lower = targetPath.toLowerCase();
        if (
          lower.includes("/etc/shadow") ||
          lower.includes("/etc/sudoers") ||
          lower.includes("/etc/pam.d") ||
          lower.includes(".ssh/") ||
          lower.endsWith(".ssh") ||
          lower.includes("keyring") ||
          lower.includes(".key") ||
          lower.includes("/proc/") ||
          lower.includes("/sys/")
        ) {
          throw new AiAssistantError("protected_target", "Path is a protected system resource");
        }
      }
    };
    checkProtectedPath(payload.path);
    checkProtectedPath(payload.targetPath);
    checkProtectedPath(payload.backupPath);

    if (kind === "file_read" || kind === "file_apply") {
      const scopes = kind === "file_read" ? policy.fileReadScopes : policy.fileWriteScopes;
      const target = String(payload.path);
      const scope = String(payload.scope);
      if (!scopes.includes(scope) || !within(target, scope)) throw new AiAssistantError("policy_denied");
    }
    if (kind.startsWith("service_") || kind.startsWith("config_")) {
      if (!policy.serviceProfileIds.includes(String(payload.profileId))) throw new AiAssistantError("policy_denied");
      if (typeof payload.service === "string" && /(^|[\/_\-\.:])(flexserver|vps-manager|vps_manager|vps-agent|vps_agent|postgres|sshd)([\/_\-\.:]|$)/i.test(payload.service)) {
        throw new AiAssistantError("protected_target", "Target service is a protected system resource");
      }
    }
    if (typeof payload.content === "string" && sha256(payload.content) !== payload.postImageDigest) throw new AiAssistantError("policy_denied");
    if (typeof payload.candidateContent === "string" && payload.postImageDigest && sha256(payload.candidateContent) !== payload.postImageDigest) throw new AiAssistantError("policy_denied");
  }
}
