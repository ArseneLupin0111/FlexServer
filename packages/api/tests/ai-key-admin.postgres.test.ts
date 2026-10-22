import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMigrations } from "../src/db/migrations.js";
import { createPostgresAiRepository } from "../src/persistence/repositories/ai.repository.js";
import { manageAiKeysFromCli } from "../src/scripts/manage-ai-keys.js";
import { encryptAiSecret, decryptAiSecret, loadAiKeyring } from "../src/ai/ai-crypto.js";

import type { AiAadContext } from "../src/ai/ai-crypto.js";
const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)("PostgreSQL AI key administration", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let directory: string;
  let keyringFile: string;

  beforeEach(async () => {
    schema = `ai_admin_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: scopedUrl.toString() });
    const migration = (await loadMigrations()).find((row) => row.id === "031_ai_state_journal.sql")!;
    await pool.query(migration.sql);
    directory = await mkdtemp(join(tmpdir(), "ai-pg-admin-"));
    keyringFile = join(directory, "keyring.json");
    vi.stubEnv("STORAGE_DRIVER", "postgres");
    vi.stubEnv("DATABASE_URL", scopedUrl.toString());
    vi.stubEnv("DATA_DIR", join(directory, "data"));
    vi.stubEnv("PRIVATE_DIR", join(directory, "private"));
    vi.stubEnv("AI_KEYRING_FILE", keyringFile);
    vi.stubEnv("DASHBOARD_SESSION_SECRET", "0123456789012345678901234567890123456789");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });

  it("initializes on migrated storage, rotates retained secrets, and preserves their decryption", async () => {
    await manageAiKeysFromCli(["init"]);
    const initial = await loadAiKeyring(keyringFile);
    const context: AiAadContext = { vpsId: "global", taskId: "provider", field: "providerApiKey", version: 1 };
    const repo = createPostgresAiRepository(pool);
    await repo.updateSettings({ patch: { endpoint: "https://provider.example/v1", model: "model" }, apiKeyEnvelope: encryptAiSecret("provider-secret", context, initial) });
    await manageAiKeysFromCli(["rotate"]);
    const rotated = await loadAiKeyring(keyringFile);
    const settings = await repo.getSettings();
    expect(rotated.activeKekId).not.toBe(initial.activeKekId);
    expect(settings!.encryptedApiKey!.kekId).toBe(rotated.activeKekId);
    expect(decryptAiSecret(settings!.encryptedApiKey!, context, rotated)).toBe("provider-secret");
    const keyringBefore = await readFile(keyringFile, "utf8");
    await expect(manageAiKeysFromCli(["init"])).rejects.toThrow("Existing encrypted AI data");
    expect(await readFile(keyringFile, "utf8")).toBe(keyringBefore);
  });

  it("refuses a replacement keyring for orphaned ciphertext without changing the stored journal", async () => {
    const state = { settings: { encryptedApiKey: { kekId: "original-key" } }, blobs: [] };
    await pool.query("INSERT INTO ai_state_journal (id, state) VALUES (1, $1)", [JSON.stringify(state)]);
    await expect(manageAiKeysFromCli(["init"])).rejects.toThrow("Existing encrypted AI data");
    await expect(access(keyringFile)).rejects.toThrow();
    expect((await pool.query("SELECT state FROM ai_state_journal WHERE id = 1")).rows[0].state).toEqual(state);
  });
});
