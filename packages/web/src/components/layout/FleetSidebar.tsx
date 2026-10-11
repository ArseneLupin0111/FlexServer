import { Link } from "react-router-dom";
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
  const metricById = new Map(metrics.map((metric) => [metric.vpsId, metric]));
  const onlineCount = hosts.filter((host) => host.status === "healthy").length;

  return (
    <aside
      aria-label="Fleet hosts"
      className={cn(
        "flex min-w-0 shrink-0 flex-col border-b border-line bg-[hsl(var(--fleet-sidebar-background))] lg:sticky lg:top-0 lg:h-screen lg:w-[var(--fleet-sidebar-width)] lg:border-b-0 lg:border-r",
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

      <nav
        aria-label="Hosts"
        className="flex min-h-0 flex-1 overflow-x-auto lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto"
      >
        {hosts.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-dim">
            No servers registered yet.
          </p>
        ) : (
          hosts.map((host) => {
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

      <Link
        to="/vps/new"
        className="hidden shrink-0 border-t border-line p-3 text-left text-[12px] text-dim transition-colors hover:text-signal focus-visible:outline-2 focus-visible:outline-signal lg:block"
      >
        + Add new VPS
      </Link>
    </aside>
  );
}
