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
import { hostTools, AiHostPlanService, sha256 } from "../src/ai/ai-host-plan.service.js";
import { hostClaimSchema, updateAiPolicySchema } from "../src/ai/ai.schemas.js";
import { getEffectiveAiPolicy } from "../src/ai/ai-policy.service.js";
import { AiAssistantError } from "../src/ai/ai-failures.js";
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
describe("updateAiPolicySchema executionMode and autoApprove removal", () => {
  it("rejects obsolete autoApprove in strict policy schema", () => {
    const result = updateAiPolicySchema.safeParse({ autoApprove: true });
    expect(result.success).toBe(false);
  });

  it("accepts valid executionMode manual and yolo", () => {
    expect(updateAiPolicySchema.safeParse({ executionMode: "manual" }).success).toBe(true);
    expect(updateAiPolicySchema.safeParse({ executionMode: "yolo" }).success).toBe(true);
    expect(updateAiPolicySchema.safeParse({ executionMode: "auto" }).success).toBe(false);
    expect(updateAiPolicySchema.safeParse({ executionMode: "root" }).success).toBe(false);
  });

  it("accepts acknowledgeYolo boolean and rejects non-boolean", () => {
    expect(updateAiPolicySchema.safeParse({ acknowledgeYolo: true }).success).toBe(true);
    expect(updateAiPolicySchema.safeParse({ acknowledgeYolo: false }).success).toBe(true);
    expect(updateAiPolicySchema.safeParse({ acknowledgeYolo: "yes" }).success).toBe(false);
    expect(updateAiPolicySchema.safeParse({ acknowledgeYolo: 1 }).success).toBe(false);
  });
});

describe("AI policy executionMode + YOLO acknowledgment routes", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let vpsRepo: VpsRepository;
  let vpsId: string;
  let routes: AiRoutesService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-yolo-policy-"));
    const keyringFile = join(dir, "ai-keyring.json");
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    vpsRepo = createVpsStore(join(dir, "vps.json"));
    const created = await vpsRepo.create({ name: "VPS-YOLO", host: "127.0.0.1", port: 22, username: "root" });
    vpsId = created.id;
    const parsed = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "ai-yolo-policy-test-secret-0123456789" });
    const config: AppConfig = { ...parsed, ai: { ...parsed.ai, enabled: true, keyringFile } };
    routes = new AiRoutesService(config, aiRepo, vpsRepo, {} as unknown as AiCodexOauthService);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults the projection to manual executionMode with null YOLO acknowledgment", async () => {
    const policy = (await routes.policy(request, vpsId)) as AiPolicy;
    expect(policy.executionMode).toBe("manual");
    expect(policy.yoloAcknowledgedAt).toBeNull();
    expect(policy.yoloAcknowledgedBy).toBeNull();
    expect(defaultAiPolicy("any").executionMode).toBe("manual");
  });

  it("rejects transition to yolo without acknowledgeYolo and keeps executionMode manual", async () => {
    await expect(routes.updatePolicy(request, vpsId, { executionMode: "yolo" })).rejects.toBeInstanceOf(BadRequestException);
    const policy = (await routes.policy(request, vpsId)) as AiPolicy;
    expect(policy.executionMode).toBe("manual");
    expect(policy.yoloAcknowledgedAt).toBeNull();
  });

  it("records who/when when acknowledgeYolo is accepted without requiring extra privileged toggle", async () => {
    const updated = (await routes.updatePolicy(request, vpsId, { executionMode: "yolo", acknowledgeYolo: true })) as AiPolicy;
    expect(updated.executionMode).toBe("yolo");
    expect(updated.yoloAcknowledgedAt).toBeTruthy();
    expect(updated.yoloAcknowledgedBy).toBe("admin-session");
  });

  it("keeps YOLO acknowledgment when returning to manual and re-enables yolo without a new ack", async () => {
    const acked = (await routes.updatePolicy(request, vpsId, { executionMode: "yolo", acknowledgeYolo: true })) as AiPolicy;
    const manual = (await routes.updatePolicy(request, vpsId, { executionMode: "manual" })) as AiPolicy;
    expect(manual.executionMode).toBe("manual");
    expect(manual.yoloAcknowledgedAt).toBe(acked.yoloAcknowledgedAt);
    expect(manual.yoloAcknowledgedBy).toBe(acked.yoloAcknowledgedBy);
    const reEnabled = (await routes.updatePolicy(request, vpsId, { executionMode: "yolo" })) as AiPolicy;
    expect(reEnabled.executionMode).toBe("yolo");
    expect(reEnabled.yoloAcknowledgedAt).toBe(acked.yoloAcknowledgedAt);
    expect(reEnabled.yoloAcknowledgedBy).toBe(acked.yoloAcknowledgedBy);
  });

  it("refreshes the YOLO acknowledgment on explicit re-ack with the new admin identity", async () => {
    await routes.updatePolicy(request, vpsId, { executionMode: "yolo", acknowledgeYolo: true });
    const secondAdmin = { dashboardSessionId: "admin-session-secondary" } as unknown as Request;
    const refreshed = (await routes.updatePolicy(secondAdmin, vpsId, { executionMode: "yolo", acknowledgeYolo: true })) as AiPolicy;
    expect(refreshed.yoloAcknowledgedBy).toBe("admin-session-secondary");
  });
});

