import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { AiBundleService } from "../src/ai/ai-bundle.service.js";
import {
  AI_BUNDLE_LOCAL_HOST_INSTALL_REASON,
  AiBundleOrchestrationService,
  type AiBundleInstallTransport,
  type AiBundleSshAuth,
} from "../src/ai/ai-bundle-install.service.js";
import type { VpsRecord } from "../src/vps/vps.models.js";

// Slice 3b runner tests: the SSH install runner against a fully fake
// transport (no network, no real SSH). Exercises the upload/verify/install/
// confirm pipeline and every failure path.

type ExecResult = { stdout: string; stderr: string };

type FakeTransport = AiBundleInstallTransport & {
  mkdirs: Array<{ remotePath: string; mode: number }>;
  uploads: Array<{ remotePath: string; contentSha: string; mode: number }>;
  commands: string[];
  installerCommands: string[];
  verifyCommands: string[];
};

type TransportScript = {
  auth: AiBundleSshAuth | null;
  hangAuth?: boolean;
  failVerifyFor?: string; // remote path fragment whose sha256 verify fails
  installer?: (command: string) => Promise<ExecResult> | ExecResult;
  discovery?: ExecResult;
};

function makeFakeTransport(script: TransportScript): FakeTransport {
  const mkdirs: FakeTransport["mkdirs"] = [];
  const uploads: FakeTransport["uploads"] = [];
  const commands: string[] = [];
  const installerCommands: string[] = [];
  const verifyCommands: string[] = [];
  return {
    mkdirs,
    uploads,
    commands,
    installerCommands,
    verifyCommands,
    resolveAuth: async () => (script.hangAuth ? new Promise(() => {}) : script.auth),
    makeDirectory: async (_vps: VpsRecord, remotePath: string, mode: number) => {
      mkdirs.push({ remotePath, mode });
    },
    uploadFile: async (_vps: VpsRecord, remotePath: string, content: Buffer, mode: number) => {
      uploads.push({ remotePath, contentSha: createHash("sha256").update(content).digest("hex"), mode });
    },
    execCommand: async (_vps: VpsRecord, command: string): Promise<ExecResult> => {
      commands.push(command);
      if (command.includes("AGENT_BIN=")) return script.discovery ?? { stdout: "AGENT_BIN=/usr/local/bin/vps-manager-agent\nAGENT_CONFIG=/etc/vps-manager-agent/config.json", stderr: "" };
      if (command.includes("sha256sum")) {
        verifyCommands.push(command);
        if (script.failVerifyFor && command.includes(script.failVerifyFor)) {
          throw new Error("sha256 mismatch on host");
        }
        return { stdout: "", stderr: "" };
      }
      if (command.includes("install-local-agent.sh")) {
        installerCommands.push(command);
        return script.installer ? await script.installer(command) : { stdout: "AI_BUNDLE_INSTALL_OK", stderr: "" };
      }
      // rm -rf cleanup and anything else
      return { stdout: "", stderr: "" };
    },
  } as FakeTransport;
}

type Fixture = { dir: string; digests: Record<string, string> };

