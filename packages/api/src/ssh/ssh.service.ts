import { Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import type { AppConfig } from "../config/app-config.js";
import { DemoSshDisabledError } from "../common/errors.js";
import type { VpsRecord } from "../vps/vps.models.js";
import {
  assertSshHostAllowedAsync,
  createHostVerifier,
  sshAlgorithmNamesForKeyType,
} from "./ssh-host-policy.js";
import type { SshSecurityOptions } from "./sshService.js";
import {
  execCommand,
  openManagedSshShell,
  openManagedSftp,
  type ManagedSftpConnection,
  type ManagedSshShell,
  type SshPtyDimensions,
  makeDirectory,
  provisionPublicKey,
  uploadFile,
  verifyPrivateKey,
} from "./sshService.js";
import { HostKeyPinService } from "./host-key-pin.service.js";

@Injectable()
export class SshService {
  constructor(
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly hostKeyPin: HostKeyPinService,
  ) {}

  async openManagedSftp(vps: VpsRecord, auth: { privateKey: string }): Promise<ManagedSftpConnection> {
    const security = await this.assertRealSshAllowed(vps, true);
    return openManagedSftp(vps, auth, security);
  }

  /**
   * Resolve the trusted host key fingerprints for a VPS.
   *
   * Uses the consolidated resolver (persisted repository pins with env pin
   * fallback) — never a permissive "accept anything" mode.
   */
  private async buildSecurityOptions(
    vps: VpsRecord,
    terminal = false,
  ): Promise<SshSecurityOptions> {
    const vettedHost = await assertSshHostAllowedAsync(vps.host, this.config);
    const trustedFingerprints = await this.hostKeyPin.getTrustedFingerprints(vps.id, vps.host, vps.port);
    const pinEntry: string | string[] = trustedFingerprints.length === 1 ? trustedFingerprints[0] : trustedFingerprints;
    const pins = trustedFingerprints.length === 0 ? {} : {
      [vps.id]: pinEntry,
      [`${vps.host}:${vps.port}`]: pinEntry,
    };
    const hostVerifier = createHostVerifier({
      vpsId: vps.id,
      host: vps.host,
      port: vps.port,
      pins,
      policy: terminal ? "strict" : this.config.sshHostKeyPolicy,
    });

    // Constrain ssh2's server host key algorithms to the trusted key type so
    // negotiation can never fall back to an unpinned key type.
    const trustedKeyType = await this.hostKeyPin.resolveKeyType(
      vps.id,
      vps.host,
      vps.port,
    );
    const serverHostKeyAlgorithms = trustedKeyType
      ? sshAlgorithmNamesForKeyType(trustedKeyType)
      : undefined;

    return {
      vettedHost,
      hostVerifier,
      serverHostKeyAlgorithms,
      hasTrustedHostKeyPin: trustedFingerprints.length > 0,
    };
  }

  private async assertRealSshAllowed(
    vps: VpsRecord,
    terminal = false,
  ): Promise<SshSecurityOptions> {
    try {
      if (this.config.mode === "demo") throw new DemoSshDisabledError();
      return await this.buildSecurityOptions(vps, terminal);
    } catch (error: unknown) {
      await this.audit.record({
        actor: "system",
        action: "ssh.host.blocked",
        resourceType: "vps",
        resourceId: vps.id,
        result: "blocked",
        metadata: { host: vps.host, error },
      });
      throw error;
    }
  }

  async provisionPublicKey(
    vps: VpsRecord,
    password: string,
    publicKey: string,
  ) {
    const security = await this.assertRealSshAllowed(vps);
    return provisionPublicKey(vps, password, publicKey, security);
  }

  async verifyPrivateKey(vps: VpsRecord, privateKey: string) {
    const security = await this.assertRealSshAllowed(vps);
    return verifyPrivateKey(vps, privateKey, security);
  }

  async makeDirectory(
    vps: VpsRecord,
    remotePath: string,
    mode: number,
    auth: { password?: string; privateKey?: string },
  ) {
    const security = await this.assertRealSshAllowed(vps);
    return makeDirectory(vps, remotePath, mode, auth, security);
  }

  async uploadFile(
    vps: VpsRecord,
    remotePath: string,
    content: Buffer,
    mode: number,
    auth: { password?: string; privateKey?: string },
  ) {
    const security = await this.assertRealSshAllowed(vps);
    return uploadFile(vps, remotePath, content, mode, auth, security);
  }

  async openManagedShell(
    vps: VpsRecord,
    auth: { privateKey: string },
    dimensions: SshPtyDimensions,
  ): Promise<ManagedSshShell> {
    const security = await this.assertRealSshAllowed(vps, true);
    return openManagedSshShell(vps, auth, dimensions, security);
  }

  async execCommand(
    vps: VpsRecord,
    command: string,
    auth: { password?: string; privateKey?: string },
    timeoutMs = 30_000,
  ): Promise<{ stdout: string; stderr: string }> {
    const security = await this.assertRealSshAllowed(vps);
    return execCommand(vps, command, auth, timeoutMs, security);
  }

  /** Execute only with a configured trusted host-key pin. */
  async execCommandStrict(
    vps: VpsRecord,
    command: string,
    auth: { password?: string; privateKey?: string },
    timeoutMs = 30_000,
  ): Promise<{ stdout: string; stderr: string }> {
    const security = await this.assertRealSshAllowed(vps, true);
    return execCommand(vps, command, auth, timeoutMs, security);
  }
}
