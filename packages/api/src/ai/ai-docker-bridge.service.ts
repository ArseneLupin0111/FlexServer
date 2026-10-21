import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Request } from "express";
import { AI_REPOSITORY, APP_CONFIG, VPS_REPOSITORY, DOCKER_MONITORING_REPOSITORY } from "../tokens.js";
import type { AiRepository } from "../persistence/repositories/ai.persistence.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import type { DockerMonitoringRepository } from "../persistence/repositories/docker-monitoring.repository.js";
import { DockerManagementService } from "../docker/docker-management.service.js";
import { ApplicationsService } from "../docker-applications/applications.service.js";
import { DockerMonitoringService } from "../docker/docker-monitoring.service.js";
import type { DockerManagementAction, DockerManagementOperation, DockerManagementTarget } from "../docker/docker-management.models.js";
import { DockerManagementConflict } from "../docker/docker-management.models.js";
type ApplicationDetail = Awaited<ReturnType<ApplicationsService["detail"]>>;
import type { AiPlan, AiPlanStep, AiPolicy, AiTask } from "./ai.models.js";
import { AiAssistantError } from "./ai-failures.js";
import { encryptAiSecret, loadAiKeyring } from "./ai-crypto.js";
import { sha256 } from "./ai-host-plan.service.js";
import type { ProviderTool } from "./ai-provider.js";

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const PROTECTED_PATTERN = /(^|[\/_\-\.:])(flexserver|vps-manager|vps_manager|vps-agent|vps_agent|host-pty|host-files|postgres)([\/_\-\.:]|$)/i;

export function isProtectedTarget(target: { name?: string; image?: string; projectName?: string; displayName?: string }): boolean {
  if (target.name && PROTECTED_PATTERN.test(target.name)) return true;
  if (target.image && PROTECTED_PATTERN.test(target.image)) return true;
  if (target.projectName && PROTECTED_PATTERN.test(target.projectName)) return true;
  if (target.displayName && PROTECTED_PATTERN.test(target.displayName)) return true;
  return false;
}

export const dockerActionSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  target: z.object({
    containerKey: z.string().min(1).max(256),
    agentInstanceId: z.string().min(1).max(256).optional(),
    name: z.string().max(256).optional(),
  }).strict(),
}).strict();

export const composeActionSchema = z.object({
  appId: z.string().min(1).max(256),
  action: z.enum(["start", "stop", "restart"]),
}).strict();

export const composePreviewSchema = z.object({
  appId: z.string().min(1).max(256),
  composeYaml: z.string().min(1).max(262144),
  variables: z.union([
    z.record(z.string().max(16384)),
    z.object({
      nonSecretValues: z.record(z.string().max(16384)),
      secretNameToggles: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(256).default([]),
    }).strict(),
  ]).optional(),
  profiles: z.array(z.string().max(128)).max(64).default([]),
  oneShotServices: z.array(z.string().max(128)).max(64).default([]),
}).strict();

export const composeDeploySchema = z.object({
  appId: z.string().min(1).max(256),
  previewId: z.string().min(1).max(128),
  removedServiceIds: z.array(z.string().max(128)).max(64).default([]),
}).strict();

export const bridgeTools: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "docker_action",
      description: "Propose a lifecycle action (start, stop, restart) on a Docker container. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["start", "stop", "restart"],
            description: "Lifecycle action to perform on container",
          },
          target: {
            type: "object",
            properties: {
              containerKey: { type: "string", description: "Container key" },
              agentInstanceId: { type: "string", description: "Agent instance ID managing the container" },
            },
            required: ["containerKey"],
            additionalProperties: false,
          },
        },
        required: ["action", "target"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compose_action",
      description: "Propose a lifecycle action (start, stop, restart) on a Docker Compose application. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", description: "Application ID" },
          action: {
            type: "string",
            enum: ["start", "stop", "restart"],
            description: "Lifecycle action to perform on the Compose stack",
          },
        },
        required: ["appId", "action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compose_preview",
      description: "Propose previewing changes to a Docker Compose application configuration.",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", description: "Application ID" },
          composeYaml: { type: "string", description: "Compose YAML configuration" },
          variables: { type: "object", description: "Environment variables" },
          profiles: { type: "array", items: { type: "string" }, description: "Compose profiles" },
        },
        required: ["appId", "composeYaml"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compose_deploy",
      description: "Propose deploying an approved preview for a Docker Compose application.",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", description: "Application ID" },
          previewId: { type: "string", description: "Approved preview ID" },
          removedServiceIds: { type: "array", items: { type: "string" }, description: "Removed service names" },
        },
        required: ["appId", "previewId"],
        additionalProperties: false,
      },
    },
  },
];

