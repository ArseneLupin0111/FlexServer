import { useId } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import type { DockerHostSample, DockerMetricRollup } from "../../../lib/api";
import { EmptyState } from "../shared/EmptyState";
import { formatBytes } from "../servers/helpers";

type HistoryPoint = { t: number; value: number | null };

function pointsFor(samples: DockerHostSample[], key: string): HistoryPoint[] {
  return samples
    .map((sample) => {
      const t = Date.parse(sample.effectiveAt);
      return { sample, t: Number.isFinite(t) ? t : null };
    })
    .filter((entry): entry is { sample: DockerHostSample; t: number } => entry.t !== null)
    .sort((a, b) => a.t - b.t)
    .map(({ sample, t }) => {
      const value = sample.metrics[key];
      return {
        t,
        value: typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null,
      };
    });
}

function CpuTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active) return null;
  const raw = payload?.[0]?.value;
  return (
    <div className="border border-line bg-raised px-2 py-1 text-[11px] text-text">
      <p className="tnum text-dim">
        {typeof label === "number" && Number.isFinite(label) ? new Date(label).toLocaleString() : "Unknown time"}
      </p>
      <p className="tnum mt-0.5">
        {typeof raw === "number" && Number.isFinite(raw) ? `${raw.toFixed(1)}%` : "no data"}
      </p>
    </div>
  );
}

function MemoryTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active) return null;
  const raw = payload?.[0]?.value;
  return (
    <div className="border border-line bg-raised px-2 py-1 text-[11px] text-text">
      <p className="tnum text-dim">
        {typeof label === "number" && Number.isFinite(label) ? new Date(label).toLocaleString() : "Unknown time"}
      </p>
      <p className="tnum mt-0.5">
        {typeof raw === "number" && Number.isFinite(raw) ? (raw === 0 ? "0 B" : formatBytes(raw)) : "no data"}
      </p>
    </div>
  );
}

