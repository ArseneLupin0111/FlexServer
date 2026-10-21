import { randomBytes } from "node:crypto";
import {
  decryptWithAesGcm,
  encryptWithAesGcm,
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
  getActiveKek,
  getKek,
  type EnvelopeData,
  loadKeyringFromFile,
  type Keyring,
} from "../ssh/key-encryption.js";
import type { AppConfig } from "../config/app-config.js";

/**
 * Generic envelope crypto seam for Compose application secret material
 * (revision composeYaml, secrets, registry credentials, preview resolved
 * models). Distinct namespace from SSH key envelopes; reuses the same
 * primitives (encryptWithAesGcm/decryptWithAesGcm, Keyring file format,
 * loadKeyringFromFile) and the same KEK-in-envelope-wraps-DEK envelope
 * shape so ONE keyring handling works across both features.
 *
 * The keyring file is external-only (never dataDir/privateDir); configured
 * via COMPOSE_KEYRING_FILE, resolved in compose-crypto-config.ts with the
 * default /etc/flexserver/compose-keyring.json. Missing/unreadable keyring
 * fails closed with ComposeCryptoUnavailableError — no plaintext fallback,
 * no silent init.
 */
export const COMPOSE_AAD_NS = "flexserver:compose:v1";
export const COMPOSE_ADMIN_ADVISORY_KEY = "vps-manager:compose-secrets";

export type AadField =
  | "composeYaml"
  | "secret"
  | "registryCredential"
  | "resolvedModel";

export type ComposeEnvelopeData = EnvelopeData & {
  namespace: typeof COMPOSE_AAD_NS;
};

export type ComposeAadContext = {
  vpsId: string;
  appId: string;
  field: AadField;
  version: number | string;
};

export function getComposeDekAad(context: ComposeAadContext): Buffer {
  return Buffer.from(`${composeAadPrefix(context)}:dek`, "utf8");
}

export function getComposePayloadAad(context: ComposeAadContext): Buffer {
  return Buffer.from(`${composeAadPrefix(context)}:payload`, "utf8");
}

function composeAadPrefix(context: ComposeAadContext): string {
  return JSON.stringify([COMPOSE_AAD_NS, context.vpsId, context.appId, context.field, context.version]);
}

export class ComposeCryptoUnavailableError extends Error {
  readonly code = "crypto_unavailable" as const;

  constructor(message = "compose keyring unavailable") {
    super(message);
    this.name = "ComposeCryptoUnavailableError";
  }
}

/** Encrypt a UTF-8 field into a Compose-namespaced envelope. */
export function encryptComposeField(
  plaintext: string,
  context: ComposeAadContext,
  keyring: Keyring,
): ComposeEnvelopeData {
  const { kekId, kek } = getActiveKek(keyring);
  const dek = randomBytes(32);
  const wrappedDek = encryptWithAesGcm(kek, dek, getComposeDekAad(context));
  const payload = encryptWithAesGcm(
    dek,
    Buffer.from(plaintext, "utf8"),
    getComposePayloadAad(context),
  );
  return {
    namespace: COMPOSE_AAD_NS,
    version: ENVELOPE_VERSION,
    format: ENVELOPE_FORMAT,
    kekId,
    dek: wrappedDek,
    encryptedKey: payload,
    createdAt: new Date().toISOString(),
  };
}

/** Decrypt a Compose envelope (fail closed). */
export function decryptComposeField(
  envelope: ComposeEnvelopeData,
  context: ComposeAadContext,
  keyring: Keyring,
): string {
  if (
    envelope.format !== ENVELOPE_FORMAT ||
    envelope.version !== ENVELOPE_VERSION ||
    envelope.namespace !== COMPOSE_AAD_NS
  ) {
    throw new ComposeCryptoUnavailableError(
      "unsupported Compose envelope format/namespace",
    );
  }
  if (!envelope.kekId) {
    throw new ComposeCryptoUnavailableError("Compose envelope has no kekId");
  }
  let dek: Buffer;
  try {
    dek = decryptWithAesGcm(
      getComposeKek(keyring, envelope.kekId),
      envelope.dek,
      getComposeDekAad(context),
    );
  } catch (err) {
    throw new ComposeCryptoUnavailableError(
      `failed to decrypt Compose DEK: ${String(err)}`,
    );
  }
  try {
    return decryptWithAesGcm(
      dek,
      envelope.encryptedKey,
      getComposePayloadAad(context),
    ).toString("utf8");
  } catch (err) {
    throw new ComposeCryptoUnavailableError(
      `failed to decrypt Compose payload: ${String(err)}`,
    );
  }
}

