import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository } from "../src/persistence/repositories/ai.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { AiCodexOauthService } from "../src/ai/ai-codex-oauth.service.js";
import { AiBundleService } from "../src/ai/ai-bundle.service.js";
import {
  AiBundleOrchestrationService,
  type AiBundleInstallTransport,
  type AiBundleSshAuth,
  type AiBundleView,
} from "../src/ai/ai-bundle-install.service.js";
import { AiRoutesService } from "../src/ai/ai-routes.service.js";
import type { AiPolicy } from "../src/ai/ai.models.js";
import { createHash } from "node:crypto";
import type { AgentRepository } from "../src/persistence/repositories/agent.repository.js";

// Slice 3b (docs/ai-agent-autoupdate-execmode-plan.md): bundled AI artifact
// reader + bundle routes + deliberate-action triggers. Fully offline — the
// SSH transport is a fake and bundle artifacts are temp-file fixtures.

const request = { dashboardSessionId: "admin-session" } as unknown as Request;

type BundleFixture = {
  dir: string;
  files: Record<string, string>;
  manifestDigestAmd64: string;
  manifestDigestArm64: string;
};

async function writeBundleFixture(prefix: string, arches: Array<"amd64" | "arm64"> = ["amd64", "arm64"]): Promise<BundleFixture> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const files: Record<string, string> = {};
  const put = async (name: string, content: string) => {
    const path = join(dir, ...name.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    files[name] = createHash("sha256").update(content).digest("hex");
  };
  await put("install-local-agent.sh", "#!/usr/bin/env bash\necho installer\n");
  await put("installer-lib.sh", "# installer lib\n");
  for (const arch of arches) {
    await put(`ai-executor-linux-${arch}`, `executor-${arch}\n`);
    await put(`ai-host-helper-linux-${arch}`, `helper-${arch}\n`);
    await put(`ai-rootfs-linux-${arch}.tar.gz`, `rootfs-${arch}\n`);
    const manifestContent = `{"arch":"${arch}","files":[]}\n`;
    await put(`ai-rootfs-linux-${arch}.manifest.json`, manifestContent);
  }
  await put("profiles/nginx.json", '{"id":"nginx"}\n');
  return {
    dir,
    files,
    manifestDigestAmd64: files["ai-rootfs-linux-amd64.manifest.json"]!,
    manifestDigestArm64: files["ai-rootfs-linux-arm64.manifest.json"]!,
  };
}

function fakeTransport(overrides: Partial<AiBundleInstallTransport> = {}): AiBundleInstallTransport & { resolveAuthCalls: { vpsId: string }[] } {
  const resolveAuthCalls: { vpsId: string }[] = [];
  const transport = {
    resolveAuthCalls,
    resolveAuth: async (vpsId: string): Promise<AiBundleSshAuth | null> => {
      resolveAuthCalls.push({ vpsId });
      return { privateKey: "fake-key" };
    },
    makeDirectory: async () => {},
    uploadFile: async () => {},
    execCommand: async () => ({ stdout: "", stderr: "" }),
    ...overrides,
  };
  return transport as unknown as AiBundleInstallTransport & { resolveAuthCalls: { vpsId: string }[] };
}

describe("bundled AI directory reader", () => {
  let fixture: BundleFixture;

  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
  });

  it("computes a stable bundleId over sorted {relativePath, sha256} and exposes per-arch artifacts", async () => {
    fixture = await writeBundleFixture("ai-bundle-ok");
    const parsed = parseAppConfig({ APP_MODE: "demo", APP_AI_BUNDLE_DIR: fixture.dir });
    const service = new AiBundleService(parsed);
    const bundle = service.getBundle();
    expect(bundle.available).toBe(true);
    if (!bundle.available) return;
    expect(bundle.bundleId).toMatch(/^[0-9a-f]{64}$/);
    expect(service.getBundle()).toMatchObject({ available: true, bundleId: bundle.bundleId });

    const canonical = JSON.stringify(
      bundle.files
        .map((f) => ({ relativePath: f.relativePath, sha256: f.sha256 }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    );
    expect(bundle.bundleId).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(bundle.arches.amd64?.rootfsDigest).toBe(fixture.manifestDigestAmd64);
    expect(bundle.arches.arm64?.rootfsDigest).toBe(fixture.manifestDigestArm64);
    expect(bundle.profiles.map((p) => p.relativePath)).toEqual(["profiles/nginx.json"]);
    expect(bundle.installerScript.relativePath).toBe("install-local-agent.sh");
    expect(bundle.installerLib?.relativePath).toBe("installer-lib.sh");
  });

  it("reports available=false with a reason when the configured directory is missing", () => {
    const parsed = parseAppConfig({ APP_MODE: "demo", APP_AI_BUNDLE_DIR: join(tmpdir(), "ai-bundle-missing-dir-xyz") });
    const service = new AiBundleService(parsed);
    const bundle = service.getBundle();
    expect(bundle.available).toBe(false);
    if (bundle.available) return;
    expect(bundle.reason).toContain("not found");
  });

  it("reports available=false when a required per-arch artifact is missing", async () => {
    fixture = await writeBundleFixture("ai-bundle-partial");
    await rm(join(fixture.dir, "ai-rootfs-linux-amd64.tar.gz"));
    await rm(join(fixture.dir, "ai-rootfs-linux-arm64.tar.gz"));
    const parsed = parseAppConfig({ APP_MODE: "demo", APP_AI_BUNDLE_DIR: fixture.dir });
    const service = new AiBundleService(parsed);
    const bundle = service.getBundle();
    expect(bundle.available).toBe(false);
    if (bundle.available) return;
    expect(bundle.reason).toContain("incomplete");
    expect(bundle.reason).toContain("ai-rootfs-linux-amd64.tar.gz");
  });
});

