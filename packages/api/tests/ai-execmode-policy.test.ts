import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { parseAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createJsonAiRepository, defaultAiPolicy } from "../src/persistence/repositories/ai.repository.js";
import { readJsonFile, writeJsonFile } from "../src/persistence/repositories/json-file.js";
import type { AiRepository } from "../src/persistence/repositories/ai.persistence.js";
import type { DockerMonitoringRepository } from "../src/persistence/repositories/docker-monitoring.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import { AiRoutesService } from "../src/ai/ai-routes.service.js";
import { AiAgentService } from "../src/ai/ai-agent.service.js";
import { AiPolicyService } from "../src/ai/ai-policy.service.js";
import { hostTools } from "../src/ai/ai-host-plan.service.js";
import { hostClaimSchema } from "../src/ai/ai.schemas.js";
import type { AiCodexOauthService } from "../src/ai/ai-codex-oauth.service.js";
import type { DashboardSessionService } from "../src/auth/dashboard-session.service.js";
import type { AiCapability, AiPolicy } from "../src/ai/ai.models.js";

// Slice 1 (docs/ai-agent-autoupdate-execmode-plan.md): execMode on the policy,
// the one-time privileged acknowledgment, and the privilegedSupported
// capability field. Policy routes run against the real JSON repository.

const request = { dashboardSessionId: "admin-session" } as unknown as Request;

