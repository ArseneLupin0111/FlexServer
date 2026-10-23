import { useState, useRef, useEffect } from "react";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Code2,
  Copy,
  Eye,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import type { AiOutputChunk, AiStreamState } from "../../../lib/ai-stream";
import type { AiTask, AiTaskState } from "../../../lib/ai-api";

export type AssistantTaskPanelProps = {
  task: AiTask | null;
  outputChunks: AiOutputChunk[];
  streamState: AiStreamState;
  hasGap: boolean;
  isTruncated: boolean;
  onClearOutput: () => void;
  onCancelTask: () => Promise<void>;
  onReconcileTask: () => Promise<void>;
  onOpenApproval: () => void;
  onReconnectStream?: () => void;
  busy?: boolean;
};

function taskStateTone(state: AiTaskState): {
  badgeClass: string;
  label: string;
} {
  switch (state) {
    case "planning":
      return {
        badgeClass: "border-signal/40 bg-signal/10 text-signal animate-pulse",
        label: "Planning",
      };
    case "awaiting_approval":
      return {
        badgeClass: "border-warn/40 bg-warn/10 text-warn font-semibold",
        label: "Awaiting Approval",
      };
    case "awaiting_input":
      return {
        badgeClass: "border-info/40 bg-info/10 text-info",
        label: "Awaiting Input",
      };
    case "executing":
      return {
        badgeClass: "border-signal/40 bg-signal/10 text-signal animate-pulse",
        label: "Executing",
      };
    case "verifying":
      return {
        badgeClass: "border-info/40 bg-info/10 text-info",
        label: "Verifying",
      };
    case "cancel_requested":
      return {
        badgeClass: "border-warn/40 bg-warn/10 text-warn",
        label: "Cancel Requested",
      };
    case "uncertain":
      return {
        badgeClass: "border-crit/40 bg-crit/10 text-crit font-semibold",
        label: "Uncertain Outcome",
      };
    case "succeeded":
      return {
        badgeClass: "border-signal/40 bg-signal/10 text-signal",
        label: "Succeeded",
      };
    case "failed":
      return {
        badgeClass: "border-crit/40 bg-crit/10 text-crit",
        label: "Failed",
      };
    case "cancelled":
      return {
        badgeClass: "border-line bg-raised/30 text-dim",
        label: "Cancelled",
      };
    case "expired":
      return {
        badgeClass: "border-line bg-raised/30 text-dim",
        label: "Expired",
      };
    default:
      return {
        badgeClass: "border-line bg-raised/30 text-dim",
        label: state,
      };
  }
}

