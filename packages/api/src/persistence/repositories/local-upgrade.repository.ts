import { nanoid } from "nanoid";
import {
  readModifyWriteJsonFile,
  readJsonFile,
  withFileLock,
  writeJsonFile,
} from "./json-file.js";
import {
  EXECUTING_UPGRADE_STATES,
  isTerminalState,
  LocalUpgradeUniqueViolationError,
  type AgentConvergenceRecord,
  type LocalUpgradeError,
  type LocalUpgradeJob,
  type LocalUpgradeResult,
  type UpdaterHeartbeat,
} from "../../local-upgrade/local-upgrade.models.js";

export type LocalUpgradeListOptions = {
  limit?: number;
  offset?: number;
};

export type LocalUpgradeRepository = {
  deleteByVps(vpsId: string): Promise<void>;
  /**
   * Insert a new job. Enforces the single-active-job-per-VPS rule and
   * idempotency-key uniqueness; violations throw
   * LocalUpgradeUniqueViolationError ("idempotency" carries the existing id).
   */
  create(job: LocalUpgradeJob): Promise<LocalUpgradeJob>;
  get(id: string): Promise<LocalUpgradeJob | undefined>;
  getActiveByVps(vpsId: string): Promise<LocalUpgradeJob | undefined>;
  getByIdempotencyKey(
    vpsId: string,
    idempotencyKey: string,
  ): Promise<LocalUpgradeJob | undefined>;
  getByVpsAndRetryRequestKey(
    vpsId: string,
    retryKey: string,
  ): Promise<LocalUpgradeJob | undefined>;
  /** Newest first. */
  listByVps(
    vpsId: string,
    options?: LocalUpgradeListOptions,
  ): Promise<LocalUpgradeJob[]>;
  listActive(): Promise<LocalUpgradeJob[]>;
  getConvergence(vpsId: string): Promise<AgentConvergenceRecord | undefined>;
  updateConvergence(
    vpsId: string,
    patch: Partial<AgentConvergenceRecord>,
  ): Promise<AgentConvergenceRecord>;
  /**
   * Compare-and-set on the job revision. Returns the updated job, or
   * undefined when the expected revision is stale (another writer won).
   * revision is always incremented and updatedAt refreshed.
   */
  compareAndSet(
    id: string,
    expectedRevision: number,
    patch: LocalUpgradeWritePatch,
  ): Promise<LocalUpgradeJob | undefined>;
  recordUpdaterHeartbeat(heartbeat: UpdaterHeartbeat): Promise<void>;
  getUpdaterHeartbeat(
    vpsId: string,
  ): Promise<UpdaterHeartbeat | undefined>;
};

/** Fields a write may patch; identity and provenance are immutable. */
export type LocalUpgradeWritePatch = Partial<
  Omit<
    LocalUpgradeJob,
    | "id"
    | "vpsId"
    | "revision"
    | "createdAt"
    | "updatedAt"
    | "releaseId"
    | "manifestRaw"
    | "targetArch"
  >
>;

type LocalUpgradeFile = {
  jobs: LocalUpgradeJob[];
  updaterHeartbeats?: Record<string, UpdaterHeartbeat>;
  convergence?: Record<string, AgentConvergenceRecord>;
};

function findActive(jobs: LocalUpgradeJob[], vpsId: string) {
  return jobs.find((job) => job.vpsId === vpsId && !isTerminalState(job.state));
}

