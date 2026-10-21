import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { decryptComposeField, encryptComposeField, type ComposeAdminStoreConfig, type ComposeAadContext, type ComposeEnvelopeData } from "../src/crypto/secret-envelope.js";
import { rotateKeyring, saveKeyringToFile, type Keyring } from "../src/ssh/key-encryption.js";
import { createComposeAdminContext } from "../src/persistence/repositories/compose-admin-registry.js";

type EnvelopeItem = { id: string; appId: string; vpsId: string; name?: string; version?: number; seq?: number; envelope?: ComposeEnvelopeData; resolvedModelEnvelope?: ComposeEnvelopeData };
const testKeyring = (): Keyring => ({ version: 1, activeKekId: "old", keys: { old: { key: randomBytes(32).toString("base64") } } });
const configFor = (dataDir: string, keyringFile: string, storageDriver: "json" | "postgres" = "json", databaseUrl?: string): ComposeAdminStoreConfig => ({ dataDir, privateDir: join(dataDir, "private"), storageDriver, databaseUrl, dbSsl: false, dbPoolMax: 2, composeCrypto: { keyringFile } });
const context = (kind: ComposeAadContext["field"], version: string | number): ComposeAadContext => ({ vpsId: "vps-admin-test", appId: kind === "registryCredential" ? "registry" : "app-admin-test", field: kind, version });
const values = [
  { field: "composeYaml" as const, version: 3, plaintext: "services:\n  app:\n    image: private/image:secret", bucket: "revisions", item: { id: "revision-1", seq: 3 } },
  { field: "secret" as const, version: "TOKEN:2", plaintext: "secret-value-never-public", bucket: "secrets", item: { id: "secret-1", name: "TOKEN", version: 2 } },
  { field: "registryCredential" as const, version: 4, plaintext: "registry-password-never-public", bucket: "credentials", item: { id: "credential-1", name: "registry", version: 4 } },
  { field: "resolvedModel" as const, version: 3, plaintext: "resolved-preview-never-public", bucket: "previews", item: { id: "preview-1", revisionSeq: 3 } },
];


