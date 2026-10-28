import { Link } from "react-router-dom";
import { AlertTriangle, Server } from "lucide-react";
import { Button } from "../../ui/button";
import {
  formatDate,
  freshnessLabel,
  serverStatusLabel,
  vpsDisplayName,
} from "../../../lib/dashboard-formatters";
import type { DashboardOverview, VpsRecord } from "../../../lib/api";
import { AgentLifecycleStatus } from "./AgentLifecycleStatus";

export function ServerCard({ vps, metric, systemInfo, jobs }: {
  vps: VpsRecord;
  metric?: DashboardOverview["metrics"][number];
  systemInfo?: DashboardOverview["systemInfo"][number];
  jobs: DashboardOverview["jobs"];
}) {
  const isLocalHost = vps.kind === "local" || vps.managedBy === "system";
  const isReady = isLocalHost || Boolean(vps.keyProvisionedAt);
  const isDown = vps.status === "unreachable";
  const displayName = vpsDisplayName(vps);
  const osLabel =
    systemInfo?.os?.prettyName ||
    systemInfo?.os?.name ||
    systemInfo?.os?.family ||
    "OS not reported";
  const isLinux = /\b(linux|ubuntu|debian|rhel|red hat|centos|fedora|rocky|alma ?linux|alpine|arch|manjaro|opensuse|suse|amazon linux|oracle linux)\b/i.test(
    `${systemInfo?.os?.family ?? ""} ${systemInfo?.os?.name ?? ""} ${systemInfo?.os?.prettyName ?? ""}`,
  );

  return (
    <article
      aria-label={`Server ${displayName}`}
      className={`min-w-0 overflow-hidden border bg-panel transition-colors duration-160 ease-out hover:bg-raised/10 ${isDown ? "border-crit/40" : "border-line hover:border-dim/60"}`}
    >
      <div className="grid min-w-0 gap-5 p-5">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h3 className="flex min-w-0 items-center gap-2 text-lg font-semibold leading-tight tracking-[-0.02em] text-text">
              {isLinux ? (
                <svg viewBox="0 0 24 24" width="22" height="22" className="shrink-0" role="img" aria-label="Linux">
                  <path fill="currentColor" d="M12 2c-3 0-4 2.5-4 5.5v2L5 16c-.8 2 .6 4 3 4h8c2.4 0 3.8-2 3-4l-3-6.5v-2C16 4.5 15 2 12 2Z" />
                  <ellipse cx="12" cy="14.5" rx="4" ry="5" fill="#f4f4f5" />
                  <ellipse cx="10.5" cy="7" rx="1.2" ry="1.7" fill="#f4f4f5" />
                  <ellipse cx="13.5" cy="7" rx="1.2" ry="1.7" fill="#f4f4f5" />
                  <circle cx="10.7" cy="7.2" r=".55" fill="#18181b" />
                  <circle cx="13.3" cy="7.2" r=".55" fill="#18181b" />
                  <path fill="#fbbf24" d="m9 9 3-1 3 1-3 2Zm-2 9 4 2-1 2H4Zm10 0-4 2 1 2h6Z" />
                </svg>
              ) : null}
              <span className="min-w-0 break-words">{displayName}</span>
            </h3>
            <ServerHealthStatus status={vps.status} />
          </div>
          <p className="mt-2 break-words text-sm text-dim" title={osLabel}>{osLabel}</p>
        </div>

        <div className="grid min-w-0 gap-3">
          <TelemetryMeter label="CPU" value={metric?.cpu} />
          <TelemetryMeter label="RAM" value={metric?.memory} />
          <TelemetryMeter label="Disk" value={metric?.disk} />
          <div className="flex items-baseline justify-between gap-3 text-[12px]">
            <span className="text-dim">Load</span>
            <span className="tnum text-dim">{metric ? metric.loadAverage : "n/a"}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 border-t border-line pt-4 xl:flex-row xl:items-center xl:justify-between">
          <Button asChild type="button" size="sm" variant="default">
            <Link to={`/vps/${encodeURIComponent(vps.id)}`} aria-label={`Manage ${displayName}`}>
              <Server size={16} />
              <span>Manage</span>
            </Link>
          </Button>
          <div className="flex min-w-0 flex-col gap-1 text-xs xl:order-first">
            <div className="flex flex-wrap items-center gap-2">
              <AgentLifecycleStatus vps={vps} jobs={jobs} compact />
              <span aria-hidden="true" className="text-dim">·</span>
              <span className={isReady ? "text-signal" : "text-warn"}>{isLocalHost ? "Local" : isReady ? "Key ready" : "Needs password"}</span>
            </div>
          </div>
        </div>
      </div>
      {isDown ? (
        <div className="flex items-center gap-2 border-t border-crit/30 bg-crit/5 px-5 py-2 text-[12px] text-crit">
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="min-w-0">No heartbeat since {formatDate(vps.lastSeenAt)} ({freshnessLabel(metric?.collectedAt ?? vps.lastSeenAt)}). Check power, firewall and SSH key.</span>
        </div>
      ) : null}
    </article>
  );
}

function ServerHealthStatus({ status }: { status?: VpsRecord["status"] }) {
  const isDown = status === "unreachable";
  const label = serverStatusLabel(status);
  const tone =
    status === "healthy"
      ? "border-signal/40 bg-signal/10 text-signal"
      : status === "warning"
        ? "border-warn/40 bg-warn/10 text-warn"
        : isDown
          ? "border-crit/40 bg-crit/10 text-crit"
          : "border-line bg-raised text-dim";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-0.5 text-[11px] font-medium ${tone}`}
      aria-label={`Host status: ${label}`}
      title={`Host status: ${label}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

function TelemetryMeter({ label, value }: { label: string; value?: number }) {
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const normalizedValue = hasValue ? Math.min(100, Math.max(0, value)) : 0;
  const meterTone = !hasValue
    ? "text-dim"
    : value >= 85
      ? "text-crit"
      : value >= 70
        ? "text-warn"
        : "text-signal";
  const meterColor = !hasValue
    ? "bg-line"
    : value >= 85
      ? "bg-crit"
      : value >= 70
        ? "bg-warn"
        : "bg-signal";

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-dim">{label}</span>
        <span className={`tnum ${meterTone}`}>{hasValue ? `${value.toFixed(1)}%` : "n/a"}</span>
      </div>
      {hasValue ? (
        <div role="progressbar" aria-label={`${label} utilization`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={normalizedValue} className="mt-1.5 h-1 w-full overflow-hidden bg-line">
          <div className={`h-full ${meterColor} transition-all duration-500`} style={{ width: `${normalizedValue}%` }} />
        </div>
      ) : (
        <div className="mt-1.5 h-1 w-full bg-line" aria-hidden="true" />
      )}
    </div>
  );
}
