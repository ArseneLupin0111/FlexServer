import { nanoid } from "nanoid";
import type { DatabasePool } from "../../db/pool.js";
import { withTransaction } from "../../db/pool.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./json-file.js";
import type {
  DockerManagementAction,
  DockerManagementCancelReason,
  DockerManagementOperation,
  DockerManagementResult,
  DockerManagementStatus,
  DockerManagementTarget,
} from "../../docker/docker-management.models.js";
import { DOCKER_MANAGEMENT_CAPS, DockerManagementConflict } from "../../docker/docker-management.models.js";

export type DockerManagementCreate = {
  vpsId: string; idempotencyKey: string; requestDigest: string;
  action: DockerManagementAction; target: DockerManagementTarget; id?: string; now?: string;
};
export type DockerManagementRepository = {
  deleteByVps(vpsId: string): Promise<void>;
  create(input: DockerManagementCreate): Promise<{ operation: DockerManagementOperation; replay: boolean }>;
  get(id: string): Promise<DockerManagementOperation | undefined>;
  listByVps(vpsId: string, limit?: number): Promise<DockerManagementOperation[]>;
  claim(id: string, claimedBy: string, now?: string): Promise<DockerManagementOperation | undefined>;
  /**
   * Queue claim for the agent command API: atomically selects the oldest
   * claimable operation for this VPS/instance (queued, or claimed with an
   * expired lease; optionally pre-targeted at agentInstanceId) and marks it
   * claimed in one locked step. Returns undefined when nothing is claimable.
   */
  claimNextQueued(vpsId: string, agentInstanceId: string, now?: string): Promise<DockerManagementOperation | undefined>;
  setResult(id: string, status: Extract<DockerManagementStatus, "succeeded" | "failed">, result: DockerManagementResult, now?: string): Promise<DockerManagementOperation | undefined>;
  status(id: string): Promise<DockerManagementOperation | undefined>;
  cancelByVps(vpsId: string, reason: DockerManagementCancelReason, now?: string): Promise<number>;
};

type Store = { operations: DockerManagementOperation[] };
const empty = (): Store => ({ operations: [] });
const cap = (n?: number) => Math.min(Math.max(n ?? DOCKER_MANAGEMENT_CAPS.listLimit, 1), DOCKER_MANAGEMENT_CAPS.listLimit);
const order = (a: DockerManagementOperation, b: DockerManagementOperation) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
function normalize(raw: unknown): Store { const s = raw as Partial<Store>; return { operations: Array.isArray(s?.operations) ? s.operations : [] }; }
function trim(ops: DockerManagementOperation[]): DockerManagementOperation[] { const counts = new Map<string, number>(); return ops.sort(order).filter(o => { const n = counts.get(o.vpsId) ?? 0; if (n >= DOCKER_MANAGEMENT_CAPS.operationsPerVps) return false; counts.set(o.vpsId, n + 1); return true; }); }
function clone(o: DockerManagementOperation): DockerManagementOperation { return JSON.parse(JSON.stringify(o)) as DockerManagementOperation; }

