import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import type { AppConfig } from "../config/app-config.js";
import { demoServers } from "../demo/demo-fixtures.js";
import {
  DemoMutationBlockedError,
  SshHostBlockedError,
  SshHostKeyScanFailedError,
  SshHostKeyTrustRequiredError,
  VpsNotFoundError,
} from "../common/errors.js";
import type { KeyService } from "../ssh/keyService.js";
import { SshService } from "../ssh/ssh.service.js";
import { selectPreferredHostKey } from "../ssh/ssh-host-policy.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import {
  createVpsSchema,
  installAgentSchema,
  provisionKeySchema,
  updateLocalVpsSchema,
  updateVpsSchema,
} from "./vps.schemas.js";
import { AgentInstallerService } from "../agents/agent-installer.service.js";
import { AgentUninstallerService } from "../agents/agent-uninstaller.service.js";
import { AgentRestartService } from "../agents/agent-restart.service.js";
import { AGENT_REPOSITORY, FLEET_PROVISIONING_SERVICE } from "../tokens.js";
import { FleetProvisioningService } from "../agents/fleet-provisioning.service.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import { HostKeyPinService } from "../ssh/host-key-pin.service.js";
import { applyAgentState, type VpsRecord } from "./vps.models.js";
import { deriveHostStatus } from "../common/host-health.js";
import { DockerMonitoringService } from "../docker/docker-monitoring.service.js";
import type { VpsCleanup } from "../persistence/vps-cleanup.js";
import { AgentLifecycleCoordinator } from "../agents/agent-lifecycle-coordinator.js";

export type VpsFilesCanceller = {
  cancelOperationsForVps(vpsId: string, reason?: string): void;
};
@Injectable()
export class VpsService {
  constructor(
    private readonly store: VpsRepository,
    private readonly keys: KeyService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly agentInstaller: AgentInstallerService,
    private readonly agentUninstaller: AgentUninstallerService,
    @Inject(AGENT_REPOSITORY) private readonly agentRepository: AgentRepository,
    private readonly hostKeyPin: HostKeyPinService,
    private readonly agentRestarter?: AgentRestartService,
    private readonly dockerMonitoring?: DockerMonitoringService,
    private readonly removalCleanup?: VpsCleanup,
    private readonly lifecycle?: AgentLifecycleCoordinator,
    private readonly filesService?: VpsFilesCanceller,
    @Optional()
    @Inject(FLEET_PROVISIONING_SERVICE)
    private readonly fleetProvisioning?: FleetProvisioningService,
  ) {}

  async list() {
    const records = await this.store.list();
    if (records.length === 0 && this.config.mode === "demo")
      return [...demoServers];
    return this.withAgentStates(
      records.map((record) => ({
        ...record,
        status: deriveHostStatus(record.status, record.lastSeenAt),
      })),
    );
  }

  /**
   * Attach persisted agent state to VPS records (local mode only; demo
   * fixtures already carry agent fields). Batch-fetches states in one read.
   */
  private async withAgentStates(records: VpsRecord[]): Promise<VpsRecord[]> {
    if (this.config.mode === "demo") return records;
    const states = await this.agentRepository.listStates();
    const stateById = new Map(states.map((s) => [s.vpsId, s]));
    return records.map((record) =>
      applyAgentState(record, stateById.get(record.id)),
    );
  }

  private assertNotDemo() {
    if (this.config.mode === "demo") throw new DemoMutationBlockedError();
  }

  private assertRemoteUserManaged(vps: {
    kind?: string;
    managedBy?: string;
    tags?: string[];
  }) {
    if (vps.kind === "local" || vps.managedBy === "system") {
      throw new BadRequestException(
        "Local host is managed by the built-in agent",
      );
    }
  }

  /** Check if VPS is local/system-managed */
  private isLocalSystemManaged(vps: {
    kind?: string;
    managedBy?: string;
  }): boolean {
    return vps.kind === "local" || vps.managedBy === "system";
  }

  async create(body: unknown) {
    this.assertNotDemo();
    const parsed = createVpsSchema.parse(body);
    const record = await this.store.create(parsed);
    await this.audit.record({
      actor: "system",
      action: "vps.create",
      resourceType: "vps",
      resourceId: record.id,
      result: "success",
      metadata: { host: record.host },
    });
    return record;
  }

