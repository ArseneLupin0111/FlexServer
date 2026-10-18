import type { DockerOperationalEvent } from "../../../lib/api";
import { EmptyState } from "../shared/EmptyState";

function describeAction(action: string): string {
  const labels: Record<string, string> = {
    create: "Container created",
    start: "Container started",
    restart: "Container restarted",
    die: "Container exited",
    stop: "Container stopped",
    kill: "Container killed",
    destroy: "Container destroyed",
    remove: "Container removed",
    health_status: "Health status change",
    stream_gap: "Event stream gap",
    daemon_restarted: "Daemon restarted",
  };
  return labels[action] ?? action;
}

/** Bounded operational Docker events timeline (read-only, not audit). */
export function DockerEventTimeline({
  events,
  retained,
  loading,
  error,
}: {
  events: DockerOperationalEvent[];
  retained: number;
  loading: boolean;
  error?: string | null;
}) {
  if (loading) {
    return (
      <section aria-label="Docker events" aria-busy="true" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-dim">Loading operational Docker events…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section aria-label="Docker events" className="border border-line bg-panel p-4">
        <p className="text-[12px] text-text">Operational Docker events are unavailable right now.</p>
        <p className="mt-1 text-[11px] text-dim">{error}</p>
      </section>
    );
  }
  return (
    <section aria-label="Docker events" className="border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-[14px] font-semibold">Operational Docker events</h3>
        <p className="mt-0.5 text-[12px] text-dim">
          Operational Docker events (container lifecycle), not the audit log. showing {events.length} loaded events
        </p>
      </header>
      {events.length === 0 ? (
        <div className="p-4">
          <EmptyState>No operational Docker events retained yet.</EmptyState>
        </div>
      ) : (
        <ol className="space-y-2 p-4">
          {events.map((event) => (
            <li key={event.id} className="flex items-start gap-3 text-[12px]">
              <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-dim" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium text-text">{describeAction(event.action)}</p>
                <p className="tnum truncate text-[11px] text-dim">
                  {new Date(event.eventOccurredAt).toLocaleString()}
                  {event.containerKey ? ` · ${event.containerKey}` : ""}
                  {event.exitCode !== undefined ? ` · exit ${event.exitCode}` : ""}
                  {event.signal !== undefined ? ` · signal ${event.signal}` : ""}
                  {event.oomKilled !== undefined ? ` · OOM killed ${event.oomKilled ? "Yes" : "No"}` : ""}
                  {event.healthStatus !== undefined ? ` · health ${event.healthStatus}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
