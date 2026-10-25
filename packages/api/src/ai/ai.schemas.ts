import { z } from "zod";

export const updateAiSettingsSchema = z
  .object({
    endpoint: z.string().url().max(1024),
    model: z.string().min(1).max(256),
    apiKey: z.string().min(1).max(4096).optional(),
    allowPrivateEndpoint: z.boolean().optional(),
  })
  .strict();

export const updateAiPolicySchema = z
  .object({
    aiEnabled: z.boolean().optional(),
    readEnabled: z.boolean().optional(),
    dockerActionsEnabled: z.boolean().optional(),
    composeActionsEnabled: z.boolean().optional(),
    shellEnabled: z.boolean().optional(),
    fileReadScopes: z.array(z.string().min(1).max(1024)).max(64).optional(),
    fileWriteScopes: z.array(z.string().min(1).max(1024)).max(64).optional(),
    serviceProfileIds: z.array(z.string().min(1).max(128)).max(64).optional(),
    sendLogsToProvider: z.boolean().optional(),
    sendFilesToProvider: z.boolean().optional(),
  })
  .strict();

export const createAiTaskSchema = z
  .object({
    request: z.string().min(1).max(32768),
    idempotencyKey: z.string().min(1).max(64),
    conversationId: z.string().min(1).max(64).optional(),
    /** Explicit provider/model selection (Q16 tier 1); must resolve or the
     * request fails closed instead of falling back. */
    providerId: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(256).optional(),
  })
  .strict();

export const providerProfileWriteSchema = z
  .object({
    name: z.string().min(1).max(64),
    endpoint: z.string().url().max(1024),
    apiKey: z.string().min(1).max(4096).optional(),
    allowPrivateEndpoint: z.boolean().optional(),
    models: z.array(z.string().min(1).max(256)).min(1).max(100),
    defaultModel: z.string().min(1).max(256).optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const taskInputSchema = z
  .object({
    input: z.string().min(1).max(32768),
  })
  .strict();

export const approvePlanSchema = z
  .object({
    planVersion: z.number().int().min(1),
    planDigest: z.string().min(16).max(128),
  })
  .strict();

export const hostCapabilitiesSchema = z
  .object({
    supported: z.boolean(),
    unsupportedReason: z.string().max(512).optional(),
    cgroupV2: z.boolean(),
    namespaces: z.boolean(),
    seccomp: z.boolean(),
    rootfsDigest: z.string().max(128),
    profilesDigest: z.string().max(128),
    profiles: z.array(z.string().min(1).max(64)).max(64),
  })
  .strict();

export const hostClaimSchema = z
  .object({
    version: z.literal(1),
    agentInstanceId: z.string().min(1).max(32),
    capabilities: hostCapabilitiesSchema.optional(),
  })
  .strict();

export const hostHeartbeatSchema = z
  .object({
    version: z.literal(1),
    agentInstanceId: z.string().min(1).max(32),
    taskId: z.string().min(1).max(64),
    commandId: z.string().min(1).max(64),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export const hostOutputSchema = z
  .object({
    version: z.literal(1),
    agentInstanceId: z.string().min(1).max(32),
    taskId: z.string().min(1).max(64),
    commandId: z.string().min(1).max(64),
    streamId: z.string().min(1).max(64),
    sequence: z.number().int().min(0),
    chunk: z
      .string()
      .max(16384)
      .refine((s) => Buffer.byteLength(s, "utf8") <= 16 * 1024, {
        message: "chunk exceeds 16 KiB UTF-8 byte limit",
      }),
    isGap: z.boolean(),
    isEnd: z.boolean(),
  })
  .strict();

export const hostResultSchema = z
  .object({
    version: z.literal(1),
    agentInstanceId: z.string().min(1).max(32),
    taskId: z.string().min(1).max(64),
    stepId: z.string().min(1).max(64),
    commandId: z.string().min(1).max(64),
    planVersion: z.number().int().min(0),
    planDigest: z.string().min(16).max(128),
    status: z.enum(["succeeded", "failed", "uncertain", "cancelled"]),
    executed: z.boolean(),
    exitCode: z.number().int().optional(),
    errorCode: z.string().max(64).optional(),
    errorMessage: z
      .string()
      .max(1024)
      .refine((s) => Buffer.byteLength(s, "utf8") <= 1024, {
        message: "errorMessage exceeds 1024 bytes UTF-8 limit",
      })
      .optional(),
    outputPreview: z
      .string()
      .max(16384)
      .refine((s) => Buffer.byteLength(s, "utf8") <= 8 * 1024, {
        message: "outputPreview exceeds 8 KiB UTF-8 byte limit",
      })
      .optional(),
    payload: z
      .record(z.unknown())
      .refine(
        (val) => {
          if (!val) return true;
          try {
            return (
              Buffer.byteLength(JSON.stringify(val), "utf8") <= 256 * 1024
            );
          } catch {
            return false;
          }
        },
        { message: "payload exceeds 256 KiB serialized byte limit" },
      )
      .optional(),
  })
  .strict();

export const hostCancelStatusSchema = z
  .object({
    version: z.literal(1),
    agentInstanceId: z.string().min(1).max(32),
    taskId: z.string().min(1).max(64),
    commandId: z.string().min(1).max(64),
    acknowledged: z.boolean(),
    terminated: z.boolean(),
  })
  .strict();
