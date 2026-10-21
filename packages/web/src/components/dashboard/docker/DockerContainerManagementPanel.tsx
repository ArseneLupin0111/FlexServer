import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import type {
  DockerManagementAction,
  DockerManagementCapability,
  DockerManagementOperation,
  DockerManagementTarget,
} from "../../../lib/api";
import {
  getVpsDockerManagementCapability,
  getVpsDockerManagementOperation,
  requestVpsDockerContainerAction,
} from "../../../lib/api";
import {
  subscribeDockerContainerLogs,
  type DockerLogErrorCode,
  type DockerLogLine,
} from "../../../lib/docker-logs";

type OperationState = {
  operation: DockerManagementOperation | null;
  checking: boolean;
  requestBusy: boolean;
  error: string | null;
};

/** One container identity: the pair, never the key alone. */
export type TargetPair = {
  agentInstanceId: string;
  containerKey: string;
};

/**
 * Viewer lifecycle. `waiting`/`live` come from the backend; every other
 * state is the viewer's own accounting of a stream it owns.
 */
type StreamStatus =
  | "waiting"
  | "live"
  | "stopped"
  | "disconnected"
  | "completed"
  | "expired"
  | "failed";

/** Backend window: the source always reopens with this many lines. */
const BACKEND_TAIL_LINES = 200;
/** Display buffer bound: dropped from the oldest end, never unbounded. */
const MAX_DISPLAY_LINES = 2000;
const MAX_DISPLAY_BYTES = 1024 * 1024;
/** Pending batches render at most this often, so bursts never thrash React. */
const DISPLAY_BATCH_MS = 100;
/** Auto-scroll only holds while the reader is this close to the tail. */
const AUTO_SCROLL_SLACK_PX = 24;

/** Safe codes only; never echoes a daemon body to the user. */
const STREAM_ERROR_COPY: Record<DockerLogErrorCode, string> = {
  container_not_found:
    "This container is no longer in the server's current inventory.",
  target_mismatch:
    "The selected container did not match the server's current inventory.",
  daemon_unreachable:
    "The Docker daemon on this server could not be reached.",
  logs_unavailable:
    "Container logs are unavailable right now. The policy or source may have changed.",
  invalid_docker_stream:
    "The Docker log stream ended in an unusable state.",
  agent_unavailable:
    "No agent claimed this stream. The agent may still be starting up.",
  stream_lost:
    "The log stream stopped sending data and was closed.",
  slow_consumer:
    "The log stream was closed because this browser could not keep up.",
  session_expired:
    "Your dashboard session expired, so the log stream was closed.",
};

function targetPairOf(target: DockerManagementTarget): TargetPair | null {
  // Targets without an agent instance cannot be streamed: the viewer needs
  // the pair, and the key alone is never a valid identity.
  if (typeof target.agentInstanceId !== "string") return null;
  return {
    agentInstanceId: target.agentInstanceId,
    containerKey: target.containerKey,
  };
}

function samePair(a: TargetPair | null, b: TargetPair | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.agentInstanceId === b.agentInstanceId && a.containerKey === b.containerKey
  );
}

/**
 * The target this panel may subscribe to right now.
 *
 * Derived during render instead of in an effect: a refresh tick that lands
 * between the capability response and the next paint must not leave an
 * unsubscribable target on screen, and React re-renders immediately when
 * the returned pair differs, so the effect below never sees a stale value.
 *
 * With `fixedTarget` the container identity is already decided by the route.
 * There is then no browsing: the panel either serves exactly that pair or
 * serves nothing. Falling back to "the first target" would silently point a
 * page titled with one container at a different container's logs and
 * controls, so a missing or stale pair resolves to `null`.
 */
