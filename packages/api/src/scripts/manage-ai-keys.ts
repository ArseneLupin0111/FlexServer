import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "../config/app-config.js";
import { withAiAdminLock } from "../persistence/repositories/ai.repository.js";
import { initKeyring, rotateKeyring, validateExternalSecretPath } from "../ssh/key-encryption.js";

const USAGE = `Usage: manage-ai-keys <init|rotate|rewrap|check>
Stop the API before JSON storage administration. Never remove a live writer lock.
Keep the external AI keyring and encrypted storage backed up separately.
Rotation retains old KEKs; rewrap every retained encrypted payload before retiring a KEK.`;

export async function manageAiKeysFromCli(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(USAGE);
    return;
  }
  if (args.length !== 1 || !["init", "rotate", "rewrap", "check"].includes(args[0]!)) throw new Error(USAGE);
  const config = loadAppConfig();
  const keyringPath = config.ai.keyringFile;
  validateExternalSecretPath(keyringPath, config.dataDir, config.privateDir, process.cwd());
  const constraints = { dataDir: config.dataDir, privateDir: config.privateDir, projectRoot: process.cwd() };
  await withAiAdminLock(config, async (admin) => {
    if (args[0] === "init") {
      if (await admin.hasEncryptedFields()) throw new Error("Existing encrypted AI data requires its original keyring; initialization would orphan data.");
      await initKeyring(keyringPath, constraints);
      console.log("AI keyring initialized. Keep a separate offline recovery copy.");
      return;
    }
    const inspect = await admin.rotateEncryptedFields({ dryRun: true });
    if (inspect.conflictCode || inspect.refusedTaskIds.length) throw new Error("AI key administration refused: resolve active or uncertain tasks before retrying.");
    if (args[0] === "check") {
      console.log(`Encrypted fields evaluated: ${inspect.rewrapped}; referenced KEKs: ${inspect.kekIds.length}. No storage changes.`);
      return;
    }
    // Preserve old keys if storage rewrap fails. Resume with rewrap, not another rotation.
    if (args[0] === "rotate") await rotateKeyring(keyringPath, constraints);
    const result = await admin.rotateEncryptedFields();
    if (result.conflictCode || result.refusedTaskIds.length) throw new Error("AI rewrap refused. Existing KEKs remain available; resolve the conflict and run rewrap.");
    console.log(`AI encrypted fields rewrapped: ${result.rewrapped}. Previous KEKs retained; back up the updated keyring separately.`);
  });
}

function directlyInvoked(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase(); }
  catch { return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase(); }
}
if (directlyInvoked()) {
  manageAiKeysFromCli().catch((error: unknown) => {
    // Emit only allowlisted diagnostics, never storage/crypto messages or values.
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const safeCodes: Record<string, true> = { EACCES: true, EPERM: true, EROFS: true, ENOENT: true, ECONNREFUSED: true, "28P01": true, "42P01": true, "42501": true };
    const reason = error instanceof Error && error.message === "Existing encrypted AI data requires its original keyring; initialization would orphan data."
      ? "original_keyring_required"
      : Object.hasOwn(safeCodes, code) ? code : "unclassified";
    console.error(`AI key administration failed (${reason}). Verify storage ownership, task state, and the original external keyring.`);
    process.exitCode = 1;
  });
}
