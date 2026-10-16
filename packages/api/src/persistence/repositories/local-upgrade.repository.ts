import { nanoid } from "nanoid";
import {
  readModifyWriteJsonFile,
  readJsonFile,
  withFileLock,
  writeJsonFile,
} from "./json-file.js";
import {
  isTerminalState,
  LocalUpgradeUniqueViolationError,
  type LocalUpgradeJob,
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
  /** Newest first. */
  listByVps(
    vpsId: string,
    options?: LocalUpgradeListOptions,
  ): Promise<LocalUpgradeJob[]>;
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
  >
>;

type LocalUpgradeFile = {
  jobs: LocalUpgradeJob[];
  updaterHeartbeats?: Record<string, UpdaterHeartbeat>;
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

    async listByVps(vpsId, options) {
      const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
      const jobs = data.jobs
        .filter((job) => job.vpsId === vpsId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 50;
      return jobs.slice(offset, offset + limit);
    },

    async compareAndSet(id, expectedRevision, patch) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<LocalUpgradeFile>(filePath, fallback);
        const index = data.jobs.findIndex((job) => job.id === id);
        if (index === -1) return undefined;
        const current = data.jobs[index]!;
        if (current.revision !== expectedRevision) return undefined;
        const updated: LocalUpgradeJob = {
          ...current,
          ...patch,
          id: current.id,
          vpsId: current.vpsId,
          createdAt: current.createdAt,
          releaseId: current.releaseId,
          manifestRaw: current.manifestRaw,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        data.jobs[index] = updated;
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
