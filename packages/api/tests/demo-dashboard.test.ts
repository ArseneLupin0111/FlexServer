import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
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
  dashboardSessionSecret: "test-secret",
  trustProxyHops: 0,
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-demo-dashboard-"));
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

describe("demo dashboard", () => {
  it("returns seeded operations data without credentials", async () => {
    const response = await request(app()).get("/api/dashboard").expect(200);

    expect(response.body.data.mode).toBe("demo");
    expect(response.body.data.banner).toBe(
      "Demo mode: simulated servers, no real SSH connections.",
    );
    expect(
      response.body.data.servers.map((server: { name: string }) => server.name),
    ).toEqual(["edge-sgp-01", "api-fra-02", "worker-sfo-01"]);
    expect(response.body.data.summary).toMatchObject({
      totalServers: 3,
      healthyServers: 1,
      warningServers: 1,
      unreachableServers: 1,
      runningJobs: 1,
    });
    expect(response.body.data.metrics).toHaveLength(3);
    expect(
      response.body.data.metrics.map(
        (metric: { freshness: string }) => metric.freshness,
      ),
    ).toEqual(["fresh", "fresh", "stale"]);
    expect(
      response.body.data.jobs.map((job: { status: string }) => job.status),
    ).toEqual(["queued", "running", "succeeded", "failed"]);
    expect(response.body.data.jobs[1]).toMatchObject({
      vpsId: "demo-edge-sgp-01",
      status: "running",
      progress: 64,
    });
    expect(
      response.body.data.auditEvents.map(
        (event: { action: string }) => event.action,
      ),
    ).toEqual([
      "demo.dashboard.view",
      "job.queued",
      "job.running",
      "job.succeeded",
      "job.failed",
      "terminal.opened",
      "ssh.host.blocked",
    ]);
    expect(response.body.data.terminal).toMatchObject({
      label: "Demo terminal",
      networkAccess: "disabled",
      commands: [
        "uptime",
        "df -h",
        "free -m",
        "systemctl status nginx",
        "journalctl -n 20",
      ],
    });
    expect(response.body.data.settings).toMatchObject({
      appMode: "demo",
      webTerminalEnabled: false,
      realSshEnabled: false,
      authRequiredInLocalMode: true,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /password|private key|ssh-ed25519/i,
    );
  });

  it("serves demo VPS records from the VPS API", async () => {
    const response = await request(app()).get("/api/vps").expect(200);

    expect(
      response.body.data.map((server: { name: string }) => server.name),
    ).toEqual(["edge-sgp-01", "api-fra-02", "worker-sfo-01"]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /password|private key|ssh-ed25519/i,
    );
  });
});