async function writeBundleFixture(prefix: string, arches: Array<"amd64" | "arm64"> = ["amd64", "arm64"]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const digests: Record<string, string> = {};
  const put = async (name: string, content: string) => {
    const path = join(dir, ...name.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    digests[name] = createHash("sha256").update(content).digest("hex");
  };
  await put("install-local-agent.sh", "#!/usr/bin/env bash\necho installer\n");
  await put("installer-lib.sh", "# lib\n");
  for (const arch of arches) {
    await put(`ai-executor-linux-${arch}`, `executor-${arch}\n`);
    await put(`ai-host-helper-linux-${arch}`, `helper-${arch}\n`);
    await put(`ai-rootfs-linux-${arch}.tar.gz`, `rootfs-${arch}\n`);
    await put(`ai-rootfs-linux-${arch}.manifest.json`, `{"arch":"${arch}"}\n`);
  }
  await put("profiles/nginx.json", '{"id":"nginx"}\n');
  return { dir, digests };
}

describe("AI bundle install runner", () => {
  let stateDir: string;
  let fixture: Fixture;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let config: AppConfig;
  let bundleService: AiBundleService;
  let orchestration: AiBundleOrchestrationService;

  function makeAgentRepo(arch?: string): AgentRepository {
    return {
      getSystemInfo: async () =>
        arch ? ({ vpsId, collectedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), kernel: { arch } }) : undefined,
    } as unknown as AgentRepository;
  }

  beforeEach(async () => {
    fixture = await writeBundleFixture("ai-bundle-run");
    stateDir = await mkdtemp(join(tmpdir(), "ai-bundle-run-state-"));
    aiRepo = createJsonAiRepository(join(stateDir, "ai.json"));
    vpsRepo = createVpsStore(join(stateDir, "vps.json"));
    const created = await vpsRepo.create({ name: "VPS", host: "10.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-bundle-run-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: fixture.dir,
    });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true } };
    bundleService = new AiBundleService(config);
    orchestration = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, makeFakeTransport({ auth: { privateKey: "k" } }),
      { confirmDeadlineMs: 2_000, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
  });

  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  async function startJob(jobId: string): Promise<void> {
    const bundle = bundleService.getBundle();
    if (!bundle.available) throw new Error("fixture bundle unavailable");
    await aiRepo.startAiBundleJob({ vpsId, bundleId: bundle.bundleId, trigger: "manual", jobId });
  }

  it("uploads per-arch artifacts, verifies sha256 on-host, runs the installer and confirms via a fresh capability claim", async () => {
    const bundle = bundleService.getBundle();
    if (!bundle.available) throw new Error("fixture bundle unavailable");
    const transport = makeFakeTransport({
      auth: { privateKey: "k" },
      installer: () => {
        // Simulate the restarted agent claiming capabilities after install.
        setTimeout(() => {
          void aiRepo.recordAiCapability({
            vpsId,
            supported: true,
            freshness: new Date().toISOString(),
            protocolVersion: 1,
            cgroupV2Available: true,
            namespacesAvailable: true,
            seccompAvailable: true,
            privilegedSupported: false,
            profiles: ["nginx"],
            rootfsDigest: bundle.arches.amd64!.rootfsDigest,
          }).catch(() => {});
        }, 15);
        return { stdout: "AI_BUNDLE_INSTALL_OK", stderr: "" };
      },
    });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 2_000, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await startJob("job-success-1");
    await runner.runJob(vpsId, "job-success-1");

    const job = await aiRepo.getAiBundleJob(vpsId);
    expect(job?.state).toBe("succeeded");
    expect(job?.lastInstalledBundleId).toBe(bundle.bundleId);
    expect(job?.error).toBeUndefined();

    // Temp staging dir + mode
    expect(transport.mkdirs).toEqual([{ remotePath: `/tmp/flexserver-ai-install-job-success-1`, mode: 0o700 }]);

    // Upload list per arch + sha256 verified on-host for every upload
    const tmp = "/tmp/flexserver-ai-install-job-success-1";
    const remoteNames = transport.uploads.map((u) => u.remotePath.slice(tmp.length + 1)).sort();
    expect(remoteNames).toEqual([
      "ai-executor",
      "ai-host-helper",
      "install-local-agent.sh",
      "installer-lib.sh",
      "profiles/nginx.json",
      "rootfs.manifest.json",
      "rootfs.tar.gz",
    ]);
    const executor = transport.uploads.find((u) => u.remotePath === `${tmp}/ai-executor`)!;
    expect(executor.contentSha).toBe(fixture.digests["ai-executor-linux-amd64"]!);
    expect(transport.verifyCommands).toHaveLength(transport.uploads.length);
    for (const upload of transport.uploads) {
      expect(transport.verifyCommands.some((c) => c.includes(upload.remotePath) && c.includes(upload.contentSha))).toBe(true);
    }

    // Installer invoked with the real flag set, under root/sudo handling
    expect(transport.installerCommands).toHaveLength(1);
    const installerCmd = transport.installerCommands[0]!;
    expect(installerCmd).toContain("sudo -n sh -c");
    expect(installerCmd).toContain("--skip-cli");
    expect(installerCmd).toContain("--install-ai");
    expect(installerCmd).toContain(`--binary '${tmp}/vps-agent'`);
    expect(installerCmd).toContain(`--config '${tmp}/config.json'`);
    expect(installerCmd).toContain(`--ai-executor-binary '${tmp}/ai-executor'`);
    expect(installerCmd).toContain(`--ai-host-helper-binary '${tmp}/ai-host-helper'`);
    expect(installerCmd).toContain(`--ai-rootfs-tar '${tmp}/rootfs.tar.gz'`);
    expect(installerCmd).toContain(`--ai-rootfs-manifest '${tmp}/rootfs.manifest.json'`);
    expect(installerCmd).toContain(`--ai-profiles-dir '${tmp}/profiles'`);
    const invocation = installerCmd.split("\n").find((line) => line.includes("bash '") && line.includes("install-local-agent.sh"));
    expect(invocation).toContain(`--ai-profiles-dir '${tmp}/profiles' && echo AI_BUNDLE_INSTALL_OK`);

    // Staging directory cleaned up best-effort
    expect(transport.commands.some((c) => c.includes(`rm -rf '${tmp}'`))).toBe(true);
  });

  it("resolves the target arch from agent system info (aarch64 -> arm64)", async () => {
    const transport = makeFakeTransport({
      auth: { privateKey: "k" },
      installer: () => {
        setTimeout(() => {
          void aiRepo.recordAiCapability({
            vpsId, supported: true, freshness: new Date().toISOString(), protocolVersion: 1,
            cgroupV2Available: true, namespacesAvailable: true, seccompAvailable: true,
            privilegedSupported: false, profiles: [], rootfsDigest: fixture.digests["ai-rootfs-linux-arm64.manifest.json"]!,
          }).catch(() => {});
        }, 10);
        return { stdout: "AI_BUNDLE_INSTALL_OK", stderr: "" };
      },
    });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("aarch64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 2_000, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await startJob("job-arm64-1");
    await runner.runJob(vpsId, "job-arm64-1");
    const tmp = "/tmp/flexserver-ai-install-job-arm64-1";
    const executor = transport.uploads.find((u) => u.remotePath === `${tmp}/ai-executor`)!;
    expect(executor.contentSha).toBe(fixture.digests["ai-executor-linux-arm64"]!);
    expect((await aiRepo.getAiBundleJob(vpsId))?.state).toBe("succeeded");
  });

  it("aborts before the installer when an uploaded file fails on-host sha256 verification", async () => {
    const transport = makeFakeTransport({ auth: { privateKey: "k" }, failVerifyFor: "ai-executor" });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await startJob("job-shamismatch-1");
    await runner.runJob(vpsId, "job-shamismatch-1");
    const job = await aiRepo.getAiBundleJob(vpsId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("sha256 verification failed for ai-executor-linux-amd64");
    expect(transport.installerCommands).toHaveLength(0);
  });

  it("fails the job when the installer exits nonzero, with a redacted error", async () => {
    const transport = makeFakeTransport({
      auth: { privateKey: "k" },
      installer: () => ({ stdout: "", stderr: "Error: systemctl failed password=hunter2" }),
    });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await startJob("job-installfail-1");
    await runner.runJob(vpsId, "job-installfail-1");
    const job = await aiRepo.getAiBundleJob(vpsId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("installer failed");
    expect(job?.error).not.toContain("hunter2");
    expect(job?.error).toContain("[REDACTED]");
  });

  it("fails the job when no confirming capability claim arrives within the deadline", async () => {
    const transport = makeFakeTransport({ auth: { privateKey: "k" } });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 60, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await startJob("job-noconfirm-1");
    await runner.runJob(vpsId, "job-noconfirm-1");
    const job = await aiRepo.getAiBundleJob(vpsId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("no confirming AI capability claim");
  });

  it("fails the job without SSH when no saved key exists", async () => {
    const transport = makeFakeTransport({ auth: null });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await startJob("job-noauth-1");
    await runner.runJob(vpsId, "job-noauth-1");
    const job = await aiRepo.getAiBundleJob(vpsId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("No saved authorized SSH key");
    expect(transport.uploads).toHaveLength(0);
    expect(transport.installerCommands).toHaveLength(0);
  });

  it("fails the job when the bundle lacks artifacts for the host arch (fallback amd64 for unknown arch)", async () => {
    // amd64-only bundle + aarch64 host -> no arm64 artifacts
    const amdOnly = await writeBundleFixture("ai-bundle-run-amdonly", ["amd64"]);
    try {
      const parsed = parseAppConfig({
        APP_MODE: "local",
        DASHBOARD_SESSION_SECRET: "ai-bundle-run-test-secret-0123456789",
        APP_AI_BUNDLE_DIR: amdOnly.dir,
      });
      const amdConfig: AppConfig = { ...parsed, ai: { ...parsed.ai, enabled: true } };
      const amdBundleService = new AiBundleService(amdConfig);
      const transport = makeFakeTransport({ auth: { privateKey: "k" } });
      const runner = new AiBundleOrchestrationService(
        amdConfig, aiRepo, vpsRepo, makeAgentRepo("aarch64"), amdBundleService,
        undefined, transport,
        { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
      );
      const bundle = amdBundleService.getBundle();
      if (!bundle.available) throw new Error("fixture bundle unavailable");
      await aiRepo.startAiBundleJob({ vpsId, bundleId: bundle.bundleId, trigger: "manual", jobId: "job-arch-1" });
      await runner.runJob(vpsId, "job-arch-1");
      const job = await aiRepo.getAiBundleJob(vpsId);
      expect(job?.state).toBe("failed");
      expect(job?.error).toContain("no artifacts for host architecture arm64");
      expect(transport.uploads).toHaveLength(0);
    } finally {
      await rm(amdOnly.dir, { recursive: true, force: true });
    }
  });

  it("fails the job for local/system-managed hosts without any SSH activity", async () => {
    await vpsRepo.ensureLocalHost({ id: vpsId, name: "Local host", host: "127.0.0.1", port: 22, username: "root", kind: "local", managedBy: "system" });
    const transport = makeFakeTransport({ auth: { privateKey: "k" } });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await startJob("job-local-1");
    await runner.runJob(vpsId, "job-local-1");
    const job = await aiRepo.getAiBundleJob(vpsId);
    expect(job?.state).toBe("failed");
    expect(job?.error).toContain("remote SSH-managed host");
    expect(transport.mkdirs).toHaveLength(0);
  });

  // ── host eligibility: local/system hosts never install from the dashboard ──

  const toLocalHost = () =>
    vpsRepo.ensureLocalHost({ id: vpsId, name: "Local host", host: "127.0.0.1", port: 22, username: "root", kind: "local", managedBy: "system" });

  it("reports installSupported per host kind in the bundle view", async () => {
    const remote = await orchestration.getBundleView(vpsId);
    expect(remote.installSupported).toBe(true);
    expect(remote.installReason).toBeUndefined();

    await toLocalHost();
    const local = await orchestration.getBundleView(vpsId);
    expect(local.installSupported).toBe(false);
    expect(local.installReason).toBe(AI_BUNDLE_LOCAL_HOST_INSTALL_REASON);
  });

  it("reports an actionable unresolved-host reason (not local guidance) when the VPS record is missing or unreadable", async () => {
    const view = await orchestration.getBundleView("vps_does_not_exist");
    expect(view.installSupported).toBe(false);
    expect(view.installReason).toBe(
      "VPS record not found or unreadable — refresh the dashboard and retry; AI install support cannot be determined.",
    );
    // Must not leak the local-host guidance for an unresolvable host.
    expect(view.installReason).not.toContain("install.sh");
  });

  it("manual installBundle rejects local/system hosts with 400 before job creation or SSH", async () => {
    await toLocalHost();
    const transport = makeFakeTransport({ auth: { privateKey: "k" } });
    let authCalls = 0;
    const innerResolve = transport.resolveAuth;
    transport.resolveAuth = async (id) => {
      authCalls += 1;
      return innerResolve(id);
    };
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    const error = await runner.installBundle(vpsId, "manual").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain("sudo bash scripts/install/install.sh");
    expect(await aiRepo.getAiBundleJob(vpsId)).toBeUndefined();
    expect(authCalls).toBe(0);
    expect(transport.mkdirs).toHaveLength(0);
    expect(transport.uploads).toHaveLength(0);
    expect(transport.commands).toHaveLength(0);
  });

  it("manual installBundle rejects an unresolvable VPS with 404 and no local-guidance message", async () => {
    const transport = makeFakeTransport({ auth: { privateKey: "k" } });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    const error = await runner.installBundle("vps_does_not_exist", "manual").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe("VPS not found");
    expect(await aiRepo.getAiBundleJob("vps_does_not_exist")).toBeUndefined();
    expect(transport.mkdirs).toHaveLength(0);
    expect(transport.commands).toHaveLength(0);
  });

  it("manual installBundle still schedules for remote hosts (remote flow preserved)", async () => {
    // Hanging auth keeps the freshly scheduled job pending deterministically.
    const transport = makeFakeTransport({ hangAuth: true });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    const view = await runner.installBundle(vpsId, "manual");
    expect(view.installSupported).toBe(true);
    expect(view.lastJob?.state).toBe("pending");
    expect((await aiRepo.getAiBundleJob(vpsId))?.trigger).toBe("manual");
    expect(transport.mkdirs).toHaveLength(0);
  });

  it("deliberate-action trigger skips local/system hosts (no job, no SSH)", async () => {
    await toLocalHost();
    const transport = makeFakeTransport({ auth: { privateKey: "k" } });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await runner.maybeInstallAfterDeliberateAction(vpsId);
    expect(await aiRepo.getAiBundleJob(vpsId)).toBeUndefined();
    expect(transport.mkdirs).toHaveLength(0);
    expect(transport.uploads).toHaveLength(0);
    expect(transport.commands).toHaveLength(0);
  });

  it("deliberate-action trigger still schedules for remote hosts", async () => {
    const transport = makeFakeTransport({ hangAuth: true });
    const runner = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, makeAgentRepo("x86_64"), bundleService,
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, installerTimeoutMs: 10_000 },
    );
    await runner.maybeInstallAfterDeliberateAction(vpsId);
    expect((await aiRepo.getAiBundleJob(vpsId))?.trigger).toBe("deliberate");
    expect(transport.mkdirs).toHaveLength(0);
  });
});
