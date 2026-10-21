import { Injectable, Inject, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { AGENT_REPOSITORY, APP_CONFIG, VPS_REPOSITORY } from "../tokens.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { AppConfig } from "../config/app-config.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import { deriveAgentStatus } from "../vps/vps.models.js";
import type { ApplicationsRepository, ApplicationsState, AppRow, WorkRow, PreviewRow, OperationAuthorization } from "../persistence/repositories/applications.repository.js";
import { APPLICATIONS_INVENTORY_REPOSITORY } from "./inventory.controller.js";
import type { ApplicationsInventoryRepository } from "../persistence/repositories/applications-inventory.repository.js";
import type { StoredApplicationsInventory } from "./inventory.schemas.js";
import type { ComposeEnvelopeData } from "../crypto/secret-envelope.js";
import type { Keyring } from "../ssh/key-encryption.js";
import { encryptComposeField, decryptComposeField, loadComposeKeyring } from "../crypto/secret-envelope.js";
import { validateComposeYaml } from "./config-policy.js";
import { z } from "zod";

export const APPLICATIONS_REPOSITORY = Symbol("APPLICATIONS_REPOSITORY");
const registryCredentialIdentity = (name: string): { host: string; username: string } => {
  const [host, username] = JSON.parse(name) as [string, string];
  return { host, username };
};
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function computeProjectRuntimeFingerprint(inv: StoredApplicationsInventory | undefined, projectName: string): string {
  const project = inv?.projects.find(p => p.project === projectName);
  if (!project) return createHash("sha256").update("[]").digest("hex");
  const rows: { containerKey: string; project: string; service: string; slot: number; state: string; health: string }[] = [];
  for (const s of project.services) {
    for (const r of s.replicas) {
      rows.push({
        containerKey: r.containerKey,
        project: project.project,
        service: s.service,
        slot: r.slot,
        state: r.state,
        health: r.health ?? "",
      });
    }
  }
  rows.sort((a, b) => (a.containerKey < b.containerKey ? -1 : a.containerKey > b.containerKey ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const terminalOp = (op: WorkRow) => ["succeeded", "failed", "cancelled"].includes(op.status);

/** Confirmation + idempotency envelope required by every mutating dashboard call. */
/** Optional durable actor stamp for operation history attribution. */
const actor = z.object({ kind: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), id: z.string().regex(/^[A-Za-z0-9_.~:-]{0,255}$/).optional() }).strict().optional();

export const confirmation = z
  .object({
    confirmation: z.object({ confirmed: z.literal(true) }).strict(),
    idempotencyKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9._~-]+$/),
    actor,
  })
  .strict();

/** Durable container-scope reservation shared with legacy container management. */
export type ContainerScope = { agentInstanceId: string; containerKey: string };

export type ClaimWork = {
  operationId: string;
  kind: string;
  vpsId: string;
  app: { id: string; project: string; daemonEpoch: string; generation: number; mode: string; source?: Record<string, unknown> };
  revision?: { seq: number; composeYaml: string; variables: Record<string, string>; profiles: string[]; oneShotServices?: string[] };
  sourcePath?: string;
  oneShotServices?: string[];
  secrets?: { name: string; version: number; value: string }[];
  registryCredentials?: { id: string; host: string; username: string; value: string; version: number }[];
  runtimePrep?: { pluginRequired: boolean };
  approvedDigest?: string;
  approvedPreview?: { digest: string; canonicalModelJson: string; redactedModel: Record<string, unknown>; imageDigests: Record<string, string>; removedServiceIds: string[]; removals?: { serviceName: string; containerKeys: string[] }[]; ownershipBinding?: { agentInstanceId: string; daemonEpoch: string; projectName: string }; inventoryFingerprint?: string; observedFingerprint: string; secretVersions: Record<string, number>; credentialVersions: Record<string, number>; revisionSeq: number };
  stages: string[];
  readinessSeconds: number;
  pullTimeoutSeconds: number;
  stopGraceSeconds: number;
  claimToken: string;
  adoptionOwnership?: { agentInstanceId: string; daemonEpoch: string; projectName: string; containers: { containerKey: string; service: string }[] };
  lifecyclePlan?: { action: "start" | "stop" | "restart"; sourcePath: string; sourceDigest: string; services: { name: string; kind: "longlived" | "oneshot"; dependsOn: string[]; condition: "started" | "healthy" | "completed"; dependencyConditions?: Record<string, "started" | "healthy" | "completed">; selected: boolean; desiredCount: number | null; replicas: { containerKey: string; state: string; health?: string; oneShotStatus: "never_started" | "running" | "succeeded" | "failed" }[] }[]; order: string[]; observedFingerprint: string };
};

const lifecycleStages = ["preflight", "apply", "observe"];
const deployStages = ["preflight", "pull", "apply", "observe"];

/** Claim lease: an agent holds a claim this long without progress before another may take over. */
const CLAIM_LEASE_SECONDS = 120;

type PreviewResolution = {
  digest: string;
  canonicalModel: Record<string, unknown>;
  canonicalModelJson: string;
  removals?: { serviceName: string; containerKeys: string[] }[];
  ownershipBinding?: { agentInstanceId: string; daemonEpoch: string; projectName: string };
  inventoryFingerprint?: string;
  redactedModel: Record<string, unknown>;
  imageDigests: Record<string, string>;
  removedServiceIds: string[];
  observedFingerprint: string;
  secretVersions: Record<string, number>;
  credentialVersions?: Record<string, number>;
  revisionSeq: number;
};

interface Receipt {
  status: "succeeded" | "failed" | "uncertain";
  executed: boolean;
  observed?: Record<string, unknown>[];
  error?: string;
}

/** Service implementing the full Compose phase-2 wire contract. */
@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VPS_REPOSITORY) private readonly vps: VpsRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(APPLICATIONS_REPOSITORY) private readonly repo: ApplicationsRepository,
    @Inject(APPLICATIONS_INVENTORY_REPOSITORY) private readonly inventories: ApplicationsInventoryRepository,
  ) {}

  async onApplicationShutdown() { await this.repo.close(); }

  private async gate(vpsId: string, fresh = false) {
    if (this.config.mode === "demo") throw new ForbiddenException("demo_disabled");
    const vps = await this.vps.get(vpsId);
    if (!vps) throw new NotFoundException("VPS not found");
    if (!vps.composeManagementEnabled) throw new ForbiddenException("compose_management_disabled");
    const inv = await this.inventories.current(vpsId);
    if (fresh) {
      const agentState = await this.agents.getState(vpsId);
      const agentStatus = agentState ? deriveAgentStatus(agentState.status, agentState.lastSeenAt) : undefined;
      if (!inv || !inv.completeness || Date.now() - Date.parse(inv.collectedAt) > 60_000 || agentStatus !== "online") {
        throw new ServiceUnavailableException("fresh_connected_inventory_required");
      }
    }
    return inv;
  }

  private app(state: ApplicationsState, vpsId: string, appId: string) {
    const app = state.applications.find(a => a.id === appId && a.vpsId === vpsId);
    if (!app) throw new NotFoundException("Application not found");
    return app;
  }

  private idle(state: ApplicationsState, appId: string): boolean {
    for (const op of state.operations) if (op.appId === appId && !terminalOp(op)) throw new ConflictException("application_busy");
    return true;
  }

  private assertContainerFree(state: ApplicationsState, vpsId: string, app: AppRow, inv?: StoredApplicationsInventory) {
    const members = inv?.projects.find(p => p.project === app.projectName)?.services.flatMap(s => s.replicas.map(r => r.containerKey)) ?? [];
    for (const c of state.containerContentions) {
      if (c.vpsId !== vpsId || c.agentInstanceId !== app.agentInstanceId) continue;
      if (members.includes(c.containerKey)) throw new ConflictException("container_operation_busy");
    }
  }

  /** Legacy reverse exclusion: a second registration bound to the same durable project must not run while one is active. */
  private assertProjectFree(state: ApplicationsState, app: AppRow) {
    for (const other of state.applications) {
      if (other.id === app.id) continue;
      if (other.ownerManifest && other.ownerManifest.projectName === app.projectName && other.ownerManifest.agentInstanceId === app.agentInstanceId && other.ownerManifest.daemonEpoch === app.daemonEpoch && state.operations.some(o => o.appId === other.id && !terminalOp(o))) throw new ConflictException("application_busy");
    }
  }

  /** Durable ownership binding: exact project identity on the daemon. */
  private bindOwnerManifest(app: AppRow, options: { adoptedFromSourcePath?: string; adoptedFromSourceDigest?: string } = {}) {
    app.ownerManifest = { agentInstanceId: app.agentInstanceId, daemonEpoch: app.daemonEpoch, projectName: app.projectName, ...options };
  }

  private claimStillHeld(op: WorkRow, instance: string) {
    if (op.claimedBy !== instance) return false;
    if (op.claimLeaseExpiresAt !== undefined) return Date.parse(op.claimLeaseExpiresAt) > Date.now();
    return true; // claim without a recorded lease never expires mid-flight
  }

  async reserveContainer(vpsId: string, target: ContainerScope, operationId: string) {
    return this.repo.transaction(state => {
      for (const c of state.containerContentions) {
        if (c.vpsId !== vpsId) continue;
        const sameOperation = c.operationId === operationId;
        if (sameOperation) {
          if (c.agentInstanceId !== target.agentInstanceId || c.containerKey !== target.containerKey) throw new ConflictException("operation_target_conflict");
          return;
        }
        if (c.agentInstanceId === target.agentInstanceId && c.containerKey === target.containerKey) throw new ConflictException("container_busy");
      }
      state.containerContentions.push({ vpsId, ...target, operationId, createdAt: now() });
    });
  }

  async releaseContainer(vpsId: string, operationId: string) {
    return this.repo.transaction(state => { state.containerContentions = state.containerContentions.filter(c => !(c.vpsId === vpsId && c.operationId === operationId)); });
  }

  async assertVpsRemovable(vpsId: string) {
    await this.repo.transaction(state => {
      if (state.applications.some(a => a.vpsId === vpsId)) throw new ConflictException("applications_present");
      if (state.operations.some(o => o.vpsId === vpsId && !terminalOp(o))) throw new ConflictException("operations_active");
      if (state.containerContentions.some(c => c.vpsId === vpsId)) throw new ConflictException("container_reservations_active");
    });
  }

  async purgeVps(vpsId: string) {
    await this.assertVpsRemovable(vpsId);
    await this.repo.transaction(state => {
      state.containerContentions = state.containerContentions.filter(c => c.vpsId !== vpsId);
      state.applications = state.applications.filter(a => a.vpsId !== vpsId);
      state.operations = state.operations.filter(o => o.vpsId !== vpsId);
    });
  }

  async create(vpsId: string, body: unknown) {
    const input = confirmation.extend({ displayName: z.string().trim().min(1).max(120), detectedProjectName: z.string().max(128).optional(), daemonEpoch: z.string().max(32).optional() }).strict().parse(body);
    const inv = await this.gate(vpsId, true);
    return this.repo.transaction(state => {
      if (state.applications.some(a => a.vpsId === vpsId && a.displayName === input.displayName)) throw new ConflictException("application_exists");
      const project = input.detectedProjectName ? inv?.projects.find(p => p.project === input.detectedProjectName) : undefined;
      if (input.detectedProjectName && (!project || String(inv?.daemonEpoch) !== input.daemonEpoch)) throw new ConflictException("project_identity_changed");
      // Atomic unique durable project registration: one application may bind a
      // given (vps, epoch, project) tuple — checked in the same transaction that
      // inserts so two creators cannot both bind the same detected project.
      if (project) {
        const binding = `${vpsId}\u0000${String(inv?.daemonEpoch)}\u0000${project.project}`;
        for (const other of state.applications.filter(a => a.vpsId === vpsId)) {
          const otherBinding = `${other.vpsId}\u0000${other.ownerManifest?.daemonEpoch ?? other.daemonEpoch}\u0000${other.ownerManifest?.projectName ?? other.projectName}`;
          if (otherBinding === binding) throw new ConflictException("project_already_registered");
        }
      }
      const appId = project ? createHash("sha256").update(JSON.stringify([vpsId, String(inv!.daemonEpoch), project.project])).digest("hex").slice(0, 16) : createHash("sha256").update(JSON.stringify([vpsId, input.displayName, "managed"])).digest("hex").slice(0, 16);
      const app: AppRow = { id: appId, vpsId, displayName: input.displayName, projectName: project?.project ?? `fs_${appId}`, daemonEpoch: String(inv!.daemonEpoch), agentInstanceId: inv!.agentInstanceId, mode: project ? "detected_readonly" : "managed", generation: 1, createdAt: now(), updatedAt: now() };
      if (project) this.bindOwnerManifest(app);
      state.applications.push(app);
      return app;
    });
  }

    async detail(vpsId: string, appId: string) {
    const vps = await this.vps.get(vpsId);
    if (!vps) throw new NotFoundException("VPS not found");
    const inv = await this.inventories.current(vpsId);
    const ageSeconds = inv ? Math.max(0, Math.floor((Date.now() - Date.parse(inv.collectedAt)) / 1000)) : undefined;

    return this.repo.transaction(state => {
      const app = state.applications.find(a => a.id === appId && a.vpsId === vpsId);
      if (app) {
        const p = inv?.projects.find(x => x.project === app.projectName);
        const ownerManifest = app.ownerManifest ? { projectName: app.ownerManifest.projectName, agentInstanceId: app.ownerManifest.agentInstanceId, daemonEpoch: app.ownerManifest.daemonEpoch } : undefined;
        return {
          ...app,
          appId: app.id,
          readinessSeconds: app.readinessSeconds ?? 300,
          ownerManifest,
          inventoryFreshnessSeconds: ageSeconds,
          observed: {
            services: (p?.services ?? []).map(s => ({
              service: s.service,
              kind: s.isOneoff ? "oneshot" : "longlived",
              replicas: s.replicas.map(r => ({ containerKey: r.containerKey, slot: r.slot, state: r.state, status: r.status, health: r.health })),
              desiredCount: null,
            })),
            updatedAt: inv?.collectedAt,
          },
          secrets: state.secrets.filter(s => s.appId === appId).map(({ name, version, updatedAt }) => ({ name, version, updatedAt })),
          revisions: state.revisions.filter(r => r.appId === appId).map(({ seq, profiles, oneShotServices, createdAt }) => ({ seq, profiles, oneShotServices, createdAt })),
          operations: state.operations.filter(o => o.appId === appId).slice(-100).reverse().map(o => this.publicOperation(o)),
        };
      }

      let matchingProject = (inv?.projects ?? []).find(p => {
        const detId = createHash("sha256").update(JSON.stringify([vpsId, String(inv?.daemonEpoch), p.project])).digest("hex").slice(0, 16);
        return detId === appId;
      });

      if (!matchingProject && appId.startsWith("detected_")) {
        try {
          const raw = Buffer.from(appId.slice("detected_".length), "base64url").toString("utf8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length >= 3) {
            matchingProject = (inv?.projects ?? []).find(p => p.project === parsed[2]);
          }
        } catch {}
      }

      if (matchingProject) {
        return {
          id: appId,
          appId,
          vpsId,
          displayName: matchingProject.project,
          projectName: matchingProject.project,
          daemonEpoch: String(inv?.daemonEpoch),
          agentInstanceId: inv?.agentInstanceId ?? "",
          mode: "detected_readonly" as const,
          generation: 0,
          readinessSeconds: 300,
          inventoryFreshnessSeconds: ageSeconds,
          source: undefined,
          ownerManifest: undefined,
          secrets: [],
          revisions: [],
          operations: [],
          observed: {
            services: matchingProject.services.map(s => ({
              service: s.service,
              kind: s.isOneoff ? "oneshot" : "longlived",
              replicas: s.replicas.map(r => ({ containerKey: r.containerKey, slot: r.slot, state: r.state, status: r.status, health: r.health })),
              desiredCount: null,
            })),
            updatedAt: inv?.collectedAt,
          },
          createdAt: inv?.collectedAt ?? now(),
          updatedAt: inv?.collectedAt ?? now(),
        };
      }

      throw new NotFoundException("Application not found");
    });
  }

  async secrets(vpsId: string, appId: string, body?: unknown) {
    if (body === undefined) return (await this.detail(vpsId, appId)).secrets;
    await this.gate(vpsId);
    const input = confirmation.extend({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), value: z.string().max(16_384) }).strict().parse(body);
    const keys = await loadComposeKeyring(this.config.composeCrypto.keyringFile);
    const liveInventory = await this.inventories.current(vpsId);
    return this.repo.transaction(state => {
      this.app(state, vpsId, appId);
      this.idle(state, appId);
      const previous = state.secrets.find(s => s.appId === appId && s.name === input.name);
      const version = (previous?.version ?? 0) + 1;
      const row = { id: previous?.id ?? createHash("sha256").update(JSON.stringify([vpsId, appId, input.name])).digest("hex").slice(0, 16), vpsId, appId, name: input.name, version, envelope: encryptComposeField(input.value, { vpsId, appId, field: "secret", version: `${input.name}:${version}` }, keys), updatedAt: now() };
      if (previous) Object.assign(previous, row); else state.secrets.push(row);
      for (const preview of state.previews) if (preview.appId === appId && preview.status === "pending") preview.status = "stale";
      return { name: row.name, version, updatedAt: row.updatedAt };
    });
  }

  async preview(vpsId: string, appId: string, body: unknown) {
    await this.gate(vpsId, true);
    const input = confirmation.extend({ composeYaml: z.string().max(262_144), revisionSeq: z.number().int().positive().optional(), variables: z.union([z.record(z.string().max(16_384)), z.object({ nonSecretValues: z.record(z.string().max(16_384)), secretNameToggles: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(256).default([]) }).strict()]).optional(), profiles: z.array(z.string().max(128)).max(64).default([]), oneShotServices: z.array(z.string().max(128)).max(64).default([]), registryCredentialIds: z.array(z.string().max(128)).max(32).default([]), actor }).strict().parse(body);
    const secretNameToggles = input.variables && "nonSecretValues" in input.variables ? input.variables.secretNameToggles : undefined;
    validateComposeYaml(input.composeYaml, secretNameToggles === undefined ? undefined : [...secretNameToggles]);
    if (Buffer.byteLength(JSON.stringify(input.variables ?? {})) > 262_144) throw new BadRequestException("variables_too_large");
    const keys = await loadComposeKeyring(this.config.composeCrypto.keyringFile);
    const liveInventory = await this.inventories.current(vpsId);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      this.idle(state, appId);
      this.assertProjectFree(state, app);
      if (app.mode !== "managed") throw new ConflictException("managed_configuration_required");
      const seq = Math.max(0, ...state.revisions.filter(r => r.appId === appId).map(r => r.seq)) + 1;
      state.revisions.push({ id: createHash("sha256").update(JSON.stringify([appId, seq, Date.now()])).digest("hex").slice(0, 16), appId, vpsId, seq, envelope: encryptComposeField(JSON.stringify({ composeYaml: input.composeYaml, variables: input.variables }), { vpsId, appId, field: "composeYaml", version: seq }, keys), variables: {}, profiles: input.profiles, oneShotServices: input.oneShotServices, createdAt: now() });
      const previewId = createHash("sha256").update(JSON.stringify([appId, seq, "preview", Date.now()])).digest("hex").slice(0, 16);
      const operation: WorkRow = { id: createHash("sha256").update(JSON.stringify([appId, "preview_prepare", previewId])).digest("hex").slice(0, 21), vpsId, appId, kind: "preview_prepare", status: "prepared", request: { previewId, revisionSeq: seq, registryCredentialIds: input.registryCredentialIds }, generation: app.generation, idempotencyKey: input.idempotencyKey, requestDigest: digest(input), createdAt: now(), updatedAt: now(), actor: this.actorOf((input as { actor?: { kind: string; id?: string } }).actor) };
      const preview: PreviewRow = { id: previewId, appId, vpsId, revisionSeq: seq, status: "pending", generation: app.generation, request: { registryCredentialIds: input.registryCredentialIds }, createdAt: now(), expiresAt: new Date(Date.now() + (this.config.compose?.previewTtlSeconds ?? 300) * 1000).toISOString(), updatedAt: now() };
      state.operations.push(operation);
      state.previews.push(preview);
      for (const prior of state.previews) if (prior.appId === appId && prior.id !== preview.id && prior.status === "pending") prior.status = "stale";
      return { previewId: preview.id, status: preview.status, operationId: operation.id };
    });
  }

  async work(vpsId: string, appId: string, kind: string, body: unknown) {
    const input = confirmation.strict().parse(body);;
    // Ownership is resolved before any gate/inventory work so a cross-VPS app id is reported as not found.
    await this.repo.transaction(state => this.app(state, vpsId, appId));
    const inv = await this.gate(vpsId, true);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      const requestDigest = digest(input);
      const previous = state.operations.find(op => op.appId === appId && op.kind === kind && op.idempotencyKey === input.idempotencyKey);
      if (previous) {
        if (previous.requestDigest !== requestDigest) throw new ConflictException("idempotency_conflict");
        return previous;
      }
      this.idle(state, appId);
      this.assertProjectFree(state, app);
      this.assertContainerFree(state, vpsId, app, inv);
      if (app.agentInstanceId !== inv!.agentInstanceId || app.daemonEpoch !== String(inv!.daemonEpoch)) throw new ConflictException("identity_changed");
      if (app.mode !== "managed" && app.mode !== "external_control") throw new ForbiddenException("stack_not_opted_in");
      if (kind.startsWith("lifecycle_") && !app.source) throw new ConflictException("verified_source_required");
      const action = kind.slice("lifecycle_".length) as "start" | "stop" | "restart";
      const observed = (inv?.projects ?? []).find(p => p.project === app.projectName);
      const source = app.source as { path?: string; digest?: string; services?: { name: string; kind?: string; dependsOn?: string[]; healthcheck?: unknown }[]; dependenciesGraph?: { service?: unknown; dependsOn?: unknown; dependencyConditions?: unknown }[] } | undefined;
      // mrVnhE-1: dependency-order execution contract. Observed verify_source
      // carries dependencyConditions per edge (started|healthy|completed); the
      // claim's durable plan must mirror that graph exactly — never a
      // hardcoded "running" oneShot. Edge conditions describe when a
      // DEPENDENT may start; they never define a service's own readiness
      // (mrVnhE-2). Each service's condition derives only from its declared
      // facts: one-shots complete; long-lived services are healthy only when
      // the source declares a healthcheck (the verify_source observation
      // carries the fact), else merely started. The agent refuses plans where
      // a dependent appears before its dependency, so a topological order is
      // derived here (name order breaks ties for deterministic stable output).
      type DependencyCondition = "started" | "healthy" | "completed";
      const graphConditions = new Map<string, Record<string, DependencyCondition>>();
      for (const node of source?.dependenciesGraph ?? []) {
        if (node && typeof node === "object" && typeof (node as { service?: unknown }).service === "string") {
          const conditions: Record<string, DependencyCondition> = {};
          const deps = (node as { dependencyConditions?: unknown }).dependencyConditions;
          if (deps && typeof deps === "object") {
            for (const [dep, cond] of Object.entries(deps as Record<string, unknown>)) {
              if (cond === "started" || cond === "healthy" || cond === "completed") conditions[dep] = cond;
            }
          }
          graphConditions.set((node as { service: string }).service, conditions);
        }
      }
      const serviceNames = new Set((source?.services ?? []).map(s => String(s.name)));
      const dependsOnOf = (name: string) => ((source?.services ?? []).find(s => String(s.name) === name)?.dependsOn ?? []).map(String).filter(d => serviceNames.has(d));
      // Topological order via DFS; dependencies first.
      const order: string[] = [];
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (name: string): boolean => {
        if (visited.has(name)) return true;
        if (visiting.has(name)) return false; // cycle: invalid graph
        visiting.add(name);
        for (const dep of dependsOnOf(name)) if (!visit(dep)) return false;
        visiting.delete(name);
        visited.add(name);
        order.push(name);
        return true;
      };
      const sortedNames = [...serviceNames].sort();
      for (const name of sortedNames) {
        if (!visit(name)) throw new ConflictException("dependency_graph_invalid");
      }
      const oneShotStatusOf = (r: { state: string; status?: string }): "never_started" | "running" | "succeeded" | "failed" => {
        if (r.state === "running") return "running";
        if (r.state === "exited") return /^Exited \(0\)(?:\s|$)/i.test(r.status ?? "") ? "succeeded" : "failed";
        if (r.state === "created" || r.state === "") return "never_started";
        return "running"; // restarting/removing etc. left ambiguous: treat as running (agent re-verifies live snapshot)
      };
      const planServices = (source?.services ?? []).map(s => ({
        name: String(s.name),
        kind: s.kind === "oneshot" ? "oneshot" as const : "longlived" as const,
        // Own readiness only: healthcheck fact beats every edge condition.
        condition: ((s.kind === "oneshot") ? "completed" : (s.healthcheck === true ? "healthy" : "started")) as "started" | "healthy" | "completed",
        dependsOn: dependsOnOf(String(s.name)),
        dependencyConditions: graphConditions.get(String(s.name)),
        selected: true,
        desiredCount: null,
        replicas: (observed?.services.find(x => x.service === String(s.name))?.replicas ?? []).map(r => ({ containerKey: r.containerKey, state: r.state, health: r.health, oneShotStatus: s.kind === "oneshot" ? oneShotStatusOf(r) : "running" as const })),
      }));
      const op: WorkRow = { id: createHash("sha256").update(JSON.stringify([vpsId, appId, kind, input.idempotencyKey])).digest("hex").slice(0, 21), vpsId, appId, kind, status: "prepared", request: { action, sourcePath: source?.path ?? "", sourceDigest: source?.digest ?? "" }, generation: app.generation, idempotencyKey: input.idempotencyKey, requestDigest, createdAt: now(), updatedAt: now(), actor: this.actorOf((input as { actor?: { kind: string; id?: string } }).actor) };
      op.lifecyclePlan = { action, sourcePath: String(op.request.sourcePath), sourceDigest: String(op.request.sourceDigest), services: planServices, order, observedFingerprint: computeProjectRuntimeFingerprint(inv, app.projectName) };
      state.operations.push(op);
      return op;
    });
  }

  async unmanage(vpsId: string, appId: string, body: unknown) {
    confirmation.strict().parse(body);
    await this.gate(vpsId);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      // Unmanage may invalidate prepared/claimed work whose mutation is not yet authorized;
      // an authorized, executing or uncertain operation keeps exclusive ownership of the stack.
      for (const op of state.operations) {
        if (op.appId !== appId || terminalOp(op)) continue;
        if (op.authorization !== undefined || op.status === "applying" || op.status === "uncertain") throw new ConflictException("application_busy");
      }
      app.mode = "unmanaged";
      app.generation++;
      app.updatedAt = now();
      for (const p of state.previews) if (p.appId === appId) p.status = "stale";
      return { appId, mode: app.mode };
    });
  }

  async update(vpsId: string, appId: string, body: unknown) {
    const input = confirmation.extend({
      displayName: z.string().trim().min(1).max(120).optional(),
      readinessSeconds: z.number().int().min(30).max(3600).optional(),
    }).strict().parse(body);
    await this.gate(vpsId);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      if (input.displayName && state.applications.some(a => a.vpsId === vpsId && a.id !== appId && a.displayName === input.displayName)) {
        throw new ConflictException("application_exists");
      }
      if (input.displayName) app.displayName = input.displayName;
      if (input.readinessSeconds !== undefined) app.readinessSeconds = input.readinessSeconds;
      app.generation++;
      app.updatedAt = now();
      for (const p of state.previews) if (p.appId === appId) p.status = "stale";
      return app;
    });
  }

  async rename(vpsId: string, appId: string, body: unknown) {
    return this.update(vpsId, appId, body);
  }

  async source(vpsId: string, appId: string, body: unknown) {
    const input = confirmation.extend({ sourcePath: z.string().startsWith("/").max(4096), oneShotServices: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)).max(64).default([]), actor }).strict().parse(body);
    const inv = await this.gate(vpsId, true);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      const prior = state.operations.find(o => o.vpsId === vpsId && o.kind === "verify_source" && o.idempotencyKey === input.idempotencyKey);
      if (prior) { if (prior.requestDigest !== digest(input)) throw new ConflictException("idempotency_conflict"); return { operationId: prior.id, status: prior.status }; }
      this.idle(state, appId);
      const operationId = createHash("sha256").update(JSON.stringify([vpsId, appId, "verify_source", input.idempotencyKey])).digest("hex").slice(0, 21);
      const op: WorkRow = { id: operationId, vpsId, appId, kind: "verify_source", status: "prepared", request: { sourcePath: input.sourcePath, oneShotServices: input.oneShotServices, daemonEpoch: inv!.daemonEpoch, agentInstanceId: inv!.agentInstanceId }, generation: app.generation, idempotencyKey: input.idempotencyKey, requestDigest: digest(input), createdAt: now(), updatedAt: now(), actor: this.actorOf(input.actor) };
      state.operations.push(op);
      return { operationId: op.id, status: op.status };
    });
  }

  async claim(vpsId: string, instance: string): Promise<ClaimWork | null> {
    const liveInventory = await this.gate(vpsId, true);
    const keys = await loadComposeKeyring(this.config.composeCrypto.keyringFile);
    return this.repo.transaction<ClaimWork | null>(async state => {
      const take = (op: WorkRow) => {
        const claimToken = randomBytes(32).toString("hex");
        op.status = "claimed";
        op.claimedBy = instance;
        op.claimToken = claimToken;
        op.claimedAt = now();
        op.claimLeaseExpiresAt = new Date(Date.now() + (this.config.compose?.claimLeaseSeconds ?? 120) * 1000).toISOString();
        op.updatedAt = now();
        return claimToken;
      };
      const leaseEligible = (op: WorkRow) => op.status === "prepared" || (["claimed", "applying"].includes(op.status) && op.authorization === undefined && op.claimedBy !== undefined && !this.claimStillHeld(op, op.claimedBy));
      const stalePreviewOp = (preview: PreviewRow) => state.operations.find(o => o.vpsId === preview.vpsId && o.appId === preview.appId && o.kind === "preview_prepare" && o.request.previewId === preview.id);
      const revisionPresent = (op: WorkRow) => !["preview_prepare", "deploy"].includes(op.kind) || state.revisions.some(r => r.appId === op.appId && r.seq === (op.request.revisionSeq as number | undefined ?? 0));
      const ownsInstance = (op: WorkRow) => op.kind === "runtime_prep" || (this.app(state, vpsId, op.appId).agentInstanceId === instance && this.app(state, vpsId, op.appId).mode !== "unmanaged");
      const previewOps = state.previews.filter(p => p.vpsId === vpsId && p.status === "pending").map(stalePreviewOp).filter((op): op is WorkRow => op !== undefined && leaseEligible(op) && revisionPresent(op) && ownsInstance(op));
      const candidates = state.operations.filter(o => o.vpsId === vpsId && leaseEligible(o) && revisionPresent(o) && ownsInstance(o) && (o.kind !== "preview_prepare" || !previewOps.includes(o)));
      const op = [...candidates, ...previewOps][0];
      if (!op) return null;
      if (op.kind === "runtime_prep") {
        const claimToken = take(op);
        return { operationId: op.id, kind: op.kind, vpsId, app: { id: "", project: "", daemonEpoch: String(op.request.daemonEpoch), generation: op.generation, mode: "unmanaged" }, runtimePrep: { pluginRequired: true }, stages: ["preflight"], readinessSeconds: 0, pullTimeoutSeconds: 0, stopGraceSeconds: 0, claimToken };
      }
      const app = this.app(state, vpsId, op.appId);
      const claimToken = take(op);
      const appPayload = { id: app.id, project: app.projectName, daemonEpoch: app.daemonEpoch, generation: app.generation, mode: app.mode, source: app.source };
      if (op.kind === "verify_source") { return { operationId: op.id, kind: op.kind, vpsId, app: appPayload, sourcePath: String(op.request.sourcePath), oneShotServices: (op.request.oneShotServices as string[] | undefined) ?? [], stages: ["preflight"], readinessSeconds: 0, pullTimeoutSeconds: 0, stopGraceSeconds: 0, claimToken }; }
      if (op.kind === "preview_prepare" || op.kind === "deploy") {
        const revision = state.revisions.find(r => r.appId === app.id && r.seq === (op.request.revisionSeq as number | undefined ?? 0));
        const rendered = revision ? JSON.parse(decryptComposeField(revision.envelope, { vpsId, appId: app.id, field: "composeYaml", version: revision.seq }, keys) as string) as { composeYaml: string; variables: Record<string, string> } : undefined;
        const previewRecord = op.kind === "deploy" ? state.previews.find(p => p.id === op.request.previewId && p.appId === app.id) : undefined;
        const approvedPreview = previewRecord ? this.decodeApprovedPreview(previewRecord, keys) : undefined;
        const credentialIds = previewRecord?.request.registryCredentialIds ?? (op.request.registryCredentialIds as string[] | undefined) ?? [];
        const registryCredentials = state.credentials.filter(c => c.vpsId === vpsId && credentialIds.includes(c.id)).map(c => ({ id: c.id, ...registryCredentialIdentity(c.name), version: c.version, value: decryptComposeField(c.envelope, { vpsId, appId: "registry", field: "registryCredential", version: c.version }, keys) }));
        return { operationId: op.id, kind: op.kind, vpsId, app: appPayload, revision: rendered ? { seq: revision!.seq, composeYaml: rendered.composeYaml, variables: rendered.variables, profiles: revision!.profiles, oneShotServices: revision!.oneShotServices } : undefined, adoptionOwnership: app.ownerManifest?.containers ? { agentInstanceId: app.ownerManifest.agentInstanceId, daemonEpoch: app.ownerManifest.daemonEpoch, projectName: app.ownerManifest.projectName, containers: app.ownerManifest.containers } : undefined, secrets: state.secrets.filter(s => s.appId === app.id).map(s => ({ name: s.name, version: s.version, value: decryptComposeField(s.envelope, { vpsId, appId: app.id, field: "secret", version: `${s.name}:${s.version}` }, keys) })), registryCredentials, approvedDigest: (op.request.approvedDigest as string | undefined), approvedPreview, stages: op.kind === "deploy" ? deployStages : ["preflight"], readinessSeconds: op.kind === "deploy" ? (app.readinessSeconds ?? 300) : 0, pullTimeoutSeconds: op.kind === "deploy" ? 600 : 0, stopGraceSeconds: op.kind === "deploy" ? 60 : 0, claimToken };
      }
      return { operationId: op.id, kind: op.kind, vpsId, app: appPayload, lifecyclePlan: op.lifecyclePlan, stages: lifecycleStages, readinessSeconds: (app.readinessSeconds ?? 300), pullTimeoutSeconds: 0, stopGraceSeconds: 60, claimToken };
    });
  }

  async progress(vpsId: string, instance: string, opId: string, body: unknown) {
    const input = z.object({ claimToken: z.string().length(64), seq: z.number().int().positive(), at: z.string().datetime({ offset: true }), items: z.array(z.object({ stage: z.enum(["claim", "preflight", "pull", "apply", "observe"]), service: z.string().max(128).optional(), status: z.enum(["started", "ok", "failed", "skipped", "uncertain"]), reason: z.string().max(255).optional(), observed: z.record(z.unknown()).optional() }).strict()).max(100) }).strict().parse(body);
    return this.repo.transaction(state => {
      const op = state.operations.find(o => o.id === opId && o.vpsId === vpsId);
      if (!op || op.claimToken !== input.claimToken || op.claimedBy !== instance) throw new ForbiddenException("invalid_claim");
      if (op.status === "claimed" || op.status === "applying") {
        op.claimedAt = now();
        op.claimLeaseExpiresAt = new Date(Date.now() + CLAIM_LEASE_SECONDS * 1000).toISOString();
      }
      op.progress = op.progress ?? { seq: -1, items: [] };
      if (input.seq < op.progress.seq) throw new ConflictException("progress_sequence_backward");
      if (input.seq === op.progress.seq && digest(input.items) !== digest(op.progress.items)) throw new ConflictException("progress_sequence_conflict");
      if (input.seq > op.progress.seq) op.progress = { seq: input.seq, items: input.items };
      return { ok: true, acceptedSeq: op.progress.seq };
    });
  }

  async authorize(vpsId: string, instance: string, opId: string, body: unknown) {
    const input = z.object({ claimToken: z.string().length(64), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
    const liveInventory = await this.gate(vpsId, true);
    const keys = await loadComposeKeyring(this.config.composeCrypto.keyringFile);
    return this.repo.transaction(state => {
      const op = state.operations.find(o => o.id === opId && o.vpsId === vpsId);
      if (!op || op.claimToken !== input.claimToken || op.claimedBy !== instance) throw new ForbiddenException("invalid_claim");
      if (op.authorization) {
        if (op.authorization.payloadDigest !== input.payloadDigest) throw new ConflictException("authorization_digest_conflict");
        return { revisionAuthorizationId: op.authorization.revisionAuthorizationId, nonce: op.authorization.nonce, grantedAt: op.authorization.grantedAt };
      }
      if (op.status !== "claimed") throw new ConflictException("invalid_operation_state");
      if (op.appId === "" && op.kind !== "runtime_prep") throw new ConflictException("vps_scoped_operation");
      const previewCredentialIds = (preview: PreviewRow | undefined) => preview?.request.registryCredentialIds ?? [];
      if (op.appId !== "") {
        const app = this.app(state, vpsId, op.appId);
        if (app.agentInstanceId !== instance || app.generation !== op.generation || app.mode === "unmanaged" || app.agentInstanceId !== liveInventory!.agentInstanceId || app.daemonEpoch !== String(liveInventory!.daemonEpoch)) throw new ConflictException("identity_changed");
        const observedFingerprint = computeProjectRuntimeFingerprint(liveInventory, app.projectName);
        if (op.kind === "deploy") {
          const preview = state.previews.find(p => p.id === op.request.previewId && p.appId === app.id);
          if (!preview || preview.status !== "confirmed" || preview.digest !== op.request.approvedDigest || preview.generation !== app.generation || Date.parse(preview.expiresAt) <= Date.now()) throw new ConflictException("stale_preview");
          const approved = this.decodeApprovedPreview(preview, keys);
          const removedIds = [...((op.request.removedServiceIds as string[] | undefined) ?? [])].sort();
          if (!approved || approved.digest !== preview.digest || digest(approved.removedServiceIds) !== digest(removedIds)) throw new ConflictException("approved_preview_changed");
          const secretVersions = Object.fromEntries(state.secrets.filter(s => s.appId === app.id).map(s => [s.name, s.version]));
          const credentialIdList = previewCredentialIds(preview);
          const credentialVersions = Object.fromEntries(state.credentials.filter(c => c.vpsId === vpsId && credentialIdList.includes(c.id)).map(c => [c.id, c.version]));
          if (digest(secretVersions) !== digest(approved.secretVersions) || digest(credentialVersions) !== digest(approved.credentialVersions)) throw new ConflictException("protected_inputs_changed");
          const preimage = { appId: app.id, approvedDigest: preview.digest, daemonEpoch: app.daemonEpoch, generation: app.generation, kind: op.kind, operationId: op.id, removedServiceIds: removedIds, removals: approved.removals, ownershipBinding: approved.ownershipBinding, inventoryFingerprint: approved.inventoryFingerprint };
          if (input.payloadDigest !== digest(preimage)) throw new ConflictException("authorization_digest_mismatch");
        } else if (op.kind.startsWith("lifecycle_")) {
          const observed = liveInventory!.projects.find(p => p.project === app.projectName);
          if (!observed || !app.source?.verified || app.source.digest !== op.request.sourceDigest) throw new ConflictException("source_changed");
          const preimage = { appId: app.id, daemonEpoch: app.daemonEpoch, generation: app.generation, operationId: op.id, kind: op.kind, sourceDigest: op.request.sourceDigest, observedFingerprint };
          if (input.payloadDigest !== digest(preimage)) throw new ConflictException("authorization_digest_mismatch");
        }
      }
      if (op.appId === "" && input.payloadDigest !== digest({ operationId: op.id, kind: op.kind, generation: op.generation, daemonEpoch: String(liveInventory!.daemonEpoch), pluginRequired: true })) throw new ConflictException("authorization_digest_mismatch");
      op.status = "applying";
      const authorization: OperationAuthorization = { id: randomBytes(16).toString("hex"), revisionAuthorizationId: randomBytes(16).toString("hex"), nonce: randomBytes(32).toString("hex"), payloadDigest: input.payloadDigest, grantedAt: now() };
      op.authorization = authorization;
      op.updatedAt = now();
      return { revisionAuthorizationId: authorization.revisionAuthorizationId, nonce: authorization.nonce, grantedAt: authorization.grantedAt };
    });
  }

  async report(vpsId: string, instance: string, opId: string, body: unknown) {
    const input = z.object({ claimToken: z.string().length(64), status: z.enum(["succeeded", "failed", "uncertain"]), executed: z.boolean(), mutationAuthorized: z.boolean().optional(), partial: z.boolean().optional(), observed: z.array(z.record(z.unknown())).max(128).optional(), error: z.string().max(255).optional() }).strict().parse(body);
    const receipt = { status: input.status, executed: input.executed, observed: input.observed ?? [], error: input.error };
    const receiptDigest = digest({ executed: receipt.executed, observed: receipt.observed ?? [], error: receipt.error });
    const keys = await loadComposeKeyring(this.config.composeCrypto.keyringFile);
    const liveInventory = await this.inventories.current(vpsId);
    return this.repo.transaction(state => {
      const op = state.operations.find(o => o.id === opId && o.vpsId === vpsId);
      const preview = state.previews.find(p => p.id === opId && p.vpsId === vpsId);
      const holder = op ?? preview;
      const previewOp = preview ? state.operations.find(o => o.vpsId === preview.vpsId && o.appId === preview.appId && o.kind === "preview_prepare" && o.request.previewId === preview.id) : undefined;
      const holderToken = op ? op.claimToken : preview?.claim?.claimToken;
      if (!holder || (previewOp?.claimToken ?? holderToken) !== input.claimToken || (op && op.claimedBy !== instance)) throw new ForbiddenException("invalid_claim");
      if (!op && previewOp) {
        if (previewOp.claimedBy !== instance) throw new ForbiddenException("invalid_claim");
      }
      // Terminal idempotent replay: op holders compare the normalized receipt
      // digest; preview holders compare the redacted public receipt projection.
      if (op && terminalOp(op)) {
        const stored = (op.result as { digest?: string } | undefined)?.digest;
        if (stored === undefined || stored !== receiptDigest) throw new ConflictException("receipt_conflict");
        return { ok: true, committed: true };
      }
      // An uncertain operation keeps its exclusion until reconciled: only the exact
      // committed receipt may replay; a divergent receipt must not overwrite it.
      if (op && op.status === "uncertain") {
        const stored = (op.result as { digest?: string } | undefined)?.digest;
        if (stored === undefined || stored !== receiptDigest) throw new ConflictException("receipt_conflict");
        return { ok: true, committed: true };
      }
      if (op?.kind === "preview_prepare") {
        const linkedPreview = state.previews.find(row => row.id === op.request.previewId && row.vpsId === vpsId && row.appId === op.appId);
        if (!linkedPreview) throw new ConflictException("preview_not_found");
        const committed = this.commitPreviewReceipt(state, linkedPreview, op, receipt, receiptDigest, this.publicReceipt(receipt), vpsId, keys);
        op.status = receipt.status;
        op.result = { ...this.publicReceipt(receipt), digest: receiptDigest };
        op.updatedAt = now();
        return committed;
      }
      return this.commitReceipt(state, op, preview, previewOp, receipt, receiptDigest, this.publicReceipt(receipt), instance, vpsId, keys, liveInventory);
    });
  }

  /** Applies a fresh receipt: mutation receipts need an authorization record only when work executed. */
  private commitReceipt(state: ApplicationsState, op: WorkRow | undefined, preview: PreviewRow | undefined, previewOp: WorkRow | undefined, receipt: Receipt, receiptDigest: string, publicReceipt: { executed: boolean; error?: string }, instance: string, vpsId: string, keys: Keyring, liveInventory?: StoredApplicationsInventory) {
    if (preview && previewOp && !op) {
      // Preview receipt: claimed -> resolved/failure; terminal statuses replay
      if (preview.status === "failed" || preview.status === "ready") {
        if (previewOp.result === undefined || digest(previewOp.result) !== receiptDigest) throw new ConflictException("receipt_conflict");
        return { ok: true, committed: true };
      }
      return this.commitPreviewReceipt(state, preview, previewOp, receipt, receiptDigest, publicReceipt, vpsId, keys);
    }
    if (op && op.appId === "") {
      if (op.kind !== "runtime_prep") throw new ForbiddenException("invalid_claim");
      op.status = receipt.status;
      const observed = receipt.observed?.find(row => typeof row?.installPerformed === "boolean");
      const runtimeResult = observed ? {
        installPerformed: observed.installPerformed,
        confirmedMode: ["plugin", "standalone", "probe_only"].includes(String(observed.confirmedMode)) ? observed.confirmedMode : undefined,
        composeVersion: typeof observed.composeVersion === "string" ? observed.composeVersion.slice(0, 128) : undefined,
        unsupportedReason: typeof observed.unsupportedReason === "string" ? observed.unsupportedReason.slice(0, 128) : undefined,
        instructions: typeof observed.instructions === "string" ? observed.instructions.slice(0, 2048) : undefined,
      } : {};
      op.result = { ...publicReceipt, ...runtimeResult, digest: receiptDigest };
      op.updatedAt = now();
      return { ok: true, committed: true };
    }
    const app = this.app(state, vpsId, String((op ?? preview)!.appId));
    if (app.agentInstanceId !== instance) throw new ConflictException("identity_changed");
    if (op) {
      const mutating = ["lifecycle_start", "lifecycle_stop", "lifecycle_restart", "deploy"].includes(op.kind);
      if (mutating && receipt.executed && !op.authorization) throw new ForbiddenException("authorization_required");
      if (!terminalOp(op)) {
        const observed = (receipt.observed ?? [])[0] ?? {};
        if (op.kind === "verify_source" && receipt.status === "succeeded" && !this.verifySourceObserved(app, op, observed, liveInventory)) throw new ConflictException("source_verification_mismatch");
        op.status = receipt.status === "uncertain" && op.authorization ? "uncertain" : receipt.status;
        if (op.kind === "deploy" && receipt.status === "succeeded" && observed.ownership && typeof observed.ownership === "object") {
          app.ownerManifest = { ...app.ownerManifest, ...(observed.ownership as object) } as AppRow["ownerManifest"];
        }
        // mrVnhE: preserve service outcomes and runtime pose inside durable op
        // result; publicOperation projects them as bounded result fields.
        op.result = { ...publicReceipt, serviceOutcomes: this.extractServiceOutcomes(receipt), observedRuntime: this.extractObservedRuntime(op, receipt, app), digest: receiptDigest };
        if (receipt.status === "failed" || receipt.status === "uncertain") {
          for (const p of state.previews) if (p.appId === String(op.appId) && p.status === "claimed") p.status = "failed";
        }
        op.updatedAt = now();
        if (op.kind === "verify_source" && receipt.status === "succeeded") {
          app.source = { ...observed, path: String(op.request.sourcePath), verified: true, verifiedAt: now(), agentInstanceId: instance, daemonEpoch: app.daemonEpoch };
          app.mode = "detected_readonly";
          app.generation++;
          app.updatedAt = now();
        }
        return { ok: true, committed: true };
      }
    }
    throw new ConflictException("receipt_conflict");
  }


  /** Preview receipts: success seals the full resolution encrypted; failure stores the redacted receipt only. */
  private commitPreviewReceipt(state: ApplicationsState, preview: PreviewRow, previewOp: WorkRow | undefined, receipt: Receipt, receiptDigest: string, publicReceipt: { executed: boolean; error?: string }, vpsId: string, keys: Keyring) {
    const observed = (receipt.observed ?? [])[0];
    const result = observed && typeof observed === "object" && typeof (observed as PreviewResolution).digest === "string" && /^[a-f0-9]{64}$/.test((observed as PreviewResolution).digest) && typeof (observed as PreviewResolution).canonicalModelJson === "string" && (observed as PreviewResolution).canonicalModelJson.length <= 262_144 && typeof (observed as PreviewResolution).canonicalModel === "object" && typeof (observed as PreviewResolution).redactedModel === "object" && typeof (observed as PreviewResolution).imageDigests === "object" && typeof (observed as PreviewResolution).secretVersions === "object" && Array.isArray((observed as PreviewResolution).removedServiceIds) ? observed as PreviewResolution : undefined;
    if (result) {
      const parsedCanonical = JSON.parse(result.canonicalModelJson) as unknown;
      if (JSON.stringify(parsedCanonical) !== JSON.stringify(result.canonicalModel)) throw new ConflictException("preview_result_invalid");
      if (createHash("sha256").update(result.canonicalModelJson, "utf8").digest("hex") !== result.digest) throw new ConflictException("preview_result_invalid");
      if (result.removedServiceIds.length > 64 || new Set(result.removedServiceIds).size !== result.removedServiceIds.length) throw new ConflictException("preview_result_invalid");
      const removals = result.removals;
      const removalKeys = Array.isArray(removals) ? removals.flatMap(removal => removal.containerKeys) : [];
      const validRemovals = Array.isArray(removals) && removals.length === result.removedServiceIds.length && removals.every(removal => removal && typeof removal.serviceName === "string" && Array.isArray(removal.containerKeys) && result.removedServiceIds.includes(removal.serviceName) && removal.containerKeys.length > 0 && removal.containerKeys.length <= 100 && removal.containerKeys.every(key => typeof key === "string" && /^[A-Za-z0-9_-]{32}$/.test(key))) && new Set(removalKeys).size === removalKeys.length;
      const app = state.applications.find(row => row.id === preview.appId && row.vpsId === preview.vpsId);
      const validOwner = app && result.ownershipBinding?.agentInstanceId === app.agentInstanceId && result.ownershipBinding?.daemonEpoch === app.daemonEpoch && result.ownershipBinding?.projectName === app.projectName;
      if (result.removedServiceIds.length > 0 && (!validRemovals || !validOwner || !result.inventoryFingerprint || !/^[a-f0-9]{64}$/.test(result.inventoryFingerprint))) throw new ConflictException("preview_result_invalid");
      if (result.removedServiceIds.length === 0 && ((removals?.length ?? 0) > 0 || (result.ownershipBinding && !validOwner) || (result.inventoryFingerprint && !/^[a-f0-9]{64}$/.test(result.inventoryFingerprint)))) throw new ConflictException("preview_result_invalid");
    }
    if (receipt.status === "succeeded" && (!result || Number(result.revisionSeq) !== Number(preview.revisionSeq))) throw new ConflictException("preview_result_invalid");
    if (receipt.status !== "succeeded") {
      preview.status = receipt.status === "uncertain" ? "claimed" : "failed";
      preview.error = { message: receipt.error ?? "preview_failed" };
      preview.result = publicReceipt;
      preview.updatedAt = now();
      return { ok: true, committed: true };
    }
    (preview.status as string) = "ready";
    preview.digest = result!.digest;
    preview.removedServices = result!.removedServiceIds;
    preview.observedSecretVersions = result!.secretVersions;
    if (result!.credentialVersions) preview.observedCredentialVersions = result!.credentialVersions;
    preview.resolvedModelEnvelope = encryptComposeField(JSON.stringify({ canonicalModelJson: result!.canonicalModelJson, redactedModel: result!.redactedModel, imageDigests: result!.imageDigests, removedServiceIds: result!.removedServiceIds, removals: result!.removals, ownershipBinding: result!.ownershipBinding, inventoryFingerprint: result!.inventoryFingerprint, observedFingerprint: result!.observedFingerprint, secretVersions: result!.secretVersions, credentialVersions: result!.credentialVersions }), { vpsId, appId: preview.appId, field: "resolvedModel", version: preview.revisionSeq }, keys);
    preview.result = { executed: publicReceipt.executed, error: publicReceipt.error };
    preview.updatedAt = now();
    return { ok: true, committed: true };
  }

  /**
   * Independent verify_source gate. Go reports only the source file's own
   * projection and echoes the requested project (source.go never populates the
   * explicit root project name), so identity is verified against concrete
   * cross-evidence here: path/epoch identity, mandatory structural fields, and
   * membership of every registered source service in BOTH the reported services
   * list AND the reported dependency graph — never the echoed project name.
   */
    private verifySourceObserved(app: AppRow, op: WorkRow, observed: Record<string, unknown>, liveInventory?: StoredApplicationsInventory): boolean {
    if (observed.path !== op.request.sourcePath || observed.verified !== true) return false;
    if (app.agentInstanceId !== op.request.agentInstanceId || app.daemonEpoch !== String(op.request.daemonEpoch)) return false;
    if (typeof observed.digest !== "string" || !/^[a-f0-9]{64}$/.test(observed.digest)) return false;
    if (typeof observed.project !== "string" || observed.project !== app.projectName) return false;
    if (!Array.isArray(observed.services) || !Array.isArray(observed.dependenciesGraph)) return false;
    if (observed.services.length === 0) return false;

    const reportedServiceNames = new Set<string>();
    for (const svc of observed.services as unknown[]) {
      if (typeof svc !== "object" || svc === null) return false;
      const name = (svc as { name?: unknown }).name;
      if (typeof name !== "string" || !name) return false;
      reportedServiceNames.add(name);
    }
    const graphServiceNames = new Set<string>();
    for (const node of observed.dependenciesGraph as unknown[]) {
      if (typeof node !== "object" || node === null) return false;
      const service = (node as { service?: unknown }).service;
      if (typeof service !== "string" || !service) return false;
      graphServiceNames.add(service);
    }
    for (const name of reportedServiceNames) {
      if (!graphServiceNames.has(name)) return false;
    }

    const typedSource = app.source as { services?: { name?: unknown }[] } | undefined;
    const sourceServices = (typedSource?.services ?? []).map(s => String(s.name)).filter(Boolean);
    for (const sourceService of sourceServices) {
      if (!reportedServiceNames.has(sourceService)) return false;
    }

    const project = liveInventory?.projects.find(p => p.project === app.projectName);
    if (project) {
      for (const s of project.services) {
        if (!reportedServiceNames.has(s.service)) return false;
      }
    }

    return true;
  }

  async optInExternal(vpsId: string, appId: string, body: unknown) {
    confirmation.strict().parse(body);
    await this.gate(vpsId, true);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      this.idle(state, appId);
      const source = app.source as { verified?: boolean } | undefined;
      if (!source || source.verified !== true) throw new ConflictException("verified_source_required");
      app.mode = "external_control";
      app.generation++;
      app.updatedAt = now();
      return app;
    });
  }

    async capability(vpsId: string) {
    const vps = await this.vps.get(vpsId);
    if (!vps) throw new NotFoundException("VPS not found");
    const inv = await this.inventories.current(vpsId);
    const agentState = await this.agents.getState(vpsId);
    const agentStatus = agentState ? deriveAgentStatus(agentState.status, agentState.lastSeenAt) : undefined;
    const reasons: string[] = [];
    if (!vps.composeManagementEnabled) reasons.push("compose_management_disabled");
    if (!inv?.capability.features.includes("compose_major_2")) reasons.push("compose_runtime_unverified");
    const ageSeconds = inv ? Math.max(0, Math.floor((Date.now() - Date.parse(inv.collectedAt)) / 1000)) : undefined;
    if (!inv?.completeness || ageSeconds === undefined || ageSeconds > 60 || agentStatus !== "online") reasons.push("fresh_connected_inventory_required");

    return {
      supported: Boolean(inv?.capability) && reasons.length === 0,
      reason: reasons[0],
      gate: { disabled: !vps.composeManagementEnabled },
      runtime: { dockerPresent: inv?.capability.dockerAvailable ?? false, composeVersion: inv?.capability.composeVersion },
      agent: { agentInstanceId: inv?.agentInstanceId },
      inventory: { ageSeconds, completeness: inv?.completeness ?? false, reason: inv?.completionReason || undefined },
      admission: { ready: reasons.length === 0, reasons },
    };
  }

  async list(vpsId: string, options?: { cursor?: string; limit?: number }) {
    if (this.config.mode === "demo") return { items: [], inventory: { available: false, reason: "demo_disabled" }, nextCursor: null };
    const vps = await this.vps.get(vpsId);
    if (!vps) throw new NotFoundException("VPS not found");
    const inv = await this.inventories.current(vpsId);
    const ageSeconds = inv ? Math.max(0, Math.floor((Date.now() - Date.parse(inv.collectedAt)) / 1000)) : undefined;

    return this.repo.transaction(state => {
      const persistedApps = state.applications.filter(a => a.vpsId === vpsId);
      const registeredProjectKeys = new Set(persistedApps.map(a => `${a.projectName}\u0000${a.daemonEpoch}`));

      const registeredItems = persistedApps.map(a => {
        const p = inv?.projects.find(x => x.project === a.projectName);
        return {
          appId: a.id,
          id: a.id,
          displayName: a.displayName,
          projectName: a.projectName,
          daemonEpoch: a.daemonEpoch,
          agentInstanceId: a.agentInstanceId,
          mode: a.mode,
          generation: a.generation,
          readinessSeconds: a.readinessSeconds ?? 300,
          inventoryFreshnessSeconds: ageSeconds,
          observed: {
            services: (p?.services ?? []).map(s => ({
              service: s.service,
              kind: s.isOneoff ? "oneshot" : "longlived",
              replicas: s.replicas.map(r => ({ containerKey: r.containerKey, slot: r.slot, state: r.state, status: r.status, health: r.health })),
              desiredCount: null,
            })),
            updatedAt: inv?.collectedAt,
          },
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        };
      });

      const detectedItems = (inv?.projects ?? [])
        .filter(p => !registeredProjectKeys.has(`${p.project}\u0000${String(inv?.daemonEpoch)}`))
        .map(p => {
          const appId = createHash("sha256").update(JSON.stringify([vpsId, String(inv?.daemonEpoch), p.project])).digest("hex").slice(0, 16);
          return {
            appId,
            id: appId,
            displayName: p.project,
            projectName: p.project,
            daemonEpoch: String(inv?.daemonEpoch),
            agentInstanceId: inv?.agentInstanceId ?? "",
            mode: "detected_readonly" as const,
            generation: 0,
            readinessSeconds: 300,
            inventoryFreshnessSeconds: ageSeconds,
            observed: {
              services: p.services.map(s => ({
                service: s.service,
                kind: s.isOneoff ? "oneshot" : "longlived",
                replicas: s.replicas.map(r => ({ containerKey: r.containerKey, slot: r.slot, state: r.state, status: r.status, health: r.health })),
                desiredCount: null,
              })),
              updatedAt: inv?.collectedAt,
            },
            createdAt: inv?.collectedAt ?? now(),
            updatedAt: inv?.collectedAt ?? now(),
          };
        });

      const allItems = [...registeredItems, ...detectedItems];
      const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
      let startIndex = 0;
      if (options?.cursor) {
        const found = allItems.findIndex(i => i.appId === options.cursor);
        if (found >= 0) startIndex = found + 1;
      }
      const page = allItems.slice(startIndex, startIndex + limit);
      const nextCursor = startIndex + limit < allItems.length ? page[page.length - 1]?.appId ?? null : null;

      return {
        items: page,
        inventory: {
          available: Boolean(inv),
          ageSeconds,
          stale: ageSeconds === undefined || ageSeconds > 60,
          completeness: Boolean(inv?.completeness),
          reason: inv?.completeness ? undefined : inv?.completionReason,
        },
        nextCursor,
      };
    });
  }

  async previewDetail(vpsId: string, appId: string, previewId: string) {
    const p = await this.repo.transaction(state => {
      this.app(state, vpsId, appId);
      const found = state.previews.find(x => x.id === previewId && x.appId === appId);
      if (!found) throw new NotFoundException("Preview not found");
      return found;
    });
    return this.publicPreview(p, await loadComposeKeyring(this.config.composeCrypto.keyringFile));
  }

  /** Public preview projection: only structurally-safe fields, no secrets, no claim keys, no op duplicity. */
  private publicPreview(p: PreviewRow, keys: Keyring) {
    return {
      id: p.id,
      appId: p.appId,
      revisionSeq: p.revisionSeq,
      status: p.status,
      generation: p.generation,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
      digest: p.digest,
      removedServices: p.removedServices,
      result: p.result,
      error: p.error,
      redactedModel: p.resolvedModelEnvelope && p.status === "ready" ? JSON.parse(decryptComposeField(p.resolvedModelEnvelope, { vpsId: p.vpsId, appId: p.appId, field: "resolvedModel", version: p.revisionSeq }, keys)).redactedModel : undefined,
    };
  }

    async operations(vpsId: string, appId: string, options?: { cursor?: string; limit?: number }) {
    await this.detail(vpsId, appId);
    return this.repo.transaction(state => {
      const appOps = state.operations.filter(o => o.appId === appId && o.vpsId === vpsId).reverse();
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
      const { page, nextCursor } = this.paginate(appOps, options?.cursor, o => o.id, limit);
      return { items: page.map(o => this.publicOperation(o)), nextCursor: nextCursor ?? null };
    });
  }

  async vpsOperations(vpsId: string, options?: { cursor?: string; limit?: number }) {
    return this.repo.transaction(state => {
      const vpsOps = state.operations.filter(o => o.vpsId === vpsId).reverse();
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
      const { page, nextCursor } = this.paginate(vpsOps, options?.cursor, o => o.id, limit);
      return { items: page.map(o => this.publicOperation(o)), nextCursor: nextCursor ?? null };
    });
  }

  async revisions(vpsId: string, appId: string, options?: { cursor?: string; limit?: number }) {
    await this.detail(vpsId, appId);
    return this.repo.transaction(state => {
      const revs = state.revisions.filter(r => r.appId === appId && r.vpsId === vpsId).reverse();
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
      const { page, nextCursor } = this.paginate(revs, options?.cursor, r => String(r.seq), limit);
      return { items: page.map(({ seq, profiles, oneShotServices, createdAt }) => ({ seq, profiles, oneShotServices, createdAt })), nextCursor: nextCursor ?? null };
    });
  }

  async cancel(vpsId: string, appId: string, opId: string, body: unknown) {
    confirmation.strict().parse(body);
    return this.repo.transaction(state => {
      this.app(state, vpsId, appId);
      const op = state.operations.find(o => o.id === opId && o.appId === appId);
      if (!op) throw new NotFoundException("Operation not found");
      if (op.authorization || op.status === "applying" || op.status === "uncertain") throw new ConflictException("mutation_already_authorized");
      if (!terminalOp(op)) { op.status = "cancelled"; op.updatedAt = now(); return op; }
      throw new ConflictException("operation_terminal");
    });
  }

  async recheck(vpsId: string, appId: string, opId: string, body: unknown) {
    confirmation.strict().parse(body);
    const inv = await this.inventories.current(vpsId);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      const found = state.operations.find(o => o.id === opId && o.appId === appId);
      if (!found) throw new NotFoundException("Operation not found");
      if (found.status !== "uncertain") throw new ConflictException("operation_not_uncertain");
      const current = inv?.projects.find(p => p.project === app.projectName);
      const sourceServiceNames = this.serviceNames(app.source);
      const discoveredNames = current?.services.map(s => s.service) ?? [];
      const matches = sourceServiceNames.length > 0 && sourceServiceNames.every(name => discoveredNames.includes(name));
      found.result = { ...(found.result as Record<string, unknown> | undefined ?? {}), reconcile: { discoveredServiceNames: discoveredNames, matched: matches } };
      found.updatedAt = now();
      return found;
    });
  }

  publicReceipt(receipt: Receipt) {
    return { executed: receipt.executed, error: receipt.error };
  }


  /** Redacted public length-preserving receipt digest. */
    private extractComposeServiceNames(composeYaml: string): string[] {
    try {
      const model = validateComposeYaml(composeYaml);
      return Object.keys(model.services ?? {});
    } catch {
      return [];
    }
  }

  private serviceNames(source: AppRow["source"]) {
    if (!source) return [];
    return Array.isArray(source.services) ? source.services.map(s => String((s as { name?: unknown }).name)) : [];
  }


  async runtimePreparation(vpsId: string, body: unknown) {
    const input = confirmation.extend({ pluginRequired: z.literal(true), actor }).strict().parse(body);
    const inv = await this.gate(vpsId, true);
    return this.repo.transaction(state => {
      const prior = state.operations.find(o => o.vpsId === vpsId && o.kind === "runtime_prep" && o.idempotencyKey === input.idempotencyKey);
      if (prior) { if (prior.requestDigest !== digest(input)) throw new ConflictException("idempotency_conflict"); return prior; }
      if (state.operations.some(o => o.vpsId === vpsId && !terminalOp(o))) throw new ConflictException("vps_operation_busy");
      const op: WorkRow = { id: createHash("sha256").update(JSON.stringify([vpsId, "runtime_prep", input.idempotencyKey])).digest("hex").slice(0, 21), vpsId, appId: "", kind: "runtime_prep", status: "prepared", request: { pluginRequired: true, daemonEpoch: String(inv!.daemonEpoch), agentInstanceId: inv!.agentInstanceId }, generation: 0, idempotencyKey: input.idempotencyKey, requestDigest: digest(input), createdAt: now(), updatedAt: now(), actor: this.actorOf(input.actor) };
      state.operations.push(op);
      return op;
    });
  }

  async vpsOperation(vpsId: string, opId: string) {
    return this.repo.transaction(state => {
      const op = state.operations.find(o => o.id === opId && o.vpsId === vpsId);
      if (!op) throw new NotFoundException("Operation not found");
      return this.publicOperation(op);
    });
  }

  async operation(vpsId: string, appId: string, opId: string) {
    return this.repo.transaction(state => {
      this.app(state, vpsId, appId);
      const op = state.operations.find(o => o.id === opId && o.appId === appId);
      if (!op) throw new NotFoundException("Operation not found");
      return this.publicOperation(op);
    });
  }

  /** Byzantine-safe durable manifest for exact owned-container removal. */
  /** Rebuilds the approved preview binding from the stored encrypted resolution. */
  private decodeApprovedPreview(preview: PreviewRow, keyring: Keyring) {
    if (!preview.digest || !preview.resolvedModelEnvelope) return undefined;
    const model = JSON.parse(decryptComposeField(preview.resolvedModelEnvelope, { vpsId: preview.vpsId, appId: preview.appId, field: "resolvedModel", version: preview.revisionSeq }, keyring)) as { canonicalModelJson: string; redactedModel: Record<string, unknown>; imageDigests: Record<string, string>; removedServiceIds: string[]; removals?: { serviceName: string; containerKeys: string[] }[]; ownershipBinding?: { agentInstanceId: string; daemonEpoch: string; projectName: string }; inventoryFingerprint?: string; observedFingerprint?: string; secretVersions: Record<string, number>; credentialVersions?: Record<string, number> };
    return { digest: preview.digest, canonicalModelJson: model.canonicalModelJson, redactedModel: model.redactedModel, imageDigests: model.imageDigests, removedServiceIds: model.removedServiceIds, removals: model.removals, ownershipBinding: model.ownershipBinding, inventoryFingerprint: model.inventoryFingerprint, observedFingerprint: model.observedFingerprint ?? "", secretVersions: model.secretVersions, credentialVersions: model.credentialVersions ?? {}, revisionSeq: preview.revisionSeq };
  }

  private ownerManifestVerified(app: AppRow, manifest: AppRow["ownerManifest"]) {
    if (!manifest || manifest.projectName !== app.projectName || manifest.agentInstanceId !== app.agentInstanceId || manifest.daemonEpoch !== app.daemonEpoch) throw new ConflictException("ownership_manifest_invalid");
    return manifest;
  }

    async adoptionPreview(vpsId: string, appId: string, body: unknown) {
    const input = confirmation.extend({
      composeYaml: z.string().max(262_144),
      variables: z.union([
        z.record(z.string().max(16_384)),
        z.object({
          nonSecretValues: z.record(z.string().max(16_384)),
          secretNameToggles: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(256).default([]),
        }).strict(),
      ]).optional(),
      profiles: z.array(z.string().max(128)).max(64).default([]),
      oneShotServices: z.array(z.string().max(128)).max(64).default([]),
      registryCredentialIds: z.array(z.string().max(128)).max(32).default([]),
      secretValues: z.record(z.string().max(16_384)).optional(),
    }).strict().parse(body);

    const inv = await this.gate(vpsId, true);
    const secretNameToggles = input.variables && "nonSecretValues" in input.variables ? input.variables.secretNameToggles : undefined;
    validateComposeYaml(input.composeYaml, secretNameToggles === undefined ? undefined : [...secretNameToggles]);

    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      const project = inv?.projects.find(p => p.project === app.projectName);
      if (!app.source?.verified) {
        return { adoptionDigest: "", differences: ["verified_source_required"], warnings: [{ reason: "verified_source_required" }], runtimeReady: false, projectServices: project?.services?.map(s => s.service) ?? [] };
      }

      const projectServiceNames = project?.services?.map(s => s.service) ?? [];
      const parsedServices = this.extractComposeServiceNames(input.composeYaml);
      const differences: string[] = [];
      for (const svc of parsedServices) {
        if (!projectServiceNames.includes(svc)) differences.push(`service_not_observed: ${svc}`);
      }
      for (const svc of projectServiceNames) {
        if (!parsedServices.includes(svc)) differences.push(`service_not_in_config: ${svc}`);
      }

      const adoptionDigest = digest({
        vpsId,
        appId,
        projectName: app.projectName,
        composeYaml: input.composeYaml,
        variables: input.variables ?? {},
        profiles: input.profiles,
        oneShotServices: input.oneShotServices,
        projectServices: [...projectServiceNames].sort(),
        differences: [...differences].sort(),
      });

      return {
        adoptionDigest,
        differences,
        warnings: differences.map(d => ({ reason: d })),
        runtimeReady: differences.length === 0 && Boolean(project),
        projectServices: projectServiceNames,
      };
    });
  }

    async adopt(vpsId: string, appId: string, body: unknown) {
    const input = confirmation.extend({
      displayName: z.string().trim().min(1).max(120).optional(),
      composeYaml: z.string().max(262_144),
      variables: z.union([
        z.record(z.string().max(16_384)),
        z.object({
          nonSecretValues: z.record(z.string().max(16_384)),
          secretNameToggles: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(256).default([]),
        }).strict(),
      ]).optional(),
      profiles: z.array(z.string().max(128)).max(64).default([]),
      oneShotServices: z.array(z.string().max(128)).max(64).default([]),
      registryCredentialIds: z.array(z.string().max(128)).max(32).default([]),
      secretValues: z.record(z.string().max(16_384)).optional(),
      adoptionDigest: z.string().regex(/^[a-f0-9]{64}$/),
      approvedDifferences: z.array(z.string()).default([]),
    }).strict().parse(body);

    const inv = await this.gate(vpsId, true);
    const keys = await loadComposeKeyring(this.config.composeCrypto.keyringFile);
    const secretNameToggles = input.variables && "nonSecretValues" in input.variables ? input.variables.secretNameToggles : undefined;
    validateComposeYaml(input.composeYaml, secretNameToggles === undefined ? undefined : [...secretNameToggles]);

    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      this.idle(state, appId);
      const source = app.source as { verified?: boolean; path?: string; digest?: string } | undefined;
      if (!source?.verified) throw new ConflictException("verified_source_required");

      const project = inv?.projects.find(p => p.project === app.projectName);
      if (!project) throw new ConflictException("project_not_observed");

      const projectServiceNames = project.services.map(s => s.service);
      const parsedServices = this.extractComposeServiceNames(input.composeYaml);
      const expectedDifferences: string[] = [];
      for (const svc of parsedServices) {
        if (!projectServiceNames.includes(svc)) expectedDifferences.push(`service_not_observed: ${svc}`);
      }
      for (const svc of projectServiceNames) {
        if (!parsedServices.includes(svc)) expectedDifferences.push(`service_not_in_config: ${svc}`);
      }

      const expectedDigest = digest({
        vpsId,
        appId,
        projectName: app.projectName,
        composeYaml: input.composeYaml,
        variables: input.variables ?? {},
        profiles: input.profiles,
        oneShotServices: input.oneShotServices,
        projectServices: [...projectServiceNames].sort(),
        differences: [...expectedDifferences].sort(),
      });

      if (input.adoptionDigest !== expectedDigest) throw new ConflictException("adoption_digest_mismatch");
      const approvedSet = new Set(input.approvedDifferences);
      for (const diff of expectedDifferences) {
        if (!approvedSet.has(diff)) throw new ConflictException("unapproved_differences_present");
      }

      const containers = project.services.flatMap(s => s.replicas.map(r => ({ containerKey: r.containerKey, service: s.service })));
      app.ownerManifest = {
        agentInstanceId: inv!.agentInstanceId,
        daemonEpoch: String(inv!.daemonEpoch),
        projectName: app.projectName,
        adoptedFromSourcePath: source.path,
        adoptedFromSourceDigest: source.digest,
        containers,
      };

      if (input.secretValues) {
        for (const [sName, sValue] of Object.entries(input.secretValues)) {
          const prev = state.secrets.find(s => s.appId === appId && s.name === sName);
          const version = (prev?.version ?? 0) + 1;
          const sRow = {
            id: prev?.id ?? createHash("sha256").update(JSON.stringify([vpsId, appId, sName])).digest("hex").slice(0, 16),
            vpsId,
            appId,
            name: sName,
            version,
            envelope: encryptComposeField(sValue, { vpsId, appId, field: "secret", version: `${sName}:${version}` }, keys),
            updatedAt: now(),
          };
          if (prev) Object.assign(prev, sRow); else state.secrets.push(sRow);
        }
      }

      const seq = 1;
      state.revisions.push({
        id: createHash("sha256").update(JSON.stringify([appId, seq, Date.now()])).digest("hex").slice(0, 16),
        appId,
        vpsId,
        seq,
        envelope: encryptComposeField(JSON.stringify({ composeYaml: input.composeYaml, variables: input.variables ?? {} }), { vpsId, appId, field: "composeYaml", version: seq }, keys),
        variables: {},
        profiles: input.profiles,
        oneShotServices: input.oneShotServices,
        createdAt: now(),
      });

      if (input.displayName) app.displayName = input.displayName;
      app.mode = "managed";
      app.generation++;
      app.updatedAt = now();
      for (const p of state.previews) if (p.appId === appId) p.status = "stale";

      return app;
    });
  }

  async confirmPreview(vpsId: string, appId: string, previewId: string, body: unknown) {
    const input = confirmation.extend({ approvedDigest: z.string().regex(/^[a-f0-9]{64}$/), removedServiceIds: z.array(z.string().max(128)).max(64), actor }).strict().parse(body);
    await this.gate(vpsId, true);
    return this.repo.transaction(state => {
      const app = this.app(state, vpsId, appId);
      const existing = state.operations.find(op => op.appId === appId && op.kind === "deploy" && op.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== digest(input)) throw new ConflictException("idempotency_conflict");
        return existing;
      }
      const p = state.previews.find(x => x.id === previewId && x.appId === appId);
      if (!p || (p.status as string) !== "ready" || Date.parse(p.expiresAt) <= Date.now() || p.digest !== input.approvedDigest || p.generation !== app.generation) throw new ConflictException("stale_preview");
      if (digest((p.removedServices as string[] | undefined) ?? []) !== digest(input.removedServiceIds)) throw new ConflictException("removed_services_confirmation_mismatch");
      // Input fencing: only bounded durable values are persisted in the
      // manifest and preview-to-deploy binding; nothing in-flight is trusted.
      this.idle(state, appId);
      const operation: WorkRow = { id: createHash("sha256").update(JSON.stringify([vpsId, appId, previewId, input.idempotencyKey])).digest("hex").slice(0, 21), vpsId, appId, kind: "deploy", status: "prepared", request: { previewId, approvedDigest: input.approvedDigest, removedServiceIds: input.removedServiceIds, revisionSeq: p.revisionSeq }, generation: app.generation, idempotencyKey: input.idempotencyKey, requestDigest: digest(input), createdAt: now(), updatedAt: now(), actor: this.actorOf(input.actor) };
      state.operations.push(operation);
      p.status = "confirmed";
      return operation;
    });
  }

  async secretMetadata(vpsId: string, appId: string, name: string) {
    return this.repo.transaction(state => {
      this.app(state, vpsId, appId);
      const s = state.secrets.find(x => x.vpsId === vpsId && x.appId === appId && x.name === name);
      if (!s) throw new NotFoundException("Secret not found");
      return { name: s.name, version: s.version, updatedAt: s.updatedAt };
    });
  }

  async deleteSecret(vpsId: string, appId: string, name: string, body: unknown) {
    confirmation.strict().parse(body);
    await this.gate(vpsId);
    return this.repo.transaction(state => {
      this.app(state, vpsId, appId);
      this.idle(state, appId);
      const ix = state.secrets.findIndex(s => s.vpsId === vpsId && s.appId === appId && s.name === name);
      if (ix < 0) throw new NotFoundException("Secret not found");
      state.secrets.splice(ix, 1);
      for (const p of state.previews) if (p.appId === appId) p.status = "stale";
      return { ok: true };
    });
  }

  async credentials(vpsId: string) {
    return this.repo.transaction(state => state.credentials.filter(c => c.vpsId === vpsId).map(({ id, name, version, updatedAt }) => ({ id, ...registryCredentialIdentity(name), version, updatedAt })));
  }

    async setCredential(vpsId: string, body: unknown) {
    const input = confirmation.extend({ credentialId: z.string().max(128).optional(), host: z.string().min(1).max(255), username: z.string().min(1).max(255), password: z.string().min(1).max(16_384) }).strict().parse(body);
    await this.gate(vpsId);
    const keys = await loadComposeKeyring(this.config.composeCrypto.keyringFile);
    return this.repo.transaction(state => {
      const name = JSON.stringify([input.host.toLowerCase(), input.username]);
      const previous = input.credentialId ? state.credentials.find(c => c.vpsId === vpsId && c.id === input.credentialId) : state.credentials.find(c => c.vpsId === vpsId && c.name === name);
      // Resolve the identity before fencing: POST with the same host/user also replaces.
      const referencesCredential = (op: WorkRow) => {
        if (!previous || op.vpsId !== vpsId) return false;
        if ((op.request?.registryCredentialIds as string[] | undefined)?.includes(previous.id)) return true;
        const linked = typeof op.request?.previewId === "string" ? state.previews.find(p => p.id === op.request.previewId && p.vpsId === vpsId) : undefined;
        return linked?.request.registryCredentialIds.includes(previous.id) === true;
      };
      if (state.operations.some(op => !terminalOp(op) && referencesCredential(op) && (op.authorization !== undefined || op.status === "applying" || op.status === "uncertain"))) throw new ConflictException("credential_in_use");
      const version = (previous?.version ?? 0) + 1;
      const id = previous?.id ?? createHash("sha256").update(JSON.stringify([vpsId, "registry", input.host.toLowerCase(), input.username])).digest("hex").slice(0, 16);
      const row = { id, vpsId, appId: "registry", name, version, envelope: encryptComposeField(input.password, { vpsId, appId: "registry", field: "registryCredential", version }, keys), updatedAt: now() };
      if (previous) Object.assign(previous, row); else state.credentials.push(row);
      for (const preview of state.previews) {
        if (preview.vpsId === vpsId && preview.request.registryCredentialIds.includes(row.id) && (preview.status === "pending" || preview.status === "ready")) {
          preview.status = "stale";
        }
      }
      return { id: row.id, ...registryCredentialIdentity(name), version: row.version, updatedAt: row.updatedAt };
    });
  }

    async deleteCredential(vpsId: string, credentialId: string, body: unknown) {
    confirmation.strict().parse(body);
    await this.gate(vpsId);
    return this.repo.transaction(state => {
      const ix = state.credentials.findIndex(c => c.vpsId === vpsId && c.id === credentialId);
      if (ix < 0) throw new NotFoundException("Credential not found");
      const inUse = state.operations.some(o => !terminalOp(o) && ((o.request?.registryCredentialIds as string[] | undefined)?.includes(credentialId) || (o.request?.previewId && state.previews.find(p => p.id === o.request.previewId)?.request.registryCredentialIds.includes(credentialId))));
      if (inUse) throw new ConflictException("credential_in_use");
      state.credentials.splice(ix, 1);
      for (const p of state.previews) {
        if (p.vpsId === vpsId && p.request.registryCredentialIds.includes(credentialId) && (p.status === "pending" || p.status === "ready")) {
          p.status = "stale";
        }
      }
      return { ok: true };
    });
  }

  private receiptInput(receipt: Receipt) {
    return { executed: receipt.executed, observed: receipt.observed ?? [], error: receipt.error };
  }


  /** Bounded concurrent safe marker for paginated public projections. */
  private paginate<T>(items: T[], cursor: string | undefined, pickup: (item: T) => string, limit: number) {
    const found = cursor ? items.findIndex(i => pickup(i) === cursor) : -1;
    if (cursor && found < 0) return { page: [] as T[], nextCursor: undefined }; // stale/absent cursor: bounded empty page
    const offset = found + 1;
    const page = items.slice(offset, offset + limit);
    return { page, nextCursor: offset + limit < items.length ? pickup(page[page.length - 1]) ?? undefined : undefined };
  }

  /** Bounded actor stamp for durable operation rows (mrVnhE-4: preservations). */
  private actorOf(actor?: { kind: string; id?: string }): { kind: string; id?: string } {
    if (!actor) return { kind: "dashboard" };
    const id = typeof actor.id === "string" && /^[A-Za-z0-9_.~:-]{0,255}$/.test(actor.id) ? actor.id : undefined;
    return { kind: actor.kind.slice(0, 64), id };
  }

  /** Public operation projection: raw claim tokens, claimedBy identity, authorization nonces, and payload digests are server-only. */
  private publicOperation(o: WorkRow) {
    const { claimToken, claimedBy, claimedAt, claimLeaseExpiresAt, authorization, ...safe } = o;
    void claimedAt;
    void claimLeaseExpiresAt;
    const safeAuthorization = authorization ? { id: authorization.id, grantedAt: authorization.grantedAt } : undefined;
    const safeProgress = o.progress ? { seq: o.progress.seq, items: o.progress.items.slice(0, 100) } : undefined;
    return {
      ...safe,
      progress: safeProgress,
      authorization: safeAuthorization,
      lifecyclePlan: o.lifecyclePlan,
      result: this.publicOperationResult(o),
    };
  }

  /** mrVnhE-4: bounded per-app operation history, newest first, actor/evidence preserved for audit. */
  async history(vpsId: string, appId: string, options?: { limit?: number; cursor?: string; actor?: string }) {
    return this.repo.transaction(state => {
      this.app(state, vpsId, appId); // membership fence
      const items = state.operations.filter(o => o.appId === appId).reverse();
      const actorKinds = [...new Set(items.map(op => op.actor?.kind ?? "dashboard"))].sort();
      const actorFilter = typeof options?.actor === "string" && options.actor ? options.actor : undefined;
      const filtered = actorFilter ? items.filter(op => (op.actor?.kind ?? "dashboard") === actorFilter) : items;
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
      const { page, nextCursor } = this.paginate(filtered, options?.cursor, op => op.id, limit);
      return { items: page.map(o => this.publicOperation(o)), actorKinds: actorKinds.slice(0, 64), nextCursor: nextCursor ?? null };
    });
  }

  /** Public result shape: outcome + bounded serviceOutcomes + observedRuntime (never a raw observed body). */
  private publicOperationResult(o: WorkRow) {
    const stored = (o.result ?? {}) as {
      executed?: boolean; error?: string; outcome?: string;
      installPerformed?: boolean; confirmedMode?: string; composeVersion?: string; unsupportedReason?: string; instructions?: string;
      serviceOutcomes?: unknown; observedRuntime?: unknown;
    };
    // Outcome semantics (wire contract): readiness timeout is `failed` with
    // outcome readiness_timeout; other failures flatten to `failed`.
    const outcome = o.status === "uncertain" ? "uncertain"
      : o.status === "failed" ? (stored.error === "readiness_timeout" ? "readiness_timeout" : "failed")
      : o.status === "succeeded" ? "succeeded" : undefined;
    const outcomes = Array.isArray(stored.serviceOutcomes)
      ? (stored.serviceOutcomes as unknown[]).flat().slice(0, 500).map(this.mapServiceOutcome)
      : undefined;
    return {
      outcome,
      executed: stored.executed,
      ...(o.kind === "runtime_prep" ? { installPerformed: stored.installPerformed, confirmedMode: stored.confirmedMode, composeVersion: stored.composeVersion, unsupportedReason: stored.unsupportedReason, instructions: stored.instructions } : {}),
      error: typeof stored.error === "string" ? { message: stored.error.slice(0, 255) } : undefined,
      serviceOutcomes: outcomes,
      observedRuntime: stored.observedRuntime,
    };
  }

  /** Bounded durable per-service outcomes from the reported receipt observation. */
  private extractServiceOutcomes(receipt: Receipt) {
    if (!Array.isArray(receipt.observed)) return undefined;
    for (const raw of receipt.observed) {
      if (raw && typeof raw === "object" && Array.isArray((raw as { serviceOutcomes?: unknown }).serviceOutcomes)) {
        const list = (raw as { serviceOutcomes: unknown[] }).serviceOutcomes;
        return list.length <= 500 ? list : undefined;
      }
    }
    return undefined;
  }

  /** Bounded durable runtime pose (readinessSeconds + ownership binding) on deploy receipts. */
  private extractObservedRuntime(op: WorkRow, receipt: Receipt, app: AppRow) {
    if (!Array.isArray(receipt.observed)) return undefined;
    const observed = receipt.observed.find(o => o?.ownership);
    if (op.kind !== "deploy" || !observed?.ownership || typeof observed.ownership !== "object") return undefined;
    return { readinessSeconds: app.readinessSeconds ?? 300, ownership: observed.ownership };
  }

  /** Normalized bounded per-service {service, outcome, reason} — Go's `status` key folds to `outcome`. */
  private mapServiceOutcome(row: unknown) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    const service = typeof r.service === "string" ? r.service.slice(0, 255) : "";
    const outcome = typeof r.outcome === "string" && r.outcome ? r.outcome.slice(0, 64) : typeof r.status === "string" ? r.status.slice(0, 64) : "";
    const reason = typeof r.reason === "string" ? r.reason.slice(0, 255) : undefined;
    if (!service) return null;
    return reason !== undefined ? { service, outcome, reason } : { service, outcome };
  }
}
