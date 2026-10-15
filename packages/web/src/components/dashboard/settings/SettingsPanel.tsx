import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  Info,
  Loader2,
  Lock,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { Button } from "../../ui/button";
import type { DashboardOverview } from "../../../lib/api";
import { useDashboard } from "../../../context/DashboardContext";

function RuntimeFact({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn";
}) {
  const toneClass =
    tone === "ok"
      ? "text-signal"
      : tone === "warn"
        ? "text-warn"
        : "text-text";
  return (
    <div className="bg-panel p-4 transition-colors duration-160 ease-out hover:bg-raised/40">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dim">
        {label}
      </dt>
      <dd className={`tnum mt-1 font-mono text-[13px] font-medium ${toneClass}`}>{value}</dd>
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
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12 xl:gap-6 xl:items-start">
      {/* Main column: Terminal & safety panel + Agent updates slot */}
      <div className="space-y-4 xl:col-span-8">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b border-line p-4 pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle>Terminal &amp; safety</CardTitle>
                <span className="border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-dim">
                  Global
                </span>
              </div>
            </div>
            <CardDescription className="mt-0.5">
              Runtime console access and client-side accidental execution guard.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-line p-0">
            {/* Web terminal row */}
            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <TerminalSquare
                      size={16}
                      className="shrink-0 text-dim"
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-text">Web terminal</h3>
                  </div>
                  <p className="mt-1 text-xs text-dim">
                    Interactive browser terminal access for system-managed local host and remote VPS targets.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={enabled ? "secondary" : "outline"}
                  className="h-8 rounded-none px-3 text-xs"
                  disabled={pending}
                  aria-pressed={enabled}
                  aria-label={
                    enabled ? "Disable web terminal" : "Enable web terminal"
                  }
                  data-testid="web-terminal-toggle"
                  onClick={handleToggle}
                >
                  {pending ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                      <span>Updating…</span>
                    </span>
                  ) : enabled ? (
                    "Disable"
                  ) : (
                    "Enable"
                  )}
                </Button>
              </div>
              {error ? (
                <div
                  role="alert"
                  className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"
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

            {/* Dangerous command guard row */}
            <div className="p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <ShieldAlert
                      size={16}
                      className="shrink-0 text-dim"
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-text">
                      Dangerous command guard
                    </h3>
                  </div>
                  <p className="mt-1 text-xs text-dim">
                    Client-side typing safety net intercepting high-impact accidental commands.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={guardEnabled ? "secondary" : "outline"}
                  className="h-8 rounded-none px-3 text-xs"
                  disabled={guardPending}
                  aria-pressed={guardEnabled}
                  aria-label={
                    guardEnabled
                      ? "Disable terminal command guard"
                      : "Enable terminal command guard"
                  }
                  data-testid="terminal-command-guard-toggle"
                  onClick={handleGuardToggle}
                >
                  {guardPending ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                      <span>Updating…</span>
                    </span>
                  ) : guardEnabled ? (
                    "Disable"
                  ) : (
                    "Enable"
                  )}
                </Button>
              </div>
              {guardError ? (
                <div
                  role="alert"
                  className="flex items-start gap-2 border border-crit/40 bg-crit/10 p-3 text-[13px] text-crit"
                >
                  <AlertCircle
                    size={16}
                    className="mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{guardError}</span>
                </div>
              ) : null}
            </div>

            {/* Always-visible warning: root sessions & guard boundary */}
            <div className="p-4 bg-raised/20">
              <div className="flex items-start gap-2.5 border border-warn/30 bg-warn/5 p-3 text-xs leading-5 text-dim">
                <AlertTriangle
                  size={15}
                  className="mt-0.5 shrink-0 text-warn"
                  aria-hidden="true"
                />
                <div>
                  <strong className="font-semibold text-text">
                    Root session notice:
                  </strong>{" "}
                  Terminal sessions run as root on the host or remote VPS. This guard is an
                  accidental typing safety net, not a security boundary or privilege-dropping sandbox.
                </div>
              </div>
            </div>

            {/* Native details/summary: How it works & limitations */}
            <div className="p-4 pt-3">
              <details className="group border border-line bg-raised/20 text-xs">
                <summary className="flex cursor-pointer select-none items-center justify-between p-3 font-medium text-text transition-colors duration-160 hover:bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2">
                    <Info
                      size={14}
                      className="text-dim group-open:text-signal"
                      aria-hidden="true"
                    />
                    <span>How it works &amp; limitations</span>
                  </span>
                  <ChevronDown
                    size={14}
                    className="text-dim transition-transform duration-160 group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <div className="space-y-3 border-t border-line p-3 text-dim leading-relaxed">
                  <div>
                    <h4 className="font-semibold text-text">Connection behavior</h4>
                    <p className="mt-0.5">
                      When enabled, authorized users can open terminal sessions from the Terminal tab. Remote servers require real SSH keys, while the system-managed local server connects directly to the hosting host.
                    </p>
                  </div>
                  <div>
                    <h4 className="font-semibold text-text">Accidental command checks</h4>
                    <p className="mt-0.5">
                      When enabled, the terminal checks interactive keyboard input and clipboard paste for high-impact accidental commands (such as recursive deletion of root/system directories like <code className="font-mono text-text">rm -rf /</code>, filesystem formatting with <code className="font-mono text-text">mkfs</code>, raw device writes with <code className="font-mono text-text">dd</code>, system shutdown/reboot, and recursive permission destruction). Detected commands are cancelled before execution.
                    </p>
                  </div>
                  <div>
                    <h4 className="font-semibold text-text">Input caveats &amp; uninspected inputs</h4>
                    <p className="mt-0.5">
                      The guard cannot inspect commands recalled from shell history (arrow keys), custom aliases, scripts, or fullscreen terminal applications (such as <code className="font-mono text-text">vim</code> or <code className="font-mono text-text">htop</code>).
                    </p>
                  </div>
                </div>
              </details>
            </div>
          </CardContent>
        </Card>

        {/* Agent updates (host-specific separate panel below main) */}
        {children ? <div className="space-y-4">{children}</div> : null}
      </div>

      {/* Side column: Runtime facts + Dashboard access */}
      <div className="space-y-4 xl:col-span-4">
        {/* Runtime key-value facts */}
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b border-line p-4 pb-3">
            <CardTitle>Runtime posture</CardTitle>
            <CardDescription className="mt-0.5">
              Host environment and platform capabilities.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <dl className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 xl:grid-cols-1">
              <RuntimeFact label="App mode" value={overview.settings.appMode} />
              <RuntimeFact
                label="Real SSH"
                value={overview.settings.realSshEnabled ? "enabled" : "disabled"}
                tone={overview.settings.realSshEnabled ? "ok" : "warn"}
              />
              <RuntimeFact
                label="Local auth"
                value={
                  overview.settings.authRequiredInLocalMode ? "required" : "off"
                }
                tone={
                  overview.settings.authRequiredInLocalMode ? "ok" : "warn"
                }
              />
            </dl>
          </CardContent>
        </Card>

        {/* Dashboard access collapsed informational section */}
        <Card className="min-w-0 overflow-hidden">
          <details className="group">
            <summary className="flex cursor-pointer select-none items-center justify-between p-4 font-semibold text-text transition-colors duration-160 hover:bg-raised/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal list-none [&::-webkit-details-marker]:hidden">
              <div className="min-w-0 pr-2">
                <div className="flex items-center gap-2">
                  <Lock size={15} className="shrink-0 text-dim" aria-hidden="true" />
                  <span className="text-sm">Dashboard access</span>
                </div>
                <p className="mt-0.5 text-xs font-normal text-dim truncate">
                  Session credentials &amp; authentication
                </p>
              </div>
              <ChevronDown
                size={16}
                className="shrink-0 text-dim transition-transform duration-160 group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="border-t border-line bg-raised/10 p-4 text-xs leading-relaxed text-dim space-y-2">
              <p>
                Local mode uses a secure HttpOnly cookie session. Dashboard
                passwords are verified server-side against stored credentials
                and are never saved in browser storage.
              </p>
              <p>
                Use the account menu in the top bar to log out and revoke the
                current session.
              </p>
            </div>
          </details>
        </Card>
      </div>
    </div>
  );
}