describe("legacy autoApprove fail-closed normalization to manual", () => {
  let dir: string;
  let aiFile: string;
  let aiRepo: AiRepository;
  let vpsId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-legacy-autoapprove-"));
    aiFile = join(dir, "ai.json");
    aiRepo = createJsonAiRepository(aiFile);
    vpsId = "vps-legacy-autoapprove";
    await aiRepo.updateAiPolicy({ vpsId, patch: { shellEnabled: true }, expectedRevision: 0 });
    // Simulate legacy row stored with autoApprove: true and without executionMode
    const raw = await readJsonFile<{ policies: Record<string, unknown>[] }>(aiFile, { policies: [] });
    raw.policies[0]!.autoApprove = true;
    delete raw.policies[0]!.executionMode;
    delete raw.policies[0]!.yoloAcknowledgedAt;
    delete raw.policies[0]!.yoloAcknowledgedBy;
    await writeJsonFile(aiFile, raw);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("normalizes legacy autoApprove: true to executionMode manual on read", async () => {
    const policy = await aiRepo.getAiPolicy(vpsId);
    expect(policy?.executionMode).toBe("manual");
    expect(policy?.yoloAcknowledgedAt).toBeNull();
    expect(policy?.yoloAcknowledgedBy).toBeNull();
  });
});

describe("centralized effective policy resolution (getEffectiveAiPolicy)", () => {
  const basePolicy: AiPolicy = {
    vpsId: "vps-test",
    aiEnabled: true,
    readEnabled: true,
    dockerActionsEnabled: false,
    composeActionsEnabled: false,
    shellEnabled: false,
    execMode: "sandbox",
    privilegedAcknowledgedAt: null,
    privilegedAcknowledgedBy: null,
    executionMode: "manual",
    yoloAcknowledgedAt: null,
    yoloAcknowledgedBy: null,
    fileReadScopes: ["/var/log"],
    fileWriteScopes: ["/tmp"],
    serviceProfileIds: ["nginx"],
    sendLogsToProvider: false,
    sendFilesToProvider: false,
    revision: 1,
    updatedAt: new Date().toISOString(),
  };

  it("manual mode: preserves configured permissions", () => {
    const effective = getEffectiveAiPolicy(basePolicy);
    expect(effective.executionMode).toBe("manual");
    expect(effective.shellEnabled).toBe(false);
    expect(effective.execMode).toBe("sandbox");
    expect(effective.dockerActionsEnabled).toBe(false);
    expect(effective.composeActionsEnabled).toBe(false);
    expect(effective.sendLogsToProvider).toBe(false);
    expect(effective.sendFilesToProvider).toBe(false);
  });

  it("yolo mode: grants full host operations including root shell without extra privileged toggle", () => {
    const yoloPolicy: AiPolicy = {
      ...basePolicy,
      executionMode: "yolo",
      yoloAcknowledgedAt: new Date().toISOString(),
      yoloAcknowledgedBy: "admin",
    };
    const effective = getEffectiveAiPolicy(yoloPolicy);
    expect(effective.executionMode).toBe("yolo");
    expect(effective.shellEnabled).toBe(true);
    expect(effective.execMode).toBe("privileged");
    expect(effective.dockerActionsEnabled).toBe(true);
    expect(effective.composeActionsEnabled).toBe(true);
    expect(effective.readEnabled).toBe(true);
  });

  it("yolo mode: keeps egress strictly independent (never auto-elevates)", () => {
    const yoloPolicy: AiPolicy = {
      ...basePolicy,
      executionMode: "yolo",
      sendLogsToProvider: false,
      sendFilesToProvider: false,
    };
    const effective = getEffectiveAiPolicy(yoloPolicy);
    expect(effective.sendLogsToProvider).toBe(false);
    expect(effective.sendFilesToProvider).toBe(false);
  });

  it("disabled AI remains disabled even with executionMode yolo", () => {
    const disabledYolo: AiPolicy = {
      ...basePolicy,
      aiEnabled: false,
      executionMode: "yolo",
    };
    const effective = getEffectiveAiPolicy(disabledYolo);
    expect(effective.aiEnabled).toBe(false);
    expect(effective.shellEnabled).toBe(false);
    expect(effective.dockerActionsEnabled).toBe(false);
    expect(effective.composeActionsEnabled).toBe(false);
  });
});