export type AiPlanStepProposal = AiPlanStep & {
  step: AiPlanStep;
  preconditions: { key: string; expectedValue: unknown }[];
};

export type ComposePreviewStatus = "pending" | "ready" | "confirmed" | "stale" | "failed";

export type ComposePreviewSummary = {
  id: string;
  appId: string;
  revisionSeq: number;
  status: ComposePreviewStatus;
  generation: number;
  expiresAt: string;
  createdAt: string;
  digest: string;
  removedServices: string[];
  result?: unknown;
  error?: unknown;
  redactedModel?: unknown;
};

@Injectable()
export class AiDockerBridgeService {
  constructor(
    @Inject(AI_REPOSITORY) private readonly repository: AiRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(DockerManagementService) private readonly dockerManagement: DockerManagementService,
    @Inject(ApplicationsService) private readonly applications: ApplicationsService,
    @Inject(DockerMonitoringService) private readonly dockerMonitoring: DockerMonitoringService,
    @Inject(DOCKER_MONITORING_REPOSITORY) private readonly monitoringRepo: DockerMonitoringRepository,
  ) {}

  async propose(
    vpsIdOrTask: string | AiTask,
    tool: string,
    rawArgs: unknown,
    policy: AiPolicy,
    explicitTaskId?: string,
  ): Promise<AiPlanStepProposal> {
    const vpsId = typeof vpsIdOrTask === "string" ? vpsIdOrTask : vpsIdOrTask.vpsId;
    const taskId = typeof vpsIdOrTask === "string" ? explicitTaskId : vpsIdOrTask.id;

    if (!policy.aiEnabled) throw new AiAssistantError("policy_denied", "AI is disabled by policy");

    if (tool === "docker_action") {
      if (!policy.dockerActionsEnabled) {
        throw new AiAssistantError("policy_denied", "Docker actions are disabled by policy");
      }
      const parsed = dockerActionSchema.safeParse(rawArgs);
      if (!parsed.success) throw new AiAssistantError("policy_denied", "Invalid docker_action arguments");

      const vpsRecord = await this.vps.get(vpsId);
      if (!vpsRecord) throw new NotFoundException("VPS not found");
      if (vpsRecord.dockerManagementEnabled !== true) {
        throw new AiAssistantError("policy_denied", "Docker management is disabled on this VPS");
      }

      const containers = await this.dockerMonitoring.currentContainers(vpsId);
      const rawTarget = parsed.data.target;
      let matched = containers.filter(c => c.containerKey === rawTarget.containerKey);

      if (matched.length === 0 && rawTarget.name) {
        matched = containers.filter(c => c.name === rawTarget.name || c.name === `/${rawTarget.name}`);
      }
      if (matched.length === 0) {
        matched = containers.filter(c => c.name === rawTarget.containerKey || c.name === `/${rawTarget.containerKey}`);
      }

      if (matched.length === 0) {
        throw new AiAssistantError("ambiguous_target", `Target container not found: ${rawTarget.containerKey}`);
      }
      if (matched.length > 1) {
        throw new AiAssistantError("ambiguous_target", `Multiple containers match target: ${rawTarget.containerKey}`);
      }

      const target = matched[0];
      if (rawTarget.agentInstanceId && target.agentInstanceId && target.agentInstanceId !== rawTarget.agentInstanceId) {
        throw new AiAssistantError("target_changed", "Container agentInstanceId mismatch");
      }

      if (isProtectedTarget({ name: target.name, image: target.image })) {
        throw new AiAssistantError("protected_target", "Target container is a protected system resource");
      }

      const normalizedTarget: DockerManagementTarget = {
        containerKey: target.containerKey,
        ...(target.agentInstanceId ? { agentInstanceId: target.agentInstanceId } : {}),
      };

      const normalizedArgs = {
        action: parsed.data.action,
        target: normalizedTarget,
      };

      const preconditions = [
        { key: `container:${target.containerKey}:state`, expectedValue: target.state },
        { key: `container:${target.containerKey}:agentInstanceId`, expectedValue: target.agentInstanceId },
      ];

      const resourceKeys = [`docker:container:${target.containerKey}`];
      const stepId = randomUUID();
      const payloadStr = JSON.stringify(normalizedArgs);
      const payloadDigest = sha256(payloadStr);

      let encryptedBlobId: string | undefined;
      if (taskId) {
        encryptedBlobId = randomUUID();
        const keyring = await loadAiKeyring(this.config.ai.keyringFile);
        const encryptedPayload = encryptAiSecret(
          payloadStr,
          { vpsId, taskId, field: "executionPayload", version: 1 },
          keyring,
        );
        await this.repository.saveExecutionBlob({
          id: encryptedBlobId,
          taskId,
          stepId,
          encryptedPayload,
          expiresAt: new Date(Date.now() + 180000).toISOString(),
          createdAt: new Date().toISOString(),
        });
      }

      const step: AiPlanStep = {
        stepId,
        tool,
        version: 1,
        args: normalizedArgs,
        resourceKeys,
        inputDigests: {
          payload: payloadDigest,
          args: payloadDigest,
        },
        description: `${parsed.data.action.toUpperCase()} Docker container ${target.name ?? target.containerKey}`,
        timeoutSeconds: 120,
        ...(encryptedBlobId ? { encryptedBlobId } : {}),
      };

      return {
        ...step,
        step,
        preconditions,
      };
    }

    if (tool === "compose_action") {
      if (!policy.composeActionsEnabled) {
        throw new AiAssistantError("policy_denied", "Compose actions are disabled by policy");
      }
      const parsed = composeActionSchema.safeParse(rawArgs);
      if (!parsed.success) throw new AiAssistantError("policy_denied", "Invalid compose_action arguments");

      let app: ApplicationDetail;
      try {
        app = await this.applications.detail(vpsId, parsed.data.appId);
      } catch {
        throw new AiAssistantError("ambiguous_target", `Compose application not found: ${parsed.data.appId}`);
      }

      if (isProtectedTarget({ projectName: app.projectName, displayName: app.displayName })) {
        throw new AiAssistantError("protected_target", "Compose application is a protected system resource");
      }

      if (app.mode === "unmanaged") {
        throw new AiAssistantError("policy_denied", "Cannot execute lifecycle actions on unmanaged application");
      }

      if (!app.source?.verified) {
        throw new AiAssistantError("policy_denied", "Verified Compose source is required for lifecycle actions");
      }

      const normalizedArgs = {
        appId: app.id,
        action: parsed.data.action,
      };

      const preconditions = [
        { key: `compose:${app.id}:generation`, expectedValue: app.generation },
        { key: `compose:${app.id}:daemonEpoch`, expectedValue: app.daemonEpoch },
        { key: `compose:${app.id}:agentInstanceId`, expectedValue: app.agentInstanceId },
      ];
      const sourceDigest = (app.source && typeof app.source === "object" && "digest" in app.source && typeof (app.source as { digest?: unknown }).digest === "string")
        ? (app.source as { digest: string }).digest
        : undefined;
      if (sourceDigest) {
        preconditions.push({ key: `compose:${app.id}:sourceDigest`, expectedValue: sourceDigest });
      }

      const resourceKeys = [`compose:app:${app.id}`, `compose:project:${app.projectName}`];
      const stepId = randomUUID();
      const payloadStr = JSON.stringify(normalizedArgs);
      const payloadDigest = sha256(payloadStr);

      let encryptedBlobId: string | undefined;
      if (taskId) {
        encryptedBlobId = randomUUID();
        const keyring = await loadAiKeyring(this.config.ai.keyringFile);
        const encryptedPayload = encryptAiSecret(
          payloadStr,
          { vpsId, taskId, field: "executionPayload", version: 1 },
          keyring,
        );
        await this.repository.saveExecutionBlob({
          id: encryptedBlobId,
          taskId,
          stepId,
          encryptedPayload,
          expiresAt: new Date(Date.now() + 180000).toISOString(),
          createdAt: new Date().toISOString(),
        });
      }

      const step: AiPlanStep = {
        stepId,
        tool,
        version: 1,
        args: normalizedArgs,
        resourceKeys,
        inputDigests: {
          payload: payloadDigest,
          args: payloadDigest,
          ...(sourceDigest ? { sourceDigest } : {}),
        },
        description: `${parsed.data.action.toUpperCase()} Compose app ${app.displayName ?? app.projectName}`,
        timeoutSeconds: app.readinessSeconds ?? 300,
        ...(encryptedBlobId ? { encryptedBlobId } : {}),
      };

      return {
        ...step,
        step,
        preconditions,
      };
    }

    if (tool === "compose_preview") {
      if (!policy.composeActionsEnabled) {
        throw new AiAssistantError("policy_denied", "Compose actions are disabled by policy");
      }
      const parsed = composePreviewSchema.safeParse(rawArgs);
      if (!parsed.success) throw new AiAssistantError("policy_denied", "Invalid compose_preview arguments");

      let app: ApplicationDetail;
      try {
        app = await this.applications.detail(vpsId, parsed.data.appId);
      } catch {
        throw new AiAssistantError("ambiguous_target", `Compose application not found: ${parsed.data.appId}`);
      }

      if (isProtectedTarget({ projectName: app.projectName, displayName: app.displayName })) {
        throw new AiAssistantError("protected_target", "Compose application is a protected system resource");
      }

      if (app.mode !== "managed") {
        throw new AiAssistantError("policy_denied", "Managed configuration required for Compose preview");
      }

      const normalizedArgs = parsed.data;
      const preconditions = [
        { key: `compose:${app.id}:generation`, expectedValue: app.generation },
        { key: `compose:${app.id}:daemonEpoch`, expectedValue: app.daemonEpoch },
      ];

      const resourceKeys = [`compose:app:${app.id}`, `compose:project:${app.projectName}`];
      const stepId = randomUUID();
      const payloadStr = JSON.stringify(normalizedArgs);
      const payloadDigest = sha256(payloadStr);

      let encryptedBlobId: string | undefined;
      if (taskId) {
        encryptedBlobId = randomUUID();
        const keyring = await loadAiKeyring(this.config.ai.keyringFile);
        const encryptedPayload = encryptAiSecret(
          payloadStr,
          { vpsId, taskId, field: "executionPayload", version: 1 },
          keyring,
        );
        await this.repository.saveExecutionBlob({
          id: encryptedBlobId,
          taskId,
          stepId,
          encryptedPayload,
          expiresAt: new Date(Date.now() + 180000).toISOString(),
          createdAt: new Date().toISOString(),
        });
      }

      const step: AiPlanStep = {
        stepId,
        tool,
        version: 1,
        args: normalizedArgs,
        resourceKeys,
        inputDigests: {
          payload: payloadDigest,
          args: payloadDigest,
          composeYaml: sha256(parsed.data.composeYaml),
        },
        description: `Preview configuration changes for Compose app ${app.displayName ?? app.projectName}`,
        timeoutSeconds: 120,
        ...(encryptedBlobId ? { encryptedBlobId } : {}),
      };

      return {
        ...step,
        step,
        preconditions,
      };
    }

    if (tool === "compose_deploy") {
      if (!policy.composeActionsEnabled) {
        throw new AiAssistantError("policy_denied", "Compose actions are disabled by policy");
      }
      const parsed = composeDeploySchema.safeParse(rawArgs);
      if (!parsed.success) throw new AiAssistantError("policy_denied", "Invalid compose_deploy arguments");

      let app: ApplicationDetail;
      try {
        app = await this.applications.detail(vpsId, parsed.data.appId);
      } catch {
        throw new AiAssistantError("ambiguous_target", `Compose application not found: ${parsed.data.appId}`);
      }

      if (isProtectedTarget({ projectName: app.projectName, displayName: app.displayName })) {
        throw new AiAssistantError("protected_target", "Compose application is a protected system resource");
      }

      let preview: unknown;
      try {
        preview = await this.applications.previewDetail(vpsId, app.id, parsed.data.previewId);
      } catch {
        throw new AiAssistantError("stale_plan", `Compose preview not found: ${parsed.data.previewId}`);
      }

      const previewStatus = preview && typeof preview === "object" && "status" in preview && typeof preview.status === "string" ? preview.status : undefined;
      const previewDigest = preview && typeof preview === "object" && "digest" in preview && typeof preview.digest === "string" ? preview.digest : undefined;

      if (previewStatus !== "ready" && previewStatus !== "confirmed") {
        throw new AiAssistantError("stale_plan", `Preview is not ready (status: ${previewStatus ?? "unknown"})`);
      }
      if (!previewDigest) {
        throw new AiAssistantError("stale_plan", "Preview digest is missing");
      }
      const normalizedArgs = parsed.data;
      const preconditions = [
        { key: `compose:${app.id}:preview:${parsed.data.previewId}:digest`, expectedValue: previewDigest },
        { key: `compose:${app.id}:generation`, expectedValue: app.generation },
        { key: `compose:${app.id}:daemonEpoch`, expectedValue: app.daemonEpoch },
      ];

      const resourceKeys = [`compose:app:${app.id}`, `compose:project:${app.projectName}`];
      const stepId = randomUUID();
      const payloadStr = JSON.stringify(normalizedArgs);
      const payloadDigest = sha256(payloadStr);

      let encryptedBlobId: string | undefined;
      if (taskId) {
        encryptedBlobId = randomUUID();
        const keyring = await loadAiKeyring(this.config.ai.keyringFile);
        const encryptedPayload = encryptAiSecret(
          payloadStr,
          { vpsId, taskId, field: "executionPayload", version: 1 },
          keyring,
        );
        await this.repository.saveExecutionBlob({
          id: encryptedBlobId,
          taskId,
          stepId,
          encryptedPayload,
          expiresAt: new Date(Date.now() + 180000).toISOString(),
          createdAt: new Date().toISOString(),
        });
      }

      const step: AiPlanStep = {
        stepId,
        tool,
        version: 1,
        args: normalizedArgs,
        resourceKeys,
        inputDigests: {
          payload: payloadDigest,
          args: payloadDigest,
          previewDigest: previewDigest,
        },
        description: `Deploy preview ${parsed.data.previewId} for Compose app ${app.displayName ?? app.projectName}`,
        timeoutSeconds: app.readinessSeconds ?? 300,
        ...(encryptedBlobId ? { encryptedBlobId } : {}),
      };

      return {
        ...step,
        step,
        preconditions,
      };
    }

    throw new AiAssistantError("policy_denied", `Unsupported bridge tool: ${tool}`);
  }

