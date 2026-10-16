import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Box, Search } from "lucide-react";
import { Button } from "../../ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import type { DashboardDockerContainerMetric, DashboardOverview, VpsRecord } from "../../../lib/api";
import { freshnessLabel, vpsDisplayName } from "../../../lib/dashboard-formatters";
import { formatBytes, formatDockerError } from "./helpers";

type Filter = "all" | "running" | "stopped" | "unhealthy";
type Sort = "name" | "cpu" | "memory" | "state";
type SnapshotState = "live" | "stale" | "unknown";

const rowBase = "grid min-w-0 grid-cols-[minmax(0,1fr)_4.25rem_4.75rem] items-center gap-2 border-t border-line px-2";
const headerBase = "grid grid-cols-[minmax(0,1fr)_4.25rem_4.75rem] gap-2 px-2 text-[11px] uppercase tracking-[0.14em] text-dim";
const pillBase = "inline-flex w-fit items-center border px-1.5 py-0.5 text-[11px] font-medium";
const controlBase = "h-8 border border-line bg-ink px-2 text-[12px] text-text focus:border-signal focus:outline-none";
const linkBase = "text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

export function dockerSnapshotState(metric?: DashboardOverview["dockerMetrics"][number], now = Date.now()): SnapshotState {
  if (metric?.freshness === "fresh") return "live";
  if (metric?.freshness === "stale") return "stale";
  if (!metric?.receivedAt) return "unknown";
  const receivedAt = Date.parse(metric.receivedAt);
  if (!Number.isFinite(receivedAt) || receivedAt > now) return "unknown";
  return now - receivedAt < 120_000 ? "live" : "stale";
}

function isUnhealthy(container: DashboardDockerContainerMetric) {
  return /unhealthy|health:\s*starting|restarting|dead/i.test(`${container.state} ${container.status ?? ""}`);
}
function isRunning(container: DashboardDockerContainerMetric) { return container.state.toLowerCase() === "running" && !isUnhealthy(container); }
function isStopped(container: DashboardDockerContainerMetric) { return !isRunning(container) && !isUnhealthy(container); }

function displayNames(containers: DashboardDockerContainerMetric[]) {
  const counts = new Map<string, number>();
  containers.forEach(({ name }) => { const match = name.match(/^([a-zA-Z0-9.-]+)_([^_]+)_\d+$/); if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1); });
  return new Map(containers.map((container) => { const match = container.name.match(/^([a-zA-Z0-9.-]+)_([^_]+)_\d+$/); return [container.containerKey, match && (counts.get(match[1]) ?? 0) > 1 ? match[2] : container.name]; }));
}

function ContainerRow({ container, name, stale, roomy = false, linkTo }: { container: DashboardDockerContainerMetric; name: string; stale: boolean; roomy?: boolean; linkTo?: string }) {
  const running = isRunning(container);
  const status = running ? "Running" : isUnhealthy(container) ? "Unhealthy" : "Stopped";
  const pillTone = running ? "border-signal/40 bg-signal/10 text-signal" : isUnhealthy(container) ? "border-crit/40 bg-crit/10 text-crit" : "border-warn/40 bg-warn/10 text-warn";
  const dotTone = running ? "bg-signal" : isUnhealthy(container) ? "bg-crit" : "bg-warn";
  const rowTone = running ? "" : isUnhealthy(container) ? "bg-crit/[0.04]" : "bg-warn/[0.04]";
  return (
    <li
      className={`${rowBase} transition-colors duration-160 ease-out hover:bg-raised/40 ${roomy ? "py-2.5 text-[13px] sm:grid-cols-[minmax(0,1fr)_6rem_4.5rem_5.5rem_3.5rem] sm:px-4" : "py-2 text-[11px]"} ${rowTone}`}
      title={`${container.name} · ${container.image} · ${container.status ?? container.state}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotTone}`} aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate font-medium text-text">
            {linkTo ? (
              <Link
                to={linkTo}
                className={linkBase}
                aria-label={`View details for container ${name}`}
              >
                {name}
              </Link>
            ) : (
              name
            )}
          </span>
          <span className="tnum block truncate text-[10px] text-dim" title={container.image}>{container.image}</span>
        </span>
      </span>
      {roomy ? <span className={`${pillBase} hidden sm:inline-flex ${pillTone}`}>{status}</span> : null}
      <span className="tnum text-right" aria-label={`CPU ${container.cpuPercent.toFixed(1)} percent${stale ? ", stale" : ""}`}>{container.cpuPercent.toFixed(1)}%</span>
      <span className="tnum truncate text-right" aria-label={`Memory ${formatBytes(container.memoryUsageBytes)}${stale ? ", stale" : ""}`}>{formatBytes(container.memoryUsageBytes)}</span>
      {roomy ? <span className="tnum hidden text-right text-dim sm:block">{container.pids}</span> : null}
    </li>
  );
}

