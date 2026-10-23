import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import { FleetProvisioningService, type Architecture } from "../src/agents/fleet-provisioning.service.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AgentRepository, AgentCredentialRecord } from "../src/persistence/repositories/agent.repository.js";
import type { KeyService } from "../src/ssh/keyService.js";
import type { HostKeyPinService } from "../src/ssh/host-key-pin.service.js";
import type { SshService } from "../src/ssh/ssh.service.js";
import type { AuditService } from "../audit/audit.service.js";
import type { AgentService } from "../src/agents/agent.service.js";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

describe("FleetProvisioningService", () => {
  let tempDir: string;
  let vpsRepo: VpsRepository;
  let mockKeys: {
    readPrivateKey: Mock;
  };
  let mockHostKeyPin: {
    getTrustedFingerprints: Mock;
  };
  let mockAgentRepo: Partial<AgentRepository>;
  let mockAgentService: Partial<AgentService>;
  let mockSsh: {
    execCommand: Mock;
    uploadFile: Mock;
    makeDirectory: Mock;
  };
  let mockAudit: Partial<AuditService>;
  let service: FleetProvisioningService;
  let config: AppConfig;

  let credentialsStore: Map<string, AgentCredentialRecord>;
  let executedCommands: string[];
  let uploadedFiles: Map<string, Buffer | string>;
  let dummyScript: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fleet-prov-test-"));
    const vpsPath = join(tempDir, "vps.json");
    vpsRepo = createVpsStore(vpsPath);

    // Create mock updater binaries and installer script in tempDir
    const dummyBinDir = join(tempDir, "bin");
    await mkdir(dummyBinDir, { recursive: true });
    const dummyUpdaterAmd64 = join(dummyBinDir, "vps-updater-linux-amd64");
    const dummyUpdaterArm64 = join(dummyBinDir, "vps-updater-linux-arm64");
    dummyScript = join(dummyBinDir, "install-fleet-updater.sh");
    await writeFile(dummyUpdaterAmd64, Buffer.from("mock-updater-amd64-binary"));
    await writeFile(dummyUpdaterArm64, Buffer.from("mock-updater-arm64-binary"));
    await writeFile(dummyScript, "#!/bin/sh\necho mock installer");


    config = {
      mode: "local",
      enableWebTerminal: false,
      agentPublicBaseUrl: "https://api.example.com",
      allowPrivateNetworkTargets: false,
      dataDir: tempDir,
      privateDir: join(tempDir, "private"),
      rateLimitWindowMs: 60_000,
      rateLimitMax: 120,
      agentInstallIntervalSeconds: 15,
      allowInsecureAgentHttp: false,
      storageDriver: "json",
      dbSsl: false,
      dbPoolMax: 10,
      dashboardSessionTtlSeconds: 86_400,
      dashboardCookieSecure: false,
      dashboardCookieSameSite: "lax",
      dashboardSessionSecret: "test-secret-min-32-chars-long!!",
      trustProxyHops: 0,
      jobHistoryLimit: 1000,
      auditHistoryLimit: 5000,
      metricWindowLimit: 120,
      sshHostKeyPins: {},
      sshHostKeyPolicy: "strict",
    };

    credentialsStore = new Map();
    executedCommands = [];
    uploadedFiles = new Map();

    mockKeys = {
      readPrivateKey: vi.fn(async (vpsId: string) => `-----BEGIN PRIVATE KEY-----\nmock-key-for-${vpsId}\n-----END PRIVATE KEY-----`),
    };

    mockHostKeyPin = {
      getTrustedFingerprints: vi.fn(async () => ["SHA256:trustedfingerprint123"]),
    };

    let credCounter = 0;
    mockAgentRepo = {
      getCredential: vi.fn(async (id: string) => credentialsStore.get(id)),
      revokeCredential: vi.fn(async (id: string) => {
        const cred = credentialsStore.get(id);
        if (cred) {
          cred.status = "revoked";
        }
      }),
      createCredential: vi.fn(async (input) => {
        credCounter++;
        const id = `cred_${credCounter}`;
        const record: AgentCredentialRecord = {
          id,
          vpsId: input.vpsId,
          secretHash: input.secretHash,
          status: input.status,
          scope: input.scope,
          createdAt: new Date().toISOString(),
          revokedAt: null,
          lastUsedAt: null,
        };
        credentialsStore.set(id, record);
        return record;
      }),
    };

    mockAgentService = {
      createCredential: vi.fn(async (vpsId: string, status: "active", scope?: string) => {
        credCounter++;
        const id = `cred_${credCounter}`;
        const secret = `secret_${credCounter}`;
        const record: AgentCredentialRecord = {
          id,
          vpsId,
          secretHash: hashSecret(secret),
          status,
          scope: (scope ?? "local-updater") as "agent" | "local-updater",
          createdAt: new Date().toISOString(),
          revokedAt: null,
          lastUsedAt: null,
        };
        credentialsStore.set(id, record);
        return {
          credential: record,
          token: `vma_${id}_${secret}`,
        };
      }),
    };

    mockSsh = {
      execCommand: vi.fn(async (_vps, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") {
          return { stdout: "x86_64\n", stderr: "" };
        }
        if (cmd.includes("cat /etc/vps-updater/config.json")) {
          return { stdout: "", stderr: "" };
        }
        if (cmd.includes("install-fleet-updater.sh") || cmd.includes("flock -x -w 5 9")) {
          return { stdout: "PROVISIONING_COMPLETE_OK\n", stderr: "" };
        }
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) {
          return { stdout: "PRIV_OK\n", stderr: "" };
        }
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) {
          return { stdout: "PROVISIONING_COMPLETE_OK\n", stderr: "" };
        }
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: [
              "AGENT_BIN=/home/admin/.vps-manager-agent/vps-agent",
              "AGENT_STATE_DIR=/var/lib/vps-manager-agent",
              "HAS_HOST_PTY=0",
              "HAS_AI_HELPER=0",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      }),
      execCommandStrict: vi.fn(async (_vps, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") {
          return { stdout: "x86_64\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }),
      uploadFile: vi.fn(async (_vps, remotePath: string, content: Buffer | string) => {
        uploadedFiles.set(remotePath, content);
      }),
      makeDirectory: vi.fn(async () => {}),
    };

    mockAudit = {
      record: vi.fn(async () => {}),
    };

    service = new FleetProvisioningService(
      config,
      vpsRepo,
      mockKeys as KeyService,
      mockAgentRepo as AgentRepository,
      mockAgentService as AgentService,
      mockSsh as SshService,
      mockAudit as AuditService,
      undefined,
      mockHostKeyPin as HostKeyPinService,
    );

    // Override resolveInstallerScriptPath to use our dummy script
    vi.spyOn(service, "resolveInstallerScriptPath").mockReturnValue(dummyScript);
    vi.spyOn(service, "resolveUpdaterBinaryPath").mockImplementation((arch) =>
      arch === "arm64" ? dummyUpdaterArm64 : dummyUpdaterAmd64,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("ensureBundled", () => {
    it("generates a provisioning command accepted by bash and POSIX sh", async () => {
      const vps = await vpsRepo.create({
        name: "azure-student",
        host: "192.0.2.10",
        port: 22,
        username: "admin",
      });

      await service.ensureBundled(vps.id);
      const command = executedCommands.find((cmd) => cmd.includes("flock -x -w 5 9"));
      expect(command).toBeDefined();
      for (const shell of ["bash", "sh"]) {
        const parsed = spawnSync(shell, ["-n"], { input: command!, encoding: "utf8" });
        expect(parsed.stderr).toBe("");
        expect(parsed.status).toBe(0);
      }
    });

    it("returns failed when VPS is not found", async () => {
      const result = await service.ensureBundled("nonexistent");
      expect(result.status).toBe("failed");
      expect(result.reason).toBe("VPS not found");
    });

    it("returns failed when VPS is local or system managed", async () => {
      const vps = await vpsRepo.create({
        name: "local-box",
        host: "127.0.0.1",
        port: 22,
        username: "root",
      });
      vi.spyOn(vpsRepo, "get").mockResolvedValueOnce({ ...vps, kind: "local" });
      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("failed");
      expect(result.reason).toMatch(/not applicable for local/i);
    });

    it("returns needs_access when SSH host key is unpinned / not trusted", async () => {
      const vps = await vpsRepo.create({
        name: "remote-untrusted",
        host: "192.168.1.100",
        port: 22,
        username: "admin",
      });
      mockHostKeyPin.getTrustedFingerprints.mockResolvedValueOnce([]);

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("needs_access");
      expect(result.reason).toMatch(/SSH host key is not trusted/i);
    });

    it("returns needs_access when no saved authorized SSH private key exists", async () => {
      const vps = await vpsRepo.create({
        name: "remote-no-key",
        host: "192.168.1.101",
        port: 22,
        username: "admin",
      });
      mockKeys.readPrivateKey.mockResolvedValueOnce(null);

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("needs_access");
      expect(result.reason).toMatch(/No saved authorized SSH key available/i);
    });

    it("returns needs_access when remote host lacks root or passwordless sudo", async () => {
      const vps = await vpsRepo.create({
        name: "remote-no-sudo",
        host: "192.168.1.102",
        port: 22,
        username: "admin",
      });

      // Privilege check returns PRIV_FAILED
      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) {
          return { stdout: "PRIV_FAILED\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("needs_access");
      expect(result.reason).toMatch(/root or passwordless sudo required/i);
    });

    it("provisions immediately and executes installer even when host registry has active workloads", async () => {
      const hostStateDir = join(tempDir, "remote-host-busy");
      const regDir = join(hostStateDir, "docker-applications");
      await mkdir(regDir, { recursive: true });

      // Simulate active busy exclusion registry on remote host
      await writeFile(
        join(regDir, "exclusion.json"),
        JSON.stringify({
          scopes: [
            { scope: "terminal:active-session-1" },
            { scope: "ai:workload-running" },
          ],
        }),
      );

      const markerFile = join(hostStateDir, "installer_executed.marker");
      // Set dummy installer to write markerFile upon execution
      const installerPath = service.resolveInstallerScriptPath();
      await writeFile(
        installerPath,
        `#!/bin/sh\necho "MOCK_INSTALLER_EXECUTED" > "${markerFile}"\nexit 0\n`,
      );
      await chmod(installerPath, 0o755);
      const vps = await vpsRepo.create({
        name: "remote-busy-workload",
        host: "192.168.1.103",
        port: 22,
        username: "admin",
      });

      mockSsh.makeDirectory.mockImplementation(async (_vps: unknown, dir: string) => {
        await mkdir(dir, { recursive: true });
      });

      mockSsh.uploadFile.mockImplementation(
        async (_vps: unknown, remotePath: string, content: Buffer | string) => {
          uploadedFiles.set(remotePath, content);
          await mkdir(dirname(remotePath), { recursive: true });
          await writeFile(remotePath, content);
          await chmod(remotePath, 0o755);
        },
      );

      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) {
          return { stdout: "PRIV_OK\n", stderr: "" };
        }
        if (cmd.includes("cat /etc/vps-updater/config.json")) {
          return { stdout: "", stderr: "" };
        }
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: [
              `AGENT_BIN=${hostStateDir}/vps-agent`,
              `AGENT_STATE_DIR=${hostStateDir}`,
              "HAS_HOST_PTY=0",
              "HAS_AI_HELPER=0",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        if (cmd.includes("flock -x -w 5 9")) {
          const res = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
          if (res.status !== 0) {
            throw new Error(res.stderr.trim() || res.stdout.trim() || `Exit ${res.status}`);
          }
          return { stdout: res.stdout, stderr: res.stderr };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("enrolled");
      expect(result.reason).toBeNull();
      expect(existsSync(markerFile)).toBe(true);

      const command = executedCommands.find((cmd) => cmd.includes("flock -x -w 5 9"));
      expect(command).toBeDefined();
      expect(command).toContain("fleet-updater.lock");
      expect(command).not.toContain("active_sessions");
      expect(command).not.toContain("cgroup.procs");
      expect(command).not.toContain("GATE_BUSY");
    });

    it("ensures flock failure stops installer execution rather than proceeding", async () => {
      const hostStateDir = join(tempDir, "remote-host-flock");
      const regDir = join(hostStateDir, "docker-applications");
      await mkdir(regDir, { recursive: true });

      const lockFile = join(regDir, "fleet-updater.lock");
      await writeFile(lockFile, "");

      const markerFile = join(hostStateDir, "installer_should_not_run.marker");
      const installerPath = service.resolveInstallerScriptPath();
      await writeFile(
        installerPath,
        `#!/bin/sh\necho "SHOULD_NOT_RUN" > "${markerFile}"\nexit 0\n`,
      );
      await chmod(installerPath, 0o755);

      const vps = await vpsRepo.create({
        name: "remote-flock-busy",
        host: "192.168.1.104b",
        port: 22,
        username: "admin",
      });

      mockSsh.makeDirectory.mockImplementation(async (_vps: unknown, dir: string) => {
        await mkdir(dir, { recursive: true });
      });

      mockSsh.uploadFile.mockImplementation(
        async (_vps: unknown, remotePath: string, content: Buffer | string) => {
          uploadedFiles.set(remotePath, content);
          await mkdir(dirname(remotePath), { recursive: true });
          await writeFile(remotePath, content);
          await chmod(remotePath, 0o755);
        },
      );
      // Pre-acquire exclusive flock on fleet-updater.lock so the installer flock check times out
      const blocker = spawn("flock", ["-x", lockFile, "sleep", "10"]);

      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) {
          return { stdout: "PRIV_OK\n", stderr: "" };
        }
        if (cmd.includes("cat /etc/vps-updater/config.json")) {
          return { stdout: "", stderr: "" };
        }
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: [
              `AGENT_BIN=${hostStateDir}/vps-agent`,
              `AGENT_STATE_DIR=${hostStateDir}`,
              "HAS_HOST_PTY=0",
              "HAS_AI_HELPER=0",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        if (cmd.includes("flock -x -w 5 9")) {
          const res = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
          if (res.status !== 0) {
            throw new Error(res.stderr.trim() || res.stdout.trim() || `Exit ${res.status}`);
          }
          return { stdout: res.stdout, stderr: res.stderr };
        }
        return { stdout: "", stderr: "" };
      });

      try {
        const result = await service.ensureBundled(vps.id);
        expect(result.status).toBe("failed");
        expect(result.reason).toMatch(/update lock held by concurrent update/i);
        expect(existsSync(markerFile)).toBe(false);
      } finally {
        blocker.kill();
      }
    });
    it("provisions successfully in bundled mode without needing release public key", async () => {
      const vps = await vpsRepo.create({
        name: "remote-ready",
        host: "192.168.1.104",
        port: 22,
        username: "admin",
      });

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("enrolled");
      expect(result.reason).toBeNull();

      // Check executed installer command had --source 'bundled' and no --pubkey-file
      const installCmd = executedCommands.find((c) => c.includes("install-fleet-updater.sh"));
      expect(installCmd).toBeDefined();
      expect(installCmd).toContain("--source 'bundled'");
      expect(installCmd).toContain("--agent-binary '/home/admin/.vps-manager-agent/vps-agent'");
      expect(installCmd).toContain("--agent-state-dir '/var/lib/vps-manager-agent'");
      expect(installCmd).toContain("flock -x -w 5 9");
      expect(installCmd).toContain("fleet-updater.lock");
      expect(installCmd).not.toContain("--pubkey-file");
    });
  });

  describe("bundled vs signed provisioning source", () => {
    it("bundled mode succeeds without release public key configured", async () => {
      const vps = await vpsRepo.create({
        name: "bundled-vps",
        host: "192.168.1.105",
        port: 22,
        username: "admin",
      });

      const result = await service.provisionHost(vps.id, { privateKey: "mock-key" }, {
        source: "bundled",
      });
      expect(result.status).toBe("enrolled");
      expect(result.reason).toBeNull();
    });

    it("signed mode fails if release public key file is unconfigured", async () => {
      const vps = await vpsRepo.create({
        name: "signed-unconfigured",
        host: "192.168.1.106",
        port: 22,
        username: "admin",
      });

      const result = await service.provisionHost(vps.id, { privateKey: "mock-key" }, {
        source: "signed",
      });
      expect(result.status).toBe("failed");
      expect(result.reason).toMatch(/public key file is not configured/i);
    });

    it("signed mode passes --source 'signed' and --pubkey-file when configured", async () => {
      const vps = await vpsRepo.create({
        name: "signed-configured",
        host: "192.168.1.107",
        port: 22,
        username: "admin",
      });

      const pubKeyFile = join(tempDir, "release.pub");
      await writeFile(pubKeyFile, "-----BEGIN PUBLIC KEY-----\nmock-pub-key\n-----END PUBLIC KEY-----");
      config.fleet = { publicKeyFile: pubKeyFile };

      const result = await service.provisionHost(vps.id, { privateKey: "mock-key" }, {
        source: "signed",
      });
      expect(result.status).toBe("enrolled");

      const installCmd = executedCommands.find((c) => c.includes("install-fleet-updater.sh"));
      expect(installCmd).toContain("--source 'signed'");
      expect(installCmd).toContain("--pubkey-file");
    });

    it("rejects invalid provisioning source", async () => {
      const vps = await vpsRepo.create({
        name: "invalid-source-vps",
        host: "192.168.1.108",
        port: 22,
        username: "admin",
      });

      const result = await service.provisionHost(vps.id, { privateKey: "mock-key" }, {
        source: "invalid_source" as unknown as "bundled",
      });
      expect(result.status).toBe("failed");
      expect(result.reason).toMatch(/Invalid provisioning source/i);
    });
  });

  describe("credential reuse vs minting and revocation", () => {
    it("reuses valid existing updater credential from remote host and does not create new one", async () => {
      const vps = await vpsRepo.create({
        name: "existing-cred-vps",
        host: "192.168.1.109",
        port: 22,
        username: "admin",
      });

      // Existing credential in repo
      const existingSecret = "abcdef0123456789abcdef0123456789";
      const existingRecord: AgentCredentialRecord = {
        id: "cred_existing",
        vpsId: vps.id,
        secretHash: hashSecret(existingSecret),
        status: "active",
        scope: "local-updater",
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastUsedAt: null,
      };
      credentialsStore.set(existingRecord.id, existingRecord);

      const remoteConfigJson = JSON.stringify({
        credential: `vma_${existingRecord.id}_${existingSecret}`,
      });

      // Remote host returns existing config
      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("cat /etc/vps-updater/config.json")) {
          return { stdout: remoteConfigJson, stderr: "" };
        }
        if (cmd.includes("install-fleet-updater.sh")) {
          return { stdout: "", stderr: "" };
        }
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) {
          return { stdout: "PRIV_OK\n", stderr: "" };
        }
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) {
          return { stdout: "GATE_IDLE_OK\n", stderr: "" };
        }
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: "AGENT_BIN=/home/admin/.vps-manager-agent/vps-agent\nAGENT_STATE_DIR=/var/lib/vps-manager-agent\nHAS_HOST_PTY=0\nHAS_AI_HELPER=0\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });
      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("enrolled");

      // Verify no new credential was created via mockAgentService
      expect(mockAgentService.createCredential).not.toHaveBeenCalled();

      // Verify uploaded token matches the existing token
      let stagedTokenContent: string | undefined;
      for (const [path, content] of uploadedFiles.entries()) {
        if (path.endsWith("/.token")) {
          stagedTokenContent = content.toString();
        }
      }
      expect(stagedTokenContent).toBe(`vma_${existingRecord.id}_${existingSecret}`);
    });

    it("does not revoke reused credential if subsequent provisioning step fails", async () => {
      const vps = await vpsRepo.create({
        name: "reused-cred-fail",
        host: "192.168.1.110",
        port: 22,
        username: "admin",
      });

      const existingSecret = "1234567890abcdef1234567890abcdef";
      const existingRecord: AgentCredentialRecord = {
        id: "cred_reuse_fail",
        vpsId: vps.id,
        secretHash: hashSecret(existingSecret),
        status: "active",
        scope: "local-updater",
        createdAt: new Date().toISOString(),
        revokedAt: null,
        lastUsedAt: null,
      };
      credentialsStore.set(existingRecord.id, existingRecord);

      // Make script execution fail
      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("cat /etc/vps-updater/config.json")) {
          return { stdout: JSON.stringify({ credential: `vma_${existingRecord.id}_${existingSecret}` }), stderr: "" };
        }
        if (cmd.includes("install-fleet-updater.sh")) {
          throw new Error("Systemd failed to reload unit");
        }
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) return { stdout: "GATE_IDLE_OK\n", stderr: "" };
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: "AGENT_BIN=/home/admin/.vps-manager-agent/vps-agent\nAGENT_STATE_DIR=/var/lib/vps-manager-agent\nHAS_HOST_PTY=0\nHAS_AI_HELPER=0\n",
            stderr: "",
          };
        }
      });
      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("failed");

      // The reused credential MUST NOT be revoked
      expect(mockAgentRepo.revokeCredential).not.toHaveBeenCalled();
      expect(existingRecord.status).toBe("active");
    });

    it("revokes newly created credential if provisioning step fails", async () => {
      const vps = await vpsRepo.create({
        name: "new-cred-fail",
        host: "192.168.1.111",
        port: 22,
        username: "admin",
      });

      // Script execution fails
      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) return { stdout: "PRIV_OK\n", stderr: "" };
        if (cmd.includes("install-fleet-updater.sh")) {
          throw new Error("Disk full on target");
        }
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) return { stdout: "GATE_IDLE_OK\n", stderr: "" };
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: "AGENT_BIN=/home/admin/.vps-manager-agent/vps-agent\nAGENT_STATE_DIR=/var/lib/vps-manager-agent\nHAS_HOST_PTY=0\nHAS_AI_HELPER=0\n",
            stderr: "",
          };
        }
      });
      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("failed");

      // Since a new credential was minted, it MUST be revoked
      expect(mockAgentRepo.revokeCredential).toHaveBeenCalled();
    });
  });

  describe("onAgentReinstalled", () => {
    it("provisions bundled updater unconditionally on managed reinstall", async () => {
      const vps = await vpsRepo.create({
        name: "reinstall-vps",
        host: "192.168.1.112",
        port: 22,
        username: "admin",
      });

      const spy = vi.spyOn(service, "provisionHost");
      const result = await service.onAgentReinstalled(vps.id, { privateKey: "mock-key" });
      expect(result.status).toBe("enrolled");
      expect(spy).toHaveBeenCalledWith(vps.id, { privateKey: "mock-key" }, expect.objectContaining({
        source: "bundled",
        isNewHost: false,
      }));
    });
  });
  describe("helper binary refresh and state path discovery", () => {
    it("discovers custom agent state directory from unit and passes to installer", async () => {
      const vps = await vpsRepo.create({
        name: "custom-state-dir-vps",
        host: "192.168.1.120",
        port: 22,
        username: "admin",
      });

      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) return { stdout: "PRIV_OK\n", stderr: "" };
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) return { stdout: "GATE_IDLE_OK\n", stderr: "" };
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: [
              "AGENT_BIN=/opt/flexserver/agent",
              "AGENT_STATE_DIR=/var/data/custom-agent-state",
              "HAS_HOST_PTY=0",
              "HAS_AI_HELPER=0",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("enrolled");

      const installCmd = executedCommands.find((c) => c.includes("install-fleet-updater.sh"));
      expect(installCmd).toBeDefined();
      expect(installCmd).toContain("--agent-state-dir '/var/data/custom-agent-state'");
      expect(installCmd).toContain("--agent-binary '/opt/flexserver/agent'");
    });

    it("refreshes flexserver-host-pty helper when installed on remote host", async () => {
      const vps = await vpsRepo.create({
        name: "pty-helper-vps",
        host: "192.168.1.121",
        port: 22,
        username: "admin",
      });

      const dummyHostPty = join(tempDir, "bin", "host-pty-linux-amd64");
      await writeFile(dummyHostPty, Buffer.from("mock-host-pty-binary"));
      process.env.HOST_PTY_BINARY_PATH_AMD64 = dummyHostPty;

      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) return { stdout: "PRIV_OK\n", stderr: "" };
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) return { stdout: "GATE_IDLE_OK\n", stderr: "" };
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: [
              "AGENT_BIN=/usr/local/bin/vps-agent",
              "AGENT_STATE_DIR=/var/lib/vps-manager-agent",
              "HAS_HOST_PTY=1",
              "HAS_AI_HELPER=0",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("enrolled");

      // Check that flexserver-host-pty was uploaded and privileged refresh executed
      let uploadedHostPty = false;
      for (const path of uploadedFiles.keys()) {
        if (path.endsWith("/flexserver-host-pty")) {
          uploadedHostPty = true;
        }
      }
      expect(uploadedHostPty).toBe(true);

      const refreshCmd = executedCommands.find((c) => c.includes("flexserver-host-pty") && c.includes("chmod"));
      expect(refreshCmd).toBeDefined();
      expect(refreshCmd).toContain("chmod 0755 /usr/local/bin/flexserver-host-pty");

      delete process.env.HOST_PTY_BINARY_PATH_AMD64;
    });

    it("returns needs_access when host-pty is installed on host but deployment binary is unavailable", async () => {
      const vps = await vpsRepo.create({
        name: "pty-missing-bin-vps",
        host: "192.168.1.122",
        port: 22,
        username: "admin",
      });

      delete process.env.HOST_PTY_BINARY_PATH_AMD64;
      delete process.env.HOST_PTY_BINARY_PATH;
      vi.spyOn(service, "resolveHostPtyBinaryPath").mockReturnValue(null);

      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) return { stdout: "PRIV_OK\n", stderr: "" };
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) return { stdout: "GATE_IDLE_OK\n", stderr: "" };
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: [
              "AGENT_BIN=/usr/local/bin/vps-agent",
              "AGENT_STATE_DIR=/var/lib/vps-manager-agent",
              "HAS_HOST_PTY=1",
              "HAS_AI_HELPER=0",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("needs_access");
      expect(result.reason).toMatch(/Host terminal helper requires binary refresh/i);
    });

    it("refreshes ai-host-helper when installed on remote host", async () => {
      const vps = await vpsRepo.create({
        name: "ai-helper-vps",
        host: "192.168.1.123",
        port: 22,
        username: "admin",
      });

      const dummyAiHelper = join(tempDir, "bin", "ai-host-helper-linux-amd64");
      await writeFile(dummyAiHelper, Buffer.from("mock-ai-helper-binary"));
      process.env.AI_HOST_HELPER_BINARY_PATH_AMD64 = dummyAiHelper;

      mockSsh.execCommand.mockImplementation(async (_vps: unknown, cmd: string) => {
        executedCommands.push(cmd);
        if (cmd === "uname -m") return { stdout: "x86_64\n", stderr: "" };
        if (cmd.includes("PRIV_OK") || cmd.includes("PRIV_FAILED")) return { stdout: "PRIV_OK\n", stderr: "" };
        if (cmd.includes("GATE_BUSY") || cmd.includes("gate_status=")) return { stdout: "GATE_IDLE_OK\n", stderr: "" };
        if (cmd.includes("AGENT_BIN=") || cmd.includes("AGENT_STATE_DIR=")) {
          return {
            stdout: [
              "AGENT_BIN=/usr/local/bin/vps-agent",
              "AGENT_STATE_DIR=/var/lib/vps-manager-agent",
              "HAS_HOST_PTY=0",
              "HAS_AI_HELPER=1",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await service.ensureBundled(vps.id);
      expect(result.status).toBe("enrolled");

      let uploadedAiHelper = false;
      for (const path of uploadedFiles.keys()) {
        if (path.endsWith("/ai-host-helper")) {
          uploadedAiHelper = true;
        }
      }
      expect(uploadedAiHelper).toBe(true);

      const refreshCmd = executedCommands.find((c) => c.includes("ai-host-helper") && c.includes("chmod"));
      expect(refreshCmd).toBeDefined();
      expect(refreshCmd).toContain("chmod 0755 /usr/local/sbin/ai-host-helper");

      delete process.env.AI_HOST_HELPER_BINARY_PATH_AMD64;
    });

    it("does not persist one-time password during provisioning", async () => {
      const vps = await vpsRepo.create({
        name: "otp-vps",
        host: "192.168.1.124",
        port: 22,
        username: "admin",
      });

      await service.provisionHost(vps.id, { password: "one-time-secret-password" }, {
        source: "bundled",
      });

      const storedVps = await vpsRepo.get(vps.id);
      expect((storedVps as Record<string, unknown>).password).toBeUndefined();
    });
  });
});
