/**
 * Compose applications list for one VPS.
 *
 * Reads the real applications inventory (grouped by Compose project) — never
 * the sampled per-container metric list, which is bounded and can miss
 * containers for big projects. Each row shows observed services, replicas
 * with live container route links, mode, capability rationale, and
 * inventory freshness. Creates registers detected projects or new managed
 * stacks; nothing is created silently.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../ui/alert-dialog";
import { Input } from "../../../ui/input";
import { EmptyState } from "../../shared/EmptyState";
import { RowActionsMenu } from "../../shared/RowActionsMenu";
import { ComposeApplicationDetail } from "./ComposeApplicationDetail";
import { useComposeApplications } from "./useComposeApplications";
import { ComposeCapabilityNotice, ComposeInventoryIncompleteNote } from "./ComposeCapabilityNotice";
import {
  createVpsComposeApplication,
  vpsComposeModeLabel,
  type ComposeAppSummary,
  type ComposeApplicationMode,
} from "../../../../lib/compose-applications";

export type ComposeApplicationsPanelProps = {
  vpsId: string;
  refreshTick: number;
};

export function ComposeApplicationsPanel({
  vpsId,
  refreshTick,
}: ComposeApplicationsPanelProps) {
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const data = useComposeApplications(vpsId, refreshTick);
  const [modeFilter, setModeFilter] = useState<ComposeApplicationMode | "all">("all");
  const filtered = useMemo(() => {
    if (modeFilter === "all") return data.applications;
    return data.applications.filter((app) => app.mode === modeFilter);
  }, [data.applications, modeFilter]);

  return (
    <section aria-label="Compose applications" className="min-w-0 border border-line bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1 sm:pr-6">
          <h3 className="text-[15px] font-semibold">Compose applications</h3>
          <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-dim">
            Compose projects reported by the agent's inventory. Discovered
            stacks are read-only until source verification and explicit control opt-in.
          </p>
        </div>
        <ComposeCreateApplicationButton vpsId={vpsId} onCreated={data.refresh} />
      </header>
        {selectedAppId ? (
          <ComposeApplicationDetail
            vpsId={vpsId}
            appId={selectedAppId}
            onBack={() => setSelectedAppId(null)}
          />
        ) : (
        <div className="space-y-3 p-4">
          <ComposeCapabilityNotice
            vpsId={vpsId}
            capability={data.capability}
            loading={data.loading}
            error={data.error}
            onRetry={data.refresh}
          />
          <ComposeInventoryIncompleteNote capability={data.capability} />

          {!data.loading && data.applications.length === 0 && !data.error && data.capability?.supported && !data.capability.demoDisabled && data.capability.inventory.ageSeconds !== undefined ? (
            <EmptyState>
              <p className="font-medium text-text">No Compose projects in this scan</p>
              <p className="mt-1 text-[12px] leading-relaxed">Projects appear here when the agent discovers containers belonging to a Docker Compose stack.</p>
            </EmptyState>
          ) : null}

          {!data.loading && data.applications.length > 0 ? (
            <label className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3 text-[12px] text-dim" htmlFor={`compose-app-filter-${vpsId}`}>
              <span>{data.applications.length} applications · Filter by management mode</span>
              <select
                id={`compose-app-filter-${vpsId}`}
                value={modeFilter}
                onChange={(event) => setModeFilter(event.target.value as ComposeApplicationMode | "all")}
                className="min-h-9 border border-line bg-raised px-2 text-[12px] text-text"
              >
                <option value="all">All modes</option>
                <option value="detected_readonly">Detected (read-only)</option>
                <option value="external_control">External stack control</option>
                <option value="managed">Managed</option>
                <option value="unmanaged">Unmanaged</option>
              </select>
            </label>
          ) : null}

          {data.applications.length > 0 && filtered.length === 0 ? <EmptyState>No applications match this management mode.</EmptyState> : null}
          {filtered.map((app) => (
            <ComposeApplicationRow
              key={app.appId}
              vpsId={vpsId}
              app={app}
              onOpen={() => setSelectedAppId(app.appId)}
            />
          ))}

          {data.loadMoreError ? (
            <p role="alert" className="text-[11px] text-crit">{data.loadMoreError}</p>
          ) : null}
          {data.nextCursor ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={data.loadingMore}
              onClick={() => void data.loadMore()}
            >
              {data.loadingMore ? "Loading…" : "Load more applications"}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ── Application row ─────────────────────────────────────────────────

function ComposeApplicationRow({
  vpsId,
  app,
  onOpen,
}: {
  vpsId: string;
  app: ComposeAppSummary;
  onOpen: () => void;
}) {
  const runningCount = app.observed.services
    .flatMap((service) => service.replicas)
    .filter((replica) => replica.state === "running").length;
  const totalReplicas = app.observed.services
    .flatMap((service) => service.replicas)
    .length;

  return (
    <article className="min-w-0 border border-line bg-ink/30">
      <header className="flex items-start justify-between gap-3 border-b border-line px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpen}
              className="break-all text-left text-[14px] font-semibold text-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              {app.displayName}
            </button>
            <span className="inline-flex items-center border border-line px-1.5 py-0.5 text-[11px] text-dim">
              {vpsComposeModeLabel(app.mode)}
            </span>
          </div>
          <p className="mt-1 truncate text-[11px] font-mono text-dim" title={app.projectName}>
            project {app.projectName}
          </p>
        </div>
        <RowActionsMenu label={`actions for ${app.displayName}`}>
          <button
            type="button"
            onClick={onOpen}
            className="w-full px-2 py-1.5 text-left text-[12px] hover:bg-raised"
          >
            Open application
          </button>
        </RowActionsMenu>
      </header>

      <div className="space-y-3 p-3 sm:p-4">
        {app.capabilityReason ? (
          <p className="text-[11px] text-warn">{app.capabilityReason}</p>
        ) : null}

        {app.observed.services.length === 0 ? (
          <p className="text-[11px] text-dim">
            No services reported for this project yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {app.observed.services.map((service) => (
              <li key={service.service} className="min-w-0 border-b border-line pb-3 text-[12px] last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-medium text-text">{service.service}</span>
                  <span className="text-[11px] text-dim">
                    {service.kind === "oneshot" ? "one-shot job" : "service"}
                  </span>
                  {service.desiredCount != null ? (
                    <span className="tnum text-[11px] text-dim">
                      {service.replicas.length}/{service.desiredCount} observed/desired
                    </span>
                  ) : (
                    <span className="tnum text-[11px] text-dim">
                      {service.replicas.length} observed · desired unknown
                    </span>
                  )}
                </div>
                {service.replicas.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {service.replicas.map((replica) => {
                      if (!app.agentInstanceId) {
                        return (
                          <span
                            key={replica.containerKey}
                            title="Container investigation unavailable: agent instance id not part of the sampled inventory"
                            className="inline-flex items-center gap-1 border border-line px-1.5 py-0.5 text-[11px] text-dim"
                          >
                            <span
                              aria-hidden="true"
                              className="docker-container-state h-1.5 w-1.5 rounded-full bg-current"
                              data-container-state={replica.state}
                            />
                            <span className="docker-container-state" data-container-state={replica.state}>
                              {replica.state}
                            </span>
                          </span>
                        );
                      }
                      const route = `/vps/${encodeURIComponent(vpsId)}/docker/containers/${encodeURIComponent(app.agentInstanceId)}/${encodeURIComponent(replica.containerKey)}`;
                      return (
                        <Link
                          key={replica.containerKey}
                          to={route}
                          title="Open container investigation (preserves container identity route)"
                          className="inline-flex items-center gap-1 border border-line px-1.5 py-0.5 text-[11px] text-info hover:border-dim hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                        >
                          <span
                            aria-hidden="true"
                            className="docker-container-state h-1.5 w-1.5 rounded-full bg-current"
                            data-container-state={replica.state}
                          />
                          <span className="docker-container-state" data-container-state={replica.state}>
                            {replica.state}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {totalReplicas > 0 ? (
          <p className="tnum text-[11px] text-dim">
            {runningCount}/{totalReplicas} replicas running
            {app.inventoryFreshnessSeconds != null
              ? ` · inventory ${app.inventoryFreshnessSeconds >= 60 ? `${Math.round(app.inventoryFreshnessSeconds / 60)}m` : `${app.inventoryFreshnessSeconds}s`} old`
              : ""}
            {app.observed.updatedAt
              ? ` · updated ${new Date(app.observed.updatedAt).toLocaleString()}`
              : ""}
          </p>
        ) : null}
      </div>
    </article>
  );
}

// ── Create dialog ───────────────────────────────────────────────────

function ComposeCreateApplicationButton({ vpsId, onCreated }: { vpsId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [detectedProjectNameInput, setDetectedProjectNameInput] = useState("");
  const [daemonEpochInput, setDaemonEpochInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const canSubmit =
    displayNameInput.trim().length > 0 &&
    (detectedProjectNameInput.trim().length === 0
      ? true
      : detectedProjectNameInput.trim().length > 0 && daemonEpochInput.trim().length > 0);

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createVpsComposeApplication(vpsId, {
        displayName: displayNameInput.trim(),
        ...(detectedProjectNameInput.trim()
          ? {
              detectedProjectName: detectedProjectNameInput.trim(),
              daemonEpoch: daemonEpochInput.trim(),
            }
          : {}),
        confirmation: { confirmed: true },
        idempotencyKey: crypto.randomUUID().replace(/-/g, ""),
      });
      setCreated(true);
      setOpen(false);
      setDisplayNameInput("");
      setDetectedProjectNameInput("");
      setDaemonEpochInput("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create application.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setError(null);
          setCreated(false);
          setOpen(true);
        }}
      >
        New application
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create application</AlertDialogTitle>
            <AlertDialogDescription>
              A managed application reserves a new Compose project name
              (generated backend-side). Registering a detected project binds
              an existing project alias + epoch; adoption stays a separate
              confirmed step.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <label className="block text-[11px] text-dim" htmlFor={`compose-create-name-${vpsId}`}>
              Display name
            </label>
            <Input
              id={`compose-create-name-${vpsId}`}
              value={displayNameInput}
              onChange={(event) => setDisplayNameInput(event.target.value)}
              disabled={busy}
              className="h-9"
            />
            <label className="block text-[11px] text-dim" htmlFor={`compose-create-project-${vpsId}`}>
              Detected project name (optional)
            </label>
            <Input
              id={`compose-create-project-${vpsId}`}
              value={detectedProjectNameInput}
              onChange={(event) => setDetectedProjectNameInput(event.target.value)}
              disabled={busy}
              className="h-9"
              placeholder="com.docker.compose.project value from the inventory"
            />
            <label className="block text-[11px] text-dim" htmlFor={`compose-create-epoch-${vpsId}`}>
              Daemon epoch (required with project name)
            </label>
            <Input
              id={`compose-create-epoch-${vpsId}`}
              value={daemonEpochInput}
              onChange={(event) => setDaemonEpochInput(event.target.value)}
              disabled={busy}
              className="h-9"
            />
            {error ? (
              <p role="alert" className="text-[11px] text-crit">{error}</p>
            ) : null}
            {created ? (
              <p role="status" className="text-[11px] text-signal">
                Application created; refresh the list to see the row.
              </p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !canSubmit}
              onClick={() => void submit()}
            >
              {busy ? "Creating…" : "Create"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
