import { manageAiKeysFromCli } from "../../packages/api/src/scripts/manage-ai-keys.js";

manageAiKeysFromCli().catch(() => {
  console.error("AI key administration failed. Verify storage ownership, task state, and the original external keyring.");
  process.exitCode = 1;
});
