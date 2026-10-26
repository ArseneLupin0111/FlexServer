import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { loadMigrations } from "../src/db/migrations.js";
import { createPostgresLocalUpgradeRepository } from "../src/persistence/repositories/local-upgrade.postgres.repository.js";
import type { LocalUpgradeJob } from "../src/local-upgrade/local-upgrade.models.js";

const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;

const TERMINAL_RESULT = {
  outcome: "succeeded",
  reportedBuildId: "build-new",
  heartbeatBuildId: "build-new",
  completedAt: "2026-09-27T00:00:00.000Z",
} as const;

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lug_1",
    vps_id: "vps-1",
    state: "succeeded",
    progress: 100,
    release_id: "rel-1",
    release_version: "1.0.0",
    release_build_id: "build-new",
    target_sha256: "abc",
    target_url: "https://example.invalid/agent.tar.gz",
    target_size_bytes: null,
    manifest_raw: "{}",
    baseline_build_id: null,
    baseline_heartbeat_at: null,
    actor: "test",
    idempotency_key: null,
    fencing_token: 1,
    reclaim_count: 0,
    claimed_at: null,
    lease_expires_at: null,
    deadline_at: new Date("2026-09-27T00:30:00.000Z"),
    phase_deadline_at: null,
    message: null,
    error_code: null,
    error_message: null,
    result: { ...TERMINAL_RESULT },
    revision: 1,
    created_at: new Date("2026-09-27T00:00:00.000Z"),
    updated_at: new Date("2026-09-27T00:00:00.000Z"),
    completed_at: new Date("2026-09-27T00:00:00.000Z"),
    ...overrides,
  };
}

