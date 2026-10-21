import { randomUUID } from "node:crypto";
import { withTransaction, type DatabasePool } from "../../db/pool.js";
import type { StoredApplicationsInventory } from "../../docker-applications/inventory.schemas.js";
import { acceptedInventory, compareInventory, type ApplicationsInventoryRepository } from "./applications-inventory.repository.js";

export function createPostgresApplicationsInventoryRepository(pool: DatabasePool): ApplicationsInventoryRepository {
  return {
    async current(vpsId) {
      const result = await pool.query<{ payload: StoredApplicationsInventory }>("SELECT payload FROM docker_application_inventories WHERE vps_id=$1 ORDER BY received_at DESC, sequence DESC LIMIT 1", [vpsId]);
      return result.rows[0]?.payload;
    },
    async save(input) {
      return withTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`applications-inventory:${input.vpsId}`]);
        const old = await client.query<{ payload: StoredApplicationsInventory }>("SELECT payload FROM docker_application_inventories WHERE vps_id=$1 ORDER BY received_at DESC, sequence DESC LIMIT 1 FOR UPDATE", [input.vpsId]);
        const current = old.rows[0]?.payload;
        const result = compareInventory(current, input);
        if (result !== "accepted") return result;
        const stored = acceptedInventory(input, current);
        // Evidence provenance (acceptedPayloadDigest, evidenceReceivedAt) lives inside
        // the payload snapshot so an incomplete replay never stores retained
        // projects under the replay's own digest, and both adapters persist
        // identical semantics without a schema change.
        await client.query(`INSERT INTO docker_application_inventories
          (id,vps_id,agent_instance_id,daemon_epoch,sequence,collected_at,received_at,completeness,completeness_reason,capabilities,projects,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), stored.vpsId, stored.agentInstanceId, String(stored.daemonEpoch), stored.inventorySequence, stored.collectedAt, stored.receivedAt, stored.completeness, stored.completionReason || null, stored.capability, JSON.stringify(stored.projects), stored]);
        // Only the current committed observation is required; history belongs
        // to applications/operations, not a growing metadata snapshot archive.
        await client.query("DELETE FROM docker_application_inventories WHERE vps_id=$1 AND id <> (SELECT id FROM docker_application_inventories WHERE vps_id=$1 ORDER BY received_at DESC,sequence DESC LIMIT 1)", [stored.vpsId]);
        return result;
      });
    },
  };
}
