import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Layers,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  type FleetEnrollResult,
  type FleetGroup,
  type FleetHost,
  type FleetHostState,
  type FleetNotification,
  type FleetPolicy,
  type FleetPolicyMode,
  type FleetPolicyUpdateResult,
  type FleetRelease,
  type FleetRollout,
  type FleetUpdatesDashboardData,
  controlFleetRollout,
  createFleetRollout,
  enrollFleetHosts,
  getFleetAgentUpdates,
  updateFleetPolicies,
} from "../../../lib/api";
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
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { cn } from "../../../lib/utils";

// ── State Chips & Labels ──────────────────────────────────────────────

const HOST_STATE_CONFIG: Record<
  string,
  { label: string; badgeClass: string; icon: React.ComponentType<{ className?: string }> }
> = {
  needs_setup: {
    label: "Needs setup",
    badgeClass: "border-warn/40 bg-warn/15 text-warn",
    icon: AlertTriangle,
  },
  idle: {
    label: "Idle",
    badgeClass: "border-line bg-raised/50 text-text",
    icon: CheckCircle2,
  },
  queued: {
    label: "Queued",
    badgeClass: "border-info/40 bg-info/10 text-info",
    icon: Clock,
  },
  updating: {
    label: "Updating",
    badgeClass: "border-info/60 bg-info/20 text-info animate-pulse",
    icon: RefreshCw,
  },
  observing: {
    label: "Observing (5m)",
    badgeClass: "border-signal/50 bg-signal/15 text-signal animate-pulse",
    icon: Activity,
  },
  succeeded: {
    label: "Succeeded",
    badgeClass: "border-signal/40 bg-signal/10 text-signal",
    icon: ShieldCheck,
  },
  failed: {
    label: "Failed",
    badgeClass: "border-crit/40 bg-crit/15 text-crit",
    icon: XCircle,
  },
  rolled_back: {
    label: "Rolled back",
    badgeClass: "border-warn/50 bg-warn/15 text-warn",
    icon: RotateCcw,
  },
  waiting_verification: {
    label: "Waiting verification",
    badgeClass: "border-warn/40 bg-warn/10 text-warn animate-pulse",
    icon: AlertCircle,
  },
  offline: {
    label: "Offline",
    badgeClass: "border-line bg-raised/30 text-dim",
    icon: Server,
  },
  busy: {
    label: "Busy",
    badgeClass: "border-line bg-raised/80 text-warn",
    icon: Clock,
  },
  pinned: {
    label: "Pinned",
    badgeClass: "border-line bg-raised text-text",
    icon: ShieldCheck,
  },
};

function formatBuild(buildId?: string | null): string {
  if (!buildId) return "—";
  return buildId.length > 12 ? `${buildId.slice(0, 12)}…` : buildId;
}

const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatWindow(window?: FleetPolicy["maintenanceWindow"]): string {
  if (!window || !window.start || !window.end) return "Any time";
  const days =
    window.days && window.days.length > 0 && window.days.length < 7
      ? window.days.map((d) => DAYS_OF_WEEK[d] || d).join(", ")
      : "Daily";
  const overnight = window.end < window.start ? " (overnight)" : "";
  return `${days} ${window.start}–${window.end}${overnight} ${window.timezone || "UTC"}`;
}

// ── Main Component ────────────────────────────────────────────────────

