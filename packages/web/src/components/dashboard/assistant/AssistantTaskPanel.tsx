import { useState, useRef, useEffect } from "react";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { AssistantApprovalCard } from "./AssistantApprovalCard";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Code2,
  Copy,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
  XCircle,
  Zap,
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
  vpsId: string;
  onClearOutput: () => void;
  onCancelTask: () => Promise<void>;
  onReconcileTask: () => Promise<void>;
  onResumeTask?: () => Promise<void>;
  onApprovePlan: (planVersion: number, planDigest: string) => Promise<void>;
  onDenyPlan: () => Promise<void>;
  onReconnectStream?: () => void;
  busy?: boolean;
};

function planStatusTone(status: string): string {
  switch (status) {
    case "approved":
      return "border-signal/40 bg-signal/10 text-signal";
    case "pending":
      return "border-warn/40 bg-warn/10 text-warn animate-pulse";
    case "denied":
      return "border-crit/40 bg-crit/10 text-crit";
    case "consumed":
      return "border-line bg-raised/30 text-dim";
    case "expired":
      return "border-line bg-raised/30 text-dim";
    default:
      return "border-line text-dim";
  }
}

function observationStatusTone(status: string): string {
  switch (status) {
    case "succeeded":
      return "border-signal/40 bg-signal/10 text-signal";
    case "failed":
      return "border-crit/40 bg-crit/10 text-crit";
    case "uncertain":
      return "border-warn/40 bg-warn/10 text-warn";
    case "cancelled":
      return "border-line bg-raised/30 text-dim";
    default:
      return "border-line text-dim";
  }
}

