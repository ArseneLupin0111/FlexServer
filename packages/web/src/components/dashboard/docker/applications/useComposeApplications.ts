/**
 * Shared data hooks for Compose applications panels.
 *
 * Both the list view and detail view poll the same capability + list
 * endpoints, so the load/refresh/error/retry cycle lives here once.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getVpsComposeCapability,
  listVpsComposeApplications,
  type ComposeAppSummary,
  type ComposeCapability,
} from "../../../../lib/compose-applications";

export type ComposeApplicationsData = {
  capability: ComposeCapability | null;
  applications: ComposeAppSummary[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor?: string;
  error: string | null;
  loadMoreError: string | null;
  refresh: () => void;
  loadMore: () => void;
};

export function useComposeApplications(vpsId: string, refreshTick: number) {
  const [capability, setCapability] = useState<ComposeCapability | null>(null);
  const [applications, setApplications] = useState<ComposeAppSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const scopeRef = useRef({ vpsId, generation: 0 });

  useEffect(() => {
    const scopeId = vpsId;
    let cancelled = false;
    const controller = new AbortController();
    const scopeChanged = scopeRef.current.vpsId !== scopeId;
    const generation = ++scopeRef.current.generation;
    setLoadingMore(false);
    scopeRef.current.vpsId = scopeId;
    if (scopeChanged) {
      setCapability(null);
      setApplications([]);
      setNextCursor(undefined);
      setLoadingMore(false);
      setLoadMoreError(null);
    }
    // Keep evidence on same-VPS refresh failures, never across VPS scopes.
    setLoading(scopeChanged || applications.length === 0);
    setError(null);
    getVpsComposeCapability(scopeId, controller.signal)
      .then((result) => {
        if (cancelled) return;
        setCapability(result);
      })
      .catch((err) => {
        if (cancelled || err instanceof DOMException) return;
        if (scopeChanged) setCapability(null);
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Compose capability check failed.",
        );
      });

    listVpsComposeApplications(scopeId)
      .then((result) => {
        if (cancelled) return;
        setApplications(result.items);
        setNextCursor(result.nextCursor);
        setLoadMoreError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (scopeChanged) {
          setApplications([]);
          setNextCursor(undefined);
        }
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Applications inventory is unavailable.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (scopeRef.current.generation === generation) ++scopeRef.current.generation;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vpsId, refreshTick, retryTick]);

  const refresh = useCallback(() => {
    setRetryTick((tick) => tick + 1);
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = nextCursor;
    if (!cursor || loadingMore) return;
    const generation = scopeRef.current.generation;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const result = await listVpsComposeApplications(vpsId, cursor);
      if (scopeRef.current.vpsId !== vpsId || scopeRef.current.generation !== generation) return;
      setApplications((items) => [...items, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (err) {
      if (scopeRef.current.vpsId !== vpsId || scopeRef.current.generation !== generation) return;
      setLoadMoreError(
        err instanceof Error && err.message
          ? err.message
          : "Unable to load more applications.",
      );
    } finally {
      if (scopeRef.current.vpsId === vpsId && scopeRef.current.generation === generation) setLoadingMore(false);
    }
  }, [vpsId, nextCursor, loadingMore]);

  return {
    capability,
    applications,
    loading,
    loadingMore,
    nextCursor,
    error,
    loadMoreError,
    refresh,
    loadMore,
  };
}