describe("AiHostPlanService authorization under YOLO", () => {
  let dir: string;
  let aiRepo: AiRepository;
  let planService: AiHostPlanService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-host-plan-test-"));
    const keyringFile = join(dir, "ai-keyring.json");
    aiRepo = createJsonAiRepository(join(dir, "ai.json"));
    const parsed = parseAppConfig({ APP_MODE: "local", DASHBOARD_SESSION_SECRET: "ai-host-plan-test-secret-0123456789" });
    const config: AppConfig = { ...parsed, ai: { ...parsed.ai, enabled: true, keyringFile } };
    planService = new AiHostPlanService(aiRepo, config);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const yoloPolicy: AiPolicy = {
    vpsId: "vps-yolo",
    aiEnabled: true,
    readEnabled: true,
    dockerActionsEnabled: true,
    composeActionsEnabled: true,
    shellEnabled: false, // in raw policy, shell is false
    execMode: "sandbox", // in raw policy, sandbox
    privilegedAcknowledgedAt: null,
    privilegedAcknowledgedBy: null,
    executionMode: "yolo",
    yoloAcknowledgedAt: "2026-10-27T00:00:00.000Z",
    yoloAcknowledgedBy: "admin",
    fileReadScopes: [],
    fileWriteScopes: [],
    serviceProfileIds: [],
    sendLogsToProvider: false,
    sendFilesToProvider: false,
    revision: 1,
    updatedAt: new Date().toISOString(),
  };

  it("bypasses old scope gates for file operations in YOLO mode", () => {
    const content = "config_value=123\n";
    const digest = sha256(content);
    expect(() => {
      planService.authorize("file_apply", {
        path: "/opt/app/config.ini",
        scope: "/opt/app",
        content,
        postImageDigest: digest,
        expectedPreImageDigest: digest,
        mode: 420,
        createNoReplace: false,
      }, yoloPolicy);
    }).not.toThrow();
  });

  it("strictly enforces trust boundaries on protected paths even in YOLO mode", () => {
    const content = "root:x:0:0:root:/root:/bin/bash\n";
    const digest = sha256(content);
    for (const badPath of ["/etc/shadow", "/etc/sudoers", "/etc/pam.d/su", "/root/.ssh/id_rsa", "/proc/1/mem", "/sys/kernel/security"]) {
      expect(() => {
        planService.authorize("file_apply", {
          path: badPath,
          scope: "/",
          content,
          postImageDigest: digest,
          expectedPreImageDigest: digest,
          mode: 384,
          createNoReplace: false,
        }, yoloPolicy);
      }).toThrow(AiAssistantError);
    }
  });

  it("strictly enforces trust boundaries on protected services even in YOLO mode", () => {
    for (const protectedService of ["flexserver", "postgres", "vps-agent", "sshd"]) {
      expect(() => {
        planService.authorize("service_action", {
          profileId: "system",
          service: protectedService,
          action: "restart",
        }, yoloPolicy);
      }).toThrow(AiAssistantError);
    }
  });

  it("strictly enforces payload validation size caps even in YOLO mode", () => {
    const oversizedScript = "a".repeat(32769);
    expect(() => {
      planService.authorize("shell", {
        script: oversizedScript,
        timeoutSeconds: 30,
        execMode: "privileged",
      }, yoloPolicy);
    }).toThrow(AiAssistantError);
  });
});
