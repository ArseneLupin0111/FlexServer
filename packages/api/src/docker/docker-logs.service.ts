import { randomUUID } from "node:crypto";
import type { Response } from "express";
import {
  Inject,
  Injectable,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleDestroy,
} from "@nestjs/common";
import { APP_CONFIG } from "../tokens.js";
import type { AppConfig } from "../config/app-config.js";
import { DashboardSessionService } from "../auth/dashboard-session.service.js";
import type { AgentCredential } from "../agents/agent.models.js";
import { DockerManagementService } from "./docker-management.service.js";
import {
  DOCKER_LOG_ERROR_CODES,
  DOCKER_LOGS_MAX_BODY_BYTES,
  DOCKER_LOGS_MAX_FRAME_BYTES,
  DOCKER_LOGS_SSE_CLOSED,
  DOCKER_LOGS_SSE_LINES,
  DOCKER_LOGS_SSE_STATE,
  DOCKER_LOGS_TAIL_LINES,
  dockerLogsChunksRequestSchema,
  dockerLogsChunksResponseSchema,
  dockerLogsClaimRequestSchema,
  dockerLogsClaimResponseSchema,
  dockerLogsClosedEventSchema,
  dockerLogsLinesEventSchema,
  dockerLogsResultRequestSchema,
  dockerLogsResultResponseSchema,
  dockerLogsStateEventSchema,
  type DockerLogErrorCode,
  type DockerLogsClaimRequest,
  type DockerLogsClaimResponse,
} from "./docker-logs.schemas.js";

/** Wire shape of one claimed subscription (mirrors the agent's protocol). */
export type DockerLogsSubscription = NonNullable<
  DockerLogsClaimResponse["data"]["subscription"]
>;

// ── Tunables (plan §3) ────────────────────────────────────────────────

/** Maximum concurrent log streams for a single VPS. */
const MAX_STREAMS_PER_VPS = 4;
/** Maximum concurrent log streams on this API instance. */
const MAX_STREAMS_TOTAL = 32;
/** A claim must arrive and report ready within this window of the viewer opening. */
const CLAIM_READY_TIMEOUT_MS = 30_000;
/** After going live, silence (no batch and no heartbeat) longer than this is a lost source. */
const STREAM_IDLE_TIMEOUT_MS = 10_000;
/** Hard cap on a single subscription's lifetime; reconnect opens a new window. */
const MAX_SUBSCRIPTION_MS = 2 * 60 * 60 * 1000;
/** Policy/session revalidation cadence, which doubles as the SSE keepalive cadence. */
const REVALIDATE_INTERVAL_MS = 15_000;

const ERROR_CODE_LOOKUP: Record<DockerLogErrorCode, true> =
  Object.fromEntries(DOCKER_LOG_ERROR_CODES.map((code) => [code, true])) as Record<
    DockerLogErrorCode,
    true
  >;

export type DockerLogStreamQuery = {
  vpsId: string;
  agentInstanceId: string;
  containerKey: string;
};

export type DockerLogsSessionContext = {
  /** Set by the dashboard guard in local mode; absent in demo. */
  dashboardSessionId?: string;
  /** True when the request carries a local-mode dashboard session. */
  localMode: boolean;
};

export type DockerLogsPolicySnapshot = {
  logsSupported: boolean;
  targets: Array<{
    agentInstanceId: string;
    containerKey: string;
    name: string;
    image?: string;
    state?: string;
  }>;
};

type SubscriptionStatus = "waiting" | "claimed" | "live" | "closed";

type RegistryEntry = {
  subscriptionId: string;
  vpsId: string;
  agentInstanceId: string;
  containerKey: string;
  tailLines: typeof DOCKER_LOGS_TAIL_LINES;
  createdAt: number;
  expiresAt: number;
  claimedAt?: number;
  liveAt?: number;
  closedAt?: number;
  status: SubscriptionStatus;
  /** Last accepted sequence; 0 before the agent's first chunk/heartbeat. */
  sequence: number;
  closeReason?: "completed" | "failed" | "expired";
  closeErrorCode?: DockerLogErrorCode;
  response: Response & { flush?: () => void };
  detachResponse?: () => void;
  claimReadyTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  keepaliveTimer?: NodeJS.Timeout;
  revalidateTimer?: NodeJS.Timeout;
};

