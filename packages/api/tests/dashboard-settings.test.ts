import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/app-config.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { InMemorySettingsRepository } from "../src/persistence/repositories/settings.repository.js";
import { createSessionCookie } from "./test-helpers.js";

const SESSION_SECRET = "test-secret-that-is-at-least-32-chars-long";
const ORIGIN = "https://dashboard.example.test";

const baseConfig: AppConfig = {
  mode: "local",
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
  dashboardCookieSecure: true,
  dashboardCookieSameSite: "lax",
  dashboardSessionSecret: SESSION_SECRET,
  dashboardPublicOrigin: ORIGIN,
  trustProxyHops: 0,
};

let tempDir: string;
let settingsRepo: InMemorySettingsRepository;
let sessionCookie: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-settings-test-"));
  settingsRepo = new InMemorySettingsRepository();
  sessionCookie = await createSessionCookie(tempDir, SESSION_SECRET);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function app(configOverrides: Partial<AppConfig> = {}) {
  return createApp({
    config: {
      ...baseConfig,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
      ...configOverrides,
    },
    store: createVpsStore(join(tempDir, "data", "vps.json")),
    keys: createKeyService(join(tempDir, "private", "keys")),
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    settings: settingsRepo,
  });
}

describe("Dashboard Settings API", () => {
  it("rejects PATCH /api/dashboard/settings when unauthenticated in local mode", async () => {
    const response = await request(app())
      .patch("/api/dashboard/settings")
      .send({ webTerminalEnabled: true })
      .expect(401);

    expect(response.body.error).toBeDefined();
  });

  it("rejects enabling web terminal when mode is demo", async () => {
    const demoApp = app({ mode: "demo" });
    const response = await request(demoApp)
      .patch("/api/dashboard/settings")
      .send({ webTerminalEnabled: true })
      .expect(400);

    expect(response.body.error).toBeDefined();
    const overview = await request(demoApp).get("/api/dashboard").expect(200);
    expect(overview.body.data.settings.webTerminalEnabled).toBe(false);
  });

  it("rejects enabling web terminal when DASHBOARD_PUBLIC_ORIGIN is missing", async () => {
    const localNoOriginApp = app({ dashboardPublicOrigin: undefined });
    const response = await request(localNoOriginApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", "http://127.0.0.1")
      .set("Host", "127.0.0.1")
      .send({ webTerminalEnabled: true })
      .expect(400);

    const errorMessage = response.body.error?.message ?? JSON.stringify(response.body);
    expect(errorMessage).toMatch(/DASHBOARD_PUBLIC_ORIGIN/i);
  });

  it("persists enabled web terminal and reflects in GET /api/dashboard", async () => {
    const localApp = app();

    // Initial state: disabled
    const initialOverview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(initialOverview.body.data.settings.webTerminalEnabled).toBe(false);

    // PATCH to enable
    const patchResponse = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ webTerminalEnabled: true })
      .expect(200);
    expect(patchResponse.body.data).toEqual({ webTerminalEnabled: true });

    const updatedOverview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(updatedOverview.body.data.settings.webTerminalEnabled).toBe(true);

    // Verify persisted directly in repository
    const stored = await settingsRepo.get();
    expect(stored?.webTerminalEnabled).toBe(true);
    // PATCH to disable
    const disableResponse = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ webTerminalEnabled: false })
      .expect(200);
    expect(disableResponse.body.data).toEqual({ webTerminalEnabled: false });

    const storedDisabled = await settingsRepo.get();
    expect(storedDisabled?.webTerminalEnabled).toBe(false);

    const finalOverview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(finalOverview.body.data.settings.webTerminalEnabled).toBe(false);
  });

});
