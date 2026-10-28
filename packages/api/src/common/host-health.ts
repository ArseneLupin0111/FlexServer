export const HOST_FRESHNESS_THRESHOLD_MS = 120_000;

export function isFreshTimestamp(
  timestamp: string,
  thresholdMs = HOST_FRESHNESS_THRESHOLD_MS,
  now = Date.now(),
): boolean {
  const time = Date.parse(timestamp);
  // Future and invalid observations are not fresh: freshness is based on an
  // observation already received by the server, not an agent clock claim.
  return Number.isFinite(time) && time <= now && now - time < thresholdMs;
}

export function deriveHostStatus(
  status: "unknown" | "healthy" | "warning" | "unreachable" | undefined,
  lastSeenAt: string | undefined,
  now = Date.now(),
): "unknown" | "healthy" | "warning" | "unreachable" {
  const storedStatus = status ?? "unknown";
  if (storedStatus !== "healthy") return storedStatus;
  if (!lastSeenAt) return storedStatus;
  const seen = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seen)) return storedStatus;
  return now - seen >= HOST_FRESHNESS_THRESHOLD_MS ? "unknown" : storedStatus;
}
