import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "../lib/utils";
import { formatThroughput } from "../components/dashboard/metrics/historySeries";
import {
  AuditPanel,
  AssistantPanel,
  JobsPanel,
  MetricsPanel,
  OverviewPanel,
  SettingsPanel,
  TerminalPanel,
  FilesPanel,
  SftpSettingsCard,
} from "../components/dashboard/DashboardPanels";
import {
  getVpsDockerStorage,
  listVpsDockerContainerHistory,
  listVpsDockerCurrentContainers,
  listVpsDockerAlerts,
  listVpsDockerEvents,
  listVpsDockerHistory,
  listVpsDockerRollups,
  listVpsAuditEvents,
  listVpsJobs,
  listVpsMetrics,
  type AuditEvent,
  type DashboardJob,
  type DashboardMetric,
  type DashboardOverview,
  type DockerAlert,
  type DockerCurrentContainer,
  type DockerOperationalEvent,
  type DockerHostSample,
  type DockerMetricRollup,
  type DockerStorageLatest,
  type VpsRecord,
} from "../lib/api";
import { subscribeMonitoring } from "../lib/live-api";
import { useDashboard } from "./DashboardContext";
import { freshnessLabel, serverStatusLabel, vpsDisplayName } from "../lib/dashboard-formatters";
import { DockerMetricsPanel } from "../components/dashboard/servers/DockerMetricsPanel";
import { DockerCapabilityNotice } from "../components/dashboard/docker/DockerCapabilityNotice";
import { DockerHistoryChart } from "../components/dashboard/docker/DockerHistoryChart";
import { DockerEventTimeline } from "../components/dashboard/docker/DockerEventTimeline";
import { DockerAlertsPanel } from "../components/dashboard/docker/DockerAlertsPanel";
import { DockerContainerManagementPanel } from "../components/dashboard/docker/DockerContainerManagementPanel";
import { DockerStorageOverview } from "../components/dashboard/docker/DockerStorageOverview";
import { DockerContainerInvestigationPanel } from "../components/dashboard/docker/DockerContainerInvestigationPanel";
import { DockerWorkloads } from "../components/dashboard/docker/DockerWorkloads";
import { ComposeApplicationsPanel } from "../components/dashboard/docker/applications/ComposeApplicationsPanel";

// ── Context type ────────────────────────────────────────────────────

export type VpsWorkspaceCtx = {
  vps: VpsRecord;
  overview: DashboardOverview;
};

export const VpsWorkspaceContext = createContext<VpsWorkspaceCtx | null>(null);

export function useVpsWorkspace(): VpsWorkspaceCtx {
  const ctx = useContext(VpsWorkspaceContext);
  if (!ctx)
    throw new Error("useVpsWorkspace must be used within VpsWorkspaceLayout");
  return ctx;
}

// ── Helper ──────────────────────────────────────────────────────────

/** Merge arrays by `id`, global (live) record overwrites bootstrap record. */
function mergeById<T extends { id: string }>(global: T[], bootstrap: T[]): T[] {
  if (bootstrap.length === 0) return global;
  if (global.length === 0) return bootstrap;
  const map = new Map<string, T>();
  for (const item of bootstrap) map.set(item.id, item);
  for (const item of global) map.set(item.id, item);
  return Array.from(map.values());
}

const EMPTY_CURRENT_TARGETS: DockerCurrentContainer[] = [];

// ── Sub-page config ─────────────────────────────────────────────────

const workspaceSubPages = [
  { label: "Overview", to: "", end: true },
  { label: "Assistant", to: "assistant", end: false },
  { label: "Metrics", to: "metrics", end: false },
  { label: "Docker", to: "docker", end: false },
  { label: "Jobs", to: "jobs", end: false },
  { label: "Audit", to: "audit", end: false },
  { label: "Terminal", to: "terminal", end: false },
  { label: "Files", to: "files", end: false },
  { label: "Settings", to: "settings", end: false },
] as const;

// ── Layout ──────────────────────────────────────────────────────────

