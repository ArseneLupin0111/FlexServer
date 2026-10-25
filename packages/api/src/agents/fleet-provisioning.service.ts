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
import { HostKeyPinService } from "../ssh/host-key-pin.service.js";
import { AgentService } from "./agent.service.js";
import { AuditService } from "../audit/audit.service.js";
import { resolveAgentBackendUrl } from "./agent-backend-url.js";
import { getAgentServiceName } from "./agent-lifecycle-remote.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const TOKEN_PREFIX = "vma_";
function parseToken(
  token: string,
): { credentialId: string; secret: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  const rest = token.slice(TOKEN_PREFIX.length);
  const separatorIndex = rest.lastIndexOf("_");
  if (separatorIndex < 1) {
    return null;
  }
  const credentialId = rest.slice(0, separatorIndex);
  const secret = rest.slice(separatorIndex + 1);
  if (!credentialId || !secret) {
    return null;
  }
  return { credentialId, secret };
}

export type Architecture = "amd64" | "arm64";
export type ProvisioningSource = "bundled" | "signed";
export type FleetProvisioningStatus = "enrolled" | "needs_access" | "failed";

export interface FleetProvisioningOptions {
  source?: ProvisioningSource;
  isNewHost?: boolean;
  force?: boolean;
  rotateCredentials?: boolean;
}

