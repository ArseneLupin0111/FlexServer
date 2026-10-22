import { z } from "zod";
import { LOCAL_UPGRADE_PROGRESS_PHASES } from "./local-upgrade.models.js";

/** Full git SHA — releaseId/buildId identity for releases and heartbeats. */
export const fullGitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-char git SHA");

/** Required Idempotency-Key header on agent-update trigger. */
export const requiredIdempotencyKeySchema = z
  .string({ required_error: "Idempotency-Key header is required" })
  .trim()
  .min(1, "Idempotency-Key must not be empty")
  .max(200);
/** POST /api/local-updater/jobs/:jobId/progress */
export const localUpdaterProgressSchema = z
  .object({
    fencingToken: z.number().int().min(0),
    phase: z.enum(LOCAL_UPGRADE_PROGRESS_PHASES),
    progress: z.number().int().min(0).max(100).nullable().optional(),
    message: z.string().trim().max(160).optional(),
  })
  .strict();

export type LocalUpdaterProgressInput = z.infer<
  typeof localUpdaterProgressSchema
>;

/** POST /api/local-updater/jobs/:jobId/result */
export const localUpdaterResultSchema = z
  .object({
    fencingToken: z.number().int().min(0),
    outcome: z.enum([
      "succeeded",
      "rolled_back",
      "rollback_unverified",
      "failed",
      "deferred",
      "superseded",
    ]),
    reportedBuildId: fullGitShaSchema.optional(),
    reason: z.string().trim().max(160).optional(),
  })
  .strict();

export type LocalUpdaterResultInput = z.infer<
  typeof localUpdaterResultSchema
>;

/** GET /api/vps/:id/local-agent-upgrades?limit=&offset= */
export const localUpgradeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Optional Idempotency-Key header on job create. */
export const idempotencyKeySchema = z.string().trim().min(1).max(200);
