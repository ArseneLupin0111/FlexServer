import { AlertCircle, CheckCircle2, LoaderCircle, Radio } from "lucide-react";
import type { DashboardJob, VpsRecord } from "../../../lib/api";

/** Mirrors the API's HOST_FRESHNESS_THRESHOLD_MS for online/offline derivation. */
const LOCAL_FRESHNESS_MS = 120_000;

const stepLabels: Record<string, string> = {
  queued: "Waiting to start",
  connecting: "Connecting to server",
  "creating-directory": "Preparing agent files",
  "uploading-binary": "Uploading agent",
  "writing-config": "Saving secure configuration",
  "installing-service": "Installing system service",
  "starting-service": "Starting agent",
  verifying: "Checking connection",
  stopping: "Stopping agent",
  "removing-service": "Removing system service",
  "removing-files": "Removing agent files",
};

export function agentJobFor(vps: VpsRecord, jobs: DashboardJob[]) {
  const lifecycleJobs = jobs.filter(
    (job) =>
      job.vpsId === vps.id &&
      (job.type === "install-agent" || job.type === "uninstall-agent" || job.type === "upgrade-agent" || job.type === "restart-agent" || job.type === "rotate-agent"),
  );
  if (vps.lastAgentInstallJobId) {
    const exact = lifecycleJobs.find((job) => job.id === vps.lastAgentInstallJobId);
    if (exact) return exact;
  }
  // SSE payload ordering is not a lifecycle ordering. Prefer the newest known
  // job, with stable id ordering when timestamps are unavailable/equal.
  return lifecycleJobs.sort((a, b) => {
    const aTime = Date.parse(a.finishedAt || a.startedAt || "") || 0;
    const bTime = Date.parse(b.finishedAt || b.startedAt || "") || 0;
    return bTime - aTime || b.id.localeCompare(a.id);
  })[0];
}

/**
 * Observed local-agent label derived from the record's last-seen heartbeat,
 * matching the API's freshness window for online/offline: a fresh observation
 * is "Online", a stale past observation is "Offline", and missing, invalid, or
 * future timestamps are "Unknown" (never a fresh heartbeat). Shared by card
 * and table so local labels cannot drift apart.
 */
export function localAgentLabel(lastSeenAt: string | undefined, now = Date.now()) {
  const seen = Date.parse(lastSeenAt || "");
  if (!Number.isFinite(seen) || seen > now) return "Unknown";
  return now - seen < LOCAL_FRESHNESS_MS ? "Online" : "Offline";
}

export function AgentLifecycleStatus({ vps, jobs, compact = false }: {
  vps: VpsRecord;
  jobs: DashboardJob[];
  compact?: boolean;
}) {
  const job = agentJobFor(vps, jobs);
  const active = job && (job.status === "queued" || job.status === "running");
  const progress = active ? Math.min(100, Math.max(0, job.progress || 0)) : 0;
  const status = vps.agentStatus || "not_installed";

  if (active) {
    const removing = job.type === "uninstall-agent";
    const upgrading = job.type === "upgrade-agent";
    const restarting = job.type === "restart-agent";
    const rotating = job.type === "rotate-agent";
    const label = rotating ? "Rotating credential" : restarting ? "Restarting agent" : upgrading ? "Upgrading agent" : stepLabels[job.step || ""] || (removing ? "Removing agent" : "Installing agent");
    return (
      <div className={compact ? "min-w-[150px]" : "mt-3 border-t border-line pt-3"} aria-live="polite">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-text">
            <LoaderCircle size={13} className="animate-spin text-info" aria-hidden="true" />
            {label}
          </span>
          <span className="tabular-nums text-dim">{progress}%</span>
        </div>
        <div role="progressbar" aria-label={`${removing ? "Agent removal" : rotating ? "Agent rotation" : restarting ? "Agent restart" : upgrading ? "Agent upgrade" : "Agent install"}: ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="mt-2 h-1.5 overflow-hidden bg-raised">
          <div className="h-full bg-info transition-[width] duration-500" style={{ width: `${progress}%` }} />
        </div>
      </div>
    );
  }

  if (status === "online") return <span className="inline-flex items-center gap-1.5 text-xs text-signal" role="status"><CheckCircle2 size={13} aria-hidden="true" />Agent online</span>;
  if (status === "offline") return <span className="inline-flex items-center gap-1.5 text-xs text-warn" role="status"><Radio size={13} aria-hidden="true" />Agent offline</span>;
  if (status === "failed") return <span className="inline-flex items-center gap-1.5 text-xs text-crit" role="alert" title={job?.errorMessage || vps.agentLastError}><AlertCircle size={13} aria-hidden="true" />{job?.errorMessage || vps.agentLastError || "Agent action failed"}</span>;
  if (status === "installing") return <span className="text-xs text-dim" role="status">{job?.status === "succeeded" ? "Checking agent status" : "Agent installing"}</span>;
  if (vps.kind === "local" || vps.managedBy === "system") {
    // Local host: the persisted lifecycle row can be missing while the local
    // process keeps reporting (the supervisor marks the record seen on every
    // collect). Never assert "not installed" over a fresh observation -
    // mirror it with the shared observed label.
    const observed = localAgentLabel(vps.lastSeenAt);
    if (observed === "Online") return <span className="inline-flex items-center gap-1.5 text-xs text-signal" role="status"><CheckCircle2 size={13} aria-hidden="true" />Agent online</span>;
    if (observed === "Offline") return <span className="inline-flex items-center gap-1.5 text-xs text-warn" role="status"><Radio size={13} aria-hidden="true" />Agent offline</span>;
    return <span className="text-xs text-dim">Agent status unknown</span>;
  }
  return <span className="text-xs text-dim">Agent not installed</span>;
}
