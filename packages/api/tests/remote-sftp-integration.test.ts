import { execSync } from "node:child_process";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { RemoteFilesTransport } from "../src/files/remote-files.transport.js";
import { SshService } from "../src/ssh/ssh.service.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { VpsRecord } from "../src/vps/vps.models.js";
import type { KeyService } from "../src/ssh/keyService.js";
import type { AuditService } from "../src/audit/audit.service.js";
import type { HostKeyPinService } from "../src/ssh/host-key-pin.service.js";
import { computeFingerprint } from "../src/ssh/ssh-host-policy.js";

const CONTAINER_NAME = "flexserver-sftp-integration-test";
const PORT = 52222;

let clientPrivateKey = "";
let serverHostKeyPub = "";
let serverFingerprint = "";
let containerStarted = false;

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("Remote SFTP live integration fixture", () => {
  beforeAll(async () => {
    if (!isDockerAvailable()) return;
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
    } catch {}

    const initCmd = [
      "apk add --no-cache openssh-server openssh-sftp-server openssh-keygen >/dev/null 2>&1",
      "adduser -D -s /bin/sh testuser",
      "passwd -u -d testuser",
      "mkdir -p /etc/ssh /home/testuser/.ssh",
      "ssh-keygen -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key >/dev/null",
      "ssh-keygen -t ed25519 -N '' -f /tmp/id_ed25519 >/dev/null",
      "cp /tmp/id_ed25519.pub /home/testuser/.ssh/authorized_keys",
      "chown -R testuser:testuser /home/testuser",
      "chmod 700 /home/testuser/.ssh && chmod 600 /home/testuser/.ssh/authorized_keys",
      "cat /tmp/id_ed25519",
      "echo '---FLEX_DELIM---'",
      "cat /etc/ssh/ssh_host_ed25519_key.pub",
      "echo '---FLEX_DELIM---'",
      "/usr/sbin/sshd -D -e -p 22 -o StrictModes=no -o PubkeyAuthentication=yes -o Subsystem='sftp /usr/lib/ssh/sftp-server'",
    ].join(" && ");

    const setupOut = execSync(
      `docker run --name ${CONTAINER_NAME} -d -p 0.0.0.0:${PORT}:22 alpine sh -c "${initCmd}"`,
      { encoding: "utf8" }
    ).trim();

    // Exception: Live external Docker daemon process initialization requires real wall-clock wait while alpine installs packages and OpenSSH daemon boots.
    let logs = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      logs = execSync(`docker logs ${CONTAINER_NAME}`, { encoding: "utf8" });
      if (logs.includes("---FLEX_DELIM---")) break;
    }

    const parts = logs.split("---FLEX_DELIM---");
    if (parts.length >= 3) {
      clientPrivateKey = parts[0].trim();
      serverHostKeyPub = parts[1].trim();
      const rawPub = Buffer.from(serverHostKeyPub.split(" ")[1], "base64");
      serverFingerprint = computeFingerprint(rawPub);
      containerStarted = true;
    }
  }, 30000);

  afterAll(() => {
    if (containerStarted) {
      try {
        execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
      } catch {}
    }
  });

  it("completes full SFTP workflow with SHA-256 match", async (ctx) => {
    if (!containerStarted) ctx.skip();

    const config = {
      mode: "local",
      allowPrivateNetworkTargets: true,
      sshHostKeyPolicy: "strict",
      sshHostKeyPins: {},
    } as AppConfig;

    const hostIp = Object.values(os.networkInterfaces())
      .flatMap((net) => net ?? [])
      .find((a) => a.family === "IPv4" && !a.internal && (a.address.startsWith("192.168.") || a.address.startsWith("10.") || (a.address.startsWith("172.") && !a.address.startsWith("172.17."))))
      ?.address;
    if (!hostIp) return ctx.skip();

    const vps: VpsRecord = {
      id: "vps-test",
      name: "test-vps",
      host: hostIp,
      port: PORT,
      username: "testuser",
      createdAt: "",
      updatedAt: "",
      sftpEnabled: true,
    };

    const hostKeyPinMock: Partial<HostKeyPinService> = {
      getTrustedFingerprints: async () => [serverFingerprint],
      resolveKeyType: async () => "ssh-ed25519",
    };

    const auditMock: Partial<AuditService> = {
      record: async () => {},
    };

    const ssh = new SshService(
      config,
      auditMock as unknown as AuditService,
      hostKeyPinMock as unknown as HostKeyPinService
    );

    const keyServiceMock: Partial<KeyService> = {
      readPrivateKey: async () => clientPrivateKey,
    };

    const transport = new RemoteFilesTransport(ssh, keyServiceMock as unknown as KeyService);
    const session = await transport.open(vps, new AbortController().signal);

    try {
      // 1. list home directory
      const initial = await session.list("/home/testuser");
      expect(initial.path).toBe("/home/testuser");
      expect(Array.isArray(initial.entries)).toBe(true);

      // 2. upload test file
      const payload = randomBytes(64 * 1024);
      const hashOriginal = createHash("sha256").update(payload).digest("hex");
      const targetPath = "/home/testuser/test-file.bin";

      const uploadedBytes = await session.upload(targetPath, Readable.from([payload]));
      expect(uploadedBytes).toBe(payload.length);

      // 3. destination exists -> 409
      await expect(session.upload(targetPath, Readable.from([Buffer.from("overwrite")]))).rejects.toMatchObject({
        code: "DESTINATION_EXISTS",
      });

      // 4. download and check hash
      const chunks: Buffer[] = [];
      const out = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          cb();
        },
      });
      const downloadedBytes = await session.download(targetPath, out);
      expect(downloadedBytes).toBe(payload.length);
      const downloadedBuffer = Buffer.concat(chunks);
      const hashDownloaded = createHash("sha256").update(downloadedBuffer).digest("hex");
      expect(hashDownloaded).toBe(hashOriginal);

      // 5. rename
      const renamedPath = "/home/testuser/test-file-renamed.bin";
      await session.rename(targetPath, renamedPath);

      // 6. delete
      await session.delete(renamedPath);

      // 7. verify 404 after delete
      await expect(session.download(renamedPath, new Writable({ write(_c, _e, cb) { cb(); } }))).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
      });
    } finally {
      session.close();
    }
  }, 30000);

  it("fails closed when host key pin does not match", async (ctx) => {
    if (!containerStarted) ctx.skip();

    const config = {
      mode: "local",
      allowPrivateNetworkTargets: true,
      sshHostKeyPolicy: "strict",
      sshHostKeyPins: {},
    } as AppConfig;

    const hostIp = Object.values(os.networkInterfaces())
      .flatMap((net) => net ?? [])
      .find((a) => a.family === "IPv4" && !a.internal && (a.address.startsWith("192.168.") || a.address.startsWith("10.") || (a.address.startsWith("172.") && !a.address.startsWith("172.17."))))
      ?.address;
    if (!hostIp) return ctx.skip();

    const vps: VpsRecord = {
      id: "vps-test",
      name: "test-vps",
      host: hostIp,
      port: PORT,
      username: "testuser",
      createdAt: "",
      updatedAt: "",
      sftpEnabled: true,
    };

    const hostKeyPinMock: Partial<HostKeyPinService> = {
      getTrustedFingerprints: async () => ["SHA256:wrongFingerprintHere1234567890="],
      resolveKeyType: async () => "ssh-ed25519",
    };

    const ssh = new SshService(
      config,
      { record: async () => {} } as unknown as AuditService,
      hostKeyPinMock as unknown as HostKeyPinService
    );

    const transport = new RemoteFilesTransport(ssh, {
      readPrivateKey: async () => clientPrivateKey,
    } as unknown as KeyService);

    await expect(transport.open(vps, new AbortController().signal)).rejects.toMatchObject({
      code: "SFTP_UNAVAILABLE",
    });
  }, 15000);
});
