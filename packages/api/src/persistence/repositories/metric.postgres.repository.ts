import { withTransaction, type DatabasePool } from "../../db/pool.js";
import type {
  MetricSample,
  MetricTrend,
} from "../../metrics/metrics.models.js";
import type { PaginationParams } from "../../common/pagination.js";
import type { MetricRepository } from "./metric.repository.js";
import {
  optionalIsoString,
  requiredIsoString,
  toDateOrNull,
  toJsonOrNull,
} from "./postgres-mappers.js";

const DEFAULT_WINDOW_CAP = 120;

type MetricRow = {
  id?: string | number | bigint | null;
  sample_id?: string | number | bigint | null;
  vps_id: string;
  cpu: number;
  memory: number;
  disk: number;
  load_average: number;
  network_rx: number;
  network_tx: number;
  uptime: number;
  collected_at: Date | string;
  received_at: Date | string | null;
  effective_at: Date | string;
  source: MetricSample["source"] | null;
  agent_version: string | null;
  trend: MetricTrend | null;
  network_unit: string | null;
  network_available: boolean | null;
};

export function createPostgresMetricRepository(
  pool: DatabasePool,
): MetricRepository {
  async function listLatest(page?: PaginationParams): Promise<MetricSample[]> {
    const result = page
      ? await pool.query<MetricRow>(
          "SELECT * FROM metric_latest ORDER BY effective_at DESC, vps_id DESC LIMIT $1 OFFSET $2",
          [page.limit, page.offset],
        )
      : await pool.query<MetricRow>(
          "SELECT * FROM metric_latest ORDER BY effective_at DESC, vps_id DESC",
        );
    return result.rows.map(rowToMetricSample);
  }

  return {
    async deleteByVps(vpsId) {
      await pool.query("DELETE FROM metric_samples WHERE vps_id=$1", [vpsId]);
      await pool.query("DELETE FROM metric_latest WHERE vps_id=$1", [vpsId]);
    },
    async list(page) {
      return listLatest(page);
    },
    async append(sample, _windowCap = DEFAULT_WINDOW_CAP) {
      return withTransaction(pool, async (client) => {
        const inserted = await insertSample(client, sample);
        await upsertLatest(client, sample, inserted.id);

        return sample;
      });
    },
    listLatest,
    async getLatest(vpsId) {
      const result = await pool.query<MetricRow>(
        "SELECT * FROM metric_latest WHERE vps_id = $1",
        [vpsId],
      );
      return result.rows[0] ? rowToMetricSample(result.rows[0]) : undefined;
    },
    async upsertLatest(sample) {
      await upsertLatest(pool, sample, null);
      return sample;
    },
    async appendWindow(sample, _limit = DEFAULT_WINDOW_CAP) {
      await insertSample(pool, sample);
    },
    async listWindow(vpsId, limit) {
      const effectiveLimit = normalizeWindowLimit(limit ?? DEFAULT_WINDOW_CAP);
      if (effectiveLimit === 0) return [];
      const result = await pool.query<MetricRow>(
        `SELECT * FROM (
          SELECT * FROM metric_samples WHERE vps_id = $1 ORDER BY effective_at DESC, id DESC LIMIT $2
        ) recent ORDER BY effective_at ASC, id ASC`,
        [vpsId, effectiveLimit],
      );
      return result.rows.map(rowToMetricSample);
    },
  };
}

function normalizeWindowLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("Metric window limit must be a non-negative integer");
  }
  return limit;
}

async function insertSample(
  client: Pick<DatabasePool, "query">,
  sample: MetricSample,
): Promise<{ id: string | number | bigint | null }> {
  const result = await client.query<{ id: string | number | bigint }>(
    `INSERT INTO metric_samples (vps_id, cpu, memory, disk, load_average, network_rx, network_tx, uptime,
      collected_at, received_at, effective_at, source, agent_version, trend, network_unit, network_available)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (vps_id, collected_at, effective_at) DO UPDATE SET
       cpu = EXCLUDED.cpu,
       memory = EXCLUDED.memory,
       disk = EXCLUDED.disk,
       load_average = EXCLUDED.load_average,
       network_rx = EXCLUDED.network_rx,
       network_tx = EXCLUDED.network_tx,
       uptime = EXCLUDED.uptime,
       received_at = EXCLUDED.received_at,
       source = EXCLUDED.source,
       agent_version = EXCLUDED.agent_version,
       trend = EXCLUDED.trend,
       network_unit = EXCLUDED.network_unit,
       network_available = EXCLUDED.network_available
     RETURNING id`,
    metricValues(sample),
  );
  return { id: result.rows[0]?.id ?? null };
}

async function upsertLatest(
  client: Pick<DatabasePool, "query">,
  sample: MetricSample,
  sampleId: string | number | bigint | null,
) {
  await client.query(
    `INSERT INTO metric_latest (vps_id, sample_id, cpu, memory, disk, load_average, network_rx, network_tx, uptime,
      collected_at, received_at, effective_at, source, agent_version, trend, network_unit, network_available, updated_at)
     VALUES ($1,$17,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (vps_id) DO UPDATE SET
       sample_id = COALESCE(EXCLUDED.sample_id, metric_latest.sample_id),
       cpu = EXCLUDED.cpu,
       memory = EXCLUDED.memory,
       disk = EXCLUDED.disk,
       load_average = EXCLUDED.load_average,
       network_rx = EXCLUDED.network_rx,
       network_tx = EXCLUDED.network_tx,
       uptime = EXCLUDED.uptime,
       collected_at = EXCLUDED.collected_at,
       received_at = EXCLUDED.received_at,
       effective_at = EXCLUDED.effective_at,
       source = EXCLUDED.source,
       agent_version = EXCLUDED.agent_version,
       trend = EXCLUDED.trend,
       network_unit = EXCLUDED.network_unit,
       network_available = EXCLUDED.network_available,
       updated_at = now()
     WHERE metric_latest.effective_at <= EXCLUDED.effective_at`,
    [...metricValues(sample), sampleId],
  );
}

function metricValues(sample: MetricSample): unknown[] {
  const effectiveAt = sample.receivedAt ?? sample.collectedAt;
  return [
    sample.vpsId,
    sample.cpu,
    sample.memory,
    sample.disk,
    sample.loadAverage,
    sample.networkRx,
    sample.networkTx,
    sample.uptime,
    new Date(sample.collectedAt),
    toDateOrNull(sample.receivedAt),
    new Date(effectiveAt),
    sample.source ?? null,
    sample.agentVersion ?? null,
    toJsonOrNull(sample.trend),
    sample.networkUnit ?? null,
    sample.networkAvailable ?? null,
  ];
}

function rowToMetricSample(row: MetricRow): MetricSample {
  return {
    vpsId: row.vps_id,
    cpu: Number(row.cpu),
    memory: Number(row.memory),
    disk: Number(row.disk),
    loadAverage: Number(row.load_average),
    networkRx: Number(row.network_rx),
    networkTx: Number(row.network_tx),
    uptime: Number(row.uptime),
    collectedAt: requiredIsoString(row.collected_at),
    receivedAt: optionalIsoString(row.received_at),
    source: row.source ?? undefined,
    agentVersion: row.agent_version ?? undefined,
    trend: row.trend ?? undefined,
    networkUnit: row.network_unit === "bytes/s" ? "bytes/s" : undefined,
    networkAvailable:
      row.network_available === null || row.network_available === undefined
        ? undefined
        : row.network_available,
  };
}
