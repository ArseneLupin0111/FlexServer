import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { loadMigrations } from "../src/db/migrations.js";
import { createPostgresDockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.postgres.repository.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import {
  decodeDockerCursor,
  encodeDockerCursor,
} from "../src/docker/docker-monitoring.schemas.js";
import type {
  DockerAlert,
  DockerContainerSample,
  DockerHostSample,
  DockerOperationalEvent,
} from "../src/docker/docker-monitoring.models.js";

// PostgreSQL shared-conformance harness (I1). Direct SQL seed/cleanup with
// observable semantics matching the JSON backend:
// newest-first (at DESC, id DESC), VPS isolation, cursor binding, bounded
// keyset pagination, nullable fields omitted, I3 methods throw.
const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;

function sample(
  id: string,
  vpsId: string,
  effectiveAt: string,
): DockerHostSample {
  return {
    id,
    vpsId,
    agentInstanceId: "inst1",
    snapshotId: `snap_${id}`,
    collectedAt: effectiveAt,
    receivedAt: effectiveAt,
    effectiveAt,
    metrics: { cpu: 1 },
  };
}

function containerSample(
  id: string,
  vpsId: string,
  effectiveAt: string,
  agentInstanceId = "inst1",
  containerKey = "ck1",
): DockerContainerSample {
  return { ...sample(id, vpsId, effectiveAt), agentInstanceId, containerKey };
}

function event(id: string, vpsId: string, at: string): DockerOperationalEvent {
  return {
    id,
    vpsId,
    agentInstanceId: "inst1",
    action: "die",
    eventOccurredAt: at,
    receivedAt: at,
    eventDigest: `digest_${id}`,
    contextVersion: 1,
  };
}

function alert(id: string, vpsId: string, openedAt: string): DockerAlert {
  return {
    id,
    vpsId,
    ruleKind: "container_cpu_high",
    state: "open",
    fingerprint: `fp_${id}`,
    openedAt,
    occurrences: 1,
    summary: "s",
    contextVersion: 1,
  };
}

describe("docker monitoring repository (PostgreSQL, I1)", () => {
  const admin = databaseUrl
    ? new pg.Pool({ connectionString: databaseUrl })
    : undefined;
  const schema = `vps_manager_dm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let pool: pg.Pool | undefined;
  let repo: DockerMonitoringRepository | undefined;

  beforeAll(async () => {
    if (!databaseUrl || !admin) return;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      `CREATE TABLE vps (id text PRIMARY KEY, name text NOT NULL, host text NOT NULL, ` +
        `port integer NOT NULL, username text NOT NULL, created_at timestamptz NOT NULL, ` +
        `updated_at timestamptz NOT NULL)`,
    );
    const migration = (await loadMigrations()).find(
      (m) => m.id === "013_docker_monitoring.sql",
    )!;
    await pool.query(migration.sql);
    const ingestMigration = (await loadMigrations()).find(
      (m) => m.id === "014_docker_ingest.sql",
    )!;
    await pool.query(ingestMigration.sql);
    const alertResolutionMigration = (await loadMigrations()).find(
      (m) => m.id === "016_docker_alert_resolution.sql",
    )!;
    await pool.query(alertResolutionMigration.sql);
    const overviewMigration = (await loadMigrations()).find(
      (m) => m.id === "020_docker_v2_overview.sql",
    )!;
    await pool.query(overviewMigration.sql);
    const detailsMigration = (await loadMigrations()).find(
      (m) => m.id === "027_docker_container_details.sql",
    )!;
    await pool.query(detailsMigration.sql);
    repo = createPostgresDockerMonitoringRepository(pool as never);
  }, 30000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await admin
      ?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    if (!pool) return;
    for (const table of [
      "docker_metric_samples",
      "docker_metric_rollups",
      "docker_operational_events",
      "docker_storage_latest",
      "docker_event_watermarks",
      "docker_ingest_batches",
      "docker_alerts",
      "vps",
    ]) {
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  async function ensureVps(id: string): Promise<void> {
    await pool!.query(
      `INSERT INTO vps (id, name, host, port, username, created_at, updated_at) ` +
        `VALUES ($1, $1, 'host', 22, 'root', now(), now()) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
  }

  async function seedSamples(
    rows: Array<DockerHostSample | DockerContainerSample>,
  ): Promise<void> {
    for (const s of rows) {
      await ensureVps(s.vpsId);
      const c = s as DockerContainerSample;
      await pool!.query(
        `INSERT INTO docker_metric_samples ` +
          `(id, vps_id, agent_instance_id, snapshot_id, container_key, name, state, ` +
          `collected_at, received_at, effective_at, metrics, coverage, details) ` +
          `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          s.id,
          s.vpsId,
          s.agentInstanceId,
          s.snapshotId,
          c.containerKey ?? null,
          (c as { name?: string }).name ?? null,
          (c as { state?: string }).state ?? null,
          new Date(s.collectedAt),
          new Date(s.receivedAt),
          new Date(s.effectiveAt),
          JSON.stringify(s.metrics ?? {}),
          s.coverage !== undefined ? JSON.stringify(s.coverage) : null,
          c.details !== undefined ? JSON.stringify(c.details) : null,
        ],
      );
    }
  }

  async function seedEvents(rows: DockerOperationalEvent[]): Promise<void> {
    for (const e of rows) {
      await ensureVps(e.vpsId);
      await pool!.query(
        `INSERT INTO docker_operational_events ` +
          `(id, vps_id, agent_instance_id, container_key, action, event_occurred_at, ` +
          `received_at, event_digest, context_version, health_status, exit_code, signal, oom_killed) ` +
          `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)`,
        [
          e.id,
          e.vpsId,
          e.agentInstanceId,
          e.containerKey ?? null,
          e.action,
          new Date(e.eventOccurredAt),
          new Date(e.receivedAt),
          e.eventDigest,
          e.healthStatus ?? null,
          e.exitCode ?? null,
          e.signal ?? null,
          e.oomKilled ?? null,
        ],
      );
    }
  }

  async function seedAlerts(rows: DockerAlert[]): Promise<void> {
    for (const a of rows) {
      await ensureVps(a.vpsId);
      await pool!.query(
        `INSERT INTO docker_alerts ` +
          `(id, vps_id, agent_instance_id, rule_kind, container_key, state, fingerprint, ` +
          `opened_at, last_observed_at, resolved_at, acknowledged_at, acknowledged_by, ` +
          `occurrences, summary, context_version) ` +
          `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1)`,
        [
          a.id,
          a.vpsId,
          a.agentInstanceId ?? null,
          a.ruleKind,
          a.containerKey ?? null,
          a.state,
          a.fingerprint,
          new Date(a.openedAt),
          a.lastObservedAt ? new Date(a.lastObservedAt) : null,
          a.resolvedAt ? new Date(a.resolvedAt) : null,
          a.acknowledgedAt ? new Date(a.acknowledgedAt) : null,
          a.acknowledgedBy ?? null,
          a.occurrences,
          a.summary,
        ],
      );
    }
  }

  it.skipIf(!databaseUrl)(
    "empty tables yield empty reads, no cursors, undefined singles",
    async () => {
      expect((await repo!.listHostSamples({ vpsId: "vps-a" })).data).toEqual(
        [],
      );
      expect(
        (await repo!.listHostSamples({ vpsId: "vps-a" })).page.hasMore,
      ).toBe(false);
      expect(
        (
          await repo!.listContainerSamples({
            vpsId: "vps-a",
            agentInstanceId: "i",
            containerKey: "c",
          })
        ).data,
      ).toEqual([]);
      expect((await repo!.listEvents({ vpsId: "vps-a" })).data).toEqual([]);
      expect((await repo!.listRollups({ vpsId: "vps-a" })).data).toEqual([]);
      expect((await repo!.listAlerts({ vpsId: "vps-a" })).data).toEqual([]);
      expect(await repo!.getStorageLatest("vps-a")).toBeUndefined();
      expect(await repo!.getWatermark("vps-a", "i")).toBeUndefined();
      expect(await repo!.getIngestBatch("vps-a", "i", "b")).toBeUndefined();
    },
  );

  it.skipIf(!databaseUrl)(
    "scoped reads isolate VPSs; container scope requires exact instance+key",
    async () => {
      const t = new Date().toISOString();
      await seedSamples([
        sample("h1", "vps-a", t),
        containerSample("c1", "vps-a", t, "inst1", "ck1"),
        containerSample("c2", "vps-a", t, "inst2", "ck1"),
        containerSample("c3", "vps-b", t, "inst1", "ck1"),
      ]);
      expect(
        (await repo!.listHostSamples({ vpsId: "vps-a" })).data.map((s) => s.id),
      ).toEqual(["h1"]);
      expect((await repo!.listHostSamples({ vpsId: "vps-b" })).data).toEqual(
        [],
      );
      expect(
        (
          await repo!.listContainerSamples({
            vpsId: "vps-a",
            agentInstanceId: "inst1",
            containerKey: "ck1",
          })
        ).data.map((s) => s.id),
      ).toEqual(["c1"]);
      expect(
        (
          await repo!.listContainerSamples({
            vpsId: "vps-a",
            agentInstanceId: "inst2",
            containerKey: "ck1",
          })
        ).data.map((s) => s.id),
      ).toEqual(["c2"]);
    },
  );

  it.skipIf(!databaseUrl)(
    "orders newest-first with stable (at,id) tiebreak",
    async () => {
      const t = "2026-09-01T00:00:00.000Z";
      await seedSamples([
        sample("a", "vps-a", t),
        sample("b", "vps-a", t),
        sample("c", "vps-a", "2026-09-02T00:00:00.000Z"),
      ]);
      const ids = (await repo!.listHostSamples({ vpsId: "vps-a" })).data.map(
        (s) => s.id,
      );
      expect(ids).toEqual(["c", "b", "a"]);
    },
  );

  it.skipIf(!databaseUrl)(
    "cursor pagination walks the set; tamper/cross-VPS/scope mismatch rejected",
    async () => {
      const samples = Array.from({ length: 5 }, (_, i) =>
        sample(`s${i}`, "vps-a", `2026-09-0${i + 1}T00:00:00.000Z`),
      );
      await seedSamples(samples);
      const first = await repo!.listHostSamples({ vpsId: "vps-a", limit: 2 });
      expect(first.data.map((s) => s.id)).toEqual(["s4", "s3"]);
      expect(first.page.hasMore).toBe(true);
      expect(first.page.nextCursor).toBeDefined();
      const second = await repo!.listHostSamples({
        vpsId: "vps-a",
        limit: 2,
        cursor: first.page.nextCursor,
      });
      expect(second.data.map((s) => s.id)).toEqual(["s2", "s1"]);
      const third = await repo!.listHostSamples({
        vpsId: "vps-a",
        limit: 2,
        cursor: second.page.nextCursor,
      });
      expect(third.data.map((s) => s.id)).toEqual(["s0"]);
      expect(third.page.hasMore).toBe(false);
      expect(third.page.nextCursor).toBeUndefined();

      await expect(
        repo!.listHostSamples({
          vpsId: "vps-a",
          limit: 2,
          cursor: "!!!not-base64!!!",
        }),
      ).rejects.toThrow();
      const cross = first.page.nextCursor!;
      const decoded = decodeDockerCursor(cross);
      const rebound = encodeDockerCursor({ ...decoded, vpsId: "vps-b" });
      await expect(
        repo!.listHostSamples({ vpsId: "vps-a", limit: 2, cursor: rebound }),
      ).rejects.toThrow();
      await expect(
        repo!.listEvents({ vpsId: "vps-a", cursor: cross }),
      ).rejects.toThrow();
    },
  );

  it.skipIf(!databaseUrl)(
    "latest storage round-trips per VPS without leakage",
    async () => {
      const t = new Date().toISOString();
      await ensureVps("vps-a");
      await pool!.query(
        `INSERT INTO docker_storage_latest ` +
          `(vps_id, agent_instance_id, snapshot_id, collected_at, received_at, images, containers, ` +
          `local_volumes, build_cache, formula_version) ` +
          `VALUES ('vps-a','inst1','snap1',$1,$1,'{"supported":true,"count":1,"totalBytes":10}',` +
          `'{"supported":false,"count":0,"totalBytes":0}','{"supported":false,"count":0,"totalBytes":0}',` +
          `'{"supported":false,"count":0,"totalBytes":0}',1)`,
        [new Date(t)],
      );
      expect((await repo!.getStorageLatest("vps-a"))?.snapshotId).toBe("snap1");
      expect(await repo!.getStorageLatest("vps-b")).toBeUndefined();
    },
  );

  it.skipIf(!databaseUrl)(
    "I3 ingest is atomic, replay-safe, CAS-ordered, and cleans up",
    async () => {
      const receivedAt = "2026-09-01T00:00:00.000Z";
      const base = (
        overrides: Partial<
          Parameters<DockerMonitoringRepository["ingestUnit"]>[0]
        > = {},
      ) => ({
        vpsId: "vps-a",
        agentInstanceId: "inst1",
        snapshotId: "snap-1",
        batchId: "batch-1",
        requestDigest: "digest-1",
        requestDigestVersion: 1,
        receivedAt,
        sourceSequence: "1",
        hostSample: sample("hs-1", "vps-a", receivedAt),
        ...overrides,
      });
      await ensureVps("vps-a");
      const eventful = base({
        events: [
          { ...event("ev-1", "vps-a", receivedAt), sourceSequence: "1" },
        ],
        eventProtocol: {
          fromWatermark: {
            vpsId: "vps-a",
            agentInstanceId: "inst1",
            timeNano: "0",
            boundaryDigests: [],
            updatedAt: receivedAt,
          },
          proposedWatermark: {
            vpsId: "vps-a",
            agentInstanceId: "inst1",
            timeNano: "10",
            boundaryDigests: ["digest-1"],
            updatedAt: receivedAt,
          },
          eventWindow: { from: "0", to: "10" },
        },
      });
      const committed = await repo!.ingestUnit(eventful);
      expect(committed).toMatchObject({
        ingestStatus: "committed",
        committedWatermark: { timeNano: "10", boundaryDigests: ["digest-1"] },
      });
      expect(
        (await repo!.listHostSamples({ vpsId: "vps-a" })).data,
      ).toHaveLength(1);
      expect(
        (await repo!.listEvents({ vpsId: "vps-a" })).data.map((row) => row.id),
      ).toEqual(["ev-1"]);
      expect(await repo!.getWatermark("vps-a", "inst1")).toMatchObject({
        timeNano: "10",
        boundaryDigests: ["digest-1"],
        committedBatchId: "batch-1",
      });
      expect(await repo!.ingestUnit(base())).toEqual({
        ...committed,
        ingestStatus: "already_committed",
      });
      await expect(
        repo!.ingestUnit(base({ requestDigest: "digest-2" })),
      ).rejects.toMatchObject({ code: "request_digest_mismatch" });
      await expect(
        repo!.ingestUnit(
          base({
            batchId: "batch-2",
            snapshotId: "snap-2",
            sourceSequence: "1",
            agentInstanceId: "inst2",
            requestDigest: "digest-3",
          }),
        ),
      ).rejects.toMatchObject({ code: "active_instance_conflict" });
      const concurrent = await Promise.all([
        repo!.ingestUnit(
          base({
            batchId: "batch-3",
            snapshotId: "snap-3",
            sourceSequence: "2",
            requestDigest: "digest-3",
          }),
        ),
        repo!.ingestUnit(
          base({
            batchId: "batch-4",
            snapshotId: "snap-4",
            sourceSequence: "3",
            requestDigest: "digest-4",
          }),
        ),
      ]);
      expect(concurrent.map((r) => r.ingestStatus)).toEqual([
        "committed",
        "committed",
      ]);
      await repo!.cleanupForVps({ vpsId: "vps-a", reason: "vps_deleted" });
      expect(
        await repo!.getIngestBatch("vps-a", "inst1", "batch-1"),
      ).toBeUndefined();
      expect((await repo!.listHostSamples({ vpsId: "vps-a" })).data).toEqual(
        [],
      );
    },
  );

  it.skipIf(!databaseUrl)(
    "replay digests: repeat accepted, CPU change rejected, legacy accepted, wrong watermark rejected",
    async () => {
      const t1 = "2026-09-01T00:00:00.000Z";
      const t2 = "2026-09-01T00:00:01.000Z";
      const mkBase = (
        vpsId: string,
        snapshotId: string,
        batchId: string,
        digest: string,
        receivedAt: string,
        extra: Record<string, unknown> = {},
      ) => ({
        vpsId,
        agentInstanceId: "inst1",
        snapshotId,
        batchId,
        requestDigest: digest,
        requestDigestVersion: 1,
        receivedAt,
        sourceSequence: "1",
        hostSample: sample(`hs_${snapshotId}`, vpsId, receivedAt),
        ...extra,
      });
      // Repeat with a different receivedAt stays a replay with ACK fields.
      await ensureVps("vps-pg-replay");
      const first = await repo!.ingestUnit(
        mkBase("vps-pg-replay", "snap-r1", "batch-r1", "digest-r1", t1),
      );
      expect(first.ingestStatus).toBe("committed");
      const replay = await repo!.ingestUnit(
        mkBase("vps-pg-replay", "snap-r1", "batch-r1", "digest-r1", t2),
      );
      expect(replay.ingestStatus).toBe("already_committed");
      expect(replay.snapshotId).toBe("snap-r1");
      expect(replay.revision).toBe(first.revision);

      // Changed payload (new digest, same snapshot) is rejected.
      await expect(
        repo!.ingestUnit(
          mkBase("vps-pg-replay", "snap-r1", "batch-r1", "digest-r2", t2),
        ),
      ).rejects.toMatchObject({ code: "request_digest_mismatch" });

      // v1 commit then v2 replay via the original receive timestamp.
      await ensureVps("vps-pg-legacy");
      const v1 = await repo!.ingestUnit(
        mkBase("vps-pg-legacy", "snap-l1", "batch-l1", "digest-v1", t1),
      );
      expect(v1.ingestStatus).toBe("committed");
      const v2Replay = await repo!.ingestUnit({
        ...mkBase("vps-pg-legacy", "snap-l1", "batch-l1", "digest-v2", t2),
        requestDigestVersion: 2,
        legacyRequestDigest: (originalReceivedAt: string) =>
          originalReceivedAt === t1 ? "digest-v1" : "digest-mismatch",
      });
      expect(v2Replay.ingestStatus).toBe("already_committed");

      // Legacy replay with the wrong proposed watermark is rejected.
      await ensureVps("vps-pg-wm");
      const committedWm = await repo!.ingestUnit({
        ...mkBase("vps-pg-wm", "snap-w1", "batch-w1", "digest-w1", t1),
        events: [{ ...event("ev-w1", "vps-pg-wm", t1), sourceSequence: "1" }],
        eventProtocol: {
          fromWatermark: {
            vpsId: "vps-pg-wm",
            agentInstanceId: "inst1",
            timeNano: "0",
            boundaryDigests: [],
            updatedAt: t1,
          },
          proposedWatermark: {
            vpsId: "vps-pg-wm",
            agentInstanceId: "inst1",
            timeNano: "10",
            boundaryDigests: ["digest-w1"],
            updatedAt: t1,
          },
          eventWindow: { from: "0", to: "10" },
        },
      });
      expect(committedWm.ingestStatus).toBe("committed");
      await expect(
        repo!.ingestUnit({
          ...mkBase("vps-pg-wm", "snap-w1", "batch-w1", "digest-v2-wm", t2),
          requestDigestVersion: 2,
          legacyRequestDigest: (originalReceivedAt: string) =>
            originalReceivedAt === t1 ? "digest-w1" : "digest-mismatch",
          events: [{ ...event("ev-w1", "vps-pg-wm", t1), sourceSequence: "1" }],
          eventProtocol: {
            fromWatermark: {
              vpsId: "vps-pg-wm",
              agentInstanceId: "inst1",
              timeNano: "0",
              boundaryDigests: [],
              updatedAt: t2,
            },
            proposedWatermark: {
              vpsId: "vps-pg-wm",
              agentInstanceId: "inst1",
              timeNano: "11",
              boundaryDigests: ["digest-wrong"],
              updatedAt: t2,
            },
            eventWindow: { from: "0", to: "11" },
          },
        }),
      ).rejects.toMatchObject({ code: "request_digest_mismatch" });
    },
  );

  it.skipIf(!databaseUrl)("persists details and excludes prior-snapshot details from current rows", async () => {
    const details = {
      collectedAt: "2026-09-15T12:00:00.500Z",
      status: "available" as const,
      ports: [],
      mounts: [],
      networks: [],
      healthcheck: { status: "none" as const },
    };
    await seedSamples([
      { ...containerSample("old-details", "vps-detail", "2026-09-15T12:00:00Z"), details },
      containerSample("new-legacy", "vps-detail", "2026-09-15T12:00:01Z"),
    ]);
    expect(await repo!.listCurrentContainers("vps-detail")).toMatchObject([
      { agentInstanceId: "inst1", containerKey: "ck1", collectedAt: "2026-09-15T12:00:01.000Z" },
    ]);
    expect(await repo!.listCurrentContainers("vps-detail")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ details })]),
    );
    await seedSamples([
      { ...containerSample("replacement", "vps-detail", "2026-09-15T12:00:02Z", "inst2"), details },
    ]);
    expect(await repo!.listCurrentContainers("vps-detail")).toMatchObject([
      { agentInstanceId: "inst2", details, collectedAt: "2026-09-15T12:00:02.000Z" },
    ]);
  });
  it.skipIf(!databaseUrl)("persists and reads details from the exact current sample", async () => {
    const details = {
      collectedAt: "2026-09-15T12:00:00.500Z",
      status: "available" as const,
      ports: [],
      mounts: [],
      networks: [],
      healthcheck: { status: "none" as const },
    };
    await seedSamples([
      { ...containerSample("latest-details", "vps-detail-current", "2026-09-15T12:00:03Z", "inst-new"), details },
    ]);
    expect(await repo!.listCurrentContainers("vps-detail-current")).toMatchObject([
      { agentInstanceId: "inst-new", containerKey: "ck1", collectedAt: "2026-09-15T12:00:03.000Z", details },
    ]);
  });

});