export function AssistantTaskPanel({
  task,
  outputChunks,
  streamState,
  hasGap,
  isTruncated,
  onClearOutput,
  onCancelTask,
  onReconcileTask,
  onOpenApproval,
  onReconnectStream,
  busy = false,
}: AssistantTaskPanelProps) {
  const [cancelling, setCancelling] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const consoleEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoScroll && consoleEndRef.current) {
      const container = consoleEndRef.current.parentElement;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [outputChunks, autoScroll]);

  if (!task) {
    return (
      <aside aria-label="Task inspector" className="flex h-full flex-col items-center justify-center border border-line bg-panel p-6 text-center">
        <Activity className="h-8 w-8 text-dim opacity-40" />
        <h2 className="mt-3 text-sm font-semibold text-text">No Active Task</h2>
        <p className="mt-1 max-w-xs text-xs text-dim">
          Submit an instruction in the chat to create a task and inspect plan execution.
        </p>
      </aside>
    );
  }

  const { badgeClass, label: stateLabel } = taskStateTone(task.state);

  const isTerminal =
    task.state === "succeeded" ||
    task.state === "failed" ||
    task.state === "cancelled" ||
    task.state === "expired";

  const isAwaitingApproval = task.state === "awaiting_approval";
  const isUncertain = task.state === "uncertain";
  const isCancelRequested = task.state === "cancel_requested";

  async function handleCancel() {
    if (cancelling || busy || isTerminal) return;
    setCancelling(true);
    try {
      await onCancelTask();
    } finally {
      setCancelling(false);
    }
  }

  async function handleReconcile() {
    if (reconciling || busy) return;
    setReconciling(true);
    try {
      await onReconcileTask();
    } finally {
      setReconciling(false);
    }
  }

  async function handleCopyTaskId() {
    if (!task) return;
    await navigator.clipboard.writeText(task.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <aside aria-label="Task inspector" className="flex h-full min-h-0 min-w-0 flex-col border border-line bg-panel">
      {/* Task identity header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={badgeClass}>
            {stateLabel}
          </Badge>
          <div className="flex items-center gap-1 font-mono text-xs text-dim">
            <span>ID:</span>
            <span className="select-all text-text" title={task.id}>
              {task.id.slice(0, 12)}…
            </span>
            <button
              type="button"
              onClick={() => void handleCopyTaskId()}
              className="ml-1 text-dim hover:text-text"
              title="Copy Task ID"
            >
              <Copy className="h-3 w-3" />
            </button>
            {copied ? (
              <span className="text-[10px] text-signal font-sans">Copied!</span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs text-dim">
          <Clock className="h-3 w-3" />
          <span>rev {task.revision}</span>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4">
        {task.usage ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-line pb-4 text-xs">
            <div><dt className="text-dim">Input / output tokens</dt><dd className="mt-1 font-mono text-text">{task.usage.inputTokens.toLocaleString()} / {task.usage.outputTokens.toLocaleString()}{task.usage.estimated ? " (estimated)" : ""}</dd></div>
            <div><dt className="text-dim">Tool calls / rounds</dt><dd className="mt-1 font-mono text-text">{task.usage.toolCalls} / {task.usage.rounds}</dd></div>
          </dl>
        ) : null}
        {/* Awaiting Approval Action Card */}
        {isAwaitingApproval && task.plan ? (
          <div className="border border-warn/40 bg-warn/10 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-warn">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  <span>Approval Required</span>
                </div>
                <p className="text-xs text-text">
                  The plan contains {task.plan.steps.length} operation
                  {task.plan.steps.length === 1 ? "" : "s"} requiring exact verification.
                </p>
                <div className="font-mono text-[11px] text-dim">
                  Digest: {task.plan.planDigest.slice(0, 24)}…
                </div>
              </div>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={onOpenApproval}
                className="shrink-0 text-xs font-semibold"
              >
                <Eye className="mr-1.5 h-3.5 w-3.5" />
                Review Plan
              </Button>
            </div>
          </div>
        ) : null}

        {/* Cancellation Pending Alert */}
        {isCancelRequested ? (
          <div className="flex items-center gap-2 border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
            <span>
              Cancellation requested. Waiting for executor acknowledgement...
            </span>
          </div>
        ) : null}

        {/* Uncertain Outcome Alert */}
        {isUncertain ? (
          <div className="space-y-2 border border-crit/40 bg-crit/10 p-3 text-xs text-crit">
            <div className="flex items-center gap-2 font-semibold">
              <AlertOctagon className="h-4 w-4 shrink-0" />
              <span>Uncertain Outcome</span>
            </div>
            <p className="text-text">
              The executor was interrupted or reported an ambiguous result.
              State changes may be partially applied. Receipts are protected.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reconciling || busy}
              onClick={() => void handleReconcile()}
              className="text-xs border-crit/40 text-crit hover:bg-crit/20"
            >
              {reconciling ? (
                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Reconcile State
            </Button>
          </div>
        ) : null}

        {/* Task Error Notice */}
        {task.error ? (
          <div className="space-y-1 border border-crit/40 bg-crit/10 p-3 text-xs text-crit">
            <div className="flex items-center gap-1.5 font-semibold">
              <XCircle className="h-3.5 w-3.5 shrink-0" />
              <span>Error: {task.error.code}</span>
            </div>
            <p className="text-text">{task.error.message}</p>
          </div>
        ) : null}

        {/* Task Summary */}
        {task.summary ? (
          <details className="min-w-0 border-b border-line pb-4">
            <summary className="cursor-pointer text-sm font-medium text-dim hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">Response summary</summary>
            <div className="mt-3 min-w-0"><AssistantMarkdown content={task.summary} /></div>
          </details>
        ) : null}

        {/* Plan Steps Timeline */}
        {task.plan && task.plan.steps.length > 0 ? (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
              Plan Steps ({task.plan.steps.length})
            </h2>
            <div className="space-y-2">
              {task.plan.steps.map((step, idx) => (
                <div
                  key={step.stepId || idx}
                  className="flex items-start justify-between gap-2 border border-line bg-ink/20 p-2.5 text-xs"
                >
                  <div className="flex items-start gap-2">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center border border-line bg-raised font-mono text-[10px] text-text">
                      {idx + 1}
                    </span>
                    <div>
                      <div className="font-semibold text-text">
                        {step.description || step.tool}
                      </div>
                      {step.resourceKeys && step.resourceKeys.length > 0 ? (
                        <div className="mt-0.5 font-mono text-[11px] text-dim">
                          {step.resourceKeys.join(", ")}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <Badge variant="outline" className="border-line font-mono text-[10px]">
                    <Code2 className="mr-1 h-2.5 w-2.5" />
                    {step.tool}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Live Output Console */}
        <details key={task.id} open={outputChunks.length > 0 || hasGap || isTruncated || streamState === "error"} className="min-w-0 space-y-3">
          <summary className="cursor-pointer text-sm font-medium text-dim hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">Execution output{outputChunks.length === 0 ? " · no output" : ""}</summary>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-signal" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
                Live Output Stream
              </h2>
              <span
                className={`h-2 w-2 rounded-full ${
                  streamState === "live"
                    ? "bg-signal animate-pulse"
                    : streamState === "connecting"
                      ? "bg-warn"
                      : "bg-dim"
                }`}
                title={`Stream: ${streamState}`}
              />
            </div>

            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5 text-dim cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="h-3 w-3 rounded-none border-line bg-ink text-signal focus:ring-0"
                />
                <span>Auto-scroll</span>
              </label>
              {onReconnectStream && streamState === "error" ? (
                <button
                  type="button"
                  onClick={onReconnectStream}
                  className="text-warn hover:text-text p-1"
                  title="Reconnect stream"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              ) : null}

              <button
                type="button"
                onClick={onClearOutput}
                className="text-dim hover:text-text p-1"
                title="Clear output view"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>

          {streamState === "error" ? (
            <p role="status" className="text-xs text-warn">Live output disconnected. Reconnect to resume updates.</p>
          ) : null}

          {/* Output gap alert */}
          {hasGap ? (
            <div className="flex items-center gap-1.5 border border-warn/40 bg-warn/10 p-2 font-mono text-[11px] text-warn">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Stream gap detected: buffer dropped some output chunks.</span>
            </div>
          ) : null}

          {/* Truncated notice */}
          {isTruncated ? (
            <div className="border border-line bg-ink/40 p-2 font-mono text-[11px] text-dim">
              [Output truncated by agent bounded limits]
            </div>
          ) : null}

          {/* Console Output box */}
          <div className={`${outputChunks.length ? "max-h-64" : ""} overflow-auto overscroll-contain border border-line bg-ink p-3 font-mono text-xs text-text [scrollbar-width:thin]`}>
            {outputChunks.length === 0 ? (
              <span className="text-dim/60 italic">
                {streamState === "live"
                  ? "Connected to live stream. Awaiting output..."
                  : streamState === "connecting"
                    ? "Connecting to stream..."
                    : "No stream output for this task."}
              </span>
            ) : (
              <>
                {outputChunks.map((chunk) => (
                  <div
                    key={chunk.id}
                    className={`whitespace-pre-wrap break-all ${
                      chunk.isGap ? "text-warn italic" : "text-text"
                    }`}
                  >
                    {chunk.text}
                  </div>
                ))}
                <div ref={consoleEndRef} />
              </>
            )}
          </div>
        </details>
      </div>

      {/* Task Controls Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line p-3">
        <div className="flex items-center gap-2">
          {!isTerminal && !isCancelRequested ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={cancelling || busy}
              onClick={() => void handleCancel()}
              className="text-xs border-crit/40 text-crit hover:bg-crit/20"
            >
              {cancelling ? (
                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
              )}
              Cancel Task
            </Button>
          ) : null}

          {isUncertain || task.state === "failed" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reconciling || busy}
              onClick={() => void handleReconcile()}
              className="text-xs"
            >
              {reconciling ? (
                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Reconcile
            </Button>
          ) : null}
        </div>

        <div className="text-[11px] text-dim">
          Updated: {new Date(task.updatedAt).toLocaleTimeString()}
        </div>
      </div>
    </aside>
  );
}
