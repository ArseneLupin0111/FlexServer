import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config/app-config.js";
import {
  SshHostKeyScanFailedError,
  SshHostKeyTrustRequiredError,
} from "../src/common/errors.js";
import { computeFingerprint } from "../src/ssh/ssh-host-policy.js";
import { selectPreferredHostKey } from "../src/ssh/ssh-host-policy.js";
import { HostKeyPinService } from "../src/ssh/host-key-pin.service.js";
import { createJsonHostKeyPinRepository } from "../src/ssh/host-key-pin.repository.js";
import type { HostKeyPinRepository } from "../src/ssh/host-key-pin.repository.js";
import type { KeyScanResult } from "../src/ssh/host-key-pin.models.js";
import { createVpsStore } from "../src/persistence/store/vpsStore.js";
import { createKeyService } from "../src/ssh/keyService.js";
import { createTestKeyring } from "../src/ssh/key-encryption.js";
import { createJsonAuditRepository } from "../src/persistence/repositories/audit.repository.js";
import { createJsonAgentRepository } from "../src/persistence/repositories/agent.repository.js";
import type { VpsRepository } from "../src/persistence/repositories/vps.repository.js";
import type { VpsRecord } from "../src/vps/vps.models.js";

// ---------------------------------------------------------------------------
// Mock node:dns/promises and node:child_process so no test touches real DNS
// or spawns a real ssh-keyscan binary.
// ---------------------------------------------------------------------------
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("node:child_process")
  >();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock ssh2 Client — records connect args, auto-emits "ready"
// (mirrors phase-one.test.ts; lets us capture the hostVerifier callback).
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
// Fixtures
// ---------------------------------------------------------------------------

const strictLocalConfig: AppConfig = {
  mode: "local",
  enableWebTerminal: false,
  allowPrivateNetworkTargets: true,
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
  dashboardSessionSecret: "ssh-host-key-test-session-secret-32+chars",
  trustProxyHops: 0,
  jobHistoryLimit: 1000,
  auditHistoryLimit: 5000,
  metricWindowLimit: 120,
  // Deliberately empty — trusted pins must come from the persisted repo.
  sshHostKeyPins: {},
  sshHostKeyPolicy: "strict",
};

const HOST = "203.0.113.20"; // TEST-NET-3, safe public literal (no DNS needed)
const PORT = 22;

const keyA = Buffer.from("ssh-ed25519-host-key-A-v1", "utf-8");
const fpA = computeFingerprint(keyA);
const keyB = Buffer.from("ssh-ed25519-host-key-B-v2", "utf-8");
const fpB = computeFingerprint(keyB);

let tempDir: string;
let pinsFile: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vps-manager-hostkey-"));
  await mkdir(join(tempDir, "data"), { recursive: true });
  pinsFile = join(tempDir, "data", "host-key-pins.json");
  const ssh2 = (await import("ssh2")) as any;
  ssh2.__testing.reset();
  const dns = (await import("node:dns/promises")) as any;
  dns.lookup.mockReset();
  const childProcess = (await import("node:child_process")) as any;
  childProcess.spawn.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake child_process.spawn child that mimics an ssh-keyscan run. */
function fakeSshKeyScanChild(options: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  const { stdoutData = "", stderrData = "", exitCode = 0 } = options;
  setImmediate(() => {
    if (stdoutData) child.stdout.emit("data", Buffer.from(stdoutData, "utf8"));
    if (stderrData) child.stderr.emit("data", Buffer.from(stderrData, "utf8"));
    child.emit("close", exitCode);
  });
  return child;
}

/** Access the mocked child_process.spawn mock for assertions/setup. */
async function mockSpawn() {
  const childProcess = await import("node:child_process");
  return childProcess.spawn as unknown as import("vitest").Mock;
}

function makeHostKeyPinService(config: AppConfig): {
  service: HostKeyPinService;
  repo: HostKeyPinRepository;
} {
  const repo = createJsonHostKeyPinRepository(pinsFile);
  const unusedVpsRepo = {} as unknown as VpsRepository;
  return { service: new HostKeyPinService(config, repo, unusedVpsRepo), repo };
}

