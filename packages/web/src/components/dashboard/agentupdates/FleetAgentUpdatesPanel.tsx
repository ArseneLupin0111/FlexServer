import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  XCircle,
} from "lucide-react";
import { Button } from "../../ui/button";
import {
  getFleetAgentUpdates,
  requestVpsAgentUpdate,
  type AgentUpdateAutomation,
  type AgentUpdateAutomationState,
  type AgentUpdateView,
  type FleetAgentUpdateHost,
  type FleetAgentUpdatesData,
  type LocalAgentUpgradeState,
} from "../../../lib/api";
import { formatDate, freshnessLabel } from "../../../lib/dashboard-formatters";

/**
 * Fleet Agent Updates Panel.
 *
 * Replaces legacy manual rollout/cohort/canary controls with deployment convergence:
 * - Authoritative state comes from GET /api/agent-updates.
 * - Shows status for every managed host against the current deployment target.
 * - Per-host Update/Retry action via POST /api/vps/:id/agent-update with Idempotency-Key.
 * - Handles waiting_connection, needs_access, failed, updating, current.
 */

const POLL_INTERVAL_MS = 15_000;

type FilterTab = "all" | "current" | "updating" | "waiting" | "needs_access" | "failed";

const AUTOMATION_CONFIG: Record<
  AgentUpdateAutomationState,
  {
    label: string;
    variant: "ready" | "pending" | "destructive" | "outline";
    icon: React.ComponentType<{ className?: string; size?: number | string }>;
    badgeClass: string;
  }
> = {
  current: {
    label: "Up to date",
    variant: "ready",
    icon: CheckCircle2,
    badgeClass: "border-signal/40 bg-signal/10 text-signal",
  },
  pending: {
    label: "Pending update",
    variant: "pending",
    icon: Clock,
    badgeClass: "border-info/40 bg-info/10 text-info",
  },
  waiting_connection: {
    label: "Waiting (offline)",
    variant: "pending",
    icon: Clock,
    badgeClass: "border-line bg-raised text-dim",
  },
  updating: {
    label: "Updating",
    variant: "pending",
    icon: LoaderCircle,
    badgeClass: "border-info/50 bg-info/20 text-info animate-pulse",
  },
  needs_access: {
    label: "Needs access",
    variant: "destructive",
    icon: AlertTriangle,
    badgeClass: "border-warn/50 bg-warn/15 text-warn",
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    icon: XCircle,
    badgeClass: "border-crit/40 bg-crit/15 text-crit",
  },
  incompatible: {
    label: "Incompatible",
    variant: "destructive",
    icon: XCircle,
    badgeClass: "border-crit/30 bg-crit/10 text-crit",
  },
  release_unavailable: {
    label: "Unavailable",
    variant: "outline",
    icon: AlertCircle,
    badgeClass: "border-line bg-raised text-dim",
  },
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
  deferred: "Deferred",
  superseded: "Superseded by newer deployment",
};

function shortBuild(buildId?: string | null): string | null {
  return buildId ? buildId.slice(0, 12) : null;
}

function resolveAutomation(update: AgentUpdateView): AgentUpdateAutomation {
  if (update.automation) return update.automation;
  const isCurrent = update.state === "current";
  const isAvail = update.state === "available";
  const isUpdating = update.job && !["succeeded", "rolled_back", "rollback_unverified", "failed", "deferred", "superseded"].includes(update.job.state);
  if (isUpdating) {
    return {
      state: "updating",
      reason: null,
      targetBuildId: update.job?.releaseBuildId ?? null,
      retryAllowed: false,
    };
  }
  if (isCurrent) {
    return {
      state: "current",
      reason: null,
      targetBuildId: update.installed.buildId,
      retryAllowed: false,
    };
  }
  if (update.state === "incompatible") {
    return {
      state: "incompatible",
      reason: "Build incompatible with server architecture or API contract.",
      targetBuildId: null,
      retryAllowed: false,
    };
  }
  if (update.state === "updater_unavailable") {
    return {
      state: "needs_access",
      reason: "Updater daemon is not installed on this server.",
      targetBuildId: null,
      retryAllowed: true,
    };
  }
  if (update.state === "release_unavailable") {
    return {
      state: "release_unavailable",
      reason: "Bundled agent binary unavailable in this deployment.",
      targetBuildId: null,
      retryAllowed: false,
    };
  }
  if (update.installed && !update.installed.fresh) {
    return {
      state: "waiting_connection",
      reason: "Agent heartbeat is stale or disconnected.",
      targetBuildId: update.available?.buildId ?? null,
      retryAllowed: true,
    };
  }
  return {
    state: isAvail ? "pending" : "incompatible",
    reason: null,
    targetBuildId: update.available?.buildId ?? null,
    retryAllowed: isAvail,
  };
}

