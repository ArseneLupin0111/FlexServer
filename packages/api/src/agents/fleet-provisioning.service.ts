import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config/app-config.js";
import {
  APP_CONFIG,
  AGENT_REPOSITORY,
  FLEET_REPOSITORY,
  KEY_SERVICE,
  VPS_REPOSITORY,
} from "../tokens.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { FleetRepository } from "../persistence/repositories/fleet.repository.js";
import { SshService } from "../ssh/ssh.service.js";
import type { KeyService } from "../ssh/keyService.js";
import { AgentService } from "./agent.service.js";
import { AuditService } from "../audit/audit.service.js";
import { resolveAgentBackendUrl } from "./agent-backend-url.js";
import { getAgentServiceName } from "./agent-lifecycle-remote.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type Architecture = "amd64" | "arm64";

export interface FleetProvisioningOptions {
  isNewHost?: boolean;
  fleetAutoUpdate?: boolean;
  force?: boolean;
}

export interface FleetProvisioningResult {
  vpsId: string;
  status: "enrolled" | "needs_setup" | "failed";
  message?: string;
}

export function normalizeArchitecture(rawArch: string): Architecture {
  const trimmed = rawArch.trim().toLowerCase();
  if (trimmed === "aarch64" || trimmed === "arm64") {
    return "arm64";
  }
  if (trimmed === "x86_64" || trimmed === "amd64") {
    return "amd64";
  }
  throw new BadRequestException(
    `Unsupported or unknown host architecture: "${rawArch.trim()}"`,
  );
}

