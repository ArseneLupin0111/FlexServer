/**
 * CLI tool to manage SSH key envelope encryption:
 *   - init:    Initialize a new external keyring secret file.
 *   - rotate:  Generate a new active KEK in the keyring and rewrap existing keys.
 *   - migrate: Migrate existing plaintext OpenSSH keys or rewrap to active KEK.
 *
 * Never prints secret key material to stdout/stderr.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../config/app-config.js";
import {
  getDefaultKeyringPath,
  initKeyring,
  loadKeyringFromFile,
  migrateKeysDirectory,
  rotateKeyring,
  validateExternalSecretPath,
  ENVELOPE_FORMAT,
} from "../ssh/key-encryption.js";
function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index !== -1) {
    if (index + 1 >= process.argv.length || process.argv[index + 1]!.startsWith("-")) {
      throw new Error(`Missing required value for flag ${flag}`);
    }
    return process.argv[index + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printUsage(): void {
  console.log(`
Usage: manage-ssh-keys <command> [options]

Commands:
  init      Initialize a new external SSH key encryption keyring file
  rotate    Generate a new active KEK and rewrap managed SSH keys
  migrate   Migrate plaintext keys and rewrap existing envelopes to active KEK

Options:
  --path <file>       Explicit external path to keyring file (default: SSH_KEY_ENCRYPTION_KEY_FILE or system default)
  --keys-dir <dir>    Managed SSH keys directory (default: PRIVATE_DIR/keys)
  --migrate           Migrate existing plaintext keys immediately after init
  --skip-rewrap       Rotate keyring without immediately rewrapping managed keys
  --help, -h          Show this help message
`);
}

export async function manageSshKeysFromCli(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-"));

  if (!command || hasFlag("--help") || hasFlag("-h")) {
    printUsage();
    if (!command && !hasFlag("--help") && !hasFlag("-h")) {
      process.exitCode = 1;
    }
    return;
  }

  const config = loadAppConfig();
  const explicitPath = getArgValue("--path");
  const keyringPath =
    explicitPath ??
    config.sshKeyEncryptionKeyFile ??
    process.env.SSH_KEY_ENCRYPTION_KEY_FILE ??
    getDefaultKeyringPath();

  const explicitKeysDir = getArgValue("--keys-dir");
  const keysDir = explicitKeysDir ?? join(config.privateDir, "keys");

  switch (command) {
    case "init": {
      // Guard against initializing a new keyring if existing encrypted key envelopes exist
      if (existsSync(keysDir)) {
        const entries = readdirSync(keysDir);
        for (const entry of entries) {
          if (entry.endsWith(".pub") || entry.endsWith(".tmp") || entry.startsWith(".")) {
            continue;
          }
          const fullPath = join(keysDir, entry);
          try {
            const content = readFileSync(fullPath, "utf8");
            if (!content.includes("-----BEGIN")) {
              const parsed = JSON.parse(content);
              if (parsed && typeof parsed === "object" && parsed.format === ENVELOPE_FORMAT) {
                throw new Error(
                  `Cannot initialize a new keyring: found existing encrypted key envelope ("${entry}") in ${keysDir}. Initializing a new keyring would orphan existing encrypted keys. Restore the original keyring file instead.`,
                );
              }
            }
          } catch (err: unknown) {
            if (err instanceof Error && err.message.includes("Cannot initialize a new keyring")) {
              throw err;
            }
          }
        }
      }

      const result = await initKeyring(keyringPath, {
        dataDir: config.dataDir,
        privateDir: config.privateDir,
      });

      console.log("Keyring initialized successfully.");
      console.log(`Active KEK ID: ${result.keyring.activeKekId}`);
      console.log("");
      console.log("Configuration required:");
      console.log(`Set SSH_KEY_ENCRYPTION_KEY_FILE=${keyringPath} in your .env file.`);
      console.log("");
      console.log("SECURITY NOTICE:");
      console.log("1. Maintain a separate, offline recovery copy of this keyring file.");
      console.log("2. Exclude this keyring file from regular application data backups.");
      console.log("3. Ensure strict file permissions (0600 / owner read-write only).");

      if (hasFlag("--migrate")) {
        console.log("");
        console.log(`Migrating existing keys in: ${keysDir}`);
        const migration = await migrateKeysDirectory(keysDir, result.keyring);
        console.log("Migration summary:");
        console.log(`- Total key files evaluated: ${migration.total}`);
        console.log(
          `- Migrated from plaintext to encrypted envelope: ${migration.migratedFromPlaintext}`,
        );
        console.log(
          `- Rewrapped older KEK envelopes to active KEK: ${migration.rewrapped}`,
        );
        console.log(
          `- Already encrypted with active KEK: ${migration.unchanged}`,
        );
        if (migration.errors.length > 0) {
          console.error(
            `- Errors encountered during migration (${migration.errors.length}):`,
          );
          for (const err of migration.errors) {
            console.error(`  - Key "${err.id}": ${err.error}`);
          }
          process.exitCode = 1;
        }
      }
      break;
    }

    case "rotate": {
      const skipRewrap = hasFlag("--skip-rewrap");
      console.log(`Rotating active KEK in keyring: ${keyringPath}`);

      // Validate secret path before proceeding
      validateExternalSecretPath(
        keyringPath,
        config.dataDir,
        config.privateDir,
      );

      const rotation = await rotateKeyring(keyringPath);
      console.log(
        `Active KEK rotated: ${rotation.previousActiveKekId} -> ${rotation.newActiveKekId}`,
      );

      if (!skipRewrap) {
        console.log(`Rewrapping managed keys in: ${keysDir}`);
        const migration = await migrateKeysDirectory(
          keysDir,
          rotation.keyring,
        );
        console.log(
          `Rewrapped ${migration.rewrapped} keys (${migration.unchanged} unchanged, ${migration.migratedFromPlaintext} migrated from plaintext).`,
        );
        if (migration.errors.length > 0) {
          console.error(
            `Encountered ${migration.errors.length} error(s) during key rewrapping:`,
          );
          for (const err of migration.errors) {
            console.error(`  - Key "${err.id}": ${err.error}`);
          }
          process.exitCode = 1;
        }
      } else {
        console.log(
          "Skipped key rewrapping (--skip-rewrap specified). Existing keys remain decryptable via historical KEKs.",
        );
      }

      console.log("");
      console.log("SECURITY NOTICE:");
      console.log(
        "Update your offline recovery copy of the keyring to include the newly rotated KEK.",
      );
      break;
    }

    case "migrate": {
      console.log(`Loading keyring from: ${keyringPath}`);
      validateExternalSecretPath(
        keyringPath,
        config.dataDir,
        config.privateDir,
      );

      const keyring = await loadKeyringFromFile(keyringPath);
      console.log(
        `Active KEK ID: ${keyring.activeKekId}. Migrating keys in: ${keysDir}`,
      );

      const migration = await migrateKeysDirectory(keysDir, keyring);
      console.log("Migration summary:");
      console.log(
        `- Total key files evaluated: ${migration.total}`,
      );
      console.log(
        `- Migrated from plaintext to encrypted envelope: ${migration.migratedFromPlaintext}`,
      );
      console.log(
        `- Rewrapped older KEK envelopes to active KEK: ${migration.rewrapped}`,
      );
      console.log(
        `- Already encrypted with active KEK: ${migration.unchanged}`,
      );
      if (migration.errors.length > 0) {
        console.error(
          `- Errors encountered during migration (${migration.errors.length}):`,
        );
        for (const err of migration.errors) {
          console.error(`  - Key "${err.id}": ${err.error}`);
        }
        process.exitCode = 1;
      }
      break;
    }
    default:
      console.error(`Unknown command: "${command}"\n`);
      printUsage();
      process.exitCode = 1;
      break;
  }
}

function isCurrentScriptDirectRun(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  try {
    const canonicalScript = existsSync(scriptPath)
      ? realpathSync(scriptPath)
      : resolve(scriptPath);
    const canonicalModule = realpathSync(fileURLToPath(import.meta.url));
    return canonicalScript.toLowerCase() === canonicalModule.toLowerCase();
  } catch {
    return (
      resolve(scriptPath).toLowerCase() ===
      resolve(fileURLToPath(import.meta.url)).toLowerCase()
    );
  }
}

if (isCurrentScriptDirectRun()) {
  manageSshKeysFromCli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("SSH key management failed:", message);
    process.exit(1);
  });
}