  async get(id: string) {
    const record = await this.store.get(id);
    if (record) {
      if (this.config.mode === "demo") return record;
      const state = await this.agentRepository.getState(id);
      return applyAgentState(
        {
          ...record,
          status: deriveHostStatus(record.status, record.lastSeenAt),
        },
        state,
      );
    }
    // In demo mode fall back to demo fixtures (matching list() semantics)
    if (this.config.mode === "demo") {
      const demo = demoServers.find((s) => s.id === id);
      if (demo) return { ...demo };
    }
    throw new VpsNotFoundError();
  }

  async update(id: string, body: unknown) {
    const release = await this.lifecycle?.tryAcquire(id, "update");
    try { return await this.updateUnlocked(id, body); } finally { release?.(); }
  }

  private async updateUnlocked(id: string, body: unknown) {
    this.assertNotDemo();
    const vps = await this.get(id);

    // For local/system-managed hosts: only feature toggles are allowed.
    // Each flag is persisted independently, so a management-only patch never
    // cleans up monitoring history and never flips dockerMetricsEnabled.
    if (this.isLocalSystemManaged(vps)) {
      const localPatch = updateLocalVpsSchema.parse(body);
      const oldMetrics = vps.dockerMetricsEnabled ?? false;
      const oldManagement = vps.dockerManagementEnabled ?? false;
      const oldSftp = vps.sftpEnabled ?? false;
      const newSftp = localPatch.sftpEnabled;
      const sftpChanged = newSftp !== undefined && newSftp !== oldSftp;
      const newMetrics = localPatch.dockerMetricsEnabled;
      const newManagement = localPatch.dockerManagementEnabled;
      const newCompose = localPatch.composeManagementEnabled;
      const oldCompose = vps.composeManagementEnabled ?? false;
      const composeChanged = newCompose !== undefined && newCompose !== oldCompose;
      const metricsChanged =
        newMetrics !== undefined && newMetrics !== oldMetrics;
      const managementChanged =
        newManagement !== undefined && newManagement !== oldManagement;

      if (!metricsChanged && !managementChanged && !sftpChanged && !composeChanged) {
        // No change; just return current record
        return vps;
      }

      // Clean up monitoring history only on an explicit metrics disable
      // transition. If cleanup fails, leave the toggle enabled so the
      // persisted configuration remains consistent and the request is retryable.
      if (oldMetrics && newMetrics === false) {
        await this.dockerMonitoring?.cleanupForVps(id, "monitoring_disabled");
      }
      if (oldSftp && newSftp === false) {
        this.filesService?.cancelOperationsForVps(id);
      }

      const updated = await this.store.update(id, {
        ...(newMetrics !== undefined
          ? { dockerMetricsEnabled: newMetrics }
          : {}),
        ...(newManagement !== undefined
          ? { dockerManagementEnabled: newManagement }
          : {}),
        ...(newSftp !== undefined ? { sftpEnabled: newSftp } : {}),
        ...(newCompose !== undefined ? { composeManagementEnabled: newCompose } : {}),
      });
      if (!updated) throw new VpsNotFoundError();

      await this.audit.record({
        actor: "system",
        action: metricsChanged
          ? "vps.docker_metrics.update"
          : managementChanged ? "vps.docker_management.update" : composeChanged ? "vps.compose_management.update" : "vps.sftp.update",
        resourceType: "vps",
        resourceId: id,
        result: "success",
        metadata: {
          old: {
            ...(sftpChanged ? { sftpEnabled: oldSftp } : {}),
            ...(composeChanged ? { composeManagementEnabled: oldCompose } : {}),
            ...(metricsChanged ? { dockerMetricsEnabled: oldMetrics } : {}),
            ...(managementChanged
              ? { dockerManagementEnabled: oldManagement }
              : {}),
          },
          new: {
            ...(sftpChanged ? { sftpEnabled: newSftp } : {}),
            ...(composeChanged ? { composeManagementEnabled: newCompose } : {}),
            ...(metricsChanged ? { dockerMetricsEnabled: newMetrics } : {}),
            ...(managementChanged
              ? { dockerManagementEnabled: newManagement }
              : {}),
          },
        },
      });
      return updated;
    }

    // Remote/user-managed hosts accept endpoint fields and independent toggles.
    const parsedBody = updateVpsSchema.parse(body);
    const hasDockerToggle = parsedBody && "dockerMetricsEnabled" in parsedBody;
    const oldEndpoint = { host: vps.host, port: vps.port };
    const newEndpoint = {
      host: parsedBody.host ?? vps.host,
      port: parsedBody.port ?? vps.port,
    };
    const endpointChanged =
      oldEndpoint.host !== newEndpoint.host || oldEndpoint.port !== newEndpoint.port;
    const endpointAuditMetadata = endpointChanged
      ? { oldEndpoint, newEndpoint }
      : undefined;

    if (hasDockerToggle) {
      const oldValue = vps.dockerMetricsEnabled ?? false;
      const newValue = parsedBody.dockerMetricsEnabled as boolean;

      // Clean up first. A failed cleanup leaves the original VPS record and all
      // combined update fields untouched, making the request safely retryable.
      if (oldValue && !newValue) {
        await this.dockerMonitoring?.cleanupForVps(id, "monitoring_disabled");
      }

      const updated = await this.store.update(id, parsedBody);
      if (!updated) throw new VpsNotFoundError();

      if (endpointChanged) await this.hostKeyPin.revokeTrust(id);
      if (endpointChanged || parsedBody.sftpEnabled === false) {
        this.filesService?.cancelOperationsForVps(id);
      }

       await this.audit.record({
        actor: "system",
        action:
          oldValue !== newValue ? "vps.docker_metrics.update" : "vps.update",
        resourceType: "vps",
        resourceId: id,
        result: "success",
         metadata: {
           ...(hasDockerToggle
             ? {
                 old: { dockerMetricsEnabled: oldValue, ...(parsedBody.sftpEnabled !== undefined ? { sftpEnabled: vps.sftpEnabled ?? false } : {}) },
                 new: { dockerMetricsEnabled: newValue, ...(parsedBody.sftpEnabled !== undefined ? { sftpEnabled: parsedBody.sftpEnabled } : {}) },
               }
             : {}),
           ...(endpointAuditMetadata ?? {}),
         },
      });
      return updated;
    }

    const updated = await this.store.update(id, parsedBody);
    if (!updated) throw new VpsNotFoundError();
    if (endpointChanged) await this.hostKeyPin.revokeTrust(id);
    if (endpointChanged || parsedBody.sftpEnabled === false) {
      this.filesService?.cancelOperationsForVps(id);
    }
    await this.audit.record({
      actor: "system",
      action: Object.keys(parsedBody).length === 1 && parsedBody.sftpEnabled !== undefined
        ? "vps.sftp.update" : "vps.update",
      resourceType: "vps",
      resourceId: id,
       result: "success",
       metadata: {
         ...endpointAuditMetadata,
         ...(parsedBody.sftpEnabled !== undefined ? {
           old: { sftpEnabled: vps.sftpEnabled ?? false },
           new: { sftpEnabled: parsedBody.sftpEnabled },
         } : {}),
       },
     });
     return updated;
  }

