import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { createPostgresVpsRepository } from "../src/persistence/repositories/vps.postgres.repository.js";
import { InMemorySettingsRepository } from "../src/persistence/repositories/settings.repository.js";
import { runMigrations } from "../src/db/migrations.js";
import type { FileEntry, FilesConnection, FilesTransport } from "../src/files/files.models.js";
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
  jobHistoryLimit: 100,
  auditHistoryLimit: 100,
  metricWindowLimit: 100,
  dockerRetentionDays: 7,
  dockerRollupRetentionDays: 30,
  dockerResolvedAlertRetentionDays: 30,
  dockerMaintenanceSamplesPerVps: 1000,
  dockerMaintenanceEventsPerVps: 1000,
  dockerJsonMaxBytes: 10 * 1024 * 1024,
  dockerJsonMaintenanceMaxRewriteBytes: 5 * 1024 * 1024,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "permissive",
};

class MockTransport implements FilesTransport {
  constructor(
    public entries: FileEntry[] = [
      {
        name: "test.txt",
        path: "/test.txt",
        type: "file",
        size: 12,
        modifiedAt: "2026-10-18T10:00:00Z",
        mode: 0o644,
      },
    ],
  ) {}

  async open(): Promise<FilesConnection> {
    return {
      close: () => {},
      list: async (path: string) => ({
        path,
        entries: this.entries,
      }),
      download: async (_path: string, output) => {
        const data = Buffer.from("hello world\n");
        output.write(data);
        output.end();
        return data.length;
      },
      upload: async (_path: string, input) => {
        let bytes = 0;
        for await (const chunk of input) {
          bytes += (chunk as Buffer).length;
        }
        return bytes;
      },
      mkdir: async () => {},
      rename: async () => {},
      delete: async () => {},
    };
  }
}

