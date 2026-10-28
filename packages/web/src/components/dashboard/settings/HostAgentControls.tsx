import { useContext, useState } from "react";
import { DownloadCloud, KeyRound, RotateCw, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { DashboardContext } from "../../../context/DashboardContext";
import { AgentLifecycleStatus, agentJobFor } from "../servers/AgentLifecycleStatus";
import { vpsDisplayName } from "../../../lib/dashboard-formatters";

/** Host-scoped SSH key and monitoring-agent lifecycle actions. */
export function HostAgentControls({ vpsId }: { vpsId: string }) {
  const dashboard = useContext(DashboardContext);
  const [confirm, setConfirm] = useState<"key" | "install" | "uninstall" | "restart" | null>(null);

  if (!dashboard) return null;
  const vps = dashboard.records.find((record) => record.id === vpsId);
  if (!vps) return null;

  const isLocalHost = vps.kind === "local" || vps.managedBy === "system";
  const keyReady = isLocalHost || Boolean(vps.keyProvisionedAt);
  const agentStatus = vps.agentStatus ?? "not_installed";
  const job = agentJobFor(vps, dashboard.jobs);
  const lifecycleActive = agentStatus === "installing" || Boolean(job && (job.status === "queued" || job.status === "running"));
  const disabled = dashboard.busy || dashboard.mode === "demo" || lifecycleActive;
  const canInstall = keyReady && !isLocalHost && (agentStatus === "not_installed" || agentStatus === "failed");
  const canUninstall = keyReady && !isLocalHost && (agentStatus === "online" || agentStatus === "offline" || agentStatus === "failed");
  const canRestart = keyReady && !isLocalHost && (agentStatus === "offline" || agentStatus === "failed");
  const password = dashboard.provisionPasswords?.[vps.id] ?? "";
  const displayName = vpsDisplayName(vps);
  const actionDisabled = disabled || !password.trim();

  const runConfirmed = () => {
    const action = confirm;
    setConfirm(null);
    if (action === "key") dashboard.onProvision(vps);
    if (action === "install") dashboard.onInstallAgent(vps);
    if (action === "uninstall") dashboard.onUninstallAgent(vps);
    if (action === "restart") dashboard.onRestartAgent(vps);
  };

  return (
    <section aria-label="Agent updates" data-testid="host-agent-controls" className="border border-line bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">Agent updates</h3>
          <p className="mt-1 text-xs text-dim">SSH access and the monitoring agent for this host.</p>
        </div>
        <AgentLifecycleStatus vps={vps} jobs={dashboard.jobs} />
      </div>

      {!isLocalHost && !keyReady ? (
        <div className="space-y-3 border-b border-line p-4">
          <div>
            <h4 className="text-sm font-medium text-text">Install SSH key</h4>
            <p className="mt-1 text-xs leading-5 text-dim">Enter the one-time VPS password to install the dashboard key. The password is used once and never stored.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Label className="min-w-0 flex-1">
              One-time password
              <Input
                data-testid="agent-provision-password"
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                placeholder="Used once to install the key"
                value={password}
                disabled={disabled}
                onChange={(event) => dashboard.onPasswordChange(vps.id, event.target.value)}
              />
            </Label>
            <Button type="button" data-testid="install-ssh-key" disabled={actionDisabled} onClick={() => setConfirm("key")}>
              <KeyRound size={16} aria-hidden="true" />
              Install key
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 p-4">
        {canInstall ? (
          <Button type="button" data-testid="install-agent" disabled={disabled} onClick={() => setConfirm("install")}>
            <DownloadCloud size={16} aria-hidden="true" />
            {agentStatus === "failed" ? "Retry install" : "Install agent"}
          </Button>
        ) : null}
        {canRestart ? (
          <Button type="button" variant="outline" data-testid="restart-agent" disabled={disabled} onClick={() => setConfirm("restart")}>
            <RotateCw size={16} aria-hidden="true" />
            Restart agent
          </Button>
        ) : null}
        {canUninstall ? (
          <Button type="button" variant="outline" data-testid="uninstall-agent" disabled={disabled} onClick={() => setConfirm("uninstall")}>
            <Trash2 size={16} aria-hidden="true" />
            Uninstall agent
          </Button>
        ) : null}
        {isLocalHost ? <p className="text-xs text-dim">The local agent is managed by the dashboard.</p> : null}
        {!isLocalHost && keyReady && !canInstall && !canUninstall && !canRestart && !lifecycleActive ? (
          <p className="text-xs text-dim">No agent action is available in the current state.</p>
        ) : null}
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "key" ? "Install SSH key?" : confirm === "install" ? (agentStatus === "failed" ? "Retry agent install?" : "Install agent?") : confirm === "restart" ? `Restart agent on ${displayName}?` : `Uninstall agent from ${displayName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "key"
                ? `This will connect to ${displayName} with the one-time password and install SSH access. The password will not be stored.`
                : confirm === "install"
                  ? `This will install the monitoring agent on ${displayName}.`
                  : confirm === "restart"
                    ? "This restarts the monitoring agent only. It does not reboot the VPS."
                    : "Monitoring from this agent will stop. The server record and SSH access stay in place."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={disabled} onClick={runConfirmed}>
              {confirm === "key" ? "Install key" : confirm === "install" ? (agentStatus === "failed" ? "Retry install" : "Install agent") : confirm === "restart" ? "Restart agent" : "Uninstall agent"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
