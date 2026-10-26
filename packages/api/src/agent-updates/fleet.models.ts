export type FleetPolicyMode = "auto" | "manual" | "pinned";

export interface FleetMaintenanceWindow {
  timezone: string;
  start: string; // HH:mm
  end: string; // HH:mm
  days: number[]; // 0=Sun..6=Sat
}

export interface FleetPolicy {
  mode: FleetPolicyMode;
  group: string; // Default fallback is "Default"
  pinnedReleaseId?: string;
  canary?: boolean;
  maintenanceWindow?: FleetMaintenanceWindow;
}

export type FleetHostStatus =
  | "idle"
  | "queued"
  | "updating"
  | "observing"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "offline"
  | "ai_stale"
  | "ai_unhealthy";

export interface FleetHost {
  vpsId: string;
  name: string;
  online: boolean;
  installedBuildId: string | null;
  targetReleaseId: string | null;
  policy: FleetPolicy;
  enrolled: boolean;
  setupRequired: boolean;
  status: FleetHostStatus;
  lastSeenAt: string | null;
}

export interface FleetGroup {
  name: string;
  description?: string;
}

export interface FleetRelease {
  id: string;
  version: string;
  buildId: string;
  publishedAt: string;
  channel: "stable";
  rollbackSafe: boolean;
  minUpdaterVersion?: string;
  upgradeFrom?: string[];
  components: string[];
  artifacts?: FleetArtifact[];
  ai?: {
    version: string;
    components: string[];
  };
  rawPayload: string;
  signature?: string;
  keyId?: string;
  createdAt: string;
}

export type FleetRolloutState =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type FleetRolloutHostState =
  | "queued"
  | "updating"
  | "observing"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface FleetRolloutHost {
  vpsId: string;
  state: FleetRolloutHostState;
  jobId?: string;
  isCanary?: boolean;
  observationStartedAt?: string;
  reason?: string;
  updatedAt: string;
}

export interface FleetRollout {
  id: string;
  releaseId: string;
  state: FleetRolloutState;
  group: string;
  createdAt: string;
  updatedAt: string;
  hosts: FleetRolloutHost[];
  reason?: string;
}

export type FleetNotificationKind = "info" | "warning" | "error" | "success";

export interface FleetNotification {
  id: string;
  createdAt: string;
  message: string;
  kind: FleetNotificationKind;
}

export type FleetArtifactComponent =
  | "agent"
  | "ai-executor"
  | "ai-host-helper"
  | "ai-rootfs"
  | "ai-profiles";

export interface FleetArtifact {
  component: FleetArtifactComponent;
  os: "linux";
  arch: "amd64" | "arm64";
  url: string;
  sha256: string;
  size: number;
  version: string;
}

export interface FleetManifestPayload {
  schemaVersion: 1;
  releaseId: string;
  version: string;
  buildId: string;
  publishedAt: string;
  channel: "stable";
  rollbackSafe: boolean;
  minUpdaterVersion?: string;
  upgradeFrom?: string[];
  artifacts: FleetArtifact[];
  ai?: {
    version: string;
    components: string[];
  };
}

export interface FleetManifestEnvelope {
  payload: string; // Verbatim raw UTF-8 JSON string
  signature: string; // base64 Ed25519 signature
  keyId: string;
}

export interface FleetOverviewResponse {
  hosts: FleetHost[];
  groups: FleetGroup[];
  releases: FleetRelease[];
  rollouts: FleetRollout[];
  notifications: FleetNotification[];
}
