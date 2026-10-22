import { useState } from "react";
import { Link } from "react-router-dom";
import { Search, Plus, Layers } from "lucide-react";
import { cn } from "../../lib/utils";
import { vpsDisplayName } from "../../lib/dashboard-formatters";
import type { DashboardOverview, VpsRecord } from "../../lib/api";
import { FleetHostItem } from "./FleetHostItem";
import { BrandMark } from "../Brand";

export type FleetSidebarProps = {
  hosts: VpsRecord[];
  metrics: DashboardOverview["metrics"];
  selectedHostId?: string;
  /** Extra class for layout positioning (width/stickiness). */
  className?: string;
};

/**
 * Reference host rail: brand + fleet counter, host list with live metrics,
 * and a create-VPS action. Collapses to a horizontal rail below `lg`.
 */
export function FleetSidebar({
  hosts,
  metrics,
  selectedHostId,
  className,
}: FleetSidebarProps) {
  const [filter, setFilter] = useState("");
  const metricById = new Map(metrics.map((metric) => [metric.vpsId, metric]));
  const onlineCount = hosts.filter((host) => host.status === "healthy").length;

  const filteredHosts = hosts.filter((host) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase().trim();
    return (
      host.name.toLowerCase().includes(q) ||
      (host.displayName && host.displayName.toLowerCase().includes(q)) ||
      host.host.toLowerCase().includes(q) ||
      (host.tags && host.tags.some((t) => t.toLowerCase().includes(q)))
    );
  });
  return (
    <aside
      aria-label="Fleet hosts"
      className={cn(
        "hidden min-w-0 shrink-0 flex-col border-b border-line bg-[hsl(var(--fleet-sidebar-background))] lg:flex lg:sticky lg:top-0 lg:h-screen lg:w-[var(--fleet-sidebar-width)] lg:border-b-0 lg:border-r",
        className,
      )}
    >
      <div className="border-b border-line p-4">
        <Link to="/vps" aria-label="FlexServer — go to servers" className="flex items-center gap-2 text-text focus-visible:outline-2 focus-visible:outline-signal">
          <BrandMark />
          <span className="text-lg font-bold tracking-tight">FlexServer</span>
        </Link>
        <div className="tnum mt-1 text-[11px] text-dim">
          {onlineCount}/{hosts.length} HOSTS ONLINE
        </div>
      </div>
      {hosts.length > 3 ? (
        <div className="hidden border-b border-line p-2 lg:block">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
              aria-hidden="true"
            />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter hosts…"
              aria-label="Filter sidebar hosts"
              className="h-7 w-full border border-line bg-ink pl-8 pr-2 text-xs text-text placeholder:text-dim/60 focus:border-signal focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      <nav
        aria-label="Hosts"
        className="flex min-h-0 flex-1 overflow-x-auto lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto"
      >
        {filteredHosts.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-dim">
            {hosts.length === 0 ? "No servers registered yet." : "No matching hosts found."}
          </p>
        ) : (
          filteredHosts.map((host) => {
            const metric = metricById.get(host.id);
            return (
              <FleetHostItem
                key={host.id}
                id={host.id}
                to={`/vps/${encodeURIComponent(host.id)}`}
                name={vpsDisplayName(host)}
                endpoint={host.host}
                status={host.status}
                cpu={metric?.cpu}
                memory={metric?.memory}
                selected={host.id === selectedHostId}
              />
            );
          })
        )}
      </nav>

      <div className="hidden shrink-0 border-t border-line p-2.5 lg:block">
        <Link
          to="/vps/updates"
          className="flex items-center justify-center gap-1.5 border border-line bg-raised/30 py-2 text-center text-xs font-medium text-dim transition-colors duration-160 ease-out hover:border-signal/50 hover:bg-raised hover:text-signal focus-visible:outline-2 focus-visible:outline-signal"
        >
          <Layers size={13} aria-hidden="true" />
          Fleet updates
        </Link>
      </div>
      <div className="hidden shrink-0 border-t border-line p-2.5 lg:block">
        <Link
          to="/vps/new"
          className="flex items-center justify-center gap-1.5 border border-line bg-raised/30 py-2 text-center text-xs font-medium text-dim transition-colors duration-160 ease-out hover:border-signal/50 hover:bg-raised hover:text-signal focus-visible:outline-2 focus-visible:outline-signal"
        >
          <Plus size={13} aria-hidden="true" />
          + Add new VPS
        </Link>
      </div>
    </aside>
  );
}
