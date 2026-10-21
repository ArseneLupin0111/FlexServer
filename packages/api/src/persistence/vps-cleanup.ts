import type { AgentRepository } from "./repositories/agent.repository.js";
import type { JobRepository } from "./repositories/job.repository.js";
import type { MetricRepository } from "./repositories/metric.repository.js";
import type { DockerMonitoringRepository } from "./repositories/docker-monitoring.repository.js";
import type { DockerManagementRepository } from "./repositories/docker-management.repository.js";
import type { LocalUpgradeRepository } from "./repositories/local-upgrade.repository.js";
import type { HostKeyPinRepository } from "../ssh/host-key-pin.repository.js";
import type { TerminalSessionService } from "../terminal/terminal-session.service.js";
import type { DockerLogsService } from "../docker/docker-logs.service.js";
import type { ApplicationsService } from "../docker-applications/applications.service.js";

export type VpsCleanup = {
  prepare(id: string): Promise<void>;
  purge(id: string): Promise<void>;
};

export function createVpsCleanup(
  agent: AgentRepository, jobs: JobRepository, metrics: MetricRepository,
  docker: DockerMonitoringRepository, management: DockerManagementRepository,
  upgrades: LocalUpgradeRepository, pins: HostKeyPinRepository,
  terminal: TerminalSessionService, logs: DockerLogsService,
  applications?: ApplicationsService,
): VpsCleanup {
  return {
    async prepare(id) {
      await applications?.assertVpsRemovable(id);
      const active = await jobs.list();
      if (active.some(job => job.vpsId === id && (job.status === "queued" || job.status === "running"))) {
        throw new Error("Wait for active server jobs to finish before removing this server");
      }
      await terminal.closeByVps(id);
      logs.closeByVps(id);
    },
    async purge(id) {
      await applications?.purgeVps(id);
      await jobs.deleteByVps(id);
      await metrics.deleteByVps(id);
      await docker.cleanupForVps({ vpsId: id, reason: "vps_deleted" });
      await management.deleteByVps(id);
      await upgrades.deleteByVps(id);
      await pins.deleteByVpsId(id);
      await agent.deleteVpsData(id);
    },
  };
}
