import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config/app-config.js";
import {
  createInMemoryRateLimitStore,
  type RateLimitStore,
} from "./rate-limit-store.js";

/**
 * Shared rate limiter for mutation endpoints.
 *
 * Applies a higher limit to agent metric routes (multiplier × rateLimitMax)
 * to support multiple agents pushing at 1–2s cadence without blocking.
 *
 * Defaults to in-memory store. Pass a Postgres store for shared DB-backed
 * rate limiting across multi-instance deployments.
 */
export function createMutationRateLimit(
  config: AppConfig,
  store?: RateLimitStore,
) {
  const limiter = store ?? createInMemoryRateLimitStore();
  // Agent routes get a higher limit to support ~5 agents at 1s cadence
  const AGENT_LIMIT_MULTIPLIER = 5;

  return function mutationRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (!["POST", "PATCH", "DELETE"].includes(req.method)) return next();
    if (
      !req.path.startsWith("/api/vps") &&
      !req.path.startsWith("/api/agent")
    )
      return next();

    const ipKey = req.ip || "unknown";
    const isAgent =
      req.path.startsWith("/api/agent");
    // Keep unauthenticated traffic bounded by IP, but isolate authenticated agents
    // before controller verification using a non-reversible credential fingerprint.
    const authHeader = req.header("authorization") ?? "";
    const credentialKey = authHeader.startsWith("Bearer ")
      ? createHash("sha256").update(authHeader).digest("hex").slice(0, 32)
      : ipKey;
    const acknowledgeMatch = req.path.match(/^\/api\/vps\/([^/]+)\/docker\/alerts\/[^/]+\/acknowledge$/);
    const sessionKey = req.dashboardSessionId ?? ipKey;
    const maxRequests = isAgent
      ? config.rateLimitMax * AGENT_LIMIT_MULTIPLIER
      : config.rateLimitMax;
    const windowMs = config.dockerAlertAcknowledgeRateLimitWindowMs ?? config.rateLimitWindowMs;
    const acknowledgeMax = config.dockerAlertAcknowledgeRateLimitMax ?? 30;
    const bucket = acknowledgeMatch
      ? `docker-alert-ack:${sessionKey}:${acknowledgeMatch[1]}`
      : `${isAgent ? "agent" : "mutation"}:${credentialKey}`;

    const effectiveMax = acknowledgeMatch ? acknowledgeMax : maxRequests;
    limiter
      .consume(bucket, acknowledgeMatch ? windowMs : config.rateLimitWindowMs, effectiveMax)
      .then(({ count, resetAtMs }) => {
        if (count > effectiveMax) {
          const retryAfter = Math.ceil((resetAtMs - Date.now()) / 1000);
          if (retryAfter > 0) {
            res.set("Retry-After", String(retryAfter));
          }
          return res
            .status(429)
            .json({
              error: { message: "Too many requests", requestId: req.requestId },
            });
        }
        next();
      })
      .catch(() => {
        // Store error: fail closed with 503
        return res
          .status(503)
          .json({
            error: {
              message: "Rate limiter unavailable",
              requestId: req.requestId,
            },
          });
      });
  };
}
