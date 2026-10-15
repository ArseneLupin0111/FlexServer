import { Inject, Injectable } from "@nestjs/common";
import type { CommandJob } from "../jobs/jobs.models.js";
import type { JobRepository } from "../persistence/repositories/job.repository.js";
import { JOB_REPOSITORY } from "../tokens.js";
import { JobActivityService } from "./job-activity.service.js";

/**
 * Context provided to each running task so it can report progress and outcome.
 */
export type JobTaskContext = {
  jobId: string;
  /** Update progress/step and optionally more fields on the job. */
  update(
    step: string,
    progress: number,
    patch?: Partial<CommandJob>,
  ): Promise<void>;
  /** Mark job as failed with a sanitised error message. */
  fail(step: string, error: unknown): Promise<void>;
  /** Mark job as succeeded. */
  succeed(step?: string, patch?: Partial<CommandJob>): Promise<void>;
};

const SENSITIVE_PATTERNS: RegExp[] = [
  // Authorization: Bearer <token>
  /(bearer\s+)[A-Za-z0-9._~+/-]+(=*)/gi,
  // JSON-like "token" or "authorization" values
  /"token"\s*:\s*"[^"]+"/gi,
  /"authorization"\s*:\s*"[^"]+"/gi,
  /token\s*[:=]\s*\S+/gi,
  /\bvma_[A-Za-z0-9_-]+\b/g,
];

function redactSensitive(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match, prefix) => {
      // Preserve the key/prefix, redact only the value portion
      return prefix ? `${prefix}[REDACTED]` : "[REDACTED]";
    });
  }
  return result;
}

export function sanitiseError(error: unknown): string {
  let message: string;

  if (error instanceof Error) {
    // Strip stack and keep only message
    message = error.message;
  } else {
    try {
      message = String(error);
    } catch {
      message = "An unknown error occurred";
    }
  }

  // Cap length to avoid giant token dumps
  if (message.length > 500) {
    message = message.slice(0, 500) + "...";
  }

  // Normalize multiline to single line for storage/display
  message = message.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

  // Redact sensitive patterns
  message = redactSensitive(message);

  return message;
}

/**
 * Minimal in-process job runner.
 *
 * **Phase-1 limitation:** Jobs are lost if the backend restarts.
 * Production use requires a durable queue/worker (e.g. Bull/BullMQ).
 */
@Injectable()
export class JobRunnerService {
  constructor(
    @Inject(JOB_REPOSITORY) private readonly jobRepository: JobRepository,
    @Inject(JobActivityService) private readonly activity: JobActivityService,
  ) {}

  /**
   * Start a job asynchronously.
   *
   * @param job   The job to run (must already exist in the repository).
   * @param task  Async function that performs the actual work.
   */
  start(job: CommandJob, task: (ctx: JobTaskContext) => Promise<void>): void {
    // Fire-and-forget: we do not return a promise to the caller.
    // The caller receives the jobId synchronously and can poll.
    this.run(job, task).catch(() => {
      // Top-level errors are handled inside run() by the fail() path.
    });
  }

  private async run(
    job: CommandJob,
    task: (ctx: JobTaskContext) => Promise<void>,
  ): Promise<void> {
    const ctx: JobTaskContext = {
      jobId: job.id,

      update: async (
        step: string,
        progress: number,
        patch?: Partial<CommandJob>,
      ) => {
        const updated = await this.jobRepository.update(job.id, {
          status: "running",
          step,
          progress,
          ...patch,
        });
        if (updated) this.activity.publish(updated);
      },

      fail: async (step: string, error: unknown) => {
        const message = sanitiseError(error);
        const updated = await this.jobRepository.update(job.id, {
          status: "failed",
          step,
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        if (updated) this.activity.publish(updated);
      },

      succeed: async (step?: string, patch?: Partial<CommandJob>) => {
        const updated = await this.jobRepository.update(job.id, {
          status: "succeeded",
          step: step ?? "complete",
          progress: 100,
          finishedAt: new Date().toISOString(),
          ...patch,
        });
        if (updated) this.activity.publish(updated);
      },
    };

    // Mark as running
    const started = await this.jobRepository.update(job.id, {
      status: "running",
      step: "started",
      startedAt: new Date().toISOString(),
      progress: 0,
    });
    if (started) this.activity.publish(started);

    try {
      await task(ctx);
    } catch (error: unknown) {
      // ctx.fail calls sanitiseError internally — pass raw error, not pre-sanitized
      await ctx.fail("error", error);
    }
  }
}
