import {
  Client,
  type ClientChannel,
  type ServerHostKeyAlgorithm,
  type SFTPWrapper,
} from "ssh2";
import { SshOperationError } from "../common/errors.js";
import type { VpsRecord } from "../vps/vps.models.js";

const SSH_READY_TIMEOUT_MS = 15_000;
const SSH_DIR_PATH = ".ssh";
const AUTHORIZED_KEYS_PATH = `${SSH_DIR_PATH}/authorized_keys`;

/**
 * Additional security options for SSH connections.
 * When provided, the connection uses a DNS-vetted IP and installs a hostVerifier callback.
 */
export interface SshSecurityOptions {
  /** DNS-resolved IP to connect to (avoids DNS rebinding TOCTOU). */
  vettedHost?: string;
  /** ssh2 hostVerifier callback for host key pinning. */
  hostVerifier?: (key: Buffer, verify: (permitted: boolean) => void) => void;
  /**
   * ssh2 `algorithms.serverHostKey` list constrained to the algorithm(s)
   * matching the trusted host key type, so ssh2 can never negotiate a host
   * key type that was not pinned at trust time.
   */
  serverHostKeyAlgorithms?: string[];
  /** Terminal connections must have an explicitly resolved pin. */
  requireHostKeyPin?: boolean;
  /** Indicates that at least one trusted fingerprint was resolved. */
  hasTrustedHostKeyPin?: boolean;
}

/** Internal SSH terminal handle; use SshService.openManagedShell rather than this primitive directly. */
export interface ManagedSshShell {
  client: Client;
  channel: ClientChannel;
  close(): void;
}

export interface SshPtyDimensions {
  cols: number;
  rows: number;
  height?: number;
  width?: number;
}

export function validateSshPtyDimensions(dimensions: SshPtyDimensions): SshPtyDimensions {
  const { cols, rows, height = 0, width = 0 } = dimensions;
  if (![cols, rows, height, width].every(Number.isInteger)) {
    throw new SshOperationError("SSH terminal dimensions are invalid.");
  }
  if (cols < 1 || cols > 500 || rows < 1 || rows > 200 || height < 0 || height > 10_000 || width < 0 || width > 10_000) {
    throw new SshOperationError("SSH terminal dimensions are outside the permitted range.");
  }
  return { cols, rows, height, width };
}

function connect(
  config: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
  },
  security?: SshSecurityOptions,
) {
  if (security?.requireHostKeyPin && (!security.hasTrustedHostKeyPin || !security.vettedHost || !security.hostVerifier)) {
    return Promise.reject(new SshOperationError("SSH terminal requires vetted host and trusted host key verification."));
  }
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end();
      reject(
        new SshOperationError(
          "SSH connection timed out. Check network reachability, firewall rules, and SSH port.",
        ),
      );
    }, SSH_READY_TIMEOUT_MS + 2_000);
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(client);
    });
    client.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(toSshOperationError(error));
    });
    try {
      // Use vetted IP for actual connection (DNS rebinding protection)
      const targetHost = security?.vettedHost ?? config.host;
      client.connect({
        host: targetHost,
        port: config.port,
        username: config.username,
        ...(config.password !== undefined ? { password: config.password } : {}),
        ...(config.privateKey !== undefined ? { privateKey: config.privateKey } : {}),
        readyTimeout: SSH_READY_TIMEOUT_MS,
        hostVerifier: security?.hostVerifier,
        algorithms: security?.serverHostKeyAlgorithms
          ? {
              serverHostKey:
                security.serverHostKeyAlgorithms as ServerHostKeyAlgorithm[],
            }
          : undefined,
      });
    } catch (error: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(toSshOperationError(error));
    }
  });
}

