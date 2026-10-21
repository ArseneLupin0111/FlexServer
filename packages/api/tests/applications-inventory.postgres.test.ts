import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadMigrations } from "../src/db/migrations.js";
import type { StoredApplicationsInventory } from "../src/docker-applications/inventory.schemas.js";
import { payloadDigest, type ApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.repository.js";
import { createPostgresApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.postgres.repository.js";
// table comes from the real 028 migration applied to an isolated schema, so
// column names, JSONB projections, and pruning semantics are exercised against
// the deployed shape rather than a hand-built copy.
const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;

const row: StoredApplicationsInventory = { vpsId: "vps", receivedAt: "2026-10-20T00:00:01Z", protocolVersion: "applications-v1", agentInstanceId: "a".repeat(32), daemonEpoch: 1, inventorySequence: 10, collectedAt: "2026-10-20T00:00:00Z", completeness: true, completionReason: "", containerTotal: 0, projectTotal: 0, replicaTotal: 0, projects: [], capability: { protocolVersion: "applications-v1", os: "linux", arch: "amd64", agentVersion: "test", dockerAvailable: true, composeMode: "plugin", installState: "unknown", managementGate: false, features: [], reasons: [] } };

const completeRow: StoredApplicationsInventory = {
  ...row,
  containerTotal: 2, projectTotal: 1, replicaTotal: 1,
  projects: [{
    project: "demo", replicaTotal: 1, services: [{
      service: "web", occupiedSlots: [], maxSlot: 1,
      replicas: [{ containerKey: "b".repeat(32), slot: 1, state: "running", status: "Up", createdAt: "2026-10-20T00:00:00Z" }],
      health: "healthy", isOneoff: false, configHash: "cfg",
    }],
  }],
};

const completeReceivedAt = "2026-10-20T00:01:00Z";
const replaySequence = 11;
const replayReceivedAt = "2026-10-20T00:02:00Z";
const replayCollectedAt = "2026-10-20T00:01:00Z";
const incompleteReplay: StoredApplicationsInventory = {
  ...completeRow,
  inventorySequence: replaySequence,
  collectedAt: replayCollectedAt,
  completeness: false,
  completionReason: "transport_failure",
  projects: [],
  projectTotal: 0,
  replicaTotal: 0,
  containerTotal: 0,
};

type InventoryRow = {
  agent_instance_id: string;
  daemon_epoch: string;
  sequence: number;
  completeness: boolean;
  completeness_reason: string | null;
  capabilities: StoredApplicationsInventory["capability"];
  projects: StoredApplicationsInventory["projects"];
  payload: StoredApplicationsInventory;
};

describe("applications inventory repository (PostgreSQL, migration 028)", () => {
  const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
  const schema = `applications_inventory_${Date.now()}_${randomBytes(4).toString("hex")}`;
  let pool: pg.Pool | undefined;
  let repository: ApplicationsInventoryRepository | undefined;

  beforeAll(async () => {
    if (!admin) return;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE vps (id text PRIMARY KEY, name text NOT NULL, host text NOT NULL, port integer NOT NULL, username text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`);
    const migration = (await loadMigrations()).find((candidate) => candidate.id === "028_docker_applications.sql")!;
    await pool.query(migration.sql);
    repository = createPostgresApplicationsInventoryRepository(pool);
  }, 30000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM docker_application_inventories");
    await pool.query(`INSERT INTO vps (id,name,host,port,username,created_at,updated_at) VALUES ('vps','vps','host',22,'root',now(),now()) ON CONFLICT (id) DO NOTHING`);
  });

  const stored = async (): Promise<InventoryRow[]> => (await pool!.query<InventoryRow>("SELECT agent_instance_id, daemon_epoch, sequence, completeness, completeness_reason, capabilities, projects, payload FROM docker_application_inventories ORDER BY received_at DESC, sequence DESC")).rows;

  it.skipIf(!databaseUrl)("retains complete evidence and its original provenance when an incomplete replay is accepted", async () => {
    const completeAccepted = { ...completeRow, receivedAt: completeReceivedAt };
    expect(await repository!.save(completeAccepted)).toBe("accepted");
    const complete = await repository!.current("vps");
    expect(complete?.completeness).toBe(true);
    expect(complete?.evidenceReceivedAt).toBeUndefined();
    expect(complete?.acceptedPayloadDigest).toBe(payloadDigest(completeAccepted));

    const [completeStored] = await stored();
    expect(completeStored).toMatchObject({ agent_instance_id: "a".repeat(32), daemon_epoch: "1", sequence: 10, completeness: true, completeness_reason: null });
    expect(completeStored?.capabilities).toEqual(completeRow.capability);
    expect(completeStored?.projects).toEqual(completeRow.projects);
    expect(completeStored?.payload.projects).toEqual(completeRow.projects);

    const replayInput = { ...incompleteReplay, receivedAt: replayReceivedAt };
    expect(await repository!.save(replayInput)).toBe("accepted");
    const afterReplay = await repository!.current("vps");
    expect(afterReplay?.completeness).toBe(false);
    expect(afterReplay?.completionReason).toBe("transport_failure");
    expect(afterReplay?.projects).toEqual(completeRow.projects);
    expect(afterReplay?.projectTotal).toBe(completeRow.projectTotal);
    expect(afterReplay?.replicaTotal).toBe(completeRow.replicaTotal);
    expect(afterReplay?.containerTotal).toBe(completeRow.containerTotal);
    expect(afterReplay?.evidenceReceivedAt).toBe(completeReceivedAt);
    expect(afterReplay?.receivedAt).toBe(replayReceivedAt);
    expect(afterReplay?.acceptedPayloadDigest).toBe(payloadDigest(replayInput));

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: replaySequence, completeness: false, completeness_reason: "transport_failure" });
    expect(rows[0]?.projects).toEqual(completeRow.projects);
    expect(rows[0]?.payload.evidenceReceivedAt).toBe(completeReceivedAt);
  });

  it.skipIf(!databaseUrl)("treats an exact replay as a duplicate that never advances freshness", async () => {
    const completeAccepted = { ...completeRow, receivedAt: completeReceivedAt };
    expect(await repository!.save(completeAccepted)).toBe("accepted");
    const completeReplay = { ...completeAccepted, receivedAt: "2026-10-20T00:04:00Z" };
    expect(await repository!.save(completeReplay)).toBe("duplicate");
    expect(await repository!.current("vps")).toMatchObject({ receivedAt: completeReceivedAt, completeness: true });
    expect(await stored()).toHaveLength(1);
    const completeRowAfterReplay = await pool!.query<{ n: number; received_at: Date }>("SELECT count(*)::int AS n, min(received_at) AS received_at FROM docker_application_inventories");
    expect(completeRowAfterReplay.rows[0]?.n).toBe(1);
    expect(completeRowAfterReplay.rows[0]?.received_at.toISOString()).toBe(new Date(completeReceivedAt).toISOString());

    const replayInput = { ...incompleteReplay, receivedAt: replayReceivedAt };
    expect(await repository!.save(replayInput)).toBe("accepted");
    expect(await repository!.save({ ...replayInput, receivedAt: "2026-10-20T00:05:00Z" })).toBe("duplicate");
    const afterReplayReplay = await repository!.current("vps");
    expect(afterReplayReplay?.receivedAt).toBe(replayReceivedAt);
    expect(afterReplayReplay?.evidenceReceivedAt).toBe(completeReceivedAt);
    expect(afterReplayReplay?.acceptedPayloadDigest).toBe(payloadDigest(replayInput));
    expect(await stored()).toHaveLength(1);
  });

  it.skipIf(!databaseUrl)("rejects a reused sequence carrying different evidence without changing the stored row", async () => {
    expect(await repository!.save({ ...completeRow, receivedAt: completeReceivedAt })).toBe("accepted");
    await expect(repository!.save({ ...completeRow, completeness: false, completionReason: "transport_failure", receivedAt: replayReceivedAt })).rejects.toThrow("inventory_sequence_conflict");

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 10, completeness: true });
    expect(rows[0]?.payload.receivedAt).toBe(completeReceivedAt);
    expect((await repository!.current("vps"))?.receivedAt).toBe(completeReceivedAt);
  });

  it.skipIf(!databaseUrl)("clears retained provenance when the next complete observation is accepted", async () => {
    expect(await repository!.save({ ...completeRow, receivedAt: completeReceivedAt })).toBe("accepted");
    expect(await repository!.save({ ...incompleteReplay, receivedAt: replayReceivedAt })).toBe("accepted");
    expect((await repository!.current("vps"))?.evidenceReceivedAt).toBe(completeReceivedAt);

    const refreshed: StoredApplicationsInventory = {
      ...completeRow,
      inventorySequence: 12,
      collectedAt: "2026-10-20T00:02:00Z",
      receivedAt: "2026-10-20T00:03:00Z",
      projects: [{ ...completeRow.projects[0]!, project: "fresh" }],
    };
    expect(await repository!.save(refreshed)).toBe("accepted");
    const current = await repository!.current("vps");
    expect(current?.completeness).toBe(true);
    expect(current?.evidenceReceivedAt).toBeUndefined();
    expect(current?.projects[0]?.project).toBe("fresh");
    expect(current?.acceptedPayloadDigest).toBe(payloadDigest(refreshed));

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projects[0]?.project).toBe("fresh");
    const provenance = await pool!.query<{ present: boolean }>("SELECT payload ? 'evidenceReceivedAt' AS present FROM docker_application_inventories");
    expect(provenance.rows[0]?.present).toBe(false);
  });

  it.skipIf(!databaseUrl)("does not retain evidence when the agent instance changes", async () => {
    expect(await repository!.save({ ...completeRow, receivedAt: completeReceivedAt })).toBe("accepted");
    const switched: StoredApplicationsInventory = { ...incompleteReplay, agentInstanceId: "c".repeat(32), inventorySequence: 12, receivedAt: replayReceivedAt };
    expect(await repository!.save(switched)).toBe("accepted");

    const current = await repository!.current("vps");
    expect(current?.agentInstanceId).toBe("c".repeat(32));
    expect(current?.projects).toEqual([]);
    expect(current?.projectTotal).toBe(0);
    expect(current?.evidenceReceivedAt).toBeUndefined();
    expect(current?.acceptedPayloadDigest).toBe(payloadDigest(switched));

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_instance_id).toBe("c".repeat(32));
    expect(rows[0]?.projects).toEqual([]);
    expect(rows[0]?.payload.evidenceReceivedAt).toBeUndefined();
  });
});
