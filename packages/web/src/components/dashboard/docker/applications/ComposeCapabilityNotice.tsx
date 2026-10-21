/**
 * Compose applications capability gate notice.
 *
 * Explains exactly which layer blocks applications: feature gate, runtime,
 * agent reach, inventory completeness, or demo mode. Provides explicit,
 * separately confirmed runtime preparation when Compose v2 plugin is missing.
 */

import { useState, useEffect } from "react";
import {
  type ComposeCapability,
  requestComposeRuntimePreparation,
  getVpsComposeOperation,
  composeOperationIsActive,
} from "../../../../lib/compose-applications";
import { EmptyState } from "../../shared/EmptyState";
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
  AlertDialogTrigger,
} from "../../../ui/alert-dialog";

export function ComposeCapabilityNotice({
  vpsId,
  capability,
  loading,
  error,
  onRetry,
}: {
  vpsId?: string;
  capability: ComposeCapability | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [prepBusy, setPrepBusy] = useState(false);
  const [prepOpId, setPrepOpId] = useState<string | null>(null);
  const [prepResult, setPrepResult] = useState<string | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);

  useEffect(() => {
    if (!prepOpId || !vpsId) return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const op = await getVpsComposeOperation(vpsId, prepOpId);
        if (cancelled) return;
        if (!composeOperationIsActive(op.status)) {
          clearInterval(interval);
          setPrepOpId(null);
          setPrepBusy(false);
          if (op.status === "succeeded") {
            if (op.result?.installPerformed === false) {
              setPrepResult("Host already has a trusted compatible Compose runtime; no installation was needed.");
            } else {
              setPrepResult("Official Docker Compose v2.40.3 installed successfully.");
            }
            onRetry();
          } else {
            if (op.error?.code === "docker_cli_missing") {
              setPrepError("Docker CLI is missing on the host. Please install docker-ce-cli via your distribution package manager first.");
            } else {
              setPrepError(op.error?.message ?? "Runtime preparation failed.");
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          clearInterval(interval);
          setPrepOpId(null);
          setPrepBusy(false);
          setPrepError(err instanceof Error ? err.message : "Unable to verify runtime preparation progress.");
        }
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [prepOpId, vpsId, onRetry]);

  async function handleStartRuntimePreparation() {
    if (!vpsId || prepBusy) return;
    setPrepBusy(true);
    setPrepResult(null);
    setPrepError(null);
    try {
      const op = await requestComposeRuntimePreparation(vpsId);
      if (composeOperationIsActive(op.status)) {
        setPrepOpId(op.id);
      } else if (op.status === "succeeded") {
        setPrepBusy(false);
        if (op.result?.installPerformed === false) {
          setPrepResult("Host already has a trusted compatible Compose runtime; no installation was needed.");
        } else {
          setPrepResult("Official Docker Compose v2.40.3 installed successfully.");
        }
        onRetry();
      } else {
        setPrepBusy(false);
        if (op.error?.code === "docker_cli_missing") {
          setPrepError("Docker CLI is missing on the host. Please install docker-ce-cli via your distribution package manager first.");
        } else {
          setPrepError(op.error?.message ?? "Runtime preparation failed.");
        }
      }
    } catch (err) {
      setPrepBusy(false);
      setPrepError(err instanceof Error ? err.message : "Unable to request runtime preparation.");
    }
  }

  if (loading) {
    return (
      <div className="border border-line bg-panel p-4" role="status">
        <p className="text-[13px] text-dim">Checking Compose capability…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-line bg-panel p-4" role="alert">
        <p className="text-[13px] text-text">
          Compose capability status is unknown right now.
        </p>
        <p className="mt-1 text-[12px] text-dim">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex min-h-9 items-center border border-line px-3 text-[13px] text-text hover:border-dim hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          Retry capability check
        </button>
      </div>
    );
  }

  if (!capability) return null;

  if (capability.demoDisabled) {
    return (
      <div className="border border-line bg-panel p-4" role="status">
        <p className="text-[13px] font-medium text-text">
          Compose applications are disabled in demo mode.
        </p>
        <p className="mt-1 text-[12px] text-dim">
          Demo servers are simulated; no real Compose inspection or control is
          performed against them.
        </p>
      </div>
    );
  }

  // Any capability gap whose only realistic remedy is host-side runtime work
  // (plugin missing, Docker CLI absent, reported runtime/compose reason) gets
  // the explicit, separately confirmed preparation entry point.
  const reasonText = (capability.reason ?? "").toLowerCase();
  const needsRuntimePrep =
    !capability.runtime.composeVersion ||
    !capability.runtime.dockerPresent ||
    reasonText.includes("runtime") ||
    reasonText.includes("compose") ||
    reasonText.includes("docker");

  if (!capability.supported) {
    return (
      <div className="space-y-3">
        <EmptyState>
          <p className="font-medium text-text">Compose applications are unavailable.</p>
          {capability.reason ? (
            <p className="mt-1 text-[12px]">{capability.reason}</p>
          ) : null}
          <p className="mt-1 text-[12px]">
            Runtime: {capability.runtime.dockerPresent ? "Docker present" : "Docker not reported"}
            {capability.runtime.composeVersion ? ` · Compose ${capability.runtime.composeVersion}` : " · Compose v2 plugin not installed"}.
          </p>
          {capability.inventory.completeness === false && capability.inventory.reason ? (
            <p className="mt-1 text-[12px]">Inventory: {capability.inventory.reason}</p>
          ) : null}
        </EmptyState>

        {vpsId && needsRuntimePrep ? (
          <div className="border border-line bg-panel p-4 space-y-2">
            <h4 className="text-[13px] font-semibold text-text">Docker Compose runtime preparation</h4>
            <p className="text-[12px] text-dim">
              The official Docker Compose v2 plugin can be installed or prepared into an isolated FlexServer directory on the host without modifying system packages.
            </p>
            {prepResult ? (
              <p role="status" className="text-[12px] text-signal font-medium">{prepResult}</p>
            ) : null}
            {prepError ? (
              <p role="alert" className="text-[12px] text-crit font-medium">{prepError}</p>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={prepBusy}
                >
                  {prepBusy ? "Preparing runtime…" : "Prepare Docker Compose runtime"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Prepare Docker Compose runtime</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will install or verify the official Docker Compose v2 plugin into an isolated FlexServer directory (/usr/local/lib/flexserver/compose) on the host. It will not modify your existing system package manager or Docker Engine.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={prepBusy}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={prepBusy}
                    onClick={() => void handleStartRuntimePreparation()}
                  >
                    Confirm preparation
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
      </div>
    );
  }

  if (capability.gate?.disabled) {
    return (
      <div className="border border-line bg-panel p-4" role="status">
        <p className="text-[13px] font-medium text-text">
          Compose control is disabled for this server.
        </p>
        {capability.gate.reason ? (
          <p className="mt-1 text-[12px] text-dim">{capability.gate.reason}</p>
        ) : (
          <p className="mt-1 text-[12px] text-dim">
            Enable Compose management in server settings to allow stack operations.
          </p>
        )}
      </div>
    );
  }

  if (!capability.admission.ready && capability.admission.reasons.length > 0) {
    return (
      <div className="border border-line bg-panel p-4" role="status">
        <p className="text-[13px] font-medium text-text">
          New operations are blocked until these clear:
        </p>
        <ul className="mt-1 list-disc pl-5 text-[12px] text-dim">
          {capability.admission.reasons.map((reason, index) => (
            <li key={`${reason}-${index}`}>{reason}</li>
          ))}
        </ul>
      </div>
    );
  }

  return null;
}

export function ComposeInventoryIncompleteNote({
  capability,
}: {
  capability: ComposeCapability | null;
}) {
  if (!capability || capability.inventory.completeness !== false) return null;
  return (
    <p className="text-[11px] text-warn">
      Inventory incomplete: {capability.inventory.reason ?? "the agent could not read every project"}.
      Service and replica rows may be partial; state shown is what was reported.
    </p>
  );
}
