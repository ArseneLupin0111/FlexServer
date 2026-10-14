import { Link } from "react-router-dom";
import { Alert } from "../../ui/alert";
import type { DashboardOverview } from "../../../lib/api";
import { formatBytes } from "../servers/helpers";
import { formatDate, vpsHostId } from "../../../lib/dashboard-formatters";
import { formatUptime } from "../shared/formatUptime";
import { AuditPanel } from "../audit/AuditPanel";
import { JobsPanel } from "../jobs/JobsPanel";
import { SystemFacts } from "../shared/SystemFacts";
import { ChartPanel } from "../metrics/MetricsPanel";
import {
  cpuMemorySeries,
  networkSeries,
} from "../metrics/historySeries";

export function DemoBanner({ overview }: { overview: DashboardOverview }) {
  if (!overview.banner) return null;
  return (
    <Alert variant="success" className="mb-0 border-line bg-panel text-text">
      {overview.banner}
    </Alert>
  );
}

type KpiTone = "ok" | "warn" | "crit" | "idle";

function Kpi({
  label,
  value,
  sub,
  tone = "ok",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: KpiTone;
}) {
  const valueTone =
    tone === "crit"
      ? "text-crit"
      : tone === "warn"
        ? "text-warn"
        : tone === "idle"
          ? "text-dim"
          : "text-text";
  const dotClass =
    tone === "crit"
      ? "bg-crit"
      : tone === "warn"
        ? "bg-warn"
        : tone === "idle"
          ? "bg-line"
          : "bg-signal";
  return (
    <div className="min-w-0 border border-line bg-panel px-4 py-3 transition-colors duration-160 ease-out hover:bg-raised/40">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">
          {label}
        </p>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
      </div>
      <p
        className={`tnum mt-1 truncate text-xl font-bold tracking-tight ${valueTone}`}
        title={value}
      >
        {value}
      </p>
      <p className="mt-1 truncate text-[12px] leading-5 text-dim" title={sub}>
        {sub}
      </p>
    </div>
  );
}

export function OverviewPanel({ overview }: { overview: DashboardOverview }) {
  const server = overview.servers[0];
  const metric = overview.metrics[0];
  const sysInfo = overview.systemInfo[0];
  const docker = overview.dockerMetrics[0];

  // `overview.metrics` is already scoped to this VPS by the workspace
  // context; the charts render this same host's own `history` window.
  const cpuMemory = cpuMemorySeries(metric);
  const netSeries = networkSeries(metric);

  const containersValue = docker?.available
    ? `${docker.containerRunning}/${docker.containerTotal}`
    : "n/a";
  const containersTone: KpiTone = docker?.available ? "ok" : "idle";
  const notRunning = docker?.available
    ? Math.max(0, docker.containerTotal - docker.containerRunning)
    : 0;
  const failedJobs = overview.jobs.filter((job) => job.status === "failed").length;
  const runningJobs = overview.jobs.filter((job) => job.status === "running").length;

  const sysCells = [
    {
      label: "OS",
      value:
        sysInfo?.os?.prettyName ||
        sysInfo?.os?.name ||
        sysInfo?.os?.family ||
        "n/a",
    },
    {
      label: "Kernel",
      value:
        [sysInfo?.kernel?.release, sysInfo?.kernel?.arch]
          .filter(Boolean)
          .join(" ") || "n/a",
    },
    ...(server ? [
      { label: "Server ID", value: server.id },
      { label: "Host ID", value: vpsHostId(server) || "Not reported" },
      { label: "CPU cores", value: sysInfo?.cpu?.cores ? String(sysInfo.cpu.cores) : "Not reported" },
      { label: "CPU model", value: sysInfo?.cpu?.model || "Not reported" },
      { label: "RAM capacity", value: sysInfo?.memory?.totalBytes ? formatBytes(sysInfo.memory.totalBytes) : "Not reported" },
      { label: "Disk capacity", value: sysInfo?.rootDisk?.totalBytes ? formatBytes(sysInfo.rootDisk.totalBytes) : "Not reported" },
      { label: "Tags", value: server.tags?.join(", ") || "None" },
      { label: "Notes", value: server.notes || "None" },
      { label: "Agent version", value: sysInfo?.agentVersion || "Not reported" },
      { label: "Uptime", value: metric ? formatUptime(metric.uptime) : "Not reported" },
      { label: "Last check", value: formatDate(metric?.collectedAt) },
    ] : []),
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <DemoBanner overview={overview} />
      {failedJobs > 0 ? (
        <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-2">
          <span>{failedJobs} recent {failedJobs === 1 ? "job failed" : "jobs failed"}. Host health is reported separately.</span>
          <Link to="jobs?status=failed" className="font-medium underline underline-offset-4">Review failed jobs</Link>
        </Alert>
      ) : null}
      <section aria-label="Workload status">
        <div className="w-full sm:max-w-xs">
          <Kpi
            label="Containers"
            value={containersValue}
            sub={
              docker?.available
                ? `${notRunning} stopped · ${docker.freshness === "stale" ? "stale snapshot" : "active snapshot"}`
                : "Docker data unavailable"
            }
            tone={containersTone}
          />
        </div>
      </section>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <ChartPanel title="CPU & Memory" hint="Utilization history · percent" series={cpuMemory} />
        <ChartPanel title="Network I/O" hint="Receive / transmit throughput · bytes per second" series={netSeries} />
      </div>

      {/* Audit / jobs split */}
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[1.5fr_1fr]">
        <AuditPanel events={overview.auditEvents.slice(0, 5)} compact />
        <JobsPanel jobs={overview.jobs.slice(0, 5)} compact />
      </div>
      <SystemFacts facts={sysCells} />

    </div>
  );
}
