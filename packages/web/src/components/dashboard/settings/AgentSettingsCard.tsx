import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { Switch } from "../../ui/switch";
import { getVpsAgentUpdate, type AgentUpdateView } from "../../../lib/api";
import {
  getAiBundle,
  getVpsAiCapability,
  getVpsAiPolicy,
  installAiBundle,
  patchVpsAiPolicy,
  type AiBundleJobState,
  type AiBundleStatus,
  type AiExecMode,
  type AiPolicy,
  type UpdateAiPolicy,
} from "../../../lib/ai-api";
import { cn } from "../../../lib/utils";
import { freshnessLabel } from "../../../lib/dashboard-formatters";

/**
 * Per-host "Agent" card in the VPS Settings page (execmode plan, Web slice).
 *
 * Owns the AI policy surface that moved out of the Assistant settings modal:
 * AI on/off, shell on/off, sandbox/privileged execution mode (first switch to
 * privileged requires a one-time risk acknowledgment), a compact agent
 * version row, and the AI bundle install/update row with the real sandbox
 * capability diagnosis. Data loads lazily when the card mounts; runtime rows
 * refresh on window focus and poll while an install job is active. Every
 * section fails independently so a missing endpoint never blocks the page.
 */

const BUNDLE_JOB_POLL_MS = 5_000;

