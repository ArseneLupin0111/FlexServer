import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import type { DashboardOverview } from "../../../lib/api";

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
          <dl className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
            <RuntimeFact label="App mode" value={overview.settings.appMode} />
            <RuntimeFact
              label="Web terminal"
              value={
                overview.settings.webTerminalEnabled ? "enabled" : "disabled"
              }
              tone={overview.settings.webTerminalEnabled ? "ok" : "warn"}
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
