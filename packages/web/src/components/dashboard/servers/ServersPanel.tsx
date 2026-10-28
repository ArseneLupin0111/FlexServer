import { useState } from "react";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { EmptyState } from "../shared/EmptyState";
import { ServerCard } from "./ServerCard";
import { ServerTable } from "./ServerTable";
import { ServerOpsSummary } from "./ServerOpsSummary";
import type { ServersPanelProps, ViewMode } from "./types";
import type { VpsRecord } from "../../../lib/api";
import { EditServerDialog } from "./EditServerDialog";

export { type ServersPanelProps, type ViewMode };

export function ServersPanel(props: ServersPanelProps) {
  const [editTarget, setEditTarget] = useState<VpsRecord | null>(null);
  const metricById = new Map(
    props.metrics.map((metric) => [metric.vpsId, metric]),
  );
  const systemInfoById = new Map(
    (props.systemInfo ?? []).map((info) => [info.vpsId, info]),
  );
  return (
    <div className="grid min-w-0 gap-6">
      {/* Fleet heading */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight">Servers</h1>
          <p className="mt-1 text-dim">
            Manage SSH access, health checks and provisioning for the whole fleet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild className="h-8 shrink-0">
            <Link to="/vps/new">
              <Plus size={15} />
              <span>New VPS</span>
            </Link>
          </Button>
        </div>
      </div>

      {/* Fleet stat strip (above search, left-tone accents, clickable) */}
      <ServerOpsSummary
        records={props.records}
        metrics={props.metrics}
        dockerMetrics={props.dockerMetrics}
        onSelect={props.onStatusFilterChange}
      />

      {/* Search / status filter / view toggle */}
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-60 flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim"
          />
          <Input
            aria-label="Search servers"
            placeholder="Search name, host, provider, city, country, tag..."
            className="h-9 bg-panel pl-9"
            value={props.serverSearch}
            onChange={(event) => props.onSearchChange(event.target.value)}
          />
        </label>
        <select
          aria-label="Filter status"
          className="h-9 min-w-0 rounded-none border border-line bg-panel px-3 text-[13px] text-text outline-none transition focus:border-signal focus:outline-none"
          value={props.statusFilter}
          onChange={(event) => props.onStatusFilterChange(event.target.value)}
        >
          <option value="all">All states</option>
          <option value="healthy">Healthy</option>
          <option value="warning">Warning</option>
          <option value="unreachable">Unreachable</option>
          <option value="unknown">Unknown</option>
          <option value="ready">Key ready</option>
          <option value="pending">Needs password</option>
        </select>
        <div
          role="group"
          aria-label="View style"
          className="flex shrink-0 border border-line"
        >
          <button
            type="button"
            aria-label="Card view"
            aria-pressed={props.viewMode === "card"}
            className={`grid h-9 w-9 place-items-center transition-colors ${
              props.viewMode === "card"
                ? "bg-raised text-signal"
                : "text-dim hover:text-text"
            }`}
            onClick={() => props.onViewModeChange("card")}
          >
            <LayoutGrid size={15} />
          </button>
          <button
            type="button"
            aria-label="Table view"
            aria-pressed={props.viewMode === "table"}
            className={`grid h-9 w-9 place-items-center transition-colors ${
              props.viewMode === "table"
                ? "bg-raised text-signal"
                : "text-dim hover:text-text"
            }`}
            onClick={() => props.onViewModeChange("table")}
          >
            <List size={15} />
          </button>
        </div>
      </div>

      {props.statusMessage}

      {props.records.length === 0 ? (
        <EmptyState>
          <p>No VPS servers yet. Add your first server to get started.</p>
          <Button asChild variant="outline" className="mt-3">
            <Link to="/vps/new">
              <Plus size={16} />
              New VPS
            </Link>
          </Button>
        </EmptyState>
      ) : props.visibleRecords.length === 0 ? (
        <EmptyState>No servers match this filter.</EmptyState>
      ) : props.viewMode === "table" ? (
        <ServerTable
          vpsList={props.visibleRecords}
          busy={props.busy}
          provisionPasswords={props.provisionPasswords}
          onProvision={props.onProvision}
          onVerify={props.onVerify}
          onInstallAgent={props.onInstallAgent}
          onUninstallAgent={props.onUninstallAgent}
          onRestartAgent={props.onRestartAgent}
          onRotateAgent={props.onRotateAgent}
          jobs={props.jobs}
          onDelete={props.onDelete}
          mode={props.mode}
          onEdit={setEditTarget}
        />
      ) : (
        <div className="grid min-w-0 grid-cols-2 gap-4 max-[1000px]:grid-cols-1">
          {props.visibleRecords.map((vps) => (
            <ServerCard
              key={vps.id}
              vps={vps}
              metric={metricById.get(vps.id)}
              systemInfo={systemInfoById.get(vps.id)}
              jobs={props.jobs.filter((job) => job.vpsId === vps.id)}
            />
          ))}
        </div>
      )}

      <EditServerDialog
        vps={editTarget}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        onSave={props.onEdit}
      />
    </div>
  );
}
