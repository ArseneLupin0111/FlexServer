import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";
import { AiBundleService } from "../src/ai/ai-bundle.service.js";
import {
  AiBundleOrchestrationService,
  type AiBundleInstallTransport,
} from "../src/ai/ai-bundle-install.service.js";
import type { AiCapability } from "../src/ai/ai.models.js";

// Slice 3b convergence tests (execmode plan Q7): the AI bundle convergence
// tick schedules updates only for hosts that already run an AI worker
// (capability report) when the bundled bundleId differs, with per-failure
// backoff. No network, no real SSH.

const flushAsync = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeBundleFixture(prefix: string): Promise<{ dir: string; bundleId: string }> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const put = async (name: string, content: string) => {
    const path = join(dir, ...name.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  };
  await put("install-local-agent.sh", "#!/usr/bin/env bash\n");
  await put("installer-lib.sh", "# lib\n");
  await put("ai-executor-linux-amd64", "executor\n");
  await put("ai-host-helper-linux-amd64", "helper\n");
  await put("ai-rootfs-linux-amd64.tar.gz", "rootfs\n");
  await put("ai-rootfs-linux-amd64.manifest.json", '{"arch":"amd64"}\n');
  await put("profiles/nginx.json", '{"id":"nginx"}\n');
  const bundleService = new AiBundleService(
    (() => {
      const parsed = parseAppConfig({ APP_MODE: "demo", APP_AI_BUNDLE_DIR: dir });
      return parsed;
    })(),
  );
  const bundle = bundleService.getBundle();
  if (!bundle.available) throw new Error("fixture bundle unavailable");
  return { dir, bundleId: bundle.bundleId };
}

function capabilityReport(vpsId: string): AiCapability {
  return {
    vpsId,
    supported: true,
    freshness: new Date().toISOString(),
    protocolVersion: 1,
    cgroupV2Available: true,
    namespacesAvailable: true,
    seccompAvailable: true,
    privilegedSupported: false,
    profiles: [],
    rootfsDigest: "stale-digest",
  };
}

