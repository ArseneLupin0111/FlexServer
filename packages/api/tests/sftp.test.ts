import { createHash, randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { openManagedSftp } from "../src/ssh/sshService.js";
import { SshService } from "../src/ssh/ssh.service.js";
import { RemoteFilesTransport } from "../src/files/remote-files.transport.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import type { KeyService } from "../src/ssh/keyService.js";
import { computeFingerprint } from "../src/ssh/ssh-host-policy.js";
import type { AuditService } from "../src/audit/audit.service.js";
import type { HostKeyPinService } from "../src/ssh/host-key-pin.service.js";

const config = { mode: "local", allowPrivateNetworkTargets: true, sshHostKeyPolicy: "strict", sshHostKeyPins: {} } as AppConfig;
const vps: VpsRecord = { id: "vps-sftp-test", name: "test", host: "203.0.113.20", port: 22, username: "root", createdAt: "", updatedAt: "" };
const security = { vettedHost: "203.0.113.21", hasTrustedHostKeyPin: true, hostVerifier: vi.fn(), serverHostKeyAlgorithms: ["ssh-ed25519"] };

describe("SFTP primitives and remote transport", () => {
  it("openManagedSftp fails closed without a pin", async () => {
    await expect(openManagedSftp(vps, { privateKey: "key" }, { ...security, hasTrustedHostKeyPin: false }))
      .rejects.toThrow(/trusted host key verification/);
  });

  it("openManagedSftp rejects blank private key", async () => {
    await expect(openManagedSftp(vps, { privateKey: "  " }, security))
      .rejects.toThrow(/private key/);
  });

  it("RemoteFilesTransport fails closed when key is missing", async () => {
    const keys: KeyService = {
      readPrivateKey: vi.fn().mockRejectedValue(new Error("key not found")),
      ensureKeyPair: vi.fn(),
      removeKeyPair: vi.fn(),
    };
    const ssh = new SshService(config, { record: vi.fn() } as unknown as AuditService, { getTrustedFingerprints: vi.fn().mockResolvedValue(["pin"]) } as unknown as HostKeyPinService);
    const transport = new RemoteFilesTransport(ssh, keys);
    await expect(transport.open(vps, new AbortController().signal)).rejects.toMatchObject({ code: "SFTP_UNAVAILABLE" });
  });

  it("high-level openManagedSftp enforces host key pin resolution", async () => {
    const pinService = {
      getTrustedFingerprints: vi.fn().mockResolvedValue([]),
      resolveKeyType: vi.fn().mockResolvedValue(undefined),
    };
    const ssh = new SshService({ ...config, sshHostKeyPolicy: "permissive" }, { record: vi.fn() } as unknown as AuditService, pinService as unknown as HostKeyPinService);
    await expect(ssh.openManagedSftp(vps, { privateKey: "valid-key" })).rejects.toThrow();
    expect(pinService.getTrustedFingerprints).toHaveBeenCalledTimes(1);
  });
});