describe("Files API", () => {
  let tempDir: string;
  let sessionCookie: string;
  let mockTransport: MockTransport;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vps-files-test-"));
    sessionCookie = await createSessionCookie(tempDir, SESSION_SECRET);
    mockTransport = new MockTransport();
  });

  afterEach(async () => {
    await closeTestApps();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function makeApp(configOverrides: Partial<AppConfig> = {}, customTransport?: FilesTransport) {
    const store = createVpsStore(join(tempDir, "data", "vps.json"));
    return {
      app: createApp({
        config: {
          ...baseConfig,
          dataDir: join(tempDir, "data"),
          privateDir: join(tempDir, "private"),
          ...configOverrides,
        },
        store,
        keys: createKeyService({ baseDir: join(tempDir, "private", "keys") }),
        audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
        settings: new InMemorySettingsRepository(),
        localFilesTransport: customTransport ?? mockTransport,
        remoteFilesTransport: customTransport ?? mockTransport,
      }),
      store,
    };
  }

  it("finishes remote writes after the complete HTTP upload body arrives", async () => {
    const transport: FilesTransport = {
      open: async (_vps, signal) => ({
        ...(await mockTransport.open()),
        upload: async (_path, input) => {
          let bytes = 0;
          for await (const chunk of input) bytes += (chunk as Buffer).length;
          await new Promise(resolve => setTimeout(resolve, 30));
          signal.throwIfAborted();
          return bytes;
        },
      }),
    };
    const { app, store } = makeApp({}, transport);
    const vps = await store.create({ name: "upload", host: "example.test", port: 22, username: "root" });
    await store.update(vps.id, { sftpEnabled: true });
    const payload = Buffer.alloc(128 * 1024, 0x37);
    const response = await request(app).put(`/api/vps/${vps.id}/files/upload?path=/binary`)
      .set("Cookie", sessionCookie).set("Origin", ORIGIN)
      .set("Content-Type", "application/octet-stream").send(payload).expect(201);
    expect(response.body.data.bytes).toBe(payload.length);
  });

  it("downloads Unicode filenames with an ASCII fallback and RFC5987 filename", async () => {
    const { app, store } = makeApp();
    const vps = await store.create({ name: "download", host: "example.test", port: 22, username: "root" });
    await store.update(vps.id, { sftpEnabled: true });
    const path = "/Việt's (file).txt";
    const response = await request(app).get(`/api/vps/${vps.id}/files/download`)
      .query({ path }).set("Cookie", sessionCookie).expect(200);
    expect(response.headers["content-disposition"]).toBe(
      "attachment; filename=\"Vi_t's (file).txt\"; filename*=UTF-8''Vi%E1%BB%87t%27s%20%28file%29.txt",
    );
    expect(response.body).toEqual(Buffer.from("hello world\n"));
  });

  describe("Authentication and Origin Guards", () => {
    it("rejects unauthenticated requests in local mode with 401", async () => {
      const { app, store } = makeApp();
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });

      await request(app)
        .get(`/api/vps/${vps.id}/files/capabilities`)
        .expect(401);

      await request(app)
        .get(`/api/vps/${vps.id}/files/entries`)
        .expect(401);

      await request(app)
        .post(`/api/vps/${vps.id}/files/directory`)
        .send({ path: "/test" })
        .expect(401);
    });

    it("rejects mutations without Origin or with wrong Origin with 403", async () => {
      const { app, store } = makeApp();
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });

      // Missing origin
      await request(app)
        .post(`/api/vps/${vps.id}/files/directory`)
        .set("Cookie", sessionCookie)
        .send({ path: "/test" })
        .expect(403);

      // Wrong origin
      await request(app)
        .post(`/api/vps/${vps.id}/files/directory`)
        .set("Cookie", sessionCookie)
        .set("Origin", "https://attacker.example.com")
        .send({ path: "/test" })
        .expect(403);
    });
  });

  describe("Demo Mode Restrictions", () => {
    it("reports unavailable in capabilities and blocks operations in demo mode", async () => {
      const { app, store } = makeApp({ mode: "demo" });
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });

      const capRes = await request(app)
        .get(`/api/vps/${vps.id}/files/capabilities`)
        .expect(200);

      expect(capRes.body.data.enabled).toBe(false);
      expect(capRes.body.data.available).toBe(false);
      expect(capRes.body.data.reason).toMatch(/demo/i);

      const entriesRes = await request(app)
        .get(`/api/vps/${vps.id}/files/entries`)
        .expect(403);

      expect(entriesRes.body.error.code).toBe("DEMO_UNAVAILABLE");

      const dirRes = await request(app)
        .post(`/api/vps/${vps.id}/files/directory`)
        .set("Origin", ORIGIN)
        .send({ path: "/test" })
        .expect(403);

      expect(dirRes.body.error.code).toBe("DEMO_UNAVAILABLE");
    });
  });

  describe("Per-VPS SFTP Enabled State", () => {
    it("blocks access with FILES_DISABLED when sftpEnabled is false", async () => {
      const { app, store } = makeApp();
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });

      expect(vps.sftpEnabled).toBe(false);

      const capRes = await request(app)
        .get(`/api/vps/${vps.id}/files/capabilities`)
        .set("Cookie", sessionCookie)
        .expect(200);

      expect(capRes.body.data.enabled).toBe(false);
      expect(capRes.body.data.available).toBe(false);

      const listRes = await request(app)
        .get(`/api/vps/${vps.id}/files/entries`)
        .set("Cookie", sessionCookie)
        .expect(403);

      expect(listRes.body.error.code).toBe("FILES_DISABLED");
    });

    it("enabling VPS A does not enable VPS B", async () => {
      const { app, store } = makeApp();
      const vpsA = await store.create({
        name: "vps-a",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });
      const vpsB = await store.create({
        name: "vps-b",
        host: "10.0.0.2",
        port: 22,
        username: "root",
      });

      // Enable VPS A
      await store.update(vpsA.id, { sftpEnabled: true });

      const capA = await request(app)
        .get(`/api/vps/${vpsA.id}/files/capabilities`)
        .set("Cookie", sessionCookie)
        .expect(200);

      expect(capA.body.data.enabled).toBe(true);
      expect(capA.body.data.available).toBe(true);

      const capB = await request(app)
        .get(`/api/vps/${vpsB.id}/files/capabilities`)
        .set("Cookie", sessionCookie)
        .expect(200);

      expect(capB.body.data.enabled).toBe(false);
      expect(capB.body.data.available).toBe(false);
    });
  });

  describe("File Operations", () => {
    it("executes list, download, upload, mkdir, rename, delete successfully", async () => {
      const { app, store } = makeApp();
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });
      await store.update(vps.id, { sftpEnabled: true });

      // List
      const listRes = await request(app)
        .get(`/api/vps/${vps.id}/files/entries?path=/`)
        .set("Cookie", sessionCookie)
        .expect(200);

      expect(listRes.body.data.entries).toHaveLength(1);
      expect(listRes.body.data.entries[0].name).toBe("test.txt");

      // Download
      const downloadRes = await request(app)
        .get(`/api/vps/${vps.id}/files/download?path=/test.txt`)
        .set("Cookie", sessionCookie)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks).toString("utf8")));
        })
        .expect(200);

      expect(downloadRes.headers["content-type"]).toBe("application/octet-stream");
      expect(downloadRes.headers["cache-control"]).toBe("no-store");
      expect(downloadRes.headers["x-content-type-options"]).toBe("nosniff");
      expect(downloadRes.headers["content-disposition"]).toContain("attachment");
      expect(downloadRes.body).toBe("hello world\n");
      // Upload
      const uploadRes = await request(app)
        .put(`/api/vps/${vps.id}/files/upload?path=/newfile.txt`)
        .set("Cookie", sessionCookie)
        .set("Origin", ORIGIN)
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("new file content"))
        .expect(201);

      expect(uploadRes.body.data.path).toBe("/newfile.txt");
      expect(uploadRes.body.data.bytes).toBe(16);

      // Mkdir
      const mkdirRes = await request(app)
        .post(`/api/vps/${vps.id}/files/directory`)
        .set("Cookie", sessionCookie)
        .set("Origin", ORIGIN)
        .send({ path: "/newdir" })
        .expect(201);

      expect(mkdirRes.body.data.path).toBe("/newdir");

      // Rename
      const renameRes = await request(app)
        .post(`/api/vps/${vps.id}/files/rename`)
        .set("Cookie", sessionCookie)
        .set("Origin", ORIGIN)
        .send({ path: "/test.txt", newPath: "/renamed.txt" })
        .expect(200);

      expect(renameRes.body.data.path).toBe("/renamed.txt");

      // Delete
      await request(app)
        .delete(`/api/vps/${vps.id}/files/entry?path=/renamed.txt`)
        .set("Cookie", sessionCookie)
        .set("Origin", ORIGIN)
        .expect(204);
    });

    it("rejects invalid paths with 400 INVALID_PATH", async () => {
      const { app, store } = makeApp();
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });
      await store.update(vps.id, { sftpEnabled: true });

      // Relative path
      await request(app)
        .get(`/api/vps/${vps.id}/files/download?path=relative/path`)
        .set("Cookie", sessionCookie)
        .expect(400);

      // Null byte
      await request(app)
        .get(`/api/vps/${vps.id}/files/download?path=/test\0.txt`)
        .set("Cookie", sessionCookie)
        .expect(400);

      // Root path mutation
      await request(app)
        .delete(`/api/vps/${vps.id}/files/entry?path=/`)
        .set("Cookie", sessionCookie)
        .set("Origin", ORIGIN)
        .expect(400);
    });

    it("rejects uploads with wrong content-type with 415", async () => {
      const { app, store } = makeApp();
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });
      await store.update(vps.id, { sftpEnabled: true });

      await request(app)
        .put(`/api/vps/${vps.id}/files/upload?path=/test.txt`)
        .set("Cookie", sessionCookie)
        .set("Origin", ORIGIN)
        .set("Content-Type", "application/json")
        .send({ foo: "bar" })
        .expect(415);
    });
  });

  describe("Concurrency and Streaming Limits", () => {
    it("returns 429 FILES_BUSY when exceeding per-VPS concurrent operation limit", async () => {
      let resolveFirst: () => void;
      let resolveSecond: () => void;
      let enteredFirst: () => void;
      let enteredSecond: () => void;

      const enteredFirstPromise = new Promise<void>((r) => { enteredFirst = r; });
      const enteredSecondPromise = new Promise<void>((r) => { enteredSecond = r; });

      let count = 0;
      const blockingTransport: FilesTransport = {
        async open() {
          count++;
          const current = count;
          return {
            close: () => {},
            list: async () => {
              if (current === 1) {
                enteredFirst();
                await new Promise<void>((r) => { resolveFirst = r; });
              } else if (current === 2) {
                enteredSecond();
                await new Promise<void>((r) => { resolveSecond = r; });
              }
              return { path: "/", entries: [] };
            },
            download: async () => 0,
            upload: async () => 0,
            mkdir: async () => {},
            rename: async () => {},
            delete: async () => {},
          };
        },
      };

      const { app, store } = makeApp({}, blockingTransport);
      const vps = await store.create({
        name: "test-vps",
        host: "10.0.0.1",
        port: 22,
        username: "root",
      });
      await store.update(vps.id, { sftpEnabled: true });

      // Start op 1 and wait until it is inside list()
      const p1 = request(app)
        .get(`/api/vps/${vps.id}/files/entries`)
        .set("Cookie", sessionCookie)
        .then((res) => res);
      await enteredFirstPromise;

      // Start op 2 and wait until it is inside list()
      const p2 = request(app)
        .get(`/api/vps/${vps.id}/files/entries`)
        .set("Cookie", sessionCookie)
        .then((res) => res);
      await enteredSecondPromise;

      // Attempt op 3 - should be rejected with 429 immediately
      const res3 = await request(app)
        .get(`/api/vps/${vps.id}/files/entries`)
        .set("Cookie", sessionCookie)
        .expect(429);

      expect(res3.body.error.code).toBe("FILES_BUSY");

      resolveFirst!();
      resolveSecond!();
      await Promise.all([p1, p2]);
    });
  });

  describe("PostgreSQL Persistence Verification", () => {
    const testDbUrl =
      process.env.TEST_DATABASE_URL ||
      "postgres://postgres:files-disposable-test@127.0.0.1:55439/files_test";

    it("persists sftp_enabled flag through migrations and updates on disposable PostgreSQL", async () => {
      let pool: Pool | null = null;
      try {
        pool = new Pool({ connectionString: testDbUrl, connectionTimeoutMillis: 2000 });
        await pool.query("SELECT 1");
      } catch (e) {
        console.warn(`PostgreSQL test skipped: ${testDbUrl} unreachable (${e})`);
        return;
      }

      try {
        // Run migrations
        await runMigrations(pool, { includeOptional: false });

        const repo = createPostgresVpsRepository(pool);
        const vps = await repo.create({
          name: "postgres-files-test",
          host: "10.0.0.99",
          port: 22,
          username: "testuser",
        });

        // Default should be false
        expect(vps.sftpEnabled).toBe(false);

        // Update sftpEnabled to true
        const updated = await repo.update(vps.id, { sftpEnabled: true });
        expect(updated?.sftpEnabled).toBe(true);

        // Fetch back from DB
        const reloaded = await repo.get(vps.id);
        expect(reloaded?.sftpEnabled).toBe(true);

        // Ensure other fields not overwritten
        const partialUpdate = await repo.update(vps.id, { dockerMetricsEnabled: true });
        expect(partialUpdate?.dockerMetricsEnabled).toBe(true);
        expect(partialUpdate?.sftpEnabled).toBe(true);

        // Clean up
        await repo.delete(vps.id);
      } finally {
        await pool.end();
      }
    });
  });
});