export interface FleetProvisioningResult {
  vpsId: string;
  status: FleetProvisioningStatus;
  reason: string | null;
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
    @Optional()
    @Inject(HostKeyPinService)
    private readonly hostKeyPin?: HostKeyPinService,
  ) {}

  /**
   * Prepares and provisions the bundled updater onto a remote host using saved SSH credentials.
   * Usable by convergence. Never accepts ephemeral/one-time passwords.
   * Returns { status: "enrolled" | "needs_access" | "failed", reason: string | null }.
   * Does not auto-accept changed or unpinned host keys.
   * Reuses usable existing updater credentials; revokes newly created credentials on failure.
   */
  async ensureBundled(vpsId: string): Promise<FleetProvisioningResult> {
    const vps = await this.vpsRepo.get(vpsId);
    if (!vps) {
      return { vpsId, status: "failed", reason: "VPS not found", message: "VPS not found" };
    }

    if (vps.kind === "local" || vps.managedBy === "system") {
      return {
        vpsId,
        status: "failed",
        reason: "Fleet updater not applicable for local or system-managed VPS",
        message: "Fleet updater not applicable for local or system-managed VPS",
      };
    }

    // Strict host key check: require verified pin, never auto-accept changed host keys
    if (this.hostKeyPin) {
      try {
        const trustedFingerprints = await this.hostKeyPin.getTrustedFingerprints(
          vps.id,
          vps.host,
          vps.port,
        );
        if (!trustedFingerprints || trustedFingerprints.length === 0) {
          return {
            vpsId,
            status: "needs_access",
            reason: "SSH host key is not trusted. Operator must verify and pin the host key.",
            message: "SSH host key is not trusted. Operator must verify and pin the host key.",
          };
        }
      } catch (err) {
        return {
          vpsId,
          status: "needs_access",
          reason: `SSH host key check failed: ${err instanceof Error ? err.message : String(err)}`,
          message: `SSH host key check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Require saved authorized private key; never accept or persist one-time passwords
    const auth = await this.resolveAuth(vpsId);
    if (!auth || !auth.privateKey) {
      return {
        vpsId,
        status: "needs_access",
        reason: "No saved authorized SSH key available for remote setup",
        message: "No saved authorized SSH key available for remote setup",
      };
    }

    return this.provisionHost(vpsId, auth, {
      source: "bundled",
      isNewHost: false,
      force: false,
    });
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
      return { vpsId, status: "failed", reason: "VPS not found", message: "VPS not found" };
    }

    if (vps.kind === "local" || vps.managedBy === "system") {
      return {
        vpsId,
        status: "failed",
        reason: "Fleet updater not applicable for local or system-managed VPS",
        message: "Fleet updater not applicable for local or system-managed VPS",
      };
    }

    const source: ProvisioningSource = options?.source ?? "bundled";
    if (source !== "bundled" && source !== "signed") {
      return {
        vpsId,
        status: "failed",
        reason: `Invalid provisioning source: "${source}". Must be "bundled" or "signed".`,
        message: `Invalid provisioning source: "${source}". Must be "bundled" or "signed".`,
      };
    }

    // Strict host key pin validation: never auto-accept changed or unpinned host keys
    if (this.hostKeyPin) {
      try {
        const trustedFingerprints = await this.hostKeyPin.getTrustedFingerprints(
          vps.id,
          vps.host,
          vps.port,
        );
        if (!trustedFingerprints || trustedFingerprints.length === 0) {
          return {
            vpsId,
            status: "needs_access",
            reason: "SSH host key is not trusted. Operator must verify and pin the host key.",
            message: "SSH host key is not trusted. Operator must verify and pin the host key.",
          };
        }
      } catch (err) {
        return {
          vpsId,
          status: "needs_access",
          reason: `SSH host key check failed: ${err instanceof Error ? err.message : String(err)}`,
          message: `SSH host key check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Resolve auth without persisting password
    const auth = await this.resolveAuth(vpsId, sshAuth);
    if (!auth) {
      return {
        vpsId,
        status: "needs_access",
        reason: "No saved authorized SSH key available for remote setup",
        message: "No saved authorized SSH key available for remote setup",
      };
    }

    let credentialId: string | undefined;
    let isNewCredential = false;
    let stagingDir = "";

    try {
      // 1. Inspect remote architecture and verify sudo/root privileges upfront
      const unameResult = await this.ssh.execCommand(vps, "uname -m", auth, 15_000);
      const arch = normalizeArchitecture(unameResult.stdout);

      // Verify privilege requirements: root or passwordless sudo required
      // Never interpolate passwords into remote shell argv to avoid /proc cmdline leaks
      const privilegeCheckCmd = [
        `if [ "$(id -u)" -eq 0 ]; then`,
        `  echo "PRIV_OK";`,
        `elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then`,
        `  echo "PRIV_OK";`,
        `else echo "PRIV_FAILED"; fi`,
      ].join("\n");
      const privResult = await this.ssh.execCommand(vps, privilegeCheckCmd, auth, 15_000);
      if (!privResult.stdout.includes("PRIV_OK")) {
        return {
          vpsId,
          status: "needs_access",
          reason: "Root or passwordless sudo required for remote updater setup",
          message: "Root or passwordless sudo required for remote updater setup",
        };
      }
      // 2. Resolve matching architecture daemon/helper updater binary
      const updaterBinaryPath = this.resolveUpdaterBinaryPath(arch);
      const updaterBytes = readFileSync(updaterBinaryPath);
      const updaterSha256 = createHash("sha256")
        .update(updaterBytes)
        .digest("hex");

      // 3. Resolve installer script
      const installerScriptPath = this.resolveInstallerScriptPath();
      const installerScript = readFileSync(installerScriptPath);

      // 4. Resolve pinned public key PEM: required only in signed mode, omitted in bundled mode
      let pubkeyPem: string | undefined;
      if (source === "signed") {
        pubkeyPem = this.resolvePublicKeyPem();
      }


      // 5. Credential reuse or minting:
      // Try to reuse existing valid updater credential from remote host configuration
      let token: string | undefined;
      if (!options?.rotateCredentials && !options?.force) {
        const readConfigCmd = [
          `if [ "$(id -u)" -eq 0 ]; then`,
          `  if [ -f /etc/vps-updater/config.json ]; then cat /etc/vps-updater/config.json; fi;`,
          `elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then`,
          `  if sudo -n test -f /etc/vps-updater/config.json; then sudo -n cat /etc/vps-updater/config.json; fi;`,
          `fi;`,
        ].join("\n");

        try {
          const configOutput = await this.ssh.execCommand(vps, readConfigCmd, auth, 15_000);
          if (configOutput.stdout && configOutput.stdout.trim().startsWith("{")) {
            const parsedConfig = JSON.parse(configOutput.stdout.trim()) as {
              credential?: string;
              vpsId?: string;
            };
            if (
              (!parsedConfig.vpsId || parsedConfig.vpsId === vpsId) &&
              typeof parsedConfig.credential === "string" &&
              parsedConfig.credential.startsWith(TOKEN_PREFIX)
            ) {
              const parsedToken = parseToken(parsedConfig.credential);
              if (parsedToken) {
                const existingCred = await this.agentRepo.getCredential(parsedToken.credentialId);
                if (
                  existingCred &&
                  existingCred.vpsId === vpsId &&
                  existingCred.status === "active" &&
                  (existingCred.scope ?? "agent") === "local-updater" &&
                  hashSecret(parsedToken.secret) === existingCred.secretHash
                ) {
                  token = parsedConfig.credential;
                  credentialId = existingCred.id;
                  isNewCredential = false;
                }
              }
            }
          }
        } catch {
          // If reading existing config fails or invalid, fall through to minting a fresh credential
        }
      }

      if (!token) {
        // Mint scoped updater credential (local-updater scope)
        const credResult = await this.agentService.createCredential(
          vpsId,
          "active",
          "local-updater",
        );
        credentialId = credResult.credential.id;
        token = credResult.token;
        isNewCredential = true;
      }

      // 6. Resolve HTTPS API base URL
      const apiUrl = resolveAgentBackendUrl(this.config);

      // 7. Determine per-VPS agent unit name, state path, and check for installed helpers needing refresh
      const agentUnit = getAgentServiceName(vpsId);
      const discoveryCmd = [
        `unit=${shellQuote(agentUnit)};`,
        `bin="";`,
        `state_dir="";`,
        `if [ -f "/etc/systemd/system/$unit" ]; then`,
        `  bin=$(sed -n -e 's/^ExecStart=\\([^ ]*\\).*/\\1/p' "/etc/systemd/system/$unit" 2>/dev/null | head -n 1 || true);`,
        `  env_dir=$(grep -E '^[[:space:]]*Environment=.*FLEXSERVER_AGENT_STATE_DIR=' "/etc/systemd/system/$unit" 2>/dev/null | sed -e 's/.*FLEXSERVER_AGENT_STATE_DIR=//' -e 's/[ "].*//' | tr -d '\\r\\n');`,
        `  if [ -n "$env_dir" ]; then state_dir="$env_dir"; fi;`,
        `fi;`,
        `if [ -z "$bin" ]; then`,
        `  u_home=$(getent passwd $(whoami) 2>/dev/null | cut -d: -f6 || echo "$HOME");`,
        `  if [ -f "$u_home/.vps-manager-agent/vps-agent" ]; then`,
        `    bin="$u_home/.vps-manager-agent/vps-agent";`,
        `  fi;`,
        `fi;`,
        `if [ -z "$state_dir" ] && [ -f /etc/vps-updater/config.json ]; then`,
        `  cfg_dir=$(grep -o '"agentStateDir"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/vps-updater/config.json 2>/dev/null | cut -d'"' -f4 | tr -d '\\r\\n');`,
        `  if [ -n "$cfg_dir" ]; then state_dir="$cfg_dir"; fi;`,
        `fi;`,
        `if [ -z "$state_dir" ]; then`,
        `  u_home=$(getent passwd $(whoami) 2>/dev/null | cut -d: -f6 || echo "$HOME");`,
        `  if [ -d "$u_home/.flexserver/agent" ]; then`,
        `    state_dir="$u_home/.flexserver/agent";`,
        `  else`,
        `    state_dir="/var/lib/vps-manager-agent";`,
        `  fi;`,
        `fi;`,
        `has_host_pty=0;`,
        `if [ -f "/etc/systemd/system/flexserver-host-pty.service" ] || [ -f "/lib/systemd/system/flexserver-host-pty.service" ] || [ -f "/usr/local/bin/flexserver-host-pty" ] || [ -S "/run/flexserver/host-pty/host-pty.sock" ] || [ -S "/var/run/flexserver/host-pty/host-pty.sock" ]; then`,
        `  has_host_pty=1;`,
        `fi;`,
        `has_ai_helper=0;`,
        `if [ -f "/etc/systemd/system/flexserver-ai-helper.service" ] || [ -f "/lib/systemd/system/flexserver-ai-helper.service" ] || [ -f "/usr/local/sbin/ai-host-helper" ] || [ -S "/run/flexserver-ai/helper.sock" ]; then`,
        `  has_ai_helper=1;`,
        `fi;`,
        `echo "AGENT_BIN=$bin";`,
        `echo "AGENT_STATE_DIR=$state_dir";`,
        `echo "HAS_HOST_PTY=$has_host_pty";`,
        `echo "HAS_AI_HELPER=$has_ai_helper";`,
      ].join("\n");
      const discoveryResult = await this.ssh.execCommand(vps, discoveryCmd, auth, 15_000);
      const binMatch = discoveryResult.stdout.match(/AGENT_BIN=(.*)/);
      const resolvedAgentBinary = binMatch ? binMatch[1].trim() : "";
      const stateDirMatch = discoveryResult.stdout.match(/AGENT_STATE_DIR=(.*)/);
      const resolvedAgentStateDir = stateDirMatch && stateDirMatch[1].trim()
        ? stateDirMatch[1].trim()
        : "/var/lib/vps-manager-agent";
      const hasHostPty = discoveryResult.stdout.includes("HAS_HOST_PTY=1");
      const hasAiHelper = discoveryResult.stdout.includes("HAS_AI_HELPER=1");

      // Check if installed helpers need refresh
      let hostPtyBytes: Buffer | null = null;
      let hostPtySha256 = "";
      if (hasHostPty) {
        const hostPtyPath = this.resolveHostPtyBinaryPath(arch);
        if (!hostPtyPath) {
          return {
            vpsId,
            status: "needs_access",
            reason: "Host terminal helper requires binary refresh but bundled host-pty is unavailable in deployment",
            message: "Host terminal helper requires binary refresh but bundled host-pty is unavailable in deployment",
          };
        }
        hostPtyBytes = readFileSync(hostPtyPath);
        hostPtySha256 = createHash("sha256").update(hostPtyBytes).digest("hex");
      }

      let aiHelperBytes: Buffer | null = null;
      let aiHelperSha256 = "";
      if (hasAiHelper) {
        const aiHelperPath = this.resolveAiHostHelperBinaryPath(arch);
        if (!aiHelperPath) {
          return {
            vpsId,
            status: "needs_access",
            reason: "AI host helper requires binary refresh but bundled ai-host-helper is unavailable in deployment",
            message: "AI host helper requires binary refresh but bundled ai-host-helper is unavailable in deployment",
          };
        }
        aiHelperBytes = readFileSync(aiHelperPath);
        aiHelperSha256 = createHash("sha256").update(aiHelperBytes).digest("hex");
      }

      // 8. Create temporary staging directory on remote host
      const nonce = randomBytes(8).toString("hex");
      stagingDir = `/tmp/fleet-updater-prov-${nonce}`;
      await this.ssh.makeDirectory(vps, stagingDir, 0o700, auth);

      const stagedScript = `${stagingDir}/install-fleet-updater.sh`;
      const stagedBinary = `${stagingDir}/vps-updater`;
      const stagedPubkey = `${stagingDir}/fleet-release.pub`;
      const stagedToken = `${stagingDir}/.token`;
      const stagedHostPty = `${stagingDir}/flexserver-host-pty`;
      const stagedAiHelper = `${stagingDir}/ai-host-helper`;

      // 9. Upload artifacts (token uploaded to 0600 file to avoid argv process secret leak)
      await this.ssh.uploadFile(vps, stagedScript, installerScript, 0o700, auth);
      await this.ssh.uploadFile(vps, stagedBinary, updaterBytes, 0o700, auth);
      if (source === "signed" && pubkeyPem) {
        await this.ssh.uploadFile(
          vps,
          stagedPubkey,
          Buffer.from(pubkeyPem, "utf8"),
          0o644,
          auth,
        );
      }
      await this.ssh.uploadFile(
        vps,
        stagedToken,
        Buffer.from(token, "utf8"),
        0o600,
        auth,
      );

      if (hostPtyBytes) {
        await this.ssh.uploadFile(vps, stagedHostPty, hostPtyBytes, 0o755, auth);
        const verifyPtyCmd = `test "$(sha256sum ${shellQuote(stagedHostPty)} | cut -d' ' -f1)" = ${shellQuote(hostPtySha256)}`;
        await this.ssh.execCommand(vps, verifyPtyCmd, auth, 15_000);
      }
      if (aiHelperBytes) {
        await this.ssh.uploadFile(vps, stagedAiHelper, aiHelperBytes, 0o755, auth);
        const verifyAiCmd = `test "$(sha256sum ${shellQuote(stagedAiHelper)} | cut -d' ' -f1)" = ${shellQuote(aiHelperSha256)}`;
        await this.ssh.execCommand(vps, verifyAiCmd, auth, 15_000);
      }

      // 10. Verify remote binary checksum (execCommand rejects if test fails)
      const verifyCmd = `test "$(sha256sum ${shellQuote(stagedBinary)} | cut -d' ' -f1)" = ${shellQuote(updaterSha256)}`;
      await this.ssh.execCommand(vps, verifyCmd, auth, 15_000);

      // 11. Refresh host helper binaries if installed and staged
      const helperRefreshParts: string[] = [];
      if (hostPtyBytes) {
        helperRefreshParts.push(
          `if [ ! -f /usr/local/bin/flexserver-host-pty ] || [ "$(sha256sum /usr/local/bin/flexserver-host-pty 2>/dev/null | cut -d' ' -f1)" != ${shellQuote(hostPtySha256)} ]; then`,
          `  cp -f ${shellQuote(stagedHostPty)} /usr/local/bin/flexserver-host-pty;`,
          `  chmod 0755 /usr/local/bin/flexserver-host-pty && chown root:root /usr/local/bin/flexserver-host-pty;`,
          `  ln -sf /usr/local/bin/flexserver-host-pty /usr/local/bin/host-pty 2>/dev/null || true;`,
          `  if command -v systemctl >/dev/null 2>&1 && systemctl is-active flexserver-host-pty >/dev/null 2>&1; then`,
          `    systemctl restart flexserver-host-pty || exit 1;`,
          `  fi;`,
          `fi;`,
        );
      }
      if (aiHelperBytes) {
        helperRefreshParts.push(
          `if [ ! -f /usr/local/sbin/ai-host-helper ] || [ "$(sha256sum /usr/local/sbin/ai-host-helper 2>/dev/null | cut -d' ' -f1)" != ${shellQuote(aiHelperSha256)} ]; then`,
          `  cp -f ${shellQuote(stagedAiHelper)} /usr/local/sbin/ai-host-helper;`,
          `  chmod 0755 /usr/local/sbin/ai-host-helper && chown root:root /usr/local/sbin/ai-host-helper;`,
          `  if command -v systemctl >/dev/null 2>&1; then`,
          `    if systemctl is-active flexserver-ai-helper >/dev/null 2>&1; then`,
          `      systemctl restart flexserver-ai-helper || exit 1;`,
          `    elif systemctl is-active vps-ai-helper >/dev/null 2>&1; then`,
          `      systemctl restart vps-ai-helper || exit 1;`,
          `    fi;`,
          `  fi;`,
          `fi;`,
        );
      }

      // 12. Execute installer script with privilege handling using --token-file, --source, and discovered state dir
      const cmdParts = [
        shellQuote(stagedScript),
        "--source",
        shellQuote(source),
        "--api-url",
        shellQuote(apiUrl),
        "--token-file",
        shellQuote(stagedToken),
        "--vps-id",
        shellQuote(vpsId),
        "--binary",
        shellQuote(stagedBinary),
        "--agent-unit",
        shellQuote(agentUnit),
        "--agent-state-dir",
        shellQuote(resolvedAgentStateDir),
      ];

      if (resolvedAgentBinary) {
        cmdParts.push("--agent-binary", shellQuote(resolvedAgentBinary));
      }

      if (source === "signed" && pubkeyPem) {
        cmdParts.push("--pubkey-file", shellQuote(stagedPubkey));
      }

      const scriptExec = cmdParts.join(" ");

      // Serialize concurrent updater installations on the same host using a dedicated update mutex
      const execStatements = [
        `reg_dir=${shellQuote(`${resolvedAgentStateDir}/docker-applications`)};`,
        `mkdir -p "$reg_dir" 2>/dev/null || true;`,
        `chmod 0755 "$reg_dir" 2>/dev/null || true;`,
        `lock_f="$reg_dir/fleet-updater.lock";`,
        `touch "$lock_f" 2>/dev/null || true;`,
        `chmod 0664 "$lock_f" 2>/dev/null || true;`,
        `exec 9<>"$lock_f";`,
        `if ! flock -x -w 5 9 2>/dev/null; then`,
        `  echo "Error: update lock held by concurrent update" >&2;`,
        `  exit 1;`,
        `fi;`,
        ...helperRefreshParts,
        scriptExec,
        `flock -u 9 2>/dev/null || true;`,
        `exec 9>&-;`,
        `echo "PROVISIONING_COMPLETE_OK";`,
      ].join("\n");

      const privilegedCmd = [
        `if [ "$(id -u)" -eq 0 ]; then`,
        `  ${execStatements}`,
        `elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then`,
        `  sudo -n sh -c ${shellQuote(execStatements)};`,
        `else echo "Error: root or passwordless sudo required" >&2; exit 1; fi`,
      ].join("\n");

      await this.ssh.execCommand(vps, privilegedCmd, auth, 60_000);
      await this.audit.record({
        actor: "system",
        action: "fleet.updater.provision",
        resourceType: "vps",
        resourceId: vpsId,
        result: "success",
        metadata: { arch, agentUnit, source },
      });

      // Update fleet enrollment state if available
      if (this.fleetRepo && options?.isNewHost !== false) {
        await this.fleetRepo.setEnrolled(vpsId, true).catch(() => undefined);
        const policy = await this.fleetRepo.getPolicy(vpsId).catch(() => undefined);
        if (!policy) {
          await this.fleetRepo.upsertPolicy(vpsId, {
            mode: "auto",
            group: "Default",
          }).catch(() => undefined);
        }
        await this.fleetRepo.addNotification({
          kind: "info",
          message: `Fleet updater provisioned on host ${vps.name || vpsId} (${arch})`,
        }).catch(() => undefined);
      }

      return { vpsId, status: "enrolled", reason: null };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      // Clean up newly minted credential on failure (never revoke reused credentials)
      if (isNewCredential && credentialId) {
        await this.agentRepo.revokeCredential(credentialId).catch(() => undefined);
      }

      // Record failure audit
      await this.audit.record({
        actor: "system",
        action: "fleet.updater.provision",
        resourceType: "vps",
        resourceId: vpsId,
        result: "failure",
        metadata: { error: msg, source },
      });

      if (this.fleetRepo) {
        await this.fleetRepo.addNotification({
          kind: "warning",
          message: `Fleet updater setup failed on host ${vps.name || vpsId}: ${msg}`,
        }).catch(() => undefined);
      }

      // Classify error: access/privilege/trust vs hard failure
      const isAccessIssue =
        msg.includes("root or passwordless sudo required") ||
        msg.includes("Permission denied") ||
        msg.includes("All configured authentication methods failed") ||
        msg.includes("host key") ||
        msg.includes("Host key") ||
        msg.includes("verification failed");

      const sanitizedReason = this.sanitizeErrorReason(msg);

      return {
        vpsId,
        status: isAccessIssue ? "needs_access" : "failed",
        reason: sanitizedReason,
        message: sanitizedReason,
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

  private sanitizeErrorReason(raw: string): string {
    if (raw.includes("root or passwordless sudo required") || raw.includes("PRIV_FAILED")) {
      return "Root or passwordless sudo required for remote updater setup";
    }
    if (raw.includes("host key") || raw.includes("Host key") || raw.includes("verification failed")) {
      return "SSH host key verification failed or changed: operator trust required";
    }
    if (raw.includes("All configured authentication methods failed") || raw.includes("Permission denied")) {
      return "SSH authentication failed: invalid credentials or rejected key";
    }
    if (raw.includes("not found") && raw.includes("binary")) {
      return "Fleet updater binary not found for host architecture";
    }
    return raw.slice(0, 300);
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
    return this.provisionHost(vpsId, sshAuth, {
      source: "bundled",
      isNewHost: false,
      force: true,
    });
  }

  /**
   * Bulk enrollment for multiple VPS hosts:
   * Uses ensureBundled for each host.
   */
  async enrollBulk(vpsIds: string[]): Promise<FleetProvisioningResult[]> {
    const results: FleetProvisioningResult[] = [];
    for (const vpsId of vpsIds) {
      results.push(await this.ensureBundled(vpsId));
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
  resolveHostPtyBinaryPath(arch: Architecture): string | null {
    const envSpecific =
      arch === "arm64"
        ? process.env.HOST_PTY_BINARY_PATH_ARM64
        : process.env.HOST_PTY_BINARY_PATH_AMD64;
    if (envSpecific && existsSync(envSpecific)) {
      return envSpecific;
    }
    if (process.env.HOST_PTY_BINARY_PATH && existsSync(process.env.HOST_PTY_BINARY_PATH)) {
      return process.env.HOST_PTY_BINARY_PATH;
    }
    const candidates = [
      `/app/agent/host-pty-linux-${arch}`,
      join(process.cwd(), "agent", `host-pty-linux-${arch}`),
      join(process.cwd(), "packages", "agent", "dist", `host-pty-linux-${arch}`),
      join(process.cwd(), "packages", "agent", `host-pty-linux-${arch}`),
      join(process.cwd(), "..", "..", "packages", "agent", "dist", `host-pty-linux-${arch}`),
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
  }

  resolveAiHostHelperBinaryPath(arch: Architecture): string | null {
    const envSpecific =
      arch === "arm64"
        ? process.env.AI_HOST_HELPER_BINARY_PATH_ARM64
        : process.env.AI_HOST_HELPER_BINARY_PATH_AMD64;
    if (envSpecific && existsSync(envSpecific)) {
      return envSpecific;
    }
    if (
      process.env.AI_HOST_HELPER_BINARY_PATH &&
      existsSync(process.env.AI_HOST_HELPER_BINARY_PATH)
    ) {
      return process.env.AI_HOST_HELPER_BINARY_PATH;
    }
    const candidates = [
      `/app/agent/ai/ai-host-helper-linux-${arch}`,
      `/app/agent/ai-host-helper-linux-${arch}`,
      join(process.cwd(), "agent", `ai-host-helper-linux-${arch}`),
      join(process.cwd(), "packages", "agent", "dist", `ai-host-helper-linux-${arch}`),
      join(process.cwd(), "packages", "agent", `ai-host-helper-linux-${arch}`),
      join(process.cwd(), "..", "..", "packages", "agent", "dist", `ai-host-helper-linux-${arch}`),
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
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
