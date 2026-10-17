import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  Info,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { Switch } from "../../ui/switch";
import type { DashboardOverview } from "../../../lib/api";
import { useDashboard } from "../../../context/DashboardContext";

/**
 * Global terminal settings in the workspace Settings tab.
 *
 * Two global toggles (web terminal, command guard) carry the actions; the
 * always-visible root-session warning keeps the safety boundary explicit and
 * the technical caveats stay in a native disclosure. Host-specific agent
 * update controls arrive as children and render directly below.
 */
function ToggleRow({
  icon,
  title,
  description,
  actionLabel,
  enabled,
  pending,
  testId,
  onToggle,
  error,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  /** Names the setting for the accessible action label, e.g. "web terminal". */
  actionLabel: string;
  enabled: boolean;
  pending: boolean;
  testId: string;
  onToggle: () => void;
  error: string | null;
}) {
  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text">{title}</h3>
            <p className="mt-0.5 text-xs text-dim">{description}</p>
          </div>
        </div>
        <Switch
          checked={enabled}
          pending={pending}
          aria-label={`${enabled ? "Disable" : "Enable"} ${actionLabel}`}
          data-testid={testId}
          onCheckedChange={onToggle}
        />
      </div>
      {error ? (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"
        >
          <AlertCircle
            size={16}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsPanel({
  overview,
  children,
}: {
  overview: DashboardOverview;
  children?: ReactNode;
}) {
  const dashboard = useDashboard();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardPending, setGuardPending] = useState(false);
  const [guardError, setGuardError] = useState<string | null>(null);

  const enabled = overview.settings.webTerminalEnabled;
  const guardEnabled = overview.settings.terminalCommandGuardEnabled;

  const handleToggle = async () => {
    if (pending) return;
    const next = !enabled;
    setPending(true);
    setError(null);
    try {
      await dashboard.onUpdateSettings({
        webTerminalEnabled: next,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to update web terminal setting.";
      setError(message);
    } finally {
      setPending(false);
    }
  };

  const handleGuardToggle = async () => {
    if (guardPending) return;
    const next = !guardEnabled;
    setGuardPending(true);
    setGuardError(null);
    try {
      await dashboard.onUpdateSettings({
        terminalCommandGuardEnabled: next,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to update command guard setting.";
      setGuardError(message);
    } finally {
      setGuardPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b border-line p-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Terminal &amp; safety</CardTitle>
            <span className="border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-dim">
              All hosts
            </span>
          </div>
        </CardHeader>
        <CardContent className="divide-y divide-line p-0">
          <ToggleRow
            icon={
              <TerminalSquare
                size={16}
                className="shrink-0 text-dim"
                aria-hidden="true"
              />
            }
            title="Web terminal"
            description="Interactive terminal sessions from the Terminal tab."
            actionLabel="web terminal"
            enabled={enabled}
            pending={pending}
            testId="web-terminal-toggle"
            onToggle={() => void handleToggle()}
            error={error}
          />

          <ToggleRow
            icon={
              <ShieldAlert
                size={16}
                className="shrink-0 text-dim"
                aria-hidden="true"
              />
            }
            title="Dangerous command guard"
            description="Cancels accidental high-impact commands before they run."
            actionLabel="terminal command guard"
            enabled={guardEnabled}
            pending={guardPending}
            testId="terminal-command-guard-toggle"
            onToggle={() => void handleGuardToggle()}
            error={guardError}
          />

          {/* Always-visible warning: root sessions & guard boundary */}
          <div className="p-4">
            <div className="flex items-start gap-2.5 border border-warn/30 bg-warn/5 p-3 text-xs leading-5 text-dim">
              <AlertTriangle
                size={15}
                className="mt-0.5 shrink-0 text-warn"
                aria-hidden="true"
              />
              <p>
                <strong className="font-semibold text-text">
                  Root session notice:
                </strong>{" "}
                Terminal sessions run as root on the host or remote VPS. This
                guard is an accidental typing safety net, not a security
                boundary or privilege-dropping sandbox.
              </p>
            </div>
          </div>

          {/* Native details/summary: technical caveats and uninspected inputs */}
          <div className="p-4 pt-3">
            <details className="group border border-line bg-raised/20 text-xs">
              <summary className="flex cursor-pointer select-none items-center justify-between p-3 font-medium text-text transition-colors duration-160 hover:bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                  <Info
                    size={14}
                    className="text-dim group-open:text-signal"
                    aria-hidden="true"
                  />
                  <span>Details &amp; limitations</span>
                </span>
                <ChevronDown
                  size={14}
                  className="text-dim transition-transform duration-160 group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="border-t border-line p-3 leading-relaxed text-dim">
                <ul className="list-disc space-y-1 pl-4">
                  <li>
                    Remote hosts need real SSH keys; the system-managed local
                    host connects directly.
                  </li>
                  <li>
                    The guard checks typed keystrokes and pasted text for
                    high-impact commands — recursive deletion of system
                    directories (<code className="font-mono text-text">rm -rf /</code>
                    ), formatting with <code className="font-mono text-text">mkfs</code>, raw
                    device writes with <code className="font-mono text-text">dd</code>,
                    shutdown/reboot, and recursive permission changes — and
                    cancels them before execution.
                  </li>
                  <li>
                    It cannot inspect shell history recall, aliases, scripts, or
                    fullscreen applications such as{" "}
                    <code className="font-mono text-text">vim</code> or{" "}
                    <code className="font-mono text-text">htop</code>.
                  </li>
                </ul>
              </div>
            </details>
          </div>
        </CardContent>
      </Card>

      {/* Agent updates (host-specific panel directly below the global controls) */}
      {children ? <div className="space-y-4">{children}</div> : null}
    </div>
  );
}
