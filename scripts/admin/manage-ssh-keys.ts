/**
 * Thin entry point for local dev (runs via `tsx scripts/admin/manage-ssh-keys.ts`).
 *
 * In production, use the compiled version:
 *   node dist/scripts/manage-ssh-keys.js <command> [options]
 *
 * The implementation lives in packages/api/src/scripts/manage-ssh-keys.ts
 * which compiles to dist/scripts/manage-ssh-keys.js during `npm run build`.
 */

import { manageSshKeysFromCli } from "../../packages/api/src/scripts/manage-ssh-keys.js";

manageSshKeysFromCli().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Failed to manage SSH keys:", message);
  process.exit(1);
});
