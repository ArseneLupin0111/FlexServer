import { createHash } from "node:crypto";
import type { StoredApplicationsInventory } from "../../docker-applications/inventory.schemas.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./json-file.js";

export interface ApplicationsInventoryRepository {
  current(vpsId: string): Promise<StoredApplicationsInventory | undefined>;
  save(input: StoredApplicationsInventory): Promise<"accepted" | "duplicate" | "outdated">;
}
export function inventoryDigest(input: StoredApplicationsInventory): string {
  return input.acceptedPayloadDigest ?? payloadDigest(input);
}
export function payloadDigest(input: StoredApplicationsInventory): string {
  const { receivedAt: _receivedAt, acceptedPayloadDigest: _digest, evidenceReceivedAt: _evidence, ...payload } = input;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
// Builds the stored projection for an accepted observation. The raw payload
// digest is minted from the incoming observation alone and never recomputed
// from the projected record, so retained evidence (projects/counters carried
// from the last complete observation while an incomplete observation for the
// same agent instance/epoch is accepted) cannot masquerade as fresh evidence or
// collide with the digest of the payload that actually supplied the projects.
// evidenceReceivedAt is stamped only when evidence is genuinely carried
// forward, with the acceptance time of that evidence — never with the replay's
// arrival time — and is omitted when the retained record held no evidence.
export function acceptedInventory(input: StoredApplicationsInventory, current?: StoredApplicationsInventory): StoredApplicationsInventory {
  const acceptedPayloadDigest = payloadDigest(input);
  const retainsEvidence = Boolean(current) && !input.completeness && current!.agentInstanceId === input.agentInstanceId && current!.daemonEpoch === input.daemonEpoch;
  if (!retainsEvidence) return { ...input, acceptedPayloadDigest };
  const evidenceReceivedAt = current!.completeness ? current!.receivedAt : current!.evidenceReceivedAt;
  return {
    ...input,
    projects: current!.projects,
    projectTotal: current!.projectTotal,
    replicaTotal: current!.replicaTotal,
    containerTotal: current!.containerTotal,
    acceptedPayloadDigest,
    ...(evidenceReceivedAt ? { evidenceReceivedAt } : {}),
  };
}
export function compareInventory(current: StoredApplicationsInventory | undefined, input: StoredApplicationsInventory): "accepted" | "duplicate" | "outdated" {
  if (!current) return "accepted";
  if (current.agentInstanceId === input.agentInstanceId && current.daemonEpoch === input.daemonEpoch) {
    if (input.inventorySequence < current.inventorySequence) return "outdated";
    if (input.inventorySequence === current.inventorySequence) {
      if (inventoryDigest(current) !== inventoryDigest(input)) throw new Error("inventory_sequence_conflict");
      return "duplicate";
    }
  }
  if (Date.parse(input.collectedAt) <= Date.parse(current.collectedAt)) return "outdated";
  return "accepted";
}

export function createJsonApplicationsInventoryRepository(file: string): ApplicationsInventoryRepository {
  return {
    async current(vpsId) { return (await readJsonFile<Record<string, StoredApplicationsInventory>>(file, {}))[vpsId]; },
    async save(input) {
      return withFileLock(file, async () => {
        const rows = await readJsonFile<Record<string, StoredApplicationsInventory>>(file, {});
        const result = compareInventory(rows[input.vpsId], input);
        if (result === "accepted") {
          rows[input.vpsId] = acceptedInventory(input, rows[input.vpsId]);
          await writeJsonFile(file, rows);
        }
        return result;
      });
    },
  };
}
