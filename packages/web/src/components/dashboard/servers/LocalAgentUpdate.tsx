import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Info,
  LoaderCircle,
  PauseCircle,
} from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  ApiError,
  getLocalAgentUpgrade,
  getVpsAgentUpdate,
  isTerminalLocalUpgrade,
  requestVpsAgentUpdate,
  type AgentUpdateAutomation,
  type AgentUpdateAutomationState,
  type AgentUpdateCompatibility,
  type AgentUpdateState,
  type AgentUpdateStatus,
  type AgentUpdateView,
  type DashboardOverview,
  type LocalAgentUpgradeJob,
  type LocalAgentUpgradeState,
  type VpsRecord,
} from "../../../lib/api";
import { formatDate, freshnessLabel, vpsDisplayName } from "../../../lib/dashboard-formatters";
import { subscribeMonitoring } from "../../../lib/live-api";
import { DashboardContext } from "../../../context/DashboardContext";

/**
 * Agent update controls in VPS Settings.
 *
 * Consolidated for all managed hosts (local and remote):
 * - Reads deployment target and automation state from GET /api/vps/:id/agent-update.
 * - Triggers update/retry directly via POST /api/vps/:id/agent-update with Idempotency-Key.
 * - No confirmation wizard: busy/offline states enqueue intent and display waiting.
 * - Displays active progress, verified/unverified rollback results, and setup guidance.
 * - Collapsible technical details for inspection.
 * - Disables duplicate clicks while request is inflight; retransmits same key on retry.
 */

const STATUS_POLL_MS = 30_000;
const JOB_POLL_MS = 5_000;

const AUTOMATION_CHIPS: Record<
  AgentUpdateAutomationState,
  { label: string; variant: "ready" | "pending" | "destructive" | "outline" }
> = {
  current: { label: "Up to date", variant: "ready" },
  pending: { label: "Update available", variant: "pending" },
  waiting_busy: { label: "Waiting (busy)", variant: "pending" },
  waiting_connection: { label: "Waiting (offline)", variant: "pending" },
  updating: { label: "Updating", variant: "pending" },
  needs_access: { label: "Needs access", variant: "destructive" },
  failed: { label: "Update failed", variant: "destructive" },
  incompatible: { label: "Incompatible", variant: "destructive" },
  release_unavailable: { label: "Unavailable", variant: "outline" },
};

const STATE_CHIPS: Record<
  AgentUpdateState,
  { label: string; variant: "ready" | "pending" | "destructive" | "outline" }
> = {
  current: { label: "Up to date", variant: "ready" },
  available: { label: "Update available", variant: "pending" },
  incompatible: { label: "Incompatible", variant: "destructive" },
  release_unavailable: { label: "Update unavailable", variant: "outline" },
  updater_unavailable: { label: "Needs setup", variant: "destructive" },
  unknown: { label: "Update status unknown", variant: "destructive" },
};

const PHASE_LABELS: Record<LocalAgentUpgradeState, string> = {
  queued: "Queued",
  claimed: "Claimed by updater",
  downloading: "Downloading update",
  verifying: "Verifying binary checksum",
  staging: "Staging update",
  restarting: "Restarting agent",
  awaiting_heartbeat: "Waiting for fresh heartbeat",
  rolling_back: "Rolling back",
  succeeded: "Upgrade confirmed",
  rolled_back: "Rolled back",
  rollback_unverified: "Rollback unverified",
  failed: "Upgrade failed",
  deferred: "Deferred while busy",
  superseded: "Superseded by newer deployment",
};

function shortBuild(buildId?: string | null): string | null {
  return buildId ? buildId.slice(0, 12) : null;
}