describe("GET /api/vps/:id/ai/bundle", () => {
  let dir: string;
  let fixture: BundleFixture;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let agentRepo: AgentRepository;
  let vpsId: string;
  let config: AppConfig;
  let routes: AiRoutesService;

  beforeEach(async () => {
    fixture = await writeBundleFixture("ai-bundle-get");
    dir = await mkdtemp(join(tmpdir(), "ai-bundle-get-state-"));
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    agentRepo = {} as unknown as AgentRepository;
    const created = await vpsRepo.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-bundle-get-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: fixture.dir,
    });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true } };
    const orchestration = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, agentRepo, new AiBundleService(config),
      undefined, fakeTransport(),
    );
    routes = new AiRoutesService(config, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService, orchestration);
  });

  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("exposes the pinned view shape with no job and no capability claim", async () => {
    const view = (await routes.bundle(request, vpsId)) as AiBundleView;
    expect(view).toEqual({
      available: true,
      bundleId: expect.stringMatching(/^[0-9a-f]{64}$/),
      installed: false,
      lastInstalledBundleId: null,
      lastJob: null,
      capability: { supported: false, privilegedSupported: false },
    });
  });

  it("reflects installed state, lastInstalledBundleId and the last job record", async () => {
    const bundle = new AiBundleService(config).getBundle();
    if (!bundle.available) throw new Error("fixture bundle unavailable");
    await aiRepo.recordAiCapability({
      vpsId, supported: true, freshness: new Date().toISOString(), protocolVersion: 1,
      cgroupV2Available: true, namespacesAvailable: true, seccompAvailable: true,
      privilegedSupported: false, profiles: [], reason: "cgroup", agentVersion: "9.9.9",
    });
    const started = await aiRepo.startAiBundleJob({ vpsId, bundleId: bundle.bundleId, trigger: "manual" });
    await aiRepo.finishAiBundleJob({ vpsId, jobId: started.job.jobId, outcome: "failed", error: "installer boom token=abc123" });

    const view = (await routes.bundle(request, vpsId)) as AiBundleView;
    expect(view.installed).toBe(true);
    expect(view.lastInstalledBundleId).toBeNull();
    expect(view.lastJob).toEqual({
      state: "failed",
      error: "installer boom [REDACTED]",
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    });
    expect(view.capability).toEqual({ supported: true, reason: "cgroup", agentVersion: "9.9.9", privilegedSupported: false });
  });

  it("degrades gracefully when the bundle directory is absent", async () => {
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-bundle-get-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: join(tmpdir(), "ai-bundle-absent-xyz"),
    });
    const degradedConfig: AppConfig = { ...parsed, ai: { ...parsed.ai, enabled: true } };
    const orchestration = new AiBundleOrchestrationService(
      degradedConfig, aiRepo, vpsRepo, agentRepo, new AiBundleService(degradedConfig),
      undefined, fakeTransport(),
    );
    const degradedRoutes = new AiRoutesService(degradedConfig, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService, orchestration);
    const view = (await degradedRoutes.bundle(request, vpsId)) as AiBundleView;
    expect(view.available).toBe(false);
    expect(view.reason).toContain("not found");
    expect(view.bundleId).toBeNull();
    expect(view.installed).toBe(false);
    expect(view.lastJob).toBeNull();
  });
});

