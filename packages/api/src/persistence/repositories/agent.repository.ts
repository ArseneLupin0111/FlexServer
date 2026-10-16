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

  getState(vpsId: string): Promise<AgentState | undefined>;
  upsertState(state: AgentState): Promise<AgentState>;
  /** Only synthesize local state while no real agent owns the heartbeat. */
  upsertSyntheticLocalState(state: AgentState): Promise<AgentState | undefined>;
  listStates(): Promise<AgentState[]>;
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

    async revokeCredential(id) {
      return this.updateCredential(id, {
        status: "revoked",
        revokedAt: new Date().toISOString(),
      });
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
