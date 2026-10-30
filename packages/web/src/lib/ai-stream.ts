// ── Dedicated AI Assistant SSE Stream Client ───────────────────────────
//
// Matches local://ai-wire-contract.md §15 and plan §8.4:
// GET /api/vps/:id/ai/tasks/:taskId/events
// Bounded ephemeral output ring buffer, no replay promises,
// authoritative snapshot re-fetched on reconnect.
// Safe text rendering: no execution of HTML or terminal escapes.

import { useEffect, useRef, useState, useCallback } from "react";
import { ApiError } from "./api";
import {
  getVpsAiTask,
  type AiPlan,
  type AiPlanStep,
  type AiTask,
  type AiTaskUsage,
} from "./ai-api";

export type AiStreamState = "idle" | "connecting" | "live" | "closed" | "error";

export type AiOutputChunk = {
  id: string;
  text: string;
  isGap?: boolean;
  truncated?: boolean;
  timestamp: string;
};

export type UseAiTaskStreamOptions = {
  vpsId: string;
  taskId: string | null;
  enabled?: boolean;
  onSnapshot?: (task: AiTask) => void;
  onPlanUpdate?: (plan: AiPlan) => void;
  onStepUpdate?: (step: AiPlanStep) => void;
  onUsageUpdate?: (usage: AiTaskUsage) => void;
};