function completionOutcomeTone(kind: string): {
  badgeClass: string;
  cardClass: string;
} {
  switch (kind) {
    case "verified":
      return {
        badgeClass: "border-signal/40 bg-signal/10 text-signal font-semibold",
        cardClass: "border-signal/40 bg-signal/5",
      };
    case "unverified":
      return {
        badgeClass: "border-warn/40 bg-warn/10 text-warn font-semibold",
        cardClass: "border-warn/40 bg-warn/5",
      };
    case "blocked":
      return {
        badgeClass: "border-crit/40 bg-crit/10 text-crit font-semibold",
        cardClass: "border-crit/40 bg-crit/5",
      };
    case "cancelled":
      return {
        badgeClass: "border-line bg-raised/30 text-dim font-medium",
        cardClass: "border-line bg-raised/10",
      };
    case "expired":
      return {
        badgeClass: "border-line bg-raised/30 text-dim font-medium",
        cardClass: "border-line bg-raised/10",
      };
    default:
      return {
        badgeClass: "border-line bg-raised/30 text-dim",
        cardClass: "border-line bg-panel",
      };
  }
}

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
  vpsId,
  onClearOutput,
  onCancelTask,
  onReconcileTask,
  onResumeTask,
  onApprovePlan,
  onDenyPlan,
  onReconnectStream,
  busy = false,
}: AssistantTaskPanelProps) {
  const [cancelling, setCancelling] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [resuming, setResuming] = useState(false);
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
  const isPaused = Boolean(task.loop?.pauseReason) || task.state === "awaiting_input";
  const canResume = Boolean(
    onResumeTask &&
      !isTerminal &&
      !isCancelRequested &&
      !isUncertain &&
      (isPaused || task.state === "planning" || task.state === "verifying"),
  );
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

  async function handleResume() {
    if (resuming || busy || !onResumeTask) return;
    setResuming(true);
    try {
      await onResumeTask();
    } finally {
      setResuming(false);
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
          {task.executionMode === "yolo" ? (
            <Badge variant="outline" className="border-warn/40 bg-warn/10 text-warn font-semibold">
              <Zap className="mr-1 h-3 w-3" />
              YOLO
            </Badge>
          ) : (
            <Badge variant="outline" className="border-line text-dim">
              Manual
            </Badge>
          )}
          {task.completion ?? task.loop?.completion ? (
            <Badge
              variant="outline"
              className={`font-semibold ${
                completionOutcomeTone((task.completion ?? task.loop?.completion)!.kind).badgeClass
              }`}
            >
              {(task.completion ?? task.loop?.completion)!.kind}
            </Badge>
          ) : null}
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
        {/* Awaiting approval: inline authorization, no separate dialog */}
        {isAwaitingApproval && task.plan ? (
          <AssistantApprovalCard
            plan={task.plan}
            vpsId={vpsId}
            taskId={task.id}
            busy={busy}
            onApprove={onApprovePlan}
            onDeny={onDenyPlan}
          />
        ) : null}

        {/* Cancellation Pending Alert */}
        {isCancelRequested ? (
          <div className="space-y-1 border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
            <div className="flex items-center gap-2 font-semibold">
              <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
              <span>Cancellation Requested</span>
            </div>
            <p className="text-[11px] text-dim">
              Halting future plan steps. Any in-flight host command will record its receipt before stopping; executed changes are not rolled back.
            </p>
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
              An action reported an ambiguous result or was interrupted.
              State changes may be partially applied; receipts are protected and will never be replayed.
            </p>
            <p className="text-[11px] text-dim">
              Automatic mutation retries are blocked to prevent unsafe replay. You must reconcile state until an authoritative outcome is reached; resuming an uncertain mutation is strictly blocked.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
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
          </div>
        ) : null}

        {/* Execution Paused Alert */}
        {isPaused && !isTerminal && !isCancelRequested && !isUncertain ? (
          <div className="space-y-2 border border-line bg-panel p-3 text-xs">
            <div className="flex items-center gap-2 font-semibold text-text">
              <Clock className="h-4 w-4 shrink-0 text-signal" />
              <span>Execution Paused{task.loop?.pauseReason ? ` (${task.loop.pauseReason})` : ""}</span>
            </div>
            <p className="text-dim">
              The loop paused safely (e.g. policy or provider settings changed, or awaiting input). You can resume execution after verifying the current configuration.
            </p>
            {onResumeTask ? (
              <div className="pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={resuming || busy}
                  onClick={() => void handleResume()}
                  className="text-xs"
                >
                  {resuming ? (
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Resume Task
                </Button>
              </div>
            ) : null}
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

        {/* Completion Outcome Card */}
        {task.completion ?? task.loop?.completion ? (
          <div
            data-testid="completion-outcome-card"
            className={`space-y-2 border p-3 text-xs ${
              completionOutcomeTone((task.completion ?? task.loop?.completion)!.kind).cardClass
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-semibold text-text">
                {(task.completion ?? task.loop?.completion)!.kind === "verified" ? (
                  <CheckCircle2 className="h-4 w-4 text-signal shrink-0" />
                ) : (task.completion ?? task.loop?.completion)!.kind === "unverified" ? (
                  <AlertTriangle className="h-4 w-4 text-warn shrink-0" />
                ) : (task.completion ?? task.loop?.completion)!.kind === "blocked" ? (
                  <AlertOctagon className="h-4 w-4 text-crit shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 text-dim shrink-0" />
                )}
                <span>Outcome: {(task.completion ?? task.loop?.completion)!.kind}</span>
              </div>
              <Badge
                variant="outline"
                className={`font-mono text-[10px] ${
                  completionOutcomeTone((task.completion ?? task.loop?.completion)!.kind).badgeClass
                }`}
              >
                {(task.completion ?? task.loop?.completion)!.reasonCode}
              </Badge>
            </div>
            <p className="text-text">{(task.completion ?? task.loop?.completion)!.message}</p>
            {(task.completion ?? task.loop?.completion)!.evidenceReferences &&
            (task.completion ?? task.loop?.completion)!.evidenceReferences!.length > 0 ? (
              <div className="space-y-1 pt-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">
                  Evidence references:
                </span>
                <div className="flex flex-wrap gap-1 font-mono text-[10px]">
                  {(task.completion ?? task.loop?.completion)!.evidenceReferences!.map((ref, idx) => (
                    <span
                      key={idx}
                      className="border border-line bg-ink/40 px-1.5 py-0.5 text-text"
                    >
                      {ref}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Multi-Plan Timeline */}
        {(() => {
          const planHistory = task.planHistory ?? task.loop?.planHistory ?? (task.plan ? [task.plan] : []);
          if (planHistory.length === 0) return null;
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
                  Plan History ({planHistory.length})
                </h2>
                {task.loop?.counters ? (
                  <span className="font-mono text-[11px] text-dim">
                    turn {task.loop.turn} · {task.loop.counters.mutationPlans} plans
                  </span>
                ) : null}
              </div>
              <div className="space-y-3">
                {planHistory.map((plan, planIdx) => {
                  const isCurrent = task.plan && task.plan.planVersion === plan.planVersion;
                  return (
                    <div
                      key={plan.planId || planIdx}
                      data-testid={`plan-item-v${plan.planVersion}`}
                      className={`space-y-2 border p-3 text-xs ${
                        isCurrent && isAwaitingApproval
                          ? "border-warn/60 bg-warn/5"
                          : "border-line bg-ink/20"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-text">
                            v{plan.planVersion}
                          </span>
                          <Badge
                            variant="outline"
                            className={`font-mono text-[10px] ${planStatusTone(plan.status)}`}
                          >
                            {plan.status}
                          </Badge>
                          {plan.execMode === "privileged" ? (
                            <Badge
                              variant="outline"
                              className="border-warn/40 bg-warn/10 text-warn font-mono text-[10px]"
                            >
                              privileged
                            </Badge>
                          ) : null}
                        </div>
                        <span className="font-mono text-[10px] text-dim" title={plan.planDigest}>
                          digest: {plan.planDigest ? `${plan.planDigest.slice(0, 10)}…` : "none"}
                        </span>
                      </div>

                      {/* Plan steps */}
                      <div className="space-y-1.5 pt-1">
                        {plan.steps.map((step, stepIdx) => (
                          <div
                            key={step.stepId || stepIdx}
                            className="flex items-start justify-between gap-2 border border-line/60 bg-panel/50 p-2 text-xs"
                          >
                            <div className="flex items-start gap-2">
                              <span className="flex h-4 w-4 shrink-0 items-center justify-center border border-line bg-raised font-mono text-[10px] text-text">
                                {stepIdx + 1}
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
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Loop Observations Timeline */}
        {(() => {
          const observations = task.observations ?? task.loop?.observations ?? [];
          if (observations.length === 0) return null;
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
                  Loop Observations ({observations.length})
                </h2>
              </div>
              <div className="space-y-2">
                {observations.map((obs, obsIdx) => (
                  <div
                    key={obs.id || obsIdx}
                    data-testid={`observation-item-${obs.id || obsIdx}`}
                    className="space-y-1.5 border border-line bg-ink/20 p-2.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-mono text-[11px]">
                        <span className="text-dim">turn {obs.turn}</span>
                        <span className="text-dim">·</span>
                        <span className="font-semibold text-text">{obs.tool}</span>
                        {obs.source ? (
                          <span className="text-dim">({obs.source.replace(/_/g, " ")})</span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {obs.exitCode !== undefined ? (
                          <span className="font-mono text-[10px] text-dim">
                            exit: {obs.exitCode}
                          </span>
                        ) : null}
                        <Badge
                          variant="outline"
                          className={`font-mono text-[10px] ${observationStatusTone(obs.status)}`}
                        >
                          {obs.status}
                        </Badge>
                      </div>
                    </div>

                    {obs.target ? (
                      <div className="font-mono text-[10px] text-dim">
                        target: <span className="text-text">{obs.target}</span>
                      </div>
                    ) : null}

                    {obs.summary || obs.outputPreview ? (
                      <p className="line-clamp-3 font-mono text-[11px] text-dim whitespace-pre-wrap">
                        {obs.summary || obs.outputPreview}
                      </p>
                    ) : null}

                    {obs.restrictedSources && obs.restrictedSources.length > 0 ? (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {obs.restrictedSources.map((rs, i) => (
                          <Badge
                            key={i}
                            variant="outline"
                            className="border-warn/40 bg-warn/10 text-warn font-mono text-[9px]"
                          >
                            restricted: {rs}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

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

          {canResume ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resuming || busy}
              onClick={() => void handleResume()}
              className="text-xs"
            >
              {resuming ? (
                <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              Resume Task
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