/** Raised before headers are written: carries the HTTP status to answer with. */
export class DockerLogsPolicyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "DockerLogsPolicyError";
  }
}

/** Raised for an unknown or already-closed subscription id. */
export class DockerLogsSubscriptionMissingError extends Error {
  constructor(readonly status: 404 | 410) {
    super(status === 410 ? "subscription_closed" : "subscription_not_found");
    this.name = "DockerLogsSubscriptionMissingError";
  }
}

/** Raised when the reported sequence is not the next expected one. */
export class DockerLogsSequenceError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super("sequence_mismatch");
    this.name = "DockerLogsSequenceError";
  }
}

/** Raised for a body that violates the log-stream wire contract. */
export class DockerLogsProtocolError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
  ) {
    super(code);
    this.name = "DockerLogsProtocolError";
  }
}

export type DockerLogsChunksResult = {
  ok: true;
  subscriptionId: string;
  sequence: number;
};

export type DockerLogsResultResult = {
  ok: true;
  subscriptionId: string;
  agentInstanceId: string;
};

/**
 * Ephemeral broker for realtime container logs.
 *
 * The registry holds only in-flight subscriptions — no log content, no
 * history, no persistence, no audit of line data. A subscription exists from
 * the moment a browser opens the SSE response until teardown: browser
 * disconnect, policy or session loss, expiry, or the agent reporting its
 * outcome. Every code path that ends a subscription runs the same idempotent
 * close, so a cancelled viewer can never leak a timer or a registry slot.
 */
