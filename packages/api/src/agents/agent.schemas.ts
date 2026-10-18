import { z } from "zod";
import { dockerContainerDetailsSchema } from "../docker/docker-container-details.js";

// ── Schema ──────────────────────────────────────────────────────────────

const TEN_MINUTES_MS = 10 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;

const agentSystemOsInfoSchema = z
  .object({
    family: z.string().max(512).optional(),
    name: z.string().max(512).optional(),
    version: z.string().max(512).optional(),
    prettyName: z.string().max(512).optional(),
  })
  .strict();

const agentSystemKernelInfoSchema = z
  .object({
    release: z.string().max(512).optional(),
    version: z.string().max(512).optional(),
    arch: z.string().max(512).optional(),
  })
  .strict();

const agentSystemCpuInfoSchema = z
  .object({
    cores: z.number().int().min(0).max(4096).optional(),
    model: z.string().max(512).optional(),
  })
  .strict();

const agentSystemMemoryInfoSchema = z
  .object({
    totalBytes: z.number().int().finite().min(0).safe().optional(),
    availableBytes: z.number().int().finite().min(0).safe().optional(),
  })
  .strict();

const agentSystemRootDiskInfoSchema = z
  .object({
    mountPoint: z.string().min(1).max(255),
    fsType: z.string().max(512).optional(),
    totalBytes: z.number().int().finite().min(0).safe().optional(),
    usedBytes: z.number().int().finite().min(0).safe().optional(),
    freeBytes: z.number().int().finite().min(0).safe().optional(),
  })
  .strict();

const agentSystemInfoInputSchema = z
  .object({
    os: agentSystemOsInfoSchema.optional(),
    kernel: agentSystemKernelInfoSchema.optional(),
    cpu: agentSystemCpuInfoSchema.optional(),
    memory: agentSystemMemoryInfoSchema.optional(),
    rootDisk: agentSystemRootDiskInfoSchema.optional(),
  })
  .strict();

// ── Docker metrics sub-schemas ─────────────────────────────────────────


// ── Docker schema (additive, strictly bounded) ────────────────────────
// Privacy invariant: only the narrow allowlist below is accepted. Env,
// labels, mounts, commands/entrypoints/args, logs, secrets, configs,
// inspect payloads, volume names, layer IDs, and arbitrary event/storage
// attributes are rejected by strict() at every nesting level.

const dockerTimestamp = z.string().datetime({ offset: true });

const safeId = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._~-]+$/);

// Wire IDs are opaque, bounded strings. These limits mirror the agent's
// fail-closed validators (instance/container 32, retry IDs 64, digests 64).
const agentInstanceId = safeId(32);
const containerKey = safeId(32);
const retryId = safeId(64);
const eventId = safeId(128);
const digest = safeId(64);
const nanoString = z.string().regex(/^(0|[1-9]\d{0,31})$/);