function mockAudit() {
  return { record: vi.fn(async () => undefined) };
}

async function createStoredVps() {
  const store = createVpsStore(join(tempDir, "data", "vps.json"));
  const vps = await store.create({
    name: "prod",
    host: HOST,
    port: PORT,
    username: "root",
  });
  return { store, vps };
}

function testVps(): VpsRecord {
  return {
    id: "vps-hostkey-test",
    name: "pinned",
    host: HOST,
    port: PORT,
    username: "root",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Strict, unpinned, scan succeeds -> SSH_HOST_KEY_TRUST_REQUIRED contract
// ---------------------------------------------------------------------------

describe("SSH host key provisioning — strict trust contract", () => {
  it("returns SSH_HOST_KEY_TRUST_REQUIRED with the observed key when scan succeeds and no pin exists (no SSH attempted)", async () => {
    const { store, vps } = await createStoredVps();
    const { service: hostKeyPin } = makeHostKeyPinService(strictLocalConfig);

    const scanResult: KeyScanResult = {
      vpsId: vps.id,
      host: vps.host,
      port: vps.port,
      keys: [{ type: "ssh-ed25519", key: "AAAA-test-key", fingerprint: fpA }],
    };
    vi.spyOn(hostKeyPin, "scanHostKey").mockResolvedValue(scanResult);

    const ssh = { provisionPublicKey: vi.fn(async () => undefined) };
    const { VpsService } = await import("../src/vps/vps.service.js");
    const vpsService = new VpsService(
      store,
      createKeyService(join(tempDir, "private", "keys")),
      ssh as never,
      mockAudit() as never,
      strictLocalConfig,
      {} as never,
      {} as never,
      createJsonAgentRepository(join(tempDir, "data", "agents.json")),
      hostKeyPin,
    );

    await expect(vpsService.provisionKey(vps.id, { password: "pw" })).rejects.toMatchObject({
      info: {
        error: "SSH_HOST_KEY_TRUST_REQUIRED",
        vpsId: vps.id,
        host: vps.host,
        port: vps.port,
        fingerprint: fpA,
        keyType: "ssh-ed25519",
      },
    });

    // Trust must be established first — never fall through to a real SSH attempt.
    expect(ssh.provisionPublicKey).not.toHaveBeenCalled();
  });

  it("provisioning succeeds after a pin is persisted (retry without re-trust), and no scan is required", async () => {
    const { store, vps } = await createStoredVps();
    const { service: hostKeyPin, repo } = makeHostKeyPinService(strictLocalConfig);
    await repo.upsert({
      vpsId: vps.id,
      host: vps.host,
      port: vps.port,
      fingerprint: fpA,
    });

    const ssh = { provisionPublicKey: vi.fn(async () => undefined) };
    const scanSpy = vi.spyOn(hostKeyPin, "scanHostKey");
    const { VpsService } = await import("../src/vps/vps.service.js");
    const vpsService = new VpsService(
      store,
      createKeyService({
        baseDir: join(tempDir, "private", "keys"),
        keyring: createTestKeyring("test-host-key-kek"),
      }),
      ssh as never,
      mockAudit() as never,
      strictLocalConfig,
      {} as never,
      {} as never,
      createJsonAgentRepository(join(tempDir, "data", "agents.json")),
      hostKeyPin,
    );

    const updated = await vpsService.provisionKey(vps.id, { password: "pw" });

    expect(ssh.provisionPublicKey).toHaveBeenCalledTimes(1);
    expect(scanSpy).not.toHaveBeenCalled();
    expect(updated).toBeDefined();
    expect(updated?.keyProvisionedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Endpoint changes invalidate VPS-scoped host-key trust.
// ---------------------------------------------------------------------------

describe("VPS endpoint changes and host-key trust", () => {
  async function createUpdateContext() {
    const { store, vps } = await createStoredVps();
    const { service: hostKeyPin, repo } = makeHostKeyPinService(strictLocalConfig);
    await repo.upsert({
      vpsId: vps.id,
      host: vps.host,
      port: vps.port,
      fingerprint: fpA,
    });
    const audit = mockAudit();
    const { VpsService } = await import("../src/vps/vps.service.js");
    const service = new VpsService(
      store,
      createKeyService(join(tempDir, "private", "keys")),
      {} as never,
      audit as never,
      strictLocalConfig,
      {} as never,
      {} as never,
      createJsonAgentRepository(join(tempDir, "data", "agents.json")),
      hostKeyPin,
    );
    return { service, repo, vps, audit };
  }

  it("revokes an existing VPS-scoped pin when the host changes", async () => {
    const { service, repo, vps, audit } = await createUpdateContext();

    await service.update(vps.id, { host: "203.0.113.21" });

    expect(await repo.findByVpsId(vps.id)).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "vps.update",
      metadata: {
        oldEndpoint: { host: HOST, port: PORT },
        newEndpoint: { host: "203.0.113.21", port: PORT },
      },
    }));
  });

  it("revokes an existing VPS-scoped pin when the port changes", async () => {
    const { service, repo, vps, audit } = await createUpdateContext();

    await service.update(vps.id, { port: 2222 });

    expect(await repo.findByVpsId(vps.id)).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        oldEndpoint: { host: HOST, port: PORT },
        newEndpoint: { host: HOST, port: 2222 },
      },
    }));
  });

  it("preserves an existing VPS-scoped pin when the endpoint is unchanged", async () => {
    const { service, repo, vps } = await createUpdateContext();

    await service.update(vps.id, { name: "renamed" });

    expect(await repo.findByVpsId(vps.id)).toMatchObject({
      vpsId: vps.id,
      host: HOST,
      port: PORT,
      fingerprint: fpA,
    });
  });
});