export function FleetAgentUpdatesPanel() {
  const [data, setData] = useState<FleetUpdatesDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    kind: "success" | "warn" | "error";
    message: string;
  } | null>(null);

  // Filters & selection
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Dialog states
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [rolloutOpen, setRolloutOpen] = useState(false);
  const [activeHostForPolicy, setActiveHostForPolicy] = useState<FleetHost | null>(null);

  const fetchRef = useRef(false);

  const loadData = useCallback(async (isManual = false) => {
    if (fetchRef.current && !isManual) return;
    fetchRef.current = true;
    if (isManual) setRefreshing(true);
    try {
      const res = await getFleetAgentUpdates();
      setData(res);
      setError(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load fleet agent updates";
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
      fetchRef.current = false;
    }
  }, []);

  // Polling every 10s when visible
  useEffect(() => {
    loadData(false);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadData(false);
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const hosts = useMemo(() => data?.hosts || [], [data]);
  const groups = useMemo(() => data?.groups || [], [data]);
  const releases = useMemo(() => data?.releases || [], [data]);
  const rollouts = useMemo(() => data?.rollouts || [], [data]);
  const notifications = useMemo(() => data?.notifications || [], [data]);

  // Derived filter
  const filteredHosts = useMemo(() => {
    return hosts.filter((h) => {
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchName = h.name.toLowerCase().includes(q);
        const matchVpsId = h.vpsId.toLowerCase().includes(q);
        const matchGroup = h.policy?.group?.toLowerCase().includes(q);
        const matchBuild = (h.installedBuildId || "").toLowerCase().includes(q);
        if (!matchName && !matchVpsId && !matchGroup && !matchBuild) return false;
      }
      if (statusFilter !== "all" && h.status !== statusFilter) return false;
      if (groupFilter !== "all" && (h.policy?.group || "Default") !== groupFilter) return false;
      if (modeFilter !== "all" && (h.policy?.mode || "auto") !== modeFilter) return false;
      return true;
    });
  }, [hosts, search, statusFilter, groupFilter, modeFilter]);

  // Bulk selection helpers
  const allFilteredSelected =
    filteredHosts.length > 0 && filteredHosts.every((h) => selectedIds.has(h.vpsId));
  const someFilteredSelected =
    filteredHosts.some((h) => selectedIds.has(h.vpsId)) && !allFilteredSelected;

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredHosts.map((h) => h.vpsId)));
    }
  }

  function toggleSelectHost(vpsId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(vpsId)) next.delete(vpsId);
      else next.add(vpsId);
      return next;
    });
  }

  // Summary counts
  const enrolledCount = hosts.filter((h) => h.enrolled).length;
  const setupCount = hosts.filter((h) => h.setupRequired || h.status === "needs_setup").length;
  const inProgressCount = hosts.filter(
    (h) => h.status === "updating" || h.status === "observing" || h.status === "queued",
  ).length;
  const succeededCount = hosts.filter((h) => h.status === "succeeded").length;
  const failedCount = hosts.filter((h) => h.status === "failed" || h.status === "rolled_back").length;

  // Actions
  async function handleRolloutControl(rolloutId: string, action: "pause" | "resume" | "retry") {
    try {
      await controlFleetRollout(rolloutId, action);
      setActionNotice({
        kind: "success",
        message: `Rollout ${rolloutId} ${action} request processed successfully.`,
      });
      await loadData(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Failed to ${action} rollout`;
      setActionNotice({ kind: "error", message: msg });
    }
  }

  return (
    <div className="grid min-w-0 gap-6">
      {/* Fleet Updates Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text sm:text-3xl">
            Fleet Agent Updates
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-dim sm:text-[13px]">
            Bulk enrollment, canary verification cohorts, overnight maintenance windows, and signed
            cryptographic release rollouts across the VPS fleet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => loadData(true)}
            className="h-8 gap-1.5"
            aria-label="Refresh fleet status"
          >
            <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
            <span>Refresh</span>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-8">
            <Link to="/vps">Server List</Link>
          </Button>
        </div>
      </div>

      {/* Global / Action Alert */}
      {actionNotice ? (
        <div
          role="status"
          className={cn(
            "flex items-center justify-between border px-4 py-2.5 text-xs",
            actionNotice.kind === "success" && "border-signal/40 bg-signal/10 text-signal",
            actionNotice.kind === "warn" && "border-warn/40 bg-warn/10 text-warn",
            actionNotice.kind === "error" && "border-crit/40 bg-crit/10 text-crit",
          )}
        >
          <span>{actionNotice.message}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-dim hover:text-text"
            aria-label="Dismiss alert"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between border border-crit/40 bg-crit/10 px-4 py-3 text-xs text-crit"
        >
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadData(true)}
            className="h-7 text-xs border-crit/30 text-crit hover:bg-crit/20"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {/* Setup Guidance Banner if any host requires setup */}
      {setupCount > 0 ? (
        <div
          role="region"
          aria-label="Setup requirements"
          className="border border-warn/40 bg-warn/5 p-4 text-xs text-text"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert size={18} className="shrink-0 text-warn" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-warn">
                  {setupCount} host(s) require update configuration or trust setup
                </span>
              </div>
              <p className="text-dim leading-relaxed">
                Cryptographic trust must be established before automated updates proceed. Ensure
                the Ed25519 public key (<code className="font-mono text-text">FLEET_RELEASE_PUBLIC_KEY_FILE</code>)
                and stable release manifest pointer (<code className="font-mono text-text">FLEET_RELEASE_MANIFEST_URL</code>)
                are configured on the API, and host updaters are provisioned. Unsigned fallback is strictly prohibited.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Fleet KPI Summary Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="border border-line bg-panel p-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-dim">
            Enrolled Hosts
          </div>
          <div className="tnum mt-1 text-2xl font-semibold text-text">
            {data !== null ? (
              <>
                {enrolledCount}
                <span className="text-xs font-normal text-dim"> / {hosts.length}</span>
              </>
            ) : (
              <span className="text-dim">—</span>
            )}
          </div>
        </div>
        <div className="border border-line bg-panel p-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-dim">
            In Progress
          </div>
          <div className="tnum mt-1 text-2xl font-semibold text-info">
            {data !== null ? inProgressCount : <span className="text-dim">—</span>}
          </div>
        </div>
        <div className="border border-line bg-panel p-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-dim">
            Up to date
          </div>
          <div className="tnum mt-1 text-2xl font-semibold text-signal">
            {data !== null ? succeededCount : <span className="text-dim">—</span>}
          </div>
        </div>
        <div className="border border-line bg-panel p-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-dim">
            Failed / Rolled Back
          </div>
          <div className="tnum mt-1 text-2xl font-semibold text-crit">
            {data !== null ? failedCount : <span className="text-dim">—</span>}
          </div>
        </div>
        <div className="border border-line bg-panel p-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-dim">
            Needs Setup
          </div>
          <div className={cn("tnum mt-1 text-2xl font-semibold", data !== null && setupCount > 0 ? "text-warn" : "text-dim")}>
            {data !== null ? setupCount : "—"}
          </div>
        </div>
      </div>

      {/* Floating Bulk Action Bar */}
      {selectedIds.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions bar"
          className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 border border-signal/40 bg-raised p-3 shadow-lg"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-signal">
            <Check size={14} />
            <span>{selectedIds.size} host(s) selected</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={() => setEnrollOpen(true)}
              className="h-8 text-xs font-semibold"
            >
              Opt-in Enroll
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setActiveHostForPolicy(null);
                setPolicyOpen(true);
              }}
              className="h-8 text-xs"
            >
              <Sliders size={13} className="mr-1" />
              Set Policy
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRolloutOpen(true)}
              className="h-8 text-xs"
            >
              <Layers size={13} className="mr-1" />
              Trigger Rollout
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
              className="h-8 text-xs text-dim"
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {/* Search and Filters Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Input
            aria-label="Search fleet hosts"
            placeholder="Search host name, VPS ID, group, or build ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 bg-panel pl-3 text-xs"
          />
        </div>

        <select
          aria-label="Filter by state"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 border border-line bg-panel px-3 text-xs text-text outline-none focus:border-signal"
        >
          <option value="all">All States</option>
          <option value="needs_setup">Needs setup</option>
          <option value="idle">Idle</option>
          <option value="queued">Queued</option>
          <option value="updating">Updating</option>
          <option value="observing">Observing (canary)</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="rolled_back">Rolled back</option>
          <option value="waiting_verification">Waiting verification</option>
          <option value="offline">Offline</option>
          <option value="busy">Busy</option>
          <option value="pinned">Pinned</option>
        </select>

        <select
          aria-label="Filter by group"
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="h-9 border border-line bg-panel px-3 text-xs text-text outline-none focus:border-signal"
        >
          <option value="all">All Groups</option>
          {groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name}
            </option>
          ))}
          {!groups.some((g) => g.name === "Default") ? (
            <option value="Default">Default</option>
          ) : null}
        </select>

        <select
          aria-label="Filter by policy mode"
          value={modeFilter}
          onChange={(e) => setModeFilter(e.target.value)}
          className="h-9 border border-line bg-panel px-3 text-xs text-text outline-none focus:border-signal"
        >
          <option value="all">All Modes</option>
          <option value="auto">Auto (stable)</option>
          <option value="manual">Manual only</option>
          <option value="pinned">Pinned release</option>
        </select>
      </div>

      {/* Hosts Table */}
      <div className="border border-line bg-panel overflow-hidden">
        <div className="overflow-x-auto">
          <table
            aria-label="Fleet hosts agent updates"
            className="w-full text-left text-xs"
          >
            <thead>
              <tr className="border-b border-line bg-raised/40 text-[11px] uppercase tracking-wider text-dim">
                <th scope="col" className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all filtered hosts"
                    checked={allFilteredSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someFilteredSelected;
                    }}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 accent-signal cursor-pointer"
                  />
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Host / Server
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Status & Telemetry
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Installed Build / Target
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Policy & Maintenance Window
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {filteredHosts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-dim">
                    {loading
                      ? "Loading fleet hosts…"
                      : data === null && error
                      ? "Fleet host telemetry unavailable while service is unreachable."
                      : "No matching fleet hosts found."}
                  </td>
                </tr>
              ) : (
                filteredHosts.map((host) => {
                  const stateCfg =
                    HOST_STATE_CONFIG[host.status] || {
                      label: host.status,
                      badgeClass: "border-line bg-raised text-text",
                      icon: Server,
                    };
                  const Icon = stateCfg.icon;
                  const isSelected = selectedIds.has(host.vpsId);

                  return (
                    <tr
                      key={host.vpsId}
                      className={cn(
                        "transition-colors duration-160 ease-out hover:bg-raised/40",
                        isSelected && "bg-raised/30",
                      )}
                    >
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${host.name}`}
                          checked={isSelected}
                          onChange={() => toggleSelectHost(host.vpsId)}
                          className="h-3.5 w-3.5 accent-signal cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "h-2 w-2 rounded-full shrink-0",
                              host.online ? "bg-signal" : "bg-dim",
                            )}
                            title={host.online ? "Online" : "Offline"}
                          />
                          <div className="min-w-0">
                            <Link
                              to={`/vps/${encodeURIComponent(host.vpsId)}`}
                              className="font-medium text-text hover:text-signal hover:underline"
                            >
                              {host.name}
                            </Link>
                            <div className="font-mono text-[11px] text-dim truncate max-w-[200px]">
                              {host.vpsId}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="space-y-1">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] font-medium leading-none",
                              stateCfg.badgeClass,
                            )}
                          >
                            <Icon className="h-3 w-3 shrink-0" />
                            <span>{stateCfg.label}</span>
                          </span>
                          {host.reason ? (
                            <p
                              className="max-w-xs text-[11px] text-dim truncate leading-tight"
                              title={host.reason}
                            >
                              {host.reason}
                            </p>
                          ) : null}
                          {!host.enrolled ? (
                            <span className="block text-[10px] uppercase tracking-wider text-warn">
                              Not enrolled (Opt-in required)
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-[11px]">
                        <div>
                          <span className="text-dim">Current: </span>
                          <span className="text-text font-medium" title={host.installedBuildId || ""}>
                            {formatBuild(host.installedBuildId)}
                          </span>
                        </div>
                        {host.targetReleaseId ? (
                          <div className="mt-0.5 text-info">
                            <span className="text-dim">Target: </span>
                            <span>{formatBuild(host.targetReleaseId)}</span>
                          </div>
                        ) : null}
                        {host.updaterVersion ? (
                          <div className="mt-0.5 text-[10px] text-dim">
                            Updater: v{host.updaterVersion}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] uppercase font-mono py-0",
                                host.policy?.mode === "auto" && "border-signal/40 text-signal",
                                host.policy?.mode === "pinned" && "border-info/40 text-info",
                                host.policy?.mode === "manual" && "border-line text-dim",
                              )}
                            >
                              {host.policy?.mode || "auto"}
                            </Badge>
                            <span className="border border-line bg-raised px-1.5 py-0.5 text-[10px] text-text">
                              {host.policy?.group || "Default"}
                            </span>
                            {host.policy?.canary ? (
                              <span className="border border-signal/30 bg-signal/10 px-1 py-0.5 text-[10px] text-signal font-mono">
                                CANARY
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[11px] text-dim">
                            {formatWindow(host.policy?.maintenanceWindow)}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs px-2"
                            onClick={() => {
                              setActiveHostForPolicy(host);
                              setSelectedIds(new Set([host.vpsId]));
                              setPolicyOpen(true);
                            }}
                          >
                            Edit
                          </Button>
                          {!host.enrolled ? (
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 text-xs px-2"
                              onClick={() => {
                                setSelectedIds(new Set([host.vpsId]));
                                setEnrollOpen(true);
                              }}
                            >
                              Enroll
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs px-2 text-dim hover:text-text"
                              onClick={() => {
                                setSelectedIds(new Set([host.vpsId]));
                                setRolloutOpen(true);
                              }}
                            >
                              Rollout
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Active and Recent Rollouts */}
      <div className="border border-line bg-panel p-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h2 className="text-base font-semibold text-text">Fleet Rollout Campaigns</h2>
            <p className="text-xs text-dim">
              Canary observation (5 min) followed by max-3 concurrent hosts per cohort.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => {
              setSelectedIds(new Set(hosts.map((h) => h.vpsId)));
              setRolloutOpen(true);
            }}
          >
            New Rollout
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          {data === null && error ? (
            <p className="py-4 text-center text-xs text-dim">
              Rollout campaigns unavailable while service is unreachable.
            </p>
          ) : rollouts.length === 0 ? (
            <p className="py-4 text-center text-xs text-dim">No active or historical rollouts.</p>
          ) : (
            rollouts.map((rollout) => {
              const completedCount = rollout.hosts.filter(
                (h) => h.state === "succeeded" || h.state === "rolled_back",
              ).length;

              return (
                <div
                  key={rollout.id}
                  className="border border-line bg-raised/20 p-3.5 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-text text-xs">
                        {rollout.id}
                      </span>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "text-[10px] uppercase font-mono",
                          rollout.state === "running" && "border-info/40 text-info",
                          rollout.state === "paused" && "border-warn/40 text-warn",
                          rollout.state === "completed" && "border-signal/40 text-signal",
                          rollout.state === "failed" && "border-crit/40 text-crit",
                        )}
                      >
                        {rollout.state}
                      </Badge>
                      <span className="text-xs text-dim">
                        Release: <span className="text-text font-mono">{rollout.releaseId}</span>
                      </span>
                      <span className="text-xs text-dim">
                        Group: <span className="text-text">{rollout.group}</span>
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {rollout.state === "running" || rollout.state === "pending" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs border-warn/40 text-warn hover:bg-warn/10"
                          onClick={() => handleRolloutControl(rollout.id, "pause")}
                        >
                          <Pause size={12} className="mr-1" />
                          Pause
                        </Button>
                      ) : null}

                      {rollout.state === "paused" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs border-signal/40 text-signal hover:bg-signal/10"
                          onClick={() => handleRolloutControl(rollout.id, "resume")}
                        >
                          <Play size={12} className="mr-1" />
                          Resume
                        </Button>
                      ) : null}

                      {rollout.state === "failed" || rollout.state === "paused" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs border-info/40 text-info hover:bg-info/10"
                          onClick={() => handleRolloutControl(rollout.id, "retry")}
                        >
                          <RotateCcw size={12} className="mr-1" />
                          Retry
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="text-xs text-dim flex flex-wrap items-center gap-4">
                    <span>
                      Hosts: {completedCount}/{rollout.hosts.length} completed
                    </span>
                    <span>Created: {new Date(rollout.createdAt).toLocaleString()}</span>
                    <span>Updated: {new Date(rollout.updatedAt).toLocaleString()}</span>
                    {rollout.reason ? (
                      <span className="text-warn font-medium">{rollout.reason}</span>
                    ) : null}
                  </div>

                  {/* Individual host progress strip */}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 pt-1">
                    {rollout.hosts.map((rh) => (
                      <div
                        key={rh.vpsId}
                        className="border border-line bg-panel p-2 text-[11px] space-y-0.5"
                      >
                        <div className="font-mono text-text truncate">{rh.vpsId}</div>
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-dim uppercase">{rh.state}</span>
                          {rh.reason ? (
                            <span className="text-crit truncate max-w-[90px]" title={rh.reason}>
                              {rh.reason}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Published Releases Catalog */}
      <div className="border border-line bg-panel p-4">
        <h2 className="text-base font-semibold text-text">Available Signed Releases</h2>
        <p className="text-xs text-dim mb-4">
          All releases require valid Ed25519 cryptographic signatures matching the pinned release key.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data === null && error ? (
            <p className="text-xs text-dim col-span-full">
              Release catalog unavailable while service is unreachable.
            </p>
          ) : releases.length === 0 ? (
            <p className="text-xs text-dim col-span-full">No published releases found in catalog.</p>
          ) : (
            releases.map((release) => (
              <div
                key={release.id}
                className="border border-line bg-raised/20 p-3 space-y-2 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-text text-sm">v{release.version}</div>
                    <div className="font-mono text-[11px] text-dim">{release.id}</div>
                  </div>
                  {release.rollbackSafe ? (
                    <Badge variant="success" className="text-[10px] font-mono">
                      ROLLBACK SAFE
                    </Badge>
                  ) : (
                    <Badge variant="warning" className="text-[10px] font-mono">
                      IRREVERSIBLE
                    </Badge>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-[11px] text-dim">
                    Build: <span className="font-mono text-text">{formatBuild(release.buildId)}</span>
                  </div>
                  <div className="text-[11px] text-dim">
                    Published: {new Date(release.publishedAt).toLocaleDateString()}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1 pt-1">
                  {release.components.map((c) => (
                    <span
                      key={c}
                      className="border border-line bg-panel px-1.5 py-0.5 text-[10px] font-mono text-dim"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Notifications Feed */}
      {notifications.length > 0 ? (
        <div className="border border-line bg-panel p-4">
          <h2 className="text-base font-semibold text-text mb-1">Fleet Notifications</h2>
          <p className="text-xs text-dim mb-3">Audit history retained for 90 days.</p>
          <div className="divide-y divide-line/60">
            {notifications.map((n) => (
              <div key={n.id} className="py-2.5 text-xs flex items-start gap-2.5">
                <span
                  className={cn(
                    "mt-0.5 h-2 w-2 rounded-full shrink-0",
                    n.kind === "error" && "bg-crit",
                    n.kind === "warning" && "bg-warn",
                    n.kind === "success" && "bg-signal",
                    n.kind === "info" && "bg-info",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-text leading-snug">{n.message}</p>
                  <span className="text-[10px] text-dim">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Dialog: Bulk Opt-In Enrollment */}
      <FleetEnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        vpsIds={Array.from(selectedIds)}
        groups={groups}
        onComplete={async (msg) => {
          setActionNotice({ kind: "success", message: msg });
          setSelectedIds(new Set());
          await loadData(true);
        }}
      />

      {/* Dialog: Policy Configuration */}
      <FleetPolicyDialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        vpsIds={Array.from(selectedIds)}
        groups={groups}
        releases={releases}
        initialPolicy={activeHostForPolicy?.policy}
        onComplete={async (msg) => {
          setActionNotice({ kind: "success", message: msg });
          setSelectedIds(new Set());
          setActiveHostForPolicy(null);
          await loadData(true);
        }}
      />

      {/* Dialog: Rollout Trigger */}
      <FleetRolloutDialog
        open={rolloutOpen}
        onOpenChange={setRolloutOpen}
        vpsIds={Array.from(selectedIds)}
        releases={releases}
        onComplete={async (msg) => {
          setActionNotice({ kind: "success", message: msg });
          setSelectedIds(new Set());
          await loadData(true);
        }}
      />
    </div>
  );
}

// ── Dialog: Enroll ────────────────────────────────────────────────────

function FleetEnrollDialog({
  open,
  onOpenChange,
  vpsIds,
  groups,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vpsIds: string[];
  groups: FleetGroup[];
  onComplete: (message: string) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState<FleetPolicyMode>("auto");
  const [group, setGroup] = useState("Default");
  const [canary, setCanary] = useState(false);
  const [tz, setTz] = useState("UTC");
  const [start, setStart] = useState("02:00");
  const [end, setEnd] = useState("05:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOvernight = end < start;

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b),
    );
  }

  async function handleEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) {
      setError("Explicit confirmation is required for host enrollment.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const policy: FleetPolicy = {
        mode,
        group: group.trim() || "Default",
        canary,
        maintenanceWindow: {
          timezone: tz.trim() || "UTC",
          start,
          end,
          days,
        },
      };
      const res = await enrollFleetHosts({
        vpsIds,
        confirmed: true,
        policy,
      });

      const enrolledCount = res.results.filter((r) => r.status === "enrolled").length;
      const needsSetupCount = res.results.filter((r) => r.status === "needs_setup").length;
      const failedCount = res.results.filter((r) => r.status === "failed").length;

      let msg = `Enrolled ${enrolledCount} host(s) successfully.`;
      if (needsSetupCount > 0) msg += ` (${needsSetupCount} require trust setup)`;
      if (failedCount > 0) msg += ` (${failedCount} failed)`;

      onOpenChange(false);
      await onComplete(msg);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg border border-line bg-panel p-6 text-text">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg font-bold">
            Bulk Opt-In Host Enrollment
          </AlertDialogTitle>
          <AlertDialogDescription className="text-xs text-dim">
            Explicit opt-in is required for existing hosts. New hosts automatically disclose stable
            auto channel enrollment upon installation.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form onSubmit={handleEnroll} className="space-y-4 pt-2">
          {error ? (
            <div className="border border-crit/40 bg-crit/10 p-2 text-xs text-crit">{error}</div>
          ) : null}

          <div className="border border-line bg-raised/30 p-2.5 text-xs">
            <span className="font-semibold text-text">Target hosts ({vpsIds.length}):</span>
            <div className="font-mono text-[11px] text-dim truncate mt-0.5">
              {vpsIds.join(", ")}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Policy Mode</Label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as FleetPolicyMode)}
                className="mt-1 h-8 w-full border border-line bg-ink px-2 text-xs text-text"
              >
                <option value="auto">Auto (stable rollback-safe)</option>
                <option value="manual">Manual rollout only</option>
                <option value="pinned">Pinned release</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Cohort Group</Label>
              <Input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="Default"
                className="mt-1 h-8 text-xs"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enroll-canary"
              checked={canary}
              onChange={(e) => setCanary(e.target.checked)}
              className="accent-signal cursor-pointer"
            />
            <label htmlFor="enroll-canary" className="text-xs text-text cursor-pointer">
              Designate as Canary host (observed for 5 min before broader group rollout)
            </label>
          </div>

          {/* Maintenance window */}
          <div className="border border-line bg-raised/20 p-3 space-y-2 text-xs">
            <div className="font-semibold text-text flex items-center justify-between">
              <span>Maintenance Window</span>
              {isOvernight ? (
                <span className="text-[10px] text-warn font-mono">Spans midnight (overnight)</span>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-[10px] text-dim">Timezone</Label>
                <Input
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  className="h-7 text-xs"
                />
              </div>
              <div>
                <Label className="text-[10px] text-dim">Start (HH:mm)</Label>
                <Input
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="h-7 text-xs font-mono"
                />
              </div>
              <div>
                <Label className="text-[10px] text-dim">End (HH:mm)</Label>
                <Input
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="h-7 text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <Label className="text-[10px] text-dim block mb-1">Active Days</Label>
              <div className="flex flex-wrap gap-1">
                {DAYS_OF_WEEK.map((name, idx) => (
                  <button
                    type="button"
                    key={name}
                    onClick={() => toggleDay(idx)}
                    className={cn(
                      "px-2 py-1 text-[10px] font-mono border",
                      days.includes(idx)
                        ? "border-signal bg-signal/15 text-signal font-semibold"
                        : "border-line bg-ink text-dim",
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="border border-line bg-raised/40 p-2.5 space-y-1 text-xs">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id="enroll-confirm"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 accent-signal cursor-pointer"
              />
              <label htmlFor="enroll-confirm" className="text-xs text-text cursor-pointer leading-tight">
                I explicitly confirm opt-in enrollment for {vpsIds.length} host(s). Only rollback-safe
                signed releases will be installed automatically.
              </label>
            </div>
          </div>

          <AlertDialogFooter className="pt-2">
            <AlertDialogCancel
              type="button"
              disabled={submitting}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <Button
              type="submit"
              disabled={!confirmed || submitting}
              className="h-8 text-xs"
            >
              {submitting ? "Enrolling…" : "Enroll Hosts"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Dialog: Policy ────────────────────────────────────────────────────

function FleetPolicyDialog({
  open,
  onOpenChange,
  vpsIds,
  groups,
  releases,
  initialPolicy,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vpsIds: string[];
  groups: FleetGroup[];
  releases: FleetRelease[];
  initialPolicy?: FleetPolicy;
  onComplete: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<FleetPolicyMode>(initialPolicy?.mode || "auto");
  const [group, setGroup] = useState(initialPolicy?.group || "Default");
  const [pinnedReleaseId, setPinnedReleaseId] = useState(initialPolicy?.pinnedReleaseId || "");
  const [canary, setCanary] = useState(initialPolicy?.canary || false);
  const [tz, setTz] = useState(initialPolicy?.maintenanceWindow?.timezone || "UTC");
  const [start, setStart] = useState(initialPolicy?.maintenanceWindow?.start || "02:00");
  const [end, setEnd] = useState(initialPolicy?.maintenanceWindow?.end || "05:00");
  const [days, setDays] = useState<number[]>(
    initialPolicy?.maintenanceWindow?.days || [1, 2, 3, 4, 5],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPolicy) {
      setMode(initialPolicy.mode);
      setGroup(initialPolicy.group);
      setPinnedReleaseId(initialPolicy.pinnedReleaseId || "");
      setCanary(!!initialPolicy.canary);
      if (initialPolicy.maintenanceWindow) {
        setTz(initialPolicy.maintenanceWindow.timezone || "UTC");
        setStart(initialPolicy.maintenanceWindow.start || "02:00");
        setEnd(initialPolicy.maintenanceWindow.end || "05:00");
        setDays(initialPolicy.maintenanceWindow.days || [1, 2, 3, 4, 5]);
      }
    }
  }, [initialPolicy, open]);

  const isOvernight = end < start;

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b),
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const policy: FleetPolicy = {
        mode,
        group: group.trim() || "Default",
        pinnedReleaseId: mode === "pinned" ? pinnedReleaseId || undefined : undefined,
        canary,
        maintenanceWindow: {
          timezone: tz.trim() || "UTC",
          start,
          end,
          days,
        },
      };

      await updateFleetPolicies({
        vpsIds,
        policy,
      });

      onOpenChange(false);
      await onComplete(`Policy updated successfully for ${vpsIds.length} host(s).`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update policy");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg border border-line bg-panel p-6 text-text">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg font-bold">
            Update Agent Update Policy
          </AlertDialogTitle>
          <AlertDialogDescription className="text-xs text-dim">
            Configure rollout modes, canary flags, and overnight maintenance windows for {vpsIds.length} host(s).
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form onSubmit={handleSave} className="space-y-4 pt-2">
          {error ? (
            <div className="border border-crit/40 bg-crit/10 p-2 text-xs text-crit">{error}</div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Update Mode</Label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as FleetPolicyMode)}
                className="mt-1 h-8 w-full border border-line bg-ink px-2 text-xs text-text"
              >
                <option value="auto">Auto (automatic stable updates)</option>
                <option value="manual">Manual (only on operator trigger)</option>
                <option value="pinned">Pinned (locked to release)</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Policy Group</Label>
              <Input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="Default"
                className="mt-1 h-8 text-xs"
              />
            </div>
          </div>

          {mode === "pinned" ? (
            <div>
              <Label className="text-xs">Pinned Release</Label>
              <select
                value={pinnedReleaseId}
                onChange={(e) => setPinnedReleaseId(e.target.value)}
                className="mt-1 h-8 w-full border border-line bg-ink px-2 text-xs text-text font-mono"
              >
                <option value="">Select pinned release…</option>
                {releases.map((r) => (
                  <option key={r.id} value={r.id}>
                    v{r.version} ({formatBuild(r.buildId)})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="policy-canary"
              checked={canary}
              onChange={(e) => setCanary(e.target.checked)}
              className="accent-signal cursor-pointer"
            />
            <label htmlFor="policy-canary" className="text-xs text-text cursor-pointer">
              Designate as Canary host (first release recipient in cohort)
            </label>
          </div>

          {/* Maintenance window */}
          <div className="border border-line bg-raised/20 p-3 space-y-2 text-xs">
            <div className="font-semibold text-text flex items-center justify-between">
              <span>Maintenance Window</span>
              {isOvernight ? (
                <span className="text-[10px] text-warn font-mono">Overnight (spans midnight)</span>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-[10px] text-dim">Timezone</Label>
                <Input
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  className="h-7 text-xs"
                />
              </div>
              <div>
                <Label className="text-[10px] text-dim">Start (HH:mm)</Label>
                <Input
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="h-7 text-xs font-mono"
                />
              </div>
              <div>
                <Label className="text-[10px] text-dim">End (HH:mm)</Label>
                <Input
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="h-7 text-xs font-mono"
                />
              </div>
            </div>

            <div>
              <Label className="text-[10px] text-dim block mb-1">Active Days</Label>
              <div className="flex flex-wrap gap-1">
                {DAYS_OF_WEEK.map((name, idx) => (
                  <button
                    type="button"
                    key={name}
                    onClick={() => toggleDay(idx)}
                    className={cn(
                      "px-2 py-1 text-[10px] font-mono border",
                      days.includes(idx)
                        ? "border-signal bg-signal/15 text-signal font-semibold"
                        : "border-line bg-ink text-dim",
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <AlertDialogFooter className="pt-2">
            <AlertDialogCancel
              type="button"
              disabled={submitting}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <Button
              type="submit"
              disabled={submitting}
              className="h-8 text-xs"
            >
              {submitting ? "Saving…" : "Save Policy"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Dialog: Rollout ───────────────────────────────────────────────────

function FleetRolloutDialog({
  open,
  onOpenChange,
  vpsIds,
  releases,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vpsIds: string[];
  releases: FleetRelease[];
  onComplete: (message: string) => Promise<void>;
}) {
  const [releaseId, setReleaseId] = useState(releases[0]?.id || "");
  const [confirmed, setConfirmed] = useState(false);
  const [irreversibleConsent, setIrreversibleConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!releaseId && releases.length > 0) {
      setReleaseId(releases[0].id);
    }
  }, [releases, releaseId]);

  useEffect(() => {
    setIrreversibleConsent(false);
  }, [releaseId]);

  const selectedRelease = releases.find((r) => r.id === releaseId);

  async function handleRollout(e: React.FormEvent) {
    e.preventDefault();
    if (!releaseId) {
      setError("Please select a signed release to roll out.");
      return;
    }
    if (!confirmed) {
      setError("Explicit confirmation is required to trigger rollout.");
      return;
    }
    if (selectedRelease && !selectedRelease.rollbackSafe && !irreversibleConsent) {
      setError("Explicit consent for irreversible changes is required to proceed.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await createFleetRollout({
        vpsIds,
        releaseId,
        confirmed: true,
        irreversibleConsent:
          selectedRelease && !selectedRelease.rollbackSafe ? irreversibleConsent : undefined,
      });

      onOpenChange(false);
      await onComplete(`Rollout campaign ${res.id} queued successfully for ${vpsIds.length} host(s).`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to initiate rollout");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg border border-line bg-panel p-6 text-text">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg font-bold">
            Trigger Fleet Agent Rollout
          </AlertDialogTitle>
          <AlertDialogDescription className="text-xs text-dim">
            Deploys signed release artifacts to {vpsIds.length} target host(s) following cohort
            concurrency (1 canary, then max-3 concurrent).
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form onSubmit={handleRollout} className="space-y-4 pt-2">
          {error ? (
            <div className="border border-crit/40 bg-crit/10 p-2 text-xs text-crit">{error}</div>
          ) : null}

          <div className="border border-line bg-raised/30 p-2.5 text-xs">
            <span className="font-semibold text-text">Target hosts ({vpsIds.length}):</span>
            <div className="font-mono text-[11px] text-dim truncate mt-0.5">
              {vpsIds.join(", ")}
            </div>
          </div>

          <div>
            <Label className="text-xs">Signed Release</Label>
            <select
              value={releaseId}
              onChange={(e) => setReleaseId(e.target.value)}
              className="mt-1 h-8 w-full border border-line bg-ink px-2 text-xs text-text font-mono"
            >
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.version} ({formatBuild(r.buildId)}) — {r.rollbackSafe ? "Rollback Safe" : "Irreversible"}
                </option>
              ))}
            </select>
          </div>

          {selectedRelease && !selectedRelease.rollbackSafe ? (
            <div className="border border-warn/40 bg-warn/10 p-2.5 text-xs text-warn space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Irreversible Release Warning:</span>
                  <p className="mt-0.5 text-dim">
                    This release contains changes that cannot be automatically rolled back. Manual operator
                    consent is mandatory.
                  </p>
                </div>
              </div>
              <label className="flex items-start gap-2 cursor-pointer font-normal text-text pt-1.5 border-t border-warn/25">
                <input
                  type="checkbox"
                  id="irreversible-consent"
                  checked={irreversibleConsent}
                  onChange={(e) => setIrreversibleConsent(e.target.checked)}
                  className="mt-0.5 accent-warn cursor-pointer"
                />
                <span className="leading-tight">
                  I give explicit consent to apply this irreversible release, acknowledging automated rollback is unavailable.
                </span>
              </label>
            </div>
          ) : null}

          <div className="border border-line bg-raised/40 p-2.5 space-y-1 text-xs">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id="rollout-confirm"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 accent-signal cursor-pointer"
              />
              <label htmlFor="rollout-confirm" className="text-xs text-text cursor-pointer leading-tight">
                I explicitly confirm triggering the rollout of release {releaseId} to {vpsIds.length} host(s).
              </label>
            </div>
          </div>

          <AlertDialogFooter className="pt-2">
            <AlertDialogCancel
              type="button"
              disabled={submitting}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <Button
              type="submit"
              disabled={
                !confirmed ||
                (!!selectedRelease && !selectedRelease.rollbackSafe && !irreversibleConsent) ||
                submitting
              }
              className="h-8 text-xs"
            >
              {submitting ? "Initiating Rollout…" : "Start Rollout"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