describe("POST /api/vps/:id/ai/bundle/install idempotency", () => {
  let dir: string;
  let fixture: BundleFixture;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let agentRepo: AgentRepository;
  let vpsId: string;
  let config: AppConfig;
  let transport: ReturnType<typeof fakeTransport>;
  let hangAuthCalls: string[];
  let routes: AiRoutesService;

  beforeEach(async () => {
    fixture = await writeBundleFixture("ai-bundle-post");
    dir = await mkdtemp(join(tmpdir(), "ai-bundle-post-state-"));
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    agentRepo = {} as unknown as AgentRepository;
    const created = await vpsRepo.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-bundle-post-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: fixture.dir,
    });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true } };
    // A transport whose auth resolution never resolves holds the job in
    // pending (in-flight) so idempotency can be observed deterministically.
    hangAuthCalls = [];
    transport = fakeTransport({
      resolveAuth: async (vpsId) => {
        hangAuthCalls.push(vpsId);
        return new Promise(() => {});
      },
    });
    const orchestration = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, agentRepo, new AiBundleService(config),
      undefined, transport,
    );
    routes = new AiRoutesService(config, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService, orchestration);
  });

  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the already-running job without duplicating it", async () => {
    const expectedBundleId = new AiBundleService(config).getBundle();
    if (!expectedBundleId.available) throw new Error("fixture bundle unavailable");
    const first = (await routes.installBundle(request, vpsId)) as AiBundleView;
    expect(first.lastJob?.state).toBe("pending");
    const second = (await routes.installBundle(request, vpsId)) as AiBundleView;
    expect(second.lastJob).toEqual(first.lastJob);
    expect(hangAuthCalls).toHaveLength(1);
    const job = await aiRepo.getAiBundleJob(vpsId);
    expect(job?.bundleId).toBe(expectedBundleId.bundleId);
  });

  it("rejects with 503 and a clear reason when the bundle is unavailable", async () => {
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-bundle-post-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: join(tmpdir(), "ai-bundle-absent-xyz"),
    });
    const degradedConfig: AppConfig = { ...parsed, ai: { ...parsed.ai, enabled: true } };
    const orchestration = new AiBundleOrchestrationService(
      degradedConfig, aiRepo, vpsRepo, agentRepo, new AiBundleService(degradedConfig),
      undefined, transport,
    );
    const degradedRoutes = new AiRoutesService(degradedConfig, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService, orchestration);
    await expect(degradedRoutes.installBundle(request, vpsId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("updatePolicy deliberate-action triggers (Q8)", () => {
  let dir: string;
  let fixture: BundleFixture;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let agentRepo: AgentRepository;
  let vpsId: string;
  let config: AppConfig;
  let routes: AiRoutesService;

  beforeEach(async () => {
    fixture = await writeBundleFixture("ai-bundle-trig");
    dir = await mkdtemp(join(tmpdir(), "ai-bundle-trig-state-"));
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    agentRepo = {} as unknown as AgentRepository;
    const created = await vpsRepo.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "ai-bundle-trig-test-secret-0123456789",
      APP_AI_BUNDLE_DIR: fixture.dir,
    });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true } };
    // resolveAuth returns null -> launched jobs fail fast and are contained.
    const orchestration = new AiBundleOrchestrationService(
      config, aiRepo, vpsRepo, agentRepo, new AiBundleService(config),
      undefined, fakeTransport({ resolveAuth: async () => null }),
    );
    routes = new AiRoutesService(config, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService, orchestration);
  });

  afterEach(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  const scheduledJob = async () => {
    // Fire-and-forget scheduling (microtasks + file lock I/O): poll briefly
    // so parallel test-runner load cannot cause a false negative.
    const deadline = Date.now() + 2_000;
    for (;;) {
      const job = await aiRepo.getAiBundleJob(vpsId);
      if (job) return job;
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const bundledId = (): string => {
    const bundle = new AiBundleService(config).getBundle();
    if (!bundle.available) throw new Error("fixture bundle unavailable");
    return bundle.bundleId;
  };

  it("schedules an install when AI is enabled off->on", async () => {
    await routes.updatePolicy(request, vpsId, { aiEnabled: false });
    expect((await aiRepo.getAiBundleJob(vpsId)) ?? undefined).toBeUndefined();
    await routes.updatePolicy(request, vpsId, { aiEnabled: true });
    const job = await scheduledJob();
    expect(job?.trigger).toBe("deliberate");
    expect(job?.bundleId).toBe(bundledId());
  });

  it("schedules an install when shell is enabled false->true", async () => {
    await routes.updatePolicy(request, vpsId, { shellEnabled: true });
    const job = await scheduledJob();
    expect(job?.trigger).toBe("deliberate");
  });

  it("schedules an install when execMode changes (with acknowledgment)", async () => {
    await routes.updatePolicy(request, vpsId, { execMode: "privileged", acknowledgePrivileged: true });
    const job = await scheduledJob();
    expect(job?.trigger).toBe("deliberate");
  });

  it("does not schedule on unrelated policy edits", async () => {
    await routes.updatePolicy(request, vpsId, { readEnabled: false });
    await routes.updatePolicy(request, vpsId, { sendLogsToProvider: true });
    expect(await aiRepo.getAiBundleJob(vpsId)).toBeUndefined();
  });

  it("does not schedule when the AI worker already reported a capability (installed)", async () => {
    await aiRepo.recordAiCapability({
      vpsId, supported: false, freshness: new Date().toISOString(), protocolVersion: 1,
      cgroupV2Available: false, namespacesAvailable: false, seccompAvailable: false,
      privilegedSupported: false, profiles: [],
    });
    await routes.updatePolicy(request, vpsId, { aiEnabled: true, shellEnabled: true });
    expect(await aiRepo.getAiBundleJob(vpsId)).toBeUndefined();
  });
});
