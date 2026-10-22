import { z } from "zod";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const maintenanceWindowSchema = z.object({
  timezone: z.string().min(1).refine(isValidTimeZone, {
    message: "Invalid IANA timezone name",
  }),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(0).max(6)).min(1),
});

export const basePolicySchema = z.object({
  mode: z.enum(["auto", "manual", "pinned"]).default("auto"),
  group: z.string().min(1).default("Default"),
  pinnedReleaseId: z.string().optional(),
  canary: z.boolean().optional(),
  maintenanceWindow: maintenanceWindowSchema.optional(),
});

export const policySchema = basePolicySchema.superRefine((data, ctx) => {
  if (data.mode === "pinned" && !data.pinnedReleaseId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pinnedReleaseId is required when mode is 'pinned'",
      path: ["pinnedReleaseId"],
    });
  }
});

export const partialPolicySchema = basePolicySchema.partial().superRefine((data, ctx) => {
  if (data.mode === "pinned" && !data.pinnedReleaseId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pinnedReleaseId is required when mode is 'pinned'",
      path: ["pinnedReleaseId"],
    });
  }
});

export const enrollSchema = z.object({
  vpsIds: z.array(z.string().min(1)).min(1),
  confirmed: z.literal(true),
  policy: partialPolicySchema.optional(),
});

export const updatePoliciesSchema = z.object({
  vpsIds: z.array(z.string().min(1)).min(1),
  policy: partialPolicySchema,
});

export const createRolloutSchema = z.object({
  releaseId: z.string().min(1),
  group: z.string().min(1).optional(),
  vpsIds: z.array(z.string().min(1)).optional(),
  confirmed: z.literal(true),
  irreversibleConsent: z.boolean().optional(),
});

export const controlRolloutSchema = z.object({
  action: z.enum(["pause", "resume", "retry"]),
});
