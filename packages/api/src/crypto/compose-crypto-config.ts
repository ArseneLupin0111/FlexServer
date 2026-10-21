import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateExternalSecretPath } from "../ssh/key-encryption.js";

/** Compose application crypto configuration.
 *
 * Keyring file must live OUTSIDE project/data/private dirs (external key
 * material policy). Absent file means crypto unavailable at use time (503,
 * fail closed) rather than a plaintext fallback or a privateDir default.
 */
export type ComposeCryptoConfig = {
  /** Absolute path to the external keyring file. */
  keyringFile: string;
};

function findProjectRoot(startDirectory: string): string | undefined {
  let currentDirectory = startDirectory;
  while (true) {
    if (existsSync(join(currentDirectory, "package.json"))) return currentDirectory;
    const parent = dirname(currentDirectory);
    if (parent === currentDirectory) return undefined;
    currentDirectory = parent;
  }
}

/** Resolve COMPOSE_KEYRING_FILE with the same external-path validation the
 * SSH keyring uses. Absent env var defaults to the conventional external
 * path; the missing FILE is a runtime 503 crypto_unavailable, not a startup
 * crash (feature stays read-only without the keyring). */
export function resolveComposeKeyringFilePath(
  envValue: string | undefined,
  config: { dataDir: string; privateDir: string },
): string {
  if (!envValue) {
    return "/etc/flexserver/compose-keyring.json";
  }
  const projectRoot =
    findProjectRoot(process.cwd()) ??
    findProjectRoot(dirname(new URL(import.meta.url).pathname));
  return validateExternalSecretPath(
    envValue,
    config.dataDir,
    config.privateDir,
    projectRoot,
  );
}