describe("AI policy execMode + privileged acknowledgment", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let routes: AiRoutesService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-execmode-policy-"));
    const keyringFile = join(dir, "ai-keyring.json");
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    const created = await vpsRepo.create({ name: "VPS", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    const parsed = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "ai-execmode-policy-test-secret-0123456789" });
    const config: AppConfig = { ...parsed, ai: { ...parsed.ai, enabled: true, keyringFile } };
    routes = new AiRoutesService(config, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults the projection to sandbox execMode with no acknowledgment", async () => {
    const policy = (await routes.policy(request, vpsId)) as AiPolicy;
    expect(policy.execMode).toBe("sandbox");
    expect(policy.privilegedAcknowledgedAt).toBeNull();
    expect(policy.privilegedAcknowledgedBy).toBeNull();
    expect(defaultAiPolicy("any").execMode).toBe("sandbox");
  });

  it("rejects invalid execMode and acknowledgePrivileged values", async () => {
    await expect(routes.updatePolicy(request, vpsId, { execMode: "root" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(routes.updatePolicy(request, vpsId, { execMode: "privileged", acknowledgePrivileged: "yes" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(routes.updatePolicy(request, vpsId, { acknowledgePrivileged: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a transition to privileged without acknowledgment and keeps the policy sandbox", async () => {
    await expect(routes.updatePolicy(request, vpsId, { execMode: "privileged" })).rejects.toBeInstanceOf(BadRequestException);
    const policy = (await routes.policy(request, vpsId)) as AiPolicy;
    expect(policy.execMode).toBe("sandbox");
    expect(policy.privilegedAcknowledgedAt).toBeNull();
  });

  it("records who/when when acknowledgePrivileged is accepted", async () => {
    const updated = (await routes.updatePolicy(request, vpsId, { execMode: "privileged", acknowledgePrivileged: true })) as AiPolicy;
    expect(updated.execMode).toBe("privileged");
    expect(updated.privilegedAcknowledgedAt).toBeTruthy();
    expect(updated.privilegedAcknowledgedBy).toBe("admin-session");
  });

  it("keeps the acknowledgment when returning to sandbox and re-enables privileged without a new ack", async () => {
    const acked = (await routes.updatePolicy(request, vpsId, { execMode: "privileged", acknowledgePrivileged: true })) as AiPolicy;
    const sandbox = (await routes.updatePolicy(request, vpsId, { execMode: "sandbox" })) as AiPolicy;
    expect(sandbox.execMode).toBe("sandbox");
    expect(sandbox.privilegedAcknowledgedAt).toBe(acked.privilegedAcknowledgedAt);
    expect(sandbox.privilegedAcknowledgedBy).toBe(acked.privilegedAcknowledgedBy);
    const reEnabled = (await routes.updatePolicy(request, vpsId, { execMode: "privileged" })) as AiPolicy;
    expect(reEnabled.execMode).toBe("privileged");
    expect(reEnabled.privilegedAcknowledgedAt).toBe(acked.privilegedAcknowledgedAt);
    expect(reEnabled.privilegedAcknowledgedBy).toBe(acked.privilegedAcknowledgedBy);
  });

  it("refreshes the acknowledgment on an explicit re-ack with the new admin identity", async () => {
    await routes.updatePolicy(request, vpsId, { execMode: "privileged", acknowledgePrivileged: true });
    const secondAdmin = { dashboardSessionId: "admin-session-2" } as unknown as Request;
    const refreshed = (await routes.updatePolicy(secondAdmin, vpsId, { execMode: "privileged", acknowledgePrivileged: true })) as AiPolicy;
    expect(refreshed.privilegedAcknowledgedBy).toBe("admin-session-2");
  });
});

describe("legacy AI policy rows read as sandbox", () => {
  let dir: string;
  let aiFile: string;
  let aiRepo: AiRepository;
  let vpsId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-execmode-legacy-"));
    aiFile = join(dir, "ai.json");
    aiRepo = createJsonAiRepository(aiFile);
    vpsId = "vps-legacy";
    await aiRepo.updateAiPolicy({ vpsId, patch: { shellEnabled: true }, expectedRevision: 0 });
    // Simulate a row persisted before the execMode fields existed.
    const raw = await readJsonFile<{ policies: Record<string, unknown>[] }>(aiFile, { policies: [] });
    delete raw.policies[0]!.execMode;
    delete raw.policies[0]!.privilegedAcknowledgedAt;
    delete raw.policies[0]!.privilegedAcknowledgedBy;
    await writeJsonFile(aiFile, raw);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("normalizes a legacy row to sandbox with null acknowledgment on read", async () => {
    const policy = await aiRepo.getAiPolicy(vpsId);
    expect(policy?.shellEnabled).toBe(true);
    expect(policy?.execMode).toBe("sandbox");
    expect(policy?.privilegedAcknowledgedAt).toBeNull();
    expect(policy?.privilegedAcknowledgedBy).toBeNull();
  });

  it("keeps the sandbox default when a legacy row is updated", async () => {
    const updated = await aiRepo.updateAiPolicy({ vpsId, patch: { shellEnabled: false }, expectedRevision: 1 });
    expect(updated.execMode).toBe("sandbox");
    expect(updated.privilegedAcknowledgedAt).toBeNull();
  });
});

describe("privilegedSupported capability ingestion", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsId: string;
  let config: AppConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-execmode-claim-"));
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsId = "vps-claim";
    const parsed = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "ai-execmode-claim-test-secret-0123456789" });
    config = { ...parsed, ai: { ...parsed.ai, enabled: true, keyringFile: join(dir, "ai-keyring.json") } };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function claimBody(privileged: boolean | undefined) {
    return {
      version: 1 as const,
      agentInstanceId: "agent-claim-1",
      capabilities: {
        supported: false,
        cgroupV2: false,
        namespaces: false,
        seccomp: false,
        rootfsDigest: "a".repeat(64),
        profilesDigest: "b".repeat(64),
        profiles: [],
        ...(privileged === undefined ? {} : { privilegedSupported: privileged }),
      },
    };
  }

  it("accepts privilegedSupported in the claim schema", () => {
    expect(hostClaimSchema.safeParse(claimBody(true)).success).toBe(true);
    // Older agents omit the field entirely — still valid.
    expect(hostClaimSchema.safeParse(claimBody(undefined)).success).toBe(true);
  });

  it("persists privilegedSupported from an agent claim (fail-closed false when absent)", async () => {
    const agent = new AiAgentService(
      aiRepo,
      config,
      {} as unknown as DashboardSessionService,
      {} as unknown as DockerMonitoringRepository,
      new AiPolicyService(config, aiRepo),
    );
    await agent.claim(vpsId, claimBody(true));
    expect((await aiRepo.getAiCapability(vpsId))?.privilegedSupported).toBe(true);

    await agent.claim(vpsId, claimBody(undefined));
    expect((await aiRepo.getAiCapability(vpsId))?.privilegedSupported).toBe(false);
  });

  it("persists privilegedSupported + reason via applyCapabilityReport", async () => {
    const policyService = new AiPolicyService(config, aiRepo);
    const base = {
      supported: true,
      cgroupV2: true,
      namespaces: true,
      seccomp: true,
      rootfsDigest: "a".repeat(64),
      profilesDigest: "b".repeat(64),
      profiles: [],
    };
    const withPrivileged = await policyService.applyCapabilityReport(vpsId, { ...base, privilegedSupported: true, privilegedUnsupportedReason: "helper outdated" }, "1.2.3");
    expect(withPrivileged.privilegedSupported).toBe(true);
    expect(withPrivileged.privilegedUnsupportedReason).toBe("helper outdated");

    const withoutPrivileged = await policyService.applyCapabilityReport(vpsId, base);
    expect(withoutPrivileged.privilegedSupported).toBe(false);
    expect(withoutPrivileged.privilegedUnsupportedReason).toBeUndefined();
  });

  it("returns privilegedSupported false for the missing-capability placeholder", async () => {
    const policyService = new AiPolicyService(config, aiRepo);
    const capability = await policyService.getCapability("vps-no-report");
    expect(capability.privilegedSupported).toBe(false);
  });

  it("keeps isCapabilityFresh strict while isCapabilityReportFresh ignores the supported flag", async () => {
    const policyService = new AiPolicyService(config, aiRepo);
    const capability: AiCapability = {
      vpsId,
      supported: false,
      freshness: new Date().toISOString(),
      protocolVersion: 1,
      cgroupV2Available: false,
      namespacesAvailable: false,
      seccompAvailable: false,
      privilegedSupported: true,
      profiles: [],
    };
    expect(policyService.isCapabilityReportFresh(capability)).toBe(true);
    expect(policyService.isCapabilityFresh(capability)).toBe(false);
  });
});

describe("shell host tool schema", () => {
  it("exposes execMode as an optional string enum for the model", () => {
    const shell = hostTools.find((tool) => tool.function.name === "host_shell");
    expect(shell).toBeDefined();
    const parameters = shell!.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(parameters.properties.execMode).toMatchObject({ type: "string", enum: ["sandbox", "privileged"] });
    expect(parameters.required).toContain("script");
    expect(parameters.required).toContain("timeoutSeconds");
    expect(parameters.required).not.toContain("execMode");
    const fileApply = hostTools.find((tool) => tool.function.name === "host_file_apply");
    const fileParameters = fileApply!.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(fileParameters.properties.execMode).toBeUndefined();
    expect(fileParameters.required).not.toContain("execMode");
  });
});