const nonNegative = z.number().int().finite().min(0).safe();
// Canonical decimal-string ordering without numeric overflow: longer means
// larger; equal length compares lexicographically (matches agent cmp).
const decimalOrder = (left: string, right: string): number => {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const dockerCoverageSchema = z
  .object({
    detailsSampled: nonNegative.max(20),
    detailsTotalEligible: nonNegative.max(10000),
    complete: z.boolean(),
    cohortDigest: digest.optional(),
  })
  .strict();

const dockerAggregateSchema = z
  .object({
    coverage: dockerCoverageSchema,
    cpuPercent: z.number().finite().min(0).max(100000),
    memoryUsageBytes: nonNegative,
    networkRxBytes: nonNegative,
    networkTxBytes: nonNegative,
    blockReadBytes: nonNegative,
    blockWriteBytes: nonNegative,
    pids: nonNegative,
  })
  .strict();

const dockerEventContextSchema = z
  .object({
    version: z.literal(1),
    healthStatus: z.enum(["healthy", "unhealthy", "starting", "none"]).optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    signal: z.number().int().min(0).max(255).optional(),
    oomKilled: z.boolean().optional(),
    // Canonical seconds-only normalization marker: the agent normalized a
    // daemon event from `time` (seconds), so timeNano = seconds × 1e9.
    reducedPrecision: z.boolean().optional(),
    reason: z
      .enum([
        "boundary_overflow",
        "boundary_overrun_abandoned",
        "response_oversize",
        "collection_deadline",
        "daemon_restarted",
      ])
      .optional(),
    skippedFromNano: nanoString.optional(),
    skippedThroughNano: nanoString.optional(),
    skippedCount: nonNegative.max(10000).optional(),
  })
  .strict();

const dockerEventSchema = z
  .object({
    eventId: eventId,
    eventOccurredAt: z.string().datetime({ offset: true }),
    containerKey: containerKey.optional(),
    action: z.enum([
      "create",
      "start",
      "restart",
      "die",
      "stop",
      "kill",
      "destroy",
      "remove",
      "health_status",
      "stream_gap",
      "daemon_restarted",
    ]),
    context: dockerEventContextSchema,
  })
  .strict();

const dockerWatermarkSchema = z
  .object({
    timeNano: nanoString,
    boundaryDigests: z.array(digest).max(256).nullable().transform((value) => value ?? []),
  })
  .strict();

const dockerEventWindowSchema = z
  .object({
    since: nanoString,
    until: nanoString,
    capped: z.boolean(),
    lossy: z.boolean(),
    gapReason: z
      .enum([
        "boundary_overflow",
        "boundary_overrun_abandoned",
        "response_oversize",
        "collection_deadline",
      ])
      .optional(),
  })
  .strict()
  .refine((w) => decimalOrder(w.since, w.until) < 0, {
    message: "docker.eventWindow.since must be < until",
  })
  .refine((w) => w.lossy === (w.gapReason !== undefined), {
    message: "docker.eventWindow.lossy must match gapReason presence",
  });

const dockerStorageCategorySchema = z
  .object({
    supported: z.boolean(),
    count: nonNegative.max(1000000),
    totalBytes: nonNegative,
    reclaimableBytes: nonNegative.optional(),
    reclaimableSupported: z.boolean().optional(),
    estimatedReclaimableBytes: nonNegative.optional(),
  })
  .strict();

const dockerStorageSchema = z
  .object({
    formulaVersion: z.literal(1),
    images: dockerStorageCategorySchema,
    containers: dockerStorageCategorySchema,
    localVolumes: dockerStorageCategorySchema,
    buildCache: dockerStorageCategorySchema,
  })
  .strict();

const agentDockerContainerMetricSchema = z
  .object({
    containerKey,
    name: z.string().max(255),
    image: z.string().max(255),
    status: z.string().max(255).optional(),
    state: z.string().max(255),
    createdAt: z.string().max(255).optional(),
    health: z.enum(["healthy", "unhealthy", "starting", "none"]).optional(),
    cpuPercent: z.number().finite().min(0).max(100000),
    memoryUsageBytes: z.number().int().finite().min(0).safe(),
    memoryLimitBytes: z.number().int().finite().min(0).safe().optional(),
    networkRxBytes: z.number().int().finite().min(0).safe(),
    networkTxBytes: z.number().int().finite().min(0).safe(),
    blockReadBytes: z.number().int().finite().min(0).safe(),
    blockWriteBytes: z.number().int().finite().min(0).safe(),
    pids: z.number().int().finite().min(0).safe(),
    details: dockerContainerDetailsSchema.optional(),
  })
  .strict();

const dockerErrorCodeSchema = z.enum([
  "socket_missing",
  "permission_denied",
  "timeout",
  "daemon_unreachable",
  "unsupported_os",
  "bad_response",
]);

const positiveCanonicalDecimal = z.string().regex(/^[1-9][0-9]*$/, "must be a positive canonical decimal string");

const dockerMonitoringMetadataSchema = z.object({
  effectiveCadenceSeconds: z.number().int().finite().positive().max(86400),
  availability: z.enum(["available", "unavailable", "unknown"]),
  state: z.enum(["enabled", "disabled", "unknown"]),
}).strict();

const agentDockerMetricsBaseSchema = z
  .object({
    collectedAt: dockerTimestamp,
    agentVersion: z.string().max(255).optional(),
    engineVersion: z.string().max(64).optional(),
    apiVersion: z.string().max(64).optional(),
    os: z.string().max(32).optional(),
    architecture: z.string().max(32).optional(),
    schemaVersion: z.literal(2),
    agentInstanceId: agentInstanceId,
    snapshotId: retryId,
    sourceSequence: positiveCanonicalDecimal,
    batchId: retryId.optional(),
    available: z.boolean(),
    errorCode: dockerErrorCodeSchema.optional(),
    containerTotal: nonNegative,
    containerRunning: nonNegative,
    cpuPercent: z.number().finite().min(0).max(100000),
    memoryUsageBytes: nonNegative,
    memoryLimitBytes: nonNegative.optional(),
    networkRxBytes: nonNegative,
    networkTxBytes: nonNegative,
    blockReadBytes: nonNegative,
    blockWriteBytes: nonNegative,
    pids: nonNegative,
    details: dockerContainerDetailsSchema.optional(),
    containers: z.array(agentDockerContainerMetricSchema).max(20),
    sampledContainerAggregate: dockerAggregateSchema.optional(),
    events: z.array(dockerEventSchema).max(100).optional(),
    eventWindow: dockerEventWindowSchema.optional(),
    fromWatermark: dockerWatermarkSchema.optional(),
    proposedWatermark: dockerWatermarkSchema.optional(),
    storage: dockerStorageSchema.optional(),
    monitoring: dockerMonitoringMetadataSchema.optional(),
  })
  .strict();

const agentDockerMetricsInputSchema = agentDockerMetricsBaseSchema
  .superRefine((v, ctx) => {
    // A durable batch replays byte-for-byte until acknowledged. Its original
    // collection time can be arbitrarily old after an outage or failed upgrade.
    // Fresh snapshots still require a recent timestamp; neither may be future-dated.
    const collectedAt = new Date(v.collectedAt).getTime();
    if (
      collectedAt > Date.now() + TWO_MINUTES_MS ||
      (v.batchId === undefined && collectedAt < Date.now() - TEN_MINUTES_MS)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "docker.collectedAt must be recent unless replaying a durable batch",
      });
    }
    // Event protocol is all-or-none: batchId/events/eventWindow/
    // fromWatermark/proposedWatermark travel together (flat plan item 7).
    // A minimal snapshot carries none of them (batchId absent with no event
    // branch); a batch carries all five. Any partial mix is rejected.
    const hasBatch = v.batchId !== undefined;
    const hasEvents = v.events !== undefined;
    const hasWindow = v.eventWindow !== undefined;
    const hasFrom = v.fromWatermark !== undefined;
    const hasProposed = v.proposedWatermark !== undefined;
    const present = [hasBatch, hasEvents, hasWindow, hasFrom, hasProposed].filter(Boolean).length;
    if (present !== 0 && present !== 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "docker event batch must include batchId+events+eventWindow+fromWatermark+proposedWatermark together",
      });
      return;
    }
    if (present === 5) {
      // from==since is retained: the fixed window replays inclusively from S.
      if (v.fromWatermark!.timeNano !== v.eventWindow!.since) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "docker.fromWatermark.timeNano must equal eventWindow.since",
        });
      }
      // Range: from <= proposed <= until (canonical decimal ordering).
      // Capped windows may report partial complete-boundary progress
      // (since < proposed < until); the remainder is retried next window.
      if (decimalOrder(v.fromWatermark!.timeNano, v.proposedWatermark!.timeNano) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "docker.proposedWatermark.timeNano must not precede docker.fromWatermark.timeNano",
        });
      }
      if (decimalOrder(v.proposedWatermark!.timeNano, v.eventWindow!.until) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "docker.proposedWatermark.timeNano must not exceed docker.eventWindow.until",
        });
      }
      // Uncapped fully consumed windows must advance exactly to until.
      if (!v.eventWindow!.capped && !v.eventWindow!.lossy) {
        if (v.proposedWatermark!.timeNano !== v.eventWindow!.until) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "docker.proposedWatermark.timeNano must equal eventWindow.until for uncapped complete windows",
          });
        }
      }
      // Explicit abandonment through U must advance exactly to until
      // (plan item 5: the remainder is deliberately dropped and recorded).
      // This covers all abandonment-through-U gap reasons; partial
      // proposed<until stays allowed only for boundary_overflow and for
      // capped non-lossy complete-boundary batches.
      if (
        v.eventWindow!.lossy &&
        (v.eventWindow!.gapReason === "boundary_overrun_abandoned" ||
          v.eventWindow!.gapReason === "response_oversize" ||
          v.eventWindow!.gapReason === "collection_deadline")
      ) {
        if (v.proposedWatermark!.timeNano !== v.eventWindow!.until) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "docker.proposedWatermark.timeNano must equal eventWindow.until for abandoned windows",
          });
        }
      }
    }
    // Container scope: host-scope actions may omit containerKey; all other
    // actions require a valid opaque key (mirrors agent validator).
    for (let i = 0; i < (v.events ?? []).length; i++) {
      const e = v.events![i]!;
      const hostScope = e.action === "stream_gap" || e.action === "daemon_restarted";
      if (!hostScope && e.containerKey === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `docker.events[${i}].containerKey is required for action ${e.action}`,
        });
      }
    }
  });

