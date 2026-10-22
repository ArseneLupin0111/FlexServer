import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import { VpsService } from "../src/vps/vps.service.js";

const localVps: VpsRecord = {
  id: "vps_local_host",
  name: "Local host",
  host: "127.0.0.1",
  port: 22,
  username: "root",
  kind: "local",
  managedBy: "system",
  dockerMetricsEnabled: false,
  dockerManagementEnabled: false,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
};

function arrangeService(record: VpsRecord = localVps) {
  const update = vi.fn(
    async (_id: string, patch: Partial<VpsRecord>) => ({
      ...record,
      ...patch,
    }),
  );
  const store = {
    get: vi.fn(async () => record),
    update,
  } as unknown as VpsRepository;
  const audit = { record: vi.fn(async () => undefined) };
  const agentRepository = {
    getState: vi.fn(async () => undefined),
  } as unknown as AgentRepository;
  const config = { mode: "local" } as AppConfig;
  const cleanupForVps = vi.fn(async () => undefined);
  const service = new VpsService(
    store,
    {} as never,
    {} as never,
    audit as never,
    config,
    {} as never,
    {} as never,
    agentRepository,
    {} as never,
    undefined,
    { cleanupForVps } as never,
  );

  return { service, update, audit, agentRepository, cleanupForVps };
}

describe("local/system VPS Docker toggle updates", () => {
  it("accepts the exact dockerMetricsEnabled boolean patch", async () => {
    // Objective (positive): local/system VPS may toggle Docker metrics when the
    // request contains exactly the supported boolean field.
    // Arrange
    const { service, update, audit } = arrangeService();

    // Act
    const result = await service.update(localVps.id, {
      dockerMetricsEnabled: true,
    });

    // Assert
    expect(result.dockerMetricsEnabled).toBe(true);
    expect(update).toHaveBeenCalledWith(localVps.id, {
      dockerMetricsEnabled: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vps.docker_metrics.update" }),
    );
  });

  it("rejects a Docker toggle patch containing an unrelated field", async () => {
    // Objective (negative): local/system VPS updates must reject extra fields,
    // while preserving the valid exact-toggle behavior covered above.
    // Arrange
    const { service, update, audit } = arrangeService();

    // Act
    const action = service.update(localVps.id, {
      dockerMetricsEnabled: true,
      name: "not-allowed",
    });

    // Assert
    await expect(action).rejects.toMatchObject({ name: "ZodError" });
    expect(update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("persists a management-only patch without touching monitoring or history", async () => {
    // Bugfix objective: a management-only patch must disable management consent
    // tracking without disabling monitoring or cleaning up monitoring history.
    // Arrange: monitoring stays on throughout.
    const monitored: VpsRecord = {
      ...localVps,
      dockerMetricsEnabled: true,
      dockerManagementEnabled: false,
    };
    const { service, update, audit, cleanupForVps } =
      arrangeService(monitored);

    // Act
    const result = await service.update(localVps.id, {
      dockerManagementEnabled: true,
    });

    // Assert
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(localVps.id, {
      dockerManagementEnabled: true,
    });
    expect(cleanupForVps).not.toHaveBeenCalled();
    expect(result.dockerManagementEnabled).toBe(true);
    expect(result.dockerMetricsEnabled).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vps.docker_management.update" }),
    );
  });

  it("cleans up history on an explicit monitoring disable transition", async () => {
    // Companion objective: narrowing the cleanup guard to explicit transitions
    // must retain the real monitoring-disabled cleanup path.
    // Arrange
    const monitored: VpsRecord = {
      ...localVps,
      dockerMetricsEnabled: true,
      dockerManagementEnabled: true,
    };
    const { service, update, cleanupForVps } = arrangeService(monitored);

    // Act
    const result = await service.update(localVps.id, {
      dockerMetricsEnabled: false,
    });

    // Assert
    expect(cleanupForVps).toHaveBeenCalledTimes(1);
    expect(cleanupForVps).toHaveBeenCalledWith(
      localVps.id,
      "monitoring_disabled",
    );
    expect(update).toHaveBeenCalledWith(localVps.id, {
      dockerMetricsEnabled: false,
    });
    expect(result.dockerMetricsEnabled).toBe(false);
    expect(result.dockerManagementEnabled).toBe(true);
  });
});
