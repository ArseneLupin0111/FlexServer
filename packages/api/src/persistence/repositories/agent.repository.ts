import { nanoid } from "nanoid";
import type {
  AgentCredential,
  AgentState,
  AgentSystemInfo,
} from "../../agents/agent.models.js";
import {
  readJsonFile,
  readModifyWriteJsonFile,
  withFileLock,
  writeJsonFile,
} from "./json-file.js";

// ── Type ────────────────────────────────────────────────────────────────

export type AgentRepository = {
  createCredential(
    input: Omit<AgentCredential, "id" | "createdAt"> & { id?: string },
  ): Promise<AgentCredential>;
  getCredential(id: string): Promise<AgentCredential | undefined>;
  listCredentialsByVps(vpsId: string): Promise<AgentCredential[]>;
  updateCredential(
    id: string,
    patch: Partial<AgentCredential>,
  ): Promise<AgentCredential | undefined>;
  revokeCredential(id: string): Promise<AgentCredential | undefined>;
  revokeOtherActiveAgentCredentials(
    vpsId: string,
    keepCredentialId: string,
  ): Promise<string[]>;
  acceptHeartbeat(input: {
    credentialId: string;
    vpsId: string;
    lastUsedAt: string;
    lastUsedIp?: string;
    version?: string;
    buildId?: string;
    lastSeenAt: string;
  }): Promise<AgentCredential | undefined>;
  createInstallCredential(
    input: Omit<AgentCredential, "id" | "createdAt"> & { id?: string },
    state: AgentState,
  ): Promise<AgentCredential>;
  getState(vpsId: string): Promise<AgentState | undefined>;
  upsertState(state: AgentState): Promise<AgentState>;
  /** Only synthesize local state while no real agent owns the heartbeat. */
  upsertSyntheticLocalState(state: AgentState): Promise<AgentState | undefined>;
  listStates(): Promise<AgentState[]>;
  /**
   * Atomically move a still-`online` state to `not_installed` and revoke every
   * credential of that VPS. Only applies if `lastSeenAt` still equals
   * `expectedLastSeenAt` (a newer heartbeat wins). Returns true when applied.
   */
  markAgentAbsent(
    vpsId: string,
    expectedLastSeenAt: string,
  ): Promise<boolean>;
  /** Delete persisted lifecycle state for a VPS. Returns true if anything was removed. */
  deleteState(vpsId: string): Promise<boolean>;
  /**
   * Delete all credentials for a VPS. Returns the number removed.
   * Removal (not revoke) mirrors Postgres `ON DELETE CASCADE`.
   */
  deleteCredentialsByVps(vpsId: string): Promise<number>;

  upsertSystemInfo(info: AgentSystemInfo): Promise<AgentSystemInfo>;
  getSystemInfo(vpsId: string): Promise<AgentSystemInfo | undefined>;
  listSystemInfo(): Promise<AgentSystemInfo[]>;
  /** Delete persisted system info for a VPS. Returns true if anything was removed. */
  deleteSystemInfo(vpsId: string): Promise<boolean>;
  /**
   * Delete every agent-scoped row for a VPS: credentials, system info, then
   * lifecycle state last so a `not_installed` retry checkpoint survives until
   * the terminal `store.delete` succeeds. Idempotent.
   */
  deleteVpsData(vpsId: string): Promise<void>;
};

// ── Storage shape ───────────────────────────────────────────────────────
// JSON-backed, single-process / local-only until a DB migration is added.

type AgentFile = {
  credentials: AgentCredential[];
  states: Record<string, AgentState>;
  systemInfo?: Record<string, AgentSystemInfo>;
};

// ── Factory ─────────────────────────────────────────────────────────────