export function createJsonLocalUpgradeRepository(
  filePath = "data/local-upgrades.json",
): LocalUpgradeRepository {
  const fallback: LocalUpgradeFile = { jobs: [], updaterHeartbeats: {} };

  return {
    async deleteByVps(vpsId) {
      await withFileLock(filePath, async () => {
        const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
        data.jobs = data.jobs.filter(job => job.vpsId !== vpsId);
        if (data.updaterHeartbeats) delete data.updaterHeartbeats[vpsId];
        if (data.convergence) delete data.convergence[vpsId];
        await writeJsonFile(filePath, data);
      });
    },
    async create(job) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
        const active = findActive(data.jobs, job.vpsId);
        if (active) {
          throw new LocalUpgradeUniqueViolationError("active", active.id);
        }
        if (job.idempotencyKey) {
          const existing = data.jobs.find(
            (candidate) =>
              candidate.vpsId === job.vpsId &&
              candidate.idempotencyKey === job.idempotencyKey,
          );
          if (existing) {
            throw new LocalUpgradeUniqueViolationError(
              "idempotency",
              existing.id,
            );
          }
        }
        if (EXECUTING_UPGRADE_STATES.includes(job.state)) {
          const activeExecuting = data.jobs.find(
            (j) => EXECUTING_UPGRADE_STATES.includes(j.state),
          );
          if (activeExecuting) {
            throw new LocalUpgradeUniqueViolationError("global_active", activeExecuting.id);
          }
        }
        data.jobs.push({ ...job, revision: 0 });
        await writeJsonFile(filePath, data);
        return job;
      });
    },

    async get(id) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      return data.jobs.find((job) => job.id === id);
    },

    async getActiveByVps(vpsId) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      return findActive(data.jobs, vpsId);
    },

    async getByIdempotencyKey(vpsId, idempotencyKey) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      return data.jobs.find(
        (job) =>
          job.vpsId === vpsId && job.idempotencyKey === idempotencyKey,
      );
    },

    async getByVpsAndRetryRequestKey(vpsId, retryKey) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      return data.jobs.find(
        (job) => job.vpsId === vpsId && job.retryRequestKey === retryKey,
      );
    },

    async listByVps(vpsId, options) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      const jobs = data.jobs
        .filter((job) => job.vpsId === vpsId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 50;
      return jobs.slice(offset, offset + limit);
    },

    async listActive() {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      return data.jobs
        .filter((job) => !isTerminalState(job.state))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },

    async getConvergence(vpsId) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      return data.convergence?.[vpsId];
    },

    async updateConvergence(vpsId, patch) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
        data.convergence ??= {};
        const current: AgentConvergenceRecord = data.convergence[vpsId] ?? {
          vpsId,
          suppressedBuildId: null,
          suppressedReason: null,
          retryBuildId: null,
          retryKey: null,
          setupState: "unknown",
          setupReason: null,
          nextSetupAttemptAt: null,
        };
        const updated: AgentConvergenceRecord = {
          ...current,
          ...patch,
          vpsId,
        };
        data.convergence[vpsId] = updated;
        await writeJsonFile(filePath, data);
        return updated;
      });
    },

    async compareAndSet(id, expectedRevision, patch) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
        const index = data.jobs.findIndex((job) => job.id === id);
        if (index === -1) return undefined;
        const current = data.jobs[index]!;
        if (current.revision !== expectedRevision) return undefined;

        // Global executing job serialization: transition from queued to executing
        const isClaiming =
          current.state === "queued" &&
          (patch.state === "claimed" ||
            (patch.state != null && EXECUTING_UPGRADE_STATES.includes(patch.state)));
        if (isClaiming) {
          const activeExecuting = data.jobs.find(
            (j) => j.id !== id && EXECUTING_UPGRADE_STATES.includes(j.state),
          );
          if (activeExecuting) {
            throw new LocalUpgradeUniqueViolationError("global_active", activeExecuting.id);
          }
        }

        const updated: LocalUpgradeJob = {
          ...current,
          ...patch,
          id: current.id,
          vpsId: current.vpsId,
          createdAt: current.createdAt,
          releaseId: current.releaseId,
          manifestRaw: current.manifestRaw,
          targetArch: current.targetArch,
          retryRequestKey: current.retryRequestKey,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        data.jobs[index] = updated;

        // Atomic suppression on terminal failures
        if (
          patch.state === "failed" ||
          patch.state === "rolled_back" ||
          patch.state === "rollback_unverified"
        ) {
          data.convergence ??= {};
          const currentConv = data.convergence[current.vpsId] ?? {
            vpsId: current.vpsId,
            suppressedBuildId: null,
            suppressedReason: null,
            retryBuildId: null,
            retryKey: null,
            setupState: "unknown",
            setupReason: null,
            nextSetupAttemptAt: null,
          };
          const reason =
            (patch.result as LocalUpgradeResult | undefined)?.reason ??
            (patch.error as LocalUpgradeError | undefined)?.message ??
            patch.state;
          const shouldClearRetry = Boolean(
            current.retryRequestKey &&
              currentConv.retryKey === current.retryRequestKey &&
              currentConv.retryBuildId === current.releaseBuildId,
          );
          data.convergence[current.vpsId] = {
            ...currentConv,
            suppressedBuildId: current.releaseBuildId,
            suppressedReason: reason,
            retryBuildId: shouldClearRetry ? null : currentConv.retryBuildId,
            retryKey: shouldClearRetry ? null : currentConv.retryKey,
          };
        } else if (patch.state === "succeeded") {
          if (data.convergence?.[current.vpsId]) {
            const conv = data.convergence[current.vpsId];
            if (conv.suppressedBuildId === current.releaseBuildId) {
              conv.suppressedBuildId = null;
              conv.suppressedReason = null;
            }
            if (
              current.retryRequestKey &&
              conv.retryKey === current.retryRequestKey &&
              conv.retryBuildId === current.releaseBuildId
            ) {
              conv.retryBuildId = null;
              conv.retryKey = null;
            }
          }
        }

        await writeJsonFile(filePath, data);
        return updated;
      });
    },

    async recordUpdaterHeartbeat(heartbeat) {
      await readModifyWriteJsonFile<LocalUpgradeFile>(
        filePath,
        fallback,
        (data) => {
          data.updaterHeartbeats ??= {};
          data.updaterHeartbeats[heartbeat.vpsId] = heartbeat;
          return data;
        },
      );
    },

    async getUpdaterHeartbeat(vpsId) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      return data.updaterHeartbeats?.[vpsId];
    },
  };
}

/** Nanoid default alphabet is URL-safe [A-Za-z0-9_-] — safe for systemd instances. */
export function newLocalUpgradeId(): string {
  return `lug_${nanoid(12)}`;
}