function shortId(id: string | null | undefined): string | null {
  return id ? id.slice(0, 12) : null;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const BUNDLE_JOB_LABELS: Record<AiBundleJobState, string> = {
  pending: "install queued",
  running: "installing",
  succeeded: "last install succeeded",
  failed: "last install failed",
};

type CapabilityView = {
  supported: boolean;
  reason?: string;
  agentVersion?: string;
  /** null = unknown (bundle endpoint absent; standalone capability cannot say). */
  privilegedSupported: boolean | null;
};

function capabilityView(
  bundle: AiBundleStatus | null,
  fallback: { supported?: boolean; reason?: string; agentVersion?: string } | null,
): CapabilityView | null {
  const fromBundle = bundle?.capability;
  if (fromBundle) {
    return {
      supported: fromBundle.supported === true,
      reason: fromBundle.reason,
      agentVersion: fromBundle.agentVersion,
      privilegedSupported: fromBundle.privilegedSupported === true,
    };
  }
  if (fallback && typeof fallback.supported === "boolean") {
    return {
      supported: fallback.supported,
      reason: fallback.reason,
      agentVersion: fallback.agentVersion,
      privilegedSupported: null,
    };
  }
  return null;
}

function ToggleRow({
  icon,
  title,
  description,
  actionLabel,
  testId,
  enabled,
  pending,
  disabled,
  onToggle,
  error,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  testId: string;
  enabled: boolean;
  pending: boolean;
  disabled: boolean;
  onToggle: () => void;
  error: string | null;
}) {
  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text">{title}</h3>
            <p className="mt-0.5 text-xs text-dim">{description}</p>
          </div>
        </div>
        <Switch
          checked={enabled}
          pending={pending}
          disabled={disabled}
          aria-label={`${enabled ? "Disable" : "Enable"} ${actionLabel}`}
          data-testid={testId}
          onCheckedChange={onToggle}
        />
      </div>
      {error ? (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"
        >
          <AlertCircle
            size={16}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

export function AgentSettingsCard({ vpsId }: { vpsId: string }) {
  // Policy (AI / shell toggles, execution mode)
  const [policy, setPolicy] = useState<AiPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [aiPending, setAiPending] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [shellPending, setShellPending] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [execPending, setExecPending] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);

  // Runtime rows (agent version, AI bundle + capability)
  const [agentUpdate, setAgentUpdate] = useState<AgentUpdateView | null>(null);
  const [agentUpdateError, setAgentUpdateError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<AiBundleStatus | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [standaloneCapability, setStandaloneCapability] = useState<{
    supported?: boolean;
    reason?: string;
    agentVersion?: string;
  } | null>(null);
  const [installPending, setInstallPending] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const ackReasonId = useId();
  const installReasonId = useId();

  const loadPolicy = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await getVpsAiPolicy(vpsId, signal);
        setPolicy(next);
        setPolicyError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setPolicyError(errorMessage(err, "AI policy is unavailable."));
      }
    },
    [vpsId],
  );

  // Bundle + capability + agent-update fail independently; the standalone
  // capability endpoint (available on older APIs) backs the sandbox
  // diagnosis in when the bundle endpoint is missing.
  const loadRuntime = useCallback(
    async (signal?: AbortSignal) => {
      const [bundleRes, capRes, updateRes] = await Promise.allSettled([
        getAiBundle(vpsId, signal),
        getVpsAiCapability(vpsId, signal),
        getVpsAgentUpdate(vpsId, signal),
      ]);
      if (signal?.aborted) return;
      if (bundleRes.status === "fulfilled") {
        setBundle(bundleRes.value);
        setBundleError(null);
      } else {
        setBundleError(errorMessage(bundleRes.reason, "AI bundle status is unavailable."));
      }
      if (capRes.status === "fulfilled") {
        const cap = capRes.value;
        setStandaloneCapability(
          cap
            ? {
                supported: cap.supported,
                reason: cap.reason,
                agentVersion: cap.agentVersion,
              }
            : null,
        );
      }
      if (updateRes.status === "fulfilled") {
        setAgentUpdate(updateRes.value);
        setAgentUpdateError(null);
      } else {
        setAgentUpdateError(errorMessage(updateRes.reason, "Agent version is unavailable."));
      }
    },
    [vpsId],
  );

  // Lazy load: only when the card mounts (the Settings tab renders it).
  useEffect(() => {
    const controller = new AbortController();
    void loadPolicy(controller.signal);
    void loadRuntime(controller.signal);
    return () => controller.abort();
  }, [loadPolicy, loadRuntime]);

  // Keep runtime rows fresh on window focus (install state changes while the
  // tab was away) and poll while an install job is in flight.
  useEffect(() => {
    const onFocus = () => {
      void loadPolicy();
      void loadRuntime();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadPolicy, loadRuntime]);

  const bundleJobState = bundle?.lastJob?.state ?? null;
  const bundleJobActive =
    bundleJobState === "pending" || bundleJobState === "running";

  useEffect(() => {
    if (!bundleJobActive) return;
    const timer = window.setInterval(() => void loadRuntime(), BUNDLE_JOB_POLL_MS);
    return () => window.clearInterval(timer);
  }, [bundleJobActive, loadRuntime]);

  const execMode: AiExecMode = policy?.execMode === "privileged" ? "privileged" : "sandbox";
  const policyControlsDisabled = policy === null;

  const applyExecMode = async (patch: UpdateAiPolicy) => {
    if (execPending) return;
    setExecPending(true);
    setExecError(null);
    try {
      const next = await patchVpsAiPolicy(vpsId, patch);
      setPolicy(next);
      setPolicyError(null);
      setAckOpen(false);
    } catch (err) {
      setExecError(errorMessage(err, "Failed to update the execution mode."));
    } finally {
      setExecPending(false);
    }
  };

  const selectExecMode = (mode: AiExecMode) => {
    if (!policy || execPending || mode === execMode) return;
    // First switch to privileged requires the one-time acknowledgment
    // (ack modal); a retained acknowledgment switches directly (plan Q4).
    if (mode === "privileged" && policy.privilegedAcknowledgedAt == null) {
      setAckChecked(false);
      setExecError(null);
      setAckOpen(true);
      return;
    }
    void applyExecMode({ execMode: mode });
  };

  const confirmPrivileged = () => {
    if (!ackChecked) return;
    void applyExecMode({ execMode: "privileged", acknowledgePrivileged: true });
  };

  const togglePolicyFlag = async (field: "aiEnabled" | "shellEnabled") => {
    if (!policy) return;
    const isAi = field === "aiEnabled";
    const setPending = isAi ? setAiPending : setShellPending;
    const setError = isAi ? setAiError : setShellError;
    if ((isAi ? aiPending : shellPending)) return;
    const next = !policy[field];
    setPending(true);
    setError(null);
    try {
      const updated = await patchVpsAiPolicy(vpsId, { [field]: next });
      setPolicy(updated);
      setPolicyError(null);
    } catch (err) {
      setError(
        errorMessage(
          err,
          isAi
            ? "Failed to update the AI setting."
            : "Failed to update the shell setting.",
        ),
      );
    } finally {
      setPending(false);
    }
  };

  const installBundle = async () => {
    if (installPending || bundleJobActive || bundle?.available !== true) return;
    setInstallPending(true);
    setInstallError(null);
    try {
      const job = await installAiBundle(vpsId);
      setBundle((prev) => (prev ? { ...prev, lastJob: job } : prev));
    } catch (err) {
      setInstallError(
        errorMessage(err, "Failed to start the AI bundle install."),
      );
    } finally {
      setInstallPending(false);
    }
  };

  const installedAgent = agentUpdate?.installed ?? null;
  const agentBuild = shortId(installedAgent?.buildId);
  const capView = capabilityView(bundle, standaloneCapability);

  const installEnabled =
    bundle !== null && bundleError === null && bundle.available === true && !bundleJobActive;
  // A bundle load error is already rendered on the bundle line; only the
  // actionable disabled reasons need a separate hint.
  const installDisabledReason = bundleError
    ? null
    : bundle === null
      ? "Checking AI bundle status…"
      : !bundle.available
        ? (bundle.reason ?? "AI bundle artifacts are not included in this deployment.")
        : bundleJobActive
          ? "An install or update job is already running."
          : null;

  const bundleLine = bundleError
    ? bundleError
    : bundle === null
      ? "Checking AI bundle…"
      : [
          bundle.installed ? "Installed" : "Not installed",
          bundle.installed && bundle.bundleId
            ? `bundle ${shortId(bundle.bundleId)}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <Card className="min-w-0 overflow-hidden" data-testid="agent-settings-card" data-policy-revision={policy?.revision ?? ""}>
      <CardHeader className="border-b border-line p-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Agent</CardTitle>
          <span className="border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-dim">
            This host
          </span>
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-line p-0">
        {policyError ? (
          <div className="p-4">
            <div
              role="alert"
              className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"
            >
              <AlertCircle
                size={16}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span>{policyError}</span>
            </div>
          </div>
        ) : null}

        <ToggleRow
          icon={
            <Bot size={16} className="shrink-0 text-dim" aria-hidden="true" />
          }
          title="AI assistant"
          description="Assistant chat, plans, and tools for this host."
          actionLabel="AI assistant"
          testId="agent-ai-toggle"
          enabled={policy?.aiEnabled === true}
          pending={aiPending}
          disabled={policyControlsDisabled}
          onToggle={() => void togglePolicyFlag("aiEnabled")}
          error={aiError}
        />

        <ToggleRow
          icon={
            <TerminalSquare
              size={16}
              className="shrink-0 text-dim"
              aria-hidden="true"
            />
          }
          title="Shell commands"
          description="Lets the assistant run shell commands; every command still needs your approval."
          actionLabel="AI shell commands"
          testId="agent-shell-toggle"
          enabled={policy?.shellEnabled === true}
          pending={shellPending}
          disabled={policyControlsDisabled}
          onToggle={() => void togglePolicyFlag("shellEnabled")}
          error={shellError}
        />

        <div className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text">
                Execution mode
              </h3>
              <p className="mt-0.5 text-xs text-dim">
                {execMode === "privileged"
                  ? "Shell commands run as root directly on the host — no sandbox. Every command still needs your approval."
                  : "Shell commands run inside the AI sandbox on the host."}
              </p>
            </div>
            <div
              role="group"
              aria-label="Execution mode"
              className="flex shrink-0 border border-line"
            >
              <button
                type="button"
                data-testid="exec-mode-sandbox"
                aria-pressed={execMode === "sandbox"}
                disabled={policyControlsDisabled || execPending}
                onClick={() => selectExecMode("sandbox")}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors duration-160 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-60",
                  execMode === "sandbox"
                    ? "bg-signal/10 text-signal"
                    : "text-dim hover:bg-raised/40 hover:text-text",
                )}
              >
                Sandbox
              </button>
              <button
                type="button"
                data-testid="exec-mode-privileged"
                aria-pressed={execMode === "privileged"}
                disabled={policyControlsDisabled || execPending}
                onClick={() => selectExecMode("privileged")}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors duration-160 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal disabled:cursor-not-allowed disabled:opacity-60",
                  execMode === "privileged"
                    ? "bg-crit/10 text-crit"
                    : "text-dim hover:bg-raised/40 hover:text-text",
                )}
              >
                Privileged
              </button>
            </div>
          </div>
          {execError ? (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"
            >
              <AlertCircle
                size={16}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span>{execError}</span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text">Agent version</h3>
            <p
              className="mt-0.5 text-xs text-dim"
              data-testid="agent-version-line"
            >
              {agentUpdateError ? (
                <span className="text-crit">{agentUpdateError}</span>
              ) : installedAgent?.version ? (
                <>
                  <span className="font-medium text-text">
                    v{installedAgent.version}
                  </span>
                  {agentBuild ? (
                    <span className="ml-1.5 font-mono">({agentBuild})</span>
                  ) : null}
                  {installedAgent.lastSeenAt ? (
                    <span className="ml-1.5">
                      · last seen {freshnessLabel(installedAgent.lastSeenAt)}
                    </span>
                  ) : null}
                </>
              ) : (
                "Not reported yet"
              )}
            </p>
          </div>
          {!agentUpdateError && installedAgent ? (
            installedAgent.fresh ? (
              <Badge variant="ready">Fresh</Badge>
            ) : (
              <Badge variant="warning">Stale</Badge>
            )
          ) : null}
        </div>

        <div className="space-y-2.5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text">AI bundle</h3>
              <p
                className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-dim"
                data-testid="ai-bundle-line"
              >
                <span className={bundleError ? "text-crit" : undefined}>
                  {bundleLine}
                </span>
                {bundleJobActive ? (
                  <span className="inline-flex items-center gap-1 text-info">
                    <LoaderCircle
                      size={12}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {bundleJobState === "pending" ? "install queued" : "installing"}
                  </span>
                ) : bundleJobState ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      bundleJobState === "succeeded"
                        ? "text-signal"
                        : bundleJobState === "failed"
                          ? "text-crit"
                          : undefined,
                    )}
                  >
                    {bundleJobState === "succeeded" ? (
                      <CheckCircle2
                        size={12}
                        className="shrink-0"
                        aria-hidden="true"
                      />
                    ) : bundleJobState === "failed" ? (
                      <AlertTriangle
                        size={12}
                        className="shrink-0"
                        aria-hidden="true"
                      />
                    ) : null}
                    {BUNDLE_JOB_LABELS[bundleJobState]}
                  </span>
                ) : null}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant={installEnabled ? "default" : "outline"}
              disabled={!installEnabled || installPending}
              aria-describedby={
                installDisabledReason ? installReasonId : undefined
              }
              data-testid="ai-bundle-install"
              onClick={() => void installBundle()}
              className="h-8 gap-1.5 text-xs"
            >
              {installPending ? (
                <LoaderCircle
                  size={13}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              {bundle?.installed ? "Update AI bundle" : "Install AI bundle"}
            </Button>
          </div>
          {installDisabledReason && !installEnabled ? (
            <p id={installReasonId} className="text-[11px] text-dim">
              {installDisabledReason}
            </p>
          ) : null}
          {installError ? (
            <div
              role="alert"
              className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-2.5 text-xs text-crit"
            >
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{installError}</span>
            </div>
          ) : null}
          {bundle?.lastJob?.state === "failed" && bundle.lastJob.error ? (
            <p className="text-[11px] text-crit" data-testid="ai-bundle-job-error">
              {bundle.lastJob.error}
            </p>
          ) : null}

          {/* Capability diagnosis: the real sandbox_unavailable reason */}
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-testid="ai-capability-badges"
          >
            {capView ? (
              capView.supported ? (
                <Badge variant="ready">
                  <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />
                  Sandbox ready
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />
                  Sandbox unavailable
                </Badge>
              )
            ) : (
              <Badge variant="default">Sandbox status unknown</Badge>
            )}
            {capView?.privilegedSupported === true ? (
              <Badge variant="ready">Privileged ready</Badge>
            ) : capView?.privilegedSupported === false ? (
              <Badge variant="warning">Privileged unavailable</Badge>
            ) : null}
          </div>
          {capView && !capView.supported && capView.reason ? (
            <p className="text-[11px] text-dim" data-testid="ai-capability-reason">
              {capView.reason}
            </p>
          ) : null}
        </div>
      </CardContent>

      {ackOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="agent-exec-ack-title"
        >
          <div
            className="w-full max-w-md border border-line bg-panel p-5"
            data-testid="exec-ack-modal"
          >
            <div className="flex items-center gap-2">
              <ShieldAlert
                size={18}
                className="shrink-0 text-warn"
                aria-hidden="true"
              />
              <h4
                id="agent-exec-ack-title"
                className="text-sm font-semibold text-text"
              >
                Enable privileged execution
              </h4>
            </div>
            <p className="mt-3 text-xs leading-5 text-dim">
              AI shell commands will run as root directly on the host — outside
              the sandbox, with no namespace, cgroup, or filesystem isolation.
            </p>
            <p className="mt-2 text-xs leading-5 text-dim">
              What still protects the host: every command is shown for manual
              approval before it runs, protected targets and redaction stay
              enforced, and all activity is audited.
            </p>
            <label className="mt-3 flex items-center gap-2 text-xs font-medium text-text">
              <input
                type="checkbox"
                data-testid="exec-ack-checkbox"
                checked={ackChecked}
                onChange={(e) => setAckChecked(e.target.checked)}
                aria-label="I understand the risk of privileged execution"
                className="h-3.5 w-3.5"
              />
              <span>I understand the risk</span>
            </label>
            {execError ? (
              <p role="alert" className="mt-2 text-xs text-crit">
                {execError}
              </p>
            ) : null}
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAckOpen(false)}
                disabled={execPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                data-testid="exec-ack-confirm"
                disabled={!ackChecked || execPending}
                onClick={() => void confirmPrivileged()}
              >
                {execPending ? (
                  <LoaderCircle
                    size={13}
                    className="mr-1.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                Enable privileged
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