// ---------------------------------------------------------------------------
// Persisted pin is used by the ACTUAL host verifier (env pins are empty)
// ---------------------------------------------------------------------------

describe("SSH host key provisioning — actual verifier uses persisted pins", () => {
  it("host verifier accepts the persisted fingerprint and rejects others (strict, env pins empty)", async () => {
    const { service: hostKeyPin, repo } = makeHostKeyPinService(strictLocalConfig);
    const vps = testVps();
    await repo.upsert({
      vpsId: vps.id,
      host: vps.host,
      port: vps.port,
      fingerprint: fpA,
    });
    expect(strictLocalConfig.sshHostKeyPins).toEqual({});

    const { SshService } = await import("../src/ssh/ssh.service.js");
    const ssh = new SshService(strictLocalConfig, mockAudit() as never, hostKeyPin);
    await ssh.verifyPrivateKey(vps, "dummy-private-key");

    const ssh2 = (await import("ssh2")) as any;
    const calls = ssh2.__testing.getConnectArgs();
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const hostVerifier = calls[0].hostVerifier as (
      key: Buffer,
      verify: (permitted: boolean) => void,
    ) => void;
    expect(typeof hostVerifier).toBe("function");

    // The key matching the persisted pin (persisted via repo, not env) is trusted.
    await new Promise<void>((done) => {
      hostVerifier(keyA, (permitted) => {
        expect(permitted).toBe(true);
        done();
      });
    });

    // A different key is still rejected — persisted trust never becomes permissive.
    await new Promise<void>((done) => {
      hostVerifier(keyB, (permitted) => {
        expect(permitted).toBe(false);
        done();
      });
    });

    // Sanity: fpB is genuinely a different fingerprint.
    expect(fpB).not.toBe(fpA);
  });
});

// ---------------------------------------------------------------------------
// Scan failure must be explicit — never swallowed into a generic SSH attempt
// ---------------------------------------------------------------------------

