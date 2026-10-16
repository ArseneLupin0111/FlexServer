import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, LoaderCircle, RefreshCw } from "lucide-react";
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
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card";
import {
  ApiError,
  createLocalAgentUpgrade,
  getLocalAgentUpgrade,
  getVpsAgentUpdate,
  isTerminalLocalUpgrade,
  upgradeAgent,
  type AgentUpdateCompatibility,
  type AgentUpdateState,
  type AgentUpdateStatus,
  type LocalAgentUpgradeJob,
  type LocalAgentUpgradeState,
  type DashboardOverview,
  type VpsRecord,
} from "../../../lib/api";
import { formatDate, freshnessLabel, vpsDisplayName } from "../../../lib/dashboard-formatters";
import { subscribeMonitoring } from "../../../lib/live-api";
import { DashboardContext } from "../../../context/DashboardContext";
import { agentJobFor } from "./AgentLifecycleStatus";

/**
 * Agent update controls in VPS Settings.
 *
 * Single source of truth for agent update actions:
 * - Local system hosts (kind="local" or managedBy="system") use the bundled
 *   binary deployment workflow with pull-based daemon updater and heartbeat verification.
 * - Remote SSH hosts use SSH-based agent upgrades with confirmation, progress tracking,
 *   and capability gating.
 *
 * Local upgrade jobs live in a durable store outside the dashboard jobs feed,
 * so progress is read back from the persisted job endpoint. Remote agent upgrades
 * trigger background jobs tracked through DashboardContext or the upgrade-agent API.
 */

const JOB_POLL_MS = 5_000;
const STATUS_POLL_MS = 30_000;
/** Debounce for SSE-triggered job re-reads (mirrors the dashboard's 250ms invalidation debounce). */
const LIVE_REFRESH_DEBOUNCE_MS = 250;

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
};

const STATE_CHIPS: Record<
  AgentUpdateState,
  { label: string; variant: "ready" | "pending" | "destructive" | "outline" }
> = {
  unknown: { label: "Update status unknown", variant: "outline" },
  current: { label: "Agent up to date", variant: "ready" },
  available: { label: "Update available", variant: "pending" },
  incompatible: { label: "Update blocked", variant: "destructive" },
  release_unavailable: { label: "Bundled agent unavailable", variant: "pending" },
  updater_unavailable: { label: "Updater not installed", variant: "pending" },
};

const REMOTE_STATUS_CHIPS: Record<
  NonNullable<VpsRecord["agentStatus"]>,
  { label: string; variant: "ready" | "pending" | "destructive" | "outline" }
> = {
  online: { label: "Agent online", variant: "ready" },
  installing: { label: "Agent installing", variant: "pending" },
  offline: { label: "Agent offline", variant: "pending" },
  failed: { label: "Agent failed", variant: "destructive" },
  not_installed: { label: "Agent not installed", variant: "outline" },
};

const INCOMPATIBLE_REASONS: Record<AgentUpdateCompatibility["reason"], string> = {
  ok: "This build is not compatible with this server.",
  api_incompatible: "The bundled build targets a newer dashboard API contract than this one.",
  unsupported_architecture: "No bundled agent artifact matches this host's operating system and architecture.",
  release_unavailable: "The bundled agent binary is unavailable in this deployment — try again shortly.",
  unknown: "Compatibility could not be determined for the bundled agent build.",
};

const JOB_RUNNING_REASON = "An upgrade job is already running for this server.";

/**
 * Every update state has a concrete disabled reason — there is deliberately no
 * generic "unavailable" fallback. Reasons for the reachable states (unknown,
 * incompatible, submitting, job running) are chosen inline below; this map is
 * the state-specific residual.
 */
const STATE_DISABLED_REASONS: Record<AgentUpdateState, string> = {
  unknown: "Cannot verify the running build: the agent heartbeat is stale or the build ID is missing.",
  current: "The agent is already up to date.",
  available: "The updater is not reporting a healthy heartbeat.",
  incompatible: "This build is not compatible with this server.",
  release_unavailable: "The bundled agent binary is unavailable in this deployment — try again shortly.",
  updater_unavailable: "The updater is not installed on this server.",
};

function shortBuild(buildId?: string | null): string | null {
  return buildId ? buildId.slice(0, 12) : null;
}