/** Re-wrap only the DEK to the ACTIVE KEK — plaintext never touches memory. */
export function rewrapComposeEnvelope(
  envelope: ComposeEnvelopeData,
  context: ComposeAadContext,
  keyring: Keyring,
): ComposeEnvelopeData {
  if (
    envelope.format !== ENVELOPE_FORMAT ||
    envelope.version !== ENVELOPE_VERSION ||
    envelope.namespace !== COMPOSE_AAD_NS
  ) {
    throw new ComposeCryptoUnavailableError(
      "unsupported Compose envelope format/namespace",
    );
  }
  let dek: Buffer;
  try {
    dek = decryptWithAesGcm(
      getComposeKek(keyring, envelope.kekId),
      envelope.dek,
      getComposeDekAad(context),
    );
  } catch (err) {
    throw new ComposeCryptoUnavailableError(
      `failed to decrypt Compose DEK for rewrap: ${String(err)}`,
    );
  }
  const { kekId: newKekId, kek: newKek } = getActiveKek(keyring);
  const newWrappedDek = encryptWithAesGcm(
    newKek,
    dek,
    getComposeDekAad(context),
  );
  return {
    ...envelope,
    kekId: newKekId,
    dek: newWrappedDek,
  };
}

/** Get a KEK buffer for a specific id from a keyring (fail closed, shared decoder). */
function getComposeKek(keyring: Keyring, kekId: string): Buffer {
  try {
    return getKek(keyring, kekId);
  } catch (err) {
    throw new ComposeCryptoUnavailableError(`Compose KEK "${kekId}" unavailable: ${String(err)}`);
  }
}

/** Load the external keyring file (fail closed absent/invalid). */
export async function loadComposeKeyring(
  keyringFile: string,
): Promise<Keyring> {
  try {
    return await loadKeyringFromFile(keyringFile);
  } catch (err) {
    throw new ComposeCryptoUnavailableError(
      `compose keyring "${keyringFile}" unavailable: ${String(err)}`,
    );
  }
}

export type ComposeAdminStoreConfig = Readonly<
  Pick<
    AppConfig,
    | "dataDir"
    | "storageDriver"
    | "databaseUrl"
    | "dbSsl"
    | "dbPoolMax"
    | "composeCrypto"
  >
>;

/** Administrative context handed to CLI actions, sealed to one lock scope. */
export type ComposeAdminContext = {
  hasEncryptedFields(): Promise<boolean>;
  rotateEncryptedFields(options?: {
    dryRun?: boolean;
  }): Promise<{
    rewrapped: number;
    refusedAppIds: string[];
    kekIds: string[];
    conflictCode?: "busy" | "crypto_unavailable";
  }>;
};

/** Run `action` under the compose administrative authority (JSON lifetime
 * writer lock; PG session advisory lock pinned to one dedicated client).
 * Inner helpers receive the context and MUST reuse it (no re-acquisition,
 * no deadlock). */
export async function withComposeAdminLock<T>(
  config: ComposeAdminStoreConfig,
  action: (context: ComposeAdminContext) => Promise<T>,
): Promise<T> {
  const context = await openComposeAdminContext(config);
  try {
    return await action(context);
  } finally {
    await closeComposeAdminContext(context);
  }
}

async function openComposeAdminContext(
  config: ComposeAdminStoreConfig,
): Promise<ComposeAdminContext> {
  return createContext(config);
}

async function closeComposeAdminContext(
  context: ComposeAdminContext,
): Promise<void> {
  await releaseContext(context);
}

// Context creation/release is delegated to the repository wiring; the
// function is injected by compose-repository-registry.ts to avoid circular
// imports (crypto < repositories knowledge is runtime-only via a setter).
type ComposeAdminContextState = ComposeAdminContext & {
  __release?: () => Promise<void>;
};

type ContextFactory = (
  config: ComposeAdminStoreConfig,
) => Promise<ComposeAdminContextState>;

let contextFactory: ContextFactory | undefined;

export function registerComposeAdminContextFactory(
  factory: ContextFactory,
): void {
  contextFactory = factory;
}

async function createContext(
  config: ComposeAdminStoreConfig,
): Promise<ComposeAdminContextState> {
  if (!contextFactory) {
    throw new ComposeCryptoUnavailableError(
      "compose admin context factory not registered (repositories wiring missing)",
    );
  }
  return contextFactory(config);
}

async function releaseContext(
  context: ComposeAdminContextState,
): Promise<void> {
  if (context.__release) await context.__release();
}
