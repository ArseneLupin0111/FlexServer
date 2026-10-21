import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonSessionRepository } from "../src/persistence/repositories/session.repository.js";
import { createJsonAdminCredentialRepository } from "../src/persistence/repositories/admin-credential.repository.js";
import { hashPassword, verifyPassword } from "../src/auth/password-hash.js";
import { SESSION_COOKIE_NAME } from "../src/auth/cookies.js";

const SESSION_SECRET = "test-session-secret";
const TEST_PASSWORD = "valid-test-password-123";
const ORIGIN = "http://127.0.0.1";
const HOST = "127.0.0.1";

const localConfig: AppConfig = {
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
  dashboardSessionSecret: SESSION_SECRET,
  dashboardSessionTtlSeconds: 86_400,
  dashboardCookieSecure: false,
  dashboardCookieSameSite: "lax",
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-auth-"));
});

afterEach(async () => {
  await closeTestApps();
  await rm(tempDir, { recursive: true, force: true });
});

function app(overrides?: Partial<AppConfig>) {
  const config = { ...localConfig, ...overrides };
  return createApp({
    config: {
      ...config,
      dataDir: join(tempDir, "data"),
      privateDir: join(tempDir, "private"),
    },
    store: createVpsStore(join(tempDir, "data", "vps.json")),
    keys: createKeyService(join(tempDir, "private", "keys")),
    audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
  });
}

/** Seed a password credential into the JSON store for a given app. */
async function seedCredential(password: string) {
  const repo = createJsonAdminCredentialRepository(
    join(tempDir, "data", "admin-credential.json"),
  );
  const passwordHash = hashPassword(password);
  await repo.upsert({
    passwordHash,
    passwordAlgorithm: "scrypt",
    passwordParams: JSON.stringify({ N: 16384, r: 8, p: 1 }),
  });
}

// ── Password hash unit tests ───────────────────────────────────────────

describe("password hashing", () => {
  it("hashPassword produces a valid scrypt string", () => {
    const hash = hashPassword(TEST_PASSWORD);
    expect(hash).toMatch(
      /^scrypt\$[0-9a-f]+\$[0-9a-f]+\$[0-9a-f]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/,
    );
  });

  it("verifyPassword returns true for the correct password", () => {
    const hash = hashPassword(TEST_PASSWORD);
    expect(verifyPassword(TEST_PASSWORD, hash)).toBe(true);
  });

  it("verifyPassword returns false for wrong password", () => {
    const hash = hashPassword(TEST_PASSWORD);
    expect(verifyPassword("wrong-password-here", hash)).toBe(false);
  });

  it("verifyPassword returns false for malformed stored hash", () => {
    expect(verifyPassword(TEST_PASSWORD, "invalid:hash")).toBe(false);
    expect(verifyPassword(TEST_PASSWORD, "")).toBe(false);
    expect(verifyPassword(TEST_PASSWORD, null as unknown as string)).toBe(
      false,
    );
    expect(verifyPassword(TEST_PASSWORD, "scrypt$4000")).toBe(false);
    expect(
      verifyPassword(TEST_PASSWORD, "scrypt$4000$8$1$salt$hash$extra"),
    ).toBe(false);
  });

  it("verifyPassword returns false for extreme/unsafe scrypt params without throwing", () => {
    // N not a power of 2
    expect(verifyPassword(TEST_PASSWORD, "scrypt$4001$8$1$dGVzdA$dGVzdA")).toBe(
      false,
    );
    // N too small
    expect(verifyPassword(TEST_PASSWORD, "scrypt$100$8$1$dGVzdA$dGVzdA")).toBe(
      false,
    );
    // N too large
    expect(
      verifyPassword(TEST_PASSWORD, "scrypt$200000$8$1$dGVzdA$dGVzdA"),
    ).toBe(false);
    // r out of bounds
    expect(
      verifyPassword(TEST_PASSWORD, "scrypt$4000$999$1$dGVzdA$dGVzdA"),
    ).toBe(false);
    // p out of bounds
    expect(
      verifyPassword(TEST_PASSWORD, "scrypt$4000$8$999$dGVzdA$dGVzdA"),
    ).toBe(false);
    // salt too short
    expect(
      verifyPassword(TEST_PASSWORD, "scrypt$4000$8$1$dGVzdA$dGVzdGVzdA"),
    ).toBe(false);
    // hash too short
    expect(
      verifyPassword(TEST_PASSWORD, "scrypt$4000$8$1$dGVzdGFkdmFsdWU$dGVzdA"),
    ).toBe(false);
  });

  it("produces different hashes for same password (random salt)", () => {
    const a = hashPassword(TEST_PASSWORD);
    const b = hashPassword(TEST_PASSWORD);
    expect(a).not.toBe(b);
  });
});


// ── Login via password (primary path) ──────────────────────────────────

