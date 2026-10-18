import { useEffect, useRef, useState } from "react";
import { listVpsDockerEvents, type DockerCurrentContainer, type DockerOperationalEvent } from "../../../lib/api";
import { Button } from "../../ui/button";
import { DockerContainerManagementPanel } from "./DockerContainerManagementPanel";
import { DockerContainerDetailsPanel } from "./DockerContainerDetailsPanel";
import { DockerEventTimeline } from "./DockerEventTimeline";

const EVENT_LIMIT = 25;
const EVENT_CAP = 100;

export function DockerContainerInvestigationPanel({ vpsId, container, managementEnabled, monitoringEnabled, refreshTick }: {
  vpsId: string;
  container: DockerCurrentContainer;
  managementEnabled: boolean;
  monitoringEnabled: boolean;
  refreshTick: number;
}) {
  const identity = JSON.stringify([vpsId, container.agentInstanceId, container.containerKey]);
  const generation = useRef(0);
  const [events, setEvents] = useState<DockerOperationalEvent[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setEvents([]); setCursor(undefined); setHasMore(false); setError(null); setMoreError(null); setLoading(false); setLoadingMore(false);
    if (!monitoringEnabled) return;
    setLoading(true);
    listVpsDockerEvents(vpsId, { agentInstanceId: container.agentInstanceId, containerKey: container.containerKey, limit: EVENT_LIMIT })
      .then((result) => {
        if (generation.current !== requestGeneration) return;
        const unique = [...new Map(result.data.map((event) => [event.id, event])).values()].slice(0, EVENT_CAP);
        setEvents(unique); setCursor(result.page.nextCursor); setHasMore(result.page.hasMore || unique.length === EVENT_CAP);
      })
      .catch((reason: unknown) => { if (generation.current === requestGeneration) setError(reason instanceof Error ? reason.message : "Container events unavailable"); })
      .finally(() => { if (generation.current === requestGeneration) setLoading(false); });
    return () => { if (generation.current === requestGeneration) generation.current += 1; };
  }, [identity, refreshTick, monitoringEnabled, retryTick]);

  useEffect(() => () => { generation.current += 1; }, []);

  const loadMore = async () => {
    if (!cursor || loadingMore || events.length >= EVENT_CAP) return;
    const requestGeneration = generation.current;
    setLoadingMore(true); setMoreError(null);
    try {
      const result = await listVpsDockerEvents(vpsId, { agentInstanceId: container.agentInstanceId, containerKey: container.containerKey, limit: EVENT_LIMIT, cursor });
      if (generation.current !== requestGeneration) return;
      setEvents((current) => [...new Map([...current, ...result.data].map((event) => [event.id, event])).values()].slice(0, EVENT_CAP));
      setCursor(result.page.nextCursor); setHasMore(result.page.hasMore);
    } catch (reason) {
      if (generation.current === requestGeneration) setMoreError(reason instanceof Error ? reason.message : "Unable to load more events");
    } finally {
      if (generation.current === requestGeneration) setLoadingMore(false);
    }
  };

  return <div className="min-w-0 space-y-4">
    {!monitoringEnabled ? <p role="status" className="border border-line bg-panel p-3 text-xs text-dim">Docker monitoring is disabled. Details below are saved container data and may not reflect current state.</p> : null}
    <DockerContainerDetailsPanel container={container} />
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <section aria-label="Selected container events" className="min-w-0 space-y-3">
        {!monitoringEnabled ? <p role="status" className="border border-line bg-panel p-4 text-xs text-dim">Docker monitoring is disabled. Container events are not currently loaded.</p> : <>
          <div className="flex justify-end"><Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => setRetryTick((tick) => tick + 1)}>Refresh events</Button></div>
          <DockerEventTimeline events={events} retained={events.length} loading={loading && events.length === 0} error={error} />
          {error ? <Button type="button" variant="outline" size="sm" onClick={() => setRetryTick((tick) => tick + 1)}>Retry</Button> : null}
          {hasMore && events.length < EVENT_CAP ? <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : "Load more events"}</Button> : null}
          {moreError ? <p role="alert" className="text-xs text-crit">{moreError}</p> : null}
          {events.length >= EVENT_CAP ? <p className="text-[11px] text-dim">Only the 100 most recent loaded events are shown.</p> : null}
        </>}
      </section>
      <div className="min-w-0"><DockerContainerManagementPanel vpsId={vpsId} enabled={managementEnabled} refreshTick={refreshTick} fixedTarget={{ agentInstanceId: container.agentInstanceId, containerKey: container.containerKey }} /></div>
    </div>
  </div>;
}
