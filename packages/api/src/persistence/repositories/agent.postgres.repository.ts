import { nanoid } from "nanoid";
import { withTransaction, type DatabasePool } from "../../db/pool.js";
import type {
  AgentCredential,
  AgentState,
  AgentSystemInfo,
} from "../../agents/agent.models.js";
import type { AgentRepository } from "./agent.repository.js";
import {
  optionalIsoString,
  requiredIsoString,
  toDateOrNull,
} from "./postgres-mappers.js";

type AgentCredentialRow = {
  id: string;
  vps_id: string;
  secret_hash: string;
  status: AgentCredential["status"];
  scope: string | null;
  created_at: Date | string;
  activated_at: Date | string | null;
  revoked_at: Date | string | null;
  last_used_at: Date | string | null;
  last_used_ip: string | null;
};

type AgentStateRow = {
  vps_id: string;
  status: AgentState["status"];
  version: string | null;
  build_id: string | null;
  installed_at: Date | string | null;
  last_seen_at: Date | string | null;
  last_error: string | null;
  last_install_job_id: string | null;
};

type AgentSystemInfoRow = {
  vps_id: string;
  collected_at: Date | string;
  received_at: Date | string;
  agent_version: string | null;
  data: unknown;
};

export function createPostgresAgentRepository(
  pool: DatabasePool,
): AgentRepository {
  async function getCredential(
    id: string,
  ): Promise<AgentCredential | undefined> {
    const result = await pool.query<AgentCredentialRow>(
      "SELECT * FROM agent_credentials WHERE id = $1",
      [id],
    );
    return result.rows[0] ? rowToCredential(result.rows[0]) : undefined;
  }

  return {
    async deleteState(vpsId) {
      const result = await pool.query("DELETE FROM agent_states WHERE vps_id=$1", [vpsId]);
      return (result.rowCount ?? 0) > 0;
    },
    async deleteCredentialsByVps(vpsId) {
      const result = await pool.query("DELETE FROM agent_credentials WHERE vps_id=$1", [vpsId]);
      return result.rowCount ?? 0;
    },
    async deleteVpsData(vpsId) {
      await pool.query("DELETE FROM agent_credentials WHERE vps_id=$1", [vpsId]);
      await pool.query("DELETE FROM agent_system_info WHERE vps_id=$1", [vpsId]);
      await pool.query("DELETE FROM agent_states WHERE vps_id=$1", [vpsId]);
    },
    async createCredential(input) {
      const credential: AgentCredential = {
        ...input,
        id: input.id ?? `cred_${nanoid(12)}`,
        createdAt: new Date().toISOString(),
      };
      const result = await pool.query<AgentCredentialRow>(
        `INSERT INTO agent_credentials (id, vps_id, secret_hash, status, scope, created_at, activated_at, revoked_at, last_used_at, last_used_ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        credentialToValues(credential),
      );
      return rowToCredential(result.rows[0]!);
    },
    getCredential,
    async listCredentialsByVps(vpsId) {
      const result = await pool.query<AgentCredentialRow>(
        "SELECT * FROM agent_credentials WHERE vps_id = $1 ORDER BY created_at DESC",
        [vpsId],
      );
      return result.rows.map(rowToCredential);
    },
    async updateCredential(id, patch) {
      return withTransaction(pool, async (client) => {
        const currentResult = await client.query<AgentCredentialRow>(
          "SELECT * FROM agent_credentials WHERE id = $1 FOR UPDATE",
          [id],
        );
        const current = currentResult.rows[0]
          ? rowToCredential(currentResult.rows[0])
          : undefined;
        if (!current) return undefined;
        const { id: _ignoredPatchId, ...safePatch } = patch;
        const next = { ...current, ...safePatch, id };
        const result = await client.query<AgentCredentialRow>(
          `UPDATE agent_credentials
           SET vps_id=$2, secret_hash=$3, status=$4, scope=$5, created_at=$6, activated_at=$7,
               revoked_at=$8, last_used_at=$9, last_used_ip=$10
           WHERE id=$1 RETURNING *`,
          credentialToValues(next),
        );
        return result.rows[0] ? rowToCredential(result.rows[0]) : undefined;
      });
    },
    async revokeCredential(id) {
      return this.updateCredential(id, {
        status: "revoked",
        revokedAt: new Date().toISOString(),
      });
    },
    async getState(vpsId) {
      const result = await pool.query<AgentStateRow>(
        "SELECT * FROM agent_states WHERE vps_id = $1",
        [vpsId],
      );
      return result.rows[0] ? rowToState(result.rows[0]) : undefined;
    },
    async listStates() {
      const result = await pool.query<AgentStateRow>(
        "SELECT * FROM agent_states",
      );
      return result.rows.map(rowToState);
    },
    async upsertState(state) {
      const result = await pool.query<AgentStateRow>(
        `INSERT INTO agent_states (vps_id, status, version, build_id, installed_at, last_seen_at, last_error, last_install_job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (vps_id) DO UPDATE SET
           status = EXCLUDED.status,
           version = EXCLUDED.version,
           build_id = EXCLUDED.build_id,
           installed_at = EXCLUDED.installed_at,
           last_seen_at = EXCLUDED.last_seen_at,
           last_error = EXCLUDED.last_error,
           last_install_job_id = EXCLUDED.last_install_job_id
         RETURNING *`,
        [
          state.vpsId,
          state.status,
          state.version ?? null,
          state.buildId ?? null,
          toDateOrNull(state.installedAt),
          toDateOrNull(state.lastSeenAt),
          state.lastError ?? null,
          state.lastInstallJobId ?? null,
        ],
      );
      return rowToState(result.rows[0]!);
    },

    async upsertSyntheticLocalState(state) {
      const result = await pool.query<AgentStateRow>(
        `INSERT INTO agent_states (vps_id, status, version, last_seen_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (vps_id) DO UPDATE SET
           status = EXCLUDED.status,
           version = EXCLUDED.version,
           last_seen_at = EXCLUDED.last_seen_at
         WHERE agent_states.version = '0.1.0-local'
         RETURNING *`,
        [state.vpsId, state.status, state.version, toDateOrNull(state.lastSeenAt)],
      );
      if (result.rows[0]) return rowToState(result.rows[0]);
      return this.getState(state.vpsId);
    },

    async upsertSystemInfo(info) {
      const result = await pool.query<AgentSystemInfoRow>(
        `INSERT INTO agent_system_info (
           vps_id, collected_at, received_at, agent_version,
           os_family, os_name, os_version, os_pretty_name,
           kernel_release, kernel_version, arch,
           cpu_cores, cpu_model,
           memory_total_bytes, memory_available_bytes,
           root_disk_mount_point, root_disk_fs_type, root_disk_total_bytes, root_disk_used_bytes, root_disk_free_bytes,
           data
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
         ON CONFLICT (vps_id) DO UPDATE SET
           collected_at = EXCLUDED.collected_at,
           received_at = EXCLUDED.received_at,
           agent_version = EXCLUDED.agent_version,
           os_family = EXCLUDED.os_family,
           os_name = EXCLUDED.os_name,
           os_version = EXCLUDED.os_version,
           os_pretty_name = EXCLUDED.os_pretty_name,
           kernel_release = EXCLUDED.kernel_release,
           kernel_version = EXCLUDED.kernel_version,
           arch = EXCLUDED.arch,
           cpu_cores = EXCLUDED.cpu_cores,
           cpu_model = EXCLUDED.cpu_model,
           memory_total_bytes = EXCLUDED.memory_total_bytes,
           memory_available_bytes = EXCLUDED.memory_available_bytes,
           root_disk_mount_point = EXCLUDED.root_disk_mount_point,
           root_disk_fs_type = EXCLUDED.root_disk_fs_type,
           root_disk_total_bytes = EXCLUDED.root_disk_total_bytes,
           root_disk_used_bytes = EXCLUDED.root_disk_used_bytes,
           root_disk_free_bytes = EXCLUDED.root_disk_free_bytes,
           data = EXCLUDED.data
         WHERE agent_system_info.collected_at <= EXCLUDED.collected_at
         RETURNING *`,
        [
          info.vpsId,
          toDateOrNull(info.collectedAt),
          toDateOrNull(info.receivedAt),
          info.agentVersion ?? null,
          info.os?.family ?? null,
          info.os?.name ?? null,
          info.os?.version ?? null,
          info.os?.prettyName ?? null,
          info.kernel?.release ?? null,
          info.kernel?.version ?? null,
          info.kernel?.arch ?? null,
          info.cpu?.cores ?? null,
          info.cpu?.model ?? null,
          info.memory?.totalBytes ?? null,
          info.memory?.availableBytes ?? null,
          info.rootDisk?.mountPoint ?? null,
          info.rootDisk?.fsType ?? null,
          info.rootDisk?.totalBytes ?? null,
          info.rootDisk?.usedBytes ?? null,
          info.rootDisk?.freeBytes ?? null,
          JSON.stringify({
            os: info.os,
            kernel: info.kernel,
            cpu: info.cpu,
            memory: info.memory,
            rootDisk: info.rootDisk,
          }),
        ],
      );
      if (result.rows[0]) return rowToSystemInfo(result.rows[0]);
      const current = await pool.query<AgentSystemInfoRow>(
        "SELECT * FROM agent_system_info WHERE vps_id = $1",
        [info.vpsId],
      );
      return current.rows[0] ? rowToSystemInfo(current.rows[0]) : info;
    },

    async getSystemInfo(vpsId) {
      const result = await pool.query<AgentSystemInfoRow>(
        "SELECT * FROM agent_system_info WHERE vps_id = $1",
        [vpsId],
      );
      if (!result.rows[0]) return undefined;
      return rowToSystemInfo(result.rows[0]);
    },

    async listSystemInfo() {
      const result = await pool.query<AgentSystemInfoRow>(
        "SELECT * FROM agent_system_info",
      );
      return result.rows.map(rowToSystemInfo);
    },

    async deleteSystemInfo(vpsId: string) {
      const result = await pool.query(
        "DELETE FROM agent_system_info WHERE vps_id = $1",
        [vpsId],
      );
      return Boolean(result.rowCount);
    },
  };
}

function credentialToValues(credential: AgentCredential): unknown[] {
  return [
    credential.id,
    credential.vpsId,
    credential.secretHash,
    credential.status,
    credential.scope ?? "agent",
    new Date(credential.createdAt),
    toDateOrNull(credential.activatedAt),
    toDateOrNull(credential.revokedAt),
    toDateOrNull(credential.lastUsedAt),
    credential.lastUsedIp ?? null,
  ];
}

function rowToCredential(row: AgentCredentialRow): AgentCredential {
  return {
    id: row.id,
    vpsId: row.vps_id,
    secretHash: row.secret_hash,
    status: row.status,
    scope: (row.scope ?? "agent") as NonNullable<AgentCredential["scope"]>,
    createdAt: requiredIsoString(row.created_at),
    activatedAt: optionalIsoString(row.activated_at),
    revokedAt: optionalIsoString(row.revoked_at),
    lastUsedAt: optionalIsoString(row.last_used_at),
    lastUsedIp: row.last_used_ip ?? undefined,
  };
}

function rowToSystemInfo(row: AgentSystemInfoRow): AgentSystemInfo {
  const data =
    typeof row.data === "string"
      ? JSON.parse(row.data)
      : (row.data as Record<string, unknown>);
  return {
    vpsId: row.vps_id,
    collectedAt: requiredIsoString(row.collected_at),
    receivedAt: requiredIsoString(row.received_at),
    agentVersion: row.agent_version ?? undefined,
    os: data?.os as AgentSystemInfo["os"],
    kernel: data?.kernel as AgentSystemInfo["kernel"],
    cpu: data?.cpu as AgentSystemInfo["cpu"],
    memory: data?.memory as AgentSystemInfo["memory"],
    rootDisk: data?.rootDisk as AgentSystemInfo["rootDisk"],
  };
}

function rowToState(row: AgentStateRow): AgentState {
  return {
    vpsId: row.vps_id,
    status: row.status,
    version: row.version ?? undefined,
    buildId: row.build_id ?? undefined,
    installedAt: optionalIsoString(row.installed_at),
    lastSeenAt: optionalIsoString(row.last_seen_at),
    lastError: row.last_error ?? undefined,
    lastInstallJobId: row.last_install_job_id ?? undefined,
  };
}
