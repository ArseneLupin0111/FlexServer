import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../src/db/pool.js";
import { applicationsInventorySchema, type StoredApplicationsInventory } from "../src/docker-applications/inventory.schemas.js";
import { acceptedInventory, compareInventory, createJsonApplicationsInventoryRepository, payloadDigest } from "../src/persistence/repositories/applications-inventory.repository.js";
import { createPostgresApplicationsInventoryRepository } from "../src/persistence/repositories/applications-inventory.postgres.repository.js";

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

type InsertLog = { payload: StoredApplicationsInventory };
const transactionFake = (): { pool: DatabasePool; inserts: InsertLog[] } => {
  const inserts: InsertLog[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT payload")) return { rowCount: inserts.length ? 1 : 0, rows: inserts.length ? [{ payload: inserts[inserts.length - 1]!.payload }] : [] };
    if (sql.includes("INSERT INTO") && values) inserts.push({ payload: values[11] as StoredApplicationsInventory });
    return { rowCount: 1, rows: [] };
  });
  const client = { query, release: vi.fn() };
  return { pool: { query, connect: async () => client } as unknown as DatabasePool, inserts };
};

let tempDirs: string[] = [];
afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("applications observation ordering", () => {
  it("accepts identical retry without refreshing freshness", () => {
    expect(compareInventory(row, { ...row, receivedAt: "2026-10-20T01:00:00Z" })).toBe("duplicate");
  });

  it("rejects a sequence reused for different evidence", () => {
    expect(() => compareInventory(row, { ...row, completeness: false, completionReason: "transport_failure" })).toThrow("inventory_sequence_conflict");
  });

  it("does not replace current evidence with an older sequence or old installation", () => {
    expect(compareInventory(row, { ...row, inventorySequence: 9, collectedAt: "2026-10-20T00:00:02Z" })).toBe("outdated");
    expect(compareInventory(row, { ...row, agentInstanceId: "b".repeat(32), collectedAt: "2026-10-19T00:00:00Z" })).toBe("outdated");
    expect(compareInventory(row, { ...row, agentInstanceId: "b".repeat(32), inventorySequence: 1, collectedAt: "2026-10-20T00:00:02Z" })).toBe("accepted");
  });

  it("distinguishes complete empty evidence from malformed counts and raw payloads", () => {
    const { vpsId, receivedAt, ...payload } = row;
    expect(applicationsInventorySchema.parse(payload).projects).toEqual([]);
    expect(() => applicationsInventorySchema.parse({ ...payload, projectTotal: 1 })).toThrow();
    expect(() => applicationsInventorySchema.parse({ ...payload, labels: { secret: "private" } })).toThrow();
  });
});

describe("accepted observation projection", () => {
  it("mints the raw payload digest from the incoming observation", () => {
    const projected = acceptedInventory(completeRow);
    expect(projected.acceptedPayloadDigest).toBe(payloadDigest(completeRow));
    expect(projected.evidenceReceivedAt).toBeUndefined();
  });

  it("carries forward evidence with its original acceptance timestamp", () => {
    const replayInput = { ...incompleteReplay, receivedAt: replayReceivedAt };
    const current = { ...completeRow, acceptedPayloadDigest: payloadDigest(completeRow), receivedAt: completeReceivedAt };
    const projected = acceptedInventory(replayInput, current);
    expect(projected.projects).toEqual(completeRow.projects);
    expect(projected.acceptedPayloadDigest).toBe(payloadDigest(replayInput));
    expect(projected.acceptedPayloadDigest).not.toBe(payloadDigest(completeRow));
    expect(projected.evidenceReceivedAt).toBe(completeReceivedAt);
  });
});

