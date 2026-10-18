import { z } from "zod";
import { canonicalDockerJson } from "./docker-monitoring.schemas.js";

/**
 * Bounded inspect projection for one Docker container.
 *
 * This module is the single source of truth for the shared wire shape: the
 * Go agent (`docker_container_details.go`) re-declares the identical bounds,
 * `packages/web/src/lib/api.ts` mirrors the inferred type, and the monitoring
 * models attach `details?: DockerContainerDetails` to samples and current
 * containers. The strict projection excludes raw environment, labels, health
 * commands/output and daemon identifiers. Allowed metadata strings remain
 * operator-visible; they are not a general-purpose secret detector.
 */

/** Mount source/destination paths. */
export const DOCKER_DETAILS_PATH_BYTES_MAX = 1024;
/** Protocol, mount type, restart-policy name. */
export const DOCKER_DETAILS_SHORT_BYTES_MAX = 32;
export const DOCKER_DETAILS_PORT_MIN = 1;
export const DOCKER_DETAILS_PORT_MAX = 65535;
/** Whole-details envelope cap on canonical JSON (sorted keys, no whitespace). */
export const DOCKER_DETAILS_TOTAL_BYTES_MAX = 16 * 1024;
/** Counters and durations are nonnegative safe integers; no tighter cap. */
export const DOCKER_DETAILS_SAFE_INT_MIN = 0;
export const DOCKER_DETAILS_PORT_ROWS_MAX = 32;
export const DOCKER_DETAILS_MOUNTS_MAX = 16;
export const DOCKER_DETAILS_NETWORKS_MAX = 16;
/** Names, addresses, timestamps and every non-path string. */
export const DOCKER_DETAILS_STRING_BYTES_MAX = 256;

export const DOCKER_DETAILS_REASONS = [
  "timeout",
  "not_found",
  "permission_denied",
  "daemon_unreachable",
  "invalid_response",
  "budget_exhausted",
] as const;

export const DOCKER_DETAILS_HEALTH_STATUSES = [
  "healthy",
  "unhealthy",
  "starting",
  "none",
] as const;

/**
 * Docker zero time is never a real lifecycle timestamp: the agent MUST omit
 * zero timestamps instead of attaching them, and the schema rejects
 * `0001-01-01T00:00:00Z` so a broken host cannot publish zero values.
 */
const DOCKER_ZERO_TIME_EPOCH_MS = -62135596800000;

const utf8ByteLength = (value: string): number =>
  Buffer.byteLength(value, "utf8");

/**
 * Bounded non-empty string with a byte (not code-unit) length check:
 * UTF-8 byte prefixes (multi-byte sequences, emoji) still parse or reject
 * identically across TS and Go. Lone UTF-16 surrogates are also rejected —
 * they serialize lossily across the process boundary (mirrors
 * `dockerLogLineSchema`).
 */
