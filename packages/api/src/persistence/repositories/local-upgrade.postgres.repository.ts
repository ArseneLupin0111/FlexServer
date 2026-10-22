import type { Pool } from "pg";
import type {
  LocalUpgradeJob,
  LocalUpgradeResult,
  LocalUpgradeError,
  LocalUpgradeState,
  UpdaterHeartbeat,
} from "../../local-upgrade/local-upgrade.models.js";
import { LocalUpgradeUniqueViolationError } from "../../local-upgrade/local-upgrade.models.js";
import type {
  LocalUpgradeListOptions,
  LocalUpgradeRepository,
  LocalUpgradeWritePatch,
} from "./local-upgrade.repository.js";
import {
  optionalIsoString,
  requiredIsoString,
  toDateOrNull,
  toJsonOrNull,
} from "./postgres-mappers.js";

type LocalUpgradeRow = {
  id: string;
  vps_id: string;
  state: LocalUpgradeState;
  progress: number | null;
  release_id: string;
  release_version: string;
  release_build_id: string;
  target_sha256: string;
  target_url: string;
  target_size_bytes: string | null;
  manifest_raw: string;
  baseline_build_id: string | null;
  baseline_heartbeat_at: Date | string | null;
  actor: string;
  idempotency_key: string | null;
  fencing_token: string | number;
  reclaim_count: number;
  claimed_at: Date | string | null;
  lease_expires_at: Date | string | null;
  deadline_at: Date | string;
  phase_deadline_at: Date | string | null;
  message: string | null;
  error_code: string | null;
  error_message: string | null;
  result: LocalUpgradeResult | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  components: string[] | null;
  manifest_sha256: string | null;
};

type UpdaterHeartbeatRow = {
  vps_id: string;
  last_seen_at: Date | string;
  credential_id: string | null;
  protocol_version: number | null;
  updater_version: string | null;
  platform: { os: string; arch: string } | null;
  idle: boolean | null;
  busy_reason: string | null;
  installed_ai: string[] | null;
  ai_health: { status: string; healthy: boolean } | null;
};

function rowToJob(row: LocalUpgradeRow): LocalUpgradeJob {
  return {
    id: row.id,
    vpsId: row.vps_id,
    state: row.state,
    progress: row.progress ?? null,
    releaseId: row.release_id,
    releaseVersion: row.release_version,
    releaseBuildId: row.release_build_id,
    targetSha256: row.target_sha256,
    targetUrl: row.target_url,
    ...(row.target_size_bytes == null
      ? {}
      : { targetSizeBytes: Number(row.target_size_bytes) }),
    ...(row.components ? { components: row.components } : {}),
    ...(row.manifest_sha256 ? { manifestSha256: row.manifest_sha256 } : {}),
    manifestRaw: row.manifest_raw,
    ...(row.baseline_build_id == null
      ? {}
      : { baselineBuildId: row.baseline_build_id }),
    ...(row.baseline_heartbeat_at == null
      ? {}
      : { baselineHeartbeatAt: requiredIsoString(row.baseline_heartbeat_at) }),
    actor: row.actor,
    ...(row.idempotency_key == null
      ? {}
      : { idempotencyKey: row.idempotency_key }),
    fencingToken: Number(row.fencing_token),
    reclaimCount: row.reclaim_count,
    claimedAt:
      row.claimed_at == null ? null : requiredIsoString(row.claimed_at),
    leaseExpiresAt:
      row.lease_expires_at == null
        ? null
        : requiredIsoString(row.lease_expires_at),
    deadlineAt: requiredIsoString(row.deadline_at),
    ...(row.phase_deadline_at == null
      ? {}
      : { phaseDeadlineAt: requiredIsoString(row.phase_deadline_at) }),
    ...(row.message == null ? {} : { message: row.message }),
    error:
      row.error_code == null
        ? null
        : {
            code: row.error_code,
            message: row.error_message ?? "",
          },
    result: row.result ?? null,
    revision: row.revision,
    createdAt: requiredIsoString(row.created_at),
    updatedAt: requiredIsoString(row.updated_at),
    completedAt:
      row.completed_at == null ? null : requiredIsoString(row.completed_at),
  };
}

const COLUMNS: Record<
  Exclude<keyof LocalUpgradeWritePatch, "error" | "result">,
  string