export function FleetAgentUpdatesPanel() {
  const [data, setData] = useState<FleetAgentUpdatesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    kind: "success" | "warn" | "error";
    message: string;
  } | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FilterTab>("all");

  const [submittingIds, setSubmittingIds] = useState<Record<string, boolean>>({});
  const idempotencyKeysRef = useRef<Record<string, string>>({});
  const fetchActiveRef = useRef(false);

  const loadData = useCallback(async (isManual = false) => {
    if (fetchActiveRef.current && !isManual) return;
    fetchActiveRef.current = true;
    if (isManual) setRefreshing(true);
    try {
      const result = await getFleetAgentUpdates();
      setData(result);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load agent updates.");
    } finally {
      setLoading(false);
      setRefreshing(false);
      fetchActiveRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadData(false);
  }, [loadData]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadData(false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadData(false);
      }
    }, POLL_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.clearInterval(interval);
    };
  }, [loadData]);

  const handleHostUpdate = async (vpsId: string, hostName: string) => {
    if (submittingIds[vpsId]) return;

    let key = idempotencyKeysRef.current[vpsId];
    if (!key) {
      key = crypto.randomUUID();
      idempotencyKeysRef.current[vpsId] = key;
    }

    setSubmittingIds((prev) => ({ ...prev, [vpsId]: true }));
    setActionNotice(null);

    try {
      const updatedView = await requestVpsAgentUpdate(vpsId, key);
      delete idempotencyKeysRef.current[vpsId];
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          hosts: prev.hosts.map((h) =>
            h.vpsId === vpsId ? { ...h, update: updatedView } : h,
          ),
        };
      });
      setActionNotice({
        kind: "success",
        message: `Update request accepted for ${hostName}. Agent will update automatically.`,
      });
    } catch (err: unknown) {
      setActionNotice({
        kind: "error",
        message: err instanceof Error ? err.message : `Failed to request update for ${hostName}.`,
      });
    } finally {
      setSubmittingIds((prev) => ({ ...prev, [vpsId]: false }));
    }
  };

  const hostsWithAutomation = useMemo(() => {
    if (!data?.hosts) return [];
    return data.hosts.map((host) => ({
      ...host,
      automation: resolveAutomation(host.update),
    }));
  }, [data]);

  const counts = useMemo(() => {
    let current = 0;
    let updating = 0;
    let waiting = 0;
    let needsAccess = 0;
    let failed = 0;

    for (const item of hostsWithAutomation) {
      const st = item.automation.state;
      if (st === "current") current++;
      else if (st === "updating") updating++;
      else if (st === "waiting_connection" || st === "pending") waiting++;
      else if (st === "needs_access") needsAccess++;
      else if (st === "failed" || st === "incompatible" || st === "release_unavailable") failed++;
    }

    return {
      total: hostsWithAutomation.length,
      current,
      updating,
      waiting,
      needsAccess,
      failed,
    };
  }, [hostsWithAutomation]);

  const filteredHosts = useMemo(() => {
    return hostsWithAutomation.filter((item) => {
      const st = item.automation.state;
      if (statusFilter === "current" && st !== "current") return false;
      if (statusFilter === "updating" && st !== "updating") return false;
      if (
        statusFilter === "waiting" &&
        st !== "waiting_connection" &&
        st !== "pending"
      ) {
        return false;
      }
      if (statusFilter === "needs_access" && st !== "needs_access") return false;
      if (
        statusFilter === "failed" &&
        st !== "failed" &&
        st !== "incompatible" &&
        st !== "release_unavailable"
      ) {
        return false;
      }

      if (search.trim()) {
        const query = search.trim().toLowerCase();
        const nameMatch = item.name.toLowerCase().includes(query);
        const vpsIdMatch = item.vpsId.toLowerCase().includes(query);
        const buildMatch =
          item.update.installed.buildId?.toLowerCase().includes(query) ||
          item.automation.targetBuildId?.toLowerCase().includes(query);
        if (!nameMatch && !vpsIdMatch && !buildMatch) return false;
      }

      return true;
    });
  }, [hostsWithAutomation, statusFilter, search]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text">Agent Deployment Updates</h1>
          <p className="mt-1 text-xs text-dim">
            Managed agents converge to this deployment&apos;s bundled artifact automatically. Hosts update automatically with verified rollback.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadData(true)}
            disabled={refreshing || loading}
            aria-label="Refresh agent update status"
            className="h-8 gap-1.5 text-xs"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            <span>Refresh</span>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
            <Link to="/vps">
              <Server size={13} />
              <span>All Servers</span>
            </Link>
          </Button>
        </div>
      </div>

      {/* Action Notification */}
      {actionNotice ? (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center justify-between border px-3 py-2 text-xs ${
            actionNotice.kind === "success"
              ? "border-signal/40 bg-signal/10 text-signal"
              : actionNotice.kind === "warn"
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-crit/40 bg-crit/10 text-crit"
          }`}
        >
          <span>{actionNotice.message}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="ml-3 text-dim hover:text-text"
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Status Breakdown Pills */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" role="tablist" aria-label="Filter by status">
        <StatusCountCard
          label="Total Hosts"
          count={counts.total}
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
        />
        <StatusCountCard
          label="Up to Date"
          count={counts.current}
          active={statusFilter === "current"}
          variant="ready"
          onClick={() => setStatusFilter("current")}
        />
        <StatusCountCard
          label="Updating"
          count={counts.updating}
          active={statusFilter === "updating"}
          variant="pending"
          onClick={() => setStatusFilter("updating")}
        />
        <StatusCountCard
          label="Waiting"
          count={counts.waiting}
          active={statusFilter === "waiting"}
          variant="pending"
          onClick={() => setStatusFilter("waiting")}
        />
        <StatusCountCard
          label="Needs Access"
          count={counts.needsAccess}
          active={statusFilter === "needs_access"}
          variant="warn"
          onClick={() => setStatusFilter("needs_access")}
        />
        <StatusCountCard
          label="Failed"
          count={counts.failed}
          active={statusFilter === "failed"}
          variant="destructive"
          onClick={() => setStatusFilter("failed")}
        />
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
          <input
            type="text"
            placeholder="Search host, VPS ID, or build..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full border border-line bg-ink pl-8 pr-3 text-xs text-text placeholder:text-dim/60 focus:border-signal focus:outline-none"
            aria-label="Search hosts"
          />
        </div>
        <div className="text-xs text-dim">
          Showing <span className="tabular-nums font-medium text-text">{filteredHosts.length}</span> of{" "}
          <span className="tabular-nums font-medium text-text">{counts.total}</span> hosts
        </div>
      </div>

      {/* Table Content */}
      {loading ? (
        <div className="flex h-48 items-center justify-center border border-line bg-panel text-xs text-dim">
          <LoaderCircle size={16} className="mr-2 animate-spin text-signal" />
          <span>Loading agent status…</span>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-2 border border-line bg-panel p-8 text-center text-xs">
          <AlertTriangle size={20} className="text-warn" />
          <p className="text-text">{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadData(true)}
            className="mt-2 text-xs"
          >
            Retry
          </Button>
        </div>
      ) : filteredHosts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 border border-line bg-panel p-12 text-center text-xs text-dim">
          <Server size={24} className="text-dim/60" />
          <p className="font-medium text-text">No hosts match the selected criteria</p>
          <p className="text-dim">
            {hostsWithAutomation.length === 0
              ? "No managed hosts are currently registered."
              : "Try clearing filters or search term."}
          </p>
          {statusFilter !== "all" || search ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setStatusFilter("all");
                setSearch("");
              }}
              className="mt-2 text-xs"
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="overflow-x-auto border border-line bg-panel">
          <table className="w-full min-w-[680px] text-left text-xs" role="table" aria-label="Deployment Agent Updates">
            <thead className="border-b border-line bg-raised/30 text-[11px] uppercase tracking-wider text-dim">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Host</th>
                <th scope="col" className="px-4 py-3 font-medium">Installed Version</th>
                <th scope="col" className="px-4 py-3 font-medium">Deployment Target</th>
                <th scope="col" className="px-4 py-3 font-medium">Status &amp; Reason</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredHosts.map((host) => {
                const auto = host.automation;
                const update = host.update;
                const config = AUTOMATION_CONFIG[auto.state];
                const Icon = config.icon;
                const isSubmitting = Boolean(submittingIds[host.vpsId]);
                const isUpdating = auto.state === "updating";
                const isCurrent = auto.state === "current";
                const isFailed = auto.state === "failed" || update.job?.state === "rolled_back" || update.job?.state === "rollback_unverified";
                const isNeedsAccess = auto.state === "needs_access";
                const isIncompatible = auto.state === "incompatible";
                const isUnavailable = auto.state === "release_unavailable";

                const buttonDisabled =
                  isSubmitting ||
                  isUpdating ||
                  isCurrent ||
                  isIncompatible ||
                  isUnavailable;

                const buttonText = isSubmitting
                  ? "Starting…"
                  : isUpdating
                    ? "Updating…"
                    : isCurrent
                      ? "Up to date"
                      : isIncompatible
                        ? "Incompatible"
                        : isUnavailable
                          ? "Unavailable"
                          : isFailed
                            ? "Retry"
                            : isNeedsAccess
                              ? "Retry setup"
                              : "Update";
                const installedVersionText = update.installed.version
                  ? `v${update.installed.version}`
                  : "unknown";
                const installedBuildShort = shortBuild(update.installed.buildId);

                const targetBuildShort = shortBuild(auto.targetBuildId);
                const targetVersionText = update.available?.version
                  ? `v${update.available.version}`
                  : "deployment target";

                const reasonText =
                  auto.reason ||
                  (update.job?.state && PHASE_LABELS[update.job.state]) ||
                  (isCurrent ? "Running deployment build." : "Awaiting automatic convergence.");

                return (
                  <tr key={host.vpsId} className="transition-colors hover:bg-raised/20">
                    {/* Host Name & ID */}
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-1.5">
                        <Link
                          to={`/vps/${encodeURIComponent(host.vpsId)}?tab=settings`}
                          className="font-medium text-text hover:text-signal hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal"
                        >
                          {host.name}
                        </Link>
                      </div>
                      <div className="font-mono text-[11px] text-dim">{host.vpsId}</div>
                    </td>

                    {/* Installed Version / Build */}
                    <td className="px-4 py-3 align-top">
                      <div className="text-text">
                        <span>{installedVersionText}</span>
                        {installedBuildShort ? (
                          <span className="ml-1.5 font-mono text-[11px] text-dim">({installedBuildShort})</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-dim" title={formatDate(update.installed.lastSeenAt ?? undefined)}>
                        {update.installed.fresh ? (
                          <span className="text-signal">heartbeat active</span>
                        ) : (
                          <span className="text-warn">
                            stale ({freshnessLabel(update.installed.lastSeenAt ?? undefined)})
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Deployment Target */}
                    <td className="px-4 py-3 align-top">
                      <div className="text-text">
                        <span>{targetVersionText}</span>
                        {targetBuildShort ? (
                          <span className="ml-1.5 font-mono text-[11px] text-dim">({targetBuildShort})</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-dim">bundled artifact</div>
                    </td>

                    {/* Status & Reason */}
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] font-medium ${config.badgeClass}`}
                        >
                          <Icon size={12} className={isUpdating ? "animate-spin" : ""} />
                          <span>{config.label}</span>
                        </span>
                      </div>
                      <p className="mt-1 max-w-sm text-[11px] text-dim">{reasonText}</p>
                      {/* Active determinate progress if updating */}
                      {isUpdating && update.job && typeof update.job.progress === "number" ? (
                        <div className="mt-1.5 max-w-xs space-y-1">
                          <div className="flex justify-between text-[10px] tabular-nums text-dim">
                            <span>{PHASE_LABELS[update.job.state]}</span>
                            <span>{Math.round(update.job.progress)}%</span>
                          </div>
                          <div
                            role="progressbar"
                            aria-valuenow={Math.round(update.job.progress)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            className="h-1 w-full bg-raised"
                          >
                            <div
                              className="h-full bg-info transition-[width] duration-300"
                              style={{ width: `${Math.round(update.job.progress)}%` }}
                            />
                          </div>
                        </div>
                      ) : null}
                    </td>

                    {/* Action */}
                    <td className="px-4 py-3 text-right align-top">
                      <Button
                        type="button"
                        size="sm"
                        variant={isCurrent || isIncompatible || isUnavailable ? "outline" : "default"}
                        disabled={buttonDisabled}
                        onClick={() => void handleHostUpdate(host.vpsId, host.name)}
                        className="h-7 px-2.5 text-xs"
                        aria-label={`${buttonText} agent on ${host.name}`}
                      >
                        {isSubmitting ? (
                          <LoaderCircle size={12} className="mr-1 animate-spin" />
                        ) : null}
                        <span>{buttonText}</span>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusCountCard({
  label,
  count,
  active,
  variant = "default",
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  variant?: "default" | "ready" | "pending" | "warn" | "destructive";
  onClick: () => void;
}) {
  const badgeClasses =
    variant === "ready"
      ? "text-signal"
      : variant === "warn"
        ? "text-warn"
        : variant === "destructive"
          ? "text-crit"
          : variant === "pending"
            ? "text-info"
            : "text-text";

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-col border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal ${
        active
          ? "border-signal bg-raised/60"
          : "border-line bg-panel hover:border-line hover:bg-raised/20"
      }`}
    >
      <span className="text-[11px] text-dim">{label}</span>
      <span className={`mt-1 font-mono text-lg font-semibold tabular-nums ${badgeClasses}`}>
        {count}
      </span>
    </button>
  );
}
