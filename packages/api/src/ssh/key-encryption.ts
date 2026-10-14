import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const ENVELOPE_FORMAT = "vps-manager-envelope-aes256gcm" as const;
export const ENVELOPE_VERSION = 1;

export interface EncryptedPayload {
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64
}

export interface EnvelopeData {
  version: typeof ENVELOPE_VERSION;
  format: typeof ENVELOPE_FORMAT;
  kekId: string;
  dek: EncryptedPayload;
  encryptedKey: EncryptedPayload;
  createdAt: string;
}

export interface KeyringKey {
  key: string; // base64 or 64-character hex encoded 32 bytes
  createdAt?: string;
}

export interface Keyring {
  version: 1;
  activeKekId: string;
  keys: Record<string, KeyringKey | string>;
}

export function getDefaultKeyringPath(): string {
  if (process.platform === "win32") {
    const base =
      process.env.ProgramData ||
      process.env.LOCALAPPDATA ||
      "C:\\ProgramData";
    return join(base, "flexserver", "ssh-keyring.json");
  }
  return "/etc/flexserver/ssh-keyring.json";
}

export function decodeKeyBytes(rawKey: string): Buffer {
  const trimmed = rawKey.trim();
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, "hex");
  } else {
    buf = Buffer.from(trimmed, "base64");
  }
  if (buf.length !== 32) {
    throw new Error(
      `Invalid KEK length: expected 32 bytes (256 bits), got ${buf.length} bytes`,
    );
  }
  return buf;
}

export function getKek(keyring: Keyring, kekId: string): Buffer {
  const entry = keyring.keys?.[kekId];
  if (!entry) {
    throw new Error(`KEK "${kekId}" not found in keyring`);
  }
  const rawKey = typeof entry === "string" ? entry : entry.key;
  if (!rawKey) {
    throw new Error(`KEK "${kekId}" is missing key material in keyring`);
  }
  return decodeKeyBytes(rawKey);
}

export function getActiveKek(keyring: Keyring): { kekId: string; kek: Buffer } {
  if (!keyring.activeKekId) {
    throw new Error("Keyring has no activeKekId configured");
  }
  return {
    kekId: keyring.activeKekId,
    kek: getKek(keyring, keyring.activeKekId),
  };
}

