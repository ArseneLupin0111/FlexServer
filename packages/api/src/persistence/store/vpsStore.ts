import { nanoid } from "nanoid";
import type {
  CreateVpsInput,
  UpdateVpsInput,
  VpsRecord,
} from "../../vps/vps.models.js";
import {
  readJsonFile,
  readModifyWriteJsonFile,
} from "../repositories/json-file.js";
import {
  withVpsDefaults,
  type EnsureLocalHostInput,
  type VpsRepository,
} from "../repositories/vps.repository.js";

type StoreFile = { vps: VpsRecord[] };

const now = () => new Date().toISOString();

export function createVpsStore(filePath = "data/vps.json") {
  async function readStore(): Promise<StoreFile> {
    const data = await readJsonFile<StoreFile>(filePath, { vps: [] });
    return { vps: data.vps.map(withVpsDefaults) };
  }

  const repository: VpsRepository = {
    async list() {
      return (await readStore()).vps;
    },
    async get(id: string) {
      return (await readStore()).vps.find((vps) => vps.id === id);
    },
    async create(input: CreateVpsInput) {
      const id = `vps_${nanoid(12)}`;
      const timestamp = now();
      const record: VpsRecord = {
        id,
        name: input.name,
        displayName: input.displayName,
        host: input.host,
        port: input.port,
        username: input.username,
        provider: input.provider ?? "unknown",
         region: undefined,
        tags: input.tags ?? [],
        status: input.status ?? "unknown",
        notes: input.notes,
        kind: "remote",
        managedBy: "user",
        dockerMetricsEnabled: false,
        dockerManagementEnabled: false,
        sftpEnabled: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return readModifyWriteJsonFile<StoreFile>(
        filePath,
        { vps: [] },
        (data) => {
          data.vps = data.vps.map(withVpsDefaults);
          data.vps.push(record);
          return data;
        },
      ).then((data) => data.vps.find((vps) => vps.id === id) ?? record);
    },
    async update(id: string, input: UpdateVpsInput) {
      return readModifyWriteJsonFile<StoreFile>(
        filePath,
        { vps: [] },
        (data) => {
          data.vps = data.vps.map(withVpsDefaults);
          const index = data.vps.findIndex((vps) => vps.id === id);
          if (index === -1) return data;
          data.vps[index] = { ...data.vps[index], ...input, updatedAt: now() };
          return data;
        },
      ).then((data) => data.vps.find((vps) => vps.id === id));
    },
    async markKeyProvisioned(id: string) {
      return readModifyWriteJsonFile<StoreFile>(
        filePath,
        { vps: [] },
        (data) => {
          data.vps = data.vps.map(withVpsDefaults);
          const index = data.vps.findIndex((vps) => vps.id === id);
          if (index === -1) return data;
          const timestamp = now();
          data.vps[index] = {
            ...data.vps[index],
            keyProvisionedAt: timestamp,
            updatedAt: timestamp,
          };
          return data;
        },
      ).then((data) => data.vps.find((vps) => vps.id === id));
    },
    async updateAgentLocation(id, location) {
      return readModifyWriteJsonFile<StoreFile>(filePath, { vps: [] }, (data) => {
        data.vps = data.vps.map(withVpsDefaults);
        const index = data.vps.findIndex((v) => v.id === id);
        if (index === -1) return data;
        const current = data.vps[index]!;
        if (current.locationDetectedAt && Date.parse(current.locationDetectedAt) > Date.parse(location.detectedAt)) return data;
        data.vps[index] = { ...current, city: location.city, country: location.country, locationDetectedAt: location.detectedAt, updatedAt: now() };
        return data;
      }).then((data) => data.vps.find((v) => v.id === id));
    },
    async delete(id: string) {
      let deleted = false;
      await readModifyWriteJsonFile<StoreFile>(
        filePath,
        { vps: [] },
        (data) => {
          data.vps = data.vps.map(withVpsDefaults);
          const next = data.vps.filter((vps) => vps.id !== id);
          deleted = next.length !== data.vps.length;
          data.vps = next;
          return data;
        },
      );
      return deleted;
    },
    async ensureLocalHost(input: EnsureLocalHostInput) {
      return readModifyWriteJsonFile<StoreFile>(
        filePath,
        { vps: [] },
        (data) => {
          data.vps = data.vps.map(withVpsDefaults);
          const existing = data.vps.find((v) => v.id === input.id);
          if (existing) {
            // Update existing local host record
            const idx = data.vps.indexOf(existing);
            data.vps[idx] = {
              ...existing,
              name: input.name,
              displayName: input.displayName,
              host: input.host,
              port: input.port,
              username: input.username,
              provider: input.provider ?? "local",
              tags: input.tags ?? ["local", "local-agent", "system"],
              status: input.status ?? "unknown",
              notes: input.notes,
              kind: input.kind ?? "local",
              managedBy: input.managedBy ?? "system",
              dockerMetricsEnabled: existing.dockerMetricsEnabled ?? false,
              dockerManagementEnabled: existing.dockerManagementEnabled ?? false,
              sftpEnabled: existing.sftpEnabled ?? false,
              updatedAt: now(),
            };
          } else {
            // Create new local host record
            const timestamp = now();
            data.vps.push({
              id: input.id,
              name: input.name,
              displayName: input.displayName,
              host: input.host,
              port: input.port,
              username: input.username,
              provider: input.provider ?? "local",
              tags: input.tags ?? ["local", "local-agent", "system"],
              status: input.status ?? "unknown",
              notes: input.notes,
              kind: input.kind ?? "local",
              managedBy: input.managedBy ?? "system",
              dockerMetricsEnabled: false,
              dockerManagementEnabled: false,
              sftpEnabled: false,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          }
          return data;
        },
      ).then((data) => {
        const found = data.vps.find((v) => v.id === input.id);
        if (!found) throw new Error("Failed to ensure local host record");
        return found;
      });
    },
    async markSeen(
      id: string,
      status: VpsRecord["status"],
      lastSeenAt: string,
    ) {
      return readModifyWriteJsonFile<StoreFile>(
        filePath,
        { vps: [] },
        (data) => {
          data.vps = data.vps.map(withVpsDefaults);
          const index = data.vps.findIndex((vps) => vps.id === id);
          if (index === -1) return data;
          data.vps[index] = {
            ...data.vps[index],
            status,
            lastSeenAt,
            updatedAt: now(),
          };
          return data;
        },
      ).then((data) => data.vps.find((vps) => vps.id === id));
    },
  };

  return repository;
}

export type VpsStore = ReturnType<typeof createVpsStore>;