describe("AI bundle convergence tick (Q7)", () => {
  let stateDir: string;
  let fixture: { dir: string; bundleId: string };
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsA: string;
  let vpsB: string;
  let config: AppConfig;
  let orchestration: AiBundleOrchestrationService;

  beforeEach(async () => {
    fixture = await writeBundleFixture("ai-bundle-conv");
    stateDir = await mkdtemp(join(tmpdir(), "ai-bundle-conv-state-"));
    aiRepo = createJsonAiRepository(join(stateDir, "ai.json"));
    vpsRepo = createVpsStore(join(stateDir, "vps.json"));
    const a = await vpsRepo.create({ name: "A", host: "10.0.0.1", port: 22, username: "root" });
    const b = await vpsRepo.create({ name: "B", host: "10.0.0.2", port: 22, username: "root" });
    vpsA = a.id;
    vpsB = b.id;
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-bundle-conv-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: fixture.dir,
    });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true } };
    // Jobs launched by the tick fail fast (no saved key) and stay contained.
    const transport = {
      resolveAuth: async () => null,
      makeDirectory: async () => {},
      uploadFile: async () => {},
      execCommand: async () => ({ stdout: "", stderr: "" }),
    } as unknown as AiBundleInstallTransport;
    orchestration = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, {} as unknown as AgentRepository, new AiBundleService(config),
      undefined, transport,
      { confirmDeadlineMs: 100, confirmPollIntervalMs: 5, failureBackoffMs: 10 * 60_000 },
    );
  });

  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("schedules an update when the installed bundle differs from the bundled one", async () => {
    await aiRepo.recordAiCapability(capabilityReport(vpsA));
    await orchestration.convergeTick();
    await flushAsync();
    const job = await aiRepo.getAiBundleJob(vpsA);
    expect(job?.trigger).toBe("convergence");
    expect(job?.bundleId).toBe(fixture.bundleId);
  });

  it("converges regardless of aiEnabled (AI OFF keeps version updates, Q5/Q7)", async () => {
    await aiRepo.recordAiCapability(capabilityReport(vpsA));
    await aiRepo.updateAiPolicy({ vpsId: vpsA, patch: { aiEnabled: false, shellEnabled: false }, expectedRevision: 0 });
    await orchestration.convergeTick();
    await flushAsync();
    expect((await aiRepo.getAiBundleJob(vpsA))?.trigger).toBe("convergence");
  });

  it("skips hosts whose installed bundle already matches (no job churn)", async () => {
    await aiRepo.recordAiCapability(capabilityReport(vpsA));
    const started = await aiRepo.startAiBundleJob({ vpsId: vpsA, bundleId: fixture.bundleId, trigger: "convergence" });
    await aiRepo.finishAiBundleJob({ vpsId: vpsA, jobId: started.job.jobId, outcome: "succeeded" });
    await orchestration.convergeTick();
    await flushAsync();
    const job = await aiRepo.getAiBundleJob(vpsA);
    expect(job?.jobId).toBe(started.job.jobId);
    expect(job?.state).toBe("succeeded");
  });

  it("skips hosts with a pending/running job", async () => {
    await aiRepo.recordAiCapability(capabilityReport(vpsA));
    const started = await aiRepo.startAiBundleJob({ vpsId: vpsA, bundleId: "older-bundle", trigger: "manual" });
    await aiRepo.markAiBundleJobRunning(vpsA, started.job.jobId);
    await orchestration.convergeTick();
    await flushAsync();
    const job = await aiRepo.getAiBundleJob(vpsA);
    expect(job?.jobId).toBe(started.job.jobId);
  });

  it("backs off recently failed hosts but retries after the backoff window", async () => {
    await aiRepo.recordAiCapability(capabilityReport(vpsA));
    const started = await aiRepo.startAiBundleJob({ vpsId: vpsA, bundleId: "older-bundle", trigger: "convergence" });
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    await aiRepo.finishAiBundleJob({ vpsId: vpsA, jobId: started.job.jobId, outcome: "failed", error: "ssh down", now: oneMinuteAgo });
    await orchestration.convergeTick();
    await flushAsync();
    expect((await aiRepo.getAiBundleJob(vpsA))?.jobId).toBe(started.job.jobId);

    // A brand new orchestration instance with an expired backoff (and no
    // newer failure) retries the same stale bundle.
    const retryOrchestration = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, {} as unknown as AgentRepository, new AiBundleService(config),
      undefined, {
        resolveAuth: async () => null,
        makeDirectory: async () => {},
        uploadFile: async () => {},
        execCommand: async () => ({ stdout: "", stderr: "" }),
      } as unknown as AiBundleInstallTransport,
      { failureBackoffMs: 30_000 },
    );
    await retryOrchestration.convergeTick();
    await flushAsync();
    const retried = await aiRepo.getAiBundleJob(vpsA);
    expect(retried?.jobId).not.toBe(started.job.jobId);
    expect(retried?.bundleId).toBe(fixture.bundleId);
  });

  it("ignores hosts without any capability report (deliberate-action-only, Q8)", async () => {
    await orchestration.convergeTick();
    await flushAsync();
    expect(await aiRepo.getAiBundleJob(vpsA)).toBeUndefined();
    expect(await aiRepo.getAiBundleJob(vpsB)).toBeUndefined();
  });

  it("creates at most one install job per tick across the fleet", async () => {
    await aiRepo.recordAiCapability(capabilityReport(vpsA));
    await aiRepo.recordAiCapability(capabilityReport(vpsB));
    await orchestration.convergeTick();
    await flushAsync();
    const jobs = [
      await aiRepo.getAiBundleJob(vpsA),
      await aiRepo.getAiBundleJob(vpsB),
    ];
    expect(jobs.filter(Boolean)).toHaveLength(1);
  });
});
