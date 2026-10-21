import { describe, expect, it } from "vitest";
import { AiRetentionService } from "../src/ai/ai-retention.service.js";

describe("AI startup recovery", () => {
  it("keeps bootstrap pending until retention writes finish", async () => {
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const pendingWrite = new Promise<void>(resolve => { release = resolve; });
    const service = new AiRetentionService(
      { mode: "local" } as never,
      {
        deleteTerminalTasksOlderThan: async () => {
          entered();
          await pendingWrite;
          return 0;
        },
        deleteExpiredExecutionBlobs: async () => 0,
      } as never,
      { list: async () => [] } as never,
      {} as never,
    );
    let ready = false;
    const bootstrap = Promise.resolve(service.onApplicationBootstrap()).then(() => { ready = true; });
    try {
      await writing;
      await Promise.resolve();
      expect(ready).toBe(false);
      release();
      await bootstrap;
      expect(service.getHealth()).toMatchObject({ status: "healthy", runs: 1 });
    } finally {
      release();
      await bootstrap;
      await service.onApplicationShutdown();
    }
  });
});
