import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, closeTestApps } from "./test-helpers.js";
import { ApiExceptionFilter } from "../src/common/filters/api-exception.filter.js";
import type { AppConfig } from "../src/config/app-config.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";

const demoConfig: AppConfig = {
  mode: "demo",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: false,
  dataDir: "data",
  privateDir: "private",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
  agentInstallIntervalSeconds: 1,
  allowInsecureAgentHttp: false,
  storageDriver: "json",
  dbSsl: false,
  dbPoolMax: 10,
  dashboardSessionTtlSeconds: 86_400,
  dashboardCookieSecure: false,
  dashboardCookieSameSite: "lax",
  dashboardSessionSecret: "routes-test-secret-32+chars-here!!",
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-routes-"));
});

afterEach(async () => {
  await closeTestApps();
  await rm(tempDir, { recursive: true, force: true });
});

function app() {
  return createApp({
    config: {
      ...demoConfig,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
    store: createVpsStore(join(tempDir, "data", "vps.json")),
    keys: createKeyService(join(tempDir, "private", "keys")),
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
  });
}

describe("routes", () => {
  it("returns health status", async () => {
    await request(app()).get("/api/health").expect(200, { ok: true });
  });

  it("blocks VPS creation in demo mode and sanitizes errors", async () => {
    const server = app();
    // Mutations blocked in demo mode
    const create = await request(server)
      .post("/api/vps")
      .send({
        name: "prod",
        host: "203.0.113.20",
        port: 22,
        username: "root",
        password: "secret",
      })
      .expect(403);
    expect(create.body.error.message).toBe(
      "Mutations are disabled in demo mode",
    );
    expect(JSON.stringify(create.body)).not.toContain("secret");

    // Reads still work — demo mode returns seeded demo servers
    const list = await request(server).get("/api/vps").expect(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(list.body)).not.toContain("ssh-ed25519");
  });

  it("sanitizes validation and not-found errors", async () => {
    const bad = await request(app())
      .post("/api/vps")
      .send({ password: "secret" })
      .expect(403);
    expect(bad.body.error.message).toBe("Mutations are disabled in demo mode");
    expect(JSON.stringify(bad.body)).not.toContain("secret");

    await request(app())
      .get("/api/vps/missing")
      .expect(404, { error: { message: "VPS not found" } });
  });

  it("serves public dashboard assets without exposing private or data directories", async () => {
    const server = app();

    const page = await request(server).get("/").expect(200);
    expect(page.text).toContain("FlexServer");

    // CSP header should be present
    const csp = page.headers["content-security-policy"] as string | undefined;
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    await request(server).get("/private/keys/vps_123").expect(404);
    await request(server).get("/data/vps.json").expect(404);
    await request(server).get("/packages/web/src/App.tsx").expect(404);
    await request(server).get("/packages/api/src/app.ts").expect(404);
  });

  it("surfaces standard HttpException messages instead of the generic fallback", async () => {
    // `error` in the standard NestJS payload is the HTTP error name (a plain
    // string like "Bad Request"); the actual message lives in `message`.
    await request(app())
      .get("/api/metrics?limit=0")
      .expect(400, { error: { message: "limit must be a positive integer" } });

    await request(app())
      .get("/api/jobs?offset=-1")
      .expect(400, {
        error: { message: "offset must be a non-negative integer" },
      });
  });
});

describe("exception filter — HttpException payload messages", () => {
  function runFilter(error: unknown) {
    let status = 500;
    let body: unknown;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: unknown) {
        body = payload;
        return res;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => res,
      }),
    };
    new ApiExceptionFilter().catch(error, host as never);
    return { status, body };
  }

  it("preserves the top-level message when payload.error is a plain string", () => {
    // Standard NestJS payload: { statusCode, message, error: "Bad Request" } —
    // `error` is the HTTP error name, not a nested object. This shape used to
    // be flattened to the generic "Request failed".
    const { status, body } = runFilter(
      new HttpException(
        {
          statusCode: 400,
          message: "limit must be a positive integer",
          error: "Bad Request",
        },
        400,
      ),
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      error: { message: "limit must be a positive integer" },
    });
  });

  it("prefers a nested error.message when the payload is truly nested", () => {
    const { status, body } = runFilter(
      new HttpException({ error: { message: "Invalid token" } }, 401),
    );
    expect(status).toBe(401);
    expect(body).toEqual({ error: { message: "Invalid token" } });
  });

  it("keeps the safe generic message when the payload message is an array", () => {
    const { status, body } = runFilter(
      new HttpException(
        { statusCode: 400, message: ["a", "b"], error: "Bad Request" },
        400,
      ),
    );
    expect(status).toBe(400);
    expect(body).toEqual({ error: { message: "Request failed" } });
  });

  it("falls back to the exception message for non-object payloads", () => {
    const { status, body } = runFilter(new HttpException("Plain string", 418));
    expect(status).toBe(418);
    expect(body).toEqual({ error: { message: "Plain string" } });
  });
});
