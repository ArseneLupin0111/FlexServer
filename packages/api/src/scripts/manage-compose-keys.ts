import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../config/app-config.js";
import "../persistence/repositories/create-repositories.js";
import { withComposeAdminLock } from "../crypto/secret-envelope.js";
import { initKeyring, rotateKeyring, validateExternalSecretPath } from "../ssh/key-encryption.js";

const USAGE = `Usage: manage-compose-keys <init|rotate|rewrap|check> [--help]

Uses COMPOSE_KEYRING_FILE and the configured JSON/PostgreSQL store.
Stop API writers before administration; never clear a live writer lock.
init     Create a separate external keyring, only when no encrypted data exists.
rotate   Add a new active KEK, retain old KEKs, then rewrap every retained field.
rewrap   Rewrap every retained field with the existing active KEK.
check    Report envelope counts and conflicts without changing storage.

Back up ciphertext storage and the keyring separately before rotation.
Never delete old KEKs until all retained fields have been rewrapped.
This command does not rotate SSH keys or change application secret values.`;

export async function manageComposeKeysFromCli(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE);
    return;
  }
  if (args.length !== 1 || !["init", "rotate", "rewrap", "check"].includes(args[0]!)) {
    throw new Error(USAGE);
  }
  const command = args[0]!;
  const config = loadAppConfig();
  const keyringPath = config.composeCrypto.keyringFile;
  validateExternalSecretPath(keyringPath, config.dataDir, config.privateDir, process.cwd());
  const constraints = { dataDir: config.dataDir, privateDir: config.privateDir, projectRoot: process.cwd() };
  await withComposeAdminLock(config, async (admin) => {
    if (command === "init") {
      if (await admin.hasEncryptedFields()) {
        throw new Error("Existing encrypted Compose data requires its original keyring. Restore that keyring; initialization would orphan data.");
      }
      await initKeyring(keyringPath, constraints);
      console.log("Compose keyring initialized. Keep a separate offline recovery copy; restrict file access to the API administrator.");
      return;
    }

    const inspect = await admin.rotateEncryptedFields({ dryRun: true });
    if (inspect.conflictCode || inspect.refusedAppIds.length > 0) {
      throw new Error(`Compose key administration refused: ${inspect.conflictCode ?? "busy"}. Resolve active or uncertain operations before retrying.`);
    }
    if (command === "check") {
      console.log(`Encrypted fields evaluated: ${inspect.rewrapped}; referenced KEKs: ${inspect.kekIds.length}. No storage changes.`);
      return;
    }
    if (command === "rotate") {
      // Old KEKs survive a later store failure; retry rewrap, not rotation.
      await rotateKeyring(keyringPath, constraints);
    }
    const result = await admin.rotateEncryptedFields();
    if (result.conflictCode || result.refusedAppIds.length > 0) {
      throw new Error(`Compose rewrap refused: ${result.conflictCode ?? "busy"}. Existing KEKs remain available; run rewrap after resolving the conflict.`);
    }
    console.log(`Compose encrypted fields rewrapped: ${result.rewrapped}. Previous KEKs retained; back up the updated keyring separately.`);
  });
}

function directlyInvoked(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
  }
}

if (directlyInvoked()) {
  manageComposeKeysFromCli().catch((error: unknown) => {
    // Crypto/store exceptions must not expose submitted configuration or key material.
    console.error(error instanceof Error ? error.message : "Compose key administration failed");
    process.exitCode = 1;
  });
}