/** Bounded host history charts (read-only Recharts, no controls). */
export function DockerHistoryChart({
  samples,
  rollups,
  retained,
  loading,
  error,
}: {
  samples: DockerHostSample[];
  rollups?: DockerMetricRollup[];
  retained: number;
  loading: boolean;
  error?: string | null;
}) {
  const captionId = useId();
  if (loading) {
    return (
      <section aria-label="Docker history" aria-busy="true" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-dim">Loading bounded Docker history…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label="Docker history" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-text">Docker history is unavailable right now.</p>
        <p className="mt-1 text-[11px] text-dim">{error}</p>
      </section>
    );
  }
  const cpu = pointsFor(samples, "cpuPercent");
  const mem = pointsFor(samples, "memoryUsageBytes");
  const cpuValid = cpu.filter((p) => p.value !== null).length;
  const memValid = mem.filter((p) => p.value !== null).length;
  const times = [...cpu.map((p) => p.t), ...mem.map((p) => p.t)].sort((a, b) => a - b);
  const first = times.length > 0 ? times[0] : undefined;
  const last = times.length > 0 ? times[times.length - 1] : undefined;
  const partial = samples.filter((sample) => sample.coverage && !sample.coverage.complete).length;
  const gaps = samples.filter((sample) => sample.coverage && sample.coverage.detailsSampled < sample.coverage.detailsTotalEligible).length;
  if (cpuValid === 0 && memValid === 0) {
    return (
      <section aria-label="Docker history" className="border border-line bg-panel">
        <header className="border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">History</h3>
        </header>
        <div className="p-4">
          <EmptyState>
            No history retained yet.
          </EmptyState>
        </div>
      </section>
    );
  }

  const xDomainFor = (points: HistoryPoint[]): [string | number, string | number] => {
    if (points.length === 0) return ["dataMin", "dataMax"];
    const ts = points.map((p) => p.t);
    const min = Math.min(...ts);
    const max = Math.max(...ts);
    if (min === max) return [min - 60_000, max + 60_000];
    return ["dataMin", "dataMax"];
  };
  const cpuMax = Math.max(...cpu.map((p) => (p.value === null ? Number.NEGATIVE_INFINITY : p.value)), 0);
  const memMax = Math.max(...mem.map((p) => (p.value === null ? Number.NEGATIVE_INFINITY : p.value)), 0);
  const cpuYDomain: [string | number, string | number] = cpuMax <= 0 ? [0, 1] : [0, "dataMax"];
  const memYDomain: [string | number, string | number] = memMax <= 0 ? [0, 1] : [0, "dataMax"];
  const tickStyle = { fill: "hsl(var(--dim))", fontSize: 11 };

  return (
    <section aria-label="Docker history" className="border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-[14px] font-semibold">History</h3>
        <p className="mt-1 text-xs text-dim">{samples.length} samples · {rollups?.length ?? 0} rollups</p>
      </header>
      <div className="space-y-2 p-4">
        <p className="tnum text-[11px] text-dim">
          {first !== undefined && last !== undefined
            ? `${new Date(first).toLocaleString()} – ${new Date(last).toLocaleString()}`
            : "No source range"}
          {partial ? ` · ${partial} partial coverage` : ""}
          {gaps ? ` · ${gaps} samples with reduced detail coverage` : ""}
        </p>
        <div className="grid min-w-0 gap-4 text-text sm:grid-cols-2">
          <figure aria-labelledby={`${captionId}-cpu`} className="min-w-0">
            <figcaption id={`${captionId}-cpu`} className="text-[11px] text-dim">
              CPU (%) · aggregate can exceed 100%
            </figcaption>
            {cpuValid === 0 ? (
              <p className="mt-1 text-[11px] text-dim">No CPU % points retained.</p>
            ) : (
              <>
                <div className="mt-1 h-44 w-full min-w-0">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart accessibilityLayer data={cpu} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="hsl(var(--line))" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="t"
                        type="number"
                        scale="time"
                        domain={xDomainFor(cpu)}
                        tickFormatter={(t: number) =>
                          new Date(t).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })
                        }
                        tick={tickStyle}
                        stroke="hsl(var(--line))"
                        minTickGap={24}
                      />
                      <YAxis
                        domain={cpuYDomain}
                        tickFormatter={(v: number) => `${v}%`}
                        tick={tickStyle}
                        stroke="hsl(var(--line))"
                        width={52}
                      />
                      <Tooltip content={(props) => <CpuTooltip {...props} />} cursor={{ stroke: "hsl(var(--dim))" }} />
                      <Line
                        type="linear"
                        dataKey="value"
                        stroke="hsl(var(--telemetry-cpu))"
                        strokeWidth={1.5}
                        dot={cpuValid === 1 ? { r: 3, fill: "hsl(var(--telemetry-cpu))" } : false}
                        activeDot={{ r: 3 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {cpuValid === 1 ? (
                  <p className="mt-1 text-[11px] text-dim">Not enough history yet — showing the single retained sample.</p>
                ) : null}
              </>
            )}
          </figure>
          <figure aria-labelledby={`${captionId}-memory`} className="min-w-0">
            <figcaption id={`${captionId}-memory`} className="text-[11px] text-dim">
              Memory (bytes)
            </figcaption>
            {memValid === 0 ? (
              <p className="mt-1 text-[11px] text-dim">No Memory bytes points retained.</p>
            ) : (
              <>
                <div className="mt-1 h-44 w-full min-w-0">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart accessibilityLayer data={mem} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="hsl(var(--line))" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="t"
                        type="number"
                        scale="time"
                        domain={xDomainFor(mem)}
                        tickFormatter={(t: number) =>
                          new Date(t).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })
                        }
                        tick={tickStyle}
                        stroke="hsl(var(--line))"
                        minTickGap={24}
                      />
                      <YAxis
                        domain={memYDomain}
                        tickFormatter={(v: number) => (v === 0 ? "0 B" : formatBytes(v))}
                        tick={tickStyle}
                        stroke="hsl(var(--line))"
                        width={64}
                      />
                      <Tooltip content={(props) => <MemoryTooltip {...props} />} cursor={{ stroke: "hsl(var(--dim))" }} />
                      <Line
                        type="linear"
                        dataKey="value"
                        stroke="hsl(var(--telemetry-memory))"
                        strokeWidth={1.5}
                        dot={memValid === 1 ? { r: 3, fill: "hsl(var(--telemetry-memory))" } : false}
                        activeDot={{ r: 3 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {memValid === 1 ? (
                  <p className="mt-1 text-[11px] text-dim">Not enough history yet — showing the single retained sample.</p>
                ) : null}
              </>
            )}
          </figure>
        </div>
      </div>
    </section>
  );
}
