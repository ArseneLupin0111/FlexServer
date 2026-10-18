import type { DockerCurrentContainer } from "../../../lib/api";

function value(value: string | number | undefined) {
  return value === undefined || value === "" ? "Not reported" : String(value);
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-[11px] text-dim">{label}</dt><dd className="mt-1 break-words text-xs text-text">{children}</dd></div>;
}

/** Saved, read-only inspect projection for one exact agent/container identity. */
export function DockerContainerDetailsPanel({ container }: { container: DockerCurrentContainer }) {
  const details = container.details;
  return <section aria-label="Container details" className="min-w-0 border border-line bg-panel">
    <header className="border-b border-line px-4 py-3"><h3 className="text-sm font-semibold">Container details</h3></header>
    <div className="space-y-4 p-4">
      <dl className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
        <Definition label="Name">{value(container.name)}</Definition><Definition label="Image">{value(container.image)}</Definition><Definition label="State">{value(container.state)}</Definition>
        <Definition label="Agent instance"><span className="break-all">{container.agentInstanceId}</span></Definition><Definition label="Container key"><span className="break-all">{container.containerKey}</span></Definition><Definition label="Snapshot collected">{new Date(container.collectedAt).toLocaleString()}</Definition>
      </dl>
      {!details ? <p role="status" className="text-xs text-dim">Container detail inspection has not been supplied by this agent. Snapshot saved {new Date(container.collectedAt).toLocaleString()}.</p> : details.status === "unavailable" ? <p role="status" className="text-xs text-dim">Container details were unavailable when inspected ({details.reason}). Snapshot saved {new Date(details.collectedAt).toLocaleString()}.</p> : <>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-line pt-4 sm:grid-cols-3">
          <Definition label="Detail snapshot saved">{new Date(details.collectedAt).toLocaleString()}</Definition><Definition label="Created">{value(details.createdAt)}</Definition><Definition label="Started">{value(details.startedAt)}</Definition><Definition label="Finished">{value(details.finishedAt)}</Definition><Definition label="Exit code">{value(details.exitCode)}</Definition><Definition label="OOM killed">{details.oomKilled === undefined ? "Unknown" : details.oomKilled ? "Yes" : "No"}</Definition><Definition label="Restart count">{value(details.restartCount)}</Definition><Definition label="Restart policy">{details.restartPolicy ? `${details.restartPolicy.name} (maximum retries: ${details.restartPolicy.maximumRetryCount})` : "Not reported"}</Definition>
        </dl>
        <div className="grid min-w-0 gap-4 border-t border-line pt-4 md:grid-cols-2">
          <section><h4 className="text-xs font-semibold">Ports</h4>{details.ports.length ? <ul className="mt-2 space-y-1 text-xs">{details.ports.map((port, i) => <li key={`${port.containerPort}-${port.protocol}-${port.hostIp}-${port.hostPort}-${i}`} className="break-words">{port.hostIp ? `${port.hostIp}:` : ""}{port.hostPort ?? "unpublished"} → {port.containerPort}/{port.protocol}</li>)}</ul> : <p className="mt-2 text-xs text-dim">No ports reported.</p>}</section>
          <section><h4 className="text-xs font-semibold">Mounts</h4>{details.mounts.length ? <ul className="mt-2 space-y-1 text-xs">{details.mounts.map((mount, i) => <li key={`${mount.destination}-${i}`} className="break-all">{mount.source ? `${mount.source} → ` : ""}{mount.destination} · {mount.type} · {mount.readOnly ? "read-only" : "read-write"}</li>)}</ul> : <p className="mt-2 text-xs text-dim">No mounts reported.</p>}</section>
          <section><h4 className="text-xs font-semibold">Networks</h4>{details.networks.length ? <ul className="mt-2 space-y-1 text-xs">{details.networks.map((network) => <li key={network.name} className="break-words">{network.name}{[network.ipv4 && `IPv4 ${network.ipv4}`, network.ipv6 && `IPv6 ${network.ipv6}`, network.gateway && `gateway ${network.gateway}`].filter(Boolean).map((part) => ` · ${part}`)}</li>)}</ul> : <p className="mt-2 text-xs text-dim">No networks reported.</p>}</section>
          <section><h4 className="text-xs font-semibold">Healthcheck</h4><p className="mt-2 text-xs">{details.healthcheck.status === "none" ? "No healthcheck configured" : details.healthcheck.status}</p>{details.healthcheck.status !== "none" ? <p className="mt-1 break-words text-[11px] text-dim">{details.healthcheck.failingStreak !== undefined ? `Failing streak ${details.healthcheck.failingStreak}` : ""}{details.healthcheck.intervalMs !== undefined ? ` · interval ${details.healthcheck.intervalMs} ms` : ""}{details.healthcheck.timeoutMs !== undefined ? ` · timeout ${details.healthcheck.timeoutMs} ms` : ""}{details.healthcheck.startPeriodMs !== undefined ? ` · start period ${details.healthcheck.startPeriodMs} ms` : ""}{details.healthcheck.retries !== undefined ? ` · retries ${details.healthcheck.retries}` : ""}</p> : null}</section>
        </div>
      </>}
    </div>
  </section>;
}