describe("SSH host key provisioning — scan failure is explicit", () => {
  it("surfaces a safe SshHostKeyScanFailedError instead of falling through to SSH", async () => {
    const { store, vps } = await createStoredVps();
    const { service: hostKeyPin } = makeHostKeyPinService(strictLocalConfig);

    vi.spyOn(hostKeyPin, "scanHostKey").mockRejectedValue(
      new Error("ssh-keyscan failed (exit 255): super-secret-host-key-material"),
    );

    const ssh = { provisionPublicKey: vi.fn(async () => undefined) };
    const { VpsService } = await import("../src/vps/vps.service.js");
    const vpsService = new VpsService(
      store,
      createKeyService(join(tempDir, "private", "keys")),
      ssh as never,
      mockAudit() as never,
      strictLocalConfig,
      {} as never,
      {} as never,
      createJsonAgentRepository(join(tempDir, "data", "agents.json")),
      hostKeyPin,
    );

    let caught: unknown;
    try {
      await vpsService.provisionKey(vps.id, { password: "pw" });
    } catch (error: unknown) {
      caught = error;
    }

    // Explicit typed error — not a generic host-verification failure.
    expect(caught).toBeInstanceOf(SshHostKeyScanFailedError);
    expect(caught).not.toBeInstanceOf(SshHostKeyTrustRequiredError);

    // The raw scan failure / secrets must never leak into the error contract.
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain("super-secret-host-key-material");
    expect(message).not.toContain("exit 255");

    // No SSH connection is attempted after a scan failure.
    expect(ssh.provisionPublicKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DNS TOCTOU — ssh-keyscan must run against the vetted literal address
// ---------------------------------------------------------------------------

describe("SSH host key scan — DNS TOCTOU (vetted scan target)", () => {
  it("spawns ssh-keyscan against the vetted resolved IP, not the raw hostname", async () => {
    const dns = await import("node:dns/promises");
    (dns.lookup as import("vitest").Mock).mockResolvedValue([
      { address: "203.0.113.99", family: 4 },
    ]);

    const spawnMock = await mockSpawn();
    const keyB64 = Buffer.from("ssh-ed25519-host-key-material").toString(
      "base64",
    );
    spawnMock.mockReturnValueOnce(
      fakeSshKeyScanChild({
        stdoutData: `203.0.113.99 ssh-ed25519 ${keyB64}\n`,
      }),
    );

    const { service } = makeHostKeyPinService(strictLocalConfig);
    const result = await service.scanHostKey(
      "vps-dns-toctou",
      "vps.example.com",
      PORT,
    );

    // The scan target must be the vetted literal IP returned by policy/DNS,
    // never the original hostname (prevents a DNS-rebinding TOCTOU window).
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("203.0.113.99");
    expect(args).not.toContain("vps.example.com");

    // Identity/pin lookup retains the original hostname.
    expect(result.host).toBe("vps.example.com");
    expect(result.keys).toHaveLength(1);
    const rawKey = Buffer.from(keyB64, "base64");
    expect(result.keys[0].fingerprint).toBe(computeFingerprint(rawKey));
  });

  it("throws the safe SshHostKeyScanFailedError when scan output parses to zero reliable keys", async () => {
    const spawnMock = await mockSpawn();
    // Output that yields exactly zero parseable key entries (every line has
    // fewer than the `<host> <type> <base64>` shape ssh-keyscan emits).
    spawnMock.mockReturnValueOnce(
      fakeSshKeyScanChild({
        stdoutData: "comment-with-too-few-fields\nstill-not-a-host-key\n",
      }),
    );

    const { service } = makeHostKeyPinService(strictLocalConfig);
    await expect(
      service.scanHostKey("vps-empty-parse", HOST, PORT),
    ).rejects.toBeInstanceOf(SshHostKeyScanFailedError);
  });
});

// ---------------------------------------------------------------------------
// Key-type determinism: scan/trust selection → persisted type → ssh2 negotiation
// ---------------------------------------------------------------------------

describe("SSH host key type determinism — scan/trust to ssh2 negotiation", () => {
  const edKey = {
    type: "ssh-ed25519",
    key: "ed25519-b64",
    fingerprint: computeFingerprint(Buffer.from("ed25519-host-key")),
  };
  const rsaKey = {
    type: "ssh-rsa",
    key: "rsa-b64",
    fingerprint: computeFingerprint(Buffer.from("rsa-host-key")),
  };
  const ecdsaKey = {
    type: "ecdsa-sha2-nistp256",
    key: "ecdsa-b64",
    fingerprint: computeFingerprint(Buffer.from("ecdsa-host-key")),
  };

  it("selects the preferred host key deterministically regardless of scan output order", () => {
    expect(selectPreferredHostKey([rsaKey, ecdsaKey, edKey])).toBe(edKey);
    expect(selectPreferredHostKey([rsaKey, ecdsaKey])).toBe(ecdsaKey);
    expect(selectPreferredHostKey([rsaKey])).toBe(rsaKey);
    expect(selectPreferredHostKey([])).toBeUndefined();
  });

  it("reports the preferred ed25519 key in the trust-required contract even when rsa appears first in the scan", async () => {
    const { store, vps } = await createStoredVps();
    const { service: hostKeyPin } = makeHostKeyPinService(strictLocalConfig);

    // Scan arrives with rsa first and ed25519 second — selection must still
    // deterministically prefer ed25519.
    const scanResult: KeyScanResult = {
      vpsId: vps.id,
      host: vps.host,
      port: vps.port,
      keys: [rsaKey, edKey],
    };
    vi.spyOn(hostKeyPin, "scanHostKey").mockResolvedValue(scanResult);

    const ssh = { provisionPublicKey: vi.fn(async () => undefined) };
    const { VpsService } = await import("../src/vps/vps.service.js");
    const vpsService = new VpsService(
      store,
      createKeyService(join(tempDir, "private", "keys")),
      ssh as never,
      mockAudit() as never,
      strictLocalConfig,
      {} as never,
      {} as never,
      createJsonAgentRepository(join(tempDir, "data", "agents.json")),
      hostKeyPin,
    );

    await expect(
      vpsService.provisionKey(vps.id, { password: "pw" }),
    ).rejects.toMatchObject({
      info: {
        error: "SSH_HOST_KEY_TRUST_REQUIRED",
        fingerprint: edKey.fingerprint,
        keyType: "ssh-ed25519",
      },
    });

    // Trust must be established first — never fall through to a real SSH attempt.
    expect(ssh.provisionPublicKey).not.toHaveBeenCalled();
  });

  it("persists the scanned key type via trustKey", async () => {
    const { service: hostKeyPin, repo } = makeHostKeyPinService(
      strictLocalConfig,
    );
    const scanResult: KeyScanResult = {
      vpsId: "vps-trust-type",
      host: HOST,
      port: PORT,
      keys: [{ type: "ssh-ed25519", key: "ed25519-b64", fingerprint: fpA }],
    };
    vi.spyOn(hostKeyPin, "scanHostKey").mockResolvedValue(scanResult);

    const pin = await hostKeyPin.trustKey("vps-trust-type", HOST, PORT, fpA);
    expect(pin.keyType).toBe("ssh-ed25519");

    const stored = await repo.findByVpsId("vps-trust-type");
    expect(stored?.keyType).toBe("ssh-ed25519");
  });

  it("constrains ssh2 algorithms.serverHostKey to the trusted key type — selected key accepted, unscanned key rejected", async () => {
    const { service: hostKeyPin, repo } = makeHostKeyPinService(
      strictLocalConfig,
    );
    const vps = testVps();
    await repo.upsert({
      vpsId: vps.id,
      host: vps.host,
      port: vps.port,
      fingerprint: fpA,
      keyType: "ssh-ed25519",
    });

    const { SshService } = await import("../src/ssh/ssh.service.js");
    const ssh = new SshService(
      strictLocalConfig,
      mockAudit() as never,
      hostKeyPin,
    );
    await ssh.verifyPrivateKey(vps, "dummy-private-key");

    const ssh2 = (await import("ssh2")) as any;
    const calls = ssh2.__testing.getConnectArgs();
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // ssh2 can only negotiate the algorithm matching the trusted key type —
    // an unscanned/alternate type like ssh-rsa can never be negotiated.
    expect(calls[0].algorithms).toEqual({ serverHostKey: ["ssh-ed25519"] });

    const hostVerifier = calls[0].hostVerifier as (
      key: Buffer,
      verify: (permitted: boolean) => void,
    ) => void;

    // The scanned+trusted ed25519 key is accepted...
    await new Promise<void>((done) => {
      hostVerifier(keyA, (permitted) => {
        expect(permitted).toBe(true);
        done();
      });
    });

    // ...and an unscanned/untrusted key is rejected.
    await new Promise<void>((done) => {
      hostVerifier(keyB, (permitted) => {
        expect(permitted).toBe(false);
        done();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP response mapping for scan failures and policy errors
// ---------------------------------------------------------------------------

describe("SSH host key scan failure — HTTP response mapping", () => {
  it(
    "maps a host key scan failure to HTTP 502 with a safe message",
    async () => {
      const spawnMock = await mockSpawn();
      spawnMock.mockReturnValueOnce(
        fakeSshKeyScanChild({
          stderrData: "connection refused\n",
          exitCode: 255,
        }),
      );

      // VPS host is a literal public IP, so no DNS is touched.
      const httpTempDir = await mkdtemp(
        join(tmpdir(), "vps-manager-hostkey-http-"),
      );
      await mkdir(join(httpTempDir, "data"), { recursive: true });
      await mkdir(join(httpTempDir, "private"), { recursive: true });
      const store = createVpsStore(join(httpTempDir, "data", "vps.json"));
      const vps = await store.create({
        name: "prod",
        host: HOST,
        port: PORT,
        username: "root",
      });

      const server = createApp({
        config: {
          ...strictLocalConfig,
          dataDir: join(httpTempDir, "data"),
          privateDir: join(httpTempDir, "private"),
        },
        store,
        keys: createKeyService(join(httpTempDir, "private", "keys")),
        audit: createJsonAuditRepository(
          join(httpTempDir, "data", "audit.json"),
        ),
      });

      const { createSessionCookie } = await import("./test-helpers.js");
      const cookie = await createSessionCookie(
        httpTempDir,
        strictLocalConfig.dashboardSessionSecret,
      );

      try {
        const response = await request(server)
          .post(`/api/vps/${vps.id}/ssh/host-key/scan`)
          .set("Cookie", cookie)
          .set("Origin", "http://127.0.0.1")
          .set("Host", "127.0.0.1")
          .expect(502);

        expect(response.body.error.message).toContain(
          "SSH host key scan failed",
        );
        // Raw spawn output / secrets never leak into the HTTP contract.
        expect(JSON.stringify(response.body)).not.toContain(
          "connection refused",
        );
        expect(JSON.stringify(response.body)).not.toContain("255");
      } finally {
        await rm(httpTempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "preserves SshHostBlockedError as HTTP 403 instead of wrapping as 502",
    async () => {
      // Private target with allowPrivateNetworkTargets=false → policy blocks.
      const httpTempDir = await mkdtemp(
        join(tmpdir(), "vps-manager-hostkey-http-"),
      );
      await mkdir(join(httpTempDir, "data"), { recursive: true });
      await mkdir(join(httpTempDir, "private"), { recursive: true });
      const store = createVpsStore(join(httpTempDir, "data", "vps.json"));
      const vps = await store.create({
        name: "blocked",
        host: "10.0.0.5",
        port: PORT,
        username: "root",
      });

      const blockedConfig: AppConfig = {
        ...strictLocalConfig,
        allowPrivateNetworkTargets: false,
      };
      const server = createApp({
        config: {
          ...blockedConfig,
          dataDir: join(httpTempDir, "data"),
          privateDir: join(httpTempDir, "private"),
        },
        store,
        keys: createKeyService(join(httpTempDir, "private", "keys")),
        audit: createJsonAuditRepository(
          join(httpTempDir, "data", "audit.json"),
        ),
      });

      const { createSessionCookie } = await import("./test-helpers.js");
      const cookie = await createSessionCookie(
        httpTempDir,
        blockedConfig.dashboardSessionSecret,
      );

      const spawnMock = await mockSpawn();
      try {
        const response = await request(server)
          .post(`/api/vps/${vps.id}/ssh/host-key/scan`)
          .set("Cookie", cookie)
          .set("Origin", "http://127.0.0.1")
          .set("Host", "127.0.0.1")
          .expect(403);

        expect(response.body.error.message).toContain(
          "Private-network SSH targets",
        );
        // ssh-keyscan must never have been spawned for a blocked target.
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        await rm(httpTempDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});