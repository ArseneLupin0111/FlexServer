import { useEffect, useRef, useState } from "react";
import { FolderOpen, ShieldAlert, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { Switch } from "../../ui/switch";
import { useDashboard } from "../../../context/DashboardContext";
import type { VpsRecord } from "../../../lib/api";
import { getFilesCapabilities, type FilesCapabilities } from "../../../lib/files-api";

export function SftpSettingsCard({ vps }: { vps: VpsRecord }) {
  const dashboard = useDashboard();
  const sftpEnabled = vps.sftpEnabled === true;
  const isLocal = vps.kind === "local" || vps.managedBy === "system";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<FilesCapabilities | null>(null);
  const [loadingCaps, setLoadingCaps] = useState(false);
  const toggleLock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingCaps(true);
    getFilesCapabilities(vps.id)
      .then((caps) => {
        if (!cancelled) setCapabilities(caps);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingCaps(false);
      });

    return () => {
      cancelled = true;
    };
  }, [vps.id, sftpEnabled]);

  async function handleToggle(): Promise<void> {
    if (toggleLock.current || dashboard.busy || dashboard.mode === "demo") return;
    toggleLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await dashboard.onEdit(vps, { sftpEnabled: !sftpEnabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update Files setting");
    } finally {
      toggleLock.current = false;
      setBusy(false);
    }
  }

  const isOnline = capabilities?.available === true;

  return (
    <section
      aria-label="Files & SFTP settings"
      className="mb-4 space-y-3 border border-line bg-panel p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <FolderOpen size={18} className="text-dim" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold text-text">SFTP / Files</h3>
            <p className="mt-0.5 text-xs text-dim">
              Enable guarded filesystem browsing and transfers for this VPS.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {sftpEnabled && (
            <span
              className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] font-medium ${
                isOnline
                  ? "border-signal/40 bg-signal/10 text-signal"
                  : "border-warn/40 bg-warn/10 text-warn"
              }`}
            >
              {isOnline ? (
                <CheckCircle2 size={12} aria-hidden="true" />
              ) : (
                <XCircle size={12} aria-hidden="true" />
              )}
              {isLocal ? "Host filesystem" : "SFTP"}: {loadingCaps ? "checking…" : isOnline ? "available" : "unavailable"}
            </span>
          )}
          <Switch
            checked={sftpEnabled}
            pending={busy}
            aria-label={`${sftpEnabled ? "Disable" : "Enable"} Files access`}
            disabled={dashboard.busy || dashboard.mode === "demo"}
            onCheckedChange={() => void handleToggle()}
          />
        </div>
      </div>

      <div className="rounded border border-line/60 bg-raised/20 p-3 text-xs text-dim">
        <div className="flex items-start gap-2">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium text-text">Filesystem authorization boundary</p>
            <p>
              {isLocal
                ? "Local files use the host-files helper running with root filesystem access. That grants access to system files; disable Files when not in use."
                : `Remote operations use SFTP over SSH as '${vps.username}'. Host-key pinning and key authentication are enforced.`}
            </p>
          </div>
        </div>
      </div>

      {capabilities && !capabilities.available && sftpEnabled && (
        <div className="rounded border border-warn/40 bg-warn/10 p-2.5 text-xs text-warn">
          <p className="font-medium">Transport degraded or unavailable</p>
          <p className="mt-0.5 text-dim">
            {capabilities.reason ||
              (isLocal
                ? "Host files helper is offline. Ensure flexserver-host-files service is active on the host."
                : "Unable to establish SFTP session. Verify SSH credentials and host reachability.")}
          </p>
        </div>
      )}

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-xs text-crit"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}