  async delete(id: string) {
    this.filesService?.cancelOperationsForVps(id);

    this.assertNotDemo();
    const record = await this.store.get(id);
    if (record) this.assertRemoteUserManaged(record);
    if (!this.removalCleanup) throw new Error("Server removal cleanup is unavailable");
    if (record) {
      await this.agentUninstaller.removeForDelete(id, async () => {
        await this.keys.removeKeyPair(id);
        if (!(await this.store.delete(id))) throw new VpsNotFoundError();
        await this.removalCleanup!.purge(id);
      }, () => this.removalCleanup!.prepare(id));
    } else {
      // A previous attempt may have deleted the row before local cleanup failed.
      await this.keys.removeKeyPair(id);
      await this.removalCleanup.purge(id);
    }
    await this.audit.record({
      actor: "system",
      action: "vps.delete",
      resourceType: "vps",
      resourceId: id,
      result: "success",
    }).catch(() => undefined);
  }

  async provisionKey(id: string, body: unknown) {
    const release = await this.lifecycle?.tryAcquire(id, "provision");
    try { return await this.provisionKeyUnlocked(id, body); } finally { release?.(); }
  }

  private async provisionKeyUnlocked(id: string, body: unknown) {
    this.assertNotDemo();
    const vps = await this.get(id);
    this.assertRemoteUserManaged(vps);
    const { password } = provisionKeySchema.parse(body);

    // In strict mode, check host key trust before connecting.
    // If no pin is configured, scan the host key and return a structured
    // SSH_HOST_KEY_TRUST_REQUIRED error so the caller can trust it first.
    if (this.config.sshHostKeyPolicy === "strict") {
      const trustedPins = await this.hostKeyPin.getTrustedFingerprints(
        vps.id,
        vps.host,
        vps.port,
      );
      if (trustedPins.length === 0) {
        try {
          const scanResult = await this.hostKeyPin.scanHostKey(
            vps.id,
            vps.host,
            vps.port,
          );
          // Deterministically select the preferred host key (ed25519 → ecdsa
          // → rsa), regardless of ssh-keyscan output order.
          const preferredKey = selectPreferredHostKey(scanResult.keys);
          throw new SshHostKeyTrustRequiredError({
            vpsId: vps.id,
            host: vps.host,
            port: vps.port,
            fingerprint: preferredKey?.fingerprint,
            keyType: preferredKey?.type,
          });
        } catch (error) {
          if (error instanceof SshHostKeyTrustRequiredError) throw error;
          // Preserve policy/host-block errors (403) and typed scan errors
          // rather than collapsing them into a generic 502.
          if (error instanceof SshHostBlockedError) throw error;
          if (error instanceof SshHostKeyScanFailedError) throw error;
          // Any other unexpected scan failure surface as an explicit safe
          // error — do NOT fall through to a generic SSH connection attempt
          // (which would report a misleading generic host verification failure).
          throw new SshHostKeyScanFailedError();
        }
      }
    }

    const keyPair = await this.keys.ensureKeyPair(vps.id);
    try {
      await this.ssh.provisionPublicKey(vps, password, keyPair.publicKey);
      const updated = await this.store.markKeyProvisioned(vps.id);
      await this.audit.record({
        actor: "system",
        action: "vps.key.provision",
        resourceType: "vps",
        resourceId: vps.id,
        result: "success",
      });
      return updated;
    } catch (error: unknown) {
      await this.audit.record({
        actor: "system",
        action: "vps.key.provision",
        resourceType: "vps",
        resourceId: vps.id,
        result: "failure",
        metadata: { error },
      });
      throw error;
    }
  }