function apiErrorCode(error: unknown): { code?: string; jobId?: string } {
  if (!(error instanceof ApiError)) return {};
  const payload = error.payload;
  return {
    code: typeof payload?.code === "string" ? payload.code : undefined,
    jobId: typeof payload?.jobId === "string" ? payload.jobId : undefined,
  };
}

function agentStatusLabel(status?: VpsRecord["agentStatus"]): string {
  switch (status) {
    case "not_installed":
      return "Agent not installed";
    case "installing":
      return "Agent installing";
    case "online":
      return "Agent online";
    case "offline":
      return "Agent offline";
    case "failed":
      return "Agent failed";
    default:
      return "Unknown";
  }
}

export type LocalAgentUpdateProps = {
  vps: VpsRecord;
  variant?: "card" | "table" | "workspace";
  jobs?: DashboardOverview["jobs"];
};

export function LocalAgentUpdate({ vps, jobs }: LocalAgentUpdateProps) {
  const isLocal = vps.kind === "local" || vps.managedBy === "system";
  if (isLocal) {
    return <LocalHostAgentUpdate vps={vps} />;
  }
  return <RemoteAgentUpdate vps={vps} jobs={jobs} />;
}

function LocalHostAgentUpdate({ vps }: { vps: VpsRecord }) {
  const displayName = vpsDisplayName(vps);

  const [status, setStatus] = useState<AgentUpdateStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [job, setJob] = useState<LocalAgentUpgradeJob | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const previousJobStateRef = useRef<LocalAgentUpgradeState | null>(null);
  /** Shared id so the disabled Upgrade button can reference its reason (aria-describedby). */
  const reasonId = useId();
  const upgradeTriggerRef = useRef<HTMLButtonElement>(null);

  const applyStatus = useCallback((next: AgentUpdateStatus) => {
    setStatus(next);
    setLoadError(false);
    setJob((current) => {
      if (!next.job) return current;
      if (!current || current.id !== next.job.id) return next.job;
      if (!isTerminalLocalUpgrade(current.state)) return current; // live job wins; we poll it directly
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

  // Agent-update: load once on mount, then refresh every 30s (freshness,
  // bundled build pointer, jobs started elsewhere).
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
        if (signal?.aborted) return;
        if (fresh.id === jobId) setJob(fresh);
      } catch {
        // Transient failure: the next nudge or poll tick retries; persisted
        // state on the server is intact.
      }
    },
    [vps.id, jobId],
  );

  // Persisted job: poll while non-terminal (reload-safe) as the fallback that
  // works even when the SSE stream is quiet or disconnected.
  useEffect(() => {
    if (!jobId || !jobActive) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => void refreshJob(controller.signal), JOB_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [jobId, jobActive, refreshJob]);

  // Timely refresh through the existing SSE mechanism (subscribeMonitoring —
  // never a second EventSource implementation): while a job is live, stream
  // activity re-reads the persisted job endpoint immediately (debounced)
  // instead of waiting for the next poll tick. Only an event scoped to this
  // host (metrics for this vps) or a full snapshot resync nudges; heartbeat
  // and jobs.updated belong to the dashboard-wide feed and stay poll-driven.
  useEffect(() => {
    if (!jobId || !jobActive) return;
    if (typeof EventSource === "undefined") return; // environment without SSE: poll-only fallback
    const controller = new AbortController();
    let nudgeTimer: number | null = null;
    const nudge = () => {
      if (nudgeTimer !== null) return;
      nudgeTimer = window.setTimeout(() => {
        nudgeTimer = null;
        void refreshJob(controller.signal);
      }, LIVE_REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeMonitoring({
      onSnapshot: nudge,
      onMetricsUpdated: (payload) => {
        if (payload.metrics.some((metric) => metric.vpsId === vps.id)) nudge();
      },
    });
    return () => {
      controller.abort();
      if (nudgeTimer !== null) window.clearTimeout(nudgeTimer);
      unsubscribe();
    };
  }, [jobId, jobActive, vps.id, refreshJob]);

  // When a job we watched crosses into a terminal state, refresh the status
  // once so the installed build/availability reflect the confirmed heartbeat.
  useEffect(() => {
    if (!job) {
      previousJobStateRef.current = null;
      return;
    }
    const previous = previousJobStateRef.current;
    previousJobStateRef.current = job.state;
    if (
      previous &&
      previous !== job.state &&
      !isTerminalLocalUpgrade(previous) &&
      isTerminalLocalUpgrade(job.state)
    ) {
      void refreshStatus();
    }
  }, [job, refreshStatus]);

  async function confirmUpgrade() {
    if (!status?.available || submitting) return;
    const releaseId = status.available.releaseId;
    setSubmitting(true);
    setActionError(null);
    try {
      const created = await createLocalAgentUpgrade(vps.id, {
        releaseId,
        idempotencyKey: crypto.randomUUID(),
      });
      setJob(created);
      setConfirmOpen(false);
    } catch (error) {
      const { code, jobId: existingJobId } = apiErrorCode(error);
      if (code === "active_job_exists") {
        setConfirmOpen(false);
        if (existingJobId) {
          try {
            setJob(await getLocalAgentUpgrade(vps.id, existingJobId));
          } catch {
            void refreshStatus();
          }
        } else {
          void refreshStatus();
        }
      } else if (code === "release_changed") {
        void refreshStatus();
        setActionError(
          "The target build changed since this dialog opened. Review the new target and confirm again.",
        );
      } else {
        setActionError(
          error instanceof Error ? error.message : "The upgrade request failed. Try again.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  const installed = status?.installed ?? null;
  const updater = status?.updater ?? null;
  const available = status?.available ?? null;
  const activeJob = job && !isTerminalLocalUpgrade(job.state) ? job : null;
  const resultJob = job && isTerminalLocalUpgrade(job.state) ? job : null;
  const chip = status ? STATE_CHIPS[status.state] : null;

  const showUpgrade = Boolean(
    status &&
      updater?.installed &&
      (activeJob ||
        (available && status.state !== "current" && status.state !== "updater_unavailable")),
  );
  const upgradeEnabled = Boolean(
    showUpgrade && !activeJob && status?.state === "available" && updater?.healthy && !submitting,
  );

  // Every disabled state carries a concrete reason; no generic fallback.
  let upgradeReason: string | null = null;
  if (showUpgrade && !upgradeEnabled) {
    if (activeJob) {
      upgradeReason = JOB_RUNNING_REASON;
    } else if (status?.state === "incompatible") {
      upgradeReason = INCOMPATIBLE_REASONS[status.compatibility.reason];
    } else if (submitting) {
      upgradeReason = "Starting the upgrade…";
    } else if (status) {
      upgradeReason = STATE_DISABLED_REASONS[status.state];
    }
  }

  const displayedReason = upgradeReason;

  const dialogInstalledText = installed
    ? installed.buildId
      ? `Agent ${installed.version ?? "unknown"} (${shortBuild(installed.buildId)})`
      : `Agent ${installed.version ?? "unknown"}`
    : null;
  const dialogHeartbeatText = installed
    ? installed.fresh
      ? `heartbeat ${freshnessLabel(installed.lastSeenAt ?? undefined)}`
      : `heartbeat stale (${freshnessLabel(installed.lastSeenAt ?? undefined)})`
    : null;
  const installedText = dialogInstalledText;
  const heartbeatText = dialogHeartbeatText;

  let liveContent: React.ReactNode = null;
  if (activeJob) {
    const determinate = typeof activeJob.progress === "number";
    const percent = determinate
      ? Math.min(100, Math.max(0, Math.round(activeJob.progress as number)))
      : null;
    liveContent = (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-info">
        <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
        <span>{PHASE_LABELS[activeJob.state]}</span>
        <span className="text-dim">
          target {activeJob.releaseVersion} ({shortBuild(activeJob.releaseBuildId)})
        </span>
        {percent !== null ? (
          <span className="tabular-nums text-text">{percent}%</span>
        ) : null}
        {percent !== null ? (
          <div
            role="progressbar"
            aria-label={`Agent upgrade progress for ${displayName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full max-w-56 overflow-hidden rounded-none bg-raised"
          >
            <div
              className="h-full rounded-none bg-info transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
      </div>
    );
  } else if (resultJob) {
    const completedAt = resultJob.completedAt ?? undefined;
    const finishedAt = completedAt ? `completed ${freshnessLabel(completedAt)}` : "";
    if (resultJob.state === "succeeded") {
      const confirmedBuild =
        resultJob.result?.heartbeatBuildId ??
        resultJob.result?.reportedBuildId ??
        resultJob.releaseBuildId;
      const isHistorical = Boolean(status?.state === "available");
      liveContent = (
        <div
          className={
            isHistorical
              ? "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim"
              : "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-signal"
          }
        >
          <CheckCircle2 size={13} aria-hidden="true" className={isHistorical ? "text-dim" : undefined} />
          <span>
            {isHistorical
              ? `Previous upgrade — ${resultJob.releaseVersion} (${shortBuild(confirmedBuild)}) was confirmed by heartbeat.`
              : `Upgrade confirmed — ${resultJob.releaseVersion} (${shortBuild(confirmedBuild)}) is sending a fresh heartbeat.`}
          </span>
          {finishedAt ? (
            <span className="text-dim" title={formatDate(completedAt)}>
              {finishedAt}
            </span>
          ) : null}
        </div>
      );
    } else if (resultJob.state === "rolled_back") {
      liveContent = (
        <div className="space-y-1 text-xs text-warn">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>
              Upgrade failed and rolled back — the previous build was verified by heartbeat.
              {resultJob.error ? ` ${resultJob.error.message}` : ""}
            </span>
            {finishedAt ? (
              <span className="text-dim" title={formatDate(completedAt)}>
                {finishedAt}
              </span>
            ) : null}
          </div>
          <p className="text-dim">
            The previous build is still running — inspect the failed step on the host with
            <span className="font-mono"> journalctl -u vps-manager-agent</span>, then retry the upgrade.
          </p>
        </div>
      );
    } else if (resultJob.state === "rollback_unverified") {
      liveContent = (
        <div className="space-y-1 text-xs text-crit">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>
              Upgrade failed and the rollback is unverified — manual intervention required.
            </span>
            {finishedAt ? (
              <span className="text-dim" title={formatDate(completedAt)}>
                {finishedAt}
              </span>
            ) : null}
          </div>
          <p className="text-dim">
            No fresh heartbeat arrived after the swap deadline. On the host, run
            <span className="font-mono"> systemctl status vps-manager-agent</span> and
            <span className="font-mono"> journalctl -u vps-manager-agent</span>, confirm which build is
            running, and restore the previous binary from your backup before treating this server as upgraded.
          </p>
        </div>
      );
    } else {
      liveContent = (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-crit">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>
            Upgrade failed before the agent was swapped.
            {resultJob.error ? ` ${resultJob.error.message}` : ""}
          </span>
          {finishedAt ? (
            <span className="text-dim" title={formatDate(completedAt)}>
              {finishedAt}
            </span>
          ) : null}
        </div>
      );
    }
  }

  const actions = showUpgrade ? (
    <Button
      ref={upgradeTriggerRef}
      type="button"
      size="sm"
      variant="default"
      disabled={!upgradeEnabled}
      aria-describedby={upgradeReason ? reasonId : undefined}
      onClick={() => {
        setActionError(null);
        setConfirmOpen(true);
      }}
    >
      Upgrade agent
    </Button>
  ) : null;

  const retryRow = loadError ? (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-dim">
      <span>Update status unavailable.</span>
      <Button type="button" size="sm" variant="outline" className="text-[11px]" onClick={() => void refreshStatus()}>
        <RefreshCw size={12} />
        Retry
      </Button>
    </div>
  ) : null;

  const details = status ? (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {chip ? (
          <Badge
            variant={chip.variant}
            className="text-[10px] uppercase tracking-wide"
          >
            {chip.label}
          </Badge>
        ) : null}
        {installedText ? <span className="text-xs text-text">{installedText}</span> : null}
        {heartbeatText ? (
          <span
            className={`text-[11px] ${installed?.fresh ? "text-dim" : "text-warn/80"}`}
            title={formatDate(installed?.lastSeenAt ?? undefined)}
          >
            {heartbeatText}
          </span>
        ) : null}
      </div>
      {showUpgrade ? (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
      {displayedReason ? (
        <p id={reasonId} className="text-[11px] text-dim">{displayedReason}</p>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-[11px] text-crit">
          {actionError}
        </p>
      ) : null}
      {/* Persistent empty live region: job start/results are only reliably
          announced when the container already exists before the content is
          inserted, so it stays mounted whenever the status details render. */}
      <div role="status" aria-live="polite">
        {liveContent ? <div>{liveContent}</div> : null}
      </div>
      {retryRow}
      <details className="group border border-line bg-raised/20 text-xs">
        <summary className="flex cursor-pointer select-none items-center justify-between p-3 font-medium text-text transition-colors duration-160 hover:bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <Info
              size={14}
              className="text-dim group-open:text-signal"
              aria-hidden="true"
            />
            <span>Build &amp; updater details</span>
          </span>
          <ChevronDown
            size={14}
            className="text-dim transition-transform duration-160 group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="space-y-1 border-t border-line p-3 text-xs">
          <DetailRow label="Installed build" value={installed?.buildId ?? "Not reported"} mono />
          <DetailRow
            label="Last heartbeat"
            value={installed ? formatDate(installed.lastSeenAt ?? undefined) : "Not reported"}
          />
          <DetailRow
            label="Updater"
            value={
              updater?.installed
                ? `Installed · ${updater.healthy ? "healthy" : "unhealthy"} · last seen ${freshnessLabel(updater.lastSeenAt ?? undefined)}`
                : "Not installed on this host"
            }
          />
          {available ? (
            <>
              <DetailRow label="Bundled build" value={`${available.version} (${shortBuild(available.buildId)})`} />
              <DetailRow label="Build ID" value={available.buildId} mono />
              <DetailRow label="Source" value="Deployed API image" />
            </>
          ) : (
            <DetailRow
              label="Bundled build"
              value={status.state === "release_unavailable" ? "Bundled binary unavailable" : "Already running bundled build"}
            />
          )}
          {status.compatibility.reason !== "ok" ? (
            <DetailRow label="Compatibility" value={INCOMPATIBLE_REASONS[status.compatibility.reason]} />
          ) : null}
        </div>
      </details>
    </>
  ) : (
    retryRow
  );

  if (!status && !loadError) return null;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Agent updates</CardTitle>
          <CardDescription>
            Installs the bundled release in this deployment; completion is confirmed by a fresh
            heartbeat, not by the service status.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">{details}</CardContent>
      </Card>
      {renderDialogs()}
    </>
  );

  function renderDialogs() {
    return (
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent onCloseAutoFocus={(event) => {
          event.preventDefault();
          upgradeTriggerRef.current?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Upgrade agent on {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Monitoring pauses for one agent restart. The upgrade counts as complete only when the new
              build sends a fresh heartbeat from this server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-xs text-text">
            <div className="flex justify-between gap-4">
              <span className="text-dim">Current</span>
              <span className="text-right">
                {dialogInstalledText ?? "Unknown"}
                {dialogHeartbeatText ? ` · ${dialogHeartbeatText}` : ""}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-dim">Target</span>
              <span className="text-right">
                {available ? `${available.version} (${shortBuild(available.buildId)})` : ""}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-dim">Release ID</span>
              <span className="break-all text-right font-mono">{available?.releaseId ?? ""}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-dim">Source</span>
              <span className="text-right">Deployed API image</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-dim">Downtime</span>
              <span className="text-right">
                Monitoring pauses for a few seconds while the agent restarts.
              </span>
            </div>
            <p className="text-dim">
              If the upgrade cannot complete, the updater restores the previous binary and verifies its
              heartbeat; an unverified rollback is flagged for manual intervention. Existing credentials
              are preserved.
            </p>
            {actionError ? (
              <p role="alert" className="text-crit">
                {actionError}
              </p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void confirmUpgrade();
              }}
            >
              {submitting ? "Starting…" : "Upgrade agent"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
}

function RemoteAgentUpdate({
  vps,
  jobs: propJobs,
}: {
  vps: VpsRecord;
  jobs?: DashboardOverview["jobs"];
}) {
  const dashboard = useContext(DashboardContext);
  const mode = dashboard?.mode ?? "local";
  const isBusy = dashboard?.busy ?? false;
  const displayName = vpsDisplayName(vps);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [localAgentStatus, setLocalAgentStatus] = useState<VpsRecord["agentStatus"] | null>(null);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const reasonId = useId();
  const upgradeTriggerRef = useRef<HTMLButtonElement>(null);

  const availableJobs = propJobs ?? dashboard?.jobs;
  const activeJob = availableJobs
    ? availableJobs.find(
        (job) =>
          job.vpsId === vps.id &&
          (job.status === "queued" || job.status === "running") &&
          (job.type === "install-agent" ||
            job.type === "uninstall-agent" ||
            job.type === "upgrade-agent" ||
            job.type === "restart-agent" ||
            job.type === "rotate-agent"),
      ) ?? agentJobFor(vps, availableJobs)
    : null;
  const activeJobRunning = Boolean(
    activeJob && (activeJob.status === "queued" || activeJob.status === "running"),
  );
  const agentStatus = localAgentStatus ?? vps.agentStatus;
  const agentActionRunning = agentStatus === "installing" || activeJobRunning;
  const canUpgrade =
    mode !== "demo" &&
    !agentActionRunning &&
    (agentStatus === "online" || agentStatus === "offline" || agentStatus === "failed");

  let disabledReason: string | null = null;
  if (mode === "demo") {
    disabledReason = "Agent upgrades are unavailable in demo mode.";
  } else if (agentActionRunning) {
    disabledReason =
      activeJob?.type === "restart-agent"
        ? "An agent restart is currently in progress."
        : activeJob?.type === "rotate-agent"
          ? "An agent credential rotation is currently in progress."
          : activeJob?.type === "uninstall-agent"
            ? "An agent removal is currently in progress."
            : "An agent installation or upgrade is currently in progress.";
  } else if (agentStatus === "not_installed") {
    disabledReason = "Agent is not installed on this server.";
  } else if (!agentStatus) {
    disabledReason = "Agent status is unavailable.";
  }

  const chip = agentStatus ? REMOTE_STATUS_CHIPS[agentStatus] : null;

  async function handleUpgrade() {
    if (submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      if (dashboard?.onUpgradeAgent) {
        const result = await dashboard.onUpgradeAgent(vps);
        if (
          result &&
          typeof result === "object" &&
          "jobId" in result &&
          typeof result.jobId === "string"
        ) {
          setLastJobId(result.jobId);
          setLocalAgentStatus("installing");
        }
      } else {
        const result = await upgradeAgent(vps.id);
        if (result?.jobId) {
          setLastJobId(result.jobId);
        }
        setLocalAgentStatus("installing");
      }
      setConfirmOpen(false);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "The upgrade request failed. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Agent updates</CardTitle>
          <CardDescription>
            Installs the latest compatible agent release over SSH.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {chip ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge
                variant={chip.variant}
                className="text-[10px] uppercase tracking-wide"
              >
                {chip.label}
              </Badge>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={upgradeTriggerRef}
              type="button"
              size="sm"
              variant="default"
              disabled={!canUpgrade || submitting || isBusy}
              aria-describedby={disabledReason ? reasonId : undefined}
              onClick={() => {
                setActionError(null);
                setConfirmOpen(true);
              }}
            >
              {submitting ? (
                <>
                  <LoaderCircle size={14} className="animate-spin" />
                  Starting…
                </>
              ) : (
                "Upgrade agent"
              )}
            </Button>
          </div>

          {disabledReason ? (
            <p id={reasonId} className="text-[11px] text-dim">
              {disabledReason}
            </p>
          ) : null}

          {actionError ? (
            <p role="alert" className="text-[11px] text-crit">
              {actionError}
            </p>
          ) : null}

          <details className="group border border-line bg-raised/20 text-xs">
            <summary className="flex cursor-pointer select-none items-center justify-between p-3 font-medium text-text transition-colors duration-160 hover:bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                <Info
                  size={14}
                  className="text-dim group-open:text-signal"
                  aria-hidden="true"
                />
                <span>Updater details</span>
              </span>
              <ChevronDown
                size={14}
                className="text-dim transition-transform duration-160 group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="space-y-1 border-t border-line p-3 text-xs">
              <DetailRow
                label="Last heartbeat"
                value={vps.lastSeenAt ? formatDate(vps.lastSeenAt) : "Not reported"}
              />
              {lastJobId || vps.lastAgentInstallJobId ? (
                <DetailRow
                  label="Last install/upgrade job"
                  value={lastJobId || vps.lastAgentInstallJobId || ""}
                  mono
                />
              ) : null}
              {vps.agentLastError ? (
                <DetailRow label="Last error" value={vps.agentLastError} />
              ) : null}
            </div>
          </details>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            upgradeTriggerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Upgrade agent on {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Monitoring will pause briefly while the agent is upgraded. If the upgrade cannot
              complete, the previous version is restored automatically. Existing credentials are
              preserved and are not changed or stored again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-xs text-text">
            <div className="flex justify-between gap-4">
              <span className="text-dim">Current status</span>
              <span className="text-right">{agentStatusLabel(agentStatus)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-dim">Host</span>
              <span className="text-right font-mono">
                {vps.username}@{vps.host}:{vps.port}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-dim">Downtime</span>
              <span className="text-right">
                Monitoring pauses briefly while the agent service restarts.
              </span>
            </div>
            {actionError ? (
              <p role="alert" className="text-crit">
                {actionError}
              </p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void handleUpgrade();
              }}
            >
              {submitting ? "Starting…" : "Upgrade agent"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
