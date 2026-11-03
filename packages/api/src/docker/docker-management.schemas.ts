import { createHash } from "node:crypto";
import { z } from "zod";
import { DOCKER_MANAGEMENT_ACTIONS } from "./docker-management.models.js";

export const DOCKER_MANAGEMENT_DIGEST_VERSION = 1;

const opaqueId = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._~-]+$/);

export const dockerManagementOperationIdSchema = opaqueId(128);
export const dockerManagementIdempotencyKeySchema = opaqueId(64);

export const dockerManagementTargetSchema = z
  .object({
    containerKey: opaqueId(32),
    agentInstanceId: opaqueId(32).optional(),
  })
  .strict();

export const dockerManagementConfirmationSchema = z
  .object({
    confirmed: z.literal(true),
  })
  .strict();

export const dockerManagementCreateSchema = z
  .object({
    action: z.enum(DOCKER_MANAGEMENT_ACTIONS),
    target: dockerManagementTargetSchema,
    confirmation: dockerManagementConfirmationSchema,
    idempotencyKey: dockerManagementIdempotencyKeySchema,
  })
  .strict();

export const dockerManagementClaimSchema = z
  .object({
    claimedBy: opaqueId(64),
  })
  .strict();

export const dockerManagementResultSchema = z
  .object({
    ok: z.boolean(),
    exitCode: z.number().int().min(0).max(255).optional(),
    message: z.string().min(1).max(500).optional(),
  })
  .strict();

export type DockerManagementCreateInput = z.infer<
  typeof dockerManagementCreateSchema
>;
export type DockerManagementClaimInput = z.infer<
  typeof dockerManagementClaimSchema
>;
export type DockerManagementResultInput = z.infer<
  typeof dockerManagementResultSchema
>;

// ── Agent command queue contract (packages/agent/internal/commands) ─────
// The Go agent validates fail-closed in both directions; these schemas
// mirror its bounds exactly so neither side ever accepts a shape the other
// would reject.

/** Error codes the agent may attach to failed/uncertain receipts. */
export const AGENT_COMMAND_ERROR_CODES = [
  "container_not_found",
  "target_busy",
  "action_failed",
  "deadline_exceeded",
  "target_mismatch",
  "identity_mismatch",
  "unsupported_action",
  "daemon_unreachable",
  "timeout",
  "uncertain_outcome",
] as const;
/** POST /api/agent/commands/claim request body. */
export const agentCommandClaimRequestSchema = z
  .object({
    agentInstanceId: opaqueId(32),
  })
  .strict();

/** POST /api/agent/commands/result request body. */
export const agentCommandReportSchema = z
  .object({
    commandId: opaqueId(64),
    agentInstanceId: opaqueId(32),
    status: z.enum(["succeeded", "failed", "uncertain"]),
    executed: z.boolean(),
    exitCode: z.number().int().min(0).max(255).optional(),
    errorCode: z.enum(AGENT_COMMAND_ERROR_CODES).optional(),
    outputPreview: z
      .string()
      .superRefine((value, ctx) => {
        if (Buffer.byteLength(value, "utf8") > 8 * 1024) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "outputPreview exceeds 8KiB",
          });
        }
      })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "uncertain" && !value.executed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uncertain results must set executed",
      });
    }
  });

/**
 * Outbound claim payload; bounds mirror commands.ValidateCommand so a queued
 * operation that cannot be represented safely is never handed to the agent.
 */
export const agentCommandSchema = z
  .object({
    commandId: opaqueId(64),
    agentInstanceId: opaqueId(32),
    vpsId: opaqueId(64),
    action: z.enum(["start", "stop", "restart"]),
    containerKey: opaqueId(32),
    deadlineNano: z.string().regex(/^(0|[1-9][0-9]{0,31})$/),
    timeoutSeconds: z.number().int().min(1).max(120),
  })
  .strict();

export type AgentCommandClaimRequest = z.infer<
  typeof agentCommandClaimRequestSchema
>;
export type AgentCommandReport = z.infer<typeof agentCommandReportSchema>;
export type AgentCommand = z.infer<typeof agentCommandSchema>;

/** Canonical JSON for deterministic request digests (sorted object keys). */
export function canonicalManagementJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalManagementJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalManagementJson(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Digest covers action + target only: confirmation/key are transport metadata. */
export function dockerManagementRequestDigest(value: unknown): string {
  return createHash("sha256")
    .update(`docker-management-v${DOCKER_MANAGEMENT_DIGEST_VERSION}:`)
    .update(canonicalManagementJson(value))
    .digest("hex");
}