export async function openManagedSshShell(
  vps: VpsRecord,
  auth: { privateKey: string },
  dimensions: SshPtyDimensions,
  security: SshSecurityOptions,
): Promise<ManagedSshShell> {
  const pty = validateSshPtyDimensions(dimensions);
  if (!auth.privateKey.trim()) {
    throw new SshOperationError("SSH terminal requires a private key.");
  }
  const client = await connect(
    { host: vps.host, port: vps.port, username: vps.username, ...auth },
    { ...security, requireHostKeyPin: true },
  );
  try {
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: "xterm-256color", cols: pty.cols, rows: pty.rows, height: pty.height, width: pty.width },
        (error, stream) => (error ? reject(toSshOperationError(error)) : resolve(stream)),
      );
    });
    let closed = false;
    return {
      client,
      channel,
      close: () => {
        if (closed) return;
        closed = true;
        try { channel.end(); } catch { /* best effort */ }
        try { client.end(); } catch { /* best effort */ }
        setTimeout(() => {
          try { (channel as ClientChannel & { destroy?: () => void }).destroy?.(); } catch { /* best effort */ }
          try { (client as Client & { destroy?: () => void }).destroy?.(); } catch { /* best effort */ }
        }, 250).unref();
      },
    };
  } catch (error) {
    client.end();
    throw error;
  }
}

export type ManagedSftpConnection = { sftp: SFTPWrapper; close(): void };

export async function openManagedSftp(
  vps: VpsRecord,
  auth: { privateKey: string },
  security: SshSecurityOptions,
): Promise<ManagedSftpConnection> {
  if (!auth.privateKey.trim()) throw new SshOperationError("SFTP requires a private key.");
  const client = await connect(
    { host: vps.host, port: vps.port, username: vps.username, ...auth },
    { ...security, requireHostKeyPin: true },
  );
  try {
    const sftp = await openSftp(client);
    let closed = false;
    return { sftp, close() {
      if (closed) return;
      closed = true;
      sftp.destroy();
      client.destroy();
    } };
  } catch (error) {
    client.destroy();
    throw error;
  }
}

function toSshOperationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const level =
    typeof error === "object" && error && "level" in error
      ? String((error as { level?: unknown }).level)
      : "";

  if (
    level === "client-authentication" ||
    /authentication|auth|permission denied/i.test(message)
  ) {
    return new SshOperationError(
      "SSH authentication failed. Check username, password, and whether password login is enabled on the VPS.",
    );
  }

  if (/unsupported key format/i.test(message)) {
    return new SshOperationError(
      "SSH private key format is unsupported. Reinstall the VPS key to regenerate a compatible key pair.",
    );
  }

  if (code === "ECONNREFUSED") {
    return new SshOperationError(
      "SSH connection refused. Check the VPS host, SSH port, and whether sshd is running.",
    );
  }

  if (code === "ETIMEDOUT" || /timed out|timeout/i.test(message)) {
    return new SshOperationError(
      "SSH connection timed out. Check network reachability, firewall rules, and SSH port.",
    );
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new SshOperationError("SSH host could not be resolved.");
  }

  // Host key verification failure from ssh2 (hostVerifier called verify(false))
  if (
    level === "handshake" ||
    /host denied|host key verification/i.test(message)
  ) {
    return new SshOperationError(
      "SSH host key verification failed. Check configured host key pins.",
    );
  }

  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return new SshOperationError(
      "SSH host is unreachable from the API server.",
    );
  }

  return new SshOperationError(
    "SSH operation failed. Check host, port, credentials, and server SSH configuration.",
  );
}

function openSftp(client: Client) {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(toSshOperationError(error));
      resolve(sftp);
    });
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string, mode: number) {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, { mode }, (error) => {
      if (!error || isRemoteExistsError(error)) return resolve();
      reject(toSshOperationError(error));
    });
  });
}

