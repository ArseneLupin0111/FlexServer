import type { DockerContainerDetails } from "./docker-container-details.js";
import type { DockerTypedAlertState } from "./docker-alert-evaluator.js";

export type DockerScope = "host" | "container" | "aggregate";
export type DockerAlertState = "open" | "acknowledged" | "resolved";
export type DockerAlertResolutionReason =
  | "monitoring_disabled"
  | "identity_reset_orphaned"
  | "vps_deleted"
  | "condition_cleared"
  | "container_removed";
export type DockerEventAction =
  | "create"
  | "start"
  | "restart"
  | "die"
  | "stop"
  | "kill"
  | "destroy"
  | "remove"
  | "health_status"
  | "stream_gap"
  | "daemon_restarted";

export type DockerHostSampleCoverage = {
  detailsSampled: number;
  detailsTotalEligible: number;
  complete: boolean;
  cohortDigest?: string;
};
export type DockerHostSample = {
  id: string;
  vpsId: string;
  agentInstanceId: string;
  snapshotId: string;
  collectedAt: string;
  receivedAt: string;
  effectiveAt: string;
  metrics: Record<string, number>;
  coverage?: DockerHostSampleCoverage;
};
export type DockerContainerSample = DockerHostSample & {
  containerKey: string;
  name?: string;
  state?: string;
  image?: string;
  status?: string;
  details?: DockerContainerDetails;
};
/** Canonical container identity rows of the latest committed snapshot. */
export type DockerCurrentContainer = {
  agentInstanceId: string;
  containerKey: string;
  name?: string;
  state?: string;
  image?: string;
  status?: string;
  metrics: { cpuPercent: number; memoryUsageBytes: number; pids: number };
  collectedAt: string;
  details?: DockerContainerDetails;
};
export type DockerMetricSample = DockerHostSample | DockerContainerSample;
export type DockerMetricRollup = {
  id: string;
  vpsId: string;
  agentInstanceId: string;
  scope: DockerScope;
  metricName?: string;
  containerKey?: string;
  cohortDigest?: string;
  bucketStart: string;
  formulaVersion: number;
  firstAt: string;
  lastAt: string;
  sampleCount: number;
  gaugeMin?: number;
  gaugeMax?: number;
  gaugeSum?: number;
  gaugeAverage?: number;
  counterFirst?: number;
  counterLast?: number;
  counterIncrease?: number;
  resetCount: number;
  expectedSamples: number;
  observedSamples: number;
  partialSampleCount: number;
  gapCount: number;
  coverageRatio: number;
};
export type DockerOperationalEvent = {
  id: string;
  vpsId: string;
  agentInstanceId: string;
  containerKey?: string;
  action: DockerEventAction;
  eventOccurredAt: string;
  receivedAt: string;
  eventDigest: string;
  contextVersion: 1;
  healthStatus?: "healthy" | "unhealthy" | "starting" | "none";
  exitCode?: number;
  signal?: number;
  oomKilled?: boolean;
};
export type DockerStorageLatest = {
  vpsId: string;
  agentInstanceId: string;
  snapshotId: string;
  collectedAt: string;
  receivedAt: string;
  images: DockerStorageCategory;
  containers: DockerStorageCategory;
  localVolumes: DockerStorageCategory;
  buildCache: DockerStorageCategory;
  formulaVersion: 1;
};
export type DockerStorageCategory = {
  supported: boolean;
  count: number;
  totalBytes: number;
  reclaimableBytes?: number;
  reclaimableSupported?: boolean;
  estimatedReclaimableBytes?: number;
};
export type DockerSourceSequence = string;
export type DockerEventWatermark = {
  vpsId: string;
  agentInstanceId: string;
  timeNano: string;
  boundaryDigests: string[];
  committedBatchId?: string;
  updatedAt: string;
};
export type DockerInitialWatermark = { timeNano: "0"; boundaryDigests: [] };
export type DockerIngestEvent = DockerOperationalEvent & {
  sourceSequence: DockerSourceSequence;
};
export type DockerEventProtocol = {
  fromWatermark: DockerEventWatermark;
  proposedWatermark: DockerEventWatermark;
  eventWindow: { from: string; to: string };
};
export type DockerMonitoringMetadata = {
  effectiveCadenceSeconds: number;
  availability: "available" | "unavailable" | "unknown";
  state: "enabled" | "disabled" | "unknown";
};
export type DockerIngestAuth = {
  credentialId?: string;
  credentialCreatedAt?: string;
  isCurrentGeneration?: boolean;
};
export type DockerIngestUnit = {
  vpsId: string;
  agentInstanceId: string;
  snapshotId: string;
  batchId?: string;
  requestDigest: string;
  requestDigestVersion: number;
  /** Rebuild the v1 projection using the original ledger receive timestamp. */
  legacyRequestDigest?: (receivedAt: string) => string;
  receivedAt: string;
  sourceSequence: DockerSourceSequence;
  hostSample: DockerHostSample;
  containerSamples?: DockerContainerSample[];
  events?: DockerIngestEvent[];
  storageLatest?: DockerStorageLatest;
  eventProtocol?: DockerEventProtocol;
  monitoring?: DockerMonitoringMetadata;
  available?: boolean;
  errorCode?: string;
  engineVersion?: string;
  apiVersion?: string;
  auth?: DockerIngestAuth;
};
export type DockerIngestBatchResult = {
  status: "committed" | "already_committed" | "replay_ignored";
  snapshotId: string;
  revision: number;
  committedWatermark?: DockerEventWatermark;
};
export type DockerIngestBatch = {
  vpsId: string;
  agentInstanceId: string;
  batchId: string;
  snapshotId: string;
  requestDigest: string;
  result: DockerIngestBatchResult | string;
  revision?: number;
};
export type DockerIngestConflictCode =
  | "request_digest_mismatch"
  | "source_sequence_conflict"
  | "watermark_conflict"
  | "active_instance_conflict"
  | "snapshot_conflict"
  | "batch_conflict";