> = {
  state: "state",
  progress: "progress",
  releaseVersion: "release_version",
  releaseBuildId: "release_build_id",
  targetSha256: "target_sha256",
  targetUrl: "target_url",
  targetSizeBytes: "target_size_bytes",
  baselineBuildId: "baseline_build_id",
  baselineHeartbeatAt: "baseline_heartbeat_at",
  actor: "actor",
  idempotencyKey: "idempotency_key",
  fencingToken: "fencing_token",
  reclaimCount: "reclaim_count",
  claimedAt: "claimed_at",
  leaseExpiresAt: "lease_expires_at",
  deadlineAt: "deadline_at",
  phaseDeadlineAt: "phase_deadline_at",
  message: "message",
  completedAt: "completed_at",
  components: "components",
  manifestSha256: "manifest_sha256",
};

const DATE_FIELDS = new Set([
  "baselineHeartbeatAt",
  "claimedAt",
  "leaseExpiresAt",
  "deadlineAt",
  "phaseDeadlineAt",
  "completedAt",
]);

const INTEGER_FIELDS = new Set([
  "progress",
  "fencingToken",
  "reclaimCount",
  "targetSizeBytes",
]);

export function createPostgresLocalUpgradeRepository(
  pool: Pool,
): LocalUpgradeRepository {
  return {
    async deleteByVps(vpsId) {
      await pool.query("DELETE FROM local_agent_upgrade_jobs WHERE vps_id=$1", [vpsId]);
      await pool.query("DELETE FROM updater_heartbeats WHERE vps_id=$1", [vpsId]);
    },
    async create(job) {
      try {
        await pool.query(
          `INSERT INTO local_agent_upgrade_jobs (
             id, vps_id, state, progress, release_id, release_version,
             release_build_id, target_sha256, target_url, target_size_bytes,
             manifest_raw, baseline_build_id, actor, idempotency_key,
             fencing_token, reclaim_count, claimed_at, lease_expires_at,
             deadline_at, phase_deadline_at, revision, created_at, updated_at,
             components, manifest_sha256
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
          [
            job.id,
            job.vpsId,
            job.state,
            job.progress,
            job.releaseId,
            job.releaseVersion,
            job.releaseBuildId,
            job.targetSha256,
            job.targetUrl,
            job.targetSizeBytes ?? null,
            job.manifestRaw,
            job.baselineBuildId ?? null,
            job.actor,
            job.idempotencyKey ?? null,
            job.fencingToken,
            job.reclaimCount,
            toDateOrNull(job.claimedAt),
            toDateOrNull(job.leaseExpiresAt),
            new Date(job.deadlineAt),
            toDateOrNull(job.phaseDeadlineAt),
            0,
            new Date(job.createdAt),
            new Date(job.updatedAt),
            toJsonOrNull(job.components),
            job.manifestSha256 ?? null,
          ],
        );
        return job;
      } catch (error: unknown) {
        const pgError = error as { code?: string; constraint?: string };
        if (pgError.code !== "23505") throw error;
        if (pgError.constraint?.endsWith("_idem")) {
          const existing = await pool.query<{ id: string }>(
            "SELECT id FROM local_agent_upgrade_jobs WHERE vps_id = $1 AND idempotency_key = $2",
            [job.vpsId, job.idempotencyKey],
          );
          throw new LocalUpgradeUniqueViolationError(
            "idempotency",
            existing.rows[0]?.id,
          );
        }
        const active = await pool.query<{ id: string }>(
          `SELECT id FROM local_agent_upgrade_jobs
           WHERE vps_id = $1 AND state NOT IN ('succeeded','rolled_back','rollback_unverified','failed')`,
          [job.vpsId],
        );
        throw new LocalUpgradeUniqueViolationError(
          "active",
          active.rows[0]?.id,
        );
      }
    },

    async get(id) {
      const result = await pool.query<LocalUpgradeRow>(
        "SELECT * FROM local_agent_upgrade_jobs WHERE id = $1",
        [id],
      );
      return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
    },

    async getActiveByVps(vpsId) {
      const result = await pool.query<LocalUpgradeRow>(
        `SELECT * FROM local_agent_upgrade_jobs
         WHERE vps_id = $1 AND state NOT IN ('succeeded','rolled_back','rollback_unverified','failed')
         LIMIT 1`,
        [vpsId],
      );
      return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
    },

    async getByIdempotencyKey(vpsId, idempotencyKey) {
      const result = await pool.query<LocalUpgradeRow>(
        "SELECT * FROM local_agent_upgrade_jobs WHERE vps_id = $1 AND idempotency_key = $2",
        [vpsId, idempotencyKey],
      );
      return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
    },

    async listByVps(vpsId, options: LocalUpgradeListOptions = {}) {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      const result = await pool.query<LocalUpgradeRow>(
        `SELECT * FROM local_agent_upgrade_jobs
         WHERE vps_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [vpsId, limit, offset],
      );
      return result.rows.map(rowToJob);
    },

    async compareAndSet(id, expectedRevision, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [id, expectedRevision];
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (field === "error") {
          const error = value as LocalUpgradeError | undefined;
          values.push(error?.code ?? null, error?.message ?? null);
          assignments.push(
            `error_code = $${values.length - 1}, error_message = $${values.length}`,
          );
          continue;
        }
        if (field === "result") {
          // jsonb column: stringify explicitly (migration 021) — COLUMNS
          // excludes "result", so this must run before the column lookup.
          values.push(value === null ? null : JSON.stringify(value));
          assignments.push(`result = $${values.length}`);
          continue;
        }
        if (field === "components") {
          values.push(value === null ? null : JSON.stringify(value));
          assignments.push(`components = $${values.length}`);
          continue;
        }
        const column =
          COLUMNS[field as Exclude<keyof LocalUpgradeWritePatch, "error" | "result">];
        if (!column) continue;
        if (DATE_FIELDS.has(field)) {
          values.push(toDateOrNull(value as string | undefined));
        } else if (INTEGER_FIELDS.has(field)) {
          values.push(value === null ? null : Number(value));
        } else {
          values.push(value);
        }
        assignments.push(`${column} = $${values.length}`);
      }
      if (assignments.length === 0) return undefined;
      const result = await pool.query<LocalUpgradeRow>(
        `UPDATE local_agent_upgrade_jobs
         SET ${assignments.join(", ")}, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND revision = $2
         RETURNING *`,
        values,
      );
      return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
    },

    async recordUpdaterHeartbeat(heartbeat) {
      await pool.query(
        `INSERT INTO updater_heartbeats (
           vps_id, last_seen_at, credential_id, protocol_version,
           updater_version, platform, idle, busy_reason, installed_ai, ai_health
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (vps_id) DO UPDATE SET
           last_seen_at = EXCLUDED.last_seen_at,
           credential_id = EXCLUDED.credential_id,
           protocol_version = EXCLUDED.protocol_version,
           updater_version = COALESCE(EXCLUDED.updater_version, updater_heartbeats.updater_version),
           platform = COALESCE(EXCLUDED.platform, updater_heartbeats.platform),
           idle = COALESCE(EXCLUDED.idle, updater_heartbeats.idle),
           busy_reason = COALESCE(EXCLUDED.busy_reason, updater_heartbeats.busy_reason),
           installed_ai = COALESCE(EXCLUDED.installed_ai, updater_heartbeats.installed_ai),
           ai_health = COALESCE(EXCLUDED.ai_health, updater_heartbeats.ai_health)`,
        [
          heartbeat.vpsId,
          new Date(heartbeat.lastSeenAt),
          heartbeat.credentialId ?? null,
          heartbeat.protocolVersion ?? 1,
          heartbeat.updaterVersion ?? null,
          toJsonOrNull(heartbeat.platform),
          heartbeat.idle ?? null,
          heartbeat.busyReason ?? null,
          toJsonOrNull(heartbeat.installedAi),
          toJsonOrNull(heartbeat.aiHealth),
        ],
      );
    },

    async getUpdaterHeartbeat(vpsId) {
      const result = await pool.query<UpdaterHeartbeatRow>(
        "SELECT * FROM updater_heartbeats WHERE vps_id = $1",
        [vpsId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        vpsId: row.vps_id,
        lastSeenAt: requiredIsoString(row.last_seen_at),
        protocolVersion: row.protocol_version ?? 1,
        ...(row.credential_id == null ? {} : { credentialId: row.credential_id }),
        ...(row.updater_version == null ? {} : { updaterVersion: row.updater_version }),
        ...(row.platform == null ? {} : { platform: row.platform }),
        ...(row.idle == null ? {} : { idle: row.idle }),
        ...(row.busy_reason == null ? {} : { busyReason: row.busy_reason }),
        ...(row.installed_ai == null ? {} : { installedAi: row.installed_ai }),
        ...(row.ai_health == null ? {} : { aiHealth: row.ai_health }),
      };
    },
  };
}