function sftpChmod(sftp: SFTPWrapper, path: string, mode: number) {
  return new Promise<void>((resolve, reject) => {
    sftp.chmod(path, mode, (error) => {
      if (error) return reject(toSshOperationError(error));
      resolve();
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string) {
  return new Promise<string>((resolve, reject) => {
    sftp.readFile(path, "utf8", (error, data) => {
      if (error) {
        if (isRemoteNotFoundError(error)) return resolve("");
        return reject(toSshOperationError(error));
      }
      resolve(typeof data === "string" ? data : data.toString("utf8"));
    });
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, data: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, data, { encoding: "utf8", mode: 0o600 }, (error) => {
      if (error) return reject(toSshOperationError(error));
      resolve();
    });
  });
}

function isRemoteExistsError(error: unknown) {
  return (
    typeof error === "object" &&
    error &&
    "code" in error &&
    Number((error as { code?: unknown }).code) === 4
  );
}

function isRemoteNotFoundError(error: unknown) {
  return (
    typeof error === "object" &&
    error &&
    "code" in error &&
    Number((error as { code?: unknown }).code) === 2
  );
}

async function installPublicKeyViaSftp(client: Client, publicKey: string) {
  const sftp = await openSftp(client);
  await sftpMkdir(sftp, SSH_DIR_PATH, 0o700);
  await sftpChmod(sftp, SSH_DIR_PATH, 0o700);
  const existing = await sftpReadFile(sftp, AUTHORIZED_KEYS_PATH);
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.includes(publicKey.trim())) lines.push(publicKey.trim());
  await sftpWriteFile(sftp, AUTHORIZED_KEYS_PATH, `${lines.join("\n")}\n`);
  await sftpChmod(sftp, AUTHORIZED_KEYS_PATH, 0o600);
}

export async function provisionPublicKey(
  vps: VpsRecord,
  password: string,
  publicKey: string,
  security?: SshSecurityOptions,
) {
  const client = await connect(
    { host: vps.host, port: vps.port, username: vps.username, password },
    security,
  );
  try {
    await installPublicKeyViaSftp(client, publicKey);
  } finally {
    client.end();
  }
}

export async function verifyPrivateKey(
  vps: VpsRecord,
  privateKey: string,
  security?: SshSecurityOptions,
) {
  const client = await connect(
    { host: vps.host, port: vps.port, username: vps.username, privateKey },
    security,
  );
  client.end();
}

function sftpWriteBuffer(
  sftp: SFTPWrapper,
  path: string,
  data: Buffer,
  mode: number,
) {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, data, { mode }, (error) => {
      if (error) return reject(toSshOperationError(error));
      resolve();
    });
  });
}

export async function uploadFile(
  vps: VpsRecord,
  remotePath: string,
  content: Buffer,
  mode: number,
  auth: { password?: string; privateKey?: string },
  security?: SshSecurityOptions,
) {
  const client = await connect(
    { host: vps.host, port: vps.port, username: vps.username, ...auth },
    security,
  );
  try {
    const sftp = await openSftp(client);
    await sftpWriteBuffer(sftp, remotePath, content, mode);
  } finally {
    client.end();
  }
}

export async function makeDirectory(
  vps: VpsRecord,
  remotePath: string,
  mode: number,
  auth: { password?: string; privateKey?: string },
  security?: SshSecurityOptions,
) {
  const client = await connect(
    { host: vps.host, port: vps.port, username: vps.username, ...auth },
    security,
  );
  try {
    const sftp = await openSftp(client);
    await sftpMkdir(sftp, remotePath, mode);
  } finally {
    client.end();
  }
}

export async function execCommand(
  vps: VpsRecord,
  command: string,
  auth: { password?: string; privateKey?: string },
  timeoutMs = 30_000,
  security?: SshSecurityOptions,
): Promise<{ stdout: string; stderr: string }> {
  const client = await connect(
    { host: vps.host, port: vps.port, username: vps.username, ...auth },
    security,
  );
  try {
    return await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error) return reject(toSshOperationError(error));
          let stdout = "";
          let stderr = "";
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            stream.close();
            reject(new SshOperationError("Remote command timed out"));
          }, timeoutMs);
          stream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          stream.on("close", (code: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code === 0) resolve({ stdout, stderr });
            else
              reject(
                new SshOperationError(
                  stderr.trim() ||
                    stdout.trim() ||
                    `Remote command failed with code ${code}`,
                ),
              );
          });
        });
      },
    );
  } finally {
    client.end();
  }
}