describe("Compose admin external-keyring rotation", () => {
  it("loads the external keyring file and rewraps all protected record types without exposing plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "compose-admin-"));
    const dataDir = join(root, "data");
    const keyringFile = join(root, "external", "compose-keyring.json");
    try {
      await mkdir(dataDir, { recursive: true });
      await mkdir(join(root, "external"), { recursive: true });
      const oldRing = testKeyring();
      await saveKeyringToFile(keyringFile, oldRing);
      const state: Record<string, unknown> = { applications: [], operations: [], containerContentions: [], revisions: [], secrets: [], credentials: [], previews: [] };
      const originalEnvelopes: Record<string, ComposeEnvelopeData> = {};
      for (const value of values) {
        const envelope = encryptComposeField(value.plaintext, context(value.field, value.version), oldRing);
        originalEnvelopes[value.item.id] = envelope;
        const row = { ...value.item, appId: "app-admin-test", vpsId: "vps-admin-test", ...(value.bucket === "previews" ? { resolvedModelEnvelope: envelope } : { envelope }) };
        (state[value.bucket] as unknown[]).push(row);
      }
      await writeFile(join(dataDir, "docker-applications.json"), JSON.stringify(state));
      const config = configFor(dataDir, keyringFile);
      const admin = await createComposeAdminContext(config);
      try {
        const inspect = await admin.rotateEncryptedFields({ dryRun: true });
        expect(inspect).toMatchObject({ rewrapped: 4, refusedAppIds: [], kekIds: ["old"] });
        expect(JSON.stringify(inspect)).not.toContain("private/image:secret");
        const rotation = await rotateKeyring(keyringFile, { dataDir, privateDir: config.privateDir, projectRoot: process.cwd() });
        expect(rotation.previousKekId).toBe("old");
        const result = await admin.rotateEncryptedFields();
        expect(result).toMatchObject({ rewrapped: 4, refusedAppIds: [] });
        expect(JSON.stringify(result)).not.toContain("secret-value-never-public");
      } finally { await admin.__release(); }
      const newRing = JSON.parse(await readFile(keyringFile, "utf8")) as Keyring;
      const persisted = JSON.parse(await readFile(join(dataDir, "docker-applications.json"), "utf8")) as Record<string, EnvelopeItem[]>;
      for (const value of values) {
        const row = persisted[value.bucket]!.find((candidate) => candidate.id === value.item.id)!;
        const envelope = value.bucket === "previews" ? row.resolvedModelEnvelope! : row.envelope!;
        expect(envelope.kekId).toBe(newRing.activeKekId);
        expect(decryptComposeField(envelope, context(value.field, value.version), newRing)).toBe(value.plaintext);
        expect(decryptComposeField(envelope, context(value.field, value.version), { ...newRing, keys: { [newRing.activeKekId]: newRing.keys[newRing.activeKekId]! } })).toBe(value.plaintext);
        expect(() => decryptComposeField(envelope, { ...context(value.field, value.version), appId: "wrong-app" }, newRing)).toThrow();
        expect(decryptComposeField(originalEnvelopes[value.item.id]!, context(value.field, value.version), newRing)).toBe(value.plaintext);
      }
      const serialized = JSON.stringify(persisted);
      for (const value of values) expect(serialized).not.toContain(value.plaintext);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses unresolved operations without changing ciphertext", async () => {
    const root = await mkdtemp(join(tmpdir(), "compose-admin-busy-"));
    const dataDir = join(root, "data");
    const keyringFile = join(root, "compose-keyring.json");
    try {
      await mkdir(dataDir, { recursive: true });
      const oldRing = testKeyring();
      await saveKeyringToFile(keyringFile, oldRing);
      const envelope = encryptComposeField("busy-secret", context("secret", "TOKEN:1"), oldRing);
      const state = { applications: [], secrets: [{ id: "secret-1", vpsId: "vps-admin-test", appId: "app-admin-test", name: "TOKEN", version: 1, envelope, updatedAt: "2026-01-01T00:00:00.000Z" }], credentials: [], revisions: [], previews: [], operations: [{ id: "op-1", vpsId: "vps-admin-test", appId: "app-admin-test", kind: "deploy", status: "running", request: {}, generation: 1, idempotencyKey: "x", requestDigest: "x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], containerContentions: [] };
      await writeFile(join(dataDir, "docker-applications.json"), JSON.stringify(state));
      const before = await readFile(join(dataDir, "docker-applications.json"), "utf8");
      const admin = await createComposeAdminContext(configFor(dataDir, keyringFile));
      try {
        expect(await admin.rotateEncryptedFields({ dryRun: true })).toMatchObject({ rewrapped: 0, refusedAppIds: ["app-admin-test"], conflictCode: "busy" });
        expect(await admin.rotateEncryptedFields()).toMatchObject({ rewrapped: 0, refusedAppIds: ["app-admin-test"], conflictCode: "busy" });
      } finally { await admin.__release(); }
      expect(JSON.parse(await readFile(join(dataDir, "docker-applications.json"), "utf8"))).toEqual(JSON.parse(before));
      expect(decryptComposeField(envelope, context("secret", "TOKEN:1"), oldRing)).toBe("busy-secret");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  const databaseUrl = process.env.VPS_MANAGER_TEST_POSTGRES_URL;
  it.skipIf(!databaseUrl)("rewraps the PostgreSQL JSONB admin repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "compose-admin-pg-"));
    const schema = `compose_admin_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const adminPool = new pg.Pool({ connectionString: databaseUrl });
    let pool: pg.Pool | undefined;
    try {
      await adminPool.query(`CREATE SCHEMA "${schema}"`);
      pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
      await pool.query("CREATE TABLE docker_application_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload JSONB NOT NULL)");
      const ring = testKeyring();
      const keyringFile = join(root, "external-keyring.json");
      await saveKeyringToFile(keyringFile, ring);
      const state = { applications: [], operations: [], containerContentions: [], revisions: [], secrets: [], credentials: [], previews: [] };
      for (const value of values) {
        const envelope = encryptComposeField(value.plaintext, context(value.field, value.version), ring);
        const row = { ...value.item, appId: "app-admin-test", vpsId: "vps-admin-test", ...(value.bucket === "previews" ? { resolvedModelEnvelope: envelope } : { envelope }) };
        (state[value.bucket] as unknown[]).push(row);
      }
      await pool.query("INSERT INTO docker_application_state(id,payload) VALUES(1,$1::jsonb)", [JSON.stringify(state)]);
      const scopedUrl = new URL(databaseUrl!);
      scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
      const config = configFor(root, keyringFile, "postgres", scopedUrl.toString());
      const repo = await createComposeAdminContext(config);
      try {
        const rotation = await rotateKeyring(keyringFile);
        expect(rotation.previousKekId).toBe("old");
        expect(await repo.rotateEncryptedFields()).toMatchObject({ rewrapped: 4, refusedAppIds: [] });
      } finally { await repo.__release(); }
      const { rows } = await pool.query<{ payload: Record<string, EnvelopeItem[]> }>("SELECT payload FROM docker_application_state WHERE id=1");
      for (const value of values) {
        const row = rows[0]!.payload[value.bucket].find((candidate) => candidate.id === value.item.id)!;
        const envelope = value.bucket === "previews" ? row.resolvedModelEnvelope! : row.envelope!;
        expect(decryptComposeField(envelope, context(value.field, value.version), JSON.parse(await readFile(keyringFile, "utf8")) as Keyring)).toBe(value.plaintext);
      }
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await adminPool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