  async execute(
    vpsId: string,
    step: AiPlanStep,
    plan: AiPlan,
    request?: Request,
  ): Promise<{ ok: boolean; result: unknown }> {
    if (plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now()) {
      throw new AiAssistantError("approval_expired", "Plan approval has expired");
    }
    if (plan.status !== "approved" && plan.status !== "consumed") {
      throw new AiAssistantError("stale_plan", "Plan has not been approved");
    }
    if (plan.vpsId !== vpsId) {
      throw new AiAssistantError("policy_denied", "VPS mismatch");
    }

    for (const cond of plan.preconditions ?? []) {
      if (cond.key.startsWith("container:")) {
        const parts = cond.key.split(":");
        const containerKey = parts[1];
        const field = parts[2];
        const containers = await this.dockerMonitoring.currentContainers(vpsId);
        const live = containers.find(c => c.containerKey === containerKey);
        if (!live) {
          throw new AiAssistantError("target_changed", `Container ${containerKey} no longer exists`);
        }
        if (field === "state" && live.state !== cond.expectedValue) {
          throw new AiAssistantError("target_changed", `Container state drifted: expected ${cond.expectedValue}, found ${live.state}`);
        }
        if (field === "agentInstanceId" && live.agentInstanceId !== cond.expectedValue) {
          throw new AiAssistantError("target_changed", "Container agentInstanceId drifted");
        }
      } else if (cond.key.startsWith("compose:")) {
        const parts = cond.key.split(":");
        const appId = parts[1];
        const liveApp = await this.applications.detail(vpsId, appId);
        if (parts[2] === "generation" && liveApp.generation !== cond.expectedValue) {
          throw new AiAssistantError("target_changed", `Application generation drifted: expected ${cond.expectedValue}, found ${liveApp.generation}`);
        }
        if (parts[2] === "daemonEpoch" && liveApp.daemonEpoch !== cond.expectedValue) {
          throw new AiAssistantError("target_changed", "Application daemonEpoch drifted");
        }
        if (parts[2] === "agentInstanceId" && liveApp.agentInstanceId !== cond.expectedValue) {
          throw new AiAssistantError("target_changed", "Application agentInstanceId drifted");
        }
        const liveSourceDigest = (liveApp.source && typeof liveApp.source === "object" && "digest" in liveApp.source && typeof (liveApp.source as { digest?: unknown }).digest === "string")
          ? (liveApp.source as { digest: string }).digest
          : undefined;
        if (parts[2] === "sourceDigest" && liveSourceDigest !== cond.expectedValue) {
          throw new AiAssistantError("target_changed", "Application source digest drifted");
        }
        if (parts[2] === "preview" && parts[4] === "digest") {
          const previewId = parts[3];
          const livePreview = await this.applications.previewDetail(vpsId, appId, previewId);
          const liveDigest = livePreview && typeof livePreview === "object" && "digest" in livePreview && typeof livePreview.digest === "string" ? livePreview.digest : undefined;
          if (liveDigest !== cond.expectedValue) {
            throw new AiAssistantError("target_changed", "Preview digest drifted");
          }
        }
      }
    }

    if (step.tool === "docker_action") {
      const action = step.args.action as DockerManagementAction;
      const target = step.args.target as DockerManagementTarget;

      if (isProtectedTarget({ name: target.containerKey })) {
        throw new AiAssistantError("protected_target", "Target container is protected");
      }

      const idempotencyKey = `ai-step-${step.stepId}`;
      let operation: DockerManagementOperation;
      try {
        operation = await this.dockerManagement.create(vpsId, {
          action,
          target,
          idempotencyKey,
          confirmedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof ConflictException) {
          if (err.message === "container_busy" || err.message === "operation_target_conflict") {
            throw new AiAssistantError("task_busy", err.message);
          }
          throw new AiAssistantError("target_changed", err.message);
        }
        if (err instanceof ForbiddenException) {
          throw new AiAssistantError("policy_denied", err.message);
        }
        if (err instanceof DockerManagementConflict) {
          throw new AiAssistantError("stale_plan", err.reason);
        }
        throw err;
      }

      const timeoutMs = (step.timeoutSeconds ? Math.min(step.timeoutSeconds, 120) : 120) * 1000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = await this.dockerManagement.get(vpsId, operation.id);
        if (current.status === "succeeded") {
          return { ok: true, result: current.result ?? { ok: true } };
        }
        if (current.status === "failed") {
          return {
            ok: false,
            result: current.result ?? { ok: false, message: current.cancelReason ?? "Docker operation failed" },
          };
        }
        if (current.status === "cancelled") {
          throw new AiAssistantError("uncertain_outcome", "Docker operation was cancelled");
        }
        await sleep(500);
      }

      throw new AiAssistantError("uncertain_outcome", "Timed out observing Docker operation completion");
    }

    if (step.tool === "compose_action") {
      const appId = String(step.args.appId);
      const action = String(step.args.action);

      const app = await this.applications.detail(vpsId, appId);
      if (isProtectedTarget({ projectName: app.projectName, displayName: app.displayName })) {
        throw new AiAssistantError("protected_target", "Application is protected");
      }

      const kind = `lifecycle_${action}`;
      const idempotencyKey = `ai-step-${step.stepId}`;
      let workOp: { id: string };
      try {
        workOp = await this.applications.work(vpsId, appId, kind, {
          confirmation: { confirmed: true },
          idempotencyKey,
          actor: {
            kind: "ai",
            id: request?.dashboardSessionId ?? plan.approvedSessionId ?? "ai_assistant",
          },
        });
      } catch (err) {
        if (err instanceof ConflictException) {
          if (err.message === "application_busy" || err.message === "container_operation_busy") {
            throw new AiAssistantError("task_busy", err.message);
          }
          if (err.message === "identity_changed" || err.message === "source_changed") {
            throw new AiAssistantError("target_changed", err.message);
          }
          throw new AiAssistantError("stale_plan", err.message);
        }
        if (err instanceof ForbiddenException) {
          throw new AiAssistantError("policy_denied", err.message);
        }
        throw err;
      }

      const timeoutMs = (step.timeoutSeconds ? Math.min(step.timeoutSeconds, 300) : 300) * 1000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = await this.applications.operation(vpsId, appId, workOp.id);
        if (current.status === "succeeded") {
          return { ok: true, result: current };
        }
        if (current.status === "uncertain") {
          throw new AiAssistantError("uncertain_outcome", "Compose operation outcome is uncertain");
        }
        if (current.status === "failed") {
          return { ok: false, result: current };
        }
        if (current.status === "cancelled") {
          throw new AiAssistantError("uncertain_outcome", "Compose operation was cancelled");
        }
        await sleep(1000);
      }

      throw new AiAssistantError("uncertain_outcome", "Timed out observing Compose operation completion");
    }

