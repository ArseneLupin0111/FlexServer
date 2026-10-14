import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type ssh2 from "ssh2";
import {
  atomicWriteFile,
  decryptEnvelope,
  encryptEnvelope,
  getActiveKek,
  loadKeyringFromFile,
  type EnvelopeData,
  type Keyring,
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
} from "./key-encryption.js";

const require = createRequire(import.meta.url);
const sshUtils = (require("ssh2") as typeof ssh2).utils;
function isLegacyUnsupportedPrivateKey(privateKey: string) {
  return privateKey.includes("-----BEGIN PRIVATE KEY-----");
}

function generateOpenSshKeyPair() {
  const keyPair = sshUtils.generateKeyPairSync("ed25519");
  return { privateKey: keyPair.private, publicKey: keyPair.public };
}
function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export interface KeyPairResult {
  privateKeyPath: string;
  publicKeyPath: string;
  privateKey: string;
  publicKey: string;
}

export interface KeyServiceOptions {
  baseDir?: string;
  keyringFilePath?: string;
  keyring?: Keyring;
}

export interface KeyService {
  ensureKeyPair(id: string): Promise<KeyPairResult>;
  readPrivateKey(id: string): Promise<string>;
}

export function createKeyService(
  baseDirOrOptions: string | KeyServiceOptions = "private/keys",
  maybeOptions?: KeyServiceOptions,
): KeyService {
  const baseDir =
    typeof baseDirOrOptions === "string"
      ? baseDirOrOptions
      : (baseDirOrOptions?.baseDir ?? "private/keys");
  const options =
    typeof baseDirOrOptions === "object"
      ? baseDirOrOptions
      : (maybeOptions ?? {});

  function paths(id: string) {
    return {
      privateKeyPath: join(baseDir, id),
      publicKeyPath: join(baseDir, `${id}.pub`),
    };
  }

  async function resolveKeyring(): Promise<Keyring> {
    if (options.keyring) {
      return options.keyring;
    }
    const keyringPath =
      options.keyringFilePath || process.env.SSH_KEY_ENCRYPTION_KEY_FILE;
    if (!keyringPath) {
      throw new Error(
        "SSH key encryption keyring is not configured or missing; real SSH key operations are blocked.",
      );
    }
    return loadKeyringFromFile(keyringPath);
  }

  async function writeNewKeyPair(id: string) {
    const keyring = await resolveKeyring();
    const { kekId, kek } = getActiveKek(keyring);
    const keyPaths = paths(id);
    const { privateKey, publicKey } = generateOpenSshKeyPair();

    const envelope = encryptEnvelope(id, privateKey, kekId, kek);

    await mkdir(baseDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(
      keyPaths.privateKeyPath,
      JSON.stringify(envelope, null, 2),
      0o600,
    );
    await atomicWriteFile(
      keyPaths.publicKeyPath,
      `${publicKey.trim()}\n`,
      0o644,
    );

    return { ...keyPaths, privateKey, publicKey: publicKey.trim() };
  }

  async function readAndDecryptPrivateKey(id: string): Promise<string> {
    const keyPaths = paths(id);
    const raw = await readFile(keyPaths.privateKeyPath, "utf8");

    // Check if legacy plaintext OpenSSH key
    if (raw.includes("-----BEGIN")) {
      if (isLegacyUnsupportedPrivateKey(raw)) {
        throw new Error(
          `Legacy PKCS#8 private key format is not supported for "${id}"`,
        );
      }
      // Migrate on the fly: encrypt with active KEK and atomically write envelope
      const keyring = await resolveKeyring();
      const { kekId, kek } = getActiveKek(keyring);
      const envelope = encryptEnvelope(id, raw, kekId, kek);
      await atomicWriteFile(
        keyPaths.privateKeyPath,
        JSON.stringify(envelope, null, 2),
        0o600,
      );
      return raw;
    }

    // It must be a JSON envelope
    let envelope: EnvelopeData;
    try {
      envelope = JSON.parse(raw) as EnvelopeData;
    } catch {
      throw new Error(
        `Corrupted private key file for "${id}": not valid JSON envelope or PEM key`,
      );
    }

    if (
      envelope.format !== ENVELOPE_FORMAT ||
      envelope.version !== ENVELOPE_VERSION
    ) {
      throw new Error(
        `Unsupported private key format "${envelope.format}" for "${id}"`,
      );
    }

    const keyring = await resolveKeyring();
    return decryptEnvelope(id, envelope, keyring);
  }

  return {
    async ensureKeyPair(id: string) {
      const keyPaths = paths(id);
      const [privateExists, publicExists] = await Promise.all([
        pathExists(keyPaths.privateKeyPath),
        pathExists(keyPaths.publicKeyPath),
      ]);

      if (privateExists && !publicExists) {
        throw new Error(
          `Private key exists for "${id}" but public key is missing; unsafe regeneration blocked`,
        );
      }
      if (!privateExists && publicExists) {
        throw new Error(
          `Public key exists for "${id}" but private key is missing; unsafe regeneration blocked`,
        );
      }

      if (privateExists && publicExists) {
        const [privateKey, rawPublicKey] = await Promise.all([
          readAndDecryptPrivateKey(id),
          readFile(keyPaths.publicKeyPath, "utf8"),
        ]);
        return { ...keyPaths, privateKey, publicKey: rawPublicKey.trim() };
      }

      return writeNewKeyPair(id);
    },
    async readPrivateKey(id: string) {
      return readAndDecryptPrivateKey(id);
    },
  };
}

