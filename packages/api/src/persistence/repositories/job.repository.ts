import { nanoid } from "nanoid";
import type { CommandJob } from "../../jobs/jobs.models.js";
import type { PaginationParams } from "../../common/pagination.js";
import { readJsonFile, writeJsonFile, withFileLock } from "./json-file.js";

type JobFile = { jobs: CommandJob[] };

export type JobRepository = {
  list(page?: PaginationParams): Promise<CommandJob[]>;
  get(id: string): Promise<CommandJob | undefined>;
  create(
    job: Omit<CommandJob, "id"> & { id?: string },
    historyLimit?: number,
  ): Promise<CommandJob>;
  update(
    id: string,
    patch: Partial<Omit<CommandJob, "id">>,
  ): Promise<CommandJob | undefined>;
  /**
   * Delete every job for a VPS. Returns the number removed.
   * Mirrors Postgres `jobs.vps_id ... ON DELETE CASCADE`.
   */
  deleteByVps(vpsId: string): Promise<number>;
  append(
    job: Omit<CommandJob, "id"> & { id?: string },
    historyLimit?: number,
  ): Promise<CommandJob>;
};
function normalizeJob(job: CommandJob): CommandJob {
  return {
    ...job,
    progress: job.progress ?? 0,
    updatedAt: job.updatedAt ?? job.startedAt ?? new Date().toISOString(),
  };
}

/**
 * Sort jobs newest-first by updatedAt (desc), then id (desc) for stable ordering.
 */
function sortJobsDesc(jobs: CommandJob[]): CommandJob[] {
  return [...jobs].sort((a, b) => {
    const aTime = new Date(a.updatedAt ?? a.startedAt ?? 0).getTime();
    const bTime = new Date(b.updatedAt ?? b.startedAt ?? 0).getTime();
    if (bTime !== aTime) return bTime - aTime;
    return b.id.localeCompare(a.id);
  });
}

/**
 * Terminal statuses (finished jobs).
 */
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Trim the jobs array to stay within `historyLimit`.
 *
 * Rule: keep ALL queued/running jobs.  Trim terminal jobs (oldest first)
 * until the total is within the cap.
 */
function trimJobs(jobs: CommandJob[], historyLimit: number): CommandJob[] {
  if (jobs.length <= historyLimit) return jobs;

  const active = jobs.filter((j) => !TERMINAL.has(j.status));
  const terminal = jobs.filter((j) => TERMINAL.has(j.status));

  // Sort terminal by updatedAt ascending so we drop the oldest first
  terminal.sort((a, b) => {
    const aTime = new Date(a.updatedAt ?? a.startedAt ?? 0).getTime();
    const bTime = new Date(b.updatedAt ?? b.startedAt ?? 0).getTime();
    return aTime - bTime;
  });

  const maxTerminal = Math.max(0, historyLimit - active.length);
  if (maxTerminal === 0) return active;
  const kept = terminal.slice(-maxTerminal);
  return [...kept, ...active];
}

export function createJsonJobRepository(
  filePath = "data/jobs.json",
): JobRepository {
  return {
    async list(page) {
      const data = await readJsonFile<JobFile>(filePath, { jobs: [] });
      let jobs = data.jobs.map(normalizeJob);
      jobs = sortJobsDesc(jobs);
      if (page) {
        return jobs.slice(page.offset, page.offset + page.limit);
      }
      return jobs;
    },

    async get(id: string) {
      const data = await readJsonFile<JobFile>(filePath, { jobs: [] });
      const job = data.jobs.find((j) => j.id === id);
      return job ? normalizeJob(job) : undefined;
    },

    async create(input, historyLimit) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<JobFile>(filePath, { jobs: [] });
        const job: CommandJob = {
          ...input,
          id: input.id ?? `job_${nanoid(12)}`,
          progress: input.progress ?? 0,
          updatedAt: new Date().toISOString(),
        };
        data.jobs.push(job);
        if (historyLimit !== undefined) {
          data.jobs = trimJobs(data.jobs, historyLimit);
        }
        await writeJsonFile(filePath, data);
        return job;
      });
    },

    async update(id: string, patch: Partial<Omit<CommandJob, "id">>) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<JobFile>(filePath, { jobs: [] });
        const index = data.jobs.findIndex((j) => j.id === id);
        if (index === -1) return undefined;
        data.jobs[index] = {
          ...data.jobs[index],
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(filePath, data);
        return data.jobs[index];
      });
    },
    async deleteByVps(vpsId) {
      let removed = 0;
      await withFileLock(filePath, async () => {
        const data = await readJsonFile<JobFile>(filePath, { jobs: [] });
        const kept = data.jobs.filter((j) => j.vpsId !== vpsId);
        removed = data.jobs.length - kept.length;
        if (removed > 0) {
          data.jobs = kept;
          await writeJsonFile(filePath, data);
        }
      });
      return removed;
    },
    async append(input, historyLimit) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<JobFile>(filePath, { jobs: [] });
        const job: CommandJob = {
          ...input,
          id: input.id ?? `job_${nanoid(12)}`,
          progress: input.progress ?? 0,
          updatedAt: new Date().toISOString(),
        };
        data.jobs.push(job);
        if (historyLimit !== undefined) {
          data.jobs = trimJobs(data.jobs, historyLimit);
        }
        await writeJsonFile(filePath, data);
        return job;
      });
    },
  };
}
