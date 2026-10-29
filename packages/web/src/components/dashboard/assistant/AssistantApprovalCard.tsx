import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Code2,
  FileText,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Terminal,
  XCircle,
} from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { type AiPlan, getVpsAiTaskPreview } from "../../../lib/ai-api";

export type AssistantApprovalCardProps = {
  plan: AiPlan;
  vpsId?: string;
  taskId?: string;
  busy?: boolean;
  onApprove: (planVersion: number, planDigest: string) => Promise<void>;
  onDeny: () => Promise<void>;
};

// Inline approval for the task inspector: the decrypted preview loads on
// render, and the card disappears with the plan once the task advances.
export function AssistantApprovalCard({
  plan,
  vpsId,
  taskId,
  busy = false,
  onApprove,
  onDeny,
}: AssistantApprovalCardProps) {
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [previewSteps, setPreviewSteps] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewReload, setPreviewReload] = useState(0);

  const effectiveVpsId = vpsId || plan.vpsId;
  const effectiveTaskId = taskId || plan.taskId;

  useEffect(() => {
    const controller = new AbortController();
    setPreviewSteps(null);
    setLoadingPreview(true);
    setPreviewError(null);

    getVpsAiTaskPreview(effectiveVpsId, effectiveTaskId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        // Strict equality required: planVersion and planDigest must match pending plan
        if (!data || data.planVersion !== plan.planVersion) {
          throw new Error("Plan version mismatch in preview response.");
        }
        if (data.planDigest !== plan.planDigest) {
          throw new Error("Plan digest mismatch in preview response.");
        }
        const map: Record<string, Record<string, unknown>> = {};
        for (const item of data.steps || []) {
          if (item?.stepId && item?.payload) {
            map[item.stepId] = item.payload;
          }
        }
        // Strict requirement: every encrypted step payload must be present
        for (const step of plan.steps) {
          if (step.encryptedBlobId && !map[step.stepId]) {
            throw new Error(
              `Missing decrypted execution preview for encrypted step ${step.stepId}.`,
            );
          }
        }
        setPreviewSteps(map);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPreviewSteps(null);
        setPreviewError(
          err instanceof Error ? err.message : "Failed to load decrypted execution preview.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingPreview(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [effectiveVpsId, effectiveTaskId, plan.planVersion, plan.planDigest, previewReload]);

  // Re-evaluate expiry every second; a new plan resets the in-flight action.
  useEffect(() => {
    setSubmitting(null);
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [plan.planVersion, plan.planDigest]);

  const expiresAtMs = new Date(plan.expiresAt).getTime();
  const isInvalidTimestamp = Number.isNaN(expiresAtMs) || expiresAtMs <= 0;
  const isExpired = isInvalidTimestamp || expiresAtMs <= now;

  const isPreviewBlocked = loadingPreview || previewError !== null || previewSteps === null;

  async function handleApprove() {
    if (isExpired || submitting !== null || busy || isPreviewBlocked) return;
    setSubmitting("approve");
    try {
      await onApprove(plan.planVersion, plan.planDigest);
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDeny() {
    if (submitting !== null || busy) return;
    setSubmitting("deny");
    try {
      await onDeny();
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section aria-label="Plan approval" className="border border-warn/40 bg-warn/10">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warn/30 p-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-warn">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Approval required</span>
          <Badge variant="outline" className="border-warn/40 font-mono text-[10px] text-warn">
            v{plan.planVersion}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-dim">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Expires{" "}
            <strong className={isExpired ? "font-semibold text-crit" : "font-normal text-text"}>
              {new Date(plan.expiresAt).toLocaleTimeString()}
            </strong>
          </span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="min-w-0 font-mono text-[11px]">
          <span className="text-dim">Digest </span>
          <span className="break-all text-signal select-all" title={plan.planDigest}>
            {plan.planDigest}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-dim">
          <span>policy v{plan.policyRevision}</span>
          <span>provider v{plan.providerRevision}</span>
          <span>capability v{plan.capabilityRevision}</span>
        </div>

        {isInvalidTimestamp ? (
          <div className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-2 text-xs text-crit">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Invalid expiration timestamp. This plan cannot be approved.</span>
          </div>
        ) : isExpired ? (
          <div className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-2 text-xs text-crit">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>This plan has expired. Reject it or request a new plan.</span>
          </div>
        ) : null}

        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-dim">
            Exact steps ({plan.steps.length})
          </h3>

          {loadingPreview ? (
            <div role="status" className="flex items-center gap-2 border border-line bg-ink/40 p-2 text-xs text-dim">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span>Decrypting execution preview…</span>
            </div>
          ) : previewError ? (
            <div className="flex items-start justify-between gap-2 border border-crit/40 bg-crit/10 p-2 text-xs text-crit">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{previewError}</span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewReload((n) => n + 1)}
                className="shrink-0 p-1 hover:text-text"
                title="Retry preview"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>
          ) : null}

          {plan.steps.map((step, idx) => {
            const stepPayload = previewSteps?.[step.stepId];
            return (
              <div key={step.stepId || idx} className="space-y-1.5 border border-line bg-ink/40 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center border border-line bg-raised font-mono text-[10px] text-text">
                      {idx + 1}
                    </span>
                    <span className="min-w-0 break-words text-xs font-semibold text-text">
                      {step.description || "Unspecified step"}
                    </span>
                  </div>
                  <Badge variant="outline" className="shrink-0 border-line font-mono text-[10px] text-signal">
                    <Code2 className="mr-1 h-2.5 w-2.5" aria-hidden="true" />
                    {step.tool}
                  </Badge>
                </div>

                {step.resourceKeys && step.resourceKeys.length > 0 ? (
                  <div className="break-all font-mono text-[11px] text-dim">
                    <span className="text-dim/80">Targets </span>
                    {step.resourceKeys.join(" · ")}
                  </div>
                ) : null}

                <div className="font-mono text-[10px] text-dim">Timeout {step.timeoutSeconds}s</div>

                {typeof stepPayload?.script === "string" ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-warn">
                      <Terminal className="h-3 w-3" aria-hidden="true" />
                      <span>Script to execute</span>
                    </div>
                    <pre className="max-h-40 overflow-auto border border-line bg-ink p-2 font-mono text-[11px] text-text select-all">
                      {stepPayload.script}
                    </pre>
                  </div>
                ) : null}

                {typeof stepPayload?.candidateContent === "string" ||
                typeof stepPayload?.content === "string" ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-warn">
                      <FileText className="h-3 w-3" aria-hidden="true" />
                      <span>
                        {typeof stepPayload.candidateContent === "string"
                          ? "Candidate content (to apply)"
                          : "File content (to apply)"}
                      </span>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap border border-line bg-ink p-2 font-mono text-[11px] text-text select-all">
                      {String(stepPayload.candidateContent ?? stepPayload.content)}
                    </pre>
                  </div>
                ) : null}

                {stepPayload
                  ? (() => {
                      const otherEntries = Object.entries(stepPayload).filter(
                        ([k]) => !["script", "content", "candidateContent"].includes(k),
                      );
                      if (otherEntries.length === 0) return null;
                      return (
                        <div className="space-y-1">
                          <div className="text-[10px] text-dim">Payload parameters</div>
                          <pre className="max-h-32 overflow-auto border border-line bg-ink/70 p-2 font-mono text-[10px] text-text">
                            {JSON.stringify(Object.fromEntries(otherEntries), null, 2)}
                          </pre>
                        </div>
                      );
                    })()
                  : null}

                {!stepPayload && step.args && Object.keys(step.args).length > 0 ? (
                  <div className="space-y-1">
                    <div className="text-[10px] text-dim">Payload arguments</div>
                    <pre className="max-h-32 overflow-auto border border-line bg-ink/70 p-2 font-mono text-[10px] text-text">
                      {JSON.stringify(step.args, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {plan.preconditions && plan.preconditions.length > 0 ? (
          <div className="space-y-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-dim">
              Preconditions
            </h3>
            <div className="space-y-1 border border-line bg-ink/30 p-2 font-mono text-[11px]">
              {plan.preconditions.map((p, idx) => (
                <div key={idx} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all text-text">{p.key}</span>
                  <span className="text-dim">== {String(p.expectedValue)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {plan.recoverySteps && plan.recoverySteps.length > 0 ? (
          <div className="space-y-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-dim">
              Recovery on failure
            </h3>
            <div className="space-y-1 border border-line bg-ink/30 p-2 text-[11px] text-dim">
              {plan.recoverySteps.map((rec, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <FileText className="h-3 w-3 shrink-0 text-text" aria-hidden="true" />
                  <span className="break-words">{rec.description || rec.tool}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-warn/30 pt-3">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={isExpired || submitting !== null || busy || isPreviewBlocked}
            onClick={() => void handleApprove()}
            className="min-w-[7rem] flex-1 text-xs font-semibold"
          >
            {submitting === "approve" ? (
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            )}
            Approve
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={submitting !== null || busy}
            onClick={() => void handleDeny()}
            className="min-w-[7rem] flex-1 text-xs"
          >
            {submitting === "deny" ? (
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <XCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            )}
            Reject
          </Button>
        </div>
      </div>
    </section>
  );
}