export class DockerIngestConflict extends Error {
  readonly code: DockerIngestConflictCode;
  constructor(code: DockerIngestConflictCode, message = code) {
    super(message);
    this.name = "DockerIngestConflict";
    this.code = code;
  }
}
export class DockerIngestCapacityRefused extends Error {
  readonly code = "history_capacity_refused" as const;
  readonly retryable = true;
  constructor(message = "Docker ingest history capacity refused") {
    super(message);
    this.name = "DockerIngestCapacityRefused";
  }
}
export type DockerIngestResult = {
  vpsId: string;
  ingestStatus:
    "committed" | "already_committed" | "replay_ignored" | "rejected";
  status?: "history_capacity_refused" | string;
  snapshotId: string;
  agentInstanceId: string;
  batchId?: string;
  receivedAt: string;
  committedWatermark?: DockerEventWatermark;
  revision: number;
};
export type DockerMonitoringSnapshot = {
  vpsId: string;
  snapshotId: string;
  agentInstanceId: string;
  requestDigest: string;
  sourceSequence: DockerSourceSequence;
  result: DockerIngestBatchResult;
  receivedAt: string;
  revision: number;
};
export type DockerAuthoritativeLatest = {
  activeInstanceId: string;
  snapshotId: string;
  sourceSequence: DockerSourceSequence;
  receivedAt: string;
  updatedAt: string;
  revision: number;
  available?: boolean;
  errorCode?: string;
  engineVersion?: string;
  apiVersion?: string;
  credentialId?: string;
  credentialCreatedAt?: string;
};
export type DockerUnavailableRuleState = {
  vpsId: string;
  window: Array<"available" | "unavailable">;
  alert: {
    state: "open" | "acknowledged";
    openedAt: string;
    lastObservedAt: string;
    occurrences: number;
    acknowledgedAt?: string;
    acknowledgedBy?: string;
  } | null;
};
export type DockerAlert = {
  id: string;
  vpsId: string;
  agentInstanceId?: string;
  ruleKind: string;
  containerKey?: string;
  state: DockerAlertState;
  fingerprint: string;
  openedAt: string;
  lastObservedAt?: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  occurrences: number;
  summary: string;
  resolutionReason?: DockerAlertResolutionReason;
  contextVersion: 1;
};
export type DockerMonitoringStore = {
  schemaVersion: number;
  revision: number;
  lastMaintenanceAt?: string;
  samples: DockerMetricSample[];
  rollups: DockerMetricRollup[];
  events: DockerOperationalEvent[];
  latestStorage: Record<string, DockerStorageLatest>;
  latestByVps: Record<string, DockerAuthoritativeLatest>;
  snapshots: DockerMonitoringSnapshot[];
  watermarks: DockerEventWatermark[];
  batches: DockerIngestBatch[];
  alerts: DockerAlert[];
  alertRuleStates: Record<
    string,
    DockerUnavailableRuleState | DockerTypedAlertState
  >;
  retiredInstancesByVps?: Record<string, string[]>;
};

export type DockerListScope =
  "host" | "container" | "events" | "alerts" | "rollups";
export type DockerListQuery = {
  vpsId: string;
  scope: DockerListScope;
  limit?: number;
  from?: string;
  to?: string;
  cursor?: string;
  agentInstanceId?: string;
  containerKey?: string;
  action?: DockerEventAction;
  state?: DockerAlertState;
  ruleKind?: string;
};
export type DockerPage<T> = {
  data: T[];
  page: { limit: number; nextCursor?: string; hasMore: boolean };
};
export type DockerCursorPayload = {
  v: 1;
  vpsId: string;
  scope: DockerListScope;
  agentInstanceId?: string;
  containerKey?: string;
  filters: Record<string, string | undefined>;
  order:
    | "effectiveAt,id"
    | "eventOccurredAt,id"
    | "lastObservedAt,id"
    | "bucketStart,id";
  last: { at: string; id: string };
};