    if (step.tool === "compose_preview") {
      const appId = String(step.args.appId);
      const app = await this.applications.detail(vpsId, appId);
      if (isProtectedTarget({ projectName: app.projectName, displayName: app.displayName })) {
        throw new AiAssistantError("protected_target", "Application is protected");
      }

      const idempotencyKey = `ai-step-${step.stepId}`;
      const previewResult = await this.applications.preview(vpsId, appId, {
        confirmation: { confirmed: true },
        idempotencyKey,
        composeYaml: String(step.args.composeYaml ?? ""),
        variables: typeof step.args.variables === "object" && step.args.variables ? (step.args.variables as Record<string, unknown>) : undefined,
        profiles: Array.isArray(step.args.profiles) ? (step.args.profiles as string[]) : [],
        oneShotServices: Array.isArray(step.args.oneShotServices) ? (step.args.oneShotServices as string[]) : [],
        actor: {
          kind: "ai",
          id: request?.dashboardSessionId ?? plan.approvedSessionId ?? "ai_assistant",
        },
      });

      return { ok: true, result: previewResult };
    }

    if (step.tool === "compose_deploy") {
      const appId = String(step.args.appId);
      const previewId = String(step.args.previewId);
      const removedServiceIds = (step.args.removedServiceIds as string[] | undefined) ?? [];

      const app = await this.applications.detail(vpsId, appId);
      if (isProtectedTarget({ projectName: app.projectName, displayName: app.displayName })) {
        throw new AiAssistantError("protected_target", "Application is protected");
      }

      const previewRaw = await this.applications.previewDetail(vpsId, appId, previewId);
      const previewDigest = previewRaw && typeof previewRaw === "object" && "digest" in previewRaw && typeof previewRaw.digest === "string" ? previewRaw.digest : "";
      const idempotencyKey = `ai-step-${step.stepId}`;

      let deployOp: { id: string };
      try {
        deployOp = await this.applications.confirmPreview(vpsId, appId, previewId, {
          confirmation: { confirmed: true },
          idempotencyKey,
          approvedDigest: previewDigest,
          removedServiceIds,
          actor: {
            kind: "ai",
            id: request?.dashboardSessionId ?? plan.approvedSessionId ?? "ai_assistant",
          },
        });
      } catch (err) {
        if (err instanceof ConflictException) {
          if (err.message === "application_busy") throw new AiAssistantError("task_busy", err.message);
          if (err.message === "stale_preview" || err.message === "removed_services_confirmation_mismatch") {
            throw new AiAssistantError("stale_plan", err.message);
          }
          throw new AiAssistantError("target_changed", err.message);
        }
        if (err instanceof ForbiddenException) throw new AiAssistantError("policy_denied", err.message);
        throw err;
      }

      const timeoutMs = (step.timeoutSeconds ? Math.min(step.timeoutSeconds, 300) : 300) * 1000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = await this.applications.operation(vpsId, appId, deployOp.id);
        if (current.status === "succeeded") {
          return { ok: true, result: current };
        }
        if (current.status === "uncertain") {
          throw new AiAssistantError("uncertain_outcome", "Compose deployment outcome is uncertain");
        }
        if (current.status === "failed") {
          return { ok: false, result: current };
        }
        if (current.status === "cancelled") {
          throw new AiAssistantError("uncertain_outcome", "Compose deployment was cancelled");
        }
        await sleep(1000);
      }

      throw new AiAssistantError("uncertain_outcome", "Timed out observing Compose deployment completion");
    }

    throw new AiAssistantError("policy_denied", `Unsupported bridge execution tool: ${step.tool}`);
  }
}