export const agentMetricPayloadSchema = z
  .object({
    cpu: z.number().finite().min(0).max(100),
    memory: z.number().finite().min(0).max(100),
    disk: z.number().finite().min(0).max(100),
    loadAverage: z.number().finite().min(0),
    networkRx: z.number().finite().min(0),
    networkTx: z.number().finite().min(0),
    uptime: z.number().finite().min(0),
    collectedAt: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), {
        message: "collectedAt must be a parseable date",
      })
      .refine(
        (val) => {
          const ts = new Date(val).getTime();
          const now = Date.now();
          return ts >= now - TEN_MINUTES_MS && ts <= now + TWO_MINUTES_MS;
        },
        { message: "collectedAt must be within -10m / +2m of now" },
      ),
    agentVersion: z.string().min(1, "agentVersion is required"),
    /** Full git SHA build identity of the running agent binary (heartbeat). */
    buildId: z.string().regex(/^[0-9a-f]{40}$/, "buildId must be a full git SHA").optional(),
     vpsId: z.string().optional(),
     location: z.object({
       city: z.string().trim().min(1).max(120),
       country: z.string().trim().min(1).max(120),
       detectedAt: z.string().datetime({ offset: true }),
     }).strict().optional(),
     system: agentSystemInfoInputSchema.optional(),
    docker: agentDockerMetricsInputSchema.optional(),
    /** New collectors always send B/s; old rows omit it. */
    networkUnit: z.enum(["bytes/s"]).optional(),
    /** false = first-sample/reset/elapsed<=0/unreadable (rx=tx=0 on the wire). */
    networkAvailable: z.boolean().optional(),
  })
  .strict(); // reject unknown fields

export type AgentMetricPayloadInput = z.infer<typeof agentMetricPayloadSchema>;