function deriveFallbackAutomation(status: AgentUpdateView | null): AgentUpdateAutomation {
  if (!status) {
    return {
      state: "pending",
      reason: null,
      targetBuildId: null,
      retryAllowed: false,
    };
  }
  if (status.job && !isTerminalLocalUpgrade(status.job.state)) {
    return {
      state: "updating",
      reason: "An upgrade job is currently running on this host.",
      targetBuildId: status.job.releaseBuildId ?? status.available?.buildId ?? null,
      retryAllowed: false,
    };
  }
  if (status.state === "current") {
    return {
      state: "current",
      reason: null,
      targetBuildId: status.installed.buildId,
      retryAllowed: false,
    };
  }
  if (status.state === "incompatible") {
    return {
      state: "incompatible",
      reason: "Build is incompatible with host architecture or API contract.",
      targetBuildId: null,
      retryAllowed: false,
    };
  }
  if (status.state === "release_unavailable") {
    return {
      state: "release_unavailable",
      reason: "Bundled agent binary unavailable in this deployment.",
      targetBuildId: null,
      retryAllowed: false,
    };
  }
  if (status.state === "updater_unavailable") {
    return {
      state: "needs_access",
      reason: "Host updater daemon is not installed or requires access credentials.",
      targetBuildId: null,
      retryAllowed: true,
    };
  }
  if (status.job?.state === "rolled_back" || status.job?.state === "rollback_unverified" || status.job?.state === "failed") {
    return {
      state: "failed",
      reason: status.job.error?.message ?? status.job.result?.reason ?? "Previous upgrade attempt failed.",
      targetBuildId: status.job.releaseBuildId ?? status.available?.buildId ?? null,
      retryAllowed: true,
    };
  }
  if (!status.installed.fresh || !status.installed.buildId) {
    return {
      state: "waiting_connection",
      reason: "Agent heartbeat is stale or the build ID is missing.",
      targetBuildId: status.available?.buildId ?? null,
      retryAllowed: false,
    };
  }
  return {
    state: status.state === "available" ? "pending" : "pending",
    reason: null,
    targetBuildId: status.available?.buildId ?? null,
    retryAllowed: true,
  };
}

export type LocalAgentUpdateProps = {
  vps: VpsRecord;
  variant?: "card" | "table" | "workspace";
  jobs?: DashboardOverview["jobs"];
};