export function createJsonDockerManagementRepository(filePath = "data/docker-management.json"): DockerManagementRepository {
  async function modify<T>(fn: (s: Store) => Promise<[Store, T]> | [Store, T]): Promise<T> {
    return withFileLock(filePath, async () => { const s = normalize(await readJsonFile(filePath, empty())); const [next, value] = await fn(s); await writeJsonFile(filePath, { operations: trim(next.operations) }); return value; });
  }
  const get = async (id: string) => normalize(await readJsonFile(filePath, empty())).operations.find(o => o.id === id);
  const deleteByVps = async (vpsId: string): Promise<void> => { await modify(s => [{ operations: s.operations.filter(o => o.vpsId !== vpsId) }, undefined]); };
  const create = (input: DockerManagementCreate) => modify(s => { const old = s.operations.find(o => o.idempotencyKey === input.idempotencyKey); if (old) { if (old.vpsId !== input.vpsId) throw new DockerManagementConflict("vps_mismatch", old.id); if (old.requestDigest !== input.requestDigest) throw new DockerManagementConflict("request_digest_mismatch", old.id); return [s, { operation: clone(old), replay: true }]; } const now = input.now ?? new Date().toISOString(); const operation: DockerManagementOperation = { id: input.id ?? nanoid(), vpsId: input.vpsId, idempotencyKey: input.idempotencyKey, requestDigest: input.requestDigest, action: input.action, target: input.target, status: "queued", createdAt: now, updatedAt: now }; return [{ operations: [...s.operations, operation] }, { operation: clone(operation), replay: false }]; });
  const claim = (id: string, claimedBy: string, now = new Date().toISOString()) => modify(s => { const o = s.operations.find(x => x.id === id); if (!o) return [s, undefined]; const lease = o.leaseExpiresAt ? Date.parse(o.leaseExpiresAt) : 0; if (o.status !== "queued" && !(o.status === "claimed" && lease <= Date.parse(now))) throw new DockerManagementConflict("not_claimable", id); Object.assign(o, { status: "claimed", claimedBy, leaseExpiresAt: new Date(Date.parse(now) + DOCKER_MANAGEMENT_CAPS.claimLeaseSeconds * 1000).toISOString(), updatedAt: now }); return [s, clone(o)]; });
  const claimNextQueued = (vpsId: string, agentInstanceId: string, now = new Date().toISOString()) => modify(s => {
    const nowMs = Date.parse(now);
    const claimable = (o: DockerManagementOperation) => {
      if (o.vpsId !== vpsId) return false;
      if (o.action !== "start" && o.action !== "stop" && o.action !== "restart") return false;
      if (o.target.agentInstanceId && o.target.agentInstanceId !== agentInstanceId) return false;
      if (o.status === "queued") return true;
      if (o.status !== "claimed") return false;
      return (o.leaseExpiresAt ? Date.parse(o.leaseExpiresAt) : 0) <= nowMs;
    };
    const target = s.operations.filter(claimable).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!target) return [s, undefined];
    Object.assign(target, { status: "claimed", claimedBy: agentInstanceId, leaseExpiresAt: new Date(nowMs + DOCKER_MANAGEMENT_CAPS.claimLeaseSeconds * 1000).toISOString(), updatedAt: now });
    return [s, clone(target)];
  });
  const setResult = (id: string, status: "succeeded" | "failed", result: DockerManagementResult, now = new Date().toISOString()) => modify(s => { const o = s.operations.find(x => x.id === id); if (!o) return [s, undefined]; Object.assign(o, { status, result, leaseExpiresAt: undefined, updatedAt: now }); return [s, clone(o)]; });
  const cancelByVps = (vpsId: string, reason: DockerManagementCancelReason, now = new Date().toISOString()) => modify(s => { let n = 0; for (const o of s.operations) if (o.vpsId === vpsId && (o.status === "queued" || o.status === "claimed")) { Object.assign(o, { status: "cancelled", cancelReason: reason, leaseExpiresAt: undefined, updatedAt: now }); n++; } return [s, n]; });
  return { deleteByVps, create, get, listByVps: async (v, l) => (await getAll()).filter(o => o.vpsId === v).sort(order).slice(0, cap(l)), claim, claimNextQueued, setResult, status: get, cancelByVps };
  async function getAll() { return normalize(await readJsonFile(filePath, empty())).operations; }
}

