import { nanoid } from "nanoid";
import { withTransaction, type DatabasePool } from "../../db/pool.js";
import type { CommandJob } from "../../jobs/jobs.models.js";
import type { PaginationParams } from "../../common/pagination.js";
import type { JobRepository } from "./job.repository.js";
import {
  optionalIsoString,
  requiredIsoString,
  toDateOrNull,
} from "./postgres-mappers.js";

type JobRow = {
  id: string;
  vps_id: string;
  type: string;
  status: CommandJob["status"];
  progress: number;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  exit_code: number | null;
  output_preview: string | null;
  error_message: string | null;
  worker_id: string | null;
  duration_ms: number | null;
  retry_count: number | null;
  error_log_url: string | null;
  step: string | null;
  updated_at: Date | string;
};

export function createPostgresJobRepository(pool: DatabasePool): JobRepository {
  async function get(id: string): Promise<CommandJob | undefined> {
    const result = await pool.query<JobRow>(
      "SELECT * FROM jobs WHERE id = $1",
      [id],
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
  }

  return {
    async list(page?: PaginationParams) {
      const result = page
        ? await pool.query<JobRow>(
            "SELECT * FROM jobs ORDER BY updated_at DESC, id DESC LIMIT $1 OFFSET $2",
            [page.limit, page.offset],
          )
        : await pool.query<JobRow>(
            "SELECT * FROM jobs ORDER BY updated_at DESC, id DESC",
          );
      return result.rows.map(rowToJob);
    },
    get,
    async create(input) {
      const job = {
        ...input,
        id: input.id ?? `job_${nanoid(12)}`,
        progress: input.progress ?? 0,
        updatedAt: new Date().toISOString(),
      };
      const result = await pool.query<JobRow>(
        `INSERT INTO jobs (id, vps_id, type, status, progress, started_at, finished_at, exit_code, output_preview,
          error_message, worker_id, duration_ms, retry_count, error_log_url, step, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        jobToValues(job),
      );
      return rowToJob(result.rows[0]!);
    },
    async update(id, patch) {
      return withTransaction(pool, async (client) => {
        const currentResult = await client.query<JobRow>(
          "SELECT * FROM jobs WHERE id = $1 FOR UPDATE",
          [id],
        );
        const current = currentResult.rows[0]
          ? rowToJob(currentResult.rows[0])
          : undefined;
        if (!current) return undefined;
        const next = {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        const result = await client.query<JobRow>(
          `UPDATE jobs SET vps_id=$2, type=$3, status=$4, progress=$5, started_at=$6, finished_at=$7,
            exit_code=$8, output_preview=$9, error_message=$10, worker_id=$11, duration_ms=$12,
            retry_count=$13, error_log_url=$14, step=$15, updated_at=$16
           WHERE id=$1 RETURNING *`,
          [id, ...jobToValues(next).slice(1)],
        );
        return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
      });
    },
    async deleteByVps(vpsId) {
      const result = await pool.query(
        "DELETE FROM jobs WHERE vps_id = $1",
        [vpsId],
      );
      return result.rowCount ?? 0;
    },
    async append(input) {
      return this.create(input);
    },
  };
}

function jobToValues(job: CommandJob): unknown[] {
  return [
    job.id,
    job.vpsId,
    job.type,
    job.status,
    job.progress ?? 0,
    toDateOrNull(job.startedAt),
    toDateOrNull(job.finishedAt),
    job.exitCode ?? null,
    job.outputPreview ?? null,
    job.errorMessage ?? null,
    job.workerId ?? null,
    job.durationMs ?? null,
    job.retryCount ?? null,
    job.errorLogUrl ?? null,
    job.step ?? null,
    new Date(job.updatedAt ?? new Date().toISOString()),
  ];
}

function rowToJob(row: JobRow): CommandJob {
  return {
    id: row.id,
    vpsId: row.vps_id,
    type: row.type,
    status: row.status,
    progress: row.progress ?? 0,
    startedAt: optionalIsoString(row.started_at),
    finishedAt: optionalIsoString(row.finished_at),
    exitCode: row.exit_code ?? undefined,
    outputPreview: row.output_preview ?? undefined,
    errorMessage: row.error_message ?? undefined,
    workerId: row.worker_id ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    retryCount: row.retry_count ?? undefined,
    errorLogUrl: row.error_log_url ?? undefined,
    step: row.step ?? undefined,
    updatedAt: requiredIsoString(row.updated_at),
  };
}
