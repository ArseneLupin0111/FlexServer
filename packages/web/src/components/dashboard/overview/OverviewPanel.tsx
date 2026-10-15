import { Link } from "react-router-dom";
import { Alert } from "../../ui/alert";
import type { DashboardOverview } from "../../../lib/api";
import { formatBytes } from "../servers/helpers";
import {
  formatDate,
  freshnessLabel,
  serverStatusLabel,
  vpsHostId,
} from "../../../lib/dashboard-formatters";
import { formatUptime } from "../shared/formatUptime";
import { AuditPanel } from "../audit/AuditPanel";
import { JobsPanel } from "../jobs/JobsPanel";
import { FactGroup, SystemFacts } from "../shared/SystemFacts";
import { ChartPanel } from "../metrics/MetricsPanel";
import {
  cpuMemorySeries,
  formatNetworkValue,
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
  to,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: KpiTone;
  to?: string;
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

  const content = (
    <>
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
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className="min-w-0 border border-line bg-panel px-4 py-3 transition-colors duration-160 ease-out hover:bg-raised/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      >
        {content}
      </Link>
    );
  }

  return (
    <div className="min-w-0 border border-line bg-panel px-4 py-3 transition-colors duration-160 ease-out hover:bg-raised/40">
      {content}
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
  const cpuMemoryReadouts = [
    {
      label: "CPU",
      value: metric?.cpu != null ? `${metric.cpu.toFixed(1)}%` : "n/a",
    },
    {
      label: "RAM",
      value: metric?.memory != null ? `${metric.memory.toFixed(1)}%` : "n/a",
    },
  ];
  const netReadouts = [
    {
      label: "RX",
      value: formatNetworkValue(metric, "networkRx"),
    },
    {
      label: "TX",
      value: formatNetworkValue(metric, "networkTx"),
    },
  ];

  const serverGroups: readonly FactGroup[] = server
    ? [
        {
          group: "Host & Runtime",
          items: [
            { label: "Server ID", value: server.id, span: 2 },
            { label: "Host ID", value: vpsHostId(server) || "Not reported", span: 2 },
            {
              label: "Agent version",
              value: sysInfo?.agentVersion || "Not reported",
            },
            {
              label: "Uptime",
              value: metric ? formatUptime(metric.uptime) : "Not reported",
            },
            {
              label: "Last check",
              value: formatDate(metric?.collectedAt),
              span: 2,
            },
          ],
        },
        {
          group: "Configuration & Notes",
          items: [
            { label: "Tags", value: server.tags?.join(", ") || "None" },
            { label: "Notes", value: server.notes || "None", span: 3 },
          ],
        },
      ]
    : [];

  const factGroups: readonly FactGroup[] = [
    {
      group: "Hardware & Platform",
      items: [
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
        {
          label: "CPU model",
          value: sysInfo?.cpu?.model || "Not reported",
          span: 2,
        },
        {
          label: "CPU cores",
          value: sysInfo?.cpu?.cores ? String(sysInfo.cpu.cores) : "Not reported",
        },
        {
          label: "RAM capacity",
          value: sysInfo?.memory?.totalBytes
            ? formatBytes(sysInfo.memory.totalBytes)
            : "Not reported",
        },
        {
          label: "Disk capacity",
          value: sysInfo?.rootDisk?.totalBytes
            ? formatBytes(sysInfo.rootDisk.totalBytes)
            : "Not reported",
          span: 2,
        },
      ],
    },
    ...serverGroups,
  ];

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
    ...(server
      ? [
          { label: "Server ID", value: server.id },
          { label: "Host ID", value: vpsHostId(server) || "Not reported" },
          {
            label: "CPU cores",
            value: sysInfo?.cpu?.cores ? String(sysInfo.cpu.cores) : "Not reported",
          },
          { label: "CPU model", value: sysInfo?.cpu?.model || "Not reported" },
          {
            label: "RAM capacity",
            value: sysInfo?.memory?.totalBytes
              ? formatBytes(sysInfo.memory.totalBytes)
              : "Not reported",
          },
          {
            label: "Disk capacity",
            value: sysInfo?.rootDisk?.totalBytes
              ? formatBytes(sysInfo.rootDisk.totalBytes)
              : "Not reported",
          },
          { label: "Tags", value: server.tags?.join(", ") || "None" },
          { label: "Notes", value: server.notes || "None" },
          {
            label: "Agent version",
            value: sysInfo?.agentVersion || "Not reported",
          },
          {
            label: "Uptime",
            value: metric ? formatUptime(metric.uptime) : "Not reported",
          },
          { label: "Last check", value: formatDate(metric?.collectedAt) },
        ]
      : []),
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
      <section
        aria-label="Workload status"
        className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3"
      >
        <Kpi
          label="Host"
          value={server ? serverStatusLabel(server.status) : "n/a"}
          sub={
            metric?.uptime
              ? `Uptime ${formatUptime(metric.uptime)}`
              : metric?.collectedAt
                ? `Last seen ${freshnessLabel(metric.collectedAt)}`
                : "No telemetry reported"
          }
          tone={
            server?.status === "healthy"
              ? "ok"
              : server?.status === "warning"
                ? "warn"
                : server?.status === "unreachable"
                  ? "crit"
                  : "idle"
          }
        />
        <Kpi
          label="Containers"
          value={containersValue}
          sub={
            docker?.available
              ? `${notRunning} stopped · ${docker.freshness === "stale" ? "stale snapshot" : "active snapshot"}`
              : "Docker data unavailable"
          }
          tone={containersTone}
          to="docker"
        />
        <Kpi
          label="Jobs"
          value={overview.jobs.length ? `${overview.jobs.length} recorded` : "0 recorded"}
          sub={`${runningJobs} running · ${failedJobs} failed`}
          tone={failedJobs > 0 ? "crit" : runningJobs > 0 ? "warn" : "idle"}
          to="jobs"
        />
      </section>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <ChartPanel
          title="CPU & Memory"
          hint="Utilization history · percent"
          series={cpuMemory}
          readouts={cpuMemoryReadouts}
        />
        <ChartPanel
          title="Network I/O"
          hint="Receive / transmit throughput · bytes per second"
          series={netSeries}
          readouts={netReadouts}
        />
      </div>

      {/* Audit / jobs split */}
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[1.5fr_1fr]">
        <AuditPanel events={overview.auditEvents.slice(0, 5)} compact />
        <JobsPanel jobs={overview.jobs.slice(0, 5)} compact />
      </div>
      <SystemFacts groups={factGroups} facts={sysCells} />

    </div>
  );
}
