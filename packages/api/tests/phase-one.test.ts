import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, closeTestApps } from "./test-helpers.js";
import type { AppConfig } from "../src/config/app-config.js";
import { parseAppConfig } from "../src/config/app-config.js";
import { redactString, redactValue } from "../src/common/redaction.js";
import { SshHostBlockedError } from "../src/common/errors.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import {
  assertSshHostAllowed,
  assertSshHostAllowedAsync,
  computeFingerprint,
  createHostVerifier,
} from "../src/ssh/ssh-host-policy.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";

// ---------------------------------------------------------------------------
// Mock node:dns/promises so no test touches real DNS
// ---------------------------------------------------------------------------
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

// Dynamically import the mocked module so we can set up responses
async function mockDns() {
  const dns = await import("node:dns/promises");
  return dns.lookup as import("vitest").Mock;
}

// ---------------------------------------------------------------------------
// Mock ssh2 Client for TOCTOU test — tracks connect args, auto-emits ready
// Exposes __testing helpers so test code can inspect connect args.
// ---------------------------------------------------------------------------
vi.mock("ssh2", () => {
  const connectArgs: Array<Record<string, unknown>> = [];
  let readyHandler: (() => void) | null = null;

  function MockClient() {
    // constructor
  }
  MockClient.prototype.once = function (event: string, cb: Function) {
    if (event === "ready") readyHandler = cb as () => void;
    return this;
  };
  MockClient.prototype.connect = function (opts: Record<string, unknown>) {
    connectArgs.push(opts);
    if (readyHandler) setImmediate(readyHandler);
  };
  MockClient.prototype.end = function () {};

  return {
    Client: MockClient as never,
    __testing: {
      getConnectArgs: () => connectArgs,
      reset: () => {
        connectArgs.length = 0;
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

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
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

const localConfig: AppConfig = {
  ...demoConfig,
  mode: "local",
  allowPrivateNetworkTargets: true,
  dashboardSessionSecret: "local-test-session-secret-32+chars!!",
};

async function testHarness(config: AppConfig = demoConfig) {
  const tempDir = await mkdtemp(join(tmpdir(), "vps-manager-phase-one-"));
  const scopedConfig = {
    ...config,
    dataDir: join(tempDir, "data"),
    privateDir: join(tempDir, "private"),
  };
  return {
    tempDir,
    server: createApp({
      config: scopedConfig,
      store: createVpsStore(join(tempDir, "data", "vps.json")),
      keys: createKeyService(join(tempDir, "private", "keys")),
      audit: createJsonAuditRepository(join(tempDir, "data", "audit.json")),
    }),
  };
}

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

describe("phase one config", () => {
  it("defaults to safe demo mode", () => {
    expect(parseAppConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      mode: "demo",
      enableWebTerminal: false,
      allowPrivateNetworkTargets: false,
      dataDir: "data",
      privateDir: "private",
    });
  });

  it("accepts blank local auth token in demo mode", () => {
    expect(
      parseAppConfig({ APP_MODE: "demo" } as NodeJS.ProcessEnv),
    ).toMatchObject({
      mode: "demo",
    });
  });

  it("fails fast for unsafe local and terminal settings", () => {
    expect(() =>
      parseAppConfig({ APP_MODE: "local" } as NodeJS.ProcessEnv),
    ).toThrow(/DASHBOARD_SESSION_SECRET/);
    expect(() =>
      parseAppConfig({
        APP_MODE: "local",
        DASHBOARD_SESSION_SECRET: "",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DASHBOARD_SESSION_SECRET/);
    expect(() =>
      parseAppConfig({
        APP_MODE: "demo",
        ENABLE_WEB_TERMINAL: "true",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ENABLE_WEB_TERMINAL/);
  });

  it("rejects short DASHBOARD_SESSION_SECRET in local mode", () => {
    expect(() =>
      parseAppConfig({
        APP_MODE: "local",
        DASHBOARD_SESSION_SECRET: "short",
      } as NodeJS.ProcessEnv),
    ).toThrow(/at least 32 characters/);
  });

  it("rejects SameSite=none without Secure", () => {
    expect(() =>
      parseAppConfig({
        DASHBOARD_COOKIE_SAME_SITE: "none",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DASHBOARD_COOKIE_SAME_SITE=none requires/);
  });

  it("rejects SameSite=none with Secure=false explicitly", () => {
    expect(() =>
      parseAppConfig({
        DASHBOARD_COOKIE_SAME_SITE: "none",
        DASHBOARD_COOKIE_SECURE: "false",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DASHBOARD_COOKIE_SAME_SITE=none requires/);
  });

  it("accepts SameSite=none with Secure=true", () => {
    const parsed = parseAppConfig({
      DASHBOARD_COOKIE_SAME_SITE: "none",
      DASHBOARD_COOKIE_SECURE: "true",
    } as NodeJS.ProcessEnv);
    expect(parsed.dashboardCookieSameSite).toBe("none");
    expect(parsed.dashboardCookieSecure).toBe(true);
  });

  it("rejects https DASHBOARD_PUBLIC_ORIGIN without Secure in local mode", () => {
    expect(() =>
      parseAppConfig({
        APP_MODE: "local",
        DASHBOARD_SESSION_SECRET: "a".repeat(32),
        DASHBOARD_PUBLIC_ORIGIN: "https://example.com",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DASHBOARD_COOKIE_SECURE=true is required/);
  });

  it("accepts https DASHBOARD_PUBLIC_ORIGIN with Secure in local mode", () => {
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "a".repeat(32),
      DASHBOARD_PUBLIC_ORIGIN: "https://example.com",
      DASHBOARD_COOKIE_SECURE: "true",
    } as NodeJS.ProcessEnv);
    expect(parsed.dashboardCookieSecure).toBe(true);
  });

  it("allows http DASHBOARD_PUBLIC_ORIGIN without Secure in local mode", () => {
    const parsed = parseAppConfig({
      APP_MODE: "local",
      DASHBOARD_SESSION_SECRET: "a".repeat(32),
      DASHBOARD_PUBLIC_ORIGIN: "http://localhost:3000",
    } as NodeJS.ProcessEnv);
    expect(parsed.dashboardPublicOrigin).toBe("http://localhost:3000");
  });
});

// ---------------------------------------------------------------------------
// Redaction tests
// ---------------------------------------------------------------------------

describe("phase one redaction", () => {
  it("redacts secret keys and secret-looking strings", () => {
    expect(
      redactString("password=secret ssh-ed25519 AAAATEST user@example"),
    ).not.toContain("secret");
    expect(
      redactString(
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      ),
    ).toBe("[REDACTED]");
    expect(
      redactValue({
        password: "secret",
        nested: { privateKey: "key" },
        ok: "visible",
      }),
    ).toEqual({
      password: "[REDACTED]",
      nested: { privateKey: "[REDACTED]" },
      ok: "visible",
    });
  });
});

// ---------------------------------------------------------------------------
// SSH host policy (sync literal checks)
// ---------------------------------------------------------------------------

describe("phase one SSH host policy", () => {
  it("blocks metadata, localhost, and private hosts unless explicitly local", () => {
    expect(() => assertSshHostAllowed("169.254.169.254", demoConfig)).toThrow(
      SshHostBlockedError,
    );
    expect(() => assertSshHostAllowed("localhost", demoConfig)).toThrow(
      SshHostBlockedError,
    );
    expect(() => assertSshHostAllowed("10.0.0.5", demoConfig)).toThrow(
      SshHostBlockedError,
    );

    expect(() => assertSshHostAllowed("10.0.0.5", localConfig)).not.toThrow();
    expect(() =>
      assertSshHostAllowed("203.0.113.20", demoConfig),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Host input validation (shared by sync + async)
// ---------------------------------------------------------------------------

describe("phase one host input validation", () => {
  const cases: { input: string; label: string }[] = [
    { input: "user@host", label: "userinfo" },
    { input: "host/path", label: "path" },
    { input: "host%20", label: "percent" },
    { input: "host:22", label: "host:port" },
    { input: "[::1]:22", label: "bracketed v6 with port" },
    { input: "[2001:db8::1]:2222", label: "bracketed v6 long port" },
  ];

  for (const { input, label } of cases) {
    it(`rejects ${label} - sync`, () => {
      expect(() => assertSshHostAllowed(input, demoConfig)).toThrow(
        SshHostBlockedError,
      );
    });
    it(`rejects ${label} - async`, async () => {
      await expect(
        assertSshHostAllowedAsync(input, demoConfig),
      ).rejects.toThrow(SshHostBlockedError);
    });
  }

  const goodIps = ["2001:db8::1", "fc00::1", "fd00::1", "203.0.113.20"];
  for (const ip of goodIps) {
    it(`preserves valid IPv6 literal: ${ip}`, () => {
      // Should not throw format validation — will be evaluated by policy instead
      expect(() => assertSshHostAllowed(ip, localConfig)).not.toThrow(
        SshHostBlockedError,
      );
    });
  }

  // ::1 and fe80::1 are valid IPv6 literals but correctly blocked by policy
  // (always-blocked, unlike fc::/7 which is conditional).
  // They are covered by "phase one IPv6 literal policy" tests below.
});

// ---------------------------------------------------------------------------
// DNS resolution policy (mocked)
// ---------------------------------------------------------------------------

describe("phase one DNS resolution policy", () => {
  beforeEach(async () => {
    const lookup = await mockDns();
    lookup.mockReset();
  });

  it("hostname resolving to metadata IP is blocked", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      assertSshHostAllowedAsync("metadata.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("hostname resolving to private IP is blocked without local+flag", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      assertSshHostAllowedAsync("private.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("hostname resolving to private IP is allowed with local+flag", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const result = await assertSshHostAllowedAsync(
      "private.example.com",
      localConfig,
    );
    expect(result).toBe("10.0.0.5");
  });

  it("hostname resolving to public IP is allowed and returns the IP", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "203.0.113.20", family: 4 }]);
    const result = await assertSshHostAllowedAsync(
      "public.example.com",
      demoConfig,
    );
    expect(result).toBe("203.0.113.20");
  });

  it("mixed public + private records is blocked", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([
      { address: "203.0.113.20", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      assertSshHostAllowedAsync("mixed.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("DNS failure is blocked (fail closed)", async () => {
    const lookup = await mockDns();
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertSshHostAllowedAsync("fail.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("DNS empty result is blocked (fail closed)", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([]);
    await expect(
      assertSshHostAllowedAsync("empty.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("hostname resolving to IPv6 public address is allowed", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "2001:db8::1", family: 6 }]);
    const result = await assertSshHostAllowedAsync(
      "ipv6.example.com",
      demoConfig,
    );
    expect(result).toBe("2001:db8::1");
  });

  it("hostname resolving to IPv6 ULA is blocked without local+flag", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "fc00::1", family: 6 }]);
    await expect(
      assertSshHostAllowedAsync("ula.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("hostname resolving to IPv6 ULA is allowed with local+flag", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    const result = await assertSshHostAllowedAsync(
      "ula-local.example.com",
      localConfig,
    );
    expect(result).toBe("fd00::1");
  });

  it("hostname resolving to IPv4-mapped IPv6 is classified by embedded IPv4", async () => {
    const lookup = await mockDns();
    // DNS returns ::ffff:10.0.0.5 which maps to private 10.0.0.5
    lookup.mockResolvedValue([{ address: "::ffff:10.0.0.5", family: 6 }]);
    await expect(
      assertSshHostAllowedAsync("mapped.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("hostname resolving to IPv4-mapped IPv6 allowed with local+flag returns embedded v4", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "::ffff:10.0.0.5", family: 6 }]);
    const result = await assertSshHostAllowedAsync(
      "mapped-local.example.com",
      localConfig,
    );
    expect(result).toBe("10.0.0.5");
  });

  it("hostname resolving to leading-zero mapped IPv6 blocked in demo", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([
      { address: "0000:0000:0000:0000:0000:ffff:0a00:0005", family: 6 },
    ]);
    await expect(
      assertSshHostAllowedAsync("leading-zero.example.com", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("hostname resolving to leading-zero mapped IPv6 allowed with local+flag returns embedded v4", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([
      { address: "0000:0000:0000:0000:0000:ffff:0a00:0005", family: 6 },
    ]);
    const result = await assertSshHostAllowedAsync(
      "leading-zero-local.example.com",
      localConfig,
    );
    expect(result).toBe("10.0.0.5");
  });
});

// ---------------------------------------------------------------------------
// IPv6 literal policy tests
// ---------------------------------------------------------------------------

describe("phase one IPv6 literal policy", () => {
  it("blocks ::1 localhost always", async () => {
    await expect(assertSshHostAllowedAsync("::1", demoConfig)).rejects.toThrow(
      SshHostBlockedError,
    );
    await expect(assertSshHostAllowedAsync("::1", localConfig)).rejects.toThrow(
      SshHostBlockedError,
    );
  });

  it("blocks :: unspecified always", async () => {
    await expect(assertSshHostAllowedAsync("::", demoConfig)).rejects.toThrow(
      SshHostBlockedError,
    );
  });

  // ---- Link-local fe80::/10 (first hextet 0xfe80 – 0xfebf) ----

  it("blocks fe80:: link-local always", async () => {
    await expect(
      assertSshHostAllowedAsync("fe80::1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
    await expect(
      assertSshHostAllowedAsync("fe80::1", localConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks fe90::1 link-local (fe80::/10 range boundary)", async () => {
    await expect(
      assertSshHostAllowedAsync("fe90::1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
    await expect(
      assertSshHostAllowedAsync("fe90::1", localConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks fea0::1 link-local (fe80::/10 range middle)", async () => {
    await expect(
      assertSshHostAllowedAsync("fea0::1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks febf::1 link-local (fe80::/10 range upper boundary)", async () => {
    await expect(
      assertSshHostAllowedAsync("febf::1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  // ---- ULA fc00::/7 ----

  it("blocks fc00::/7 ULA without local+flag", async () => {
    await expect(
      assertSshHostAllowedAsync("fc00::1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
    await expect(
      assertSshHostAllowedAsync("fd00::1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("allows fc00::/7 ULA with local+flag", async () => {
    await expect(
      assertSshHostAllowedAsync("fc00::1", localConfig),
    ).resolves.toBe("fc00::1");
    await expect(
      assertSshHostAllowedAsync("fd00::1", localConfig),
    ).resolves.toBe("fd00::1");
  });

  it("allows public IPv6", async () => {
    await expect(
      assertSshHostAllowedAsync("2001:db8::1", demoConfig),
    ).resolves.toBe("2001:db8::1");
  });

  // ---- Full-form loopback / unspecified ----

  it("blocks fully-expanded loopback 0:0:0:0:0:0:0:1", async () => {
    await expect(
      assertSshHostAllowedAsync("0:0:0:0:0:0:0:1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
    await expect(
      assertSshHostAllowedAsync("0:0:0:0:0:0:0:1", localConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks fully-expanded unspecified 0:0:0:0:0:0:0:0", async () => {
    await expect(
      assertSshHostAllowedAsync("0:0:0:0:0:0:0:0", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  // ---- Leading-zero mapped variants ----

  it("blocks leading-zero mapped localhost 0000:0000:0000:0000:0000:ffff:7f00:0001", async () => {
    await expect(
      assertSshHostAllowedAsync(
        "0000:0000:0000:0000:0000:ffff:7f00:0001",
        demoConfig,
      ),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks leading-zero mapped private 0000:0000:0000:0000:0000:ffff:0a00:0005 in demo", async () => {
    await expect(
      assertSshHostAllowedAsync(
        "0000:0000:0000:0000:0000:ffff:0a00:0005",
        demoConfig,
      ),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("allows leading-zero mapped private with local+flag and returns v4", async () => {
    const result = await assertSshHostAllowedAsync(
      "0000:0000:0000:0000:0000:ffff:0a00:0005",
      localConfig,
    );
    expect(result).toBe("10.0.0.5");
  });

  // ---- IPv4-mapped IPv6 ----

  it("blocks IPv4-mapped IPv6 localhost (dotted short)", async () => {
    await expect(
      assertSshHostAllowedAsync("::ffff:127.0.0.1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks IPv4-mapped IPv6 localhost (hex short)", async () => {
    await expect(
      assertSshHostAllowedAsync("::ffff:7f00:1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks IPv4-mapped IPv6 localhost (full 8-group dotted)", async () => {
    await expect(
      assertSshHostAllowedAsync("0:0:0:0:0:ffff:127.0.0.1", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("blocks IPv4-mapped IPv6 private (hex short) without local flag", async () => {
    await expect(
      assertSshHostAllowedAsync("::ffff:a00:5", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("allows IPv4-mapped IPv6 private (hex short) with local+flag returning v4", async () => {
    const result = await assertSshHostAllowedAsync("::ffff:a00:5", localConfig);
    expect(result).toBe("10.0.0.5");
  });

  it("blocks IPv4-mapped IPv6 private (full dotted) without local flag", async () => {
    await expect(
      assertSshHostAllowedAsync("::ffff:10.0.0.5", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });

  it("allows IPv4-mapped IPv6 private (full dotted) with local+flag", async () => {
    const result = await assertSshHostAllowedAsync(
      "::ffff:10.0.0.5",
      localConfig,
    );
    expect(result).toBe("10.0.0.5");
  });

  it("allows public hostname literal IP", async () => {
    const result = await assertSshHostAllowedAsync("203.0.113.20", demoConfig);
    expect(result).toBe("203.0.113.20");
  });

  it("blocks metadata IP", async () => {
    await expect(
      assertSshHostAllowedAsync("169.254.169.254", demoConfig),
    ).rejects.toThrow(SshHostBlockedError);
  });
});

// ---------------------------------------------------------------------------
// SSH host key verification
// ---------------------------------------------------------------------------

describe("phase one SSH host key verification", () => {
  const keyA = Buffer.from("test-key-a-1234567890", "utf-8");
  const fpA = computeFingerprint(keyA);

  const keyB = Buffer.from("test-key-b-0987654321", "utf-8");
  const fpB = computeFingerprint(keyB);

  const keyC = Buffer.from("test-key-c-rotated", "utf-8");
  const fpC = computeFingerprint(keyC);

  it("computeFingerprint produces canonical format", () => {
    const buf = Buffer.from("test-key-material", "utf-8");
    const fp = computeFingerprint(buf);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{27,43}$/);
    expect(fp).not.toContain("=");
  });

  it("host verifier accepts matching vpsId pin (single string)", () => {
    const pins: Record<string, string | string[]> = { "vps-1": fpA };
    const opts = {
      vpsId: "vps-1",
      host: "203.0.113.20",
      port: 22,
      pins,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    return new Promise<void>((done) => {
      verifier(keyA, (permitted) => {
        expect(permitted).toBe(true);
        done();
      });
    });
  });

  it("host verifier accepts matching host:port pin", () => {
    const pins: Record<string, string | string[]> = { "203.0.113.20:22": fpB };
    const opts = {
      vpsId: "other-vps",
      host: "203.0.113.20",
      port: 22,
      pins,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    return new Promise<void>((done) => {
      verifier(keyB, (permitted) => {
        expect(permitted).toBe(true);
        done();
      });
    });
  });

  it("host verifier accepts vpsId pin over host:port pin", () => {
    // Both present; vpsId should win
    const pins: Record<string, string | string[]> = {
      "vps-1": fpA,
      "203.0.113.20:22": fpB,
    };
    const opts = {
      vpsId: "vps-1",
      host: "203.0.113.20",
      port: 22,
      pins,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    // keyA matches vpsId pin -> accepted
    // keyB matches host:port pin but should not be checked since vpsId took priority
    return new Promise<void>((done) => {
      verifier(keyA, (permitted: boolean) => {
        expect(permitted).toBe(true);
        done();
      });
    });
  });

  it("host verifier rejects on fingerprint mismatch", () => {
    const pins: Record<string, string | string[]> = { "vps-1": fpA };
    const opts = {
      vpsId: "vps-1",
      host: "203.0.113.20",
      port: 22,
      pins,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    return new Promise<void>((done) => {
      verifier(keyB, (permitted) => {
        expect(permitted).toBe(false);
        done();
      });
    });
  });

  it("host verifier rejects unpinned host in strict mode", () => {
    const opts = {
      vpsId: "unknown-vps",
      host: "10.0.0.1",
      port: 22,
      pins: {} as Record<string, string | string[]>,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    return new Promise<void>((done) => {
      verifier(keyA, (permitted) => {
        expect(permitted).toBe(false);
        done();
      });
    });
  });

  it("host verifier allows unpinned host in permissive mode", () => {
    const opts = {
      vpsId: "unknown-vps",
      host: "10.0.0.1",
      port: 22,
      pins: {} as Record<string, string | string[]>,
      policy: "permissive" as const,
    };
    const verifier = createHostVerifier(opts);
    return new Promise<void>((done) => {
      verifier(keyA, (permitted) => {
        expect(permitted).toBe(true);
        done();
      });
    });
  });

  // ---- Array pin tests ----

  it("host verifier accepts array pin containing matching fingerprint", () => {
    const pins: Record<string, string | string[]> = { "vps-1": [fpA, fpB] };
    const opts = {
      vpsId: "vps-1",
      host: "203.0.113.20",
      port: 22,
      pins,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    // keyA should match first element
    return new Promise<void>((done) => {
      verifier(keyA, (permitted) => {
        expect(permitted).toBe(true);
        done();
      });
    });
  });

  it("host verifier accepts array pin with second element (key rotation)", () => {
    const pins: Record<string, string | string[]> = { "vps-1": [fpA, fpC] };
    const opts = {
      vpsId: "vps-1",
      host: "203.0.113.20",
      port: 22,
      pins,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    // keyC should match second element
    return new Promise<void>((done) => {
      verifier(keyC, (permitted) => {
        expect(permitted).toBe(true);
        done();
      });
    });
  });

  it("host verifier rejects when array pin has no match", () => {
    const pins: Record<string, string | string[]> = { "vps-1": [fpA, fpB] };
    const opts = {
      vpsId: "vps-1",
      host: "203.0.113.20",
      port: 22,
      pins,
      policy: "strict" as const,
    };
    const verifier = createHostVerifier(opts);
    // keyC does not match any element
    return new Promise<void>((done) => {
      verifier(keyC, (permitted) => {
        expect(permitted).toBe(false);
        done();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SSH_HOST_KEY_PINS parser tests
// ---------------------------------------------------------------------------

describe("SSH_HOST_KEY_PINS parser", () => {
  it("accepts valid JSON object with string values", () => {
    const parsed = parseAppConfig({
      SSH_HOST_KEY_PINS: JSON.stringify({ "vps-1": "SHA256:abc123" }),
      SSH_HOST_KEY_POLICY: "permissive",
    } as NodeJS.ProcessEnv);
    expect(parsed.sshHostKeyPins).toEqual({ "vps-1": "SHA256:abc123" });
    expect(parsed.sshHostKeyPolicy).toBe("permissive");
  });

  it("accepts array values for key rotation", () => {
    const pins = { "vps-1": ["SHA256:abc123", "SHA256:xyz789"] };
    const parsed = parseAppConfig({
      SSH_HOST_KEY_PINS: JSON.stringify(pins),
    } as NodeJS.ProcessEnv);
    expect(parsed.sshHostKeyPins).toEqual(pins);
  });

  it("rejects invalid JSON", () => {
    expect(() =>
      parseAppConfig({ SSH_HOST_KEY_PINS: "not-json" } as NodeJS.ProcessEnv),
    ).toThrow(/SSH_HOST_KEY_PINS/);
  });

  it("rejects JSON array at top level", () => {
    expect(() =>
      parseAppConfig({
        SSH_HOST_KEY_PINS: '["vps-1","SHA256:abc"]',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be a JSON object/);
  });

  it("rejects non-string, non-array values", () => {
    expect(() =>
      parseAppConfig({
        SSH_HOST_KEY_PINS: JSON.stringify({ "vps-1": 123 }),
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be a string/);
  });

  it("rejects array with non-string elements", () => {
    expect(() =>
      parseAppConfig({
        SSH_HOST_KEY_PINS: JSON.stringify({ "vps-1": ["abc", 123] }),
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be a string/);
  });

  it("defaults to empty object", () => {
    const parsed = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(parsed.sshHostKeyPins).toEqual({});
  });

  it("defaults policy to strict", () => {
    const parsed = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(parsed.sshHostKeyPolicy).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// TOCTOU test — high-level SshService passes vetted IP to ssh2
// ---------------------------------------------------------------------------

describe("TOCTOU protection — high-level SshService", () => {
  beforeEach(async () => {
    const ssh2 = (await import("ssh2")) as any;
    ssh2.__testing.reset();
    const lookup = await mockDns();
    lookup.mockReset();
  });

  /** Build a minimal mock AuditService (only `record` used by SshService). */
  function mockAuditService() {
    const events: unknown[] = [];
    return {
      record: vi.fn((e: unknown) => {
        events.push(e);
      }),
      _events: events,
    };
  }

  /** Build a minimal HostKeyPinService stub (no persisted pins). */
  function fakeHostKeyPinService() {
    return {
      getTrustedFingerprints: vi.fn(async () => []),
      resolveKeyType: vi.fn(async () => undefined),
    } as never;
  }

  it("SshService.verifyPrivateKey passes vetted IP and hostVerifier to ssh2 Client.connect", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "203.0.113.42", family: 4 }]);

    // Dynamic import so the ssh2 mock is in effect
    const { SshService } = await import("../src/ssh/ssh.service.js");
    const audit = mockAuditService();
    const service = new SshService(
      localConfig,
      audit as never,
      fakeHostKeyPinService(),
    );

    const vps: VpsRecord = {
      id: "vps-toctou-svc",
      name: "TOCTOU high-level",
      host: "myserver.example.com",
      port: 22,
      username: "root",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await service.verifyPrivateKey(vps, "dummy-private-key");

    const ssh2 = (await import("ssh2")) as any;
    const calls = ssh2.__testing.getConnectArgs();
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Must use the DNS-resolved IP, NOT the original hostname
    expect(calls[0].host).toBe("203.0.113.42");
    expect(calls[0].host).not.toBe("myserver.example.com");

    // Must pass a hostVerifier callback
    expect(typeof calls[0].hostVerifier).toBe("function");

    // Audit should not have been called (no block)
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("SshService.verifyPrivateKey rejects blocked host before ssh2 connect and writes audit", async () => {
    const lookup = await mockDns();
    lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    // Use local mode WITHOUT allowPrivateNetworkTargets so private IPs are blocked
    // (demo mode would throw DemoSshDisabledError first)
    const blockedConfig: AppConfig = {
      ...localConfig,
      allowPrivateNetworkTargets: false,
    };

    const { SshService } = await import("../src/ssh/ssh.service.js");
    const audit = mockAuditService();
    const service = new SshService(
      blockedConfig,
      audit as never,
      fakeHostKeyPinService(),
    );

    const vps: VpsRecord = {
      id: "vps-blocked-svc",
      name: "Blocked high-level",
      host: "private.example.com",
      port: 22,
      username: "root",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(service.verifyPrivateKey(vps, "dummy-key")).rejects.toThrow(
      SshHostBlockedError,
    );

    // ssh2 must never have been reached
    const ssh2 = (await import("ssh2")) as any;
    expect(ssh2.__testing.getConnectArgs().length).toBe(0);

    // Audit must have been recorded
    expect(audit.record).toHaveBeenCalledTimes(1);
    const event = audit.record.mock.calls[0][0] as Record<string, unknown>;
    expect(event.action).toBe("ssh.host.blocked");
    expect(event.resourceId).toBe("vps-blocked-svc");
  });
});

// ---------------------------------------------------------------------------
// Route security tests
// ---------------------------------------------------------------------------

describe("phase one route security", () => {
  it("blocks demo mutations and adds security headers/request IDs", async () => {
    const { server, tempDir } = await testHarness();
    try {
      const response = await request(server)
        .post("/api/vps")
        .send({
          name: "prod",
          host: "203.0.113.20",
          port: 22,
          username: "root",
        })
        .expect(403);
      expect(response.headers["x-request-id"]).toBeDefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.body.error.message).toBe(
        "Mutations are disabled in demo mode",
      );
    } finally {
      await closeTestApps();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires session auth for local-mode mutations", async () => {
    const config = { ...demoConfig, mode: "local" as const };
    const { server, tempDir } = await testHarness(config);
    const { createSessionCookie } = await import("./test-helpers.js");

    try {
      await request(server).get("/api/health").expect(200, { ok: true });
      await request(server)
        .post("/api/vps")
        .send({
          name: "prod",
          host: "203.0.113.20",
          port: 22,
          username: "root",
        })
        .expect(401);

      const cookie = await createSessionCookie(
        tempDir,
        config.dashboardSessionSecret,
      );
      await request(server)
        .post("/api/vps")
        .set("Cookie", cookie)
        .set("Origin", "http://127.0.0.1")
        .set("Host", "127.0.0.1")
        .send({
          name: "prod",
          host: "203.0.113.20",
          port: 22,
          username: "root",
        })
        .expect(201);
    } finally {
      await closeTestApps();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks demo mutations and real SSH, writes redacted audit events", async () => {
    const { server, tempDir } = await testHarness();
    try {
      const create = await request(server)
        .post("/api/vps")
        .send({
          name: "prod",
          host: "203.0.113.20",
          port: 22,
          username: "root",
        })
        .expect(403);
      expect(create.body.error.message).toBe(
        "Mutations are disabled in demo mode",
      );

      const blocked = await request(server)
        .post("/api/vps/nonexistent/provision-key")
        .send({ password: "super-secret" })
        .expect(403);
      expect(JSON.stringify(blocked.body)).not.toContain("super-secret");
    } finally {
      await closeTestApps();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
