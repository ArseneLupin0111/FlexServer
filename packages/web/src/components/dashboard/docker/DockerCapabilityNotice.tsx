/**
 * Capability notice for the Docker detail view.
 *
 * Read-only: explains why bounded detail sections (history, operational
 * events, alerts, storage overview) may be unavailable instead of rendering
 * empty data as healthy. Never renders mutation controls.
 */
export function DockerCapabilityNotice({
  enabled,
  waiting,
}: {
  enabled: boolean;
  waiting: boolean;
}) {
  if (!enabled) {
    return (
      <div
        className="border border-line bg-panel p-4"
        role="status"
      >
        <p className="text-[13px] font-medium text-text">
          Docker monitoring is off for this server.
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-dim">
          Detail sections (history, operational events, alerts, storage
          overview) stay hidden until monitoring is enabled. Enabling
          monitoring does not grant container control: this view is
          read-only.
        </p>
      </div>
    );
  }

  if (waiting) {
    return (
      <div
        className="border border-line bg-panel p-4"
        role="status"
      >
        <p className="flex items-center gap-2 text-[13px] text-text">
          <span className="h-2 w-2 rounded-full bg-info" />
          Waiting for Docker-capable agent.
        </p>
        <p className="mt-1 pl-4 text-[12px] text-dim">
          Detail sections appear here automatically once the agent reports a
          snapshot. Bounded history, events, alerts, and the storage overview
          require an agent that reports Docker schema details.
        </p>
      </div>
    );
  }

  return null;
}