  async verifyKey(id: string) {
    this.assertNotDemo();
    const vps = await this.get(id);
    this.assertRemoteUserManaged(vps);
    const privateKey = await this.keys.readPrivateKey(vps.id);
    try {
      await this.ssh.verifyPrivateKey(vps, privateKey);
      await this.audit.record({
        actor: "system",
        action: "vps.key.verify",
        resourceType: "vps",
        resourceId: vps.id,
        result: "success",
      });
    } catch (error: unknown) {
      await this.audit.record({
        actor: "system",
        action: "vps.key.verify",
        resourceType: "vps",
        resourceId: vps.id,
        result: "failure",
        metadata: { error },
      });
      throw error;
    }
  }

  async installAgent(id: string, body: unknown, requestHost?: string) {
    this.assertNotDemo();
    const vps = await this.get(id);
    this.assertRemoteUserManaged(vps);
    const { password } = installAgentSchema.parse(body);
    try {
      const result = await this.agentInstaller.install(
        vps.id,
        password,
        requestHost,
      );
      await this.audit.record({
        actor: "system",
        action: "agent.install",
        resourceType: "vps",
        resourceId: vps.id,
        result: "success",
        metadata: { jobId: result.jobId },
      });
      return result;
    } catch (error: unknown) {
      await this.audit.record({
        actor: "system",
        action: "agent.install",
        resourceType: "vps",
        resourceId: vps.id,
        result: "failure",
        metadata: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
      });
      throw error;
    }
  }

  async uninstallAgent(id: string) {
    this.assertNotDemo();
    const vps = await this.get(id);
    this.assertRemoteUserManaged(vps);
    return this.agentUninstaller.uninstall(vps.id);
  }


  async restartAgent(id: string) {
    this.assertNotDemo();
    const vps = await this.get(id);
    this.assertRemoteUserManaged(vps);
    if (!this.agentRestarter) throw new Error("Agent restart service is unavailable");
    return this.agentRestarter.restart(vps.id);
  }
}
