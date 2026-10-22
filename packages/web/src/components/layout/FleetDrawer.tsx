import { useState } from "react";
import { Link } from "react-router-dom";
import { Search, Server, Plus, Layers } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";
import { BrandMark } from "../Brand";
import { FleetHostItem } from "./FleetHostItem";
import { vpsDisplayName } from "../../lib/dashboard-formatters";
import type { DashboardOverview, VpsRecord } from "../../lib/api";

export type FleetDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hosts: VpsRecord[];
  metrics: DashboardOverview["metrics"];
  selectedHostId?: string;
};

export function FleetDrawer({
  open,
  onOpenChange,
  hosts,
  metrics,
  selectedHostId,
}: FleetDrawerProps) {
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="flex w-80 max-w-[85vw] flex-col border-r border-line bg-panel p-0 text-text"
      >
        <SheetHeader className="border-b border-line p-4 text-left">
          <SheetTitle className="flex items-center gap-2">
            <Link
              to="/vps"
              onClick={() => onOpenChange(false)}
              className="flex items-center gap-2 text-text focus-visible:outline-2 focus-visible:outline-signal"
            >
              <BrandMark />
              <span className="text-lg font-bold tracking-tight">FlexServer</span>
            </Link>
          </SheetTitle>
          <div className="tnum mt-1 flex items-center justify-between text-[11px] text-dim">
            <span>{onlineCount}/{hosts.length} HOSTS ONLINE</span>
            <span className="flex items-center gap-1">
              <Server size={12} aria-hidden="true" />
              <span>Fleet drawer</span>
            </span>
          </div>
        </SheetHeader>

        {hosts.length > 3 ? (
          <div className="border-b border-line p-2">
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
                aria-hidden="true"
              />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter hosts…"
                aria-label="Filter fleet hosts"
                className="h-8 w-full border border-line bg-ink pl-8 pr-3 text-xs text-text placeholder:text-dim/60 focus:border-signal focus:outline-none"
              />
            </div>
          </div>
        ) : null}

        <nav
          aria-label="Mobile fleet hosts"
          className="flex-1 overflow-y-auto"
        >
          {filteredHosts.length === 0 ? (
            <p className="p-4 text-xs text-dim">
              {hosts.length === 0 ? "No servers registered yet." : "No matching hosts found."}
            </p>
          ) : (
            filteredHosts.map((host) => {
              const metric = metricById.get(host.id);
              return (
                <div key={host.id} onClick={() => onOpenChange(false)}>
                  <FleetHostItem
                    id={host.id}
                    to={`/vps/${encodeURIComponent(host.id)}`}
                    name={vpsDisplayName(host)}
                    endpoint={host.host}
                    status={host.status}
                    cpu={metric?.cpu}
                    memory={metric?.memory}
                    selected={host.id === selectedHostId}
                  />
                </div>
              );
            })
          )}
        </nav>

        <div className="shrink-0 border-t border-line p-3">
          <Link
            to="/vps/updates"
            onClick={() => onOpenChange(false)}
            className="flex items-center justify-center gap-1.5 border border-line bg-raised/50 py-2 text-xs font-medium text-dim transition-colors duration-160 ease-out hover:border-signal/50 hover:bg-raised hover:text-signal focus-visible:outline-2 focus-visible:outline-signal"
          >
            <Layers size={14} aria-hidden="true" />
            Fleet updates
          </Link>
        </div>
        <div className="shrink-0 border-t border-line p-3">
          <Link
            to="/vps/new"
            onClick={() => onOpenChange(false)}
            className="flex items-center justify-center gap-1.5 border border-line bg-raised/50 py-2 text-xs font-medium text-dim transition-colors duration-160 ease-out hover:border-signal/50 hover:bg-raised hover:text-signal focus-visible:outline-2 focus-visible:outline-signal"
          >
            <Plus size={14} aria-hidden="true" />
            + Add new VPS
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
