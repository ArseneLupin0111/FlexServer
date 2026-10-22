import type { AgentState } from "../agents/agent.models.js";
import { HOST_FRESHNESS_THRESHOLD_MS } from "../common/host-health.js";

export type VpsRecord = {
  id: string;
  name: string;
  displayName?: string;
  host: string;
  port: number;
  username: string;
  provider?: string;
  /** Legacy read-only region field. */
  region?: string;
  city?: string;
  country?: string;
  locationDetectedAt?: string;
  tags?: string[];
  status?: "unknown" | "healthy" | "warning" | "unreachable";
  lastSeenAt?: string;
  notes?: string;
  keyProvisionedAt?: string;
  kind?: "remote" | "local";
  managedBy?: "user" | "system";
  dockerMetricsEnabled?: boolean;
  dockerManagementEnabled?: boolean;
  composeManagementEnabled?: boolean;
  sftpEnabled?: boolean;
  fleetAutoUpdate?: boolean;
  /** Persisted agent lifecycle state (from agent_states), surfaced on VPS data. */
  agentStatus?: "not_installed" | "installing" | "online" | "offline" | "failed";
  /** Job that last drove agent install/uninstall (used to track progress live). */
  lastAgentInstallJobId?: string;
  /** Last error captured by the agent lifecycle (install/uninstall). */
  agentLastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentStateOnVps = Pick<
  VpsRecord,
  "agentStatus" | "lastAgentInstallJobId" | "agentLastError"
>;

/**
 * Merge the persisted agent state for a VPS onto its record. Does not mutate
 * the input; returns the input untouched when no state exists so callers can
 * safely pass demo fixtures through.
 */
export function deriveAgentStatus(
  status: AgentState["status"],
  lastSeenAt: string | undefined,
  now = Date.now(),
): AgentState["status"] {
  if (status !== "online") return status;
  if (!lastSeenAt) return "offline";
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen) || now - seen >= HOST_FRESHNESS_THRESHOLD_MS) {
    return "offline";
  }
  return "online";
}

export function applyAgentState(
  record: VpsRecord,
  state?: AgentState,
  now = Date.now(),
): VpsRecord {
  if (!state) return record;
  return {
    ...record,
    agentStatus: deriveAgentStatus(state.status, state.lastSeenAt, now),
    lastAgentInstallJobId: state.lastInstallJobId,
    agentLastError: state.lastError,
  };
}

export type CreateVpsInput = {
  name: string;
  displayName?: string;
  host: string;
  port: number;
  username: string;
  provider?: string;
  tags?: string[];
  status?: "unknown" | "healthy" | "warning" | "unreachable";
  notes?: string;
  password?: string;
  fleetAutoUpdate?: boolean;
};

export type UpdateVpsInput = Partial<Omit<CreateVpsInput, "password">> & {
  dockerMetricsEnabled?: boolean;
  dockerManagementEnabled?: boolean;
  composeManagementEnabled?: boolean;
  sftpEnabled?: boolean;
};