function selectScope(
  targetPair: TargetPair | null,
  containers: DockerManagementTarget[],
  fixedTarget: TargetPair | null,
): TargetPair | null {
  if (fixedTarget) {
    const present = containers.some(
      (target) =>
        target.agentInstanceId === fixedTarget.agentInstanceId &&
        target.containerKey === fixedTarget.containerKey,
    );
    if (!present) return null;
    return samePair(targetPair, fixedTarget) ? targetPair : fixedTarget;
  }
  if (containers.length === 0) return null;
  // The backend projects snapshots + metrics rows; fixtures can report the
  // same identity twice (differing only in name/image). Dedupe by pair so
  // the dropdown never renders duplicate keys for one stream identity.
  const seen = new Set<string>();
  const pairs: TargetPair[] = [];
  for (const target of containers) {
    const pair = targetPairOf(target);
    if (pair === null) continue;
    const key = pairValue(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
  }
  if (targetPair !== null && pairs.some((pair) => samePair(pair, targetPair))) {
    return targetPair;
  }
  return pairs.length > 0 ? pairs[0] : null;
}

function pairValue(pair: TargetPair): string {
  // The opaque charset has no separator characters, so this is unambiguous.
  return `${pair.agentInstanceId}::${pair.containerKey}`;
}

function parsePairValue(value: string): TargetPair | null {
  const separator = value.indexOf("::");
  if (separator <= 0) return null;
  const agentInstanceId = value.slice(0, separator);
  const containerKey = value.slice(separator + 2);
  if (!agentInstanceId || !containerKey) return null;
  return { agentInstanceId, containerKey };
}

const byteCounter = new TextEncoder();

/**
 * The viewer buffer and the byte total that bounds it. The byte total is
 * tracked on append so a render never re-encodes the whole window just to
 * print a count, and `discarded` rides along so the notice is published
 * with exactly the lines it describes.
 */
type DisplayBuffer = {
  lines: DockerLogLine[];
  bytes: number;
  /** Rendered line count, kept next to the byte total it shares a bound with. */
  count: number;
  discarded: boolean;
};

/**
 * Shared empty buffer. Lines are never mutated in place — every append
 * builds a new array — so one constant can back every reset.
 */
const EMPTY_BUFFER: DisplayBuffer = { lines: [], bytes: 0, count: 0, discarded: false };

/**
 * Appends to the buffer and drops the globally oldest lines until both
 * bounds hold. Eviction runs on the logical stream, so what the reader can
 * ever see is decided by delivery order and never by when a render
 * happens. A single line longer than the byte bound is kept rather than
 * dropping everything; the wire contract caps lines far below that bound.
 */
function appendBounded(
  buffer: DisplayBuffer,
  incoming: DockerLogLine[],
): DisplayBuffer {
  const lines = buffer.lines.concat(incoming);
  let bytes = buffer.bytes;
  for (const line of incoming) bytes += byteCounter.encode(line.text).length;
  let start = 0;
  while (
    start < lines.length &&
    (lines.length - start > MAX_DISPLAY_LINES || bytes > MAX_DISPLAY_BYTES)
  ) {
    bytes -= byteCounter.encode(lines[start].text).length;
    start += 1;
  }
  // The notice is sticky: once lines have been discarded, later appends
  // that do not evict must not make the warning disappear.
  const kept = start === 0 ? lines : lines.slice(start);
  return {
    lines: kept,
    bytes,
    count: kept.length,
    discarded: buffer.discarded || start > 0,
  };
}

/**
 * Docker container management (P4) with a realtime log viewer.
 *
 * - Capability/target display is explicit; controls stay disabled until both
 *   capability and a container target resolve.
 * - Start/stop/restart always confirm via AlertDialog; Cancel closes the
 *   dialog and makes no API call.
 * - No optimistic state: container rows are never edited locally; only the
 *   operation result/status is shown.
 * - Logs are an ephemeral SSE viewer: the last 200 lines, then live. The
 *   viewer owns its buffer, its reconnect, and its scroll position.
 */
export function DockerContainerManagementPanel({
  vpsId,
  enabled,
  refreshTick = 0,
  fixedTarget = null,
}: {
  vpsId: string;
  /** Opt-in for mutations only; read-only logs use capability.logsSupported. */
  enabled: boolean;
  /** Capability reload tick from the workspace monitoring refresh. */
  refreshTick?: number;
  /**
   * When set, the panel is a detail view for exactly this container: the
   * target selector disappears, the panel never falls back to another
   * container, and a stale or missing identity reports the container as
   * unavailable instead of streaming someone else's logs.
   */
  fixedTarget?: TargetPair | null;
}) {
  const [capability, setCapability] =
    useState<DockerManagementCapability | null>(null);
  // Capability gates the read-only log viewer even when management is
  // disabled, so it is always fetched.
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [targetPair, setTargetPair] = useState<TargetPair | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: DockerManagementAction; target: TargetPair; name: string; vpsId: string } | null>(null);
  const actionLock = useRef(false);
  const actionScope = useRef({ vpsId, pair: targetPair });
  actionScope.current = { vpsId, pair: targetPair };
  const [operationState, setOperationState] = useState<OperationState>({
    operation: null,
    checking: false,
    requestBusy: false,
    error: null,
  });

  // ── Log viewer state ───────────────────────────────────────────────
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const [streamErrorCode, setStreamErrorCode] =
    useState<DockerLogErrorCode | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  /** Stop keeps the buffer and closes the source; reconnect reopens it. */
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [logQuery, setLogQuery] = useState("");
  const [logStream, setLogStream] = useState("all");

  const containers = capability?.targets ?? [];
  const selected = targetPair
    ? (containers.find(
        (item) =>
          item.agentInstanceId === targetPair.agentInstanceId &&
          item.containerKey === targetPair.containerKey,
      ) ?? null)
    : null;
  const logsSupported = capability?.logsSupported === true;
  const canStream = logsSupported && streamEnabled && selected !== null;
  useEffect(() => {
    setLogQuery("");
    setLogStream("all");
  }, [vpsId, selected?.agentInstanceId, selected?.containerKey]);

  const preRef = useRef<HTMLPreElement | null>(null);
  /**
   * The one authoritative buffer: the staged lines and the byte total that
   * bounds them. Appends land here immediately and are bounded here
   * immediately, so there is never a second staging queue that could hold
   * lines the display bound already discarded.
   */
  const bufferRef = useRef<DisplayBuffer>(EMPTY_BUFFER);
  /** Lines as last published to React; `null` until the first publish. */
  const [published, setPublished] = useState<DisplayBuffer | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  /**
   * Reader was at the tail before this append. A ref guards the layout
   * effect without re-subscribing it; the state copy drives the
   * "Jump to latest" affordance.
   */
  const stickToTailRef = useRef(true);
  const [atTail, setAtTail] = useState(true);

  // ── Capability load (retry + monitoring refresh tick) ──────────────
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // The first load has nothing to show yet, so it gates the viewer. A
    // refresh (tick or retry) keeps whatever is already rendered: swapping
    // the log viewport out for a loading branch would remount the <pre>
    // and throw away the reader's scroll position mid-stream.
    setCapabilityLoading(capability === null);
    setCapabilityError(null);
    getVpsDockerManagementCapability(vpsId, controller.signal)
      .then((result) => {
        if (cancelled) return;
        setCapability(result);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        // A refresh failure must not wipe a working viewer: the last good
        // capability stays until the next tick supplies a replacement.
        if (capability === null) setCapability(null);
        setCapabilityError(
          err instanceof Error
            ? err.message
            : "Container management is unavailable right now.",
        );
      })
      .finally(() => {
        if (!cancelled) setCapabilityLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vpsId, enabled, capabilityRetry, refreshTick]);

  // ── Target selection: always a live (agentInstanceId, containerKey) pair
  // In list mode a pair that left the inventory is replaced by the first
  // valid target. With a route-fixed target, a stale or missing pair
  // resolves to null so the page reports its own container as unavailable.
  const scopedPair = selectScope(targetPair, containers, fixedTarget);
  if (scopedPair !== targetPair) {
    setTargetPair(scopedPair);
  }

  useEffect(() => {
    if (pendingAction && (pendingAction.vpsId !== vpsId || !samePair(pendingAction.target, scopedPair) || !enabled || capabilityError || !capability?.supported || !capability.actions.includes(pendingAction.action))) {
      setPendingAction(null);
    }
  }, [vpsId, scopedPair, enabled, capability, capabilityError, pendingAction]);

  // Scope changes never leak operation status into another target.
  useEffect(() => {
    if (!enabled) {
      setPendingAction(null);
      setOperationState({
        operation: null,
        checking: false,
        requestBusy: false,
        error: null,
      });
    }
  }, [enabled]);

  // ── Viewer buffer: one authoritative, bounded ref plus a render tick ─
  // The single bounded buffer is the only source of truth. Appends evict
  // the oldest lines of the logical stream immediately — eviction decides
  // what is real, so it must not depend on when a render happens, and there
  // must not be a second queue whose own budget evicts lines before they
  // were ever shown.
  //
  // React state is only a publication of that buffer: at most one render
  // per DISPLAY_BATCH_MS, so a burst never thrashes the viewport. The
  // discard notice travels inside the published buffer, so it can never
  // describe a different window than the lines next to it.
  const publishBuffer = useCallback(() => {
    flushTimerRef.current = null;
    // A timer is armed only after an append and cleared on every scope
    // reset, so a fire always has a fresh array to publish. React bails
    // out when the reference is unchanged, so an empty publish is free.
    setPublished(bufferRef.current);
  }, []);

  const appendLines = useCallback(
    (incoming: DockerLogLine[]) => {
      if (incoming.length === 0) return;
      // Bounded on the logical stream the moment the lines arrive; the
      // flush below only decides when React sees the same array.
      bufferRef.current = appendBounded(bufferRef.current, incoming);
      if (flushTimerRef.current !== null) return;
      flushTimerRef.current = window.setTimeout(publishBuffer, DISPLAY_BATCH_MS);
    },
    [publishBuffer],
  );

  /**
   * Drops the whole buffer and any timer armed against it. Used by a scope
   * change (the old window must not survive into a new target) and by
   * Reconnect (a fresh window reopens from the backend tail), and served to
   * Clear so "clear" only drops the display buffer: the subscription is
   * untouched, so lines emitted after it still arrive and append to the
   * emptied buffer.
   */
  const resetBuffer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    bufferRef.current = EMPTY_BUFFER;
    setPublished(null);
  }, []);

  // ── Scope reset: independent of subscription eligibility ───────────
  // Runs for every scope change, including while the viewer is stopped:
  // the previous container's buffer must never stay on screen under a
  // new target label, and a new pair must always auto-subscribe.
  useEffect(() => {
    resetBuffer();
    setStreamStatus("waiting");
    setStreamErrorCode(null);
    setStreamEnabled(true);
    stickToTailRef.current = true;
    setAtTail(true);
  }, [vpsId, selected?.agentInstanceId, selected?.containerKey, reconnectCount]);

  // ── Ephemeral viewer: primitive deps only ───────────────────────────
  // The capability object and the refresh tick are deliberately absent: a
  // capability reload that keeps the same target must not reopen a stream,
  // and a refresh tick must never tear down a live subscription.
  useEffect(() => {
    // Narrowed here rather than cast: a target that lost its agent instance
    // mid-refresh must not open a viewer with an undefined identity.
    const agentInstanceId = selected?.agentInstanceId;
    if (!canStream || !selected || typeof agentInstanceId !== "string") return;
    const pair: TargetPair = {
      agentInstanceId,
      containerKey: selected.containerKey,
    };

    let disposed = false;

    const unsubscribe = subscribeDockerContainerLogs(vpsId, pair, {
      onState: (status) => {
        if (disposed) return;
        setStreamStatus(status);
      },
      onLines: (lines) => {
        if (disposed) return;
        appendLines(lines);
      },
      onClosed: (event) => {
        if (disposed) return;
        setStreamStatus(
          event.reason === "completed"
            ? "completed"
            : event.reason === "expired"
              ? "expired"
              : "failed",
        );
        setStreamErrorCode(event.errorCode ?? null);
      },
      onError: () => {
        if (disposed) return;
        setStreamStatus("disconnected");
      },
    });

    return () => {
      disposed = true;
      // Tear down the source, not the buffer: Stop keeps what the reader
      // has on screen, and the scope reset below owns clearing it. Only the
      // pending publish is dropped, so a timer armed for the retired
      // viewer cannot publish into the next one.
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vpsId, canStream, selected?.agentInstanceId, selected?.containerKey, reconnectCount]);

  // Auto-scroll only while the reader stayed at the tail before the append.
  useLayoutEffect(() => {
    const element = preRef.current;
    if (!element || !stickToTailRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [published]);

  const buffer = published ?? EMPTY_BUFFER;
  const visibleLines = useMemo(() => {
    const query = logQuery.toLowerCase();
    return buffer.lines.filter((line) =>
      (logStream === "all" || line.stream === logStream) &&
      line.text.toLowerCase().includes(query),
    );
  }, [buffer.lines, logQuery, logStream]);

  const submitAction = async (action: DockerManagementAction, target: TargetPair): Promise<void> => {
    if (actionLock.current || !enabled || capabilityError || !capability?.supported || !selected || !samePair(target, scopedPair) || !capability.actions.includes(action)) return;
    actionLock.current = true;
    setOperationState((prev) => ({
      ...prev,
      requestBusy: true,
      error: null,
    }));
    try {
      const result = await requestVpsDockerContainerAction(
        vpsId,
        target,
        action,
      );
      if (actionScope.current.vpsId !== vpsId || !samePair(actionScope.current.pair, target)) return;
      setOperationState({
        operation: result,
        checking: false,
        requestBusy: false,
        error: null,
      });
    } catch (err) {
      if (actionScope.current.vpsId !== vpsId || !samePair(actionScope.current.pair, target)) return;
      setOperationState((prev) => ({
        ...prev,
        requestBusy: false,
        error:
          err instanceof Error
            ? err.message
            : "Unable to start this container operation.",
      }));
    } finally {
      actionLock.current = false;
      setOperationState((prev) => ({ ...prev, requestBusy: false }));
      // No optimistic container update; dialog closes and status is
      // checked manually below.
      setPendingAction(null);
    }
  };

  const checkOperationStatus = async () => {
    const current = operationState.operation;
    if (!current || operationState.checking) return;
    setOperationState((prev) => ({ ...prev, checking: true, error: null }));
    try {
      const result = await getVpsDockerManagementOperation(vpsId, current.id);
      setOperationState((prev) => ({
        ...prev,
        operation: result,
        checking: false,
      }));
    } catch (err) {
      // Keep the last known operation but surface unknown freshness.
      setOperationState((prev) => ({
        ...prev,
        checking: false,
        error:
          err instanceof Error
            ? `Operation status is unknown right now: ${err.message}`
            : "Operation status is unknown right now.",
      }));
    }
  };

  const stopStream = () => {
    // The subscription cleanup closes the source; status is local only.
    setStreamEnabled(false);
    setStreamErrorCode(null);
    setStreamStatus("stopped");
  };

  const reconnectStream = () => {
    setStreamEnabled(true);
    setStreamErrorCode(null);
    setReconnectCount((n) => n + 1);
  };

  const jumpToLatest = () => {
    const element = preRef.current;
    stickToTailRef.current = true;
    setAtTail(true);
    if (element) element.scrollTop = element.scrollHeight;
  };

  if (capabilityLoading) {
    return (
      <section
        aria-label="Docker container management"
        aria-busy="true"
        className="border border-line bg-panel"
      >
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">Container management</h3>
        </header>
        <div className="p-4">
          <p className="text-[12px] text-dim">
            Checking container management capability…
          </p>
        </div>
      </section>
    );
  }

  if (capabilityError || !capability) {
    return (
      <section
        aria-label="Docker container management"
        className="border border-line bg-panel"
      >
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">Container management</h3>
        </header>
        <div className="p-4">
          <p className="text-[12px] text-text">
            Container management status is unknown right now.
          </p>
          {capabilityError ? (
            <p className="mt-1 text-[11px] text-dim">{capabilityError}</p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => setCapabilityRetry((n) => n + 1)}
          >
            Retry capability check
          </Button>
        </div>
      </section>
    );
  }

  if (!capability.supported && !logsSupported) {
    return (
      <section
        aria-label="Docker container management"
        className="border border-line bg-panel"
      >
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">Container management</h3>
        </header>
        <div className="p-4">
          <p className="text-[12px] text-text">
            Container logs and controls are unavailable for this server.
          </p>
          {capability.reason ? (
            <p className="mt-1 text-[11px] text-dim">{capability.reason}</p>
          ) : null}
        </div>
      </section>
    );
  }

  const visibleOperation =
    operationState.operation &&
    operationState.operation.target.containerKey ===
      targetPair?.containerKey &&
    operationState.operation.target.agentInstanceId ===
      targetPair?.agentInstanceId
      ? operationState.operation
      : null;

  const streamOpen = streamStatus === "waiting" || streamStatus === "live";
  const streamLabel =
    streamStatus === "waiting"
      ? // "Waiting for agent" must only be claimed for a scope that can
        // actually subscribe. With no live target the viewer is idle, not
        // waiting on an agent that will never arrive.
        canStream
        ? "Waiting for agent"
        : "Idle"
      : streamStatus === "live"
        ? "Live"
        : streamStatus === "stopped"
          ? "Stopped"
          : streamStatus === "disconnected"
            ? "Disconnected"
            : streamStatus === "completed"
              ? "Completed"
              : streamStatus === "expired"
                ? "Expired"
                : streamStatus === "failed"
                  ? "Failed"
                  : "Idle";

  return (
    <section
      aria-label={
        fixedTarget
          ? "Docker container detail"
          : "Docker container management"
      }
      className="min-w-0 border border-line bg-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="text-[15px] font-semibold">
          {fixedTarget ? "Container detail" : "Container investigation"}
        </h3>
        <p className="text-[12px] text-dim">Logs: {logsSupported ? `${BACKEND_TAIL_LINES} lines + live` : "unavailable"}{!enabled || !capability.supported ? " · Controls disabled" : ""}</p>
      </header>

      <div className="min-w-0 p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            {fixedTarget ? (
              <>
                {selected ? (
                  <>
                    <p className="truncate text-[12px] font-medium text-text">
                      {selected.name}
                    </p>
                    <p className="mt-1 truncate text-[11px] text-dim" title={selected.image}>
                      key {selected.containerKey} · {selected.image} ·{" "}
                      <span data-container-state={selected.state} className="docker-container-state">{selected.state}</span>
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] text-crit" role="status">
                    This container is not reported in the server's current
                    inventory.
                  </p>
                )}
              </>
            ) : null}
            {!fixedTarget ? (
            <>
            <label
              className="mb-1 block text-[11px] text-dim"
              htmlFor={`docker-management-target-${vpsId}`}
            >
              Target container
            </label>
            <select
              id={`docker-management-target-${vpsId}`}
              value={targetPair ? pairValue(targetPair) : ""}
              onChange={(event) => {
                const next = parsePairValue(event.target.value);
                setTargetPair(next);
              }}
              className="h-10 w-full min-w-0 border border-line bg-ink px-3 text-[13px] text-text transition-colors duration-160 ease-out focus:border-signal focus:outline-none"
            >
              {targetPair === null ? (
                <option value="">No container reported…</option>
              ) : null}
              {(() => {
                const seen = new Set<string>();
                const unique: TargetPair[] = [];
                for (const item of containers) {
                  const pair = targetPairOf(item);
                  if (pair === null) continue;
                  const key = pairValue(pair);
                  if (seen.has(key)) continue;
                  seen.add(key);
                  unique.push(pair);
                }
                return unique.map((pair) => (
                  <option key={pairValue(pair)} value={pairValue(pair)}>
                    {containers.find(
                      (item) =>
                        item.agentInstanceId === pair.agentInstanceId &&
                        item.containerKey === pair.containerKey,
                    )?.name ?? pair.containerKey}{" "}
                    ·
                  </option>
                ));
              })()}
            </select>
            {selected ? (
              <p className="mt-2 break-words text-[12px] leading-relaxed text-dim">
                Target: {selected.name} · key {selected.containerKey} ·{" "}
                {selected.image} · <span data-container-state={selected.state} className="docker-container-state">{selected.state}</span>
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-dim">
                No container has been reported for this server yet, so there is
                nothing to stream.
              </p>
            )}
            </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {(["start", "stop", "restart"] as DockerManagementAction[]).map(
              (action) => (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant={action === "stop" ? "destructive" : "secondary"}
                  className="capitalize"
                  disabled={
                    !enabled ||
                    !capability.supported ||
                    !selected ||
                    operationState.requestBusy ||
                    operationState.checking ||
                    !capability.actions.includes(action)
                  }
                  onClick={() => {
                    const target = selected && targetPairOf(selected);
                    if (!target || !selected) return;
                    if (action === "start") void submitAction(action, target);
                    else setPendingAction({ action, target, name: selected.name, vpsId });
                  }}
                >
                  {action}
                </Button>
              ),
            )}
          </div>
        </div>

        <div
          aria-live="polite"
          className="mt-3 border border-line bg-panel p-3 transition-colors duration-160 ease-out hover:bg-raised/40"
        >
          <p className="text-[11px] font-medium text-text">
            Operation status:{" "}
            {operationState.error && !visibleOperation
              ? "unknown"
              : (visibleOperation?.status ?? "none")}
          </p>
          {visibleOperation ? (
            <>
              <p className="mt-1 text-[11px] text-dim">
                {visibleOperation.action} ·{" "}
                {visibleOperation.target.containerKey} · requested{" "}
                {new Date(visibleOperation.createdAt).toLocaleString()}
                {visibleOperation.updatedAt
                  ? ` · updated ${new Date(visibleOperation.updatedAt).toLocaleString()}`
                  : ""}
              </p>
              {visibleOperation.status === "failed" &&
              visibleOperation.result?.message ? (
                <p role="alert" className="mt-1 text-[11px] text-crit">
                  {visibleOperation.result.message}
                </p>
              ) : null}
              {visibleOperation.cancelReason ? (
                <p className="mt-1 text-[11px] text-dim">
                  Cancel reason: {visibleOperation.cancelReason}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={operationState.checking}
                  onClick={() => void checkOperationStatus()}
                >
                  {operationState.checking
                    ? "Checking…"
                    : "Check status manually"}
                </Button>
              </div>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-dim">No operations</p>
          )}
          {operationState.error ? (
            <p role="alert" className="mt-1 text-[11px] text-crit">
              {operationState.error}
            </p>
          ) : null}
        </div>

        {/* ── Realtime log viewer ──────────────────────────────────── */}
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[13px] font-semibold text-text">
              Container logs
            </h4>
            <span
              className="tnum text-[11px] text-dim"
              data-testid="docker-log-stream-status"
            >
              {logsSupported ? streamLabel : "Not supported"}
            </span>
            <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
              {streamOpen ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={stopStream}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!logsSupported || !selected}
                  onClick={reconnectStream}
                >
                  Reconnect
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={buffer.count === 0}
                onClick={resetBuffer}
              >
                Clear
              </Button>
              {buffer.count > 0 && !atTail ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={jumpToLatest}
                >
                  Jump to latest
                </Button>
              ) : null}
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <label className="text-[12px] text-dim">
              Search buffered logs
              <Input value={logQuery} maxLength={256} placeholder="Find text in buffered lines…" onChange={(event) => setLogQuery(event.target.value)} className="mt-1" />
            </label>
            <label className="text-[12px] text-dim">
              Log stream
              <select value={logStream} onChange={(event) => setLogStream(event.target.value)} className="mt-1 block h-9 w-full border border-line bg-panel px-3 text-text">
                <option value="all">All</option>
                <option value="stdout">stdout</option>
                <option value="stderr">stderr</option>
                <option value="combined">combined</option>
              </select>
            </label>
          </div>

          <div
            aria-live="polite"
            className="mt-2 text-[11px] text-dim"
            data-testid="docker-log-status"
          >
            {streamLabel}
            {logsSupported && streamStatus === "live" && buffer.count === 0
              ? " · No logs yet"
              : ""}
          </div>

          {!logsSupported ? (
            <p className="mt-2 text-[11px] text-dim">
              Realtime logs are unavailable for this server or agent.
            </p>
          ) : selected === null ? (
            <p className="mt-2 text-[11px] text-dim">
              {fixedTarget
                ? "Container is unavailable, so no log stream is open."
                : "No container has been reported for this server, so no log stream is open."}
            </p>
          ) : (
            <>
              <p aria-live="polite" className="mt-2 text-[11px] text-dim">
                {visibleLines.length} matching / {buffer.count} buffered lines · {buffer.bytes} bytes buffered
              </p>
              {buffer.discarded ? (
                <p className="mt-1 text-[11px] text-dim">
                  Older displayed lines were discarded.
                </p>
              ) : null}
              {streamStatus === "failed" || streamStatus === "disconnected" ? (
                <p role="alert" className="mt-1 text-[11px] text-crit">
                  {streamStatus === "disconnected"
                    ? "The log stream disconnected. Reconnect to open a new window."
                    : (streamErrorCode
                        ? STREAM_ERROR_COPY[streamErrorCode]
                        : "The log stream failed. Reconnect to try again.")}
                </p>
              ) : null}
              {streamStatus === "expired" ? (
                <p className="mt-1 text-[11px] text-dim">
                  This log window expired. Reconnect for a new one.
                </p>
              ) : null}
              {visibleLines.length > 0 ? (
                <pre
                  ref={preRef}
                  data-testid="docker-log-body"
                  className="tnum mt-2 min-h-40 max-h-96 overflow-auto whitespace-pre-wrap break-words border border-line bg-ink p-3 font-mono text-[12px] leading-6 text-text sm:p-4"
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    // Auto-scroll only holds while the reader stayed at the
                    // tail: scrolling up pins the view instead of yanking.
                    const nearTail =
                      element.scrollHeight -
                        element.scrollTop -
                        element.clientHeight <=
                      AUTO_SCROLL_SLACK_PX;
                    stickToTailRef.current = nearTail;
                    if (nearTail !== atTail) setAtTail(nearTail);
                  }}
                >
                  {visibleLines
                    .map((line) =>
                      line.truncated ? `${line.text} [line truncated]` : line.text,
                    )
                    .join("\n")}
                </pre>
              ) : (
                <p className="mt-2 text-[11px] text-dim">
                  {buffer.count > 0
                    ? "No buffered lines match these filters"
                    : streamStatus === "waiting"
                    ? "Waiting for the agent to claim this stream…"
                    : streamStatus === "live"
                      ? "No logs yet from this container."
                      : streamOpen
                        ? "Waiting for the agent to claim this stream…"
                        : "No lines buffered. Reconnect to open a new window."}
                </p>
              )}
            </>
          )}
        </div>

        <AlertDialog
          open={pendingAction !== null}
          onOpenChange={(open) => {
            // Closing the dialog is always a local cancel with no API call.
            if (!open && !operationState.requestBusy) setPendingAction(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingAction ? (
                  <>
                    {pendingAction.action === "stop" ? "Stop" : "Restart"}{" "}
                    container “{pendingAction.name}”?
                  </>
                ) : (
                  "Confirm container action"
                )}
              </AlertDialogTitle>
              <AlertDialogDescription>
                This targets {pendingAction?.name ?? "the selected container"} (key{" "}
                {pendingAction?.target.containerKey ?? "—"}) on this server and can interrupt services.
                The action is sent once on confirmation; container state is not updated optimistically.
                Check operation status manually afterwards.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  !pendingAction ||
                  !selected ||
                  operationState.requestBusy
                }
                onClick={() => {
                  if (pendingAction && pendingAction.vpsId === vpsId) void submitAction(pendingAction.action, pendingAction.target);
                }}
              >
                {operationState.requestBusy
                  ? "Sending…"
                  : pendingAction
                    ? `Confirm ${pendingAction.action}`
                    : "Confirm"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
