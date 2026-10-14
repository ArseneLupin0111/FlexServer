import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Edit3, KeyRound, MoreHorizontal, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import {
  serverStatusLabel,
  vpsDisplayName,
  vpsHostId,
} from "../../../lib/dashboard-formatters";
import type { VpsRecord } from "../../../lib/api";
import type { DashboardJob } from "../../../lib/api";
import { AgentLifecycleStatus, agentJobFor, localAgentLabel } from "./AgentLifecycleStatus";
import { LocalAgentUpdate } from "./LocalAgentUpdate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

export function ServerTable({
  vpsList,
  busy,
  provisionPasswords,
  onProvision,
  onVerify,
  onInstallAgent,
  onUninstallAgent,
  onUpgradeAgent,
  onRestartAgent,
  onRotateAgent,
  jobs,
  onDelete,
  mode,
  onEdit,
}: {
  vpsList: VpsRecord[];
  busy: boolean;
  provisionPasswords: Record<string, string>;
  onProvision: (vps: VpsRecord) => void;
  onVerify: (vps: VpsRecord) => void;
  onInstallAgent: (vps: VpsRecord) => void;
  onUninstallAgent: (vps: VpsRecord) => void;
  onUpgradeAgent: (vps: VpsRecord) => void;
  onRestartAgent: (vps: VpsRecord) => void;
  onRotateAgent: (vps: VpsRecord) => void;
  jobs: DashboardJob[];
  onDelete: (vps: VpsRecord) => void;
  mode: "demo" | "local";
  onEdit: (vps: VpsRecord) => void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<VpsRecord | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<VpsRecord | null>(null);
  const [upgradeTarget, setUpgradeTarget] = useState<VpsRecord | null>(null);
  const [restartTarget, setRestartTarget] = useState<VpsRecord | null>(null);
  const [rotateAgentTarget, setRotateAgentTarget] = useState<VpsRecord | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  function handleDeleteClick(vps: VpsRecord) {
    const isLocalHost = vps.kind === "local" || vps.managedBy === "system";
    if (isLocalHost) return;
    setDeleteTarget(vps);
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.14em] text-dim">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Host</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Host status</th>
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Access</th>
              <th className="px-4 py-3 font-medium">Last seen</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {vpsList.map((vps) => {
              const displayName = vpsDisplayName(vps);
              const hostId = vpsHostId(vps);
              const isLocal =
                vps.kind === "local" || vps.managedBy === "system";
              const isReady = isLocal || Boolean(vps.keyProvisionedAt);
              const serverJobs = jobs.filter((job) => job.vpsId === vps.id);
              const agentJob = agentJobFor(vps, serverJobs);
              const agentActionRunning = Boolean(agentJob && (agentJob.status === "queued" || agentJob.status === "running"));
              const canUninstall = vps.agentStatus === "online" || vps.agentStatus === "offline" || vps.agentStatus === "failed";
              const canUpgrade = mode !== "demo" && !isLocal && !agentActionRunning && canUninstall;
              const canRestart = mode !== "demo" && !isLocal && Boolean(vps.keyProvisionedAt) && !agentActionRunning && (vps.agentStatus === "offline" || vps.agentStatus === "failed");
              const canRotateAgent = mode !== "demo" && isLocal && !agentActionRunning;
              const accessProblem = !isLocal && (!vps.keyProvisionedAt || vps.status === "unreachable");
              // Local rows mirror the card lifecycle: when the persisted
              // lifecycle row is missing/stale, derive online/offline from the
              // observed local heartbeat instead of the "Unknown" placeholder.
              // Remote rows keep their existing labels untouched.
              const agentLabel =
                vps.agentStatus === "online" ? "Online"
                : vps.agentStatus === "offline" ? "Offline"
                : vps.agentStatus === "failed" ? "Failed"
                : !isLocal ? "Not installed"
                : localAgentLabel(vps.lastSeenAt);
              const agentTone =
                agentLabel === "Online" ? "green"
                : agentLabel === "Failed" ? "red"
                : agentLabel === "Offline" ? "amber"
                : "neutral";
              return (
                <tr
                  key={vps.id}
                  aria-label={`Server ${displayName}`}
                  className="border-b border-line transition-colors duration-160 ease-out hover:bg-raised/40"
                >
                  <td className="px-4 py-3">
                    <Link
                      to={`/vps/${encodeURIComponent(vps.id)}`}
                      className="font-medium text-text transition-colors hover:text-signal"
                      title={hostId ? `Host ID: ${hostId}` : undefined}
                    >
                      {displayName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="tnum block max-w-52 truncate font-mono text-text" title={`${vps.host}:${vps.port}`}>{vps.host}:{vps.port}</span>
                    <span className="mt-0.5 block text-[12px] text-dim">{vps.username}</span>
                  </td>
                  <td className="px-4 py-3 text-dim">
                    <span className="block max-w-40 truncate" title={[vps.city, vps.country].filter(Boolean).join(", ") || "Location not detected"}>
                      {[vps.city, vps.country].filter(Boolean).join(", ") || "Location not detected"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <TableStatus kind="host" label={serverStatusLabel(vps.status)} tone={vps.status === "healthy" ? "green" : vps.status === "warning" ? "amber" : vps.status === "unreachable" ? "red" : "neutral"} />
                  </td>
                  <td className="px-4 py-3">
                    {agentActionRunning ? <AgentLifecycleStatus vps={vps} jobs={serverJobs} compact /> : <TableStatus kind="agent" label={agentLabel} tone={agentTone} />}
                    {isLocal ? <div className="mt-1"><LocalAgentUpdate vps={vps} variant="table" /></div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={isReady ? "ready" : "pending"}>
                      {isLocal ? "Local" : isReady ? "Key ready" : "Needs password"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-dim">
                    <span title={exactTimestamp(vps.lastSeenAt)}>{relativeTime(vps.lastSeenAt, now)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link to={`/vps/${encodeURIComponent(vps.id)}`}>
                        <Button
                          type="button"
                          aria-label={`Manage ${displayName}`}
                          size="sm"
                          variant="default"
                          className="text-[11px]"
                        >
                          Manage
                        </Button>
                      </Link>
                      {accessProblem ? <Button
                        type="button"
                        aria-label={`Verify access for ${displayName}`}
                        size="sm"
                        variant="outline"
                        className="text-[11px]"
                        disabled={busy || isLocal}
                        onClick={() => onVerify(vps)}
                      >
                        <ShieldCheck size={13} />
                        Verify access
                      </Button> : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" size="sm" variant="outline" aria-label={`More actions for ${displayName}`}>
                            <MoreHorizontal size={13} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48 rounded-none">
                          {!accessProblem ? <DropdownMenuItem disabled={busy || isLocal} onClick={() => onVerify(vps)}><ShieldCheck size={14} /> Verify access</DropdownMenuItem> : null}
                          {isLocal ? null : <DropdownMenuItem disabled={busy || !canUpgrade} onClick={() => window.setTimeout(() => setUpgradeTarget(vps), 0)}><RotateCw size={14} /> Upgrade agent</DropdownMenuItem>}
                          {canRestart ? <DropdownMenuItem disabled={busy} onClick={() => window.setTimeout(() => setRestartTarget(vps), 0)}><RotateCw size={14} /> Restart agent</DropdownMenuItem> : null}
                          {isLocal ? <DropdownMenuItem disabled={busy || !canRotateAgent} onClick={() => window.setTimeout(() => setRotateAgentTarget(vps), 0)}><KeyRound size={14} /> Rotate agent credential</DropdownMenuItem> : null}
                          <DropdownMenuItem disabled={busy || isLocal || !provisionPasswords[vps.id]?.trim()} onClick={() => onProvision(vps)}><KeyRound size={14} /> Reinstall SSH key</DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={busy || isLocal || mode === "demo"}
                            onClick={() => window.setTimeout(() => onEdit(vps), 0)}
                            title={mode === "demo" ? "Editing is unavailable in demo mode." : isLocal ? "Local servers are managed by the system." : undefined}
                            aria-label={`Edit server${mode === "demo" ? ": unavailable in demo mode" : isLocal ? ": local servers are system managed" : ""}`}
                          >
                            <Edit3 size={14} /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={busy || isLocal}
                            onClick={() => window.setTimeout(() => handleDeleteClick(vps), 0)}
                          >
                            <Trash2 size={14} /> Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Delete confirmation dialog (single instance for table) */}
      <AlertDialog open={upgradeTarget !== null} onOpenChange={(open) => { if (!open) setUpgradeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Upgrade agent on {upgradeTarget ? vpsDisplayName(upgradeTarget) : "server"}?</AlertDialogTitle><AlertDialogDescription>Monitoring will pause briefly while the agent is upgraded. If the upgrade cannot complete, the previous version is restored automatically. Existing credentials are preserved and are not changed or stored again.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { if (upgradeTarget) onUpgradeAgent(upgradeTarget); setUpgradeTarget(null); }}>Upgrade agent</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={restartTarget !== null} onOpenChange={(open) => { if (!open) setRestartTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Restart agent on {restartTarget ? vpsDisplayName(restartTarget) : "server"}?</AlertDialogTitle><AlertDialogDescription>This restarts the monitoring agent only. It does not reboot the VPS.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (restartTarget && !busy) onRestartAgent(restartTarget); setRestartTarget(null); }}>Restart agent</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={rotateAgentTarget !== null} onOpenChange={(open) => { if (!open) setRotateAgentTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Rotate agent credential on {rotateAgentTarget ? vpsDisplayName(rotateAgentTarget) : "server"}?</AlertDialogTitle><AlertDialogDescription>The agent credential is replaced without exposing the token. The agent reconnects automatically.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { if (rotateAgentTarget && !busy) onRotateAgent(rotateAgentTarget); setRotateAgentTarget(null); }}>Rotate credential</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget ? vpsDisplayName(deleteTarget) : "server"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `This permanently removes the server record for ${deleteTarget.username}@${deleteTarget.host}:${deleteTarget.port}. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) onDelete(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Delete server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={uninstallTarget !== null} onOpenChange={(open) => { if (!open) setUninstallTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall agent from {uninstallTarget ? vpsDisplayName(uninstallTarget) : "server"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Monitoring from this agent will stop. The server record and SSH access stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (uninstallTarget) onUninstallAgent(uninstallTarget);
                setUninstallTarget(null);
              }}
            >Uninstall agent</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TableStatus({ kind, label, tone }: { kind: "host" | "agent"; label: string; tone: "green" | "amber" | "red" | "neutral" }) {
  const dot = tone === "green" ? "bg-signal" : tone === "amber" ? "bg-warn" : tone === "red" ? "bg-crit" : "bg-dim";
  const text = tone === "green" ? "text-signal" : tone === "amber" ? "text-warn" : tone === "red" ? "text-crit" : "text-dim";
  return <span className={`inline-flex items-center gap-1.5 text-[12px] ${text}`} aria-label={`${kind === "host" ? "Host" : "Agent"} status: ${label}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} /><span aria-hidden="true">{label}</span></span>;
}

export function relativeTime(value: string | undefined, now: number) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function exactTimestamp(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "No last seen timestamp";
  return `Last seen: ${new Date(value).toLocaleString()}`;
}