type Row = { id:string; vps_id:string; idempotency_key:string; request_digest:string; action:DockerManagementAction; target: DockerManagementTarget; status:DockerManagementStatus; claimed_by:string|null; lease_expires_at:Date|string|null; result:DockerManagementResult|null; cancel_reason:string|null; created_at:Date|string; updated_at:Date|string };
const rowToOperation = (r: Row): DockerManagementOperation => ({ id:r.id, vpsId:r.vps_id, idempotencyKey:r.idempotency_key, requestDigest:r.request_digest, action:r.action, target:r.target, status:r.status, claimedBy:r.claimed_by ?? undefined, leaseExpiresAt:r.lease_expires_at ? new Date(r.lease_expires_at).toISOString() : undefined, result:r.result ?? undefined, cancelReason:r.cancel_reason ?? undefined, createdAt:new Date(r.created_at).toISOString(), updatedAt:new Date(r.updated_at).toISOString() });
export function createPostgresDockerManagementRepository(pool: DatabasePool): DockerManagementRepository {
  const get = async (id:string) => { const r = await pool.query<Row>("SELECT * FROM docker_management_operations WHERE id=$1", [id]); return r.rows[0] && rowToOperation(r.rows[0]); };
  return { get, status:get,
    async deleteByVps(vpsId) { await pool.query("DELETE FROM docker_management_operations WHERE vps_id=$1", [vpsId]); },
    async create(i) { const now=i.now ?? new Date().toISOString(); return withTransaction(pool, async c => { const old=(await c.query<Row>("SELECT * FROM docker_management_operations WHERE idempotency_key=$1 FOR UPDATE",[i.idempotencyKey])).rows[0]; if(old){if(old.vps_id!==i.vpsId)throw new DockerManagementConflict("vps_mismatch",old.id);if(old.request_digest!==i.requestDigest)throw new DockerManagementConflict("request_digest_mismatch",old.id);return {operation:rowToOperation(old),replay:true};} const r=await c.query<Row>("INSERT INTO docker_management_operations (id,vps_id,idempotency_key,request_digest,action,target,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$7) RETURNING *",[i.id??nanoid(),i.vpsId,i.idempotencyKey,i.requestDigest,i.action,i.target,now]); await c.query("DELETE FROM docker_management_operations WHERE vps_id=$1 AND id NOT IN (SELECT id FROM docker_management_operations WHERE vps_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2)",[i.vpsId,DOCKER_MANAGEMENT_CAPS.operationsPerVps]); return {operation:rowToOperation(r.rows[0]),replay:false}; }); },
    async listByVps(v,l){const r=await pool.query<Row>("SELECT * FROM docker_management_operations WHERE vps_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2",[v,cap(l)]);return r.rows.map(rowToOperation);},
    async claim(id,by,now=new Date().toISOString()){const r=await pool.query<Row>("UPDATE docker_management_operations SET status='claimed',claimed_by=$2,lease_expires_at=$3::timestamptz,updated_at=$4::timestamptz WHERE id=$1 AND (status='queued' OR (status='claimed' AND lease_expires_at <= $4::timestamptz)) RETURNING *",[id,by,new Date(Date.parse(now)+DOCKER_MANAGEMENT_CAPS.claimLeaseSeconds*1000).toISOString(),now]);if(!r.rows[0]){if(await get(id))throw new DockerManagementConflict("not_claimable",id);return undefined;}return rowToOperation(r.rows[0]);},
    async claimNextQueued(vpsId,agentInstanceId,now=new Date().toISOString()){const r=await pool.query<Row>(
      `UPDATE docker_management_operations SET status='claimed',claimed_by=$2,lease_expires_at=$3::timestamptz,updated_at=$4::timestamptz
       WHERE id=(SELECT id FROM docker_management_operations
         WHERE vps_id=$1 AND action IN ('start','stop','restart')
           AND (target->>'agentInstanceId' IS NULL OR target->>'agentInstanceId'=$2)
           AND (status='queued' OR (status='claimed' AND lease_expires_at <= $4::timestamptz))
         ORDER BY created_at ASC,id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [vpsId,agentInstanceId,new Date(Date.parse(now)+DOCKER_MANAGEMENT_CAPS.claimLeaseSeconds*1000).toISOString(),now]);return r.rows[0]&&rowToOperation(r.rows[0]);},
    async setResult(id,status,result,now=new Date().toISOString()){const r=await pool.query<Row>("UPDATE docker_management_operations SET status=$2,result=$3,lease_expires_at=NULL,updated_at=$4::timestamptz WHERE id=$1 RETURNING *",[id,status,result,now]);return r.rows[0]&&rowToOperation(r.rows[0]);},
    async cancelByVps(v,reason,now=new Date().toISOString()){const r=await pool.query("UPDATE docker_management_operations SET status='cancelled',cancel_reason=$2,lease_expires_at=NULL,updated_at=$3::timestamptz WHERE vps_id=$1 AND status IN ('queued','claimed')",[v,reason,now]);return r.rowCount ?? 0;}
  };
}
