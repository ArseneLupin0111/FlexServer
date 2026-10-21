import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createLoginRateLimit } from "../src/common/login-rate-limit.middleware.js";
import {
  createInMemoryRateLimitStore,
  createPostgresRateLimitStore,
} from "../src/common/rate-limit-store.js";


describe("InMemoryRateLimitStore", () => {
  it("first consume returns count 1 within window", async () => {
    const store = createInMemoryRateLimitStore();
    const result = await store.consume("ip:test", 60_000, 5);
    expect(result.count).toBe(1);
    expect(result.resetAtMs).toBeGreaterThan(Date.now());
  });

  it("increments count within the same window", async () => {
    const store = createInMemoryRateLimitStore();
    await store.consume("ip:test", 60_000, 5);
    const result = await store.consume("ip:test", 60_000, 5);
    expect(result.count).toBe(2);
  });

  it("resets after window expires", async () => {
    const store = createInMemoryRateLimitStore();
    const first = await store.consume("ip:test", 10, 5); // 10ms window
    expect(first.count).toBe(1);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 15));

    const second = await store.consume("ip:test", 10, 5);
    expect(second.count).toBe(1); // reset
  });

  it("separate keys are independent", async () => {
    const store = createInMemoryRateLimitStore();
    const [a, b] = await Promise.all([
      store.consume("ip:a", 60_000, 5),
      store.consume("ip:b", 60_000, 5),
    ]);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  it("shared store across middleware (reuses same store)", async () => {
    const store = createInMemoryRateLimitStore();
    // Simulate two middleware instances sharing the same store
    await store.consume("ip:shared", 60_000, 2);
    const result = await store.consume("ip:shared", 60_000, 2);
    expect(result.count).toBe(2); // Third would be blocked
  });
});

describe("PostgresRateLimitStore (mocked pool)", () => {
  it("returns count and resetAtMs from atomic UPSERT", async () => {
    const resetAt = new Date("2026-07-06T12:01:00Z");
    let capturedSql = "";
    let capturedParams: unknown[] = [];

    const mockPool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [{ count: 3, reset_at: resetAt }],
        };
      },
      end: async () => {},
    } as never;

    const store = createPostgresRateLimitStore(mockPool);
    const result = await store.consume("login:127.0.0.1", 60_000, 5);
    expect(result.count).toBe(3);
    expect(result.resetAtMs).toBe(resetAt.getTime());
    expect(capturedSql).toContain("INSERT INTO rate_limit_buckets");
    expect(capturedSql).toContain("ON CONFLICT");
    expect(capturedSql).toContain("DO UPDATE");
    expect(capturedSql).toContain("RETURNING count, reset_at");
    expect(capturedSql).not.toMatch(/\bDELETE\b/i);
    expect(capturedSql).not.toMatch(/\bSELECT\b/i);
    expect(capturedParams).toEqual(["login:127.0.0.1", 60_000]);
  });

  it("throws on query error so middleware can fail closed with 503", async () => {
    const mockPool = {
      query: async () => {
        throw new Error("DB connection failed");
      },
      end: async () => {},
    } as never;

    const store = createPostgresRateLimitStore(mockPool);
    await expect(store.consume("login:127.0.0.1", 60_000, 5)).rejects.toThrow(
      "DB connection failed",
    );
  });
});

describe("rate limit middleware fail-closed behavior", () => {
  it("returns 503 with standard error shape when the store fails", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.requestId = "req_rate_limit_test";
      next();
    });
    app.use(
      createLoginRateLimit({
        async consume() {
          throw new Error("DB unavailable");
        },
      }),
    );
    app.post("/api/auth/login", (_req, res) => res.status(204).end());

    const response = await request(app).post("/api/auth/login").expect(503);
    expect(response.body).toEqual({
      error: {
        message: "Rate limiter unavailable",
        requestId: "req_rate_limit_test",
      },
    });
  });
});

