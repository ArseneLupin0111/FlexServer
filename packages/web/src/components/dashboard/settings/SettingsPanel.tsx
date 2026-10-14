import { useState } from "react";
import { AlertCircle, Loader2, ShieldAlert, TerminalSquare } from "lucide-react";
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

export function SettingsPanel({ overview }: { overview: DashboardOverview }) {
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
    <div className="grid max-w-3xl gap-4">
      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b border-line p-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Settings</CardTitle>
              <CardDescription className="mt-0.5">
                Runtime safety posture.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <dl className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 xl:grid-cols-5">
            <RuntimeFact label="App mode" value={overview.settings.appMode} />
            <RuntimeFact
              label="Web terminal"
              value={enabled ? "enabled" : "disabled"}
              tone={enabled ? "ok" : "warn"}
            />
            <RuntimeFact
              label="Command guard"
              value={guardEnabled ? "enabled" : "disabled"}
              tone={guardEnabled ? "ok" : "warn"}
            />
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

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b border-line p-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <TerminalSquare
                  size={16}
                  className="shrink-0 text-dim"
                  aria-hidden="true"
                />
                <CardTitle>Web terminal</CardTitle>
              </div>
              <CardDescription className="mt-0.5 max-w-2xl leading-5">
                Interactive browser terminal access for system-managed local host
                and remote VPS targets.
              </CardDescription>
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
        </CardHeader>
        <CardContent className="space-y-3 p-4">
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
          <p className="text-[13px] leading-6 text-dim">
            When enabled, authorized users can open terminal sessions from the
            Terminal tab. Remote servers require real SSH keys, while the
            system-managed local server connects directly to the hosting host.
          </p>
        </CardContent>
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b border-line p-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <ShieldAlert
                  size={16}
                  className="shrink-0 text-dim"
                  aria-hidden="true"
                />
                <CardTitle>Dangerous command guard</CardTitle>
              </div>
              <CardDescription className="mt-0.5 max-w-2xl leading-5">
                Client-side accidental command guard for web terminal sessions.
              </CardDescription>
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
        </CardHeader>
        <CardContent className="space-y-3 p-4">
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
          <p className="text-[13px] leading-6 text-dim">
            When enabled, the terminal checks interactive keyboard input and
            clipboard paste for high-impact accidental commands (such as recursive
            deletion of root/system directories like{" "}
            <code className="font-mono text-text">rm -rf /</code>, filesystem
            formatting with <code className="font-mono text-text">mkfs</code>, raw
            device writes with <code className="font-mono text-text">dd</code>,
            system shutdown/reboot, and recursive permission destruction).
            Detected commands are cancelled before execution.
          </p>
          <div className="border border-line bg-panel p-3 text-[12px] leading-5 text-dim space-y-1">
            <p>
              <strong className="text-text">Root privileges remain unchanged:</strong> This
              guard is an accidental typing safety net, not a security boundary or
              privilege-dropping sandbox. Terminal sessions continue to run as root on the
              host or remote VPS.
            </p>
            <p>
              <strong className="text-text">Input caveats:</strong> The guard cannot inspect
              commands recalled from shell history (arrow keys), custom aliases, scripts,
              or fullscreen terminal applications (such as{" "}
              <code className="font-mono text-text">vim</code> or{" "}
              <code className="font-mono text-text">htop</code>).
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b border-line p-4 pb-3">
          <CardTitle>Dashboard access</CardTitle>
          <CardDescription className="mt-0.5 max-w-2xl leading-5">
            Local mode uses a secure HttpOnly cookie session. Dashboard
            passwords are verified server-side against the stored credential
            and are never saved in browser storage.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4">
          <p className="text-[13px] leading-6 text-dim">
            Use the account menu in the top bar to log out and revoke the
            current session.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
