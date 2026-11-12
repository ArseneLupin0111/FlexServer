/** Docker management P2 contracts: durable, transport-abstract operations. */

export const DOCKER_MANAGEMENT_ACTIONS = [
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
  "remove",
] as const;

export type DockerManagementAction = (typeof DOCKER_MANAGEMENT_ACTIONS)[number];

export type DockerManagementStatus =
  | "queued"
  | "claimed"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DockerManagementTarget = {
  containerKey: string;
  agentInstanceId?: string;
};

export type DockerManagementResult = {
  ok: boolean;
  exitCode?: number;
  message?: string;
  outputPreview?: string;
};

export type DockerManagementOperation = {
  id: string;
  vpsId: string;
  idempotencyKey: string;
  requestDigest: string;
  action: DockerManagementAction;
  target: DockerManagementTarget;
  status: DockerManagementStatus;
  claimedBy?: string;
  leaseExpiresAt?: string;
  result?: DockerManagementResult;
  cancelReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type DockerManagementCancelReason =
  | "management_disabled"
  | "vps_deleted"
  | "user_cancelled";

export class DockerManagementConflict extends Error {
  readonly reason: "vps_mismatch" | "request_digest_mismatch" | "not_claimable";
  readonly operationId: string;

  constructor(
    reason: DockerManagementConflict["reason"],
    operationId: string,
  ) {
    super(`Docker management conflict: ${reason}`);
    this.reason = reason;
    this.operationId = operationId;
  }
}

/** Bounded limits enforced by every repository and the service. */
export const DOCKER_MANAGEMENT_CAPS = {
  /** Max persisted operations per VPS (newest-first truncation). */
  operationsPerVps: 500,
  /** Claim lease time-to-live in seconds. */
  claimLeaseSeconds: 120,
  /** Max list limit per read. */
  listLimit: 100,
} as const;
