import { describe, expect, it } from "vitest";
import { parseAppConfig } from "../src/config/app-config.js";

describe("AI context budget configuration", () => {
  it("defaults to the approved compaction budget", () => {
    const config = parseAppConfig({} as NodeJS.ProcessEnv);
    expect(config.ai).toMatchObject({
      enabled: true,
      contextWindowTokens: 128_000,
      contextWindowTokensByModel: {},
      contextReserveTokens: 20_000,
      contextTailTokens: 20_000,
      maxCumulativeTaskTokens: 1_000_000,
    });
  });

  it("preserves existing ai settings and accepts explicit overrides", () => {
    const config = parseAppConfig({
      APP_AI_ENABLED: "false",
      APP_AI_CONTEXT_WINDOW_TOKENS: "200000",
      APP_AI_CONTEXT_RESERVE_TOKENS: "30000",
      APP_AI_CONTEXT_TAIL_TOKENS: "25000",
      APP_AI_MAX_CUMULATIVE_TASK_TOKENS: "2000000",
    } as NodeJS.ProcessEnv);
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.contextWindowTokens).toBe(200_000);
    expect(config.ai.contextReserveTokens).toBe(30_000);
    expect(config.ai.contextTailTokens).toBe(25_000);
    expect(config.ai.maxCumulativeTaskTokens).toBe(2_000_000);
  });

  it("accepts the tightest legal budget", () => {
    const config = parseAppConfig({
      APP_AI_CONTEXT_WINDOW_TOKENS: "16000",
      APP_AI_CONTEXT_RESERVE_TOKENS: "2048",
      APP_AI_CONTEXT_TAIL_TOKENS: "13951",
      APP_AI_MAX_CUMULATIVE_TASK_TOKENS: "16000",
    } as NodeJS.ProcessEnv);
    expect(config.ai.contextWindowTokens - config.ai.contextReserveTokens).toBe(13_952);
  });

  it("accepts exact model window overrides", () => {
    const config = parseAppConfig({ APP_AI_CONTEXT_MODEL_WINDOWS: '{"small-model":64000,"large-model":200000}' } as NodeJS.ProcessEnv);
    expect(config.ai.contextWindowTokensByModel).toMatchObject({ "small-model": 64_000, "large-model": 200_000 });
  });

  it.each([
    { reason: "reserve below output allowance", env: { APP_AI_CONTEXT_RESERVE_TOKENS: "2047" } },
    { reason: "malformed model windows", env: { APP_AI_CONTEXT_MODEL_WINDOWS: "not-json" } },
    { reason: "model window smaller than reserve and tail", env: { APP_AI_CONTEXT_MODEL_WINDOWS: '{"small-model":16000}' } },
    { reason: "fractional model window", env: { APP_AI_CONTEXT_MODEL_WINDOWS: '{"model":64000.5}' } },
    { reason: "cumulative budget below model window", env: { APP_AI_CONTEXT_MODEL_WINDOWS: '{"model":2000000}' } },
    { reason: "reserve reaches the window", env: { APP_AI_CONTEXT_RESERVE_TOKENS: "128000" } },
    { reason: "reserve exceeds the window", env: { APP_AI_CONTEXT_RESERVE_TOKENS: "130000" } },
    { reason: "tail reaches the prompt budget", env: { APP_AI_CONTEXT_RESERVE_TOKENS: "108000", APP_AI_CONTEXT_TAIL_TOKENS: "20000" } },
    { reason: "tail exceeds the prompt budget", env: { APP_AI_CONTEXT_RESERVE_TOKENS: "110000", APP_AI_CONTEXT_TAIL_TOKENS: "20000" } },
    { reason: "cumulative budget below one full window", env: { APP_AI_MAX_CUMULATIVE_TASK_TOKENS: "127999" } },
    { reason: "non-integer window", env: { APP_AI_CONTEXT_WINDOW_TOKENS: "128000.5" } },
    { reason: "window below the floor", env: { APP_AI_CONTEXT_WINDOW_TOKENS: "15999" } },
    { reason: "negative reserve", env: { APP_AI_CONTEXT_RESERVE_TOKENS: "-1000" } },
  ])("rejects a $reason", ({ env }) => {
    expect(() => parseAppConfig(env as NodeJS.ProcessEnv)).toThrow();
  });
});
