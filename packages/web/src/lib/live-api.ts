import type { DashboardOverview } from "./api";

// ── Event envelope types ──────────────────────────────────────────────

export type MonitoringEnvelope<TType extends string, TPayload> = {
  schemaVersion: 1;
  type: TType;
  id: string;
  emittedAt: string;
  payload: TPayload;
};

export type MonitoringHelloPayload = {
  mode: "demo" | "local";
  intervalMs: number;
};

export type MonitoringSnapshotPayload = {
  overview: DashboardOverview;
  servers: DashboardOverview["servers"];
  jobs: DashboardOverview["jobs"];
  metrics: DashboardOverview["metrics"];
  auditEvents: DashboardOverview["auditEvents"];
} | { refreshRequired: true };

export type MetricsUpdatedPayload = {
  metrics: DashboardOverview["metrics"];
  systemInfo?: DashboardOverview["systemInfo"];
  dockerMetrics?: DashboardOverview["dockerMetrics"];
  servers?: DashboardOverview["servers"];
};

export type JobsUpdatedPayload = {
  jobs: DashboardOverview["jobs"];
};

export type MonitoringHeartbeatPayload = Record<string, never>;

export type MonitoringErrorPayload = {
  message: string;
};

export type DockerEventsAvailablePayload = {
  vpsId?: string;
  newestEventId?: string;
  countHint?: number;
  truncated?: boolean;
};

export type DockerAlertsUpdatedPayload = {
  vpsId?: string;
  changedAlertIds?: string[];
  refreshRequired?: boolean;
};

export type DockerInvalidationPayload = {
  vpsIds?: string[];
  refreshRequired?: boolean;
};

// ── Union of all recognised event types ───────────────────────────────

export type MonitoringEvent =
  | MonitoringEnvelope<"monitoring.hello", MonitoringHelloPayload>
  | MonitoringEnvelope<"monitoring.snapshot", MonitoringSnapshotPayload>
  | MonitoringEnvelope<"metrics.updated", MetricsUpdatedPayload>
  | MonitoringEnvelope<"jobs.updated", JobsUpdatedPayload>
  | MonitoringEnvelope<"monitoring.heartbeat", MonitoringHeartbeatPayload>
  | MonitoringEnvelope<"monitoring.error", MonitoringErrorPayload>
  | MonitoringEnvelope<"docker.events.available", DockerEventsAvailablePayload>
  | MonitoringEnvelope<"docker.alerts.updated", DockerAlertsUpdatedPayload>
  | MonitoringEnvelope<"docker.invalidation", DockerInvalidationPayload>;

// ── Connection state ──────────────────────────────────────────────────

export type LiveConnectionState =
  | { status: "connecting" }
  | { status: "live"; latestEventAt: string }
  | { status: "reconnecting"; latestEventAt?: string }
  | { status: "stale"; latestEventAt?: string };

// ── Event source subscription ─────────────────────────────────────────

export type MonitoringCallbacks = {
  onHello?: (payload: MonitoringHelloPayload) => void;
  onSnapshot?: (payload: MonitoringSnapshotPayload) => void;
  onMetricsUpdated?: (payload: MetricsUpdatedPayload) => void;
  onJobsUpdated?: (payload: JobsUpdatedPayload) => void;
  onHeartbeat?: (payload: MonitoringHeartbeatPayload) => void;
  onError?: (payload: MonitoringErrorPayload) => void;
  onDockerEventsAvailable?: (payload: DockerEventsAvailablePayload) => void;
  onDockerAlertsUpdated?: (payload: DockerAlertsUpdatedPayload) => void;
  onDockerInvalidation?: (payload: DockerInvalidationPayload) => void;
  onConnectionChange?: (state: LiveConnectionState) => void;
};

/**
 * Subscribe to the SSE monitoring stream.
 * Returns a cleanup function that closes the EventSource.
 */
export function subscribeMonitoring(
  callbacks: MonitoringCallbacks,
): () => void {
  let es: EventSource | null = null;
  let reconnectAttempts = 0;
  let latestCursor: number | null = null;
  let generation = 0;
  let disposed = false;

  function connect() {
    const currentGeneration = ++generation;
    if (es) es.close();
    callbacks.onConnectionChange?.({ status: "connecting" });
    const query = latestCursor === null ? "" : `?cursor=${encodeURIComponent(String(latestCursor))}`;
    const current = new EventSource(`/api/monitoring/stream${query}`);
    es = current;
    const active = () => !disposed && generation === currentGeneration && es === current;
    const acceptCursor = (event: MessageEvent) => {
      if (!active()) return false;
      const raw = typeof event.lastEventId === "string" ? event.lastEventId.trim() : "";
      if (!/^\d+$/.test(raw)) return true;
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || id < 0 || (latestCursor !== null && id <= latestCursor)) return false;
      latestCursor = id;
      return true;
    };
    const handle = (event: MessageEvent, callback?: (payload: never) => void) => {
      if (!acceptCursor(event)) return;
      try {
        const envelope = JSON.parse(event.data) as MonitoringEvent;
        if (envelope.schemaVersion !== 1) return;
        callback?.(envelope.payload as never);
        callbacks.onConnectionChange?.({ status: "live", latestEventAt: envelope.emittedAt });
        reconnectAttempts = 0;
      } catch { /* Ignore malformed events */ }
    };
    for (const [type, callback] of [
      ["monitoring.hello", callbacks.onHello], ["monitoring.snapshot", callbacks.onSnapshot],
      ["metrics.updated", callbacks.onMetricsUpdated], ["jobs.updated", callbacks.onJobsUpdated],
      ["monitoring.heartbeat", callbacks.onHeartbeat], ["monitoring.error", callbacks.onError],
      ["docker.events.available", callbacks.onDockerEventsAvailable], ["docker.alerts.updated", callbacks.onDockerAlertsUpdated],
      ["docker.invalidation", callbacks.onDockerInvalidation],
    ] as const) {
      current.addEventListener(type, (event: MessageEvent) => handle(event, callback as ((payload: never) => void) | undefined));
    }
    current.onerror = () => {
      if (!active()) return;
      reconnectAttempts++;
      callbacks.onConnectionChange?.(reconnectAttempts <= 1 ? { status: "reconnecting" } : { status: "stale" });
      current.close();
      const delay = Math.min(1000 * 2 ** Math.max(0, reconnectAttempts - 1), 16_000);
      window.setTimeout(() => {
        if (active()) connect();
      }, delay);
    };
  }

  connect();
  return () => {
    disposed = true;
    generation++;
    es?.close();
    es = null;
  };
}