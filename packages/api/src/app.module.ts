import {
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { join } from "node:path";
import { createVpsCleanup } from "./persistence/vps-cleanup.js";
import type { Pool } from "pg";
import { AuditService } from "./audit/audit.service.js";
import { loadAppConfig, type AppConfig } from "./config/app-config.js";
import { AgentController } from "./agents/agent.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { VpsController } from "./vps/vps.controller.js";
import { HealthController } from "./health/health.controller.js";
import { DashboardController } from "./dashboard/dashboard.controller.js";
import { DashboardService } from "./dashboard/dashboard.service.js";
import { JobsController } from "./jobs/jobs.controller.js";
import { JobService } from "./jobs/job.service.js";
import { JobRunnerService } from "./jobs/job-runner.service.js";
import { MetricsController } from "./metrics/metrics.controller.js";
import { MetricService } from "./metrics/metric.service.js";
import { AuditController } from "./audit/audit.controller.js";
import { MonitoringController } from "./monitoring/monitoring.controller.js";
import { MonitoringService } from "./monitoring/monitoring.service.js";
import { DashboardSessionGuard } from "./auth/dashboard-session.guard.js";
import { DashboardSessionService } from "./auth/dashboard-session.service.js";
import { OriginGuard } from "./auth/origin-guard.js";
import type { AdminCredentialRepository } from "./persistence/repositories/admin-credential.repository.js";
import type { AgentRepository } from "./persistence/repositories/agent.repository.js";
import type { AuditRepository } from "./persistence/repositories/audit.repository.js";
import { createRepositories } from "./persistence/repositories/create-repositories.js";
import type { JobRepository } from "./persistence/repositories/job.repository.js";
import type { MetricRepository } from "./persistence/repositories/metric.repository.js";
import type { SessionRepository } from "./persistence/repositories/session.repository.js";
import { createKeyService, type KeyService } from "./ssh/keyService.js";
import { SshService } from "./ssh/ssh.service.js";
import { HostKeyPinService } from "./ssh/host-key-pin.service.js";
import type { HostKeyPinRepository } from "./ssh/host-key-pin.repository.js";
import { AgentInstallerService } from "./agents/agent-installer.service.js";
import { AgentUninstallerService } from "./agents/agent-uninstaller.service.js";
import { AgentLifecycleCoordinator } from "./agents/agent-lifecycle-coordinator.js";
import { AgentRestartService } from "./agents/agent-restart.service.js";
import { AgentRotationService } from "./agents/agent-rotation.service.js";
import { LocalAgentRotationHelper } from "./agents/local-agent-rotation-helper.service.js";
import { AgentService } from "./agents/agent.service.js";
import { LocalUpgradeController } from "./local-upgrade/local-upgrade.controller.js";
import { LocalUpgradeService } from "./local-upgrade/local-upgrade.service.js";
import { AgentConvergenceService } from "./local-upgrade/agent-convergence.service.js";
import { LocalUpdaterController } from "./local-upgrade/local-updater.controller.js";
import { BundledAgentService } from "./local-upgrade/bundled-agent.service.js";
import { JobActivityService } from "./jobs/job-activity.service.js";
import { VpsService } from "./vps/vps.service.js";
import type { VpsRepository } from "./persistence/repositories/vps.repository.js";
import { LocalAgentSupervisorService } from "./agents/local-agent-supervisor.service.js";
import { TerminalSessionService } from "./terminal/terminal-session.service.js";
import { DockerMonitoringController } from "./docker/docker-monitoring.controller.js";
import { DockerManagementController } from "./docker/docker-management.controller.js";
import { DockerManagementService } from "./docker/docker-management.service.js";
import { DockerLogsService } from "./docker/docker-logs.service.js";
import { AgentLogsController } from "./agents/agent-logs.controller.js";
import { DockerMonitoringService } from "./docker/docker-monitoring.service.js";
import { DockerMonitoringMaintenanceService } from "./docker/docker-monitoring-maintenance.service.js";
import { DockerActivityService } from "./docker/docker-activity.service.js";
import type { DockerMonitoringRepository } from "./persistence/repositories/docker-monitoring.repository.js";
import type { DockerManagementRepository } from "./persistence/repositories/docker-management.repository.js";
import type { LocalUpgradeRepository } from "./persistence/repositories/local-upgrade.repository.js";
import { DashboardSettingsService } from "./dashboard/dashboard-settings.service.js";
import { LocalTerminalService } from "./terminal/local-terminal.service.js";
import { FilesController } from "./files/files.controller.js";
import { FilesService } from "./files/files.service.js";
import type { FilesTransport } from "./files/files.models.js";
import type { SettingsRepository } from "./persistence/repositories/settings.repository.js";
import { APPLICATIONS_INVENTORY_REPOSITORY, ApplicationsInventoryAgentController } from "./docker-applications/inventory.controller.js";
import { createJsonApplicationsInventoryRepository, type ApplicationsInventoryRepository } from "./persistence/repositories/applications-inventory.repository.js";
import { createPostgresApplicationsInventoryRepository } from "./persistence/repositories/applications-inventory.postgres.repository.js";
import { ApplicationsService, APPLICATIONS_REPOSITORY } from "./docker-applications/applications.service.js";
import { AgentApplicationsController } from "./docker-applications/agent.controller.js";
import { ApplicationsController } from "./docker-applications/applications.controller.js";
import { createJsonApplicationsRepository, createPostgresApplicationsRepository } from "./persistence/repositories/applications.repository.js";
import {
  ADMIN_CREDENTIAL_REPOSITORY,
  AGENT_REPOSITORY,
  APP_CONFIG,
  AUDIT_REPOSITORY,
  DATABASE_POOL,
  DOCKER_MONITORING_REPOSITORY,
  DOCKER_MANAGEMENT_REPOSITORY,
  HOST_KEY_PIN_REPOSITORY,
  JOB_REPOSITORY,
  KEY_SERVICE,
  LOCAL_UPGRADE_REPOSITORY,
  METRIC_REPOSITORY,
  SESSION_REPOSITORY,
  VPS_REPOSITORY,
  SETTINGS_REPOSITORY,
  LOCAL_FILES_TRANSPORT,
  REMOTE_FILES_TRANSPORT,
} from "./tokens.js";
import { AI_REPOSITORY } from "./tokens.js";
import {
  createJsonAiRepository,
  createPostgresAiRepository,
} from "./persistence/repositories/ai.repository.js";
import type { AiRepository } from "./persistence/repositories/ai.persistence.js";
import { AiRoutesService } from "./ai/ai-routes.service.js";
import { AiSettingsController, AiPolicyController } from "./ai/ai.controller.js";
import { AiPolicyService } from "./ai/ai-policy.service.js";
import { AiProviderMigrationService } from "./ai/ai-provider-migration.service.js";
import { AiTaskService } from "./ai/ai-task.service.js";
import { AiHostPlanService } from "./ai/ai-host-plan.service.js";
import { AiDockerBridgeService } from "./ai/ai-docker-bridge.service.js";
import { AiAgentController } from "./ai/ai-agent.controller.js";
import { AiAgentService } from "./ai/ai-agent.service.js";
import { AiReadToolsService } from "./ai/ai-read-tools.service.js";
import { AiRetentionService } from "./ai/ai-retention.service.js";
import { FLEET_REPOSITORY, FLEET_SERVICE } from "./tokens.js";
import type { FleetRepository } from "./persistence/repositories/fleet.repository.js";
import { FleetService } from "./agent-updates/fleet.service.js";
import { AgentUpdatesController } from "./agent-updates/agent-updates.controller.js";
import { FleetProvisioningService } from "./agents/fleet-provisioning.service.js";
import { FLEET_PROVISIONING_SERVICE } from "./tokens.js";
export {
  ADMIN_CREDENTIAL_REPOSITORY,
  AGENT_REPOSITORY,
  AI_REPOSITORY,
  APP_CONFIG,
  AUDIT_REPOSITORY,
  DATABASE_POOL,
  DOCKER_MONITORING_REPOSITORY,
  DOCKER_MANAGEMENT_REPOSITORY,
  HOST_KEY_PIN_REPOSITORY,
  JOB_REPOSITORY,
  KEY_SERVICE,
  LOCAL_UPGRADE_REPOSITORY,
  METRIC_REPOSITORY,
  SESSION_REPOSITORY,
  VPS_REPOSITORY,
  SETTINGS_REPOSITORY,
  FLEET_PROVISIONING_SERVICE,
};

const DATABASE_POOL_OWNS = Symbol("DATABASE_POOL_OWNS");

export type AppDependencies = {
  config?: AppConfig;
  store?: VpsRepository;
  keys?: KeyService;
  audit?: AuditRepository;
  jobs?: JobRepository;
  metrics?: MetricRepository;
  agent?: AgentRepository;
  sessions?: SessionRepository;
  adminCredential?: AdminCredentialRepository;
  hostKeyPins?: HostKeyPinRepository;
  dockerMonitoring?: DockerMonitoringRepository;
  dockerManagement?: DockerManagementRepository;
  localUpgrades?: LocalUpgradeRepository;
  settings?: SettingsRepository;
  applicationsInventory?: ApplicationsInventoryRepository;
  ai?: AiRepository;
  fleet?: FleetRepository;
  localFilesTransport?: FilesTransport;
  remoteFilesTransport?: FilesTransport;
  /** Optional pre-created DB pool. Caller owns lifecycle unless ownsPool=true. */
  pool?: Pool;
  ownsPool?: boolean;
};

export class AppModule {}

Module({})(AppModule);

class DatabasePoolShutdown implements OnApplicationShutdown {
  constructor(
    @Optional() @Inject(DATABASE_POOL) private readonly pool?: Pool,
    @Optional() @Inject(DATABASE_POOL_OWNS) private readonly ownsPool?: boolean,
  ) {}

  async onApplicationShutdown() {
    if (this.ownsPool) {
      await this.pool?.end();
    }
  }
}

export function createAppModule(deps: AppDependencies = {}): DynamicModule {
  const config = deps.config ?? loadAppConfig();
  const needsRepositories =
    !deps.store ||
    !deps.audit ||
    !deps.jobs ||
    !deps.metrics ||
    !deps.agent ||
    !deps.sessions ||
    !deps.adminCredential ||
    !deps.hostKeyPins ||
    !deps.dockerMonitoring ||
    !deps.dockerManagement ||
    !deps.localUpgrades;
  const repositories = needsRepositories
    ? createRepositories(config, deps.pool)
    : undefined;
  const pool = deps.pool ?? repositories?.pool;
  const ownsPool = Boolean(
    (deps.pool && deps.ownsPool) || (!deps.pool && repositories?.pool),
  );

  return {
    module: AppModule,
    controllers: [
      HealthController,
      DashboardController,
      VpsController,
      JobsController,
      MetricsController,
      AuditController,
      MonitoringController,
      AgentController,
      AgentLogsController,
      AuthController,
      DockerMonitoringController,
      DockerManagementController,
      LocalUpgradeController,
      LocalUpdaterController,
      FilesController,
      ApplicationsInventoryAgentController,
      AgentApplicationsController,
      ApplicationsController,
      AiSettingsController,
      AiPolicyController,
      AiAgentController,
      AgentUpdatesController,
    ],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      {
        provide: AI_REPOSITORY,
        useValue:
          deps.ai ??
          repositories?.ai ??
          (pool
            ? createPostgresAiRepository(pool)
            : createJsonAiRepository(join(config.dataDir, "ai.json"))),
      },
      AiRoutesService,
      AiPolicyService,
      AiProviderMigrationService,
      AiHostPlanService,
      AiDockerBridgeService,
      AiTaskService,
      AiAgentService,
      AiReadToolsService,
      AiRetentionService,
      { provide: DATABASE_POOL, useValue: pool }, 
      { provide: DATABASE_POOL_OWNS, useValue: ownsPool },
      DatabasePoolShutdown,
      { provide: APPLICATIONS_INVENTORY_REPOSITORY, useValue: deps.applicationsInventory ?? repositories?.applicationsInventory ?? (pool ? createPostgresApplicationsInventoryRepository(pool) : createJsonApplicationsInventoryRepository(join(config.dataDir, "applications-inventory.json"))) },
      ApplicationsService,
      { provide: APPLICATIONS_REPOSITORY, useValue: pool ? createPostgresApplicationsRepository(pool) : createJsonApplicationsRepository(config.dataDir) },
      { provide: VPS_REPOSITORY, useValue: deps.store ?? repositories!.vps },
      {
        provide: KEY_SERVICE,
        useValue:
          deps.keys ??
          createKeyService({
            baseDir: join(config.privateDir, "keys"),
            keyringFilePath: config.sshKeyEncryptionKeyFile,
          }),
      },
      {
        provide: AUDIT_REPOSITORY,
        useValue: deps.audit ?? repositories!.audit,
      },
      { provide: JOB_REPOSITORY, useValue: deps.jobs ?? repositories!.jobs },
      {
        provide: METRIC_REPOSITORY,
        useValue: deps.metrics ?? repositories!.metrics,
      },
      {
        provide: AGENT_REPOSITORY,
        useValue: deps.agent ?? repositories!.agent,
      },
      {
        provide: SESSION_REPOSITORY,
        useValue: deps.sessions ?? repositories!.sessions,
      },
      {
        provide: ADMIN_CREDENTIAL_REPOSITORY,
        useValue: deps.adminCredential ?? repositories!.adminCredential,
      },
      {
        provide: SETTINGS_REPOSITORY,
        useValue: deps.settings ?? repositories!.settings,
      },
      DashboardSettingsService,
      FilesService,
      ...(deps.localFilesTransport
        ? [{ provide: LOCAL_FILES_TRANSPORT, useValue: deps.localFilesTransport }]
        : []),
      ...(deps.remoteFilesTransport
        ? [{ provide: REMOTE_FILES_TRANSPORT, useValue: deps.remoteFilesTransport }]
        : []),
      LocalTerminalService,
      DashboardSessionService,
      {
        provide: TerminalSessionService,
        inject: [
          APP_CONFIG,
          VPS_REPOSITORY,
          KEY_SERVICE,
          SshService,
          DashboardSessionService,
          AgentLifecycleCoordinator,
          AuditService,
          DashboardSettingsService,
          LocalTerminalService,
        ],
        useFactory: (
          config: AppConfig,
          vps: VpsRepository,
          keys: KeyService,
          ssh: SshService,
          sessions: DashboardSessionService,
          coordinator: AgentLifecycleCoordinator,
          audit: AuditService,
          settings: DashboardSettingsService,
          localTerminal: LocalTerminalService,
        ) =>
          new TerminalSessionService(
            config,
            vps,
            keys,
            ssh,
            sessions,
            coordinator,
            audit,
            settings,
            localTerminal,
          ),
      },
      DashboardSessionGuard,
      OriginGuard,
      AgentLifecycleCoordinator,
      AgentInstallerService,
      AgentUninstallerService,
      AgentRestartService,
      LocalAgentRotationHelper,
      AgentRotationService,
      LocalAgentSupervisorService,
      JobActivityService,
      {
        provide: AgentService,
        inject: [
          AGENT_REPOSITORY,
          METRIC_REPOSITORY,
          VPS_REPOSITORY,
           APP_CONFIG,
           AgentLifecycleCoordinator,
           DockerMonitoringService,
         ],
        useFactory: (
          agentRepo: AgentRepository,
          metricRepo: MetricRepository,
          vpsRepo: VpsRepository,
           appConfig: AppConfig,
           lifecycle: AgentLifecycleCoordinator,
           dockerMonitoringService: DockerMonitoringService,
         ) => new AgentService(agentRepo, metricRepo, vpsRepo, appConfig, lifecycle, dockerMonitoringService),
      },
      AuditService,
      {
        provide: DashboardService,
        inject: [
          APP_CONFIG,
          VPS_REPOSITORY,
          METRIC_REPOSITORY,
          AGENT_REPOSITORY,
          JOB_REPOSITORY,
          DOCKER_MONITORING_REPOSITORY,
          DashboardSettingsService,
        ],
        useFactory: (
          config: AppConfig,
          vps: VpsRepository,
          metrics: MetricRepository,
          agent: AgentRepository,
          jobs: JobRepository,
          dockerMonitoring: DockerMonitoringRepository,
          settings: DashboardSettingsService,
        ) =>
          new DashboardService(
            config,
            vps,
            metrics,
            agent,
            jobs,
            dockerMonitoring,
            settings,
          ),
      },
      JobRunnerService,
      JobService,
      MetricService,
      MonitoringService,
      {
        provide: SshService,
        inject: [APP_CONFIG, AuditService, HostKeyPinService],
        useFactory: (
          appConfig: AppConfig,
          audit: AuditService,
          hostKeyPin: HostKeyPinService,
        ) => new SshService(appConfig, audit, hostKeyPin),
      },
      {
        provide: HOST_KEY_PIN_REPOSITORY,
        useValue: deps.hostKeyPins ?? repositories!.hostKeyPins,
      },
      {
        provide: DOCKER_MONITORING_REPOSITORY,
        useValue: deps.dockerMonitoring ?? repositories!.dockerMonitoring,
      },
      {
        provide: DOCKER_MANAGEMENT_REPOSITORY,
        useValue: deps.dockerManagement ?? repositories!.dockerManagement,
      },
      {
        provide: LOCAL_UPGRADE_REPOSITORY,
        useValue: deps.localUpgrades ?? repositories!.localUpgrades,
      },
      BundledAgentService,
      LocalUpgradeService,
      AgentConvergenceService,
      {
        provide: FLEET_REPOSITORY,
        useValue: deps.fleet ?? repositories!.fleet,
      },
      {
        provide: FleetService,
        inject: [
          APP_CONFIG,
          FLEET_REPOSITORY,
          VPS_REPOSITORY,
          AGENT_REPOSITORY,
          LOCAL_UPGRADE_REPOSITORY,
          LocalUpgradeService,
          METRIC_REPOSITORY,
          AuditService,
          SshService,
          KEY_SERVICE,
          DATABASE_POOL,
        ],
        useFactory: (
          appConfig: AppConfig,
          fleetRepo: FleetRepository,
          vpsRepo: VpsRepository,
          agentRepo: AgentRepository,
          localUpgradeRepo: LocalUpgradeRepository,
          localUpgradeService: LocalUpgradeService,
          metricRepo: MetricRepository,
          audit: AuditService,
          ssh: SshService,
          keys: KeyService,
          pool?: Pool,
        ) =>
          new FleetService({
            config: appConfig,
            fleetRepository: fleetRepo,
            vpsRepository: vpsRepo,
            agentRepository: agentRepo,
            localUpgradeRepository: localUpgradeRepo,
            localUpgradeService,
            metricRepository: metricRepo,
            auditService: audit,
            sshService: ssh,
            keyService: keys,
            pool,
          }),
      },
      {
        provide: FLEET_SERVICE,
        useExisting: FleetService,
      },
      {
        provide: FleetProvisioningService,
        inject: [
          APP_CONFIG,
          VPS_REPOSITORY,
          KEY_SERVICE,
          AGENT_REPOSITORY,
          AgentService,
          SshService,
          AuditService,
          FLEET_REPOSITORY,
        ],
        useFactory: (
          config: AppConfig,
          vpsRepo: VpsRepository,
          keys: KeyService,
          agentRepo: AgentRepository,
          agentService: AgentService,
          ssh: SshService,
          audit: AuditService,
          fleetRepo?: FleetRepository,
        ) =>
          new FleetProvisioningService(
            config,
            vpsRepo,
            keys,
            agentRepo,
            agentService,
            ssh,
            audit,
            fleetRepo,
          ),
      },
      {
        provide: FLEET_PROVISIONING_SERVICE,
        useExisting: FleetProvisioningService,
      },
       DockerActivityService,
       DockerMonitoringService,
       DockerManagementService,
       DockerLogsService,
       DockerMonitoringMaintenanceService,
       HostKeyPinService,
      {
        provide: VpsService,
        inject: [
          VPS_REPOSITORY,
          KEY_SERVICE,
          SshService,
          AuditService,
          APP_CONFIG,
          AgentInstallerService,
          AgentUninstallerService,
          AGENT_REPOSITORY,
          HostKeyPinService,
           AgentRestartService,
           DockerMonitoringService,
          JOB_REPOSITORY, METRIC_REPOSITORY, DOCKER_MONITORING_REPOSITORY,
          DOCKER_MANAGEMENT_REPOSITORY, LOCAL_UPGRADE_REPOSITORY,
          HOST_KEY_PIN_REPOSITORY, TerminalSessionService, DockerLogsService,
          AgentLifecycleCoordinator,
          FilesService,
          ApplicationsService,
          FLEET_REPOSITORY,
          FleetProvisioningService,
        ],
        useFactory: (
          store: VpsRepository,
          keys: KeyService,
          ssh: SshService,
          audit: AuditService,
          appConfig: AppConfig,
          installer: AgentInstallerService,
          uninstaller: AgentUninstallerService,
          agentRepo: AgentRepository,
          hostKeyPin: HostKeyPinService,
          restarter: AgentRestartService,
          dockerMonitoringService: DockerMonitoringService,
          jobs: JobRepository, metrics: MetricRepository, docker: DockerMonitoringRepository,
          management: DockerManagementRepository, upgrades: LocalUpgradeRepository,
          pins: HostKeyPinRepository, terminal: TerminalSessionService, logs: DockerLogsService,
          lifecycle: AgentLifecycleCoordinator,
          filesService: FilesService,
          applications: ApplicationsService,
          fleet: FleetRepository,
          fleetProvisioning: FleetProvisioningService,
        ) =>
          new VpsService(
            store,
            keys,
            ssh,
            audit,
            appConfig,
            installer,
            uninstaller,
            agentRepo,
             hostKeyPin,
             restarter,
             dockerMonitoringService,
             createVpsCleanup(agentRepo, jobs, metrics, docker, management, upgrades, pins, terminal, logs, applications, fleet),
             lifecycle,
             filesService,
             fleetProvisioning,
           ),
      },
    ],
  };
}