describe("POST /api/auth/login", () => {
  it("returns 401 with invalid password", async () => {
    await seedCredential(TEST_PASSWORD);
    const res = await request(app())
      .post("/api/auth/login")
      .send({ password: "wrong-password-here-!!!!" })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid credentials");
    // No hash leakage in error response
    expect(JSON.stringify(res.body)).not.toContain("scrypt");
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("returns 401 with missing password field", async () => {
    await seedCredential(TEST_PASSWORD);
    const res = await request(app())
      .post("/api/auth/login")
      .send({})
      .expect(401);
    expect(res.body.error.message).toBe("Invalid credentials");
  });

  it("rejects token field even when credential IS configured", async () => {
    await seedCredential(TEST_PASSWORD);
    const res = await request(app())
      .post("/api/auth/login")
      .send({ token: "anything" })
      .expect(401);
    expect(res.body.error.message).toBe("Invalid credentials");
  });

  it("sets HttpOnly SameSite=Lax cookie and returns AuthStatus shape on password login", async () => {
    await seedCredential(TEST_PASSWORD);
    const server = app();
    const res = await request(server)
      .post("/api/auth/login")
      .send({ password: TEST_PASSWORD })
      .expect(201);

    // AuthStatus shape
    expect(res.body.data).toMatchObject({
      mode: "local",
      authenticated: true,
      authRequired: true,
    });
    expect(res.body.data.session).toBeDefined();
    expect(res.body.data.session.id).toMatch(/^sess_/);

    // Set-Cookie
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookie).toContain(SESSION_COOKIE_NAME);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("Path=/");

    // Cookie works for subsequent requests
    const meRes = await request(server)
      .get("/api/auth/me")
      .set("Cookie", cookie!.split(";")[0]!)
      .expect(200);
    expect(meRes.body.data.authenticated).toBe(true);
  });

  it("does not log the submitted password in error responses", async () => {
    await seedCredential(TEST_PASSWORD);
    const res = await request(app())
      .post("/api/auth/login")
      .send({ password: TEST_PASSWORD + "wrong" })
      .expect(401);
    expect(JSON.stringify(res.body)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain("password");
  });
});

// ── Login rate limiting ────────────────────────────────────────────────

describe("POST /api/auth/login rate limiting", () => {
  it("returns 429 after 6 rapid password attempts", async () => {
    await seedCredential(TEST_PASSWORD);
    const server = app();
    for (let i = 0; i < 5; i++) {
      await request(server)
        .post("/api/auth/login")
        .send({ password: "some-other-password-123456" })
        .expect(401);
    }
    const res = await request(server)
      .post("/api/auth/login")
      .send({ password: "some-other-password-789012" })
      .expect(429);
    expect(res.body.error.message).toContain("Too many login attempts");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

// ── Logout ─────────────────────────────────────────────────────────────

describe("POST /api/auth/logout", () => {
  /** Create a session directly and return the cookie header value. */
  async function createSession(): Promise<string> {
    const repo = createJsonSessionRepository(
      join(tempDir, "data", "sessions.json"),
    );
    const raw = "b".repeat(64);
    const hash = createHash("sha256")
      .update(raw)
      .update(SESSION_SECRET)
      .digest("hex");
    await repo.create({
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return `${SESSION_COOKIE_NAME}=${raw}`;
  }

  it("clears cookie and revokes session", async () => {
    const server = app();
    const cookie = await createSession();

    const res = await request(server)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)
      .set("Host", HOST)
      .expect(201);

    expect(res.body.data).toEqual({ ok: true });

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cleared = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=");
    expect(cleared).toContain("Path=/");

    // Session no longer valid
    const meRes = await request(server)
      .get("/api/auth/me")
      .set("Cookie", cookie)
      .expect(200);
    expect(meRes.body.data.authenticated).toBe(false);
  });

  it("rejects logout without Origin for unsafe POST", async () => {
    const server = app();
    const cookie = await createSession();
    await request(server)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .expect(403);
  });

  it("rejects logout from disallowed Origin", async () => {
    const server = app();
    const cookie = await createSession();
    await request(server)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.com")
      .set("Host", HOST)
      .expect(403);
  });
});

// ── Auth me ────────────────────────────────────────────────────────────

describe("GET /api/auth/me", () => {
  async function createSession(): Promise<string> {
    const repo = createJsonSessionRepository(
      join(tempDir, "data", "sessions.json"),
    );
    const raw = "c".repeat(64);
    const hash = createHash("sha256")
      .update(raw)
      .update(SESSION_SECRET)
      .digest("hex");
    await repo.create({
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return `${SESSION_COOKIE_NAME}=${raw}`;
  }

  it("returns unauthenticated status when no cookie", async () => {
    const res = await request(app()).get("/api/auth/me").expect(200);
    expect(res.body.data).toEqual({
      mode: "local",
      authenticated: false,
      authRequired: true,
    });
  });

  it("returns authenticated status with valid cookie", async () => {
    const server = app();
    const cookie = await createSession();
    const res = await request(server)
      .get("/api/auth/me")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.data).toMatchObject({
      mode: "local",
      authenticated: true,
      authRequired: true,
    });
    expect(res.body.data.session.id).toMatch(/^sess_/);
  });

  it("returns unauthenticated for expired sessions", async () => {
    const server = app();
    const repo = createJsonSessionRepository(
      join(tempDir, "data", "sessions.json"),
    );
    const raw = "expired";
    const hash = createHash("sha256")
      .update(raw)
      .update(SESSION_SECRET)
      .digest("hex");
    await repo.create({
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await request(server)
      .get("/api/auth/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${raw}`)
      .expect(200);
    expect(res.body.data.authenticated).toBe(false);
  });
});