export function createJsonAgentRepository(
  filePath = "data/agents.json",
): AgentRepository {
  return {
    async createCredential(input) {
      return readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          const credential: AgentCredential = {
            ...input,
            id: input.id ?? `cred_${nanoid(12)}`,
            createdAt: new Date().toISOString(),
          };
          data.credentials.push(credential);
          return data;
        },
      ).then((data) => {
        const created = data.credentials[data.credentials.length - 1];
        if (!created) throw new Error("Failed to create credential");
        return created;
      });
    },

    async getCredential(id) {
      const data = await readJsonFile<AgentFile>(filePath, {
        credentials: [],
        states: {},
      });
      return data.credentials.find((c) => c.id === id);
    },

    async listCredentialsByVps(vpsId) {
      const data = await readJsonFile<AgentFile>(filePath, {
        credentials: [],
        states: {},
      });
      return data.credentials.filter((c) => c.vpsId === vpsId);
    },

    async updateCredential(id, patch) {
      return withFileLock(filePath, async () => {
        const data = await readJsonFile<AgentFile>(filePath, {
          credentials: [],
          states: {},
        });
        const index = data.credentials.findIndex((c) => c.id === id);
        if (index === -1) return undefined;
        data.credentials[index] = { ...data.credentials[index], ...patch };
        await writeJsonFile(filePath, data);
        return data.credentials[index];
      });
    },
    async acceptHeartbeat(input) {
      let accepted: AgentCredential | undefined;
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          const index = data.credentials.findIndex((credential) =>
            credential.id === input.credentialId &&
            credential.vpsId === input.vpsId &&
            credential.status !== "revoked",
          );
          if (index < 0) return data;
          const current = data.credentials[index]!;
          const next: AgentCredential = {
            ...current,
            status: "active",
            activatedAt: current.activatedAt ?? input.lastUsedAt,
            lastUsedAt: input.lastUsedAt,
            ...(input.lastUsedIp !== undefined ? { lastUsedIp: input.lastUsedIp } : {}),
          };
          data.credentials[index] = next;
          const previous = data.states[input.vpsId];
          data.states[input.vpsId] = {
            vpsId: input.vpsId,
            status: "online",
            version: input.version,
            buildId: input.buildId,
            installedAt: previous?.installedAt,
            lastSeenAt: input.lastSeenAt,
            lastError: undefined,
            lastInstallJobId: previous?.lastInstallJobId,
          };
          accepted = next;
          return data;
        },
      );
      return accepted;
    },
    async createInstallCredential(input, state) {
      let created: AgentCredential | undefined;
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          created = {
            ...input,
            id: input.id ?? `cred_${nanoid(12)}`,
            createdAt: new Date().toISOString(),
          };
          data.credentials.push(created);
          data.states[state.vpsId] = state;
          return data;
        },
      );
      if (!created) throw new Error("Failed to create install credential");
      return created;
    },

    async revokeCredential(id) {
      return this.updateCredential(id, {
        status: "revoked",
        revokedAt: new Date().toISOString(),
      });
    },

    async revokeOtherActiveAgentCredentials(vpsId, keepCredentialId) {
      let revokedIds: string[] = [];
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          const keep = data.credentials.find(
            (c) => c.id === keepCredentialId && c.vpsId === vpsId,
          );
          if (!keep) {
            throw new Error(
              `Credential "${keepCredentialId}" not found for VPS "${vpsId}"; refusing to revoke anything.`,
            );
          }
          if (keep.status !== "active") {
            throw new Error(
              `Credential "${keepCredentialId}" is "${keep.status}", not active; refusing to revoke anything.`,
            );
          }
          if ((keep.scope ?? "agent") !== "agent") {
            throw new Error(
              `Credential "${keepCredentialId}" has scope "${keep.scope}", expected "agent"; refusing to revoke anything.`,
            );
          }
          const now = new Date().toISOString();
          revokedIds = [];
          for (const c of data.credentials) {
            if (
              c.vpsId === vpsId &&
              c.id !== keepCredentialId &&
              c.status === "active" &&
              (c.scope ?? "agent") === "agent"
            ) {
              c.status = "revoked";
              c.revokedAt = now;
              revokedIds.push(c.id);
            }
          }
          return data;
        },
      );
      return revokedIds;
    },

    async getState(vpsId) {
      const data = await readJsonFile<AgentFile>(filePath, {
        credentials: [],
        states: {},
      });
      return data.states[vpsId];
    },

    async upsertState(state) {
      return readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          data.states[state.vpsId] = state;
          return data;
        },
      ).then(() => state);
    },

    async upsertSyntheticLocalState(state) {
      let stored: AgentState | undefined;
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          const current = data.states[state.vpsId];
          if (!current || current.version === "0.1.0-local") {
            data.states[state.vpsId] = state;
            stored = state;
          } else {
            stored = current;
          }
          return data;
        },
      );
      return stored;
    },

    async markAgentAbsent(vpsId, expectedLastSeenAt) {
      let applied = false;
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          const current = data.states[vpsId];
          if (!current || current.status !== "online" || current.lastSeenAt !== expectedLastSeenAt) return data;
          data.states[vpsId] = { vpsId, status: "not_installed" };
          const revokedAt = new Date().toISOString();
          data.credentials = data.credentials.map((credential) =>
            credential.vpsId === vpsId && credential.status !== "revoked"
              ? { ...credential, status: "revoked", revokedAt }
              : credential,
          );
          applied = true;
          return data;
        },
      );
      return applied;
    },

    async listStates() {
      const data = await readJsonFile<AgentFile>(filePath, {
        credentials: [],
        states: {},
      });
      return Object.values(data.states ?? {});
    },
    async deleteState(vpsId) {
      let deleted = false;
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          if (data.states[vpsId]) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete data.states[vpsId];
            deleted = true;
          }
          return data;
        },
      );
      return deleted;
    },

    async deleteCredentialsByVps(vpsId) {
      let removed = 0;
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          const kept = data.credentials.filter((c) => c.vpsId !== vpsId);
          removed = data.credentials.length - kept.length;
          data.credentials = kept;
          return data;
        },
      );
      return removed;
    },


    async upsertSystemInfo(info) {
      let stored = info;
      return readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          if (!data.systemInfo) data.systemInfo = {};
          const current = data.systemInfo[info.vpsId];
          if (
            current &&
            new Date(current.collectedAt).getTime() >
              new Date(info.collectedAt).getTime()
          ) {
            stored = current;
            return data;
          }
          data.systemInfo[info.vpsId] = info;
          stored = info;
          return data;
        },
      ).then(() => stored);
    },

    async getSystemInfo(vpsId) {
      const data = await readJsonFile<AgentFile>(filePath, {
        credentials: [],
        states: {},
      });
      return data.systemInfo?.[vpsId];
    },

    async listSystemInfo() {
      const data = await readJsonFile<AgentFile>(filePath, {
        credentials: [],
        states: {},
      });
      return Object.values(data.systemInfo ?? {});
    },

    async deleteSystemInfo(vpsId) {
      let deleted = false;
      await readModifyWriteJsonFile<AgentFile>(
        filePath,
        { credentials: [], states: {} },
        (data) => {
          if (!data.systemInfo) return data;
          if (data.systemInfo[vpsId]) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete data.systemInfo[vpsId];
            deleted = true;
          }
          return data;
        },
      );
      return deleted;
    },
    async deleteVpsData(vpsId) {
      await this.deleteCredentialsByVps(vpsId);
      await this.deleteSystemInfo(vpsId);
      await this.deleteState(vpsId);
    },
  };
}
