#!/usr/bin/env tsx

/**
 * Manual agent installer for an existing VPS.
 * Reads VPS SSH credentials from .env.vps and installs the agent binary
 * plus config, runs -validate-config validation, and starts the systemd service.
 *
 * Usage:
 *   npx tsx scripts/agent/install-agent-from-env.ts --vps-id <vps_id> [--help]
 *
 * Requires a .env.vps file with LOCAL_VPS_IP, LOCAL_VPS_PORT, LOCAL_VPS_USER,
 * LOCAL_VPS_PASSWORD.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Client, type SFTPWrapper } from "ssh2";
import { loadAppConfig } from "../../packages/api/src/config/app-config.js";
import { resolveAgentBackendUrl } from "../../packages/api/src/agents/agent-backend-url.js";
import { createRepositories } from "../../packages/api/src/persistence/repositories/create-repositories.js";
import {
  buildDockerStateProvisionCommand,
  buildTransactionalStartCommand,
} from "../../packages/api/src/agents/agent-lifecycle-remote.js";

const REMOTE_DIR = "/tmp/vps-manager-agent";
const REMOTE_BINARY = `${REMOTE_DIR}/vps-agent`;
const REMOTE_CONFIG = `${REMOTE_DIR}/config.json`;
const LOCAL_BINARY = "packages/agent/dist/vps-agent-linux-amd64";

function usage(exitCode = 0): never {
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage: npx tsx scripts/agent/install-agent-from-env.ts --vps-id <vps_id> [options]

Installs the agent on a VPS using SSH credentials from .env.vps.

Options:
  --vps-id <id>   Existing VPS id to bind the token to
  --help          Show this help and exit
`);
  process.exit(exitCode);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parseEnvFile(path: string) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        let value = line.slice(index + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [line.slice(0, index).trim(), value];
      }),
  );
}

function connect(input: {
  host: string;
  port: number;
  username: string;
  password: string;
}) {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect({ ...input, readyTimeout: 15_000 });
  });
}

function openSftp(client: Client) {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function mkdir(sftp: SFTPWrapper, path: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, { mode: 0o700 }, (error) => {
      if (!error || Number((error as { code?: unknown })?.code) === 4)
        return resolve();
      reject(error);
    });
  });
}

function writeRemoteFile(
  sftp: SFTPWrapper,
  path: string,
  data: string | Buffer,
  mode: number,
) {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, data, { mode }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function chmod(sftp: SFTPWrapper, path: string, mode: number) {
  return new Promise<void>((resolve, reject) => {
    sftp.chmod(path, mode, (error) => (error ? reject(error) : resolve()));
  });
}

function exec(client: Client, command: string, timeoutMs = 30_000) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.close();
        reject(new Error("Remote command timed out"));
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
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                `Remote command failed with code ${code}`,
            ),
          );
      });
    });
  });
}

async function createAgentToken(vpsId: string) {
  const config = loadAppConfig();
  const repos = createRepositories(config);
  const { vps: vpsRepository, agent: agentRepository, pool } = repos;

  try {
    const vps = await vpsRepository.get(vpsId);
    if (!vps) throw new Error(`VPS not found: ${vpsId}`);
    const secret = randomBytes(32).toString("hex");
    const credential = await agentRepository.createCredential({
      vpsId: vps.id,
      secretHash: createHash("sha256").update(secret).digest("hex"),
      status: "active",
    });
    return {
      config,
      vps,
      token: `vma_${credential.id}_${secret}`,
      credentialId: credential.id,
    };
  } finally {
    if (pool) await pool.end();
  }
}

async function main() {
  if (process.argv.includes("--help")) usage();
  const vpsId = argValue("--vps-id");
  if (!vpsId) usage(1);
  if (!existsSync(LOCAL_BINARY))
    throw new Error(
      `Agent binary not found: ${LOCAL_BINARY}. Run npm run build:agent first.`,
    );

  const env = parseEnvFile(".env.vps");
  const host = env.LOCAL_VPS_IP;
  const port = Number(env.LOCAL_VPS_PORT || 22);
  const username = env.LOCAL_VPS_USER;
  const password = env.LOCAL_VPS_PASSWORD;
  if (!host || !port || !username || !password)
    throw new Error(
      "Invalid .env.vps. Expected LOCAL_VPS_IP, LOCAL_VPS_PORT, LOCAL_VPS_USER, LOCAL_VPS_PASSWORD.",
    );

  const { config, vps, token, credentialId } = await createAgentToken(vpsId);
  const backendUrl = resolveAgentBackendUrl(config);
  const agentConfig = {
    backendUrl,
    vpsId,
    token,
    intervalSeconds: config.agentInstallIntervalSeconds,
    requestTimeoutSeconds: 10,
  };

  const client = await connect({ host, port, username, password });
  try {
    const sftp = await openSftp(client);
    await mkdir(sftp, REMOTE_DIR);
    await writeRemoteFile(
      sftp,
      REMOTE_BINARY,
      readFileSync(LOCAL_BINARY),
      0o700,
    );
    await chmod(sftp, REMOTE_BINARY, 0o700);
    await writeRemoteFile(
      sftp,
      REMOTE_CONFIG,
      `${JSON.stringify(agentConfig, null, 2)}\n`,
      0o600,
    );
    await chmod(sftp, REMOTE_CONFIG, 0o600);
    // Provision Docker identity/runtime state before any agent run.
    // exec() rejects on non-zero exit, so a provisioning failure aborts here
    // and the preflight validation never runs.
    await exec(
      client,
      buildDockerStateProvisionCommand(REMOTE_BINARY, REMOTE_DIR),
      30_000,
    );
    const preflightResult = await exec(
      client,
      `${REMOTE_BINARY} -config ${REMOTE_CONFIG} -validate-config`,
      15_000,
    );
    const pidFile = `${REMOTE_DIR}/vps-agent.pid`;
    const startCmd = buildTransactionalStartCommand(
      REMOTE_BINARY,
      REMOTE_CONFIG,
      pidFile,
      {
        user: username,
        vpsId,
        homeDir: REMOTE_DIR.replace(/\/\.vps-manager-agent$/, "") || "/root",
      },
    );
    const startResult = await exec(client, startCmd, 30_000);
    console.log(
      JSON.stringify(
        {
          installed: true,
          vpsId,
          credentialId,
          remoteDir: REMOTE_DIR,
          backendUrl,
          agentOutput:
            preflightResult.stdout.trim() ||
            startResult.stdout.trim() ||
            "completed",
        },
        null,
        2,
      ),
    );
  } finally {
    client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message.replace(/vma_[A-Za-z0-9_]+/g, "[redacted-token]")
      : "Agent install failed",
  );
  process.exit(1);
});
