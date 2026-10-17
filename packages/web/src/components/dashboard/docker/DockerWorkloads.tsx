import type { DashboardOverview } from "../../../lib/api";
import { formatBytes as formatDockerBytes, formatDockerError } from "../servers/helpers";
import { EmptyState } from "../shared/EmptyState";

export function DockerWorkloads({ dockerMetrics }: {
  dockerMetrics: DashboardOverview["dockerMetrics"];
}) {
  const activeMetrics = dockerMetrics.filter((metric) => metric.available);
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
            Agent-reported container workloads and resource utilization.
          </p>
        </div>
        <span className={`inline-flex items-center border px-1.5 py-0.5 text-[11px] font-medium ${activeMetrics.length ? "border-signal/40 bg-signal/10 text-signal" : "border-line text-dim"}`}>
          {activeMetrics.length ? `${totals.running} running` : "Docker inactive"}
        </span>
      </header>

      {dockerMetrics.length ? (
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
            <MetricStat label="PIDs" value={String(totals.pids)} sub="Active processes" />
            <MetricStat
              label="Container CPU"
              value={`${totals.cpu.toFixed(1)}%`}
              sub="Host total"
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
                    <span data-container-state={container.state} className="docker-container-state capitalize">{container.state}</span>
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

function MetricStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="border border-line bg-panel p-4">
    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dim">{label}</div>
    <div className="tnum mt-1.5 text-2xl font-bold tracking-tight">{value}</div>
    <div className="mt-0.5 truncate text-[12px] text-dim" title={sub}>{sub}</div>
  </div>;
}
