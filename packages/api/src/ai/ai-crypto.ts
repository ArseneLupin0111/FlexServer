import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decryptWithAesGcm,
  encryptWithAesGcm,
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
  getActiveKek,
  getKek,
  type EnvelopeData,
  type Keyring,
  loadKeyringFromFile,
  validateExternalSecretPath,
} from "../ssh/key-encryption.js";

/**
 * AI-namespaced envelope crypto seam (plan §9.1): API keys for the provider and
 * optionally encrypted execution payload blobs (scripts / file candidates).
 *
 * Deliberately distinct namespace from the Compose envelope (compose-crypto-config.ts):
 * same keyring file format and AES-256-GCM primitives as ssh/key-encryption.ts,
 * but every AAD string is prefixed with AI_AAD_NS so envelopes encrypted for AI
 * cannot be decrypted by compose tooling or vice versa, even when both reuse the
 * same keyring file.
 *
 * Every AAD binds (vpsId, taskId, field, version) so a task's execution payload
 * or key material cannot be replayed into another task context.
 *
 * The keyring file is external-only (never inside project/data/private dirs,
 * validated by validateExternalSecretPath — same policy as the SSH keyring).
 * Absent/unreadable keyring fails closed with AiCryptoUnavailableError — no
 * plaintext fallback, no silent initialization, and the dashboard session
 * secret is never an encryption key.
 */
export const AI_AAD_NS = "flexserver:ai:v1";

export type AiAadField = "providerApiKey" | "executionPayload";

export type AiAadContext = {
  vpsId: string;
  taskId: string;
  field: AiAadField;
  version: number | string;
};

export type AiEnvelopeData = EnvelopeData & {
  namespace: typeof AI_AAD_NS;
};

export class AiCryptoUnavailableError extends Error {
  readonly code = "crypto_unavailable" as const;

  constructor(message = "AI crypto keyring unavailable") {
    super(message);
    this.name = "AiCryptoUnavailableError";
  }
}

function aiAadPrefix(context: AiAadContext): string {
  if (!context?.vpsId || !context?.taskId) {
    throw new AiCryptoUnavailableError(
      "AI AAD context requires non-empty vpsId and taskId",
    );
  }
  return JSON.stringify([
    AI_AAD_NS,
    context.vpsId,
    context.taskId,
    context.field,
    context.version,
  ]);
}

export function getAiDekAad(context: AiAadContext): Buffer {
  return Buffer.from(`${aiAadPrefix(context)}:dek`, "utf8");
}

export function getAiPayloadAad(context: AiAadContext): Buffer {
  return Buffer.from(`${aiAadPrefix(context)}:payload`, "utf8");
}

/** Encrypt a UTF-8 secret into an AI-namespaced envelope. */
export function encryptAiSecret(
  plaintext: string,
  context: AiAadContext,
  keyring: Keyring,
): AiEnvelopeData {
  const { kekId, kek } = getActiveAiKek(keyring);
  const dek = randomBytes(32);
  const wrappedDek = encryptWithAesGcm(kek, dek, getAiDekAad(context));
  const payload = encryptWithAesGcm(
    dek,
    Buffer.from(plaintext, "utf8"),
    getAiPayloadAad(context),
  );
  return {
    namespace: AI_AAD_NS,
    version: ENVELOPE_VERSION,
    format: ENVELOPE_FORMAT,
    kekId,
    dek: wrappedDek,
    encryptedKey: payload,
    createdAt: new Date().toISOString(),
  };
}

/** Decrypt an AI envelope bound to the exact same vpsId/taskId/field/version.
 * Fails closed (AiCryptoUnavailableError) on wrong context or missing KEK. */
export function decryptAiSecret(
  envelope: AiEnvelopeData,
  context: AiAadContext,
  keyring: Keyring,
): string {
  if (
    envelope?.format !== ENVELOPE_FORMAT ||
    envelope?.version !== ENVELOPE_VERSION ||
    envelope?.namespace !== AI_AAD_NS
  ) {
    throw new AiCryptoUnavailableError("unsupported AI envelope format/namespace");
  }
  if (!envelope.kekId) {
    throw new AiCryptoUnavailableError("AI envelope has no kekId");
  }
  let dek: Buffer;
  try {
    dek = decryptWithAesGcm(
      getAiKek(keyring, envelope.kekId),
      envelope.dek,
      getAiDekAad(context),
    );
  } catch {
    throw new AiCryptoUnavailableError("Failed to decrypt AI DEK");
  }

  try {
    return decryptWithAesGcm(dek, envelope.encryptedKey, getAiPayloadAad(context)).toString("utf8");
  } catch {
    throw new AiCryptoUnavailableError("Failed to decrypt AI payload");
  }
}

/** Rotate only the wrapped DEK, preserving the encrypted payload and its identity. */
export function rewrapAiEnvelope(envelope: AiEnvelopeData, context: AiAadContext, keyring: Keyring): AiEnvelopeData {
  // Authenticate both layers before rewrapping; malformed payloads cannot be blessed.
  decryptAiSecret(envelope, context, keyring);
  try {
    const dek = decryptWithAesGcm(getAiKek(keyring, envelope.kekId), envelope.dek, getAiDekAad(context));
    const active = getActiveAiKek(keyring);
    return { ...envelope, kekId: active.kekId, dek: encryptWithAesGcm(active.kek, dek, getAiDekAad(context)) };
  } catch {
    throw new AiCryptoUnavailableError("Failed to rewrap AI envelope");
  }
}

function getActiveAiKek(keyring: Keyring): { kekId: string; kek: Buffer } {
  try {
    return getActiveKek(keyring);
  } catch {
    throw new AiCryptoUnavailableError("AI active KEK unavailable");
  }
}

function getAiKek(keyring: Keyring, kekId: string): Buffer {
  try {
    return getKek(keyring, kekId);
  } catch {
    throw new AiCryptoUnavailableError("AI KEK unavailable");
  }
}

/** Load the external keyring file (fail closed absent/invalid). */
export async function loadAiKeyring(keyringFile: string): Promise<Keyring> {
  try {
    return await loadKeyringFromFile(keyringFile);
  } catch {
    throw new AiCryptoUnavailableError("AI keyring unavailable");
  }
}

/** Canonical default external path for the AI keyring file. */
export const AI_DEFAULT_KEYRING_PATH = "/etc/flexserver/ai-keyring.json";

/** Resolve AI_KEYRING_FILE with the same external-path validation the SSH keyring
 * uses. Absent env var → conventional external default; present value MUST
 * resolve to a path outside project / data / private dirs. */
export function resolveAiKeyringFilePath(
  envValue: string | undefined,
  config: { dataDir: string; privateDir: string },
): string {
  if (!envValue) {
    return AI_DEFAULT_KEYRING_PATH;
  }
  const projectRoot =
    findProjectRoot(process.cwd()) ??
    findProjectRoot(dirname(fileURLToPath(new URL(import.meta.url))));
  return validateExternalSecretPath(envValue, config.dataDir, config.privateDir, projectRoot);
}

function findProjectRoot(startDirectory: string): string | undefined {
  let currentDirectory = startDirectory;

  while (true) {
    if (existsSync(join(currentDirectory, "package.json"))) return currentDirectory;
    const parent = dirname(currentDirectory);
    if (parent === currentDirectory) return undefined;
    currentDirectory = parent;
  }
}