describe("incomplete replay evidence retention", () => {
  it("retains prior complete evidence with provenance in the JSON repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "applications-inventory-"));
    tempDirs.push(dir);
    const repository = createJsonApplicationsInventoryRepository(join(dir, "inventory.json"));
    const completeAccepted = { ...completeRow, receivedAt: completeReceivedAt };
    expect(await repository.save(completeAccepted)).toBe("accepted");
    const complete = await repository.current("vps");
    expect(complete?.completeness).toBe(true);
    expect(complete?.acceptedPayloadDigest).toBe(payloadDigest(completeAccepted));
    expect(complete?.evidenceReceivedAt).toBeUndefined();

    const replayInput = { ...incompleteReplay, receivedAt: replayReceivedAt };
    expect(await repository.save(replayInput)).toBe("accepted");
    const afterReplay = await repository.current("vps");
    expect(afterReplay?.completeness).toBe(false);
    expect(afterReplay?.completionReason).toBe("transport_failure");
    expect(afterReplay?.projects).toEqual(completeRow.projects);
    expect(afterReplay?.projectTotal).toBe(completeRow.projectTotal);
    expect(afterReplay?.replicaTotal).toBe(completeRow.replicaTotal);
    expect(afterReplay?.containerTotal).toBe(completeRow.containerTotal);
    expect(afterReplay?.evidenceReceivedAt).toBe(completeReceivedAt);
    expect(afterReplay?.receivedAt).toBe(replayReceivedAt);
    expect(afterReplay?.acceptedPayloadDigest).toBe(payloadDigest(replayInput));
    expect(await repository.save({ ...replayInput, receivedAt: "2026-10-20T00:03:00Z" })).toBe("duplicate");
    expect(() => compareInventory(afterReplay, replayInput)).not.toThrow();
    expect(compareInventory(afterReplay, completeRow)).toBe("outdated");
    expect(() => compareInventory(afterReplay, { ...replayInput, completionReason: "budget_exceeded" })).toThrow("inventory_sequence_conflict");

    expect(await repository.save({ ...completeRow, inventorySequence: 12, collectedAt: "2026-10-20T00:02:00Z", receivedAt: "2026-10-20T00:03:00Z" })).toBe("accepted");
    const refreshed = await repository.current("vps");
    expect(refreshed?.completeness).toBe(true);
    expect(refreshed?.evidenceReceivedAt).toBeUndefined();
  });

  it("persists retained evidence provenance through the PostgreSQL adapter", async () => {
    const { pool, inserts } = transactionFake();
    const repository = createPostgresApplicationsInventoryRepository(pool);
    const completeAccepted = { ...completeRow, receivedAt: completeReceivedAt };
    expect(await repository.save(completeAccepted)).toBe("accepted");
    const replayInput = { ...incompleteReplay, receivedAt: replayReceivedAt };
    expect(await repository.save(replayInput)).toBe("accepted");
    expect(inserts).toHaveLength(2);
    const [completeInsert, replayInsert] = inserts;
    expect(completeInsert?.payload.completeness).toBe(true);
    expect(completeInsert?.payload.evidenceReceivedAt).toBeUndefined();
    expect(completeInsert?.payload.acceptedPayloadDigest).toBe(payloadDigest(completeAccepted));
    expect(replayInsert?.payload.completeness).toBe(false);
    expect(replayInsert?.payload.projects).toEqual(completeRow.projects);
    expect(replayInsert?.payload.projectTotal).toBe(completeRow.projectTotal);
    expect(replayInsert?.payload.evidenceReceivedAt).toBe(completeReceivedAt);
    expect(replayInsert?.payload.acceptedPayloadDigest).toBe(payloadDigest(replayInput));
    expect(await repository.save({ ...replayInput, receivedAt: "2026-10-20T00:03:00Z" })).toBe("duplicate");
    expect(await repository.save({ ...completeRow, inventorySequence: 12, collectedAt: "2026-10-20T00:02:00Z", receivedAt: "2026-10-20T00:03:00Z" })).toBe("accepted");
    expect(inserts[2]?.payload.evidenceReceivedAt).toBeUndefined();
  });

  it("does not retain evidence across agent instance change", async () => {
    const { pool, inserts } = transactionFake();
    const repository = createPostgresApplicationsInventoryRepository(pool);
    expect(await repository.save({ ...completeRow, receivedAt: completeReceivedAt })).toBe("accepted");
    expect(await repository.save({ ...incompleteReplay, agentInstanceId: "c".repeat(32), inventorySequence: 12, receivedAt: replayReceivedAt })).toBe("accepted");
    expect(inserts[1]?.payload.projects).toEqual([]);
    expect(inserts[1]?.payload.evidenceReceivedAt).toBeUndefined();
  });
});