function ListHeader({ roomy }: { roomy: boolean }) {
  return (
    <div className={`${headerBase} ${roomy ? "sm:grid-cols-[minmax(0,1fr)_6rem_4.5rem_5.5rem_3.5rem] sm:px-4" : ""}`}>
      <span>Container</span>
      {roomy ? <span className="hidden sm:block">Status</span> : null}
      <span className="text-right">CPU</span>
      <span className="text-right">Memory</span>
      {roomy ? <span className="hidden text-right sm:block">PIDs</span> : null}
    </div>
  );
}

function HealthSummary({ runningCount, stoppedCount, unhealthyCount }: { runningCount: number; stoppedCount: number; unhealthyCount: number }) {
  return (
    <div className="flex flex-wrap gap-2 text-[11px]" aria-label="Container health summary">
      <span className={`${pillBase} border-signal/40 bg-signal/10 text-signal`}>{runningCount} running</span>
      <span className={`${pillBase} border-line text-dim`}>{stoppedCount} stopped</span>
      {unhealthyCount > 0 ? <span className={`${pillBase} border-crit/40 bg-crit/10 text-crit`}>{unhealthyCount} unhealthy</span> : null}
    </div>
  );
}

export function DockerMetricsPanel({ vps, dockerMetrics, busy, onToggle, presentation = "compact", showContainers = true }: { vps: VpsRecord; dockerMetrics?: DashboardOverview["dockerMetrics"][number]; busy: boolean; onToggle: (vps: VpsRecord) => void; presentation?: "compact" | "detail"; /** Detail pages that own the container inventory pass false to keep one list. */ showContainers?: boolean }) {
  const enabled = vps.dockerMetricsEnabled === true;
  const detail = presentation === "detail";
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("state");
  const containers = dockerMetrics?.containers ?? [];
  const snapshotState = dockerSnapshotState(dockerMetrics);
  const notLive = snapshotState !== "live";
  const names = displayNames(containers);
  const filtered = useMemo(() => containers.filter((container) => {
    const matchesQuery = `${container.name} ${container.image}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (filter === "all" || (filter === "running" && isRunning(container)) || (filter === "stopped" && isStopped(container)) || (filter === "unhealthy" && isUnhealthy(container)));
  }).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "cpu" ? b.cpuPercent - a.cpuPercent : sort === "memory" ? b.memoryUsageBytes - a.memoryUsageBytes : Number(isRunning(a)) - Number(isRunning(b)) || a.state.localeCompare(b.state)), [containers, query, filter, sort]);
  const detailLimit = expanded ? 20 : detail ? 8 : 3;
  const visible = filtered.slice(0, detailLimit);
  const runningCount = containers.filter(isRunning).length;
  const unhealthyCount = containers.filter(isUnhealthy).length;
  const stoppedCount = containers.filter(isStopped).length;
  const updatedAt = dockerMetrics?.lastUpdatedAt ?? dockerMetrics?.receivedAt ?? dockerMetrics?.collectedAt;
  const total = Math.max(dockerMetrics?.containerTotal ?? containers.length, containers.length);
  const retainedDetails = total > containers.length;

  // Detail links carry the full identity pair (instance + key), because the
  // container key alone is not a valid stream/action identity. Both segments
  // are URI-encoded: opaque ids may legitimately contain characters that must
  // not terminate the path segment.
  const agentInstanceId = dockerMetrics?.agentInstanceId;
  const containerDetailBase =
    typeof agentInstanceId === "string" && agentInstanceId.length > 0
      ? `/vps/${encodeURIComponent(vps.id)}/docker/containers/${encodeURIComponent(agentInstanceId)}`
      : null;

  let body: ReactNode;
  if (!enabled) body = <div className="border border-line bg-raised p-3"><p className="text-[13px] font-medium text-text">Docker monitoring is off.</p><p className="mt-1 text-[11px] text-dim">Enable it to see container health and resource usage.</p></div>;
  else if (!dockerMetrics) body = <div className="space-y-1" role="status"><div className="flex items-center gap-2 text-[12px] text-dim"><span className="h-2 w-2 rounded-full bg-info" aria-hidden="true" />Waiting for Docker-capable agent.</div><p className="pl-4 text-[11px] text-dim">The first snapshot will appear here automatically.</p></div>;
  else if (!dockerMetrics.available) body = <div className="border border-crit/30 bg-crit/5 p-3" role="status"><p className="text-[13px] font-medium text-crit">Docker unavailable</p><p className="mt-1 text-[11px] leading-relaxed text-dim">{formatDockerError(dockerMetrics.errorCode)}</p>{updatedAt ? <p className="mt-2 text-[11px] text-dim">Last checked {freshnessLabel(updatedAt)}</p> : null}</div>;
  else if (!detail) body = <div className="space-y-2.5">
    <HealthSummary runningCount={runningCount} stoppedCount={stoppedCount} unhealthyCount={unhealthyCount} />
    {containers.length ? <><ListHeader roomy={false} /><ul>{containers.slice(0, 3).map((container) => <ContainerRow key={container.containerKey} container={container} name={names.get(container.containerKey) ?? container.name} stale={notLive} linkTo={containerDetailBase ? `${containerDetailBase}/${encodeURIComponent(container.containerKey)}` : undefined} />)}</ul></> : <p className="text-[12px] text-dim">No containers reported.</p>}
    <Link to={`/vps/${encodeURIComponent(vps.id)}/docker`} className={`inline-flex min-h-8 items-center text-[11px] font-medium ${linkBase}`} aria-label={`View Docker details for ${vpsDisplayName(vps)}`}>View Docker details →</Link>
  </div>;
  else body = <div className="space-y-2.5">
    <HealthSummary runningCount={runningCount} stoppedCount={stoppedCount} unhealthyCount={unhealthyCount} />
    {!showContainers ? null : containers.length ? <><div className="flex flex-wrap items-center gap-1.5 border-b border-line pb-3 sm:gap-2">
      <div className="relative min-w-52 flex-1">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" aria-hidden="true" />
        <label className="sr-only" htmlFor={`docker-search-${vps.id}`}>Search containers by name or image</label>
        <input id={`docker-search-${vps.id}`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or image…" className="h-8 w-full border border-line bg-ink pl-9 pr-3 text-[13px] text-text placeholder:text-dim focus:border-signal focus:outline-none" />
      </div>
      <label className="sr-only" htmlFor={`docker-filter-${vps.id}`}>Filter containers</label>
      <select id={`docker-filter-${vps.id}`} value={filter} onChange={(event) => setFilter(event.target.value as Filter)} className={controlBase}><option value="all">All</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="unhealthy">Unhealthy</option></select>
      <label className="sr-only" htmlFor={`docker-sort-${vps.id}`}>Sort containers</label>
      <select id={`docker-sort-${vps.id}`} value={sort} onChange={(event) => setSort(event.target.value as Sort)} className={controlBase}><option value="state">Sort: state</option><option value="name">Sort: name</option><option value="cpu">Sort: CPU</option><option value="memory">Sort: memory</option></select>
    </div><div className="space-y-0.5 text-[12px] text-dim"><div className="flex items-center justify-between gap-2"><span aria-live="polite">Showing {visible.length} detail rows of {total} reported containers</span>{filtered.length !== containers.length ? <span>{filtered.length} matches in details</span> : null}</div>{retainedDetails ? <p>Search and filters cover {containers.length} retained detail rows; {total - containers.length} reported containers have no detail row.</p> : null}</div>
    {visible.length ? <><ListHeader roomy /><ul>{visible.map((container) => <ContainerRow key={container.containerKey} container={container} name={names.get(container.containerKey) ?? container.name} stale={notLive} roomy={detail} linkTo={containerDetailBase ? `${containerDetailBase}/${encodeURIComponent(container.containerKey)}` : undefined} />)}</ul></> : <p className="py-3 text-center text-[12px] text-dim">No containers match this view.</p>}
    {filtered.length > detailLimit || expanded ? <button type="button" className={`text-[12px] font-medium ${linkBase}`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less ↑" : `Show more (max 20) →`}</button> : null}</> : <p className="text-[12px] text-dim">No containers reported.</p>}
  </div>;

  const snapshotStrip = detail && enabled && dockerMetrics?.available ? (
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-2 border px-4 py-3 text-[13px] ${notLive ? "border-warn/30 bg-warn/5" : "border-signal/30 bg-signal/5"}`} role="status">
      <span className={`flex items-center gap-2 font-medium ${notLive ? "text-warn" : "text-signal"}`}>
        {snapshotState === "live" ? <i className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
        {snapshotState === "live" ? "Live snapshot" : snapshotState === "stale" ? "Saved snapshot · not live" : "Saved snapshot · freshness unknown · not live"}
      </span>
      <span className="text-dim">{updatedAt ? `Updated ${freshnessLabel(updatedAt)}` : "Update time unavailable"}{dockerMetrics.ageSeconds != null ? ` · ${dockerMetrics.ageSeconds}s old` : ""}</span>
      <span className="tnum text-dim">{formatBytes(dockerMetrics.memoryUsageBytes)} RAM in use</span>
      {(dockerMetrics.engineVersion || dockerMetrics.apiVersion) ? <span className="tnum ml-auto text-dim">Engine {dockerMetrics.engineVersion ?? "—"}{dockerMetrics.apiVersion ? ` · API ${dockerMetrics.apiVersion}` : ""}</span> : null}
    </div>
  ) : null;

  return (
    <>
      {snapshotStrip}
      <section className={detail ? "border border-line bg-panel" : "border border-line bg-ink/40 p-3"}>
        {detail ? (
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <span className="block text-[14px] font-semibold">Container snapshot</span>
            </div>
            <Button type="button" size="sm" variant={enabled ? "secondary" : "outline"} className={`${detail ? "min-w-20" : "h-7 px-2 text-[11px]"} rounded-none`} disabled={busy} aria-pressed={enabled} aria-label={`${enabled ? "Disable" : "Enable"} Docker metrics for ${vpsDisplayName(vps)}`} onClick={() => enabled ? onToggle(vps) : setDialogOpen(true)}>{busy ? "Updating…" : enabled ? "On" : "Off"}</Button>
          </header>
        ) : (
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-[12px] text-dim"><Box size={14} aria-hidden="true" />Docker</span>
            <Button type="button" size="sm" variant={enabled ? "secondary" : "outline"} className="h-7 px-2 text-[11px] rounded-none" disabled={busy} aria-pressed={enabled} aria-label={`${enabled ? "Disable" : "Enable"} Docker metrics for ${vpsDisplayName(vps)}`} onClick={() => enabled ? onToggle(vps) : setDialogOpen(true)}>{busy ? "Updating…" : enabled ? "On" : "Off"}</Button>
          </div>
        )}
        <div className={detail ? "space-y-2.5 p-4" : ""}>{body}</div>
      </section>
      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Enable Docker monitoring?</AlertDialogTitle><AlertDialogDescription>The agent will collect container names, images, status, and resource usage. Docker must be available to the agent. Environment variables, logs, mounts, labels, and commands are not collected.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { onToggle(vps); setDialogOpen(false); }}>Enable Docker monitoring</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </>
  );
}