@Injectable()
export class FleetProvisioningService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vpsRepo: VpsRepository,
    @Inject(KEY_SERVICE) private readonly keys: KeyService,
    @Inject(AGENT_REPOSITORY) private readonly agentRepo: AgentRepository,
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(SshService) private readonly ssh: SshService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional()
    @Inject(FLEET_REPOSITORY)
    private readonly fleetRepo?: FleetRepository,
  ) {}

  /**
   * Persists new host auto-update preference honoring opt-out.
   */
  async recordNewHostPreference(
    vpsId: string,
    fleetAutoUpdate: boolean,
  ): Promise<void> {
    if (!this.fleetRepo) return;
    if (fleetAutoUpdate) {
      await this.fleetRepo.setEnrolled(vpsId, true);
      const existing = await this.fleetRepo.getPolicy(vpsId);
      if (!existing) {
        await this.fleetRepo.upsertPolicy(vpsId, {
          mode: "auto",
          group: "Default",
        });
      }
    } else {
      await this.fleetRepo.setEnrolled(vpsId, false);
    }
  }

  /**
   * Provisions trusted fleet updater onto remote host over SSH using matching architecture binaries.
   */
  async provisionHost(
    vpsId: string,
    sshAuth?: { password?: string; privateKey?: string },
    options?: FleetProvisioningOptions,
  ): Promise<FleetProvisioningResult> {
    const vps = await this.vpsRepo.get(vpsId);
    if (!vps) {
      return { vpsId, status: "failed", message: "VPS not found" };
    }

    if (vps.kind === "local" || vps.managedBy === "system") {
      return {
        vpsId,
        status: "needs_setup",
        message: "Fleet updater not applicable for local or system-managed VPS",
      };
    }

    // Resolve auth without persisting password
    const auth = await this.resolveAuth(vpsId, sshAuth);
    if (!auth) {
      return {
        vpsId,
        status: "needs_setup",
        message: "No saved authorized SSH key available for remote setup",
      };
    }

    let credentialId: string | undefined;
    let stagingDir = "";

    try {
      // 1. Inspect remote architecture (fail-closed if command fails)
      const unameResult = await this.ssh.execCommand(vps, "uname -m", auth, 15_000);
      const arch = normalizeArchitecture(unameResult.stdout);

      // 2. Resolve matching architecture daemon/helper updater binary
      const updaterBinaryPath = this.resolveUpdaterBinaryPath(arch);
      const updaterBytes = readFileSync(updaterBinaryPath);
      const updaterSha256 = createHash("sha256")
        .update(updaterBytes)
        .digest("hex");

      // 3. Resolve installer script
      const installerScriptPath = this.resolveInstallerScriptPath();
      const installerScript = readFileSync(installerScriptPath);

      // 4. Resolve pinned public key PEM (strict: config.fleet.publicKeyFile only)
      const pubkeyPem = this.resolvePublicKeyPem();

      // 5. Mint scoped updater credential (local-updater scope)
      const credResult = await this.agentService.createCredential(
        vpsId,
        "active",
        "local-updater",
      );
      credentialId = credResult.credential.id;
      const token = credResult.token;

      // 6. Resolve HTTPS API base URL
      const apiUrl = resolveAgentBackendUrl(this.config);

      // 7. Determine per-VPS agent unit name
      const agentUnit = getAgentServiceName(vpsId);

      // 8. Create temporary staging directory on remote host
      const nonce = randomBytes(8).toString("hex");
      stagingDir = `/tmp/fleet-updater-prov-${nonce}`;
      await this.ssh.makeDirectory(vps, stagingDir, 0o700, auth);

      const stagedScript = `${stagingDir}/install-fleet-updater.sh`;
      const stagedBinary = `${stagingDir}/vps-updater`;
      const stagedPubkey = `${stagingDir}/fleet-release.pub`;
      const stagedToken = `${stagingDir}/.token`;

      // 9. Upload artifacts (token uploaded to 0600 file to avoid argv process secret leak)
      await this.ssh.uploadFile(vps, stagedScript, installerScript, 0o700, auth);
      await this.ssh.uploadFile(vps, stagedBinary, updaterBytes, 0o700, auth);
      await this.ssh.uploadFile(
        vps,
        stagedPubkey,
        Buffer.from(pubkeyPem, "utf8"),
        0o644,
        auth,
      );
      await this.ssh.uploadFile(
        vps,
        stagedToken,
        Buffer.from(token, "utf8"),
        0o600,
        auth,
      );

      // 10. Verify remote binary checksum (execCommand rejects if test fails)
      const verifyCmd = `test "$(sha256sum ${shellQuote(stagedBinary)} | cut -d' ' -f1)" = ${shellQuote(updaterSha256)}`;
      await this.ssh.execCommand(vps, verifyCmd, auth, 15_000);

      // 11. Execute installer script with privilege handling using --token-file
      const cmdParts = [
        shellQuote(stagedScript),
        "--api-url",
        shellQuote(apiUrl),
        "--token-file",
        shellQuote(stagedToken),
        "--pubkey-file",
        shellQuote(stagedPubkey),
        "--vps-id",
        shellQuote(vpsId),
        "--binary",
        shellQuote(stagedBinary),
        "--agent-unit",
        shellQuote(agentUnit),
      ];

      const scriptExec = cmdParts.join(" ");
      const privilegedCmd = [
        `if [ "$(id -u)" -eq 0 ]; then`,
        `  ${scriptExec};`,
        `elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then`,
        `  sudo -n ${scriptExec};`,
        auth.password
          ? `else printf '%s\\n' ${shellQuote(auth.password)} | sudo -S ${scriptExec}; fi`
          : `else echo "Error: root or passwordless sudo required" >&2; exit 1; fi`,
      ].join("\n");

      await this.ssh.execCommand(vps, privilegedCmd, auth, 60_000);

      // Record successful audit event
      await this.audit.record({
        actor: "system",
        action: "fleet.updater.provision",
        resourceType: "vps",
        resourceId: vpsId,
        result: "success",
        metadata: { arch, agentUnit },
      });

      // Update fleet enrollment state if available
      if (this.fleetRepo && options?.isNewHost !== false) {
        await this.fleetRepo.setEnrolled(vpsId, true);
        const policy = await this.fleetRepo.getPolicy(vpsId);
        if (!policy) {
          await this.fleetRepo.upsertPolicy(vpsId, {
            mode: "auto",
            group: "Default",
          });
        }
        await this.fleetRepo.addNotification({
          kind: "info",
          message: `Fleet updater provisioned on host ${vps.name || vpsId} (${arch})`,
        });
      }

      return { vpsId, status: "enrolled" };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      // Clean up minted credential on failure
      if (credentialId) {
        await this.agentRepo.revokeCredential(credentialId).catch(() => undefined);
      }

      // Record failure audit and fleet notification
      await this.audit.record({
        actor: "system",
        action: "fleet.updater.provision",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { error: msg },
      });

      if (this.fleetRepo) {
        await this.fleetRepo.addNotification({
          kind: "warning",
          message: `Fleet updater setup failed on host ${vps.name || vpsId}: ${msg}`,
        }).catch(() => undefined);
      }

      // Surface failure outcome without rolling back base agent
      return {
        vpsId,
        status: "needs_setup",
        message: `Fleet updater setup failed: ${msg}`,
      };
    } finally {
      // Clean up staging directory on remote host
      if (stagingDir) {
        await this.ssh
          .execCommand(vps, `rm -rf ${shellQuote(stagingDir)}`, auth, 15_000)
          .catch(() => undefined);
      }
    }
  }

  /**
   * Invoked upon successful agent re-installation:
   * Never auto-enrolls an un-enrolled host or overwrites existing policy.
   * Only provisions updater if the host was already enrolled.
   */
  async onAgentReinstalled(
    vpsId: string,
    sshAuth?: { password?: string; privateKey?: string },
  ): Promise<FleetProvisioningResult> {
    if (!this.fleetRepo) {
      return { vpsId, status: "needs_setup", message: "Fleet repository unavailable" };
    }

    const isEnrolled = await this.fleetRepo.isEnrolled(vpsId);
    if (!isEnrolled) {
      // Reinstall never auto-enrolls an un-enrolled host or overwrites policy
      return {
        vpsId,
        status: "needs_setup",
        message: "Host not enrolled in fleet updates; preserving existing policy",
      };
    }

    // Host was already enrolled; refresh updater provisioning without overwriting policy
    return this.provisionHost(vpsId, sshAuth, {
      isNewHost: false,
      fleetAutoUpdate: true,
      force: true,
    });
  }

  /**
   * Bulk enrollment for multiple VPS hosts:
   * Uses saved authorized SSH key if available, else marks needs_setup with reason.
   */
  async enrollBulk(vpsIds: string[]): Promise<FleetProvisioningResult[]> {
    const results: FleetProvisioningResult[] = [];

    for (const vpsId of vpsIds) {
      const vps = await this.vpsRepo.get(vpsId);
      if (!vps) {
        results.push({ vpsId, status: "failed", message: "VPS not found" });
        continue;
      }

      const auth = await this.resolveAuth(vpsId);
      if (!auth) {
        results.push({
          vpsId,
          status: "needs_setup",
          message: "No saved authorized SSH key available for remote setup",
        });
        if (this.fleetRepo) {
          await this.fleetRepo.addNotification({
            kind: "warning",
            message: `Bulk enrollment for host ${vps.name || vpsId} requires SSH key setup`,
          }).catch(() => undefined);
        }
        continue;
      }

      const provResult = await this.provisionHost(
        vpsId,
        auth,
        { isNewHost: false, fleetAutoUpdate: true, force: true },
      );
      results.push(provResult);
    }

    return results;
  }

  private async resolveAuth(
    vpsId: string,
    sshAuth?: { password?: string; privateKey?: string },
  ): Promise<{ password?: string; privateKey?: string } | null> {
    if (sshAuth?.password || sshAuth?.privateKey) {
      return sshAuth;
    }
    try {
      const privateKey = await this.keys.readPrivateKey(vpsId);
      if (privateKey && privateKey.trim().length > 0) {
        return { privateKey };
      }
    } catch {
      // No saved private key
    }
    return null;
  }

  resolveUpdaterBinaryPath(arch: Architecture): string {
    if (process.env.UPDATER_BINARY_PATH && existsSync(process.env.UPDATER_BINARY_PATH)) {
      return process.env.UPDATER_BINARY_PATH;
    }
    const candidates = [
      `/app/agent/vps-updater-linux-${arch}`,
      join(process.cwd(), "agent", `vps-updater-linux-${arch}`),
      join(process.cwd(), "packages", "agent", "dist", `vps-updater-linux-${arch}`),
      join(
        process.cwd(),
        "..",
        "..",
        "packages",
        "agent",
        "dist",
        `vps-updater-linux-${arch}`,
      ),
    ];
    const found = candidates.find((c) => existsSync(c));
    if (!found) {
      throw new BadRequestException(
        `Fleet updater binary for ${arch} was not found. Looked in: ${candidates.join(", ")}`,
      );
    }
    return found;
  }

  resolveInstallerScriptPath(): string {
    const candidates = [
      "/app/scripts/install/install-fleet-updater.sh",
      join(process.cwd(), "scripts", "install", "install-fleet-updater.sh"),
      join(process.cwd(), "..", "..", "scripts", "install", "install-fleet-updater.sh"),
    ];
    const found = candidates.find((c) => existsSync(c));
    if (!found) {
      throw new BadRequestException(
        `Fleet installer script not found. Looked in: ${candidates.join(", ")}`,
      );
    }
    return found;
  }

  resolvePublicKeyPem(): string {
    const keyPath = this.config.fleet?.publicKeyFile;
    if (!keyPath || !existsSync(keyPath)) {
      throw new BadRequestException(
        `Fleet release public key file is not configured or does not exist: ${keyPath ?? "undefined"}`,
      );
    }
    return readFileSync(keyPath, "utf8");
  }
}
