import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import {
  createJsonSettingsRepository,
  InMemorySettingsRepository,
} from "../src/persistence/repositories/settings.repository.js";
import { createPostgresSettingsRepository } from "../src/persistence/repositories/settings.postgres.repository.js";
import { DashboardSettingsService } from "../src/dashboard/dashboard-settings.service.js";
import { loadMigrations } from "../src/db/migrations.js";
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
  await closeTestApps();
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
    expect(initialOverview.body.data.settings.terminalCommandGuardEnabled).toBe(false);

    // PATCH to enable
    const patchResponse = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ webTerminalEnabled: true })
      .expect(200);
    expect(patchResponse.body.data).toEqual({
      webTerminalEnabled: true,
      terminalCommandGuardEnabled: false,
    });

    const updatedOverview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(updatedOverview.body.data.settings.webTerminalEnabled).toBe(true);
    expect(updatedOverview.body.data.settings.terminalCommandGuardEnabled).toBe(false);

    // Verify persisted directly in repository
    const stored = await settingsRepo.get();
    expect(stored?.webTerminalEnabled).toBe(true);
    expect(stored?.terminalCommandGuardEnabled).toBe(false);

    // PATCH to disable
    const disableResponse = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ webTerminalEnabled: false })
      .expect(200);
    expect(disableResponse.body.data).toEqual({
      webTerminalEnabled: false,
      terminalCommandGuardEnabled: false,
    });

    const storedDisabled = await settingsRepo.get();
    expect(storedDisabled?.webTerminalEnabled).toBe(false);
    expect(storedDisabled?.terminalCommandGuardEnabled).toBe(false);

    const finalOverview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(finalOverview.body.data.settings.webTerminalEnabled).toBe(false);
    expect(finalOverview.body.data.settings.terminalCommandGuardEnabled).toBe(false);
  });

  it("rejects enabling terminal command guard when mode is demo", async () => {
    const demoApp = app({ mode: "demo" });
    const response = await request(demoApp)
      .patch("/api/dashboard/settings")
      .send({ terminalCommandGuardEnabled: true })
      .expect(400);

    expect(response.body.error).toBeDefined();
    const overview = await request(demoApp).get("/api/dashboard").expect(200);
    expect(overview.body.data.settings.terminalCommandGuardEnabled).toBe(false);
  });

  it("allows partial updates: setting terminalCommandGuardEnabled independently preserves existing webTerminalEnabled", async () => {
    const localApp = app();

    // Enable web terminal first
    await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ webTerminalEnabled: true })
      .expect(200);

    // Independently enable command guard (without sending webTerminalEnabled)
    const patchResponse = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ terminalCommandGuardEnabled: true })
      .expect(200);

    expect(patchResponse.body.data).toEqual({
      webTerminalEnabled: true,
      terminalCommandGuardEnabled: true,
    });

    const overview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(overview.body.data.settings.webTerminalEnabled).toBe(true);
    expect(overview.body.data.settings.terminalCommandGuardEnabled).toBe(true);

    // Independently disable command guard (without sending webTerminalEnabled)
    const disableGuard = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ terminalCommandGuardEnabled: false })
      .expect(200);

    expect(disableGuard.body.data).toEqual({
      webTerminalEnabled: true,
      terminalCommandGuardEnabled: false,
    });

    const finalOverview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(finalOverview.body.data.settings.webTerminalEnabled).toBe(true);
    expect(finalOverview.body.data.settings.terminalCommandGuardEnabled).toBe(false);
  });

  it("allows partial update of command guard when webTerminalEnabled was never explicitly set", async () => {
    const localApp = app();
    const patchResponse = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ terminalCommandGuardEnabled: true })
      .expect(200);

    expect(patchResponse.body.data).toEqual({
      webTerminalEnabled: false,
      terminalCommandGuardEnabled: true,
    });

    const overview = await request(localApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(overview.body.data.settings.webTerminalEnabled).toBe(false);
    expect(overview.body.data.settings.terminalCommandGuardEnabled).toBe(true);
  });

  it("allows updating both settings simultaneously", async () => {
    const localApp = app();
    const patchResponse = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ webTerminalEnabled: true, terminalCommandGuardEnabled: true })
      .expect(200);

    expect(patchResponse.body.data).toEqual({
      webTerminalEnabled: true,
      terminalCommandGuardEnabled: true,
    });
  });

  it("rejects empty payload, unknown properties, and non-boolean types", async () => {
    const localApp = app();

    // Empty payload
    const emptyRes = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({})
      .expect(400);
    expect(emptyRes.body.error?.message).toMatch(/At least one setting/i);

    // Unknown property
    const unknownRes = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ unknownKey: true })
      .expect(400);
    expect(unknownRes.body.error?.message).toMatch(/Unrecognized key/i);

    // Non-boolean type
    const invalidTypeRes = await request(localApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ terminalCommandGuardEnabled: "true" })
      .expect(400);
    expect(invalidTypeRes.body.error?.message).toMatch(/Expected boolean/i);
  });

  it("persists partial updates in createJsonSettingsRepository with file locking", async () => {
    const jsonRepoPath = join(tempDir, "data", "test-settings.json");
    const jsonRepo = createJsonSettingsRepository(jsonRepoPath);

    expect(await jsonRepo.get()).toBeUndefined();

    // Partial update: only command guard
    const r1 = await jsonRepo.upsert({ terminalCommandGuardEnabled: true });
    expect(r1.terminalCommandGuardEnabled).toBe(true);
    expect(r1.webTerminalEnabled).toBe(false);

    // Partial update: only web terminal
    const r2 = await jsonRepo.upsert({ webTerminalEnabled: true });
    expect(r2.webTerminalEnabled).toBe(true);
    expect(r2.terminalCommandGuardEnabled).toBe(true);

    // Direct read from disk verifies persistence
    const loaded = await jsonRepo.get();
    expect(loaded?.webTerminalEnabled).toBe(true);
    expect(loaded?.terminalCommandGuardEnabled).toBe(true);
  });

  it("preserves effective config when no settings exist and guard-only PATCH is sent (listener not disabled)", async () => {
    const configWithWebTerminal: AppConfig = {
      ...baseConfig,
      enableWebTerminal: true,
    };
    const enabledApp = app({ enableWebTerminal: true });

    // Direct service unit test verifying listener is not called and webTerminal remains enabled
    const unitRepo = new InMemorySettingsRepository();
    const unitService = new DashboardSettingsService(configWithWebTerminal, unitRepo);
    const disabledSpy = vi.fn();
    unitService.onDisabled(disabledSpy);

    const unitResult = await unitService.updateSettings({ terminalCommandGuardEnabled: true });
    expect(unitResult).toEqual({
      webTerminalEnabled: true,
      terminalCommandGuardEnabled: true,
    });
    expect(disabledSpy).not.toHaveBeenCalled();
    expect(await unitService.isWebTerminalEnabled()).toBe(true);
    const unitStored = await unitRepo.get();
    expect(unitStored?.webTerminalEnabled).toBe(true);
    expect(unitStored?.terminalCommandGuardEnabled).toBe(true);

    // End-to-end HTTP integration test
    const initialOverview = await request(enabledApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(initialOverview.body.data.settings.webTerminalEnabled).toBe(true);
    expect(initialOverview.body.data.settings.terminalCommandGuardEnabled).toBe(false);
    expect(await settingsRepo.get()).toBeUndefined();

    // PATCH ONLY command guard on uninitialized settings
    const guardOnlyRes = await request(enabledApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ terminalCommandGuardEnabled: true })
      .expect(200);

    expect(guardOnlyRes.body.data).toEqual({
      webTerminalEnabled: true,
      terminalCommandGuardEnabled: true,
    });

    // Persisted settings retained effective webTerminalEnabled: true
    const stored = await settingsRepo.get();
    expect(stored?.webTerminalEnabled).toBe(true);
    expect(stored?.terminalCommandGuardEnabled).toBe(true);
    // Overview reflects both enabled
    const afterOverview = await request(enabledApp)
      .get("/api/dashboard")
      .set("Cookie", sessionCookie)
      .expect(200);
    expect(afterOverview.body.data.settings.webTerminalEnabled).toBe(true);
    expect(afterOverview.body.data.settings.terminalCommandGuardEnabled).toBe(true);

    // Subsequent guard-only PATCH to disable guard preserves webTerminalEnabled: true
    const disableGuardRes = await request(enabledApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ terminalCommandGuardEnabled: false })
      .expect(200);

    expect(disableGuardRes.body.data).toEqual({
      webTerminalEnabled: true,
      terminalCommandGuardEnabled: false,
    });
    expect(disabledSpy).not.toHaveBeenCalled();
    const storedAfterDisable = await settingsRepo.get();
    expect(storedAfterDisable?.webTerminalEnabled).toBe(true);
    expect(storedAfterDisable?.terminalCommandGuardEnabled).toBe(false);
  });

  it("does not overwrite explicit existing webTerminalEnabled=false when guard is patched with enableWebTerminal config true", async () => {
    const enabledApp = app({ enableWebTerminal: true });

    // Explicitly set webTerminalEnabled to false first
    await request(enabledApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ webTerminalEnabled: false })
      .expect(200);

    const storedBefore = await settingsRepo.get();
    expect(storedBefore?.webTerminalEnabled).toBe(false);

    // Now PATCH only command guard
    const guardRes = await request(enabledApp)
      .patch("/api/dashboard/settings")
      .set("Cookie", sessionCookie)
      .set("Origin", ORIGIN)
      .send({ terminalCommandGuardEnabled: true })
      .expect(200);

    // webTerminalEnabled MUST stay false, NOT reset to true from config!
    expect(guardRes.body.data).toEqual({
      webTerminalEnabled: false,
      terminalCommandGuardEnabled: true,
    });
    const storedAfter = await settingsRepo.get();
    expect(storedAfter?.webTerminalEnabled).toBe(false);
    expect(storedAfter?.terminalCommandGuardEnabled).toBe(true);
  });

  it("persists partial updates in createJsonSettingsRepository with file locking and defaults on creation", async () => {
    const jsonRepoPath = join(tempDir, "data", "test-settings.json");
    const jsonRepo = createJsonSettingsRepository(jsonRepoPath);

    expect(await jsonRepo.get()).toBeUndefined();

    // Partial update on creation with default webTerminalEnabled: true
    const r1 = await jsonRepo.upsert(
      { terminalCommandGuardEnabled: true },
      { webTerminalEnabled: true },
    );
    expect(r1.terminalCommandGuardEnabled).toBe(true);
    expect(r1.webTerminalEnabled).toBe(true);

    // Subsequent partial update preserves existing values without falling back to defaults
    const r2 = await jsonRepo.upsert(
      { terminalCommandGuardEnabled: false },
      { webTerminalEnabled: false },
    );
    expect(r2.webTerminalEnabled).toBe(true);
    expect(r2.terminalCommandGuardEnabled).toBe(false);

    // Direct read from disk verifies persistence
    const loaded = await jsonRepo.get();
    expect(loaded?.webTerminalEnabled).toBe(true);
    expect(loaded?.terminalCommandGuardEnabled).toBe(false);
  });

  it("persists partial updates in createPostgresSettingsRepository and passes expected SQL with defaults", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT * FROM dashboard_settings")) {
        return {
          rows: [
            {
              id: "dashboard_settings",
              web_terminal_enabled: false,
              terminal_command_guard_enabled: true,
              updated_at: new Date("2026-10-15T12:00:00.000Z"),
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO dashboard_settings")) {
        return {
          rows: [
            {
              id: "dashboard_settings",
              web_terminal_enabled: params?.[0] ?? params?.[1] ?? false,
              terminal_command_guard_enabled: params?.[2] ?? params?.[3] ?? false,
              updated_at: params?.[4] ?? new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const pgRepo = createPostgresSettingsRepository({ query } as never);
    const retrieved = await pgRepo.get();
    expect(retrieved?.terminalCommandGuardEnabled).toBe(true);
    expect(retrieved?.webTerminalEnabled).toBe(false);

    const updated = await pgRepo.upsert(
      { terminalCommandGuardEnabled: true },
      { webTerminalEnabled: true },
    );
    expect(query).toHaveBeenCalled();
    const [insertSql, insertParams] = query.mock.calls[1] as [string, unknown[]];
    expect(insertSql).toContain("COALESCE($1, $2, false)");
    expect(insertSql).toContain("COALESCE($3, $4, false)");
    expect(insertSql).toContain("web_terminal_enabled = COALESCE($1, dashboard_settings.web_terminal_enabled)");
    expect(insertSql).toContain("terminal_command_guard_enabled = COALESCE($3, dashboard_settings.terminal_command_guard_enabled)");
    expect(insertParams[0]).toBeNull();
    expect(insertParams[1]).toBe(true);
    expect(insertParams[2]).toBe(true);
    expect(insertParams[3]).toBeNull();
    expect(updated.terminalCommandGuardEnabled).toBe(true);
    expect(updated.webTerminalEnabled).toBe(true);
  });
  it("registers migration 025_terminal_command_guard.sql immediately after 024", async () => {
    const migrations = await loadMigrations();
    const ids = migrations.map((m) => m.id);
    const index024 = ids.indexOf("024_dashboard_settings.sql");
    const index025 = ids.indexOf("025_terminal_command_guard.sql");

    expect(index024).toBeGreaterThanOrEqual(0);
    expect(index025).toBe(index024 + 1);

    const m025 = migrations[index025]!;
    expect(m025.sql).toContain("ALTER TABLE dashboard_settings");
    expect(m025.sql).toContain("ADD COLUMN IF NOT EXISTS terminal_command_guard_enabled boolean NOT NULL DEFAULT false");
  });

});
