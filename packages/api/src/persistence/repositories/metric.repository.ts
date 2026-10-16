import type { MetricSample } from "../../metrics/metrics.models.js";
import type { PaginationParams } from "../../common/pagination.js";
import { readJsonFile, writeJsonFile, withFileLock } from "./json-file.js";

const DEFAULT_WINDOW_CAP = 120;

// ── Storage shape ──────────────────────────────────────────────────────
// Supports migration from old `{ metrics: MetricSample[] }` format.

type MetricFile = {
  latest: Record<string, MetricSample>;
  windows: Record<string, MetricSample[]>;
};

// Old format for migration detection
type OldMetricFile = { metrics: MetricSample[] };

function isOldFormat(data: unknown): data is OldMetricFile {
  return Array.isArray((data as OldMetricFile).metrics);
}

function migrateToNew(old: OldMetricFile): MetricFile {
  const latest: Record<string, MetricSample> = {};
  const windows: Record<string, MetricSample[]> = {};
  for (const sample of old.metrics) {
    latest[sample.vpsId] = sample;
    if (!windows[sample.vpsId]) windows[sample.vpsId] = [];
    windows[sample.vpsId].push(sample);
  }
  // Sort by collectedAt (oldest first) and cap to default limit
  for (const vpsId of Object.keys(windows)) {
    windows[vpsId].sort(
      (a, b) =>
        new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime(),
    );
    if (windows[vpsId].length > DEFAULT_WINDOW_CAP) {
      windows[vpsId] = windows[vpsId].slice(
        windows[vpsId].length - DEFAULT_WINDOW_CAP,
      );
    }
  }
  return { latest, windows };
}

async function readMetricFile(filePath: string): Promise<MetricFile> {
  const data = await readJsonFile<unknown>(filePath, {
    latest: {},
    windows: {},
  });
  if (isOldFormat(data)) {
    return migrateToNew(data);
  }
  return data as MetricFile;
}

function capWindow(window: MetricSample[], limit: number): MetricSample[] {
  if (window.length > limit) {
    return window.slice(window.length - limit);
  }
  return window;
}

function sortLatestDesc(samples: MetricSample[]): MetricSample[] {
  return [...samples].sort((a, b) => {
    const aTime = new Date(a.receivedAt ?? a.collectedAt).getTime();
    const bTime = new Date(b.receivedAt ?? b.collectedAt).getTime();
    if (bTime !== aTime) return bTime - aTime;
    return b.vpsId.localeCompare(a.vpsId);
  });
}

function applyPage(
  samples: MetricSample[],
  page?: PaginationParams,
): MetricSample[] {
  if (!page) return samples;
  return samples.slice(page.offset, page.offset + page.limit);
}

// ── Repository type ────────────────────────────────────────────────────

export type MetricRepository = {
  deleteByVps(vpsId: string): Promise<void>;
  /** Returns latest samples for each VPS (backward compat) */
  list(page?: PaginationParams): Promise<MetricSample[]>;
  /** Upserts latest + appends to bounded window */
  append(sample: MetricSample, windowCap?: number): Promise<MetricSample>;

  /** Returns all latest samples */
  listLatest(page?: PaginationParams): Promise<MetricSample[]>;
  /** Returns latest sample for a specific VPS */
  getLatest(vpsId: string): Promise<MetricSample | undefined>;
  /** Set/replace latest sample for a VPS */
  upsertLatest(sample: MetricSample): Promise<MetricSample>;
  /** Append sample to VPS window (bounded) */
  appendWindow(sample: MetricSample, limit?: number): Promise<void>;
  /** List window samples for a VPS (chronological oldest-first, capped) */
  listWindow(vpsId: string, limit?: number): Promise<MetricSample[]>;
};

// ── Factory ────────────────────────────────────────────────────────────

export function createJsonMetricRepository(
  filePath = "data/metrics.json",
): MetricRepository {
  return {
    async deleteByVps(vpsId) {
      await withFileLock(filePath, async () => {
        const data = await readMetricFile(filePath);
        delete data.latest[vpsId];
        delete data.windows[vpsId];
        await writeJsonFile(filePath, data);
      });
    },
    async list(page) {
      const data = await readMetricFile(filePath);
      return applyPage(sortLatestDesc(Object.values(data.latest)), page);
    },

    async append(sample, windowCap = DEFAULT_WINDOW_CAP) {
      return withFileLock(filePath, async () => {
        const data = await readMetricFile(filePath);
        data.latest[sample.vpsId] = sample;
        if (!data.windows[sample.vpsId]) data.windows[sample.vpsId] = [];
        data.windows[sample.vpsId].push(sample);
        data.windows[sample.vpsId] = capWindow(
          data.windows[sample.vpsId],
          windowCap,
        );
        await writeJsonFile(filePath, data);
        return sample;
      });
    },

    async listLatest(page) {
      const data = await readMetricFile(filePath);
      return applyPage(sortLatestDesc(Object.values(data.latest)), page);
    },

    async getLatest(vpsId: string) {
      const data = await readMetricFile(filePath);
      return data.latest[vpsId];
    },

    async upsertLatest(sample) {
      return withFileLock(filePath, async () => {
        const data = await readMetricFile(filePath);
        data.latest[sample.vpsId] = sample;
        await writeJsonFile(filePath, data);
        return sample;
      });
    },

    async appendWindow(sample, limit = DEFAULT_WINDOW_CAP) {
      return withFileLock(filePath, async () => {
        const data = await readMetricFile(filePath);
        if (!data.windows[sample.vpsId]) data.windows[sample.vpsId] = [];
        data.windows[sample.vpsId].push(sample);
        data.windows[sample.vpsId] = capWindow(
          data.windows[sample.vpsId],
          limit,
        );
        await writeJsonFile(filePath, data);
      });
    },

    /** List window samples for a VPS in chronological order (oldest first), capped */
    async listWindow(vpsId: string, limit?: number) {
      const data = await readMetricFile(filePath);
      const window = data.windows[vpsId] ?? [];
      if (limit !== undefined && window.length > limit) {
        return window.slice(window.length - limit);
      }
      return [...window];
    },
  };
}
