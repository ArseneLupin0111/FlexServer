import {
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { join } from "node:path";
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
import { AgentUpgraderService } from "./agents/agent-upgrader.service.js";
import { AgentRestartService } from "./agents/agent-restart.service.js";
import { AgentRotationService } from "./agents/agent-rotation.service.js";
import { LocalAgentRotationHelper } from "./agents/local-agent-rotation-helper.service.js";
import { AgentService } from "./agents/agent.service.js";
import { LocalUpgradeController } from "./local-upgrade/local-upgrade.controller.js";
import { LocalUpgradeService } from "./local-upgrade/local-upgrade.service.js";
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
} from "./tokens.js";

export {
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
    ],
    providers: [
      { provide: APP_CONFIG, useValue: config },
      { provide: DATABASE_POOL, useValue: pool },
      { provide: DATABASE_POOL_OWNS, useValue: ownsPool },
      DatabasePoolShutdown,
      { provide: VPS_REPOSITORY, useValue: deps.store ?? repositories!.vps },
      {
        provide: KEY_SERVICE,
        useValue:
          deps.keys ?? createKeyService(join(config.privateDir, "keys")),
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
      DashboardSessionService,
      TerminalSessionService,
      DashboardSessionGuard,
      OriginGuard,
      AgentLifecycleCoordinator,
      AgentInstallerService,
      AgentUninstallerService,
      AgentUpgraderService,
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
      DashboardService,
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
          AgentUpgraderService,
           AgentRestartService,
           DockerMonitoringService,
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
          upgrader: AgentUpgraderService,
           restarter: AgentRestartService,
           dockerMonitoringService: DockerMonitoringService,
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
             upgrader,
             restarter,
             dockerMonitoringService,
           ),
      },
    ],
  };
}