export function encryptWithAesGcm(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): EncryptedPayload {
  if (key.length !== 32) {
    throw new Error(`AES-256-GCM requires a 32-byte key, got ${key.length}`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptWithAesGcm(
  key: Buffer,
  encrypted: EncryptedPayload,
  aad: Buffer,
): Buffer {
  if (key.length !== 32) {
    throw new Error(`AES-256-GCM requires a 32-byte key, got ${key.length}`);
  }
  if (!encrypted?.iv || !encrypted?.ciphertext || !encrypted?.tag) {
    throw new Error("Invalid encrypted payload: missing iv, ciphertext, or tag");
  }
  const iv = Buffer.from(encrypted.iv, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");

  if (iv.length !== 12) {
    throw new Error(
      `Invalid AES-GCM IV length: expected 12 bytes, got ${iv.length}`,
    );
  }
  if (tag.length !== 16) {
    throw new Error(
      `Invalid AES-GCM tag length: expected 16 bytes, got ${tag.length}`,
    );
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function getDekAad(id: string): Buffer {
  return Buffer.from(`${id}:dek:v1`, "utf8");
}

export function getPayloadAad(id: string): Buffer {
  return Buffer.from(`${id}:payload:v1`, "utf8");
}

export function encryptEnvelope(
  id: string,
  plaintextPrivateKey: string,
  kekId: string,
  kek: Buffer,
): EnvelopeData {
  const dek = randomBytes(32);
  const encryptedDek = encryptWithAesGcm(kek, dek, getDekAad(id));
  const encryptedKey = encryptWithAesGcm(
    dek,
    Buffer.from(plaintextPrivateKey, "utf8"),
    getPayloadAad(id),
  );

  return {
    version: ENVELOPE_VERSION,
    format: ENVELOPE_FORMAT,
    kekId,
    dek: encryptedDek,
    encryptedKey,
    createdAt: new Date().toISOString(),
  };
}

export function decryptEnvelope(
  id: string,
  envelope: unknown,
  keyring: Keyring,
): string {
  if (!envelope || typeof envelope !== "object") {
    throw new Error(`Invalid envelope for key "${id}": expected JSON object`);
  }
  const env = envelope as EnvelopeData;
  if (env.format !== ENVELOPE_FORMAT || env.version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope format/version for key "${id}"`);
  }
  if (!env.kekId) {
    throw new Error(`Envelope for key "${id}" is missing kekId`);
  }

  const kek = getKek(keyring, env.kekId);
  let dek: Buffer;
  try {
    dek = decryptWithAesGcm(kek, env.dek, getDekAad(id));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to decrypt DEK for key "${id}" using KEK "${env.kekId}": ${msg}`,
    );
  }

  if (dek.length !== 32) {
    throw new Error(
      `Decrypted DEK for key "${id}" has invalid length (${dek.length})`,
    );
  }

  let privateKeyBuffer: Buffer;
  try {
    privateKeyBuffer = decryptWithAesGcm(
      dek,
      env.encryptedKey,
      getPayloadAad(id),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to decrypt private key payload for "${id}": ${msg}`,
    );
  }

  const privateKey = privateKeyBuffer.toString("utf8");
  if (!privateKey.includes("-----BEGIN")) {
    throw new Error(
      `Decrypted private key payload for "${id}" does not contain a valid PEM marker`,
    );
  }
  return privateKey;
}

export function rewrapEnvelope(
  id: string,
  envelope: EnvelopeData,
  keyring: Keyring,
): EnvelopeData {
  if (
    envelope.format !== ENVELOPE_FORMAT ||
    envelope.version !== ENVELOPE_VERSION
  ) {
    throw new Error(`Unsupported envelope format/version for key "${id}"`);
  }
  const oldKek = getKek(keyring, envelope.kekId);
  const dek = decryptWithAesGcm(oldKek, envelope.dek, getDekAad(id));

  const { kekId: newKekId, kek: newKek } = getActiveKek(keyring);
  const newEncryptedDek = encryptWithAesGcm(newKek, dek, getDekAad(id));

  return {
    ...envelope,
    kekId: newKekId,
    dek: newEncryptedDek,
  };
}

function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(
    dir,
    `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(tmpPath, content, { mode });

  try {
    // Never remove the destination: a failed replacement must preserve its KEKs.
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore tmp cleanup error
    }
    throw error;
  }
}

function getCanonicalPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch (err: unknown) {
    if (getErrorCode(err) === "ENOENT") {
      const parent = dirname(targetPath);
      if (parent === targetPath) return resolve(targetPath);
      const canonicalParent = getCanonicalPath(parent);
      return join(canonicalParent, basename(targetPath));
    }
    return resolve(targetPath);
  }
}

function getCanonicalDir(dirPath: string): string {
  const resolved = resolve(dirPath);
  try {
    return realpathSync(resolved);
  } catch {
    return getCanonicalPath(resolved);
  }
}

function isSubpathOrEqual(child: string, parent: string): boolean {
  const isWindows = process.platform === "win32";
  const c = isWindows ? child.toLowerCase() : child;
  const p = isWindows ? parent.toLowerCase() : parent;
  const rel = relative(p, c);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export function validateExternalSecretPath(
  secretPath: string,
  dataDir: string,
  privateDir: string,
  projectRoot?: string,
): string {
  const resolvedSecret = resolve(secretPath);
  const canonicalSecret = getCanonicalPath(resolvedSecret);

  const canonicalData = getCanonicalDir(dataDir);
  const canonicalPrivate = getCanonicalDir(privateDir);
  const canonicalRoot = projectRoot ? getCanonicalDir(projectRoot) : undefined;

  for (const candidate of [resolvedSecret, canonicalSecret]) {
    if (canonicalData && isSubpathOrEqual(candidate, canonicalData)) {
      throw new Error(
        `SSH_KEY_ENCRYPTION_KEY_FILE (${secretPath}) must not be located inside DATA_DIR (${dataDir})`,
      );
    }
    if (canonicalPrivate && isSubpathOrEqual(candidate, canonicalPrivate)) {
      throw new Error(
        `SSH_KEY_ENCRYPTION_KEY_FILE (${secretPath}) must not be located inside PRIVATE_DIR (${privateDir})`,
      );
    }
    if (canonicalRoot && isSubpathOrEqual(candidate, canonicalRoot)) {
      throw new Error(
        `SSH_KEY_ENCRYPTION_KEY_FILE (${secretPath}) must not be located inside the project directory (${projectRoot})`,
      );
    }
  }

  return resolvedSecret;
}

export async function loadKeyringFromFile(filePath: string): Promise<Keyring> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if (getErrorCode(err) === "ENOENT") {
      throw new Error(`SSH key encryption keyring file not found: ${filePath}`);
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `SSH key encryption keyring file (${filePath}) is not valid JSON`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `SSH key encryption keyring file (${filePath}) must contain a JSON object`,
    );
  }

  const rawRecord = parsed as Record<string, unknown>;
  if (rawRecord.version !== 1) {
    throw new Error(`Unsupported keyring version: ${String(rawRecord.version)}`);
  }
  const keyring = parsed as Keyring;
  if (!keyring.activeKekId || typeof keyring.activeKekId !== "string") {
    throw new Error("Keyring missing activeKekId");
  }
  if (!keyring.keys || typeof keyring.keys !== "object") {
    throw new Error("Keyring missing keys map");
  }

  // Validate active KEK
  getActiveKek(keyring);

  return keyring;
}

export async function saveKeyringToFile(
  filePath: string,
  keyring: Keyring,
): Promise<void> {
  const content = JSON.stringify(keyring, null, 2);
  await atomicWriteFile(filePath, content, 0o600);
}

export async function initKeyring(
  filePath: string,
  options?: {
    dataDir?: string;
    privateDir?: string;
    projectRoot?: string;
  },
): Promise<{ filePath: string; activeKekId: string; keyring: Keyring }> {
  if (options?.dataDir && options?.privateDir) {
    validateExternalSecretPath(
      filePath,
      options.dataDir,
      options.privateDir,
      options.projectRoot,
    );
  }

  const resolved = resolve(filePath);
  if (existsSync(resolved)) {
    throw new Error(
      `Keyring file already exists at ${resolved}. Overwrite is blocked to prevent unrecoverable KEK loss.`,
    );
  }

  const activeKekId = `kek_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const kekBytes = randomBytes(32);

  const keyring: Keyring = {
    version: 1,
    activeKekId,
    keys: {
      [activeKekId]: {
        key: kekBytes.toString("base64"),
        createdAt: new Date().toISOString(),
      },
    },
  };

  await saveKeyringToFile(resolved, keyring);
  return { filePath: resolved, activeKekId, keyring };
}

export interface KeyringRotationResult {
  activeKekId: string;
  newActiveKekId: string;
  previousKekId: string;
  previousActiveKekId: string;
  keyring: Keyring;
}

export async function rotateKeyring(
  filePath: string,
  options?: {
    dataDir?: string;
    privateDir?: string;
    projectRoot?: string;
  },
): Promise<KeyringRotationResult> {
  if (options?.dataDir && options?.privateDir) {
    validateExternalSecretPath(
      filePath,
      options.dataDir,
      options.privateDir,
      options.projectRoot,
    );
  }

  const keyring = await loadKeyringFromFile(filePath);
  const previousKekId = keyring.activeKekId;
  const newKekId = `kek_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const newKekBytes = randomBytes(32);

  keyring.keys[newKekId] = {
    key: newKekBytes.toString("base64"),
    createdAt: new Date().toISOString(),
  };
  keyring.activeKekId = newKekId;

  await saveKeyringToFile(filePath, keyring);
  return {
    activeKekId: newKekId,
    newActiveKekId: newKekId,
    previousKekId,
    previousActiveKekId: previousKekId,
    keyring,
  };
}

export const rotateKeyringInFile = rotateKeyring;

export interface DirectoryMigrationResult {
  total: number;
  migrated: number;
  migratedFromPlaintext: number;
  rewrapped: number;
  alreadyActive: number;
  unchanged: number;
  errors: Array<{ id: string; error: string }>;
}

export async function migrateKeysDirectory(
  keysDir: string,
  keyring: Keyring,
): Promise<DirectoryMigrationResult> {
  if (!existsSync(keysDir)) {
    return {
      total: 0,
      migrated: 0,
      migratedFromPlaintext: 0,
      rewrapped: 0,
      alreadyActive: 0,
      unchanged: 0,
      errors: [],
    };
  }

  const entries = await readdir(keysDir);
  const keyFiles = entries.filter(
    (name) =>
      !name.endsWith(".pub") &&
      !name.endsWith(".tmp") &&
      !name.startsWith("."),
  );

  let migrated = 0;
  let rewrapped = 0;
  let alreadyActive = 0;
  const errors: Array<{ id: string; error: string }> = [];

  const { kekId: activeKekId, kek: activeKek } = getActiveKek(keyring);

  for (const id of keyFiles) {
    const keyPath = join(keysDir, id);
    try {
      const content = await readFile(keyPath, "utf8");

      // Check if legacy plaintext OpenSSH key
      if (content.includes("-----BEGIN")) {
        const envelope = encryptEnvelope(id, content, activeKekId, activeKek);
        await atomicWriteFile(
          keyPath,
          JSON.stringify(envelope, null, 2),
          0o600,
        );
        migrated++;
        continue;
      }

      // Check if envelope JSON
      let envelope: EnvelopeData;
      try {
        envelope = JSON.parse(content);
      } catch {
        errors.push({ id, error: "Not valid JSON or PEM private key" });
        continue;
      }

      if (
        envelope.format !== ENVELOPE_FORMAT ||
        envelope.version !== ENVELOPE_VERSION
      ) {
        errors.push({ id, error: "Unsupported envelope format or version" });
        continue;
      }

      if (envelope.kekId === activeKekId) {
        alreadyActive++;
        continue;
      }

      // Rewrap DEK to active KEK
      const updated = rewrapEnvelope(id, envelope, keyring);
      await atomicWriteFile(
        keyPath,
        JSON.stringify(updated, null, 2),
        0o600,
      );
      rewrapped++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ id, error: msg });
    }
  }

  return {
    total: keyFiles.length,
    migrated,
    migratedFromPlaintext: migrated,
    rewrapped,
    alreadyActive,
    unchanged: alreadyActive,
    errors,
  };
}

export const migrateKeysInDirectory = migrateKeysDirectory;

export function createTestKeyring(kekId = "test-kek-1"): Keyring {
  return {
    version: 1,
    activeKekId: kekId,
    keys: {
      [kekId]: {
        key: randomBytes(32).toString("base64"),
        createdAt: new Date().toISOString(),
      },
    },
  };
}
