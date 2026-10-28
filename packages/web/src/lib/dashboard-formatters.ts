import type { VpsRecord } from "./api";

export type ChipVariant = "ready" | "pending" | "destructive" | "outline";

const dockerHostnamePattern = /^[0-9a-f]{12}$/;

export function vpsRawDisplayName(vps: VpsRecord): string {
  return (
    vps.displayName?.trim() ||
    vps.name?.trim() ||
    vps.id?.trim() ||
    vps.host?.trim() ||
    "VPS"
  );
}

/** User-facing VPS label, with presentation-only cleanup for generated local hostnames. */
export function vpsDisplayName(vps: VpsRecord): string {
  const name = vpsRawDisplayName(vps);
  const isLocal = vps.kind === "local" || vps.managedBy === "system";
  return isLocal && dockerHostnamePattern.test(name) ? "Local Server" : name;
}

export function vpsHostId(vps: VpsRecord): string | undefined {
  const name = vpsRawDisplayName(vps);
  return vpsDisplayName(vps) !== name ? name : undefined;
}

export function serverStatusLabel(status?: VpsRecord["status"]) {
  if (status === "healthy") return "Healthy";
  if (status === "warning") return "Warning";
  // `unreachable` is only persisted explicitly; a stale heartbeat reads `unknown`.
  if (status === "unreachable") return "Unreachable";
  return "Unknown";
}

export function chipVariant(status?: string): ChipVariant {
  if (
    ["healthy", "fresh", "succeeded", "success", "ready"].includes(status || "")
  )
    return "ready";
  if (
    ["unreachable", "failed", "failure", "blocked", "destructive"].includes(
      status || "",
    )
  )
    return "destructive";
  if (!status || status === "unknown") return "outline";
  return "pending";
}

export function formatDate(value?: string) {
  if (!value) return "Not reported";
  return new Date(value).toLocaleString();
}

export function freshnessLabel(value?: string) {
  if (!value) return "No timestamp";
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 60000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
