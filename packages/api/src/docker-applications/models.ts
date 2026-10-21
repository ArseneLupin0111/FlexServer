import { AppConfig } from "../config/app-config.js";

export type ComposeApplicationMode =
  | "detected_readonly"
  | "external_control"
  | "managed"
  | "unmanaged";

export type ComposeObservationKind = "longlived" | "oneshot";

export type DockerObservedReplica = {
  containerKey: string;
  agentInstanceId?: string;
  state: string;
  health?: string;
};

export type DockerObservedService = {
  service: string;
  kind: ComposeObservationKind;
  replicas: DockerObservedReplica[];
  desiredCount: number | null;
  profiles: string[];
  hasDependencies: boolean;
};

export type DockerProjectObservation = {
  projectName: string;
  daemonEpoch: string;
  agentInstanceId: string;
  services: DockerObservedService[];
  updatedAt: string;
};

export type DockerApplicationSource =
  | {
      kind: "external_control";
      verified: boolean;
      path?: string;
      digest?: string;
      verifiedAt?: string;
    }
  | { kind: "managed"; verified: false };

export type DockerApplicationIdentity = {
  id: string;
  vpsId: string;
  displayName: string;
  projectName: string;
  daemonEpoch: string;
  agentInstanceId?: string;
  mode: ComposeApplicationMode;
  generation: number;
  source?: DockerApplicationSource;
  createdAt: string;
  updatedAt: string;
};

export type DockerApplication = DockerApplicationIdentity & {
  observed?: DockerProjectObservation;
  capabilitiesReasons: string[];
  secrets: { name: string; version: number; updatedAt: string }[];
};

export type ComposeInventorySequence = {
  vpsId: string;
  agentInstanceId: string;
  daemonEpoch: string;
  sequence: number;
  collectedAt: string;
  receivedAt: string;
  completeness: boolean;
  completenessReason?: string;
  capabilities: ComposeAgentCapabilities;
  projects: ComposeDiscoveredProject[];
};

export type ComposeDiscoveredProject = {
  projectName: string;
  services: { service: string; kind: ComposeObservationKind; replicaCount: number; containerKeys: string[] }[];
};

export type ComposeAgentCapabilities = {
  agentInstanceId: string;
  daemonEpoch: string;
  protocolVersion: number;
  daemonVersion?: string;
  engine: { name: string; version?: string };
  composeVersion?: string;
};