@Injectable()
export class DockerLogsService implements OnModuleDestroy, OnApplicationShutdown {
  private readonly subscriptions = new Map<string, RegistryEntry>();
  private readonly closedSubscriptions = new Map<
    string,
    { vpsId: string; agentInstanceId: string }
  >();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DockerManagementService)
    private readonly dockerManagement: DockerManagementService,
    @Inject(DashboardSessionService)
    private readonly dashboardSessions: DashboardSessionService,
  ) {}

  // ── Dashboard: open a stream ─────────────────────────────────────────

  /**
   * Validates policy and target, registers the subscription, writes the SSE
   * headers and the initial `waiting` frame. Rejects with
   * `DockerLogsPolicyError` before any header is written on policy failure,
   * so the caller can answer a plain JSON error. After resolving, all
   * writes to `res` belong to this service.
   */
  async open(
    res: Response,
    query: DockerLogStreamQuery,
    session: DockerLogsSessionContext,
  ): Promise<DockerLogsSubscription> {
    const policy = await this.policySnapshot(query.vpsId);
    if (this.config.mode !== "local") {
      // Realtime logs need a real agent-backed source; demo never fakes one.
      throw new DockerLogsPolicyError(403, "logs_unavailable");
    }
    if (!policy.logsSupported) {
      throw new DockerLogsPolicyError(403, "logs_unavailable");
    }
    const target = policy.targets.find(
      (candidate) =>
        candidate.agentInstanceId === query.agentInstanceId &&
        candidate.containerKey === query.containerKey,
    );
    if (!target) {
      throw new DockerLogsPolicyError(404, "container_not_found");
    }

    const active = [...this.subscriptions.values()];
    if (active.length >= MAX_STREAMS_TOTAL) {
      throw new DockerLogsPolicyError(429, "too_many_streams");
    }
    if (
      active.filter((entry) => entry.vpsId === query.vpsId).length >=
      MAX_STREAMS_PER_VPS
    ) {
      throw new DockerLogsPolicyError(429, "too_many_streams_for_vps");
    }

    const now = Date.now();
    const subscriptionId = `dlog_${randomUUID()}`;
    const entry: RegistryEntry = {
      subscriptionId,
      vpsId: query.vpsId,
      agentInstanceId: query.agentInstanceId,
      containerKey: query.containerKey,
      tailLines: DOCKER_LOGS_TAIL_LINES,
      createdAt: now,
      expiresAt: now + MAX_SUBSCRIPTION_MS,
      status: "waiting",
      sequence: 0,
      response: res,
    };

    // Response listeners are attached before the subscription becomes
    // claimable, so an instant browser disconnect can never orphan an entry
    // the agent already picked up.
    entry.detachResponse = this.attachResponseHandlers(entry);
    this.subscriptions.set(subscriptionId, entry);

    // Arm timers before writing any frames: if the write buffer is saturated
    // or the socket fails on write, close() can cleanly release all timers
    // instead of leaking intervals scheduled after close.
    entry.claimReadyTimer = setTimeout(() => {
      if (entry.status === "waiting" || entry.status === "claimed") {
        this.close(entry, "failed", "agent_unavailable");
      }
    }, CLAIM_READY_TIMEOUT_MS);
    entry.keepaliveTimer = setInterval(() => {
      this.writeRaw(entry, ": keepalive\n\n");
    }, REVALIDATE_INTERVAL_MS);
    entry.expiryTimer = setTimeout(() => {
      this.close(entry, "expired");
    }, MAX_SUBSCRIPTION_MS);
    this.armIdleTimeout(entry);
    this.armRevalidation(entry, session);

    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    } catch (error) {
      // Header or socket failure before the first frame: release the slot
      // rather than orphaning an entry the viewer never received.
      this.close(entry, "failed", "logs_unavailable");
      throw error;
    }
    // The waiting frame may itself saturate the socket and close the entry
    // via slow_consumer; timers were armed above so close() releases them.
    this.writeFrame(
      entry,
      DOCKER_LOGS_SSE_STATE,
      dockerLogsStateEventSchema.parse({
        subscriptionId,
        status: "waiting",
      }),
    );

    return {
      subscriptionId,
      vpsId: entry.vpsId,
      agentInstanceId: entry.agentInstanceId,
      containerKey: entry.containerKey,
      tailLines: entry.tailLines,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  // ── Agent: claim ────────────────────────────────────────────────────

  /**
   * Atomically moves the oldest waiting subscription for this VPS + instance
   * to `claimed`. Returns null when there is nothing to claim, which covers
   * both an empty queue and every denied policy state — policy never leaks.
   * A claimed subscription is never handed out twice.
   */
  async claim(
    credential: AgentCredential,
    body: DockerLogsClaimRequest,
  ): Promise<DockerLogsSubscription | null> {
    const parsed = dockerLogsClaimRequestSchema.parse(body);
    const now = Date.now();
    const candidates = [...this.subscriptions.values()]
      .filter(
        (entry) =>
          entry.vpsId === credential.vpsId &&
          entry.agentInstanceId === parsed.agentInstanceId &&
          entry.status === "waiting",
      )
      .sort((a, b) => a.createdAt - b.createdAt);

    const entry = candidates[0];
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.close(entry, "expired");
      return null;
    }
    // Flip synchronously before any await so a concurrent claim can never
    // hand out the same entry twice; the async policy recheck below either
    // confirms the handoff or releases it.
    entry.status = "claimed";
    entry.claimedAt = now;
    if (!(await this.assertCurrentPolicy(entry))) {
      this.close(entry, "failed", "logs_unavailable");
      return null;
    }
    if (
      entry.status !== "claimed" ||
      !this.subscriptions.has(entry.subscriptionId)
    ) {
      // Lost the claim while rechecking (viewer left, timer fired).
      return null;
    }
    return {
      subscriptionId: entry.subscriptionId,
      vpsId: entry.vpsId,
      agentInstanceId: entry.agentInstanceId,
      containerKey: entry.containerKey,
      tailLines: entry.tailLines,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  // ── Agent: chunks ───────────────────────────────────────────────────

  /**
   * Accepts one ordered batch (or heartbeat) from the claiming agent.
   * Sequence must be exactly the next expected number; anything else is a
   * 409, because retrying an already-delivered batch would duplicate lines
   * in the viewer.
   */
  async chunks(
    credential: AgentCredential,
    subscriptionId: string,
    body: unknown,
  ): Promise<DockerLogsChunksResult> {
    this.assertBodySize(body);
    const parsed = dockerLogsChunksRequestSchema.parse(body);
    const entry = this.requireEntry(
      credential,
      subscriptionId,
      parsed.agentInstanceId,
    );

    if (!(await this.assertCurrentPolicy(entry))) {
      this.close(entry, "failed", "logs_unavailable");
      throw new DockerLogsSubscriptionMissingError(410);
    }

    if (!parsed.ready) {
      // The source only uploads after Docker answered 2xx, so a not-ready
      // chunk is a contract violation, not a retryable race.
      throw new DockerLogsProtocolError(409, "not_ready");
    }
    const expected = entry.sequence + 1;
    if (parsed.sequence !== expected) {
      throw new DockerLogsSequenceError(expected, parsed.sequence);
    }
    entry.sequence = parsed.sequence;

    if (entry.status === "waiting" || entry.status === "claimed") {
      entry.status = "live";
      entry.liveAt = Date.now();
      this.writeFrame(entry, DOCKER_LOGS_SSE_STATE, {
        subscriptionId: entry.subscriptionId,
        status: "live",
      });
    }
    this.armIdleTimeout(entry);

    if (parsed.lines.length > 0) {
      const frame = dockerLogsLinesEventSchema.parse({
        subscriptionId: entry.subscriptionId,
        lines: parsed.lines,
      });
      if (
        Buffer.byteLength(JSON.stringify(frame), "utf8") >
        DOCKER_LOGS_MAX_FRAME_BYTES
      ) {
        // A widened schema must not be able to blow the SSE frame budget.
        this.close(entry, "failed", "slow_consumer");
        return {
          ok: true,
          subscriptionId: entry.subscriptionId,
          sequence: entry.sequence,
        };
      }
      this.writeFrame(entry, DOCKER_LOGS_SSE_LINES, frame);
    }

    return dockerLogsChunksResponseSchema.parse({
      data: {
        ok: true,
        subscriptionId: entry.subscriptionId,
        sequence: entry.sequence,
      },
    }).data;
  }

  // ── Agent: result ───────────────────────────────────────────────────

  /** Final outcome from the claiming agent; ends the viewer stream. */
  async result(
    credential: AgentCredential,
    subscriptionId: string,
    body: unknown,
  ): Promise<DockerLogsResultResult> {
    this.assertBodySize(body);
    const parsed = dockerLogsResultRequestSchema.parse(body);
    const entry = this.requireEntry(
      credential,
      subscriptionId,
      parsed.agentInstanceId,
    );

    // Completed means the Docker source reached a clean EOF; failed carries
    // only a safe error code, never a daemon response body.
    this.close(
      entry,
      parsed.status === "completed" ? "completed" : "failed",
      parsed.status === "failed" ? parsed.errorCode : undefined,
    );

    return dockerLogsResultResponseSchema.parse({
      data: {
        ok: true,
        subscriptionId: entry.subscriptionId,
        agentInstanceId: parsed.agentInstanceId,
      },
    }).data;
  }

  // ── Introspection ───────────────────────────────────────────────────

  /** Registry summary for tests and ops snapshots; never carries content. */
  snapshot(): Array<{
    subscriptionId: string;
    vpsId: string;
    agentInstanceId: string;
    containerKey: string;
    status: SubscriptionStatus;
    sequence: number;
  }> {
    return [...this.subscriptions.values()].map((entry) => ({
      subscriptionId: entry.subscriptionId,
      vpsId: entry.vpsId,
      agentInstanceId: entry.agentInstanceId,
      containerKey: entry.containerKey,
      status: entry.status,
      sequence: entry.sequence,
    }));
  }

  /**
   * Releases every registry slot on module teardown, so a test app closing
   * never leaves timers behind that would keep the event loop alive.
   */
  onModuleDestroy(): void {
    this.closeAllSubscriptions();
  }

  onApplicationShutdown(): void {
    this.closeAllSubscriptions();
  }

  private closeAllSubscriptions(): void {
    for (const entry of this.subscriptions.values()) {
      this.close(entry, "failed", "logs_unavailable");
    }
    this.closedSubscriptions.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async policySnapshot(vpsId: string): Promise<DockerLogsPolicySnapshot> {
    try {
      const result = await this.dockerManagement.capability(vpsId);
      return {
        logsSupported: this.config.mode === "local" && result.logsSupported === true,
        targets: (result.targets ?? []).map((target) => ({ ...target })),
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      // A policy lookup failure is not leakable detail: report unavailable.
      return {
        logsSupported: false,
        targets: [],
      };
    }
  }

  private attachResponseHandlers(entry: RegistryEntry): () => void {
    const teardown = () => {
      this.close(entry, "failed", "agent_unavailable");
    };
    entry.response.on("close", teardown);
    entry.response.on("finish", teardown);
    entry.response.on("error", teardown);
    return () => {
      entry.response.off("close", teardown);
      entry.response.off("finish", teardown);
      entry.response.off("error", teardown);
    };
  }

  private armIdleTimeout(entry: RegistryEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.status === "live") {
        this.close(entry, "failed", "stream_lost");
      }
    }, STREAM_IDLE_TIMEOUT_MS);
  }

  private armRevalidation(
    entry: RegistryEntry,
    session: DockerLogsSessionContext,
  ): void {
    if (session.localMode === true && session.dashboardSessionId) {
      entry.revalidateTimer = setInterval(() => {
        this.revalidate(entry, session).catch(() => {
          this.close(entry, "failed", "logs_unavailable");
        });
      }, REVALIDATE_INTERVAL_MS);
    }
  }

  private async revalidate(
    entry: RegistryEntry,
    session: DockerLogsSessionContext,
  ): Promise<void> {
    if (entry.status === "closed") return;
    if (!session.dashboardSessionId) return;
    try {
      const authenticated = await this.dashboardSessions.authenticateById(
        session.dashboardSessionId,
      );
      if (!authenticated) {
        this.close(entry, "failed", "session_expired");
        return;
      }
      if (!(await this.assertCurrentPolicy(entry))) {
        // The container disappeared from the latest committed snapshot, so the
        // Docker source this viewer watches is gone.
        this.close(entry, "failed", "logs_unavailable");
      }
    } catch {
      this.close(entry, "failed", "logs_unavailable");
    }
  }

  private async assertCurrentPolicy(entry: RegistryEntry): Promise<boolean> {
    try {
      const policy = await this.policySnapshot(entry.vpsId);
      return (
        policy.logsSupported === true &&
        policy.targets.some(
          (target) =>
            target.agentInstanceId === entry.agentInstanceId &&
            target.containerKey === entry.containerKey,
        )
      );
    } catch {
      return false;
    }
  }

  private requireEntry(
    credential: AgentCredential,
    subscriptionId: string,
    agentInstanceId: string,
  ): RegistryEntry {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) {
      const closed = this.closedSubscriptions.get(subscriptionId);
      if (
        closed &&
        closed.vpsId === credential.vpsId &&
        closed.agentInstanceId === agentInstanceId
      ) {
        throw new DockerLogsSubscriptionMissingError(410);
      }
      throw new DockerLogsSubscriptionMissingError(404);
    }
    if (
      entry.vpsId !== credential.vpsId ||
      entry.agentInstanceId !== agentInstanceId
    ) {
      // Never disclose whether the id exists on another VPS or instance.
      throw new DockerLogsSubscriptionMissingError(404);
    }
    if (entry.status === "closed") {
      throw new DockerLogsSubscriptionMissingError(410);
    }
    return entry;
  }

  private assertBodySize(body: unknown): void {
    if (body === undefined || body === null) return;
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > DOCKER_LOGS_MAX_BODY_BYTES) {
      throw new DockerLogsProtocolError(400, "body_too_large");
    }
  }

  /** Writes one SSE frame; closes the subscription when the consumer is overloaded. */
  private writeFrame(
    entry: RegistryEntry,
    event: string,
    payload: unknown,
  ): void {
    if (entry.status === "closed") return;
    const data = JSON.stringify(payload);
    if (Buffer.byteLength(data, "utf8") > DOCKER_LOGS_MAX_FRAME_BYTES) {
      this.close(entry, "failed", "slow_consumer");
      return;
    }
    this.writeRaw(entry, `event: ${event}\ndata: ${data}\n\n`);
  }

  private writeRaw(entry: RegistryEntry, chunk: string): void {
    if (entry.status === "closed") return;
    if (entry.response.writableEnded || entry.response.destroyed) return;
    try {
      const accepted = entry.response.write(chunk, "utf8");
      if (accepted === false) {
        // A saturated socket buffer means the viewer cannot keep up; queueing
        // more would grow memory without bound, so end the stream instead.
        this.close(entry, "failed", "slow_consumer");
        return;
      }
      if (typeof entry.response.flush === "function") {
        entry.response.flush();
      }
    } catch {
      this.close(entry, "failed", "slow_consumer");
    }
  }

  private close(
    entry: RegistryEntry,
    reason: "completed" | "failed" | "expired",
    errorCode?: DockerLogErrorCode,
  ): void {
    if (entry.status === "closed") return;
    entry.status = "closed";
    entry.closedAt = Date.now();
    entry.closeReason = reason;
    entry.closeErrorCode = errorCode;

    this.subscriptions.delete(entry.subscriptionId);
    this.closedSubscriptions.set(entry.subscriptionId, {
      vpsId: entry.vpsId,
      agentInstanceId: entry.agentInstanceId,
    });
    if (this.closedSubscriptions.size > 256) {
      const oldest = this.closedSubscriptions.keys().next().value;
      if (oldest) this.closedSubscriptions.delete(oldest);
    }
    entry.detachResponse?.();
    entry.detachResponse = undefined;
    clearTimeout(entry.claimReadyTimer);
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.expiryTimer);
    clearInterval(entry.keepaliveTimer);
    clearInterval(entry.revalidateTimer);
    entry.claimReadyTimer = undefined;
    entry.idleTimer = undefined;
    entry.expiryTimer = undefined;
    entry.keepaliveTimer = undefined;
    entry.revalidateTimer = undefined;

    const code =
      errorCode && ERROR_CODE_LOOKUP[errorCode] === true ? errorCode : undefined;
    const frame = dockerLogsClosedEventSchema.parse({
      subscriptionId: entry.subscriptionId,
      reason,
      ...(code ? { errorCode: code } : {}),
    });
    // The entry is already marked closed, so this bypasses writeRaw's guard —
    // the terminal frame is the one message that must always reach the viewer.
    this.writeClosedFrame(entry, frame);
    if (!entry.response.writableEnded && !entry.response.destroyed) {
      try {
        entry.response.end();
      } catch {
        // Socket already gone; nothing left to release.
      }
    }
  }

  /** Writes the terminal closed frame regardless of the entry's closed state. */
  private writeClosedFrame(entry: RegistryEntry, frame: unknown): void {
    if (entry.response.writableEnded || entry.response.destroyed) return;
    try {
      entry.response.write(
        `event: ${DOCKER_LOGS_SSE_CLOSED}\ndata: ${JSON.stringify(frame)}\n\n`,
        "utf8",
      );
      if (typeof entry.response.flush === "function") {
        entry.response.flush();
      }
    } catch {
      // Socket already gone; the viewer's own close path has taken over.
    }
  }
}
