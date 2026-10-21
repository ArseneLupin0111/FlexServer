import { manageComposeKeysFromCli } from "../../packages/api/src/scripts/manage-compose-keys.js";

manageComposeKeysFromCli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Compose key administration failed");
  process.exitCode = 1;
});
