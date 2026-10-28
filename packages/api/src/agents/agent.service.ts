import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import type { AppConfig } from "../config/app-config.js";
import type {
  AgentCredential,
  AgentCredentialScope,
  AgentCredentialStatus,
  AgentMetricPayload,
  AgentState,
} from "./agent.models.js";
import type { MetricSample } from "../metrics/metrics.models.js";
import type { AgentRepository } from "../persistence/repositories/agent.repository.js";
import type { MetricRepository } from "../persistence/repositories/metric.repository.js";
import type { VpsRepository } from "../persistence/repositories/vps.repository.js";
import {
  AGENT_REPOSITORY,
  APP_CONFIG,
  METRIC_REPOSITORY,
  VPS_REPOSITORY,
} from "../tokens.js";
import { agentMetricPayloadSchema } from "./agent.schemas.js";
import { VpsNotFoundError } from "../common/errors.js";
import { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import { DockerMonitoringService } from "../docker/docker-monitoring.service.js";
import type { DockerIngestResult } from "../docker/docker-monitoring.models.js";

export type IngestMetricResult = {
  sample: MetricSample;
  config: { dockerMetricsEnabled: boolean };
  docker?: {
    ingestStatus: DockerIngestResult["ingestStatus"];
    snapshotId: string;
    agentInstanceId: string;
    batchId?: string;
    committedWatermark?: DockerIngestResult["committedWatermark"];
    revision: number;
    capabilities: {
      history: true;
      containerHistory: true;
      events: true;
      storage: true;
    };
  };
};

// ── Token format ────────────────────────────────────────────────────────
//   vma_<credentialId>_<secret>
//   The <secret> is 32 random bytes hex-encoded (64 hex chars).
//   Only the SHA-256 hash of the secret is stored server-side.

const TOKEN_PREFIX = "vma_";

function omitDockerField(payload: AgentMetricPayload): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const { docker: _docker, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/**
 * Extract the credential id from a raw agent token.
 * Token format: vma_<credentialId>_<secret>
 * Uses lastIndexOf('_') to separate credentialId (may contain underscores
 * from nanoid) from the secret (hex-encoded, no underscores).
 * Returns undefined if the token format is invalid.
 */
function parseToken(
  token: string,
): { credentialId: string; secret: string } | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const body = token.slice(TOKEN_PREFIX.length);
  // Last underscore separates credentialId from secret (secret is hex, no underscores)
  const lastUnderscore = body.lastIndexOf("_");
  if (lastUnderscore < 1) return undefined;
  return {
    credentialId: body.slice(0, lastUnderscore),
    secret: body.slice(lastUnderscore + 1),
  };
}

/**
 * Hash a secret using SHA-256 and return the hex digest.
 */
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ── Service ─────────────────────────────────────────────────────────────

@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_REPOSITORY) private readonly agentRepository: AgentRepository,
    @Inject(METRIC_REPOSITORY)
    private readonly metricRepository: MetricRepository,
    @Inject(VPS_REPOSITORY) private readonly vpsRepository: VpsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AgentLifecycleCoordinator)
    private readonly lifecycle: AgentLifecycleCoordinator,
    @Inject(DockerMonitoringService)
    private readonly dockerMonitoringService: DockerMonitoringService,
  ) {}

  /**
   * Create a new agent credential and return the raw token.
   * The raw token is only returned once — the secret is hashed before storage.
   * Never log or persist the raw token.
   * Throws VpsNotFoundError if the VPS does not exist.
   */
  async createCredential(
    vpsId: string,
    status?: AgentCredentialStatus,
    scope?: AgentCredentialScope,
  ): Promise<{ credential: AgentCredential; token: string }> {
    // Verify VPS exists before creating credential
    const vps = await this.vpsRepository.get(vpsId);
    if (!vps) {
      throw new VpsNotFoundError();
    }

    const secret = randomBytes(32).toString("hex");
    const secretHash = hashSecret(secret);

    const credential = await this.agentRepository.createCredential({
      vpsId,
      secretHash,
      status: status ?? "active",
      ...(scope ? { scope } : {}),
    });

    const token = `${TOKEN_PREFIX}${credential.id}_${secret}`;
    return { credential, token };
  }

  async createInstallCredential(
    vpsId: string,
    jobId: string,
  ): Promise<{ credential: AgentCredential; token: string; state: AgentState }> {
    const vps = await this.vpsRepository.get(vpsId);
    if (!vps) throw new VpsNotFoundError();
    const secret = randomBytes(32).toString("hex");
    const credential = await this.agentRepository.createInstallCredential(
      {
        vpsId,
        secretHash: hashSecret(secret),
        status: "pending",
      },
      { vpsId, status: "installing", lastInstallJobId: jobId },
    );
    const state = await this.agentRepository.getState(vpsId);
    if (!state) throw new Error("Failed to persist installing agent state");
    return { credential, token: `${TOKEN_PREFIX}${credential.id}_${secret}`, state };
  }

  /**
   * Verify a bearer token header and return the associated credential.
   * Throws UnauthorizedException if the token is invalid, revoked, or malformed.
   */
  async verifyBearerToken(
    header: string | undefined,
  ): Promise<AgentCredential> {
    if (!header) {
      throw new UnauthorizedException({
        error: { message: "Missing authorization header" },
      });
    }
    if (!header.startsWith("Bearer ")) {
      throw new UnauthorizedException({
        error: { message: "Invalid authorization header format" },
      });
    }

    const rawToken = header.slice("Bearer ".length).trim();
    const parsed = parseToken(rawToken);
    if (!parsed) {
      throw new UnauthorizedException({
        error: { message: "Invalid token format" },
      });
    }

    const credential = await this.agentRepository.getCredential(
      parsed.credentialId,
    );
    if (!credential) {
      throw new UnauthorizedException({ error: { message: "Invalid token" } });
    }

    // Hash the provided secret and compare using timing-safe equality
    const providedHash = hashSecret(parsed.secret);
    const storedHash = credential.secretHash;

    if (providedHash.length !== storedHash.length) {
      throw new UnauthorizedException({ error: { message: "Invalid token" } });
    }

    if (
      !timingSafeEqual(
        Buffer.from(providedHash, "hex"),
        Buffer.from(storedHash, "hex"),
      )
    ) {
      throw new UnauthorizedException({ error: { message: "Invalid token" } });
    }

    if (credential.status === "revoked") {
      throw new UnauthorizedException({
        error: { message: "Token has been revoked" },
      });
    }

    return credential;
  }

  /**
   * Bearer verification for agent-facing routes (metrics, commands, docker).
   * The local-updater credential is scoped to upgrade job pulls only and is
   * rejected here — scope isolation, not just route placement.
   */
  async verifyAgentBearerToken(
    header: string | undefined,
  ): Promise<AgentCredential> {
    const credential = await this.verifyBearerToken(header);
    if (credential.scope === "local-updater") {
      throw new ForbiddenException({
        error: {
          message: "Credential is not scoped for agent metrics or commands",
          code: "invalid_credential_scope",
        },
      });
    }
    return credential;
  }

  /**
   * Revoke a credential by id.
   */
  async revokeCredential(id: string): Promise<void> {
    await this.agentRepository.revokeCredential(id);
  }

  /**
   * Ingest a metric payload from an authenticated agent.
   *
   * - Auto-activates pending credentials on first use.
   * - Updates credential lastUsedAt / lastUsedIp.
   * - Updates agent state (status, version, lastSeenAt).
   * - Validates the payload against the strict schema.
   * - Appends the metric sample to the repository.
   *
   * Never logs or returns the raw token.
   */
  async ingestMetric(
    credential: AgentCredential,
    payload: AgentMetricPayload,
    ip?: string,
  ): Promise<IngestMetricResult> {
    const releaseIngest = await this.lifecycle.beginIngest(credential.vpsId);
    try {
      // 1. Verify the VPS still exists and get its config before validating the
      // optional Docker branch. Docker payloads are ignored when disabled, so a
      // stale agent cycle cannot break core metric ingest with Docker-only schema
      // errors.
      if (this.lifecycle.isUninstalling(credential.vpsId))
        throw new UnauthorizedException({
          error: { message: "Agent lifecycle operation in progress" },
        });
      const currentCredential = await this.agentRepository.getCredential(
        credential.id,
      );
      if (!currentCredential || currentCredential.status === "revoked")
        throw new UnauthorizedException({
          error: { message: "Token has been revoked" },
        });
      credential = currentCredential;
      if (credential.scope === "local-updater") {
        throw new ForbiddenException({
          error: {
            message: "Credential is not scoped for agent metrics or commands",
            code: "invalid_credential_scope",
          },
        });
      }
      const vps = await this.vpsRepository.get(credential.vpsId);
      if (!vps) {
        throw new VpsNotFoundError();
      }

      const dockerMetricsEnabled = vps.dockerMetricsEnabled ?? false;
      const config = dockerMetricsEnabled
        ? {
            dockerMetricsEnabled: true,
            history: true as const,
            containerHistory: true as const,
            events: true as const,
            storage: true as const,
          }
        : { dockerMetricsEnabled: false };
      // 2. Validate payload
      let parsed: AgentMetricPayload;
      try {
        parsed = agentMetricPayloadSchema.parse(
          dockerMetricsEnabled ? payload : omitDockerField(payload),
        ) as unknown as AgentMetricPayload;
      } catch (error: unknown) {
        if (error instanceof ZodError) {
          throw error;
        }
        throw error;
      }


      // 3. If vpsId is provided in payload, it must match the credential owner
      if (parsed.vpsId !== undefined && parsed.vpsId !== credential.vpsId) {
        throw new UnauthorizedException({
          error: { message: "VPS ID mismatch" },
        });
      }

      const now = new Date().toISOString();

      // Credential admission, usage, and online state share the repository's
      // per-VPS transaction fence. A stale ingest therefore cannot resurrect a
      // state after reconciliation revoked its credential.
      const accepted = await this.agentRepository.acceptHeartbeat({
        credentialId: credential.id,
        vpsId: credential.vpsId,
        lastUsedAt: now,
        ...(ip !== undefined ? { lastUsedIp: ip } : {}),
        version: parsed.agentVersion,
        buildId: parsed.buildId,
        lastSeenAt: now,
      });
      if (!accepted) {
        throw new UnauthorizedException({
          error: { message: "Token has been revoked" },
        });
      }
      credential = accepted;

      // 7. If system info provided, upsert it (before metric append)
      if (parsed.system) {
        await this.agentRepository.upsertSystemInfo({
          vpsId: credential.vpsId,
          collectedAt: parsed.collectedAt,
          receivedAt: now,
          agentVersion: parsed.agentVersion,
          ...parsed.system,
        });
      }

      // 8. Canonical Docker observations use the durable monitoring ingest path.
      let docker: IngestMetricResult["docker"];
      if (parsed.docker && dockerMetricsEnabled) {
        const credentials = await this.agentRepository.listCredentialsByVps(
          credential.vpsId,
        );
        const activeOrPending = credentials.filter(
          (c) => c.status !== "revoked" && (c.scope ?? "agent") === "agent",
        );
        activeOrPending.sort((a, b) => {
          const timeA = Date.parse(a.createdAt) || 0;
          const timeB = Date.parse(b.createdAt) || 0;
          if (timeB !== timeA) return timeB - timeA;
          return b.id.localeCompare(a.id);
        });
        const authoritativeId = activeOrPending[0]?.id;
        const isCurrentGeneration = credential.id === authoritativeId;

        const result = await this.dockerMonitoringService.ingest(
          credential.vpsId,
          parsed.docker,
          now,
          {
            credentialId: credential.id,
            credentialCreatedAt: credential.createdAt,
            isCurrentGeneration,
          },
        );
        docker = {
          ingestStatus: result.ingestStatus,
          snapshotId: result.snapshotId,
          agentInstanceId: result.agentInstanceId,
          ...(result.batchId ? { batchId: result.batchId } : {}),
          ...(result.committedWatermark
            ? { committedWatermark: result.committedWatermark }
            : {}),
          revision: result.revision,
          capabilities: {
            history: true,
            containerHistory: true,
            events: true,
            storage: true,
          },
        };
      }
      // When dockerMetricsEnabled is false, any Docker payload is silently ignored.

      // Persist only agent-owned location fields through the dedicated method.
      if (parsed.location) {
        await this.vpsRepository.updateAgentLocation(
          credential.vpsId,
          parsed.location,
        );
      }

      // 9. Build metric sample and append
      const sample: MetricSample = {
        vpsId: credential.vpsId,
        cpu: parsed.cpu,
        memory: parsed.memory,
        disk: parsed.disk,
        loadAverage: parsed.loadAverage,
        networkRx: parsed.networkRx,
        networkTx: parsed.networkTx,
        uptime: parsed.uptime,
        collectedAt: parsed.collectedAt,
        receivedAt: now,
        source: "agent",
        agentVersion: parsed.agentVersion,
        ...(parsed.networkUnit !== undefined
          ? { networkUnit: parsed.networkUnit }
          : {}),
        ...(parsed.networkAvailable !== undefined
          ? { networkAvailable: parsed.networkAvailable }
          : {}),
      };

      await this.metricRepository.append(sample, this.config.metricWindowLimit);

      // Mark host health only after the accepted observation is durably appended.
      await this.vpsRepository.markSeen(credential.vpsId, "healthy", now);
      return { sample, config, ...(docker ? { docker } : {}) };
    } finally {
      releaseIngest();
    }
  }
}