export function LocalAgentUpdate({ vps, variant = "card", jobs: propsJobs }: LocalAgentUpdateProps) {
  const displayName = vpsDisplayName(vps);
  const dashboard = useContext(DashboardContext);
  const isDemo = dashboard?.mode === "demo";

  const allJobs = propsJobs ?? dashboard?.jobs ?? [];
  const restartJob = allJobs.find(
    (j) => j.vpsId === vps.id && j.type === "restart-agent" && (j.status === "running" || j.status === "queued"),
  );
  const rotateJob = allJobs.find(
    (j) => j.vpsId === vps.id && j.type === "rotate-agent" && (j.status === "running" || j.status === "queued"),
  );

  const [status, setStatus] = useState<AgentUpdateStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [job, setJob] = useState<LocalAgentUpgradeJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const previousJobStateRef = useRef<LocalAgentUpgradeState | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const reasonId = useId();

  const applyStatus = useCallback((next: AgentUpdateStatus) => {
    setStatus(next);
    setLoadError(false);
    setJob((current) => {
      if (!current) return next.job;
      if (!next.job) return current;
      if (isTerminalLocalUpgrade(current.state) && !isTerminalLocalUpgrade(next.job.state)) {
        return next.job;
      }
      const currentStamp = Date.parse(current.updatedAt ?? "") || 0;
      const nextStamp = Date.parse(next.job.updatedAt ?? "") || 0;
      return nextStamp >= currentStamp ? next.job : current;
    });
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      applyStatus(await getVpsAgentUpdate(vps.id));
    } catch {
      setLoadError(true);
    }
  }, [vps.id, applyStatus]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await getVpsAgentUpdate(vps.id, controller.signal);
        if (!cancelled) applyStatus(next);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [vps.id, applyStatus]);

  const jobId = job?.id ?? null;
  const jobActive = Boolean(job && !isTerminalLocalUpgrade(job.state));

  const refreshJob = useCallback(
    async (signal?: AbortSignal) => {
      if (!jobId) return;
      try {
        const fresh = await getLocalAgentUpgrade(vps.id, jobId, signal);
        setJob(fresh);
        if (isTerminalLocalUpgrade(fresh.state)) {
          void refreshStatus();
        }
      } catch {
        // Fall back to general status refresh
        void refreshStatus();
      }
    },
    [vps.id, jobId, refreshStatus],
  );

  useEffect(() => {
    if (!jobId || !jobActive) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => void refreshJob(controller.signal), JOB_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [jobId, jobActive, refreshJob]);

  useEffect(() => {
    const refreshForEvent = () => {
      void refreshStatus();
      if (jobId && jobActive) void refreshJob();
    };
    return subscribeMonitoring({
      onMetricsUpdated: (metrics) => {
        if (metrics.metrics.some((metric) => metric.vpsId === vps.id)) refreshForEvent();
      },
      onSnapshot: () => refreshForEvent(),
      onJobsUpdated: () => refreshForEvent(),
    });
  }, [vps.id, jobId, jobActive, refreshJob, refreshStatus]);

  useEffect(() => {
    const currentState = job?.state ?? null;
    const previousState = previousJobStateRef.current;
    if (
      previousState &&
      !isTerminalLocalUpgrade(previousState) &&
      currentState &&
      isTerminalLocalUpgrade(currentState)
    ) {
      void refreshStatus();
    }
    previousJobStateRef.current = currentState;
  }, [job?.state, refreshStatus]);

  const handleUpdate = async () => {
    if (submitting || jobActive) return;

    let key = idempotencyKeyRef.current;
    if (!key) {
      key = crypto.randomUUID();
      idempotencyKeyRef.current = key;
    }

    setSubmitting(true);
    setActionError(null);

    try {
      const updatedStatus = await requestVpsAgentUpdate(vps.id, key);
      idempotencyKeyRef.current = null;
      applyStatus(updatedStatus);
      if (updatedStatus.job) {
        setJob(updatedStatus.job);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.payload?.error === "active_job_exists") {
        idempotencyKeyRef.current = null;
        void refreshStatus();
        return;
      }
      setActionError(
        err instanceof Error ? err.message : "The update request failed. You may retry safely.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const installed = status?.installed ?? null;
  const updater = status?.updater ?? null;
  const available = status?.available ?? null;
  const auto = status?.automation ?? deriveFallbackAutomation(status);
  const activeJob = job && !isTerminalLocalUpgrade(job.state) ? job : null;
  const resultJob = job && isTerminalLocalUpgrade(job.state) ? job : null;

  const showUpgrade =
    isDemo ||
    vps.agentStatus === "not_installed" ||
    vps.agentStatus === "installing" ||
    Boolean(restartJob) ||
    Boolean(rotateJob) ||
    (status !== null
      ? auto.state === "needs_access" ||
        (status.state !== "current" && status.state !== "release_unavailable")
      : true);

  const upgradeReason =
    jobActive
      ? "An upgrade job is already running for this server."
      : submitting
        ? "Starting update..."
        : isDemo
          ? "Agent upgrades are unavailable in demo mode."
          : vps.agentStatus === "not_installed"
            ? "Agent is not installed on this server."
            : vps.agentStatus === "installing"
              ? "An agent installation or upgrade is currently in progress."
              : restartJob
                ? "An agent restart is currently in progress."
                : rotateJob
                  ? "An agent credential rotation is currently in progress."
                  : auto.state === "current"
                    ? "Agent is already up to date with this deployment."
                    : auto.state === "incompatible"
                      ? auto.reason || "This deployment is incompatible with the server architecture."
                      : auto.state === "release_unavailable"
                        ? "Bundled agent binary is not available in this deployment."
                        : auto.state === "waiting_connection"
                          ? "Agent heartbeat is stale or the build ID is missing."
                          : null;

  const upgradeEnabled =
    showUpgrade &&
    !jobActive &&
    !submitting &&
    !isDemo &&
    vps.agentStatus !== "not_installed" &&
    vps.agentStatus !== "installing" &&
    !restartJob &&
    !rotateJob &&
    auto.state !== "waiting_connection" &&
    auto.state !== "incompatible" &&
    auto.state !== "release_unavailable" &&
    auto.state !== "current" &&
    (auto.retryAllowed ||
      auto.state === "pending" ||
      auto.state === "waiting_busy" ||
      auto.state === "failed" ||
      auto.state === "needs_access" ||
      status?.state === "available");

  const buttonText = submitting
    ? "Starting..."
    : auto.state === "failed" || resultJob?.state === "rolled_back" || resultJob?.state === "rollback_unverified"
      ? "Retry update"
      : auto.state === "needs_access"
        ? "Retry setup"
        : "Upgrade agent";

  const chip = status
    ? (AUTOMATION_CHIPS[auto.state] ?? STATE_CHIPS[status.state] ?? null)
    : null;

  // Render live job progress or terminal outcome
  let liveContent: React.ReactNode = null;
  if (activeJob) {
    const phaseLabel = PHASE_LABELS[activeJob.state] ?? activeJob.state;
    const pct = typeof activeJob.progress === "number" ? Math.round(activeJob.progress) : null;
    const shortRel = shortBuild(activeJob.releaseBuildId);
    liveContent = (
      <div className="space-y-2 border border-line bg-raised/30 p-3" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-text">
            <LoaderCircle size={13} className="animate-spin text-signal" />
            <span>{phaseLabel}</span>
          </span>
          <span className="text-[11px] text-dim">
            target {activeJob.releaseVersion}
            {shortRel ? <span className="ml-1 font-mono">({shortRel})</span> : null}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Agent upgrade progress"
          aria-valuenow={pct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 w-full overflow-hidden bg-panel"
        >
          {pct !== null ? (
            <div
              className="h-full bg-signal transition-[width] duration-300"
              style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
            />
          ) : (
            <div className="h-full w-1/3 animate-pulse bg-signal" />
          )}
        </div>
      </div>
    );
  } else if (resultJob) {
    if (resultJob.state === "succeeded") {
      const hb = shortBuild(resultJob.result?.heartbeatBuildId ?? resultJob.releaseBuildId);
      const isHistorical = status?.state === "available" || auto.state === "pending";

      liveContent = isHistorical ? (
        <div className="border border-line bg-raised/20 p-2.5 text-xs text-dim">
          <span>
            Previous upgrade — {resultJob.releaseVersion}
            {hb ? <span className="mx-1 font-mono">({hb})</span> : null} was confirmed by heartbeat.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 border border-signal/40 bg-signal/10 p-2.5 text-xs text-signal">
          <CheckCircle2 size={14} className="shrink-0" />
          <span>
            Agent {resultJob.releaseVersion}
            {hb ? <span className="mx-1 font-mono font-bold">({hb})</span> : null} is sending a fresh heartbeat.
          </span>
        </div>
      );
    } else if (resultJob.state === "rolled_back") {
      liveContent = (
        <div className="space-y-1.5 border border-warn/40 bg-warn/10 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-warn">
            <AlertTriangle size={14} />
            <span>Upgrade rolled back safely: previous build was verified by heartbeat.</span>
          </div>
          <p className="text-dim">
            {resultJob.error?.message ?? resultJob.result?.reason ?? "New build failed to confirm health within deadline."}
          </p>
          <p className="text-[11px] text-dim">
            Inspect host logs with <code className="font-mono text-text">journalctl -u vps-manager-agent</code>, then retry the upgrade.
          </p>
        </div>
      );
    } else if (resultJob.state === "rollback_unverified") {
      liveContent = (
        <div className="space-y-1.5 border border-crit/40 bg-crit/15 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-bold text-crit">
            <AlertTriangle size={14} />
            <span>Agent rollback is unverified — manual intervention required.</span>
          </div>
          <p className="text-text">
            {resultJob.error?.message ?? "The service failed to restore the previous binary or produce a heartbeat."}
          </p>
          <p className="text-[11px] text-dim">
            SSH into the host and run <code className="font-mono text-text">journalctl -u vps-manager-agent</code> to check service state.
          </p>
        </div>
      );
    } else if (resultJob.state === "deferred") {
      liveContent = (
        <div className="border border-line bg-raised/30 p-2.5 text-xs text-dim">
          <span>Upgrade was deferred because the host was actively running tasks. It will resume when idle.</span>
        </div>
      );
    } else if (resultJob.state === "superseded") {
      liveContent = (
        <div className="border border-line bg-raised/30 p-2.5 text-xs text-dim">
          <span>Previous update attempt was superseded by a newer deployment build.</span>
        </div>
      );
    } else if (resultJob.state === "failed") {
      liveContent = (
        <div className="space-y-1 border border-crit/30 bg-crit/10 p-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-crit">
            <AlertTriangle size={13} />
            <span>Upgrade failed before the agent was swapped:</span>
          </div>
          <p className="text-dim">{resultJob.error?.message ?? "Execution error"}</p>
        </div>
      );
    }
  }

  const details = (
    <div className="space-y-3">
      {/* Status Chip & Main Status Line */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {chip ? <Badge variant={chip.variant}>{chip.label}</Badge> : null}
          {installed?.version ? (
            <span className="text-xs text-text">
              Installed: v{installed.version}
              {installed.buildId ? (
                <span className="ml-1 font-mono text-[11px] text-dim">
                  ({shortBuild(installed.buildId)})
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs text-dim">
              {vps.agentStatus === "not_installed"
                ? "Agent not installed"
                : "Checking installed version..."}
            </span>
          )}
        </div>

        {/* Action Button */}
        {showUpgrade ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={upgradeEnabled ? "default" : "outline"}
              disabled={!upgradeEnabled}
              aria-describedby={upgradeReason ? reasonId : undefined}
              onClick={() => void handleUpdate()}
              className="h-8 gap-1.5 text-xs"
            >
              {submitting ? <LoaderCircle size={13} className="animate-spin" /> : null}
              <span>{buttonText}</span>
            </Button>
          </div>
        ) : null}
      </div>

      {/* Disabled Reason Notice for screen readers and visual hints */}
      {upgradeReason && showUpgrade && !upgradeEnabled ? (
        <p id={reasonId} className="text-[11px] text-dim">
          {upgradeReason}
        </p>
      ) : null}

      {/* Action Error Alert */}
      {actionError ? (
        <div role="alert" className="flex items-center gap-2 border border-crit/40 bg-crit/10 p-2.5 text-xs text-crit">
          <AlertTriangle size={13} className="shrink-0" />
          <span>{actionError}</span>
        </div>
      ) : null}

      {/* Live progress / outcomes */}
      {liveContent}

      {/* Automation Waiting notices */}
      {auto.state === "waiting_busy" && !liveContent ? (
        <div className="flex items-center gap-2 border border-warn/30 bg-warn/10 p-2.5 text-xs text-warn">
          <PauseCircle size={14} className="shrink-0" />
          <span>Server is busy with active tasks. Update will automatically apply when the host becomes idle.</span>
        </div>
      ) : null}

      {auto.state === "waiting_connection" && !liveContent ? (
        <div className="flex items-center gap-2 border border-line bg-raised/20 p-2.5 text-xs text-dim">
          <Clock size={14} className="shrink-0" />
          <span>Awaiting fresh agent heartbeat. Reconnect or restart agent if connection does not recover.</span>
        </div>
      ) : null}

      {auto.state === "needs_access" && !liveContent ? (
        <div className="space-y-1 border border-warn/40 bg-warn/15 p-2.5 text-xs text-warn">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={14} />
            <span>Host setup required</span>
          </div>
          <p className="text-dim">
            The updater daemon requires root or passwordless sudo privileges to install and swap binaries. Ensure valid SSH credentials are configured.
          </p>
        </div>
      ) : null}

      {/* Collapsible Technical Details */}
      <div className="border-t border-line/50 pt-2">
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex w-full items-center justify-between py-1 text-left text-[11px] text-dim hover:text-text focus-visible:outline-none"
        >
          <span className="flex items-center gap-1">
            <Info size={11} />
            <span>Technical details</span>
          </span>
          <ChevronDown
            size={12}
            className={`transition-transform duration-200 ${detailsOpen ? "rotate-180" : ""}`}
          />
        </button>

        {detailsOpen ? (
          <div className="mt-2 space-y-1.5 bg-raised/20 p-2.5 text-[11px]">
            <DetailRow label="Host ID" value={vps.id} mono />
            <DetailRow
              label="Installed Build"
              value={installed?.buildId ?? "unknown"}
              mono
            />
            <DetailRow
              label="Target Build"
              value={auto.targetBuildId ?? available?.buildId ?? "none"}
              mono
            />
            <DetailRow
              label="Agent Heartbeat"
              value={
                installed?.lastSeenAt
                  ? `${formatDate(installed.lastSeenAt)} (${freshnessLabel(installed.lastSeenAt)})`
                  : "never"
              }
            />
            <DetailRow
              label="Updater Daemon"
              value={
                updater?.installed
                  ? updater.healthy
                    ? "healthy"
                    : "stale heartbeat"
                  : "not installed"
              }
            />
            {status?.compatibility ? (
              <DetailRow
                label="API Contract"
                value={`v${status.compatibility.apiContractVersion} (${status.compatibility.reason})`}
              />
            ) : null}
            {auto.reason ? <DetailRow label="Automation Reason" value={auto.reason} /> : null}
          </div>
        ) : null}
      </div>

    </div>
  );

  if (variant === "table") {
    return details;
  }

  return (
    <div className="border border-line bg-panel p-4">
      <div className="mb-2">
        <h2 className="text-sm font-medium text-text">Agent updates</h2>
        <p className="mt-0.5 text-xs text-dim">
          Installs the bundled release in this deployment; completion is confirmed by a fresh
          heartbeat, not by the service status.
        </p>
      </div>
      {details}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-dim">{label}</span>
      <span className={`break-all text-right text-text ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
