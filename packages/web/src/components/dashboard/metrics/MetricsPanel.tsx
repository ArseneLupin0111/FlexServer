import { useEffect, useId, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "../../../lib/utils";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { chipVariant, freshnessLabel } from "../../../lib/dashboard-formatters";
import type { DashboardOverview } from "../../../lib/api";
import type { ChartSeries } from "./historySeries";
import {
  cpuMemorySeries,
  formatChartTime,
  formatNetworkPair,
  formatThroughput,
  formatTickValue,
  networkSeries,
  pickFocusMetric,
  sumNetworkRate,
} from "./historySeries";
import { formatUptime } from "../shared/formatUptime";
import { EmptyState } from "../shared/EmptyState";
import {
  formatBytes as formatDockerBytes,
  formatDockerError,
} from "../servers/helpers";

type Tone = "ok" | "warn" | "crit";

const toneText: Record<Tone, string> = {
  ok: "text-text",
  warn: "text-warn",
  crit: "text-crit",
};

const loadTone = (value: number): Tone =>
  value >= 85 ? "crit" : value >= 70 ? "warn" : "ok";

export function MetricsPanel({
  metrics,
  dockerMetrics,
  scopedVpsId,
}: {
  metrics: DashboardOverview["metrics"];
  dockerMetrics: DashboardOverview["dockerMetrics"];
  scopedVpsId?: string;
}) {
  const [serverFilter, setServerFilter] = useState(scopedVpsId || "all");
  const [metricFilter, setMetricFilter] = useState("all");

  useEffect(() => {
    if (scopedVpsId) {
      setServerFilter(scopedVpsId);
    }
  }, [scopedVpsId]);

  const serverIds = Array.from(
    new Set([
      ...metrics.map((metric) => metric.vpsId),
      ...dockerMetrics.map((metric) => metric.vpsId),
    ]),
  ).sort();
  const visibleMetrics = metrics.filter(
    (metric) => serverFilter === "all" || metric.vpsId === serverFilter,
  );
  const visibleDockerMetrics = dockerMetrics.filter(
    (metric) => serverFilter === "all" || metric.vpsId === serverFilter,
  );
  const fresh = metrics.filter((metric) => metric.freshness === "fresh").length;
  const highestCpu = maxMetric(metrics, "cpu");
  const highestDisk = maxMetric(metrics, "disk");
  const highestMemory = maxMetric(metrics, "memory");
  const highestLoad = metrics.length
    ? [...metrics].sort((a, b) => b.loadAverage - a.loadAverage)[0]
    : null;
  // History charts render one host's own `history` window: the selected
  // host, or — for "all" — the most recently updated single host. Never a
  // cross-host merge and never a relabeled series.
  const chartFocus = pickFocusMetric(metrics, serverFilter);
  const cpuMemory = cpuMemorySeries(chartFocus);
  const netSeries = networkSeries(chartFocus);
  const rxRate = sumNetworkRate(visibleMetrics, "networkRx");
  const txRate = sumNetworkRate(visibleMetrics, "networkTx");
  const alerts = buildMetricAlerts(visibleMetrics);

  const showCpuMem =
    metricFilter === "all" ||
    metricFilter === "cpu" ||
    metricFilter === "memory" ||
    metricFilter === "disk" ||
    metricFilter === "load";
  const showNetwork =
    metricFilter === "all" ||
    metricFilter === "network" ||
    metricFilter === "disk" ||
    metricFilter === "load";

  return (
    <div className="grid min-w-0 gap-4">
      <section
        className={cn(
          "grid gap-3 border border-line bg-panel p-3",
          scopedVpsId ? "grid-cols-1" : "md:grid-cols-[minmax(0,1fr)_190px]",
        )}
        aria-label="Metrics filters"
      >
        {!scopedVpsId ? (
          <select
            aria-label="Filter metrics server"
            className="h-9 w-full border border-line bg-ink px-3 text-[13px] text-text focus:border-signal focus:outline-none"
            value={serverFilter}
            onChange={(event) => setServerFilter(event.target.value)}
          >
            <option value="all">All servers</option>
            {serverIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Filter metric type"
          className="h-9 w-full border border-line bg-ink px-3 text-[13px] text-text focus:border-signal focus:outline-none"
          value={metricFilter}
          onChange={(event) => setMetricFilter(event.target.value)}
        >
          <option value="all">All metrics</option>
          <option value="cpu">CPU</option>
          <option value="memory">Memory</option>
          <option value="disk">Disk</option>
          <option value="load">Load</option>
          <option value="network">Network</option>
        </select>
      </section>

      {!scopedVpsId ? (
        <section
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
          aria-label="Metrics summary"
        >
          <MetricStat
            label="CPU"
            value={highestCpu ? `${highestCpu.cpu.toFixed(1)}%` : "n/a"}
            sub={highestCpu ? `peak · ${highestCpu.vpsId}` : "no telemetry"}
            tone={highestCpu ? loadTone(highestCpu.cpu) : undefined}
          />
          <MetricStat
            label="RAM"
            value={highestMemory ? `${highestMemory.memory.toFixed(1)}%` : "n/a"}
            sub={highestMemory ? `peak · ${highestMemory.vpsId}` : "no telemetry"}
            tone={highestMemory ? loadTone(highestMemory.memory) : undefined}
          />
          <MetricStat
            label="Disk"
            value={highestDisk ? `${highestDisk.disk.toFixed(1)}%` : "n/a"}
            sub={highestDisk ? `peak · ${highestDisk.vpsId}` : "no telemetry"}
            tone={highestDisk ? loadTone(highestDisk.disk) : undefined}
          />
          <MetricStat
            label="Load"
            value={highestLoad ? highestLoad.loadAverage.toFixed(2) : "n/a"}
            sub={
              highestLoad
                ? `peak · ${highestLoad.vpsId} · ${fresh}/${metrics.length} fresh`
                : "no telemetry"
            }
          />
        </section>
      ) : null}

      <section
        className={cn(
          "grid gap-4",
          showCpuMem && showNetwork
            ? "grid-cols-2 max-[1000px]:grid-cols-1"
            : "grid-cols-1",
        )}
        aria-label="Metric trends"
      >
        {showCpuMem ? (
          <ChartPanel
            title="CPU & memory"
            hint={
              chartFocus
                ? `Utilization history · ${chartFocus.vpsId}`
                : "Agent-reported utilization history"
            }
            series={cpuMemory}
          />
        ) : null}
        {showNetwork ? (
          <ChartPanel
            title="Network in / out"
            hint={
              chartFocus
                ? `Throughput (B/s) · ${chartFocus.vpsId}`
                : "Agent-reported throughput (B/s)"
            }
            series={netSeries}
            readouts={
              scopedVpsId
                ? undefined
                : [
                    {
                      label: "RX",
                      value: rxRate.known
                        ? formatThroughput(rxRate.total)
                        : "n/a",
                    },
                    {
                      label: "TX",
                      value: txRate.known
                        ? formatThroughput(txRate.total)
                        : "n/a",
                    },
                  ]
            }
          />
        ) : null}
      </section>

      {!scopedVpsId ? (
        visibleMetrics.length ? (
          <section className="grid gap-3" aria-label="Server metrics">
            {visibleMetrics.map((metric) => (
              <MetricServerCard
                key={metric.vpsId}
                metric={metric}
                focus={metricFilter}
              />
            ))}
          </section>
        ) : (
          <EmptyState>No metrics match these filters.</EmptyState>
        )
      ) : null}

      <CanonicalDockerWorkloads
        dockerMetrics={visibleDockerMetrics}
        totalDockerMetrics={dockerMetrics}
        scoped={Boolean(scopedVpsId)}
      />

      <section
        className="border border-line bg-panel"
        aria-label="Recent metric alerts"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold">Recent metric alerts</h2>
            <p className="mt-0.5 text-[12px] text-dim">
              Threshold warnings and telemetry freshness alerts.
            </p>
          </div>
          <Pill tone={alerts.length ? "warn" : "neutral"}>
            {alerts.length} alerts
          </Pill>
        </header>
        {alerts.length ? (
          <ul className="space-y-2 p-4">
            {alerts.map((alert) => (
              <li
                key={`${alert.vpsId}-${alert.message}`}
                className="flex gap-2 text-[13px]"
              >
                <AlertTriangle
                  size={14}
                  className="mt-0.5 shrink-0 text-warn"
                  aria-hidden="true"
                />
                <span>
                  <span className="tnum text-dim">{alert.vpsId}</span>
                  {" · "}
                  {alert.message}
                  <span className="tnum text-dim"> · {alert.time}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center">
            <div className="text-[13px] font-medium">No alerts</div>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-dim">
              No resource warnings from current metrics.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "crit" | "info";
}) {
  const t = {
    neutral: "border-line text-dim",
    ok: "border-signal/40 text-signal bg-signal/10",
    warn: "border-warn/40 text-warn bg-warn/10",
    crit: "border-crit/40 text-crit bg-crit/10",
    info: "border-info/40 text-info bg-info/10",
  }[tone];
  return (
    <span
      className={`inline-flex items-center border px-1.5 py-0.5 text-[11px] font-medium ${t}`}
    >
      {children}
    </span>
  );
}

function MetricStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: Tone;
}) {
  return (
    <div className="border border-line bg-panel p-4 transition-colors duration-160 ease-out hover:bg-raised/40">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dim">
        {label}
      </div>
      <div className={`tnum mt-1.5 text-2xl font-bold tracking-tight ${tone ? toneText[tone] : ""}`}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-[12px] text-dim" title={sub}>
        {sub}
      </div>
    </div>
  );
}

export type { ChartSeries } from "./historySeries";

export function ChartPanel({
  title,
  hint,
  series,
  readouts,
}: {
  title: string;
  hint: string;
  series: ChartSeries[];
  readouts?: Array<{ label: string; value: string }>;
}) {
  // A single sample cannot form a line: require >=2 valid (non-gap) points.
  const validCount = (entry: ChartSeries) =>
    entry.points.filter((point) => point.value !== null).length;
  const withPoints = series.filter((entry) => validCount(entry) >= 2);
  const totalPoints = series.reduce(
    (sum, entry) => sum + entry.points.length,
    0,
  );
  return (
    <section className="border border-line bg-panel">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <p className="mt-0.5 text-[12px] text-dim">{hint}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {readouts?.map((readout) => (
            <span key={readout.label} className="text-[12px] text-dim">
              {readout.label}{" "}
              <span className="tnum text-text">{readout.value}</span>
            </span>
          ))}
          {series.map((entry) => {
            const valid = entry.points.filter(
              (point) => point.value !== null,
            ).length;
            return (
              <span
                key={entry.key}
                className="flex items-center gap-1.5 text-[12px] text-dim"
              >
                <i
                  className="inline-block h-0.5 w-3"
                  style={{
                    background: entry.color,
                    opacity: valid >= 2 ? 1 : 0.35,
                  }}
                />
                {entry.name}
                {valid < 2 && (
                  <span className="text-warn">no history</span>
                )}
              </span>
            );
          })}
        </div>
      </header>
      <div className="px-4 py-4">
        {withPoints.length ? (
          <TrendChart series={withPoints} />
        ) : (
          <div className="px-4 py-8 text-center">
            <div className="text-[13px] font-medium">
              {totalPoints === 0
                ? "History unavailable"
                : "Not enough history yet"}
            </div>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-dim">
              {totalPoints === 0
                ? "No collected samples for this host yet."
                : "At least two collected samples are needed to draw history; current values remain in the readouts."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

type TrendRow = { t: number; [key: string]: number | null };

/**
 * Chronological union of every series timestamp, keyed by series key so
 * mismatched or sparse sample sets line up. Missing entries stay null so
 * Recharts breaks the line instead of interpolating or implying zero.
 */
function alignRows(plotted: ChartSeries[]): TrendRow[] {
  const byTime: Record<number, TrendRow> = {};
  for (const entry of plotted) {
    for (const point of entry.points) {
      const t = Date.parse(point.t);
      if (!Number.isFinite(t)) continue;
      const existing = byTime[t] ?? { t };
      existing[entry.key] =
        typeof point.value === "number" && Number.isFinite(point.value)
          ? point.value
          : null;
      byTime[t] = existing;
    }
  }
  const rows = Object.values(byTime).sort((a, b) => a.t - b.t);
  for (const row of rows) {
    for (const entry of plotted) {
      if (!(entry.key in row)) row[entry.key] = null;
    }
  }
  return rows;
}

function TrendTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: unknown;
    color?: string;
    dataKey?: string | number;
  }>;
  label?: unknown;
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const when =
    typeof label === "number" && Number.isFinite(label)
      ? new Date(label).toLocaleString()
      : "Unknown time";
  return (
    <div className="border border-line bg-raised px-2 py-1 text-[11px] text-text">
      <p className="tnum text-dim">{when}</p>
      {payload.map((entry) => {
        const raw = entry.value;
        const text =
          typeof raw === "number" && Number.isFinite(raw)
            ? unit === "bytes/s"
              ? formatThroughput(raw)
              : `${raw.toFixed(1)}%`
            : "unavailable";
        return (
          <p key={String(entry.dataKey ?? entry.name)} className="tnum mt-0.5">
            <span style={{ color: entry.color }}>{entry.name}</span>
            {": "}
            {text}
          </p>
        );
      })}
    </div>
  );
}

function TrendChart({ series }: { series: ChartSeries[] }) {
  // React useId emits colons (":r0:") which break SVG url(#…) references.
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // ChartPanel already gates on >=2 valid points; double-check here.
  const plotted = series.filter(
    (entry) => entry.points.filter((point) => point.value !== null).length >= 2,
  );
  const data = alignRows(plotted);
  const unit = plotted[0]?.unit;
  const isPercent = unit === "%";
  const validValues = plotted.flatMap((entry) =>
    entry.points.flatMap((point) =>
      point.value === null ? [] : [point.value],
    ),
  );
  // Percent is bounded 0..100; network stays data-driven and never negative.
  // Thresholds remain visible by widening the upper bound when supplied.
  const highest = Math.max(...validValues, 1);
  const top = Math.max(
    highest,
    ...plotted.flatMap((entry) =>
      entry.threshold === undefined ? [] : [entry.threshold],
    ),
  );
  const yDomain: [number, number] = isPercent ? [0, 100] : [0, top];
  const first = data.length > 0 ? data[0].t : 0;
  const last = data.length > 0 ? data[data.length - 1].t : 1;
  // A single shared timestamp needs visible width or it collapses to the axis.
  const xDomain: ["dataMin", "dataMax"] | [number, number] =
    first === last ? [first - 60_000, last + 60_000] : ["dataMin", "dataMax"];
  const tickStyle = { fill: "hsl(var(--dim))", fontSize: 11 };

  return (
    <div
      className="min-w-0"
      role="region"
      aria-label={`${plotted.map((entry) => entry.name).join(" and ")} trend`}
    >
      <div className="h-48 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart
            accessibilityLayer
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              {plotted.map((entry) => (
                <linearGradient
                  key={entry.key}
                  id={`${gradientId}-${entry.key}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    style={{ stopColor: entry.color, stopOpacity: 0.26 }}
                  />
                  <stop
                    offset="100%"
                    style={{ stopColor: entry.color, stopOpacity: 0 }}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke="hsl(var(--line))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={xDomain}
              tickFormatter={(t: number) => `${formatChartTime(new Date(t).toISOString())}:${String(new Date(t).getSeconds()).padStart(2, "0")}`}
              tick={tickStyle}
              stroke="hsl(var(--line))"
              minTickGap={24}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(value: number) => isPercent ? `${formatTickValue(value, unit)}%` : unit === "bytes/s" ? formatThroughput(value) : formatTickValue(value, unit)}
              tick={tickStyle}
              stroke="hsl(var(--line))"
              width={isPercent ? 56 : 76}
            />
            <Tooltip
              filterNull={false}
              content={<TrendTooltip unit={unit} />}
              cursor={{ stroke: "hsl(var(--dim))" }}
            />
            {plotted.map((entry) => (
              <Area
                key={entry.key}
                type="linear"
                dataKey={entry.key}
                name={entry.name}
                stroke={entry.color}
                fill={`url(#${gradientId}-${entry.key})`}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
            {plotted.map((entry) =>
              entry.threshold !== undefined && Number.isFinite(entry.threshold) ? (
                <ReferenceLine
                  key={`${entry.key}-threshold`}
                  y={entry.threshold}
                  stroke={entry.color}
                  strokeDasharray="4 3"
                  strokeOpacity={0.45}
                />
              ) : null,
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
function CanonicalDockerWorkloads({
  dockerMetrics,
  totalDockerMetrics,
  scoped,
}: {
  dockerMetrics: DashboardOverview["dockerMetrics"];
  totalDockerMetrics: DashboardOverview["dockerMetrics"];
  scoped?: boolean;
}) {
  const available = totalDockerMetrics.filter((metric) => metric.available);
  const scopedAvailable = dockerMetrics.filter((metric) => metric.available);
  const activeMetrics = scoped ? scopedAvailable : available;
  const totals = activeMetrics.reduce(
    (summary, metric) => ({
      containers: summary.containers + metric.containerTotal,
      running: summary.running + metric.containerRunning,
      cpu: summary.cpu + metric.cpuPercent,
      memory: summary.memory + metric.memoryUsageBytes,
      network: summary.network + metric.networkRxBytes + metric.networkTxBytes,
      pids: summary.pids + metric.pids,
    }),
    { containers: 0, running: 0, cpu: 0, memory: 0, network: 0, pids: 0 },
  );

  const allContainers = dockerMetrics
    .filter((metric) => metric.available)
    .flatMap((metric) =>
      metric.containers.map((container) => ({
        ...container,
        vpsId: metric.vpsId,
      })),
    )
    .sort((a, b) => b.cpuPercent - a.cpuPercent);

  const firstMetric = dockerMetrics[0];

  return (
    <section className="border border-line bg-panel" aria-label="Docker metrics">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold">Docker workloads</h2>
          <p className="mt-0.5 text-[12px] text-dim">
            {scoped
              ? "Agent-reported container workloads and resource utilization."
              : "Top containers and resource utilization across reporting hosts."}
          </p>
        </div>
        <Pill tone={activeMetrics.length ? "ok" : "neutral"}>
          {activeMetrics.length ? `${totals.running} running` : "Docker inactive"}
        </Pill>
      </header>

      {totalDockerMetrics.length ? (
        <div className="space-y-4 p-4">
          <section
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
            aria-label="Docker metrics summary"
          >
            <MetricStat
              label="Containers"
              value={`${totals.running}/${totals.containers}`}
              sub={`${totals.running} running`}
            />
            {!scoped ? (
              <MetricStat
                label="Docker hosts"
                value={`${available.length}/${totalDockerMetrics.length}`}
                sub="Reporting agents"
              />
            ) : (
              <MetricStat
                label="PIDs"
                value={String(totals.pids)}
                sub="Active processes"
              />
            )}
            <MetricStat
              label="Container CPU"
              value={`${totals.cpu.toFixed(1)}%`}
              sub={scoped ? "Host total" : "Across hosts"}
            />
            <MetricStat
              label="Container RAM"
              value={formatDockerBytes(totals.memory)}
              sub="Current usage"
            />
            <MetricStat
              label="Container network"
              value={formatDockerBytes(totals.network)}
              sub="RX + TX"
            />
          </section>

          {firstMetric && !firstMetric.available ? (
            <div className="border-l-2 border-line pl-3">
              <p className="text-[13px] text-dim">
                {formatDockerError(firstMetric.errorCode)}
              </p>
              <p className="mt-1 text-[12px] text-dim">
                Check Docker socket access for the agent.
              </p>
            </div>
          ) : allContainers.length ? (
            <div className="overflow-hidden border border-line">
              <div className="hidden grid-cols-[minmax(140px,1fr)_minmax(160px,1.25fr)_0.7fr_0.7fr_0.8fr_0.6fr] gap-3 bg-raised px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-dim md:grid">
                <span>Container</span>
                <span>Image</span>
                <span>State</span>
                <span>CPU</span>
                <span>Memory</span>
                <span>PIDs</span>
              </div>
              <div className="divide-y divide-line">
                {allContainers.map((container) => (
                  <div
                    key={`${container.vpsId}-${container.containerKey}`}
                    className="grid gap-2 border-t border-line px-3 py-2.5 text-[13px] text-dim hover:bg-raised md:grid-cols-[minmax(140px,1fr)_minmax(160px,1.25fr)_0.7fr_0.7fr_0.8fr_0.6fr] md:items-center"
                    title={container.status}
                  >
                    <span className="min-w-0 truncate font-medium text-text">
                      {container.name}
                    </span>
                    <span
                      className="min-w-0 truncate font-mono text-[12px]"
                      title={container.image}
                    >
                      {container.image}
                    </span>
                    <span className="capitalize">{container.state}</span>
                    <span className="tnum font-medium text-text">
                      {container.cpuPercent.toFixed(1)}%
                    </span>
                    <span className="tnum">
                      {formatDockerBytes(container.memoryUsageBytes)}
                    </span>
                    <span className="tnum">{container.pids}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-dim">
              No containers reported by this agent.
            </p>
          )}
        </div>
      ) : (
        <div className="p-4">
          <EmptyState>No Docker metrics reported for this server.</EmptyState>
        </div>
      )}
    </section>
  );
}

function maxMetric(
  metrics: DashboardOverview["metrics"],
  key: "cpu" | "memory" | "disk",
) {
  return metrics.length
    ? [...metrics].sort((a, b) => b[key] - a[key])[0]
    : null;
}

function MetricServerCard({
  metric,
  focus,
}: {
  metric: DashboardOverview["metrics"][number];
  focus: string;
}) {
  const stale = metric.freshness === "stale";
  const warnings = [
    metric.cpu >= 85 ? "High CPU" : null,
    metric.memory >= 80 ? "Memory pressure" : null,
    metric.disk >= 85 ? "Disk near limit" : null,
    stale ? "Stale telemetry" : null,
  ].filter(Boolean);
  return (
    <article className="grid min-w-0 gap-3 border border-line bg-panel p-4 xl:grid-cols-[minmax(220px,1fr)_minmax(360px,1.4fr)_auto] xl:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="truncate text-lg font-medium text-text">
            {metric.vpsId}
          </strong>
          <Badge className="uppercase" variant={chipVariant(metric.freshness)}>
            {metric.freshness}
          </Badge>
        </div>
        <p className="mt-1 text-[12px] text-dim">
          Collected {freshnessLabel(metric.collectedAt)} · Uptime{" "}
          {formatUptime(metric.uptime)}
        </p>
        {warnings.length ? (
          <p className="tnum mt-2 text-[11px] uppercase tracking-[0.08em] text-warn">
            {warnings.join(" · ")}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <MetricMeter
          label="CPU"
          value={metric.cpu}
          display={`${metric.cpu}%`}
          hot={metric.cpu >= 85 || focus === "cpu"}
        />
        <MetricMeter
          label="RAM"
          value={metric.memory}
          display={`${metric.memory}%`}
          hot={metric.memory >= 80 || focus === "memory"}
        />
        <MetricMeter
          label="Disk"
          value={metric.disk}
          display={`${metric.disk}%`}
          hot={metric.disk >= 85 || focus === "disk"}
        />
        <MetricMeter
          label="Load"
          value={Math.min(100, metric.loadAverage * 25)}
          display={String(metric.loadAverage)}
          hot={focus === "load"}
        />
        <MetricMeter
          label="Net"
          value={null}
          display={formatNetworkPair(metric)}
          hot={focus === "network"}
        />
      </div>
      <div className="flex flex-wrap gap-2 xl:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-line px-3 text-[12px] font-medium"
          disabled
          title="Coming soon"
        >
          View details
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-line px-3 text-[12px] font-medium"
          disabled
          title="Coming soon"
        >
          Open server
        </Button>
      </div>
    </article>
  );
}

function MetricMeter({
  label,
  value,
  display,
  hot = false,
}: {
  label: string;
  value: number | null;
  display: string;
  hot?: boolean;
}) {
  const tone = value === null ? "ok" : loadTone(value);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className={hot ? "text-text" : "text-dim"}>{label}</span>
        <span className={`tnum ${toneText[tone]}`} title={display}>
          {display}
        </span>
      </div>
      <div
        className="mt-1.5 h-1 bg-line"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value === null ? undefined : Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${value === null ? "bg-info" : tone === "ok" ? "bg-signal" : tone === "warn" ? "bg-warn" : "bg-crit"}`}
          style={{
            width: `${value === null ? 100 : Math.min(100, Math.max(0, value))}%`,
            opacity: value === null ? 0.55 : 1,
          }}
        />
      </div>
    </div>
  );
}

function buildMetricAlerts(metrics: DashboardOverview["metrics"]) {
  return metrics.flatMap(
    (metric) =>
      [
        metric.freshness === "stale"
          ? {
              vpsId: metric.vpsId,
              severity: "stale",
              message: "Telemetry is stale",
              time: freshnessLabel(metric.collectedAt),
            }
          : null,
        metric.memory >= 80
          ? {
              vpsId: metric.vpsId,
              severity: "critical",
              message: `Memory pressure at ${metric.memory}%`,
              time: freshnessLabel(metric.collectedAt),
            }
          : metric.memory >= 75
            ? {
                vpsId: metric.vpsId,
                severity: "warning",
                message: `Memory nearing threshold at ${metric.memory}%`,
                time: freshnessLabel(metric.collectedAt),
              }
            : null,
        metric.disk >= 85
          ? {
              vpsId: metric.vpsId,
              severity: "critical",
              message: `Disk near limit at ${metric.disk}%`,
              time: freshnessLabel(metric.collectedAt),
            }
          : metric.disk >= 75
            ? {
                vpsId: metric.vpsId,
                severity: "warning",
                message: `Disk usage warning at ${metric.disk}%`,
                time: freshnessLabel(metric.collectedAt),
              }
            : null,
        metric.cpu >= 85
          ? {
              vpsId: metric.vpsId,
              severity: "critical",
              message: `High CPU at ${metric.cpu}%`,
              time: freshnessLabel(metric.collectedAt),
            }
          : null,
      ].filter(Boolean) as Array<{
        vpsId: string;
        severity: "warning" | "stale" | "critical";
        message: string;
        time: string;
      }>,
  );
}