function baseJob(): LocalUpgradeJob {
  const now = "2026-09-27T00:00:00.000Z";
  return {
    id: "lug_live_1",
    vpsId: "vps-live-1",
    state: "queued",
    progress: null,
    releaseId: "rel-1",
    releaseVersion: "1.0.0",
    releaseBuildId: "build-new",
    targetSha256: "abc",
    targetUrl: "https://example.invalid/agent.tar.gz",
    manifestRaw: "{}",
    actor: "test",
    fencingToken: 1,
    reclaimCount: 0,
    claimedAt: null,
    leaseExpiresAt: null,
    deadlineAt: "2026-09-27T00:30:00.000Z",
    error: null,
    result: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

describe("local-upgrade postgres migration (021)", () => {
  it("defines result as jsonb", async () => {
    const migrations = await loadMigrations();
    const migration = migrations.find((m) => m.id === "021_local_agent_upgrades.sql");
    expect(migration).toBeDefined();
    expect(migration!.sql).toMatch(/result\s+jsonb/i);
  });
});

describe("local-upgrade postgres CAS result (deterministic SQL fake)", () => {
  it("persists a result-only patch as stringified JSONB instead of dropping it", async () => {
    const query = vi.fn(async () => ({ rows: [baseRow()] }));
    const repo = createPostgresLocalUpgradeRepository({ query } as never);

    // Regression: COLUMNS excludes "result", so a result-only patch used to hit
    // `if (!column) continue` and return undefined without issuing SQL.
    const updated = await repo.compareAndSet("lug_1", 0, {
      result: { ...TERMINAL_RESULT },
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("result = $");
    expect(sql).toContain("revision = revision + 1");
    expect(sql).toContain("WHERE id = $1 AND revision = $2");
    expect(values).toContainEqual(JSON.stringify(TERMINAL_RESULT));
    expect(updated?.result).toEqual(TERMINAL_RESULT);
    expect(updated?.revision).toBe(1);
  });

  it("preserves null semantics when clearing the terminal outcome", async () => {
    const query = vi.fn(async () => ({ rows: [baseRow({ result: null })] }));
    const repo = createPostgresLocalUpgradeRepository({ query } as never);

    const updated = await repo.compareAndSet("lug_1", 1, { result: null });

    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("result = $");
    expect(values).toContain(null);
    expect(updated?.result).toBeNull();
  });

  it("preserves the CAS revision guard on conflict", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repo = createPostgresLocalUpgradeRepository({ query } as never);

    await expect(
      repo.compareAndSet("lug_1", 999, { result: { ...TERMINAL_RESULT } }),
    ).resolves.toBeUndefined();
  });
});

describe("local-upgrade postgres terminal outcome (live PostgreSQL)", () => {
  it.skipIf(!databaseUrl)("persists and retrieves terminal outcome with CAS revision", async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schema = `vps_manager_lug_${Date.now()}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query("CREATE TABLE vps (id text PRIMARY KEY)");
      await pool.query("CREATE TABLE agent_credentials (id text PRIMARY KEY, vps_id text)");
      await pool.query("CREATE TABLE agent_states (vps_id text PRIMARY KEY)");
      const migrations = await loadMigrations();
      await pool.query(migrations.find((m) => m.id === "021_local_agent_upgrades.sql")!.sql);
      await pool.query(migrations.find((m) => m.id === "032_fleet_agent_updates.sql")!.sql);
      const m033 = migrations.find((m) => m.id === "033_agent_deploy_convergence.sql");
      if (m033) await pool.query(m033.sql);
      await pool.query(migrations.find((m) => m.id === "034_agent_convergence_indexes.sql")!.sql);
      await pool.query(migrations.find((m) => m.id === "035_updater_ai_install.sql")!.sql);
      await pool.query("INSERT INTO vps (id) VALUES ('vps-live-1')");

      const repo = createPostgresLocalUpgradeRepository(pool);
      await repo.create({ ...baseJob(), targetArch: "amd64" });

      const updated = await repo.compareAndSet("lug_live_1", 0, {
        state: "succeeded",
        result: { ...TERMINAL_RESULT },
        completedAt: "2026-09-27T00:00:00.000Z",
      });
      expect(updated?.revision).toBe(1);
      expect(updated?.result).toEqual(TERMINAL_RESULT);

      const reloaded = await repo.get("lug_live_1");
      expect(reloaded?.result).toEqual(TERMINAL_RESULT);
      expect(reloaded?.revision).toBe(1);
      expect(reloaded?.targetArch).toBe("amd64");

      await expect(
        repo.compareAndSet("lug_live_1", 0, { result: { ...TERMINAL_RESULT } }),
      ).resolves.toBeUndefined();
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it.skipIf(!databaseUrl)("persists and retrieves deferred and superseded states, excluding from active", async () => {
    const schema = `test_lug_states_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Pool({ connectionString: databaseUrl! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path="${schema}"` });
    try {
      await pool.query("CREATE TABLE vps (id text PRIMARY KEY)");
      await pool.query("CREATE TABLE agent_credentials (id text PRIMARY KEY, vps_id text)");
      await pool.query("CREATE TABLE agent_states (vps_id text PRIMARY KEY)");
      const migrations = await loadMigrations();
      await pool.query(migrations.find((m) => m.id === "021_local_agent_upgrades.sql")!.sql);
      await pool.query(migrations.find((m) => m.id === "032_fleet_agent_updates.sql")!.sql);
      const m033 = migrations.find((m) => m.id === "033_agent_deploy_convergence.sql");
      if (m033) await pool.query(m033.sql);
      await pool.query(migrations.find((m) => m.id === "034_agent_convergence_indexes.sql")!.sql);
      await pool.query(migrations.find((m) => m.id === "035_updater_ai_install.sql")!.sql);

      await pool.query("INSERT INTO vps (id) VALUES ('vps-1')");
      const repo = createPostgresLocalUpgradeRepository(pool);
      await repo.create({ ...baseJob(), vpsId: "vps-1", targetArch: "amd64" });

      const deferredUpdated = await repo.compareAndSet("lug_live_1", 0, {
        state: "deferred",
        result: { outcome: "deferred", reason: "host busy", completedAt: "2026-09-27T00:00:00.000Z" },
        completedAt: "2026-09-27T00:00:00.000Z",
      });
      expect(deferredUpdated?.state).toBe("deferred");
      expect(deferredUpdated?.result?.outcome).toBe("deferred");

      const activeAfterDeferred = await repo.getActiveByVps("vps-1");
      expect(activeAfterDeferred).toBeUndefined();
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it.skipIf(!databaseUrl)("supports convergence records and global execution serialization", async () => {
    const schema = `test_lug_conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Pool({ connectionString: databaseUrl! });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path="${schema}"` });
    try {
      await pool.query("CREATE TABLE vps (id text PRIMARY KEY)");
      await pool.query("CREATE TABLE agent_credentials (id text PRIMARY KEY, vps_id text)");
      await pool.query("CREATE TABLE agent_states (vps_id text PRIMARY KEY)");
      const migrations = await loadMigrations();
      await pool.query(migrations.find((m) => m.id === "021_local_agent_upgrades.sql")!.sql);
      await pool.query(migrations.find((m) => m.id === "032_fleet_agent_updates.sql")!.sql);
      const m033 = migrations.find((m) => m.id === "033_agent_deploy_convergence.sql");
      if (m033) await pool.query(m033.sql);
      const m034 = migrations.find((m) => m.id === "034_agent_convergence_indexes.sql");
      if (m034) await pool.query(m034.sql);
      await pool.query(migrations.find((m) => m.id === "035_updater_ai_install.sql")!.sql);

      await pool.query("INSERT INTO vps (id) VALUES ('vps-1'), ('vps-2')");
      const repo = createPostgresLocalUpgradeRepository(pool);

      // Convergence record operations
      const initial = await repo.getConvergence("vps-1");
      expect(initial).toBeUndefined();

      const created = await repo.updateConvergence("vps-1", {
        setupState: "needs_access",
        setupReason: "ssh_missing",
        suppressedBuildId: "build-123",
      });
      expect(created.setupState).toBe("needs_access");
      expect(created.suppressedBuildId).toBe("build-123");

      const loaded = await repo.getConvergence("vps-1");
      expect(loaded?.setupState).toBe("needs_access");
      expect(loaded?.suppressedBuildId).toBe("build-123");

      // Two queued jobs
      await repo.create({ ...baseJob(), id: "lug_1", vpsId: "vps-1", targetArch: "amd64" });
      await repo.create({ ...baseJob(), id: "lug_2", vpsId: "vps-2", targetArch: "amd64" });

      // Claim first job -> succeeds
      const claimed1 = await repo.compareAndSet("lug_1", 0, { state: "claimed" });
      expect(claimed1?.state).toBe("claimed");

      // Claim second job while first is executing -> throws global_active error
      await expect(
        repo.compareAndSet("lug_2", 0, { state: "claimed" }),
      ).rejects.toMatchObject({ kind: "global_active", existingId: "lug_1" });

      // listActive returns only active non-terminal jobs
      const activeList = await repo.listActive();
      expect(activeList.length).toBe(2);

      // Transition first job to terminal succeeded
      await repo.compareAndSet("lug_1", 1, {
        state: "succeeded",
        result: { outcome: "succeeded", completedAt: new Date().toISOString() },
      });

      // Now claim second job -> succeeds!
      const claimed2 = await repo.compareAndSet("lug_2", 0, { state: "claimed" });
      expect(claimed2?.state).toBe("claimed");
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
