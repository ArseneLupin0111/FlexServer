import { join } from "node:path";
import type { Pool } from "pg";
import type { AppConfig } from "../../config/app-config.js";
import { createDatabasePool } from "../../db/pool.js";
import { createVpsStore } from "../store/vpsStore.js";
import {
  createJsonAdminCredentialRepository,
  type AdminCredentialRepository,
} from "./admin-credential.repository.js";
import { createPostgresAdminCredentialRepository } from "./admin-credential.postgres.repository.js";
import {
  createJsonAgentRepository,
  type AgentRepository,
} from "./agent.repository.js";
import { createPostgresAgentRepository } from "./agent.postgres.repository.js";
import {
  createJsonAuditRepository,
  type AuditRepository,
} from "./audit.repository.js";
import { createPostgresAuditRepository } from "./audit.postgres.repository.js";
import {
  createJsonJobRepository,
  type JobRepository,
} from "./job.repository.js";
import { createPostgresJobRepository } from "./job.postgres.repository.js";
import {
  createJsonMetricRepository,
  type MetricRepository,
} from "./metric.repository.js";
import { createPostgresMetricRepository } from "./metric.postgres.repository.js";
import type { VpsRepository } from "./vps.repository.js";
import { createPostgresVpsRepository } from "./vps.postgres.repository.js";
import {
  createJsonSessionRepository,
  type SessionRepository,
} from "./session.repository.js";
import { createPostgresSessionRepository } from "./session.postgres.repository.js";
import {
  createJsonHostKeyPinRepository,
  type HostKeyPinRepository,
} from "../../ssh/host-key-pin.repository.js";
import { createPostgresHostKeyPinRepository } from "../../ssh/host-key-pin.postgres.repository.js";
import {
  createJsonDockerMonitoringRepository,
  type DockerMonitoringRepository,
} from "./docker-monitoring.repository.js";
import { createPostgresDockerMonitoringRepository } from "./docker-monitoring.postgres.repository.js";
import {
  createJsonDockerManagementRepository,
  createPostgresDockerManagementRepository,
  type DockerManagementRepository,
} from "./docker-management.repository.js";
import {
  createJsonLocalUpgradeRepository,
  type LocalUpgradeRepository,
} from "./local-upgrade.repository.js";
import { createPostgresLocalUpgradeRepository } from "./local-upgrade.postgres.repository.js";
import {
  createJsonSettingsRepository,
  type SettingsRepository,
} from "./settings.repository.js";
import { createPostgresSettingsRepository } from "./settings.postgres.repository.js";
import { createJsonApplicationsInventoryRepository, type ApplicationsInventoryRepository } from "./applications-inventory.repository.js";
import { createPostgresApplicationsInventoryRepository } from "./applications-inventory.postgres.repository.js";
import {
  createJsonAiRepository,
  createPostgresAiRepository,
} from "./ai.repository.js";
import type { AiRepository } from "./ai.persistence.js";
import { createJsonFleetRepository, type FleetRepository } from "./fleet.repository.js";
import { createPostgresFleetRepository } from "./fleet.postgres.repository.js";

import { registerComposeAdminContextFactory } from "../../crypto/secret-envelope.js";
import { createComposeAdminContext } from "./compose-admin-registry.js";

registerComposeAdminContextFactory(createComposeAdminContext);

export type RepositorySet = {
  vps: VpsRepository;
  audit: AuditRepository;
  jobs: JobRepository;
  metrics: MetricRepository;
  agent: AgentRepository;
  sessions: SessionRepository;
  adminCredential: AdminCredentialRepository;
  hostKeyPins: HostKeyPinRepository;
  dockerMonitoring: DockerMonitoringRepository;
  dockerManagement: DockerManagementRepository;
  localUpgrades: LocalUpgradeRepository;
  settings: SettingsRepository;
  applicationsInventory: ApplicationsInventoryRepository;
  ai?: AiRepository;
  pool?: Pool;
  fleet: FleetRepository;
};

/**
 * Create a repository set for the given config.
 *
 * If `existingPool` is provided (e.g. from a caller that already created one),
 * it is reused instead of creating a new pool. The caller owns the pool's lifecycle.
 */
export function createRepositories(
  config: AppConfig,
  existingPool?: Pool,
): RepositorySet {
  if (config.storageDriver === "postgres") {
    const pool = existingPool ?? createDatabasePool(config);
    return {
      pool,
      vps: createPostgresVpsRepository(pool),
      audit: createPostgresAuditRepository(pool),
      jobs: createPostgresJobRepository(pool),
      metrics: createPostgresMetricRepository(pool),
      agent: createPostgresAgentRepository(pool),
      sessions: createPostgresSessionRepository(pool),
      adminCredential: createPostgresAdminCredentialRepository(pool),
      hostKeyPins: createPostgresHostKeyPinRepository(pool),
      dockerMonitoring: createPostgresDockerMonitoringRepository(pool),
      dockerManagement: createPostgresDockerManagementRepository(pool),
      localUpgrades: createPostgresLocalUpgradeRepository(pool),
      settings: createPostgresSettingsRepository(pool),
      applicationsInventory: createPostgresApplicationsInventoryRepository(pool),
      ai: createPostgresAiRepository(pool),
      fleet: createPostgresFleetRepository(pool),
    };
  }

  return {
    applicationsInventory: createJsonApplicationsInventoryRepository(join(config.dataDir, "applications-inventory.json")),
    vps: createVpsStore(join(config.dataDir, "vps.json")),
    audit: createJsonAuditRepository(join(config.dataDir, "audit.json")),
    jobs: createJsonJobRepository(join(config.dataDir, "jobs.json")),
    metrics: createJsonMetricRepository(join(config.dataDir, "metrics.json")),
    agent: createJsonAgentRepository(join(config.dataDir, "agents.json")),
    sessions: createJsonSessionRepository(
      join(config.dataDir, "sessions.json"),
    ),
    adminCredential: createJsonAdminCredentialRepository(
      join(config.dataDir, "admin-credential.json"),
    ),
    hostKeyPins: createJsonHostKeyPinRepository(
      join(config.dataDir, "host-key-pins.json"),
    ),
    dockerMonitoring: createJsonDockerMonitoringRepository(
       join(config.dataDir, "docker-monitoring.json"),
       { maxBytes: config.dockerJsonMaxBytes, maintenanceMaxRewriteBytes: config.dockerJsonMaintenanceMaxRewriteBytes },
     ),
    dockerManagement: createJsonDockerManagementRepository(
      join(config.dataDir, "docker-management.json"),
    ),
    localUpgrades: createJsonLocalUpgradeRepository(
      join(config.dataDir, "local-upgrades.json"),
    ),
    settings: createJsonSettingsRepository(
      join(config.dataDir, "settings.json"),
    ),
    ai: createJsonAiRepository(join(config.dataDir, "ai.json")),
    fleet: createJsonFleetRepository(join(config.dataDir, "fleet.json")),
  };
}
