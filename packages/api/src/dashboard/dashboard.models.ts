import type { AgentSystemInfo } from "../agents/agent.models.js";
import type { AuditEvent } from "../audit/audit.models.js";
import type { CommandJob } from "../jobs/jobs.models.js";
import type { MetricSample } from "../metrics/metrics.models.js";
import type { VpsRecord } from "../vps/vps.models.js";
import type { AppMode } from "../config/app-config.js";

export type MetricFreshness = "fresh" | "stale";

export type DashboardMetricSample = MetricSample & {
  freshness: MetricFreshness;
};

export type DashboardJob = CommandJob & {
  progress: number;
};

export type DemoTerminalSession = {
  command: string;
  output: string;
};

export type DemoTerminalOverview = {
  label: string;
  networkAccess: "disabled";
  commands: string[];
  sessions: DemoTerminalSession[];
};

export type DashboardSettings = {
  appMode: AppMode;
  webTerminalEnabled: boolean;
  terminalCommandGuardEnabled: boolean;
  realSshEnabled: boolean;
  authRequiredInLocalMode: boolean;
};

export type DashboardSummary = {
  totalServers: number;
  healthyServers: number;
  warningServers: number;
  unreachableServers: number;
  runningJobs: number;
};

/**
 * Latest committed Docker snapshot for one enabled VPS.
 *
 * Everything derives from `DockerMonitoringRepository`'s newest committed
 * snapshot: host aggregates from the latest host sample, authoritative
 * extras (sourceSequence, availability, engine metadata) from
 * `getAuthoritativeLatest`, and container identity/display/metrics subset
 * from `listCurrentContainers`. Fields written only by post-cutover ingests
 * (available, errorCode, engineVersion, apiVersion, image, status) stay
 * absent for pre-cutover rows until the next committed snapshot.
 */
export type DashboardDockerMetrics = {
  vpsId: string;
  agentInstanceId: string;
  snapshotId: string;
  schemaVersion: 2;
  collectedAt: string;
  receivedAt: string;
  effectiveAt: string;
  freshness: MetricFreshness;
  ageSeconds?: number;
  lastUpdatedAt: string;
  agentVersion?: string;
  sourceSequence: string;
  available?: boolean;
  errorCode?: string;
  engineVersion?: string;
  apiVersion?: string;
  containerTotal: number;
  containerRunning: number;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes?: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  containers: DashboardDockerContainer[];
};

export type DashboardDockerContainer = {
  containerKey: string;
  name: string;
  state: string;
  image?: string;
  status?: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  pids: number;
};

export type DashboardOverview = {
  mode: AppMode;
  banner?: string;
  summary: DashboardSummary;
  servers: VpsRecord[];
  metrics: DashboardMetricSample[];
  jobs: DashboardJob[];
  auditEvents: AuditEvent[];
  terminal: DemoTerminalOverview;
  settings: DashboardSettings;
  systemInfo: AgentSystemInfo[];
  dockerMetrics: DashboardDockerMetrics[];
};
