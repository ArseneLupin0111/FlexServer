// ── Local agent upgrade job model ────────────────────────────────────────
// Durable state machine for upgrading a local host's agent binary via the
// pull-only updater. Source of truth is the repository (JSON or Postgres);
// in-memory coordinators are never authoritative.

export type LocalUpgradeState =
  | "queued"
  | "claimed"
  | "downloading"
  | "verifying"
  | "staging"
  | "restarting"
  | "awaiting_heartbeat"
  | "rolling_back"
  | "succeeded"
  | "rolled_back"
  | "rollback_unverified"
  | "failed";

export const LOCAL_UPGRADE_TERMINAL_STATES: readonly LocalUpgradeState[] = [
  "succeeded",
  "rolled_back",
  "rollback_unverified",
  "failed",
];

/** Phases the updater may report via progress. */
export const LOCAL_UPGRADE_PROGRESS_PHASES = [
  "downloading",
  "verifying",
  "staging",
  "restarting",
  "awaiting_heartbeat",
  "rolling_back",
] as const;
export type LocalUpgradeProgressPhase =
  (typeof LOCAL_UPGRADE_PROGRESS_PHASES)[number];

/**
 * States at or past the binary swap point. A claim landing here must be
 * reconciled against the host journal before any further mutation: the API
 * never replays a swap itself and lease expiry must not cause one.
 */
export const LOCAL_UPGRADE_POST_SWAP_STATES: readonly LocalUpgradeState[] = [
  "restarting",
  "awaiting_heartbeat",
  "rolling_back",
];

export type LocalUpgradeOutcome =
  | "succeeded"
  | "rolled_back"
  | "rollback_unverified"
  | "failed";

export type LocalUpgradeError = {
  code: string;
  message: string;
};

export type LocalUpgradeResult = {
  outcome: LocalUpgradeOutcome;
  /** Build id the updater observed on disk (advisory; heartbeat is authority). */
  reportedBuildId?: string;
  /** Build id of the heartbeat that confirmed the terminal ruling. */
  heartbeatBuildId?: string;
  completedAt: string;
};

export type LocalUpgradeJob = {
  id: string;
  vpsId: string;
  state: LocalUpgradeState;
  /** Real percentage only; null until a phase reports one. */
  progress: number | null;
  /** Pinned at confirm time — later channel-pointer moves never retarget a job. */
  releaseId: string;
  releaseVersion: string;
  releaseBuildId: string;
  targetSha256: string;
  targetUrl: string;
  targetSizeBytes?: number;
  /** Verbatim signed manifest document as published (never re-canonicalized). */
  manifestRaw: string;
  /** Build id of the binary being replaced (captured at claim). */
  baselineBuildId?: string;
  /** Last agent heartbeat before the swap point (set when restarting is reported). */
  components?: string[];
  manifestSha256?: string;
  baselineHeartbeatAt?: string;
  actor: string;
  idempotencyKey?: string;
  /** Last journal message reported by the updater (ops-visible, ≤160 chars). */
  message?: string;
  fencingToken: number;
  reclaimCount: number;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  deadlineAt: string;
  phaseDeadlineAt?: string;
  error: LocalUpgradeError | null;
  result: LocalUpgradeResult | null;
  /** Optimistic-concurrency guard; every write increments it (CAS). */
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type UpdaterHeartbeat = {
  vpsId: string;
  lastSeenAt: string;
  credentialId?: string;
  protocolVersion?: number;
  updaterVersion?: string;
  platform?: { os: string; arch: string };
  idle?: boolean;
  busyReason?: string;
  installedAi?: string[];
  aiHealth?: { status: string; healthy: boolean };
};

// ── Timing policy ────────────────────────────────────────────────────────

/** Claim/progress lease TTL; every updater write extends it. */
export const LOCAL_UPGRADE_LEASE_TTL_MS = 60_000;
/** Whole-job deadline from creation. */
export const LOCAL_UPGRADE_OVERALL_DEADLINE_MS = 30 * 60_000;
/** Per-phase deadlines, reset on each phase transition. */
export const LOCAL_UPGRADE_PHASE_TIMEOUT_MS: Record<
  LocalUpgradeState,
  number
> = {
  queued: 5 * 60_000,
  claimed: 5 * 60_000,
  downloading: 5 * 60_000,
  verifying: 2 * 60_000,
  staging: 2 * 60_000,
  restarting: 2 * 60_000,
  awaiting_heartbeat: 10 * 60_000,
  rolling_back: 5 * 60_000,
  succeeded: 0,
  rolled_back: 0,
  rollback_unverified: 0,
  failed: 0,
};

/** Updater claim cadence expected from the host. */
export const UPDATER_CLAIM_CADENCE_MS = 60_000;
/** Updater counts as healthy when seen within this window (≈5 missed polls). */
export const UPDATER_HEALTH_TTL_MS = 5 * 60_000;

export function isTerminalState(state: LocalUpgradeState): boolean {
  return LOCAL_UPGRADE_TERMINAL_STATES.includes(state);
}

export function isPostSwapState(state: LocalUpgradeState): boolean {
  return LOCAL_UPGRADE_POST_SWAP_STATES.includes(state);
}

// ── Domain errors ────────────────────────────────────────────────────────

/**
 * Raised by repository create() when a unique constraint fires: either the
 * single-active-job rule (per VPS) or an idempotency-key replay.
 */
export class LocalUpgradeUniqueViolationError extends Error {
  constructor(
    public readonly kind: "active" | "idempotency",
    public readonly existingId?: string,
  ) {
    super(
      kind === "active"
        ? "An upgrade job is already active for this VPS"
        : "Idempotency key already used",
    );
    this.name = "LocalUpgradeUniqueViolationError";
  }
}

export class LocalUpgradeConflictError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly jobId?: string,
  ) {
    super(message);
    this.name = "LocalUpgradeConflictError";
  }
}

export class LocalUpgradeNotFoundError extends Error {
  constructor() {
    super("Upgrade job not found");
    this.name = "LocalUpgradeNotFoundError";
  }
}