const MAX_OUTPUT_CHUNKS = 500;
const MAX_TOTAL_OUTPUT_CHARS = 128 * 1024; // 128 KiB memory cap
const MAX_SINGLE_CHUNK_CHARS = 32 * 1024; // 32 KiB cap per single chunk
export function useAiTaskStream({
  vpsId,
  taskId,
  enabled = true,
  onSnapshot,
  onPlanUpdate,
  onStepUpdate,
  onUsageUpdate,
}: UseAiTaskStreamOptions) {
  const [streamState, setStreamState] = useState<AiStreamState>("idle");
  const [outputChunks, setOutputChunks] = useState<AiOutputChunk[]>([]);
  const [hasGap, setHasGap] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const activeRef = useRef<{ vpsId: string; taskId: string | null }>({
    vpsId,
    taskId,
  });
  const totalCharsRef = useRef(0);

  activeRef.current = { vpsId, taskId };

  const callbacksRef = useRef({
    onSnapshot,
    onPlanUpdate,
    onStepUpdate,
    onUsageUpdate,
  });
  callbacksRef.current = {
    onSnapshot,
    onPlanUpdate,
    onStepUpdate,
    onUsageUpdate,
  };
  const appendChunk = useCallback((chunk: {
    text: string;
    isGap?: boolean;
    truncated?: boolean;
  }) => {
    let text = chunk.text;
    let truncated = chunk.truncated ?? false;
    if (text.length > MAX_SINGLE_CHUNK_CHARS) {
      text = text.slice(0, MAX_SINGLE_CHUNK_CHARS);
      truncated = true;
      setIsTruncated(true);
    }
    if (truncated) {
      setIsTruncated(true);
    }

    setOutputChunks((prev) => {
      totalCharsRef.current += text.length;
      const nextItem: AiOutputChunk = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text,
        isGap: chunk.isGap,
        truncated,
        timestamp: new Date().toLocaleTimeString(),
      };
      const combined = [...prev, nextItem];
      while (
        combined.length > MAX_OUTPUT_CHUNKS ||
        totalCharsRef.current > MAX_TOTAL_OUTPUT_CHARS
      ) {
        const removed = combined.shift();
        if (removed) {
          totalCharsRef.current -= removed.text.length;
          setIsTruncated(true);
        }
      }
      return combined;
    });
  }, []);

  const clearOutput = useCallback(() => {
    totalCharsRef.current = 0;
    setOutputChunks([]);
    setHasGap(false);
    setIsTruncated(false);
  }, []);

  const connect = useCallback(() => {
    if (!taskId || !vpsId || !enabled) {
      setStreamState("idle");
      return;
    }

    const isActive = () =>
      activeRef.current.vpsId === vpsId && activeRef.current.taskId === taskId;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setStreamState("connecting");

    // Fetch authoritative snapshot immediately upon connecting or reconnecting
    // Durable snapshots are memory-only; no raw script payloads are persisted to browser storage.
    getVpsAiTask(vpsId, taskId)
      .then((task) => {
        if (isActive() && callbacksRef.current.onSnapshot) {
          callbacksRef.current.onSnapshot(task);
        }
      })
      .catch((err: unknown) => {
        if (!isActive()) return;
        // Disconnect and close immediately on auth loss (session expiry / 401 / 403)
        const isAuthLoss =
          err instanceof ApiError &&
          (err.payload?.error === "UNAUTHORIZED" ||
            err.payload?.code === "UNAUTHORIZED" ||
            err.payload?.code === "FORBIDDEN" ||
            err.message.toLowerCase().includes("unauthorized") ||
            err.message.toLowerCase().includes("session expired") ||
            err.message.includes("401") ||
            err.message.includes("403"));
        if (isAuthLoss) {
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          setStreamState("closed");
          return;
        }
      });
    const url = `/api/vps/${encodeURIComponent(vpsId)}/ai/tasks/${encodeURIComponent(taskId)}/events`;
    const source = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = source;

    source.onopen = () => {
      if (isActive()) {
        setStreamState("live");
      }
    };

    const handleSnapshot = (event: MessageEvent) => {
      if (!isActive()) return;
      try {
        const data = JSON.parse(event.data) as AiTask;
        if (data && data.id === taskId && callbacksRef.current.onSnapshot) {
          callbacksRef.current.onSnapshot(data);
        }
      } catch {
        // Malformed frame ignored
      }
    };

    const handleStepUpdate = (event: MessageEvent) => {
      if (!isActive()) return;
      try {
        const data = JSON.parse(event.data) as {
          taskId?: string;
          step?: AiPlanStep;
          plan?: AiPlan;
          task?: AiTask;
        } & Partial<AiPlanStep>;
        if (data.task && callbacksRef.current.onSnapshot) {
          callbacksRef.current.onSnapshot(data.task);
        } else if (data.plan && callbacksRef.current.onPlanUpdate) {
          callbacksRef.current.onPlanUpdate(data.plan);
        } else if (data.step && callbacksRef.current.onStepUpdate) {
          callbacksRef.current.onStepUpdate(data.step);
        } else if (data.stepId && callbacksRef.current.onStepUpdate) {
          callbacksRef.current.onStepUpdate(data as AiPlanStep);
        }
      } catch {
        // Malformed frame ignored
      }
    };

    const handleApprovalRequired = (event: MessageEvent) => {
      if (!isActive()) return;
      try {
        const data = JSON.parse(event.data) as AiPlan;
        if (data && callbacksRef.current.onPlanUpdate) {
          callbacksRef.current.onPlanUpdate(data);
        }
      } catch {
        // Malformed frame ignored
      }
    };

    const handleOutputChunk = (event: MessageEvent) => {
      if (!isActive()) return;
      try {
        const data = JSON.parse(event.data) as {
          chunk?: string;
          text?: string;
          gap?: boolean;
          isGap?: boolean;
          truncated?: boolean;
        };
        const text = data.chunk ?? data.text ?? "";
        const isGap = Boolean(data.gap ?? data.isGap);
        const truncated = Boolean(data.truncated);
        if (isGap) setHasGap(true);
        if (truncated) setIsTruncated(true);
        if (text) {
          appendChunk({
            text,
            isGap,
            truncated,
          });
        }
      } catch {
        // Malformed frame ignored
      }
    };

    const handleOutputGap = () => {
      if (!isActive()) return;
      setHasGap(true);
      appendChunk({
        text: "[Notice: Output gap detected. Some stream lines dropped due to rate/buffer bounds.]",
        isGap: true,
      });
    };

    const handleUsageUpdated = (event: MessageEvent) => {
      if (!isActive()) return;
      try {
        const data = JSON.parse(event.data) as AiTaskUsage;
        if (data && callbacksRef.current.onUsageUpdate) {
          callbacksRef.current.onUsageUpdate(data);
        }
      } catch {
        // Malformed frame ignored
      }
    };

    const handleClosed = () => {
      if (!isActive()) return;
      setStreamState("closed");
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };

    // Register canonical wire event names only (no legacy aliases)
    source.addEventListener("ai.task.snapshot", handleSnapshot);
    source.addEventListener("ai.task.updated", handleSnapshot);
    source.addEventListener("ai.step.updated", handleStepUpdate);
    source.addEventListener("ai.approval.required", handleApprovalRequired);
    source.addEventListener("ai.output.chunk", handleOutputChunk);
    source.addEventListener("ai.output.gap", handleOutputGap);
    source.addEventListener("ai.usage.updated", handleUsageUpdated);
    source.addEventListener("ai.stream.closed", handleClosed);

    source.onerror = () => {
      if (!isActive()) return;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setStreamState("error");
      // Immediately verify if stream error was triggered by session loss / 401 / 403
      getVpsAiTask(vpsId, taskId).catch((err: unknown) => {
        if (!isActive()) return;
        const isAuthLoss =
          err instanceof ApiError &&
          (err.payload?.error === "UNAUTHORIZED" ||
            err.payload?.code === "UNAUTHORIZED" ||
            err.payload?.code === "FORBIDDEN" ||
            err.message.toLowerCase().includes("unauthorized") ||
            err.message.toLowerCase().includes("session expired") ||
            err.message.includes("401") ||
            err.message.includes("403"));
        if (isAuthLoss) {
          setStreamState("closed");
        }
      });
    };
  }, [vpsId, taskId, enabled, appendChunk]);
  useEffect(() => {
    clearOutput();
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [vpsId, taskId, enabled, connect, clearOutput]);

  return {
    streamState,
    outputChunks,
    hasGap,
    isTruncated,
    clearOutput,
    reconnect: connect,
  };
}
