import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";

const demoConfig: AppConfig = {
  mode: "demo",
  dataDir: "data",
  privateDir: "private",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: false,
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
  dashboardSessionSecret: "test-secret",
  trustProxyHops: 0,
};

let app: Express;

beforeAll(async () => {
  app = createApp({ config: demoConfig });
});

afterAll(async () => {
  await closeTestApps();
});

describe("SSE monitoring stream", () => {
  it("returns 200 and event-stream headers", async () => {
    const res = await request(app)
      .get("/api/monitoring/stream")
      .buffer(true)
      // Capture partial response by closing after first data
      .parse((res, cb) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
          // After receiving at least some data, close
          if (data.length > 10) {
            res.destroy();
          }
        });
        res.on("close", () => cb(null, data));
        res.on("error", (err: Error) => cb(err));
      })
      .timeout(5000);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["cache-control"]).toMatch(/no-cache/);
    expect(res.headers["connection"]).toMatch(/keep-alive/i);

    const body = res.body as string;
    expect(body).toBeTruthy();
    expect(body).toContain("event:");
    expect(body).toContain("data:");
  });

  it("emits JSON with schemaVersion 1", async () => {
    let eventData = "";

    await request(app)
      .get("/api/monitoring/stream")
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk: Buffer) => {
          eventData += chunk.toString();
          if (eventData.includes("\n\n")) {
            res.destroy();
          }
        });
        res.on("close", () => cb(null, eventData));
        res.on("error", (err: Error) => cb(err));
      })
      .timeout(5000);

    // Extract the data: line
    const dataMatch = eventData.match(/^data: (.+)$/m);
    expect(dataMatch).toBeTruthy();
    const parsed = JSON.parse(dataMatch![1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.type).toBe("monitoring.hello");
    expect(typeof parsed.id).toBe("string");
    expect(parsed.id.length).toBeGreaterThan(0);
    expect(typeof parsed.emittedAt).toBe("string");
    expect(parsed.payload).toHaveProperty("mode");
    expect(parsed.payload).toHaveProperty("intervalMs");
  });

  it("snapshot event has all required payload keys", async () => {
    const chunks: string[] = [];

    await request(app)
      .get("/api/monitoring/stream")
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk.toString());
          // Collect at least 2 events
          const eventCount = chunks
            .join("")
            .split("\n\n")
            .filter((s) => s.includes("data:")).length;
          if (eventCount >= 2) {
            res.destroy();
          }
        });
        res.on("close", () => cb(null, chunks.join("")));
        res.on("error", (err: Error) => cb(err));
      })
      .timeout(5000);

    const allData = chunks.join("");
    const dataLines = allData.match(/^data: (.+)$/gm);
    expect(dataLines).toBeTruthy();
    expect(dataLines!.length).toBeGreaterThanOrEqual(2);

    // Second event should be snapshot
    const snapshot = JSON.parse(dataLines![1].replace(/^data: /, ""));
    expect(snapshot.type).toBe("monitoring.snapshot");
    const payload = snapshot.payload;
    expect(payload).toHaveProperty("overview");
    expect(payload).toHaveProperty("servers");
    expect(payload).toHaveProperty("jobs");
    expect(payload).toHaveProperty("metrics");
    expect(payload).toHaveProperty("auditEvents");
  });

  it("does not include password, privateKey, or secret fields", async () => {
    const chunks: string[] = [];

    await request(app)
      .get("/api/monitoring/stream")
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk.toString());
          const eventCount = chunks
            .join("")
            .split("\n\n")
            .filter((s) => s.includes("data:")).length;
          if (eventCount >= 2) {
            res.destroy();
          }
        });
        res.on("close", () => cb(null, chunks.join("")));
        res.on("error", (err: Error) => cb(err));
      })
      .timeout(5000);

    const allData = chunks.join("");
    const raw = allData.toLowerCase();
    expect(raw).not.toContain('"password"');
    expect(raw).not.toContain('"privatekey"');
    expect(raw).not.toContain('"secret"');
  });

  it("demo mode emits metrics.updated after initial events", async () => {
    const chunks: string[] = [];

    await request(app)
      .get("/api/monitoring/stream")
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk.toString());
          const eventCount = chunks
            .join("")
            .split("\n\n")
            .filter((s) => s.includes("data:")).length;
          if (eventCount >= 3) {
            res.destroy();
          }
        });
        res.on("close", () => cb(null, chunks.join("")));
        res.on("error", (err: Error) => cb(err));
      })
      .timeout(8000);

    const allData = chunks.join("");
    const dataLines = allData.match(/^data: (.+)$/gm) ?? [];
    expect(dataLines.length).toBeGreaterThanOrEqual(3);

    const types = dataLines.map(
      (l) => JSON.parse(l.replace(/^data: /, "")).type,
    );
    expect(types[0]).toBe("monitoring.hello");
    expect(types[1]).toBe("monitoring.snapshot");
    expect(types.slice(2).some((t) => t === "metrics.updated")).toBe(true);
  });
});
