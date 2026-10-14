import { Link } from "react-router-dom";
import { cn } from "../../lib/utils";
import type { VpsRecord } from "../../lib/api";

export type FleetHostItemProps = {
  id: string;
  to: string;
  name: string;
  endpoint: string;
  status?: VpsRecord["status"];
  cpu?: number;
  memory?: number;
  selected?: boolean;
};

function statusDotClass(status?: VpsRecord["status"]) {
  if (status === "healthy") return "bg-signal";
  if (status === "warning") return "bg-warn";
  if (status === "unreachable") return "bg-crit";
  return "bg-dim";
}

function loadValueClass(
  value: number | undefined,
  token: "cpu" | "memory",
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-dim";
  if (value >= 85) return "text-crit";
  if (value >= 70) return "text-warn";
  return token === "cpu"
    ? "text-[hsl(var(--telemetry-cpu))]"
    : "text-[hsl(var(--telemetry-memory))]";
}

function formatPct(value?: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(0)}%`
    : "n/a";
}

export function FleetHostItem({
  id,
  to,
  name,
  endpoint,
  status,
  cpu,
  memory,
  selected,
}: FleetHostItemProps) {
  const needsAttention = status === "warning" || status === "unreachable";
  return (
    <Link
      to={to}
      data-host-id={id}
      aria-current={selected ? "page" : undefined}
      aria-label={`Host ${name}`}
      className={cn(
        "block min-w-[13rem] shrink-0 border-b border-l-2 border-b-line px-4 py-3 text-left transition-colors duration-160 ease-out focus-visible:outline-2 focus-visible:outline-signal lg:min-w-0 lg:w-full lg:shrink",
        selected
          ? "border-l-signal bg-raised text-text"
          : "border-l-transparent text-dim hover:bg-raised/70 hover:text-text",
      )}
    >
      <span className="flex items-center gap-2">
        <i
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            statusDotClass(status),
          )}
        />
        <span className="tnum min-w-0 flex-1 truncate font-medium text-text">
          {name}
        </span>
      </span>
      <span className="tnum mt-1 block truncate text-[11px] text-dim">
        {endpoint}
      </span>
      <span className="tnum mt-1.5 flex gap-3 text-[11px] text-dim">
        <span>
          CPU{" "}
          <b className={cn("font-medium", loadValueClass(cpu, "cpu"))}>
            {formatPct(cpu)}
          </b>
        </span>
        <span>
          RAM{" "}
          <b className={cn("font-medium", loadValueClass(memory, "memory"))}>
            {formatPct(memory)}
          </b>
        </span>
      </span>
    </Link>
  );
}