const boundedNonEmptyUtf8 = (maxBytes: number) =>
  z
    .string()
    .max(maxBytes)
    .superRefine((value, ctx) => {
      if (
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          value,
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must not contain lone UTF-16 surrogates",
        });
      }
      const bytes = utf8ByteLength(value);
      if (bytes < 1 || bytes > maxBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be 1..${maxBytes} UTF-8 bytes`,
        });
        return;
      }
    });

/** Timestamps stay UTC ISO (`...Z`), seconds with up to 9 fraction digits. */
const utcTimestampSchema = z.string().datetime();
const detailsTimestamp = boundedNonEmptyUtf8(
  DOCKER_DETAILS_STRING_BYTES_MAX,
).superRefine((value, ctx) => {
  if (
    !utcTimestampSchema.safeParse(value).success ||
    !/T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value) ||
    Date.parse(value) === DOCKER_ZERO_TIME_EPOCH_MS
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "must be a real UTC ISO timestamp (`…Z`, ≤9 fraction digits, not the Docker zero time)",
    });
  }
});

const nonNegativeInt = z.number().int().min(DOCKER_DETAILS_SAFE_INT_MIN).safe();

const detailsPortRow = z
  .object({
    containerPort: z
      .number()
      .int()
      .min(DOCKER_DETAILS_PORT_MIN)
      .max(DOCKER_DETAILS_PORT_MAX)
      .safe(),
    protocol: boundedNonEmptyUtf8(DOCKER_DETAILS_SHORT_BYTES_MAX),
    hostIp: boundedNonEmptyUtf8(DOCKER_DETAILS_STRING_BYTES_MAX).optional(),
    hostPort: z
      .number()
      .int()
      .min(DOCKER_DETAILS_PORT_MIN)
      .max(DOCKER_DETAILS_PORT_MAX)
      .safe()
      .optional(),
  })
  .strict();

const detailsMount = z
  .object({
    type: boundedNonEmptyUtf8(DOCKER_DETAILS_SHORT_BYTES_MAX),
    source: boundedNonEmptyUtf8(DOCKER_DETAILS_PATH_BYTES_MAX).optional(),
    destination: boundedNonEmptyUtf8(DOCKER_DETAILS_PATH_BYTES_MAX),
    readOnly: z.boolean(),
  })
  .strict();

const detailsNetwork = z
  .object({
    name: boundedNonEmptyUtf8(DOCKER_DETAILS_STRING_BYTES_MAX),
    ipv4: boundedNonEmptyUtf8(DOCKER_DETAILS_STRING_BYTES_MAX).optional(),
    ipv6: boundedNonEmptyUtf8(DOCKER_DETAILS_STRING_BYTES_MAX).optional(),
    gateway: boundedNonEmptyUtf8(DOCKER_DETAILS_STRING_BYTES_MAX).optional(),
  })
  .strict();

const detailsRestartPolicy = z
  .object({
    name: boundedNonEmptyUtf8(DOCKER_DETAILS_SHORT_BYTES_MAX),
    maximumRetryCount: nonNegativeInt,
  })
  .strict();

const detailsHealthcheck = z
  .object({
    status: z.enum(DOCKER_DETAILS_HEALTH_STATUSES),
    failingStreak: nonNegativeInt.optional(),
    intervalMs: nonNegativeInt.optional(),
    timeoutMs: nonNegativeInt.optional(),
    startPeriodMs: nonNegativeInt.optional(),
    retries: nonNegativeInt.optional(),
  })
  .strict();

const availableDetailsSchema = z
  .object({
    collectedAt: detailsTimestamp,
    status: z.literal("available"),
    createdAt: detailsTimestamp.optional(),
    startedAt: detailsTimestamp.optional(),
    finishedAt: detailsTimestamp.optional(),
    exitCode: z.number().int().min(0).max(255).safe().optional(),
    oomKilled: z.boolean().optional(),
    restartCount: nonNegativeInt.optional(),
    restartPolicy: detailsRestartPolicy.optional(),
    ports: z.array(detailsPortRow).max(DOCKER_DETAILS_PORT_ROWS_MAX),
    mounts: z.array(detailsMount).max(DOCKER_DETAILS_MOUNTS_MAX),
    networks: z.array(detailsNetwork).max(DOCKER_DETAILS_NETWORKS_MAX),
    healthcheck: detailsHealthcheck,
  })
  .strict();

const unavailableDetailsSchema = z
  .object({
    collectedAt: detailsTimestamp,
    status: z.literal("unavailable"),
    reason: z.enum(DOCKER_DETAILS_REASONS),
  })
  .strict();

const detailsUnion = z.discriminatedUnion("status", [
  availableDetailsSchema,
  unavailableDetailsSchema,
]);

const detailsUnionEnvelope = detailsUnion.superRefine((value, ctx) => {
  const bytes = utf8ByteLength(canonicalDockerJson(value));
  if (bytes > DOCKER_DETAILS_TOTAL_BYTES_MAX) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `serialized details must not exceed ${DOCKER_DETAILS_TOTAL_BYTES_MAX} bytes`,
    });
  }
});

export const dockerContainerDetailsSchema = detailsUnionEnvelope;

export type DockerContainerDetails = z.infer<
  typeof dockerContainerDetailsSchema
>;
