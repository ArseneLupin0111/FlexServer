import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadMigrations } from "../src/db/migrations.js";
import { createPostgresDockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import { createJsonDockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";
import type { DockerManagementRepository } from "../src/persistence/repositories/docker-management.repository.js";

const vpsId = "lookup-vps";
const otherVpsId = "other-vps";
const now = "2026-10-20T12:00:00.000Z";
const fixtureDirs: string[] = [];

beforeEach(async () => {
  fixtureDirs.push(await mkdtemp(join(tmpdir(), "docker-management-lookups-")));
});
afterEach(async () => {
  await Promise.all(fixtureDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createRepository() {
  const dir = fixtureDirs[fixtureDirs.length - 1]!;
  return createJsonDockerManagementRepository(join(dir, "operations.json"));
}

describe("docker management JSON repository lookups", () => {
  it("looks past newer terminal history to find and peek the oldest eligible operation without claiming it", async () => {
    const repository = createRepository();
    const operation = (id: string, vps: string, key: string, createdAt: string, status: "queued" | "claimed" | "succeeded", action: "start" | "stop" | "restart" | "pause", target: { containerKey: string; agentInstanceId?: string }, leaseExpiresAt?: string) => ({
      id, vpsId: vps, idempotencyKey: key, requestDigest: `digest-${id}`, action, target, status,
      ...(leaseExpiresAt ? { claimedBy: "instance-a", leaseExpiresAt } : {}),
      ...(status === "succeeded" ? { result: { ok: true } } : {}),
      createdAt, updatedAt: createdAt,
    });
    const operations = [
      operation("old-queued", vpsId, "old-key", "2026-01-01T00:00:00.000Z", "queued", "start", { containerKey: "old", agentInstanceId: "instance-a" }),
      operation("old-claimed", vpsId, "old-claimed-key", "2026-01-01T00:00:01.000Z", "claimed", "stop", { containerKey: "claimed" }, "2026-01-02T00:02:00.000Z"),
      operation("expired-lease", vpsId, "expired-key", "2026-01-02T00:00:00.000Z", "claimed", "restart", { containerKey: "expired" }, "2026-01-02T00:02:00.000Z"),
      operation("active-lease", vpsId, "active-key", "2026-01-03T00:00:00.000Z", "claimed", "restart", { containerKey: "active" }, "2026-10-20T12:01:00.000Z"),
      operation("wrong-instance", vpsId, "wrong-instance-key", "2026-01-04T00:00:00.000Z", "queued", "start", { containerKey: "wrong", agentInstanceId: "instance-b" }),
      operation("wrong-action", vpsId, "wrong-action-key", "2026-01-05T00:00:00.000Z", "queued", "pause", { containerKey: "pause" }),
      operation("other-vps-op", otherVpsId, "other-vps-key", "2026-01-01T00:00:00.000Z", "queued", "start", { containerKey: "other" }),
      ...Array.from({ length: 501 }, (_, index) => operation(
        `terminal-${String(index).padStart(3, "0")}`, vpsId, `terminal-key-${index}`,
        new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 1000).toISOString(), "succeeded", "stop", { containerKey: `terminal-${index}` },
      )),
    ];
    const dir = fixtureDirs[fixtureDirs.length - 1]!;
    await writeFile(join(dir, "operations.json"), JSON.stringify({ operations }));
    // One real repository mutation applies retention to the seeded history.
    await repository.create({
      vpsId, id: "new-terminal", idempotencyKey: "new-terminal-key", requestDigest: "new-terminal",
      action: "stop", target: { containerKey: "new-terminal" }, now: "2026-10-20T11:59:00.000Z",
    });
    await repository.setResult("new-terminal", "succeeded", { ok: true });

    expect((await repository.findByIdempotencyKey(vpsId, "old-key"))?.id).toBe("old-queued");
    expect(await repository.findByIdempotencyKey(otherVpsId, "old-key")).toBeUndefined();
    expect((await repository.peekNextClaimable(vpsId, "instance-a", now))?.id).toBe("old-queued");
    expect((await repository.get("old-queued"))?.status).toBe("queued");
    expect((await repository.get("expired-lease"))?.status).toBe("claimed");
    expect((await repository.get("active-lease"))?.status).toBe("claimed");
    expect((await repository.get("terminal-000"))).toBeUndefined();
    expect((await repository.listUnresolved(vpsId)).map((item) => item.id)).toEqual([
      "old-queued", "old-claimed", "expired-lease", "active-lease", "wrong-instance", "wrong-action",
    ]);
  });

  it("replays simultaneous creates with one idempotency key as the same operation", async () => {
    const repository = createRepository();
    const input = {
      vpsId,
      id: "concurrent-operation",
      idempotencyKey: "concurrent-key",
      requestDigest: "same-request",
      action: "start" as const,
      target: { containerKey: "container" },
      now,
    };
    const [first, second] = await Promise.all([
      repository.create(input),
      repository.create(input),
    ]);
    expect(first).toMatchObject({ operation: { id: "concurrent-operation" }, replay: false });
    expect(second).toMatchObject({ operation: { id: "concurrent-operation" }, replay: true });
    expect(await repository.findByIdempotencyKey(vpsId, input.idempotencyKey)).toMatchObject({
      id: "concurrent-operation",
      requestDigest: "same-request",
    });
  });
});
const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;

describe("docker management PostgreSQL repository lookups", () => {
  const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
  const schema = `vps_manager_dm_lookup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let pool: pg.Pool | undefined;
  let repository: DockerManagementRepository | undefined;

  beforeAll(async () => {
    if (!databaseUrl || !admin) return;
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE IF NOT EXISTS vps (
      id text PRIMARY KEY, name text NOT NULL, host text NOT NULL, port integer NOT NULL,
      username text NOT NULL, provider text NOT NULL DEFAULT 'unknown', region text,
      tags text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'unknown',
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
    )`);
    const migrations = await loadMigrations();
    await pool.query(migrations.find((migration) => migration.id === "018_docker_management.sql")!.sql);
    await pool.query("DELETE FROM docker_management_operations");
    await pool.query("DELETE FROM vps");
    repository = createPostgresDockerManagementRepository(pool as never);
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    pool = undefined;
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it.skipIf(!databaseUrl)("replays concurrent same-key creates and looks past terminal history without claiming", async () => {
    const repo = repository!;
    const concurrentInput = {
      vpsId, id: "pg-concurrent", idempotencyKey: "pg-concurrent-key", requestDigest: "same",
      action: "start" as const, target: { containerKey: "concurrent" }, now,
    };
    await pool!.query("INSERT INTO vps (id,name,host,port,username,created_at,updated_at) VALUES ($1,$1,'host',22,'root',now(),now())", [vpsId]);
    const [first, second] = await Promise.all([repo.create(concurrentInput), repo.create(concurrentInput)]);
    expect([first.operation.id, second.operation.id]).toEqual(["pg-concurrent", "pg-concurrent"]);
    expect([first.replay, second.replay].sort()).toEqual([false, true]);

    const terminalRows = Array.from({ length: 501 }, (_, index) => {
      const createdAt = new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 1000).toISOString();
      return [
        `pg-terminal-${index}`, vpsId, `pg-terminal-key-${index}`, `pg-digest-${index}`, "stop",
        JSON.stringify({ containerKey: `terminal-${index}` }), "succeeded", JSON.stringify({ ok: true }),
        createdAt, createdAt,
      ];
    });
    const values = terminalRows.flat();
    const placeholders = terminalRows.map((_, index) => {
      const base = index * 10;
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6}::jsonb,$${base + 7},$${base + 8}::jsonb,$${base + 9}::timestamptz,$${base + 10}::timestamptz)`;
    });
    await pool!.query(
      `INSERT INTO docker_management_operations (id,vps_id,idempotency_key,request_digest,action,target,status,result,created_at,updated_at) VALUES ${placeholders.join(",")}`,
      values,
    );
    await repo.create({
      vpsId, id: "pg-new-terminal", idempotencyKey: "pg-new-terminal-key", requestDigest: "new-terminal",
      action: "stop", target: { containerKey: "new-terminal" }, now: "2026-10-20T11:59:00.000Z",
    });
    await repo.setResult("pg-new-terminal", "succeeded", { ok: true }, now);
    const old = await repo.create({
      vpsId, id: "pg-old-queued", idempotencyKey: "pg-old-key", requestDigest: "old",
      action: "restart", target: { containerKey: "old", agentInstanceId: "instance-a" },
      now: "2026-01-01T00:00:00.000Z",
    });
    const oldClaimed = await repo.create({
      vpsId, id: "pg-old-claimed", idempotencyKey: "pg-old-claimed-key", requestDigest: "claimed",
      action: "stop", target: { containerKey: "claimed" }, now: "2026-01-01T00:00:01.000Z",
    });
    await repo.claim(oldClaimed.operation.id, "instance-a", "2026-01-02T00:00:00.000Z");
    const expired = await repo.create({
      vpsId, id: "pg-expired", idempotencyKey: "pg-expired-key", requestDigest: "expired",
      action: "restart", target: { containerKey: "expired" }, now: "2026-01-02T00:00:00.000Z",
    });
    await repo.claim(expired.operation.id, "instance-a", "2026-01-02T00:00:00.000Z");
    const active = await repo.create({
      vpsId, id: "pg-active", idempotencyKey: "pg-active-key", requestDigest: "active",
      action: "restart", target: { containerKey: "active" }, now: "2026-01-03T00:00:00.000Z",
    });
    await repo.claim(active.operation.id, "instance-a", "2026-10-20T11:59:00.000Z");
    await repo.create({
      vpsId, id: "pg-wrong-instance", idempotencyKey: "pg-wrong-instance-key", requestDigest: "wrong",
      action: "start", target: { containerKey: "wrong", agentInstanceId: "instance-b" }, now: "2026-01-04T00:00:00.000Z",
    });
    await repo.create({
      vpsId, id: "pg-wrong-action", idempotencyKey: "pg-wrong-action-key", requestDigest: "pause",
      action: "pause", target: { containerKey: "pause" }, now: "2026-01-05T00:00:00.000Z",
    });

    expect((await repo.findByIdempotencyKey(vpsId, "pg-old-key"))?.id).toBe(old.operation.id);
    expect((await repo.peekNextClaimable(vpsId, "instance-a", now))?.id).toBe(old.operation.id);
    expect((await repo.get(old.operation.id))?.status).toBe("queued");
    expect((await repo.listUnresolved(vpsId)).map((operation) => operation.id)).toEqual([
      "pg-concurrent", "pg-old-queued", "pg-old-claimed", "pg-expired", "pg-active", "pg-wrong-instance", "pg-wrong-action",
    ]);
  });
});
