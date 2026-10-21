import type {
  CreateVpsInput,
  UpdateVpsInput,
  VpsRecord,
} from "../../vps/vps.models.js";

export type EnsureLocalHostInput = CreateVpsInput & {
  /** Legacy field used only by local compatibility fixtures. */
  region?: string;
  id: string;
  kind?: "remote" | "local";
  managedBy?: "user" | "system";
};

export type VpsRepository = {
  list(): Promise<VpsRecord[]>;
  get(id: string): Promise<VpsRecord | undefined>;
  create(input: CreateVpsInput): Promise<VpsRecord>;
  update(id: string, input: UpdateVpsInput): Promise<VpsRecord | undefined>;
  markKeyProvisioned(id: string): Promise<VpsRecord | undefined>;
  updateAgentLocation(id: string, location: { city: string; country: string; detectedAt: string }): Promise<VpsRecord | undefined>;
  delete(id: string): Promise<boolean>;
  ensureLocalHost(input: EnsureLocalHostInput): Promise<VpsRecord>;
  markSeen(
    id: string,
    status: VpsRecord["status"],
    lastSeenAt: string,
  ): Promise<VpsRecord | undefined>;
};

export function withVpsDefaults(record: VpsRecord): VpsRecord {
  const normalized = { ...record };
  return {
    ...normalized,
    provider: normalized.provider ?? "unknown",
    tags: normalized.tags ?? [],
    status: normalized.status ?? "unknown",
    kind: normalized.kind ?? "remote",
    managedBy: normalized.managedBy ?? "user",
    dockerMetricsEnabled: normalized.dockerMetricsEnabled ?? false,
    dockerManagementEnabled: normalized.dockerManagementEnabled ?? false,
    composeManagementEnabled: normalized.composeManagementEnabled ?? false,
    sftpEnabled: normalized.sftpEnabled ?? false,
  };
}
