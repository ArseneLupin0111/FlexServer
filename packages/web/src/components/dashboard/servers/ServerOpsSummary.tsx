import type { ReactNode } from "react";
import type { DashboardOverview, VpsRecord } from "../../../lib/api";
import { vpsDisplayName } from "../../../lib/dashboard-formatters";

type Tone = "default" | "amber" | "red";

export function calculateServerOpsSummary(
  records: VpsRecord[],
  metrics: DashboardOverview["metrics"],
  dockerMetrics: DashboardOverview["dockerMetrics"],
) {
  const attention = records.filter((server) => {
    const local = server.kind === "local" || server.managedBy === "system";
    const hostProblem = server.status !== "healthy";
    const agentProblem = !local && server.agentStatus !== "online";
    const accessProblem = !local && !server.keyProvisionedAt;
    return hostProblem || agentProblem || accessProblem;
  }).length;

  const names = new Map(records.map((server) => [server.id, vpsDisplayName(server)]));
  const pressureCandidates = metrics.flatMap((metric) =>
    (["CPU", "Memory", "Disk"] as const).map((resource) => ({
      server: names.get(metric.vpsId) ?? metric.vpsId,
      resource,
      percent: resource === "CPU" ? metric.cpu : resource === "Memory" ? metric.memory : metric.disk,
    })),
  ).filter((item) => Number.isFinite(item.percent) && item.percent >= 0);
  const pressure = pressureCandidates.sort((a, b) => b.percent - a.percent)[0] ?? null;

  const availableDocker = dockerMetrics.filter((metric) => metric.available);
  const containers = availableDocker.reduce((summary, metric) => {
    const unhealthy = metric.containers.filter((container) =>
      /unhealthy|health:\s*starting|restarting|dead|exited/i.test(`${container.state} ${container.status ?? ""}`),
    ).length;
    summary.running += metric.containerRunning;
    summary.problems += Math.max(0, metric.containerTotal - metric.containerRunning) +
      metric.containers.filter((container) => container.state.toLowerCase() === "running").filter((container) =>
        /unhealthy|health:\s*starting|restarting/i.test(container.status ?? ""),
      ).length;
    summary.unhealthy += unhealthy;
    return summary;
  }, { running: 0, problems: 0, unhealthy: 0 });

  const liveAgents = records.filter((server) =>
    server.kind === "local" || server.managedBy === "system" || server.agentStatus === "online",
  ).length;
  const agentGaps = records.length - liveAgents;

  return { attention, pressure, containers, liveAgents, agentGaps, dockerAvailable: availableDocker.length };
}

/** Compact stat button: left tone accent, uppercase label, value, sub line. */
function StatCard({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  tone: Tone;
  onClick?: () => void;
}) {
  const accent =
    tone === "red" ? "before:bg-crit" : tone === "amber" ? "before:bg-warn" : "before:bg-signal";
  const valueTone =
    tone === "red" ? "text-crit" : tone === "amber" ? "text-warn" : "text-text";
  const className = `relative min-w-0 border border-line bg-panel p-4 pl-5 text-left transition-colors duration-160 ease-out before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${accent}`;
  const clickable = `hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal`;
  const content: ReactNode = (
    <>
      <span className="block truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-dim">
        {label}
      </span>
      <span className={`tnum mt-1.5 block truncate text-[15px] font-bold ${valueTone}`}>
        {value}
      </span>
      <span className="block truncate text-[12px] text-dim" title={sub}>
        {sub}
      </span>
    </>
  );
  if (!onClick) {
    return <div className={className}>{content}</div>;
  }
  return (
    <button type="button" className={`${className} ${clickable}`} onClick={onClick}>
      {content}
    </button>
  );
}

export function ServerOpsSummary({ records, metrics, dockerMetrics, onSelect }: {
  records: VpsRecord[];
  metrics: DashboardOverview["metrics"];
  dockerMetrics: DashboardOverview["dockerMetrics"];
  /** Optional filter shortcut handler; each stat maps to a status filter value. */
  onSelect?: (filter: string) => void;
}) {
  const summary = calculateServerOpsSummary(records, metrics, dockerMetrics);
  const attentionTone: Tone = summary.attention === 0 ? "default" : records.some((server) => server.status === "unreachable" || server.agentStatus === "failed") ? "red" : "amber";
  const attentionTarget = records.some((s) => s.status === "unreachable")
    ? "unreachable"
    : records.some((s) => s.status === "warning")
      ? "warning"
      : records.some((s) => s.status === "unknown")
        ? "unknown"
        : "all";
  const pressureTone: Tone = summary.pressure && summary.pressure.percent >= 90 ? "red" : summary.pressure && summary.pressure.percent >= 75 ? "amber" : "default";
  const containerTone: Tone = summary.containers.problems ? (summary.containers.unhealthy ? "red" : "amber") : "default";
  const monitoringTone: Tone = summary.agentGaps ? (summary.liveAgents === 0 ? "red" : "amber") : "default";
  return (
    <section
      className="grid grid-cols-4 gap-3 max-[1000px]:grid-cols-2 max-[560px]:grid-cols-1"
      aria-label="Fleet health summary"
    >
      <StatCard
        label={summary.attention ? "Needs attention" : "Fleet health"}
        value={summary.attention ? `${summary.attention} server${summary.attention === 1 ? "" : "s"}` : `${records.length} healthy`}
        sub={summary.attention
          ? records
              .filter((server) => {
                const local = server.kind === "local" || server.managedBy === "system";
                return server.status !== "healthy" || (!local && server.agentStatus !== "online") || (!local && !server.keyProvisionedAt);
              })
              .slice(0, 1)
              .map((server) => vpsDisplayName(server))[0] ?? "All clear"
          : "All servers nominal"}
        tone={attentionTone}
        onClick={onSelect ? () => onSelect(attentionTarget) : undefined}
      />
      <StatCard
        label="Resource pressure"
        value={summary.pressure ? `${summary.pressure.server} · ${summary.pressure.resource} ${summary.pressure.percent.toFixed(0)}%` : "No metrics available"}
        sub={summary.pressure ? `Peak ${summary.pressure.percent.toFixed(0)}% in view` : "No metrics available"}
        tone={pressureTone}
        onClick={onSelect ? () => onSelect("all") : undefined}
      />
      <StatCard
        label="Containers"
        value={summary.dockerAvailable === 0 ? "No Docker metrics" : summary.containers.problems ? `${summary.containers.problems} problem · ${summary.containers.running} running` : `${summary.containers.running} running`}
        sub={summary.dockerAvailable === 0 ? "Waiting for agent snapshots" : summary.containers.problems ? "Containers need review" : "All healthy"}
        tone={containerTone}
        onClick={onSelect ? () => onSelect("all") : undefined}
      />
      <StatCard
        label="Monitoring"
        value={`${summary.liveAgents}/${records.length} agents live`}
        sub={summary.agentGaps ? `${summary.agentGaps} missing · heartbeat gaps` : "Heartbeat OK"}
        tone={monitoringTone}
        onClick={onSelect ? () => onSelect("healthy") : undefined}
      />
    </section>
  );
}