export function VpsWorkspaceLayout() {
  const { vpsId } = useParams<{ vpsId: string }>();
  const location = useLocation();
  const ctx = useDashboard();
  // ── Scoped REST bootstrap state ────────────────────────────────────
  const [scopedBootstrap, setScopedBootstrap] = useState<
    Record<
      string,
      {
        metrics: DashboardMetric[] | null;
        jobs: DashboardJob[] | null;
        audit: AuditEvent[] | null;
      }
    >
  >({});
  const hasBootstrappedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!vpsId || !ctx.loaded || hasBootstrappedRef.current.has(vpsId)) return;
    hasBootstrappedRef.current.add(vpsId);
    let cancelled = false;

    listVpsMetrics(vpsId)
      .then((data) => {
        if (!cancelled)
          setScopedBootstrap((prev) => ({
            ...prev,
            [vpsId]: { ...prev[vpsId], metrics: data },
          }));
      })
      .catch(() => {
        /* global data is fallback */
      });

    listVpsJobs(vpsId)
      .then((data) => {
        if (!cancelled)
          setScopedBootstrap((prev) => ({
            ...prev,
            [vpsId]: { ...prev[vpsId], jobs: data },
          }));
      })
      .catch(() => {
        /* global data is fallback */
      });

    listVpsAuditEvents(vpsId)
      .then((data) => {
        if (!cancelled)
          setScopedBootstrap((prev) => ({
            ...prev,
            [vpsId]: { ...prev[vpsId], audit: data },
          }));
      })
      .catch(() => {
        /* global data is fallback */
      });

    return () => {
      cancelled = true;
    };
  }, [vpsId, ctx.loaded]);

  useEffect(() => {
    return () => {
      hasBootstrappedRef.current = new Set();
    };
  }, []);

  // Loading state
  if (!ctx.loaded) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-[13px] text-dim">Loading VPS workspace...</div>
      </div>
    );
  }

  // Not-found state
  const vps = ctx.records.find((record) => record.id === vpsId);
  if (!vps || !vpsId) {
    return <div className="p-6 text-dim">VPS not found.</div>;
  }
  const displayName = vpsDisplayName(vps);

  // ── Compute scoped view model ─────────────────────────────────────
  const globalMetrics = ctx.metrics.filter((metric) => metric.vpsId === vpsId);
  const globalJobs = ctx.jobs.filter((job) => job.vpsId === vpsId);

  const prefill = scopedBootstrap[vpsId];

  const metrics =
    globalMetrics.length > 0
      ? globalMetrics
      : (prefill?.metrics ?? globalMetrics);
  const jobs = prefill?.jobs ? mergeById(globalJobs, prefill.jobs) : globalJobs;

  const vpsJobIds = new Set(jobs.map((j) => j.id));
  const globalAudit = ctx.auditEvents.filter(
    (event) =>
      event.resourceId === vpsId ||
      (event.jobId != null && vpsJobIds.has(event.jobId)) ||
      (event.resourceId != null && vpsJobIds.has(event.resourceId)) ||
      event.serverLabel === displayName ||
      event.serverLabel === vps.name,
  );
  const auditEvents = prefill?.audit
    ? mergeById(globalAudit, prefill.audit)
    : globalAudit;
  const systemInfo = ctx.systemInfo.filter((system) => system.vpsId === vpsId);
  const dockerMetrics = ctx.dockerMetrics.filter(
    (docker) => docker.vpsId === vpsId,
  );

  const overview: DashboardOverview = {
    ...ctx.overview,
    summary: {
      ...ctx.overview.summary,
      totalServers: 1,
      healthyServers: vps.status === "healthy" ? 1 : 0,
      warningServers: vps.status === "warning" ? 1 : 0,
      unreachableServers: vps.status === "unreachable" ? 1 : 0,
      runningJobs: jobs.filter((job) => job.status === "running").length,
    },
    servers: [vps],
    metrics,
    jobs,
    auditEvents,
    systemInfo,
    dockerMetrics,
  };

  const workspaceValue: VpsWorkspaceCtx = { vps, overview };
  const latestMetric = metrics[0];
  const cpuVal = latestMetric?.cpu;
  const memVal = latestMetric?.memory;
  const diskVal = latestMetric?.disk;
  const loadVal = latestMetric?.loadAverage;
  const netRx = latestMetric?.networkRx;
  const netTx = latestMetric?.networkTx;

  // The identity banner and live resource strip stay on the workspace
  // Overview only; every section duplicates its own context via the
  // subpage heading, and the fleet rail already carries host state.
  const isOverview =
    location.pathname.replace(/\/+$/, "") === `/vps/${vpsId}`;

  return (
    <VpsWorkspaceContext.Provider value={workspaceValue}>
      <div className="min-w-0">
        <div className="mb-2">
          <Link
            to="/vps"
            className="inline-flex min-h-8 items-center gap-1.5 text-xs text-dim transition-colors duration-160 ease-out hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            <ArrowLeft size={13} aria-hidden="true" />
            Server list
          </Link>
        </div>

        {/* Workspace Horizontal Navigation Tabs (above the Overview-only
            banner so tab positions never shift between sections) */}
        <div className="relative border-b border-line">
          <div className="overflow-x-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-track]:bg-panel [&::-webkit-scrollbar-thumb]:bg-line hover:[&::-webkit-scrollbar-thumb]:bg-dim/40">
            <nav
              aria-label={`${displayName} workspace sections`}
              className="flex w-max min-w-full items-center pr-4"
            >
              {workspaceSubPages.map((page) => (
                <NavLink
                  key={page.to || "overview"}
                  end={page.end}
                  to={page.to || ""}
                  className={({ isActive }) =>
                    [
                      "-mb-px inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-4 py-3 text-[13px] font-medium transition-colors duration-160 ease-out focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                      isActive
                        ? "border-signal bg-raised/20 font-semibold text-signal"
                        : "border-transparent text-dim hover:bg-raised/30 hover:text-text",
                    ].join(" ")
                  }
                >
                  {page.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>

        {/* Host Identity Banner & Compact Resource Strip
            (Overview only, below the tabs — de-duplicated from other
            workspace sections without shifting the tab bar) */}
        {isOverview ? (
        <div className="mt-4 mb-4 border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="truncate text-xl font-bold tracking-tight text-text sm:text-2xl">
                  {displayName}
                </h1>
                {(!vps.status || vps.status === "unknown") && vps.agentStatus ? null : (
                  <WorkspaceStatusBadge status={vps.status} />
                )}
                {vps.agentStatus ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 border px-2 py-0.5 text-[11px] font-medium",
                      vps.agentStatus === "online"
                        ? "border-signal/40 bg-signal/10 text-signal"
                        : vps.agentStatus === "failed"
                          ? "border-crit/40 bg-crit/10 text-crit"
                          : vps.agentStatus === "offline"
                            ? "border-warn/40 bg-warn/10 text-warn"
                            : "border-line bg-raised text-dim",
                    )}
                  >
                    {agentStatusLabel(vps.agentStatus)}
                  </span>
                ) : null}
              </div>
              <div className="tnum mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
                <span className="font-mono break-all">{vps.username}@{vps.host}:{vps.port}</span>
                {vps.provider ? <span>· {vps.provider}</span> : null}
                {vps.city || vps.country ? (
                  <span>· {[vps.city, vps.country].filter(Boolean).join(", ")}</span>
                ) : null}
                {latestMetric?.collectedAt ? (
                  <span>· Last seen {freshnessLabel(latestMetric.collectedAt)}</span>
                ) : null}
              </div>
            </div>

          </div>

          {/* Compact Resource Strip */}
          <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line/60 pt-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-dim">CPU</span>
              <span
                className={cn(
                  "tnum font-medium",
                  cpuVal != null && cpuVal >= 85
                    ? "text-crit"
                    : cpuVal != null && cpuVal >= 70
                      ? "text-warn"
                      : "text-text",
                )}
              >
                {cpuVal != null ? `${cpuVal.toFixed(1)}%` : "n/a"}
              </span>
              {cpuVal != null ? (
                <div className="h-1.5 w-12 overflow-hidden bg-line">
                  <div
                    className={cn(
                      "h-full",
                      cpuVal >= 85 ? "bg-crit" : cpuVal >= 70 ? "bg-warn" : "bg-signal",
                    )}
                    style={{ width: `${Math.min(100, Math.max(0, cpuVal))}%` }}
                  />
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-dim">RAM</span>
              <span
                className={cn(
                  "tnum font-medium",
                  memVal != null && memVal >= 85
                    ? "text-crit"
                    : memVal != null && memVal >= 70
                      ? "text-warn"
                      : "text-text",
                )}
              >
                {memVal != null ? `${memVal.toFixed(1)}%` : "n/a"}
              </span>
              {memVal != null ? (
                <div className="h-1.5 w-12 overflow-hidden bg-line">
                  <div
                    className={cn(
                      "h-full",
                      memVal >= 85 ? "bg-crit" : memVal >= 70 ? "bg-warn" : "bg-info",
                    )}
                    style={{ width: `${Math.min(100, Math.max(0, memVal))}%` }}
                  />
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-dim">Disk</span>
              <span
                className={cn(
                  "tnum font-medium",
                  diskVal != null && diskVal >= 85
                    ? "text-crit"
                    : diskVal != null && diskVal >= 70
                      ? "text-warn"
                      : "text-text",
                )}
              >
                {diskVal != null ? `${diskVal.toFixed(1)}%` : "n/a"}
              </span>
              {diskVal != null ? (
                <div className="h-1.5 w-12 overflow-hidden bg-line">
                  <div
                    className={cn(
                      "h-full",
                      diskVal >= 85 ? "bg-crit" : diskVal >= 70 ? "bg-warn" : "bg-signal",
                    )}
                    style={{ width: `${Math.min(100, Math.max(0, diskVal))}%` }}
                  />
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-dim">Load</span>
              <span className="tnum font-medium text-text">
                {loadVal != null ? loadVal.toFixed(2) : "n/a"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-dim">Net I/O</span>
              <span className="tnum text-dim">
                {netRx != null || netTx != null ? (
                  <>
                    <span className="font-medium text-text">
                      {netRx != null ? formatThroughput(netRx) : "n/a"}
                    </span>{" "}
                    RX /{" "}
                    <span className="font-medium text-text">
                      {netTx != null ? formatThroughput(netTx) : "n/a"}
                    </span>{" "}
                    TX
                  </>
                ) : (
                  <span className="font-medium text-text">n/a</span>
                )}
              </span>
            </div>
          </div>
        </div>
        ) : null}

        {/* Smooth 240ms Animated Content Transition */}
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="mt-5 min-w-0"
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </div>
    </VpsWorkspaceContext.Provider>
  );
}

function WorkspaceStatusBadge({ status }: { status?: VpsRecord["status"] }) {
  const tone =
    status === "healthy"
      ? "border-signal/40 bg-signal/10 text-signal"
      : status === "warning"
        ? "border-warn/40 bg-warn/10 text-warn"
        : status === "unreachable"
          ? "border-crit/40 bg-crit/10 text-crit"
          : "border-line bg-raised text-dim";
  const label = serverStatusLabel(status);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-0.5 text-[11px] font-medium ${tone}`}
    >
      <i
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-current"
      />
      Host {label.toLowerCase()}
    </span>
  );
}

// ── Child pages ─────────────────────────────────────────────────────

export function VpsWorkspaceOverviewPage() {
  const { vps, overview } = useVpsWorkspace();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight text-text">
        Overview for {vpsDisplayName(vps)}
      </h2>
      <OverviewPanel overview={overview} />
    </div>
  );
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
    case undefined:
      return "";
  }
}

export function VpsWorkspaceDockerPage() {
  const { vps, overview } = useVpsWorkspace();
  const dashboard = useDashboard();
  const snapshot = overview.dockerMetrics[0];
  const monitoringEnabled = vps.dockerMetricsEnabled === true;
  const managementEnabled = vps.dockerManagementEnabled === true;
  const [dockerView, setDockerView] = useState<"containers" | "applications">("containers");
  const [history, setHistory] = useState<DockerHostSample[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [rollups, setRollups] = useState<DockerMetricRollup[]>([]);
  const [events, setEvents] = useState<DockerOperationalEvent[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [alerts, setAlerts] = useState<DockerAlert[]>([]);
  const [alertsTotal, setAlertsTotal] = useState(0);
  const [storage, setStorage] = useState<DockerStorageLatest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resourceErrors, setResourceErrors] = useState<Record<string, string | null>>({});
  const [resourcePages, setResourcePages] = useState<Record<string, { cursor?: string; hasMore: boolean }>>({});
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // Selectable container targets come from GET /docker/containers/current —
  // never from the stored snapshot projection, whose container keys can be
  // stale. `scopeId` tags the list so a previous VPS's targets (and any
  // selection made against them) cannot leak into this server's history.
  const [currentContainers, setCurrentContainers] = useState<{ scopeId: string; targets: DockerCurrentContainer[] } | null>(null);
  const [currentContainersLoading, setCurrentContainersLoading] = useState(false);
  const [currentContainersError, setCurrentContainersError] = useState<string | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
  const [containerHistory, setContainerHistory] = useState<DockerHostSample[]>([]);
  const [containerHistoryError, setContainerHistoryError] = useState<string | null>(null);
  const [containerHistoryLoading, setContainerHistoryLoading] = useState(false);

  const currentTargets = currentContainers?.scopeId === vps.id ? currentContainers.targets : EMPTY_CURRENT_TARGETS;
  const selectedTarget = currentTargets.find((item) => JSON.stringify([item.agentInstanceId, item.containerKey]) === selectedContainer) ?? null;

  const loadMore = async (resource: "history" | "rollups" | "events" | "alerts") => {
    const cursor = resourcePages[resource]?.cursor;
    if (!monitoringEnabled || !cursor || loadingMore === resource) return;
    setLoadingMore(resource);
    try {
      if (resource === "history") {
        const result = await listVpsDockerHistory(vps.id, { limit: 100, cursor });
        setHistory((items) => [...items, ...result.data]); setHistoryTotal((n) => n + result.data.length);
        setResourcePages((pages) => ({ ...pages, history: { cursor: result.page.nextCursor, hasMore: result.page.hasMore } }));
      } else if (resource === "rollups") {
        const result = await listVpsDockerRollups(vps.id, { limit: 100, cursor });
        setRollups((items) => [...items, ...result.data]);
        setResourcePages((pages) => ({ ...pages, rollups: { cursor: result.page.nextCursor, hasMore: result.page.hasMore } }));
      } else if (resource === "events") {
        const result = await listVpsDockerEvents(vps.id, { limit: 50, cursor });
        setEvents((items) => [...items, ...result.data]); setEventsTotal((n) => n + result.data.length);
        setResourcePages((pages) => ({ ...pages, events: { cursor: result.page.nextCursor, hasMore: result.page.hasMore } }));
      } else {
        const result = await listVpsDockerAlerts(vps.id, { limit: 50, cursor });
        setAlerts((items) => [...items, ...result.data]); setAlertsTotal((n) => n + result.data.length);
        setResourcePages((pages) => ({ ...pages, alerts: { cursor: result.page.nextCursor, hasMore: result.page.hasMore } }));
      }
    } catch (err) { setResourceErrors((errors) => ({ ...errors, [resource]: err instanceof Error ? err.message : "Unable to load more" })); }
    finally { setLoadingMore(null); }
  };

  useEffect(() => {
    const scopeId = vps.id;
    if (!monitoringEnabled) {
      setLoading(false);
      setHistory([]); setHistoryTotal(0); setRollups([]); setEvents([]); setEventsTotal(0); setAlerts([]); setAlertsTotal(0); setStorage(null);
      setResourceErrors({}); setResourcePages({}); setContainerHistory([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Reset scope state so a previous VPS never flashes through.
    setHistory([]); setHistoryTotal(0); setRollups([]); setEvents([]); setEventsTotal(0); setAlerts([]); setAlertsTotal(0); setStorage(null);
    setResourceErrors({}); setResourcePages({});
    (async () => {
      try {
        const [h, r, e, a, s] = await Promise.allSettled([
          listVpsDockerHistory(scopeId, { limit: 100 }),
          listVpsDockerRollups(scopeId, { limit: 100 }),
          listVpsDockerEvents(scopeId, { limit: 50 }),
          listVpsDockerAlerts(scopeId, { limit: 50 }),
          getVpsDockerStorage(scopeId),
        ]);
        if (cancelled) return;
        const failures: string[] = [];
        const nextErrors: Record<string, string | null> = {};
        const nextPages: Record<string, { cursor?: string; hasMore: boolean }> = {};
        if (h.status === "fulfilled") {
          setHistory(h.value.data);
          setHistoryTotal(h.value.data.length);
          nextPages.history = { cursor: h.value.page.nextCursor, hasMore: h.value.page.hasMore };
        } else { failures.push("history"); nextErrors.history = h.reason instanceof Error ? h.reason.message : "History unavailable"; }
        if (r.status === "fulfilled") { setRollups(r.value.data); nextPages.rollups = { cursor: r.value.page.nextCursor, hasMore: r.value.page.hasMore }; }
        else { failures.push("rollups"); nextErrors.rollups = r.reason instanceof Error ? r.reason.message : "Rollups unavailable"; }
        if (e.status === "fulfilled") { setEvents(e.value.data); setEventsTotal(e.value.data.length); nextPages.events = { cursor: e.value.page.nextCursor, hasMore: e.value.page.hasMore }; }
        else { failures.push("events"); nextErrors.events = e.reason instanceof Error ? e.reason.message : "Events unavailable"; }
        if (a.status === "fulfilled") { setAlerts(a.value.data); setAlertsTotal(a.value.data.length); nextPages.alerts = { cursor: a.value.page.nextCursor, hasMore: a.value.page.hasMore }; }
        else { failures.push("alerts"); nextErrors.alerts = a.reason instanceof Error ? a.reason.message : "Alerts unavailable"; }
        if (s.status === "fulfilled") setStorage(s.value);
        else { failures.push("storage"); nextErrors.storage = s.reason instanceof Error ? s.reason.message : "Storage unavailable"; }
        setResourceErrors(nextErrors);
        setResourcePages(nextPages);
        if (failures.length === 5) throw new Error("Docker detail data is unavailable right now.");
        if (failures.length) setError(`Some Docker detail sections are unavailable: ${failures.join(", " )}.`);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Docker detail data is unavailable right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vps.id, monitoringEnabled, refreshTick]);

  // Live container targets for this server. Refetched on VPS change and on
  // every monitoring refresh tick.
  useEffect(() => {
    const scopeId = vps.id;
    let cancelled = false;
    setCurrentContainersLoading(true);
    setCurrentContainersError(null);
    listVpsDockerCurrentContainers(scopeId)
      .then((targets) => { if (!cancelled) setCurrentContainers({ scopeId, targets }); })
      .catch((err) => {
        if (cancelled) return;
        // Drop stale targets on failure so an outdated key can never be selected.
        setCurrentContainers({ scopeId, targets: [] });
        setCurrentContainersError(err instanceof Error ? err.message : "Current containers unavailable");
      })
      .finally(() => { if (!cancelled) setCurrentContainersLoading(false); });
    return () => { cancelled = true; };
  }, [vps.id, refreshTick]);

  // A selection must always resolve to a live current target: keys removed
  // from the list (refresh, error, or VPS switch) are cleared, not kept.
  useEffect(() => {
    if (selectedContainer && !currentContainersLoading && !currentTargets.some((item) => JSON.stringify([item.agentInstanceId, item.containerKey]) === selectedContainer)) {
      setSelectedContainer(null);
    }
  }, [currentTargets, currentContainersLoading, selectedContainer]);

  useEffect(() => {
    if (!monitoringEnabled || !selectedTarget) {
      setContainerHistory([]);
      setContainerHistoryError(null);
      setContainerHistoryLoading(false);
      return;
    }
    let cancelled = false;
    setContainerHistory([]);
    setContainerHistoryLoading(true); setContainerHistoryError(null);
    listVpsDockerContainerHistory(vps.id, { agentInstanceId: selectedTarget.agentInstanceId, containerKey: selectedTarget.containerKey, limit: 50 })
      .then((result) => { if (!cancelled) setContainerHistory(result.data); })
      .catch((err) => { if (!cancelled) setContainerHistoryError(err instanceof Error ? err.message : "Container history unavailable"); })
      .finally(() => { if (!cancelled) setContainerHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [vps.id, monitoringEnabled, selectedTarget, refreshTick]);

  useEffect(() => {
    const unsubscribe = subscribeMonitoring({
      onDockerEventsAvailable: (payload) => {
        if (!payload?.vpsId || payload.vpsId === vps.id) setRefreshTick((n) => n + 1);
      },
      onDockerAlertsUpdated: (payload) => {
        if (!payload?.vpsId || payload.vpsId === vps.id) setRefreshTick((n) => n + 1);
      },
    });
    return () => {
      unsubscribe();
    };
  }, [vps.id]);

  return (
    <section aria-labelledby="server-docker-heading" className="min-w-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="server-docker-heading" className="text-lg font-semibold text-text">Docker</h2>
      </div>
      <div role="group" aria-label="Docker view" className="mb-4 flex gap-2">
        <Button size="sm" variant={dockerView === "containers" ? "default" : "outline"} aria-pressed={dockerView === "containers"} onClick={() => setDockerView("containers")}>Containers</Button>
        <Button size="sm" variant={dockerView === "applications" ? "default" : "outline"} aria-pressed={dockerView === "applications"} onClick={() => setDockerView("applications")}>Applications</Button>
      </div>
      {dockerView === "applications" ? <ComposeApplicationsPanel key={vps.id} vpsId={vps.id} refreshTick={refreshTick} /> : <>
      <Button type="button" size="sm" variant="outline" className="mb-4" disabled={currentContainersLoading} onClick={() => setRefreshTick((tick) => tick + 1)}>Refresh containers</Button>
      <details className="mb-4 border border-line bg-panel">
        <summary className="cursor-pointer px-4 py-3 text-sm text-dim focus-visible:outline-signal">Snapshot & monitoring</summary>
      <DockerMetricsPanel
        vps={vps}
        dockerMetrics={snapshot}
        busy={dashboard.busy}
        onToggle={dashboard.onToggleDockerMetrics}
        presentation="detail"
        showContainers={false}
      />
      </details>
      <div className="mt-4 space-y-4">
            <DockerWorkloads dockerMetrics={overview.dockerMetrics} />
            <div className="grid min-w-0 gap-4 xl:grid-cols-[17rem_minmax(0,1fr)]">
            <section aria-label="Container history" className="min-w-0 self-start border border-line bg-panel">
              <h3 className="border-b border-line px-4 py-3 text-sm font-semibold">Containers <span className="tnum text-dim">{currentTargets.length}</span></h3>
              {currentTargets.length > 0 ? (
                <div className="max-h-80 overflow-y-auto xl:max-h-[40rem]">{currentTargets.map((target) => {
                  const identity = JSON.stringify([target.agentInstanceId, target.containerKey]);
                  return <button key={identity} type="button" aria-label={target.name ?? target.containerKey.slice(0, 12)} title={`${target.agentInstanceId} / ${target.containerKey}`} aria-pressed={selectedContainer === identity} className={`flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-signal ${selectedContainer === identity ? "bg-signal/10 text-signal" : "text-text hover:bg-raised"}`} onClick={() => setSelectedContainer(identity)}><span className="min-w-0 truncate">{target.name ?? target.containerKey.slice(0, 12)}</span><span data-container-state={target.state} className="docker-container-state shrink-0 text-[11px]">{target.state ?? "n/a"}</span></button>;
                })}</div>
              ) : currentContainersError ? (
                <p className="mt-2 text-[11px] text-crit">{currentContainersError}</p>
              ) : currentContainersLoading ? (
                <p className="mt-2 text-[11px] text-dim">Loading containers…</p>
              ) : (
                <p className="mt-2 text-[11px] text-dim">No containers reported for this server.</p>
              )}
            </section>
            <div className="min-w-0 space-y-4">
              {selectedTarget ? <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-text">{selectedTarget.name ?? selectedTarget.containerKey.slice(0, 12)}</h3>
                  <Link className="text-xs text-info underline-offset-4 hover:underline focus-visible:outline-signal" to={`/vps/${encodeURIComponent(vps.id)}/docker/containers/${encodeURIComponent(selectedTarget.agentInstanceId)}/${encodeURIComponent(selectedTarget.containerKey)}`}>Open container</Link>
                </div>
                {monitoringEnabled && snapshot?.agentInstanceId === selectedTarget.agentInstanceId ? snapshot.containers.filter((item) => item.containerKey === selectedTarget.containerKey).map((item) => <dl key={item.containerKey} className="grid grid-cols-2 gap-4 border-y border-line py-4 text-xs sm:grid-cols-4">
                  <div><dt className="text-dim">CPU · {snapshot.freshness === "fresh" ? "snapshot" : "saved snapshot"}</dt><dd className="tnum mt-1 text-text">{item.cpuPercent.toFixed(1)}%</dd></div>
                  <div><dt className="text-dim">Memory · PIDs</dt><dd className="tnum mt-1 text-text">{(item.memoryUsageBytes / 1048576).toFixed(1)} MiB · {item.pids}</dd></div>
                </dl>) : null}
                <DockerContainerInvestigationPanel key={`${vps.id}:${selectedTarget.agentInstanceId}:${selectedTarget.containerKey}`} vpsId={vps.id} container={selectedTarget} managementEnabled={managementEnabled} monitoringEnabled={monitoringEnabled} refreshTick={refreshTick} />
                {monitoringEnabled ? <details className="border border-line bg-panel"><summary className="cursor-pointer px-4 py-3 text-sm focus-visible:outline-signal">History</summary><DockerHistoryChart samples={containerHistory} retained={containerHistory.length} loading={containerHistoryLoading} error={containerHistoryError} /></details> : null}
              </> : <div className="flex min-h-48 items-center justify-center border border-dashed border-line p-6 text-sm text-dim">Select a container</div>}
            </div>
            </div>
            {monitoringEnabled ? <>
            <details className="border border-line bg-panel"><summary className="cursor-pointer px-4 py-3 text-sm text-dim focus-visible:outline-signal">Host history</summary>
            <DockerHistoryChart samples={history} rollups={rollups} retained={historyTotal} loading={loading} error={resourceErrors.history} />{resourcePages.history?.hasMore ? <button type="button" onClick={() => loadMore("history")} disabled={loadingMore === "history"} className="p-3 text-xs text-signal underline">{loadingMore === "history" ? "Loading…" : "Load more history"}</button> : null}{resourcePages.rollups?.hasMore ? <button type="button" onClick={() => loadMore("rollups")} disabled={loadingMore === "rollups"} className="p-3 text-xs text-signal underline">{loadingMore === "rollups" ? "Loading…" : "Load more rollups"}</button> : null}
            </details>
            <details className="border border-line bg-panel"><summary className="cursor-pointer px-4 py-3 text-sm text-dim focus-visible:outline-signal">Events, alerts & storage</summary><div className="space-y-4 p-3">
            <DockerEventTimeline events={events} retained={eventsTotal} loading={loading} error={resourceErrors.events} />{resourcePages.events?.hasMore ? <button type="button" onClick={() => loadMore("events")} disabled={loadingMore === "events"} className="text-xs text-signal underline">{loadingMore === "events" ? "Loading…" : "Load more events"}</button> : null}
            <DockerAlertsPanel alerts={alerts} retained={alertsTotal} loading={loading} error={resourceErrors.alerts} vpsId={vps.id} onAcknowledged={(updated) => setAlerts((current) => current.map((alert) => alert.id === updated.id ? updated : alert))} />{resourcePages.alerts?.hasMore ? <button type="button" onClick={() => loadMore("alerts")} disabled={loadingMore === "alerts"} className="text-xs text-signal underline">{loadingMore === "alerts" ? "Loading…" : "Load more alerts"}</button> : null}
            <DockerStorageOverview storage={storage} loading={loading} error={resourceErrors.storage} />
            </div></details>
          </>
        : null}
      </div>
      </>}
    </section>
  );
}

/**
 * Detail page for exactly one container, addressed by the full identity pair
 * from the route (`:agentInstanceId/:containerKey`).
 *
 * The identity is fixed here on purpose: this page never picks a target from
 * the inventory on the user's behalf. A route that names a container the
 * server no longer reports is rendered as unavailable — no log stream opens,
 * and no control ever fires against a different container.
 */
export function VpsWorkspaceDockerContainerPage() {
  const { vps, overview } = useVpsWorkspace();
  const { agentInstanceId, containerKey } = useParams<{
    agentInstanceId: string;
    containerKey: string;
  }>();
  return (
    <section aria-labelledby="server-docker-container-heading" className="min-w-0">
      <div className="mb-5 max-w-3xl">
        <Link
          to={`/vps/${encodeURIComponent(vps.id)}/docker`}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Back to containers
        </Link>
        <h2
          id="server-docker-container-heading"
          className="text-xl font-semibold tracking-tight text-text sm:text-2xl"
        >
          Container logs and controls
        </h2>
      </div>
      <div className="space-y-4">
        {agentInstanceId && containerKey ? <ContainerRouteInvestigation vpsId={vps.id} agentInstanceId={agentInstanceId} containerKey={containerKey} managementEnabled={vps.dockerManagementEnabled === true} monitoringEnabled={vps.dockerMetricsEnabled === true} /> : <p role="alert" className="text-sm text-crit">A complete container identity is required.</p>}
      </div>
      {!overview.dockerMetrics[0]?.available ? (
        <DockerCapabilityNotice
          enabled={vps.dockerMetricsEnabled === true}
          waiting={vps.dockerMetricsEnabled === true && !overview.dockerMetrics[0]}
        />
      ) : null}
    </section>
  );
}
function ContainerRouteInvestigation({ vpsId, agentInstanceId, containerKey, managementEnabled, monitoringEnabled }: { vpsId: string; agentInstanceId: string; containerKey: string; managementEnabled: boolean; monitoringEnabled: boolean }) {
  const [containers, setContainers] = useState<DockerCurrentContainer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setContainers(null); setError(null);
    listVpsDockerCurrentContainers(vpsId).then((items) => { if (!cancelled) setContainers(items); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Current containers unavailable"); });
    return () => { cancelled = true; };
  }, [vpsId, refreshTick]);
  const container = containers?.find((item) => item.agentInstanceId === agentInstanceId && item.containerKey === containerKey);
  if (error) return <div role="alert" className="space-y-2 text-sm text-crit"><p>Could not load the current container inventory: {error}</p><Button type="button" variant="outline" size="sm" onClick={() => setRefreshTick((tick) => tick + 1)}>Retry</Button></div>;
  if (!containers) return <p role="status" className="text-sm text-dim">Loading current container…</p>;
  if (!container) return <p role="status" className="text-sm text-dim">This container is not reported in the server's current inventory. No logs or controls attach to another container.</p>;
  return <div className="space-y-4"><div className="flex justify-end"><Button type="button" variant="outline" size="sm" onClick={() => setRefreshTick((tick) => tick + 1)}>Refresh container snapshot</Button></div><DockerContainerInvestigationPanel vpsId={vpsId} container={container} managementEnabled={managementEnabled} monitoringEnabled={monitoringEnabled} refreshTick={refreshTick} /></div>;
}

export function VpsWorkspaceMetricsPage() {
  const { vps, overview } = useVpsWorkspace();
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold tracking-tight text-text">
        Metrics for {vpsDisplayName(vps)}
      </h2>
      <MetricsPanel
        metrics={overview.metrics}
        scopedVpsId={vps.id}
      />
    </div>
  );
}

export function VpsWorkspaceJobsPage() {
  const { vps, overview } = useVpsWorkspace();
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold tracking-tight text-text">
        Jobs for {vpsDisplayName(vps)}
      </h2>
      <JobsPanel jobs={overview.jobs} />
    </div>
  );
}

export function VpsWorkspaceAuditPage() {
  const { vps, overview } = useVpsWorkspace();
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold tracking-tight text-text">
        Audit for {vpsDisplayName(vps)}
      </h2>
      <AuditPanel events={overview.auditEvents} />
    </div>
  );
}

export function VpsWorkspaceTerminalPage() {
  const { vps, overview } = useVpsWorkspace();
  const isLocal = vps.kind === "local" || vps.managedBy === "system";
  const enabled =
    overview.settings.webTerminalEnabled &&
    (isLocal || overview.settings.realSshEnabled);

  return (
    <TerminalPanel
      vps={vps}
      enabled={enabled}
      isLocal={isLocal}
      commandGuardEnabled={overview.settings.terminalCommandGuardEnabled}
    />
  );
}

export function VpsWorkspaceFilesPage() {
  const { vps } = useVpsWorkspace();
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold tracking-tight text-text">
        Files for {vpsDisplayName(vps)}
      </h2>
      <FilesPanel vps={vps} />
    </div>
  );
}
export function VpsWorkspaceAssistantPage() {
  const { vps } = useVpsWorkspace();
  return <AssistantPanel vps={vps} />;
}


export function VpsWorkspaceSettingsPage() {
  const { vps, overview } = useVpsWorkspace();
  const dashboard = useDashboard();
  const managementEnabled = vps.dockerManagementEnabled === true;
  const composeManagementEnabled = vps.composeManagementEnabled === true;
  const managementAllowed = vps.managedBy !== "system" || vps.kind === "local";
  const [managementBusy, setManagementBusy] = useState(false);
  const [managementError, setManagementError] = useState<string | null>(null);
  const managementLock = useRef(false);
  const [composeManagementBusy, setComposeManagementBusy] = useState(false);
  const [composeManagementError, setComposeManagementError] = useState<string | null>(null);
  const composeManagementLock = useRef(false);

  async function handleToggleManagement(): Promise<void> {
    if (managementLock.current || dashboard.busy || dashboard.mode === "demo" || !managementAllowed) return;
    managementLock.current = true;
    setManagementBusy(true);
    setManagementError(null);
    try {
      await dashboard.onEdit(vps, { dockerManagementEnabled: !managementEnabled });
    } catch (err) {
      setManagementError(err instanceof Error ? err.message : "Unable to update Docker management.");
    } finally {
      managementLock.current = false;
      setManagementBusy(false);
    }
  }

  async function handleToggleComposeManagement(): Promise<void> {
    if (composeManagementLock.current || dashboard.busy || dashboard.mode === "demo" || !managementAllowed) return;
    composeManagementLock.current = true;
    setComposeManagementBusy(true);
    setComposeManagementError(null);
    try {
      await dashboard.onEdit(vps, { composeManagementEnabled: !composeManagementEnabled });
    } catch (err) {
      setComposeManagementError(err instanceof Error ? err.message : "Unable to update Compose management.");
    } finally {
      composeManagementLock.current = false;
      setComposeManagementBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight text-text">
        Settings for {vpsDisplayName(vps)}
      </h2>
      <SettingsPanel overview={overview} vpsId={vps.id} />
      <SftpSettingsCard vps={vps} />
      <section aria-label="Docker management" className="mb-4 space-y-3 border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text">Docker management</h3>
          <Switch checked={managementEnabled} pending={managementBusy} aria-label={`${managementEnabled ? "Disable" : "Enable"} Docker management`} disabled={dashboard.busy || dashboard.mode === "demo" || !managementAllowed} onCheckedChange={() => void handleToggleManagement()} />
        </div>
        <p className="text-xs text-dim">Docker controls can interrupt services, including this dashboard on the local host. Agent access to Docker is root-equivalent.</p>
        {managementError ? <p role="alert" className="text-xs text-crit">{managementError}</p> : null}
      </section>
      <section aria-label="Compose management" className="mb-4 space-y-3 border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text">Compose management</h3>
          <Switch checked={composeManagementEnabled} pending={composeManagementBusy} aria-label={`${composeManagementEnabled ? "Disable" : "Enable"} Compose management`} disabled={dashboard.busy || dashboard.mode === "demo" || !managementAllowed} onCheckedChange={() => void handleToggleComposeManagement()} />
        </div>
        <p className="text-xs text-dim">Enabling Compose management is a separate consent from Docker management. Compose agent access is root-equivalent, and deployments can interrupt services.</p>
        {composeManagementError ? <p role="alert" className="text-xs text-crit">{composeManagementError}</p> : null}
      </section>
    </div>
  );
}
