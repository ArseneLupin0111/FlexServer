import { useState, useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Code2,
  FileText,
  LoaderCircle,
  ShieldAlert,
  Terminal,
  XCircle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { type AiPlan, getVpsAiTaskPreview } from "../../../lib/ai-api";

export type AssistantApprovalDialogProps = {
  open: boolean;
  plan: AiPlan | null;
  vpsId?: string;
  taskId?: string;
  busy?: boolean;
  onApprove: (planVersion: number, planDigest: string) => Promise<void>;
  onDeny: () => Promise<void>;
  onClose: () => void;
};

export function AssistantApprovalDialog({
  open,
  plan,
  vpsId,
  taskId,
  busy = false,
  onApprove,
  onDeny,
  onClose,
}: AssistantApprovalDialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [previewSteps, setPreviewSteps] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Fetch decrypted preview when dialog opens
  useEffect(() => {
    if (!open || !plan) {
      setPreviewSteps(null);
      setLoadingPreview(false);
      setPreviewError(null);
      return;
    }

    const effectiveVpsId = vpsId || plan.vpsId;
    const effectiveTaskId = taskId || plan.taskId;
    if (!effectiveVpsId || !effectiveTaskId) return;

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
  }, [open, plan?.planId, plan?.planVersion, plan?.planDigest, vpsId, taskId]);

  // Reset confirmation whenever a new plan opens, version changes, or digest changes
  useEffect(() => {
    setConfirmed(false);
    setActionError(null);
    setSubmitting(null);
  }, [plan?.planId, plan?.planVersion, plan?.planDigest, open]);

  // Bounded timer when open: ticks every second to re-evaluate expiry reactively
  useEffect(() => {
    if (!open || !plan) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [open, plan?.planId, plan?.planVersion, plan?.planDigest]);

  if (!plan) return null;

  const expiresAtMs = new Date(plan.expiresAt).getTime();
  const isInvalidTimestamp = Number.isNaN(expiresAtMs) || expiresAtMs <= 0;
  const isExpired = isInvalidTimestamp || expiresAtMs <= now;

  const isPreviewBlocked = loadingPreview || previewError !== null || previewSteps === null;

  async function handleApprove() {
    if (
      !plan ||
      isExpired ||
      isInvalidTimestamp ||
      !confirmed ||
      submitting !== null ||
      busy ||
      isPreviewBlocked
    ) {
      return;
    }
    setSubmitting("approve");
    setActionError(null);
    try {
      await onApprove(plan.planVersion, plan.planDigest);
      onClose();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Approval failed to dispatch.",
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDeny() {
    if (submitting !== null || busy) return;
    setSubmitting("deny");
    setActionError(null);
    try {
      await onDeny();
      onClose();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Denial failed to dispatch.",
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(val) => !val && onClose()}>
      <AlertDialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto border border-line bg-panel p-6 text-text">
        <AlertDialogHeader className="space-y-2 text-left">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-warn" />
              <AlertDialogTitle className="text-base font-semibold text-text">
                Plan Approval Required
              </AlertDialogTitle>
              <Badge variant="outline" className="border-line font-mono text-xs">
                v{plan.planVersion}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-xs text-dim">
              <Clock className="h-3.5 w-3.5" />
              <span>
                Expires:{" "}
                <strong
                  className={
                    isExpired ? "text-crit font-semibold" : "text-text font-normal"
                  }
                >
                  {new Date(plan.expiresAt).toLocaleTimeString()}
                </strong>
              </span>
            </div>
          </div>
          <AlertDialogDescription className="text-xs text-dim">
            The assistant has proposed modifications requiring explicit authorization.
            Inspect the exact parameters, touched resource keys, and preconditions
            before confirming.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Plan Digest & Identifiers */}
        <div className="space-y-1.5 border border-line bg-ink/50 p-3 font-mono text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-dim">Plan ID:</span>
            <span className="text-text select-all">{plan.planId}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-dim">Digest:</span>
            <span className="break-all text-signal select-all">
              {plan.planDigest}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-dim">Policy Rev:</span>
            <span className="text-text">{plan.policyRevision}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-dim">Provider Rev:</span>
            <span className="text-text">{plan.providerRevision}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-dim">Capability Rev:</span>
            <span className="text-text">{plan.capabilityRevision}</span>
          </div>
        </div>

        {/* Expired / Invalid timestamp warning */}
        {isInvalidTimestamp ? (
          <div className="flex items-center gap-2 border border-crit/40 bg-crit/10 p-3 text-xs text-crit">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              This plan has an invalid expiration timestamp. It cannot be approved.
            </span>
          </div>
        ) : isExpired ? (
          <div className="flex items-center gap-2 border border-crit/40 bg-crit/10 p-3 text-xs text-crit">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              This plan has expired. It can no longer be approved. You may deny it or
              request a new plan.
            </span>
          </div>
        ) : null}

        {/* Action Error display */}
        {actionError ? (
          <div className="flex items-center gap-2 border border-crit/40 bg-crit/10 p-3 text-xs text-crit">
            <XCircle className="h-4 w-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        ) : null}

        {/* Proposed Steps */}
        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
            Proposed Execution Steps ({plan.steps.length})
          </h2>

          <div className="space-y-3">
            {loadingPreview ? (
              <div className="flex items-center gap-2 border border-line bg-ink/40 p-2.5 text-xs text-dim">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                <span>Decrypting exact execution preview from host...</span>
              </div>
            ) : previewError ? (
              <div className="flex items-center gap-2 border border-crit/40 bg-crit/10 p-2.5 text-xs text-crit">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{previewError}</span>
              </div>
            ) : null}

            {plan.steps.map((step, idx) => {
              const stepPayload = previewSteps?.[step.stepId];
              return (
                <div
                  key={step.stepId || idx}
                  className="space-y-2 border border-line bg-ink/30 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center border border-line bg-raised font-mono text-xs font-semibold text-text">
                        {idx + 1}
                      </span>
                      <span className="font-semibold text-xs text-text">
                        {step.description || "Unspecified step"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <Badge variant="outline" className="border-line text-signal">
                        <Code2 className="mr-1 h-3 w-3" />
                        {step.tool}
                      </Badge>
                      <span className="text-dim">
                        Timeout: {step.timeoutSeconds}s
                      </span>
                    </div>
                  </div>

                  {/* Target resource keys */}
                  {step.resourceKeys && step.resourceKeys.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-dim">Targets:</span>
                      {step.resourceKeys.map((key) => (
                        <span
                          key={key}
                          className="border border-line bg-raised/50 px-1.5 py-0.5 font-mono text-[11px] text-text"
                        >
                          {key}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {/* Exact decrypted script */}
                  {typeof stepPayload?.script === "string" ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-warn">
                        <Terminal className="h-3.5 w-3.5" />
                        <span>Exact Script to Execute</span>
                      </div>
                      <pre className="max-h-60 overflow-x-auto border border-line bg-ink p-2.5 font-mono text-xs text-text select-all">
                        {stepPayload.script}
                      </pre>
                    </div>
                  ) : null}

                  {/* Exact decrypted file/config content */}
                  {typeof stepPayload?.candidateContent === "string" ||
                  typeof stepPayload?.content === "string" ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-warn">
                        <FileText className="h-3.5 w-3.5" />
                        <span>
                          {typeof stepPayload.candidateContent === "string"
                            ? "Candidate Content (To Apply)"
                            : "Exact File Content (To Apply)"}
                        </span>
                      </div>
                      <pre className="max-h-60 overflow-x-auto border border-line bg-ink p-2.5 font-mono text-xs text-text select-all whitespace-pre-wrap">
                        {String(stepPayload.candidateContent ?? stepPayload.content)}
                      </pre>
                    </div>
                  ) : null}

                  {/* Other decrypted payload parameters */}
                  {stepPayload ? (() => {
                    const otherEntries = Object.entries(stepPayload).filter(
                      ([k]) => !["script", "content", "candidateContent"].includes(k),
                    );
                    if (otherEntries.length === 0) return null;
                    return (
                      <div className="space-y-1">
                        <div className="text-[11px] text-dim">Payload parameters:</div>
                        <pre className="max-h-36 overflow-x-auto border border-line bg-ink/70 p-2 font-mono text-[11px] text-text">
                          {JSON.stringify(Object.fromEntries(otherEntries), null, 2)}
                        </pre>
                      </div>
                    );
                  })() : null}

                  {/* Fallback to plan step arguments / digests if preview is missing */}
                  {!stepPayload && step.args && Object.keys(step.args).length > 0 ? (
                    <div className="space-y-1">
                      <div className="text-[11px] text-dim">Payload arguments:</div>
                      <pre className="max-h-40 overflow-x-auto border border-line bg-ink p-2 font-mono text-[11px] text-text">
                        {JSON.stringify(step.args, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* Preconditions */}
        {plan.preconditions && plan.preconditions.length > 0 ? (
          <div className="space-y-1.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
              Preconditions
            </h2>
            <div className="space-y-1 border border-line bg-ink/30 p-2 text-xs font-mono">
              {plan.preconditions.map((p, idx) => (
                <div key={idx} className="flex items-center justify-between gap-2">
                  <span className="text-text">{p.key}</span>
                  <span className="text-dim">== {String(p.expectedValue)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Recovery steps */}
        {plan.recoverySteps && plan.recoverySteps.length > 0 ? (
          <div className="space-y-1.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-dim">
              Recovery Steps on Failure
            </h2>
            <div className="space-y-1 border border-line bg-ink/30 p-2 text-xs">
              {plan.recoverySteps.map((rec, idx) => (
                <div key={idx} className="flex items-center gap-2 text-dim">
                  <FileText className="h-3.5 w-3.5 text-text" />
                  <span>{rec.description || rec.tool}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Explicit confirmation checkbox: prevents accidental Enter approval */}
        <div className="border border-line bg-panel p-3">
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-text select-none">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={
                isExpired ||
                isInvalidTimestamp ||
                busy ||
                submitting !== null ||
                isPreviewBlocked
              }
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded-none border-line bg-ink text-signal focus:ring-signal"
            />
            <span>
              I have verified the exact decrypted execution script, content, parameters, and targets above.
              I authorize the assistant to execute these operations on this host.
            </span>
          </label>
        </div>

        <AlertDialogFooter className="flex flex-wrap items-center justify-end gap-3 pt-3">
          <Button
            type="button"
            variant="outline"
            disabled={submitting !== null || busy}
            onClick={onClose}
            className="text-xs"
          >
            Close
          </Button>

          <Button
            type="button"
            variant="destructive"
            disabled={submitting !== null || busy}
            onClick={() => void handleDeny()}
            className="text-xs"
          >
            {submitting === "deny" ? (
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="mr-1.5 h-3.5 w-3.5" />
            )}
            Deny Plan
          </Button>

          <Button
            type="button"
            variant="default"
            disabled={
              !confirmed ||
              isExpired ||
              isInvalidTimestamp ||
              submitting !== null ||
              busy ||
              isPreviewBlocked
            }
            onClick={() => void handleApprove()}
            className="text-xs font-semibold"
          >
            {submitting === "approve" ? (
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            Approve & Dispatch
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}