import "../test/setup";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiTaskStream } from "./ai-stream";

type Listener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, Set<Listener>>();
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.readyState = 2;
  }

  emit(type: string, data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    const event = new MessageEvent(type, { data: payload });
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }
}

describe("useAiTaskStream hook", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    cleanup();
    globalThis.EventSource = originalEventSource;
  });

  it("accumulates ai.message.delta stream tokens into streamingText", () => {
    const { result } = renderHook(() =>
      useAiTaskStream({ vpsId: "vps-1", taskId: "task-1" }),
    );

    expect(result.current.streamingText).toBeNull();
    const es = MockEventSource.instances[0]!;
    expect(es).toBeDefined();

    act(() => {
      es.emit("ai.message.delta", { taskId: "task-1", delta: "Hello " });
    });
    expect(result.current.streamingText).toBe("Hello ");

    act(() => {
      es.emit("ai.message.delta", { taskId: "task-1", delta: "world!" });
    });
    expect(result.current.streamingText).toBe("Hello world!");
  });

  it("replaces streamingText when full text or reset is received", () => {
    const { result } = renderHook(() =>
      useAiTaskStream({ vpsId: "vps-1", taskId: "task-1" }),
    );

    const es = MockEventSource.instances[0]!;
    act(() => {
      es.emit("ai.message.delta", { taskId: "task-1", text: "Initial snapshot text" });
    });
    expect(result.current.streamingText).toBe("Initial snapshot text");

    act(() => {
      es.emit("ai.message.delta", { taskId: "task-1", reset: true });
    });
    expect(result.current.streamingText).toBe("");
  });

  it("replays authoritative initial text for reconnect/late-join even if reset is flagged", () => {
    const { result } = renderHook(() =>
      useAiTaskStream({ vpsId: "vps-1", taskId: "task-1" }),
    );

    const es = MockEventSource.instances[0]!;
    // Simulate reconnect frame with authoritative accumulated text
    act(() => {
      es.emit("ai.message.delta", { taskId: "task-1", text: "Recovered partial answer", reset: true });
    });
    expect(result.current.streamingText).toBe("Recovered partial answer");
  });

  it("resets streamingText when taskId changes or clearOutput is called", () => {
    let currentTaskId = "task-1";
    const { result, rerender } = renderHook(() =>
      useAiTaskStream({ vpsId: "vps-1", taskId: currentTaskId }),
    );

    const es1 = MockEventSource.instances[0]!;
    act(() => {
      es1.emit("ai.message.delta", { taskId: "task-1", delta: "Running inspection..." });
    });
    expect(result.current.streamingText).toBe("Running inspection...");

    // Task change
    currentTaskId = "task-2";
    rerender();
    expect(result.current.streamingText).toBeNull();

    const es2 = MockEventSource.instances[1]!;
    act(() => {
      es2.emit("ai.message.delta", { taskId: "task-2", delta: "New task text" });
    });
    expect(result.current.streamingText).toBe("New task text");

    // Manual clear
    act(() => {
      result.current.clearOutput();
    });
    expect(result.current.streamingText).toBeNull();
  });
});
